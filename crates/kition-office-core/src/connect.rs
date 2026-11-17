//! Connectors (`KitDrawing 1.4`, DR25): lines whose ends are glued to other objects' connection
//! sites, and follow them when those objects move.
//!
//! A kit keeps each end's object and site, and after any change that moves an object it calls
//! [`reroute`] for the connectors glued to it, writing the frames it answers in the same
//! transaction.

use kurbo::Point;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::geom::Xfrm;
use crate::model::DrawingObject;
use crate::ops::{DrawingError, Result};

/// Connector presets `drawing.connect` makes.
pub const CONNECTORS: [&str; 3] = ["straightConnector1", "bentConnector3", "curvedConnector3"];

/// One glued end: the object and its connection site (an index into its geometry's sites).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct End {
    pub id: String,
    pub site: usize,
}

/// A connector's glued ends; an end left free is `None`.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct Connection {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub start: Option<End>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub end: Option<End>,
}

/// The connection sites of object `o` where they are, in its frame's space.
pub fn sites(o: &DrawingObject) -> Vec<Point> {
    let a = o.frame.affine();
    crate::edit::outline(o).sites.into_iter().map(|p| a * p).collect()
}

/// The pair of sites, one of `a`'s and one of `b`'s, closest together (`None` if either has none).
pub fn nearest(a: &[Point], b: &[Point]) -> Option<(usize, usize)> {
    let mut best: Option<(f64, usize, usize)> = None;
    for (i, p) in a.iter().enumerate() {
        for (j, q) in b.iter().enumerate() {
            let d = (*p - *q).hypot2();
            if best.is_none_or(|(bd, _, _)| d < bd) {
                best = Some((d, i, j));
            }
        }
    }
    best.map(|(_, i, j)| (i, j))
}

/// The frame of a line from `p0` to `p1`: their bounds, flipped so its start is at `p0`.
pub fn line_frame(p0: Point, p1: Point) -> Xfrm {
    Xfrm { x: p0.x.min(p1.x), y: p0.y.min(p1.y), w: (p1.x - p0.x).abs(), h: (p1.y - p0.y).abs(), rot: 0.0, flip_h: p1.x < p0.x, flip_v: p1.y < p0.y }
}

/// Where a line's start and end are (its frame's diagonal, flips included).
pub fn line_ends(f: &Xfrm) -> (Point, Point) {
    let a = f.affine();
    (a * Point::new(0.0, 0.0), a * Point::new(f.w, f.h))
}

/// The new frame of connector `c` (glued as `conn`) among `objects`: each glued end at its
/// object's site, a free end where it was. `None` when no end is glued to an object there.
pub fn reroute(c: &DrawingObject, conn: &Connection, objects: &[DrawingObject]) -> Option<Xfrm> {
    let (mut p0, mut p1) = line_ends(&c.frame);
    let site = |e: &End| objects.iter().find(|o| o.id == e.id).and_then(|o| sites(o).get(e.site).copied());
    let mut glued = false;
    if let Some(p) = conn.start.as_ref().and_then(site) {
        p0 = p;
        glued = true;
    }
    if let Some(p) = conn.end.as_ref().and_then(site) {
        p1 = p;
        glued = true;
    }
    glued.then(|| line_frame(p0, p1))
}

/// Is `o` a line a connector's ends can be dragged on: glued, or drawn with a connector or line
/// preset?
pub fn is_connector(o: &DrawingObject) -> bool {
    o.connection.is_some() || matches!(&o.geometry, crate::model::Geometry::Preset { preset, .. } if preset == "line" || CONNECTORS.contains(&preset.as_str()))
}

/// The end (0 its start, 1 its end) of connector `o` within `tol` of `p`.
pub fn hit_end(o: &DrawingObject, p: Point, tol: f64) -> Option<usize> {
    if !is_connector(o) {
        return None;
    }
    let (p0, p1) = line_ends(&o.frame);
    [(0, p0), (1, p1)].into_iter().filter(|(_, q)| (*q - p).hypot() <= tol).min_by(|a, b| (a.1 - p).hypot().total_cmp(&(b.1 - p).hypot())).map(|(i, _)| i)
}

/// The connection site nearest `p` within `tol` among `targets` (each an object's id and its
/// sites), and where it is.
fn nearest_site(targets: &[(String, Vec<Point>)], p: Point, tol: f64) -> Option<(End, Point)> {
    let mut best: Option<(f64, End, Point)> = None;
    for (id, list) in targets {
        for (i, q) in list.iter().enumerate() {
            let d = (*q - p).hypot();
            if d <= tol && best.as_ref().is_none_or(|(bd, _, _)| d < *bd) {
                best = Some((d, End { id: id.clone(), site: i }, *q));
            }
        }
    }
    best.map(|(_, e, q)| (e, q))
}

/// Is `preset` drawn as a line (from one point to another) rather than in a box?
pub fn is_line_preset(preset: &str) -> bool {
    preset == "line" || CONNECTORS.contains(&preset)
}

/// Drawing a new object with the pointer (Insert › Shapes, then a drag on the page): a box from
/// where the drag started, or for a line or connector a line whose ends snap to other objects'
/// connection sites in reach. The release inserts it; a line glued at both ends is made with
/// `drawing.connect`, so it is a connector in one undo step.
#[derive(Clone, Debug)]
pub struct CreateDrag {
    pub preset: String,
    start: Point,
    at: Point,
    targets: Vec<(String, Vec<Point>)>,
    glue: [Option<End>; 2],
}

impl CreateDrag {
    /// Starts at `p` among `objects` (the others on the slide, page or sheet), snapping a line's
    /// start to a site within `tol`.
    pub fn start(preset: &str, p: Point, objects: &[DrawingObject], tol: f64) -> CreateDrag {
        let targets: Vec<(String, Vec<Point>)> =
            objects.iter().filter(|o| !is_connector(o)).map(|o| (o.id.clone(), sites(o))).filter(|(_, s)| !s.is_empty()).collect();
        let mut d = CreateDrag { preset: preset.to_string(), start: p, at: p, targets, glue: [None, None] };
        if is_line_preset(preset)
            && let Some((e, q)) = nearest_site(&d.targets, p, tol)
        {
            d.start = q;
            d.at = q;
            d.glue[0] = Some(e);
        }
        d
    }

    /// The pointer at `p`: the new object's frame now. `square` keeps a box square (Shift).
    pub fn drag(&mut self, p: Point, tol: f64, square: bool) -> Xfrm {
        self.glue[1] = None;
        self.at = p;
        if is_line_preset(&self.preset) {
            if let Some((e, q)) = nearest_site(&self.targets, p, tol).filter(|(e, _)| self.glue[0].as_ref().is_none_or(|g| g.id != e.id)) {
                self.at = q;
                self.glue[1] = Some(e);
            }
        } else if square {
            let d = self.at - self.start;
            let side = d.x.abs().max(d.y.abs());
            self.at = self.start + kurbo::Vec2::new(side.copysign(d.x), side.copysign(d.y));
        }
        self.frame()
    }

    /// The frame drawn so far: a line from the start to the pointer, or the box between them
    /// (a click without a drag: the preset's default 72 pt box, or a 72 pt line).
    pub fn frame(&self) -> Xfrm {
        let line = is_line_preset(&self.preset);
        if (self.at - self.start).hypot() < 2.0 {
            return if line { line_frame(self.start, self.start + kurbo::Vec2::new(72.0, 0.0)) } else { Xfrm::new(self.start.x, self.start.y, 72.0, 72.0) };
        }
        if line {
            return line_frame(self.start, self.at);
        }
        Xfrm::new(self.start.x.min(self.at.x), self.start.y.min(self.at.y), (self.at.x - self.start.x).abs(), (self.at.y - self.start.y).abs())
    }

    /// The command and parameters for the release: `drawing.connect` for a line glued at both
    /// ends, else `drawing.insert` (and the ends to glue with `drawing.reconnect` after it, once
    /// the new object's id is known).
    pub fn release(&self) -> (&'static str, Value, Vec<(usize, End)>) {
        if let [Some(a), Some(b)] = &self.glue {
            let preset = if CONNECTORS.contains(&self.preset.as_str()) { self.preset.as_str() } else { CONNECTORS[0] };
            return (
                "drawing.connect",
                serde_json::json!({ "from": a.id, "to": b.id, "fromSite": a.site, "toSite": b.site, "geometry": { "preset": preset } }),
                Vec::new(),
            );
        }
        let ends = self.glue.iter().enumerate().filter_map(|(i, g)| g.clone().map(|g| (i, g))).collect();
        ("drawing.insert", serde_json::json!({ "geometry": { "preset": self.preset }, "frame": self.frame() }), ends)
    }
}

/// Dragging one end of a connector with the pointer: the end follows, snapping to the nearest
/// connection site of another object in reach; the release is one `drawing.reconnect`, gluing the
/// end there or leaving it free where it was dropped (`KitDrawing 1.4`, DR25).
#[derive(Clone, Debug)]
pub struct EndDrag {
    pub id: String,
    pub end: usize,
    fixed: Point,
    targets: Vec<(String, Vec<Point>)>,
    at: Point,
    snap: Option<End>,
}

impl EndDrag {
    /// Starts dragging end `end` of connector `c`; `objects` are the others on its slide, page
    /// or sheet (its own entry and lines are skipped).
    pub fn start(c: &DrawingObject, end: usize, objects: &[DrawingObject]) -> EndDrag {
        let (p0, p1) = line_ends(&c.frame);
        let (fixed, at) = if end == 0 { (p1, p0) } else { (p0, p1) };
        let targets = objects.iter().filter(|o| o.id != c.id && !is_connector(o)).map(|o| (o.id.clone(), sites(o))).filter(|(_, s)| !s.is_empty()).collect();
        EndDrag { id: c.id.clone(), end: end.min(1), fixed, targets, at, snap: None }
    }

    /// The pointer at `p`: the connector's frame now, and the site it would glue to (within
    /// `tol` of one).
    pub fn drag(&mut self, p: Point, tol: f64) -> (Xfrm, Option<End>) {
        (self.at, self.snap) = match nearest_site(&self.targets, p, tol) {
            Some((e, q)) => (q, Some(e)),
            None => (p, None),
        };
        (self.frame(), self.snap.clone())
    }

    /// The connector's frame with the dragged end where it is now.
    pub fn frame(&self) -> Xfrm {
        if self.end == 0 { line_frame(self.at, self.fixed) } else { line_frame(self.fixed, self.at) }
    }

    /// `drawing.reconnect`'s parameters for the release.
    pub fn release(&self) -> Value {
        let end = if self.end == 0 { "start" } else { "end" };
        match &self.snap {
            Some(e) => serde_json::json!({ "id": self.id, "end": end, "to": e.id, "site": e.site }),
            None => serde_json::json!({ "id": self.id, "end": end, "point": [self.at.x, self.at.y] }),
        }
    }
}

/// `drawing.connect`'s parameters: the two objects, their sites (the nearest pair when left
/// out), and the connector's preset.
#[derive(Clone, Debug, PartialEq)]
pub struct Connect {
    pub from: String,
    pub to: String,
    pub from_site: Option<usize>,
    pub to_site: Option<usize>,
    pub preset: String,
}

impl Connect {
    pub fn parse(p: &Value) -> Result<Connect> {
        let id = |k: &str| -> Result<String> {
            match p.get(k) {
                Some(Value::String(s)) if !s.is_empty() => Ok(s.clone()),
                Some(Value::Number(n)) => Ok(n.to_string()),
                _ => Err(DrawingError::invalid(format!("`{k}` names an object"))),
            }
        };
        let site = |k: &str| -> Result<Option<usize>> {
            match p.get(k) {
                None | Some(Value::Null) => Ok(None),
                Some(v) => v.as_u64().map(|n| Some(n as usize)).ok_or_else(|| DrawingError::invalid(format!("`{k}` is a site's index"))),
            }
        };
        let preset = match p.get("geometry").and_then(|g| g.get("preset")).or_else(|| p.get("preset")).and_then(Value::as_str) {
            None => CONNECTORS[0].to_string(),
            Some(name) if CONNECTORS.contains(&name) => name.to_string(),
            Some(name) => return Err(DrawingError::unsupported("geometry.preset", format!("`{name}` is not a connector ({})", CONNECTORS.join(", ")))),
        };
        let c = Connect { from: id("from")?, to: id("to")?, from_site: site("fromSite")?, to_site: site("toSite")?, preset };
        if c.from == c.to {
            return Err(DrawingError::invalid("a connector joins two objects"));
        }
        Ok(c)
    }

    /// The sites to glue to on `a` (from) and `b` (to): the ones named, or the nearest pair.
    pub fn sites(&self, a: &DrawingObject, b: &DrawingObject) -> Result<(usize, usize, Point, Point)> {
        let (sa, sb) = (sites(a), sites(b));
        if sa.is_empty() || sb.is_empty() {
            return Err(DrawingError::unsupported("from", "both objects need connection sites (lines and groups have none)"));
        }
        let pick = |list: &[Point], at: Option<usize>, k: &str| -> Result<Option<usize>> {
            match at {
                Some(i) if i >= list.len() => Err(DrawingError::invalid(format!("`{k}` is 0 to {}", list.len() - 1))),
                other => Ok(other),
            }
        };
        let (fi, ti) = (pick(&sa, self.from_site, "fromSite")?, pick(&sb, self.to_site, "toSite")?);
        let (i, j) = match (fi, ti) {
            (Some(i), Some(j)) => (i, j),
            (Some(i), None) => (i, nearest(&sa[i..=i], &sb).map_or(0, |(_, j)| j)),
            (None, Some(j)) => (nearest(&sa, &sb[j..=j]).map_or(0, |(i, _)| i), j),
            (None, None) => nearest(&sa, &sb).unwrap_or((0, 0)),
        };
        Ok((i, j, sa[i], sb[j]))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::Geometry;
    use serde_json::json;

    fn rect(id: &str, x: f64, y: f64) -> DrawingObject {
        DrawingObject { id: id.into(), frame: Xfrm::new(x, y, 100.0, 50.0), geometry: Geometry::preset("rect"), ..Default::default() }
    }

    #[test]
    fn a_connector_joins_the_nearest_sites_and_follows_its_ends() {
        let (a, b) = (rect("a", 0.0, 0.0), rect("b", 300.0, 200.0));
        let c = Connect::parse(&json!({ "from": "a", "to": "b" })).unwrap();
        let (i, j, p0, p1) = c.sites(&a, &b).unwrap();
        // A rectangle's sites are its sides' middles: a's right or bottom to b's left or top.
        assert!(p0.x >= 50.0 && p1.x <= 350.0, "{p0:?} {p1:?} ({i}, {j})");
        let frame = line_frame(p0, p1);
        assert_eq!(line_ends(&frame), (p0, p1));
        // b moves: the connector's end goes with it, its start stays on a.
        let conn = Connection { start: Some(End { id: "a".into(), site: i }), end: Some(End { id: "b".into(), site: j }) };
        let connector = DrawingObject { id: "c".into(), frame, ..Default::default() };
        let moved = rect("b", 300.0, 400.0);
        let f = reroute(&connector, &conn, &[a.clone(), moved.clone()]).unwrap();
        let (q0, q1) = line_ends(&f);
        assert_eq!(q0, p0);
        assert_eq!(q1, sites(&moved)[j]);
        // Ends pointing left and up flip the frame.
        let back = line_frame(Point::new(100.0, 100.0), Point::new(0.0, 0.0));
        assert!(back.flip_h && back.flip_v && back.w == 100.0);
        // A free connector stays.
        assert!(reroute(&connector, &Connection::default(), &[a]).is_none());
    }

    #[test]
    fn parameters_name_two_objects_and_a_connector_preset() {
        assert_eq!(Connect::parse(&json!({ "from": 1, "to": "b", "geometry": { "preset": "bentConnector3" } })).unwrap().preset, "bentConnector3");
        assert!(Connect::parse(&json!({ "from": "a", "to": "a" })).is_err());
        assert!(Connect::parse(&json!({ "from": "a", "to": "b", "preset": "star5" })).is_err());
        let c = Connect::parse(&json!({ "from": "a", "to": "b", "fromSite": 9 })).unwrap();
        assert!(c.sites(&rect("a", 0.0, 0.0), &rect("b", 300.0, 0.0)).is_err());
    }

    #[test]
    fn dragging_an_end_snaps_to_a_site_and_releases_as_drawing_reconnect() {
        let (a, b) = (rect("a", 0.0, 0.0), rect("b", 300.0, 200.0));
        let c = DrawingObject {
            id: "c".into(),
            frame: line_frame(Point::new(100.0, 25.0), Point::new(300.0, 225.0)),
            geometry: Geometry::preset("straightConnector1"),
            ..Default::default()
        };
        assert_eq!(hit_end(&c, Point::new(298.0, 224.0), 5.0), Some(1));
        assert_eq!(hit_end(&c, Point::new(200.0, 125.0), 5.0), None);
        assert_eq!(hit_end(&a, Point::new(0.0, 0.0), 5.0), None, "a rectangle has no ends");
        let mut drag = EndDrag::start(&c, 1, &[a.clone(), b.clone(), c.clone()]);
        // Near b's top site (its top side's middle): snaps there.
        let top = sites(&b)
            .into_iter()
            .enumerate()
            .min_by(|x, y| (x.1 - Point::new(350.0, 200.0)).hypot().total_cmp(&(y.1 - Point::new(350.0, 200.0)).hypot()))
            .unwrap();
        let (f, snap) = drag.drag(Point::new(352.0, 203.0), 8.0);
        assert_eq!(snap, Some(End { id: "b".into(), site: top.0 }));
        assert_eq!(line_ends(&f), (Point::new(100.0, 25.0), top.1));
        assert_eq!(drag.release(), json!({ "id": "c", "end": "end", "to": "b", "site": top.0 }));
        // Far from any site: free, where the pointer is.
        let (f, snap) = drag.drag(Point::new(500.0, 500.0), 8.0);
        assert_eq!((snap, line_ends(&f).1), (None, Point::new(500.0, 500.0)));
        assert_eq!(drag.release(), json!({ "id": "c", "end": "end", "point": [500.0, 500.0] }));
        // The release applied: glued, then freed and moved.
        let mut o = c.clone();
        crate::ops::DrawingOp::parse("drawing.reconnect", &json!({ "id": "c", "end": "start", "to": "a", "site": 1 })).unwrap().apply(&mut o).unwrap();
        assert_eq!(o.connection.as_ref().unwrap().start, Some(End { id: "a".into(), site: 1 }));
        crate::ops::DrawingOp::parse("drawing.reconnect", &json!({ "id": "c", "end": "start", "point": [10, 10] })).unwrap().apply(&mut o).unwrap();
        assert_eq!((o.connection.clone(), line_ends(&o.frame).0), (None, Point::new(10.0, 10.0)));
        // Not a connector, gluing to itself, or an end without a site: refused.
        let mut r = a.clone();
        assert!(crate::ops::DrawingOp::parse("drawing.reconnect", &json!({ "id": "a", "end": "end", "point": [1, 1] })).unwrap().apply(&mut r).is_err());
        assert!(crate::ops::DrawingOp::parse("drawing.reconnect", &json!({ "id": "c", "end": "end", "to": "c", "site": 0 })).is_err());
        assert!(crate::ops::DrawingOp::parse("drawing.reconnect", &json!({ "id": "c", "end": "end", "to": "a" })).is_err());
        assert!(crate::ops::DrawingOp::parse("drawing.reconnect", &json!({ "id": "c", "end": "middle" })).is_err());
    }

    #[test]
    fn drawing_a_shape_or_a_line_between_shapes() {
        let (a, b) = (rect("a", 0.0, 0.0), rect("b", 300.0, 200.0));
        // A box from the drag; Shift keeps it square; a click makes the default box.
        let mut d = CreateDrag::start("ellipse", Point::new(500.0, 500.0), &[a.clone(), b.clone()], 8.0);
        assert_eq!(d.drag(Point::new(560.0, 530.0), 8.0, false), Xfrm::new(500.0, 500.0, 60.0, 30.0));
        assert_eq!(d.drag(Point::new(560.0, 530.0), 8.0, true), Xfrm::new(500.0, 500.0, 60.0, 60.0));
        let (cmd, p, ends) = d.release();
        assert_eq!((cmd, p["geometry"]["preset"].as_str(), ends.len()), ("drawing.insert", Some("ellipse"), 0));
        let click = CreateDrag::start("rect", Point::new(10.0, 400.0), &[], 8.0);
        assert_eq!(click.frame(), Xfrm::new(10.0, 400.0, 72.0, 72.0));
        // A line from a's right site to b's top site: a connector in one command.
        let (ra, tb) = (sites(&a)[1], sites(&b)[0]);
        let mut l = CreateDrag::start("line", ra + kurbo::Vec2::new(2.0, 1.0), &[a.clone(), b.clone()], 8.0);
        let f = l.drag(tb + kurbo::Vec2::new(-3.0, 2.0), 8.0, false);
        assert_eq!(line_ends(&f), (ra, tb));
        let (cmd, p, _) = l.release();
        assert_eq!(cmd, "drawing.connect");
        assert_eq!(p, json!({ "from": "a", "to": "b", "fromSite": 1, "toSite": 0, "geometry": { "preset": "straightConnector1" } }));
        // Glued at one end only: inserted, then that end glued.
        let mut one = CreateDrag::start("line", ra, &[a.clone(), b.clone()], 8.0);
        one.drag(Point::new(150.0, 400.0), 8.0, false);
        let (cmd, _, ends) = one.release();
        assert_eq!((cmd, ends), ("drawing.insert", vec![(0, End { id: "a".into(), site: 1 })]));
        assert!(is_line_preset("bentConnector3") && !is_line_preset("rect"));
    }
}
