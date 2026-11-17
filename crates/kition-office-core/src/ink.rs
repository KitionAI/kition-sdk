//! Ink (`KitDrawing` 1.2): pen, pencil and highlighter strokes, the gestures that draw and erase
//! them, and the `drawing.ink` and `drawing.erase` parameters.
//!
//! A kit keeps strokes its own way (Slide: an ink shape holding a slide's strokes; Word: a
//! floating freeform per stroke; Sheet: an ink shape per stroke) and its own coordinates (slide,
//! page or sheet points). This module is the contract between them: a stroke described the same
//! way in every kit, a drawing gesture that previews while the pointer moves and makes one stroke
//! on release (one undo step), and an eraser gesture whose path takes the strokes it touches.

use kurbo::{BezPath, Point};
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub mod inkml;

use crate::model::Color;
use crate::ops::DrawingError;

/// Most points one stroke keeps (a long scribble is simplified to fit).
pub const MAX_POINTS: usize = 5_000;
/// Most strokes one `drawing.ink` adds.
pub const MAX_STROKES: usize = 500;
/// Thinnest and thickest ink, points.
pub const MIN_WIDTH: f64 = 0.25;
pub const MAX_WIDTH: f64 = 72.0;
/// Points closer than this (points) to the last kept one are dropped while drawing.
pub const MIN_STEP: f64 = 0.35;

/// What drew a stroke.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum InkTool {
    #[default]
    Pen,
    Pencil,
    /// Drawn translucent and behind text.
    Highlighter,
}

impl InkTool {
    pub fn parse(name: &str) -> Option<InkTool> {
        serde_json::from_value(Value::String(name.into())).ok()
    }
    /// The width a new stroke of this tool has, points.
    pub fn default_width(self) -> f64 {
        match self {
            InkTool::Pen => 1.5,
            InkTool::Pencil => 1.0,
            InkTool::Highlighter => 12.0,
        }
    }
    /// The opacity of this tool's ink, 0 to 1.
    pub fn alpha(self) -> f64 {
        match self {
            InkTool::Highlighter => 0.5,
            InkTool::Pencil => 0.85,
            InkTool::Pen => 1.0,
        }
    }
}

/// One stroke: points (x, y in the kit's coordinates, pressure 0 to 1) drawn with a tool.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct InkStroke {
    pub tool: InkTool,
    pub color: Option<Color>,
    /// Points.
    pub width: f64,
    pub points: Vec<[f64; 3]>,
}

impl InkStroke {
    /// Its points as kurbo points (pressure dropped).
    pub fn path(&self) -> Vec<Point> {
        self.points.iter().map(|p| Point::new(p[0], p[1])).collect()
    }
    /// Its centre line as a path (one point: a dot, as a zero-length segment).
    pub fn centre_line(&self) -> BezPath {
        centre_line(self.points.iter().map(|p| Point::new(p[0], p[1])))
    }
    /// The box around its ink (its width included).
    pub fn bounds(&self) -> kurbo::Rect {
        let half = self.width / 2.0;
        let mut it = self.points.iter();
        let Some(first) = it.next() else { return kurbo::Rect::ZERO };
        let mut r = kurbo::Rect::new(first[0], first[1], first[0], first[1]);
        for p in it {
            r = r.union_pt(Point::new(p[0], p[1]));
        }
        r.inflate(half, half)
    }
    /// Whether ink of it lies within `radius` of `p`.
    pub fn touches(&self, p: Point, radius: f64) -> bool {
        let reach = radius + self.width / 2.0;
        let pts = self.path();
        match pts.as_slice() {
            [] => false,
            [only] => only.distance(p) <= reach,
            _ => pts.windows(2).any(|w| segment_distance(p, w[0], w[1]) <= reach),
        }
    }
    /// Whether the eraser path `path` (radius `radius`) touches it.
    pub fn touched_by(&self, path: &[Point], radius: f64) -> bool {
        if !self.bounds().inflate(radius, radius).contains_rect_loose(path) {
            return false;
        }
        let reach = radius + self.width / 2.0;
        let mine = self.path();
        match path {
            [] => false,
            [only] => self.touches(*only, radius),
            _ => path.windows(2).any(|e| match mine.as_slice() {
                [] => false,
                [only] => segment_distance(*only, e[0], e[1]) <= reach,
                _ => mine.windows(2).any(|s| segments_distance(e[0], e[1], s[0], s[1]) <= reach),
            }),
        }
    }
}

/// Shared centre-line construction for native kit ink representations.
/// A single sample is a drawable zero-length segment, not an empty move.
pub fn centre_line(points: impl IntoIterator<Item = Point>) -> BezPath {
    let mut path = BezPath::new();
    let mut points = points.into_iter();
    if let Some(first) = points.next() {
        path.move_to(first);
        let mut any = false;
        for point in points {
            path.line_to(point);
            any = true;
        }
        if !any {
            path.line_to(first);
        }
    }
    path
}

trait LooseContains {
    fn contains_rect_loose(&self, path: &[Point]) -> bool;
}

impl LooseContains for kurbo::Rect {
    /// Whether the box around `path` meets this box.
    fn contains_rect_loose(&self, path: &[Point]) -> bool {
        let mut it = path.iter();
        let Some(first) = it.next() else { return false };
        let mut r = kurbo::Rect::from_points(*first, *first);
        for p in it {
            r = r.union_pt(*p);
        }
        r.x0 <= self.x1 && r.x1 >= self.x0 && r.y0 <= self.y1 && r.y1 >= self.y0
    }
}

fn segment_distance(p: Point, a: Point, b: Point) -> f64 {
    let ab = b - a;
    let len2 = ab.hypot2();
    if len2 <= f64::EPSILON {
        return p.distance(a);
    }
    let t = ((p - a).dot(ab) / len2).clamp(0.0, 1.0);
    p.distance(a + ab * t)
}

fn segments_distance(a: Point, b: Point, c: Point, d: Point) -> f64 {
    let cross = |o: Point, p: Point, q: Point| (p - o).cross(q - o);
    let (d1, d2, d3, d4) = (cross(c, d, a), cross(c, d, b), cross(a, b, c), cross(a, b, d));
    if ((d1 > 0.0) != (d2 > 0.0)) && ((d3 > 0.0) != (d4 > 0.0)) {
        return 0.0;
    }
    segment_distance(a, c, d).min(segment_distance(b, c, d)).min(segment_distance(c, a, b)).min(segment_distance(d, a, b))
}

/// Points simplified within `tolerance` (Ramer–Douglas–Peucker, iterative), the first and last
/// kept, at most [`MAX_POINTS`] (the tolerance grows until they fit).
pub fn simplify(points: &[[f64; 3]], tolerance: f64) -> Vec<[f64; 3]> {
    if points.len() <= 2 {
        return points.to_vec();
    }
    let mut tol = tolerance.max(0.0);
    loop {
        let mut keep = vec![false; points.len()];
        keep[0] = true;
        keep[points.len() - 1] = true;
        let mut stack = vec![(0usize, points.len() - 1)];
        while let Some((a, b)) = stack.pop() {
            if b <= a + 1 {
                continue;
            }
            let (pa, pb) = (Point::new(points[a][0], points[a][1]), Point::new(points[b][0], points[b][1]));
            let (mut far, mut at) = (0.0, a);
            for (i, p) in points.iter().enumerate().take(b).skip(a + 1) {
                let d = segment_distance(Point::new(p[0], p[1]), pa, pb);
                if d > far {
                    far = d;
                    at = i;
                }
            }
            if far > tol {
                keep[at] = true;
                stack.push((a, at));
                stack.push((at, b));
            }
        }
        let out: Vec<[f64; 3]> = points.iter().zip(&keep).filter(|(_, k)| **k).map(|(p, _)| *p).collect();
        if out.len() <= MAX_POINTS || tol > 1e6 {
            return out;
        }
        tol = (tol * 2.0).max(0.25);
    }
}

/// Drawing a stroke with the pointer: points are collected (dropping ones closer than
/// [`MIN_STEP`] to the last), [`InkGesture::preview`] is what to show meanwhile, and
/// [`InkGesture::release`] is the one stroke to add (none for a stroke without length but a dot).
#[derive(Clone, Debug)]
pub struct InkGesture {
    pub tool: InkTool,
    pub color: Option<Color>,
    pub width: f64,
    points: Vec<[f64; 3]>,
}

impl InkGesture {
    pub fn start(tool: InkTool, color: Option<Color>, width: f64, at: Point, pressure: f64) -> InkGesture {
        InkGesture { tool, color, width: width.clamp(MIN_WIDTH, MAX_WIDTH), points: vec![[at.x, at.y, pressure.clamp(0.0, 1.0)]] }
    }
    /// The pointer moved to `p`.
    pub fn drag(&mut self, p: Point, pressure: f64) {
        if !(p.x.is_finite() && p.y.is_finite()) || self.points.len() >= MAX_POINTS * 8 {
            return;
        }
        let last = self.points.last().map(|l| Point::new(l[0], l[1]));
        if last.is_none_or(|l| l.distance(p) >= MIN_STEP) {
            self.points.push([p.x, p.y, pressure.clamp(0.0, 1.0)]);
        }
    }
    /// The stroke as drawn so far.
    pub fn preview(&self) -> InkStroke {
        InkStroke { tool: self.tool, color: self.color.clone(), width: self.width, points: self.points.clone() }
    }
    /// The stroke to add: simplified to within a tenth of its width.
    pub fn release(&self) -> InkStroke {
        InkStroke { points: simplify(&self.points, (self.width / 10.0).clamp(0.05, 1.0)), ..self.preview() }
    }
}

/// Erasing with the pointer: the path it has swept so far, which [`EraserGesture::hits`] tests
/// strokes against; a kit erases what it hit on release (one undo step), and may hide the hit
/// strokes meanwhile.
#[derive(Clone, Debug)]
pub struct EraserGesture {
    pub radius: f64,
    path: Vec<Point>,
}

impl EraserGesture {
    pub fn start(at: Point, radius: f64) -> EraserGesture {
        EraserGesture { radius: radius.clamp(0.5, 200.0), path: vec![at] }
    }
    pub fn drag(&mut self, p: Point) {
        if p.x.is_finite() && p.y.is_finite() && self.path.len() < 100_000 {
            self.path.push(p);
        }
    }
    pub fn path(&self) -> &[Point] {
        &self.path
    }
    /// Which of `strokes` (by position) the path so far touches.
    pub fn hits(&self, strokes: &[InkStroke]) -> Vec<usize> {
        strokes.iter().enumerate().filter(|(_, s)| s.touched_by(&self.path, self.radius)).map(|(i, _)| i).collect()
    }
}

/// `drawing.ink` parameters: `{strokes: [{tool?, color?, width?, points: [[x, y, pressure?], …]}]}`
/// (or one stroke's members at the top level). A stroke without a tool, colour or width takes
/// `defaults`'s (the kit's current pen). Points that are not finite numbers are dropped; a stroke
/// left without points is refused.
pub fn parse_strokes(p: &Value, defaults: &InkStroke) -> Result<Vec<InkStroke>, DrawingError> {
    let list: Vec<&Value> = match p.get("strokes") {
        Some(Value::Array(a)) if !a.is_empty() && a.len() <= MAX_STROKES => a.iter().collect(),
        Some(_) => return Err(DrawingError::invalid(format!("`strokes` is a list of 1 to {MAX_STROKES} strokes"))),
        None if p.get("points").is_some() => vec![p],
        None => return Err(DrawingError::invalid("give `strokes` (or one stroke's `points`)")),
    };
    list.into_iter().map(|s| parse_stroke(s, defaults)).collect()
}

fn parse_stroke(s: &Value, defaults: &InkStroke) -> Result<InkStroke, DrawingError> {
    let tool = match s.get("tool") {
        None | Some(Value::Null) => defaults.tool,
        Some(Value::String(t)) => InkTool::parse(t).ok_or_else(|| DrawingError::invalid("`tool` is pen, pencil or highlighter"))?,
        Some(_) => return Err(DrawingError::invalid("`tool` is pen, pencil or highlighter")),
    };
    let color = match s.get("color") {
        None | Some(Value::Null) => defaults.color.clone(),
        Some(c) => Some(Color::from_value(c).ok_or_else(|| DrawingError::invalid("a stroke's colour"))?),
    };
    let width = match s.get("width") {
        None | Some(Value::Null) => {
            if defaults.width > 0.0 {
                defaults.width
            } else {
                tool.default_width()
            }
        }
        Some(v) => v.as_f64().filter(|w| w.is_finite()).ok_or_else(|| DrawingError::invalid("`width` is a number of points"))?,
    }
    .clamp(MIN_WIDTH, MAX_WIDTH);
    let raw = s.get("points").and_then(Value::as_array).ok_or_else(|| DrawingError::invalid("a stroke has `points` ([[x, y], …])"))?;
    let points: Vec<[f64; 3]> = raw
        .iter()
        .take(MAX_POINTS * 8)
        .filter_map(|pt| {
            let a = pt.as_array()?;
            let (x, y) = (a.first()?.as_f64()?, a.get(1)?.as_f64()?);
            let pressure = a.get(2).and_then(Value::as_f64).filter(|v| v.is_finite()).unwrap_or(0.5).clamp(0.0, 1.0);
            (x.is_finite() && y.is_finite() && x.abs() <= crate::ops::MAX_LENGTH && y.abs() <= crate::ops::MAX_LENGTH).then_some([x, y, pressure])
        })
        .collect();
    if points.is_empty() {
        return Err(DrawingError::invalid("a stroke has no usable point"));
    }
    let points = if points.len() > MAX_POINTS { simplify(&points, 0.1) } else { points };
    Ok(InkStroke { tool, color, width, points })
}

/// `drawing.erase` parameters: `{path: [[x, y], …], radius?}` (an eraser drag) or `{x, y,
/// radius?}` (one touch); `radius` defaults to `default_radius`.
pub fn parse_eraser(p: &Value, default_radius: f64) -> Result<EraserGesture, DrawingError> {
    let radius = p.get("radius").and_then(Value::as_f64).filter(|r| r.is_finite()).unwrap_or(default_radius);
    let point = |v: &Value| -> Option<Point> {
        let a = v.as_array()?;
        let (x, y) = (a.first()?.as_f64()?, a.get(1)?.as_f64()?);
        (x.is_finite() && y.is_finite()).then_some(Point::new(x, y))
    };
    let pts: Vec<Point> = match (p.get("path"), p.get("x").and_then(Value::as_f64), p.get("y").and_then(Value::as_f64)) {
        (Some(Value::Array(a)), _, _) => a.iter().take(100_000).filter_map(point).collect(),
        (None, Some(x), Some(y)) if x.is_finite() && y.is_finite() => vec![Point::new(x, y)],
        _ => return Err(DrawingError::invalid("give the eraser's `path` ([[x, y], …]) or a point (`x`, `y`)")),
    };
    let mut it = pts.into_iter();
    let first = it.next().ok_or_else(|| DrawingError::invalid("the eraser's path has no usable point"))?;
    let mut g = EraserGesture::start(first, radius);
    for p in it {
        g.drag(p);
    }
    Ok(g)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn line(x0: f64, y0: f64, x1: f64, y1: f64) -> InkStroke {
        InkStroke { width: 2.0, points: vec![[x0, y0, 0.5], [x1, y1, 0.5]], ..Default::default() }
    }

    #[test]
    fn a_gesture_collects_spaced_points_and_releases_a_simplified_stroke() {
        let mut g = InkGesture::start(InkTool::Pen, None, 2.0, Point::new(0.0, 0.0), 0.5);
        for i in 1..=100 {
            g.drag(Point::new(f64::from(i), 0.0), 0.6);
            g.drag(Point::new(f64::from(i) + 0.01, 0.0), 0.6);
        }
        assert_eq!(g.preview().points.len(), 101, "points closer than the step are dropped");
        let s = g.release();
        assert_eq!(s.points.len(), 2, "a straight line keeps its ends");
        assert_eq!((s.points[0][0], s.points[1][0]), (0.0, 100.0));
        let dot = InkGesture::start(InkTool::Highlighter, None, 500.0, Point::new(5.0, 5.0), 0.5).release();
        assert_eq!((dot.points.len(), dot.width), (1, MAX_WIDTH), "a dot is a stroke; the width is bounded");
    }

    #[test]
    fn the_eraser_takes_the_strokes_its_path_touches() {
        let strokes = vec![line(0.0, 0.0, 100.0, 0.0), line(0.0, 50.0, 100.0, 50.0), line(200.0, 0.0, 200.0, 100.0)];
        let mut e = EraserGesture::start(Point::new(50.0, -20.0), 2.0);
        e.drag(Point::new(50.0, 20.0));
        assert_eq!(e.hits(&strokes), vec![0], "a path crossing a stroke takes it");
        e.drag(Point::new(50.0, 49.0));
        assert_eq!(e.hits(&strokes), vec![0, 1], "a path ending within reach takes it");
        assert!(strokes[2].touches(Point::new(200.9, 50.0), 0.0), "within half the width");
        assert!(!strokes[2].touches(Point::new(202.0, 50.0), 0.5));
    }

    #[test]
    fn strokes_and_erasers_parse_from_command_parameters() {
        let pen = InkStroke { tool: InkTool::Pencil, width: 3.0, ..Default::default() };
        let s = parse_strokes(&json!({ "strokes": [{ "points": [[1, 2], [3, 4, 0.9], ["x", 1], [f64::MAX, 0]] }, { "tool": "highlighter", "color": "#FFFF00", "points": [[0, 0]] }] }), &pen).unwrap();
        assert_eq!((s[0].tool, s[0].width, s[0].points.clone()), (InkTool::Pencil, 3.0, vec![[1.0, 2.0, 0.5], [3.0, 4.0, 0.9]]));
        assert_eq!((s[1].tool, s[1].width), (InkTool::Highlighter, 3.0));
        assert!(s[1].color.is_some());
        assert!(parse_strokes(&json!({ "points": [] }), &pen).is_err());
        assert!(parse_strokes(&json!({ "strokes": [] }), &pen).is_err());
        assert!(parse_strokes(&json!({ "strokes": [{ "tool": "brush", "points": [[0, 0]] }] }), &pen).is_err());
        let e = parse_eraser(&json!({ "x": 5, "y": 6 }), 4.0).unwrap();
        assert_eq!((e.path().len(), e.radius), (1, 4.0));
        assert!(parse_eraser(&json!({ "path": [] }), 4.0).is_err());
    }

    #[test]
    fn simplifying_keeps_shape_and_fits_the_limit() {
        // A long wave: simplified to fit, its ends kept, never far from where it was drawn.
        let wave: Vec<[f64; 3]> = (0..20_000).map(|i| [f64::from(i) * 0.5, (f64::from(i) / 40.0).sin() * 100.0, 0.5]).collect();
        let s = simplify(&wave, 0.1);
        assert!(s.len() <= MAX_POINTS && s.len() > 100, "{}", s.len());
        assert_eq!((s.first(), s.last()), (wave.first(), wave.last()));
        let kept = InkStroke { points: s, ..Default::default() };
        assert!(wave.iter().step_by(97).all(|p| kept.touches(Point::new(p[0], p[1]), 2.0)), "close to the drawn wave");
    }
}
