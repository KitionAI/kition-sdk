//! Save receipts: what a host verifies before it stores a save's authors (I6).
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use ed25519_dalek::SigningKey;
use kition_open_token::Error;
use kition_open_token::receipt::{ReceiptAuthor, ReceiptClaims, ServerKey, ServerKeys, sign};

fn claims() -> ReceiptClaims {
    ReceiptClaims {
        v: 1,
        typ: String::new(),
        kid: String::new(),
        iss: "kition-server-test".into(),
        aud: "one.test".into(),
        tenant: "acme".into(),
        file: "res:1".into(),
        doc_key: "k1".into(),
        doc_id: "0192f2d4-7b1a-4c6e-9f10-3a5b6c7d8e9f".into(),
        seq: 7,
        trigger: "user".into(),
        authors: vec![ReceiptAuthor { principal: "t:acme:one.test:ann".into(), name: "Ann".into() }],
        iat: 1_000,
        exp: 1_300,
    }
}

#[test]
fn a_host_verifies_what_the_server_signed() {
    let key = SigningKey::from_bytes(&[3; 32]);
    let keys = ServerKeys::new([ServerKey { kid: "s1".into(), key: key.verifying_key(), iss: "kition-server-test".into() }]).unwrap();
    let receipt = sign(&claims(), "s1", &key).unwrap();
    let verified = keys.verify(&receipt, "one.test", 1_100).unwrap();
    assert_eq!(verified.authors, claims().authors);
    assert_eq!(verified.seq, 7);
    assert_eq!(keys.verify(&receipt, "one.other", 1_100).unwrap_err(), Error::Audience);
    assert_eq!(keys.verify(&receipt, "one.test", 1_300).unwrap_err(), Error::Expired);
    let other = SigningKey::from_bytes(&[4; 32]);
    let forged =
        sign(&ReceiptClaims { authors: vec![ReceiptAuthor { principal: "t:acme:one.test:mallory".into(), name: "Mallory".into() }], ..claims() }, "s1", &other)
            .unwrap();
    assert_eq!(keys.verify(&forged, "one.test", 1_100).unwrap_err(), Error::Signature);
    assert_eq!(keys.verify("ksr1.e30", "one.test", 1_100).unwrap_err(), Error::Malformed);
}

#[test]
fn refuses_bad_receipts_and_key_sets() {
    let key = SigningKey::from_bytes(&[3; 32]);
    assert_eq!(sign(&ReceiptClaims { exp: 1_000 + 601, ..claims() }, "s1", &key).unwrap_err(), Error::Expired);
    assert_eq!(sign(&ReceiptClaims { trigger: "page".into(), ..claims() }, "s1", &key).unwrap_err(), Error::Claims);
    let one = || ServerKey { kid: "s1".into(), key: key.verifying_key(), iss: "srv".into() };
    assert_eq!(ServerKeys::new([one(), one()]).unwrap_err(), Error::DuplicateKey);
}
