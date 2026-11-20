//! Every `kition-sync/1` method: its name constant and its params and result types. Fields that
//! carry binary payloads (KDM change bytes, snapshots, blobs) are [`Bin`] indices; see
//! [`crate::framing`] for how they are carried.

use crate::bin::Bin;
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Method name constants, exactly as they appear on the wire.
pub mod method {
    pub const SYNC_HELLO: &str = "sync/hello";
    pub const ROOM_JOIN: &str = "room/join";
    pub const CHANGES_PUSH: &str = "changes/push";
    pub const CHANGES_PULL: &str = "changes/pull";
    pub const PRESENCE_SET: &str = "presence/set";
    pub const PRESENCE_UPDATE: &str = "presence/update";
    pub const BLOB_HAS: &str = "blob/has";
    pub const BLOB_PUT: &str = "blob/put";
    pub const BLOB_GET: &str = "blob/get";
    pub const SNAPSHOT_GET: &str = "snapshot/get";
    pub const ROOM_CREATE: &str = "room/create";
    pub const ROOM_OPEN: &str = "room/open";
    pub const ROOM_LINK: &str = "room/link";
    pub const ROOM_LEAVE: &str = "room/leave";
    pub const HISTORY_LIST: &str = "history/list";
    pub const HISTORY_GET: &str = "history/get";
    pub const HISTORY_RESTORE: &str = "history/restore";
    pub const LEASE_ACQUIRE: &str = "lease/acquire";
    pub const LEASE_RELEASE: &str = "lease/release";
    pub const LEASE_CHANGED: &str = "lease/changed";
    pub const ROOM_MEMBERS: &str = "room/members";
    pub const ROOM_SET_ROLE: &str = "room/setRole";
    pub const ROOM_REMOVE_MEMBER: &str = "room/removeMember";
    pub const ROOM_REVOKE_LINK: &str = "room/revokeLink";
    pub const ROOM_ACCESS: &str = "room/access";
    pub const PREVIEW_GET: &str = "preview/get";
    pub const EXPORT_GET: &str = "export/get";
    pub const AGENT_RUN: &str = "agent/run";
    pub const ROOMS_LIST: &str = "rooms/list";
    pub const ROOMS_CHANGED: &str = "rooms/changed";
    pub const ACCOUNT_SETTINGS: &str = "account/settings";
    pub const ACCOUNT_UPDATE: &str = "account/update";
    pub const ACCOUNT_CHANGED: &str = "account/changed";
    pub const ROOM_RESOLVE: &str = "room/resolve";
    pub const ROOM_RESOLVED: &str = "room/resolved";
    pub const SAVE_BEGIN: &str = "save/begin";
    pub const SAVE_END: &str = "save/end";
    pub const SAVE_CHANGED: &str = "save/changed";
}

/// The capability a server's `sync/hello` lists when it keeps leases (protocol 1.5).
pub const LEASES_CAPABILITY: &str = "leases";

/// The capability a server's `sync/hello` lists when it takes open tokens and keeps one room per
/// file generation (protocol 1.10, `KitCollab 1.4`; docs/platform/managed-collab.md section 2).
pub const OPEN_ROOMS_CAPABILITY: &str = "open-rooms";

/// The lease scope that covers the whole document: it collides with every other scope.
pub const WHOLE_DOCUMENT_SCOPE: &str = "*";

fn is_false(value: &bool) -> bool {
    !*value
}

/// A room's role for one principal: `editor` and `owner` may push changes, `commenter` (protocol
/// 1.6) only changes that touch comment objects (KitModel rule M23), `viewer` none.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    Owner,
    Editor,
    Commenter,
    Viewer,
}

impl Role {
    /// Orders roles by what they allow: `viewer` < `commenter` < `editor` < `owner`.
    pub fn rank(self) -> u8 {
        match self {
            Self::Viewer => 0,
            Self::Commenter => 1,
            Self::Editor => 2,
            Self::Owner => 3,
        }
    }

    /// Whether the role may push changes at all (a commenter's only comments).
    pub fn may_push(self) -> bool {
        self != Self::Viewer
    }

    /// Whether the role may push any change (not only comments).
    pub fn may_edit(self) -> bool {
        matches!(self, Self::Owner | Self::Editor)
    }
}

/// One peer's presence in a room: who they are, their cursor color, and their kit's own
/// ephemeral state (selection, cursor position, viewport — opaque to this protocol).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Presence {
    pub principal_id: String,
    pub name: String,
    pub color: String,
    pub state: Value,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ClientInfo {
    pub name: String,
    pub version: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ServerInfo {
    pub name: String,
    pub version: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Principal {
    pub id: String,
    pub name: String,
}

/// `sync/hello` (client to server): the first message on a connection.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HelloParams {
    pub protocol: String,
    pub token: String,
    pub client: ClientInfo,
    pub capabilities: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HelloResult {
    pub server: ServerInfo,
    pub principal: Principal,
    pub capabilities: Vec<String>,
    /// Protocol 1.10: the scope of a connection made with an open token (RM1); absent otherwise.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub open: Option<OpenScope>,
}

/// What an open-token connection reaches (protocol 1.10, RM1): exactly one file generation's
/// room, at the role the token's permissions grant (never `owner`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenScope {
    pub tenant: String,
    /// The host that signed the token; with `tenant`, `file` and `doc_key` it names the generation (I4).
    pub iss: String,
    /// The host's resource id of the file.
    pub file: String,
    /// The co-editing generation; one room per `(tenant, file, docKey)`.
    pub doc_key: String,
    pub role: Role,
    pub perms: OpenPerms,
}

/// The open token's permissions, as the server read them.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct OpenPerms {
    pub edit: bool,
    pub comment: bool,
    pub download: bool,
    pub share: bool,
    pub export: bool,
}

/// `room/resolve` (client to server, protocol 1.10, open-token connections only): the room of the
/// connection's file generation, and with `claim` the seed claim when there is none (RM5).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoomResolveParams {
    #[serde(default, skip_serializing_if = "is_false")]
    pub claim: bool,
}

/// `docId` is the bound room's, or `None`; `claimed` is `true` when this connection now holds the
/// seed claim (an editor's `claim` with no room and no other holder), for 60 seconds.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoomResolveResult {
    pub doc_id: Option<String>,
    pub claimed: bool,
    /// The room's save state (D3); `None` without a room.
    #[serde(default)]
    pub save: Option<crate::save::SaveState>,
}

/// `room/resolved` (server to client, notification, protocol 1.10): the connection's file
/// generation now has a room.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoomResolvedParams {
    pub doc_id: String,
}

/// The `error.data` of a `room/create` refused `conflict` from an open-token connection whose
/// file generation already has a room (RM6): that room, which the caller joins instead.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoomBoundConflict {
    pub code: String,
    pub doc_id: String,
}

/// `room/join` (client to server): catch-up is by the room's own server sequence, not a KDM
/// version, so the server never needs a replica of its own to answer it. `since` is the highest
/// `seq` the caller already has (`null`: none, catch up from the room's snapshot); the result's
/// `changes` are every change after it, up to `limit` (a server caps this; see
/// [`RoomJoinResult::more`]), and `seq` locates the caller, so it always knows where it now
/// stands even when `changes` is empty.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoomJoinParams {
    pub doc_id: String,
    pub since: Option<u64>,
    /// How many changes to return at most; a server may cap this lower than requested. `None`
    /// asks for the server's own default.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<u32>,
    /// Protocol 1.8, with `since: null` only (a client with no replica yet): start from a shallow
    /// snapshot of the room's latest state ([`RoomJoinResult::shallow`]) instead of from its
    /// stored snapshot. Omitted when `false`.
    #[serde(default, skip_serializing_if = "is_false")]
    pub shallow: bool,
    /// Protocol 1.8, with `since: null` only: let the server choose a shallow start for a large
    /// document (past its own size threshold), a full one otherwise. Omitted: full.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prefer: Option<SnapshotPreference>,
}

/// Protocol 1.8: the kind of snapshot a client would rather start from, when the server may choose
/// (`snapshot/get` and `room/join`'s `prefer`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SnapshotPreference {
    /// A shallow snapshot (standard 2.0 rule M16a) for a document past the server's size
    /// threshold; a full one for a smaller document.
    Shallow,
    /// A full snapshot, as when `prefer` is omitted.
    Full,
}

/// A page of a room's catch-up. When `more` is `true`, `changes` did not reach the room's
/// latest: `seq` is the seq of the last change in `changes` (not the room's latest), and the
/// caller repeats `room/join` with `since` set to this `seq` to fetch the next page. When `more`
/// is `false`, `changes` reaches the room's latest and `seq` is that latest.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoomJoinResult {
    pub changes: Vec<Bin>,
    pub seq: u64,
    pub more: bool,
    pub presence: Vec<Presence>,
    pub role: Role,
    /// Protocol 1.5: `since` was older than the history the server still keeps change by change
    /// (its retention window), so `changes[0]` is a snapshot of the document (a full KDM export,
    /// imported like any change set) and the rest follow it. Omitted when `false`.
    #[serde(default, skip_serializing_if = "is_false")]
    pub snapshot: bool,
    /// Protocol 1.8: `changes[0]` is a **shallow** snapshot (standard 2.0 rule M16a) of the room's
    /// latest state, with `snapshot: true`, answered to a `room/join` with `since: null` that asked
    /// for one (`shallow`, or `prefer: "shallow"` for a large document). The client loads it as a
    /// new replica; it never imports it into an existing one. Omitted when `false`.
    #[serde(default, skip_serializing_if = "is_false")]
    pub shallow: bool,
}

/// `changes/push` (client to server): refused for viewers ([`crate::protocol::ErrorCode::Forbidden`]).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangesPushParams {
    pub doc_id: String,
    pub changes: Bin,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ChangesPushResult {
    pub seq: u64,
}

/// `changes/pull` (server to client, notification): another peer's changes.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangesPullParams {
    pub doc_id: String,
    pub changes: Bin,
    pub seq: u64,
    pub from: String,
}

/// `presence/set` (client to server, notification): ephemeral; the server does not persist it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PresenceSetParams {
    pub doc_id: String,
    pub state: Value,
}

/// `presence/update` (server to client, notification): the room's current peers, replacing any
/// earlier list for this `docId`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PresenceUpdateParams {
    pub doc_id: String,
    pub peers: Vec<Presence>,
}

/// `blob/has` (client to server): which of `hashes` `doc_id`'s room does not hold (protocol 1.5:
/// blobs are scoped to the documents that uploaded them).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BlobHasParams {
    pub doc_id: String,
    pub hashes: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BlobHasResult {
    pub missing: Vec<String>,
}

/// `blob/put` (client to server): the server verifies `data` hashes to `hash` (SHA-256) and
/// refuses it otherwise ([`crate::protocol::ErrorCode::Invalid`]), and records that `doc_id`
/// references it (protocol 1.5).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BlobPutParams {
    pub doc_id: String,
    pub hash: String,
    pub mime: String,
    pub data: Bin,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
pub struct BlobPutResult {}

/// `blob/get` (client to server): only a blob `doc_id` references, for a principal that may read
/// `doc_id`'s room (protocol 1.5).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BlobGetParams {
    pub doc_id: String,
    pub hash: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BlobGetResult {
    pub data: Bin,
    pub mime: String,
}

/// `snapshot/get` (client to server): the document's state as of `seq`, for a client that has
/// none of its history yet.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotGetParams {
    pub doc_id: String,
    /// Protocol 1.8: answer a shallow snapshot (standard 2.0 rule M16a) of the room's latest
    /// state: its current state with only recent history. Omitted when `false`.
    #[serde(default, skip_serializing_if = "is_false")]
    pub shallow: bool,
    /// Protocol 1.8: let the server choose a shallow snapshot for a large document (past its own
    /// size threshold), a full one otherwise. Omitted: full (unless `shallow`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prefer: Option<SnapshotPreference>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SnapshotGetResult {
    pub snapshot: Bin,
    pub seq: u64,
    /// Protocol 1.8: `snapshot` is shallow; the history before its root stays on the server
    /// (`history/get`). Omitted when `false`, and always by a server before 1.8.
    #[serde(default, skip_serializing_if = "is_false")]
    pub shallow: bool,
}

/// `room/create` (client to server): makes the room and returns a link to share it. The caller
/// becomes the room's `owner`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoomCreateParams {
    pub doc_id: String,
    /// The room's first state: a KDM snapshot that carries the document's whole history (rule
    /// S20): a full one, or a shallow one rooted at the document's birth (a copy made as a new
    /// document, `Replica::carries_whole_history`). A server refuses any other (`invalid`).
    pub snapshot: Bin,
    pub name: String,
    pub kit: String,
    /// Protocol 1.9: a **private** room, which syncs the document to its owner's own devices and
    /// has no share link until the owner mints one (`room/link`). Omitted when `false`.
    #[serde(default, skip_serializing_if = "is_false")]
    pub private: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoomCreateResult {
    /// The room's editing link; `None` (`null`) for a private room (protocol 1.9).
    pub share_link: Option<String>,
}

/// `room/leave` (client to server, notification).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoomLeaveParams {
    pub doc_id: String,
}

/// `room/open` (client to server): resolves a share link (as [`RoomCreateResult::share_link`]) to
/// the room it points to, and the role the caller would join it with. A client still sends
/// `room/join` with this `docId` to actually join; `room/open` only tells it where the link leads
/// and what it may do there, for example before showing a join prompt.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoomOpenParams {
    pub share_link: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoomOpenResult {
    pub doc_id: String,
    pub name: String,
    pub kit: String,
    pub role: Role,
}

/// `room/link` (client to server, protocol 1.4): mints another share link to a room the caller
/// is a member of, granting `role` (`editor`, `commenter` (1.6), or `viewer`, never more than the caller's own role),
/// for example a view-only link next to the editing link `room/create` answered.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoomLinkParams {
    pub doc_id: String,
    pub role: Role,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoomLinkResult {
    pub share_link: String,
}

/// `history/list` (client to server, protocol 1.5): the room's checkpoints, newest first, before
/// `before` (omitted: from the latest), at most `limit` (a server caps it).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryListParams {
    pub doc_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub before: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<u32>,
}

/// What a checkpoint stands for: a run of changes one principal pushed, or a snapshot the
/// server compacted older history into.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CheckpointKind {
    Changes,
    Snapshot,
}

/// One point the document's history can be read at ([`HistoryGetParams`]) or restored to.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Checkpoint {
    /// The document's state at this checkpoint is every change up to this `seq`.
    pub seq: u64,
    /// The first `seq` the checkpoint covers (`seq` itself for a snapshot).
    pub first_seq: u64,
    /// When the checkpoint's last change (or the snapshot) was recorded, in milliseconds since
    /// the Unix epoch.
    pub time: u64,
    /// Who pushed the changes; `None` for a snapshot.
    #[serde(default)]
    pub principal_id: Option<String>,
    /// How many changes the checkpoint covers (`0` for a snapshot).
    pub changes: u32,
    pub kind: CheckpointKind,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryListResult {
    pub checkpoints: Vec<Checkpoint>,
    /// Older checkpoints remain: repeat with `before` set to the last checkpoint's `first_seq`.
    pub more: bool,
}

/// `history/get` (client to server, protocol 1.5): the document as of `seq`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryGetParams {
    pub doc_id: String,
    pub seq: u64,
}

/// A snapshot of the document as of `seq`: exactly the asked `seq` within the history the server
/// keeps change by change, otherwise the nearest snapshot at or before it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryGetResult {
    pub snapshot: Bin,
    pub seq: u64,
}

/// `history/restore` (client to server, protocol 1.5): an `owner` or `editor` of a joined room
/// asks the server to restore the document's state as of `seq` as one new change, which every
/// member (the caller too) receives as `changes/pull`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryRestoreParams {
    pub doc_id: String,
    pub seq: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryRestoreResult {
    /// The restoring change's `seq`; `None` when the document already was in that state (no
    /// change was made).
    pub seq: Option<u64>,
    /// The `seq` whose state was restored (see [`HistoryGetResult::seq`]).
    pub restored: u64,
}

/// A lease on one scope of a room (protocol 1.5): who holds it, the holder's session (opaque; a
/// client tells its own leases from others' by it), and `ttl`, the milliseconds it had left when
/// sent. `ttl` is informational: a lease ends only when `lease/changed` drops it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Lease {
    pub scope: String,
    pub principal_id: String,
    pub name: String,
    pub session: String,
    pub ttl: u64,
}

/// `lease/acquire` (client to server, protocol 1.5): takes the lease on `scope` (a KDM object id,
/// a kit-named scope, or [`WHOLE_DOCUMENT_SCOPE`]) for `ttl` milliseconds, or renews it when the
/// caller's session holds it. Refused [`crate::protocol::ErrorCode::Conflict`] (with the holder's
/// [`Lease`] in `error.data.lease`) when another session holds a colliding scope, and
/// [`crate::protocol::ErrorCode::Forbidden`] for a viewer.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LeaseAcquireParams {
    pub doc_id: String,
    pub scope: String,
    /// Milliseconds; `None` asks for the server's default (30 000). A server clamps it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ttl: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LeaseAcquireResult {
    pub lease: Lease,
}

/// `lease/release` (client to server, protocol 1.5): ends the caller's lease on `scope`; releasing
/// one it does not hold changes nothing and still succeeds.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LeaseReleaseParams {
    pub doc_id: String,
    pub scope: String,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
pub struct LeaseReleaseResult {}

/// `lease/changed` (server to client, notification, protocol 1.5): the room's whole lease list,
/// replacing any earlier one for `doc_id`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LeaseChangedParams {
    pub doc_id: String,
    pub leases: Vec<Lease>,
}

/// One member of a room (protocol 1.6): their principal, display name, and role.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Member {
    pub principal_id: String,
    pub name: String,
    pub role: Role,
}

/// One live share link of a room (protocol 1.6): the link, the role it grants, and who minted it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareLink {
    pub share_link: String,
    pub role: Role,
    pub created_by: String,
}

/// `room/members` (client to server, protocol 1.6): the room's members and live share links, for
/// its `owner` or an `editor`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoomMembersParams {
    pub doc_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoomMembersResult {
    pub members: Vec<Member>,
    pub links: Vec<ShareLink>,
}

/// `room/setRole` (client to server, protocol 1.6): the owner changes another member's role
/// (`editor`, `commenter`, or `viewer`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoomSetRoleParams {
    pub doc_id: String,
    pub principal_id: String,
    pub role: Role,
}

/// `room/removeMember` (client to server, protocol 1.6): the owner removes another member.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoomRemoveMemberParams {
    pub doc_id: String,
    pub principal_id: String,
}

/// `room/revokeLink` (client to server, protocol 1.6): the owner revokes a share link.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoomRevokeLinkParams {
    pub doc_id: String,
    pub share_link: String,
}

/// The empty result of `room/setRole`, `room/removeMember`, and `room/revokeLink`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
pub struct RoomAdminResult {}

/// `room/access` (server to client, notification, protocol 1.6): the caller's role in the room
/// changed; `None` (`null`) means it was removed and is no longer joined.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoomAccessParams {
    pub doc_id: String,
    pub role: Option<Role>,
}

/// One room in a principal's document list (protocol 1.9, `rooms/list` and `rooms/changed`): the
/// document, the principal's role in it, when it last changed (milliseconds since the Unix epoch),
/// about how many bytes the server keeps for its current state, and whether it is private (only
/// its owner's devices sync it; no share link).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoomListing {
    pub doc_id: String,
    pub name: String,
    pub kit: String,
    pub role: Role,
    pub updated: u64,
    pub size: u64,
    #[serde(default)]
    pub private: bool,
}

/// `rooms/list` (client to server, protocol 1.9): one page of the rooms the caller is a member of,
/// most recently changed first. `cursor` is the previous page's (omitted: the first page), `limit`
/// at most how many to answer (a server caps it).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoomsListParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cursor: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<u32>,
}

/// The page, and the cursor of the next one (`None` when this page is the last).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoomsListResult {
    pub rooms: Vec<RoomListing>,
    pub cursor: Option<String>,
}

/// `rooms/changed` (server to client, notification, protocol 1.9): a room joined, left, or changed
/// in the receiver's document list: `room` as `rooms/list` would answer it now, or `None` when the
/// receiver is no longer a member.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoomsChangedParams {
    pub doc_id: String,
    pub room: Option<RoomListing>,
}

/// A principal's account settings on the server (protocol 1.9): the result of `account/settings`
/// and `account/update`, and the params of `account/changed`. `sync_all`: every document the person
/// opens on any of their devices syncs to their devices (as a private room) without asking.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountSettings {
    #[serde(default)]
    pub sync_all: bool,
}

/// `account/settings` (client to server, protocol 1.9): the caller's account settings.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct AccountSettingsParams {}

/// `account/update` (client to server, protocol 1.9): changes the settings it names; the result
/// is every setting as it now is.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountUpdateParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sync_all: Option<bool>,
}

/// The capability a server lists in `sync/hello` when it runs kits headless (protocol 1.7,
/// section 8a): `preview/get`, `export/get`, and `agent/run` for the kits it has.
pub const HEADLESS_CAPABILITY: &str = "headless";

/// `preview/get` (client to server, protocol 1.7): a picture of the document as the room has it
/// now, rendered by the kit's own engine on the server. `page` is a zero-based page (slide,
/// sheet) for a kit that has pages; `size` the longest side in pixels (the server's default when
/// omitted, and clamped).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewGetParams {
    pub doc_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub page: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size: Option<u32>,
}

/// The picture (`mimeType`, normally `image/png`), its size, and the `seq` of the room's state it
/// shows.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewGetResult {
    pub image: Bin,
    pub mime_type: String,
    pub width: u32,
    pub height: u32,
    pub seq: u64,
}

/// `export/get` (client to server, protocol 1.7): the document as a file in `format` (a format
/// the kit saves; the kit's native one when omitted), saved by the kit's own engine on the
/// server.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportGetParams {
    pub doc_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub format: Option<String>,
}

/// The file's bytes, its name (the room's name with the format's extension), its format, and the
/// `seq` of the room's state it holds.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportGetResult {
    pub data: Bin,
    pub name: String,
    pub format: String,
    pub seq: u64,
}

/// `agent/run` (client to server, protocol 1.7): runs an object-model batch (`model/batch`'s
/// request, Kition platform `docs/platform/sets/object-model.md`, without `documentId`) on the room's document in the
/// server's headless kit, as an agent acting for the caller (an `owner` or `editor` of a joined
/// room). The server sets the batch's `origin` itself (`agent`, the caller's principal, labelled
/// with `prompt` when given). What the batch changed becomes one new change of the room, which
/// every member (the caller too) receives as `changes/pull`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRunParams {
    pub doc_id: String,
    pub batch: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prompt: Option<String>,
}

/// The batch's answer (`{ refs, results, loaded }`) and the `seq` of the change it made (`None`
/// when it changed nothing, as a batch that only reads).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRunResult {
    pub seq: Option<u64>,
    pub result: Value,
}

/// Whether two lease scopes collide: equal, or either is [`WHOLE_DOCUMENT_SCOPE`].
pub fn scopes_collide(a: &str, b: &str) -> bool {
    a == b || a == WHOLE_DOCUMENT_SCOPE || b == WHOLE_DOCUMENT_SCOPE
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// Every message round-trips through JSON with the exact field names the protocol defines.
    #[test]
    fn hello_round_trips() {
        let params = HelloParams {
            protocol: crate::PROTOCOL.into(),
            token: "t".into(),
            client: ClientInfo { name: "kition".into(), version: "0.1.0".into() },
            capabilities: vec!["presence".into()],
        };
        let value = serde_json::to_value(&params).unwrap();
        assert_eq!(value["protocol"], "kition-sync/1");
        assert_eq!(serde_json::from_value::<HelloParams>(value).unwrap(), params);

        let result = HelloResult {
            server: ServerInfo { name: "kition-server".into(), version: "0.1.0".into() },
            principal: Principal { id: "p1".into(), name: "Ash".into() },
            capabilities: vec![],
            open: None,
        };
        let value = serde_json::to_value(&result).unwrap();
        assert_eq!(serde_json::from_value::<HelloResult>(value).unwrap(), result);
    }

    #[test]
    fn room_join_round_trips_and_uses_camel_case() {
        let params = RoomJoinParams { doc_id: "doc1".into(), since: Some(3), limit: None, shallow: false, prefer: None };
        let value = serde_json::to_value(&params).unwrap();
        assert_eq!(value, json!({ "docId": "doc1", "since": 3 }));
        assert_eq!(serde_json::from_value::<RoomJoinParams>(value).unwrap(), params);

        // `since: null` asks for everything, from the room's snapshot.
        let fresh = RoomJoinParams { doc_id: "doc1".into(), since: None, limit: None, shallow: false, prefer: None };
        let value = serde_json::to_value(&fresh).unwrap();
        assert_eq!(value, json!({ "docId": "doc1", "since": null }));
        assert_eq!(serde_json::from_value::<RoomJoinParams>(value).unwrap(), fresh);

        // `limit` caps how many changes come back in one page, for paging through a busy room.
        let paged = RoomJoinParams { doc_id: "doc1".into(), since: Some(512), limit: Some(512), shallow: false, prefer: None };
        let value = serde_json::to_value(&paged).unwrap();
        assert_eq!(value, json!({ "docId": "doc1", "since": 512, "limit": 512 }));
        assert_eq!(serde_json::from_value::<RoomJoinParams>(value).unwrap(), paged);

        let result = RoomJoinResult {
            changes: vec![Bin(0), Bin(1)],
            seq: 7,
            more: false,
            presence: vec![Presence { principal_id: "p1".into(), name: "Ash".into(), color: "#f00".into(), state: json!({ "cursor": 3 }) }],
            role: Role::Editor,
            snapshot: false,
            shallow: false,
        };
        let value = serde_json::to_value(&result).unwrap();
        assert_eq!(value["role"], "editor");
        assert!(value.get("snapshot").is_none(), "snapshot is omitted when false");
        assert_eq!(value["seq"], 7);
        assert_eq!(value["more"], false);
        assert_eq!(serde_json::from_value::<RoomJoinResult>(value).unwrap(), result);

        // `more: true` means `seq` is the last included change's seq, not the room's latest.
        let page = RoomJoinResult { changes: vec![Bin(0)], seq: 512, more: true, presence: vec![], role: Role::Editor, snapshot: false, shallow: false };
        let value = serde_json::to_value(&page).unwrap();
        assert_eq!(value["more"], true);
        assert_eq!(serde_json::from_value::<RoomJoinResult>(value).unwrap(), page);

        // A `since` older than the kept history answers a snapshot first.
        let reset = RoomJoinResult { changes: vec![Bin(0), Bin(1)], seq: 9, more: false, presence: vec![], role: Role::Viewer, snapshot: true, shallow: false };
        let value = serde_json::to_value(&reset).unwrap();
        assert_eq!(value["snapshot"], true);
        assert!(value.get("shallow").is_none(), "shallow is omitted when false");
        assert_eq!(serde_json::from_value::<RoomJoinResult>(value).unwrap(), reset);
    }

    #[test]
    fn shallow_starts_round_trip() {
        // 1.8: a client with no replica asks to start from a shallow snapshot, or lets the server
        // choose; a 1.7 message (no `shallow`, no `prefer`) still reads.
        let join = RoomJoinParams { doc_id: "doc1".into(), since: None, limit: None, shallow: true, prefer: None };
        let value = serde_json::to_value(&join).unwrap();
        assert_eq!(value, json!({ "docId": "doc1", "since": null, "shallow": true }));
        assert_eq!(serde_json::from_value::<RoomJoinParams>(value).unwrap(), join);
        let prefer = RoomJoinParams { doc_id: "doc1".into(), since: None, limit: None, shallow: false, prefer: Some(SnapshotPreference::Shallow) };
        let value = serde_json::to_value(&prefer).unwrap();
        assert_eq!(value, json!({ "docId": "doc1", "since": null, "prefer": "shallow" }));
        assert_eq!(serde_json::from_value::<RoomJoinParams>(value).unwrap(), prefer);
        let started = RoomJoinResult { changes: vec![Bin(0)], seq: 40, more: false, presence: vec![], role: Role::Editor, snapshot: true, shallow: true };
        let value = serde_json::to_value(&started).unwrap();
        assert_eq!((value["snapshot"].clone(), value["shallow"].clone()), (json!(true), json!(true)));
        assert_eq!(serde_json::from_value::<RoomJoinResult>(value).unwrap(), started);

        let get = SnapshotGetParams { doc_id: "doc1".into(), shallow: false, prefer: Some(SnapshotPreference::Full) };
        let value = serde_json::to_value(&get).unwrap();
        assert_eq!(value, json!({ "docId": "doc1", "prefer": "full" }));
        assert_eq!(serde_json::from_value::<SnapshotGetParams>(value).unwrap(), get);
        let old = serde_json::from_value::<SnapshotGetParams>(json!({ "docId": "doc1" })).unwrap();
        assert_eq!(old, SnapshotGetParams { doc_id: "doc1".into(), shallow: false, prefer: None });
        let answer = SnapshotGetResult { snapshot: Bin(0), seq: 40, shallow: true };
        let value = serde_json::to_value(&answer).unwrap();
        assert_eq!(value, json!({ "snapshot": { "$bin": 0 }, "seq": 40, "shallow": true }));
        assert_eq!(serde_json::from_value::<SnapshotGetResult>(value).unwrap(), answer);
        let full = serde_json::from_value::<SnapshotGetResult>(json!({ "snapshot": { "$bin": 0 }, "seq": 3 })).unwrap();
        assert!(!full.shallow);
        assert!(serde_json::from_value::<SnapshotGetParams>(json!({ "docId": "doc1", "prefer": "tiny" })).is_err());
    }

    #[test]
    fn changes_push_and_pull_round_trip() {
        let push = ChangesPushParams { doc_id: "doc1".into(), changes: Bin(0) };
        assert_eq!(serde_json::from_value::<ChangesPushParams>(serde_json::to_value(&push).unwrap()).unwrap(), push);
        let result = ChangesPushResult { seq: 42 };
        assert_eq!(serde_json::from_value::<ChangesPushResult>(serde_json::to_value(&result).unwrap()).unwrap(), result);
        let pull = ChangesPullParams { doc_id: "doc1".into(), changes: Bin(0), seq: 43, from: "p1".into() };
        assert_eq!(serde_json::from_value::<ChangesPullParams>(serde_json::to_value(&pull).unwrap()).unwrap(), pull);
    }

    #[test]
    fn presence_round_trips() {
        let set = PresenceSetParams { doc_id: "doc1".into(), state: json!({ "cursor": 1 }) };
        assert_eq!(serde_json::from_value::<PresenceSetParams>(serde_json::to_value(&set).unwrap()).unwrap(), set);
        let update = PresenceUpdateParams {
            doc_id: "doc1".into(),
            peers: vec![Presence { principal_id: "p1".into(), name: "Ash".into(), color: "#f00".into(), state: Value::Null }],
        };
        assert_eq!(serde_json::from_value::<PresenceUpdateParams>(serde_json::to_value(&update).unwrap()).unwrap(), update);
    }

    #[test]
    fn blob_messages_round_trip() {
        let has = BlobHasParams { doc_id: "doc1".into(), hashes: vec!["abc".into()] };
        let value = serde_json::to_value(&has).unwrap();
        assert_eq!(value, json!({ "docId": "doc1", "hashes": ["abc"] }));
        assert_eq!(serde_json::from_value::<BlobHasParams>(value).unwrap(), has);
        // Protocol 1.5 scopes blobs to a document: a request without `docId` does not parse.
        assert!(serde_json::from_value::<BlobHasParams>(json!({ "hashes": ["abc"] })).is_err());
        assert!(serde_json::from_value::<BlobGetParams>(json!({ "hash": "abc" })).is_err());
        let has_result = BlobHasResult { missing: vec!["abc".into()] };
        assert_eq!(serde_json::from_value::<BlobHasResult>(serde_json::to_value(&has_result).unwrap()).unwrap(), has_result);

        let put = BlobPutParams { doc_id: "doc1".into(), hash: "abc".into(), mime: "image/png".into(), data: Bin(0) };
        assert_eq!(serde_json::from_value::<BlobPutParams>(serde_json::to_value(&put).unwrap()).unwrap(), put);
        assert_eq!(serde_json::to_value(BlobPutResult {}).unwrap(), json!({}));

        let get = BlobGetParams { doc_id: "doc1".into(), hash: "abc".into() };
        assert_eq!(serde_json::to_value(&get).unwrap(), json!({ "docId": "doc1", "hash": "abc" }));
        assert_eq!(serde_json::from_value::<BlobGetParams>(serde_json::to_value(&get).unwrap()).unwrap(), get);
        let get_result = BlobGetResult { data: Bin(0), mime: "image/png".into() };
        assert_eq!(serde_json::from_value::<BlobGetResult>(serde_json::to_value(&get_result).unwrap()).unwrap(), get_result);
    }

    #[test]
    fn snapshot_and_room_lifecycle_round_trip() {
        let snapshot_params = SnapshotGetParams { doc_id: "doc1".into(), shallow: false, prefer: None };
        assert_eq!(serde_json::from_value::<SnapshotGetParams>(serde_json::to_value(&snapshot_params).unwrap()).unwrap(), snapshot_params);
        let snapshot_result = SnapshotGetResult { snapshot: Bin(0), seq: 7, shallow: false };
        assert_eq!(serde_json::from_value::<SnapshotGetResult>(serde_json::to_value(&snapshot_result).unwrap()).unwrap(), snapshot_result);

        let create = RoomCreateParams { doc_id: "doc1".into(), snapshot: Bin(0), name: "Sheet".into(), kit: "kit.sheet".into(), private: false };
        let value = serde_json::to_value(&create).unwrap();
        assert_eq!(value["kit"], "kit.sheet");
        assert_eq!(value.get("private"), None);
        assert_eq!(serde_json::from_value::<RoomCreateParams>(value).unwrap(), create);
        let create_result = RoomCreateResult { share_link: Some("https://kition.app/s/abc".into()) };
        let value = serde_json::to_value(&create_result).unwrap();
        assert_eq!(value, json!({ "shareLink": "https://kition.app/s/abc" }));
        assert_eq!(serde_json::from_value::<RoomCreateResult>(value).unwrap(), create_result);

        let leave = RoomLeaveParams { doc_id: "doc1".into() };
        assert_eq!(serde_json::from_value::<RoomLeaveParams>(serde_json::to_value(&leave).unwrap()).unwrap(), leave);
    }

    #[test]
    fn room_open_round_trips_and_uses_camel_case() {
        let params = RoomOpenParams { share_link: "https://kition.app/s/abc".into() };
        let value = serde_json::to_value(&params).unwrap();
        assert_eq!(value, json!({ "shareLink": "https://kition.app/s/abc" }));
        assert_eq!(serde_json::from_value::<RoomOpenParams>(value).unwrap(), params);

        let result = RoomOpenResult { doc_id: "doc1".into(), name: "Sheet".into(), kit: "kit.sheet".into(), role: Role::Editor };
        let value = serde_json::to_value(&result).unwrap();
        assert_eq!(value, json!({ "docId": "doc1", "name": "Sheet", "kit": "kit.sheet", "role": "editor" }));
        assert_eq!(serde_json::from_value::<RoomOpenResult>(value).unwrap(), result);
    }

    #[test]
    fn room_link_round_trips_and_uses_camel_case() {
        let params = RoomLinkParams { doc_id: "doc1".into(), role: Role::Viewer };
        let value = serde_json::to_value(&params).unwrap();
        assert_eq!(value, json!({ "docId": "doc1", "role": "viewer" }));
        assert_eq!(serde_json::from_value::<RoomLinkParams>(value).unwrap(), params);

        let result = RoomLinkResult { share_link: "https://kition.app/s/def".into() };
        let value = serde_json::to_value(&result).unwrap();
        assert_eq!(value, json!({ "shareLink": "https://kition.app/s/def" }));
        assert_eq!(serde_json::from_value::<RoomLinkResult>(value).unwrap(), result);
    }

    #[test]
    fn history_messages_round_trip_and_use_camel_case() {
        let list = HistoryListParams { doc_id: "doc1".into(), before: Some(40), limit: None };
        let value = serde_json::to_value(&list).unwrap();
        assert_eq!(value, json!({ "docId": "doc1", "before": 40 }));
        assert_eq!(serde_json::from_value::<HistoryListParams>(value).unwrap(), list);

        let result = HistoryListResult {
            checkpoints: vec![
                Checkpoint { seq: 39, first_seq: 31, time: 1_700_000_000_000, principal_id: Some("p1".into()), changes: 9, kind: CheckpointKind::Changes },
                Checkpoint { seq: 30, first_seq: 30, time: 1_690_000_000_000, principal_id: None, changes: 0, kind: CheckpointKind::Snapshot },
            ],
            more: true,
        };
        let value = serde_json::to_value(&result).unwrap();
        assert_eq!(value["checkpoints"][0]["firstSeq"], 31);
        assert_eq!(value["checkpoints"][0]["principalId"], "p1");
        assert_eq!(value["checkpoints"][1]["kind"], "snapshot");
        assert_eq!(serde_json::from_value::<HistoryListResult>(value).unwrap(), result);

        let get = HistoryGetParams { doc_id: "doc1".into(), seq: 7 };
        assert_eq!(serde_json::to_value(&get).unwrap(), json!({ "docId": "doc1", "seq": 7 }));
        let got = HistoryGetResult { snapshot: Bin(0), seq: 5 };
        assert_eq!(serde_json::from_value::<HistoryGetResult>(serde_json::to_value(&got).unwrap()).unwrap(), got);

        let restore = HistoryRestoreParams { doc_id: "doc1".into(), seq: 7 };
        assert_eq!(serde_json::from_value::<HistoryRestoreParams>(serde_json::to_value(&restore).unwrap()).unwrap(), restore);
        let restored = HistoryRestoreResult { seq: Some(42), restored: 7 };
        assert_eq!(serde_json::to_value(&restored).unwrap(), json!({ "seq": 42, "restored": 7 }));
        assert_eq!(serde_json::from_value::<HistoryRestoreResult>(json!({ "seq": null, "restored": 7 })).unwrap().seq, None);
    }

    #[test]
    fn lease_messages_round_trip_and_use_camel_case() {
        let acquire = LeaseAcquireParams { doc_id: "doc1".into(), scope: "layer-1".into(), ttl: Some(10_000) };
        let value = serde_json::to_value(&acquire).unwrap();
        assert_eq!(value, json!({ "docId": "doc1", "scope": "layer-1", "ttl": 10_000 }));
        assert_eq!(serde_json::from_value::<LeaseAcquireParams>(value).unwrap(), acquire);
        // `ttl` omitted asks for the server's default.
        let default_ttl: LeaseAcquireParams = serde_json::from_value(json!({ "docId": "doc1", "scope": "*" })).unwrap();
        assert_eq!(default_ttl.ttl, None);

        let lease = Lease { scope: "layer-1".into(), principal_id: "p1".into(), name: "Ash".into(), session: "s7".into(), ttl: 9_500 };
        let value = serde_json::to_value(LeaseAcquireResult { lease: lease.clone() }).unwrap();
        assert_eq!(value, json!({ "lease": { "scope": "layer-1", "principalId": "p1", "name": "Ash", "session": "s7", "ttl": 9_500 } }));
        assert_eq!(serde_json::from_value::<LeaseAcquireResult>(value).unwrap().lease, lease);

        let release = LeaseReleaseParams { doc_id: "doc1".into(), scope: "layer-1".into() };
        assert_eq!(serde_json::to_value(&release).unwrap(), json!({ "docId": "doc1", "scope": "layer-1" }));
        assert_eq!(serde_json::to_value(LeaseReleaseResult {}).unwrap(), json!({}));

        let changed = LeaseChangedParams { doc_id: "doc1".into(), leases: vec![lease] };
        let value = serde_json::to_value(&changed).unwrap();
        assert_eq!(value["leases"][0]["principalId"], "p1");
        assert_eq!(serde_json::from_value::<LeaseChangedParams>(value).unwrap(), changed);
    }

    #[test]
    fn member_administration_round_trips_and_uses_camel_case() {
        assert_eq!(serde_json::to_value(Role::Commenter).unwrap(), json!("commenter"));
        assert!(Role::Viewer.rank() < Role::Commenter.rank() && Role::Commenter.rank() < Role::Editor.rank() && Role::Editor.rank() < Role::Owner.rank());
        assert!(Role::Commenter.may_push() && !Role::Commenter.may_edit() && !Role::Viewer.may_push() && Role::Editor.may_edit());

        let list = RoomMembersParams { doc_id: "doc1".into() };
        assert_eq!(serde_json::to_value(&list).unwrap(), json!({ "docId": "doc1" }));
        let result = RoomMembersResult {
            members: vec![Member { principal_id: "p1".into(), name: "Ash".into(), role: Role::Commenter }],
            links: vec![ShareLink { share_link: "https://kition.app/s/abc".into(), role: Role::Viewer, created_by: "p0".into() }],
        };
        let value = serde_json::to_value(&result).unwrap();
        assert_eq!(value["members"][0], json!({ "principalId": "p1", "name": "Ash", "role": "commenter" }));
        assert_eq!(value["links"][0], json!({ "shareLink": "https://kition.app/s/abc", "role": "viewer", "createdBy": "p0" }));
        assert_eq!(serde_json::from_value::<RoomMembersResult>(value).unwrap(), result);

        let set = RoomSetRoleParams { doc_id: "doc1".into(), principal_id: "p1".into(), role: Role::Viewer };
        assert_eq!(serde_json::to_value(&set).unwrap(), json!({ "docId": "doc1", "principalId": "p1", "role": "viewer" }));
        let remove = RoomRemoveMemberParams { doc_id: "doc1".into(), principal_id: "p1".into() };
        assert_eq!(serde_json::to_value(&remove).unwrap(), json!({ "docId": "doc1", "principalId": "p1" }));
        let revoke = RoomRevokeLinkParams { doc_id: "doc1".into(), share_link: "https://kition.app/s/abc".into() };
        assert_eq!(serde_json::to_value(&revoke).unwrap(), json!({ "docId": "doc1", "shareLink": "https://kition.app/s/abc" }));
        assert_eq!(serde_json::to_value(RoomAdminResult {}).unwrap(), json!({}));

        let access = RoomAccessParams { doc_id: "doc1".into(), role: None };
        assert_eq!(serde_json::to_value(&access).unwrap(), json!({ "docId": "doc1", "role": null }));
        assert_eq!(serde_json::from_value::<RoomAccessParams>(json!({ "docId": "doc1", "role": "viewer" })).unwrap().role, Some(Role::Viewer));
    }

    #[test]
    fn scopes_collide_when_equal_or_whole_document() {
        assert!(scopes_collide("a", "a"));
        assert!(!scopes_collide("a", "b"));
        assert!(scopes_collide("*", "b"));
        assert!(scopes_collide("a", "*"));
    }

    #[test]
    fn method_names_match_the_wire_format() {
        assert_eq!(method::SYNC_HELLO, "sync/hello");
        assert_eq!(method::ROOM_JOIN, "room/join");
        assert_eq!(method::CHANGES_PUSH, "changes/push");
        assert_eq!(method::CHANGES_PULL, "changes/pull");
        assert_eq!(method::PRESENCE_SET, "presence/set");
        assert_eq!(method::PRESENCE_UPDATE, "presence/update");
        assert_eq!(method::BLOB_HAS, "blob/has");
        assert_eq!(method::BLOB_PUT, "blob/put");
        assert_eq!(method::BLOB_GET, "blob/get");
        assert_eq!(method::SNAPSHOT_GET, "snapshot/get");
        assert_eq!(method::ROOM_CREATE, "room/create");
        assert_eq!(method::ROOM_OPEN, "room/open");
        assert_eq!(method::ROOM_LINK, "room/link");
        assert_eq!(method::ROOM_LEAVE, "room/leave");
        assert_eq!(method::LEASE_ACQUIRE, "lease/acquire");
        assert_eq!(method::LEASE_RELEASE, "lease/release");
        assert_eq!(method::LEASE_CHANGED, "lease/changed");
        assert_eq!(method::HISTORY_LIST, "history/list");
        assert_eq!(method::HISTORY_GET, "history/get");
        assert_eq!(method::HISTORY_RESTORE, "history/restore");
        assert_eq!(method::ROOM_MEMBERS, "room/members");
        assert_eq!(method::ROOM_SET_ROLE, "room/setRole");
        assert_eq!(method::ROOM_REMOVE_MEMBER, "room/removeMember");
        assert_eq!(method::ROOM_REVOKE_LINK, "room/revokeLink");
        assert_eq!(method::ROOM_ACCESS, "room/access");
        assert_eq!(method::ROOMS_LIST, "rooms/list");
        assert_eq!(method::ROOMS_CHANGED, "rooms/changed");
        assert_eq!(method::ACCOUNT_SETTINGS, "account/settings");
        assert_eq!(method::ACCOUNT_UPDATE, "account/update");
        assert_eq!(method::ACCOUNT_CHANGED, "account/changed");
    }

    #[test]
    fn document_list_and_private_rooms_round_trip_and_use_camel_case() {
        let create: RoomCreateParams =
            serde_json::from_value(json!({ "docId": "d", "snapshot": { "$bin": 0 }, "name": "Slide", "kit": "kit.slide", "private": true })).unwrap();
        assert!(create.private);
        assert_eq!(serde_json::to_value(&create).unwrap()["private"], true);
        let private = RoomCreateResult { share_link: None };
        assert_eq!(serde_json::to_value(&private).unwrap(), json!({ "shareLink": null }));
        assert_eq!(serde_json::from_value::<RoomCreateResult>(json!({ "shareLink": null })).unwrap(), private);

        assert_eq!(serde_json::to_value(RoomsListParams::default()).unwrap(), json!({}));
        let page = RoomsListParams { cursor: Some("c".into()), limit: Some(50) };
        assert_eq!(serde_json::to_value(&page).unwrap(), json!({ "cursor": "c", "limit": 50 }));
        let listing = RoomListing {
            doc_id: "d".into(),
            name: "Slide.kslide".into(),
            kit: "kit.slide".into(),
            role: Role::Owner,
            updated: 1_700_000_000_000,
            size: 4096,
            private: true,
        };
        let value = serde_json::to_value(&listing).unwrap();
        assert_eq!(
            value,
            json!({ "docId": "d", "name": "Slide.kslide", "kit": "kit.slide", "role": "owner", "updated": 1_700_000_000_000_u64, "size": 4096, "private": true })
        );
        let result = RoomsListResult { rooms: vec![listing.clone()], cursor: None };
        assert_eq!(serde_json::to_value(&result).unwrap()["cursor"], Value::Null);
        assert_eq!(serde_json::from_value::<RoomsListResult>(serde_json::to_value(&result).unwrap()).unwrap(), result);
        let changed = RoomsChangedParams { doc_id: "d".into(), room: None };
        assert_eq!(serde_json::to_value(&changed).unwrap(), json!({ "docId": "d", "room": null }));
        let changed = RoomsChangedParams { doc_id: "d".into(), room: Some(listing) };
        assert_eq!(serde_json::from_value::<RoomsChangedParams>(serde_json::to_value(&changed).unwrap()).unwrap(), changed);

        assert_eq!(serde_json::to_value(AccountSettings { sync_all: true }).unwrap(), json!({ "syncAll": true }));
        assert_eq!(serde_json::from_value::<AccountSettings>(json!({})).unwrap(), AccountSettings::default());
        assert_eq!(serde_json::to_value(AccountUpdateParams::default()).unwrap(), json!({}));
        assert_eq!(serde_json::from_value::<AccountUpdateParams>(json!({ "syncAll": false })).unwrap().sync_all, Some(false));
        assert_eq!(serde_json::from_value::<AccountSettingsParams>(json!({})).unwrap(), AccountSettingsParams {});
    }

    #[test]
    fn headless_kit_messages_round_trip_and_use_camel_case() {
        let preview = PreviewGetParams { doc_id: "d".into(), page: Some(2), size: None };
        let value = serde_json::to_value(&preview).unwrap();
        assert_eq!(value, json!({ "docId": "d", "page": 2 }));
        assert_eq!(serde_json::from_value::<PreviewGetParams>(json!({ "docId": "d" })).unwrap().page, None);
        let picture = PreviewGetResult { image: Bin(0), mime_type: "image/png".into(), width: 4, height: 3, seq: 9 };
        assert_eq!(serde_json::to_value(&picture).unwrap(), json!({ "image": { "$bin": 0 }, "mimeType": "image/png", "width": 4, "height": 3, "seq": 9 }));
        let export = ExportGetParams { doc_id: "d".into(), format: Some("pptx".into()) };
        assert_eq!(serde_json::from_value::<ExportGetParams>(serde_json::to_value(&export).unwrap()).unwrap(), export);
        let file = ExportGetResult { data: Bin(0), name: "Slide.pptx".into(), format: "pptx".into(), seq: 9 };
        assert_eq!(serde_json::to_value(&file).unwrap()["name"], "Slide.pptx");
        let run = AgentRunParams { doc_id: "d".into(), batch: json!({ "ops": [] }), prompt: None };
        assert_eq!(serde_json::to_value(&run).unwrap(), json!({ "docId": "d", "batch": { "ops": [] } }));
        let answer = AgentRunResult { seq: None, result: json!({ "results": [] }) };
        assert_eq!(serde_json::from_value::<AgentRunResult>(serde_json::to_value(&answer).unwrap()).unwrap(), answer);
    }

    #[test]
    fn open_scope_and_room_resolve_use_the_wire_names() {
        let result = HelloResult {
            server: ServerInfo { name: "kition-server".into(), version: "0.2.0".into() },
            principal: Principal { id: "t:acme:u1".into(), name: "Ann".into() },
            capabilities: vec![OPEN_ROOMS_CAPABILITY.into(), "KitCollab 1.4".into()],
            open: Some(OpenScope {
                tenant: "acme".into(),
                iss: "one.test".into(),
                file: "res:1".into(),
                doc_key: "k1".into(),
                role: Role::Viewer,
                perms: OpenPerms { download: true, ..OpenPerms::default() },
            }),
        };
        let value = serde_json::to_value(&result).unwrap();
        assert_eq!(
            value["open"],
            json!({ "tenant": "acme", "iss": "one.test", "file": "res:1", "docKey": "k1", "role": "viewer", "perms": { "edit": false, "comment": false, "download": true, "share": false, "export": false } })
        );
        assert_eq!(serde_json::from_value::<HelloResult>(value).unwrap(), result);
        let plain = json!({ "server": { "name": "s", "version": "1" }, "principal": { "id": "p", "name": "P" }, "capabilities": [] });
        assert_eq!(serde_json::from_value::<HelloResult>(plain).unwrap().open, None, "a 1.9 server sends no scope");

        assert_eq!(serde_json::to_value(RoomResolveParams { claim: true }).unwrap(), json!({ "claim": true }));
        assert_eq!(serde_json::to_value(RoomResolveParams::default()).unwrap(), json!({}));
        let resolved: RoomResolveResult = serde_json::from_value(json!({ "docId": null, "claimed": true })).unwrap();
        assert_eq!(resolved, RoomResolveResult { doc_id: None, claimed: true, save: None });
        let conflict: RoomBoundConflict = serde_json::from_value(json!({ "code": "conflict", "docId": "d1" })).unwrap();
        assert_eq!(conflict.doc_id, "d1");
        assert_eq!(serde_json::to_value(RoomResolvedParams { doc_id: "d1".into() }).unwrap(), json!({ "docId": "d1" }));
    }
}
