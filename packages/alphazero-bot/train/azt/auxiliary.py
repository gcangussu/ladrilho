"""Auxiliary targets ([Z11-67]): the final score margin and the final walls.

A game's result is one ±1 label shared by every position of the game, and
early in a game it is close to a coin flip. What the game ended as — by how
many points, and which wall cells each player filled — says far more about
the same positions. Heads that predict it, trained beside the policy and the
value, give the shared body that extra signal. They are never exported: the
checkpoint ([Z11-11]), its parity ([Z11-13]) and the crate's forward pass do
not change, nor does anything that searches.
"""

import io
from pathlib import Path

import numpy as np
import torch

from .formats import AUX, read_aux, write_atomic
from .model import WALL_CELLS, AuxHeads

# The margin is learned over this many points, so a typical final margin is a
# target of order 1, the size of the value's.
MARGIN_SCALE = 20.0


def weights(config: dict) -> tuple[float, float]:
    """`auxMarginWeight` and `auxWallsWeight`; absent is 0, which is off."""
    return float(config.get("auxMarginWeight", 0)), float(config.get("auxWallsWeight", 0))


def enabled(config: dict) -> bool:
    wm, ww = weights(config)
    return wm > 0 or ww > 0


def window_aux(files: list[Path], counts: list[int]) -> np.ndarray:
    """One aux record per window sample, in window order, and a `has` flag:
    a sample file without an aux file (a parent's, or written before [Z11-67])
    contributes records with `has` false, which no aux loss reads."""
    out = np.zeros(sum(counts), dtype=[("aux", AUX), ("has", "?")])
    at = 0
    for f, n in zip(files, counts):
        a = read_aux(f)
        if a is not None:
            if len(a) != n:
                raise ValueError(f"{f}: {n} samples but {len(a)} aux records")
            out["aux"][at:at + n] = a
            out["has"][at:at + n] = True
        at += n
    return out


def targets(rows: np.ndarray):
    """The margin over [MARGIN_SCALE], the 50 wall cells as 0/1 (the seat's
    wall first, cell `i` of each at bit `i`), and the `has` mask."""
    margin = torch.from_numpy(rows["aux"]["margin"].astype(np.float32) / MARGIN_SCALE)
    w = rows["aux"]["walls"].astype(np.uint32)
    bits = (w[:, :, None] >> np.arange(25, dtype=np.uint32)) & 1
    walls = torch.from_numpy(bits.reshape(len(rows), WALL_CELLS).astype(np.float32))
    return margin, walls, torch.from_numpy(rows["has"].copy())


def losses(out, margin, walls, has):
    """The margin's squared error and the walls' mean binary cross-entropy,
    each over the samples that have targets; zero when none do."""
    pred_margin, wall_logits = out
    if not bool(has.any()):
        zero = pred_margin.sum() * 0.0
        return zero, zero
    m = ((pred_margin[has] - margin[has]) ** 2).mean()
    w = torch.nn.functional.binary_cross_entropy_with_logits(wall_logits[has], walls[has])
    return m, w


def optimiser(heads: AuxHeads, config: dict):
    """The heads' own SGD, with the run's settings: the body's optimiser state
    keeps its shape, so a run started from one without heads still loads it."""
    return torch.optim.SGD(heads.parameters(), lr=config["learningRate"], momentum=config["momentum"],
                           weight_decay=config["weightDecay"])


def load(path: Path, width: int, config: dict):
    """The heads and their optimiser as generation `g` left them, or fresh
    ones when the file is absent (a run's first generation with them)."""
    heads = AuxHeads(width)
    opt = optimiser(heads, config)
    if path.exists():
        state = torch.load(path)
        heads.load_state_dict(state["heads"])
        from .train import restore

        restore(opt, state["optimiser"], config)
    return heads, opt


def save(path: Path, heads: AuxHeads, opt) -> None:
    buf = io.BytesIO()
    torch.save({"heads": heads.state_dict(), "optimiser": opt.state_dict()}, buf)
    write_atomic(path, buf.getvalue())
