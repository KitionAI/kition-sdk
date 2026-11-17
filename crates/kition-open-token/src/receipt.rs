//! Save receipts (`ksr1.`; Kition platform docs/platform/managed-collab.md
//! section 3): Kition Server's signed statement of what one save of a managed room holds — the
//! room's file generation, the change written, and every author of the changes since the last
//! version, from the server's own log. The page carries it to the host's write; the host verifies
//! it with the server's public key and takes the authors from it, never from the page.
//!
//! `ksr1.` base64url(claims JSON, keys sorted) `.` base64url(Ed25519 signature over the middle segment).

use std::collections::HashMap;

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use ed25519_dalek::{Signature, VerifyingKey};
use serde::{Deserialize, Serialize};

use crate::Error;

pub const RECEIPT_PREFIX: &str = "ksr1.";
pub const RECEIPT_TYPE: &str = "kition-save";
/// The longest a receipt may live: a save writes within minutes of `save/begin`.
pub const RECEIPT_MAX_TTL_SECS: u64 = 600;
/// At most this many authors; a server that has more names the most recent ones.
pub const RECEIPT_MAX_AUTHORS: usize = 256;

/// One author of a save: the sync principal and the name they said hello with.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReceiptAuthor {
    pub principal: String,
    pub name: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReceiptClaims {
    pub v: u32,
    pub typ: String,
    pub kid: String,
    /// The server that signed it (its configured id: the `aud` of the open tokens it takes).
    pub iss: String,
    /// The host the save is for (the open token's `iss`).
    pub aud: String,
    pub tenant: String,
    pub file: String,
    pub doc_key: String,
    pub doc_id: String,
    /// The room's change the save writes.
    pub seq: u64,
    /// `user`, `timer` or `command`.
    pub trigger: String,
    pub authors: Vec<ReceiptAuthor>,
    pub iat: u64,
    pub exp: u64,
}

/// A server's public key, by the server's id.
#[derive(Clone, Debug)]
pub struct ServerKey {
    pub kid: String,
    pub key: VerifyingKey,
    pub iss: String,
}

/// The server keys a host trusts, by `(iss, kid)`.
#[derive(Clone, Debug, Default)]
pub struct ServerKeys {
    keys: HashMap<(String, String), ServerKey>,
}

impl ServerKeys {
    /// The key set; `Error::DuplicateKey` when two keys share an `(iss, kid)`.
    pub fn new(keys: impl IntoIterator<Item = ServerKey>) -> Result<Self, Error> {
        let mut map = HashMap::new();
        for key in keys {
            if map.insert((key.iss.clone(), key.kid.clone()), key).is_some() {
                return Err(Error::DuplicateKey);
            }
        }
        Ok(Self { keys: map })
    }

    /// Verifies `receipt` for the host `audience` (its own `iss`) at `now`.
    pub fn verify(&self, receipt: &str, audience: &str, now: u64) -> Result<ReceiptClaims, Error> {
        let rest = receipt.strip_prefix(RECEIPT_PREFIX).ok_or(Error::Malformed)?;
        let (segment, signature) = rest.split_once('.').ok_or(Error::Malformed)?;
        if segment.is_empty() || signature.is_empty() || signature.contains('.') {
            return Err(Error::Malformed);
        }
        let json = URL_SAFE_NO_PAD.decode(segment).map_err(|_| Error::Malformed)?;
        let claims: ReceiptClaims = serde_json::from_slice(&json).map_err(|_| Error::Malformed)?;
        if claims.v != 1 || claims.typ != RECEIPT_TYPE {
            return Err(Error::Version);
        }
        let key = self.keys.get(&(claims.iss.clone(), claims.kid.clone())).ok_or(Error::UnknownKey)?;
        let signature = URL_SAFE_NO_PAD.decode(signature).map_err(|_| Error::Malformed)?;
        let signature = Signature::from_slice(&signature).map_err(|_| Error::Malformed)?;
        key.key.verify_strict(segment.as_bytes(), &signature).map_err(|_| Error::Signature)?;
        if claims.aud != audience {
            return Err(Error::Audience);
        }
        check(&claims)?;
        if claims.iat > now.saturating_add(crate::CLOCK_SKEW_SECS) {
            return Err(Error::NotYetValid);
        }
        if now >= claims.exp {
            return Err(Error::Expired);
        }
        Ok(claims)
    }
}

fn check(claims: &ReceiptClaims) -> Result<(), Error> {
    if claims.exp <= claims.iat || claims.exp - claims.iat > RECEIPT_MAX_TTL_SECS {
        return Err(Error::Expired);
    }
    let text = |value: &str, max: usize| !value.is_empty() && value.len() <= max && !value.chars().any(char::is_control);
    let ok = crate::is_tenant(&claims.tenant)
        && text(&claims.kid, 128)
        && text(&claims.iss, 256)
        && text(&claims.aud, 128)
        && text(&claims.file, 128)
        && text(&claims.doc_key, 128)
        && text(&claims.doc_id, 64)
        && ["user", "timer", "command"].contains(&claims.trigger.as_str())
        && claims.authors.len() <= RECEIPT_MAX_AUTHORS
        && claims.authors.iter().all(|author| text(&author.principal, 512) && author.name.len() <= 128 && !author.name.chars().any(char::is_control));
    if ok { Ok(()) } else { Err(Error::Claims) }
}

/// Signs a receipt (feature `sign`, for Kition Server); `v`, `typ` and `kid` are set here.
#[cfg(feature = "sign")]
pub fn sign(claims: &ReceiptClaims, kid: &str, key: &ed25519_dalek::SigningKey) -> Result<String, Error> {
    use ed25519_dalek::Signer as _;
    let claims = ReceiptClaims { v: 1, typ: RECEIPT_TYPE.to_owned(), kid: kid.to_owned(), ..claims.clone() };
    check(&claims)?;
    let value = crate::sorted(serde_json::to_value(&claims).map_err(|_| Error::Claims)?);
    let segment = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&value).map_err(|_| Error::Claims)?);
    Ok(format!("{RECEIPT_PREFIX}{segment}.{}", URL_SAFE_NO_PAD.encode(key.sign(segment.as_bytes()).to_bytes())))
}
