//! The lookahead past boundaries into round 5 or later ([Z11-80], [Z11-81]):
//! its file, its deals, its seat, and that it leaves self-play's samples as
//! they were.

mod support;

use azul_alphazero::config::{Lookahead, RunConfig, SearchKind, Settings, settings};
use azul_alphazero::lookahead::{draw_deals, lookahead_value, looked_past};
use azul_alphazero::network::{Evaluation, Evaluator};
use azul_alphazero::rng::{Rng, cap_seed, game_seed, look_seed, noise_seed};
use azul_alphazero::samples::{Kind, look_path, read_all, read_all_look};
use azul_alphazero::search::{SearchConfig, search};
use azul_alphazero::selfplay::{play_game_looked, self_play};
use azul_alphazero::view::is_boundary;
use azul_engine::{Action, AzulState, ENCODED_SIZE, OFF_ROUND, OFF_SCORES, Seeded};
use support::{config_json, fixture, fixture_paths, run, scratch};

fn config(extra: &[(&str, &str)]) -> RunConfig {
    RunConfig::parse(config_json(extra).as_bytes()).unwrap()
}

fn self_play_settings(extra: &[(&str, &str)]) -> (RunConfig, Settings) {
    let c = config(extra);
    let s = settings(&c, SearchKind::SelfPlay).unwrap();
    (c, s)
}

/// The round a sample's observation says it is in, as an index.
fn round_of(observation: &[f32; ENCODED_SIZE]) -> u32 {
    (observation[OFF_ROUND] * 10.0).round() as u32
}

/// [Z11-80] with [Z11-70]: the lookahead's searches are lanes of the batched
/// loop now, so that loop's byte-identity case needs them present. The sample
/// and aux files are byte for byte what the same config without the lookahead
/// writes, at one thread and at eight; the lookahead file is the same at both;
/// and every file is that of the same games played one at a time, unbatched.
///
/// Mutation, seen red ([Z11-48]): the lookahead's deals drawn from the game's
/// own generator (`&mut self.rng` for `&mut self.look_rng` in `Game::play`).
#[test]
fn the_lookahead_changes_no_sample_at_any_thread_count() {
    let net = fixture();
    let base = [("selfPlaySimulations", "16"), ("tempPlies", "4")];
    let mut on = base.to_vec();
    on.extend([("lookaheadDeals", "3"), ("lookaheadAlpha", "0.9")]);
    let games = 9;
    let written = |fields: &[(&str, &str)], threads: &str| {
        let mut f = fields.to_vec();
        f.push(("threads", threads));
        let (c, s) = self_play_settings(&f);
        self_play(&net, &s, c.seed, 5, games)
    };
    let off = written(&base, "1");
    let on1 = written(&on, "1");
    let on8 = written(&on, "8");
    assert_eq!(off.look, None);
    assert!(on1.samples == off.samples, "the lookahead changed the sample file at one thread");
    assert!(on1.aux == off.aux, "the lookahead changed the aux file at one thread");
    assert!(on8.samples == off.samples, "the lookahead changed the sample file at eight threads");
    assert!(on8.aux == off.aux, "the lookahead changed the aux file at eight threads");
    let look = on1.look.clone().expect("a lookahead file");
    assert!(on8.look.as_ref() == Some(&look), "the lookahead file depends on the thread count");

    // The same games one at a time, unbatched.
    let (c, s) = self_play_settings(&on);
    let mut alone = Vec::new();
    for i in 0..games as u64 {
        let (_, l) = play_game_looked(&net, &s, c.seed, 5, i);
        for v in l {
            alone.extend_from_slice(&v.to_le_bytes());
        }
    }
    assert!(alone == look, "batched lookaheads wrote different values from games played alone");
    let values = read_all_look(&look).unwrap();
    assert_eq!(values.len(), read_all(&on1.samples).unwrap().len());
    assert!(values.iter().any(|v| v.is_finite()), "no boundary was looked past");
}

/// One game replayed by hand, as [Z11-69]'s and [Z11-75]'s cases do — the
/// temperature off, so the move is the most visited — with each boundary into
/// round 5 or later looked past by an independent reference: its deals drawn
/// by `draw_deals` from the lookahead's own generator, each searched by plain
/// `search` from the seat that opens the round, the root values averaged in
/// `f64`. Per sample, that value or NaN.
fn reference_look(s: &Settings, seed: u64, generation: u64, index: u64, deals: u32) -> Vec<f32> {
    let net = fixture();
    let mut state = AzulState::new_game(Seeded::new(game_seed(seed, generation, index)));
    let mut noise_rng = Rng::new(noise_seed(seed, generation, index));
    let mut look_rng = Rng::new(look_seed(seed, generation, index));
    let mut out = Vec::new();
    while !state.is_terminal() {
        let noise = s.noise.as_ref().map(|n| (n, &mut noise_rng));
        let (r, _) = search(&net, &state, &s.search, noise).unwrap();
        out.push(f32::NAN);
        let mut best = 0;
        for a in 0..180 {
            if r.visits[a] > r.visits[best] {
                best = a;
            }
        }
        let before = state.clone();
        state.apply(best as Action).unwrap();
        if is_boundary(&before, &state) && !state.is_terminal() {
            let mut v = f32::NAN;
            if state.round_index() >= 4 {
                let opener = state.current_player();
                let mut sum = 0f64;
                for dealt in draw_deals(&before, best as Action, deals, &mut look_rng).unwrap() {
                    assert_eq!(dealt.current_player(), opener, "a deal changed who opens the round");
                    sum += f64::from(search(&net, &dealt, &s.search, None).unwrap().0.value);
                }
                v = (sum / f64::from(deals)) as f32;
            }
            out.push(v);
        }
    }
    out
}

/// [Z11-80]'s alignment: exactly the boundary samples into round 5 or later
/// have a finite value, every other sample NaN; and each value is the
/// reference's — `selfPlaySimulations`, no noise, from the opener's seat,
/// the deals in the order drawn — bit for bit.
#[test]
fn the_lookahead_file_labels_exactly_the_late_boundaries() {
    let deals = 3;
    let (c, s) = self_play_settings(&[
        ("selfPlaySimulations", "16"),
        ("tempPlies", "0"),
        ("lookaheadDeals", "3"),
        ("lookaheadAlpha", "0.9"),
    ]);
    let mut labelled = 0;
    for index in 0..3 {
        let (records, look) = play_game_looked(&fixture(), &s, c.seed, 2, index);
        assert_eq!(look.len(), records.len(), "game {index}: a value per sample");
        for (k, ((sample, _), v)) in records.iter().zip(&look).enumerate() {
            let late = sample.kind == Kind::Boundary && round_of(&sample.observation) >= 4;
            assert_eq!(v.is_finite(), late, "game {index} sample {k}: kind {:?}, round {}", sample.kind, round_of(&sample.observation));
            labelled += usize::from(late);
        }
        let want = reference_look(&s, c.seed, 2, index, deals);
        let bits = |v: &[f32]| v.iter().map(|x| x.to_bits()).collect::<Vec<_>>();
        assert_eq!(bits(&look), bits(&want), "game {index}: not the reference's lookahead");
    }
    assert!(labelled >= 3, "{labelled} boundaries looked past in three games");
}

/// Boundary plies into round 5 or later from games of random moves: the
/// position before, the move, and whether the deal recycled the lid.
fn late_boundaries() -> Vec<(AzulState<Seeded>, Action, bool)> {
    let mut out = Vec::new();
    for seed in 1..=12u64 {
        let mut s = AzulState::seeded(seed);
        let mut rng = Rng::new(seed ^ 0x5eed);
        while !s.is_terminal() {
            let legal = s.legal_actions();
            let a = legal.as_slice()[rng.below(legal.len() as u64) as usize];
            let before = s.clone();
            s.apply(a).unwrap();
            if is_boundary(&before, &s) && looked_past(&s) {
                out.push((before.clone(), a, s.shuffles_used() != before.shuffles_used()));
            }
        }
    }
    out
}

/// [Z11-80]'s analogue of [Z11-21]: the deals, and the lookahead value on
/// them, are identical for two positions that differ only in their bag's
/// order and their shuffler's seed — over boundaries into round 5 and later
/// from recorded games, deals that recycle the lid among them, with a
/// non-zero network. The one test that sees a lookahead dealing even one of
/// its deals from the real bag, which every other test would pass.
///
/// Mutation, seen red ([Z11-48]): in `draw_deals`, the first deal dealt from
/// `before`'s bag as it lies instead of the shuffled public counts.
#[test]
fn the_lookahead_never_reads_the_bags_order() {
    let net = fixture();
    let config = SearchConfig { simulations: 24, cpuct: 1.25, fpu: 0.25, endgame_nodes: 0 };
    let cases = late_boundaries();
    assert!(cases.len() >= 12, "{} late boundaries", cases.len());
    assert!(cases.iter().any(|c| c.2), "no deal recycled the lid");
    let mut moved = 0;
    for (n, (before, action, _)) in cases.iter().enumerate() {
        let mut c = before.to_canonical();
        c.bag.reverse();
        let third = c.bag.len() / 3;
        c.bag.rotate_left(third);
        moved += usize::from(c.bag != before.to_canonical().bag);
        let other = AzulState::from_canonical(&c, Seeded::new(0xdead_beef ^ n as u64)).unwrap();
        let seed = look_seed(7, 3, n as u64);
        let a = draw_deals(before, *action, 8, &mut Rng::new(seed)).unwrap();
        let b = draw_deals(&other, *action, 8, &mut Rng::new(seed)).unwrap();
        assert!(a == b, "case {n}: the deals moved with the bag's order or the shuffler");
        let va = lookahead_value(&net, before, *action, 8, &config, &mut Rng::new(seed));
        let vb = lookahead_value(&net, &other, *action, 8, &config, &mut Rng::new(seed));
        assert_eq!(va.to_bits(), vb.to_bits(), "case {n}: the value moved with the bag's order");
        assert!(va.is_finite());
    }
    assert!(moved * 2 >= cases.len(), "only {moved} bags were reordered");
}

/// Values a position by the score difference its observation holds, from the
/// seat it was given: right about whoever leads, whatever the network.
struct Scores;

impl Evaluator for Scores {
    fn evaluate(&self, o: &[f32; ENCODED_SIZE], legal: &[Action], out: &mut Evaluation) {
        out.policy = [0.0; 180];
        for &a in legal {
            out.policy[usize::from(a)] = 1.0 / legal.len() as f32;
        }
        out.value = (5.0 * (o[OFF_SCORES] - o[OFF_SCORES + 1])).tanh();
    }
}

/// [Z11-80]'s seat: on a boundary into round 5 where one seat leads by 60
/// points, the lookahead value is near +1 when the seat that opens the round
/// leads and near −1 when it trails — the seat the boundary sample's result
/// is from ([Z11-26]).
///
/// Mutation, seen red ([Z11-48]): a deal's root value negated where
/// `Boundary::advance` records it.
#[test]
fn the_lookahead_values_from_the_openers_seat() {
    let config = SearchConfig { simulations: 64, cpuct: 1.25, fpu: 0.25, endgame_nodes: 0 };
    let mut seen = 0;
    for (n, (before, action, _)) in late_boundaries().into_iter().take(6).enumerate() {
        let mut after = before.clone();
        after.apply(action).unwrap();
        let opener = after.current_player().index();
        for leads in [true, false] {
            let mut c = before.to_canonical();
            c.scores = [0, 0];
            c.scores[if leads { opener } else { 1 - opener }] = 60;
            let posed = AzulState::from_canonical(&c, Seeded::new(1)).unwrap();
            let v = lookahead_value(&Scores, &posed, action, 4, &config, &mut Rng::new(n as u64));
            if leads {
                assert!(v > 0.8, "case {n}: the opener leads by 60 and the lookahead says {v}");
            } else {
                assert!(v < -0.8, "case {n}: the opener trails by 60 and the lookahead says {v}");
            }
            seen += 1;
        }
    }
    assert_eq!(seen, 12);
}

/// [Z11-80]'s determinism: the same seed writes the same lookahead file
/// twice; the lookahead's seed is its own for every game of the triple, apart
/// from the shuffler's, the noise's and the cap's; and a different generation
/// or game index draws different deals of the same boundary.
///
/// Mutation, seen red ([Z11-48]): `look_seed` leaving out the generation
/// and the index (`splitmix64(seed ^ LOOK_SALT)`).
#[test]
fn the_lookahead_is_seeded_from_the_games_triple() {
    let (c, s) = self_play_settings(&[
        ("selfPlaySimulations", "8"),
        ("threads", "2"),
        ("lookaheadDeals", "2"),
        ("lookaheadAlpha", "0.9"),
    ]);
    let net = fixture();
    let a = self_play(&net, &s, c.seed, 1, 4);
    let b = self_play(&net, &s, c.seed, 1, 4);
    assert!(a == b, "the same seed wrote different files");

    let mut seeds = Vec::new();
    for g in 0..3 {
        for i in 0..3 {
            seeds.extend([look_seed(c.seed, g, i), game_seed(c.seed, g, i), noise_seed(c.seed, g, i), cap_seed(c.seed, g, i)]);
        }
    }
    let mut sorted = seeds.clone();
    sorted.sort_unstable();
    sorted.dedup();
    assert_eq!(sorted.len(), seeds.len(), "two of a triple's seeds coincide");

    let (before, action, _) = late_boundaries().swap_remove(0);
    let deal = |g: u64, i: u64| draw_deals(&before, action, 2, &mut Rng::new(look_seed(c.seed, g, i))).unwrap();
    let base = deal(1, 1);
    assert!(deal(2, 1) != base, "another generation drew the same deals");
    assert!(deal(1, 2) != base, "another game drew the same deals");
}

/// [Z11-81]: the two keys go together, inside their ranges; only self-play
/// reads the deals.
#[test]
fn the_lookahead_settings_are_checked() {
    let parse = |extra: &[(&str, &str)]| RunConfig::parse(config_json(extra).as_bytes());
    assert_eq!(parse(&[]).unwrap().lookahead, None);
    let ok = parse(&[("lookaheadDeals", "8"), ("lookaheadAlpha", "0.9")]).unwrap();
    assert_eq!(ok.lookahead, Some(Lookahead { deals: 8, alpha: 0.9 }));
    assert_eq!(settings(&ok, SearchKind::SelfPlay).unwrap().lookahead_deals, Some(8));
    assert_eq!(settings(&ok, SearchKind::Milestone).unwrap().lookahead_deals, None);
    assert_eq!(settings(&ok, SearchKind::Play).unwrap().lookahead_deals, None);
    assert_eq!(settings(&ok, SearchKind::Latency(Some(10))).unwrap().lookahead_deals, None);
    for bad in [
        vec![("lookaheadDeals", "8")],
        vec![("lookaheadAlpha", "0.9")],
        vec![("lookaheadDeals", "0"), ("lookaheadAlpha", "0.9")],
        vec![("lookaheadDeals", "65"), ("lookaheadAlpha", "0.9")],
        vec![("lookaheadDeals", "8"), ("lookaheadAlpha", "0")],
        vec![("lookaheadDeals", "8"), ("lookaheadAlpha", "1.5")],
    ] {
        assert!(parse(&bad).is_err(), "{bad:?} was accepted");
    }
    assert!(parse(&[("lookaheadDeals", "1"), ("lookaheadAlpha", "1")]).is_ok());
}

/// [Z11-80] through the binary: `selfplay` writes `<g>.look.bin` beside the
/// sample file, a value per sample, only while the keys are set.
#[test]
fn selfplay_writes_the_lookahead_file_only_with_the_keys() {
    let dir = scratch();
    let (checkpoint, _) = fixture_paths();
    let mut seen = Vec::new();
    for (name, extra) in [("off", vec![]), ("on", vec![("lookaheadDeals", "2"), ("lookaheadAlpha", "0.9")])] {
        let cfg = dir.path().join(format!("{name}.json"));
        let mut f = vec![("selfPlaySimulations", "8"), ("threads", "2")];
        f.extend(extra);
        std::fs::write(&cfg, config_json(&f)).unwrap();
        let out = dir.path().join(name).join("6.bin");
        std::fs::create_dir_all(out.parent().unwrap()).unwrap();
        let o = run(
            &["selfplay", checkpoint.to_str().unwrap(), "--config", cfg.to_str().unwrap(), "--generation", "6", "--games", "3", "--out", out.to_str().unwrap()],
            &[],
        );
        assert!(o.status.success(), "{}", String::from_utf8_lossy(&o.stderr));
        assert_eq!(look_path(&out).file_name().unwrap(), "6.look.bin");
        seen.push((std::fs::read(&out).unwrap(), look_path(&out).exists()));
        if name == "on" {
            let n = read_all(&std::fs::read(&out).unwrap()).unwrap().len();
            assert_eq!(read_all_look(&std::fs::read(look_path(&out)).unwrap()).unwrap().len(), n);
        }
    }
    assert!(!seen[0].1 && seen[1].1, "the lookahead file's presence: {:?}", [seen[0].1, seen[1].1]);
    assert!(seen[0].0 == seen[1].0, "the binary's sample file changed with the lookahead");
}
