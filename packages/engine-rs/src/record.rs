//! The round-scoring record of 0007, field for field, in `snake_case`.
//!
//! An event, not a position: nothing here is part of a snapshot
//! ([0007 S7-6]), the engine retains none ([0007 S7-7]), and every value is
//! owned, so a caller may keep one for as long as it likes ([0007 S7-8]).

/// What one tile earned when it was placed ([0007 S7-9]..[0007 S7-11]).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Placement {
    /// Pattern-line row, `0..4`; also the wall row.
    pub row: u8,
    /// Wall column, `0..4`.
    pub col: u8,
    /// Horizontal run through the new tile, itself included.
    pub h: u8,
    /// Vertical run through the new tile, itself included.
    pub v: u8,
    /// What was charged: `placement_value(wall, row, col)`.
    pub points: i32,
}

/// What the floor line cost, by slot ([0007 S7-14]..[0007 S7-16]).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FloorCharge {
    /// Occupied slots at the moment of charging. May exceed `FLOOR_SLOTS`.
    pub occupied: u8,
    /// The rungs charged: a prefix of `FLOOR_PENALTIES`, borrowed, never copied.
    pub rungs: &'static [i32],
    /// Did this player hold the marker, captured before the handoff clears it.
    pub marker_held: bool,
    /// The non-positive number charged: `CUM_PENALTY[min(FLOOR_SLOTS, occupied)]`.
    pub penalty: i32,
}

/// One player's round ([0007 S7-17], [0007 S7-18]).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PlayerRound {
    /// In resolution order, rows `0..4`.
    pub placements: Vec<Placement>,
    /// The accumulator's value: what wall-tiling charged.
    pub tiling: i32,
    pub floor: FloorCharge,
    pub score_before: i32,
    /// The score after the clamp, before any bonus.
    pub score_after_round: i32,
    /// `>= 0`; what the clamp did not take.
    pub forgiven: i32,
}

/// One player's end-of-game bonuses ([0007 S7-19], [0007 S7-22]).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PlayerBonuses {
    pub rows: u8,
    pub cols: u8,
    pub colors: u8,
    pub row_points: i32,
    pub col_points: i32,
    pub color_points: i32,
    /// `row_points + col_points + color_points`, charged unclamped.
    pub total: i32,
    /// Equal to this player's `score_after_round`.
    pub score_before: i32,
    /// The final score. Nothing is added after this.
    pub score_after: i32,
}

/// One round resolution ([0007 S7-1]).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RoundScoring {
    /// The index of the round that just ended, captured on entry ([0007 S7-13]).
    pub round: u32,
    /// By seat, `[player 0, player 1]`.
    pub players: [PlayerRound; 2],
    /// `Some` if and only if the game ended on this ply ([0007 S7-20]).
    pub bonuses: Option<[PlayerBonuses; 2]>,
}
