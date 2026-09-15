use orange_translator_desktop_lib::{
    app_state::{
        AppState, ContextCaptureSnapshot, ContextSource, ContextStatus, ContextUnit,
        GatewayConnectionState, GatewayParsedResult, LatestGatewayTarget, LiveDetailPhase,
        LiveDetailPopupState, RequestType, WordDetailComparison, WordDetailResult,
    },
    gateway::{
        build_detail_language_request, GatewayClient, GatewayTransport, HttpResponse,
        TransportError,
    },
};
use std::sync::Mutex;

fn target(generation: u64, request_type: RequestType) -> LatestGatewayTarget {
    LatestGatewayTarget {
        target: "warfare".into(),
        binding: None,
        request_type,
        page_title: "Context page".into(),
        source_app: "Microsoft Word".into(),
        capture_generation: generation + 10,
        translation_generation: generation,
        captured_at_unix_ms: 1,
        context: ContextCaptureSnapshot {
            context_sentence: "chemical warfare agents".into(),
            status: ContextStatus::Success,
            source: ContextSource::Uia,
            unit: ContextUnit::Paragraph,
            context_length: 23,
            context_preview: "chemical warfare agents".into(),
        },
        translation_mode: orange_translator_desktop_lib::settings::TranslationMode::Precise,
    }
}

fn quick_word() -> GatewayParsedResult {
    GatewayParsedResult::Word {
        provider: "gateway".into(),
        upstream_provider: "provider".into(),
        skill_version: "context-analysis-v6".into(),
        word: "warfare".into(),
        lemma: "warfare".into(),
        phonetic: "/warfare/".into(),
        part_of_speech: "n.".into(),
        meaning: "战争".into(),
    }
}

fn ready_state() -> (AppState, LatestGatewayTarget, String) {
    let state = AppState::default();
    state.set_auto_translate(true).unwrap();
    let generation = state.next_translation_generation();
    let target = target(generation, RequestType::WordAnalysis);
    let quick_request_id = "quick-word".to_string();
    state.set_latest_gateway_target(target.clone()).unwrap();
    state
        .update_gateway_test_state(|gateway| {
            gateway.connection_state = GatewayConnectionState::Success;
            gateway.request_id = Some(quick_request_id.clone());
            gateway.request_type = Some(RequestType::WordAnalysis);
            gateway.request_target_length = Some(target.target_length());
            gateway.parsed_result = Some(quick_word());
        })
        .unwrap();
    assert!(state
        .prepare_live_detail(&target, &quick_request_id)
        .unwrap());
    (state, target, quick_request_id)
}

struct FakeTransport {
    response: HttpResponse,
    body: Mutex<Option<String>>,
}

impl GatewayTransport for FakeTransport {
    fn post(
        &self,
        _path: &str,
        _access_token: &str,
        json_body: Option<&str>,
    ) -> Result<HttpResponse, TransportError> {
        *self.body.lock().unwrap() = json_body.map(str::to_owned);
        Ok(self.response.clone())
    }
}

#[test]
fn detail_request_reuses_original_target_context_and_gateway_whitelist() {
    let generation = 3;
    let target = target(generation, RequestType::WordAnalysis);
    let request = build_detail_language_request(&target, "detail-1".into()).unwrap();
    assert_eq!(request.request_type, RequestType::WordAnalysis);
    assert_eq!(request.analysis_mode, "detail");
    assert_eq!(request.text, target.target);
    assert_eq!(request.context_sentence, target.context.context_sentence);
    assert_eq!(request.page_title, target.page_title);
    let value = serde_json::to_value(request).unwrap();
    let mut keys = value
        .as_object()
        .unwrap()
        .keys()
        .cloned()
        .collect::<Vec<_>>();
    keys.sort();
    assert_eq!(
        keys,
        vec![
            "analysisMode",
            "contextSentence",
            "mode",
            "pageTitle",
            "requestId",
            "requestType",
            "sourceLanguage",
            "targetLanguage",
            "text",
        ]
    );
    assert_eq!(value["mode"], "precise");
}

#[test]
fn strict_detail_parser_accepts_comparison_and_null() {
    for (request_id, comparison) in [
        (
            "detail-with-comparison",
            serde_json::json!({"word":"battle","difference":"warfare is broader"}),
        ),
        ("detail-null", serde_json::Value::Null),
    ] {
        let has_comparison = !comparison.is_null();
        let response = serde_json::json!({
            "status": "ok",
            "requestId": request_id,
            "data": {
                "provider": "gateway",
                "upstreamProvider": "gemini",
                "resultType": "contextAnalysis",
                "skillVersion": "context-analysis-v6",
                "analysisMode": "detail",
                "analysis": {
                    "meaningInSentence": "armed conflict",
                    "comparison": comparison,
                }
            }
        })
        .to_string();
        let transport = FakeTransport {
            response: HttpResponse {
                status: 200,
                body: response,
            },
            body: Mutex::new(None),
        };
        let request =
            build_detail_language_request(&target(1, RequestType::WordAnalysis), request_id.into())
                .unwrap();
        let (_, parsed) = GatewayClient::new(transport)
            .send_word_detail("token", &request)
            .unwrap();
        assert_eq!(parsed.meaning_in_sentence, "armed conflict");
        assert_eq!(parsed.comparison.is_some(), has_comparison);
    }
}

#[test]
fn strict_detail_parser_rejects_schema_and_identity_errors() {
    let invalid_bodies = [
        r#"{"status":"ok","requestId":"other","data":{}}"#,
        r#"{"status":"ok","requestId":"detail","data":{"provider":"gateway","upstreamProvider":"gemini","resultType":"sentenceTranslation","skillVersion":"context-analysis-v6","analysisMode":"detail","analysis":{"meaningInSentence":"x","comparison":null}}}"#,
        r#"{"status":"ok","requestId":"detail","data":{"provider":"gateway","upstreamProvider":"gemini","resultType":"contextAnalysis","skillVersion":"context-analysis-v6","analysisMode":"quick","analysis":{"meaningInSentence":"x","comparison":null}}}"#,
        r#"{"status":"ok","requestId":"detail","data":{"provider":"gateway","upstreamProvider":"gemini","resultType":"contextAnalysis","skillVersion":"context-analysis-v6","analysisMode":"detail","analysis":{"comparison":null}}}"#,
        r#"{"status":"ok","requestId":"detail","data":{"provider":"gateway","upstreamProvider":"gemini","resultType":"contextAnalysis","skillVersion":"context-analysis-v6","analysisMode":"detail","analysis":{"meaningInSentence":"","comparison":null}}}"#,
        r#"{"status":"ok","requestId":"detail","data":{"provider":"gateway","upstreamProvider":"gemini","resultType":"contextAnalysis","skillVersion":"context-analysis-v6","analysisMode":"detail","analysis":{"meaningInSentence":"x","comparison":{"word":"battle","difference":""}}}}"#,
        r#"{"status":"ok","requestId":"detail","data":{"provider":"gateway","upstreamProvider":"gemini","resultType":"contextAnalysis","skillVersion":"context-analysis-v6","analysisMode":"detail","analysis":{"meaningInSentence":"x","comparison":null,"extra":true}}}"#,
    ];
    for body in invalid_bodies {
        let transport = FakeTransport {
            response: HttpResponse {
                status: 200,
                body: body.into(),
            },
            body: Mutex::new(None),
        };
        let request =
            build_detail_language_request(&target(1, RequestType::WordAnalysis), "detail".into())
                .unwrap();
        assert!(GatewayClient::new(transport)
            .send_word_detail("token", &request)
            .is_err());
    }
}

#[test]
fn detail_claim_is_atomic_and_does_not_replace_quick_main_state() {
    let (state, target, quick_request_id) = ready_state();
    let before = state.gateway_test_state().unwrap();
    let claim = state
        .claim_live_detail(target.translation_generation, &quick_request_id)
        .unwrap()
        .unwrap();
    assert_eq!(claim.target, target);
    assert_eq!(state.live_detail_phase(), LiveDetailPhase::Loading);
    assert!(state
        .claim_live_detail(target.translation_generation, &quick_request_id)
        .unwrap()
        .is_none());
    assert_eq!(state.gateway_test_state().unwrap(), before);
}

#[test]
fn detail_claim_after_mode_switch_keeps_the_original_quick_profile() {
    use orange_translator_desktop_lib::settings::TranslationMode;
    let (state, target, quick_request_id) = ready_state();
    assert_eq!(target.translation_mode, TranslationMode::Precise);
    state.set_translation_mode(TranslationMode::UltraFast).unwrap();
    let claim = state.claim_live_detail(target.translation_generation, &quick_request_id)
        .unwrap().unwrap();
    assert_eq!(claim.target.translation_mode, TranslationMode::Precise);
    assert_eq!(build_detail_language_request(&claim.target, "detail".into()).unwrap().mode,
               TranslationMode::Precise);
}

#[test]
fn local_error_retry_reuses_snapshot_and_changes_only_detail_request_id() {
    let (state, target, quick_request_id) = ready_state();
    let first = state
        .claim_live_detail(target.translation_generation, &quick_request_id)
        .unwrap()
        .unwrap();
    let error = state
        .complete_live_detail(
            target.translation_generation,
            &quick_request_id,
            &first.detail_request_id,
            Err(()),
        )
        .unwrap()
        .unwrap();
    assert!(matches!(error, LiveDetailPopupState::Error { .. }));
    let retry = state
        .claim_live_detail_retry(target.translation_generation, &first.detail_request_id)
        .unwrap()
        .unwrap();
    assert_eq!(retry.target, target);
    assert_eq!(retry.quick_request_id, quick_request_id);
    assert_ne!(retry.detail_request_id, first.detail_request_id);
}

#[test]
fn stale_new_target_and_f1_off_reject_detail_work() {
    let (state, target_a, quick_request_id) = ready_state();
    let claim = state
        .claim_live_detail(target_a.translation_generation, &quick_request_id)
        .unwrap()
        .unwrap();
    let generation_b = state.next_translation_generation();
    state
        .set_latest_gateway_target(target(generation_b, RequestType::WordAnalysis))
        .unwrap();
    assert!(state
        .complete_live_detail(
            target_a.translation_generation,
            &quick_request_id,
            &claim.detail_request_id,
            Ok(WordDetailResult {
                meaning_in_sentence: "old".into(),
                comparison: Some(WordDetailComparison {
                    word: "battle".into(),
                    difference: "old".into(),
                }),
            }),
        )
        .unwrap()
        .is_none());

    let (disabled, target, quick_request_id) = ready_state();
    disabled.set_auto_translate(false).unwrap();
    assert!(disabled
        .claim_live_detail(target.translation_generation, &quick_request_id)
        .unwrap()
        .is_none());
}

#[test]
fn changed_quick_request_identity_invalidates_detail_completion_and_retry() {
    let (state, target, quick_request_id) = ready_state();
    let claim = state
        .claim_live_detail(target.translation_generation, &quick_request_id)
        .unwrap()
        .unwrap();
    state
        .update_gateway_test_state(|gateway| {
            gateway.request_id = Some("manual-new-request".into());
        })
        .unwrap();

    assert!(state
        .complete_live_detail(
            target.translation_generation,
            &quick_request_id,
            &claim.detail_request_id,
            Err(()),
        )
        .unwrap()
        .is_none());
    assert!(!state.is_current_live_detail(
        target.translation_generation,
        &quick_request_id,
        &claim.detail_request_id,
    ));
}

#[test]
fn sentence_quick_never_becomes_detail_ready() {
    let state = AppState::default();
    state.set_auto_translate(true).unwrap();
    let generation = state.next_translation_generation();
    let target = target(generation, RequestType::SentenceTranslation);
    state.set_latest_gateway_target(target.clone()).unwrap();
    state
        .update_gateway_test_state(|gateway| {
            gateway.connection_state = GatewayConnectionState::Success;
            gateway.request_id = Some("sentence-quick".into());
            gateway.parsed_result = Some(GatewayParsedResult::Sentence {
                provider: "gateway".into(),
                upstream_provider: "provider".into(),
                skill_version: "sentence-translation-v1.1".into(),
                translation: "译文".into(),
                key_term: None,
            });
        })
        .unwrap();
    assert!(!state
        .prepare_live_detail(&target, "sentence-quick")
        .unwrap());
    assert_eq!(state.live_detail_phase(), LiveDetailPhase::Unavailable);
}

#[test]
fn detail_popup_payload_excludes_gateway_diagnostics_and_arbitrary_json() {
    let payload = LiveDetailPopupState::Success {
        generation: 1,
        capture_generation: 2,
        quick_request_id: "quick".into(),
        detail_request_id: "detail".into(),
        result: WordDetailResult {
            meaning_in_sentence: "context meaning".into(),
            comparison: None,
        },
    };
    let value = serde_json::to_value(payload).unwrap();
    assert!(value.get("httpStatus").is_none());
    assert!(value.get("rawPreview").is_none());
    assert!(value.get("accessToken").is_none());
    assert!(value.get("requestBody").is_none());
}
