//! The trained player of spec 0011, for the browser (spec 0012).
//!
//! No player code lives here ([T12-3]): every move is one call to the crate's
//! own `choose_memoised`, with a fresh memo, on the network `load` accepted
//! after its parity check. What this crate adds is the marshalling — a
//! canonical block in, an action and a value out — and the raw exports of
//! `exports.rs`, the one module allowed `unsafe` ([T12-5]).

#![deny(unsafe_code)]

#[allow(unsafe_code)]
pub mod exports;

use azul_alphazero::memo::{Memo, choose_memoised};
use azul_alphazero::network::Network;
use azul_alphazero::search::SearchConfig;
use azul_alphazero::wire::read_canonical;
use azul_engine::{AzulState, Seeded};

/// A loaded network and the search settings of the milestone it came from.
pub struct Player {
    net: Network,
    cpuct: f32,
    fpu: f32,
}

/// Why `choose` gave no move.
#[derive(Clone, Debug, PartialEq)]
pub enum Refusal {
    /// The block did not decode to a position.
    Block(String),
    /// The position is terminal: there is no move to choose.
    Terminal,
}

impl Player {
    /// The checkpoint and its parity file, parity checked as every load is
    /// ([0011 Z11-13]), and the milestone's `cpuct` and `fpu`.
    pub fn load(checkpoint: &[u8], parity: &[u8], cpuct: f32, fpu: f32) -> Result<Player, String> {
        let net = Network::load(checkpoint, parity).map_err(|e| e.to_string())?;
        Ok(Player { net, cpuct, fpu })
    }

    /// [T12-3], [T12-4]: the block decoded as `play` decodes it, and the move
    /// `choose_memoised` makes from it at `simulations`.
    pub fn choose(&self, block: &[u32], simulations: u32) -> Result<(u8, f32), Refusal> {
        let canonical = read_canonical(block).map_err(Refusal::Block)?;
        let state = AzulState::from_canonical(&canonical, Seeded::new(0))
            .map_err(|e| Refusal::Block(format!("the position was refused: {e:?}")))?;
        // The endgame proof stays off in the browser until 0012 ships it ([0011 Z11-76]).
        let config = SearchConfig { simulations, cpuct: self.cpuct, fpu: self.fpu, endgame_nodes: 0 };
        let mut memo = Memo::new();
        let result = choose_memoised(&self.net, &state, &config, &mut memo).ok_or(Refusal::Terminal)?;
        Ok((result.action, result.value))
    }
}
