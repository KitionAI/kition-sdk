//! The environment API: `reset(task)` starts an episode in a fresh workspace holding the task's
//! file, `step(tool, arguments)` passes one call to the kit's tools there, and `score()` answers
//! the episode's reward. No transport: a framework wraps it as it likes.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use base64::Engine as _;
use serde_json::{Value, json};

use crate::score::{Reward, ScoreOptions, score_files};
use crate::session::Session;
use crate::{EnvError, EnvKit, Task, error};

/// How many steps an episode takes before `step` says it is done, unless set.
pub const MAX_STEPS: usize = 32;

/// What an episode starts with.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Observation {
    /// The task's id.
    pub task: String,
    pub instruction: String,
    /// The task's file, relative to the episode's workspace: the `path` of the kit's tools.
    pub path: String,
    /// The episode's workspace.
    pub workspace: PathBuf,
    /// The tools a step may call: the kit's agent tools.
    pub tools: Vec<String>,
    /// Recorded ids bound by inverse setup to this episode's allocated ids.
    pub id_map: BTreeMap<String, String>,
}

/// One step's answer: the tool's output (or its failure, `{ error, … }`), its previews as
/// `previews: [{ caption, png }]` (base64), and whether the episode's step budget is spent.
#[derive(Clone, Debug, PartialEq)]
pub struct Step {
    /// The actual arguments sent to the kit after binding recorded creation ids.
    pub arguments: Value,
    pub result: Value,
    pub done: bool,
}

struct Episode {
    session: Session,
    task: Task,
    /// The file as the episode started, which the reward compares with.
    before: Vec<u8>,
    observation: Observation,
    steps: usize,
    ids: crate::replay::ReplayIds,
}

/// One kit on tasks from one source workspace; each `reset` starts a new episode.
pub struct Environment {
    kit: EnvKit,
    source: PathBuf,
    max_steps: usize,
    score: ScoreOptions,
    episode: Option<Episode>,
}

impl Environment {
    /// An environment for `kit` on tasks whose files are in `source` (never changed).
    pub fn new(kit: EnvKit, source: &Path) -> Self {
        Self { kit, source: source.to_path_buf(), max_steps: MAX_STEPS, score: ScoreOptions::default(), episode: None }
    }

    #[must_use]
    pub fn with_max_steps(mut self, steps: usize) -> Self {
        self.max_steps = steps;
        self
    }

    #[must_use]
    pub fn with_score_options(mut self, options: ScoreOptions) -> Self {
        self.score = options;
        self
    }

    /// Ends the episode: its kit stops and its workspace is removed.
    pub async fn close(&mut self) {
        if let Some(episode) = self.episode.take() {
            episode.session.shutdown().await;
        }
    }

    /// Starts an episode of `task`: a fresh workspace with the task's file (for an inverse task,
    /// edited by its `setup`); the last episode ends.
    pub async fn reset(&mut self, task: &Task) -> Result<Observation, EnvError> {
        self.close().await;
        if task.kit != self.kit.definition.id {
            return Err(error(format!("the task is for {}, this environment runs {}", task.kit, self.kit.definition.id)));
        }
        let bytes = std::fs::read(self.source.join(&task.file)).map_err(|err| error(format!("`{}`: {err}", task.file)))?;
        let session = Session::new(&self.kit)?;
        session.write(&task.file, &bytes)?;
        let mut ids = crate::replay::ReplayIds::default();
        if let Some(setup) = &task.setup {
            let answer = session
                .call("batch", &task.file, json!({ "ops": setup }))
                .await
                .map_err(|failure| error(format!("the inverse task's setup failed: {}", failure["error"]["message"])))?;
            ids.learn(&task.bindings, &answer);
            session.close(&task.file).await;
        }
        let before = session.read(&task.file)?;
        let mut tools: Vec<String> = kition_kits::tools::installed(&session.kits).into_iter().map(|spec| spec.name).collect();
        tools.sort();
        let observation = Observation {
            task: task.id.clone(),
            instruction: task.instruction.clone(),
            path: task.file.clone(),
            workspace: session.root(),
            tools,
            id_map: ids.0.clone(),
        };
        self.episode = Some(Episode { session, task: task.clone(), before, observation: observation.clone(), steps: 0, ids });
        Ok(observation)
    }

    fn episode(&self) -> Result<&Episode, EnvError> {
        self.episode.as_ref().ok_or_else(|| error("no episode: reset first"))
    }

    /// The episode's observation, as `reset` answered it.
    pub fn observation(&self) -> Result<&Observation, EnvError> {
        Ok(&self.episode()?.observation)
    }

    pub fn id_map(&self) -> Result<&BTreeMap<String, String>, EnvError> {
        Ok(&self.episode()?.ids.0)
    }

    /// The episode's file.
    pub fn file(&self) -> PathBuf {
        self.episode.as_ref().map(|episode| episode.observation.workspace.join(&episode.task.file)).unwrap_or_default()
    }

    /// Calls the kit's `tool` with `arguments` on the episode's workspace (`path` defaults to the
    /// task's file). A tool that fails answers its failure as the result; a tool that is not the
    /// kit's is an error.
    pub async fn step(&mut self, tool: &str, mut arguments: Value) -> Result<Step, EnvError> {
        let max_steps = self.max_steps;
        let episode = self.episode.as_mut().ok_or_else(|| error("no episode: reset first"))?;
        if !episode.observation.tools.iter().any(|name| name == tool) {
            return Err(error(format!("`{tool}` is not one of the episode's tools ({})", episode.observation.tools.join(", "))));
        }
        if !arguments.is_object() {
            arguments = json!({});
        }
        if arguments.get("path").is_none() {
            arguments["path"] = json!(episode.task.file);
        }
        arguments = episode.ids.batch_arguments(&arguments, &episode.task.bindings);
        let result = match episode.session.call_tool(tool, &arguments).await {
            Ok((mut output, previews)) => {
                episode.ids.learn(&episode.task.bindings, &output);
                if !previews.is_empty() {
                    let engine = base64::engine::general_purpose::STANDARD;
                    output["previews"] = previews.iter().map(|preview| json!({ "caption": preview.caption, "png": engine.encode(&preview.png) })).collect();
                }
                output
            }
            Err(failure) => failure,
        };
        episode.steps += 1;
        Ok(Step { arguments, result, done: episode.steps >= max_steps })
    }

    /// The episode's reward: the task's file as it started against the file now (saved first if
    /// the kit holds unsaved edits), as [`score_files`] scores them.
    pub async fn score(&mut self) -> Result<Reward, EnvError> {
        let episode = self.episode()?;
        let kits = &episode.session.kits;
        if let Ok(view) = kits.open(kition_kits::Caller::Agent, &episode.task.file).await
            && view.dirty
        {
            kits.save(kition_kits::Caller::Agent, view.kit_id, &view.document_id).await.map_err(|failure| error(failure.to_string()))?;
        }
        let after = episode.session.read(&episode.task.file)?;
        score_files(&self.kit, &episode.task.with_ids(&episode.ids.0), &episode.before, &after, &self.score).await
    }
}
