//! Shared geometry for drawable zero-length subpaths.
//!
//! SVG defines round/square caps even for closed subpaths of zero length, while
//! a move without any drawing command has no stroke. These contours supplement
//! stroke expanders which discard equal-point segments; they contain no paint.
//! https://www.w3.org/TR/SVG2/painting.html#LineCaps

use kurbo::{BezPath, Cap, Circle, PathEl, Point, Rect, Shape, Stroke};

const MAX_ELEMENTS: usize = 100_000;

#[derive(Clone, Copy)]
struct Subpath {
    start: Point,
    current: Point,
    drawable: bool,
    nonzero: bool,
}

impl Subpath {
    fn new(point: Point) -> Self {
        Self { start: point, current: point, drawable: false, nonzero: false }
    }

    fn segment(&mut self, points: &[Point]) -> Option<()> {
        self.drawable = true;
        for point in points {
            if !valid_point(*point) {
                return None;
            }
            self.nonzero |= *point != self.current;
        }
        self.current = *points.last()?;
        Some(())
    }

    fn append_cap(&self, out: &mut BezPath, cap: Cap, radius: f64, tolerance: f64) -> Option<()> {
        if !self.drawable || self.nonzero {
            return Some(());
        }
        let mut append = |element| {
            if out.elements().len() >= MAX_ELEMENTS {
                return None;
            }
            out.push(element);
            Some(())
        };
        match cap {
            Cap::Round => {
                for element in Circle::new(self.start, radius).path_elements(tolerance) {
                    append(element)?;
                }
            }
            Cap::Square => {
                let p = self.start;
                for element in Rect::new(p.x - radius, p.y - radius, p.x + radius, p.y + radius).path_elements(tolerance) {
                    append(element)?;
                }
            }
            Cap::Butt => {}
        }
        Some(())
    }
}

fn valid_point(point: Point) -> bool {
    point.is_finite() && point.x.abs().max(point.y.abs()) <= crate::ops::MAX_LENGTH
}

/// Positive-winding cap contours for entirely zero-length drawable subpaths.
///
/// Append these to an expanded stroke and fill their union once with the same
/// paint. Apply the object's transform afterwards, so nonuniform scaling also
/// scales the caps. No contour is returned for a bare move or a nonzero subpath.
///
/// The bounded initial profile is undashed strokes with equal round or square
/// start/end caps. Unsupported styles or invalid/oversized geometry return None;
/// callers retain their existing stroke path in that case.
pub fn zero_length_caps(path: &BezPath, stroke: &Stroke, tolerance: f64) -> Option<BezPath> {
    if stroke.start_cap != stroke.end_cap
        || stroke.start_cap == Cap::Butt
        || !stroke.dash_pattern.is_empty()
        || !stroke.width.is_finite()
        || stroke.width <= 0.0
        || stroke.width > crate::ops::MAX_LENGTH
        || !tolerance.is_finite()
        || tolerance <= 0.0
        || path.elements().len() > MAX_ELEMENTS
    {
        return None;
    }
    let radius = stroke.width / 2.0;
    if radius == 0.0 {
        return None;
    }
    let mut out = BezPath::new();
    let mut subpath: Option<Subpath> = None;
    for element in path.elements() {
        match *element {
            PathEl::MoveTo(point) => {
                if !valid_point(point) {
                    return None;
                }
                if let Some(previous) = subpath {
                    previous.append_cap(&mut out, stroke.start_cap, radius, tolerance)?;
                }
                subpath = Some(Subpath::new(point));
            }
            PathEl::LineTo(point) => subpath.as_mut()?.segment(&[point])?,
            PathEl::QuadTo(control, point) => subpath.as_mut()?.segment(&[control, point])?,
            PathEl::CurveTo(first, second, point) => subpath.as_mut()?.segment(&[first, second, point])?,
            PathEl::ClosePath => {
                let previous = subpath.as_mut()?;
                previous.segment(&[previous.start])?;
                previous.append_cap(&mut out, stroke.start_cap, radius, tolerance)?;
                // A following drawing command starts again at the closed start.
                subpath = Some(Subpath::new(previous.start));
            }
        }
    }
    if let Some(previous) = subpath {
        previous.append_cap(&mut out, stroke.start_cap, radius, tolerance)?;
    }
    (!out.elements().is_empty()).then_some(out)
}

#[cfg(test)]
mod tests;
