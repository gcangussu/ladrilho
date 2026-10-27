//! A lookahead past the boundary into the final round, for play: an
//! experiment, off unless a caller asks for it, and not yet a requirement.
//!
//! In round 4 every boundary leaf of a search faces the same deal: no move of
//! a round touches the bag, so the bag that will deal round 5 is the same at
//! every leaf, and into round 5 it holds exactly the 20 tiles that will be
//! dealt. So one pool of deals, drawn once from the bag's public counts, can
//! value every leaf, and two leaves are compared on the same deals.
//!
//! The pool is seeded from what stays fixed through a round and is public:
//! walls, scores, bag and lid counts, the round. Never from the bag's order,
//! so two positions that differ only there play the same move, and every move
//! of a round draws the same pool.
//!
//! [`choose_past_deal`] searches as `choose` does, re-values the most-visited
//! boundary leaves on the pool by a fixed blend of cheap evaluators (the
//! *ladder*), and searches again from scratch with those values, every other
//! boundary leaf recalibrated onto the blend's scale. The second search plays.
//! A stop during any of it leaves the first search's move. No clock is read.

use std::collections::HashMap;

use azul_engine::{Action, AzulState, Canonical, Player, Seeded, Shuffler};

use crate::memo::Memo;
use crate::network::{Evaluation, Evaluator, Request};
use crate::rng::{Rng, splitmix64};
use crate::search::{Search, SearchConfig, SearchResult, TreeStats};

/// The round index a root must be in: round 4, whose boundaries deal round 5.
pub const ROOT_ROUND_INDEX: u32 = 3;

/// A deal draws 20 tiles: with fewer in the bag it would recycle the lid.
pub const DEAL_TILES: usize = 20;

/// `a + b·v`: a pre-deal head value moved onto the blend's scale.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Recal {
    pub a: f64,
    pub b: f64,
}

impl Recal {
    pub const IDENTITY: Recal = Recal { a: 0.0, b: 1.0 };

    pub fn apply(&self, v: f32) -> f32 {
        clamp(self.a + self.b * f64::from(v))
    }
}

/// A leaf's refined value: `intercept + head·v + dealt·mean(r0) +
/// rollout·(2Φ(mean m / sigma) − 1) + deep·mean(r2)`, clamped to [−1, 1].
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Blend {
    pub intercept: f64,
    pub head: f64,
    pub dealt: f64,
    pub rollout: f64,
    pub sigma: f64,
    pub deep: f64,
}

/// The deep rung: a short search of each dealt position, on the top leaves.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Deep {
    /// How many of the most-visited leaves get it.
    pub leaves: u32,
    /// On how many of the pool's deals (the first ones).
    pub deals: u32,
    pub simulations: u32,
    pub blend: Blend,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mode {
    /// Refine, then search again.
    TwoPass,
    /// One search, every boundary leaf into round 5 recalibrated; no deal.
    RecalOnly,
}

#[derive(Clone, Debug, PartialEq)]
pub struct PastDeal {
    pub mode: Mode,
    pub deals: u32,
    /// At most this many leaves refined, most-visited first.
    pub leaves: u32,
    /// Network calls refinement may spend on a move.
    pub budget: u64,
    /// Whether the ladder includes a greedy rollout per deal.
    pub rollouts: bool,
    pub blend: Blend,
    pub deep: Option<Deep>,
    pub recal: Recal,
}

fn clamp(x: f64) -> f32 {
    x.clamp(-1.0, 1.0) as f32
}

/// erf by Abramowitz and Stegun 7.1.26, |error| < 1.5e-7.
fn erf(x: f64) -> f64 {
    let s = x.signum();
    let x = x.abs();
    let t = 1.0 / (1.0 + 0.327_591_1 * x);
    let y = 1.0
        - (((((1.061_405_429 * t - 1.453_152_027) * t) + 1.421_413_741) * t - 0.284_496_736) * t + 0.254_829_592)
            * t
            * (-x * x).exp();
    s * y
}

/// `2Φ(m/σ) − 1`, which is `erf(m / (σ√2))`.
pub fn margin_value(m: f64, sigma: f64) -> f64 {
    erf(m / (sigma * std::f64::consts::SQRT_2))
}

/// The pool's seed: a hash of what a round leaves fixed and everyone sees.
pub fn pool_seed(c: &Canonical) -> u64 {
    let mut h = 0x9e37_79b9_7f4a_7c15u64;
    let mut mix = |x: u64| h = splitmix64(h ^ x);
    for wall in &c.walls {
        for &cell in wall {
            mix(u64::from(cell));
        }
    }
    for &s in &c.scores {
        mix(s as u32 as u64);
    }
    let mut counts = [0u64; 5];
    for &t in &c.bag {
        counts[usize::from(t)] += 1;
    }
    for n in counts {
        mix(n);
    }
    for &n in &c.lid {
        mix(u64::from(n));
    }
    mix(u64::from(c.round_index));
    h
}

/// `K` deals of one bag: the orders it is laid out in (the last tile is drawn
/// first), and a seed per deal for any later recycle's shuffler.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Pool {
    pub id: u64,
    pub orders: Vec<Vec<u8>>,
    pub seeds: Vec<u64>,
}

impl Pool {
    /// The pool of `state`'s round: its bag's public counts in colour order,
    /// shuffled `deals` times by Fisher–Yates, descending, from a generator
    /// seeded by [`pool_seed`].
    pub fn of<S: Shuffler>(state: &AzulState<S>, deals: u32) -> Pool {
        let c = state.to_canonical();
        let id = pool_seed(&c);
        let mut rng = Rng::new(id);
        let mut public = c.bag.clone();
        public.sort_unstable();
        let mut orders = Vec::with_capacity(deals as usize);
        let mut seeds = Vec::with_capacity(deals as usize);
        for _ in 0..deals {
            let mut bag = public.clone();
            for i in (1..bag.len()).rev() {
                let j = rng.below(i as u64 + 1) as usize;
                bag.swap(i, j);
            }
            orders.push(bag);
            seeds.push(rng.next_u64());
        }
        Pool { id, orders, seeds }
    }

    /// The boundary ply `action` from `before`, dealt with the bag laid out
    /// as deal `k`. `None` unless `before`'s bag holds the pool's tiles and the
    /// ply deals a new round.
    pub fn deal<S: Shuffler>(&self, before: &AzulState<S>, action: Action, k: usize) -> Option<AzulState<Seeded>> {
        let mut c = before.to_canonical();
        let mut have = c.bag.clone();
        have.sort_unstable();
        let mut want = self.orders[k].clone();
        want.sort_unstable();
        if have != want {
            return None;
        }
        c.bag.clone_from(&self.orders[k]);
        let mut s = AzulState::from_canonical(&c, Seeded::new(self.seeds[k])).ok()?;
        s.apply(action).ok()?;
        (!s.is_terminal() && s.round_index() == before.round_index() + 1).then_some(s)
    }
}

/// Whether `root` is a position the lookahead applies to.
pub fn applies<S: Shuffler>(root: &AzulState<S>) -> bool {
    !root.is_terminal() && root.round_index() == ROOT_ROUND_INDEX && root.to_canonical().bag.len() >= DEAL_TILES
}

/// A network that counts its calls.
struct Counted<'a, E> {
    net: &'a E,
    calls: u64,
}

impl<E: Evaluator> Counted<'_, E> {
    fn evaluate(&mut self, request: Request<'_>, out: &mut Evaluation) {
        self.calls += 1;
        self.net.evaluate(request.0, request.1, out);
    }
}

/// A greedy policy rollout from `start` to the game's end: the final margin
/// from `seat`'s side.
fn rollout<E: Evaluator>(net: &mut Counted<'_, E>, start: &AzulState<Seeded>, seat: Player) -> i32 {
    let mut s = start.clone();
    let mut e = Evaluation::default();
    while !s.is_terminal() {
        let legal = s.legal_actions();
        let obs = s.encode();
        net.evaluate((&obs, legal.as_slice()), &mut e);
        let mut best = legal.as_slice()[0];
        for &a in legal.as_slice() {
            if e.policy[usize::from(a)] > e.policy[usize::from(best)] {
                best = a;
            }
        }
        if s.apply(best).is_err() {
            break;
        }
    }
    let sc = s.scores();
    sc[seat.index()] - sc[seat.other().index()]
}

/// One leaf's ladder, from the seat that opens the next round.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Rungs {
    /// The head on each dealt position.
    pub dealt: Vec<f32>,
    /// Each deal's rollout margin, when run.
    pub margins: Vec<i32>,
    /// Each deep search's root value, when run.
    pub deep: Vec<f32>,
}

/// The ladder of the boundary ply `action` from `before` on `pool`: the
/// head on every deal, a rollout per deal if `rollouts`, and a
/// `deep.simulations` search on the first `deep.deals` deals if `deep`.
/// `None` if the ply cannot be dealt from the pool.
pub fn ladder<S: Shuffler, E: Evaluator>(
    net: &E,
    pool: &Pool,
    before: &AzulState<S>,
    action: Action,
    rollouts: bool,
    deep: Option<&Deep>,
    calls: &mut u64,
) -> Option<Rungs> {
    let mut r = Rungs::default();
    for k in 0..pool.orders.len() {
        let s = pool.deal(before, action, k)?;
        rungs_dealt(net, &s, rollouts, deep.filter(|d| k < d.deals as usize), &mut r, calls);
    }
    Some(r)
}

/// One dealt position's rungs, added to `r`: the head on it, a rollout's
/// margin if `rollouts`, a `deep.simulations` search's root value if `deep`;
/// each from the seat to move, the one that opens the round.
pub fn rungs_dealt<E: Evaluator>(
    net: &E,
    s: &AzulState<Seeded>,
    rollouts: bool,
    deep: Option<&Deep>,
    r: &mut Rungs,
    calls: &mut u64,
) {
    let mut net = Counted { net, calls: 0 };
    let mut e = Evaluation::default();
    let seat = s.current_player();
    let legal = s.legal_actions();
    let obs = s.encode();
    net.evaluate((&obs, legal.as_slice()), &mut e);
    r.dealt.push(e.value);
    if rollouts {
        r.margins.push(rollout(&mut net, s, seat));
    }
    if let Some(d) = deep {
        let config = SearchConfig { simulations: d.simulations, cpuct: 1.25, fpu: 0.25, endgame_nodes: 0 };
        if let Some(mut search) = Search::new(s, &config, None) {
            while let Some(request) = search.wants() {
                net.evaluate(request, &mut e);
                search.supply(&e);
            }
            r.deep.push(search.finish().0.value);
        }
    }
    *calls += net.calls;
}

fn mean(xs: impl Iterator<Item = f64>) -> Option<f64> {
    let (mut sum, mut n) = (0.0, 0u32);
    for x in xs {
        sum += x;
        n += 1;
    }
    (n > 0).then(|| sum / f64::from(n))
}

impl Blend {
    /// The blend of a leaf's head value `v` and its ladder.
    pub fn value(&self, v: f32, r: &Rungs) -> f32 {
        let mut x = self.intercept + self.head * f64::from(v);
        if let Some(d) = mean(r.dealt.iter().map(|&x| f64::from(x))) {
            x += self.dealt * d;
        }
        if let Some(m) = mean(r.margins.iter().map(|&m| f64::from(m))) {
            x += self.rollout * margin_value(m, self.sigma);
        }
        if let Some(s) = mean(r.deep.iter().map(|&x| f64::from(x))) {
            x += self.deep * s;
        }
        clamp(x)
    }
}

/// What [`choose_past_deal`] did.
#[derive(Clone, Debug, PartialEq)]
pub struct Played {
    /// The move played, and its search.
    pub result: SearchResult,
    /// The first search's result: today's move.
    pub first: SearchResult,
    /// The first search's tree, and the simulations it ran.
    pub first_stats: TreeStats,
    pub first_simulations: u32,
    /// Network calls (memo misses) of each stage.
    pub calls_first: u64,
    pub calls_refine: u64,
    pub calls_second: u64,
    /// Distinct leaves refined, and how many of them reached the deep rung.
    pub refined: u32,
    pub deepened: u32,
    /// Whether the second search's move stands: false when the lookahead did
    /// not apply, or a stop left the first search's.
    pub applied: bool,
}

type ViewKey = Box<[u32]>;

fn view_key(observation: &[f32]) -> ViewKey {
    observation.iter().map(|x| x.to_bits()).collect()
}

/// Runs `search` to its end with the memo, valuing every boundary request by
/// `boundary` (given the head's own value). `false` if `stop` fired.
fn drive<S: Shuffler, E: Evaluator>(
    net: &E,
    search: &mut Search<S>,
    memo: &mut Memo,
    calls: &mut u64,
    stop: &mut dyn FnMut() -> bool,
    boundary: &mut dyn FnMut(&[f32], f32) -> f32,
) -> bool {
    let mut eval = Evaluation::default();
    let mut stopped = false;
    while search.wants().is_some() {
        if !stopped && stop() {
            stopped = true;
            search.stop();
        }
        let Some(request) = search.wants() else { break };
        let mut e = match memo.lookup(request) {
            Ok(e) => e,
            Err(k) => {
                *calls += 1;
                net.evaluate(request.0, request.1, &mut eval);
                memo.insert(k, &eval);
                eval.clone()
            }
        };
        // A boundary asks for no policy: its legal set is empty, and only it.
        if request.1.is_empty() {
            e.value = boundary(&request.0[..], e.value);
        }
        let after: &mut dyn FnMut() -> bool = if stopped { &mut || false } else { &mut *stop };
        search.supply_until(&e, after);
    }
    !stopped
}

/// `choose`, with the lookahead past the boundary into round 5 when `root`
/// is in round 4 ([`applies`]); otherwise exactly `choose_memoised`'s search.
/// `stop` is asked as `search_memoised_until` asks it, and also between
/// refined leaves; once it fires, the first search's move is played. The
/// endgame proof is left to the caller: in round 4 it never runs, since no
/// wall row can hold four tiles before round 5.
pub fn choose_past_deal<S: Shuffler, E: Evaluator>(
    net: &E,
    root: &AzulState<S>,
    config: &SearchConfig,
    pd: &PastDeal,
    memo: &mut Memo,
    stop: &mut dyn FnMut() -> bool,
) -> Option<Played> {
    let applies = applies(root);
    let mut calls_first = 0;
    let mut first = Search::new(root, config, None)?;
    let recal = |_: &[f32], v: f32| if applies { pd.recal.apply(v) } else { v };
    let identity = |_: &[f32], v: f32| v;
    let recal_only = applies && pd.mode == Mode::RecalOnly;
    let finished = if recal_only {
        drive(net, &mut first, memo, &mut calls_first, stop, &mut { recal })
    } else {
        drive(net, &mut first, memo, &mut calls_first, stop, &mut { identity })
    };
    let first_stats = first.stats();
    let first_simulations = first.simulations_run();
    let leaves = if applies && !recal_only && finished { first.boundary_leaves() } else { Vec::new() };
    let first = first.finish().0;
    let mut played = Played {
        result: first.clone(),
        first,
        first_stats,
        first_simulations,
        calls_first,
        calls_refine: 0,
        calls_second: 0,
        refined: 0,
        deepened: 0,
        applied: recal_only,
    };
    if !applies || recal_only || !finished {
        return Some(played);
    }

    // Refine, most-visited first; ties keep the tree's order.
    let mut leaves = leaves;
    leaves.sort_by_key(|l| std::cmp::Reverse(l.taken));
    let pool = Pool::of(root, pd.deals);
    let mut refined: HashMap<ViewKey, f32> = HashMap::new();
    for leaf in &leaves {
        if refined.len() >= pd.leaves as usize || played.calls_refine >= pd.budget {
            break;
        }
        if stop() {
            return Some(played);
        }
        let mut after = leaf.before.clone();
        if after.apply(leaf.action).is_err() {
            continue;
        }
        let key = view_key(&crate::view::pre_deal_view(&leaf.before, &after));
        if refined.contains_key(&key) {
            continue;
        }
        let deep = pd.deep.as_ref().filter(|d| played.deepened < d.leaves);
        let Some(r) = ladder(net, &pool, &leaf.before, leaf.action, pd.rollouts, deep, &mut played.calls_refine) else {
            continue;
        };
        let blend = match deep {
            Some(d) => {
                played.deepened += 1;
                &d.blend
            }
            None => &pd.blend,
        };
        refined.insert(key, blend.value(leaf.value, &r));
    }
    played.refined = refined.len() as u32;

    // Search again, refined leaves at their values, every other boundary
    // leaf recalibrated.
    let mut second = Search::new(root, config, None)?;
    let mut value = |obs: &[f32], v: f32| refined.get(&view_key(obs)).copied().unwrap_or_else(|| pd.recal.apply(v));
    if !drive(net, &mut second, memo, &mut played.calls_second, stop, &mut value) {
        return Some(played);
    }
    played.result = second.finish().0;
    played.applied = true;
    Some(played)
}
