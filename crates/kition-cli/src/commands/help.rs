//! The usage of `kition` and of each of its commands, and what a mistake answers: the closest
//! known command and where its usage is, never the whole usage.

use std::process::ExitCode;

pub const USAGE: &str = "\
kition: Kition's kits for AI agents and programs, installed on demand

usage: kition <command> [options]    (kition <command> --help for one command)

kits:
  kition kit list [--json]                 the kits in the index and those installed
  kition kit install <kit>[@<version>]...  install kits; --all installs every kit for here
  kition kit upgrade [<kit>]               move a kit, or every kit not pinned, to its newest
  kition kit remove <kit>...               remove every version of kits
  kition kit info <kit> [--json]           a kit's versions, files, protocol and agent tools
  kition kit add <path>                    put a kit built or copied here into the store
  kition kit pack <kit> [--out <folder>]   write the kit in use as an archive for kit add

agents:
  kition agent add <claude|codex|cursor>   register kition mcp as the agent's MCP server kition
  kition agent remove <agent>              remove that registration
  kition agent list                        the agents that have kition registered

servers:
  kition mcp [--workspace <folder>]        the kits' MCP server on stdio (default: this folder)
  kition serve --workspace <folder>        the Kits Service API on stdio

troubleshooting:
  kition doctor [--json]                   check kition, its home, PATH, index, kits and agents
  kition --version | --help

environment:
  KITION_HOME    where kits are kept (default ~/.kition): kits/<kit>/<version>/
  KITION_INDEX   the kit index: an https address or a file (default the SDK's kit index, gathered
                 from every kit's releases:
                 https://raw.githubusercontent.com/KitionAI/kition-sdk/kits-index/kits-index.json)
  HTTPS_PROXY, HTTP_PROXY, ALL_PROXY, NO_PROXY   proxies for downloads
";

pub const KIT: &str = "\
usage: kition kit <command> [options]

  list [--json]                 the kits in the index and those installed, with the version in
                                use and the newest
  install <kit>[@<version>]...  install kits (the newest this kition can run); with a version,
                                install that one and keep using it (pinned)
  install --all                 install every kit in the index that this machine can run
  upgrade [<kit>]               move a kit, or every kit not pinned, to the newest version, and
                                remove the older ones
  remove <kit>...               remove every version of kits
  info <kit> [--json]           a kit's versions, files, folder, protocol and agent tools
  add <path>                    put a kit built or copied here into the store
  pack <kit> [--out <folder>]   write the version in use as an archive that kit add takes

  <kit> is the short name (note) or the kit id (kit.note).
  --index <address or file>     the kit index to read instead of KITION_INDEX or the default
                                (list, install, upgrade, info)

kition kit <command> --help for one command.
";

const KIT_LIST: &str = "\
usage: kition kit list [--json] [--index <address or file>]

The kits in the index and those installed: the version in use, `(pinned)` when it was asked for
by number, `(upgrade)` when the index has a newer one this kition can run, and the files each
opens. When the index cannot be read, it says so on stderr and lists the installed kits.

  --json    the same as JSON: home, platform, index (location, read, stale or error) and kits
";

const KIT_INSTALL: &str = "\
usage: kition kit install <kit>[@<version>]... [--index <address or file>]
       kition kit install --all [--index <address or file>]

Installs each kit named: the newest version this kition can run, used from then on; with
@<version>, that version, pinned (kit upgrade without a kit leaves it alone). --all installs every
kit the index has a build of for this machine. A kit that fails does not stop the others; the
exit status is 1 when any failed. On a terminal, each download shows its progress on stderr.
";

const KIT_UPGRADE: &str = "\
usage: kition kit upgrade [<kit>] [--index <address or file>]

Moves the kit, or every installed kit not pinned, to the newest version this kition can run, and
removes the older versions. Naming a pinned kit unpins it.
";

const KIT_REMOVE: &str = "\
usage: kition kit remove <kit>...

Removes every version of each kit named. A kit that fails does not stop the others; the exit
status is 1 when any failed.
";

const KIT_INFO: &str = "\
usage: kition kit info <kit> [--json] [--index <address or file>]

A kit's id, name and files; the versions installed, in use, pinned and in the index; the folder
and executable in use and the protocol it speaks; and the agent tools its kit.json declares.
";

const KIT_ADD: &str = "\
usage: kition kit add <path>

Puts a kit built or copied here into the store, with the checks of an install from the index
(id, version, protocol, executable) and the same one-rename move. <path> is one of:
  - a kit archive: a .tar.gz with kit.json and the executable at its top (what kit pack writes)
  - a folder holding kit.json and the executable it names (headless.executable)
  - a kit executable: its kit.json is the nearest one above it naming it, as --kit finds it
A version installed already stays as it is: remove the kit first to replace it.
";

const KIT_PACK: &str = "\
usage: kition kit pack <kit> [--out <folder>]

Writes the version of the kit in use as kition-<kit>-<version>-<platform>.tar.gz in --out (default
the current folder): kit.json and the executable at its top, as the index's archives. kition kit
add <file> on another machine of the same platform installs it, with no network.
";

pub const AGENT: &str = "\
usage: kition agent <command> [options]

  add <claude|codex|cursor> [--workspace <folder>] [--scope user|project]
                    register kition mcp as the agent's MCP server named kition
  remove <agent> [--workspace <folder>] [--scope user|project]
                    remove that registration
  list              the agents that have kition registered, and where

kition agent <command> --help for one command.
";

const AGENT_ADD: &str = "\
usage: kition agent add <claude|codex|cursor> [--workspace <folder>] [--scope user|project]

Registers this kition as the MCP server named kition, and prints what it ran or wrote. Running it
again replaces the registration. The agent runs this kition by its absolute path, so it finds it
off the PATH; installed with npm, by npm's kition command (npm install -g @kition/cli), or as
npx -y @kition/cli (run through npx), which outlive npm's cache and upgrades.

  --scope project   (default for claude and cursor) for one folder: --workspace, else the current
                    folder, which is also the folder the server edits. Claude Code: its local
                    scope there (claude mcp add -s local); Cursor: <folder>/.cursor/mcp.json
  --scope user      for every folder. Claude Code: claude mcp add -s user; Codex (user only):
                    codex mcp add; Cursor: ~/.cursor/mcp.json. Without --workspace the server
                    edits the folder the agent works in
  --workspace       the folder the server edits, always
";

const AGENT_REMOVE: &str = "\
usage: kition agent remove <claude|codex|cursor> [--workspace <folder>] [--scope user|project]

Removes the MCP server named kition from the agent, and prints what it ran or wrote. Without
--scope: Claude Code removes it from whichever scope has it; Cursor from the project file and the
user file.
";

const AGENT_LIST: &str = "\
usage: kition agent list [--workspace <folder>]

For Claude Code, Codex and Cursor: whether the agent is here, and whether kition is registered
with it (for the folder --workspace names, else the current folder, and for the user).
";

const DOCTOR: &str = "\
usage: kition doctor [--json] [--index <address or file>]

Checks kition: its version and protocol; the Kition home and whether it can be written; whether
the folder holding this kition (installed with npm: npm's kition command) is on the PATH; whether
the kit index can be read now (or how old the kept copy is); each installed kit in use, started
and asked kit.initialize; and which agents have kition registered. Each failed check ends with
the command that fixes it; the exit status is 1 when any check failed.

  --json    the same as JSON: version, protocol, platform, ok, and checks (name, status ok, warn,
            fail or info, detail, fix)
";

/// The usage of `kition <path>` (`["kit", "install"]`), when it has one of its own.
pub fn of(path: &[&str]) -> Option<&'static str> {
    Some(match path {
        [] => USAGE,
        ["kit"] => KIT,
        ["kit", "list"] => KIT_LIST,
        ["kit", "install"] => KIT_INSTALL,
        ["kit", "upgrade"] => KIT_UPGRADE,
        ["kit", "remove"] => KIT_REMOVE,
        ["kit", "info"] => KIT_INFO,
        ["kit", "add"] => KIT_ADD,
        ["kit", "pack"] => KIT_PACK,
        ["agent"] => AGENT,
        ["agent", "add"] => AGENT_ADD,
        ["agent", "remove"] => AGENT_REMOVE,
        ["agent", "list"] => AGENT_LIST,
        ["doctor"] => DOCTOR,
        _ => return None,
    })
}

/// The commands, each with its subcommands.
pub const COMMANDS: &[(&str, &[&str])] = &[
    ("kit", &["list", "install", "upgrade", "remove", "info", "add", "pack"]),
    ("agent", &["add", "remove", "list"]),
    ("mcp", &[]),
    ("serve", &[]),
    ("doctor", &[]),
];

/// Prints the usage of `kition <path>`.
pub fn print(path: &[&str]) -> ExitCode {
    print!("{}", of(path).unwrap_or(USAGE));
    ExitCode::SUCCESS
}

/// The edit distance between `a` and `b` (insertions, deletions, substitutions).
fn distance(a: &str, b: &str) -> usize {
    let b: Vec<char> = b.chars().collect();
    let mut row: Vec<usize> = (0..=b.len()).collect();
    for (i, x) in a.chars().enumerate() {
        let mut diagonal = row[0];
        row[0] = i + 1;
        for (j, y) in b.iter().enumerate() {
            let above = row[j + 1];
            row[j + 1] = (diagonal + usize::from(x != *y)).min(row[j] + 1).min(above + 1);
            diagonal = above;
        }
    }
    row[b.len()]
}

/// The known command closest to `word` typed after `kition <within>`, as it is typed in full
/// (`kition kit install`): a subcommand of `within`, then a command, then any subcommand.
pub fn closest(within: &[&str], word: &str) -> Option<String> {
    let mut candidates: Vec<String> = Vec::new();
    if let [command] = within {
        for (name, subcommands) in COMMANDS {
            if name == command {
                candidates.extend(subcommands.iter().map(|sub| format!("kition {name} {sub}")));
            }
        }
    }
    candidates.extend(COMMANDS.iter().map(|(name, _)| format!("kition {name}")));
    for (name, subcommands) in COMMANDS {
        candidates.extend(subcommands.iter().map(|sub| format!("kition {name} {sub}")));
    }
    let word = word.to_ascii_lowercase();
    let limit = (word.chars().count() / 3).max(1);
    let mut best: Option<(usize, String)> = None;
    for candidate in candidates {
        let last = candidate.rsplit(' ').next().unwrap_or_default();
        let far = distance(&word, last);
        if far <= limit && best.as_ref().is_none_or(|(known, _)| far < *known) {
            best = Some((far, candidate));
        }
    }
    best.map(|(_, candidate)| candidate)
}

/// An unknown command or subcommand `word` after `kition <within>`: the closest known one, and
/// where the usage is. Exit status 2.
pub fn unknown(within: &[&str], word: &str) -> ExitCode {
    let what = if within.is_empty() { "command".to_owned() } else { format!("{} command", within.join(" ")) };
    let mut message = format!("kition: unknown {what} {word}");
    if let Some(close) = closest(within, word) {
        message.push_str(&format!("; did you mean `{close}`?"));
    }
    let help = if within.is_empty() { "kition --help".to_owned() } else { format!("kition {} --help", within.join(" ")) };
    eprintln!("{message}\nrun `{help}` for the commands");
    ExitCode::from(2)
}

/// A mistake in the arguments of `kition <path>`: what is wrong, and where its usage is. Exit
/// status 2.
pub fn mistake(path: &[&str], message: impl std::fmt::Display) -> ExitCode {
    let command = format!("kition {}", path.join(" "));
    eprintln!("{command}: {message}\nrun `{command} --help` for its usage");
    ExitCode::from(2)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_mistyped_command_names_the_closest() {
        assert_eq!(closest(&[], "install").as_deref(), Some("kition kit install"));
        assert_eq!(closest(&[], "doctr").as_deref(), Some("kition doctor"));
        assert_eq!(closest(&["kit"], "instal").as_deref(), Some("kition kit install"));
        assert_eq!(closest(&["kit"], "rm").as_deref(), None);
        assert_eq!(closest(&["agent"], "ad").as_deref(), Some("kition agent add"));
        assert_eq!(closest(&[], "frobnicate"), None);
    }

    #[test]
    fn the_usage_is_short_and_every_command_has_its_own() {
        assert!(USAGE.lines().count() <= 40, "{} lines", USAGE.lines().count());
        for (name, subcommands) in COMMANDS {
            if !matches!(*name, "mcp" | "serve") {
                assert!(of(&[name]).is_some(), "{name}");
            }
            for sub in *subcommands {
                assert!(of(&[name, sub]).is_some(), "{name} {sub}");
            }
        }
    }
}
