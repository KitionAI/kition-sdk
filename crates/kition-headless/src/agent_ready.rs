//! The KHP Agent-ready phases (KHP `spec/conformance.md`) a kit runs from its own tests, against
//! its headless backend and the package files beside its `kit.json`:
//!
//! ```ignore
//! #[test]
//! fn is_agent_ready() {
//!     let repo = std::path::Path::new(concat!(env!("CARGO_MANIFEST_DIR"), "/../.."));
//!     kition_headless::agent_ready::check(include_str!("../../../kit.json"), repo, || {
//!         Headless::<DesignDocument>::new(KitInfo::from_manifest(include_str!("../../../kit.json"), &[], &[]).unwrap())
//!     })
//!     .unwrap();
//! }
//! ```
//!
//! The package (`level`, `agent.*`, `agent/checks.json` with a fixture per code, and
//! `conformance/basic.<ext>`, `edit.json`, `expected/tolerance.json`); a schema for every listed
//! command and `{}` answered without a crash or a change (A5, A36); `edit.json` changing the document
//! and surviving a save and a reopen, unknown commands refused, failed calls leaving the file as it
//! was (A18); a check that changes nothing, is clean on `basic` and yields each fixture's code (A21,
//! A22, A38); a real preview (A39); and every `creates` entry and every `exports` extension (through
//! `agent.export`, as `<prefix>_export` writes it) working, with handles
//! the host never granted refused (A29, A41). The backend reads and writes the workspace through
//! the host's `files.*` ([`crate::HostFolder`]), as it does in a host.
//!
//! A kit adds its own tests for what only it can say (framing to its content, a target's size). The
//! same phases over MCP are `khp check`; this is the in-process form, so a kit sees a failure before
//! it is packaged.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use kition_kit_server::protocol::{Origin, ScreenshotScope, base64};
use kition_kit_server::{ErrorReason, KitBackend, OpenRequest, RpcError, ScreenshotRequest};

use crate::HostFolder;
use serde_json::{Map, Value, json};

mod workspace_only;
pub use workspace_only::{WorkspaceOnly, workspace_only};

/// Runs every phase and returns every failure, each prefixed with its phase. `repo` holds `agent/`
/// and `conformance/`; `kit` makes a fresh backend (each phase gets its own, with the workspace set
/// to a copy of `conformance/`). A missing or broken package file is a failure and does not hide
/// the rest: every phase whose own files are there still runs, and one that cannot says what it
/// needs.
pub fn check<B: KitBackend>(manifest: &str, repo: &Path, kit: impl Fn() -> B) -> Result<(), Vec<String>> {
    let manifest: Value = serde_json::from_str(manifest).map_err(|e| vec![format!("package: kit.json is not JSON: {e}")])?;
    let (package, errors) = Package::read(&manifest, repo);
    let mut failures: Vec<String> = errors.into_iter().map(|e| format!("package: {e}")).collect();
    type Phase<B> = fn(&Package, &mut B, &Workspace) -> Result<(), Vec<String>>;
    let phases: [(&str, Phase<B>); 5] =
        [("schemas", schemas::<B>), ("act", act::<B>), ("verify", verify::<B>), ("preview", preview::<B>), ("files", files::<B>)];
    for (name, phase) in phases {
        let outcome = Workspace::new(repo, name).and_then(|workspace| {
            let mut backend = kit();
            backend.set_host(workspace.folder.host());
            phase(&package, &mut backend, &workspace)
        });
        if let Err(errors) = outcome {
            failures.extend(errors.into_iter().map(|e| format!("{name}: {e}")));
        }
    }
    if failures.is_empty() { Ok(()) } else { Err(failures) }
}

/// The package files the phases read, as far as they are there.
struct Package {
    manifest: Value,
    /// `conformance/basic.<ext>`, `<ext>` the first extension of the first `edit` format; when it
    /// is not there, what the phases that open it need instead.
    basic: Result<String, String>,
    /// `agent/checks.json`'s codes.
    codes: BTreeSet<String>,
    /// `agent/checks.json`: `(code, fixture)`, for the fixtures that are there.
    checks: Vec<(String, String)>,
    /// `conformance/edit.json`'s `steps`: `(command, params)`.
    edit: Vec<(String, Map<String, Value>)>,
}

impl Package {
    /// The package and everything wrong with it.
    fn read(manifest: &Value, repo: &Path) -> (Self, Vec<String>) {
        let mut errors = Vec::new();
        if !matches!(manifest["level"].as_str(), Some("agent-ready" | "agent-ready-complete")) {
            errors.push(format!("level is {}, not agent-ready (K19)", manifest["level"]));
        }
        for key in ["objectModel", "layout", "drafts"] {
            if !manifest["agent"][key].is_boolean() {
                errors.push(format!("agent.{key} is not said (K16)"));
            }
        }
        let extension = manifest["formats"]
            .as_array()
            .and_then(|formats| formats.iter().find(|f| f["role"] == "edit"))
            .and_then(|f| f["extensions"].get(0))
            .and_then(Value::as_str);
        let conformance = repo.join("conformance");
        let basic = match extension {
            Some(extension) => {
                let file = format!("conformance/basic.{extension}");
                if repo.join(&file).is_file() {
                    Ok(format!("basic.{extension}"))
                } else {
                    errors.push(format!("{file} is missing"));
                    Err(file)
                }
            }
            None => {
                errors.push("no format with role edit".into());
                Err("conformance/basic.<ext> of a format with role edit".into())
            }
        };
        if !conformance.join("edit.json").is_file() {
            errors.push("conformance/edit.json is missing".into());
        }
        if !conformance.join(EXPECTED).join("tolerance.json").is_file() {
            errors.push(format!("conformance/{EXPECTED}/tolerance.json is missing"));
        }
        let (mut codes, mut checks) = (BTreeSet::new(), Vec::new());
        match read_json(&repo.join("agent/checks.json")) {
            Ok(Value::Array(entries)) if !entries.is_empty() => {
                for entry in &entries {
                    match (entry["code"].as_str(), entry["fixture"].as_str()) {
                        (Some(code), Some(fixture)) => {
                            codes.insert(code.to_owned());
                            if conformance.join(fixture).is_file() {
                                checks.push((code.to_owned(), fixture.to_owned()));
                            } else {
                                errors.push(format!("{code}: conformance/{fixture} is missing (A38)"));
                            }
                        }
                        _ => errors.push(format!("agent/checks.json entry without code and fixture: {entry}")),
                    }
                }
            }
            Ok(_) => errors.push("agent/checks.json is not a non-empty array (K17)".into()),
            Err(e) => errors.push(format!("agent/checks.json: {e} (K17)")),
        }
        let edit_file = conformance.join("edit.json");
        let mut edit = Vec::new();
        // A missing file is said above.
        if edit_file.is_file() {
            match read_json(&edit_file) {
                Ok(json) => {
                    for step in json["steps"].as_array().into_iter().flatten() {
                        if let Some(command) = step["command"].as_str() {
                            edit.push((command.to_owned(), step["params"].as_object().cloned().unwrap_or_default()));
                        }
                    }
                    if edit.is_empty() {
                        errors.push("conformance/edit.json has no steps".into());
                    }
                }
                Err(e) => errors.push(format!("conformance/edit.json: {e}")),
            }
        }
        (Self { manifest: manifest.clone(), basic, codes, checks, edit }, errors)
    }

    /// `basic`'s file name; a phase that opens it does not run without it, and says so.
    fn basic(&self) -> Result<&str, Vec<String>> {
        self.basic.as_deref().map_err(|needs| vec![format!("not run: it needs {needs}")])
    }
}

/// An error's detail (what the kit said), else its message.
fn detail(error: &RpcError) -> &str {
    error.data.as_ref().and_then(|data| data.get("detail")).and_then(Value::as_str).unwrap_or(&error.message)
}

fn read_json(path: &Path) -> Result<Value, String> {
    let text = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
    serde_json::from_str(&text).map_err(|e| e.to_string())
}

/// The folder of `conformance/` that holds the expected previews and their tolerance:
/// `expected/` (KHP spec/conformance.md, Fixtures).
const EXPECTED: &str = "expected";

/// A temporary copy of `conformance/`, removed when the phase ends, and its host.
struct Workspace {
    root: PathBuf,
    folder: HostFolder,
}

impl Workspace {
    fn new(repo: &Path, phase: &str) -> Result<Self, Vec<String>> {
        // The clock alone may give two checks running at once the same folder (macOS counts
        // microseconds), and one's cleanup would take the other's files.
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let id = std::process::id();
        let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
        let n = NEXT.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("khp-agent-ready-{phase}-{id}-{nanos}-{n}"));
        let copy = || -> std::io::Result<PathBuf> {
            std::fs::create_dir_all(&dir)?;
            // Without `conformance/` the workspace is empty; the package phase said it is missing.
            let entries = match std::fs::read_dir(repo.join("conformance")) {
                Ok(entries) => entries,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => return std::fs::canonicalize(&dir),
                Err(e) => return Err(e),
            };
            for entry in entries {
                let entry = entry?;
                if entry.file_type()?.is_file() {
                    std::fs::copy(entry.path(), dir.join(entry.file_name()))?;
                }
            }
            std::fs::canonicalize(&dir)
        };
        let root = copy().map_err(|e| vec![format!("cannot copy conformance/: {e}")])?;
        let folder = HostFolder::new(&root).map_err(|e| vec![format!("cannot serve conformance/: {}", e.message)])?;
        Ok(Self { root, folder })
    }
}

impl Drop for Workspace {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

/// Opens the workspace file `name` through a handle the host grants.
fn open<B: KitBackend>(kit: &mut B, workspace: &Workspace, name: &str) -> Result<String, Vec<String>> {
    let file = workspace.folder.file(name).map_err(|e| vec![format!("cannot grant {name}: {}", e.message)])?;
    kit.open(OpenRequest { file: &file, read_only: false, create: None }).map(|info| info.id).map_err(|e| vec![format!("cannot open {name}: {}", e.message)])
}

fn state<B: KitBackend>(kit: &mut B, id: &str) -> Result<Map<String, Value>, Vec<String>> {
    kit.describe(id).map(|d| d.state).map_err(|e| vec![format!("view.describe failed: {}", e.message)])
}

fn file_name(path: &Path) -> String {
    path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()
}

fn read(path: &Path) -> Result<Vec<u8>, Vec<String>> {
    std::fs::read(path).map_err(|e| vec![format!("cannot read {}: {e}", file_name(path))])
}

/// A5, A36: every listed command has an object schema, and `{}` on a fresh copy is a result or a
/// typed error with a message, never a change when it fails.
fn schemas<B: KitBackend>(package: &Package, kit: &mut B, workspace: &Workspace) -> Result<(), Vec<String>> {
    let basic = package.basic()?;
    let file = workspace.root.join(basic);
    let before = read(&file)?;
    let mut id = open(kit, workspace, basic)?;
    // What the agent's connection lists (the manifest's `agent.include` and `agent.exclude`).
    let listed = kit.agent_commands(Some(&id)).map_err(|e| vec![format!("commands.list failed: {}", e.message)])?;
    let mut failures = Vec::new();
    if listed.is_empty() {
        failures.push("no commands are listed".into());
    }
    for command in &listed {
        if command.params["type"] != "object" || !command.params["properties"].is_object() {
            failures.push(format!("{}: no parameter schema", command.id));
        }
    }
    for command in &listed {
        let was = state(kit, &id)?;
        match kit.execute(&id, &command.id, Map::new(), Origin::Agent) {
            Ok(_) => {
                let _ = kit.close(&id, true);
                id = open(kit, workspace, basic)?;
            }
            Err(error) => {
                if error.message.is_empty() {
                    failures.push(format!("{}: an error without a message", command.id));
                }
                if state(kit, &id)? != was {
                    failures.push(format!("{}: a failed call changed the document", command.id));
                }
            }
        }
        if failures.len() > 20 {
            failures.push("stopped after 20 failures".into());
            break;
        }
    }
    if read(&file)? != before {
        failures.push(format!("a command saved {}", basic));
    }
    if failures.is_empty() { Ok(()) } else { Err(failures) }
}

/// `edit.json` changes the document and survives a save and a reopen; unknown commands are
/// `CommandNotFound`; failed calls leave the document clean and the file byte for byte (A18).
fn act<B: KitBackend>(package: &Package, kit: &mut B, workspace: &Workspace) -> Result<(), Vec<String>> {
    let basic = package.basic()?;
    if package.edit.is_empty() {
        return Err(vec!["not run: it needs the steps of conformance/edit.json".into()]);
    }
    let file = workspace.root.join(basic);
    let mut failures = Vec::new();
    let id = open(kit, workspace, basic)?;
    let original = state(kit, &id)?;
    for (command, params) in &package.edit {
        match kit.execute(&id, command, params.clone(), Origin::Agent) {
            Ok(executed) if !executed.changed => failures.push(format!("edit.json {command}: did not change the document")),
            Ok(_) => {}
            Err(e) => failures.push(format!("edit.json {command}: {}", e.message)),
        }
    }
    let edited = state(kit, &id)?;
    if edited == original {
        failures.push("edit.json left view.describe as it was".into());
    }
    kit.save(&id, None, None).map_err(|e| vec![format!("save failed: {}", e.message)])?;
    let _ = kit.close(&id, false);
    let id = open(kit, workspace, basic)?;
    if state(kit, &id)? == original {
        failures.push("the edit did not survive a save and a reopen".into());
    }
    let bytes = read(&file)?;
    match kit.execute(&id, "no.such.command", Map::new(), Origin::Agent) {
        Ok(_) => failures.push("an unknown command succeeded".into()),
        Err(e) if e.code != ErrorReason::CommandNotFound.code() => failures.push(format!("an unknown command is error {}, not CommandNotFound", e.code)),
        Err(_) => {}
    }
    if kit.document(&id).map(|d| d.dirty).unwrap_or(true) {
        failures.push("a failed call left the document dirty".into());
    }
    if read(&file)? != bytes {
        failures.push("a failed call changed the file".into());
    }
    if failures.is_empty() { Ok(()) } else { Err(failures) }
}

fn diagnostic_codes(answer: &Value) -> Option<Vec<String>> {
    answer["diagnostics"].as_array().map(|list| list.iter().filter_map(|d| d["code"].as_str().map(str::to_owned)).collect())
}

/// The codes of the `error` diagnostics (A21).
fn error_codes(answer: &Value) -> Vec<String> {
    let list = answer["diagnostics"].as_array().into_iter().flatten();
    list.filter(|d| d["severity"] == "error").filter_map(|d| d["code"].as_str().map(str::to_owned)).collect()
}

/// A21, A22, A38: the check is clean on `basic`, changes nothing, and yields each fixture's code and
/// only catalogued codes.
fn verify<B: KitBackend>(package: &Package, kit: &mut B, workspace: &Workspace) -> Result<(), Vec<String>> {
    let mut failures = Vec::new();
    match package.basic() {
        Ok(basic) => {
            let id = open(kit, workspace, basic)?;
            let was = state(kit, &id)?;
            match kit.check(&id).map(|answer| diagnostic_codes(&answer)) {
                Ok(Some(codes)) if codes.is_empty() => {}
                Ok(Some(codes)) => failures.push(format!("{basic} is not clean: {codes:?}")),
                Ok(None) => failures.push("document.check has no diagnostics array".into()),
                Err(e) => failures.push(format!("document.check failed: {}", e.message)),
            }
            if state(kit, &id)? != was || kit.document(&id).map(|d| d.dirty).unwrap_or(true) {
                failures.push("document.check changed the document".into());
            }
            let _ = kit.close(&id, true);
        }
        Err(needs) => failures.extend(needs.into_iter().map(|needs| format!("basic {needs}"))),
    }
    for (code, fixture) in &package.checks {
        let id = match open(kit, workspace, fixture) {
            Ok(id) => id,
            Err(errors) => {
                failures.extend(errors);
                continue;
            }
        };
        match kit.check(&id).map(|answer| diagnostic_codes(&answer).unwrap_or_default()) {
            Ok(codes) => {
                if !codes.iter().any(|c| c == code) {
                    failures.push(format!("{fixture}: no {code} in {codes:?}"));
                }
                if let Some(unknown) = codes.iter().find(|c| !package.codes.contains(c.as_str())) {
                    failures.push(format!("{fixture}: {unknown} is not in agent/checks.json"));
                }
            }
            Err(e) => failures.push(format!("{fixture}: document.check failed: {}", e.message)),
        }
        let _ = kit.close(&id, true);
    }
    if failures.is_empty() { Ok(()) } else { Err(failures) }
}

/// A39: `view.screenshot` of `basic` is a PNG drawn by the engine that is "not uniform: a blank,
/// transparent, single-colour, or placeholder image fails", as `khp check` reads it: more than one
/// colour, and not every pixel transparent.
fn preview<B: KitBackend>(package: &Package, kit: &mut B, workspace: &Workspace) -> Result<(), Vec<String>> {
    let basic = package.basic()?;
    let id = open(kit, workspace, basic)?;
    let request = ScreenshotRequest { scope: ScreenshotScope::Canvas, max_size: 512, scale: 1.0, target: None };
    let shot = kit.screenshot(&id, &request).map_err(|e| vec![format!("view.screenshot failed: {}", e.message)])?;
    match uniformity(&shot.png).map_err(|e| vec![format!("view.screenshot is not a PNG: {e}")])? {
        Some(flat) => Err(vec![format!("view.screenshot is {flat}: it is not a real preview (A39)")]),
        None => Ok(()),
    }
}

/// Why a PNG is uniform (A39): `uniform (1 colour)` or `fully transparent`; `None` when it is not.
fn uniformity(png_bytes: &[u8]) -> Result<Option<String>, String> {
    let mut decoder = png::Decoder::new(png_bytes);
    decoder.set_transformations(png::Transformations::normalize_to_color8());
    let mut reader = decoder.read_info().map_err(|e| e.to_string())?;
    let mut buffer = vec![0; reader.output_buffer_size()];
    let frame = reader.next_frame(&mut buffer).map_err(|e| e.to_string())?;
    let channels = frame.color_type.samples().max(1);
    let alpha = matches!(frame.color_type, png::ColorType::Rgba | png::ColorType::GrayscaleAlpha);
    let pixels = buffer.get(..frame.buffer_size()).unwrap_or_default();
    if alpha && pixels.chunks(channels).all(|pixel| pixel.last() == Some(&0)) {
        return Ok(Some("fully transparent".into()));
    }
    let colours = pixels.chunks(channels).collect::<BTreeSet<_>>().len();
    Ok((colours <= 1).then(|| "uniform (1 colour)".into()))
}

/// A29, A41: every `creates` entry makes a new, unsaved document without `error` diagnostics that
/// saves; every `exports` extension is written by `agent.export.command`, as `<prefix>_export`
/// writes it (Kition platform K21; KHP K5 gives an export entry no command), answering a file in
/// `agent.export.data`; a handle the host never granted is refused, and the host grants none
/// outside the workspace, whether the file exists or not.
fn files<B: KitBackend>(package: &Package, kit: &mut B, workspace: &Workspace) -> Result<(), Vec<String>> {
    let mut failures = Vec::new();
    for entry in package.manifest["creates"].as_array().into_iter().flatten() {
        let (Some(format), Some(base), Some(extension)) = (entry["id"].as_str(), entry["baseName"].as_str(), entry["extension"].as_str()) else {
            failures.push(format!("creates entry without id, baseName and extension: {entry}"));
            continue;
        };
        let name = format!("{base}.{extension}");
        let path = workspace.root.join(&name);
        let options = entry["size"].as_object().cloned().unwrap_or_default();
        let file = match workspace.folder.file(&name) {
            Ok(file) => file,
            Err(e) => {
                failures.push(format!("create {format}: cannot grant {name}: {}", e.message));
                continue;
            }
        };
        match kit.open(OpenRequest { file: &file, read_only: false, create: Some((format, Some(&options))) }) {
            Ok(info) => {
                if !info.dirty {
                    failures.push(format!("create {format}: a new document is not unsaved"));
                }
                // A new document is not broken (A41; A21: `error` is "the document is broken or will
                // not show as meant"). A `warning` or an `info` ("worth knowing, nothing to fix") is
                // no failure: KHP asks nothing more of a new document.
                match kit.check(&info.id).map(|answer| error_codes(&answer)) {
                    Ok(errors) if !errors.is_empty() => failures.push(format!("create {format}: a new document has error diagnostics: {errors:?}")),
                    Ok(_) => {}
                    Err(e) => failures.push(format!("create {format}: document.check failed: {}", e.message)),
                }
                if let Err(e) = kit.save(&info.id, None, None) {
                    failures.push(format!("create {format}: save failed: {}", e.message));
                } else if !path.is_file() {
                    failures.push(format!("create {format}: save wrote no file"));
                }
            }
            Err(e) => failures.push(format!("create {format}: {}", e.message)),
        }
    }
    let mut extensions = Vec::new();
    for entry in package.manifest["exports"].as_array().into_iter().flatten() {
        match entry["extension"].as_str() {
            Some(extension) => extensions.push(extension.trim_start_matches('.').to_owned()),
            None => failures.push(format!("exports entry without extension: {entry}")),
        }
    }
    let export = &package.manifest["agent"]["export"];
    let (command, data) = (export["command"].as_str(), export["data"].as_str());
    if !extensions.is_empty() && (command.is_none() || data.is_none()) {
        let missing = match (export.is_object(), command, data) {
            (false, _, _) => "agent.export (its command and data) is missing, so nothing can export them",
            (true, None, _) => "agent.export.command is missing",
            _ => "agent.export.data is missing",
        };
        failures.push(format!("exports lists {}, but {missing} (K21, A41)", extensions.join(", ")));
    }
    let fixed = match &export["params"] {
        Value::Null => Map::new(),
        Value::Object(params) => params.clone(),
        other => {
            failures.push(format!("agent.export.params is not an object: {other}"));
            Map::new()
        }
    };
    match (package.basic(), command, data) {
        // What `<prefix>_export` runs (Kition platform K21): `agent.export.command` for every
        // extension, with its fixed `params` and `format`, answering the file's bytes in `data`.
        (Ok(basic), Some(command), Some(data)) => {
            let id = open(kit, workspace, basic)?;
            for extension in &extensions {
                let mut params = fixed.clone();
                params.insert("format".into(), json!(extension));
                match kit.execute(&id, command, params, Origin::Agent) {
                    Ok(executed) => match executed.result.as_ref().map(|result| &result[data]) {
                        Some(Value::String(text)) => match base64::decode(text) {
                            Some(bytes) if !bytes.is_empty() => {}
                            Some(_) => failures.push(format!("export {extension}: {command} answered no file in `{data}`")),
                            None => failures.push(format!("export {extension}: {command} answered a `{data}` that is not base64")),
                        },
                        _ => failures.push(format!("export {extension}: {command} answered no file in `{data}`")),
                    },
                    Err(e) => failures.push(format!("export {extension}: {command}: {}", detail(&e))),
                }
            }
        }
        (Ok(basic), _, _) => {
            open(kit, workspace, basic)?;
        }
        (Err(needs), Some(_), Some(_)) if !extensions.is_empty() => failures.extend(needs.into_iter().map(|needs| format!("exports {needs}"))),
        (Err(_), _, _) => {}
    }
    let name = package.basic.as_deref().unwrap_or("basic.file");
    let outside = [format!("../escape-{name}"), format!("/../../etc/{name}")];
    for path in outside {
        if workspace.folder.read_only(&path).is_ok() {
            failures.push(format!("{path} outside the workspace was granted"));
        }
    }
    if kit.open(OpenRequest { file: "fh_00000000000000000000000000000000", read_only: true, create: None }).is_ok() {
        failures.push("a handle the host never granted was opened".into());
    }
    if failures.is_empty() { Ok(()) } else { Err(failures) }
}

#[cfg(test)]
mod tests;
