//! The two figures of [R9-18], measured the way `packages/engine/bench` measures
//! them: `legal_actions` + `apply` over a recorded random game replayed from a
//! clone of its opening state, and one `clone` of a mid-game position.
//!
//! Shared by `benches/engine.rs` and `examples/compare.rs` through `#[path]`, so
//! the bench and the gate measure one thing. `tests/measure.rs` includes it
//! too, to test the protocol; each includer uses a different part.
#![allow(dead_code)]

use azul_engine::{Action, AzulState};
use std::hint::black_box;
use std::time::{Duration, Instant};

/// The seed the TypeScript bench uses, for want of a reason to pick another.
/// The two engines deal different games from it ([R9-13]); what is compared is
/// plies per second, not the game.
pub const SEED: u64 = 20260903;

/// Warm-up runs discarded, then timed runs kept, per [0007 S7-40]'s protocol.
pub const WARMUP_RUNS: usize = 3;
pub const TIMED_RUNS: usize = 9;

/// How long one timed run lasts.
const RUN_TIME: Duration = Duration::from_millis(500);

/// A fixed script of plies, so every iteration does identical work.
pub fn record_game(seed: u64) -> Vec<Action> {
    let mut s = AzulState::seeded(seed);
    let mut pick = seed | 1;
    let mut actions = Vec::new();
    while !s.is_terminal() {
        let legal = s.legal_actions();
        // A throwaway xorshift for move choice; the engine's generator is only
        // ever consumed by shuffles ([0001 E1-47]).
        pick ^= pick << 13;
        pick ^= pick >> 7;
        pick ^= pick << 17;
        let a = legal.as_slice()[(pick % legal.len() as u64) as usize];
        actions.push(a);
        s.apply(a).expect("a recorded move is legal");
    }
    actions
}

/// One timed run of the whole game: plies per second.
fn plies_per_second_once(start: &AzulState, actions: &[Action]) -> f64 {
    let begin = Instant::now();
    let mut games = 0u64;
    while begin.elapsed() < RUN_TIME {
        let mut s = start.clone();
        for &a in actions {
            black_box(s.legal_actions());
            let _ = s.apply(black_box(a));
        }
        black_box(&s);
        games += 1;
    }
    (games * actions.len() as u64) as f64 / begin.elapsed().as_secs_f64()
}

/// One timed run of cloning a mid-game position: nanoseconds per clone.
fn clone_ns_once(mid: &AzulState) -> f64 {
    let begin = Instant::now();
    let mut n = 0u64;
    while begin.elapsed() < RUN_TIME {
        for _ in 0..1000 {
            black_box(black_box(mid).clone());
        }
        n += 1000;
    }
    begin.elapsed().as_nanos() as f64 / n as f64
}

pub fn median(mut xs: Vec<f64>) -> f64 {
    xs.sort_by(f64::total_cmp);
    let n = xs.len();
    if n % 2 == 1 { xs[n / 2] } else { (xs[n / 2 - 1] + xs[n / 2]) / 2.0 }
}

pub struct Figures {
    pub plies: usize,
    pub plies_per_second: f64,
    pub clone_ns: f64,
}

/// The fixed work one run measures: a recorded game from its opening, and a
/// position 40 plies into it.
pub struct Workload {
    actions: Vec<Action>,
    start: AzulState,
    mid: AzulState,
}

impl Default for Workload {
    fn default() -> Self {
        Self::new()
    }
}

impl Workload {
    pub fn new() -> Self {
        let actions = record_game(SEED);
        let start = AzulState::seeded(SEED);
        let mut mid = start.clone();
        for &a in actions.iter().take(40) {
            mid.apply(a).expect("a recorded move is legal");
        }
        Workload { actions, start, mid }
    }

    pub fn plies(&self) -> usize {
        self.actions.len()
    }

    /// One timed run of each figure: plies per second, nanoseconds per clone.
    pub fn run_once(&self) -> (f64, f64) {
        (plies_per_second_once(&self.start, &self.actions), clone_ns_once(&self.mid))
    }
}

/// The protocol of [R9-18], over any source of runs: `WARMUP_RUNS` discarded,
/// then the median of `TIMED_RUNS`, for each of the two figures a run yields.
pub fn protocol(mut run: impl FnMut(usize) -> (f64, f64)) -> (f64, f64) {
    let mut a = Vec::new();
    let mut b = Vec::new();
    for i in 0..WARMUP_RUNS + TIMED_RUNS {
        let (x, y) = run(i);
        if i >= WARMUP_RUNS {
            a.push(x);
            b.push(y);
        }
    }
    (median(a), median(b))
}

/// Three discarded runs, then the median of nine, for each figure.
pub fn measure() -> Figures {
    let w = Workload::new();
    let (plies_per_second, clone_ns) = protocol(|_| w.run_once());
    Figures { plies: w.plies(), plies_per_second, clone_ns }
}

/// Writes `contents` to `path` only whole: to a temporary file beside it, then
/// renamed into place, so a run that stops early leaves the old file as it was
/// ([R9-19]).
pub fn write_whole(path: &std::path::Path, contents: &str) -> std::io::Result<()> {
    let tmp = path.with_extension("partial");
    std::fs::write(&tmp, contents)?;
    std::fs::rename(&tmp, path)
}
