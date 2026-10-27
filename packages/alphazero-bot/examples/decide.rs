//! The deciding experiment for the past-deal lookahead (PLAN.md, stage 3):
//! does re-valuing boundary leaves into round 5 beat searching longer, at
//! equal time, on round-4 moves? An experiment's tool, not a lane.
//!
//! usage:
//!   decide positions <checkpoint> <games> <first-seed> <threads> <out.jsonl>
//!   decide run <checkpoint> <positions.jsonl> <fit.json> <threads> <out.jsonl> [arms]
//!   decide score <checkpoint> <positions.jsonl> <runs.jsonl> <replays> <sims> <threads> <out.jsonl> [arms]
//!   decide report <positions.jsonl> <runs.jsonl> <scores.jsonl> [arms]
//!   decide match <checkpoint> <fit.json> <pairs> <first-seed> <threads> <out.jsonl>
//!   decide match-report <out.jsonl>
//!
//! `run`, `score` and `match` append, and skip what their output already
//! holds, so a stopped run resumes.


#![allow(clippy::needless_range_loop)]
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::io::{BufRead, Write};
use std::sync::Mutex;
use std::time::Instant;

use azul_alphazero::memo::{Memo, choose_memoised};
use azul_alphazero::network::{Evaluation, Evaluator, Network};
use azul_alphazero::pastdeal::{Blend, Deep, Mode, PastDeal, Recal, applies, choose_past_deal};
use azul_alphazero::rng::{Rng, splitmix64};
use azul_alphazero::search::{Search, SearchConfig, SelfPlayNoise};
use azul_alphazero::wire::{read_canonical, write_canonical};
use azul_engine::{AzulState, Outcome, Player, Seeded};
use serde_json::{Value, json};

const CPUCT: f32 = 1.25;
const FPU: f32 = 0.25;
const SHIPPED: u32 = 10_000;
const ENDGAME: u32 = 300_000;
/// The controls: the shipped search at these simulations.
const GRID: [u32; 7] = [14_000, 20_000, 40_000, 80_000, 160_000, 320_000, 640_000];

fn config(simulations: u32, endgame_nodes: u32) -> SearchConfig {
    SearchConfig { simulations, cpuct: CPUCT, fpu: FPU, endgame_nodes }
}

fn load(path: &str) -> Network {
    Network::load(&std::fs::read(path).unwrap(), &std::fs::read(path.replace(".bin", ".parity")).unwrap()).unwrap()
}

fn lines(path: &str) -> Vec<Value> {
    match std::fs::File::open(path) {
        Ok(f) => std::io::BufReader::new(f).lines().map_while(Result::ok).filter(|l| !l.is_empty()).map(|l| serde_json::from_str(&l).unwrap()).collect(),
        Err(_) => Vec::new(),
    }
}

fn appender(path: &str) -> Mutex<std::fs::File> {
    Mutex::new(std::fs::OpenOptions::new().create(true).append(true).open(path).unwrap())
}

fn emit(out: &Mutex<std::fs::File>, v: &Value) {
    let mut f = out.lock().unwrap();
    writeln!(f, "{v}").unwrap();
    f.flush().unwrap();
}

/// Runs `job(i)` for `0..n` on `threads` threads.
fn par(n: usize, threads: usize, job: &(dyn Fn(usize) + Sync)) {
    let next = Mutex::new(0usize);
    std::thread::scope(|s| {
        for _ in 0..threads {
            s.spawn(|| {
                loop {
                    let i = {
                        let mut g = next.lock().unwrap();
                        let i = *g;
                        *g += 1;
                        i
                    };
                    if i >= n {
                        break;
                    }
                    job(i);
                }
            });
        }
    });
}

fn state_of(p: &Value) -> AzulState<Seeded> {
    let words: Vec<u32> = p["words"].as_array().unwrap().iter().map(|w| w.as_u64().unwrap() as u32).collect();
    AzulState::from_canonical(&read_canonical(&words).unwrap(), Seeded::new(p["seed"].as_u64().unwrap())).unwrap()
}

fn phase(tiles: u64) -> &'static str {
    match tiles {
        0..=7 => "0-7",
        8..=15 => "8-15",
        _ => "16-20",
    }
}

// ---- positions ----

/// Self-play by the checkpoint, as its run played (1 000 simulations, the
/// root's noise, the first ten plies sampled by visits), to the end of round
/// 4; from each game one round-4 position with at most 15 tiles left, and one
/// in four games one with 16 or more.
fn positions(a: &[String]) {
    let net = load(&a[2]);
    let games: usize = a[3].parse().unwrap();
    let first: u64 = a[4].parse().unwrap();
    let threads: usize = a[5].parse().unwrap();
    let out = appender(&a[6]);
    let noise = SelfPlayNoise { alpha: 0.3, epsilon: 0.25 };
    par(games, threads, &|g| {
        let seed = first + g as u64;
        let mut rng = Rng::new(splitmix64(seed ^ 0x5eed));
        let mut s = AzulState::<Seeded>::seeded(seed);
        let mut memo = Memo::new();
        let mut round4 = Vec::new();
        let mut ply = 0u32;
        while !s.is_terminal() && s.round_index() <= 3 {
            if s.round_index() == 3 {
                round4.push((ply, s.clone()));
            }
            let mut search = Search::new(&s, &config(1000, 0), Some((&noise, &mut rng))).unwrap();
            let mut e = Evaluation::default();
            while let Some(request) = search.wants() {
                match memo.lookup(request) {
                    Ok(hit) => search.supply(&hit),
                    Err(k) => {
                        net.evaluate(request.0, request.1, &mut e);
                        memo.insert(k, &e);
                        search.supply(&e);
                    }
                }
            }
            let r = search.finish().0;
            let action = if ply < 10 {
                let total: u64 = r.visits.iter().map(|&v| u64::from(v)).sum();
                let mut x = rng.below(total.max(1));
                let mut pick = r.action;
                for (a, &v) in r.visits.iter().enumerate() {
                    if x < u64::from(v) {
                        pick = a as azul_engine::Action;
                        break;
                    }
                    x -= u64::from(v);
                }
                pick
            } else {
                r.action
            };
            s.apply(action).unwrap();
            ply += 1;
        }
        let late: Vec<_> = round4.iter().filter(|(_, s)| s.tiles_left() <= 15).collect();
        let early: Vec<_> = round4.iter().filter(|(_, s)| s.tiles_left() >= 16).collect();
        let mut chosen = Vec::new();
        if !late.is_empty() {
            chosen.push(late[rng.below(late.len() as u64) as usize]);
        }
        if !early.is_empty() && rng.below(4) == 0 {
            chosen.push(early[rng.below(early.len() as u64) as usize]);
        }
        for (ply, p) in chosen {
            emit(&out, &json!({
                "game": seed, "ply": ply, "tiles": p.tiles_left(), "seed": splitmix64(seed ^ u64::from(*ply)),
                "words": write_canonical(&p.to_canonical()),
            }));
        }
    });
}

// ---- run ----

fn blend(v: &Value) -> Blend {
    Blend {
        intercept: v["intercept"].as_f64().unwrap(),
        head: v["head"].as_f64().unwrap(),
        dealt: v["dealt"].as_f64().unwrap(),
        rollout: v["rollout"].as_f64().unwrap(),
        sigma: v["sigma"].as_f64().unwrap(),
        deep: v["deep"].as_f64().unwrap(),
    }
}

/// Every arm by name: its simulations and its lookahead.
fn arms(fit: &Value) -> Vec<(String, u32, PastDeal)> {
    let recal = Recal { a: fit["recal"]["a"].as_f64().unwrap(), b: fit["recal"]["b"].as_f64().unwrap() };
    let deals = fit["deals"].as_u64().unwrap() as u32;
    let shallow = blend(&fit["shallow"]);
    let plain = PastDeal {
        mode: Mode::RecalOnly,
        deals,
        leaves: 0,
        budget: 0,
        rollouts: true,
        blend: shallow,
        deep: None,
        recal: Recal::IDENTITY,
    };
    let look = PastDeal { mode: Mode::TwoPass, leaves: 32, budget: 4_000, recal, ..plain.clone() };
    let deep = Deep { leaves: 4, deals: 4, simulations: fit["deepSimulations"].as_u64().unwrap() as u32, blend: blend(&fit["deep"]) };
    let mut out = vec![
        ("shipped".to_string(), SHIPPED, plain.clone()),
        ("recal".to_string(), SHIPPED, PastDeal { recal, ..plain.clone() }),
        ("look01".to_string(), SHIPPED, look.clone()),
        ("look012".to_string(), SHIPPED, PastDeal { deep: Some(deep), budget: 6_000, ..look }),
    ];
    for n in GRID {
        out.push((format!("ctl{n}"), n, plain.clone()));
    }
    out
}

fn run(a: &[String]) {
    let net = load(&a[2]);
    let positions = lines(&a[3]);
    let fit: Value = serde_json::from_str(&std::fs::read_to_string(&a[4]).unwrap()).unwrap();
    let threads: usize = a[5].parse().unwrap();
    let only: Option<HashSet<String>> = a.get(7).map(|s| s.split(',').map(String::from).collect());
    let done: HashSet<(u64, String)> =
        lines(&a[6]).iter().map(|r| (r["pos"].as_u64().unwrap(), r["arm"].as_str().unwrap().to_string())).collect();
    let out = appender(&a[6]);
    let arms: Vec<_> = arms(&fit).into_iter().filter(|(n, ..)| only.as_ref().is_none_or(|o| o.contains(n))).collect();
    par(positions.len(), threads, &|i| {
        let root = state_of(&positions[i]);
        // Every arm of a position in turn, on one thread, so they meet the
        // same machine.
        for (name, sims, pd) in &arms {
            if done.contains(&(i as u64, name.clone())) {
                continue;
            }
            let t = Instant::now();
            let p = choose_past_deal(&net, &root, &config(*sims, 0), pd, &mut Memo::new(), &mut || false).unwrap();
            let ms = t.elapsed().as_secs_f64() * 1e3;
            let st = p.first_stats;
            let made = u64::from(st.expanded.saturating_sub(1) + st.boundaries + st.terminals);
            let rehit = 1.0 - made as f64 / f64::from(p.first_simulations.max(1));
            emit(&out, &json!({
                "pos": i, "arm": name, "action": p.result.action, "first": p.first.action, "ms": ms,
                "calls": p.calls_first + p.calls_refine + p.calls_second, "callsRefine": p.calls_refine,
                "rehit": rehit, "refined": p.refined, "deepened": p.deepened, "value": p.result.value,
            }));
        }
    });
}

// ---- score ----

/// The result for `seat` of the game from `root` after `action`, the bag
/// laid out by replay `j`'s seed, both seats played by `choose` at `sims`
/// with the endgame proof.
fn replay(net: &Network, root: &AzulState<Seeded>, pos_seed: u64, j: u32, action: u8, sims: u32) -> f32 {
    let seat = root.current_player();
    let mut c = root.to_canonical();
    let mut rng = Rng::new(splitmix64(pos_seed ^ (u64::from(j) << 32) ^ 0x7e9a));
    c.bag.sort_unstable();
    for i in (1..c.bag.len()).rev() {
        let k = rng.below(i as u64 + 1) as usize;
        c.bag.swap(i, k);
    }
    let mut s = AzulState::from_canonical(&c, Seeded::new(rng.next_u64())).unwrap();
    s.apply(action).unwrap();
    let mut memo = Memo::new();
    while !s.is_terminal() {
        let r = choose_memoised(net, &s, &config(sims, ENDGAME), &mut memo).unwrap();
        s.apply(r.action).unwrap();
    }
    match (s.outcome(), seat) {
        (Some(Outcome::Player0), Player::P0) | (Some(Outcome::Player1), Player::P1) => 1.0,
        (Some(Outcome::Draw), _) | (None, _) => 0.5,
        _ => 0.0,
    }
}

fn score(a: &[String]) {
    let net = load(&a[2]);
    let positions = lines(&a[3]);
    let runs = lines(&a[4]);
    let replays: u32 = a[5].parse().unwrap();
    let sims: u32 = a[6].parse().unwrap();
    let threads: usize = a[7].parse().unwrap();
    let only: Option<HashSet<String>> = a.get(9).map(|s| s.split(',').map(String::from).collect());
    let done: HashSet<(u64, u64)> =
        lines(&a[8]).iter().map(|r| (r["pos"].as_u64().unwrap(), r["action"].as_u64().unwrap())).collect();
    // Per position, the distinct moves of the arms named.
    let mut moves: BTreeMap<u64, BTreeSet<u64>> = BTreeMap::new();
    for r in &runs {
        if only.as_ref().is_none_or(|o| o.contains(r["arm"].as_str().unwrap())) {
            moves.entry(r["pos"].as_u64().unwrap()).or_default().insert(r["action"].as_u64().unwrap());
        }
    }
    let jobs: Vec<(u64, u64)> = moves
        .iter()
        .filter(|(_, m)| m.len() > 1)
        .flat_map(|(&p, m)| m.iter().map(move |&a| (p, a)))
        .filter(|j| !done.contains(j))
        .collect();
    eprintln!("{} moves to score", jobs.len());
    let out = appender(&a[8]);
    par(jobs.len(), threads, &|i| {
        let (p, action) = jobs[i];
        let pos = &positions[p as usize];
        let root = state_of(pos);
        let seed = pos["seed"].as_u64().unwrap();
        let t = Instant::now();
        let results: Vec<f32> = (0..replays).map(|j| replay(&net, &root, seed, j, action as u8, sims)).collect();
        emit(&out, &json!({ "pos": p, "action": action, "results": results, "s": t.elapsed().as_secs_f64() }));
    });
}

// ---- report ----

fn median(mut xs: Vec<f64>) -> f64 {
    xs.sort_by(f64::total_cmp);
    if xs.is_empty() { f64::NAN } else { xs[xs.len() / 2] }
}

fn quantile(xs: &mut [f64], q: f64) -> f64 {
    xs.sort_by(f64::total_cmp);
    xs[((xs.len() - 1) as f64 * q).round() as usize]
}

fn report(a: &[String]) {
    let positions = lines(&a[2]);
    let runs = lines(&a[3]);
    let scores = lines(&a[4]);
    let shown: Vec<String> = a.get(5).map_or(vec!["recal".into(), "look01".into(), "look012".into()], |s| s.split(',').map(String::from).collect());
    let mut by: HashMap<(u64, String), &Value> = HashMap::new();
    for r in &runs {
        by.insert((r["pos"].as_u64().unwrap(), r["arm"].as_str().unwrap().to_string()), r);
    }
    let mut score: HashMap<(u64, u64), f64> = HashMap::new();
    for s in &scores {
        let r: Vec<f64> = s["results"].as_array().unwrap().iter().map(|x| x.as_f64().unwrap()).collect();
        score.insert((s["pos"].as_u64().unwrap(), s["action"].as_u64().unwrap()), r.iter().sum::<f64>() / r.len() as f64);
    }
    let phases = ["0-7", "8-15", "16-20"];
    let arm_names: BTreeSet<String> = runs.iter().map(|r| r["arm"].as_str().unwrap().to_string()).collect();
    println!("{:<10} {:>6} {:>9} {:>9} {:>9} {:>8} {:>8}", "arm", "phase", "n", "p50 ms", "p95 ms", "calls", "differ");
    for arm in &arm_names {
        for ph in phases {
            let rows: Vec<(u64, &&Value)> = by
                .iter()
                .filter(|((p, n), _)| n == arm && phase(positions[*p as usize]["tiles"].as_u64().unwrap()) == ph)
                .map(|((p, _), r)| (*p, r))
                .collect();
            if rows.is_empty() {
                continue;
            }
            let mut ms: Vec<f64> = rows.iter().map(|(_, r)| r["ms"].as_f64().unwrap()).collect();
            let calls = rows.iter().map(|(_, r)| r["calls"].as_f64().unwrap()).sum::<f64>() / rows.len() as f64;
            let differ = rows
                .iter()
                .filter(|(p, r)| by.get(&(*p, "shipped".into())).is_some_and(|s| s["action"] != r["action"]))
                .count();
            println!(
                "{arm:<10} {ph:>6} {:>9} {:>9.0} {:>9.0} {calls:>8.0} {:>7.1}%",
                rows.len(),
                quantile(&mut ms, 0.5),
                quantile(&mut ms, 0.95),
                100.0 * differ as f64 / rows.len() as f64
            );
        }
    }
    // The time-matched controls: per phase, the grid arm whose median time is
    // nearest (in ratio) to the lookahead's, and to twice it.
    println!();
    for arm in &shown {
        if !arm.starts_with("look") {
            continue;
        }
        for ph in phases {
            let in_phase = |p: u64| phase(positions[p as usize]["tiles"].as_u64().unwrap()) == ph;
            let med = |name: &str| median(by.iter().filter(|((p, n), _)| n == name && in_phase(*p)).map(|(_, r)| r["ms"].as_f64().unwrap()).collect());
            let target = med(arm);
            if target.is_nan() {
                continue;
            }
            for mult in [1.0, 2.0] {
                let ctl = GRID
                    .iter()
                    .map(|n| format!("ctl{n}"))
                    .filter(|n| arm_names.contains(n))
                    .min_by(|x, y| (med(x) / (mult * target)).ln().abs().total_cmp(&(med(y) / (mult * target)).ln().abs()));
                let Some(ctl) = ctl else { continue };
                paired(&format!("{arm} vs {ctl} ({mult}x: {:.0} vs {:.0} ms)", target, med(&ctl)), arm, &ctl, ph, &by, &score, &positions);
            }
        }
    }
    println!();
    for arm in &shown {
        for ph in phases {
            paired(&format!("{arm} vs shipped"), arm, "shipped", ph, &by, &score, &positions);
        }
    }
    for ph in phases {
        paired("look01 vs recal", "look01", "recal", ph, &by, &score, &positions);
    }
}

/// Per position of the phase, `E[score | arm's move] − E[score | other's]`
/// (0 where they agree), its mean and a 95% bootstrap interval over positions.
fn paired(
    label: &str,
    arm: &str,
    other: &str,
    ph: &str,
    by: &HashMap<(u64, String), &Value>,
    score: &HashMap<(u64, u64), f64>,
    positions: &[Value],
) {
    let mut diffs = Vec::new();
    let mut missing = 0;
    for p in 0..positions.len() as u64 {
        if phase(positions[p as usize]["tiles"].as_u64().unwrap()) != ph {
            continue;
        }
        let (Some(x), Some(y)) = (by.get(&(p, arm.to_string())), by.get(&(p, other.to_string()))) else { continue };
        let (ax, ay) = (x["action"].as_u64().unwrap(), y["action"].as_u64().unwrap());
        if ax == ay {
            diffs.push(0.0);
            continue;
        }
        match (score.get(&(p, ax)), score.get(&(p, ay))) {
            (Some(sx), Some(sy)) => diffs.push(sx - sy),
            _ => missing += 1,
        }
    }
    if diffs.is_empty() {
        return;
    }
    let n = diffs.len();
    let mean = diffs.iter().sum::<f64>() / n as f64;
    let mut rng = Rng::new(7);
    let mut boots: Vec<f64> = (0..2000).map(|_| (0..n).map(|_| diffs[rng.below(n as u64) as usize]).sum::<f64>() / n as f64).collect();
    let differ = diffs.iter().filter(|&&d| d != 0.0).count();
    println!(
        "{label:<52} {ph:>6}  n {n:>4}  differ {differ:>4}  {mean:+.4} ({:+.4} to {:+.4}){}",
        quantile(&mut boots, 0.025),
        quantile(&mut boots, 0.975),
        if missing > 0 { format!("  [{missing} unscored]") } else { String::new() }
    );
}

// ---- match ----

/// The lookahead's gate, derived from stage 3: round 4 with at least 4 tiles
/// left (and a bag that deals round 5 whole, where the lookahead applies).
/// The control's extra time follows the same gate.
fn gated(s: &AzulState<Seeded>) -> bool {
    applies(s) && s.tiles_left() >= 4
}

/// The control's simulations under the gate: the grid arm whose median time
/// matched look01's in stage 3, by phase.
fn matched(tiles: u8) -> u32 {
    match tiles {
        0..=7 => 320_000,
        8..=15 => 640_000,
        _ => 80_000,
    }
}

/// One player of a match game: the lookahead or the time-matched control,
/// both the shipped search outside the gate.
struct Side {
    look: bool,
    memo: Memo,
    /// Tiles left and milliseconds, for every move under the gate.
    ms: Vec<(u8, f64)>,
}

impl Side {
    fn play(&mut self, net: &Network, s: &AzulState<Seeded>, look01: &PastDeal) -> azul_engine::Action {
        if !gated(s) {
            return choose_memoised(net, s, &config(SHIPPED, ENDGAME), &mut self.memo).unwrap().action;
        }
        let t = Instant::now();
        let action = if self.look {
            choose_past_deal(net, s, &config(SHIPPED, ENDGAME), look01, &mut self.memo, &mut || false).unwrap().result.action
        } else {
            choose_memoised(net, s, &config(matched(s.tiles_left()), ENDGAME), &mut self.memo).unwrap().action
        };
        self.ms.push((s.tiles_left(), t.elapsed().as_secs_f64() * 1e3));
        action
    }
}

/// Pairs of games from one seed each: both seats play the shipped search to
/// the start of round 4 (the same moves, so played once), and then the
/// lookahead takes each seat in turn against the control.
fn tournament(a: &[String]) {
    let net = load(&a[2]);
    let fit: Value = serde_json::from_str(&std::fs::read_to_string(&a[3]).unwrap()).unwrap();
    let pairs: usize = a[4].parse().unwrap();
    let first: u64 = a[5].parse().unwrap();
    let threads: usize = a[6].parse().unwrap();
    let done: HashSet<u64> = lines(&a[7]).iter().map(|r| r["seed"].as_u64().unwrap()).collect();
    let out = appender(&a[7]);
    let look01 = arms(&fit).into_iter().find(|(n, ..)| n == "look01").unwrap().2;
    let seeds: Vec<u64> = (first..first + pairs as u64).filter(|s| !done.contains(s)).collect();
    eprintln!("{} pairs to play", seeds.len());
    par(seeds.len(), threads, &|i| {
        let seed = seeds[i];
        let t = Instant::now();
        let mut s = AzulState::<Seeded>::seeded(seed);
        let mut memo = Memo::new();
        while !s.is_terminal() && s.round_index() < 3 {
            let r = choose_memoised(&net, &s, &config(SHIPPED, ENDGAME), &mut memo).unwrap();
            s.apply(r.action).unwrap();
        }
        let games: Vec<Value> = [Player::P0, Player::P1]
            .into_iter()
            .map(|look_seat| {
                let mut sides = [Side { look: false, memo: Memo::new(), ms: Vec::new() }, Side { look: false, memo: Memo::new(), ms: Vec::new() }];
                sides[look_seat as usize].look = true;
                let mut g = s.clone();
                while !g.is_terminal() {
                    let action = sides[g.current_player() as usize].play(&net, &g, &look01);
                    g.apply(action).unwrap();
                }
                let result = match (g.outcome(), look_seat) {
                    (Some(Outcome::Player0), Player::P0) | (Some(Outcome::Player1), Player::P1) => 1.0,
                    (Some(Outcome::Draw), _) | (None, _) => 0.5,
                    _ => 0.0,
                };
                let ms = |side: &Side| side.ms.iter().map(|&(t, m)| json!([t, m])).collect::<Vec<_>>();
                let ctl = &sides[1 - look_seat as usize];
                json!({
                    "lookSeat": look_seat as usize, "result": result, "scores": g.scores(),
                    "look": ms(&sides[look_seat as usize]), "ctl": ms(ctl),
                })
            })
            .collect();
        emit(&out, &json!({ "seed": seed, "games": games, "s": t.elapsed().as_secs_f64() }));
    });
}

/// The match's score for the lookahead, a 95% bootstrap interval over pairs,
/// and the gated moves' times by phase on each side.
fn tournament_report(a: &[String]) {
    let pairs = lines(&a[2]);
    let sums: Vec<f64> =
        pairs.iter().map(|p| p["games"].as_array().unwrap().iter().map(|g| g["result"].as_f64().unwrap()).sum()).collect();
    let n = sums.len();
    let mean = sums.iter().sum::<f64>() / (2 * n) as f64;
    let mut rng = Rng::new(7);
    let mut boots: Vec<f64> =
        (0..2000).map(|_| (0..n).map(|_| sums[rng.below(n as u64) as usize]).sum::<f64>() / (2 * n) as f64).collect();
    let (lo, hi) = (quantile(&mut boots, 0.025), quantile(&mut boots, 0.975));
    let elo = |p: f64| 400.0 * (p / (1.0 - p)).log10();
    let (w, d, l) = pairs.iter().flat_map(|p| p["games"].as_array().unwrap().iter()).fold((0, 0, 0), |(w, d, l), g| {
        match g["result"].as_f64().unwrap() {
            r if r > 0.75 => (w + 1, d, l),
            r if r > 0.25 => (w, d + 1, l),
            _ => (w, d, l + 1),
        }
    });
    println!("look01 vs time-matched control: {} games, W-D-L {w}-{d}-{l}", 2 * n);
    println!("score {:.1}% ({:.1}% to {:.1}%), Elo {:+.0} ({:+.0} to {:+.0})", 100.0 * mean, 100.0 * lo, 100.0 * hi, elo(mean), elo(lo), elo(hi));
    let mut by: BTreeMap<String, usize> = BTreeMap::new();
    for s in &sums {
        *by.entry(format!("{s:.1}")).or_default() += 1;
    }
    println!("pairs by the lookahead's points out of 2: {by:?}");
    for side in ["look", "ctl"] {
        for ph in ["0-7", "8-15", "16-20"] {
            let mut ms: Vec<f64> = pairs
                .iter()
                .flat_map(|p| p["games"].as_array().unwrap().iter())
                .flat_map(|g| g[side].as_array().unwrap().iter())
                .filter(|m| phase(m[0].as_u64().unwrap()) == ph)
                .map(|m| m[1].as_f64().unwrap())
                .collect();
            if ms.is_empty() {
                continue;
            }
            let total: f64 = ms.iter().sum();
            println!(
                "{side:>5} {ph:>6}  moves {:>5}  p50 {:>6.0} ms  p95 {:>6.0} ms  total {:>7.1} s",
                ms.len(),
                median(ms.clone()),
                quantile(&mut ms, 0.95),
                total / 1e3
            );
        }
    }
}

fn main() {
    let a: Vec<String> = std::env::args().collect();
    match a.get(1).map(String::as_str) {
        Some("positions") => positions(&a),
        Some("run") => run(&a),
        Some("score") => score(&a),
        Some("report") => report(&a),
        Some("match") => tournament(&a),
        Some("match-report") => tournament_report(&a),
        _ => eprintln!("usage: decide positions|run|score|report|match|match-report ..."),
    }
}
