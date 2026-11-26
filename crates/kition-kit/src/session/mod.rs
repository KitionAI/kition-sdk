//! Engine contract 2: a kit keeps its document as a KDM replica ([`crate::kdm`]).
//!
//! The engine implements [`KitModel`]: its materialised view of the document, loaded from a
//! replica and patched from the objects that changed. [`KitSession`] owns everything else: the
//! replica, per-person undo, the change exchange, the post-merge repair, and the blobs. Commands
//! become transactions ([`KitSession::execute`]); the view follows from the replica, never the
//! other way round. [`export_kit_session!`](crate::export_kit_session) adds the contract 2 members
//! to the class [`export_kit_document!`](crate::export_kit_document) made.

use std::collections::{BTreeSet, HashMap};
use std::hash::Hash;
use std::sync::Arc;

use kition_kdm::{ActorId, KdmError, ObjectId, Origin, Replica, Schema, Tx, UndoOutcome, UndoScope, Version};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

pub mod model;
mod state;
mod text;
mod web;

pub use state::{State, state, take_file, write_state};
pub use text::{DIFF_BUDGET, TextEdit, TextRun, diff_text, write_marks, write_rich_text, write_text};
pub use web::KitSessionDocument;
#[doc(hidden)]
pub use web::{
    __author_schema_version, __can_redo, __can_undo, __changes_since, __compare_changes, __execute_as, __export_changes, __import_changes, __merge_changes,
    __model_batch, __model_describe, __model_reply, __redo, __restore_state, __schema_version, __snapshot, __undo, __version,
};

/// A failure of a kit session: the KDM's, or the kit's own message.
#[derive(Debug, Clone, PartialEq, thiserror::Error)]
#[non_exhaustive]
pub enum KitError {
    #[error(transparent)]
    Kdm(#[from] KdmError),
    #[error("{0}")]
    Kit(String),
}

impl KitError {
    pub fn new(message: impl Into<String>) -> Self {
        Self::Kit(message.into())
    }
}

impl From<String> for KitError {
    fn from(message: String) -> Self {
        Self::Kit(message)
    }
}

impl From<&str> for KitError {
    fn from(message: &str) -> Self {
        Self::Kit(message.to_owned())
    }
}

/// Contract 1 reports errors as plain messages.
impl From<KitError> for String {
    fn from(error: KitError) -> Self {
        error.to_string()
    }
}

pub type Result<T, E = KitError> = std::result::Result<T, E>;

/// A KDM `blob` field's value: `{ "hash": "<sha256 hex>", "mime": "...", "size": n }`.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct BlobRef {
    pub hash: String,
    pub mime: String,
    pub size: u64,
}

/// Where a session reads blob bytes by hash.
pub trait BlobSource {
    fn get(&self, hash: &str) -> Option<Arc<[u8]>>;
}

/// A blob store that also takes new blobs.
pub trait BlobSink: BlobSource {
    /// Stores `bytes` under their SHA-256 (lowercase hex) and answers the reference.
    fn put(&mut self, bytes: &[u8], mime: &str) -> BlobRef;
}

/// Blobs in memory, for tests and for hosts that hand a document its blobs up front.
#[derive(Clone, Debug, Default)]
pub struct MemoryBlobs(pub HashMap<String, Arc<[u8]>>);

impl BlobSource for MemoryBlobs {
    fn get(&self, hash: &str) -> Option<Arc<[u8]>> {
        self.0.get(hash).cloned()
    }
}

impl BlobSink for MemoryBlobs {
    fn put(&mut self, bytes: &[u8], mime: &str) -> BlobRef {
        let hash = sha256_hex(bytes);
        self.0.entry(hash.clone()).or_insert_with(|| Arc::from(bytes));
        BlobRef { hash, mime: mime.to_owned(), size: bytes.len() as u64 }
    }
}

/// SHA-256 as lowercase hex, the hash of a [`BlobRef`].
pub fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().map(|byte| format!("{byte:02x}")).collect()
}

/// What a change made stale on screen. Rects are `[x0, y0, x1, y1]` in document pixels, the area
/// convention of [`crate::KitDocument::render_area`]. As JSON: `{"kind":"none"}`,
/// `{"kind":"full"}`, or `{"kind":"rects","rects":[[x0,y0,x1,y1],...]}`.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "rects", rename_all = "camelCase")]
pub enum Damage {
    #[default]
    None,
    Full,
    Rects(Vec<[i32; 4]>),
}

impl Damage {
    /// Both damages: `Full` absorbs everything, rects add up.
    #[must_use]
    pub fn merge(self, other: Damage) -> Damage {
        match (self, other) {
            (Damage::Full, _) | (_, Damage::Full) => Damage::Full,
            (Damage::None, other) | (other, Damage::None) => other,
            (Damage::Rects(mut rects), Damage::Rects(more)) => {
                rects.extend(more);
                Damage::Rects(rects)
            }
        }
    }
}

/// A kit's engine under contract 2: its view of a KDM document.
pub trait KitModel: Sized {
    /// The kit's schema (`model/schema.json`).
    fn schema() -> Arc<Schema>;
    /// The view of the whole document.
    fn load(replica: &Replica, blobs: &dyn BlobSource) -> Result<Self>;
    /// Patches the view after `changed` objects changed (created, edited, or deleted) in
    /// `replica`, rather than rebuilding it (E11). If it fails, the session reloads the view.
    fn apply(&mut self, replica: &Replica, changed: &BTreeSet<ObjectId>, blobs: &dyn BlobSource) -> Result<Damage>;
    /// Deterministic repair after a merge (E14), such as dropping list entries of deleted
    /// objects; answers whether it wrote anything. It reads and writes through `tx` and has no
    /// `self`: the view is stale until the change and the repair are applied to it together. After
    /// a draft's merge or a restore it runs inside that change, so its writes are part of the same
    /// undo step (data model 6.6, D9); after an import, an undo or a redo, in the session's own
    /// `system` transaction. Every replica runs it, so it must give the same writes for the same
    /// state.
    fn validate(tx: &mut Tx<'_>, changed: &BTreeSet<ObjectId>) -> Result<bool>;
    /// A new document from a file (E13); bulk content goes in `Replica::create_with` (P2).
    fn import(name: &str, bytes: &[u8], blobs: &mut dyn BlobSink, actor: ActorId) -> Result<Replica>;
    /// The document as file bytes in `name`'s format.
    fn export(&self, replica: &Replica, name: &str, blobs: &dyn BlobSource) -> Result<Vec<u8>>;
}

/// One open document under contract 2: the replica, the kit's view of it, and its blobs.
pub struct KitSession<M: KitModel> {
    replica: Replica,
    model: M,
    blobs: Box<dyn BlobSink + Send>,
}

/// The kit's repair ([`KitModel::validate`]) as a merge runs it in its transaction
/// (`Replica::merge_changes_repaired`): a kit error that is not the KDM's is kept in `kit_error`,
/// for the caller to answer in place of the merge's refusal.
fn repair<M: KitModel>(kit_error: &mut Option<KitError>) -> impl FnOnce(&mut Tx<'_>, &BTreeSet<ObjectId>) -> kition_kdm::Result<()> + '_ {
    move |tx, changed| {
        M::validate(tx, changed).map(drop).map_err(|error| match error {
            KitError::Kdm(error) => error,
            other => {
                *kit_error = Some(other);
                KdmError::Engine("the kit's repair of the merge failed".into())
            }
        })
    }
}

impl<M: KitModel> KitSession<M> {
    /// Opens a snapshot (or a full change export) as a replica of `actor`.
    pub fn open_snapshot(bytes: &[u8], blobs: Box<dyn BlobSink + Send>, actor: ActorId) -> Result<Self> {
        let replica = Replica::load(M::schema(), bytes, actor)?;
        Self::attach(replica, blobs)
    }

    /// A new document from a file, through [`KitModel::import`].
    pub fn import(name: &str, bytes: &[u8], mut blobs: Box<dyn BlobSink + Send>, actor: ActorId) -> Result<Self> {
        let replica = M::import(name, bytes, blobs.as_mut(), actor)?;
        Self::attach(replica, blobs)
    }

    /// A session over a replica the kit made itself (a new, empty document).
    pub fn from_replica(replica: Replica, blobs: Box<dyn BlobSink + Send>) -> Result<Self> {
        Self::attach(replica, blobs)
    }

    fn attach(mut replica: Replica, blobs: Box<dyn BlobSink + Send>) -> Result<Self> {
        replica.take_changed();
        let model = M::load(&replica, blobs.as_ref())?;
        Ok(Self { replica, model, blobs })
    }

    /// Runs one transaction with `origin` (E12). `f` reads the view and writes the transaction;
    /// if it fails, nothing changes. Then the changed objects are applied to the view. Answers
    /// `f`'s result and the damage.
    pub fn execute<R>(&mut self, origin: &Origin, f: impl FnOnce(&M, &mut Tx<'_>) -> Result<R>) -> Result<(R, Damage)> {
        let model = &self.model;
        let value = transact(&mut self.replica, origin, |tx| f(model, tx))?;
        let changed = self.replica.take_changed();
        Ok((value, self.refresh(&changed)?))
    }

    /// Applies a validated file difference to the existing replica as an import transaction.
    /// The kit resolves imported identities and writes only changed values in `reconcile`.
    /// Both undo histories stay attached; outside writes are never new undo steps.
    pub fn reread(&mut self, reconcile: impl FnOnce(&M, &mut Tx<'_>) -> Result<()>) -> Result<Damage> {
        self.execute(&Origin::new(kition_kdm::OriginKind::Import, "file reread"), reconcile).map(|(_, damage)| damage)
    }

    /// Writes one transaction without applying it to the view: for bridges that already changed
    /// their own view and turn that change into a transaction. Undo and imports still patch the
    /// view from the replica.
    pub fn record<R>(&mut self, origin: &Origin, f: impl FnOnce(&mut Tx<'_>) -> Result<R>) -> Result<R> {
        let value = transact(&mut self.replica, origin, f)?;
        self.replica.take_changed();
        Ok(value)
    }

    /// Undoes this replica's last person or agent transaction (never imports or repairs).
    /// Answers whether there was one, and the damage. Then repairs the result like
    /// [`KitSession::import_changes`]: an undo can bring back state that later edits made invalid.
    pub fn undo(&mut self) -> Result<(bool, Damage)> {
        let done = self.replica.undo()?.is_done();
        Ok((done, self.settle()?))
    }

    /// Repairs the result like [`KitSession::undo`].
    pub fn redo(&mut self) -> Result<(bool, Damage)> {
        let done = self.replica.redo()?.is_done();
        Ok((done, self.settle()?))
    }

    /// Undoes the last transaction of `scope` (KitModel M12a): an agent's undo takes back only the
    /// agent's steps, and the person's (`undo`) only the person's. Repairs the result like
    /// [`KitSession::undo`].
    pub fn undo_in(&mut self, scope: UndoScope) -> Result<(bool, Damage)> {
        let (outcome, damage) = self.undo_in_outcome(scope)?;
        Ok((outcome.is_done(), damage))
    }

    /// Redoes the last undone transaction of `scope`, like [`KitSession::undo_in`].
    pub fn redo_in(&mut self, scope: UndoScope) -> Result<(bool, Damage)> {
        let (outcome, damage) = self.redo_in_outcome(scope)?;
        Ok((outcome.is_done(), damage))
    }

    /// [`KitSession::undo_in`] answering which steps the undo took off the stack
    /// ([`UndoOutcome`]: the steps passed over, top first, and the one taken back) instead of
    /// whether it took one. A kit that keeps its own labels or entries beside the replica's
    /// history drops one for each step the outcome names ([`UndoOutcome::steps`]): an undo that
    /// passes over a step with nothing left to change takes two off the stack.
    pub fn undo_in_outcome(&mut self, scope: UndoScope) -> Result<(UndoOutcome, Damage)> {
        let outcome = self.replica.undo_in(scope)?;
        Ok((outcome, self.settle()?))
    }

    /// [`KitSession::redo_in`] answering which steps it took, like [`KitSession::undo_in_outcome`].
    pub fn redo_in_outcome(&mut self, scope: UndoScope) -> Result<(UndoOutcome, Damage)> {
        let outcome = self.replica.redo_in(scope)?;
        Ok((outcome, self.settle()?))
    }

    /// [`Replica::undo_depth`]: how many undo steps `scope` holds. A kit that keeps an undo label
    /// of its own per step keeps this many (a `model/batch` is one step, its commands included).
    pub fn undo_depth(&self, scope: UndoScope) -> usize {
        self.replica.undo_depth(scope)
    }

    /// [`Replica::redo_depth`].
    pub fn redo_depth(&self, scope: UndoScope) -> usize {
        self.replica.redo_depth(scope)
    }

    /// [`Replica::in_undo_group`]: whether an undo group (a `model/batch`) is open, so a command
    /// run now joins the group's step instead of adding one.
    pub fn in_undo_group(&self) -> bool {
        self.replica.in_undo_group()
    }

    pub fn can_undo_in(&self, scope: UndoScope) -> bool {
        self.replica.can_undo_in(scope)
    }

    pub fn can_redo_in(&self, scope: UndoScope) -> bool {
        self.replica.can_redo_in(scope)
    }

    pub fn undo_touches_in(&self, scope: UndoScope) -> Vec<kition_kdm::UndoTouch> {
        self.replica.undo_touches_in(scope)
    }

    pub fn redo_touches_in(&self, scope: UndoScope) -> Vec<kition_kdm::UndoTouch> {
        self.replica.redo_touches_in(scope)
    }

    pub fn can_undo(&self) -> bool {
        self.replica.can_undo()
    }

    pub fn can_redo(&self) -> bool {
        self.replica.can_redo()
    }

    /// The transactions until [`KitSession::end_undo_group`] undo as one step.
    pub fn begin_undo_group(&mut self) -> Result<()> {
        Ok(self.replica.begin_undo_group()?)
    }

    pub fn end_undo_group(&mut self) {
        self.replica.end_undo_group();
    }

    pub fn version(&self) -> Version {
        self.replica.version()
    }

    pub fn export_changes(&self, since: &Version) -> Result<Vec<u8>> {
        Ok(self.replica.export_changes(since)?)
    }

    /// Imports remote or stored changes, repairs the merged state with [`KitModel::validate`] in
    /// a `system` transaction labelled `repair`, and applies both to the view.
    pub fn import_changes(&mut self, bytes: &[u8]) -> Result<Damage> {
        self.replica.import_changes(bytes)?;
        self.settle()
    }

    /// A draft of the document (standard 2.0 A12): a session on a fork of this one's replica,
    /// with its own actor and a copy of its blobs.
    pub fn fork(&self, actor: ActorId, blobs: Box<dyn BlobSink + Send>) -> Result<Self> {
        Self::attach(self.replica.fork(actor)?, blobs)
    }

    /// Takes a draft's changes (its changes since it was forked) into this document as one
    /// transaction with `origin` (`Replica::merge_changes_repaired`): one undo step, the edits made
    /// here since the fork kept. The kit's repair ([`KitModel::validate`]) of the merged state is
    /// part of that change and that step (data model 6.6, D9): one undo gives back the exact state
    /// before the merge, one redo the exact repaired state. A repair that fails refuses the merge,
    /// which changes nothing. Applies the result to the view. Add the draft's blobs first.
    ///
    /// Answers the undo scope the step was recorded in with the damage: the person's, also for an
    /// agent's `origin` (KitModel M12a: the person accepted the draft), `None` when no step was
    /// recorded. A kit that keeps undo labels or a history of its own records the step there.
    pub fn merge_changes(&mut self, bytes: &[u8], origin: &Origin) -> Result<(Option<UndoScope>, Damage)> {
        let mut kit_error = None;
        let merged = self.replica.merge_changes_repaired(bytes, origin, repair::<M>(&mut kit_error));
        let merged = kit_error.map_or(Ok(()), Err).and(merged.map_err(KitError::from))?;
        let changed = self.replica.take_changed();
        Ok((merged.scope, self.refresh(&changed)?))
    }

    /// What merging a draft's changes would change in the document now, the kit's repair
    /// ([`KitModel::validate`]) included as [`KitSession::merge_changes`] runs it
    /// (`Replica::compare_changes_repaired`), so a draft's preview is what accepting it gives;
    /// nothing changes. Refuses what the merge refuses. The repair runs on a copy for every
    /// comparison: a repair that reads only the objects it is given costs what they cost.
    pub fn compare_changes(&self, bytes: &[u8]) -> Result<kition_kdm::diff::StateDiff> {
        let mut kit_error = None;
        let compared = self.replica.compare_changes_repaired(bytes, repair::<M>(&mut kit_error));
        kit_error.map_or(Ok(()), Err).and(compared.map_err(KitError::from))
    }

    /// The canonical state merging a draft's changes would give, the kit's repair included
    /// (`Replica::merged_state_repaired`, see [`KitSession::compare_changes`]); nothing changes.
    pub fn merged_state(&self, bytes: &[u8]) -> Result<Value> {
        let mut kit_error = None;
        let merged = self.replica.merged_state_repaired(bytes, repair::<M>(&mut kit_error));
        kit_error.map_or(Ok(()), Err).and(merged.map_err(KitError::from))
    }

    /// Writes the state `snapshot` holds (a snapshot or content of this document, as a host's
    /// checkpoint keeps it) over the document as one transaction with `origin` ([`write_state`],
    /// keyed by object id), the kit's repair ([`KitModel::validate`]) of the restored state in it:
    /// one undo step of the person for a person's origin, whose undo gives back the exact state
    /// before. Nothing changes
    /// when the states are equal. Refuses ([`KdmError::WrongDocument`]) another document's.
    pub fn restore_state(&mut self, snapshot: &[u8], origin: &Origin) -> Result<Damage> {
        let schema = M::schema();
        let loaded = Replica::load(Arc::clone(&schema), snapshot, self.replica.actor())?;
        if loaded.doc_id() != self.replica.doc_id() {
            return Err(KdmError::WrongDocument { expected: self.replica.doc_id().to_string(), found: loaded.doc_id().to_string() }.into());
        }
        let (now, then) = (state(&self.replica)?, state(&loaded)?);
        if now == then {
            return Ok(Damage::None);
        }
        // The kit's repair of the restored state is part of the restore's one change and undo step.
        let changed: BTreeSet<ObjectId> = now.keys().chain(then.keys()).filter(|id| now.get(*id) != then.get(*id)).map(ObjectId::from_string).collect();
        self.execute(origin, |_, tx| {
            write_state(tx, &schema, &now, &then)?;
            M::validate(tx, &changed).map(drop)
        })
        .map(|((), damage)| damage)
    }

    /// The document's state with its version ([`Replica::snapshot`]): for the host's store,
    /// drafts and new replicas, never for a person's file.
    pub fn snapshot(&self) -> Result<Vec<u8>> {
        Ok(self.replica.snapshot()?)
    }

    /// The document's content for a person's file ([`Replica::content_snapshot`]): the state, no
    /// history, the same bytes for the same state.
    pub fn content_snapshot(&self) -> Result<Vec<u8>> {
        Ok(self.replica.content_snapshot()?)
    }

    pub fn state_hash(&self) -> Result<String> {
        Ok(self.replica.state_hash()?)
    }

    /// The document as file bytes, through [`KitModel::export`].
    pub fn export(&self, name: &str) -> Result<Vec<u8>> {
        self.model.export(&self.replica, name, self.blobs.as_ref())
    }

    pub fn model(&self) -> &M {
        &self.model
    }

    /// For view-only state (selection, scroll); document state changes through transactions.
    pub fn model_mut(&mut self) -> &mut M {
        &mut self.model
    }

    pub fn replica(&self) -> &Replica {
        &self.replica
    }

    pub fn blobs(&self) -> &dyn BlobSink {
        self.blobs.as_ref()
    }

    pub fn blobs_mut(&mut self) -> &mut dyn BlobSink {
        self.blobs.as_mut()
    }

    /// After an import, undo, or redo: runs [`KitModel::validate`] over what changed in a
    /// `system` transaction labelled `repair` (not an undo step), then applies both to the view.
    /// The view is applied even if the repair fails, so it always matches the replica.
    fn settle(&mut self) -> Result<Damage> {
        let mut changed = self.replica.take_changed();
        let repaired = if changed.is_empty() { Ok(false) } else { transact(&mut self.replica, &Origin::system("repair"), |tx| M::validate(tx, &changed)) };
        changed.extend(self.replica.take_changed());
        let damage = self.refresh(&changed)?;
        repaired?;
        Ok(damage)
    }

    /// Applies `changed` to the view; if that fails, reloads the view so it still matches.
    fn refresh(&mut self, changed: &BTreeSet<ObjectId>) -> Result<Damage> {
        if changed.is_empty() {
            return Ok(Damage::None);
        }
        match self.model.apply(&self.replica, changed, self.blobs.as_ref()) {
            Ok(damage) => Ok(damage),
            Err(_) => {
                self.model = M::load(&self.replica, self.blobs.as_ref())?;
                Ok(Damage::Full)
            }
        }
    }
}

/// The undo scope an `edit.undo` or `edit.redo` works in (KitModel M12a): the one its `scope`
/// parameter names (`"person"` or `"agent"`), else its origin's (`agent` for an agent's step,
/// `person` for the person's and for scripts). A `scope` that names neither is an error.
pub fn history_scope(params: &Value, origin: &Origin) -> Result<UndoScope> {
    match params.get("scope") {
        None | Some(Value::Null) => Ok(UndoScope::of(origin.kind).unwrap_or(UndoScope::Person)),
        Some(Value::String(scope)) => {
            UndoScope::parse(scope).ok_or_else(|| KitError::Kit(format!("invalid-params: scope is \"person\" or \"agent\", not {scope:?}")))
        }
        Some(other) => Err(KitError::Kit(format!("invalid-params: scope is \"person\" or \"agent\", not {other}"))),
    }
}

/// [`Replica::transact`] with a closure that fails with a [`KitError`]: the KDM's closure must
/// fail with a [`KdmError`], so a kit's own error is kept aside and returned instead.
fn transact<R>(replica: &mut Replica, origin: &Origin, f: impl FnOnce(&mut Tx<'_>) -> Result<R>) -> Result<R> {
    let mut kit_error = None;
    let result = replica.transact(origin, |tx| {
        f(tx).map_err(|error| match error {
            KitError::Kdm(error) => error,
            other => {
                kit_error = Some(other);
                KdmError::Engine("the kit refused the transaction".into())
            }
        })
    });
    match (result, kit_error) {
        (_, Some(error)) => Err(error),
        (result, None) => Ok(result?),
    }
}

/// Object ids to a kit's own local ids (layer indices, handles) and back. The kit rebuilds it
/// when it loads its view.
#[derive(Clone, Debug)]
pub struct IdMap<L> {
    local: HashMap<ObjectId, L>,
    object: HashMap<L, ObjectId>,
}

impl<L> Default for IdMap<L> {
    fn default() -> Self {
        Self { local: HashMap::new(), object: HashMap::new() }
    }
}

impl<L: Copy + Eq + Hash> IdMap<L> {
    /// Maps `id` to `local`, replacing either's earlier mapping.
    pub fn insert(&mut self, id: ObjectId, local: L) {
        self.remove(&id);
        if let Some(old) = self.object.remove(&local) {
            self.local.remove(&old);
        }
        self.object.insert(local, id.clone());
        self.local.insert(id, local);
    }

    pub fn local(&self, id: &ObjectId) -> Option<L> {
        self.local.get(id).copied()
    }

    pub fn object(&self, local: L) -> Option<&ObjectId> {
        self.object.get(&local)
    }

    /// Forgets `id`; answers its local id.
    pub fn remove(&mut self, id: &ObjectId) -> Option<L> {
        let local = self.local.remove(id)?;
        self.object.remove(&local);
        Some(local)
    }

    /// Forgets `local`; answers its object id.
    pub fn remove_local(&mut self, local: L) -> Option<ObjectId> {
        let id = self.object.remove(&local)?;
        self.local.remove(&id);
        Some(id)
    }

    pub fn clear(&mut self) {
        self.local.clear();
        self.object.clear();
    }

    pub fn len(&self) -> usize {
        self.local.len()
    }

    pub fn is_empty(&self) -> bool {
        self.local.is_empty()
    }
}

/// A JSON value's text, for the contract 2 answers.
fn json(value: &impl Serialize) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| Value::Null.to_string())
}
