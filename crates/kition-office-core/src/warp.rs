//! Text warp (`KitDrawing 1.3`, WordArt): a text body laid out flat in its box, then bent by a
//! DrawingML preset (`a:prstTxWarp@prst`).
//!
//! Each preset is an envelope (the curves the text's top and bottom follow across the box, the
//! text stretched between them) or an arch (the text along an ellipse). The curves approximate
//! Office's preset text warp definitions: the same families and directions, not their exact
//! guide formulas.

use kurbo::{BezPath, PathEl, Point};

pub mod follow;

/// The presets [`warp_point`] bends text by, as `a:prstTxWarp@prst` names them.
pub const WARPS: [&str; 22] = [
    "textPlain",
    "textArchUp",
    "textArchDown",
    "textCircle",
    "textWave1",
    "textWave2",
    "textDoubleWave1",
    "textInflate",
    "textDeflate",
    "textSlantUp",
    "textSlantDown",
    "textTriangle",
    "textTriangleInverted",
    "textChevron",
    "textChevronInverted",
    "textCurveUp",
    "textCurveDown",
    "textCanUp",
    "textCanDown",
    "textFadeRight",
    "textFadeLeft",
    "textStop",
];

/// Is `name` a warp this module bends text by?
pub fn is_warp(name: &str) -> bool {
    WARPS.contains(&name)
}

/// A preset's main adjust value (`adj`, or `adj1`) in DrawingML units (100000 is the whole box,
/// angles in 60000ths of a degree), else its default.
fn adjust_of(name: &str, adjust: &[(String, f64)]) -> f64 {
    let given = adjust.iter().find(|(n, v)| (n == "adj" || n == "adj1") && v.is_finite()).map(|(_, v)| *v);
    given.unwrap_or(match name {
        "textArchUp" | "textCircle" => 10_800_000.0,
        "textArchDown" => 0.0,
        "textWave1" | "textWave2" => 12_500.0,
        "textDoubleWave1" => 6_250.0,
        "textInflate" | "textDeflate" => 18_750.0,
        "textSlantUp" => 55_556.0,
        "textSlantDown" => 44_444.0,
        "textTriangle" | "textTriangleInverted" => 50_000.0,
        "textChevron" | "textChevronInverted" => 25_000.0,
        "textCurveUp" | "textCurveDown" => 45_977.0,
        "textCanUp" => 85_000.0,
        "textCanDown" => 14_286.0,
        "textFadeRight" | "textFadeLeft" => 33_333.0,
        "textStop" => 25_000.0,
        _ => 0.0,
    })
}

/// An envelope: the top and bottom of the text at `t` across the box (0 left, 1 right), as
/// fractions of its height, for adjust value `adj` ([`adjust_of`]). At the defaults the curves
/// are those of `KitDrawing 1.3`'s first release.
fn envelope(name: &str, t: f64, adj: f64) -> Option<(f64, f64)> {
    use std::f64::consts::PI;
    let f = (adj / 100_000.0).clamp(0.0, 1.0);
    let mid = (2.0 * t - 1.0).abs(); // 1 at the edges, 0 in the middle
    Some(match name {
        "textPlain" => (0.0, 1.0),
        "textWave1" | "textWave2" | "textDoubleWave1" => {
            let a = (adj / 100_000.0).clamp(0.0, 0.2) * if name == "textDoubleWave1" { 1.6 } else { 0.96 };
            let turns = if name == "textDoubleWave1" { 4.0 } else { 2.0 };
            let wave = (turns * PI * t).sin() * if name == "textWave2" { -1.0 } else { 1.0 };
            (a + a * wave, 1.0 - a + a * wave)
        }
        "textInflate" => {
            let k = (f * 4.0 / 3.0).min(0.45);
            (k * mid * mid, 1.0 - k * mid * mid)
        }
        "textDeflate" => {
            let k = (f * 4.0 / 3.0).min(0.45);
            (k * (1.0 - mid * mid), 1.0 - k * (1.0 - mid * mid))
        }
        "textSlantUp" => {
            let k = ((1.0 - f) * 0.675).min(0.9);
            (k * (1.0 - t), 1.0 - k + k * (1.0 - t))
        }
        "textSlantDown" => {
            let k = (f * 0.675).min(0.9);
            (k * t, 1.0 - k + k * t)
        }
        "textTriangle" | "textTriangleInverted" => {
            // The peak at `adj` across the box.
            let peak = f.clamp(0.01, 0.99);
            let off = if t < peak { 1.0 - t / peak } else { (t - peak) / (1.0 - peak) };
            if name == "textTriangle" { (0.85 * off, 1.0) } else { (0.0, 1.0 - 0.85 * off) }
        }
        "textChevron" => {
            let k = (f * 1.2).min(0.9);
            (k * mid, 1.0 - k + k * mid)
        }
        "textChevronInverted" => {
            let k = (f * 1.2).min(0.9);
            (k * (1.0 - mid), 1.0 - k + k * (1.0 - mid))
        }
        "textCurveUp" => {
            let k = (f * 0.6525).min(0.9);
            (k * (1.0 - t) * (1.0 - t), 1.0 - k + k * (1.0 - t) * (1.0 - t))
        }
        "textCurveDown" => {
            let k = (f * 0.6525).min(0.9);
            (k * t * t, 1.0 - k + k * t * t)
        }
        "textCanUp" => {
            let k = ((1.0 - f) * 4.0 / 3.0).min(0.45);
            (k * (PI * t).sin(), 1.0 - k + k * (PI * t).sin())
        }
        "textCanDown" => {
            let k = (f * 1.4).min(0.45);
            (k * (1.0 - (PI * t).sin()), 1.0 - k + k * (1.0 - (PI * t).sin()))
        }
        "textFadeRight" => {
            let k = (f * 0.9).min(0.45);
            (k * t, 1.0 - k * t)
        }
        "textFadeLeft" => {
            let k = (f * 0.9).min(0.45);
            (k * (1.0 - t), 1.0 - k * (1.0 - t))
        }
        "textStop" => {
            // An octagon's sides: the corners cut by `adj` of the box.
            let c = (f * 0.8).clamp(0.01, 0.45);
            let cut = ((c - t.min(1.0 - t)) / c).clamp(0.0, 1.0) * c;
            (cut, 1.0 - cut)
        }
        _ => return None,
    })
}

/// Where point `p` of text laid out flat in a `w` × `h` box goes once bent by `preset` at its
/// default adjust values; `p` unchanged for an unknown preset or an empty box.
pub fn warp_point(preset: &str, w: f64, h: f64, p: Point) -> Point {
    warp_point_adj(preset, &[], w, h, p)
}

/// [`warp_point`] with the preset's adjust values by guide name (`adj`, `adj1`), as the file or
/// `drawing.text` gives them; the arches take their angle, the envelopes their depth.
pub fn warp_point_adj(preset: &str, adjust: &[(String, f64)], w: f64, h: f64, p: Point) -> Point {
    if !(w > 0.0 && h > 0.0 && p.x.is_finite() && p.y.is_finite()) {
        return p;
    }
    let adj = adjust_of(preset, adjust);
    let (u, v) = (p.x / w, p.y / h);
    let (cx, cy, rx, ry) = (w / 2.0, h / 2.0, w / 2.0, h / 2.0);
    use std::f64::consts::PI;
    let deg = adj / 60_000.0;
    match preset {
        // Along the top of the box's ellipse, left to right, its top outward: the arc runs
        // symmetrically about the top from the adjust angle (180° at the default: a half).
        "textArchUp" | "textCircle" => {
            let sweep = if preset == "textCircle" { (2.0 * (270.0 - deg) + 180.0).clamp(10.0, 360.0) } else { (2.0 * (270.0 - deg)).clamp(10.0, 360.0) };
            let sweep = sweep.to_radians();
            let a = PI / 2.0 + sweep / 2.0 - u * sweep;
            let s = 1.0 - 0.45 * v.clamp(-1.0, 2.0);
            Point::new(cx + rx * s * a.cos(), cy - ry * s * a.sin())
        }
        // Along the bottom, left to right, its top toward the middle.
        "textArchDown" => {
            let sweep = (2.0 * (90.0 - deg).abs()).clamp(10.0, 360.0).to_radians();
            let a = PI / 2.0 + sweep / 2.0 - u * sweep;
            let s = 0.55 + 0.45 * v.clamp(-1.0, 2.0);
            Point::new(cx + rx * s * a.cos(), cy + ry * s * a.sin())
        }
        name => match envelope(name, u.clamp(0.0, 1.0), adj) {
            Some((top, bottom)) => Point::new(p.x, h * (top + (bottom - top) * v)),
            None => p,
        },
    }
}

/// Path `path` (text outlines laid out flat in a `w` × `h` box) bent by `preset`: flattened to
/// short lines first, so straight strokes curve with the warp.
pub fn warp_path(preset: &str, w: f64, h: f64, path: &BezPath) -> BezPath {
    warp_path_adj(preset, &[], w, h, path)
}

/// [`warp_path`] with the preset's adjust values ([`warp_point_adj`]).
pub fn warp_path_adj(preset: &str, adjust: &[(String, f64)], w: f64, h: f64, path: &BezPath) -> BezPath {
    if !is_warp(preset) || preset == "textPlain" {
        return path.clone();
    }
    let tolerance = (w.min(h) / 400.0).clamp(0.05, 1.0);
    let mut out = BezPath::new();
    let mut last = Point::ZERO;
    let step = (w.max(h) / 200.0).max(0.5);
    kurbo::flatten(path.iter(), tolerance, |el| match el {
        PathEl::MoveTo(p) => {
            out.move_to(warp_point_adj(preset, adjust, w, h, p));
            last = p;
        }
        PathEl::LineTo(p) => {
            // Long straight runs are split so they bend too.
            let n = ((p - last).hypot() / step).ceil().clamp(1.0, 64.0) as usize;
            for k in 1..=n {
                let q = last.lerp(p, k as f64 / n as f64);
                out.line_to(warp_point_adj(preset, adjust, w, h, q));
            }
            last = p;
        }
        PathEl::ClosePath => out.close_path(),
        _ => {}
    });
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn envelopes_bend_the_text_between_their_curves() {
        let (w, h) = (200.0, 100.0);
        // Plain leaves text as it is.
        assert_eq!(warp_point("textPlain", w, h, Point::new(30.0, 40.0)), Point::new(30.0, 40.0));
        assert_eq!(warp_point("bogus", w, h, Point::new(30.0, 40.0)), Point::new(30.0, 40.0));
        // Inflate: tall in the middle, short at the edges.
        let top_mid = warp_point("textInflate", w, h, Point::new(100.0, 0.0));
        let top_edge = warp_point("textInflate", w, h, Point::new(0.0, 0.0));
        assert!(top_mid.y < top_edge.y, "{top_mid:?} {top_edge:?}");
        // Slant up: the right side is higher.
        assert!(warp_point("textSlantUp", w, h, Point::new(200.0, 50.0)).y < warp_point("textSlantUp", w, h, Point::new(0.0, 50.0)).y);
        // Every envelope keeps the text inside the box, top above bottom.
        for name in WARPS.iter().filter(|n| !n.starts_with("textArch") && **n != "textCircle") {
            for k in 0..=20 {
                let t = k as f64 / 20.0;
                let (top, bottom) = envelope(name, t, adjust_of(name, &[])).unwrap();
                assert!((0.0..=1.0).contains(&top) && (0.0..=1.0).contains(&bottom) && top < bottom, "{name} at {t}: {top} {bottom}");
            }
        }
    }

    #[test]
    fn arches_follow_the_ellipse_and_paths_bend_with_them() {
        let (w, h) = (200.0, 100.0);
        // Arch up: the middle of the text's top is at the top of the box, its ends at the sides.
        let top = warp_point("textArchUp", w, h, Point::new(100.0, 0.0));
        assert!((top.x - 100.0).abs() < 1e-6 && top.y.abs() < 1e-6, "{top:?}");
        let left = warp_point("textArchUp", w, h, Point::new(0.0, 0.0));
        assert!(left.x.abs() < 1e-6 && (left.y - 50.0).abs() < 1e-6, "{left:?}");
        // Arch down: the middle at the bottom.
        let bottom = warp_point("textArchDown", w, h, Point::new(100.0, 100.0));
        assert!((bottom.y - 100.0).abs() < 1e-6, "{bottom:?}");
        // A straight baseline across the box bends into a curve.
        let mut line = BezPath::new();
        line.move_to((0.0, 80.0));
        line.line_to((200.0, 80.0));
        let bent = warp_path("textArchUp", w, h, &line);
        let ys: Vec<f64> = bent.elements().iter().filter_map(|e| if let PathEl::LineTo(p) = e { Some(p.y) } else { None }).collect();
        assert!(ys.len() > 10 && ys.iter().cloned().fold(f64::MAX, f64::min) < ys[0] - 10.0, "{ys:?}");
        assert_eq!(warp_path("textPlain", w, h, &line), line);
    }

    #[test]
    fn adjust_values_change_the_bend_and_defaults_keep_it() {
        let (w, h) = (200.0, 100.0);
        let at = |preset: &str, adj: &[(String, f64)], x: f64, y: f64| warp_point_adj(preset, adj, w, h, Point::new(x, y));
        let adj = |v: f64| vec![("adj".to_string(), v)];
        // The defaults, given or not, bend alike.
        for (name, d) in [("textInflate", 18_750.0), ("textArchUp", 10_800_000.0), ("textWave1", 12_500.0), ("textArchDown", 0.0)] {
            let key = if name == "textWave1" { "adj1" } else { "adj" };
            assert_eq!(at(name, &[(key.to_string(), d)], 30.0, 10.0), warp_point(name, w, h, Point::new(30.0, 10.0)), "{name}");
        }
        // A deeper inflate pinches the edges more; a flatter arch keeps its ends higher.
        assert!(at("textInflate", &adj(30_000.0), 0.0, 0.0).y > at("textInflate", &[], 0.0, 0.0).y);
        assert!(at("textArchUp", &adj(13_500_000.0), 0.0, 0.0).y < at("textArchUp", &[], 0.0, 0.0).y);
        // A bigger wave swings further.
        assert!(at("textWave1", &[("adj1".to_string(), 20_000.0)], 50.0, 0.0).y > at("textWave1", &[], 50.0, 0.0).y);
        // Arch down still runs left to right along the bottom.
        assert!(at("textArchDown", &[], 0.0, 100.0).x < at("textArchDown", &[], 200.0, 100.0).x);
        assert!((at("textArchDown", &[], 100.0, 100.0).y - 100.0).abs() < 1e-6);
        // Wild values stay inside the box.
        for v in [-1e12, 0.0, 1e12, f64::NAN] {
            for name in WARPS.iter().filter(|n| !n.starts_with("textArch") && **n != "textCircle") {
                let p = at(name, &adj(v), 120.0, 50.0);
                assert!(p.y.is_finite() && (-1.0..=101.0).contains(&p.y), "{name} {v}: {p:?}");
            }
        }
    }
}
