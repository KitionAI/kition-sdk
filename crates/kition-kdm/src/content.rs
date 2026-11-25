//! The content encoding (data model, "The content encoding"): the bytes a kit writes into a
//! person's file (`content.json`), and, with a version, a replica's snapshot.
//!
//! This is the one part of the KDM that cannot change after the first public release: every rule
//! below is a test (`tests/content.rs`, fixtures `tests/fixtures/content/`).
//!
//! ```text
//! {"kdm":1,"kit":"kit.board","docId":"…","schemaVersion":1,"objects":{
//! "<id>":{"$type":"Board","pages":["<id>"],"title":"Q4"},
//! "<id>":{"$type":"Page","name":"Page 1"}
//! }}
//! ```
//!
//! - UTF-8 without a byte order mark; lines end with `\n`, the last one too.
//! - The first line is the header: `kdm`, `kit`, `docId`, then (a snapshot only) `version` as
//!   `{"lineage":"<uuid>","seq":<n>}`, then `schemaVersion`, then `"objects":{`, in this order.
//! - Then one line per object, `"<id>":{…}`, a `,` after each but the last, ids in ascending
//!   order of their UTF-8 bytes; then the line `}}`. No other whitespace anywhere.
//! - Inside an object, at every depth, keys are in ascending order of their UTF-8 bytes.
//! - A field holding `null`, an empty text (`""`, or no runs), an empty list, an empty map or an
//!   empty tree is left out. A register holding `""`, `[]`, `{}`, `0` or `false` is written.
//! - A number that is whole and within ±2^53 is written as an integer (`-0` as `0`, `5.0` as `5`);
//!   an integer beyond ±2^53 is refused; any other number is written in its shortest round-trip
//!   digits, laid out by [`write_double`] (`0.1`, `123456789.125`, `1e21`, `1.5e-7`).
//! - In strings only `"`, `\` and U+0000 to U+001F are escaped (`\b`, `\f`, `\n`, `\r`, `\t`, else
//!   `\u00xx` in lower case); every other character is written as itself, outside the BMP too.
//! - A text field that declares marks is its runs, `[{"attributes":{…},"insert":"…"}]`
//!   (`attributes` left out of a run without marks); one that declares none is a string. A list
//!   is an array of ids, a map an object, a tree an array of `{"children":[…],"object":"<id>"}`
//!   in pre-order, and a blob the value `{"hash","mime","size"}`.
//! - No version (outside a snapshot), lineage, actor, origin or time.

use std::collections::BTreeMap;

use serde_json::{Map, Value};
use uuid::Uuid;

use crate::value::canonical;
use crate::{DocId, FieldKind, KDM_VERSION, KdmError, Result, Schema};

/// The largest integer magnitude the encoding writes: every reader, JavaScript's doubles
/// included, holds integers up to ±2^53 exactly.
const MAX_SAFE_INTEGER: u64 = 1 << 53;

/// The key of an object's type.
pub const TYPE_KEY: &str = "$type";

/// A snapshot's version (data model, "Versions"): the line of changes (`lineage`) and how many
/// changes of it the state holds (`seq`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct ContentVersion {
    pub lineage: [u8; 16],
    pub seq: u64,
}

/// A document's content as the encoding holds it: its header and its objects, each object with
/// `$type` and the fields it stores, in their content form.
#[derive(Clone, Debug, PartialEq)]
pub struct Content {
    pub kit: String,
    pub doc_id: DocId,
    /// The document's minimum schema version (rule M20).
    pub schema_version: u64,
    /// Only in a snapshot; never in a file's content.
    pub version: Option<ContentVersion>,
    /// Each object's id and its fields, `$type` included, sorted by id.
    pub objects: BTreeMap<String, Map<String, Value>>,
}

/// The content's bytes. Refuses ([`KdmError::Encoding`]) an object without a string `$type` and
/// an integer beyond ±2^53; leaves out fields holding `null` (empty containers are left out by
/// [`from_state`], which knows the fields' kinds).
pub fn encode(content: &Content) -> Result<Vec<u8>> {
    let mut out = String::with_capacity(128 + content.objects.len() * 96);
    out.push_str("{\"kdm\":");
    out.push_str(&KDM_VERSION.to_string());
    out.push_str(",\"kit\":");
    write_string(&mut out, &content.kit);
    out.push_str(",\"docId\":");
    write_string(&mut out, &content.doc_id.to_string());
    if let Some(version) = &content.version {
        out.push_str(",\"version\":{\"lineage\":");
        write_string(&mut out, &Uuid::from_bytes(version.lineage).to_string());
        out.push_str(",\"seq\":");
        out.push_str(&version.seq.to_string());
        out.push('}');
    }
    out.push_str(",\"schemaVersion\":");
    out.push_str(&content.schema_version.to_string());
    out.push_str(",\"objects\":{\n");
    let mut first = true;
    for (id, fields) in &content.objects {
        if !fields.get(TYPE_KEY).is_some_and(Value::is_string) {
            return Err(KdmError::Encoding(format!("object `{id}` has no `$type`")));
        }
        if !first {
            out.push_str(",\n");
        }
        first = false;
        write_string(&mut out, id);
        out.push(':');
        write_fields(&mut out, fields)?;
    }
    if !first {
        out.push('\n');
    }
    out.push_str("}}\n");
    Ok(out.into_bytes())
}

/// Reads content bytes (a file's content, or a snapshot). Whitespace between tokens is accepted,
/// so a file edited by hand reads; [`encode`] writes it back in the canonical form. Refuses
/// ([`KdmError::Encoding`]) bytes that are not this encoding, a `kdm` other than 1
/// ([`KdmError::Schema`]), and an integer beyond ±2^53.
pub fn decode(bytes: &[u8]) -> Result<Content> {
    let bad = |reason: &str| KdmError::Encoding(format!("not KDM content: {reason}"));
    let value: Value = serde_json::from_slice(bytes).map_err(|error| KdmError::Encoding(format!("not KDM content: {error}")))?;
    let Value::Object(mut top) = value else { return Err(bad("not a JSON object")) };
    if let Some(key) = top.keys().find(|key| !matches!(key.as_str(), "kdm" | "kit" | "docId" | "version" | "schemaVersion" | "objects")) {
        return Err(bad(&format!("unknown key `{key}`")));
    }
    match top.get("kdm").and_then(Value::as_u64) {
        Some(kdm) if kdm == u64::from(KDM_VERSION) => {}
        Some(kdm) => return Err(KdmError::Schema(format!("the document uses kdm {kdm}; this build reads {KDM_VERSION}"))),
        None => return Err(bad("`kdm` is missing")),
    }
    let kit = top.get("kit").and_then(Value::as_str).ok_or_else(|| bad("`kit` is missing"))?.to_owned();
    let doc_id = DocId::parse(top.get("docId").and_then(Value::as_str).ok_or_else(|| bad("`docId` is missing"))?)?;
    let schema_version = top.get("schemaVersion").and_then(Value::as_u64).ok_or_else(|| bad("`schemaVersion` is missing"))?;
    let version = match top.remove("version") {
        None => None,
        Some(Value::Object(version)) if version.len() == 2 => {
            let lineage = version.get("lineage").and_then(Value::as_str).and_then(|text| Uuid::parse_str(text).ok()).ok_or_else(|| bad("`version.lineage`"))?;
            let seq = version.get("seq").and_then(Value::as_u64).ok_or_else(|| bad("`version.seq`"))?;
            Some(ContentVersion { lineage: *lineage.as_bytes(), seq })
        }
        Some(_) => return Err(bad("`version` is not {lineage, seq}")),
    };
    let Some(Value::Object(stored)) = top.remove("objects") else { return Err(bad("`objects` is missing")) };
    let mut objects = BTreeMap::new();
    for (id, object) in stored {
        let Value::Object(fields) = object else { return Err(bad(&format!("object `{id}` is not a JSON object"))) };
        if !fields.get(TYPE_KEY).is_some_and(Value::is_string) {
            return Err(KdmError::Encoding(format!("object `{id}` has no `$type`")));
        }
        let mut kept = Map::new();
        for (name, value) in fields {
            if value.is_null() {
                continue;
            }
            check_portable(&value)?;
            kept.insert(name, canonical(value));
        }
        objects.insert(id, kept);
    }
    Ok(Content { kit, doc_id, schema_version, version, objects })
}

/// The content of a canonical state (`{meta, objects}`, as [`crate::Replica::state_json`] reads
/// it), with `version` for a snapshot. Fields that hold `null`, and fields the schema declares as
/// text, list, map or tree that are empty, are left out; fields the schema does not declare
/// (objects written under another schema version) are kept as they are.
pub fn from_state(state: &Value, schema: &Schema, version: Option<ContentVersion>) -> Result<Content> {
    let bad = |reason: &str| KdmError::Encoding(format!("not a KDM state: {reason}"));
    let meta = state.get("meta").and_then(Value::as_object).ok_or_else(|| bad("`meta` is missing"))?;
    let kit = meta.get("kit").and_then(Value::as_str).ok_or_else(|| bad("`meta.kit` is missing"))?.to_owned();
    let doc_id = DocId::parse(meta.get("docId").and_then(Value::as_str).ok_or_else(|| bad("`meta.docId` is missing"))?)?;
    let schema_version = meta.get("schemaVersion").and_then(Value::as_u64).ok_or_else(|| bad("`meta.schemaVersion` is missing"))?;
    let stored = state.get("objects").and_then(Value::as_object).ok_or_else(|| bad("`objects` is missing"))?;
    let mut objects = BTreeMap::new();
    for (id, object) in stored {
        let fields = object.as_object().ok_or_else(|| bad(&format!("object `{id}` is not a JSON object")))?;
        let ty = fields.get(TYPE_KEY).and_then(Value::as_str).ok_or_else(|| KdmError::Encoding(format!("object `{id}` has no `$type`")))?;
        let def = schema.types.get(ty);
        let mut kept = Map::new();
        for (name, value) in fields {
            let kind = def.and_then(|def| def.fields.get(name)).map(|field| field.kind);
            if value.is_null() || kind.is_some_and(|kind| kind.is_container() && is_empty_container(value)) {
                continue;
            }
            check_portable(value)?;
            kept.insert(name.clone(), canonical(value.clone()));
        }
        objects.insert(id.clone(), kept);
    }
    Ok(Content { kit, doc_id, schema_version, version, objects })
}

/// The canonical state (`{meta, objects}`) of content: each object of a type the schema declares
/// with every field of the type, a field the content leaves out read as empty (`null`, `""`, `[]`
/// for a text that declares marks, a list or a tree, `{}` for a map); an object of a type the
/// schema does not declare as its `$type` only, as [`crate::Replica::state_json`] reads them.
pub fn to_state(content: &Content, schema: &Schema) -> Value {
    let mut objects = Map::new();
    for (id, fields) in &content.objects {
        let ty = fields.get(TYPE_KEY).and_then(Value::as_str).unwrap_or_default();
        let mut out = Map::new();
        out.insert(TYPE_KEY.to_owned(), Value::String(ty.to_owned()));
        if let Some(def) = schema.types.get(ty) {
            for (name, field) in &def.fields {
                let value = fields.get(name).cloned().unwrap_or_else(|| match field.kind {
                    FieldKind::Text if field.has_marks() => Value::Array(Vec::new()),
                    FieldKind::Text => Value::String(String::new()),
                    FieldKind::List | FieldKind::Tree => Value::Array(Vec::new()),
                    FieldKind::Map => Value::Object(Map::new()),
                    _ => Value::Null,
                });
                out.insert(name.clone(), value);
            }
        }
        objects.insert(id.clone(), Value::Object(out));
    }
    let mut meta = Map::new();
    meta.insert("docId".into(), Value::String(content.doc_id.to_string()));
    meta.insert("kdm".into(), Value::from(KDM_VERSION));
    meta.insert("kit".into(), Value::String(content.kit.clone()));
    meta.insert("schemaVersion".into(), Value::from(content.schema_version));
    canonical(serde_json::json!({ "meta": Value::Object(meta), "objects": Value::Object(objects) }))
}

/// Whether a container field's value is empty: `""`, `[]` or `{}`.
fn is_empty_container(value: &Value) -> bool {
    match value {
        Value::String(text) => text.is_empty(),
        Value::Array(items) => items.is_empty(),
        Value::Object(entries) => entries.is_empty(),
        _ => false,
    }
}

/// Refuses an integer beyond ±2^53 at any depth.
fn check_portable(value: &Value) -> Result<()> {
    match value {
        Value::Number(number) => {
            let fits = match (number.as_i64(), number.as_u64()) {
                (Some(integer), _) => integer.unsigned_abs() <= MAX_SAFE_INTEGER,
                (None, Some(integer)) => integer <= MAX_SAFE_INTEGER,
                (None, None) => true,
            };
            if fits { Ok(()) } else { Err(KdmError::Encoding(format!("the integer {number} is beyond ±2^53"))) }
        }
        Value::Array(items) => items.iter().try_for_each(check_portable),
        Value::Object(entries) => entries.values().try_for_each(check_portable),
        _ => Ok(()),
    }
}

/// An object's fields, `null` ones left out, keys in byte order.
fn write_fields(out: &mut String, fields: &Map<String, Value>) -> Result<()> {
    let mut entries: Vec<(&String, &Value)> = fields.iter().filter(|(_, value)| !value.is_null()).collect();
    entries.sort_unstable_by(|a, b| a.0.as_bytes().cmp(b.0.as_bytes()));
    out.push('{');
    for (index, (key, value)) in entries.into_iter().enumerate() {
        if index > 0 {
            out.push(',');
        }
        write_string(out, key);
        out.push(':');
        write_value(out, value)?;
    }
    out.push('}');
    Ok(())
}

/// One JSON value in the canonical form: keys in byte order, numbers by [`write_number`].
fn write_value(out: &mut String, value: &Value) -> Result<()> {
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(flag) => out.push_str(if *flag { "true" } else { "false" }),
        Value::Number(number) => write_number(out, number)?,
        Value::String(text) => write_string(out, text),
        Value::Array(items) => {
            out.push('[');
            for (index, item) in items.iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                write_value(out, item)?;
            }
            out.push(']');
        }
        Value::Object(entries) => {
            let mut sorted: Vec<(&String, &Value)> = entries.iter().collect();
            sorted.sort_unstable_by(|a, b| a.0.as_bytes().cmp(b.0.as_bytes()));
            out.push('{');
            for (index, (key, item)) in sorted.into_iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                write_string(out, key);
                out.push(':');
                write_value(out, item)?;
            }
            out.push('}');
        }
    }
    Ok(())
}

/// A number: an integer when whole and within ±2^53 (`-0` is `0`); an integer beyond is refused;
/// any other double by [`write_double`].
fn write_number(out: &mut String, number: &serde_json::Number) -> Result<()> {
    if let Some(integer) = number.as_i64() {
        if integer.unsigned_abs() > MAX_SAFE_INTEGER {
            return Err(KdmError::Encoding(format!("the integer {integer} is beyond ±2^53")));
        }
        out.push_str(&integer.to_string());
        return Ok(());
    }
    if let Some(integer) = number.as_u64() {
        if integer > MAX_SAFE_INTEGER {
            return Err(KdmError::Encoding(format!("the integer {integer} is beyond ±2^53")));
        }
        out.push_str(&integer.to_string());
        return Ok(());
    }
    let Some(float) = number.as_f64().filter(|float| float.is_finite()) else {
        return Err(KdmError::Encoding(format!("the number {number} is not finite")));
    };
    if float.fract() == 0.0 && float.abs() <= MAX_SAFE_INTEGER as f64 {
        out.push_str(&(float as i64).to_string());
        return Ok(());
    }
    write_double(out, float);
    Ok(())
}

/// A double that is not a whole number within ±2^53, in its shortest round-trip digits (the
/// fewest decimal digits that read back as the same double, as Rust's float formatting finds
/// them), laid out by where its decimal point falls (`point`: the value is `0.<digits> × 10^point`):
///
/// - `0 <= point - digits` and `point <= 16`: the digits, zeros, `.0` (`9007199254740994.0`);
/// - `0 < point <= 16`: the digits with a decimal point (`123456789.125`, `0.5` is `point` 0, below);
/// - `-5 < point <= 0`: `0.`, zeros, the digits (`0.1`, `0.0001`);
/// - otherwise an exponent without `+`: `1e21`, `1e16`, `1.5e-7`, `5e-324`.
fn write_double(out: &mut String, float: f64) {
    let scientific = format!("{:e}", float.abs());
    let (mantissa, exponent) = scientific.split_once('e').unwrap_or((scientific.as_str(), "0"));
    let exponent: i64 = exponent.parse().unwrap_or(0);
    let digits: String = mantissa.chars().filter(char::is_ascii_digit).collect();
    let count = i64::try_from(digits.len()).unwrap_or(i64::MAX);
    let point = exponent + 1;
    if float < 0.0 {
        out.push('-');
    }
    if 0 <= point - count && point <= 16 {
        out.push_str(&digits);
        out.push_str(&"0".repeat(usize::try_from(point - count).unwrap_or(0)));
        out.push_str(".0");
    } else if 0 < point && point <= 16 {
        let (whole, fraction) = digits.split_at(usize::try_from(point).unwrap_or(0).min(digits.len()));
        out.push_str(whole);
        out.push('.');
        out.push_str(fraction);
    } else if -5 < point && point <= 0 {
        out.push_str("0.");
        out.push_str(&"0".repeat(usize::try_from(-point).unwrap_or(0)));
        out.push_str(&digits);
    } else {
        let (first, rest) = digits.split_at(1.min(digits.len()));
        out.push_str(first);
        if !rest.is_empty() {
            out.push('.');
            out.push_str(rest);
        }
        out.push('e');
        out.push_str(&(point - 1).to_string());
    }
}

/// A string as serde_json writes it: `"` and `\` escaped, U+0000 to U+001F escaped (`\b`, `\f`,
/// `\n`, `\r`, `\t`, else `\u00xx`), everything else as itself.
fn write_string(out: &mut String, text: &str) {
    out.push('"');
    for character in text.chars() {
        match character {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{08}' => out.push_str("\\b"),
            '\u{0C}' => out.push_str("\\f"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            control if (control as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", control as u32)),
            other => out.push(other),
        }
    }
    out.push('"');
}

#[cfg(test)]
mod tests {
    use super::*;

    fn number(value: Value) -> String {
        let mut out = String::new();
        let Value::Number(number) = value else { panic!("not a number") };
        write_number(&mut out, &number).unwrap();
        out
    }

    #[test]
    fn numbers_are_written_by_the_rules() {
        assert_eq!(number(serde_json::json!(5.0)), "5");
        assert_eq!(number(serde_json::json!(-0.0)), "0");
        assert_eq!(number(serde_json::json!(9_007_199_254_740_992.0)), "9007199254740992");
        assert_eq!(number(serde_json::json!(-9_007_199_254_740_992i64)), "-9007199254740992");
        assert_eq!(number(serde_json::json!(1e16)), "1e16");
        assert_eq!(number(serde_json::json!(1e21)), "1e21");
        assert_eq!(number(serde_json::json!(0.1)), "0.1");
        assert_eq!(number(serde_json::json!(0.1 + 0.2)), "0.30000000000000004");
        assert_eq!(number(serde_json::json!(1.5e-7)), "1.5e-7");
        assert_eq!(number(serde_json::json!(0.0001)), "0.0001");
        assert_eq!(number(serde_json::json!(-2.5)), "-2.5");
        assert_eq!(number(serde_json::json!(0.5)), "0.5");
        assert_eq!(number(serde_json::json!(123_456_789.125)), "123456789.125");
        assert_eq!(number(serde_json::json!(9_007_199_254_740_994.0)), "9007199254740994.0");
        assert_eq!(number(serde_json::json!(1e-5)), "0.00001");
        assert_eq!(number(serde_json::json!(1e-6)), "1e-6");
        assert_eq!(number(serde_json::json!(1.5e-6)), "1.5e-6");
        assert_eq!(number(serde_json::json!(1e-7)), "1e-7");
        assert_eq!(number(serde_json::json!(5e-324)), "5e-324");
        assert_eq!(number(serde_json::json!(-2.5e-10)), "-2.5e-10");
        assert_eq!(number(serde_json::json!(1.7976931348623157e308)), "1.7976931348623157e308");
        let mut out = String::new();
        let Value::Number(big) = serde_json::json!(9_007_199_254_740_993u64) else { unreachable!() };
        assert!(write_number(&mut out, &big).is_err());
    }

    #[test]
    fn strings_escape_quotes_backslashes_and_controls_only() {
        let mut out = String::new();
        write_string(&mut out, "a\"b\\c\n\t\u{1}\u{1f}\u{7f}/\u{2028}\u{e9}\u{1f600}");
        assert_eq!(out, "\"a\\\"b\\\\c\\n\\t\\u0001\\u001f\u{7f}/\u{2028}\u{e9}\u{1f600}\"");
        // serde_json writes the same.
        assert_eq!(out, serde_json::to_string("a\"b\\c\n\t\u{1}\u{1f}\u{7f}/\u{2028}\u{e9}\u{1f600}").unwrap());
    }
}
