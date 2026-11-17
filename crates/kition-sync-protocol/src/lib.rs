//! # kition-sync-protocol
//!
//! The open sync protocol, `kition-sync/1`: JSON-RPC 2.0 over a WebSocket. Text frames carry a
//! JSON message; binary payloads (KDM change bytes, snapshots, blobs) travel as separate binary
//! frames the message's own JSON references by index, so a change set never needs to be copied
//! into a JSON string.
//!
//! - [`bin`]: `Bin`, the `{"$bin": n}` index a message uses in place of bytes.
//! - [`framing`]: turns a message and its bytes into the frames a transport sends, and turns an
//!   incoming stream of frames back into messages, with limits a hostile or broken peer cannot
//!   exceed.
//! - [`protocol`]: the JSON-RPC envelope (`RequestId`, `RpcError`, `Message`) and its parsing.
//! - [`messages`]: every `kition-sync/1` method's params and result types.
//! - [`save`]: the save state machine of a co-edited room (protocol 1.10) and its messages.
//!
//! This crate carries no server or client logic and depends on nothing in the Kition workspace:
//! a server and a client each build their own behavior on these types.
#![forbid(unsafe_code)]
#![deny(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::unimplemented, clippy::todo, clippy::unreachable)]

pub mod bin;
pub mod framing;
pub mod messages;
pub mod protocol;
pub mod save;

pub use bin::Bin;

/// The protocol identifier a client sends in `sync/hello`.
pub const PROTOCOL: &str = "kition-sync/1";
