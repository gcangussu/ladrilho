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

fn serve(e: &Env, search: &str, stdin: &[u8]) -> std::process::Output {
    run(&["serve", &e.checkpoint, "--config", &e.config, "--search", search], stdin)
}

/// [Z11-72]: `serve`, handed every position of one game and the start of
/// another in a single stream, answers each with exactly the action,
/// simulations and value `play` gives that position alone ([Z11-24]), in
/// order — though its memo has run through both games and a dozen rounds.
///
/// Mutation, seen red ([Z11-48]), in a copy with its anchor confirmed: in
/// `memo.rs`, the key built from the first 100 observation floats alone
/// (`buf.iter_mut().zip(&observation[..100])`), which hands back another
/// position's evaluation.
#[test]
fn serve_answers_each_position_as_play_does() {
    let e = env(&[("milestoneSimulations", "24")]);
    let mut positions = support::game_positions(21);
    positions.extend(support::game_positions(22).into_iter().take(12));
    let input: Vec<u8> = positions.iter().flat_map(|s| frame(&block_of(s))).collect();
    let o = serve(&e, "milestone", &input);
    assert!(o.status.success(), "{}", stderr(&o));
    let served = words(&o.stdout);
    assert_eq!(served.len(), 5 * positions.len(), "one answer per position");
    for (i, s) in positions.iter().enumerate() {
        let alone = words(&play(&e, "milestone", &frame(&block_of(s))).stdout);
        assert_eq!(served[5 * i..5 * i + 4], alone[..4], "position {i}: serve and play disagree");
    }
}

/// [Z11-72]: `serve` ends cleanly when its input ends between positions, and
/// refuses with an error exit, after answering every whole position before
/// it, a stream cut inside a position, or a terminal position ([Z11-22],
/// [Z11-62]).
#[test]
fn serve_ends_at_the_end_of_its_input_and_refuses_bad_input() {
    let e = env(&[]);
    let empty = serve(&e, "play", &[]);
    assert!(empty.status.success(), "{}", stderr(&empty));
    assert!(empty.stdout.is_empty());

    let s = AzulState::seeded(5);
    let one = frame(&block_of(&s));
    let mut cut = [one.clone(), one.clone()].concat();
    cut.extend_from_slice(&one[..one.len() - 3]);
    let o = serve(&e, "play", &cut);
    assert_eq!(o.status.code(), Some(2));
    assert_eq!(o.stdout.len(), 2 * 20, "the two whole positions are answered");
    assert!(stderr(&o).contains("cut short"), "{}", stderr(&o));

    let mut end = AzulState::seeded(8);
    while !end.is_terminal() {
        let a = end.legal_actions().as_slice()[0];
        end.apply(a).unwrap();
    }
    let o = serve(&e, "play", &frame(&block_of(&end)));
    assert_eq!(o.status.code(), Some(2));
    assert!(stderr(&o).contains("terminal"), "{}", stderr(&o));
}

fn serve_with(e: &Env, extra: &[&str], stdin: &[u8]) -> std::process::Output {
    let mut args = vec!["serve", &e.checkpoint, "--config", &e.config, "--search", "play"];
    args.extend_from_slice(extra);
    run(&args, stdin)
}

/// [Z11-78], [Z11-23] as amended by spec 0013 [G13-27]: `serve --clock-ms 0` and
/// `play --clock-ms 0` stop after the first whole simulation, so they answer
/// every position with one simulation and exactly the move and value `play`
/// gives at `playSimulations: 1` — the count stays the config's ceiling, and
/// the command, not the library, reads the clock.
///
/// Mutation, seen red ([Z11-48]), in a copy with its anchor confirmed: in
/// `serve`, `&mut || false` passed in place of `&mut stop`, which answers
/// with the ceiling's move; the case fails on the simulations word.
#[test]
fn a_clocked_serve_is_the_search_of_its_count() {
    let ceiling = env(&[("playSimulations", "300")]);
    let one = env(&[("playSimulations", "1")]);
    let positions: Vec<_> = support::game_positions(41).into_iter().step_by(4).collect();
    let input: Vec<u8> = positions.iter().flat_map(|s| frame(&block_of(s))).collect();
    let o = serve_with(&ceiling, &["--clock-ms", "0"], &input);
    assert!(o.status.success(), "{}", stderr(&o));
    let served = words(&o.stdout);
    assert_eq!(served.len(), 5 * positions.len());
    for (i, s) in positions.iter().enumerate() {
        let block = frame(&block_of(s));
        let alone = words(&play(&one, "play", &block).stdout);
        assert_eq!(served[5 * i + 2], 1, "position {i}: one simulation");
        assert_eq!(served[5 * i + 1..5 * i + 4], alone[1..4], "position {i}");
        let clocked = run(&["play", &ceiling.checkpoint, "--config", &ceiling.config, "--search", "play", "--clock-ms", "0"], &block);
        assert!(clocked.status.success(), "{}", stderr(&clocked));
        assert_eq!(words(&clocked.stdout)[1..4], alone[1..4], "position {i}: play --clock-ms 0");
    }
}

/// [Z11-79]: under `--split-ms`, `play` and `serve` answer in five words —
/// the action, simulations and value of the four-word answer, then the
/// search's milliseconds and the proof's — and the proof's is 0 with the
/// proof off. Without the flag the answer is the four words it always was
/// ([Z11-23]; `play_answers_in_four_words`). The searches run 20 000
/// simulations from positions early in a round, long enough that the search's
/// word is never 0, so the two times cannot be swapped unseen. (Late in a
/// round the tree soon holds only valued leaves, and 20 000 simulations take
/// well under a millisecond.)
///
/// Mutation, seen red ([Z11-48]), in a copy with its anchor confirmed: in
/// `answer`, the proof's milliseconds written before the search's.
#[test]
fn a_split_answer_times_search_and_proof_apart() {
    let e = env(&[("playSimulations", "20000")]);
    let positions: Vec<_> =
        support::game_positions(43).into_iter().filter(|s| s.tiles_left() >= 12).step_by(3).collect();
    for s in &positions {
        let input = frame(&block_of(s));
        let four = words(&play(&e, "play", &input).stdout);
        let o = run(&["play", &e.checkpoint, "--config", &e.config, "--search", "play", "--split-ms"], &input);
        assert!(o.status.success(), "{}", stderr(&o));
        let five = words(&o.stdout);
        assert_eq!(five.len(), 6);
        assert_eq!(five[0], 5, "the length prefix");
        assert_eq!(five[1..4], four[1..4]);
        assert!(five[4] > 0, "the search's milliseconds: {five:?}");
        assert_eq!(five[5], 0, "the proof is off");
    }
    let input: Vec<u8> = positions.iter().flat_map(|s| frame(&block_of(s))).collect();
    let o = serve_with(&e, &["--split-ms"], &input);
    assert!(o.status.success(), "{}", stderr(&o));
    let served = words(&o.stdout);
    assert_eq!(served.len(), 6 * positions.len());
    for (i, s) in positions.iter().enumerate() {
        let four = words(&play(&e, "play", &frame(&block_of(s))).stdout);
        assert_eq!(served[6 * i], 5);
        assert_eq!(served[6 * i + 1..6 * i + 4], four[1..4], "position {i}");
        assert!(served[6 * i + 4] > 0, "position {i}: the search's milliseconds");
        assert_eq!(served[6 * i + 5], 0);
    }
}

/// [Z11-60]: a self-play count is at most 65,535, because a sample stores root
/// visits as `u16` ([Z11-27]); a count that writes no sample — `playSimulations`
/// and `milestoneSimulations` — is bounded only by the search's `u32` visit
/// counts, and a search configured past the old cap runs.
///
/// Mutation, seen red ([Z11-48]), in a copy with its anchor confirmed: in
/// `config.rs`, `playSimulations` bounded by `MAX_SIMULATIONS` again; the
/// 4,294,967,295 config is then refused.
#[test]
fn only_self_play_is_bounded_by_its_sample_format() {
    let input = frame(&block_of(&AzulState::seeded(9)));
    let refused = |overrides: &[(&str, &str)], key: &str| {
        let e = env(overrides);
        let o = play(&e, "play", &input);
        assert_eq!(o.status.code(), Some(2), "{overrides:?}");
        assert!(stderr(&o).contains(key), "{}", stderr(&o));
    };
    refused(&[("selfPlaySimulations", "65536")], "selfPlaySimulations");
    refused(&[("playSimulations", "4294967296")], "playSimulations");
    refused(&[("milestoneSimulations", "4294967296")], "milestoneSimulations");

    let high = env(&[("playSimulations", "4294967295"), ("milestoneSimulations", "4294967295"), ("selfPlaySimulations", "65535")]);
    let o = run(&["play", &high.checkpoint, "--config", &high.config, "--search", "play", "--clock-ms", "200"], &input);
    assert!(o.status.success(), "{}", stderr(&o));
    let o = run(&["play", &high.checkpoint, "--config", &high.config, "--search", "milestone", "--clock-ms", "200"], &input);
    assert!(o.status.success(), "{}", stderr(&o));
    // Past the old cap, run to the end: the count is the configured one.
    let past = env(&[("playSimulations", "70000")]);
    let w = words(&play(&past, "play", &input).stdout);
    assert_eq!(w[2], 70_000);
}
