//! The trained player of spec 0011, for the browser (spec 0012).
//!
//! No player code lives here ([T12-3]): every move is one call to the crate's
//! own `choose_played`, with a fresh memo, on the network `load` accepted
//! after its parity check, at the shipped endgame proof's node cap
//! ([T12-33], [0011 Z11-76]), with the shipped past-deal refinement if there
//! is one ([T12-36], [0011 Z11-91]). What this crate adds is the marshalling — a
//! canonical block in, an action and a value out — and the raw exports of
//! `exports.rs`, the one module allowed `unsafe` ([T12-5]).

#![deny(unsafe_code)]

#[allow(unsafe_code)]
pub mod exports;

use azul_alphazero::memo::Memo;
use azul_alphazero::network::Network;
use azul_alphazero::pastdeal::{PastDeal, choose_played};
use azul_alphazero::search::SearchConfig;
use azul_alphazero::wire::read_canonical;
use azul_engine::{AzulState, Seeded};

/// A loaded network, the search settings of the milestone it came from, the
/// endgame proof's node cap it ships with, and its refinement, if any.
pub struct Player {
    net: Network,
    cpuct: f32,
    fpu: f32,
    endgame_nodes: u32,
    past_deal: Option<PastDeal>,
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
    /// ([0011 Z11-13]), the milestone's `cpuct` and `fpu`, the shipped
    /// endgame node cap ([T12-33]), and the bytes of the shipped
    /// `pastdeal.json`, empty for none: read by the crate's own parser and
    /// refused unless fitted to this checkpoint ([T12-36]).
    pub fn load(
        checkpoint: &[u8],
        parity: &[u8],
        cpuct: f32,
        fpu: f32,
        endgame_nodes: u32,
        past_deal: &[u8],
    ) -> Result<Player, String> {
        let past_deal = match past_deal {
            [] => None,
            bytes => Some(PastDeal::parse(bytes)?.fitted_to(checkpoint)?),
        };
        let net = Network::load_single(checkpoint, parity).map_err(|e| e.to_string())?;
        Ok(Player { net, cpuct, fpu, endgame_nodes, past_deal })
    }

    /// [T12-3], [T12-4]: the block decoded as `play` decodes it, and the move
    /// `choose_played` makes from it at `simulations`.
    pub fn choose(&self, block: &[u32], simulations: u32) -> Result<(u8, f32), Refusal> {
        let canonical = read_canonical(block).map_err(Refusal::Block)?;
        let state = AzulState::from_canonical(&canonical, Seeded::new(0))
            .map_err(|e| Refusal::Block(format!("the position was refused: {e:?}")))?;
        let config = SearchConfig { simulations, cpuct: self.cpuct, fpu: self.fpu, endgame_nodes: self.endgame_nodes };
        let result =
            choose_played(&self.net, &state, &config, self.past_deal.as_ref(), Memo::new()).ok_or(Refusal::Terminal)?;
        Ok((result.action, result.value))
    }
}
