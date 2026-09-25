//! The round-scoring record of 0007: what `apply_explained` reports, and that
//! it agrees with the score.

mod support;

use azul_engine::*;
use support::{blank, settle};

/// One record with the position it was produced from.
struct Observed {
    at: String,
    before: Canonical,
    after: Canonical,
    record: RoundScoring,
}

/// Every round resolution the corpus reaches: every vector, played through
/// apply_explained, and 100 seeded games.
fn corpus() -> Vec<Observed> {
    let mut out = Vec::new();
    for v in support::vectors() {
        let mut s = support::start(v);
        for (i, ply) in v.plies.iter().enumerate() {
            let before = s.to_canonical();
            let r = s.apply_explained(ply.action).unwrap();
            if let Some(record) = r {
                out.push(Observed { at: format!("{} ply {i}", v.name), before, after: s.to_canonical(), record });
            }
        }
    }
    for seed in 0..100 {
        let mut s = AzulState::seeded(seed);
        let mut pick = support::Picker::new(seed);
        let mut i = 0;
        while !s.is_terminal() {
            let before = s.to_canonical();
            let legal = s.legal_actions();
            if let Some(record) = s.apply_explained(legal.as_slice()[pick.below(legal.len())]).unwrap() {
                out.push(Observed { at: format!("seed {seed} ply {i}"), before, after: s.to_canonical(), record });
            }
            i += 1;
        }
    }
    out
}

/// [S7-30] The corpus reaches every case the invariants need: a forgiven
/// clamp, a row-completion ending, an exhausted ending, a lone tile.
#[test]
fn the_corpus_reaches_every_case() {
    let c = corpus();
    assert!(c.iter().any(|o| o.record.players.iter().any(|p| p.forgiven > 0)), "a forgiven clamp");
    assert!(c.iter().any(|o| o.record.bonuses.is_some() && !o.after.exhausted), "a row-completion ending");
    assert!(c.iter().any(|o| o.record.bonuses.is_some() && o.after.exhausted), "an exhausted ending");
    assert!(
        c.iter().any(|o| o.record.players.iter().any(|p| p.placements.iter().any(|x| x.h == 1 && x.v == 1))),
        "a lone tile"
    );
}

/// [S7-23] tiling is the sum of the placements' points.
///
/// Seen to fail [S7-31] against `points: points + 1` in the `sink.push` of
/// `tile_wall`, `src/apply.rs`. The accumulator is untouched, so the round
/// still scores what the rules say and only the record lies: this failed, and
/// the other four invariants passed. The re-derivation of [S7-10] below failed
/// too — the same lie read from the other side.
#[test]
fn tiling_is_the_sum_of_points() {
    for o in corpus() {
        for p in &o.record.players {
            assert_eq!(p.tiling, p.placements.iter().map(|x| x.points).sum::<i32>(), "{}", o.at);
        }
    }
}

/// [S7-24] the penalty is the sum of the rungs.
///
/// Seen to fail [S7-31] against `rungs: &FLOOR_PENALTIES[..usize::from(occupied)
/// .min(FLOOR_SLOTS - 1)]` in `resolve_player`, `src/apply.rs` — one rung
/// short on a full floor. This failed; the other four passed, because the
/// number charged is `CUM_PENALTY`'s and the ladder is only reported beside
/// it. The ladder check of [S7-16] failed too, stating the same lie directly.
#[test]
fn the_penalty_is_the_sum_of_the_rungs() {
    for o in corpus() {
        for p in &o.record.players {
            assert_eq!(p.floor.penalty, p.floor.rungs.iter().sum::<i32>(), "{}", o.at);
        }
    }
}

/// [S7-25] score_after_round = score_before + tiling + penalty + forgiven,
/// and = max(0, score_before + tiling + penalty).
///
/// Seen to fail [S7-31] against the clamp removed — `self.scores[pi] = charged;`
/// in `resolve_player`, `src/apply.rs`. The second clause failed; the other
/// four invariants passed. [S7-17] failed with it, and so did [S7-30]'s
/// coverage check, with no forgiven round left to find. So did the vector
/// replays and the snapshot round trip, loudly: removing the clamp is a rules
/// change, and a negative score is a snapshot `from_canonical` refuses.
#[test]
fn the_round_score_accounts_for_the_clamp() {
    for o in corpus() {
        for p in &o.record.players {
            assert_eq!(p.score_after_round, p.score_before + p.tiling + p.floor.penalty + p.forgiven, "{}", o.at);
            assert_eq!(p.score_after_round, (p.score_before + p.tiling + p.floor.penalty).max(0), "{}", o.at);
        }
    }
}

/// [S7-26] bonuses start where the round left off and add their total.
///
/// Seen to fail [S7-31] against `score_after: score_before + total + total` in
/// `finish_game`, `src/apply.rs` — the bonus added twice, to the record and the
/// state alike. This failed and nothing else in this file did: the state and
/// the record agreed on the doubled number.
#[test]
fn bonuses_start_where_the_round_ended() {
    for o in corpus() {
        if let Some(b) = &o.record.bonuses {
            for (p, b) in b.iter().enumerate() {
                assert_eq!(b.score_before, o.record.players[p].score_after_round, "{}", o.at);
                assert_eq!(b.score_after, b.score_before + b.total, "{}", o.at);
            }
        }
    }
}

/// [S7-27] the record accounts for the whole score change.
///
/// Seen to fail [S7-31] against `if !self.is_terminal { self.scores[0] += 1; }`
/// just before the record is returned at the foot of `end_round`,
/// `src/apply.rs` — a score change the record does not account for. This
/// failed and nothing else in this file did: every other invariant is an equation between
/// numbers the record carries, and the mutation touched none of them. That is
/// why this one is stated separately.
#[test]
fn the_record_accounts_for_the_whole_score() {
    for o in corpus() {
        for p in 0..2 {
            let want = match &o.record.bonuses {
                Some(b) => b[p].score_after,
                None => o.record.players[p].score_after_round,
            };
            assert_eq!(o.after.scores[p], want, "{}", o.at);
        }
    }
}

/// [S7-9] every tile moved to the wall, rows in order, only full rows;
/// [S7-10] points are placement_value of the wall as the placement found it;
/// [S7-11] h and v are the real runs, re-derived here independently of the
/// engine's scans; [S7-12] so a second fusion rule disagreeing anywhere the
/// corpus reaches fails here.
#[test]
fn placements_are_re_derived_from_the_wall() {
    fn runs(wall: &[u8; 25], r: usize, c: usize) -> (u8, u8) {
        let set = |r: isize, c: isize| (0..5).contains(&r) && (0..5).contains(&c) && wall[(r * 5 + c) as usize] != 0;
        let (r, c) = (r as isize, c as isize);
        let count = |dr: isize, dc: isize| (1..5).take_while(|&k| set(r + dr * k, c + dc * k)).count() as u8;
        (1 + count(0, -1) + count(0, 1), 1 + count(-1, 0) + count(1, 0))
    }
    for o in corpus() {
        for (p, pr) in o.record.players.iter().enumerate() {
            let mut wall = o.before.walls[p];
            let full: Vec<u8> = (0..5).filter(|&r| usize::from(o.before.pl_count[p][r]) == r + 1).map(|r| r as u8).collect();
            let rows: Vec<u8> = pr.placements.iter().map(|x| x.row).collect();
            // The round-ending ply may itself fill a line; the before state is
            // one ply short of that, so check containment and order.
            assert!(rows.windows(2).all(|w| w[0] < w[1]), "{}", o.at);
            assert!(full.iter().all(|r| rows.contains(r)), "{}", o.at);
            for x in &pr.placements {
                let (r, c) = (usize::from(x.row), usize::from(x.col));
                let colour = o.before.pl_color[p][r];
                if colour >= 0 {
                    assert_eq!(c, usize::from(wall_col(colour as u8, x.row)), "{}", o.at);
                }
                let (h, v) = runs(&wall, r, c);
                assert_eq!((x.h, x.v), (h, v), "{} p{p} row {r}", o.at);
                let fused = if h > 1 || v > 1 { i32::from(if h > 1 { h } else { 0 }) + i32::from(if v > 1 { v } else { 0 }) } else { 1 };
                assert_eq!(x.points, fused, "{}", o.at);
                assert_eq!(x.points, placement_value(&wall, r, c), "{}", o.at);
                wall[r * 5 + c] = 1;
            }
            assert_eq!(wall, o.after.walls[p], "{}: the placements account for the whole wall change", o.at);
        }
    }
}

/// [S7-15] the penalty is CUM_PENALTY[min(7, occupied)], non-positive;
/// [S7-16] the rungs are the ladder's prefix, by slot; [S7-17] forgiven is
/// >= 0 and 0 unless the clamp bit; [S7-18] the scores on both sides of it.
#[test]
fn the_floor_and_clamp_fields() {
    for o in corpus() {
        for (p, pr) in o.record.players.iter().enumerate() {
            let n = usize::from(pr.floor.occupied).min(FLOOR_SLOTS);
            assert_eq!(pr.floor.penalty, CUM_PENALTY[n], "{}", o.at);
            assert!(pr.floor.penalty <= 0);
            assert_eq!(pr.floor.rungs, &FLOOR_PENALTIES[..n], "{}", o.at);
            assert!(pr.forgiven >= 0);
            let bit = pr.score_before + pr.tiling + pr.floor.penalty < 0;
            assert_eq!(pr.forgiven > 0, bit, "{}", o.at);
            assert_eq!(pr.score_before, o.before.scores[p], "{}", o.at);
        }
    }
}

/// [S7-13] round is the index of the round that ended, on all three exits:
/// an ordinary round, a row completion, and exhaustion [S7-32].
#[test]
fn the_round_is_the_one_that_ended_on_every_exit() {
    let c = corpus();
    let ordinary = c.iter().find(|o| o.record.bonuses.is_none()).unwrap();
    let completed = c.iter().find(|o| o.record.bonuses.is_some() && !o.after.exhausted).unwrap();
    let exhausted = c.iter().find(|o| o.after.exhausted).unwrap();
    for o in [ordinary, completed, exhausted] {
        assert_eq!(o.record.round, o.before.round_index, "{}", o.at);
    }
    assert_eq!(ordinary.after.round_index, ordinary.before.round_index + 1);
    assert_eq!(completed.after.round_index, completed.before.round_index);
    assert_eq!(exhausted.after.round_index, exhausted.before.round_index + 1);
    for o in &c {
        assert_eq!(o.record.round, o.before.round_index, "{}", o.at);
    }
}

/// [S7-14] marker_held and occupied are read as resolution found the floor —
/// before it is cleared and before the handoff [S7-33].
#[test]
fn the_floor_is_read_before_it_is_cleared() {
    let mut c = blank();
    c.bag = (0..20).map(|i| (i % 5) as u8).collect();
    c.marker_in_center = false;
    c.floor_marker[0] = true;
    c.floor[0] = [1, 0, 2, 0, 0];
    c.factories[0] = [0, 0, 0, 1, 0];
    let mut s = settle(c);
    let r = s.apply_explained(encode_action(0, 3, 4).unwrap()).unwrap().unwrap();
    assert!(r.players[0].floor.marker_held);
    assert_eq!(r.players[0].floor.occupied, 4);
    assert_eq!(r.players[0].floor.penalty, -6);
    assert!(!r.players[1].floor.marker_held);
    assert_eq!(r.players[1].floor.occupied, 0);
    let after = s.to_canonical();
    assert_eq!(after.floor[0], [0; 5]);
    assert!(!after.floor_marker[0]);
}

/// [S7-19] bonus counts, what each earned, and the total; [S7-20] present
/// exactly when the game ended on the ply; [S7-22] the final score is read,
/// not added.
#[test]
fn bonuses_are_present_exactly_when_the_game_ends() {
    for o in corpus() {
        assert_eq!(o.record.bonuses.is_some(), o.after.is_terminal, "{}", o.at);
        if let Some(b) = &o.record.bonuses {
            for (p, b) in b.iter().enumerate() {
                let wall = &o.after.walls[p];
                assert_eq!((b.rows, b.cols, b.colors), (wall_completed_rows(wall), wall_completed_cols(wall), wall_completed_colors(wall)));
                assert_eq!(b.row_points, ROW_BONUS * i32::from(b.rows));
                assert_eq!(b.col_points, COL_BONUS * i32::from(b.cols));
                assert_eq!(b.color_points, COLOR_BONUS * i32::from(b.colors));
                assert_eq!(b.total, b.row_points + b.col_points + b.color_points);
                assert_eq!(b.score_after, o.after.scores[p]);
            }
        }
    }
}

/// [S7-1] apply_explained returns Some exactly on the ply that ends a round;
/// [S7-28] and apply and apply_explained are indistinguishable as state
/// transitions — equal as snapshots and equal as whole states, so neither
/// entry point leaves anything behind [S7-7], and nothing was added to the
/// state or its snapshot [S7-6]. Seeds are reported on failure.
#[test]
fn the_two_entry_points_are_the_same_transition() {
    for seed in 0..200u64 {
        let mut a = AzulState::seeded(seed);
        let mut b = a.clone();
        let mut pick = support::Picker::new(seed);
        while !a.is_terminal() {
            let legal = a.legal_actions();
            let act = legal.as_slice()[pick.below(legal.len())];
            let round = a.round_index();
            a.apply(act).unwrap();
            let r = b.apply_explained(act).unwrap();
            assert_eq!(a.to_canonical(), b.to_canonical(), "seed {seed}");
            assert_eq!(a, b, "seed {seed}");
            let ended = a.round_index() != round || a.is_terminal();
            assert_eq!(r.is_some(), ended, "seed {seed}");
        }
    }
}

/// [S7-2] apply returns a Result of unit and never a record: the binding
/// below fails to compile if that changes.
#[test]
fn apply_returns_no_record() {
    let mut c = blank();
    c.bag = (0..20).map(|i| (i % 5) as u8).collect();
    c.factories[0] = [1, 0, 0, 0, 0];
    let mut s = settle(c);
    let (): () = s.apply(encode_action(0, 0, FLOOR).unwrap()).unwrap();
    assert_eq!(s.round_index(), 1, "that ply ended a round");
}

/// [S7-8] a record kept across later plies still says what that round
/// charged; [S7-34] and the position that produced one round-trips through
/// its snapshot unchanged.
#[test]
fn a_record_is_safe_to_keep() {
    let mut s = AzulState::seeded(5);
    let mut pick = support::Picker::new(5);
    let mut kept: Option<(RoundScoring, RoundScoring)> = None;
    while !s.is_terminal() {
        let legal = s.legal_actions();
        if let Some(r) = s.apply_explained(legal.as_slice()[pick.below(legal.len())]).unwrap() {
            let c = s.to_canonical();
            let back = AzulState::from_canonical(&c, s.shuffler().clone()).unwrap();
            assert_eq!(back.to_canonical(), c);
            assert_eq!(back, s);
            if kept.is_none() {
                kept = Some((r.clone(), r));
            }
        }
    }
    let (kept, copy) = kept.unwrap();
    assert_eq!(kept, copy);
}

/// [S7-21] no field derivable from another, and [S7-36] asserted by naming
/// every field of every record type without `..`: adding or removing one
/// fails to compile here, and nowhere else.
#[test]
fn the_record_types_have_exactly_their_declared_fields() {
    let mut c = blank();
    c.bag = (0..20).map(|i| (i % 5) as u8).collect();
    c.factories[0] = [0, 0, 0, 0, 1];
    c.pl_color[0][0] = 3;
    c.pl_count[0][0] = 1;
    for col in 0..4 {
        c.walls[1][col] = 1;
    }
    c.pl_color[1][0] = 4;
    c.pl_count[1][0] = 1;
    let mut s = settle(c);
    let r = s.apply_explained(encode_action(0, 4, FLOOR).unwrap()).unwrap().unwrap();
    let RoundScoring { round, players, bonuses } = r;
    let _ = round;
    for PlayerRound { placements, tiling, floor, score_before, score_after_round, forgiven } in players {
        let _ = (tiling, score_before, score_after_round, forgiven);
        let FloorCharge { occupied, rungs, marker_held, penalty } = floor;
        let _ = (occupied, rungs, marker_held, penalty);
        for Placement { row, col, h, v, points } in placements {
            let _ = (row, col, h, v, points);
        }
    }
    for PlayerBonuses { rows, cols, colors, row_points, col_points, color_points, total, score_before, score_after } in
        bonuses.expect("player 1 completed row 0")
    {
        let _ = (rows, cols, colors, row_points, col_points, color_points, total, score_before, score_after);
    }
    // [S7-6] the snapshot is 0001's eighteen fields and nothing else.
    let Canonical {
        factories, center, marker_in_center, bag, lid, walls, pl_color, pl_count, floor,
        floor_marker, scores, current_player, first_player, round_index, tiles_left,
        shuffles_used, is_terminal, exhausted,
    } = s.to_canonical();
    let _ = (factories, center, marker_in_center, bag, lid, walls, pl_color, pl_count, floor);
    let _ = (floor_marker, scores, current_player, first_player, round_index, tiles_left);
    let _ = (shuffles_used, is_terminal, exhausted);
}
