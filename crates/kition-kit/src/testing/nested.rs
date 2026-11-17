//! [`check_nested_dispatch_is_gated`]: a kit's own batch, macro, and script commands run their
//! steps through the host's gate ([`crate::dispatch::may_run`]).

use std::sync::{Arc, Mutex, PoisonError};

use serde_json::{Value, json};

use crate::dispatch::{self, Gate, Refusal, RefusalCode, Role};
use crate::{KitCommand, KitDocument};

/// A kit command that runs other commands, and how to make it run one step: `wrap(command,
/// params)` answers the dispatcher's parameters for a single step that runs `command` with
/// `params` (`|id, params| json!({ "steps": [{ "command": id, "params": params }] })`), for a
/// dispatcher whose step form the check cannot guess (a script language, required settings).
#[derive(Clone, Copy)]
pub struct Dispatcher<'a> {
    pub command: &'a str,
    pub wrap: fn(&str, &Value) -> Value,
}

/// Parameter names that hold a list of steps.
const STEP_LISTS: &[&str] = &["steps", "commands", "actions", "operations", "ops", "macro", "batch", "sequence"];
/// Keys of a step object that name its command.
const STEP_KEYS: &[&str] = &["command", "cmd", "commandId"];
/// Parameter names that hold a script or a command line.
const SCRIPTS: &[&str] = &["script", "code", "macro", "program", "commands", "commandLine", "line"];
/// Words in a command id that say it runs other commands.
const RUNNERS: &[&str] = &["script", "macro", "batch", "automat", "eval", "commandline", "repeat", "replay", "play"];

/// The gate the check sets: it refuses `refused` and records every command it was asked about.
struct Recording {
    refused: String,
    asked: Mutex<Vec<String>>,
}

impl Gate for Recording {
    fn role(&self) -> Role {
        Role::Agent
    }

    fn check(&self, command: &str, _params: &Value) -> Result<(), Refusal> {
        self.asked.lock().unwrap_or_else(PoisonError::into_inner).push(command.to_owned());
        if command == self.refused { Err(Refusal::new(RefusalCode::NotAllowed, command, "not for the agent (the check's gate)")) } else { Ok(()) }
    }
}

/// How a step names its command in an array parameter's items, when the items say.
fn step_key(items: &Value) -> Option<&'static str> {
    let properties = items.get("properties")?.as_object()?;
    STEP_KEYS.iter().copied().find(|key| properties.contains_key(*key))
}

/// The ways the check tries to put one step into `command`'s parameters, from its schema: a list
/// of step objects, a script or command line. Empty when its schema shows none.
fn guesses(command: &KitCommand) -> Vec<fn(&str, &str, &Value) -> Value> {
    let Some(Value::Object(properties)) = &command.schema else { return Vec::new() };
    let id = command.id.to_ascii_lowercase();
    let runner = RUNNERS.iter().any(|word| id.contains(word));
    let mut forms: Vec<fn(&str, &str, &Value) -> Value> = Vec::new();
    for (name, node) in properties {
        let kind = node.get("type").and_then(Value::as_str).unwrap_or("json");
        let items = node.get("items").unwrap_or(&Value::Null);
        if kind == "array" && (step_key(items).is_some() || STEP_LISTS.iter().any(|list| list.eq_ignore_ascii_case(name))) {
            forms.push(|param, step, params| json!({ param: [{ "command": step, "params": params }] }));
            forms.push(|param, step, params| json!({ param: [{ "cmd": step, "params": params }] }));
            forms.push(|param, step, params| json!({ param: [{ "id": step, "params": params }] }));
        } else if kind == "string" && (SCRIPTS.iter().any(|script| script.eq_ignore_ascii_case(name)) || runner) {
            forms.push(|param, step, params| json!({ param: format!("{step} {params}") }));
            forms.push(|param, step, _| json!({ param: step }));
        }
    }
    forms
}

/// The parameter a guessed form fills: the first that looks like steps or a script.
fn step_param(command: &KitCommand) -> Option<String> {
    let Some(Value::Object(properties)) = &command.schema else { return None };
    let id = command.id.to_ascii_lowercase();
    let runner = RUNNERS.iter().any(|word| id.contains(word));
    properties
        .iter()
        .find(|(name, node)| {
            let kind = node.get("type").and_then(Value::as_str).unwrap_or("json");
            let items = node.get("items").unwrap_or(&Value::Null);
            (kind == "array" && (step_key(items).is_some() || STEP_LISTS.iter().any(|list| list.eq_ignore_ascii_case(name))))
                || (kind == "string" && (SCRIPTS.iter().any(|script| script.eq_ignore_ascii_case(name)) || runner))
        })
        .map(|(name, _)| name.clone())
}

/// A command a dispatcher can run with `{}`: the step the check's gate refuses. One that only
/// reads, if there is one, so a dispatcher that does not ask changes as little as possible.
fn victim<'a>(commands: &'a [KitCommand], dispatchers: &[&str]) -> Option<&'a KitCommand> {
    let takes_empty = |command: &&KitCommand| {
        !dispatchers.contains(&command.id.as_str())
            && !matches!(command.id.as_str(), "edit.undo" | "edit.redo")
            && command
                .schema
                .as_ref()
                .and_then(Value::as_object)
                .is_some_and(|properties| properties.values().all(|node| node.get("required") != Some(&Value::Bool(true))))
    };
    commands.iter().filter(takes_empty).find(|command| !command.mutates).or_else(|| commands.iter().find(takes_empty))
}

/// Checks that every command of the kit that runs other commands asks the host's gate before each
/// step ([`crate::dispatch::may_run`], engine contract): a step the gate refuses must fail the
/// call. The check finds the dispatchers it can by their schema, a heuristic:
///
/// - an array parameter whose items name a command (`command`, `cmd`, `commandId`), or named like a
///   list of steps (`steps`, `commands`, `actions`, `ops`, `macro`, `batch`, …);
/// - a string parameter named like a script or a command line (`script`, `code`, `macro`,
///   `commandLine`, …), or any string parameter of a command whose id says it runs others
///   (`script`, `macro`, `batch`, `automate`, `eval`, `commandLine`, `repeat`, `play`, …).
///
/// For each it picks a command of the kit that takes `{}` (one that only reads when there is one),
/// sets a gate that refuses that command for the agent and allows the rest, and calls the
/// dispatcher with one step running it, on a fresh document from `fresh`. The dispatcher passes
/// when the gate was asked about the step and the call failed. It fails when it ran without
/// asking, when it ran on after the gate refused, and when no step form reached the gate: then the
/// kit gives the form in `dispatchers` (`wrap`), or lists the command in `not_dispatchers` with why
/// it runs no commands (`("html.setSource", "the source is HTML; scripts in it run no kit
/// commands")`). Entries of both lists must name commands of the kit; `not_dispatchers` only the
/// heuristic's finds, so neither list can go stale.
///
/// What it cannot catch: a dispatcher the heuristic does not find (steps under another name, in a
/// nested object, or read from the document, such as a workbook's stored scripts) unless the kit
/// lists it in `dispatchers`; a script language whose call syntax the guesses miss; steps that
/// name commands other than by id; and a dispatcher that asks for its first step and not the rest.
/// It proves the gate is consulted, not that every path through the dispatcher is.
///
/// Answers the dispatchers it checked.
pub fn check_nested_dispatch_is_gated<D: KitDocument>(
    mut fresh: impl FnMut() -> D,
    dispatchers: &[Dispatcher<'_>],
    not_dispatchers: &[(&str, &str)],
) -> Result<Vec<String>, Vec<String>> {
    let commands = fresh().commands();
    let mut problems = Vec::new();
    for declared in dispatchers {
        if !commands.iter().any(|command| command.id == declared.command) {
            problems.push(format!("dispatchers names {}, which is not a command", declared.command));
        }
    }
    let found: Vec<&KitCommand> = commands.iter().filter(|command| !guesses(command).is_empty()).collect();
    for (id, reason) in not_dispatchers {
        if !found.iter().any(|command| command.id == *id) {
            problems.push(format!("not_dispatchers names {id}, which the check does not take for a dispatcher"));
        } else if reason.trim().is_empty() {
            problems.push(format!("not_dispatchers gives no reason for {id}"));
        }
    }
    let mut checked: Vec<&str> = dispatchers.iter().map(|declared| declared.command).collect();
    for command in &found {
        if !checked.contains(&command.id.as_str()) && !not_dispatchers.iter().any(|(id, _)| *id == command.id) {
            checked.push(&command.id);
        }
    }
    let Some(step) = victim(&commands, &checked) else {
        if !checked.is_empty() {
            problems.push("no command takes `{}`, so the check has no step to refuse".into());
        }
        return if problems.is_empty() { Ok(Vec::new()) } else { Err(problems) };
    };
    for id in &checked {
        let Some(command) = commands.iter().find(|command| command.id == *id) else { continue };
        let tries: Vec<Value> = match dispatchers.iter().find(|declared| declared.command == *id) {
            Some(declared) => vec![(declared.wrap)(&step.id, &json!({}))],
            None => {
                let param = step_param(command).unwrap_or_default();
                guesses(command).into_iter().map(|form| form(&param, &step.id, &json!({}))).collect()
            }
        };
        let mut reached = false;
        for params in &tries {
            let gate = Arc::new(Recording { refused: step.id.clone(), asked: Mutex::new(Vec::new()) });
            let mut doc = fresh();
            let answer = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| dispatch::with_gate(gate.clone(), || doc.execute(id, params.clone()))));
            let _ = dispatch::take_refusal();
            let asked = gate.asked.lock().unwrap_or_else(PoisonError::into_inner).contains(&step.id);
            match answer {
                Err(_) => {
                    problems.push(format!("{id}: panicked running {params}"));
                    reached = true;
                    break;
                }
                Ok(Ok(_)) if asked => {
                    problems.push(format!("{id}: ran on after the gate refused its step `{}` ({params})", step.id));
                    reached = true;
                    break;
                }
                Ok(Ok(_)) => {
                    problems.push(format!("{id}: ran its step `{}` without asking kition_kit::dispatch::may_run ({params})", step.id));
                    reached = true;
                    break;
                }
                Ok(Err(_)) if asked => {
                    reached = true;
                    break;
                }
                Ok(Err(_)) => {}
            }
        }
        if !reached {
            let tried: Vec<String> = tries.iter().map(Value::to_string).collect();
            problems.push(format!(
                "{id}: no step reached kition_kit::dispatch::may_run (tried {}): give its step form in dispatchers, or list it in not_dispatchers with why it runs no commands",
                if tried.is_empty() { "nothing".to_owned() } else { tried.join(", ") }
            ));
        }
    }
    if problems.is_empty() { Ok(checked.into_iter().map(str::to_owned).collect()) } else { Err(problems) }
}

/// A [`Dispatcher`]'s `wrap` for the usual form, `{ "steps": [{ command, params }] }`.
#[must_use]
pub fn step_list(command: &str, params: &Value) -> Value {
    json!({ "steps": [{ "command": command, "params": params }] })
}
