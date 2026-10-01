//! Self-play ([Z11-20], [Z11-26]): games of the current network against
//! itself, each on its own seeded state, written as samples ([Z11-27]).

use std::sync::Mutex;
use std::sync::atomic::{AtomicUsize, Ordering};

use azul_engine::{ACTION_SPACE, AzulState, Outcome, Player, Seeded};

use crate::config::Settings;
use crate::memo::Memo;
use crate::network::{BATCH, Evaluation, Evaluator, Request};
use crate::rng::{Rng, game_seed, noise_seed};
use crate::samples::{Kind, LEGAL_BYTES, Sample, legal_mask};
use crate::search::Search;
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

/// How many games each self-play thread plays at once, their leaves valued
/// in one batch ([Z11-70]).
pub const GAMES_PER_THREAD: usize = BATCH;

/// One game in progress: its state, its generator, the samples so far, the
/// search of the current move, and its memo.
struct Game {
    index: u64,
    state: AzulState<Seeded>,
    rng: Rng,
    samples: Vec<(Sample, Player)>,
    ply: usize,
    search: Option<Search<Seeded>>,
    memo: Memo,
    /// The memo key of the input the search is paused on, once the memo has
    /// missed it: the game is waiting for the network.
    waiting: Option<Box<[u32]>>,
}

impl Game {
    fn new(seed: u64, generation: u64, index: u64) -> Game {
        Game {
            index,
            state: AzulState::new_game(Seeded::new(game_seed(seed, generation, index))),
            rng: Rng::new(noise_seed(seed, generation, index)),
            samples: Vec::new(),
            ply: 0,
            search: None,
            memo: Memo::new(),
            waiting: None,
        }
    }

    /// Plays on until the game needs the network (`true`) or is over
    /// (`false`). The memo answers what it can on the way.
    fn advance(&mut self, settings: &Settings) -> bool {
        if self.waiting.is_some() {
            return true;
        }
        loop {
            let Some(search) = self.search.as_mut() else {
                if self.state.is_terminal() || self.ply >= MAX_PLIES {
                    return false;
                }
                let noise = settings.noise.as_ref().map(|n| (n, &mut self.rng));
                match Search::new(&self.state, &settings.search, noise) {
                    Some(s) => self.search = Some(s),
                    None => return false,
                }
                continue;
            };
            if let Some(request) = search.wants() {
                match self.memo.lookup(request) {
                    Ok(e) => search.supply(e),
                    Err(k) => {
                        self.waiting = Some(k);
                        return true;
                    }
                }
                continue;
            }
            let Some(search) = self.search.take() else { return false };
            let (result, _) = search.finish();
            if !self.play(&result.visits, settings) {
                return false;
            }
        }
    }

    /// The input the game is waiting on.
    fn request(&self) -> Option<Request<'_>> {
        self.search.as_ref()?.wants()
    }

    /// The network's answer to `request`: remembered, then handed to the
    /// search.
    fn supply(&mut self, eval: &Evaluation) {
        if let (Some(k), Some(search)) = (self.waiting.take(), self.search.as_mut()) {
            self.memo.insert(k, eval);
            search.supply(eval);
        }
    }

    /// The move sample, the move, and a boundary sample if the move resolved
    /// a round. `false` if the move could not be played.
    fn play(&mut self, root_visits: &[u32; ACTION_SPACE], settings: &Settings) -> bool {
        let state = &mut self.state;
        let legal = state.legal_actions();
        let mut visits = [0u16; ACTION_SPACE];
        for (v, &n) in visits.iter_mut().zip(root_visits) {
            *v = n.min(u32::from(u16::MAX)) as u16;
        }
        let seat = state.current_player();
        self.samples.push((
            Sample { kind: Kind::Move, result: 0, observation: state.encode(), legal: legal_mask(legal.as_slice()), visits },
            seat,
        ));
        let action = pick(root_visits, self.ply, settings, &mut self.rng);
        let before = state.clone();
        if state.apply(action).is_err() {
            return false;
        }
        self.ply += 1;
        let boundary = is_boundary(&before, state);
        if boundary {
            // The memo holds one round: an input from before the deal is all
            // but never asked again after it, since the observation carries
            // the round index. That is for memory only; what the memo answers
            // is exact however often it is emptied.
            self.memo.clear();
        }
        if !state.is_terminal() && boundary {
            self.samples.push((
                Sample {
                    kind: Kind::Boundary,
                    result: 0,
                    observation: pre_deal_view(&before, state),
                    legal: [0; LEGAL_BYTES],
                    visits: [0; ACTION_SPACE],
                },
                state.current_player(),
            ));
        }
        true
    }

    /// The samples, results filled in from the final outcome.
    fn into_samples(self) -> Vec<Sample> {
        let outcome = self.state.outcome();
        self.samples
            .into_iter()
            .map(|(mut s, seat)| {
                s.result = result_for(outcome, seat);
                s
            })
            .collect()
    }
}

/// [Z11-70]: plays the games `next` hands out, up to `lanes` at once, and
/// gives each to `done` when it ends. Each round of the loop advances every
/// game to its next network call and values them all in one batch. A game
/// sees only its own evaluations, each the bits it would get alone, so what
/// it plays does not depend on which games shared its batches.
fn play_games<E: Evaluator>(
    net: &E,
    settings: &Settings,
    seed: u64,
    generation: u64,
    lanes: usize,
    mut next: impl FnMut() -> Option<u64>,
    mut done: impl FnMut(u64, Vec<Sample>),
) {
    let lanes = lanes.max(1);
    let mut games: Vec<Game> = Vec::with_capacity(lanes);
    let mut evals = vec![Evaluation::default(); lanes];
    loop {
        let mut k = 0;
        while k < lanes {
            if k == games.len() {
                match next() {
                    Some(i) => games.push(Game::new(seed, generation, i)),
                    None => break,
                }
            }
            if games[k].advance(settings) {
                k += 1;
            } else {
                let g = games.swap_remove(k);
                done(g.index, g.into_samples());
            }
        }
        if games.is_empty() {
            return;
        }
        // Every game left is waiting: `advance` said so.
        let requests: Vec<Request<'_>> = games.iter().filter_map(Game::request).collect();
        debug_assert_eq!(requests.len(), games.len());
        net.evaluate_batch(&requests, &mut evals[..requests.len()]);
        drop(requests);
        for (g, e) in games.iter_mut().zip(&evals) {
            g.supply(e);
        }
    }
}

/// One self-play game on its own, unbatched: its samples, results filled in
/// from the final outcome.
pub fn play_game<E: Evaluator>(net: &E, settings: &Settings, seed: u64, generation: u64, index: u64) -> Vec<Sample> {
    let mut out = Vec::new();
    let mut once = Some(index);
    play_games(net, settings, seed, generation, 1, || once.take(), |_, s| out = s);
    out
}

/// Games `0..games` of generation `generation`, on `settings.threads` threads
/// over one shared network, each playing `GAMES_PER_THREAD` at once, as the
/// bytes of a sample file in game order. The order of the file does not
/// depend on which thread played which game, nor on which games shared a
/// batch.
pub fn self_play<E: Evaluator>(net: &E, settings: &Settings, seed: u64, generation: u64, games: usize) -> Vec<u8> {
    let next = AtomicUsize::new(0);
    let done: Mutex<Vec<Option<Vec<u8>>>> = Mutex::new(vec![None; games]);
    std::thread::scope(|scope| {
        for _ in 0..settings.threads.max(1) {
            scope.spawn(|| {
                let take = || {
                    let i = next.fetch_add(1, Ordering::Relaxed);
                    (i < games).then_some(i as u64)
                };
                let finish = |i: u64, samples: Vec<Sample>| {
                    let mut bytes = Vec::new();
                    for s in samples {
                        s.write(&mut bytes);
                    }
                    if let Ok(mut d) = done.lock() {
                        d[i as usize] = Some(bytes);
                    }
                };
                play_games(net, settings, seed, generation, GAMES_PER_THREAD, take, finish);
            });
        }
    });
    let done = done.into_inner().unwrap_or_default();
    done.into_iter().flatten().flatten().collect()
}
