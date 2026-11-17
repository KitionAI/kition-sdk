//! Traces: the tool calls a solver makes on a task's episode and their results, with the reward.
//! A trace is kept as training data only when its reward is 1 ([`Trace::verified`]).
//!
//! The built-in [`Oracle`] solves a task as an agent would with the ground truth in hand:
//! `<prefix>_inspect` (with a preview), `<prefix>_batch` with the task's solution (the receipt
//! answers what it changed), then `<prefix>_check`. With `find`, it first reads the object model
//! (`<prefix>_query`, level by level from the root) until every object its batch names has been
//! answered by a read, so the trace shows how the targets were found.

use std::collections::BTreeMap;
use std::path::Path;

use base64::Engine as _;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use crate::environment::{Environment, Observation};
use crate::score::Reward;
use crate::{EnvError, EnvKit, Task};

/// One step of a trace: the tool, its arguments, and its result with images replaced.
#[derive(Clone, Debug, PartialEq)]
pub struct TraceStep {
    pub tool: String,
    pub arguments: Value,
    pub result: Value,
}

/// What a solver did on a task, and the reward it earned.
#[derive(Clone, Debug, PartialEq)]
pub struct Trace {
    pub task: Task,
    pub steps: Vec<TraceStep>,
    pub reward: Reward,
    pub id_map: BTreeMap<String, String>,
}

impl Trace {
    /// Whether the trace solved its task: reward 1.
    pub fn verified(&self) -> bool {
        self.reward.reward == 1.0
    }

    /// `{ task, steps: [{ tool, arguments, result }], reward }` as one line of JSON.
    pub fn to_line(&self) -> String {
        let steps: Vec<Value> = self.steps.iter().map(|step| json!({ "tool": step.tool, "arguments": step.arguments, "result": step.result })).collect();
        json!({ "task": self.task.to_json(), "steps": steps, "reward": self.reward.to_json(), "idMap": self.id_map }).to_string()
    }
}

/// Picks a task's next tool call from what it has seen; none when it is done.
pub trait Solver {
    fn next(&mut self, observation: &Observation, steps: &[TraceStep]) -> Option<(String, Value)>;
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct OracleOptions {
    /// Read the object model until every object the batch names has been seen, instead of naming
    /// the ground truth's objects at once.
    pub find: bool,
}

/// The solver that replays a task's ground truth through the agent-facing tools.
pub struct Oracle {
    solution: Vec<Value>,
    options: OracleOptions,
    stage: Stage,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Stage {
    Inspect,
    Find,
    Batch,
    Check,
    Done,
}

impl Oracle {
    pub fn new(task: &Task, options: OracleOptions) -> Self {
        Self { solution: task.solution.clone(), options, stage: Stage::Inspect }
    }

    /// The ids the solution's operations name, `root` aside.
    fn named(&self) -> Vec<String> {
        let mut ids = Vec::new();
        for op in &self.solution {
            for key in ["target", "item"] {
                ids.extend(op[key].as_str().map(str::to_owned));
            }
            if let Some((owner, _)) = op["in"].as_str().and_then(|place| place.rsplit_once('.')) {
                ids.push(owner.to_owned());
            }
        }
        ids.retain(|id| id != "root");
        ids.sort();
        ids.dedup();
        ids
    }

    /// The next read: the root and the object types first, then, while an object the batch names
    /// is still unseen, the objects the last read's fields name.
    fn find(&self, steps: &[TraceStep], observation: &Observation) -> Option<Value> {
        let queries: Vec<&TraceStep> = steps.iter().filter(|step| step.tool.ends_with("_query")).collect();
        let Some(last) = queries.last() else { return Some(json!({ "describe": true })) };
        let seen: String = steps.iter().map(|step| step.result.to_string()).collect();
        if self.named().into_iter().all(|id| seen.contains(&Value::String(observation.id_map.get(&id).cloned().unwrap_or(id)).to_string())) {
            return None;
        }
        let mut asked: Vec<String> = queries
            .iter()
            .flat_map(|step| step.arguments["objects"].as_array().cloned().unwrap_or_default())
            .filter_map(|id| id.as_str().map(str::to_owned))
            .collect();
        asked.extend(last.result["objects"].as_array().into_iter().flatten().filter_map(|object| object["id"].as_str().map(str::to_owned)));
        let mut next: Vec<String> = Vec::new();
        for object in last.result["objects"].as_array().into_iter().flatten() {
            for value in object["fields"].as_object().into_iter().flatten().map(|(_, value)| value) {
                for item in value.as_array().into_iter().flatten().filter_map(|item| item.as_str().or_else(|| item["object"].as_str())) {
                    if !asked.iter().any(|id| id == item) && !next.iter().any(|id| id == item) {
                        next.push(item.to_owned());
                    }
                }
            }
        }
        if next.is_empty() {
            return None;
        }
        next.truncate(200);
        Some(json!({ "objects": next, "limit": 200 }))
    }
}

impl Solver for Oracle {
    fn next(&mut self, observation: &Observation, steps: &[TraceStep]) -> Option<(String, Value)> {
        let tool = |action: &str| observation.tools.iter().find(|name| name.ends_with(&format!("_{action}"))).cloned();
        let path = json!(observation.path);
        loop {
            match self.stage {
                Stage::Inspect => {
                    self.stage = if self.options.find { Stage::Find } else { Stage::Batch };
                    return Some((tool("inspect")?, json!({ "path": path, "preview": true })));
                }
                Stage::Find => match self.find(steps, observation) {
                    Some(mut query) => {
                        query["path"] = path;
                        return Some((tool("query")?, query));
                    }
                    None => self.stage = Stage::Batch,
                },
                Stage::Batch => {
                    self.stage = Stage::Check;
                    return Some((tool("batch")?, json!({ "path": path, "ops": self.solution, "changes": "all" })));
                }
                Stage::Check => {
                    self.stage = Stage::Done;
                    return Some((tool("check")?, json!({ "path": path })));
                }
                Stage::Done => return None,
            }
        }
    }
}

/// Runs `solver` on an episode of `task` (its file in `workspace`) and answers the trace.
pub async fn trace(kit: &EnvKit, workspace: &Path, task: &Task, solver: &mut dyn Solver) -> Result<Trace, EnvError> {
    let mut env = Environment::new(kit.clone(), workspace);
    let traced = async {
        let observation = env.reset(task).await?;
        let mut steps: Vec<TraceStep> = Vec::new();
        while let Some((tool, arguments)) = solver.next(&observation, &steps) {
            let step = env.step(&tool, arguments.clone()).await?;
            steps.push(TraceStep { tool, arguments: step.arguments, result: without_images(&step.result) });
            if step.done {
                break;
            }
        }
        let reward = env.score().await?;
        Ok(Trace { task: task.clone(), steps, reward, id_map: env.id_map()?.clone() })
    }
    .await;
    env.close().await;
    traced
}

/// The oracle's traces of `tasks` that earn reward 1, as JSON lines.
pub async fn verified_traces(kit: &EnvKit, workspace: &Path, tasks: &[Task], options: OracleOptions) -> Result<Vec<String>, EnvError> {
    let mut lines = Vec::new();
    for task in tasks {
        let traced = trace(kit, workspace, task, &mut Oracle::new(task, options)).await?;
        if traced.verified() {
            lines.push(traced.to_line());
        }
    }
    Ok(lines)
}

/// The PNG signature as base64 starts it.
const PNG_BASE64: &str = "iVBORw0KGgo";

/// `value` with every image (a PNG as base64, or a `data:image/…` URL) replaced by
/// `sha256:<hex>` of its bytes.
pub fn without_images(value: &Value) -> Value {
    match value {
        Value::String(text) => match image_bytes(text) {
            Some(bytes) => Value::String(format!("sha256:{}", hex::encode(Sha256::digest(bytes)))),
            None => value.clone(),
        },
        Value::Array(items) => Value::Array(items.iter().map(without_images).collect()),
        Value::Object(map) => Value::Object(map.iter().map(|(key, item)| (key.clone(), without_images(item))).collect()),
        other => other.clone(),
    }
}

fn image_bytes(text: &str) -> Option<Vec<u8>> {
    let data = match text.strip_prefix("data:image/") {
        Some(rest) => rest.split_once(";base64,")?.1,
        None if text.starts_with(PNG_BASE64) => text,
        None => return None,
    };
    Some(base64::engine::general_purpose::STANDARD.decode(data).unwrap_or_else(|_| data.as_bytes().to_vec()))
}
