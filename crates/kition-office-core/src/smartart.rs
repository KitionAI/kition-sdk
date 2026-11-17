//! SmartArt diagrams: the ready-made drawing (`dsp:drawing`) Office keeps beside a diagram's data
//! model, turned into items ready to draw ([`items`]). The diagram's layout isn't run; the saved
//! drawing is the picture. Shapes take their outlines from the shared preset catalog
//! ([`crate::preset`]), colours follow [`crate::drawingml`], and empty placeholder nodes show their
//! prompt from the data model (`dgm:dataModel`), as WPS draws them. Generic over the kit's XML
//! tree ([`crate::xml::Xml`]).

use std::collections::HashMap;

use crate::drawingml::{color, opacity, over_white};
use crate::kurbo::{Affine, BezPath, PathEl, Point, Vec2};
use crate::model::Rgb;
use crate::preset::FillMode;
use crate::xml::Xml;

/// Something a diagram draws, in points from its top-left corner.
#[derive(Clone, Debug, PartialEq)]
pub enum Item {
    /// A preset shape filling `rect` (`[x, y, w, h]`), upright, with its default adjust values: one
    /// of the presets kits commonly draw themselves (see [`SIMPLE_PRESETS`]).
    Preset { rect: [f32; 4], prst: String, fill: Option<Rgb>, stroke: Option<Rgb>, stroke_width: f32 },
    /// An outline: turned, adjusted or other presets, connectors.
    Path { segs: Vec<Seg>, fill: Option<Rgb>, stroke: Option<Rgb>, stroke_width: f32 },
    /// One line of text in `rect`, aligned horizontally by `align`, centred vertically.
    Text {
        rect: [f32; 4],
        text: String,
        size: f32,
        color: Rgb,
        bold: bool,
        align: TextAlign,
        font: Option<String>,
        /// A placeholder's prompt (an empty node's "[Text]"): kits draw it as outlines, not as
        /// document text.
        prompt: bool,
    },
    /// A picture stretched into `rect`: the key the kit's `image` callback gave its relationship.
    Image { rect: [f32; 4], media: String },
}

/// A path element, points.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Seg {
    Move(f32, f32),
    Line(f32, f32),
    Cubic(f32, f32, f32, f32, f32, f32),
    Close,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum TextAlign {
    Left,
    #[default]
    Center,
    Right,
}

/// The presets drawn as [`Item::Preset`] when upright and unadjusted.
pub const SIMPLE_PRESETS: [&str; 8] = ["rect", "roundRect", "ellipse", "triangle", "diamond", "rightArrow", "star5", "heart"];

/// Text width estimate, as a share of the font size per character.
const CHAR_W: f32 = 0.55;

fn text_w(s: &str, size: f32) -> f32 {
    s.chars().count() as f32 * size * CHAR_W
}

/// Largest length in points layout accepts.
const MAX_LEN_PT: f32 = 14_400.0;

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

/// A preset's outline at `w` × `h`, adjust values NaN taking its defaults (an unknown preset is a
/// rectangle).
fn preset_geometry(name: &str, adj: &[f64], w: f64, h: f64) -> Option<crate::preset::Geometry> {
    let defaults = crate::preset::info(name).map(|i| i.defaults).unwrap_or(&[]);
    let adj: Vec<f64> = adj.iter().enumerate().map(|(i, v)| if v.is_finite() { *v } else { defaults.get(i).copied().unwrap_or(0.0) }).collect();
    crate::preset::build(name, w.max(0.0), h.max(0.0), &adj).or_else(|| crate::preset::build("rect", w.max(0.0), h.max(0.0), &[]))
}

/// Deepest `dsp:grpSp` nesting followed.
const MAX_GROUP_DEPTH: usize = 8;
/// Most shapes read from one drawing.
const MAX_SHAPES: usize = 10_000;
/// Most items emitted for one diagram.
const MAX_ITEMS: usize = 50_000;
/// Most paragraphs of one shape (a `presOf` connection's `destOrd` beyond it is ignored).
const MAX_PARAGRAPHS: usize = 1_000;
/// EMU per point.
const EMU_PT: f64 = 12_700.0;
/// Largest coordinate or extent accepted, EMU (about 78,000 pt).
const MAX_EMU: f64 = 1.0e9;
/// Line height as a multiple of the font size.
const LINE: f32 = 1.2;

/// An affine map per axis (`x' = kx·x + ox`, `y' = ky·y + oy`).
#[derive(Clone, Copy, Debug)]
struct Xf {
    kx: f64,
    ox: f64,
    ky: f64,
    oy: f64,
}

impl Xf {
    const ID: Xf = Xf { kx: 1.0, ox: 0.0, ky: 1.0, oy: 0.0 };

    /// `self` applied after `inner`.
    fn then(self, inner: Xf) -> Xf {
        Xf { kx: self.kx * inner.kx, ox: self.kx * inner.ox + self.ox, ky: self.ky * inner.ky, oy: self.ky * inner.oy + self.oy }
    }

    /// The box `[x, y, w, h]` mapped to corners `[x0, y0, x1, y1]`.
    fn rect(self, b: [f64; 4]) -> [f64; 4] {
        let (x0, x1) = (self.kx * b[0] + self.ox, self.kx * (b[0] + b[2]) + self.ox);
        let (y0, y1) = (self.ky * b[1] + self.oy, self.ky * (b[1] + b[3]) + self.oy);
        [x0.min(x1), y0.min(y1), x0.max(x1), y0.max(y1)]
    }
}

/// Points, clamped into the range layout accepts (NaN, from a degenerate transform, is 0).
fn pt(v: f64) -> f32 {
    if v.is_nan() { 0.0 } else { v.clamp(-MAX_LEN_PT as f64, MAX_LEN_PT as f64) as f32 }
}

/// An EMU attribute of `e`, finite and bounded.
fn emu<E: Xml>(e: &E, attr: &str) -> Option<f64> {
    int(e.qattr(attr)?).map(|v| (v as f64).clamp(-MAX_EMU, MAX_EMU))
}

/// `a:off` / `a:ext` of an element (a shape's `a:xfrm`, `dsp:txXfrm`) as `[x, y, w, h]` in EMU.
fn xfrm_box<E: Xml>(x: &E) -> Option<[f64; 4]> {
    let (off, ext) = (x.qchild("a:off")?, x.qchild("a:ext")?);
    Some([emu(off, "x")?, emu(off, "y")?, emu(ext, "cx")?.max(0.0), emu(ext, "cy")?.max(0.0)])
}

/// The `rot` of an element in degrees, clockwise, in `[0, 360)`.
fn rot_of<E: Xml>(e: Option<&E>) -> f64 {
    e.and_then(|e| e.qattr("rot")).and_then(int).unwrap_or(0).rem_euclid(21_600_000) as f64 / 60_000.0
}

/// The box `[x, y, w, h]` turned `rot` degrees about its centre, as the box it covers.
fn turned_box(b: [f64; 4], rot: f64) -> [f64; 4] {
    let (s, c) = rot.to_radians().sin_cos();
    let (w, h) = ((b[2] * c).abs() + (b[3] * s).abs(), (b[2] * s).abs() + (b[3] * c).abs());
    [b[0] + (b[2] - w) / 2.0, b[1] + (b[3] - h) / 2.0, w, h]
}

/// Child-space to parent-space scale of a group, from its `a:xfrm` (`off`/`ext` against `chOff`/`chExt`).
fn group_xf<E: Xml>(grp: &E) -> Xf {
    let Some(x) = grp.qchild("dsp:grpSpPr").and_then(|p| p.qchild("a:xfrm")) else { return Xf::ID };
    let v = |tag: &str, a: &str| x.qchild(tag).and_then(|e| emu(e, a)).unwrap_or(0.0);
    let scale = |e: f64, c: f64| if c > 0.0 && e >= 0.0 { e / c } else { 1.0 };
    let kx = scale(v("a:ext", "cx"), v("a:chExt", "cx"));
    let ky = scale(v("a:ext", "cy"), v("a:chExt", "cy"));
    Xf { kx, ox: v("a:off", "x") - v("a:chOff", "x") * kx, ky, oy: v("a:off", "y") - v("a:chOff", "y") * ky }
}

/// Shapes in `tree` (depth-first through groups), each with its transform into the drawing.
fn collect<'a, E: Xml>(tree: &'a E, xf: Xf, depth: usize, out: &mut Vec<(Xf, &'a E)>) {
    for e in tree.qels() {
        match e.qname() {
            "dsp:sp" if out.len() < MAX_SHAPES => out.push((xf, e)),
            "dsp:grpSp" if depth < MAX_GROUP_DEPTH => collect(e, xf.then(group_xf(e)), depth + 1, out),
            _ => {}
        }
    }
}

/// The placeholder prompts of a diagram's data model (`dgm:dataModel`), by shape: a shape (a
/// presentation point, the drawing's `modelId`) shows data points as its paragraphs, in the
/// order of their `presOf` connections' `destOrd`; each slot holds the prompt (`phldrT`) of a
/// placeholder point (`phldr`), which an empty paragraph shows.
pub fn prompts<E: Xml>(data: &E) -> HashMap<&str, Vec<Option<&str>>> {
    let mut placeholders: HashMap<&str, &str> = HashMap::new();
    for point in data.qchild("dgm:ptLst").into_iter().flat_map(|l| l.qchildren("dgm:pt")) {
        let (Some(id), Some(set)) = (point.qattr("modelId"), point.qchild("dgm:prSet")) else { continue };
        if set.qattr("phldr").is_some_and(on)
            && let Some(prompt) = set.qattr("phldrT")
        {
            placeholders.insert(id, prompt);
        }
    }
    let mut out: HashMap<&str, Vec<Option<&str>>> = HashMap::new();
    for cxn in data.qchild("dgm:cxnLst").into_iter().flat_map(|l| l.qchildren("dgm:cxn")) {
        if cxn.qattr("type") != Some("presOf") {
            continue;
        }
        let (Some(src), Some(dest)) = (cxn.qattr("srcId"), cxn.qattr("destId")) else { continue };
        let Some(order) = cxn.qattr("destOrd").map_or(Some(0), int).and_then(|v| usize::try_from(v).ok()).filter(|v| *v < MAX_PARAGRAPHS) else {
            continue;
        };
        let slots = out.entry(dest).or_default();
        if slots.len() <= order {
            slots.resize(order + 1, None);
        }
        slots[order] = placeholders.get(src).copied();
    }
    out
}

/// The items of a SmartArt drawing, scaled so its extent fills the `w` × `h` (points) frame.
/// `data` is the diagram's data model, for the prompts of empty placeholder nodes.
/// `image` maps a relationship id of the drawing part to a `Document::media` key.
pub fn items<E: Xml>(drawing: &E, data: Option<&E>, theme: &[Rgb], w: f32, h: f32, image: &mut dyn FnMut(&str) -> Option<String>) -> Vec<Item> {
    let Some(tree) = drawing.qfind("dsp:spTree") else { return Vec::new() };
    let prompts = data.map(prompts).unwrap_or_default();
    let mut shapes = Vec::new();
    collect(tree, Xf::ID, 0, &mut shapes);
    let placed: Vec<(Xf, &E, [f64; 4])> = shapes
        .into_iter()
        .filter_map(|(xf, sp)| {
            let b = sp.qchild("dsp:spPr").and_then(|p| p.qchild("a:xfrm")).and_then(xfrm_box)?;
            Some((xf, sp, b))
        })
        .collect();
    // The drawing's extent (from its origin) against the frame: the tree's own (`dsp:grpSpPr`),
    // else the far corner of its shapes' boxes. One scale for both axes, never above 1:1: Word
    // draws the drawing at its own size when it fits the frame.
    let own = tree.qchild("dsp:grpSpPr").and_then(|p| p.qchild("a:xfrm")).and_then(xfrm_box).filter(|b| b[2] > 0.0 && b[3] > 0.0);
    let (ext_x, ext_y) = match own {
        Some(b) => (b[0] + b[2], b[1] + b[3]),
        None => placed.iter().fold((0.0f64, 0.0f64), |(mx, my), (xf, _, b)| {
            let r = xf.rect(*b);
            (mx.max(r[2]), my.max(r[3]))
        }),
    };
    let frame = |f: f32| if f.is_finite() && f > 0.0 { f as f64 * EMU_PT } else { 0.0 };
    let fit_of = |frame: f64, ext: f64| if frame > 0.0 && ext > 0.0 { frame / ext } else { 1.0 };
    let fit = [1.0, fit_of(frame(w), ext_x), fit_of(frame(h), ext_y)].into_iter().fold(f64::INFINITY, f64::min);
    let root = Xf { kx: fit / EMU_PT, ox: 0.0, ky: fit / EMU_PT, oy: 0.0 };
    let mut out = Vec::new();
    for (xf, sp, b) in placed {
        if out.len() >= MAX_ITEMS {
            break;
        }
        let slots = sp.qattr("modelId").and_then(|id| prompts.get(id)).map_or(&[][..], Vec::as_slice);
        shape(sp, root.then(xf), b, theme, fit as f32, slots, image, &mut out);
    }
    out
}

/// One `dsp:sp`: its picture or outline, then its text.
/// `fit` is the drawing's scale into the frame, which text sizes follow; `prompts` are the
/// placeholder prompts of its paragraphs.
#[allow(clippy::too_many_arguments)]
fn shape<E: Xml>(
    sp: &E,
    xf: Xf,
    b: [f64; 4],
    theme: &[Rgb],
    fit: f32,
    prompts: &[Option<&str>],
    image: &mut dyn FnMut(&str) -> Option<String>,
    out: &mut Vec<Item>,
) {
    let [x0, y0, x1, y1] = xf.rect(b);
    if ![x0, y0, x1, y1].iter().all(|v| v.is_finite()) {
        return;
    }
    let (w, h) = (x1 - x0, y1 - y0);
    let sppr = sp.qchild("dsp:spPr");
    let xfrm = sppr.and_then(|p| p.qchild("a:xfrm"));
    let attr = |n: &str| xfrm.and_then(|x| x.qattr(n));
    let rot = rot_of(xfrm);
    let flip_h = attr("flipH").is_some_and(on);
    let flip_v = attr("flipV").is_some_and(on);
    let turned = rot != 0.0 || flip_h || flip_v;
    let rect = [pt(x0), pt(y0), pt(w), pt(h)];
    let filled;
    if let Some(blip) = sppr.and_then(|p| p.qchild("a:blipFill")).and_then(|f| f.qfind("a:blip")) {
        // A picture fill stretches into the shape's box; no clipping to the outline.
        if let Some(media) = blip.qattr("r:embed").and_then(image) {
            out.push(Item::Image { rect, media });
        }
        filled = false;
    } else {
        let fill = fill_of(sp, sppr, theme);
        let (stroke, stroke_width) = line_of(sp, sppr, theme);
        let geom = sppr.and_then(|p| p.qchild("a:prstGeom"));
        let prst = geom.and_then(|g| g.qattr("prst")).unwrap_or("rect");
        let adjusted = geom.and_then(|g| g.qchild("a:avLst")).is_some_and(|l| l.qchildren("a:gd").next().is_some());
        match SIMPLE_PRESETS.contains(&prst).then_some(prst).filter(|_| !adjusted && (!turned || prst == "ellipse")) {
            Some(prst) => out.push(Item::Preset { rect, prst: prst.to_string(), fill, stroke, stroke_width }),
            None => {
                // Flip in the box, then turn about its centre (clockwise, y down).
                let centre = Vec2::new(x0 + w / 2.0, y0 + h / 2.0);
                let flip = Affine::new([if flip_h { -1.0 } else { 1.0 }, 0.0, 0.0, if flip_v { -1.0 } else { 1.0 }, 0.0, 0.0]);
                let place = Affine::translate(centre) * Affine::rotate(rot.to_radians()) * flip * Affine::translate(Vec2::new(-w / 2.0, -h / 2.0));
                let adj: Vec<f64> = adjust_values(geom);
                for sub in preset_geometry(prst, &adj, w, h).map(|g| g.paths).unwrap_or_default() {
                    let segs = segments(&(place * sub.path));
                    if segs.is_empty() {
                        continue;
                    }
                    let shade = |keep: f64, to: f64| fill.map(|c| mix(c, to, keep));
                    let sub_fill = match sub.fill {
                        _ if !segs.contains(&Seg::Close) => None,
                        FillMode::Norm => fill,
                        FillMode::None => None,
                        FillMode::Lighten => shade(0.6, 255.0),
                        FillMode::LightenLess => shade(0.8, 255.0),
                        FillMode::Darken => shade(0.6, 0.0),
                        FillMode::DarkenLess => shade(0.8, 0.0),
                    };
                    if sub_fill.is_some() || sub.stroke {
                        out.push(Item::Path { segs, fill: sub_fill, stroke: if sub.stroke { stroke } else { None }, stroke_width });
                    }
                }
            }
        }
        filled = fill.is_some();
    }
    text(sp, xf, b, theme, filled, fit, prompts, out);
}

/// `c` with `keep` of itself, the rest `to` (255 lightens, 0 darkens).
fn mix(c: Rgb, to: f64, keep: f64) -> Rgb {
    let f = |x: u8| (x as f64 * keep + to * (1.0 - keep)).round().clamp(0.0, 255.0) as u8;
    Rgb(f(c.0), f(c.1), f(c.2))
}

/// A preset's adjust values (`a:avLst` `a:gd name="adjN"`, `fmla="val N"`) in the catalog's
/// guide order; one not given is NaN, which takes the preset's default.
fn adjust_values<E: Xml>(geom: Option<&E>) -> Vec<f64> {
    let given: Vec<(String, f64)> = geom
        .and_then(|g| g.qchild("a:avLst"))
        .into_iter()
        .flat_map(|l| l.qchildren("a:gd"))
        .filter_map(|d| {
            let v = d.qattr("fmla")?.strip_prefix("val ")?.trim().parse::<f64>().ok().filter(|v| v.is_finite())?;
            Some((d.qattr("name")?.to_string(), v.clamp(-1.0e9, 1.0e9)))
        })
        .collect();
    let mut out: Vec<Option<f64>> = Vec::new();
    for (guide, value) in given.iter().take(16) {
        let index = match guide.strip_prefix("adj") {
            Some("") => Some(0),
            Some(n) => n.parse::<usize>().ok().and_then(|n| n.checked_sub(1)),
            None => None,
        };
        if let Some(i) = index.filter(|i| *i < 16)
            && value.is_finite()
        {
            if out.len() <= i {
                out.resize(i + 1, None);
            }
            if let Some(slot) = out.get_mut(i) {
                *slot = Some(*value);
            }
        }
    }
    out.into_iter().map(|v| v.unwrap_or(f64::NAN)).collect()
}

/// A path's elements as [`Seg`]s (quadratic curves raised to cubics), in points.
fn segments(path: &BezPath) -> Vec<Seg> {
    let mut out = Vec::new();
    let mut last = Point::ZERO;
    let p = |q: Point| (pt(q.x), pt(q.y));
    for el in path.elements() {
        match *el {
            PathEl::MoveTo(a) => {
                let (x, y) = p(a);
                out.push(Seg::Move(x, y));
                last = a;
            }
            PathEl::LineTo(a) => {
                let (x, y) = p(a);
                out.push(Seg::Line(x, y));
                last = a;
            }
            PathEl::QuadTo(c, a) => {
                let (c1, c2) = (last + (c - last) * (2.0 / 3.0), a + (c - a) * (2.0 / 3.0));
                let ((ax, ay), (bx, by), (x, y)) = (p(c1), p(c2), p(a));
                out.push(Seg::Cubic(ax, ay, bx, by, x, y));
                last = a;
            }
            PathEl::CurveTo(c1, c2, a) => {
                let ((ax, ay), (bx, by), (x, y)) = (p(c1), p(c2), p(a));
                out.push(Seg::Cubic(ax, ay, bx, by, x, y));
                last = a;
            }
            PathEl::ClosePath => out.push(Seg::Close),
        }
    }
    out
}

fn on(v: &str) -> bool {
    v == "1" || v == "true"
}

/// The colour of a shape's style reference (`a:fillRef`, `a:lnRef`); index 0 means none.
fn style_colour<E: Xml>(sp: &E, which: &str, theme: &[Rgb]) -> Option<Rgb> {
    let r = sp.qchild("dsp:style")?.qchild(which)?;
    if r.qattr("idx") == Some("0") {
        return None;
    }
    color(r, theme).map(|c| over_white(c, opacity(r)))
}

/// The colour of a fill or line element (as `drawing_color::paint`) as it shows over the page.
fn paint<E: Xml>(e: &E, theme: &[Rgb]) -> Option<Rgb> {
    let colour = match e.qname() {
        "a:gradFill" => e.qchild("a:gsLst").and_then(|l| l.qchild("a:gs")),
        "a:pattFill" => e.qchild("a:fgClr"),
        "a:noFill" | "a:blipFill" => None,
        _ => Some(e),
    }?;
    color(colour, theme).map(|c| over_white(c, opacity(colour)))
}

/// A shape's fill: its own `a:*Fill`, else the style's fill colour.
fn fill_of<E: Xml>(sp: &E, sppr: Option<&E>, theme: &[Rgb]) -> Option<Rgb> {
    let own = sppr.and_then(|p| p.qels().find(|e| matches!(e.qname(), "a:solidFill" | "a:noFill" | "a:gradFill" | "a:pattFill")));
    match own {
        Some(e) => paint(e, theme),
        None => style_colour(sp, "a:fillRef", theme),
    }
}

/// A shape's outline colour and width in points (`a:ln`, else the style's line at 0.75 pt).
fn line_of<E: Xml>(sp: &E, sppr: Option<&E>, theme: &[Rgb]) -> (Option<Rgb>, f32) {
    let ln = sppr.and_then(|p| p.qchild("a:ln"));
    let width = ln.and_then(|l| l.qattr("w")).and_then(int).map_or(0.75, |v| (v as f64 / EMU_PT).clamp(0.0, 100.0) as f32);
    let own = ln.and_then(|l| l.qels().find(|e| matches!(e.qname(), "a:solidFill" | "a:noFill" | "a:gradFill")));
    match own {
        Some(e) if e.qname() == "a:noFill" => (None, 0.0),
        Some(e) => (paint(e, theme), width),
        None => (style_colour(sp, "a:lnRef", theme), width),
    }
}

/// One line of a text item before it's placed.
struct Line {
    text: String,
    size: f32,
    color: Rgb,
    bold: bool,
    align: TextAlign,
    font: Option<String>,
    /// Points from the text box's left to the line's text.
    indent: f32,
    /// The bullet before the first line of its paragraph, and where it starts.
    bullet: Option<(String, f32)>,
    /// The line's height and the room above it.
    height: f32,
    before: f32,
    /// Whether the line is a placeholder's prompt.
    prompt: bool,
}

/// The Latin typeface a run's properties name (theme fonts, `+mn-lt`, are left to the default).
fn latin<E: Xml>(r: Option<&E>) -> Option<&str> {
    r?.qchild("a:latin")?.qattr("typeface").filter(|t| !t.is_empty() && !t.starts_with('+'))
}

/// A paragraph's property `name`: its own `a:pPr`, else its list-style level's.
fn para_attr<'a, E: Xml>(ppr: Option<&'a E>, level: Option<&'a E>, name: &str) -> Option<&'a str> {
    ppr.and_then(|p| p.qattr(name)).or_else(|| level.and_then(|l| l.qattr(name)))
}

/// A spacing (`a:lnSpc`, `a:spcBef`, `a:spcAft`) as a share of the line (`spcPct`) or points
/// (`spcPts`), from the paragraph or its list-style level.
enum Spacing {
    Share(f32),
    Points(f32),
}

fn spacing<E: Xml>(ppr: Option<&E>, level: Option<&E>, name: &str) -> Option<Spacing> {
    let s = ppr.and_then(|p| p.qchild(name)).or_else(|| level.and_then(|l| l.qchild(name)))?;
    let val = |tag: &str| s.qchild(tag).and_then(|e| e.qattr("val")).and_then(int);
    if let Some(v) = val("a:spcPct") {
        return Some(Spacing::Share((v as f32 / 100_000.0).clamp(0.0, 10.0)));
    }
    val("a:spcPts").map(|v| Spacing::Points((v as f32 / 100.0).clamp(0.0, 1_000.0)))
}

/// The text of a `dsp:txBody`: one item per (wrapped) line, stacked in the text box by its
/// anchor. The text box is `dsp:txXfrm` (else the shape's box), less the body's insets; a box
/// turned a quarter whose text the body turns back holds level text across the box as it lies.
/// An empty paragraph whose node is a placeholder shows `prompts`' prompt.
#[allow(clippy::too_many_arguments)]
fn text<E: Xml>(sp: &E, xf: Xf, b: [f64; 4], theme: &[Rgb], filled: bool, fit: f32, prompts: &[Option<&str>], out: &mut Vec<Item>) {
    let Some(tb) = sp.qchild("dsp:txBody") else { return };
    let body = tb.qchild("a:bodyPr");
    let autofit = body.and_then(|p| p.qchild("a:normAutofit"));
    let scale = autofit.and_then(|n| n.qattr("fontScale")).and_then(int).map_or(1.0, |v| (v as f32 / 100_000.0).clamp(0.1, 1.0));
    let reduce = autofit.and_then(|n| n.qattr("lnSpcReduction")).and_then(int).map_or(0.0, |v| (v as f32 / 100_000.0).clamp(0.0, 0.9));
    let inset = |n: &str, def: f64| body.and_then(|p| p.qattr(n)).and_then(int).map_or(def, |v| (v as f64).clamp(0.0, MAX_EMU));
    let (l, t, r, bo) = (inset("lIns", 91_440.0), inset("tIns", 45_720.0), inset("rIns", 91_440.0), inset("bIns", 45_720.0));
    let tx = sp.qchild("dsp:txXfrm");
    let (frame, frame_rot) = match tx.and_then(xfrm_box) {
        Some(f) => (f, rot_of(tx)),
        None => (b, rot_of(sp.qchild("dsp:spPr").and_then(|p| p.qchild("a:xfrm")))),
    };
    // A quarter-turned box whose text is turned back lies on its other side; other turns are
    // drawn level in the unturned box.
    let quarter = (frame_rot - 90.0).abs() < 0.01 || (frame_rot - 270.0).abs() < 0.01;
    let level = (frame_rot + rot_of(body)).rem_euclid(360.0).abs() < 0.01;
    let frame = if quarter && level { turned_box(frame, frame_rot) } else { frame };
    let text_box = [frame[0] + l, frame[1] + t, (frame[2] - l - r).max(0.0), (frame[3] - t - bo).max(0.0)];
    let [x0, y0, x1, y1] = xf.rect(text_box);
    let (x0, y0, tw, th) = (pt(x0), pt(y0), pt(x1 - x0), pt(y1 - y0));
    let emu_pt = |v: f64| pt(v * xf.kx.abs());
    // Each line is one item: stop at the diagram's item limit, however much text there is.
    let room = MAX_ITEMS.saturating_sub(out.len());
    let fallback = theme.get(if filled { 1 } else { 0 }).copied().unwrap_or(if filled { Rgb(255, 255, 255) } else { Rgb(0, 0, 0) });
    let font_ref = sp.qchild("dsp:style").and_then(|s| s.qchild("a:fontRef")).and_then(|f| color(f, theme));
    let list = tb.qchild("a:lstStyle");
    let paras: Vec<&E> = tb.qchildren("a:p").collect();
    let count = paras.len().max(prompts.len().min(MAX_PARAGRAPHS));
    let mut lines: Vec<Line> = Vec::new();
    let mut after = 0.0f32;
    for i in 0..count {
        if lines.len() >= room {
            break;
        }
        let p = paras.get(i).or(paras.last()).copied();
        let own: String = paras.get(i).into_iter().flat_map(|p| p.qchildren("a:r")).filter_map(|r| r.qchild("a:t")).map(|t| t.qtext()).collect();
        let own: String = own.chars().map(|c| if c.is_control() { ' ' } else { c }).collect();
        let (text, prompt) = match own.trim() {
            "" => match prompts.get(i).copied().flatten() {
                Some(prompt) => (prompt.trim().to_string(), true),
                None => continue,
            },
            t => (t.to_string(), false),
        };
        if text.is_empty() {
            continue;
        }
        let ppr = p.and_then(|p| p.qchild("a:pPr"));
        let lvl = ppr.and_then(|q| q.qattr("lvl")).and_then(int).map_or(0, |v| v.clamp(0, 8));
        let level = list.and_then(|s| s.qchild(&format!("a:lvl{}pPr", lvl + 1)));
        let defaults = level.and_then(|l| l.qchild("a:defRPr"));
        let run = p.and_then(|p| p.qchildren("a:r").find(|r| r.qchild("a:t").is_some()));
        let rpr = run.and_then(|r| r.qchild("a:rPr")).or_else(|| p.and_then(|p| p.qchild("a:endParaRPr")));
        let char_attr = |name: &str| rpr.and_then(|r| r.qattr(name)).or_else(|| defaults.and_then(|d| d.qattr(name)));
        // The file's size (18 pt when unset), reduced by the autofit and scaled with the drawing.
        let base = char_attr("sz").and_then(int).map_or(18.0, |v| (v as f32 / 100.0).clamp(1.0, 400.0));
        let size = base * scale * fit;
        let fill = |r: Option<&E>| r.and_then(|r| r.qchild("a:solidFill")).and_then(|f| color(f, theme));
        let color = fill(rpr).or_else(|| fill(defaults)).or(font_ref).unwrap_or(fallback);
        let bold = char_attr("b").is_some_and(on);
        let align = match para_attr(ppr, level, "algn") {
            Some("l" | "just" | "dist") => TextAlign::Left,
            Some("r") => TextAlign::Right,
            _ => TextAlign::Center,
        };
        let font = latin(rpr).or_else(|| latin(defaults)).map(str::to_string);
        let margin = para_attr(ppr, level, "marL").and_then(int).map_or(0.0, |v| emu_pt((v as f64).clamp(0.0, MAX_EMU))).min(tw);
        let hanging = para_attr(ppr, level, "indent").and_then(int).map_or(0.0, |v| emu_pt((v as f64).clamp(-MAX_EMU, MAX_EMU)));
        let bullet = if ppr.and_then(|q| q.qchild("a:buNone")).is_some() {
            None
        } else {
            ppr.and_then(|q| q.qchild("a:buChar")).or_else(|| level.and_then(|l| l.qchild("a:buChar"))).and_then(|c| c.qattr("char")).filter(|c| !c.is_empty())
        };
        let line_share = match spacing(ppr, level, "a:lnSpc") {
            Some(Spacing::Share(s)) => s,
            _ => 1.0,
        } * (1.0 - reduce);
        let height = size * LINE * line_share;
        let gap = |s: Option<Spacing>| match s {
            Some(Spacing::Share(s)) => s * size * LINE,
            Some(Spacing::Points(p)) => p * fit,
            None => 0.0,
        };
        let mut before = if lines.is_empty() { 0.0 } else { after + gap(spacing(ppr, level, "a:spcBef")) };
        after = gap(spacing(ppr, level, "a:spcAft"));
        let width = (tw - margin).max(0.0);
        let mut first = true;
        for text in wrap(&text, size, width, room - lines.len()) {
            let bullet = first.then(|| bullet.map(|c| (c.to_string(), (margin + hanging).max(0.0)))).flatten();
            lines.push(Line { text, size, color, bold, align, font: font.clone(), indent: margin, bullet, height, before, prompt });
            before = 0.0;
            first = false;
        }
    }
    let total: f32 = lines.iter().map(|l| l.height + l.before).sum();
    let mut y = match body.and_then(|p| p.qattr("anchor")) {
        Some("ctr") => y0 + (th - total) / 2.0,
        Some("b") => y0 + th - total,
        _ => y0,
    };
    for l in lines {
        if out.len() >= MAX_ITEMS {
            break;
        }
        y += l.before;
        if let Some((bullet, at)) = l.bullet.filter(|_| out.len() + 1 < MAX_ITEMS) {
            out.push(Item::Text {
                rect: [x0 + at, y, (l.indent - at).max(0.0), l.height],
                text: bullet,
                size: l.size,
                color: l.color,
                bold: false,
                align: TextAlign::Left,
                font: None,
                prompt: l.prompt,
            });
        }
        let rect = [x0 + l.indent, y, (tw - l.indent).max(0.0), l.height];
        out.push(Item::Text { rect, text: l.text, size: l.size, color: l.color, bold: l.bold, align: l.align, font: l.font, prompt: l.prompt });
        y += l.height;
    }
}

/// Splits `text` into at most `max` lines of whole words that fit `width` points (by the shared
/// text width estimate); a word wider than that keeps its own line.
fn wrap(text: &str, size: f32, width: f32, max: usize) -> Vec<String> {
    let limit = if width > 0.0 && size > 0.0 { width } else { f32::INFINITY };
    let space = text_w(" ", size);
    let mut lines = Vec::new();
    let (mut cur, mut cur_w) = (String::new(), 0.0f32);
    for word in text.split_whitespace() {
        let w = text_w(word, size);
        if !cur.is_empty() && cur_w + space + w > limit {
            if lines.len() + 1 >= max {
                break;
            }
            lines.push(std::mem::take(&mut cur));
            cur_w = 0.0;
        }
        if !cur.is_empty() {
            cur.push(' ');
            cur_w += space;
        }
        cur.push_str(word);
        cur_w += w;
    }
    if !cur.is_empty() && lines.len() < max {
        lines.push(cur);
    }
    lines
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::drawingml::THEME;

    const NS: &str = r#"xmlns:dsp="http://schemas.microsoft.com/office/drawing/2008/diagram" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships""#;

    fn drawing(body: &str) -> crate::xml::Element {
        crate::xml::parse(&format!("<dsp:drawing {NS}><dsp:spTree>{body}</dsp:spTree></dsp:drawing>")).unwrap().root
    }

    /// Items for a drawing whose only image relationship is `rId1`.
    fn items(body: &str, w: f32, h: f32) -> Vec<Item> {
        let root = drawing(body);
        super::items(&root, None, &THEME, w, h, &mut |id| (id == "rId1").then(|| "image1.png".to_string()))
    }

    /// A `dsp:sp` with the given geometry (`prst`, `xfrm` attributes) and extra spPr/txBody XML.
    fn sp(xfrm: &str, prst: &str, rest: &str) -> String {
        format!(
            r#"<dsp:sp><dsp:spPr><a:xfrm {xfrm}><a:off x="0" y="0"/><a:ext cx="1270000" cy="1270000"/></a:xfrm><a:prstGeom prst="{prst}"><a:avLst/></a:prstGeom>{rest}</dsp:spPr></dsp:sp>"#
        )
    }

    const DGM: &str = r#"xmlns:dgm="http://schemas.openxmlformats.org/drawingml/2006/diagram" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main""#;

    /// Items for a drawing with the data model `data` (a `dgm:dataModel` body).
    fn items_with_data(body: &str, data: &str, w: f32, h: f32) -> Vec<Item> {
        let root = drawing(body);
        let data = crate::xml::parse(&format!("<dgm:dataModel {DGM}>{data}</dgm:dataModel>")).unwrap().root;
        super::items(&root, Some(&data), &THEME, w, h, &mut |_| None)
    }

    fn texts(out: &[Item]) -> Vec<(&str, [f32; 4], f32)> {
        out.iter().filter_map(|i| if let Item::Text { text, rect, size, .. } = i { Some((text.as_str(), *rect, *size)) } else { None }).collect()
    }

    /// The bounds of a path's points.
    fn bounds(segs: &[Seg]) -> [f32; 4] {
        let mut b = [f32::INFINITY, f32::INFINITY, f32::NEG_INFINITY, f32::NEG_INFINITY];
        let mut add = |x: f32, y: f32| b = [b[0].min(x), b[1].min(y), b[2].max(x), b[3].max(y)];
        for s in segs {
            match *s {
                Seg::Move(x, y) | Seg::Line(x, y) => add(x, y),
                Seg::Cubic(a, b2, c, d, x, y) => {
                    add(a, b2);
                    add(c, d);
                    add(x, y);
                }
                Seg::Close => {}
            }
        }
        b
    }

    #[test]
    fn turned_presets_come_from_the_shared_catalog() {
        // A 50 x 200 pt top-rounded rectangle turned a quarter: it lies 200 x 50 pt about its
        // centre (125, 100), with the rounded corners on the right.
        let body = r#"<dsp:sp><dsp:spPr><a:xfrm rot="5400000"><a:off x="1270000" y="0"/><a:ext cx="635000" cy="2540000"/></a:xfrm><a:prstGeom prst="round2SameRect"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="FF0000"/></a:solidFill></dsp:spPr></dsp:sp>"#;
        let out = items(body, 400.0, 400.0);
        let Item::Path { segs, fill, .. } = &out[0] else { panic!("path: {out:?}") };
        assert_eq!(*fill, Some(Rgb(255, 0, 0)));
        assert!(segs.iter().any(|s| matches!(s, Seg::Cubic(..))), "rounded corners: {segs:?}");
        let b = bounds(segs);
        assert!((b[0] - 25.0).abs() < 0.1 && (b[1] - 75.0).abs() < 0.1 && (b[2] - 225.0).abs() < 0.1 && (b[3] - 125.0).abs() < 0.1, "{b:?}");
    }

    #[test]
    fn the_drawing_keeps_its_own_extent() {
        // The same shape in a drawing 250 x 125 pt large (the tree's own extent): its unturned box
        // reaches 200 pt down, its turned one 125 pt. In a 250 x 125 pt frame the drawing fits at
        // its own size.
        let body = r#"<dsp:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="3175000" cy="1587500"/><a:chOff x="0" y="0"/><a:chExt cx="3175000" cy="1587500"/></a:xfrm></dsp:grpSpPr><dsp:sp><dsp:spPr><a:xfrm rot="5400000"><a:off x="1270000" y="0"/><a:ext cx="635000" cy="2540000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></dsp:spPr></dsp:sp>"#;
        let out = items(body, 250.0, 125.0);
        let Item::Path { segs, .. } = &out[0] else { panic!("path: {out:?}") };
        let b = bounds(segs);
        assert!((b[2] - b[0] - 200.0).abs() < 0.1 && (b[3] - 125.0).abs() < 0.1, "{b:?}");
    }

    #[test]
    fn connectors_are_open_paths_from_the_catalog() {
        let out = items(&sp("", "bentConnector3", r#"<a:ln w="12700"><a:solidFill><a:srgbClr val="0000FF"/></a:solidFill></a:ln>"#), 100.0, 100.0);
        let Item::Path { segs, fill, stroke, .. } = &out[0] else { panic!("path: {out:?}") };
        assert_eq!((*fill, *stroke), (None, Some(Rgb(0, 0, 255))));
        assert!(!segs.contains(&Seg::Close), "{segs:?}");
    }

    #[test]
    fn translucent_fills_show_over_the_white_page() {
        let rest = r#"<a:solidFill><a:srgbClr val="000000"><a:alpha val="50000"/></a:srgbClr></a:solidFill>"#;
        let out = items(&sp("", "rect", rest), 10.0, 10.0);
        let Item::Preset { fill, .. } = &out[0] else { panic!("shape: {out:?}") };
        assert_eq!(*fill, Some(Rgb(128, 128, 128)));
    }

    #[test]
    fn placeholder_points_show_their_prompt() {
        // Two empty paragraphs whose data points are placeholders, through `presOf` connections.
        let body = r#"<dsp:sp modelId="{S}"><dsp:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="2540000" cy="1270000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></dsp:spPr><dsp:txBody><a:bodyPr lIns="0" tIns="0" rIns="0" bIns="0" anchor="t"/><a:p><a:endParaRPr sz="1000"/></a:p><a:p><a:endParaRPr sz="1000"/></a:p></dsp:txBody></dsp:sp>"#;
        let data = r#"<dgm:ptLst><dgm:pt modelId="{A}"><dgm:prSet phldrT="[Text]" phldr="1"/></dgm:pt><dgm:pt modelId="{B}"><dgm:prSet phldrT="[More]" phldr="1"/></dgm:pt><dgm:pt modelId="{S}" type="pres"><dgm:prSet presAssocID="{A}"/></dgm:pt></dgm:ptLst><dgm:cxnLst><dgm:cxn modelId="{1}" type="presOf" srcId="{B}" destId="{S}" srcOrd="0" destOrd="1"/><dgm:cxn modelId="{2}" type="presOf" srcId="{A}" destId="{S}" srcOrd="0" destOrd="0"/></dgm:cxnLst>"#;
        let out = items_with_data(body, data, 400.0, 400.0);
        let t: Vec<&str> = texts(&out).into_iter().map(|t| t.0).collect();
        assert_eq!(t, ["[Text]", "[More]"]);
        assert!(out.iter().all(|i| !matches!(i, Item::Text { prompt: false, .. })), "prompts are marked: {out:?}");
        // Without the data model there is nothing to show.
        assert!(texts(&items(body, 400.0, 400.0)).is_empty());
    }

    #[test]
    fn list_style_levels_set_size_indent_and_bullet() {
        // A second-level paragraph: 20 pt and a bullet from the list style, the text at its 36 pt
        // left margin, the bullet 18 pt before it.
        let body = r#"<dsp:sp><dsp:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="2540000" cy="1270000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></dsp:spPr><dsp:txBody><a:bodyPr lIns="0" tIns="0" rIns="0" bIns="0" anchor="t"/><a:lstStyle><a:lvl2pPr marL="457200" indent="-228600" algn="l"><a:buChar char="&#8226;"/><a:defRPr sz="2000"/></a:lvl2pPr></a:lstStyle><a:p><a:pPr lvl="1"/><a:r><a:t>Item</a:t></a:r></a:p></dsp:txBody></dsp:sp>"#;
        let out = items(body, 400.0, 400.0);
        let t = texts(&out);
        let bullet = t.iter().find(|t| t.0 == "\u{2022}").expect("bullet");
        let item = t.iter().find(|t| t.0 == "Item").expect("item");
        assert_eq!((bullet.2, item.2), (20.0, 20.0));
        assert!((item.1[0] - 36.0).abs() < 0.01 && (bullet.1[0] - 18.0).abs() < 0.01, "{t:?}");
        assert!(item.1[1].abs() < 0.01, "anchored at the top: {t:?}");
    }

    #[test]
    fn quarter_turned_text_box_turned_back_is_level_text() {
        // Text turned back by its body (`rot` -90) in a quarter-turned 50 x 200 pt text box: level
        // text across the box as it lies, 200 pt wide less its insets.
        let body = r#"<dsp:sp><dsp:spPr><a:xfrm rot="5400000"><a:off x="1270000" y="0"/><a:ext cx="635000" cy="2540000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></dsp:spPr><dsp:txBody><a:bodyPr rot="-5400000" lIns="127000" tIns="0" rIns="127000" bIns="0" anchor="ctr"/><a:p><a:pPr algn="l"/><a:r><a:rPr sz="1000"/><a:t>Level</a:t></a:r></a:p></dsp:txBody><dsp:txXfrm rot="5400000"><a:off x="1270000" y="0"/><a:ext cx="635000" cy="2540000"/></dsp:txXfrm></dsp:sp>"#;
        let out = items(body, 400.0, 400.0);
        let t = texts(&out);
        assert_eq!(t.len(), 1, "{t:?}");
        let r = t[0].1;
        assert!((r[0] - 35.0).abs() < 0.01 && (r[2] - 180.0).abs() < 0.01, "{r:?}");
        assert!((r[1] + r[3] / 2.0 - 100.0).abs() < 0.01, "centred down the box: {r:?}");
    }

    #[test]
    fn round_rect_takes_theme_colour_and_text() {
        let body = r#"<dsp:sp><dsp:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="1270000" cy="635000"/></a:xfrm><a:prstGeom prst="roundRect"><a:avLst/></a:prstGeom><a:solidFill><a:schemeClr val="accent1"/></a:solidFill><a:ln><a:noFill/></a:ln></dsp:spPr><dsp:style><a:fontRef idx="minor"><a:schemeClr val="lt1"/></a:fontRef></dsp:style><dsp:txBody><a:bodyPr/><a:p><a:pPr algn="ctr"/><a:r><a:rPr sz="2000" b="1"/><a:t>Foo</a:t></a:r></a:p></dsp:txBody></dsp:sp>"#;
        let out = items(body, 100.0, 50.0);
        let Item::Preset { prst, fill, stroke, rect, .. } = &out[0] else { panic!("shape first: {out:?}") };
        assert_eq!(prst, "roundRect");
        assert_eq!(*fill, Some(Rgb(0x15, 0x60, 0x82)));
        assert_eq!(*stroke, None);
        assert_eq!(*rect, [0.0, 0.0, 100.0, 50.0]);
        let Item::Text { text, size, color, bold, align, .. } = &out[1] else { panic!("text second: {out:?}") };
        assert_eq!(text, "Foo");
        assert_eq!((*size, *color, *bold, *align), (20.0, Rgb(255, 255, 255), true, TextAlign::Center));
    }

    #[test]
    fn chevron_is_a_path() {
        let out = items(&sp("", "chevron", ""), 100.0, 100.0);
        let Item::Path { segs, .. } = &out[0] else { panic!("path: {out:?}") };
        assert_eq!(segs.len(), 7);
        assert_eq!(segs.last(), Some(&Seg::Close));
    }

    #[test]
    fn rotated_rect_is_a_rotated_path() {
        let out = items(&sp(r#"rot="2700000""#, "rect", r#"<a:solidFill><a:srgbClr val="FF0000"/></a:solidFill>"#), 100.0, 100.0);
        let Item::Path { segs, fill, .. } = &out[0] else { panic!("path: {out:?}") };
        assert_eq!(*fill, Some(Rgb(255, 0, 0)));
        let Seg::Move(x, y) = segs[0] else { panic!("move") };
        // A 100 pt square turned 45 degrees about its centre: the top-left corner moves to the
        // middle of the top edge's extension.
        assert!((x - 50.0).abs() < 0.01 && (y + 20.71).abs() < 0.01, "got {x} {y}");
    }

    #[test]
    fn lum_mod_darkens_the_theme_colour() {
        let rest = r#"<a:solidFill><a:schemeClr val="accent1"><a:lumMod val="50000"/></a:schemeClr></a:solidFill>"#;
        let out = items(&sp("", "rect", rest), 10.0, 10.0);
        let Item::Preset { fill, .. } = &out[0] else { panic!("shape") };
        let Rgb(r, g, b) = fill.expect("fill");
        // accent1 (156082) at half its luminance.
        assert!(r < 0x15 && g < 0x60 && b < 0x82, "got {r:02x}{g:02x}{b:02x}");
    }

    #[test]
    fn picture_fill_is_an_image() {
        let rest = r#"<a:blipFill><a:blip r:embed="rId1"/><a:stretch><a:fillRect/></a:stretch></a:blipFill>"#;
        let out = items(&sp("", "ellipse", rest), 10.0, 10.0);
        assert!(matches!(&out[0], Item::Image { media, .. } if media == "image1.png"), "{out:?}");
    }

    #[test]
    fn frame_scales_the_drawing_and_groups_transform_children() {
        // A 2 x 2 inch drawing in a 72 pt frame: a group at the origin holds a half-size child.
        let grp = r#"<dsp:grpSp><dsp:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="1270000" cy="1270000"/><a:chOff x="0" y="0"/><a:chExt cx="2540000" cy="2540000"/></a:xfrm></dsp:grpSpPr><dsp:sp><dsp:spPr><a:xfrm><a:off x="1270000" y="1270000"/><a:ext cx="1270000" cy="1270000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></dsp:spPr></dsp:sp></dsp:grpSp>"#;
        let out = items(grp, 72.0, 72.0);
        let Item::Preset { rect, .. } = &out[0] else { panic!("shape: {out:?}") };
        // The group's child sits at half of the 1 in group extent (x = 0.5 in): 36 pt of the 72 pt frame.
        assert_eq!(*rect, [36.0, 36.0, 36.0, 36.0]);
    }

    #[test]
    fn long_text_wraps_into_several_lines() {
        let body = r#"<dsp:sp><dsp:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="1270000" cy="1270000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></dsp:spPr><dsp:txBody><a:bodyPr lIns="0" rIns="0"/><a:p><a:r><a:rPr sz="1000"/><a:t>one two three four five six</a:t></a:r></a:p></dsp:txBody></dsp:sp>"#;
        let out = items(body, 30.0, 30.0);
        let texts: Vec<&str> = out.iter().filter_map(|i| if let Item::Text { text, .. } = i { Some(text.as_str()) } else { None }).collect();
        assert!(texts.len() > 1, "{texts:?}");
        assert_eq!(texts.join(" "), "one two three four five six");
    }

    #[test]
    fn hostile_numbers_and_nesting_do_not_panic() {
        let huge = format!(
            r#"<dsp:sp><dsp:spPr><a:xfrm rot="zzz" flipH="1"><a:off x="99999999999999999999999" y="-1e400"/><a:ext cx="-5" cy="NaN"/></a:xfrm><a:prstGeom prst="leftRightArrow"><a:avLst><a:gd name="adj1" fmla="val 1e999"/><a:gd name="adj2" fmla="val -7"/></a:avLst></a:prstGeom></dsp:spPr><dsp:txBody><a:bodyPr lIns="99999999999999999999" tIns="-9"/><a:p><a:r><a:rPr sz="99999999999999"/><a:t>x</a:t></a:r></a:p></dsp:txBody></dsp:sp>{}"#,
            sp(r#"rot="2700000""#, "chevron", "")
        );
        let mut nested = String::new();
        for _ in 0..40 {
            nested = format!(
                r#"<dsp:grpSp><dsp:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></dsp:grpSpPr>{nested}{}</dsp:grpSp>"#,
                sp("", "rect", "")
            );
        }
        let _ = items(&huge, f32::NAN, -3.0);
        let _ = items(&huge, f32::INFINITY, 1.0e30);
        let _ = items(&nested, 100.0, 100.0);
        let root = drawing(&huge);
        assert!(super::items(&root, None, &[], 10.0, 10.0, &mut |_| None).len() <= MAX_ITEMS);
    }

    #[test]
    fn text_follows_autofit_and_the_drawing_fit() {
        // A 100 pt drawing: `fontScale` 50% halves its 20 pt text and the 18 pt default alike.
        let body = r#"<dsp:sp><dsp:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="1270000" cy="1270000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></dsp:spPr><dsp:txBody><a:bodyPr><a:normAutofit fontScale="50000"/></a:bodyPr><a:p><a:r><a:rPr sz="2000"/><a:t>Big</a:t></a:r></a:p><a:p><a:r><a:rPr/><a:t>Small</a:t></a:r></a:p></dsp:txBody></dsp:sp>"#;
        let sizes = |out: Vec<Item>| -> Vec<(String, f32)> {
            out.into_iter().filter_map(|i| if let Item::Text { text, size, .. } = i { Some((text, size)) } else { None }).collect()
        };
        assert_eq!(sizes(items(body, 100.0, 100.0)), [("Big".to_string(), 10.0), ("Small".to_string(), 9.0)]);
        // In a 50 pt frame the whole drawing is at half size, so its text is too.
        assert_eq!(sizes(items(body, 50.0, 50.0)), [("Big".to_string(), 5.0), ("Small".to_string(), 4.5)]);
    }

    #[test]
    fn one_huge_text_body_stops_at_the_item_limit() {
        let words = "word ".repeat(MAX_ITEMS + 100);
        let body = format!(
            r#"<dsp:sp><dsp:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="12700" cy="12700"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></dsp:spPr><dsp:txBody><a:bodyPr lIns="0" rIns="0"/><a:p><a:r><a:t>{words}</a:t></a:r></a:p><a:p><a:r><a:t>{words}</a:t></a:r></a:p></dsp:txBody></dsp:sp>"#
        );
        let out = items(&body, 1.0, 1.0);
        assert_eq!(out.len(), MAX_ITEMS);
    }

    #[test]
    fn text_far_outside_nested_groups_stays_finite() {
        // Eight groups each scaling 1e9: a shape at -1e9 EMU ends up beyond f32 before clamping.
        let mut tree = r#"<dsp:sp><dsp:spPr><a:xfrm><a:off x="-1000000000" y="0"/><a:ext cx="1000000000" cy="0"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></dsp:spPr><dsp:txBody><a:bodyPr/><a:p><a:r><a:t>Far</a:t></a:r></a:p></dsp:txBody></dsp:sp>"#.to_string();
        for _ in 0..MAX_GROUP_DEPTH {
            tree = format!(
                r#"<dsp:grpSp><dsp:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="1000000000" cy="1"/><a:chOff x="0" y="0"/><a:chExt cx="1" cy="1"/></a:xfrm></dsp:grpSpPr>{tree}</dsp:grpSp>"#
            );
        }
        let out = items(&tree, 100.0, 100.0);
        let rects: Vec<[f32; 4]> = out.iter().filter_map(|i| if let Item::Text { rect, .. } = i { Some(*rect) } else { None }).collect();
        assert!(!rects.is_empty() && rects.iter().flatten().all(|v| v.is_finite()), "{rects:?}");
    }
}
