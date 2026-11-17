//! Curved ribbons assembled from a translated quadratic band and folded tails.

use super::*;
use kurbo::Affine;

struct Band {
    curvature: f64,
}

impl Band {
    fn y(&self, x: f64, offset: f64) -> f64 {
        self.curvature * (2.0 * x - 1.0).powi(2) + offset
    }

    /// The tangent intersection gives the quadratic control point for any
    /// interval, so front and tail edges share one continuous curvature.
    fn edge(&self, path: &mut Pb, from: f64, to: f64, offset: f64) {
        let middle = (from + to) / 2.0;
        let control = (self.y(from, offset) + self.y(to, offset)) / 2.0 - 2.0 * self.curvature * (to - from).powi(2);
        path.q(middle, control, to, self.y(to, offset));
    }
}

pub(super) fn build(up: bool, w: f64, h: f64, height: f64, width: f64, curvature: f64) -> Geometry {
    let rise = height.clamp(0.0, 100000.0) / 1e5;
    let band = Band { curvature: curvature.clamp(0.0, rise * 1e5) / 1e5 };
    let thickness = 1.0 - rise;
    let drop = rise - band.curvature;
    let left = (1.0 - width.clamp(25000.0, 75000.0) / 1e5) / 2.0;
    let right = 1.0 - left;
    let inner = left + 0.125;
    let mut faces = Pb::new();
    let mut folds = Pb::new();
    let mut outline = Pb::new();

    for mirror in [false, true] {
        let mut tail = Pb::new();
        tail.m(0.0, band.y(0.0, drop));
        band.edge(&mut tail, 0.0, inner, drop);
        tail.l(inner, band.y(inner, drop + thickness));
        band.edge(&mut tail, inner, 0.0, drop + thickness);
        tail.l(0.125, band.y(0.125, drop + thickness / 2.0)).z();

        let mut fold = Pb::new();
        fold.m(left, band.y(left, thickness));
        band.edge(&mut fold, left, inner, thickness);
        fold.l(inner, band.y(inner, drop + thickness)).z();

        // Only the exposed tail edges are stroked. The front band occludes
        // the rest, including the upper section of the inner vertical edge.
        let mut visible = Pb::new();
        visible.m(0.0, band.y(0.0, drop));
        band.edge(&mut visible, 0.0, left, drop);
        visible.m(inner, band.y(inner, thickness)).l(inner, band.y(inner, drop + thickness));
        band.edge(&mut visible, inner, 0.0, drop + thickness);
        visible.l(0.125, band.y(0.125, drop + thickness / 2.0)).l(0.0, band.y(0.0, drop));
        visible.m(left, band.y(left, thickness)).l(inner, band.y(inner, drop + thickness));

        let transform = if mirror { Affine::new([-1.0, 0.0, 0.0, 1.0, 1.0, 0.0]) } else { Affine::IDENTITY };
        faces.p.extend((transform * tail.take()).elements().iter().copied());
        folds.p.extend((transform * fold.take()).elements().iter().copied());
        outline.p.extend((transform * visible.take()).elements().iter().copied());
    }

    let mut front = Pb::new();
    front.m(left, band.y(left, 0.0));
    band.edge(&mut front, left, right, 0.0);
    front.l(right, band.y(right, thickness));
    band.edge(&mut front, right, left, thickness);
    front.z();
    let front = front.take();
    outline.p.extend(front.elements().iter().copied());

    let transform = if up { Affine::scale_non_uniform(w, h) } else { Affine::new([w, 0.0, 0.0, -h, 0.0, h]) };
    let mut shaded = fill_only(transform * folds.take());
    shaded.fill = FillMode::DarkenLess;
    let top = band.y(left, 0.0);
    let text_rect =
        if up { Rect::new(left * w, top * h, right * w, thickness * h) } else { Rect::new(left * w, (1.0 - thickness) * h, right * w, (1.0 - top) * h) };
    Geometry {
        paths: vec![fill_only(transform * faces.take()), shaded, fill_only(transform * front), stroke_only(transform * outline.take())],
        text_rect,
        handles: vec![],
        sites: mid_sites(w, h),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use kurbo::ParamCurve;

    #[test]
    fn front_band_curves_have_constant_thickness_and_no_hidden_strokes() {
        let geometry = super::super::build("ellipseRibbon2", 200.0, 100.0, &[]).unwrap();
        assert!(geometry.paths[..3].iter().all(|path| !path.stroke));
        assert_eq!(geometry.paths[3].fill, FillMode::None);
        let segments: Vec<_> = geometry.paths[2].path.segments().collect();
        for t in [0.0, 0.25, 0.5, 0.75, 1.0] {
            let top = segments[0].eval(t);
            let bottom = segments[2].eval(1.0 - t);
            assert!((top.x - bottom.x).abs() < 1e-9);
            assert!((bottom.y - top.y - 75.0).abs() < 1e-9);
        }
        let bounds = geometry.outline().bounding_box();
        assert_eq!(bounds, Rect::new(0.0, 0.0, 200.0, 100.0));
    }

    #[test]
    fn curved_ribbon_variants_are_vertical_reflections() {
        for adjustments in [vec![], vec![35000.0, 65000.0, 20000.0], vec![18000.0, 30000.0, 5000.0]] {
            let up = super::super::build("ellipseRibbon2", 160.0, 90.0, &adjustments).unwrap();
            let down = super::super::build("ellipseRibbon", 160.0, 90.0, &adjustments).unwrap();
            let mirror = Affine::new([1.0, 0.0, 0.0, -1.0, 0.0, 90.0]);
            for (a, b) in up.paths.iter().zip(&down.paths) {
                for (a, b) in (mirror * a.path.clone()).segments().zip(b.path.segments()) {
                    for t in [0.0, 0.5, 1.0] {
                        assert!(a.eval(t).distance(b.eval(t)) < 1e-9);
                    }
                }
            }
        }
    }
}
