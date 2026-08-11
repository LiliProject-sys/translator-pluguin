mod uia_context;
mod win32;

use crate::app_state::{
    target_preview, AppState, CandidateType, ClipboardRestoreState, DiagnosticEvent,
    DiagnosticResult, DiagnosticStage, LatestGatewayTarget, PopupAckState, PopupAttemptState,
    RequestType, SelectionSnapshot,
};
use serde::Serialize;
use std::{
    collections::hash_map::DefaultHasher,
    hash::{Hash, Hasher},
    sync::{
        atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering},
        mpsc::{self, Receiver},
        Arc, Condvar, Mutex,
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Manager};

pub use win32::Win32CapturePlatform;

pub const SELECTION_SETTLE_DELAY: Duration = Duration::from_millis(100);
pub const CLIPBOARD_POLL_INTERVAL: Duration = Duration::from_millis(10);
pub const CLIPBOARD_WAIT_BUDGET: Duration = Duration::from_millis(500);
pub const CLIPBOARD_COPY_SETTLE_DELAY: Duration = Duration::from_millis(150);
pub const MOCK_RESULT_DELAY: Duration = Duration::from_millis(250);
pub const DEDUPE_WINDOW: Duration = Duration::from_millis(750);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MouseEventKind {
    LeftDown,
    LeftUp,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RawMouseEvent {
    pub kind: MouseEventKind,
    pub x: i32,
    pub y: i32,
    pub time: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WindowBounds {
    pub left: i32,
    pub top: i32,
    pub right: i32,
    pub bottom: i32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PopupClickAction {
    Keep,
    Hide,
}

pub fn popup_click_action(
    visible: bool,
    bounds: Option<WindowBounds>,
    x: i32,
    y: i32,
) -> PopupClickAction {
    if !visible {
        return PopupClickAction::Keep;
    }
    let Some(bounds) = bounds else {
        return PopupClickAction::Keep;
    };
    if x >= bounds.left && x < bounds.right && y >= bounds.top && y < bounds.bottom {
        PopupClickAction::Keep
    } else {
        PopupClickAction::Hide
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GestureKind {
    Drag,
    DoubleClick,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct GestureCandidate {
    pub kind: GestureKind,
    pub x: i32,
    pub y: i32,
    pub time: u32,
}

#[derive(Debug, Clone, Copy)]
pub struct GestureMetrics {
    pub drag_x: i32,
    pub drag_y: i32,
    pub double_click_x: i32,
    pub double_click_y: i32,
    pub double_click_ms: u32,
}

#[derive(Default)]
pub struct GestureDetector {
    down: Option<RawMouseEvent>,
    previous_click: Option<RawMouseEvent>,
}

impl GestureDetector {
    pub fn handle(
        &mut self,
        event: RawMouseEvent,
        metrics: GestureMetrics,
    ) -> Option<GestureCandidate> {
        match event.kind {
            MouseEventKind::LeftDown => {
                self.down = Some(event);
                None
            }
            MouseEventKind::LeftUp => {
                let down = self.down.take()?;
                let dx = event.x.abs_diff(down.x) as i32;
                let dy = event.y.abs_diff(down.y) as i32;
                if dx >= metrics.drag_x.max(1) || dy >= metrics.drag_y.max(1) {
                    self.previous_click = None;
                    return Some(GestureCandidate {
                        kind: GestureKind::Drag,
                        x: event.x,
                        y: event.y,
                        time: event.time,
                    });
                }

                if let Some(previous) = self.previous_click.take() {
                    let elapsed = event.time.wrapping_sub(previous.time);
                    let max_x = (metrics.double_click_x.max(2) / 2) as u32;
                    let max_y = (metrics.double_click_y.max(2) / 2) as u32;
                    if elapsed <= metrics.double_click_ms
                        && event.x.abs_diff(previous.x) <= max_x
                        && event.y.abs_diff(previous.y) <= max_y
                    {
                        return Some(GestureCandidate {
                            kind: GestureKind::DoubleClick,
                            x: event.x,
                            y: event.y,
                            time: event.time,
                        });
                    }
                }
                self.previous_click = Some(event);
                None
            }
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ForegroundWindow {
    pub hwnd: isize,
    pub pid: u32,
    pub title: String,
    pub app_name: String,
}

#[derive(Debug, Clone)]
struct CaptureCandidate {
    generation: u64,
    foreground: ForegroundWindow,
    mouse_x: i32,
    mouse_y: i32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OriginalClipboard {
    Empty,
    Unicode(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClipboardSnapshot {
    pub safe_backup: Option<OriginalClipboard>,
    pub sequence: u32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClipboardRead {
    pub text: Option<String>,
    pub sequence: u32,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ClipboardFormatAvailability {
    Yes,
    No,
    #[default]
    Error,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ClipboardStepState {
    Success,
    Failed,
    #[default]
    NotAttempted,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ClipboardTestResult {
    Success,
    #[default]
    Failed,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ClipboardErrorStage {
    #[default]
    None,
    OpenClipboard,
    FormatUnavailable,
    GetClipboardData,
    GlobalLock,
    DecodeUtf16,
    EmptyText,
    Other,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipboardUnicodeDiagnostic {
    pub format_available: ClipboardFormatAvailability,
    pub get_data_state: ClipboardStepState,
    pub global_lock_state: ClipboardStepState,
    pub character_count: usize,
    pub result: ClipboardTestResult,
    pub error_stage: ClipboardErrorStage,
    pub reason_code: String,
    pub last_error: u32,
    pub text_preview: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ClipboardPhase {
    Original,
    CopyObserved,
    UserModified,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CaptureStopReason {
    ModifierActive,
    ClipboardSnapshotFailed,
    ClipboardSequenceZero,
    SendInputFailed,
    ClipboardUnchanged,
    ClipboardUserModified,
    UnicodeUnavailable,
    StaleGeneration,
}

impl CaptureStopReason {
    pub fn reason_code(self) -> &'static str {
        match self {
            Self::ModifierActive => "modifier_pressed",
            Self::ClipboardSnapshotFailed => "clipboard_snapshot_failed",
            Self::ClipboardSequenceZero => "clipboard_sequence_zero",
            Self::SendInputFailed => "sendinput_incomplete",
            Self::ClipboardUnchanged => "clipboard_unchanged",
            Self::ClipboardUserModified => "clipboard_user_modified",
            Self::UnicodeUnavailable => "unicode_unavailable",
            Self::StaleGeneration => "stale_generation",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ClipboardTraceStage {
    Snapshot,
    CtrlCSent,
    ClipboardChanged,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClipboardCaptureResult {
    pub target: Option<String>,
    pub phase: ClipboardPhase,
    pub restored: bool,
    pub restore_state: ClipboardRestoreState,
    pub stop_reason: Option<CaptureStopReason>,
}

pub trait CapturePlatform {
    fn foreground(&self) -> Result<ForegroundWindow, String>;
    fn snapshot_clipboard(&self) -> Result<ClipboardSnapshot, String>;
    fn modifiers_active(&self) -> bool;
    fn send_ctrl_c(&self) -> Result<(), String>;
    fn clipboard_sequence(&self) -> u32;
    fn read_unicode(&self) -> Result<ClipboardRead, String>;
    fn restore_if_owned(
        &self,
        expected_sequence: u32,
        expected_text: Option<&str>,
        original: &OriginalClipboard,
    ) -> Result<bool, String>;
    fn sleep(&self, duration: Duration);
}

pub fn run_clipboard_transaction<P, F>(platform: &P, is_current: F) -> ClipboardCaptureResult
where
    P: CapturePlatform,
    F: Fn() -> bool,
{
    run_clipboard_transaction_observed(platform, is_current, CLIPBOARD_WAIT_BUDGET, |_| {})
}

pub fn run_clipboard_transaction_with_budget<P, F>(
    platform: &P,
    is_current: F,
    wait_budget: Duration,
) -> ClipboardCaptureResult
where
    P: CapturePlatform,
    F: Fn() -> bool,
{
    run_clipboard_transaction_observed(platform, is_current, wait_budget, |_| {})
}

pub fn run_clipboard_transaction_observed<P, F, O>(
    platform: &P,
    is_current: F,
    wait_budget: Duration,
    mut observe: O,
) -> ClipboardCaptureResult
where
    P: CapturePlatform,
    F: Fn() -> bool,
    O: FnMut(ClipboardTraceStage),
{
    let mut snapshot = match platform.snapshot_clipboard() {
        Ok(snapshot) if snapshot.sequence != 0 => snapshot,
        Ok(_) => {
            return ClipboardCaptureResult {
                target: None,
                phase: ClipboardPhase::Original,
                restored: false,
                restore_state: ClipboardRestoreState::NotNeeded,
                stop_reason: Some(CaptureStopReason::ClipboardSequenceZero),
            };
        }
        Err(_) => {
            return ClipboardCaptureResult {
                target: None,
                phase: ClipboardPhase::Original,
                restored: false,
                restore_state: ClipboardRestoreState::NotNeeded,
                stop_reason: Some(CaptureStopReason::ClipboardSnapshotFailed),
            };
        }
    };
    observe(ClipboardTraceStage::Snapshot);

    if !is_current() {
        return ClipboardCaptureResult {
            target: None,
            phase: ClipboardPhase::Original,
            restored: false,
            restore_state: ClipboardRestoreState::NotNeeded,
            stop_reason: Some(CaptureStopReason::StaleGeneration),
        };
    }

    if platform.modifiers_active() {
        return ClipboardCaptureResult {
            target: None,
            phase: ClipboardPhase::Original,
            restored: false,
            restore_state: ClipboardRestoreState::NotNeeded,
            stop_reason: Some(CaptureStopReason::ModifierActive),
        };
    }

    // Bind the transaction to the latest sequence immediately before SendInput. If the
    // clipboard changed while the optional backup was being prepared, keep translating but
    // discard that stale backup so it can never overwrite the newer clipboard value.
    let before_sequence = platform.clipboard_sequence();
    if before_sequence == 0 {
        return ClipboardCaptureResult {
            target: None,
            phase: ClipboardPhase::Original,
            restored: false,
            restore_state: ClipboardRestoreState::NotNeeded,
            stop_reason: Some(CaptureStopReason::ClipboardSequenceZero),
        };
    }
    if before_sequence != snapshot.sequence {
        snapshot.safe_backup = None;
        snapshot.sequence = before_sequence;
    }

    if platform.send_ctrl_c().is_err() {
        return ClipboardCaptureResult {
            target: None,
            phase: ClipboardPhase::Original,
            restored: false,
            restore_state: ClipboardRestoreState::NotNeeded,
            stop_reason: Some(CaptureStopReason::SendInputFailed),
        };
    }
    observe(ClipboardTraceStage::CtrlCSent);

    let started = Instant::now();
    let mut observed: Option<ClipboardRead> = None;
    let mut observed_sequence: Option<u32> = None;
    let mut user_modified_during_settle = false;
    let mut stale = false;
    while started.elapsed() < wait_budget {
        let current_sequence = platform.clipboard_sequence();
        if current_sequence != before_sequence {
            let first_changed_sequence = if let Some(sequence) = observed_sequence {
                sequence
            } else {
                observed_sequence = Some(current_sequence);
                observe(ClipboardTraceStage::ClipboardChanged);
                platform.sleep(CLIPBOARD_COPY_SETTLE_DELAY);
                current_sequence
            };
            if let Ok(read) = platform.read_unicode() {
                if read.sequence != first_changed_sequence {
                    user_modified_during_settle = true;
                    break;
                }
                observed = Some(read);
                break;
            }
        }
        if !is_current() {
            stale = true;
            break;
        }
        platform.sleep(CLIPBOARD_POLL_INTERVAL);
    }
    if !is_current() {
        stale = true;
    }

    let (phase, expected_sequence, expected_text, accepted_target) = if user_modified_during_settle
    {
        (ClipboardPhase::UserModified, before_sequence, None, None)
    } else {
        match observed {
            Some(read) => {
                let target = read
                    .text
                    .as_ref()
                    .filter(|text| !text.trim().is_empty())
                    .cloned();
                (
                    ClipboardPhase::CopyObserved,
                    read.sequence,
                    read.text,
                    target,
                )
            }
            None => match observed_sequence {
                Some(sequence) => (ClipboardPhase::CopyObserved, sequence, None, None),
                None => (ClipboardPhase::Original, before_sequence, None, None),
            },
        }
    };

    let mut final_phase = phase;
    let (restored, restore_state) = match (snapshot.safe_backup.as_ref(), expected_text.as_deref())
    {
        (Some(backup), Some(expected)) => {
            match platform.restore_if_owned(expected_sequence, Some(expected), backup) {
                Ok(true) => (true, ClipboardRestoreState::Success),
                Ok(false) => {
                    final_phase = ClipboardPhase::UserModified;
                    (false, ClipboardRestoreState::Skipped)
                }
                Err(_) => (false, ClipboardRestoreState::Failed),
            }
        }
        (_, _) if phase == ClipboardPhase::UserModified => (false, ClipboardRestoreState::Skipped),
        (None, _) if phase == ClipboardPhase::CopyObserved => {
            (false, ClipboardRestoreState::Skipped)
        }
        (Some(_), None) if phase == ClipboardPhase::CopyObserved => {
            (false, ClipboardRestoreState::Skipped)
        }
        _ => (false, ClipboardRestoreState::NotNeeded),
    };

    let has_accepted_target = accepted_target.is_some();
    ClipboardCaptureResult {
        target: if stale { None } else { accepted_target },
        phase: final_phase,
        restored,
        restore_state,
        stop_reason: if stale {
            Some(CaptureStopReason::StaleGeneration)
        } else if user_modified_during_settle {
            Some(CaptureStopReason::ClipboardUserModified)
        } else if !has_accepted_target {
            Some(if observed_sequence.is_some() {
                CaptureStopReason::UnicodeUnavailable
            } else {
                CaptureStopReason::ClipboardUnchanged
            })
        } else {
            None
        },
    }
}

pub fn any_modifier_pressed(states: [bool; 5]) -> bool {
    states.into_iter().any(|pressed| pressed)
}

pub fn is_orange_process(pid: u32, orange_pid: u32) -> bool {
    pid == orange_pid
}

pub fn normalize_target(text: &str) -> Option<String> {
    let normalized = text.trim();
    (!normalized.is_empty()).then(|| normalized.to_owned())
}

pub fn contains_han(text: &str) -> bool {
    text.chars().any(|character| {
        matches!(character as u32,
            0x2E80..=0x2FFF
                | 0x3005..=0x3007
                | 0x3021..=0x3029
                | 0x3038..=0x303B
                | 0x31C0..=0x31EF
                | 0x3400..=0x4DBF
                | 0x4E00..=0x9FFF
                | 0xF900..=0xFAFF
                | 0x20000..=0x2FA1F
                | 0x30000..=0x323AF)
    })
}

pub fn classify_target(text: &str) -> RequestType {
    if text.chars().any(char::is_whitespace) {
        RequestType::SentenceTranslation
    } else {
        RequestType::WordAnalysis
    }
}

pub fn target_filter_reason(
    target: &str,
    generation_current: bool,
    duplicate: bool,
) -> Option<&'static str> {
    if contains_han(target) {
        Some("contains_han")
    } else if !generation_current {
        Some("stale_generation")
    } else if duplicate {
        Some("duplicate_target")
    } else {
        None
    }
}

#[derive(Default)]
pub struct TargetDedupe {
    previous: Option<(isize, u64, Instant)>,
}

impl TargetDedupe {
    pub fn is_duplicate(&mut self, hwnd: isize, target: &str, now: Instant) -> bool {
        let mut hasher = DefaultHasher::new();
        target.hash(&mut hasher);
        let fingerprint = hasher.finish();
        let duplicate = self.previous.is_some_and(|(old_hwnd, old_hash, old_time)| {
            old_hwnd == hwnd
                && old_hash == fingerprint
                && now.saturating_duration_since(old_time) <= DEDUPE_WINDOW
        });
        self.previous = Some((hwnd, fingerprint, now));
        duplicate
    }
}

struct CandidateSlot {
    candidate: Mutex<Option<CaptureCandidate>>,
    ready: Condvar,
}

impl CandidateSlot {
    fn new() -> Self {
        Self {
            candidate: Mutex::new(None),
            ready: Condvar::new(),
        }
    }

    fn replace(&self, candidate: CaptureCandidate) -> bool {
        if let Ok(mut pending) = self.candidate.lock() {
            let replaced = pending.is_some();
            *pending = Some(candidate);
            self.ready.notify_one();
            replaced
        } else {
            false
        }
    }

    #[cfg(test)]
    fn take_now(&self, stopped: &AtomicBool) -> Option<CaptureCandidate> {
        if stopped.load(Ordering::SeqCst) {
            return None;
        }
        self.candidate.lock().ok()?.take()
    }
}

fn candidate_type(kind: GestureKind) -> CandidateType {
    match kind {
        GestureKind::Drag => CandidateType::Drag,
        GestureKind::DoubleClick => CandidateType::DoubleClick,
    }
}

fn diagnostic_event(kind: GestureKind) -> DiagnosticEvent {
    match kind {
        GestureKind::Drag => DiagnosticEvent::DragCandidate,
        GestureKind::DoubleClick => DiagnosticEvent::DoubleClickCandidate,
    }
}

fn diagnostic_title(title: &str) -> String {
    title.chars().take(96).collect()
}

fn capture_gate_allows(
    stopped: bool,
    auto_translate_enabled: bool,
    current_generation: u64,
    candidate: &CaptureCandidate,
    current_foreground: Option<&ForegroundWindow>,
    orange_pid: u32,
) -> bool {
    capture_gate_reason(
        stopped,
        auto_translate_enabled,
        current_generation,
        candidate,
        current_foreground,
        orange_pid,
    )
    .is_none()
}

fn capture_gate_reason(
    stopped: bool,
    auto_translate_enabled: bool,
    current_generation: u64,
    candidate: &CaptureCandidate,
    current_foreground: Option<&ForegroundWindow>,
    orange_pid: u32,
) -> Option<&'static str> {
    if stopped {
        return Some("stale_generation");
    }
    if !auto_translate_enabled {
        return Some("auto_translate_disabled");
    }
    if current_generation != candidate.generation {
        return Some("candidate_replaced");
    }
    let Some(foreground) = current_foreground else {
        return Some("foreground_unavailable");
    };
    if foreground.pid == orange_pid {
        return Some("self_window");
    }
    if foreground.hwnd != candidate.foreground.hwnd || foreground.pid != candidate.foreground.pid {
        return Some("foreground_changed");
    }
    None
}

pub(super) fn processing_is_running(stopped: &AtomicBool) -> bool {
    !stopped.load(Ordering::SeqCst)
}

fn context_capture_is_current(
    stopped: bool,
    auto_translate_enabled: bool,
    current_generation: u64,
    candidate_generation: u64,
) -> bool {
    !stopped && auto_translate_enabled && current_generation == candidate_generation
}

pub struct CaptureController {
    stopped: Arc<AtomicBool>,
    hook_thread_id: Arc<AtomicU32>,
    slot: Arc<CandidateSlot>,
    threads: Mutex<Vec<JoinHandle<()>>>,
}

impl CaptureController {
    pub fn start(app: AppHandle, owner_hwnd: isize) -> Result<Self, String> {
        let stopped = Arc::new(AtomicBool::new(false));
        let hook_thread_id = Arc::new(AtomicU32::new(0));
        let slot = Arc::new(CandidateSlot::new());
        let capture_generation = Arc::new(AtomicU64::new(0));
        let (raw_sender, raw_receiver) = mpsc::sync_channel(128);
        let (installed_sender, installed_receiver) = mpsc::sync_channel(1);

        let hook_stop = stopped.clone();
        let hook_id = hook_thread_id.clone();
        let hook_thread = thread::Builder::new()
            .name("orange-mouse-hook".into())
            .spawn(move || {
                win32::run_mouse_hook(raw_sender, installed_sender, hook_stop, hook_id);
            })
            .map_err(|error| error.to_string())?;

        match installed_receiver.recv_timeout(Duration::from_secs(2)) {
            Ok(Ok(())) => {}
            Ok(Err(error)) => {
                stopped.store(true, Ordering::SeqCst);
                let _ = hook_thread.join();
                return Err(error);
            }
            Err(error) => {
                stopped.store(true, Ordering::SeqCst);
                win32::stop_hook_thread(hook_thread_id.load(Ordering::SeqCst));
                let _ = hook_thread.join();
                return Err(format!("hook install handshake failed: {error}"));
            }
        }

        let gesture_thread = match spawn_gesture_thread(
            app.clone(),
            raw_receiver,
            stopped.clone(),
            slot.clone(),
            capture_generation.clone(),
        ) {
            Ok(thread) => thread,
            Err(error) => {
                stopped.store(true, Ordering::SeqCst);
                win32::stop_hook_thread(hook_thread_id.load(Ordering::SeqCst));
                let _ = hook_thread.join();
                return Err(error);
            }
        };
        let worker_thread = match spawn_capture_worker(
            app,
            owner_hwnd,
            stopped.clone(),
            slot.clone(),
            capture_generation,
        ) {
            Ok(thread) => thread,
            Err(error) => {
                stopped.store(true, Ordering::SeqCst);
                slot.ready.notify_all();
                win32::stop_hook_thread(hook_thread_id.load(Ordering::SeqCst));
                let _ = hook_thread.join();
                let _ = gesture_thread.join();
                return Err(error);
            }
        };

        Ok(Self {
            stopped,
            hook_thread_id,
            slot,
            threads: Mutex::new(vec![hook_thread, gesture_thread, worker_thread]),
        })
    }

    pub fn shutdown(&self) {
        if self.stopped.swap(true, Ordering::SeqCst) {
            return;
        }
        self.slot.ready.notify_all();
        win32::stop_hook_thread(self.hook_thread_id.load(Ordering::SeqCst));
        if let Ok(mut threads) = self.threads.lock() {
            for handle in threads.drain(..) {
                let _ = handle.join();
            }
        }
    }
}

impl Drop for CaptureController {
    fn drop(&mut self) {
        self.shutdown();
    }
}

fn spawn_gesture_thread(
    app: AppHandle,
    receiver: Receiver<RawMouseEvent>,
    stopped: Arc<AtomicBool>,
    slot: Arc<CandidateSlot>,
    capture_generation: Arc<AtomicU64>,
) -> Result<JoinHandle<()>, String> {
    thread::Builder::new()
        .name("orange-selection-gesture".into())
        .spawn(move || {
            let metrics = win32::gesture_metrics();
            let mut detector = GestureDetector::default();
            while !stopped.load(Ordering::SeqCst) {
                let Ok(event) = receiver.recv_timeout(Duration::from_millis(50)) else {
                    continue;
                };
                if event.kind == MouseEventKind::LeftDown {
                    hide_popup_for_external_click(&app, event);
                }
                let current_foreground = win32::foreground_window().ok();
                let _ = crate::publish_target_capture_diagnostic(&app, |diagnostic| {
                    diagnostic.last_mouse_event = match event.kind {
                        MouseEventKind::LeftDown => DiagnosticEvent::MouseDown,
                        MouseEventKind::LeftUp => DiagnosticEvent::MouseUp,
                    };
                    if let Some(foreground) = current_foreground.as_ref() {
                        diagnostic.foreground_title = diagnostic_title(&foreground.title);
                        diagnostic.foreground_pid = foreground.pid;
                    }
                });
                let Some(gesture) = detector.handle(event, metrics) else {
                    if event.kind == MouseEventKind::LeftUp {
                        let _ = crate::publish_target_capture_diagnostic(&app, |diagnostic| {
                            diagnostic.reason_code = "single_click".into();
                            diagnostic.candidate_type = None;
                        });
                    }
                    continue;
                };
                let kind = candidate_type(gesture.kind);
                let event = diagnostic_event(gesture.kind);
                let _ = crate::publish_target_capture_diagnostic(&app, |diagnostic| {
                    diagnostic.last_mouse_event = event;
                    diagnostic.reason_code.clear();
                    diagnostic.candidate_type = Some(kind);
                });
                if !app.state::<AppState>().is_auto_translate_enabled() {
                    let _ = crate::publish_target_capture_diagnostic(&app, |diagnostic| {
                        diagnostic.reason_code = "auto_translate_disabled".into();
                    });
                    continue;
                }
                let foreground = match win32::foreground_window() {
                    Ok(foreground) => foreground,
                    Err(_) => {
                        let _ = crate::publish_target_capture_diagnostic(&app, |diagnostic| {
                            diagnostic.reason_code = "foreground_unavailable".into();
                        });
                        continue;
                    }
                };
                if foreground.pid == std::process::id() {
                    let title = diagnostic_title(&foreground.title);
                    let _ = crate::publish_target_capture_diagnostic(&app, |diagnostic| {
                        diagnostic.reason_code = "self_window".into();
                        diagnostic.foreground_title = title;
                        diagnostic.foreground_pid = foreground.pid;
                    });
                    continue;
                }
                let generation = capture_generation.fetch_add(1, Ordering::SeqCst) + 1;
                let title = diagnostic_title(&foreground.title);
                let _ = crate::publish_target_capture_diagnostic(&app, |diagnostic| {
                    diagnostic.generation = generation;
                    diagnostic.foreground_title = title.clone();
                    diagnostic.foreground_pid = foreground.pid;
                });
                let _ = crate::publish_new_external_capture(
                    &app,
                    kind,
                    generation,
                    title,
                    foreground.pid,
                );
                let candidate = CaptureCandidate {
                    generation,
                    foreground,
                    mouse_x: gesture.x,
                    mouse_y: gesture.y,
                };
                let replaced = slot.replace(candidate);
                let _ =
                    crate::publish_external_capture_diagnostic(&app, generation, |diagnostic| {
                        diagnostic.stage = DiagnosticStage::WaitingSelection;
                        diagnostic.result = DiagnosticResult::None;
                        diagnostic.reason_code = if replaced {
                            "candidate_replaced".into()
                        } else {
                            String::new()
                        };
                    });
            }
        })
        .map_err(|error| error.to_string())
}

fn hide_popup_for_external_click(app: &AppHandle, event: RawMouseEvent) {
    let Some(popup) = app.get_webview_window("popup") else {
        return;
    };
    let visible = popup.is_visible().unwrap_or(false);
    let bounds = visible
        .then(|| popup.hwnd().ok())
        .flatten()
        .and_then(|hwnd| win32::window_bounds(hwnd.0 as isize).ok());
    if popup_click_action(visible, bounds, event.x, event.y) == PopupClickAction::Hide {
        let _ = popup.hide();
    }
}

fn spawn_capture_worker(
    app: AppHandle,
    owner_hwnd: isize,
    stopped: Arc<AtomicBool>,
    slot: Arc<CandidateSlot>,
    capture_generation: Arc<AtomicU64>,
) -> Result<JoinHandle<()>, String> {
    let uia_context = uia_context::UiaContextService::start();
    thread::Builder::new()
        .name("orange-target-capture".into())
        .spawn(move || {
            let platform = Win32CapturePlatform::new(owner_hwnd);
            let mut dedupe = TargetDedupe::default();
            while !stopped.load(Ordering::SeqCst) {
                let candidate = {
                    let mut pending = match slot.candidate.lock() {
                        Ok(pending) => pending,
                        Err(_) => break,
                    };
                    while pending.is_none() && !stopped.load(Ordering::SeqCst) {
                        let result = slot.ready.wait_timeout(pending, Duration::from_millis(100));
                        match result {
                            Ok((next, _)) => pending = next,
                            Err(_) => return,
                        }
                    }
                    pending.take()
                };
                let Some(candidate) = candidate else {
                    continue;
                };

                thread::sleep(SELECTION_SETTLE_DELAY);
                let _ = crate::publish_external_capture_diagnostic(
                    &app,
                    candidate.generation,
                    |diagnostic| {
                        diagnostic.stage = DiagnosticStage::CaptureStarted;
                        diagnostic.result = DiagnosticResult::None;
                        diagnostic.reason_code.clear();
                    },
                );
                let generation_is_current = || {
                    !stopped.load(Ordering::SeqCst)
                        && capture_generation.load(Ordering::SeqCst) == candidate.generation
                        && app.state::<AppState>().is_auto_translate_enabled()
                };
                let current_foreground = platform.foreground().ok();
                if let Some(reason) = capture_gate_reason(
                    stopped.load(Ordering::SeqCst),
                    app.state::<AppState>().is_auto_translate_enabled(),
                    capture_generation.load(Ordering::SeqCst),
                    &candidate,
                    current_foreground.as_ref(),
                    std::process::id(),
                ) {
                    let _ = crate::publish_external_capture_diagnostic(
                        &app,
                        candidate.generation,
                        |diagnostic| {
                            diagnostic.stage = DiagnosticStage::GateRejected;
                            diagnostic.result = DiagnosticResult::Ignored;
                            diagnostic.reason_code = reason.into();
                        },
                    );
                    continue;
                }
                let capture_is_current = || {
                    let foreground = platform.foreground().ok();
                    capture_gate_allows(
                        stopped.load(Ordering::SeqCst),
                        app.state::<AppState>().is_auto_translate_enabled(),
                        capture_generation.load(Ordering::SeqCst),
                        &candidate,
                        foreground.as_ref(),
                        std::process::id(),
                    )
                };
                let result = run_clipboard_transaction_observed(
                    &platform,
                    capture_is_current,
                    CLIPBOARD_WAIT_BUDGET,
                    |stage| {
                        let _ = crate::publish_external_capture_diagnostic(
                            &app,
                            candidate.generation,
                            |diagnostic| {
                                diagnostic.stage = match stage {
                                    ClipboardTraceStage::Snapshot => {
                                        DiagnosticStage::ClipboardSnapshot
                                    }
                                    ClipboardTraceStage::CtrlCSent => DiagnosticStage::CtrlCSent,
                                    ClipboardTraceStage::ClipboardChanged => {
                                        DiagnosticStage::ClipboardChanged
                                    }
                                };
                            },
                        );
                    },
                );
                let restore_state = result.restore_state;
                if result.restore_state == ClipboardRestoreState::Failed {
                    eprintln!(
                        "target-capture stage=clipboard-restore status=failed phase={:?}",
                        result.phase
                    );
                }
                let Some(raw_target) = result.target else {
                    let reason = result
                        .stop_reason
                        .map(CaptureStopReason::reason_code)
                        .unwrap_or("clipboard_snapshot_failed");
                    let _ = crate::publish_external_capture_diagnostic(
                        &app,
                        candidate.generation,
                        |diagnostic| {
                            diagnostic.stage = if matches!(
                                result.stop_reason,
                                Some(CaptureStopReason::ModifierActive)
                                    | Some(CaptureStopReason::StaleGeneration)
                            ) {
                                DiagnosticStage::GateRejected
                            } else {
                                DiagnosticStage::CaptureFailed
                            };
                            diagnostic.result = if matches!(
                                result.stop_reason,
                                Some(CaptureStopReason::ModifierActive)
                                    | Some(CaptureStopReason::StaleGeneration)
                            ) {
                                DiagnosticResult::Ignored
                            } else {
                                DiagnosticResult::Failed
                            };
                            diagnostic.reason_code = reason.into();
                            diagnostic.clipboard_restore_state = restore_state;
                        },
                    );
                    continue;
                };
                let Some(target) = normalize_target(&raw_target) else {
                    let _ = crate::publish_external_capture_diagnostic(
                        &app,
                        candidate.generation,
                        |diagnostic| {
                            diagnostic.stage = DiagnosticStage::TargetFiltered;
                            diagnostic.result = DiagnosticResult::Ignored;
                            diagnostic.reason_code = "empty_target".into();
                            diagnostic.clipboard_restore_state = restore_state;
                        },
                    );
                    continue;
                };
                let generation_current = generation_is_current();
                let duplicate = generation_current
                    && !contains_han(&target)
                    && dedupe.is_duplicate(candidate.foreground.hwnd, &target, Instant::now());
                if let Some(reason) = target_filter_reason(&target, generation_current, duplicate) {
                    let length = target.chars().count();
                    let preview = target_preview(&target);
                    let _ = crate::publish_external_capture_diagnostic(
                        &app,
                        candidate.generation,
                        |diagnostic| {
                            diagnostic.stage = if reason == "stale_generation" {
                                DiagnosticStage::GateRejected
                            } else {
                                DiagnosticStage::TargetFiltered
                            };
                            diagnostic.result = DiagnosticResult::Ignored;
                            diagnostic.reason_code = reason.into();
                            diagnostic.target_preview = preview;
                            diagnostic.target_length = length;
                            diagnostic.clipboard_restore_state = restore_state;
                        },
                    );
                    continue;
                }

                let request_type = classify_target(&target);
                let context = uia_context.capture(
                    uia_context::ContextCaptureRequest {
                        foreground_hwnd: candidate.foreground.hwnd,
                        foreground_pid: candidate.foreground.pid,
                        target: target.clone(),
                    },
                    uia_context::CONTEXT_WAIT,
                );
                if !context_capture_is_current(
                    stopped.load(Ordering::SeqCst),
                    app.state::<AppState>().is_auto_translate_enabled(),
                    capture_generation.load(Ordering::SeqCst),
                    candidate.generation,
                ) {
                    continue;
                }
                let translation_generation = app.state::<AppState>().next_translation_generation();
                let captured_at_unix_ms = SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_millis() as u64;
                let snapshot = SelectionSnapshot {
                    selection_id: format!("selection-{}", candidate.generation),
                    capture_generation: candidate.generation,
                    target_length: target.chars().count(),
                    request_type,
                    foreground_hwnd: format!("0x{:X}", candidate.foreground.hwnd as usize),
                    foreground_pid: candidate.foreground.pid,
                    page_title: candidate.foreground.title.clone(),
                    mouse_x: candidate.mouse_x,
                    mouse_y: candidate.mouse_y,
                    captured_at_unix_ms,
                };
                let target_length = snapshot.target_length;
                let request_type = snapshot.request_type;
                let preview = target_preview(&target);
                let gateway_target = LatestGatewayTarget {
                    target,
                    request_type,
                    page_title: snapshot.page_title.clone(),
                    source_app: candidate.foreground.app_name.clone(),
                    capture_generation: snapshot.capture_generation,
                    translation_generation,
                    captured_at_unix_ms,
                    context,
                };
                let _ = crate::publish_latest_gateway_target(&app, gateway_target.clone());
                let _ = crate::publish_external_capture_diagnostic(
                    &app,
                    candidate.generation,
                    |diagnostic| {
                        diagnostic.stage = DiagnosticStage::TargetCaptured;
                        diagnostic.result = DiagnosticResult::Success;
                        diagnostic.reason_code.clear();
                        diagnostic.target_preview = preview;
                        diagnostic.target_length = target_length;
                        diagnostic.request_type = Some(request_type);
                        diagnostic.clipboard_restore_state = restore_state;
                        diagnostic.translation_generation = translation_generation;
                        diagnostic.popup_ack_state = PopupAckState::NotExpected;
                        diagnostic.popup_show_state = PopupAttemptState::NotAttempted;
                        diagnostic.popup_emit_state = PopupAttemptState::NotAttempted;
                    },
                );
                #[cfg(not(test))]
                crate::start_automatic_gateway_translation(&app, gateway_target);
                #[cfg(test)]
                let _ = gateway_target;
            }
        })
        .map_err(|error| error.to_string())
}

#[cfg(test)]
mod internal_tests {
    use super::*;

    fn candidate(generation: u64, hwnd: isize, pid: u32) -> CaptureCandidate {
        CaptureCandidate {
            generation,
            foreground: ForegroundWindow {
                hwnd,
                pid,
                title: String::new(),
                app_name: String::new(),
            },
            mouse_x: 0,
            mouse_y: 0,
        }
    }

    #[test]
    fn candidate_slot_keeps_only_the_latest_candidate() {
        let slot = CandidateSlot::new();
        let stopped = AtomicBool::new(false);
        slot.replace(candidate(1, 10, 20));
        slot.replace(candidate(2, 11, 21));

        let pending = slot.take_now(&stopped).expect("latest candidate");
        assert_eq!(pending.generation, 2);
        assert_eq!(pending.foreground.hwnd, 11);
        assert!(slot.take_now(&stopped).is_none());
    }

    #[test]
    fn context_wait_result_is_discarded_after_generation_or_state_changes() {
        assert!(context_capture_is_current(false, true, 7, 7));
        assert!(!context_capture_is_current(false, true, 8, 7));
        assert!(!context_capture_is_current(false, false, 7, 7));
        assert!(!context_capture_is_current(true, true, 7, 7));
    }

    #[test]
    fn capture_gate_rejects_disabled_stale_changed_and_orange_foregrounds() {
        let item = candidate(7, 100, 200);
        let same = item.foreground.clone();
        assert!(capture_gate_allows(false, true, 7, &item, Some(&same), 999));
        assert!(!capture_gate_allows(true, true, 7, &item, Some(&same), 999));
        assert!(!capture_gate_allows(
            false,
            false,
            7,
            &item,
            Some(&same),
            999
        ));
        assert!(!capture_gate_allows(
            false,
            true,
            8,
            &item,
            Some(&same),
            999
        ));
        assert!(!capture_gate_allows(false, true, 7, &item, None, 999));
        assert!(!capture_gate_allows(
            false,
            true,
            7,
            &item,
            Some(&ForegroundWindow {
                hwnd: 101,
                ..same.clone()
            }),
            999,
        ));
        assert!(!capture_gate_allows(
            false,
            true,
            7,
            &item,
            Some(&ForegroundWindow {
                pid: 201,
                ..same.clone()
            }),
            999,
        ));
        assert!(!capture_gate_allows(
            false,
            true,
            7,
            &item,
            Some(&same),
            200
        ));
    }

    #[test]
    fn stopped_state_blocks_pending_work_and_hook_loop_predicate() {
        let slot = CandidateSlot::new();
        let stopped = AtomicBool::new(false);
        slot.replace(candidate(1, 10, 20));
        assert!(processing_is_running(&stopped));

        stopped.store(true, Ordering::SeqCst);
        assert!(!processing_is_running(&stopped));
        assert!(slot.take_now(&stopped).is_none());
    }
}
