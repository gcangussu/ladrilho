//! Deterministic two-player Azul rules engine, in Rust.
//!
//! A second implementation of the rules of spec 0001, held to the same
//! conformance vectors as the TypeScript engine. What applies from 0001, 0002
//! and 0007, and how each reads in Rust, is spec 0009's *Adopted requirements*
//! table; this crate does not restate the rules.
//!
//! Synchronous throughout ([R9-4]): a ply is a bounded computation over a few
//! hundred bytes, so there is nothing to wait on. Callers who want parallelism
//! run owned states on `std::thread` ([R9-5]).

#![forbid(unsafe_code)]
// The board is parallel fixed arrays indexed by row, colour and seat — a line's
// count and colour, a wall cell, a pool — and a loop over the index says so
// more plainly than zipped iterators over five of them.
#![allow(clippy::needless_range_loop)]

mod apply;
mod constants;
mod observe;
mod record;
mod rng;
mod score;
mod state;
mod types;

pub use apply::{decode_action, encode_action};
pub use constants::{
    ACTION_SPACE, CENTER, COLOR_BONUS, COL_BONUS, CUM_PENALTY, FACTORY_SIZE, FLOOR,
    FLOOR_PENALTIES, FLOOR_SLOTS, NUM_COLORS, NUM_FACTORIES, NUM_ROWS, NUM_TILES, ROW_BONUS,
    TILES_PER_COLOR, wall_col, wall_color_at,
};
pub use observe::{
    ENCODED_SIZE, OFF_BAG, OFF_CENTER, OFF_CENTER_TOTAL, OFF_FACTORIES, OFF_FACTORY_FLAGS,
    OFF_I_START, OFF_LID, OFF_MARKER_CENTER, OFF_MY_FLOOR, OFF_MY_LINES, OFF_MY_SETS, OFF_MY_WALL,
    OFF_OP_FLOOR, OFF_OP_LINES, OFF_OP_SETS, OFF_OP_WALL, OFF_ROUND, OFF_SCORES, OFF_TILES_LEFT,
};
pub use record::{FloorCharge, Placement, PlayerBonuses, PlayerRound, RoundScoring};
pub use rng::{Seeded, Shuffler};
pub use score::{placement_value, wall_completed_colors, wall_completed_cols, wall_completed_rows};
pub use state::{AzulState, Canonical};
pub use types::{Action, ActionList, CanonicalError, IllegalAction, Outcome, Player};

/// [R9-5]: the types a caller moves between threads are `Send + Sync`,
/// checked when the crate compiles.
const _: () = {
    const fn assert_send_sync<T: Send + Sync>() {}
    assert_send_sync::<AzulState<Seeded>>();
    assert_send_sync::<Canonical>();
    assert_send_sync::<RoundScoring>();
    assert_send_sync::<IllegalAction>();
};
