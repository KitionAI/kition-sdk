//! The store's kits for `kition mcp`, and the supply that installs the others when the agent
//! first names a file of theirs (`kition_kits::supply`).

use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use kition_kits::KitDefinition;
use kition_kits::definitions::Found;
use kition_kits::supply::{KitSupply, SupplyError};
use serde_json::json;

use crate::index::{self, Freshness, Index, Loaded, Source};
use crate::store::Store;

/// How old a kept index `kition mcp` starts with before it reads the index again.
pub const STARTUP_FRESHNESS: Duration = Duration::from_secs(3600);

/// The kits in use in the store, each with its executable. A version whose `kit.json` declares
/// no usable kit is skipped, with a warning.
pub fn installed(store: &Store) -> Vec<Found> {
    store
        .list()
        .iter()
        .filter_map(|kit| {
            let installed = kit.in_use()?;
            match KitDefinition::from_manifest_text(&installed.manifest) {
                Ok(definition) => Some((definition, Some(installed.executable.clone()))),
                Err(error) => {
                    eprintln!("kition: {} {} in {}: {error}", kit.name, installed.version, installed.folder.display());
                    None
                }
            }
        })
        .collect()
}

/// A definition worded from what the index says of a kit, for the tools that install it: never run.
fn placeholder(name: &str, kit: &index::IndexKit) -> Option<&'static KitDefinition> {
    let manifest = json!({
        "id": kit.id,
        "name": kit.name,
        "version": kit.latest().map(|version| version.to_string()).unwrap_or_default(),
        "formats": [{ "id": name, "extensions": kit.extensions, "role": "edit" }],
        "agent": { "prefix": name },
    });
    KitDefinition::from_manifest(&manifest).ok()
}

/// Installs kits from the index into the store while `kition mcp` serves.
pub struct StoreSupply {
    store: Store,
    source: Source,
    /// Whether it installs (`--no-install` turns it off: it then says how to install instead).
    installs: bool,
    loaded: Mutex<Option<Loaded>>,
    /// Why the index could not be read at startup, when it could not.
    unreachable: Option<String>,
    available: Vec<&'static KitDefinition>,
}

impl StoreSupply {
    /// The supply for `store`, with the index from `source` (the kept copy when it is recent).
    pub fn new(store: Store, source: Source, installs: bool) -> Self {
        let (loaded, unreachable) = match index::load(store.home(), &source, Freshness::Within(STARTUP_FRESHNESS)) {
            Ok(loaded) => (Some(loaded), None),
            Err(error) => (None, Some(error)),
        };
        let available = loaded.as_ref().map(|loaded| loaded.index.kits.iter().filter_map(|(name, kit)| placeholder(name, kit)).collect()).unwrap_or_default();
        Self { store, source, installs, loaded: Mutex::new(loaded), unreachable, available }
    }

    fn index(&self) -> Result<Loaded, String> {
        let mut loaded = self.loaded.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some(loaded) = loaded.as_ref().filter(|loaded| loaded.stale.is_none()) {
            return Ok(loaded.clone());
        }
        let fresh = index::load(self.store.home(), &self.source, Freshness::Now)?;
        *loaded = Some(fresh.clone());
        Ok(fresh)
    }
}

fn kinds(index: &Index) -> String {
    let kinds: Vec<String> = index.kits.values().map(|kit| format!("{} (.{})", kit.name, kit.extensions.join(", ."))).collect();
    if kinds.is_empty() { "no kit".to_owned() } else { kinds.join("; ") }
}

impl KitSupply for StoreSupply {
    fn available(&self) -> Vec<&'static KitDefinition> {
        self.available.clone()
    }

    fn unavailable(&self) -> Option<String> {
        self.unreachable.as_ref().map(|error| {
            format!("the kit index cannot be read ({error}). Ask the person to connect, or to run `kition kit install <kit>`, then restart this server.")
        })
    }

    fn installs(&self) -> bool {
        self.installs
    }

    fn install(&self, extension: &str) -> Result<Found, SupplyError> {
        let loaded = self.index().map_err(|error| {
            SupplyError::new(
                "unavailable",
                format!("The kit for .{extension} files is not installed, and the kit index cannot be read to install it: {error}. Try again later, or ask the person to run `kition kit install <kit>` when online."),
            )
        })?;
        let Some((name, kit)) = loaded.index.for_extension(extension) else {
            return Err(SupplyError::new("unknown-type", format!("No Kition kit opens .{extension} files. The kits there are: {}.", kinds(&loaded.index))));
        };
        if !self.installs {
            return Err(SupplyError::new(
                "off",
                format!(
                    "{} (for .{extension} files) is not installed, and this server installs no kits (`--no-install`). Ask the person to run `kition kit install {name}`, then restart this server.",
                    kit.name
                ),
            ));
        }
        let platform = crate::home::platform();
        if let Err(why) = Store::choose(name, kit, None, &platform) {
            let ours = crate::protocol();
            let reason = if kit.versions.values().any(|entry| entry.protocol == ours) { "failed" } else { "protocol" };
            return Err(SupplyError::new(reason, format!("{} (for .{extension} files) cannot be installed: {why}. Tell the person.", kit.name)));
        }
        let (name, outcome) = self.store.install(&loaded, name, None).map_err(|why| {
            SupplyError::new(
                "unavailable",
                format!("Installing {} (for .{extension} files) failed: {why}. Try again; if it keeps failing, tell the person.", kit.name),
            )
        })?;
        let Some(stored) = self.store.kit(&name) else {
            return Err(SupplyError::new("failed", format!("{} {} was installed and then not found in the store", kit.name, outcome.version())));
        };
        let installed = stored.in_use().ok_or_else(|| SupplyError::new("failed", format!("{} has no version in use", kit.name)))?;
        let definition = KitDefinition::from_manifest_text(&installed.manifest).map_err(|error| SupplyError::new("failed", error))?;
        Ok((definition, Some(installed.executable.clone())))
    }
}

/// The store for `kition mcp`: its kits, and the supply. `None` for the supply leaves on-demand
/// installs out entirely.
pub fn for_mcp(store: Store, source: Source, installs: bool) -> (Vec<Found>, Option<Arc<dyn KitSupply>>) {
    let found = installed(&store);
    let supply: Arc<dyn KitSupply> = Arc::new(StoreSupply::new(store, source, installs));
    (found, Some(supply))
}
