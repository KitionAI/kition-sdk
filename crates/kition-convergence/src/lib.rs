//! # kition-convergence
//!
//! The performance mode of the Kition kit platform's kit suite ([`perf`]): the per-kit budgets of
//! Kition's `docs/kits.md` section 7 (opening a document, applying 1,000 changes from another
//! replica, a keystroke, the memory of one more replica), measured through a small adapter
//! ([`KitAdapter`]) on any contract 2 kit. The suite only sees bytes and JSON, so it depends on no
//! particular `kition-kit` revision; a kit adds it as a dev-dependency.
//!
//! The multi-replica merge scenarios it ran before are gone with the CRDT (plan 2026-11-24): a
//! document's changes form one line, and collaboration will order them on a server.

// No `clippy::indexing_slicing`: the suite indexes `serde_json::Value`s by key, which never panics.
#![deny(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::collections::BTreeMap;

use serde_json::Value;

mod alloc;
pub mod perf;

pub use alloc::CountingAlloc;

/// A failure, as a message that names what differed.
pub type Result<T, E = String> = std::result::Result<T, E>;

/// Blob bytes by SHA-256 (lowercase hex), as a replica hands them to a peer.
pub type Blobs = BTreeMap<String, Vec<u8>>;

/// A scripted step the suite asks a kit for. Each acts on the kit's **probe**: an object (or text)
/// the adapter picks deterministically from the document's state (the first slide's first shape,
/// the first paragraph), so every replica that has the same state picks the same one. An adapter
/// answers `Ok(false)` for a step its kit has no equivalent of; the scenarios that need it are
/// then reported as skipped.
#[derive(Clone, Debug, PartialEq, Eq)]
#[non_exhaustive]
pub enum Script {
    /// Sets one register field of the probe object to a value derived from `value` (different
    /// values give different results). Slots 0 and 1 MUST be different fields of the same object.
    SetField { slot: u8, value: u32 },
    /// Creates one object of the kit's main kind (a shape, a paragraph, a layer).
    Create,
    /// Deletes the probe object.
    Delete,
    /// Duplicates the probe object.
    Duplicate,
    /// Moves an item of an ordered collection (slides, layers, blocks); `which` 0 and 1 SHOULD move
    /// different items.
    Reorder { which: u8 },
    /// Moves an object under another parent in a tree (groups); `which` 0 and 1 SHOULD make
    /// conflicting moves (each object into the other) when the kit allows it.
    Reparent { which: u8 },
    /// Inserts `text` at character `at` (Unicode scalar values) of [`KitAdapter::text`].
    InsertText { at: usize, text: String },
    /// Deletes `len` characters at `at` of [`KitAdapter::text`].
    DeleteText { at: usize, len: usize },
    /// Splits the paragraph at character `at` of [`KitAdapter::text`]: a `\n` appears there.
    SplitParagraph { at: usize },
    /// Merges the paragraphs on both sides of the `\n` at character `at`.
    MergeParagraph { at: usize },
    /// Adds content backed by a new blob (a picture) whose bytes derive from `seed`.
    InsertBlob { seed: u32 },
}

/// A contract 2 kit as the suite drives it. Errors are messages; the suite reports them with the
/// scenario and seed.
pub trait KitAdapter {
    /// One replica: the kit's open document (its contract 1 document with the session members, or
    /// its session type).
    type Doc;

    /// The kit id, for reports (`kit.doc`).
    fn name(&self) -> &str;
    /// The kit's KDM schema (`model/schema.json`), which the reference checks read.
    fn schema(&self) -> &str;
    /// A new document with some content (several objects, and text when the kit has text).
    fn create(&self) -> Result<Self::Doc>;
    /// Another replica of a document: opens `snapshot` (from [`KitAdapter::snapshot`]) with its
    /// blobs, as a new actor.
    fn join(&self, snapshot: &[u8], blobs: &Blobs) -> Result<Self::Doc>;
    /// The encoded version vector.
    fn version(&self, doc: &mut Self::Doc) -> Result<Vec<u8>>;
    /// The changes a replica at `since` lacks; empty `since` asks for every change.
    fn export_changes(&self, doc: &mut Self::Doc, since: &[u8]) -> Result<Vec<u8>>;
    /// Takes changes from a peer or from storage, in any order, any number of times.
    fn import_changes(&self, doc: &mut Self::Doc, bytes: &[u8]) -> Result<()>;
    fn snapshot(&self, doc: &mut Self::Doc) -> Result<Vec<u8>>;
    /// The canonical state (`Replica::state_json`).
    fn state(&self, doc: &mut Self::Doc) -> Result<Value>;
    /// Undoes this replica's last step; answers whether there was one.
    fn undo(&self, doc: &mut Self::Doc) -> Result<bool>;
    fn redo(&self, doc: &mut Self::Doc) -> Result<bool>;
    /// One random edit through the kit's commands; answers a label for the step log, or `None`
    /// when the picked command did not apply (nothing selected). A command the kit refuses for
    /// the document's state is `Ok(None)`, not an error.
    fn random_edit(&self, doc: &mut Self::Doc, rng: &mut Rng) -> Result<Option<String>>;

    /// Runs a scripted step; `Ok(false)` when the kit has no such step.
    fn script(&self, doc: &mut Self::Doc, step: &Script) -> Result<bool> {
        let _ = (doc, step);
        Ok(false)
    }
    /// The document's text in reading order, paragraphs joined by `\n`, or `None` when the kit has
    /// no text the suite can type into.
    fn text(&self, doc: &mut Self::Doc) -> Result<Option<String>> {
        let _ = doc;
        Ok(None)
    }
    /// Whether the view (what the engine renders and saves) matches the replica.
    fn check_view(&self, doc: &mut Self::Doc) -> Result<()> {
        let _ = doc;
        Ok(())
    }
    /// The blobs the replica holds, for a peer.
    fn blobs(&self, doc: &mut Self::Doc) -> Result<Blobs> {
        let _ = doc;
        Ok(Blobs::new())
    }
    /// Adds a peer's blobs.
    fn add_blobs(&self, doc: &mut Self::Doc, blobs: &Blobs) -> Result<()> {
        let _ = (doc, blobs);
        Ok(())
    }
    /// The document as file bytes, when the kit can save; `None` skips the export checks.
    fn export_file(&self, doc: &mut Self::Doc) -> Result<Option<Vec<u8>>> {
        let _ = doc;
        Ok(None)
    }
    /// Whether `ty.field` may name an object that no longer exists (a reference the kit keeps
    /// dangling on purpose and treats as a validation state, Kition platform `docs/platform/sets/model.md`).
    fn allows_dangling(&self, ty: &str, field: &str) -> bool {
        let _ = (ty, field);
        false
    }
    /// A large working document for [`perf`] (an imported fixture); `None` builds one from random
    /// edits.
    fn large(&self) -> Result<Option<Self::Doc>> {
        Ok(None)
    }
    /// One person's keystroke and the repaint it causes, for [`perf`]; the default is a random
    /// edit without painting.
    fn keystroke(&self, doc: &mut Self::Doc, rng: &mut Rng) -> Result<()> {
        self.random_edit(doc, rng).map(|_| ())
    }
}

/// A small deterministic random generator (xorshift64*), so failing seeds reproduce. The same
/// sequence as `kition_kdm::testing::Rng`.
#[derive(Clone, Debug)]
pub struct Rng(u64);

impl Rng {
    pub fn new(seed: u64) -> Self {
        Self(seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1)
    }

    pub fn next_u64(&mut self) -> u64 {
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        self.0.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }

    /// A value in `0..bound`, or 0 when `bound` is 0.
    pub fn below(&mut self, bound: usize) -> usize {
        match bound {
            0 => 0,
            _ => (self.next_u64() % bound as u64) as usize,
        }
    }

    /// `true` with `percent` percent probability.
    pub fn chance(&mut self, percent: u64) -> bool {
        self.next_u64() % 100 < percent
    }

    pub fn shuffle<T>(&mut self, items: &mut [T]) {
        for index in (1..items.len()).rev() {
            let other = self.below(index + 1);
            items.swap(index, other);
        }
    }

    /// One item, or `None` for an empty slice.
    pub fn pick<'a, T>(&mut self, items: &'a [T]) -> Option<&'a T> {
        items.get(self.below(items.len()))
    }
}
