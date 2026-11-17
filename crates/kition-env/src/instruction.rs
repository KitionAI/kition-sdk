//! A task's instruction: one plain-English sentence from a template per edit kind, naming each
//! object as a person would from what the tools show (its type, what it says, where it is) and
//! never by its id ([`crate::Reference`]).

use serde_json::Value;

use crate::changes::list;
use crate::snapshot::{Snapshot, quoted, text_of, words};

/// A value in an instruction: a text in quotes, a number or a truth value as it is.
fn shown(value: &Value) -> String {
    match value {
        Value::String(text) => quoted(text),
        Value::Array(items)
            if items.iter().all(|run| run["insert"].is_string() && run["attributes"].as_object().is_none_or(|attributes| attributes.is_empty())) =>
        {
            quoted(&text_of(value))
        }
        other => other.to_string(),
    }
}

/// `On slide 1, ` before `rest`, or `rest` capitalised when there is no place; ends with a full stop.
fn sentence(place: &str, rest: &str) -> String {
    let text = if place.is_empty() { rest.to_owned() } else { format!("{place}, {rest}") };
    let mut chars = text.chars();
    let first = chars.next().map(|c| c.to_uppercase().collect::<String>()).unwrap_or_default();
    format!("{first}{}.", chars.as_str())
}

/// Where a list of `parent` is: `On slide 2` for a slide, nothing for the document itself.
fn place_of_parent(start: &Snapshot, parent: &str) -> Option<String> {
    if parent == start.root() {
        return Some(String::new());
    }
    Some(format!("On {}", start.reference(parent)?.located()))
}

/// `slide 2`, or `the document` for the root.
fn destination(start: &Snapshot, parent: &str) -> Option<String> {
    if parent == start.root() { Some("the document".to_owned()) } else { Some(start.reference(parent)?.located()) }
}

fn position(start: &Snapshot, place: &Value, inserted: bool) -> usize {
    start.spelled_index(
        place["parent"].as_str().unwrap_or_default(),
        place["field"].as_str().unwrap_or_default(),
        place["index"].as_u64().unwrap_or(0) as usize,
        inserted,
    ) + 1
}

/// What an edit at `path` of the object `id` (of `ty`) changes, in words, and its value `after`
/// as a person reads it: `the name` for a field; `the name` for the type's label inside
/// a json field (`props.name`); `the value v of "transform/opacity"` in the kit's words (`named`);
/// `the time of the 2nd key` for a field of a held object reached by a path; a value shown by its
/// field's `display` (`00:00:05:00`).
fn described_field(start: &Snapshot, id: &str, ty: &str, path: &str, named: Option<&str>, after: &Value) -> (String, String) {
    let shown_as = |ty: &str, field: &str| start.displayed(ty, field, after).unwrap_or_else(|| shown(after));
    let top = path.split('.').next().unwrap_or(path);
    if start.type_def(ty)["text"] == path {
        return ("the text".to_owned(), shown(after));
    }
    if !path.contains('.') {
        return (format!("the {}", words(path)), shown_as(ty, path));
    }
    if start.label_field(ty).as_deref() == Some(path) || matches!(start.kind(ty, top), "json" | "map") {
        let last = path.rsplit('.').find(|segment| segment.parse::<usize>().is_err()).unwrap_or(path);
        return (format!("the {}", words(last)), shown(after));
    }
    if let Some(named) = named {
        let cut = named.rfind('/').unwrap_or(0);
        let (object, field) = match named[cut..].find('.') {
            Some(dot) => (&named[..cut + dot], &named[cut + dot + 1..]),
            None => (named, ""),
        };
        return (format!("the {} of {}", words(&field.replace('.', " ")), quoted(object)), shown(after));
    }
    // A field of a held object: its type and place among its siblings.
    let (object_path, field) = path.rsplit_once('.').unwrap_or(("", path));
    let held = start.object_at(id, object_path);
    let described = held.as_ref().and_then(|held| {
        let held_ty = start.type_of(held)?;
        let index = object_path.rsplit('.').next()?.parse::<usize>().ok();
        Some((held_ty.to_owned(), index))
    });
    match described {
        Some((held_ty, Some(index))) => {
            (format!("the {} of the {} {}", words(field), crate::snapshot::ordinal(index + 1), words(&held_ty)), shown_as(&held_ty, field))
        }
        Some((held_ty, None)) => (format!("the {} of its {}", words(field), words(&held_ty)), shown_as(&held_ty, field)),
        None => (format!("the {}", words(field)), shown(after)),
    }
}

/// The instruction for the change set `truth` of an edit of `kind`, on the document `start`
/// shows (the file the task starts from); an inverse task asks to restore what was changed.
/// None when an object it names cannot be described unambiguously.
pub(crate) fn instruction(kind: &str, truth: &Value, start: &Snapshot, inverse: bool) -> Option<String> {
    if let Some(primary) = crate::structural::primary(truth, start) {
        return instruction(kind, &primary, start, inverse);
    }
    if let Some(member) = crate::changes::map_membership(truth, start) {
        let place = place_of_parent(start, &member.parent)?;
        if !member.creating {
            let target = start.reference(&member.id)?;
            return Some(sentence(&place, &format!("delete {} from {} at key {}", target.phrase_within(), words(&member.field), quoted(&member.key))));
        }
        let created = &truth["created"][0];
        let ty = created["type"].as_str()?;
        let values: Vec<_> = created["values"]
            .as_object()?
            .iter()
            .filter(|(field, value)| !start.creation_kept(ty, field) && !value.is_null())
            .map(|(field, value)| format!("{} {}", words(field), shown(value)))
            .collect();
        let with = if values.is_empty() { String::new() } else { format!(" with {}", values.join(" and ")) };
        return Some(sentence(&place, &format!("add a new {}{with} to {} at key {}", words(ty), words(&member.field), quoted(&member.key))));
    }
    if let Some(change) = list(truth, "changed")
        .filter(|_| crate::changes::move_root(truth, start).is_none())
        .find(|change| change["edits"].as_array().is_some_and(|edits| !edits.is_empty()))
    {
        let id = change["id"].as_str()?;
        let edit = &change["edits"][0];
        let path = edit["field"].as_str()?;
        let ty = change["type"].as_str().unwrap_or_default();
        let (field, value) = described_field(start, id, ty, path, edit["named"].as_str(), &edit["after"]);
        let subject = || if id == start.root() { Some("the document".to_owned()) } else { start.reference(id).map(|target| target.located_within()) };
        if edit["span"]["complete"] == true {
            let span = &edit["span"];
            let context = format!("{}{}{}", span["before"].as_str()?, span["removed"].as_str()?, span["after"].as_str()?);
            return Some(sentence(
                "",
                &format!(
                    "replace {} with {} in {field} of {}, at character {} in context {}",
                    shown(&span["removed"]),
                    shown(&span["inserted"]),
                    subject()?,
                    span["offset"].as_u64()? + 1,
                    quoted(&context)
                ),
            ));
        }
        if id == start.root() {
            return Some(sentence("", &format!("change {field} of the document {} {value}", if inverse { "back to" } else { "to" })));
        }
        let target = start.reference(id)?;
        let after = &edit["after"];
        if let Some(state) = after.as_bool() {
            let (object, name) = match path.rsplit_once('.') {
                Some((held, name)) => (start.object_at(id, held), name),
                None => (Some(id.to_owned()), path),
            };
            let owner_ty = object.as_ref().and_then(|id| start.type_of(id)).unwrap_or(ty);
            let label = start.type_def(owner_ty)["fields"][name]["label"].as_str().map(str::to_owned).unwrap_or_else(|| words(name));
            let state = format!("{}{label}", if state { "" } else { "not " });
            let subject = object.as_ref().and_then(|held| start.reference(held)).map(|held| held.located_within()).unwrap_or_else(|| {
                if path.contains('.') { format!("{} of {}", field.trim_start_matches("the "), target.located_within()) } else { target.located_within() }
            });
            return Some(sentence("", &format!("set {subject} {} {state}", if inverse { "back to" } else { "to" })));
        }
        return Some(match (inverse, after.is_null()) {
            (false, _) => sentence(&target.place(), &format!("change {field} of {} to {value}", target.phrase_within())),
            (true, true) => sentence(&target.place(), &format!("{field} of {} was set; remove it again", target.phrase_within())),
            (true, false) => sentence(&target.place(), &format!("{field} of {} was changed; change it back to {value}", target.phrase_within())),
        });
    }
    if let Some(moved) = list(truth, "moved").next() {
        let target = start.reference(moved["id"].as_str()?)?;
        let (from, to) = (&moved["from"], &moved["to"]);
        let same_list = from["parent"] == to["parent"] && from["field"] == to["field"];
        let at = position(start, to, !same_list);
        return Some(match (inverse, same_list) {
            (false, true) => sentence(&target.place(), &format!("move {} to position {at}", target.phrase_within())),
            (true, true) => sentence(&target.place(), &format!("{} was moved; move it back to position {at}", target.phrase_within())),
            (false, false) => sentence("", &format!("move {} to {}, at position {at}", target.located_within(), destination(start, to["parent"].as_str()?)?)),
            (true, false) => sentence(
                "",
                &format!("{} was moved; move it back to {}, at position {at}", target.located_within(), destination(start, to["parent"].as_str()?)?),
            ),
        });
    }
    if let Some(created) = list(truth, "created").next() {
        let ty = created["type"].as_str()?;
        let at = &created["at"];
        let place = place_of_parent(start, at["parent"].as_str()?)?;
        let label = start.label_field(ty);
        let mut values: Vec<(&String, &Value)> =
            created["values"].as_object()?.iter().filter(|(field, value)| !start.creation_kept(ty, field) && !value.is_null()).collect();
        values.sort_by_key(|(field, _)| (Some(field.as_str()) != label.as_deref(), field.as_str()));
        let with = if values.is_empty() {
            String::new()
        } else {
            format!(" with {}", values.iter().map(|(field, value)| format!("{} {}", words(field), shown(value))).collect::<Vec<_>>().join(" and "))
        };
        return Some(sentence(&place, &format!("add a new {}{with} at position {}", words(ty), position(start, at, true))));
    }
    if let Some(deleted) = list(truth, "deleted").next() {
        let cascade = crate::changes::cascade_root(truth, start);
        let target = start.reference(cascade.as_deref().or_else(|| deleted["id"].as_str())?)?;
        return Some(if inverse && kind == "create" {
            sentence(&target.place(), &format!("{} was added; delete it", target.phrase_within()))
        } else {
            sentence(&target.place(), &format!("delete {}{}", target.phrase(), if cascade.is_some() { " and its contents" } else { "" }))
        });
    }
    None
}
