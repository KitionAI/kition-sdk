//! Replicas of one document and the exchange between them.

use serde_json::Value;

use crate::state::{self, SchemaInfo};
use crate::{Blobs, KitAdapter, Result, Rng, Script};

/// `count` replicas of one new document: the first made by [`KitAdapter::create`], the others
/// joined from its snapshot. Public so a kit can write scenarios of its own on the same harness.
pub struct Net<'k, K: KitAdapter> {
    pub kit: &'k K,
    pub docs: Vec<K::Doc>,
    pub schema: SchemaInfo,
    pub rng: Rng,
    /// The snapshot and blobs every replica started from.
    pub initial: (Vec<u8>, Blobs),
}

impl<'k, K: KitAdapter> Net<'k, K> {
    pub fn new(kit: &'k K, count: usize, seed: u64) -> Result<Self> {
        let schema = SchemaInfo::parse(kit.schema())?;
        let mut first = kit.create().map_err(|error| format!("create: {error}"))?;
        let snapshot = kit.snapshot(&mut first)?;
        let blobs = kit.blobs(&mut first)?;
        let mut docs = vec![first];
        for _ in 1..count.max(1) {
            docs.push(kit.join(&snapshot, &blobs).map_err(|error| format!("join: {error}"))?);
        }
        Ok(Self { kit, docs, schema, rng: Rng::new(seed), initial: (snapshot, blobs) })
    }

    pub fn doc(&mut self, index: usize) -> Result<&mut K::Doc> {
        let len = self.docs.len();
        self.docs.get_mut(index).ok_or_else(|| format!("no replica {index} of {len}"))
    }

    pub fn state(&mut self, index: usize) -> Result<Value> {
        let kit = self.kit;
        kit.state(self.doc(index)?)
    }

    /// Runs a scripted step on one replica; `Ok(false)` when the kit has no such step.
    pub fn script(&mut self, index: usize, step: &Script) -> Result<bool> {
        let kit = self.kit;
        kit.script(self.doc(index)?, step).map_err(|error| format!("replica {index}: {step:?}: {error}"))
    }

    /// Like [`Net::script`], and fails when the kit has no such step.
    pub fn must(&mut self, index: usize, step: &Script) -> Result<()> {
        if self.script(index, step)? { Ok(()) } else { Err(format!("the adapter does not support {step:?}")) }
    }

    pub fn text(&mut self, index: usize) -> Result<String> {
        let kit = self.kit;
        kit.text(self.doc(index)?)?.ok_or_else(|| "the adapter has no text".to_owned())
    }

    /// Sends `to` what it lacks from `from`, blobs first.
    pub fn deliver(&mut self, from: usize, to: usize) -> Result<()> {
        let kit = self.kit;
        let since = kit.version(self.doc(to)?)?;
        let bytes = kit.export_changes(self.doc(from)?, &since)?;
        let blobs = kit.blobs(self.doc(from)?)?;
        let target = self.doc(to)?;
        kit.add_blobs(target, &blobs)?;
        kit.import_changes(target, &bytes).map_err(|error| format!("replica {to} importing from {from}: {error}"))
    }

    /// Delivers every replica's changes to every other in seeded orders until no state changes
    /// (repairs made on import travel too), then sends everything again from scratch to prove
    /// duplicates harmless.
    pub fn sync(&mut self) -> Result<()> {
        let count = self.docs.len();
        let mut pairs: Vec<(usize, usize)> = (0..count).flat_map(|from| (0..count).filter(move |to| *to != from).map(move |to| (from, to))).collect();
        let mut previous: Option<Vec<Value>> = None;
        for _ in 0..12 {
            self.rng.shuffle(&mut pairs);
            for &(from, to) in &pairs {
                self.deliver(from, to)?;
            }
            let states = (0..count).map(|index| self.state(index)).collect::<Result<Vec<_>>>()?;
            if previous.as_ref() == Some(&states) {
                break;
            }
            previous = Some(states);
        }
        for &(from, to) in &pairs {
            let kit = self.kit;
            let bytes = kit.export_changes(self.doc(from)?, &[])?;
            kit.import_changes(self.doc(to)?, &bytes).map_err(|error| format!("replica {to} importing a duplicate of everything from {from}: {error}"))?;
        }
        Ok(())
    }

    /// The common state, or the first difference.
    pub fn converged(&mut self) -> Result<Value> {
        let first = self.state(0)?;
        for index in 1..self.docs.len() {
            let other = self.state(index)?;
            if other != first {
                let at = state::first_difference(&first, &other).unwrap_or_default();
                return Err(format!("replicas 0 and {index} differ at {at}"));
            }
        }
        Ok(first)
    }

    /// [`Net::converged`], the schema's references, and every replica's view.
    pub fn check(&mut self) -> Result<Value> {
        let state = self.converged()?;
        let kit = self.kit;
        state::check_references(&self.schema, &state, &|ty, field| kit.allows_dangling(ty, field))?;
        for index in 0..self.docs.len() {
            kit.check_view(self.doc(index)?).map_err(|error| format!("replica {index}'s view: {error}"))?;
        }
        Ok(state)
    }

    /// [`Net::sync`] then [`Net::check`].
    pub fn settle(&mut self) -> Result<Value> {
        self.sync()?;
        self.check()
    }
}
