//! Open tokens against the shared vectors (`vectors.json`, which `@kition/sync`'s tests read too)
//! and the signer's own refusals.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use ed25519_dalek::SigningKey;
use kition_open_token::{Claims, Error, HostKey, HostKeys, Perms, Role, TYPE, Watermark, decode, doc_key, role_of, sign};
use serde_json::Value;

fn vectors() -> Value {
    serde_json::from_str(include_str!("vectors.json")).unwrap()
}

fn parse_keys(keys: &Value) -> Result<HostKeys, Error> {
    let keys = keys.as_array().unwrap();
    HostKeys::new(keys.iter().map(|key| {
        HostKey::parse(key["kid"].as_str().unwrap(), key["publicKey"].as_str().unwrap(), key["tenant"].as_str().unwrap(), key["iss"].as_str().unwrap()).unwrap()
    }))
}

fn key_set(vectors: &Value, name: &str) -> HostKeys {
    parse_keys(&vectors["keySets"][name]).unwrap()
}

fn error_of(code: &str) -> Error {
    [
        Error::Malformed,
        Error::Version,
        Error::UnknownKey,
        Error::Signature,
        Error::Issuer,
        Error::Audience,
        Error::DuplicateKey,
        Error::Claims,
        Error::Expired,
        Error::NotYetValid,
    ]
    .into_iter()
    .find(|error| error.code() == code)
    .unwrap()
}

#[test]
fn verifies_the_shared_vectors() {
    let vectors = vectors();
    for case in vectors["cases"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let keys = key_set(&vectors, case["keys"].as_str().unwrap());
        let answer = keys.verify(case["token"].as_str().unwrap(), case["audience"].as_str().unwrap(), case["now"].as_u64().unwrap());
        if let Some(code) = case["error"].as_str() {
            assert_eq!(answer.unwrap_err(), error_of(code), "{name}");
            continue;
        }
        let claims = answer.unwrap_or_else(|error| panic!("{name}: {error}"));
        let ok = &case["ok"];
        assert_eq!(claims.sub, ok["sub"].as_str().unwrap(), "{name}");
        assert_eq!(claims.name, ok["name"].as_str().unwrap(), "{name}");
        assert_eq!(claims.tenant, ok["tenant"].as_str().unwrap(), "{name}");
        assert_eq!(claims.iss, ok["iss"].as_str().unwrap(), "{name}");
        assert_eq!(claims.aud, ok["aud"].as_str().unwrap(), "{name}");
        assert_eq!(claims.principal_id(), ok["principal"].as_str().unwrap(), "{name}");
        assert_eq!(claims.file, ok["file"].as_str().unwrap(), "{name}");
        assert_eq!(claims.version, ok["version"].as_str().unwrap(), "{name}");
        assert_eq!(claims.doc_key, ok["docKey"].as_str().unwrap(), "{name}");
        assert_eq!(claims.role().as_str(), ok["role"].as_str().unwrap(), "{name}");
        assert_eq!(serde_json::to_value(claims.perms).unwrap(), ok["perms"], "{name}");
        assert_eq!(serde_json::to_value(&claims.watermark).unwrap(), ok["watermark"], "{name}");
        assert_eq!(claims.exp, ok["exp"].as_u64().unwrap(), "{name}");
    }
}

#[test]
fn refuses_key_sets_with_two_keys_of_one_tenant_and_kid() {
    for entry in vectors()["keySetErrors"].as_array().unwrap() {
        assert_eq!(parse_keys(&entry["keys"]).unwrap_err(), error_of(entry["error"].as_str().unwrap()), "{}", entry["name"]);
    }
}

#[test]
fn derives_the_shared_doc_keys() {
    for entry in vectors()["docKeys"].as_array().unwrap() {
        assert_eq!(doc_key(entry["file"].as_str().unwrap(), entry["generation"].as_u64().unwrap()), entry["docKey"].as_str().unwrap());
    }
    assert_ne!(doc_key("res:a", 1), doc_key("res:a", 2), "a new generation is a new room");
    assert_ne!(doc_key("res:a", 1), doc_key("res:b", 1), "a copy is a new room");
}

fn claims() -> Claims {
    Claims {
        v: 1,
        typ: TYPE.into(),
        kid: String::new(),
        iss: "one.test".into(),
        aud: "srv".into(),
        tenant: "example-corp".into(),
        sub: "user-1".into(),
        name: "Ann".into(),
        file: "res:1".into(),
        version: "r1".into(),
        doc_key: doc_key("res:1", 1),
        perms: Perms { edit: true, comment: true, ..Perms::default() },
        watermark: Some(Watermark { text: "Ann".into() }),
        iat: 1_000,
        exp: 1_300,
        jti: None,
    }
}

#[test]
fn signs_what_it_verifies() {
    let key = SigningKey::from_bytes(&[9; 32]);
    let token = sign(&claims(), "k1", &key).unwrap();
    let keys = HostKeys::new([HostKey { kid: "k1".into(), key: key.verifying_key(), tenant: "example-corp".into(), iss: "one.test".into() }]).unwrap();
    let verified = keys.verify(&token, "srv", 1_100).unwrap();
    assert_eq!(verified.kid, "k1");
    assert_eq!(verified.principal_id(), "t:example-corp:one.test:user-1");
    assert_eq!(keys.verify(&token, "another-server", 1_100).unwrap_err(), Error::Audience);
    assert_eq!(decode(&token).unwrap(), verified);
}

#[test]
fn the_signer_refuses_bad_claims() {
    let key = SigningKey::from_bytes(&[9; 32]);
    let refuse = |claims: Claims| sign(&claims, "k1", &key).unwrap_err();
    assert_eq!(refuse(Claims { perms: Perms { edit: true, comment: false, ..Perms::default() }, ..claims() }), Error::Claims, "edit implies comment (OT1)");
    assert_eq!(refuse(Claims { file: "a/b.docx".into(), ..claims() }), Error::Claims, "a path is not a resource id");
    assert_eq!(refuse(Claims { file: String::new(), ..claims() }), Error::Claims);
    assert_eq!(refuse(Claims { doc_key: "*".into(), ..claims() }), Error::Claims, "no wildcards");
    assert_eq!(refuse(Claims { tenant: "Bad Tenant".into(), ..claims() }), Error::Claims);
    assert_eq!(refuse(Claims { iss: "one:test".into(), ..claims() }), Error::Claims, "an issuer has no colon: principals stay unambiguous");
    assert_eq!(refuse(Claims { aud: String::new(), ..claims() }), Error::Claims);
    assert_eq!(refuse(Claims { watermark: Some(Watermark { text: "x".repeat(257) }), ..claims() }), Error::Claims);
    assert_eq!(refuse(Claims { exp: 1_000 + 3_601, ..claims() }), Error::Expired, "at most an hour");
    assert_eq!(refuse(Claims { exp: 1_000, ..claims() }), Error::Expired);
}

#[test]
fn roles_follow_the_permissions() {
    assert_eq!(role_of(&Perms { edit: true, comment: true, ..Perms::default() }), Role::Editor);
    assert_eq!(role_of(&Perms { comment: true, download: true, ..Perms::default() }), Role::Commenter);
    assert_eq!(role_of(&Perms { download: true, share: true, export: true, ..Perms::default() }), Role::Viewer);
}

#[test]
fn unknown_permission_fields_are_malformed() {
    let key = SigningKey::from_bytes(&[9; 32]);
    let token = sign(&claims(), "k1", &key).unwrap();
    let segment = token.split('.').nth(1).unwrap();
    use base64::Engine as _;
    let engine = base64::engine::general_purpose::URL_SAFE_NO_PAD;
    let json = String::from_utf8(engine.decode(segment).unwrap()).unwrap().replace("\"share\":false", "\"share\":false,\"owner\":true");
    let forged = format!("ko1.{}.{}", engine.encode(json), token.rsplit('.').next().unwrap());
    assert_eq!(decode(&forged).unwrap_err(), Error::Malformed);
}
