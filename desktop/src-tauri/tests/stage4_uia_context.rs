use orange_translator_desktop_lib::{
    app_state::{
        ContextCaptureSnapshot, ContextSource, ContextStatus, ContextUnit, LatestGatewayTarget,
        RequestType,
    },
    gateway::build_language_request,
};

fn target(context: ContextCaptureSnapshot) -> LatestGatewayTarget {
    LatestGatewayTarget {
        target: "measurement".into(),
        request_type: RequestType::WordAnalysis,
        page_title: "Notepad".into(),
        source_app: "Notepad".into(),
        capture_generation: 4,
        translation_generation: 5,
        captured_at_unix_ms: 6,
        context,
    }
}

#[test]
fn gateway_uses_captured_context_and_ipc_omits_full_context() {
    let context = ContextCaptureSnapshot {
        context_sentence: "A private measurement context sentence.".into(),
        status: ContextStatus::Success,
        source: ContextSource::Uia,
        unit: ContextUnit::Paragraph,
        context_length: 39,
        context_preview: "preview only".into(),
    };
    let target = target(context.clone());
    let request = build_language_request(&target, "desktop-stage4".into()).unwrap();
    assert_eq!(request.context_sentence, context.context_sentence);

    let ipc = serde_json::to_string(&target).unwrap();
    assert!(!ipc.contains("private measurement"));
    assert!(!ipc.contains("contextSentence"));
    assert!(ipc.contains("preview only"));
}

#[test]
fn failed_uia_still_builds_gateway_request_with_empty_context() {
    for status in [
        ContextStatus::Unsupported,
        ContextStatus::NoSelection,
        ContextStatus::Mismatch,
        ContextStatus::Timeout,
        ContextStatus::Error,
    ] {
        let target = target(ContextCaptureSnapshot::empty(status));
        let request = build_language_request(&target, "desktop-stage4".into()).unwrap();
        assert!(request.context_sentence.is_empty());
        assert_eq!(target.context.status, status);
    }
}

#[test]
fn retry_snapshot_clone_preserves_context_and_generations() {
    let original = target(ContextCaptureSnapshot {
        context_sentence: "local measurement context".into(),
        status: ContextStatus::Success,
        source: ContextSource::Uia,
        unit: ContextUnit::Line,
        context_length: 25,
        context_preview: "local measurement context".into(),
    });
    let retry = original.clone();
    assert_eq!(retry.target, original.target);
    assert_eq!(retry.context, original.context);
    assert_eq!(retry.capture_generation, original.capture_generation);
    assert_eq!(
        retry.translation_generation,
        original.translation_generation
    );
}
