//! The position ([R9-8]..[R9-10]) and its snapshot ([0001 E1-62]).

use crate::constants::{CUM_PENALTY, FLOOR_SLOTS, NUM_COLORS, NUM_FACTORIES, NUM_ROWS, NUM_TILES,
    TILES_PER_COLOR, WALL_IDX};
use crate::rng::{Seeded, Shuffler};
use crate::score::{wall_completed_colors, wall_completed_cols, wall_completed_rows};
use crate::types::{CanonicalError, Outcome, Player};

/// The lossless snapshot: 0001's data model, every field in the order 0001
/// declares it, and nothing else ([0001 E1-62]). A plain value, not a
/// serialisation.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Canonical {
    /// Per display, per colour.
    pub factories: [[u8; 5]; 5],
    pub center: [u8; 5],
    pub marker_in_center: bool,
    /// Storage order; the last element is drawn first ([0001 E1-32]).
    pub bag: Vec<u8>,
    pub lid: [u8; 5],
    /// Row-major, 0/1 ([0001 E1-2]).
    pub walls: [[u8; 25]; 2],
    /// `-1` when the line is empty ([0001 E1-4]).
    pub pl_color: [[i8; 5]; 2],
    pub pl_count: [[u8; 5]; 2],
    pub floor: [[u8; 5]; 2],
    pub floor_marker: [bool; 2],
    pub scores: [i32; 2],
    pub current_player: Player,
    pub first_player: Player,
    pub round_index: u32,
    pub tiles_left: u8,
    pub shuffles_used: u32,
    pub is_terminal: bool,
    pub exhausted: bool,
}

/// A whole game position. Every field is private to the crate ([R9-8]), the
/// state owns no heap allocation ([R9-9]), and equality compares every field,
/// the cache and the shuffler included ([R9-10]). Deliberately not `Copy`.
#[derive(Clone, Debug, PartialEq)]
pub struct AzulState<S: Shuffler = Seeded> {
    pub(crate) factories: [[u8; 5]; NUM_FACTORIES],
    pub(crate) center: [u8; 5],
    pub(crate) marker_in_center: bool,
    pub(crate) bag: [u8; NUM_TILES],
    pub(crate) bag_len: u8,
    pub(crate) lid: [u8; 5],
    pub(crate) walls: [[u8; 25]; 2],
    pub(crate) pl_color: [[i8; 5]; 2],
    pub(crate) pl_count: [[u8; 5]; 2],
    pub(crate) floor: [[u8; 5]; 2],
    pub(crate) floor_marker: [bool; 2],
    pub(crate) scores: [i32; 2],
    pub(crate) current_player: Player,
    pub(crate) first_player: Player,
    pub(crate) round_index: u32,
    pub(crate) tiles_left: u8,
    pub(crate) shuffles_used: u32,
    pub(crate) is_terminal: bool,
    pub(crate) exhausted: bool,
    /// Derived cache ([0001 E1-60]): bit `r` of `open[p][c]` is set when colour
    /// `c` may still go into `p`'s pattern line `r` ([0001 E1-10]).
    pub(crate) open: [[u8; NUM_COLORS]; 2],
    pub(crate) shuffler: S,
}

/// The largest score a snapshot may carry. Far past anything a game reaches,
/// and far enough below `i32::MAX` that no later arithmetic can overflow ([R9-7]).
const MAX_SCORE: i32 = 1_000_000;

impl AzulState<Seeded> {
    /// `new_game(Seeded::new(seed))`.
    pub fn seeded(seed: u64) -> Self {
        AzulState::new_game(Seeded::new(seed))
    }
}

impl<S: Shuffler> AzulState<S> {
    /// The opening position ([0001 E1-65]): a full bag shuffled once, empty
    /// everything else, player 0 to move, then the first refill.
    pub fn new_game(shuffler: S) -> Self {
        let mut bag = [0u8; NUM_TILES];
        for (i, tile) in bag.iter_mut().enumerate() {
            *tile = (i / TILES_PER_COLOR) as u8;
        }
        let mut s = AzulState {
            factories: [[0; 5]; NUM_FACTORIES],
            center: [0; 5],
            marker_in_center: true,
            bag,
            bag_len: NUM_TILES as u8,
            lid: [0; 5],
            walls: [[0; 25]; 2],
            pl_color: [[-1; 5]; 2],
            pl_count: [[0; 5]; 2],
            floor: [[0; 5]; 2],
            floor_marker: [false; 2],
            scores: [0; 2],
            current_player: Player::P0,
            first_player: Player::P0,
            round_index: 0,
            tiles_left: 0,
            shuffles_used: 0,
            is_terminal: false,
            exhausted: false,
            open: [[0; NUM_COLORS]; 2],
            shuffler,
        };
        s.rebuild_open();
        s.run_shuffle();
        s.refill();
        s
    }

    /// Loads a snapshot. A one-sided inverse of [`AzulState::to_canonical`]:
    /// `from_canonical(c)?.to_canonical() == c` for every snapshot it accepts
    /// ([0001 E1-62]). Loading never shuffles ([0001 E1-61]).
    ///
    /// Refuses, rather than loads, a snapshot no game could hold, so nothing
    /// played from an accepted one can index out of bounds or overflow ([R9-7]).
    pub fn from_canonical(c: &Canonical, shuffler: S) -> Result<Self, CanonicalError> {
        validate(c)?;
        let mut bag = [0u8; NUM_TILES];
        bag[..c.bag.len()].copy_from_slice(&c.bag);
        let mut s = AzulState {
            factories: c.factories,
            center: c.center,
            marker_in_center: c.marker_in_center,
            bag,
            bag_len: c.bag.len() as u8,
            lid: c.lid,
            walls: c.walls,
            pl_color: c.pl_color,
            pl_count: c.pl_count,
            floor: c.floor,
            floor_marker: c.floor_marker,
            scores: c.scores,
            current_player: c.current_player,
            first_player: c.first_player,
            round_index: c.round_index,
            tiles_left: 0,
            shuffles_used: c.shuffles_used,
            is_terminal: c.is_terminal,
            exhausted: c.exhausted,
            open: [[0; NUM_COLORS]; 2],
            shuffler,
        };
        // Derived rather than copied, then held to what the snapshot claims.
        s.tiles_left = s.board_tiles();
        if s.tiles_left != c.tiles_left {
            return Err(CanonicalError::TilesLeftMismatch);
        }
        s.rebuild_open();
        Ok(s)
    }

    /// Every data-model field and nothing else ([0001 E1-62]).
    pub fn to_canonical(&self) -> Canonical {
        Canonical {
            factories: self.factories,
            center: self.center,
            marker_in_center: self.marker_in_center,
            bag: self.bag[..usize::from(self.bag_len)].to_vec(),
            lid: self.lid,
            walls: self.walls,
            pl_color: self.pl_color,
            pl_count: self.pl_count,
            floor: self.floor,
            floor_marker: self.floor_marker,
            scores: self.scores,
            current_player: self.current_player,
            first_player: self.first_player,
            round_index: self.round_index,
            tiles_left: self.tiles_left,
            shuffles_used: self.shuffles_used,
            is_terminal: self.is_terminal,
            exhausted: self.exhausted,
        }
    }

    pub fn current_player(&self) -> Player {
        self.current_player
    }

    pub fn first_player(&self) -> Player {
        self.first_player
    }

    pub fn scores(&self) -> [i32; 2] {
        self.scores
    }

    pub fn round_index(&self) -> u32 {
        self.round_index
    }

    pub fn tiles_left(&self) -> u8 {
        self.tiles_left
    }

    pub fn shuffles_used(&self) -> u32 {
        self.shuffles_used
    }

    pub fn is_terminal(&self) -> bool {
        self.is_terminal
    }

    pub fn exhausted(&self) -> bool {
        self.exhausted
    }

    pub fn shuffler(&self) -> &S {
        &self.shuffler
    }

    /// `None` while the game is unfinished; ties on score break on complete
    /// rows, and still tied is a draw ([0001 E1-39]).
    pub fn outcome(&self) -> Option<Outcome> {
        if !self.is_terminal {
            return None;
        }
        let [s0, s1] = self.scores;
        let decided = |a: i32, b: i32| if a > b { Outcome::Player0 } else { Outcome::Player1 };
        if s0 != s1 {
            return Some(decided(s0, s1));
        }
        let r0 = i32::from(self.completed_rows(Player::P0));
        let r1 = i32::from(self.completed_rows(Player::P1));
        if r0 != r1 {
            return Some(decided(r0, r1));
        }
        Some(Outcome::Draw)
    }

    /// Floor slots in use, marker included ([0001 E1-26]). May exceed seven.
    pub(crate) fn floor_occupied(&self, p: Player) -> u8 {
        let fl = &self.floor[p.index()];
        let tiles: u8 = fl.iter().sum();
        tiles + u8::from(self.floor_marker[p.index()])
    }

    /// The non-positive penalty for `p`'s floor line ([0001 E1-27]).
    pub fn floor_penalty(&self, p: Player) -> i32 {
        CUM_PENALTY[FLOOR_SLOTS.min(usize::from(self.floor_occupied(p)))]
    }

    pub fn completed_rows(&self, p: Player) -> u8 {
        wall_completed_rows(&self.walls[p.index()])
    }

    pub fn completed_cols(&self, p: Player) -> u8 {
        wall_completed_cols(&self.walls[p.index()])
    }

    pub fn completed_colors(&self, p: Player) -> u8 {
        wall_completed_colors(&self.walls[p.index()])
    }

    /// Every tile, wherever it is ([0001 E1-40]).
    pub fn tile_census(&self) -> [u8; 5] {
        census(
            &self.bag[..usize::from(self.bag_len)],
            &self.lid,
            &self.center,
            &self.factories,
            &self.floor,
            &self.pl_color,
            &self.pl_count,
            &self.walls,
        )
    }

    /// Per-colour counts of the bag. Its order is hidden information.
    pub(crate) fn bag_counts(&self) -> [u8; 5] {
        let mut counts = [0u8; 5];
        for &c in &self.bag[..usize::from(self.bag_len)] {
            counts[usize::from(c)] += 1;
        }
        counts
    }

    /// Tiles on the displays and in the centre: what `tiles_left` must equal
    /// ([0001 E1-41]).
    pub(crate) fn board_tiles(&self) -> u8 {
        let mut total: u8 = self.center.iter().sum();
        for f in &self.factories {
            total += f.iter().sum::<u8>();
        }
        total
    }

    /// Recomputes the open-row cache for both players from the board.
    pub(crate) fn rebuild_open(&mut self) {
        for p in 0..2 {
            for c in 0..NUM_COLORS {
                let mut mask = 0u8;
                for r in 0..NUM_ROWS {
                    let n = self.pl_count[p][r];
                    if usize::from(n) <= r
                        && (n == 0 || self.pl_color[p][r] == c as i8)
                        && self.walls[p][WALL_IDX[c][r]] == 0
                    {
                        mask |= 1 << r;
                    }
                }
                self.open[p][c] = mask;
            }
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn census(
    bag: &[u8],
    lid: &[u8; 5],
    center: &[u8; 5],
    factories: &[[u8; 5]; 5],
    floor: &[[u8; 5]; 2],
    pl_color: &[[i8; 5]; 2],
    pl_count: &[[u8; 5]; 2],
    walls: &[[u8; 25]; 2],
) -> [u8; 5] {
    // Summed wide: `from_canonical` calls this before it knows the totals are sane.
    let mut counts = [0u32; 5];
    for &c in bag {
        counts[usize::from(c)] += 1;
    }
    for c in 0..NUM_COLORS {
        counts[c] += u32::from(lid[c]) + u32::from(center[c]);
        for f in factories {
            counts[c] += u32::from(f[c]);
        }
        for fl in floor {
            counts[c] += u32::from(fl[c]);
        }
    }
    for p in 0..2 {
        for r in 0..NUM_ROWS {
            if pl_count[p][r] != 0 {
                counts[pl_color[p][r] as usize] += u32::from(pl_count[p][r]);
            }
        }
        for (c, idx) in WALL_IDX.iter().enumerate() {
            for &i in idx {
                counts[c] += u32::from(walls[p][i] != 0);
            }
        }
    }
    counts.map(|n| n.min(u32::from(u8::MAX)) as u8)
}

/// Everything `from_canonical` refuses. Ranges first, so the census below can
/// index by colour safely.
fn validate(c: &Canonical) -> Result<(), CanonicalError> {
    use CanonicalError::{Inconsistent, OutOfRange};
    let per_colour = TILES_PER_COLOR as u8;
    let cells = c.factories.iter().chain(std::iter::once(&c.center)).chain(std::iter::once(&c.lid))
        .chain(c.floor.iter());
    for pool in cells {
        if pool.iter().any(|&n| n > per_colour) {
            return Err(OutOfRange);
        }
    }
    if c.bag.len() > NUM_TILES || c.bag.iter().any(|&t| usize::from(t) >= NUM_COLORS) {
        return Err(OutOfRange);
    }
    if c.walls.iter().flatten().any(|&cell| cell > 1) {
        return Err(OutOfRange);
    }
    if c.scores.iter().any(|&s| !(0..=MAX_SCORE).contains(&s)) {
        return Err(OutOfRange);
    }
    for p in 0..2 {
        for r in 0..NUM_ROWS {
            let n = c.pl_count[p][r];
            let colour = c.pl_color[p][r];
            if usize::from(n) > r + 1 || !(-1..NUM_COLORS as i8).contains(&colour) {
                return Err(OutOfRange);
            }
            if (n == 0) != (colour == -1) {
                return Err(Inconsistent);
            }
            if n != 0 && c.walls[p][WALL_IDX[colour as usize][r]] != 0 {
                return Err(Inconsistent);
            }
        }
    }
    let markers = usize::from(c.marker_in_center)
        + usize::from(c.floor_marker[0])
        + usize::from(c.floor_marker[1]);
    if markers != 1 {
        return Err(Inconsistent);
    }
    let counts = census(
        &c.bag, &c.lid, &c.center, &c.factories, &c.floor, &c.pl_color, &c.pl_count, &c.walls,
    );
    if counts.iter().any(|&n| n > per_colour) {
        return Err(OutOfRange);
    }
    Ok(())
}
