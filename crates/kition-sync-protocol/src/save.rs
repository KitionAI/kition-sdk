//! The save state machine of a co-edited room (protocol 1.10, managed co-editing; Kition
//! platform docs/platform/managed-collab.md section 3): one state per room, kept by the server and
//! broadcast as `save/changed`, so exactly one session saves at a time and every editor shows the
//! same state. [`transition`] is the whole rule set; `@kition/sync`'s `saveTransition` is its
//! twin, and both are held to `tests/save-transitions.json`.

use serde::{Deserialize, Serialize};

/// `editing`, `force-save` (one session saves now), `must-save` (the last editor left with unsaved
/// changes), `corrupted` (a save was rejected as corrupt; saving stops until a good one), `closed`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SaveStatus {
    Editing,
    ForceSave,
    MustSave,
    Corrupted,
    Closed,
}

/// The longest host version a save may report (I6).
pub const SAVE_VERSION_LIMIT: usize = 256;

/// What started a save.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SaveTrigger {
    User,
    Timer,
    Command,
}

/// Why a save ended without a version.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SaveFailure {
    Conflict,
    Failed,
    Corrupted,
}

/// A room's save state, as `save/changed` and `room/resolve` carry it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveState {
    pub status: SaveStatus,
    pub dirty: bool,
    pub head_seq: u64,
    pub saved_seq: u64,
    pub version: Option<String>,
    pub trigger: Option<SaveTrigger>,
    /// The session (connection) running the save now (`force-save`), or that ran the last one; a
    /// server names sessions here, never principals, so one tab's save is not another's (I5).
    pub by: Option<String>,
    pub reason: Option<SaveFailure>,
    /// The change the running save writes (`force-save` only).
    pub saving_seq: Option<u64>,
}

impl SaveState {
    /// A new room's state: its creation snapshot is `version`.
    pub fn new(version: Option<String>) -> Self {
        Self { status: SaveStatus::Editing, dirty: false, head_seq: 0, saved_seq: 0, version, trigger: None, by: None, reason: None, saving_seq: None }
    }
}

/// What happens to a room, in the server's order.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum SaveEvent {
    Change {
        seq: u64,
        by: String,
    },
    Joined {
        by: String,
    },
    Begin {
        by: String,
        trigger: SaveTrigger,
    },
    End {
        by: String,
        seq: u64,
        version: Option<String>,
        #[serde(default)]
        error: Option<SaveFailure>,
    },
    Left {
        by: String,
        last: bool,
    },
}

/// Why an event was refused: another save runs (`conflict`), it is not this session's save
/// (`forbidden`), or a bad `seq` or an end with neither a version nor an error (`invalid`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SaveRefusal {
    Conflict,
    Forbidden,
    Invalid,
}

/// The state after `event`; a refused event leaves `state` as it was.
pub fn transition(state: &SaveState, event: &SaveEvent) -> Result<SaveState, SaveRefusal> {
    let mut next = state.clone();
    match event {
        SaveEvent::Change { seq, .. } => {
            next.head_seq = next.head_seq.max(*seq);
            next.dirty = next.head_seq > next.saved_seq;
            if next.status == SaveStatus::Closed {
                next.status = SaveStatus::Editing;
            }
        }
        SaveEvent::Joined { .. } => {
            if next.status == SaveStatus::Closed {
                next.status = SaveStatus::Editing;
            }
        }
        SaveEvent::Begin { by, trigger } => {
            if state.status == SaveStatus::ForceSave {
                return if state.by.as_deref() == Some(by.as_str()) { Ok(next) } else { Err(SaveRefusal::Conflict) };
            }
            // A clean room needs no version unless the person asked for one (SV2).
            if !state.dirty && *trigger != SaveTrigger::User {
                return Ok(next);
            }
            next.status = SaveStatus::ForceSave;
            next.trigger = Some(*trigger);
            next.by = Some(by.clone());
            next.saving_seq = Some(state.head_seq);
        }
        SaveEvent::End { by, seq, version, error } => {
            if state.status != SaveStatus::ForceSave || state.by.as_deref() != Some(by.as_str()) {
                return Err(SaveRefusal::Forbidden);
            }
            if state.saving_seq != Some(*seq) || (error.is_none() && version.is_none()) {
                return Err(SaveRefusal::Invalid);
            }
            if version.as_ref().is_some_and(|version| version.is_empty() || version.len() > SAVE_VERSION_LIMIT) {
                return Err(SaveRefusal::Invalid);
            }
            next.saving_seq = None;
            match error {
                Some(SaveFailure::Corrupted) => {
                    next.status = SaveStatus::Corrupted;
                    next.reason = Some(SaveFailure::Corrupted);
                }
                Some(failure) => {
                    next.status = SaveStatus::Editing;
                    next.reason = Some(*failure);
                }
                None => {
                    next.status = SaveStatus::Editing;
                    next.saved_seq = *seq;
                    next.version.clone_from(version);
                    next.dirty = next.head_seq > *seq;
                    next.reason = None;
                }
            }
        }
        SaveEvent::Left { by, last } => {
            // A save whose session went away ends without a version.
            if state.status == SaveStatus::ForceSave && state.by.as_deref() == Some(by.as_str()) {
                next.status = SaveStatus::Editing;
                next.saving_seq = None;
            }
            if *last && next.status != SaveStatus::Corrupted {
                next.status = if next.dirty { SaveStatus::MustSave } else { SaveStatus::Closed };
            }
        }
    }
    Ok(next)
}

/// `save/begin` (client to server, protocol 1.10): an editor of a joined room starts a save.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveBeginParams {
    pub doc_id: String,
    pub trigger: SaveTrigger,
}

/// Someone whose changes a save holds.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Author {
    pub principal_id: String,
    pub name: String,
}

/// `save` is the room's state after the call: `force-save` by the caller to write `seq`, or
/// unchanged for a clean room. `authors` are every principal whose changes are in
/// `(savedSeq, seq]`, from the server's own log.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveBeginResult {
    pub save: SaveState,
    pub seq: u64,
    pub authors: Vec<Author>,
    /// The server's signed save receipt (`ksr1.`, `kition_open_token::receipt`): the host verifies
    /// it and takes the authors, `seq` and generation from it, never from the page (I6).
    pub receipt: String,
}

/// `save/end` (client to server, protocol 1.10): the save of `seq` wrote `version`, or failed.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveEndParams {
    pub doc_id: String,
    pub seq: u64,
    pub version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<SaveFailure>,
}

/// `save/changed` (server to client, notification, protocol 1.10): after every transition.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveChangedParams {
    pub doc_id: String,
    pub save: SaveState,
}
