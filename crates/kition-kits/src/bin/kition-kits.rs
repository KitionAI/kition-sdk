//! `kition-kits`: Kition's kits for a host written in any language.
//!
//! `kition-kits serve --workspace <folder>` speaks the Kits Service API (newline-delimited
//! JSON-RPC 2.0 on standard input and output, `kition_kits::serve`): the host opens, edits, saves
//! and previews the workspace's files by path, and this process runs the kits and serves their
//! files over the Kit Process Protocol. Like every form of the Kition SDK, it is free and needs no
//! licence key.

use std::path::PathBuf;
use std::process::ExitCode;

use kition_kits::{KitManager, definitions};

const USAGE: &str = "\
usage:
  kition-kits serve --workspace <folder> [--kit <path>]... [--kits-dir <folder>] [--sandbox]
      serve the Kits Service API on stdin and stdout (newline-delimited JSON-RPC 2.0) until
      stdin closes; see docs/sdk/hosts.md and schemas/kits-service.schema.json

  --sandbox              run every kit process under the platform's sandbox: it reads the system's
                         files and its package, keeps its state in its private folder, and reaches
                         no other file and no network (macOS: sandbox-exec; Linux: Landlock and
                         seccomp). Elsewhere, or on a Linux kernel without Landlock, it refuses to
                         start. Off by default for now; meant to become the default
  --call-timeout-secs <n> maximum time per kit request (default 120; shorter protocol limits apply)
  --idle-timeout-secs <n> save and stop a process with no calls for this long (default 600)
  --memory-limit-mib <n>  optional per-process memory ceiling (Linux/macOS); unsupported platforms
                         refuse it. All three values must be positive integers

kits (a kit is its KHP manifest, `kit.json`, and its headless executable):
  --kit <path>           a kit's headless executable; its kit.json is the nearest one above it
                         that names it (`headless.executable`); one that no kit.json names is
                         asked which kit it is (kit.initialize), and one that is no kit known
                         stops kition-kits with an error; repeatable
  --kits-dir <folder>    a folder with one folder per kit holding its kit.json, and its executable
                         beside it if installed (an SDK bundle's `kits/`)
  KITION_KIT_<KIT>_BINARY  executables named by the environment, as --kit
  bin/<platform>/        for kits without one, the executable their kit.json names in the bundle's
                         bin/<platform>/ beside --kits-dir, beside kition-kits, then on the PATH
";

struct Options {
    workspace: Option<PathBuf>,
    kits: Vec<PathBuf>,
    kits_dir: Option<PathBuf>,
    sandbox: bool,
    limits: kition_kits::control::Limits,
}

fn parse(mut args: impl Iterator<Item = String>) -> Result<Options, String> {
    match args.next().as_deref() {
        Some("serve") => {}
        Some("--help" | "-h") | None => return Err(String::new()),
        Some(other) => return Err(format!("unknown command {other}")),
    }
    let mut options = Options { workspace: None, kits: Vec::new(), kits_dir: None, sandbox: false, limits: kition_kits::control::Limits::default() };
    while let Some(arg) = args.next() {
        let mut value = |name: &str| args.next().ok_or_else(|| format!("{name} needs a value"));
        match arg.as_str() {
            "--workspace" => options.workspace = Some(PathBuf::from(value("--workspace")?)),
            "--kit" => options.kits.push(PathBuf::from(value("--kit")?)),
            "--kits-dir" => options.kits_dir = Some(PathBuf::from(value("--kits-dir")?)),
            "--sandbox" => options.sandbox = true,
            "--call-timeout-secs" | "--idle-timeout-secs" | "--memory-limit-mib" => options.limits.set_flag(&arg, &value(&arg)?)?,
            other => return Err(format!("unknown argument {other}")),
        }
    }
    options.limits.validate()?;
    Ok(options)
}

fn main() -> ExitCode {
    let options = match parse(std::env::args().skip(1)) {
        Ok(options) => options,
        Err(message) if message.is_empty() => {
            print!("{USAGE}");
            return ExitCode::SUCCESS;
        }
        Err(message) => {
            eprintln!("kition-kits: {message}\n\n{USAGE}");
            return ExitCode::from(2);
        }
    };
    let Some(workspace) = options.workspace.clone().filter(|dir| dir.is_dir()) else {
        eprintln!("kition-kits: --workspace must name a folder\n\n{USAGE}");
        return ExitCode::from(2);
    };
    // No fallback: a sandbox that this machine cannot give is a refusal to start, never kits run
    // unconfined.
    if options.sandbox
        && let Err(reason) = kition_kit_host::sandbox::check()
    {
        eprintln!("kition-kits: --sandbox: {reason}");
        return ExitCode::FAILURE;
    }
    let found = match definitions::found(&options.kits, options.kits_dir.as_deref(), options.sandbox, options.limits) {
        Ok(found) => found,
        Err(message) => {
            eprintln!("kition-kits: {message}");
            return ExitCode::from(2);
        }
    };
    for reason in found.iter().filter_map(definitions::missing) {
        eprintln!("kition-kits: {reason}");
    }
    let runtime = match kition_kits::runtime() {
        Ok(runtime) => runtime,
        Err(error) => {
            eprintln!("kition-kits: {error}");
            return ExitCode::FAILURE;
        }
    };
    let kits = match KitManager::new(Some(workspace), found).with_limits(options.limits) {
        Ok(kits) => kits,
        Err(reason) => {
            eprintln!("kition-kits: {reason}");
            return ExitCode::FAILURE;
        }
    };
    let kits = if options.sandbox { kits.with_sandbox() } else { kits };
    match runtime.block_on(kition_kits::serve::serve(kits, tokio::io::stdin(), tokio::io::stdout())) {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("kition-kits: {error}");
            ExitCode::FAILURE
        }
    }
}
