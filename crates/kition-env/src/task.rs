//! The task record: one JSON object per line.

use serde_json::{Value, json};
use std::collections::BTreeMap;

use crate::{EnvError, error};

/// An editing task with its ground truth.
#[derive(Clone, Debug, PartialEq)]
pub struct Task {
    /// A stable hash of the file's content, the seed and the index (16 hex digits).
    pub id: String,
    /// The kit's id (`kit.slide`).
    pub kit: String,
    /// The file, relative to the workspace, `/`-separated.
    pub file: String,
    pub seed: u64,
    /// The task's place in its generation run, from 0.
    pub index: usize,
    /// The edit kind (`set-field`, `replace-text`, `delete`, `move`, `create`), of the forward
    /// edit for an inverse task.
    pub kind: String,
    pub instruction: String,
    /// The change set the task asks for, as the kit's receipt gave it.
    pub ground_truth: Value,
    /// An inverse task starts from the edited file and asks to restore what the edit changed.
    pub inverse: bool,
    /// For an inverse task, the batch operations that make the edited file from `file`.
    pub setup: Option<Vec<Value>>,
    /// The batch operations that make the ground truth from the task's starting file, checked
    /// when the task was made.
    pub solution: Vec<Value>,
    /// Recorded creation id -> its batch `ref`. Episodes bind these to each replay allocation.
    pub bindings: BTreeMap<String, String>,
    /// The edits sampled before this one and discarded: `{ kind, reason }`.
    pub resampled: Vec<Value>,
}

impl Task {
    /// Binds this task for standalone scoring or replay with ids from `Trace.id_map`.
    pub fn with_ids(&self, ids: &BTreeMap<String, String>) -> Self {
        let ids = crate::replay::ReplayIds(ids.clone());
        let mut task = self.clone();
        task.ground_truth = ids.json(&task.ground_truth);
        task.solution = ids.arguments(&json!({"ops":task.solution}))["ops"].as_array().cloned().unwrap_or_default();
        if let Some(setup) = &task.setup {
            task.setup = ids.arguments(&json!({"ops":setup}))["ops"].as_array().cloned();
        }
        task
    }

    pub fn to_json(&self) -> Value {
        let mut value = json!({
            "id": self.id,
            "kit": self.kit,
            "file": self.file,
            "seed": self.seed,
            "index": self.index,
            "kind": self.kind,
            "instruction": self.instruction,
            "groundTruth": self.ground_truth,
            "inverse": self.inverse,
            "solution": self.solution,
            "resampled": self.resampled,
        });
        if let Some(setup) = &self.setup {
            value["setup"] = json!(setup);
        }
        if !self.bindings.is_empty() {
            value["bindings"] = json!(self.bindings);
        }
        value
    }

    /// The task as one line of JSON (no line break).
    pub fn to_line(&self) -> String {
        self.to_json().to_string()
    }

    pub fn from_json(value: &Value) -> Result<Self, EnvError> {
        let text = |name: &str| value[name].as_str().map(str::to_owned).ok_or_else(|| error(format!("a task's `{name}` is a string")));
        let ops = |name: &str| value[name].as_array().cloned().ok_or_else(|| error(format!("a task's `{name}` is a list of operations")));
        let ground_truth = value.get("groundTruth").filter(|truth| truth.is_object()).cloned().ok_or_else(|| error("a task has a `groundTruth` change set"))?;
        let inverse = value["inverse"].as_bool().ok_or_else(|| error("a task's `inverse` is true or false"))?;
        Ok(Self {
            id: text("id")?,
            kit: text("kit")?,
            file: text("file")?,
            seed: value["seed"].as_u64().ok_or_else(|| error("a task's `seed` is a number"))?,
            index: value["index"].as_u64().and_then(|index| usize::try_from(index).ok()).ok_or_else(|| error("a task's `index` is a number"))?,
            kind: text("kind")?,
            instruction: text("instruction")?,
            ground_truth,
            inverse,
            setup: if inverse { Some(ops("setup")?) } else { None },
            solution: ops("solution")?,
            bindings: match value.get("bindings") {
                Some(bindings) => serde_json::from_value(bindings.clone()).map_err(|_| error("a task's `bindings` maps recorded ids to batch refs"))?,
                None => BTreeMap::new(),
            },
            resampled: value["resampled"].as_array().cloned().unwrap_or_default(),
        })
    }

    /// The tasks of a JSON-lines text (blank lines skipped).
    pub fn parse_lines(text: &str) -> Result<Vec<Self>, EnvError> {
        text.lines()
            .enumerate()
            .filter(|(_, line)| !line.trim().is_empty())
            .map(|(at, line)| {
                let value: Value = serde_json::from_str(line).map_err(|err| error(format!("line {}: {err}", at + 1)))?;
                Self::from_json(&value).map_err(|err| error(format!("line {}: {err}", at + 1)))
            })
            .collect()
    }
}
