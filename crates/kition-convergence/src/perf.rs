//! The suite's performance mode: the per-kit budgets of Kition's `docs/kits.md` section 7.
//!
//! - **open**: a new replica from a snapshot of a working document (median of 5);
//! - **remote**: one replica applying 1,000 remote changes, each its own import;
//! - **keystroke**: one [`KitAdapter::keystroke`] (an edit and the repaint it causes), median and
//!   95th percentile;
//! - **memory**: heap bytes one more replica of the document holds (with [`CountingAlloc`]).
//!
//! Run it in release builds; debug timings mean little.

use std::time::{Duration, Instant};

use crate::{CountingAlloc, KitAdapter, Result, Rng};

#[derive(Clone, Debug)]
pub struct PerfOptions {
    /// Random edits that make the working document, when the adapter has no
    /// [`KitAdapter::large`] one.
    pub edits: usize,
    pub remote_changes: usize,
    pub keystrokes: usize,
    pub seed: u64,
    /// The test binary's global allocator, for the memory figure.
    pub allocator: Option<&'static CountingAlloc>,
}

impl Default for PerfOptions {
    fn default() -> Self {
        Self { edits: 200, remote_changes: 1000, keystrokes: 200, seed: 7, allocator: None }
    }
}

/// The measurements, in milliseconds and bytes.
#[derive(Clone, Debug, Default)]
pub struct PerfReport {
    pub kit: String,
    /// Objects in the working document.
    pub objects: usize,
    pub snapshot_bytes: usize,
    pub open_ms: f64,
    /// How many remote changes were applied (`remote_changes`, unless the kit's edits ran dry).
    pub remote_changes: usize,
    pub remote_ms: f64,
    pub keystroke_p50_ms: f64,
    pub keystroke_p95_ms: f64,
    pub memory_bytes: Option<usize>,
}

impl PerfReport {
    /// One line, as the budget table reads.
    pub fn render(&self) -> String {
        let memory = self.memory_bytes.map_or_else(|| "n/a".to_owned(), |bytes| format!("{:.1} MB", bytes as f64 / 1_048_576.0));
        format!(
            "{}: {} objects, snapshot {:.1} KB; open {:.1} ms; {} remote changes {:.1} ms; keystroke p50 {:.2} ms, p95 {:.2} ms; memory per replica {memory}",
            self.kit,
            self.objects,
            self.snapshot_bytes as f64 / 1024.0,
            self.open_ms,
            self.remote_changes,
            self.remote_ms,
            self.keystroke_p50_ms,
            self.keystroke_p95_ms,
        )
    }
}

fn ms(duration: Duration) -> f64 {
    duration.as_secs_f64() * 1000.0
}

fn percentile(samples: &mut [f64], at: f64) -> f64 {
    samples.sort_by(f64::total_cmp);
    let index = ((samples.len() as f64 - 1.0) * at).round() as usize;
    samples.get(index).copied().unwrap_or_default()
}

/// Measures `kit`.
pub fn measure<K: KitAdapter>(kit: &K, options: &PerfOptions) -> Result<PerfReport> {
    let mut rng = Rng::new(options.seed);
    let mut doc = match kit.large()? {
        Some(doc) => doc,
        None => {
            let mut doc = kit.create()?;
            for _ in 0..options.edits {
                kit.random_edit(&mut doc, &mut rng)?;
            }
            doc
        }
    };
    let snapshot = kit.snapshot(&mut doc)?;
    let blobs = kit.blobs(&mut doc)?;
    let objects = crate::state::objects(&kit.state(&mut doc)?).len();

    let mut opens = Vec::new();
    for _ in 0..5 {
        let start = Instant::now();
        let replica = kit.join(&snapshot, &blobs)?;
        opens.push(ms(start.elapsed()));
        drop(replica);
    }

    let memory_bytes = match options.allocator {
        Some(allocator) => {
            let before = allocator.live();
            let replica = kit.join(&snapshot, &blobs)?;
            let after = allocator.live();
            drop(replica);
            Some(usize::try_from(after - before).unwrap_or_default())
        }
        None => None,
    };

    // 1,000 remote changes: one replica edits, each edit its own change; another applies them.
    let mut author = kit.join(&snapshot, &blobs)?;
    let mut changes = Vec::new();
    let mut since = kit.version(&mut author)?;
    let mut tries = 0;
    while changes.len() < options.remote_changes && tries < options.remote_changes * 5 {
        tries += 1;
        if kit.random_edit(&mut author, &mut rng)?.is_none() {
            continue;
        }
        let version = kit.version(&mut author)?;
        if version != since {
            changes.push(kit.export_changes(&mut author, &since)?);
            since = version;
        }
    }
    let author_blobs = kit.blobs(&mut author)?;
    let mut reader = kit.join(&snapshot, &blobs)?;
    kit.add_blobs(&mut reader, &author_blobs)?;
    let start = Instant::now();
    for bytes in &changes {
        kit.import_changes(&mut reader, bytes)?;
    }
    let remote_ms = ms(start.elapsed());

    let mut typist = kit.join(&snapshot, &blobs)?;
    let mut strokes = Vec::new();
    for _ in 0..options.keystrokes {
        let start = Instant::now();
        kit.keystroke(&mut typist, &mut rng)?;
        strokes.push(ms(start.elapsed()));
    }

    Ok(PerfReport {
        kit: kit.name().to_owned(),
        objects,
        snapshot_bytes: snapshot.len(),
        open_ms: percentile(&mut opens, 0.5),
        remote_changes: changes.len(),
        remote_ms,
        keystroke_p50_ms: percentile(&mut strokes.clone(), 0.5),
        keystroke_p95_ms: percentile(&mut strokes, 0.95),
        memory_bytes,
    })
}
