//! # kition-convergence
//!
//! The convergence suite of the Kition kit platform (`docs/platform/kits/levels.md`): what a
//! contract 2 kit runs to claim **L6 Collaboration**. It drives two to five in-process replicas of
//! one document through the kit's own command layer, delivers their changes in seeded orders with
//! duplicates, crashes and recovers replicas, and checks after every scenario that
//!
//! - every replica has the same canonical state (the KDM's `state_json`, whose SHA-256 is the
//!   state hash);
//! - the state keeps the schema's references valid: a `ref` names an existing object of its type,
//!   a `list` holds existing objects once each, a `tree` names each object at most once;
//! - each replica's view matches its replica ([`KitAdapter::check_view`]).
//!
//! A kit plugs in with a [`KitAdapter`]: how to make and join replicas, exchange changes, read the
//! canonical state, make a random edit from its command catalogue, and run the few scripted steps
//! of [`Script`]. The suite only sees bytes and JSON, so it depends on no particular `kition-kit`
//! revision; a kit adds it as a dev-dependency:
//!
//! ```ignore
//! #[test]
//! fn converges() {
//!     let report = kition_convergence::run(&MyKit, &kition_convergence::Options::default());
//!     println!("{}", report.render());
//!     assert!(report.passed(), "{}", report.render());
//! }
//! ```
//!
//! [`perf`] measures the performance budgets of `docs/kits.md` section 7 (Kition), and [`wasm`]
//! checks that the kit's WebAssembly engine reaches the native state from the same change log.

// No `clippy::indexing_slicing`: the suite indexes `serde_json::Value`s by key, which never panics.
#![deny(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::collections::BTreeMap;

use serde_json::Value;

mod alloc;
mod net;
pub mod perf;
mod scenarios;
pub mod state;
pub mod wasm;

pub use alloc::CountingAlloc;
pub use net::Net;
pub use state::SchemaInfo;

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

/// What the suite runs.
#[derive(Clone, Debug)]
pub struct Options {
    /// Seeds of the fuzzed runs; each runs on every replica count of `replicas`.
    pub seeds: Vec<u64>,
    /// Replica counts of the fuzzed runs (2 to 5).
    pub replicas: Vec<usize>,
    /// Steps of each fuzzed run.
    pub steps: usize,
}

impl Default for Options {
    fn default() -> Self {
        Self { seeds: vec![1, 2, 3], replicas: vec![2, 3, 5], steps: 120 }
    }
}

impl Options {
    /// A heavier run, for nightly jobs: `KITION_CONVERGENCE_SEEDS=<n>` seeds from 1,
    /// `KITION_CONVERGENCE_SEED_BASE=<b>` seeds from `b + 1` instead (another range of runs),
    /// `KITION_CONVERGENCE_STEPS=<n>` steps.
    pub fn from_env() -> Self {
        Self::from_vars(|name| std::env::var(name).ok())
    }

    /// [`Options::from_env`] with the variables `var` answers.
    pub fn from_vars(var: impl Fn(&str) -> Option<String>) -> Self {
        let mut options = Self::default();
        let number = |name: &str| var(name).and_then(|text| text.parse::<u64>().ok());
        let base = number("KITION_CONVERGENCE_SEED_BASE").unwrap_or(0);
        let count = number("KITION_CONVERGENCE_SEEDS").map(|count| count.max(1));
        if count.is_some() || base > 0 {
            let count = count.unwrap_or_else(|| u64::try_from(options.seeds.len()).unwrap_or(u64::MAX));
            options.seeds = (1..=count).map(|seed| base.saturating_add(seed)).collect();
        }
        if let Some(steps) = number("KITION_CONVERGENCE_STEPS") {
            options.steps = usize::try_from(steps).unwrap_or(usize::MAX).max(1);
        }
        options
    }
}

/// How one scenario went.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Outcome {
    Passed,
    Failed(String),
    /// The kit has no such step (its adapter answered `Ok(false)`), with why.
    Skipped(String),
}

/// One scenario's result.
#[derive(Clone, Debug)]
pub struct Check {
    pub id: &'static str,
    pub title: &'static str,
    /// Whether L6 needs it to pass (rather than be skipped). Conditional scenarios (text, blobs,
    /// lists, trees) are required when the kit has what they test.
    pub required: bool,
    pub outcome: Outcome,
}

/// The suite's results.
#[derive(Clone, Debug, Default)]
pub struct Report {
    pub kit: String,
    pub checks: Vec<Check>,
}

impl Report {
    /// No scenario failed. Skips are allowed here; [`Report::level6`] is stricter.
    pub fn passed(&self) -> bool {
        !self.checks.is_empty() && self.checks.iter().all(|check| !matches!(check.outcome, Outcome::Failed(_)))
    }

    /// The kit passes the convergence suite for L6: nothing failed and no required scenario was
    /// skipped.
    pub fn level6(&self) -> bool {
        self.passed() && self.checks.iter().all(|check| !check.required || check.outcome == Outcome::Passed)
    }

    /// The report as JSON: `{ kit, suite, level6, checks: [{ id, title, required, outcome, reason? }] }`,
    /// `outcome` one of `passed`, `failed`, `skipped`. `tools/check-manifest.mjs --convergence`
    /// reads it for L6.
    pub fn to_json(&self) -> Value {
        let checks: Vec<Value> = self
            .checks
            .iter()
            .map(|check| {
                let (outcome, reason) = match &check.outcome {
                    Outcome::Passed => ("passed", None),
                    Outcome::Failed(reason) => ("failed", Some(reason)),
                    Outcome::Skipped(reason) => ("skipped", Some(reason)),
                };
                let mut out = serde_json::json!({ "id": check.id, "title": check.title, "required": check.required, "outcome": outcome });
                if let Some(reason) = reason {
                    out["reason"] = Value::from(reason.as_str());
                }
                out
            })
            .collect();
        serde_json::json!({ "kit": self.kit, "suite": SUITE, "level6": self.level6(), "checks": checks })
    }

    /// Writes [`Report::to_json`] to the file `KITION_CONVERGENCE_REPORT` names, when it is set:
    /// how a kit's test hands its result to `check-manifest.mjs --convergence`.
    pub fn save_if_requested(&self) -> Result<()> {
        match std::env::var_os("KITION_CONVERGENCE_REPORT") {
            Some(path) => {
                std::fs::write(&path, format!("{:#}\n", self.to_json())).map_err(|error| format!("{}: {error}", std::path::Path::new(&path).display()))
            }
            None => Ok(()),
        }
    }

    pub fn outcome(&self, id: &str) -> Option<&Outcome> {
        self.checks.iter().find(|check| check.id == id).map(|check| &check.outcome)
    }

    /// One line per scenario, then the summary.
    pub fn render(&self) -> String {
        let mut out = String::new();
        for check in &self.checks {
            let line = match &check.outcome {
                Outcome::Passed => format!("PASS {} - {}\n", check.id, check.title),
                Outcome::Failed(reason) => format!("FAIL {} - {}: {reason}\n", check.id, check.title),
                Outcome::Skipped(reason) => {
                    format!("SKIP {} - {}{}: {reason}\n", check.id, check.title, if check.required { " (required for L6)" } else { "" })
                }
            };
            out.push_str(&line);
        }
        let passed = self.checks.iter().filter(|check| check.outcome == Outcome::Passed).count();
        out.push_str(&format!(
            "{}: {passed}/{} scenarios passed; L6 convergence {}\n",
            self.kit,
            self.checks.len(),
            if self.level6() { "passed" } else { "not passed" }
        ));
        out
    }

    fn push(&mut self, id: &'static str, title: &'static str, required: bool, outcome: Outcome) {
        self.checks.push(Check { id, title, required, outcome });
    }
}

/// The suite's name and version in reports: scenarios are only added in a minor version.
pub const SUITE: &str = "kition-convergence 1.0";

/// Every scenario: `(id, title)`, in the order [`run`] runs them.
pub const SCENARIOS: &[(&str, &str)] = scenarios::SCENARIOS;

/// Runs the whole suite against `kit`.
pub fn run<K: KitAdapter>(kit: &K, options: &Options) -> Report {
    scenarios::run(kit, options)
}

/// Runs one scenario by id (from [`SCENARIOS`]); `None` for an unknown id.
pub fn run_one<K: KitAdapter>(kit: &K, id: &str, options: &Options) -> Option<Report> {
    scenarios::run_one(kit, id, options)
}
