//! Orthogonal connectors whose successive adjustments place alternating x/y bends.

use super::*;

pub(super) fn bent(five_segments: bool, w: f64, h: f64, adj1: f64, adj2: f64, adj3: f64) -> Geometry {
    let x1 = w * (adj1 / 100000.0);
    let y2 = h * (adj2 / 100000.0);
    let x3 = if five_segments { w * (adj3 / 100000.0) } else { w };
    let mut path = Pb::new();
    path.m(0.0, 0.0).l(x1, 0.0).l(x1, y2).l(x3, y2).l(x3, h);
    if five_segments {
        path.l(w, h);
    }
    let mut handles = vec![
        Handle::new(0, Point::new(0.0, y2 / 2.0), Vec2::new(w / 100000.0, 0.0), adj1, -1e6, 1e6),
        Handle::new(1, Point::new(x1 / 2.0 + x3 / 2.0, 0.0), Vec2::new(0.0, h / 100000.0), adj2, -1e6, 1e6),
    ];
    if five_segments {
        handles.push(Handle::new(2, Point::new(0.0, y2 / 2.0 + h / 2.0), Vec2::new(w / 100000.0, 0.0), adj3, -1e6, 1e6));
    }
    Geometry { paths: vec![stroke_only(path.take())], text_rect: Rect::new(0.0, 0.0, w, h), handles, sites: vec![Point::ZERO, Point::new(w, h)] }
}

#[cfg(test)]
mod tests {
    use super::*;
    use kurbo::{ParamCurve, PathEl};

    #[test]
    fn four_segment_connector_preserves_an_external_bend_and_vertical_finish() {
        let geometry = build("bentConnector4", 200.0, 80.0, &[-25000.0, 75000.0]).unwrap();
        let path = &geometry.paths[0].path;
        assert_eq!(
            path.elements(),
            &[
                PathEl::MoveTo(Point::ZERO),
                PathEl::LineTo(Point::new(-50.0, 0.0)),
                PathEl::LineTo(Point::new(-50.0, 60.0)),
                PathEl::LineTo(Point::new(200.0, 60.0)),
                PathEl::LineTo(Point::new(200.0, 80.0)),
            ]
        );
        assert!(geometry.is_open());
        assert!(geometry.paths[0].stroke);
        assert_eq!(geometry.sites, vec![Point::ZERO, Point::new(200.0, 80.0)]);
    }

    #[test]
    fn five_segment_connector_uses_all_guides_and_handles_independently() {
        let adjustments = [20000.0, -25000.0, 125000.0];
        let geometry = build("bentConnector5", 80.0, 200.0, &adjustments).unwrap();
        let segments: Vec<_> = geometry.paths[0].path.segments().collect();
        assert_eq!(segments.len(), 5);
        assert_eq!(segments[2].start(), Point::new(16.0, -50.0));
        assert_eq!(segments[2].end(), Point::new(100.0, -50.0));
        assert_eq!(segments[4].start(), Point::new(100.0, 200.0));
        assert_eq!(segments[4].end(), Point::new(80.0, 200.0));
        for (i, segment) in segments.iter().enumerate() {
            let delta = segment.end() - segment.start();
            assert_eq!(if i % 2 == 0 { delta.y } else { delta.x }, 0.0);
        }
        assert_eq!(geometry.handles.len(), 3);
        for (handle, adjustment) in geometry.handles.iter().zip(adjustments) {
            assert!((handle.value_at(handle.pos) - adjustment).abs() < 1e-6);
            assert!((handle.value_at(handle.pos + handle.dir * 1000.0) - adjustment - 1000.0).abs() < 1e-6);
        }
    }

    #[test]
    fn omitted_connector_guides_use_midpoint_defaults() {
        for name in ["bentConnector4", "bentConnector5"] {
            let partial = build(name, 200.0, 80.0, &[25000.0]).unwrap();
            let explicit = build(name, 200.0, 80.0, &[25000.0, 50000.0, 50000.0]).unwrap();
            assert_eq!(partial.paths[0].path, explicit.paths[0].path);
            assert_eq!(partial.handles[1].pos.y, 40.0);
        }
    }

    #[test]
    fn extreme_finite_guides_and_collapsed_extents_keep_finite_coordinates() {
        for name in ["bentConnector4", "bentConnector5"] {
            for (w, h) in [(240.0, 160.0), (0.0, 160.0), (240.0, 0.0), (0.0, 0.0)] {
                let geometry = build(name, w, h, &[-f64::MAX, f64::MAX, f64::MAX]).unwrap();
                for segment in geometry.paths[0].path.segments() {
                    for point in [segment.start(), segment.end()] {
                        assert!(point.x.is_finite() && point.y.is_finite());
                    }
                }
                for handle in &geometry.handles {
                    assert!(handle.pos.x.is_finite() && handle.pos.y.is_finite());
                }
            }
        }
    }
}
