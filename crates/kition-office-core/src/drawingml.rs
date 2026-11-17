//! DrawingML colours the Office kits read alike (charts, SmartArt, shapes): a colour element with
//! its modifiers applied, its opacity, and the paint of a fill or line (solid, the first stop of
//! a gradient, a pattern's foreground) or a gradient's stops. Generic over the kit's XML tree
//! ([`crate::xml::Xml`]).

use crate::model::Rgb;
use crate::xml::Xml;

/// The default Office theme's colours by slot: dk1, lt1, dk2, lt2, accent1..6, hlink, folHlink.
pub const THEME: [Rgb; 12] = [
    Rgb(0x00, 0x00, 0x00),
    Rgb(0xFF, 0xFF, 0xFF),
    Rgb(0x0E, 0x28, 0x41),
    Rgb(0xE8, 0xE8, 0xE8),
    Rgb(0x15, 0x60, 0x82),
    Rgb(0xE9, 0x71, 0x32),
    Rgb(0x19, 0x6B, 0x24),
    Rgb(0x0F, 0x9E, 0xD5),
    Rgb(0xA0, 0x2B, 0x93),
    Rgb(0x4E, 0xA7, 0x2E),
    Rgb(0x46, 0x78, 0x86),
    Rgb(0x96, 0x60, 0x7D),
];

/// An integer attribute (a whole or decimal number, rounded).
fn int(s: &str) -> Option<i64> {
    let t = s.trim();
    if t.is_empty() || t.len() > 40 {
        return None;
    }
    if let Ok(v) = t.parse::<i64>() {
        return Some(v);
    }
    let v: f64 = t.parse().ok()?;
    v.is_finite().then(|| v.round().clamp(i64::MIN as f64, i64::MAX as f64) as i64)
}

/// Theme colour `i` (0 dk1, 1 lt1, 2 dk2, 3 lt2, 4..9 accent1..6, 10 hlink, 11 folHlink), falling
/// back to the default theme.
pub fn slot(theme: &[Rgb], i: usize) -> Rgb {
    theme.get(i).or_else(|| THEME.get(i)).copied().unwrap_or(Rgb(0, 0, 0))
}

/// The colour of a fill or line element: a solid colour, the first stop of a gradient, or the
/// foreground of a pattern. `None` for no fill and picture fills.
pub fn paint<E: Xml>(e: &E, theme: &[Rgb]) -> Option<Rgb> {
    match e.qname() {
        "a:gradFill" => e.qchild("a:gsLst").and_then(|l| l.qchild("a:gs")).and_then(|g| color(g, theme)),
        "a:pattFill" => e.qchild("a:fgClr").and_then(|c| color(c, theme)),
        "a:noFill" | "a:blipFill" => None,
        _ => color(e, theme),
    }
}

/// The fill of a `…Pr` or `a:ln` element (its first solid, gradient or pattern fill), as [`paint`].
pub fn fill_colour<E: Xml>(e: &E, theme: &[Rgb]) -> Option<Rgb> {
    let f = e.qels().find(|c| matches!(c.qname(), "a:solidFill" | "a:gradFill" | "a:pattFill"))?;
    paint(f, theme)
}

/// A gradient fill (`a:gradFill`).
#[derive(Clone, Debug, PartialEq)]
pub struct Gradient {
    /// (position 0..1, colour), at least two, in order.
    pub stops: Vec<(f32, Rgb)>,
    /// The `a:lin` angle, degrees clockwise.
    pub angle: f32,
    /// The `a:path` shape (`circle`, `rect`, `shape`) of a path gradient.
    pub path: Option<String>,
}

/// A gradient fill's stops (at most ten), its `a:lin` angle or `a:path` shape.
pub fn gradient<E: Xml>(e: &E, theme: &[Rgb]) -> Option<Gradient> {
    let mut stops: Vec<(f32, Rgb)> = e
        .qchild("a:gsLst")?
        .qels()
        .filter(|g| g.qname() == "a:gs")
        .take(10)
        .filter_map(|g| Some(((g.qattr("pos").and_then(int)? as f32 / 100_000.0).clamp(0.0, 1.0), color(g, theme)?)))
        .collect();
    stops.sort_by(|a, b| a.0.total_cmp(&b.0));
    if stops.len() < 2 {
        return None;
    }
    let angle = e.qchild("a:lin").and_then(|l| l.qattr("ang")).and_then(int).map_or(0.0, |a| (a as f32 / 60_000.0).rem_euclid(360.0));
    let path = e.qchild("a:path").and_then(|p| p.qattr("path")).filter(|p| matches!(*p, "circle" | "rect" | "shape")).map(str::to_string);
    Some(Gradient { stops, angle, path })
}

fn is_color<E: Xml>(e: &E) -> bool {
    matches!(e.qname(), "a:srgbClr" | "a:schemeClr" | "a:sysClr")
}

/// A colour element (`a:srgbClr`, `a:schemeClr`, `a:sysClr`), or the one inside `e`, with its
/// `lumMod` / `lumOff` / `tint` / `shade` applied in document order.
pub fn color<E: Xml>(e: &E, theme: &[Rgb]) -> Option<Rgb> {
    let c = if is_color(e) { e } else { e.qels().find(|c| is_color(*c))? };
    let base = match c.qname() {
        "a:srgbClr" => Rgb::parse(c.qattr("val")?)?,
        "a:schemeClr" => *theme.get(scheme_slot(c.qattr("val")?)?)?,
        "a:sysClr" => Rgb::parse(c.qattr("lastClr")?)?,
        _ => return None,
    };
    let val = |m: &E| m.qattr("val").and_then(int).map_or(0.0, |v| (v as f64 / 100_000.0).clamp(-10.0, 10.0));
    let mut rgb = base;
    for m in c.qels() {
        rgb = match m.qname() {
            "a:lumMod" => adjust_lum(rgb, |l| l * val(m)),
            "a:lumOff" => adjust_lum(rgb, |l| l + val(m)),
            "a:tint" => mix(rgb, 255.0, val(m)),
            "a:shade" => mix(rgb, 0.0, val(m)),
            _ => rgb,
        };
    }
    Some(rgb)
}

/// The opacity of a colour element (or the one inside `e`): its last `a:alpha`, 1 without one.
pub fn opacity<E: Xml>(e: &E) -> f64 {
    let Some(c) = (if is_color(e) { Some(e) } else { e.qels().find(|c| is_color(*c)) }) else { return 1.0 };
    c.qchildren("a:alpha").last().and_then(|a| a.qattr("val")).and_then(int).map_or(1.0, |v| (v as f64 / 100_000.0).clamp(0.0, 1.0))
}

/// `c` at `opacity` over a white page: how a translucent colour shows there.
pub fn over_white(c: Rgb, opacity: f64) -> Rgb {
    mix(c, 255.0, opacity)
}

/// Index into `Document::settings.theme_colors` (dk1, lt1, dk2, lt2, accent1..6, hlink, folHlink).
fn scheme_slot(name: &str) -> Option<usize> {
    Some(match name {
        "dk1" | "tx1" => 0,
        "lt1" | "bg1" => 1,
        "dk2" | "tx2" => 2,
        "lt2" | "bg2" => 3,
        "accent1" => 4,
        "accent2" => 5,
        "accent3" => 6,
        "accent4" => 7,
        "accent5" => 8,
        "accent6" => 9,
        "hlink" => 10,
        "folHlink" => 11,
        _ => return None,
    })
}

/// `tint` (towards `to` = 255) and `shade` (towards 0): `v` is the share of the original colour kept.
fn mix(c: Rgb, to: f64, v: f64) -> Rgb {
    let f = |x: u8| (x as f64 * v + to * (1.0 - v)).round().clamp(0.0, 255.0) as u8;
    Rgb(f(c.0), f(c.1), f(c.2))
}

fn adjust_lum(c: Rgb, f: impl Fn(f64) -> f64) -> Rgb {
    let (h, s, l) = to_hsl(c);
    from_hsl(h, s, f(l).clamp(0.0, 1.0))
}

fn to_hsl(c: Rgb) -> (f64, f64, f64) {
    let (r, g, b) = (c.0 as f64 / 255.0, c.1 as f64 / 255.0, c.2 as f64 / 255.0);
    let (max, min) = (r.max(g).max(b), r.min(g).min(b));
    let l = (max + min) / 2.0;
    if max == min {
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

fn from_hsl(h: f64, s: f64, l: f64) -> Rgb {
    let byte = |v: f64| (v * 255.0).round().clamp(0.0, 255.0) as u8;
    if s == 0.0 {
        return Rgb(byte(l), byte(l), byte(l));
    }
    let q = if l < 0.5 { l * (1.0 + s) } else { l + s - l * s };
    let p = 2.0 * l - q;
    let channel = |t: f64| {
        let t = t.rem_euclid(1.0);
        let v = if t < 1.0 / 6.0 {
            p + (q - p) * 6.0 * t
        } else if t < 0.5 {
            q
        } else if t < 2.0 / 3.0 {
            p + (q - p) * (2.0 / 3.0 - t) * 6.0
        } else {
            p
        };
        byte(v)
    };
    Rgb(channel(h + 1.0 / 3.0), channel(h), channel(h - 1.0 / 3.0))
}

#[cfg(test)]
mod tests {
    use super::*;

    const NS: &str = r#"xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main""#;

    /// The element `name` with `attrs` and `body`, parsed.
    fn el(name: &str, attrs: &str, body: &str) -> crate::xml::Element {
        crate::xml::parse(&format!(r#"<{name} {NS} {attrs}>{body}</{name}>"#)).unwrap().root
    }

    #[test]
    fn gradient_and_pattern_fills_take_their_first_colour() {
        let theme = THEME.to_vec();
        let grad = el("a:gradFill", "", r#"<a:gsLst><a:gs pos="0"><a:srgbClr val="FF0000"/></a:gs></a:gsLst>"#);
        assert_eq!(paint(&grad, &theme), Some(Rgb(255, 0, 0)));
        let patt = el("a:pattFill", r#"prst="dkDnDiag""#, r#"<a:fgClr><a:srgbClr val="00FF00"/></a:fgClr><a:bgClr><a:srgbClr val="0000FF"/></a:bgClr>"#);
        assert_eq!(paint(&patt, &theme), Some(Rgb(0, 255, 0)));
        let ln = el("a:ln", "", r#"<a:gradFill><a:gsLst><a:gs pos="0"><a:srgbClr val="FF0000"/></a:gs></a:gsLst></a:gradFill>"#);
        assert_eq!(fill_colour(&ln, &theme), Some(Rgb(255, 0, 0)));
        assert_eq!(fill_colour(&el("a:ln", "", "<a:noFill/>"), &theme), None);
    }

    #[test]
    fn tint_and_shade_move_towards_white_and_black() {
        let theme = THEME.to_vec();
        let near = |c: Option<Rgb>| c.is_some_and(|Rgb(r, g, b)| [r, g, b].iter().all(|x| x.abs_diff(128) <= 1));
        assert!(near(color(&el("a:srgbClr", r#"val="000000""#, r#"<a:tint val="50000"/>"#), &theme)));
        assert!(near(color(&el("a:srgbClr", r#"val="FFFFFF""#, r#"<a:shade val="50000"/>"#), &theme)));
    }

    #[test]
    fn modifiers_apply_in_the_order_written() {
        let theme = THEME.to_vec();
        let a = el("a:srgbClr", r#"val="808080""#, r#"<a:lumMod val="50000"/><a:lumOff val="50000"/>"#);
        let b = el("a:srgbClr", r#"val="808080""#, r#"<a:lumOff val="50000"/><a:lumMod val="50000"/>"#);
        assert_ne!(color(&a, &theme), color(&b, &theme));
    }
}
