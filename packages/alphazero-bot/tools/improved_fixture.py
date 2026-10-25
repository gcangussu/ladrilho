"""Records test/fixtures/improved.json from mctx, the reference for [Z11-86].

A deliberate act, like `ai-bot`'s fixtures: run once, commit the output. It needs
a throwaway environment, never the trainer's:

    uv venv -p 3.11 /tmp/mctxenv && uv pip install -p /tmp/mctxenv/bin/python \
        jax==0.4.38 jaxlib==0.4.38 chex 'numpy<2'
    git clone https://github.com/google-deepmind/mctx /tmp/mctx   # 428bfb7e
    /tmp/mctxenv/bin/python tools/improved_fixture.py /tmp/mctx > test/fixtures/improved.json

Nothing of mctx is copied into the crate: the crate is held to these numbers.

Two kinds of case:

- `improved` (modes `mixed`, `low`, `all-visited`, `none-visited`, `equal-q`,
  `zero-prior`): one root, 180 actions of which `legal` are legal, with clean prior
  probabilities, child visits, child Q from the root's seat, and the root's own
  network value. mctx's `qtransform_completed_by_mix_value` (its defaults:
  value_scale 0.1, maxvisit_init 50, rescale on, mixed value on) gives the
  completed Q, and `softmax(prior_logits + completedQ)` over the legal set is the
  improved policy `gumbel_muzero_policy` writes as `action_weights`.
- `interior`: a frozen policy and the sequence of actions mctx's
  `_prepare_argmax_input` + argmax picks from zero visits, one visit added each step.
"""

import json
import sys

import numpy as np

sys.path.insert(0, sys.argv[1])

import jax  # noqa: E402

jax.config.update("jax_enable_x64", True)

import jax.numpy as jnp  # noqa: E402
from mctx._src import action_selection, qtransforms, tree as tree_lib  # noqa: E402

A = 180


def one_tree(prior, legal, visits, q, raw):
    """An unbatched two-node tree whose root holds the case."""
    logits = np.where(legal, np.log(np.maximum(prior, np.finfo(np.float64).tiny)), -np.inf)
    # mctx masks invalid actions by the most negative finite logit.
    logits = np.where(legal, logits, np.finfo(np.float64).min)
    n = 2
    z = lambda *s: jnp.zeros(s, dtype=jnp.float64)  # noqa: E731
    return tree_lib.Tree(
        node_visits=jnp.array([visits.sum() + 1, 0], dtype=jnp.int32),
        raw_values=jnp.array([raw, 0.0]),
        node_values=z(n),
        parents=jnp.array([-1, 0], dtype=jnp.int32),
        action_from_parent=jnp.array([-1, 0], dtype=jnp.int32),
        children_index=jnp.full((n, A), -1, dtype=jnp.int32),
        children_prior_logits=jnp.stack([jnp.array(logits), z(A)]),
        children_visits=jnp.stack([jnp.array(visits, dtype=jnp.int32), jnp.zeros(A, dtype=jnp.int32)]),
        children_rewards=z(n, A),
        children_discounts=jnp.ones((n, A), dtype=jnp.float64),
        children_values=jnp.stack([jnp.array(q), z(A)]),
        embeddings=z(n, 1),
        root_invalid_actions=jnp.array(~legal, dtype=jnp.int32),
        extra_data=None,
    ), logits


def improved(rng, legal_n, mode):
    legal = np.zeros(A, dtype=bool)
    legal[rng.choice(A, legal_n, replace=False)] = True
    prior = np.zeros(A)
    w = np.exp(rng.normal(0, 1.5, legal_n))
    if mode == "zero-prior" and legal_n > 1:
        w[0] = 0.0
    # f32, as the network's policy is: both sides then read the same numbers.
    prior[legal] = (w / w.sum()).astype(np.float32)
    visits = np.zeros(A, dtype=np.int64)
    if mode == "none-visited":
        pass
    elif mode == "low":
        visits[legal] = np.where(rng.random(legal_n) < 0.5, rng.integers(1, 5, legal_n), 0)
    elif mode == "all-visited":
        visits[legal] = rng.integers(1, 60, legal_n)
    else:
        visits[legal] = np.where(rng.random(legal_n) < 0.5, rng.integers(1, 400, legal_n), 0)
    q = np.zeros(A)
    q[legal] = rng.uniform(-1, 1, legal_n)
    if mode == "equal-q":
        q[legal] = 0.3
    # The network's value is f32 too.
    raw = float(np.float32(0.3 if mode == "equal-q" else rng.uniform(-1, 1)))
    q = np.where(visits > 0, q, 0.0)
    t, logits = one_tree(prior, legal, visits, q, raw)
    completed = np.asarray(qtransforms.qtransform_completed_by_mix_value(t, 0))
    z = np.where(legal, logits + completed, -np.inf)
    z = z - z[legal].max()
    pi = np.where(legal, np.exp(z), 0.0)
    pi = pi / pi.sum()
    idx = np.flatnonzero(legal)
    return {
        "mode": mode,
        "prior": prior[idx].tolist(),
        "visits": visits[idx].tolist(),
        "q": q[idx].tolist(),
        "value": raw,
        "completed": completed[idx].tolist(),
        "policy": pi[idx].tolist(),
    }


def interior(rng, n, steps):
    w = np.exp(rng.normal(0, 1.5, n))
    pi = w / w.sum()
    visits = np.zeros(n, dtype=np.int32)
    chosen = []
    for _ in range(steps):
        a = int(jnp.argmax(action_selection._prepare_argmax_input(jnp.array(pi), jnp.array(visits))))
        chosen.append(a)
        visits[a] += 1
    return {"policy": pi.tolist(), "chosen": chosen}


def main():
    rng = np.random.default_rng(86)
    cases = []
    for mode in ["mixed"] * 40 + ["low"] * 10 + ["all-visited"] * 10 + ["none-visited"] * 5 + ["equal-q"] * 5 + ["zero-prior"] * 5:
        cases.append(improved(rng, int(rng.integers(1, 60)), mode))
    for legal_n in (1, 2):
        cases.append(improved(rng, legal_n, "mixed"))
    inter = [interior(rng, int(rng.integers(2, 60)), 400) for _ in range(20)]
    json.dump({"source": "mctx 428bfb7e1c931715cd3d74f9c65e9991afd86df8", "improved": cases, "interior": inter}, sys.stdout)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
