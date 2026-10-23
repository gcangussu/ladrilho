//! Self-play ([Z11-20], [Z11-26]): games of the current network against
//! itself, each on its own seeded state, written as samples ([Z11-27]).

use std::sync::Mutex;
use std::sync::atomic::{AtomicUsize, Ordering};

use azul_engine::{ACTION_SPACE, AzulState, Outcome, Player, Seeded, Shuffler};

use crate::config::Settings;
use crate::lookahead::{Boundary, Lane, looked_past};
use crate::network::{BATCH, Evaluation, Evaluator, Request};
use crate::rng::{Rng, cap_seed, game_seed, look_seed, noise_seed};
use crate::samples::{Aux, Kind, LEGAL_BYTES, Sample, legal_mask, wall_mask};
use crate::search::{Search, SearchConfig};
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

/// One game's records: its samples, each beside what the game ended as from
/// its seat ([Z11-67]).
pub type Records = Vec<(Sample, Aux)>;

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

/// One game in progress: its state, its generators, the samples so far, the
/// lane of its current move's search with the game's memo, and its
/// lookaheads ([Z11-80]).
struct Game {
    index: u64,
    state: AzulState<Seeded>,
    rng: Rng,
    /// The playout cap's draws ([Z11-75]), apart from the noise's.
    cap_rng: Rng,
    /// The lookahead's deals ([Z11-80]), apart from both.
    look_rng: Rng,
    /// Whether the current move's search is a full one ([Z11-75]).
    full: bool,
    samples: Vec<(Sample, Player)>,
    /// Per sample, its lookahead value; NaN for none ([Z11-80]).
    look: Vec<f32>,
    ply: usize,
    /// The current move's search, and the memo the game keeps across moves
    /// ([Z11-69]).
    lane: Lane,
    /// Whether the game itself has ended; its lookaheads may still run.
    over: bool,
    /// Lookaheads still running, each with the sample it labels.
    looks: Vec<(usize, Boundary)>,
}

impl Game {
    fn new(seed: u64, generation: u64, index: u64) -> Game {
        Game {
            index,
            state: AzulState::new_game(Seeded::new(game_seed(seed, generation, index))),
            rng: Rng::new(noise_seed(seed, generation, index)),
            cap_rng: Rng::new(cap_seed(seed, generation, index)),
            look_rng: Rng::new(look_seed(seed, generation, index)),
            full: true,
            samples: Vec::new(),
            look: Vec::new(),
            ply: 0,
            lane: Lane::default(),
            over: false,
            looks: Vec::new(),
        }
    }

    /// Plays on until the game needs the network (`true`) or is over
    /// (`false`). The memo answers what it can on the way.
    fn advance_play(&mut self, settings: &Settings) -> bool {
        loop {
            if self.lane.search.is_none() {
                if self.state.is_terminal() || self.ply >= MAX_PLIES {
                    return false;
                }
                // [Z11-75]: under the cap, a draw decides between the full
                // search with its noise and a cheap one without.
                let cheap = match settings.playout_cap {
                    Some(cap) if self.cap_rng.uniform() >= cap.full_search_fraction => Some(cap.cheap_simulations),
                    _ => None,
                };
                self.full = cheap.is_none();
                let created = match cheap {
                    None => {
                        let noise = settings.noise.as_ref().map(|n| (n, &mut self.rng));
                        Search::new(&self.state, &settings.search, noise)
                    }
                    Some(simulations) => {
                        let config = SearchConfig { simulations, ..settings.search.clone() };
                        Search::new(&self.state, &config, None)
                    }
                };
                match created {
                    Some(s) => self.lane.search = Some(s),
                    None => return false,
                }
            }
            if self.lane.advance() {
                return true;
            }
            let Some(search) = self.lane.search.take() else { return false };
            let (result, _) = search.finish();
            if !self.play(&result.visits, settings) {
                return false;
            }
        }
    }

    /// Plays on, and runs every lookahead on, until each needs the network.
    /// `false` once the game is over and its lookaheads have all finished:
    /// it is done. Otherwise something of it is waiting.
    fn advance(&mut self, settings: &Settings) -> bool {
        if !self.over && !self.advance_play(settings) {
            self.over = true;
        }
        let mut i = 0;
        while i < self.looks.len() {
            if self.looks[i].1.advance() {
                i += 1;
            } else {
                let (k, b) = self.looks.remove(i);
                self.look[k] = b.value();
            }
        }
        !self.over || !self.looks.is_empty()
    }

    /// The inputs the game is waiting on: its own search's, then its
    /// lookaheads', in order.
    fn requests<'a>(&'a self, out: &mut Vec<Request<'a>>) {
        if !self.over {
            out.extend(self.lane.request());
        }
        for (_, b) in &self.looks {
            b.requests(out);
        }
    }

    /// The network's answers, taken from `answers` in the order of `requests`.
    fn supply<'e>(&mut self, answers: &mut impl Iterator<Item = &'e Evaluation>) {
        if !self.over
            && self.lane.is_waiting()
            && let Some(e) = answers.next()
        {
            self.lane.supply(e);
        }
        for (_, b) in &mut self.looks {
            b.supply(answers);
        }
    }

    fn push(&mut self, sample: Sample, seat: Player) {
        self.samples.push((sample, seat));
        self.look.push(f32::NAN);
    }

    /// The move sample, the move, and a boundary sample if the move resolved
    /// a round, with its lookahead started if [Z11-80] looks past it. `false`
    /// if the move could not be played.
    fn play(&mut self, root_visits: &[u32; ACTION_SPACE], settings: &Settings) -> bool {
        let legal = self.state.legal_actions();
        let mut visits = [0u16; ACTION_SPACE];
        for (v, &n) in visits.iter_mut().zip(root_visits) {
            *v = n.min(u32::from(u16::MAX)) as u16;
        }
        let seat = self.state.current_player();
        let sample = if self.full {
            Sample { kind: Kind::Move, result: 0, observation: self.state.encode(), legal: legal_mask(legal.as_slice()), visits }
        } else {
            // [Z11-75]: a cheap search's visits are no target; its position
            // still learns the game's result.
            Sample { kind: Kind::Cheap, result: 0, observation: self.state.encode(), legal: [0; LEGAL_BYTES], visits: [0; ACTION_SPACE] }
        };
        self.push(sample, seat);
        let action = pick(root_visits, self.ply, settings, &mut self.rng);
        let before = self.state.clone();
        if self.state.apply(action).is_err() {
            return false;
        }
        self.ply += 1;
        let boundary = is_boundary(&before, &self.state);
        if boundary {
            // The memo holds one round: an input from before the deal is all
            // but never asked again after it, since the observation carries
            // the round index. That is for memory only; what the memo answers
            // is exact however often it is emptied.
            self.lane.memo.clear();
        }
        if !self.state.is_terminal() && boundary {
            let sample = Sample {
                kind: Kind::Boundary,
                result: 0,
                observation: pre_deal_view(&before, &self.state),
                legal: [0; LEGAL_BYTES],
                visits: [0; ACTION_SPACE],
            };
            self.push(sample, self.state.current_player());
            if let Some(deals) = settings.lookahead_deals
                && looked_past(&self.state)
            {
                // The deals come from the lookahead's own generator and the
                // bag's counts, never the game's state or generators: the
                // game plays on exactly as it would without them.
                let b = Boundary::new(&before, action, deals, &settings.search, &mut self.look_rng);
                self.looks.push((self.samples.len() - 1, b));
            }
        }
        true
    }

    /// The samples, results filled in from the final outcome, each beside
    /// what the game ended as from its seat ([Z11-67]); and each sample's
    /// lookahead value ([Z11-80]).
    fn into_records(self) -> (Records, Vec<f32>) {
        let outcome = self.state.outcome();
        let state = &self.state;
        let records = self
            .samples
            .into_iter()
            .map(|(mut s, seat)| {
                s.result = result_for(outcome, seat);
                (s, final_aux(state, seat))
            })
            .collect();
        (records, self.look)
    }
}

/// [Z11-70]: plays the games `next` hands out, up to `lanes` at once, and
/// gives each to `done` when it and its lookaheads end. Each round of the
/// loop advances every game, and every lookahead deal ([Z11-80]), to its next
/// network call and values them all in one batch. A search sees only its own
/// evaluations, each the bits it would get alone, so what it plays does not
/// depend on which searches shared its batches.
fn play_games<E: Evaluator>(
    net: &E,
    settings: &Settings,
    seed: u64,
    generation: u64,
    lanes: usize,
    mut next: impl FnMut() -> Option<u64>,
    mut done: impl FnMut(u64, Records, Vec<f32>),
) {
    let lanes = lanes.max(1);
    let mut games: Vec<Game> = Vec::with_capacity(lanes);
    let mut answers = Vec::new();
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
                let index = g.index;
                let (records, look) = g.into_records();
                done(index, records, look);
            }
        }
        if games.is_empty() {
            return;
        }
        // Every game left is waiting on something: `advance` said so.
        let mut requests: Vec<Request<'_>> = Vec::new();
        for g in &games {
            g.requests(&mut requests);
        }
        debug_assert!(!requests.is_empty());
        if answers.len() < requests.len() {
            answers.resize(requests.len(), Evaluation::default());
        }
        net.evaluate_batch(&requests, &mut answers[..requests.len()]);
        drop(requests);
        let mut given = answers.iter();
        for g in &mut games {
            g.supply(&mut given);
        }
    }
}

/// One self-play game on its own, unbatched: its samples, results filled in
/// from the final outcome, each beside its aux record ([Z11-67]).
pub fn play_game<E: Evaluator>(net: &E, settings: &Settings, seed: u64, generation: u64, index: u64) -> Records {
    play_game_looked(net, settings, seed, generation, index).0
}

/// [`play_game`], with each sample's lookahead value beside it: NaN for a
/// sample [Z11-80] does not look past, and for every sample while
/// `settings.lookahead_deals` is unset.
pub fn play_game_looked<E: Evaluator>(
    net: &E,
    settings: &Settings,
    seed: u64,
    generation: u64,
    index: u64,
) -> (Records, Vec<f32>) {
    let mut out = (Vec::new(), Vec::new());
    let mut once = Some(index);
    play_games(net, settings, seed, generation, 1, || once.take(), |_, s, l| out = (s, l));
    out
}

/// What `self_play` writes: the sample file's bytes, its aux file's
/// ([Z11-67]), and its lookahead file's while `lookahead_deals` is set
/// ([Z11-80]).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Written {
    pub samples: Vec<u8>,
    pub aux: Vec<u8>,
    pub look: Option<Vec<u8>>,
}

/// One game's bytes: its sample, aux and lookahead records.
type GameBytes = (Vec<u8>, Vec<u8>, Vec<u8>);

/// Games `0..games` of generation `generation`, on `settings.threads` threads
/// over one shared network, each playing `GAMES_PER_THREAD` at once, as the
/// bytes of a sample file in game order. The order of the file does not
/// depend on which thread played which game, nor on which games shared a
/// batch; and the bytes of its aux file ([Z11-67]) and its lookahead file
/// ([Z11-80]), in the same order.
pub fn self_play<E: Evaluator>(net: &E, settings: &Settings, seed: u64, generation: u64, games: usize) -> Written {
    let next = AtomicUsize::new(0);
    let done: Mutex<Vec<Option<GameBytes>>> = Mutex::new(vec![None; games]);
    std::thread::scope(|scope| {
        for _ in 0..settings.threads.max(1) {
            scope.spawn(|| {
                let take = || {
                    let i = next.fetch_add(1, Ordering::Relaxed);
                    (i < games).then_some(i as u64)
                };
                let finish = |i: u64, records: Records, look: Vec<f32>| {
                    let (mut bytes, mut aux, mut looked) = (Vec::new(), Vec::new(), Vec::new());
                    for (s, a) in records {
                        s.write(&mut bytes);
                        a.write(&mut aux);
                    }
                    for v in look {
                        looked.extend_from_slice(&v.to_le_bytes());
                    }
                    if let Ok(mut d) = done.lock() {
                        d[i as usize] = Some((bytes, aux, looked));
                    }
                };
                play_games(net, settings, seed, generation, GAMES_PER_THREAD, take, finish);
            });
        }
    });
    let done = done.into_inner().unwrap_or_default();
    let (mut samples, mut aux, mut look) = (Vec::new(), Vec::new(), Vec::new());
    for (s, a, l) in done.into_iter().flatten() {
        samples.extend(s);
        aux.extend(a);
        look.extend(l);
    }
    Written { samples, aux, look: settings.lookahead_deals.map(|_| look) }
}
