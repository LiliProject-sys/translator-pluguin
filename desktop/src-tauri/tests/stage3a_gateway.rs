use orange_translator_desktop_lib::{
    app_state::{
        AppState, ContextCaptureSnapshot, ContextStatus, LatestGatewayTarget, RequestType,
    },
    gateway::build_language_request,
    settings::{Settings, SettingsRepository, SettingsView, TranslationMode},
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
        binding: None,
        request_type,
        page_title: "P".repeat(320),
        source_app: String::new(),
        capture_generation: 11,
        translation_generation: 12,
        captured_at_unix_ms: 13,
        context: ContextCaptureSnapshot::empty(ContextStatus::Unsupported),
        translation_mode: TranslationMode::Precise,
    }
}

#[test]
fn existing_stage_one_settings_load_without_access_code() {
    let path = test_path("compat/settings.json");
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(&path, r#"{"schemaVersion":1}"#).unwrap();
    let repository = SettingsRepository::new(path.clone());
    assert_eq!(repository.load().unwrap(), Settings::default());
    assert_eq!(
        repository.load().unwrap().translation_mode,
        TranslationMode::UltraFast
    );
    fs::remove_dir_all(path.parent().unwrap()).unwrap();
}

#[test]
fn settings_replace_existing_token_and_view_never_serializes_it() {
    let path = test_path("replace/settings.json");
    let repository = SettingsRepository::new(path.clone());
    let first = Settings {
        schema_version: 1,
        gateway_access_token: "first-secret".into(),
        translation_mode: TranslationMode::Precise,
    };
    let second = Settings {
        schema_version: 1,
        gateway_access_token: "second-secret".into(),
        translation_mode: TranslationMode::Fast,
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
    assert_eq!(word.mode, TranslationMode::Precise);

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

#[test]
fn translation_mode_round_trips_and_is_copied_into_quick_and_detail_requests() {
    let path = test_path("mode/settings.json");
    let repository = SettingsRepository::new(path.clone());
    let settings = Settings {
        translation_mode: TranslationMode::Fast,
        ..Settings::default()
    };
    repository.save(&settings).unwrap();
    assert_eq!(
        repository.load().unwrap().translation_mode,
        TranslationMode::Fast
    );

    let mut fast_target = target("sample", RequestType::WordAnalysis);
    fast_target.translation_mode = TranslationMode::Fast;
    let quick = build_language_request(&fast_target, "quick".into()).unwrap();
    let detail = orange_translator_desktop_lib::gateway::build_detail_language_request(
        &fast_target,
        "detail".into(),
    )
    .unwrap();
    assert_eq!(quick.mode, TranslationMode::Fast);
    assert_eq!(detail.mode, TranslationMode::Fast);
    fs::remove_dir_all(path.parent().unwrap()).unwrap();
}

#[test]
fn runtime_translation_mode_defaults_to_ultra_fast_and_updates_without_restart() {
    let state = AppState::default();
    assert_eq!(state.translation_mode().unwrap(), TranslationMode::UltraFast);
    state.set_translation_mode(TranslationMode::Fast).unwrap();
    assert_eq!(state.translation_mode().unwrap(), TranslationMode::Fast);
}

#[test]
fn all_modes_persist_without_overwriting_explicit_old_choices() {
    let path = test_path("three-modes/settings.json");
    let repository = SettingsRepository::new(path.clone());
    assert_eq!(repository.load().unwrap().translation_mode, TranslationMode::UltraFast);
    for (wire, mode) in [("fast", TranslationMode::Fast), ("precise", TranslationMode::Precise),
                         ("ultra_fast", TranslationMode::UltraFast)] {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, format!(r#"{{"schemaVersion":1,"translationMode":"{wire}"}}"#)).unwrap();
        let settings = repository.load().unwrap();
        assert_eq!(settings.translation_mode, mode);
        repository.save(&settings).unwrap();
        assert_eq!(repository.load().unwrap().translation_mode, mode);
        assert_eq!(serde_json::to_value(mode).unwrap(), wire);
    }
    let invalid = r#"{"schemaVersion":1,"translationMode":"future-mode"}"#;
    fs::write(&path, invalid).unwrap();
    assert!(repository.load().is_err());
    assert_eq!(fs::read_to_string(&path).unwrap(), invalid);
    fs::remove_dir_all(path.parent().unwrap()).unwrap();
}

#[test]
fn mode_switch_only_affects_new_targets_not_in_flight_quick_or_detail() {
    let state = AppState::default();
    for mode in [TranslationMode::UltraFast, TranslationMode::Fast, TranslationMode::Precise,
                 TranslationMode::UltraFast] {
        state.set_translation_mode(mode).unwrap();
        let mut captured = target("sample", RequestType::WordAnalysis);
        captured.translation_mode = state.translation_mode().unwrap();
        state.set_latest_gateway_target(captured.clone()).unwrap();
        state.set_translation_mode(TranslationMode::Precise).unwrap();
        let quick = build_language_request(&captured, "quick".into()).unwrap();
        let detail = orange_translator_desktop_lib::gateway::build_detail_language_request(
            &captured, "detail".into()).unwrap();
        assert_eq!(quick.mode, mode);
        assert_eq!(detail.mode, mode);
        assert_eq!(state.gateway_test_state().unwrap().latest_target.unwrap().translation_mode, mode);
    }
}
