//! [T12-26]: the exports, called natively exactly as JavaScript calls them,
//! against the crate's own unmemoised `choose` on the same network and
//! settings — the decoding of [T12-4], the settings of [T12-3] and the memo's
//! transparency, all at once — with the endgame proof on at a cap `load` was
//! given ([T12-33], [0011 Z11-76]).

use azul_alphazero::endgame::can_end_this_round;
use azul_alphazero::network::Network;
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
    // SAFETY: both buffers came from `alloc`, at their own lengths.
    unsafe { exports::load(put(checkpoint), checkpoint.len(), put(parity), parity.len(), CPUCT, FPU, endgame_nodes) }
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
