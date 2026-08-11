use orange_translator_desktop_lib::{
    app_state::{
        AppState, ContextCaptureSnapshot, ContextStatus, LatestGatewayTarget, RequestType,
    },
    gateway::build_language_request,
    settings::{Settings, SettingsRepository, SettingsView},
};
use std::{fs, path::PathBuf, time::SystemTime};

fn test_path(name: &str) -> PathBuf {
    let nonce = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    std::env::temp_dir().join(format!("orange-stage3a-{nonce}-{name}"))
}

fn target(text: &str, request_type: RequestType) -> LatestGatewayTarget {
    LatestGatewayTarget {
        target: text.into(),
        request_type,
        page_title: "P".repeat(320),
        source_app: String::new(),
        capture_generation: 11,
        translation_generation: 12,
        captured_at_unix_ms: 13,
        context: ContextCaptureSnapshot::empty(ContextStatus::Unsupported),
    }
}

#[test]
fn existing_stage_one_settings_load_without_access_code() {
    let path = test_path("compat/settings.json");
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(&path, r#"{"schemaVersion":1}"#).unwrap();
    let repository = SettingsRepository::new(path.clone());
    assert_eq!(repository.load().unwrap(), Settings::default());
    fs::remove_dir_all(path.parent().unwrap()).unwrap();
}

#[test]
fn settings_replace_existing_token_and_view_never_serializes_it() {
    let path = test_path("replace/settings.json");
    let repository = SettingsRepository::new(path.clone());
    let first = Settings {
        schema_version: 1,
        gateway_access_token: "first-secret".into(),
    };
    let second = Settings {
        schema_version: 1,
        gateway_access_token: "second-secret".into(),
    };
    repository.save(&first).unwrap();
    repository.save(&second).unwrap();
    assert_eq!(repository.load().unwrap(), second);
    let public = serde_json::to_string(&SettingsView::from(&second)).unwrap();
    assert!(!public.contains("second-secret"));
    assert!(!public.contains("gatewayAccessToken"));
    assert!(public.contains("gatewayAccessConfigured"));
    fs::remove_dir_all(path.parent().unwrap()).unwrap();
}

#[test]
fn empty_access_code_is_omitted_from_persisted_json() {
    let path = test_path("empty/settings.json");
    let repository = SettingsRepository::new(path.clone());
    repository.save(&Settings::default()).unwrap();
    let text = fs::read_to_string(&path).unwrap();
    assert!(!text.contains("gatewayAccessToken"));
    fs::remove_dir_all(path.parent().unwrap()).unwrap();
}

#[test]
fn settings_loads_retained_backup_when_primary_is_missing() {
    let path = test_path("backup/settings.json");
    let backup = path.with_extension("json.bak");
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(
        &backup,
        r#"{"schemaVersion":1,"gatewayAccessToken":"retained"}"#,
    )
    .unwrap();
    let repository = SettingsRepository::new(path.clone());
    assert_eq!(repository.load().unwrap().gateway_access_token, "retained");
    fs::remove_dir_all(path.parent().unwrap()).unwrap();
}

#[test]
fn latest_gateway_target_keeps_full_text_separate_from_diagnostic_preview() {
    let state = AppState::default();
    let text = "x".repeat(800);
    let snapshot = target(&text, RequestType::SentenceTranslation);
    state.set_latest_gateway_target(snapshot).unwrap();
    let current = state.gateway_test_state().unwrap().latest_target.unwrap();
    assert_eq!(current.target, text);
    assert_eq!(current.target_length(), 800);
}

#[test]
fn request_maps_word_sentence_and_gateway_limits() {
    let word = build_language_request(
        &target("sample", RequestType::WordAnalysis),
        "desktop-1".into(),
    )
    .unwrap();
    assert_eq!(word.request_type, RequestType::WordAnalysis);
    assert_eq!(word.analysis_mode, "quick");
    assert_eq!(word.context_sentence, "");
    assert_eq!(word.page_title.chars().count(), 300);

    let sentence = build_language_request(
        &target("a sentence", RequestType::SentenceTranslation),
        "desktop-2".into(),
    )
    .unwrap();
    assert_eq!(sentence.request_type, RequestType::SentenceTranslation);
    assert!(build_language_request(
        &target(&"x".repeat(5001), RequestType::WordAnalysis),
        "desktop-3".into(),
    )
    .is_err());
}
