//! The `DrawingObject` description (`KitDrawing 1.0` DR1 to DR8): what `drawing.describe`
//! returns and what `drawing.insert` and `drawing.format` take. It is an exchange form: a kit
//! converts its own object to it and writes changed members back, keeping what it does not cover.

use std::collections::BTreeMap;
use std::fmt;

use serde::de::Error as _;
use serde::{Deserialize, Deserializer, Serialize, Serializer};

use crate::geom::Xfrm;

/// Longest text a description or a command carries in one object (characters).
pub const MAX_TEXT: usize = 1_000_000;
/// Most paragraphs or runs in one text body.
pub const MAX_ITEMS: usize = 100_000;

/// One drawing object, described.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct DrawingObject {
    /// The kit's object id (DR2); empty in an object being inserted.
    #[serde(skip_serializing_if = "String::is_empty")]
    pub id: String,
    pub kind: ObjectKind,
    pub frame: Xfrm,
    pub placement: Placement,
    pub geometry: Geometry,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fill: Option<Fill>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stroke: Option<Stroke>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<TextBody>,
    /// A chart's description (`KitDrawing` 1.1, DR15); only on objects of kind `chart`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub chart: Option<crate::chart::ChartSpec>,
    /// An ink object's strokes (`KitDrawing` 1.2); only on objects of kind `ink`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ink: Option<Vec<crate::ink::InkStroke>>,
    /// A group's members, bottom to top, by id (`KitDrawing` 1.4, DR22); only on objects of
    /// kind `group`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub members: Option<Vec<String>>,
    /// Shadow and glow (`KitDrawing` 1.4, DR24); absent when the object has none.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub effects: Option<Effects>,
    /// A connector's glued ends (`KitDrawing` 1.4, DR25); only on connectors.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub connection: Option<crate::connect::Connection>,
}

/// An object's effects (DR24).
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Effects {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub shadow: Option<Shadow>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub glow: Option<Glow>,
}

impl Effects {
    pub fn is_empty(&self) -> bool {
        self.shadow.is_none() && self.glow.is_none()
    }
}

/// An outer shadow: the silhouette in `color` (its `alpha` the shadow's opacity), blurred by
/// `blur` points, cast `distance` points in direction `angle` (degrees clockwise from right).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Shadow {
    pub color: Color,
    pub blur: f64,
    pub distance: f64,
    pub angle: f64,
}

/// A glow `size` points wide around the outline, in `color` (its `alpha` the opacity).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Glow {
    pub color: Color,
    pub size: f64,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ObjectKind {
    #[default]
    Shape,
    TextBox,
    /// `KitDrawing` 1.1.
    Chart,
    /// `KitDrawing` 1.2: one or more ink strokes.
    Ink,
    /// `KitDrawing` 1.4 (DR22): objects grouped; `members` lists them.
    Group,
}

/// How the frame is kept (DR5): `kind` plus the kit's own members, passed through unchanged.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Placement {
    pub kind: PlacementKind,
    #[serde(flatten)]
    pub extra: BTreeMap<String, serde_json::Value>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PlacementKind {
    #[default]
    Slide,
    Float,
    Inline,
    Cell,
}

/// Preset geometry with adjust values by guide name, or custom paths (DR6).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum Geometry {
    Preset {
        preset: String,
        #[serde(default)]
        adjust: BTreeMap<String, f64>,
    },
    Custom {
        paths: Vec<CustomPath>,
    },
}

impl Default for Geometry {
    fn default() -> Self {
        Geometry::preset("rect")
    }
}

impl Geometry {
    pub fn preset(name: &str) -> Self {
        Geometry::Preset { preset: name.into(), adjust: BTreeMap::new() }
    }

    /// The preset's adjust values in guide order (`adj` or `adj1`, `adj2`…), as
    /// [`crate::preset::build`] takes them; positions not named take the preset's default.
    pub fn adjust_values(&self) -> Vec<f64> {
        let Geometry::Preset { preset, adjust } = self else { return Vec::new() };
        let mut out: Vec<f64> = Vec::new();
        for (name, value) in adjust {
            let Some(index) = guide_index(name) else { continue };
            if index >= 16 || !value.is_finite() {
                continue;
            }
            if out.len() <= index {
                out.resize(index + 1, f64::NAN);
            }
            if let Some(slot) = out.get_mut(index) {
                *slot = *value;
            }
        }
        let defaults = crate::preset::info(preset).map(|i| i.defaults).unwrap_or(&[]);
        for (i, v) in out.iter_mut().enumerate() {
            if v.is_nan() {
                *v = defaults.get(i).copied().unwrap_or(0.0);
            }
        }
        out
    }
}

/// `adj` → 0, `adjN` → N − 1.
pub fn guide_index(name: &str) -> Option<usize> {
    match name.strip_prefix("adj")? {
        "" => Some(0),
        n => n.parse::<usize>().ok()?.checked_sub(1),
    }
}

/// One custom path in its own coordinate space `w` × `h`, stretched over the frame.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct CustomPath {
    pub w: f64,
    pub h: f64,
    /// SVG path data in the path's space (`M`, `L`, `C`, `Q`, `Z`, absolute).
    pub d: String,
    /// Filled (false for an open line).
    pub filled: bool,
    pub stroked: bool,
}

/// `#RRGGBB`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub struct Rgb(pub u8, pub u8, pub u8);

impl Rgb {
    pub fn parse(text: &str) -> Option<Rgb> {
        let hex = text.trim().strip_prefix('#').unwrap_or(text.trim());
        if hex.len() != 6 || !hex.is_ascii() {
            return None;
        }
        let byte = |at: usize| hex.get(at..at + 2).and_then(|b| u8::from_str_radix(b, 16).ok());
        Some(Rgb(byte(0)?, byte(2)?, byte(4)?))
    }
}

impl fmt::Display for Rgb {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "#{:02X}{:02X}{:02X}", self.0, self.1, self.2)
    }
}

impl Serialize for Rgb {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

/// Read from `#RRGGBB` or `RRGGBB`, or from `[r, g, b]` (the form Doc's documents carried their
/// equation colours in).
impl<'de> Deserialize<'de> for Rgb {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        #[serde(untagged)]
        enum Form {
            Text(String),
            Parts(u8, u8, u8),
        }
        match Form::deserialize(d)? {
            Form::Text(text) => Rgb::parse(&text).ok_or_else(|| D::Error::custom(format!("`{text}` is not a #RRGGBB color"))),
            Form::Parts(r, g, b) => Ok(Rgb(r, g, b)),
        }
    }
}

/// DrawingML scheme color names (DR7).
pub const THEME_SLOTS: [&str; 16] =
    ["accent1", "accent2", "accent3", "accent4", "accent5", "accent6", "tx1", "bg1", "tx2", "bg2", "dk1", "lt1", "dk2", "lt2", "hlink", "folHlink"];

/// A color: explicit or a theme slot, with opacity and DrawingML transforms (DR7). Read as
/// `{rgb|theme, alpha?, mods?}`, or as `#RRGGBB` or a theme slot's name alone, wherever a
/// colour goes.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Color {
    #[serde(flatten)]
    pub base: ColorBase,
    /// Opacity 0 (clear) to 1 (opaque).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub alpha: Option<f64>,
    /// DrawingML color transforms with their values (`lumMod` 75000…), in order.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub mods: Vec<(String, i32)>,
}

/// [`Color`]'s object form, as read.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ColorObject {
    #[serde(flatten)]
    base: ColorBase,
    #[serde(default)]
    alpha: Option<f64>,
    #[serde(default)]
    mods: Vec<(String, i32)>,
}

impl<'de> Deserialize<'de> for Color {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        match serde_json::Value::deserialize(d)? {
            serde_json::Value::String(s) if THEME_SLOTS.contains(&s.as_str()) => Ok(Color::theme(&s)),
            serde_json::Value::String(s) => {
                Rgb::parse(&s).map(Color::rgb).ok_or_else(|| D::Error::custom(format!("`{s}` is not a #RRGGBB colour or a theme slot")))
            }
            other => {
                let o: ColorObject = serde_json::from_value(other).map_err(D::Error::custom)?;
                Ok(Color { base: o.base, alpha: o.alpha, mods: o.mods })
            }
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ColorBase {
    Rgb { rgb: Rgb },
    Theme { theme: String },
}

impl Color {
    pub fn rgb(rgb: Rgb) -> Self {
        Color { base: ColorBase::Rgb { rgb }, alpha: None, mods: Vec::new() }
    }
    pub fn theme(slot: &str) -> Self {
        Color { base: ColorBase::Theme { theme: slot.into() }, alpha: None, mods: Vec::new() }
    }
    /// A color written in a command: `"#RRGGBB"`, a theme slot name, or the object form.
    pub fn from_value(v: &serde_json::Value) -> Option<Color> {
        match v {
            serde_json::Value::String(s) if THEME_SLOTS.contains(&s.as_str()) => Some(Color::theme(s)),
            serde_json::Value::String(s) => Rgb::parse(s).map(Color::rgb),
            other => {
                serde_json::from_value::<ColorObject>(other.clone()).ok().map(|o| Color { base: o.base, alpha: o.alpha, mods: o.mods }).filter(Color::is_valid)
            }
        }
    }
    pub fn is_valid(&self) -> bool {
        let base = match &self.base {
            ColorBase::Rgb { .. } => true,
            ColorBase::Theme { theme } => THEME_SLOTS.contains(&theme.as_str()),
        };
        base && self.alpha.is_none_or(|a| (0.0..=1.0).contains(&a)) && self.mods.len() <= 16
    }
}

/// A fill: a color, or none (DR7). A kit describes fills `KitDrawing 1.0` cannot set (a
/// gradient, a picture, a pattern) as [`Fill::Other`] with their kind; commands never take one.
#[derive(Clone, Debug, PartialEq)]
pub enum Fill {
    None,
    Solid(Color),
    /// `KitDrawing` 1.4 (DR23): a gradient.
    Gradient(Gradient),
    Other(String),
}

/// One colour of a gradient at `pos` (0 to 1 along it).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct GradientStop {
    pub pos: f64,
    pub color: Color,
}

/// A gradient fill (DrawingML `a:gradFill`): two to ten stops in order, and a linear direction
/// (`angle`, degrees clockwise from left to right) or a `path` from the centre (`circle`, `rect`,
/// `shape`).
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Gradient {
    pub stops: Vec<GradientStop>,
    pub angle: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
}

/// Gradient paths (DrawingML `ST_PathShadeType`).
pub const GRADIENT_PATHS: [&str; 3] = ["circle", "rect", "shape"];

impl Gradient {
    pub fn is_valid(&self) -> bool {
        (2..=10).contains(&self.stops.len())
            && self.stops.iter().all(|s| s.pos.is_finite() && (0.0..=1.0).contains(&s.pos) && s.color.is_valid())
            && self.stops.windows(2).all(|w| w[0].pos <= w[1].pos)
            && self.angle.is_finite()
            && self.path.as_deref().is_none_or(|p| GRADIENT_PATHS.contains(&p))
    }
}

impl Serialize for Fill {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        match self {
            Fill::None => serde_json::json!({ "none": true }).serialize(s),
            Fill::Solid(color) => serde_json::json!({ "color": color }).serialize(s),
            Fill::Gradient(g) => serde_json::json!({ "gradient": g }).serialize(s),
            Fill::Other(kind) => serde_json::json!({ "kind": kind }).serialize(s),
        }
    }
}

impl<'de> Deserialize<'de> for Fill {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let v = serde_json::Value::deserialize(d)?;
        if let Some(kind) = v.get("kind").and_then(serde_json::Value::as_str) {
            return Ok(Fill::Other(kind.into()));
        }
        Fill::from_value(&v).ok_or_else(|| D::Error::custom("a fill is {color}, {gradient} or {none: true}"))
    }
}

impl Fill {
    pub fn from_value(v: &serde_json::Value) -> Option<Fill> {
        // Shorthand: a colour alone (`"#102D39"`, `"accent1"`) is a solid fill, `"none"` no fill.
        if let serde_json::Value::String(s) = v {
            return if s.eq_ignore_ascii_case("none") { Some(Fill::None) } else { Color::from_value(v).map(Fill::Solid) };
        }
        if v.get("none").and_then(serde_json::Value::as_bool) == Some(true) {
            return Some(Fill::None);
        }
        if let Some(g) = v.get("gradient") {
            let stops = g
                .get("stops")?
                .as_array()?
                .iter()
                .map(|st| Some(GradientStop { pos: st.get("pos")?.as_f64()?, color: Color::from_value(st.get("color")?)? }))
                .collect::<Option<Vec<_>>>()?;
            let angle = match g.get("angle") {
                None => 0.0,
                Some(a) => a.as_f64()?,
            };
            let path = match g.get("path") {
                None | Some(serde_json::Value::Null) => None,
                Some(p) => Some(p.as_str()?.to_string()),
            };
            let g = Gradient { stops, angle: angle.rem_euclid(360.0), path };
            return g.is_valid().then_some(Fill::Gradient(g));
        }
        v.get("color").and_then(Color::from_value).map(Fill::Solid)
    }
}

/// An outline (DR7). `none` hides it; otherwise unset members are inherited.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Stroke {
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub none: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub color: Option<Color>,
    /// Points.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub width: Option<f64>,
    /// DrawingML preset dash (`solid`, `dash`, `sysDot`…).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dash: Option<String>,
}

/// DrawingML preset dashes.
pub const DASHES: [&str; 11] = ["solid", "dot", "dash", "lgDash", "dashDot", "lgDashDot", "lgDashDotDot", "sysDash", "sysDot", "sysDashDot", "sysDashDotDot"];

/// A text body (DR8).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct TextBody {
    pub paragraphs: Vec<Paragraph>,
    pub anchor: TextAnchor,
    /// Left, top, right, bottom, points. Read also as one number for all four, or as
    /// `{left, top, right, bottom}` (any missing side 0).
    #[serde(deserialize_with = "insets")]
    pub insets: [f64; 4],
    pub wrap: bool,
    pub autofit: Autofit,
    /// WordArt's preset text warp (DR26); `None` for unbent text.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub warp: Option<Warp>,
}

fn insets<'de, D: serde::Deserializer<'de>>(d: D) -> Result<[f64; 4], D::Error> {
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum Insets {
        Four([f64; 4]),
        All(f64),
        Sides {
            #[serde(default)]
            left: f64,
            #[serde(default)]
            top: f64,
            #[serde(default)]
            right: f64,
            #[serde(default)]
            bottom: f64,
        },
    }
    match Insets::deserialize(d) {
        Ok(Insets::Four(four)) => Ok(four),
        Ok(Insets::All(all)) => Ok([all; 4]),
        Ok(Insets::Sides { left, top, right, bottom }) => Ok([left, top, right, bottom]),
        Err(_) => Err(serde::de::Error::custom("insets are [left, top, right, bottom] in points, one number for all four, or {left, top, right, bottom}")),
    }
}

/// A preset text warp (`a:prstTxWarp`, DR26): its name and adjust values by guide name.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Warp {
    pub preset: String,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub adjust: BTreeMap<String, f64>,
}

impl Default for TextBody {
    fn default() -> Self {
        // DrawingML's defaults: 0.1" left and right, 0.05" top and bottom, wrapped.
        TextBody { paragraphs: Vec::new(), anchor: TextAnchor::Top, insets: [7.2, 3.6, 7.2, 3.6], wrap: true, autofit: Autofit::None, warp: None }
    }
}

impl TextBody {
    /// One paragraph per line of `text` (`\n`), each a single run.
    pub fn plain(text: &str) -> Self {
        TextBody {
            paragraphs: text.split('\n').map(|line| Paragraph { runs: vec![Run { text: line.into(), ..Default::default() }], ..Default::default() }).collect(),
            ..Default::default()
        }
    }
    /// The text, paragraphs joined by `\n`.
    pub fn text(&self) -> String {
        self.paragraphs.iter().map(|p| p.runs.iter().map(|r| r.text.as_str()).collect::<String>()).collect::<Vec<_>>().join("\n")
    }
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Paragraph {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub align: Option<Align>,
    pub runs: Vec<Run>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Run {
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub font: Option<String>,
    /// Points.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bold: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub italic: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub underline: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub color: Option<Color>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Align {
    // Short alignment names are read here and written in full.
    #[serde(alias = "l")]
    Left,
    #[serde(alias = "c", alias = "ctr", alias = "middle")]
    Center,
    #[serde(alias = "r")]
    Right,
    #[serde(alias = "j", alias = "just")]
    Justify,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TextAnchor {
    #[default]
    #[serde(alias = "t")]
    Top,
    #[serde(alias = "m", alias = "ctr", alias = "center")]
    Middle,
    #[serde(alias = "b")]
    Bottom,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Autofit {
    #[default]
    None,
    Shrink,
    Resize,
}

/// Describes several objects at once (a selection, DR10): every member whose values differ
/// becomes `{"mixed": true}`; `id` lists the ids.
pub fn describe_many(objects: &[DrawingObject]) -> serde_json::Value {
    let values: Vec<serde_json::Value> = objects.iter().filter_map(|o| serde_json::to_value(o).ok()).collect();
    let Some((first, rest)) = values.split_first() else { return serde_json::Value::Null };
    let mut out = serde_json::Map::new();
    let keys: std::collections::BTreeSet<&String> = values.iter().filter_map(|v| v.as_object()).flat_map(|o| o.keys()).collect();
    for key in keys {
        if key == "id" {
            continue;
        }
        let a = first.get(key);
        let same = rest.iter().all(|v| v.get(key) == a);
        out.insert(key.clone(), if same { a.cloned().unwrap_or(serde_json::Value::Null) } else { serde_json::json!({ "mixed": true }) });
    }
    out.insert("ids".into(), objects.iter().map(|o| serde_json::Value::String(o.id.clone())).collect());
    serde_json::Value::Object(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn short_names_and_other_inset_shapes_read() {
        let body: TextBody = serde_json::from_value(json!({"anchor": "b", "insets": {"left": 10, "right": 10}})).unwrap();
        assert_eq!((body.anchor, body.insets), (TextAnchor::Bottom, [10.0, 0.0, 10.0, 0.0]));
        let body: TextBody = serde_json::from_value(json!({"anchor": "center", "insets": 4})).unwrap();
        assert_eq!((body.anchor, body.insets), (TextAnchor::Middle, [4.0; 4]));
        let p: Paragraph = serde_json::from_value(json!({"align": "l", "runs": []})).unwrap();
        assert_eq!(p.align, Some(Align::Left));
        assert_eq!(serde_json::to_value(Align::Left).unwrap(), json!("left"), "written in full");
    }

    #[test]
    fn a_colour_alone_is_a_solid_fill() {
        assert_eq!(Fill::from_value(&serde_json::json!("#102D39")), Fill::from_value(&serde_json::json!({"color": "#102D39"})));
        assert!(matches!(Fill::from_value(&serde_json::json!("accent1")), Some(Fill::Solid(_))));
        assert!(matches!(Fill::from_value(&serde_json::json!("none")), Some(Fill::None)));
        assert!(Fill::from_value(&serde_json::json!("not a colour")).is_none());
    }

    #[test]
    fn the_spec_example_reads_and_writes_back() {
        let v = json!({
          "id": "s-12",
          "kind": "shape",
          "frame": { "x": 72, "y": 144, "w": 216, "h": 108 },
          "placement": { "kind": "slide" },
          "geometry": { "preset": "ellipse", "adjust": {} },
          "fill": { "color": { "rgb": "#5645D4" } },
          "stroke": { "color": { "theme": "accent1", "mods": [["lumMod", 75000]] }, "width": 1.0 },
          "text": { "paragraphs": [{ "align": "center", "runs": [{ "text": "Q3", "size": 18.0, "bold": true }] }], "anchor": "middle", "insets": [7.2, 3.6, 7.2, 3.6] }
        });
        let o: DrawingObject = serde_json::from_value(v).unwrap();
        assert_eq!(o.fill, Some(Fill::Solid(Color::rgb(Rgb(0x56, 0x45, 0xD4)))));
        assert_eq!(o.stroke.as_ref().unwrap().color.as_ref().unwrap().mods, vec![("lumMod".to_string(), 75000)]);
        assert_eq!(o.text.as_ref().unwrap().text(), "Q3");
        let back = serde_json::to_value(&o).unwrap();
        let again: DrawingObject = serde_json::from_value(back).unwrap();
        assert_eq!(o, again);
    }

    #[test]
    fn placement_keeps_kit_members() {
        let p: Placement = serde_json::from_value(json!({ "kind": "cell", "mode": "moveAndSize", "from": "B2" })).unwrap();
        assert_eq!(p.kind, PlacementKind::Cell);
        assert_eq!(serde_json::to_value(&p).unwrap(), json!({ "kind": "cell", "mode": "moveAndSize", "from": "B2" }));
    }

    #[test]
    fn colors_from_commands() {
        assert_eq!(Color::from_value(&json!("#ff0000")), Some(Color::rgb(Rgb(255, 0, 0))));
        assert_eq!(Color::from_value(&json!("accent2")), Some(Color::theme("accent2")));
        assert_eq!(Color::from_value(&json!("magenta")), None);
        assert_eq!(Color::from_value(&json!({ "theme": "accent9" })), None);
        assert_eq!(Color::from_value(&json!({ "rgb": "#000000", "alpha": 2.0 })), None);
        assert_eq!(Fill::from_value(&json!({ "none": true })), Some(Fill::None));
    }

    #[test]
    fn a_colour_is_read_in_its_short_forms_anywhere() {
        let r: Run = serde_json::from_value(json!({ "text": "a", "color": "#C00000" })).unwrap();
        assert_eq!(r.color, Some(Color::rgb(Rgb(0xC0, 0, 0))));
        let r: Run = serde_json::from_value(json!({ "text": "a", "color": "accent2" })).unwrap();
        assert_eq!(r.color, Some(Color::theme("accent2")));
        let r: Run = serde_json::from_value(json!({ "text": "a", "color": { "rgb": "#000000", "alpha": 0.5 } })).unwrap();
        assert_eq!(r.color.unwrap().alpha, Some(0.5));
        assert!(serde_json::from_value::<Run>(json!({ "text": "a", "color": "red" })).is_err());
    }

    #[test]
    fn gradients_have_two_to_ten_stops_in_order() {
        let g: Fill = serde_json::from_value(
            json!({ "gradient": { "stops": [{ "pos": 0, "color": "#5645D4" }, { "pos": 1, "color": { "theme": "accent2" } }], "angle": 450 } }),
        )
        .unwrap();
        let Fill::Gradient(ref gr) = g else { panic!("{g:?}") };
        assert_eq!((gr.stops.len(), gr.angle, gr.path.clone()), (2, 90.0, None));
        let back: Fill = serde_json::from_value(serde_json::to_value(&g).unwrap()).unwrap();
        assert_eq!(back, g);
        for bad in [
            json!({ "gradient": { "stops": [{ "pos": 0, "color": "#000000" }] } }),
            json!({ "gradient": { "stops": [{ "pos": 0.8, "color": "#000000" }, { "pos": 0.2, "color": "#FFFFFF" }] } }),
            json!({ "gradient": { "stops": [{ "pos": 0, "color": "#000000" }, { "pos": 1, "color": "#FFFFFF" }], "path": "star" } }),
        ] {
            assert!(serde_json::from_value::<Fill>(bad.clone()).is_err(), "{bad}");
        }
    }

    #[test]
    fn adjust_values_follow_guide_names() {
        let g: Geometry = serde_json::from_value(json!({ "preset": "roundRect", "adjust": { "adj": 25000.0 } })).unwrap();
        assert_eq!(g.adjust_values(), vec![25000.0]);
        let g: Geometry = serde_json::from_value(json!({ "preset": "x", "adjust": { "adj2": 5.0, "bogus": 1.0, "adj0": 3.0 } })).unwrap();
        assert_eq!(g.adjust_values(), vec![0.0, 5.0]);
        // A gap takes the preset's default.
        let g: Geometry = serde_json::from_value(json!({ "preset": "rightArrow", "adjust": { "adj2": 40000.0 } })).unwrap();
        let defaults = crate::preset::info("rightArrow").unwrap().defaults;
        assert_eq!(g.adjust_values(), vec![defaults[0], 40000.0]);
    }

    #[test]
    fn a_selection_reports_mixed_values() {
        let a = DrawingObject { id: "1".into(), fill: Some(Fill::None), ..Default::default() };
        let b = DrawingObject { id: "2".into(), fill: Some(Fill::Solid(Color::theme("accent1"))), ..Default::default() };
        let d = describe_many(&[a, b]);
        assert_eq!(d["fill"], json!({ "mixed": true }));
        assert_eq!(d["kind"], json!("shape"));
        assert_eq!(d["ids"], json!(["1", "2"]));
    }
}
