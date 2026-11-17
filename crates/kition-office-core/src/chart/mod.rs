//! Charts (`KitDrawing` 1.1): the chart description agents read and commands take, its DrawingML
//! codec (`c:chartSpace`, the same in DOCX, XLSX and PPTX), and the `drawing.chart` operation.
//!
//! A kit keeps its own chart model and renderer; this is the contract between them. Slide maps
//! its model to [`ChartSpec`]; Word reads and patches the chart part with [`codec`]; Sheet maps its
//! range-bound charts (their data are the sheet's cells, edited there).

pub mod codec;
pub mod trend;
pub mod workbook;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::model::Color;
use crate::ops::DrawingError;

/// Most categories or series a chart may hold through a command.
pub const MAX_POINTS: usize = 10_000;
pub const MAX_SERIES: usize = 255;

/// The chart types `KitDrawing` charts edit. Others a file holds (stock, surface, bubble, 3-D,
/// the 2016 chart types) are described as [`ChartKind::Other`] with their element name: their
/// data and titles edit, their type does not change.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ChartKind {
    #[default]
    Column,
    StackedColumn,
    PercentColumn,
    Bar,
    StackedBar,
    PercentBar,
    Line,
    LineMarkers,
    StackedLine,
    Area,
    StackedArea,
    Pie,
    Doughnut,
    Scatter,
    Radar,
    Other(String),
}

impl ChartKind {
    pub fn parse(name: &str) -> Option<ChartKind> {
        serde_json::from_value(Value::String(name.into())).ok().filter(|k| !matches!(k, ChartKind::Other(_)))
    }
    /// A pie or doughnut: one series, no axes.
    pub fn is_pie(&self) -> bool {
        matches!(self, ChartKind::Pie | ChartKind::Doughnut)
    }
}

/// Where the legend is.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum LegendPos {
    Top,
    Bottom,
    Left,
    Right,
    TopRight,
}

impl LegendPos {
    pub fn ooxml(self) -> &'static str {
        match self {
            LegendPos::Top => "t",
            LegendPos::Bottom => "b",
            LegendPos::Left => "l",
            LegendPos::Right => "r",
            LegendPos::TopRight => "tr",
        }
    }
    pub fn from_ooxml(v: &str) -> LegendPos {
        match v {
            "t" => LegendPos::Top,
            "l" => LegendPos::Left,
            "tr" => LegendPos::TopRight,
            "b" => LegendPos::Bottom,
            _ => LegendPos::Right,
        }
    }
}

/// One series.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct SeriesSpec {
    pub name: String,
    /// One value per category (`null`: a gap).
    pub values: Vec<Option<f64>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub color: Option<Color>,
    /// Its own type in a combination chart.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kind: Option<ChartKind>,
    /// Its line's (or its bars' outline's) width in points; `None`: the chart's style.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub line_width: Option<f64>,
    /// Its marker (a line, scatter or radar chart's): one of [`MARKERS`]; `None`: the type's.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub marker: Option<String>,
    /// A line or scatter series drawn as a smooth curve.
    #[serde(skip_serializing_if = "is_false")]
    pub smooth: bool,
    /// Its trendline (a bar, column, line, area or scatter series').
    #[serde(skip_serializing_if = "Option::is_none")]
    pub trendline: Option<Trendline>,
    /// Its error bars, on its values (a bar, column, line, area or scatter series').
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_bars: Option<ErrorBars>,
    /// Plotted against the secondary value axis (on the right) in a combination chart.
    #[serde(skip_serializing_if = "is_false")]
    pub secondary: bool,
}

/// Trendline types (DrawingML `ST_TrendlineType`).
pub const TRENDLINES: [&str; 6] = ["linear", "exp", "log", "poly", "power", "movingAvg"];
/// Error amount types (DrawingML `ST_ErrValType`, less custom values).
pub const ERROR_BARS: [&str; 4] = ["fixedVal", "percentage", "stdDev", "stdErr"];

/// A series' trendline (`c:trendline`).
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Trendline {
    /// One of [`TRENDLINES`].
    pub kind: String,
    /// A polynomial's order, 2 to 6.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub order: Option<u32>,
    /// A moving average's period, 2 or more.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub period: Option<u32>,
    /// How far it runs past the data, forward and backward (categories, or X units on a
    /// scatter chart).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub forward: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub backward: Option<f64>,
}

/// A series' error bars (`c:errBars`), both ways on its values.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ErrorBars {
    /// One of [`ERROR_BARS`].
    pub kind: String,
    /// The amount: a value (`fixedVal`), a percent (`percentage`), or how many standard
    /// deviations (`stdDev`); `None`: Office's default (1, 5% or 1). `stdErr` takes none.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value: Option<f64>,
}

impl Trendline {
    /// Checked: a known type and order, period and extents in range.
    pub fn check(&self) -> Result<(), DrawingError> {
        if !TRENDLINES.contains(&self.kind.as_str()) {
            return Err(DrawingError::unsupported("trendline.kind", format!("trendline `{}` ({})", self.kind, TRENDLINES.join(", "))));
        }
        if self.order.is_some_and(|o| !(2..=6).contains(&o)) {
            return Err(DrawingError::invalid("a polynomial trendline's `order` is 2 to 6"));
        }
        if self.period.is_some_and(|p| !(2..=255).contains(&p)) {
            return Err(DrawingError::invalid("a moving average's `period` is 2 to 255"));
        }
        if [self.forward, self.backward].iter().flatten().any(|v| !v.is_finite() || *v < 0.0 || *v > 1e9) {
            return Err(DrawingError::invalid("`forward` and `backward` are 0 or more"));
        }
        Ok(())
    }
}

impl ErrorBars {
    /// Checked: a known type and a positive, finite amount.
    pub fn check(&self) -> Result<(), DrawingError> {
        if !ERROR_BARS.contains(&self.kind.as_str()) {
            return Err(DrawingError::unsupported("errorBars.kind", format!("error bars `{}` ({})", self.kind, ERROR_BARS.join(", "))));
        }
        if self.value.is_some_and(|v| !v.is_finite() || !(0.0..=1e12).contains(&v)) {
            return Err(DrawingError::invalid("an error amount is 0 or more"));
        }
        Ok(())
    }
}

fn is_false(v: &bool) -> bool {
    !*v
}

/// The markers a series takes (DrawingML `ST_MarkerStyle`).
pub const MARKERS: [&str; 11] = ["none", "auto", "circle", "dash", "diamond", "dot", "plus", "square", "star", "triangle", "x"];
/// Where data labels sit (DrawingML `ST_DLblPos`).
pub const LABEL_POSITIONS: [&str; 9] = ["bestFit", "b", "ctr", "inBase", "inEnd", "l", "outEnd", "r", "t"];

/// An axis's scale and labels; members left `None` are automatic.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct AxisSpec {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub min: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max: Option<f64>,
    /// The distance between major tick marks and gridlines.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub major: Option<f64>,
    /// An Excel number format code (`0.0%`); `None`: as the data are formatted.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub number_format: Option<String>,
    /// The axis (its line and labels) is not shown.
    #[serde(skip_serializing_if = "is_false")]
    pub hidden: bool,
}

impl AxisSpec {
    pub fn is_default(&self) -> bool {
        *self == AxisSpec::default()
    }
}

/// A chart, described.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ChartSpec {
    pub kind: ChartKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    pub categories: Vec<String>,
    pub series: Vec<SeriesSpec>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub legend: Option<LegendPos>,
    pub data_labels: bool,
    pub gridlines: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub x_title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub y_title: Option<String>,
    /// The category (or a scatter chart's X) axis.
    #[serde(skip_serializing_if = "AxisSpec::is_default")]
    pub x_axis: AxisSpec,
    /// The value axis.
    #[serde(skip_serializing_if = "AxisSpec::is_default")]
    pub y_axis: AxisSpec,
    /// Where data labels sit: one of [`LABEL_POSITIONS`]; `None`: the type's.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data_label_position: Option<String>,
}

impl ChartSpec {
    /// A new chart's data: three categories, two series, as an inserted chart starts.
    pub fn sample(kind: ChartKind) -> Self {
        ChartSpec {
            kind,
            title: Some("Chart Title".into()),
            categories: vec!["Category 1".into(), "Category 2".into(), "Category 3".into()],
            series: vec![
                SeriesSpec { name: "Series 1".into(), values: vec![Some(4.3), Some(2.5), Some(3.5)], ..Default::default() },
                SeriesSpec { name: "Series 2".into(), values: vec![Some(2.4), Some(4.4), Some(1.8)], ..Default::default() },
            ],
            legend: Some(LegendPos::Bottom),
            data_labels: false,
            gridlines: true,
            ..Default::default()
        }
    }
}

/// What a change does to an axis; `None` leaves a member as it is.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct AxisChange {
    pub min: Option<Option<f64>>,
    pub max: Option<Option<f64>>,
    pub major: Option<Option<f64>>,
    pub number_format: Option<Option<String>>,
    pub hidden: Option<bool>,
}

/// What a change does to one series' look; `None` leaves a member as it is.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct SeriesFormat {
    pub color: Option<Option<Color>>,
    pub line_width: Option<Option<f64>>,
    pub marker: Option<Option<String>>,
    pub smooth: Option<bool>,
    pub trendline: Option<Option<Trendline>>,
    pub error_bars: Option<Option<ErrorBars>>,
    pub secondary: Option<bool>,
    /// Its own type in a combination chart (`null`: the chart's).
    pub kind: Option<Option<ChartKind>>,
}

/// A number or null at `p[k]` (`Some(None)`: null), checked by `ok`.
fn number_or_null(p: &Value, k: &str, ok: impl Fn(f64) -> bool) -> Result<Option<Option<f64>>, DrawingError> {
    match p.get(k) {
        None => Ok(None),
        Some(Value::Null) => Ok(Some(None)),
        Some(v) => v.as_f64().filter(|n| n.is_finite() && ok(*n)).map(|n| Some(Some(n))).ok_or_else(|| DrawingError::invalid(format!("`{k}` is out of range"))),
    }
}

/// A text from `allowed` or null at `p[k]`.
fn choice_or_null(p: &Value, k: &str, allowed: &[&str]) -> Result<Option<Option<String>>, DrawingError> {
    match p.get(k) {
        None => Ok(None),
        Some(Value::Null) => Ok(Some(None)),
        Some(Value::String(s)) if allowed.contains(&s.as_str()) => Ok(Some(Some(s.clone()))),
        Some(_) => Err(DrawingError::invalid(format!("`{k}` is one of {} or null", allowed.join(", ")))),
    }
}

impl AxisChange {
    fn parse(p: &Value) -> Result<AxisChange, DrawingError> {
        let number_format = match p.get("numberFormat") {
            None => None,
            Some(Value::Null) => Some(None),
            Some(Value::String(s)) if !s.is_empty() && s.chars().count() <= 255 => Some(Some(s.clone())),
            Some(_) => return Err(DrawingError::invalid("`numberFormat` is a format code (at most 255 characters) or null")),
        };
        let hidden = match p.get("hidden") {
            None => None,
            Some(Value::Bool(b)) => Some(*b),
            Some(_) => return Err(DrawingError::invalid("`hidden` is true or false")),
        };
        let a = AxisChange {
            min: number_or_null(p, "min", |_| true)?,
            max: number_or_null(p, "max", |_| true)?,
            major: number_or_null(p, "major", |n| n > 0.0)?,
            number_format,
            hidden,
        };
        if let (Some(Some(min)), Some(Some(max))) = (a.min, a.max)
            && min >= max
        {
            return Err(DrawingError::invalid("an axis's `min` is below its `max`"));
        }
        Ok(a)
    }
    fn apply(&self, a: &mut AxisSpec) -> Result<(), DrawingError> {
        if let Some(v) = self.min {
            a.min = v;
        }
        if let Some(v) = self.max {
            a.max = v;
        }
        if let Some(v) = self.major {
            a.major = v;
        }
        if let Some(v) = &self.number_format {
            a.number_format.clone_from(v);
        }
        if let Some(v) = self.hidden {
            a.hidden = v;
        }
        if let (Some(min), Some(max)) = (a.min, a.max)
            && min >= max
        {
            return Err(DrawingError::invalid("an axis's `min` is below its `max`"));
        }
        Ok(())
    }
}

impl SeriesFormat {
    fn parse(p: &Value) -> Result<SeriesFormat, DrawingError> {
        let color = match p.get("color") {
            None => None,
            Some(Value::Null) => Some(None),
            Some(c) => Some(Some(Color::from_value(c).ok_or_else(|| DrawingError::invalid("a series colour"))?)),
        };
        let smooth = match p.get("smooth") {
            None => None,
            Some(Value::Bool(b)) => Some(*b),
            Some(_) => return Err(DrawingError::invalid("`smooth` is true or false")),
        };
        // A kind's name alone, or the whole description; `null` removes it.
        let trendline = match p.get("trendline") {
            None => None,
            Some(Value::Null) => Some(None),
            Some(Value::String(k)) => Some(Some(Trendline { kind: k.clone(), ..Default::default() })),
            Some(v) => Some(Some(serde_json::from_value::<Trendline>(v.clone()).map_err(|e| DrawingError::invalid(format!("trendline: {e}")))?)),
        };
        if let Some(Some(t)) = &trendline {
            t.check()?;
        }
        let error_bars = match p.get("errorBars") {
            None => None,
            Some(Value::Null) => Some(None),
            Some(Value::String(k)) => Some(Some(ErrorBars { kind: k.clone(), ..Default::default() })),
            Some(v) => Some(Some(serde_json::from_value::<ErrorBars>(v.clone()).map_err(|e| DrawingError::invalid(format!("errorBars: {e}")))?)),
        };
        if let Some(Some(e)) = &error_bars {
            e.check()?;
        }
        let secondary = match p.get("secondary") {
            None => None,
            Some(Value::Bool(b)) => Some(*b),
            Some(_) => return Err(DrawingError::invalid("`secondary` is true or false")),
        };
        let kind = match p.get("kind") {
            None => None,
            Some(Value::Null) => Some(None),
            Some(Value::String(k)) => {
                Some(Some(ChartKind::parse(k).ok_or_else(|| DrawingError::unsupported("chart.series.kind", format!("chart type `{k}`")))?))
            }
            Some(_) => return Err(DrawingError::invalid("a series' `kind` is a chart type or null")),
        };
        Ok(SeriesFormat {
            color,
            line_width: number_or_null(p, "lineWidth", |n| (0.0..=100.0).contains(&n))?,
            marker: choice_or_null(p, "marker", &MARKERS)?,
            smooth,
            trendline,
            error_bars,
            secondary,
            kind,
        })
    }
    fn apply(&self, s: &mut SeriesSpec) {
        if let Some(v) = &self.color {
            s.color.clone_from(v);
        }
        if let Some(v) = self.line_width {
            s.line_width = v;
        }
        if let Some(v) = &self.marker {
            s.marker.clone_from(v);
        }
        if let Some(v) = self.smooth {
            s.smooth = v;
        }
        if let Some(v) = &self.trendline {
            s.trendline.clone_from(v);
        }
        if let Some(v) = &self.error_bars {
            s.error_bars.clone_from(v);
        }
        if let Some(v) = self.secondary {
            s.secondary = v;
        }
        if let Some(v) = &self.kind {
            s.kind.clone_from(v);
        }
    }
}

/// What a `drawing.chart` command changes; `None` leaves a member as it is.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct ChartChange {
    pub kind: Option<ChartKind>,
    pub title: Option<Option<String>>,
    pub legend: Option<Option<LegendPos>>,
    pub data_labels: Option<bool>,
    pub gridlines: Option<bool>,
    pub x_title: Option<Option<String>>,
    pub y_title: Option<Option<String>>,
    pub categories: Option<Vec<String>>,
    pub series: Option<Vec<SeriesSpec>>,
    pub x_axis: Option<AxisChange>,
    pub y_axis: Option<AxisChange>,
    pub data_label_position: Option<Option<String>>,
    /// Series' looks by position, their data left as they are.
    pub series_format: Option<Vec<(usize, SeriesFormat)>>,
}

impl ChartChange {
    /// Whether it changes the data (categories or series), not only properties.
    pub fn touches_data(&self) -> bool {
        self.categories.is_some() || self.series.is_some()
    }

    /// From `drawing.chart` parameters: `{id, kind?, title?: text | null, legend?: pos | null,
    /// dataLabels?, gridlines?, xTitle?, yTitle?, categories?, series?: [{name, values, color?}]}`.
    pub fn parse(p: &Value) -> Result<ChartChange, DrawingError> {
        let text = |k: &str| -> Result<Option<Option<String>>, DrawingError> {
            match p.get(k) {
                None => Ok(None),
                Some(Value::Null) => Ok(Some(None)),
                Some(Value::String(s)) if s.chars().count() <= 1000 => Ok(Some(Some(s.clone()))),
                Some(_) => Err(DrawingError::invalid(format!("`{k}` is a text (at most 1000 characters) or null"))),
            }
        };
        let flag = |k: &str| -> Result<Option<bool>, DrawingError> {
            match p.get(k) {
                None => Ok(None),
                Some(Value::Bool(b)) => Ok(Some(*b)),
                Some(_) => Err(DrawingError::invalid(format!("`{k}` is true or false"))),
            }
        };
        let kind = match p.get("kind") {
            None => None,
            Some(Value::String(s)) => Some(ChartKind::parse(s).ok_or_else(|| DrawingError::unsupported("chart.kind", format!("chart type `{s}`")))?),
            Some(_) => return Err(DrawingError::invalid("`kind` is a chart type")),
        };
        let legend = match p.get("legend") {
            None => None,
            Some(Value::Null) => Some(None),
            Some(v) => Some(Some(
                serde_json::from_value::<LegendPos>(v.clone()).map_err(|_| DrawingError::invalid("legend is top, bottom, left, right, topRight or null"))?,
            )),
        };
        let categories = match p.get("categories") {
            None => None,
            Some(Value::Array(a)) if a.len() <= MAX_POINTS => Some(
                a.iter()
                    .map(|v| match v {
                        Value::String(s) => Ok(s.clone()),
                        Value::Number(n) => Ok(n.to_string()),
                        _ => Err(DrawingError::invalid("a category is a text")),
                    })
                    .collect::<Result<Vec<_>, _>>()?,
            ),
            Some(_) => return Err(DrawingError::invalid(format!("`categories` is a list of at most {MAX_POINTS} texts"))),
        };
        let series = match p.get("series") {
            None => None,
            Some(Value::Array(a)) if !a.is_empty() && a.len() <= MAX_SERIES => {
                let mut out = Vec::with_capacity(a.len());
                for s in a {
                    let name = s.get("name").and_then(Value::as_str).unwrap_or_default().to_string();
                    let values = s
                        .get("values")
                        .and_then(Value::as_array)
                        .filter(|v| v.len() <= MAX_POINTS)
                        .ok_or_else(|| DrawingError::invalid("a series has `values`"))?
                        .iter()
                        .map(|v| match v {
                            Value::Null => Ok(None),
                            v => v.as_f64().filter(|n| n.is_finite()).map(Some).ok_or_else(|| DrawingError::invalid("a value is a number or null")),
                        })
                        .collect::<Result<Vec<_>, _>>()?;
                    let mut spec = SeriesSpec { name, values, ..Default::default() };
                    SeriesFormat::parse(s)?.apply(&mut spec);
                    out.push(spec);
                }
                Some(out)
            }
            Some(_) => return Err(DrawingError::invalid(format!("`series` is a list of 1 to {MAX_SERIES} series"))),
        };
        let axis = |k: &str| -> Result<Option<AxisChange>, DrawingError> {
            match p.get(k) {
                None => Ok(None),
                Some(v @ Value::Object(_)) => Ok(Some(AxisChange::parse(v)?)),
                Some(_) => Err(DrawingError::invalid(format!("`{k}` is {{min?, max?, major?, numberFormat?, hidden?}}"))),
            }
        };
        let series_format = match p.get("seriesFormat") {
            None => None,
            Some(Value::Array(a)) if a.len() <= MAX_SERIES => Some(
                a.iter()
                    .map(|f| {
                        let i = f
                            .get("index")
                            .and_then(Value::as_u64)
                            .and_then(|i| usize::try_from(i).ok())
                            .ok_or_else(|| DrawingError::invalid("a series format names its series by `index`"))?;
                        Ok((i, SeriesFormat::parse(f)?))
                    })
                    .collect::<Result<Vec<_>, DrawingError>>()?,
            ),
            Some(_) => return Err(DrawingError::invalid("`seriesFormat` is a list of {index, color?, lineWidth?, marker?, smooth?, trendline?, errorBars?}")),
        };
        let change = ChartChange {
            x_axis: axis("xAxis")?,
            y_axis: axis("yAxis")?,
            data_label_position: choice_or_null(p, "dataLabelPosition", &LABEL_POSITIONS)?,
            series_format,
            kind,
            title: text("title")?,
            legend,
            data_labels: flag("dataLabels")?,
            gridlines: flag("gridlines")?,
            x_title: text("xTitle")?,
            y_title: text("yTitle")?,
            categories,
            series,
        };
        if change == ChartChange::default() {
            return Err(DrawingError::invalid("give something to change"));
        }
        Ok(change)
    }

    /// Applies the change to `c`. A type change of a chart whose type is not editable, or a pie
    /// given several series, fails.
    pub fn apply(&self, c: &mut ChartSpec) -> Result<(), DrawingError> {
        if let Some(k) = &self.kind {
            if let ChartKind::Other(name) = &c.kind {
                return Err(DrawingError::unsupported("chart.kind", format!("a {name} chart keeps its type")));
            }
            c.kind = k.clone();
        }
        if let Some(t) = &self.title {
            c.title.clone_from(t);
        }
        if let Some(l) = self.legend {
            c.legend = l;
        }
        if let Some(b) = self.data_labels {
            c.data_labels = b;
        }
        if let Some(b) = self.gridlines {
            c.gridlines = b;
        }
        if let Some(t) = &self.x_title {
            c.x_title.clone_from(t);
        }
        if let Some(t) = &self.y_title {
            c.y_title.clone_from(t);
        }
        if let Some(cats) = &self.categories {
            c.categories.clone_from(cats);
        }
        if let Some(series) = &self.series {
            // A series keeps its colour and its own type unless given new ones.
            let old = std::mem::take(&mut c.series);
            c.series = series
                .iter()
                .enumerate()
                .map(|(i, s)| {
                    let prev = old.get(i);
                    SeriesSpec {
                        color: s.color.clone().or_else(|| prev.and_then(|p| p.color.clone())),
                        kind: s.kind.clone().or_else(|| prev.and_then(|p| p.kind.clone())),
                        line_width: s.line_width.or_else(|| prev.and_then(|p| p.line_width)),
                        marker: s.marker.clone().or_else(|| prev.and_then(|p| p.marker.clone())),
                        smooth: s.smooth || prev.is_some_and(|p| p.smooth),
                        trendline: s.trendline.clone().or_else(|| prev.and_then(|p| p.trendline.clone())),
                        error_bars: s.error_bars.clone().or_else(|| prev.and_then(|p| p.error_bars.clone())),
                        secondary: s.secondary || prev.is_some_and(|p| p.secondary),
                        ..s.clone()
                    }
                })
                .collect();
        }
        if let Some(a) = &self.x_axis {
            a.apply(&mut c.x_axis)?;
        }
        if let Some(a) = &self.y_axis {
            a.apply(&mut c.y_axis)?;
        }
        if let Some(p) = &self.data_label_position {
            c.data_label_position.clone_from(p);
        }
        for (i, f) in self.series_format.iter().flatten() {
            let kind = c.kind.clone();
            let s = c.series.get_mut(*i).ok_or_else(|| DrawingError::invalid(format!("the chart has no series {i}")))?;
            // Pies, doughnuts and radar charts take neither trendlines nor error bars.
            let own = s.kind.clone().unwrap_or_else(|| kind.clone());
            if (own.is_pie() || own == ChartKind::Radar) && (matches!(f.trendline, Some(Some(_))) || matches!(f.error_bars, Some(Some(_)))) {
                let property = if matches!(f.trendline, Some(Some(_))) { "trendline" } else { "errorBars" };
                return Err(DrawingError::unsupported(property, "pie, doughnut and radar series take neither trendlines nor error bars"));
            }
            f.apply(s);
            // A combination: series of a pie or doughnut, or of a radar chart, mix with no other type.
            let own = s.kind.clone().unwrap_or_else(|| kind.clone());
            if s.secondary && (own.is_pie() || own == ChartKind::Radar) {
                return Err(DrawingError::unsupported("secondary", "a pie, doughnut or radar series has no secondary axis"));
            }
            if s.kind.as_ref().is_some_and(|k| k.is_pie() || *k == ChartKind::Radar || matches!(k, ChartKind::Other(_))) {
                return Err(DrawingError::unsupported("chart.series.kind", "a series of a combination is a column, bar, line, area or scatter series"));
            }
        }
        // Every series has one value per category.
        let n = c.categories.len();
        for s in &mut c.series {
            s.values.resize(n, None);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_change_parses_and_applies() {
        let mut c = ChartSpec::sample(ChartKind::Column);
        c.series[0].color = Some(Color::theme("accent2"));
        let ch = ChartChange::parse(
            &json!({ "kind": "line", "title": null, "legend": "top", "categories": ["A", "B"], "series": [{ "name": "X", "values": [1, null] }] }),
        )
        .unwrap();
        ch.apply(&mut c).unwrap();
        assert_eq!((c.kind.clone(), c.title.clone(), c.legend), (ChartKind::Line, None, Some(LegendPos::Top)));
        assert_eq!(c.series.len(), 1);
        assert_eq!(c.series[0].values, vec![Some(1.0), None]);
        assert_eq!(c.series[0].color, Some(Color::theme("accent2")), "the series keeps its colour");
        // Fewer categories than values: values follow the categories.
        ChartChange::parse(&json!({ "categories": ["A"] })).unwrap().apply(&mut c).unwrap();
        assert_eq!(c.series[0].values, vec![Some(1.0)]);
    }

    #[test]
    fn bad_changes_are_refused() {
        assert_eq!(ChartChange::parse(&json!({})).unwrap_err().code, "invalid");
        assert_eq!(ChartChange::parse(&json!({ "kind": "hologram" })).unwrap_err().code, "unsupported");
        assert!(ChartChange::parse(&json!({ "series": [] })).is_err());
        assert!(ChartChange::parse(&json!({ "series": [{ "name": "a", "values": ["x"] }] })).is_err());
        assert!(ChartChange::parse(&json!({ "legend": "middle" })).is_err());
        let mut other = ChartSpec { kind: ChartKind::Other("stockChart".into()), ..Default::default() };
        assert_eq!(ChartChange::parse(&json!({ "kind": "pie" })).unwrap().apply(&mut other).unwrap_err().code, "unsupported");
    }

    #[test]
    fn axis_and_series_format_changes_parse_check_and_apply() {
        let mut c = ChartSpec::sample(ChartKind::Line);
        let change = ChartChange::parse(&json!({
            "yAxis": { "min": 0, "max": 100, "major": 20, "numberFormat": "0%" },
            "xAxis": { "hidden": true },
            "dataLabelPosition": "t",
            "seriesFormat": [{ "index": 1, "lineWidth": 3, "marker": "circle", "smooth": true, "color": "#FF0000" }]
        }))
        .unwrap();
        assert!(!change.touches_data(), "formatting is not data");
        change.apply(&mut c).unwrap();
        assert_eq!((c.y_axis.min, c.y_axis.max, c.y_axis.major, c.y_axis.number_format.as_deref()), (Some(0.0), Some(100.0), Some(20.0), Some("0%")));
        assert!(c.x_axis.hidden);
        assert_eq!(c.data_label_position.as_deref(), Some("t"));
        assert_eq!((c.series[1].line_width, c.series[1].marker.as_deref(), c.series[1].smooth), (Some(3.0), Some("circle"), true));
        // null returns a member to automatic; an axis's min stays below its max.
        ChartChange::parse(&json!({ "yAxis": { "max": null } })).unwrap().apply(&mut c).unwrap();
        assert_eq!(c.y_axis.max, None);
        assert!(ChartChange::parse(&json!({ "yAxis": { "min": 5, "max": 5 } })).is_err());
        assert!(
            ChartChange::parse(&json!({ "yAxis": { "min": 200 } }))
                .unwrap()
                .apply(&mut ChartSpec { y_axis: AxisSpec { max: Some(100.0), ..Default::default() }, ..c.clone() })
                .is_err()
        );
        assert!(ChartChange::parse(&json!({ "yAxis": { "major": 0 } })).is_err());
        assert!(ChartChange::parse(&json!({ "dataLabelPosition": "middle" })).is_err());
        assert!(ChartChange::parse(&json!({ "seriesFormat": [{ "index": 0, "marker": "heart" }] })).is_err());
        // A series' own type and axis; a pie series has no secondary axis.
        let mut combo = ChartSpec::sample(ChartKind::Column);
        ChartChange::parse(&json!({ "seriesFormat": [{ "index": 1, "kind": "line", "secondary": true }] })).unwrap().apply(&mut combo).unwrap();
        assert_eq!((combo.series[1].kind.clone(), combo.series[1].secondary), (Some(ChartKind::Line), true));
        assert!(ChartChange::parse(&json!({ "seriesFormat": [{ "index": 1, "kind": "pie" }] })).unwrap().apply(&mut combo).is_err());
        // Trendlines and error bars, by name or in full; pies refuse them.
        let mut lines = ChartSpec::sample(ChartKind::Line);
        ChartChange::parse(&json!({ "seriesFormat": [{ "index": 0, "trendline": "linear", "errorBars": { "kind": "fixedVal", "value": 0.5 } }] }))
            .unwrap()
            .apply(&mut lines)
            .unwrap();
        assert_eq!((lines.series[0].trendline.as_ref().unwrap().kind.as_str(), lines.series[0].error_bars.as_ref().unwrap().value), ("linear", Some(0.5)));
        ChartChange::parse(&json!({ "seriesFormat": [{ "index": 0, "trendline": null }] })).unwrap().apply(&mut lines).unwrap();
        assert_eq!(lines.series[0].trendline, None);
        assert!(ChartChange::parse(&json!({ "seriesFormat": [{ "index": 0, "trendline": "spline" }] })).is_err());
        assert!(ChartChange::parse(&json!({ "seriesFormat": [{ "index": 0, "trendline": { "kind": "poly", "order": 9 } }] })).is_err());
        let mut pie = ChartSpec::sample(ChartKind::Pie);
        let e = ChartChange::parse(&json!({ "seriesFormat": [{ "index": 0, "trendline": "linear" }] })).unwrap().apply(&mut pie).unwrap_err();
        assert_eq!(e.property.as_deref(), Some("trendline"));
        assert!(ChartChange::parse(&json!({ "seriesFormat": [{ "index": 9, "smooth": true }] })).unwrap().apply(&mut c).is_err());
        // A series given anew keeps its look unless given another.
        ChartChange::parse(&json!({ "series": [{ "name": "A", "values": [1, 2, 3] }, { "name": "B", "values": [3, 2, 1] }] })).unwrap().apply(&mut c).unwrap();
        assert_eq!((c.series[1].line_width, c.series[1].marker.as_deref()), (Some(3.0), Some("circle")));
    }
}
