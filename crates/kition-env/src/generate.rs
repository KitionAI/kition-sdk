//! Task generation: for each file of a workspace that the kit edits, a seeded sampler picks a
//! generic edit its object model can express and checks it through the kit itself.
//!
//! The edit kinds ([`EDIT_KINDS`]), on objects that are not read-only (OM8) and that a person can
//! name ([`crate::Reference`]):
//!
//! - `set-field`: a scalar field (enum, boolean, integer, number, or a string other than the
//!   object's label) to another valid value: another of the enum's values, the other truth value,
//!   a number a step away, or a value the same field has on another object of the type;
//! - `replace-text`: the object's label (its `text` field, else a string field named like one,
//!   `text`, `name`, `title`, …) to a word of the vocabulary;
//! - `delete`: an object a list holds and that holds no objects itself;
//! - `move`: an object to another place in its list, or into the same field of another object of
//!   its parent's type;
//! - `create`: a new object in a list, at a sampled position, with the values of an object of its
//!   type (its label from the vocabulary).
//!
//! Objects are named by the ids that survive saving and reopening the file: a kit qualifies when
//! the ids its tasks and receipts use do (its tool ids, KitObjectModel OM9, or, for a kit that
//! declares none, its object ids), and an object without a tool id of a kit that declares them
//! (a text body, a paragraph, a layout) is never sampled (`excluded`: `no-tool-id`); its changes
//! are told under the object holding it, as receipts tell them.
//!
//! Field edits leave read-only registers, tool ids and `readOnlyWhen` discriminators alone;
//! creation includes immutable registers from an example, leaving tool-id allocation to the kit. Each
//! edit runs as one `<prefix>_batch` on a copy of the file; it becomes a task only when the kit
//! accepts it, `<prefix>_check` reports no new error, the receipt equals the difference of the
//! file's states read again after saving, and the receipt's operations ([`crate::ops_for`])
//! remake the edit on a fresh copy. Otherwise it is resampled (at most `attempts` times), and the
//! task records why.

use std::collections::BTreeMap;
use std::path::Path;

use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use crate::changes::{core, create_fields, creation_values, has_excerpt, instruction_complete, is_empty, ops_for, replay_for};
use crate::instruction::instruction;
use crate::rng::Rng;
use crate::score::{diff, new_errors};
use crate::session::{Session, file_name, relative};
use crate::snapshot::{self, Snapshot};
use crate::{EnvError, EnvKit, Task, error};

/// The generic edit kinds, in the order the sampler lists them.
pub const EDIT_KINDS: [&str; 5] = ["set-field", "replace-text", "delete", "move", "create"];

/// The texts `replace-text` and `create` write unless the options give others.
pub const VOCABULARY: [&str; 12] =
    ["Q4 revenue", "Overview", "Next steps", "Key results", "Open questions", "Summary", "Thank you", "Timeline", "Budget", "Team", "Risks", "Agenda"];

#[derive(Clone, Debug)]
pub struct GenerateOptions {
    pub seed: u64,
    /// How many tasks, spread over the workspace's files in turn.
    pub count: usize,
    /// The share of inverse tasks (0 to 1).
    pub inverse_share: f64,
    /// The texts to write instead of [`VOCABULARY`].
    pub vocabulary: Option<Vec<String>>,
    /// Only these edit kinds.
    pub kinds: Option<Vec<String>>,
    /// How many edits to try for one task before giving it up.
    pub attempts: usize,
}

impl Default for GenerateOptions {
    fn default() -> Self {
        Self { seed: 0, count: 10, inverse_share: 0.3, vocabulary: None, kinds: None, attempts: 8 }
    }
}

/// What a generation run made.
#[derive(Clone, Debug, Default)]
pub struct Generated {
    pub tasks: Vec<Task>,
    /// Source files that could not be read: `{ file, reason }`, in path order.
    pub skipped: Vec<Value>,
    /// The tasks given up: `{ index, file, resampled, reason }`.
    pub given_up: Vec<Value>,
    /// Objects never sampled, by why: `not-describable` (no list holds them), `no-tool-id` (the kit
    /// names other objects by tool ids, and their object ids do not survive a reopen).
    pub excluded: BTreeMap<String, usize>,
}

/// One of the workspace's files, as the run read it.
struct Source {
    path: String,
    bytes: Vec<u8>,
    start: Snapshot,
    errors: Vec<Value>,
}

/// An edit the sampler can make, before its values are drawn.
#[derive(Clone, Debug)]
enum Candidate {
    SetField {
        id: String,
        field: String,
    },
    /// A scalar field of an object without a tool id, written through the one with a tool id that
    /// holds it, at a path: `held` is the object, `path` from `holder` to it.
    SetHeld {
        held: String,
        holder: String,
        path: String,
        field: String,
    },
    ReplaceText {
        id: String,
        field: String,
    },
    Delete {
        id: String,
    },
    Move {
        id: String,
    },
    Create {
        parent: String,
        field: String,
        of: String,
    },
}

impl Candidate {
    fn object_type<'a>(&'a self, start: &'a Snapshot) -> &'a str {
        match self {
            Self::Create { of, .. } => of,
            Self::SetHeld { held, .. } => start.type_of(held).unwrap_or_default(),
            Self::SetField { id, .. } | Self::ReplaceText { id, .. } | Self::Delete { id } | Self::Move { id } => start.type_of(id).unwrap_or_default(),
        }
    }

    fn kind(&self) -> &'static str {
        match self {
            Self::SetField { .. } | Self::SetHeld { .. } => "set-field",
            Self::ReplaceText { .. } => "replace-text",
            Self::Delete { .. } => "delete",
            Self::Move { .. } => "move",
            Self::Create { .. } => "create",
        }
    }
}

fn pick_type_balanced<'a>(candidates: &[&'a Candidate], start: &Snapshot, rng: &mut Rng) -> Option<&'a Candidate> {
    let types: Vec<_> = candidates.iter().map(|candidate| candidate.object_type(start)).collect::<std::collections::BTreeSet<_>>().into_iter().collect();
    let ty = if types.len() == 1 { types[0] } else { *rng.pick(&types)? };
    let of_type: Vec<_> = candidates.iter().copied().filter(|candidate| candidate.object_type(start) == ty).collect();
    rng.pick(&of_type).copied()
}

/// The files under `workspace` that `kit` edits, relative and sorted; hidden folders skipped.
fn files(workspace: &Path, kit: &EnvKit) -> Vec<String> {
    let mut found = Vec::new();
    let mut folders = vec![workspace.to_path_buf()];
    while let Some(folder) = folders.pop() {
        for entry in std::fs::read_dir(&folder).into_iter().flatten().flatten() {
            let path = entry.path();
            if entry.file_name().to_string_lossy().starts_with('.') {
                continue;
            }
            if path.is_dir() {
                folders.push(path);
            } else if let Some(relative) = relative(workspace, &path).filter(|relative| kit.opens(relative)) {
                found.push(relative);
            }
        }
    }
    found.sort();
    found
}

fn task_id(bytes: &[u8], seed: u64, index: usize) -> String {
    let mut hash = Sha256::new();
    hash.update(bytes);
    hash.update(seed.to_le_bytes());
    hash.update((index as u64).to_le_bytes());
    hex::encode(hash.finalize())[..16].to_owned()
}

/// Generates `options.count` tasks from the files of `workspace` that `kit` edits. The files are
/// never changed: every edit runs on a copy in a workspace of the run's own.
pub async fn generate(kit: &EnvKit, workspace: &Path, options: &GenerateOptions) -> Result<Generated, EnvError> {
    if !kit.definition.agent.object_model {
        return Err(error(format!("{} declares no object model (`agent.objectModel` in its kit.json): its edits cannot be sampled", kit.definition.name)));
    }
    let paths = files(workspace, kit);
    if paths.is_empty() {
        return Err(error(format!(
            "no file in `{}` opens in {} (extensions {})",
            workspace.display(),
            kit.definition.name,
            kit.definition.extensions.join(", ")
        )));
    }
    let session = Session::new(kit)?;
    let made = run(&session, workspace, &paths, options).await;
    session.shutdown().await;
    made
}

async fn run(session: &Session, workspace: &Path, paths: &[String], options: &GenerateOptions) -> Result<Generated, EnvError> {
    let mut generated = Generated::default();
    let mut sources = Vec::new();
    for path in paths {
        let copy = format!("start/{path}");
        let read = async {
            let bytes = std::fs::read(workspace.join(path)).map_err(|err| error(format!("`{path}`: {err}")))?;
            session.write(&copy, &bytes)?;
            let start = snapshot::read(session, &copy).await?;
            let errors = session.errors(&copy).await?;
            session.close(&copy).await;
            let again = snapshot::read(session, &copy).await?;
            Ok::<_, EnvError>((bytes, start, errors, again))
        }
        .await;
        session.close(&copy).await;
        let (bytes, start, errors, again) = match read {
            Ok(source) => source,
            Err(failure) => {
                generated.skipped.push(json!({ "file": path, "reason": failure.to_string() }));
                continue;
            }
        };
        if again.stable_ids() != start.stable_ids() {
            return Err(error(format!(
                "`{path}`: {} names its objects by other ids each time the file is opened (object ids made anew, no tool ids): \
                 tasks name objects by the ids the tools answer, so they need ids that survive saving and reopening the file \
                 (KitObjectModel OM9 tool ids, or stable object ids)",
                session.kit.definition.name
            )));
        }
        let hidden = start.ids().into_iter().filter(|id| id != start.root() && start.reference(id).is_none()).count();
        if hidden > 0 {
            *generated.excluded.entry("not-describable".to_owned()).or_default() += hidden;
        }
        let unnamed = start.ids().into_iter().filter(|id| start.reference(id).is_some() && !start.stable(id)).count();
        if unnamed > 0 {
            *generated.excluded.entry("no-tool-id".to_owned()).or_default() += unnamed;
        }
        sources.push(Source { path: path.clone(), bytes, start, errors });
    }
    if sources.is_empty() {
        return Ok(generated);
    }
    let vocabulary: Vec<String> = options.vocabulary.clone().unwrap_or_else(|| VOCABULARY.iter().map(|word| (*word).to_owned()).collect());
    for index in 0..options.count {
        let source = &sources[index % sources.len()];
        let mut rng = Rng::new(options.seed, index as u64);
        let inverse = rng.chance(options.inverse_share);
        let mut resampled = Vec::new();
        let mut task = None;
        let mut reason = "attempts";
        for attempt in 0..options.attempts.max(1) {
            let candidates = candidates(&source.start, options.kinds.as_deref(), inverse);
            let kinds: Vec<&str> = EDIT_KINDS.into_iter().filter(|kind| candidates.iter().any(|candidate| candidate.kind() == *kind)).collect();
            let Some(kind) = rng.pick(&kinds).copied() else {
                reason = "no-candidates";
                break;
            };
            let of_kind: Vec<&Candidate> = candidates.iter().filter(|candidate| candidate.kind() == kind).collect();
            let Some(candidate) = pick_type_balanced(&of_kind, &source.start, &mut rng) else { break };
            let Some(ops) = build(candidate, &source.start, &mut rng, &vocabulary) else {
                resampled.push(json!({ "kind": kind, "reason": "no-value" }));
                continue;
            };
            let work = format!("work/{index}-{attempt}");
            match attempt_edit(session, source, &work, ops, kind, inverse).await? {
                Ok((truth, instruction, setup, solution, bindings)) => {
                    task = Some(Task {
                        id: task_id(&source.bytes, options.seed, index),
                        kit: session.kit.definition.id.to_owned(),
                        file: source.path.clone(),
                        seed: options.seed,
                        index,
                        kind: kind.to_owned(),
                        instruction,
                        ground_truth: truth,
                        inverse,
                        setup,
                        solution,
                        bindings,
                        resampled: std::mem::take(&mut resampled),
                    });
                    break;
                }
                Err(why) => resampled.push(json!({ "kind": kind, "reason": why })),
            }
        }
        match task {
            Some(task) => generated.tasks.push(task),
            None => generated.given_up.push(json!({ "index": index, "file": source.path, "reason": reason, "resampled": resampled })),
        }
    }
    Ok(generated)
}

/// What a successful attempt makes: the ground truth, the instruction, the setup of an inverse
/// task, and the solution.
type Made = (Value, String, Option<Vec<Value>>, Vec<Value>, crate::replay::Bindings);

/// Runs `ops` on a copy of the source in the folder `work`; the task it makes, or why not.
async fn attempt_edit(
    session: &Session,
    source: &Source,
    work: &str,
    ops: Vec<Value>,
    kind: &str,
    inverse: bool,
) -> Result<Result<Made, &'static str>, EnvError> {
    let copy = format!("{work}/{}", file_name(&source.path));
    session.write(&copy, &source.bytes)?;
    let outcome = edit(session, source, &copy, &ops, kind, inverse).await;
    session.close(&copy).await;
    outcome
}

/// `ops` as one batch on `path`: its change set, or why it is no edit to make a task of.
async fn batch(session: &Session, path: &str, ops: &[Value]) -> Result<Value, &'static str> {
    let answer = session.call("batch", path, json!({ "ops": ops, "changes": "all" })).await.map_err(|_| "refused")?;
    if !answer["changes"].is_object() {
        return Err("no-receipt");
    }
    Ok(core(&answer["changes"]))
}

/// The state of `path` read again from its file.
async fn reread(session: &Session, path: &str) -> Result<Snapshot, EnvError> {
    session.close(path).await;
    snapshot::read(session, path).await
}

/// Whether `ops` remake `goal` from `bytes`, on a fresh copy at `path`.
async fn remakes(
    session: &Session,
    path: &str,
    bytes: &[u8],
    steps: &[&[Value]],
    goal: &Snapshot,
    allocated: &Value,
    bindings: &crate::replay::Bindings,
) -> Result<bool, EnvError> {
    session.write(path, bytes)?;
    let mut created = std::collections::BTreeSet::new();
    let mut ids = crate::replay::ReplayIds::default();
    for ops in steps {
        let arguments = ids.batch_arguments(&json!({"ops":ops,"changes":"all"}), bindings);
        match session.call("batch", path, arguments).await {
            Ok(answer) => {
                ids.learn(bindings, &answer);
                let changes = core(&answer["changes"]);
                created.extend(changes["created"].as_array().into_iter().flatten().filter_map(|item| item["id"].as_str().map(str::to_owned)));
            }
            Err(_) => {
                session.close(path).await;
                return Ok(false);
            }
        }
    }
    let made = reread(session, path).await?;
    session.close(path).await;
    created.retain(|id| made.objects.contains_key(id));
    let expected = allocated["created"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|item| item["id"].as_str().filter(|id| goal.objects.contains_key(*id)).map(str::to_owned))
        .collect();
    Ok(goal.same_created(&made, &expected, &created))
}

async fn edit(session: &Session, source: &Source, copy: &str, ops: &[Value], kind: &str, inverse: bool) -> Result<Result<Made, &'static str>, EnvError> {
    let start = &source.start;
    let forward = match batch(session, copy, ops).await {
        Ok(changes) => changes,
        Err(why) => return Ok(Err(why)),
    };
    if is_empty(&forward) {
        return Ok(Err("no-change"));
    }
    // A field write whose effect is more than that field: not the edit its instruction would say.
    if matches!(kind, "set-field" | "replace-text")
        && crate::structural::primary(&forward, start).is_none()
        && (["created", "deleted", "moved"].iter().any(|list| forward[*list].as_array().is_some_and(|items| !items.is_empty()))
            || forward["changed"].as_array().map_or(0, Vec::len) != 1)
    {
        return Ok(Err("effect-differs"));
    }
    if !new_errors(&source.errors, &session.errors(copy).await?).is_empty() {
        return Ok(Err("new-error"));
    }
    if !instruction_complete(&forward, start) && crate::changes::cascade_root(&forward, start).is_none() {
        return Ok(Err("instruction-incomplete"));
    }
    let edited = reread(session, copy).await?;
    let forward = creation_values(forward, &edited);
    if diff(start, &edited) != forward {
        return Ok(Err("receipt-differs"));
    }
    if has_excerpt(&forward) {
        return Ok(Err("long-text"));
    }
    let Ok((setup, mut bindings)) = replay_for(&forward, start) else { return Ok(Err("not-replayable")) };
    let check = format!("{}/check/{}", copy.rsplit_once('/').map_or("", |(dir, _)| dir), file_name(copy));
    if !inverse {
        if !remakes(session, &check, &source.bytes, &[&setup], &edited, &forward, &bindings).await? {
            return Ok(Err("not-replayable"));
        }
        let Some(instruction) = instruction(kind, &forward, start, false) else { return Ok(Err("not-describable")) };
        return Ok(Ok((forward, instruction, None, setup, bindings)));
    }
    let Ok(back) = ops_for(&diff(&edited, start), &edited) else { return Ok(Err("inverse-not-restorable")) };
    let truth = match batch(session, copy, &back).await {
        Ok(changes) => changes,
        Err(_) => return Ok(Err("inverse-not-restorable")),
    };
    let restored = reread(session, copy).await?;
    if !restored.same(start) {
        return Ok(Err("inverse-not-restorable"));
    }
    let truth = creation_values(truth, &restored);
    if diff(&edited, &restored) != truth {
        return Ok(Err("receipt-differs"));
    }
    if has_excerpt(&truth) {
        return Ok(Err("long-text"));
    }
    let Ok((solution, inverse_bindings)) = replay_for(&truth, &edited) else { return Ok(Err("not-replayable")) };
    bindings.extend(inverse_bindings);
    if !instruction_complete(&truth, &edited) {
        return Ok(Err("instruction-incomplete"));
    }
    if !remakes(session, &check, &source.bytes, &[&setup, &solution], start, &truth, &bindings).await? {
        return Ok(Err("not-replayable"));
    }
    let Some(instruction) = instruction(kind, &truth, &edited, true) else { return Ok(Err("not-describable")) };
    Ok(Ok((truth, instruction, Some(setup), solution, bindings)))
}

/// Whether the object model may write objects in `parent`'s list fields.
fn writable(start: &Snapshot, id: &str) -> bool {
    start.type_of(id).is_some_and(|ty| !start.read_only(ty, Some(id)))
}

/// Whether `id` holds no objects: its list and tree fields are empty.
fn holds_nothing(start: &Snapshot, id: &str) -> bool {
    let Some(ty) = start.type_of(id) else { return false };
    !start.places.values().any(|place| place.parent == id)
        && start
            .fields(ty)
            .iter()
            .all(|(field, def)| !matches!(def["kind"].as_str(), Some("list" | "tree")) || start.value(id, field).as_array().is_none_or(Vec::is_empty))
}

/// The other values the string `field` has on objects of `ty`, sorted.
fn other_values(start: &Snapshot, ty: &str, field: &str, current: &Value) -> Vec<Value> {
    let mut values: Vec<Value> = start
        .ids()
        .iter()
        .filter(|id| start.type_of(id) == Some(ty))
        .map(|id| start.value(id, field))
        .filter(|value| value.as_str().is_some_and(|text| !text.is_empty()) && value != current)
        .collect();
    values.sort_by_key(Value::to_string);
    values.dedup();
    values
}

/// Other objects of `parent`'s type that have the list `field`.
fn other_parents(start: &Snapshot, parent: &str, field: &str, moving: &str) -> Vec<String> {
    if start.type_of(moving).is_some_and(|ty| start.type_def(ty)["moveConsequences"].as_array().is_some_and(|paths| !paths.is_empty()))
        && let Some(owner) = start.tree_owner(parent, field)
    {
        return start
            .ids()
            .into_iter()
            .filter(|id| {
                if id == parent || !writable(start, id) || start.tree_owner(id, field).as_ref() != Some(&owner) {
                    return false;
                }
                let mut at = id.as_str();
                for _ in 0..64 {
                    if at == moving {
                        return false;
                    }
                    let Some(place) = start.place(at) else { return true };
                    at = &place.parent;
                }
                false
            })
            .collect();
    }
    let ty = start.type_of(parent);
    start
        .ids()
        .into_iter()
        .filter(|id| {
            id != parent
                && start.type_of(id) == ty
                && writable(start, id)
                && (id == start.root() || start.reference(id).is_some())
                && start.value(id, field).is_array()
        })
        .collect()
}

const SCALARS: [&str; 5] = ["enum", "boolean", "integer", "number", "string"];

fn number_leaves(value: &Value, path: &str) -> Vec<String> {
    match value {
        Value::Number(_) => vec![path.to_owned()],
        Value::Object(members) => members.iter().flat_map(|(name, value)| number_leaves(value, &format!("{path}.{name}"))).collect(),
        Value::Array(items) => items.iter().enumerate().flat_map(|(i, value)| number_leaves(value, &format!("{path}.{i}"))).collect(),
        _ => Vec::new(),
    }
}

fn member_pattern(value: &Value, path: &str) -> String {
    let mut at = value;
    let mut pattern = String::new();
    for segment in path.split('.') {
        if at.is_array() {
            pattern.push_str("[]");
            at = segment.parse::<usize>().ok().and_then(|i| at.get(i)).unwrap_or(&Value::Null);
        } else {
            if !pattern.is_empty() {
                pattern.push('.');
            }
            pattern.push_str(segment);
            at = at.get(segment).unwrap_or(&Value::Null);
        }
    }
    pattern
}

fn candidates(start: &Snapshot, kinds: Option<&[String]>, inverse: bool) -> Vec<Candidate> {
    let mut found = Vec::new();
    for id in start.ids() {
        let Some(ty) = start.type_of(&id).map(str::to_owned) else { continue };
        // Held by an object with a tool id, at a path: its scalar fields.
        if !start.stable(&id)
            && let Some((holder, path)) = start.held_path(&id)
            && start.reference(&holder).is_some()
            && writable(start, &holder)
        {
            for (field, def) in start.fields(&ty) {
                let kind = def["kind"].as_str().unwrap_or_default();
                if start.kept(&ty, &field) || def["sample"] == false {
                    continue;
                }
                if kind == "json" {
                    let value = start.value(&id, &field);
                    let leaves = number_leaves(&value, &field);
                    for leaf in leaves {
                        found.push(Candidate::SetHeld { held: id.clone(), holder: holder.clone(), path: path.clone(), field: leaf });
                    }
                    continue;
                }
                if !SCALARS.contains(&kind) {
                    continue;
                }
                if kind != "string" || !other_values(start, &ty, &field, &start.value(&id, &field)).is_empty() {
                    found.push(Candidate::SetHeld { held: id.clone(), holder: holder.clone(), path: path.clone(), field });
                }
            }
            continue;
        }
        if !writable(start, &id) || !start.stable(&id) {
            continue;
        }
        let named = start.reference(&id).is_some();
        if named || id == start.root() {
            let label = start.text_field(&ty);
            for (field, def) in start.fields(&ty) {
                // A field the kit says is no edit to sample.
                if start.kept(&ty, &field) || def["sample"] == false {
                    continue;
                }
                let kind = def["kind"].as_str().unwrap_or_default();
                if Some(&field) == label.as_ref() {
                    found.push(Candidate::ReplaceText { id: id.clone(), field });
                } else if SCALARS.contains(&kind) && (kind != "string" || !other_values(start, &ty, &field, &start.value(&id, &field)).is_empty()) {
                    found.push(Candidate::SetField { id: id.clone(), field });
                } else if kind == "json" {
                    let value = start.value(&id, &field);
                    let leaves = number_leaves(&value, &field);
                    for field in leaves {
                        found.push(Candidate::SetHeld { held: id.clone(), holder: id.clone(), path: String::new(), field });
                    }
                }
            }
            let place = start.place(&id).cloned();
            if let Some(place) = place.filter(|place| writable(start, &place.parent)) {
                let container = start.type_of(&place.parent).map(|ty| start.kind(ty, &place.field));
                let cascade = start
                    .tree_owner(&place.parent, &place.field)
                    .or_else(|| start.tree_owner(&id, &place.field))
                    .and_then(|owner| start.type_of(&owner))
                    .is_some_and(|ty| start.type_def(ty)["fields"][&place.field]["cascade"] == true);
                if !inverse && container != Some("ref") && (holds_nothing(start, &id) || cascade) {
                    found.push(Candidate::Delete { id: id.clone() });
                }
                if container != Some("map")
                    && (start.items(&place.parent, &place.field).len() > 1 || !other_parents(start, &place.parent, &place.field, &id).is_empty())
                {
                    found.push(Candidate::Move { id: id.clone() });
                }
            }
        }
        // A label at a path inside a json field (`props.name`).
        if let Some(label) = start.text_field(&ty).filter(|label| {
            let field = label.split('.').next().unwrap_or(label);
            (named || id == start.root())
                && label.contains('.')
                && start.value_at(&id, label).is_string()
                && !start.kept(&ty, field)
                && start.type_def(&ty)["fields"][field]["sample"] != false
        }) {
            found.push(Candidate::ReplaceText { id: id.clone(), field: label });
        }
        if named || id == start.root() {
            for (field, def) in start.fields(&ty) {
                if def["sample"] == false {
                    continue;
                }
                let of = def["of"].as_str().unwrap_or_default();
                let stable_of = !start.uses_tool_ids() || start.type_def(of)["toolId"].is_object();
                if matches!(def["kind"].as_str(), Some("list" | "tree")) && def["readOnly"] != true && !of.is_empty() && !start.read_only(of, None) && stable_of
                {
                    found.push(Candidate::Create { parent: id.clone(), field: field.clone(), of: of.to_owned() });
                    if def["kind"] == "tree" {
                        for node in start.ids().into_iter().filter(|node| start.tree_owner(node, &field).as_ref() == Some(&id) && writable(start, node)) {
                            if node != id {
                                found.push(Candidate::Create { parent: node, field: field.clone(), of: of.to_owned() });
                            }
                        }
                    }
                }
                if def["kind"] == "map" && def["owns"] == true && def["readOnly"] != true {
                    let types: std::collections::BTreeSet<_> =
                        start.items(&id, &field).iter().filter_map(|child| start.type_of(child)).map(str::to_owned).collect();
                    for of in types {
                        if !start.read_only(&of, None) && (!start.uses_tool_ids() || start.type_def(&of)["toolId"].is_object()) {
                            found.push(Candidate::Create { parent: id.clone(), field: field.clone(), of });
                        }
                    }
                }
            }
        }
    }
    found.retain(|candidate| kinds.is_none_or(|kinds| kinds.iter().any(|kind| kind == candidate.kind())));
    found
}

/// A target as a batch names it.
fn target(start: &Snapshot, id: &str) -> String {
    if id == start.root() { "root".to_owned() } else { id.to_owned() }
}

/// A word of `vocabulary` other than `current`.
fn word(rng: &mut Rng, vocabulary: &[String], current: &Value) -> Option<String> {
    let current = crate::snapshot::text_of(current);
    let words: Vec<&String> = vocabulary.iter().filter(|word| word.trim() != current.trim()).collect();
    rng.pick(&words).map(|word| (*word).clone())
}

fn number(def: &Value, current: &Value, rng: &mut Rng) -> Option<Value> {
    constrained_number(def, &Value::Null, current, rng)
}

fn constrained_number(def: &Value, conditional: &Value, current: &Value, rng: &mut Rng) -> Option<Value> {
    let integer = def["kind"] == "integer";
    let step = conditional["multipleOf"].as_f64().or_else(|| def["multipleOf"].as_f64()).unwrap_or(if integer { 1.0 } else { 0.5 });
    let min = def["minimum"].as_f64().unwrap_or(f64::NEG_INFINITY).max(conditional["minimum"].as_f64().unwrap_or(f64::NEG_INFINITY));
    let max = def["maximum"].as_f64().unwrap_or(f64::INFINITY).min(conditional["maximum"].as_f64().unwrap_or(f64::INFINITY));
    if min > max || !step.is_finite() || step <= 0.0 {
        return None;
    }
    let current = current.as_f64().unwrap_or(0.0);
    let center = current.clamp(min, max);
    let mut values = Vec::new();
    for units in [1.0, 2.0, 3.0, -1.0, -2.0, -3.0].map(|delta| (center / step).round() + delta).into_iter().chain([(min / step).ceil(), (max / step).floor()]) {
        let value = units * step;
        let accepts = |limits: &Value| {
            limits["multipleOf"].as_f64().is_none_or(|step| {
                let units = value / step;
                units.is_finite() && (units - units.round()).abs() <= 1e-9
            })
        };
        if value.is_finite() && value != current && value >= min && value <= max && (!integer || value.fract() == 0.0) && accepts(def) && accepts(conditional) {
            values.push(if integer { json!(value as i64) } else { json!(value) });
        }
    }
    rng.pick(&values).cloned()
}

/// The write of `field` (of `ty`) with `value`: `text.set` for a text field.
fn write(start: &Snapshot, ty: &str, id: &str, field: &str, value: Value) -> Value {
    if start.kind(ty, field) == "text" {
        json!({ "op": "text.set", "target": target(start, id), "field": field, "text": crate::snapshot::text_of(&value) })
    } else {
        json!({ "op": "set", "target": target(start, id), "field": field, "value": value })
    }
}

/// The batch operations of `candidate`, its values drawn by `rng`; none when it has no value to write.
fn build(candidate: &Candidate, start: &Snapshot, rng: &mut Rng, vocabulary: &[String]) -> Option<Vec<Value>> {
    match candidate {
        Candidate::SetField { id, field } => {
            let ty = start.type_of(id)?;
            let def = &start.type_def(ty)["fields"][field];
            let current = start.value(id, field);
            let value = match def["kind"].as_str()? {
                "enum" => {
                    let values: Vec<Value> = def["values"].as_array()?.iter().filter(|value| **value != current).cloned().collect();
                    rng.pick(&values)?.clone()
                }
                "boolean" => Value::Bool(!current.as_bool().unwrap_or(false)),
                "integer" | "number" => constrained_number(def, &start.described["objectLimits"][id][field], &current, rng)?,
                _ => rng.pick(&other_values(start, ty, field, &current))?.clone(),
            };
            Some(vec![write(start, ty, id, field, value)])
        }
        Candidate::SetHeld { held, holder, path, field } => {
            let ty = start.type_of(held)?;
            let def = &start.type_def(ty)["fields"][field.split('.').next().unwrap_or(field)];
            let limits = field.split_once('.').map(|(root, member)| &def["members"][member_pattern(&start.value(held, root), member)]).unwrap_or(def);
            let current = start.value_at(held, field);
            let kind = if def["kind"] == "json" { "number" } else { def["kind"].as_str()? };
            let value = match kind {
                "enum" => {
                    let values: Vec<Value> = def["values"].as_array()?.iter().filter(|value| **value != current).cloned().collect();
                    rng.pick(&values)?.clone()
                }
                "boolean" => Value::Bool(!current.as_bool().unwrap_or(false)),
                "integer" | "number" => constrained_number(limits, &start.described["objectLimits"][held][field], &current, rng)?,
                _ => rng.pick(&other_values(start, ty, field, &current))?.clone(),
            };
            let field = if path.is_empty() { field.clone() } else { format!("{path}.{field}") };
            Some(vec![json!({ "op": "set", "target": target(start, holder), "field": field, "value": value })])
        }
        Candidate::ReplaceText { id, field } => {
            let ty = start.type_of(id)?;
            let current = crate::snapshot::text_of(&start.value_at(id, field));
            if current.chars().count() > kition_kdm::diff::EXCERPT_CHARS {
                let (offset, removed) = text_fragment(&current, rng)?;
                let replacement = word(rng, vocabulary, &json!(removed))?;
                let mut after: Vec<char> = current.chars().collect();
                after.splice(offset..offset + removed.chars().count(), replacement.chars());
                let after: String = after.into_iter().collect();
                let span = kition_kdm::diff::text_span(&current, &after)?;
                return crate::changes::span_ops(&json!({"field":field,"span":span}), id, ty, start).ok();
            }
            let text = word(rng, vocabulary, &json!(current))?;
            Some(vec![write(start, ty, id, field, Value::String(text))])
        }
        Candidate::Delete { id } => {
            let mut ops = Vec::new();
            if let Some(place) = start.place(id)
                && start.type_of(&place.parent).is_some_and(|ty| start.kind(ty, &place.field) == "map")
            {
                let entries = start.value(&place.parent, &place.field);
                let (key, _) = entries
                    .as_object()?
                    .iter()
                    .find(|(_, value)| kition_kdm::FieldDef::map_held(&json!({"entry":value}), |candidate| candidate == id).len() == 1)?;
                let held = kition_kdm::FieldDef::map_held(&json!({"entry":entries[key]}), |candidate| start.objects.contains_key(candidate));
                if held.len() != 1 {
                    return None;
                }
                ops.push(json!({"op":"map.delete","target":target(start,&place.parent),"field":place.field,"key":key}));
            }
            ops.push(json!({ "op": "delete", "target": target(start, id) }));
            Some(ops)
        }
        Candidate::Move { id } => {
            let place = start.place(id)?;
            let count = start.items(&place.parent, &place.field).len();
            let mut destinations: Vec<(String, usize)> = (0..count).filter(|at| *at != place.index).map(|at| (place.parent.clone(), at)).collect();
            for other in other_parents(start, &place.parent, &place.field, id) {
                let length = start.items(&other, &place.field).len();
                destinations.extend((0..=length).map(|at| (other.clone(), at)));
            }
            let (parent, at) = rng.pick(&destinations)?.clone();
            let field = &place.field;
            if start.type_of(id).is_some_and(|ty| start.type_def(ty)["projected"] == true) {
                return Some(vec![json!({"op":"list.move","target":id,"in":format!("{parent}.{field}"),"to":at})]);
            }
            if start.tree_owner(&parent, field).is_some() {
                return start.tree_move(id, &parent, field, at);
            }
            Some(if parent == place.parent {
                vec![
                    json!({ "op": "list.move", "target": target(start, &parent), "field": field, "from": place.index, "to": if at > place.index { at + 1 } else { at } }),
                ]
            } else {
                vec![
                    json!({ "op": "list.remove", "target": target(start, &place.parent), "field": field, "index": place.index }),
                    json!({ "op": "list.insert", "target": target(start, &parent), "field": field, "item": id, "index": at }),
                ]
            })
        }
        Candidate::Create { parent, field, of } => {
            let models: Vec<String> = start.ids().into_iter().filter(|id| start.type_of(id) == Some(of.as_str())).collect();
            let model = rng.pick(&models).cloned();
            let label = start.label_field(of);
            let mut fields = start.type_def(of)["creation"]["fields"].as_object().cloned().unwrap_or_default();
            for (name, def) in start.fields(of) {
                if fields.contains_key(&name) {
                    continue;
                }
                let kind = def["kind"].as_str().unwrap_or_default();
                if start.creation_kept(of, &name) || !(SCALARS.contains(&kind) || matches!(kind, "text" | "json") || kind == "ref" && def["owns"] == true) {
                    continue;
                }
                let copied = model.as_ref().map(|model| start.value(model, &name)).filter(|value| !value.is_null());
                let value = if Some(&name) == label.as_ref() {
                    Value::String(word(rng, vocabulary, &copied.clone().unwrap_or(Value::Null))?)
                } else if let Some(value) = copied {
                    value
                } else if def["optional"] == true {
                    continue;
                } else {
                    match kind {
                        "enum" => def["values"][0].clone(),
                        "boolean" => Value::Bool(false),
                        "integer" | "number" => number(&def, &Value::Null, rng)?,
                        "json" if start.type_def(of)["creation"]["command"].is_object() => continue,
                        "json" => return None,
                        _ => Value::String(rng.pick(vocabulary)?.clone()),
                    }
                };
                fields.insert(name, value);
            }
            let at = rng.below(start.items(parent, field).len() + 1);
            let create = json!({"op":"create","type":of,"in":format!("{}.{field}",target(start,parent)),"at":at,"ref":"$new","fields":fields});
            if let Some(command) = crate::changes::creation_command(start, of, &create) {
                return Some(vec![command]);
            }
            let (fields, mut before, containers) = create_fields(of, &fields, start, "$new").ok()?;
            if start.type_of(parent).is_some_and(|ty| start.kind(ty, field) == "map") {
                let entries = start.value(parent, field);
                let entries = entries.as_object()?;
                let keys: Vec<_> = vocabulary.iter().filter(|key| !entries.contains_key(*key)).collect();
                let key = rng.pick(&keys)?;
                before.push(json!({"op":"create","type":of,"ref":"$new","fields":fields}));
                before.extend(containers);
                before.push(json!({"op":"map.set","target":target(start,parent),"field":field,"key":key,"value":"$new"}));
                return Some(before);
            }
            if let Some(owner) = start.tree_owner(parent, field) {
                let parent_node = if parent == &owner { Value::Null } else { json!(parent) };
                let mut ops = before;
                ops.push(json!({ "op": "create", "type": of, "in": format!("{}.{field}", target(start, &owner)), "parent": parent_node, "ref": "$new", "fields": fields }));
                ops.extend(start.tree_move("$new", parent, field, at)?);
                ops.extend(containers);
                return Some(ops);
            }
            before.push(json!({ "op": "create", "type": of, "in": format!("{}.{field}", target(start, parent)), "at": at, "ref":"$new", "fields": fields }));
            let mut ops = before;
            ops.extend(containers);
            Some(ops)
        }
    }
}

/// A word, line or sentence around a seeded character, small enough for a complete span.
fn text_fragment(text: &str, rng: &mut Rng) -> Option<(usize, String)> {
    let chars: Vec<_> = text.chars().collect();
    let seed = rng.below(chars.len());
    let at = (0..chars.len()).map(|n| (seed + n) % chars.len()).find(|at| !chars[*at].is_whitespace())?;
    let mode = rng.below(3);
    let boundary = |c: char| match mode {
        0 => c.is_whitespace(),
        1 => matches!(c, '\n' | '\r'),
        _ => matches!(c, '.' | '!' | '?' | '\n' | '\r'),
    };
    let mut start = at;
    let mut end = at + 1;
    while start > 0 && !boundary(chars[start - 1]) {
        start -= 1;
    }
    while end < chars.len() && !boundary(chars[end]) {
        end += 1;
    }
    while start < end && chars[start].is_whitespace() {
        start += 1;
    }
    while end > start && chars[end - 1].is_whitespace() {
        end -= 1;
    }
    if end - start > 60 {
        start = at;
        end = at + 1;
        while start > 0 && at - start < 30 && !chars[start - 1].is_whitespace() {
            start -= 1;
        }
        while end < chars.len() && end - start < 60 && !chars[end].is_whitespace() {
            end += 1;
        }
    }
    (start < end).then(|| (start, chars[start..end].iter().collect()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn creation_templates_supply_required_values_and_container_sampling_is_respected() {
        let start = Snapshot {
            described: json!({"root":"Root","types":{
                "Root":{"fields":{"nodes":{"kind":"list","of":"Node","sample":false}}},
                "Node":{"creation":{"fields":{"kind":{"shape":"box"}}},"fields":{"name":{"kind":"string"},"kind":{"kind":"json","readOnly":true}}}
            }}),
            root: "root".into(),
            objects: BTreeMap::from([("root".into(), json!({"$type":"Root","nodes":[]}))]),
            places: BTreeMap::new(),
            owned: BTreeMap::new(),
            owned_by: BTreeMap::new(),
            schema: None,
        };
        assert!(candidates(&start, Some(&["create".into()]), false).is_empty(), "sample:false containers cannot create tasks");
        let candidate = Candidate::Create { parent: "root".into(), field: "nodes".into(), of: "Node".into() };
        let ops = build(&candidate, &start, &mut Rng::new(7, 0), &["New".into()]).expect("template supplies the required immutable JSON");
        assert_eq!(ops[0]["fields"]["kind"], json!({"shape":"box"}));
    }

    #[test]
    fn sampling_weights_types_equally_even_with_a_large_map() {
        let mut start = Snapshot {
            described: json!({}),
            root: "root".into(),
            objects: BTreeMap::new(),
            places: BTreeMap::new(),
            owned: BTreeMap::new(),
            owned_by: BTreeMap::new(),
            schema: None,
        };
        let mut candidates = Vec::new();
        for index in 0..1001 {
            let id = index.to_string();
            start.objects.insert(id.clone(), json!({"$type":if index == 1000 {"Sheet"} else {"Cell"}}));
            candidates.push(Candidate::SetField { id, field: "value".into() });
        }
        let candidates: Vec<_> = candidates.iter().collect();
        let sheets =
            (0..1000).filter(|index| pick_type_balanced(&candidates, &start, &mut Rng::new(7, *index)).unwrap().object_type(&start) == "Sheet").count();
        assert!((400..600).contains(&sheets), "one Sheet competes equally with 1000 Cells: {sheets}");
    }

    #[test]
    fn create_copies_a_required_json_kind_from_an_existing_node() {
        let mut start = Snapshot {
            described: json!({ "root": "Root", "types": {
                "Root": { "fields": { "nodes": { "kind": "list", "of": "Node" } } },
                "Node": { "fields": { "name": { "kind": "string" }, "kind": { "kind": "json", "sample": false } } }
            } }),
            root: "root".into(),
            objects: BTreeMap::from([
                ("root".into(), json!({ "$type": "Root", "nodes": ["one"] })),
                ("one".into(), json!({ "$type": "Node", "name": "Original", "kind": { "type": "frame" } })),
            ]),
            places: BTreeMap::new(),
            owned: BTreeMap::new(),
            owned_by: BTreeMap::new(),
            schema: None,
        };
        let candidate = Candidate::Create { parent: "root".into(), field: "nodes".into(), of: "Node".into() };
        let ops = build(&candidate, &start, &mut Rng::new(7, 0), &["Sampled".into()]).unwrap();
        assert_eq!(ops[0]["fields"]["kind"], json!({ "type": "frame" }));
        start.objects.remove("one");
        assert!(build(&candidate, &start, &mut Rng::new(7, 0), &["Sampled".into()]).is_none(), "a required JSON value must have an example");
    }
}
