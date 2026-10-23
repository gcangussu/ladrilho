//! [Z11-80]: the lookahead past a boundary into round 5 or later — searches of
//! deals the crate draws itself, whose mean root value labels the boundary
//! sample for the trainer ([Z11-82]).
//!
//! A deal is drawn from the bag's public counts by the crate's own generator,
//! so nothing here reads the real bag's order or the game's shuffler. The
//! searches label a sample and choose nothing: the move a game plays is its
//! own search's, so the information barrier of [Z11-15] is untouched.

use azul_engine::{Action, AzulState, Seeded, Shuffler};

use crate::memo::{Key, Memo};
use crate::network::{Evaluation, Evaluator, Request};
use crate::rng::Rng;
use crate::search::{Search, SearchConfig};

/// The round index of round 5: a boundary into it, or into a later one, is
/// looked past ([Z11-80]).
pub const FROM_ROUND_INDEX: u32 = 4;

/// Whether the boundary ply that led to `after` is one [Z11-80] looks past:
/// it did not end the game, and it opened round 5 or a later one.
pub fn looked_past<S: Shuffler>(after: &AzulState<S>) -> bool {
    !after.is_terminal() && after.round_index() >= FROM_ROUND_INDEX
}

/// `deals` deals of the boundary ply `action` from `before`, each `before`
/// with its bag laid out in colour order — its public counts, nothing of its
/// order — shuffled by Fisher–Yates, descending, from `rng`, and a `Seeded`
/// shuffler seeded from `rng` for any recycle the deal makes; then the ply
/// applied ([Z11-80]). `None` if the position will not load or the ply will not
/// apply, which a boundary self-play played cannot do.
pub fn draw_deals<S: Shuffler>(
    before: &AzulState<S>,
    action: Action,
    deals: u32,
    rng: &mut Rng,
) -> Option<Vec<AzulState<Seeded>>> {
    let mut c = before.to_canonical();
    let mut public = c.bag.clone();
    public.sort_unstable();
    let mut out = Vec::with_capacity(deals as usize);
    for _ in 0..deals {
        c.bag.clone_from(&public);
        for i in (1..c.bag.len()).rev() {
            let j = rng.below(i as u64 + 1) as usize;
            c.bag.swap(i, j);
        }
        let shuffler = Seeded::new(rng.next_u64());
        let mut s = AzulState::from_canonical(&c, shuffler).ok()?;
        s.apply(action).ok()?;
        out.push(s);
    }
    Some(out)
}

/// A search and its memo, run on until it needs the network: what a lane of
/// [Z11-70]'s batched loop holds, a game's or a lookahead deal's.
#[derive(Default)]
pub(crate) struct Lane {
    pub(crate) search: Option<Search<Seeded>>,
    pub(crate) memo: Memo,
    /// The memo key of the input the search is paused on, once the memo has
    /// missed it: the lane is waiting for the network.
    waiting: Option<Key>,
}

impl Lane {
    pub(crate) fn new(search: Option<Search<Seeded>>) -> Lane {
        Lane { search, memo: Memo::new(), waiting: None }
    }

    /// Runs the search on, the memo answering what it can, until it waits on
    /// the network (`true`), or has finished or has no search (`false`).
    pub(crate) fn advance(&mut self) -> bool {
        if self.waiting.is_some() {
            return true;
        }
        let Some(search) = self.search.as_mut() else { return false };
        while let Some(request) = search.wants() {
            match self.memo.lookup(request) {
                Ok(e) => search.supply(&e),
                Err(k) => {
                    self.waiting = Some(k);
                    return true;
                }
            }
        }
        false
    }

    /// The input the lane is waiting on, if it is.
    pub(crate) fn request(&self) -> Option<Request<'_>> {
        self.waiting.as_ref()?;
        self.search.as_ref()?.wants()
    }

    pub(crate) fn is_waiting(&self) -> bool {
        self.waiting.is_some()
    }

    /// The network's answer to `request`: remembered, then handed to the
    /// search.
    pub(crate) fn supply(&mut self, eval: &Evaluation) {
        if let (Some(k), Some(search)) = (self.waiting.take(), self.search.as_mut()) {
            self.memo.insert(k, eval);
            search.supply(eval);
        }
    }
}

/// One boundary's lookahead in progress: a lane per deal, and each finished
/// deal's root value.
pub(crate) struct Boundary {
    lanes: Vec<Lane>,
    /// Per deal, in the order drawn: its root value once its search has
    /// finished; NaN before, and for good if its search never started.
    values: Vec<f32>,
}

impl Boundary {
    /// The deals of [`draw_deals`], each a search with `config` and no noise,
    /// from the seat that opens the next round. A boundary whose deals cannot
    /// be drawn has none, and its value is NaN.
    pub(crate) fn new<S: Shuffler>(
        before: &AzulState<S>,
        action: Action,
        deals: u32,
        config: &SearchConfig,
        rng: &mut Rng,
    ) -> Boundary {
        let states = draw_deals(before, action, deals, rng).unwrap_or_default();
        let lanes: Vec<Lane> = states.iter().map(|s| Lane::new(Search::new(s, config, None))).collect();
        let values = vec![f32::NAN; deals.max(1) as usize];
        Boundary { lanes, values }
    }

    /// Every deal's search run on to the network; `true` while one waits.
    /// A search that finishes leaves its root value, and its memo goes.
    pub(crate) fn advance(&mut self) -> bool {
        let mut waiting = false;
        for (lane, value) in self.lanes.iter_mut().zip(&mut self.values) {
            if lane.advance() {
                waiting = true;
            } else if let Some(search) = lane.search.take() {
                *value = search.finish().0.value;
                lane.memo = Memo::new();
            }
        }
        waiting
    }

    /// The inputs its deals wait on, in deal order.
    pub(crate) fn requests<'a>(&'a self, out: &mut Vec<Request<'a>>) {
        out.extend(self.lanes.iter().filter_map(Lane::request));
    }

    /// Each waiting deal's evaluation, taken from `evals` in the order of
    /// [`Boundary::requests`].
    pub(crate) fn supply<'e>(&mut self, evals: &mut impl Iterator<Item = &'e Evaluation>) {
        for lane in self.lanes.iter_mut().filter(|l| l.is_waiting()) {
            if let Some(e) = evals.next() {
                lane.supply(e);
            }
        }
    }

    /// `L`: the deals' root values, each from the seat that opens the next
    /// round, summed in `f64` in the order drawn, over their count.
    pub(crate) fn value(&self) -> f32 {
        let sum: f64 = self.values.iter().map(|&v| f64::from(v)).sum();
        (sum / self.values.len() as f64) as f32
    }
}

/// [Z11-80]'s lookahead value of the boundary ply `action` from `before`, on
/// its own: what self-play writes for that boundary, given the generator in
/// the state self-play's would be in. The deals' searches are valued a batch
/// at a time, which changes no bit ([Z11-70]).
pub fn lookahead_value<S: Shuffler, E: Evaluator>(
    net: &E,
    before: &AzulState<S>,
    action: Action,
    deals: u32,
    config: &SearchConfig,
    rng: &mut Rng,
) -> f32 {
    let mut b = Boundary::new(before, action, deals, config, rng);
    let mut evals = Vec::new();
    while b.advance() {
        let mut requests = Vec::new();
        b.requests(&mut requests);
        evals.resize(requests.len(), Evaluation::default());
        net.evaluate_batch(&requests, &mut evals);
        drop(requests);
        b.supply(&mut evals.iter());
    }
    b.value()
}
