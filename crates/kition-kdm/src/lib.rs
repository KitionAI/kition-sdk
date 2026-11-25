//! Kit Data Model (KDM): the typed, replicated document model of the Kition kit platform (`KitModel 1.1`).
//!
//! A kit declares its document as a [`Schema`]. A [`Replica`] holds one copy of a document,
//! changes it only through transactions ([`Replica::transact`]), and exchanges changes with other
//! replicas ([`Replica::export_changes`], [`Replica::import_changes`]). Every replica that has
//! seen the same changes has the same [`Replica::state_json`], in any delivery order.
//!
//! The replication engine is Loro; it never appears in this crate's public types.

#![deny(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::indexing_slicing)]

pub mod batch;
mod changes;
pub mod comment;
pub mod conflict;
pub mod content;
pub mod diff;
mod error;
pub mod footprint;
mod ids;
mod marks;
mod op;
mod origin;
mod overlay;
pub mod projection;
mod read;
mod replica;
pub mod reread;
mod schema;
// The plain model's store (plan 2026-11-24): `Replica` moves onto it in the next step.
#[allow(dead_code)]
mod store;
pub mod testing;
pub mod tool_ids;
mod tx;
mod value;

pub use changes::{Changes, MapWrites};
pub use error::{KdmError, Result};
pub use ids::{ActorId, DocId, NodeRef, ObjectId};
pub use marks::TextRun;
pub use origin::{Origin, OriginKind, UndoScope};
pub use replica::{HistoryChange, Replica, TreeEntry, UndoTouch, Version};
pub use schema::{
    Expand, FieldDef, FieldKind, KDM_VERSION, MarkDef, NumberLimits, ProjectedCommand, ReadOnlyWhen, Schema, StructuralConsequence, ToolIdDef, TypeDef,
};
pub use tx::Tx;
