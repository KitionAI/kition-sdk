//! What Kition's Office kits (doc, sheet, slide) share: one implementation of the objects all
//! three hold, so each is drawn, edited, read and written the same way in every kit. Today the
//! drawing objects (Kit Harness Protocol set `KitDrawing 1.0`), charts, ink, text warps, and
//! equations ([`math`]: the model, its text forms, its OMML codec and its layout, set in the
//! kit's fonts), and smart graphics ([`smartart`], OOXML diagrams) with the DrawingML colours
//! they use ([`drawingml`]). Shared readers take the kit's own XML tree through [`xml::Xml`].
//!
//! The dependency direction is kit adapter → this crate: nothing here knows a kit, its document
//! model, its renderer, or Kition. A kit keeps its own placement (Word's floats, Sheet's cell
//! anchors, Slide's placeholders), object identity, transactions, and file packaging, and uses:
//!
//! - [`geom`] and [`preset`]: points and EMU, frames ([`Xfrm`]), and the preset shape outlines
//!   (our own clean-room construction from ECMA-376's preset names and adjust semantics);
//! - [`model`]: the `DrawingObject` description agents read and commands take;
//! - [`ops`]: typed, validated operations ([`ops::DrawingOp`]) parsed from `drawing.*` command
//!   parameters, applied to a [`model::DrawingObject`];
//! - [`edit`]: handles, hit testing and the gesture state machine (preview while dragging, one
//!   operation on release, nothing on cancel);
//! - [`display`]: what to paint for an object, as paths and paints for the kit's renderer;
//! - [`chart`] and [`ink`]: charts (`KitDrawing` 1.1) and ink strokes (1.2).
#![deny(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::unimplemented, clippy::todo, clippy::unreachable)]
#![forbid(unsafe_code)]

pub mod arrange;
pub mod chart;
pub mod connect;
pub mod display;
pub mod drawingml;
pub mod edit;
pub mod geom;
pub mod ink;
pub mod math;
pub mod model;
pub mod ops;
pub mod preset;
pub mod smartart;
pub mod stroke;
pub mod warp;
pub mod xml;

pub use geom::*;
/// The kurbo this crate's paths and points are, for kits that draw them.
pub use kurbo;
