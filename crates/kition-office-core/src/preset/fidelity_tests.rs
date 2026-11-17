use super::*;
use kurbo::{ParamCurve, PathEl};

#[test]
fn crescent_inner_arc_preserves_the_pointed_tips() {
    for (width, height) in [(200.0, 100.0), (80.0, 240.0)] {
        let geometry = build("moon", width, height, &[]).unwrap();
        let path = &geometry.paths[0].path;
        // At one quarter height the inner edge lies between these points.
        // A half ellipse incorrectly cuts away both of them.
        assert_ne!(path.winding(Point::new(width * 0.600, height * 0.25)), 0);
        assert_eq!(path.winding(Point::new(width * 0.610, height * 0.25)), 0);
        assert_ne!(path.winding(Point::new(width * 0.600, height * 0.75)), 0);
        assert_eq!(path.winding(Point::new(width * 0.610, height * 0.75)), 0);
        let bounds = path.bounding_box();
        assert!(bounds.origin().distance(Point::ZERO) < 1e-6);
        assert!((bounds.size().to_vec2() - Vec2::new(width, height)).hypot() < 1e-6);
    }
}

#[test]
fn crescent_adjustment_grows_the_body_without_moving_its_tips() {
    let mut previous_area = 0.0;
    for adjustment in [0.0, 25000.0, 50000.0, 87500.0] {
        let geometry = build("moon", 200.0, 100.0, &[adjustment]).unwrap();
        let path = &geometry.paths[0].path;
        let area = path.area().abs();
        assert!(area + 1e-6 >= previous_area);
        if adjustment == 0.0 {
            assert!(area < 1e-6);
        }
        let end = path.segments().last().unwrap().end();
        assert!(end.distance(Point::new(200.0, 0.0)) < 1e-6);
        previous_area = area;
    }
}

#[test]
fn terminal_transport_buttons_leave_one_bar_width_between_bar_and_triangle() {
    for (name, beginning) in [("actionButtonBeginning", true), ("actionButtonEnd", false)] {
        for (width, height) in [(200.0, 100.0), (80.0, 160.0)] {
            let geometry = build(name, width, height, &[]).unwrap();
            let mut contours = Vec::new();
            let mut path = BezPath::new();
            for element in geometry.paths[1].path.elements() {
                path.push(*element);
                if matches!(element, PathEl::ClosePath) {
                    contours.push(path.bounding_box());
                    path = BezPath::new();
                }
            }
            assert_eq!(contours.len(), 2);
            let (triangle, bar) = (contours[0], contours[1]);
            let gap = if beginning { triangle.x0 - bar.x1 } else { bar.x0 - triangle.x1 };
            assert!((gap - bar.width()).abs() < 1e-9);
            assert!((triangle.width() - 6.0 * bar.width()).abs() < 1e-9);
            assert!((bar.height() - triangle.height()).abs() < 1e-9);
        }
    }
}

#[test]
fn even_stars_span_their_declared_box() {
    for name in ["star6", "star10"] {
        for (w, h) in [(200.0, 100.0), (80.0, 240.0)] {
            let geometry = build(name, w, h, &[]).unwrap();
            let bounds = geometry.outline().bounding_box();
            assert!((bounds.width() - w).abs() < 1e-6, "{name}: {bounds:?}");
            assert!((bounds.height() - h).abs() < 1e-6, "{name}: {bounds:?}");
        }
    }
}

#[test]
fn crossing_math_symbols_have_no_internal_stroke_contours() {
    for name in ["mathMultiply", "mathNotEqual"] {
        let geometry = build(name, 200.0, 100.0, &[]).unwrap();
        let path = &geometry.paths[0].path;
        assert_eq!(path.elements().iter().filter(|element| matches!(element, PathEl::MoveTo(_))).count(), 1);
        assert_eq!(path.winding(Point::new(100.0, 50.0)).abs(), 1);
        assert_eq!(path.winding(Point::new(100.0, 45.0)).abs(), 1);
    }
}

#[test]
fn division_dot_adjustment_is_a_radius() {
    let geometry = build("mathDivide", 200.0, 100.0, &[]).unwrap();
    let path = &geometry.paths[0].path;
    assert_ne!(path.winding(Point::new(100.0, 12.0)), 0);
    assert_ne!(path.winding(Point::new(100.0, 88.0)), 0);
    assert_eq!(path.winding(Point::new(100.0, 36.0)), 0);
}

#[test]
fn half_frame_open_ends_follow_the_rectangular_diagonal() {
    let geometry = build("halfFrame", 200.0, 100.0, &[]).unwrap();
    let path = &geometry.paths[0].path;
    assert_eq!(path.winding(Point::new(150.0, 30.0)), 0);
    assert_ne!(path.winding(Point::new(25.0, 80.0)), 0);
}

#[test]
fn prohibition_symbol_has_two_holes_and_no_overlapping_bar() {
    let geometry = build("noSmoking", 200.0, 100.0, &[]).unwrap();
    assert_eq!(geometry.paths.len(), 1);
    assert!(geometry.paths[0].even_odd);
    let path = &geometry.paths[0].path;
    assert_eq!(path.elements().iter().filter(|element| matches!(element, PathEl::MoveTo(_))).count(), 3);
    assert_eq!(path.winding(Point::new(100.0, 50.0)).abs() % 2, 1);
    assert_eq!(path.winding(Point::new(100.0, 30.0)).abs() % 2, 0);
    assert_eq!(path.winding(Point::new(100.0, 70.0)).abs() % 2, 0);
}

#[test]
fn prohibition_symbol_trims_the_ellipse_in_polar_angles() {
    for (width, expected_slope) in [(100.0, 1.0), (200.0, 0.5)] {
        let geometry = build("noSmoking", width, 100.0, &[]).unwrap();
        let chords: Vec<_> = geometry.paths[0]
            .path
            .segments()
            .filter_map(|segment| match segment {
                kurbo::PathSeg::Line(line) if line.p0.distance(line.p1) > 10.0 => Some(line),
                _ => None,
            })
            .collect();
        assert_eq!(chords.len(), 2);
        for chord in chords {
            let slope = (chord.p1.y - chord.p0.y) / (chord.p1.x - chord.p0.x);
            if width == 100.0 {
                assert!((slope - expected_slope).abs() < 1e-9);
            } else {
                assert!(slope > 0.35 && slope < expected_slope - 0.01);
            }
        }
    }
}

#[test]
fn bevel_dark_faces_follow_the_direction_of_light() {
    let geometry = build("bevel", 200.0, 100.0, &[]).unwrap();
    assert_eq!(geometry.paths[3].fill, FillMode::Darken);
    assert_eq!(geometry.paths[4].fill, FillMode::DarkenLess);
}

#[test]
fn wave_edges_keep_the_same_phase_and_constant_thickness() {
    for amplitude in [6250.0, 12500.0, 18000.0] {
        let geometry = build("wave", 200.0, 100.0, &[amplitude, 0.0]).unwrap();
        let segments: Vec<_> = geometry.paths[0].path.segments().collect();
        let thickness = 100.0 * (1.0 - 2.0 * amplitude / 1e5);
        for t in [0.1, 0.25, 0.5, 0.75, 0.9] {
            let top = segments[0].eval(t);
            let bottom = segments[2].eval(1.0 - t);
            assert!((top.x - bottom.x).abs() < 1e-6);
            assert!((bottom.y - top.y - thickness).abs() < 1e-6);
        }
        let bounds = geometry.outline().bounding_box();
        assert!(bounds.y0 >= 0.0 && bounds.y0 < 1.0);
        assert!(bounds.y1 <= 100.0 && bounds.y1 > 99.0);
    }
}

#[test]
fn flowchart_cylinder_and_drum_caps_use_a_sixth_radius() {
    let cylinder = build("flowChartMagneticDisk", 200.0, 120.0, &[]).unwrap();
    assert!((cylinder.paths[1].path.bounding_box().height() - 40.0).abs() < 0.001);
    let drum = build("flowChartMagneticDrum", 120.0, 200.0, &[]).unwrap();
    assert!((drum.paths[1].path.bounding_box().width() - 20.0).abs() < 0.001);
}

#[test]
fn punched_tape_edges_are_same_phase_half_ellipses() {
    let geometry = build("flowChartPunchedTape", 200.0, 100.0, &[]).unwrap();
    let path = &geometry.paths[0].path;
    assert_eq!(path.winding(Point::new(50.0, 19.0)), 0);
    assert_ne!(path.winding(Point::new(50.0, 21.0)), 0);
    assert_ne!(path.winding(Point::new(150.0, 1.0)), 0);
    assert_ne!(path.winding(Point::new(50.0, 99.0)), 0);
    assert_eq!(path.winding(Point::new(150.0, 85.0)), 0);
    let bounds = path.bounding_box();
    assert!(bounds.x0.abs() < 1e-9 && bounds.y0.abs() < 1e-9);
    assert!((bounds.x1 - 200.0).abs() < 1e-9 && (bounds.y1 - 100.0).abs() < 1e-9);
}
