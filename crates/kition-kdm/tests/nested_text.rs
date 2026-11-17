use std::sync::Arc;

use kition_kdm::batch::{self, ReplicaTarget};
use kition_kdm::{ActorId, DocId, ObjectId, Replica, Schema};
use serde_json::{Value, json};

fn document() -> Replica {
    let fixture: Value = serde_json::from_str(include_str!("../../../cases/regressions/issue-29-nested-text/input/model.json")).unwrap();
    let schema = Arc::new(Schema::parse(&fixture["schema"].to_string()).unwrap());
    let mut replica = Replica::create(schema, DocId::new(), ActorId::random()).unwrap();
    batch::run(&mut ReplicaTarget(&mut replica), &fixture["setup"]).unwrap();
    replica
}

#[test]
fn nested_text_operations_follow_owned_fields_and_unicode_indexes() {
    for (field, id) in [("body.paragraphs.0.text", "p"), ("body.captions.main.text", "caption")] {
        for (op, expected) in [
            (json!({"op":"text.insert","index":2,"text":"文"}), "A🙂文éZ"),
            (json!({"op":"text.delete","index":1,"count":3}), "AZ"),
            (json!({"op":"text.set","text":"New🙂"}), "New🙂"),
        ] {
            let mut replica = document();
            let mut edit = op;
            edit["target"] = json!("shape");
            edit["field"] = json!(field);
            batch::run(&mut ReplicaTarget(&mut replica), &json!({"ops":[edit]})).unwrap();
            assert_eq!(replica.text(&ObjectId::from_string(id), "text").unwrap(), expected, "{field}");
        }
    }
}

#[test]
fn nested_text_operations_enforce_boundaries_atomically() {
    for field in ["linked.paragraphs.0.text", "body.paragraphs.1.text", "body.paragraphs.0.protected", "body.data.text", "body.paragraphs.99.text"] {
        for op in ["text.insert", "text.delete", "text.set"] {
            let mut replica = document();
            let before = replica.state_hash().unwrap();
            let error = batch::run(
                &mut ReplicaTarget(&mut replica),
                &json!({"ops":[
                    {"op":"text.set","target":"p","field":"text","text":"Temporary"},
                    {"op":op,"target":"shape","field":field,"text":"New","index":0,"count":1}
                ]}),
            )
            .unwrap_err();
            assert_eq!(error.index, Some(1), "{op}/{field}: {error}");
            assert_eq!(error.code.as_str(), if field.ends_with("protected") { "read-only" } else { "invalid-op" }, "{op}/{field}: {error}");
            assert_eq!(replica.state_hash().unwrap(), before);
        }
    }
}
