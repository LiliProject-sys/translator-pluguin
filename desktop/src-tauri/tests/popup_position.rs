use orange_translator_desktop_lib::popup_position::{compute_popup_position, target_geometry, Direction, Point, Size, WorkArea};

const AREA: WorkArea = WorkArea { x: 0, y: 0, width: 1920, height: 1040 };
const SIZE: Size = Size { width: 400, height: 450 };
fn position(x: i32, y: i32) -> orange_translator_desktop_lib::popup_position::Placement {
    compute_popup_position(Some(Point { x, y }), SIZE, AREA, 16).unwrap()
}

#[test]
fn center_prefers_right_bottom() {
    let p = position(600, 300);
    assert_eq!(p.position, Point { x: 616, y: 316 });
    assert_eq!(p.direction, Direction::RightBottom);
    assert!(!p.clamped);
}
#[test]
fn right_edge_flips_left() {
    let p = position(1900, 200);
    assert_eq!(p.position, Point { x: 1484, y: 216 });
    assert_eq!(p.direction, Direction::LeftBottom);
}
#[test]
fn bottom_edge_flips_up() {
    let p = position(600, 1000);
    assert_eq!(p.position, Point { x: 616, y: 534 });
    assert_eq!(p.direction, Direction::RightTop);
}
#[test]
fn bottom_right_flips_both_axes() {
    let p = position(1900, 1000);
    assert_eq!(p.position, Point { x: 1484, y: 534 });
    assert_eq!(p.direction, Direction::LeftTop);
}
#[test]
fn zero_is_a_valid_anchor_and_top_left_remains_inside() {
    assert_eq!(position(0, 0).position, Point { x: 16, y: 16 });
}
#[test]
fn second_monitor_uses_its_own_nonzero_origin_and_taskbar_work_area() {
    let area = WorkArea { x: 1920, y: 40, width: 1280, height: 984 };
    let p = compute_popup_position(Some(Point { x: 3100, y: 950 }), SIZE, area, 16).unwrap();
    assert_eq!(p.position, Point { x: 2684, y: 484 });
    assert!(p.position.y >= 40);
}
#[test]
fn negative_left_and_upper_monitor_coordinates_are_valid() {
    let area = WorkArea { x: -1920, y: -1080, width: 1920, height: 1040 };
    let p = compute_popup_position(Some(Point { x: -900, y: -800 }), SIZE, area, 16).unwrap();
    assert_eq!(p.position, Point { x: -884, y: -784 });
}
#[test]
fn nearly_full_size_clamps_without_resizing() {
    let size = Size { width: 1900, height: 1000 };
    let p = compute_popup_position(Some(Point { x: 960, y: 500 }), size, AREA, 16).unwrap();
    assert_eq!(p.position, Point { x: 0, y: 0 });
    assert!(p.clamped);
    assert!(!p.oversized);
}
#[test]
fn oversized_window_keeps_top_left_accessible_without_invalid_clamp_range() {
    let p = compute_popup_position(Some(Point { x: 500, y: 500 }), Size { width: 3000, height: 2000 }, AREA, 16).unwrap();
    assert_eq!(p.position, Point { x: 0, y: 0 });
    assert!(p.oversized && p.clamped);
}
#[test]
fn missing_anchor_invalid_size_area_and_disconnected_monitor_are_fallback_reasons() {
    assert_eq!(compute_popup_position(None, SIZE, AREA, 16).unwrap_err(), "missing-anchor");
    assert_eq!(compute_popup_position(Some(Point { x: 1, y: 1 }), Size { width: 0, height: 1 }, AREA, 16).unwrap_err(), "invalid-size");
    assert_eq!(compute_popup_position(Some(Point { x: 1, y: 1 }), SIZE, WorkArea { width: 0, ..AREA }, 16).unwrap_err(), "invalid-work-area");
    assert_eq!(compute_popup_position(Some(Point { x: -2000, y: 1 }), SIZE, AREA, 16).unwrap_err(), "anchor-outside-monitor");
}
#[test]
fn mixed_dpi_scales_window_dimensions_and_gap_not_screen_anchor() {
    let (size, offset) = target_geometry(Size { width: 380, height: 420 }, 1.0, 1.5).unwrap();
    assert_eq!(size, Size { width: 570, height: 630 });
    assert_eq!(offset, 24);
    let area = WorkArea { x: 1920, y: 0, width: 2560, height: 1400 };
    let p = compute_popup_position(Some(Point { x: 2000, y: 100 }), size, area, offset).unwrap();
    assert_eq!(p.position, Point { x: 2024, y: 124 });
    assert_eq!(target_geometry(size, 1.5, 1.0).unwrap(), (Size { width: 380, height: 420 }, 16));
}
#[test]
fn invalid_dpi_and_large_geometry_fail_closed_without_overflow() {
    for scale in [0.0, -1.0, f64::NAN, f64::INFINITY] {
        assert!(target_geometry(SIZE, scale, 1.0).is_err());
        assert!(target_geometry(SIZE, 1.0, scale).is_err());
    }
    assert!(compute_popup_position(Some(Point { x: i32::MAX, y: 0 }), SIZE,
        WorkArea { x: i32::MAX, y: 0, width: 100, height: 100 }, 16).is_err());
}
#[test]
fn all_fitting_windows_remain_inside_varied_work_areas() {
    for origin in [-2560, 0, 1920] {
        let area = WorkArea { x: origin, y: -200, width: 1280, height: 900 };
        for (w, h) in [(1, 1), (380, 420), (1279, 899), (1280, 900)] {
            for x in [origin, origin + 640, origin + 1279] {
                for y in [-200, 250, 699] {
                    let p = compute_popup_position(Some(Point { x, y }), Size { width: w, height: h }, area, 24).unwrap();
                    assert!(p.position.x >= area.x && p.position.y >= area.y);
                    assert!(i64::from(p.position.x) + i64::from(w) <= i64::from(area.x) + i64::from(area.width));
                    assert!(i64::from(p.position.y) + i64::from(h) <= i64::from(area.y) + i64::from(area.height));
                }
            }
        }
    }
}
#[test]
fn only_initial_show_can_position_and_getters_stay_outside_commit() {
    let source = include_str!("../src/lib.rs");
    let loading = source.split_once("fn emit_live_loading_current(").unwrap().1.split_once("fn emit_live_result_if_current(").unwrap().0;
    assert!(loading.find("if !should_emit_live_loading").unwrap() < loading.find("popup_position::apply").unwrap());
    assert!(loading.contains("if may_show {"));
    for getter in [".outer_size(", ".scale_factor(", ".monitor_from_point(", ".is_visible(", "popup_position::prepare"] {
        assert!(!loading.contains(getter));
    }
    for (start, end) in [("fn emit_live_result_current(", "fn emit_detail_if_current("),
        ("fn emit_detail_if_current(", "fn local_gateway_failure(")] {
        let section = source.split_once(start).unwrap().1.split_once(end).unwrap().0;
        for forbidden in [".center(", ".set_position(", "popup_position::", ".show("] {
            assert!(!section.contains(forbidden));
        }
    }
    let helper = include_str!("../src/popup_position.rs");
    assert!(!helper.contains("GetCursorPos"));
    assert!(!include_str!("../src/gateway.rs").contains("popup_position"));
    assert!(!include_str!("../src/host_adapter/mod.rs").contains("popup_position"));
}

#[test]
fn pure_geometry_timing_sample() {
    let start = std::time::Instant::now();
    for i in 0..10000 {
        std::hint::black_box(compute_popup_position(Some(Point { x: i % 1920, y: i % 1040 }), SIZE, AREA, 16).unwrap());
    }
    println!("geometry_10000_total_us={}", start.elapsed().as_micros());
}
