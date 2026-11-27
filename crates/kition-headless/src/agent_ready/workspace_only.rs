//! [`workspace_only`]: a kit's executable, launched as a host launches it, leaves nothing in its
//! private folder and nothing new in its workspace but what the host saved (KHP A29, §10.6).

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use kition_kit_host::{HeadlessKit, LaunchOptions};
use serde_json::{Value, json};

/// What [`workspace_only`] leaves to the kit.
#[derive(Clone, Copy, Debug, Default)]
pub struct WorkspaceOnly<'a> {
    /// Commands the sweep does not run with `{}`, each with why (`("app.quit", "ends the
    /// session")`, a render that takes minutes).
    pub skip: &'a [(&'a str, &'a str)],
    /// Files the kit may leave in its private folder, as paths under it (`work/…`, `home/…`,
    /// `tmp/…`; `*` stands for any run of characters), each with why.
    pub allowed: &'a [(&'a str, &'a str)],
}

/// How long one request may take.
const LIMIT: Duration = Duration::from_secs(60);

/// Every file under `dir`, `/`-separated and relative to it, sorted.
fn files(dir: &Path) -> Vec<String> {
    let mut out = Vec::new();
    let mut stack = vec![dir.to_path_buf()];
    while let Some(next) = stack.pop() {
        for entry in std::fs::read_dir(&next).into_iter().flatten().flatten() {
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
            } else {
                let relative = path.strip_prefix(dir).unwrap_or(&path);
                out.push(relative.components().map(|part| part.as_os_str().to_string_lossy().into_owned()).collect::<Vec<_>>().join("/"));
            }
        }
    }
    out.sort();
    out
}

/// Launches the kit executable `executable` as a host does (`kition_kit_host`: a private, empty
/// current folder, home and temporary folder, the allowlisted environment; Kit Process Protocol
/// section 3), serving it a copy of `repo`'s `conformance/` as its workspace. It opens
/// `conformance/basic.<ext>` (the first extension of the manifest's first `edit` format), runs
/// `conformance/edit.json`'s steps and then every command the kit lists with `{}` (but `skip`),
/// all as the agent, and saves. Then:
///
/// - the kit's private folder holds nothing but what `allowed` names: an engine that wrote by path
///   (an auto-save beside the document's bare name, a cache in `HOME`, a print file in `TMPDIR`)
///   left it there;
/// - the workspace holds the files it was given and no other: the host saved the document in
///   place;
/// - the private folder is gone once the kit has shut down.
///
/// Errors are fine; files are not. It cannot see a write to an absolute path elsewhere, a read, a
/// process the kit started, or a network connection: those need the kit's own test or a
/// sandbox (`khp check`). Every `allowed` entry needs a reason, and one that matched nothing is a
/// problem, so the list cannot go stale. A kit calls it from a test of the package that builds its
/// executable:
///
/// ```ignore
/// #[test]
/// fn leaves_nothing_outside_its_workspace() {
///     let repo = std::path::Path::new(concat!(env!("CARGO_MANIFEST_DIR"), "/../.."));
///     let exe = std::path::Path::new(env!("CARGO_BIN_EXE_example-kit"));
///     kition_headless::agent_ready::workspace_only(exe, include_str!("../../../kit.json"), repo, &Default::default()).unwrap();
/// }
/// ```
pub fn workspace_only(executable: &Path, manifest: &str, repo: &Path, options: &WorkspaceOnly<'_>) -> Result<(), Vec<String>> {
    let manifest: Value = serde_json::from_str(manifest).map_err(|error| vec![format!("kit.json is not JSON: {error}")])?;
    let extension = manifest["formats"]
        .as_array()
        .and_then(|formats| formats.iter().find(|format| format["role"] == "edit"))
        .and_then(|format| format["extensions"].get(0))
        .and_then(Value::as_str)
        .ok_or_else(|| vec!["kit.json has no format with role edit".to_owned()])?;
    let basic = format!("basic.{extension}");
    if !repo.join("conformance").join(&basic).is_file() {
        return Err(vec![format!("conformance/{basic} is missing")]);
    }
    let mut problems = Vec::new();
    for (pattern, reason) in options.allowed.iter().chain(options.skip) {
        if reason.trim().is_empty() {
            problems.push(format!("{pattern}: no reason given"));
        }
    }
    let scratch = Scratch::new(repo)?;
    let runtime = tokio::runtime::Builder::new_multi_thread().enable_all().build().map_err(|error| vec![error.to_string()])?;
    let given = files(&scratch.workspace);
    let (left, private) = runtime.block_on(sweep(executable, &scratch, &basic, options, &mut problems))?;
    for file in &left {
        if !options.allowed.iter().any(|(pattern, _)| kition_kit::dispatch::pattern_matches(pattern, file)) {
            problems.push(format!("the kit left {file} in its private folder: something reached the file system by path (KHP A29, §10.6)"));
        }
    }
    for (pattern, _) in options.allowed {
        if !left.iter().any(|file| kition_kit::dispatch::pattern_matches(pattern, file)) {
            problems.push(format!("allowed names {pattern}, which the kit did not leave"));
        }
    }
    let now = files(&scratch.workspace);
    for file in now.iter().filter(|file| !given.contains(file)) {
        problems.push(format!("the workspace gained {file}, which the host did not save"));
    }
    if private.exists() {
        problems.push("the private folder outlived the kit".into());
    }
    if problems.is_empty() { Ok(()) } else { Err(problems) }
}

/// Runs the kit, and answers the files of its private folder and that folder.
async fn sweep(
    executable: &Path,
    scratch: &Scratch,
    basic: &str,
    options: &WorkspaceOnly<'_>,
    problems: &mut Vec<String>,
) -> Result<(Vec<String>, PathBuf), Vec<String>> {
    let mut launch = LaunchOptions::new(executable);
    launch.workspace = Some(scratch.workspace.clone());
    launch.private_base = Some(scratch.root.join("homes"));
    let kit = HeadlessKit::launch(launch).await.map_err(|error| vec![format!("the kit did not start: {error}")])?;
    let private = kit.private_dir().to_path_buf();
    let state = kit.open(basic, false, LIMIT).await.map_err(|error| vec![format!("cannot open {basic}: {error}")])?;
    let id = state["documentId"].clone();
    let run = |command: String, params: Value| {
        let kit = &kit;
        let id = id.clone();
        async move { kit.request("command.execute", json!({ "documentId": id, "command": command, "params": params, "origin": "agent" }), LIMIT).await }
    };
    let edit = std::fs::read_to_string(scratch.repo.join("conformance/edit.json")).ok().and_then(|text| serde_json::from_str::<Value>(&text).ok());
    for step in edit.as_ref().and_then(|edit| edit["steps"].as_array()).into_iter().flatten() {
        if let Some(command) = step["command"].as_str() {
            let _ = run(command.to_owned(), step.get("params").cloned().unwrap_or_else(|| json!({}))).await;
        }
    }
    match kit.request("command.list", json!({ "documentId": id }), LIMIT).await {
        Ok(listed) => {
            for command in listed["commands"].as_array().into_iter().flatten().filter_map(|command| command["id"].as_str()) {
                if !options.skip.iter().any(|(skipped, _)| *skipped == command) {
                    let _ = run(command.to_owned(), json!({})).await;
                }
            }
        }
        Err(error) => problems.push(format!("command.list failed: {error}")),
    }
    if let Err(error) = kit.request("file.save", json!({ "documentId": id }), LIMIT).await {
        problems.push(format!("file.save failed: {error}"));
    }
    let left = files(&private);
    kit.shutdown(Duration::from_secs(5)).await;
    Ok((left, private))
}

/// A copy of `conformance/` as the workspace, beside the folder private folders are made in;
/// removed when dropped.
struct Scratch {
    repo: PathBuf,
    root: PathBuf,
    workspace: PathBuf,
}

impl Scratch {
    fn new(repo: &Path) -> Result<Self, Vec<String>> {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let root = std::env::temp_dir().join(format!("khp-workspace-only-{}-{}", std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed)));
        let _ = std::fs::remove_dir_all(&root);
        let copy = || -> std::io::Result<PathBuf> {
            let workspace = root.join("workspace");
            std::fs::create_dir_all(&workspace)?;
            for entry in std::fs::read_dir(repo.join("conformance"))? {
                let entry = entry?;
                if entry.file_type()?.is_file() {
                    std::fs::copy(entry.path(), workspace.join(entry.file_name()))?;
                }
            }
            std::fs::canonicalize(workspace)
        };
        let workspace = copy().map_err(|error| vec![format!("cannot copy conformance/: {error}")])?;
        Ok(Self { repo: repo.to_path_buf(), root, workspace })
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}
