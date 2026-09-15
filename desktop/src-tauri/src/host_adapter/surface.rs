//! Minimal foreground/focus ancestry probe. No content or coordinate access.
use serde::Serialize;
use std::{ffi::c_void, path::Path};
type Handle = *mut c_void;
#[repr(C)]
#[derive(Default)]
struct Gui {
    size: u32, flags: u32, active: Handle, focus: Handle, capture: Handle,
    menu: Handle, move_size: Handle, caret: Handle, rect: [i32; 4],
}
#[link(name = "user32")]
unsafe extern "system" {
    fn GetForegroundWindow() -> Handle;
    fn GetWindowThreadProcessId(h: Handle, pid: *mut u32) -> u32;
    fn GetGUIThreadInfo(tid: u32, gui: *mut Gui) -> i32;
    fn GetParent(h: Handle) -> Handle;
    fn IsWindowVisible(h: Handle) -> i32;
    fn GetClassNameW(h: Handle, buf: *mut u16, size: i32) -> i32;
}
#[link(name = "kernel32")]
unsafe extern "system" {
    fn OpenProcess(access: u32, inherit: i32, pid: u32) -> Handle;
    fn QueryFullProcessImageNameW(h: Handle, flags: u32, buf: *mut u16, size: *mut u32) -> i32;
    fn CloseHandle(h: Handle) -> i32;
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SurfaceKind { Pdf, Generic, Indeterminate }
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Surface {
    #[serde(skip)]
    pub kind: SurfaceKind,
    pub token: String,
}
fn identity(h: Handle) -> (u32, u32, String, String) {
    unsafe {
        let mut pid = 0;
        let tid = GetWindowThreadProcessId(h, &mut pid);
        let mut cls = [0; 129];
        let n = GetClassNameW(h, cls.as_mut_ptr(), cls.len() as i32).max(0) as usize;
        let mut path = [0; 32768];
        let mut size = path.len() as u32;
        let process = OpenProcess(0x1000, 0, pid);
        let image = if !process.is_null() {
            let ok = QueryFullProcessImageNameW(process, 0, path.as_mut_ptr(), &mut size);
            CloseHandle(process);
            if ok != 0 { String::from_utf16_lossy(&path[..size as usize]) } else { String::new() }
        } else { String::new() };
        (pid, tid, image, String::from_utf16_lossy(&cls[..n]))
    }
}
pub fn classify(fg: &str, focus: &str, class: &str, valid: bool) -> SurfaceKind {
    let name = |p: &str| p.rsplit(['\\', '/']).next().unwrap_or("").to_ascii_lowercase();
    if fg.is_empty() { return SurfaceKind::Indeterminate; }
    if !matches!(name(fg).as_str(), "wps.exe" | "wpsoffice.exe" | "wpspdf.exe") {
        return SurfaceKind::Generic;
    }
    if !valid || !Path::new(fg).parent().zip(Path::new(focus).parent())
        .is_some_and(|(a,b)| a.to_string_lossy().eq_ignore_ascii_case(&b.to_string_lossy())) {
        return SurfaceKind::Indeterminate;
    }
    match (name(focus).as_str(), class) {
        ("wpspdf.exe", "Qt5QWindowIcon") => SurfaceKind::Pdf,
        ("wps.exe", "_WwG") => SurfaceKind::Generic,
        _ => SurfaceKind::Indeterminate,
    }
}
pub fn probe() -> Surface {
    unsafe {
        let fg = GetForegroundWindow();
        let (pid, tid, image, _) = identity(fg);
        let mut gui = Gui { size: std::mem::size_of::<Gui>() as u32, ..Default::default() };
        let ok = tid != 0 && GetGUIThreadInfo(tid, &mut gui) != 0;
        let (fp, ft, fi, fc) = identity(gui.focus);
        let mut chain = Vec::new();
        let mut h = gui.focus;
        let mut belongs = false;
        for _ in 0..16 {
            if h.is_null() || chain.contains(&(h as usize)) { break; }
            chain.push(h as usize);
            if h == fg { belongs = true; break; }
            h = GetParent(h);
        }
        let valid = ok && belongs && gui.focus != fg && IsWindowVisible(gui.focus) != 0;
        Surface {
            kind: classify(&image, &fi, &fc, valid),
            token: format!("{}:{pid}:{}:{fp}:{ft}", fg as usize, gui.focus as usize),
        }
    }
}
