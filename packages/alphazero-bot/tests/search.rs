//! The search ([Z11-14] through [Z11-21], [Z11-62]), as [Z11-42] asks: on a zero network — a
//! uniform policy and a value of 0 — and on the fixture where a network that
//! sees its input matters.

mod support;

use azul_alphazero::rng::{Rng, game_seed, noise_seed};
use azul_alphazero::search::{SearchConfig, SelfPlayNoise, choose, search};
use azul_alphazero::view::is_boundary;
use azul_engine::{AzulState, Player, Seeded, encode_action};
use support::{Counting, Zero, blank, fixture, game_positions, pose};

fn config(simulations: u32, fpu: f32) -> SearchConfig {
    SearchConfig { simulations, cpuct: 1.25, fpu }
}

/// [Z11-18]: the root's visits sum to exactly the configured count, and the
/// root's expansion is one evaluator call that is not among them — a search of
/// zero simulations makes exactly that call.
#[test]
fn a_search_runs_exactly_its_simulations() {
    let s = AzulState::seeded(4);
    let zero = Counting::new(Zero);
    let r = choose(&zero, &s, &config(0, 0.25)).unwrap();
    assert_eq!(zero.calls(), 1);
    assert_eq!(r.visits.iter().sum::<u32>(), 0);
    for n in [1, 7, 150, 401] {
        for fpu in [0.0, 0.25] {
            let r = choose(&Zero, &s, &config(n, fpu)).unwrap();
            assert_eq!(r.visits.iter().sum::<u32>(), n);
            assert!(s.is_legal(r.action));
        }
    }
    let net = fixture();
    for p in game_positions(5).iter().step_by(9) {
        let r = choose(&net, p, &config(123, 0.25)).unwrap();
        assert_eq!(r.visits.iter().sum::<u32>(), 123);
        for a in 0..180u8 {
            assert!(r.visits[usize::from(a)] == 0 || p.is_legal(a));
        }
    }
}

/// [Z11-62]: a terminal root gives `None`, and the evaluator is never called.
#[test]
fn a_terminal_root_has_no_move() {
    let mut s = AzulState::seeded(8);
    while !s.is_terminal() {
        let a = s.legal_actions().as_slice()[0];
        s.apply(a).unwrap();
    }
    let zero = Counting::new(Zero);
    assert!(choose(&zero, &s, &config(100, 0.25)).is_none());
    assert_eq!(zero.calls(), 0);
}

/// [Z11-16]: every action ties — a uniform prior, a value of 0 — so selection
/// takes the lowest action first, and with the first-play reduction nothing
/// unvisited ever overtakes it: every visit, and the move, go to the lowest
/// legal action. And [Z11-19]'s tie-break: with no reduction the visits spread
/// evenly, and equal visits go to the lowest index too.
///
/// Mutation, seen red ([Z11-48]): `>` replaced by `>=` in `Tree::select` sends
/// every visit to the highest action and fails the first half.
#[test]
fn ties_go_to_the_lowest_action() {
    let s = AzulState::seeded(12);
    let legal = s.legal_actions();
    let lowest = legal.as_slice()[0];
    let r = choose(&Zero, &s, &config(50, 0.25)).unwrap();
    assert_eq!(r.action, lowest);
    assert_eq!(r.visits[usize::from(lowest)], 50);

    let n = legal.len() as u32;
    let r = choose(&Zero, &s, &config(3 * n, 0.0)).unwrap();
    assert!(legal.as_slice().iter().all(|&a| r.visits[usize::from(a)] == 3));
    assert_eq!(r.action, lowest);
}

/// P0 to move with one blue in the centre; P1 holds the marker. P0's line 4
/// holds four blue and its wall row 4 lacks only blue, so blue to line 4 ends
/// the game at scoring, P0 27 to P1 25. Every other move ends the round and
/// the game goes on.
fn win_in_one() -> AzulState<Seeded> {
    let mut c = blank();
    c.center = [1, 0, 0, 0, 0];
    c.marker_in_center = false;
    c.floor_marker = [false, true];
    c.bag = (0..40).map(|i| (i % 5) as u8).collect();
    for cell in 20..24 {
        c.walls[0][cell] = 1;
    }
    c.pl_color[0][4] = 0;
    c.pl_count[0][4] = 4;
    c.scores = [20, 25];
    pose(c, 3)
}

/// [Z11-14]: a terminal leaf is valued from `outcome` for the seat to move
/// there: the one move that ends the game in a win is found, although it is
/// the highest-numbered of six and the zero network rates nothing.
///
/// [Z11-7]: that value is `+1` for the seat that wins.
#[test]
fn a_winning_move_is_found() {
    let s = win_in_one();
    let win = encode_action(5, 0, 4).unwrap();
    let mut end = s.clone();
    end.apply(win).unwrap();
    assert!(end.is_terminal() && end.outcome() == Some(azul_engine::Outcome::Player0));
    assert_ne!(s.legal_actions().as_slice()[0], win);
    let r = choose(&Zero, &s, &config(200, 0.0)).unwrap();
    assert_eq!(r.action, win);
    assert!(r.value > 0.5, "the root is worth nearly a win to P0: {}", r.value);
}

/// [Z11-17]: P0 holds the marker and takes the last tile, so the boundary ply
/// leaves P0 to move — and P0 already has a finished row, so it ends the game,
/// won. Two plies of parity would say the seat changed twice; the backed-up
/// value must have the sign of P0's result, positive, whichever move is made.
///
/// Mutation, seen red ([Z11-48]): negating at every step of the backup, as ply
/// parity would, gives a root value of −1 here.
#[test]
fn backup_follows_the_seat_to_move() {
    let mut c = blank();
    c.center = [0, 1, 0, 0, 0];
    c.marker_in_center = false;
    c.floor_marker = [true, false];
    c.bag = (0..20).map(|i| (i % 5) as u8).collect();
    for cell in 0..5 {
        c.walls[0][cell] = 1;
    }
    c.scores = [40, 10];
    let s = pose(c, 5);
    for a in s.legal_actions().as_slice() {
        let mut t = s.clone();
        t.apply(*a).unwrap();
        assert!(t.is_terminal() && t.current_player() == Player::P0);
    }
    let r = choose(&Zero, &s, &config(30, 0.0)).unwrap();
    assert!(r.value > 0.99, "{}", r.value);
}

/// Positions late in a round, where the tree is mostly boundaries.
fn late(seeds: std::ops::Range<u64>, tiles: u8) -> Vec<AzulState<Seeded>> {
    let mut out = Vec::new();
    for seed in seeds {
        let p = game_positions(seed);
        for w in p.windows(2) {
            if w[0].tiles_left() <= tiles && !is_boundary(&w[0], &w[1]) {
                out.push(w[0].clone());
            }
        }
    }
    out
}

/// [Z11-14]: terminal and boundary nodes are valued once, on their first
/// visit. Late in a round, with an evaluator that counts its calls, the total
/// equals the nodes the finished tree holds that the network valued — expanded
/// nodes, the root included, plus non-terminal boundaries — however many times
/// each was visited; and the searches do revisit them, or this would prove
/// nothing.
///
/// Mutation, seen red ([Z11-48]): re-evaluating a boundary child on every
/// visit in `Tree::simulate` makes the calls outnumber the nodes.
#[test]
fn leaves_are_valued_once() {
    let net = fixture();
    let mut revisited = 0;
    for s in late(0..8, 4) {
        let counting = Counting::new(&net);
        let (r, stats) = search(&counting, &s, &config(300, 0.25), None).unwrap();
        assert_eq!(counting.calls(), stats.expanded + stats.boundaries);
        let created = stats.expanded - 1 + stats.boundaries + stats.terminals;
        assert!(created <= 300);
        revisited += 300 - created;
        assert_eq!(r.visits.iter().sum::<u32>(), 300);
    }
    assert!(revisited > 1000, "leaves were revisited {revisited} times");
}

/// `s` with its bag reordered and its shuffler reseeded: everything the
/// search must not see.
fn reshuffled(s: &AzulState<Seeded>, seed: u64) -> AzulState<Seeded> {
    let mut c = s.to_canonical();
    let mut rng = Rng::new(seed);
    for i in (1..c.bag.len()).rev() {
        let j = rng.below(i as u64 + 1) as usize;
        c.bag.swap(i, j);
    }
    AzulState::from_canonical(&c, Seeded::new(seed.wrapping_mul(31))).unwrap()
}

/// [Z11-21]: two states differing only in their bag's order and their
/// shuffler's seed get identical root visits and value — on positions one
/// ordinary deal away and one recycle away, with a non-zero network, since a
/// zero one would make the pre-deal view invisible.
///
/// Mutation, seen red ([Z11-48]): valuing a boundary leaf on `encode()` of the
/// dealt position instead of the pre-deal view fails here.
#[test]
fn the_search_never_sees_the_bag() {
    let net = fixture();
    let positions = late(20..32, 3);
    let recycle = |s: &AzulState<Seeded>| s.to_canonical().bag.len() < 20;
    assert!(positions.iter().any(recycle), "a position one recycle away");
    assert!(positions.iter().any(|s| !recycle(s)), "a position one ordinary deal away");
    let mut compared = 0;
    for s in positions.iter().step_by(2) {
        let base = choose(&net, s, &config(150, 0.25)).unwrap();
        for k in 1..4 {
            let t = reshuffled(s, 1000 + k);
            let bag = s.to_canonical().bag;
            if bag.iter().any(|&x| x != bag[0]) {
                assert_ne!(t.to_canonical().bag, bag, "the order differs");
            }
            assert_ne!(t.shuffler(), s.shuffler());
            let r = choose(&net, &t, &config(150, 0.25)).unwrap();
            assert_eq!(r.visits, base.visits);
            assert_eq!(r.value.to_bits(), base.value.to_bits());
            compared += 1;
        }
    }
    assert!(compared > 20);
}

/// [Z11-19]: in play the search starts afresh every call and draws no noise,
/// so the same position gets the same visits and move every time.
#[test]
fn play_is_a_pure_function_of_the_position() {
    let net = fixture();
    for s in game_positions(40).iter().step_by(11) {
        let a = choose(&net, s, &config(80, 0.25)).unwrap();
        let _ = choose(&net, &game_positions(41)[3], &config(80, 0.25));
        let b = choose(&net, s, &config(80, 0.25)).unwrap();
        assert_eq!(a, b);
        let most = *a.visits.iter().max().unwrap();
        assert_eq!(usize::from(a.action), a.visits.iter().position(|&v| v == most).unwrap());
    }
}

/// [Z11-20]: self-play's noise changes the root's priors, and draws from a
/// generator seeded apart from the shuffler: the noise seed is never the
/// game's seed, and the two streams share no words.
#[test]
fn noise_is_drawn_apart_from_the_shuffle() {
    let s = AzulState::seeded(2);
    let net = fixture();
    let noise = SelfPlayNoise { alpha: 0.3, epsilon: 0.25 };
    let plain = search(&net, &s, &config(100, 0.25), None).unwrap().0;
    let mut rng = Rng::new(9);
    let noisy = search(&net, &s, &config(100, 0.25), Some((&noise, &mut rng))).unwrap().0;
    assert_ne!(plain.visits, noisy.visits);
    for g in 0..20 {
        for i in 0..50 {
            let (a, b) = (game_seed(7, g, i), noise_seed(7, g, i));
            assert_ne!(a, b);
            let mut x = Rng::new(a);
            let mut y = Rng::new(b);
            let xs: Vec<u64> = (0..8).map(|_| x.next_u64()).collect();
            assert!((0..8).all(|_| !xs.contains(&y.next_u64())));
        }
    }
}

/// [Z11-72]: `choose_memoised` over every position of a game, one memo
/// throughout, gives each position exactly `choose`'s visits, action and
/// value, and calls the network fewer times than `choose` does.
///
/// Mutations, seen red ([Z11-48]), each in a copy with its anchor confirmed:
/// in `choose_memoised`, the network's answer never remembered (its
/// `memo.insert` removed), which makes as many calls as `choose`; and in
/// `memo.rs`, the key built from the first 100 observation floats alone.
#[test]
fn a_memoised_choice_is_the_choice() {
    use azul_alphazero::memo::{Memo, choose_memoised};
    let config = SearchConfig { simulations: 64, cpuct: 1.25, fpu: 0.25 };
    let memoised = Counting::new(fixture());
    let plain = Counting::new(fixture());
    let mut memo = Memo::new();
    for (i, s) in support::game_positions(31).iter().enumerate() {
        let a = choose_memoised(&memoised, s, &config, &mut memo).unwrap();
        let b = choose(&plain, s, &config).unwrap();
        assert_eq!(a.visits, b.visits, "position {i}");
        assert_eq!((a.action, a.value.to_bits()), (b.action, b.value.to_bits()), "position {i}");
    }
    assert!(memoised.calls() < plain.calls(), "{} calls against {}", memoised.calls(), plain.calls());
}
