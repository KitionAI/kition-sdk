//! Native and WebAssembly builds reach identical state from identical change logs.
//!
//! [`record`] makes a change log: three replicas edit concurrently and their changes are put in a
//! shuffled order (so some arrive before what they depend on). [`replay_native`] imports the log
//! into a replica opened from the log's snapshot. [`replay_wasm`] does the same in Node with the
//! kit's built WebAssembly engine (its `openWithReplica`, `importChanges`, and `snapshot`, the
//! members every contract 2 engine has) through `tools/convergence-wasm.mjs`, embedded here, and
//! [`check_parity`] compares the two canonical states, repairs included.
//!
//! A kit's test runs it when `KITION_WASM_ENGINE` names a folder with the engine's
//! `<module>.js` and `<module>_bg.wasm` (a package's `engine/`, or a `wasm-pack` output):
//!
//! ```ignore
//! if let Some(engine) = WasmEngine::from_env("kition_doc_kit", "DocDocument", "Document.docx") {
//!     wasm::check_parity(&WordKit, &engine, Path::new(env!("CARGO_TARGET_TMPDIR")), 1).unwrap();
//! }
//! ```

use std::path::{Path, PathBuf};
use std::process::Command;

use serde_json::{Value, json};

use crate::net::Net;
use crate::{Blobs, KitAdapter, Result, state};

const RUNNER: &str = include_str!("../../../tools/convergence-wasm.mjs");

/// A kit's built WebAssembly engine.
#[derive(Clone, Debug)]
pub struct WasmEngine {
    /// The folder with `<module>.js` and `<module>_bg.wasm`.
    pub dir: PathBuf,
    pub module: String,
    pub class: String,
    /// The name the document opens as (its extension picks the format).
    pub file_name: String,
    /// The Node executable.
    pub node: PathBuf,
}

impl WasmEngine {
    /// The engine in `KITION_WASM_ENGINE`, or `None` when it is not set.
    pub fn from_env(module: &str, class: &str, file_name: &str) -> Option<Self> {
        let dir = std::env::var_os("KITION_WASM_ENGINE")?;
        Some(Self {
            dir: PathBuf::from(dir),
            module: module.to_owned(),
            class: class.to_owned(),
            file_name: file_name.to_owned(),
            node: std::env::var_os("NODE").map_or_else(|| PathBuf::from("node"), PathBuf::from),
        })
    }
}

/// A change log: the snapshot every replica started from, its blobs, and the changes in delivery
/// order.
#[derive(Clone, Debug, Default)]
pub struct Trace {
    pub snapshot: Vec<u8>,
    pub blobs: Blobs,
    pub changes: Vec<Vec<u8>>,
}

/// Records a trace from `edits` rounds of concurrent edits on three replicas.
pub fn record<K: KitAdapter>(kit: &K, seed: u64, edits: usize) -> Result<Trace> {
    let mut net = Net::new(kit, 3, seed)?;
    let mut sent: Vec<Vec<u8>> = (0..3).map(|index| kit.version(net.doc(index)?)).collect::<Result<_>>()?;
    let mut changes = Vec::new();
    let mut blobs = net.initial.1.clone();
    for round in 0..edits {
        let index = round % 3;
        let mut rng = std::mem::replace(&mut net.rng, crate::Rng::new(0));
        let edited = kit.random_edit(net.doc(index)?, &mut rng);
        net.rng = rng;
        edited?;
        if round % 7 == 6 {
            // Some causal chains.
            let from = net.rng.below(3);
            net.deliver(from, (from + 1) % 3)?;
        }
        let since = sent.get(index).cloned().unwrap_or_default();
        let doc = net.doc(index)?;
        let version = kit.version(doc)?;
        if version != since {
            changes.push(kit.export_changes(doc, &since)?);
            blobs.extend(kit.blobs(doc)?);
            if let Some(slot) = sent.get_mut(index) {
                *slot = version;
            }
        }
    }
    net.rng.shuffle(&mut changes);
    Ok(Trace { snapshot: net.initial.0.clone(), blobs, changes })
}

/// The state a native replica reaches from `trace`.
pub fn replay_native<K: KitAdapter>(kit: &K, trace: &Trace) -> Result<Value> {
    let mut doc = kit.join(&trace.snapshot, &trace.blobs)?;
    for (index, bytes) in trace.changes.iter().enumerate() {
        kit.import_changes(&mut doc, bytes).map_err(|error| format!("native change {index}: {error}"))?;
    }
    kit.state(&mut doc)
}

/// Blobs as `openWithReplica` takes them: `(64-character hex SHA-256, u64 LE length, bytes) * N`.
pub fn encode_blobs(blobs: &Blobs) -> Vec<u8> {
    let mut out = Vec::new();
    for (hash, bytes) in blobs {
        out.extend_from_slice(hash.as_bytes());
        out.extend_from_slice(&(bytes.len() as u64).to_le_bytes());
        out.extend_from_slice(bytes);
    }
    out
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// The snapshot the WebAssembly engine makes from `trace`; `scratch` holds the runner's files.
pub fn replay_wasm(engine: &WasmEngine, trace: &Trace, scratch: &Path) -> Result<Vec<u8>> {
    std::fs::create_dir_all(scratch).map_err(|error| format!("{}: {error}", scratch.display()))?;
    let runner = scratch.join("convergence-wasm.mjs");
    let trace_path = scratch.join(format!("{}-trace.json", engine.module));
    let out = scratch.join(format!("{}-snapshot.bin", engine.module));
    let body = json!({
        "snapshot": hex(&trace.snapshot),
        "blobs": hex(&encode_blobs(&trace.blobs)),
        "changes": trace.changes.iter().map(|bytes| hex(bytes)).collect::<Vec<_>>(),
    });
    std::fs::write(&runner, RUNNER).map_err(|error| error.to_string())?;
    std::fs::write(&trace_path, body.to_string()).map_err(|error| error.to_string())?;
    let output = Command::new(&engine.node)
        .arg(&runner)
        .arg(&engine.dir)
        .arg(&engine.module)
        .arg(&engine.class)
        .arg(&engine.file_name)
        .arg(&trace_path)
        .arg(&out)
        .output()
        .map_err(|error| format!("cannot run {}: {error}", engine.node.display()))?;
    if !output.status.success() {
        return Err(format!("the WebAssembly replay failed: {}{}", String::from_utf8_lossy(&output.stderr), String::from_utf8_lossy(&output.stdout)));
    }
    std::fs::read(&out).map_err(|error| format!("{}: {error}", out.display()))
}

/// Records a trace, replays it natively and in WebAssembly, and compares the states.
pub fn check_parity<K: KitAdapter>(kit: &K, engine: &WasmEngine, scratch: &Path, seed: u64) -> Result<()> {
    let trace = record(kit, seed, 30)?;
    let native = replay_native(kit, &trace)?;
    let snapshot = replay_wasm(engine, &trace, scratch)?;
    let mut doc = kit.join(&snapshot, &trace.blobs).map_err(|error| format!("opening the WebAssembly snapshot natively: {error}"))?;
    let wasm = kit.state(&mut doc)?;
    if wasm != native {
        return Err(format!("native and WebAssembly states differ at {}", state::first_difference(&native, &wasm).unwrap_or_default()));
    }
    Ok(())
}
