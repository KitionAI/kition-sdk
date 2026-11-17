//! Bounded InkML trace decoding shared by Office document adapters.
//!
//! Syntax follows W3C InkML 3.2.1. XML, relationship resolution and unsupported-feature
//! fallback belong to the containing kit. This module neither opens files nor renders.

use kurbo::{BezPath, Point};

/// A conservative per-trace limit, shared with interactive ink.
pub const MAX_TRACE_POINTS: usize = super::MAX_POINTS;
const MAX_TRACE_BYTES: usize = 1_000_000;
const MAX_COORDINATE: f64 = 1_000_000_000.0;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TraceError {
    Limit,
    Syntax,
    InvalidDifference,
    NonFinite,
}

#[derive(Clone, Copy, Default)]
struct Channel {
    position: f64,
    velocity: f64,
    component: f64,
    mode: u8,
    initialized: bool,
    has_difference: bool,
}

impl Channel {
    fn sample(&mut self, prefix: Option<u8>, value: Option<f64>) -> Result<f64, TraceError> {
        if let Some(mode) = prefix {
            self.mode = mode;
        }
        let mode = if self.mode == 0 { b'!' } else { self.mode };
        if !self.initialized && (mode != b'!' || value.is_none()) {
            return Err(TraceError::InvalidDifference);
        }
        if mode == b'"' && !self.has_difference {
            return Err(TraceError::InvalidDifference);
        }
        let v = value.unwrap_or(self.component);
        match mode {
            b'!' => {
                self.position = v;
                self.velocity = 0.0;
                self.has_difference = false;
            }
            b'\'' => {
                self.velocity = v;
                self.position += v;
                self.has_difference = true;
            }
            b'"' => {
                self.velocity += v;
                self.position += self.velocity;
            }
            _ => return Err(TraceError::Syntax),
        }
        self.component = v;
        self.initialized = true;
        if !self.position.is_finite() || !self.velocity.is_finite() || self.position.abs() > MAX_COORDINATE {
            return Err(TraceError::NonFinite);
        }
        Ok(self.position)
    }
}

struct Tokens<'a> {
    text: &'a str,
    offset: usize,
}

impl Tokens<'_> {
    fn peek(&self) -> Option<u8> {
        self.text.as_bytes().get(self.offset).copied()
    }
    fn whitespace(&mut self) {
        while self.peek().is_some_and(|c| c.is_ascii_whitespace()) {
            self.offset += 1;
        }
    }
    fn number(&mut self) -> Result<Option<f64>, TraceError> {
        if self.peek() == Some(b'*') {
            self.offset += 1;
            return Ok(None);
        }
        let negative = self.peek() == Some(b'-');
        if negative {
            self.offset += 1;
            self.whitespace();
        }
        let start = self.offset;
        let mut digits = 0;
        while self.peek().is_some_and(|c| c.is_ascii_digit()) {
            self.offset += 1;
            digits += 1;
        }
        if self.peek() == Some(b'.') {
            self.offset += 1;
            while self.peek().is_some_and(|c| c.is_ascii_digit()) {
                self.offset += 1;
                digits += 1;
            }
        }
        if digits == 0 {
            return Err(TraceError::Syntax);
        }
        if matches!(self.peek(), Some(b'e' | b'E')) {
            self.offset += 1;
            if matches!(self.peek(), Some(b'+' | b'-')) {
                self.offset += 1;
            }
            let exponent = self.offset;
            while self.peek().is_some_and(|c| c.is_ascii_digit()) {
                self.offset += 1;
            }
            if self.offset == exponent {
                return Err(TraceError::Syntax);
            }
        }
        if self.offset - start > 64 {
            return Err(TraceError::Limit);
        }
        let v = self.text.get(start..self.offset).and_then(|s| s.parse::<f64>().ok()).filter(|v| v.is_finite()).ok_or(TraceError::NonFinite)?;
        Ok(Some(if negative { -v } else { v }))
    }
}

/// Decode a two-channel trace. The adapter validates the channels and their units first.
/// Channel modes persist independently; adjacent signed values need no whitespace.
/// Unsupported booleans, intermittent channels and malformed points return an error.
pub fn decode_xy(text: &str, y_first: bool) -> Result<Vec<Point>, TraceError> {
    if text.len() > MAX_TRACE_BYTES {
        return Err(TraceError::Limit);
    }
    let mut tokens = Tokens { text, offset: 0 };
    let mut channels = [Channel::default(); 2];
    let mut out = Vec::new();
    tokens.whitespace();
    if tokens.peek().is_none() {
        return Err(TraceError::Syntax);
    }
    loop {
        if out.len() >= MAX_TRACE_POINTS {
            return Err(TraceError::Limit);
        }
        let mut xy = [0.0; 2];
        for (channel, value) in channels.iter_mut().zip(xy.iter_mut()) {
            tokens.whitespace();
            let prefix = match tokens.peek() {
                Some(c @ (b'!' | b'\'' | b'"')) => {
                    tokens.offset += 1;
                    Some(c)
                }
                _ => None,
            };
            tokens.whitespace();
            let component = tokens.number()?;
            // A wildcard is a separate grammar alternative, not a prefixed number.
            if prefix.is_some() && component.is_none() {
                return Err(TraceError::Syntax);
            }
            *value = channel.sample(prefix, component)?;
        }
        let [a, b] = xy;
        out.push(if y_first { Point::new(b, a) } else { Point::new(a, b) });
        tokens.whitespace();
        match tokens.peek() {
            None => return Ok(out),
            Some(b',') => {
                tokens.offset += 1;
                tokens.whitespace();
                // InkML allows a single optional comma after the final point.
                if tokens.peek().is_none() {
                    return Ok(out);
                }
            }
            _ => return Err(TraceError::Syntax),
        }
    }
}

/// Physical brush dimensions use W3C length units, independent of the sample coordinates.
pub fn length_in_points(value: f64, unit: &str) -> Option<f64> {
    let factor = match unit {
        "in" => 72.0,
        "cm" => 72.0 / 2.54,
        "mm" => 72.0 / 25.4,
        "pt" => 1.0,
        "pc" => 12.0,
        _ => return None,
    };
    let length = value * factor;
    (length.is_finite() && length > 0.0 && length <= super::MAX_WIDTH).then_some(length)
}

/// Fit sample positions to an Office content-part frame without changing the brush width.
/// A zero-extent source axis remains centered; a single-point trace remains a drawable dot.
/// Office ink object transforms keep physical brush size separate from sample placement.
pub fn fitted_center_line(points: &[Point], width: f64, height: f64) -> Option<BezPath> {
    if points.is_empty()
        || points.len() > MAX_TRACE_POINTS
        || ![width, height].into_iter().all(|v| v.is_finite() && (0.0..=crate::ops::MAX_LENGTH).contains(&v))
        || points.iter().any(|p| !p.is_finite() || p.x.abs().max(p.y.abs()) > MAX_COORDINATE)
    {
        return None;
    }
    let first = *points.first()?;
    let bounds = points.iter().fold(kurbo::Rect::from_points(first, first), |b, p| b.union_pt(*p));
    let fit = |v: f64, start: f64, extent: f64, dest: f64| if extent > 0.0 { (v - start) / extent * dest } else { dest / 2.0 };
    let mut path = BezPath::new();
    for (i, p) in points.iter().enumerate() {
        let point = Point::new(fit(p.x, bounds.x0, bounds.width(), width), fit(p.y, bounds.y0, bounds.height(), height));
        if i == 0 {
            path.move_to(point);
        } else {
            path.line_to(point);
        }
    }
    if points.len() == 1 {
        path.line_to(Point::new(width / 2.0, height / 2.0));
    }
    Some(path)
}

#[cfg(test)]
mod tests;
