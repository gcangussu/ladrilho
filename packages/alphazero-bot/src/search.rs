//! The PUCT search ([Z11-14] through [Z11-21]).
//!
//! Each expanded node holds, per legal action, a prior, a visit count and a
//! value sum from the perspective of the seat to move there, and its own
//! network value from when it was expanded. Terminal and boundary nodes are
//! leaves for good: valued once, on their first visit, and never expanded.

use azul_engine::{ACTION_SPACE, Action, AzulState, Outcome, Player, Shuffler};

use crate::network::{Evaluation, Evaluator};
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

struct Tree<'a, S: Shuffler, E: Evaluator> {
    net: &'a E,
    config: &'a SearchConfig,
    nodes: Vec<Node<S>>,
    edges: Vec<Edge>,
    eval: Evaluation,
    stats: TreeStats,
}

impl<S: Shuffler, E: Evaluator> Tree<'_, S, E> {
    /// Expands `state` into a new node: one network call on its own
    /// observation, whose policy becomes the priors.
    fn expand(&mut self, state: AzulState<S>) -> u32 {
        let legal = state.legal_actions();
        let obs = state.encode();
        debug_assert!(accounts_for(&obs, &state), "an input that does not account for every tile ([Z11-51])");
        self.net.evaluate(&obs, legal.as_slice(), &mut self.eval);
        let start = self.edges.len();
        for &a in legal.as_slice() {
            self.edges.push(Edge {
                action: a,
                prior: self.eval.policy[usize::from(a)],
                visits: 0,
                total: 0.0,
                child: NONE,
            });
        }
        self.stats.expanded += 1;
        let seat = state.current_player();
        self.nodes.push(Node {
            state,
            seat,
            kind: Kind::Expanded,
            value: self.eval.value,
            visits: 0,
            edges: start..self.edges.len(),
        });
        (self.nodes.len() - 1) as u32
    }

    /// A new child of `parent` by `action`: terminal, boundary or expanded.
    /// Terminal and boundary children are valued here, once ([Z11-14]).
    fn child(&mut self, parent: u32, action: Action) -> u32 {
        let (state, applied, view) = {
            let before = &self.nodes[parent as usize].state;
            let mut state = before.clone();
            // The action came from `legal_actions`, so this cannot fail; if it
            // somehow did, the unchanged clone is valued as a leaf of its own.
            let applied = state.apply(action).is_ok();
            if applied && !state.is_terminal() && !is_boundary(before, &state) {
                return self.expand(state);
            }
            // Valued from the seat that opens the next round, on the view
            // before the deal: nothing below reads a dealt tile ([Z11-15]).
            let view = (applied && !state.is_terminal()).then(|| pre_deal_view(before, &state));
            (state, applied, view)
        };
        let seat = state.current_player();
        let (kind, value) = if state.is_terminal() || !applied {
            self.stats.terminals += 1;
            (Kind::Terminal, terminal_value(state.outcome(), seat))
        } else {
            let view = view.unwrap_or_else(|| state.encode());
            self.net.evaluate(&view, &[], &mut self.eval);
            self.stats.boundaries += 1;
            (Kind::Boundary, self.eval.value)
        };
        self.nodes.push(Node { state, seat, kind, value, visits: 0, edges: 0..0 });
        (self.nodes.len() - 1) as u32
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

    fn simulate(&mut self, path: &mut Vec<(u32, usize)>) {
        path.clear();
        let mut node = 0u32;
        let (mut value, mut seat) = loop {
            let e = self.select(node);
            path.push((node, e));
            let child = if self.edges[e].child == NONE {
                let c = self.child(node, self.edges[e].action);
                self.edges[e].child = c;
                let n = &self.nodes[c as usize];
                break (n.value, n.seat);
            } else {
                self.edges[e].child
            };
            let n = &self.nodes[child as usize];
            if n.kind != Kind::Expanded {
                break (n.value, n.seat);
            }
            node = child;
        };
        // [Z11-17]: negate exactly where the seat to move changes, never by
        // ply parity — a boundary ply can leave the same seat to move.
        for &(node, e) in path.iter().rev() {
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
    if root.is_terminal() || root.legal_actions().is_empty() {
        return None; // [Z11-62]: no evaluator call
    }
    let mut tree = Tree {
        net,
        config,
        nodes: Vec::new(),
        edges: Vec::new(),
        eval: Evaluation::default(),
        stats: TreeStats::default(),
    };
    // The root's expansion is not a simulation ([Z11-18]).
    tree.expand(root.clone());
    if let Some((noise, rng)) = noise {
        let edges = tree.nodes[0].edges.clone();
        let mut dir = vec![0f64; edges.len()];
        rng.dirichlet(f64::from(noise.alpha), &mut dir);
        let eps = f64::from(noise.epsilon);
        for (i, d) in edges.zip(dir) {
            let p = &mut tree.edges[i].prior;
            *p = ((1.0 - eps) * f64::from(*p) + eps * d) as f32;
        }
    }
    let mut path = Vec::new();
    for _ in 0..config.simulations {
        tree.simulate(&mut path);
    }

    let mut visits = [0u32; ACTION_SPACE];
    let mut total = 0f64;
    let mut count = 0u32;
    let mut action = tree.edges[tree.nodes[0].edges.start].action;
    let mut most = 0u32;
    for e in &tree.edges[tree.nodes[0].edges.clone()] {
        visits[usize::from(e.action)] = e.visits;
        total += e.total;
        count += e.visits;
        if e.visits > most {
            most = e.visits;
            action = e.action;
        }
    }
    let value = if count == 0 { tree.nodes[0].value } else { (total / f64::from(count)) as f32 };
    Some((SearchResult { action, visits, value }, tree.stats))
}

/// The player's move ([Z11-19]): an empty tree, no noise, the most-visited
/// action. `None` for a terminal root, which has no legal action ([Z11-62]).
pub fn choose<S: Shuffler, E: Evaluator>(net: &E, root: &AzulState<S>, config: &SearchConfig) -> Option<SearchResult> {
    search(net, root, config, None).map(|(r, _)| r)
}
