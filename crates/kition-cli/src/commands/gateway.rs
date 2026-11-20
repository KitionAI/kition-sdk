//! `kition gateway --workspace <folder>`: one workspace's kits served on loopback HTTP, by the
//! one process that holds them (`kition_kits_http::gateway`): the Kit AI bridge to open kit
//! editors, workspace files for them, file grants, the agent's drafts for review, and the kits'
//! MCP server, to which `kition mcp` for the same workspace relays (`relay.rs`).
//!
//! It binds 127.0.0.1 only, on `--port` (default 0: a port the system picks), makes a token for
//! this launch, writes its lockfile (`gateway.rs`), and prints one ready line on stdout:
//!
//! ```json
//! {"kition":"gateway-ready","protocol":"kition-gateway/1","version":"0.5.2","pid":4242,
//!  "port":51234,"url":"http://127.0.0.1:51234","apiPrefix":"/api/v1",
//!  "workspace":"/abs/canonical/folder","lockfile":"/home/.kition/run/<key>.json"}
//! ```
//!
//! The token is not on stdout, which supervisors and terminals tend to keep: whoever may use the
//! gateway reads it from the lockfile, which only this account can read. A gateway already
//! serving the workspace makes a second one print `{"kition":"gateway-running", ...}` (the same
//! fields, the running one's) and exit with status 3; a lockfile whose gateway is gone is
//! replaced. It stops on SIGINT, SIGTERM or SIGHUP, when stdin closes with `--stdin-lifetime`,
//! and after `--idle-timeout <seconds>` with no request and no editor attached; it then saves and
//! stops its kits and removes its lockfile.

use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use kition_cli::gateway::{self, LOCKFILE_FORMAT, Lockfile};
use kition_cli::home::Home;
use kition_kits_http::gateway::{API_PREFIX, Activity, PROTOCOL};
use serde_json::{Value, json};

use super::help;

/// The exit status when a gateway already serves the workspace.
pub const ALREADY_RUNNING: u8 = 3;

/// What the gateway takes itself; the rest are the kit options `kition mcp` takes.
#[derive(Debug)]
struct Options {
    workspace: Option<PathBuf>,
    port: u16,
    stdin_lifetime: bool,
    idle: Option<Duration>,
    rest: Vec<String>,
}

fn parse(args: Vec<String>) -> Result<Options, String> {
    let mut options = Options { workspace: None, port: 0, stdin_lifetime: false, idle: None, rest: Vec::new() };
    let mut args = args.into_iter();
    while let Some(arg) = args.next() {
        let (name, inline) = match arg.split_once('=') {
            Some((name, value)) if arg.starts_with("--") => (name.to_owned(), Some(value.to_owned())),
            _ => (arg.clone(), None),
        };
        let mut value = |what: &str| inline.clone().or_else(|| args.next()).filter(|value| !value.is_empty()).ok_or_else(|| format!("{name} needs {what}"));
        match name.as_str() {
            "--workspace" => options.workspace = Some(PathBuf::from(value("a folder")?)),
            "--port" => options.port = value("a port number")?.parse().map_err(|_| "--port is a port number, 0 to 65535 (0: any free port)".to_owned())?,
            "--stdin-lifetime" if inline.is_none() => options.stdin_lifetime = true,
            "--idle-timeout" => {
                let seconds: u64 =
                    value("a number of seconds")?.parse().ok().filter(|seconds| *seconds > 0).ok_or("--idle-timeout is a positive number of seconds")?;
                options.idle = Some(Duration::from_secs(seconds));
            }
            "drafts" | "--schemas" | "--list-kits" => return Err(format!("{arg} is kition mcp's, not the gateway's")),
            _ => options.rest.push(arg),
        }
    }
    Ok(options)
}

fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |since| since.as_secs())
}

/// The ready line's fields (and the running line's) for `lock` at `path`.
fn announcement(kind: &str, lock: &Lockfile, path: &Path) -> Value {
    json!({
        "kition": kind,
        "protocol": lock.protocol,
        "version": lock.version,
        "pid": lock.pid,
        "port": lock.port,
        "url": lock.url,
        "apiPrefix": lock.api_prefix,
        "workspace": lock.workspace,
        "lockfile": path.display().to_string(),
    })
}

/// Says that `lock`'s gateway serves the workspace already; exit status 3.
fn already_running(lock: &Lockfile, path: &Path) -> ExitCode {
    println!("{}", announcement("gateway-running", lock, path));
    eprintln!("kition gateway: a gateway already serves {} (pid {}, {}); stop it first, or use it", lock.workspace, lock.pid, lock.url);
    ExitCode::from(ALREADY_RUNNING)
}

pub fn run(args: Vec<String>, store: kition_kits::cli::mcp::Store) -> ExitCode {
    if super::asks_help(&args) {
        return help::print(&["gateway"]);
    }
    let options = match parse(args) {
        Ok(options) => options,
        Err(message) => return help::mistake(&["gateway"], message),
    };
    let Some(workspace) = options.workspace.clone() else {
        return help::mistake(&["gateway"], "--workspace names the folder it serves");
    };
    let Ok(canonical) = std::fs::canonicalize(&workspace).map_err(|_| ()).and_then(|path| if path.is_dir() { Ok(path) } else { Err(()) }) else {
        return help::mistake(&["gateway"], format!("--workspace must name a folder: {}", workspace.display()));
    };
    let home = match Home::from_env() {
        Ok(home) => home,
        Err(message) => {
            eprintln!("kition gateway: {message}");
            return ExitCode::FAILURE;
        }
    };
    let path = gateway::lockfile_path(&home, &canonical);
    if let Some(lock) = gateway::read(&path) {
        if gateway::identity(&lock).is_some() {
            return already_running(&lock, &path);
        }
        // Its gateway is gone: the lockfile is stale.
        gateway::remove_if_ours(&path, &lock);
    }
    let mut rest = options.rest.clone();
    rest.extend(["--workspace".to_owned(), canonical.display().to_string()]);
    let prepared = match kition_kits::cli::mcp::prepare("kition gateway", rest.into_iter(), Some(store)) {
        Ok(prepared) => prepared,
        Err(code) => return code,
    };
    let runtime = match kition_kits::runtime() {
        Ok(runtime) => runtime,
        Err(error) => {
            eprintln!("kition gateway: {error}");
            return ExitCode::FAILURE;
        }
    };
    let code = runtime.block_on(serve(prepared, options, canonical, path));
    runtime.shutdown_timeout(Duration::from_secs(1));
    code
}

async fn serve(prepared: kition_kits::cli::mcp::Prepared, options: Options, canonical: PathBuf, path: PathBuf) -> ExitCode {
    let listener = match tokio::net::TcpListener::bind(("127.0.0.1", options.port)).await {
        Ok(listener) => listener,
        Err(error) => {
            eprintln!("kition gateway: cannot listen on 127.0.0.1:{}: {error}", options.port);
            return ExitCode::FAILURE;
        }
    };
    let port = match listener.local_addr() {
        Ok(address) => address.port(),
        Err(error) => {
            eprintln!("kition gateway: {error}");
            return ExitCode::FAILURE;
        }
    };
    let token = kition_http_guard::gate::new_token();
    let lock = Lockfile {
        format: LOCKFILE_FORMAT,
        protocol: PROTOCOL.to_owned(),
        version: kition_cli::VERSION.to_owned(),
        pid: std::process::id(),
        port,
        url: format!("http://127.0.0.1:{port}"),
        api_prefix: API_PREFIX.to_owned(),
        token: token.clone(),
        workspace: canonical.display().to_string(),
        unified: prepared.unified,
        started: now(),
    };
    match gateway::write_new(&path, &lock) {
        Ok(true) => {}
        Ok(false) => {
            // Another gateway took the workspace while this one started.
            if let Some(other) = gateway::read(&path) {
                return already_running(&other, &path);
            }
            eprintln!("kition gateway: another gateway is starting for {}", canonical.display());
            return ExitCode::from(ALREADY_RUNNING);
        }
        Err(error) => {
            eprintln!("kition gateway: cannot write {}: {error}", path.display());
            return ExitCode::FAILURE;
        }
    }
    let gate = match kition_kits_http::gateway::gate(&token) {
        Ok(gate) => gate,
        Err(error) => {
            gateway::remove_if_ours(&path, &lock);
            eprintln!("kition gateway: {error}");
            return ExitCode::FAILURE;
        }
    };
    let identity = json!({
        "protocol": PROTOCOL,
        "version": kition_cli::VERSION,
        "pid": lock.pid,
        "workspace": lock.workspace,
        "unified": lock.unified,
        "started": lock.started,
    });
    let activity = Activity::default();
    let kits = prepared.kits.clone();
    let app = kition_kits_http::gateway::app(kits.clone(), gate, identity, activity.clone());
    println!("{}", announcement("gateway-ready", &lock, &path));
    let _ = std::io::Write::flush(&mut std::io::stdout());
    eprintln!("kition gateway: serving {} at {} (pid {})", lock.workspace, lock.url, lock.pid);

    let (stop, stopped) = tokio::sync::watch::channel(false);
    let reason = tokio::spawn(stop_reason(options.stdin_lifetime, options.idle, activity, kits.clone()));
    let server = tokio::spawn({
        let mut stopped = stopped.clone();
        async move {
            axum::serve(listener, app)
                .with_graceful_shutdown(async move {
                    let _ = stopped.wait_for(|stop| *stop).await;
                })
                .await
        }
    });
    let why = reason.await.unwrap_or("stopping");
    eprintln!("kition gateway: {why}: stopping");
    let _ = stop.send(true);
    // Open bridge streams never end on their own: give answers in flight a moment, no more.
    let _ = tokio::time::timeout(Duration::from_secs(5), server).await;
    kits.shutdown().await;
    gateway::remove_if_ours(&path, &lock);
    ExitCode::SUCCESS
}

/// Waits for a reason to stop: a signal, stdin closing (`--stdin-lifetime`), or being idle.
async fn stop_reason(stdin_lifetime: bool, idle: Option<Duration>, activity: Activity, kits: kition_kits::KitManager) -> &'static str {
    let stdin = async {
        if !stdin_lifetime {
            return std::future::pending::<()>().await;
        }
        let mut stdin = tokio::io::stdin();
        let mut sink = tokio::io::sink();
        let _ = tokio::io::copy(&mut stdin, &mut sink).await;
    };
    let idle = async {
        let Some(idle) = idle else { return std::future::pending::<()>().await };
        loop {
            tokio::time::sleep(Duration::from_secs(1).min(idle)).await;
            if activity.idle_for() >= idle && !kits.bridge().connected() {
                return;
            }
        }
    };
    tokio::select! {
        signal = signal() => signal,
        () = stdin => "stdin closed",
        () = idle => "idle",
    }
}

#[cfg(unix)]
async fn signal() -> &'static str {
    use tokio::signal::unix::{SignalKind, signal};
    let (Ok(mut interrupt), Ok(mut terminate), Ok(mut hangup)) =
        (signal(SignalKind::interrupt()), signal(SignalKind::terminate()), signal(SignalKind::hangup()))
    else {
        return std::future::pending().await;
    };
    tokio::select! {
        _ = interrupt.recv() => "SIGINT",
        _ = terminate.recv() => "SIGTERM",
        _ = hangup.recv() => "SIGHUP",
    }
}

#[cfg(not(unix))]
async fn signal() -> &'static str {
    let _ = tokio::signal::ctrl_c().await;
    "interrupted"
}

#[cfg(test)]
mod tests {
    use super::*;

    fn strings(words: &[&str]) -> Vec<String> {
        words.iter().map(|word| (*word).to_owned()).collect()
    }

    #[test]
    fn reads_its_own_options_and_passes_the_kit_options_on() {
        let options = parse(strings(&["--workspace", "/w", "--port=8123", "--stdin-lifetime", "--idle-timeout", "60", "--unified", "--kit", "/k"])).unwrap();
        assert_eq!(options.workspace.as_deref(), Some(Path::new("/w")));
        assert_eq!((options.port, options.stdin_lifetime, options.idle), (8123, true, Some(Duration::from_secs(60))));
        assert_eq!(options.rest, ["--unified", "--kit", "/k"]);
        assert!(parse(strings(&["--port", "70000"])).is_err());
        assert!(parse(strings(&["--idle-timeout", "0"])).is_err());
        assert!(parse(strings(&["drafts", "list"])).unwrap_err().contains("kition mcp's"));
    }
}
