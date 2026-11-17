//! Curved ribbons and multi-direction arrow callouts, constructed from ellipses and polygons.

use super::*;
use kurbo::Affine;

fn ellipse_point(rx: f64, ry: f64, angle: f64) -> Point {
    let parameter = vis(angle, rx, ry).to_radians();
    Point::new(rx * parameter.cos(), ry * parameter.sin())
}

/// Intersect the outward half of a line with an ellipse. Keeping the farther
/// root selects the arrowhead side even when the line also crosses the far side.
fn ellipse_intersection(rx: f64, ry: f64, base: Point, direction: Vec2) -> Point {
    if rx <= 1e-9 || ry <= 1e-9 {
        return Point::ZERO;
    }
    let p = Vec2::new(base.x / rx, base.y / ry);
    let d = Vec2::new(direction.x / rx, direction.y / ry);
    let quadratic = d.hypot2();
    let linear = p.dot(d);
    let discriminant = linear * linear - quadratic * (p.hypot2() - 1.0);
    if discriminant < 0.0 || quadratic <= 0.0 {
        return ellipse_point(rx, ry, base.y.atan2(base.x).to_degrees());
    }
    base + direction * ((-linear + discriminant.sqrt()) / quadratic)
}

pub(super) fn circular(name: &str, w: f64, h: f64, adjust: [f64; 5]) -> Geometry {
    let short = w.min(h);
    let head_half = short * adjust[4].clamp(0.0, 25000.0) / 1e5;
    let half_thickness = (short * adjust[0].max(0.0) / 2e5).min(head_half);
    let (rx, ry) = (w / 2.0 - head_half, h / 2.0 - head_half);
    let outer = (rx + half_thickness, ry + half_thickness);
    let inner = ((rx - half_thickness).max(0.0), (ry - half_thickness).max(0.0));
    let start = (adjust[3] / 60000.0).rem_euclid(360.0);
    let end = (adjust[2] / 60000.0).rem_euclid(360.0);
    let reverse = name == "leftCircularArrow";
    let head_angle = (adjust[1] / 60000.0).abs().min(90.0);
    let tip_angle = end + if reverse { -head_angle } else { head_angle };
    let tip = ellipse_point(rx, ry, tip_angle);
    let base = ellipse_point(rx, ry, end);
    let direction = Vec2::new(tip_angle.to_radians().cos(), tip_angle.to_radians().sin());
    let head_outer = base + direction * head_half;
    let head_inner = base - direction * head_half;
    let join_outer = ellipse_intersection(outer.0, outer.1, base, direction);
    let join_inner = ellipse_intersection(inner.0, inner.1, base, direction);
    let parameter = |point: Point, radii: (f64, f64)| (point.y / radii.1.max(1e-9)).atan2(point.x / radii.0.max(1e-9)).to_degrees();
    let outer_start = vis(start, outer.0, outer.1);
    let inner_start = vis(start, inner.0, inner.1);
    let outer_end = parameter(join_outer, outer);
    let inner_end = parameter(join_inner, inner);
    let sweep = |from: f64, to: f64| {
        if reverse { -(from - to).rem_euclid(360.0) } else { (to - from).rem_euclid(360.0) }
    };
    let p = ellipse_point(outer.0, outer.1, start);
    let path = Pb::new()
        .m(p.x, p.y)
        .arc(outer.0, outer.1, outer_start, sweep(outer_start, outer_end))
        .l(head_outer.x, head_outer.y)
        .l(tip.x, tip.y)
        .l(head_inner.x, head_inner.y)
        .l(join_inner.x, join_inner.y)
        .arc(inner.0, inner.1, inner_end, -sweep(inner_start, inner_end))
        .z()
        .take();
    simple(Affine::translate((w / 2.0, h / 2.0)) * path, Rect::new(head_half, head_half, w - head_half, h - head_half), w, h)
}

pub(super) fn curved(name: &str, w: f64, h: f64, a0: f64, a1: f64, a2: f64) -> Geometry {
    let direction = match name {
        "curvedLeftArrow" => Dir::Left,
        "curvedUpArrow" => Dir::Up,
        "curvedDownArrow" => Dir::Down,
        _ => Dir::Right,
    };
    let (length, height) = len_thick(direction, w, h);
    let short = length.min(height);
    let head_width = (short * a1.max(0.0) / 1e5).min(height);
    let thickness = (short * a0.max(0.0) / 1e5).min(head_width);
    let head_length = (short * a2.max(0.0) / 1e5).min(length);
    let radius = (height - (head_width + thickness) / 2.0) / 2.0;
    let base_x = length - head_length;
    let base_angle = if length > 0.0 { (head_length / length).clamp(0.0, 1.0).acos().to_degrees() } else { 0.0 };
    let base_y = radius * (1.0 + base_angle.to_radians().sin());
    let tip_y = height - head_width / 2.0;

    // Two translated half ellipses form a folded strip. The front hides the
    // overlapping part of the back, producing the fold without an extra seam.
    let back = Pb::new().m(length, 0.0).arc(length, radius, 270.0, -90.0).l(0.0, radius + thickness).arc(length, radius, 180.0, 90.0).l(length, 0.0).z().take();
    let front = Pb::new()
        .m(0.0, radius)
        .arc(length, radius, 180.0, -base_angle)
        .l(base_x, tip_y - head_width / 2.0)
        .l(length, tip_y)
        .l(base_x, height)
        .l(base_x, base_y + thickness)
        .arc(length, radius, 180.0 - base_angle, base_angle)
        .z()
        .take();
    let transform = match direction {
        Dir::Right => Affine::IDENTITY,
        Dir::Left => Affine::new([-1.0, 0.0, 0.0, 1.0, w, 0.0]),
        Dir::Up => Affine::new([0.0, -1.0, 1.0, 0.0, 0.0, h]),
        Dir::Down => Affine::new([0.0, 1.0, 1.0, 0.0, 0.0, 0.0]),
    };
    // Fills and strokes are separate renderer passes. Omit the hidden section
    // of the back edge explicitly, so it cannot reappear over the front face.
    let crossing = if radius > 0.0 { (thickness / (2.0 * radius)).clamp(0.0, 1.0).asin().to_degrees() } else { 90.0 };
    let back_outline = Pb::new().m(0.0, radius).arc(length, radius, 180.0, 90.0).l(length, thickness).arc(length, radius, 270.0, crossing - 90.0).take();
    let mut back_fill = shade(transform * back, FillMode::DarkenLess);
    back_fill.stroke = false;
    Geometry {
        paths: vec![back_fill, fill(transform * front), stroke_only(transform * back_outline)],
        text_rect: Rect::new(0.0, 0.0, w, h),
        handles: vec![],
        sites: mid_sites(w, h),
    }
}

pub(super) fn callout(name: &str, w: f64, h: f64, a0: f64, a1: f64, a2: f64, a3: f64) -> Geometry {
    let short = w.min(h);
    let head_half = short * a1.clamp(0.0, 50000.0) / 1e5;
    let shaft_half = (short * a0.max(0.0) / 2e5).min(head_half);
    let head_length = (short * a2.max(0.0) / 1e5).min(short / 2.0);
    let box_fraction = a3.clamp(0.0, 100000.0) / 1e5;
    let box_half_w = (w * box_fraction / 2.0).min(w / 2.0 - head_length).max(shaft_half);
    let box_half_h = (h * box_fraction / 2.0).min(h / 2.0 - head_length).max(shaft_half);
    let (cx, cy) = (w / 2.0, h / 2.0);
    let (left, right) = (cx - box_half_w, cx + box_half_w);
    let (top, bottom) = if name == "quadArrowCallout" { (cy - box_half_h, cy + box_half_h) } else { (0.0, h) };
    let mut points = vec![(left, top)];
    if name == "quadArrowCallout" {
        points.extend([
            (cx - shaft_half, top),
            (cx - shaft_half, head_length),
            (cx - head_half, head_length),
            (cx, 0.0),
            (cx + head_half, head_length),
            (cx + shaft_half, head_length),
            (cx + shaft_half, top),
        ]);
    }
    points.extend([
        (right, top),
        (right, cy - shaft_half),
        (w - head_length, cy - shaft_half),
        (w - head_length, cy - head_half),
        (w, cy),
        (w - head_length, cy + head_half),
        (w - head_length, cy + shaft_half),
        (right, cy + shaft_half),
        (right, bottom),
    ]);
    if name == "quadArrowCallout" {
        points.extend([
            (cx + shaft_half, bottom),
            (cx + shaft_half, h - head_length),
            (cx + head_half, h - head_length),
            (cx, h),
            (cx - head_half, h - head_length),
            (cx - shaft_half, h - head_length),
            (cx - shaft_half, bottom),
        ]);
    }
    points.extend([
        (left, bottom),
        (left, cy + shaft_half),
        (head_length, cy + shaft_half),
        (head_length, cy + head_half),
        (0.0, cy),
        (head_length, cy - head_half),
        (head_length, cy - shaft_half),
        (left, cy - shaft_half),
    ]);
    simple(Pb::new().poly(&points).take(), Rect::new(left, top, right, bottom), w, h)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn circular_arrow_has_a_hole_and_a_directional_head() {
        let arrow = build("circularArrow", 400.0, 240.0, &[]).unwrap();
        let path = &arrow.paths[0].path;
        assert_eq!(path.winding(Point::new(200.0, 120.0)), 0);
        assert_ne!(path.winding(Point::new(200.0, 30.0)), 0);
        assert_eq!(path.winding(Point::new(200.0, 210.0)), 0);
        let bounds = path.bounding_box();
        assert!((bounds.x0 - 15.0).abs() < 1e-6);
        assert!((bounds.y0 - 15.0).abs() < 0.05);
        assert!((bounds.y1 - 120.0).abs() < 1e-6);
        assert!(path.area().abs() < 400.0 * 240.0 / 4.0);
    }

    #[test]
    fn circular_arrow_adjustments_control_width_and_sweep() {
        let thin = build("circularArrow", 200.0, 200.0, &[5000.0, 600000.0, 21000000.0, 10800000.0, 10000.0]).unwrap();
        let thick = build("circularArrow", 200.0, 200.0, &[15000.0, 600000.0, 21000000.0, 10800000.0, 10000.0]).unwrap();
        assert!(thick.paths[0].path.area().abs() > thin.paths[0].path.area().abs() * 2.0);
        let lower = build("leftCircularArrow", 200.0, 200.0, &[5000.0, 600000.0, 600000.0, 10800000.0, 10000.0]).unwrap();
        assert_ne!(lower.paths[0].path.winding(Point::new(100.0, 180.0)), 0);
        assert_eq!(lower.paths[0].path.winding(Point::new(100.0, 20.0)), 0);
    }

    #[test]
    fn curved_arrows_keep_the_fold_and_rotate_with_their_boxes() {
        let right = build("curvedRightArrow", 400.0, 240.0, &[]).unwrap();
        let down = build("curvedDownArrow", 240.0, 400.0, &[]).unwrap();
        assert_eq!(right.paths.len(), 3);
        assert_eq!(right.paths[0].fill, FillMode::DarkenLess);
        assert_eq!(right.paths[1].fill, FillMode::Norm);
        assert!(!right.paths[0].stroke);
        assert_eq!(right.paths[2].fill, FillMode::None);
        for (horizontal, vertical) in right.paths.iter().zip(&down.paths) {
            assert!((horizontal.path.area().abs() - vertical.path.area().abs()).abs() < 1e-6);
            if horizontal.fill == FillMode::None {
                continue;
            }
            for x in [10.0, 100.0, 200.0, 300.0, 390.0] {
                for y in [10.0, 60.0, 120.0, 180.0, 230.0] {
                    assert_eq!(horizontal.path.winding(Point::new(x, y)).abs(), vertical.path.winding(Point::new(y, x)).abs());
                }
            }
        }
        assert_eq!(right.outline().winding(Point::new(200.0, 120.0)), 0);
    }

    #[test]
    fn arrow_callouts_have_center_boxes_and_narrow_connector_shafts() {
        for name in ["leftRightArrowCallout", "quadArrowCallout"] {
            let geometry = build(name, 400.0, 240.0, &[]).unwrap();
            let path = &geometry.paths[0].path;
            assert_ne!(path.winding(Point::new(200.0, 120.0)), 0);
            assert_ne!(path.winding(Point::new(75.0, 120.0)), 0);
            assert_eq!(path.winding(Point::new(75.0, 60.0)), 0);
            assert!((geometry.text_rect.width() - 400.0 * 0.48123).abs() < 1e-6);
        }
    }
}
