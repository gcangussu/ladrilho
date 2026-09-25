//! The rules that are questions about a **wall** rather than a state: what a
//! placed tile scores ([0001 E1-68]) and what a wall has completed
//! ([0001 E1-70]). Round scoring and the per-player accessors call these, so
//! each rule has exactly one implementation. Nothing here allocates ([R9-17]).

use crate::constants::{NUM_COLORS, NUM_ROWS, WALL_IDX};

/// Length of the horizontal run through `(row, col)`, the new tile included.
fn horizontal_run(wall: &[u8; 25], row: usize, col: usize) -> u8 {
    let base = row * 5;
    let mut run = 1;
    let mut i = col;
    while i > 0 && wall[base + i - 1] != 0 {
        run += 1;
        i -= 1;
    }
    let mut i = col + 1;
    while i < 5 && wall[base + i] != 0 {
        run += 1;
        i += 1;
    }
    run
}

/// Length of the vertical run through `(row, col)`, the new tile included.
fn vertical_run(wall: &[u8; 25], row: usize, col: usize) -> u8 {
    let mut run = 1;
    let mut i = row;
    while i > 0 && wall[(i - 1) * 5 + col] != 0 {
        run += 1;
        i -= 1;
    }
    let mut i = row + 1;
    while i < 5 && wall[i * 5 + col] != 0 {
        run += 1;
        i += 1;
    }
    run
}

/// What a tile placed at `(row, col)` scores ([0001 E1-24], [0001 E1-68]): the
/// horizontal run plus the vertical run where either exceeds one, and 1 for a
/// tile that lands alone.
///
/// The cell at `(row, col)` itself is never read, so the answer is the same
/// whether the caller has set it yet or not. A cell off the wall scores 0,
/// which keeps the function total ([R9-7]).
pub fn placement_value(wall: &[u8; 25], row: usize, col: usize) -> i32 {
    if row >= NUM_ROWS || col >= 5 {
        return 0;
    }
    let h = i32::from(horizontal_run(wall, row, col));
    let v = i32::from(vertical_run(wall, row, col));
    if h > 1 || v > 1 {
        (if h > 1 { h } else { 0 }) + (if v > 1 { v } else { 0 })
    } else {
        1
    }
}

/// The two runs through `(row, col)` for the round-scoring record
/// ([0007 S7-11]). Private, and it stops at the two scans: combining them is
/// the fusion rule, whose one implementation is [`placement_value`]'s
/// ([0007 S7-12]).
pub(crate) fn placement_runs(wall: &[u8; 25], row: usize, col: usize) -> (u8, u8) {
    (horizontal_run(wall, row, col), vertical_run(wall, row, col))
}

/// Complete rows on `wall` ([0001 E1-70]).
pub fn wall_completed_rows(wall: &[u8; 25]) -> u8 {
    let mut n = 0;
    for r in 0..NUM_ROWS {
        if wall[r * 5..r * 5 + 5].iter().all(|&cell| cell != 0) {
            n += 1;
        }
    }
    n
}

/// Complete columns on `wall` ([0001 E1-70]).
pub fn wall_completed_cols(wall: &[u8; 25]) -> u8 {
    let mut n = 0;
    for col in 0..5 {
        if (0..NUM_ROWS).all(|r| wall[r * 5 + col] != 0) {
            n += 1;
        }
    }
    n
}

/// Colours placed in all five rows of `wall` ([0001 E1-70]).
pub fn wall_completed_colors(wall: &[u8; 25]) -> u8 {
    let mut n = 0;
    for idx in WALL_IDX.iter().take(NUM_COLORS) {
        if idx.iter().all(|&i| wall[i] != 0) {
            n += 1;
        }
    }
    n
}
