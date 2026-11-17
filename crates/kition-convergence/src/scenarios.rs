//! The scenarios of architecture section 16, scripted and fuzzed.

use std::collections::{BTreeMap, BTreeSet};

use serde_json::Value;

use crate::net::Net;
use crate::state::{self, SchemaInfo};
use crate::{Blobs, KitAdapter, Options, Outcome, Report, Result, Script};

pub(crate) const SCENARIOS: &[(&str, &str)] = &[
    ("fields", "concurrent edits to different fields of one object keep both"),
    ("same-field", "concurrent edits to one field resolve to one of the written values everywhere"),
    ("create", "concurrent creation from one snapshot makes distinct ids, all kept"),
    ("text-position", "concurrent text at one position (IME composition, CJK, emoji) keeps both without loss"),
    ("text-delete-insert", "text typed inside a range deleted concurrently survives"),
    ("text-split", "a paragraph split concurrent with typing keeps the typing"),
    ("text-merge", "a paragraph merge concurrent with typing in the merged paragraph keeps the typing"),
    ("reorder", "reorder versus reorder keeps every item once"),
    ("reparent", "reparent versus reparent keeps every node once, with no cycle"),
    ("delete-edit", "delete versus edit: the delete wins and references stay valid"),
    ("duplicate-delete", "duplicate versus delete leaves valid references"),
    ("undo", "undo by one actor keeps another actor's later changes"),
    ("undo-reconnect", "undo and redo while offline keep another actor's changes after reconnecting"),
    ("delivery", "delivery in any order, with duplicates and retries, gives identical state"),
    ("crash", "a crash after a local commit and before the push recovers the change"),
    ("blobs-late", "blobs that arrive after their changes do not corrupt the document"),
    ("fuzz", "seeded random commands, undo, redo, partial delivery, and crashes on 2 to 5 replicas converge"),
];

/// Two IME results and emoji, by code point (CJK ideographs "middle" and "text", a grinning face,
/// and a thumbs-up with a skin tone modifier: two scalar values in one grapheme).
const CJK_MIDDLE: char = '\u{4E2D}';
const CJK_TEXT: char = '\u{6587}';
const EMOJI_GRIN: char = '\u{1F600}';
const EMOJI_THUMBS_UP: char = '\u{1F44D}';
const SKIN_TONE: char = '\u{1F3FD}';

/// Whether L6 needs a scenario, from what the kit has.
struct Needs {
    text: bool,
    lists: bool,
    trees: bool,
    blobs: bool,
}

fn needs<K: KitAdapter>(kit: &K) -> Result<Needs> {
    let schema = SchemaInfo::parse(kit.schema())?;
    let mut doc = kit.create()?;
    Ok(Needs { text: kit.text(&mut doc)?.is_some(), lists: schema.has_kind("list"), trees: schema.has_kind("tree"), blobs: schema.has_kind("blob") })
}

fn required(id: &str, needs: &Needs) -> bool {
    match id {
        "text-position" | "text-delete-insert" => needs.text,
        "reorder" => needs.lists,
        "reparent" => needs.trees,
        "blobs-late" => needs.blobs,
        "text-split" | "text-merge" | "duplicate-delete" => false,
        _ => true,
    }
}

pub(crate) fn run<K: KitAdapter>(kit: &K, options: &Options) -> Report {
    let mut report = Report { kit: kit.name().to_owned(), checks: Vec::new() };
    let needs = match needs(kit) {
        Ok(needs) => needs,
        Err(error) => {
            report.push("setup", "the kit makes a document and its schema parses", true, Outcome::Failed(error));
            return report;
        }
    };
    for (id, title) in SCENARIOS {
        report.push(id, title, required(id, &needs), one(kit, id, options));
    }
    report
}

pub(crate) fn run_one<K: KitAdapter>(kit: &K, id: &str, options: &Options) -> Option<Report> {
    let (id, title) = SCENARIOS.iter().find(|(known, _)| *known == id)?;
    let mut report = Report { kit: kit.name().to_owned(), checks: Vec::new() };
    let required = needs(kit).map(|needs| required(id, &needs)).unwrap_or(true);
    report.push(id, title, required, one(kit, id, options));
    Some(report)
}

/// A scenario's body: `Ok(None)` passed, `Ok(Some(why))` skipped.
type Body = Result<Option<String>>;

fn one<K: KitAdapter>(kit: &K, id: &str, options: &Options) -> Outcome {
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| match id {
        "fields" => fields(kit),
        "same-field" => same_field(kit),
        "create" => create(kit),
        "text-position" => text_position(kit),
        "text-delete-insert" => text_delete_insert(kit),
        "text-split" => text_split(kit),
        "text-merge" => text_merge(kit),
        "reorder" => reorder(kit),
        "reparent" => reparent(kit),
        "delete-edit" => delete_edit(kit),
        "duplicate-delete" => duplicate_delete(kit),
        "undo" => undo(kit),
        "undo-reconnect" => undo_reconnect(kit),
        "delivery" => delivery(kit),
        "crash" => crash(kit),
        "blobs-late" => blobs_late(kit),
        "fuzz" => fuzz(kit, options),
        _ => Err(format!("no scenario {id}")),
    }));
    // A panic in a kit is a failure of this scenario, not of the whole suite.
    match result {
        Ok(Ok(None)) => Outcome::Passed,
        Ok(Ok(Some(why))) => Outcome::Skipped(why),
        Ok(Err(error)) => Outcome::Failed(error),
        Err(panic) => Outcome::Failed(format!(
            "panicked: {}",
            panic.downcast_ref::<String>().cloned().or_else(|| panic.downcast_ref::<&str>().map(|text| (*text).to_owned())).unwrap_or_default()
        )),
    }
}

/// Runs `step` on replica `index`; returns early with a skip when the kit has no such step.
macro_rules! script {
    ($net:expr, $index:expr, $step:expr) => {{
        let step = $step;
        if !$net.script($index, &step)? {
            return Ok(Some(format!("the adapter has no {}", step_name(&step))));
        }
    }};
}

fn step_name(step: &Script) -> &'static str {
    match step {
        Script::SetField { .. } => "SetField",
        Script::Create => "Create",
        Script::Delete => "Delete",
        Script::Duplicate => "Duplicate",
        Script::Reorder { .. } => "Reorder",
        Script::Reparent { .. } => "Reparent",
        Script::InsertText { .. } => "InsertText",
        Script::DeleteText { .. } => "DeleteText",
        Script::SplitParagraph { .. } => "SplitParagraph",
        Script::MergeParagraph { .. } => "MergeParagraph",
        Script::InsertBlob { .. } => "InsertBlob",
    }
}

fn changes<K: KitAdapter>(net: &mut Net<'_, K>, index: usize, before: &Value) -> Result<(Value, BTreeMap<state::Slot, Value>)> {
    let after = net.state(index)?;
    let changed = state::register_changes(&net.schema, before, &after);
    Ok((after, changed))
}

/// Every register in `expected` has its value in `merged`.
fn expect_registers(schema: &SchemaInfo, merged: &Value, expected: &BTreeMap<state::Slot, Value>, whose: &str) -> Result<()> {
    for (slot, value) in expected {
        let found = state::register(schema, merged, slot);
        if &found != value {
            return Err(format!("{whose} change to {}.{} was lost: expected {value}, found {found}", slot.0, slot.1));
        }
    }
    Ok(())
}

fn fields<K: KitAdapter>(kit: &K) -> Body {
    let mut net = Net::new(kit, 2, 11)?;
    let base = net.settle()?;
    script!(net, 0, Script::SetField { slot: 0, value: 101 });
    script!(net, 1, Script::SetField { slot: 1, value: 202 });
    let (_, a) = changes(&mut net, 0, &base)?;
    let (_, b) = changes(&mut net, 1, &base)?;
    if a.is_empty() || b.is_empty() {
        return Err(format!("SetField changed no register (slot 0: {} changes, slot 1: {})", a.len(), b.len()));
    }
    let only_a: BTreeMap<_, _> = a.iter().filter(|(slot, _)| !b.contains_key(*slot)).map(|(k, v)| (k.clone(), v.clone())).collect();
    let only_b: BTreeMap<_, _> = b.iter().filter(|(slot, _)| !a.contains_key(*slot)).map(|(k, v)| (k.clone(), v.clone())).collect();
    if only_a.is_empty() || only_b.is_empty() {
        return Err(format!("SetField slots 0 and 1 changed the same registers: {:?}", a.keys().collect::<Vec<_>>()));
    }
    let objects_a: BTreeSet<&String> = only_a.keys().map(|slot| &slot.0).collect();
    if !only_b.keys().any(|slot| objects_a.contains(&slot.0)) {
        return Err("SetField slots 0 and 1 changed different objects; they must be two fields of one object".into());
    }
    let merged = net.settle()?;
    expect_registers(&net.schema, &merged, &only_a, "replica 0's")?;
    expect_registers(&net.schema, &merged, &only_b, "replica 1's")?;
    Ok(None)
}

fn same_field<K: KitAdapter>(kit: &K) -> Body {
    let mut net = Net::new(kit, 3, 12)?;
    let base = net.settle()?;
    let mut written = Vec::new();
    for index in 0..3 {
        script!(net, index, Script::SetField { slot: 0, value: 300 + index as u32 });
        written.push(changes(&mut net, index, &base)?.1);
    }
    let merged = net.settle()?;
    let slots: BTreeSet<&state::Slot> = written.iter().flat_map(BTreeMap::keys).collect();
    for slot in slots {
        let found = state::register(&net.schema, &merged, slot);
        if !written.iter().any(|changes| changes.get(slot) == Some(&found)) {
            return Err(format!("{}.{} resolved to {found}, which no replica wrote", slot.0, slot.1));
        }
    }
    Ok(None)
}

fn create<K: KitAdapter>(kit: &K) -> Body {
    let mut net = Net::new(kit, 3, 13)?;
    let base = net.settle()?;
    let mut made: Vec<BTreeSet<String>> = Vec::new();
    for index in 0..3 {
        script!(net, index, Script::Create);
        let ids = state::created(&base, &net.state(index)?);
        if ids.is_empty() {
            return Err(format!("Create on replica {index} created no object"));
        }
        made.push(ids);
    }
    for (index, ids) in made.iter().enumerate() {
        for (other, theirs) in made.iter().enumerate().skip(index + 1) {
            if let Some(id) = ids.intersection(theirs).next() {
                return Err(format!("replicas {index} and {other} both created {id}"));
            }
        }
    }
    let merged = net.settle()?;
    let objects = state::objects(&merged);
    for (index, ids) in made.iter().enumerate() {
        if let Some(lost) = ids.iter().find(|id| !objects.contains_key(*id)) {
            return Err(format!("replica {index}'s new object {lost} is gone after the merge"));
        }
    }
    Ok(None)
}

/// A text the suite types into: at least `min` characters in the first paragraph.
fn text_base<K: KitAdapter>(net: &mut Net<'_, K>, min: usize) -> Result<Option<String>> {
    let Some(text) = net.kit.text(net.doc(0)?)? else { return Ok(None) };
    let first = text.split('\n').next().unwrap_or_default().chars().count();
    if first < min {
        let filler: String = "abcdefgh".chars().take(min - first).collect();
        if !net.script(0, &Script::InsertText { at: first, text: filler })? {
            return Ok(None);
        }
        net.settle()?;
    }
    Ok(Some(net.text(0)?))
}

/// `text` without one occurrence of each of `parts`, or `None` when one is missing.
fn without(text: &str, parts: &[&str]) -> Option<String> {
    let mut rest = text.to_owned();
    for part in parts {
        if !rest.contains(part) {
            return None;
        }
        rest = rest.replacen(part, "", 1);
    }
    Some(rest)
}

fn text_position<K: KitAdapter>(kit: &K) -> Body {
    let mut net = Net::new(kit, 2, 14)?;
    let Some(base) = text_base(&mut net, 2)? else { return Ok(Some("the kit has no text".into())) };
    let composed: String = [CJK_MIDDLE, CJK_TEXT, EMOJI_GRIN].iter().collect();
    let theirs: String = ['X', 'Y', EMOJI_THUMBS_UP, SKIN_TONE].iter().collect();
    // Replica 0 composes with an IME: the romanisation appears, is replaced, then each result.
    script!(net, 0, Script::InsertText { at: 1, text: "zh".into() });
    script!(net, 0, Script::DeleteText { at: 1, len: 2 });
    script!(net, 0, Script::InsertText { at: 1, text: CJK_MIDDLE.to_string() });
    script!(net, 0, Script::InsertText { at: 2, text: CJK_TEXT.to_string() });
    script!(net, 0, Script::InsertText { at: 3, text: EMOJI_GRIN.to_string() });
    script!(net, 1, Script::InsertText { at: 1, text: "XY".into() });
    script!(net, 1, Script::InsertText { at: 3, text: [EMOJI_THUMBS_UP, SKIN_TONE].iter().collect() });
    net.settle()?;
    let text = net.text(0)?;
    match without(&text, &[&composed, &theirs]) {
        Some(rest) if rest == base => Ok(None),
        Some(rest) => Err(format!("the text around the insertions changed: {rest:?}, was {base:?}")),
        None => Err(format!("an insertion was lost or interleaved: {text:?}")),
    }
}

fn text_delete_insert<K: KitAdapter>(kit: &K) -> Body {
    let mut net = Net::new(kit, 2, 15)?;
    let Some(base) = text_base(&mut net, 4)? else { return Ok(Some("the kit has no text".into())) };
    script!(net, 0, Script::DeleteText { at: 1, len: 2 });
    script!(net, 1, Script::InsertText { at: 2, text: "ZZ".into() });
    net.settle()?;
    let text = net.text(0)?;
    let expected: String = base.chars().enumerate().filter(|(index, _)| !(1..3).contains(index)).map(|(_, c)| c).collect();
    match without(&text, &["ZZ"]) {
        Some(rest) if rest == expected => Ok(None),
        Some(rest) => Err(format!("after deleting 2 characters at 1 the text is {rest:?}, expected {expected:?}")),
        None => Err(format!("the typing inside the deleted range was lost: {text:?}")),
    }
}

fn newlines(text: &str) -> usize {
    text.matches('\n').count()
}

fn text_split<K: KitAdapter>(kit: &K) -> Body {
    let mut net = Net::new(kit, 2, 16)?;
    let Some(base) = text_base(&mut net, 4)? else { return Ok(Some("the kit has no text".into())) };
    script!(net, 0, Script::SplitParagraph { at: 2 });
    script!(net, 1, Script::InsertText { at: 2, text: "QQ".into() });
    script!(net, 1, Script::InsertText { at: 5, text: "WW".into() });
    net.settle()?;
    let text = net.text(0)?;
    if newlines(&text) != newlines(&base) + 1 {
        return Err(format!("the split made {} paragraph breaks out of {}: {text:?}", newlines(&text), newlines(&base)));
    }
    match without(&text, &["QQ", "WW"]) {
        Some(rest) if rest.replace('\n', "") == base.replace('\n', "") => Ok(None),
        Some(rest) => Err(format!("the split changed the text: {rest:?}, was {base:?}")),
        None => Err(format!("typing concurrent with the split was lost: {text:?}")),
    }
}

fn text_merge<K: KitAdapter>(kit: &K) -> Body {
    let mut net = Net::new(kit, 2, 17)?;
    let Some(mut base) = text_base(&mut net, 2)? else { return Ok(Some("the kit has no text".into())) };
    if !base.contains('\n') {
        let end = base.chars().count();
        script!(net, 0, Script::SplitParagraph { at: end.min(1) });
        net.settle()?;
        base = net.text(0)?;
    }
    let Some(at) = base.chars().position(|c| c == '\n') else { return Err("SplitParagraph made no paragraph break".into()) };
    script!(net, 0, Script::MergeParagraph { at });
    // Replica 1 types at the start of the paragraph replica 0 merges away, and at its end.
    script!(net, 1, Script::InsertText { at: at + 1, text: "RR".into() });
    net.settle()?;
    let text = net.text(0)?;
    if newlines(&text) + 1 != newlines(&base) {
        return Err(format!("the merge left {} paragraph breaks out of {}: {text:?}", newlines(&text), newlines(&base)));
    }
    match without(&text, &["RR"]) {
        Some(rest) if rest.replace('\n', "") == base.replace('\n', "") => Ok(None),
        Some(rest) => Err(format!("the merge changed the text: {rest:?}, was {base:?}")),
        None => Err(format!("typing in the merged paragraph was lost: {text:?}")),
    }
}

fn reorder<K: KitAdapter>(kit: &K) -> Body {
    let mut net = Net::new(kit, 2, 18)?;
    let base = net.settle()?;
    script!(net, 0, Script::Reorder { which: 0 });
    script!(net, 1, Script::Reorder { which: 1 });
    let moved = net.state(0)?;
    if state::list_sets(&net.schema, &moved) == state::list_sets(&net.schema, &base) && moved == base {
        return Err("Reorder changed nothing".into());
    }
    let merged = net.settle()?;
    let (before, after) = (state::list_sets(&net.schema, &base), state::list_sets(&net.schema, &merged));
    for (list, items) in &before {
        if let Some(now) = after.get(list)
            && now != items
        {
            let lost: Vec<_> = items.difference(now).collect();
            let added: Vec<_> = now.difference(items).collect();
            return Err(format!("{list} changed its items under concurrent reorders: lost {lost:?}, gained {added:?}"));
        }
    }
    Ok(None)
}

fn reparent<K: KitAdapter>(kit: &K) -> Body {
    let mut net = Net::new(kit, 2, 19)?;
    let base = net.settle()?;
    script!(net, 0, Script::Reparent { which: 0 });
    script!(net, 1, Script::Reparent { which: 1 });
    let merged = net.settle()?;
    let (before, after) = (state::tree_nodes(&net.schema, &base), state::tree_nodes(&net.schema, &merged));
    if before != after {
        return Err(format!("concurrent reparents changed the trees' node counts: {before:?} to {after:?}"));
    }
    Ok(None)
}

fn delete_edit<K: KitAdapter>(kit: &K) -> Body {
    let mut net = Net::new(kit, 2, 20)?;
    let base = net.settle()?;
    script!(net, 0, Script::Delete);
    script!(net, 1, Script::SetField { slot: 0, value: 707 });
    let gone = state::deleted(&base, &net.state(0)?);
    if gone.is_empty() {
        return Err("Delete deleted no object".into());
    }
    let (_, edited) = changes(&mut net, 1, &base)?;
    let merged = net.settle()?;
    let objects = state::objects(&merged);
    if let Some(back) = gone.iter().find(|id| objects.contains_key(*id)) {
        return Err(format!("{back} was deleted on replica 0 but exists after the merge (delete must win over edit)"));
    }
    let kept: BTreeMap<_, _> = edited.into_iter().filter(|(slot, _)| !gone.contains(&slot.0)).collect();
    expect_registers(&net.schema, &merged, &kept, "replica 1's")?;
    Ok(None)
}

fn duplicate_delete<K: KitAdapter>(kit: &K) -> Body {
    let mut net = Net::new(kit, 2, 21)?;
    let base = net.settle()?;
    script!(net, 0, Script::Duplicate);
    script!(net, 1, Script::Delete);
    let copies = state::created(&base, &net.state(0)?);
    if copies.is_empty() {
        return Err("Duplicate created no object".into());
    }
    net.settle()?;
    Ok(None)
}

fn undo<K: KitAdapter>(kit: &K) -> Body {
    let mut net = Net::new(kit, 2, 22)?;
    net.settle()?;
    script!(net, 0, Script::SetField { slot: 0, value: 11 });
    let base = net.settle()?;
    script!(net, 1, Script::SetField { slot: 0, value: 22 });
    script!(net, 1, Script::SetField { slot: 1, value: 23 });
    let (_, later) = changes(&mut net, 1, &base)?;
    net.settle()?;
    let kit = net.kit;
    if !kit.undo(net.doc(0)?)? {
        return Err("replica 0 had no step to undo after its edit".into());
    }
    let merged = net.settle()?;
    expect_registers(&net.schema, &merged, &later, "replica 1's later")?;
    Ok(None)
}

fn undo_reconnect<K: KitAdapter>(kit: &K) -> Body {
    let mut net = Net::new(kit, 2, 23)?;
    net.settle()?;
    let start = net.state(0)?;
    script!(net, 0, Script::SetField { slot: 1, value: 31 });
    let (_, mine) = changes(&mut net, 0, &start)?;
    let base = net.settle()?;
    // Offline: replica 1 edits, replica 0 undoes and redoes; nothing travels.
    script!(net, 1, Script::SetField { slot: 0, value: 41 });
    let (_, theirs) = changes(&mut net, 1, &base)?;
    let kit = net.kit;
    if !kit.undo(net.doc(0)?)? {
        return Err("replica 0 had no step to undo".into());
    }
    if !kit.redo(net.doc(0)?)? {
        return Err("replica 0 had no step to redo after its undo".into());
    }
    let merged = net.settle()?;
    expect_registers(&net.schema, &merged, &theirs, "replica 1's offline")?;
    let mine: BTreeMap<_, _> = mine.into_iter().filter(|(slot, _)| !theirs.contains_key(slot)).collect();
    expect_registers(&net.schema, &merged, &mine, "replica 0's redone")?;
    Ok(None)
}

/// One edit on a replica: a random command, falling back to a scripted one when the random pick
/// did not apply.
fn edit<K: KitAdapter>(net: &mut Net<'_, K>, index: usize, salt: u32) -> Result<String> {
    let kit = net.kit;
    for _ in 0..8 {
        let mut rng = std::mem::replace(&mut net.rng, crate::Rng::new(0));
        let label = kit.random_edit(net.doc(index)?, &mut rng);
        net.rng = rng;
        if let Some(label) = label? {
            return Ok(label);
        }
    }
    if net.script(index, &Script::SetField { slot: (salt % 2) as u8, value: 9000 + salt })? {
        return Ok("SetField".into());
    }
    Err("random_edit applied nothing in 8 tries and the adapter has no SetField".into())
}

/// The changes `index` made since `since`, and its new version.
fn increment<K: KitAdapter>(net: &mut Net<'_, K>, index: usize, since: &[u8]) -> Result<(Vec<u8>, Vec<u8>)> {
    let kit = net.kit;
    let doc = net.doc(index)?;
    let bytes = kit.export_changes(doc, since)?;
    Ok((bytes, kit.version(doc)?))
}

fn delivery<K: KitAdapter>(kit: &K) -> Body {
    let mut net = Net::new(kit, 3, 24)?;
    let count = net.docs.len();
    let mut sent: Vec<Vec<u8>> = (0..count).map(|index| net.kit.version(net.doc(index)?)).collect::<Result<_>>()?;
    let mut pool: Vec<Vec<u8>> = Vec::new();
    let mut blobs = Blobs::new();
    for round in 0..4u32 {
        for (index, since) in sent.iter_mut().enumerate() {
            edit(&mut net, index, round * 10 + index as u32)?;
            let (bytes, version) = increment(&mut net, index, since)?;
            pool.push(bytes);
            *since = version;
        }
        if round == 1 {
            // Some causal chains: everything so far reaches everyone before the next edits.
            net.sync()?;
        }
    }
    net.sync()?;
    for (index, since) in sent.iter().enumerate() {
        pool.push(increment(&mut net, index, since)?.0);
        blobs.extend(net.kit.blobs(net.doc(index)?)?);
    }
    let reference = net.check()?;
    // Two late replicas from the first snapshot: one takes the changes shuffled with duplicates,
    // the other in reverse, each twice in a row (a retry).
    let (snapshot, initial_blobs) = net.initial.clone();
    let mut late = Vec::new();
    for order in 0..2 {
        let mut doc = kit.join(&snapshot, &initial_blobs)?;
        kit.add_blobs(&mut doc, &blobs)?;
        let mut messages = pool.clone();
        if order == 0 {
            net.rng.shuffle(&mut messages);
            for _ in 0..pool.len() / 2 {
                let again = net.rng.below(messages.len());
                let copy = messages.get(again).cloned().unwrap_or_default();
                messages.insert(net.rng.below(messages.len() + 1), copy);
            }
        } else {
            messages.reverse();
            messages = messages.into_iter().flat_map(|bytes| [bytes.clone(), bytes]).collect();
        }
        for (step, bytes) in messages.iter().enumerate() {
            kit.import_changes(&mut doc, bytes).map_err(|error| format!("late replica {order} at message {step}: {error}"))?;
        }
        let state = kit.state(&mut doc)?;
        if state != reference {
            // Its own repairs of states the others never had are changes too: they must
            // converge once exchanged.
            let at = state::first_difference(&reference, &state).unwrap_or_default();
            late.push(format!("late replica {order} differs at {at} before exchanging its own changes"));
        }
        net.docs.push(doc);
    }
    net.settle().map_err(|error| if late.is_empty() { error } else { format!("{error} ({})", late.join("; ")) })?;
    Ok(None)
}

/// What a replica keeps on disk: the last saved snapshot, its blobs, and the changes committed
/// since, appended at each commit (standard 2.0 P5).
#[derive(Clone)]
struct Disk {
    snapshot: Vec<u8>,
    blobs: Blobs,
    log: Vec<Vec<u8>>,
}

impl Disk {
    fn save<K: KitAdapter>(kit: &K, doc: &mut K::Doc) -> Result<Self> {
        Ok(Self { snapshot: kit.snapshot(doc)?, blobs: kit.blobs(doc)?, log: Vec::new() })
    }

    /// The replica as reopened after a crash.
    fn recover<K: KitAdapter>(&self, kit: &K) -> Result<K::Doc> {
        let mut doc = kit.join(&self.snapshot, &self.blobs).map_err(|error| format!("reopening the saved snapshot: {error}"))?;
        for (index, bytes) in self.log.iter().enumerate() {
            kit.import_changes(&mut doc, bytes).map_err(|error| format!("replaying logged commit {index}: {error}"))?;
        }
        Ok(doc)
    }
}

fn crash<K: KitAdapter>(kit: &K) -> Body {
    let mut net = Net::new(kit, 2, 25)?;
    let mut disk = Disk { snapshot: net.initial.0.clone(), blobs: net.initial.1.clone(), log: Vec::new() };
    let mut since = kit.version(net.doc(0)?)?;
    for step in 0..6u32 {
        if step == 2 {
            disk = Disk::save(kit, net.doc(0)?)?;
            since = kit.version(net.doc(0)?)?;
        }
        edit(&mut net, 0, step)?;
        let (bytes, version) = increment(&mut net, 0, &since)?;
        disk.log.push(bytes);
        disk.blobs.extend(kit.blobs(net.doc(0)?)?);
        since = version;
    }
    let before = net.state(0)?;
    // The crash: replica 0 is gone before it pushed anything; it reopens from its disk.
    let recovered = disk.recover(kit)?;
    if let Some(doc) = net.docs.get_mut(0) {
        *doc = recovered;
    }
    let after = net.state(0)?;
    if after != before {
        return Err(format!("the recovered replica differs at {}", state::first_difference(&before, &after).unwrap_or_default()));
    }
    let merged = net.settle()?;
    if merged != before {
        return Err(format!("the recovered changes did not reach the peer: {}", state::first_difference(&before, &merged).unwrap_or_default()));
    }
    Ok(None)
}

fn blob_hashes(schema: &SchemaInfo, state: &Value) -> BTreeSet<String> {
    let mut out = BTreeSet::new();
    for object in state::objects(state).values() {
        let ty = object["$type"].as_str().unwrap_or_default();
        for (name, field) in schema.types.get(ty).into_iter().flatten() {
            if field.kind == "blob"
                && let Some(hash) = object[name.as_str()]["hash"].as_str()
            {
                out.insert(hash.to_owned());
            }
        }
    }
    out
}

fn blobs_late<K: KitAdapter>(kit: &K) -> Body {
    let mut net = Net::new(kit, 2, 26)?;
    net.settle()?;
    let before_b = net.state(1)?;
    script!(net, 0, Script::InsertBlob { seed: 7 });
    let a_state = net.state(0)?;
    let since = kit.version(net.doc(1)?)?;
    let bytes = kit.export_changes(net.doc(0)?, &since)?;
    // The changes arrive, the blobs do not (yet).
    let early = kit.import_changes(net.doc(1)?, &bytes);
    let b_state = net.state(1)?;
    match &early {
        Ok(()) if b_state != a_state => {
            return Err(format!("changes imported without their blobs differ at {}", state::first_difference(&a_state, &b_state).unwrap_or_default()));
        }
        Err(_) if b_state != before_b => return Err("a refused import without blobs changed the replica".into()),
        _ => {}
    }
    // An edit meanwhile must not corrupt anything either.
    edit(&mut net, 1, 1)?;
    let blobs = kit.blobs(net.doc(0)?)?;
    kit.add_blobs(net.doc(1)?, &blobs)?;
    kit.import_changes(net.doc(1)?, &bytes).map_err(|error| format!("importing again once the blobs arrived: {error}"))?;
    let merged = net.settle()?;
    let held = kit.blobs(net.doc(1)?)?;
    if !held.is_empty()
        && let Some(missing) = blob_hashes(&net.schema, &merged).into_iter().find(|hash| !held.contains_key(hash))
    {
        return Err(format!("replica 1 references blob {missing} it does not hold once the blobs arrived"));
    }
    for index in 0..2 {
        kit.export_file(net.doc(index)?).map_err(|error| format!("replica {index} cannot save after the late blobs: {error}"))?;
    }
    Ok(None)
}

/// One message in flight: changes and the blobs they may need.
struct Message {
    bytes: Vec<u8>,
    blobs: Blobs,
}

fn fuzz<K: KitAdapter>(kit: &K, options: &Options) -> Body {
    for &count in &options.replicas {
        for &seed in &options.seeds {
            fuzz_once(kit, count, seed, options.steps).map_err(|error| format!("{count} replicas, seed {seed}: {error}"))?;
        }
    }
    Ok(None)
}

fn fuzz_once<K: KitAdapter>(kit: &K, count: usize, seed: u64, steps: usize) -> Result<()> {
    let mut net = Net::new(kit, count, seed)?;
    let mut sent: Vec<Vec<u8>> = (0..count).map(|index| kit.version(net.doc(index)?)).collect::<Result<_>>()?;
    let mut disks: Vec<Disk> = (0..count).map(|_| Disk { snapshot: net.initial.0.clone(), blobs: net.initial.1.clone(), log: Vec::new() }).collect();
    let mut inbox: Vec<Vec<Message>> = (0..count).map(|_| Vec::new()).collect();
    let mut log: Vec<String> = Vec::new();
    let trail = |log: &[String]| log.iter().rev().take(12).rev().cloned().collect::<Vec<_>>().join(", ");
    for step in 0..steps {
        let index = net.rng.below(count);
        let roll = net.rng.below(100);
        let label = (|| -> Result<String> {
            let label = match roll {
                0..55 => edit(&mut net, index, step as u32)?,
                55..62 => format!("undo={}", kit.undo(net.doc(index)?)?),
                62..67 => format!("redo={}", kit.redo(net.doc(index)?)?),
                67..90 => {
                    let Some(queue) = inbox.get_mut(index) else { return Ok("idle".into()) };
                    if queue.is_empty() {
                        return Ok("idle".into());
                    }
                    let at = net.rng.below(queue.len());
                    // Sometimes the message stays queued: it arrives again later (a duplicate).
                    let message = if net.rng.chance(20) {
                        queue.get(at).map(|m| Message { bytes: m.bytes.clone(), blobs: m.blobs.clone() })
                    } else {
                        Some(queue.remove(at))
                    };
                    let Some(message) = message else { return Ok("idle".into()) };
                    let doc = net.doc(index)?;
                    kit.add_blobs(doc, &message.blobs)?;
                    kit.import_changes(doc, &message.bytes)?;
                    "deliver".into()
                }
                90..95 => {
                    // Every commit was sent already, so the disk's log restarts from here.
                    let disk = Disk::save(kit, net.doc(index)?)?;
                    if let Some(slot) = disks.get_mut(index) {
                        *slot = disk;
                    }
                    "save".into()
                }
                _ => {
                    let before = net.state(index)?;
                    let recovered = disks.get(index).ok_or("no disk")?.recover(kit)?;
                    if let Some(doc) = net.docs.get_mut(index) {
                        *doc = recovered;
                    }
                    let after = net.state(index)?;
                    if after != before {
                        return Err(format!("the recovered replica differs at {}", state::first_difference(&before, &after).unwrap_or_default()));
                    }
                    if let Some(since) = sent.get_mut(index) {
                        *since = kit.version(net.doc(index)?)?;
                    }
                    "crash".into()
                }
            };
            Ok(label)
        })()
        .map_err(|error| format!("step {step} on replica {index}: {error}; after {}", trail(&log)))?;
        log.push(format!("{index}:{label}"));
        // Commit: what the replica has that it has not sent goes to its disk log and to everyone.
        let since = sent.get(index).cloned().unwrap_or_default();
        let (bytes, version) = increment(&mut net, index, &since)?;
        if version != since {
            let blobs = kit.blobs(net.doc(index)?)?;
            if let Some(disk) = disks.get_mut(index) {
                disk.log.push(bytes.clone());
                disk.blobs.extend(blobs.clone());
            }
            for (to, queue) in inbox.iter_mut().enumerate() {
                if to != index {
                    queue.push(Message { bytes: bytes.clone(), blobs: blobs.clone() });
                }
            }
            if let Some(slot) = sent.get_mut(index) {
                *slot = version;
            }
        }
    }
    // Everything still in flight arrives, in a shuffled order, then the replicas reconnect.
    for (index, queue) in inbox.iter_mut().enumerate() {
        net.rng.shuffle(queue);
        for message in queue.drain(..) {
            let doc = net.docs.get_mut(index).ok_or("no replica")?;
            kit.add_blobs(doc, &message.blobs)?;
            kit.import_changes(doc, &message.bytes).map_err(|error| format!("final delivery to replica {index}: {error}; after {}", trail(&log)))?;
        }
    }
    net.settle().map_err(|error| format!("{error}; after {}", trail(&log)))?;
    Ok(())
}
