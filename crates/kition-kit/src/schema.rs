//! Machine-readable command parameters for AI harnesses (standard sections 4 E7 and 7.2).
//!
//! A command's parameters are a DeepSeek Harness `ParameterSchemaSpec`: an object of named
//! properties, each a `ValueSchemaSpec` (`string`, `number`, `integer`, `boolean`, `null`,
//! `array`, `object` with explicit `additionalProperties`, `json`, or `oneOf`), with
//! `required: true` on required ones.
//!
//! [`from_kit_params`] converts the free-text notation the kit engines use for people into
//! that form. Two dialects are in use: quoted keys (Photo, Film:
//! `{"layer":id?,"mode":"normal|multiply"="normal","opacity":0..100}`) and plain keys
//! (Vector, Motion, Layout: `{x, y, width, radius?: pt, ids?}`). What it
//! cannot type precisely becomes `{"type":"json"}` with the original text as its description,
//! so the schema stays valid and the model still reads the hint; [`Conversion`] counts both.
//! Converted schemas mark no property required (see [`from_kit_params`]); [`Conversion::required`]
//! lists the ones the notation leaves without a default and not optional, which a kit publishes as
//! required only when it opts in ([`crate::KitCommand::notation_required`]).

use serde_json::{Map, Value, json};

mod paths;
pub use paths::{PATH_DESCRIPTION_PHRASES, PATH_NAME_WORDS, PathLike, path_like_parameters};

/// A converted parameter schema and how much of it was typed precisely.
#[derive(Clone, Debug, PartialEq)]
pub struct Conversion {
    /// The `ParameterSchemaSpec` object.
    pub schema: Value,
    /// Properties found.
    pub properties: usize,
    /// Properties typed precisely (not the `json` fallback).
    pub precise: usize,
    /// The top-level properties the notation marks neither optional (`?` after the key or the
    /// type) nor with a default (`=value`, or a literal as the type), typed precisely, without
    /// notes, and not one of several alternative keys or forms: what [`Conversion::required_schema`]
    /// marks required. In the notation's order.
    pub required: Vec<String>,
    /// The top-level entries the notation gives no key the parser can read (`id?/ids?`, where
    /// `id?, ids?` was meant), each as written: the schema has no parameter for them, so
    /// [`refuse_unknown`] refuses a call that passes one. [`crate::testing::check_commands`] names
    /// each as a problem of its command.
    pub unreadable: Vec<String>,
}

impl Conversion {
    /// [`Conversion::schema`] with `required: true` on each of [`Conversion::required`]: the schema a
    /// kit publishes for a command that opts in ([`crate::KitCommand::notation_required`]), checked
    /// with [`crate::testing::check_required`].
    #[must_use]
    pub fn required_schema(&self) -> Value {
        let mut schema = self.schema.clone();
        for key in &self.required {
            if let Some(node) = schema.get_mut(key).and_then(Value::as_object_mut) {
                node.insert("required".into(), Value::Bool(true));
            }
        }
        schema
    }
}

/// Converts kit command notation to a `ParameterSchemaSpec`. An error means the text is
/// not an object of parameters at all (prose, or unbalanced brackets); such a command stays off
/// the agent's tool list.
pub fn from_kit_params(text: &str) -> Result<Conversion, String> {
    let forms = alternative_objects(text.trim())?;
    let mut schema = Map::new();
    let mut precise = 0;
    let mut required = Vec::new();
    let mut unreadable = Vec::new();
    for body in &forms {
        precise += convert_object(body, forms.len() > 1, &mut schema, &mut required, &mut unreadable);
    }
    let properties = schema.len();
    Ok(Conversion { schema: Value::Object(schema), properties, precise: precise.min(properties), required, unreadable })
}

/// `{"hidden":[label]}|{"color":label}`: a command that takes one of several whole forms. Every
/// form's keys are parameters (none required, since each belongs to one form), so a call in any
/// form passes `refuse_unknown`. Text after the last form (`=description`) is ignored, as before.
fn alternative_objects(text: &str) -> Result<Vec<&str>, String> {
    let mut forms = vec![leading_object(text)?];
    let mut rest = text;
    while let Some(after) = rest.strip_prefix('{').and_then(|_| object_end(rest)).map(|end| rest[end..].trim_start()) {
        let Some(next) = after.strip_prefix('|').map(str::trim_start).filter(|next| next.starts_with('{')) else { break };
        forms.push(leading_object(next)?);
        rest = next;
    }
    Ok(forms)
}

/// The byte index just past the `}` closing the object `text` starts with.
fn object_end(text: &str) -> Option<usize> {
    let mut depth = 0i32;
    let mut quoted = false;
    for (index, ch) in text.char_indices() {
        match ch {
            '"' => quoted = !quoted,
            '{' | '[' | '(' if !quoted => depth += 1,
            '}' | ']' | ')' if !quoted => {
                depth -= 1;
                if depth == 0 {
                    return Some(index + ch.len_utf8());
                }
            }
            _ => {}
        }
    }
    None
}

/// Adds one object form's properties to `schema` (a key another form already gave keeps that
/// definition), and to `required` those the notation marks neither optional nor defaulted
/// ([`Conversion::required`]), and to `unreadable` the entries with no key it can read
/// ([`Conversion::unreadable`]), and answers how many were typed precisely.
fn convert_object(body: &str, one_of_several_forms: bool, schema: &mut Map<String, Value>, required: &mut Vec<String>, unreadable: &mut Vec<String>) -> usize {
    let mut precise = 0;
    for entry in split_top(body, ',') {
        let entry = entry.trim();
        if entry.is_empty() || entry == "…" || entry == "..." {
            continue;
        }
        // `"time":ticks|"frame":i64|"seconds":f64`: alternative keys, one property each.
        let alternatives = split_alternative_keys(entry);
        let alternative = alternatives.len() > 1;
        for part in &alternatives {
            let Some((key, expression)) = key_and_expression(part) else {
                unreadable.push(part.trim().to_owned());
                continue;
            };
            let (mut node, typed) = if expression.is_empty() {
                bare_key(&key).map_or_else(|| (json!({ "type": "json" }), false), |node| (node, true))
            } else if expression.starts_with('(') {
                noted_key(&key, expression)
            } else {
                property(expression)
            };
            if typed {
                precise += 1;
            }
            if typed && !alternative && !one_of_several_forms && !schema.contains_key(&key) && no_default_and_not_optional(part, expression, &node) {
                required.push(key.clone());
            }
            if alternative && let Some(object) = node.as_object_mut() {
                let note = "one of several alternative parameters".to_owned();
                let description = object.get("description").and_then(Value::as_str).map_or(note.clone(), |text| format!("{text}; {note}"));
                object.insert("description".into(), Value::String(description));
            }
            if one_of_several_forms && let Some(object) = node.as_object_mut() {
                object.remove("required");
                let note = "in one of several forms of the parameters".to_owned();
                let description = object.get("description").and_then(Value::as_str).map_or(note.clone(), |text| format!("{text}; {note}"));
                object.insert("description".into(), Value::String(description));
            }
            schema.entry(key).or_insert(node);
        }
    }
    precise
}

/// Whether the notation leaves a key without a default and does not mark it optional: no `?` after
/// the key (`name?`, `"name"?`) or the type (`str?`), no default (`=value`, a literal written as the
/// type), and no notes (`(…)`), which the notation uses for conditions (`[x,y,w,h] (rect only)`).
fn no_default_and_not_optional(part: &str, expression: &str, node: &Value) -> bool {
    let part = part.trim();
    let after_key = match part.strip_prefix('"') {
        Some(rest) => rest.find('"').map_or("", |end| &rest[end + 1..]),
        None => part.find(|ch: char| !(ch.is_ascii_alphanumeric() || ch == '_' || ch == '-' || ch == '.')).map_or("", |end| &part[end..]),
    };
    if after_key.trim_start().starts_with('?') || expression.starts_with('(') {
        return false;
    }
    let (bare, notes) = strip_notes(expression);
    notes.is_empty() && !bare.trim().ends_with('?') && split_default(bare.trim()).is_none() && node.get("default").is_none()
}

/// The text inside the first top-level `{…}`; `{}` and an empty text are no parameters.
fn leading_object(text: &str) -> Result<&str, String> {
    if text.is_empty() {
        return Ok("");
    }
    if !text.starts_with('{') {
        return Err("the parameters are not an object".into());
    }
    let mut depth = 0i32;
    let mut quoted = false;
    for (index, ch) in text.char_indices() {
        match ch {
            '"' => quoted = !quoted,
            '{' | '[' | '(' if !quoted => depth += 1,
            '}' | ']' | ')' if !quoted => {
                depth -= 1;
                if depth == 0 {
                    return Ok(&text[1..index]);
                }
            }
            _ => {}
        }
    }
    Err("unbalanced brackets in the parameters".into())
}

/// Splits on `separator` outside quotes and brackets.
fn split_top(text: &str, separator: char) -> Vec<&str> {
    let mut parts = Vec::new();
    let mut depth = 0i32;
    let mut quoted = false;
    let mut start = 0;
    for (index, ch) in text.char_indices() {
        match ch {
            '"' => quoted = !quoted,
            '{' | '[' | '(' if !quoted => depth += 1,
            '}' | ']' | ')' if !quoted => depth -= 1,
            _ if ch == separator && !quoted && depth == 0 => {
                parts.push(&text[start..index]);
                start = index + ch.len_utf8();
            }
            _ => {}
        }
    }
    parts.push(&text[start..]);
    parts
}

/// Alternative names for one value: `"a":x|"b":y` (quoted keys, each with its type) and
/// `name?|title?: text` (plain keys sharing the last one's type). `"a":"x|y"` and `kind: a|b`
/// are one key with choices.
fn split_alternative_keys(entry: &str) -> Vec<String> {
    let parts = split_top(entry, '|');
    if parts.len() > 1
        && parts.iter().skip(1).all(|part| part.trim_start().starts_with('"') && key_and_expression(part).is_some_and(|(_, expression)| !expression.is_empty()))
    {
        return parts.into_iter().map(str::to_owned).collect();
    }
    let bare = |part: &str| plain_key(part.trim()).is_some_and(|(_, rest)| rest.is_empty());
    if let Some((last, rest)) = parts.split_last()
        && !rest.is_empty()
        && rest.iter().all(|part| bare(part))
        && let Some((_, shared)) = key_and_expression(last).filter(|(_, expression)| !expression.is_empty())
    {
        let mut keys: Vec<String> = rest.iter().filter_map(|part| plain_key(part.trim()).map(|(key, _)| format!("{key}?: {shared}"))).collect();
        keys.push((*last).to_owned());
        return keys;
    }
    // `to?: [x,y] | delta: [dx,dy]`, `expr? | value?`, `handle | handles`: keys given one or
    // another, each with its own type. Every part after the first marks its key with `?` or `:`,
    // or no part has a `:` at all; `mode?: new|append` (values given one or another) stays whole.
    let keyish = |part: &str| plain_key(part.trim()).is_some_and(|(_, rest)| rest.is_empty() || rest.starts_with(':') || rest.starts_with('('));
    let marked = |part: &str| {
        let part = part.trim();
        let end = part.find(|ch: char| !(ch.is_ascii_alphanumeric() || ch == '_' || ch == '-' || ch == '.')).unwrap_or(part.len());
        part[end..].trim_start().starts_with(['?', ':'])
    };
    if parts.len() > 1
        && parts.iter().all(|part| keyish(part))
        && (parts.iter().skip(1).all(|part| marked(part)) || parts.iter().all(|part| !part.contains(':')))
    {
        return parts.into_iter().map(|part| part.trim().to_owned()).collect();
    }
    vec![entry.to_owned()]
}

/// A plain key at the start of `part` (`radius`, `ids`, `font.size`), with the text after it
/// and any `?` after the key removed.
fn plain_key(part: &str) -> Option<(&str, &str)> {
    let end = part.find(|ch: char| !(ch.is_ascii_alphanumeric() || ch == '_' || ch == '-' || ch == '.')).unwrap_or(part.len());
    let key = &part[..end];
    if key.is_empty() || !key.starts_with(|ch: char| ch.is_ascii_alphabetic() || ch == '_') {
        return None;
    }
    let rest = part[end..].trim_start();
    let rest = rest.strip_prefix('?').map_or(rest, str::trim_start);
    Some((key, rest))
}

/// `"key":expression`, `key: expression`, `key?: expression`, or a bare `key` / `key?` (its
/// type then comes from its name, see [`bare_key`]).
fn key_and_expression(part: &str) -> Option<(String, &str)> {
    let part = part.trim();
    if let Some(rest) = part.strip_prefix('"') {
        let end = rest.find('"')?;
        let key = &rest[..end];
        if key.is_empty() || !key.chars().all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '-' || ch == '.') {
            return None;
        }
        // A quoted key takes every form a plain one does: `"key"?: x`, `"key"`, `"key"? (notes)`.
        let rest = rest[end + 1..].trim_start();
        let rest = rest.strip_prefix('?').map_or(rest, str::trim_start);
        return key_rest(key, rest);
    }
    let (key, rest) = plain_key(part)?;
    key_rest(key, rest)
}

/// A key and what follows it (its `?` removed): nothing, `(notes)`, or `: expression`.
fn key_rest<'a>(key: &str, rest: &'a str) -> Option<(String, &'a str)> {
    if rest.is_empty() {
        return Some((key.to_owned(), ""));
    }
    // `key (notes)` / `key? (notes)`: a key without a type but with notes for people.
    if rest.starts_with('(') {
        return Some((key.to_owned(), rest));
    }
    let expression = rest.strip_prefix(':')?;
    Some((key.to_owned(), expression.trim()))
}

/// A key written without a type but with notes (`direction? (horizontal|vertical|grid)`,
/// `y (its top-left, in the parent)`): notes that are only `a|b|c` words are its choices; any
/// other notes describe it, and its type comes from its name as for a bare key.
fn noted_key(key: &str, expression: &str) -> (Value, bool) {
    let (rest, notes) = strip_notes(expression);
    let description = notes.join("; ");
    if !rest.trim().is_empty() {
        return (json!({ "type": "json", "description": expression }), false);
    }
    let word = |text: &str| !text.is_empty() && text.chars().all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '-');
    if let [only] = notes.as_slice() {
        let choices: Vec<&str> = only.split('|').map(str::trim).collect();
        if choices.len() > 1 && choices.iter().all(|choice| word(choice)) {
            return (json!({ "type": "string", "enum": choices }), true);
        }
    }
    match bare_key(key) {
        Some(mut node) => {
            if let Some(object) = node.as_object_mut()
                && !description.is_empty()
            {
                let own = object.get("description").and_then(Value::as_str).map(str::to_owned);
                let text = own.map_or_else(|| description.clone(), |own| format!("{own}; {description}"));
                object.insert("description".into(), Value::String(text));
            }
            (node, true)
        }
        None => (json!({ "type": "json", "description": description }), false),
    }
}

/// An object id: a whole number or a string.
fn any_id() -> Value {
    json!({ "oneOf": [{ "type": "integer" }, { "type": "string" }], "description": "an id" })
}

/// The type of a key written without one (`{x, y, width, height}`), when its name says it
/// unambiguously. Names that could mean several things (`target`, `fill`, `library`) stay untyped.
fn bare_key(key: &str) -> Option<Value> {
    let lower = key.to_ascii_lowercase();
    let kind = match lower.as_str() {
        "x" | "y" | "x0" | "y0" | "x1" | "y1" | "x2" | "y2" | "cx" | "cy" | "dx" | "dy" | "width" | "height" | "w" | "h" | "radius" | "size" | "angle"
        | "rotation" | "scale" | "opacity" | "weight" | "left" | "top" | "right" | "bottom" | "seconds" | "time" | "duration" | "start" | "end" | "offset"
        | "spacing" => "number",
        // An object id is a number in some kits and a string in others (KitDrawing ids are strings,
        // DR2; Slide takes both): either, so the check never refuses a kit's own ids.
        "id" => return Some(any_id()),
        "index" | "page" | "count" | "item" | "layer" | "artboard" | "frame" | "column" | "row" | "columns" | "rows" => "integer",
        "name" | "title" | "text" | "path" | "url" | "file" | "font" | "family" | "style" | "color" | "label" | "preset" | "prefix" | "suffix" => "string",
        "copy" | "visible" | "hidden" | "closed" | "locked" | "enabled" | "selected" | "recursive" | "all" => "boolean",
        "ids" => return Some(json!({ "type": "array", "items": any_id() })),
        "items" | "layers" | "pages" | "artboards" => return Some(json!({ "type": "array", "items": { "type": "integer" } })),
        _ => {
            let camel = |prefix: &str| key.strip_prefix(prefix).is_some_and(|rest| rest.starts_with(|ch: char| ch.is_ascii_uppercase()));
            if ["include", "is", "has", "show", "use", "allow", "keep", "preserve"].iter().any(|prefix| camel(prefix)) {
                "boolean"
            } else if key.ends_with("Name") || key.ends_with("Base64") || key.ends_with("Text") {
                "string"
            } else if key.ends_with("Index") || key.ends_with("Count") {
                "integer"
            } else {
                return None;
            }
        }
    };
    if lower == "index" || key.ends_with("Index") {
        return Some(json!({ "type": kind, "description": FROM_ZERO }));
    }
    Some(json!({ "type": kind }))
}

/// What every `index` says: agents take "slide 4" from users and must not pass 4.
const FROM_ZERO: &str = "a position counted from 0 (the first is 0)";

/// One property: its schema node, and whether it was typed precisely.
///
/// No property is marked required. The notation is written for people: a property without `?`
/// is often optional in the engine (paint.bucket's "angle"). A harness rejects calls that miss
/// a required parameter, which would force the model to invent values, while a missing value
/// only earns an engine error the model can act on. Kits that hand-write schemas may require.
fn property(expression: &str) -> (Value, bool) {
    let original = expression.trim();
    // Parenthetical notes become the description.
    let (expression, notes) = strip_notes(original);
    let mut expression = expression.trim().to_owned();
    if let Some(stripped) = expression.strip_suffix('?') {
        expression = stripped.trim_end().to_owned();
    }
    let mut default = None;
    if let Some((before, after)) = split_default(&expression) {
        default = Some(after.trim().to_owned());
        expression = before.trim().to_owned();
    }
    let (mut node, typed) = value(&expression);
    if let Some(object) = node.as_object_mut() {
        let mut description = notes;
        if let Some(raw) = &default {
            match default_value(raw, object.get("type").and_then(Value::as_str)) {
                Some(value) => {
                    object.insert("default".into(), value);
                }
                None => description.push(format!("default {raw}")),
            }
        }
        if !typed {
            description.insert(0, original.to_owned());
        }
        if let Some(own) = object.get("description").and_then(Value::as_str) {
            description.insert(usize::from(!typed), own.to_owned());
        }
        if !description.is_empty() {
            object.insert("description".into(), Value::String(description.join("; ")));
        }
    }
    (node, typed)
}

/// Removes `( … )` groups that follow the type, returning them as notes.
fn strip_notes(expression: &str) -> (String, Vec<String>) {
    let mut out = String::new();
    let mut notes = Vec::new();
    let mut depth = 0i32;
    let mut quoted = false;
    let mut note = String::new();
    for ch in expression.chars() {
        match ch {
            '"' if depth == 0 => {
                quoted = !quoted;
                out.push(ch);
            }
            '(' if !quoted => {
                if depth > 0 {
                    note.push(ch);
                }
                depth += 1;
            }
            ')' if !quoted && depth > 0 => {
                depth -= 1;
                if depth == 0 {
                    notes.push(note.trim().to_owned());
                    note.clear();
                } else {
                    note.push(ch);
                }
            }
            _ if depth > 0 => note.push(ch),
            _ => out.push(ch),
        }
    }
    (out, notes.into_iter().filter(|note| !note.is_empty()).collect())
}

/// `type=default`, splitting at the last top-level `=` that is not part of `==` or a range.
fn split_default(expression: &str) -> Option<(&str, &str)> {
    let mut depth = 0i32;
    let mut quoted = false;
    let mut found = None;
    let bytes = expression.as_bytes();
    for (index, ch) in expression.char_indices() {
        match ch {
            '"' => quoted = !quoted,
            '{' | '[' => depth += 1,
            '}' | ']' => depth -= 1,
            '=' if !quoted && depth == 0 && bytes.get(index + 1) != Some(&b'=') && (index == 0 || bytes.get(index - 1) != Some(&b'=')) => {
                found = Some(index);
                break;
            }
            _ => {}
        }
    }
    let index = found?;
    Some((&expression[..index], &expression[index + 1..]))
}

/// The schema node for a type expression, and whether it is precise.
fn value(expression: &str) -> (Value, bool) {
    let expression = expression.trim();
    if expression.is_empty() {
        return (json!({ "type": "json" }), false);
    }
    // A quoted string: one literal, or `"a|b|c"` choices (open when it ends with an ellipsis).
    if let Some(inner) = expression.strip_prefix('"').and_then(|rest| rest.strip_suffix('"'))
        && !inner.contains('"')
    {
        // One quoted value is a format or placeholder ("#rrggbb"), not the only allowed value.
        if !inner.contains('|') {
            return (json!({ "type": "string", "description": format!("like {inner}") }), true);
        }
        let choices: Vec<&str> = inner.split('|').map(str::trim).filter(|choice| !choice.is_empty()).collect();
        let open = choices.iter().any(|choice| *choice == "…" || *choice == "..." || choice.ends_with('…'));
        let closed: Vec<&str> = choices.into_iter().filter(|choice| *choice != "…" && *choice != "..." && !choice.ends_with('…')).collect();
        if open || closed.is_empty() {
            return (json!({ "type": "string", "description": format!("for example {}", closed.join(", ")) }), true);
        }
        return (json!({ "type": "string", "enum": closed }), true);
    }
    // Top-level unions of different shapes are typed loosely.
    let alternatives = split_top(expression, '|');
    if alternatives.len() > 1 {
        let nodes: Vec<(Value, bool)> = alternatives.iter().map(|part| value(part)).collect();
        // `none|autoHeight|shrinkText`: bare words that are not type names are string choices.
        let identifier = |part: &&str| {
            let part = part.trim();
            !part.is_empty()
                && part.chars().all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '-')
                && part.starts_with(|ch: char| ch.is_ascii_alphabetic())
                && word(part).is_none()
        };
        let numbers: Vec<i64> = alternatives.iter().filter_map(|part| part.trim().parse::<i64>().ok()).collect();
        if numbers.len() == alternatives.len() {
            return (json!({ "type": "integer", "enum": numbers }), true);
        }
        if alternatives.iter().all(identifier) {
            return (json!({ "type": "string", "enum": alternatives.iter().map(|part| part.trim()).collect::<Vec<_>>() }), true);
        }
        let quoted_literals: Vec<String> =
            alternatives.iter().filter_map(|part| part.trim().strip_prefix('"').and_then(|rest| rest.strip_suffix('"')).map(str::to_owned)).collect();
        if quoted_literals.len() == alternatives.len() {
            return (json!({ "type": "string", "enum": quoted_literals }), true);
        }
        let types: Vec<Option<&str>> = nodes.iter().map(|(node, _)| node.get("type").and_then(Value::as_str)).collect();
        if nodes.iter().all(|(_, typed)| *typed)
            && types.windows(2).all(|pair| pair[0] == pair[1])
            && types[0].is_some_and(|kind| kind != "array" && kind != "object")
        {
            let mut node = nodes[0].0.clone();
            if let Some(object) = node.as_object_mut() {
                object.remove("enum");
            }
            return (node, true);
        }
        return (json!({ "type": "json" }), false);
    }
    if expression.starts_with('[') && expression.ends_with(']') {
        return array(&expression[1..expression.len() - 1]);
    }
    if expression.starts_with('{') && expression.ends_with('}') {
        return match from_kit_params(expression) {
            Ok(inner) if inner.properties > 0 => {
                (json!({ "type": "object", "properties": inner.schema, "additionalProperties": true }), inner.precise == inner.properties)
            }
            _ => (json!({ "type": "object", "additionalProperties": true }), true),
        };
    }
    // A literal written as the type is its own type and its default: `convert?: true`, `steps?: 1`.
    match expression {
        "true" | "false" => return (json!({ "type": "boolean", "default": expression == "true" }), true),
        "byte" => return (json!({ "type": "integer", "description": "0 to 255" }), true),
        _ => {}
    }
    if let Ok(number) = expression.parse::<i64>() {
        return (json!({ "type": "integer", "default": number }), true);
    }
    if let Ok(number) = expression.parse::<f64>()
        && let Some(default) = serde_json::Number::from_f64(number)
    {
        return (json!({ "type": "number", "default": default }), true);
    }
    if let Some((low, high)) = range(expression) {
        // A range from 0 to 1 is a fraction (opacity, flow, a point along a curve): as whole
        // numbers it would allow only its two ends.
        let fraction = low.trim() == "0" && high.trim() == "1";
        let integer = !fraction && !low.contains('.') && !high.contains('.');
        return (json!({ "type": if integer { "integer" } else { "number" }, "description": format!("{low} to {high}") }), true);
    }
    match word(expression) {
        Some(node) => (node, true),
        None => (json!({ "type": "json" }), false),
    }
}

/// `[T]` is a list of T; `[x,y]`, `[x,y,w,h]`, `[tl,tr,br,bl]` are fixed-length number lists.
fn array(inner: &str) -> (Value, bool) {
    let parts: Vec<&str> = split_top(inner, ',').into_iter().map(str::trim).filter(|part| !part.is_empty()).collect();
    match parts.as_slice() {
        [] => (json!({ "type": "array" }), true),
        [one] if one.ends_with('…') || one.ends_with("...") => (json!({ "type": "array" }), true),
        [one] => {
            let (items, typed) = value(one);
            (json!({ "type": "array", "items": items }), typed)
        }
        many => {
            let named = many.iter().all(|part| part.chars().all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '?' || ch == '…' || ch == '.'));
            let names: Vec<&str> = many.iter().map(|part| part.trim_end_matches('?')).filter(|part| *part != "…" && *part != "...").collect();
            if named && names.iter().all(|name| word(name).is_none()) {
                return (json!({ "type": "array", "items": { "type": "number" }, "description": format!("[{}]", names.join(", ")) }), true);
            }
            let items: Vec<(Value, bool)> = many.iter().filter(|part| **part != "…" && **part != "...").map(|part| value(part)).collect();
            let first = items.first().map(|(node, _)| node.clone()).unwrap_or_else(|| json!({ "type": "json" }));
            let same = items.iter().all(|(node, _)| node.get("type") == first.get("type"));
            if same && items.iter().all(|(_, typed)| *typed) {
                return (json!({ "type": "array", "items": first }), true);
            }
            (json!({ "type": "array" }), false)
        }
    }
}

/// `0..100`, `-1..1`, `0.5..5000`.
fn range(expression: &str) -> Option<(&str, &str)> {
    let (low, high) = expression.split_once("..")?;
    let number = |text: &str| !text.is_empty() && text.trim_start_matches('-').chars().all(|ch| ch.is_ascii_digit() || ch == '.');
    let high = high.trim_end_matches(|ch: char| ch.is_alphabetic() || ch == '%' || ch == ' ');
    (number(low.trim()) && number(high.trim())).then_some((low.trim(), high.trim()))
}

/// The kit command type words.
fn word(word: &str) -> Option<Value> {
    let lower = word.trim().to_ascii_lowercase();
    let kind = match lower.as_str() {
        "bool" | "boolean" => "boolean",
        "str" | "string" | "text" | "name" | "path" | "file" | "url" | "timecode" | "hex" | "color" | "colour" | "font" | "family" | "uuid" => "string",
        "id" | "n" | "int" | "integer" | "i32" | "i64" | "u8" | "u16" | "u32" | "u64" | "usize" | "frames" | "frame" | "ticks" | "index" | "count" | "seed" => {
            "integer"
        }
        "f32" | "f64" | "number" | "float" | "px" | "pt" | "deg" | "degrees" | "seconds" | "secs" | "ms" | "%" | "percent" | "x" | "y" | "w" | "h" | "db"
        | "scale" | "angle" | "ratio" => "number",
        "json" | "value" | "any" | "object" => "json",
        "null" => "null",
        _ => return None,
    };
    let mut node = json!({ "type": kind });
    if let Some(object) = node.as_object_mut() {
        let unit = match lower.as_str() {
            "id" => Some("an id"),
            "index" => Some(FROM_ZERO),
            "ticks" => Some("ticks (254016000000 per second)"),
            "frames" | "frame" => Some("frames"),
            "px" => Some("pixels"),
            "pt" => Some("points"),
            "deg" | "degrees" | "angle" => Some("degrees"),
            "seconds" | "secs" => Some("seconds"),
            "ms" => Some("milliseconds"),
            "%" | "percent" => Some("percent"),
            "color" | "colour" | "hex" => Some("a colour such as #rrggbb"),
            _ => None,
        };
        if let Some(unit) = unit {
            object.insert("description".into(), Value::String(unit.into()));
        }
    }
    Some(node)
}

/// A default written in the notation, as JSON of the property's type when it is unambiguous.
fn default_value(raw: &str, kind: Option<&str>) -> Option<Value> {
    let raw = raw.trim();
    match kind? {
        "boolean" => match raw {
            "true" => Some(Value::Bool(true)),
            "false" => Some(Value::Bool(false)),
            _ => None,
        },
        "integer" => raw.parse::<i64>().ok().map(Value::from),
        "number" => raw.parse::<f64>().ok().and_then(|number| serde_json::Number::from_f64(number).map(Value::Number)),
        "string" => raw
            .strip_prefix('"')
            .and_then(|rest| rest.strip_suffix('"'))
            .filter(|inner| !inner.contains('"'))
            .map(|inner| Value::String(inner.to_owned()))
            .or_else(|| raw.starts_with('#').then(|| Value::String(raw.to_owned()))),
        _ => None,
    }
}

/// Whether a command's target parameter ([`crate::KitCommand::targets`]) takes one id or a list.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TargetArity {
    One,
    Many,
}

/// The JSON Schema keyword hosts put on a command's target parameter (`"x-khp-role": "targets"`),
/// and the one at the top of its parameters that lists the editor state it reads (`"x-khp-reads"`,
/// [`crate::KitCommand::reads`]); Kit Process Protocol section 6.
pub const ROLE_KEYWORD: &str = "x-khp-role";
pub const READS_KEYWORD: &str = "x-khp-reads";
/// The role hosts give a parameter that names a place rather than an object
/// ([`crate::KitCommand::places`]): `"x-khp-role": "place"`.
pub const PLACE_ROLE: &str = "place";
/// The role hosts give a parameter besides the targets that names objects by id
/// ([`crate::KitCommand::objects`]): `"x-khp-role": "object"`.
pub const OBJECT_ROLE: &str = "object";
/// The keyword at the top of a command's parameters that says its effect does not depend on where
/// its target is ([`crate::KitCommand::position_independent`]): `"x-khp-position": "independent"`.
pub const POSITION_KEYWORD: &str = "x-khp-position";
/// The keyword on a command's target parameter that gives the prefix of its index spelling
/// ([`crate::KitCommand::index`]): `"x-khp-index": "#"`.
pub const INDEX_KEYWORD: &str = "x-khp-index";
/// The keyword beside [`INDEX_KEYWORD`] that says the index counts from the other end of the list
/// ([`crate::KitCommand::index_reversed`]): `"x-khp-index-order": "reversed"`.
pub const INDEX_ORDER_KEYWORD: &str = "x-khp-index-order";
/// The keyword on a command's target parameter that says a whole number naming no object is a
/// place in the list, counted from 1 ([`crate::KitCommand::index_numbers`]):
/// `"x-khp-index-numbers": true`.
pub const INDEX_NUMBERS_KEYWORD: &str = "x-khp-index-numbers";
/// The keyword on a parameter that names objects (the targets, or an object parameter) listing the
/// types they are of ([`crate::KitCommand::object_types`]): `"x-khp-types": ["Layer"]`.
pub const TYPES_KEYWORD: &str = "x-khp-types";
/// The keyword on a command's target parameter that says it also takes an object by its name, the
/// stored field holding names ([`crate::KitCommand::name_field`]): `"x-khp-name": "name"`.
pub const NAME_KEYWORD: &str = "x-khp-name";

/// Checks a command's `targets` declaration ([`crate::KitCommand::targets`]) against its
/// `ParameterSchemaSpec`: `name` is one of its parameters, an id or a list of ids (an `array` of
/// them), or a `oneOf` of ids and lists of ids (one id or a list: a 3D kit's `objects`).
/// An id is a `string`, an `integer`, or a `oneOf` of those (what [`from_kit_params`] writes for an
/// id that may be either, a name or a number); anything else (an object, a boolean, free `json`)
/// is not. Answers whether it takes one id or a list (`Many` when a list is among its forms: `on`
/// fills it with a list).
pub fn check_targets(schema: &Value, name: &str) -> Result<TargetArity, String> {
    let property = schema.get(name).ok_or_else(|| format!("targets names `{name}`, which is not a parameter of the command's schema"))?;
    if is_id(property) {
        return Ok(TargetArity::One);
    }
    if is_ids(property) {
        return Ok(TargetArity::Many);
    }
    match property.get("oneOf").and_then(Value::as_array) {
        Some(branches) if !branches.is_empty() && branches.iter().all(|branch| is_id(branch) || is_ids(branch)) => Ok(TargetArity::Many),
        _ => Err(format!(
            "targets names `{name}`, which is neither an id (a string, an integer, or a `oneOf` of them), a list of ids (an array of them), nor a `oneOf` of ids and lists of ids"
        )),
    }
}

/// Whether a value schema is a list of ids (an `array` whose items are ids).
fn is_ids(node: &Value) -> bool {
    node.get("type").and_then(Value::as_str) == Some("array") && node.get("items").is_some_and(is_id)
}

/// Whether a value schema is an id: a `string`, an `integer`, or a `oneOf` whose every branch is one.
fn is_id(node: &Value) -> bool {
    match node.get("oneOf").and_then(Value::as_array) {
        Some(branches) => !branches.is_empty() && branches.iter().all(is_id),
        None => matches!(node.get("type").and_then(Value::as_str), Some("string" | "integer")),
    }
}

/// Checks that `schema` is a well-formed `ParameterSchemaSpec`; the converter only produces such
/// schemas, and kits that write their own can check them here.
pub fn validate(schema: &Value) -> Result<(), String> {
    let Some(properties) = schema.as_object() else { return Err("a parameter schema is an object".into()) };
    for (key, node) in properties {
        value_node(node, key, true)?;
    }
    Ok(())
}

fn value_node(node: &Value, at: &str, property: bool) -> Result<(), String> {
    let Some(object) = node.as_object() else { return Err(format!("{at}: a schema node is an object")) };
    for key in object.keys() {
        let allowed = [
            "type",
            "description",
            "title",
            "default",
            "examples",
            "enum",
            "const",
            "items",
            "properties",
            "additionalProperties",
            "oneOf",
            "minimum",
            "maximum",
            "multipleOf",
        ]
        .contains(&key.as_str())
            || (property && key == "required")
            || (object.get("type").and_then(Value::as_str) == Some("file") && ["access", "accept", "kind"].contains(&key.as_str()))
            || (key == "notFile" && object.get("type").and_then(Value::as_str) == Some("string"));
        if !allowed {
            return Err(format!("{at}: unknown keyword {key}"));
        }
    }
    if property && object.get("required").is_some_and(|required| required != &Value::Bool(true)) {
        return Err(format!("{at}: required must be true when present"));
    }
    // A string reviewed as carrying no path (KHP A28, `testing::check_file_parameters`).
    if object.get("notFile").is_some_and(|reviewed| reviewed != &Value::Bool(true)) {
        return Err(format!("{at}: notFile must be true when present"));
    }
    for key in ["minimum", "maximum", "multipleOf"] {
        if let Some(limit) = object.get(key)
            && (!matches!(object.get("type").and_then(Value::as_str), Some("number" | "integer"))
                || limit.as_f64().is_none_or(|n| !n.is_finite() || key == "multipleOf" && n <= 0.0))
        {
            return Err(format!("{at}: {key} requires a numeric type and a finite limit (positive multipleOf)"));
        }
    }
    if object.get("minimum").and_then(Value::as_f64).zip(object.get("maximum").and_then(Value::as_f64)).is_some_and(|(min, max)| min > max) {
        return Err(format!("{at}: minimum exceeds maximum"));
    }
    if let Some(branches) = object.get("oneOf") {
        let branches = branches.as_array().filter(|list| list.len() >= 2).ok_or_else(|| format!("{at}: oneOf needs at least two branches"))?;
        for (index, branch) in branches.iter().enumerate() {
            value_node(branch, &format!("{at}.oneOf[{index}]"), false)?;
        }
        return Ok(());
    }
    let kind = object.get("type").and_then(Value::as_str).ok_or_else(|| format!("{at}: needs a type"))?;
    match kind {
        "string" | "number" | "integer" | "boolean" | "null" | "json" => {}
        "file" => file_node(object, at)?,
        "array" => {
            if let Some(items) = object.get("items") {
                value_node(items, &format!("{at}[]"), false)?;
            }
        }
        "object" => {
            if !object.get("additionalProperties").is_some_and(Value::is_boolean) {
                return Err(format!("{at}: an object node states additionalProperties"));
            }
            if let Some(properties) = object.get("properties").and_then(Value::as_object) {
                for (key, inner) in properties {
                    value_node(inner, &format!("{at}.{key}"), true)?;
                }
            }
        }
        other => return Err(format!("{at}: unknown type {other}")),
    }
    if let Some(choices) = object.get("enum") {
        let choices = choices.as_array().ok_or_else(|| format!("{at}: enum is a list"))?;
        let matches = |choice: &Value| match kind {
            "string" => choice.is_string(),
            "number" => choice.is_number(),
            "integer" => choice.is_i64() || choice.is_u64(),
            "boolean" => choice.is_boolean(),
            _ => false,
        };
        if choices.is_empty() || !choices.iter().all(matches) {
            return Err(format!("{at}: enum values must be of type {kind}"));
        }
    }
    Ok(())
}

/// Checks a command's output schema (KHP A1 `output.schema`): one `ValueSchemaSpec` node, as a
/// parameter's but without `required`, which only a property carries.
pub fn validate_output(schema: &Value) -> Result<(), String> {
    value_node(schema, "output", false)
}

/// A `file` parameter (KHP A28): `access` is `read`, `create`, or `write`; `accept` lists
/// extensions without the dot; `kind: "folder"` names a folder, which is only read.
fn file_node(object: &Map<String, Value>, at: &str) -> Result<(), String> {
    let access = object.get("access").and_then(Value::as_str).ok_or_else(|| format!("{at}: a file states its access"))?;
    if !["read", "create", "write"].contains(&access) {
        return Err(format!("{at}: file access is read, create, or write"));
    }
    match object.get("accept") {
        None => {}
        Some(Value::Array(list)) if list.iter().all(|ext| ext.as_str().is_some_and(|ext| !ext.is_empty() && !ext.starts_with('.'))) => {}
        Some(_) => return Err(format!("{at}: accept lists extensions without the dot")),
    }
    match object.get("kind") {
        None => Ok(()),
        Some(kind) if kind == "folder" && access == "read" => Ok(()),
        Some(kind) if kind == "folder" => Err(format!("{at}: a folder is only read")),
        Some(_) => Err(format!("{at}: file kind is folder when present")),
    }
}

/// Whether a value schema names a file (KHP A28): typed `file` (or, in JSON Schema, a string with
/// `x-khp-file`, A29), directly, as an array's items, or as one of its `oneOf` branches.
#[must_use]
pub fn names_file(node: &Value) -> bool {
    let Some(object) = node.as_object() else { return false };
    object.get("type").and_then(Value::as_str) == Some("file")
        || object.contains_key("x-khp-file")
        || object.get("items").is_some_and(names_file)
        || object.get("oneOf").and_then(Value::as_array).is_some_and(|branches| branches.iter().any(names_file))
}

/// One parameter a call got wrong (Kit Process Protocol §10, `invalid_params` `data.errors`): where,
/// as a JSON Pointer into the params (`/target/row`, `/fields/0/type`), what is wrong, and what the
/// command takes there.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct ParamError {
    pub path: String,
    pub message: String,
    pub expected: String,
}

/// Separates an engine's [`refusal`] message from its parameter errors: ASCII's record separator.
pub const REFUSAL_SEPARATOR: char = '\u{1e}';

/// An engine's refusal of a call's parameters, for a check its schema cannot state (a record's
/// `values` key that names no field of the table): `Err(refusal(&errors))` from
/// [`crate::KitDocument::execute`]. The message reads as the errors' messages where it is shown as
/// text, and the binding answers `invalid_params` with `data.errors` (Kit Process Protocol section
/// 10): kition-headless, and the page's kit editor, which shows the message alone.
#[must_use]
pub fn refusal(errors: &[ParamError]) -> String {
    let message = errors.iter().map(|error| error.message.as_str()).collect::<Vec<_>>().join("; ");
    format!("{message}{REFUSAL_SEPARATOR}{}", serde_json::to_string(errors).unwrap_or_else(|_| "[]".into()))
}

/// A [`refusal`]'s message and errors; `None` for any other error message.
#[must_use]
pub fn parse_refusal(message: &str) -> Option<(&str, Vec<ParamError>)> {
    let (text, errors) = message.split_once(REFUSAL_SEPARATOR)?;
    Some((text, serde_json::from_str(errors).ok()?))
}

/// Checks a call's `params` against the command's `ParameterSchemaSpec` (KHP A5, A18): required
/// keys are present; each value has its node's type (`json` takes any value; `integer` takes
/// whole numbers; a `file` is a path string with one of its `accept` extensions); enums and
/// `const` hold; arrays check their items; objects check their properties and, when
/// `additionalProperties` is false, refuse other keys; a `oneOf` value matches a branch. The
/// top level is open here: [`refuse_unknown`] refuses the keys the schema does not name. Answers one error for
/// each parameter that is wrong, by parameter name, each saying the key, what was expected,
/// what was given, and an example.
#[must_use]
pub fn param_errors(schema: &Value, params: &Map<String, Value>) -> Vec<ParamError> {
    let Some(properties) = schema.as_object() else { return Vec::new() };
    let mut errors = Vec::new();
    for (key, node) in properties {
        let required = node.get("required") == Some(&Value::Bool(true));
        let pointer = format!("/{}", pointer_token(key));
        match params.get(key) {
            // `null` is "none" for a key that may be left out (`layer.setParent {parent: null}`).
            Some(Value::Null) if !required => {}
            Some(value) => {
                if let Err(error) = check_value(node, value, key, &pointer) {
                    errors.push(error);
                }
            }
            None if required => errors.push(ParamError {
                path: pointer,
                message: format!("`{key}` is required: expected {}. {}", expected(node), value_source(node)),
                expected: expected(node),
            }),
            None => {}
        }
    }
    errors
}

/// [`param_errors`]' first error, as its message.
pub fn check_params(schema: &Value, params: &Map<String, Value>) -> Result<(), String> {
    match param_errors(schema, params).into_iter().next() {
        Some(error) => Err(error.message),
        None => Ok(()),
    }
}

/// A key as a JSON Pointer token (RFC 6901).
fn pointer_token(key: &str) -> String {
    key.replace('~', "~0").replace('/', "~1")
}

/// Refuses a top-level key `command`'s `ParameterSchemaSpec` does not name, so an agent that
/// misspells a parameter (`objects` for `object`) is told instead of the command running without
/// it. The error names the key, the parameter it most resembles, and the ones the command takes.
/// kition-headless calls it for every command that has a schema and does not say its top level
/// is open (`KitCommand::open_params`), before the command runs; kits may call it too, at
/// dispatch, and answer the same words. `check_params` leaves the top level open.
pub fn refuse_unknown(command: &str, schema: &Value, params: &Value) -> Result<(), String> {
    let (Some(names), Some(given)) = (schema.as_object(), params.as_object()) else { return Ok(()) };
    let Some(unknown) = given.keys().find(|key| !names.contains_key(*key)) else { return Ok(()) };
    let lower = unknown.to_ascii_lowercase();
    let limit = (unknown.len() / 3).max(2);
    let closest = names
        .keys()
        .map(|name| (edit_distance(&lower, &name.to_ascii_lowercase()), name))
        .filter(|(distance, _)| *distance <= limit)
        .min_by_key(|(distance, _)| *distance)
        .map(|(_, name)| format!("; did you mean `{name}`?"))
        .unwrap_or_default();
    let taken = if names.is_empty() {
        "it takes no parameters".to_owned()
    } else {
        format!("it takes {}", names.keys().map(|name| format!("`{name}`")).collect::<Vec<_>>().join(", "))
    };
    Err(format!("`{command}` has no parameter `{unknown}`{closest} ({taken})"))
}

fn edit_distance(a: &str, b: &str) -> usize {
    let b: Vec<char> = b.chars().collect();
    let mut row: Vec<usize> = (0..=b.len()).collect();
    for (i, ca) in a.chars().enumerate() {
        let mut diagonal = i;
        if let Some(first) = row.first_mut() {
            *first = i + 1;
        }
        for (j, cb) in b.iter().enumerate() {
            let left = row.get(j).copied().unwrap_or(0);
            let above = row.get(j + 1).copied().unwrap_or(0);
            let value = (diagonal + usize::from(ca != *cb)).min(left + 1).min(above + 1);
            diagonal = above;
            if let Some(cell) = row.get_mut(j + 1) {
                *cell = value;
            }
        }
    }
    row.last().copied().unwrap_or(0)
}

/// `value` against `node`; `at` names it in messages (`target.row`), `pointer` in the error's path.
fn check_value(node: &Value, value: &Value, at: &str, pointer: &str) -> Result<(), ParamError> {
    let Some(object) = node.as_object() else { return Ok(()) };
    let fail = |message: String, node: &Value| ParamError { path: pointer.to_owned(), message, expected: expected(node) };
    if let Some(branches) = object.get("oneOf").and_then(Value::as_array) {
        if branches.iter().any(|branch| check_value(branch, value, at, pointer).is_ok()) {
            return Ok(());
        }
        return Err(fail(mismatch(at, node, value), node));
    }
    let kind = object.get("type").and_then(Value::as_str).unwrap_or("json");
    let fits = match kind {
        "json" => true,
        "string" => value.is_string(),
        "number" => value.is_number(),
        "integer" => value.is_i64() || value.is_u64() || value.as_f64().is_some_and(|n| n.fract() == 0.0 && n.is_finite()),
        "boolean" => value.is_boolean(),
        "null" => value.is_null(),
        "file" => value.as_str().is_some_and(|path| !path.is_empty()),
        "array" => value.is_array(),
        "object" => value.is_object(),
        _ => true,
    };
    if !fits {
        return Err(fail(mismatch(at, node, value), node));
    }
    if let Some(choices) = object.get("enum").and_then(Value::as_array)
        && !choices.contains(value)
    {
        return Err(fail(mismatch(at, node, value), node));
    }
    if let Some(constant) = object.get("const")
        && constant != value
    {
        return Err(fail(mismatch(at, node, value), node));
    }
    if kind == "file"
        && let (Some(path), Some(accept)) = (value.as_str(), object.get("accept").and_then(Value::as_array))
        && object.get("kind").and_then(Value::as_str) != Some("folder")
    {
        let extension = path.rsplit_once('.').map(|(_, ext)| ext.to_ascii_lowercase());
        if !accept.iter().filter_map(Value::as_str).any(|ext| extension.as_deref() == Some(&ext.to_ascii_lowercase())) {
            return Err(fail(format!("`{at}`: expected {}, got {}", expected(node), shown(value)), node));
        }
    }
    if let (Some(items), Some(list)) = (object.get("items"), value.as_array()) {
        for (index, item) in list.iter().enumerate() {
            check_value(items, item, &format!("{at}[{index}]"), &format!("{pointer}/{index}"))?;
        }
    }
    if let Some(fields) = value.as_object() {
        let properties = object.get("properties").and_then(Value::as_object);
        if let Some(properties) = properties {
            for (key, inner) in properties {
                let required = inner.get("required") == Some(&Value::Bool(true));
                match fields.get(key) {
                    Some(Value::Null) if !required => {}
                    Some(inner_value) => check_value(inner, inner_value, &format!("{at}.{key}"), &format!("{pointer}/{}", pointer_token(key)))?,
                    None if required => {
                        return Err(ParamError {
                            path: format!("{pointer}/{}", pointer_token(key)),
                            message: format!("`{at}.{key}` is required: expected {}", expected(inner)),
                            expected: expected(inner),
                        });
                    }
                    None => {}
                }
            }
        }
        if object.get("additionalProperties") == Some(&Value::Bool(false)) {
            let known = |key: &String| properties.is_some_and(|properties| properties.contains_key(key));
            if let Some(extra) = fields.keys().find(|key| !known(key)) {
                let names: Vec<&str> = properties.map(|p| p.keys().map(String::as_str).collect()).unwrap_or_default();
                let fields = if names.is_empty() { "none".to_owned() } else { names.join(", ") };
                return Err(ParamError {
                    path: format!("{pointer}/{}", pointer_token(extra)),
                    message: format!("`{at}.{extra}` is not a field of `{at}`: its fields are {fields}"),
                    expected: format!("one of the fields {fields}"),
                });
            }
        }
    }
    Ok(())
}

/// Where a valid value of a required parameter comes from (KHP A48): an id names something the
/// document has, which the kit's inspect lists; anything else has no default to fall back on.
fn value_source(node: &Value) -> &'static str {
    let id = is_id(node) && node.get("description").and_then(Value::as_str).is_some_and(|text| text.contains("id"));
    let ids = node.get("items").is_some_and(|items| is_id(items) && items.get("description").and_then(Value::as_str).is_some_and(|text| text.contains("id")));
    if id || ids {
        "It names something in the document: give an id the kit's inspect lists for it."
    } else {
        "The command has no default for it: give it in the call."
    }
}

fn mismatch(at: &str, node: &Value, value: &Value) -> String {
    format!("`{at}`: expected {}, got {}", expected(node), shown(value))
}

/// What a node takes, for an error: its type, enum or constant, and an example.
fn expected(node: &Value) -> String {
    let Some(object) = node.as_object() else { return "a value".into() };
    if let Some(branches) = object.get("oneOf").and_then(Value::as_array) {
        return branches.iter().map(expected).collect::<Vec<_>>().join(" or ");
    }
    let kind = object.get("type").and_then(Value::as_str).unwrap_or("json");
    let mut text = match kind {
        "json" => "any value".to_owned(),
        "file" => match object.get("accept").and_then(Value::as_array) {
            Some(accept) if !accept.is_empty() => {
                format!("a workspace path ending in {}", accept.iter().filter_map(Value::as_str).map(|ext| format!(".{ext}")).collect::<Vec<_>>().join(", "))
            }
            _ if object.get("kind").and_then(Value::as_str) == Some("folder") => "a workspace folder path".to_owned(),
            _ => "a workspace path".to_owned(),
        },
        "array" => match object.get("items") {
            Some(items) => format!("a list of {}", expected(items)),
            None => "a list".to_owned(),
        },
        "integer" => "a whole number".to_owned(),
        "object" => "an object".to_owned(),
        other => format!("a {other}"),
    };
    if let Some(choices) = object.get("enum").and_then(Value::as_array) {
        text = format!("one of {}", choices.iter().map(Value::to_string).collect::<Vec<_>>().join(", "));
    } else if let Some(constant) = object.get("const") {
        text = format!("exactly {constant}");
    }
    if let Some(description) = object.get("description").and_then(Value::as_str) {
        text = format!("{text} ({description})");
    }
    let example = object
        .get("examples")
        .and_then(Value::as_array)
        .and_then(|list| list.first())
        .or_else(|| object.get("default"))
        .or_else(|| object.get("enum").and_then(Value::as_array).and_then(|list| list.first()));
    if let Some(example) = example {
        text = format!("{text}, for example {example}");
    }
    text
}

fn shown(value: &Value) -> String {
    let kind = match value {
        Value::Null => "null",
        Value::Bool(_) => "a boolean",
        Value::Number(_) => "a number",
        Value::String(_) => "a string",
        Value::Array(_) => "a list",
        Value::Object(_) => "an object",
    };
    let mut text = value.to_string();
    if text.chars().count() > 60 {
        text = format!("{}…", text.chars().take(60).collect::<String>());
    }
    format!("{kind} {text}")
}

/// The top-level parameters of a `ParameterSchemaSpec` that name files (KHP A28), by name.
#[must_use]
pub fn file_params(schema: &Value) -> Vec<String> {
    schema.as_object().map(|properties| properties.iter().filter(|(_, node)| names_file(node)).map(|(name, _)| name.clone()).collect()).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_target_parameter_is_an_id_or_a_list_of_ids() {
        let schema = json!({
            "id": { "type": "string", "required": true },
            "ids": { "type": "array", "items": { "type": "integer" } },
            "names": { "type": "array", "items": { "type": "object" } },
            "text": { "type": "boolean" },
        });
        assert_eq!(check_targets(&schema, "id"), Ok(TargetArity::One));
        assert_eq!(check_targets(&schema, "ids"), Ok(TargetArity::Many));
        for wrong in ["names", "text", "missing"] {
            let refused = check_targets(&schema, wrong).err().unwrap_or_default();
            assert!(refused.contains(&format!("`{wrong}`")), "{refused}");
        }
    }

    /// regressions/issue-targets-either-id: the converter writes an id that may be a number or a
    /// string as `oneOf: [integer, string]` (`{id}`, `{ids}`, `"object":id|name`), and `targets`
    /// must take it, alone or as a list's items; what is not an id stays refused.
    #[test]
    fn a_target_parameter_may_be_an_id_of_either_kind() {
        let converted = convert("{id, ids?}");
        assert_eq!(check_targets(&converted, "id"), Ok(TargetArity::One));
        assert_eq!(check_targets(&converted, "ids"), Ok(TargetArity::Many));
        let schema = json!({
            "object": { "oneOf": [{ "type": "string" }, { "type": "integer" }], "description": "a name or an id" },
            "objects": { "type": "array", "items": { "oneOf": [{ "type": "integer" }, { "type": "string" }] } },
            "nameOrFlag": { "oneOf": [{ "type": "string" }, { "type": "boolean" }] },
            "shape": { "oneOf": [{ "type": "integer" }, { "type": "object", "additionalProperties": true }] },
            "free": { "type": "json" },
            "lists": { "type": "array", "items": { "type": "array", "items": { "type": "integer" } } },
        });
        assert_eq!(check_targets(&schema, "object"), Ok(TargetArity::One));
        assert_eq!(check_targets(&schema, "objects"), Ok(TargetArity::Many));
        for wrong in ["nameOrFlag", "shape", "free", "lists"] {
            let refused = check_targets(&schema, wrong).err().unwrap_or_default();
            assert!(refused.contains(&format!("`{wrong}`")), "{wrong}: {refused}");
        }
    }

    /// regressions/issue-guard-targets-one-or-many: a parameter that takes one id or a
    /// list (`oneOf [integer, string, array of integers]`, a 3D kit's `objects`) is a target taking
    /// a list; a `oneOf` with a branch that is neither stays refused.
    #[test]
    fn a_target_parameter_may_take_one_id_or_a_list() {
        let schema = json!({
            "objects": { "oneOf": [{ "type": "integer" }, { "type": "string" }, { "type": "array", "items": { "type": "integer" } }] },
            "mixed": { "oneOf": [{ "type": "integer" }, { "type": "array", "items": { "type": "object" } }] },
        });
        assert_eq!(check_targets(&schema, "objects"), Ok(TargetArity::Many));
        let refused = check_targets(&schema, "mixed").err().unwrap_or_default();
        assert!(refused.contains("`mixed`"), "{refused}");
    }

    // regressions/issue-unreadable-param-notes: an entry with no key the notation reads is not
    // dropped silently: the conversion lists it, as written, and the keys around it still convert.
    #[test]
    fn entries_with_no_key_the_notation_reads_are_listed_as_written() {
        let converted = from_kit_params("{replace? (clear others first), id?/ids?, \"frame\"? | \"dx\"?, spacing? [x, y], name?: str}").unwrap();
        assert_eq!(converted.unreadable, vec!["id?/ids?", "\"frame\"? | \"dx\"?", "spacing? [x, y]"]);
        let keys: Vec<&String> = converted.schema.as_object().unwrap().keys().collect();
        assert_eq!(keys, vec!["name", "replace"], "the readable keys still convert");
        for readable in [
            "{id?, ids?}",
            "{\"layer\":id?,\"mode\":\"normal|multiply\"=\"normal\"}",
            "{x, y, width, radius?: pt, ids?}",
            "{name?|title?: text}",
            "{to?: [x,y] | delta: [dx,dy]}",
            "{a, …}",
            "{}",
            "",
        ] {
            assert_eq!(from_kit_params(readable).unwrap().unreadable, Vec::<String>::new(), "{readable}");
        }
    }

    /// the notation marks a parameter optional with `?` (after the key or the type) or gives
    /// it a default (`=value`, or a literal as its type); the rest, typed precisely and not one of
    /// several alternatives or forms, has no default and is not optional. The converter lists
    /// those, and marks them required only when the kit opts in.
    #[test]
    fn the_notation_required_parameters_are_those_with_no_default_that_are_not_optional() {
        let required = |text: &str| {
            let mut keys = from_kit_params(text).unwrap().required;
            keys.sort();
            keys
        };
        assert_eq!(
            required(
                r##"{"layer":id,"name":str?,"opacity":0..100=100,"mode":"a|b"="a","antiAlias":bool=true,"x":f64,"rect":[x,y,w,h] (rect only),"what":somethingodd}"##
            ),
            ["layer", "x"]
        );
        assert_eq!(required("{x, y, radius?: pt, ids?, label: text, depth, convert?: true, steps: 1, kind: a|b}"), ["kind", "label", "x", "y"]);
        assert_eq!(required(r#"{"text":string, "after"?: n, "style"?, "align"? (left|right)}"#), ["text"]);
        assert_eq!(required(r#"{"item":id,"time":ticks|"frame":i64}"#), ["item"], "alternative keys are never required");
        assert!(required(r#"{"hidden":[label]}|{"color":label}"#).is_empty(), "nor the keys of one of several forms");
        assert!(required(r#"{"name":str="Beat"?}"#).is_empty());

        let converted = from_kit_params(r#"{"layer":id,"name":str?}"#).unwrap();
        assert!(converted.schema.as_object().unwrap().values().all(|node| node.get("required").is_none()), "the schema itself requires nothing");
        let opted = converted.required_schema();
        validate(&opted).unwrap();
        assert_eq!(opted["layer"]["required"], true);
        assert!(opted["name"].get("required").is_none());

        let command = |opt_in: bool| {
            crate::KitCommand { params: Some(r#"{"layer":id,"name":str?}"#.into()), notation_required: opt_in, ..Default::default() }.with_kit_schema()
        };
        assert!(command(false).schema.unwrap()["layer"].get("required").is_none(), "off by default: nothing is published required");
        assert_eq!(command(true).schema.unwrap()["layer"]["required"], true, "opted in: the notation's required parameters are");
    }

    /// KHP A48: a missing required parameter is refused naming it, what it takes, and where a
    /// valid value comes from.
    #[test]
    fn the_notation_required_parameters_when_missing_say_where_a_value_comes_from() {
        let schema = from_kit_params(r#"{"layer":id,"name":str}"#).unwrap().required_schema();
        let errors = param_errors(&schema, &Map::new());
        let messages: Vec<&str> = errors.iter().map(|error| error.message.as_str()).collect();
        assert_eq!(errors.iter().map(|error| error.path.as_str()).collect::<Vec<_>>(), ["/layer", "/name"]);
        assert!(
            messages[0].starts_with("`layer` is required: expected a whole number (an id)") && messages[0].contains("an id the kit's inspect lists"),
            "{}",
            messages[0]
        );
        assert!(messages[1].starts_with("`name` is required: expected a string") && messages[1].contains("no default"), "{}", messages[1]);
    }

    /// An engine's refusal carries its errors to the binding, and reads as text.
    #[test]
    fn a_refusal_carries_its_errors_and_reads_as_its_messages() {
        let errors = vec![ParamError {
            path: "/values/Primary channel".into(),
            message: "`values.Primary channel` names no field of table 2".into(),
            expected: "a field name".into(),
        }];
        let message = refusal(&errors);
        assert!(message.starts_with("`values.Primary channel` names no field of table 2\u{1e}"), "{message}");
        assert_eq!(parse_refusal(&message), Some(("`values.Primary channel` names no field of table 2", errors)));
        assert_eq!(parse_refusal("unknown command x"), None);
    }

    /// Every wrong parameter, each with a JSON Pointer to it, not the first alone.
    #[test]
    fn param_errors_lists_every_wrong_parameter_with_its_path() {
        let schema = json!({
            "type": { "type": "string", "enum": ["text", "number"], "required": true },
            "fields": { "type": "array", "items": { "type": "object", "properties": { "type": { "type": "string", "enum": ["text", "number"] }, "a/b": { "type": "integer" } } } },
            "name": { "type": "string", "required": true },
        });
        let params = json!({ "type": "no-such-type", "fields": [{ "type": "text" }, { "type": "email", "a/b": 1 }] });
        let errors = param_errors(&schema, params.as_object().unwrap());
        let paths: Vec<&str> = errors.iter().map(|error| error.path.as_str()).collect();
        assert_eq!(paths, ["/fields/1/type", "/name", "/type"]);
        assert_eq!(errors[2].expected, "one of \"text\", \"number\", for example \"text\"");
        assert!(errors[2].message.starts_with("`type`: expected one of"), "{}", errors[2].message);
        assert!(errors[0].message.starts_with("`fields[1].type`: expected one of"), "{}", errors[0].message);
        assert!(errors[1].message.starts_with("`name` is required"), "{}", errors[1].message);
        assert_eq!(check_params(&schema, params.as_object().unwrap()).unwrap_err(), errors[0].message, "check_params answers the first");
        assert_eq!(pointer_token("a/b~c"), "a~1b~0c");
        assert!(param_errors(&schema, json!({ "type": "text", "name": "x" }).as_object().unwrap()).is_empty());
    }

    #[test]
    fn keys_given_one_or_another_within_a_form_are_each_parameters() {
        // CAD: `{handles?, from?: [x,y], to?: [x,y] | delta: [dx,dy]}`, `{h1, expr? | value?}`,
        // `{handle | handles, option}`; values given one or another stay one key.
        let keys = |text: &str| from_kit_params(text).unwrap().schema.as_object().unwrap().keys().cloned().collect::<Vec<_>>();
        let mut moved = keys("{handles?, from?: [x,y], to?: [x,y] | delta: [dx,dy]}");
        moved.sort();
        assert_eq!(moved, ["delta", "from", "handles", "to"]);
        let mut constraint = keys("{h1, p1?, expr? | value?, name?}");
        constraint.sort();
        assert_eq!(constraint, ["expr", "h1", "name", "p1", "value"]);
        let mut edited = keys("{handle | handles, option: close|open|join}");
        edited.sort();
        assert_eq!(edited, ["handle", "handles", "option"]);
        let mut lengthened = keys("{handle, delta? | deltaAngle? (deg) | percent? | to?: [x,y]}");
        lengthened.sort();
        assert_eq!(lengthened, ["delta", "deltaAngle", "handle", "percent", "to"]);
        assert_eq!(keys("{mode?: new|append|exclude}"), ["mode"]);
        assert_eq!(keys("{kind?: colorDependent|named (new)}"), ["kind"]);
        assert_eq!(keys("{scale?: paper units per model unit | \"1:50\"}"), ["scale"]);
    }

    #[test]
    fn an_unknown_key_is_refused_with_the_name_it_resembles() {
        let schema = json!({ "object": { "type": "string" }, "kind": { "type": "string" } });
        let error = refuse_unknown("modifier.add", &schema, &json!({ "objects": "Cube", "kind": "bevel" })).unwrap_err();
        assert!(error.contains("`objects`"), "{error}");
        assert!(error.contains("did you mean `object`"), "{error}");
        assert!(error.contains("`kind`"), "{error}");
        assert_eq!(refuse_unknown("modifier.add", &schema, &json!({ "object": "Cube" })), Ok(()));
        assert_eq!(refuse_unknown("modifier.add", &schema, &json!({})), Ok(()));
        assert_eq!(refuse_unknown("modifier.add", &schema, &Value::Null), Ok(()));
    }

    #[test]
    fn a_command_without_parameters_says_so() {
        let error = refuse_unknown("edit.undo", &json!({}), &json!({ "zzUnknownParam": 1 })).unwrap_err();
        assert!(error.contains("`zzUnknownParam`") && error.contains("takes no parameters"), "{error}");
        assert!(!error.contains("did you mean"), "{error}");
    }

    #[test]
    fn null_is_none_for_a_key_that_is_not_required() {
        // Kits clear a value with null (`layer.setParent {parent: null}`, a check's own fix); a
        // required key still needs a value.
        let schema = json!({
            "parent": { "oneOf": [{ "type": "integer" }, { "type": "string" }], "description": "layer|null" },
            "name": { "type": "string", "required": true },
            "style": { "type": "object", "properties": { "font": { "type": "string" } } },
        });
        let params = |value: Value| value.as_object().cloned().unwrap_or_default();
        check_params(&schema, &params(json!({ "parent": null, "name": "Band" }))).unwrap();
        check_params(&schema, &params(json!({ "name": "Band", "style": { "font": null } }))).unwrap();
        assert!(check_params(&schema, &params(json!({ "name": null }))).is_err(), "a required key needs a value");
        assert!(check_params(&schema, &params(json!({ "parent": true, "name": "Band" }))).is_err(), "other wrong types are still refused");
    }

    #[test]
    fn params_are_checked_against_the_schema() {
        let schema = json!({
            "name": { "type": "string", "required": true },
            "count": { "type": "integer", "examples": [3] },
            "mode": { "type": "string", "enum": ["fast", "exact"] },
            "to": { "type": "file", "access": "create", "accept": ["png"] },
            "rows": { "type": "array", "items": { "type": "integer" } },
            "at": { "type": "object", "additionalProperties": false, "properties": { "row": { "type": "integer", "required": true } } },
            "either": { "oneOf": [{ "type": "string" }, { "type": "boolean" }] },
            "anything": { "type": "json" },
        });
        let check = |params: Value| check_params(&schema, params.as_object().unwrap());
        check(json!({ "name": "a", "count": 2.0, "mode": "fast", "to": "out/a.PNG", "rows": [1, 2], "at": { "row": 1 }, "either": true, "anything": [{}] }))
            .unwrap();
        check(json!({ "name": "a", "extra": "the top level is the kit's" })).unwrap();
        let refused = |params: Value| check(params).unwrap_err();
        assert!(refused(json!({})).starts_with("`name` is required: expected a string"));
        let wrong = refused(json!({ "name": "a", "count": "3" }));
        assert!(wrong.contains("`count`: expected a whole number, for example 3, got a string \"3\""), "{wrong}");
        assert!(refused(json!({ "name": "a", "count": 1.5 })).contains("`count`"));
        assert!(refused(json!({ "name": "a", "mode": "slow" })).contains("one of \"fast\", \"exact\""));
        assert!(refused(json!({ "name": "a", "to": "a.jpg" })).contains("a workspace path ending in .png"));
        assert!(refused(json!({ "name": "a", "rows": [1, "2"] })).contains("`rows[1]`"));
        assert!(refused(json!({ "name": "a", "at": {} })).contains("`at.row` is required"));
        assert!(refused(json!({ "name": "a", "at": { "row": 1, "col": 2 } })).contains("`at.col` is not a field of `at`: its fields are row"));
        assert!(refused(json!({ "name": "a", "either": 3 })).contains("a string or a boolean"));
        assert!(refused(json!({ "name": null })).contains("got null"));
    }

    #[test]
    fn output_schemas_are_one_value_node() {
        let result = serde_json::json!({
            "type": "object",
            "additionalProperties": true,
            "properties": { "id": { "type": "integer", "required": true }, "title": { "type": "string" } },
        });
        validate_output(&result).unwrap();
        validate_output(&serde_json::json!({ "type": "null" })).unwrap();
        assert!(validate_output(&serde_json::json!({ "type": "integer", "required": true })).is_err(), "the output itself is not a property");
        assert!(validate_output(&serde_json::json!({ "id": { "type": "integer" } })).is_err(), "not a parameter object");
    }

    #[test]
    fn file_parameters_come_from_the_type_not_the_name() {
        let schema = serde_json::json!({
            "target": { "type": "string", "description": "A field to import into." },
            "path": { "type": "string" },
            "to": { "type": "file", "access": "create", "accept": ["png"] },
            "files": { "type": "array", "items": { "type": "file", "access": "read", "accept": ["pdf"] } },
            "source": { "oneOf": [{ "type": "string" }, { "type": "file", "access": "read", "kind": "folder" }] },
        });
        validate(&schema).unwrap();
        assert_eq!(file_params(&schema), ["files", "source", "to"]);
        assert!(names_file(&serde_json::json!({ "type": "string", "x-khp-file": { "access": "read" } })));
        for bad in [
            serde_json::json!({ "f": { "type": "file" } }),
            serde_json::json!({ "f": { "type": "file", "access": "delete" } }),
            serde_json::json!({ "f": { "type": "file", "access": "read", "accept": [".png"] } }),
            serde_json::json!({ "f": { "type": "file", "access": "write", "kind": "folder" } }),
            serde_json::json!({ "f": { "type": "string", "access": "read" } }),
        ] {
            assert!(validate(&bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn a_bare_id_is_a_number_or_a_string() {
        let schema = convert("{ids?, id?, w?}");
        let params = |v: Value| v.as_object().cloned().unwrap();
        assert!(check_params(&schema, &params(json!({ "ids": [3, "01a18b74-a39f-7435-981d-7d1b91814a23"], "id": "s-12" }))).is_ok());
        assert!(check_params(&schema, &params(json!({ "ids": [true] }))).is_err());
        assert!(check_params(&schema, &params(json!({ "w": "wide" }))).is_err(), "other bare keys keep their type");
    }

    fn convert(text: &str) -> Value {
        let converted = from_kit_params(text).unwrap();
        validate(&converted.schema).unwrap_or_else(|error| panic!("{error} in {}", converted.schema));
        converted.schema
    }

    #[test]
    fn keys_with_notes_and_no_type_stay_in_the_schema() {
        // The plain-key dialect writes notes for people right after a key with no type.
        let schema = convert("{ids?, direction? (horizontal|vertical|grid), x, y (its top-left, in the parent), author? (a name, or false for none)}");
        assert_eq!(schema["direction"], json!({ "type": "string", "enum": ["horizontal", "vertical", "grid"] }));
        assert_eq!(schema["y"], json!({ "type": "number", "description": "its top-left, in the parent" }));
        assert_eq!(schema["author"], json!({ "type": "json", "description": "a name, or false for none" }));
        assert!(schema["ids"].is_object() && schema["x"].is_object());
        let converted = from_kit_params("{direction? (horizontal|vertical|grid), author? (a name)}").unwrap();
        assert_eq!((converted.properties, converted.precise), (2, 1), "choices are typed; free notes are not");
    }

    #[test]
    fn quoted_keys_take_every_form_plain_keys_do() {
        // Quoted keys may put the optional marker outside the quotes: `"after"?: n`.
        // the quoted key with `?` was dropped from the schema.
        let schema = convert(r#"{"text":string, "after"?: n, "before"? : n, "style"?, "align"? (left|center|right), "note" (for people)}"#);
        let plain = convert("{after?: n}");
        assert_eq!(schema["after"], plain["after"], "a quoted key converts as the plain one does");
        assert_eq!(schema["before"], plain["after"]);
        assert!(schema["style"].is_object(), "a bare quoted key stays, typed from its name");
        assert_eq!(schema["align"], json!({ "type": "string", "enum": ["left", "center", "right"] }));
        assert_eq!(schema["note"]["description"], "for people");
        assert_eq!(schema.as_object().map(Map::len), Some(6));
        // Alternatives of quoted keys still split.
        let alternatives = convert(r#"{"time":ticks|"frame":i64}"#);
        assert!(alternatives["time"].is_object() && alternatives["frame"].is_object());
    }

    #[test]
    fn a_zero_to_one_range_is_a_fraction() {
        // `0..1` is how kits write opacity, flow, a point along a curve or a keyframe's influence:
        // a whole number from 0 to 1 would allow only the two ends.
        let schema = convert(r#"{"opacity":0..1,"t":0..1=0.5,"steps":0..100,"gain":0.5..2}"#);
        assert_eq!(schema["opacity"], json!({ "type": "number", "description": "0 to 1" }));
        assert_eq!(schema["t"]["type"], "number");
        assert_eq!(schema["steps"], json!({ "type": "integer", "description": "0 to 100" }));
        assert_eq!(schema["gain"]["type"], "number");
    }

    #[test]
    fn types_required_optional_defaults_and_enums() {
        let schema = convert(
            r##"{"name":str?,"layer":id,"opacity":0..100=100,"mode":"normal|multiply|screen"="normal","antiAlias":bool=true,"color":"#rrggbb"=foreground}"##,
        );
        assert_eq!(schema["name"], json!({ "type": "string" }));
        assert_eq!(schema["layer"], json!({ "type": "integer", "description": "an id" }));
        assert!(schema.as_object().unwrap().values().all(|node| node.get("required").is_none()), "converted schemas require nothing");
        assert_eq!(schema["opacity"], json!({ "type": "integer", "description": "0 to 100", "default": 100 }));
        assert_eq!(schema["mode"], json!({ "type": "string", "enum": ["normal", "multiply", "screen"], "default": "normal" }));
        assert_eq!(schema["antiAlias"], json!({ "type": "boolean", "default": true }));
        assert_eq!(schema["color"]["type"], "string");
        assert!(schema["color"].get("enum").is_none(), "a placeholder is not a choice");
        assert_eq!(schema["color"]["description"], "like #rrggbb; default foreground");
    }

    #[test]
    fn arrays_objects_notes_and_open_enums() {
        let schema =
            convert(r##"{"items":[id]?,"rect":[x,y,w,h] (rect/ellipse),"points":[[x,y],…],"blend":"normal|multiply|…"?,"brush":{…}?,"style":{"size":px}}"##);
        assert_eq!(schema["items"], json!({ "type": "array", "items": { "type": "integer", "description": "an id" } }));
        assert_eq!(schema["rect"]["items"], json!({ "type": "number" }));
        assert!(schema["rect"].get("required").is_none(), "a noted property is conditional, so optional");
        assert!(schema["rect"]["description"].as_str().unwrap().contains("rect/ellipse"));
        assert_eq!(schema["points"]["type"], "array");
        assert_eq!(schema["blend"]["type"], "string");
        assert!(schema["blend"].get("enum").is_none(), "an open list is not an enum");
        assert_eq!(schema["brush"]["type"], "object");
        assert_eq!(schema["style"]["properties"]["size"]["type"], "number");
    }

    #[test]
    fn alternative_keys_become_separate_properties() {
        let schema = convert(r##"{"item":id,"time":ticks|"frame":i64|"seconds":f64,"insert":bool}"##);
        assert_eq!(schema["item"]["type"], "integer");
        for key in ["time", "frame", "seconds"] {
            assert!(schema[key].get("required").is_none(), "{key} is one of several");
        }
        assert_eq!(schema["frame"]["type"], "integer");
        assert_eq!(schema["seconds"]["type"], "number");
    }

    #[test]
    fn alternative_objects_declare_every_form_s_keys() {
        // `markers.filterColors`: either form is a valid call, so refuse_unknown must not refuse
        // the second one's keys.
        let schema = convert(r##"{"hidden":[label]}|{"color":label,"visible":bool?}"##);
        for key in ["hidden", "color", "visible"] {
            assert!(schema.get(key).is_some(), "{key} is a parameter of one form: {schema}");
            assert!(schema[key].get("required").is_none(), "{key} belongs to one form only");
        }
        assert_eq!(schema["visible"]["type"], "boolean");
        assert_eq!(refuse_unknown("markers.filterColors", &schema, &json!({ "color": "red", "visible": false })), Ok(()));
        assert!(refuse_unknown("markers.filterColors", &schema, &json!({ "colour": "red" })).is_err());
    }

    #[test]
    fn unclear_types_fall_back_to_json_with_the_text() {
        let converted = from_kit_params(r##"{"target":"pixels"|"mask"|{"channel":i}=Channels panel target,"what":somethingodd}"##).unwrap();
        validate(&converted.schema).unwrap();
        assert_eq!(converted.properties, 2);
        assert!(converted.precise < 2);
        assert_eq!(converted.schema["what"]["type"], "json");
        assert!(converted.schema["what"]["description"].as_str().unwrap().contains("somethingodd"));
    }

    #[test]
    fn plain_keys_dialect() {
        let schema = convert(r##"{x, y, width, height, radius?: pt, rotation?: deg (about centre)} → {id}"##);
        for key in ["x", "y", "width", "height"] {
            assert_eq!(schema[key]["type"], "number", "{key}");
        }
        assert_eq!(schema["radius"]["type"], "number");
        assert_eq!(schema["rotation"]["description"], "degrees; about centre");
        let schema = convert(r##"{ids?, mode: "cmyk"|"rgb", convert?: true, name?|title?: document name, depth?, what: diskCache|media}"##);
        assert_eq!(schema["ids"]["type"], "array");
        assert_eq!(schema["mode"], json!({ "type": "string", "enum": ["cmyk", "rgb"] }));
        assert_eq!(schema["name"]["type"], schema["title"]["type"], "alternative names share a type");
        assert_eq!(schema["depth"]["type"], "json", "a bare key whose name says nothing");
        assert!(schema.get("diskCache").is_none(), "choices are not keys");
        assert_eq!(schema["what"], json!({ "type": "string", "enum": ["diskCache", "media"] }), "bare-word choices");
        // Prose after the parameters is ignored.
        assert_eq!(convert("{ids?} — delete selected items")["ids"]["type"], "array");
        let schema = convert(r##"{convert?: true, steps?: 1, alpha?: byte, dir?: -1|0|1, copy?, includeImages?, newName, cx, target?}"##);
        assert_eq!(schema["convert"], json!({ "type": "boolean", "default": true }));
        assert_eq!(schema["steps"], json!({ "type": "integer", "default": 1 }));
        assert_eq!(schema["alpha"]["type"], "integer");
        assert_eq!(schema["dir"], json!({ "type": "integer", "enum": [-1, 0, 1] }));
        assert_eq!(schema["copy"]["type"], "boolean");
        assert_eq!(schema["includeImages"]["type"], "boolean");
        assert_eq!(schema["newName"]["type"], "string");
        assert_eq!(schema["cx"]["type"], "number");
        assert_eq!(schema["target"]["type"], "json", "an ambiguous name stays untyped");
    }

    #[test]
    fn prose_and_no_parameters() {
        assert_eq!(from_kit_params("{}").unwrap().properties, 0);
        assert_eq!(from_kit_params("").unwrap().properties, 0);
        assert!(from_kit_params("the active layer").is_err());
        assert!(from_kit_params(r##"{"a":[1,2"##).is_err());
        // A result description after the parameters is ignored.
        assert_eq!(convert(r##"{} → {groups:[{name}],count}"##), json!({}));
    }

    #[test]
    fn validate_rejects_malformed_schemas() {
        assert!(validate(&json!({ "a": { "type": "object" } })).is_err(), "objects state additionalProperties");
        assert!(validate(&json!({ "a": { "type": "string", "required": false } })).is_err());
        assert!(validate(&json!({ "a": { "type": "integer", "enum": ["x"] } })).is_err());
        assert!(validate(&json!({ "a": { "type": "date" } })).is_err());
        assert!(validate(&json!({ "a": { "oneOf": [{ "type": "string" }] } })).is_err());
        validate(&json!({ "a": { "oneOf": [{ "type": "string" }, { "type": "integer" }], "required": true } })).unwrap();
    }

    #[test]
    fn command_numeric_limits_are_validated_and_preserved() {
        let schema = json!({"opacity":{"type":"number","minimum":0,"maximum":1,"multipleOf":0.1}});
        validate(&schema).unwrap();
        for node in [json!({"type":"number","minimum":2,"maximum":1}), json!({"type":"number","multipleOf":0}), json!({"type":"string","minimum":0})] {
            assert!(validate(&json!({"value":node})).is_err());
        }
    }
}
