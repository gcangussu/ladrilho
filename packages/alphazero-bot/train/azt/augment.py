"""Display permutation ([Z11-65]).

The five displays are interchangeable: relabelling them gives the same game
position, the same result, and the same search with its visits relabelled. So
a sample is trained on under a random permutation of them, without searching
again. Display `i` of the permuted sample holds what display `perm[i]` held:
its five colour counts, its flag, and every action taken from it. The centre
and everything else stay where they are.

The offsets come from `train/layout.json`, which `pnpm -F alphazero-bot
augment-fixtures` writes from the engine's exports and the lanes' suite holds
to them ([Z11-8]).
"""

import json
from pathlib import Path

import numpy as np

from .formats import LEGAL_BYTES
from .model import INPUT, POLICY

LAYOUT = json.loads((Path(__file__).resolve().parent.parent / "layout.json").read_text())
DISPLAYS = LAYOUT["displays"]
COLORS = LAYOUT["colors"]
OFF_FACTORIES = LAYOUT["offFactories"]
OFF_FLAGS = LAYOUT["offFactoryFlags"]
PER_SOURCE = LAYOUT["perSource"]
assert (LAYOUT["encodedSize"], LAYOUT["actionSpace"]) == (INPUT, POLICY)
assert LAYOUT["center"] == DISPLAYS and PER_SOURCE * (DISPLAYS + 1) == POLICY


def random_perms(rng: np.random.Generator, n: int) -> np.ndarray:
    """`[n, 5]`: one uniformly random permutation of the displays per sample."""
    return np.argsort(rng.random((n, DISPLAYS)), axis=1)


def permute_obs(obs: np.ndarray, perms: np.ndarray) -> np.ndarray:
    out = obs.copy()
    rows = np.arange(len(obs))[:, None]
    counts = obs[:, OFF_FACTORIES:OFF_FACTORIES + DISPLAYS * COLORS].reshape(-1, DISPLAYS, COLORS)
    out[:, OFF_FACTORIES:OFF_FACTORIES + DISPLAYS * COLORS] = counts[rows, perms].reshape(-1, DISPLAYS * COLORS)
    out[:, OFF_FLAGS:OFF_FLAGS + DISPLAYS] = obs[:, OFF_FLAGS:OFF_FLAGS + DISPLAYS][rows, perms]
    return out


def permute_actions(values: np.ndarray, perms: np.ndarray) -> np.ndarray:
    """`[n, 180]` per-action values (visits, or the legal mask unpacked):
    source `i`'s block takes source `perm[i]`'s; the centre's stays."""
    by_source = values.reshape(len(values), DISPLAYS + 1, PER_SOURCE)
    rows = np.arange(len(values))[:, None]
    out = by_source.copy()
    out[:, :DISPLAYS] = by_source[rows, perms]
    return out.reshape(len(values), POLICY)


def permute_legal(legal: np.ndarray, perms: np.ndarray) -> np.ndarray:
    """The packed 23-byte masks of [Z11-27], permuted as `permute_actions`."""
    bits = np.unpackbits(legal, axis=1, bitorder="little")[:, :POLICY]
    packed = np.packbits(permute_actions(bits, perms), axis=1, bitorder="little")
    return packed[:, :LEGAL_BYTES]


def permute_samples(samples: np.ndarray, perms: np.ndarray) -> np.ndarray:
    """A copy of `samples` with every record's displays permuted by its row of
    `perms`. A boundary sample's displays are empty and its legal and visits
    zero ([Z11-9], [Z11-27]), so it comes back unchanged."""
    out = samples.copy()
    out["obs"] = permute_obs(samples["obs"], perms)
    out["legal"] = permute_legal(samples["legal"], perms)
    out["visits"] = permute_actions(samples["visits"], perms)
    return out
