use crate::app_state::{ContextCaptureSnapshot, ContextSource, ContextStatus, ContextUnit};
use std::{
    ffi::c_void,
    sync::mpsc::{self, Receiver, SyncSender, TrySendError},
    thread,
    time::Duration,
};
use windows::{
    core::Result as WindowsResult,
    Win32::{
        Foundation::HWND,
        System::Com::{
            CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER,
            COINIT_MULTITHREADED,
        },
        UI::Accessibility::{
            CUIAutomation, IUIAutomation, IUIAutomationElement, IUIAutomationTextPattern,
            IUIAutomationTextRange, TextUnit, TextUnit_Line, TextUnit_Paragraph, UIA_TextPatternId,
        },
    },
};

const CONTEXT_LIMIT: usize = 5000;
const PREVIEW_LIMIT: usize = 400;
pub(super) const CONTEXT_WAIT: Duration = Duration::from_millis(200);

#[derive(Debug, Clone)]
pub(super) struct ContextCaptureRequest {
    pub foreground_hwnd: isize,
    pub foreground_pid: u32,
    pub target: String,
}

struct WorkerRequest {
    request: ContextCaptureRequest,
    response: mpsc::Sender<ContextCaptureSnapshot>,
}

#[derive(Clone)]
pub(super) struct UiaContextService {
    sender: Option<SyncSender<WorkerRequest>>,
}

impl UiaContextService {
    pub fn start() -> Self {
        let (sender, receiver) = mpsc::sync_channel(1);
        let available = thread::Builder::new()
            .name("orange-uia-context".into())
            .spawn(move || run_worker(receiver))
            .is_ok();
        Self {
            sender: available.then_some(sender),
        }
    }

    pub fn capture(
        &self,
        request: ContextCaptureRequest,
        timeout: Duration,
    ) -> ContextCaptureSnapshot {
        let Some(sender) = &self.sender else {
            return ContextCaptureSnapshot::empty(ContextStatus::Error);
        };
        let (response, receiver) = mpsc::channel();
        match sender.try_send(WorkerRequest { request, response }) {
            Ok(()) => receiver
                .recv_timeout(timeout)
                .unwrap_or_else(|_| ContextCaptureSnapshot::empty(ContextStatus::Timeout)),
            Err(TrySendError::Full(_)) => ContextCaptureSnapshot::empty(ContextStatus::Timeout),
            Err(TrySendError::Disconnected(_)) => {
                ContextCaptureSnapshot::empty(ContextStatus::Error)
            }
        }
    }
}

struct ComGuard;

impl Drop for ComGuard {
    fn drop(&mut self) {
        unsafe { CoUninitialize() };
    }
}

fn run_worker(receiver: Receiver<WorkerRequest>) {
    let automation = initialize_automation();
    while let Ok(message) = receiver.recv() {
        let snapshot = match &automation {
            Ok((_, automation)) => capture_with_automation(automation, &message.request),
            Err(status) => ContextCaptureSnapshot::empty(*status),
        };
        let _ = message.response.send(snapshot);
    }
}

fn initialize_automation() -> Result<(ComGuard, IUIAutomation), ContextStatus> {
    unsafe {
        CoInitializeEx(None, COINIT_MULTITHREADED)
            .ok()
            .map_err(|_| ContextStatus::Error)?;
        let guard = ComGuard;
        let automation = CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER)
            .map_err(|_| ContextStatus::Unsupported)?;
        Ok((guard, automation))
    }
}

fn capture_with_automation(
    automation: &IUIAutomation,
    request: &ContextCaptureRequest,
) -> ContextCaptureSnapshot {
    capture_standard_paths(&WindowsElementProvider { automation }, request)
}

trait UiaElementProvider {
    type Element;
    fn focused_element(&self) -> Option<(u32, Self::Element)>;
    fn hwnd_element(&self, hwnd: isize) -> Option<(u32, Self::Element)>;
    fn capture(&self, element: &Self::Element, target: &str) -> ContextCaptureSnapshot;
}

struct WindowsElementProvider<'a> {
    automation: &'a IUIAutomation,
}

impl UiaElementProvider for WindowsElementProvider<'_> {
    type Element = IUIAutomationElement;

    fn focused_element(&self) -> Option<(u32, Self::Element)> {
        let element = unsafe { self.automation.GetFocusedElement() }.ok()?;
        let pid = unsafe { element.CurrentProcessId() }.ok()? as u32;
        Some((pid, element))
    }

    fn hwnd_element(&self, hwnd: isize) -> Option<(u32, Self::Element)> {
        let element =
            unsafe { self.automation.ElementFromHandle(HWND(hwnd as *mut c_void)) }.ok()?;
        let pid = unsafe { element.CurrentProcessId() }.ok()? as u32;
        Some((pid, element))
    }

    fn capture(&self, element: &Self::Element, target: &str) -> ContextCaptureSnapshot {
        capture_element(element, target)
    }
}

fn capture_standard_paths<P: UiaElementProvider>(
    provider: &P,
    request: &ContextCaptureRequest,
) -> ContextCaptureSnapshot {
    let mut last = ContextCaptureSnapshot::empty(ContextStatus::Unsupported);
    let mut matched_pid = false;
    if let Some((pid, element)) = provider.focused_element() {
        if pid == request.foreground_pid {
            matched_pid = true;
            let snapshot = provider.capture(&element, &request.target);
            if snapshot.status == ContextStatus::Success {
                return snapshot;
            }
            last = snapshot;
        }
    }
    if let Some((pid, element)) = provider.hwnd_element(request.foreground_hwnd) {
        if pid == request.foreground_pid {
            matched_pid = true;
            let snapshot = provider.capture(&element, &request.target);
            if snapshot.status == ContextStatus::Success {
                return snapshot;
            }
            last = snapshot;
        }
    }
    if matched_pid {
        last
    } else {
        ContextCaptureSnapshot::empty(ContextStatus::Unsupported)
    }
}

fn capture_element(element: &IUIAutomationElement, target: &str) -> ContextCaptureSnapshot {
    let pattern: IUIAutomationTextPattern =
        match unsafe { element.GetCurrentPatternAs(UIA_TextPatternId) } {
            Ok(pattern) => pattern,
            Err(_) => return ContextCaptureSnapshot::empty(ContextStatus::Unsupported),
        };
    let selections = match unsafe { pattern.GetSelection() } {
        Ok(selections) => selections,
        Err(_) => return ContextCaptureSnapshot::empty(ContextStatus::Error),
    };
    let count = match unsafe { selections.Length() } {
        Ok(count) if count > 0 => count,
        Ok(_) => return ContextCaptureSnapshot::empty(ContextStatus::NoSelection),
        Err(_) => return ContextCaptureSnapshot::empty(ContextStatus::Error),
    };
    for index in 0..count {
        let Ok(range) = (unsafe { selections.GetElement(index) }) else {
            continue;
        };
        let selection = match range_text(&range) {
            Ok(value) if !normalize_context_text(&value).is_empty() => value,
            _ => continue,
        };
        if normalize_context_text(&selection) != normalize_context_text(target) {
            return ContextCaptureSnapshot::empty(ContextStatus::Mismatch);
        }
        return choose_expanded_context(target, |unit| expanded_text(&range, unit));
    }
    ContextCaptureSnapshot::empty(ContextStatus::Mismatch)
}

fn range_text(range: &IUIAutomationTextRange) -> WindowsResult<String> {
    unsafe { range.GetText((CONTEXT_LIMIT + 1) as i32) }.map(|value| value.to_string())
}

fn expanded_text(selection: &IUIAutomationTextRange, unit: TextUnit) -> Option<String> {
    let range = unsafe { selection.Clone() }.ok()?;
    unsafe { range.ExpandToEnclosingUnit(unit) }.ok()?;
    range_text(&range).ok()
}

fn choose_expanded_context(
    target: &str,
    mut read: impl FnMut(TextUnit) -> Option<String>,
) -> ContextCaptureSnapshot {
    if let Some(paragraph) = read(TextUnit_Paragraph) {
        if let Some(snapshot) =
            context_snapshot_from_text(target, &paragraph, ContextUnit::Paragraph)
        {
            return snapshot;
        }
    }
    if let Some(line) = read(TextUnit_Line) {
        if let Some(snapshot) = context_snapshot_from_text(target, &line, ContextUnit::Line) {
            return snapshot;
        }
    }
    ContextCaptureSnapshot::empty(ContextStatus::Mismatch)
}

pub(crate) fn normalize_context_text(value: &str) -> String {
    value
        .replace("\r\n", "\n")
        .replace('\r', "\n")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

pub(crate) fn context_snapshot_from_text(
    target: &str,
    value: &str,
    unit: ContextUnit,
) -> Option<ContextCaptureSnapshot> {
    let normalized_target = normalize_context_text(target);
    let normalized = normalize_context_text(value);
    if normalized_target.is_empty() {
        return None;
    }
    let mut context: String = normalized.chars().take(CONTEXT_LIMIT).collect();
    if unit == ContextUnit::Paragraph && normalized.chars().count() > CONTEXT_LIMIT {
        return None;
    }
    if !context.contains(&normalized_target) {
        return None;
    }
    let context_length = context.chars().count();
    let context_preview = context.chars().take(PREVIEW_LIMIT).collect();
    Some(ContextCaptureSnapshot {
        context_sentence: std::mem::take(&mut context),
        status: ContextStatus::Success,
        source: ContextSource::Uia,
        unit,
        context_length,
        context_preview,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    struct FakeProvider {
        focused: Option<(u32, usize)>,
        hwnd: Option<(u32, usize)>,
        results: Vec<ContextCaptureSnapshot>,
        calls: AtomicUsize,
        hwnd_calls: AtomicUsize,
    }

    impl UiaElementProvider for FakeProvider {
        type Element = usize;
        fn focused_element(&self) -> Option<(u32, Self::Element)> {
            self.focused
        }
        fn hwnd_element(&self, _hwnd: isize) -> Option<(u32, Self::Element)> {
            self.hwnd_calls.fetch_add(1, Ordering::SeqCst);
            self.hwnd
        }
        fn capture(&self, element: &Self::Element, _target: &str) -> ContextCaptureSnapshot {
            self.calls.fetch_add(1, Ordering::SeqCst);
            self.results[*element].clone()
        }
    }

    #[test]
    fn normalizes_crlf_trim_and_unicode_whitespace() {
        assert_eq!(normalize_context_text("  alpha\r\n\tbeta  "), "alpha beta");
    }

    #[test]
    fn accepts_matching_context_and_limits_preview() {
        let value = format!("target {}", "x".repeat(500));
        let snapshot =
            context_snapshot_from_text("target", &value, ContextUnit::Paragraph).unwrap();
        assert_eq!(snapshot.status, ContextStatus::Success);
        assert_eq!(snapshot.context_preview.chars().count(), 400);
    }

    #[test]
    fn paragraph_over_limit_falls_back_but_line_truncation_keeps_target_guard() {
        let value = format!("target{}", "x".repeat(5100));
        assert!(context_snapshot_from_text("target", &value, ContextUnit::Paragraph).is_none());
        assert!(context_snapshot_from_text("target", &value, ContextUnit::Line).is_some());
        let tail = format!("{}target", "x".repeat(5001));
        assert!(context_snapshot_from_text("target", &tail, ContextUnit::Line).is_none());
    }

    #[test]
    fn paragraph_failure_uses_exactly_one_line_fallback() {
        let mut units = Vec::new();
        let result = choose_expanded_context("target", |unit| {
            units.push(unit);
            if unit == TextUnit_Paragraph {
                None
            } else {
                Some("line with target".into())
            }
        });
        assert_eq!(result.status, ContextStatus::Success);
        assert_eq!(result.unit, ContextUnit::Line);
        assert_eq!(units, vec![TextUnit_Paragraph, TextUnit_Line]);
    }

    #[test]
    fn focused_pid_mismatch_falls_back_to_original_hwnd() {
        let success =
            context_snapshot_from_text("target", "a target line", ContextUnit::Line).unwrap();
        let provider = FakeProvider {
            focused: Some((99, 0)),
            hwnd: Some((42, 0)),
            results: vec![success.clone()],
            calls: AtomicUsize::new(0),
            hwnd_calls: AtomicUsize::new(0),
        };
        let result = capture_standard_paths(
            &provider,
            &ContextCaptureRequest {
                foreground_hwnd: 1,
                foreground_pid: 42,
                target: "target".into(),
            },
        );
        assert_eq!(result, success);
        assert_eq!(provider.calls.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn standard_paths_preserve_no_selection_and_error() {
        for status in [ContextStatus::NoSelection, ContextStatus::Error] {
            let provider = FakeProvider {
                focused: Some((42, 0)),
                hwnd: None,
                results: vec![ContextCaptureSnapshot::empty(status)],
                calls: AtomicUsize::new(0),
                hwnd_calls: AtomicUsize::new(0),
            };
            let result = capture_standard_paths(
                &provider,
                &ContextCaptureRequest {
                    foreground_hwnd: 1,
                    foreground_pid: 42,
                    target: "target".into(),
                },
            );
            assert_eq!(result.status, status);
        }
    }

    #[test]
    fn unavailable_and_timed_out_services_return_empty_context() {
        let request = ContextCaptureRequest {
            foreground_hwnd: 1,
            foreground_pid: 42,
            target: "target".into(),
        };
        let unavailable = UiaContextService { sender: None };
        assert_eq!(
            unavailable
                .capture(request.clone(), Duration::from_millis(1))
                .status,
            ContextStatus::Error
        );

        let (sender, receiver) = mpsc::sync_channel(1);
        let service = UiaContextService {
            sender: Some(sender),
        };
        let blocker = thread::spawn(move || {
            let _: WorkerRequest = receiver.recv().unwrap();
            thread::sleep(Duration::from_millis(20));
        });
        assert_eq!(
            service.capture(request, Duration::from_millis(1)).status,
            ContextStatus::Timeout
        );
        blocker.join().unwrap();
    }

    #[test]
    fn focused_success_does_not_touch_hwnd_fallback() {
        let success =
            context_snapshot_from_text("target", "focused target", ContextUnit::Line).unwrap();
        let provider = FakeProvider {
            focused: Some((42, 0)),
            hwnd: Some((42, 0)),
            results: vec![success],
            calls: AtomicUsize::new(0),
            hwnd_calls: AtomicUsize::new(0),
        };
        let result = capture_standard_paths(
            &provider,
            &ContextCaptureRequest {
                foreground_hwnd: 1,
                foreground_pid: 42,
                target: "target".into(),
            },
        );
        assert_eq!(result.status, ContextStatus::Success);
        assert_eq!(provider.hwnd_calls.load(Ordering::SeqCst), 0);
    }
}
