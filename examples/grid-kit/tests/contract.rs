use grid_kit::GridDocument;
use kition_kit::testing::check_contract;
use kition_kit::{KitCommand, KitDocument};
use serde_json::{Value, json};

fn fixture() -> Vec<u8> {
    let mut bytes = b"GRID 8 6\n".to_vec();
    bytes.extend((0..48u8).map(|v| v * 5));
    bytes
}

fn edit(doc: &mut GridDocument) -> Result<(), String> {
    doc.execute("grid.set", json!({ "x": 2, "y": 3, "grey": 7 })).map(|_| ())
}

#[test]
fn a_correct_kit_passes() {
    check_contract::<GridDocument>(&fixture(), "fixture.grid", edit).unwrap();
}

/// The same kit with `render_area` sampling instead of averaging.
struct Sampling(GridDocument);

impl KitDocument for Sampling {
    fn open(name: &str, bytes: &[u8]) -> Result<Self, String> {
        let mut doc = GridDocument::open(name, bytes)?;
        doc.box_mean = false;
        Ok(Self(doc))
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
    fn execute(&mut self, command: &str, params: Value) -> Result<Value, String> {
        self.0.execute(command, params)
    }
    fn inspect(&self) -> Result<Value, String> {
        self.0.inspect()
    }
    fn commands(&self) -> Vec<KitCommand> {
        self.0.commands()
    }
    fn save(&self, name: Option<&str>) -> Result<Vec<u8>, String> {
        self.0.save(name)
    }
    fn mark_saved(&mut self) {
        self.0.mark_saved();
    }
}

#[test]
fn a_render_area_that_samples_instead_of_averaging_fails() {
    let error = check_contract::<Sampling>(&fixture(), "fixture.grid", |doc| edit(&mut doc.0)).unwrap_err();
    assert!(error.contains("box mean"), "{error}");
}

#[test]
fn bad_bytes_and_unknown_commands_are_errors() {
    assert!(GridDocument::open("x.grid", b"PNG").is_err());
    let mut doc = GridDocument::open("x.grid", &fixture()).unwrap();
    assert!(doc.execute("nope", json!({})).is_err());
    assert!(kition_kit::parse_params("not json").is_err());
    assert_eq!(kition_kit::parse_params(" ").unwrap(), json!({}));
}

#[test]
fn agent_facing_commands_carry_schemas() {
    let doc = GridDocument::open("x.grid", &fixture()).unwrap();
    let set = doc.commands().into_iter().find(|command| command.id == "grid.set").unwrap();
    let schema = set.schema.expect("grid.set has a schema");
    kition_kit::schema::validate(&schema).unwrap();
    assert_eq!(schema["grey"]["type"], "integer");
}

#[test]
fn the_engine_tool_paints_and_reports_overlays() {
    use kition_kit::tools::{KitTools, PointerAction, ToolMods, ToolPointer};
    let mut doc = GridDocument::open("x.grid", &fixture()).unwrap();
    let before = doc.revision();
    let response = doc.pointer(&ToolPointer { action: PointerAction::Down, x: 1.5, y: 2.5, mods: ToolMods::default(), pressure: 1.0, zoom: 4.0 }).unwrap();
    assert!(doc.revision() > before, "the pencil edited the grid");
    assert_eq!(response.cursor, "crosshair");
    assert_eq!(response.overlays.len(), 1);
    assert!(doc.select_tool("eraser", 1.0).is_err());
}

#[test]
fn reads_a_granted_file_by_handle_and_produces_a_file_for_the_host() {
    use kition_kit::host::{HandleTable, set_handles};
    use kition_kit::testing::check_outputs;

    let dir = std::env::temp_dir().join(format!("grid-kit-files-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("in.grey"), [9u8; 48]).unwrap();
    std::fs::write(dir.join("short.grey"), [9u8; 3]).unwrap();
    set_handles(Some(Box::new(HandleTable::default().grant("fh_in", dir.join("in.grey")).grant("fh_short", dir.join("short.grey")))));

    let mut doc = GridDocument::open("x.grid", &fixture()).unwrap();
    // A path is not a handle, an ungranted handle is refused, and a file of the wrong size is an error.
    assert!(doc.execute("grid.import", json!({ "file": "in.grey" })).is_err());
    assert!(doc.execute("grid.import", json!({ "file": "fh_other" })).unwrap_err().contains("not granted"));
    assert!(doc.execute("grid.import", json!({ "file": "fh_short" })).is_err());
    doc.execute("grid.import", json!({ "file": "fh_in" })).unwrap();
    assert_eq!(doc.grey_at(5, 5), 9);
    set_handles(None);

    // The export answers its output and keeps the bytes until the host takes them.
    let outputs = check_outputs(&mut doc, "grid.exportPgm", json!({})).unwrap();
    assert_eq!(outputs.len(), 1);
    let (info, bytes) = &outputs[0];
    assert_eq!((info.suggested_name.as_str(), info.mime.as_str()), ("Grid.pgm", "image/x-portable-graymap"));
    assert!(bytes.starts_with(b"P5\n8 6\n255\n"));
    assert_eq!(bytes.len(), "P5\n8 6\n255\n".len() + 48);
    // A command that answers no outputs fails the check.
    assert!(check_outputs(&mut doc, "grid.set", json!({ "x": 0, "y": 0, "grey": 1 })).unwrap_err().contains("outputs"));

    let file_schema = doc.commands().into_iter().find(|command| command.id == "grid.import").unwrap().schema.unwrap();
    kition_kit::schema::validate(&file_schema).unwrap();
    assert_eq!(kition_kit::schema::file_params(&file_schema), ["file"]);
    let _ = std::fs::remove_dir_all(dir);
}

/// Every command says what it does, and the read command says what it answers (KitCommand::description, KHP A1).
#[test]
fn every_command_says_what_it_does() {
    let doc = GridDocument::create("a.grid", 2, 2).unwrap();
    kition_kit::testing::check_commands(&doc.commands(), &[]).unwrap();
}
