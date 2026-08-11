use orange_translator_desktop_lib::app_state::{
    AppState, ContextCaptureSnapshot, ContextStatus, GatewayConnectionState, GatewayParseStatus,
    GatewayParsedResult, LatestGatewayTarget, RequestType,
};
use std::sync::{mpsc, Arc};
use std::thread;

#[test]
fn gateway_state_rejects_an_old_request_identity() {
    let state = AppState::default();
    state
        .update_gateway_test_state(|gateway| gateway.request_id = Some("new".into()))
        .unwrap();

    assert!(state
        .update_gateway_test_state_for_request("old", |gateway| {
            gateway.connection_state = GatewayConnectionState::Success;
        })
        .unwrap()
        .is_none());
    assert_eq!(
        state.gateway_test_state().unwrap().connection_state,
        GatewayConnectionState::Idle
    );

    assert!(state
        .update_gateway_test_state_for_request("new", |gateway| {
            gateway.connection_state = GatewayConnectionState::Success;
        })
        .unwrap()
        .is_some());
}

#[test]
fn live_gateway_state_rejects_an_old_translation_generation() {
    let state = AppState::default();
    let old_generation = state.next_translation_generation();
    state
        .set_latest_gateway_target(LatestGatewayTarget {
            target: "old".into(),
            request_type: RequestType::WordAnalysis,
            page_title: String::new(),
            source_app: String::new(),
            capture_generation: 1,
            translation_generation: old_generation,
            captured_at_unix_ms: 1,
            context: ContextCaptureSnapshot::empty(ContextStatus::Unsupported),
        })
        .unwrap();
    state
        .update_gateway_test_state(|gateway| gateway.request_id = Some("old-request".into()))
        .unwrap();

    state.next_translation_generation();
    assert!(state
        .update_gateway_test_state_for_live_request("old-request", old_generation, |gateway| {
            gateway.connection_state = GatewayConnectionState::Success
        },)
        .unwrap()
        .is_none());
    assert_eq!(
        state.gateway_test_state().unwrap().connection_state,
        GatewayConnectionState::Idle
    );
}

#[test]
fn completion_and_new_generation_are_linearized_while_old_result_is_retained() {
    let state = Arc::new(AppState::default());
    let old_generation = state.next_translation_generation();
    state
        .set_latest_gateway_target(LatestGatewayTarget {
            target: "old".into(),
            request_type: RequestType::WordAnalysis,
            page_title: String::new(),
            source_app: String::new(),
            capture_generation: 1,
            translation_generation: old_generation,
            captured_at_unix_ms: 1,
            context: ContextCaptureSnapshot::empty(ContextStatus::Unsupported),
        })
        .unwrap();
    state
        .update_gateway_test_state(|gateway| gateway.request_id = Some("old-request".into()))
        .unwrap();

    let (entered_tx, entered_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let completion_state = Arc::clone(&state);
    let completion = thread::spawn(move || {
        completion_state
            .update_gateway_test_state_for_live_request("old-request", old_generation, |gateway| {
                entered_tx.send(()).unwrap();
                release_rx.recv().unwrap();
                gateway.connection_state = GatewayConnectionState::Success;
                gateway.parse_status = GatewayParseStatus::Success;
                gateway.parsed_result = Some(GatewayParsedResult::Word {
                    provider: "gateway".into(),
                    upstream_provider: "provider".into(),
                    skill_version: "skill".into(),
                    word: "old".into(),
                    lemma: "old".into(),
                    phonetic: "/old/".into(),
                    part_of_speech: "n.".into(),
                    meaning: "old result".into(),
                });
            })
            .unwrap()
            .unwrap();
    });

    entered_rx.recv().unwrap();
    let (published_tx, published_rx) = mpsc::channel();
    let selection_state = Arc::clone(&state);
    let selection = thread::spawn(move || {
        let new_generation = selection_state.next_translation_generation();
        let published = selection_state
            .set_latest_gateway_target(LatestGatewayTarget {
                target: "new".into(),
                request_type: RequestType::WordAnalysis,
                page_title: String::new(),
                source_app: String::new(),
                capture_generation: 2,
                translation_generation: new_generation,
                captured_at_unix_ms: 2,
                context: ContextCaptureSnapshot::empty(ContextStatus::Unsupported),
            })
            .unwrap();
        published_tx.send(published).unwrap();
    });

    assert!(published_rx.try_recv().is_err());
    release_tx.send(()).unwrap();
    completion.join().unwrap();
    selection.join().unwrap();
    let published = published_rx.recv().unwrap();

    assert_eq!(published.connection_state, GatewayConnectionState::Success);
    assert_eq!(published.parse_status, GatewayParseStatus::Success);
    assert_eq!(published.request_id.as_deref(), Some("old-request"));
    assert!(published.parsed_result.is_some());
    assert_eq!(
        published.latest_target.unwrap().translation_generation,
        old_generation + 1
    );
}
