//! An Azul player trained from scratch by self-play on `azul_engine`
//! (spec 0011).
//!
//! The Rust half: the network's forward pass, the search, self-play, and the
//! file formats the Python trainer and the TypeScript lanes read. Synchronous
//! throughout ([0009 R9-4]); self-play's threads are `std::thread`.
//!
//! Nothing in this library reads a clock ([Z11-18]): a search runs exactly its
//! simulations and is never curtailed. The binary times `choose` from outside.

#![forbid(unsafe_code)]
#![allow(clippy::needless_range_loop)]

pub mod config;
pub mod network;
pub mod parity;
pub mod rng;
pub mod samples;
pub mod search;
pub mod selfplay;
pub mod view;
pub mod wire;

pub use network::{Evaluation, Evaluator, LoadError, Network};
pub use search::{SearchConfig, SearchResult, SelfPlayNoise, TreeStats, choose, search};
pub use view::pre_deal_view;

/// The network is shared by reference across self-play's threads.
const _: () = {
    const fn assert_send_sync<T: Send + Sync>() {}
    assert_send_sync::<Network>();
};
