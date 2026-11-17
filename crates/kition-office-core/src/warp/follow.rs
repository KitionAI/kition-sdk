//! Single-path WordArt geometry. Unlike a two-path envelope, this path locates shaped
//! clusters; it does not deform points within a glyph. Font layout remains in the kit.
//!
//! Arc start/sweep and radii follow ECMA-376 Part 1 Annex D's textArchUp/textArchDown
//! definitions. Two-path envelope mappings use a separate placement contract.

use kurbo::{Point, Vec2};

const STEPS: usize = 256;
const TURN: f64 = 21_600_000.0;

/// A point on a single-path warp and its unit tangent in reading-path direction.
#[derive(Clone, Copy, Debug)]
pub struct PathSample {
    pub point: Point,
    pub tangent: Vec2,
}

/// A finite elliptical guide path with a bounded arc-length lookup table.
/// Coordinates are local to the supplied box; no font size or device transform is applied.
#[derive(Clone, Debug)]
pub struct FollowPath {
    center: Point,
    radii: Vec2,
    start: f64,
    sweep: f64,
    lengths: Vec<f64>,
}

impl FollowPath {
    /// Build only the independently verified single-path ArchUp/ArchDown presets.
    /// Other presets return None so callers retain their existing rendering behavior.
    pub fn from_preset(preset: &str, adjust: &[(String, f64)], width: f64, height: f64) -> Option<Self> {
        if !matches!(preset, "textArchUp" | "textArchDown") || !width.is_finite() || !height.is_finite() || width <= 0.0 || height <= 0.0 {
            return None;
        }
        let default = if preset == "textArchUp" { TURN / 2.0 } else { 0.0 };
        // These single-path definitions use adj, not the Pour presets' adj1/adj2.
        let a = adjust.iter().find(|(name, v)| name == "adj" && v.is_finite()).map_or(default, |(_, v)| *v).clamp(0.0, TURN - 1.0);
        let v1 = TURN / 2.0 - a;
        let v2 = TURN * 1.5 - a;
        let w1 = TURN / 4.0 - a;
        let w2 = TURN * 0.75 - a;
        let (start, sweep) = if preset == "textArchUp" {
            let end = if v1 > 0.0 { v1 } else { v2 };
            let d1 = end - a;
            let d2 = TURN + d1;
            let c2 = if w2 > 0.0 { d1 } else { d2 };
            let c1 = if v1 > 0.0 { d2 } else { c2 };
            (a, if w1 > 0.0 { d1 } else { c1 })
        } else {
            let start = if -v1 > 0.0 { v2 } else { v1 };
            let d1 = a - start;
            let d2 = d1 - TURN;
            let c2 = if w2 > 0.0 { d1 } else { d2 };
            let c1 = if v1 > 0.0 { d2 } else { c2 };
            let c0 = if w1 > 0.0 { d1 } else { c1 };
            (start, if start > 0.0 { c0 } else { -TURN / 2.0 })
        };
        let radii = Vec2::new(width / 2.0, height / 2.0);
        // DrawingML angles are radial bearings. Convert to ellipse parameters before
        // measuring arc length; equal angular steps are not equal distances on an ellipse.
        let parameter = |angle: f64| {
            let angle = angle / TURN * std::f64::consts::TAU;
            let p = (radii.x * angle.sin()).atan2(radii.y * angle.cos());
            p + ((angle - p) / std::f64::consts::TAU).round() * std::f64::consts::TAU
        };
        let t0 = parameter(start);
        let t1 = parameter(start + sweep);
        let mut path = Self { center: Point::new(radii.x, radii.y), radii, start: t0, sweep: t1 - t0, lengths: Vec::with_capacity(STEPS + 1) };
        if !path.sweep.is_finite() || path.sweep.abs() < 1e-12 {
            return None;
        }
        path.lengths.push(0.0);
        let mut length = 0.0;
        for i in 0..STEPS {
            length += path.integral(i as f64 / STEPS as f64, (i + 1) as f64 / STEPS as f64);
            path.lengths.push(length);
        }
        (length.is_finite() && length > 0.0).then_some(path)
    }

    /// Total path length in the box's units.
    pub fn length(&self) -> f64 {
        self.lengths.last().copied().unwrap_or(0.0)
    }

    fn speed(&self, u: f64) -> f64 {
        let t = self.start + self.sweep * u;
        (self.radii.x * t.sin()).hypot(self.radii.y * t.cos()) * self.sweep.abs()
    }

    fn integral(&self, a: f64, b: f64) -> f64 {
        (b - a) / 6.0 * (self.speed(a) + 4.0 * self.speed((a + b) / 2.0) + self.speed(b))
    }

    /// Sample by distance along the path. Out-of-range finite positions extend along
    /// the endpoint tangent, preserving overflow advances without stacking clusters.
    pub fn sample(&self, distance: f64) -> Option<PathSample> {
        if !distance.is_finite() {
            return None;
        }
        let length = self.length();
        let d = distance.clamp(0.0, length);
        let upper = self.lengths.partition_point(|v| *v < d).clamp(1, STEPS);
        let lower = upper - 1;
        let a = lower as f64 / STEPS as f64;
        let mut lo = a;
        let mut hi = upper as f64 / STEPS as f64;
        let base = *self.lengths.get(lower)?;
        for _ in 0..24 {
            let mid = (lo + hi) / 2.0;
            if base + self.integral(a, mid) < d {
                lo = mid;
            } else {
                hi = mid;
            }
        }
        let u = if d == 0.0 {
            0.0
        } else if d == length {
            1.0
        } else {
            (lo + hi) / 2.0
        };
        let t = self.start + self.sweep * u;
        let v = Vec2::new(-self.radii.x * t.sin(), self.radii.y * t.cos()) * self.sweep.signum();
        let norm = v.hypot();
        if !norm.is_finite() || norm <= 0.0 {
            return None;
        }
        let tangent = v / norm;
        let point = self.center + Vec2::new(self.radii.x * t.cos(), self.radii.y * t.sin()) + tangent * (distance - d);
        point.is_finite().then_some(PathSample { point, tangent })
    }
}

#[cfg(test)]
mod tests;
