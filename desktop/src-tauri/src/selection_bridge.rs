//! Host facts end here. Only semantic input enters the existing Quick worker.
use crate::{host_adapter::{CaptureStatus, OccurrenceIdentity, SelectionRuntimeState, SelectionSnapshot},
    selection::{normalize_target, target_filter_reason}};
use std::time::Instant;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TranslationInput {
    pub snapshot_id: String,
    pub target: String,
    pub context: String,
}

/// Local interaction metadata; never serialized into a Gateway request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QuickBinding {
    pub snapshot: SelectionSnapshot,
    pub mouse_x: i32,
    pub mouse_y: i32,
    pub capture_epoch: u64,
    pub ready_at: Instant,
}

pub fn build_translation_input(capture: &SelectionRuntimeState, current: bool)
    -> Result<TranslationInput, &'static str>
{
    if !current { return Err("stale_generation"); }
    if capture.status != CaptureStatus::Ok {
        return Err(match capture.status {
            CaptureStatus::Unstable => "capture_unstable",
            CaptureStatus::Indeterminate | CaptureStatus::NotApplicable => "surface_indeterminate",
            CaptureStatus::NoSelection => "no_selection",
            _ => "helper_error",
        });
    }
    let snapshot = capture.snapshot.as_ref().ok_or("no_selection")?;
    let target = normalize_target(snapshot.target_text()).ok_or("empty_target")?;
    if let Some(reason) = target_filter_reason(&target, current, false) { return Err(reason); }
    if target.chars().count() > 5000 { return Err("target_too_long"); }
    if snapshot.adapter_id() == "wps-pdf" {
        if !matches!(snapshot.occurrence(), OccurrenceIdentity::WpsPdfRange { start_index, end_index, .. } if start_index <= end_index) {
            return Err("resolver_unresolved");
        }
        if snapshot.context_quality() != "exact" || snapshot.context_text().trim().is_empty() {
            return Err("context_not_exact");
        }
    }
    Ok(TranslationInput { snapshot_id: snapshot.id().into(), target,
        context: snapshot.context_text().into() })
}
