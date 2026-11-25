//! The object model (`KitObjectModel 1.0`): `model/describe` and `model/batch` for any contract 2
//! document, over [`kition_kdm::batch`].
//!
//! Two ways in:
//!
//! - **Direct**, for a [`KitSessionDocument`]: [`session_describe`] and [`session_batch`] write the
//!   session's own replica. A batch is one undo step of the document, and its commands run through
//!   [`KitSessionDocument::execute_as`]. [`export_kit_session!`](crate::export_kit_session) exports
//!   them as `modelDescribe()` and `modelBatch(json)`.
//! - **Exchange**, for any engine that exchanges changes ([`ReplicaPort`]): an [`Exchange`] keeps a
//!   scratch replica of the document on the host's side, catches it up with the engine's changes,
//!   runs the batch's model operations on it, and hands the new changes to the engine, which takes
//!   them as it takes a collaborator's (its merge repair runs). No kit change is needed; script
//!   edits then arrive as another actor's changes and are not in the person's undo history.

use std::sync::Arc;

use kition_kdm::batch::{self, BatchTarget};
use kition_kdm::{ActorId, Origin, Replica, Schema, Tx};
use serde_json::Value;

use super::{KitError, KitSessionDocument};
use crate::KitCommand;

pub use kition_kdm::batch::{BatchError as ModelError, BatchErrorCode as ModelErrorCode, CAPABILITY};

/// `model/describe`: the schema (`batch::describe`) with the kit's commands.
fn with_commands(mut described: Value, commands: &[KitCommand]) -> Value {
    described["commands"] = serde_json::to_value(commands).unwrap_or(Value::Array(Vec::new()));
    described
}

/// `model/describe` for a [`KitSessionDocument`].
pub fn session_describe<D: KitSessionDocument>(document: &D) -> Value {
    with_commands(batch::describe(document.session().replica()), &document.commands())
}

/// `model/batch` for a [`KitSessionDocument`]: one undo step; `read_only` refuses writes.
pub fn session_batch<D: KitSessionDocument>(document: &mut D, request: &Value, read_only: bool) -> Result<Value, ModelError> {
    let grouped = document.session_mut().begin_undo_group().is_ok();
    let answer = batch::run(&mut SessionTarget { document: &mut *document, read_only }, request);
    if grouped {
        document.session_mut().end_undo_group();
    }
    answer
}

struct SessionTarget<'a, D> {
    document: &'a mut D,
    read_only: bool,
}

fn in_context<D: crate::KitDocument>(document: &mut D, context: &Value, run: impl FnOnce(&mut D) -> Result<Value, String>) -> Result<Value, String> {
    let context: crate::CallContext = serde_json::from_value(context.clone()).map_err(|error| error.to_string())?;
    if context.is_empty() {
        return run(document);
    }
    let state = document.editor_state();
    let result = document.set_context(&context).and_then(|()| run(document));
    let restored = document.restore_editor_state(&state);
    match (result, restored) {
        (_, Err(error)) => Err(error),
        (result, Ok(())) => result,
    }
}

impl<D: KitSessionDocument> BatchTarget for SessionTarget<'_, D> {
    fn projected_objects(&mut self) -> Result<Vec<kition_kdm::projection::ProjectedObject>, ModelError> {
        self.document.projected_objects().map_err(failed)
    }
    fn value_limits(&mut self) -> Option<batch::ValueLimits> {
        self.document.value_limits()
    }
    fn replica(&mut self) -> Result<&Replica, ModelError> {
        Ok(self.document.session().replica())
    }

    fn transact(&mut self, origin: &Origin, write: &mut dyn FnMut(&mut Tx<'_>) -> Result<(), ModelError>) -> Result<(), ModelError> {
        let mut batch_error = None;
        let settle = self.document.batch_settler();
        let result = self.document.session_mut().execute(origin, |_, tx| {
            write(tx).and_then(|()| settle.as_ref().map_or(Ok(()), |settle| settle(tx).map_err(failed))).map_err(|error| {
                batch_error = Some(error);
                KitError::new("the batch failed")
            })
        });
        match (result, batch_error) {
            (_, Some(error)) => Err(error),
            (Ok(_), None) => {
                self.document.batch_applied();
                Ok(())
            }
            (Err(error), None) => Err(ModelError::new(ModelErrorCode::InvalidValue, None, error.to_string())),
        }
    }

    /// Through the gate of the call the host runs (`crate::dispatch`), as `commands.execute`.
    fn command(&mut self, id: &str, params: Value, origin: &Origin) -> Result<Value, String> {
        crate::dispatch::may_run(id, &params)?;
        self.document.execute_as(id, params, origin)
    }
    fn command_at(&mut self, id: &str, params: Value, context: &Value, origin: &Origin) -> Result<Value, String> {
        in_context(self.document, context, |doc| {
            crate::dispatch::may_run(id, &params)?;
            doc.execute_as(id, params, origin)
        })
    }

    fn read_only(&self) -> bool {
        self.read_only
    }
}

/// An engine that exchanges changes with other replicas of its document: every contract 2 kit's
/// engine has these members (`exportChanges`, `importChanges`, `executeAs` in JavaScript).
pub trait ReplicaPort {
    /// The kit's schema (`model/schema.json`).
    fn model_schema(&self) -> Arc<Schema>;
    /// The changes since the encoded version `since`; empty bytes ask for every change.
    fn model_export(&mut self, since: &[u8]) -> Result<Vec<u8>, String>;
    /// Takes changes made elsewhere, as from a collaborator.
    fn model_import(&mut self, bytes: &[u8]) -> Result<(), String>;
    /// Adds the media changes reference (pixels, embedded files), in the kits' blob encoding
    /// (see [`ReplicaPort::model_open_replica`]), before the [`ReplicaPort::model_import`] that
    /// needs them. A kit whose changes carry no blobs keeps the default, which takes none.
    fn model_add_blobs(&mut self, blobs: &[u8]) -> Result<(), String> {
        if blobs.is_empty() { Ok(()) } else { Err("this kit's changes carry no blobs".into()) }
    }
    /// The blobs a replica at the encoded version `since` needs for the changes since then (empty
    /// bytes: every blob the current state references), in the same encoding. None by default.
    fn model_blobs_since(&mut self, _since: &[u8]) -> Result<Vec<u8>, String> {
        Ok(Vec::new())
    }
    /// Runs a command as `origin`.
    fn model_command(&mut self, command: &str, params: Value, origin: &Origin) -> Result<Value, String>;
    /// The kit's commands, for `model/describe`.
    fn model_commands(&self) -> Vec<KitCommand>;
    /// Opens a replica of a shared document that has no file yet, as a server's headless kit
    /// opens a sync room's state (`model.open` in `kition-headless`): `snapshot` is a KDM snapshot
    /// or a full change export, and `blobs` the media it references in the kits' blob encoding,
    /// `(64-char hex SHA-256, u64 LE length, bytes) * N` (empty for none). The document is the
    /// replica's alone, under a fresh actor. Kits answer with their `open_with_replica(name, &[],
    /// snapshot, blobs)`, but must fail rather than fall back to an empty document: a server
    /// checks changes against what this opens. By default a kit cannot.
    fn model_open_replica(_name: &str, _snapshot: &[u8], _blobs: &[u8]) -> Result<Self, String>
    where
        Self: Sized,
    {
        Err("this kit cannot open a document from its replica yet".into())
    }
}

/// The host's side of the object model over a [`ReplicaPort`]: a scratch replica of one document.
#[derive(Default)]
pub struct Exchange {
    scratch: Option<Replica>,
}

impl Exchange {
    pub fn new() -> Self {
        Self::default()
    }

    /// `model/describe` for the port's document.
    pub fn describe<P: ReplicaPort>(&mut self, port: &mut P) -> Result<Value, ModelError> {
        let commands = port.model_commands();
        let replica = catch_up(&mut self.scratch, port)?;
        Ok(with_commands(batch::describe(replica), &commands))
    }

    /// `model/batch` for the port's document; `read_only` refuses writes.
    pub fn batch<P: ReplicaPort + crate::KitDocument>(&mut self, port: &mut P, request: &Value, read_only: bool) -> Result<Value, ModelError> {
        let settle = port.batch_settler();
        let answer = batch::run(&mut ExchangeTarget { scratch: &mut self.scratch, port, read_only, settle }, request);
        if answer.as_ref().is_err_and(|error| error.message.starts_with(REFUSED)) {
            // The engine has not taken what the scratch replica holds: start again from the engine.
            self.scratch = None;
        }
        answer
    }

    /// The scratch replica, caught up with the engine: what `model.version` and `model.changes`
    /// read (the document's version, and what changed since one).
    pub fn replica<P: ReplicaPort>(&mut self, port: &mut P) -> Result<&Replica, ModelError> {
        catch_up(&mut self.scratch, port)
    }

    /// Forgets the scratch replica (the engine opened another document).
    pub fn reset(&mut self) {
        self.scratch = None;
    }
}

const REFUSED: &str = "the kit refused the changes";

fn failed(message: impl std::fmt::Display) -> ModelError {
    ModelError::new(ModelErrorCode::InvalidValue, None, message.to_string())
}

/// The scratch replica, caught up with the engine.
fn catch_up<'a, P: ReplicaPort>(scratch: &'a mut Option<Replica>, port: &mut P) -> Result<&'a Replica, ModelError> {
    match scratch {
        Some(replica) => {
            let changes = port.model_export(&replica.version().encode()).map_err(failed)?;
            match replica.import_changes(&changes) {
                Ok(_) => {}
                Err(kition_kdm::KdmError::WrongDocument { .. } | kition_kdm::KdmError::Stale(_)) => {
                    // A command may replace the engine's document. Histories of distinct
                    // documents never merge; load the replacement under a fresh actor.
                    *scratch = None;
                    let all = port.model_export(&[]).map_err(failed)?;
                    *scratch = Some(Replica::load(port.model_schema(), &all, ActorId::random()).map_err(failed)?);
                }
                Err(error) => return Err(failed(error)),
            }
        }
        None => {
            let all = port.model_export(&[]).map_err(failed)?;
            *scratch = Some(Replica::load(port.model_schema(), &all, ActorId::random()).map_err(failed)?);
        }
    }
    scratch.as_ref().ok_or_else(|| failed("no replica"))
}

struct ExchangeTarget<'a, P> {
    scratch: &'a mut Option<Replica>,
    port: &'a mut P,
    read_only: bool,
    settle: Option<crate::BatchSettler>,
}

impl<P: ReplicaPort + crate::KitDocument> BatchTarget for ExchangeTarget<'_, P> {
    fn projected_objects(&mut self) -> Result<Vec<kition_kdm::projection::ProjectedObject>, ModelError> {
        self.port.projected_objects().map_err(failed)
    }
    fn value_limits(&mut self) -> Option<batch::ValueLimits> {
        self.port.value_limits()
    }
    fn replica(&mut self) -> Result<&Replica, ModelError> {
        catch_up(self.scratch, self.port)
    }

    fn transact(&mut self, origin: &Origin, write: &mut dyn FnMut(&mut Tx<'_>) -> Result<(), ModelError>) -> Result<(), ModelError> {
        catch_up(self.scratch, self.port)?;
        let replica = self.scratch.as_mut().ok_or_else(|| failed("no replica"))?;
        let before = replica.version();
        batch::transact_replica(replica, origin, &mut |tx| {
            write(tx)?;
            self.settle.as_ref().map_or(Ok(()), |settle| settle(tx).map_err(failed))
        })?;
        if replica.version() == before {
            return Ok(());
        }
        let changes = replica.export_changes(&before).map_err(failed)?;
        self.port.model_import(&changes).map_err(|message| failed(format!("{REFUSED}: {message}")))?;
        self.port.batch_applied();
        Ok(())
    }

    /// Through the gate of the call the host runs (`crate::dispatch`), as `commands.execute`.
    fn command(&mut self, id: &str, params: Value, origin: &Origin) -> Result<Value, String> {
        crate::dispatch::may_run(id, &params)?;
        self.port.model_command(id, params, origin)
    }
    fn command_at(&mut self, id: &str, params: Value, context: &Value, origin: &Origin) -> Result<Value, String> {
        in_context(self.port, context, |port| {
            crate::dispatch::may_run(id, &params)?;
            port.model_command(id, params, origin)
        })
    }

    fn read_only(&self) -> bool {
        self.read_only
    }
}
