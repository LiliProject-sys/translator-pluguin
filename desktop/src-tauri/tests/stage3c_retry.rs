use orange_translator_desktop_lib::app_state::{
    AppState, ContextCaptureSnapshot, ContextStatus, GatewayConnectionState, LatestGatewayTarget,
    LivePopupErrorKind, RequestType,
};

fn target(generation: u64, capture_generation: u64) -> LatestGatewayTarget {
    LatestGatewayTarget {
        target: "sample".into(),
        binding: None,
        request_type: RequestType::WordAnalysis,
        page_title: String::new(),
        source_app: String::new(),
        capture_generation,
        translation_generation: generation,
        captured_at_unix_ms: generation,
        context: ContextCaptureSnapshot::empty(ContextStatus::Unsupported),
        translation_mode: orange_translator_desktop_lib::settings::TranslationMode::Fast,
    }
}

fn prepare_failed_live_request(
    state: &AppState,
    generation: u64,
    request_id: &str,
    error_kind: LivePopupErrorKind,
) {
    state
        .set_latest_gateway_target(target(generation, generation))
        .unwrap();
    state
        .update_gateway_test_state(|gateway| {
            gateway.connection_state = GatewayConnectionState::Failed;
            gateway.request_id = Some(request_id.into());
            gateway.request_type = Some(RequestType::WordAnalysis);
            gateway.request_target_length = Some(6);
            gateway.error_code = Some("test_failure".into());
            gateway.live_error_kind = Some(error_kind);
        })
        .unwrap();
}

#[test]
fn retry_reuses_the_immutable_target_and_generation_with_a_new_request_id() {
    let state = AppState::default();
    state.set_auto_translate(true).unwrap();
    let generation = state.next_translation_generation();
    prepare_failed_live_request(
        &state,
        generation,
        "failed-request",
        LivePopupErrorKind::Retryable,
    );

    let claim = state
        .claim_live_gateway_retry(generation, "failed-request")
        .unwrap()
        .unwrap();

    assert_eq!(claim.target, target(generation, generation));
    assert_eq!(claim.target.translation_generation, generation);
    assert_ne!(claim.request_id, "failed-request");
    assert_eq!(
        claim.gateway_state.connection_state,
        GatewayConnectionState::Sending
    );
    assert_eq!(
        claim.gateway_state.request_id.as_deref(),
        Some(claim.request_id.as_str())
    );
    assert!(claim.gateway_state.error_code.is_none());
    assert!(claim.gateway_state.live_error_kind.is_none());

    assert!(state
        .claim_live_gateway_retry(generation, "failed-request")
        .unwrap()
        .is_none());
}

#[test]
fn retry_rejects_stale_nonfailed_nonretryable_and_disabled_requests() {
    for error_kind in [
        LivePopupErrorKind::Configuration,
        LivePopupErrorKind::Terminal,
    ] {
        let state = AppState::default();
        state.set_auto_translate(true).unwrap();
        let generation = state.next_translation_generation();
        prepare_failed_live_request(&state, generation, "failed", error_kind);
        assert!(state
            .claim_live_gateway_retry(generation, "failed")
            .unwrap()
            .is_none());
    }

    let state = AppState::default();
    state.set_auto_translate(true).unwrap();
    let generation = state.next_translation_generation();
    prepare_failed_live_request(&state, generation, "failed", LivePopupErrorKind::Retryable);
    assert!(state
        .claim_live_gateway_retry(generation, "other")
        .unwrap()
        .is_none());
    state.next_translation_generation();
    assert!(state
        .claim_live_gateway_retry(generation, "failed")
        .unwrap()
        .is_none());

    let disabled = AppState::default();
    disabled.set_auto_translate(false).unwrap();
    let generation = disabled.next_translation_generation();
    prepare_failed_live_request(
        &disabled,
        generation,
        "failed",
        LivePopupErrorKind::Retryable,
    );
    assert!(disabled
        .claim_live_gateway_retry(generation, "failed")
        .unwrap()
        .is_none());
}

#[test]
fn newer_target_prevents_an_older_automatic_request_from_being_claimed() {
    let state = AppState::default();
    state.set_auto_translate(true).unwrap();
    let generation_a = state.next_translation_generation();
    let target_a = target(generation_a, 1);
    state.set_latest_gateway_target(target_a.clone()).unwrap();

    let generation_b = state.next_translation_generation();
    let target_b = target(generation_b, 2);
    state.set_latest_gateway_target(target_b.clone()).unwrap();

    assert!(state
        .claim_new_live_gateway_request(&target_a)
        .unwrap()
        .is_none());
    let claim_b = state
        .claim_new_live_gateway_request(&target_b)
        .unwrap()
        .unwrap();
    assert_eq!(claim_b.target, target_b);
    assert_eq!(
        claim_b.gateway_state.request_id.as_deref(),
        Some(claim_b.request_id.as_str())
    );
}
