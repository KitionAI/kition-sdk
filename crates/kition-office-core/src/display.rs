//! What to paint for a drawing object: its geometry as paths in object-local space with
//! resolved paints, and where its text goes. Each kit rasterizes the list with its own renderer
//! and lays the text out with its own text engine; colors from a theme come from the kit through
//! [`Resources`].

use kurbo::{Affine, BezPath, Rect};

use crate::model::{Color, ColorBase, CustomPath, DrawingObject, Fill, ObjectKind, Rgb};
use crate::preset::FillMode;

/// What the kit resolves for the shared code.
pub trait Resources {
    /// A theme slot's color (`accent1`, `tx1`…) in the object's context.
    fn theme_color(&self, slot: &str) -> Option<Rgb>;
    /// The fill an object without its own fill gets (a style's, a theme's), if any; also the
    /// flat paint for a fill the display list does not draw ([`Fill::Other`]).
    fn default_fill(&self, _o: &DrawingObject) -> Option<Rgba> {
        None
    }
    /// The outline an object without its own outline gets, if any: color and width.
    fn default_stroke(&self, _o: &DrawingObject) -> Option<(Rgba, f64)> {
        None
    }
}

/// Straight (not premultiplied) RGBA.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Rgba(pub u8, pub u8, pub u8, pub u8);

/// One thing to paint, in object-local space (0..w, 0..h); `transform` maps it to the parent.
#[derive(Clone, Debug, PartialEq)]
pub enum Item {
    Fill { path: BezPath, paint: Rgba, even_odd: bool },
    Stroke { path: BezPath, paint: Rgba, width: f64, dash: Vec<f64> },
}

/// An object's paint list.
#[derive(Clone, Debug, PartialEq)]
pub struct DisplayList {
    /// Object-local space to the frame's parent space (rotation and flips included).
    pub transform: Affine,
    pub items: Vec<Item>,
    /// Where the text goes, object-local; text itself is not mirrored by flips.
    pub text_rect: Rect,
}

/// A text box has no fill or outline of its own unless it is given one.
pub fn display_list(o: &DrawingObject, res: &dyn Resources) -> DisplayList {
    let g = crate::edit::outline(o);
    let fill = match &o.fill {
        Some(Fill::None) => None,
        Some(Fill::Solid(c)) => resolve(c, res),
        // A gradient is the kit's to paint; its first colour stands in here.
        Some(Fill::Gradient(g)) => g.stops.first().and_then(|s| resolve(&s.color, res)),
        // A picture or pattern is the kit's to paint; `default_fill` may stand in.
        Some(Fill::Other(_)) => res.default_fill(o),
        None if o.kind == ObjectKind::TextBox => None,
        None => res.default_fill(o),
    };
    let stroke = match &o.stroke {
        Some(s) if s.none => None,
        Some(s) => {
            let base = if o.kind == ObjectKind::TextBox { None } else { res.default_stroke(o) };
            let paint = s.color.as_ref().and_then(|c| resolve(c, res)).or(base.map(|b| b.0));
            paint.map(|paint| (paint, s.width.or(base.map(|b| b.1)).unwrap_or(0.75), s.dash.as_deref().map(dash_pattern).unwrap_or_default()))
        }
        None if o.kind == ObjectKind::TextBox => None,
        None => res.default_stroke(o).map(|(paint, width)| (paint, width, Vec::new())),
    };
    let mut items = Vec::new();
    for sub in &g.paths {
        if let Some(paint) = fill
            && sub.fill != FillMode::None
        {
            items.push(Item::Fill { path: sub.path.clone(), paint: shade(paint, sub.fill), even_odd: sub.even_odd });
        }
    }
    if let Some((paint, width, dash)) = stroke {
        for sub in g.paths.iter().filter(|s| s.stroke) {
            let width = width.max(0.0);
            items.push(Item::Stroke { path: sub.path.clone(), paint, width, dash: dash.iter().map(|d| d * width.max(0.25)).collect() });
        }
    }
    DisplayList { transform: o.frame.affine(), items, text_rect: g.text_rect }
}

/// A color resolved against the kit's theme, its transforms applied.
pub fn resolve(c: &Color, res: &dyn Resources) -> Option<Rgba> {
    let Rgb(mut r, mut g, mut b) = match &c.base {
        ColorBase::Rgb { rgb } => *rgb,
        ColorBase::Theme { theme } => res.theme_color(theme)?,
    };
    for (name, value) in &c.mods {
        (r, g, b) = apply_mod(name, *value, (r, g, b));
    }
    let a = c.alpha.map_or(255, |a| (a.clamp(0.0, 1.0) * 255.0).round() as u8);
    Some(Rgba(r, g, b, a))
}

/// The DrawingML luminance transforms most theme colors use (`lumMod`, `lumOff`, `tint`,
/// `shade`); other transforms leave the color as it is.
fn apply_mod(name: &str, value: i32, (r, g, b): (u8, u8, u8)) -> (u8, u8, u8) {
    let f = f64::from(value) / 100_000.0;
    let ch = |c: u8, k: &dyn Fn(f64) -> f64| (k(f64::from(c) / 255.0).clamp(0.0, 1.0) * 255.0).round() as u8;
    match name {
        "lumMod" | "lumOff" => {
            let (h, s, l) = to_hsl(r, g, b);
            let l = if name == "lumMod" { l * f } else { l + f };
            from_hsl(h, s, l.clamp(0.0, 1.0))
        }
        "tint" => (ch(r, &|c| c + (1.0 - c) * (1.0 - f)), ch(g, &|c| c + (1.0 - c) * (1.0 - f)), ch(b, &|c| c + (1.0 - c) * (1.0 - f))),
        "shade" => (ch(r, &|c| c * f), ch(g, &|c| c * f), ch(b, &|c| c * f)),
        _ => (r, g, b),
    }
}

fn to_hsl(r: u8, g: u8, b: u8) -> (f64, f64, f64) {
    let (r, g, b) = (f64::from(r) / 255.0, f64::from(g) / 255.0, f64::from(b) / 255.0);
    let (max, min) = (r.max(g).max(b), r.min(g).min(b));
    let l = (max + min) / 2.0;
    if (max - min).abs() < 1e-12 {
        return (0.0, 0.0, l);
    }
    let d = max - min;
    let s = if l > 0.5 { d / (2.0 - max - min) } else { d / (max + min) };
    let h = if max == r {
        (g - b) / d + if g < b { 6.0 } else { 0.0 }
    } else if max == g {
        (b - r) / d + 2.0
    } else {
        (r - g) / d + 4.0
    };
    (h / 6.0, s, l)
}

fn from_hsl(h: f64, s: f64, l: f64) -> (u8, u8, u8) {
    let to = |v: f64| (v.clamp(0.0, 1.0) * 255.0).round() as u8;
    if s.abs() < 1e-12 {
        return (to(l), to(l), to(l));
    }
    let q = if l < 0.5 { l * (1.0 + s) } else { l + s - l * s };
    let p = 2.0 * l - q;
    let hue = |mut t: f64| {
        t = t.rem_euclid(1.0);
        if t < 1.0 / 6.0 {
            p + (q - p) * 6.0 * t
        } else if t < 0.5 {
            q
        } else if t < 2.0 / 3.0 {
            p + (q - p) * (2.0 / 3.0 - t) * 6.0
        } else {
            p
        }
    };
    (to(hue(h + 1.0 / 3.0)), to(hue(h)), to(hue(h - 1.0 / 3.0)))
}

/// The 3-D faces of some presets are their fill made lighter or darker.
fn shade(c: Rgba, mode: FillMode) -> Rgba {
    let k = match mode {
        FillMode::Lighten => 1.4,
        FillMode::LightenLess => 1.2,
        FillMode::Darken => 0.6,
        FillMode::DarkenLess => 0.8,
        _ => return c,
    };
    let f = |v: u8| (f64::from(v) * k).clamp(0.0, 255.0).round() as u8;
    Rgba(f(c.0), f(c.1), f(c.2), c.3)
}

/// A preset dash as multiples of the line width (DrawingML's preset patterns).
pub fn dash_pattern(name: &str) -> Vec<f64> {
    match name {
        "dot" => vec![1.0, 3.0],
        "sysDot" => vec![1.0, 1.0],
        "dash" => vec![4.0, 3.0],
        "sysDash" => vec![3.0, 1.0],
        "lgDash" => vec![8.0, 3.0],
        "dashDot" => vec![4.0, 3.0, 1.0, 3.0],
        "sysDashDot" => vec![3.0, 1.0, 1.0, 1.0],
        "lgDashDot" => vec![8.0, 3.0, 1.0, 3.0],
        "lgDashDotDot" => vec![8.0, 3.0, 1.0, 3.0, 1.0, 3.0],
        "sysDashDotDot" => vec![3.0, 1.0, 1.0, 1.0, 1.0, 1.0],
        _ => Vec::new(),
    }
}

/// Custom paths stretched over `w` × `h`.
pub fn custom_geometry(paths: &[CustomPath], w: f64, h: f64) -> Option<crate::preset::Geometry> {
    let mut subs = Vec::new();
    for p in paths.iter().take(1000) {
        let path = BezPath::from_svg(&p.d).ok()?;
        let sx = if p.w > 1e-9 { w / p.w } else { 1.0 };
        let sy = if p.h > 1e-9 { h / p.h } else { 1.0 };
        subs.push(crate::preset::SubPath {
            path: Affine::scale_non_uniform(sx, sy) * path,
            fill: if p.filled { FillMode::Norm } else { FillMode::None },
            stroke: p.stroked,
            even_odd: false,
        });
    }
    (!subs.is_empty()).then(|| crate::preset::Geometry { paths: subs, text_rect: Rect::new(0.0, 0.0, w, h), handles: Vec::new(), sites: Vec::new() })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::geom::Xfrm;
    use crate::model::{Geometry, Stroke};

    struct Theme;
    impl Resources for Theme {
        fn theme_color(&self, slot: &str) -> Option<Rgb> {
            (slot == "accent1").then_some(Rgb(0x44, 0x72, 0xC4))
        }
        fn default_stroke(&self, _o: &DrawingObject) -> Option<(Rgba, f64)> {
            Some((Rgba(0, 0, 0, 255), 1.0))
        }
    }

    #[test]
    fn a_filled_outlined_shape_paints_fill_then_stroke() {
        let o = DrawingObject {
            frame: Xfrm::new(10.0, 10.0, 100.0, 50.0),
            geometry: Geometry::preset("ellipse"),
            fill: Some(Fill::Solid(Color::theme("accent1"))),
            stroke: Some(Stroke { width: Some(2.0), dash: Some("dash".into()), ..Default::default() }),
            ..Default::default()
        };
        let d = display_list(&o, &Theme);
        assert!(matches!(&d.items[0], Item::Fill { paint: Rgba(0x44, 0x72, 0xC4, 255), .. }));
        assert!(matches!(&d.items[1], Item::Stroke { paint: Rgba(0, 0, 0, 255), width, dash, .. } if *width == 2.0 && dash == &vec![8.0, 6.0]));
        assert_eq!(d.transform * kurbo::Point::ZERO, kurbo::Point::new(10.0, 10.0));
    }

    #[test]
    fn text_boxes_paint_nothing_by_default() {
        let o = DrawingObject { kind: ObjectKind::TextBox, frame: Xfrm::new(0.0, 0.0, 10.0, 10.0), ..Default::default() };
        assert!(display_list(&o, &Theme).items.is_empty());
    }

    #[test]
    fn color_transforms() {
        let mut c = Color::rgb(Rgb(0x44, 0x72, 0xC4));
        c.mods = vec![("lumMod".into(), 50000)];
        let Rgba(r, g, b, _) = resolve(&c, &Theme).unwrap();
        assert!(r < 0x44 && g < 0x72 && b < 0xC4);
        c.mods = vec![("shade".into(), 50000)];
        assert_eq!(resolve(&c, &Theme), Some(Rgba(0x22, 0x39, 0x62, 255)));
        let missing = Color::theme("accent6");
        assert_eq!(resolve(&missing, &Theme), None);
    }

    #[test]
    fn custom_paths_stretch_over_the_frame() {
        let g = custom_geometry(&[CustomPath { w: 10.0, h: 10.0, d: "M0 0 L10 0 L10 10 Z".into(), filled: true, stroked: true }], 100.0, 50.0).unwrap();
        let bb = kurbo::Shape::bounding_box(&g.paths[0].path);
        assert_eq!((bb.width(), bb.height()), (100.0, 50.0));
        assert!(custom_geometry(&[CustomPath { d: "not a path".into(), ..Default::default() }], 1.0, 1.0).is_none());
    }
}
