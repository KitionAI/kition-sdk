//! Position transforms for text and lists (plan 2026-11-24, section 1.5): an undo's operations
//! were made for the state right after its step; changes applied since moved the text and the
//! items they address. [`through`] carries them over those changes, one at a time: text inserted
//! before a position moves it on, text deleted around it takes it back, an undo's delete keeps
//! text inserted inside its range by others, and an undo's mark does not spread over it. The log
//! is one line, so this is a plain transform of one sequence of operations against another, not a
//! merge.
//!
//! Only operations on the same text or list field affect each other; any other operation passes
//! unchanged. Positions that no longer fit are fitted when the undo applies ([`super::Store::fit`]).

use std::collections::HashSet;

use super::op::Op;
use crate::ObjectId;

/// `ops` (applied in order on a state) carried over `later` (applied in order on that same
/// state), so they apply in order after `later`; and whether any of `later` moved them. List
/// moves come out as the removal and the insertion they are.
pub(crate) fn through(ops: Vec<Op>, later: &[Op]) -> (Vec<Op>, bool) {
    let fields: HashSet<(&ObjectId, &str)> = ops.iter().filter(|op| is_sequence_edit(op)).filter_map(|op| Some((op.object()?, &**op.field()?))).collect();
    let touching: Vec<&Op> =
        later.iter().filter(|op| is_sequence_edit(op) && op.object().zip(op.field()).is_some_and(|(id, field)| fields.contains(&(id, &**field)))).collect();
    if touching.is_empty() {
        return (ops, false);
    }
    let mut ops: Vec<Op> = ops.into_iter().flat_map(split_move).collect();
    for op in touching {
        if ops.is_empty() {
            break;
        }
        let (moved, _) = xform(ops, split_move(op.clone()));
        ops = moved;
    }
    (ops, true)
}

/// Whether both operations edit one text or one list field.
fn addresses_same_sequence(a: &Op, b: &Op) -> bool {
    is_sequence_edit(a) && is_sequence_edit(b) && a.object() == b.object() && a.field() == b.field()
}

fn is_sequence_edit(op: &Op) -> bool {
    matches!(op, Op::TextInsert { .. } | Op::TextDelete { .. } | Op::TextMark { .. } | Op::ListInsert { .. } | Op::ListRemove { .. } | Op::ListMove { .. })
}

/// A list move as the removal and the insertion it is, for transforming.
fn split_move(op: Op) -> Vec<Op> {
    match op {
        Op::ListMove { id, field, from, to, item: Some(item) } => {
            vec![Op::ListRemove { id: id.clone(), field: field.clone(), index: from, item: Some(item.clone()) }, Op::ListInsert { id, field, index: to, item }]
        }
        other => vec![other],
    }
}

/// Two sequences of operations made on one state (neither holding a list move), transformed
/// against each other: `a` to apply after `b`, and `b` to apply after `a` ([`pair`]).
fn xform(a: Vec<Op>, b: Vec<Op>) -> (Vec<Op>, Vec<Op>) {
    match (a.len(), b.len()) {
        (0, _) | (_, 0) => (a, b),
        (1, 1) => {
            let (Some(one), Some(other)) = (a.into_iter().next(), b.into_iter().next()) else { return (Vec::new(), Vec::new()) };
            pair(one, other)
        }
        (1, _) => {
            let mut b = b.into_iter();
            let first: Vec<Op> = b.next().into_iter().collect();
            let rest: Vec<Op> = b.collect();
            let (a, first) = xform(a, first);
            let (a, rest) = xform(a, rest);
            (a, first.into_iter().chain(rest).collect())
        }
        _ => {
            let mut a = a.into_iter();
            let first: Vec<Op> = a.next().into_iter().collect();
            let rest: Vec<Op> = a.collect();
            let (first, b) = xform(first, b);
            let (rest, b) = xform(rest, b);
            (first.into_iter().chain(rest).collect(), b)
        }
    }
}

/// The number of characters of an insertion.
fn chars(text: &str) -> usize {
    text.chars().count()
}

/// Two operations made on one state, transformed against each other: `a` to apply after `b`, `b`
/// to apply after `a`. At one position, `b`'s text comes first and `a`'s list item does. Answers
/// none for an operation left with nothing to do.
fn pair(a: Op, b: Op) -> (Vec<Op>, Vec<Op>) {
    if !addresses_same_sequence(&a, &b) {
        return (vec![a], vec![b]);
    }
    match (a, b) {
        (Op::TextInsert { id, field, index: i, text: s, marks }, b @ Op::TextInsert { .. }) => {
            let Op::TextInsert { index: j, ref text, .. } = b else { return (Vec::new(), vec![b]) };
            let (n, m) = (chars(&s), chars(text));
            // At one position the other text comes first: text taken back and put back loses its
            // place among what was typed at that point, and what was typed after it stays after.
            if i < j {
                (vec![Op::TextInsert { id, field, index: i, text: s, marks }], vec![with_index(b, j + n)])
            } else {
                (vec![Op::TextInsert { id, field, index: i + m, text: s, marks }], vec![b])
            }
        }
        (Op::TextInsert { id, field, index: i, text: s, marks }, Op::TextDelete { id: bid, field: bfield, index: j, count: m, was }) => {
            let n = chars(&s);
            if i <= j {
                (vec![Op::TextInsert { id, field, index: i, text: s, marks }], vec![Op::TextDelete { id: bid, field: bfield, index: j + n, count: m, was }])
            } else if i >= j + m {
                (vec![Op::TextInsert { id, field, index: i - m, text: s, marks }], vec![Op::TextDelete { id: bid, field: bfield, index: j, count: m, was }])
            } else {
                // Inserted inside the deleted range: the insertion stays, at the range's start.
                let deletes = vec![
                    Op::TextDelete { id: bid.clone(), field: bfield.clone(), index: j, count: i - j, was: Vec::new() },
                    Op::TextDelete { id: bid, field: bfield, index: j + n, count: j + m - i, was: Vec::new() },
                ];
                (vec![Op::TextInsert { id, field, index: j, text: s, marks }], nonempty(deletes))
            }
        }
        (Op::TextDelete { id, field, index: i, count: n, was }, Op::TextInsert { id: bid, field: bfield, index: j, text: t, marks }) => {
            let m = chars(&t);
            if j <= i {
                (vec![Op::TextDelete { id, field, index: i + m, count: n, was }], vec![Op::TextInsert { id: bid, field: bfield, index: j, text: t, marks }])
            } else if j >= i + n {
                (vec![Op::TextDelete { id, field, index: i, count: n, was }], vec![Op::TextInsert { id: bid, field: bfield, index: j - n, text: t, marks }])
            } else {
                // The other text, inserted inside this range, is kept.
                let deletes = vec![
                    Op::TextDelete { id: id.clone(), field: field.clone(), index: i, count: j - i, was: Vec::new() },
                    Op::TextDelete { id, field, index: i + m, count: i + n - j, was: Vec::new() },
                ];
                (nonempty(deletes), vec![Op::TextInsert { id: bid, field: bfield, index: i, text: t, marks }])
            }
        }
        (Op::TextDelete { id, field, index: i, count: n, was }, Op::TextDelete { id: bid, field: bfield, index: j, count: m, was: bwas }) => {
            let overlap = (i + n).min(j + m).saturating_sub(i.max(j));
            let before_a = if j < i { m.min(i - j) } else { 0 };
            let before_b = if i < j { n.min(j - i) } else { 0 };
            (
                nonempty(vec![Op::TextDelete { id, field, index: i - before_a, count: n - overlap, was }]),
                nonempty(vec![Op::TextDelete { id: bid, field: bfield, index: j - before_b, count: m - overlap, was: bwas }]),
            )
        }
        (Op::TextMark { id, field, start, end, key, value, was }, b @ Op::TextInsert { .. }) => {
            let Op::TextInsert { index: j, ref text, .. } = b else { return (Vec::new(), vec![b]) };
            let m = chars(text);
            let marks = if j <= start {
                vec![Op::TextMark { id, field, start: start + m, end: end + m, key, value, was }]
            } else if j >= end {
                vec![Op::TextMark { id, field, start, end, key, value, was }]
            } else {
                // Not spread over the other text inserted inside the range.
                vec![
                    Op::TextMark { id: id.clone(), field: field.clone(), start, end: j, key: key.clone(), value: value.clone(), was: Vec::new() },
                    Op::TextMark { id, field, start: j + m, end: end + m, key, value, was: Vec::new() },
                ]
            };
            (marks, vec![b])
        }
        (Op::TextMark { id, field, start, end, key, value, was }, b @ Op::TextDelete { .. }) => {
            let Op::TextDelete { index: j, count: m, .. } = b else { return (Vec::new(), vec![b]) };
            let map = |at: usize| if at > j { at - (at - j).min(m) } else { at };
            let (start, end) = (map(start), map(end));
            let marks = if start < end { vec![Op::TextMark { id, field, start, end, key, value, was }] } else { Vec::new() };
            (marks, vec![b])
        }
        (a @ (Op::TextInsert { .. } | Op::TextDelete { .. } | Op::TextMark { .. }), b @ Op::TextMark { .. }) => (vec![a], vec![b]),
        (Op::ListInsert { id, field, index: i, item }, b @ Op::ListInsert { .. }) => {
            let Op::ListInsert { index: j, .. } = b else { return (Vec::new(), vec![b]) };
            if i <= j {
                (vec![Op::ListInsert { id, field, index: i, item }], vec![with_index(b, j + 1)])
            } else {
                (vec![Op::ListInsert { id, field, index: i + 1, item }], vec![b])
            }
        }
        (Op::ListInsert { id, field, index: i, item }, b @ Op::ListRemove { .. }) => {
            let Op::ListRemove { index: j, .. } = b else { return (Vec::new(), vec![b]) };
            if i <= j {
                (vec![Op::ListInsert { id, field, index: i, item }], vec![with_index(b, j + 1)])
            } else {
                (vec![Op::ListInsert { id, field, index: i - 1, item }], vec![b])
            }
        }
        (Op::ListRemove { id, field, index: i, item }, b @ Op::ListInsert { .. }) => {
            let Op::ListInsert { index: j, .. } = b else { return (Vec::new(), vec![b]) };
            if j <= i {
                (vec![Op::ListRemove { id, field, index: i + 1, item }], vec![b])
            } else {
                (vec![Op::ListRemove { id, field, index: i, item }], vec![with_index(b, j - 1)])
            }
        }
        (Op::ListRemove { id, field, index: i, item }, b @ Op::ListRemove { .. }) => {
            let Op::ListRemove { index: j, .. } = b else { return (Vec::new(), vec![b]) };
            if i == j {
                // The same item: an undo's removal stays, to find the item wherever a move put it
                // (`Store::fit` skips it when the item is gone).
                (vec![Op::ListRemove { id, field, index: i, item }], Vec::new())
            } else if j < i {
                (vec![Op::ListRemove { id, field, index: i - 1, item }], vec![b])
            } else {
                (vec![Op::ListRemove { id, field, index: i, item }], vec![with_index(b, j - 1)])
            }
        }
        (a, b) => (vec![a], vec![b]),
    }
}

/// The operation with its position set to `index`.
fn with_index(op: Op, index: usize) -> Op {
    match op {
        Op::TextInsert { id, field, text, marks, .. } => Op::TextInsert { id, field, index, text, marks },
        Op::TextDelete { id, field, count, was, .. } => Op::TextDelete { id, field, index, count, was },
        Op::ListInsert { id, field, item, .. } => Op::ListInsert { id, field, index, item },
        Op::ListRemove { id, field, item, .. } => Op::ListRemove { id, field, index, item },
        other => other,
    }
}

/// Drops deletions of no characters.
fn nonempty(ops: Vec<Op>) -> Vec<Op> {
    ops.into_iter().filter(|op| !matches!(op, Op::TextDelete { count: 0, .. })).collect()
}
