use super::*;

#[test]
fn differences_accelerations_and_independent_modes() {
    let p = decode_xy("10 20,'2'3,\"1\"-1,1-2,!50'4,5 6", false).unwrap();
    assert_eq!(
        p,
        vec![Point::new(10.0, 20.0), Point::new(12.0, 23.0), Point::new(15.0, 25.0), Point::new(19.0, 25.0), Point::new(50.0, 29.0), Point::new(5.0, 35.0)]
    );
    let q = decode_xy("1e1-2.5,'1.0'.5,**", true).unwrap();
    assert_eq!(q, vec![Point::new(-2.5, 10.0), Point::new(-2.0, 11.0), Point::new(-1.5, 12.0)]);
}

#[test]
fn wildcards_keep_the_current_encoding_component() {
    let p = decode_xy("10 20,**,'2'3,** ,\"1\"2,**", false).unwrap();
    assert_eq!(p.last(), Some(&Point::new(21.0, 38.0)));
}

#[test]
fn hostile_or_unsupported_trace_data_is_rejected() {
    for text in ["", "1", "1 2 3", "NaN 2", "1e999 2", "1e 2", "'1 2", "1 2,\"1 2", "* 2", "1?", "1 2;3 4", "1 2,3T", "1 2,!1e9'1e9,**"] {
        assert!(decode_xy(text, false).is_err(), "{text}");
    }
    assert_eq!(decode_xy(&"1 2,".repeat(MAX_TRACE_POINTS + 1), false), Err(TraceError::Limit));
    assert_eq!(decode_xy(&" ".repeat(MAX_TRACE_BYTES + 1), false), Err(TraceError::Limit));
}

#[test]
fn numeric_prefix_and_sign_whitespace_preserve_channel_integration() {
    let spaced = "10 20, ' \t2 ' \n- \t3, \" 1 \" - 2, **, \r\n";
    assert_eq!(decode_xy(spaced, false).unwrap(), vec![Point::new(10.0, 20.0), Point::new(12.0, 17.0), Point::new(15.0, 12.0), Point::new(19.0, 5.0)]);
    assert_eq!(decode_xy("1 2,! \t- 3 ! .5,", false).unwrap().last(), Some(&Point::new(-3.0, 0.5)));
    assert_eq!(decode_xy("1e-2 - 2E+1,", false).unwrap(), vec![Point::new(0.01, -20.0)]);
    assert_eq!(decode_xy("0.923.45", false).unwrap(), vec![Point::new(0.923, 0.45)]);
}

#[test]
fn optional_final_comma_is_not_an_empty_additional_point() {
    assert_eq!(decode_xy("1 2, \n\t", false).unwrap(), vec![Point::new(1.0, 2.0)]);
    assert_eq!(decode_xy(&"1 2,".repeat(MAX_TRACE_POINTS), false).unwrap().len(), MAX_TRACE_POINTS);
    for text in [",", "1 2,,", "1 2, ,3 4", "1 2,3,"] {
        assert_eq!(decode_xy(text, false), Err(TraceError::Syntax), "{text}");
    }
}

#[test]
fn wildcards_cannot_be_prefixed_or_signed() {
    for component in ["!*", "' *", "\"\t*", "-*", "- *", "+1", "+ 1"] {
        let trace = format!("10 20,'2'3,\"1\"2,{component} 0");
        assert_eq!(decode_xy(&trace, false), Err(TraceError::Syntax), "{trace}");
    }
    // An unprefixed wildcard retains the preceding channel's difference order.
    assert_eq!(decode_xy("10 20,'2'3,\"1\"2,**", false).unwrap().last(), Some(&Point::new(19.0, 35.0)));
}

#[test]
fn physical_units_are_bounded_and_independent_of_frame_size() {
    for (n, u) in [(1.0, "in"), (2.54, "cm"), (25.4, "mm"), (72.0, "pt"), (6.0, "pc")] {
        assert!((length_in_points(n, u).unwrap() - 72.0).abs() < 1e-8);
    }
    for n in [0.0, -1.0, f64::NAN, f64::INFINITY, 100.0] {
        assert!(length_in_points(n, "in").is_none());
    }
    assert!(length_in_points(1.0, "dev").is_none());
}

#[test]
fn fitting_keeps_axis_extents_and_degenerate_strokes() {
    use kurbo::Shape;
    let p = [Point::new(10.0, 20.0), Point::new(20.0, 40.0)];
    assert_eq!(fitted_center_line(&p, 30.0, 60.0).unwrap().bounding_box(), kurbo::Rect::new(0.0, 0.0, 30.0, 60.0));
    let line = fitted_center_line(&[Point::new(5.0, 5.0), Point::new(5.0, 15.0)], 4.0, 20.0).unwrap();
    assert_eq!(line.bounding_box(), kurbo::Rect::new(2.0, 0.0, 2.0, 20.0));
    let dot = fitted_center_line(&[Point::new(10.0, 20.0)], 4.0, 6.0).unwrap();
    assert_eq!(dot.elements(), &[kurbo::PathEl::MoveTo(Point::new(2.0, 3.0)), kurbo::PathEl::LineTo(Point::new(2.0, 3.0))]);
    assert!(fitted_center_line(&[], 4.0, 6.0).is_none());
    assert!(fitted_center_line(&[Point::new(f64::NAN, 0.0)], 4.0, 6.0).is_none());
    assert!(fitted_center_line(&p, f64::INFINITY, 6.0).is_none());
}
