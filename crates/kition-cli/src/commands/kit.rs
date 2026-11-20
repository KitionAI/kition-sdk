//! `kition kit <command>`: the kit store and the kit index.

use std::path::{Path, PathBuf};
use std::process::ExitCode;

use kition_cli::editors::Editors;
use kition_cli::home::Home;
use kition_cli::index::{self, Freshness, INDEX_VARIABLE, IndexKit, Loaded, Source};
use kition_cli::store::{Outcome, Store};
use semver::Version;
use serde_json::{Value, json};

use super::progress::Progress;
use super::{Args, help};

fn fail(message: impl std::fmt::Display) -> ExitCode {
    eprintln!("kition: {message}");
    ExitCode::FAILURE
}

pub fn store() -> Result<Store, String> {
    Ok(Store::new(Home::from_env()?))
}

/// A kit's short name: `note` for `note` and for `kit.note`.
fn short(name: &str) -> &str {
    name.strip_prefix("kit.").unwrap_or(name)
}

/// `<kit>` or `<kit>@<version>`.
pub fn kit_and_version(text: &str) -> Result<(String, Option<Version>), String> {
    match text.split_once('@') {
        Some((name, version)) => {
            let version = Version::parse(version.trim_start_matches('v')).map_err(|_| format!("`{version}` is not a version, for example 0.3.0"))?;
            Ok((name.to_owned(), Some(version)))
        }
        None => Ok((text.to_owned(), None)),
    }
}

/// `kition kit <args>`.
pub fn run(args: &[String]) -> ExitCode {
    let Some(command) = args.first().map(String::as_str) else { return help::print(&["kit"]) };
    if matches!(command, "--help" | "-h" | "help") {
        return help::print(&["kit"]);
    }
    let (switches, valued): (&[&'static str], &[&'static str]) = match command {
        "list" | "info" => (&["--json"], &["--index"]),
        "install" => (&["--all"], &["--index"]),
        "upgrade" => (&[], &["--index"]),
        "remove" | "add" => (&[], &[]),
        "pack" => (&[], &["--out"]),
        other if other.starts_with('-') => return help::mistake(&["kit"], format!("{other} goes after the kit command (kition kit <command> {other})")),
        other => return help::unknown(&["kit"], other),
    };
    let path = ["kit", command];
    let rest = &args[1..];
    if super::asks_help(rest) {
        return help::print(&path);
    }
    let args = match Args::parse(rest, switches, valued) {
        Ok(args) => args,
        Err(message) => return help::mistake(&path, message),
    };
    let store = match store() {
        Ok(store) => store,
        Err(message) => return fail(message),
    };
    let source = Source::choose(args.value("--index"));
    let words: Vec<&str> = args.words.iter().map(String::as_str).collect();
    match (command, words.as_slice()) {
        ("list", []) => list(&store, &source, args.has("--json")),
        ("install", targets) => install(&store, &source, targets, args.has("--all")),
        ("upgrade", []) => upgrade(&store, &source, None),
        ("upgrade", [name]) => upgrade(&store, &source, Some(short(name))),
        ("remove", names) if !names.is_empty() => remove(&store, names),
        ("info", [name]) => info(&store, &source, short(name), args.has("--json")),
        ("add", [path]) => add(&store, Path::new(path)),
        ("pack", [name]) => pack(&store, short(name), args.value("--out").map_or_else(|| PathBuf::from("."), PathBuf::from)),
        ("remove" | "info" | "pack", []) => help::mistake(&path, "name a kit"),
        ("add", []) => help::mistake(&path, "name a kit archive, a folder holding kit.json, or a kit executable"),
        (_, extra) => help::mistake(&path, format!("too many arguments: {}", extra.join(" "))),
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
                None => manifest_extensions(in_use.map(|installed| installed.manifest.as_str()).unwrap_or_default()),
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
                "editor": editor_state(store, loaded.as_ref().ok(), name, in_use.map(|installed| &installed.version)),
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
    let mut table = vec![["KIT".to_owned(), "NAME".to_owned(), "INSTALLED".to_owned(), "EDITOR".to_owned(), "LATEST".to_owned(), "FILES".to_owned()]];
    for row in &rows {
        let mut installed = text(&row["inUse"]);
        let newer = |a: &Value, b: &Value| match (a.as_str().map(Version::parse), b.as_str().map(Version::parse)) {
            (Some(Ok(a)), Some(Ok(b))) => a > b,
            _ => false,
        };
        if !row["pinned"].is_null() && row["pinned"] == row["inUse"] {
            installed.push_str(" (pinned)");
        } else if row["upgrade"] == true {
            installed.push_str(" (upgrade)");
        } else if newer(&row["inUse"], &row["latest"]) {
            installed.push_str(" (newer than the index)");
        }
        let files: Vec<String> =
            row["extensions"].as_array().into_iter().flatten().filter_map(Value::as_str).map(|extension| format!(".{extension}")).collect();
        table.push([text(&row["name"]), text(&row["displayName"]), installed, editor_text(&row["editor"]), text(&row["latest"]), files.join(" ")]);
    }
    let widths: Vec<usize> = (0..6).map(|column| table.iter().map(|row| row[column].chars().count()).max().unwrap_or(0)).collect();
    for row in &table {
        let line: Vec<String> = row.iter().zip(&widths).map(|(cell, width)| format!("{cell:<width$}")).collect();
        println!("{}", line.join("  ").trim_end());
    }
    ExitCode::SUCCESS
}

/// Whether the editor package of the version of `name` in use (`in_use`) is installed:
/// `{ installed: [versions], inUse: bool, available: bool }`, `available` saying whether the kit
/// index lists one for that version (`null` when the index could not be read).
fn editor_state(store: &Store, loaded: Option<&Loaded>, name: &str, in_use: Option<&Version>) -> Value {
    let editors = Editors::new(store.clone());
    let installed: Vec<String> = editors.installed(name).iter().map(|editor| editor.version.to_string()).collect();
    let available = loaded.map(|loaded| {
        in_use.is_some_and(|version| loaded.index.kits.get(name).and_then(|kit| kit.versions.get(&version.to_string())).is_some_and(|entry| entry.ui.is_some()))
    });
    json!({
        "installed": installed,
        "inUse": in_use.is_some_and(|version| installed.contains(&version.to_string())),
        "available": available,
    })
}

/// The EDITOR column: the version in use's editor `installed`, `missing` (the index has one),
/// `none` (it has none), `-` (no version in use).
fn editor_text(editor: &Value) -> String {
    if editor["inUse"] == true {
        "installed".to_owned()
    } else if editor["available"] == false {
        "none".to_owned()
    } else if editor["available"] == true {
        "missing".to_owned()
    } else {
        "-".to_owned()
    }
}

/// Installs the editor package of `name` `version` when the index lists one; says what happened.
fn install_editor(store: &Store, loaded: &Loaded, name: &str, version: &Version) -> Result<(), String> {
    let listed = loaded.index.kits.get(name).and_then(|kit| kit.versions.get(&version.to_string())).is_some_and(|entry| entry.ui.is_some());
    if !listed {
        println!("the kit index lists no editor package for {name} {version}: kition gateway cannot show its editor");
        return Ok(());
    }
    let editors = Editors::new(store.clone());
    let mut progress = Progress::new(&format!("{name} editor"));
    let outcome = editors.install(loaded, name, version, &mut |done, total| progress.update(done, total));
    progress.finish();
    match outcome.map_err(|why| format!("the editor of {name} {version}: {why}"))? {
        Outcome::Installed(_) => println!("installed the editor of {name} {version}"),
        Outcome::Present(_) => {}
    }
    Ok(())
}

/// The extensions a kit.json's edit formats open.
fn manifest_extensions(manifest: &str) -> Vec<String> {
    kition_kits::KitDefinition::from_manifest_text(manifest)
        .map(|kit| kit.extensions.iter().map(|extension| (*extension).to_owned()).collect())
        .unwrap_or_default()
}

fn install(store: &Store, source: &Source, targets: &[&str], all: bool) -> ExitCode {
    let path = ["kit", "install"];
    if all && !targets.is_empty() {
        return help::mistake(&path, "--all installs every kit: name no kit with it");
    }
    if !all && targets.is_empty() {
        return help::mistake(&path, "name a kit (kition kit list shows them), or --all");
    }
    let mut wanted = Vec::new();
    for target in targets {
        match kit_and_version(target) {
            Ok(parsed) => wanted.push(parsed),
            Err(message) => return help::mistake(&path, message),
        }
    }
    let loaded = match read_index(store, source) {
        Ok(loaded) => loaded,
        Err(error) => return fail(format!("{error}\nthe kit index is needed to install a kit ({INDEX_VARIABLE} or --index name another)")),
    };
    if all {
        let platform = kition_cli::home::platform();
        for (name, kit) in &loaded.index.kits {
            match Store::choose(name, kit, None, &platform) {
                Ok(_) => wanted.push((name.clone(), None)),
                Err(why) => eprintln!("kition: skipped {name}: {why}"),
            }
        }
        if wanted.is_empty() {
            println!("the kit index has no kit this machine ({platform}) can run");
            return ExitCode::SUCCESS;
        }
    }
    let mut failed = Vec::new();
    for (name, version) in &wanted {
        if let Err(message) = install_one(store, &loaded, name, version.as_ref()) {
            eprintln!("kition: {message}");
            failed.push(name.as_str());
        }
    }
    if failed.is_empty() {
        return ExitCode::SUCCESS;
    }
    if wanted.len() > 1 {
        eprintln!("kition: {} of {} kits failed: {}", failed.len(), wanted.len(), failed.join(", "));
    }
    ExitCode::FAILURE
}

/// The newest version of `name` installed here and the newest the index offers this machine, when
/// the installed one is newer (the index went back to an older number, or the kit came by `kit
/// add`): installing or upgrading without a version then leaves the kit as it is.
fn ahead_of_index(store: &Store, name: &str, kit: &IndexKit) -> Option<(Version, Version)> {
    let held = store.kit(name)?.versions.first()?.version.clone();
    let offered = Store::choose(name, kit, None, &kition_cli::home::platform()).ok()?;
    (held > offered).then_some((held, offered))
}

fn install_one(store: &Store, loaded: &Loaded, name: &str, version: Option<&Version>) -> Result<(), String> {
    if version.is_none()
        && let Some((short, kit)) = loaded.index.kit(name)
        && let Some((held, offered)) = ahead_of_index(store, short, kit)
    {
        store.pin(short, None)?;
        println!(
            "{short} {held} is installed, newer than the kit index's newest, {offered}: it stays in use (`kition kit install {short}@{offered}` installs that one)"
        );
        return Ok(());
    }
    let mut progress = Progress::new(short(name));
    let installed = store.install_reporting(loaded, name, version, &mut |done, total| progress.update(done, total));
    progress.finish();
    let (name, outcome) = installed?;
    store.pin(&name, version)?;
    match outcome {
        Outcome::Installed(installed) => println!("installed {name} {installed}"),
        Outcome::Present(installed) => println!("{name} {installed} is installed already"),
    }
    if let Some(in_use) = store.kit(&name).and_then(|kit| kit.in_use().cloned()) {
        println!("{name} {} is in use{}: {}", in_use.version, if version.is_some() { " (pinned)" } else { "" }, in_use.folder.display());
        install_editor(store, loaded, &name, &in_use.version)?;
    }
    Ok(())
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
        let Some((_, listed)) = loaded.index.kit(&kit.name) else {
            println!("{} is not in the kit index: left as it is", kit.name);
            continue;
        };
        if let Some((held, offered)) = ahead_of_index(store, &kit.name, listed) {
            if let Err(message) = store.pin(&kit.name, None) {
                eprintln!("kition: {message}");
                failed = true;
                continue;
            }
            println!("{} {held} is newer than the kit index's newest, {offered}: left as it is", kit.name);
            continue;
        }
        let before = kit.in_use().map(|installed| installed.version.clone());
        let mut progress = Progress::new(&kit.name);
        let installed = store.install_reporting(&loaded, &kit.name, None, &mut |done, total| progress.update(done, total));
        progress.finish();
        match installed {
            Ok((name, outcome)) => {
                if let Err(message) = store.pin(&name, None) {
                    eprintln!("kition: {message}");
                    failed = true;
                    continue;
                }
                let removed = store.prune(&name);
                let now = outcome.version();
                if let Err(message) = install_editor(store, &loaded, &name, now) {
                    eprintln!("kition: {message}");
                    failed = true;
                }
                Editors::new(store.clone()).prune(&name, Some(now));
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

fn remove(store: &Store, names: &[&str]) -> ExitCode {
    let mut failed = false;
    for name in names {
        match store.remove(short(name)) {
            Ok(versions) => {
                let versions: Vec<String> = versions.iter().map(Version::to_string).collect();
                println!("removed {} {}", short(name), versions.join(", "));
            }
            Err(message) => {
                eprintln!("kition: {message}");
                failed = true;
            }
        }
    }
    if failed { ExitCode::FAILURE } else { ExitCode::SUCCESS }
}

fn info(store: &Store, source: &Source, name: &str, json: bool) -> ExitCode {
    let loaded = index::load(store.home(), source, Freshness::Now);
    let platform = kition_cli::home::platform();
    let listed = loaded.as_ref().ok().and_then(|loaded| loaded.index.kits.get(name));
    let held = store.kit(name);
    if listed.is_none() && held.is_none() {
        let known = match &loaded {
            Ok(loaded) => format!("the kit index lists {}", loaded.index.kits.keys().cloned().collect::<Vec<_>>().join(", ")),
            Err(error) => format!("the kit index cannot be read ({error})"),
        };
        return fail(format!("no kit named `{name}` is installed, and {known}"));
    }
    if !json {
        match &loaded {
            Ok(Loaded { stale: Some(why), .. }) => eprintln!("kition: {why}; showing the kit index as last read"),
            Err(error) => eprintln!("kition: {error}; showing the installed kit only"),
            _ => {}
        }
    }
    let in_use = held.as_ref().and_then(|kit| kit.in_use());
    let manifest: Value = in_use.and_then(|installed| serde_json::from_str(&installed.manifest).ok()).unwrap_or(Value::Null);
    let definition = in_use.and_then(|installed| kition_kits::KitDefinition::from_manifest_text(&installed.manifest).ok());
    let available: Vec<Value> = listed
        .map(|kit| {
            kit.versions()
                .iter()
                .map(|(version, entry)| {
                    json!({
                        "version": version.to_string(),
                        "protocol": entry.protocol,
                        "platforms": entry.platforms.keys().collect::<Vec<_>>(),
                        "runsHere": entry.protocol == kition_cli::protocol() && entry.platforms.contains_key(&platform),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    let answer = json!({
        "name": name,
        "id": listed.map(|kit| kit.id.clone()).or_else(|| manifest["id"].as_str().map(str::to_owned)),
        "displayName": listed.map(|kit| kit.name.clone()).or_else(|| manifest["name"].as_str().map(str::to_owned)),
        "extensions": listed.map_or_else(|| manifest_extensions(in_use.map(|installed| installed.manifest.as_str()).unwrap_or_default()), |kit| kit.extensions.clone()),
        "installed": held.as_ref().map(|kit| kit.versions.iter().map(|installed| installed.version.to_string()).collect::<Vec<_>>()).unwrap_or_default(),
        "inUse": in_use.map(|installed| installed.version.to_string()),
        "pinned": held.as_ref().and_then(|kit| kit.pinned.as_ref()).map(Version::to_string),
        "available": available,
        "latest": listed.and_then(|kit| Store::choose(name, kit, None, &platform).ok()).map(|version| version.to_string()),
        "folder": in_use.map(|installed| installed.folder.display().to_string()),
        "executable": in_use.map(|installed| installed.executable.display().to_string()),
        "protocol": in_use.and_then(|installed| installed.protocol.clone()),
        "agent": definition.map(|kit| json!({ "prefix": kit.agent.prefix, "tools": kition_kits::tools::tool_names(kit) })),
        "editor": editor_state(store, loaded.as_ref().ok(), name, in_use.map(|installed| &installed.version)),
        "platform": platform,
    });
    if json {
        println!("{}", serde_json::to_string_pretty(&answer).unwrap_or_default());
        return ExitCode::SUCCESS;
    }
    let text = |value: &Value| value.as_str().map_or_else(|| "-".to_owned(), str::to_owned);
    let joined = |value: &Value, prefix: &str| {
        let items: Vec<String> = value.as_array().into_iter().flatten().filter_map(Value::as_str).map(|item| format!("{prefix}{item}")).collect();
        if items.is_empty() { "-".to_owned() } else { items.join(" ") }
    };
    println!("{} ({}): {}", name, text(&answer["id"]), text(&answer["displayName"]));
    println!("files:       {}", joined(&answer["extensions"], "."));
    let installed: Vec<String> = answer["installed"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(|version| {
            let mut shown = version.to_owned();
            if answer["inUse"] == version {
                shown.push_str(if answer["pinned"] == version { " (in use, pinned)" } else { " (in use)" });
            }
            shown
        })
        .collect();
    println!("installed:   {}", if installed.is_empty() { "-".to_owned() } else { installed.join(", ") });
    let in_index: Vec<String> = available
        .iter()
        .map(|entry| {
            let version = text(&entry["version"]);
            if entry["runsHere"] == true { version } else { format!("{version} (not for here: {})", text(&entry["protocol"])) }
        })
        .collect();
    let in_index = if listed.is_none() { "- (not in the kit index)".to_owned() } else { in_index.join(", ") };
    println!("in index:    {in_index}");
    println!("newest here: {}", text(&answer["latest"]));
    println!("folder:      {}", text(&answer["folder"]));
    println!("executable:  {}", text(&answer["executable"]));
    println!("protocol:    {}", text(&answer["protocol"]));
    let editor = match editor_text(&answer["editor"]).as_str() {
        "installed" => "installed (kition gateway shows it)".to_owned(),
        "missing" => format!("not installed: kition kit install {name}"),
        "none" => "none in the kit index for this version".to_owned(),
        _ => "-".to_owned(),
    };
    println!("editor:      {editor}");
    match definition {
        Some(kit) => {
            println!("agent:       prefix {}", kit.agent.prefix);
            println!("tools:       {}", kition_kits::tools::tool_names(kit).join(" "));
        }
        None => println!("agent:       - (install it to see its tools: kition kit install {name})"),
    }
    ExitCode::SUCCESS
}

fn add(store: &Store, path: &Path) -> ExitCode {
    match store.add(path) {
        Ok((name, outcome)) => {
            match outcome {
                Outcome::Installed(version) => println!("added {name} {version}"),
                Outcome::Present(version) => {
                    println!("{name} {version} is installed already: left as it is (`kition kit remove {name}` first to replace it)")
                }
            }
            if let Some(in_use) = store.kit(&name).and_then(|kit| kit.in_use().cloned()) {
                println!("{name} {} is in use: {}", in_use.version, in_use.folder.display());
            }
            ExitCode::SUCCESS
        }
        Err(message) => fail(message),
    }
}

fn pack(store: &Store, name: &str, out: PathBuf) -> ExitCode {
    match store.pack(name, &out) {
        Ok(file) => {
            let size = std::fs::metadata(&file).map(|meta| meta.len()).unwrap_or(0);
            let shown = std::path::absolute(&file).unwrap_or(file);
            println!("wrote {} ({})", shown.display(), super::bytes(size));
            println!("on another machine of this platform: kition kit add {}", super::shell_quote(&shown.file_name().unwrap_or_default().to_string_lossy()));
            ExitCode::SUCCESS
        }
        Err(message) => fail(message),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_kit_may_name_its_version() {
        assert_eq!(kit_and_version("note").unwrap(), ("note".to_owned(), None));
        assert_eq!(kit_and_version("note@v0.3.0").unwrap().1, Some(Version::new(0, 3, 0)));
        assert!(kit_and_version("note@latest").is_err());
    }
}
