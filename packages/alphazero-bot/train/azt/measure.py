"""The value head by round ([Z11-54]), beside a formula to beat.

A value loss averaged over a generation hides where the head is wrong. Run
`first`'s head scored 0.89 on fresh samples against 0.98 for predicting 0,
which read as learning something; by round it was worse than 0 in round 1 and
behind a one-line formula of the score difference everywhere but the last
round. So each generation records, per round, the head's squared error on its
own fresh samples and that of the **formula**: a least-squares fit of the
result on `1, d, d·r, r`, where `d` is the score difference as the observation
holds it and `r` the round, fitted on the rest of the window and never on the
samples it is scored on.
"""

import numpy as np
import torch

from .augment import LAYOUT
from .model import Net

OFF_SCORES = LAYOUT["offScores"]
OFF_ROUND = LAYOUT["offRound"]
ROUND_SCALE = LAYOUT["roundScale"]


def round_of(obs: np.ndarray) -> np.ndarray:
    return np.rint(obs[:, OFF_ROUND] * ROUND_SCALE).astype(np.int64)


def features(obs: np.ndarray) -> np.ndarray:
    d = obs[:, OFF_SCORES].astype(np.float64) - obs[:, OFF_SCORES + 1]
    r = round_of(obs).astype(np.float64)
    return np.stack([np.ones(len(obs)), d, d * r, r], axis=1)


class FitData:
    """The formula's training data, gathered file by file so no second copy
    of the window is ever held."""

    def __init__(self) -> None:
        self.x: list[np.ndarray] = []
        self.y: list[np.ndarray] = []

    def add(self, samples: np.ndarray) -> None:
        self.x.append(features(samples["obs"]))
        self.y.append(samples["result"].astype(np.float64))

    def weights(self) -> np.ndarray | None:
        if not self.x:
            return None
        w, *_ = np.linalg.lstsq(np.concatenate(self.x), np.concatenate(self.y), rcond=None)
        return w


def predict_values(net: Net, samples: np.ndarray, chunk: int = 4096) -> np.ndarray:
    out = []
    with torch.no_grad():
        for i in range(0, len(samples), chunk):
            _, v = net(torch.from_numpy(samples["obs"][i:i + chunk].copy()))
            out.append(v.numpy().astype(np.float64))
    return np.concatenate(out) if out else np.zeros(0)


def value_by_round(values: np.ndarray, samples: np.ndarray, weights: np.ndarray | None) -> dict:
    """Squared errors against the result, unweighted, over all samples, in
    total and per round; the formula's beside the network's, or `None`
    without data to fit it on."""
    y = samples["result"].astype(np.float64)
    formula = None if weights is None else np.clip(features(samples["obs"]) @ weights, -1.0, 1.0)
    rounds = round_of(samples["obs"])

    def mse(pred, mask):
        return None if pred is None else float(((pred[mask] - y[mask]) ** 2).mean())

    every = np.ones(len(y), dtype=bool)
    return {
        "network": mse(values, every),
        "formula": mse(formula, every),
        "rounds": [
            {"round": int(r), "samples": int((rounds == r).sum()),
             "network": mse(values, rounds == r), "formula": mse(formula, rounds == r)}
            for r in np.unique(rounds)
        ],
    }
