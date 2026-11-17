//! # kition-open-token
//!
//! Open tokens (`ko1.`), managed co-editing (Kition platform docs/platform/managed-collab.md,
//! section 1): a host (Kition One, an integrator's server) signs one person's permissions on one
//! file version; Kition Server and the kit host verify them offline against the host's public
//! keys, and never call the host back to ask.
//!
//! ```text
//! ko1.<base64url(claims JSON)>.<base64url(Ed25519 signature over the middle segment's ASCII)>
//! ```
//!
//! The signature covers the segment as sent, so verifiers never re-serialize the claims.
//! `@kition/sync/openToken` is the TypeScript twin, held to the same answers by
//! `tests/vectors.json`.
#![forbid(unsafe_code)]
#![deny(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

pub mod receipt;

use std::collections::HashMap;

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use ed25519_dalek::{Signature, VerifyingKey};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// What every open token starts with.
pub const PREFIX: &str = "ko1.";
/// The claims' `typ`.
pub const TYPE: &str = "kition-open";
/// The claims' `v`.
pub const VERSION: u32 = 1;
/// The longest a token may live (`exp - iat`), seconds (OT3).
pub const MAX_TTL_SECS: u64 = 3600;
/// How far ahead of the verifier's clock `iat` may be, seconds (OT3).
pub const CLOCK_SKEW_SECS: u64 = 60;
/// The longest `watermark.text`.
pub const MAX_WATERMARK: usize = 256;

/// What the person may do with the file (OT1, OT5). `edit` implies `comment`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Perms {
    pub edit: bool,
    pub comment: bool,
    pub download: bool,
    pub share: bool,
    pub export: bool,
}

/// What the kit host draws over the editor.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Watermark {
    pub text: String,
}

/// The sync role a token grants (OT1); an open token never grants `owner`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Role {
    Editor,
    Commenter,
    Viewer,
}

impl Role {
    /// The sync protocol's name for it.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Editor => "editor",
            Self::Commenter => "commenter",
            Self::Viewer => "viewer",
        }
    }
}

/// The role `perms` grant: `editor` for `edit`, `commenter` for `comment` alone, else `viewer`.
pub fn role_of(perms: &Perms) -> Role {
    if perms.edit {
        Role::Editor
    } else if perms.comment {
        Role::Commenter
    } else {
        Role::Viewer
    }
}

/// An open token's claims.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Claims {
    pub v: u32,
    pub typ: String,
    pub kid: String,
    /// The host that signed it: `[A-Za-z0-9._-]`, 1 to 128 characters; its keys name it (I2).
    pub iss: String,
    /// The Kition Server the token is for (its configured id); a server refuses others' (I2).
    pub aud: String,
    pub tenant: String,
    /// The person: the host's user id.
    pub sub: String,
    #[serde(default)]
    pub name: String,
    /// The host's immutable resource id of the file.
    pub file: String,
    /// The host content revision the session opens.
    pub version: String,
    /// The co-editing generation (section 1.3): one room per `(tenant, file, doc_key)`.
    pub doc_key: String,
    pub perms: Perms,
    #[serde(default)]
    pub watermark: Option<Watermark>,
    pub iat: u64,
    pub exp: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub jti: Option<String>,
}

impl Claims {
    /// The sync role these claims grant.
    pub fn role(&self) -> Role {
        role_of(&self.perms)
    }

    /// The Server principal id, `t:<tenant>:<iss>:<sub>`: the same person of another host, or a
    /// `ks1` token's `t:<tenant>:<sub>`, is someone else (I2).
    pub fn principal_id(&self) -> String {
        format!("t:{}:{}:{}", self.tenant, self.iss, self.sub)
    }
}

/// Why a token was refused. `code()` is shared with `@kition/sync/openToken`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Error {
    /// Not `ko1.<segment>.<signature>`, or the segment is not claims JSON.
    Malformed,
    /// `v` or `typ` is not this format's.
    Version,
    /// No key of the claims' tenant has the claims' `kid`.
    UnknownKey,
    Signature,
    /// The key belongs to another issuer than the claims' `iss`.
    Issuer,
    /// The token is for another server (`aud`).
    Audience,
    /// Two keys with one `(tenant, kid)`: the key set is refused, never one of them chosen (I3).
    DuplicateKey,
    /// A claim is missing, too long, or ill-formed; or `edit` without `comment`.
    Claims,
    /// `now >= exp`, or `exp - iat` outside 1..=3600.
    Expired,
    /// `iat` is more than 60 seconds ahead.
    NotYetValid,
}

impl Error {
    pub fn code(self) -> &'static str {
        match self {
            Self::Malformed => "malformed",
            Self::Version => "version",
            Self::UnknownKey => "unknown-key",
            Self::Signature => "signature",
            Self::Issuer => "issuer",
            Self::Audience => "audience",
            Self::DuplicateKey => "duplicate-key",
            Self::Claims => "claims",
            Self::Expired => "expired",
            Self::NotYetValid => "not-yet-valid",
        }
    }
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "open token refused: {}", self.code())
    }
}

impl std::error::Error for Error {}

/// A host's public key: it signs only for `tenant`, and only as `iss` (OT2, I2).
#[derive(Clone, Debug)]
pub struct HostKey {
    pub kid: String,
    pub key: VerifyingKey,
    pub tenant: String,
    pub iss: String,
}

impl HostKey {
    /// A key from its id, its raw 32-byte public key (base64url, a JWK `x`), its tenant and issuer.
    pub fn parse(kid: &str, public_key: &str, tenant: &str, iss: &str) -> Result<Self, Error> {
        let bytes = URL_SAFE_NO_PAD.decode(public_key.trim()).map_err(|_| Error::Malformed)?;
        let bytes: [u8; 32] = bytes.try_into().map_err(|_| Error::Malformed)?;
        let key = VerifyingKey::from_bytes(&bytes).map_err(|_| Error::Malformed)?;
        if !is_tenant(tenant) || !id_like(iss, b"") || !plain(kid, 128) {
            return Err(Error::Malformed);
        }
        Ok(Self { kid: kid.to_owned(), key, tenant: tenant.to_owned(), iss: iss.to_owned() })
    }
}

/// The keys a verifier trusts, by tenant and key id.
#[derive(Clone, Debug, Default)]
pub struct HostKeys {
    keys: HashMap<(String, String), HostKey>,
}

impl HostKeys {
    /// The key set; `Error::DuplicateKey` when two keys share a `(tenant, kid)` (I3).
    pub fn new(keys: impl IntoIterator<Item = HostKey>) -> Result<Self, Error> {
        let mut map = HashMap::new();
        for key in keys {
            if map.insert((key.tenant.clone(), key.kid.clone()), key).is_some() {
                return Err(Error::DuplicateKey);
            }
        }
        Ok(Self { keys: map })
    }

    pub fn is_empty(&self) -> bool {
        self.keys.is_empty()
    }

    /// Verifies `token` at `now` (Unix seconds) for the server `audience` (OT3, I2).
    pub fn verify(&self, token: &str, audience: &str, now: u64) -> Result<Claims, Error> {
        let (segment, signature) = split(token)?;
        let claims = parse_claims(segment)?;
        if claims.v != VERSION || claims.typ != TYPE {
            return Err(Error::Version);
        }
        let key = self.keys.get(&(claims.tenant.clone(), claims.kid.clone())).ok_or(Error::UnknownKey)?;
        let signature = URL_SAFE_NO_PAD.decode(signature).map_err(|_| Error::Malformed)?;
        let signature = Signature::from_slice(&signature).map_err(|_| Error::Malformed)?;
        key.key.verify_strict(segment.as_bytes(), &signature).map_err(|_| Error::Signature)?;
        if key.iss != claims.iss {
            return Err(Error::Issuer);
        }
        if claims.aud != audience {
            return Err(Error::Audience);
        }
        check_claims(&claims)?;
        check_time(&claims, now)?;
        Ok(claims)
    }
}

/// The claims of `token` without checking its signature or times: for showing what a token says,
/// never for deciding what it allows.
pub fn decode(token: &str) -> Result<Claims, Error> {
    let (segment, _) = split(token)?;
    parse_claims(segment)
}

fn split(token: &str) -> Result<(&str, &str), Error> {
    let rest = token.strip_prefix(PREFIX).ok_or(Error::Malformed)?;
    let (segment, signature) = rest.split_once('.').ok_or(Error::Malformed)?;
    if segment.is_empty() || signature.is_empty() || signature.contains('.') {
        return Err(Error::Malformed);
    }
    Ok((segment, signature))
}

fn parse_claims(segment: &str) -> Result<Claims, Error> {
    let json = URL_SAFE_NO_PAD.decode(segment).map_err(|_| Error::Malformed)?;
    serde_json::from_slice(&json).map_err(|_| Error::Malformed)
}

/// Whether `tenant` is a tenant name: 2 to 40 lowercase letters, digits, and inner hyphens.
pub fn is_tenant(tenant: &str) -> bool {
    let bytes = tenant.as_bytes();
    (2..=40).contains(&bytes.len())
        && bytes.iter().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'-')
        && bytes.first() != Some(&b'-')
        && bytes.last() != Some(&b'-')
}

fn plain(text: &str, max: usize) -> bool {
    !text.is_empty() && text.len() <= max && !text.chars().any(char::is_control)
}

fn id_like(text: &str, extra: &[u8]) -> bool {
    (1..=128).contains(&text.len()) && text.bytes().all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b) || extra.contains(&b))
}

fn check_claims(claims: &Claims) -> Result<(), Error> {
    let ok = is_tenant(&claims.tenant)
        && plain(&claims.kid, 128)
        && id_like(&claims.iss, b"")
        && plain(&claims.aud, 256)
        && plain(&claims.sub, 128)
        && claims.name.len() <= 128
        && !claims.name.chars().any(char::is_control)
        && id_like(&claims.file, b":")
        && plain(&claims.version, 128)
        && id_like(&claims.doc_key, b"")
        && (!claims.perms.edit || claims.perms.comment)
        && claims.watermark.as_ref().is_none_or(|mark| plain(&mark.text, MAX_WATERMARK))
        && claims.jti.as_ref().is_none_or(|jti| plain(jti, 128));
    if ok { Ok(()) } else { Err(Error::Claims) }
}

fn check_time(claims: &Claims, now: u64) -> Result<(), Error> {
    if claims.exp <= claims.iat || claims.exp - claims.iat > MAX_TTL_SECS {
        return Err(Error::Expired);
    }
    if claims.iat > now.saturating_add(CLOCK_SKEW_SECS) {
        return Err(Error::NotYetValid);
    }
    if now >= claims.exp {
        return Err(Error::Expired);
    }
    Ok(())
}

/// The `doc_key` of `file`'s co-editing `generation` (section 1.3; not a secret, since the token
/// that carries it is signed): the first 32 characters of
/// base64url(SHA-256("kition-doc-key\n" + file + "\n" + generation)).
pub fn doc_key(file: &str, generation: u64) -> String {
    let mut hash = Sha256::new();
    hash.update(b"kition-doc-key\n");
    hash.update(file.as_bytes());
    hash.update(b"\n");
    hash.update(generation.to_string().as_bytes());
    let mut text = URL_SAFE_NO_PAD.encode(hash.finalize());
    text.truncate(32);
    text
}

/// Signs `claims` with `key` (feature `sign`, for host servers). `v`, `typ` and `kid` are set
/// from the arguments; the claims are checked first (`Error::Claims`, `Error::Expired`), and
/// written with sorted keys.
#[cfg(feature = "sign")]
pub fn sign(claims: &Claims, kid: &str, key: &ed25519_dalek::SigningKey) -> Result<String, Error> {
    use ed25519_dalek::Signer as _;
    let claims = Claims { v: VERSION, typ: TYPE.to_owned(), kid: kid.to_owned(), ..claims.clone() };
    check_claims(&claims)?;
    if claims.exp <= claims.iat || claims.exp - claims.iat > MAX_TTL_SECS {
        return Err(Error::Expired);
    }
    let value = sorted(serde_json::to_value(&claims).map_err(|_| Error::Claims)?);
    let json = serde_json::to_vec(&value).map_err(|_| Error::Claims)?;
    let segment = URL_SAFE_NO_PAD.encode(json);
    let signature = key.sign(segment.as_bytes());
    Ok(format!("{PREFIX}{segment}.{}", URL_SAFE_NO_PAD.encode(signature.to_bytes())))
}

/// `value` with every object's keys in order, whatever map order serde_json was built with.
#[cfg(feature = "sign")]
pub(crate) fn sorted(value: serde_json::Value) -> serde_json::Value {
    match value {
        serde_json::Value::Object(map) => {
            let mut entries: Vec<_> = map.into_iter().collect();
            entries.sort_by(|a, b| a.0.cmp(&b.0));
            serde_json::Value::Object(entries.into_iter().map(|(key, value)| (key, sorted(value))).collect())
        }
        other => other,
    }
}
