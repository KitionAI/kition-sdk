use super::*;

fn caps(source: &str, cap: Cap) -> Option<BezPath> {
    zero_length_caps(&BezPath::from_svg(source).unwrap(), &Stroke::new(8.0).with_caps(cap), 0.001)
}

#[test]
fn drawable_zero_subpaths_have_one_centered_cap_shape() {
    for source in ["M20 30L20 30", "M20 30Z", "M20 30Q20 30 20 30", "M20 30C20 30 20 30 20 30", "M20 30L20 30L20 30Z"] {
        let round = caps(source, Cap::Round).unwrap();
        let square = caps(source, Cap::Square).unwrap();
        assert_eq!(round.bounding_box(), Rect::new(16.0, 26.0, 24.0, 34.0));
        assert_eq!(square.bounding_box(), round.bounding_box());
        assert_eq!(round.winding(Point::new(20.0, 30.0)), 1);
        assert_eq!(square.winding(Point::new(20.0, 30.0)), 1);
        assert_eq!(round.winding(Point::new(23.5, 33.5)), 0);
        assert_eq!(square.winding(Point::new(23.5, 33.5)), 1);
        assert!(caps(source, Cap::Butt).is_none());
    }
}

#[test]
fn moves_and_nonzero_curves_do_not_acquire_dots() {
    for source in ["M20 30", "M20 30M40 50", "M20 30L25 30L20 30", "M20 30Q21 30 20 30", "M20 30C20 31 20 29 20 30"] {
        for cap in [Cap::Round, Cap::Square] {
            assert!(caps(source, cap).is_none(), "{source}");
        }
    }
}

#[test]
fn mixed_subpaths_and_commands_after_close_keep_independent_caps() {
    let shape = caps("M0 0L50 0 M20 30L20 30 M40 50Z L40 50 M60 60", Cap::Round).unwrap();
    assert_eq!(shape.winding(Point::new(25.0, 0.0)), 0);
    assert_eq!(shape.winding(Point::new(20.0, 30.0)), 1);
    assert!(shape.winding(Point::new(40.0, 50.0)) > 0);
    assert_eq!(shape.winding(Point::new(60.0, 60.0)), 0);
}

#[test]
fn caps_preserve_positive_stroke_union_for_both_closed_windings() {
    let normal = BezPath::from_svg("M10 10L40 10L40 40L10 40Z").unwrap();
    let stroke = Stroke::new(8.0).with_caps(Cap::Round);
    for path in [normal.clone(), normal.reverse_subpaths()] {
        let mut outline = kurbo::stroke(path.iter(), &stroke, &kurbo::StrokeOpts::default(), 0.001);
        let point = Point::new(20.0, 10.0);
        assert!(outline.winding(point) > 0);
        outline.extend(caps("M20 10L20 10", Cap::Round).unwrap());
        assert!(outline.winding(point) > 1, "same-paint overlap stays inside the nonzero union");
        assert_eq!(outline.winding(Point::new(25.0, 25.0)), 0, "the closed stroke's interior stays empty");
    }
}

#[test]
fn transformations_apply_to_the_entire_cap_geometry() {
    let square = caps("M20 30L20 30", Cap::Square).unwrap();
    let transform = kurbo::Affine::translate((70.0, 50.0)) * kurbo::Affine::rotate(0.7) * kurbo::Affine::scale_non_uniform(-2.0, 0.5);
    let transformed = transform * square;
    let expected = transform * Point::new(20.0, 30.0);
    assert_eq!(transformed.winding(expected), -1);
    assert!(transformed.bounding_box().contains(expected));
    assert!((transformed.area().abs() - 64.0).abs() < 1e-8);
}

#[test]
fn unsupported_styles_and_hostile_geometry_preserve_the_callers_fallback() {
    let path = BezPath::from_svg("M20 30L20 30").unwrap();
    for width in [0.0, -1.0, f64::NAN, f64::INFINITY, crate::ops::MAX_LENGTH + 1.0] {
        assert!(zero_length_caps(&path, &Stroke::new(width), 0.001).is_none());
    }
    for tolerance in [0.0, -1.0, f64::NAN, f64::INFINITY] {
        assert!(zero_length_caps(&path, &Stroke::new(8.0), tolerance).is_none());
    }
    assert!(zero_length_caps(&path, &Stroke::new(8.0).with_start_cap(Cap::Butt), 0.001).is_none());
    assert!(zero_length_caps(&path, &Stroke::new(8.0).with_dashes(0.0, [2.0, 2.0]), 0.001).is_none());
    let mut invalid = path.clone();
    invalid.line_to((f64::NAN, 30.0));
    assert!(zero_length_caps(&invalid, &Stroke::new(8.0), 0.001).is_none());
    let mut excessive = BezPath::new();
    for _ in 0..=MAX_ELEMENTS {
        excessive.move_to((0.0, 0.0));
    }
    assert!(zero_length_caps(&excessive, &Stroke::new(8.0), 0.001).is_none());
}

#[test]
fn shared_ink_center_line_preserves_empty_and_single_sample_meanings() {
    assert!(crate::ink::centre_line([]).elements().is_empty());
    let point = Point::new(20.0, 30.0);
    let path = crate::ink::centre_line([point]);
    assert_eq!(path.elements(), &[PathEl::MoveTo(point), PathEl::LineTo(point)]);
    let ink = crate::ink::InkStroke { points: vec![[20.0, 30.0, 0.5]], ..Default::default() };
    assert_eq!(ink.centre_line(), path);
    assert!(zero_length_caps(&path, &Stroke::new(8.0), 0.001).is_some());
}
