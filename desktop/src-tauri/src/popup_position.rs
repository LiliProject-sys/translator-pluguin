//! UI-only physical screen geometry. Never used to resolve text or build requests.
use crate::app_state::LatestGatewayTarget;
use serde::Serialize;
use std::{collections::BTreeMap, time::Instant};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct Point { pub x: i32, pub y: i32 }
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct Size { pub width: u32, pub height: u32 }
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct WorkArea { pub x: i32, pub y: i32, pub width: u32, pub height: u32 }
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Direction { RightBottom, LeftBottom, RightTop, LeftTop }
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Placement { pub position: Point, pub direction: Direction, pub clamped: bool, pub oversized: bool }

pub fn compute_popup_position(anchor: Option<Point>, size: Size, area: WorkArea, offset: u32)
    -> Result<Placement, &'static str>
{
    let a = anchor.ok_or("missing-anchor")?;
    if size.width == 0 || size.height == 0 { return Err("invalid-size"); }
    let (left, top) = (i64::from(area.x), i64::from(area.y));
    let (right, bottom) = (left + i64::from(area.width), top + i64::from(area.height));
    if area.width == 0 || area.height == 0 || right > i64::from(i32::MAX) || bottom > i64::from(i32::MAX) {
        return Err("invalid-work-area");
    }
    let (x, y, w, h, gap) = (i64::from(a.x), i64::from(a.y), i64::from(size.width), i64::from(size.height), i64::from(offset));
    // Zero and negative coordinates are valid on the virtual desktop.
    if x < left || x >= right || y < top || y >= bottom { return Err("anchor-outside-monitor"); }
    let flip_x = x + gap + w > right;
    let flip_y = y + gap + h > bottom;
    let px = if flip_x { x - gap - w } else { x + gap };
    let py = if flip_y { y - gap - h } else { y + gap };
    let final_x = px.clamp(left, (right - w).max(left));
    let final_y = py.clamp(top, (bottom - h).max(top));
    Ok(Placement {
        position: Point { x: final_x as i32, y: final_y as i32 },
        direction: match (flip_x, flip_y) {
            (false, false) => Direction::RightBottom, (true, false) => Direction::LeftBottom,
            (false, true) => Direction::RightTop, (true, true) => Direction::LeftTop,
        },
        clamped: px != final_x || py != final_y,
        oversized: size.width > area.width || size.height > area.height,
    })
}

/// Borderless popup preserves logical size when Windows changes its monitor DPI.
pub fn target_geometry(size: Size, current_scale: f64, target_scale: f64) -> Result<(Size, u32), &'static str> {
    if !current_scale.is_finite() || !target_scale.is_finite() || current_scale <= 0.0 || target_scale <= 0.0 {
        return Err("invalid-scale");
    }
    let width = (f64::from(size.width) / current_scale * target_scale).ceil();
    let height = (f64::from(size.height) / current_scale * target_scale).ceil();
    let offset = (16.0 * target_scale).round();
    if width < 1.0 || height < 1.0 || width > f64::from(i32::MAX) || height > f64::from(i32::MAX) || offset > f64::from(i32::MAX) {
        return Err("invalid-size");
    }
    Ok((Size { width: width as u32, height: height as u32 }, offset.max(1.0) as u32))
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PositionDiagnostic {
    pub position_mode: String,
    pub fallback_reason: Option<String>,
    pub anchor: Option<Point>,
    pub final_position: Option<Point>,
    pub placement_direction: Option<Direction>,
    pub work_area: Option<WorkArea>,
    pub popup_size: Option<Size>,
    pub offset_px: Option<u32>,
    pub clamped: bool,
    pub oversized: bool,
    pub submission_succeeded: bool,
    // Timings measure lookup/computation/command submission, not OS paint latency.
    pub timing_us: BTreeMap<String, u64>,
}

pub(crate) struct PreparedPosition { diagnostic: PositionDiagnostic, started: Instant }

/// All synchronous window/monitor getters run before the translation commit lock.
pub(crate) fn prepare(popup: &tauri::WebviewWindow, target: &LatestGatewayTarget) -> PreparedPosition {
    let started = Instant::now();
    let anchor = target.binding.as_ref().map(|b| Point { x: b.mouse_x, y: b.mouse_y });
    let mut d = PositionDiagnostic {
        position_mode: "center-fallback".into(), fallback_reason: None, anchor,
        final_position: None, placement_direction: None, work_area: None,
        popup_size: None, offset_px: None, clamped: false, oversized: false,
        submission_succeeded: false, timing_us: BTreeMap::new(),
    };
    d.timing_us.insert("anchorLookup".into(), started.elapsed().as_micros() as u64);
    let result = (|| -> Result<(), &'static str> {
        let anchor = anchor.ok_or("missing-anchor")?;
        let lookup = Instant::now();
        let monitor_result = popup.monitor_from_point(f64::from(anchor.x), f64::from(anchor.y));
        d.timing_us.insert("monitorLookup".into(), lookup.elapsed().as_micros() as u64);
        let monitor = monitor_result.map_err(|_| "monitor-lookup-failed")?.ok_or("monitor-not-found")?;
        let rect = monitor.work_area();
        let area = WorkArea { x: rect.position.x, y: rect.position.y, width: rect.size.width, height: rect.size.height };
        d.work_area = Some(area);
        let lookup = Instant::now();
        let size_result = popup.outer_size();
        let scale_result = popup.scale_factor();
        d.timing_us.insert("sizeAndScaleLookup".into(), lookup.elapsed().as_micros() as u64);
        let size = size_result.map_err(|_| "size-lookup-failed")?;
        let scale = scale_result.map_err(|_| "scale-lookup-failed")?;
        let compute = Instant::now();
        let (size, offset) = target_geometry(Size { width: size.width, height: size.height }, scale, monitor.scale_factor())?;
        let placement = compute_popup_position(Some(anchor), size, area, offset)?;
        d.timing_us.insert("compute".into(), compute.elapsed().as_micros() as u64);
        d.popup_size = Some(size);
        d.offset_px = Some(offset);
        d.final_position = Some(placement.position);
        d.placement_direction = Some(placement.direction);
        d.clamped = placement.clamped;
        d.oversized = placement.oversized;
        d.position_mode = "mouse-anchor".into();
        Ok(())
    })();
    if let Err(reason) = result { d.fallback_reason = Some(reason.into()); }
    PreparedPosition { diagnostic: d, started }
}

/// Called only inside the existing current snapshot + request gated initial show.
/// No getters, cursor reads, show, or content updates here.
pub(crate) fn apply(popup: &tauri::WebviewWindow, mut prepared: PreparedPosition) -> PositionDiagnostic {
    let submit = Instant::now();
    let d = &mut prepared.diagnostic;
    if d.position_mode == "mouse-anchor" {
        let p = d.final_position.expect("computed position");
        if popup.set_position(tauri::PhysicalPosition::new(p.x, p.y)).is_ok() {
            d.submission_succeeded = true;
        } else {
            d.position_mode = "center-fallback".into();
            d.fallback_reason = Some("set-position-failed".into());
        }
    }
    if d.position_mode == "center-fallback" {
        d.final_position = None; // Do not pretend to know asynchronous center's final coordinates.
        d.placement_direction = None;
        d.submission_succeeded = popup.center().is_ok();
    }
    d.timing_us.insert("positionSubmission".into(), submit.elapsed().as_micros() as u64);
    d.timing_us.insert("total".into(), prepared.started.elapsed().as_micros() as u64);
    prepared.diagnostic
}
