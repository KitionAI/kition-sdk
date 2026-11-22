//! Engine contract E22: kition-headless tells every document it serves that the host owns every
//! file (`kition_kit::host::Hosting::files_only`), before the engine reads the file and once the
//! document exists, so a kit's engine can turn off what reaches the file system by path.
//! Before, an engine had no way to tell it ran under a host.

use grid_kit::GridDocument;
use kition_kit::host::{Hosting, hosting};

use super::*;
use crate::test_support::lent_turn;

/// The grid kit, recording what it was told: how it is hosted while it opens, and its `hosted`.
struct Told {
    grid: GridDocument,
    opening: Hosting,
    hosted: Vec<Hosting>,
    replica_objects: serde_json::Map<String, Value>,
}

impl KitDocument for Told {
    fn open(name: &str, bytes: &[u8]) -> Result<Self, String> {
        Ok(Self { grid: GridDocument::open(name, bytes)?, opening: hosting(), hosted: Vec::new(), replica_objects: Default::default() })
    }
    fn create(name: &str, width: u32, height: u32) -> Result<Self, String> {
        Ok(Self { grid: GridDocument::create(name, width, height)?, opening: hosting(), hosted: Vec::new(), replica_objects: Default::default() })
    }
    fn width(&self) -> u32 {
        self.grid.width()
    }
    fn height(&self) -> u32 {
        self.grid.height()
    }
    fn revision(&self) -> u64 {
        self.grid.revision()
    }
    fn dirty(&self) -> bool {
        self.grid.dirty()
    }
    fn render(&self, x: f64, y: f64, scale: f64, width: u32, height: u32) -> Result<Vec<u8>, String> {
        self.grid.render(x, y, scale, width, height)
    }
    fn render_area(&self, x0: i32, y0: i32, x1: i32, y1: i32, width: u32, height: u32) -> Result<Vec<u8>, String> {
        self.grid.render_area(x0, y0, x1, y1, width, height)
    }
    fn execute(&mut self, command: &str, params: Value) -> Result<Value, String> {
        self.grid.execute(command, params)
    }
    fn inspect(&self) -> Result<Value, String> {
        self.grid.inspect()
    }
    fn commands(&self) -> Vec<KitCommand> {
        self.grid.commands()
    }
    fn save(&self, name: Option<&str>) -> Result<Vec<u8>, String> {
        self.grid.save(name)
    }
    fn mark_saved(&mut self) {
        self.grid.mark_saved();
    }
    fn hosted(&mut self, hosting: &Hosting) {
        self.hosted.push(*hosting);
    }
    fn carry_replica_objects(&mut self, previous: &Self) -> Result<(), String> {
        for (id, value) in &previous.replica_objects {
            match id.as_str() {
                "keep" => {
                    self.replica_objects.insert(id.clone(), value.clone());
                }
                "reanchor" => {
                    self.replica_objects.insert(id.clone(), json!(self.width()));
                }
                "fail" => return Err("cannot carry this object".into()),
                _ => {}
            }
        }
        Ok(())
    }
}

#[test]
fn reread_hook_runs_for_reload_notification_and_reopen_and_failure_keeps_the_session() {
    let _turn = lent_turn();
    let root = std::env::temp_dir().join(format!("kition-headless-carry-{}", std::process::id()));
    std::fs::create_dir_all(&root).unwrap();
    for route in ["reload", "notification", "reopen", "fail"] {
        std::fs::write(root.join("a.grid"), GridDocument::create("a.grid", 2, 2).unwrap().save(None).unwrap()).unwrap();
        let mut kit = Headless::<Told>::new(KitInfo::from_manifest(include_str!("../../../examples/grid-kit/kit.json"), &[], &[]).unwrap());
        let folder = HostFolder::new(&root).unwrap();
        kit.set_host(folder.host());
        let file = folder.file("a.grid").unwrap();
        let info = kit.open(OpenRequest { file: &file, read_only: false, create: None }).unwrap();
        let index = kit.position(&info.id).unwrap();
        kit.docs[index].doc.replica_objects = json!({"keep":7,"reanchor":2,"drop":0}).as_object().unwrap().clone();
        if route == "fail" {
            kit.docs[index].doc.replica_objects.insert("fail".into(), json!(true));
        }
        std::fs::write(root.join("a.grid"), GridDocument::create("a.grid", 3, 3).unwrap().save(None).unwrap()).unwrap();
        let reread = match route {
            "notification" => kit.did_change_on_disk(&info.id).ok_or_else(|| RpcError::internal("expected reread")),
            "reopen" => kit.open(OpenRequest { file: &file, read_only: false, create: None }),
            _ => kit.reload(&info.id),
        };
        if route == "fail" {
            assert!(reread.is_err());
            assert_eq!(kit.docs[index].doc.width(), 2);
            assert_eq!(kit.docs[index].doc.replica_objects["keep"], 7);
        } else {
            let reread = reread.unwrap();
            let doc = &kit.docs[kit.position(&reread.id).unwrap()].doc;
            assert_eq!(doc.width(), 3);
            assert_eq!(doc.replica_objects, json!({"keep":7,"reanchor":3}).as_object().unwrap().clone());
            assert!(!reread.dirty);
        }
    }
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn every_document_is_told_the_host_owns_every_file() {
    let _turn = lent_turn();
    let root = std::env::temp_dir().join(format!("kition-headless-hosting-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(&root).unwrap();
    let root = std::fs::canonicalize(root).unwrap();
    std::fs::write(root.join("a.grid"), GridDocument::create("a.grid", 2, 2).unwrap().save(None).unwrap()).unwrap();
    let mut kit = Headless::<Told>::new(KitInfo::from_manifest(include_str!("../../../examples/grid-kit/kit.json"), &[], &[]).unwrap());
    let folder = HostFolder::new(&root).unwrap();
    kit.set_host(folder.host());
    let opened = kit.open(OpenRequest { file: &folder.file("a.grid").unwrap(), read_only: false, create: None }).unwrap();
    let created = kit.open(OpenRequest { file: &folder.file("b.grid").unwrap(), read_only: false, create: Some(("grid", None)) }).unwrap();
    for id in [&opened.id, &created.id] {
        let told = &kit.docs[kit.position(id).unwrap()].doc;
        assert!(told.opening.files_only, "hosted while the engine opens the file");
        assert_eq!(told.hosted, [Hosting { files_only: true }], "and told once it exists");
    }
    let _ = std::fs::remove_dir_all(root);
}
