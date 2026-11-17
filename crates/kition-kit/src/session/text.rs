//! Character-level writes of KDM text fields for bridges (plan K2).
//!
//! A bridge that holds a paragraph, a text box, or a cell as a string and its runs writes the
//! difference between the old and the new form, not a replacement: [`write_text`] turns two
//! strings into insertions and deletions, [`write_marks`] turns two run lists over one text into
//! mark and unmark ranges, and [`write_rich_text`] does both. Concurrent typing in one paragraph
//! then merges by character (rule M19 for marks). Positions are Unicode scalar values (rule M18).

use std::collections::{BTreeMap, BTreeSet};

use kition_kdm::{ObjectId, Tx};
use serde_json::Value;

pub use kition_kdm::TextRun;

use super::{KitError, Result};

/// A run's marks by key.
type Marks = BTreeMap<String, Value>;

/// One replacement in a text: `delete` scalar values at `index` of the old text give way to
/// `insert`. [`diff_text`] answers them in ascending, non-overlapping order.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TextEdit {
    pub index: usize,
    pub delete: usize,
    pub insert: String,
}

/// The largest edit distance (characters inserted plus deleted) [`diff_text`] searches for
/// between the common prefix and suffix. Beyond it the middle is replaced as a whole: still
/// correct, only coarser when merged with a concurrent edit there. Memory grows with its square.
pub const DIFF_BUDGET: usize = 1024;

/// The edits that turn `old` into `new`: the common prefix and suffix are kept, and the middle is
/// diffed by Myers' algorithm with at most [`DIFF_BUDGET`] insertions and deletions (one
/// replacement of the middle beyond it). Equal texts answer no edits.
pub fn diff_text(old: &str, new: &str) -> Vec<TextEdit> {
    let a: Vec<char> = old.chars().collect();
    let b: Vec<char> = new.chars().collect();
    let prefix = a.iter().zip(&b).take_while(|(x, y)| x == y).count();
    let rest = a.len().min(b.len()) - prefix;
    let suffix = a.iter().rev().zip(b.iter().rev()).take(rest).take_while(|(x, y)| x == y).count();
    let (a_mid, b_mid) = (&a[prefix..a.len() - suffix], &b[prefix..b.len() - suffix]);
    if a_mid.is_empty() && b_mid.is_empty() {
        return Vec::new();
    }
    let replace_all = || vec![TextEdit { index: prefix, delete: a_mid.len(), insert: b_mid.iter().collect() }];
    if a_mid.is_empty() || b_mid.is_empty() {
        return replace_all();
    }
    match myers(a_mid, b_mid, DIFF_BUDGET) {
        Some(steps) => group(&steps, b_mid, prefix),
        None => replace_all(),
    }
}

/// Writes `new` over a text field that holds `old` (the bridge's last view of it) as insertions
/// and deletions, and answers the edits. `old` must be the field's current text, including this
/// transaction's earlier edits.
pub fn write_text(tx: &mut Tx<'_>, id: &ObjectId, field: &str, old: &str, new: &str) -> Result<Vec<TextEdit>> {
    let edits = diff_text(old, new);
    // Last edit first, so every index still counts in the old text.
    for edit in edits.iter().rev() {
        if edit.delete > 0 {
            tx.text_delete(id, field, edit.index, edit.delete)?;
        }
        if !edit.insert.is_empty() {
            tx.text_insert(id, field, edit.index, &edit.insert)?;
        }
    }
    Ok(edits)
}

/// Writes the marks of `new_runs` over a text field whose marks are `old_runs`: for each mark
/// key, the ranges whose value changed are marked (or unmarked when the new runs lack the key).
/// Both lists cover the field's current text, the same characters; otherwise a [`KitError`].
pub fn write_marks(tx: &mut Tx<'_>, id: &ObjectId, field: &str, old_runs: &[TextRun], new_runs: &[TextRun]) -> Result<()> {
    let old_text: String = old_runs.iter().map(|run| run.insert.as_str()).collect();
    let new_text: String = new_runs.iter().map(|run| run.insert.as_str()).collect();
    if old_text != new_text {
        return Err(KitError::new("write_marks: the old and new runs cover different texts; use write_rich_text"));
    }
    let before = old_runs.iter().map(|run| Span { len: run.insert.chars().count(), marks: Some(&run.attributes) }).collect();
    apply_marks(tx, id, field, before, new_runs)
}

/// Writes `new_runs` over a text field whose text and marks are `old_runs`: [`write_text`] for the
/// characters, then [`write_marks`] for the marks. Inserted characters may have taken marks from
/// their neighbours (the schema's `expand`), so each of them gets every mark key of either list
/// set or removed explicitly.
pub fn write_rich_text(tx: &mut Tx<'_>, id: &ObjectId, field: &str, old_runs: &[TextRun], new_runs: &[TextRun]) -> Result<()> {
    let old_text: String = old_runs.iter().map(|run| run.insert.as_str()).collect();
    let new_text: String = new_runs.iter().map(|run| run.insert.as_str()).collect();
    let edits = write_text(tx, id, field, &old_text, &new_text)?;
    let before = project(old_runs, &edits);
    apply_marks(tx, id, field, before, new_runs)
}

/// A stretch of the text and the marks it holds now; `None` for inserted characters, whose marks
/// depend on the engine's `expand` and are not known.
struct Span<'a> {
    len: usize,
    marks: Option<&'a BTreeMap<String, Value>>,
}

/// The marks of the new text after `edits`, from the old runs: kept characters keep theirs.
fn project<'a>(old_runs: &'a [TextRun], edits: &[TextEdit]) -> Vec<Span<'a>> {
    // The old runs as (start, end, marks), in scalar positions of the old text.
    let mut runs = Vec::with_capacity(old_runs.len());
    let mut at = 0;
    for run in old_runs {
        let len = run.insert.chars().count();
        runs.push((at, at + len, &run.attributes));
        at += len;
    }
    let total = at;
    let mut out = Vec::new();
    let copy = |out: &mut Vec<Span<'a>>, from: usize, to: usize| {
        for &(start, end, marks) in &runs {
            let (start, end) = (start.max(from), end.min(to));
            if start < end {
                out.push(Span { len: end - start, marks: Some(marks) });
            }
        }
    };
    let mut cursor = 0;
    for edit in edits {
        copy(&mut out, cursor, edit.index);
        let inserted = edit.insert.chars().count();
        if inserted > 0 {
            out.push(Span { len: inserted, marks: None });
        }
        cursor = edit.index + edit.delete;
    }
    copy(&mut out, cursor, total);
    out
}

/// What one stretch needs for one key.
#[derive(Clone, Copy, PartialEq)]
enum Action<'a> {
    Mark(&'a Value),
    Unmark,
}

/// Marks and unmarks, key by key, the stretches where `before` differs from `new_runs`.
fn apply_marks(tx: &mut Tx<'_>, id: &ObjectId, field: &str, before: Vec<Span<'_>>, new_runs: &[TextRun]) -> Result<()> {
    let mut keys: BTreeSet<&str> = BTreeSet::new();
    for span in &before {
        keys.extend(span.marks.into_iter().flat_map(|marks| marks.keys().map(String::as_str)));
    }
    for run in new_runs {
        keys.extend(run.attributes.keys().map(String::as_str));
    }
    if keys.is_empty() {
        return Ok(());
    }
    // Both lists cut at every boundary of either: pieces of (start, end, before, after).
    let mut pieces: Vec<(usize, usize, Option<&Marks>, &Marks)> = Vec::new();
    let mut new_iter = new_runs.iter().map(|run| (run.insert.chars().count(), &run.attributes)).filter(|(len, _)| *len > 0);
    let mut new_current = new_iter.next();
    let mut at = 0;
    for span in before.iter().filter(|span| span.len > 0) {
        let mut left = span.len;
        while left > 0 {
            let Some((new_len, new_marks)) = new_current else {
                return Err(KitError::new("write_marks: the new runs are shorter than the text"));
            };
            let take = left.min(new_len);
            pieces.push((at, at + take, span.marks, new_marks));
            at += take;
            left -= take;
            new_current = if take == new_len { new_iter.next() } else { Some((new_len - take, new_marks)) };
        }
    }
    if new_current.is_some() {
        return Err(KitError::new("write_marks: the new runs are longer than the text"));
    }
    for key in keys {
        let mut pending: Option<(usize, usize, Action<'_>)> = None;
        for &(start, end, have, want) in &pieces {
            let want = want.get(key);
            let action = match (have.map(|marks| marks.get(key)), want) {
                (Some(have), want) if have == want => None,
                (_, Some(value)) => Some(Action::Mark(value)),
                (_, None) => Some(Action::Unmark),
            };
            match (&mut pending, action) {
                (Some((_, pending_end, pending_action)), Some(action)) if *pending_end == start && *pending_action == action => *pending_end = end,
                (_, action) => {
                    if let Some(done) = pending.take() {
                        write_action(tx, id, field, key, done)?;
                    }
                    pending = action.map(|action| (start, end, action));
                }
            }
        }
        if let Some(done) = pending {
            write_action(tx, id, field, key, done)?;
        }
    }
    Ok(())
}

fn write_action(tx: &mut Tx<'_>, id: &ObjectId, field: &str, key: &str, (start, end, action): (usize, usize, Action<'_>)) -> Result<()> {
    match action {
        Action::Mark(value) => tx.text_mark(id, field, start, end, key, value.clone())?,
        Action::Unmark => tx.text_unmark(id, field, start, end, key)?,
    }
    Ok(())
}

/// One step of an edit script from `a` to `b`.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Step {
    Keep,
    Delete,
    /// Inserts `b[index]`.
    Insert(usize),
}

/// Myers' O(ND) shortest edit script from `a` to `b`, or `None` when it needs more than `max_d`
/// insertions and deletions.
fn myers(a: &[char], b: &[char], max_d: usize) -> Option<Vec<Step>> {
    let (n, m) = (a.len() as isize, b.len() as isize);
    let limit = (a.len() + b.len()).min(max_d) as isize;
    let offset = limit + 1;
    let size = (2 * limit + 3) as usize;
    let mut v = vec![0isize; size];
    let mut trace: Vec<Vec<isize>> = Vec::new();
    let at = |k: isize| (k + offset) as usize;
    for d in 0..=limit {
        trace.push(v.clone());
        let mut k = -d;
        while k <= d {
            let mut x = if k == -d || (k != d && v[at(k - 1)] < v[at(k + 1)]) { v[at(k + 1)] } else { v[at(k - 1)] + 1 };
            let mut y = x - k;
            while x < n && y < m && a[x as usize] == b[y as usize] {
                x += 1;
                y += 1;
            }
            v[at(k)] = x;
            if x >= n && y >= m {
                return Some(backtrack(&trace, n, m, d, offset));
            }
            k += 2;
        }
    }
    None
}

fn backtrack(trace: &[Vec<isize>], n: isize, m: isize, last: isize, offset: isize) -> Vec<Step> {
    let at = |k: isize| (k + offset) as usize;
    let mut steps = Vec::new();
    let (mut x, mut y) = (n, m);
    for d in (0..=last).rev() {
        let v = &trace[d as usize];
        let k = x - y;
        let prev_k = if k == -d || (k != d && v[at(k - 1)] < v[at(k + 1)]) { k + 1 } else { k - 1 };
        let prev_x = if d == 0 { 0 } else { v[at(prev_k)] };
        let prev_y = if d == 0 { 0 } else { prev_x - prev_k };
        while x > prev_x && y > prev_y {
            steps.push(Step::Keep);
            x -= 1;
            y -= 1;
        }
        if d > 0 {
            if x == prev_x {
                y -= 1;
                steps.push(Step::Insert(y as usize));
            } else {
                x -= 1;
                steps.push(Step::Delete);
            }
        }
    }
    steps.reverse();
    steps
}

/// An edit script as replacements, at positions of the old text shifted by `base`.
fn group(steps: &[Step], b: &[char], base: usize) -> Vec<TextEdit> {
    let mut edits: Vec<TextEdit> = Vec::new();
    let mut old_at = base;
    let mut open = false;
    for step in steps {
        match step {
            Step::Keep => {
                old_at += 1;
                open = false;
            }
            Step::Delete | Step::Insert(_) => {
                if !open {
                    edits.push(TextEdit { index: old_at, delete: 0, insert: String::new() });
                    open = true;
                }
                if let Some(edit) = edits.last_mut() {
                    match step {
                        Step::Delete => {
                            edit.delete += 1;
                            old_at += 1;
                        }
                        Step::Insert(index) => edit.insert.extend(b.get(*index)),
                        Step::Keep => {}
                    }
                }
            }
        }
    }
    edits
}

#[cfg(test)]
mod tests {
    use super::*;

    fn apply(old: &str, edits: &[TextEdit]) -> String {
        let mut chars: Vec<char> = old.chars().collect();
        for edit in edits.iter().rev() {
            chars.splice(edit.index..edit.index + edit.delete, edit.insert.chars());
        }
        chars.into_iter().collect()
    }

    fn points(points: &[u32]) -> String {
        points.iter().filter_map(|&point| char::from_u32(point)).collect()
    }

    #[test]
    fn diffs_round_trip_and_stay_minimal() {
        let cases = [
            ("", ""),
            ("", "abc"),
            ("abc", ""),
            ("abc", "abc"),
            ("Hello world", "Hello brave world"),
            ("Hello world", "Hello"),
            ("kitten", "sitting"),
            ("abcabba", "cbabac"),
            ("the quick brown fox", "the slow brown cat"),
        ];
        for (old, new) in cases {
            let edits = diff_text(old, new);
            assert_eq!(apply(old, &edits), new, "{old:?} -> {new:?}: {edits:?}");
        }
        assert_eq!(diff_text("Hello world", "Hello brave world"), vec![TextEdit { index: 6, delete: 0, insert: "brave ".into() }]);
        assert_eq!(diff_text("abc", "abc"), vec![]);
        // Two separate changes stay two edits, so text between them is untouched.
        let edits = diff_text("one two three", "One two Three");
        assert_eq!(edits.len(), 2, "{edits:?}");
        assert_eq!(edits.iter().map(|edit| edit.delete).sum::<usize>(), 2);
    }

    #[test]
    fn diffs_count_unicode_scalar_values_for_emoji_and_ideographs() {
        // A grinning face (U+1F600) and two ideographs ("quarter"), then "review".
        let face = points(&[0x1F600]);
        let quarter = points(&[0x5B63, 0x5EA6]);
        let review = points(&[0x56DE, 0x987E]);
        let old = format!("a{face}{quarter}b");
        let new = format!("a{face}{review}{quarter}b");
        let edits = diff_text(&old, &new);
        assert_eq!(edits, vec![TextEdit { index: 2, delete: 0, insert: review.clone() }]);
        assert_eq!(apply(&old, &edits), new);
        let edits = diff_text(&new, &format!("{face}b"));
        assert_eq!(apply(&new, &edits), format!("{face}b"));
    }

    #[test]
    fn a_diff_beyond_the_budget_replaces_the_middle() {
        let old: String = (0..DIFF_BUDGET + 10).map(|index| if index % 2 == 0 { 'a' } else { 'b' }).collect();
        let new: String = (0..DIFF_BUDGET + 10).map(|index| if index % 3 == 0 { 'c' } else { 'd' }).collect();
        let edits = diff_text(&old, &new);
        assert_eq!(apply(&old, &edits), new);
        assert_eq!(edits.len(), 1);
    }

    mod replica {
        use std::sync::Arc;

        use kition_kdm::{ActorId, DocId, Origin, Replica, Schema};
        use serde_json::json;

        use super::super::*;
        use super::points;

        const SCHEMA: &str = r#"{ "kdm": 1, "kit": "kit.text", "schemaVersion": 1, "root": "Para", "types": { "Para": { "fields": {
            "text": { "kind": "text", "marks": { "bold": { "expand": "after" }, "italic": { "expand": "after" }, "link": { "expand": "none" } } } } } } }"#;

        fn run(text: &str, marks: Value) -> TextRun {
            TextRun { insert: text.into(), attributes: marks.as_object().cloned().unwrap_or_default().into_iter().collect() }
        }

        fn person() -> Origin {
            Origin::person("user:test")
        }

        /// A replica whose paragraph holds `runs`, written by [`write_rich_text`] over an empty text.
        fn paragraph(actor: u64, runs: &[TextRun]) -> (Replica, ObjectId) {
            let schema = Arc::new(Schema::parse(SCHEMA).unwrap());
            let mut replica = Replica::create(schema, DocId::new(), ActorId::from_u64(actor).unwrap()).unwrap();
            let para = replica
                .transact(&person(), |tx| {
                    let para = tx.create("Para", serde_json::Map::new())?;
                    write_rich_text(tx, &para, "text", &[], runs).map_err(kdm)?;
                    Ok(para)
                })
                .unwrap();
            (replica, para)
        }

        fn kdm(error: KitError) -> kition_kdm::KdmError {
            match error {
                KitError::Kdm(error) => error,
                other => kition_kdm::KdmError::Engine(other.to_string()),
            }
        }

        fn rewrite(replica: &mut Replica, para: &ObjectId, new: &[TextRun]) {
            let old = replica.text_delta(para, "text").unwrap();
            replica.transact(&person(), |tx| write_rich_text(tx, para, "text", &old, new).map_err(kdm)).unwrap();
            assert_eq!(&replica.text_delta(para, "text").unwrap(), new);
        }

        #[test]
        fn rich_text_writes_reach_the_runs_asked_for() {
            let (mut replica, para) = paragraph(1, &[run("Hello ", json!({ "bold": true })), run("world", json!({}))]);
            assert_eq!(replica.text_delta(&para, "text").unwrap(), vec![run("Hello ", json!({ "bold": true })), run("world", json!({}))]);
            // Typing at the bold run's end: the new characters are not bold, as asked.
            rewrite(&mut replica, &para, &[run("Hello ", json!({ "bold": true })), run("big world", json!({}))]);
            // Italic over part of a bold run, a link, and a deletion.
            rewrite(
                &mut replica,
                &para,
                &[
                    run("He", json!({ "bold": true })),
                    run("llo", json!({ "bold": true, "italic": true })),
                    run(" big ", json!({})),
                    run("wor", json!({ "link": "u" })),
                ],
            );
            // Everything unmarked.
            rewrite(&mut replica, &para, &[run("He", json!({}))]);
            rewrite(&mut replica, &para, &[]);
        }

        #[test]
        fn rich_text_writes_handle_emoji_and_ideographs() {
            let face = points(&[0x1F600]);
            let quarter = points(&[0x5B63, 0x5EA6]);
            let (mut replica, para) = paragraph(1, &[run(&format!("a{face}"), json!({ "bold": true })), run(&quarter, json!({}))]);
            rewrite(&mut replica, &para, &[run("a", json!({ "bold": true })), run(&format!("{face}{quarter}"), json!({ "italic": true }))]);
        }

        #[test]
        fn concurrent_rich_text_writes_keep_both_sides_typing() {
            let (mut a, para) = paragraph(1, &[run("Hello world", json!({}))]);
            let mut b = Replica::load(Arc::new(Schema::parse(SCHEMA).unwrap()), &a.snapshot().unwrap(), ActorId::from_u64(2).unwrap()).unwrap();
            rewrite(&mut a, &para, &[run("Hello brave world", json!({}))]);
            rewrite(&mut b, &para, &[run("Hello ", json!({})), run("world", json!({ "bold": true })), run("!", json!({}))]);
            let to_b = a.export_changes(&b.version()).unwrap();
            let to_a = b.export_changes(&a.version()).unwrap();
            a.import_changes(&to_a).unwrap();
            b.import_changes(&to_b).unwrap();
            assert_eq!(a.state_json().unwrap(), b.state_json().unwrap());
            assert_eq!(a.text(&para, "text").unwrap(), "Hello brave world!");
            // "world" is bold and "!" is not; whether "brave " (typed concurrently at the bold
            // range's start) takes the mark is the engine's choice, the same on both replicas.
            let runs = a.text_delta(&para, "text").unwrap();
            assert!(runs.iter().any(|run| run.insert.ends_with("world") && run.attributes.get("bold") == Some(&json!(true))), "{runs:?}");
            assert_eq!(runs.last(), Some(&run("!", json!({}))));
        }

        #[test]
        fn write_marks_refuses_runs_over_different_texts() {
            let (mut replica, para) = paragraph(1, &[run("abc", json!({}))]);
            let error =
                replica.transact(&person(), |tx| write_marks(tx, &para, "text", &[run("abc", json!({}))], &[run("abd", json!({}))]).map_err(kdm)).unwrap_err();
            assert!(error.to_string().contains("different texts"), "{error}");
            replica
                .transact(&person(), |tx| write_marks(tx, &para, "text", &[run("abc", json!({}))], &[run("abc", json!({ "bold": true }))]).map_err(kdm))
                .unwrap();
            assert_eq!(replica.text_delta(&para, "text").unwrap(), vec![run("abc", json!({ "bold": true }))]);
        }
    }

    #[test]
    fn project_marks_kept_characters_and_leaves_inserted_ones_unknown() {
        let bold: BTreeMap<String, Value> = [("bold".to_owned(), Value::Bool(true))].into_iter().collect();
        let old = vec![TextRun { insert: "Hello".into(), attributes: bold }, TextRun::new(" world")];
        let edits = diff_text("Hello world", "Help world!");
        let spans = project(&old, &edits);
        let shape: Vec<(usize, bool)> = spans.iter().map(|span| (span.len, span.marks.is_some())).collect();
        assert_eq!(spans.iter().map(|span| span.len).sum::<usize>(), "Help world!".chars().count());
        assert!(shape.contains(&(1, false)), "{shape:?}");
    }
}
