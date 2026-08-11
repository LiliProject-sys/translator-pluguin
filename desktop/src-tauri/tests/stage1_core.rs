use orange_translator_desktop_lib::{
    app_state::{should_toggle_for_shortcut, AppState, MainSection},
    settings::{Settings, SettingsError, SettingsRepository},
    windows::{close_action, should_hide_popup, CloseAction},
};
use std::{
    fs,
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
};

static NEXT_DIR: AtomicU64 = AtomicU64::new(1);

#[test]
fn disabling_auto_translate_hides_popup_while_enabling_does_not() {
    assert!(should_hide_popup(false));
    assert!(!should_hide_popup(true));
}

fn test_path(name: &str) -> PathBuf {
    std::env::temp_dir()
        .join(format!(
            "orange-stage1-{}-{}",
            std::process::id(),
            NEXT_DIR.fetch_add(1, Ordering::SeqCst)
        ))
        .join(name)
}

#[test]
fn runtime_defaults_to_enabled_home() {
    let state = AppState::default().runtime().unwrap();
    assert!(state.auto_translate_enabled);
    assert_eq!(state.main_section, MainSection::Home);
}

#[test]
fn state_can_set_toggle_and_change_all_sections() {
    let state = AppState::default();
    assert!(
        !state
            .toggle_auto_translate()
            .unwrap()
            .auto_translate_enabled
    );
    assert!(
        state
            .toggle_auto_translate()
            .unwrap()
            .auto_translate_enabled
    );
    for section in [
        MainSection::Home,
        MainSection::Vocabulary,
        MainSection::Settings,
    ] {
        state.set_main_section(section).unwrap();
        assert_eq!(state.runtime().unwrap().main_section, section);
    }
}

#[test]
fn only_pressed_shortcut_toggles() {
    assert!(should_toggle_for_shortcut(true));
    assert!(!should_toggle_for_shortcut(false));
}

#[test]
fn generations_only_accept_latest_work() {
    let state = AppState::default();
    let old_mock = state.next_translation_generation();
    let new_mock = state.next_translation_generation();
    assert!(!state.is_current_translation(old_mock));
    assert!(state.is_current_translation(new_mock));
    let old_status = state.next_status_generation();
    let new_status = state.next_status_generation();
    assert!(!state.is_current_status(old_status));
    assert!(state.is_current_status(new_status));
}

#[test]
fn missing_settings_file_returns_default_without_creating_file() {
    let path = test_path("settings.json");
    let repository = SettingsRepository::new(path.clone());
    assert_eq!(repository.load().unwrap(), Settings::default());
    assert!(!path.exists());
}

#[test]
fn settings_round_trip_contains_only_schema_version() {
    let path = test_path("settings.json");
    let root = path.parent().unwrap().to_path_buf();
    let repository = SettingsRepository::new(path);
    repository.save(&Settings::default()).unwrap();
    assert_eq!(repository.load().unwrap(), Settings::default());
    let _ = fs::remove_dir_all(root);
}

#[test]
fn invalid_settings_json_is_reported_and_not_overwritten() {
    let path = test_path("settings.json");
    let root = path.parent().unwrap().to_path_buf();
    fs::create_dir_all(&root).unwrap();
    fs::write(&path, "{broken").unwrap();
    let repository = SettingsRepository::new(path.clone());
    assert!(matches!(
        repository.load(),
        Err(SettingsError::InvalidJson(_))
    ));
    assert_eq!(fs::read_to_string(path).unwrap(), "{broken");
    let _ = fs::remove_dir_all(root);
}

#[test]
fn stage_one_windows_hide_unless_app_is_exiting() {
    for label in ["main", "popup", "status"] {
        assert_eq!(close_action(label, false), CloseAction::Hide);
        assert_eq!(close_action(label, true), CloseAction::Exit);
    }
    assert_eq!(close_action("future", false), CloseAction::Ignore);
}

#[test]
fn exit_flag_is_false_until_tray_exit_begins() {
    let state = AppState::default();
    assert!(!state.is_exiting());
    state.begin_exit();
    assert!(state.is_exiting());
}

#[test]
fn unavailable_target_capture_keeps_auto_translate_disabled() {
    let state = AppState::default();
    state.mark_target_capture_unavailable();
    assert!(!state.runtime().unwrap().target_capture_available);
    assert!(state.set_auto_translate(true).is_err());
    assert!(state.toggle_auto_translate().is_err());
    assert!(!state.runtime().unwrap().auto_translate_enabled);
}
