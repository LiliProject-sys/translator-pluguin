use crate::{
    settings::SettingsRepository,
    vocabulary::{
        VocabularyCandidate, VocabularyComparison, VocabularyDetail, VocabularyError,
        VocabularyRepository, VocabularySource,
    },
};
use serde::{Deserialize, Serialize};
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Mutex,
};
use tauri::{menu::CheckMenuItem, Wry};

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MainSection {
    #[default]
    Home,
    Vocabulary,
    Settings,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeState {
    pub auto_translate_enabled: bool,
    pub main_section: MainSection,
    pub target_capture_available: bool,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum DiagnosticEvent {
    #[default]
    None,
    MouseDown,
    MouseUp,
    DragCandidate,
    DoubleClickCandidate,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum DiagnosticStage {
    #[default]
    Idle,
    CandidateDetected,
    WaitingSelection,
    CaptureStarted,
    GateRejected,
    ClipboardSnapshot,
    CtrlCSent,
    ClipboardChanged,
    TargetCaptured,
    TargetFiltered,
    PopupShow,
    PopupEmit,
    PopupAcknowledged,
    CaptureFailed,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum DiagnosticResult {
    #[default]
    None,
    Success,
    Ignored,
    Failed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum CandidateType {
    Drag,
    DoubleClick,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ClipboardRestoreState {
    #[default]
    NotNeeded,
    Success,
    Skipped,
    Failed,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum PopupWindowState {
    #[default]
    NotChecked,
    Exists,
    Missing,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum PopupAttemptState {
    #[default]
    NotAttempted,
    Pending,
    Success,
    Failed,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum PopupListenerState {
    Ready,
    #[default]
    NotReady,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum PopupAckState {
    #[default]
    NotExpected,
    No,
    Yes,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemEventDiagnostic {
    pub hook_ready: bool,
    pub last_mouse_event: DiagnosticEvent,
    pub candidate_type: Option<CandidateType>,
    pub reason_code: String,
    pub foreground_title: String,
    pub foreground_pid: u32,
    pub generation: u64,
}

impl Default for SystemEventDiagnostic {
    fn default() -> Self {
        Self {
            hook_ready: false,
            last_mouse_event: DiagnosticEvent::None,
            candidate_type: None,
            reason_code: String::new(),
            foreground_title: String::new(),
            foreground_pid: 0,
            generation: 0,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalCaptureDiagnostic {
    pub candidate_type: Option<CandidateType>,
    pub stage: DiagnosticStage,
    pub result: DiagnosticResult,
    pub reason_code: String,
    pub target_preview: String,
    pub target_length: usize,
    pub request_type: Option<RequestType>,
    pub clipboard_restore_state: ClipboardRestoreState,
    pub popup_window_state: PopupWindowState,
    pub popup_show_state: PopupAttemptState,
    pub popup_emit_state: PopupAttemptState,
    pub popup_listener_state: PopupListenerState,
    pub popup_ack_state: PopupAckState,
    pub capture_generation: u64,
    pub translation_generation: u64,
    pub foreground_title: String,
    pub foreground_pid: u32,
}

impl ExternalCaptureDiagnostic {
    pub fn new(
        candidate_type: CandidateType,
        capture_generation: u64,
        foreground_title: String,
        foreground_pid: u32,
        popup_listener_ready: bool,
    ) -> Self {
        Self {
            candidate_type: Some(candidate_type),
            stage: DiagnosticStage::CandidateDetected,
            result: DiagnosticResult::None,
            reason_code: String::new(),
            target_preview: String::new(),
            target_length: 0,
            request_type: None,
            clipboard_restore_state: ClipboardRestoreState::NotNeeded,
            popup_window_state: PopupWindowState::NotChecked,
            popup_show_state: PopupAttemptState::NotAttempted,
            popup_emit_state: PopupAttemptState::NotAttempted,
            popup_listener_state: if popup_listener_ready {
                PopupListenerState::Ready
            } else {
                PopupListenerState::NotReady
            },
            popup_ack_state: PopupAckState::NotExpected,
            capture_generation,
            translation_generation: 0,
            foreground_title,
            foreground_pid,
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TargetDiagnostics {
    pub system_event: SystemEventDiagnostic,
    pub external_capture: Option<ExternalCaptureDiagnostic>,
}

pub fn target_preview(target: &str) -> String {
    const PREVIEW_LIMIT: usize = 400;
    let length = target.chars().count();
    if length <= PREVIEW_LIMIT {
        target.to_owned()
    } else {
        let mut preview: String = target.chars().take(PREVIEW_LIMIT - 1).collect();
        preview.push('…');
        preview
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum RequestType {
    WordAnalysis,
    SentenceTranslation,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ContextStatus {
    Success,
    Unsupported,
    NoSelection,
    Mismatch,
    Timeout,
    Error,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ContextSource {
    Uia,
    Empty,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ContextUnit {
    Paragraph,
    Line,
    None,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextCaptureSnapshot {
    #[serde(skip)]
    pub context_sentence: String,
    pub status: ContextStatus,
    pub source: ContextSource,
    pub unit: ContextUnit,
    pub context_length: usize,
    pub context_preview: String,
}

impl ContextCaptureSnapshot {
    pub fn empty(status: ContextStatus) -> Self {
        Self {
            context_sentence: String::new(),
            status,
            source: ContextSource::Empty,
            unit: ContextUnit::None,
            context_length: 0,
            context_preview: String::new(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LatestGatewayTarget {
    pub target: String,
    pub request_type: RequestType,
    pub page_title: String,
    pub source_app: String,
    pub capture_generation: u64,
    pub translation_generation: u64,
    pub captured_at_unix_ms: u64,
    pub context: ContextCaptureSnapshot,
}

impl LatestGatewayTarget {
    pub fn target_length(&self) -> usize {
        self.target.chars().count()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GatewayKeyTerm {
    pub term: String,
    pub meaning: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WordDetailComparison {
    pub word: String,
    pub difference: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WordDetailResult {
    pub meaning_in_sentence: String,
    pub comparison: Option<WordDetailComparison>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(
    tag = "phase",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum LiveDetailPopupState {
    Loading {
        generation: u64,
        capture_generation: u64,
        quick_request_id: String,
        detail_request_id: String,
    },
    Success {
        generation: u64,
        capture_generation: u64,
        quick_request_id: String,
        detail_request_id: String,
        result: WordDetailResult,
    },
    Error {
        generation: u64,
        capture_generation: u64,
        quick_request_id: String,
        detail_request_id: String,
        message: String,
    },
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum LiveDetailPhase {
    #[default]
    Unavailable,
    Ready,
    Loading,
    Success,
    Error,
}

#[derive(Debug, Clone)]
struct LiveDetailRuntimeState {
    phase: LiveDetailPhase,
    target: Option<LatestGatewayTarget>,
    quick_request_id: Option<String>,
    detail_request_id: Option<String>,
    result: Option<WordDetailResult>,
}

impl Default for LiveDetailRuntimeState {
    fn default() -> Self {
        Self {
            phase: LiveDetailPhase::Unavailable,
            target: None,
            quick_request_id: None,
            detail_request_id: None,
            result: None,
        }
    }
}

#[derive(Debug, Clone)]
pub struct ClaimedLiveDetailRequest {
    pub target: LatestGatewayTarget,
    pub quick_request_id: String,
    pub detail_request_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum GatewayParsedResult {
    Word {
        provider: String,
        upstream_provider: String,
        skill_version: String,
        word: String,
        lemma: String,
        phonetic: String,
        part_of_speech: String,
        meaning: String,
    },
    Sentence {
        provider: String,
        upstream_provider: String,
        skill_version: String,
        translation: String,
        key_term: Option<GatewayKeyTerm>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum PopupTranslationResult {
    Word {
        word: String,
        lemma: String,
        phonetic: String,
        part_of_speech: String,
        meaning: String,
    },
    Sentence {
        translation: String,
        key_term: Option<GatewayKeyTerm>,
    },
}

impl From<&GatewayParsedResult> for PopupTranslationResult {
    fn from(result: &GatewayParsedResult) -> Self {
        match result {
            GatewayParsedResult::Word {
                word,
                lemma,
                phonetic,
                part_of_speech,
                meaning,
                ..
            } => Self::Word {
                word: word.clone(),
                lemma: lemma.clone(),
                phonetic: phonetic.clone(),
                part_of_speech: part_of_speech.clone(),
                meaning: meaning.clone(),
            },
            GatewayParsedResult::Sentence {
                translation,
                key_term,
                ..
            } => Self::Sentence {
                translation: translation.clone(),
                key_term: key_term.clone(),
            },
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(
    tag = "phase",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum LivePopupTranslationState {
    Loading {
        generation: u64,
        capture_generation: u64,
        request_id: String,
        target: String,
        request_type: RequestType,
    },
    Success {
        generation: u64,
        capture_generation: u64,
        request_id: String,
        target: String,
        result: PopupTranslationResult,
    },
    Error {
        generation: u64,
        capture_generation: u64,
        request_id: String,
        target: String,
        request_type: RequestType,
        error_kind: LivePopupErrorKind,
        message: String,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum LivePopupErrorKind {
    Retryable,
    Configuration,
    Terminal,
}

impl LivePopupTranslationState {
    pub fn loading(target: &LatestGatewayTarget, request_id: String) -> Self {
        Self::Loading {
            generation: target.translation_generation,
            capture_generation: target.capture_generation,
            request_id,
            target: target.target.clone(),
            request_type: target.request_type,
        }
    }

    pub fn success(
        target: &LatestGatewayTarget,
        request_id: String,
        result: &GatewayParsedResult,
    ) -> Self {
        Self::Success {
            generation: target.translation_generation,
            capture_generation: target.capture_generation,
            request_id,
            target: target.target.clone(),
            result: PopupTranslationResult::from(result),
        }
    }

    pub fn error(
        target: &LatestGatewayTarget,
        request_id: String,
        error_kind: LivePopupErrorKind,
    ) -> Self {
        let message = match error_kind {
            LivePopupErrorKind::Retryable => "翻译失败，请稍后重试",
            LivePopupErrorKind::Configuration => "访问码无效或未配置，请在设置中重新验证",
            LivePopupErrorKind::Terminal => "翻译失败，请重新划取后再试",
        };
        Self::Error {
            generation: target.translation_generation,
            capture_generation: target.capture_generation,
            request_id,
            target: target.target.clone(),
            request_type: target.request_type,
            error_kind,
            message: message.into(),
        }
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum GatewayConnectionState {
    #[default]
    Idle,
    Sending,
    Success,
    Failed,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum GatewayParseStatus {
    #[default]
    NotAttempted,
    Success,
    Failed,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GatewayTestState {
    pub latest_target: Option<LatestGatewayTarget>,
    pub connection_state: GatewayConnectionState,
    pub request_id: Option<String>,
    pub request_type: Option<RequestType>,
    pub request_target_length: Option<usize>,
    pub http_status: Option<u16>,
    pub latency_ms: Option<u64>,
    pub parse_status: GatewayParseStatus,
    pub parsed_result: Option<GatewayParsedResult>,
    pub raw_preview: Option<String>,
    pub error_code: Option<String>,
    pub gateway_error_code: Option<String>,
    pub error_message: Option<String>,
    pub live_error_kind: Option<LivePopupErrorKind>,
}

#[derive(Debug, Clone)]
pub struct ClaimedLiveGatewayRequest {
    pub target: LatestGatewayTarget,
    pub request_id: String,
    pub gateway_state: GatewayTestState,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SelectionSnapshot {
    pub selection_id: String,
    pub capture_generation: u64,
    pub target_length: usize,
    pub request_type: RequestType,
    pub foreground_hwnd: String,
    pub foreground_pid: u32,
    pub page_title: String,
    pub mouse_x: i32,
    pub mouse_y: i32,
    pub captured_at_unix_ms: u64,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MockScenario {
    Loading,
    WordSuccess,
    SentenceSuccess,
    Error,
    Retry,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MockTranslationState {
    #[serde(rename = "mock")]
    pub is_mock: bool,
    pub generation: u64,
    pub request_id: String,
    pub phase: String,
    pub view: String,
    pub title: String,
    pub body: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub phonetic: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub part_of_speech: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_code: Option<String>,
    pub retryable: bool,
    pub capture_diagnostic: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub selection: Option<SelectionSnapshot>,
}

impl MockTranslationState {
    pub fn loading(generation: u64) -> Self {
        Self::base(
            generation,
            "loading",
            "loading",
            "正在处理",
            "这是阶段 1 的固定 Mock 加载状态。",
        )
    }

    pub fn word(generation: u64) -> Self {
        let mut state = Self::base(generation, "success", "word", "sample", "示例；样本");
        state.phonetic = Some("/ˈsæmpəl/".into());
        state.part_of_speech = Some("n.".into());
        state.detail = Some("这是静态 Mock 详细解释，仅用于验证浮窗视觉与交互。".into());
        state
    }

    pub fn sentence(generation: u64) -> Self {
        Self::base(
            generation,
            "success",
            "sentence",
            "Sentence Translation",
            "这是一条固定的 Mock 句段译文。",
        )
    }

    pub fn error(generation: u64) -> Self {
        let mut state = Self::base(
            generation,
            "error",
            "error",
            "Mock 请求失败",
            "这是用于验证错误与重试状态的固定脱敏信息。",
        );
        state.error_code = Some("MOCK_ERROR".into());
        state.retryable = true;
        state
    }

    pub fn captured_loading(generation: u64, target: String, selection: SelectionSnapshot) -> Self {
        let mut state = Self::base(
            generation,
            "loading",
            "loading",
            "正在处理",
            "已捕获 TARGET，正在生成阶段 2 Mock 结果。",
        );
        state.request_id = format!("selection-{}", selection.capture_generation);
        state.target = Some(target);
        state.selection = Some(selection);
        state
    }

    pub fn captured_success(generation: u64, target: String, selection: SelectionSnapshot) -> Self {
        let mut state = match selection.request_type {
            RequestType::WordAnalysis => {
                let mut word = Self::base(
                    generation,
                    "success",
                    "word",
                    "Word Mock",
                    "这是固定的阶段 2 单词 Mock 释义。",
                );
                word.phonetic = Some("/mock/".into());
                word.part_of_speech = Some("mock".into());
                word.detail = Some("实际 TARGET 已捕获；详细解释仍为固定 Mock。".into());
                word
            }
            RequestType::SentenceTranslation => Self::base(
                generation,
                "success",
                "sentence",
                "Sentence Mock",
                "这是固定的阶段 2 句段 Mock 译文。",
            ),
        };
        state.request_id = format!("selection-{}", selection.capture_generation);
        state.target = Some(target);
        state.selection = Some(selection);
        state
    }

    pub fn target_diagnostic(
        generation: u64,
        target: String,
        selection: SelectionSnapshot,
    ) -> Self {
        let kind = match selection.request_type {
            RequestType::WordAnalysis => "Word",
            RequestType::SentenceTranslation => "Sentence",
        };
        let source = if selection.page_title.is_empty() {
            "未知程序"
        } else {
            selection.page_title.as_str()
        };
        let mut state = Self::base(
            generation,
            "success",
            match selection.request_type {
                RequestType::WordAnalysis => "word",
                RequestType::SentenceTranslation => "sentence",
            },
            "TARGET 捕获测试",
            &format!(
                "类型：{kind} · 长度：{} · 来源：{source}",
                selection.target_length
            ),
        );
        state.request_id = format!("selection-{}", selection.capture_generation);
        state.capture_diagnostic = true;
        state.target = Some(target);
        state.selection = Some(selection);
        state
    }

    fn base(generation: u64, phase: &str, view: &str, title: &str, body: &str) -> Self {
        Self {
            is_mock: true,
            generation,
            request_id: format!("mock-{generation}"),
            phase: phase.into(),
            view: view.into(),
            title: title.into(),
            body: body.into(),
            phonetic: None,
            part_of_speech: None,
            detail: None,
            error_code: None,
            retryable: false,
            capture_diagnostic: false,
            target: None,
            selection: None,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusToast {
    pub enabled: bool,
    pub message: String,
    pub generation: u64,
}

pub struct AppState {
    auto_translate_enabled: Mutex<bool>,
    main_section: Mutex<MainSection>,
    translation_generation: AtomicU64,
    translation_commit: Mutex<()>,
    status_generation: AtomicU64,
    exiting: AtomicBool,
    target_capture_available: AtomicBool,
    target_diagnostics: Mutex<TargetDiagnostics>,
    gateway_test_state: Mutex<GatewayTestState>,
    live_detail_state: Mutex<LiveDetailRuntimeState>,
    gateway_request_sequence: AtomicU64,
    popup_listener_ready: AtomicBool,
    settings: Mutex<Option<SettingsRepository>>,
    vocabulary: Mutex<Option<VocabularyRepository>>,
    auto_menu_item: Mutex<Option<CheckMenuItem<Wry>>>,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            auto_translate_enabled: Mutex::new(true),
            main_section: Mutex::new(MainSection::Home),
            translation_generation: AtomicU64::new(0),
            translation_commit: Mutex::new(()),
            status_generation: AtomicU64::new(0),
            exiting: AtomicBool::new(false),
            target_capture_available: AtomicBool::new(true),
            target_diagnostics: Mutex::new(TargetDiagnostics::default()),
            gateway_test_state: Mutex::new(GatewayTestState::default()),
            live_detail_state: Mutex::new(LiveDetailRuntimeState::default()),
            gateway_request_sequence: AtomicU64::new(0),
            popup_listener_ready: AtomicBool::new(false),
            settings: Mutex::new(None),
            vocabulary: Mutex::new(None),
            auto_menu_item: Mutex::new(None),
        }
    }
}

impl AppState {
    pub fn runtime(&self) -> Result<RuntimeState, String> {
        Ok(RuntimeState {
            auto_translate_enabled: *self
                .auto_translate_enabled
                .lock()
                .map_err(|_| "runtime state lock failed")?,
            main_section: *self
                .main_section
                .lock()
                .map_err(|_| "main section lock failed")?,
            target_capture_available: self.target_capture_available.load(Ordering::SeqCst),
        })
    }

    pub fn set_auto_translate(&self, enabled: bool) -> Result<RuntimeState, String> {
        if enabled && !self.target_capture_available.load(Ordering::SeqCst) {
            return Err("TARGET 捕获不可用".into());
        }
        *self
            .auto_translate_enabled
            .lock()
            .map_err(|_| "runtime state lock failed")? = enabled;
        self.runtime()
    }

    pub fn toggle_auto_translate(&self) -> Result<RuntimeState, String> {
        let mut guard = self
            .auto_translate_enabled
            .lock()
            .map_err(|_| "runtime state lock failed")?;
        if !*guard && !self.target_capture_available.load(Ordering::SeqCst) {
            return Err("TARGET 捕获不可用".into());
        }
        *guard = !*guard;
        let enabled = *guard;
        drop(guard);
        let mut runtime = self.runtime()?;
        runtime.auto_translate_enabled = enabled;
        Ok(runtime)
    }

    pub fn is_auto_translate_enabled(&self) -> bool {
        self.auto_translate_enabled
            .lock()
            .map(|value| *value)
            .unwrap_or(false)
    }

    pub fn set_main_section(&self, section: MainSection) -> Result<(), String> {
        *self
            .main_section
            .lock()
            .map_err(|_| "main section lock failed")? = section;
        Ok(())
    }

    pub fn next_translation_generation(&self) -> u64 {
        let _commit = self
            .translation_commit
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        self.translation_generation.fetch_add(1, Ordering::SeqCst) + 1
    }

    pub fn is_current_translation(&self, generation: u64) -> bool {
        self.translation_generation.load(Ordering::SeqCst) == generation
    }

    pub fn mark_target_capture_unavailable(&self) {
        self.target_capture_available.store(false, Ordering::SeqCst);
        if let Ok(mut enabled) = self.auto_translate_enabled.lock() {
            *enabled = false;
        }
    }

    pub fn mark_target_capture_available(&self) {
        self.target_capture_available.store(true, Ordering::SeqCst);
    }

    pub fn set_latest_gateway_target(
        &self,
        target: LatestGatewayTarget,
    ) -> Result<GatewayTestState, String> {
        let mut state = self
            .gateway_test_state
            .lock()
            .map_err(|_| "gateway state lock failed")?;
        state.latest_target = Some(target);
        *self
            .live_detail_state
            .lock()
            .map_err(|_| "detail state lock failed")? = LiveDetailRuntimeState::default();
        Ok(state.clone())
    }

    pub fn prepare_live_detail(
        &self,
        target: &LatestGatewayTarget,
        quick_request_id: &str,
    ) -> Result<bool, String> {
        let _commit = self
            .translation_commit
            .lock()
            .map_err(|_| "translation commit lock failed")?;
        if !self.is_current_translation(target.translation_generation) {
            return Ok(false);
        }
        let gateway = self
            .gateway_test_state
            .lock()
            .map_err(|_| "gateway state lock failed")?;
        let eligible = gateway.latest_target.as_ref() == Some(target)
            && gateway.request_id.as_deref() == Some(quick_request_id)
            && gateway.connection_state == GatewayConnectionState::Success
            && matches!(
                gateway.parsed_result,
                Some(GatewayParsedResult::Word { .. })
            );
        if !eligible {
            return Ok(false);
        }
        let mut detail = self
            .live_detail_state
            .lock()
            .map_err(|_| "detail state lock failed")?;
        *detail = LiveDetailRuntimeState {
            phase: LiveDetailPhase::Ready,
            target: Some(target.clone()),
            quick_request_id: Some(quick_request_id.into()),
            detail_request_id: None,
            result: None,
        };
        Ok(true)
    }

    pub fn claim_live_detail(
        &self,
        generation: u64,
        quick_request_id: &str,
    ) -> Result<Option<ClaimedLiveDetailRequest>, String> {
        let _commit = self
            .translation_commit
            .lock()
            .map_err(|_| "translation commit lock failed")?;
        if !self.is_auto_translate_enabled() || !self.is_current_translation(generation) {
            return Ok(None);
        }
        let gateway = self
            .gateway_test_state
            .lock()
            .map_err(|_| "gateway state lock failed")?;
        let Some(target) = gateway.latest_target.clone() else {
            return Ok(None);
        };
        let eligible = target.translation_generation == generation
            && target.request_type == RequestType::WordAnalysis
            && gateway.request_id.as_deref() == Some(quick_request_id)
            && gateway.connection_state == GatewayConnectionState::Success
            && matches!(
                gateway.parsed_result,
                Some(GatewayParsedResult::Word { .. })
            );
        if !eligible {
            return Ok(None);
        }
        drop(gateway);
        let mut detail = self
            .live_detail_state
            .lock()
            .map_err(|_| "detail state lock failed")?;
        if detail.phase != LiveDetailPhase::Ready
            || detail.target.as_ref() != Some(&target)
            || detail.quick_request_id.as_deref() != Some(quick_request_id)
        {
            return Ok(None);
        }
        let detail_request_id = self.next_detail_request_id();
        detail.phase = LiveDetailPhase::Loading;
        detail.detail_request_id = Some(detail_request_id.clone());
        detail.result = None;
        Ok(Some(ClaimedLiveDetailRequest {
            target,
            quick_request_id: quick_request_id.into(),
            detail_request_id,
        }))
    }

    pub fn claim_live_detail_retry(
        &self,
        generation: u64,
        failed_detail_request_id: &str,
    ) -> Result<Option<ClaimedLiveDetailRequest>, String> {
        let _commit = self
            .translation_commit
            .lock()
            .map_err(|_| "translation commit lock failed")?;
        if !self.is_auto_translate_enabled() || !self.is_current_translation(generation) {
            return Ok(None);
        }
        let gateway = self
            .gateway_test_state
            .lock()
            .map_err(|_| "gateway state lock failed")?;
        let Some(latest_target) = gateway.latest_target.as_ref() else {
            return Ok(None);
        };
        let mut detail = self
            .live_detail_state
            .lock()
            .map_err(|_| "detail state lock failed")?;
        if detail.phase != LiveDetailPhase::Error
            || detail.detail_request_id.as_deref() != Some(failed_detail_request_id)
            || detail
                .target
                .as_ref()
                .map(|target| target.translation_generation)
                != Some(generation)
            || detail.target.as_ref() != Some(latest_target)
            || gateway.request_id.as_deref() != detail.quick_request_id.as_deref()
            || gateway.connection_state != GatewayConnectionState::Success
            || !matches!(
                gateway.parsed_result,
                Some(GatewayParsedResult::Word { .. })
            )
        {
            return Ok(None);
        }
        let target = detail.target.clone().expect("validated detail target");
        let quick_request_id = detail
            .quick_request_id
            .clone()
            .expect("validated quick request id");
        let detail_request_id = self.next_detail_request_id();
        detail.phase = LiveDetailPhase::Loading;
        detail.detail_request_id = Some(detail_request_id.clone());
        detail.result = None;
        Ok(Some(ClaimedLiveDetailRequest {
            target,
            quick_request_id,
            detail_request_id,
        }))
    }

    pub fn complete_live_detail(
        &self,
        generation: u64,
        quick_request_id: &str,
        detail_request_id: &str,
        outcome: Result<WordDetailResult, ()>,
    ) -> Result<Option<LiveDetailPopupState>, String> {
        let _commit = self
            .translation_commit
            .lock()
            .map_err(|_| "translation commit lock failed")?;
        if !self.is_current_translation(generation) {
            return Ok(None);
        }
        let gateway = self
            .gateway_test_state
            .lock()
            .map_err(|_| "gateway state lock failed")?;
        if gateway.request_id.as_deref() != Some(quick_request_id)
            || gateway.connection_state != GatewayConnectionState::Success
            || !matches!(
                gateway.parsed_result,
                Some(GatewayParsedResult::Word { .. })
            )
        {
            return Ok(None);
        }
        let mut detail = self
            .live_detail_state
            .lock()
            .map_err(|_| "detail state lock failed")?;
        if detail.phase != LiveDetailPhase::Loading
            || detail.detail_request_id.as_deref() != Some(detail_request_id)
            || detail.quick_request_id.as_deref() != Some(quick_request_id)
        {
            return Ok(None);
        }
        let Some(target) = detail.target.as_ref() else {
            return Ok(None);
        };
        if target.translation_generation != generation {
            return Ok(None);
        }
        let quick_request_id = detail.quick_request_id.clone().unwrap_or_default();
        let capture_generation = target.capture_generation;
        let payload = match outcome {
            Ok(result) => {
                detail.phase = LiveDetailPhase::Success;
                detail.result = Some(result.clone());
                LiveDetailPopupState::Success {
                    generation,
                    capture_generation,
                    quick_request_id,
                    detail_request_id: detail_request_id.into(),
                    result,
                }
            }
            Err(()) => {
                detail.phase = LiveDetailPhase::Error;
                detail.result = None;
                LiveDetailPopupState::Error {
                    generation,
                    capture_generation,
                    quick_request_id,
                    detail_request_id: detail_request_id.into(),
                    message: "详细解释加载失败，请重试".into(),
                }
            }
        };
        Ok(Some(payload))
    }

    pub fn live_detail_loading_payload(
        &self,
        claim: &ClaimedLiveDetailRequest,
    ) -> LiveDetailPopupState {
        LiveDetailPopupState::Loading {
            generation: claim.target.translation_generation,
            capture_generation: claim.target.capture_generation,
            quick_request_id: claim.quick_request_id.clone(),
            detail_request_id: claim.detail_request_id.clone(),
        }
    }

    pub fn is_current_live_detail(
        &self,
        generation: u64,
        quick_request_id: &str,
        detail_request_id: &str,
    ) -> bool {
        self.is_current_translation(generation)
            && self
                .gateway_test_state
                .lock()
                .map(|gateway| {
                    gateway.request_id.as_deref() == Some(quick_request_id)
                        && gateway.connection_state == GatewayConnectionState::Success
                        && matches!(
                            gateway.parsed_result,
                            Some(GatewayParsedResult::Word { .. })
                        )
                })
                .unwrap_or(false)
            && self
                .live_detail_state
                .lock()
                .map(|detail| {
                    detail.detail_request_id.as_deref() == Some(detail_request_id)
                        && detail.quick_request_id.as_deref() == Some(quick_request_id)
                        && matches!(
                            detail.phase,
                            LiveDetailPhase::Loading
                                | LiveDetailPhase::Success
                                | LiveDetailPhase::Error
                        )
                })
                .unwrap_or(false)
    }

    pub fn live_detail_phase(&self) -> LiveDetailPhase {
        self.live_detail_state
            .lock()
            .map(|detail| detail.phase)
            .unwrap_or(LiveDetailPhase::Unavailable)
    }

    pub fn current_vocabulary_candidate(
        &self,
        generation: u64,
        quick_request_id: &str,
    ) -> Result<Option<VocabularyCandidate>, String> {
        let _commit = self
            .translation_commit
            .lock()
            .map_err(|_| "translation commit lock failed")?;
        if !self.is_current_translation(generation) {
            return Ok(None);
        }
        let gateway = self
            .gateway_test_state
            .lock()
            .map_err(|_| "gateway state lock failed")?;
        let Some(target) = gateway.latest_target.as_ref() else {
            return Ok(None);
        };
        if target.translation_generation != generation
            || target.request_type != RequestType::WordAnalysis
            || gateway.request_id.as_deref() != Some(quick_request_id)
            || gateway.connection_state != GatewayConnectionState::Success
        {
            return Ok(None);
        }
        let Some(GatewayParsedResult::Word {
            word,
            lemma,
            phonetic,
            part_of_speech,
            meaning,
            ..
        }) = gateway.parsed_result.as_ref()
        else {
            return Ok(None);
        };

        let detail = self
            .live_detail_state
            .lock()
            .map_err(|_| "detail state lock failed")?;
        let saved_detail = if detail.phase == LiveDetailPhase::Success
            && detail.target.as_ref() == Some(target)
            && detail.quick_request_id.as_deref() == Some(quick_request_id)
        {
            detail.result.as_ref().map(|result| VocabularyDetail {
                meaning_in_sentence: result.meaning_in_sentence.clone(),
                comparison: result
                    .comparison
                    .as_ref()
                    .map(|comparison| VocabularyComparison {
                        word: comparison.word.clone(),
                        difference: comparison.difference.clone(),
                    }),
            })
        } else {
            None
        };

        Ok(Some(VocabularyCandidate {
            word: word.clone(),
            lemma: lemma.clone(),
            phonetic: phonetic.clone(),
            part_of_speech: part_of_speech.clone(),
            meaning: meaning.clone(),
            context: target.context.context_sentence.clone(),
            source: VocabularySource {
                app: target.source_app.clone(),
                title: target.page_title.clone(),
                url: None,
            },
            detail: saved_detail,
        }))
    }

    fn next_detail_request_id(&self) -> String {
        let sequence = self.gateway_request_sequence.fetch_add(1, Ordering::SeqCst) + 1;
        let unix_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis();
        format!("desktop-{unix_ms}-{sequence}-detail")
    }

    pub fn gateway_test_state(&self) -> Result<GatewayTestState, String> {
        self.gateway_test_state
            .lock()
            .map(|state| state.clone())
            .map_err(|_| "gateway state lock failed".into())
    }

    pub fn update_gateway_test_state(
        &self,
        update: impl FnOnce(&mut GatewayTestState),
    ) -> Result<GatewayTestState, String> {
        let mut state = self
            .gateway_test_state
            .lock()
            .map_err(|_| "gateway state lock failed")?;
        update(&mut state);
        Ok(state.clone())
    }

    pub fn update_gateway_test_state_for_request(
        &self,
        request_id: &str,
        update: impl FnOnce(&mut GatewayTestState),
    ) -> Result<Option<GatewayTestState>, String> {
        let mut state = self
            .gateway_test_state
            .lock()
            .map_err(|_| "gateway state lock failed")?;
        if state.request_id.as_deref() != Some(request_id) {
            return Ok(None);
        }
        update(&mut state);
        Ok(Some(state.clone()))
    }

    pub fn update_gateway_test_state_for_live_request(
        &self,
        request_id: &str,
        translation_generation: u64,
        update: impl FnOnce(&mut GatewayTestState),
    ) -> Result<Option<GatewayTestState>, String> {
        let _commit = self
            .translation_commit
            .lock()
            .map_err(|_| "translation commit lock failed")?;
        let mut state = self
            .gateway_test_state
            .lock()
            .map_err(|_| "gateway state lock failed")?;
        let latest_generation = state
            .latest_target
            .as_ref()
            .map(|target| target.translation_generation);
        if state.request_id.as_deref() != Some(request_id)
            || latest_generation != Some(translation_generation)
            || !self.is_current_translation(translation_generation)
        {
            return Ok(None);
        }
        update(&mut state);
        Ok(Some(state.clone()))
    }

    pub fn claim_new_live_gateway_request(
        &self,
        target: &LatestGatewayTarget,
    ) -> Result<Option<ClaimedLiveGatewayRequest>, String> {
        let _commit = self
            .translation_commit
            .lock()
            .map_err(|_| "translation commit lock failed")?;
        if !self.is_auto_translate_enabled()
            || !self.is_current_translation(target.translation_generation)
        {
            return Ok(None);
        }
        let mut state = self
            .gateway_test_state
            .lock()
            .map_err(|_| "gateway state lock failed")?;
        if state.latest_target.as_ref() != Some(target) {
            return Ok(None);
        }
        Ok(Some(self.claim_live_gateway_request_locked(
            &mut state,
            target.clone(),
        )))
    }

    pub fn claim_live_gateway_retry(
        &self,
        translation_generation: u64,
        request_id: &str,
    ) -> Result<Option<ClaimedLiveGatewayRequest>, String> {
        let _commit = self
            .translation_commit
            .lock()
            .map_err(|_| "translation commit lock failed")?;
        if !self.is_auto_translate_enabled() || !self.is_current_translation(translation_generation)
        {
            return Ok(None);
        }
        let mut state = self
            .gateway_test_state
            .lock()
            .map_err(|_| "gateway state lock failed")?;
        let Some(target) = state.latest_target.clone() else {
            return Ok(None);
        };
        if target.translation_generation != translation_generation
            || state.request_id.as_deref() != Some(request_id)
            || state.connection_state != GatewayConnectionState::Failed
            || state.live_error_kind != Some(LivePopupErrorKind::Retryable)
        {
            return Ok(None);
        }
        Ok(Some(
            self.claim_live_gateway_request_locked(&mut state, target),
        ))
    }

    fn claim_live_gateway_request_locked(
        &self,
        state: &mut GatewayTestState,
        target: LatestGatewayTarget,
    ) -> ClaimedLiveGatewayRequest {
        let request_id = self.next_gateway_request_id();
        state.connection_state = GatewayConnectionState::Sending;
        state.request_id = Some(request_id.clone());
        state.request_type = Some(target.request_type);
        state.request_target_length = Some(target.target_length());
        state.http_status = None;
        state.latency_ms = None;
        state.parse_status = GatewayParseStatus::NotAttempted;
        state.parsed_result = None;
        state.raw_preview = None;
        state.error_code = None;
        state.gateway_error_code = None;
        state.error_message = None;
        state.live_error_kind = None;
        ClaimedLiveGatewayRequest {
            target,
            request_id,
            gateway_state: state.clone(),
        }
    }

    pub fn next_gateway_request_id(&self) -> String {
        let sequence = self.gateway_request_sequence.fetch_add(1, Ordering::SeqCst) + 1;
        let unix_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis();
        format!("desktop-{unix_ms}-{sequence}")
    }

    pub fn target_diagnostics(&self) -> Result<TargetDiagnostics, String> {
        self.target_diagnostics
            .lock()
            .map(|diagnostic| diagnostic.clone())
            .map_err(|_| "target capture diagnostic lock failed".into())
    }

    pub fn update_system_event(
        &self,
        update: impl FnOnce(&mut SystemEventDiagnostic),
    ) -> Result<TargetDiagnostics, String> {
        let mut diagnostic = self
            .target_diagnostics
            .lock()
            .map_err(|_| "target capture diagnostic lock failed")?;
        update(&mut diagnostic.system_event);
        Ok(diagnostic.clone())
    }

    pub fn begin_external_capture(
        &self,
        candidate_type: CandidateType,
        capture_generation: u64,
        foreground_title: String,
        foreground_pid: u32,
    ) -> Result<TargetDiagnostics, String> {
        let mut diagnostics = self
            .target_diagnostics
            .lock()
            .map_err(|_| "target capture diagnostic lock failed")?;
        diagnostics.external_capture = Some(ExternalCaptureDiagnostic::new(
            candidate_type,
            capture_generation,
            foreground_title,
            foreground_pid,
            self.popup_listener_ready.load(Ordering::SeqCst),
        ));
        Ok(diagnostics.clone())
    }

    pub fn update_external_capture(
        &self,
        capture_generation: u64,
        update: impl FnOnce(&mut ExternalCaptureDiagnostic),
    ) -> Result<Option<TargetDiagnostics>, String> {
        let mut diagnostics = self
            .target_diagnostics
            .lock()
            .map_err(|_| "target capture diagnostic lock failed")?;
        let Some(external) = diagnostics.external_capture.as_mut() else {
            return Ok(None);
        };
        if external.capture_generation != capture_generation {
            return Ok(None);
        }
        update(external);
        Ok(Some(diagnostics.clone()))
    }

    pub fn popup_listener_ready(&self) -> bool {
        self.popup_listener_ready.load(Ordering::SeqCst)
    }

    pub fn set_popup_listener_ready(&self, ready: bool) -> Result<TargetDiagnostics, String> {
        self.popup_listener_ready.store(ready, Ordering::SeqCst);
        let mut diagnostics = self
            .target_diagnostics
            .lock()
            .map_err(|_| "target capture diagnostic lock failed")?;
        if let Some(external) = diagnostics.external_capture.as_mut() {
            external.popup_listener_state = if ready {
                PopupListenerState::Ready
            } else {
                PopupListenerState::NotReady
            };
        }
        Ok(diagnostics.clone())
    }

    pub fn acknowledge_target_diagnostic(
        &self,
        capture_generation: u64,
        translation_generation: u64,
    ) -> Result<(bool, Option<TargetDiagnostics>), String> {
        let mut diagnostics = self
            .target_diagnostics
            .lock()
            .map_err(|_| "target capture diagnostic lock failed")?;
        let Some(external) = diagnostics.external_capture.as_mut() else {
            return Ok((false, None));
        };
        if external.capture_generation != capture_generation
            || external.translation_generation != translation_generation
            || external.popup_ack_state != PopupAckState::No
            || !matches!(
                external.popup_emit_state,
                PopupAttemptState::Pending | PopupAttemptState::Success
            )
        {
            return Ok((false, None));
        }
        external.popup_ack_state = PopupAckState::Yes;
        external.stage = DiagnosticStage::PopupAcknowledged;
        Ok((true, Some(diagnostics.clone())))
    }

    pub fn next_status_generation(&self) -> u64 {
        self.status_generation.fetch_add(1, Ordering::SeqCst) + 1
    }

    pub fn is_current_status(&self, generation: u64) -> bool {
        self.status_generation.load(Ordering::SeqCst) == generation
    }

    pub fn begin_exit(&self) {
        self.exiting.store(true, Ordering::SeqCst);
    }

    pub fn is_exiting(&self) -> bool {
        self.exiting.load(Ordering::SeqCst)
    }

    pub fn set_settings_repository(&self, repository: SettingsRepository) -> Result<(), String> {
        *self.settings.lock().map_err(|_| "settings lock failed")? = Some(repository);
        Ok(())
    }

    pub fn settings_repository(&self) -> Result<SettingsRepository, String> {
        self.settings
            .lock()
            .map_err(|_| "settings lock failed")?
            .clone()
            .ok_or_else(|| "settings repository is not initialized".into())
    }

    pub fn set_vocabulary_repository(
        &self,
        repository: VocabularyRepository,
    ) -> Result<(), String> {
        *self
            .vocabulary
            .lock()
            .map_err(|_| "vocabulary repository lock failed")? = Some(repository);
        Ok(())
    }

    pub fn with_vocabulary_repository<T>(
        &self,
        operation: impl FnOnce(&VocabularyRepository) -> Result<T, VocabularyError>,
    ) -> Result<T, String> {
        let repository = self
            .vocabulary
            .lock()
            .map_err(|_| "vocabulary repository lock failed")?;
        let repository = repository
            .as_ref()
            .ok_or_else(|| "vocabulary repository is not initialized".to_owned())?;
        operation(repository).map_err(|error| error.to_string())
    }

    pub fn set_auto_menu_item(&self, item: CheckMenuItem<Wry>) -> Result<(), String> {
        *self
            .auto_menu_item
            .lock()
            .map_err(|_| "tray menu lock failed")? = Some(item);
        Ok(())
    }

    pub fn update_auto_menu(&self, enabled: bool) {
        if let Ok(guard) = self.auto_menu_item.lock() {
            if let Some(item) = guard.as_ref() {
                let _ = item.set_checked(enabled);
                let _ = item.set_text(if enabled {
                    "暂停自动翻译"
                } else {
                    "恢复自动翻译"
                });
            }
        }
    }
}

pub fn should_toggle_for_shortcut(pressed: bool) -> bool {
    pressed
}
