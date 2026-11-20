//! `kition doctor`: what is wrong, and the command that fixes it. It checks the Kition home, the
//! PATH, the kit index, each installed kit in use (started and asked `kit.initialize` as a host
//! does, through `kition-kit-host`), and which agents have `kition` registered.

use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::time::Duration;

use kition_cli::home::Home;
use kition_cli::index::{self, Freshness, INDEX_VARIABLE, Source};
use kition_cli::launcher::Started;
use kition_cli::store::Store;
use kition_kit_host::{HeadlessKit, LaunchOptions};
use serde_json::{Value, json};

use super::agent::{self, Registrations};
use super::{Args, help};

/// How long a kit has to start and answer `kit.initialize`.
const KIT_TIMEOUT: Duration = Duration::from_secs(20);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Status {
    Ok,
    /// Works, but not as well as it could (an index read earlier, not now).
    Warn,
    /// Broken: the exit status is 1.
    Fail,
    /// For information: nothing to fix (an agent kition is not registered with).
    Info,
}

impl Status {
    fn word(self) -> &'static str {
        match self {
            Self::Ok => "ok",
            Self::Warn => "warn",
            Self::Fail => "fail",
            Self::Info => "info",
        }
    }
}

struct Check {
    name: String,
    status: Status,
    detail: String,
    /// The command that fixes it.
    fix: Option<String>,
}

impl Check {
    fn new(name: impl Into<String>, status: Status, detail: impl Into<String>, fix: Option<String>) -> Self {
        Self { name: name.into(), status, detail: detail.into(), fix }
    }
}

/// `kition doctor <args>`.
pub fn run(args: &[String]) -> ExitCode {
    if super::asks_help(args) {
        return help::print(&["doctor"]);
    }
    let args = match Args::parse(args, &["--json"], &["--index"]) {
        Ok(args) => args,
        Err(message) => return help::mistake(&["doctor"], message),
    };
    if let Some(extra) = args.words.first() {
        return help::mistake(&["doctor"], format!("it takes no arguments: {extra}"));
    }
    let source = Source::choose(args.value("--index"));
    let mut checks = Vec::new();
    let home = match Home::from_env() {
        Ok(home) => {
            checks.push(check_home(&home));
            Some(home)
        }
        Err(message) => {
            checks.push(Check::new("home", Status::Fail, message, Some("export KITION_HOME=\"$HOME/.kition\"".to_owned())));
            None
        }
    };
    checks.push(check_path());
    if let Some(home) = &home {
        checks.push(Check::new("registries", Status::Info, format!("kits and the index come from {}", kition_cli::registry::configured().named()), None));
        checks.push(check_index(home, &source));
        checks.extend(check_kits(&Store::new(home.clone())));
        checks.extend(check_editors(&Store::new(home.clone())));
        checks.push(check_gateways(home));
    }
    let here = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    checks.extend(agent::registrations(&here).into_iter().map(check_agent));
    let ok = checks.iter().all(|check| check.status != Status::Fail);
    let version = kition_cli::VERSION;
    let protocol = kition_cli::protocol();
    let platform = kition_cli::home::platform();
    if args.has("--json") {
        let answer = json!({
            "version": version,
            "protocol": protocol,
            "platform": platform,
            "home": home.as_ref().map(|home| home.root().display().to_string()),
            "ok": ok,
            "checks": checks.iter().map(|check| json!({
                "name": check.name, "status": check.status.word(), "detail": check.detail, "fix": check.fix,
            })).collect::<Vec<Value>>(),
        });
        println!("{}", serde_json::to_string_pretty(&answer).unwrap_or_default());
    } else {
        println!("kition {version} (kit protocol {protocol}, index format {}) on {platform}", index::SCHEMA_VERSION);
        let width = checks.iter().map(|check| check.name.chars().count()).max().unwrap_or(0);
        for check in &checks {
            println!("{:<4}  {:<width$}  {}", check.status.word(), check.name, check.detail);
            if let Some(fix) = &check.fix {
                println!("{:<4}  {:<width$}  fix: {fix}", "", "");
            }
        }
        let failed = checks.iter().filter(|check| check.status == Status::Fail).count();
        if failed > 0 {
            println!("{failed} check{} failed", if failed == 1 { "" } else { "s" });
        }
    }
    if ok { ExitCode::SUCCESS } else { ExitCode::FAILURE }
}

/// The gateways whose lockfiles are in the home's `run/` (`kition gateway`): which serve which
/// workspace, and which lockfiles are left by gateways that are gone (the next gateway for that
/// workspace replaces them). For information only.
fn check_gateways(home: &Home) -> Check {
    let lockfiles: Vec<PathBuf> = std::fs::read_dir(kition_cli::gateway::run_dir(home))
        .map(|entries| {
            entries.filter_map(Result::ok).map(|entry| entry.path()).filter(|path| path.extension().is_some_and(|extension| extension == "json")).collect()
        })
        .unwrap_or_default();
    let mut live = Vec::new();
    let mut stale = 0;
    for path in &lockfiles {
        match kition_cli::gateway::read(path) {
            Some(lock) if kition_cli::gateway::identity(&lock).is_some() => live.push(format!("{} at {} (pid {})", lock.workspace, lock.url, lock.pid)),
            _ => stale += 1,
        }
    }
    let mut detail = if live.is_empty() { "none running".to_owned() } else { format!("{} running: {}", live.len(), live.join("; ")) };
    if stale > 0 {
        detail.push_str(&format!("; {stale} lockfile{} left by gateways that stopped", if stale == 1 { "" } else { "s" }));
    }
    Check::new("gateways", Status::Info, detail, None)
}

/// The home, and whether a file can be written there (or, when it is not made yet, in the
/// nearest folder above it that is).
fn check_home(home: &Home) -> Check {
    let root = home.root();
    let shown = root.display();
    let fix = Some("export KITION_HOME=<a folder you can write>".to_owned());
    let Some(existing) = root.ancestors().find(|folder| folder.exists()) else {
        return Check::new("home", Status::Fail, format!("{shown}: no folder above it exists"), fix);
    };
    if !existing.is_dir() {
        return Check::new("home", Status::Fail, format!("{shown}: {} is not a folder", existing.display()), fix);
    }
    let probe = kition_cli::fetch::scratch(existing, ".kition-doctor");
    match std::fs::write(&probe, b"") {
        Ok(()) => {
            let _ = std::fs::remove_file(&probe);
            let made = if existing == root { "writable" } else { "not made yet; it can be" };
            Check::new("home", Status::Ok, format!("{shown} ({made})"), None)
        }
        Err(error) => Check::new("home", Status::Fail, format!("{shown} cannot be written ({}: {error})", existing.display()), fix),
    }
}

/// Whether `kition` runs from any shell: the folder of the command that starts this kition is on
/// the PATH. Run directly, that is this kition's own folder; from a global npm install, npm's
/// folder of commands, which holds `kition` (npm's link or `kition.cmd`), not the folder inside
/// node_modules that holds the executable. Through npx, or from a project's node_modules, there
/// is no `kition` command to put on the PATH: that is said, with the install that gives one.
fn check_path() -> Check {
    let started = match Started::detect() {
        Ok(started) => started,
        Err(_) => return Check::new("PATH", Status::Warn, "cannot tell where this kition is", None),
    };
    let global = Some("npm install -g @kition/cli   (or install.sh: docs/sdk/cli.md)".to_owned());
    let (folder, what) = match &started {
        Started::Npx { command } => {
            let detail = format!("kition runs through npx ({}), from npm's cache: no `kition` command is on the PATH", command.join(" "));
            return Check::new("PATH", Status::Info, detail, global);
        }
        Started::Npm { command } if Started::is_project_command(command) => {
            let detail = format!("kition runs from a project's node_modules ({}): no `kition` command is on the PATH", command.display());
            return Check::new("PATH", Status::Info, detail, global);
        }
        Started::Npm { command } => (command.parent().map(Path::to_path_buf), "npm's folder of global commands, holding kition"),
        Started::Itself(exe) => (exe.parent().map(Path::to_path_buf), "this kition's folder"),
    };
    let Some(folder) = folder else {
        return Check::new("PATH", Status::Warn, "cannot tell where this kition is", None);
    };
    let same = |a: &Path, b: &Path| std::fs::canonicalize(a).ok().zip(std::fs::canonicalize(b).ok()).is_some_and(|(a, b)| a == b);
    let on_path = std::env::var_os("PATH").is_some_and(|path| std::env::split_paths(&path).any(|entry| same(&entry, &folder)));
    if on_path {
        return Check::new("PATH", Status::Ok, format!("{} ({what}) is on the PATH", folder.display()), None);
    }
    let fix = if cfg!(windows) {
        format!("setx PATH \"%PATH%;{}\"   (then open a new terminal)", folder.display())
    } else {
        format!("export PATH=\"{}:$PATH\"   (add the line to your shell's profile, ~/.zshrc or ~/.bashrc)", folder.display())
    };
    Check::new("PATH", Status::Fail, format!("{} ({what}) is not on the PATH", folder.display()), Some(fix))
}

/// Whether the index can be read now; else how old the copy kept from the last read is.
fn check_index(home: &Home, source: &Source) -> Check {
    let location = &source.location;
    let fix = Some(format!(
        "check the network (and HTTPS_PROXY), name a registry that answers (export {}=<address>, such as https://registry.npmmirror.com), or another index ({INDEX_VARIABLE}=<address or file>); then kition doctor",
        kition_cli::registry::REGISTRY_VARIABLE
    ));
    match index::load(home, source, Freshness::Now) {
        Ok(loaded) if loaded.stale.is_none() => Check::new("index", Status::Ok, format!("{location}: read now, {} kits", loaded.index.kits.len()), None),
        Ok(loaded) => {
            let age = source.kept_age(home).map_or_else(|| "of unknown age".to_owned(), |age| format!("read {} ago", duration(age)));
            let why = loaded.stale.unwrap_or_default();
            Check::new("index", Status::Warn, format!("{location} cannot be read now ({why}); using the copy {age}"), fix)
        }
        Err(error) => Check::new("index", Status::Fail, format!("{location} cannot be read ({error}), and no copy is kept"), fix),
    }
}

/// A duration as people read it: `40 s`, `12 min`, `3 h`, `5 days`.
fn duration(age: Duration) -> String {
    let seconds = age.as_secs();
    match seconds {
        0..60 => format!("{seconds} s"),
        60..3600 => format!("{} min", seconds / 60),
        3600..86400 => format!("{} h", seconds / 3600),
        _ => format!("{} days", seconds / 86400),
    }
}

/// Each installed kit in use, started and asked `kit.initialize`, all at once.
fn check_kits(store: &Store) -> Vec<Check> {
    let kits = store.list();
    if kits.is_empty() {
        return vec![Check::new("kits", Status::Info, format!("none installed in {}", store.home().kits().display()), None)];
    }
    let runtime = match kition_kits::runtime() {
        Ok(runtime) => runtime,
        Err(error) => return vec![Check::new("kits", Status::Fail, format!("cannot start the kits: {error}"), None)],
    };
    let ours = kition_cli::protocol();
    runtime.block_on(async {
        let mut asked = Vec::new();
        for kit in &kits {
            let Some(installed) = kit.in_use().cloned() else { continue };
            let name = kit.name.clone();
            let ours = ours.clone();
            asked.push(tokio::spawn(async move {
                let label = format!("kit {name}");
                let fix = Some(format!("kition kit remove {name} && kition kit install {name}   (a kit built here: kition kit add <path>)"));
                let protocol = installed.protocol.clone().unwrap_or_default();
                if protocol != ours {
                    return Check::new(
                        label,
                        Status::Fail,
                        format!("{} speaks `{protocol}`, and this kition speaks {ours}", installed.version),
                        Some(format!("kition kit upgrade {name}")),
                    );
                }
                let mut options = LaunchOptions::new(&installed.executable);
                options.ready_timeout = KIT_TIMEOUT;
                options.initialize_timeout = KIT_TIMEOUT;
                match HeadlessKit::launch(options).await {
                    Ok(kit) => {
                        let (id, version) = (kit.kit_id().to_owned(), kit.kit_version().to_owned());
                        kit.shutdown(Duration::from_secs(2)).await;
                        let expected = format!("kit.{name}");
                        if id == expected && version == installed.version.to_string() {
                            Check::new(label, Status::Ok, format!("{version} answers kit.initialize ({})", installed.executable.display()), None)
                        } else {
                            Check::new(label, Status::Fail, format!("its kit.json is {expected} {}, and it answers {id} {version}", installed.version), fix)
                        }
                    }
                    Err(error) => {
                        Check::new(label, Status::Fail, format!("{} did not start: {error} ({})", installed.version, installed.executable.display()), fix)
                    }
                }
            }));
        }
        let mut checks = Vec::new();
        for handle in asked {
            if let Ok(check) = handle.await {
                checks.push(check);
            }
        }
        checks
    })
}

/// Whether the editor package of each kit in use is installed (`kition gateway` shows it). A
/// missing one is for information: the agent's tools work without it, and the gateway installs
/// it when the kit is first opened.
fn check_editors(store: &Store) -> Vec<Check> {
    let editors = kition_cli::editors::Editors::new(store.clone());
    store
        .list()
        .iter()
        .filter_map(|kit| {
            let installed = kit.in_use()?;
            let label = format!("editor {}", kit.name);
            Some(match editors.find(&kit.name, &installed.version) {
                Some(editor) => Check::new(label, Status::Ok, format!("{} installed ({})", installed.version, editor.root.display()), None),
                None => Check::new(
                    label,
                    Status::Info,
                    format!("{} not installed: kition gateway installs it when the kit is first opened", installed.version),
                    Some(format!("kition kit install {}", kit.name)),
                ),
            })
        })
        .collect()
}

fn check_agent(seen: Registrations) -> Check {
    let label = format!("agent {}", seen.agent.name());
    let title = seen.agent.title();
    if let Some(problem) = seen.problem {
        return Check::new(label, Status::Warn, format!("{title}: {problem}"), None);
    }
    if !seen.found.is_empty() {
        return Check::new(label, Status::Ok, format!("{title}: kition registered: {}", seen.found.join("; ")), None);
    }
    if !seen.present {
        return Check::new(label, Status::Info, format!("{title}: not here (no `{}` on the PATH)", seen.agent.name()), None);
    }
    Check::new(label, Status::Info, format!("{title}: kition is not registered (kition agent add {})", seen.agent.name()), None)
}
