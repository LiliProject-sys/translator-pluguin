use super::{
    any_modifier_pressed, CapturePlatform, ClipboardErrorStage, ClipboardFormatAvailability,
    ClipboardRead, ClipboardSnapshot, ClipboardStepState, ClipboardTestResult,
    ClipboardUnicodeDiagnostic, ForegroundWindow, GestureMetrics, MouseEventKind,
    OriginalClipboard, RawMouseEvent,
};
use std::{
    ffi::c_void,
    mem::size_of,
    sync::{
        atomic::{AtomicBool, AtomicU32, Ordering},
        mpsc::SyncSender,
        Arc, Mutex, OnceLock,
    },
    thread,
    time::Duration,
};
use windows::{
    core::PWSTR,
    Win32::{
        Foundation::{
            CloseHandle, GetLastError, GlobalFree, SetLastError, ERROR_SUCCESS, HANDLE, HGLOBAL,
            HINSTANCE, HWND, LPARAM, LRESULT, RECT, WPARAM,
        },
        System::{
            DataExchange::{
                CloseClipboard, CountClipboardFormats, EmptyClipboard, EnumClipboardFormats,
                GetClipboardData, GetClipboardSequenceNumber, IsClipboardFormatAvailable,
                OpenClipboard, SetClipboardData,
            },
            LibraryLoader::GetModuleHandleW,
            Memory::{GlobalAlloc, GlobalLock, GlobalSize, GlobalUnlock, GMEM_MOVEABLE},
            Threading::{
                GetCurrentThreadId, OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
                PROCESS_QUERY_LIMITED_INFORMATION,
            },
        },
        UI::{
            Input::KeyboardAndMouse::{
                GetAsyncKeyState, GetDoubleClickTime, SendInput, INPUT, INPUT_0, INPUT_KEYBOARD,
                KEYBDINPUT, KEYEVENTF_KEYUP, VK_C, VK_CONTROL, VK_LWIN, VK_MENU, VK_RWIN, VK_SHIFT,
            },
            WindowsAndMessaging::{
                CallNextHookEx, GetForegroundWindow, GetMessageW, GetSystemMetrics, GetWindowRect,
                GetWindowTextLengthW, GetWindowTextW, GetWindowThreadProcessId, PostThreadMessageW,
                SetWindowsHookExW, UnhookWindowsHookEx, MSG, MSLLHOOKSTRUCT, SM_CXDOUBLECLK,
                SM_CXDRAG, SM_CYDOUBLECLK, SM_CYDRAG, WH_MOUSE_LL, WM_LBUTTONDOWN, WM_LBUTTONUP,
                WM_QUIT,
            },
        },
    },
};

// Win32 CF_UNICODETEXT. Defining the stable platform constant locally avoids enabling all OLE APIs.
const CF_UNICODETEXT: u32 = 13;
const CF_TEXT: u32 = 1;
const CF_OEMTEXT: u32 = 7;
const CF_LOCALE: u32 = 16;
const CLIPBOARD_OPEN_RETRIES: usize = 10;
const CLIPBOARD_RETRY_DELAY: Duration = Duration::from_millis(10);

static HOOK_SENDER: OnceLock<Mutex<Option<SyncSender<RawMouseEvent>>>> = OnceLock::new();

fn is_plain_text_format(format: u32) -> bool {
    matches!(format, CF_TEXT | CF_OEMTEXT | CF_UNICODETEXT | CF_LOCALE)
}

fn formats_are_plain_text(formats: &[u32]) -> bool {
    !formats.is_empty() && formats.iter().copied().all(is_plain_text_format)
}

fn clipboard_contains_only_plain_text_formats() -> bool {
    let mut previous = 0;
    let mut formats = Vec::new();
    loop {
        unsafe { SetLastError(ERROR_SUCCESS) };
        let format = unsafe { EnumClipboardFormats(previous) };
        if format == 0 {
            return unsafe { GetLastError() } == ERROR_SUCCESS && formats_are_plain_text(&formats);
        }
        formats.push(format);
        previous = format;
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum UnicodeApiError {
    GetData(u32),
    GlobalLock(u32),
    Other(u32),
}

struct ClipboardUnicodeOutcome {
    diagnostic: ClipboardUnicodeDiagnostic,
    text: Option<String>,
}

fn failed_unicode_diagnostic(
    format_available: ClipboardFormatAvailability,
    get_data_state: ClipboardStepState,
    global_lock_state: ClipboardStepState,
    error_stage: ClipboardErrorStage,
    reason_code: &str,
    last_error: u32,
) -> ClipboardUnicodeOutcome {
    ClipboardUnicodeOutcome {
        diagnostic: ClipboardUnicodeDiagnostic {
            format_available,
            get_data_state,
            global_lock_state,
            result: ClipboardTestResult::Failed,
            error_stage,
            reason_code: reason_code.into(),
            last_error,
            ..Default::default()
        },
        text: None,
    }
}

fn read_unicode_core<F>(
    format_available: Result<bool, u32>,
    get_and_copy: F,
) -> ClipboardUnicodeOutcome
where
    F: FnOnce() -> Result<Vec<u16>, UnicodeApiError>,
{
    match format_available {
        Err(error) => {
            return failed_unicode_diagnostic(
                ClipboardFormatAvailability::Error,
                ClipboardStepState::NotAttempted,
                ClipboardStepState::NotAttempted,
                ClipboardErrorStage::FormatUnavailable,
                "clipboard_format_unavailable",
                error,
            );
        }
        Ok(false) => {
            return failed_unicode_diagnostic(
                ClipboardFormatAvailability::No,
                ClipboardStepState::NotAttempted,
                ClipboardStepState::NotAttempted,
                ClipboardErrorStage::FormatUnavailable,
                "clipboard_format_unavailable",
                0,
            );
        }
        Ok(true) => {}
    }

    let utf16 = match get_and_copy() {
        Ok(values) => values,
        Err(UnicodeApiError::GetData(error)) => {
            return failed_unicode_diagnostic(
                ClipboardFormatAvailability::Yes,
                ClipboardStepState::Failed,
                ClipboardStepState::NotAttempted,
                ClipboardErrorStage::GetClipboardData,
                "clipboard_get_data_failed",
                error,
            );
        }
        Err(UnicodeApiError::GlobalLock(error)) => {
            return failed_unicode_diagnostic(
                ClipboardFormatAvailability::Yes,
                ClipboardStepState::Success,
                ClipboardStepState::Failed,
                ClipboardErrorStage::GlobalLock,
                "clipboard_global_lock_failed",
                error,
            );
        }
        Err(UnicodeApiError::Other(error)) => {
            return failed_unicode_diagnostic(
                ClipboardFormatAvailability::Yes,
                ClipboardStepState::Success,
                ClipboardStepState::Success,
                ClipboardErrorStage::Other,
                "clipboard_other_failed",
                error,
            );
        }
    };

    let Some(length) = utf16.iter().position(|value| *value == 0) else {
        return failed_unicode_diagnostic(
            ClipboardFormatAvailability::Yes,
            ClipboardStepState::Success,
            ClipboardStepState::Success,
            ClipboardErrorStage::DecodeUtf16,
            "clipboard_utf16_decode_failed",
            0,
        );
    };
    let text = match String::from_utf16(&utf16[..length]) {
        Ok(text) => text,
        Err(_) => {
            return failed_unicode_diagnostic(
                ClipboardFormatAvailability::Yes,
                ClipboardStepState::Success,
                ClipboardStepState::Success,
                ClipboardErrorStage::DecodeUtf16,
                "clipboard_utf16_decode_failed",
                0,
            );
        }
    };
    if text.is_empty() {
        let mut outcome = failed_unicode_diagnostic(
            ClipboardFormatAvailability::Yes,
            ClipboardStepState::Success,
            ClipboardStepState::Success,
            ClipboardErrorStage::EmptyText,
            "clipboard_empty_text",
            0,
        );
        outcome.text = Some(String::new());
        return outcome;
    }
    let character_count = text.chars().count();
    ClipboardUnicodeOutcome {
        diagnostic: ClipboardUnicodeDiagnostic {
            format_available: ClipboardFormatAvailability::Yes,
            get_data_state: ClipboardStepState::Success,
            global_lock_state: ClipboardStepState::Success,
            character_count,
            result: ClipboardTestResult::Success,
            error_stage: ClipboardErrorStage::None,
            reason_code: String::new(),
            last_error: 0,
            text_preview: crate::app_state::target_preview(&text),
        },
        text: Some(text),
    }
}

pub struct Win32CapturePlatform {
    owner_hwnd: isize,
}

impl Win32CapturePlatform {
    pub fn new(owner_hwnd: isize) -> Self {
        Self { owner_hwnd }
    }

    fn owner(&self) -> HWND {
        HWND(self.owner_hwnd as *mut c_void)
    }

    fn open_clipboard_with_error(&self) -> Result<ClipboardGuard, u32> {
        let mut final_error = 0;
        for _ in 0..CLIPBOARD_OPEN_RETRIES {
            unsafe { SetLastError(ERROR_SUCCESS) };
            if unsafe { OpenClipboard(Some(self.owner())) }.is_ok() {
                return Ok(ClipboardGuard);
            }
            final_error = unsafe { GetLastError() }.0;
            thread::sleep(CLIPBOARD_RETRY_DELAY);
        }
        Err(final_error)
    }

    fn open_clipboard(&self) -> Result<ClipboardGuard, String> {
        self.open_clipboard_with_error()
            .map_err(|_| "clipboard-open-failed".into())
    }

    fn read_unicode_while_open(&self) -> ClipboardUnicodeOutcome {
        unsafe { SetLastError(ERROR_SUCCESS) };
        let format_available = match unsafe { IsClipboardFormatAvailable(CF_UNICODETEXT) } {
            Ok(()) => Ok(true),
            Err(_) => {
                let error = unsafe { GetLastError() }.0;
                if error == 0 {
                    Ok(false)
                } else {
                    Err(error)
                }
            }
        };
        read_unicode_core(format_available, || {
            unsafe { SetLastError(ERROR_SUCCESS) };
            let handle = unsafe { GetClipboardData(CF_UNICODETEXT) }
                .map_err(|_| UnicodeApiError::GetData(unsafe { GetLastError() }.0))?;
            let memory = HGLOBAL(handle.0);
            unsafe { SetLastError(ERROR_SUCCESS) };
            let pointer = unsafe { GlobalLock(memory) } as *const u16;
            if pointer.is_null() {
                return Err(UnicodeApiError::GlobalLock(unsafe { GetLastError() }.0));
            }
            unsafe { SetLastError(ERROR_SUCCESS) };
            let byte_size = unsafe { GlobalSize(memory) };
            let size_error = unsafe { GetLastError() }.0;
            let capacity = byte_size / size_of::<u16>();
            if capacity == 0 {
                let _ = unsafe { GlobalUnlock(memory) };
                return Err(UnicodeApiError::Other(size_error));
            }
            let values = unsafe { std::slice::from_raw_parts(pointer, capacity) }.to_vec();
            let _ = unsafe { GlobalUnlock(memory) };
            Ok(values)
        })
    }

    pub fn read_current_unicode_diagnostic(&self) -> ClipboardUnicodeDiagnostic {
        let guard = match self.open_clipboard_with_error() {
            Ok(guard) => guard,
            Err(error) => {
                return failed_unicode_diagnostic(
                    ClipboardFormatAvailability::Error,
                    ClipboardStepState::NotAttempted,
                    ClipboardStepState::NotAttempted,
                    ClipboardErrorStage::OpenClipboard,
                    "clipboard_open_failed",
                    error,
                )
                .diagnostic;
            }
        };
        let outcome = self.read_unicode_while_open();
        drop(guard);
        outcome.diagnostic
    }

    fn put_unicode_while_open(&self, text: &str) -> Result<(), (&'static str, bool)> {
        let mut utf16: Vec<u16> = text.encode_utf16().collect();
        utf16.push(0);
        let byte_count = utf16.len() * size_of::<u16>();
        let memory = unsafe { GlobalAlloc(GMEM_MOVEABLE, byte_count) }
            .map_err(|_| ("clipboard-allocate-failed", false))?;
        let pointer = unsafe { GlobalLock(memory) } as *mut u16;
        if pointer.is_null() {
            let _ = unsafe { GlobalFree(Some(memory)) };
            return Err(("clipboard-lock-failed", false));
        }
        unsafe { std::ptr::copy_nonoverlapping(utf16.as_ptr(), pointer, utf16.len()) };
        let _ = unsafe { GlobalUnlock(memory) };
        if unsafe { EmptyClipboard() }.is_err() {
            let _ = unsafe { GlobalFree(Some(memory)) };
            return Err(("clipboard-empty-failed", false));
        }
        match unsafe { SetClipboardData(CF_UNICODETEXT, Some(HANDLE(memory.0))) } {
            Ok(_) => Ok(()),
            Err(_) => {
                let _ = unsafe { GlobalFree(Some(memory)) };
                Err(("clipboard-set-unicode-failed", true))
            }
        }
    }
}

struct ClipboardGuard;

impl Drop for ClipboardGuard {
    fn drop(&mut self) {
        let _ = unsafe { CloseClipboard() };
    }
}

impl CapturePlatform for Win32CapturePlatform {
    fn foreground(&self) -> Result<ForegroundWindow, String> {
        foreground_window()
    }

    fn snapshot_clipboard(&self) -> Result<ClipboardSnapshot, String> {
        let sequence_before = unsafe { GetClipboardSequenceNumber() };
        let Ok(guard) = self.open_clipboard() else {
            return Ok(ClipboardSnapshot {
                safe_backup: None,
                sequence: unsafe { GetClipboardSequenceNumber() },
            });
        };
        unsafe { SetLastError(ERROR_SUCCESS) };
        let count = unsafe { CountClipboardFormats() };
        let count_succeeded = count != 0 || unsafe { GetLastError() } == ERROR_SUCCESS;
        let safe_backup = if count_succeeded && count == 0 {
            Some(OriginalClipboard::Empty)
        } else if count_succeeded && clipboard_contains_only_plain_text_formats() {
            let outcome = self.read_unicode_while_open();
            outcome.text.map(OriginalClipboard::Unicode)
        } else {
            None
        };
        drop(guard);
        let sequence = unsafe { GetClipboardSequenceNumber() };
        Ok(ClipboardSnapshot {
            safe_backup: (sequence_before == sequence)
                .then_some(safe_backup)
                .flatten(),
            sequence,
        })
    }

    fn modifiers_active(&self) -> bool {
        any_modifier_pressed(
            [VK_CONTROL, VK_SHIFT, VK_MENU, VK_LWIN, VK_RWIN]
                .map(|key| unsafe { GetAsyncKeyState(key.0 as i32) } as u16 & 0x8000 != 0),
        )
    }

    fn send_ctrl_c(&self) -> Result<(), String> {
        fn key_input(
            key: windows::Win32::UI::Input::KeyboardAndMouse::VIRTUAL_KEY,
            up: bool,
        ) -> INPUT {
            INPUT {
                r#type: INPUT_KEYBOARD,
                Anonymous: INPUT_0 {
                    ki: KEYBDINPUT {
                        wVk: key,
                        dwFlags: if up {
                            KEYEVENTF_KEYUP
                        } else {
                            Default::default()
                        },
                        ..Default::default()
                    },
                },
            }
        }
        let inputs = [
            key_input(VK_CONTROL, false),
            key_input(VK_C, false),
            key_input(VK_C, true),
            key_input(VK_CONTROL, true),
        ];
        let sent = unsafe { SendInput(&inputs, size_of::<INPUT>() as i32) };
        (sent == inputs.len() as u32)
            .then_some(())
            .ok_or_else(|| "send-input-incomplete".into())
    }

    fn clipboard_sequence(&self) -> u32 {
        unsafe { GetClipboardSequenceNumber() }
    }

    fn read_unicode(&self) -> Result<ClipboardRead, String> {
        let guard = self.open_clipboard()?;
        let outcome = self.read_unicode_while_open();
        let sequence = unsafe { GetClipboardSequenceNumber() };
        drop(guard);
        if let Some(text) = outcome.text {
            Ok(ClipboardRead {
                text: Some(text),
                sequence,
            })
        } else if outcome.diagnostic.format_available == ClipboardFormatAvailability::No {
            Ok(ClipboardRead {
                text: None,
                sequence,
            })
        } else {
            Err(outcome.diagnostic.reason_code)
        }
    }

    fn restore_if_owned(
        &self,
        expected_sequence: u32,
        expected_text: Option<&str>,
        original: &OriginalClipboard,
    ) -> Result<bool, String> {
        if unsafe { GetClipboardSequenceNumber() } != expected_sequence {
            return Ok(false);
        }
        let guard = self.open_clipboard()?;
        if unsafe { GetClipboardSequenceNumber() } != expected_sequence {
            return Ok(false);
        }
        if let Some(expected) = expected_text {
            match self.read_unicode_while_open().text {
                Some(actual) if actual == expected => {}
                _ => return Ok(false),
            }
        }
        match original {
            OriginalClipboard::Empty => {
                unsafe { EmptyClipboard() }.map_err(|_| "clipboard-restore-empty-failed")?;
            }
            OriginalClipboard::Unicode(text) => self
                .put_unicode_while_open(text)
                .map_err(|(code, _)| code.to_owned())?,
        }
        drop(guard);
        Ok(true)
    }

    fn sleep(&self, duration: Duration) {
        thread::sleep(duration);
    }
}

pub fn foreground_window() -> Result<ForegroundWindow, String> {
    let hwnd = unsafe { GetForegroundWindow() };
    if hwnd.0.is_null() {
        return Err("foreground-window-missing".into());
    }
    let mut pid = 0u32;
    unsafe { GetWindowThreadProcessId(hwnd, Some(&mut pid)) };
    if pid == 0 {
        return Err("foreground-pid-missing".into());
    }
    let title_length = unsafe { GetWindowTextLengthW(hwnd) }.max(0) as usize;
    let mut title_buffer = vec![0u16; title_length.saturating_add(1).min(1024)];
    let copied = if title_buffer.is_empty() {
        0
    } else {
        unsafe { GetWindowTextW(hwnd, &mut title_buffer) }.max(0) as usize
    };
    Ok(ForegroundWindow {
        hwnd: hwnd.0 as isize,
        pid,
        title: String::from_utf16_lossy(&title_buffer[..copied]),
        app_name: process_app_name(pid),
    })
}

fn process_app_name(pid: u32) -> String {
    let Ok(process) = (unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) })
    else {
        return String::new();
    };
    let mut buffer = vec![0u16; 32768];
    let mut size = buffer.len() as u32;
    let queried = unsafe {
        QueryFullProcessImageNameW(
            process,
            PROCESS_NAME_WIN32,
            PWSTR(buffer.as_mut_ptr()),
            &mut size,
        )
    };
    let _ = unsafe { CloseHandle(process) };
    if queried.is_err() || size == 0 {
        return String::new();
    }
    let path = String::from_utf16_lossy(&buffer[..size as usize]);
    let executable = path.rsplit(['\\', '/']).next().unwrap_or_default();
    let normalized = executable.to_ascii_lowercase();
    match normalized.as_str() {
        "chrome.exe" => "Google Chrome".into(),
        "msedge.exe" => "Microsoft Edge".into(),
        "winword.exe" => "Microsoft Word".into(),
        "notepad.exe" => "Notepad".into(),
        "wps.exe" | "wpsoffice.exe" => "WPS".into(),
        _ => executable
            .strip_suffix(".exe")
            .or_else(|| executable.strip_suffix(".EXE"))
            .unwrap_or(executable)
            .to_owned(),
    }
}

pub fn window_bounds(hwnd: isize) -> Result<super::WindowBounds, String> {
    let mut rect = RECT::default();
    unsafe { GetWindowRect(HWND(hwnd as *mut c_void), &mut rect) }
        .map_err(|_| "window-rect-unavailable".to_owned())?;
    Ok(super::WindowBounds {
        left: rect.left,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
    })
}

pub fn gesture_metrics() -> GestureMetrics {
    GestureMetrics {
        drag_x: unsafe { GetSystemMetrics(SM_CXDRAG) },
        drag_y: unsafe { GetSystemMetrics(SM_CYDRAG) },
        double_click_x: unsafe { GetSystemMetrics(SM_CXDOUBLECLK) },
        double_click_y: unsafe { GetSystemMetrics(SM_CYDOUBLECLK) },
        double_click_ms: unsafe { GetDoubleClickTime() },
    }
}

pub fn stop_hook_thread(thread_id: u32) {
    if thread_id != 0 {
        let _ = unsafe { PostThreadMessageW(thread_id, WM_QUIT, WPARAM(0), LPARAM(0)) };
    }
}

pub fn run_mouse_hook(
    sender: SyncSender<RawMouseEvent>,
    installed: SyncSender<Result<(), String>>,
    stopped: Arc<AtomicBool>,
    thread_id: Arc<AtomicU32>,
) {
    let sender_slot = HOOK_SENDER.get_or_init(|| Mutex::new(None));
    if let Ok(mut slot) = sender_slot.lock() {
        *slot = Some(sender);
    } else {
        let _ = installed.send(Err("hook-sender-lock-failed".into()));
        return;
    }

    thread_id.store(unsafe { GetCurrentThreadId() }, Ordering::SeqCst);
    let module = match unsafe { GetModuleHandleW(None) } {
        Ok(module) => module,
        Err(_) => {
            let _ = installed.send(Err("hook-module-handle-failed".into()));
            if let Ok(mut slot) = sender_slot.lock() {
                *slot = None;
            }
            return;
        }
    };
    let hook = match unsafe {
        SetWindowsHookExW(
            WH_MOUSE_LL,
            Some(mouse_hook_callback),
            Some(HINSTANCE(module.0)),
            0,
        )
    } {
        Ok(hook) => hook,
        Err(error) => {
            let _ = installed.send(Err(format!("hook-install-failed: {}", error.code().0)));
            if let Ok(mut slot) = sender_slot.lock() {
                *slot = None;
            }
            return;
        }
    };
    let _ = installed.send(Ok(()));

    let mut message = MSG::default();
    while super::processing_is_running(&stopped)
        && unsafe { GetMessageW(&mut message, None, 0, 0) }.0 > 0
    {}
    let _ = unsafe { UnhookWindowsHookEx(hook) };
    if let Ok(mut slot) = sender_slot.lock() {
        *slot = None;
    }
}

unsafe extern "system" fn mouse_hook_callback(
    code: i32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    if code >= 0 {
        let kind = match wparam.0 as u32 {
            WM_LBUTTONDOWN => Some(MouseEventKind::LeftDown),
            WM_LBUTTONUP => Some(MouseEventKind::LeftUp),
            _ => None,
        };
        if let Some(kind) = kind {
            let info = &*(lparam.0 as *const MSLLHOOKSTRUCT);
            if let Some(sender_slot) = HOOK_SENDER.get() {
                if let Ok(slot) = sender_slot.try_lock() {
                    if let Some(sender) = slot.as_ref() {
                        let _ = sender.try_send(RawMouseEvent {
                            kind,
                            x: info.pt.x,
                            y: info.pt.y,
                            time: info.time,
                        });
                    }
                }
            }
        }
    }
    CallNextHookEx(None, code, wparam, lparam)
}

#[cfg(test)]
mod unicode_reader_tests {
    use super::*;

    fn encoded(text: &str) -> Vec<u16> {
        text.encode_utf16().chain(std::iter::once(0)).collect()
    }

    #[test]
    fn shared_unicode_reader_reports_success_and_bounded_preview() {
        let outcome = read_unicode_core(Ok(true), || Ok(encoded("clipboard-base")));
        assert_eq!(outcome.text.as_deref(), Some("clipboard-base"));
        assert_eq!(outcome.diagnostic.result, ClipboardTestResult::Success);
        assert_eq!(outcome.diagnostic.character_count, 14);
        assert_eq!(outcome.diagnostic.text_preview, "clipboard-base");

        let long = "a".repeat(450);
        let outcome = read_unicode_core(Ok(true), || Ok(encoded(&long)));
        assert_eq!(outcome.diagnostic.character_count, 450);
        assert_eq!(outcome.diagnostic.text_preview.chars().count(), 400);
        assert!(outcome.diagnostic.text_preview.ends_with('…'));
    }

    #[test]
    fn shared_unicode_reader_distinguishes_format_get_data_and_lock_failures() {
        let unavailable = read_unicode_core(Ok(false), || Ok(Vec::new()));
        assert_eq!(
            unavailable.diagnostic.reason_code,
            "clipboard_format_unavailable"
        );
        assert_eq!(
            unavailable.diagnostic.format_available,
            ClipboardFormatAvailability::No
        );

        let get_data = read_unicode_core(Ok(true), || Err(UnicodeApiError::GetData(5)));
        assert_eq!(get_data.diagnostic.reason_code, "clipboard_get_data_failed");
        assert_eq!(get_data.diagnostic.last_error, 5);
        assert_eq!(
            get_data.diagnostic.get_data_state,
            ClipboardStepState::Failed
        );

        let lock = read_unicode_core(Ok(true), || Err(UnicodeApiError::GlobalLock(6)));
        assert_eq!(lock.diagnostic.reason_code, "clipboard_global_lock_failed");
        assert_eq!(lock.diagnostic.last_error, 6);
        assert_eq!(lock.diagnostic.get_data_state, ClipboardStepState::Success);
        assert_eq!(
            lock.diagnostic.global_lock_state,
            ClipboardStepState::Failed
        );
    }

    #[test]
    fn shared_unicode_reader_distinguishes_empty_and_invalid_utf16() {
        let empty = read_unicode_core(Ok(true), || Ok(vec![0]));
        assert_eq!(empty.diagnostic.reason_code, "clipboard_empty_text");
        assert_eq!(empty.text.as_deref(), Some(""));

        let invalid = read_unicode_core(Ok(true), || Ok(vec![0xD800, 0]));
        assert_eq!(
            invalid.diagnostic.reason_code,
            "clipboard_utf16_decode_failed"
        );
        assert!(invalid.text.is_none());
    }

    #[test]
    fn safe_backup_format_filter_accepts_only_plain_text_formats() {
        for format in [CF_TEXT, CF_OEMTEXT, CF_UNICODETEXT, CF_LOCALE] {
            assert!(is_plain_text_format(format));
        }
        for format in [2, 8, 15, 0xC000] {
            assert!(!is_plain_text_format(format));
        }
        assert!(formats_are_plain_text(&[
            CF_UNICODETEXT,
            CF_TEXT,
            CF_LOCALE
        ]));
        assert!(!formats_are_plain_text(&[CF_UNICODETEXT, CF_TEXT, 0xC000]));
        assert!(!formats_are_plain_text(&[]));
    }
}
