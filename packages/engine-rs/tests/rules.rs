//! The rules of 0001, one posed position at a time. The vector replay proves
//! agreement with the oracle wholesale; these name the rule each behaviour is.

mod support;

use azul_engine::{
    ACTION_SPACE, AzulState, CENTER, CUM_PENALTY, Canonical, CanonicalError, FLOOR, IllegalAction,
    Outcome, Player, Seeded, decode_action, encode_action, placement_value, wall_col,
    wall_color_at, wall_completed_colors, wall_completed_cols, wall_completed_rows,
};
use support::{blank, settle};

/// A position built by `f` on a blank board whose bag holds four of each
/// colour, so a round that ends here can deal the next.
fn pose(f: impl FnOnce(&mut Canonical)) -> AzulState<Seeded> {
    let mut c = blank();
    c.bag = (0..20).map(|i| (i % 5) as u8).collect();
    f(&mut c);
    settle(c)
}

fn act(source: u8, color: u8, dest: u8) -> u8 {
    encode_action(source, color, dest).unwrap()
}

/// Colour `c` in row `r` sits in column `(c + r) % 5`, and the cell inverse
/// agrees [E1-1]; placing it sets row-major index `r * 5 + col` [E1-2].
#[test]
fn the_wall_is_the_fixed_colour_wall_stored_row_major() {
    for r in 0..5u8 {
        for c in 0..5u8 {
            let col = wall_col(c, r);
            assert_eq!(col, (c + r) % 5);
            assert_eq!(wall_color_at(r, col), c);
        }
    }
    // Row 3 full of red (2): column (2 + 3) % 5 = 0, index 15.
    let mut s = pose(|c| {
        c.pl_color[0][3] = 2;
        c.pl_count[0][3] = 4;
        c.factories[0] = [1, 0, 0, 0, 0];
    });
    s.apply(act(0, 0, FLOOR)).unwrap();
    let wall = s.to_canonical().walls[0];
    assert_eq!(wall.iter().filter(|&&x| x == 1).count(), 1);
    assert_eq!(wall[15], 1);
}

/// The floor line is per-colour counts, not an ordered list [E1-3].
#[test]
fn the_floor_is_counts_per_colour() {
    let mut s = pose(|c| c.factories[0] = [0, 3, 0, 0, 1]);
    s.apply(act(0, 1, FLOOR)).unwrap();
    assert_eq!(s.to_canonical().floor[0], [0, 3, 0, 0, 0]);
}

/// An emptied pattern line reports colour -1 [E1-4].
#[test]
fn an_emptied_line_has_no_colour() {
    let mut s = pose(|c| {
        c.pl_color[0][0] = 3;
        c.pl_count[0][0] = 1;
        c.factories[0] = [1, 0, 0, 0, 0];
    });
    s.apply(act(0, 0, FLOOR)).unwrap();
    let c = s.to_canonical();
    assert_eq!((c.pl_count[0][0], c.pl_color[0][0]), (0, -1));
}

/// `source * 30 + color * 6 + dest`, dense over 0..180 [E1-6]; the two
/// functions are inverses over the space, and None outside it [E1-7]
/// [V2-23].
#[test]
fn the_action_encoding_round_trips_over_the_whole_space() {
    let mut seen = [false; ACTION_SPACE];
    for source in 0..=5u8 {
        for color in 0..5u8 {
            for dest in 0..=5u8 {
                let a = encode_action(source, color, dest).unwrap();
                assert_eq!(usize::from(a), usize::from(source) * 30 + usize::from(color) * 6 + usize::from(dest));
                assert_eq!(decode_action(a), Some((source, color, dest)));
                seen[usize::from(a)] = true;
            }
        }
    }
    assert!(seen.iter().all(|&x| x), "every integer in 0..180 decodes");
    for a in ACTION_SPACE as u16..=255 {
        assert_eq!(decode_action(a as u8), None);
    }
    assert_eq!(encode_action(6, 0, 0), None);
    assert_eq!(encode_action(0, 5, 0), None);
    assert_eq!(encode_action(0, 0, 6), None);
}

/// A source without the colour offers nothing [E1-9].
#[test]
fn a_source_must_hold_the_colour() {
    let s = pose(|c| c.factories[0] = [0, 4, 0, 0, 0]);
    assert!(!s.is_legal(act(0, 0, 0)));
    assert!(!s.is_legal(act(0, 0, FLOOR)));
    assert!(!s.is_legal(act(CENTER, 1, 0)));
    assert!(s.is_legal(act(0, 1, 0)));
}

/// A line takes a colour only if it is not full, is empty or holds that
/// colour, and the wall row lacks it [E1-10]; the floor always takes it
/// [E1-12].
#[test]
fn a_pattern_line_must_be_open_to_the_colour() {
    let s = pose(|c| {
        c.factories[0] = [2, 2, 0, 0, 0];
        c.pl_color[0][0] = 1; // row 0 full of yellow
        c.pl_count[0][0] = 1;
        c.pl_color[0][2] = 1; // row 2 started with yellow
        c.pl_count[0][2] = 1;
        c.walls[0][5 + wall_col(0, 1) as usize] = 1; // blue already on wall row 1
    });
    assert!(!s.is_legal(act(0, 1, 0)), "full line");
    assert!(!s.is_legal(act(0, 0, 2)), "line holds another colour");
    assert!(s.is_legal(act(0, 1, 2)), "line holds this colour");
    assert!(!s.is_legal(act(0, 0, 1)), "colour already on the wall row");
    assert!(s.is_legal(act(0, 0, 3)), "empty line, open wall");
    for color in [0, 1] {
        assert!(s.is_legal(act(0, color, FLOOR)), "the floor always takes it");
    }
}

/// A finished game has no legal actions, refuses every action, and says so
/// [E1-11].
#[test]
fn a_terminal_state_has_no_moves() {
    let mut s = pose(|c| {
        c.factories[0] = [1, 0, 0, 0, 0];
        c.is_terminal = true;
    });
    assert!(s.legal_actions().is_empty());
    assert!((0..=255u8).all(|a| !s.is_legal(a)));
    assert_eq!(s.apply(act(0, 0, FLOOR)), Err(IllegalAction { action: act(0, 0, FLOOR) }));
}

/// In every position of many played games, every held colour can go to the
/// floor, so there is always a move [E1-12]; and the list is exactly the
/// legal set, ascending, without duplicates [E1-13].
#[test]
fn the_legal_list_is_exactly_the_legal_set_ascending() {
    for seed in 0..20 {
        for s in support::self_play(seed) {
            let legal = s.legal_actions();
            let brute: Vec<u8> = (0..=u8::MAX).filter(|&a| s.is_legal(a)).collect();
            assert_eq!(legal.as_slice(), brute.as_slice(), "seed {seed}");
            assert!(legal.as_slice().windows(2).all(|w| w[0] < w[1]));
            if s.is_terminal() {
                continue;
            }
            assert!(!legal.is_empty(), "seed {seed}: a live position has a move");
            let c = s.to_canonical();
            for source in 0..=5u8 {
                let pool = if source == CENTER { c.center } else { c.factories[usize::from(source)] };
                for color in 0..5u8 {
                    assert_eq!(pool[usize::from(color)] > 0, s.is_legal(act(source, color, FLOOR)));
                }
            }
        }
    }
}

/// An illegal or out-of-range action is refused with an error and changes
/// nothing [E1-14]; so does apply_explained, with no partial record [S7-5].
#[test]
fn an_illegal_action_changes_nothing() {
    let s = pose(|c| {
        c.factories[0] = [2, 0, 0, 0, 0];
        c.pl_color[0][1] = 3;
        c.pl_count[0][1] = 1;
    });
    for a in [act(0, 1, 0), act(0, 0, 1), act(CENTER, 0, 0), 180, 255] {
        let mut t = s.clone();
        assert_eq!(t.apply(a), Err(IllegalAction { action: a }));
        assert_eq!(t, s);
        let mut t = s.clone();
        assert_eq!(t.apply_explained(a), Err(IllegalAction { action: a }));
        assert_eq!(t, s);
    }
}

/// Taking removes the colour from its display [E1-15] and sends the rest to
/// the centre [E1-16].
#[test]
fn taking_from_a_display_empties_it() {
    let mut s = pose(|c| {
        c.factories[2] = [1, 2, 0, 1, 0];
        c.factories[3] = [4, 0, 0, 0, 0];
        c.center = [0, 0, 0, 1, 0];
    });
    s.apply(act(2, 1, FLOOR)).unwrap();
    let c = s.to_canonical();
    assert_eq!(c.factories[2], [0; 5]);
    assert_eq!(c.center, [1, 0, 0, 2, 0]);
    assert_eq!(c.factories[3], [4, 0, 0, 0, 0]);
}

/// The first take from the centre moves the marker to the taker's floor, and
/// later takes move nothing [E1-17].
#[test]
fn the_first_centre_take_takes_the_marker() {
    let mut s = pose(|c| {
        c.center = [2, 2, 0, 0, 0];
        c.factories[0] = [4, 0, 0, 0, 0];
    });
    s.apply(act(CENTER, 0, FLOOR)).unwrap();
    let c = s.to_canonical();
    assert!(!c.marker_in_center && c.floor_marker[0] && !c.floor_marker[1]);
    s.apply(act(CENTER, 1, FLOOR)).unwrap();
    let c = s.to_canonical();
    assert!(!c.marker_in_center && c.floor_marker[0] && !c.floor_marker[1]);
}

/// A line takes its colour up to `dest + 1` tiles and the surplus overflows
/// [E1-18]; to the floor, everything overflows [E1-19].
#[test]
fn a_line_fills_to_capacity_and_overflows() {
    let mut s = pose(|c| {
        c.factories[0] = [0, 0, 4, 0, 0];
        c.factories[1] = [0, 0, 0, 3, 0];
        c.factories[2] = [1, 0, 0, 0, 0]; // keeps the round open
    });
    s.apply(act(0, 2, 1)).unwrap();
    let c = s.to_canonical();
    assert_eq!((c.pl_color[0][1], c.pl_count[0][1]), (2, 2));
    assert_eq!(c.floor[0], [0, 0, 2, 0, 0]);
    s.apply(act(1, 3, FLOOR)).unwrap();
    assert_eq!(s.to_canonical().floor[1], [0, 0, 0, 3, 0]);
}

/// The floor holds seven occupied slots, the marker counting as one, and
/// anything past that goes straight to the lid; the marker itself can take an
/// eighth slot [E1-20].
#[test]
fn the_floor_overflows_to_the_lid() {
    let mut s = pose(|c| {
        c.floor[0] = [0, 6, 0, 0, 0];
        c.factories[0] = [0, 0, 3, 0, 0];
        c.center = [0, 0, 0, 2, 0];
        c.factories[1] = [4, 0, 0, 0, 0];
        c.factories[2] = [0, 1, 0, 0, 0]; // keeps the round open
    });
    s.apply(act(0, 2, FLOOR)).unwrap(); // one fits, two to the lid
    let c = s.to_canonical();
    assert_eq!(c.floor[0], [0, 6, 1, 0, 0]);
    assert_eq!(c.lid, [0, 0, 2, 0, 0]);
    s.apply(act(1, 0, 0)).unwrap(); // player 1, elsewhere
    s.apply(act(CENTER, 3, FLOOR)).unwrap(); // marker makes eight; both tiles to the lid
    let c = s.to_canonical();
    assert!(c.floor_marker[0]);
    assert_eq!(c.floor[0], [0, 6, 1, 0, 0]);
    assert_eq!(c.lid, [0, 0, 2, 2, 0]);
    assert_eq!(s.floor_penalty(Player::P0), CUM_PENALTY[7]);
}

/// A ply lowers `tiles_left` by the tiles taken and passes the turn; the ply
/// that empties the board resolves the round inside the same `apply` [E1-21].
#[test]
fn the_ply_that_empties_the_board_ends_the_round() {
    let mut s = pose(|c| c.factories[0] = [3, 1, 0, 0, 0]);
    assert_eq!(s.tiles_left(), 4);
    s.apply(act(0, 0, FLOOR)).unwrap();
    assert_eq!((s.tiles_left(), s.current_player()), (1, Player::P1));
    s.apply(act(CENTER, 1, FLOOR)).unwrap();
    // Round resolved and the next dealt, in the same call.
    assert_eq!(s.round_index(), 1);
    assert_eq!(s.tiles_left(), 20);
    assert_eq!(s.to_canonical().floor, [[0; 5]; 2]);
}

/// A partial line is left alone at round end [E1-22]; a full one places one
/// tile, sends `r` to the lid and empties [E1-23].
#[test]
fn only_full_lines_resolve() {
    let mut s = pose(|c| {
        c.pl_color[0][2] = 1; // full: three yellow
        c.pl_count[0][2] = 3;
        c.pl_color[0][3] = 4; // partial: two of four teal
        c.pl_count[0][3] = 2;
        c.factories[0] = [1, 0, 0, 0, 0];
        c.lid = [0; 5];
    });
    s.apply(act(0, 0, 0)).unwrap(); // row 0, blue, full: resolves too
    let c = s.to_canonical();
    assert_eq!((c.pl_color[0][3], c.pl_count[0][3]), (4, 2), "partial line untouched");
    assert_eq!((c.pl_color[0][2], c.pl_count[0][2]), (-1, 0));
    assert_eq!(c.walls[0][10 + usize::from(wall_col(1, 2))], 1);
    assert_eq!(c.walls[0][usize::from(wall_col(0, 0))], 1);
    // Two yellow of three went to the lid (then the bag was untouched: the
    // deal came from the 20 in the bag).
    assert_eq!(c.lid[1], 2);
}

/// A lone tile scores 1; otherwise each run longer than one scores its length
/// [E1-24]; the answer never depends on the cell itself [E1-68].
#[test]
fn placement_scores_runs() {
    let mut wall = [0u8; 25];
    let at = |r: usize, c: usize| r * 5 + c;
    assert_eq!(placement_value(&wall, 2, 2), 1);
    wall[at(2, 1)] = 1;
    assert_eq!(placement_value(&wall, 2, 2), 2);
    wall[at(2, 3)] = 1;
    assert_eq!(placement_value(&wall, 2, 2), 3);
    wall[at(1, 2)] = 1;
    assert_eq!(placement_value(&wall, 2, 2), 3 + 2);
    wall[at(3, 2)] = 1;
    wall[at(4, 2)] = 1;
    assert_eq!(placement_value(&wall, 2, 2), 3 + 4);
    let mut vertical = [0u8; 25];
    vertical[at(0, 4)] = 1;
    assert_eq!(placement_value(&vertical, 1, 4), 2);
    // The cell itself is not read: set or unset, the same answer.
    for r in 0..5 {
        for c in 0..5 {
            let mut set = wall;
            set[at(r, c)] = 1;
            let mut unset = wall;
            unset[at(r, c)] = 0;
            assert_eq!(placement_value(&set, r, c), placement_value(&unset, r, c));
        }
    }
    // Off the wall scores nothing rather than panicking [R9-7].
    assert_eq!(placement_value(&wall, 5, 0), 0);
    assert_eq!(placement_value(&wall, 0, 9), 0);
}

/// Rows resolve 0..4 and a later row scores against the tile an earlier row
/// just placed [E1-25]. Reversed order would score 4, not 5.
#[test]
fn a_later_row_scores_against_an_earlier_one() {
    let mut s = pose(|c| {
        c.pl_color[0][0] = 0; // blue at (0,0)
        c.pl_count[0][0] = 1;
        c.pl_color[0][1] = 4; // teal at (1,0), right below it
        c.pl_count[0][1] = 2;
        c.walls[0][6] = 1; // (1,1) already set: blue in row 1
        c.factories[0] = [0, 0, 1, 0, 0];
    });
    s.apply(act(0, 2, 2)).unwrap(); // red to row 2, which stays partial
    // (0,0) alone: 1. Then (1,0): h = 2 with (1,1), v = 2 with (0,0): 4.
    assert_eq!(s.scores()[0], 5);
}

/// Occupied slots are floor tiles plus the marker [E1-26]; the penalty sums
/// the first min(occupied, 7) rungs [E1-27].
#[test]
fn the_floor_penalty_is_charged_by_slot() {
    let expected = [0, -1, -2, -4, -6, -8, -11, -14];
    for tiles in 0..=9u8 {
        for marker in [false, true] {
            let s = pose(|c| {
                c.floor[0] = [tiles.min(5), tiles.saturating_sub(5), 0, 0, 0];
                c.floor_marker[0] = marker;
                c.marker_in_center = !marker;
                c.factories[0] = [0, 0, 1, 0, 0];
            });
            let occupied = usize::from(tiles) + usize::from(marker);
            assert_eq!(s.floor_penalty(Player::P0), expected[occupied.min(7)], "{tiles} tiles, marker {marker}");
        }
    }
}

/// The round's change is tiling plus penalty, clamped at zero once per round;
/// no debt carries forward [E1-28]. Floor tiles then go to the lid [E1-29].
#[test]
fn a_round_score_is_clamped_at_zero() {
    let mut s = pose(|c| {
        c.scores = [3, 0];
        c.floor[0] = [1, 1, 1, 1, 0]; // four tiles: -6
        c.pl_color[0][0] = 2;
        c.pl_count[0][0] = 1; // one tile: +1
        c.factories[0] = [0, 0, 0, 0, 1];
        c.lid = [0; 5];
    });
    s.apply(act(0, 4, 1)).unwrap();
    assert_eq!(s.scores()[0], 0, "3 + 1 - 6 clamps to 0");
    let c = s.to_canonical();
    assert_eq!(c.floor[0], [0; 5]);
    assert_eq!(c.lid, [1, 1, 1, 1, 0]);
}

/// The marker holder gives it back and starts the next round [E1-30].
#[test]
fn the_marker_holder_starts_the_next_round() {
    let mut s = pose(|c| {
        c.marker_in_center = false;
        c.floor_marker[1] = true;
        c.factories[0] = [1, 0, 0, 0, 0];
    });
    s.apply(act(0, 0, FLOOR)).unwrap(); // player 0 ends the round
    let c = s.to_canonical();
    assert!(c.marker_in_center && !c.floor_marker[0] && !c.floor_marker[1]);
    assert_eq!((c.first_player, c.current_player), (Player::P1, Player::P1));
}

/// Nobody took from the centre all round: the player who did not move last
/// starts the next one [E1-31].
#[test]
fn an_untouched_centre_keeps_alternation() {
    for (mover, next) in [(Player::P0, Player::P1), (Player::P1, Player::P0)] {
        let mut s = pose(|c| {
            c.current_player = mover;
            c.first_player = mover;
            c.factories[0] = [1, 0, 0, 0, 0];
        });
        s.apply(act(0, 0, FLOOR)).unwrap();
        assert_eq!((s.first_player(), s.current_player()), (next, next));
    }
}

/// Refill deals four tiles per display, in display order, from the end of the
/// bag [E1-32].
#[test]
fn refill_deals_from_the_end_of_the_bag() {
    let bag: Vec<u8> = (0..20).map(|i| (i / 4) as u8).collect(); // 0000 1111 2222 3333 4444
    let mut s = pose(|c| {
        c.bag = bag.clone();
        c.factories[0] = [1, 0, 0, 0, 0];
    });
    s.apply(act(0, 0, FLOOR)).unwrap();
    let c = s.to_canonical();
    // Display 0 gets the last four drawn: colour 4; display 4 the first: colour 0.
    for (f, colour) in (0..5).zip([4usize, 3, 2, 1, 0]) {
        let mut want = [0u8; 5];
        want[colour] = 4;
        assert_eq!(c.factories[f], want, "display {f}");
    }
    assert!(c.bag.is_empty());
}

/// A deal that takes the bag's last tile exactly leaves an empty bag and
/// shuffles nothing; the lid is recycled only when a draw *finds* the bag
/// empty, and then shuffled once; with the lid empty too, nothing is
/// shuffled [E1-33].
#[test]
fn the_lid_is_recycled_lazily() {
    // Exactly twenty in the bag, five in the lid: no shuffle.
    let mut s = pose(|c| {
        c.lid = [1, 1, 1, 1, 1];
        c.factories[0] = [0, 1, 0, 0, 0];
        c.bag = (0..20).map(|i| (i % 5) as u8).collect();
    });
    let before = s.shuffles_used();
    s.apply(act(0, 1, FLOOR)).unwrap();
    assert_eq!(s.shuffles_used(), before);
    let c = s.to_canonical();
    assert!(c.bag.is_empty());
    assert_eq!(c.lid, [1, 2, 1, 1, 1]);

    // Empty bag, twenty in the lid: one shuffle, at the first draw.
    let mut s = pose(|c| {
        c.bag = Vec::new();
        c.lid = [4; 5];
        c.factories[0] = [0, 1, 0, 0, 0];
    });
    s.apply(act(0, 1, 0)).unwrap();
    assert_eq!(s.shuffles_used(), 1);
    assert_eq!(s.tiles_left(), 20);

    // Empty bag, empty lid: nothing to shuffle, and nothing is.
    let mut s = pose(|c| {
        c.bag = Vec::new();
        c.lid = [0; 5];
        c.factories[0] = [0, 1, 0, 0, 0];
    });
    s.apply(act(0, 1, 0)).unwrap();
    assert_eq!(s.shuffles_used(), 0);
}

/// With bag and lid both short, dealing stops early and the rest of the
/// displays stay short [E1-34]; a deal of nothing ends the game, exhausted
/// [E1-37]; either way the round counter still advances [E1-35].
#[test]
fn a_short_deal_and_an_empty_one() {
    let mut s = pose(|c| {
        c.bag = vec![0, 1, 2, 3, 4, 0];
        c.lid = [0; 5];
        c.factories[0] = [0, 1, 0, 0, 0];
    });
    s.apply(act(0, 1, 0)).unwrap();
    let c = s.to_canonical();
    assert_eq!(c.tiles_left, 6);
    assert_eq!(c.factories[0].iter().sum::<u8>(), 4);
    assert_eq!(c.factories[1].iter().sum::<u8>(), 2);
    assert!(c.factories[2..].iter().all(|f| f == &[0; 5]));
    assert!(!c.is_terminal && !c.exhausted);
    assert_eq!(c.round_index, 1);

    let mut s = pose(|c| {
        c.bag = Vec::new();
        c.lid = [0; 5];
        c.factories[0] = [0, 1, 0, 0, 0];
    });
    s.apply(act(0, 1, 0)).unwrap();
    assert!(s.is_terminal() && s.exhausted());
    assert_eq!(s.round_index(), 1, "the increment stands although nothing was dealt");
    assert!(s.outcome().is_some());
}

/// A new game is round 0 and a round transition counts one [E1-35].
#[test]
fn the_round_index_counts_transitions() {
    let s = AzulState::seeded(3);
    assert_eq!(s.round_index(), 0);
    let mut s = pose(|c| c.factories[0] = [1, 0, 0, 0, 0]);
    s.apply(act(0, 0, FLOOR)).unwrap();
    assert_eq!(s.round_index(), 1);
}

/// A completed wall row ends the game after tiling and before any refill
/// [E1-36]; the marker handoff has already run [E1-66]; bonuses are 2 per
/// row, 7 per column and 10 per colour, added unclamped after the clamped
/// round [E1-38].
#[test]
fn a_completed_row_ends_the_game_with_bonuses() {
    let mut s = pose(|c| {
        // Player 0: (0,0)..(0,3) set; teal fills (0,4). Seven floor tiles.
        for col in 0..4 {
            c.walls[0][col] = 1;
        }
        c.pl_color[0][0] = 4;
        c.pl_count[0][0] = 1;
        c.floor[0] = [0, 7, 0, 0, 0];
        // Player 1: column 0 and every blue cell.
        for r in 0..5 {
            c.walls[1][r * 5] = 1;
            c.walls[1][r * 5 + r] = 1;
        }
        c.scores = [0, 10];
        c.marker_in_center = false;
        c.floor_marker[1] = true;
        c.factories[0] = [0, 0, 0, 1, 0];
    });
    let bag_before = s.to_canonical().bag;
    s.apply(act(0, 3, FLOOR)).unwrap();
    let c = s.to_canonical();
    assert!(c.is_terminal && !c.exhausted);
    assert_eq!(c.factories, [[0; 5]; 5], "no refill");
    assert_eq!(c.bag, bag_before);
    assert_eq!(c.round_index, 0, "no transition was counted");
    // [E1-66] the handoff ran first.
    assert!(c.marker_in_center && c.floor_marker == [false, false]);
    assert_eq!((c.first_player, c.current_player), (Player::P1, Player::P1));
    // Player 0: 0 + 5 - 14 clamps to 0, then +2 for the row, unclamped.
    // Player 1: 10, less 1 for the marker on the floor, then + 7 for the
    // column + 10 for blue.
    assert_eq!(c.scores, [2, 26]);
}

/// The outcome: higher score wins; a tie breaks on complete rows; still tied
/// is a draw; unfinished is None [E1-39].
#[test]
fn the_outcome_breaks_ties_on_rows() {
    let terminal = |scores: [i32; 2], rows: [usize; 2]| {
        pose(|c| {
            c.is_terminal = true;
            c.scores = scores;
            for (p, &n) in rows.iter().enumerate() {
                for r in 0..n {
                    for col in 0..5 {
                        c.walls[p][r * 5 + col] = 1;
                    }
                }
            }
        })
    };
    assert_eq!(terminal([10, 5], [1, 1]).outcome(), Some(Outcome::Player0));
    assert_eq!(terminal([5, 10], [1, 1]).outcome(), Some(Outcome::Player1));
    assert_eq!(terminal([7, 7], [1, 2]).outcome(), Some(Outcome::Player1));
    assert_eq!(terminal([7, 7], [2, 1]).outcome(), Some(Outcome::Player0));
    assert_eq!(terminal([7, 7], [1, 1]).outcome(), Some(Outcome::Draw));
    assert_eq!(pose(|c| c.factories[0] = [1, 0, 0, 0, 0]).outcome(), None);
    assert_eq!(Outcome::Player0 as i8, 1);
    assert_eq!(Outcome::Draw as i8, 0);
    assert_eq!(Outcome::Player1 as i8, -1);
}

/// What a wall has completed, and the per-player accessors delegate to it
/// [E1-70].
#[test]
fn completions_are_counted_on_the_wall() {
    let mut wall = [0u8; 25];
    assert_eq!((wall_completed_rows(&wall), wall_completed_cols(&wall), wall_completed_colors(&wall)), (0, 0, 0));
    for col in 0..5 {
        wall[5 + col] = 1; // row 1
    }
    for r in 0..5 {
        wall[r * 5 + 3] = 1; // column 3
        wall[r * 5 + usize::from(wall_col(2, r as u8))] = 1; // every red
    }
    assert_eq!((wall_completed_rows(&wall), wall_completed_cols(&wall), wall_completed_colors(&wall)), (1, 1, 1));
    let s = pose(|c| {
        c.walls[1] = wall;
        c.factories[0] = [1, 0, 0, 0, 0];
    });
    assert_eq!(
        (s.completed_rows(Player::P1), s.completed_cols(Player::P1), s.completed_colors(Player::P1)),
        (1, 1, 1)
    );
    assert_eq!(s.completed_rows(Player::P0), 0);
}

/// `to_canonical(from_canonical(c)) == c` for every recorded state, and a
/// snapshot whose tiles_left disagrees with its board is refused [E1-62].
#[test]
fn a_snapshot_round_trips_and_is_held_to_its_board() {
    for v in support::vectors() {
        for c in std::iter::once(&v.initial).chain(v.plies.iter().map(|p| &p.state)) {
            let s = AzulState::from_canonical(c, Seeded::new(1)).unwrap();
            assert_eq!(&s.to_canonical(), c, "{}", v.name);
        }
    }
    let mut c = support::vectors()[0].initial.clone();
    c.tiles_left += 1;
    assert_eq!(AzulState::from_canonical(&c, Seeded::new(1)).err(), Some(CanonicalError::TilesLeftMismatch));
}

/// Malformed snapshots are refused, not loaded and not panicked on [R9-7].
#[test]
fn malformed_snapshots_are_refused() {
    let ok = {
        let mut c = blank();
        c.factories[0] = [1, 0, 0, 0, 0];
        c.tiles_left = 1;
        c
    };
    assert!(AzulState::from_canonical(&ok, Seeded::new(0)).is_ok());
    type Case = (&'static str, fn(&mut Canonical), CanonicalError);
    let cases: Vec<Case> = vec![
        ("bag colour", |c| c.bag = vec![5], CanonicalError::OutOfRange),
        ("bag size", |c| c.bag = vec![0; 101], CanonicalError::OutOfRange),
        ("wall cell", |c| c.walls[0][3] = 2, CanonicalError::OutOfRange),
        ("negative score", |c| c.scores[1] = -1, CanonicalError::OutOfRange),
        ("huge score", |c| c.scores[0] = i32::MAX, CanonicalError::OutOfRange),
        ("line colour", |c| {
            c.pl_color[0][2] = 7;
            c.pl_count[0][2] = 1;
        }, CanonicalError::OutOfRange),
        ("line overfull", |c| {
            c.pl_color[0][0] = 1;
            c.pl_count[0][0] = 2;
        }, CanonicalError::OutOfRange),
        ("count without colour", |c| c.pl_count[1][3] = 2, CanonicalError::Inconsistent),
        ("colour without count", |c| c.pl_color[1][3] = 2, CanonicalError::Inconsistent),
        ("colour on the wall", |c| {
            c.pl_color[0][1] = 0;
            c.pl_count[0][1] = 1;
            c.walls[0][5 + usize::from(wall_col(0, 1))] = 1;
        }, CanonicalError::Inconsistent),
        ("two markers", |c| c.floor_marker[0] = true, CanonicalError::Inconsistent),
        ("no marker", |c| c.marker_in_center = false, CanonicalError::Inconsistent),
        ("too many of a colour", |c| {
            c.lid = [20, 0, 0, 0, 0];
        }, CanonicalError::OutOfRange),
        ("a pool past 20", |c| c.center = [0, 0, 21, 0, 0], CanonicalError::OutOfRange),
    ];
    for (what, edit, want) in cases {
        let mut c = ok.clone();
        edit(&mut c);
        assert_eq!(AzulState::from_canonical(&c, Seeded::new(0)).err(), Some(want), "{what}");
    }
}

/// The opening position [E1-65]: full shuffled bag dealt once, empty boards,
/// marker in the centre, player 0 to move, round 0, one shuffle used.
#[test]
fn a_new_game_opens_as_specified() {
    let c = AzulState::seeded(42).to_canonical();
    assert_eq!(c.bag.len(), 80);
    assert_eq!(c.tiles_left, 20);
    assert!(c.factories.iter().all(|f| f.iter().sum::<u8>() == 4));
    assert_eq!(c.center, [0; 5]);
    assert_eq!(c.lid, [0; 5]);
    assert_eq!(c.walls, [[0; 25]; 2]);
    assert_eq!(c.pl_color, [[-1; 5]; 2]);
    assert_eq!(c.pl_count, [[0; 5]; 2]);
    assert_eq!(c.floor, [[0; 5]; 2]);
    assert!(c.marker_in_center && c.floor_marker == [false, false]);
    assert_eq!(c.scores, [0, 0]);
    assert_eq!((c.current_player, c.first_player), (Player::P0, Player::P0));
    assert_eq!((c.round_index, c.shuffles_used), (0, 1));
    assert!(!c.is_terminal && !c.exhausted);
    assert_eq!(AzulState::seeded(42).tile_census(), [20; 5]);
}
