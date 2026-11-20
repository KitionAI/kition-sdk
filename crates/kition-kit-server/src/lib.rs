//! # kition-kit-server
//!
//! The kit side of the Kition Kit Process Protocol, version 1: the host launches the kit executable with
//! `--kition-kit` and four `KITION_KIT_*` environment variables, the kit listens on a local socket
//! (a named pipe on Windows), prints one ready line, and serves newline-delimited JSON-RPC 2.0. The
//! host connection is two-way: the kit reads and writes files only through the host's `files.*`,
//! by handle ([`Host`]).
//!
//! The protocol itself (message types, error codes, framing, the transport, launch constants) is
//! `kition-kit-process-protocol`, the one definition hosts share, re-exported here as [`protocol`]. This
//! crate adds the kit's side of it (tokens, the `host` and `agent` roles, requests to the host, and
//! change notifications) and hands documents and commands to a [`KitBackend`].
//!
//! The protocol specification is the Kition platform's `docs/platform/reference/kit-process-protocol.md`; the Kition
//! conformance suite (`kition-kit-conformance`) checks a kit built on this crate.
#![forbid(unsafe_code)]
#![deny(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::unimplemented, clippy::todo, clippy::unreachable)]

pub mod backend;
pub mod identity;
mod reply;
mod server;

pub use backend::{
    CommandSummary, Describe, DocumentInfo, Executed, FileBytes, Host, HostCall, KitBackend, MODEL_FEATURES, Notifier, OpenRequest, Screenshot,
    ScreenshotRequest, Written, with_model_features,
};
pub use identity::{EmbeddedReplica, FileIdentity};
pub use kition_kit_process_protocol as protocol;
pub use protocol::launch::LAUNCH_ARG;
pub use protocol::{ErrorReason, PROTOCOL_VERSION, RpcError};
pub use server::{LaunchConfig, LaunchError, serve};
