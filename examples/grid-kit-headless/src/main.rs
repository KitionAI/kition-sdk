//! `kit-grid`: the reference grid kit for Kition's agent, served by `kition-headless` as its
//! `kit.json` declares it. A grid file holds the grid alone (no replica: the kit makes one when it
//! opens a file), so it says so (`FileIdentity::NotEmbedded`) and `document.identity` answers no
//! identity and `document.fork` copies the bytes.

use kition_headless::{FileIdentity, Headless, KitInfo};

fn main() -> std::process::ExitCode {
    let kit = match KitInfo::from_manifest(include_str!("../../grid-kit/kit.json"), &[], &[]) {
        Ok(kit) => kit,
        Err(error) => {
            eprintln!("kit: {error}");
            return std::process::ExitCode::from(2);
        }
    };
    let backend = Headless::<grid_kit::GridDocument>::new(kit.clone()).with_file_identity(FileIdentity::NotEmbedded);
    kition_headless::serve_backend(&kit, backend)
}
