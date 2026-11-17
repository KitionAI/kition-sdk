//! Scrolls made from a sheet and circular rolls, with the horizontal variant transposed.

use super::*;
use kurbo::Affine;

pub(super) fn build(vertical: bool, width: f64, height: f64, adjustment: f64) -> Geometry {
    let (w, h) = if vertical { (width, height) } else { (height, width) };
    let r = w.min(h) * adjustment.clamp(0.0, 25000.0) / 200000.0;
    if r <= 1e-9 {
        return simple(corner_rect(width, height, [Corner::Square; 4]), Rect::new(0.0, 0.0, width, height), width, height);
    }
    let mut sheet = Pb::new();
    sheet
        .m(3.0 * r, 0.0)
        .l(w - r, 0.0)
        .arc(r, r, 270.0, 180.0)
        .l(w - 2.0 * r, 2.0 * r)
        .l(w - 2.0 * r, h - r)
        .arc(r, r, 0.0, 90.0)
        .l(r, h)
        .arc(r, r, 90.0, 180.0)
        .l(2.0 * r, h - 2.0 * r)
        .l(2.0 * r, r)
        .arc(r, r, 180.0, 90.0)
        .z();

    // Each roll exposes a shaded reverse face. The smaller semicircle returns
    // into the larger one, instead of outlining an overlapping full disk.
    let mut reverse = Pb::new();
    reverse.m(3.0 * r, r).l(4.0 * r, r).arc(r, r, 0.0, 90.0).arc(r / 2.0, r / 2.0, 90.0, 180.0).z();
    reverse.m(r, h - 2.0 * r).arc(r / 2.0, r / 2.0, 270.0, 180.0).l(2.0 * r, h - r).arc(r, r, 0.0, 270.0).z();

    // Fill and visible seams are separate so the outline of a rear face cannot
    // show through the sheet; shared outer boundaries are stroked only once.
    let sheet = sheet.take();
    let mut seams = Pb::new();
    seams.m(3.0 * r, 0.0).arc(r, r, 270.0, 180.0).arc(r / 2.0, r / 2.0, 90.0, 180.0).l(4.0 * r, r);
    seams.m(3.0 * r, 2.0 * r).l(w - 2.0 * r, 2.0 * r);
    seams.m(r, h - 2.0 * r).arc(r / 2.0, r / 2.0, 270.0, 180.0).l(2.0 * r, h - r).arc(r, r, 0.0, 90.0);
    seams.m(2.0 * r, h - 2.0 * r).l(2.0 * r, h - r);
    seams.p.extend(sheet.elements().iter().copied());

    let transform = if vertical { Affine::IDENTITY } else { Affine::new([0.0, 1.0, 1.0, 0.0, 0.0, 0.0]) };
    let mut shaded = fill_only(transform * reverse.take());
    shaded.fill = FillMode::DarkenLess;
    Geometry {
        paths: vec![fill_only(transform * sheet), shaded, stroke_only(transform * seams.take())],
        text_rect: Rect::new(2.0 * r, 2.0 * r, width - 2.0 * r, height - 2.0 * r),
        handles: vec![],
        sites: mid_sites(width, height),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use kurbo::ParamCurve;

    #[test]
    fn scroll_sheet_reaches_the_lower_edge_and_leaves_the_left_margin_clear() {
        let geometry = build(true, 240.0, 160.0, 12500.0);
        let sheet = &geometry.paths[0].path;
        assert_eq!(sheet.winding(Point::new(15.0, 80.0)), 0);
        assert_ne!(sheet.winding(Point::new(120.0, 155.0)), 0);
        assert_ne!(sheet.winding(Point::new(35.0, 3.0)), 0);
        let bounds = sheet.bounding_box();
        assert!(bounds.origin().distance(Point::ZERO) < 1e-9);
        assert!((bounds.width() - 240.0).abs() < 1e-9 && (bounds.height() - 160.0).abs() < 1e-9);
        assert!(geometry.paths[..2].iter().all(|path| !path.stroke));
        assert_eq!(geometry.paths[2].fill, FillMode::None);
    }

    #[test]
    fn scroll_orientation_transposes_all_faces_and_seams() {
        let transpose = Affine::new([0.0, 1.0, 1.0, 0.0, 0.0, 0.0]);
        for adjustment in [6250.0, 12500.0, 25000.0] {
            let vertical = build(true, 240.0, 160.0, adjustment);
            let horizontal = build(false, 160.0, 240.0, adjustment);
            for (a, b) in vertical.paths.iter().zip(&horizontal.paths) {
                assert_eq!(a.fill, b.fill);
                for (a, b) in (transpose * a.path.clone()).segments().zip(b.path.segments()) {
                    for t in [0.0, 0.5, 1.0] {
                        assert!(a.eval(t).distance(b.eval(t)) < 1e-9);
                    }
                }
            }
        }
    }

    #[test]
    fn zero_roll_size_collapses_to_a_plain_sheet() {
        for vertical in [false, true] {
            let geometry = build(vertical, 240.0, 160.0, 0.0);
            assert_eq!(geometry.paths.len(), 1);
            assert!((geometry.paths[0].path.area().abs() - 240.0 * 160.0).abs() < 1e-9);
        }
    }
}
