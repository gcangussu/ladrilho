//! The observation vector, against the oracle and against itself.

mod support;

use azul_engine::*;
use support::{blank, settle};

fn all_states() -> Vec<AzulState<Seeded>> {
    let mut out = Vec::new();
    for seed in 0..10 {
        out.extend(support::self_play(seed));
    }
    for v in support::vectors() {
        for c in std::iter::once(&v.initial).chain(v.plies.iter().map(|p| &p.state)) {
            out.push(AzulState::from_canonical(c, Seeded::new(0)).unwrap());
        }
    }
    out
}

/// [E1-53] ENCODED_SIZE is 182 and every offset has 0001's value.
#[test]
fn the_layout_constants_have_their_values() {
    let offsets = [
        (OFF_MY_WALL, 0), (OFF_OP_WALL, 25), (OFF_MY_LINES, 50), (OFF_OP_LINES, 80),
        (OFF_MY_FLOOR, 110), (OFF_OP_FLOOR, 117), (OFF_SCORES, 124), (OFF_FACTORIES, 126),
        (OFF_FACTORY_FLAGS, 151), (OFF_CENTER, 156), (OFF_CENTER_TOTAL, 161),
        (OFF_MARKER_CENTER, 162), (OFF_BAG, 163), (OFF_LID, 168), (OFF_TILES_LEFT, 173),
        (OFF_I_START, 174), (OFF_ROUND, 175), (OFF_MY_SETS, 176), (OFF_OP_SETS, 179),
    ];
    for (got, want) in offsets {
        assert_eq!(got, want);
    }
    assert_eq!(ENCODED_SIZE, 182);
    assert_eq!(AzulState::seeded(0).encode().len(), 182);
}

/// [V2-38] Every recorded encoding, both seats, value for value: each f32,
/// widened to f64, equals the parsed number exactly.
#[test]
fn encodings_match_the_oracle_exactly() {
    let mut compared = 0;
    let mut faults = Vec::new();
    for v in support::vectors() {
        let states = std::iter::once((&v.initial, v.initial_encoded.as_ref()))
            .chain(v.plies.iter().map(|p| (&p.state, p.encoded.as_ref())));
        for (i, (c, enc)) in states.enumerate() {
            let Some(enc) = enc else { continue };
            let s = AzulState::from_canonical(c, Seeded::new(0)).unwrap();
            for (seat, p) in [Player::P0, Player::P1].into_iter().enumerate() {
                let got = s.encode_for(p);
                for k in 0..ENCODED_SIZE {
                    compared += 1;
                    if f64::from(got[k]) != enc[seat][k] {
                        faults.push(format!("{} state {i} seat {seat} [{k}]: {} != {}", v.name, got[k], enc[seat][k]));
                    }
                }
            }
        }
    }
    assert!(compared > 10_000, "compared only {compared} values");
    assert!(faults.is_empty(), "{}", faults[..faults.len().min(20)].join("\n"));
}

/// [E1-67] encode is encode_for the seat to move; neither changes the state.
#[test]
fn encode_is_the_movers_view() {
    for s in all_states().iter().take(3000) {
        let before = s.clone();
        assert_eq!(s.encode(), s.encode_for(s.current_player()));
        assert_eq!(s, &before);
    }
}

/// [E1-54] An empty pattern line contributes all zeros.
#[test]
fn an_empty_line_encodes_as_zeros() {
    let mut c = blank();
    c.factories[0] = [1, 0, 0, 0, 0];
    c.pl_color[1][2] = 3;
    c.pl_count[1][2] = 2;
    let s = settle(c);
    let v = s.encode_for(Player::P0);
    assert!(v[OFF_MY_LINES..OFF_MY_LINES + 30].iter().all(|&x| x == 0.0));
    let theirs = &v[OFF_OP_LINES + 12..OFF_OP_LINES + 18];
    assert_eq!(theirs, &[0.0, 0.0, 0.0, 1.0, 0.0, (2.0f64 / 3.0) as f32]);
}

/// [E1-55] Bag counts are encoded; bag order is not: two positions differing
/// only in bag order encode identically.
#[test]
fn bag_order_is_not_encoded() {
    let mut a = blank();
    a.factories[0] = [1, 0, 0, 0, 0];
    a.bag = vec![0, 0, 1, 2, 3, 4, 4];
    let mut b = a.clone();
    b.bag = vec![4, 3, 4, 2, 1, 0, 0];
    let (a, b) = (settle(a), settle(b));
    assert_ne!(a, b);
    assert_eq!(a.encode(), b.encode());
    assert_eq!(a.encode()[OFF_BAG..OFF_BAG + 5], [0.1, 0.05, 0.05, 0.05, 0.1]);
}

/// [E1-56] [V2-29] Every value finite and >= 0; the floor slots and the round
/// index clamped to [0, 1]; and no blanket <= 1, because centre counts and
/// scores exceed it lawfully — which this checks happens.
#[test]
fn values_are_finite_non_negative_and_only_two_are_clamped() {
    let mut exceeded = false;
    for s in all_states() {
        for p in [Player::P0, Player::P1] {
            let v = s.encode_for(p);
            assert!(v.iter().all(|x| x.is_finite() && *x >= 0.0));
            for off in [OFF_MY_FLOOR + 5, OFF_OP_FLOOR + 5, OFF_ROUND] {
                assert!(v[off] <= 1.0);
            }
            exceeded |= v.iter().any(|&x| x > 1.0);
        }
    }
    let mut c = blank();
    c.center = [0, 12, 0, 0, 0];
    c.scores = [140, 0];
    let v = settle(c).encode();
    assert!(v[OFF_CENTER + 1] > 1.0 && v[OFF_SCORES] > 1.0);
    let mut c = blank();
    c.factories[0] = [1, 0, 0, 0, 0];
    c.round_index = 25;
    c.floor[0] = [5, 5, 0, 0, 0];
    let v = settle(c).encode();
    assert_eq!((v[OFF_ROUND], v[OFF_MY_FLOOR + 5]), (1.0, 1.0));
    let _ = exceeded;
}

/// [E1-63] [V2-30] The start flag is floor_marker[me] || first_player == me.
/// Before the marker is taken the starter sees 1 and the other seat 0; once
/// the non-starter takes it from the centre, both see 1.
#[test]
fn the_start_flag_is_a_disjunction() {
    let mut c = blank();
    c.factories[0] = [2, 0, 0, 0, 0];
    c.factories[1] = [0, 3, 0, 0, 0];
    c.center = [0, 0, 2, 0, 0];
    let mut s = settle(c);
    let flags = |s: &AzulState<Seeded>| (s.encode_for(Player::P0)[OFF_I_START], s.encode_for(Player::P1)[OFF_I_START]);
    assert_eq!(flags(&s), (1.0, 0.0));
    s.apply(encode_action(0, 0, FLOOR).unwrap()).unwrap(); // the starter, from a display
    assert_eq!(flags(&s), (1.0, 0.0));
    s.apply(encode_action(CENTER, 2, FLOOR).unwrap()).unwrap(); // the non-starter takes the marker
    assert_eq!(flags(&s), (1.0, 1.0));
}

/// [V2-25] The two seats mirror across exactly the five paired regions, each
/// asserted on a position where that pair differs; the shared regions are
/// identical; index 174 is in neither group.
#[test]
fn the_two_seats_mirror_pair_by_pair() {
    let pairs: [(std::ops::Range<usize>, std::ops::Range<usize>); 5] = [
        (0..25, 25..50),
        (50..80, 80..110),
        (110..117, 117..124),
        (124..125, 125..126),
        (176..179, 179..182),
    ];
    let shared: Vec<usize> = (126..174).chain([175]).collect();
    // One position per pair, built so that pair differs between the seats.
    let mut posed = Vec::new();
    for pair in 0..5 {
        let mut c = blank();
        c.factories[0] = [1, 2, 0, 0, 0];
        c.center = [0, 0, 3, 0, 0];
        c.bag = vec![0, 1, 2];
        c.lid = [1, 0, 0, 0, 2];
        c.round_index = 3;
        match pair {
            0 => c.walls[0][7] = 1,
            1 => {
                c.pl_color[1][3] = 4;
                c.pl_count[1][3] = 2;
            }
            2 => {
                c.floor[0] = [0, 0, 0, 2, 0];
                c.marker_in_center = false;
                c.floor_marker[1] = true;
            }
            3 => c.scores = [31, 4],
            _ => {
                for col in 0..5 {
                    c.walls[1][col] = 1;
                }
            }
        }
        posed.push((pair, settle(c)));
    }
    for (pair, s) in &posed {
        let (a, b) = (s.encode_for(Player::P0), s.encode_for(Player::P1));
        let (mine, theirs) = pairs[*pair].clone();
        assert_ne!(a[mine.clone()], a[theirs.clone()], "pair {pair} must differ between the seats");
        for (x, y) in [(mine.clone(), theirs.clone()), (theirs, mine)] {
            assert_eq!(a[x], b[y], "pair {pair} mirrors");
        }
        for &i in &shared {
            assert_eq!(a[i], b[i], "shared index {i}");
        }
    }
    // And on every state the vectors and self-play reach.
    for s in all_states() {
        let (a, b) = (s.encode_for(Player::P0), s.encode_for(Player::P1));
        for (mine, theirs) in &pairs {
            assert_eq!(a[mine.clone()], b[theirs.clone()]);
            assert_eq!(a[theirs.clone()], b[mine.clone()]);
        }
        for &i in &shared {
            assert_eq!(a[i], b[i]);
        }
    }
}

/// [R9-25] Immediately after a boundary ply whose deal recycled the lid, the
/// encoding's display, bag and lid fields, unscaled, with the walls, pattern
/// lines and floors, account for all 100 tiles ([E1-40]) — the fields a
/// recycle rearranges, read at the moment it rearranges them.
///
/// Seen red, in a copy: `bag_counts` in `src/state.rs` counting the whole bag
/// array (`for &c in &self.bag`) instead of `&self.bag[..usize::from(self.bag_len)]`
/// counts the drawn, zeroed slots as blue here.
#[test]
fn the_encoding_after_a_recycle_accounts_for_every_tile() {
    let unscaled = |v: &[f32; ENCODED_SIZE]| -> [i32; 5] {
        let n = |x: f32, s: f32| (x * s).round() as i32;
        let mut out = [0i32; 5];
        for c in 0..NUM_COLORS {
            out[c] += n(v[OFF_BAG + c], 20.0) + n(v[OFF_LID + c], 20.0) + n(v[OFF_CENTER + c], 10.0);
            for f in 0..NUM_FACTORIES {
                out[c] += n(v[OFF_FACTORIES + f * 5 + c], FACTORY_SIZE as f32);
            }
            for off in [OFF_MY_FLOOR, OFF_OP_FLOOR] {
                out[c] += n(v[off + c], FLOOR_SLOTS as f32);
            }
        }
        for off in [OFF_MY_LINES, OFF_OP_LINES] {
            for r in 0..NUM_ROWS {
                let count = n(v[off + r * 6 + 5], (r + 1) as f32);
                for c in 0..NUM_COLORS {
                    if v[off + r * 6 + c] == 1.0 {
                        out[c] += count;
                    }
                }
            }
        }
        for off in [OFF_MY_WALL, OFF_OP_WALL] {
            for i in 0..25 {
                if v[off + i] == 1.0 {
                    out[usize::from(wall_color_at((i / 5) as u8, (i % 5) as u8))] += 1;
                }
            }
        }
        out
    };
    let mut recycles = 0;
    for seed in 0..40 {
        let mut s = AzulState::seeded(seed);
        let mut k = 0usize;
        while !s.is_terminal() {
            let legal = s.legal_actions();
            let a = legal.as_slice()[(k * 7 + seed as usize) % legal.len()];
            let before = s.clone();
            s.apply(a).unwrap();
            k += 1;
            if !s.is_terminal() && s.round_index() != before.round_index() && s.shuffles_used() > before.shuffles_used() {
                recycles += 1;
                for p in [Player::P0, Player::P1] {
                    assert_eq!(unscaled(&s.encode_for(p)), [20; 5], "seed {seed}, ply {k}");
                }
            }
        }
    }
    assert!(recycles > 10, "only {recycles} recycles seen");
}
