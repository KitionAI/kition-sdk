//! `kition agent add/remove/list` against stand-ins for `claude` and `codex` (shell scripts that
//! log how they were run) and a home folder of the test's own: nothing reaches the person's real
//! agent configuration. Cursor's `mcp.json` is merged, keeping what else it holds.
#![cfg(unix)]

mod support;

use std::path::{Path, PathBuf};

use serde_json::{Value, json};
use support::{kition, run};

/// A stand-in for an agent's command: it logs `<folder>|<arguments>` to `$STUB_LOG`, keeps
/// `kition` registered between `mcp add` and `mcp remove`, and answers `mcp get` as Codex does.
const STUB: &str = r#"#!/bin/sh
echo "$(pwd -P)|$*" >> "$STUB_LOG"
marker="$(dirname "$0")/registered-$(basename "$0")"
case "$1 $2" in
  "mcp add") touch "$marker" ;;
  "mcp remove") [ -f "$marker" ] || { echo "no server named kition" >&2; exit 1; }; rm -f "$marker" ;;
  "mcp get") [ -f "$marker" ] || exit 1; echo '{"name":"kition","transport":{"type":"stdio","command":"/k/kition","args":["mcp"]}}' ;;
esac
"#;

struct Scene {
    _dir: tempfile::TempDir,
    root: PathBuf,
    stubs: PathBuf,
    person: PathBuf,
    project: PathBuf,
    log: PathBuf,
}

impl Scene {
    fn new() -> Self {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(dir.path()).unwrap();
        let stubs = root.join("stubs");
        let person = root.join("person");
        let project = root.join("project");
        for folder in [&stubs, &person, &project] {
            std::fs::create_dir_all(folder).unwrap();
        }
        for name in ["claude", "codex"] {
            std::fs::write(stubs.join(name), STUB).unwrap();
            std::fs::set_permissions(stubs.join(name), std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let log = root.join("log");
        Self { _dir: dir, root, stubs, person, project, log }
    }

    /// `kition agent <args>` in the project folder, with the stand-ins on the PATH (`with_agents`)
    /// or not.
    fn agent(&self, args: &[&str], with_agents: bool) -> (bool, String, String) {
        self.agent_launched(args, with_agents, None)
    }

    /// The same, as the npm launcher starts kition: with `KITION_LAUNCHER` set to `launcher`.
    fn agent_launched(&self, args: &[&str], with_agents: bool, launcher: Option<&Value>) -> (bool, String, String) {
        let path = if with_agents { format!("{}:/usr/bin:/bin", self.stubs.display()) } else { "/usr/bin:/bin".to_owned() };
        let mut command = kition(&self.root.join("home"));
        command.arg("agent").args(args).current_dir(&self.project).env("PATH", path).env("HOME", &self.person).env("STUB_LOG", &self.log);
        if let Some(launcher) = launcher {
            command.env("KITION_LAUNCHER", launcher.to_string());
        }
        run(&mut command)
    }

    fn logged(&self) -> Vec<String> {
        std::fs::read_to_string(&self.log).unwrap_or_default().lines().map(str::to_owned).collect()
    }
}

fn kition_path() -> String {
    std::path::absolute(env!("CARGO_BIN_EXE_kition")).unwrap().display().to_string()
}

fn read(path: &Path) -> Value {
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

#[test]
fn registers_with_claude_code_and_codex_through_their_commands() {
    let scene = Scene::new();
    let project = scene.project.display().to_string();
    let kition = kition_path();

    let (ok, out, err) = scene.agent(&["add", "claude"], true);
    assert!(ok, "{out}{err}");
    let expected = format!("{project}|mcp add -s local kition -- {kition} mcp --workspace {project}");
    assert_eq!(scene.logged(), vec![expected], "run in the project folder, with this kition's absolute path");
    assert!(out.contains(&format!("ran: claude mcp add -s local kition -- {kition} mcp --workspace {project}")), "{out}");

    let (ok, out, err) = scene.agent(&["add", "claude", "--scope", "user"], true);
    assert!(ok, "{out}{err}");
    assert!(scene.logged()[1].ends_with(&format!("|mcp add -s user kition -- {kition} mcp")), "a user registration fixes no folder: {:?}", scene.logged());

    let (ok, _, err) = scene.agent(&["add", "codex", "--scope", "project"], true);
    assert!(!ok && err.contains("Codex keeps its MCP servers for the user only"), "{err}");
    let (ok, out, err) = scene.agent(&["add", "codex"], true);
    assert!(ok, "{out}{err}");
    assert!(scene.logged()[2].ends_with(&format!("|mcp add kition -- {kition} mcp")), "{:?}", scene.logged());

    let (ok, out, _) = scene.agent(&["list"], true);
    assert!(ok && out.contains("Claude Code:") && out.contains("Codex: /k/kition mcp"), "{out}");

    let (ok, out, err) = scene.agent(&["remove", "claude"], true);
    assert!(ok && out.contains("ran: claude mcp remove kition"), "{out}{err}");
    let (ok, out, _) = scene.agent(&["remove", "codex"], true);
    assert!(ok && out.contains("ran: codex mcp remove kition"), "{out}");
    let (ok, out, _) = scene.agent(&["remove", "codex"], true);
    assert!(!ok && out.contains("no server named kition"), "the agent's refusal is passed on: {out}");

    let (ok, _, err) = scene.agent(&["add", "claude"], false);
    assert!(!ok && err.contains("Claude Code is not on the PATH"), "{err}");
    let (ok, out, _) = scene.agent(&["list"], false);
    assert!(ok && out.contains("Claude Code: not here") && out.contains("Codex: not here"), "{out}");
}

#[test]
fn registers_with_cursor_by_merging_its_mcp_json() {
    let scene = Scene::new();
    let project = scene.project.display().to_string();
    let kition = kition_path();
    let file = scene.project.join(".cursor/mcp.json");
    std::fs::create_dir_all(file.parent().unwrap()).unwrap();
    std::fs::write(&file, r#"{ "mcpServers": { "other": { "command": "other-server", "args": ["--x"] } }, "theme": "kept" }"#).unwrap();

    let (ok, out, err) = scene.agent(&["add", "cursor", "--scope", "project"], false);
    assert!(ok && out.contains(&format!("wrote {}", file.display())), "{out}{err}");
    let config = read(&file);
    assert_eq!(config["theme"], "kept");
    assert_eq!(config["mcpServers"]["other"], json!({ "command": "other-server", "args": ["--x"] }));
    assert_eq!(config["mcpServers"]["kition"], json!({ "command": kition, "args": ["mcp", "--workspace", project] }));
    let left: Vec<_> = std::fs::read_dir(file.parent().unwrap()).unwrap().flatten().map(|entry| entry.file_name()).collect();
    assert_eq!(left.len(), 1, "written through a temporary file and a rename: {left:?}");

    let (ok, _, err) = scene.agent(&["add", "cursor", "--scope", "user"], false);
    assert!(ok, "{err}");
    let user = read(&scene.person.join(".cursor/mcp.json"));
    assert_eq!(user["mcpServers"]["kition"]["args"], json!(["mcp", "--workspace", "${workspaceFolder}"]));

    let (ok, out, _) = scene.agent(&["list"], false);
    assert!(ok && out.matches("Cursor:").count() == 2, "{out}");

    let (ok, out, _) = scene.agent(&["remove", "cursor"], false);
    assert!(ok && out.matches("removed mcpServers.kition").count() == 2, "{out}");
    let config = read(&file);
    assert!(config["mcpServers"].get("kition").is_none() && config["mcpServers"]["other"]["command"] == "other-server", "{config}");
    let (ok, _, err) = scene.agent(&["remove", "cursor"], false);
    assert!(!ok && err.contains("not registered with Cursor"), "{err}");

    std::fs::write(&file, "{ not json").unwrap();
    let (ok, _, err) = scene.agent(&["add", "cursor"], false);
    assert!(!ok && err.contains("is not JSON") && std::fs::read_to_string(&file).unwrap() == "{ not json", "a file it cannot read is left alone: {err}");

    let (ok, _, err) = scene.agent(&["add", "cursor", "--workspace", "/no/such/folder"], false);
    assert!(!ok && err.contains("no such folder"), "{err}");
    let (ok, _, err) = scene.agent(&["add", "vim"], false);
    assert!(!ok && err.contains("claude, codex and cursor"), "{err}");
}

/// Started by the npm package, kition registers what will still start it next week: `npx -y kition`
/// (npx runs it from npm's cache, which npm may clear) or npm's global `kition` command (not the
/// executable inside node_modules). A `KITION_LAUNCHER` naming another executable is not taken.
#[test]
fn registers_the_npm_command_that_started_it() {
    let scene = Scene::new();
    let project = scene.project.display().to_string();
    let kition = kition_path();
    let npx = json!({ "via": "npx", "command": ["npx", "-y", "kition"], "executable": kition });

    let (ok, out, err) = scene.agent_launched(&["add", "claude"], true, Some(&npx));
    assert!(ok, "{out}{err}");
    assert_eq!(scene.logged(), vec![format!("{project}|mcp add -s local kition -- npx -y kition mcp --workspace {project}")]);
    let (ok, out, err) = scene.agent_launched(&["add", "codex"], true, Some(&npx));
    assert!(ok, "{out}{err}");
    assert!(scene.logged()[1].ends_with("|mcp add kition -- npx -y kition mcp"), "{:?}", scene.logged());
    let (ok, out, err) = scene.agent_launched(&["add", "cursor", "--scope", "project"], false, Some(&npx));
    assert!(ok, "{out}{err}");
    let file = scene.project.join(".cursor/mcp.json");
    assert_eq!(read(&file)["mcpServers"]["kition"], json!({ "command": "npx", "args": ["-y", "kition", "mcp", "--workspace", project] }));

    // npm install -g: <prefix>/bin/kition, npm's link to the launcher.
    let shim = scene.root.join("npm/bin/kition").display().to_string();
    let global = json!({ "via": "npm", "command": [shim], "executable": kition });
    let (ok, out, err) = scene.agent_launched(&["add", "cursor", "--scope", "project"], false, Some(&global));
    assert!(ok, "{out}{err}");
    assert_eq!(read(&file)["mcpServers"]["kition"], json!({ "command": shim, "args": ["mcp", "--workspace", project] }));
    let (ok, out, err) = scene.agent_launched(&["add", "claude", "--scope", "user"], true, Some(&global));
    assert!(ok, "{out}{err}");
    assert!(scene.logged()[2].ends_with(&format!("|mcp add -s user kition -- {shim} mcp")), "{:?}", scene.logged());

    // A KITION_LAUNCHER inherited from another kition (another executable) is not this one's.
    let other = json!({ "via": "npx", "command": ["npx", "-y", "kition"], "executable": scene.root.join("other/kition") });
    let (ok, out, err) = scene.agent_launched(&["add", "cursor", "--scope", "project"], false, Some(&other));
    assert!(ok, "{out}{err}");
    assert_eq!(read(&file)["mcpServers"]["kition"]["command"], json!(kition));
}
