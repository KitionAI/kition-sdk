//! The reward of an attempt at a task, from the document before and after it.
//!
//! The attempt is compared with the task's ground truth unit by unit (a changed field, a created,
//! moved or deleted object, [`crate::changes::Unit`]):
//!
//! - `intended`: the share of the ground truth's units the attempt made with the right values
//!   (a field's value after; a created object's list, index and values; a moved object's place);
//!   texts compared trimmed and in Unicode normalisation form C unless `exact_text`;
//! - `preserved`: `1 / (1 + n)`, where `n` is the number of objects the attempt changed beyond
//!   the ground truth (`collateral` lists those changes);
//! - `diagnostics`: 1 when the attempt brought no new error diagnostic (`<prefix>_check`), else 0
//!   (`newErrors` lists them);
//! - `reward = intended × preserved × diagnostics`.
//!
//! The states are read through the kit ([`crate::Snapshot`]), so an attempt made by any means
//! scores the same; its own receipt is trusted only through [`score_changes`].

use serde_json::{Value, json};

use crate::changes::{Unit, units_with};
use crate::session::{Session, file_name};
use crate::snapshot::{self, Snapshot};
use crate::{EnvError, EnvKit, Task};

/// How texts are compared.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct ScoreOptions {
    /// Compare texts as they are, not trimmed and normalised.
    pub exact_text: bool,
}

/// A reward and what it was made of.
#[derive(Clone, Debug, PartialEq)]
pub struct Reward {
    /// `intended × preserved × diagnostics`.
    pub reward: f64,
    pub intended: f64,
    pub preserved: f64,
    pub diagnostics: f64,
    /// The ground truth's units the attempt made, and how many it has.
    pub matched: usize,
    pub expected: usize,
    /// The ground truth's units the attempt did not make (or made with other values).
    pub missing: Vec<Value>,
    /// What the attempt changed beyond the ground truth.
    pub collateral: Vec<Value>,
    /// The error diagnostics the attempt brought.
    pub new_errors: Vec<Value>,
}

impl Reward {
    pub fn to_json(&self) -> Value {
        json!({
            "reward": self.reward,
            "intended": self.intended,
            "preserved": self.preserved,
            "diagnostics": self.diagnostics,
            "matched": self.matched,
            "expected": self.expected,
            "missing": self.missing,
            "collateral": self.collateral,
            "newErrors": self.new_errors,
        })
    }
}

/// The reward of the attempt that turned the file `before` into `after` (the bytes of the task's
/// file before and after it), both read by `kit` in a workspace of their own.
pub async fn score_files(kit: &EnvKit, task: &Task, before: &[u8], after: &[u8], options: &ScoreOptions) -> Result<Reward, EnvError> {
    let session = Session::new(kit)?;
    let name = file_name(&task.file);
    let (was, now) = (format!("before/{name}"), format!("after/{name}"));
    let read = async {
        session.write(&was, before)?;
        session.write(&now, after)?;
        let old = snapshot::read(&session, &was).await?;
        let new = snapshot::read(&session, &now).await?;
        let errors = new_errors(&session.errors(&was).await?, &session.errors(&now).await?);
        Ok::<_, EnvError>((old, new, errors))
    }
    .await;
    session.shutdown().await;
    let (old, new, errors) = read?;
    let changes = diff(&old, &new);
    let kept = |ty: &str, field: &str| new.creation_kept(ty, field) || old.creation_kept(ty, field);
    Ok(reward(&units_with(&task.ground_truth, &kept), &units_with(&changes, &kept), errors, options))
}

/// The reward of an attempt from its own receipt: the change set it answered (`changes`) and the
/// diagnostics it introduced (`diagnostics.new`). Only as good as the receipt; [`score_files`]
/// trusts nothing but the states.
pub fn score_changes(task: &Task, changes: &Value, new_diagnostics: &[Value], options: &ScoreOptions) -> Reward {
    let errors = new_diagnostics.iter().filter(|diagnostic| diagnostic["severity"] == "error").cloned().collect();
    let none = |_: &str, _: &str| false;
    reward(&units_with(&task.ground_truth, &none), &units_with(changes, &none), errors, options)
}

/// The change set `before → after`, as the SDK computes a draft's comparison, without `texts`.
pub(crate) fn diff(before: &Snapshot, after: &Snapshot) -> Value {
    let changes = match &before.schema {
        // Paired, not matched by object id: the kit may mint new ids for objects without tool ids
        // on every read.
        Some(schema) => kition_kdm::reread::diff_paired(schema, &before.canonical(), &after.canonical()),
        None => kition_kdm::diff::diff_states(&before.canonical(), &after.canonical()),
    };
    crate::changes::creation_values(crate::changes::core(&changes.to_located_json()), after)
}

/// The diagnostics of `after` that `before` does not have (by code and target, counted).
pub(crate) fn new_errors(before: &[Value], after: &[Value]) -> Vec<Value> {
    let key = |diagnostic: &Value| (diagnostic["code"].to_string(), diagnostic["target"].to_string());
    let mut left: Vec<(String, String)> = before.iter().map(key).collect();
    after
        .iter()
        .filter(|diagnostic| match left.iter().position(|was| *was == key(diagnostic)) {
            Some(at) => {
                left.remove(at);
                false
            }
            None => true,
        })
        .cloned()
        .collect()
}

fn reward(truth: &[Unit], made: &[Unit], new_errors: Vec<Value>, options: &ScoreOptions) -> Reward {
    let mut used = vec![false; made.len()];
    let mut missing = Vec::new();
    let mut matched = 0;
    for unit in truth {
        match made.iter().enumerate().position(|(at, other)| !used[at] && unit.same(other, options.exact_text)) {
            Some(at) => {
                used[at] = true;
                matched += 1;
            }
            None => missing.push(unit.to_json()),
        }
    }
    let keys: Vec<String> = truth.iter().map(Unit::key).collect();
    let collateral: Vec<&Unit> = made.iter().enumerate().filter(|(at, unit)| !used[*at] && !keys.contains(&unit.key())).map(|(_, unit)| unit).collect();
    let mut objects: Vec<String> = collateral.iter().map(|unit| unit.object()).collect();
    objects.sort();
    objects.dedup();
    let intended = if truth.is_empty() { 1.0 } else { matched as f64 / truth.len() as f64 };
    let preserved = 1.0 / (1.0 + objects.len() as f64);
    let diagnostics = if new_errors.is_empty() { 1.0 } else { 0.0 };
    Reward {
        reward: intended * preserved * diagnostics,
        intended,
        preserved,
        diagnostics,
        matched,
        expected: truth.len(),
        missing,
        collateral: collateral.iter().map(|unit| unit.to_json()).collect(),
        new_errors,
    }
}
