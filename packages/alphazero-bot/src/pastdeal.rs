//! The past-deal refinement ([Z11-91] to [Z11-96]): in round 4, a look past
//! the boundary into the final round, for play only.
//!
//! In round 4 every boundary leaf of a search faces the same deal: no move of
//! a round touches the bag, so the bag that will deal round 5 is the same at
//! every leaf, and into round 5 it holds exactly the 20 tiles that will be
//! dealt. So one pool of deals, drawn once from the bag's public counts, can
//! value every leaf, and two leaves are compared on the same deals.
//!
//! The pool is seeded from what stays fixed through a round and is public:
//! walls, scores, the bag's counts, the round. Never from the bag's order, so
//! two positions that differ only there play the same move, and every move of
//! a round draws the same pool. Not from the lid either: a floor's overflow
//! reaches the lid in the middle of a round ([Z11-92]).
//!
//! [`choose_played`] searches as `choose_memoised` does; where the refinement
//! applies ([`PastDeal::applies`]) it then values the most-visited boundary
//! leaves on the pool, by a fixed blend of the head on each dealt position and
//! a greedy rollout's margin, and searches again from scratch with those
//! values, every other boundary leaf recalibrated onto the blend's scale. The
//! second search plays. Nothing stops it part way, and no clock is read.

use std::borrow::BorrowMut;

use azul_engine::{Action, AzulState, Canonical, Player, Seeded, Shuffler};
use serde::{Deserialize, Serialize};

use crate::memo::Memo;
use crate::network::{Evaluation, Evaluator};
use crate::rng::{Rng, splitmix64};
use crate::search::{Search, SearchConfig, SearchResult};

/// The round index a root must be in: round 4, whose boundaries deal round 5.
pub const ROOT_ROUND_INDEX: u32 = 3;

/// A deal draws 20 tiles: with fewer in the bag it would recycle the lid.
pub const DEAL_TILES: usize = 20;

/// The simulations the leaf cap and the budget are stated at; below it both
/// scale down in proportion, and above it they stay ([Z11-93]).
pub const REFERENCE_SIMULATIONS: u32 = 10_000;

/// `a + b·v`: a pre-deal head value moved onto the blend's scale ([Z11-95]).
#[derive(Clone, Copy, Debug, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
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

/// A leaf's refined value: `intercept + head·v + dealt·mean(dealt values) +
/// rollout·erf(mean margin / (sigma·√2))`, clamped to [−1, 1] ([Z11-95]).
#[derive(Clone, Copy, Debug, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Blend {
    pub intercept: f64,
    pub head: f64,
    pub dealt: f64,
    pub rollout: f64,
    pub sigma: f64,
}

/// The refinement's settings, one checkpoint's: what `pastdeal.json` holds
/// ([Z11-97]) and [`PastDeal::parse`] reads, natively and in the browser.
#[derive(Clone, Debug, PartialEq)]
pub struct PastDeal {
    /// The checkpoint the constants were fitted to.
    pub checkpoint_sha256: String,
    /// The fewest tiles left on the board for it to apply ([Z11-91]).
    pub gate: u32,
    pub deals: u32,
    /// At most this many leaves refined, most-visited first, at
    /// [`REFERENCE_SIMULATIONS`].
    pub leaves: u32,
    /// Network calls refinement may spend on a move, at [`REFERENCE_SIMULATIONS`].
    pub budget: u64,
    /// Whether each deal's rung includes a greedy rollout ([Z11-94]).
    pub rollouts: bool,
    pub blend: Blend,
    pub recal: Recal,
}

/// `pastdeal.json` as written: the settings, and what the fit measured,
/// which nothing reads back.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Raw {
    checkpoint_sha256: String,
    gate: u32,
    deals: u32,
    leaves: u32,
    budget: u64,
    rollouts: bool,
    blend: Blend,
    recal: Recal,
    #[serde(default)]
    #[allow(dead_code)]
    fit: Option<serde_json::Value>,
}

impl PastDeal {
    /// `pastdeal.json`'s settings, refused unless every number is finite and
    /// in range ([Z11-97]).
    pub fn parse(bytes: &[u8]) -> Result<PastDeal, String> {
        let r: Raw = serde_json::from_slice(bytes).map_err(|e| format!("pastdeal.json: {e}"))?;
        let finite = [r.blend.intercept, r.blend.head, r.blend.dealt, r.blend.rollout, r.blend.sigma, r.recal.a, r.recal.b];
        if finite.iter().any(|x| !x.is_finite()) {
            return Err("pastdeal.json: every constant must be finite".into());
        }
        if r.blend.sigma <= 0.0 {
            return Err("pastdeal.json: sigma must be positive".into());
        }
        if r.checkpoint_sha256.len() != 64 || !r.checkpoint_sha256.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err("pastdeal.json: checkpointSha256 must be 64 hex digits".into());
        }
        let ranges = [("gate", u64::from(r.gate), 0, 20), ("deals", u64::from(r.deals), 1, 64), ("leaves", u64::from(r.leaves), 1, 256)];
        for (name, x, lo, hi) in ranges {
            if !(lo..=hi).contains(&x) {
                return Err(format!("pastdeal.json: {name} must be in {lo}..={hi}"));
            }
        }
        if !(1..=1_000_000).contains(&r.budget) {
            return Err("pastdeal.json: budget must be in 1..=1000000".into());
        }
        Ok(PastDeal {
            checkpoint_sha256: r.checkpoint_sha256.to_ascii_lowercase(),
            gate: r.gate,
            deals: r.deals,
            leaves: r.leaves,
            budget: r.budget,
            rollouts: r.rollouts,
            blend: r.blend,
            recal: r.recal,
        })
    }

    /// The leaf cap and the call budget at `simulations` ([Z11-93]):
    /// `min(cap, simulations × cap / 10 000)`, in integers.
    pub fn scaled(&self, simulations: u32) -> (u32, u64) {
        let s = u64::from(simulations);
        let r = u64::from(REFERENCE_SIMULATIONS);
        let leaves = u64::from(self.leaves).min(s * u64::from(self.leaves) / r) as u32;
        (leaves, self.budget.min(s * self.budget / r))
    }

    /// [Z11-91]: whether the refinement applies to a search of `root` at
    /// `simulations`: round index 3, a bag of at least 20, at least `gate`
    /// tiles left, and at least one leaf to refine once scaled.
    pub fn applies<S: Shuffler>(&self, root: &AzulState<S>, simulations: u32) -> bool {
        !root.is_terminal()
            && root.round_index() == ROOT_ROUND_INDEX
            && u32::from(root.tiles_left()) >= self.gate
            && root.to_canonical().bag.len() >= DEAL_TILES
            && self.scaled(simulations).0 >= 1
    }
}

fn clamp(x: f64) -> f32 {
    x.clamp(-1.0, 1.0) as f32
}

/// erf by Abramowitz and Stegun 7.1.26, |error| < 1.5e-7 ([Z11-94]).
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

/// [Z11-92]: the pool's seed, a hash of what a round leaves fixed and
/// everyone sees: walls, scores, the bag's counts by colour, the round index.
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
    /// [Z11-92]: the pool of `state`'s round: its bag's public counts in
    /// colour order, shuffled `deals` times by Fisher–Yates, descending, from
    /// a generator seeded by [`pool_seed`].
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

/// [Z11-94]: a greedy rollout from `start` to the game's end, each move the
/// legal action of highest logit ([`Evaluator::greedy`]): the final margin
/// from `seat`'s side.
fn rollout<E: Evaluator>(net: &E, start: &AzulState<Seeded>, seat: Player, calls: &mut u64) -> i32 {
    let mut s = start.clone();
    while !s.is_terminal() {
        let legal = s.legal_actions();
        *calls += 1;
        let best = net.greedy(&s.encode(), legal.as_slice());
        if s.apply(best).is_err() {
            break;
        }
    }
    let sc = s.scores();
    sc[seat.index()] - sc[seat.other().index()]
}

/// One leaf's rungs, from the seat that opens the next round.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Rungs {
    /// The head on each dealt position.
    pub dealt: Vec<f32>,
    /// Each deal's rollout margin, when run.
    pub margins: Vec<i32>,
}

/// The rungs of the boundary ply `action` from `before` on `pool`: the head
/// on every deal, and a rollout per deal if `rollouts`. `None` if the ply
/// cannot be dealt from the pool.
pub fn rungs<S: Shuffler, E: Evaluator>(
    net: &E,
    pool: &Pool,
    before: &AzulState<S>,
    action: Action,
    rollouts: bool,
    calls: &mut u64,
) -> Option<Rungs> {
    let mut r = Rungs::default();
    for k in 0..pool.orders.len() {
        let s = pool.deal(before, action, k)?;
        rungs_dealt(net, &s, rollouts, &mut r, calls);
    }
    Some(r)
}

/// One dealt position's rungs, added to `r`: the head on it, and a rollout's
/// margin if `rollouts`; each from the seat to move, the one that opens the
/// round. Every call reaches the network: none goes through a memo
/// ([Z11-93]).
pub fn rungs_dealt<E: Evaluator>(net: &E, s: &AzulState<Seeded>, rollouts: bool, r: &mut Rungs, calls: &mut u64) {
    let mut e = Evaluation::default();
    let legal = s.legal_actions();
    *calls += 1;
    net.evaluate(&s.encode(), legal.as_slice(), &mut e);
    r.dealt.push(e.value);
    if rollouts {
        r.margins.push(rollout(net, s, s.current_player(), calls));
    }
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
    /// The blend of a leaf's head value `v` and its rungs.
    pub fn value(&self, v: f32, r: &Rungs) -> f32 {
        let mut x = self.intercept + self.head * f64::from(v);
        if let Some(d) = mean(r.dealt.iter().map(|&x| f64::from(x))) {
            x += self.dealt * d;
        }
        if let Some(m) = mean(r.margins.iter().map(|&m| f64::from(m))) {
            x += self.rollout * margin_value(m, self.sigma);
        }
        clamp(x)
    }
}

/// What [`search_played`] did.
#[derive(Clone, Debug, PartialEq)]
pub struct Played {
    /// The move played, and its search: the second search's where the
    /// refinement applied, else the only one's.
    pub result: SearchResult,
    /// The first search's result.
    pub first: SearchResult,
    /// Network calls of each stage: memo misses for the searches, every call
    /// for the refinement.
    pub calls_first: u64,
    pub calls_refine: u64,
    pub calls_second: u64,
    /// Distinct leaves refined.
    pub refined: u32,
    /// Whether the refinement applied ([`PastDeal::applies`]).
    pub applied: bool,
}

/// The refined values, by pre-deal view: a fixed hash of the view's bits to
/// skip most comparisons, then the bits themselves. Small, so a list; and
/// seeded by nothing, so the same everywhere.
#[derive(Default)]
struct Refined(Vec<(u64, Box<[u32]>, f32)>);

impl Refined {
    fn key(observation: &[f32]) -> (u64, Box<[u32]>) {
        let bits: Box<[u32]> = observation.iter().map(|x| x.to_bits()).collect();
        let mut h = 0xcbf2_9ce4_8422_2325u64;
        for &b in bits.iter() {
            h = (h ^ u64::from(b)).wrapping_mul(0x0100_0000_01b3);
        }
        (h, bits)
    }

    fn get(&self, observation: &[f32]) -> Option<f32> {
        let (h, bits) = Refined::key(observation);
        self.0.iter().find(|(g, b, _)| *g == h && *b == bits).map(|e| e.2)
    }

    fn insert(&mut self, observation: &[f32], value: f32) {
        let (h, bits) = Refined::key(observation);
        self.0.push((h, bits, value));
    }

    fn len(&self) -> usize {
        self.0.len()
    }
}

/// Runs `search` to its end with the memo, every boundary request valued by
/// `boundary` of the head's own value. The memo stores the network's raw
/// answers, so a hit is the call it replaces ([Z11-96]).
fn drive<S: Shuffler, E: Evaluator>(
    net: &E,
    search: &mut Search<S>,
    memo: &mut Memo,
    calls: &mut u64,
    boundary: &mut dyn FnMut(&[f32], f32) -> f32,
) {
    let mut eval = Evaluation::default();
    while let Some(request) = search.wants() {
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
        search.supply(&e);
    }
}

/// The search of [`choose_played`], without the endgame proof. With no
/// refinement, or where it does not apply, it is `search_memoised_until`'s
/// search, never stopped, bit for bit: the first search below.
///
/// Where it applies ([Z11-93] to [Z11-96]): the first search runs as that
/// one; its boundary leaves into round 5 are walked ([`Search::boundary_leaves`]'s
/// order) and sorted by visits, descending, ties keeping the walk's order;
/// the first `leaves` distinct pre-deal views are refined on one pool, until
/// the calls spent reach the budget, checked before each leaf; the leaves are dropped; and a
/// second search from an empty tree, at the same config, takes each refined
/// view's blend and every other boundary's recalibrated head.
pub fn search_played<S: Shuffler, E: Evaluator>(
    net: &E,
    root: &AzulState<S>,
    config: &SearchConfig,
    past_deal: Option<&PastDeal>,
    memo: &mut Memo,
) -> Option<Played> {
    let pd = past_deal.filter(|pd| pd.applies(root, config.simulations));
    let mut calls_first = 0;
    let mut first = Search::new(root, config, None)?;
    drive(net, &mut first, memo, &mut calls_first, &mut |_, v| v);
    let Some(pd) = pd else {
        let r = first.finish().0;
        return Some(Played { result: r.clone(), first: r, calls_first, calls_refine: 0, calls_second: 0, refined: 0, applied: false });
    };
    let (cap, budget) = pd.scaled(config.simulations);

    let mut leaves = first.boundary_leaves();
    let first = first.finish().0;

    // Refine, most-visited first; a stable sort keeps the walk's order on ties.
    leaves.sort_by_key(|l| std::cmp::Reverse(l.taken));
    let pool = Pool::of(root, pd.deals);
    let mut refined = Refined::default();
    let mut calls_refine = 0u64;
    for leaf in &leaves {
        if refined.len() >= cap as usize || calls_refine >= budget {
            break;
        }
        let mut after = leaf.before.clone();
        if after.apply(leaf.action).is_err() {
            continue;
        }
        let view = crate::view::pre_deal_view(&leaf.before, &after);
        if refined.get(&view).is_some() {
            continue;
        }
        let Some(r) = rungs(net, &pool, &leaf.before, leaf.action, pd.rollouts, &mut calls_refine) else {
            continue;
        };
        refined.insert(&view, pd.blend.value(leaf.value, &r));
    }
    drop(leaves);

    let mut calls_second = 0;
    let mut second = Search::new(root, config, None)?;
    drive(net, &mut second, memo, &mut calls_second, &mut |obs, v| {
        refined.get(obs).unwrap_or_else(|| pd.recal.apply(v))
    });
    Some(Played {
        result: second.finish().0,
        first,
        calls_first,
        calls_refine,
        calls_second,
        refined: refined.len() as u32,
        applied: true,
    })
}

/// `choose_memoised` with the refinement ([Z11-96]): [`search_played`], then
/// [Z11-76]'s endgame proof on its result. With `None`, or where the
/// refinement does not apply, the same result `choose_memoised` gives, bit
/// for bit. The memo is dropped before the proof, as there.
pub fn choose_played<S: Shuffler, E: Evaluator>(
    net: &E,
    root: &AzulState<S>,
    config: &SearchConfig,
    past_deal: Option<&PastDeal>,
    mut memo: impl BorrowMut<Memo>,
) -> Option<SearchResult> {
    let played = search_played(net, root, config, past_deal, memo.borrow_mut())?;
    drop(memo);
    Some(crate::endgame::refine(root, played.result, config.endgame_nodes).0)
}
