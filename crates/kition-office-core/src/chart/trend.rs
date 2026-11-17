//! Trendlines and error bars computed from a series' points: the regressions Office fits
//! (`ST_TrendlineType`) and the error amounts it draws (`ST_ErrValType`), so every kit draws the
//! same curve and the same bars.

use super::{ErrorBars, Trendline};

/// Least squares of `ys` on the columns of `rows` (each a point's regressors): the
/// coefficients, or `None` when the system is singular or the points too few.
#[allow(clippy::needless_range_loop)] // Matrix arithmetic reads clearest by index.
fn least_squares(rows: &[Vec<f64>], ys: &[f64]) -> Option<Vec<f64>> {
    let n = rows.first()?.len();
    if rows.len() < n || n == 0 {
        return None;
    }
    // Normal equations, solved by Gaussian elimination with partial pivoting.
    let mut a = vec![vec![0.0; n + 1]; n];
    for (r, y) in rows.iter().zip(ys) {
        for i in 0..n {
            for j in 0..n {
                a[i][j] += r[i] * r[j];
            }
            a[i][n] += r[i] * y;
        }
    }
    for col in 0..n {
        let pivot = (col..n).max_by(|&x, &y| a[x][col].abs().total_cmp(&a[y][col].abs()))?;
        if a[pivot][col].abs() < 1e-12 {
            return None;
        }
        a.swap(col, pivot);
        for row in 0..n {
            if row != col {
                let f = a[row][col] / a[col][col];
                for k in col..=n {
                    a[row][k] -= f * a[col][k];
                }
            }
        }
    }
    let out: Vec<f64> = (0..n).map(|i| a[i][n] / a[i][i]).collect();
    out.iter().all(|c| c.is_finite()).then_some(out)
}

/// The fitted curve of trendline `t` through `points` (x, y), as a function of x; `None` for a
/// moving average (see [`moving_average`]) or when it cannot be fitted (too few points, or
/// logarithms of values at or below zero).
pub fn fit(t: &Trendline, points: &[(f64, f64)]) -> Option<Box<dyn Fn(f64) -> f64>> {
    let pts: Vec<(f64, f64)> = points.iter().copied().filter(|(x, y)| x.is_finite() && y.is_finite()).collect();
    if pts.len() < 2 {
        return None;
    }
    let xs: Vec<f64> = pts.iter().map(|p| p.0).collect();
    let ys: Vec<f64> = pts.iter().map(|p| p.1).collect();
    match t.kind.as_str() {
        "linear" => {
            let c = least_squares(&xs.iter().map(|x| vec![1.0, *x]).collect::<Vec<_>>(), &ys)?;
            Some(Box::new(move |x| c[0] + c[1] * x))
        }
        "poly" => {
            let order = t.order.unwrap_or(2).clamp(2, 6) as i32;
            let c = least_squares(&xs.iter().map(|x| (0..=order).map(|k| x.powi(k)).collect()).collect::<Vec<_>>(), &ys)?;
            Some(Box::new(move |x| c.iter().enumerate().map(|(k, a)| a * x.powi(k as i32)).sum()))
        }
        // y = a·e^(bx): ln y on x.
        "exp" => {
            if ys.iter().any(|y| *y <= 0.0) {
                return None;
            }
            let c = least_squares(&xs.iter().map(|x| vec![1.0, *x]).collect::<Vec<_>>(), &ys.iter().map(|y| y.ln()).collect::<Vec<_>>())?;
            Some(Box::new(move |x| (c[0] + c[1] * x).exp()))
        }
        // y = a + b·ln x.
        "log" => {
            if xs.iter().any(|x| *x <= 0.0) {
                return None;
            }
            let c = least_squares(&xs.iter().map(|x| vec![1.0, x.ln()]).collect::<Vec<_>>(), &ys)?;
            Some(Box::new(move |x| if x > 0.0 { c[0] + c[1] * x.ln() } else { f64::NAN }))
        }
        // y = a·x^b: ln y on ln x.
        "power" => {
            if xs.iter().any(|x| *x <= 0.0) || ys.iter().any(|y| *y <= 0.0) {
                return None;
            }
            let c = least_squares(&xs.iter().map(|x| vec![1.0, x.ln()]).collect::<Vec<_>>(), &ys.iter().map(|y| y.ln()).collect::<Vec<_>>())?;
            Some(Box::new(move |x| if x > 0.0 { (c[0] + c[1] * x.ln()).exp() } else { f64::NAN }))
        }
        _ => None,
    }
}

/// A moving average of `points` over `period` (at least 2): each point from the period-th on,
/// the mean of it and the ones before.
pub fn moving_average(points: &[(f64, f64)], period: u32) -> Vec<(f64, f64)> {
    let p = (period as usize).max(2);
    points.windows(p).map(|w| (w[p - 1].0, w.iter().map(|q| q.1).sum::<f64>() / p as f64)).collect()
}

/// Trendline `t` through `points` as a polyline to draw: the fitted curve sampled from the
/// first x less `backward` to the last plus `forward` (`steps` segments), or the moving average.
pub fn polyline(t: &Trendline, points: &[(f64, f64)], steps: usize) -> Vec<(f64, f64)> {
    if t.kind == "movingAvg" {
        return moving_average(points, t.period.unwrap_or(2));
    }
    let Some(f) = fit(t, points) else { return Vec::new() };
    let finite = points.iter().filter(|(x, y)| x.is_finite() && y.is_finite());
    let (lo, hi) = finite.fold((f64::INFINITY, f64::NEG_INFINITY), |(lo, hi), (x, _)| (lo.min(*x), hi.max(*x)));
    let (lo, hi) = (lo - t.backward.unwrap_or(0.0), hi + t.forward.unwrap_or(0.0));
    let steps = if t.kind == "linear" { 1 } else { steps.max(1) };
    (0..=steps).map(|i| lo + (hi - lo) * i as f64 / steps as f64).map(|x| (x, f(x))).filter(|(_, y)| y.is_finite()).collect()
}

/// Error bars `e` on a series of `values`: each value's low and high ends (`None` for a gap).
/// Standard deviation bars stand around the series' mean, as Office draws them.
pub fn error_ends(e: &ErrorBars, values: &[Option<f64>]) -> Vec<Option<(f64, f64)>> {
    let present: Vec<f64> = values.iter().flatten().copied().filter(|v| v.is_finite()).collect();
    let n = present.len() as f64;
    let mean = if n > 0.0 { present.iter().sum::<f64>() / n } else { 0.0 };
    let sd = if n > 1.0 { (present.iter().map(|v| (v - mean).powi(2)).sum::<f64>() / (n - 1.0)).sqrt() } else { 0.0 };
    values
        .iter()
        .map(|v| {
            let v = (*v).filter(|v| v.is_finite())?;
            Some(match e.kind.as_str() {
                "fixedVal" => {
                    let d = e.value.unwrap_or(1.0);
                    (v - d, v + d)
                }
                "percentage" => {
                    let d = v.abs() * e.value.unwrap_or(5.0) / 100.0;
                    (v - d, v + d)
                }
                "stdDev" => {
                    let d = sd * e.value.unwrap_or(1.0);
                    (mean - d, mean + d)
                }
                "stdErr" => {
                    let d = if n > 0.0 { sd / n.sqrt() } else { 0.0 };
                    (v - d, v + d)
                }
                _ => (v, v),
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn t(kind: &str) -> Trendline {
        Trendline { kind: kind.into(), ..Default::default() }
    }

    #[test]
    fn regressions_recover_their_curves() {
        let line: Vec<(f64, f64)> = (1..=5).map(|x| (x as f64, 2.0 * x as f64 + 1.0)).collect();
        let f = fit(&t("linear"), &line).unwrap();
        assert!((f(10.0) - 21.0).abs() < 1e-9);
        let quad: Vec<(f64, f64)> = (1..=6).map(|x| (x as f64, (x * x) as f64 - 3.0)).collect();
        let f = fit(&Trendline { order: Some(2), ..t("poly") }, &quad).unwrap();
        assert!((f(7.0) - 46.0).abs() < 1e-6);
        let exp: Vec<(f64, f64)> = (0..5).map(|x| (x as f64, 3.0 * (0.5 * x as f64).exp())).collect();
        assert!((fit(&t("exp"), &exp).unwrap()(6.0) - 3.0 * 3.0f64.exp()).abs() < 1e-6);
        let pow: Vec<(f64, f64)> = (1..6).map(|x| (x as f64, 2.0 * (x as f64).powf(1.5))).collect();
        assert!((fit(&t("power"), &pow).unwrap()(9.0) - 54.0).abs() < 1e-6);
        let log: Vec<(f64, f64)> = (1..6).map(|x| (x as f64, 1.0 + 2.0 * (x as f64).ln())).collect();
        assert!((fit(&t("log"), &log).unwrap()(std::f64::consts::E) - 3.0).abs() < 1e-9);
        // Logarithms of values at or below zero do not fit; one point does not either.
        assert!(fit(&t("exp"), &[(1.0, -1.0), (2.0, 3.0)]).is_none());
        assert!(fit(&t("linear"), &[(1.0, 1.0)]).is_none());
    }

    #[test]
    fn polylines_run_past_the_data_and_moving_averages_lag() {
        let pts: Vec<(f64, f64)> = (1..=4).map(|x| (x as f64, x as f64)).collect();
        let p = polyline(&Trendline { forward: Some(2.0), backward: Some(0.5), ..t("linear") }, &pts, 20);
        assert_eq!(p.len(), 2);
        assert!((p[0].0 - 0.5).abs() < 1e-9 && (p[1].0 - 6.0).abs() < 1e-9 && (p[1].1 - 6.0).abs() < 1e-9);
        assert_eq!(polyline(&Trendline { order: Some(3), ..t("poly") }, &pts, 20).len(), 21);
        let ma = polyline(&Trendline { period: Some(2), ..t("movingAvg") }, &[(1.0, 2.0), (2.0, 4.0), (3.0, 8.0)], 20);
        assert_eq!(ma, vec![(2.0, 3.0), (3.0, 6.0)]);
    }

    #[test]
    fn error_bars_measure_as_office_does() {
        let v = [Some(2.0), None, Some(4.0), Some(6.0)];
        let ends = |kind: &str, value: Option<f64>| error_ends(&ErrorBars { kind: kind.into(), value }, &v);
        assert_eq!(ends("fixedVal", Some(0.5))[0], Some((1.5, 2.5)));
        assert_eq!(ends("fixedVal", None)[1], None, "a gap has none");
        let (lo, hi) = ends("percentage", Some(10.0))[3].unwrap();
        assert!((lo - 5.4).abs() < 1e-12 && (hi - 6.6).abs() < 1e-12);
        // Mean 4, sample deviation 2: standard deviation bars stand around the mean.
        assert_eq!(ends("stdDev", None)[0], Some((2.0, 6.0)));
        let se = 2.0 / 3f64.sqrt();
        let (lo, hi) = ends("stdErr", None)[2].unwrap();
        assert!((lo - (4.0 - se)).abs() < 1e-12 && (hi - (4.0 + se)).abs() < 1e-12);
    }
}
