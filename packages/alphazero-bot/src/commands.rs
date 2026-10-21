//! The commands. Argument errors, unreadable files, refused checkpoints and
//! malformed positions are all error exits with a message ([Z11-22]).

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::Instant;

use azul_alphazero::config::{RunConfig, SearchKind, Settings, settings};
use azul_alphazero::network::{Evaluation, Evaluator, Network};
use azul_alphazero::parity;
use azul_alphazero::memo::{Memo, search_memoised_until};
use azul_alphazero::samples::aux_path;
use azul_alphazero::endgame::refine;
use azul_alphazero::search::{SearchResult, choose, search_until};
use azul_alphazero::selfplay::{GAMES_PER_THREAD, self_play};
use azul_alphazero::wire::{frame, read_canonical, read_message, read_messages};
use azul_engine::{AzulState, Seeded};
use clap::{Parser, Subcommand, ValueEnum};
use serde::Serialize;
use sha2::{Digest, Sha256};

/// Each command loads one checkpoint, parity checked, and one run's
/// `config.json`. Only `latency` takes `--simulations` ([Z11-60]).
#[derive(Parser)]
#[command(name = "alphazero", about = "The trained player's commands (spec 0011).")]
pub struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Clone, Copy, ValueEnum)]
enum Search {
    Play,
    Milestone,
}

#[derive(Subcommand)]
enum Command {
    /// One position on stdin, one answer on stdout ([Z11-23]).
    Play {
        checkpoint: PathBuf,
        #[arg(long)]
        config: PathBuf,
        #[arg(long, value_enum)]
        search: Search,
        #[command(flatten)]
        timing: Timing,
    },
    /// Positions on stdin one after another, each answered on stdout as `play`
    /// answers it, until stdin ends ([Z11-72]).
    Serve {
        checkpoint: PathBuf,
        #[arg(long)]
        config: PathBuf,
        #[arg(long, value_enum)]
        search: Search,
        #[command(flatten)]
        timing: Timing,
    },
    /// Self-play games, written as a sample file ([Z11-26]).
    Selfplay {
        checkpoint: PathBuf,
        #[arg(long)]
        config: PathBuf,
        #[arg(long)]
        generation: u64,
        #[arg(long, value_parser = clap::value_parser!(u64).range(1..=1_000_000))]
        games: u64,
        #[arg(long)]
        out: PathBuf,
    },
    /// `choose` timed on every corpus position ([Z11-40], [Z11-57]).
    Latency {
        checkpoint: PathBuf,
        corpus: PathBuf,
        #[arg(long)]
        config: PathBuf,
        #[arg(long)]
        simulations: Option<u32>,
    },
    /// Self-play's speed, written beside the config ([Z11-53]).
    Throughput {
        checkpoint: PathBuf,
        #[arg(long)]
        config: PathBuf,
    },
}

/// `play`'s and `serve`'s clock and split answer ([0013 G13-27], [0013 G13-29]).
/// The clock is a stop the command applies, not a search setting
/// ([Z11-60]): the count's ceiling is still the config's.
#[derive(clap::Args, Clone, Copy)]
struct Timing {
    /// [Z11-78]: stop after the first whole simulation that ends at or past
    /// this many milliseconds of search.
    #[arg(long)]
    clock_ms: Option<u64>,
    /// [Z11-79]: answer in five words, the search's and the proof's
    /// milliseconds apart.
    #[arg(long)]
    split_ms: bool,
}

fn read(path: &Path) -> Result<Vec<u8>, String> {
    std::fs::read(path).map_err(|e| format!("{}: {e}", path.display()))
}

/// Writes to a temporary name and renames, so no reader ever sees a partial
/// file ([Z11-30]).
fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let tmp = path.with_extension(format!("tmp-{}", std::process::id()));
    std::fs::write(&tmp, bytes).map_err(|e| format!("{}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, path).map_err(|e| format!("{}: {e}", path.display()))
}

fn to_json<T: Serialize>(value: &T) -> String {
    // Plain data with string keys: serialisation cannot fail.
    let mut s = serde_json::to_string_pretty(value).unwrap_or_default();
    s.push('\n');
    s
}

struct Loaded {
    net: Network,
    config: RunConfig,
    checkpoint_sha256: String,
}

/// A checkpoint and the parity file beside it (`x.bin` → `x.parity`), and a
/// config. Only a command that batches its evaluations keeps the network's
/// row-major matrices: one that searches alone holds each matrix once.
fn load(checkpoint: &Path, config: &Path, batched: bool) -> Result<Loaded, String> {
    let bytes = read(checkpoint)?;
    let parity = read(&checkpoint.with_extension("parity"))
        .map_err(|e| format!("no parity file beside the checkpoint, so it is not loaded ([Z11-13]): {e}"))?;
    let net = if batched { Network::load(&bytes, &parity) } else { Network::load_single(&bytes, &parity) };
    let net = net.map_err(|e| format!("{}: {e}", checkpoint.display()))?;
    let config = RunConfig::parse(&read(config)?)?;
    let (w, b) = net.architecture();
    if (w, b) != (config.width, config.blocks) {
        return Err(format!(
            "the checkpoint is {w} wide and {b} blocks deep, the config {} and {}",
            config.width, config.blocks
        ));
    }
    Ok(Loaded { net, config, checkpoint_sha256: hex::encode(Sha256::digest(&bytes)) })
}

pub fn run(cli: Cli) -> Result<(), String> {
    match cli.command {
        Command::Play { checkpoint, config, search, timing } => play(&checkpoint, &config, search, timing),
        Command::Serve { checkpoint, config, search, timing } => serve(&checkpoint, &config, search, timing),
        Command::Selfplay { checkpoint, config, generation, games, out } => {
            selfplay(&checkpoint, &config, generation, games, &out)
        }
        Command::Latency { checkpoint, corpus, config, simulations } => {
            latency(&checkpoint, &corpus, &config, simulations)
        }
        Command::Throughput { checkpoint, config } => throughput(&checkpoint, &config),
    }
}

fn search_kind(search: Search) -> SearchKind {
    match search {
        Search::Play => SearchKind::Play,
        Search::Milestone => SearchKind::Milestone,
    }
}

/// A canonical block as the state `play` searches ([Z11-23]).
fn position(block: &[u32]) -> Result<AzulState<Seeded>, String> {
    let canonical = read_canonical(block)?;
    AzulState::from_canonical(&canonical, Seeded::new(0)).map_err(|e| format!("the position was refused: {e:?}"))
}

const TERMINAL: &str = "the position is terminal: there is no move to choose ([Z11-62])";

/// A clock's stop for [Z11-78], or one that never stops.
fn stopper(clock_ms: Option<u64>, started: Instant) -> impl FnMut() -> bool {
    move || clock_ms.is_some_and(|ms| started.elapsed().as_secs_f64() * 1000.0 >= ms as f64)
}

/// A move found by search then proof, each timed, around its own part
/// ([Z11-79]). The result is `choose`'s ([Z11-78]).
struct Answer {
    result: SearchResult,
    search_ms: f64,
    proof_ms: f64,
}

/// The four words of [Z11-23] — the action, the simulations run, the root
/// value's bits and the milliseconds — or, under `--split-ms`, five: the
/// search's milliseconds and the proof's in place of their sum ([Z11-79]).
fn answer(out: &mut impl Write, a: &Answer, split: bool) -> Result<(), String> {
    let r = &a.result;
    let simulations: u32 = r.visits.iter().sum();
    let mut words = vec![u32::from(r.action), simulations, r.value.to_bits()];
    if split {
        words.extend([a.search_ms.round() as u32, a.proof_ms.round() as u32]);
    } else {
        words.push((a.search_ms + a.proof_ms).round() as u32);
    }
    out.write_all(&frame(&words)).and_then(|()| out.flush()).map_err(|e| format!("writing stdout: {e}"))
}

/// The proof of [Z11-76] after a search that ran in `search_ms`.
fn proved<S: azul_engine::Shuffler>(state: &AzulState<S>, result: SearchResult, nodes: u32, search_ms: f64) -> Answer {
    let started = Instant::now();
    let result = refine(state, result, nodes).0;
    Answer { result, search_ms, proof_ms: started.elapsed().as_secs_f64() * 1000.0 }
}

/// [Z11-23]: one position in, four words out, nothing kept.
fn play(checkpoint: &Path, config: &Path, search: Search, timing: Timing) -> Result<(), String> {
    let loaded = load(checkpoint, config, false)?;
    let s = settings(&loaded.config, search_kind(search))?;
    let mut input = Vec::new();
    std::io::stdin().read_to_end(&mut input).map_err(|e| format!("reading stdin: {e}"))?;
    let messages = read_messages(&input)?;
    let [block] = messages.as_slice() else {
        return Err(format!("expected one message on stdin, got {}", messages.len()));
    };
    let state = position(block)?;
    let started = Instant::now();
    let Some((result, _)) = search_until(&loaded.net, &state, &s.search, None, &mut stopper(timing.clock_ms, started))
    else {
        return Err(TERMINAL.into());
    };
    let a = proved(&state, result, s.search.endgame_nodes, started.elapsed().as_secs_f64() * 1000.0);
    answer(&mut std::io::stdout().lock(), &a, timing.split_ms)
}

/// [Z11-72]: `play` for a whole game in one process. The checkpoint is loaded
/// and parity checked once; each position is answered before the next is
/// read, from a memo of the evaluations made so far ([Z11-69]), emptied
/// whenever a position's round differs from the one before it.
fn serve(checkpoint: &Path, config: &Path, search: Search, timing: Timing) -> Result<(), String> {
    let loaded = load(checkpoint, config, false)?;
    let s = settings(&loaded.config, search_kind(search))?;
    let mut input = std::io::stdin().lock();
    let mut out = std::io::stdout().lock();
    let mut memo = Memo::new();
    let mut round = None;
    while let Some(block) = read_message(&mut input)? {
        let state = position(&block)?;
        if round != Some(state.round_index()) {
            memo.clear();
            round = Some(state.round_index());
        }
        let started = Instant::now();
        let mut stop = stopper(timing.clock_ms, started);
        let Some(result) = search_memoised_until(&loaded.net, &state, &s.search, &mut memo, &mut stop) else {
            return Err(TERMINAL.into());
        };
        let a = proved(&state, result, s.search.endgame_nodes, started.elapsed().as_secs_f64() * 1000.0);
        answer(&mut out, &a, timing.split_ms)?;
    }
    Ok(())
}

/// [Z11-26].
fn selfplay(checkpoint: &Path, config: &Path, generation: u64, games: u64, out: &Path) -> Result<(), String> {
    let loaded = load(checkpoint, config, true)?;
    let s = settings(&loaded.config, SearchKind::SelfPlay)?;
    let (bytes, aux) = self_play(&loaded.net, &s, loaded.config.seed, generation, games as usize);
    // The aux file first: a complete sample file then always has its aux file
    // beside it, and the loop takes the sample file as self-play's commit
    // point ([Z11-28], [Z11-67]).
    write_atomic(&aux_path(out), &aux)?;
    write_atomic(out, &bytes)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LatencyReport {
    simulations: u32,
    checkpoint_sha256: String,
    measured: usize,
    skipped: u64,
    milliseconds: Vec<f64>,
}

/// [Z11-40]: `choose` timed on every corpus position, single-threaded, from
/// the position handed in to the action returned.
fn latency(checkpoint: &Path, corpus: &Path, config: &Path, simulations: Option<u32>) -> Result<(), String> {
    let loaded = load(checkpoint, config, false)?;
    let s = settings(&loaded.config, SearchKind::Latency(simulations))?;
    let mut states = Vec::new();
    for (i, block) in read_messages(&read(corpus)?)?.iter().enumerate() {
        let c = read_canonical(block).map_err(|e| format!("corpus position {i}: {e}"))?;
        let st = AzulState::from_canonical(&c, Seeded::new(0))
            .map_err(|e| format!("corpus position {i} was refused: {e:?}"))?;
        states.push(st);
    }
    let mut times = Vec::new();
    let mut skipped = 0u64;
    for st in &states {
        let started = Instant::now();
        let chosen = choose(&loaded.net, st, &s.search);
        let ms = started.elapsed().as_secs_f64() * 1000.0;
        match chosen {
            Some(_) => times.push(ms),
            None => skipped += 1, // [Z11-62]
        }
    }
    print!(
        "{}",
        to_json(&LatencyReport {
            simulations: s.search.simulations,
            checkpoint_sha256: loaded.checkpoint_sha256,
            measured: times.len(),
            skipped,
            milliseconds: times,
        })
    );
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ThroughputReport {
    checkpoint_sha256: String,
    simulations: u32,
    threads: u32,
    evaluations_per_second: f64,
    games_timed: u64,
    samples_written: usize,
    games_per_hour: f64,
    games_per_generation: u32,
    minutes_per_generation: f64,
    max_generation_minutes: f64,
    passed: bool,
}

/// [Z11-53]: evaluations a second single-threaded, self-play games an hour at
/// the run's threads, and what that makes a generation cost. Written beside
/// the config, as `throughput.json`.
fn throughput(checkpoint: &Path, config: &Path) -> Result<(), String> {
    let loaded = load(checkpoint, config, true)?;
    let s: Settings = settings(&loaded.config, SearchKind::SelfPlay)?;

    let corpus = parity::corpus();
    let mut eval = Evaluation::default();
    let legal: Vec<u8> = (0..180).collect();
    let started = Instant::now();
    let mut evaluations = 0u64;
    while started.elapsed().as_secs_f64() < 3.0 {
        for e in corpus {
            loaded.net.evaluate(&e.observation, &legal, &mut eval);
            evaluations += 1;
        }
    }
    let per_second = evaluations as f64 / started.elapsed().as_secs_f64();

    // Enough games that every thread fills its batch twice over ([Z11-70]).
    let games = u64::from(s.threads) * GAMES_PER_THREAD as u64 * 2;
    let started = Instant::now();
    // Seeded apart from any generation a run will play: the games are thrown away.
    let (bytes, _) = self_play(&loaded.net, &s, loaded.config.seed ^ 0x7468_726f_7567_6870, u64::MAX, games as usize);
    let seconds = started.elapsed().as_secs_f64();
    let per_hour = games as f64 / seconds * 3600.0;
    let minutes = f64::from(loaded.config.games_per_generation) / per_hour * 60.0;
    let text = to_json(&ThroughputReport {
        checkpoint_sha256: loaded.checkpoint_sha256,
        simulations: s.search.simulations,
        threads: s.threads,
        evaluations_per_second: per_second.round(),
        games_timed: games,
        samples_written: bytes.len() / azul_alphazero::samples::RECORD_BYTES,
        games_per_hour: per_hour.round(),
        games_per_generation: loaded.config.games_per_generation,
        minutes_per_generation: (minutes * 10.0).round() / 10.0,
        max_generation_minutes: loaded.config.max_generation_minutes,
        passed: minutes <= loaded.config.max_generation_minutes,
    });
    let dir = config.parent().unwrap_or(Path::new("."));
    write_atomic(&dir.join("throughput.json"), text.as_bytes())?;
    print!("{text}");
    Ok(())
}
