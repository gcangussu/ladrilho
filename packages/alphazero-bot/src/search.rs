//! The PUCT search ([Z11-14] through [Z11-21]).
//!
//! Each expanded node holds, per legal action, a prior, a visit count and a
//! value sum from the perspective of the seat to move there, and its own
//! network value from when it was expanded. Terminal and boundary nodes are
//! leaves for good: valued once, on their first visit, and never expanded.

use azul_engine::{ACTION_SPACE, Action, ActionList, AzulState, ENCODED_SIZE, Outcome, Player, Shuffler};

use crate::network::{Evaluation, Evaluator, Request};
use crate::rng::Rng;
use crate::view::{accounts_for, is_boundary, pre_deal_view};

#[derive(Clone, Debug, PartialEq)]
pub struct SearchConfig {
    pub simulations: u32,
    pub cpuct: f32,
    pub fpu: f32,
}

#[derive(Clone, Debug, PartialEq)]
pub struct SelfPlayNoise {
    pub alpha: f32,
    pub epsilon: f32,
}

#[derive(Clone, Debug, PartialEq)]
pub struct SearchResult {
    /// The most-visited root action, ties to the lowest index ([Z11-19]).
    pub action: Action,
    pub visits: [u32; ACTION_SPACE],
    /// The mean value backed up to the root, from the root's seat to move.
    pub value: f32,
}

/// What the finished tree holds, by kind: what [Z11-42]'s once-per-node case
/// counts evaluator calls against.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct TreeStats {
    /// Expanded nodes, the root included.
    pub expanded: u32,
    /// Non-terminal boundary nodes, valued by the network on a pre-deal view.
    pub boundaries: u32,
    /// Terminal nodes, valued by `outcome`, a game-ending boundary included.
    pub terminals: u32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Kind {
    Expanded,
    Terminal,
    Boundary,
}

struct Edge {
    action: Action,
    prior: f32,
    visits: u32,
    /// Sum of backed-up values, from the parent's seat to move.
    total: f64,
    child: u32,
}

const NONE: u32 = u32::MAX;

struct Node<S: Shuffler> {
    state: AzulState<S>,
    seat: Player,
    kind: Kind,
    /// The network's value for an expanded node; the leaf value for a terminal
    /// or boundary one. From `seat`'s perspective.
    value: f32,
    visits: u32,
    edges: std::ops::Range<usize>,
}

/// `+1`, `-1` or `0` for `seat` ([Z11-14]).
fn terminal_value(outcome: Option<Outcome>, seat: Player) -> f32 {
    match outcome {
        Some(Outcome::Player0) if seat == Player::P0 => 1.0,
        Some(Outcome::Player1) if seat == Player::P1 => 1.0,
        Some(Outcome::Draw) | None => 0.0,
        Some(_) => -1.0,
    }
}

/// What a paused search is waiting for the network to value.
enum Wait {
    /// The root's own expansion, before the first simulation.
    Root,
    /// A new node below the edge, expanded on its own observation.
    Expand(usize),
    /// A boundary node below the edge, valued on its pre-deal view.
    Boundary(usize),
}

struct Pending<S: Shuffler> {
    wait: Wait,
    state: AzulState<S>,
    observation: [f32; ENCODED_SIZE],
    /// `None` for a boundary: no policy is wanted there.
    legal: Option<ActionList>,
}

/// A search that pauses wherever it needs the network ([Z11-70]): `wants`
/// names the input, `supply` hands back its evaluation and runs on to the next
/// one, and `finish` reads the tree once `wants` has nothing left to ask.
/// Between pauses it is exactly the search [Z11-14] through [Z11-18] describe,
/// so who evaluates, alone or in a batch, changes nothing it computes.
pub struct Search<S: Shuffler> {
    config: SearchConfig,
    nodes: Vec<Node<S>>,
    edges: Vec<Edge>,
    stats: TreeStats,
    path: Vec<(u32, usize)>,
    /// Simulations still to run, the one paused included.
    remaining: u32,
    pending: Option<Pending<S>>,
    /// `ε` and the root's Dirichlet draw, mixed in once the root is expanded.
    noise: Option<(f64, Vec<f64>)>,
}

impl<S: Shuffler> Search<S> {
    /// A search of `root`, paused on the root's expansion. `None` for a
    /// terminal root ([Z11-62]). The root's noise is drawn here, which is the
    /// first thing the search ever draws, so the generator's order is the one
    /// it always had.
    pub fn new(root: &AzulState<S>, config: &SearchConfig, noise: Option<(&SelfPlayNoise, &mut Rng)>) -> Option<Self> {
        if root.is_terminal() {
            return None;
        }
        let legal = root.legal_actions();
        if legal.is_empty() {
            return None;
        }
        let noise = noise.map(|(n, rng)| {
            let mut dir = vec![0f64; legal.len()];
            rng.dirichlet(f64::from(n.alpha), &mut dir);
            (f64::from(n.epsilon), dir)
        });
        let pending = Some(Self::expansion(Wait::Root, root.clone()));
        Some(Search {
            config: config.clone(),
            nodes: Vec::new(),
            edges: Vec::new(),
            stats: TreeStats::default(),
            path: Vec::new(),
            remaining: config.simulations,
            pending,
            noise,
        })
    }

    fn expansion(wait: Wait, state: AzulState<S>) -> Pending<S> {
        let observation = state.encode();
        debug_assert!(accounts_for(&observation, &state), "an input that does not account for every tile ([Z11-51])");
        let legal = Some(state.legal_actions());
        Pending { wait, state, observation, legal }
    }

    /// The input the search is paused on, or `None` once it has finished.
    pub fn wants(&self) -> Option<Request<'_>> {
        self.pending.as_ref().map(|p| (&p.observation, p.legal.as_ref().map_or(&[][..], ActionList::as_slice)))
    }

    /// The evaluation of what `wants` named; the search runs on until it
    /// needs the network again or has run every simulation.
    pub fn supply(&mut self, eval: &Evaluation) {
        let Some(p) = self.pending.take() else { return };
        match p.wait {
            Wait::Root => {
                self.push_expanded(p.state, p.legal.as_ref(), eval);
                if let Some((eps, dir)) = self.noise.take() {
                    for (i, d) in self.nodes[0].edges.clone().zip(dir) {
                        let prior = &mut self.edges[i].prior;
                        *prior = ((1.0 - eps) * f64::from(*prior) + eps * d) as f32;
                    }
                }
            }
            Wait::Expand(e) => {
                let c = self.push_expanded(p.state, p.legal.as_ref(), eval);
                self.settle(e, c);
            }
            Wait::Boundary(e) => {
                let seat = p.state.current_player();
                self.stats.boundaries += 1;
                let c = self.push(Node { state: p.state, seat, kind: Kind::Boundary, value: eval.value, visits: 0, edges: 0..0 });
                self.settle(e, c);
            }
        }
        self.run();
    }

    /// An expanded node: the evaluation's policy over the legal set becomes
    /// its priors, its value the node's `V`.
    fn push_expanded(&mut self, state: AzulState<S>, legal: Option<&ActionList>, eval: &Evaluation) -> u32 {
        let start = self.edges.len();
        for &a in legal.map_or(&[][..], ActionList::as_slice) {
            self.edges.push(Edge { action: a, prior: eval.policy[usize::from(a)], visits: 0, total: 0.0, child: NONE });
        }
        self.stats.expanded += 1;
        let seat = state.current_player();
        self.push(Node { state, seat, kind: Kind::Expanded, value: eval.value, visits: 0, edges: start..self.edges.len() })
    }

    fn push(&mut self, node: Node<S>) -> u32 {
        self.nodes.push(node);
        (self.nodes.len() - 1) as u32
    }

    /// The new child `c` hangs below edge `e`; its value is the simulation's.
    fn settle(&mut self, e: usize, c: u32) {
        self.edges[e].child = c;
        let n = &self.nodes[c as usize];
        self.backup(n.value, n.seat);
    }

    /// Simulations until one needs the network or none remain.
    fn run(&mut self) {
        while self.pending.is_none() && self.remaining > 0 {
            self.simulate();
        }
    }

    /// [Z11-16]: the legal action maximising `Q + cpuct · P · √Nₜ / (1 + N)`,
    /// an unvisited action's `Q` taken as `V − fpu`. Strictly greatest, so ties
    /// go to the lowest action.
    fn select(&self, node: u32) -> usize {
        let n = &self.nodes[node as usize];
        let sqrt_total = f64::from(n.visits).sqrt();
        let cpuct = f64::from(self.config.cpuct);
        let unvisited = f64::from(n.value) - f64::from(self.config.fpu);
        let mut best = f64::NEG_INFINITY;
        let mut chosen = n.edges.start;
        for i in n.edges.clone() {
            let e = &self.edges[i];
            let q = if e.visits == 0 { unvisited } else { e.total / f64::from(e.visits) };
            let u = q + cpuct * f64::from(e.prior) * sqrt_total / (1.0 + f64::from(e.visits));
            if u > best {
                best = u;
                chosen = i;
            }
        }
        chosen
    }

    /// One simulation: down to a leaf, then either its value backed up, or a
    /// pause on the network with the path kept for when the value comes.
    fn simulate(&mut self) {
        self.path.clear();
        let mut node = 0u32;
        loop {
            let e = self.select(node);
            self.path.push((node, e));
            let child = self.edges[e].child;
            if child == NONE {
                return self.descend_new(node, e);
            }
            let n = &self.nodes[child as usize];
            if n.kind != Kind::Expanded {
                return self.backup(n.value, n.seat);
            }
            node = child;
        }
    }

    /// A new child of `parent` by edge `e`: terminal ones are valued and backed
    /// up here; boundary and expanded ones pause on the network ([Z11-14]).
    fn descend_new(&mut self, parent: u32, e: usize) {
        let before = &self.nodes[parent as usize].state;
        let mut state = before.clone();
        // The action came from `legal_actions`, so this cannot fail; if it
        // somehow did, the unchanged clone is valued as a leaf of its own.
        let applied = state.apply(self.edges[e].action).is_ok();
        if applied && !state.is_terminal() {
            if !is_boundary(before, &state) {
                self.pending = Some(Self::expansion(Wait::Expand(e), state));
            } else {
                // Valued from the seat that opens the next round, on the view
                // before the deal: nothing below reads a dealt tile ([Z11-15]).
                let observation = pre_deal_view(before, &state);
                self.pending = Some(Pending { wait: Wait::Boundary(e), state, observation, legal: None });
            }
            return;
        }
        let seat = state.current_player();
        self.stats.terminals += 1;
        let value = terminal_value(state.outcome(), seat);
        let c = self.push(Node { state, seat, kind: Kind::Terminal, value, visits: 0, edges: 0..0 });
        self.settle(e, c);
    }

    /// [Z11-17]: negate exactly where the seat to move changes, never by ply
    /// parity — a boundary ply can leave the same seat to move. Ends the
    /// simulation.
    fn backup(&mut self, mut value: f32, mut seat: Player) {
        for &(node, e) in self.path.iter().rev() {
            let n = &mut self.nodes[node as usize];
            if n.seat != seat {
                value = -value;
                seat = n.seat;
            }
            n.visits += 1;
            let edge = &mut self.edges[e];
            edge.visits += 1;
            edge.total += f64::from(value);
        }
        self.remaining -= 1;
    }

    /// The root's visits and backed-up value, and the tree's shape. Read once
    /// `wants` is `None`.
    pub fn finish(self) -> (SearchResult, TreeStats) {
        debug_assert!(self.pending.is_none() && self.remaining == 0, "a search read before it finished");
        let mut visits = [0u32; ACTION_SPACE];
        let mut total = 0f64;
        let mut count = 0u32;
        let root = &self.nodes[0];
        let mut action = self.edges[root.edges.start].action;
        let mut most = 0u32;
        for e in &self.edges[root.edges.clone()] {
            visits[usize::from(e.action)] = e.visits;
            total += e.total;
            count += e.visits;
            if e.visits > most {
                most = e.visits;
                action = e.action;
            }
        }
        let value = if count == 0 { root.value } else { (total / f64::from(count)) as f32 };
        (SearchResult { action, visits, value }, self.stats)
    }
}

/// A finished search: the root's visits and backed-up value, and the tree's
/// shape. `None` for a terminal root.
pub fn search<S: Shuffler, E: Evaluator>(
    net: &E,
    root: &AzulState<S>,
    config: &SearchConfig,
    noise: Option<(&SelfPlayNoise, &mut Rng)>,
) -> Option<(SearchResult, TreeStats)> {
    // [Z11-62]: a terminal root asks for nothing.
    let mut search = Search::new(root, config, noise)?;
    let mut eval = Evaluation::default();
    while let Some((observation, legal)) = search.wants() {
        net.evaluate(observation, legal, &mut eval);
        search.supply(&eval);
    }
    Some(search.finish())
}

/// The player's move ([Z11-19]): an empty tree, no noise, the most-visited
/// action. `None` for a terminal root, which has no legal action ([Z11-62]).
pub fn choose<S: Shuffler, E: Evaluator>(net: &E, root: &AzulState<S>, config: &SearchConfig) -> Option<SearchResult> {
    search(net, root, config, None).map(|(r, _)| r)
}
