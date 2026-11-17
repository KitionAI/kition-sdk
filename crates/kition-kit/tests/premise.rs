use kition_kit::Premise;
use serde_json::json;

#[test]
fn content_ask_preserves_an_explicit_null_region_and_rejects_an_absent_region() {
    let params = json!({"id":"board","field":"body","region":null,"before":{},"step":2,"state":{"part":"board"},"changes":{}});
    let ask: kition_kit::ContentAsk = serde_json::from_value(params.clone()).unwrap();
    assert_eq!(ask.premise.region, serde_json::Value::Null);
    assert_eq!(ask.step.step, 2);
    assert_eq!(serde_json::to_value(&ask).unwrap(), params);
    let mut absent = params;
    absent.as_object_mut().unwrap().remove("region");
    assert!(serde_json::from_value::<kition_kit::ContentAsk>(absent).is_err());
}

#[test]
fn selector_identity_is_optional_and_roundtrips_through_under() {
    let plain = Premise::on("image").fields(["channels[name=Alpha]"]).positions([] as [&str; 0]);
    let plain_json = json!({ "id": "image", "fields": ["channels[name=Alpha]"], "positions": [] });
    assert_eq!(serde_json::to_value(&plain).unwrap(), plain_json);
    assert_eq!(serde_json::from_value::<Premise>(plain_json).unwrap(), plain);
    let named = plain.identity("channels[name=Alpha]", "key");
    let under = kition_kit::Under { premises: vec![named.clone()], ..Default::default() };
    let encoded = serde_json::to_value(&under).unwrap();
    assert_eq!(encoded["premises"][0]["identities"], json!({ "channels[name=Alpha]": "key" }));
    assert_eq!(serde_json::from_value::<kition_kit::Under>(encoded).unwrap().premises, [named]);
}
