//! # kition-license
//!
//! [`kition1`]: **the licence of Kition One and Kition Server**, `KITION1.<payload>.<signature>`
//! (docs/platform/licence-format.md), verified offline against public keys compiled in. Nothing
//! else Kition makes is licensed: the kits are free in every form and need no key.
#![no_std]
#![forbid(unsafe_code)]
#![deny(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

extern crate alloc;

pub mod kition1;
