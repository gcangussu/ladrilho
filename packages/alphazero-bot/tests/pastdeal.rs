//! [Z11-91] to [Z11-97]: the past-deal refinement. Each test that names a
//! mutation was seen to fail under it.

mod support;

use azul_alphazero::endgame::{can_end_this_round, refine};
use azul_alphazero::memo::{Memo, choose_memoised, search_memoised_until};
use azul_alphazero::network::{Evaluation, Evaluator, argmax};
use azul_alphazero::pastdeal::{Blend, PastDeal, Pool, Recal, choose_played, search_played};
use azul_alphazero::search::{Search, SearchConfig};
use azul_alphazero::view::{is_boundary, pre_deal_view};
use azul_engine::{Action, AzulState, ENCODED_SIZE, Seeded, wall_color_at};
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

const SHA: &str = "6f44c25ed9376c6eb23a30f175502c9514526485a48517eb6f11c4ebd1a16c3c";

fn pd(blend: Blend, recal: Recal) -> PastDeal {
    PastDeal { checkpoint_sha256: SHA.into(), gate: 4, deals: 4, leaves: 8, budget: 1_000_000, rollouts: true, blend, recal }
}

const SHIFT: Blend = Blend { intercept: 0.1, head: 0.5, dealt: 0.3, rollout: 0.2, sigma: 3.5 };
/// A blend that gives back the head's own value.
const HEAD: Blend = Blend { intercept: 0.0, head: 1.0, dealt: 0.0, rollout: 0.0, sigma: 1.0 };

fn searched<E: Evaluator>(net: &E, root: &AzulState<Seeded>, sims: u32) -> Search<Seeded> {
    let mut search = Search::new(root, &config(sims), None).unwrap();
    let mut e = Evaluation::default();
    while let Some((o, l)) = search.wants() {
        net.evaluate(o, l, &mut e);
        search.supply(&e);
    }
    search
}

/// [Z11-92]: the pool depends on the bag's counts, never its order, and on
/// nothing a move of the round changes, a floor's overflow into the lid
/// included.
///
/// Mutations, seen red: the seed reading the bag in storage order rather than
/// as counts; the seed reading the displays; the seed reading the lid.
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
    // A move that overflows a floor puts tiles in the lid mid-round.
    let mut overflows = 0;
    for seed in 0..40 {
        for s in support::game_positions(seed).into_iter().filter(|s| s.round_index() == 3) {
            for &a in s.legal_actions().as_slice() {
                let mut next = s.clone();
                next.apply(a).unwrap();
                if next.round_index() == s.round_index() && next.to_canonical().lid != s.to_canonical().lid {
                    assert_eq!(Pool::of(&next, 4), Pool::of(&s, 4), "an overflow into the lid");
                    overflows += 1;
                }
            }
        }
    }
    assert!(overflows > 0, "no move overflowed a floor");
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

/// [Z11-92]: the pool deals every leaf of a search the same displays: the
/// deal depends on the bag alone, which no move of a round touches.
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

/// [Z11-91]: the gate. Round index 3, a bag of 20, `gate` tiles left, and a
/// leaf to refine once scaled: each condition alone turns it off.
///
/// Mutations, seen red: the gate off by one (`>` for `>=`); the bag check
/// removed; the scaling check removed.
#[test]
fn it_applies_exactly_where_the_gate_says() {
    let p = pd(SHIFT, Recal::IDENTITY);
    let mut seen = [false; 4];
    for seed in 0..60 {
        for s in support::game_positions(seed) {
            let bag = s.to_canonical().bag.len();
            let want = s.round_index() == 3 && bag >= 20 && s.tiles_left() >= 4;
            assert_eq!(p.applies(&s, 10_000), want, "round {} bag {bag} tiles {}", s.round_index(), s.tiles_left());
            if s.round_index() == 3 {
                seen[0] |= want;
                seen[1] |= bag >= 20 && s.tiles_left() == 4;
                seen[3] |= bag >= 20 && s.tiles_left() == 3;
            }
        }
    }
    // Games reach round 4 with 40 tiles in the bag, so a short bag is posed:
    // tiles moved from the bag to the lid, which the census allows.
    for s in round_four(0..10, 20) {
        let mut c = s.to_canonical();
        while c.bag.len() > 19 {
            let t = c.bag.pop().unwrap();
            c.lid[usize::from(t)] += 1;
        }
        let short = AzulState::from_canonical(&c, Seeded::new(0)).unwrap();
        assert_eq!(p.applies(&short, 10_000), false, "a bag of 19");
        seen[2] |= s.tiles_left() >= 4;
    }
    assert_eq!(seen, [true; 4], "every edge of the gate was met");
    // 8 leaves at 10 000: none below 1 250 simulations.
    let root = round_four(0..10, 20).into_iter().find(|s| p.applies(s, 10_000)).unwrap();
    assert!(p.applies(&root, 1_250) && !p.applies(&root, 1_249));
}

/// [Z11-93]: the cap and the budget scale down in proportion below 10 000
/// simulations, in integers, and stay above it.
#[test]
fn the_cap_and_the_budget_scale_in_integers() {
    let p = PastDeal { leaves: 32, budget: 4_000, ..pd(SHIFT, Recal::IDENTITY) };
    assert_eq!(p.scaled(10_000), (32, 4_000));
    assert_eq!(p.scaled(200_000), (32, 4_000));
    assert_eq!(p.scaled(5_000), (16, 2_000));
    assert_eq!(p.scaled(1_000), (3, 400));
    assert_eq!(p.scaled(312), (0, 124));
    assert_eq!(p.scaled(313), (1, 125));
}

/// [Z11-96]: without the refinement, or where it does not apply, the move is
/// `choose_memoised`'s, bit for bit, the proof included.
#[test]
fn where_it_does_not_apply_the_move_is_choose_memoiseds() {
    let net = fixture();
    let p = pd(SHIFT, Recal { a: 0.3, b: 0.5 });
    let cfg = SearchConfig { endgame_nodes: 100_000, ..config(300) };
    let mut checked = 0;
    for seed in 0..3 {
        for s in support::game_positions(seed).into_iter().step_by(5) {
            let want = choose_memoised(&net, &s, &cfg, Memo::new());
            assert_eq!(choose_played(&net, &s, &cfg, None, Memo::new()), want);
            if !p.applies(&s, cfg.simulations) {
                assert_eq!(choose_played(&net, &s, &cfg, Some(&p), Memo::new()), want);
                checked += 1;
            }
        }
    }
    assert!(checked > 20);
    // Below the scaling's floor: 8 leaves at 300 simulations scale to none.
    let root = round_four(0..10, 20).into_iter().find(|s| p.applies(s, 10_000)).unwrap();
    assert_eq!(choose_played(&net, &root, &cfg, Some(&p), Memo::new()), choose_memoised(&net, &root, &cfg, Memo::new()));
}

/// [Z11-96]: a refinement that gives every leaf back its own value changes
/// nothing: the second search is the first, and both are
/// `search_memoised_until`'s.
#[test]
fn a_refinement_that_changes_no_value_changes_nothing() {
    let net = fixture();
    let p = PastDeal { rollouts: false, ..pd(HEAD, Recal::IDENTITY) };
    for root in round_four(30..34, 12) {
        let want = search_memoised_until(&net, &root, &config(4_000), &mut Memo::new(), &mut || false).unwrap();
        let played = search_played(&net, &root, &config(4_000), Some(&p), &mut Memo::new()).unwrap();
        assert!(played.applied && played.refined > 0);
        assert_eq!(played.first, want);
        assert_eq!(played.result, want);
    }
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

/// [Z11-95], [Z11-96]: the second search values every boundary leaf, refined
/// or not, and nothing else, by the refinement. With a blend that is the
/// recalibration, it is a search on a network whose boundary values alone
/// are recalibrated.
///
/// Mutations, seen red: recalibrating every request; recalibrating none.
#[test]
fn the_second_search_revalues_the_boundaries_and_only_them() {
    let net = fixture();
    let recal = Recal { a: 0.2, b: 0.6 };
    let p = PastDeal { rollouts: false, ..pd(Blend { intercept: recal.a, head: recal.b, dealt: 0.0, rollout: 0.0, sigma: 1.0 }, recal) };
    for root in round_four(50..54, 12) {
        let shifted = Boundaries { net: &net, f: |v| recal.apply(v) };
        let want = search_memoised_until(&shifted, &root, &config(4_000), &mut Memo::new(), &mut || false).unwrap();
        let played = search_played(&net, &root, &config(4_000), Some(&p), &mut Memo::new()).unwrap();
        assert_eq!(played.result, want);
    }
}

/// [Z11-96]: the refined values reach the second search: valued at the blend,
/// the refined leaves move the root's value off the first search's.
///
/// Mutation, seen red: the second search reading the recalibration for every
/// boundary.
#[test]
fn the_refined_values_reach_the_second_search() {
    let net = fixture();
    let all_won = Blend { intercept: 1.0, head: 0.0, dealt: 0.0, rollout: 0.0, sigma: 1.0 };
    let p = PastDeal { rollouts: false, ..pd(all_won, Recal::IDENTITY) };
    let (mut refined, mut moved) = (0, 0);
    for root in round_four(60..70, 10) {
        let played = search_played(&net, &root, &config(4_000), Some(&p), &mut Memo::new()).unwrap();
        if played.refined > 0 {
            refined += 1;
            moved += usize::from(played.result.value != played.first.value);
        }
    }
    assert!(refined >= 5 && moved == refined, "{moved} of {refined} moved");
}

/// [Z11-93]: the refinement's calls bypass the memo, so a memo warm from
/// earlier moves changes nothing but the searches' misses, also where the
/// budget binds.
///
/// Mutation, seen red: the rungs' head asked through the memo.
#[test]
fn a_warm_memo_changes_nothing() {
    let net = fixture();
    let p = PastDeal { budget: 60, ..pd(SHIFT, Recal { a: 0.02, b: 0.97 }) };
    for root in round_four(70..73, 12) {
        let cold = search_played(&net, &root, &config(2_000), Some(&p), &mut Memo::new()).unwrap();
        assert!(cold.calls_refine >= 60 && cold.refined < 8, "the budget binds");
        let mut memo = Memo::new();
        let _ = search_played(&net, &root, &config(2_000), Some(&p), &mut memo).unwrap();
        for &a in root.legal_actions().as_slice().iter().take(3) {
            let mut child = root.clone();
            child.apply(a).unwrap();
            let _ = search_memoised_until(&net, &child, &config(500), &mut memo, &mut || false);
        }
        let warm = search_played(&net, &root, &config(2_000), Some(&p), &mut memo).unwrap();
        assert_eq!((&warm.result, &warm.first, warm.refined, warm.calls_refine), (&cold.result, &cold.first, cold.refined, cold.calls_refine));
        assert!(warm.calls_first < cold.calls_first);
    }
}

/// The same position twice: the same move, calls and refinement.
#[test]
fn it_is_deterministic() {
    let net = fixture();
    let p = pd(SHIFT, Recal { a: 0.02, b: 0.97 });
    for root in round_four(80..83, 10) {
        let run = || search_played(&net, &root, &config(2_000), Some(&p), &mut Memo::new()).unwrap();
        let (a, b) = (run(), run());
        assert_eq!(a, b);
        assert!(a.refined > 0 && a.applied);
    }
}

/// `root` with one wall row of the player to move filled to four tiles, the
/// tiles taken from the lid, else the bag; `None` if the engine refuses it.
fn with_four_in_a_row(root: &AzulState<Seeded>) -> Option<AzulState<Seeded>> {
    let mut c = root.to_canonical();
    let me = c.current_player.index();
    for row in 0..5 {
        let filled = (0..5).filter(|&col| c.walls[me][row * 5 + col] != 0).count();
        if filled == 4 {
            return AzulState::from_canonical(&c, Seeded::new(0)).ok();
        }
        if c.pl_count[me][row] != 0 {
            continue;
        }
        let mut c2 = c.clone();
        let mut ok = true;
        for col in 0..5 {
            if (0..5).filter(|&k| c2.walls[me][row * 5 + k] != 0).count() == 4 {
                break;
            }
            if c2.walls[me][row * 5 + col] != 0 {
                continue;
            }
            let colour = usize::from(wall_color_at(row as u8, col as u8));
            if c2.lid[colour] > 0 {
                c2.lid[colour] -= 1;
            } else if let Some(i) = c2.bag.iter().position(|&t| usize::from(t) == colour) {
                c2.bag.remove(i);
            } else {
                ok = false;
                break;
            }
            c2.walls[me][row * 5 + col] = 1;
        }
        if ok && c2.bag.len() >= 20 {
            if let Ok(s) = AzulState::from_canonical(&c2, Seeded::new(0)) {
                return Some(s);
            }
        }
    }
    None
}

/// [Z11-96], [Z11-76]: the endgame proof follows the second search. No
/// reachable round-4 position lets the proof run, so the positions are posed:
/// round-4 positions with a four-tile wall row, where the game can end.
///
/// Mutation, seen red: `choose_played` returning the second search's result
/// without the proof.
#[test]
fn the_proof_follows_the_second_search() {
    let net = fixture();
    let p = pd(SHIFT, Recal { a: 0.02, b: 0.97 });
    let cfg = SearchConfig { endgame_nodes: 2_000_000, ..config(1_500) };
    let (mut posed, mut changed) = (0, 0);
    for root in round_four(0..80, 12).iter().filter_map(with_four_in_a_row) {
        if !p.applies(&root, cfg.simulations) || !can_end_this_round(&root) {
            continue;
        }
        posed += 1;
        let played = search_played(&net, &root, &cfg, Some(&p), &mut Memo::new()).unwrap();
        let proved = refine(&root, played.result.clone(), cfg.endgame_nodes).0;
        assert_eq!(choose_played(&net, &root, &cfg, Some(&p), Memo::new()).unwrap(), proved);
        if proved != played.result {
            changed += 1;
        }
    }
    assert!(posed >= 10, "{posed} posed");
    assert!(changed >= 1, "the proof changed none of {posed}");
}

/// [Z11-97]: `pastdeal.json` as the fit writes it parses; a file that is not
/// one is refused.
#[test]
fn the_settings_file_is_read_strictly() {
    let shipped = support::read(&support::crate_dir().join("milestones/twelfth/120/pastdeal.json"));
    let p = PastDeal::parse(&shipped).unwrap();
    assert_eq!((p.gate, p.deals, p.leaves, p.budget, p.rollouts), (4, 8, 32, 4_000, true));
    assert_eq!(p.checkpoint_sha256, SHA);
    let text = String::from_utf8(shipped).unwrap();
    for (from, to) in [
        ("\"gate\": 4", "\"gate\": 21"),
        ("\"deals\": 8", "\"deals\": 0"),
        ("\"sigma\": 3.0", "\"sigma\": 0.0"),
        ("\"rollouts\": true", "\"rollouts\": 1"),
        (SHA, "6f44"),
        ("\"leaves\": 32", "\"leaves\": 32, \"extra\": 1"),
    ] {
        assert!(text.contains(from), "{from}");
        assert!(PastDeal::parse(text.replacen(from, to, 1).as_bytes()).is_err(), "{to}");
    }
}

/// [Z11-94]: a rollout's move is the legal action of the highest logit, the
/// lowest action on a tie, read from the logits the forward pass computes,
/// not from the policy, whose `exp` may round differently on another build.
/// This catches a wrong argmax; a `greedy` reading the policy would mostly
/// agree with the logits' and is not what it can see.
///
/// Mutations, seen red: ties to the highest action; `Network::greedy` taking
/// the lowest logit.
#[test]
fn the_greedy_move_is_the_highest_logit() {
    let net = fixture();
    let mut checked = 0;
    for s in support::game_positions(90).into_iter().chain(support::game_positions(91)) {
        let legal = s.legal_actions();
        let mut logits = [0f32; 180];
        net.forward(&s.encode(), &mut logits);
        let mut want = legal.as_slice()[0];
        for &a in legal.as_slice() {
            if logits[usize::from(a)] > logits[usize::from(want)] {
                want = a;
            }
        }
        assert_eq!(net.greedy(&s.encode(), legal.as_slice()), want);
        checked += 1;
    }
    assert!(checked > 40);
    let mut flat = [0f32; 180];
    assert_eq!(argmax(&flat, &[7, 3, 9]), 3, "a tie goes to the lowest action");
    flat[9] = 1.0;
    assert_eq!(argmax(&flat, &[7, 3, 9]), 9);
}
