//! Typed operations on drawing objects (`KitDrawing 1.0` section 3), parsed and validated from
//! `drawing.*` command parameters and applied to a [`DrawingObject`]. A kit runs one operation
//! inside one of its own commands, so the edit is one transaction in its undo history and KDM
//! replica; nothing here keeps a history.

use serde_json::{Value, json};

use crate::geom::Xfrm;
use crate::model::{self, Color, DrawingObject, Fill, Geometry, ObjectKind, Placement, Stroke, TextBody};

/// Largest frame side or offset a command may set, points (about 55 m).
pub const MAX_LENGTH: f64 = 158_400.0;
/// Most objects one command may name.
pub const MAX_IDS: usize = 10_000;

/// A command's structured failure (DR11).
#[derive(Clone, Debug, PartialEq)]
pub struct DrawingError {
    /// `invalid`, `not-found`, `unsupported`, or `read-only`.
    pub code: &'static str,
    pub message: String,
    /// The property an `unsupported` error is about.
    pub property: Option<String>,
}

impl DrawingError {
    pub fn invalid(message: impl Into<String>) -> Self {
        DrawingError { code: "invalid", message: message.into(), property: None }
    }
    /// Commands address the slide, page or sheet being edited (DR9); an id on another part
    /// requires navigating to that part first.
    pub fn not_found(id: &str) -> Self {
        DrawingError {
            code: "not-found",
            message: format!(
                "no drawing object `{id}` on the slide, page or sheet being edited; to reach another, go to it first (the run tool's `target`); drawing.describe without `ids` lists the objects here"
            ),
            property: None,
        }
    }
    pub fn unsupported(property: &str, message: impl Into<String>) -> Self {
        DrawingError { code: "unsupported", message: message.into(), property: Some(property.into()) }
    }
    pub fn read_only() -> Self {
        DrawingError { code: "read-only", message: "the document is read-only for this person".into(), property: None }
    }
    /// The error as command results report it: `{code, message, data: {property}}`.
    pub fn to_value(&self) -> Value {
        let mut v = json!({ "code": self.code, "message": self.message });
        if let Some(p) = &self.property {
            v["data"] = json!({ "property": p });
        }
        v
    }
}

impl std::fmt::Display for DrawingError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for DrawingError {}

pub type Result<T> = std::result::Result<T, DrawingError>;

/// How a transform changes each object's frame.
#[derive(Clone, Debug, PartialEq)]
pub enum FrameChange {
    /// Set the whole frame (one object), or each object's (a gesture's commit).
    Set(Vec<(String, Xfrm)>),
    /// Move, turn, or mirror every named object by the same amounts.
    By { ids: Vec<String>, dx: f64, dy: f64, rotate_by: f64, flip_h: bool, flip_v: bool },
}

/// Formatting changes; `None` leaves a property as it is.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Format {
    pub fill: Option<Fill>,
    pub stroke: Option<Stroke>,
    pub geometry: Option<Geometry>,
    /// The shadow and glow to set (`Some(None)`: none); a member left out stays (DR24).
    pub shadow: Option<Option<crate::model::Shadow>>,
    pub glow: Option<Option<crate::model::Glow>>,
}

/// One operation.
#[derive(Clone, Debug, PartialEq)]
pub enum DrawingOp {
    Insert(Box<DrawingObject>),
    Delete(Vec<String>),
    Transform(FrameChange),
    Format {
        ids: Vec<String>,
        format: Format,
    },
    /// New text. Without `layout` only the paragraphs change and the body keeps its anchor,
    /// insets, wrap, and autofit; without `paragraphs` they stay too. `warp` sets the body's text
    /// warp (`Some(None)` removes it, DR27).
    Text {
        id: String,
        body: TextBody,
        layout: bool,
        paragraphs: bool,
        warp: Option<Option<model::Warp>>,
    },
    /// `drawing.reconnect` (`KitDrawing` 1.4, DR25): one end of connector `id` glued to `to`, or
    /// left free (moved to `point` when given).
    Reconnect {
        id: String,
        end: usize,
        to: Option<crate::connect::End>,
        point: Option<crate::Point>,
    },
    /// `drawing.chart` (`KitDrawing` 1.1, DR16).
    Chart {
        id: String,
        change: crate::chart::ChartChange,
    },
}

impl DrawingOp {
    /// The objects the operation changes (none for an insert).
    pub fn ids(&self) -> Vec<String> {
        match self {
            DrawingOp::Insert(_) => Vec::new(),
            DrawingOp::Delete(ids) | DrawingOp::Format { ids, .. } => ids.clone(),
            DrawingOp::Transform(FrameChange::Set(frames)) => frames.iter().map(|(id, _)| id.clone()).collect(),
            DrawingOp::Transform(FrameChange::By { ids, .. }) => ids.clone(),
            DrawingOp::Text { id, .. } | DrawingOp::Chart { id, .. } | DrawingOp::Reconnect { id, .. } => vec![id.clone()],
        }
    }

    /// Parses `drawing.<name>` parameters. `drawing.describe` is a query, not an operation.
    pub fn parse(command: &str, p: &Value) -> Result<DrawingOp> {
        match command {
            "drawing.insert" => Ok(DrawingOp::Insert(Box::new(insert(p)?))),
            "drawing.delete" => Ok(DrawingOp::Delete(ids(p)?)),
            "drawing.transform" => transform(p),
            "drawing.format" => Ok(DrawingOp::Format { ids: ids(p)?, format: format(p)? }),
            "drawing.text" => {
                let id: &str = &match p.get("id") {
                    Some(Value::String(s)) if !s.is_empty() => s.clone(),
                    Some(Value::Number(n)) => n.to_string(),
                    _ => return Err(DrawingError::invalid("missing `id`")),
                };
                let warp = warp(p)?;
                let paragraphs = p.get("paragraphs").is_some() || p.get("text").is_some();
                let layout = p.get("body").is_some() || text_lays_out(p);
                let body = match (paragraphs, layout) {
                    (true, _) => text(p)?,
                    (false, true) => layout_only(p)?,
                    (false, false) if warp.is_some() => TextBody::default(),
                    (false, false) => return Err(DrawingError::invalid("give `text`, `paragraphs`, `body`, or `warp`")),
                };
                Ok(DrawingOp::Text { id: id.into(), body, layout, paragraphs, warp })
            }
            "drawing.reconnect" => {
                let id: &str = &match p.get("id") {
                    Some(Value::String(s)) if !s.is_empty() => s.clone(),
                    Some(Value::Number(n)) => n.to_string(),
                    _ => return Err(DrawingError::invalid("missing `id`")),
                };
                let end = match p.get("end").and_then(Value::as_str) {
                    Some("start") => 0,
                    Some("end") => 1,
                    _ => return Err(DrawingError::invalid("`end` is `start` or `end`")),
                };
                let to = match p.get("to") {
                    None | Some(Value::Null) => None,
                    Some(t) => {
                        let to = t
                            .as_str()
                            .map(str::to_string)
                            .or_else(|| t.as_u64().map(|n| n.to_string()))
                            .ok_or_else(|| DrawingError::invalid("`to` names an object"))?;
                        let site = p.get("site").and_then(Value::as_u64).ok_or_else(|| DrawingError::invalid("`site` is the site's index on `to`"))?;
                        if to == id {
                            return Err(DrawingError::invalid("a connector does not glue to itself"));
                        }
                        Some(crate::connect::End { id: to, site: site as usize })
                    }
                };
                let point = match p.get("point") {
                    None | Some(Value::Null) => None,
                    Some(v) => {
                        let xy: [f64; 2] = serde_json::from_value(v.clone()).map_err(|_| DrawingError::invalid("`point` is [x, y]"))?;
                        if !xy.iter().all(|c| c.is_finite() && c.abs() <= 1e7) {
                            return Err(DrawingError::invalid("`point` is [x, y]"));
                        }
                        Some(crate::Point::new(xy[0], xy[1]))
                    }
                };
                Ok(DrawingOp::Reconnect { id: id.into(), end, to, point })
            }
            "drawing.chart" => {
                let id = ids(p)?;
                let [id] = <[String; 1]>::try_from(id).map_err(|_| DrawingError::invalid("`drawing.chart` changes one chart"))?;
                Ok(DrawingOp::Chart { id, change: crate::chart::ChartChange::parse(p)? })
            }
            other => Err(DrawingError::invalid(format!("`{other}` is not a drawing operation"))),
        }
    }

    /// Applies the operation to object `o` (one the operation names). Inserts and deletes are
    /// the kit's to apply to its own list; for them this does nothing.
    pub fn apply(&self, o: &mut DrawingObject) -> Result<()> {
        match self {
            DrawingOp::Insert(_) | DrawingOp::Delete(_) => Ok(()),
            DrawingOp::Transform(FrameChange::Set(frames)) => {
                if let Some((_, f)) = frames.iter().find(|(id, _)| *id == o.id) {
                    o.frame = *f;
                }
                Ok(())
            }
            DrawingOp::Transform(FrameChange::By { dx, dy, rotate_by, flip_h, flip_v, .. }) => {
                o.frame = moved(&o.frame, *dx, *dy, *rotate_by, *flip_h, *flip_v)?;
                Ok(())
            }
            DrawingOp::Format { format, .. } => {
                if let Some(fill) = &format.fill {
                    o.fill = Some(fill.clone());
                }
                if let Some(stroke) = &format.stroke {
                    o.stroke = Some(merge_stroke(o.stroke.take(), stroke));
                }
                if let Some(g) = &format.geometry {
                    o.geometry = g.clone();
                }
                if format.shadow.is_some() || format.glow.is_some() {
                    let mut e = o.effects.take().unwrap_or_default();
                    if let Some(sh) = &format.shadow {
                        e.shadow.clone_from(sh);
                    }
                    if let Some(gl) = &format.glow {
                        e.glow.clone_from(gl);
                    }
                    o.effects = (!e.is_empty()).then_some(e);
                }
                Ok(())
            }
            DrawingOp::Text { body, layout, paragraphs, warp, .. } => {
                match (o.text.as_mut(), layout, paragraphs) {
                    (Some(_), false, false) => {}
                    (Some(old), false, true) => old.paragraphs.clone_from(&body.paragraphs),
                    (Some(old), true, false) => {
                        let (paragraphs, warp) = (std::mem::take(&mut old.paragraphs), old.warp.take());
                        *old = TextBody { paragraphs, warp, ..body.clone() };
                    }
                    _ => o.text = Some(body.clone()),
                }
                if let (Some(w), Some(t)) = (warp, o.text.as_mut()) {
                    t.warp.clone_from(w);
                }
                Ok(())
            }
            DrawingOp::Reconnect { end, to, point, .. } => {
                if !crate::connect::is_connector(o) {
                    return Err(DrawingError::unsupported("id", format!("object {} is not a connector", o.id)));
                }
                let mut conn = o.connection.clone().unwrap_or_default();
                *(if *end == 0 { &mut conn.start } else { &mut conn.end }) = to.clone();
                if let Some(p) = point {
                    let (p0, p1) = crate::connect::line_ends(&o.frame);
                    o.frame = if *end == 0 { crate::connect::line_frame(*p, p1) } else { crate::connect::line_frame(p0, *p) };
                }
                o.connection = (conn.start.is_some() || conn.end.is_some()).then_some(conn);
                Ok(())
            }
            DrawingOp::Chart { change, .. } => match o.chart.as_mut() {
                Some(c) => change.apply(c),
                None => Err(DrawingError::unsupported("kind", format!("object {} is not a chart", o.id))),
            },
        }
    }
}

/// A frame moved by `dx`, `dy`, turned by `rotate_by` degrees, and mirrored, checked.
pub fn moved(f: &Xfrm, dx: f64, dy: f64, rotate_by: f64, flip_h: bool, flip_v: bool) -> Result<Xfrm> {
    let mut n = *f;
    n.x += dx;
    n.y += dy;
    n.rot = (n.rot + rotate_by).rem_euclid(360.0);
    n.flip_h ^= flip_h;
    n.flip_v ^= flip_v;
    check_frame(&n)?;
    Ok(n)
}

/// A frame every kit can keep: finite, sizes from 0 up to [`MAX_LENGTH`], offsets within it.
pub fn check_frame(f: &Xfrm) -> Result<()> {
    if !f.is_finite() {
        return Err(DrawingError::invalid("the frame has a value that is not a number"));
    }
    if f.w < 0.0 || f.h < 0.0 || f.w > MAX_LENGTH || f.h > MAX_LENGTH || f.x.abs() > MAX_LENGTH || f.y.abs() > MAX_LENGTH {
        return Err(DrawingError::invalid(format!("frame sizes are 0 to {MAX_LENGTH} pt and offsets within ±{MAX_LENGTH} pt")));
    }
    Ok(())
}

fn merge_stroke(old: Option<Stroke>, new: &Stroke) -> Stroke {
    if new.none {
        return Stroke { none: true, ..Default::default() };
    }
    let old = old.unwrap_or_default();
    Stroke { none: false, color: new.color.clone().or(old.color), width: new.width.or(old.width), dash: new.dash.clone().or(old.dash) }
}

fn ids(p: &Value) -> Result<Vec<String>> {
    let list = match (p.get("ids"), p.get("id")) {
        (Some(Value::Array(a)), _) => a.iter().map(id_text).collect::<Option<Vec<_>>>().ok_or_else(|| DrawingError::invalid("`ids` holds ids"))?,
        (None, Some(id)) => vec![id_text(id).ok_or_else(|| DrawingError::invalid("`id` is an id"))?],
        _ => return Err(DrawingError::invalid("missing `ids`")),
    };
    if list.is_empty() || list.len() > MAX_IDS {
        return Err(DrawingError::invalid(format!("name 1 to {MAX_IDS} objects")));
    }
    Ok(list)
}

/// Ids are strings; kits whose ids are numbers accept them as numbers too.
fn id_text(v: &Value) -> Option<String> {
    match v {
        Value::String(s) if !s.is_empty() => Some(s.clone()),
        Value::Number(n) => n.as_u64().map(|n| n.to_string()),
        _ => None,
    }
}

fn number(p: &Value, key: &str) -> Result<Option<f64>> {
    match p.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(v) => v.as_f64().filter(|n| n.is_finite()).map(Some).ok_or_else(|| DrawingError::invalid(format!("`{key}` is a number"))),
    }
}

fn frame(v: &Value) -> Result<Xfrm> {
    let f: Xfrm = serde_json::from_value(v.clone()).map_err(|e| DrawingError::invalid(format!("frame: {e}")))?;
    check_frame(&f)?;
    Ok(f)
}

fn transform(p: &Value) -> Result<DrawingOp> {
    let ids = ids(p)?;
    if let Some(f) = p.get("frame") {
        if ids.len() != 1 {
            return Err(DrawingError::invalid("`frame` sets one object's frame; use dx/dy for several"));
        }
        let f = frame(f)?;
        return Ok(DrawingOp::Transform(FrameChange::Set(ids.into_iter().map(|id| (id, f)).collect())));
    }
    let dx = number(p, "dx")?.unwrap_or(0.0);
    let dy = number(p, "dy")?.unwrap_or(0.0);
    let rotate_by = number(p, "rotateBy")?.unwrap_or(0.0);
    if dx.abs() > MAX_LENGTH || dy.abs() > MAX_LENGTH || rotate_by.abs() > 3600.0 {
        return Err(DrawingError::invalid("move or turn out of range"));
    }
    let flag = |k: &str| p.get(k).and_then(Value::as_bool).unwrap_or(false);
    Ok(DrawingOp::Transform(FrameChange::By { ids, dx, dy, rotate_by, flip_h: flag("flipH"), flip_v: flag("flipV") }))
}

fn format(p: &Value) -> Result<Format> {
    let fill = match p.get("fill") {
        None => None,
        Some(v) => Some(
            Fill::from_value(v).ok_or_else(|| DrawingError::invalid("a fill is a colour (\"#rrggbb\", \"accent1\"), {color}, {gradient}, or {none: true}"))?,
        ),
    };
    let stroke = match p.get("stroke") {
        None => None,
        Some(v) => Some(stroke(v)?),
    };
    let geometry = match p.get("geometry") {
        None => None,
        Some(v) => Some(geometry(v)?),
    };
    let (mut shadow, mut glow) = (None, None);
    if let Some(e) = p.get("effects") {
        let e = e.as_object().ok_or_else(|| DrawingError::invalid("`effects` is {shadow?, glow?}"))?;
        if let Some(v) = e.get("shadow") {
            shadow = Some(match v {
                Value::Null => None,
                v => {
                    let color = v.get("color").and_then(Color::from_value).filter(Color::is_valid).ok_or_else(|| DrawingError::invalid("a shadow's colour"))?;
                    let blur = number(v, "blur")?.unwrap_or(4.0);
                    let distance = number(v, "distance")?.unwrap_or(3.0);
                    let angle = number(v, "angle")?.unwrap_or(45.0);
                    if !(0.0..=200.0).contains(&blur) || !(0.0..=200.0).contains(&distance) {
                        return Err(DrawingError::invalid("a shadow's blur and distance are 0 to 200 pt"));
                    }
                    Some(crate::model::Shadow { color, blur, distance, angle: angle.rem_euclid(360.0) })
                }
            });
        }
        if let Some(v) = e.get("glow") {
            glow = Some(match v {
                Value::Null => None,
                v => {
                    let color = v.get("color").and_then(Color::from_value).filter(Color::is_valid).ok_or_else(|| DrawingError::invalid("a glow's colour"))?;
                    let size = number(v, "size")?.unwrap_or(5.0);
                    if !(0.0..=150.0).contains(&size) {
                        return Err(DrawingError::invalid("a glow is 0 to 150 pt"));
                    }
                    Some(crate::model::Glow { color, size })
                }
            });
        }
    }
    if fill.is_none() && stroke.is_none() && geometry.is_none() && shadow.is_none() && glow.is_none() {
        return Err(DrawingError::invalid("give `fill`, `stroke`, `geometry`, or `effects`"));
    }
    Ok(Format { fill, stroke, geometry, shadow, glow })
}

fn stroke(v: &Value) -> Result<Stroke> {
    if v.get("none").and_then(Value::as_bool) == Some(true) {
        return Ok(Stroke { none: true, ..Default::default() });
    }
    let color = match v.get("color") {
        None => None,
        Some(c) => Some(Color::from_value(c).ok_or_else(|| DrawingError::invalid("stroke color: `#RRGGBB`, a theme slot, or {rgb|theme}"))?),
    };
    let width = number(v, "width")?;
    if width.is_some_and(|w| !(0.0..=1584.0).contains(&w)) {
        return Err(DrawingError::invalid("stroke width is 0 to 1584 pt"));
    }
    let dash = match v.get("dash").and_then(Value::as_str) {
        None => None,
        Some(d) if model::DASHES.contains(&d) => Some(d.to_string()),
        Some(d) => return Err(DrawingError::invalid(format!("unknown dash `{d}`"))),
    };
    Ok(Stroke { none: false, color, width, dash })
}

fn geometry(v: &Value) -> Result<Geometry> {
    // Name the accepted geometry shapes when the untagged enum cannot be decoded.
    let g: Geometry = serde_json::from_value(v.clone()).map_err(|_| {
        DrawingError::invalid(
            "geometry is {preset, adjust?: {guide: value}} (for example {\"preset\": \"roundRect\", \"adjust\": {\"adj\": 16667}}) or {paths: [...]}",
        )
    })?;
    match &g {
        Geometry::Preset { preset, adjust } => {
            if crate::preset::info(preset).is_none() {
                return Err(DrawingError::unsupported("geometry.preset", format!("preset `{preset}` is not drawn")));
            }
            if adjust.len() > 16 || adjust.iter().any(|(k, v)| model::guide_index(k).is_none() || !v.is_finite()) {
                return Err(DrawingError::invalid("adjust values are numbers named adj, adj1…adj16"));
            }
        }
        Geometry::Custom { paths } => {
            if paths.is_empty() || paths.len() > 1000 || paths.iter().any(|p| p.d.len() > 1_000_000 || !(p.w.is_finite() && p.h.is_finite())) {
                return Err(DrawingError::invalid("1 to 1000 custom paths of reasonable size"));
            }
        }
    }
    Ok(g)
}

/// What `text` is, for the error when it is neither.
const TEXT_FORMS: &str = "`text` is a string (a line break starts a new paragraph), or the text object `drawing.describe` gives: \
     {paragraphs: [{runs: [{text, font?, size?, bold?, color?}], align?}], anchor?, insets?, wrap?, autofit?}";

/// Where paragraphs (`at`, e.g. `paragraphs` or `text.paragraphs`) fail to read: the first run or
/// paragraph serde refuses, with serde's reason, so the agent sees which field is wrong.
fn paragraphs_error(paras: &Value, at: &str, e: &serde_json::Error) -> DrawingError {
    let Some(list) = paras.as_array() else { return DrawingError::invalid(format!("{at} is a list of paragraphs, {{runs: [...], align?}}")) };
    for (i, para) in list.iter().enumerate() {
        for (j, run) in para.get("runs").and_then(Value::as_array).into_iter().flatten().enumerate() {
            if let Err(e) = serde_json::from_value::<model::Run>(run.clone()) {
                let hint = if run.get("font").is_some_and(Value::is_object) {
                    "; `font` is the family's name, and size, bold, italic, underline and color are fields of the run itself"
                } else {
                    ""
                };
                return DrawingError::invalid(format!("{at}[{i}].runs[{j}]: {e}{hint}"));
            }
        }
        if let Err(e) = serde_json::from_value::<model::Paragraph>(para.clone()) {
            return DrawingError::invalid(format!("{at}[{i}]: {e}"));
        }
    }
    DrawingError::invalid(format!("{at}: {e}"))
}

/// `text` given as the text object `drawing.describe` gives; `None` for a string or no `text`.
fn text_object(p: &Value) -> Result<Option<TextBody>> {
    match p.get("text") {
        None | Some(Value::String(_)) => Ok(None),
        Some(t @ Value::Object(o)) if o.contains_key("paragraphs") => serde_json::from_value(t.clone()).map(Some).map_err(|e| {
            let located = paragraphs_error(&o["paragraphs"], "text.paragraphs", &e);
            if located.message.starts_with("text.paragraphs[") { located } else { DrawingError::invalid(format!("text: {e}; {TEXT_FORMS}")) }
        }),
        Some(_) => Err(DrawingError::invalid(TEXT_FORMS)),
    }
}

/// Whether `text` is a text object that says how the body is laid out.
fn text_lays_out(p: &Value) -> bool {
    p.get("text").and_then(Value::as_object).is_some_and(|t| ["anchor", "insets", "wrap", "autofit"].iter().any(|k| t.contains_key(*k)))
}

/// The body's layout from `body`, else from a text object; its paragraphs are left to the caller.
fn layout(p: &Value, given: Option<&TextBody>) -> Result<TextBody> {
    match p.get("body") {
        Some(b @ Value::Object(_)) => serde_json::from_value::<TextBody>(b.clone()).map_err(|e| DrawingError::invalid(format!("body: {e}"))),
        Some(_) => Err(DrawingError::invalid("`body` is {anchor, insets, wrap, autofit}")),
        None => Ok(given.map(|g| TextBody { paragraphs: Vec::new(), ..g.clone() }).unwrap_or_default()),
    }
}

/// `drawing.text` with only `body` (or a text object's layout): the layout, no paragraphs.
fn layout_only(p: &Value) -> Result<TextBody> {
    let body = layout(p, text_object(p)?.as_ref())?;
    check_text(&body)?;
    Ok(body)
}

fn text(p: &Value) -> Result<TextBody> {
    let given = text_object(p)?;
    let mut body = layout(p, given.as_ref())?;
    body.paragraphs = match (p.get("paragraphs"), p.get("text"), given) {
        (Some(paras), _, _) => serde_json::from_value(paras.clone()).map_err(|e| paragraphs_error(paras, "paragraphs", &e))?,
        (None, Some(Value::String(t)), _) => TextBody::plain(t).paragraphs,
        (None, _, Some(given)) => given.paragraphs,
        _ => return Err(DrawingError::invalid("give `text` or `paragraphs`")),
    };
    check_text(&body)?;
    Ok(body)
}

/// `warp`: a preset name, `{preset, adjust}`, or `null` to remove the warp; `None` when absent.
fn warp(p: &Value) -> Result<Option<Option<model::Warp>>> {
    let w = match p.get("warp").or_else(|| p.get("body").and_then(|b| b.get("warp"))) {
        None => return Ok(None),
        Some(Value::Null) => return Ok(Some(None)),
        Some(Value::String(name)) => model::Warp { preset: name.clone(), ..Default::default() },
        Some(w) => serde_json::from_value::<model::Warp>(w.clone()).map_err(|e| DrawingError::invalid(format!("warp: {e}")))?,
    };
    check_warp(&w)?;
    Ok(Some((w.preset != "textPlain").then_some(w)))
}

fn check_warp(w: &model::Warp) -> Result<()> {
    if !crate::warp::is_warp(&w.preset) {
        return Err(DrawingError::unsupported("warp", format!("no text warp `{}`", w.preset)));
    }
    if w.adjust.len() > 8 || w.adjust.values().any(|v| !v.is_finite()) {
        return Err(DrawingError::invalid("warp adjust values"));
    }
    Ok(())
}

fn check_text(body: &TextBody) -> Result<()> {
    if let Some(w) = &body.warp {
        check_warp(w)?;
    }
    let runs: usize = body.paragraphs.iter().map(|p| p.runs.len()).sum();
    let chars: usize = body.paragraphs.iter().flat_map(|p| &p.runs).map(|r| r.text.chars().count()).sum();
    if body.paragraphs.len() > model::MAX_ITEMS || runs > model::MAX_ITEMS || chars > model::MAX_TEXT {
        return Err(DrawingError::invalid("text too long"));
    }
    if body.insets.iter().any(|v| !v.is_finite() || !(0.0..=1584.0).contains(v)) {
        return Err(DrawingError::invalid("insets are 0 to 1584 pt"));
    }
    for r in body.paragraphs.iter().flat_map(|p| &p.runs) {
        if r.size.is_some_and(|s| !(1.0..=4000.0).contains(&s)) {
            return Err(DrawingError::invalid("text size is 1 to 4000 pt"));
        }
        if r.color.as_ref().is_some_and(|c| !c.is_valid()) {
            return Err(DrawingError::invalid("run color"));
        }
    }
    Ok(())
}

fn insert(p: &Value) -> Result<DrawingObject> {
    let kind: ObjectKind = match p.get("kind") {
        None => ObjectKind::Shape,
        Some(k) => serde_json::from_value(k.clone()).map_err(|_| DrawingError::unsupported("kind", "KitDrawing inserts `shape`, `textBox`, and `chart`"))?,
    };
    if kind == ObjectKind::Group {
        return Err(DrawingError::unsupported("kind", "a group is made with `drawing.group`"));
    }
    let mut o = DrawingObject { kind, ..Default::default() };
    if kind == ObjectKind::Chart {
        // A sample chart of the type asked for, then the members given (DR16).
        let given = p.get("chart").cloned().unwrap_or_else(|| json!({}));
        let start = match given.get("kind") {
            Some(Value::String(k)) => crate::chart::ChartKind::parse(k).ok_or_else(|| DrawingError::unsupported("chart.kind", format!("chart type `{k}`")))?,
            _ => crate::chart::ChartKind::Column,
        };
        let mut spec = crate::chart::ChartSpec::sample(start.clone());
        if start.is_pie() {
            spec.series.truncate(1);
            spec.gridlines = false;
            spec.legend = Some(crate::chart::LegendPos::Right);
        }
        if given.as_object().is_some_and(|m| m.keys().any(|k| k != "kind")) {
            crate::chart::ChartChange::parse(&given)?.apply(&mut spec)?;
        }
        o.chart = Some(spec);
    }
    o.geometry = match p.get("geometry") {
        Some(g) => geometry(g)?,
        None => Geometry::preset("rect"),
    };
    if let Some(f) = p.get("frame") {
        o.frame = frame(f)?;
    }
    if let Some(pl) = p.get("placement") {
        o.placement = serde_json::from_value::<Placement>(pl.clone()).map_err(|e| DrawingError::invalid(format!("placement: {e}")))?;
    }
    if let Some(v) = p.get("fill") {
        o.fill = Some(
            Fill::from_value(v).ok_or_else(|| DrawingError::invalid("a fill is a colour (\"#rrggbb\", \"accent1\"), {color}, {gradient}, or {none: true}"))?,
        );
    }
    if let Some(v) = p.get("stroke") {
        o.stroke = Some(stroke(v)?);
    }
    if p.get("text").is_some() || p.get("paragraphs").is_some() {
        o.text = Some(text(p)?);
    } else if kind == ObjectKind::TextBox {
        o.text = Some(TextBody::plain(""));
    }
    if let Some(w) = warp(p)? {
        o.text.get_or_insert_with(TextBody::default).warp = w;
    }
    Ok(o)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::Rgb;

    #[test]
    fn insert_takes_defaults_and_checks_values() {
        let op = DrawingOp::parse(
            "drawing.insert",
            &json!({ "geometry": { "preset": "ellipse" }, "frame": { "x": 10, "y": 20, "w": 100, "h": 50 }, "fill": { "color": "#FF0000" }, "text": "Hi" }),
        )
        .unwrap();
        let DrawingOp::Insert(o) = op else { panic!() };
        assert_eq!(o.geometry, Geometry::preset("ellipse"));
        assert_eq!(o.fill, Some(Fill::Solid(Color::rgb(Rgb(255, 0, 0)))));
        assert_eq!(o.text.unwrap().text(), "Hi");
        let tb = DrawingOp::parse("drawing.insert", &json!({ "kind": "textBox" })).unwrap();
        assert!(matches!(tb, DrawingOp::Insert(o) if o.text.is_some() && o.kind == ObjectKind::TextBox));
        let bad = DrawingOp::parse("drawing.insert", &json!({ "kind": "picture" })).unwrap_err();
        assert_eq!((bad.code, bad.property.as_deref()), ("unsupported", Some("kind")));
        assert_eq!(DrawingOp::parse("drawing.insert", &json!({ "geometry": { "preset": "noSuchShape" } })).unwrap_err().code, "unsupported");
        assert_eq!(DrawingOp::parse("drawing.insert", &json!({ "frame": { "x": 0, "y": 0, "w": -5, "h": 1 } })).unwrap_err().code, "invalid");
        assert_eq!(DrawingOp::parse("drawing.insert", &json!({ "fill": { "color": "nope" } })).unwrap_err().code, "invalid");
    }

    #[test]
    fn transform_by_and_set() {
        let mut o = DrawingObject { id: "7".into(), frame: Xfrm::new(0.0, 0.0, 10.0, 10.0), ..Default::default() };
        DrawingOp::parse("drawing.transform", &json!({ "ids": [7], "dx": 5, "dy": -2, "rotateBy": 450, "flipH": true })).unwrap().apply(&mut o).unwrap();
        assert_eq!((o.frame.x, o.frame.y, o.frame.rot, o.frame.flip_h), (5.0, -2.0, 90.0, true));
        let set = DrawingOp::parse("drawing.transform", &json!({ "id": "7", "frame": { "x": 1, "y": 2, "w": 3, "h": 4 } })).unwrap();
        set.apply(&mut o).unwrap();
        assert_eq!(o.frame, Xfrm::new(1.0, 2.0, 3.0, 4.0));
        assert!(DrawingOp::parse("drawing.transform", &json!({ "ids": ["1", "2"], "frame": { "x": 1, "y": 2, "w": 3, "h": 4 } })).is_err());
        assert!(DrawingOp::parse("drawing.transform", &json!({ "ids": [] })).is_err());
        assert!(DrawingOp::parse("drawing.transform", &json!({ "ids": ["1"], "dx": "far" })).is_err());
        let far = DrawingOp::parse("drawing.transform", &json!({ "ids": ["7"], "dx": MAX_LENGTH })).unwrap();
        assert_eq!(far.apply(&mut o).unwrap_err().code, "invalid");
    }

    #[test]
    fn format_merges_the_stroke() {
        let mut o = DrawingObject {
            id: "1".into(),
            stroke: Some(Stroke { width: Some(2.0), color: Some(Color::theme("accent1")), ..Default::default() }),
            ..Default::default()
        };
        DrawingOp::parse("drawing.format", &json!({ "id": "1", "stroke": { "color": "#000000" } })).unwrap().apply(&mut o).unwrap();
        let s = o.stroke.clone().unwrap();
        assert_eq!((s.width, s.color), (Some(2.0), Some(Color::rgb(Rgb(0, 0, 0)))));
        DrawingOp::parse("drawing.format", &json!({ "id": "1", "stroke": { "none": true }, "fill": { "none": true } })).unwrap().apply(&mut o).unwrap();
        assert!(o.stroke.unwrap().none);
        assert_eq!(o.fill, Some(Fill::None));
        assert!(DrawingOp::parse("drawing.format", &json!({ "id": "1" })).is_err());
        // Effects: a member given changes, one left out stays, null removes.
        let mut o = DrawingObject { id: "1".into(), ..Default::default() };
        DrawingOp::parse(
            "drawing.format",
            &json!({ "id": "1", "effects": { "shadow": { "color": { "rgb": "#000000", "alpha": 0.4 } }, "glow": { "color": "#5645D4", "size": 6 } } }),
        )
        .unwrap()
        .apply(&mut o)
        .unwrap();
        let e = o.effects.clone().unwrap();
        assert_eq!((e.shadow.as_ref().map(|s| (s.blur, s.distance, s.angle)), e.glow.as_ref().map(|g| g.size)), (Some((4.0, 3.0, 45.0)), Some(6.0)));
        DrawingOp::parse("drawing.format", &json!({ "id": "1", "effects": { "shadow": null } })).unwrap().apply(&mut o).unwrap();
        assert!(o.effects.as_ref().is_some_and(|e| e.shadow.is_none() && e.glow.is_some()));
        DrawingOp::parse("drawing.format", &json!({ "id": "1", "effects": { "glow": null } })).unwrap().apply(&mut o).unwrap();
        assert_eq!(o.effects, None);
        assert!(DrawingOp::parse("drawing.format", &json!({ "id": "1", "effects": { "shadow": { "color": "#000000", "blur": 900 } } })).is_err());
        assert!(DrawingOp::parse("drawing.format", &json!({ "id": "1", "stroke": { "dash": "wavy" } })).is_err());
    }

    #[test]
    fn text_from_plain_text_or_paragraphs() {
        let op = DrawingOp::parse("drawing.text", &json!({ "id": "1", "text": "a\nb" })).unwrap();
        let DrawingOp::Text { body, .. } = &op else { panic!() };
        assert_eq!(body.paragraphs.len(), 2);
        let op = DrawingOp::parse("drawing.text", &json!({ "id": "1", "paragraphs": [{ "align": "right", "runs": [{ "text": "x", "size": 30 }] }] })).unwrap();
        let DrawingOp::Text { body, .. } = &op else { panic!() };
        assert_eq!(body.paragraphs[0].runs[0].size, Some(30.0));
        assert!(DrawingOp::parse("drawing.text", &json!({ "id": "1", "paragraphs": [{ "runs": [{ "text": "x", "size": 0 }] }] })).is_err());
        assert!(DrawingOp::parse("drawing.text", &json!({ "text": "x" })).is_err());
    }

    #[test]
    fn warps_are_set_kept_and_removed() {
        let mut o = DrawingObject { id: "1".into(), text: Some(TextBody::plain("Art text")), ..Default::default() };
        DrawingOp::parse("drawing.text", &json!({ "id": "1", "warp": "textArchUp" })).unwrap().apply(&mut o).unwrap();
        let t = o.text.clone().unwrap();
        assert_eq!((t.text().as_str(), t.warp.unwrap().preset.as_str()), ("Art text", "textArchUp"));
        // New text keeps the warp.
        DrawingOp::parse("drawing.text", &json!({ "id": "1", "text": "Kition" })).unwrap().apply(&mut o).unwrap();
        assert_eq!(o.text.as_ref().unwrap().warp.as_ref().unwrap().preset, "textArchUp");
        let op = json!({ "id": "1", "warp": { "preset": "textWave1", "adjust": { "adj1": 12500 } } });
        DrawingOp::parse("drawing.text", &op).unwrap().apply(&mut o).unwrap();
        assert_eq!(o.text.as_ref().unwrap().warp.as_ref().unwrap().adjust["adj1"], 12500.0);
        DrawingOp::parse("drawing.text", &json!({ "id": "1", "warp": null })).unwrap().apply(&mut o).unwrap();
        assert_eq!((o.text.as_ref().unwrap().warp.clone(), o.text.as_ref().unwrap().text()), (None, "Kition".into()));
        let e = DrawingOp::parse("drawing.text", &json!({ "id": "1", "warp": "textSpiral" })).unwrap_err();
        assert_eq!(e.property.as_deref(), Some("warp"));
        let ins = DrawingOp::parse("drawing.insert", &json!({ "kind": "textBox", "text": "Hi", "warp": "textInflate" })).unwrap();
        assert!(matches!(ins, DrawingOp::Insert(o) if o.text.as_ref().unwrap().warp.as_ref().unwrap().preset == "textInflate"));
    }

    /// `drawing.text {id, body}` accepts layout edits without replacement text.
    #[test]
    fn body_alone_lays_the_text_out_and_keeps_it() {
        let mut o = DrawingObject {
            id: "1".into(),
            text: Some(TextBody { warp: Some(model::Warp { preset: "textArchUp".into(), ..Default::default() }), ..TextBody::plain("Kept") }),
            ..Default::default()
        };
        let op = DrawingOp::parse("drawing.text", &json!({ "id": 1, "body": { "anchor": "middle", "insets": [0, 0, 0, 0], "wrap": false } })).unwrap();
        op.apply(&mut o).unwrap();
        let t = o.text.clone().unwrap();
        assert_eq!((t.text().as_str(), t.anchor, t.insets, t.wrap), ("Kept", model::TextAnchor::Middle, [0.0; 4], false));
        assert_eq!(t.warp.unwrap().preset, "textArchUp", "the warp stays too");
        let none = DrawingOp::parse("drawing.text", &json!({ "id": "1" })).unwrap_err();
        assert_eq!(none.message, "give `text`, `paragraphs`, `body`, or `warp`");
    }

    /// `text` accepts the text object returned by `drawing.describe`.
    #[test]
    fn text_takes_the_text_object_describe_gives() {
        let given = json!({ "kind": "textBox", "text": {
            "paragraphs": [{ "runs": [{ "text": "Q3 review", "size": 48, "bold": true, "color": "#FFFFFF" }] }],
            "anchor": "bottom",
        } });
        let DrawingOp::Insert(o) = DrawingOp::parse("drawing.insert", &given).unwrap() else { panic!() };
        let t = o.text.unwrap();
        assert_eq!((t.text().as_str(), t.anchor, t.paragraphs[0].runs[0].size), ("Q3 review", model::TextAnchor::Bottom, Some(48.0)));
        let mut o = DrawingObject { id: "1".into(), text: Some(TextBody::plain("old")), ..Default::default() };
        DrawingOp::parse("drawing.text", &json!({ "id": "1", "text": { "paragraphs": [{ "runs": [{ "text": "new" }] }], "anchor": "middle" } }))
            .unwrap()
            .apply(&mut o)
            .unwrap();
        let t = o.text.unwrap();
        assert_eq!((t.text().as_str(), t.anchor), ("new", model::TextAnchor::Middle));
        for wrong in [json!({ "text": "Kition" }), json!(["Kition"]), json!(7)] {
            let e = DrawingOp::parse("drawing.insert", &json!({ "kind": "textBox", "text": wrong })).unwrap_err();
            assert!(e.message.starts_with("`text` is a string") && e.message.contains("{paragraphs: [{runs: [{text"), "{}", e.message);
        }
    }

    /// An invalid font value names the run and the field's place in the error.
    #[test]
    fn a_wrong_run_field_is_named() {
        let run = json!({ "runs": [{ "text": "Title", "font": { "size": 48, "bold": true, "family": "Calibri" } }] });
        let e = DrawingOp::parse("drawing.insert", &json!({ "kind": "textBox", "text": { "paragraphs": [run] } })).unwrap_err();
        assert!(e.message.starts_with("text.paragraphs[0].runs[0]: ") && e.message.contains("fields of the run itself"), "{}", e.message);
        let e = DrawingOp::parse(
            "drawing.insert",
            &json!({ "kind": "textBox", "paragraphs": [{ "runs": [{ "text": "a" }] }, { "runs": [{ "text": "b", "size": "big" }] }] }),
        )
        .unwrap_err();
        assert!(e.message.starts_with("paragraphs[1].runs[0]: "), "{}", e.message);
    }

    #[test]
    fn plain_text_keeps_the_body_layout() {
        let mut o = DrawingObject {
            id: "1".into(),
            text: Some(TextBody { insets: [0.0; 4], anchor: model::TextAnchor::Bottom, ..TextBody::plain("old") }),
            ..Default::default()
        };
        DrawingOp::parse("drawing.text", &json!({ "id": "1", "text": "new" })).unwrap().apply(&mut o).unwrap();
        let t = o.text.clone().unwrap();
        assert_eq!((t.text().as_str(), t.insets, t.anchor), ("new", [0.0; 4], model::TextAnchor::Bottom));
        DrawingOp::parse("drawing.text", &json!({ "id": "1", "text": "x", "body": { "anchor": "middle" } })).unwrap().apply(&mut o).unwrap();
        assert_eq!(o.text.unwrap().anchor, model::TextAnchor::Middle);
    }

    #[test]
    fn errors_report_code_and_property() {
        let e = DrawingError::unsupported("placement.wrap", "this kit has no wrap");
        assert_eq!(e.to_value(), json!({ "code": "unsupported", "message": "this kit has no wrap", "data": { "property": "placement.wrap" } }));
    }

    #[test]
    fn charts_insert_from_a_sample_and_change_by_drawing_chart() {
        let DrawingOp::Insert(o) = DrawingOp::parse("drawing.insert", &json!({ "kind": "chart", "chart": { "kind": "pie", "title": "Share" } })).unwrap()
        else {
            panic!()
        };
        let c = o.chart.unwrap();
        assert_eq!((c.kind.clone(), c.title.as_deref(), c.series.len()), (crate::chart::ChartKind::Pie, Some("Share"), 1));
        let DrawingOp::Insert(plain) = DrawingOp::parse("drawing.insert", &json!({ "kind": "chart" })).unwrap() else { panic!() };
        assert_eq!(plain.chart.unwrap().series.len(), 2);
        let op = DrawingOp::parse("drawing.chart", &json!({ "id": "c1", "categories": ["A"], "legend": null })).unwrap();
        assert_eq!(op.ids(), ["c1"]);
        let mut o = DrawingObject { id: "c1".into(), kind: ObjectKind::Chart, chart: Some(c), ..Default::default() };
        op.apply(&mut o).unwrap();
        let c = o.chart.as_ref().unwrap();
        assert_eq!((c.categories.len(), c.series[0].values.len(), c.legend), (1, 1, None));
        let mut shape = DrawingObject { id: "s".into(), ..Default::default() };
        assert_eq!(op.apply(&mut shape).unwrap_err().code, "unsupported");
        assert!(DrawingOp::parse("drawing.chart", &json!({ "ids": ["a", "b"], "title": "x" })).is_err());
        assert!(DrawingOp::parse("drawing.insert", &json!({ "kind": "chart", "chart": { "kind": "funnel" } })).is_err());
    }
}
