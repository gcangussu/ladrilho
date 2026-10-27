//! [T12-26]: the exports, called natively exactly as JavaScript calls them,
//! against the crate's own unmemoised `choose` on the same network and
//! settings — the decoding of [T12-4], the settings of [T12-3] and the memo's
//! transparency, all at once — with the endgame proof on at a cap `load` was
//! given ([T12-33], [0011 Z11-76]), and against `choose_played` with the
//! past-deal refinement `load` was given ([T12-36], [0011 Z11-91]).

use azul_alphazero::endgame::can_end_this_round;
use azul_alphazero::memo::{Memo, choose_memoised};
use azul_alphazero::network::Network;
use azul_alphazero::pastdeal::{PastDeal, choose_played};
use azul_alphazero::rng::Rng;
use azul_alphazero::search::{SearchConfig, choose as crate_choose};
use azul_alphazero::wire::{read_canonical, read_messages, write_canonical};
use azul_alphazero_web::exports;
use azul_engine::{Action, AzulState, Seeded};

const PACKAGE: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/..");
const CPUCT: f32 = 1.25;
const FPU: f32 = 0.25;
const SIMULATIONS: u32 = 800;
/// A cap for these cases: generous, so every proof they start finishes.
const ENDGAME: u32 = 2_000_000;

fn read(path: &str) -> Vec<u8> {
    std::fs::read(format!("{PACKAGE}/{path}")).unwrap_or_else(|e| panic!("{path}: {e}"))
}

/// Writes bytes where JavaScript would: into a buffer `alloc` returned.
fn put(bytes: &[u8]) -> *const u8 {
    let p = exports::alloc(bytes.len());
    // SAFETY: `alloc` returned `bytes.len()` writable bytes.
    unsafe { std::ptr::copy_nonoverlapping(bytes.as_ptr(), p, bytes.len()) };
    p
}

fn load(checkpoint: &[u8], parity: &[u8], endgame_nodes: u32) -> i32 {
    load_with(checkpoint, parity, endgame_nodes, &[])
}

fn load_with(checkpoint: &[u8], parity: &[u8], endgame_nodes: u32, past_deal: &[u8]) -> i32 {
    // SAFETY: every buffer came from `alloc`, at its own length, and is not used again.
    unsafe {
        exports::load(
            put(checkpoint),
            checkpoint.len(),
            put(parity),
            parity.len(),
            CPUCT,
            FPU,
            endgame_nodes,
            put(past_deal),
            past_deal.len(),
        )
    }
}

fn error() -> String {
    // SAFETY: the exports hand out the error string's own bytes.
    let bytes = unsafe { std::slice::from_raw_parts(exports::error_ptr(), exports::error_len()) };
    String::from_utf8(bytes.to_vec()).unwrap()
}

fn choose(block: &[u32], simulations: u32) -> i32 {
    // SAFETY: `words_ptr` is `WORDS` writable words, and no block is longer.
    unsafe { std::ptr::copy_nonoverlapping(block.as_ptr(), exports::words_ptr(), block.len()) };
    exports::choose(block.len(), simulations)
}

// Mutations ([T12-29]), each in a copy with its anchor confirmed: `Player::load`
// storing cpuct and fpu swapped turns this case red at the first position; and
// `Seeded::new(1)` in place of `Seeded::new(0)` in `Player::choose` leaves it
// green, as it must — the search never reads the shuffler before a round
// boundary ([0011 Z11-15]), so no test can see that seed, and none pretends to.
#[test]
fn the_exports_choose_what_the_crate_chooses_bit_for_bit() {
    let (checkpoint, parity) = (read("test/fixtures/checkpoint.bin"), read("test/fixtures/checkpoint.parity"));
    assert_eq!(load(&checkpoint, &parity, ENDGAME), 0, "{}", error());
    let net = Network::load(&checkpoint, &parity).unwrap();
    let config = SearchConfig { simulations: SIMULATIONS, cpuct: CPUCT, fpu: FPU, endgame_nodes: ENDGAME };
    let mut compared = 0;
    for block in read_messages(&read("latency/corpus.bin")).unwrap().iter().step_by(37) {
        let state = AzulState::from_canonical(&read_canonical(block).unwrap(), Seeded::new(0)).unwrap();
        let Some(want) = crate_choose(&net, &state, &config) else {
            assert_eq!(choose(block, SIMULATIONS), -1, "a terminal position");
            continue;
        };
        assert_eq!(choose(block, SIMULATIONS), i32::from(want.action));
        assert_eq!(exports::value().to_bits(), want.value.to_bits());
        compared += 1;
    }
    assert!(compared >= 50, "only {compared} positions compared");
}

/// Late positions where the game can end this round, so the proof runs:
/// games that mostly fill pattern lines, stopped once a wall row holds four
/// tiles and few enough tiles are left for every proof to finish.
fn late_positions(count: usize) -> Vec<AzulState> {
    let mut out = Vec::new();
    let mut rng = Rng::new(33);
    let mut seed = 0;
    while out.len() < count {
        seed += 1;
        let mut s = AzulState::seeded(seed);
        while !s.is_terminal() {
            if can_end_this_round(&s) && s.tiles_left() <= 10 && s.legal_actions().len() > 1 {
                out.push(s.clone());
                break;
            }
            let legal = s.legal_actions();
            let lines: Vec<Action> = legal.as_slice().iter().copied().filter(|a| a % 6 != 5).collect();
            let pool = if !lines.is_empty() && rng.below(10) < 8 { &lines[..] } else { legal.as_slice() };
            s.apply(pool[rng.below(pool.len() as u64) as usize]).unwrap();
        }
    }
    out
}

/// [T12-33], [T12-26]: the cap `load` is given is the cap every move plays
/// at. On late positions where the proof changes the crate's move, the
/// exports play exactly what `choose` plays at that cap, and, loaded at 0,
/// exactly what it plays with the proof off. The count of changed moves is
/// what makes this a test of the cap: on positions where the proof changes
/// nothing, a cap dropped on the way in would pass.
///
/// Mutations ([T12-29]), each in a copy with its anchor confirmed: `Player`
/// building its `SearchConfig` with `endgame_nodes: 0`, and `load` passing a
/// fixed cap instead of its argument, each turn this case red.
#[test]
fn the_exports_play_at_the_cap_load_was_given() {
    let (checkpoint, parity) = (read("test/fixtures/checkpoint.bin"), read("test/fixtures/checkpoint.parity"));
    let net = Network::load(&checkpoint, &parity).unwrap();
    let at = |endgame_nodes| SearchConfig { simulations: SIMULATIONS, cpuct: CPUCT, fpu: FPU, endgame_nodes };
    let positions = late_positions(60);
    let mut changed = 0;
    assert_eq!(load(&checkpoint, &parity, ENDGAME), 0, "{}", error());
    for s in &positions {
        let block = write_canonical(&s.to_canonical());
        let with = crate_choose(&net, s, &at(ENDGAME)).unwrap();
        assert_eq!(choose(&block, SIMULATIONS), i32::from(with.action));
        assert_eq!(exports::value().to_bits(), with.value.to_bits());
        if with.action != crate_choose(&net, s, &at(0)).unwrap().action {
            changed += 1;
        }
    }
    assert!(changed >= 5, "the proof changed only {changed} of {} moves", positions.len());
    assert_eq!(load(&checkpoint, &parity, 0), 0, "{}", error());
    for s in &positions {
        let block = write_canonical(&s.to_canonical());
        assert_eq!(choose(&block, SIMULATIONS), i32::from(crate_choose(&net, s, &at(0)).unwrap().action));
    }
}

/// Round-4 positions of games played uniformly, where the refinement applies.
fn gated_positions(pd: &PastDeal, simulations: u32, count: usize) -> Vec<AzulState> {
    let mut out = Vec::new();
    let mut rng = Rng::new(91);
    let mut seed = 100;
    while out.len() < count {
        seed += 1;
        let mut s = AzulState::seeded(seed);
        while !s.is_terminal() && s.round_index() <= 3 {
            if pd.applies(&s, simulations) && s.tiles_left() <= 8 {
                out.push(s.clone());
                break;
            }
            let legal = s.legal_actions();
            s.apply(legal.as_slice()[rng.below(legal.len() as u64) as usize]).unwrap();
        }
    }
    out
}

/// [T12-26], [T12-36]: loaded with a `pastdeal.json`, the exports play
/// exactly what `choose_played` plays with it, bit for bit, on round-4
/// positions where it applies; and the refinement changes some of those
/// moves, so the case would see it dropped on the way in. The settings are
/// the fixture's own, pinned for the test: 64 leaves, so 12 at 2 000
/// simulations.
///
/// Mutations ([T12-29]), each in a copy with its anchor confirmed: `load`
/// passing an empty buffer for the refinement, and `Player::choose` calling
/// `choose_memoised`, each turn this case red.
#[test]
fn the_exports_play_the_refinement_load_was_given() {
    const SIMS: u32 = 2_000;
    let (checkpoint, parity) = (read("test/fixtures/checkpoint.bin"), read("test/fixtures/checkpoint.parity"));
    let file = read("test/fixtures/pastdeal.json");
    let pd = PastDeal::parse(&file).unwrap();
    let net = Network::load(&checkpoint, &parity).unwrap();
    let config = SearchConfig { simulations: SIMS, cpuct: CPUCT, fpu: FPU, endgame_nodes: ENDGAME };
    assert_eq!(load_with(&checkpoint, &parity, ENDGAME, &file), 0, "{}", error());
    let positions = gated_positions(&pd, SIMS, 20);
    let mut changed = 0;
    for s in &positions {
        let block = write_canonical(&s.to_canonical());
        let want = choose_played(&net, s, &config, Some(&pd), Memo::new()).unwrap();
        assert_eq!(choose(&block, SIMS), i32::from(want.action));
        assert_eq!(exports::value().to_bits(), want.value.to_bits());
        if want.action != choose_memoised(&net, s, &config, Memo::new()).unwrap().action {
            changed += 1;
        }
    }
    assert!(changed >= 2, "the refinement changed only {changed} of {} moves", positions.len());
}

/// [T12-28]: a `pastdeal.json` that is malformed, or fitted to another
/// checkpoint, refuses the load, with the crate's reason.
#[test]
fn a_refused_refinement_refuses_the_load() {
    let (checkpoint, parity) = (read("test/fixtures/checkpoint.bin"), read("test/fixtures/checkpoint.parity"));
    let file = String::from_utf8(read("test/fixtures/pastdeal.json")).unwrap();
    assert_eq!(load_with(&checkpoint, &parity, ENDGAME, b"{"), -1);
    assert!(error().contains("pastdeal.json"), "{}", error());
    let other = file.replacen("ce8343e1", "ce8343e2", 1);
    assert_eq!(load_with(&checkpoint, &parity, ENDGAME, other.as_bytes()), -1);
    assert!(error().contains("fitted to checkpoint"), "{}", error());
    assert_eq!(load_with(&checkpoint, &parity, ENDGAME, file.as_bytes()), 0, "{}", error());
}

#[test]
fn a_refused_load_or_block_says_why() {
    let (checkpoint, mut parity) = (read("test/fixtures/checkpoint.bin"), read("test/fixtures/checkpoint.parity"));
    let last = parity.len() - 1;
    parity[last] ^= 0x40;
    assert_eq!(load(&checkpoint, &parity, ENDGAME), -1);
    assert!(error().contains("parity"), "{}", error());
    let parity = read("test/fixtures/checkpoint.parity");
    assert_eq!(load(&checkpoint, &parity, ENDGAME), 0);
    assert_eq!(choose(&[7; 3], 100), -2);
    assert!(error().contains("block ends"), "{}", error());
}
