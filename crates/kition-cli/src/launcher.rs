//! How this `kition` was started, and the command that starts it again: what `kition agent add`
//! registers with an agent and what `kition doctor` looks for on the PATH.
//!
//! Run directly (installed by `install.sh`, or a build), that command is this executable's own
//! path. Started by the npm package `@kition/cli`, a Node launcher, the executable lives inside
//! `node_modules`, and for `npx` inside npm's cache, which npm may clear. The launcher says how it
//! was started in `KITION_LAUNCHER`, a JSON object (packages/kition/src/resolve.ts):
//!
//! ```json
//! { "via": "npx", "command": ["npx", "-y", "@kition/cli"], "executable": "/…/@kition/cli-darwin-arm64/bin/kition" }
//! { "via": "npm", "command": ["/opt/homebrew/bin/kition"], "executable": "/…/bin/kition" }
//! ```
//!
//! `command` starts this kition again, its arguments to follow: `npx -y @kition/cli`, or npm's
//! `kition` command (the global one, `<prefix>/bin/kition` or `<prefix>\kition.cmd`, or a
//! project's `node_modules/.bin/kition`). `executable` is the program the launcher started: the
//! variable is taken only when that is this executable, so a value inherited by another kition is
//! ignored.

use std::path::{Path, PathBuf};

use serde::Deserialize;

/// The environment variable the npm launcher sets (sdk.json `binaries.cli.launcher`).
pub const LAUNCHER_VARIABLE: &str = "KITION_LAUNCHER";

/// How this kition was started.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Started {
    /// Directly, from its own path.
    Itself(PathBuf),
    /// Through npx, from npm's cache: `command` is `npx -y @kition/cli`.
    Npx { command: Vec<String> },
    /// Through npm's `kition` command, global or a project's.
    Npm { command: PathBuf },
}

#[derive(Deserialize)]
struct Launcher {
    via: String,
    command: Vec<String>,
    executable: PathBuf,
}

/// Whether two paths name the same file.
fn same_file(a: &Path, b: &Path) -> bool {
    match (std::fs::canonicalize(a), std::fs::canonicalize(b)) {
        (Ok(a), Ok(b)) => a == b,
        _ => a == b,
    }
}

impl Started {
    /// This process: `KITION_LAUNCHER` read against its own executable.
    pub fn detect() -> Result<Self, String> {
        let exe = std::env::current_exe().map_err(|error| format!("cannot tell where this kition is: {error}"))?;
        let exe = std::path::absolute(&exe).unwrap_or(exe);
        Ok(Self::from_launcher(std::env::var(LAUNCHER_VARIABLE).ok().as_deref(), &exe))
    }

    /// How the kition at `exe` was started, given `KITION_LAUNCHER`'s value. A value that is not
    /// the launcher's JSON, or that names another executable, is not taken: `exe` was started
    /// itself.
    pub fn from_launcher(value: Option<&str>, exe: &Path) -> Self {
        let itself = || Self::Itself(exe.to_path_buf());
        let Some(launcher) = value.and_then(|value| serde_json::from_str::<Launcher>(value).ok()) else { return itself() };
        if !same_file(&launcher.executable, exe) || launcher.command.iter().any(String::is_empty) {
            return itself();
        }
        match (launcher.via.as_str(), launcher.command.as_slice()) {
            ("npx", [program, ..]) if program == "npx" => Self::Npx { command: launcher.command },
            ("npm", [command]) if Path::new(command).is_absolute() => Self::Npm { command: PathBuf::from(command) },
            _ => itself(),
        }
    }

    /// The command that starts this kition again (its arguments follow), as an agent is to run it:
    /// the program and its first arguments. On Windows, `npx` and npm's `kition.cmd` are batch
    /// files, which a program cannot start by itself, so they go through `cmd /c`.
    pub fn command(&self, windows: bool) -> (String, Vec<String>) {
        let words: Vec<String> = match self {
            Self::Itself(exe) => return (exe.display().to_string(), Vec::new()),
            Self::Npx { command } => command.clone(),
            Self::Npm { command } => vec![command.display().to_string()],
        };
        let batch = |program: &str| {
            let lower = program.to_ascii_lowercase();
            lower == "npx" || lower.ends_with(".cmd") || lower.ends_with(".bat")
        };
        if windows && batch(&words[0]) {
            return ("cmd".to_owned(), ["/c".to_owned()].into_iter().chain(words).collect());
        }
        let mut words = words.into_iter();
        let program = words.next().unwrap_or_default();
        (program, words.collect())
    }

    /// Whether npm's `kition` command is a project's (`node_modules/.bin/kition`), not the global one.
    pub fn is_project_command(command: &Path) -> bool {
        let mut names = command.components().rev().skip(1).map(|part| part.as_os_str().to_string_lossy().into_owned());
        names.next().as_deref() == Some(".bin") && names.next().as_deref() == Some("node_modules")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn launcher(via: &str, command: &[&str], executable: &Path) -> String {
        serde_json::json!({ "via": via, "command": command, "executable": executable }).to_string()
    }

    #[test]
    fn takes_the_launchers_word_only_for_this_executable() {
        let dir = tempfile::tempdir().unwrap();
        let exe = dir.path().join("kition");
        std::fs::write(&exe, "").unwrap();
        let other = dir.path().join("other-kition");
        std::fs::write(&other, "").unwrap();

        assert_eq!(Started::from_launcher(None, &exe), Started::Itself(exe.clone()));
        assert_eq!(Started::from_launcher(Some("not json"), &exe), Started::Itself(exe.clone()));
        let npx = launcher("npx", &["npx", "-y", "@kition/cli"], &exe);
        assert_eq!(Started::from_launcher(Some(&npx), &exe), Started::Npx { command: vec!["npx".into(), "-y".into(), "@kition/cli".into()] });
        assert_eq!(Started::from_launcher(Some(&npx), &other), Started::Itself(other.clone()), "inherited by another kition");
        let shim = dir.path().join("bin").join("kition");
        let npm = launcher("npm", &[&shim.display().to_string()], &exe);
        assert_eq!(Started::from_launcher(Some(&npm), &exe), Started::Npm { command: shim.clone() });
        assert_eq!(Started::from_launcher(Some(&launcher("npm", &["kition"], &exe)), &exe), Started::Itself(exe.clone()), "a relative command");
        assert_eq!(Started::from_launcher(Some(&launcher("yarn", &["yarn", "kition"], &exe)), &exe), Started::Itself(exe.clone()));
    }

    #[test]
    fn the_command_goes_through_cmd_on_windows_for_batch_files() {
        let npx = Started::Npx { command: vec!["npx".into(), "-y".into(), "@kition/cli".into()] };
        assert_eq!(npx.command(false), ("npx".to_owned(), vec!["-y".to_owned(), "@kition/cli".to_owned()]));
        assert_eq!(npx.command(true), ("cmd".to_owned(), vec!["/c".to_owned(), "npx".to_owned(), "-y".to_owned(), "@kition/cli".to_owned()]));
        let global = Started::Npm { command: PathBuf::from("/opt/npm/bin/kition") };
        assert_eq!(global.command(false), ("/opt/npm/bin/kition".to_owned(), Vec::new()));
        let windows = Started::Npm { command: PathBuf::from(r"C:\Users\me\AppData\Roaming\npm\kition.cmd") };
        assert_eq!(windows.command(true).0, "cmd");
        assert_eq!(windows.command(true).1, vec!["/c".to_owned(), r"C:\Users\me\AppData\Roaming\npm\kition.cmd".to_owned()]);
        let itself = Started::Itself(PathBuf::from("/home/me/.kition/bin/kition"));
        assert_eq!(itself.command(true), ("/home/me/.kition/bin/kition".to_owned(), Vec::new()));
    }

    #[test]
    fn tells_a_projects_command_from_the_global_one() {
        assert!(Started::is_project_command(Path::new("/work/app/node_modules/.bin/kition")));
        assert!(!Started::is_project_command(Path::new("/opt/npm/bin/kition")));
    }
}
