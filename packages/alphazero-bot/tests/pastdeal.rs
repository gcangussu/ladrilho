//! The past-deal lookahead (`pastdeal`): an experiment, not yet a
//! requirement, so these tests cite none. Each was seen to fail under the
//! mutation it names.

mod support;

use azul_alphazero::memo::{Memo, search_memoised_until};
use azul_alphazero::network::{Evaluation, Evaluator};
use azul_alphazero::pastdeal::{Blend, Mode, PastDeal, Pool, Recal, applies, choose_past_deal};
use azul_alphazero::search::{Search, SearchConfig};
use azul_alphazero::view::{is_boundary, pre_deal_view};
use azul_engine::{Action, AzulState, ENCODED_SIZE, Seeded};
use support::fixture;

fn config(simulations: u32) -> SearchConfig {
    SearchConfig { simulations, cpuct: 1.25, fpu: 0.25, endgame_nodes: 0 }
}

/// Round-4 positions of uniform games with at most `tiles` tiles left.
fn round_four(seeds: std::ops::Range<u64>, tiles: u8) -> Vec<AzulState<Seeded>> {
    seeds
        .filter_map(|seed| {
            support::game_positions(seed).into_iter().find(|s| s.round_index() == 3 && s.tiles_left() <= tiles)
        })
        .collect()
}

fn pd(mode: Mode, leaves: u32, recal: Recal) -> PastDeal {
    PastDeal {
        mode,
        deals: 4,
        leaves,
        budget: 1_000_000,
        rollouts: true,
        blend: Blend { intercept: 0.1, head: 0.5, dealt: 0.3, rollout: 0.2, sigma: 3.5, deep: 0.0 },
        deep: None,
        recal,
    }
}

fn searched<E: Evaluator>(net: &E, root: &AzulState<Seeded>, sims: u32) -> Search<Seeded> {
    let mut search = Search::new(root, &config(sims), None).unwrap();
    let mut e = Evaluation::default();
    while let Some((o, l)) = search.wants() {
        net.evaluate(o, l, &mut e);
        search.supply(&e);
    }
    search
}

/// Mutations, seen red: the seed reading the bag in storage order rather than
/// as counts; the seed reading the displays.
#[test]
fn the_pool_reads_only_what_a_round_leaves_fixed() {
    for s in round_four(0..6, 20) {
        let pool = Pool::of(&s, 4);
        let mut c = s.to_canonical();
        c.bag.reverse();
        c.bag.rotate_left(3);
        let shuffled = AzulState::from_canonical(&c, Seeded::new(99)).unwrap();
        assert_eq!(Pool::of(&shuffled, 4), pool, "the bag's order");
        let mut next = s.clone();
        next.apply(s.legal_actions().as_slice()[0]).unwrap();
        if next.round_index() == s.round_index() {
            assert_eq!(Pool::of(&next, 4), pool, "a move of the same round");
        }
        let mut other = s.to_canonical();
        other.scores[0] += 1;
        let other = AzulState::from_canonical(&other, Seeded::new(0)).unwrap();
        assert_ne!(Pool::of(&other, 4).orders, pool.orders, "a different score");
    }
}

/// Every boundary leaf of a search, walked from the root, is a boundary ply
/// whose pre-deal view the network values as the leaf holds; there are as many
/// as the tree counts.
///
/// Mutation, seen red: the walk not applying the edge's action on descent.
#[test]
fn the_walk_finds_every_boundary_leaf_as_the_search_made_it() {
    let net = fixture();
    let mut checked = 0;
    for root in round_four(10..14, 8) {
        let search = searched(&net, &root, 300);
        let leaves = search.boundary_leaves();
        assert_eq!(leaves.len() as u32, search.stats().boundaries);
        let mut e = Evaluation::default();
        for leaf in &leaves {
            let mut after = leaf.before.clone();
            after.apply(leaf.action).unwrap();
            assert!(is_boundary(&leaf.before, &after) && !after.is_terminal());
            net.evaluate(&pre_deal_view(&leaf.before, &after), &[], &mut e);
            assert_eq!(e.value, leaf.value);
            checked += 1;
        }
    }
    assert!(checked > 20, "{checked} leaves");
}

/// The pool deals every leaf of a search the same displays: the deal depends
/// on the bag alone, which no move of a round touches.
///
/// Mutation, seen red: the pool's order rotated by the leaf's position.
#[test]
fn every_leaf_is_dealt_the_same_deals() {
    let net = fixture();
    let root = round_four(20..21, 8).remove(0);
    let leaves = searched(&net, &root, 300).boundary_leaves();
    assert!(leaves.len() >= 2);
    let pool = Pool::of(&root, 4);
    for k in 0..4 {
        let displays: Vec<_> = leaves
            .iter()
            .map(|l| pool.deal(&l.before, l.action, k).unwrap().to_canonical().factories)
            .collect();
        assert!(displays.windows(2).all(|w| w[0] == w[1]), "deal {k}");
    }
}

/// With nothing refined and the identity recalibration, the second search is
/// the first, and both are `search_memoised_until`'s, bit for bit.
#[test]
fn an_empty_refinement_changes_nothing() {
    let net = fixture();
    for root in round_four(30..34, 12) {
        let mut memo = Memo::new();
        let want = search_memoised_until(&net, &root, &config(400), &mut Memo::new(), &mut || false).unwrap();
        for mode in [Mode::TwoPass, Mode::RecalOnly] {
            let p = choose_past_deal(&net, &root, &config(400), &pd(mode, 0, Recal::IDENTITY), &mut memo, &mut || false)
                .unwrap();
            assert_eq!(p.first, want);
            assert_eq!(p.result, want);
            assert!(p.applied);
        }
    }
}

/// Outside round 4 the lookahead does not apply, and the search is today's.
#[test]
fn outside_round_four_it_is_todays_search() {
    let net = fixture();
    let root = support::game_positions(40).into_iter().find(|s| s.round_index() == 1).unwrap();
    assert!(!applies(&root));
    let want = search_memoised_until(&net, &root, &config(300), &mut Memo::new(), &mut || false).unwrap();
    let p = choose_past_deal(&net, &root, &config(300), &pd(Mode::TwoPass, 16, Recal { a: 0.3, b: 0.5 }), &mut Memo::new(), &mut || false)
        .unwrap();
    assert_eq!(p.result, want);
    assert!(!p.applied);
}

/// An evaluator whose boundary values (requests with no legal set) are
/// replaced by `f` of the network's.
struct Boundaries<E, F> {
    net: E,
    f: F,
}

impl<E: Evaluator, F: Fn(f32) -> f32 + Sync> Evaluator for Boundaries<E, F> {
    fn evaluate(&self, o: &[f32; ENCODED_SIZE], legal: &[Action], out: &mut Evaluation) {
        self.net.evaluate(o, legal, out);
        if legal.is_empty() {
            out.value = (self.f)(out.value);
        }
    }
}

/// The recalibration reaches every boundary leaf and nothing else: the
/// recalibration-only search is today's search on a network whose boundary
/// values alone are recalibrated.
///
/// Mutations, seen red: recalibrating every request; recalibrating none.
#[test]
fn the_recalibration_reaches_the_boundaries_and_only_them() {
    let net = fixture();
    let recal = Recal { a: 0.2, b: 0.6 };
    for root in round_four(50..54, 12) {
        let shifted = Boundaries { net: &net, f: |v| recal.apply(v) };
        let want = search_memoised_until(&shifted, &root, &config(400), &mut Memo::new(), &mut || false).unwrap();
        let p = choose_past_deal(&net, &root, &config(400), &pd(Mode::RecalOnly, 0, recal), &mut Memo::new(), &mut || false)
            .unwrap();
        assert_eq!(p.result, want);
    }
}

/// A stop during the first search plays the first search, which is the
/// search stopped at the same point; a stop during refinement or the second
/// search plays the first search's move too.
#[test]
fn a_stop_plays_the_first_search() {
    let net = fixture();
    for root in round_four(60..63, 12) {
        for at in [5u32, 40] {
            let mut n = 0;
            let mut stop = || {
                n += 1;
                n > at
            };
            let want = search_memoised_until(&net, &root, &config(400), &mut Memo::new(), &mut stop).unwrap();
            let mut n = 0;
            let mut stop = || {
                n += 1;
                n > at
            };
            let p = choose_past_deal(&net, &root, &config(400), &pd(Mode::TwoPass, 8, Recal::IDENTITY), &mut Memo::new(), &mut stop)
                .unwrap();
            assert_eq!(p.first, want, "stopped at {at}");
            assert_eq!(p.result, want);
            assert!(!p.applied);
        }
        // Count the first search's questions, then stop just after it.
        let full = search_memoised_until(&net, &root, &config(400), &mut Memo::new(), &mut || false).unwrap();
        let mut n = 0u32;
        let first_questions = {
            let mut q = 0u32;
            let _ = search_memoised_until(&net, &root, &config(400), &mut Memo::new(), &mut || {
                q += 1;
                false
            });
            q
        };
        let p = choose_past_deal(&net, &root, &config(400), &pd(Mode::TwoPass, 8, Recal::IDENTITY), &mut Memo::new(), &mut || {
            n += 1;
            n > first_questions
        })
        .unwrap();
        assert_eq!(p.result, full, "a stop after the first search");
        assert_eq!(p.refined, 0);
        assert!(!p.applied);
    }
}

/// The same position twice: the same move, calls and refinement.
#[test]
fn it_is_deterministic() {
    let net = fixture();
    for root in round_four(70..73, 10) {
        let run = || choose_past_deal(&net, &root, &config(300), &pd(Mode::TwoPass, 8, Recal { a: 0.02, b: 0.97 }), &mut Memo::new(), &mut || false).unwrap();
        let (a, b) = (run(), run());
        assert_eq!(a, b);
        assert!(a.refined > 0 && a.applied);
    }
}
