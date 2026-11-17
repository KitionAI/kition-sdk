//! Pointer editing of drawing objects: selection handles, hit testing, and gestures.
//!
//! A gesture never changes a document. While the pointer moves it answers preview frames, which
//! the kit draws as overlays (or in a preview pass); on release it answers one
//! [`DrawingOp`](crate::ops::DrawingOp) for the kit to run as one command, so one gesture is one
//! undo step (`KitDrawing 1.0` DR13). Dropping the gesture (Escape, pointer cancel) discards it.
//!
//! Coordinates are points in the space the kit's frames are in (a slide, a page, a sheet).

use kurbo::{Affine, BezPath, Point, Rect, Shape as _, Vec2};

use crate::geom::{Xfrm, near_path};
use crate::model::{DrawingObject, Fill, Geometry, ObjectKind};
use crate::ops::{DrawingOp, Format, FrameChange};

/// Handle hit radius as a multiple of the tolerance (resize and rotate).
const HANDLE_REACH: f64 = 1.6;
const ROTATE_REACH: f64 = 1.8;
/// How far above the top edge the rotation handle sits, points.
pub const ROTATE_OFFSET: f64 = 20.0;

/// Modifier keys during a gesture.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Mods {
    /// Constrain: straight moves, kept aspect ratio, 15° rotation steps.
    pub shift: bool,
    /// Resize about the centre.
    pub alt: bool,
}

/// The 8 resize handles (NW, N, NE, E, SE, S, SW, W) and the rotation handle of a frame.
pub fn box_handles(x: &Xfrm) -> ([Point; 8], Point) {
    let a = x.affine();
    let (w, h) = (x.w, x.h);
    let local = [(0.0, 0.0), (w / 2.0, 0.0), (w, 0.0), (w, h / 2.0), (w, h), (w / 2.0, h), (0.0, h), (0.0, h / 2.0)];
    let pts = local.map(|(px, py)| a * Point::new(px, py));
    // The rotation handle sits above the top edge, in the object's rotated frame.
    let up = if x.flip_v { 1.0 } else { -1.0 };
    let rot = Affine::translate(Vec2::new(x.x + w / 2.0, x.y + h / 2.0)) * Affine::rotate(x.rot.to_radians()) * Point::new(0.0, up * (h / 2.0 + ROTATE_OFFSET));
    (pts, rot)
}

/// A handle of a selected object.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HandleHit {
    /// Resize handle 0..8: NW, N, NE, E, SE, S, SW, W.
    Resize(u8),
    Rotate,
}

/// The handle of `frame` under `p`, the rotation handle first when `rotate` is allowed.
pub fn hit_handle(frame: &Xfrm, p: Point, tol: f64, rotate: bool) -> Option<HandleHit> {
    let (pts, rot) = box_handles(frame);
    if rotate && (rot - p).hypot() <= tol * ROTATE_REACH {
        return Some(HandleHit::Rotate);
    }
    pts.iter().position(|q| (*q - p).hypot() <= tol * HANDLE_REACH).and_then(|i| u8::try_from(i).ok()).map(HandleHit::Resize)
}

/// The built outline of an object's geometry at its frame's size (object-local space). Unknown
/// presets and custom paths that do not parse fall back to the frame's rectangle.
pub fn outline(o: &DrawingObject) -> crate::preset::Geometry {
    let (w, h) = (o.frame.w.max(0.0), o.frame.h.max(0.0));
    let built = match &o.geometry {
        Geometry::Preset { preset, .. } => crate::preset::build(preset, w, h, &o.geometry.adjust_values()),
        Geometry::Custom { paths } => crate::display::custom_geometry(paths, w, h),
    };
    built.or_else(|| crate::preset::build("rect", w, h, &[])).unwrap_or_else(|| crate::preset::Geometry {
        paths: Vec::new(),
        text_rect: Rect::new(0.0, 0.0, w, h),
        handles: Vec::new(),
        sites: Vec::new(),
    })
}

/// Whether `p` is on object `o`: inside a filled outline, near a stroked one, or anywhere in the
/// frame of an object that holds text or is a text box (so empty text boxes can be clicked).
pub fn hit_object(o: &DrawingObject, p: Point, tol: f64) -> bool {
    if !o.frame.is_finite() {
        return false;
    }
    let local = o.frame.affine().inverse() * p;
    let in_frame = local.x >= -tol && local.y >= -tol && local.x <= o.frame.w + tol && local.y <= o.frame.h + tol;
    if !in_frame {
        return false;
    }
    if o.kind == ObjectKind::TextBox || o.text.as_ref().is_some_and(|t| !t.text().is_empty()) {
        return true;
    }
    let g = outline(o);
    let path = g.outline();
    let filled = !matches!(o.fill, Some(Fill::None)) && !g.is_open();
    (filled && path.winding(local) != 0) || near_path(&path, local, tol)
}

/// The topmost object under `p` (objects are listed bottom to top).
pub fn hit_topmost(objects: &[DrawingObject], p: Point, tol: f64) -> Option<&DrawingObject> {
    objects.iter().rev().find(|o| hit_object(o, p, tol))
}

/// The frame after dragging resize handle `h` by `d` (in the parent space): the opposite edge
/// stays put in the object's rotated frame; `keep_aspect` keeps the ratio on corner handles;
/// `from_center` grows both sides; dragging past the opposite edge flips.
pub fn resize_box(o: &Xfrm, h: u8, d: Vec2, keep_aspect: bool, from_center: bool) -> Xfrm {
    // Work in the shape's rotated frame.
    let rot = Affine::rotate(-o.rot.to_radians());
    let ld = rot * Point::new(d.x, d.y);
    let (mut l, mut t, mut r, mut b) = (0.0, 0.0, o.w, o.h);
    let (sx, sy) = (if o.flip_h { -1.0 } else { 1.0 }, if o.flip_v { -1.0 } else { 1.0 });
    let (dx, dy) = (ld.x * sx, ld.y * sy);
    match h {
        0 => {
            l += dx;
            t += dy;
        }
        1 => t += dy,
        2 => {
            r += dx;
            t += dy;
        }
        3 => r += dx,
        4 => {
            r += dx;
            b += dy;
        }
        5 => b += dy,
        6 => {
            l += dx;
            b += dy;
        }
        _ => l += dx,
    }
    if from_center {
        // Symmetric growth about the centre.
        let gw = match h {
            0 | 6 | 7 => -dx,
            2..=4 => dx,
            _ => 0.0,
        };
        let gh = match h {
            0..=2 => -dy,
            4..=6 => dy,
            _ => 0.0,
        };
        l = -gw;
        r = o.w + gw;
        t = -gh;
        b = o.h + gh;
    }
    let mut w = r - l;
    let mut hh = b - t;
    if keep_aspect && o.w > 1e-9 && o.h > 1e-9 && !matches!(h, 1 | 3 | 5 | 7) {
        let ar = o.w / o.h;
        if (w / ar).abs() > hh.abs() {
            hh = w.abs() / ar * hh.signum().max(if hh == 0.0 { 1.0 } else { hh.signum() });
        } else {
            w = hh.abs() * ar * w.signum().max(if w == 0.0 { 1.0 } else { w.signum() });
        }
        if matches!(h, 0 | 6) {
            l = r - w;
        } else {
            r = l + w;
        }
        if matches!(h, 0 | 2) {
            t = b - hh;
        } else {
            b = t + hh;
        }
        if from_center {
            let (cx, cy) = (o.w / 2.0, o.h / 2.0);
            l = cx - w / 2.0;
            r = cx + w / 2.0;
            t = cy - hh / 2.0;
            b = cy + hh / 2.0;
        }
    }
    // Dragging past the opposite edge flips.
    let (mut fh, mut fv) = (o.flip_h, o.flip_v);
    if r < l {
        std::mem::swap(&mut l, &mut r);
        fh = !fh;
    }
    if b < t {
        std::mem::swap(&mut t, &mut b);
        fv = !fv;
    }
    let (nw, nh) = (r - l, b - t);
    // New centre in the parent space: old centre + rotated offset of the local centre change.
    let local_c = Point::new((l + r) / 2.0 * sx + if sx < 0.0 { o.w } else { 0.0 }, (t + b) / 2.0 * sy + if sy < 0.0 { o.h } else { 0.0 });
    let c = o.affine() * Point::new(if o.flip_h { o.w - local_c.x } else { local_c.x }, if o.flip_v { o.h - local_c.y } else { local_c.y });
    Xfrm { x: c.x - nw / 2.0, y: c.y - nh / 2.0, w: nw, h: nh, rot: o.rot, flip_h: fh, flip_v: fv }
}

/// A rotation of `origs` by `delta` degrees: each object turns, and with several objects their
/// centres also turn about `center`. With `snap`, the first object's angle steps by 15°.
pub fn rotate_frames(origs: &[(String, Xfrm)], center: Point, delta: f64, snap: bool) -> Vec<(String, Xfrm)> {
    let mut delta = delta;
    if snap && let Some((_, first)) = origs.first() {
        delta = ((first.rot + delta) / 15.0).round() * 15.0 - first.rot;
    }
    origs
        .iter()
        .map(|(id, o)| {
            let mut n = *o;
            n.rot = (o.rot + delta).rem_euclid(360.0);
            if origs.len() > 1 {
                let c = Affine::translate(center.to_vec2()) * Affine::rotate(delta.to_radians()) * Affine::translate(-center.to_vec2()) * o.center();
                n.x = c.x - o.w / 2.0;
                n.y = c.y - o.h / 2.0;
            }
            (id.clone(), n)
        })
        .collect()
}

/// The adjust handles (the yellow dots) of a preset shape at `frame`: each handle's adjust
/// index and where it is, in the frame's space. None for custom geometry.
pub fn adjust_handles(frame: &Xfrm, geometry: &Geometry) -> Vec<(usize, Point)> {
    let Geometry::Preset { preset, .. } = geometry else { return Vec::new() };
    let Some(g) = crate::preset::build(preset, frame.w.max(0.0), frame.h.max(0.0), &geometry.adjust_values()) else { return Vec::new() };
    let a = frame.affine();
    g.handles.iter().map(|h| (h.index, a * h.pos)).collect()
}

/// The adjust handle of a shape at `frame` under `p`.
pub fn hit_adjust(frame: &Xfrm, geometry: &Geometry, p: Point, tol: f64) -> Option<usize> {
    adjust_handles(frame, geometry).into_iter().find(|(_, q)| (*q - p).hypot() <= tol * HANDLE_REACH).map(|(i, _)| i)
}

/// The guide name of a preset's adjust value `index` (`adj` when it has one, else `adj1`…).
fn guide_name(preset: &str, index: usize) -> String {
    let count = crate::preset::info(preset).map_or(0, |i| i.defaults.len());
    if count <= 1 && index == 0 { "adj".to_string() } else { format!("adj{}", index + 1) }
}

/// A preset's adjust values with the ones it does not name at their defaults.
fn full_values(geometry: &Geometry) -> Vec<f64> {
    let Geometry::Preset { preset, .. } = geometry else { return Vec::new() };
    let mut v = geometry.adjust_values();
    let defaults = crate::preset::info(preset).map_or(&[][..], |i| i.defaults);
    if v.len() < defaults.len() {
        v.extend_from_slice(&defaults[v.len()..]);
    }
    v
}

/// `geometry` with adjust value `index` set to `value`, under the name the preset uses.
fn with_adjust(geometry: &Geometry, index: usize, value: f64) -> Geometry {
    let Geometry::Preset { preset, adjust } = geometry else { return geometry.clone() };
    let mut adjust = adjust.clone();
    // One name per value: an `adj1` written for a one-value preset gives way to `adj`.
    adjust.retain(|name, _| crate::model::guide_index(name) != Some(index));
    adjust.insert(guide_name(preset, index), value);
    Geometry::Preset { preset: preset.clone(), adjust }
}

/// A pointer gesture on selected objects.
#[derive(Clone, Debug, PartialEq)]
pub enum Gesture {
    Move {
        origs: Vec<(String, Xfrm)>,
        start: Point,
        moved: bool,
    },
    Resize {
        id: String,
        handle: u8,
        orig: Xfrm,
        start: Point,
    },
    Rotate {
        origs: Vec<(String, Xfrm)>,
        center: Point,
        start_angle: f64,
    },
    /// Dragging adjust handle `index` of shape `id`; `current` is the geometry under the pointer.
    Adjust {
        id: String,
        frame: Xfrm,
        geometry: Geometry,
        index: usize,
        current: Option<Geometry>,
    },
}

/// A gesture's state after a pointer move.
#[derive(Clone, Debug, PartialEq)]
pub struct Preview {
    /// The frames to draw instead of the objects' own (empty while a move is under the drag
    /// threshold).
    pub frames: Vec<(String, Xfrm)>,
}

impl Gesture {
    /// Starts moving `origs` (the selection's frames) from `start`.
    pub fn moving(origs: Vec<(String, Xfrm)>, start: Point) -> Self {
        Gesture::Move { origs, start, moved: false }
    }
    pub fn resizing(id: String, handle: u8, orig: Xfrm, start: Point) -> Self {
        Gesture::Resize { id, handle, orig, start }
    }
    /// Starts rotating `origs` about the centre of `about` (the object whose handle was grabbed).
    pub fn rotating(origs: Vec<(String, Xfrm)>, about: &Xfrm, start: Point) -> Self {
        let center = about.center();
        Gesture::Rotate { origs, center, start_angle: (start.y - center.y).atan2(start.x - center.x) }
    }

    /// Starts dragging adjust handle `index` of the preset shape `id` at `frame`.
    pub fn adjusting(id: String, frame: Xfrm, geometry: Geometry, index: usize) -> Self {
        Gesture::Adjust { id, frame, geometry, index, current: None }
    }

    /// While an adjust handle is dragged: the shape's outline as it will be, in the frame's
    /// space, for the kit to draw as the preview.
    pub fn preview_outline(&self) -> Option<(String, BezPath)> {
        let Gesture::Adjust { id, frame, current: Some(g), .. } = self else { return None };
        let o = DrawingObject { frame: *frame, geometry: g.clone(), ..Default::default() };
        Some((id.clone(), frame.affine() * outline(&o).outline()))
    }

    /// The pointer moved to `p`. `snap` may adjust a move by the moved bounds (smart guides).
    pub fn drag(&mut self, p: Point, mods: Mods, tol: f64, snap: Option<&dyn Fn(Rect) -> Vec2>) -> Preview {
        if !(p.x.is_finite() && p.y.is_finite()) {
            return Preview { frames: self.frames() };
        }
        match self {
            Gesture::Move { origs, start, moved } => {
                let mut d = p - *start;
                if !*moved && d.hypot() < tol.max(1.0) {
                    return Preview { frames: Vec::new() };
                }
                *moved = true;
                if mods.shift {
                    if d.x.abs() > d.y.abs() {
                        d.y = 0.0;
                    } else {
                        d.x = 0.0;
                    }
                }
                if let Some(snap) = snap {
                    let bounds = origs.iter().map(|(_, x)| x.bounds()).reduce(|a, b| a.union(b)).unwrap_or_default();
                    d += snap(bounds + d);
                }
                Preview { frames: origs.iter().map(|(id, o)| (id.clone(), Xfrm { x: o.x + d.x, y: o.y + d.y, ..*o })).collect() }
            }
            Gesture::Resize { id, handle, orig, start } => Preview { frames: vec![(id.clone(), resize_box(orig, *handle, p - *start, mods.shift, mods.alt))] },
            Gesture::Rotate { origs, center, start_angle } => {
                let delta = ((p.y - center.y).atan2(p.x - center.x) - *start_angle).to_degrees();
                Preview { frames: rotate_frames(origs, *center, delta, mods.shift) }
            }
            Gesture::Adjust { id, frame, geometry, index, current } => {
                let Geometry::Preset { preset, .. } = &*geometry else { return Preview { frames: Vec::new() } };
                let built = crate::preset::build(preset, frame.w.max(0.0), frame.h.max(0.0), &geometry.adjust_values());
                let Some(handle) = built.as_ref().and_then(|g| g.handles.iter().find(|h| h.index == *index)) else {
                    return Preview { frames: Vec::new() };
                };
                let value = handle.value_at(frame.affine().inverse() * p);
                let next = with_adjust(geometry, *index, value);
                *current = (full_values(&next) != full_values(geometry)).then_some(next);
                // The frame stays; the kit draws `preview_outline` over it.
                Preview { frames: if current.is_some() { vec![(id.clone(), *frame)] } else { Vec::new() } }
            }
        }
    }

    /// The frames before the gesture.
    pub fn frames(&self) -> Vec<(String, Xfrm)> {
        match self {
            Gesture::Move { origs, .. } | Gesture::Rotate { origs, .. } => origs.clone(),
            Gesture::Resize { id, orig, .. } => vec![(id.clone(), *orig)],
            Gesture::Adjust { id, frame, .. } => vec![(id.clone(), *frame)],
        }
    }

    /// The pointer was released after `last` (the latest preview): the operation to commit,
    /// or nothing for a click that never moved or a frame that is not valid.
    pub fn release(&self, last: &Preview) -> Option<DrawingOp> {
        if let Gesture::Adjust { id, current, .. } = self {
            // An adjust handle changes the geometry, not the frame: one `drawing.format`.
            let geometry = current.clone()?;
            return Some(DrawingOp::Format { ids: vec![id.clone()], format: Format { geometry: Some(geometry), ..Default::default() } });
        }
        if last.frames.is_empty() || last.frames == self.frames() {
            return None;
        }
        if last.frames.iter().any(|(_, f)| crate::ops::check_frame(f).is_err()) {
            return None;
        }
        Some(DrawingOp::Transform(FrameChange::Set(last.frames.clone())))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::Color;

    fn ellipse(id: &str, x: f64, y: f64) -> DrawingObject {
        DrawingObject {
            id: id.into(),
            frame: Xfrm::new(x, y, 100.0, 50.0),
            geometry: Geometry::preset("ellipse"),
            fill: Some(Fill::Solid(Color::theme("accent1"))),
            ..Default::default()
        }
    }

    #[test]
    fn an_adjust_handle_is_dragged_into_one_format_change() {
        // A rounded rectangle's handle sits on its top edge, `adj` of the shorter side in.
        let frame = Xfrm::new(100.0, 100.0, 200.0, 100.0);
        let g = Geometry::preset("roundRect");
        let handles = adjust_handles(&frame, &g);
        assert_eq!(handles.len(), 1);
        let (index, at) = handles[0];
        assert_eq!(index, 0);
        assert!((at.y - 100.0).abs() < 1e-6 && (at.x - (100.0 + 100.0 * 16_667.0 / 100_000.0)).abs() < 0.01, "{at:?}");
        assert_eq!(hit_adjust(&frame, &g, at + Vec2::new(1.0, 0.0), 1.0), Some(0));
        assert_eq!(hit_adjust(&frame, &g, Point::new(200.0, 150.0), 1.0), None);

        let mut gesture = Gesture::adjusting("s1".into(), frame, g.clone(), index);
        // Dragging 25 pt to the right: a quarter of the 100 pt side, 25,000 more.
        let preview = gesture.drag(at + Vec2::new(25.0, 0.0), Mods::default(), 1.0, None);
        assert_eq!(preview.frames, vec![("s1".to_string(), frame)]);
        assert!(gesture.preview_outline().is_some_and(|(id, path)| id == "s1" && path.bounding_box().width() > 199.0));
        let Some(DrawingOp::Format { ids, format }) = gesture.release(&preview) else { panic!("one format change") };
        assert_eq!(ids, vec!["s1".to_string()]);
        let value = format.geometry.unwrap().adjust_values()[0];
        assert!((value - 41_667.0).abs() <= 1.0, "{value}");

        // Clamped to the preset's range, and nothing for a handle put back where it was.
        let mut far = Gesture::adjusting("s1".into(), frame, g.clone(), index);
        let p = far.drag(Point::new(1000.0, 100.0), Mods::default(), 1.0, None);
        let Some(DrawingOp::Format { format, .. }) = far.release(&p) else { panic!() };
        assert_eq!(format.geometry.unwrap().adjust_values(), vec![50_000.0]);
        let mut back = Gesture::adjusting("s1".into(), frame, g, index);
        let p = back.drag(at, Mods::default(), 1.0, None);
        assert!(back.release(&p).is_none());

        // A preset with several values names each one; a rotated frame moves its handles.
        let arrow = Geometry::preset("rightArrow");
        let turned = Xfrm { rot: 90.0, ..frame };
        assert_eq!(adjust_handles(&turned, &arrow).len(), 2);
        assert_eq!(
            with_adjust(&arrow, 1, 30_000.0),
            serde_json::from_value::<Geometry>(serde_json::json!({ "preset": "rightArrow", "adjust": { "adj2": 30000.0 } })).unwrap()
        );
        assert!(adjust_handles(&frame, &Geometry::Custom { paths: Vec::new() }).is_empty());
    }

    #[test]
    fn ellipses_are_hit_inside_their_outline_only() {
        let e = ellipse("1", 0.0, 0.0);
        assert!(hit_object(&e, Point::new(50.0, 25.0), 1.0));
        assert!(!hit_object(&e, Point::new(3.0, 3.0), 1.0), "the frame's corner is outside the ellipse");
        let unfilled = DrawingObject { fill: Some(Fill::None), ..ellipse("2", 0.0, 0.0) };
        assert!(!hit_object(&unfilled, Point::new(50.0, 25.0), 1.0));
        assert!(hit_object(&unfilled, Point::new(50.0, 0.5), 1.0), "near the outline");
        let tb = DrawingObject { kind: ObjectKind::TextBox, fill: Some(Fill::None), ..ellipse("3", 0.0, 0.0) };
        assert!(hit_object(&tb, Point::new(3.0, 3.0), 1.0), "an empty text box is hit anywhere in its frame");
    }

    #[test]
    fn the_topmost_object_wins_and_rotation_is_respected() {
        let objects = vec![ellipse("a", 0.0, 0.0), ellipse("b", 20.0, 0.0)];
        assert_eq!(hit_topmost(&objects, Point::new(60.0, 25.0), 1.0).map(|o| o.id.as_str()), Some("b"));
        let mut tall = DrawingObject { geometry: Geometry::preset("rect"), ..ellipse("t", 0.0, 0.0) };
        tall.frame.rot = 90.0;
        // Turned about its centre (50, 25), the 100×50 box spans x 25..75, y -25..75.
        assert!(hit_object(&tall, Point::new(50.0, 70.0), 0.5));
        assert!(!hit_object(&tall, Point::new(90.0, 25.0), 0.5));
    }

    #[test]
    fn handles_and_their_hits() {
        let f = Xfrm::new(0.0, 0.0, 100.0, 50.0);
        let (pts, rot) = box_handles(&f);
        assert_eq!(pts[4], Point::new(100.0, 50.0));
        assert_eq!(rot, Point::new(50.0, -ROTATE_OFFSET));
        assert_eq!(hit_handle(&f, Point::new(99.0, 49.0), 2.0, true), Some(HandleHit::Resize(4)));
        assert_eq!(hit_handle(&f, Point::new(50.0, -20.0), 2.0, true), Some(HandleHit::Rotate));
        assert_eq!(hit_handle(&f, Point::new(50.0, -20.0), 2.0, false), None);
    }

    #[test]
    fn resizing_keeps_the_opposite_corner_and_flips_past_it() {
        let o = Xfrm::new(10.0, 10.0, 100.0, 50.0);
        let n = resize_box(&o, 4, Vec2::new(20.0, 10.0), false, false);
        assert_eq!((n.x, n.y, n.w, n.h), (10.0, 10.0, 120.0, 60.0));
        let flipped = resize_box(&o, 3, Vec2::new(-150.0, 0.0), false, false);
        assert!(flipped.flip_h && (flipped.w - 50.0).abs() < 1e-9 && (flipped.x - -40.0).abs() < 1e-9);
        let aspect = resize_box(&o, 4, Vec2::new(100.0, 0.0), true, false);
        assert!((aspect.w / aspect.h - 2.0).abs() < 1e-9);
        let centred = resize_box(&o, 3, Vec2::new(10.0, 0.0), false, true);
        assert_eq!((centred.x, centred.w), (0.0, 120.0));
    }

    #[test]
    fn a_rotated_resize_keeps_the_opposite_corner_in_place() {
        let mut o = Xfrm::new(0.0, 0.0, 100.0, 50.0);
        o.rot = 30.0;
        let anchor = o.affine() * Point::new(0.0, 0.0);
        let n = resize_box(&o, 4, Vec2::new(17.0, 23.0), false, false);
        let after = n.affine() * Point::new(0.0, 0.0);
        assert!((anchor - after).hypot() < 1e-9);
    }

    #[test]
    fn a_move_gesture_previews_and_commits_one_operation() {
        let mut g = Gesture::moving(vec![("1".into(), Xfrm::new(0.0, 0.0, 10.0, 10.0)), ("2".into(), Xfrm::new(20.0, 0.0, 10.0, 10.0))], Point::new(5.0, 5.0));
        let small = g.drag(Point::new(6.0, 5.0), Mods::default(), 3.0, None);
        assert!(small.frames.is_empty(), "under the drag threshold");
        assert_eq!(g.release(&small), None, "a click is not an edit");
        let p = g.drag(Point::new(25.0, 9.0), Mods { shift: true, alt: false }, 3.0, None);
        assert_eq!(p.frames[1].1, Xfrm::new(40.0, 0.0, 10.0, 10.0), "Shift keeps the move straight");
        let snapped = g.drag(Point::new(25.0, 5.0), Mods::default(), 3.0, Some(&|_| Vec2::new(1.0, 0.0)));
        assert_eq!(snapped.frames[0].1.x, 21.0);
        let op = g.release(&snapped).unwrap();
        assert!(matches!(op, DrawingOp::Transform(FrameChange::Set(f)) if f.len() == 2));
    }

    #[test]
    fn rotation_snaps_and_turns_a_group_about_its_centre() {
        let origs = vec![("1".to_string(), Xfrm::new(0.0, 0.0, 10.0, 10.0)), ("2".to_string(), Xfrm::new(20.0, 0.0, 10.0, 10.0))];
        let turned = rotate_frames(&origs, Point::new(15.0, 5.0), 92.0, true);
        assert_eq!(turned[0].1.rot, 90.0);
        // Object 2's centre (25, 5) turns 90° about (15, 5) to (15, 15).
        assert!((turned[1].1.center() - Point::new(15.0, 15.0)).hypot() < 1e-9);
        let mut g = Gesture::rotating(vec![origs[0].clone()], &origs[0].1, Point::new(5.0, -20.0));
        let p = g.drag(Point::new(30.0, 5.0), Mods::default(), 3.0, None);
        assert!((p.frames[0].1.rot - 90.0).abs() < 1e-9);
    }

    #[test]
    fn a_resize_that_breaks_the_frame_commits_nothing() {
        let g = Gesture::resizing("1".into(), 4, Xfrm::new(0.0, 0.0, 10.0, 10.0), Point::ZERO);
        let bad = Preview { frames: vec![("1".into(), Xfrm::new(0.0, 0.0, f64::NAN, 10.0))] };
        assert_eq!(g.release(&bad), None);
    }
}
