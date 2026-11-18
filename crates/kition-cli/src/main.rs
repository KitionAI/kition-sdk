//! `kition`: the Kition command line. See `kition --help` and `docs/sdk/cli.md`.

use std::process::ExitCode;

use kition_cli::home::Home;
use kition_cli::index::{self, Freshness, INDEX_VARIABLE, Loaded, Source};
use kition_cli::store::{Outcome, Store};
use kition_cli::{VERSION, supply};
use semver::Version;
use serde_json::{Value, json};

const USAGE: &str = "\
kition: Kition's kits for AI agents and programs, installed on demand

usage:
  kition kit list [--json]                  the kits in the index and those installed, with the
                                            version in use and the newest
  kition kit install <kit>[@<version>]      install a kit (the newest this kition can run); with a
                                            version, install that one and keep using it (pinned)
  kition kit upgrade [<kit>]                move a kit, or every kit not pinned, to the newest
                                            version, and remove the older ones
  kition kit remove <kit>                   remove every version of a kit
  kition mcp --workspace <folder> [options] the kits' MCP server on stdio (as kition-kits-mcp);
                                            see kition mcp --help
  kition serve --workspace <folder> [...]   the Kits Service API on stdio (as kition-kits serve);
                                            see kition serve --help
  kition --version | --help

options of kit and mcp:
  --index <address or file>   the kit index to read instead of KITION_INDEX or the default

environment:
  KITION_HOME    where kits are kept (default ~/.kition): kits/<kit>/<version>/
  KITION_INDEX   the kit index: an https address or a file (default the SDK's latest release:
                 https://github.com/KitionAI/kition-sdk/releases/latest/download/kits-index.json)
  HTTPS_PROXY, HTTP_PROXY, ALL_PROXY, NO_PROXY   proxies for downloads
";

const MCP_STORE_USAGE: &str = "
the kit store (kition mcp only):
  with no --kit and no --kits-dir, the kits are those installed in the store (KITION_HOME, default
  ~/.kition: kits/<kit>/<version>/), and a kit the index lists that is not installed is installed
  when the agent first names a file of it (through kit_inspect, or any kit_* tool with --unified);
  the server then announces its new tools (notifications/tools/list_changed)
  --no-install           install nothing: a file of a kit not installed answers how to install it
  --index <address or file>  the kit index (default KITION_INDEX, else the SDK's latest release)
";

fn fail(message: impl std::fmt::Display) -> ExitCode {
    eprintln!("kition: {message}");
    ExitCode::FAILURE
}

fn usage_error(message: impl std::fmt::Display) -> ExitCode {
    eprintln!("kition: {message}\n\n{USAGE}");
    ExitCode::from(2)
}

/// The arguments left, `--index`'s value, and the program's own flags given.
type Taken = (Vec<String>, Option<String>, Vec<String>);

/// `--index <value>` taken out of `args`, with whatever else `own` names (flags without value).
fn take_flags(args: Vec<String>, own: &[&str]) -> Result<Taken, String> {
    let mut rest = Vec::new();
    let mut index = None;
    let mut flags = Vec::new();
    let mut args = args.into_iter();
    while let Some(arg) = args.next() {
        if arg == "--index" {
            index = Some(args.next().filter(|value| !value.is_empty()).ok_or("--index needs an address or a file")?);
        } else if let Some(value) = arg.strip_prefix("--index=") {
            index = Some(value.to_owned());
        } else if own.contains(&arg.as_str()) {
            flags.push(arg);
        } else {
            rest.push(arg);
        }
    }
    Ok((rest, index, flags))
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        None | Some("--help" | "-h" | "help") => {
            print!("{USAGE}");
            ExitCode::SUCCESS
        }
        Some("--version" | "-V" | "version") => {
            println!("kition {VERSION} (kit protocol {}, index format {})", kition_cli::protocol(), index::SCHEMA_VERSION);
            ExitCode::SUCCESS
        }
        Some("kit") => kit(args[1..].to_vec()),
        Some("mcp") => mcp(args[1..].to_vec()),
        Some("serve") => serve(args),
        Some(other) => usage_error(format!("unknown command {other}")),
    }
}

fn store() -> Result<Store, String> {
    Ok(Store::new(Home::from_env()?))
}

fn mcp(args: Vec<String>) -> ExitCode {
    let (rest, index, flags) = match take_flags(args, &["--no-install"]) {
        Ok(taken) => taken,
        Err(message) => return usage_error(message),
    };
    let installs = !flags.iter().any(|flag| flag == "--no-install");
    let source = Source::choose(index.as_deref());
    let kits: Box<dyn FnOnce() -> _> = Box::new(move || match store() {
        Ok(store) => supply::for_mcp(store, source, installs),
        Err(message) => {
            eprintln!("kition mcp: {message}");
            (Vec::new(), None)
        }
    });
    kition_kits::cli::mcp::main("kition mcp", rest.into_iter(), Some(kition_kits::cli::mcp::Store { usage: MCP_STORE_USAGE, kits }))
}

fn serve(args: Vec<String>) -> ExitCode {
    let kits: Box<dyn FnOnce() -> _> = Box::new(|| store().map(|store| supply::installed(&store)).unwrap_or_default());
    kition_kits::cli::serve::main("kition", args.into_iter(), Some(kits))
}

/// `<kit>` or `<kit>@<version>`.
fn kit_and_version(text: &str) -> Result<(String, Option<Version>), String> {
    match text.split_once('@') {
        Some((name, version)) => {
            let version = Version::parse(version.trim_start_matches('v')).map_err(|_| format!("`{version}` is not a version, for example 0.3.0"))?;
            Ok((name.to_owned(), Some(version)))
        }
        None => Ok((text.to_owned(), None)),
    }
}

fn kit(args: Vec<String>) -> ExitCode {
    let (rest, index, flags) = match take_flags(args, &["--json"]) {
        Ok(taken) => taken,
        Err(message) => return usage_error(message),
    };
    let json = !flags.is_empty();
    let store = match store() {
        Ok(store) => store,
        Err(message) => return fail(message),
    };
    let source = Source::choose(index.as_deref());
    let words: Vec<&str> = rest.iter().map(String::as_str).collect();
    if words.iter().any(|word| word.starts_with('-')) {
        return usage_error(format!("unknown option {}", words.iter().find(|word| word.starts_with('-')).unwrap_or(&"")));
    }
    match words.as_slice() {
        ["list"] => list(&store, &source, json),
        ["install", target] => match kit_and_version(target) {
            Ok((name, version)) => install(&store, &source, &name, version.as_ref()),
            Err(message) => usage_error(message),
        },
        ["upgrade"] => upgrade(&store, &source, None),
        ["upgrade", name] => upgrade(&store, &source, Some(name)),
        ["remove", name] => match store.remove(name) {
            Ok(versions) => {
                let versions: Vec<String> = versions.iter().map(Version::to_string).collect();
                println!("removed {name} {}", versions.join(", "));
                ExitCode::SUCCESS
            }
            Err(message) => fail(message),
        },
        [] | ["--help" | "-h" | "help"] => {
            print!("{USAGE}");
            ExitCode::SUCCESS
        }
        _ => usage_error(format!("unknown kit command: {}", words.join(" "))),
    }
}

fn read_index(store: &Store, source: &Source) -> Result<Loaded, String> {
    let loaded = index::load(store.home(), source, Freshness::Now)?;
    if let Some(why) = &loaded.stale {
        eprintln!("kition: {why}; using the kit index as last read");
    }
    Ok(loaded)
}

fn list(store: &Store, source: &Source, json: bool) -> ExitCode {
    let loaded = index::load(store.home(), source, Freshness::Now);
    let platform = kition_cli::home::platform();
    let stored = store.list();
    let mut names: Vec<String> = stored.iter().map(|kit| kit.name.clone()).collect();
    if let Ok(loaded) = &loaded {
        names.extend(loaded.index.kits.keys().cloned());
    }
    names.sort();
    names.dedup();
    let rows: Vec<Value> = names
        .iter()
        .map(|name| {
            let listed = loaded.as_ref().ok().and_then(|loaded| loaded.index.kits.get(name));
            let held = stored.iter().find(|kit| &kit.name == name);
            let in_use = held.and_then(|kit| kit.in_use());
            let manifest: Value = in_use.and_then(|installed| serde_json::from_str(&installed.manifest).ok()).unwrap_or(Value::Null);
            let latest = listed.and_then(|kit| Store::choose(name, kit, None, &platform).ok());
            let extensions: Vec<String> = match listed {
                Some(kit) => kit.extensions.clone(),
                None => kition_kits::KitDefinition::from_manifest_text(&in_use.map(|installed| installed.manifest.clone()).unwrap_or_default())
                    .map(|kit| kit.extensions.iter().map(|extension| (*extension).to_owned()).collect())
                    .unwrap_or_default(),
            };
            json!({
                "name": name,
                "id": listed.map(|kit| kit.id.clone()).or_else(|| manifest["id"].as_str().map(str::to_owned)),
                "displayName": listed.map(|kit| kit.name.clone()).or_else(|| manifest["name"].as_str().map(str::to_owned)),
                "extensions": extensions,
                "installed": held.map(|kit| kit.versions.iter().map(|installed| installed.version.to_string()).collect::<Vec<_>>()).unwrap_or_default(),
                "inUse": in_use.map(|installed| installed.version.to_string()),
                "pinned": held.and_then(|kit| kit.pinned.as_ref()).map(Version::to_string),
                "executable": in_use.map(|installed| installed.executable.display().to_string()),
                "latest": latest.as_ref().map(Version::to_string),
                "upgrade": matches!((in_use, &latest), (Some(installed), Some(latest)) if &installed.version < latest),
                "inIndex": listed.is_some(),
            })
        })
        .collect();
    let index_state = match &loaded {
        Ok(loaded) => json!({ "location": loaded.location, "read": true, "stale": loaded.stale }),
        Err(error) => json!({ "location": source.location, "read": false, "error": error }),
    };
    if json {
        let answer = json!({ "home": store.home().root().display().to_string(), "platform": platform, "index": index_state, "kits": rows });
        println!("{}", serde_json::to_string_pretty(&answer).unwrap_or_default());
        return ExitCode::SUCCESS;
    }
    match &loaded {
        Ok(Loaded { stale: Some(why), .. }) => eprintln!("kition: {why}; showing the kit index as last read"),
        Err(error) => eprintln!("kition: {error}; showing the installed kits only"),
        _ => {}
    }
    if rows.is_empty() {
        println!("no kits: the index lists none and none is installed in {}", store.home().kits().display());
        return ExitCode::SUCCESS;
    }
    let text = |value: &Value| value.as_str().unwrap_or("-").to_owned();
    let mut table = vec![["KIT".to_owned(), "NAME".to_owned(), "INSTALLED".to_owned(), "LATEST".to_owned(), "FILES".to_owned()]];
    for row in &rows {
        let mut installed = text(&row["inUse"]);
        if !row["pinned"].is_null() && row["pinned"] == row["inUse"] {
            installed.push_str(" (pinned)");
        } else if row["upgrade"] == true {
            installed.push_str(" (upgrade)");
        }
        let files: Vec<String> =
            row["extensions"].as_array().into_iter().flatten().filter_map(Value::as_str).map(|extension| format!(".{extension}")).collect();
        table.push([text(&row["name"]), text(&row["displayName"]), installed, text(&row["latest"]), files.join(" ")]);
    }
    let widths: Vec<usize> = (0..5).map(|column| table.iter().map(|row| row[column].chars().count()).max().unwrap_or(0)).collect();
    for row in &table {
        let line: Vec<String> = row.iter().zip(&widths).map(|(cell, width)| format!("{cell:<width$}")).collect();
        println!("{}", line.join("  ").trim_end());
    }
    ExitCode::SUCCESS
}

fn install(store: &Store, source: &Source, name: &str, version: Option<&Version>) -> ExitCode {
    let loaded = match read_index(store, source) {
        Ok(loaded) => loaded,
        Err(error) => return fail(format!("{error}\nthe kit index is needed to install a kit ({INDEX_VARIABLE} or --index name another)")),
    };
    match store.install(&loaded, name, version) {
        Ok((name, outcome)) => {
            let pinned = match version {
                Some(version) => store.pin(&name, Some(version)),
                None => store.pin(&name, None),
            };
            if let Err(message) = pinned {
                return fail(message);
            }
            let in_use = store.kit(&name).and_then(|kit| kit.in_use().map(|installed| (installed.version.clone(), installed.folder.clone())));
            match outcome {
                Outcome::Installed(installed) => println!("installed {name} {installed}"),
                Outcome::Present(installed) => println!("{name} {installed} is installed already"),
            }
            if let Some((in_use, folder)) = in_use {
                println!("{name} {in_use} is in use{}: {}", if version.is_some() { " (pinned)" } else { "" }, folder.display());
            }
            ExitCode::SUCCESS
        }
        Err(message) => fail(message),
    }
}

fn upgrade(store: &Store, source: &Source, only: Option<&str>) -> ExitCode {
    let installed = store.list();
    if let Some(name) = only
        && !installed.iter().any(|kit| kit.name == name)
    {
        return fail(format!("{name} is not installed: install it with `kition kit install {name}`"));
    }
    if installed.is_empty() {
        println!("no kit is installed");
        return ExitCode::SUCCESS;
    }
    let loaded = match read_index(store, source) {
        Ok(loaded) => loaded,
        Err(error) => return fail(error),
    };
    let mut failed = false;
    for kit in installed.iter().filter(|kit| only.is_none_or(|name| name == kit.name)) {
        if only.is_none()
            && let Some(pinned) = kit.pinned.as_ref().filter(|pinned| kit.versions.iter().any(|installed| &installed.version == *pinned))
        {
            println!("{} stays at {pinned} (pinned): `kition kit upgrade {}` moves it", kit.name, kit.name);
            continue;
        }
        if loaded.index.kit(&kit.name).is_none() {
            println!("{} is not in the kit index: left as it is", kit.name);
            continue;
        }
        let before = kit.in_use().map(|installed| installed.version.clone());
        match store.install(&loaded, &kit.name, None) {
            Ok((name, outcome)) => {
                if let Err(message) = store.pin(&name, None) {
                    eprintln!("kition: {message}");
                    failed = true;
                    continue;
                }
                let removed = store.prune(&name);
                let now = outcome.version();
                match &before {
                    Some(before) if before == now => println!("{name} {now} is the newest"),
                    Some(before) => println!("upgraded {name} {before} -> {now}"),
                    None => println!("installed {name} {now}"),
                }
                if !removed.is_empty() {
                    let removed: Vec<String> = removed.iter().map(Version::to_string).collect();
                    println!("removed {name} {}", removed.join(", "));
                }
            }
            Err(message) => {
                eprintln!("kition: {}: {message}", kit.name);
                failed = true;
            }
        }
    }
    if failed { ExitCode::FAILURE } else { ExitCode::SUCCESS }
}

#[cfg(test)]
mod tests {
    use super::*;
    use kition_cli::home::HOME_VARIABLE;
    use kition_cli::index::DEFAULT_INDEX;

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

    #[test]
    fn a_kit_may_name_its_version() {
        assert_eq!(kit_and_version("note").unwrap(), ("note".to_owned(), None));
        assert_eq!(kit_and_version("note@v0.3.0").unwrap().1, Some(Version::new(0, 3, 0)));
        assert!(kit_and_version("note@latest").is_err());
    }
}
