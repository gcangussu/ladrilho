//! The improved policy ([Z11-86]) and its use as self-play's target ([Z11-87]).

mod support;

use azul_alphazero::config::{RunConfig, SearchKind, settings};
use azul_alphazero::improved::{Transform, completed_q, improved_policy, interior_pick, weights};
use azul_alphazero::network::{Evaluation, Evaluator};
use azul_alphazero::rng::Rng;
use azul_alphazero::samples::{Kind, mask_has, read_all};
use azul_alphazero::search::{Search, SearchConfig, SelfPlayNoise};
use azul_alphazero::selfplay::self_play;
use azul_engine::AzulState;
use serde_json::Value;
use support::{config_json, crate_dir, fixture, read};

const MCTX: Transform = Transform { c_visit: 50.0, c_scale: 0.1 };

fn recorded() -> Value {
    serde_json::from_slice(&read(&crate_dir().join("test/fixtures/improved.json"))).unwrap()
}

fn floats(v: &Value) -> Vec<f64> {
    v.as_array().unwrap().iter().map(|x| x.as_f64().unwrap()).collect()
}

/// [Z11-86]: completed Q and the improved policy equal mctx's on every
/// recorded case: mixed and low visits, every legal action visited, none
/// visited, every completed value equal, a zero prior, one and two legal
/// actions. The priors are f32 on both sides; mctx renormalises them where we
/// do not, which is the last bit of an f32 and inside the tolerance.
///
/// Mutations, seen red ([Z11-48]), each in a copy with its anchor confirmed:
/// the rescale's range taken over the legal values alone, without `v_mix`
/// (fails `all-visited`); its floor `1e-8` raised to `1.0`,
/// as olivkoch's rescale has it (fails a `mixed` case, whose range is under 1);
/// `c_scale` read as 1; the mixed value's network term negated.
#[test]
fn the_improved_policy_is_mctxs() {
    let f = recorded();
    let cases = f["improved"].as_array().unwrap();
    assert!(cases.len() >= 70);
    for (i, c) in cases.iter().enumerate() {
        let prior: Vec<f32> = floats(&c["prior"]).iter().map(|&p| p as f32).collect();
        let visits: Vec<u32> = floats(&c["visits"]).iter().map(|&n| n as u32).collect();
        let q = floats(&c["q"]);
        let value = c["value"].as_f64().unwrap() as f32;
        let mode = c["mode"].as_str().unwrap();
        let completed = completed_q(&prior, &visits, &q, value, &MCTX);
        for (a, (&ours, theirs)) in completed.iter().zip(floats(&c["completed"])).enumerate() {
            assert!((ours - theirs).abs() <= 1e-5 * theirs.abs().max(1.0), "case {i} ({mode}) action {a}: {ours} against {theirs}");
        }
        let policy = improved_policy(&prior, &visits, &q, value, &MCTX);
        for (a, (&ours, theirs)) in policy.iter().zip(floats(&c["policy"])).enumerate() {
            assert!((ours - theirs).abs() <= 1e-6, "case {i} ({mode}) action {a}: {ours} against {theirs}");
        }
    }
}

/// [Z11-86]: with a frozen policy, the interior pick chooses mctx's sequence,
/// step for step from zero visits, and keeps every action's visits within two
/// of its share. (Within `1 / (1 + ΣN)` of `π` does not hold: the worst case
/// found by simulation is 1.11 visits.)
///
/// Mutation, seen red ([Z11-48]): `1 + ΣN` as `ΣN`.
#[test]
fn the_interior_pick_is_mctxs() {
    let f = recorded();
    for (i, c) in f["interior"].as_array().unwrap().iter().enumerate() {
        let policy = floats(&c["policy"]);
        let mut visits = vec![0u32; policy.len()];
        for (step, want) in c["chosen"].as_array().unwrap().iter().enumerate() {
            let a = interior_pick(&policy, &visits);
            assert_eq!(a as u64, want.as_u64().unwrap(), "case {i} step {step}");
            visits[a] += 1;
            let total = f64::from(step as u32 + 1);
            for (&n, &p) in visits.iter().zip(&policy) {
                assert!((f64::from(n) - p * total).abs() <= 2.0, "case {i} step {step}");
            }
        }
    }
}

/// [Z11-27]: weights sum to 65 535 within one per legal action.
#[test]
fn weights_sum_to_the_scale() {
    let policy = [0.5, 0.25, 0.125, 0.0625, 0.0625];
    let w: Vec<u16> = weights(&policy).collect();
    assert_eq!(w, vec![32768, 16384, 8192, 4096, 4096]);
    let total: u32 = w.iter().map(|&x| u32::from(x)).sum();
    assert!(total.abs_diff(65535) <= policy.len() as u32);
}

/// The network's policy at `state`'s root, over its legal set.
fn root_policy(net: &impl Evaluator, state: &AzulState<azul_engine::Seeded>) -> Vec<f32> {
    let legal = state.legal_actions();
    let mut e = Evaluation::default();
    net.evaluate(&state.encode(), legal.as_slice(), &mut e);
    legal.as_slice().iter().map(|&a| e.policy[usize::from(a)]).collect()
}

fn run_search(state: &AzulState<azul_engine::Seeded>, noise: Option<(&SelfPlayNoise, &mut Rng)>) -> Search<azul_engine::Seeded> {
    let net = fixture();
    let config = SearchConfig { simulations: 200, cpuct: 1.25, fpu: 0.25, endgame_nodes: 0 };
    let mut search = Search::new(state, &config, noise).unwrap();
    let mut e = Evaluation::default();
    while let Some((o, l)) = search.wants() {
        net.evaluate(o, l, &mut e);
        search.supply(&e);
    }
    search
}

/// [Z11-86]: under root noise the improved policy is built from the
/// network's clean priors, not the noised ones the search selects with, and
/// it is exactly the policy of the root's statistics, written as weights.
///
/// Mutation, seen red ([Z11-48]): the clean copy taken after the noise is
/// mixed in.
#[test]
fn the_target_is_built_from_the_clean_priors() {
    let state = AzulState::seeded(5);
    let clean = root_policy(&fixture(), &state);
    let noise = SelfPlayNoise { alpha: 0.3, epsilon: 0.25 };
    let mut rng = Rng::new(3);
    let search = run_search(&state, Some((&noise, &mut rng)));
    let r = search.root_statistics();
    assert_eq!(r.priors, clean, "the priors the target reads are not the network's");
    let policy = improved_policy(&r.priors, &r.visits, &r.q, r.value, &MCTX);
    let mut want = [0u16; azul_engine::ACTION_SPACE];
    for (&a, w) in r.actions.iter().zip(weights(&policy)) {
        want[usize::from(a)] = w;
    }
    assert_eq!(search.improved(&MCTX), want);
    // A search without noise reads the same clean priors.
    assert_eq!(run_search(&state, None).root_statistics().priors, clean);
}

/// [Z11-86]: what the target reads of the root is what the search found:
/// each action's visits are the root visits `finish` reports, and the
/// visit-weighted mean of the actions' Q is the root value `finish` backs up,
/// from the root's seat. Held on every position of three games, among them
/// roots whose children end the round with the seat to move kept and with it
/// changed ([Z11-17]), where a Q read from the wrong seat shows.
///
/// Mutations, seen red ([Z11-48]): Q read from the child's own network value
/// (`c.value`) instead of `total / taken`; an action's visits read as the
/// child's `visits` instead of `taken`.
#[test]
fn the_target_reads_the_search_as_it_backed_up() {
    use azul_alphazero::view::is_boundary;
    let net = fixture();
    let config = SearchConfig { simulations: 120, cpuct: 1.25, fpu: 0.25, endgame_nodes: 0 };
    let (mut kept, mut changed) = (0, 0);
    for seed in [3, 4, 5] {
        for state in support::game_positions(seed) {
            let mut search = Search::new(&state, &config, None).unwrap();
            let mut e = Evaluation::default();
            while let Some((o, l)) = search.wants() {
                net.evaluate(o, l, &mut e);
                search.supply(&e);
            }
            let r = search.root_statistics();
            let (result, _) = search.finish();
            for (&a, &n) in r.actions.iter().zip(&r.visits) {
                assert_eq!(n, result.visits[usize::from(a)]);
            }
            let total: f64 = r.visits.iter().map(|&n| f64::from(n)).sum();
            let mean: f64 = r.visits.iter().zip(&r.q).map(|(&n, &q)| f64::from(n) * q).sum::<f64>() / total;
            assert!((mean - f64::from(result.value)).abs() < 1e-5, "{mean} against {}", result.value);
            for (&a, &n) in r.actions.iter().zip(&r.visits) {
                let mut after = state.clone();
                after.apply(a).unwrap();
                if n > 0 && !after.is_terminal() && is_boundary(&state, &after) {
                    if after.current_player() == state.current_player() { kept += 1 } else { changed += 1 }
                }
            }
        }
    }
    assert!(kept > 0 && changed > 0, "boundary children: {kept} keeping the seat, {changed} changing it");
}

fn config_with(extra: &[(&str, &str)]) -> RunConfig {
    let mut f = vec![("selfPlaySimulations", "24"), ("threads", "2"), ("cheapSimulations", "6"), ("fullSearchFraction", "0.5")];
    f.extend_from_slice(extra);
    RunConfig::parse(config_json(&f).as_bytes()).unwrap()
}

/// [Z11-87]: the improved target changes the policy weights of a full
/// search's move sample and nothing else: the same games are played, every
/// other byte of every sample is the same, and the weights stay inside the
/// legal set and sum to 65 535 within one per legal action. Without the key,
/// the weights are the root visits, summing to the simulations.
///
/// Mutations, seen red ([Z11-48]): the target never written, the weights left
/// at zero; the visits written rescaled to 65 535 in its place.
#[test]
fn the_improved_target_changes_only_the_target() {
    let net = fixture();
    let plain = config_with(&[]);
    let improved = config_with(&[("improvedCScale", "0.1")]);
    assert_eq!(improved.improved, Some(MCTX));
    let a = self_play(&net, &settings(&plain, SearchKind::SelfPlay).unwrap(), plain.seed, 3, 6);
    let b = self_play(&net, &settings(&improved, SearchKind::SelfPlay).unwrap(), improved.seed, 3, 6);
    assert_eq!(a.aux, b.aux, "the games ended differently");
    let (sa, sb) = (read_all(&a.samples).unwrap(), read_all(&b.samples).unwrap());
    assert_eq!(sa.len(), sb.len());
    let mut moves = 0;
    let mut differs = 0;
    for (x, y) in sa.iter().zip(&sb) {
        assert_eq!((x.kind, x.result, x.observation, x.legal), (y.kind, y.result, y.observation, y.legal));
        if x.kind != Kind::Move {
            assert_eq!(x.visits, y.visits);
            continue;
        }
        moves += 1;
        let visits: u32 = x.visits.iter().map(|&v| u32::from(v)).sum();
        assert_eq!(visits, 24);
        let legal = (0..180).filter(|&a| mask_has(&y.legal, a)).count() as u32;
        let total: u32 = y.visits.iter().map(|&v| u32::from(v)).sum();
        assert!(total.abs_diff(65535) <= legal, "weights sum to {total}");
        assert!((0..180).all(|a| y.visits[a] == 0 || mask_has(&y.legal, a)));
        // Not the visits rescaled: the improved policy weights by value.
        let off: f64 = (0..180).map(|a| (f64::from(y.visits[a]) - f64::from(x.visits[a]) * 65535.0 / 24.0).abs()).sum();
        if off > 1000.0 {
            differs += 1;
        }
    }
    assert!(moves > 50);
    assert!(differs * 2 > moves, "{differs} of {moves} targets differ from the rescaled visits");
}

/// [Z11-87]: `improvedCVisit` goes with `improvedCScale`, both in range, the
/// visit constant defaulting to mctx's; and only self-play reads them.
#[test]
fn the_improved_settings_are_checked() {
    let parse = |extra: &[(&str, &str)]| RunConfig::parse(config_json(extra).as_bytes());
    assert_eq!(parse(&[]).unwrap().improved, None);
    let ok = parse(&[("improvedCScale", "0.05"), ("improvedCVisit", "20")]).unwrap();
    assert_eq!(ok.improved, Some(Transform { c_visit: 20.0, c_scale: 0.05 }));
    assert_eq!(settings(&ok, SearchKind::SelfPlay).unwrap().improved, ok.improved);
    for kind in [SearchKind::Play, SearchKind::Milestone, SearchKind::Latency(Some(10))] {
        assert_eq!(settings(&ok, kind).unwrap().improved, None);
    }
    for bad in [
        vec![("improvedCVisit", "50")],
        vec![("improvedCScale", "0")],
        vec![("improvedCScale", "11")],
        vec![("improvedCScale", "0.1"), ("improvedCVisit", "-1")],
    ] {
        assert!(parse(&bad).is_err(), "{bad:?} was accepted");
    }
}
