//! Host snapshots are immutable facts; legacy popup metadata remains untouched.
pub mod surface;
mod transport;
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, time::{SystemTime, UNIX_EPOCH}};
use surface::{Surface, SurfaceKind};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
pub enum OccurrenceIdentity {
    #[serde(rename_all = "camelCase")]
    WpsPdfRange { page_index: u32, start_index: u32, end_index: u32 },
    Unavailable,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Host { adapter_id: String, app_kind: String }
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Target { text: String }
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Document { document_id: String, title: Option<String> }
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Context { text: String, source: String, quality: String }
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SelectionSnapshot {
    snapshot_id: String, captured_at: String, host: Host, target: Target,
    document: Document, occurrence: OccurrenceIdentity, context: Context,
}
impl SelectionSnapshot {
    pub fn id(&self) -> &str { &self.snapshot_id }
    pub fn adapter_id(&self) -> &str { &self.host.adapter_id }
    pub fn target_text(&self) -> &str { &self.target.text }
    pub fn context_text(&self) -> &str { &self.context.text }
    pub fn context_quality(&self) -> &str { &self.context.quality }
    pub fn occurrence(&self) -> &OccurrenceIdentity { &self.occurrence }
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum CaptureStatus { Ok, NotApplicable, Indeterminate, NoSelection, Unstable, Error }
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SelectionRuntimeState {
    pub status: CaptureStatus,
    pub snapshot: Option<SelectionSnapshot>,
    pub reason: String,
    pub timing_ms: BTreeMap<String, u64>,
}
impl SelectionRuntimeState {
    pub fn empty(status: CaptureStatus, reason: &str) -> Self {
        Self { status, snapshot: None, reason: reason.into(), timing_ms: BTreeMap::new() }
    }
    pub fn target(&self) -> &str { self.snapshot.as_ref().map_or("", |s| s.target.text.as_str()) }
}
pub fn interaction_id(generation: u64) -> String {
    let time = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_nanos();
    format!("selection-{}-{time}-{generation}", std::process::id())
}
pub struct GenericWindowsAdapter;
impl GenericWindowsAdapter {
    // Keep the existing transaction, filters, UIA and translation lifecycle intact.
    pub fn capture<T>(existing: impl FnOnce() -> T) -> T { existing() }
    pub fn snapshot(id: String, target: &str, context: &str, source: &str) -> SelectionRuntimeState {
        SelectionRuntimeState {
            status: CaptureStatus::Ok, reason: "generic_existing_chain".into(), timing_ms: BTreeMap::new(),
            snapshot: Some(SelectionSnapshot {
                snapshot_id: id.clone(), captured_at: SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis().to_string(),
                host: Host { adapter_id: "generic-windows".into(), app_kind: source.into() },
                target: Target { text: target.into() },
                document: Document { document_id: format!("unavailable-{id}"), title: None },
                occurrence: OccurrenceIdentity::Unavailable,
                context: Context { text: context.into(), source: "uia-or-unavailable".into(), quality: "unverified".into() },
            }),
        }
    }
}
#[derive(Default)]
pub struct WpsPdfAdapter { helper: transport::Helper }
#[derive(Default)]
pub struct HostAdapterRegistry { wps: WpsPdfAdapter }
fn route(kind: SurfaceKind, wps: impl FnOnce() -> SelectionRuntimeState) -> Option<SelectionRuntimeState> {
    match kind {
        SurfaceKind::Generic => None,
        SurfaceKind::Indeterminate => Some(SelectionRuntimeState::empty(CaptureStatus::Indeterminate, "surface_unknown")),
        SurfaceKind::Pdf => Some(wps()),
    }
}
impl HostAdapterRegistry {
    // Only Generic is represented by None; all WPS outcomes are terminal.
    pub fn capture(&mut self, surface: &Surface, id: &str) -> Option<SelectionRuntimeState> {
        route(surface.kind, || self.wps.helper.capture(id, &surface.token))
    }
}
pub(super) fn decode(line: &str, id: &str) -> Result<SelectionRuntimeState, ()> {
    let r: SelectionRuntimeState = serde_json::from_str(line).map_err(|_| ())?;
    if r.reason.len() > 80 || !r.reason.bytes().all(|c| c.is_ascii_lowercase() || c == b'_') { return Err(()); }
    if r.status == CaptureStatus::Ok {
        let s = r.snapshot.as_ref().ok_or(())?;
        if s.snapshot_id != id || s.host.adapter_id != "wps-pdf" || s.host.app_kind != "wps-pdf"
            || s.target.text.is_empty() || s.target.text.chars().count() > 500
            || s.context.text.is_empty() || s.context.text.chars().count() > 2000
            || s.document.document_id.len() != 64 || !s.document.document_id.bytes().all(|c| c.is_ascii_hexdigit())
            || s.document.title.as_ref().is_some_and(|t| t.len()>512 || t.contains(['\\','/']))
            || !matches!((&*s.context.source, &*s.context.quality), ("pymupdf-sentence", "exact") | ("wps-page-text", "exact-location-fallback"))
            || !matches!(s.occurrence, OccurrenceIdentity::WpsPdfRange{start_index,end_index,..} if start_index <= end_index)
        { return Err(()); }
    } else if r.snapshot.is_some() { return Err(()); }
    Ok(r)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn routing_precedence_and_terminal_failures_never_authorize_clipboard() {
        for status in [CaptureStatus::Ok,CaptureStatus::NoSelection,CaptureStatus::Error,CaptureStatus::Unstable,CaptureStatus::NotApplicable] {
            let mut calls=0;
            let r=route(SurfaceKind::Pdf,||{calls+=1;SelectionRuntimeState::empty(status,"test")});
            assert!(r.is_some());assert_eq!(calls,1);
        }
        assert!(route(SurfaceKind::Generic,||panic!("must not call WPS")).is_none());
        assert_eq!(route(SurfaceKind::Indeterminate,||panic!("must not call helper")).unwrap().status,CaptureStatus::Indeterminate);
        let mut clipboard=0;
        if route(SurfaceKind::Generic,||unreachable!()).is_none(){GenericWindowsAdapter::capture(||clipboard+=1);}
        assert_eq!(clipboard,1);
    }
    #[test]
    fn native_surface_classification_is_conservative() {
        use surface::classify;
        let fg=r"D:\office6\wps.exe";
        assert_eq!(classify(r"D:\chrome.exe","","",false),SurfaceKind::Generic);
        assert_eq!(classify(fg,r"D:\office6\wps.exe","_WwG",true),SurfaceKind::Generic);
        assert_eq!(classify(fg,r"D:\office6\wpspdf.exe","Qt5QWindowIcon",true),SurfaceKind::Pdf);
        for cls in ["Edit","Toolbar","", "Qt5QWindowIcon"] {
            assert_eq!(classify(fg,r"D:\office6\wpspdf.exe",cls,false),SurfaceKind::Indeterminate);
        }
        assert_eq!(classify(fg,r"D:\other\wpspdf.exe","Qt5QWindowIcon",true),SurfaceKind::Indeterminate);
        assert_eq!(classify(fg,fg,"Edit",true),SurfaceKind::Indeterminate);
        assert_eq!(classify("","","",false),SurfaceKind::Indeterminate);
    }
    fn fixture(id:&str)->serde_json::Value {
        serde_json::json!({"status":"OK","reason":"resolved","timingMs":{"resolver":1},"snapshot":{
            "snapshotId":id,"capturedAt":"2026-09-14T08:00:00Z","host":{"adapterId":"wps-pdf","appKind":"wps-pdf"},
            "document":{"documentId":"a".repeat(64),"title":"test.pdf"},"target":{"text":"word"},
            "occurrence":{"kind":"wps-pdf-range","pageIndex":0,"startIndex":5,"endIndex":8},
            "context":{"text":"A word here.","source":"pymupdf-sentence","quality":"exact"}}})
    }
    #[test]
    fn tagged_snapshot_ids_and_immutable_copy_contract() {
        let a=interaction_id(1);let b=interaction_id(1);assert_ne!(a,b);
        let first=decode(&fixture(&a).to_string(),&a).unwrap();
        let second=decode(&fixture(&b).to_string(),&b).unwrap();
        assert_eq!(first.snapshot.as_ref().unwrap().occurrence,second.snapshot.as_ref().unwrap().occurrence);
        let mut runtime=first.clone();runtime.snapshot=None;
        assert!(first.snapshot.is_some());assert!(runtime.snapshot.is_none());
        assert!(decode(&fixture(&a).to_string(),&b).is_err());
    }
    #[test]
    fn malformed_response_and_false_exactness_fail_closed() {
        assert!(decode("not json","a").is_err());
        for field in ["snapshotId","host","target","context","document","occurrence"] {
            let mut v=fixture("a");v["snapshot"].as_object_mut().unwrap().remove(field);
            assert!(decode(&v.to_string(),"a").is_err());
        }
        let mut v=fixture("a");v["snapshot"]["occurrence"]["startIndex"]=10.into();assert!(decode(&v.to_string(),"a").is_err());
        v=fixture("a");v["snapshot"]["document"]["title"]=r"D:\private.pdf".into();assert!(decode(&v.to_string(),"a").is_err());
        v=fixture("a");v["status"]="ERROR".into();assert!(decode(&v.to_string(),"a").is_err());
        v=fixture("a");v["snapshot"]["context"]["source"]="wps-page-text".into();assert!(decode(&v.to_string(),"a").is_err());
        v["snapshot"]["context"]["quality"]="exact-location-fallback".into();assert!(decode(&v.to_string(),"a").is_ok());
    }
    #[test]
    fn snapshot_bridge_keeps_wps_before_clipboard_without_special_gateway() {
        let code=include_str!("../selection/mod.rs");
        let start=code.find("if let Some(mut host_capture)").unwrap();
        let end=code[start..].find("let result = crate::host_adapter::GenericWindowsAdapter").unwrap()+start;
        assert!(code[start..end].contains("continue;"));
        assert!(!code[start..end].contains("start_automatic_gateway_translation("));
        assert!(code[start..end].contains("submit_selection_snapshot("));
        let transport=include_str!("transport.rs");
        let helper=include_str!("../../../helpers/wps-pdf/Program.cs");
        for forbidden in ["../experiments", "mouseX", "mouseY", "bbox", "Application.Quit", "SendInput", "Clipboard"] {
            assert!(!transport.contains(forbidden));assert!(!helper.contains(forbidden));
        }
    }
}
