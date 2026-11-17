//! A kit as a training and evaluation environment, with no code for any one kit: whatever
//! a kit's headless executable serves through the kits server's agent tools is enough.
//!
//! - [`generate`]: editing tasks with ground truth from a workspace of files. A seeded sampler
//!   picks a generic edit the kit's object model can express (set a field, replace a text, delete,
//!   move, create), applies it to a copy through the kit's own `<prefix>_batch`, and keeps it only
//!   when the kit accepts it without a new error diagnostic; the edit's receipt is the ground
//!   truth, and the instruction names objects as a person would ([`Reference`]).
//! - [`score_files`] and [`score_changes`]: a [`Reward`] for an attempt made by any means, from
//!   the document's states before and after it (or, when asked, from its own receipt).
//! - [`trace`]: a [`Solver`]'s tool calls and results as a trace; the built-in [`Oracle`] replays
//!   the ground truth through the agent-facing tools.
//! - [`Environment`]: `reset`, `step`, `score`, transport-free.
//!
//! The command line is `kit-env` (`src/bin/kit-env.rs`); the formats and the reward are described
//! in `docs/sdk/env.md`.

mod changes;
mod environment;
mod generate;
mod instruction;
mod replay;
mod rng;
mod score;
mod session;
mod snapshot;
mod stats;
mod structural;
mod task;
mod trace;

use std::path::PathBuf;

use kition_kits::KitDefinition;

pub use changes::ops_for;
pub use environment::{Environment, Observation, Step};
pub use generate::{EDIT_KINDS, GenerateOptions, Generated, VOCABULARY, generate};
pub use score::{Reward, ScoreOptions, score_changes, score_files};
pub use snapshot::{Reference, Snapshot, read_snapshot};
pub use stats::stats;
pub use task::Task;
pub use trace::{Oracle, OracleOptions, Solver, Trace, TraceStep, trace, verified_traces, without_images};

/// A kit the environment runs: its definition (from its `kit.json`) and its headless executable.
#[derive(Clone, Debug)]
pub struct EnvKit {
    pub definition: &'static KitDefinition,
    pub executable: Option<PathBuf>,
}

impl EnvKit {
    pub fn new(definition: &'static KitDefinition, executable: Option<PathBuf>) -> Self {
        Self { definition, executable }
    }

    /// The kit's tool for `action` (`<prefix>_batch` for `batch`).
    pub fn tool(&self, action: &str) -> String {
        format!("{}_{action}", self.definition.agent.prefix)
    }

    /// Whether the kit edits files with the extension of `path`.
    pub fn opens(&self, path: &str) -> bool {
        path.rsplit_once('.').is_some_and(|(_, extension)| self.definition.extensions.contains(&extension.to_ascii_lowercase().as_str()))
    }
}

/// Why the environment could not do what it was asked: a file that does not read, a kit that
/// does not start or refuses a document, a malformed task.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EnvError(pub String);

impl std::fmt::Display for EnvError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for EnvError {}

impl From<std::io::Error> for EnvError {
    fn from(error: std::io::Error) -> Self {
        Self(error.to_string())
    }
}

pub(crate) fn error(message: impl Into<String>) -> EnvError {
    EnvError(message.into())
}
