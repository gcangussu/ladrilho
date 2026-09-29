//! The binary's commands: `play`'s protocol ([Z11-23]), its answers to bad
//! input ([Z11-22]), its determinism ([Z11-24]), and where each command reads
//! its search settings ([Z11-60]).

mod support;

use azul_alphazero::wire::{frame, write_canonical};
use azul_engine::AzulState;
use support::{config_json, fixture_paths, run, scratch};

fn words(bytes: &[u8]) -> Vec<u32> {
    bytes.as_chunks::<4>().0.iter().map(|w| u32::from_le_bytes(*w)).collect()
}

fn block_of(s: &AzulState) -> Vec<u32> {
    write_canonical(&s.to_canonical())
}

struct Env {
    checkpoint: String,
    config: String,
    /// Holds the scratch directory for as long as the environment lives.
    _dir: tempfile::TempDir,
}

fn env(overrides: &[(&str, &str)]) -> Env {
    let dir = scratch();
    let config = dir.path().join("config.json");
    std::fs::write(&config, config_json(overrides)).unwrap();
    Env {
        checkpoint: fixture_paths().0.to_str().unwrap().into(),
        config: config.to_str().unwrap().into(),
        _dir: dir,
    }
}

fn play(e: &Env, search: &str, stdin: &[u8]) -> std::process::Output {
    run(&["play", &e.checkpoint, "--config", &e.config, "--search", search], stdin)
}

fn stderr(o: &std::process::Output) -> String {
    String::from_utf8_lossy(&o.stderr).into_owned()
}

/// [Z11-23]: one canonical block in, four words out — a legal action, the
/// simulations run, the root value's bits, and milliseconds. [Z11-60]: `--search`
/// picks `playSimulations` or `milestoneSimulations` from the config.
#[test]
fn play_answers_in_four_words() {
    let e = env(&[("playSimulations", "40"), ("milestoneSimulations", "24")]);
    let s = AzulState::seeded(17);
    for (search, want) in [("play", 40), ("milestone", 24)] {
        let o = play(&e, search, &frame(&block_of(&s)));
        assert!(o.status.success(), "{}", stderr(&o));
        let w = words(&o.stdout);
        assert_eq!(w.len(), 5);
        assert_eq!(w[0], 4, "the length prefix");
        assert!(s.is_legal(w[1] as u8));
        assert_eq!(w[2], want);
        let v = f32::from_bits(w[3]);
        assert!((-1.0..=1.0).contains(&v));
    }
}

/// [Z11-24]: the same checkpoint, config, search and position give the same
/// action and value, run after run.
#[test]
fn play_is_deterministic() {
    let e = env(&[]);
    let mut s = AzulState::seeded(3);
    for _ in 0..30 {
        let a = s.legal_actions().as_slice()[0];
        s.apply(a).unwrap();
    }
    let input = frame(&block_of(&s));
    let first = words(&play(&e, "play", &input).stdout);
    for _ in 0..2 {
        let again = words(&play(&e, "play", &input).stdout);
        assert_eq!(first[..4], again[..4]);
    }
}

/// [Z11-22]: truncated and malformed blocks are error exits with a message,
/// never a panic. A panic exits 101; an error exit here is 2.
#[test]
fn play_refuses_bad_input_without_panicking() {
    let e = env(&[]);
    let good = block_of(&AzulState::seeded(5));
    let mut cases: Vec<(&str, Vec<u8>)> = vec![
        ("empty", Vec::new()),
        ("a short length", vec![1, 0]),
        ("a body shorter than its length", frame(&good)[..40].to_vec()),
        ("a block cut short", frame(&good[..good.len() - 3])),
        ("words past the block", frame(&[good.clone(), vec![0]].concat())),
        ("two messages", [frame(&good), frame(&good)].concat()),
        ("a huge length", vec![0xff, 0xff, 0xff, 0x7f]),
    ];
    let mut bad = |at: usize, v: u32, what: &'static str| {
        let mut b = good.clone();
        b[at] = v;
        cases.push((what, frame(&b)));
    };
    bad(0, 300, "a count past a byte");
    bad(30, 2, "a flag of 2");
    bad(31, 101, "a bag of 101");
    let len = good[31] as usize;
    bad(32 + len + 5 + 50, 7, "a pattern colour of 7");
    bad(good.len() - 4, 0, "tilesLeft disagreeing with the board");
    bad(good.len() - 7, 2, "a third seat");
    for (what, input) in cases {
        let o = play(&e, "play", &input);
        assert_eq!(o.status.code(), Some(2), "{what}: {}", stderr(&o));
        assert!(stderr(&o).starts_with("alphazero: "), "{what}");
    }
}

/// [Z11-62]: `play` answers a terminal position with an error exit naming it.
#[test]
fn play_refuses_a_terminal_position() {
    let e = env(&[]);
    let mut s = AzulState::seeded(8);
    while !s.is_terminal() {
        let a = s.legal_actions().as_slice()[0];
        s.apply(a).unwrap();
    }
    let o = play(&e, "play", &frame(&block_of(&s)));
    assert_eq!(o.status.code(), Some(2));
    assert!(stderr(&o).contains("terminal"));
}

/// [Z11-60]: `--simulations` is refused by every command but `latency`, which
/// uses it; and [Z11-58]: while `playSimulations` is unset, `play --search
/// play` refuses to run and `latency` requires `--simulations`.
#[test]
fn simulations_are_read_from_one_place() {
    let e = env(&[]);
    let dir = std::path::Path::new(&e.config).parent().unwrap().to_path_buf();
    let out = dir.join("x.bin");
    for args in [
        vec!["play", &e.checkpoint, "--config", &e.config, "--search", "play", "--simulations", "5"],
        vec!["selfplay", &e.checkpoint, "--config", &e.config, "--generation", "0", "--games", "1", "--out", out.to_str().unwrap(), "--simulations", "5"],
        vec!["throughput", &e.checkpoint, "--config", &e.config, "--simulations", "5"],
    ] {
        let o = run(&args, &[]);
        assert_eq!(o.status.code(), Some(2));
        assert!(stderr(&o).contains("unexpected argument '--simulations'"), "{}", stderr(&o));
    }
    let corpus = dir.join("corpus.bin");
    let mut s = AzulState::seeded(1);
    let mut bytes = frame(&block_of(&s));
    s.apply(s.legal_actions().as_slice()[0]).unwrap();
    bytes.extend(frame(&block_of(&s)));
    std::fs::write(&corpus, &bytes).unwrap();
    let o = run(&["latency", &e.checkpoint, corpus.to_str().unwrap(), "--config", &e.config, "--simulations", "5"], &[]);
    assert!(o.status.success(), "{}", stderr(&o));
    let doc: serde_json::Value = serde_json::from_slice(&o.stdout).unwrap();
    assert_eq!(doc.get("simulations").and_then(|v| v.as_u64()), Some(5));
    assert_eq!(doc.get("measured").and_then(|v| v.as_u64()), Some(2));
    assert_eq!(doc.get("skipped").and_then(|v| v.as_u64()), Some(0));

    let unset = env(&[("playSimulations", "null")]);
    let o = play(&unset, "play", &frame(&block_of(&AzulState::seeded(2))));
    assert_eq!(o.status.code(), Some(2));
    assert!(stderr(&o).contains("playSimulations is unset"));
    let o = play(&unset, "milestone", &frame(&block_of(&AzulState::seeded(2))));
    assert!(o.status.success(), "milestones do not need it: {}", stderr(&o));
    let o = run(&["latency", &unset.checkpoint, corpus.to_str().unwrap(), "--config", &unset.config], &[]);
    assert_eq!(o.status.code(), Some(2));
    assert!(stderr(&o).contains("needs --simulations"));
}

/// [Z11-13]: no command loads a checkpoint without its parity file; and a
/// config whose architecture is not the checkpoint's is refused.
#[test]
fn a_checkpoint_without_parity_is_not_loaded() {
    let e = env(&[]);
    let dir = std::path::Path::new(&e.config).parent().unwrap();
    let lone = dir.join("lone.bin");
    std::fs::copy(fixture_paths().0, &lone).unwrap();
    let input = frame(&block_of(&AzulState::seeded(2)));
    let o = run(&["play", lone.to_str().unwrap(), "--config", &e.config, "--search", "play"], &input);
    assert_eq!(o.status.code(), Some(2));
    assert!(stderr(&o).contains("no parity file"));

    let wide = env(&[("width", "32")]);
    let o = play(&wide, "play", &input);
    assert_eq!(o.status.code(), Some(2));
    assert!(stderr(&o).contains("wide"));
}
