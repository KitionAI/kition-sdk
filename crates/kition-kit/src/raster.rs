//! Contract-exact `render` and `render_area` from one full-resolution frame, for engines that
//! render a whole picture at a time (a video frame, a slide, a page). Pixels are straight-alpha
//! RGBA8, row-major, `width × height × 4` bytes.

/// A full-resolution frame the helpers read from.
#[derive(Clone, Copy)]
pub struct Frame<'a> {
    pub rgba: &'a [u8],
    pub width: u32,
    pub height: u32,
}

impl Frame<'_> {
    fn pixel(&self, x: i64, y: i64) -> [u8; 4] {
        if x < 0 || y < 0 || x >= i64::from(self.width) || y >= i64::from(self.height) {
            return [0; 4];
        }
        let at = (y as usize * self.width as usize + x as usize) * 4;
        match self.rgba.get(at..at + 4) {
            Some(px) => [px[0], px[1], px[2], px[3]],
            None => [0; 4],
        }
    }
}

/// [`crate::KitDocument::render`]: the area at (`x`, `y`) shown at `scale` screen pixels per
/// pixel. Below 1 each output pixel is the mean of the pixels it covers; above 1 pixels repeat.
pub fn render(frame: Frame<'_>, x: f64, y: f64, scale: f64, width: u32, height: u32) -> Vec<u8> {
    let scale = if scale.is_finite() && scale > 0.0 { scale } else { 1.0 };
    let (width, height) = (width.clamp(1, crate::MAX_RENDER_SIDE), height.clamp(1, crate::MAX_RENDER_SIDE));
    if scale >= 1.0 {
        let mut out = Vec::with_capacity(width as usize * height as usize * 4);
        for row in 0..height {
            let sy = (y + f64::from(row) / scale).floor() as i64;
            for col in 0..width {
                let sx = (x + f64::from(col) / scale).floor() as i64;
                out.extend(frame.pixel(sx, sy));
            }
        }
        return out;
    }
    let x0 = x.floor() as i32;
    let y0 = y.floor() as i32;
    let span_x = ((f64::from(width) / scale).ceil() as i32).max(1);
    let span_y = ((f64::from(height) / scale).ceil() as i32).max(1);
    render_area(frame, x0, y0, x0.saturating_add(span_x), y0.saturating_add(span_y), width, height)
}

/// [`crate::KitDocument::render_area`]: the integer area (`x0`, `y0`)–(`x1`, `y1`) averaged to
/// exactly `width × height`. Output pixel `t` covers source `[t·span/n, (t+1)·span/n)`, so a
/// whole-number reduction is the exact box mean.
pub fn render_area(frame: Frame<'_>, x0: i32, y0: i32, x1: i32, y1: i32, width: u32, height: u32) -> Vec<u8> {
    let (width, height) = (width.clamp(1, crate::MAX_RENDER_SIDE), height.clamp(1, crate::MAX_RENDER_SIDE));
    let span_x = i64::from(x1.saturating_sub(x0)).max(1);
    let span_y = i64::from(y1.saturating_sub(y0)).max(1);
    let (n, m) = (i64::from(width), i64::from(height));
    let edges = |t: i64, span: i64, count: i64| {
        let a = t * span / count;
        (a, ((t + 1) * span / count).max(a + 1))
    };
    let mut out = Vec::with_capacity(width as usize * height as usize * 4);
    for row in 0..m {
        let (sy0, sy1) = edges(row, span_y, m);
        for col in 0..n {
            let (sx0, sx1) = edges(col, span_x, n);
            let mut sum = [0u64; 4];
            for sy in sy0..sy1 {
                for sx in sx0..sx1 {
                    let px = frame.pixel(i64::from(x0) + sx, i64::from(y0) + sy);
                    for (total, value) in sum.iter_mut().zip(px) {
                        *total += u64::from(value);
                    }
                }
            }
            let count = ((sx1 - sx0) * (sy1 - sy0)).max(1) as u64;
            out.extend(sum.map(|total| ((total + count / 2) / count) as u8));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn gradient(w: u32, h: u32) -> Vec<u8> {
        (0..w * h).flat_map(|i| [(i % 256) as u8, (i / 3 % 256) as u8, 7, 255]).collect()
    }

    #[test]
    fn whole_number_reductions_are_box_means() {
        let rgba = gradient(8, 6);
        let frame = Frame { rgba: &rgba, width: 8, height: 6 };
        let reduced = render_area(frame, 0, 0, 8, 6, 4, 3);
        let mean = (u32::from(rgba[0]) + u32::from(rgba[4]) + u32::from(rgba[32]) + u32::from(rgba[36]) + 2) / 4;
        assert_eq!(u32::from(reduced[0]), mean);
        assert_eq!(reduced.len(), 4 * 3 * 4);
        assert_eq!(render(frame, 0.0, 0.0, 0.5, 4, 3), reduced);
    }

    #[test]
    fn one_to_one_and_enlarged_repeat_pixels() {
        let rgba = gradient(4, 4);
        let frame = Frame { rgba: &rgba, width: 4, height: 4 };
        assert_eq!(render(frame, 0.0, 0.0, 1.0, 4, 4), rgba);
        let big = render(frame, 1.0, 1.0, 2.0, 4, 4);
        assert_eq!(&big[..4], &rgba[(4 + 1) * 4..(4 + 1) * 4 + 4]);
        assert_eq!(&big[4..8], &big[..4], "pixels repeat when enlarged");
        assert_eq!(&render(frame, -2.0, 0.0, 1.0, 1, 1)[..], &[0, 0, 0, 0], "outside is transparent");
    }
}
