//! The PUCT search ([Z11-14] through [Z11-21]).
//!
//! Each expanded node holds, per legal action, a prior, a visit count and a
//! value sum from the perspective of the seat to move there, and its own
//! network value from when it was expanded. Terminal and boundary nodes are
//! leaves for good: valued once, on their first visit, and never expanded.
//!
//! Laid out for memory, which a long search fills: an action's visit count and
//! value sum are kept on the child it leads to, since an action not yet taken
//! has neither, and a node keeps no state, which a simulation replays from the
//! root instead. Neither changes what is computed, or in what order.

use azul_engine::{ACTION_SPACE, Action, ActionList, AzulState, ENCODED_SIZE, Outcome, Player, Shuffler};

use crate::improved::{
    Transform, completed_q, completed_q_into, considered_pick, considered_visits, improved_policy, improved_policy_into,
    interior_pick, weights,
};
use crate::network::{Evaluation, Evaluator, Request};
use crate::rng::Rng;
use crate::view::{accounts_for, is_boundary, pre_deal_view};

#[derive(Clone, Debug, PartialEq)]
pub struct SearchConfig {
    pub simulations: u32,
    pub cpuct: f32,
    pub fpu: f32,
    /// [Z11-76]: the endgame proof's node cap, applied by `choose` after the
    /// search; 0 is off. The search itself never reads it.
    pub endgame_nodes: u32,
}

/// [Z11-88]: a Gumbel search's settings: how many root actions sequential
/// halving starts from, the scale of the Gumbel draw (1 in self-play; 0 is
/// deterministic), and the completed-Q transform of [Z11-86].
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct GumbelConfig {
    pub considered: u32,
    pub scale: f64,
    pub transform: Transform,
}

/// What a Gumbel search keeps of its root: the draw, one per legal action in
/// the root's order, and the halving table, set once the root is expanded.
struct GumbelRoot {
    config: GumbelConfig,
    gumbel: Vec<f64>,
    table: Vec<u32>,
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

/// The root's legal actions and what [Z11-86] reads of each (`Search::root_statistics`).
#[derive(Clone, Debug, PartialEq)]
pub struct RootStatistics {
    pub actions: Vec<Action>,
    pub priors: Vec<f32>,
    pub visits: Vec<u32>,
    pub q: Vec<f64>,
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

/// A boundary leaf of a search's tree (`Search::boundary_leaves`).
#[derive(Clone, Debug)]
pub struct BoundaryLeaf<S: Shuffler> {
    /// The state the boundary ply was played from.
    pub before: AzulState<S>,
    pub action: Action,
    /// The visits of the edge into the leaf.
    pub taken: u32,
    /// Its stored value, from the seat that opens the next round.
    pub value: f32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Kind {
    Expanded,
    Terminal,
    Boundary,
}

/// Every node's edges, one array a field, a node's at its `edges()`. Most
/// edges are never taken, so an edge holds only what it has before it is: its
/// visits and backed-up values are its child's (`Node::taken`, `Node::total`),
/// and an edge without a child has neither.
///
/// The arrays come in chunks of `CHUNK` edges that are never moved or grown,
/// and a node's edges never straddle two: a vector that doubles holds up to
/// twice what it needs, and copies itself to grow, both at the largest size a
/// search reaches.
#[derive(Default)]
struct Edges {
    chunks: Vec<Chunk>,
    /// The index the next node's edges would start at, in the last chunk.
    len: usize,
}

const CHUNK: usize = 1 << 16;

struct Chunk {
    action: Box<[Action]>,
    prior: Box<[f32]>,
    child: Box<[u32]>,
}

impl Edges {
    /// A node's edges, one for each of `legal` with its prior from `policy`,
    /// unexpanded; the index of the first.
    fn push(&mut self, legal: &[Action], policy: &[f32; ACTION_SPACE]) -> usize {
        // The next free edge is always in the last chunk: a new one when the
        // edges would cross its end, or start at it.
        if self.len + legal.len().max(1) > self.chunks.len() * CHUNK {
            self.len = self.chunks.len() * CHUNK;
            self.chunks.push(Chunk {
                action: vec![0; CHUNK].into_boxed_slice(),
                prior: vec![0.0; CHUNK].into_boxed_slice(),
                child: vec![NONE; CHUNK].into_boxed_slice(),
            });
        }
        let start = self.len;
        let c = &mut self.chunks[start / CHUNK];
        let at = start % CHUNK;
        c.action[at..at + legal.len()].copy_from_slice(legal);
        for (p, &a) in c.prior[at..].iter_mut().zip(legal) {
            *p = policy[usize::from(a)];
        }
        self.len += legal.len();
        start
    }

    /// The node's edges from `start` on: their actions, priors and children.
    fn of(&self, start: usize, len: usize) -> (&[Action], &[f32], &[u32]) {
        let c = &self.chunks[start / CHUNK];
        let at = start % CHUNK;
        (&c.action[at..at + len], &c.prior[at..at + len], &c.child[at..at + len])
    }

    fn action(&self, e: usize) -> Action {
        self.chunks[e / CHUNK].action[e % CHUNK]
    }

    fn prior_mut(&mut self, e: usize) -> &mut f32 {
        &mut self.chunks[e / CHUNK].prior[e % CHUNK]
    }

    fn child(&self, e: usize) -> u32 {
        self.chunks[e / CHUNK].child[e % CHUNK]
    }

    fn set_child(&mut self, e: usize, c: u32) {
        self.chunks[e / CHUNK].child[e % CHUNK] = c;
    }
}

const NONE: u32 = u32::MAX;

/// A node holds no state: every expanded node is in the root's round, where
/// nothing is drawn, so its state is the root's with the path's actions
/// replayed, which each simulation does on its way down (`trail`).
struct Node {
    seat: Player,
    kind: Kind,
    /// The network's value for an expanded node; the leaf value for a terminal
    /// or boundary one. From `seat`'s perspective.
    value: f32,
    /// Simulations that went on below it.
    visits: u32,
    /// The visits of the edge into it: one more than `visits` for an expanded
    /// node, the leaf's first, and every visit for a terminal or boundary one.
    taken: u32,
    /// Sum of the values backed up through the edge into it, from the parent's
    /// seat to move.
    total: f64,
    edges_start: usize,
    edges_len: u8,
}

impl Node {
    fn leaf(seat: Player, kind: Kind, value: f32) -> Node {
        Node { seat, kind, value, visits: 0, taken: 0, total: 0.0, edges_start: 0, edges_len: 0 }
    }

    fn edges(&self) -> std::ops::Range<usize> {
        self.edges_start..self.edges_start + usize::from(self.edges_len)
    }
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
    /// The states of the last path down: `trail[d]` is the state at depth `d`,
    /// the root's first, and `trail[d + 1]` the child by edge `steps[d]`. An
    /// edge has one child, so a simulation that takes the same edge from depth
    /// `d` finds that child's state here, and replays only past where its path
    /// leaves the last one.
    trail: Vec<AzulState<S>>,
    steps: Vec<usize>,
    nodes: Vec<Node>,
    edges: Edges,
    stats: TreeStats,
    path: Vec<(u32, usize)>,
    /// Simulations still to run, the one paused included.
    remaining: u32,
    pending: Option<Pending<S>>,
    /// `ε` and the root's Dirichlet draw, mixed in once the root is expanded.
    noise: Option<(f64, Vec<f64>)>,
    /// The root's priors as the network gave them, before any noise: what the
    /// improved policy is built from ([Z11-86]), which must not learn the noise.
    root_priors: Vec<f32>,
    /// [Z11-88]: set for a Gumbel search, which selects by it instead of PUCT.
    gumbel: Option<GumbelRoot>,
    /// A Gumbel step's working space, reused so a step allocates nothing.
    scratch: std::cell::RefCell<Scratch>,
}

#[derive(Default)]
struct Scratch {
    visits: Vec<u32>,
    q: Vec<f64>,
    values: Vec<f64>,
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
            trail: vec![root.clone()],
            steps: Vec::new(),
            nodes: Vec::new(),
            edges: Edges::default(),
            stats: TreeStats::default(),
            path: Vec::new(),
            remaining: config.simulations,
            pending,
            noise,
            root_priors: Vec::new(),
            gumbel: None,
            scratch: Default::default(),
        })
    }

    /// [Z11-88]: a Gumbel search of `root`, paused on the root's expansion.
    /// `None` for a terminal root. The draw is the first thing it takes from
    /// `rng`, one `U` per legal action on the open interval (0, 1), and is
    /// taken whatever the scale, so the generator's order does not depend on
    /// it. No noise: the draw is the exploration.
    pub fn gumbel(root: &AzulState<S>, config: &SearchConfig, gumbel: &GumbelConfig, rng: &mut Rng) -> Option<Self> {
        let mut search = Self::new(root, config, None)?;
        let n = root.legal_actions().len();
        let draw = (0..n)
            .map(|_| {
                let mut u = rng.uniform();
                while u <= 0.0 {
                    u = rng.uniform();
                }
                gumbel.scale * -(-u.ln()).ln()
            })
            .collect();
        search.gumbel = Some(GumbelRoot { config: *gumbel, gumbel: draw, table: Vec::new() });
        Some(search)
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
        self.supply_until(eval, &mut || false);
    }

    /// [Z11-78]: `supply`, asking `stop` after each whole simulation it runs
    /// on from here whether to start another. Simulations that end at a leaf
    /// already valued never reach the network, so without this a search
    /// could run to its ceiling without its caller being asked.
    pub fn supply_until(&mut self, eval: &Evaluation, stop: &mut dyn FnMut() -> bool) {
        // [Z11-78]: a Gumbel search's halving is planned for its whole budget,
        // so it is never stopped: it asks no one.
        let gumbel = self.gumbel.is_some();
        let stop = &mut || !gumbel && stop();
        let Some(p) = self.pending.take() else { return };
        match p.wait {
            Wait::Root => {
                self.push_expanded(p.state.current_player(), p.legal.as_ref(), eval);
                let (_, priors, _) = self.edges.of(self.nodes[0].edges_start, usize::from(self.nodes[0].edges_len));
                self.root_priors = priors.to_vec();
                if let Some(g) = self.gumbel.as_mut() {
                    let m = (g.config.considered as usize).min(self.root_priors.len());
                    g.table = considered_visits(m, self.config.simulations as usize);
                }
                if let Some((eps, dir)) = self.noise.take() {
                    for (i, d) in self.nodes[0].edges().zip(dir) {
                        let prior = self.edges.prior_mut(i);
                        *prior = ((1.0 - eps) * f64::from(*prior) + eps * d) as f32;
                    }
                }
            }
            Wait::Expand(e) => {
                let c = self.push_expanded(p.state.current_player(), p.legal.as_ref(), eval);
                self.settle(e, c);
            }
            Wait::Boundary(e) => {
                let seat = p.state.current_player();
                self.stats.boundaries += 1;
                let c = self.push(Node::leaf(seat, Kind::Boundary, eval.value));
                self.settle(e, c);
            }
        }
        self.run(stop);
    }

    /// An expanded node: the evaluation's policy over the legal set becomes
    /// its priors, its value the node's `V`.
    fn push_expanded(&mut self, seat: Player, legal: Option<&ActionList>, eval: &Evaluation) -> u32 {
        let legal = legal.map_or(&[][..], ActionList::as_slice);
        let edges_start = self.edges.push(legal, &eval.policy);
        self.stats.expanded += 1;
        // At most every action: it fits.
        let edges_len = legal.len() as u8;
        self.push(Node { edges_start, edges_len, ..Node::leaf(seat, Kind::Expanded, eval.value) })
    }

    fn push(&mut self, node: Node) -> u32 {
        self.nodes.push(node);
        (self.nodes.len() - 1) as u32
    }

    /// The new child `c` hangs below edge `e`; its value is the simulation's.
    fn settle(&mut self, e: usize, c: u32) {
        self.edges.set_child(e, c);
        let n = &self.nodes[c as usize];
        self.backup(n.value, n.seat);
    }

    /// Simulations until one needs the network or none remain.
    fn run(&mut self, stop: &mut dyn FnMut() -> bool) {
        while self.pending.is_none() && self.remaining > 0 {
            self.simulate();
            if self.pending.is_none() && self.remaining > 0 && stop() {
                self.remaining = 0;
            }
        }
    }

    /// [Z11-16]: the legal action maximising `Q + cpuct · P · √Nₜ / (1 + N)`,
    /// an unvisited action's `Q` taken as `V − fpu`. Strictly greatest, so ties
    /// go to the lowest action.
    fn select(&self, node: u32) -> usize {
        if let Some(g) = &self.gumbel {
            return self.select_gumbel(g, node);
        }
        let n = &self.nodes[node as usize];
        let sqrt_total = f64::from(n.visits).sqrt();
        let cpuct = f64::from(self.config.cpuct);
        let unvisited = f64::from(n.value) - f64::from(self.config.fpu);
        let mut best = f64::NEG_INFINITY;
        let (_, priors, children) = self.edges.of(n.edges_start, usize::from(n.edges_len));
        let mut chosen = 0;
        for (i, (&prior, &child)) in priors.iter().zip(children).enumerate() {
            let (q, visits) = match child {
                NONE => (unvisited, 0),
                c => {
                    let c = &self.nodes[c as usize];
                    (c.total / f64::from(c.taken), c.taken)
                }
            };
            let u = q + cpuct * f64::from(prior) * sqrt_total / (1.0 + f64::from(visits));
            if u > best {
                best = u;
                chosen = i;
            }
        }
        n.edges_start + chosen
    }

    /// Each edge of `node`'s visits and backed-up value from its seat, 0 where
    /// unvisited.
    fn child_statistics(&self, node: u32) -> (Vec<u32>, Vec<f64>) {
        let (mut visits, mut q) = (Vec::new(), Vec::new());
        self.child_statistics_into(node, &mut visits, &mut q);
        (visits, q)
    }

    /// `child_statistics` into vectors it clears first.
    fn child_statistics_into(&self, node: u32, visits: &mut Vec<u32>, q: &mut Vec<f64>) {
        let n = &self.nodes[node as usize];
        let (_, _, children) = self.edges.of(n.edges_start, usize::from(n.edges_len));
        visits.clear();
        q.clear();
        for &c in children {
            match c {
                NONE => {
                    visits.push(0);
                    q.push(0.0);
                }
                c => {
                    let c = &self.nodes[c as usize];
                    visits.push(c.taken);
                    q.push(c.total / f64::from(c.taken));
                }
            }
        }
    }

    /// [Z11-88]: at the root, the simulation numbered by the root's visits
    /// goes to the best-scoring action of those with the visits the halving
    /// table names; below it, mctx's deterministic interior pick on the node's
    /// own improved policy.
    fn select_gumbel(&self, g: &GumbelRoot, node: u32) -> usize {
        let n = &self.nodes[node as usize];
        let mut scratch = self.scratch.borrow_mut();
        let Scratch { visits, q, values } = &mut *scratch;
        self.child_statistics_into(node, visits, q);
        let (visits, q) = (&visits[..], &q[..]);
        let (_, priors, _) = self.edges.of(n.edges_start, usize::from(n.edges_len));
        let t = &g.config.transform;
        let chosen = if node == 0 {
            completed_q_into(&self.root_priors, visits, q, n.value, t, values);
            let completed = &values[..];
            let k = n.visits as usize;
            // Each simulation adds one root visit, so k is always inside the
            // table. Each halving phase leaves enough actions at the count it
            // names, so the fallback is never taken; were it, a debug build
            // says so, and a release one, which may not panic ([Z11-22]),
            // takes the best by value.
            let pick = considered_pick(g.table[k], &g.gumbel, &self.root_priors, completed, visits);
            debug_assert!(pick.is_some(), "no root action has the visits the halving table names");
            pick.or_else(|| (0..visits.len()).max_by(|&a, &b| completed[a].total_cmp(&completed[b]).then(b.cmp(&a))))
                .unwrap_or(0)
        } else {
            improved_policy_into(priors, visits, q, n.value, t, values);
            interior_pick(values, visits)
        };
        n.edges_start + chosen
    }

    /// One simulation: down to a leaf, then either its value backed up, or a
    /// pause on the network with the path kept for when the value comes.
    fn simulate(&mut self) {
        self.path.clear();
        let mut node = 0u32;
        loop {
            let e = self.select(node);
            self.path.push((node, e));
            let child = self.edges.child(e);
            let depth = self.path.len() - 1;
            if child == NONE {
                return self.descend_new(depth, e);
            }
            let n = &self.nodes[child as usize];
            if n.kind != Kind::Expanded {
                return self.backup(n.value, n.seat);
            }
            if self.steps.get(depth) != Some(&e) {
                let mut state = self.trail[depth].clone();
                // It applied when the child was made, and replays the same.
                let _ = state.apply(self.edges.action(e));
                self.steps.truncate(depth);
                self.steps.push(e);
                self.trail.truncate(depth + 1);
                self.trail.push(state);
            }
            node = child;
        }
    }

    /// A new child by edge `e` of the node at `depth` on the path: terminal
    /// ones are valued and backed up here; boundary and expanded ones pause on
    /// the network ([Z11-14]).
    fn descend_new(&mut self, depth: usize, e: usize) {
        let before = &self.trail[depth];
        let mut state = before.clone();
        // The action came from `legal_actions`, so this cannot fail; if it
        // somehow did, the unchanged clone is valued as a leaf of its own.
        let applied = state.apply(self.edges.action(e)).is_ok();
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
        let c = self.push(Node::leaf(seat, Kind::Terminal, value));
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
            let child = &mut self.nodes[self.edges.child(e) as usize];
            child.taken += 1;
            child.total += f64::from(value);
        }
        self.remaining -= 1;
    }

    /// [Z11-78]: no simulation starts after the one in flight, or after the
    /// first when the search is still paused on its root. The search then
    /// finishes as one configured for the simulations it has run would: none
    /// of its choices depend on how many remain, so the result is that
    /// search's, bit for bit. Reads no clock; the caller decides when.
    /// A Gumbel search ignores it: its halving is planned for its whole
    /// budget, so it runs on, and this answers `false`; `true` for a PUCT search.
    pub fn stop(&mut self) -> bool {
        if self.gumbel.is_some() {
            return false;
        }
        if self.pending.is_some() {
            self.remaining = self.remaining.min(1);
        }
        true
    }

    /// What the improved policy at the root is built from ([Z11-86]): per legal
    /// action, in the root's order, the action, its clean prior (the network's,
    /// before any noise), its visits, and its backed-up value from the root's
    /// seat (0 where unvisited); and the root's own network value.
    pub fn root_statistics(&self) -> RootStatistics {
        let root = &self.nodes[0];
        let (actions, _, children) = self.edges.of(root.edges_start, usize::from(root.edges_len));
        let mut visits = Vec::with_capacity(actions.len());
        let mut q = Vec::with_capacity(actions.len());
        for &child in children {
            match child {
                NONE => {
                    visits.push(0);
                    q.push(0.0);
                }
                c => {
                    let c = &self.nodes[c as usize];
                    visits.push(c.taken);
                    q.push(c.total / f64::from(c.taken));
                }
            }
        }
        RootStatistics { actions: actions.to_vec(), priors: self.root_priors.clone(), visits, q, value: root.value }
    }

    /// Every boundary leaf of the tree, by a walk from the root that replays
    /// each edge's action, as `trail` does: the state the boundary ply was
    /// played from, the ply, the edge's visits and the leaf's stored value
    /// (from the seat that opens the next round). In the tree's edge order.
    /// Reads the tree and changes nothing.
    pub fn boundary_leaves(&self) -> Vec<BoundaryLeaf<S>> {
        let mut out = Vec::new();
        if self.nodes.is_empty() {
            return out;
        }
        let mut stack = vec![(0u32, self.trail[0].clone())];
        while let Some((node, state)) = stack.pop() {
            let n = &self.nodes[node as usize];
            let (actions, _, children) = self.edges.of(n.edges_start, usize::from(n.edges_len));
            for (&action, &child) in actions.iter().zip(children) {
                if child == NONE {
                    continue;
                }
                let c = &self.nodes[child as usize];
                match c.kind {
                    Kind::Boundary => {
                        out.push(BoundaryLeaf { before: state.clone(), action, taken: c.taken, value: c.value })
                    }
                    Kind::Expanded => {
                        let mut next = state.clone();
                        // It applied when the child was made, and replays the same.
                        let _ = next.apply(action);
                        stack.push((child, next));
                    }
                    Kind::Terminal => {}
                }
            }
        }
        out
    }

    /// Simulations run so far: the root's visits.
    pub fn simulations_run(&self) -> u32 {
        self.nodes.first().map_or(0, |n| n.visits)
    }

    /// The tree's shape so far.
    pub fn stats(&self) -> TreeStats {
        self.stats
    }

    /// [Z11-88]: a Gumbel search's draw, one per legal action in the root's
    /// order; `None` for PUCT.
    pub fn gumbel_draw(&self) -> Option<&[f64]> {
        self.gumbel.as_ref().map(|g| &g.gumbel[..])
    }

    /// [Z11-86]: the improved policy at the root, as a sample's weights over
    /// the action space ([Z11-27]), zero off the legal set. Read once `wants`
    /// is `None`.
    pub fn improved(&self, t: &Transform) -> [u16; ACTION_SPACE] {
        debug_assert!(self.pending.is_none() && self.remaining == 0, "a search read before it finished");
        let r = self.root_statistics();
        let policy = improved_policy(&r.priors, &r.visits, &r.q, r.value, t);
        let mut out = [0u16; ACTION_SPACE];
        for (&a, w) in r.actions.iter().zip(weights(&policy)) {
            out[usize::from(a)] = w;
        }
        out
    }

    /// The root's visits and backed-up value, and the tree's shape. Read once
    /// `wants` is `None`.
    pub fn finish(self) -> (SearchResult, TreeStats) {
        debug_assert!(self.pending.is_none() && self.remaining == 0, "a search read before it finished");
        let mut visits = [0u32; ACTION_SPACE];
        let mut total = 0f64;
        let mut count = 0u32;
        let root = &self.nodes[0];
        let (actions, _, children) = self.edges.of(root.edges_start, usize::from(root.edges_len));
        let mut action = actions[0];
        let mut most = 0u32;
        for (&a, &child) in actions.iter().zip(children) {
            let (taken, sum) = match child {
                NONE => (0, 0.0),
                c => (self.nodes[c as usize].taken, self.nodes[c as usize].total),
            };
            visits[usize::from(a)] = taken;
            total += sum;
            count += taken;
            if taken > most {
                most = taken;
                action = a;
            }
        }
        let value = if count == 0 { root.value } else { (total / f64::from(count)) as f32 };
        // [Z11-88]: a Gumbel search plays the best-scoring of its most-visited
        // actions.
        if let Some(g) = &self.gumbel {
            let (v, q) = self.child_statistics(0);
            let completed = completed_q(&self.root_priors, &v, &q, root.value, &g.config.transform);
            if let Some(i) = considered_pick(most, &g.gumbel, &self.root_priors, &completed, &v) {
                action = actions[i];
            }
        }
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
    search_until(net, root, config, noise, &mut || false)
}

/// [Z11-78]: `search`, asking `stop` before each evaluator call whether to
/// stop after the simulation in flight, and after each whole simulation
/// whether to start another. `config.simulations` is the ceiling.
pub fn search_until<S: Shuffler, E: Evaluator>(
    net: &E,
    root: &AzulState<S>,
    config: &SearchConfig,
    noise: Option<(&SelfPlayNoise, &mut Rng)>,
    stop: &mut dyn FnMut() -> bool,
) -> Option<(SearchResult, TreeStats)> {
    // [Z11-62]: a terminal root asks for nothing.
    let mut search = Search::new(root, config, noise)?;
    let mut eval = Evaluation::default();
    let mut stopped = false;
    while let Some((observation, legal)) = search.wants() {
        net.evaluate(observation, legal, &mut eval);
        if !stopped && stop() {
            stopped = true;
            search.stop();
        }
        if stopped {
            search.supply(&eval);
        } else {
            search.supply_until(&eval, stop);
        }
    }
    Some(search.finish())
}

/// The player's move ([Z11-19]): an empty tree, no noise, the most-visited
/// action, then [Z11-76]'s endgame proof when `endgame_nodes` is set. `None`
/// for a terminal root, which has no legal action ([Z11-62]).
pub fn choose<S: Shuffler, E: Evaluator>(net: &E, root: &AzulState<S>, config: &SearchConfig) -> Option<SearchResult> {
    let (r, _) = search(net, root, config, None)?;
    Some(crate::endgame::refine(root, r, config.endgame_nodes).0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::DEFAULT_TRANSFORM;
    use crate::network::Network;
    use azul_engine::Seeded;

    /// [Z11-88]: every expanded node below the root of a finished Gumbel
    /// search picks mctx's interior action on its own improved policy, its
    /// statistics read here straight from the tree: its edges' priors, each
    /// child's `taken` and `total / taken`, and its own network value.
    ///
    /// Mutations, seen red ([Z11-48]): the interior reading the root's priors;
    /// `n.value` negated; `child_statistics` reading the child's own value.
    #[test]
    fn the_interior_picks_on_its_own_statistics() {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("test/fixtures");
        let net = Network::load(&std::fs::read(dir.join("checkpoint.bin")).unwrap(), &std::fs::read(dir.join("checkpoint.parity")).unwrap()).unwrap();
        let g = GumbelConfig { considered: 16, scale: 1.0, transform: DEFAULT_TRANSFORM };
        let config = SearchConfig { simulations: 300, cpuct: 1.25, fpu: 0.25, endgame_nodes: 0 };
        let mut checked = 0;
        for seed in 0..6 {
            let state = AzulState::<Seeded>::seeded(seed);
            let mut rng = Rng::new(seed);
            let mut search = Search::gumbel(&state, &config, &g, &mut rng).unwrap();
            let mut e = Evaluation::default();
            while let Some((o, l)) = search.wants() {
                net.evaluate(o, l, &mut e);
                search.supply(&e);
            }
            for node in 1..search.nodes.len() as u32 {
                let n = &search.nodes[node as usize];
                if n.kind != Kind::Expanded || n.visits == 0 {
                    continue;
                }
                let (_, priors, children) = search.edges.of(n.edges_start, usize::from(n.edges_len));
                let (mut visits, mut q) = (Vec::new(), Vec::new());
                for &c in children {
                    if c == NONE {
                        visits.push(0);
                        q.push(0.0);
                    } else {
                        let c = &search.nodes[c as usize];
                        visits.push(c.taken);
                        q.push(c.total / f64::from(c.taken));
                    }
                }
                let want = interior_pick(&improved_policy(priors, &visits, &q, n.value, &DEFAULT_TRANSFORM), &visits);
                assert_eq!(search.select(node), n.edges_start + want, "seed {seed} node {node}");
                checked += 1;
            }
        }
        assert!(checked > 100, "{checked} interior nodes");
    }
}
