//! `kit-env`: a kit as a training and evaluation environment (`kition_env`, `docs/sdk/env.md`).
//!
//! Tasks and traces are JSON lines on standard output; what went wrong is on standard error.
//! Exit codes: 0 done, 1 failed (a kit or a file), 2 wrong usage.

use std::io::Read as _;
use std::path::PathBuf;
use std::process::ExitCode;

use kition_env::{EnvKit, GenerateOptions, OracleOptions, ScoreOptions, Task};
use kition_kits::definitions;

const USAGE: &str = "\
usage:
  kit-env generate --workspace <dir> --kit <id or extension> --seed <n> --count <n> [--inverse-share <0..1>]
                   [--kinds <kind>[,<kind>]...] [kits]
      editing tasks with ground truth from the workspace's files, one JSON object a line
  kit-env score --task <file|-> --before <file> --after <file> [--exact] [kits]
      the reward of an attempt that turned <before> into <after> (the task's file), as JSON
  kit-env trace --tasks <tasks.jsonl> --workspace <dir> [--find] [kits]
      the oracle's traces of the tasks that earn reward 1, one JSON object a line
  kit-env stats --tasks <tasks.jsonl>
      tasks per kind and the edits resampled before them, by reason, as JSON

kits (a kit is its KHP manifest, `kit.json`, and its headless executable; as kition-kits):
  --executable <path>     a kit's headless executable; repeatable
  --kits-dir <folder>     a folder with one folder per kit holding its kit.json and executable
  KITION_KIT_<KIT>_BINARY executables named by the environment

edit kinds: set-field, replace-text, delete, move, create
";

#[derive(Default)]
struct Options {
    command: String,
    workspace: Option<PathBuf>,
    kit: Option<String>,
    seed: u64,
    count: usize,
    inverse_share: f64,
    kinds: Option<Vec<String>>,
    task: Option<String>,
    tasks: Option<PathBuf>,
    before: Option<PathBuf>,
    after: Option<PathBuf>,
    exact: bool,
    find: bool,
    executables: Vec<PathBuf>,
    kits_dir: Option<PathBuf>,
}

fn number<T: std::str::FromStr>(name: &str, value: &str) -> Result<T, String> {
    value.parse().map_err(|_| format!("{name} takes a number, not `{value}`"))
}

fn absolute(path: String) -> PathBuf {
    std::path::absolute(&path).unwrap_or_else(|_| PathBuf::from(path))
}

fn parse(mut args: impl Iterator<Item = String>) -> Result<Options, String> {
    let command = match args.next() {
        Some(command) if ["generate", "score", "trace", "stats"].contains(&command.as_str()) => command,
        Some(help) if help == "--help" || help == "-h" => return Err(String::new()),
        None => return Err(String::new()),
        Some(other) => return Err(format!("unknown command {other}")),
    };
    let mut options = Options { command, count: 10, inverse_share: 0.3, ..Options::default() };
    while let Some(arg) = args.next() {
        let mut value = |name: &str| args.next().ok_or_else(|| format!("{name} needs a value"));
        match arg.as_str() {
            "--workspace" => options.workspace = Some(PathBuf::from(value("--workspace")?)),
            "--kit" => options.kit = Some(value("--kit")?),
            "--seed" => options.seed = number("--seed", &value("--seed")?)?,
            "--count" => options.count = number("--count", &value("--count")?)?,
            "--inverse-share" => {
                options.inverse_share = number("--inverse-share", &value("--inverse-share")?)?;
                if !(0.0..=1.0).contains(&options.inverse_share) {
                    return Err("--inverse-share is between 0 and 1".to_owned());
                }
            }
            "--kinds" => {
                let kinds: Vec<String> = value("--kinds")?.split(',').map(|kind| kind.trim().to_owned()).collect();
                if let Some(unknown) = kinds.iter().find(|kind| !kition_env::EDIT_KINDS.contains(&kind.as_str())) {
                    return Err(format!("unknown edit kind {unknown}"));
                }
                options.kinds = Some(kinds);
            }
            "--task" => options.task = Some(value("--task")?),
            "--tasks" => options.tasks = Some(PathBuf::from(value("--tasks")?)),
            "--before" => options.before = Some(PathBuf::from(value("--before")?)),
            "--after" => options.after = Some(PathBuf::from(value("--after")?)),
            "--exact" => options.exact = true,
            "--find" => options.find = true,
            // Absolute, as the kit is started from a folder of its own.
            "--executable" => options.executables.push(absolute(value("--executable")?)),
            "--kits-dir" => options.kits_dir = Some(absolute(value("--kits-dir")?)),
            other => return Err(format!("unknown argument {other}")),
        }
    }
    let needs = |present: bool, name: &str| if present { Ok(()) } else { Err(format!("{} needs {name}", options.command)) };
    match options.command.as_str() {
        "generate" => {
            needs(options.workspace.is_some(), "--workspace <dir>")?;
            needs(options.kit.is_some(), "--kit <id or extension>")?;
        }
        "score" => {
            needs(options.task.is_some(), "--task <file|->")?;
            needs(options.before.is_some() && options.after.is_some(), "--before <file> and --after <file>")?;
        }
        "trace" => {
            needs(options.tasks.is_some(), "--tasks <tasks.jsonl>")?;
            needs(options.workspace.is_some(), "--workspace <dir>")?;
        }
        _ => needs(options.tasks.is_some(), "--tasks <tasks.jsonl>")?,
    }
    Ok(options)
}

/// A failure: `Usage` exits 2 with the usage, `Failed` exits 1.
enum Failure {
    Usage(String),
    Failed(String),
}

impl From<kition_env::EnvError> for Failure {
    fn from(error: kition_env::EnvError) -> Self {
        Self::Failed(error.0)
    }
}

/// The kit `wanted` names (its id, or an extension it edits) among those the options declare.
fn kit(options: &Options, wanted: &str) -> Result<EnvKit, Failure> {
    let found =
        definitions::found(&options.executables, options.kits_dir.as_deref(), false, kition_kits::control::Limits::default()).map_err(Failure::Usage)?;
    let extension = wanted.trim_start_matches('.').to_ascii_lowercase();
    let known: Vec<&str> = found.iter().map(|(kit, _)| kit.id).collect();
    let (definition, executable) =
        found.iter().find(|(kit, _)| kit.id == wanted || kit.extensions.contains(&extension.as_str())).cloned().ok_or_else(|| {
            Failure::Usage(format!("no kit {wanted} among the kits given ({})", if known.is_empty() { "none".to_owned() } else { known.join(", ") }))
        })?;
    if let Some(reason) = definitions::missing(&(definition, executable.clone())) {
        return Err(Failure::Failed(reason));
    }
    Ok(EnvKit::new(definition, executable))
}

fn read_tasks(path: &PathBuf) -> Result<Vec<Task>, Failure> {
    let text = std::fs::read_to_string(path).map_err(|err| Failure::Failed(format!("{}: {err}", path.display())))?;
    Task::parse_lines(&text).map_err(|err| Failure::Failed(format!("{}: {err}", path.display())))
}

async fn run(options: Options) -> Result<(), Failure> {
    match options.command.as_str() {
        "generate" => {
            let workspace = options.workspace.clone().unwrap_or_default();
            if !workspace.is_dir() {
                return Err(Failure::Usage("--workspace must name a folder".to_owned()));
            }
            let kit = kit(&options, options.kit.as_deref().unwrap_or_default())?;
            let generate = GenerateOptions {
                seed: options.seed,
                count: options.count,
                inverse_share: options.inverse_share,
                kinds: options.kinds.clone(),
                ..GenerateOptions::default()
            };
            let generated = kition_env::generate(&kit, &workspace, &generate).await?;
            for task in &generated.tasks {
                println!("{}", task.to_line());
            }
            let stats = kition_env::stats(&generated.tasks);
            for skipped in &generated.skipped {
                eprintln!("kit-env: skipped source {skipped}");
            }
            eprintln!(
                "kit-env: {} tasks ({} given up); resampled {}; objects not sampled {}",
                generated.tasks.len(),
                generated.given_up.len(),
                stats["resampled"],
                serde_json::to_string(&generated.excluded).unwrap_or_default()
            );
            for given_up in &generated.given_up {
                eprintln!("kit-env: gave up task {given_up}");
            }
        }
        "score" => {
            let given = options.task.clone().unwrap_or_default();
            let text = if given == "-" {
                let mut text = String::new();
                std::io::stdin().read_to_string(&mut text).map_err(|err| Failure::Failed(format!("standard input: {err}")))?;
                text
            } else {
                std::fs::read_to_string(&given).map_err(|err| Failure::Failed(format!("{given}: {err}")))?
            };
            let mut tasks = Task::parse_lines(&text)?;
            if tasks.len() != 1 {
                return Err(Failure::Usage(format!("--task holds {} tasks; give one", tasks.len())));
            }
            let task = tasks.remove(0);
            let kit = kit(&options, &task.kit)?;
            let read = |path: &Option<PathBuf>| {
                let path = path.clone().unwrap_or_default();
                std::fs::read(&path).map_err(|err| Failure::Failed(format!("{}: {err}", path.display())))
            };
            let (before, after) = (read(&options.before)?, read(&options.after)?);
            let reward = kition_env::score_files(&kit, &task, &before, &after, &ScoreOptions { exact_text: options.exact }).await?;
            println!("{}", reward.to_json());
        }
        "trace" => {
            let tasks = read_tasks(options.tasks.as_ref().unwrap_or(&PathBuf::new()))?;
            let workspace = options.workspace.clone().unwrap_or_default();
            let mut written = 0;
            for task in &tasks {
                let kit = kit(&options, &task.kit)?;
                let lines = kition_env::verified_traces(&kit, &workspace, std::slice::from_ref(task), OracleOptions { find: options.find }).await?;
                written += lines.len();
                for line in lines {
                    println!("{line}");
                }
            }
            eprintln!("kit-env: {written} of {} traces earned reward 1", tasks.len());
        }
        _ => {
            let tasks = read_tasks(options.tasks.as_ref().unwrap_or(&PathBuf::new()))?;
            println!("{}", kition_env::stats(&tasks));
        }
    }
    Ok(())
}

fn main() -> ExitCode {
    let options = match parse(std::env::args().skip(1)) {
        Ok(options) => options,
        Err(message) if message.is_empty() => {
            print!("{USAGE}");
            return ExitCode::SUCCESS;
        }
        Err(message) => {
            eprintln!("kit-env: {message}\n\n{USAGE}");
            return ExitCode::from(2);
        }
    };
    let runtime = match tokio::runtime::Builder::new_multi_thread().enable_all().build() {
        Ok(runtime) => runtime,
        Err(error) => {
            eprintln!("kit-env: {error}");
            return ExitCode::FAILURE;
        }
    };
    match runtime.block_on(run(options)) {
        Ok(()) => ExitCode::SUCCESS,
        Err(Failure::Usage(message)) => {
            eprintln!("kit-env: {message}\n\n{USAGE}");
            ExitCode::from(2)
        }
        Err(Failure::Failed(message)) => {
            eprintln!("kit-env: {message}");
            ExitCode::FAILURE
        }
    }
}
