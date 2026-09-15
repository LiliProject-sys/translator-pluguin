use orange_translator_desktop_lib::{
    app_state::{AppState, CandidateType, ContextCaptureSnapshot, ContextStatus, DiagnosticEvent,
        GatewayConnectionState, LatestGatewayTarget, LivePopupErrorKind, RequestType},
    gateway::build_language_request,
    host_adapter::{CaptureStatus, GenericWindowsAdapter, SelectionRuntimeState},
    selection_bridge::{build_translation_input, QuickBinding},
};
use std::time::Instant;

#[test]
fn local_quick_success_detail_retry_and_stale_share_the_original_binding() {
    use orange_translator_desktop_lib::{dictionary::{LocalDictionaryEntry,apply_quick_success},
        gateway::build_detail_language_request, app_state::LiveDetailPhase, settings::TranslationMode};
    for mode in [TranslationMode::UltraFast, TranslationMode::Fast, TranslationMode::Precise] {
        let state=AppState::default();
        let mut a=ready(&state,1,pdf("local-a","exact","saw"),100);
        a.translation_mode=mode;
        state.set_latest_gateway_target(a.clone()).unwrap();
        let claim=state.claim_new_live_gateway_request(&a).unwrap().unwrap();
        let local=LocalDictionaryEntry {lemma:String::new(),phonetic:"PHONETIC_SENTINEL".into(),
            part_of_speech:"n./v.".into(),meaning:"LOCAL_SENTINEL".into()};
        let display=local.display(&a.target,"base_dictionary","fixture");
        state.update_gateway_test_state_for_live_request(&claim.request_id,a.translation_generation,
            |g| apply_quick_success(g,&display,None,0)).unwrap().unwrap();
        assert!(state.prepare_live_detail(&a,&claim.request_id).unwrap());
        assert_eq!(state.live_detail_phase(),LiveDetailPhase::Ready);
        state.set_translation_mode(TranslationMode::Precise).unwrap();
        let detail=state.claim_live_detail(a.translation_generation,&claim.request_id).unwrap().unwrap();
        assert!(state.claim_live_detail(a.translation_generation,&claim.request_id).unwrap().is_none());
        let request=build_detail_language_request(&detail.target,detail.detail_request_id.clone()).unwrap();
        assert_eq!(request.text,a.target);
        assert_eq!(request.context_sentence,a.context.context_sentence);
        assert_eq!(request.mode,mode);
        assert!(!serde_json::to_string(&request).unwrap().contains("LOCAL_SENTINEL"));
        assert!(!serde_json::to_string(&request).unwrap().contains("PHONETIC_SENTINEL"));
        state.complete_live_detail(a.translation_generation,&claim.request_id,&detail.detail_request_id,Err(())).unwrap().unwrap();
        let retry=state.claim_live_detail_retry(a.translation_generation,&detail.detail_request_id).unwrap().unwrap();
        assert_eq!(retry.target,a);
        assert_ne!(retry.detail_request_id,detail.detail_request_id);
        assert_eq!(retry.quick_request_id,claim.request_id);
        let current=state.gateway_test_state().unwrap();
        assert_eq!(current.http_status,None);
        assert_eq!(current.parsed_result,Some(display.clone()));
        assert!(state.current_vocabulary_candidate(a.translation_generation,&claim.request_id).unwrap().is_some());
        state.begin_external_capture(CandidateType::Drag,2,String::new(),55).unwrap();
        assert!(state.update_gateway_test_state_for_live_request(&claim.request_id,a.translation_generation,
            |_| panic!("stale local result committed")).unwrap().is_none());
        assert!(!state.prepare_live_detail(&a,&claim.request_id).unwrap());
        assert!(state.with_current_quick(&a,|| panic!("stale local popup")).is_none());
        let b=ready(&state,3,pdf("local-b","exact","next"),300);
        let claim_b=state.claim_new_live_gateway_request(&b).unwrap().unwrap();
        state.set_auto_translate(false).unwrap();state.set_auto_translate(true).unwrap();
        assert!(state.update_gateway_test_state_for_live_request(&claim_b.request_id,b.translation_generation,
            |_| panic!("paused local result committed")).unwrap().is_none());
    }
}

fn pdf(id: &str, quality: &str, target: &str) -> SelectionRuntimeState {
    serde_json::from_value(serde_json::json!({
        "status":"OK","reason":"resolved","timingMs":{},"snapshot":{
            "snapshotId":id,"capturedAt":"2026-09-14T00:00:00Z",
            "host":{"adapterId":"wps-pdf","appKind":"wps-pdf"},
            "target":{"text":target},"document":{"documentId":"a".repeat(64),"title":"fixture.pdf"},
            "occurrence":{"kind":"wps-pdf-range","pageIndex":9,"startIndex":10,"endIndex":13},
            "context":{"text":"A word in a sentence.","source":"pymupdf-sentence","quality":quality}
        }
    })).unwrap()
}

fn ready(state: &AppState, generation: u64, capture: SelectionRuntimeState, x: i32) -> LatestGatewayTarget {
    state.begin_external_capture(CandidateType::DoubleClick, generation, "Fixture".into(), 55).unwrap();
    state.update_external_capture(generation, |d| d.host_capture = Some(capture.clone())).unwrap();
    let input = build_translation_input(&capture, true).unwrap();
    let mut context = ContextCaptureSnapshot::empty(ContextStatus::Unsupported);
    context.context_sentence = input.context;
    let snapshot = capture.snapshot.unwrap();
    let target = LatestGatewayTarget {
        binding: Some(QuickBinding { snapshot, mouse_x: x, mouse_y: 200,
            capture_epoch: state.capture_epoch(), ready_at: Instant::now() }),
        target: input.target, request_type: RequestType::WordAnalysis,
        page_title: String::new(), source_app: "local-only".into(), capture_generation: generation,
        translation_generation: state.next_translation_generation(), captured_at_unix_ms: 1,
        context, translation_mode: Default::default(),
    };
    state.set_latest_gateway_target(target.clone()).unwrap();
    target
}

#[test]
fn exact_is_eligible_fallback_is_not_and_facts_are_unchanged() {
    let capture = pdf("first", "exact", "word");
    let before = serde_json::to_value(&capture).unwrap();
    let input = build_translation_input(&capture, true).unwrap();
    assert_eq!(input.snapshot_id, "first");
    assert_eq!(input.target, "word");
    assert_eq!(input.context, "A word in a sentence.");
    assert_eq!(serde_json::to_value(capture).unwrap(), before);
    for quality in ["exact-location-fallback", "unavailable", "best-effort", ""] {
        assert_eq!(build_translation_input(&pdf("second", quality, "word"), true).unwrap_err(), "context_not_exact");
    }
}

#[test]
fn generic_empty_context_and_existing_product_filters() {
    let generic = GenericWindowsAdapter::snapshot("generic".into(), "word", "", "WPS");
    assert!(build_translation_input(&generic, true).unwrap().context.is_empty());
    for (text, reason) in [(" ", "empty_target"), ("中文word", "contains_han")] {
        assert_eq!(build_translation_input(&pdf("id", "exact", text), true).unwrap_err(), reason);
    }
    assert_eq!(build_translation_input(&pdf("id", "exact", "word"), false).unwrap_err(), "stale_generation");
    let huge = GenericWindowsAdapter::snapshot("large".into(), &"x".repeat(5001), "", "fixture");
    assert_eq!(build_translation_input(&huge, true).unwrap_err(), "target_too_long");
}

#[test]
fn capture_errors_remain_distinct_before_worker() {
    for (status, reason) in [(CaptureStatus::Unstable,"capture_unstable"),
        (CaptureStatus::Indeterminate,"surface_indeterminate"), (CaptureStatus::NoSelection,"no_selection"),
        (CaptureStatus::Error,"helper_error")] {
        let capture = SelectionRuntimeState::empty(status, "fixture");
        assert_eq!(build_translation_input(&capture, true).unwrap_err(), reason);
    }
}

#[test]
fn one_snapshot_claims_once_but_new_interaction_of_same_word_claims_again() {
    let state = AppState::default();
    let a = ready(&state, 1, pdf("a", "exact", "word"), 100);
    let first = state.claim_new_live_gateway_request(&a).unwrap().unwrap();
    assert!(state.claim_new_live_gateway_request(&a).unwrap().is_none());
    let b = ready(&state, 2, pdf("b", "exact", "word"), 700);
    let second = state.claim_new_live_gateway_request(&b).unwrap().unwrap();
    assert_ne!(first.request_id, second.request_id);
    assert_ne!(first.target.binding.unwrap().snapshot.id(), second.target.binding.unwrap().snapshot.id());
}

#[test]
fn old_result_loading_error_and_anchor_cannot_replace_new_interaction() {
    let state = AppState::default();
    let a = ready(&state, 1, pdf("a", "exact", "word"), 100);
    let first = state.claim_new_live_gateway_request(&a).unwrap().unwrap();
    // Supersede before B has even finished capture.
    state.begin_external_capture(CandidateType::Drag, 2, String::new(), 55).unwrap();
    assert!(!state.is_current_quick(&a));
    assert!(state.with_current_quick(&a, || panic!("old loading moved the window")).is_none());
    let b = ready(&state, 3, pdf("b", "exact", "next"), 700);
    let mut displayed = None;
    state.with_current_quick(&b, || displayed = Some((b.target.clone(), b.binding.as_ref().unwrap().mouse_x)));
    assert!(state.with_current_quick(&a, || displayed = Some(("old".into(), 100))).is_none());
    assert_eq!(displayed, Some(("next".into(), 700)));
    assert!(state.update_gateway_test_state_for_live_request(&first.request_id, a.translation_generation,
        |_| panic!("old response committed")).unwrap().is_none());
}

#[test]
fn snapshot_id_is_checked_even_if_generation_is_reused() {
    let state = AppState::default();
    let a = ready(&state, 1, pdf("a", "exact", "word"), 100);
    let mut b = a.clone();
    b.binding.as_mut().unwrap().snapshot = pdf("b", "exact", "word").snapshot.unwrap();
    state.set_latest_gateway_target(b.clone()).unwrap();
    assert!(!state.is_current_quick(&a));
    assert!(state.is_current_quick(&b));
}

#[test]
fn pause_resume_cancels_old_quick_and_self_events_preserve_current_snapshot() {
    let state = AppState::default();
    let a = ready(&state, 1, pdf("a", "exact", "word"), 100);
    state.update_system_event(|d| { d.last_mouse_event = DiagnosticEvent::MouseUp; d.reason_code = "self_window".into(); }).unwrap();
    assert!(state.is_current_quick(&a));
    state.set_auto_translate(false).unwrap();
    state.set_auto_translate(true).unwrap();
    assert!(!state.is_current_quick(&a));
    assert!(state.claim_new_live_gateway_request(&a).unwrap().is_none());
}

#[test]
fn quick_error_does_not_mutate_capture_and_retry_keeps_snapshot_and_anchor() {
    let state = AppState::default();
    let a = ready(&state, 1, pdf("a", "exact", "word"), 100);
    let before = state.target_diagnostics().unwrap().external_capture.unwrap().host_capture;
    let first = state.claim_new_live_gateway_request(&a).unwrap().unwrap();
    state.update_gateway_test_state_for_live_request(&first.request_id, a.translation_generation, |g| {
        g.connection_state = GatewayConnectionState::Failed;
        g.live_error_kind = Some(LivePopupErrorKind::Retryable);
    }).unwrap().unwrap();
    let retry = state.claim_live_gateway_retry(a.translation_generation, &first.request_id).unwrap().unwrap();
    assert_ne!(retry.request_id, first.request_id);
    assert_eq!(retry.target.binding, a.binding);
    assert_eq!(state.target_diagnostics().unwrap().external_capture.unwrap().host_capture, before);
}

#[test]
fn gateway_payload_is_unchanged_semantic_whitelist_and_detail_requires_quick_success() {
    let state = AppState::default();
    let a = ready(&state, 1, pdf("private-id", "exact", "word"), 700);
    let request = build_language_request(&a, "public-request".into()).unwrap();
    let value = serde_json::to_value(request).unwrap();
    let mut keys: Vec<_> = value.as_object().unwrap().keys().map(String::as_str).collect();
    keys.sort();
    assert_eq!(keys, vec!["analysisMode","contextSentence","mode","pageTitle","requestId","requestType","sourceLanguage","targetLanguage","text"]);
    assert_eq!(value["analysisMode"], "quick");
    assert_eq!(value["pageTitle"], "");
    assert_eq!(value["contextSentence"], "A word in a sentence.");
    let encoded = value.to_string();
    for private in ["private-id", "fixture.pdf", "local-only", "mouseX", "occurrence", "quality", "pymupdf", "documentId"] {
        assert!(!encoded.contains(private));
    }
    assert!(!state.prepare_live_detail(&a, "request").unwrap());
    assert!(state.claim_live_detail(a.translation_generation, "request").unwrap().is_none());
    let local = serde_json::to_value(&a.binding.unwrap().snapshot).unwrap();
    assert_eq!(local["occurrence"]["pageIndex"], 9);
    assert_eq!(local["document"]["title"], "fixture.pdf");
}

#[test]
fn delayed_pdf_response_cannot_overwrite_writer_or_returned_pdf() {
    use std::sync::{Arc, mpsc};
    let state = Arc::new(AppState::default());
    let a = ready(&state, 1, pdf("a", "exact", "word"), 100);
    let claim = state.claim_new_live_gateway_request(&a).unwrap().unwrap();
    let (release, wait) = mpsc::channel();
    let delayed_state = state.clone();
    let delayed = std::thread::spawn(move || {
        wait.recv().unwrap();
        assert!(delayed_state.update_gateway_test_state_for_live_request(&claim.request_id,
            a.translation_generation, |_| panic!("delayed A committed")).unwrap().is_none());
        assert!(delayed_state.with_current_quick(&a, || panic!("delayed A moved anchor")).is_none());
    });
    let writer = ready(&state, 2, GenericWindowsAdapter::snapshot("writer".into(), "word", "", "WPS"), 450);
    assert!(state.claim_new_live_gateway_request(&writer).unwrap().is_some());
    assert!(build_language_request(&writer, "writer-request".into()).unwrap().context_sentence.is_empty());
    assert_eq!(writer.binding.as_ref().unwrap().snapshot.adapter_id(), "generic-windows");
    let returned = ready(&state, 3, pdf("returned", "exact", "word"), 900);
    assert!(state.claim_new_live_gateway_request(&returned).unwrap().is_some());
    release.send(()).unwrap();
    delayed.join().unwrap();
    assert!(state.is_current_quick(&returned));
}

#[test]
fn commit_sections_do_not_wait_on_synchronous_window_getters() {
    let source = include_str!("../src/lib.rs");
    for (start, end) in [("fn emit_live_loading_current(", "fn emit_live_result_if_current("),
        ("fn emit_live_result_current(", "fn emit_detail_if_current(")] {
        let section = source.split_once(start).unwrap().1.split_once(end).unwrap().0;
        assert!(!section.contains(".is_visible("));
        assert!(!section.contains(".hwnd("));
    }
}

fn detail_ready(state: &AppState, target: &LatestGatewayTarget) -> String {
    use orange_translator_desktop_lib::app_state::GatewayParsedResult;
    let quick = state.claim_new_live_gateway_request(target).unwrap().unwrap();
    state.update_gateway_test_state_for_live_request(&quick.request_id,
        target.translation_generation, |g| {
            g.connection_state = GatewayConnectionState::Success;
            g.parsed_result = Some(GatewayParsedResult::Word {
                provider: "fixture".into(), upstream_provider: "fixture".into(),
                skill_version: "fixture".into(), word: target.target.clone(),
                lemma: target.target.clone(), phonetic: String::new(),
                part_of_speech: "n.".into(), meaning: "测试".into(),
            });
        }).unwrap().unwrap();
    assert!(state.prepare_live_detail(target, &quick.request_id).unwrap());
    quick.request_id
}

#[test]
fn wps_detail_click_retry_reuses_snapshot_context_and_preserves_quick() {
    use orange_translator_desktop_lib::gateway::build_detail_language_request;
    let state = AppState::default();
    let target = ready(&state, 1, pdf("private-detail", "exact", "word"), 700);
    let quick = detail_ready(&state, &target);
    // Ready is local only; no Detail has been claimed by Quick completion.
    assert_eq!(state.live_detail_phase(), orange_translator_desktop_lib::app_state::LiveDetailPhase::Ready);
    let claim = state.claim_live_detail(target.translation_generation, &quick).unwrap().unwrap();
    assert!(state.claim_live_detail(target.translation_generation, &quick).unwrap().is_none());
    assert_eq!(claim.target.binding, target.binding);
    let request = build_detail_language_request(&claim.target, claim.detail_request_id.clone()).unwrap();
    let value = serde_json::to_value(request).unwrap();
    assert_eq!(value["analysisMode"], "detail");
    assert_eq!(value["text"], "word");
    assert_eq!(value["contextSentence"], target.context.context_sentence);
    assert_eq!(value["pageTitle"], "");
    assert_eq!(value.as_object().unwrap().len(), 9);
    for private in ["private-detail", "fixture.pdf", "local-only", "occurrence", "pymupdf"] {
        assert!(!value.to_string().contains(private));
    }
    let before = state.target_diagnostics().unwrap().external_capture.unwrap().host_capture;
    assert!(state.complete_live_detail(target.translation_generation, &quick, &claim.detail_request_id, Err(())).unwrap().is_some());
    assert_eq!(state.gateway_test_state().unwrap().connection_state, GatewayConnectionState::Success);
    assert_eq!(state.target_diagnostics().unwrap().external_capture.unwrap().host_capture, before);
    let retry = state.claim_live_detail_retry(target.translation_generation, &claim.detail_request_id).unwrap().unwrap();
    assert_eq!(retry.target, claim.target);
    assert_ne!(retry.detail_request_id, claim.detail_request_id);
    assert!(!state.is_current_live_detail(target.translation_generation, &quick, &claim.detail_request_id));
    assert!(state.is_current_live_detail(target.translation_generation, &quick, &retry.detail_request_id));
    let payload = state.complete_live_detail(target.translation_generation, &quick, &retry.detail_request_id,
        Ok(orange_translator_desktop_lib::app_state::WordDetailResult {
            meaning_in_sentence: "合成测试语境释义".into(), comparison: None,
        })).unwrap().unwrap();
    assert!(matches!(payload, orange_translator_desktop_lib::app_state::LiveDetailPopupState::Success { .. }));
    assert!(state.with_current_live_detail(target.translation_generation, &quick, &retry.detail_request_id, || ()).is_some());
    assert_eq!(state.gateway_test_state().unwrap().connection_state, GatewayConnectionState::Success);
}

#[test]
fn detail_pause_resume_invalidates_ready_loading_and_retry() {
    for phase in ["ready", "loading", "error"] {
        let state = AppState::default();
        let target = ready(&state, 1, pdf("pause", "exact", "word"), 100);
        let quick = detail_ready(&state, &target);
        let claim = if phase != "ready" {
            Some(state.claim_live_detail(target.translation_generation, &quick).unwrap().unwrap())
        } else { None };
        if phase == "error" {
            state.complete_live_detail(target.translation_generation, &quick, &claim.as_ref().unwrap().detail_request_id, Err(())).unwrap();
        }
        state.set_auto_translate(false).unwrap();
        state.set_auto_translate(true).unwrap();
        assert!(state.claim_live_detail(target.translation_generation, &quick).unwrap().is_none());
        if let Some(claim) = claim {
            assert!(state.claim_live_detail_retry(target.translation_generation, &claim.detail_request_id).unwrap().is_none());
            assert!(state.complete_live_detail(target.translation_generation, &quick, &claim.detail_request_id, Err(())).unwrap().is_none());
            assert!(state.with_current_live_detail(target.translation_generation, &quick, &claim.detail_request_id,
                || panic!("paused Detail published")).is_none());
        }
    }
}

#[test]
fn detail_same_word_new_occurrence_writer_and_return_cannot_publish_old_response() {
    let state = AppState::default();
    let a = ready(&state, 1, pdf("a", "exact", "word"), 100);
    let quick = detail_ready(&state, &a);
    let claim = state.claim_live_detail(a.translation_generation, &quick).unwrap().unwrap();
    state.update_system_event(|d| d.reason_code = "self_window".into()).unwrap();
    assert!(state.with_current_live_detail(a.translation_generation, &quick, &claim.detail_request_id, || ()).is_some());
    let mut second = serde_json::to_value(pdf("b", "exact", "word")).unwrap();
    second["snapshot"]["occurrence"]["startIndex"] = 100.into();
    second["snapshot"]["occurrence"]["endIndex"] = 103.into();
    second["snapshot"]["context"]["text"] = "Another word in another context.".into();
    let b = ready(&state, 2, serde_json::from_value(second).unwrap(), 700);
    detail_ready(&state, &b);
    let writer = ready(&state, 3, GenericWindowsAdapter::snapshot("writer".into(), "word", "", "WPS"), 450);
    let writer_quick = detail_ready(&state, &writer);
    assert!(state.claim_live_detail(writer.translation_generation, &writer_quick).unwrap().unwrap().target.context.context_sentence.is_empty());
    let returned = ready(&state, 4, pdf("returned", "exact", "word"), 900);
    detail_ready(&state, &returned);
    assert!(state.complete_live_detail(a.translation_generation, &quick, &claim.detail_request_id, Err(())).unwrap().is_none());
    assert!(state.with_current_live_detail(a.translation_generation, &quick, &claim.detail_request_id,
        || panic!("old Detail moved popup")).is_none());
    assert!(state.is_current_quick(&returned));
}

#[test]
fn detail_success_and_error_are_rejected_as_soon_as_new_capture_begins() {
    use orange_translator_desktop_lib::app_state::WordDetailResult;
    for outcome in [Ok(WordDetailResult { meaning_in_sentence: "fixture".into(), comparison: None }), Err(())] {
        let state = AppState::default();
        let target = ready(&state, 1, pdf("old", "exact", "word"), 100);
        let quick = detail_ready(&state, &target);
        let claim = state.claim_live_detail(target.translation_generation, &quick).unwrap().unwrap();
        state.begin_external_capture(CandidateType::DoubleClick, 2, "Fixture B".into(), 55).unwrap();
        assert!(state.complete_live_detail(target.translation_generation, &quick, &claim.detail_request_id, outcome).unwrap().is_none());
        assert!(state.with_current_live_detail(target.translation_generation, &quick, &claim.detail_request_id,
            || panic!("old loading/result emitted")).is_none());
    }
}

#[test]
fn detail_different_snapshot_same_generation_invalidates_old_claim() {
    let state = AppState::default();
    let a = ready(&state, 1, pdf("a", "exact", "word"), 100);
    let quick = detail_ready(&state, &a);
    let claim = state.claim_live_detail(a.translation_generation, &quick).unwrap().unwrap();
    let mut b = a.clone();
    b.binding.as_mut().unwrap().snapshot = pdf("b", "exact", "word").snapshot.unwrap();
    state.set_latest_gateway_target(b).unwrap();
    assert!(state.claim_live_detail(a.translation_generation, &quick).unwrap().is_none());
    assert!(state.complete_live_detail(a.translation_generation, &quick, &claim.detail_request_id, Err(())).unwrap().is_none());
    assert!(!state.is_current_live_detail(a.translation_generation, &quick, &claim.detail_request_id));
}

#[test]
fn actual_placement_uses_only_current_binding_and_retry_keeps_its_anchor() {
    use orange_translator_desktop_lib::popup_position::{compute_popup_position, Point, Size, WorkArea};
    let state = AppState::default();
    let a = ready(&state, 1, pdf("position-a", "exact", "word"), 100);
    let _first = state.claim_new_live_gateway_request(&a).unwrap().unwrap();
    let compute = |target: &LatestGatewayTarget| {
        let binding = target.binding.as_ref().unwrap();
        compute_popup_position(Some(Point { x: binding.mouse_x, y: binding.mouse_y }),
            Size { width: 400, height: 450 }, WorkArea { x: 0, y: 0, width: 1920, height: 1040 }, 16).unwrap().position
    };
    let old_position = compute(&a); // Lookup/calculation may finish before a replacement.
    let b = ready(&state, 2, pdf("position-b", "exact", "word"), 1200);
    let second = state.claim_new_live_gateway_request(&b).unwrap().unwrap();
    let mut displayed = None;
    state.with_current_quick(&b, || displayed = Some(compute(&b)));
    assert!(state.with_current_quick(&a, || displayed = Some(old_position)).is_none());
    assert_eq!(displayed, Some(Point { x: 1216, y: 216 }));
    state.update_system_event(|d| d.reason_code = "self_window".into()).unwrap();
    assert!(state.is_current_quick(&b));
    state.update_gateway_test_state_for_live_request(&second.request_id, b.translation_generation, |g| {
        g.connection_state = GatewayConnectionState::Failed;
        g.live_error_kind = Some(LivePopupErrorKind::Retryable);
    }).unwrap();
    let retry = state.claim_live_gateway_retry(b.translation_generation, &second.request_id).unwrap().unwrap();
    assert_eq!(compute(&retry.target), compute(&b));
    state.set_auto_translate(false).unwrap();
    state.set_auto_translate(true).unwrap();
    assert!(state.with_current_quick(&retry.target, || panic!("paused anchor moved window")).is_none());
}
