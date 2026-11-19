//! `kition`: the Kition command line. See `kition --help` and `docs/sdk/cli.md`. Each command is
//! a module of `commands/`.

mod commands;

use std::process::ExitCode;

use commands::{agent, doctor, help, kit};
use kition_cli::index::{self, Source};
use kition_cli::{VERSION, supply};

const MCP_STORE_USAGE: &str = "
the kit store (kition mcp only):
  with no --workspace, the workspace is the folder kition mcp starts in; it is named on stderr
  with no --kit and no --kits-dir, the kits are those installed in the store (KITION_HOME, default
  ~/.kition: kits/<kit>/<version>/), and a kit the index lists that is not installed is installed
  when the agent first names a file of it (through kit_inspect, or any kit_* tool with --unified);
  the server then announces its new tools (notifications/tools/list_changed)
  --no-install           install nothing: a file of a kit not installed answers how to install it
  --index <address or file>  the kit index (default KITION_INDEX, else the SDK's kit index)
";

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let rest = args.get(1..).unwrap_or_default();
    match args.first().map(String::as_str) {
        None | Some("--help" | "-h" | "help") => help::print(&[]),
        Some("--version" | "-V" | "version") => {
            println!("kition {VERSION} (kit protocol {}, index format {})", kition_cli::protocol(), index::SCHEMA_VERSION);
            ExitCode::SUCCESS
        }
        Some("kit") => kit::run(rest),
        Some("agent") => agent::run(rest),
        Some("doctor") => doctor::run(rest),
        Some("mcp") => mcp(rest.to_vec()),
        Some("serve") => serve(args),
        Some(other) if other.starts_with('-') => {
            eprintln!("kition: unknown option {other}\nrun `kition --help` for the commands");
            ExitCode::from(2)
        }
        Some(other) => help::unknown(&[], other),
    }
}

/// `--index <value>` taken out of `kition mcp`'s arguments, and whether `--no-install` was given;
/// the rest are `kition-kits-mcp`'s.
fn take_store_flags(args: Vec<String>) -> Result<(Vec<String>, Option<String>, bool), String> {
    let mut rest = Vec::new();
    let mut index = None;
    let mut installs = true;
    let mut args = args.into_iter();
    while let Some(arg) = args.next() {
        if arg == "--index" {
            index = Some(args.next().filter(|value| !value.is_empty()).ok_or("--index needs an address or a file")?);
        } else if let Some(value) = arg.strip_prefix("--index=") {
            index = Some(value.to_owned());
        } else if arg == "--no-install" {
            installs = false;
        } else {
            rest.push(arg);
        }
    }
    Ok((rest, index, installs))
}

fn mcp(args: Vec<String>) -> ExitCode {
    let (rest, index, installs) = match take_store_flags(args) {
        Ok(taken) => taken,
        Err(message) => return help::mistake(&["mcp"], message),
    };
    let source = Source::choose(index.as_deref());
    let kits: Box<dyn FnOnce() -> _> = Box::new(move || match kit::store() {
        Ok(store) => supply::for_mcp(store, source, installs),
        Err(message) => {
            eprintln!("kition mcp: {message}");
            (Vec::new(), None)
        }
    });
    kition_kits::cli::mcp::main("kition mcp", rest.into_iter(), Some(kition_kits::cli::mcp::Store { usage: MCP_STORE_USAGE, kits }))
}

fn serve(args: Vec<String>) -> ExitCode {
    let kits: Box<dyn FnOnce() -> _> = Box::new(|| kit::store().map(|store| supply::installed(&store)).unwrap_or_default());
    kition_kits::cli::serve::main("kition", args.into_iter(), Some(kits))
}

#[cfg(test)]
mod tests {
    use super::*;
    use kition_cli::home::HOME_VARIABLE;
    use kition_cli::index::{DEFAULT_INDEX, INDEX_VARIABLE};
    use serde_json::Value;

    /// sdk.json registers the program, its variables and the default index; they are this
    /// program's.
    #[test]
    fn sdk_json_names_this_programs_variables() {
        let sdk: Value = serde_json::from_str(include_str!("../../../sdk.json")).unwrap();
        let cli = &sdk["binaries"]["cli"];
        assert_eq!(cli["name"], "kition");
        assert_eq!(cli["home"], HOME_VARIABLE);
        assert_eq!(cli["index"], INDEX_VARIABLE);
        assert_eq!(cli["defaultIndex"], DEFAULT_INDEX);
    }

    /// `kition --version` is the SDK version: bump this crate's version with sdk.json's.
    #[test]
    fn the_version_is_the_sdks() {
        let sdk: Value = serde_json::from_str(include_str!("../../../sdk.json")).unwrap();
        assert_eq!(sdk["version"], VERSION, "set crates/kition-cli/Cargo.toml version to sdk.json's");
    }
}
