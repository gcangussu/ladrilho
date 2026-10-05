//! The endgame proof ([Z11-76]): after the search has chosen, a node-capped
//! alpha-beta over the rest of the round may replace its move with one of
//! provably better result.
//!
//! Nothing is dealt until a round ends, so the rest of a round is a game of
//! perfect information, and a line that ends the game at the round's end has
//! an exact result. A line that goes on into another round meets the bag and
//! has none: the proof scores it as the worst case for the claim being proved
//! (worse than a loss when proving a move good, better than a win when proving
//! it bad), so a proof never depends on what is dealt, and never reads it
//! ([Z11-15]): the search stops at the first state of a new round without
//! looking at it.
//!
//! The search's tree, visits and value are untouched; only the action can
//! change, and only to a move whose result is proven strictly better than the
//! search's move can be proven to reach. A proof that runs out of nodes
//! changes nothing. No clock is read ([Z11-18]).

use std::collections::HashMap;

use azul_engine::{Action, AzulState, Outcome, Player, Shuffler};

use crate::search::SearchResult;

/// Values from the root mover's side: a loss, a draw, a win, and the two
/// stand-ins for a line that continues past the round.
const LOSS: i8 = -1;
const DRAW: i8 = 0;
const WIN: i8 = 1;
const BELOW_LOSS: i8 = -2;
const ABOVE_WIN: i8 = 2;

/// The node cap ran out: the proof is abandoned, and the search's move stands.
struct Budget;

/// [Z11-76]'s gate: the game can end at this round's end only if a wall row
/// already holds four tiles, since a row gains at most one tile a round. When
/// none does, no line ends the game this round and nothing can be proven.
pub fn can_end_this_round<S: Shuffler>(s: &AzulState<S>) -> bool {
    let walls = s.to_canonical().walls;
    walls.iter().any(|w| (0..5).any(|r| w[r * 5..r * 5 + 5].iter().map(|&x| u32::from(x)).sum::<u32>() == 4))
}

/// A 128-bit digest of everything that can change within a round. The bag and
/// the lid cannot (a round only draws at its end), nor can the round, so they
/// are left out.
fn key<S: Shuffler>(s: &AzulState<S>) -> u128 {
    let c = s.to_canonical();
    let mut bytes = [0u8; 96];
    let mut n = 0;
    let mut put = |b: u8| {
        bytes[n] = b;
        n += 1;
    };
    for f in &c.factories {
        f.iter().for_each(|&x| put(x));
    }
    c.center.iter().for_each(|&x| put(x));
    put(u8::from(c.marker_in_center));
    for w in &c.walls {
        for chunk in w.chunks(8) {
            put(chunk.iter().enumerate().fold(0u8, |acc, (i, &x)| acc | (x << i)));
        }
    }
    for p in 0..2 {
        c.pl_color[p].iter().for_each(|&x| put(x as u8));
        c.pl_count[p].iter().for_each(|&x| put(x));
        c.floor[p].iter().for_each(|&x| put(x));
        put(u8::from(c.floor_marker[p]));
        c.scores[p].to_le_bytes().iter().for_each(|&x| put(x));
    }
    put(u8::from(c.current_player == Player::P1));
    // Two FNV-1a passes from different offsets: a collision would make a proof
    // wrong, and at 128 bits none is expected in any search this can run.
    let fnv = |offset: u64| {
        bytes[..n].iter().fold(offset, |h, &b| (h ^ u64::from(b)).wrapping_mul(0x0000_0100_0000_01b3))
    };
    (u128::from(fnv(0xcbf2_9ce4_8422_2325)) << 64) | u128::from(fnv(0x6c62_272e_07bb_0142))
}

/// One kind of proof: every continuing line scored `cont`.
struct Prover {
    me: Player,
    round: u32,
    cont: i8,
    /// Lower and upper bounds on a position's value, from earlier searches.
    table: HashMap<u128, (i8, i8)>,
}

impl Prover {
    fn new<S: Shuffler>(root: &AzulState<S>, cont: i8) -> Prover {
        Prover { me: root.current_player(), round: root.round_index(), cont, table: HashMap::new() }
    }

    fn outcome(&self, outcome: Option<Outcome>) -> i8 {
        match (outcome, self.me) {
            (Some(Outcome::Player0), Player::P0) | (Some(Outcome::Player1), Player::P1) => WIN,
            (Some(Outcome::Draw), _) | (None, _) => DRAW,
            _ => LOSS,
        }
    }

    /// The value of a position some move has just produced.
    fn after<S: Shuffler>(&mut self, s: &AzulState<S>, alpha: i8, beta: i8, nodes: &mut u32) -> Result<i8, Budget> {
        if s.is_terminal() {
            return Ok(self.outcome(s.outcome()));
        }
        if s.round_index() != self.round {
            return Ok(self.cont);
        }
        self.value(s, alpha, beta, nodes)
    }

    /// Fail-soft alpha-beta within the round, the root mover maximising.
    fn value<S: Shuffler>(&mut self, s: &AzulState<S>, alpha: i8, beta: i8, nodes: &mut u32) -> Result<i8, Budget> {
        if *nodes == 0 {
            return Err(Budget);
        }
        *nodes -= 1;
        let k = key(s);
        let (lo, hi) = self.table.get(&k).copied().unwrap_or((BELOW_LOSS, ABOVE_WIN));
        if lo == hi || lo >= beta {
            return Ok(lo);
        }
        if hi <= alpha {
            return Ok(hi);
        }
        let (a0, b0) = (alpha.max(lo), beta.min(hi));
        let (mut a, mut b) = (a0, b0);
        let max = s.current_player() == self.me;
        let mut best = if max { BELOW_LOSS - 1 } else { ABOVE_WIN + 1 };
        for action in ordered(s) {
            let mut c = s.clone();
            if c.apply(action).is_err() {
                continue; // unreachable: `ordered` lists legal actions only
            }
            let v = self.after(&c, a, b, nodes)?;
            if max {
                best = best.max(v);
                a = a.max(best);
            } else {
                best = best.min(v);
                b = b.min(best);
            }
            if a >= b {
                break;
            }
        }
        let entry = self.table.entry(k).or_insert((BELOW_LOSS, ABOVE_WIN));
        if best <= a0 {
            entry.1 = entry.1.min(best);
        } else if best >= b0 {
            entry.0 = entry.0.max(best);
        } else {
            *entry = (best, best);
        }
        Ok(best)
    }

    /// Whether `action` from `root` is worth at least `v`, by a null-window search.
    fn at_least<S: Shuffler>(&mut self, root: &AzulState<S>, action: Action, v: i8, nodes: &mut u32) -> Result<bool, Budget> {
        let mut c = root.clone();
        if c.apply(action).is_err() {
            return Ok(false);
        }
        Ok(self.after(&c, v - 1, v, nodes)? >= v)
    }

    /// Whether `action` from `root` is worth at most `v`.
    fn at_most<S: Shuffler>(&mut self, root: &AzulState<S>, action: Action, v: i8, nodes: &mut u32) -> Result<bool, Budget> {
        let mut c = root.clone();
        if c.apply(action).is_err() {
            return Ok(false);
        }
        Ok(self.after(&c, v, v + 1, nodes)? <= v)
    }
}

/// Legal actions, pattern-line moves before floor moves: the floor is rarely
/// the move, and alpha-beta lives on trying the good ones first.
fn ordered<S: Shuffler>(s: &AzulState<S>) -> Vec<Action> {
    let mut moves: Vec<Action> = s.legal_actions().as_slice().to_vec();
    moves.sort_by_key(|&a| a % 6 == 5);
    moves
}

/// What the proof decided, for the record and the suite.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Verdict {
    /// Off, or the game cannot end this round.
    NotTried,
    /// The search's move is a proven win.
    Confirmed,
    /// Replaced by a proven win.
    Won,
    /// The search's move is a proven loss; replaced by a move proven at least to draw.
    Saved,
    /// Nothing proven better than the search's move.
    Kept,
    /// The node cap ran out first.
    OutOfNodes,
}

/// [Z11-76]: the search's result, its action replaced when a proof shows a
/// strictly better result is certain, within `max_nodes` interior nodes.
pub fn refine<S: Shuffler>(root: &AzulState<S>, result: SearchResult, max_nodes: u32) -> (SearchResult, Verdict) {
    if max_nodes == 0 || root.is_terminal() || !can_end_this_round(root) {
        return (result, Verdict::NotTried);
    }
    let mut nodes = max_nodes;
    match decide(root, &result, &mut nodes) {
        Ok((Some(action), verdict)) => (SearchResult { action, ..result }, verdict),
        Ok((None, verdict)) => (result, verdict),
        Err(Budget) => (result, Verdict::OutOfNodes),
    }
}

fn decide<S: Shuffler>(root: &AzulState<S>, result: &SearchResult, nodes: &mut u32) -> Result<(Option<Action>, Verdict), Budget> {
    let chosen = result.action;
    // The other moves in the search's order: most visits first, ties to the lowest index.
    let mut others: Vec<Action> = root.legal_actions().as_slice().iter().copied().filter(|&a| a != chosen).collect();
    others.sort_by_key(|&a| std::cmp::Reverse(result.visits[usize::from(a)]));
    // Continuing lines below a loss: what survives is a certain result.
    let mut pessimist = Prover::new(root, BELOW_LOSS);
    if pessimist.at_least(root, chosen, WIN, nodes)? {
        return Ok((None, Verdict::Confirmed));
    }
    for &a in &others {
        if pessimist.at_least(root, a, WIN, nodes)? {
            return Ok((Some(a), Verdict::Won));
        }
    }
    // No certain win. A move that certainly loses gives way to one that certainly does not.
    let mut optimist = Prover::new(root, ABOVE_WIN);
    if !optimist.at_most(root, chosen, LOSS, nodes)? {
        return Ok((None, Verdict::Kept));
    }
    for &a in &others {
        if pessimist.at_least(root, a, DRAW, nodes)? {
            return Ok((Some(a), Verdict::Saved));
        }
    }
    Ok((None, Verdict::Kept))
}
