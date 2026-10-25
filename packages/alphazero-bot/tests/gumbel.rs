//! Gumbel search ([Z11-88]) and Gumbel self-play ([Z11-89]).

mod support;

use azul_alphazero::config::{DEFAULT_TRANSFORM, RunConfig, SearchKind, settings};
use azul_alphazero::improved::{Transform, completed_q, considered_pick, considered_visits, improved_policy};
use azul_alphazero::network::{Evaluation, Evaluator as _};
use azul_alphazero::rng::Rng;
use azul_alphazero::samples::{Kind, read_all};
use azul_alphazero::search::{GumbelConfig, Search, SearchConfig};
use azul_alphazero::selfplay::self_play;
use azul_engine::{AzulState, Seeded};
use serde_json::Value;
use support::{config_json, crate_dir, fixture, read};

const MCTX: Transform = DEFAULT_TRANSFORM;

fn recorded() -> Value {
    serde_json::from_slice(&read(&crate_dir().join("test/fixtures/gumbel.json"))).unwrap()
}

fn floats(v: &Value) -> Vec<f64> {
    v.as_array().unwrap().iter().map(|x| x.as_f64().unwrap()).collect()
}

/// [Z11-88]: the halving table is mctx's, entry for entry, for every `m` in
/// 1..=64 at budgets from 1 to 1 000, and at 2 000 for three `m`.
///
/// Mutation, seen red ([Z11-48]): `log2` rounded down instead of up.
#[test]
fn the_halving_table_is_mctxs() {
    let f = recorded();
    let rows = f["table"].as_array().unwrap();
    assert!(rows.len() > 400);
    for row in rows {
        let (m, n) = (row["considered"].as_u64().unwrap() as usize, row["simulations"].as_u64().unwrap() as usize);
        let want: Vec<u32> = floats(&row["visits"]).iter().map(|&v| v as u32).collect();
        assert_eq!(considered_visits(m, n), want, "m {m}, n {n}");
    }
}

/// [Z11-88]: on a bandit whose every root action has a fixed Q, the root's
/// selection run simulation by simulation ends where mctx's
/// `gumbel_muzero_policy` ends: the same visits, the same action, the same
/// improved policy. Covers one and two legal actions, fewer actions than
/// considered, budgets below and far above `m`, `m` of 4, 16 and 32, and a
/// draw of scale 0.
///
/// Mutation, seen red ([Z11-48]): an action considered when its visits are
/// at most the table's, not equal to it.
#[test]
fn the_root_is_mctxs() {
    let f = recorded();
    for (i, c) in f["bandit"].as_array().unwrap().iter().enumerate() {
        let n = c["simulations"].as_u64().unwrap() as usize;
        let prior: Vec<f32> = floats(&c["prior"]).iter().map(|&p| p as f32).collect();
        let m = (c["considered"].as_u64().unwrap() as usize).min(prior.len());
        let q = floats(&c["q"]);
        let g = floats(&c["gumbel"]);
        let value = c["value"].as_f64().unwrap() as f32;
        let table = considered_visits(m, n);
        let mut visits = vec![0u32; prior.len()];
        for &k in &table {
            let completed = completed_q(&prior, &visits, &q, value, &MCTX);
            let a = considered_pick(k, &g, &prior, &completed, &visits).unwrap();
            visits[a] += 1;
        }
        let want: Vec<u32> = floats(&c["visits"]).iter().map(|&v| v as u32).collect();
        assert_eq!(visits, want, "case {i}");
        let most = *visits.iter().max().unwrap();
        let completed = completed_q(&prior, &visits, &q, value, &MCTX);
        let a = considered_pick(most, &g, &prior, &completed, &visits).unwrap();
        let actions: Vec<u64> = c["actions"].as_array().unwrap().iter().map(|x| x.as_u64().unwrap()).collect();
        assert_eq!(actions[a], c["action"].as_u64().unwrap(), "case {i}");
        for (ours, theirs) in improved_policy(&prior, &visits, &q, value, &MCTX).iter().zip(floats(&c["policy"])) {
            assert!((ours - theirs).abs() < 1e-6, "case {i}");
        }
    }
}

const GUMBEL: GumbelConfig = GumbelConfig { considered: 16, scale: 1.0, transform: MCTX };

fn config(simulations: u32, cpuct: f32) -> SearchConfig {
    SearchConfig { simulations, cpuct, fpu: 0.25, endgame_nodes: 0 }
}

fn run(state: &AzulState<Seeded>, config: &SearchConfig, g: &GumbelConfig, seed: u64) -> Search<Seeded> {
    let net = fixture();
    let mut rng = Rng::new(seed);
    let mut search = Search::gumbel(state, config, g, &mut rng).unwrap();
    let mut e = Evaluation::default();
    while let Some((o, l)) = search.wants() {
        net.evaluate(o, l, &mut e);
        search.supply(&e);
    }
    search
}

/// [Z11-88]: in a real search every simulation goes to a root action with
/// the visits the halving table names, so for every count `v` the actions
/// visited more than `v` times are as many as the table's entries equal to
/// `v`; and the move is the best-scoring of the most visited. Over every
/// position of two games, at 64 and 200 simulations, among them positions
/// with fewer legal actions than are considered. And the draw decides which
/// actions are considered: with at least `m` simulations, the actions
/// visited at all are exactly the `m` best by `g + ln p`, since until each
/// has its first visit every unvisited action's completed Q is the same `v_mix`.
///
/// Mutations, seen red ([Z11-48]): the table built for `considered` actions
/// however few are legal; the move left as the most visited, lowest first;
/// the root's pick made without the draw.
#[test]
fn a_search_follows_the_table() {
    let mut few = 0;
    for seed in [6, 7] {
        for (j, state) in support::game_positions(seed).iter().enumerate() {
            for n in [64u32, 200] {
                let search = run(state, &config(n, 1.25), &GUMBEL, j as u64);
                let r = search.root_statistics();
                let g = search.gumbel_draw().unwrap().to_vec();
                let m = 16usize.min(r.actions.len());
                few += usize::from(r.actions.len() < 16);
                let table = considered_visits(m, n as usize);
                for v in 0..=n {
                    let above = r.visits.iter().filter(|&&x| x > v).count();
                    let named = table.iter().filter(|&&x| x == v).count();
                    assert_eq!(above, named, "seed {seed} position {j} n {n} count {v}");
                }
                let mut order: Vec<usize> = (0..r.actions.len()).collect();
                let score = |i: usize| g[i] + f64::from(r.priors[i]).max(f64::MIN_POSITIVE).ln();
                order.sort_by(|&a, &b| score(b).total_cmp(&score(a)).then(a.cmp(&b)));
                let mut top: Vec<usize> = order[..m].to_vec();
                top.sort();
                let visited: Vec<usize> = (0..r.actions.len()).filter(|&i| r.visits[i] > 0).collect();
                assert_eq!(visited, top, "seed {seed} position {j} n {n}: the considered actions are not the draw's");
                let most = *r.visits.iter().max().unwrap();
                let completed = completed_q(&r.priors, &r.visits, &r.q, r.value, &MCTX);
                let a = considered_pick(most, &g, &r.priors, &completed, &r.visits).unwrap();
                let (result, _) = search.finish();
                assert_eq!(result.action, r.actions[a], "seed {seed} position {j} n {n}");
            }
        }
    }
    assert!(few > 0);
}

/// [Z11-88]: below the root a Gumbel search never reads `cpuct` (nor `fpu`):
/// its interior pick is mctx's. And at scale 0 it is deterministic whatever
/// its generator, while at scale 1 the generator changes what it plays.
///
/// Mutations, seen red ([Z11-48]): the interior left to PUCT; the draw taken
/// without its scale.
#[test]
fn the_interior_is_not_puct_and_the_scale_is_the_draws() {
    let positions = support::game_positions(8);
    let mut differ = 0;
    for (j, state) in positions.iter().enumerate().step_by(4) {
        let a = run(state, &config(120, 1.25), &GUMBEL, 1).finish().0;
        let b = run(state, &SearchConfig { fpu: 1.5, ..config(120, 30.0) }, &GUMBEL, 1).finish().0;
        assert_eq!(a, b, "position {j}: cpuct or fpu reached a Gumbel search");
        let zero = GumbelConfig { scale: 0.0, ..GUMBEL };
        assert_eq!(run(state, &config(120, 1.25), &zero, 1).finish().0, run(state, &config(120, 1.25), &zero, 2).finish().0);
        differ += usize::from(a != run(state, &config(120, 1.25), &GUMBEL, 2).finish().0);
    }
    assert!(differ > 0);
}

/// [Z11-78], [Z11-88]: a Gumbel search's halving is planned for its whole
/// budget, so it ignores a stop: `stop` answers `false` and changes
/// nothing, and a `stop` that would fire in `supply_until` is never asked.
/// At a round's last moves, where simulations end at leaves already valued
/// and `supply_until` would ask between them, it ends exactly as the search
/// nobody tried to stop. A PUCT search still stops.
///
/// Mutations, seen red ([Z11-48]): `stop` honoured by a Gumbel search; the
/// firing `stop` asked by one.
#[test]
fn a_gumbel_search_ignores_a_stop() {
    let net = fixture();
    let state = support::game_positions(4).into_iter().find(|s| s.legal_actions().len() <= 3).unwrap();
    let whole = run(&state, &config(50, 1.25), &GUMBEL, 1).finish().0;
    let mut rng = Rng::new(1);
    let mut search = Search::gumbel(&state, &config(50, 1.25), &GUMBEL, &mut rng).unwrap();
    assert!(!search.stop());
    let mut asked = 0;
    let mut e = Evaluation::default();
    while let Some((o, l)) = search.wants() {
        net.evaluate(o, l, &mut e);
        search.supply_until(&e, &mut || {
            asked += 1;
            true
        });
    }
    assert_eq!(asked, 0);
    assert_eq!(search.finish().0, whole);
    let mut puct = Search::new(&state, &config(50, 1.25), None).unwrap();
    assert!(puct.stop());
}

fn parse(extra: &[(&str, &str)]) -> Result<RunConfig, String> {
    let mut f = vec![("selfPlaySimulations", "24"), ("threads", "2"), ("cheapSimulations", "6"), ("fullSearchFraction", "0.5")];
    f.extend_from_slice(extra);
    RunConfig::parse(config_json(&f).as_bytes())
}

/// [Z11-89]: Gumbel self-play writes every full search's improved policy as
/// its target, cheap samples value-only, the same bytes at one thread and at
/// two ([Z11-70]), and plays its own moves: at scale 0 the games do not
/// depend on `tempPlies`, which only PUCT's move sampling reads.
///
/// Mutations, seen red ([Z11-48]): the move taken from the visits instead of
/// the search; the target left as the visits.
#[test]
fn gumbel_self_play_plays_its_own_moves() {
    let net = fixture();
    let c = parse(&[("gumbelConsidered", "8")]).unwrap();
    let s = settings(&c, SearchKind::SelfPlay).unwrap();
    let a = self_play(&net, &s, c.seed, 2, 4);
    let one = self_play(&net, &azul_alphazero::config::Settings { threads: 1, ..s.clone() }, c.seed, 2, 4);
    assert!(a == one, "thread count changed what Gumbel self-play wrote");
    let samples = read_all(&a.samples).unwrap();
    let mut moves = 0;
    for x in &samples {
        let total: u32 = x.visits.iter().map(|&v| u32::from(v)).sum();
        match x.kind {
            Kind::Move => {
                moves += 1;
                assert!(total.abs_diff(65535) <= 180, "a move sample's weights sum to {total}");
            }
            _ => assert_eq!(total, 0),
        }
    }
    assert!(moves > 20);
    let zero = |temp: &str| {
        let c = parse(&[("gumbelConsidered", "8"), ("gumbelScale", "0"), ("tempPlies", temp)]).unwrap();
        self_play(&net, &settings(&c, SearchKind::SelfPlay).unwrap(), c.seed, 2, 3)
    };
    assert!(zero("10") == zero("0"), "tempPlies reached a Gumbel game");
}

/// [Z11-89]: `gumbelScale` goes with `gumbelConsidered`, both in range; a
/// Gumbel search has no lookahead; its transform is the improved keys' or
/// mctx's; and only self-play reads it.
#[test]
fn the_gumbel_settings_are_checked() {
    assert_eq!(parse(&[]).unwrap().gumbel, None);
    let ok = parse(&[("gumbelConsidered", "16")]).unwrap();
    assert_eq!(ok.gumbel, Some(GUMBEL));
    let scaled = parse(&[("gumbelConsidered", "4"), ("gumbelScale", "0.5"), ("improvedCScale", "0.05")]).unwrap();
    assert_eq!(scaled.gumbel, Some(GumbelConfig { considered: 4, scale: 0.5, transform: Transform { c_visit: 50.0, c_scale: 0.05 } }));
    assert_eq!(settings(&ok, SearchKind::SelfPlay).unwrap().gumbel, ok.gumbel);
    for kind in [SearchKind::Play, SearchKind::Milestone, SearchKind::Latency(Some(10))] {
        assert_eq!(settings(&ok, kind).unwrap().gumbel, None);
    }
    for bad in [
        vec![("gumbelScale", "1")],
        vec![("gumbelConsidered", "1")],
        vec![("gumbelConsidered", "65")],
        vec![("gumbelConsidered", "16"), ("gumbelScale", "11")],
        vec![("gumbelConsidered", "16"), ("lookaheadDeals", "4"), ("lookaheadAlpha", "0.5")],
    ] {
        assert!(parse(&bad).is_err(), "{bad:?} was accepted");
    }
}

