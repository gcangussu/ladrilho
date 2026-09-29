//! Shared harness: paths, the fixture network, test evaluators, hand-built
//! positions, and running the binary.
//!
//! Each integration test is its own crate and uses a different slice of this
//! module, hence the blanket `dead_code` allowance.
#![allow(dead_code)]

use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::io::Write;
use std::sync::atomic::{AtomicU32, Ordering};

use azul_alphazero::network::{Evaluation, Evaluator, Network};
use azul_engine::{Action, AzulState, Canonical, ENCODED_SIZE, Player, Seeded};

pub fn crate_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

pub fn repo_root() -> PathBuf {
    crate_dir().join("../..")
}

pub fn read(path: &Path) -> Vec<u8> {
    std::fs::read(path).unwrap_or_else(|e| panic!("{}: {e}", path.display()))
}

pub fn fixture_paths() -> (PathBuf, PathBuf) {
    let dir = crate_dir().join("test/fixtures");
    (dir.join("checkpoint.bin"), dir.join("checkpoint.parity"))
}

/// The fixture checkpoint of [Z11-44]: `W = 16`, `B = 1`, random weights.
pub fn fixture() -> Network {
    let (c, p) = fixture_paths();
    Network::load(&read(&c), &read(&p)).unwrap_or_else(|e| panic!("the fixture: {e}"))
}

/// A network whose weights are all zero: a uniform policy over the legal set
/// and a value of 0.
pub struct Zero;

impl Evaluator for Zero {
    fn evaluate(&self, _: &[f32; ENCODED_SIZE], legal: &[Action], out: &mut Evaluation) {
        out.policy = [0.0; 180];
        for &a in legal {
            out.policy[usize::from(a)] = 1.0 / legal.len() as f32;
        }
        out.value = 0.0;
    }
}

/// Wraps an evaluator and counts its calls.
pub struct Counting<E> {
    pub inner: E,
    pub calls: AtomicU32,
}

impl<E> Counting<E> {
    pub fn new(inner: E) -> Self {
        Counting { inner, calls: AtomicU32::new(0) }
    }
    pub fn calls(&self) -> u32 {
        self.calls.load(Ordering::SeqCst)
    }
}

impl<E: Evaluator> Evaluator for Counting<E> {
    fn evaluate(&self, o: &[f32; ENCODED_SIZE], legal: &[Action], out: &mut Evaluation) {
        self.calls.fetch_add(1, Ordering::SeqCst);
        self.inner.evaluate(o, legal, out);
    }
}

/// An empty board with player 0 to move: no tiles anywhere, the marker in the
/// centre. Tests fill in what they need and load it with `pose`.
pub fn blank() -> Canonical {
    Canonical {
        factories: [[0; 5]; 5],
        center: [0; 5],
        marker_in_center: true,
        bag: Vec::new(),
        lid: [0; 5],
        walls: [[0; 25]; 2],
        pl_color: [[-1; 5]; 2],
        pl_count: [[0; 5]; 2],
        floor: [[0; 5]; 2],
        floor_marker: [false; 2],
        scores: [0; 2],
        current_player: Player::P0,
        first_player: Player::P0,
        round_index: 0,
        tiles_left: 0,
        shuffles_used: 0,
        is_terminal: false,
        exhausted: false,
    }
}

/// Loads a hand-built snapshot, deriving `tiles_left` from its board.
pub fn pose(mut c: Canonical, seed: u64) -> AzulState<Seeded> {
    let board: u32 = c.factories.iter().flatten().chain(&c.center).map(|&n| u32::from(n)).sum();
    c.tiles_left = board as u8;
    AzulState::from_canonical(&c, Seeded::new(seed)).unwrap_or_else(|e| panic!("posed position refused: {e:?}"))
}

/// Every position of a game seeded `seed`, moves uniform from the crate's
/// own generator.
pub fn game_positions(seed: u64) -> Vec<AzulState<Seeded>> {
    let mut s = AzulState::seeded(seed);
    let mut rng = azul_alphazero::rng::Rng::new(seed ^ 0xabcdef);
    let mut out = Vec::new();
    while !s.is_terminal() {
        out.push(s.clone());
        let legal = s.legal_actions();
        let a = legal.as_slice()[rng.below(legal.len() as u64) as usize];
        s.apply(a).unwrap();
    }
    out
}

pub fn binary() -> PathBuf {
    PathBuf::from(env!("CARGO_BIN_EXE_alphazero"))
}

/// Runs the binary with `stdin` fed in.
pub fn run(args: &[&str], stdin: &[u8]) -> Output {
    let mut child = Command::new(binary())
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("the binary runs");
    let mut input = child.stdin.take().unwrap();
    let _ = input.write_all(stdin);
    drop(input);
    child.wait_with_output().unwrap()
}

/// A fresh scratch directory, removed when the returned guard drops.
pub fn scratch() -> tempfile::TempDir {
    tempfile::Builder::new().prefix("alphazero-test-").tempdir().expect("a scratch directory")
}

/// A config for the fixture network, with the given overrides as raw JSON.
pub fn config_json(overrides: &[(&str, &str)]) -> String {
    let mut fields: Vec<(String, String)> = [
        ("width", "16"),
        ("blocks", "1"),
        ("seed", "12345"),
        ("playSimulations", "40"),
        ("milestoneSimulations", "24"),
        ("selfPlaySimulations", "8"),
        ("cpuct", "1.25"),
        ("fpu", "0.25"),
        ("alpha", "0.3"),
        ("epsilon", "0.25"),
        ("tempPlies", "10"),
        ("tau", "1"),
        ("threads", "4"),
        ("gamesPerGeneration", "500"),
        ("maxGenerationMinutes", "30"),
    ]
    .iter()
    .map(|(k, v)| (k.to_string(), v.to_string()))
    .collect();
    for (k, v) in overrides {
        match fields.iter_mut().find(|(f, _)| f == k) {
            Some(f) => f.1 = v.to_string(),
            None => fields.push((k.to_string(), v.to_string())),
        }
    }
    let body: Vec<String> = fields.iter().filter(|(_, v)| v != "<absent>").map(|(k, v)| format!("\"{k}\": {v}")).collect();
    format!("{{{}}}", body.join(", "))
}
