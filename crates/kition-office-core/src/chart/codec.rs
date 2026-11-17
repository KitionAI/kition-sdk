//! DrawingML charts (`c:chartSpace`, ECMA-376 Part 1, 21.2) to and from [`ChartSpec`].
//!
//! - [`read`]: a chart part described.
//! - [`patch`]: a chart part changed to say what a spec says, keeping everything the spec does
//!   not describe (formatting, axes, extensions): the series' caches, names and colours, the title,
//!   legend, data labels, gridlines and axis titles are edited in place; a type change rebuilds
//!   only the chart-type element. Cell references (`c:f`) are kept; the caches are what readers
//!   show, and an embedded workbook is the kit's to update.
//! - [`write`]: a new chart part from a spec (an inserted chart).

use super::{AxisSpec, ChartKind, ChartSpec, ErrorBars, LegendPos, MAX_POINTS, MAX_SERIES, SeriesSpec, Trendline};
use crate::model::{Color, ColorBase, Rgb};
use crate::xml::{self, Element, Node};

/// A part that cannot be read or patched.
#[derive(Clone, Debug, PartialEq)]
pub struct ChartError(pub String);

impl From<xml::XmlError> for ChartError {
    fn from(e: xml::XmlError) -> Self {
        ChartError(e.0)
    }
}

/// The chart-type elements of a plot area, by local name.
const TYPES: [&str; 16] = [
    "barChart",
    "bar3DChart",
    "lineChart",
    "line3DChart",
    "areaChart",
    "area3DChart",
    "pieChart",
    "pie3DChart",
    "doughnutChart",
    "ofPieChart",
    "scatterChart",
    "radarChart",
    "bubbleChart",
    "stockChart",
    "surfaceChart",
    "surface3DChart",
];

fn kind_of(e: &Element) -> ChartKind {
    let grouping = e.val("grouping").unwrap_or("clustered");
    match e.local() {
        "barChart" => {
            let horizontal = e.val("barDir") == Some("bar");
            match (horizontal, grouping) {
                (false, "stacked") => ChartKind::StackedColumn,
                (false, "percentStacked") => ChartKind::PercentColumn,
                (false, _) => ChartKind::Column,
                (true, "stacked") => ChartKind::StackedBar,
                (true, "percentStacked") => ChartKind::PercentBar,
                (true, _) => ChartKind::Bar,
            }
        }
        "lineChart" => {
            // A line chart without markers says so on its series; one series given a marker of
            // its own leaves the chart a line chart.
            let mut series = e.elements().filter(|s| s.local() == "ser").peekable();
            let markers =
                series.peek().is_some() && series.all(|s| s.path("marker/symbol").and_then(|m| m.attr("val")) != Some("none")) && e.val("marker") != Some("0");
            match grouping {
                "stacked" | "percentStacked" => ChartKind::StackedLine,
                _ if markers => ChartKind::LineMarkers,
                _ => ChartKind::Line,
            }
        }
        "areaChart" => {
            if matches!(grouping, "stacked" | "percentStacked") {
                ChartKind::StackedArea
            } else {
                ChartKind::Area
            }
        }
        "pieChart" => ChartKind::Pie,
        "doughnutChart" => ChartKind::Doughnut,
        "scatterChart" => ChartKind::Scatter,
        "radarChart" => ChartKind::Radar,
        other => ChartKind::Other(other.to_string()),
    }
}

/// The text of a `c:tx`, a `c:cat`'s point, or a title: a string cache, literal, or rich text.
fn rich_text(e: &Element) -> String {
    let mut ts = Vec::new();
    e.descendants("t", &mut ts);
    let mut paras = Vec::new();
    let mut ps = Vec::new();
    e.descendants("p", &mut ps);
    if ps.is_empty() {
        return ts.iter().map(|t| t.text()).collect();
    }
    for p in ps {
        let mut runs = Vec::new();
        p.descendants("t", &mut runs);
        paras.push(runs.iter().map(|t| t.text()).collect::<String>());
    }
    paras.join("\n")
}

/// Points of a cache or literal (`c:strCache`, `c:numCache`, `c:strLit`, `c:numLit`) by index.
fn points(cache: &Element) -> Vec<Option<String>> {
    let n = cache.val("ptCount").and_then(|v| v.parse::<usize>().ok()).unwrap_or(0).min(MAX_POINTS);
    let mut out = vec![None; n];
    for pt in cache.elements().filter(|e| e.local() == "pt") {
        let Some(i) = pt.attr("idx").and_then(|v| v.parse::<usize>().ok()).filter(|i| *i < MAX_POINTS) else { continue };
        if out.len() <= i {
            out.resize(i + 1, None);
        }
        if let Some(slot) = out.get_mut(i) {
            *slot = pt.child("v").map(Element::text);
        }
    }
    out
}

/// The cache of a data source (`c:cat`, `c:val`, `c:xVal`, `c:yVal`, `c:tx`).
fn cache_of(src: &Element) -> Option<&Element> {
    for path in ["strRef/strCache", "numRef/numCache", "multiLvlStrRef/multiLvlStrCache", "strLit", "numLit"] {
        if let Some(c) = src.path(path) {
            return Some(c);
        }
    }
    None
}

fn color_of(sppr: Option<&Element>) -> Option<Color> {
    let fill = sppr?.child("solidFill").or_else(|| sppr?.path("ln/solidFill"))?;
    if let Some(c) = fill.child("srgbClr") {
        return Rgb::parse(c.attr("val")?).map(Color::rgb);
    }
    let c = fill.child("schemeClr")?;
    let mut color = Color::theme(c.attr("val")?);
    for m in c.elements() {
        if let Some(v) = m.attr("val").and_then(|v| v.parse::<i32>().ok()) {
            if m.local() == "alpha" {
                color.alpha = Some(f64::from(v) / 100_000.0);
            } else {
                color.mods.push((m.local().to_string(), v));
            }
        }
    }
    Some(color.base_ok())
}

trait BaseOk {
    fn base_ok(self) -> Self;
}

impl BaseOk for Color {
    /// A scheme colour named outside the shared slots (`phClr`) is described as the text colour.
    fn base_ok(self) -> Self {
        match &self.base {
            ColorBase::Theme { theme } if !crate::model::THEME_SLOTS.contains(&theme.as_str()) => {
                Color { base: ColorBase::Theme { theme: "tx1".into() }, ..self }
            }
            _ => self,
        }
    }
}

fn title_of(t: Option<&Element>) -> Option<String> {
    let t = t?;
    match t.child("tx") {
        Some(tx) => match tx.child("strRef").and_then(|r| r.child("strCache")) {
            Some(cache) => Some(points(cache).into_iter().flatten().collect::<Vec<_>>().join(" ")),
            None => Some(rich_text(tx)),
        },
        // A title without text shows the series name; described as that.
        None => Some(String::new()),
    }
}

/// Which of the plot area's elements (by position among its elements) are the category (X) and
/// value (Y) axes: the value axis is the vertical one (`axPos` l or r), else the last; the category
/// axis a `catAx` or `dateAx`, else a value axis that is not vertical (a scatter chart's X).
fn axis_roles(plot: &Element) -> (Option<usize>, Option<usize>) {
    let vertical = |a: &Element| matches!(a.val("axPos"), Some("l" | "r"));
    let els: Vec<&Element> = plot.elements().collect();
    let vals: Vec<usize> = els.iter().enumerate().filter(|(_, e)| e.local() == "valAx").map(|(i, _)| i).collect();
    let val = vals.iter().copied().find(|i| vertical(els[*i])).or_else(|| vals.last().copied());
    let cat = els.iter().position(|e| matches!(e.local(), "catAx" | "dateAx")).or_else(|| vals.iter().copied().find(|i| Some(*i) != val && !vertical(els[*i])));
    (cat, val)
}

/// An axis's scale and number format, described.
fn axis_of(a: &Element) -> AxisSpec {
    let num = |p: &str| a.path(p).and_then(|e| e.attr("val")).and_then(|v| v.parse::<f64>().ok()).filter(|v| v.is_finite());
    AxisSpec {
        min: num("scaling/min"),
        max: num("scaling/max"),
        major: num("majorUnit"),
        number_format: a
            .child("numFmt")
            .filter(|n| !matches!(n.attr("sourceLinked"), Some("1" | "true")))
            .and_then(|n| n.attr("formatCode"))
            .filter(|f| !f.is_empty() && *f != "General")
            .map(str::to_string),
        hidden: a.val("delete").is_some_and(|v| v == "1" || v == "true"),
    }
}

/// The chart part `src`, described.
pub fn read(src: &str) -> Result<ChartSpec, ChartError> {
    let doc = xml::parse(src)?;
    from_space(&doc.root)
}

fn from_space(space: &Element) -> Result<ChartSpec, ChartError> {
    let chart = space.child("chart").ok_or_else(|| ChartError("no c:chart".into()))?;
    let plot = chart.child("plotArea").ok_or_else(|| ChartError("no c:plotArea".into()))?;
    let types: Vec<&Element> = plot.elements().filter(|e| TYPES.contains(&e.local())).collect();
    let first = types.first().ok_or_else(|| ChartError("no chart type in the plot area".into()))?;
    let kind = kind_of(first);
    let mut spec = ChartSpec { kind: kind.clone(), ..Default::default() };
    // A chart type on other axes than the first's is on the secondary axes.
    let axes_of = |t: &Element| t.elements().filter(|e| e.local() == "axId").filter_map(|e| e.attr("val").map(str::to_string)).collect::<Vec<_>>();
    let primary = axes_of(first);
    for (ti, t) in types.iter().enumerate() {
        let own = kind_of(t);
        let secondary = ti > 0 && !primary.is_empty() && axes_of(t) != primary;
        for ser in t.elements().filter(|e| e.local() == "ser").take(MAX_SERIES) {
            let scatter = matches!(own, ChartKind::Scatter);
            let cat = ser.child(if scatter { "xVal" } else { "cat" }).and_then(cache_of);
            if spec.categories.is_empty()
                && let Some(c) = cat
            {
                spec.categories = points(c).into_iter().map(Option::unwrap_or_default).collect();
            }
            let values = ser
                .child(if scatter { "yVal" } else { "val" })
                .and_then(cache_of)
                .map(|c| points(c).into_iter().map(|v| v.and_then(|t| t.trim().parse::<f64>().ok()).filter(|n| n.is_finite())).collect())
                .unwrap_or_default();
            let name = ser.child("tx").map(|tx| match tx.child("strRef").and_then(|r| r.child("strCache")) {
                Some(c) => points(c).into_iter().flatten().collect::<Vec<_>>().join(" "),
                None => tx.child("v").map(Element::text).unwrap_or_else(|| rich_text(tx)),
            });
            spec.series.push(SeriesSpec {
                name: name.unwrap_or_else(|| format!("Series {}", spec.series.len() + 1)),
                values,
                color: color_of(ser.child("spPr")),
                kind: (ti > 0 && own != kind).then_some(own.clone()),
                line_width: ser.path("spPr/ln").and_then(|l| l.attr("w")).and_then(|w| w.parse::<f64>().ok()).filter(|w| w.is_finite()).map(|w| w / 12_700.0),
                // A line chart without markers says so on each series: that is its type, not a
                // choice. On such a chart a series that names no marker has automatic ones.
                marker: match (ser.path("marker/symbol").and_then(|m| m.attr("val")), matches!(own, ChartKind::Line | ChartKind::StackedLine)) {
                    (Some("none"), true) => None,
                    (None, true) => Some("auto".to_string()),
                    (v, _) => v.map(str::to_string),
                },
                smooth: ser.val("smooth").is_some_and(|v| v == "1" || v == "true"),
                trendline: trendline_of(ser),
                error_bars: error_bars_of(ser),
                secondary,
            });
        }
        if t.path("dLbls/showVal").and_then(|e| e.attr("val")).is_some_and(|v| v == "1" || v == "true")
            || t.elements().filter(|e| e.local() == "ser").any(|s| s.path("dLbls/showVal").and_then(|e| e.attr("val")).is_some_and(|v| v == "1" || v == "true"))
        {
            spec.data_labels = true;
        }
    }
    // In their order, not grouped by type.
    let rank = ranks(plot);
    if rank.len() == spec.series.len() {
        let mut placed: Vec<Option<SeriesSpec>> = vec![None; rank.len()];
        for (k, s) in std::mem::take(&mut spec.series).into_iter().enumerate() {
            placed[rank[k]] = Some(s);
        }
        spec.series = placed.into_iter().flatten().collect();
    }
    let n = spec.categories.len().max(spec.series.iter().map(|s| s.values.len()).max().unwrap_or(0));
    if spec.categories.len() < n {
        let from = spec.categories.len();
        spec.categories.extend((from..n).map(|i| (i + 1).to_string()));
    }
    for s in &mut spec.series {
        s.values.resize(n, None);
    }
    let deleted = chart.val("autoTitleDeleted").is_some_and(|v| v == "1" || v == "true");
    spec.title = if deleted && chart.child("title").is_none() { None } else { title_of(chart.child("title")) };
    spec.legend = chart.child("legend").map(|l| LegendPos::from_ooxml(l.val("legendPos").unwrap_or("r")));
    let (cat_at, val_at) = axis_roles(plot);
    let at = |i: Option<usize>| i.and_then(|i| plot.elements().nth(i));
    let (cat_ax, val_ax) = (at(cat_at), at(val_at));
    spec.gridlines = val_ax.is_some_and(|a| a.child("majorGridlines").is_some());
    spec.x_axis = cat_ax.map(axis_of).unwrap_or_default();
    spec.y_axis = val_ax.map(axis_of).unwrap_or_default();
    spec.data_label_position = types
        .iter()
        .find_map(|t| t.path("dLbls/dLblPos").or_else(|| t.elements().filter(|e| e.local() == "ser").find_map(|s| s.path("dLbls/dLblPos"))))
        .and_then(|e| e.attr("val"))
        .map(str::to_string);
    spec.x_title = cat_ax.and_then(|a| title_of(a.child("title")));
    spec.y_title = val_ax.and_then(|a| title_of(a.child("title")));
    Ok(spec)
}

// ------------------------------------------------------------------ writing

fn val(name: &str, v: &str) -> Element {
    Element::new(name).with_attr("val", v)
}

/// A rich text title (`c:title` with one paragraph per line).
fn title_el(text: &str) -> Element {
    let mut rich = Element::new("c:rich").with_child(Element::new("a:bodyPr")).with_child(Element::new("a:lstStyle"));
    for line in text.split('\n') {
        rich = rich.with_child(Element::new("a:p").with_child(Element::new("a:r").with_child(Element::new("a:t").with_text(line))));
    }
    Element::new("c:title").with_child(Element::new("c:tx").with_child(rich)).with_child(val("c:overlay", "0"))
}

fn color_el(c: &Color) -> Element {
    let mut e = match &c.base {
        ColorBase::Rgb { rgb } => val("a:srgbClr", &format!("{:02X}{:02X}{:02X}", rgb.0, rgb.1, rgb.2)),
        ColorBase::Theme { theme } => val("a:schemeClr", theme),
    };
    for (name, v) in &c.mods {
        e = e.with_child(val(&format!("a:{name}"), &v.to_string()));
    }
    if let Some(a) = c.alpha {
        e = e.with_child(val("a:alpha", &((a.clamp(0.0, 1.0) * 100_000.0).round() as i64).to_string()));
    }
    e
}

fn str_cache(items: &[String]) -> Element {
    let mut c = Element::new("c:strCache").with_child(val("c:ptCount", &items.len().to_string()));
    for (i, s) in items.iter().enumerate() {
        c = c.with_child(Element::new("c:pt").with_attr("idx", &i.to_string()).with_child(Element::new("c:v").with_text(s)));
    }
    c
}

fn num_cache(values: &[Option<f64>]) -> Element {
    let mut c =
        Element::new("c:numCache").with_child(Element::new("c:formatCode").with_text("General")).with_child(val("c:ptCount", &values.len().to_string()));
    for (i, v) in values.iter().enumerate() {
        if let Some(v) = v {
            c = c.with_child(Element::new("c:pt").with_attr("idx", &i.to_string()).with_child(Element::new("c:v").with_text(&v.to_string())));
        }
    }
    c
}

/// A cache as a literal (`c:strLit`, `c:numLit`): the same content under another name.
fn literal(mut cache: Element) -> Element {
    cache.name = if cache.local() == "strCache" { "c:strLit".into() } else { "c:numLit".into() };
    cache
}

/// Data a part no longer takes from its workbook: each series' name, categories and values become
/// literals of what they show, and the workbook reference goes, so no reader shows stale cells.
fn detach(space: &mut Element) {
    space.remove_children("externalData");
    let mut sers = Vec::new();
    collect_sers(space, &mut sers);
    for ser in sers {
        for src in ser.elements_mut() {
            match src.local() {
                "tx" => {
                    if let Some(c) = src.path("strRef/strCache") {
                        let name = points(c).into_iter().flatten().collect::<Vec<_>>().join(" ");
                        src.children = vec![Node::Element(Element::new("c:v").with_text(&name))];
                    }
                }
                "cat" | "val" | "xVal" | "yVal" | "bubbleSize" => {
                    let cache = ["strRef/strCache", "numRef/numCache", "multiLvlStrRef/multiLvlStrCache"].iter().find_map(|p| src.path(p).cloned());
                    if let Some(cache) = cache {
                        let cache = if cache.local() == "multiLvlStrCache" {
                            // The innermost level is what the categories read as.
                            let mut flat = Element::new("c:strCache");
                            flat.children = cache.child("lvl").map(|l| l.children.clone()).unwrap_or_default();
                            flat.children.insert(0, Node::Element(val("c:ptCount", cache.val("ptCount").unwrap_or("0"))));
                            flat
                        } else {
                            cache
                        };
                        src.children = vec![Node::Element(literal(cache))];
                    }
                }
                _ => {}
            }
        }
    }
}

fn collect_sers<'a>(e: &'a mut Element, out: &mut Vec<&'a mut Element>) {
    for c in e.elements_mut() {
        if c.local() == "ser" {
            out.push(c);
        } else {
            collect_sers(c, out);
        }
    }
}

/// Replaces the cache of data source `src` (keeping its reference), or makes it a literal.
fn set_cache(src: &mut Element, cache: Element) {
    let local = cache.local().to_string();
    let reference = if local == "strCache" { "strRef" } else { "numRef" };
    let other = if local == "strCache" { "numRef" } else { "strRef" };
    // A reference of the other kind (numbers where texts now are) changes kind, keeping its formula.
    if let Some(r) = src.child(other).cloned() {
        src.remove_children(other);
        let mut new = Element::new(&format!("c:{reference}"));
        if let Some(f) = r.child("f") {
            new = new.with_child(f.clone());
        }
        src.children.push(Node::Element(new));
    }
    match src.child_mut(reference) {
        Some(r) => {
            r.remove_children("strCache");
            r.remove_children("numCache");
            r.children.push(Node::Element(cache));
        }
        None => {
            for lit in ["strLit", "numLit", "multiLvlStrRef"] {
                src.remove_children(lit);
            }
            let lit = if local == "strCache" { "c:strLit" } else { "c:numLit" };
            let mut cache = cache;
            cache.name = lit.into();
            src.children.push(Node::Element(cache));
        }
    }
}

/// A series element made from the spec (for a new chart, or one a type change rebuilds).
/// Whether series of `kind` take markers and a smooth line.
fn has_markers(kind: &ChartKind) -> bool {
    matches!(kind, ChartKind::Line | ChartKind::LineMarkers | ChartKind::StackedLine | ChartKind::Scatter | ChartKind::Radar)
}

/// `sppr` with its line width set to `width` points (or the style's, for `None`).
fn with_line_width(mut sppr: Element, width: Option<f64>) -> Element {
    let mut ln = sppr.child("ln").cloned().unwrap_or_else(|| Element::new("a:ln"));
    match width {
        Some(w) => ln.set_attr("w", &((w.clamp(0.0, 100.0) * 12_700.0).round() as i64).to_string()),
        None => ln.attrs.retain(|(k, _)| k != "w"),
    }
    if ln.attrs.is_empty() && ln.children.is_empty() {
        sppr.remove_children("ln");
    } else {
        sppr.put(ln, &["xfrm", "custGeom", "prstGeom", "noFill", "solidFill", "gradFill", "blipFill", "pattFill", "grpFill"]);
    }
    sppr
}

/// A series' first trendline, as the description has it (`None` for none, or a type it does
/// not know).
fn trendline_of(ser: &Element) -> Option<Trendline> {
    let t = ser.child("trendline")?;
    let num = |k: &str| t.val(k).and_then(|v| v.trim().parse::<f64>().ok()).filter(|v| v.is_finite());
    let line = Trendline {
        kind: t.val("trendlineType").unwrap_or("linear").to_string(),
        order: num("order").map(|v| v as u32),
        period: num("period").map(|v| v as u32),
        forward: num("forward").filter(|v| *v > 0.0),
        backward: num("backward").filter(|v| *v > 0.0),
    };
    line.check().is_ok().then_some(line)
}

/// A series' error bars on its values (`errDir` `y`, or none on a chart without X errors), both
/// ways; custom amounts and one-way bars are not described.
fn error_bars_of(ser: &Element) -> Option<ErrorBars> {
    let e = ser.elements().find(|e| e.local() == "errBars" && e.val("errDir").is_none_or(|d| d == "y"))?;
    if e.val("errBarType").is_some_and(|t| t != "both") {
        return None;
    }
    let bars = ErrorBars {
        kind: e.val("errValType").unwrap_or("fixedVal").to_string(),
        value: e.val("val").and_then(|v| v.trim().parse::<f64>().ok()).filter(|v| v.is_finite()),
    };
    bars.check().is_ok().then_some(bars)
}

fn trendline_el(t: &Trendline) -> Element {
    let mut e = Element::new("c:trendline").with_child(val("c:trendlineType", &t.kind));
    if t.kind == "poly" {
        e = e.with_child(val("c:order", &t.order.unwrap_or(2).to_string()));
    }
    if t.kind == "movingAvg" {
        e = e.with_child(val("c:period", &t.period.unwrap_or(2).to_string()));
    }
    if let Some(f) = t.forward.filter(|_| t.kind != "movingAvg") {
        e = e.with_child(val("c:forward", &f.to_string()));
    }
    if let Some(b) = t.backward.filter(|_| t.kind != "movingAvg") {
        e = e.with_child(val("c:backward", &b.to_string()));
    }
    e.with_child(val("c:dispRSqr", "0")).with_child(val("c:dispEq", "0"))
}

fn error_bars_el(b: &ErrorBars, scatter: bool) -> Element {
    let mut e = Element::new("c:errBars");
    if scatter {
        e = e.with_child(val("c:errDir", "y"));
    }
    e = e.with_child(val("c:errBarType", "both")).with_child(val("c:errValType", &b.kind)).with_child(val("c:noEndCap", "0"));
    if b.kind != "stdErr" {
        let v = b.value.unwrap_or(match b.kind.as_str() {
            "percentage" => 5.0,
            _ => 1.0,
        });
        e = e.with_child(val("c:val", &v.to_string()));
    }
    e
}

/// Whether series of `kind` take trendlines and error bars.
fn has_trends(kind: &ChartKind) -> bool {
    !(kind.is_pie() || *kind == ChartKind::Radar || matches!(kind, ChartKind::Other(_)))
}

/// The children a series has before its trendline, and before its error bars.
const BEFORE_TRENDLINE: [&str; 9] = ["idx", "order", "tx", "spPr", "invertIfNegative", "pictureOptions", "marker", "dPt", "dLbls"];
const BEFORE_ERRBARS: [&str; 10] = ["idx", "order", "tx", "spPr", "invertIfNegative", "pictureOptions", "marker", "dPt", "dLbls", "trendline"];

fn marker_el(symbol: &str) -> Element {
    Element::new("c:marker").with_child(val("c:symbol", symbol))
}

/// The children a series has before its marker.
const BEFORE_MARKER: [&str; 4] = ["idx", "order", "tx", "spPr"];
/// The children a series has before `c:smooth`.
const BEFORE_SMOOTH: [&str; 13] = ["idx", "order", "tx", "spPr", "marker", "dPt", "dLbls", "trendline", "errBars", "cat", "val", "xVal", "yVal"];

fn new_ser(i: usize, s: &SeriesSpec, cats: &[String], kind: &ChartKind, kept: Option<&Element>) -> Element {
    let scatter = *kind == ChartKind::Scatter;
    let mut e = Element::new("c:ser").with_child(val("c:idx", &i.to_string())).with_child(val("c:order", &i.to_string()));
    e = e.with_child(Element::new("c:tx").with_child(Element::new("c:v").with_text(&s.name)));
    let sppr = match (&s.color, kept.and_then(|k| k.child("spPr"))) {
        (Some(c), _) => Some(Element::new("c:spPr").with_child(Element::new("a:solidFill").with_child(color_el(c)))),
        (None, Some(k)) => Some(k.clone()),
        (None, None) => None,
    };
    let sppr = match (sppr, s.line_width) {
        (Some(sp), w) => Some(with_line_width(sp, w)),
        (None, Some(w)) => Some(with_line_width(Element::new("c:spPr"), Some(w))),
        (None, None) => None,
    };
    if let Some(sppr) = sppr {
        e = e.with_child(sppr);
    }
    if has_markers(kind) {
        match (&s.marker, kept.and_then(|k| k.child("marker"))) {
            (Some(m), _) => e = e.with_child(marker_el(m)),
            // A line chart without markers says so on each series.
            (None, _) if matches!(kind, ChartKind::Line | ChartKind::StackedLine) => e = e.with_child(marker_el("none")),
            (None, Some(k)) if *kind != ChartKind::LineMarkers || k.path("symbol").and_then(|m| m.attr("val")) != Some("none") => e = e.with_child(k.clone()),
            _ => {}
        }
    }
    if has_trends(kind) {
        if let Some(t) = &s.trendline {
            e = e.with_child(trendline_el(t));
        }
        if let Some(b) = &s.error_bars {
            e = e.with_child(error_bars_el(b, scatter));
        }
    }
    let (cat, vals) = if scatter { ("c:xVal", "c:yVal") } else { ("c:cat", "c:val") };
    e = e.with_child(Element::new(cat).with_child(literal(str_cache(cats))));
    e = e.with_child(Element::new(vals).with_child(literal(num_cache(&s.values))));
    if s.smooth && has_markers(kind) && *kind != ChartKind::Radar {
        e = e.with_child(val("c:smooth", "1"));
    }
    e
}

/// The chart-type element for `kind` holding `series`, on axes `ax_ids`.
fn type_el(kind: &ChartKind, spec: &ChartSpec, series: &[(usize, &SeriesSpec)], ax_ids: &[String], kept: &[Element]) -> Element {
    let (name, bar_dir, grouping) = match kind {
        ChartKind::Column => ("c:barChart", Some("col"), Some("clustered")),
        ChartKind::StackedColumn => ("c:barChart", Some("col"), Some("stacked")),
        ChartKind::PercentColumn => ("c:barChart", Some("col"), Some("percentStacked")),
        ChartKind::Bar => ("c:barChart", Some("bar"), Some("clustered")),
        ChartKind::StackedBar => ("c:barChart", Some("bar"), Some("stacked")),
        ChartKind::PercentBar => ("c:barChart", Some("bar"), Some("percentStacked")),
        ChartKind::Line | ChartKind::LineMarkers => ("c:lineChart", None, Some("standard")),
        ChartKind::StackedLine => ("c:lineChart", None, Some("stacked")),
        ChartKind::Area => ("c:areaChart", None, Some("standard")),
        ChartKind::StackedArea => ("c:areaChart", None, Some("stacked")),
        ChartKind::Pie => ("c:pieChart", None, None),
        ChartKind::Doughnut => ("c:doughnutChart", None, None),
        ChartKind::Scatter => ("c:scatterChart", None, None),
        ChartKind::Radar => ("c:radarChart", None, None),
        ChartKind::Other(n) => return Element::new(&format!("c:{n}")),
    };
    let mut e = Element::new(name);
    if let Some(d) = bar_dir {
        e = e.with_child(val("c:barDir", d));
    }
    if *kind == ChartKind::Scatter {
        e = e.with_child(val("c:scatterStyle", "lineMarker"));
    }
    if *kind == ChartKind::Radar {
        e = e.with_child(val("c:radarStyle", "marker"));
    }
    if let Some(g) = grouping {
        e = e.with_child(val("c:grouping", g));
    }
    e = e.with_child(val("c:varyColors", if kind.is_pie() { "1" } else { "0" }));
    for (i, s) in series {
        e = e.with_child(new_ser(*i, s, &spec.categories, kind, kept.get(*i)));
    }
    if spec.data_labels {
        e = e.with_child(dlbls(spec.data_label_position.as_deref()));
    }
    if bar_dir.is_some() {
        e = e.with_child(val("c:gapWidth", "150"));
        if grouping != Some("clustered") {
            e = e.with_child(val("c:overlap", "100"));
        }
    }
    if matches!(kind, ChartKind::Line | ChartKind::LineMarkers | ChartKind::StackedLine) {
        e = e.with_child(val("c:marker", "1"));
    }
    if *kind == ChartKind::Doughnut {
        e = e.with_child(val("c:firstSliceAng", "0")).with_child(val("c:holeSize", "50"));
    }
    if *kind == ChartKind::Pie {
        e = e.with_child(val("c:firstSliceAng", "0"));
    }
    if !kind.is_pie() {
        for id in ax_ids.iter().take(2) {
            e = e.with_child(val("c:axId", id));
        }
    }
    e
}

fn dlbls(position: Option<&str>) -> Element {
    let mut d = Element::new("c:dLbls");
    if let Some(p) = position {
        d = d.with_child(val("c:dLblPos", p));
    }
    for (k, v) in [("showLegendKey", "0"), ("showVal", "1"), ("showCatName", "0"), ("showSerName", "0"), ("showPercent", "0"), ("showBubbleSize", "0")] {
        d = d.with_child(val(&format!("c:{k}"), v));
    }
    d
}

fn axes(kind: &ChartKind, spec: &ChartSpec, ids: &[String]) -> Vec<Element> {
    if kind.is_pie() {
        return Vec::new();
    }
    let (a, b) = (ids.first().cloned().unwrap_or_else(|| "100000001".into()), ids.get(1).cloned().unwrap_or_else(|| "100000002".into()));
    let horizontal = matches!(kind, ChartKind::Bar | ChartKind::StackedBar | ChartKind::PercentBar);
    let scatter = *kind == ChartKind::Scatter;
    let base = |name: &str, id: &str, cross: &str, pos: &str, title: &Option<String>, grid: bool, axis: &AxisSpec| {
        let mut scaling = Element::new("c:scaling").with_child(val("c:orientation", "minMax"));
        if let Some(v) = axis.max {
            scaling = scaling.with_child(val("c:max", &v.to_string()));
        }
        if let Some(v) = axis.min {
            scaling = scaling.with_child(val("c:min", &v.to_string()));
        }
        let mut e = Element::new(name).with_child(val("c:axId", id)).with_child(scaling);
        e = e.with_child(val("c:delete", if axis.hidden { "1" } else { "0" })).with_child(val("c:axPos", pos));
        if grid {
            e = e.with_child(Element::new("c:majorGridlines"));
        }
        if let Some(t) = title {
            e = e.with_child(title_el(t));
        }
        if let Some(f) = &axis.number_format {
            e = e.with_child(Element::new("c:numFmt").with_attr("formatCode", f).with_attr("sourceLinked", "0"));
        }
        e = e
            .with_child(val("c:majorTickMark", "out"))
            .with_child(val("c:minorTickMark", "none"))
            .with_child(val("c:tickLblPos", "nextTo"))
            .with_child(val("c:crossAx", cross))
            .with_child(val("c:crosses", "autoZero"));
        // Only a value axis has a major unit.
        if let Some(v) = axis.major.filter(|_| name == "c:valAx") {
            e = e.with_child(val("c:majorUnit", &v.to_string()));
        }
        e
    };
    let cat_name = if scatter { "c:valAx" } else { "c:catAx" };
    let cat = base(cat_name, &a, &b, if horizontal { "l" } else { "b" }, &spec.x_title, false, &spec.x_axis);
    let value = base("c:valAx", &b, &a, if horizontal { "b" } else { "l" }, &spec.y_title, spec.gridlines, &spec.y_axis);
    vec![cat, value]
}

/// A new chart part (`word/charts/chart1.xml`, `xl/charts/chart1.xml`, `ppt/charts/chart1.xml`).
/// Each series of the plot area, in document order, mapped to its place in the description: by
/// `c:order` (a combination groups series by type, so document order is not theirs), ties in
/// document order.
fn ranks(plot: &Element) -> Vec<usize> {
    let orders: Vec<usize> = plot
        .elements()
        .filter(|t| TYPES.contains(&t.local()))
        .flat_map(|t| t.elements().filter(|e| e.local() == "ser"))
        .map(|ser| ser.val("order").and_then(|v| v.trim().parse::<usize>().ok()).unwrap_or(usize::MAX))
        .collect();
    let mut by: Vec<usize> = (0..orders.len()).collect();
    by.sort_by_key(|&k| (orders[k], k));
    let mut rank = vec![0; orders.len()];
    for (place, k) in by.into_iter().enumerate() {
        rank[k] = place;
    }
    rank
}

/// A chart-type element's series: its type, whether it is on the secondary axes, and its series
/// by position.
type Group<'a> = (ChartKind, bool, Vec<(usize, &'a SeriesSpec)>);

/// Series grouped into chart-type elements: by their own type and their axes, in the order they
/// first appear.
fn groups(spec: &ChartSpec) -> Vec<Group<'_>> {
    let mut out: Vec<Group<'_>> = Vec::new();
    for (i, s) in spec.series.iter().enumerate() {
        let k = s.kind.clone().unwrap_or_else(|| spec.kind.clone());
        let sec = s.secondary && !k.is_pie();
        match out.iter_mut().find(|(g, gs, _)| *g == k && *gs == sec) {
            Some((_, _, list)) => list.push((i, s)),
            None => out.push((k, sec, vec![(i, s)])),
        }
    }
    out
}

/// The secondary axes a combination's secondary series are on: a hidden category axis and a
/// value axis on the right, crossing at the maximum.
fn secondary_axes(ids: &[String]) -> Vec<Element> {
    let (a, b) = (ids[0].as_str(), ids[1].as_str());
    let scaling = || Element::new("c:scaling").with_child(val("c:orientation", "minMax"));
    let cat = Element::new("c:catAx")
        .with_child(val("c:axId", a))
        .with_child(scaling())
        .with_child(val("c:delete", "1"))
        .with_child(val("c:axPos", "b"))
        .with_child(val("c:majorTickMark", "out"))
        .with_child(val("c:minorTickMark", "none"))
        .with_child(val("c:tickLblPos", "nextTo"))
        .with_child(val("c:crossAx", b))
        .with_child(val("c:crosses", "autoZero"));
    let value = Element::new("c:valAx")
        .with_child(val("c:axId", b))
        .with_child(scaling())
        .with_child(val("c:delete", "0"))
        .with_child(val("c:axPos", "r"))
        .with_child(val("c:majorTickMark", "out"))
        .with_child(val("c:minorTickMark", "none"))
        .with_child(val("c:tickLblPos", "nextTo"))
        .with_child(val("c:crossAx", a))
        .with_child(val("c:crosses", "max"));
    vec![cat, value]
}

const SECONDARY_IDS: [&str; 2] = ["100000003", "100000004"];

pub fn write(spec: &ChartSpec) -> String {
    let ids = vec!["100000001".to_string(), "100000002".to_string()];
    let sec_ids: Vec<String> = SECONDARY_IDS.iter().map(|s| s.to_string()).collect();
    let mut chart = Element::new("c:chart");
    match &spec.title {
        Some(t) => chart = chart.with_child(title_el(t)).with_child(val("c:autoTitleDeleted", "0")),
        None => chart = chart.with_child(val("c:autoTitleDeleted", "1")),
    }
    let mut plot = Element::new("c:plotArea").with_child(Element::new("c:layout"));
    let groups = groups(spec);
    for (k, sec, list) in &groups {
        plot = plot.with_child(type_el(k, spec, list, if *sec { &sec_ids } else { &ids }, &[]));
    }
    for ax in axes(&spec.kind, spec, &ids) {
        plot = plot.with_child(ax);
    }
    if !spec.kind.is_pie() && groups.iter().any(|(_, sec, _)| *sec) {
        for ax in secondary_axes(&sec_ids) {
            plot = plot.with_child(ax);
        }
    }
    chart = chart.with_child(plot);
    if let Some(l) = spec.legend {
        chart = chart.with_child(Element::new("c:legend").with_child(val("c:legendPos", l.ooxml())).with_child(val("c:overlay", "0")));
    }
    chart = chart.with_child(val("c:plotVisOnly", "1"));
    let space = Element::new("c:chartSpace")
        .with_attr("xmlns:c", "http://schemas.openxmlformats.org/drawingml/2006/chart")
        .with_attr("xmlns:a", "http://schemas.openxmlformats.org/drawingml/2006/main")
        .with_attr("xmlns:r", "http://schemas.openxmlformats.org/officeDocument/2006/relationships")
        .with_child(val("c:roundedCorners", "0"))
        .with_child(chart);
    xml::write(&xml::Document { prolog: vec![Node::Raw(r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>"#.into())], root: space })
}

// ------------------------------------------------------------------ patching

/// `src` changed to say what `spec` says (see the module docs).
pub fn patch(src: &str, spec: &ChartSpec) -> Result<String, ChartError> {
    let mut doc = xml::parse(src)?;
    let before = from_space(&doc.root)?;
    if before == *spec {
        return Ok(src.to_string());
    }
    let space = &mut doc.root;
    let chart = space.child_mut("chart").ok_or_else(|| ChartError("no c:chart".into()))?;
    // Title.
    if spec.title != before.title {
        chart.remove_children("title");
        match &spec.title {
            Some(t) => {
                chart.put(title_el(t), &[]);
                chart.put(val("c:autoTitleDeleted", "0"), &["title"]);
            }
            None => chart.put(val("c:autoTitleDeleted", "1"), &[]),
        }
    }
    // Legend.
    if spec.legend != before.legend {
        match spec.legend {
            Some(l) => match chart.child_mut("legend") {
                Some(legend) => legend.put(val("c:legendPos", l.ooxml()), &[]),
                None => chart.put(
                    Element::new("c:legend").with_child(val("c:legendPos", l.ooxml())).with_child(val("c:overlay", "0")),
                    &["title", "autoTitleDeleted", "pivotFmts", "view3D", "floor", "sideWall", "backWall", "plotArea"],
                ),
            },
            None => {
                chart.remove_children("legend");
            }
        }
    }
    let plot = chart.child_mut("plotArea").ok_or_else(|| ChartError("no c:plotArea".into()))?;
    let type_at: Vec<usize> =
        plot.children.iter().enumerate().filter(|(_, n)| matches!(n, Node::Element(e) if TYPES.contains(&e.local()))).map(|(i, _)| i).collect();
    let first_at = *type_at.first().ok_or_else(|| ChartError("no chart type".into()))?;
    // A type change, or a series' own type change: rebuild the chart-type elements from the spec,
    // keeping the axes and each series' formatting where there was one.
    let own = |s: &SeriesSpec, main: &ChartKind| s.kind.clone().unwrap_or_else(|| main.clone());
    let kinds_changed = spec.kind != before.kind
        || spec.series.iter().enumerate().any(|(i, s)| match before.series.get(i) {
            Some(b) => own(s, &spec.kind) != own(b, &before.kind) || s.secondary != b.secondary,
            None => own(s, &spec.kind) != spec.kind || s.secondary,
        });
    if kinds_changed {
        let kept: Vec<Element> = type_at
            .iter()
            .filter_map(|i| if let Some(Node::Element(e)) = plot.children.get(*i) { Some(e.clone()) } else { None })
            .flat_map(|t| t.elements().filter(|s| s.local() == "ser").cloned().collect::<Vec<_>>())
            .collect();
        // Kept in the series' order, as the description numbers them.
        let kept: Vec<Element> = {
            let rank = ranks(plot);
            let mut placed: Vec<Option<Element>> = vec![None; kept.len()];
            for (k, e) in kept.into_iter().enumerate() {
                if let Some(slot) = placed.get_mut(rank.get(k).copied().unwrap_or(k)) {
                    *slot = Some(e);
                }
            }
            placed.into_iter().flatten().collect()
        };
        // The first chart type's axes are the primary ones; another pair, if a type was on one,
        // the secondary.
        let type_axes = |e: &Element| e.elements().filter(|x| x.local() == "axId").filter_map(|x| x.attr("val").map(str::to_string)).collect::<Vec<_>>();
        let old_types: Vec<Vec<String>> =
            type_at.iter().filter_map(|i| if let Some(Node::Element(e)) = plot.children.get(*i) { Some(type_axes(e)) } else { None }).collect();
        let all_ax: Vec<String> =
            plot.elements().filter(|e| matches!(e.local(), "catAx" | "valAx" | "dateAx" | "serAx")).filter_map(|a| a.val("axId").map(str::to_string)).collect();
        let ax_ids: Vec<String> = match old_types.first().filter(|a| a.len() >= 2) {
            Some(a) => a.clone(),
            None => all_ax.iter().take(2).cloned().collect(),
        };
        let old_sec: Option<Vec<String>> = old_types.iter().find(|a| a.len() >= 2 && **a != ax_ids).cloned();
        for i in type_at.iter().rev() {
            plot.children.remove(*i);
        }
        let groups = groups(spec);
        let wants_sec = !spec.kind.is_pie() && groups.iter().any(|(_, sec, _)| *sec);
        let sec_ids: Vec<String> = old_sec.clone().unwrap_or_else(|| SECONDARY_IDS.iter().map(|s| s.to_string()).collect());
        for (n, (k, sec, list)) in groups.iter().enumerate() {
            plot.children.insert(first_at + n, Node::Element(type_el(k, spec, list, if *sec { &sec_ids } else { &ax_ids }, &kept)));
        }
        // Secondary axes: made for the first secondary series, removed after the last.
        match (wants_sec, &old_sec) {
            (true, None) => {
                for ax in secondary_axes(&sec_ids) {
                    plot.children.push(Node::Element(ax));
                }
            }
            (false, Some(ids)) => {
                plot.children.retain(|n| !matches!(n, Node::Element(e) if matches!(e.local(), "catAx" | "valAx" | "dateAx" | "serAx") && e.val("axId").is_some_and(|id| ids.iter().any(|x| x == id))));
            }
            _ => {}
        }
        // Axes follow the new main type: a pie has none, a chart with axes needs them.
        let has_axes = plot.elements().any(|e| matches!(e.local(), "catAx" | "valAx" | "dateAx"));
        if spec.kind.is_pie() {
            for a in ["catAx", "valAx", "dateAx", "serAx"] {
                plot.remove_children(a);
            }
        } else if !has_axes || (spec.kind == ChartKind::Scatter) != (before.kind == ChartKind::Scatter) {
            for a in ["catAx", "valAx", "dateAx", "serAx"] {
                plot.remove_children(a);
            }
            let ids = if ax_ids.len() >= 2 { ax_ids.clone() } else { vec!["100000001".into(), "100000002".into()] };
            for ax in axes(&spec.kind, spec, &ids) {
                plot.children.push(Node::Element(ax));
            }
            // The rebuilt chart types name these axes; secondary ones keep theirs, made anew.
            for t in plot.elements_mut().filter(|e| TYPES.contains(&e.local())) {
                let on_secondary = type_axes(t) == sec_ids && wants_sec;
                if on_secondary {
                    continue;
                }
                t.remove_children("axId");
                for id in ids.iter().take(2) {
                    t.children.push(Node::Element(val("c:axId", id)));
                }
            }
            if wants_sec {
                for ax in secondary_axes(&sec_ids) {
                    plot.children.push(Node::Element(ax));
                }
            }
        }
    } else {
        // Same types: edit the series in place.
        let scatter = spec.kind == ChartKind::Scatter;
        let rank = ranks(plot);
        let mut sers: Vec<&mut Element> = Vec::new();
        for n in plot.children.iter_mut() {
            if let Node::Element(t) = n
                && TYPES.contains(&t.local())
            {
                for s in t.elements_mut().filter(|e| e.local() == "ser") {
                    sers.push(s);
                }
            }
        }
        let have = sers.len();
        for (k, ser) in sers.iter_mut().enumerate() {
            let Some(s) = spec.series.get(rank.get(k).copied().unwrap_or(k)) else { continue };
            if let Some(tx) = ser.child_mut("tx") {
                if tx.child("strRef").is_some() {
                    set_cache(tx, str_cache(std::slice::from_ref(&s.name)));
                } else {
                    tx.children.clear();
                    tx.children.push(Node::Element(Element::new("c:v").with_text(&s.name)));
                }
            } else {
                ser.put(Element::new("c:tx").with_child(Element::new("c:v").with_text(&s.name)), &["idx", "order"]);
            }
            if let Some(src) = ser.child_mut(if scatter { "xVal" } else { "cat" }) {
                set_cache(src, str_cache(&spec.categories));
            } else {
                ser.put(
                    Element::new(if scatter { "c:xVal" } else { "c:cat" }).with_child(Element::new("c:strLit")),
                    &["idx", "order", "tx", "spPr", "invertIfNegative", "pictureOptions", "dPt", "dLbls", "trendline", "errBars", "marker"],
                );
                if let Some(src) = ser.child_mut(if scatter { "xVal" } else { "cat" }) {
                    set_cache(src, str_cache(&spec.categories));
                }
            }
            if let Some(src) = ser.child_mut(if scatter { "yVal" } else { "val" }) {
                set_cache(src, num_cache(&s.values));
            }
        }
        if let Some(Node::Element(t)) = plot.children.get_mut(first_at) {
            // Series the spec adds: copies of the last one with their own data.
            let template = t.elements().filter(|e| e.local() == "ser").last().cloned();
            for (i, s) in spec.series.iter().enumerate().skip(have) {
                // Like the chart's other series: its look, line and marker.
                let ser = new_ser(i, s, &spec.categories, &spec.kind, template.as_ref());
                let at = t.children.iter().rposition(|n| matches!(n, Node::Element(e) if e.local() == "ser")).map_or(t.children.len(), |p| p + 1);
                t.children.insert(at, Node::Element(ser));
            }
        }
        // Series the spec drops: the last ones by their order.
        let rank = ranks(plot);
        let mut k = 0usize;
        for n in plot.children.iter_mut() {
            if let Node::Element(t) = n
                && TYPES.contains(&t.local())
            {
                t.children.retain(|c| {
                    if let Node::Element(e) = c
                        && e.local() == "ser"
                    {
                        let keep = rank.get(k).copied().unwrap_or(k) < spec.series.len();
                        k += 1;
                        return keep;
                    }
                    true
                });
            }
        }
    }
    // Series colours given anew.
    {
        let rank = ranks(plot);
        let mut k = 0usize;
        for n in plot.children.iter_mut() {
            if let Node::Element(t) = n
                && TYPES.contains(&t.local())
            {
                for ser in t.elements_mut().filter(|e| e.local() == "ser") {
                    let i = rank.get(k).copied().unwrap_or(k);
                    k += 1;
                    if let Some(s) = spec.series.get(i)
                        && let Some(c) = &s.color
                        && before.series.get(i).and_then(|b| b.color.as_ref()) != Some(c)
                    {
                        let mut sppr = ser.child("spPr").cloned().unwrap_or_else(|| Element::new("c:spPr"));
                        sppr.remove_children("solidFill");
                        sppr.remove_children("gradFill");
                        sppr.remove_children("pattFill");
                        sppr.remove_children("noFill");
                        sppr.children.insert(0, Node::Element(Element::new("a:solidFill").with_child(color_el(c))));
                        ser.put(sppr, &["idx", "order", "tx"]);
                    }
                }
            }
        }
    }
    // Data labels on every chart type of the plot area.
    if spec.data_labels != before.data_labels {
        for n in plot.children.iter_mut() {
            if let Node::Element(t) = n
                && TYPES.contains(&t.local())
            {
                for ser in t.elements_mut().filter(|e| e.local() == "ser") {
                    ser.remove_children("dLbls");
                }
                t.remove_children("dLbls");
                if spec.data_labels {
                    t.put(dlbls(spec.data_label_position.as_deref()), &["barDir", "grouping", "scatterStyle", "radarStyle", "varyColors", "ser"]);
                }
            }
        }
    }
    // Series' line widths, markers and smoothing given anew.
    {
        let rank = ranks(plot);
        let mut k = 0usize;
        for n in plot.children.iter_mut() {
            if let Node::Element(t) = n
                && TYPES.contains(&t.local())
            {
                let own = kind_of(t);
                let markers = has_markers(&own);
                // On a line chart without markers, a series' default is none.
                let bare = matches!(own, ChartKind::Line | ChartKind::StackedLine);
                for ser in t.elements_mut().filter(|e| e.local() == "ser") {
                    let i = rank.get(k).copied().unwrap_or(k);
                    k += 1;
                    if let (Some(s), Some(b)) = (spec.series.get(i), before.series.get(i)) {
                        if s.line_width != b.line_width {
                            let sppr = with_line_width(ser.child("spPr").cloned().unwrap_or_else(|| Element::new("c:spPr")), s.line_width);
                            ser.put(sppr, &["idx", "order", "tx"]);
                        }
                        if s.marker != b.marker && markers {
                            match &s.marker {
                                Some(m) => match ser.child_mut("marker") {
                                    Some(el) => el.put(val("c:symbol", m), &[]),
                                    None => ser.put(marker_el(m), &BEFORE_MARKER),
                                },
                                None if bare => match ser.child_mut("marker") {
                                    Some(el) => el.put(val("c:symbol", "none"), &[]),
                                    None => ser.put(marker_el("none"), &BEFORE_MARKER),
                                },
                                None => {
                                    ser.remove_children("marker");
                                }
                            }
                        }
                        if s.smooth != b.smooth && markers {
                            ser.put(val("c:smooth", if s.smooth { "1" } else { "0" }), &BEFORE_SMOOTH);
                        }
                        // A trendline or error bars given anew replace the ones there.
                        if s.trendline != b.trendline && has_trends(&own) {
                            ser.remove_children("trendline");
                            if let Some(t) = &s.trendline {
                                ser.put(trendline_el(t), &BEFORE_TRENDLINE);
                            }
                        }
                        if s.error_bars != b.error_bars && has_trends(&own) {
                            let scatter = own == ChartKind::Scatter;
                            ser.children.retain(|n| !matches!(n, Node::Element(e) if e.local() == "errBars" && e.val("errDir").is_none_or(|d| d == "y")));
                            if let Some(e) = &s.error_bars {
                                ser.put(error_bars_el(e, scatter), &BEFORE_ERRBARS);
                            }
                        }
                    }
                }
            }
        }
    }
    // Where data labels sit.
    if spec.data_label_position != before.data_label_position {
        for n in plot.children.iter_mut() {
            if let Node::Element(t) = n
                && TYPES.contains(&t.local())
            {
                let mut lists: Vec<&mut Element> = Vec::new();
                for e in t.elements_mut() {
                    if e.local() == "dLbls" {
                        lists.push(e);
                    } else if e.local() == "ser"
                        && let Some(d) = e.child_mut("dLbls")
                    {
                        lists.push(d);
                    }
                }
                for d in lists {
                    match &spec.data_label_position {
                        Some(p) => d.put(val("c:dLblPos", p), &["dLbl", "delete", "numFmt", "spPr", "txPr"]),
                        None => {
                            d.remove_children("dLblPos");
                        }
                    }
                }
            }
        }
    }
    // Gridlines and axis titles.
    let (cat_at, val_at) = axis_roles(plot);
    for (i, ax) in plot.elements_mut().enumerate() {
        let (is_cat, is_y) = (Some(i) == cat_at, Some(i) == val_at);
        if is_y && spec.gridlines != before.gridlines {
            if spec.gridlines {
                ax.put(Element::new("c:majorGridlines"), &["axId", "scaling", "delete", "axPos"]);
            } else {
                ax.remove_children("majorGridlines");
            }
        }
        let (want_axis, had_axis) = if is_cat {
            (&spec.x_axis, &before.x_axis)
        } else if is_y {
            (&spec.y_axis, &before.y_axis)
        } else {
            continue;
        };
        if want_axis != had_axis {
            patch_axis(ax, want_axis, had_axis);
        }
        let (want, had) = if is_cat { (&spec.x_title, &before.x_title) } else { (&spec.y_title, &before.y_title) };
        if want != had {
            ax.remove_children("title");
            if let Some(t) = want {
                ax.put(title_el(t), &["axId", "scaling", "delete", "axPos", "majorGridlines", "minorGridlines"]);
            }
        }
    }
    let data_changed = spec.categories != before.categories
        || spec.series.len() != before.series.len()
        || spec.series.iter().zip(&before.series).any(|(a, b)| a.name != b.name || a.values != b.values);
    if data_changed {
        detach(&mut doc.root);
    }
    Ok(xml::write(&doc))
}

/// Axis `ax` changed from `had` to `want`: its scale, unit, number format and visibility.
fn patch_axis(ax: &mut Element, want: &AxisSpec, had: &AxisSpec) {
    if want.min != had.min || want.max != had.max {
        let mut scaling = ax.child("scaling").cloned().unwrap_or_else(|| Element::new("c:scaling").with_child(val("c:orientation", "minMax")));
        match want.max {
            Some(v) => scaling.put(val("c:max", &v.to_string()), &["logBase", "orientation"]),
            None => {
                scaling.remove_children("max");
            }
        }
        match want.min {
            Some(v) => scaling.put(val("c:min", &v.to_string()), &["logBase", "orientation", "max"]),
            None => {
                scaling.remove_children("min");
            }
        }
        ax.put(scaling, &["axId"]);
    }
    if want.major != had.major && ax.local() == "valAx" {
        match want.major {
            Some(v) => ax.put(val("c:majorUnit", &v.to_string()), &["crossAx", "crosses", "crossesAt", "crossBetween"]),
            None => {
                ax.remove_children("majorUnit");
            }
        }
    }
    if want.number_format != had.number_format {
        match &want.number_format {
            Some(f) => ax.put(
                Element::new("c:numFmt").with_attr("formatCode", f).with_attr("sourceLinked", "0"),
                &["axId", "scaling", "delete", "axPos", "majorGridlines", "minorGridlines", "title"],
            ),
            None => {
                ax.remove_children("numFmt");
            }
        }
    }
    if want.hidden != had.hidden {
        ax.put(val("c:delete", if want.hidden { "1" } else { "0" }), &["axId", "scaling"]);
    }
}

/// `src` with its series taking their data from the workbook [`super::workbook::workbook`] makes
/// of them: each series' name, categories (a scatter chart's X values) and values become
/// references into it ([`super::workbook::layout`]), with caches of what they hold, and the part
/// names the workbook by relationship `rid` (`c:externalData`), which the kit relates to the
/// workbook's part. The description reads the same before and after.
pub fn bind_workbook(src: &str, rid: &str) -> Result<String, ChartError> {
    let mut doc = xml::parse(src)?;
    let spec = from_space(&doc.root)?;
    // A type the description does not edit (bubble, stock…) has data the layout does not hold.
    if let ChartKind::Other(name) = &spec.kind {
        return Err(ChartError(format!("a {name} chart keeps its data as written")));
    }
    let layout = super::workbook::layout(&spec);
    let scatter = spec.kind == ChartKind::Scatter;
    let numeric_x = scatter && spec.categories.iter().all(|c| c.trim().parse::<f64>().is_ok_and(f64::is_finite));
    let r = |name: &str, f: &str, cache: Element| Element::new(&format!("c:{name}")).with_child(Element::new("c:f").with_text(f)).with_child(cache);
    // Each series bound to its own column: by its order, as the description numbers it.
    let rank = doc.root.child("chart").and_then(|c| c.child("plotArea")).map(ranks).unwrap_or_default();
    let mut sers = Vec::new();
    collect_sers(&mut doc.root, &mut sers);
    for (k, ser) in sers.into_iter().enumerate() {
        let i = rank.get(k).copied().unwrap_or(k);
        let (Some(s), Some((name_ref, values_ref))) = (spec.series.get(i), layout.series.get(i)) else { continue };
        let tx = Element::new("c:tx").with_child(r("strRef", name_ref, str_cache(std::slice::from_ref(&s.name))));
        ser.put(tx, &["idx", "order"]);
        let (cat_name, val_name) = if ser.child("xVal").is_some() || ser.child("yVal").is_some() { ("xVal", "yVal") } else { ("cat", "val") };
        let cats = if numeric_x && cat_name == "xVal" {
            let xs: Vec<Option<f64>> = spec.categories.iter().map(|c| c.trim().parse::<f64>().ok()).collect();
            r("numRef", &layout.categories, num_cache(&xs))
        } else {
            r("strRef", &layout.categories, str_cache(&spec.categories))
        };
        let mut cat = Element::new(&format!("c:{cat_name}"));
        cat.children.push(Node::Element(cats));
        ser.put(cat, &["idx", "order", "tx", "spPr", "invertIfNegative", "pictureOptions", "dPt", "dLbls", "trendline", "errBars", "marker"]);
        let mut val = Element::new(&format!("c:{val_name}"));
        val.children.push(Node::Element(r("numRef", values_ref, num_cache(&s.values))));
        ser.put(val, &["idx", "order", "tx", "spPr", "invertIfNegative", "pictureOptions", "dPt", "dLbls", "trendline", "errBars", "marker", "cat", "xVal"]);
    }
    let space = &mut doc.root;
    if space.attr("xmlns:r").is_none() {
        space.set_attr("xmlns:r", "http://schemas.openxmlformats.org/officeDocument/2006/relationships");
    }
    let data = Element::new("c:externalData").with_attr("r:id", rid).with_child(val("c:autoUpdate", "0"));
    space.put(data, &["date1904", "lang", "roundedCorners", "AlternateContent", "style", "clrMapOvr", "pivotSource", "protection", "chart", "spPr", "txPr"]);
    Ok(xml::write(&doc))
}

/// Whether part `src` takes its data from an embedded workbook (`c:externalData`).
pub fn has_workbook(src: &str) -> bool {
    xml::parse(src).is_ok_and(|d| d.root.child("externalData").is_some())
}

#[cfg(test)]
mod tests {
    use super::*;

    const BAR: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><c:chart><c:title><c:tx><c:rich><a:bodyPr/><a:p><a:r><a:t>Sales</a:t></a:r></a:p></c:rich></c:tx></c:title><c:autoTitleDeleted val="0"/><c:plotArea><c:layout/><c:barChart><c:barDir val="col"/><c:grouping val="clustered"/><c:varyColors val="0"/><c:ser><c:idx val="0"/><c:order val="0"/><c:tx><c:strRef><c:f>Sheet1!$B$1</c:f><c:strCache><c:ptCount val="1"/><c:pt idx="0"><c:v>East</c:v></c:pt></c:strCache></c:strRef></c:tx><c:spPr><a:solidFill><a:schemeClr val="accent1"/></a:solidFill><a:ln w="12700"/></c:spPr><c:cat><c:strRef><c:f>Sheet1!$A$2:$A$3</c:f><c:strCache><c:ptCount val="2"/><c:pt idx="0"><c:v>Q1</c:v></c:pt><c:pt idx="1"><c:v>Q2</c:v></c:pt></c:strCache></c:strRef></c:cat><c:val><c:numRef><c:f>Sheet1!$B$2:$B$3</c:f><c:numCache><c:formatCode>General</c:formatCode><c:ptCount val="2"/><c:pt idx="0"><c:v>10</c:v></c:pt><c:pt idx="1"><c:v>20.5</c:v></c:pt></c:numCache></c:numRef></c:val></c:ser><c:gapWidth val="219"/><c:axId val="11"/><c:axId val="22"/></c:barChart><c:catAx><c:axId val="11"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="b"/><c:crossAx val="22"/></c:catAx><c:valAx><c:axId val="22"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="l"/><c:majorGridlines/><c:crossAx val="11"/></c:valAx><c:extLst><c:ext uri="{X}"><keep/></c:ext></c:extLst></c:plotArea><c:legend><c:legendPos val="b"/></c:legend></c:chart><c:txPr><a:bodyPr/></c:txPr><c:externalData r:id="rId1"><c:autoUpdate val="0"/></c:externalData></c:chartSpace>"#;

    #[test]
    fn reads_a_bar_chart() {
        let s = read(BAR).unwrap();
        assert_eq!(s.kind, ChartKind::Column);
        assert_eq!(s.title.as_deref(), Some("Sales"));
        assert_eq!(s.categories, ["Q1", "Q2"]);
        assert_eq!(s.series.len(), 1);
        assert_eq!((s.series[0].name.as_str(), s.series[0].values.clone()), ("East", vec![Some(10.0), Some(20.5)]));
        assert_eq!(s.series[0].color, Some(Color::theme("accent1")));
        assert_eq!((s.legend, s.gridlines, s.data_labels), (Some(LegendPos::Bottom), true, false));
    }

    #[test]
    fn patching_edits_in_place_and_keeps_the_rest() {
        let mut s = read(BAR).unwrap();
        s.categories.push("Q3".into());
        s.series[0].values = vec![Some(1.0), None, Some(3.0)];
        s.series.push(SeriesSpec {
            name: "West".into(),
            values: vec![Some(4.0), Some(5.0), Some(6.0)],
            color: Some(Color::rgb(Rgb(255, 0, 0))),
            ..Default::default()
        });
        s.title = Some("Revenue".into());
        s.legend = Some(LegendPos::Top);
        s.data_labels = true;
        s.gridlines = false;
        s.y_title = Some("USD".into());
        let out = patch(BAR, &s).unwrap();
        let back = read(&out).unwrap();
        assert_eq!(back, s);
        // What the spec does not describe stays: the pen, the gap width, extensions, text.
        assert!(out.contains(r#"<a:ln w="12700"/>"#) && out.contains(r#"<c:gapWidth val="219"/>"#) && out.contains("<keep/>") && out.contains("<c:txPr>"));
        // New data no longer come from the workbook: literals, and no stale reference.
        assert!(!out.contains("<c:f>") && !out.contains("externalData") && out.contains("<c:numLit>"));
        // A change of looks alone keeps the references.
        let mut looks = read(BAR).unwrap();
        looks.title = None;
        looks.series[0].color = Some(Color::rgb(Rgb(0, 128, 0)));
        let out = patch(BAR, &looks).unwrap();
        assert_eq!(read(&out).unwrap(), looks);
        assert!(out.contains("<c:f>Sheet1!$B$2:$B$3</c:f>") && out.contains(r#"<a:srgbClr val="008000"/>"#) && out.contains(r#"<a:ln w="12700"/>"#));
    }

    #[test]
    fn a_type_change_rebuilds_only_the_chart_type() {
        let mut s = read(BAR).unwrap();
        s.kind = ChartKind::Line;
        let out = patch(BAR, &s).unwrap();
        let back = read(&out).unwrap();
        assert_eq!(back.kind, ChartKind::Line);
        assert_eq!(back.series[0].values, s.series[0].values);
        assert_eq!(back.series[0].color, Some(Color::theme("accent1")), "the series keeps its look");
        assert!(out.contains(r#"<c:axId val="11"/>"#) && out.contains("<keep/>"), "the axes and extensions stay");
        s.kind = ChartKind::Pie;
        let pie = patch(BAR, &s).unwrap();
        assert_eq!(read(&pie).unwrap().kind, ChartKind::Pie);
        assert!(!pie.contains("<c:catAx>"), "a pie has no axes");
    }

    #[test]
    fn writes_new_charts_of_every_type_that_read_back() {
        for kind in [
            ChartKind::Column,
            ChartKind::StackedBar,
            ChartKind::PercentColumn,
            ChartKind::Line,
            ChartKind::LineMarkers,
            ChartKind::StackedArea,
            ChartKind::Pie,
            ChartKind::Doughnut,
            ChartKind::Scatter,
            ChartKind::Radar,
        ] {
            let mut s = ChartSpec::sample(kind.clone());
            s.x_title = Some("When".into());
            if kind.is_pie() {
                s.series.truncate(1);
                s.x_title = None;
                s.gridlines = false;
            }
            let back = read(&write(&s)).unwrap();
            assert_eq!(back, s, "{kind:?}");
        }
    }

    #[test]
    fn unchanged_specs_leave_the_part_as_it_was_and_bad_parts_fail() {
        assert_eq!(patch(BAR, &read(BAR).unwrap()).unwrap(), BAR);
        assert!(read("<c:chartSpace><c:chart/></c:chartSpace>").is_err());
        assert!(read("not xml").is_err());
    }

    #[test]
    fn binding_a_workbook_points_every_series_at_it_and_reads_the_same() {
        for kind in [ChartKind::Column, ChartKind::Scatter, ChartKind::Pie] {
            let mut spec = ChartSpec::sample(kind.clone());
            if kind == ChartKind::Scatter {
                spec.categories = vec!["1".into(), "2.5".into(), "4".into()];
            }
            if kind.is_pie() {
                spec.series.truncate(1);
                spec.gridlines = false;
            }
            let part = write(&spec);
            assert!(!has_workbook(&part));
            let bound = bind_workbook(&part, "rId7").unwrap();
            assert!(has_workbook(&bound));
            assert_eq!(read(&bound).unwrap(), spec, "{kind:?}");
            assert!(bound.contains(r#"<c:externalData r:id="rId7"><c:autoUpdate val="0"/></c:externalData>"#));
            assert!(bound.contains("<c:f>Sheet1!$B$2:$B$4</c:f>") && bound.contains("<c:f>Sheet1!$B$1</c:f>"), "{bound}");
            assert!(!bound.contains("<c:numLit>") && !bound.contains("<c:strLit>"));
            // A patch after an edit of the data detaches it again; binding makes a new link.
            let mut edited = spec.clone();
            edited.series[0].values[0] = Some(99.0);
            let patched = patch(&bound, &edited).unwrap();
            assert!(!has_workbook(&patched));
            assert_eq!(read(&bind_workbook(&patched, "rId8").unwrap()).unwrap(), edited);
        }
    }

    #[test]
    fn axis_scales_label_positions_and_series_looks_write_read_and_patch() {
        // A new chart with them reads back as written.
        let mut spec = ChartSpec::sample(ChartKind::LineMarkers);
        spec.y_axis = AxisSpec { min: Some(0.0), max: Some(10.0), major: Some(2.5), number_format: Some("0.0%".into()), hidden: false };
        spec.x_axis = AxisSpec { hidden: true, ..Default::default() };
        spec.data_labels = true;
        spec.data_label_position = Some("t".into());
        spec.series[0].line_width = Some(2.25);
        spec.series[0].marker = Some("diamond".into());
        spec.series[1].smooth = true;
        let part = write(&spec);
        assert_eq!(read(&part).unwrap(), spec);
        // A plain line chart's "no marker" is its type, not a series' choice.
        let plain = ChartSpec::sample(ChartKind::Line);
        assert_eq!(read(&write(&plain)).unwrap(), plain);

        // Patching a file's bar chart: the members change, the rest stays.
        let mut s = read(BAR).unwrap();
        s.y_axis = AxisSpec { min: Some(5.0), max: Some(25.0), major: Some(5.0), number_format: Some("#,##0".into()), hidden: false };
        s.x_axis.hidden = true;
        s.series[0].line_width = Some(1.5);
        s.data_labels = true;
        s.data_label_position = Some("outEnd".into());
        let out = patch(BAR, &s).unwrap();
        assert_eq!(read(&out).unwrap(), s);
        assert!(out.contains(r#"<c:gapWidth val="219"/>"#) && out.contains("<keep/>") && out.contains("<c:f>Sheet1!$B$2:$B$3</c:f>"), "{out}");
        // And back: the automatic scale again.
        let mut auto = s.clone();
        auto.y_axis = AxisSpec::default();
        auto.series[0].line_width = None;
        auto.data_label_position = None;
        let back = patch(&out, &auto).unwrap();
        assert_eq!(read(&back).unwrap(), auto);
        assert!(!back.contains("c:majorUnit") && !back.contains("<c:min ") && !back.contains("dLblPos"), "{back}");

        // A line chart's markers and smoothing patch in place.
        let line = write(&ChartSpec::sample(ChartKind::LineMarkers));
        let mut l = read(&line).unwrap();
        l.series[0].marker = Some("square".into());
        l.series[1].smooth = true;
        let out = patch(&line, &l).unwrap();
        assert_eq!(read(&out).unwrap(), l);

        // A plain line chart with one series given a marker stays a line chart, written or
        // patched, and the marker cleared again is the type's none.
        let mut one = ChartSpec::sample(ChartKind::Line);
        one.series[0].marker = Some("square".into());
        assert_eq!(read(&write(&one)).unwrap(), one);
        let plain = write(&ChartSpec::sample(ChartKind::Line));
        let out = patch(&plain, &one).unwrap();
        assert_eq!(read(&out).unwrap(), one);
        let back = patch(&out, &ChartSpec::sample(ChartKind::Line)).unwrap();
        assert_eq!(read(&back).unwrap(), ChartSpec::sample(ChartKind::Line));
        // On a line chart without markers, a series that names none has automatic ones.
        let mut auto = ChartSpec::sample(ChartKind::Line);
        auto.series[1].marker = Some("auto".into());
        assert_eq!(read(&write(&auto)).unwrap(), auto);
    }

    #[test]
    fn trendlines_and_error_bars_write_read_and_patch() {
        let mut spec = ChartSpec::sample(ChartKind::LineMarkers);
        spec.series[0].trendline = Some(Trendline { kind: "poly".into(), order: Some(3), forward: Some(1.0), ..Default::default() });
        spec.series[1].error_bars = Some(ErrorBars { kind: "percentage".into(), value: Some(10.0) });
        let xml = write(&spec);
        let back = read(&xml).unwrap();
        assert_eq!(
            (back.series[0].trendline.clone(), back.series[1].error_bars.clone()),
            (spec.series[0].trendline.clone(), spec.series[1].error_bars.clone())
        );
        // Patched: one replaced, one removed, one added; the rest of the part kept.
        let mut next = back.clone();
        next.series[0].trendline = Some(Trendline { kind: "movingAvg".into(), period: Some(2), ..Default::default() });
        next.series[1].error_bars = None;
        next.series[1].trendline = Some(Trendline { kind: "linear".into(), ..Default::default() });
        let patched = patch(&xml, &next).unwrap();
        let again = read(&patched).unwrap();
        assert_eq!(again.series[0].trendline.as_ref().unwrap().kind, "movingAvg");
        assert_eq!((again.series[1].error_bars.clone(), again.series[1].trendline.as_ref().unwrap().kind.as_str()), (None, "linear"));
        assert_eq!(patched.matches("<c:trendline>").count(), 2);
        // A trendline sits before the values, as the schema orders a series.
        let ser = &patched[patched.find("<c:ser>").unwrap()..];
        assert!(ser.find("<c:trendline>").unwrap() < ser.find("<c:val>").unwrap());
        // Scatter error bars name their direction; pies take none.
        let mut sc = ChartSpec::sample(ChartKind::Scatter);
        sc.series[0].error_bars = Some(ErrorBars { kind: "stdErr".into(), value: None });
        let sx = write(&sc);
        assert!(sx.contains("<c:errDir val=\"y\"/>"), "{sx}");
        assert_eq!(read(&sx).unwrap().series[0].error_bars.as_ref().unwrap().kind, "stdErr");
        let mut pie = ChartSpec::sample(ChartKind::Pie);
        pie.series[0].trendline = Some(Trendline { kind: "linear".into(), ..Default::default() });
        assert!(!write(&pie).contains("trendline"));
    }

    #[test]
    fn combinations_put_series_on_the_secondary_axis_and_back() {
        // Written new: a column series and a line on the secondary axis.
        let mut spec = ChartSpec::sample(ChartKind::Column);
        spec.series[1].kind = Some(ChartKind::Line);
        spec.series[1].secondary = true;
        let xml = write(&spec);
        assert!(xml.contains("<c:crosses val=\"max\"/>") && xml.contains("<c:lineChart>"), "{xml}");
        let back = read(&xml).unwrap();
        assert_eq!((back.series[1].kind.clone(), back.series[1].secondary, back.series[0].secondary), (Some(ChartKind::Line), true, false));
        // Patched: a plain column chart's second series moves to a secondary line, keeping the rest.
        let plain = write(&ChartSpec::sample(ChartKind::Column)).replace("</c:chartSpace>", "<c:extLst><kept/></c:extLst></c:chartSpace>");
        let mut next = read(&plain).unwrap();
        next.series[1].kind = Some(ChartKind::Line);
        next.series[1].secondary = true;
        let patched = patch(&plain, &next).unwrap();
        let again = read(&patched).unwrap();
        assert_eq!((again.series[1].kind.clone(), again.series[1].secondary), (Some(ChartKind::Line), true));
        assert!(patched.contains("<kept/>") && patched.matches("<c:valAx>").count() == 2);
        // The series keep their order, and an in-place edit reaches the right one.
        let mut sample3 = ChartSpec::sample(ChartKind::Column);
        sample3.series.push(SeriesSpec { name: "Series 3".into(), values: vec![Some(1.0), Some(1.0), Some(1.0)], ..Default::default() });
        let three = write(&sample3);
        let mut mixed = read(&three).unwrap();
        mixed.series[1].kind = Some(ChartKind::Line);
        let mixed_xml = patch(&three, &mixed).unwrap();
        let mut renamed = read(&mixed_xml).unwrap();
        assert_eq!(renamed.series.iter().map(|s| s.name.as_str()).collect::<Vec<_>>(), ["Series 1", "Series 2", "Series 3"]);
        renamed.series[2].values[0] = Some(9.0);
        renamed.series[1].color = Some(Color::rgb(Rgb(1, 2, 3)));
        let edited = read(&patch(&mixed_xml, &renamed).unwrap()).unwrap();
        // Bound to a workbook, each series keeps its own data.
        let bound = read(&bind_workbook(&mixed_xml, "rId1").unwrap()).unwrap();
        assert_eq!(
            bound.series.iter().map(|s| (s.name.clone(), s.values.clone())).collect::<Vec<_>>(),
            mixed.series.iter().map(|s| (s.name.clone(), s.values.clone())).collect::<Vec<_>>()
        );
        assert_eq!(
            (edited.series[2].values[0], edited.series[1].color.clone(), edited.series[0].color.clone()),
            (Some(9.0), Some(Color::rgb(Rgb(1, 2, 3))), None)
        );
        // Back on the primary axis: the secondary axes go.
        let mut flat = again.clone();
        flat.series[1].secondary = false;
        let one = patch(&patched, &flat).unwrap();
        assert_eq!(one.matches("<c:valAx>").count(), 1, "{one}");
        assert!(!read(&one).unwrap().series[1].secondary);
    }
}
