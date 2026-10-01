//! Self-play ([Z11-20], [Z11-26]): games of the current network against
//! itself, each on its own seeded state, written as samples ([Z11-27]).

use std::sync::Mutex;
use std::sync::atomic::{AtomicUsize, Ordering};

use azul_engine::{ACTION_SPACE, AzulState, Outcome, Player, Seeded, Shuffler};

use crate::config::Settings;
use crate::network::Evaluator;
use crate::rng::{Rng, game_seed, noise_seed};
use crate::samples::{Aux, Kind, LEGAL_BYTES, Sample, legal_mask, wall_mask};
use crate::search::search;
use crate::view::{is_boundary, pre_deal_view};

/// A game that has run this long has run away. Azul games are about 75 plies.
const MAX_PLIES: usize = 1000;

/// The result `+1 / 0 / -1` for `seat`.
fn result_for(outcome: Option<Outcome>, seat: Player) -> i8 {
    match outcome {
        Some(Outcome::Player0) => if seat == Player::P0 { 1 } else { -1 },
        Some(Outcome::Player1) => if seat == Player::P1 { 1 } else { -1 },
        _ => 0,
    }
}

/// What a finished game ended as, from `seat` ([Z11-67]): the seat's final
/// score minus the other's, and both final walls, the seat's first.
pub fn final_aux<S: Shuffler>(state: &AzulState<S>, seat: Player) -> Aux {
    let scores = state.scores();
    let walls = state.to_canonical().walls.map(|w| wall_mask(&w));
    let (me, them) = (seat.index(), seat.other().index());
    // Saturating: a margin past ±32 767 points is not a game of Azul.
    let margin = (scores[me] - scores[them]).clamp(i32::from(i16::MIN), i32::from(i16::MAX)) as i16;
    Aux { margin, walls: [walls[me], walls[them]] }
}

/// Picks the move from root visits: sampled in proportion to `N^(1/τ)` for the
/// first `temp_plies` plies, then the most visited, ties to the lowest index.
fn pick(visits: &[u32; ACTION_SPACE], ply: usize, settings: &Settings, rng: &mut Rng) -> u8 {
    let greedy = || {
        let mut best = 0usize;
        for a in 0..ACTION_SPACE {
            if visits[a] > visits[best] {
                best = a;
            }
        }
        best as u8
    };
    if ply >= settings.temp_plies as usize {
        return greedy();
    }
    let power = 1.0 / f64::from(settings.tau);
    let weights: Vec<f64> = visits.iter().map(|&n| if n == 0 { 0.0 } else { f64::from(n).powf(power) }).collect();
    let sum: f64 = weights.iter().sum();
    if !sum.is_finite() || sum <= 0.0 {
        return greedy();
    }
    let mut x = rng.uniform() * sum;
    let mut last = greedy();
    for (a, w) in weights.iter().enumerate() {
        if *w > 0.0 {
            last = a as u8;
            if x < *w {
                return a as u8;
            }
            x -= w;
        }
    }
    last
}

/// One self-play game: its samples, results filled in from the final outcome,
/// each beside what the game ended as from its seat ([Z11-67]).
pub fn play_game<E: Evaluator>(
    net: &E,
    settings: &Settings,
    seed: u64,
    generation: u64,
    index: u64,
) -> Vec<(Sample, Aux)> {
    let mut state = AzulState::new_game(Seeded::new(game_seed(seed, generation, index)));
    let mut rng = Rng::new(noise_seed(seed, generation, index));
    let mut samples: Vec<(Sample, Player)> = Vec::new();
    let mut ply = 0usize;
    while !state.is_terminal() && ply < MAX_PLIES {
        let noise = settings.noise.as_ref().map(|n| (n, &mut rng));
        let Some((result, _)) = search(net, &state, &settings.search, noise) else { break };
        let legal = state.legal_actions();
        let mut visits = [0u16; ACTION_SPACE];
        for (v, &n) in visits.iter_mut().zip(&result.visits) {
            *v = n.min(u32::from(u16::MAX)) as u16;
        }
        let seat = state.current_player();
        samples.push((
            Sample { kind: Kind::Move, result: 0, observation: state.encode(), legal: legal_mask(legal.as_slice()), visits },
            seat,
        ));
        let action = pick(&result.visits, ply, settings, &mut rng);
        let before = state.clone();
        if state.apply(action).is_err() {
            break;
        }
        ply += 1;
        if !state.is_terminal() && is_boundary(&before, &state) {
            samples.push((
                Sample {
                    kind: Kind::Boundary,
                    result: 0,
                    observation: pre_deal_view(&before, &state),
                    legal: [0; LEGAL_BYTES],
                    visits: [0; ACTION_SPACE],
                },
                state.current_player(),
            ));
        }
    }
    let outcome = state.outcome();
    samples
        .into_iter()
        .map(|(mut s, seat)| {
            s.result = result_for(outcome, seat);
            (s, final_aux(&state, seat))
        })
        .collect()
}

/// One game's records: its sample bytes and its aux bytes ([Z11-67]).
type GameBytes = (Vec<u8>, Vec<u8>);

/// Games `0..games` of generation `generation`, on `settings.threads` threads
/// over one shared network, as the bytes of a sample file in game order, and
/// of its aux file in the same order ([Z11-67]). The order of the files does
/// not depend on which thread played which game.
pub fn self_play<E: Evaluator>(
    net: &E,
    settings: &Settings,
    seed: u64,
    generation: u64,
    games: usize,
) -> (Vec<u8>, Vec<u8>) {
    let next = AtomicUsize::new(0);
    let done: Mutex<Vec<Option<GameBytes>>> = Mutex::new(vec![None; games]);
    std::thread::scope(|scope| {
        for _ in 0..settings.threads.max(1) {
            scope.spawn(|| {
                loop {
                    let i = next.fetch_add(1, Ordering::Relaxed);
                    if i >= games {
                        return;
                    }
                    let mut bytes = Vec::new();
                    let mut aux = Vec::new();
                    for (s, a) in play_game(net, settings, seed, generation, i as u64) {
                        s.write(&mut bytes);
                        a.write(&mut aux);
                    }
                    if let Ok(mut d) = done.lock() {
                        d[i] = Some((bytes, aux));
                    }
                }
            });
        }
    });
    let done = done.into_inner().unwrap_or_default();
    let (mut samples, mut aux) = (Vec::new(), Vec::new());
    for (s, a) in done.into_iter().flatten() {
        samples.extend(s);
        aux.extend(a);
    }
    (samples, aux)
}
