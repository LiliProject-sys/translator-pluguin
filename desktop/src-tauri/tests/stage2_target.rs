use orange_translator_desktop_lib::{
    app_state::{
        target_preview, AppState, CandidateType, ClipboardRestoreState, DiagnosticEvent,
        DiagnosticResult, DiagnosticStage, MockTranslationState, PopupAckState, PopupAttemptState,
        RequestType, SelectionSnapshot,
    },
    selection::{
        any_modifier_pressed, classify_target, contains_han, is_orange_process, normalize_target,
        popup_click_action, run_clipboard_transaction_observed,
        run_clipboard_transaction_with_budget, target_filter_reason, CapturePlatform,
        CaptureStopReason, ClipboardPhase, ClipboardRead, ClipboardSnapshot, ClipboardTraceStage,
        ForegroundWindow, GestureDetector, GestureKind, GestureMetrics, MouseEventKind,
        OriginalClipboard, PopupClickAction, RawMouseEvent, TargetDedupe, WindowBounds,
    },
};
use std::{
    cell::RefCell,
    time::{Duration, Instant},
};

const METRICS: GestureMetrics = GestureMetrics {
    drag_x: 4,
    drag_y: 4,
    double_click_x: 8,
    double_click_y: 8,
    double_click_ms: 500,
};

fn mouse(kind: MouseEventKind, x: i32, y: i32, time: u32) -> RawMouseEvent {
    RawMouseEvent { kind, x, y, time }
}

#[test]
fn drag_and_double_click_use_system_metrics_while_single_click_is_ignored() {
    let mut detector = GestureDetector::default();
    assert_eq!(
        detector.handle(mouse(MouseEventKind::LeftDown, 10, 10, 1), METRICS),
        None
    );
    let drag = detector
        .handle(mouse(MouseEventKind::LeftUp, 14, 10, 20), METRICS)
        .unwrap();
    assert_eq!(drag.kind, GestureKind::Drag);

    assert_eq!(
        detector.handle(mouse(MouseEventKind::LeftDown, 20, 20, 100), METRICS),
        None
    );
    assert_eq!(
        detector.handle(mouse(MouseEventKind::LeftUp, 20, 20, 110), METRICS),
        None
    );
    assert_eq!(
        detector.handle(mouse(MouseEventKind::LeftDown, 23, 22, 250), METRICS),
        None
    );
    let double_click = detector
        .handle(mouse(MouseEventKind::LeftUp, 23, 22, 260), METRICS)
        .unwrap();
    assert_eq!(double_click.kind, GestureKind::DoubleClick);
}

#[test]
fn distant_or_slow_clicks_do_not_form_double_click() {
    let mut detector = GestureDetector::default();
    for (x, time) in [(0, 0), (10, 100), (10, 700)] {
        detector.handle(mouse(MouseEventKind::LeftDown, x, 0, time), METRICS);
        assert_eq!(
            detector.handle(mouse(MouseEventKind::LeftUp, x, 0, time + 1), METRICS),
            None
        );
    }
}

#[test]
fn modifier_gate_covers_ctrl_shift_alt_and_both_windows_keys() {
    assert!(!any_modifier_pressed([false; 5]));
    for index in 0..5 {
        let mut states = [false; 5];
        states[index] = true;
        assert!(any_modifier_pressed(states));
    }
    assert!(any_modifier_pressed([true, true, false, false, false]));
}

#[derive(Clone)]
struct FakeConfig {
    safe_backup: Option<OriginalClipboard>,
    initial_text: Option<String>,
    modifier_active: bool,
    send_success: bool,
    copied_text: Option<String>,
    user_modifies_after_copy: bool,
    user_modifies_during_settle: bool,
    read_error_after_send: bool,
    restore_identity_unreadable: bool,
    change_during_modifier_check: bool,
    restore_error: bool,
}

struct FakeState {
    sequence: u32,
    text: Option<String>,
    writes: usize,
    clears: usize,
    sends: usize,
    sequence_reads_after_send: usize,
    sleeps: Vec<Duration>,
}

struct FakePlatform {
    config: FakeConfig,
    state: RefCell<FakeState>,
}

impl FakePlatform {
    fn new(config: FakeConfig) -> Self {
        let text = config.initial_text.clone();
        Self {
            config,
            state: RefCell::new(FakeState {
                sequence: 10,
                text,
                writes: 0,
                clears: 0,
                sends: 0,
                sequence_reads_after_send: 0,
                sleeps: Vec::new(),
            }),
        }
    }
}

impl CapturePlatform for FakePlatform {
    fn foreground(&self) -> Result<ForegroundWindow, String> {
        Ok(ForegroundWindow {
            hwnd: 7,
            pid: 9,
            title: String::new(),
            app_name: String::new(),
        })
    }

    fn snapshot_clipboard(&self) -> Result<ClipboardSnapshot, String> {
        Ok(ClipboardSnapshot {
            safe_backup: self.config.safe_backup.clone(),
            sequence: self.state.borrow().sequence,
        })
    }

    fn modifiers_active(&self) -> bool {
        if self.config.change_during_modifier_check {
            let mut state = self.state.borrow_mut();
            if state.sends == 0 {
                state.sequence += 1;
                state.text = Some("user-new-content".into());
            }
        }
        self.config.modifier_active
    }

    fn send_ctrl_c(&self) -> Result<(), String> {
        let mut state = self.state.borrow_mut();
        state.sends += 1;
        if !self.config.send_success {
            return Err("send-failed".into());
        }
        if let Some(text) = &self.config.copied_text {
            state.sequence += 1;
            state.text = Some(text.clone());
        }
        Ok(())
    }

    fn clipboard_sequence(&self) -> u32 {
        let mut state = self.state.borrow_mut();
        if state.sends > 0 {
            state.sequence_reads_after_send += 1;
            if self.config.user_modifies_after_copy && state.sequence_reads_after_send == 2 {
                state.sequence += 1;
                state.text = Some("user-new-content".into());
            }
        }
        state.sequence
    }

    fn read_unicode(&self) -> Result<ClipboardRead, String> {
        let state = self.state.borrow();
        if self.config.read_error_after_send && state.sends > 0 {
            return Err("clipboard-read-failed".into());
        }
        Ok(ClipboardRead {
            text: state.text.clone(),
            sequence: state.sequence,
        })
    }

    fn restore_if_owned(
        &self,
        expected_sequence: u32,
        expected_text: Option<&str>,
        original: &OriginalClipboard,
    ) -> Result<bool, String> {
        let mut state = self.state.borrow_mut();
        if self.config.user_modifies_after_copy
            && state.sends > 0
            && state.text.as_deref() != Some("user-new-content")
        {
            state.sequence += 1;
            state.text = Some("user-new-content".into());
        }
        if state.sequence != expected_sequence {
            return Ok(false);
        }
        if self.config.restore_error {
            return Err("restore-failed".into());
        }
        if let Some(expected) = expected_text {
            if self.config.restore_identity_unreadable || state.text.as_deref() != Some(expected) {
                return Ok(false);
            }
        }
        state.sequence += 1;
        match original {
            OriginalClipboard::Empty => {
                state.clears += 1;
                state.text = None;
            }
            OriginalClipboard::Unicode(text) => {
                state.writes += 1;
                state.text = Some(text.clone());
            }
        }
        Ok(true)
    }

    fn sleep(&self, duration: Duration) {
        let mut state = self.state.borrow_mut();
        state.sleeps.push(duration);
        if self.config.user_modifies_during_settle && duration == Duration::from_millis(150) {
            state.sequence += 1;
            state.text = Some("user-new-content".into());
        }
    }
}

fn base_config() -> FakeConfig {
    FakeConfig {
        safe_backup: Some(OriginalClipboard::Unicode("original".into())),
        initial_text: Some("original".into()),
        modifier_active: false,
        send_success: true,
        copied_text: Some("captured target".into()),
        user_modifies_after_copy: false,
        user_modifies_during_settle: false,
        read_error_after_send: false,
        restore_identity_unreadable: false,
        change_during_modifier_check: false,
        restore_error: false,
    }
}

#[test]
fn modifier_cancellation_does_not_write_send_or_clear_clipboard() {
    let mut config = base_config();
    config.modifier_active = true;
    let platform = FakePlatform::new(config);
    let result =
        run_clipboard_transaction_with_budget(&platform, || true, Duration::from_millis(5));
    assert_eq!(result.stop_reason, Some(CaptureStopReason::ModifierActive));
    let state = platform.state.borrow();
    assert_eq!((state.sends, state.clears), (0, 0));
    assert_eq!(state.text.as_deref(), Some("original"));
}

#[test]
fn clipboard_change_after_snapshot_discards_backup_but_still_captures() {
    let mut config = base_config();
    config.change_during_modifier_check = true;
    let platform = FakePlatform::new(config);
    let result =
        run_clipboard_transaction_with_budget(&platform, || true, Duration::from_millis(5));
    assert_eq!(result.target.as_deref(), Some("captured target"));
    assert_eq!(result.restore_state, ClipboardRestoreState::Skipped);
    let state = platform.state.borrow();
    assert_eq!(state.sends, 1);
    assert_eq!(state.text.as_deref(), Some("captured target"));
}

#[test]
fn successful_copy_is_accepted_then_original_unicode_is_restored() {
    let platform = FakePlatform::new(base_config());
    let result =
        run_clipboard_transaction_with_budget(&platform, || true, Duration::from_millis(5));
    assert_eq!(result.target.as_deref(), Some("captured target"));
    assert_eq!(result.phase, ClipboardPhase::CopyObserved);
    assert!(result.restored);
    assert_eq!(result.restore_state, ClipboardRestoreState::Success);
    assert_eq!(platform.state.borrow().text.as_deref(), Some("original"));
}

#[test]
fn successful_copy_restores_an_originally_empty_clipboard_to_empty() {
    let mut config = base_config();
    config.safe_backup = Some(OriginalClipboard::Empty);
    config.initial_text = None;
    let platform = FakePlatform::new(config);
    let result =
        run_clipboard_transaction_with_budget(&platform, || true, Duration::from_millis(5));
    assert_eq!(result.target.as_deref(), Some("captured target"));
    assert!(result.restored);
    assert_eq!(platform.state.borrow().text, None);
    assert_eq!(platform.state.borrow().clears, 1);
}

#[test]
fn failed_send_does_not_modify_or_restore_clipboard() {
    let mut config = base_config();
    config.send_success = false;
    config.copied_text = None;
    let platform = FakePlatform::new(config);
    let result =
        run_clipboard_transaction_with_budget(&platform, || true, Duration::from_millis(5));
    assert_eq!(result.stop_reason, Some(CaptureStopReason::SendInputFailed));
    assert!(!result.restored);
    assert_eq!(result.restore_state, ClipboardRestoreState::NotNeeded);
    assert_eq!(platform.state.borrow().text.as_deref(), Some("original"));
}

#[test]
fn clipboard_without_safe_backup_still_returns_target_and_skips_restore() {
    let mut config = base_config();
    config.safe_backup = None;
    config.initial_text = Some("complex-clipboard-placeholder".into());
    let platform = FakePlatform::new(config);
    let result =
        run_clipboard_transaction_with_budget(&platform, || true, Duration::from_millis(5));
    assert_eq!(result.target.as_deref(), Some("captured target"));
    assert!(!result.restored);
    assert_eq!(result.restore_state, ClipboardRestoreState::Skipped);
    assert_eq!(
        platform.state.borrow().text.as_deref(),
        Some("captured target")
    );
}

#[test]
fn restore_failure_does_not_turn_target_success_into_failure() {
    let mut config = base_config();
    config.restore_error = true;
    let platform = FakePlatform::new(config);
    let result =
        run_clipboard_transaction_with_budget(&platform, || true, Duration::from_millis(5));
    assert_eq!(result.target.as_deref(), Some("captured target"));
    assert!(!result.restored);
    assert_eq!(result.restore_state, ClipboardRestoreState::Failed);
}

#[test]
fn unchanged_sequence_never_falls_back_to_old_clipboard_text() {
    let mut config = base_config();
    config.copied_text = None;
    let platform = FakePlatform::new(config);
    let result =
        run_clipboard_transaction_with_budget(&platform, || true, Duration::from_millis(3));
    assert!(result.target.is_none());
    assert_eq!(result.restore_state, ClipboardRestoreState::NotNeeded);
}

#[test]
fn changed_copy_sequence_with_unreadable_text_restores_by_owned_sequence() {
    let mut config = base_config();
    config.read_error_after_send = true;
    let platform = FakePlatform::new(config);
    let result =
        run_clipboard_transaction_with_budget(&platform, || true, Duration::from_millis(3));
    assert_eq!(result.phase, ClipboardPhase::CopyObserved);
    assert!(result.target.is_none());
    assert!(!result.restored);
    assert_eq!(result.restore_state, ClipboardRestoreState::Skipped);
}

#[test]
fn restore_with_expected_text_fails_closed_when_identity_is_unreadable() {
    let mut config = base_config();
    config.restore_identity_unreadable = true;
    let platform = FakePlatform::new(config);
    let result =
        run_clipboard_transaction_with_budget(&platform, || true, Duration::from_millis(5));
    assert_eq!(result.phase, ClipboardPhase::UserModified);
    assert!(result.target.is_some());
    assert!(!result.restored);
    assert_eq!(
        platform.state.borrow().text.as_deref(),
        Some("captured target")
    );
}

#[test]
fn later_user_copy_is_not_overwritten() {
    let mut config = base_config();
    config.user_modifies_after_copy = true;
    let platform = FakePlatform::new(config);
    let result =
        run_clipboard_transaction_with_budget(&platform, || true, Duration::from_millis(5));
    assert_eq!(result.phase, ClipboardPhase::UserModified);
    assert!(!result.restored);
    assert_eq!(
        platform.state.borrow().text.as_deref(),
        Some("user-new-content")
    );
}

#[test]
fn user_copy_during_settle_is_not_treated_as_target_or_overwritten() {
    let mut config = base_config();
    config.user_modifies_during_settle = true;
    let platform = FakePlatform::new(config);
    let result =
        run_clipboard_transaction_with_budget(&platform, || true, Duration::from_millis(5));
    assert!(result.target.is_none());
    assert_eq!(result.phase, ClipboardPhase::UserModified);
    assert_eq!(result.restore_state, ClipboardRestoreState::Skipped);
    assert_eq!(
        result.stop_reason,
        Some(CaptureStopReason::ClipboardUserModified)
    );
    assert_eq!(
        platform.state.borrow().text.as_deref(),
        Some("user-new-content")
    );
}

#[test]
fn copy_sequence_change_records_the_verified_150ms_settle_delay() {
    let config = base_config();
    let platform = FakePlatform::new(config);
    let result =
        run_clipboard_transaction_with_budget(&platform, || true, Duration::from_millis(5));
    assert!(result.target.is_some());
    assert!(platform
        .state
        .borrow()
        .sleeps
        .contains(&Duration::from_millis(150)));
}

#[test]
fn system_self_window_does_not_overwrite_external_capture() {
    let state = AppState::default();
    state
        .begin_external_capture(CandidateType::DoubleClick, 12, "Notepad".into(), 123)
        .unwrap();
    state
        .update_external_capture(12, |external| {
            external.stage = DiagnosticStage::TargetCaptured;
            external.result = DiagnosticResult::Success;
            external.target_preview = "test".into();
            external.target_length = 4;
        })
        .unwrap();
    state
        .update_system_event(|system| {
            system.last_mouse_event = DiagnosticEvent::MouseUp;
            system.reason_code = "self_window".into();
            system.foreground_title = "Orange翻译".into();
            system.foreground_pid = std::process::id();
        })
        .unwrap();
    let diagnostics = state.target_diagnostics().unwrap();
    assert_eq!(diagnostics.system_event.reason_code, "self_window");
    let external = diagnostics.external_capture.unwrap();
    assert_eq!(external.foreground_title, "Notepad");
    assert_eq!(external.target_preview, "test");
}

#[test]
fn diagnostic_target_preview_is_bounded_and_only_in_external_memory_state() {
    let target = "a".repeat(450);
    let preview = target_preview(&target);
    assert_eq!(preview.chars().count(), 400);
    assert!(preview.ends_with('…'));

    let state = AppState::default();
    state
        .begin_external_capture(CandidateType::Drag, 4, "Notepad".into(), 12)
        .unwrap();
    let diagnostics = state
        .update_external_capture(4, |external| {
            external.target_preview = preview.clone();
            external.target_length = 450;
        })
        .unwrap()
        .unwrap();
    let json = serde_json::to_value(&diagnostics).unwrap();
    assert_eq!(json["externalCapture"]["targetLength"], 450);
    assert!(json["externalCapture"]["targetPreview"].as_str().is_some());
    let system_json = serde_json::to_value(&diagnostics.system_event).unwrap();
    assert!(system_json.get("targetPreview").is_none());
}

#[test]
fn popup_ack_requires_both_generations_and_accepts_pending_emit_race() {
    let state = AppState::default();
    state
        .begin_external_capture(CandidateType::DoubleClick, 12, "Notepad".into(), 123)
        .unwrap();
    state
        .update_external_capture(12, |external| {
            external.translation_generation = 7;
            external.popup_emit_state = PopupAttemptState::Pending;
            external.popup_ack_state = PopupAckState::No;
        })
        .unwrap();
    assert!(!state.acknowledge_target_diagnostic(11, 7).unwrap().0);
    assert!(!state.acknowledge_target_diagnostic(12, 6).unwrap().0);
    let (accepted, diagnostics) = state.acknowledge_target_diagnostic(12, 7).unwrap();
    assert!(accepted);
    let external = diagnostics.unwrap().external_capture.unwrap();
    assert_eq!(external.popup_ack_state, PopupAckState::Yes);
    assert_eq!(external.stage, DiagnosticStage::PopupAcknowledged);
    assert!(!state.acknowledge_target_diagnostic(12, 7).unwrap().0);
}

#[test]
fn stale_external_generation_cannot_overwrite_new_capture() {
    let state = AppState::default();
    state
        .begin_external_capture(CandidateType::Drag, 20, "New".into(), 20)
        .unwrap();
    assert!(state
        .update_external_capture(19, |external| external.result = DiagnosticResult::Failed)
        .unwrap()
        .is_none());
    let external = state
        .target_diagnostics()
        .unwrap()
        .external_capture
        .unwrap();
    assert_eq!(external.capture_generation, 20);
    assert_eq!(external.result, DiagnosticResult::None);
}

#[test]
fn diagnostic_popup_payload_contains_real_target_while_manual_mock_stays_unchanged() {
    let selection = SelectionSnapshot {
        selection_id: "selection-5".into(),
        capture_generation: 5,
        target_length: 4,
        request_type: RequestType::WordAnalysis,
        foreground_hwnd: "0x1".into(),
        foreground_pid: 2,
        page_title: "Notepad".into(),
        mouse_x: 10,
        mouse_y: 20,
        captured_at_unix_ms: 30,
    };
    let payload = MockTranslationState::target_diagnostic(7, "test".into(), selection);
    assert!(payload.capture_diagnostic);
    assert_eq!(payload.target.as_deref(), Some("test"));
    assert_eq!(payload.title, "TARGET 捕获测试");
    assert!(payload.body.contains("类型：Word"));

    for payload in [
        MockTranslationState::loading(8),
        MockTranslationState::word(9),
        MockTranslationState::sentence(10),
        MockTranslationState::error(11),
    ] {
        assert!(!payload.capture_diagnostic);
        assert!(payload.target.is_none());
    }
}

#[test]
fn clipboard_failures_have_distinct_diagnostic_reason_codes() {
    let mut config = base_config();
    config.copied_text = None;
    let unchanged = run_clipboard_transaction_with_budget(
        &FakePlatform::new(config),
        || true,
        Duration::from_millis(2),
    );
    assert_eq!(
        unchanged.stop_reason.unwrap().reason_code(),
        "clipboard_unchanged"
    );

    let mut config = base_config();
    config.read_error_after_send = true;
    let unavailable = run_clipboard_transaction_with_budget(
        &FakePlatform::new(config),
        || true,
        Duration::from_millis(2),
    );
    assert_eq!(
        unavailable.stop_reason.unwrap().reason_code(),
        "unicode_unavailable"
    );
    assert_eq!(
        CaptureStopReason::ModifierActive.reason_code(),
        "modifier_pressed"
    );
}

#[test]
fn target_filter_reasons_are_distinct() {
    assert_eq!(
        target_filter_reason("测试", true, false),
        Some("contains_han")
    );
    assert_eq!(
        target_filter_reason("test", false, false),
        Some("stale_generation")
    );
    assert_eq!(
        target_filter_reason("test", true, true),
        Some("duplicate_target")
    );
    assert_eq!(target_filter_reason("test", true, false), None);
}

#[test]
fn successful_clipboard_diagnostic_trace_reaches_target_capture_prerequisites() {
    let platform = FakePlatform::new(base_config());
    let stages = RefCell::new(Vec::new());
    let result = run_clipboard_transaction_observed(
        &platform,
        || true,
        Duration::from_millis(5),
        |stage| stages.borrow_mut().push(stage),
    );
    assert_eq!(
        *stages.borrow(),
        vec![
            ClipboardTraceStage::Snapshot,
            ClipboardTraceStage::CtrlCSent,
            ClipboardTraceStage::ClipboardChanged,
        ]
    );
    assert!(result.target.is_some());
    assert!(result.restored);
}

#[test]
fn stale_generation_after_copy_cannot_return_target_and_restores() {
    let platform = FakePlatform::new(base_config());
    let calls = RefCell::new(0usize);
    let result = run_clipboard_transaction_with_budget(
        &platform,
        || {
            let mut calls = calls.borrow_mut();
            *calls += 1;
            *calls == 1
        },
        Duration::from_millis(5),
    );
    assert!(result.target.is_none());
    assert_eq!(result.stop_reason, Some(CaptureStopReason::StaleGeneration));
    assert!(result.restored);
}

#[test]
fn popup_click_action_hides_only_visible_external_clicks() {
    let bounds = WindowBounds {
        left: 100,
        top: 100,
        right: 300,
        bottom: 250,
    };
    assert_eq!(
        popup_click_action(true, Some(bounds), 99, 150),
        PopupClickAction::Hide
    );
    assert_eq!(
        popup_click_action(true, Some(bounds), 100, 100),
        PopupClickAction::Keep
    );
    assert_eq!(
        popup_click_action(true, Some(bounds), 299, 249),
        PopupClickAction::Keep
    );
    assert_eq!(popup_click_action(true, None, 0, 0), PopupClickAction::Keep);
    assert_eq!(
        popup_click_action(false, Some(bounds), 0, 0),
        PopupClickAction::Keep
    );
}

#[test]
fn hiding_an_old_popup_does_not_consume_the_new_selection_mouse_down() {
    let action = popup_click_action(
        true,
        Some(WindowBounds {
            left: 100,
            top: 100,
            right: 300,
            bottom: 250,
        }),
        10,
        10,
    );
    assert_eq!(action, PopupClickAction::Hide);

    let mut detector = GestureDetector::default();
    assert_eq!(
        detector.handle(mouse(MouseEventKind::LeftDown, 10, 10, 1), METRICS),
        None
    );
    assert_eq!(
        detector
            .handle(mouse(MouseEventKind::LeftUp, 20, 10, 20), METRICS)
            .unwrap()
            .kind,
        GestureKind::Drag
    );
}

#[test]
fn target_normalization_han_filter_and_request_classification_match_browser_semantics() {
    assert_eq!(
        normalize_target("  hello-world  ").as_deref(),
        Some("hello-world")
    );
    assert_eq!(normalize_target("\t\n"), None);
    assert!(!contains_han("English only"));
    assert!(contains_han("hello世界"));
    assert!(contains_han("\u{20000}"));
    assert_eq!(classify_target("don't"), RequestType::WordAnalysis);
    assert_eq!(
        classify_target("state-of-the-art"),
        RequestType::WordAnalysis
    );
    assert_eq!(
        classify_target("two words"),
        RequestType::SentenceTranslation
    );
}

#[test]
fn own_process_is_excluded_and_dedupe_uses_hwnd_target_and_window() {
    assert!(is_orange_process(42, 42));
    assert!(!is_orange_process(41, 42));
    let mut dedupe = TargetDedupe::default();
    let now = Instant::now();
    assert!(!dedupe.is_duplicate(1, "same", now));
    assert!(dedupe.is_duplicate(1, "same", now + Duration::from_millis(100)));
    assert!(!dedupe.is_duplicate(2, "same", now + Duration::from_millis(200)));
    assert!(!dedupe.is_duplicate(2, "same", now + Duration::from_millis(1000)));
}
