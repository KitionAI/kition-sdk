//! generic draft review through the mock kit and the human CLI. No sibling kits needed.
#![cfg(unix)]

use std::path::PathBuf;

use kition_kits::{KitDefinition, KitManager, drafts, tools};
use serde_json::{Value, json};

#[path = "support/binary.rs"]
mod binary;

struct Fixture {
    kits: KitManager,
    workspace: tempfile::TempDir,
    _bin: tempfile::TempDir,
    launcher: PathBuf,
    path: String,
    name: String,
}

impl Fixture {
    fn new(name: &str, env: &str, text: &str, model: bool) -> Self {
        use std::os::unix::fs::PermissionsExt;
        let mock = binary::mock_binary().unwrap_or_else(|| panic!("build kition-kit-mock before running this case"));
        assert!(mock.is_file(), "build kition-kit-mock before running this case");
        let manifest = json!({
            "khp": "1.0", "id": format!("kit.{name}"), "name": name, "version": "0.0.0",
            "formats": [{ "id": name, "extensions": [name], "role": "edit" }],
            "agent": { "prefix": name, "tools": "document", "drafts": true, "objectModel": model },
            "headless": { "executable": "kition-kit-mock", "protocol": "kition-kit/2" }
        });
        let kit = KitDefinition::from_manifest(&manifest).unwrap_or_else(|error| panic!("{error}"));
        let bin = tempfile::tempdir().unwrap_or_else(|error| panic!("{error}"));
        std::fs::write(bin.path().join("kit.json"), manifest.to_string()).unwrap_or_else(|error| panic!("{error}"));
        let launcher = bin.path().join("kition-kit-mock");
        std::fs::write(&launcher, format!("#!/bin/sh\nKITION_KIT_MOCK_AS=kit.{name}:{name} {env} exec '{}' \"$@\"\n", mock.display()))
            .unwrap_or_else(|error| panic!("{error}"));
        std::fs::set_permissions(&launcher, std::fs::Permissions::from_mode(0o755)).unwrap_or_else(|error| panic!("{error}"));
        let workspace = tempfile::tempdir().unwrap_or_else(|error| panic!("{error}"));
        let path = format!("a.{name}");
        std::fs::write(workspace.path().join(&path), text).unwrap_or_else(|error| panic!("{error}"));
        let kits = KitManager::new(Some(workspace.path().to_path_buf()), vec![(kit, Some(launcher.clone()))]).with_headless_drafts();
        Self { kits, workspace, _bin: bin, launcher, path, name: name.to_owned() }
    }

    async fn call(&self, action: &str, mut input: Value) -> Value {
        input["path"] = json!(self.path);
        tools::call(&self.kits, &format!("{}_{action}", self.name), &input)
            .await
            .unwrap_or_else(|| panic!("no {action} tool"))
            .unwrap_or_else(|error| panic!("{}", error.message))
            .output
    }

    async fn compare(&self) -> Value {
        drafts::compare(&self.kits, &self.path, false).await.unwrap_or_else(|error| panic!("{}", error.message))
    }
}

#[tokio::test]
async fn replica_review_uses_receipt_ids_values_and_all_four_lists() {
    let f = Fixture::new("dcreplica", "KITION_KIT_MOCK_REPLICA=full KITION_KIT_MOCK_PARTS=tracks", "20:1=0+2|2=2+2|3=4+2", true);
    let receipt = f
        .call(
            "batch",
            json!({ "draft": true, "changes": "all", "ops": [
        { "op": "set", "target": "1", "field": "opacity", "value": 40.0 },
        { "op": "list.move", "target": "20", "field": "clips", "from": 2, "to": 0 },
        { "op": "create", "type": "Clip", "in": "20.clips", "fields": { "start": 8, "duration": 2, "opacity": 100, "enabled": true } },
        { "op": "delete", "target": "2" }
    ] }),
        )
        .await;
    let compared = f.compare().await;
    assert_eq!(compared["mode"], "replica", "{compared}");
    for list in ["created", "changed", "moved", "deleted"] {
        assert_eq!(compared["diff"][list], receipt["changes"][list], "{list}: {compared} / {receipt}");
        assert!(!compared["diff"][list].as_array().unwrap().is_empty(), "{list}: {compared}");
    }
    assert_eq!(compared["diff"]["changed"][0]["id"], 1);
    assert_eq!(compared["diff"]["changed"][0]["edits"], json!([{ "field": "opacity", "before": 100, "after": 40 }]));
    assert_eq!(compared["diff"]["moved"][0]["to"]["parent"], "20", "the track's numeric name is a string");
    assert!(compared.get("diffUnavailable").is_none(), "{compared}");
    assert_eq!(f.compare().await, compared, "review is read only");
    assert_eq!(std::fs::read_to_string(f.workspace.path().join(&f.path)).unwrap(), "20:1=0+2|2=2+2|3=4+2");
    f.kits.shutdown().await;
    let output = tokio::process::Command::new(env!("CARGO_BIN_EXE_kition-kits-mcp"))
        .args(["drafts", "compare", &f.path, "--workspace"])
        .arg(f.workspace.path())
        .arg("--kit")
        .arg(&f.launcher)
        .output()
        .await
        .unwrap_or_else(|error| panic!("{error}"));
    assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
    assert_eq!(serde_json::from_slice::<Value>(&output.stdout).unwrap(), compared);
}

#[tokio::test]
async fn file_review_pairs_reread_objects_and_names_map_leaves_and_held_edits() {
    let f = Fixture::new("dcfile", "KITION_KIT_MOCK_REPLICA=export KITION_KIT_MOCK_PARTS=tracks", "V1[label=\"old\"]:1=0+2{blur:5}", true);
    let receipt = f
        .call(
            "batch",
            json!({ "draft": true, "changes": "all", "ops": [
        { "op": "map.set", "target": "V1", "field": "attrs", "key": "label", "value": "new" },
        { "op": "set", "target": "1", "field": "effects.0.amount", "value": 9 }
    ] }),
        )
        .await;
    let compared = f.compare().await;
    assert_eq!(compared["mode"], "file", "{compared}");
    for list in ["created", "changed", "moved", "deleted"] {
        assert_eq!(compared["diff"][list], receipt["changes"][list], "{list}: {compared} / {receipt}");
    }
    assert_eq!(compared["diff"]["changed"][0]["edits"][0]["named"], "blur.amount");
    assert!(compared.get("diffUnavailable").is_none(), "{compared}");
    f.kits.shutdown().await;
}

#[tokio::test]
async fn review_bounds_entries_fields_and_unicode_values_with_counts() {
    let f = Fixture::new("dcbounds", "KITION_KIT_MOCK_REPLICA=full KITION_KIT_MOCK_PARTS=tracks", "V1:1=0+2", true);
    let long = "界🙂".repeat(1000);
    // A map is a container: each key is written with map.set.
    let mut ops: Vec<Value> = (0..200)
        .map(|index| json!({ "op": "map.set", "target": "V1", "field": "attrs", "key": format!("key{index:03}"), "value": { "payload": long } }))
        .collect();
    ops.extend((0..120).map(
        |index| json!({ "op": "create", "type": "Clip", "in": "V1.clips", "fields": { "start": index + 10, "duration": 1, "opacity": 100, "enabled": true } }),
    ));
    f.call("batch", json!({ "draft": true, "ops": ops })).await;
    let compared = f.compare().await;
    let diff = &compared["diff"];
    let count = |list: &str| diff[list].as_array().unwrap().len();
    assert_eq!(count("created") + count("changed") + count("moved") + count("deleted"), 50, "{diff}");
    assert_eq!(count("created") + diff["truncated"]["created"].as_u64().unwrap() as usize, 120);
    let track = diff["changed"].as_array().unwrap().iter().find(|entry| entry["id"] == "V1").unwrap();
    assert!(track["edits"].as_array().unwrap().len() <= 50, "{track}");
    assert!(diff["truncated"]["edits"].as_u64().unwrap() > 0, "{diff}");
    assert!(diff["truncated"]["values"].as_u64().unwrap() > 0, "{diff}");
    let shown = &track["edits"][0]["after"];
    assert!(shown["excerpt"].as_str().unwrap().chars().count() <= 80, "{shown}");
    assert!(shown["length"].as_u64().unwrap() > 80, "{shown}");
    assert!(diff.to_string().len() < 100 * 65_536 + 4096);
    f.kits.shutdown().await;
}

#[tokio::test]
async fn review_keeps_the_no_model_fallback() {
    let f = Fixture::new("dcnomodel", "KITION_KIT_MOCK_SCHEMA=none", "Hello", false);
    f.call("run", json!({ "draft": true, "steps": [{ "command": "text.append", "params": { "text": " world" } }] })).await;
    let compared = f.compare().await;
    assert!(compared["diff"].is_null(), "{compared}");
    assert!(compared["diffUnavailable"].is_string(), "{compared}");
    assert_eq!(compared["summary"], json!({ "base": "5 characters", "draft": "11 characters" }));
    f.kits.shutdown().await;
}

#[tokio::test]
async fn review_bounds_full_texts_and_created_values_too() {
    let f = Fixture::new("dctexts", "KITION_KIT_MOCK_REPLICA=full", "Hello", true);
    let long = "界🙂".repeat(1000);
    let mut ops = vec![json!({ "op": "text.set", "target": "root", "field": "text", "text": long })];
    ops.extend((0..60).map(|_| json!({ "op": "create", "type": "Tag", "in": "root.tags", "fields": { "name": long } })));
    f.call("batch", json!({ "draft": true, "ops": ops })).await;
    let compared = f.compare().await;
    let diff = &compared["diff"];
    assert_eq!(diff["texts"].as_array().unwrap().len(), 50, "{diff}");
    assert_eq!(diff["truncated"]["texts"], 11, "{diff}");
    assert_eq!(diff["truncated"]["created"], 11, "{diff}");
    for text in diff["texts"].as_array().unwrap() {
        assert_eq!(text["after"]["length"], 2000, "{text}");
        assert!(text["after"]["excerpt"].as_str().unwrap().chars().count() <= 80, "{text}");
    }
    for item in diff["created"].as_array().unwrap() {
        assert_eq!(item["values"]["name"]["length"], 2000, "{item}");
        assert!(item["values"]["name"]["excerpt"].as_str().unwrap().chars().count() <= 80, "{item}");
    }
    f.kits.shutdown().await;
}
