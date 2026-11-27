//! regressions/issue-agent-command-gate: every way an agent runs a command passes the gate
//! `command.execute` applies (KHP A28, A29, §10.6). Before, a `command` operation of `model.batch`
//! went straight to the kit's `execute_as`: a command that names files, which `command.execute`
//! refuses and `command.list` leaves out, ran from an agent's batch (a workspace
//! audit ran film's `lut.export`, vector's `file.export` and layout's `file.saveACopy` this
//! way).

use std::sync::Arc;

use kition_kit::kdm::{Origin as KdmOrigin, Schema};
use kition_kit::session::model::ReplicaPort;
use kition_kit::session::{KitSession, KitSessionDocument};

use super::*;
use crate::test_support::lent_turn;

mod notes {
    #![allow(dead_code)]
    include!("../../kition-kit/tests/model.rs");
}

/// The notes kit of `kition-kit`'s tests, with commands an agent may not run: one that names a
/// file by its parameter's name (no schema), one that names it by type, and one its manifest leaves
/// out of the agent's list (`agent.exclude`). Each only records that it ran.
struct Gated {
    notes: notes::NotesDocument,
    ran: Vec<String>,
    /// Whom each `macro.run` ran for ([`kition_kit::dispatch::role`]).
    roles: Vec<Option<kition_kit::dispatch::Role>>,
}

const HIDDEN: [&str; 3] = ["file.writeCopy", "notes.exportPicture", "notes.secret"];

const MANIFEST: &str = r#"{
  "id": "kit.notes", "version": "0.1.0",
  "formats": [{ "id": "notes", "extensions": ["notes"], "role": "edit" }],
  "agent": { "prefix": "notes", "exclude": ["notes.secret"] }
}"#;

fn gated_kit() -> KitInfo {
    KitInfo::from_manifest(MANIFEST, &[], &[]).unwrap()
}

impl KitDocument for Gated {
    fn open(name: &str, bytes: &[u8]) -> Result<Self, String> {
        Ok(Self { notes: <notes::NotesDocument as KitDocument>::open(name, bytes)?, ran: Vec::new(), roles: Vec::new() })
    }
    fn create(name: &str, width: u32, height: u32) -> Result<Self, String> {
        Ok(Self { notes: <notes::NotesDocument as KitDocument>::create(name, width, height)?, ran: Vec::new(), roles: Vec::new() })
    }
    fn width(&self) -> u32 {
        1
    }
    fn height(&self) -> u32 {
        1
    }
    fn revision(&self) -> u64 {
        0
    }
    fn dirty(&self) -> bool {
        false
    }
    fn render(&self, x: f64, y: f64, scale: f64, width: u32, height: u32) -> Result<Vec<u8>, String> {
        self.notes.render(x, y, scale, width, height)
    }
    fn render_area(&self, x0: i32, y0: i32, x1: i32, y1: i32, width: u32, height: u32) -> Result<Vec<u8>, String> {
        self.notes.render_area(x0, y0, x1, y1, width, height)
    }
    fn execute(&mut self, command: &str, params: Value) -> Result<Value, String> {
        self.execute_as(command, params, &KdmOrigin::person("person:local"))
    }
    fn inspect(&self) -> Result<Value, String> {
        self.notes.inspect()
    }
    fn commands(&self) -> Vec<KitCommand> {
        let mut commands = KitDocument::commands(&self.notes);
        commands.push(KitCommand {
            id: "file.writeCopy".into(),
            title: "Write a Copy".into(),
            params: Some("{path}".into()),
            enabled: true,
            ..Default::default()
        });
        commands.push(KitCommand {
            id: "notes.exportPicture".into(),
            title: "Export Picture".into(),
            schema: Some(json!({ "to": { "type": "file", "access": "create", "accept": ["png"], "required": true } })),
            enabled: true,
            ..Default::default()
        });
        commands.push(KitCommand { id: "notes.secret".into(), title: "Secret".into(), schema: Some(json!({})), enabled: true, ..Default::default() });
        // The kit's own dispatcher: runs its steps in order, each through the host's gate.
        commands.push(KitCommand {
            id: "macro.run".into(),
            title: "Run Steps".into(),
            schema: Some(json!({ "steps": { "type": "array", "required": true, "items": { "type": "object", "additionalProperties": false, "properties": {
                "command": { "type": "string", "required": true },
                "params": { "type": "json" },
            } } } })),
            mutates: true,
            enabled: true,
            ..Default::default()
        });
        commands
    }
    fn save(&self, name: Option<&str>) -> Result<Vec<u8>, String> {
        self.notes.save(name)
    }
    fn mark_saved(&mut self) {}
}

impl KitSessionDocument for Gated {
    type Model = notes::Notes;

    fn session(&self) -> &KitSession<notes::Notes> {
        self.notes.session()
    }

    fn session_mut(&mut self) -> &mut KitSession<notes::Notes> {
        self.notes.session_mut()
    }

    fn execute_as(&mut self, command: &str, params: Value, origin: &KdmOrigin) -> Result<Value, String> {
        if command == "macro.run" {
            self.roles.push(kition_kit::dispatch::role());
            let mut results = Vec::new();
            for step in params["steps"].as_array().cloned().unwrap_or_default() {
                let (id, step_params) = (step["command"].as_str().unwrap_or_default(), step.get("params").cloned().unwrap_or_else(|| json!({})));
                kition_kit::dispatch::may_run(id, &step_params)?;
                results.push(self.execute_as(id, step_params, origin)?);
            }
            return Ok(Value::Array(results));
        }
        if HIDDEN.contains(&command) {
            self.ran.push(command.to_owned());
            return Ok(json!({}));
        }
        self.notes.execute_as(command, params, origin)
    }
}

impl ReplicaPort for Gated {
    fn model_schema(&self) -> Arc<Schema> {
        self.notes.model_schema()
    }
    fn model_export(&mut self, since: &[u8]) -> Result<Vec<u8>, String> {
        self.notes.model_export(since)
    }
    fn model_import(&mut self, bytes: &[u8]) -> Result<(), String> {
        self.notes.model_import(bytes)
    }
    fn model_command(&mut self, command: &str, params: Value, origin: &KdmOrigin) -> Result<Value, String> {
        KitSessionDocument::execute_as(self, command, params, origin)
    }
    fn model_commands(&self) -> Vec<KitCommand> {
        KitDocument::commands(self)
    }
}

fn workspace(name: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("kition-headless-gate-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let dir = std::fs::canonicalize(dir).unwrap();
    std::fs::write(dir.join("ideas.notes"), b"").unwrap();
    dir
}

type Make = fn(KitInfo) -> Headless<Gated>;
const MAKERS: [(&str, Make); 2] = [("replica port", Headless::<Gated>::with_replica_port), ("session model", Headless::<Gated>::with_session_model)];

fn opened(make: Make, root: &std::path::Path) -> (Headless<Gated>, HostFolder, String) {
    let mut kit = make(gated_kit());
    let folder = HostFolder::new(root).unwrap();
    kit.set_host(folder.host());
    let id = kit.open(OpenRequest { file: &folder.file("ideas.notes").unwrap(), read_only: false, create: None }).unwrap().id;
    (kit, folder, id)
}

fn ran(kit: &Headless<Gated>, id: &str) -> Vec<String> {
    kit.docs[kit.position(id).unwrap()].doc.ran.clone()
}

fn reason(error: &RpcError) -> Value {
    error.data.as_ref().map_or(Value::Null, |data| data["reason"].clone())
}

/// A batch that adds a note, then runs `command` with `params`, as `kind`.
fn batch(id: &str, kind: &str, command: &str, params: Value) -> Value {
    json!({ "documentId": id, "origin": { "kind": kind, "principal": "test" }, "ops": [
        { "op": "create", "type": "Note", "in": "root.notes", "ref": "$a" },
        { "op": "text.set", "target": "$a", "field": "body", "text": "first" },
        { "op": "command", "id": command, "params": params },
    ] })
}

#[test]
fn a_batch_runs_no_command_commands_execute_refuses() {
    let _turn = lent_turn();
    let root = workspace("batch");
    for (name, make) in MAKERS {
        let (mut kit, _folder, id) = opened(make, &root);
        for (command, params) in [("file.writeCopy", json!({ "path": "/tmp/outside.notes" })), ("notes.exportPicture", json!({ "to": "/tmp/outside.png" }))] {
            for kind in ["agent", "person"] {
                let refused = kit.model("model.batch", batch(&id, kind, command, params.clone())).unwrap_err();
                assert_eq!(reason(&refused), "command_disabled", "{name}: {command} as {kind}: as command.execute answers: {refused:?}");
                let model = &refused.data.as_ref().unwrap()["model"];
                assert_eq!((model["code"].as_str(), model["index"].as_u64()), (Some("not-allowed"), Some(2)), "{name}: {command}: {model}");
                assert!(ran(&kit, &id).is_empty(), "{name}: {command} ran from a batch as {kind}");
                assert_eq!(kit.describe(&id).unwrap().state["notes"], json!([]), "{name}: nothing in a refused batch runs");
            }
        }
        // An id the kit does not have is the same unknown command command.execute answers.
        let unknown = kit.model("model.batch", batch(&id, "agent", "note.clean", json!({}))).unwrap_err();
        assert_eq!(reason(&unknown), "command_not_found", "{name}: {unknown:?}");
        assert_eq!(unknown.data.as_ref().unwrap()["model"]["code"], "unknown-command", "{name}");
        assert!(unknown.data.as_ref().unwrap()["detail"].as_str().unwrap_or_default().contains("did you mean `note.clear`"), "{name}: {unknown:?}");
        // The manifest leaves `notes.secret` out of the agent's list (`agent.exclude`): the agent
        // runs it neither way; the person does.
        let refused = kit.execute(&id, "notes.secret", Map::new(), Origin::Agent).unwrap_err();
        assert_eq!(reason(&refused), "command_disabled", "{name}");
        let refused = kit.model("model.batch", batch(&id, "agent", "notes.secret", json!({}))).unwrap_err();
        assert_eq!(refused.data.as_ref().unwrap()["model"]["code"], "not-allowed", "{name}");
        assert!(ran(&kit, &id).is_empty(), "{name}: {:?}", ran(&kit, &id));
        kit.execute(&id, "notes.secret", Map::new(), Origin::User).unwrap();
        assert_eq!(ran(&kit, &id), ["notes.secret"], "{name}");
        // A command the agent may run still runs inside its batch.
        let answer = kit.model("model.batch", batch(&id, "agent", "note.clear", json!({}))).unwrap();
        assert_eq!(answer["results"][2], json!({ "removed": 1 }), "{name}");
    }
    let _ = std::fs::remove_dir_all(root);
}

/// A kit's own dispatcher (a batch, macro, or script command the agent may run) runs its steps
/// through the same gate, for the caller the host runs the call for
/// (`kition_kit::dispatch::may_run`), from `command.execute` and from a batch alike; and the
/// agent's connection lists no command the manifest keeps from the agent.
#[test]
fn a_kits_own_dispatcher_runs_its_steps_through_the_gate() {
    let _turn = lent_turn();
    use kition_kit::dispatch::Role;
    let root = workspace("nested");
    for (name, make) in MAKERS {
        let (mut kit, _folder, id) = opened(make, &root);
        let steps = |command: &str| Map::from_iter([("steps".to_owned(), json!([{ "command": command, "params": { "path": "/tmp/outside.notes" } }]))]);
        let refused = kit.execute(&id, "macro.run", steps("file.writeCopy"), Origin::Agent).unwrap_err();
        assert_eq!(reason(&refused), "command_disabled", "{name}: {refused:?}");
        let detail = refused.data.as_ref().unwrap()["detail"].as_str().unwrap_or_default().to_owned();
        assert!(detail.starts_with("`file.writeCopy`: commands that name files"), "{name}: {detail}");
        let refused = kit.execute(&id, "macro.run", Map::from_iter([("steps".to_owned(), json!([{ "command": "notes.secret" }]))]), Origin::Agent).unwrap_err();
        assert_eq!(reason(&refused), "command_disabled", "{name}: {refused:?}");
        let request = json!({ "documentId": id, "origin": { "kind": "agent", "principal": "test" }, "ops": [
            { "op": "command", "id": "macro.run", "params": { "steps": [{ "command": "notes.exportPicture", "params": { "to": "x.png" } }] } },
        ] });
        let refused = kit.model("model.batch", request).unwrap_err();
        let model = &refused.data.as_ref().unwrap()["model"];
        assert_eq!((model["code"].as_str(), model["index"].as_u64()), (Some("not-allowed"), Some(0)), "{name}: {model}");
        assert!(ran(&kit, &id).is_empty(), "{name}: {:?}", ran(&kit, &id));
        // The person's macro runs the manifest's agent-only exclusions; the agent's runs what it may.
        kit.execute(&id, "macro.run", Map::from_iter([("steps".to_owned(), json!([{ "command": "notes.secret" }]))]), Origin::User).unwrap();
        kit.execute(&id, "macro.run", Map::from_iter([("steps".to_owned(), json!([{ "command": "note.clear" }]))]), Origin::Agent).unwrap();
        let index = kit.position(&id).unwrap();
        assert_eq!(kit.docs[index].doc.roles, [Some(Role::Agent), Some(Role::Agent), Some(Role::Agent), Some(Role::Person), Some(Role::Agent)], "{name}");
        assert_eq!(ran(&kit, &id), ["notes.secret"], "{name}");

        let listed = |commands: Vec<CommandSummary>| commands.into_iter().map(|command| command.id).collect::<Vec<_>>();
        let agent = listed(kit.agent_commands(Some(&id)).unwrap());
        assert!(agent.contains(&"macro.run".to_owned()) && !agent.contains(&"notes.secret".to_owned()), "{name}: {agent:?}");
        assert!(listed(kit.commands(Some(&id)).unwrap()).contains(&"notes.secret".to_owned()), "{name}: the person is offered it");
    }
    let _ = std::fs::remove_dir_all(root);
}

/// `agent.include` and `agent.exclude` patterns read as `tools/check-manifest.mjs` reads them: `*`
/// is any run of characters, and a pattern matches the whole id.
#[test]
fn manifest_command_patterns_match_whole_ids() {
    for (pattern, id, matches) in [
        ("file.save*", "file.saveAs", true),
        ("file.save*", "file.save", true),
        ("file.save*", "file.open", false),
        ("edit.*", "edit.undo", true),
        ("*", "anything", true),
        ("a*b*c", "aXbYc", true),
        ("a*b*c", "aXbY", false),
        ("*.export", "file.export", true),
        ("file.open", "file.opens", false),
    ] {
        assert_eq!(kition_kit::dispatch::pattern_matches(pattern, id), matches, "{pattern} {id}");
    }
}

/// regressions/issue-path-in-plain-string: a kit's review that a string carries no path
/// (`notFile`, engine contract E7b) is not JSON Schema, so the published schema leaves it out.
#[test]
fn a_reviewed_string_is_published_as_a_plain_string() {
    let spec = json!({ "source": { "type": "string", "notFile": true, "description": "The HTML source." } });
    assert_eq!(json_schema(Some(&spec), None)["properties"]["source"], json!({ "type": "string", "description": "The HTML source." }));
}
