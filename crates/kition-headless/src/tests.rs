use std::path::{Path, PathBuf};

use super::*;
use crate::test_support::lent_turn;
use grid_kit::GridDocument;
use kition_kit_host::HostService as _;

mod terminal_plan;

#[test]
fn numeric_command_limits_reach_the_mcp_schema() {
    let command =
        KitCommand { id: "opacity".into(), schema: Some(json!({"value":{"type":"number","minimum":0,"maximum":1,"multipleOf":0.1}})), ..Default::default() };
    let schema = params_schema(&command);
    assert_eq!(schema["properties"]["value"]["minimum"], 0);
    assert_eq!(schema["properties"]["value"]["maximum"], 1);
    assert_eq!(schema["properties"]["value"]["multipleOf"], 0.1);
}

/// The reference grid kit, plus one command that would write a file wherever it is told.
struct Grid(GridDocument);

impl KitDocument for Grid {
    fn open(name: &str, bytes: &[u8]) -> Result<Self, String> {
        GridDocument::open(name, bytes).map(Self)
    }
    fn create(name: &str, width: u32, height: u32) -> Result<Self, String> {
        GridDocument::create(name, width, height).map(Self)
    }
    fn width(&self) -> u32 {
        self.0.width()
    }
    fn height(&self) -> u32 {
        self.0.height()
    }
    fn revision(&self) -> u64 {
        self.0.revision()
    }
    fn dirty(&self) -> bool {
        self.0.dirty()
    }
    fn render(&self, x: f64, y: f64, scale: f64, width: u32, height: u32) -> Result<Vec<u8>, String> {
        self.0.render(x, y, scale, width, height)
    }
    fn render_area(&self, x0: i32, y0: i32, x1: i32, y1: i32, width: u32, height: u32) -> Result<Vec<u8>, String> {
        self.0.render_area(x0, y0, x1, y1, width, height)
    }
    /// A grid's pixels are what a zoom shows: its render at scale 2 is the grid at 200 %.
    fn max_render_scale(&self) -> f64 {
        2.0
    }
    fn execute(&mut self, command: &str, params: Value) -> Result<Value, String> {
        if command == "grid.close" {
            return Ok(json!({"closed":true}));
        }
        if command == "file.writeCopy" || command == "grid.exportPicture" {
            return Err("this must never run".into());
        }
        // A kit's typed refusal (`kition_kit::failure`): its reason decides the code, whatever the
        // message says; a message without one is read by its wording.
        if command == "grid.fail" && params["why"] == "locked" {
            return Err(kition_kit::failure::failure(kition_kit::failure::CommandFailure::Disabled, "the label is locked (no such command can change it)"));
        }
        if command == "grid.fail" {
            return Err("unknown command for this label".into());
        }
        if command == "grid.setOptions" || command == "grid.label" {
            return Ok(params);
        }
        if command == "grid.importRows" {
            if params["target"]["row"] == 99 {
                return Err(kition_kit::schema::refusal(&[kition_kit::schema::ParamError {
                    path: "/target/row".into(),
                    message: "`target.row` 99 is past the last row".into(),
                    expected: "a row of the grid".into(),
                }]));
            }
            return Ok(json!({ "imported": params["target"].clone() }));
        }
        // A file the document refers to (E5), read as an engine reads one.
        if command == "grid.measureLent" {
            let media = params["media"].as_str().unwrap_or_default();
            let bytes = kition_kit::host::read(media)?;
            return Ok(json!({ "size": kition_kit::host::size(media)?, "head": String::from_utf8_lossy(&bytes[..bytes.len().min(4)]) }));
        }
        // A link check: whether a file the document refers to is there (E5).
        if command == "grid.lentExists" {
            return Ok(json!({ "exists": kition_kit::host::exists(params["media"].as_str().unwrap_or_default())? }));
        }
        self.0.execute(command, params)
    }
    fn inspect(&self) -> Result<Value, String> {
        self.0.inspect()
    }
    fn commands(&self) -> Vec<KitCommand> {
        let mut commands = self.0.commands();
        commands.push(KitCommand { id: "grid.close".into(), enabled: true, mutates: false, ..Default::default() });
        commands.push(KitCommand {
            id: "file.writeCopy".into(),
            title: "Write a Copy".into(),
            params: Some("{path}".into()),
            enabled: true,
            ..Default::default()
        });
        // `target` is a place in the document, not a file: its schema says so (KHP A28). Its own id:
        // grid-kit's `grid.import` takes a granted file (engine contract E15), and two commands must not share one.
        commands.push(KitCommand {
            id: "grid.importRows".into(),
            title: "Import Rows".into(),
            params: Some("{target, rows}".into()),
            schema: Some(json!({
                "target": { "type": "object", "additionalProperties": false, "properties": { "row": { "type": "integer" } }, "required": true },
                "rows": { "type": "json" },
            })),
            output_schema: Some(json!({
                "type": "object",
                "additionalProperties": false,
                "properties": { "imported": { "type": "json", "required": true } },
            })),
            enabled: true,
            ..Default::default()
        });
        commands.push(KitCommand {
            id: "grid.fail".into(),
            title: "Fail".into(),
            params: Some("{why}".into()),
            schema: Some(json!({ "why": { "type": "string", "required": true } })),
            mutates: false,
            enabled: true,
            ..Default::default()
        });
        commands.push(KitCommand {
            id: "grid.measureLent".into(),
            title: "Measure Lent File".into(),
            params: Some("{media}".into()),
            mutates: false,
            enabled: true,
            ..Default::default()
        });
        commands.push(KitCommand {
            id: "grid.lentExists".into(),
            title: "Check Lent File".into(),
            params: Some("{media}".into()),
            mutates: false,
            enabled: true,
            ..Default::default()
        });
        // A command whose top level takes keys its schema cannot name (any option name), as
        // Photo's `tool.setBrush` takes any brush setting: it says so (`open_params`).
        commands.push(KitCommand {
            id: "grid.setOptions".into(),
            title: "Set Options".into(),
            description: "Sets display options by name, any option the grid knows, and answers what it was given.".into(),
            schema: Some(json!({
                "mode": { "type": "string" },
                "style": { "type": "object", "additionalProperties": true, "properties": { "color": { "type": "string" } } },
            })),
            open_params: true,
            enabled: true,
            ..Default::default()
        });
        // a command whose notation's required parameters are published (`notation_required`);
        // its engine answers whatever it is given, so only the gate can refuse a missing one.
        commands.push(
            KitCommand {
                id: "grid.label".into(),
                title: "Label Cell".into(),
                description: "Writes a label into one cell of the grid and answers what it was given.".into(),
                params: Some(r#"{"row":int,"column":int,"label":str,"bold":bool=false}"#.into()),
                notation_required: true,
                enabled: true,
                ..Default::default()
            }
            .with_kit_schema(),
        );
        // A file parameter by type, under a name no list would guess.
        commands.push(KitCommand {
            id: "grid.exportPicture".into(),
            title: "Export Picture".into(),
            schema: Some(json!({ "picture": { "type": "file", "access": "create", "accept": ["png"], "required": true } })),
            enabled: true,
            ..Default::default()
        });
        commands
    }
    fn save(&self, name: Option<&str>) -> Result<Vec<u8>, String> {
        self.0.save(name)
    }
    fn mark_saved(&mut self) {
        self.0.mark_saved();
    }
    fn exports() -> Vec<&'static str> {
        vec!["txt"]
    }
    fn export(&self, format: &str, _options: &Value) -> Result<Vec<u8>, String> {
        match format {
            "txt" => Ok(format!("grid {} x {}", self.width(), self.height()).into_bytes()),
            _ => Err(format!("no {format}")),
        }
    }
    fn check(&self) -> Vec<kition_kit::diagnostics::Diagnostic> {
        use kition_kit::diagnostics::{Diagnostic, Severity};
        if self.dirty() { vec![Diagnostic::new("grid.unsaved", Severity::Info, "The grid has unsaved changes.")] } else { Vec::new() }
    }
    fn text(&self, limit: usize) -> Result<kition_kit::text::DocumentText, String> {
        let mut text = kition_kit::text::TextBuilder::new(limit);
        text.part("Size", &format!("{} by {}", self.width(), self.height()));
        text.part("Note", "a grid");
        Ok(text.finish())
    }
}

/// `view.screenshot` of the whole document at scale 1, within `max_size`.
fn within(max_size: u32) -> ScreenshotRequest {
    ScreenshotRequest { scope: kition_kit_server::protocol::ScreenshotScope::Canvas, max_size, scale: 1.0, target: None }
}

fn kit() -> KitInfo {
    KitInfo::from_manifest(include_str!("../../../examples/grid-kit/kit.json"), &[], &[]).unwrap()
}

#[test]
fn saves_every_format_the_manifest_gives_the_edit_role() {
    let mut manifest: serde_json::Value = serde_json::from_str(include_str!("../../../examples/grid-kit/kit.json")).unwrap();
    let formats = manifest["formats"].as_array_mut().unwrap();
    formats.insert(0, serde_json::json!({ "id": "sheet", "extensions": ["txt"], "role": "view" }));
    formats.push(serde_json::json!({ "id": "picture", "extensions": ["png"], "role": "edit" }));
    let kit = KitInfo::from_manifest(&manifest.to_string(), &[], &[]).unwrap();
    assert_eq!(kit.saves, ["grid", "picture"], "the edit formats, the native one first");
    assert_eq!(kit.formats[0].0, "grid");
    assert_eq!(self::kit().saves, ["grid"]);
}

fn workspace(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("kition-headless-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(dir.join("art")).unwrap();
    std::fs::canonicalize(dir).unwrap()
}

/// Serves the kit the files under `root` through an in-process host's `storage.*`.
fn serve<D: KitDocument + Send + 'static>(kit: &mut Headless<D>, root: &Path) -> HostFolder {
    let folder = HostFolder::new(root).unwrap();
    kit.set_host(folder.host());
    folder
}

fn open<D: KitDocument + Send + 'static>(kit: &mut Headless<D>, folder: &HostFolder, path: &str) -> DocumentInfo {
    kit.open(OpenRequest { file: &folder.file(path).unwrap(), read_only: false, create: None }).unwrap()
}

#[test]
fn opens_edits_and_saves_documents_in_the_workspace() {
    let _turn = lent_turn();
    let root = workspace("edit");
    let file = root.join("art/a.grid");
    std::fs::write(&file, GridDocument::create("a.grid", 8, 4).unwrap().save(None).unwrap()).unwrap();
    let mut kit = Headless::<Grid>::new(kit());
    let folder = serve(&mut kit, &root);
    let info = open(&mut kit, &folder, "art/a.grid");
    assert_eq!((info.name.as_str(), info.title.as_str(), info.format.as_str(), info.dirty), ("a.grid", "a.grid", "grid", false));
    assert_eq!(open(&mut kit, &folder, "art/a.grid").id, info.id, "the same file is the same document");

    assert_eq!(kit.check(&info.id).unwrap(), json!({ "diagnostics": [] }));
    let listed: Vec<String> = kit.commands(Some(&info.id)).unwrap().into_iter().map(|command| command.id).collect();
    assert!(listed.contains(&"grid.set".to_owned()));
    assert!(!listed.contains(&"file.writeCopy".to_owned()), "commands that name files are not offered");
    let set = kit.commands(Some(&info.id)).unwrap().into_iter().find(|command| command.id == "grid.set").unwrap();
    assert_eq!(set.params["properties"]["x"]["type"], "integer", "{}", set.params);

    let executed =
        kit.execute(&info.id, "grid.set", Map::from_iter([("x".into(), json!(1)), ("y".into(), json!(1)), ("grey".into(), json!(0))]), Origin::Agent).unwrap();
    assert!(executed.changed);
    assert!(kit.document(&info.id).unwrap().dirty);
    assert_eq!(kit.check(&info.id).unwrap()["diagnostics"][0]["code"], "grid.unsaved");
    assert_eq!(kit.check("no-such-document").unwrap_err().code, ErrorReason::DocumentNotFound.code());
    let refused = kit.execute(&info.id, "file.writeCopy", Map::from_iter([("path".into(), json!("/tmp/x"))]), Origin::Agent).unwrap_err();
    assert_eq!(refused.code, ErrorReason::CommandDisabled.code());

    let (saved, written) = kit.save(&info.id, None, None).unwrap();
    assert!(!saved.dirty);
    assert_eq!(written.name, "a.grid");
    let stat = folder.files().serve("storage.stat", json!({ "handle": folder.file("art/a.grid").unwrap() })).unwrap();
    assert_eq!(json!(written.version), stat["version"], "the version the commit answered");
    let reopened = GridDocument::open("a.grid", &std::fs::read(&file).unwrap()).unwrap();
    assert_eq!(reopened.render(1.0, 1.0, 1.0, 1, 1).unwrap(), vec![0, 0, 0, 255]);

    let shot = kit.screenshot(&info.id, &within(4)).unwrap();
    assert_eq!((shot.width, shot.height), (4, 2));
    assert_eq!(&shot.png[1..4], b"PNG");
    assert!(kit.describe(&info.id).unwrap().state.contains_key("width"));
    let _ = std::fs::remove_dir_all(root);
}

// regressions/issue-screenshot-scale: `view.screenshot` honours `scale` (KHP A39) and `maxSize`.
#[test]
fn screenshots_draw_at_the_scale_the_engine_draws_and_within_max_size() {
    let _turn = lent_turn();
    let root = workspace("scale");
    let pixels: Vec<u8> = (0..32).map(|i| (i * 8) as u8).collect();
    let mut bytes = b"GRID 8 4\n".to_vec();
    bytes.extend(&pixels);
    std::fs::write(root.join("art/a.grid"), &bytes).unwrap();
    let at = |scale: f64, max_size: u32| ScreenshotRequest { scale, ..within(max_size) };
    let size = |shot: Screenshot| (shot.width, shot.height);

    let mut kit = Headless::<Grid>::new(kit());
    let folder = serve(&mut kit, &root);
    let id = open(&mut kit, &folder, "art/a.grid").id;
    let double = kit.screenshot(&id, &at(2.0, 1024)).unwrap();
    let drawn = GridDocument::open("a.grid", &bytes).unwrap().render(0.0, 0.0, 2.0, 16, 8).unwrap();
    assert_eq!(double.png, encode_png(&drawn, 16, 8).unwrap(), "the engine's own drawing at scale 2");
    assert_eq!(size(kit.screenshot(&id, &at(1.0, 1024)).unwrap()), (8, 4), "scale 1, not the largest maxSize allows");
    assert_eq!(size(kit.screenshot(&id, &at(2.0, 12)).unwrap()), (12, 6), "maxSize bounds the longer side");
    assert_eq!(size(kit.screenshot(&id, &at(0.5, 1024)).unwrap()), (4, 2));
    let target = ScreenshotRequest { target: Some(Map::from_iter([("objectId".to_owned(), json!("obj_1"))])), ..within(1024) };
    let refused = kit.screenshot(&id, &target).unwrap_err();
    assert_eq!(refused.reason(), Some(ErrorReason::InvalidParams), "a target this screenshot cannot draw is refused, not ignored");

    // An engine that draws real pixels up to scale 1 (the SDK's default) is never asked to enlarge.
    let mut plain = Headless::<GridDocument>::new(self::kit());
    let folder = serve(&mut plain, &root);
    let id = open(&mut plain, &folder, "art/a.grid").id;
    let enlarged = plain.screenshot(&id, &at(2.0, 1024)).unwrap_err();
    assert_eq!(enlarged.reason(), Some(ErrorReason::InvalidParams));
    assert!(enlarged.data.as_ref().and_then(|data| data["detail"].as_str()).unwrap_or_default().contains("scale 1 at most"), "{enlarged:?}");
    assert_eq!(size(plain.screenshot(&id, &at(2.0, 8)).unwrap()), (8, 4), "maxSize brings scale 2 down to 1");
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn file_parameters_come_from_the_schema() {
    let _turn = lent_turn();
    let root = workspace("file-params");
    let file = root.join("a.grid");
    std::fs::write(&file, GridDocument::create("a.grid", 2, 2).unwrap().save(None).unwrap()).unwrap();
    let mut kit = Headless::<Grid>::new(kit());
    let folder = serve(&mut kit, &root);
    let info = open(&mut kit, &folder, "a.grid");
    let listed = kit.commands(Some(&info.id)).unwrap();
    let import = listed.iter().find(|command| command.id == "grid.importRows").expect("a `target` that is not a file is offered");
    assert_eq!(import.params["required"], json!(["target"]));
    assert!(!listed.iter().any(|command| command.id == "grid.exportPicture"), "a `file` parameter keeps the command off the list");

    let target = json!({ "row": 1 });
    let executed =
        kit.execute(&info.id, "grid.importRows", Map::from_iter([("target".into(), target.clone()), ("rows".into(), json!([]))]), Origin::Agent).unwrap();
    assert_eq!(executed.result, Some(json!({ "imported": target })));
    let refused = kit.execute(&info.id, "grid.exportPicture", Map::from_iter([("picture".into(), json!("out.png"))]), Origin::Agent).unwrap_err();
    assert_eq!(refused.code, ErrorReason::CommandDisabled.code());
    // grid-kit's own `grid.import` takes a granted file by type: off the list and refused.
    assert!(!listed.iter().any(|command| command.id == "grid.import"), "a granted-file parameter keeps it off the list");
    let refused = kit.execute(&info.id, "grid.import", Map::from_iter([("file".into(), json!("in.grey"))]), Origin::Agent).unwrap_err();
    assert_eq!(refused.code, ErrorReason::CommandDisabled.code());
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn lists_output_schemas_as_json_schema() {
    let _turn = lent_turn();
    let mut kit = Headless::<Grid>::new(kit());
    let listed = kit.commands(None).unwrap();
    let import = listed.iter().find(|command| command.id == "grid.importRows").unwrap();
    assert_eq!(
        import.output,
        Some(json!({ "type": "object", "additionalProperties": false, "properties": { "imported": {} }, "required": ["imported"] })),
        "the kit's ValueSchemaSpec as the JSON Schema an MCP `outputSchema` carries"
    );
    let set = listed.iter().find(|command| command.id == "grid.set").unwrap();
    assert_eq!(set.output, None, "a command without an output schema lists none");
}

#[test]
fn file_parameters_become_khp_file_strings() {
    let spec = json!({
        "picture": { "type": "file", "access": "create", "accept": ["png"], "required": true, "description": "The image to write." },
        "pages": { "type": "array", "items": { "type": "file", "access": "read", "accept": ["pdf"] } },
    });
    let schema = json_schema(Some(&spec), None);
    assert_eq!(
        schema["properties"]["picture"],
        json!({ "type": "string", "x-khp-file": { "access": "create", "accept": ["png"] }, "description": "The image to write." })
    );
    assert_eq!(schema["properties"]["pages"]["items"], json!({ "type": "string", "x-khp-file": { "access": "read", "accept": ["pdf"] } }));
    assert_eq!(schema["required"], json!(["picture"]));
}

#[test]
fn follows_a_file_another_editor_replaced() {
    let _turn = lent_turn();
    let root = workspace("follow");
    let file = root.join("a.grid");
    std::fs::write(&file, GridDocument::create("a.grid", 2, 2).unwrap().save(None).unwrap()).unwrap();
    let mut kit = Headless::<Grid>::new(kit());
    let folder = serve(&mut kit, &root);
    let info = open(&mut kit, &folder, "a.grid");
    std::fs::write(&file, GridDocument::create("a.grid", 6, 6).unwrap().save(None).unwrap()).unwrap();
    let reloaded = kit.did_change_on_disk(&info.id).unwrap();
    assert!(!reloaded.dirty);
    assert_eq!(kit.screenshot(&info.id, &within(64)).unwrap().width, 6);
    // Opening the file again after another editor replaced it reads it again.
    std::thread::sleep(std::time::Duration::from_millis(5));
    std::fs::write(&file, GridDocument::create("a.grid", 9, 9).unwrap().save(None).unwrap()).unwrap();
    let reopened = open(&mut kit, &folder, "a.grid");
    assert_ne!(reopened.id, info.id, "a file replaced under a clean document is read again");
    assert_eq!(kit.screenshot(&reopened.id, &within(64)).unwrap().width, 9);
    assert_eq!(kit.documents().len(), 1);
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn a_terminal_close_removes_the_headless_session() {
    let _turn = lent_turn();
    let root = workspace("terminal-close");
    let mut kit = Headless::<Grid>::new(kit());
    let folder = serve(&mut kit, &root);
    let options = Map::from_iter([("width".into(), json!(3)), ("height".into(), json!(5))]);
    let opened = kit.open(OpenRequest { file: &folder.file("close.grid").unwrap(), read_only: false, create: Some(("grid", Some(&options))) }).unwrap();
    let result = kit.execute(&opened.id, "grid.close", Map::new(), Origin::Agent).unwrap();
    assert_eq!(result.result, Some(json!({"closed":true})));
    assert!(!result.changed);
    assert!(kit.documents().is_empty());
    assert!(!root.join("close.grid").exists());
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn creates_new_documents_and_opens_only_handles_the_host_granted() {
    let _turn = lent_turn();
    let root = workspace("create");
    let mut kit = Headless::<Grid>::new(kit());
    let folder = serve(&mut kit, &root);
    let options = Map::from_iter([("width".into(), json!(3)), ("height".into(), json!(5))]);
    let created = kit.open(OpenRequest { file: &folder.file("new.grid").unwrap(), read_only: false, create: Some(("grid", Some(&options))) }).unwrap();
    assert!(created.dirty, "unsaved until saved");
    assert!(!root.join("new.grid").exists(), "a new document's file appears when it is saved");
    kit.save(&created.id, None, None).unwrap();
    assert!(root.join("new.grid").exists());
    // Saved again, it replaces the file it made.
    kit.execute(&created.id, "grid.set", Map::from_iter([("x".into(), json!(0)), ("y".into(), json!(0)), ("grey".into(), json!(9))]), Origin::User).unwrap();
    kit.save(&created.id, None, None).unwrap();
    let leftovers: Vec<String> =
        std::fs::read_dir(&root).unwrap().filter_map(|entry| entry.ok()?.file_name().into_string().ok()).filter(|name| name.starts_with('.')).collect();
    assert!(leftovers.is_empty(), "no staging file is left: {leftovers:?}");

    // The host grants nothing outside the workspace, and the kit opens no handle it was not given.
    assert!(folder.file("../outside.grid").is_err());
    let refused = kit.open(OpenRequest { file: "fh_00000000000000000000000000000000", read_only: false, create: None }).unwrap_err();
    assert_eq!(refused.code, ErrorReason::FileNotGranted.code());
    let wrong = kit.open(OpenRequest { file: &folder.file("notes.txt").unwrap(), read_only: false, create: None }).unwrap_err();
    assert_eq!(wrong.code, ErrorReason::UnsupportedFormat.code());
    assert!(kit.save(&created.id, Some(&folder.file("copy.png").unwrap()), None).is_err(), "saves only its edit formats");
    let _ = std::fs::remove_dir_all(root);
}

/// Kit Process Protocol 5, `KitFiles 1.1` FA9, H4: a save commits with the version the kit read, so a
/// file someone changed meanwhile is a `file_conflict` and stays theirs; a read-only document's
/// handle cannot write at all.
#[test]
fn a_save_never_replaces_a_file_changed_since_it_was_read() {
    let _turn = lent_turn();
    let root = workspace("conflict");
    let file = root.join("a.grid");
    std::fs::write(&file, GridDocument::create("a.grid", 2, 2).unwrap().save(None).unwrap()).unwrap();
    let mut kit = Headless::<Grid>::new(kit());
    let folder = serve(&mut kit, &root);
    let info = open(&mut kit, &folder, "a.grid");
    kit.execute(&info.id, "grid.set", Map::from_iter([("x".into(), json!(1)), ("y".into(), json!(1)), ("grey".into(), json!(0))]), Origin::User).unwrap();
    std::thread::sleep(std::time::Duration::from_millis(5));
    std::fs::write(&file, b"GRID 1 1\n\x07").unwrap();
    let conflict = kit.save(&info.id, None, None).unwrap_err();
    assert_eq!(conflict.code, ErrorReason::FileConflict.code(), "{conflict:?}");
    assert_eq!(std::fs::read(&file).unwrap(), b"GRID 1 1\n\x07", "the other change is kept");
    assert!(kit.document(&info.id).unwrap().dirty, "the edit is still unsaved");

    let read_only = kit.open(OpenRequest { file: &folder.read_only("a.grid").unwrap(), read_only: true, create: None }).unwrap();
    assert!(read_only.read_only);
    let _ = std::fs::remove_dir_all(root);
}

/// A document with unsaved edits whose file changed is in conflict, which its state
/// says (once, on `file.didChangeOnDisk`, or when a save fails `file_conflict`), until it is
/// read again (`file.reload`) or saved; its edits are never dropped silently.
#[test]
fn a_dirty_document_whose_file_changed_is_in_conflict_until_reloaded() {
    let _turn = lent_turn();
    let root = workspace("disk-conflict");
    let file = root.join("a.grid");
    std::fs::write(&file, GridDocument::create("a.grid", 2, 2).unwrap().save(None).unwrap()).unwrap();
    let mut kit = Headless::<Grid>::new(kit());
    let folder = serve(&mut kit, &root);
    let info = open(&mut kit, &folder, "a.grid");
    let set = || Map::from_iter([("x".into(), json!(0)), ("y".into(), json!(0)), ("grey".into(), json!(9))]);
    kit.execute(&info.id, "grid.set", set(), Origin::User).unwrap();
    // Nothing changed on disk yet: no conflict.
    assert_eq!(kit.did_change_on_disk(&info.id), None);
    std::thread::sleep(std::time::Duration::from_millis(5));
    std::fs::write(&file, GridDocument::create("a.grid", 5, 5).unwrap().save(None).unwrap()).unwrap();
    let state = kit.did_change_on_disk(&info.id).expect("the state the host is sent");
    assert!(state.conflict && state.dirty, "{state:?}");
    assert_eq!(kit.screenshot(&info.id, &within(64)).unwrap().width, 2, "the edits are kept");
    assert_eq!(kit.did_change_on_disk(&info.id), None, "reported once");
    assert_eq!(kit.save(&info.id, None, None).unwrap_err().code, ErrorReason::FileConflict.code());
    let reloaded = kit.reload(&info.id).unwrap();
    assert!(!reloaded.conflict && !reloaded.dirty, "{reloaded:?}");
    assert_eq!(kit.screenshot(&info.id, &within(64)).unwrap().width, 5, "the file's content");

    // A save that finds the file changed puts the document in conflict too.
    kit.execute(&info.id, "grid.set", set(), Origin::User).unwrap();
    std::thread::sleep(std::time::Duration::from_millis(5));
    std::fs::write(&file, GridDocument::create("a.grid", 3, 3).unwrap().save(None).unwrap()).unwrap();
    assert_eq!(kit.save(&info.id, None, None).unwrap_err().code, ErrorReason::FileConflict.code());
    assert!(kit.document(&info.id).unwrap().conflict);
    let elsewhere = folder.file("copy.grid").unwrap();
    let (saved, _) = kit.save(&info.id, Some(&elsewhere), None).unwrap();
    assert!(!saved.conflict, "saved elsewhere, the document lives in its new file");
    let _ = std::fs::remove_dir_all(root);
}

/// E5 through the host: the files a document names are resolved beside it by the host
/// (`storage.resolve`) and read by handle, never outside the workspace.
#[test]
fn lent_files_are_resolved_and_read_through_the_host() {
    let _turn = lent_turn();
    let root = workspace("lent");
    std::fs::create_dir_all(root.join("media")).unwrap();
    std::fs::write(root.join("media/clip.bin"), b"CLIP0123456789").unwrap();
    std::fs::write(root.join("art/a.grid"), GridDocument::create("a.grid", 2, 2).unwrap().save(None).unwrap()).unwrap();
    let mut kit = Headless::<Grid>::new(kit());
    let folder = serve(&mut kit, &root);
    let info = open(&mut kit, &folder, "art/a.grid");
    let measure =
        |kit: &mut Headless<Grid>, media: &str| kit.execute(&info.id, "grid.measureLent", Map::from_iter([("media".into(), json!(media))]), Origin::Agent);
    assert_eq!(measure(&mut kit, "../media/clip.bin").unwrap().result, Some(json!({ "size": 14, "head": "CLIP" })));
    assert_eq!(measure(&mut kit, "/media/clip.bin").unwrap().result, Some(json!({ "size": 14, "head": "CLIP" })));
    for outside in ["../../etc/passwd", "../.kition/secret"] {
        let refused = measure(&mut kit, outside).unwrap_err();
        assert!(format!("{refused:?}").contains("not available"), "{outside}: {refused:?}");
    }
    // regressions/issue-file-not-found: a missing file the kit may see is not found, not refused.
    let missing = measure(&mut kit, "missing.bin").unwrap_err();
    assert!(format!("{missing:?}").contains("no such file"), "{missing:?}");
    let _ = std::fs::remove_dir_all(root);
}

/// regressions/issue-file-not-found: an engine's link check asks `kition_kit::host::exists`, which
/// answers `false` only when the host says the file is not found (`file_not_found`, after every
/// check of H3 and LR2), and the host's refusal otherwise, the same whether the file exists or not.
#[test]
fn an_engine_tells_a_missing_lent_file_from_a_refused_one() {
    let _turn = lent_turn();
    let root = workspace("lent-exists");
    std::fs::create_dir_all(root.join("media")).unwrap();
    std::fs::create_dir_all(root.join(".kition")).unwrap();
    std::fs::write(root.join("media/clip.bin"), b"CLIP").unwrap();
    std::fs::write(root.join(".kition/secret"), b"SECRET").unwrap();
    std::fs::write(root.join("art/a.grid"), GridDocument::create("a.grid", 2, 2).unwrap().save(None).unwrap()).unwrap();
    let mut kit = Headless::<Grid>::new(kit());
    let folder = serve(&mut kit, &root);
    let info = open(&mut kit, &folder, "art/a.grid");
    let exists = |kit: &mut Headless<Grid>, media: &str| {
        kit.execute(&info.id, "grid.lentExists", Map::from_iter([("media".into(), json!(media))]), Origin::Agent).map(|done| done.result)
    };
    assert_eq!(exists(&mut kit, "../media/clip.bin").unwrap(), Some(json!({ "exists": true })));
    assert_eq!(exists(&mut kit, "../media/missing.bin").unwrap(), Some(json!({ "exists": false })));
    assert_eq!(exists(&mut kit, "gone/missing.bin").unwrap(), Some(json!({ "exists": false })));
    for (existing, missing) in [("../.kition/secret", "../.kition/nothing"), ("../../etc/passwd", "../../etc/nothing")] {
        let (existing, missing) = (format!("{:?}", exists(&mut kit, existing).unwrap_err()), format!("{:?}", exists(&mut kit, missing).unwrap_err()));
        assert!(existing.contains("not available"), "{existing}");
        // The message names the path the engine asked for, and nothing else differs.
        assert_eq!(existing.replace("secret", "nothing").replace("passwd", "nothing"), missing, "refused alike");
    }
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn reads_the_kit_from_its_manifest() {
    let kit = kit();
    assert_eq!((kit.id.as_str(), kit.native()), ("example.grid", Some("grid")));
    let read_first =
        r#"{"id":"kit.x","version":"1.0.0","formats":[{"id":"svg","extensions":["svg"],"role":"view"},{"id":"x","extensions":["x"],"role":"edit"}]}"#;
    assert_eq!(KitInfo::from_manifest(read_first, &[], &[]).unwrap().native(), Some("x"), "the edit format is native");
    assert!(KitInfo::from_manifest(r#"{"id":"kit.x","version":"1","formats":[]}"#, &[], &[]).is_err());
}

/// The editor state `kit.json` publishes to hosts (`engine.editorState`, platform K23) is the
/// engine's own list: a kit whose two lists differ does not start, so they cannot drift apart. A
/// manifest without the field leaves the engine's list as the only one.
#[test]
fn the_manifest_editor_state_is_the_engines() {
    let manifest = |declared: Option<Value>| {
        let mut manifest: Value = serde_json::from_str(include_str!("../../../examples/grid-kit/kit.json")).unwrap();
        match declared {
            Some(declared) => manifest["engine"]["editorState"] = declared,
            None => _ = manifest["engine"].as_object_mut().unwrap().remove("editorState"),
        }
        manifest.to_string()
    };
    let volatile = ["/selection", "playhead"];
    let kit = KitInfo::from_manifest(&manifest(Some(json!(volatile))), &[], &volatile).unwrap();
    assert_eq!(kit.volatile, volatile);
    assert!(KitInfo::from_manifest(&manifest(None), &[], &volatile).is_ok(), "a manifest without the field");
    for declared in [json!([]), json!(["/selection"]), json!(["playhead", "/selection"]), json!(["/selection", "playhead", "/view"])] {
        let error = KitInfo::from_manifest(&manifest(Some(declared.clone())), &[], &volatile).unwrap_err();
        assert!(error.contains("engine.editorState") && error.contains("platform K23"), "{declared}: {error}");
    }
    let error = KitInfo::from_manifest(&manifest(Some(json!(["/view"]))), &[], &[]).unwrap_err();
    assert!(error.contains("[\"/view\"]"), "{error}");
}

#[test]
fn turns_harness_schemas_into_json_schema() {
    let spec = json!({
        "anything": { "type": "json", "description": "free" },
        "point": { "type": "object", "additionalProperties": true, "properties": { "x": { "type": "number", "required": true } } },
        "ids": { "type": "array", "items": { "type": "json" } },
        "name": { "type": "string", "required": true },
    });
    let schema = json_schema(Some(&spec), Some("{name, anything?}"));
    assert_eq!(schema["properties"]["anything"], json!({ "description": "free" }));
    assert_eq!(schema["properties"]["point"]["required"], json!(["x"]));
    assert_eq!(schema["properties"]["ids"]["items"], json!({}));
    assert_eq!(schema["required"], json!(["name"]));
    assert_eq!(schema["description"], "{name, anything?}");
}

#[test]
fn recognises_file_parameters_in_the_kit_notation() {
    assert!(touches_files(Some("{path}"), None));
    assert!(touches_files(Some("{paths: [string] (files or folders), sequence?: bool}"), None));
    assert!(touches_files(Some("{name, path?|base64?, frame?}"), None));
    assert!(touches_files(Some(r#"{"output":string}"#), None));
    assert!(!touches_files(Some("{x: u32, y: u32, pathfinder?: bool, filePattern?: string}"), None));
    assert!(!touches_files(None, Some(&Map::from_iter([("x".into(), json!(1))]))));
    assert!(touches_files(None, Some(&Map::from_iter([("Path".into(), json!("a"))]))));
    assert!(is_protocol_id("grid.set") && !is_protocol_id("Grid.set") && !is_protocol_id("grid..set"));
}

/// The object-model toy kit of `kition-kit`'s tests: a board of notes on a `KitSession`.
mod notes {
    #![allow(dead_code)]
    include!("../../kition-kit/tests/model.rs");
}

fn notes_kit() -> KitInfo {
    KitInfo {
        id: "kit.notes".into(),
        version: "0.1.0".into(),
        formats: vec![("notes".into(), vec!["notes".into()])],
        saves: vec!["notes".into()],
        exports: Vec::new(),
        sandboxed: Vec::new(),
        volatile: Vec::new(),
        capabilities: Vec::new(),
        agent_include: None,
        agent_exclude: Vec::new(),
    }
}

#[test]
fn serves_the_object_model_through_the_exchange_and_on_the_session() {
    let _turn = lent_turn();
    let root = workspace("model");
    let file = root.join("ideas.notes");
    std::fs::write(&file, b"").unwrap();
    for mut kit in [Headless::<notes::NotesDocument>::with_replica_port(notes_kit()), Headless::<notes::NotesDocument>::with_session_model(notes_kit())] {
        let folder = serve(&mut kit, &root);
        let info = open(&mut kit, &folder, "ideas.notes");
        let mut request = notes::add_notes();
        request["documentId"] = json!(info.id);
        let answer = kit.model("model.batch", request).unwrap();
        assert_eq!(answer["loaded"][1]["fields"], json!({ "body": "second", "done": true }));
        assert_eq!(kit.describe(&info.id).unwrap().state["notes"], json!(["second"]));
        let described = kit.model("model.describe", json!({ "documentId": info.id })).unwrap();
        assert_eq!(described["commands"][0]["id"], "note.clear");
        let error =
            kit.model("model.batch", json!({ "documentId": info.id, "ops": [{ "op": "set", "target": "root", "field": "title", "value": 3 }] })).unwrap_err();
        assert_eq!(error.data.unwrap()["model"]["code"], "invalid-value");
        kit.close(&info.id, true).unwrap();
        let read_only = kit.open(OpenRequest { file: &folder.read_only("ideas.notes").unwrap(), read_only: true, create: None }).unwrap();
        let refused = kit
            .model("model.batch", json!({ "documentId": read_only.id, "ops": [{ "op": "set", "target": "root", "field": "title", "value": "B" }] }))
            .unwrap_err();
        assert_eq!(refused.code, ErrorReason::CommandDisabled.code());
    }
    let mut plain = Headless::<Grid>::new(self::kit());
    assert_eq!(plain.model("model.describe", json!({ "documentId": "1" })).unwrap_err().code, RpcError::METHOD_NOT_FOUND);
    // `kit.initialize` lists the object model's features only for a kit that serves it.
    let features = |kit: &mut dyn KitBackend| {
        let serves = kit.serves_model();
        kition_kit_server::with_model_features(kit.capabilities(), serves)["features"].clone()
    };
    assert_eq!(features(&mut plain), json!(["view.describe", "file.check"]));
    assert_eq!(
        features(&mut Headless::<notes::NotesDocument>::with_replica_port(notes_kit())),
        json!(["view.describe", "file.check", "model.open", "model.import", "model.export", "model.save", "model.describe", "model.batch"])
    );
    assert_eq!(
        features(&mut Headless::<notes::NotesDocument>::with_session_model(notes_kit())),
        json!(["view.describe", "file.check", "model.describe", "model.batch"])
    );
    let _ = std::fs::remove_dir_all(root);
}

/// `model.version` and `model.changes`: any kit with an object model answers its
/// document's version and what changed since one, generically, from the replica the object model
/// reads (the exchange's scratch replica or the session's); after a reload that replaced the
/// document, `changes` is null and says why; a kit without an object model has neither method.
#[test]
fn answers_the_version_and_the_changes_since_one_for_any_kit_with_an_object_model() {
    let _turn = lent_turn();
    let root = workspace("changes");
    std::fs::write(root.join("ideas.notes"), b"").unwrap();
    for mut kit in [Headless::<notes::NotesDocument>::with_replica_port(notes_kit()), Headless::<notes::NotesDocument>::with_session_model(notes_kit())] {
        let folder = serve(&mut kit, &root);
        let info = open(&mut kit, &folder, "ideas.notes");
        let id = json!(info.id);
        let mut request = notes::add_notes();
        request["documentId"] = id.clone();
        kit.model("model.batch", request).unwrap();
        let version = kit.model("model.version", json!({ "documentId": id })).unwrap()["version"].clone();
        assert!(version.as_str().is_some_and(|text| !text.is_empty()), "{version}");
        let unchanged = kit.model("model.changes", json!({ "documentId": id, "since": version })).unwrap();
        assert_eq!(unchanged["changes"], json!({ "created": [], "changed": [], "moved": [], "deleted": [] }));
        assert_eq!(unchanged["version"], version, "no change, the same version");
        let rename = json!({ "documentId": id, "origin": { "kind": "agent", "principal": "agent:test" }, "ops": [{ "op": "set", "target": "root", "field": "title", "value": "Plans" }] });
        kit.model("model.batch", rename).unwrap();
        let answer = kit.model("model.changes", json!({ "documentId": id, "since": version })).unwrap();
        let changed = &answer["changes"]["changed"];
        assert_eq!(changed.as_array().map(Vec::len), Some(1), "{answer}");
        assert_eq!(changed[0]["edits"], json!([{ "field": "title", "before": "Ideas", "after": "Plans" }]), "{answer}");
        assert!(answer["changes"].get("texts").is_none(), "a receipt has no texts");
        assert_ne!(answer["version"], version);
        let bad = kit.model("model.changes", json!({ "documentId": id, "since": "%%" })).unwrap_err();
        assert_eq!(bad.code, RpcError::INVALID_PARAMS);
        kit.reload(&info.id).unwrap();
        let lost = kit.model("model.changes", json!({ "documentId": id, "since": answer["version"] })).unwrap();
        assert!(lost["changes"].is_null() && lost["unavailable"].as_str().is_some_and(|why| why.contains("history")), "{lost}");
        kit.close(&info.id, true).unwrap();
    }
    let mut plain = Headless::<Grid>::new(self::kit());
    for method in ["model.version", "model.changes"] {
        assert_eq!(plain.model(method, json!({ "documentId": "1" })).unwrap_err().code, RpcError::METHOD_NOT_FOUND);
    }
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn opens_a_replica_without_a_file_and_imports_exports_and_saves_it() {
    let _turn = lent_turn();
    use kition_kit::kdm::{Origin, Version};
    use kition_kit::session::KitSessionDocument as _;

    let mut kit = Headless::<notes::NotesDocument>::with_replica_port(notes_kit());
    assert_eq!(kit.capabilities()["features"], json!(["view.describe", "file.check", "model.open", "model.import", "model.export", "model.save"]));
    // The room's document, as a collaborator holds it.
    let mut peer = <notes::NotesDocument as KitDocument>::create("ideas.notes", 1, 1).unwrap();
    let snapshot = peer.session().snapshot().unwrap();
    let opened = kit.model("model.open", json!({ "name": "ideas.notes", "snapshot": base64::encode(&snapshot) })).unwrap();
    let id = opened["documentId"].as_str().unwrap().to_owned();
    assert_eq!(opened["format"], "notes");
    assert!(kit.model("model.open", json!({ "name": "../ideas.notes", "snapshot": "" })).is_err());
    assert_eq!(kit.model("model.open", json!({ "name": "ideas.txt", "snapshot": "" })).unwrap_err().code, ErrorReason::UnsupportedFormat.code());

    let write = |peer: &mut notes::NotesDocument, title: &'static str| {
        let before = peer.session().version();
        peer.session_mut()
            .execute(&Origin::person("user:a"), |_, tx| {
                let board = tx.objects_of_type("Board").into_iter().next().ok_or("no board")?;
                tx.set(&board, "title", json!(title))?;
                Ok(())
            })
            .unwrap();
        base64::encode(&peer.session().export_changes(&before).unwrap())
    };
    let change = write(&mut peer, "hello");
    kit.model("model.import", json!({ "documentId": id, "changes": change })).unwrap();
    let read = kit.model("model.batch", json!({ "documentId": id, "load": [{ "target": "root", "fields": ["title"] }] })).unwrap();
    assert_eq!(read["loaded"][0]["fields"]["title"], "hello");

    // A batch, then every change the document has: a collaborator takes them as they are.
    let mut request = notes::add_notes();
    request["documentId"] = json!(id);
    kit.model("model.batch", request).unwrap();
    let exported = kit.model("model.export", json!({ "documentId": id })).unwrap();
    let changes = base64::decode(exported["changes"].as_str().unwrap()).unwrap();
    peer.session_mut().import_changes(&changes).unwrap();
    assert_eq!(KitDocument::inspect(&peer).unwrap()["notes"], json!(["second"]));
    let since = base64::encode(&peer.session().version().encode());
    let nothing = kit.model("model.export", json!({ "documentId": id, "since": since })).unwrap();
    assert!(Version::decode(&base64::decode(&since).unwrap()).is_ok());
    assert!(nothing["changes"].is_string());

    let saved = kit.model("model.save", json!({ "documentId": id })).unwrap();
    assert_eq!(saved["name"], "ideas.notes");
    assert_eq!(base64::decode(saved["data"].as_str().unwrap()).unwrap(), b"second");
    assert_eq!(kit.model("model.save", json!({ "documentId": id, "format": "pdf" })).unwrap_err().code, ErrorReason::UnsupportedFormat.code());

    // What validate cannot repair is refused, and the document is closed.
    let refused = write(&mut peer, notes::UNREPAIRABLE);
    let error = kit.model("model.import", json!({ "documentId": id, "changes": refused })).unwrap_err();
    assert_eq!(error.data.unwrap()["refused"], true);
    assert_eq!(kit.describe(&id).unwrap_err().code, ErrorReason::DocumentNotFound.code());

    // A kit on its own session model has no replica constructor.
    let mut session = Headless::<notes::NotesDocument>::with_session_model(notes_kit());
    assert_eq!(session.capabilities()["features"], json!(["view.describe", "file.check"]));
    assert!(session.model("model.open", json!({ "name": "ideas.notes", "snapshot": base64::encode(&snapshot) })).is_err());
}

/// regressions/issue-kdm-shallow-export: a kit on the change exchange (`with_replica_port`) serves
/// a document forked as a new document, as a file
/// `file.fork` wrote or a room started from such a file holds it: `model.batch` and
/// `model.describe` read it, and an agent's draft (`model.export`, then `model.open`) opens, edits
/// and merges back with `model.import`.
#[test]
fn a_replica_port_kit_serves_a_forked_document_and_its_drafts() {
    let _turn = lent_turn();
    use kition_kit::kdm::{ActorId, DocId};

    let mut kit = Headless::<notes::NotesDocument>::with_replica_port(notes_kit());
    let source = <notes::NotesDocument as KitDocument>::create("ideas.notes", 1, 1).unwrap();
    let fork = source.session().replica().copy_as_new_document(DocId::new(), ActorId::random()).unwrap();
    let opened = kit.model("model.open", json!({ "name": "ideas.notes", "snapshot": base64::encode(&fork.snapshot().unwrap()) })).unwrap();
    let id = opened["documentId"].as_str().unwrap().to_owned();
    let described = kit.model("model.describe", json!({ "documentId": id })).unwrap();
    assert!(described["rootId"].is_string(), "{described}");
    let mut request = notes::add_notes();
    request["documentId"] = json!(id);
    let answer = kit.model("model.batch", request).unwrap();
    assert_eq!(answer["loaded"][1]["fields"], json!({ "body": "second", "done": true }));

    // The draft: every change of the fork, opened as a document of its own.
    let exported = kit.model("model.export", json!({ "documentId": id })).unwrap();
    let draft = kit.model("model.open", json!({ "name": "ideas.notes", "snapshot": exported["changes"] })).unwrap();
    let draft = draft["documentId"].as_str().unwrap().to_owned();
    let base = kit.model("model.version", json!({ "documentId": draft })).unwrap()["version"].clone();
    let rename = json!({ "documentId": draft, "ops": [{ "op": "set", "target": "root", "field": "title", "value": "Drafted" }] });
    kit.model("model.batch", rename).unwrap();
    let changes = kit.model("model.export", json!({ "documentId": draft, "since": base })).unwrap();
    kit.model("model.import", json!({ "documentId": id, "changes": changes["changes"] })).unwrap();
    let read = kit.model("model.batch", json!({ "documentId": id, "load": [{ "target": "root", "fields": ["title", "notes"] }] })).unwrap();
    assert_eq!(read["loaded"][0]["fields"]["title"], "Drafted");
    assert_eq!(read["loaded"][0]["fields"]["notes"].as_array().map(Vec::len), Some(1), "{read}");
}

#[test]
fn base64_round_trips() {
    for bytes in [&b""[..], b"f", b"fo", b"foo", b"\x00\xff\x10binary"] {
        assert_eq!(base64::decode(&base64::encode(bytes)).unwrap(), bytes);
    }
    assert_eq!(base64::encode(b"fo"), "Zm8=");
    assert!(base64::decode("not*base64").is_none());
}

/// KHP A11 and KitModel M12a: a call on the agent's connection is the agent's edit, so the
/// person's undo does not take it back; the same call from the person is the person's step.
#[test]
fn an_agents_call_is_recorded_as_the_agents_and_the_persons_undo_leaves_it() {
    let _turn = lent_turn();
    let root = workspace("origin");
    let file = root.join("ideas.notes");
    let notes = json!({ "origin": { "kind": "agent", "principal": "agent:test" }, "ops": [
        { "op": "create", "type": "Note", "in": "root.notes", "ref": "$a" },
        { "op": "text.set", "target": "$a", "field": "body", "text": "first" },
    ] });
    for (name, make) in [
        ("replica port", Headless::<notes::NotesDocument>::with_replica_port as fn(KitInfo) -> Headless<notes::NotesDocument>),
        ("session model", Headless::<notes::NotesDocument>::with_session_model),
    ] {
        for (origin, person_can_undo) in [(Origin::Agent, false), (Origin::User, true)] {
            std::fs::write(&file, b"").unwrap();
            let mut kit = make(notes_kit());
            let folder = serve(&mut kit, &root);
            let info = open(&mut kit, &folder, "ideas.notes");
            let mut request = notes.clone();
            request["documentId"] = json!(info.id);
            kit.model("model.batch", request).unwrap();
            assert!(!kit.document(&info.id).unwrap().can_undo, "{name}: the agent's notes are not the person's to undo");
            let executed = kit.execute(&info.id, "note.clear", Map::new(), origin).unwrap();
            assert_eq!(executed.result, Some(json!({ "removed": 1 })), "{name}");
            assert_eq!(kit.document(&info.id).unwrap().can_undo, person_can_undo, "{name}: note.clear as {origin:?}");
            kit.close(&info.id, true).unwrap();
        }
    }
    let _ = std::fs::remove_dir_all(root);
}

/// A host's change (origin `system`, Kit Process Protocol section 6) is no undo step in any history,
/// recorded under its label; a kit with no origin-aware engine refuses it rather than make it
/// undoable.
#[test]
fn a_hosts_change_joins_no_undo_history() {
    let _turn = lent_turn();
    use kition_kit::session::KitSessionDocument as _;

    let root = workspace("system-origin");
    let file = root.join("ideas.notes");
    let add = json!({ "origin": { "kind": "agent", "principal": "agent:test" }, "ops": [
        { "op": "create", "type": "Note", "in": "root.notes", "ref": "$a" },
        { "op": "text.set", "target": "$a", "field": "body", "text": "first" },
        { "op": "create", "type": "Note", "in": "root.notes", "ref": "$b" },
        { "op": "text.set", "target": "$b", "field": "body", "text": "second" },
    ], "load": [{ "target": "$a", "fields": ["body"] }] });
    for (name, make) in [
        ("replica port", Headless::<notes::NotesDocument>::with_replica_port as fn(KitInfo) -> Headless<notes::NotesDocument>),
        ("session model", Headless::<notes::NotesDocument>::with_session_model),
    ] {
        std::fs::write(&file, b"").unwrap();
        let mut kit = make(notes_kit());
        let folder = serve(&mut kit, &root);
        let info = open(&mut kit, &folder, "ideas.notes");
        let mut request = add.clone();
        request["documentId"] = json!(info.id);
        let first = kit.model("model.batch", request).unwrap()["loaded"][0]["id"].clone();
        // The person removes "second" (their step); the host then removes "first" (no step).
        kit.execute(&info.id, "note.clear", Map::from_iter([("except".into(), first)]), Origin::User).unwrap();
        let executed = kit.execute_system(&info.id, "note.clear", Map::new(), "emailsync").unwrap();
        assert_eq!(executed.result, Some(json!({ "removed": 1 })), "{name}");
        assert_eq!(kit.describe(&info.id).unwrap().state["notes"], json!([]), "{name}");
        // The person's undo takes back their own step: "second" returns. Were the host's change
        // their step, "first" would.
        let index = kit.position(&info.id).unwrap();
        assert!(kit.docs[index].doc.session_mut().undo_in(kition_kit::kdm::UndoScope::Person).unwrap().0, "{name}");
        assert_eq!(kit.describe(&info.id).unwrap().state["notes"], json!(["second"]), "{name}: the host's change stays");
        kit.close(&info.id, true).unwrap();
    }

    let mut plain = Headless::<Grid>::new(self::kit());
    let folder = serve(&mut plain, &root);
    std::fs::write(root.join("a.grid"), GridDocument::create("a.grid", 2, 2).unwrap().save(None).unwrap()).unwrap();
    let id = open(&mut plain, &folder, "a.grid").id;
    let set = Map::from_iter([("x".into(), json!(0)), ("y".into(), json!(0)), ("grey".into(), json!(9))]);
    let refused = plain.execute_system(&id, "grid.set", set, "emailsync").unwrap_err();
    assert_eq!(refused.code, ErrorReason::CommandDisabled.code(), "a kit with no origin-aware engine keeps no change out of undo");
    assert!(!plain.document(&id).unwrap().dirty, "and changes nothing");
    let _ = std::fs::remove_dir_all(root);
}

/// `file.export` writes the manifest's export formats as new files and leaves the document as
/// it is (KHP A41); it never replaces a file, and a format the manifest does not export fails.
#[test]
fn exports_new_files_in_the_manifest_formats() {
    let _turn = lent_turn();
    let mut manifest: serde_json::Value = serde_json::from_str(include_str!("../../../examples/grid-kit/kit.json")).unwrap();
    manifest["exports"] = json!([{ "extension": "txt", "mime": "text/plain" }]);
    let root = workspace("export");
    let file = root.join("art/a.grid");
    std::fs::write(&file, GridDocument::create("a.grid", 8, 4).unwrap().save(None).unwrap()).unwrap();
    let mut kit = Headless::<Grid>::new(KitInfo::from_manifest(&manifest.to_string(), &[], &[]).unwrap());
    let folder = serve(&mut kit, &root);
    let info = open(&mut kit, &folder, "art/a.grid");

    let target = root.join("art/a.txt");
    let handle = folder.export("art/a.txt").unwrap();
    let written = kit.export(&info.id, &handle, "txt", None).unwrap();
    assert_eq!(written.name, "a.txt");
    assert_eq!(std::fs::read_to_string(&target).unwrap(), "grid 8 x 4");
    assert!(!kit.document(&info.id).unwrap().dirty, "exporting leaves the document as it is");

    // A create handle commits once; the host mints none on an existing file (H5).
    let again = kit.export(&info.id, &handle, "", None).unwrap_err();
    assert_eq!(again.code, ErrorReason::FileAlreadyCommitted.code(), "{again:?}");
    assert!(folder.export("art/a.txt").is_err());
    assert_eq!(std::fs::read_to_string(&target).unwrap(), "grid 8 x 4", "the file is not replaced");

    let unknown = kit.export(&info.id, &folder.export("art/a.png").unwrap(), "png", None).unwrap_err();
    assert!(format!("{unknown:?}").contains("exports txt"), "{unknown:?}");
    assert!(!root.join("art/a.png").exists());

    assert_eq!(kit.capabilities()["formats"]["export"], json!(["txt"]), "the manifest's exports the engine writes");
    // A manifest export the engine does not write is neither reported nor written.
    let mut declared: serde_json::Value = serde_json::from_str(include_str!("../../../examples/grid-kit/kit.json")).unwrap();
    declared["exports"] = json!([{ "extension": "txt" }, { "extension": "pdf" }]);
    let mut overclaims = Headless::<Grid>::new(KitInfo::from_manifest(&declared.to_string(), &[], &[]).unwrap());
    let folder = serve(&mut overclaims, &root);
    assert_eq!(overclaims.capabilities()["formats"]["export"], json!(["txt"]));
    let id = open(&mut overclaims, &folder, "art/a.grid").id;
    assert!(overclaims.export(&id, &folder.export("art/a.pdf").unwrap(), "pdf", None).is_err());

    let mut plain = Headless::<Grid>::new(self::kit());
    let folder = serve(&mut plain, &root);
    let id = open(&mut plain, &folder, "art/a.grid").id;
    let none = plain.export(&id, &folder.export("art/b.txt").unwrap(), "txt", None).unwrap_err();
    assert!(format!("{none:?}").contains("exports nothing"), "{none:?}");
}

/// `model.import` takes the media its changes need (`blobs`) through the kit's
/// [`ReplicaPort::model_add_blobs`] before the changes, and `model.export` answers them beside the
/// changes; a kit whose changes carry no blobs answers none and refuses blobs it is given, before
/// importing anything.
#[test]
fn replica_methods_carry_blobs_only_for_kits_that_have_them() {
    let _turn = lent_turn();
    use kition_kit::session::KitSessionDocument as _;

    let mut kit = Headless::<notes::NotesDocument>::with_replica_port(notes_kit());
    let peer = <notes::NotesDocument as KitDocument>::create("ideas.notes", 1, 1).unwrap();
    let snapshot = peer.session().snapshot().unwrap();
    let opened = kit.model("model.open", json!({ "name": "ideas.notes", "snapshot": base64::encode(&snapshot) })).unwrap();
    let id = opened["documentId"].as_str().unwrap().to_owned();
    let exported = kit.model("model.export", json!({ "documentId": id })).unwrap();
    assert!(exported.get("blobs").is_none(), "no blobs for a kit without them: {exported}");
    let refused = kit.model("model.import", json!({ "documentId": id, "changes": exported["changes"], "blobs": base64::encode(b"not blobs") })).unwrap_err();
    assert_eq!(refused.code, RpcError::INVALID_PARAMS);
    assert!(kit.document(&id).is_ok(), "refused blobs leave the document open");
    kit.model("model.import", json!({ "documentId": id, "changes": exported["changes"] })).unwrap();
}

/// KHP A5, A18, A48: a command that opts in publishes the parameters its notation leaves
/// without a default as `required`, and a call that leaves one out is refused by the gate, before
/// the engine runs (this engine would have answered), as `invalid-params` naming each one and
/// where a value comes from.
#[test]
fn an_opted_in_command_publishes_its_required_parameters_and_the_gate_refuses_a_missing_one() {
    let _turn = lent_turn();
    let root = workspace("required");
    std::fs::write(root.join("a.grid"), GridDocument::create("a.grid", 2, 2).unwrap().save(None).unwrap()).unwrap();
    let mut kit = Headless::<Grid>::new(kit());
    let folder = serve(&mut kit, &root);
    let info = open(&mut kit, &folder, "a.grid");
    let label = kit.commands(Some(&info.id)).unwrap().into_iter().find(|command| command.id == "grid.label").unwrap();
    assert_eq!(label.params["required"], json!(["column", "label", "row"]), "{}", label.params);
    assert!(label.params["properties"]["bold"].get("default").is_some(), "a defaulted parameter is not required");

    let params = |value: Value| value.as_object().cloned().unwrap();
    let refused = kit.execute(&info.id, "grid.label", params(json!({ "row": 1, "bold": true })), Origin::Agent).unwrap_err();
    assert_eq!(refused.code, ErrorReason::InvalidParams.code());
    let data = refused.data.unwrap();
    let paths: Vec<&str> = data["errors"].as_array().unwrap().iter().filter_map(|error| error["path"].as_str()).collect();
    assert_eq!(paths, ["/column", "/label"], "{data}");
    let detail = data["detail"].as_str().unwrap();
    assert!(detail.starts_with("`column` is required: expected a whole number") && detail.contains("no default"), "{detail}");
    let ran = kit.execute(&info.id, "grid.label", params(json!({ "row": 1, "column": 0, "label": "Total" })), Origin::Agent).unwrap();
    assert_eq!(ran.result, Some(json!({ "row": 1, "column": 0, "label": "Total" })), "the required ones alone run");
}

/// KHP A5, A18: a call whose parameters break the command's schema is refused before the engine
/// runs, saying what was expected; an unknown id suggests the closest ones; valid calls run.
#[test]
fn checks_parameters_and_suggests_close_command_ids() {
    let _turn = lent_turn();
    let root = workspace("params");
    let file = root.join("a.grid");
    std::fs::write(&file, GridDocument::create("a.grid", 2, 2).unwrap().save(None).unwrap()).unwrap();
    let mut kit = Headless::<Grid>::new(kit());
    let folder = serve(&mut kit, &root);
    let info = open(&mut kit, &folder, "a.grid");
    for origin in [Origin::Agent, Origin::User] {
        let refused = kit.execute(&info.id, "grid.importRows", Map::from_iter([("rows".into(), json!([]))]), origin).unwrap_err();
        assert_eq!(refused.code, ErrorReason::InvalidParams.code(), "{origin:?}");
        let detail = refused.data.as_ref().and_then(|data| data["detail"].as_str()).unwrap_or_default().to_owned();
        assert!(detail.starts_with("`target` is required: expected an object"), "{detail}");
        let wrong = kit
            .execute(&info.id, "grid.importRows", Map::from_iter([("target".into(), json!({ "row": "1" })), ("rows".into(), json!([]))]), origin)
            .unwrap_err();
        assert!(wrong.data.unwrap()["detail"].as_str().unwrap().contains("`target.row`: expected a whole number"));
    }
    let target = json!({ "row": 1 });
    let ran = kit.execute(&info.id, "grid.importRows", Map::from_iter([("target".into(), target.clone()), ("rows".into(), json!([]))]), Origin::Agent).unwrap();
    assert_eq!(ran.result, Some(json!({ "imported": target })), "a valid call is untouched");
    let unknown = kit.execute(&info.id, "grid.improtRows", Map::new(), Origin::Agent).unwrap_err();
    assert_eq!(unknown.code, ErrorReason::CommandNotFound.code());
    let detail = unknown.data.unwrap()["detail"].as_str().unwrap().to_owned();
    assert!(detail.contains("did you mean `grid.importRows`"), "{detail}");
    let _ = std::fs::remove_dir_all(root);
}

/// A top-level key the command's published schema does not name is refused before the kit sees
/// it, for every kit, with the `invalid_params` refusal and words of
/// `kition_kit::schema::refuse_unknown` (the key, the parameter it resembles, the ones the command
/// takes), so a kit that also calls it answers the same. A command that says its top level is open
/// (`open_params`) takes any key; nested objects follow their schema's `additionalProperties`.
/// Before, the top level was left to each kit, and a kit that forgot ran the command without the
/// misspelt parameter.
#[test]
fn an_unknown_top_level_key_is_refused_for_every_kit() {
    let _turn = lent_turn();
    let root = workspace("unknown-keys");
    std::fs::write(root.join("a.grid"), GridDocument::create("a.grid", 2, 2).unwrap().save(None).unwrap()).unwrap();
    let mut kit = Headless::<Grid>::new(kit());
    let folder = serve(&mut kit, &root);
    let info = open(&mut kit, &folder, "a.grid");
    let schema = Grid::create("x.grid", 1, 1).unwrap().commands().into_iter().find(|command| command.id == "grid.importRows").unwrap().schema.unwrap();
    let detail = |error: RpcError| {
        assert_eq!(error.code, ErrorReason::InvalidParams.code(), "{error:?}");
        error.data.as_ref().and_then(|data| data["detail"].as_str()).unwrap_or_default().to_owned()
    };
    for origin in [Origin::Agent, Origin::User] {
        let params = Map::from_iter([("target".into(), json!({ "row": 1 })), ("rows".into(), json!([])), ("rowz".into(), json!(1))]);
        let expected = kition_kit::schema::refuse_unknown("grid.importRows", &schema, &Value::Object(params.clone())).unwrap_err();
        let refused = detail(kit.execute(&info.id, "grid.importRows", params, origin).unwrap_err());
        assert_eq!(refused, expected, "{origin:?}: the words of refuse_unknown");
        assert!(refused.contains("`rowz`") && refused.contains("did you mean `rows`"), "{refused}");
    }
    // A misspelt required key is named, not reported as the missing one.
    let misspelt = Map::from_iter([("tagret".into(), json!({ "row": 1 })), ("rows".into(), json!([]))]);
    let refused = detail(kit.execute(&info.id, "grid.importRows", misspelt, Origin::Agent).unwrap_err());
    assert!(refused.contains("no parameter `tagret`; did you mean `target`?"), "{refused}");
    // A nested object that is closed refuses its unknown keys.
    let nested = Map::from_iter([("target".into(), json!({ "row": 1, "column": 2 })), ("rows".into(), json!([]))]);
    let refused = detail(kit.execute(&info.id, "grid.importRows", nested, Origin::Agent).unwrap_err());
    assert!(refused.contains("`target.column` is not a field of `target`"), "{refused}");

    // An open command takes any top-level key, and an open nested object any key.
    let options =
        Map::from_iter([("mode".into(), json!("dark")), ("gridLines".into(), json!(false)), ("style".into(), json!({ "color": "red", "weight": 2 }))]);
    let ran = kit.execute(&info.id, "grid.setOptions", options.clone(), Origin::Agent).unwrap();
    assert_eq!(ran.result, Some(Value::Object(options)));
    // Its listing says the top level is open; a closed one's says nothing it does not take.
    let listed = kit.commands(Some(&info.id)).unwrap();
    let open = listed.iter().find(|command| command.id == "grid.setOptions").unwrap();
    assert_eq!(open.params["additionalProperties"], true, "{}", open.params);
    let closed = listed.iter().find(|command| command.id == "grid.importRows").unwrap();
    assert_eq!(closed.params["additionalProperties"], false, "{}", closed.params);
    let _ = std::fs::remove_dir_all(root);
}

/// `invalid_params` lists every wrong parameter in `data.errors`, `{ path, message,
/// expected }` each, `path` a JSON Pointer into the params, and repeats the first in `detail`.
#[test]
fn invalid_params_lists_every_wrong_parameter_in_data_errors() {
    let _turn = lent_turn();
    let root = workspace("param-errors");
    std::fs::write(root.join("a.grid"), GridDocument::create("a.grid", 2, 2).unwrap().save(None).unwrap()).unwrap();
    let mut kit = Headless::<Grid>::new(kit());
    let folder = serve(&mut kit, &root);
    let info = open(&mut kit, &folder, "a.grid");
    let wrong = Map::from_iter([("target".into(), json!({ "row": "one" })), ("rows".into(), json!([]))]);
    let refused = kit.execute(&info.id, "grid.importRows", wrong, Origin::Agent).unwrap_err();
    assert_eq!(refused.code, ErrorReason::InvalidParams.code());
    let data = refused.data.unwrap();
    let errors = data["errors"].as_array().unwrap();
    assert_eq!(errors.len(), 1, "{data}");
    assert_eq!(errors[0]["path"], "/target/row");
    assert_eq!(errors[0]["expected"], "a whole number");
    assert_eq!(data["detail"], errors[0]["message"]);
    let missing = kit.execute(&info.id, "grid.importRows", Map::new(), Origin::Agent).unwrap_err().data.unwrap();
    assert_eq!(missing["errors"][0]["path"], "/target");
    // A refusal by the engine itself, for what the schema cannot state.
    let past = Map::from_iter([("target".into(), json!({ "row": 99 })), ("rows".into(), json!([]))]);
    let refused = kit.execute(&info.id, "grid.importRows", past, Origin::Agent).unwrap_err();
    assert_eq!(refused.code, ErrorReason::InvalidParams.code());
    let data = refused.data.unwrap();
    assert_eq!(data["detail"], "`target.row` 99 is past the last row");
    assert_eq!(data["errors"], json!([{ "path": "/target/row", "message": "`target.row` 99 is past the last row", "expected": "a row of the grid" }]));
    let _ = std::fs::remove_dir_all(root);
}

/// An unknown id whose words are all in a command's keywords names that command first.
#[test]
fn an_unknown_command_suggests_the_command_its_words_are_keywords_of() {
    let command = |id: &str, title: &str, keywords: &[&str]| KitCommand {
        id: id.into(),
        title: title.into(),
        keywords: keywords.iter().map(|k| (*k).to_owned()).collect(),
        ..Default::default()
    };
    let commands = [
        command("layer.select", "Select Layers", &[]),
        command("keyframe.delete", "Delete Keyframes", &[]),
        command("layer.add", "New Layer", &[]),
        command("edit.delete", "Clear", &["delete layers", "remove layers"]),
    ];
    let offered: Vec<&KitCommand> = commands.iter().collect();
    let detail = unknown_command("layer.delete", &offered);
    assert!(detail.starts_with("no command `layer.delete`; did you mean `edit.delete`, "), "{detail}");
    let detail = unknown_command("layer.remove", &offered);
    assert!(detail.contains("`edit.delete`"), "{detail}");
    let detail = unknown_command("layer.selct", &offered);
    assert!(detail.contains("did you mean `layer.select`"), "a keyword match needs every word: {detail}");
    assert!(!detail.contains("edit.delete"), "{detail}");
}

/// KHP A12: a replica opened with `model.open` under a file's own name is not that file. Opening
/// the file gives its own document, the replica reports no path, and saving the replica without a
/// target is refused, so a draft can never be read or written as the file (regression: cases
/// sheet.agent.draft/east-update and note.agent.draft/new-task).
#[test]
fn a_replica_under_a_files_name_never_stands_in_for_the_file() {
    let _turn = lent_turn();
    use kition_kit::session::KitSessionDocument as _;

    let root = workspace("replica-name");
    let file = root.join("ideas.notes");
    let on_disk = <notes::NotesDocument as KitDocument>::create("ideas.notes", 1, 1).unwrap().save(None).unwrap();
    std::fs::write(&file, &on_disk).unwrap();
    let mut kit = Headless::<notes::NotesDocument>::with_replica_port(notes_kit());
    let folder = serve(&mut kit, &root);

    let draft = <notes::NotesDocument as KitDocument>::create("ideas.notes", 1, 1).unwrap();
    let snapshot = draft.session().snapshot().unwrap();
    let opened = kit.model("model.open", json!({ "name": "ideas.notes", "snapshot": base64::encode(&snapshot) })).unwrap();
    let replica = opened["documentId"].as_str().unwrap().to_owned();
    let mut request = notes::add_notes();
    request["documentId"] = json!(replica);
    kit.model("model.batch", request).unwrap();

    let replica_info = kit.document(&replica).unwrap();
    assert!(replica_info.dirty, "a replica is no file's saved state");
    let live = open(&mut kit, &folder, "ideas.notes");
    assert_ne!(live.id, replica, "opening the file gives the file, not the replica under its name");
    assert!(!live.dirty);
    assert_eq!(open(&mut kit, &folder, "ideas.notes").id, live.id, "the file's handle finds the file's document, never the replica");

    let refused = kit.save(&replica, None, None).unwrap_err();
    assert_eq!(refused.code, ErrorReason::IoError.code());
    assert_eq!(std::fs::read(&file).unwrap(), on_disk, "the file is as it was");
    // Saved to a target, the replica becomes that file.
    let (saved, written) = kit.save(&replica, Some(&folder.file("copy.notes").unwrap()), None).unwrap();
    assert_eq!((saved.name.as_str(), written.name.as_str()), ("copy.notes", "copy.notes"));
    assert!(root.join("copy.notes").is_file());
    assert_eq!(std::fs::read(&file).unwrap(), on_disk);
    let _ = std::fs::remove_dir_all(root);
}

/// The agent reads the kit's own description of a command, never its parameter notation.
#[test]
fn lists_the_kits_own_command_descriptions() {
    let _turn = lent_turn();
    let mut kit = Headless::<Grid>::new(kit());
    let listed = kit.commands(None).unwrap();
    let set = listed.iter().find(|command| command.id == "grid.set").unwrap();
    assert_eq!(set.description.as_deref(), Some("Sets one pixel's grey level (0 black, 255 white) at a column and row counted from 0."));
    assert!(listed.iter().all(|command| !command.description.as_deref().unwrap_or_default().starts_with("Params:")), "no notation as a description");
    let undescribed = listed.iter().find(|command| command.id == "grid.importRows").unwrap();
    assert_eq!(undescribed.description, None, "a command the kit did not describe lists none, not made-up text");
}

/// cases/sdk.host.document-text: a kit whose manifest lists `document-text` answers
/// `file.text` from [`KitDocument::text`] and says so in `kit.initialize`; any other kit has no
/// such method.
#[test]
fn serves_document_text_only_for_a_kit_with_the_capability() {
    let _turn = lent_turn();
    let root = workspace("text");
    let file = root.join("a.grid");
    std::fs::write(&file, GridDocument::create("a.grid", 8, 4).unwrap().save(None).unwrap()).unwrap();
    let mut manifest: Value = serde_json::from_str(include_str!("../../../examples/grid-kit/kit.json")).unwrap();
    manifest["headless"]["capabilities"] = json!(["document-text"]);
    let mut kit = Headless::<Grid>::new(KitInfo::from_manifest(&manifest.to_string(), &[], &[]).unwrap());
    assert_eq!(kit.capabilities()["capabilities"], json!(["document-text"]));
    let folder = serve(&mut kit, &root);
    let info = open(&mut kit, &folder, "a.grid");
    let revision = kit.document(&info.id).unwrap();
    assert_eq!(
        kit.text(&info.id, kition_kit_server::protocol::DOCUMENT_TEXT_LIMIT).unwrap(),
        json!({ "text": "8 by 4\na grid", "truncated": false, "parts": [{ "label": "Size", "start": 0, "end": 6 }, { "label": "Note", "start": 7, "end": 13 }] })
    );
    assert_eq!(kit.text(&info.id, 3).unwrap(), json!({ "text": "8 b", "truncated": true, "parts": [{ "label": "Size", "start": 0, "end": 3 }] }));
    assert_eq!(kit.document(&info.id).unwrap().dirty, revision.dirty);
    assert_eq!(kit.text("no-such-document", 10).unwrap_err().code, ErrorReason::DocumentNotFound.code());

    let mut plain = Headless::<Grid>::new(self::kit());
    assert!(plain.capabilities().get("capabilities").is_none());
    let folder = serve(&mut plain, &root);
    let info = open(&mut plain, &folder, "a.grid");
    assert_eq!(plain.text(&info.id, 10).unwrap_err().code, RpcError::METHOD_NOT_FOUND);
    let _ = std::fs::remove_dir_all(root);
}

/// A deck of two slides with a current slide and a selection, behind the editor-state hooks;
/// `sneaky` makes setting the context an edit, as a kit must not.
struct Deck {
    current: u64,
    selection: Vec<Value>,
    revision: u64,
    sneaky: bool,
    missing_selection: bool,
    mode: Option<String>,
}

impl KitDocument for Deck {
    fn open(_: &str, bytes: &[u8]) -> Result<Self, String> {
        Ok(Self { current: 0, selection: Vec::new(), revision: 0, sneaky: false, missing_selection: bytes == b"deleted selection", mode: None })
    }
    fn create(name: &str, _: u32, _: u32) -> Result<Self, String> {
        Self::open(name, &[])
    }
    fn width(&self) -> u32 {
        4
    }
    fn height(&self) -> u32 {
        4
    }
    fn revision(&self) -> u64 {
        self.revision
    }
    fn dirty(&self) -> bool {
        self.revision > 0
    }
    fn render(&self, _: f64, _: f64, _: f64, width: u32, height: u32) -> Result<Vec<u8>, String> {
        Ok(vec![255; (width * height * 4) as usize])
    }
    fn render_area(&self, _: i32, _: i32, _: i32, _: i32, width: u32, height: u32) -> Result<Vec<u8>, String> {
        Ok(vec![255; (width * height * 4) as usize])
    }
    fn execute(&mut self, command: &str, _: Value) -> Result<Value, String> {
        if command == "shape.text" {
            self.revision += 1;
            let mut result = json!({"written":self.selection,"slide":self.current});
            if let Some(mode) = &self.mode {
                result["mode"] = json!(mode);
            }
            return Ok(result);
        }
        if command == "deck.sneak" {
            self.sneaky = true;
            return Ok(Value::Null);
        }
        Err(format!("unknown command {command}"))
    }
    fn inspect(&self) -> Result<Value, String> {
        Ok(json!({ "canUndo": false, "canRedo": false }))
    }
    fn commands(&self) -> Vec<KitCommand> {
        vec![
            KitCommand {
                id: "shape.text".into(),
                title: "Set text".into(),
                schema: Some(json!({ "id": { "type": "string", "required": true }, "text": { "type": "string" } })),
                mutates: true,
                enabled: true,
                targets: Some("id"),
                index: Some("#"),
                reads: &[kition_kit::EditorState::Part],
                ..Default::default()
            },
            KitCommand {
                id: "format.mark".into(),
                title: "Mark".into(),
                schema: Some(json!({})),
                mutates: true,
                enabled: true,
                reads: &[kition_kit::EditorState::Selection, kition_kit::EditorState::Part],
                ..Default::default()
            },
            KitCommand { id: "deck.sneak".into(), title: "Sneak".into(), schema: Some(json!({})), enabled: true, ..Default::default() },
            KitCommand {
                id: "shape.raise".into(),
                title: "Raise a shape counted from the top".into(),
                schema: Some(json!({ "id": { "type": "string", "required": true } })),
                mutates: true,
                enabled: true,
                targets: Some("id"),
                index: Some("#"),
                index_reversed: true,
                ..Default::default()
            },
            KitCommand {
                id: "shape.fill".into(),
                title: "Fill the shape in a slot".into(),
                schema: Some(json!({ "slot": { "type": "integer" }, "color": { "type": "string" }, "like": { "type": "integer" } })),
                mutates: true,
                enabled: true,
                reads: &[kition_kit::EditorState::Part],
                places: &["slot"],
                objects: &["like"],
                position_independent: true,
                ..Default::default()
            },
        ]
    }
    fn under(&self, command: &str, params: &Value) -> Result<Option<kition_kit::Under>, String> {
        // A command that acts on the selection: what it needs of each selected shape.
        if command == "shape.outline" {
            let premises = self.selection.iter().map(|id| kition_kit::Premise::on(id.clone()).fields(["outline"])).collect();
            return Ok(Some(kition_kit::Under { premises, ..Default::default() }));
        }
        if command != "shape.fill" {
            return Ok(None);
        }
        let slot = params["slot"].as_u64().ok_or("`slot` is a number")?;
        Ok(Some(kition_kit::Under {
            objects: vec![json!(format!("s{}-{slot}", self.current + 1))],
            within: vec![kition_kit::Within {
                parent: json!(format!("slide:{}", self.current + 1)),
                field: "shapes".into(),
                from: slot as usize,
                to: slot as usize + 1,
                ..Default::default()
            }],
            ..Default::default()
        }))
    }
    /// A slot's place as it was: covered when the object's `slot` at `basis` was the
    /// slot asked, on the current slide.
    fn covered(&self, command: &str, params: &Value, objects: &[kition_kit::CoveredAsk]) -> Result<Option<kition_kit::CoveredAt>, String> {
        if command != "shape.fill" {
            return Ok(None);
        }
        let slot = params["slot"].as_u64().ok_or("`slot` is a number")?;
        let covered: Vec<kition_kit::Covered> = objects
            .iter()
            .map(|object| kition_kit::Covered {
                id: object.id.clone(),
                covered: (object.unknown.is_empty()).then(|| object.before.get("slot").and_then(Value::as_u64) == Some(slot) && self.current == 1),
                content: None,
                gone: false,
            })
            .collect();
        let under = covered.iter().filter(|object| object.covered == Some(true)).map(|object| object.id.clone()).collect();
        Ok(Some(kition_kit::CoveredAt { under, covered }))
    }
    fn derived(&self, ids: &[Value], _names: &[String]) -> Result<Vec<kition_kit::DerivedValues>, String> {
        Ok(ids
            .iter()
            .map(|id| kition_kit::DerivedValues { id: id.clone(), values: serde_json::Map::from_iter([("size".to_owned(), json!(id.to_string().len()))]) })
            .collect())
    }
    fn save(&self, _: Option<&str>) -> Result<Vec<u8>, String> {
        Ok(b"deck".to_vec())
    }
    fn mark_saved(&mut self) {}
    fn editor_state(&self) -> Value {
        let mut state = json!({ "slide": self.current, "selection": self.selection });
        if let Some(mode) = &self.mode {
            state["mode"] = json!(mode);
        }
        state
    }
    fn restore_editor_state(&mut self, saved: &Value) -> Result<(), String> {
        if self.missing_selection && !saved["selection"].as_array().is_none_or(Vec::is_empty) {
            return Err("deleted active target".into());
        }
        self.current = saved["slide"].as_u64().ok_or("not a saved state")?;
        self.selection = saved["selection"].as_array().cloned().unwrap_or_default();
        self.mode = saved["mode"].as_str().map(str::to_owned);
        Ok(())
    }
    fn set_context(&mut self, context: &kition_kit::CallContext) -> Result<(), String> {
        if let Some(part) = &context.part {
            self.current = part["slide"].as_u64().filter(|slide| (1..=2).contains(slide)).ok_or_else(|| format!("no slide {part}"))? - 1;
        }
        if !context.on.is_empty() {
            self.selection = context.on.clone();
        }
        if self.sneaky {
            self.revision += 1;
        }
        Ok(())
    }
}

fn deck_kit() -> KitInfo {
    let mut manifest: serde_json::Value = serde_json::from_str(include_str!("../../../examples/grid-kit/kit.json")).unwrap();
    manifest["formats"] = json!([{ "id": "deck", "extensions": ["deck"], "role": "edit" }]);
    KitInfo::from_manifest(&manifest.to_string(), &[], &[]).unwrap()
}

#[test]
fn outside_reread_keeps_active_target_and_mode_or_refuses_deleted_identity() {
    let _turn = lent_turn();
    for deleted in [false, true] {
        let root = workspace(if deleted { "reread-mode-deleted" } else { "reread-mode-resolved" });
        let path = root.join("a.deck");
        std::fs::write(&path, b"deck").unwrap();
        let mut kit = Headless::<Deck>::new(deck_kit());
        let folder = serve(&mut kit, &root);
        let id = open(&mut kit, &folder, "a.deck").id;
        let state = json!({"slide":1,"selection":["s2"],"mode":"mask"});
        kit.context_restore(&id, &state).unwrap();
        std::fs::write(&path, if deleted { b"deleted selection".as_slice() } else { b"unrelated outside edit".as_slice() }).unwrap();
        if deleted {
            let error = kit.reload(&id).unwrap_err();
            assert_eq!(error.reason(), Some(ErrorReason::FileConflict));
            assert!(error.data.unwrap()["detail"].as_str().unwrap().contains("deleted active target"));
        } else {
            kit.reload(&id).unwrap();
            let result = kit.execute(&id, "shape.text", Map::from_iter([("id".into(), json!("s2"))]), Origin::Agent).unwrap().result.unwrap();
            assert_eq!(result["written"], json!(["s2"]));
            assert_eq!(result["slide"], 1);
            assert_eq!(result["mode"], "mask");
        }
        assert_eq!(kit.context_get(&id).unwrap(), state);
        std::fs::remove_dir_all(root).unwrap();
    }
}

#[test]
fn reread_preserves_resolving_editor_state() {
    let _turn = lent_turn();
    let root = workspace("reread-context");
    std::fs::write(root.join("a.deck"), b"deck").unwrap();
    let mut kit = Headless::<Deck>::new(deck_kit());
    let folder = serve(&mut kit, &root);
    let id = open(&mut kit, &folder, "a.deck").id;
    let saved = json!({"slide":1,"selection":["s2"]});
    kit.context_restore(&id, &saved).unwrap();
    kit.reload(&id).unwrap();
    assert_eq!(kit.context_get(&id).unwrap(), saved);
    let written = kit.execute(&id, "shape.text", Map::from_iter([("id".into(), json!("s2"))]), Origin::Agent).unwrap();
    assert_eq!(written.result.unwrap()["written"], json!(["s2"]));
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn reread_refuses_deleted_active_target_and_keeps_previous_session() {
    let _turn = lent_turn();
    let root = workspace("reread-deleted-context");
    let path = root.join("a.deck");
    std::fs::write(&path, b"deck").unwrap();
    let mut kit = Headless::<Deck>::new(deck_kit());
    let folder = serve(&mut kit, &root);
    let id = open(&mut kit, &folder, "a.deck").id;
    let saved = json!({"slide":1,"selection":["s2"]});
    kit.context_restore(&id, &saved).unwrap();
    std::fs::write(&path, b"deleted selection").unwrap();
    let refused = kit.reload(&id).unwrap_err();
    assert_eq!(refused.reason(), Some(ErrorReason::FileConflict));
    assert!(refused.data.unwrap()["detail"].as_str().unwrap().contains("deleted active target"));
    assert_eq!(kit.context_get(&id).unwrap(), saved);
    assert_eq!(std::fs::read(&path).unwrap(), b"deleted selection");
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn reread_refuses_to_discard_unreconciled_agent_history() {
    let _turn = lent_turn();
    let root = workspace("reread-retained-history");
    std::fs::write(root.join("a.notes"), b"").unwrap();
    let mut kit = Headless::<notes::NotesDocument>::with_session_model(notes_kit());
    let folder = serve(&mut kit, &root);
    let id = open(&mut kit, &folder, "a.notes").id;
    kit.model(
        "model.batch",
        json!({"documentId":id,"origin":{"kind":"agent","principal":"agent"},"ops":[{"op":"set","target":"root","field":"title","value":"Mine"}]}),
    )
    .unwrap();
    std::fs::write(root.join("a.notes"), b"outside").unwrap();
    let refused = kit.reload(&id).unwrap_err();
    assert_eq!(refused.reason(), Some(ErrorReason::FileConflict));
    let described = kit.model("model.batch", json!({"documentId":id,"ops":[],"load":[{"target":"root"}]})).unwrap();
    assert_eq!(described["loaded"][0]["fields"]["title"], "Mine");
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn serves_the_editor_context_and_marks_what_commands_act_on() {
    let _turn = lent_turn();
    let root = workspace("context");
    std::fs::write(root.join("art/a.deck"), b"deck").unwrap();
    let mut kit = Headless::<Deck>::new(deck_kit());
    let folder = serve(&mut kit, &root);
    let id = open(&mut kit, &folder, "art/a.deck").id;

    let before = kit.context_get(&id).unwrap();
    assert_eq!(before, json!({ "slide": 0, "selection": [] }));
    let context = Map::from_iter([("part".to_owned(), json!({ "slide": 2 })), ("on".to_owned(), json!(["s2"]))]);
    kit.context_set(&id, &context).unwrap();
    assert_eq!(kit.context_get(&id).unwrap(), json!({ "slide": 1, "selection": ["s2"] }));
    let info = kit.document(&id).unwrap();
    assert!(!info.dirty && !info.can_undo, "setting the context is no edit");
    kit.context_restore(&id, &before).unwrap();
    assert_eq!(kit.context_get(&id).unwrap(), before);

    let refused = kit.context_set(&id, &Map::from_iter([("part".to_owned(), json!({ "slide": 9 }))])).unwrap_err();
    assert_eq!(refused.reason(), Some(ErrorReason::InvalidParams), "{}", refused.message);
    kit.execute(&id, "deck.sneak", Map::new(), Origin::Agent).unwrap();
    let broken = kit.context_set(&id, &context).unwrap_err();
    assert!(broken.message.contains("set_context changed the document"), "{}", broken.message);

    let commands = kit.commands(Some(&id)).unwrap();
    let text = commands.iter().find(|command| command.id == "shape.text").unwrap();
    assert_eq!(text.params["properties"]["id"]["x-khp-role"], "targets");
    assert_eq!(text.params["properties"]["id"]["x-khp-index"], "#", "the index spelling of the target");
    assert!(text.params["properties"]["id"].get("x-khp-index-order").is_none(), "counted in stored order");
    let raise = commands.iter().find(|command| command.id == "shape.raise").unwrap();
    assert_eq!(raise.params["properties"]["id"]["x-khp-index-order"], "reversed", "counted from the other end");
    assert_eq!(text.params["x-khp-reads"], json!(["part"]));
    let mark = commands.iter().find(|command| command.id == "format.mark").unwrap();
    assert_eq!(mark.params["x-khp-reads"], json!(["selection", "part"]));
    let sneak = commands.iter().find(|command| command.id == "deck.sneak").unwrap();
    assert!(sneak.params.get("x-khp-reads").is_none());
    assert!(sneak.params.get("x-khp-position").is_none());
    let fill = commands.iter().find(|command| command.id == "shape.fill").unwrap();
    assert_eq!(fill.params["properties"]["slot"]["x-khp-role"], "place");
    assert!(fill.params["properties"]["color"].get("x-khp-role").is_none());
    assert_eq!(fill.params["properties"]["like"]["x-khp-role"], "object", "a parameter naming objects by id");
    assert_eq!(fill.params["x-khp-position"], "independent");
}

/// `context.under`: the step's part is set for the question and put back after it, and
/// the kit's answer names the objects under the place and their window; a command the kit cannot
/// tell by place is refused.
#[test]
fn answers_what_a_place_names_without_moving_the_editor() {
    let _turn = lent_turn();
    let root = workspace("under");
    std::fs::write(root.join("art/a.deck"), b"deck").unwrap();
    let mut kit = Headless::<Deck>::new(deck_kit());
    let folder = serve(&mut kit, &root);
    let id = open(&mut kit, &folder, "art/a.deck").id;
    let before = kit.context_get(&id).unwrap();
    let asked =
        Map::from_iter([("command".to_owned(), json!("shape.fill")), ("params".to_owned(), json!({ "slot": 3 })), ("part".to_owned(), json!({ "slide": 2 }))]);
    let under = kit.context_under(&id, &asked).unwrap();
    assert_eq!(under, json!({ "objects": ["s2-3"], "within": [{ "parent": "slide:2", "field": "shapes", "from": 3, "to": 4 }] }));
    assert_eq!(kit.context_get(&id).unwrap(), before, "the editor is as it was");
    assert!(!kit.document(&id).unwrap().dirty, "no edit");
    // the step's `on` is the selection for the question, and put back after it.
    let selected = Map::from_iter([("command".to_owned(), json!("shape.outline")), ("on".to_owned(), json!(["s1-2"]))]);
    let under = kit.context_under(&id, &selected).unwrap();
    assert_eq!(under, json!({ "objects": [], "premises": [{ "id": "s1-2", "fields": ["outline"] }] }));
    assert_eq!(kit.context_get(&id).unwrap(), before, "the editor is as it was");
    let other = Map::from_iter([("command".to_owned(), json!("format.mark"))]);
    let refused = kit.context_under(&id, &other).unwrap_err();
    assert_eq!(refused.reason(), Some(ErrorReason::CommandDisabled), "{}", refused.message);
}

/// `context.covered` and `model.derived`: the step's part is set for the question and
/// put back; the kit answers each object asked about from its values at `basis` (`null` for one
/// whose values are unknown), and its derived values computed now; no edit.
#[test]
fn answers_what_a_place_covered_and_derived_values_without_an_edit() {
    let _turn = lent_turn();
    let root = workspace("covered");
    std::fs::write(root.join("art/a.deck"), b"deck").unwrap();
    let mut kit = Headless::<Deck>::new(deck_kit());
    let folder = serve(&mut kit, &root);
    let id = open(&mut kit, &folder, "art/a.deck").id;
    let before = kit.context_get(&id).unwrap();
    let asked = Map::from_iter([
        ("command".to_owned(), json!("shape.fill")),
        ("params".to_owned(), json!({ "slot": 3 })),
        ("part".to_owned(), json!({ "slide": 2 })),
        (
            "objects".to_owned(),
            json!([{ "id": "s2-3", "before": { "slot": 3 } }, { "id": "s2-4", "before": { "slot": 4 } }, { "id": "s2-5", "before": {}, "unknown": ["slot"] }]),
        ),
    ]);
    let covered = kit.context_covered(&id, &asked).unwrap();
    assert_eq!(
        covered,
        json!({ "under": ["s2-3"], "covered": [{ "id": "s2-3", "covered": true }, { "id": "s2-4", "covered": false }, { "id": "s2-5", "covered": null }] })
    );
    assert_eq!(kit.context_get(&id).unwrap(), before, "the editor is as it was");
    let derived = kit.model("model.derived", json!({ "documentId": id, "ids": ["s1"] })).unwrap();
    assert_eq!(derived, json!({ "objects": [{ "id": "s1", "values": { "size": 4 } }] }));
    assert!(!kit.document(&id).unwrap().dirty, "no edit");
    let other = Map::from_iter([("command".to_owned(), json!("format.mark")), ("objects".to_owned(), json!([]))]);
    assert_eq!(kit.context_covered(&id, &other).unwrap_err().reason(), Some(ErrorReason::CommandDisabled));
}

#[test]
fn a_kit_without_the_hooks_keeps_no_editor_state_and_refuses_to_set_one() {
    let _turn = lent_turn();
    let root = workspace("nocontext");
    let file = root.join("art/a.grid");
    std::fs::write(&file, GridDocument::create("a.grid", 8, 4).unwrap().save(None).unwrap()).unwrap();
    let mut kit = Headless::<Grid>::new(kit());
    let folder = serve(&mut kit, &root);
    let id = open(&mut kit, &folder, "art/a.grid").id;
    assert_eq!(kit.context_get(&id).unwrap(), Value::Null);
    kit.context_restore(&id, &Value::Null).unwrap();
    let refused = kit.context_set(&id, &Map::from_iter([("on".to_owned(), json!(["a"]))])).unwrap_err();
    assert_eq!(refused.reason(), Some(ErrorReason::CommandDisabled), "{}", refused.message);
    let detail = refused.data.as_ref().and_then(|data| data["detail"].as_str()).unwrap_or_default();
    assert!(detail.contains("`on`"), "{refused:?}");
}

/// A timeline whose `inspect()` has document fields named like editor state (a keyframe's `time`,
/// an animated property's `path`, a guide's `selection` mode) beside the editor's own state.
struct Track;

impl KitDocument for Track {
    fn open(_: &str, _: &[u8]) -> Result<Self, String> {
        Ok(Self)
    }
    fn create(_: &str, _: u32, _: u32) -> Result<Self, String> {
        Ok(Self)
    }
    fn width(&self) -> u32 {
        4
    }
    fn height(&self) -> u32 {
        4
    }
    fn revision(&self) -> u64 {
        0
    }
    fn dirty(&self) -> bool {
        false
    }
    fn render(&self, _: f64, _: f64, _: f64, width: u32, height: u32) -> Result<Vec<u8>, String> {
        Ok(vec![255; (width * height * 4) as usize])
    }
    fn render_area(&self, _: i32, _: i32, _: i32, _: i32, width: u32, height: u32) -> Result<Vec<u8>, String> {
        Ok(vec![255; (width * height * 4) as usize])
    }
    fn execute(&mut self, command: &str, _: Value) -> Result<Value, String> {
        Err(format!("unknown command {command}"))
    }
    fn inspect(&self) -> Result<Value, String> {
        Ok(json!({
            "canUndo": false,
            "canRedo": false,
            "dirty": false,
            "time": 2.5,
            "playhead": 2.5,
            "selection": ["layer:1"],
            "layers": [{
                "id": "layer:1",
                "animated": [{ "path": "transform/opacity", "keyframes": [{ "time": 0.5, "value": 0 }, { "time": 1.5, "value": 1 }] }],
                "guide": { "selection": "inside", "history": 3 },
                "selected": true
            }]
        }))
    }
    fn commands(&self) -> Vec<KitCommand> {
        Vec::new()
    }
    fn save(&self, _: Option<&str>) -> Result<Vec<u8>, String> {
        Ok(b"track".to_vec())
    }
    fn mark_saved(&mut self) {}
}

fn track_kit(volatile: &[&str]) -> KitInfo {
    let mut manifest: serde_json::Value = serde_json::from_str(include_str!("../../../examples/grid-kit/kit.json")).unwrap();
    manifest["formats"] = json!([{ "id": "track", "extensions": ["track"], "role": "edit" }]);
    manifest["engine"]["editorState"] = json!(volatile);
    KitInfo::from_manifest(&manifest.to_string(), &[], volatile).unwrap()
}

/// regressions/issue-session-keys-any-depth: what a kit's inspect details leave out is the session's
/// own bookkeeping at the top (`canUndo`, `dirty`, …) and what the kit declares as its editor
/// state, never a document field because of its name. Before, every key named `time`, `path`,
/// `selection`, `playhead`, `history`, … was removed at any depth, so keyframes lost their `time`
/// and animated properties their `path`.
#[test]
fn inspect_details_keep_document_fields_named_like_editor_state() {
    let _turn = lent_turn();
    let root = workspace("track");
    std::fs::write(root.join("art/a.track"), b"track").unwrap();
    let layer = json!({
        "id": "layer:1",
        "animated": [{ "path": "transform/opacity", "keyframes": [{ "time": 0.5, "value": 0 }, { "time": 1.5, "value": 1 }] }],
        "guide": { "selection": "inside", "history": 3 },
        "selected": true
    });

    // A kit that declares no editor state: every document field stays.
    let mut kit = Headless::<Track>::new(track_kit(&[]));
    let folder = serve(&mut kit, &root);
    let id = open(&mut kit, &folder, "art/a.track").id;
    let state = Value::Object(kit.describe(&id).unwrap().state);
    assert_eq!(state, json!({ "time": 2.5, "playhead": 2.5, "selection": ["layer:1"], "layers": [layer] }), "only the session's bookkeeping goes");

    // A kit that declares its editor state: that goes, wherever the kit uses it; the rest stays.
    // `/time` is the top level's `time` alone; `selected` is the kit's name for editor state wherever it is.
    let mut kit = Headless::<Track>::new(track_kit(&["/time", "playhead", "selection", "selected"]));
    let folder = serve(&mut kit, &root);
    let id = open(&mut kit, &folder, "art/a.track").id;
    let state = Value::Object(kit.describe(&id).unwrap().state);
    assert!(state.get("playhead").is_none() && state.get("selection").is_none() && state.get("time").is_none(), "{state}");
    assert_eq!(state["layers"][0]["animated"][0]["path"], "transform/opacity", "{state}");
    assert_eq!(state["layers"][0]["animated"][0]["keyframes"][1]["time"], 1.5, "a pointer names one member: {state}");
    assert!(state["layers"][0].get("selected").is_none(), "declared editor state goes at any depth: {state}");
    assert_eq!(state["layers"][0]["guide"]["history"], 3, "only the top level's history is the session's: {state}");
}

/// A kit says why a command did not run by a typed reason (`kition_kit::failure`), which decides
/// the error's code whatever its message says; only a message that carries none is read by its
/// wording (regressions/issue-headless-error-code).
#[test]
fn a_kits_typed_failure_decides_the_error_code_over_its_wording() {
    let _turn = lent_turn();
    let root = workspace("typed-failure");
    let file = root.join("a.grid");
    std::fs::write(&file, GridDocument::create("a.grid", 2, 2).unwrap().save(None).unwrap()).unwrap();
    let mut kit = Headless::<Grid>::new(kit());
    let folder = serve(&mut kit, &root);
    let info = open(&mut kit, &folder, "a.grid");
    let locked = kit.execute(&info.id, "grid.fail", Map::from_iter([("why".into(), json!("locked"))]), Origin::Agent).unwrap_err();
    assert_eq!(locked.code, ErrorReason::CommandDisabled.code(), "{locked:?}");
    let detail = locked.data.as_ref().and_then(|data| data["detail"].as_str()).unwrap_or_default().to_owned();
    assert_eq!(detail, "the label is locked (no such command can change it)", "the reason is not shown");
    let worded = kit.execute(&info.id, "grid.fail", Map::from_iter([("why".into(), json!("missing"))]), Origin::Agent).unwrap_err();
    assert_eq!(worded.code, ErrorReason::CommandNotFound.code(), "no reason: the wording decides: {worded:?}");
    let _ = std::fs::remove_dir_all(root);
}

/// a command's object parameters may be nested members (`rules[].target`), the target and
/// object parameters say which types they name (`x-khp-types`), and a target taking names says the
/// field holding them (`x-khp-name`).
#[test]
fn marks_nested_object_members_their_types_and_a_name_spelling() {
    let command = kition_kit::KitCommand {
        id: "particle.set".into(),
        title: "Set".into(),
        targets: Some("layer"),
        objects: &["rules[].target"],
        object_types: &[("layer", &["Layer"]), ("rules[].target", &["Node"])],
        name_field: Some("name"),
        schema: Some(json!({
            "layer": { "oneOf": [{ "type": "integer" }, { "type": "string" }] },
            "rules": { "type": "array", "items": { "type": "object", "properties": { "target": { "type": "integer" }, "weight": { "type": "number" } } } }
        })),
        ..Default::default()
    };
    let schema = params_schema(&command);
    let layer = &schema["properties"]["layer"];
    assert_eq!((layer["x-khp-types"].clone(), layer["x-khp-name"].clone()), (json!(["Layer"]), json!("name")), "{schema}");
    let target = &schema["properties"]["rules"]["items"]["properties"]["target"];
    assert_eq!((target["x-khp-role"].clone(), target["x-khp-types"].clone()), (json!("object"), json!(["Node"])), "{schema}");
}

#[test]
fn marks_name_parameters_with_their_fields_and_types() {
    let command = kition_kit::KitCommand {
        id: "node.material".into(),
        title: "Material".into(),
        targets: Some("node"),
        name_field: Some("name"),
        name_params: &[("material", "name"), ("rules[].source", "label")],
        object_types: &[("node", &["Node"]), ("material", &["Material"])],
        schema: Some(json!({ "node": { "type": "string" }, "material": { "type": "string" },
            "rules": { "type": "array", "items": { "type": "object", "properties": { "source": { "type": "string" } } } }
        })),
        ..Default::default()
    };
    let schema = params_schema(&command);
    assert_eq!(schema["properties"]["material"]["x-khp-name"], "name");
    assert_eq!(schema["properties"]["material"]["x-khp-types"], json!(["Material"]));
    assert_eq!(schema["properties"]["material"]["x-khp-role"], "object");
    assert_eq!(schema["properties"]["rules"]["items"]["properties"]["source"]["x-khp-name"], "label");
}

#[test]
fn batch_settling_is_in_the_transaction_for_exchange_and_session_models() {
    let _turn = lent_turn();
    let root = workspace("settled");
    std::fs::write(root.join("settled.notes"), b"").unwrap();
    for mut kit in [Headless::<notes::NotesDocument>::with_replica_port(notes_kit()), Headless::<notes::NotesDocument>::with_session_model(notes_kit())] {
        let folder = serve(&mut kit, &root);
        let info = open(&mut kit, &folder, "settled.notes");
        let before = kit.model("model.version", json!({ "documentId": info.id })).unwrap();
        let answer = kit
            .model(
                "model.batch",
                json!({ "documentId": info.id, "ops": [
            { "op": "create", "type": "Note", "id": "n", "in": "root.notes", "fields": { "opacity": 0.9 } }
        ], "load": [{ "target": "n", "fields": ["opacity"] }] }),
            )
            .unwrap();
        assert_eq!(answer["loaded"][0]["fields"]["opacity"], json!(230.0 / 255.0));
        let receipt = kit.model("model.changes", json!({ "documentId": info.id, "since": before["version"] })).unwrap();
        assert_eq!(receipt["changes"]["created"][0]["values"]["opacity"], json!(230.0 / 255.0));
    }
}

#[test]
fn premise_plans_advance_with_cumulative_changes_and_batch_references() {
    let _turn = lent_turn();
    let root = workspace("advance-plan");
    std::fs::write(root.join("advance.notes"), b"").unwrap();
    {
        let mut kit = Headless::<notes::NotesDocument>::with_replica_port(notes_kit());
        let folder = serve(&mut kit, &root);
        let info = open(&mut kit, &folder, "advance.notes");
        let params = |value: Value| value.as_object().unwrap().clone();
        let first = kit
            .context_plan(
                &info.id,
                &params(json!({"action":"begin","steps":[],"ops":[
            {"op":"create","type":"Note","in":"root.notes","ref":"$a"}
        ],"step":1})),
            )
            .unwrap();
        let token = &first["token"];
        let next = kit
            .context_plan(
                &info.id,
                &params(json!({"action":"advance","token":token,"steps":[],"ops":[
            {"op":"text.set","target":"$a","field":"body","text":"planned"}
        ],"step":2})),
            )
            .unwrap();
        assert_eq!(next["token"], *token);
        assert_eq!(next["refs"], first["refs"]);
        assert_eq!(next["changes"]["created"].as_array().unwrap().len(), 1);
        let read = kit
            .context_plan(
                &info.id,
                &params(json!({"action":"read","token":token,"method":"model.batch","params":{
                    "ops":[],"load":[{"target":next["refs"]["$a"],"fields":["body"]}]
                }})),
            )
            .unwrap();
        assert_eq!(read["loaded"][0]["fields"]["body"], "planned");
        let live = kit.model("model.batch", json!({"documentId":info.id,"ops":[],"load":[{"target":"root","fields":["notes"]}]})).unwrap();
        assert_eq!(live["loaded"][0]["fields"]["notes"], json!([]));
        kit.context_plan(&info.id, &params(json!({"action":"end","token":token}))).unwrap();
        assert!(kit.context_plan(&info.id, &params(json!({"action":"advance","token":token,"steps":[]}))).is_err());
    }
}

/// regressions/issue-premise-plan-earlier-steps: a plan begun with steps (and no batch) answers
/// the changes of those steps, so a later step's premises are checked against them. Its replica
/// was loaded only after the steps ran, from a snapshot, which carries no history: the receipt
/// since the plan's start was `HistoryMissing`, the plan had no token, and the guard answered
/// "Editor state unavailable" (kition-note `a_later_step_is_checked_after_the_earlier_steps`).
#[test]
fn a_plan_begun_with_steps_answers_the_changes_of_those_steps() {
    let _turn = lent_turn();
    let root = workspace("steps-plan");
    std::fs::write(root.join("steps.notes"), b"").unwrap();
    let mut kit = Headless::<notes::NotesDocument>::with_replica_port(notes_kit());
    let folder = serve(&mut kit, &root);
    let info = open(&mut kit, &folder, "steps.notes");
    let params = |value: Value| value.as_object().unwrap().clone();
    let first =
        kit.context_plan(&info.id, &params(json!({"action":"begin","steps":[{"command":"projection.rename","params":{"text":"Planned"}}],"step":1}))).unwrap();
    assert!(first["token"].is_string(), "{first}");
    assert_eq!(first["changes"]["changed"][0]["type"], "Board", "{first}");
    assert_eq!(first["changes"]["changed"][0]["fields"], json!(["title"]), "{first}");
    let next = kit
        .context_plan(
            &info.id,
            &params(json!({"action":"advance","token":first["token"],"steps":[{"command":"projection.rename","params":{"text":"Planned again"}}],"step":2})),
        )
        .unwrap();
    assert_eq!(next["changes"]["changed"][0]["fields"], json!(["title"]), "the receipt holds the earlier steps' changes: {next}");
    let live = kit.model("model.batch", json!({"documentId":info.id,"ops":[],"load":[{"target":"root","fields":["title"]}]})).unwrap();
    assert_ne!(live["loaded"][0]["fields"]["title"], "Planned", "the plan leaves the live document alone");
}

#[test]
fn premise_plan_can_replace_its_replica_without_replacing_the_live_document() {
    let _turn = lent_turn();
    let root = workspace("replacement-plan");
    std::fs::write(root.join("replacement.notes"), b"").unwrap();
    let mut kit = Headless::<notes::NotesDocument>::with_replica_port(notes_kit());
    let folder = serve(&mut kit, &root);
    let info = open(&mut kit, &folder, "replacement.notes");
    let before = kit.model("model.describe", json!({"documentId":info.id})).unwrap();
    let first = kit.context_plan(&info.id, &json!({"action":"begin","steps":[]}).as_object().unwrap().clone()).unwrap();
    let next =
        kit.context_plan(&info.id, &json!({"action":"advance","token":first["token"],"steps":[{"command":"board.new"}]}).as_object().unwrap().clone()).unwrap();
    assert!(!next["changes"]["created"].as_array().unwrap().is_empty());
    let read = kit
        .context_plan(&info.id, &json!({"action":"read","token":first["token"],"method":"model.describe","params":{}}).as_object().unwrap().clone())
        .unwrap();
    assert_ne!(read["rootId"], before["rootId"]);
    let live = kit.model("model.describe", json!({"documentId":info.id})).unwrap();
    assert_eq!(live["rootId"], before["rootId"]);
}

#[test]
fn null_content_region_reaches_the_mock_kit_callback() {
    let _turn = lent_turn();
    let root = workspace("null-content-region");
    std::fs::write(root.join("null.notes"), b"").unwrap();
    let mut kit = Headless::<notes::NotesDocument>::with_replica_port(notes_kit());
    let folder = serve(&mut kit, &root);
    let info = open(&mut kit, &folder, "null.notes");
    let mut params = json!({"id":"board","field":"body","region":null,"before":{}}).as_object().unwrap().clone();
    let answer = kit.context_content(&info.id, &params).unwrap();
    assert_eq!(answer, json!({"changed":null}));
    let callback = kition_kit::premise::read(&notes::NotesDocument::open("null.notes", b"").unwrap(), "content", &json!(params)).unwrap();
    assert_eq!(callback, answer);
    params.remove("region");
    assert!(kit.context_content(&info.id, &params).is_err());
}

#[test]
fn premise_plan_replacement_preserves_public_tool_ids() {
    let _turn = lent_turn();
    let root = workspace("replacement-tool-ids");
    std::fs::write(root.join("replacement.notes"), b"").unwrap();
    let mut kit = Headless::<notes::NotesDocument>::with_replica_port(notes_kit());
    let folder = serve(&mut kit, &root);
    let info = open(&mut kit, &folder, "replacement.notes");
    let first = kit.context_plan(&info.id, &json!({"action":"begin","steps":[]}).as_object().unwrap().clone()).unwrap();
    let next = kit
        .context_plan(
            &info.id,
            &json!({"action":"advance","token":first["token"],"steps":[{"command":"board.new","params":{"named":true}}]}).as_object().unwrap().clone(),
        )
        .unwrap();
    assert_eq!(next["changes"]["created"][0]["id"], "board:replacement", "{next}");
}
