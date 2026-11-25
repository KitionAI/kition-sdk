//! The content encoding (data model, "The content encoding"): every rule is a test here, and the
//! fixtures under `fixtures/content/` are the bytes it writes. Fixtures are written once by hand
//! from the rules and never regenerated to make a test pass.

use std::sync::Arc;

use kition_kdm::content::{self, Content, ContentVersion};
use kition_kdm::{DocId, KdmError, Schema};
use serde_json::{Map, Value, json};

fn schema() -> Arc<Schema> {
    Arc::new(Schema::parse(include_str!("fixtures/content/schema.json")).expect("content schema parses"))
}

/// The snapshot fixture's version.
fn snapshot_version() -> ContentVersion {
    let lineage = uuid::Uuid::parse_str("0193a5c4-0000-7000-8000-0000000000ff").expect("a UUID");
    ContentVersion { lineage: *lineage.as_bytes(), seq: 42, author_schema_version: None }
}

/// Each fixture: its name, its canonical state, its content bytes, and its version (snapshots).
fn fixtures() -> Vec<(&'static str, &'static str, &'static [u8], Option<ContentVersion>)> {
    vec![
        ("empty", include_str!("fixtures/content/empty.state.json"), include_bytes!("fixtures/content/empty.content.json"), None),
        ("board", include_str!("fixtures/content/board.state.json"), include_bytes!("fixtures/content/board.content.json"), None),
        ("numbers", include_str!("fixtures/content/numbers.state.json"), include_bytes!("fixtures/content/numbers.content.json"), None),
        ("keys", include_str!("fixtures/content/keys.state.json"), include_bytes!("fixtures/content/keys.content.json"), None),
        ("snapshot", include_str!("fixtures/content/snapshot.state.json"), include_bytes!("fixtures/content/snapshot.content.json"), Some(snapshot_version())),
    ]
}

/// A state's JSON in canonical form: keys sorted, whole doubles within ±2^53 as integers.
fn canonical(value: Value) -> Value {
    match value {
        Value::Number(number) if !number.is_i64() && !number.is_u64() => match number.as_f64() {
            Some(float) if float.fract() == 0.0 && float.abs() <= 9_007_199_254_740_992.0 => Value::from(float as i64),
            _ => Value::Number(number),
        },
        Value::Array(items) => Value::Array(items.into_iter().map(canonical).collect()),
        Value::Object(fields) => Value::Object(fields.into_iter().map(|(key, value)| (key, canonical(value))).collect()),
        other => other,
    }
}

fn text(bytes: &[u8]) -> String {
    String::from_utf8(bytes.to_vec()).expect("content is UTF-8")
}

#[test]
fn every_fixture_state_encodes_to_its_bytes_exactly() {
    let schema = schema();
    for (name, state, bytes, version) in fixtures() {
        let state: Value = serde_json::from_str(state).expect("the state is JSON");
        let content = content::from_state(&state, &schema, version).unwrap_or_else(|error| panic!("{name}: {error}"));
        let encoded = content::encode(&content).unwrap_or_else(|error| panic!("{name}: {error}"));
        assert_eq!(text(&encoded), text(bytes), "{name}: the encoding differs from its fixture");
    }
}

#[test]
fn every_fixture_decodes_to_its_state_and_encodes_back_to_the_same_bytes() {
    let schema = schema();
    for (name, state, bytes, version) in fixtures() {
        let decoded = content::decode(bytes).unwrap_or_else(|error| panic!("{name}: {error}"));
        assert_eq!(decoded.version, version, "{name}: the version");
        let state: Value = serde_json::from_str(state).expect("the state is JSON");
        assert_eq!(content::to_state(&decoded, &schema), canonical(state), "{name}: the state read back");
        assert_eq!(text(&content::encode(&decoded).expect("encodes")), text(bytes), "{name}: encoded again");
    }
}

#[test]
fn a_file_holds_the_header_then_one_object_per_line_then_the_closing_line() {
    let bytes = text(include_bytes!("fixtures/content/board.content.json"));
    let lines: Vec<&str> = bytes.split('\n').collect();
    assert_eq!(lines.first().copied(), Some(r#"{"kdm":1,"kit":"kit.content","docId":"0193a5c4-0000-7000-8000-000000000001","schemaVersion":2,"objects":{"#));
    // Four objects, the closing line, and the empty string after the last line's `\n`.
    assert_eq!(lines.len(), 7);
    assert_eq!(lines[5], "}}");
    assert_eq!(lines[6], "");
    for line in &lines[1..4] {
        assert!(line.ends_with("},"), "{line}");
    }
    assert!(lines[4].ends_with('}') && !lines[4].ends_with("},"));
    // No whitespace outside strings: the only spaces are inside the texts `Ship `, `Page 1`, `Page 3`.
    let outside: String = bytes.split('"').step_by(2).collect();
    assert!(!outside.contains(' ') && !outside.contains('\t') && !outside.contains('\r'), "{outside}");
}

#[test]
fn an_empty_document_is_its_header_and_the_closing_line() {
    let bytes = text(include_bytes!("fixtures/content/empty.content.json"));
    assert_eq!(bytes, "{\"kdm\":1,\"kit\":\"kit.content\",\"docId\":\"0193a5c4-0000-7000-8000-000000000001\",\"schemaVersion\":1,\"objects\":{\n}}\n");
}

#[test]
fn a_snapshot_puts_its_version_after_the_doc_id_and_a_file_has_none() {
    let snapshot = text(include_bytes!("fixtures/content/snapshot.content.json"));
    assert!(snapshot.starts_with(
        r#"{"kdm":1,"kit":"kit.content","docId":"0193a5c4-0000-7000-8000-000000000003","version":{"lineage":"0193a5c4-0000-7000-8000-0000000000ff","seq":42},"schemaVersion":2,"objects":{"#
    ));
    let mut content = content::decode(snapshot.as_bytes()).expect("decodes");
    content.version = None;
    let file = text(&content::encode(&content).expect("encodes"));
    assert!(!file.contains("version") && !file.contains("lineage"), "{file}");
    assert!(file.starts_with(r#"{"kdm":1,"kit":"kit.content","docId":"0193a5c4-0000-7000-8000-000000000003","schemaVersion":2,"objects":{"#));
}

#[test]
fn keys_and_ids_sort_by_their_utf8_bytes_not_by_utf16() {
    // U+FF5A is one UTF-16 unit above U+D83D (the first unit of U+1F600), so UTF-16 order puts
    // the emoji first; UTF-8 bytes (EF.. before F0..) put it last.
    let bytes = text(include_bytes!("fixtures/content/keys.content.json"));
    let fullwidth = bytes.find("\"\u{ff5a}\":5").expect("the fullwidth key");
    let emoji = bytes.find("\"\u{1f600}\":6").expect("the emoji key");
    assert!(fullwidth < emoji);
    let (upper, underscore, lower) = (bytes.find("\n\"Z9\"").unwrap(), bytes.find("\n\"_m\"").unwrap(), bytes.find("\n\"a0\"").unwrap());
    assert!(upper < underscore && underscore < lower);
    // `$type` (0x24) comes first in every object of these fixtures.
    for line in bytes.lines().skip(1).filter(|line| line.starts_with('"')) {
        assert!(line.contains(":{\"$type\":"), "{line}");
    }
}

#[test]
fn characters_outside_the_bmp_and_non_ascii_are_written_as_themselves() {
    let bytes = text(include_bytes!("fixtures/content/keys.content.json"));
    assert!(bytes.contains("\u{1f600}") && bytes.contains("\u{1d11e}") && bytes.contains("\u{e9}"));
    assert!(!bytes.contains("\\ud83d") && !bytes.contains("\\u00e9"));
    // Controls are escaped: `\n`, `\t` in their short form, U+0001 as `\u0001`.
    assert!(bytes.contains("line1\\nline2") && bytes.contains("Tab\\there") && bytes.contains("\\u0001"));
}

#[test]
fn null_fields_and_empty_containers_are_left_out_and_empty_registers_are_kept() {
    let bytes = text(include_bytes!("fixtures/content/board.content.json"));
    // The second page: no body, no null register; its empty name is a register, so it is kept.
    assert!(bytes.contains("\"0193a5c4-0000-7000-8000-0000000000b2\":{\"$type\":\"Page\",\"name\":\"\"},\n"));
    // The board's empty notes (a text) are left out; the third page's empty json `{}` and its
    // integer 0 are written.
    assert!(!bytes.contains("notes"));
    assert!(bytes.contains("\"box\":{},\"count\":0,\"done\":true"));
    assert!(!bytes.contains("null"));
    // `encode` itself leaves out a field holding null.
    let mut content = content::decode(bytes.as_bytes()).expect("decodes");
    let page = content.objects.get_mut("0193a5c4-0000-7000-8000-0000000000b2").expect("the page");
    page.insert("kind".into(), Value::Null);
    assert_eq!(text(&content::encode(&content).expect("encodes")), bytes);
}

#[test]
fn whole_numbers_are_integers_and_others_the_shortest_round_trip_form() {
    let bytes = text(include_bytes!("fixtures/content/numbers.content.json"));
    assert!(bytes.contains(
        "\"box\":[0,0,5,1.5,0.1,0.30000000000000004,1e21,1e16,9007199254740992,-9007199254740992,9007199254740992,1.5e-7,0.0001,1e-7,123456789.125,5e-324,1.7976931348623157e308,-2.5e-10]"
    ));
    // `1E2` in a number field is 100.
    assert!(bytes.contains("\"scale\":100}"));
    // Every number reads back as the same double, so encoding again gives the same bytes.
    let decoded = content::decode(bytes.as_bytes()).expect("decodes");
    assert_eq!(text(&content::encode(&decoded).expect("encodes")), bytes);
}

#[test]
fn integers_beyond_two_to_the_53_are_refused_everywhere() {
    let schema = schema();
    let big = "9007199254740993";
    let file = format!(
        "{{\"kdm\":1,\"kit\":\"kit.content\",\"docId\":\"0193a5c4-0000-7000-8000-000000000001\",\"schemaVersion\":1,\"objects\":{{\n\"p\":{{\"$type\":\"Page\",\"count\":{big}}}\n}}}}\n"
    );
    assert!(matches!(content::decode(file.as_bytes()), Err(KdmError::Encoding(_))));
    let state: Value = serde_json::from_str(&format!(
        "{{\"meta\":{{\"docId\":\"0193a5c4-0000-7000-8000-000000000001\",\"kdm\":1,\"kit\":\"kit.content\",\"schemaVersion\":1}},\"objects\":{{\"p\":{{\"$type\":\"Page\",\"box\":[-{big}]}}}}}}"
    ))
    .unwrap();
    assert!(matches!(content::from_state(&state, &schema, None), Err(KdmError::Encoding(_))));
    let mut objects = std::collections::BTreeMap::new();
    objects.insert("p".to_owned(), json!({ "$type": "Page", "box": { "deep": [u64::MAX] } }).as_object().cloned().unwrap());
    let content = Content { kit: "kit.content".into(), doc_id: DocId::new(), schema_version: 1, version: None, objects };
    assert!(matches!(content::encode(&content), Err(KdmError::Encoding(_))));
}

#[test]
fn decoding_accepts_whitespace_and_refuses_what_is_not_the_encoding() {
    let pretty = r#"{
        "objects": { "p": { "name": "x", "$type": "Page" } },
        "schemaVersion": 1, "docId": "0193a5c4-0000-7000-8000-000000000001", "kit": "kit.content", "kdm": 1
    }"#;
    let decoded = content::decode(pretty.as_bytes()).expect("whitespace and key order do not matter when reading");
    assert_eq!(
        text(&content::encode(&decoded).unwrap()),
        "{\"kdm\":1,\"kit\":\"kit.content\",\"docId\":\"0193a5c4-0000-7000-8000-000000000001\",\"schemaVersion\":1,\"objects\":{\n\"p\":{\"$type\":\"Page\",\"name\":\"x\"}\n}}\n"
    );
    let header = r#""kit":"kit.content","docId":"0193a5c4-0000-7000-8000-000000000001","schemaVersion":1"#;
    assert!(matches!(content::decode(format!(r#"{{"kdm":2,{header},"objects":{{}}}}"#).as_bytes()), Err(KdmError::Schema(_))));
    assert!(matches!(content::decode(format!(r#"{{"kdm":1,{header},"objects":{{}},"extra":1}}"#).as_bytes()), Err(KdmError::Encoding(_))));
    assert!(matches!(content::decode(format!(r#"{{"kdm":1,{header},"objects":{{"p":{{"name":"x"}}}}}}"#).as_bytes()), Err(KdmError::Encoding(_))));
    assert!(matches!(content::decode(format!(r#"{{"kdm":1,{header}}}"#).as_bytes()), Err(KdmError::Encoding(_))));
    assert!(matches!(content::decode(format!(r#"{{"kdm":1,{header},"objects":{{}},"version":{{"seq":1}}}}"#).as_bytes()), Err(KdmError::Encoding(_))));
    assert!(matches!(content::decode(b"KDM\x01 not json"), Err(KdmError::Encoding(_))));
}

#[test]
fn fields_the_schema_does_not_declare_are_kept_as_they_are() {
    let schema = schema();
    let state = json!({
        "meta": { "docId": "0193a5c4-0000-7000-8000-000000000001", "kdm": 1, "kit": "kit.content", "schemaVersion": 1 },
        "objects": {
            "n": { "$type": "Note", "lines": [], "body": "from a newer kit" },
            "p": { "$type": "Page", "name": "x", "later": [] }
        }
    });
    let content = content::from_state(&state, &schema, None).expect("from state");
    assert_eq!(
        text(&content::encode(&content).unwrap()),
        "{\"kdm\":1,\"kit\":\"kit.content\",\"docId\":\"0193a5c4-0000-7000-8000-000000000001\",\"schemaVersion\":1,\"objects\":{\n\
         \"n\":{\"$type\":\"Note\",\"body\":\"from a newer kit\",\"lines\":[]},\n\
         \"p\":{\"$type\":\"Page\",\"later\":[],\"name\":\"x\"}\n}}\n"
    );
}

#[test]
fn the_same_content_encodes_to_the_same_bytes_whatever_order_it_was_built_in() {
    let mut forward = Map::new();
    let mut backward = Map::new();
    let pairs = [("b", json!(1)), ("a", json!({ "z": 1, "y": [ { "d": 1, "c": 2 } ] })), ("$type", json!("Page"))];
    for (key, value) in pairs.iter().cloned() {
        forward.insert(key.to_owned(), value);
    }
    for (key, value) in pairs.iter().rev().cloned() {
        backward.insert(key.to_owned(), value);
    }
    let doc_id = DocId::new();
    let build = |fields: Map<String, Value>| Content {
        kit: "kit.content".into(),
        doc_id,
        schema_version: 1,
        version: None,
        objects: [("p".to_owned(), fields)].into_iter().collect(),
    };
    let one = content::encode(&build(forward)).unwrap();
    assert_eq!(one, content::encode(&build(backward)).unwrap());
    assert!(text(&one).contains("\"p\":{\"$type\":\"Page\",\"a\":{\"y\":[{\"c\":2,\"d\":1}],\"z\":1},\"b\":1}"));
}
