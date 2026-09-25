//! The observation vector ([0001 E1-53] through [0001 E1-67]), 0001's layout
//! unchanged.
//!
//! Every value is computed in `f64` and rounded to `f32` once, on store —
//! which is what the TypeScript engine's `Float32Array` does, and what makes
//! each value bit-equal to the oracle's recording ([0002 V2-38]).

use crate::constants::{FACTORY_SIZE, FLOOR_SLOTS, NUM_COLORS, NUM_FACTORIES, NUM_ROWS, TILES_PER_COLOR};
use crate::rng::Shuffler;
use crate::state::AzulState;
use crate::types::Player;

pub const OFF_MY_WALL: usize = 0;
pub const OFF_OP_WALL: usize = 25;
pub const OFF_MY_LINES: usize = 50;
pub const OFF_OP_LINES: usize = 80;
pub const OFF_MY_FLOOR: usize = 110;
pub const OFF_OP_FLOOR: usize = 117;
pub const OFF_SCORES: usize = 124;
pub const OFF_FACTORIES: usize = 126;
pub const OFF_FACTORY_FLAGS: usize = 151;
pub const OFF_CENTER: usize = 156;
pub const OFF_CENTER_TOTAL: usize = 161;
pub const OFF_MARKER_CENTER: usize = 162;
pub const OFF_BAG: usize = 163;
pub const OFF_LID: usize = 168;
pub const OFF_TILES_LEFT: usize = 173;
pub const OFF_I_START: usize = 174;
pub const OFF_ROUND: usize = 175;
pub const OFF_MY_SETS: usize = 176;
pub const OFF_OP_SETS: usize = 179;
pub const ENCODED_SIZE: usize = 182;

fn ratio(n: impl Into<f64>, d: f64) -> f32 {
    (n.into() / d) as f32
}

impl<S: Shuffler> AzulState<S> {
    /// The vector from the seat to move: `encode_for(current_player())` ([0001 E1-67]).
    pub fn encode(&self) -> [f32; ENCODED_SIZE] {
        self.encode_for(self.current_player)
    }

    /// The vector as seat `p` sees it: "me" is `p`, "them" the other seat
    /// ([0001 E1-67]). Divisors are scaling constants, not clamps; only the
    /// floor slots and the round index are clamped ([0001 E1-56]).
    pub fn encode_for(&self, p: Player) -> [f32; ENCODED_SIZE] {
        let mut v = [0f32; ENCODED_SIZE];
        let me = p.index();
        let them = p.other().index();

        for i in 0..25 {
            v[OFF_MY_WALL + i] = f32::from(self.walls[me][i]);
            v[OFF_OP_WALL + i] = f32::from(self.walls[them][i]);
        }

        // An empty pattern line contributes all zeros ([0001 E1-54]).
        for (off, q) in [(OFF_MY_LINES, me), (OFF_OP_LINES, them)] {
            for r in 0..NUM_ROWS {
                let n = self.pl_count[q][r];
                if n != 0 {
                    let base = off + r * 6;
                    v[base + self.pl_color[q][r] as usize] = 1.0;
                    v[base + 5] = ratio(n, (r + 1) as f64);
                }
            }
        }

        for (off, q) in [(OFF_MY_FLOOR, p), (OFF_OP_FLOOR, p.other())] {
            let qi = q.index();
            for c in 0..NUM_COLORS {
                v[off + c] = ratio(self.floor[qi][c], FLOOR_SLOTS as f64);
            }
            let occupied = FLOOR_SLOTS.min(usize::from(self.floor_occupied(q)));
            v[off + 5] = ratio(occupied as u32, FLOOR_SLOTS as f64);
            v[off + 6] = f32::from(u8::from(self.floor_marker[qi]));
        }

        v[OFF_SCORES] = ratio(self.scores[me], 100.0);
        v[OFF_SCORES + 1] = ratio(self.scores[them], 100.0);

        for i in 0..NUM_FACTORIES {
            let base = OFF_FACTORIES + i * 5;
            let mut total = 0u32;
            for c in 0..NUM_COLORS {
                let n = self.factories[i][c];
                v[base + c] = ratio(n, FACTORY_SIZE as f64);
                total += u32::from(n);
            }
            if total != 0 {
                v[OFF_FACTORY_FLAGS + i] = 1.0;
            }
        }

        let mut center_total = 0u32;
        for c in 0..NUM_COLORS {
            let n = self.center[c];
            v[OFF_CENTER + c] = ratio(n, 10.0);
            center_total += u32::from(n);
        }
        v[OFF_CENTER_TOTAL] = ratio(center_total, 20.0);
        v[OFF_MARKER_CENTER] = f32::from(u8::from(self.marker_in_center));

        // Bag and lid counts are public; the bag's order is not encoded ([0001 E1-55]).
        let bag = self.bag_counts();
        for c in 0..NUM_COLORS {
            v[OFF_BAG + c] = ratio(bag[c], TILES_PER_COLOR as f64);
            v[OFF_LID + c] = ratio(self.lid[c], TILES_PER_COLOR as f64);
        }

        v[OFF_TILES_LEFT] = ratio(self.tiles_left, 20.0);
        // A disjunction: the marker holder *and* whoever started this round
        // ([0001 E1-63]).
        v[OFF_I_START] = f32::from(u8::from(self.floor_marker[me] || self.first_player == p));
        v[OFF_ROUND] = ratio(self.round_index.min(10), 10.0);

        for (off, q) in [(OFF_MY_SETS, p), (OFF_OP_SETS, p.other())] {
            v[off] = ratio(self.completed_rows(q), 5.0);
            v[off + 1] = ratio(self.completed_cols(q), 5.0);
            v[off + 2] = ratio(self.completed_colors(q), 5.0);
        }
        v
    }
}
