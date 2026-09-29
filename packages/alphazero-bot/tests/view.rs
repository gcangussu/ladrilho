//! As [Z11-43] asks: the pre-deal view ([Z11-9]), the input's tile census ([Z11-51]), and what
//! the network is handed ([Z11-8]).

mod support;

use std::sync::Mutex;

use azul_alphazero::network::{Evaluation, Evaluator};
use azul_alphazero::search::{SearchConfig, search};
use azul_alphazero::view::{accounts_for, input_census, is_boundary, pre_deal_view};
use azul_engine::{
    Action, AzulState, ENCODED_SIZE, OFF_BAG, OFF_FACTORIES, OFF_FACTORY_FLAGS, OFF_LID, OFF_TILES_LEFT,
    Player, Seeded, encode_action,
};
use support::{Zero, blank, fixture, game_positions, pose};

/// P0 to move, one blue tile left in the centre, P1 holding the marker. P0's
/// move to the floor ends the round: the blue goes to the lid, P1 opens the
/// next round, and the deal runs from `bag` with `lid` beside it.
fn last_blue(bag: Vec<u8>, lid: [u8; 5]) -> AzulState<Seeded> {
    let mut c = blank();
    c.center = [1, 0, 0, 0, 0];
    c.marker_in_center = false;
    c.floor_marker = [false, true];
    c.bag = bag;
    c.lid = lid;
    pose(c, 77)
}

fn to_floor() -> Action {
    encode_action(5, 0, 5).unwrap()
}

fn counts(v: &[f32; ENCODED_SIZE], off: usize) -> [i32; 5] {
    std::array::from_fn(|c| (v[off + c] * 20.0).round() as i32)
}

/// Asserts the view against counts worked out by hand, and that every field
/// [Z11-9] does not name is `after.encode()`'s.
fn check(before: &AzulState<Seeded>, after: &AzulState<Seeded>, bag: [i32; 5], lid: [i32; 5]) {
    assert!(is_boundary(before, after) && !after.is_terminal());
    let v = pre_deal_view(before, after);
    assert_eq!(counts(&v, OFF_BAG), bag, "bag");
    assert_eq!(counts(&v, OFF_LID), lid, "lid");
    for c in 0..5 {
        assert_eq!(v[OFF_BAG + c], (f64::from(bag[c]) / 20.0) as f32);
        assert_eq!(v[OFF_LID + c], (f64::from(lid[c]) / 20.0) as f32);
    }
    assert!(v[OFF_FACTORIES..OFF_FACTORY_FLAGS + 5].iter().all(|&x| x == 0.0));
    assert_eq!(v[OFF_TILES_LEFT], 0.0);
    let e = after.encode();
    for i in 0..ENCODED_SIZE {
        let named = (OFF_FACTORIES..OFF_FACTORY_FLAGS + 5).contains(&i)
            || (OFF_BAG..OFF_LID + 5).contains(&i)
            || i == OFF_TILES_LEFT;
        if !named {
            assert_eq!(v[i].to_bits(), e[i].to_bits(), "field {i} is after.encode()'s");
        }
    }
    assert_eq!(after.current_player(), Player::P1, "seen from the seat that opens the next round");
    assert!(accounts_for(&v, after));
}

/// [Z11-9], a deal that did not recycle: the bag it started from, and the lid
/// as scoring left it — the one blue from P0's floor added.
#[test]
fn the_view_of_an_ordinary_deal() {
    let bag: Vec<u8> = (0..40).map(|i| (i % 5) as u8).collect(); // 8 of each
    let before = last_blue(bag, [2, 0, 1, 0, 0]);
    let mut after = before.clone();
    after.apply(to_floor()).unwrap();
    assert_eq!(after.shuffles_used(), before.shuffles_used(), "no recycle");
    check(&before, &after, [8, 8, 8, 8, 8], [3, 0, 1, 0, 0]);
}

/// [Z11-9], a deal that recycled the lid: six tiles drawn from the bag first,
/// with certainty, then the lid shuffled in. The view is the split before it:
/// the six in the bag, the twenty-one in the lid.
///
/// Mutation, seen red ([Z11-48]): in `pre_deal_view`, the bag set to
/// `bag_after + dealt` and the lid left as `after`'s fails here.
#[test]
fn the_view_of_a_deal_that_recycled_the_lid() {
    let before = last_blue(vec![0, 0, 1, 2, 3, 4], [5, 3, 4, 2, 6]);
    let mut after = before.clone();
    after.apply(to_floor()).unwrap();
    assert_eq!(after.shuffles_used(), before.shuffles_used() + 1, "the lid was recycled");
    assert_eq!(after.tiles_left(), 20);
    check(&before, &after, [2, 1, 1, 1, 1], [6, 3, 4, 2, 6]);
}

/// [Z11-9], a deal that emptied bag and lid ([0001 E1-34]): three from the
/// bag, three recycled from the lid, and dealing stops at six.
#[test]
fn the_view_of_a_deal_that_emptied_bag_and_lid() {
    let before = last_blue(vec![0, 1, 2], [0, 2, 0, 0, 0]);
    let mut after = before.clone();
    after.apply(to_floor()).unwrap();
    assert_eq!(after.tiles_left(), 6);
    assert!(!after.exhausted());
    check(&before, &after, [1, 1, 1, 0, 0], [1, 2, 0, 0, 0]);
}

/// Every boundary of 30 recorded games: every pre-deal view accounts for all
/// 100 tiles, and so does every ordinary position's encoding ([Z11-51]).
#[test]
fn every_input_of_recorded_games_accounts_for_every_tile() {
    let mut boundaries = 0;
    let mut recycles = 0;
    for seed in 0..30 {
        let positions = game_positions(seed);
        for w in positions.windows(2) {
            let (before, after) = (&w[0], &w[1]);
            assert!(accounts_for(&before.encode(), before));
            assert_eq!(input_census(&before.encode()), [20; 5]);
            if is_boundary(before, after) && !after.is_terminal() {
                boundaries += 1;
                recycles += usize::from(after.shuffles_used() > before.shuffles_used());
                let v = pre_deal_view(before, after);
                assert_eq!(input_census(&v), [20; 5]);
            }
        }
    }
    assert!(boundaries > 100 && recycles > 10, "{boundaries} boundaries, {recycles} recycles");
}

/// Positions taken late in a round, where a search reaches the boundary.
fn late_in_round(seeds: std::ops::Range<u64>) -> Vec<AzulState<Seeded>> {
    let mut out = Vec::new();
    for seed in seeds {
        let p = game_positions(seed);
        for w in p.windows(2) {
            if w[0].tiles_left() <= 6 && !is_boundary(&w[0], &w[1]) && w[0].round_index() > 0 {
                out.push(w[0].clone());
            }
        }
    }
    out
}

/// A new game with `k` tiles taken off the end of its bag: a posed position
/// whose census is below 100 ([0001 E1-40]).
fn short(seed: u64, k: usize) -> AzulState<Seeded> {
    let mut c = AzulState::seeded(seed).to_canonical();
    c.bag.truncate(c.bag.len() - k);
    AzulState::from_canonical(&c, Seeded::new(seed)).unwrap()
}

/// [Z11-51]: searches run with debug assertions on ([Z11-64]) over positions
/// from recorded games, recycles included, and over posed short-census
/// positions played to the end — so the `debug_assert!` at every expansion and
/// every pre-deal view runs against censuses of 20 and of fewer.
///
/// Mutations, seen red ([Z11-48]): the census check against the constant 20
/// (`[20; 5]` for `state.tile_census()` in `accounts_for`) fails the
/// short-census half; the pre-deal view zeroing the displays without adding
/// them to the lid fails the first half.
#[test]
fn searches_check_the_census_at_every_expansion() {
    const { assert!(cfg!(debug_assertions), "the census check needs debug assertions ([Z11-64])") };
    let net = fixture();
    let config = SearchConfig { simulations: 60, cpuct: 1.25, fpu: 0.25 };
    let late = late_in_round(0..6);
    assert!(late.iter().any(|s| s.to_canonical().bag.len() < 20), "some of them recycle");
    for s in &late {
        search(&net, s, &config, None).unwrap();
    }
    for (seed, k) in [(1, 30), (2, 55), (3, 71), (4, 79)] {
        let mut s = short(seed, k);
        let census: u32 = s.tile_census().iter().map(|&n| u32::from(n)).sum();
        assert!(census < 100);
        // Capped: with few tiles and no colour set a row can finish, a posed
        // game can cycle its tiles through the lid for ever.
        for _ in 0..150 {
            if s.is_terminal() {
                break;
            }
            let r = search(&Zero, &s, &SearchConfig { simulations: 30, cpuct: 1.25, fpu: 0.0 }, None).unwrap();
            s.apply(r.0.action).unwrap();
        }
    }
}

/// Records every observation the search hands the network, and whether a
/// legal set came with it.
struct Recording(Mutex<Vec<([f32; ENCODED_SIZE], usize)>>);

impl Evaluator for Recording {
    fn evaluate(&self, o: &[f32; ENCODED_SIZE], legal: &[Action], out: &mut Evaluation) {
        self.0.lock().unwrap().push((*o, legal.len()));
        Zero.evaluate(o, legal, out);
    }
}

/// [Z11-8]: the network's input is the observation of [0001 E1-53],
/// unmodified — the root's first call is exactly `encode()` — and a boundary
/// is valued on its pre-deal view alone, with no legal set.
///
/// [Z11-15]: no node below a boundary is expanded — every call that carries a
/// legal set is for a position of the root's own round.
#[test]
fn the_network_sees_the_observation_and_nothing_past_the_boundary() {
    let mut views = 0;
    for root in late_in_round(10..13).iter().step_by(3) {
        let rec = Recording(Mutex::new(Vec::new()));
        search(&rec, root, &SearchConfig { simulations: 200, cpuct: 1.25, fpu: 0.0 }, None).unwrap();
        let calls = rec.0.into_inner().unwrap();
        assert_eq!(calls[0].0, root.encode());
        let round = root.encode()[azul_engine::OFF_ROUND];
        for (o, legal) in &calls {
            if *legal > 0 {
                assert_eq!(o[azul_engine::OFF_ROUND], round, "an expansion past the boundary");
            } else {
                views += 1;
                assert_eq!(o[OFF_TILES_LEFT], 0.0, "a boundary valued on a dealt position");
            }
        }
    }
    assert!(views > 20, "{views} boundaries valued");
}
