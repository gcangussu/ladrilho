//! [Z11-86]: the improved policy of Danihelka et al. (ICLR 2022), `softmax(logit
//! + σ(completedQ))` over a node's legal set, as mctx computes it
//! (`qtransform_completed_by_mix_value` and `gumbel_muzero_policy`'s
//! `action_weights`), and the deterministic interior pick that tracks a policy.
//! `test/fixtures/improved.json` holds both to mctx's own numbers.
//!
//! Everything is from the seat to move at the node: a child's Q is its backed-up
//! total over its visits, which [Z11-17] keeps from the parent's seat, never the
//! child's own network value, which is from the child's.

/// The completed-Q transform's two constants ([Z11-87]); mctx's defaults are
/// `c_visit = 50` (its `maxvisit_init`) and `c_scale = 0.1` (its `value_scale`).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Transform {
    pub c_visit: f64,
    pub c_scale: f64,
}

/// A clean prior, kept off zero so its logarithm and its weight in the mixed
/// value stay finite. mctx floors the prior at this value in its mixed value;
/// the floor under the logarithm is ours (mctx's logits are never zero
/// probabilities), and the fixture builds its logits the same way. A real f32
/// prior that underflowed to zero would take −708 here where its logit is
/// about −103 or lower: that matters only once σ exceeds about 100, a max N
/// above about 950.
fn floor(p: f64) -> f64 {
    p.max(f64::MIN_POSITIVE)
}

/// `σ(completedQ)` for each legal action. `prior` is the network's clean policy
/// over the legal set, `visits` and `q` each action's, `q` read only where
/// `visits` is not zero, and `value` the node's own network value.
///
/// An unvisited action takes the mixed value `v_mix`. mctx completes every
/// action of the space, the illegal ones included, before rescaling to [0, 1]
/// by the completed vector's minimum and maximum; Azul's space always has an
/// illegal action, so `v_mix` is always inside that range, which is what the
/// rescale here does over the legal set alone.
pub fn completed_q(prior: &[f32], visits: &[u32], q: &[f64], value: f32, t: &Transform) -> Vec<f64> {
    let mut out = Vec::with_capacity(prior.len());
    completed_q_into(prior, visits, q, value, t, &mut out);
    out
}

/// `completed_q` into `out`, which it clears first: the same numbers, without
/// an allocation once `out` has grown, for a search that asks once a step.
pub fn completed_q_into(prior: &[f32], visits: &[u32], q: &[f64], value: f32, t: &Transform, out: &mut Vec<f64>) {
    debug_assert!(prior.len() == visits.len() && prior.len() == q.len());
    debug_assert!(prior.len() < azul_engine::ACTION_SPACE, "a legal set the size of the space");
    let total: f64 = visits.iter().map(|&n| f64::from(n)).sum();
    let mut visited_prior = 0.0;
    for (&p, &n) in prior.iter().zip(visits) {
        if n > 0 {
            visited_prior += floor(f64::from(p));
        }
    }
    let mut weighted = 0.0;
    for ((&p, &n), &q) in prior.iter().zip(visits).zip(q) {
        if n > 0 {
            weighted += floor(f64::from(p)) * q / visited_prior;
        }
    }
    let mixed = (f64::from(value) + total * weighted) / (total + 1.0);
    out.clear();
    out.extend(visits.iter().zip(q).map(|(&n, &q)| if n > 0 { q } else { mixed }));
    let (lo, hi) = out.iter().fold((mixed, mixed), |(lo, hi), &c| (lo.min(c), hi.max(c)));
    let range = (hi - lo).max(1e-8);
    let most = visits.iter().copied().max().unwrap_or(0);
    let scale = (t.c_visit + f64::from(most)) * t.c_scale;
    for c in out.iter_mut() {
        *c = (*c - lo) / range * scale;
    }
}

/// The improved policy over the legal set, in its order: `softmax(ln p +
/// σ(completedQ))`. No Gumbel draw is in it.
pub fn improved_policy(prior: &[f32], visits: &[u32], q: &[f64], value: f32, t: &Transform) -> Vec<f64> {
    let mut out = Vec::with_capacity(prior.len());
    improved_policy_into(prior, visits, q, value, t, &mut out);
    out
}

/// `improved_policy` into `out`, which it clears first, step for step the
/// same arithmetic.
pub fn improved_policy_into(prior: &[f32], visits: &[u32], q: &[f64], value: f32, t: &Transform, out: &mut Vec<f64>) {
    completed_q_into(prior, visits, q, value, t, out);
    for (z, &p) in out.iter_mut().zip(prior) {
        *z += floor(f64::from(p)).ln();
    }
    let top = out.iter().copied().fold(f64::NEG_INFINITY, f64::max);
    for z in out.iter_mut() {
        *z = (*z - top).exp();
    }
    let sum: f64 = out.iter().sum();
    for e in out.iter_mut() {
        *e /= sum;
    }
}

/// mctx's interior selection: the action maximising `π(a) − N(a) / (1 + ΣN)`,
/// ties to the lowest index, so that repeated picks keep visit frequencies
/// close to `π`.
pub fn interior_pick(policy: &[f64], visits: &[u32]) -> usize {
    let total: f64 = visits.iter().map(|&n| f64::from(n)).sum();
    let mut best = f64::NEG_INFINITY;
    let mut chosen = 0;
    for (i, (&p, &n)) in policy.iter().zip(visits).enumerate() {
        let s = p - f64::from(n) / (1.0 + total);
        if s > best {
            best = s;
            chosen = i;
        }
    }
    chosen
}

/// A policy over the legal set as a sample's weights ([Z11-27]): each
/// probability times 65 535, rounded, so the weights sum to 65 535 give or
/// take one per legal action.
pub fn weights(policy: &[f64]) -> impl Iterator<Item = u16> + '_ {
    policy.iter().map(|&p| (p * f64::from(u16::MAX)).round().clamp(0.0, f64::from(u16::MAX)) as u16)
}

/// [Z11-88]: mctx's `get_sequence_of_considered_visits(m, n)`: for each of a
/// root's `n` simulations, the visit count an action must have to be
/// considered by that simulation. Sequential halving as a table: `m` actions
/// share the first phase, half of them the next, down to two.
pub fn considered_visits(m: usize, n: usize) -> Vec<u32> {
    if m <= 1 {
        return (0..n as u32).collect();
    }
    let log2max = (m as f64).log2().ceil() as usize;
    let mut sequence = Vec::with_capacity(n);
    let mut visits = vec![0u32; m];
    let mut considered = m;
    while sequence.len() < n {
        let extra = (n as f64 / (log2max * considered) as f64) as usize;
        for _ in 0..extra.max(1) {
            sequence.extend_from_slice(&visits[..considered]);
            for v in &mut visits[..considered] {
                *v += 1;
            }
        }
        considered = (considered / 2).max(2);
    }
    sequence.truncate(n);
    sequence
}

/// mctx's `score_considered`: among the actions whose visits equal
/// `considered`, the one maximising `g + logit + σ(completedQ)`, the logits
/// shifted by their maximum and the sum floored at −10⁹ as mctx floors it,
/// ties to the lowest index; `None` if no action has that many visits.
/// `completed` is `completed_q`'s output, already scaled by σ.
pub fn considered_pick(considered: u32, gumbel: &[f64], prior: &[f32], completed: &[f64], visits: &[u32]) -> Option<usize> {
    // The logarithm rises with its argument, so the greatest logit is the
    // logarithm of the greatest prior, bit for bit.
    let top = floor(prior.iter().map(|&p| f64::from(p)).fold(0.0, f64::max)).ln();
    let mut best = f64::NEG_INFINITY;
    let mut chosen = None;
    for i in 0..prior.len() {
        if visits[i] != considered {
            continue;
        }
        let s = (gumbel[i] + floor(f64::from(prior[i])).ln() - top + completed[i]).max(-1e9);
        if s > best {
            best = s;
            chosen = Some(i);
        }
    }
    chosen
}
