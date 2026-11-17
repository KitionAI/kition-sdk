//! Line callouts: independent box borders, accent lines and adjustable leaders.

use super::*;

pub(super) fn build(name: &str, w: f64, h: f64, adjustment: impl Fn(usize) -> f64) -> Geometry {
    let count = match name.as_bytes().last() {
        Some(b'3') => 4,
        Some(b'2') => 3,
        _ => 2,
    };
    let border = name.starts_with("border") || name.starts_with("accentBorder");
    let accent = name.starts_with("accent");
    let rectangle = corner_rect(w, h, [Corner::Square; 4]);
    let mut paths = vec![if border { fill(rectangle) } else { fill_only(rectangle) }];
    let mut leader = Pb::new();
    for i in 0..count {
        let (x, y) = (w * adjustment(i * 2 + 1) / 1e5, h * adjustment(i * 2) / 1e5);
        if i == 0 {
            leader.m(x, y);
        } else {
            leader.l(x, y);
        }
    }
    paths.push(stroke_only(leader.take()));
    if accent {
        let x = w * adjustment(1) / 1e5;
        paths.push(stroke_only(Pb::new().m(x, 0.0).l(x, h).take()));
    }
    Geometry { paths, text_rect: Rect::new(0.0, 0.0, w, h), handles: vec![], sites: mid_sites(w, h) }
}

#[cfg(test)]
mod tests {
    use super::*;
    use kurbo::PathEl;

    #[test]
    fn line_callout_variants_keep_border_accent_and_leader_independent() {
        for prefix in ["callout", "borderCallout", "accentCallout", "accentBorderCallout"] {
            for bends in 1..=3 {
                let geometry = super::super::build(&format!("{prefix}{bends}"), 200.0, 100.0, &[]).unwrap();
                let border = prefix.contains("border") || prefix.contains("Border");
                let accent = prefix.starts_with("accent");
                assert_eq!(geometry.paths[0].stroke, border);
                assert_eq!(geometry.paths.len(), if accent { 3 } else { 2 });
                assert_eq!(geometry.paths[1].fill, FillMode::None);
                assert_eq!(geometry.paths[1].path.elements().iter().filter(|element| matches!(element, PathEl::LineTo(_))).count(), bends);
                assert_eq!(geometry.text_rect, Rect::new(0.0, 0.0, 200.0, 100.0));
            }
        }
    }

    #[test]
    fn adjusted_leader_and_accent_follow_the_first_control_point() {
        let geometry = super::super::build("accentBorderCallout2", 200.0, 100.0, &[25000.0, 75000.0, 50000.0, 125000.0, 150000.0, 150000.0]).unwrap();
        assert_eq!(geometry.paths[1].path.elements()[0], PathEl::MoveTo(Point::new(150.0, 25.0)));
        assert_eq!(geometry.paths[1].path.elements()[2], PathEl::LineTo(Point::new(300.0, 150.0)));
        assert_eq!(geometry.paths[2].path.elements()[0], PathEl::MoveTo(Point::new(150.0, 0.0)));
        assert_eq!(geometry.paths[2].path.elements()[1], PathEl::LineTo(Point::new(150.0, 100.0)));
    }
}
