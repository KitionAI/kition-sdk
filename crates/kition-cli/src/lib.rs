//! `kition`, the Kition command line. It holds no kit: kits are listed in a kit index (one JSON
//! file, `index.rs`), downloaded on demand into the kit store under the Kition home
//! (`~/.kition`, `store.rs`), and run from there by `kition mcp` and `kition serve`, the same
//! programs as `kition-kits-mcp` and `kition-kits serve` (`kition_kits::cli`). `kition mcp`
//! installs a kit the agent needs when it first names a file of it (`supply.rs`).
//!
//! The store is a plain folder that other programs may fill as well (Kition's desktop app): a
//! kit version is a folder `kits/<kit>/<version>/` holding `kit.json` and the kit's executable,
//! put in place by one rename. A kit's editor package (its own editor, for `kition gateway`'s page) is
//! installed beside it, `kits/<kit>/ui/<version>/` (`editors.rs`). See `docs/sdk/cli.md`.

pub mod editors;
pub mod fetch;
pub mod gateway;
pub mod home;
pub mod index;
pub mod launcher;
pub mod registry;
pub mod relay;
pub mod store;
pub mod supply;

/// This program's version.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

/// The Kit Process Protocol this program's hosts speak, as kit manifests and the index name it:
/// `kition-kit/1`.
pub fn protocol() -> String {
    format!("kition-kit/{}", kition_kit_process_protocol::PROTOCOL_VERSION)
}
