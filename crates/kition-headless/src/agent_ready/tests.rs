use std::cell::Cell;
use std::path::{Path, PathBuf};

use grid_kit::GridDocument;
use kition_kit::diagnostics::{Diagnostic, Severity};
use kition_kit::{KitCommand, KitDocument};
use serde_json::{Value, json};

use crate::{Headless, KitInfo};
use kition_kit_server::protocol::base64;

thread_local! {
    /// The severity of `probe.blank`, which a blank grid (every new one) yields.
    static BLANK: Cell<Severity> = const { Cell::new(Severity::Info) };
}

/// The reference grid kit with what the Agent-ready phases read: a schema on every command, the
/// pixels in `inspect`, and a check that finds a blank grid.
struct Probe(GridDocument);

impl KitDocument for Probe {
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
    fn execute(&mut self, command: &str, params: Value) -> Result<Value, String> {
        // The kit's export command (`agent.export`): the grid as text, in the field `data`, only
        // with the fixed parameters the manifest gives.
        if command == "probe.exportBytes" {
            if params["ids"] != json!([]) {
                return Err("`ids` is the manifest's fixed parameter".into());
            }
            return match params["format"].as_str() {
                Some("txt") => Ok(json!({ "data": base64::encode(format!("{:?}", self.greys()).as_bytes()) })),
                Some("nothing") => Ok(json!({ "data": "" })),
                other => Err(format!("cannot export {other:?}")),
            };
        }
        self.0.execute(command, params)
    }
    fn inspect(&self) -> Result<Value, String> {
        let mut inspected = self.0.inspect()?;
        inspected["greys"] = json!(self.greys());
        Ok(inspected)
    }
    fn commands(&self) -> Vec<KitCommand> {
        let mut commands: Vec<KitCommand> =
            self.0.commands().into_iter().map(|command| KitCommand { schema: command.schema.clone().or_else(|| Some(json!({}))), ..command }).collect();
        commands.push(KitCommand {
            id: "probe.exportBytes".into(),
            title: "Export Bytes".into(),
            schema: Some(json!({ "format": { "type": "string" }, "ids": { "type": "json" } })),
            mutates: false,
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
    fn check(&self) -> Vec<Diagnostic> {
        if self.greys().iter().all(|grey| *grey == 255) { vec![Diagnostic::new("probe.blank", BLANK.get(), "The grid is blank.")] } else { Vec::new() }
    }
}

impl Probe {
    fn greys(&self) -> Vec<u32> {
        (0..self.height()).flat_map(|y| (0..self.width()).map(move |x| (x, y))).map(|(x, y)| self.0.grey_at(x, y)).collect()
    }
}

fn grid(width: u32, height: u32, greys: &[u8]) -> Vec<u8> {
    let mut bytes = format!("GRID {width} {height}\n").into_bytes();
    bytes.extend(greys);
    bytes
}

fn manifest() -> String {
    let mut manifest: Value = serde_json::from_str(include_str!("../../../../examples/grid-kit/kit.json")).unwrap();
    manifest["level"] = json!("agent-ready");
    manifest["agent"]["objectModel"] = json!(false);
    manifest["agent"]["layout"] = json!(false);
    manifest["agent"]["drafts"] = json!(false);
    manifest.to_string()
}

/// A kit repository with every package file: `basic.grid` in black and white (two colours), the
/// fixture `blank.grid`, one edit, a tolerance, and the check catalogue.
fn repo(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("kition-agent-ready-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(dir.join("conformance/expected")).unwrap();
    std::fs::create_dir_all(dir.join("agent")).unwrap();
    let write = |path: &str, bytes: &[u8]| std::fs::write(dir.join(path), bytes).unwrap();
    write("conformance/basic.grid", &grid(4, 2, &[0, 255, 0, 255, 255, 0, 255, 0]));
    write("conformance/blank.grid", &grid(4, 2, &[255; 8]));
    write("conformance/edit.json", json!({ "steps": [{ "command": "grid.set", "params": { "x": 0, "y": 0, "grey": 77 } }] }).to_string().as_bytes());
    write("conformance/expected/tolerance.json", b"{}");
    write(
        "agent/checks.json",
        json!([{ "code": "probe.blank", "severity": "info", "summary": "The grid is blank.", "fixture": "blank.grid" }]).to_string().as_bytes(),
    );
    dir
}

fn check(repo: &Path) -> Result<(), Vec<String>> {
    check_with(repo, &manifest())
}

fn check_with(repo: &Path, manifest: &str) -> Result<(), Vec<String>> {
    super::check(manifest, repo, || Headless::<Probe>::new(KitInfo::from_manifest(manifest, &[], &[]).unwrap()))
}

/// [`manifest`] with `exports` and, when given, `agent.export`.
fn exporting(exports: Value, export: Option<Value>) -> String {
    let mut manifest: Value = serde_json::from_str(&manifest()).unwrap();
    manifest["exports"] = exports;
    if let Some(export) = export {
        manifest["agent"]["export"] = export;
    }
    manifest.to_string()
}

fn has(failures: &[String], wanted: &str) -> bool {
    failures.iter().any(|failure| failure.contains(wanted))
}

// regressions/issue-agent-ready-spec-checks: A39 asks for a preview that is "not uniform" (more than
// one colour, not transparent), and nothing in KHP asks a new document to have no `info`
// diagnostics (A21: `info` is "worth knowing, nothing to fix"; A41). The self-test failed a
// two-colour preview and a new document with a documented `info` code.
#[test]
fn a_two_colour_preview_and_an_info_on_a_new_document_pass() {
    BLANK.set(Severity::Info);
    let repo = repo("spec");
    assert_eq!(check(&repo), Ok(()));
    let _ = std::fs::remove_dir_all(repo);
}

// regressions/issue-expected-folder-rename: the expected previews are conformance/expected/. While
// the kits move from the old name one by one, a kit with only the old folder still passes; both
// folders at once fail, naming them; with neither, the tolerance is missing under the new name.
#[test]
fn the_expected_previews_are_read_from_expected_and_the_old_folder_only_alone() {
    BLANK.set(Severity::Info);
    let repo = repo("expected-folder");
    let (expected, old) = (repo.join("conformance/expected"), repo.join(format!("conformance/{}", super::EXPECTED_BEFORE_RENAME)));
    assert_eq!(check(&repo), Ok(()), "expected/ alone");

    std::fs::rename(&expected, &old).unwrap();
    assert_eq!(check(&repo), Ok(()), "the old folder alone, until every kit has moved");
    std::fs::remove_file(old.join("tolerance.json")).unwrap();
    let failures = check(&repo).unwrap_err();
    assert!(has(&failures, &format!("package: conformance/{}/tolerance.json is missing", super::EXPECTED_BEFORE_RENAME)), "{failures:#?}");
    std::fs::write(old.join("tolerance.json"), b"{}").unwrap();

    std::fs::create_dir_all(&expected).unwrap();
    std::fs::write(expected.join("tolerance.json"), b"{}").unwrap();
    let failures = check(&repo).unwrap_err();
    let both = format!("package: conformance/expected/ and conformance/{}/ are both there", super::EXPECTED_BEFORE_RENAME);
    assert!(has(&failures, &both), "{failures:#?}");
    assert!(!failures.iter().any(|failure| failure.contains("tolerance.json is missing")), "{failures:#?}");

    std::fs::remove_dir_all(&old).unwrap();
    std::fs::remove_dir_all(&expected).unwrap();
    let failures = check(&repo).unwrap_err();
    assert!(has(&failures, "package: conformance/expected/tolerance.json is missing"), "neither: {failures:#?}");
    let _ = std::fs::remove_dir_all(repo);
}

#[test]
fn a_new_document_with_an_error_diagnostic_fails() {
    BLANK.set(Severity::Error);
    let repo = repo("new-error");
    let failures = check(&repo).unwrap_err();
    assert!(has(&failures, "files: create grid: a new document has error diagnostics: [\"probe.blank\"]"), "{failures:#?}");
    let _ = std::fs::remove_dir_all(repo);
}

#[test]
fn a_uniform_preview_fails() {
    BLANK.set(Severity::Info);
    let repo = repo("uniform");
    std::fs::write(repo.join("conformance/basic.grid"), grid(4, 2, &[128; 8])).unwrap();
    let failures = check(&repo).unwrap_err();
    assert_eq!(failures, ["preview: view.screenshot is uniform (1 colour): it is not a real preview (A39)"]);
    let _ = std::fs::remove_dir_all(repo);
}

#[test]
fn a_transparent_or_one_colour_png_is_uniform_and_two_colours_are_not() {
    let png = |rgba: &[u8]| crate::encode_png(rgba, 2, 1).unwrap();
    assert_eq!(super::uniformity(&png(&[9, 9, 9, 255, 9, 9, 9, 255])), Ok(Some("uniform (1 colour)".to_owned())));
    assert_eq!(super::uniformity(&png(&[9, 9, 9, 0, 200, 0, 0, 0])), Ok(Some("fully transparent".to_owned())));
    assert_eq!(super::uniformity(&png(&[0, 0, 0, 255, 255, 255, 255, 255])), Ok(None));
    assert!(super::uniformity(b"not a png").is_err());
}

// regressions/issue-agent-ready-all-failures: after a package error the self-test returned that
// error alone, so the caller saw only that the tolerance file was missing and none of the later
// phases' failures.
#[test]
fn later_phases_run_after_package_errors() {
    BLANK.set(Severity::Error);
    let repo = repo("all-failures");
    std::fs::remove_file(repo.join("conformance/expected/tolerance.json")).unwrap();
    std::fs::remove_file(repo.join("agent/checks.json")).unwrap();
    let failures = check(&repo).unwrap_err();
    assert!(has(&failures, "package: conformance/expected/tolerance.json is missing"), "{failures:#?}");
    assert!(has(&failures, "package: agent/checks.json: "), "{failures:#?}");
    assert!(has(&failures, "files: create grid: a new document has error diagnostics"), "a later phase still runs: {failures:#?}");
    assert!(!failures.iter().any(|failure| failure.starts_with("verify:")), "basic is clean; only the fixtures need the catalogue: {failures:#?}");
    let _ = std::fs::remove_dir_all(repo);
}

#[test]
fn phases_that_need_a_missing_file_say_they_did_not_run() {
    BLANK.set(Severity::Info);
    let repo = repo("missing-basic");
    std::fs::remove_file(repo.join("conformance/basic.grid")).unwrap();
    std::fs::remove_file(repo.join("conformance/edit.json")).unwrap();
    let failures = check(&repo).unwrap_err();
    for wanted in [
        "package: conformance/basic.grid is missing",
        "package: conformance/edit.json is missing",
        "schemas: not run: it needs conformance/basic.grid",
        "act: not run: it needs conformance/basic.grid",
        "preview: not run: it needs conformance/basic.grid",
    ] {
        assert!(has(&failures, wanted), "{wanted}: {failures:#?}");
    }
    // What needs no basic still runs: the fixtures' codes, and new documents.
    assert!(!has(&failures, "blank.grid"), "{failures:#?}");
    assert!(!has(&failures, "create grid"), "{failures:#?}");

    let _ = std::fs::remove_dir_all(repo);
    let repo = self::repo("missing-edit");
    std::fs::write(repo.join("conformance/edit.json"), br#"{ "steps": [] }"#).unwrap();
    let failures = check(&repo).unwrap_err();
    assert_eq!(failures, ["package: conformance/edit.json has no steps", "act: not run: it needs the steps of conformance/edit.json"]);
    let _ = std::fs::remove_dir_all(repo);
}

// regressions/issue-agent-ready-export-command: `<prefix>_export` runs `agent.export.command` for
// every extension in `exports` (Kition platform K21, kit.schema.json; KHP K5 gives an export entry
// no command), and answers the file in the field `agent.export.data`. The self-test ran
// `exports[].command` instead, failing kits whose agent export path worked.
#[test]
fn exports_run_through_the_agent_export_command_and_answer_a_file() {
    BLANK.set(Severity::Info);
    let repo = repo("export");
    let export = json!({ "command": "probe.exportBytes", "data": "data", "params": { "ids": [] } });
    // `exports[].command` is not what agents run: a name no command has does not matter.
    let manifest = exporting(json!([{ "extension": "txt", "command": "probe.noSuchExport" }]), Some(export.clone()));
    assert_eq!(check_with(&repo, &manifest), Ok(()));

    // Every declared format runs, and each answers a file.
    let manifest = exporting(json!([{ "extension": "txt" }, { "extension": "pdf" }, { "extension": "nothing" }]), Some(export.clone()));
    let failures = check_with(&repo, &manifest).unwrap_err();
    assert_eq!(
        failures,
        ["files: export pdf: probe.exportBytes: cannot export Some(\"pdf\")", "files: export nothing: probe.exportBytes answered no file in `data`",]
    );
    let wrong_field = exporting(json!([{ "extension": "txt" }]), Some(json!({ "command": "probe.exportBytes", "data": "bytes", "params": { "ids": [] } })));
    assert_eq!(check_with(&repo, &wrong_field), Err(vec!["files: export txt: probe.exportBytes answered no file in `bytes`".to_owned()]));

    // Formats to export and no command to export them with.
    let missing = exporting(json!([{ "extension": "txt", "command": "probe.exportBytes" }]), None);
    assert_eq!(
        check_with(&repo, &missing),
        Err(vec!["files: exports lists txt, but agent.export (its command and data) is missing, so nothing can export them (K21, A41)".to_owned()])
    );
    let _ = std::fs::remove_dir_all(repo);
}

/// regressions/issue-kit-launch-environment: the check a kit adopts in one line catches an engine
/// that writes by path (the mock's `probe.environment` writes into its current folder, `HOME` and
/// temporary folder), names each file, and passes once each is
/// allowed with a reason.
#[test]
fn workspace_only_finds_what_the_kit_wrote_by_path() {
    let Some(mock) = crate::test_support::workspace_binary("kition-kit-mock") else {
        eprintln!("skipped: build kition-kit-mock first (cargo build -p kition-kit-mock)");
        return;
    };
    let repo = std::env::temp_dir().join(format!("khp-workspace-only-repo-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&repo);
    std::fs::create_dir_all(repo.join("conformance")).unwrap();
    std::fs::write(repo.join("conformance/basic.mocktext"), "hello").unwrap();
    let edit = json!({ "steps": [{ "command": "text.append", "params": { "text": " world" } }, { "command": "probe.environment" }] });
    std::fs::write(repo.join("conformance/edit.json"), edit.to_string()).unwrap();
    let manifest = include_str!("../../../kition-kit-mock/kit.json");

    let problems = super::workspace_only(&mock, manifest, &repo, &super::WorkspaceOnly::default()).unwrap_err();
    for file in ["work/probe-cwd.txt", "home/probe-home.txt", "tmp/probe-tmp.txt"] {
        assert!(problems.iter().any(|problem| problem.starts_with(&format!("the kit left {file} "))), "{file}: {problems:#?}");
    }
    assert_eq!(problems.len(), 3, "the saved document is no stray file: {problems:#?}");

    let allowed = [("work/probe-*", "the probe's own"), ("home/probe-home.txt", "the probe's own"), ("tmp/*", "the probe's own")];
    super::workspace_only(&mock, manifest, &repo, &super::WorkspaceOnly { skip: &[], allowed: &allowed }).unwrap();
    let stale = [("work/probe-*", "the probe's own"), ("home/probe-home.txt", "the probe's own"), ("tmp/*", "the probe's own"), ("home/.cache/*", "")];
    let problems = super::workspace_only(&mock, manifest, &repo, &super::WorkspaceOnly { skip: &[], allowed: &stale }).unwrap_err();
    assert_eq!(problems, ["home/.cache/*: no reason given", "allowed names home/.cache/*, which the kit did not leave"]);
    assert_eq!(std::fs::read_to_string(repo.join("conformance/basic.mocktext")).unwrap(), "hello", "the repository's copy is untouched");
    let _ = std::fs::remove_dir_all(repo);
}
