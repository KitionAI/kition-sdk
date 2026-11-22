use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard, PoisonError};

/// The engine's lent files are process-wide: every `Headless` points `kition_kit::host`'s lender,
/// handles, root and hosting at its own workspace before each document call (`lend_for`), so a test
/// serving a document while another reads a lent file swaps that file's lender under it (a read of
/// `/media/clip.bin` answered "no such file" from another test's workspace). Every test of this
/// crate that serves a document through a `Headless`, directly or through `agent_ready`, takes its
/// turn here for the whole test.
static LENT: Mutex<()> = Mutex::new(());

/// This test's turn with the process-wide lent files (see `LENT`); held until it is dropped.
pub fn lent_turn() -> MutexGuard<'static, ()> {
    LENT.lock().unwrap_or_else(PoisonError::into_inner)
}

/// Find a built workspace binary from any Cargo test executable layout.
pub fn workspace_binary(name: &str) -> Option<PathBuf> {
    let path = std::env::current_exe().ok().and_then(|exe| {
        let name = format!("{name}{}", std::env::consts::EXE_SUFFIX);
        exe.parent()?.ancestors().map(|dir| dir.join(&name)).find(|path| path.is_file())
    });
    assert!(path.is_some() || std::env::var_os("CI").is_none(), "build {name} first (cargo build -p {name})");
    path
}
