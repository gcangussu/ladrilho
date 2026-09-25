//! Board constants and the fixed wall geometry: 0001's, under the same names
//! and values ([R9-14]). Everything here is `const`, so no state is shared
//! between positions ([0001 E1-51]).

/// Colours are `0..4` = blue, yellow, red, black, teal.
pub const NUM_COLORS: usize = 5;
pub const TILES_PER_COLOR: usize = 20;
pub const NUM_TILES: usize = NUM_COLORS * TILES_PER_COLOR;
/// The two-player factory count.
pub const NUM_FACTORIES: usize = 5;
pub const FACTORY_SIZE: usize = 4;
pub const NUM_ROWS: usize = 5;

/// Action `source` value meaning "the centre pool" ([0001 E1-6]).
pub const CENTER: u8 = 5;
/// Action `dest` value meaning "the floor line" ([0001 E1-6]).
pub const FLOOR: u8 = 5;
/// `source (6) * color (5) * dest (6)` ([0001 E1-6]).
pub const ACTION_SPACE: usize = 180;

pub const FLOOR_PENALTIES: [i32; 7] = [-1, -1, -2, -2, -2, -3, -3];
pub const FLOOR_SLOTS: usize = FLOOR_PENALTIES.len();

/// `CUM_PENALTY[n]` is the penalty for `n` occupied floor slots, `n` in `0..=7`
/// ([0001 E1-27]). Slots past the seventh cost nothing, so callers clamp the index.
pub const CUM_PENALTY: [i32; FLOOR_SLOTS + 1] = cumulative_penalties();

const fn cumulative_penalties() -> [i32; FLOOR_SLOTS + 1] {
    let mut out = [0; FLOOR_SLOTS + 1];
    let mut i = 0;
    while i < FLOOR_SLOTS {
        out[i + 1] = out[i] + FLOOR_PENALTIES[i];
        i += 1;
    }
    out
}

pub const ROW_BONUS: i32 = 2;
pub const COL_BONUS: i32 = 7;
pub const COLOR_BONUS: i32 = 10;

/// Wall column of `color` in `row` on the standard fixed wall ([0001 E1-1]).
/// Total over every `u8`: the arithmetic is widened, so it cannot overflow ([R9-7]).
pub fn wall_col(color: u8, row: u8) -> u8 {
    ((u16::from(color) + u16::from(row)) % 5) as u8
}

/// Colour of the wall cell at `(row, col)`, the inverse of [`wall_col`] ([0001 E1-1]).
pub fn wall_color_at(row: u8, col: u8) -> u8 {
    (i16::from(col) - i16::from(row)).rem_euclid(5) as u8
}

/// `WALL_IDX[color][row]` is the row-major index of that colour's cell in that
/// row ([0001 E1-1], [0001 E1-2]).
pub(crate) const WALL_IDX: [[usize; NUM_ROWS]; NUM_COLORS] = wall_index();

const fn wall_index() -> [[usize; NUM_ROWS]; NUM_COLORS] {
    let mut out = [[0; NUM_ROWS]; NUM_COLORS];
    let mut c = 0;
    while c < NUM_COLORS {
        let mut r = 0;
        while r < NUM_ROWS {
            out[c][r] = r * 5 + (c + r) % NUM_COLORS;
            r += 1;
        }
        c += 1;
    }
    out
}
