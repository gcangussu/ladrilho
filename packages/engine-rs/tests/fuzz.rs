//! Randomised self-play and hostile inputs: fuzz coverage, not oracle coverage.

mod support;

use azul_engine::*;
use support::{FULL_CENSUS, Picker, check_invariants};

/// [V2-24] 200 seeded games finish without error, every ply legal by
/// construction, with conservation [E1-40] and the structural invariants
/// [E1-41] [E1-42] [E1-43] [E1-44] [E1-45] [E1-64] holding on every ply. The
/// failing seed is named.
#[test]
fn two_hundred_games_finish_conserving_tiles() {
    for seed in 0..200u64 {
        let mut s = AzulState::seeded(seed);
        let mut pick = Picker::new(seed);
        let mut plies = 0;
        while !s.is_terminal() {
            let legal = s.legal_actions();
            assert!(!legal.is_empty(), "seed {seed}: a live position with no move");
            let before = s.shuffles_used();
            s.apply(legal.as_slice()[pick.below(legal.len())]).unwrap_or_else(|e| panic!("seed {seed}: {e:?}"));
            assert_eq!(s.tile_census(), FULL_CENSUS, "seed {seed} ply {plies}: [E1-40]");
            if let Some(fault) = check_invariants(&s.to_canonical(), before) {
                panic!("seed {seed} ply {plies}: {fault}");
            }
            plies += 1;
            assert!(plies < 2000, "seed {seed}: no end in sight");
        }
        assert!(s.outcome().is_some());
    }
}

/// [R9-7] Every u8 offered as an action to a sample of positions: nothing
/// panics, and every refused action leaves the state exactly as it was.
#[test]
fn every_byte_as_an_action_is_safe() {
    for seed in 0..40u64 {
        for (i, s) in support::self_play(seed).into_iter().enumerate() {
            if i % 7 != 0 && !s.is_terminal() {
                continue;
            }
            for a in 0..=u8::MAX {
                let mut t = s.clone();
                match t.apply(a) {
                    Ok(()) => assert!(s.is_legal(a), "seed {seed}: {a} accepted but illegal"),
                    Err(e) => {
                        assert_eq!(e, IllegalAction { action: a });
                        assert_eq!(t, s, "seed {seed}: refused {a} changed the state");
                    }
                }
                let mut t = s.clone();
                if t.apply_explained(a).is_err() {
                    assert_eq!(t, s, "seed {seed}: refused {a} changed the state");
                }
            }
        }
    }
}

/// [R9-7] The free functions are total over their argument types.
#[test]
fn the_free_functions_are_total() {
    for a in 0..=u8::MAX {
        for b in 0..=u8::MAX {
            let _ = wall_col(a, b);
            let _ = wall_color_at(a, b);
        }
    }
    for s in [0, 5, 6, 200, 255] {
        for c in [0, 4, 5, 255] {
            for d in [0, 5, 6, 255] {
                let _ = encode_action(s, c, d);
            }
        }
    }
    let mut pick = Picker::new(77);
    for _ in 0..2000 {
        let wall: [u8; 25] = std::array::from_fn(|_| pick.below(256) as u8);
        let _ = (wall_completed_rows(&wall), wall_completed_cols(&wall), wall_completed_colors(&wall));
        for r in 0..8 {
            for c in 0..8 {
                let _ = placement_value(&wall, r, c);
            }
        }
        let _ = placement_value(&wall, usize::MAX, usize::MAX);
    }
}

/// [R9-7] Random snapshots, most of them malformed, are refused or loaded
/// without panicking — and every accepted one plays to its end without
/// panicking either.
#[test]
fn random_snapshots_are_refused_or_played_safely() {
    let mut pick = Picker::new(4242);
    let mut accepted = 0;
    for _ in 0..20_000 {
        let mut small = |n: usize| pick.below(n) as u8;
        let mut c = support::blank();
        for f in c.factories.iter_mut() {
            *f = std::array::from_fn(|_| if small(3) == 0 { small(5) } else { 0 });
        }
        c.center = std::array::from_fn(|_| if small(4) == 0 { small(8) } else { 0 });
        let bag_len = usize::from(small(40));
        c.bag = (0..bag_len).map(|_| if small(200) == 0 { 5 } else { small(5) }).collect();
        c.lid = std::array::from_fn(|_| small(4));
        for w in c.walls.iter_mut() {
            *w = std::array::from_fn(|_| match small(400) { 0 => 2, 1..=80 => 1, _ => 0 });
        }
        for p in 0..2 {
            for r in 0..5 {
                // Mostly a lawful line; now and then an overfull, colourless or
                // out-of-range one.
                let n = small(r + 2);
                c.pl_count[p][r] = n;
                c.pl_color[p][r] = if n == 0 { -1 } else { small(5) as i8 };
                if small(30) == 0 {
                    c.pl_count[p][r] = small(r + 3);
                    c.pl_color[p][r] = small(7) as i8 - 1;
                }
            }
            c.floor[p] = std::array::from_fn(|_| if small(3) == 0 { small(4) } else { 0 });
        }
        // Clear most wall cells a line's colour would collide with.
        for p in 0..2 {
            for r in 0..5 {
                let colour = c.pl_color[p][r];
                if (0..5).contains(&colour) && small(10) != 0 {
                    c.walls[p][r * 5 + usize::from(wall_col(colour as u8, r as u8))] = 0;
                }
            }
        }
        match small(12) {
            0 => c.marker_in_center = false,
            1 => c.floor_marker = [true, true],
            2..=4 => {
                c.marker_in_center = false;
                c.floor_marker[usize::from(small(2))] = true;
            }
            _ => {}
        }
        c.scores = [i32::from(small(200)) - 20, i32::from(small(200))];
        c.current_player = if small(2) == 0 { Player::P0 } else { Player::P1 };
        c.round_index = if small(10) == 0 { u32::MAX } else { u32::from(small(8)) };
        c.shuffles_used = if small(10) == 0 { u32::MAX } else { u32::from(small(8)) };
        c.tiles_left = c.center.iter().chain(c.factories.iter().flatten()).fold(0u8, |a, &b| a.wrapping_add(b));
        if small(5) == 0 {
            c.tiles_left = small(255);
        }
        if let Ok(mut s) = AzulState::from_canonical(&c, Seeded::new(u64::from(small(255)))) {
            accepted += 1;
            assert_eq!(s.to_canonical(), c);
            let _ = s.encode();
            let mut plies = 0;
            while !s.is_terminal() && plies < 3000 {
                let legal = s.legal_actions();
                if legal.is_empty() {
                    break;
                }
                let before = s.tile_census();
                s.apply(legal.as_slice()[pick.below(legal.len())]).unwrap();
                assert_eq!(s.tile_census(), before, "[E1-40] conserved from any start");
                plies += 1;
            }
        }
    }
    assert!(accepted > 100, "only {accepted} snapshots were accepted; the generator is too hostile to test play");
}
