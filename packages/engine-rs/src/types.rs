//! The small value types of the public surface ([R9-14]).

use crate::constants::ACTION_SPACE;

/// An encoded action, `source * 30 + color * 6 + dest` ([0001 E1-6]). Values
/// `180..=255` are representable and never legal.
pub type Action = u8;

/// A seat. A type rather than an integer, so a third seat cannot be named ([R9-7]).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Player {
    P0 = 0,
    P1 = 1,
}

impl Player {
    /// The seat as an array index, `0` or `1`.
    pub fn index(self) -> usize {
        self as usize
    }

    /// The other seat.
    pub fn other(self) -> Player {
        match self {
            Player::P0 => Player::P1,
            Player::P1 => Player::P0,
        }
    }
}

/// The result of a finished game ([0001 E1-39]). The discriminants are 0001's
/// `+1 / 0 / -1`, which is also what a vector's `final.outcome` records.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Outcome {
    Player0 = 1,
    Draw = 0,
    Player1 = -1,
}

/// An action that is out of range or not legal in the position it was played
/// in. The state it was offered to is unchanged ([0001 E1-14]).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct IllegalAction {
    pub action: Action,
}

/// Why `from_canonical` refused a snapshot ([0001 E1-62]).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CanonicalError {
    /// `tiles_left` disagrees with the board it describes ([0001 E1-41]).
    TilesLeftMismatch,
    /// A value outside what the board can hold: a colour past 4, a bag past
    /// 100 tiles, more than 20 tiles of a colour, a score out of bounds.
    OutOfRange,
    /// Values each in range that no position can hold together: a marker in
    /// two places, a pattern line with a count and no colour, a line holding a
    /// colour its wall row already has.
    Inconsistent,
}

/// Room past the last action for one whole run of [`ROW_RUN`] to be written
/// before its length is known.
pub(crate) const SLACK: usize = ROW_RUN - 1;

/// The most actions one (source, colour) pair can contribute: five rows and
/// the floor.
pub(crate) const ROW_RUN: usize = 6;

/// The legal actions of a position, ascending ([0001 E1-13]), held inline so
/// building one never allocates ([R9-17]). Entries past `len` are unspecified.
#[derive(Clone, Debug)]
pub struct ActionList {
    pub(crate) len: u8,
    pub(crate) items: [Action; ACTION_SPACE + SLACK],
}

impl ActionList {
    pub(crate) const fn new() -> Self {
        ActionList { len: 0, items: [0; ACTION_SPACE + SLACK] }
    }

    pub fn as_slice(&self) -> &[Action] {
        &self.items[..usize::from(self.len)]
    }

    pub fn len(&self) -> usize {
        usize::from(self.len)
    }

    pub fn is_empty(&self) -> bool {
        self.len == 0
    }
}
