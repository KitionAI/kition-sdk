//! `kition agent <command>`: registers `kition mcp` as the MCP server named `kition` with an
//! agent, removes it, and lists where it is registered.
//!
//! Claude Code and Codex are asked through their own commands (`claude mcp add`, `codex mcp
//! add`), found on the PATH; Cursor's `mcp.json` is merged here. The agents' programs and the
//! person's home folder come from the environment (`PATH`, `HOME`, `USERPROFILE` on Windows), so
//! tests run against stand-ins and a home of their own.

use std::path::{Path, PathBuf};
use std::process::{Command, ExitCode, Output};

use serde_json::{Map, Value, json};

use kition_cli::launcher::Started;

use super::{Args, help, shell_quote};

/// The name the server is registered under.
const SERVER: &str = "kition";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Agent {
    Claude,
    Codex,
    Cursor,
}

pub const AGENTS: [Agent; 3] = [Agent::Claude, Agent::Codex, Agent::Cursor];

impl Agent {
    fn parse(name: &str) -> Option<Self> {
        AGENTS.into_iter().find(|agent| agent.name() == name)
    }

    pub fn name(self) -> &'static str {
        match self {
            Self::Claude => "claude",
            Self::Codex => "codex",
            Self::Cursor => "cursor",
        }
    }

    pub fn title(self) -> &'static str {
        match self {
            Self::Claude => "Claude Code",
            Self::Codex => "Codex",
            Self::Cursor => "Cursor",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Scope {
    User,
    Project,
}

/// The program `name` on the PATH (with the PATHEXT extensions on Windows).
pub fn find_program(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    let extensions: Vec<String> = if cfg!(windows) {
        std::env::var("PATHEXT").unwrap_or_else(|_| ".EXE;.CMD;.BAT".to_owned()).split(';').map(str::to_ascii_lowercase).collect()
    } else {
        vec![String::new()]
    };
    std::env::split_paths(&path).find_map(|folder| {
        extensions.iter().map(|extension| folder.join(format!("{name}{extension}"))).find(|candidate| {
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::metadata(candidate).is_ok_and(|meta| meta.is_file() && meta.permissions().mode() & 0o111 != 0)
            }
            #[cfg(not(unix))]
            {
                candidate.is_file()
            }
        })
    })
}

/// The person's home folder, where Cursor keeps its user `mcp.json`.
fn person_home() -> Result<PathBuf, String> {
    std::env::home_dir().ok_or_else(|| "cannot tell where your home folder is (HOME)".to_owned())
}

/// Cursor's `mcp.json` for `scope`: `<folder>/.cursor/mcp.json` or `~/.cursor/mcp.json`.
fn cursor_file(scope: Scope, folder: &Path) -> Result<PathBuf, String> {
    Ok(match scope {
        Scope::Project => folder.join(".cursor").join("mcp.json"),
        Scope::User => person_home()?.join(".cursor").join("mcp.json"),
    })
}

/// `kition agent <args>`.
pub fn run(args: &[String]) -> ExitCode {
    let Some(command) = args.first().map(String::as_str) else { return help::print(&["agent"]) };
    if matches!(command, "--help" | "-h" | "help") {
        return help::print(&["agent"]);
    }
    if !matches!(command, "add" | "remove" | "list") {
        return help::unknown(&["agent"], command);
    }
    let path = ["agent", command];
    let rest = &args[1..];
    if super::asks_help(rest) {
        return help::print(&path);
    }
    let valued: &[&'static str] = if command == "list" { &["--workspace"] } else { &["--workspace", "--scope"] };
    let args = match Args::parse(rest, &[], valued) {
        Ok(args) => args,
        Err(message) => return help::mistake(&path, message),
    };
    let scope = match args.value("--scope") {
        None => None,
        Some("user") => Some(Scope::User),
        Some("project") => Some(Scope::Project),
        Some(other) => return help::mistake(&path, format!("--scope is user or project, not {other}")),
    };
    let workspace = match args.value("--workspace").map(folder).transpose() {
        Ok(workspace) => workspace,
        Err(message) => return help::mistake(&path, message),
    };
    let here = match std::env::current_dir() {
        Ok(here) => here,
        Err(error) => return fail(format!("cannot read the current folder: {error}")),
    };
    let words: Vec<&str> = args.words.iter().map(String::as_str).collect();
    if command == "list" {
        return match words.as_slice() {
            [] => list(workspace.as_deref().unwrap_or(&here)),
            extra => help::mistake(&path, format!("too many arguments: {}", extra.join(" "))),
        };
    }
    let agent = match words.as_slice() {
        [name] => match Agent::parse(name) {
            Some(agent) => agent,
            None => return help::mistake(&path, format!("the agents are claude, codex and cursor, not {name}")),
        },
        [] => return help::mistake(&path, "name the agent: claude, codex or cursor"),
        extra => return help::mistake(&path, format!("too many arguments: {}", extra.join(" "))),
    };
    if agent == Agent::Codex && scope == Some(Scope::Project) {
        return fail("Codex keeps its MCP servers for the user only (~/.codex/config.toml): leave out --scope, or give --scope user");
    }
    let outcome = match command {
        "add" => {
            let scope = scope.unwrap_or(if agent == Agent::Codex { Scope::User } else { Scope::Project });
            add(agent, scope, workspace.as_deref(), &here)
        }
        _ => remove(agent, scope, workspace.as_deref().unwrap_or(&here)),
    };
    match outcome {
        Ok(true) => ExitCode::SUCCESS,
        Ok(false) => ExitCode::FAILURE,
        Err(message) => fail(message),
    }
}

fn fail(message: impl std::fmt::Display) -> ExitCode {
    eprintln!("kition: {message}");
    ExitCode::FAILURE
}

/// `text` as an absolute folder that exists.
fn folder(text: &str) -> Result<PathBuf, String> {
    let path = std::path::absolute(text).map_err(|error| format!("{text}: {error}"))?;
    if !path.is_dir() {
        return Err(format!("--workspace {text}: no such folder"));
    }
    Ok(std::fs::canonicalize(&path).unwrap_or(path))
}

/// The command that starts this kition, as the agent is to run it: its absolute path (so the
/// agent finds it whatever its PATH), or, started by the npm package, `npx -y kition` or npm's
/// `kition` command, which outlive the npm cache and upgrades (`kition_cli::launcher`).
fn this_kition() -> Result<(String, Vec<String>), String> {
    Ok(Started::detect()?.command(cfg!(windows)))
}

/// What the agent runs: `kition mcp`, with `--workspace` when one is fixed.
fn server_args(workspace: Option<&str>) -> Vec<String> {
    let mut args = vec!["mcp".to_owned()];
    if let Some(workspace) = workspace {
        args.extend(["--workspace".to_owned(), workspace.to_owned()]);
    }
    args
}

/// Runs `program` with `args` in `folder`, saying exactly what it ran and passing on what it said.
fn run_tool(program: &Path, args: &[String], folder: &Path) -> Result<Output, String> {
    let name = program.file_stem().map(|stem| stem.to_string_lossy().into_owned()).unwrap_or_default();
    let line: Vec<String> = std::iter::once(name).chain(args.iter().map(|arg| shell_quote(arg))).collect();
    println!("ran: {}    (in {}; {})", line.join(" "), folder.display(), program.display());
    let output = Command::new(program).args(args).current_dir(folder).output().map_err(|error| format!("cannot run {}: {error}", program.display()))?;
    for line in String::from_utf8_lossy(&output.stdout).lines().chain(String::from_utf8_lossy(&output.stderr).lines()) {
        println!("  {line}");
    }
    Ok(output)
}

fn program_of(agent: Agent) -> Result<PathBuf, String> {
    let name = agent.name();
    find_program(name).ok_or_else(|| {
        format!("{} is not on the PATH (no `{name}` program found): install it, or add its folder to the PATH, then run this again", agent.title())
    })
}

/// Registers this kition with `agent`. `Ok(false)` when the agent's command refused.
fn add(agent: Agent, scope: Scope, workspace: Option<&Path>, here: &Path) -> Result<bool, String> {
    let (kition, mut start) = this_kition()?;
    let project = workspace.unwrap_or(here);
    // A project registration serves its folder; a user one the folder the agent works in, unless
    // --workspace fixes one.
    let fixed = match (scope, workspace) {
        (_, Some(workspace)) => Some(workspace.display().to_string()),
        (Scope::Project, None) => Some(here.display().to_string()),
        (Scope::User, None) => None,
    };
    match agent {
        Agent::Claude => {
            let program = program_of(agent)?;
            let scope_name = if scope == Scope::Project { "local" } else { "user" };
            let mut args: Vec<String> = ["mcp", "add", "-s", scope_name, SERVER, "--", &kition].map(str::to_owned).to_vec();
            args.extend(start);
            args.extend(server_args(fixed.as_deref()));
            let mut output = run_tool(&program, &args, project)?;
            let said = format!("{}{}", String::from_utf8_lossy(&output.stdout), String::from_utf8_lossy(&output.stderr));
            if !output.status.success() && said.contains("already exists") {
                let removed = run_tool(&program, &["mcp", "remove", "-s", scope_name, SERVER].map(str::to_owned), project)?;
                if !removed.status.success() {
                    return Ok(false);
                }
                output = run_tool(&program, &args, project)?;
            }
            Ok(output.status.success())
        }
        Agent::Codex => {
            let program = program_of(agent)?;
            let mut args: Vec<String> = ["mcp", "add", SERVER, "--", &kition].map(str::to_owned).to_vec();
            args.extend(start);
            args.extend(server_args(fixed.as_deref()));
            Ok(run_tool(&program, &args, project)?.status.success())
        }
        Agent::Cursor => {
            let file = cursor_file(scope, project)?;
            // Cursor fills in ${workspaceFolder} with the folder open in it.
            let workspace = fixed.unwrap_or_else(|| "${workspaceFolder}".to_owned());
            start.extend(server_args(Some(&workspace)));
            let entry = json!({ "command": kition, "args": start });
            let mut config = read_cursor(&file)?;
            let servers = servers_of(&mut config, &file)?;
            servers.insert(SERVER.to_owned(), entry.clone());
            write_json(&file, &config)?;
            println!("wrote {}: mcpServers.{SERVER} = {entry}", file.display());
            Ok(true)
        }
    }
}

/// Removes the registration from `agent`. `Ok(false)` when there was none or the agent's command
/// refused.
fn remove(agent: Agent, scope: Option<Scope>, project: &Path) -> Result<bool, String> {
    match agent {
        Agent::Claude => {
            let program = program_of(agent)?;
            let mut args: Vec<String> = ["mcp", "remove", SERVER].map(str::to_owned).to_vec();
            if let Some(scope) = scope {
                args.extend(["-s".to_owned(), if scope == Scope::Project { "local" } else { "user" }.to_owned()]);
            }
            Ok(run_tool(&program, &args, project)?.status.success())
        }
        Agent::Codex => Ok(run_tool(&program_of(agent)?, &["mcp", "remove", SERVER].map(str::to_owned), project)?.status.success()),
        Agent::Cursor => {
            let scopes = scope.map_or_else(|| vec![Scope::Project, Scope::User], |scope| vec![scope]);
            let mut looked = Vec::new();
            let mut removed = false;
            for scope in scopes {
                let file = cursor_file(scope, project)?;
                looked.push(file.display().to_string());
                if !file.is_file() {
                    continue;
                }
                let mut config = read_cursor(&file)?;
                if servers_of(&mut config, &file)?.remove(SERVER).is_some() {
                    write_json(&file, &config)?;
                    println!("wrote {}: removed mcpServers.{SERVER}", file.display());
                    removed = true;
                }
            }
            if !removed {
                eprintln!("kition: kition is not registered with Cursor (looked in {})", looked.join(" and "));
            }
            Ok(removed)
        }
    }
}

/// A Cursor `mcp.json` as it is; an empty one when there is none.
fn read_cursor(file: &Path) -> Result<Value, String> {
    match std::fs::read_to_string(file) {
        Ok(text) if text.trim().is_empty() => Ok(json!({})),
        Ok(text) => {
            let value: Value = serde_json::from_str(&text)
                .map_err(|error| format!("{} is not JSON ({error}): fix it or move it aside, then run this again", file.display()))?;
            if !value.is_object() {
                return Err(format!("{} is not a JSON object: fix it or move it aside, then run this again", file.display()));
            }
            Ok(value)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(json!({})),
        Err(error) => Err(format!("cannot read {}: {error}", file.display())),
    }
}

/// The `mcpServers` object of a Cursor `mcp.json`, made when missing.
fn servers_of<'a>(config: &'a mut Value, file: &Path) -> Result<&'a mut Map<String, Value>, String> {
    let object = config.as_object_mut().ok_or_else(|| format!("{} is not a JSON object", file.display()))?;
    object
        .entry("mcpServers")
        .or_insert_with(|| json!({}))
        .as_object_mut()
        .ok_or_else(|| format!("{}: its mcpServers is not an object: fix it, then run this again", file.display()))
}

/// Writes `value` to `file` through a temporary file beside it and one rename.
fn write_json(file: &Path, value: &Value) -> Result<(), String> {
    let folder = file.parent().unwrap_or(Path::new("."));
    std::fs::create_dir_all(folder).map_err(|error| format!("cannot write {}: {error}", folder.display()))?;
    let scratch = kition_cli::fetch::scratch(folder, ".mcp.json.kition");
    let text = format!("{}\n", serde_json::to_string_pretty(value).unwrap_or_default());
    let written = std::fs::write(&scratch, text).and_then(|()| std::fs::rename(&scratch, file));
    if let Err(error) = written {
        let _ = std::fs::remove_file(&scratch);
        return Err(format!("cannot write {}: {error}", file.display()));
    }
    Ok(())
}

/// Where `kition` is registered with one agent.
pub struct Registrations {
    pub agent: Agent,
    /// Whether the agent is here: its program on the PATH (Cursor: its user folder too).
    pub present: bool,
    /// Each registration found, described.
    pub found: Vec<String>,
    /// Why it could not be told, when it could not.
    pub problem: Option<String>,
}

/// Where `kition` is registered with each agent, for the folder `project` and for the user.
pub fn registrations(project: &Path) -> Vec<Registrations> {
    AGENTS.into_iter().map(|agent| registrations_of(agent, project)).collect()
}

fn registrations_of(agent: Agent, project: &Path) -> Registrations {
    let mut seen = Registrations { agent, present: false, found: Vec::new(), problem: None };
    let ask = |program: &Path, args: &[&str]| Command::new(program).args(args).current_dir(project).output();
    match agent {
        Agent::Claude | Agent::Codex => {
            let Some(program) = find_program(agent.name()) else { return seen };
            seen.present = true;
            let args: &[&str] = if agent == Agent::Claude { &["mcp", "get", SERVER] } else { &["mcp", "get", SERVER, "--json"] };
            match ask(&program, args) {
                Ok(output) if output.status.success() => {
                    let said = String::from_utf8_lossy(&output.stdout).into_owned();
                    let described = match serde_json::from_str::<Value>(&said) {
                        Ok(value) => described_entry(value.get("transport").unwrap_or(&value)),
                        Err(_) => said.lines().map(str::trim).filter(|line| !line.is_empty()).collect::<Vec<_>>().join("; "),
                    };
                    seen.found.push(described);
                }
                Ok(_) => {}
                Err(error) => seen.problem = Some(format!("cannot run {}: {error}", program.display())),
            }
        }
        Agent::Cursor => {
            seen.present = find_program("cursor").is_some() || person_home().is_ok_and(|home| home.join(".cursor").is_dir());
            for scope in [Scope::Project, Scope::User] {
                let Ok(file) = cursor_file(scope, project) else { continue };
                if !file.is_file() {
                    continue;
                }
                match read_cursor(&file) {
                    Ok(config) => {
                        if let Some(entry) = config.pointer(&format!("/mcpServers/{SERVER}")) {
                            seen.found.push(format!("{}: {}", file.display(), described_entry(entry)));
                        }
                    }
                    Err(problem) => seen.problem = Some(problem),
                }
            }
        }
    }
    seen
}

/// A server entry (`command` and `args`) as one command line.
fn described_entry(entry: &Value) -> String {
    let command = entry.get("command").and_then(Value::as_str).unwrap_or_default();
    let args = entry.get("args").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).map(shell_quote);
    std::iter::once(shell_quote(command)).chain(args).collect::<Vec<_>>().join(" ")
}

fn list(project: &Path) -> ExitCode {
    for seen in registrations(project) {
        let title = seen.agent.title();
        if let Some(problem) = &seen.problem {
            println!("{title}: {problem}");
        } else if !seen.present && seen.found.is_empty() {
            println!("{title}: not here (no `{}` on the PATH)", seen.agent.name());
        } else if seen.found.is_empty() {
            println!("{title}: kition is not registered: kition agent add {}", seen.agent.name());
        } else {
            for found in &seen.found {
                println!("{title}: {found}");
            }
        }
    }
    ExitCode::SUCCESS
}
