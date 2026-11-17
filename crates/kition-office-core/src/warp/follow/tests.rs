use super::*;

fn close(a: f64, b: f64) {
    assert!((a - b).abs() < 1e-6, "{a} != {b}");
}

#[test]
fn default_half_circles_have_independent_lengths_positions_and_tangents() {
    for (preset, y, dy) in [("textArchUp", 0.0, -1.0), ("textArchDown", 100.0, 1.0)] {
        let p = FollowPath::from_preset(preset, &[], 100.0, 100.0).unwrap();
        close(p.length(), std::f64::consts::PI * 50.0);
        let start = p.sample(0.0).unwrap();
        close(start.point.x, 0.0);
        close(start.point.y, 50.0);
        close(start.tangent.y, dy);
        let middle = p.sample(p.length() / 2.0).unwrap();
        close(middle.point.x, 50.0);
        close(middle.point.y, y);
        close(middle.tangent.x, 1.0);
        close(middle.tangent.y, 0.0);
        let end = p.sample(p.length()).unwrap();
        close(end.point.x, 100.0);
        close(end.point.y, 50.0);
        close(end.tangent.y, -dy);
    }
}

#[test]
fn ellipse_uses_distance_not_uniform_parameter_angle() {
    let p = FollowPath::from_preset("textArchUp", &[], 400.0, 40.0).unwrap();
    // Independent dense chord integration, rather than the implementation's Simpson table.
    let mut samples = vec![(0.0, Point::new(0.0, 20.0))];
    let mut distance = 0.0;
    let mut previous = samples[0].1;
    for i in 1..=32768 {
        let t = std::f64::consts::PI * (1.0 + i as f64 / 32768.0);
        let next = Point::new(200.0 + 200.0 * t.cos(), 20.0 + 20.0 * t.sin());
        distance += (next - previous).hypot();
        samples.push((distance, next));
        previous = next;
    }
    assert!((p.length() - distance).abs() < 0.001);
    let wanted = distance / 4.0;
    let k = samples.partition_point(|(d, _)| *d < wanted);
    let (a, b) = (samples[k - 1], samples[k]);
    let expected = a.1.lerp(b.1, (wanted - a.0) / (b.0 - a.0));
    let actual = p.sample(p.length() / 4.0).unwrap();
    assert!((actual.point - expected).hypot() < 0.001);
    let uniform_angle_x = 200.0 + 200.0 * (std::f64::consts::PI * 1.25).cos();
    assert!((actual.point.x - uniform_angle_x).abs() > 20.0);
    close(actual.tangent.hypot(), 1.0);
}

#[test]
fn adjusted_radial_bearing_on_ellipse_hits_its_declared_ray() {
    let p = FollowPath::from_preset("textArchUp", &[("adj".into(), 13_500_000.0)], 300.0, 80.0).unwrap();
    let point = p.sample(0.0).unwrap().point;
    // 225 degree bearing: x/y displacements are equal even on a non-circular ellipse.
    close(point.x - 150.0, point.y - 40.0);
    close(((point.x - 150.0) / 150.0).powi(2) + ((point.y - 40.0) / 40.0).powi(2), 1.0);
}

#[test]
fn unsupported_and_degenerate_presets_do_not_change_legacy_routing() {
    for preset in ["textArchUpPour", "textArchDownPour", "textCircle", "textInflate", "textPlain", "unknown"] {
        assert!(FollowPath::from_preset(preset, &[], 100.0, 40.0).is_none());
    }
    for (w, h) in [(0.0, 40.0), (-1.0, 40.0), (100.0, f64::NAN), (f64::INFINITY, 40.0)] {
        assert!(FollowPath::from_preset("textArchUp", &[], w, h).is_none());
    }
    // At the exact quarter-turn branch boundary the Annex D guides select a full turn.
    let full = FollowPath::from_preset("textArchUp", &[("adj".into(), 5_400_000.0)], 100.0, 100.0).unwrap();
    close(full.length(), std::f64::consts::TAU * 50.0);
}

#[test]
fn finite_overflow_extends_tangents_and_rejects_nonfinite_distances() {
    let p = FollowPath::from_preset("textArchUp", &[], 100.0, 100.0).unwrap();
    let first = p.sample(0.0).unwrap();
    let outside = p.sample(-17.0).unwrap();
    assert!((outside.point - first.point - first.tangent * -17.0).hypot() < 1e-7);
    let last = p.sample(p.length()).unwrap();
    let beyond = p.sample(p.length() + 23.0).unwrap();
    assert!((beyond.point - last.point - last.tangent * 23.0).hypot() < 1e-7);
    assert!(p.sample(f64::NAN).is_none());
    assert!(p.sample(f64::INFINITY).is_none());
}

#[test]
fn scale_changes_geometry_and_distance_together_without_changing_tangent() {
    let a = FollowPath::from_preset("textArchDown", &[], 123.0, 57.0).unwrap();
    let b = FollowPath::from_preset("textArchDown", &[], 369.0, 171.0).unwrap();
    close(a.length() * 3.0, b.length());
    for i in 0..=12 {
        let distance = a.length() * i as f64 / 12.0;
        let x = a.sample(distance).unwrap();
        let y = b.sample(distance * 3.0).unwrap();
        assert!((x.point.to_vec2() * 3.0 - y.point.to_vec2()).hypot() < 1e-6);
        assert!((x.tangent - y.tangent).hypot() < 1e-6);
    }
}
