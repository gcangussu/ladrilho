//! Actions, legality, and the ply with everything it triggers
//! ([0001 E1-6] through [0001 E1-38]).

use crate::constants::{
    ACTION_SPACE, CENTER, COLOR_BONUS, COL_BONUS, CUM_PENALTY, FACTORY_SIZE, FLOOR,
    FLOOR_PENALTIES, FLOOR_SLOTS, NUM_COLORS, NUM_FACTORIES, NUM_ROWS, ROW_BONUS, WALL_IDX,
};
use crate::record::{FloorCharge, Placement, PlayerBonuses, PlayerRound, RoundScoring};
use crate::rng::Shuffler;
use crate::score::{
    placement_runs, placement_value, wall_completed_colors, wall_completed_cols,
    wall_completed_rows,
};
use crate::state::AzulState;
use crate::types::{Action, ActionList, IllegalAction, Player, ROW_RUN};

/// `ROW_RUNS[mask]` is the destinations open to a colour whose open pattern
/// rows are the set bits of `mask`: those rows ascending, then the floor, and
/// how many that is.
const ROW_RUNS: [([u8; ROW_RUN], usize); 1 << NUM_ROWS] = row_runs();

const fn row_runs() -> [([u8; ROW_RUN], usize); 1 << NUM_ROWS] {
    let mut out = [([0; ROW_RUN], 0); 1 << NUM_ROWS];
    let mut mask = 0;
    while mask < 1 << NUM_ROWS {
        let mut n = 0;
        let mut r = 0;
        while r < NUM_ROWS {
            if mask >> r & 1 != 0 {
                out[mask].0[n] = r as u8;
                n += 1;
            }
            r += 1;
        }
        out[mask].0[n] = FLOOR;
        out[mask].1 = n + 1;
        mask += 1;
    }
    out
}

/// Tiles per colour, with anything that is not a colour counted in a sixth
/// bucket, so a bag holding one can never compare equal to a lawful one.
fn tile_counts(bag: &[u8]) -> [u8; NUM_COLORS + 1] {
    let mut counts = [0u8; NUM_COLORS + 1];
    for &t in bag {
        counts[usize::from(t).min(NUM_COLORS)] += 1;
    }
    counts
}

/// `source * 30 + color * 6 + dest` ([0001 E1-6]); `None` outside the space.
pub fn encode_action(source: u8, color: u8, dest: u8) -> Option<Action> {
    if source > CENTER || usize::from(color) >= NUM_COLORS || dest > FLOOR {
        return None;
    }
    Some(source * 30 + color * 6 + dest)
}

/// The inverse of [`encode_action`] over `0..180` ([0001 E1-7]); `None` for
/// `180..=255`.
pub fn decode_action(action: Action) -> Option<(u8, u8, u8)> {
    if usize::from(action) >= ACTION_SPACE {
        return None;
    }
    Some((action / 30, action % 30 / 6, action % 6))
}

impl<S: Shuffler> AzulState<S> {
    fn pool(&self, source: u8) -> &[u8; 5] {
        if source == CENTER {
            &self.center
        } else {
            &self.factories[usize::from(source)]
        }
    }

    fn pool_mut(&mut self, source: u8) -> &mut [u8; 5] {
        if source == CENTER {
            &mut self.center
        } else {
            &mut self.factories[usize::from(source)]
        }
    }

    /// Exactly the actions for which [`AzulState::is_legal`] is true, no
    /// duplicates, ascending; empty in a terminal state ([0001 E1-11],
    /// [0001 E1-13]). Built from the open-row cache and a table of ready-made
    /// runs, not by scanning all 180 ([0001 E1-60]).
    pub fn legal_actions(&self) -> ActionList {
        let mut out = ActionList::new();
        if self.is_terminal {
            return out;
        }
        let open = &self.open[self.current_player.index()];
        // Which (source, colour) pairs hold tiles, as bit `source * 5 + colour`,
        // gathered without a branch; then only those pairs are visited, in
        // ascending order, which is ascending action order.
        let mut held = 0u32;
        for source in 0..=CENTER {
            let pool = self.pool(source);
            for (color, &n) in pool.iter().enumerate() {
                held |= u32::from(n != 0) << (usize::from(source) * NUM_COLORS + color);
            }
        }
        let mut len = 0usize;
        while held != 0 {
            let bit = held.trailing_zeros() as u8;
            held &= held - 1;
            let (source, color) = (bit / NUM_COLORS as u8, bit % NUM_COLORS as u8);
            // The open rows ascending, then the floor, which is legal whenever
            // the source holds the colour ([0001 E1-12]). The whole run is
            // written; `len` advances by its real length.
            let (rows, n) = ROW_RUNS[usize::from(open[usize::from(color)])];
            let base = source * 30 + color * 6;
            out.items[len..len + ROW_RUN].copy_from_slice(&rows.map(|r| base + r));
            len += n;
        }
        out.len = len as u8;
        out
    }

    /// Whether the current player may play `action` now ([0001 E1-9],
    /// [0001 E1-10], [0001 E1-11]).
    pub fn is_legal(&self, action: Action) -> bool {
        if self.is_terminal {
            return false;
        }
        let Some((source, color, dest)) = decode_action(action) else {
            return false;
        };
        if self.pool(source)[usize::from(color)] == 0 {
            return false;
        }
        if dest == FLOOR {
            return true;
        }
        self.open[self.current_player.index()][usize::from(color)] >> dest & 1 != 0
    }

    /// Plays one ply, including any round or game transition it triggers
    /// ([0001 E1-21]). An illegal action is refused before anything moves, and
    /// the state is left exactly as it was ([0001 E1-14]).
    pub fn apply(&mut self, action: Action) -> Result<(), IllegalAction> {
        self.ply::<false>(action).map(|_| ())
    }

    /// The same ply, and what round resolution charged: `Some` exactly when
    /// the ply ended a round ([0007 S7-1]). Allocates nothing on a ply that
    /// ends no round ([0007 S7-4]).
    pub fn apply_explained(&mut self, action: Action) -> Result<Option<RoundScoring>, IllegalAction> {
        self.ply::<true>(action)
    }

    /// The one implementation of a ply ([0007 S7-3]). `EXPLAIN` is the only
    /// difference between the two entry points, and it reaches nothing but
    /// round resolution, so the unexplained instantiation compiles the
    /// recording away.
    fn ply<const EXPLAIN: bool>(&mut self, action: Action) -> Result<Option<RoundScoring>, IllegalAction> {
        if !self.is_legal(action) {
            return Err(IllegalAction { action });
        }
        let Some((source, color, dest)) = decode_action(action) else {
            return Err(IllegalAction { action });
        };
        let p = self.current_player;
        let pi = p.index();
        let ci = usize::from(color);

        // Take the tiles: all of the colour leaves the pool ([0001 E1-15]), and
        // the rest of a display goes to the centre ([0001 E1-16]).
        let pool = self.pool_mut(source);
        let count = pool[ci];
        pool[ci] = 0;
        if source == CENTER {
            // Only the first take from the centre each round moves the marker
            // ([0001 E1-17]).
            if self.marker_in_center {
                self.marker_in_center = false;
                self.floor_marker[pi] = true;
            }
        } else {
            let rest = *pool;
            *pool = [0; 5];
            for c in 0..NUM_COLORS {
                self.center[c] += rest[c];
            }
        }
        self.tiles_left -= count;

        // Place them ([0001 E1-18], [0001 E1-19]).
        let overflow = if dest == FLOOR {
            count
        } else {
            let d = usize::from(dest);
            let capacity = dest + 1;
            let room = capacity - self.pl_count[pi][d];
            self.pl_color[pi][d] = color as i8;
            let overflow = if count < room {
                self.pl_count[pi][d] += count;
                0
            } else {
                self.pl_count[pi][d] = capacity;
                count - room
            };
            // Keep the open-row cache current: a full line takes nothing more,
            // and a started one takes only its own colour.
            let bit = !(1u8 << dest);
            for c in 0..NUM_COLORS {
                if c != ci || self.pl_count[pi][d] == capacity {
                    self.open[pi][c] &= bit;
                }
            }
            overflow
        };

        // Overflow fills the floor up to seven occupied slots, marker included;
        // anything past that goes straight to the lid ([0001 E1-20]).
        if overflow != 0 {
            let room = (FLOOR_SLOTS as i32 - i32::from(self.floor_occupied(p))).max(0) as u8;
            let kept = overflow.min(room);
            self.floor[pi][ci] += kept;
            self.lid[ci] += overflow - kept;
        }

        if self.tiles_left != 0 {
            self.current_player = p.other();
            return Ok(None);
        }
        Ok(self.end_round::<EXPLAIN>(p))
    }

    /// The one place randomness enters ([0001 E1-47]): the seam, with the
    /// state's `shuffles_used` as the index, then the increment ([R9-12]).
    ///
    /// A shuffler is the caller's code. One that returns anything but a
    /// reordering of the tiles it was handed has that call undone: the bag
    /// keeps the order it had, and the counter still advances. A broken
    /// shuffler therefore deals a lawful, unshuffled game rather than a panic
    /// ([R9-7]).
    ///
    /// The counter saturates rather than wrapping at `u32::MAX`, a value only
    /// a loaded snapshot can carry; past it the index repeats.
    pub(crate) fn run_shuffle(&mut self) {
        let len = usize::from(self.bag_len);
        let before = self.bag;
        self.shuffler.shuffle(&mut self.bag[..len], self.shuffles_used);
        if tile_counts(&before[..len]) != tile_counts(&self.bag[..len]) {
            self.bag = before;
        }
        self.shuffles_used = self.shuffles_used.saturating_add(1);
    }

    /// Deals four tiles to each display in order, drawing from the end of the
    /// bag ([0001 E1-32]). A draw that *finds* the bag empty recycles the lid
    /// and shuffles; with the lid empty too nothing is shuffled and dealing
    /// stops ([0001 E1-33], [0001 E1-34]).
    pub(crate) fn refill(&mut self) {
        let mut dealt = 0u8;
        for f in 0..NUM_FACTORIES {
            for _ in 0..FACTORY_SIZE {
                if self.bag_len == 0 {
                    for c in 0..NUM_COLORS {
                        for _ in 0..self.lid[c] {
                            self.bag[usize::from(self.bag_len)] = c as u8;
                            self.bag_len += 1;
                        }
                        self.lid[c] = 0;
                    }
                    if self.bag_len == 0 {
                        self.tiles_left = dealt;
                        return;
                    }
                    self.run_shuffle();
                }
                self.bag_len -= 1;
                // Cleared as it is drawn, so the unused tail of the array is
                // always zero and two equal positions compare equal ([R9-10]).
                let tile = std::mem::take(&mut self.bag[usize::from(self.bag_len)]);
                self.factories[f][usize::from(tile)] += 1;
                dealt += 1;
            }
        }
        self.tiles_left = dealt;
    }

    /// Wall-tiling for one player, rows `0..4`, each scoring against the tiles
    /// earlier rows just placed ([0001 E1-22] through [0001 E1-25]). Returns
    /// the gain; each placement is recorded as it is charged when `EXPLAIN`.
    fn tile_wall<const EXPLAIN: bool>(&mut self, p: Player, sink: &mut Vec<Placement>) -> i32 {
        let pi = p.index();
        let mut gain = 0;
        for r in 0..NUM_ROWS {
            if usize::from(self.pl_count[pi][r]) != r + 1 {
                continue; // a partial line waits for the next round
            }
            let c = self.pl_color[pi][r] as usize;
            let idx = WALL_IDX[c][r];
            let col = idx - r * 5;
            let points = placement_value(&self.walls[pi], r, col); // scored before placed
            gain += points;
            if EXPLAIN {
                let (h, v) = placement_runs(&self.walls[pi], r, col);
                sink.push(Placement { row: r as u8, col: col as u8, h, v, points });
            }
            self.walls[pi][idx] = 1;
            self.lid[c] += r as u8; // the tiles of the line that did not go on the wall
            self.pl_color[pi][r] = -1;
            self.pl_count[pi][r] = 0;
        }
        gain
    }

    /// One player's tiling, floor charge and clamped round score
    /// ([0001 E1-22] through [0001 E1-29]). Every number in the record is read
    /// here, where it is charged ([0007 S7-14], [0007 S7-18]).
    fn resolve_player<const EXPLAIN: bool>(&mut self, p: Player) -> Option<PlayerRound> {
        let pi = p.index();
        let mut placements = Vec::new(); // allocates only when pushed to, so only when EXPLAIN
        let tiling = self.tile_wall::<EXPLAIN>(p, &mut placements);
        let occupied = self.floor_occupied(p);
        let marker_held = self.floor_marker[pi];
        let charged_slots = FLOOR_SLOTS.min(usize::from(occupied));
        let penalty = CUM_PENALTY[charged_slots];
        for c in 0..NUM_COLORS {
            self.lid[c] += self.floor[pi][c];
            self.floor[pi][c] = 0;
        }
        // Clamped per round, so a penalty never carries a debt forward ([0001 E1-28]).
        let score_before = self.scores[pi];
        let charged = score_before + tiling + penalty;
        self.scores[pi] = charged.max(0);
        if !EXPLAIN {
            return None;
        }
        Some(PlayerRound {
            placements,
            tiling,
            floor: FloorCharge {
                occupied,
                rungs: &FLOOR_PENALTIES[..charged_slots],
                marker_held,
                penalty,
            },
            score_before,
            score_after_round: self.scores[pi],
            forgiven: self.scores[pi] - charged,
        })
    }

    /// End-of-game bonuses, added unclamped ([0001 E1-38]).
    fn finish_game<const EXPLAIN: bool>(&mut self) -> Option<[PlayerBonuses; 2]> {
        let mut out = [Player::P0, Player::P1].map(|p| {
            let wall = &self.walls[p.index()];
            let rows = wall_completed_rows(wall);
            let cols = wall_completed_cols(wall);
            let colors = wall_completed_colors(wall);
            let row_points = ROW_BONUS * i32::from(rows);
            let col_points = COL_BONUS * i32::from(cols);
            let color_points = COLOR_BONUS * i32::from(colors);
            let total = row_points + col_points + color_points;
            let score_before = self.scores[p.index()];
            PlayerBonuses {
                rows,
                cols,
                colors,
                row_points,
                col_points,
                color_points,
                total,
                score_before,
                score_after: score_before + total,
            }
        });
        for (p, b) in out.iter_mut().enumerate() {
            self.scores[p] = b.score_after;
        }
        self.is_terminal = true;
        if EXPLAIN { Some(out) } else { None }
    }

    /// Everything that happens once the board empties ([0001 E1-22] through
    /// [0001 E1-37]): both players tile and score, player 0 first; the marker
    /// goes back; then the game ends or the next round is dealt.
    fn end_round<const EXPLAIN: bool>(&mut self, last_mover: Player) -> Option<RoundScoring> {
        // The round that is ending, read before anything moves ([0007 S7-13]).
        let round = self.round_index;
        let first = self.resolve_player::<EXPLAIN>(Player::P0);
        let second = self.resolve_player::<EXPLAIN>(Player::P1);
        self.rebuild_open();

        // The holder gives the marker up and starts the next round
        // ([0001 E1-30]); nobody took it, so alternation decides ([0001 E1-31]).
        let mut holder = last_mover.other();
        for p in [Player::P0, Player::P1] {
            if self.floor_marker[p.index()] {
                self.floor_marker[p.index()] = false;
                holder = p;
            }
        }
        self.marker_in_center = true;
        self.first_player = holder;
        self.current_player = holder;

        // The handoff runs before this check ([0001 E1-66]).
        let any_row = self.walls.iter().any(|w| wall_completed_rows(w) > 0);
        let bonuses = if any_row {
            self.finish_game::<EXPLAIN>() // [0001 E1-36]
        } else {
            self.round_index = self.round_index.saturating_add(1); // [0001 E1-35]
            self.refill();
            if self.tiles_left == 0 {
                self.exhausted = true; // [0001 E1-37]
                self.finish_game::<EXPLAIN>()
            } else {
                None
            }
        };

        match (first, second) {
            (Some(a), Some(b)) => Some(RoundScoring { round, players: [a, b], bonuses }),
            _ => None,
        }
    }
}
