pub mod app_state;
pub mod host_adapter;
pub mod gateway;
pub mod dictionary;
pub mod selection;
pub mod selection_bridge;
pub mod popup_position;
pub mod settings;
mod tray;
pub mod vocabulary;
pub mod windows;

use app_state::{
    should_toggle_for_shortcut, AppState, ClaimedLiveDetailRequest, ClaimedLiveGatewayRequest,
    ExternalCaptureDiagnostic, GatewayConnectionState, GatewayParseStatus, GatewayTestState,
    LatestGatewayTarget, LiveDetailPopupState, LivePopupErrorKind, LivePopupTranslationState,
    MainSection, MockScenario, MockTranslationState, RuntimeState, StatusToast,
    SystemEventDiagnostic, TargetDiagnostics, WordDetailResult,
};
use gateway::{
    build_detail_language_request, build_language_request, GatewayClient, GatewayFailure,
    LanguageRequest, ReqwestGatewayTransport,
};
use serde::Serialize;
use settings::{SettingsRepository, SettingsView, TranslationMode};
use std::{
    thread,
    time::{Duration, Instant},
};
use tauri::{Emitter, Manager, State, WindowEvent};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};
use tauri_plugin_opener::OpenerExt;
use vocabulary::{
    validate_source_url, VocabularyExportResult, VocabularyImportResult, VocabularyListResult,
    VocabularyRepository, VocabularySaveResult,
};

const AUTO_TRANSLATE_CHANGED: &str = "auto-translate-changed";
const TRANSLATION_STATE_CHANGED: &str = "translation-state-changed";
const STATUS_TOAST: &str = "status-toast";
const MAIN_SECTION_CHANGED: &str = "main-section-changed";
const TARGET_CAPTURE_DIAGNOSTIC: &str = "target-capture-diagnostic";
const GATEWAY_TARGET_CHANGED: &str = "gateway-target-changed";
const POPUP_TRANSLATION_STATE: &str = "popup-translation-state";
const POPUP_DETAIL_STATE: &str = "popup-detail-state";
const VOCABULARY_CHANGED: &str = "vocabulary-changed";

pub(crate) fn publish_latest_gateway_target(
    app: &tauri::AppHandle,
    target: LatestGatewayTarget,
) -> Result<GatewayTestState, String> {
    let state = app.state::<AppState>().set_latest_gateway_target(target)?;
    app.emit_to("main", GATEWAY_TARGET_CHANGED, state.clone())
        .map_err(|error| error.to_string())?;
    Ok(state)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum GatewayPresentation {
    MainOnly,
    LivePopupNewTarget,
    LivePopupRetry,
}

impl GatewayPresentation {
    fn is_live(self) -> bool {
        self != Self::MainOnly
    }

    fn loading_may_show(self) -> bool {
        self == Self::LivePopupNewTarget
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct LivePopupCommitGate {
    pub generation_current: bool,
    pub request_current: bool,
    pub auto_translate_enabled: bool,
    pub popup_visible: bool,
}

pub(crate) fn should_commit_live_popup(gate: LivePopupCommitGate) -> bool {
    gate.generation_current
        && gate.request_current
        && gate.auto_translate_enabled
        && gate.popup_visible
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct DetailPopupCommitGate {
    pub generation_current: bool,
    pub quick_request_current: bool,
    pub detail_request_current: bool,
    pub auto_translate_enabled: bool,
    pub popup_visible: bool,
    pub listener_ready: bool,
}

pub(crate) fn should_emit_live_detail(gate: DetailPopupCommitGate) -> bool {
    gate.generation_current
        && gate.quick_request_current
        && gate.detail_request_current
        && gate.auto_translate_enabled
        && gate.popup_visible
        && gate.listener_ready
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct LiveLoadingGate {
    pub generation_current: bool,
    pub request_current: bool,
    pub auto_translate_enabled: bool,
}

pub(crate) fn should_emit_live_loading(gate: LiveLoadingGate) -> bool {
    gate.generation_current && gate.request_current && gate.auto_translate_enabled
}

fn emit_live_loading(
    app: &tauri::AppHandle,
    target: &LatestGatewayTarget,
    request_id: &str,
    payload: &LivePopupTranslationState,
    may_show: bool,
) -> Result<(), String> {
    let state = app.state::<AppState>();
    // Tauri getters may synchronously wait for the UI thread. Never hold commit across them.
    let visible = app.get_webview_window("popup")
        .is_some_and(|popup| popup.is_visible().unwrap_or(false));
    let position = if may_show {
        app.get_webview_window("popup").map(|popup| popup_position::prepare(&popup, target))
    } else { None };
    state.with_current_quick(target, || emit_live_loading_current(app, target, request_id, payload, may_show, visible, position))
        .unwrap_or(Ok(()))
}

fn emit_live_loading_current(app: &tauri::AppHandle, target: &LatestGatewayTarget,
    request_id: &str, payload: &LivePopupTranslationState, may_show: bool, visible: bool,
    position: Option<popup_position::PreparedPosition>) -> Result<(), String> {
    let state = app.state::<AppState>();
    let gate = || -> Result<LiveLoadingGate, String> {
        Ok(LiveLoadingGate {
            generation_current: state.is_current_quick(target),
            request_current: state.gateway_test_state()?.request_id.as_deref() == Some(request_id),
            auto_translate_enabled: state.is_auto_translate_enabled(),
        })
    };
    if !should_emit_live_loading(gate()?) || !state.popup_listener_ready() {
        return Ok(());
    }
    let popup = app
        .get_webview_window("popup")
        .ok_or_else(|| "popup window is unavailable".to_owned())?;
    if may_show {
        if let Some(position) = position {
            let diagnostic = popup_position::apply(&popup, position);
            let _ = publish_external_capture_diagnostic(app, target.capture_generation, |d| {
                d.popup_position = Some(diagnostic);
            });
        } else {
            let _ = popup.center();
        }
        popup.show().map_err(|error| error.to_string())?;
    } else if !visible {
        return Ok(());
    }
    let after_show = gate()?;
    if !after_show.auto_translate_enabled {
        let _ = popup.hide();
        return Ok(());
    }
    if !should_emit_live_loading(after_show) || !state.popup_listener_ready() {
        return Ok(());
    }
    app.emit_to("popup", POPUP_TRANSLATION_STATE, payload)
        .map_err(|error| error.to_string())
}

fn emit_live_result_if_current(
    app: &tauri::AppHandle,
    target: &LatestGatewayTarget,
    request_id: &str,
    payload: &LivePopupTranslationState,
) -> Result<bool, String> {
    let state = app.state::<AppState>();
    let visible = app.get_webview_window("popup")
        .is_some_and(|popup| popup.is_visible().unwrap_or(false));
    state.with_current_quick(target, || emit_live_result_current(app, target, request_id, payload, visible))
        .unwrap_or(Ok(false))
}

fn emit_live_result_current(app: &tauri::AppHandle, target: &LatestGatewayTarget,
    request_id: &str, payload: &LivePopupTranslationState, visible: bool) -> Result<bool, String> {
    let state = app.state::<AppState>();
    let request_current = state.gateway_test_state()?.request_id.as_deref() == Some(request_id);
    let gate = LivePopupCommitGate {
        generation_current: state.is_current_quick(target),
        request_current,
        auto_translate_enabled: state.is_auto_translate_enabled(),
        popup_visible: visible,
    };
    if !should_commit_live_popup(gate) || !state.popup_listener_ready() {
        return Ok(false);
    }
    app.emit_to("popup", POPUP_TRANSLATION_STATE, payload)
        .map_err(|error| error.to_string())?;
    Ok(true)
}

fn emit_detail_if_current(
    app: &tauri::AppHandle,
    generation: u64,
    quick_request_id: &str,
    detail_request_id: &str,
    payload: &LiveDetailPopupState,
) -> Result<bool, String> {
    let state = app.state::<AppState>();
    let Some(popup) = app.get_webview_window("popup") else {
        return Ok(false);
    };
    let gate = || DetailPopupCommitGate {
        generation_current: state.is_current_translation(generation),
        quick_request_current: state
            .gateway_test_state()
            .map(|gateway| gateway.request_id.as_deref() == Some(quick_request_id))
            .unwrap_or(false),
        detail_request_current: state.is_current_live_detail(
            generation,
            quick_request_id,
            detail_request_id,
        ),
        auto_translate_enabled: state.is_auto_translate_enabled(),
        popup_visible: popup.is_visible().unwrap_or(false),
        listener_ready: state.popup_listener_ready(),
    };
    if !should_emit_live_detail(gate()) {
        return Ok(false);
    }
    // Visibility is queried above, outside the commit lock. Never reopen/reposition here.
    state.with_current_live_detail(generation, quick_request_id, detail_request_id, || {
        app.emit_to("popup", POPUP_DETAIL_STATE, payload)
            .map(|_| true)
            .map_err(|error| error.to_string())
    }).unwrap_or(Ok(false))
}

fn local_gateway_failure(code: &str, message: &str) -> GatewayFailure {
    GatewayFailure {
        error_code: code.into(),
        gateway_error_code: None,
        message: message.into(),
        http_status: None,
        requires_configuration: code == "access_not_configured",
        parse_failed: false,
        raw_preview: None,
    }
}

pub(crate) fn classify_live_popup_failure(failure: &GatewayFailure) -> LivePopupErrorKind {
    if failure.requires_configuration
        || failure.error_code == "access_not_configured"
        || failure.error_code == "invalid_access_token"
        || matches!(failure.http_status, Some(401 | 403))
    {
        LivePopupErrorKind::Configuration
    } else if failure.error_code == "http_4xx" {
        LivePopupErrorKind::Terminal
    } else {
        LivePopupErrorKind::Retryable
    }
}

async fn perform_gateway_request(
    token: String,
    request: LanguageRequest,
    observe_parse_ms: impl FnOnce(u64) + Send + 'static,
) -> Result<(u16, app_state::GatewayParsedResult), GatewayFailure> {
    tauri::async_runtime::spawn_blocking(move || {
        let transport = ReqwestGatewayTransport::new()?;
        GatewayClient::new(transport).send_language_observed(&token, &request, observe_parse_ms)
    })
    .await
    .map_err(|_| local_gateway_failure("network_error", "Gateway 请求任务失败"))?
}

async fn perform_gateway_detail_request(
    token: String,
    request: LanguageRequest,
) -> Result<(u16, WordDetailResult), GatewayFailure> {
    tauri::async_runtime::spawn_blocking(move || {
        let transport = ReqwestGatewayTransport::new()?;
        GatewayClient::new(transport).send_word_detail(&token, &request)
    })
    .await
    .map_err(|_| local_gateway_failure("network_error", "Gateway Detail 请求任务失败"))?
}

async fn run_claimed_live_detail(
    app: tauri::AppHandle,
    claim: ClaimedLiveDetailRequest,
) -> Result<(), String> {
    let state = app.state::<AppState>();
    let loading = state.live_detail_loading_payload(&claim);
    let _ = emit_detail_if_current(
        &app,
        claim.target.translation_generation,
        &claim.quick_request_id,
        &claim.detail_request_id,
        &loading,
    );

    let request = build_detail_language_request(&claim.target, claim.detail_request_id.clone());
    let settings = state
        .settings_repository()
        .and_then(|repository| repository.load().map_err(|error| error.to_string()));
    let outcome = match (request, settings) {
        (Err(failure), _) => Err(failure),
        (_, Err(_)) => Err(local_gateway_failure(
            "settings_unavailable",
            "无法读取 Gateway 设置",
        )),
        (Ok(_), Ok(settings)) if settings.gateway_access_token.is_empty() => Err(
            local_gateway_failure("access_not_configured", "请先验证并保存访问码"),
        ),
        (Ok(request), Ok(settings)) => {
            if !state.is_current_live_detail(
                claim.target.translation_generation,
                &claim.quick_request_id,
                &claim.detail_request_id,
            ) {
                return Ok(());
            }
            perform_gateway_detail_request(settings.gateway_access_token, request).await
        }
    };
    let payload = state.complete_live_detail(
        claim.target.translation_generation,
        &claim.quick_request_id,
        &claim.detail_request_id,
        outcome.map(|(_, result)| result).map_err(|_| ()),
    )?;
    if let Some(payload) = payload {
        let _ = emit_detail_if_current(
            &app,
            claim.target.translation_generation,
            &claim.quick_request_id,
            &claim.detail_request_id,
            &payload,
        );
    }
    Ok(())
}

async fn run_gateway_translation(
    app: tauri::AppHandle,
    target: LatestGatewayTarget,
    presentation: GatewayPresentation,
) -> Result<GatewayTestState, String> {
    let state = app.state::<AppState>();
    let claim = if presentation == GatewayPresentation::MainOnly {
        if target.binding.is_some() && !state.is_current_quick(&target) {
            return Err("stale_snapshot".into());
        }
        let request_id = state.next_gateway_request_id();
        let sending = state.update_gateway_test_state(|gateway| {
            gateway.connection_state = GatewayConnectionState::Sending;
            gateway.request_id = Some(request_id.clone());
            gateway.request_type = Some(target.request_type);
            gateway.request_target_length = Some(target.target_length());
            gateway.http_status = None;
            gateway.latency_ms = None;
            gateway.parse_status = GatewayParseStatus::NotAttempted;
            gateway.parsed_result = None;
            gateway.raw_preview = None;
            gateway.error_code = None;
            gateway.gateway_error_code = None;
            gateway.error_message = None;
            gateway.live_error_kind = None;
        })?;
        ClaimedLiveGatewayRequest {
            target,
            request_id,
            gateway_state: sending,
        }
    } else {
        let Some(claim) = state.claim_new_live_gateway_request(&target)? else {
            return state.gateway_test_state();
        };
        claim
    };
    run_claimed_gateway_translation(app, claim, presentation).await
}

async fn run_claimed_gateway_translation(
    app: tauri::AppHandle,
    claim: ClaimedLiveGatewayRequest,
    presentation: GatewayPresentation,
) -> Result<GatewayTestState, String> {
    let state = app.state::<AppState>();
    let ClaimedLiveGatewayRequest {
        target,
        request_id,
        gateway_state: sending,
    } = claim;
    if presentation.is_live() && !state.is_current_quick(&target) { return state.gateway_test_state(); }
    let _ = publish_external_capture_diagnostic(&app, target.capture_generation, |d| {
        d.quick_state = "loading".into();
        d.quick_reason.clear();
        if let Some(binding) = &target.binding {
            d.quick_timing_ms.insert("snapshotToQuickBegin".into(), binding.ready_at.elapsed().as_millis() as u64);
        }
    });
    let _ = app.emit_to("main", GATEWAY_TARGET_CHANGED, sending);

    if presentation.is_live() {
        let loading = LivePopupTranslationState::loading(&target, request_id.clone());
        let _ = emit_live_loading(
            &app,
            &target,
            &request_id,
            &loading,
            presentation.loading_may_show(),
        );
    }

    let dictionary = app.try_state::<std::sync::Arc<dictionary::DictionaryService>>()
        .map(|service| service.inner().clone());
    let local = if presentation.is_live() && target.request_type == app_state::RequestType::WordAnalysis {
        if let Some(service) = dictionary.clone() {
            let surface = target.target.clone();
            tauri::async_runtime::spawn_blocking(move || service.resolve(&surface)).await.ok()
        } else { None }
    } else { None };
    if presentation.is_live() && !state.is_current_quick(&target) { return state.gateway_test_state(); }
    let local_hit = local.as_ref().is_some_and(|r| r.entry.is_some());
    if let Some(resolution) = &local {
        let _ = publish_external_capture_diagnostic(&app, target.capture_generation, |d| {
            d.local_dictionary = Some(resolution.diagnostic.clone());
        });
    }
    let started = Instant::now();
    let outcome = if let Some(resolution) = local.as_ref().filter(|r| r.entry.is_some()) {
        Ok((None, resolution.entry.as_ref().unwrap().display(&target.target,
            &resolution.diagnostic.quick_source, &resolution.diagnostic.dictionary_version)))
    } else {
    let request = build_language_request(&target, request_id.clone());
    let settings = state
        .settings_repository()
        .and_then(|repository| repository.load().map_err(|error| error.to_string()));
    let outcome = match (request, settings) {
        (Err(failure), _) => Err(failure),
        (_, Err(_)) => Err(local_gateway_failure(
            "settings_unavailable",
            "无法读取 Gateway 设置",
        )),
        (Ok(_), Ok(settings)) if settings.gateway_access_token.is_empty() => Err(
            local_gateway_failure("access_not_configured", "请先验证并保存访问码"),
        ),
        (Ok(request), Ok(settings)) => {
            let parse_app = app.clone();
            let capture_generation = target.capture_generation;
            perform_gateway_request(settings.gateway_access_token, request, move |ms| {
                let _ = publish_external_capture_diagnostic(&parse_app, capture_generation, |d| {
                    d.quick_timing_ms.insert("quickParseData".into(), ms);
                });
            }).await
        }
    };
    outcome.map(|(status, display)| (Some(status), display))
    };
    let latency_ms = if local_hit { local.as_ref().unwrap().diagnostic.lookup_latency_us / 1000 }
                     else { started.elapsed().as_millis() as u64 };
    if !local_hit && presentation.is_live() {
        if let (Some(service), Ok((_, display))) = (dictionary, &outcome) {
            let surface = target.target.clone();
            let display = display.clone();
            let profile = format!("{:?}", target.translation_mode);
            let cached = tauri::async_runtime::spawn_blocking(move || service.cache_network_result(&surface, &display, &profile)).await;
            if !matches!(cached, Ok(Ok(()))) {
                let _ = publish_external_capture_diagnostic(&app, target.capture_generation, |d| {
                    if let Some(local) = &mut d.local_dictionary {local.errors.push("cache_write_failed".into());}
                });
            }
        }
    }

    let apply_outcome = |gateway: &mut GatewayTestState| match &outcome {
        Ok((http_status, parsed)) => {
            dictionary::apply_quick_success(gateway, parsed, *http_status, latency_ms);
        }
        Err(failure) => {
            gateway.connection_state = GatewayConnectionState::Failed;
            gateway.http_status = failure.http_status;
            gateway.latency_ms = Some(latency_ms);
            gateway.parse_status = if failure.parse_failed {
                GatewayParseStatus::Failed
            } else {
                GatewayParseStatus::NotAttempted
            };
            gateway.parsed_result = None;
            gateway.raw_preview = failure.raw_preview.clone();
            gateway.error_code = Some(failure.error_code.clone());
            gateway.gateway_error_code = failure.gateway_error_code.clone();
            gateway.error_message = Some(failure.message.clone());
            gateway.live_error_kind = Some(classify_live_popup_failure(failure));
        }
    };
    let final_state = match presentation {
        GatewayPresentation::MainOnly => {
            state.update_gateway_test_state_for_request(&request_id, apply_outcome)?
        }
        GatewayPresentation::LivePopupNewTarget | GatewayPresentation::LivePopupRetry => state
            .update_gateway_test_state_for_live_request(
                &request_id,
                target.translation_generation,
                apply_outcome,
            )?,
    };

    let Some(final_state) = final_state else {
        return state.gateway_test_state();
    };
    let _ = publish_external_capture_diagnostic(&app, target.capture_generation, |d| {
        d.quick_state = if outcome.is_ok() { "success" } else { "error" }.into();
        d.quick_reason = outcome.as_ref().err().map(|e| e.error_code.clone()).unwrap_or_default();
        d.quick_timing_ms.insert(if local_hit { "localLookup" } else { "gatewayIncludingParse" }.into(), latency_ms);
    });
    if presentation.is_live()
        && matches!(
            &outcome,
            Ok((_, app_state::GatewayParsedResult::Word { .. }))
        )
    {
        let _ = state.prepare_live_detail(&target, &request_id);
    }
    if !presentation.is_live() || state.is_current_quick(&target) {
        let _ = app.emit_to("main", GATEWAY_TARGET_CHANGED, final_state.clone());
    }
    if presentation.is_live() {
        let payload = match &outcome {
            Ok((_, parsed)) => {
                LivePopupTranslationState::success(&target, request_id.clone(), parsed)
            }
            Err(failure) => LivePopupTranslationState::error(
                &target,
                request_id.clone(),
                classify_live_popup_failure(failure),
            ),
        };
        let publish_started = Instant::now();
        if emit_live_result_if_current(&app, &target, &request_id, &payload).unwrap_or(false) {
            let _ = publish_external_capture_diagnostic(&app, target.capture_generation, |d| {
                d.quick_timing_ms.insert("popupPublish".into(), publish_started.elapsed().as_millis() as u64);
                if let Some(binding) = &target.binding {
                    d.quick_timing_ms.insert("snapshotToPopupResult".into(), binding.ready_at.elapsed().as_millis() as u64);
                }
            });
        }
    }
    Ok(final_state)
}

#[cfg_attr(test, allow(dead_code))]
pub(crate) fn start_automatic_gateway_translation(
    app: &tauri::AppHandle,
    target: LatestGatewayTarget,
) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let _ = run_gateway_translation(app, target, GatewayPresentation::LivePopupNewTarget).await;
    });
}

#[allow(dead_code)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum PopupDispatchError {
    StaleGeneration,
    WindowMissing,
    ListenerNotReady,
    ShowFailed,
    EmitFailed,
}

#[allow(dead_code)]
impl PopupDispatchError {
    pub(crate) fn reason_code(self) -> &'static str {
        match self {
            Self::StaleGeneration => "stale_generation",
            Self::WindowMissing => "popup_window_missing",
            Self::ListenerNotReady => "popup_listener_not_ready",
            Self::ShowFailed => "popup_show_failed",
            Self::EmitFailed => "popup_emit_failed",
        }
    }
}

#[allow(dead_code)]
trait TargetPopupPort {
    fn listener_ready(&self) -> bool;
    fn window_exists(&self) -> bool;
    fn show_popup(&self) -> Result<(), PopupDispatchError>;
    fn emit_payload(&self, payload: &MockTranslationState) -> Result<(), PopupDispatchError>;
}

#[allow(dead_code)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum PopupDispatchProgress {
    WindowExists,
    WindowMissing,
    ListenerReady,
    ListenerNotReady,
    ShowPending,
    ShowSuccess,
    ShowFailed,
    EmitPending,
    EmitSuccess,
    EmitFailed,
}

#[allow(dead_code)]
fn dispatch_target_diagnostic<P, F, O>(
    port: &P,
    payload: &MockTranslationState,
    is_current: F,
    mut observe: O,
) -> Result<(), PopupDispatchError>
where
    P: TargetPopupPort,
    F: Fn() -> bool,
    O: FnMut(PopupDispatchProgress),
{
    if !port.window_exists() {
        observe(PopupDispatchProgress::WindowMissing);
        return Err(PopupDispatchError::WindowMissing);
    }
    observe(PopupDispatchProgress::WindowExists);
    if !port.listener_ready() {
        observe(PopupDispatchProgress::ListenerNotReady);
        return Err(PopupDispatchError::ListenerNotReady);
    }
    observe(PopupDispatchProgress::ListenerReady);
    if !is_current() {
        return Err(PopupDispatchError::StaleGeneration);
    }
    observe(PopupDispatchProgress::ShowPending);
    if let Err(error) = port.show_popup() {
        observe(PopupDispatchProgress::ShowFailed);
        return Err(error);
    }
    observe(PopupDispatchProgress::ShowSuccess);
    if !is_current() {
        return Err(PopupDispatchError::StaleGeneration);
    }
    observe(PopupDispatchProgress::EmitPending);
    if let Err(error) = port.emit_payload(payload) {
        observe(PopupDispatchProgress::EmitFailed);
        return Err(error);
    }
    observe(PopupDispatchProgress::EmitSuccess);
    Ok(())
}

pub(crate) fn publish_target_capture_diagnostic(
    app: &tauri::AppHandle,
    update: impl FnOnce(&mut SystemEventDiagnostic),
) -> Result<TargetDiagnostics, String> {
    let diagnostic = app.state::<AppState>().update_system_event(update)?;
    app.emit_to("main", TARGET_CAPTURE_DIAGNOSTIC, diagnostic.clone())
        .map_err(|error| error.to_string())?;
    Ok(diagnostic)
}

pub(crate) fn publish_external_capture_diagnostic(
    app: &tauri::AppHandle,
    capture_generation: u64,
    update: impl FnOnce(&mut ExternalCaptureDiagnostic),
) -> Result<Option<TargetDiagnostics>, String> {
    let diagnostic = app
        .state::<AppState>()
        .update_external_capture(capture_generation, update)?;
    if let Some(diagnostic) = diagnostic.as_ref() {
        app.emit_to("main", TARGET_CAPTURE_DIAGNOSTIC, diagnostic.clone())
            .map_err(|error| error.to_string())?;
    }
    Ok(diagnostic)
}

pub(crate) fn publish_new_external_capture(
    app: &tauri::AppHandle,
    candidate_type: app_state::CandidateType,
    capture_generation: u64,
    foreground_title: String,
    foreground_pid: u32,
) -> Result<TargetDiagnostics, String> {
    let diagnostic = app.state::<AppState>().begin_external_capture(
        candidate_type,
        capture_generation,
        foreground_title,
        foreground_pid,
    )?;
    // The candidate may be filtered without ever producing a new Quick payload.
    let _ = app.emit_to("popup", "popup-selection-invalidated", capture_generation);
    app.emit_to("main", TARGET_CAPTURE_DIAGNOSTIC, diagnostic.clone())
        .map_err(|error| error.to_string())?;
    Ok(diagnostic)
}

pub(crate) fn present_main(app: &tauri::AppHandle, section: MainSection) -> Result<(), String> {
    app.state::<AppState>().set_main_section(section)?;
    if let Some(main) = app.get_webview_window("main") {
        main.show().map_err(|error| error.to_string())?;
        let _ = main.unminimize();
        main.set_focus().map_err(|error| error.to_string())?;
        app.emit_to("main", MAIN_SECTION_CHANGED, section)
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn publish_auto_translate(
    app: &tauri::AppHandle,
    runtime: RuntimeState,
) -> Result<RuntimeState, String> {
    let state = app.state::<AppState>();
    state.update_auto_menu(runtime.auto_translate_enabled);
    if windows::should_hide_popup(runtime.auto_translate_enabled) {
        if let Some(popup) = app.get_webview_window("popup") {
            let _ = popup.hide();
        }
    }
    app.emit(AUTO_TRANSLATE_CHANGED, runtime.clone())
        .map_err(|error| error.to_string())?;

    let generation = state.next_status_generation();
    let toast = StatusToast {
        enabled: runtime.auto_translate_enabled,
        message: if runtime.auto_translate_enabled {
            "自动翻译已恢复".into()
        } else {
            "自动翻译已暂停".into()
        },
        generation,
    };
    app.emit_to("status", STATUS_TOAST, toast)
        .map_err(|error| error.to_string())?;
    if let Some(status) = app.get_webview_window("status") {
        let _ = status.center();
        status.show().map_err(|error| error.to_string())?;
    }

    let app_handle = app.clone();
    thread::spawn(move || {
        thread::sleep(Duration::from_millis(1200));
        if app_handle.state::<AppState>().is_current_status(generation) {
            if let Some(status) = app_handle.get_webview_window("status") {
                let _ = status.hide();
            }
        }
    });
    Ok(runtime)
}

pub(crate) fn toggle_auto_translate(app: &tauri::AppHandle) -> Result<RuntimeState, String> {
    let runtime = app.state::<AppState>().toggle_auto_translate()?;
    publish_auto_translate(app, runtime)
}

#[tauri::command]
fn get_runtime_state(state: State<'_, AppState>) -> Result<RuntimeState, String> {
    state.runtime()
}

#[tauri::command]
fn get_target_capture_diagnostic(state: State<'_, AppState>) -> Result<TargetDiagnostics, String> {
    state.target_diagnostics()
}

#[tauri::command]
fn read_current_clipboard_unicode(
    app: tauri::AppHandle,
) -> Result<selection::ClipboardUnicodeDiagnostic, String> {
    let main = app
        .get_webview_window("main")
        .ok_or_else(|| "main window is unavailable".to_owned())?;
    let hwnd = main.hwnd().map_err(|error| error.to_string())?;
    Ok(selection::Win32CapturePlatform::new(hwnd.0 as isize).read_current_unicode_diagnostic())
}

#[tauri::command]
fn set_popup_listener_ready(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    ready: bool,
) -> Result<(), String> {
    let diagnostic = state.set_popup_listener_ready(ready)?;
    app.emit_to("main", TARGET_CAPTURE_DIAGNOSTIC, diagnostic)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn ack_target_diagnostic(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    capture_generation: u64,
    translation_generation: u64,
) -> Result<bool, String> {
    let (accepted, diagnostic) =
        state.acknowledge_target_diagnostic(capture_generation, translation_generation)?;
    if let Some(diagnostic) = diagnostic {
        app.emit_to("main", TARGET_CAPTURE_DIAGNOSTIC, diagnostic)
            .map_err(|error| error.to_string())?;
    }
    Ok(accepted)
}

#[tauri::command]
fn set_auto_translate(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    enabled: bool,
) -> Result<RuntimeState, String> {
    publish_auto_translate(&app, state.set_auto_translate(enabled)?)
}

#[tauri::command]
fn open_main_section(app: tauri::AppHandle, section: MainSection) -> Result<(), String> {
    present_main(&app, section)
}

#[tauri::command]
fn hide_popup(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(popup) = app.get_webview_window("popup") {
        popup.hide().map_err(|error| error.to_string())?;
    }
    Ok(())
}

pub(crate) fn emit_translation(
    app: &tauri::AppHandle,
    payload: &MockTranslationState,
) -> Result<(), String> {
    if let Some(popup) = app.get_webview_window("popup") {
        let _ = popup.center();
        popup.show().map_err(|error| error.to_string())?;
    }
    app.emit_to("popup", TRANSLATION_STATE_CHANGED, payload)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn show_mock_translation(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    scenario: MockScenario,
) -> Result<MockTranslationState, String> {
    let generation = state.next_translation_generation();
    let payload = match scenario {
        MockScenario::Loading => MockTranslationState::loading(generation),
        MockScenario::WordSuccess => MockTranslationState::word(generation),
        MockScenario::SentenceSuccess => MockTranslationState::sentence(generation),
        MockScenario::Error => MockTranslationState::error(generation),
        MockScenario::Retry => MockTranslationState::loading(generation),
    };
    emit_translation(&app, &payload)?;

    if matches!(scenario, MockScenario::Retry) {
        let app_handle = app.clone();
        thread::spawn(move || {
            thread::sleep(Duration::from_millis(450));
            if app_handle
                .state::<AppState>()
                .is_current_translation(generation)
            {
                let _ = emit_translation(&app_handle, &MockTranslationState::word(generation));
            }
        });
    }
    Ok(payload)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct GatewayAccessVerificationResult {
    success: bool,
    gateway_access_configured: bool,
    http_status: Option<u16>,
    error_code: Option<String>,
    gateway_error_code: Option<String>,
    message: String,
}

#[tauri::command]
fn get_settings(state: State<'_, AppState>) -> Result<SettingsView, String> {
    let settings = state
        .settings_repository()?
        .load()
        .map_err(|error| error.to_string())?;
    Ok(SettingsView::from(&settings))
}

#[tauri::command]
fn set_translation_mode(
    state: State<'_, AppState>,
    mode: TranslationMode,
) -> Result<SettingsView, String> {
    let repository = state.settings_repository()?;
    let mut settings = repository.load().map_err(|error| error.to_string())?;
    settings.translation_mode = mode;
    repository
        .save(&settings)
        .map_err(|error| error.to_string())?;
    state.set_translation_mode(mode)?;
    Ok(SettingsView::from(&settings))
}

#[tauri::command]
fn get_gateway_test_state(state: State<'_, AppState>) -> Result<GatewayTestState, String> {
    state.gateway_test_state()
}

#[tauri::command]
async fn verify_and_save_access_code(
    state: State<'_, AppState>,
    access_code: String,
) -> Result<GatewayAccessVerificationResult, String> {
    let candidate = access_code.trim().to_owned();
    let repository = state.settings_repository()?;
    let existing = repository.load().map_err(|error| error.to_string())?;
    if candidate.is_empty() {
        return Ok(GatewayAccessVerificationResult {
            success: false,
            gateway_access_configured: !existing.gateway_access_token.is_empty(),
            http_status: None,
            error_code: Some("invalid_access_token".into()),
            gateway_error_code: None,
            message: "访问码不能为空".into(),
        });
    }

    let candidate_for_verify = candidate.clone();
    let outcome = tauri::async_runtime::spawn_blocking(move || {
        let transport = ReqwestGatewayTransport::new()?;
        GatewayClient::new(transport).verify_access_code(&candidate_for_verify)
    })
    .await
    .map_err(|error| format!("gateway verification task failed: {error}"))?;

    match outcome {
        Ok(verification) => {
            let mut updated = existing;
            updated.gateway_access_token = candidate;
            repository
                .save(&updated)
                .map_err(|error| error.to_string())?;
            Ok(GatewayAccessVerificationResult {
                success: true,
                gateway_access_configured: true,
                http_status: Some(verification.http_status),
                error_code: None,
                gateway_error_code: None,
                message: "访问码验证成功并已保存".into(),
            })
        }
        Err(failure) => Ok(GatewayAccessVerificationResult {
            success: false,
            gateway_access_configured: !existing.gateway_access_token.is_empty(),
            http_status: failure.http_status,
            error_code: Some(failure.error_code),
            gateway_error_code: failure.gateway_error_code,
            message: failure.message,
        }),
    }
}

#[tauri::command]
async fn send_latest_target_to_gateway(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<GatewayTestState, String> {
    let current = state.gateway_test_state()?;
    let Some(target) = current.latest_target.clone() else {
        return state.update_gateway_test_state(|gateway| {
            gateway.connection_state = GatewayConnectionState::Failed;
            gateway.parse_status = GatewayParseStatus::NotAttempted;
            gateway.error_code = Some("target_unavailable".into());
            gateway.gateway_error_code = None;
            gateway.error_message = Some("尚无可发送的 TARGET".into());
        });
    };
    run_gateway_translation(app, target, GatewayPresentation::MainOnly).await
}

#[tauri::command]
async fn retry_live_translation(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    generation: u64,
    request_id: String,
) -> Result<GatewayTestState, String> {
    let Some(claim) = state.claim_live_gateway_retry(generation, &request_id)? else {
        return Err("retry request is stale or not eligible".into());
    };
    run_claimed_gateway_translation(app, claim, GatewayPresentation::LivePopupRetry).await
}

#[tauri::command]
async fn request_live_detail(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    generation: u64,
    quick_request_id: String,
) -> Result<(), String> {
    let Some(claim) = state.claim_live_detail(generation, &quick_request_id)? else {
        return Err("detail request is stale or not eligible".into());
    };
    run_claimed_live_detail(app, claim).await
}

#[tauri::command]
async fn retry_live_detail(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    generation: u64,
    detail_request_id: String,
) -> Result<(), String> {
    let Some(claim) = state.claim_live_detail_retry(generation, &detail_request_id)? else {
        return Err("detail retry is stale or not eligible".into());
    };
    run_claimed_live_detail(app, claim).await
}

fn publish_vocabulary_changed(app: &tauri::AppHandle) -> Result<(), String> {
    app.emit_to("main", VOCABULARY_CHANGED, ())
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn list_vocabulary(
    state: State<'_, AppState>,
    query: Option<String>,
) -> Result<VocabularyListResult, String> {
    state.with_vocabulary_repository(|repository| repository.list(query.as_deref()))
}

#[tauri::command]
async fn get_current_override(app: tauri::AppHandle, generation: u64, quick_request_id: String) -> Result<app_state::OverrideEditorView, String> {
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<AppState>().begin_override_edit(generation, &quick_request_id,
            &app.state::<std::sync::Arc<dictionary::DictionaryService>>())
    }).await.map_err(|_| "个人词典读取失败".to_string())?
}

#[tauri::command]
async fn save_current_override(app: tauri::AppHandle, generation: u64, quick_request_id: String,
    session_id: u64, fields: dictionary::LocalDictionaryEntry) -> Result<Option<app_state::PopupTranslationResult>, String> {
    commit_current_override(app, generation, quick_request_id, session_id, Some(fields)).await
}

#[tauri::command]
async fn remove_current_override(app: tauri::AppHandle, generation: u64, quick_request_id: String,
    session_id: u64) -> Result<Option<app_state::PopupTranslationResult>, String> {
    commit_current_override(app, generation, quick_request_id, session_id, None).await
}

async fn commit_current_override(app: tauri::AppHandle, generation: u64, quick_request_id: String,
    session_id: u64, fields: Option<dictionary::LocalDictionaryEntry>) -> Result<Option<app_state::PopupTranslationResult>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let result = app.state::<AppState>().commit_override_edit(generation, &quick_request_id, session_id,
            &app.state::<std::sync::Arc<dictionary::DictionaryService>>(), fields)?;
        // Diagnostics only: do not emit/reposition the normal Popup or reset Detail.
        if let Ok(state) = app.state::<AppState>().gateway_test_state() {
            let _ = app.emit_to("main", GATEWAY_TARGET_CHANGED, state);
        }
        Ok(result)
    }).await.map_err(|_| "个人词典操作失败".to_string())?
}

#[tauri::command]
fn save_current_word_to_vocabulary(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    generation: u64,
    quick_request_id: String,
) -> Result<VocabularySaveResult, String> {
    let candidate = state
        .current_vocabulary_candidate(generation, &quick_request_id)?
        .ok_or_else(|| "word result is stale or not eligible for saving".to_owned())?;
    let result = state.with_vocabulary_repository(|repository| repository.upsert(candidate))?;
    publish_vocabulary_changed(&app)?;
    Ok(result)
}

#[tauri::command]
fn delete_vocabulary_entry(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> Result<VocabularyListResult, String> {
    let result = state.with_vocabulary_repository(|repository| repository.delete(&id))?;
    publish_vocabulary_changed(&app)?;
    Ok(result)
}

#[tauri::command]
async fn import_vocabulary(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<VocabularyImportResult, String> {
    let Some(selected) = app
        .dialog()
        .file()
        .add_filter("Orange vocabulary", &["json"])
        .blocking_pick_file()
    else {
        return Ok(VocabularyImportResult {
            cancelled: true,
            added: 0,
            updated: 0,
            total: state.with_vocabulary_repository(|repository| {
                repository.list(None).map(|result| result.total)
            })?,
        });
    };
    let path = selected
        .into_path()
        .map_err(|_| "selected import location is not a local file".to_owned())?;
    let result = state.with_vocabulary_repository(|repository| repository.import_from(&path))?;
    publish_vocabulary_changed(&app)?;
    Ok(result)
}

#[tauri::command]
async fn export_vocabulary(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<VocabularyExportResult, String> {
    let Some(selected) = app
        .dialog()
        .file()
        .add_filter("Orange vocabulary", &["json"])
        .set_file_name("Orange生词本.json")
        .blocking_save_file()
    else {
        return Ok(VocabularyExportResult {
            cancelled: true,
            exported: 0,
        });
    };
    let path = selected
        .into_path()
        .map_err(|_| "selected export location is not a local file".to_owned())?;
    state.with_vocabulary_repository(|repository| repository.export_to(&path))
}

#[tauri::command]
fn open_vocabulary_source(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> Result<(), String> {
    let url = state
        .with_vocabulary_repository(|repository| repository.source_url(&id))?
        .ok_or_else(|| "vocabulary entry has no source URL".to_owned())?;
    if !validate_source_url(&url) {
        return Err("vocabulary source URL is not allowed".into());
    }
    app.opener()
        .open_url(url, None::<String>)
        .map_err(|error| error.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            let _ = present_main(app, MainSection::Home);
        }))
        .manage(AppState::default())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    if should_toggle_for_shortcut(event.state() == ShortcutState::Pressed) {
                        let _ = toggle_auto_translate(app);
                    }
                })
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            get_current_override,
            save_current_override,
            remove_current_override,
            get_runtime_state,
            get_target_capture_diagnostic,
            read_current_clipboard_unicode,
            set_popup_listener_ready,
            ack_target_diagnostic,
            set_auto_translate,
            show_mock_translation,
            hide_popup,
            open_main_section,
            get_settings,
            set_translation_mode,
            get_gateway_test_state,
            verify_and_save_access_code,
            send_latest_target_to_gateway,
            retry_live_translation,
            request_live_detail,
            retry_live_detail,
            list_vocabulary,
            save_current_word_to_vocabulary,
            delete_vocabulary_entry,
            import_vocabulary,
            export_vocabulary,
            open_vocabulary_source
        ])
        .setup(|app| {
            let app_data_dir = app.path().app_data_dir()?;
            let base_path = app.path().resource_dir()?.join("dictionary/orange_dictionary.db");
            app.manage(std::sync::Arc::new(dictionary::DictionaryService::new(
                base_path, app_data_dir.join("orange_user_lexicon.db"))));
            let settings_path = app_data_dir.join("settings.json");
            let settings_repository = SettingsRepository::new(settings_path);
            let initial_settings = settings_repository.load().unwrap_or_default();
            app.state::<AppState>()
                .set_translation_mode(initial_settings.translation_mode)
                .map_err(|message| tauri::Error::Io(std::io::Error::other(message)))?;
            app.state::<AppState>()
                .set_settings_repository(settings_repository)
                .map_err(|message| tauri::Error::Io(std::io::Error::other(message)))?;
            app.state::<AppState>()
                .set_vocabulary_repository(VocabularyRepository::new(
                    app_data_dir.join("vocabulary.json"),
                ))
                .map_err(|message| tauri::Error::Io(std::io::Error::other(message)))?;
            app.global_shortcut().register("F1")?;
            if let Some(status) = app.get_webview_window("status") {
                let _ = status.set_focusable(false);
            }
            if let Some(main) = app.get_webview_window("main") {
                match main
                    .hwnd()
                    .map_err(|error| error.to_string())
                    .and_then(|hwnd| {
                        selection::CaptureController::start(app.handle().clone(), hwnd.0 as isize)
                    }) {
                    Ok(controller) => {
                        app.state::<AppState>().mark_target_capture_available();
                        app.manage(controller);
                        let _ = publish_target_capture_diagnostic(app.handle(), |diagnostic| {
                            diagnostic.hook_ready = true;
                            diagnostic.reason_code.clear();
                        });
                    }
                    Err(error) => {
                        app.state::<AppState>().mark_target_capture_unavailable();
                        let _ = publish_target_capture_diagnostic(app.handle(), |diagnostic| {
                            diagnostic.hook_ready = false;
                            diagnostic.reason_code = "hook_not_ready".into();
                        });
                        eprintln!(
                            "target-capture stage=hook-install status=unavailable error={error}"
                        );
                    }
                }
            } else {
                app.state::<AppState>().mark_target_capture_unavailable();
                eprintln!("target-capture stage=main-hwnd status=unavailable");
            }
            tray::build(app)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                let exiting = window.app_handle().state::<AppState>().is_exiting();
                if windows::close_action(window.label(), exiting) == windows::CloseAction::Hide {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running Orange翻译 desktop application");
}

#[cfg(test)]
mod diagnostic_dispatch_tests {
    use super::{
        dispatch_target_diagnostic, MockTranslationState, PopupDispatchError,
        PopupDispatchProgress, TargetPopupPort,
    };
    use std::cell::{Cell, RefCell};

    struct FakePort {
        listener_ready: bool,
        window_exists: bool,
        show_error: Option<PopupDispatchError>,
        emit_error: Option<PopupDispatchError>,
        show_calls: Cell<u32>,
        emit_calls: Cell<u32>,
    }

    impl TargetPopupPort for FakePort {
        fn listener_ready(&self) -> bool {
            self.listener_ready
        }

        fn window_exists(&self) -> bool {
            self.window_exists
        }

        fn show_popup(&self) -> Result<(), PopupDispatchError> {
            self.show_calls.set(self.show_calls.get() + 1);
            self.show_error.map_or(Ok(()), Err)
        }

        fn emit_payload(&self, _payload: &MockTranslationState) -> Result<(), PopupDispatchError> {
            self.emit_calls.set(self.emit_calls.get() + 1);
            self.emit_error.map_or(Ok(()), Err)
        }
    }

    fn port() -> FakePort {
        FakePort {
            listener_ready: true,
            window_exists: true,
            show_error: None,
            emit_error: None,
            show_calls: Cell::new(0),
            emit_calls: Cell::new(0),
        }
    }

    #[test]
    fn popup_dispatch_failures_keep_distinct_reason_codes() {
        assert_eq!(
            PopupDispatchError::StaleGeneration.reason_code(),
            "stale_generation"
        );
        assert_eq!(
            PopupDispatchError::WindowMissing.reason_code(),
            "popup_window_missing"
        );
        assert_eq!(
            PopupDispatchError::ListenerNotReady.reason_code(),
            "popup_listener_not_ready"
        );
        assert_eq!(
            PopupDispatchError::ShowFailed.reason_code(),
            "popup_show_failed"
        );
        assert_eq!(
            PopupDispatchError::EmitFailed.reason_code(),
            "popup_emit_failed"
        );
    }

    #[test]
    fn dispatcher_covers_listener_show_emit_and_stale_gates() {
        let payload = MockTranslationState::loading(1);

        let mut fake = port();
        fake.listener_ready = false;
        assert_eq!(
            dispatch_target_diagnostic(&fake, &payload, || true, |_| {}),
            Err(PopupDispatchError::ListenerNotReady)
        );
        assert_eq!((fake.show_calls.get(), fake.emit_calls.get()), (0, 0));

        let mut fake = port();
        fake.window_exists = false;
        assert_eq!(
            dispatch_target_diagnostic(&fake, &payload, || true, |_| {}),
            Err(PopupDispatchError::WindowMissing)
        );
        assert_eq!((fake.show_calls.get(), fake.emit_calls.get()), (0, 0));

        let mut fake = port();
        fake.show_error = Some(PopupDispatchError::ShowFailed);
        assert_eq!(
            dispatch_target_diagnostic(&fake, &payload, || true, |_| {}),
            Err(PopupDispatchError::ShowFailed)
        );
        assert_eq!((fake.show_calls.get(), fake.emit_calls.get()), (1, 0));

        let mut fake = port();
        fake.emit_error = Some(PopupDispatchError::EmitFailed);
        assert_eq!(
            dispatch_target_diagnostic(&fake, &payload, || true, |_| {}),
            Err(PopupDispatchError::EmitFailed)
        );
        assert_eq!((fake.show_calls.get(), fake.emit_calls.get()), (1, 1));

        let fake = port();
        assert_eq!(
            dispatch_target_diagnostic(&fake, &payload, || false, |_| {}),
            Err(PopupDispatchError::StaleGeneration)
        );
        assert_eq!((fake.show_calls.get(), fake.emit_calls.get()), (0, 0));

        let fake = port();
        let checks = Cell::new(0);
        assert_eq!(
            dispatch_target_diagnostic(
                &fake,
                &payload,
                || {
                    checks.set(checks.get() + 1);
                    checks.get() == 1
                },
                |_| {}
            ),
            Err(PopupDispatchError::StaleGeneration)
        );
        assert_eq!((fake.show_calls.get(), fake.emit_calls.get()), (1, 0));

        let fake = port();
        let progress = RefCell::new(Vec::new());
        assert!(dispatch_target_diagnostic(
            &fake,
            &payload,
            || true,
            |step| {
                progress.borrow_mut().push(step);
            }
        )
        .is_ok());
        assert_eq!((fake.show_calls.get(), fake.emit_calls.get()), (1, 1));
        assert_eq!(
            *progress.borrow(),
            vec![
                PopupDispatchProgress::WindowExists,
                PopupDispatchProgress::ListenerReady,
                PopupDispatchProgress::ShowPending,
                PopupDispatchProgress::ShowSuccess,
                PopupDispatchProgress::EmitPending,
                PopupDispatchProgress::EmitSuccess,
            ]
        );
    }
}

#[cfg(test)]
mod stage3b_popup_tests {
    use super::{
        app_state::{
            ContextCaptureSnapshot, ContextStatus, GatewayKeyTerm, GatewayParsedResult,
            LatestGatewayTarget, LivePopupErrorKind, LivePopupTranslationState,
            PopupTranslationResult, RequestType,
        },
        classify_live_popup_failure,
        gateway::GatewayFailure,
        should_commit_live_popup, should_emit_live_detail, should_emit_live_loading,
        DetailPopupCommitGate, GatewayPresentation, LiveLoadingGate, LivePopupCommitGate,
    };

    fn target(request_type: RequestType) -> LatestGatewayTarget {
        LatestGatewayTarget {
            target: "measurement".into(),
            binding: None,
            request_type,
            page_title: "Notepad".into(),
            source_app: "Notepad".into(),
            capture_generation: 7,
            translation_generation: 8,
            captured_at_unix_ms: 9,
            context: ContextCaptureSnapshot::empty(ContextStatus::Unsupported),
            translation_mode: crate::settings::TranslationMode::Precise,
        }
    }

    #[test]
    fn word_and_sentence_results_map_to_strict_popup_models() {
        let word = GatewayParsedResult::Word {
            provider: "gateway".into(),
            upstream_provider: "provider".into(),
            skill_version: "skill".into(),
            word: "measurement".into(),
            lemma: "measure".into(),
            phonetic: "/ˈmeʒəmənt/".into(),
            part_of_speech: "n.".into(),
            meaning: "测量".into(),
        };
        assert_eq!(
            PopupTranslationResult::from(&word),
            PopupTranslationResult::Word {
                word: "measurement".into(),
                lemma: "measure".into(),
                phonetic: "/ˈmeʒəmənt/".into(),
                part_of_speech: "n.".into(),
                meaning: "测量".into(),
            }
        );

        let sentence = GatewayParsedResult::Sentence {
            provider: "gateway".into(),
            upstream_provider: "provider".into(),
            skill_version: "skill".into(),
            translation: "译文".into(),
            key_term: Some(GatewayKeyTerm {
                term: "test".into(),
                meaning: "测试".into(),
            }),
        };
        assert!(matches!(
            PopupTranslationResult::from(&sentence),
            PopupTranslationResult::Sentence {
                key_term: Some(_),
                ..
            }
        ));
        let without_key_term = GatewayParsedResult::Sentence {
            provider: "gateway".into(),
            upstream_provider: "provider".into(),
            skill_version: "skill".into(),
            translation: "译文".into(),
            key_term: None,
        };
        assert!(matches!(
            PopupTranslationResult::from(&without_key_term),
            PopupTranslationResult::Sentence { key_term: None, .. }
        ));
    }

    #[test]
    fn live_payloads_are_tagged_and_exclude_gateway_diagnostics() {
        let target = target(RequestType::WordAnalysis);
        let loading = serde_json::to_value(LivePopupTranslationState::loading(
            &target,
            "desktop-1".into(),
        ))
        .unwrap();
        assert_eq!(loading["phase"], "loading");
        assert_eq!(loading["requestId"], "desktop-1");
        assert!(loading.get("rawPreview").is_none());
        assert!(loading.get("httpStatus").is_none());
        assert!(loading.get("accessToken").is_none());

        let parsed = GatewayParsedResult::Word {
            provider: "gateway".into(),
            upstream_provider: "provider".into(),
            skill_version: "skill".into(),
            word: "measurement".into(),
            lemma: "measure".into(),
            phonetic: "/m/".into(),
            part_of_speech: "n.".into(),
            meaning: "测量".into(),
        };
        let success = serde_json::to_value(LivePopupTranslationState::success(
            &target,
            "desktop-1".into(),
            &parsed,
        ))
        .unwrap();
        assert_eq!(success["phase"], "success");
        assert_eq!(success["result"]["kind"], "word");
        assert_eq!(success["result"]["partOfSpeech"], "n.");
        assert!(success["result"].get("part_of_speech").is_none());
        assert!(success["result"].get("provider").is_none());
        assert!(success["result"].get("upstreamProvider").is_none());
        assert!(success["result"].get("skillVersion").is_none());

        let error = serde_json::to_value(LivePopupTranslationState::error(
            &target,
            "desktop-1".into(),
            LivePopupErrorKind::Retryable,
        ))
        .unwrap();
        assert_eq!(error["phase"], "error");
        assert_eq!(error["errorKind"], "retryable");
        assert_eq!(error["message"], "翻译失败，请稍后重试");
        assert!(error.get("errorCode").is_none());
    }

    #[test]
    fn sentence_popup_payload_serializes_key_term_in_camel_case() {
        let target = target(RequestType::SentenceTranslation);
        let parsed = GatewayParsedResult::Sentence {
            provider: "gateway".into(),
            upstream_provider: "provider".into(),
            skill_version: "skill".into(),
            translation: "神经毒剂测量。".into(),
            key_term: Some(crate::app_state::GatewayKeyTerm {
                term: "nerve agent".into(),
                meaning: "神经毒剂".into(),
            }),
        };
        let success = serde_json::to_value(LivePopupTranslationState::success(
            &target,
            "desktop-sentence-1".into(),
            &parsed,
        ))
        .unwrap();

        assert_eq!(success["result"]["kind"], "sentence");
        assert_eq!(success["result"]["translation"], "神经毒剂测量。");
        assert_eq!(success["result"]["keyTerm"]["term"], "nerve agent");
        assert_eq!(success["result"]["keyTerm"]["meaning"], "神经毒剂");
        assert!(success["result"].get("key_term").is_none());

        let without_key_term = GatewayParsedResult::Sentence {
            provider: "gateway".into(),
            upstream_provider: "provider".into(),
            skill_version: "skill".into(),
            translation: "普通译文。".into(),
            key_term: None,
        };
        let without_key_term = serde_json::to_value(LivePopupTranslationState::success(
            &target,
            "desktop-sentence-2".into(),
            &without_key_term,
        ))
        .unwrap();

        assert_eq!(without_key_term["result"]["translation"], "普通译文。");
        assert!(without_key_term["result"]["keyTerm"].is_null());
        assert!(without_key_term["result"].get("key_term").is_none());
    }

    #[test]
    fn live_errors_classify_configuration_retryable_and_terminal_without_diagnostics() {
        let failure = |code: &str, status, requires_configuration| GatewayFailure {
            error_code: code.into(),
            gateway_error_code: Some("INTERNAL_CODE".into()),
            message: "internal detail".into(),
            http_status: status,
            requires_configuration,
            parse_failed: false,
            raw_preview: Some("raw response".into()),
        };
        for item in [
            failure("invalid_access_token", Some(401), false),
            failure("invalid_access_token", Some(403), false),
            failure("access_not_configured", None, false),
            failure("other", None, true),
        ] {
            assert_eq!(
                classify_live_popup_failure(&item),
                LivePopupErrorKind::Configuration
            );
        }
        for code in [
            "timeout",
            "network_error",
            "http_5xx",
            "gateway_error",
            "response_json_invalid",
            "response_schema_invalid",
            "request_id_mismatch",
            "settings_unavailable",
        ] {
            assert_eq!(
                classify_live_popup_failure(&failure(code, None, false)),
                LivePopupErrorKind::Retryable
            );
        }
        assert_eq!(
            classify_live_popup_failure(&failure("http_4xx", Some(422), false)),
            LivePopupErrorKind::Terminal
        );

        for (kind, expected_message) in [
            (
                LivePopupErrorKind::Configuration,
                "访问码无效或未配置，请在设置中重新验证",
            ),
            (LivePopupErrorKind::Retryable, "翻译失败，请稍后重试"),
            (LivePopupErrorKind::Terminal, "翻译失败，请重新划取后再试"),
        ] {
            let payload = serde_json::to_value(LivePopupTranslationState::error(
                &target(RequestType::WordAnalysis),
                "desktop-error".into(),
                kind,
            ))
            .unwrap();
            assert_eq!(payload["message"], expected_message);
            assert!(payload.get("httpStatus").is_none());
            assert!(payload.get("gatewayErrorCode").is_none());
            assert!(payload.get("rawPreview").is_none());
        }
    }

    #[test]
    fn live_popup_commit_requires_generation_request_auto_and_visibility() {
        let allowed = LivePopupCommitGate {
            generation_current: true,
            request_current: true,
            auto_translate_enabled: true,
            popup_visible: true,
        };
        assert!(should_commit_live_popup(allowed));
        for blocked in [
            LivePopupCommitGate {
                generation_current: false,
                ..allowed
            },
            LivePopupCommitGate {
                request_current: false,
                ..allowed
            },
            LivePopupCommitGate {
                auto_translate_enabled: false,
                ..allowed
            },
            LivePopupCommitGate {
                popup_visible: false,
                ..allowed
            },
        ] {
            assert!(!should_commit_live_popup(blocked));
        }
    }

    #[test]
    fn loading_requires_current_enabled_identity_and_retry_never_requests_show() {
        let allowed = LiveLoadingGate {
            generation_current: true,
            request_current: true,
            auto_translate_enabled: true,
        };
        assert!(should_emit_live_loading(allowed));
        for blocked in [
            LiveLoadingGate {
                generation_current: false,
                ..allowed
            },
            LiveLoadingGate {
                request_current: false,
                ..allowed
            },
            LiveLoadingGate {
                auto_translate_enabled: false,
                ..allowed
            },
        ] {
            assert!(!should_emit_live_loading(blocked));
        }
        assert!(GatewayPresentation::LivePopupNewTarget.loading_may_show());
        assert!(!GatewayPresentation::LivePopupRetry.loading_may_show());
    }

    #[test]
    fn detail_popup_never_emits_when_hidden_disabled_or_stale() {
        let allowed = DetailPopupCommitGate {
            generation_current: true,
            quick_request_current: true,
            detail_request_current: true,
            auto_translate_enabled: true,
            popup_visible: true,
            listener_ready: true,
        };
        assert!(should_emit_live_detail(allowed));
        for blocked in [
            DetailPopupCommitGate {
                generation_current: false,
                ..allowed
            },
            DetailPopupCommitGate {
                quick_request_current: false,
                ..allowed
            },
            DetailPopupCommitGate {
                detail_request_current: false,
                ..allowed
            },
            DetailPopupCommitGate {
                auto_translate_enabled: false,
                ..allowed
            },
            DetailPopupCommitGate {
                popup_visible: false,
                ..allowed
            },
            DetailPopupCommitGate {
                listener_ready: false,
                ..allowed
            },
        ] {
            assert!(!should_emit_live_detail(blocked));
        }
    }
}
