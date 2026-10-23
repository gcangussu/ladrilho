"""The value against the measured win probability ([Z11-83]).

The error against `z` on fresh games ranks two networks fairly, since `z`'s
noise is the same for both, but it does not say how far either is from the
truth, and the pool says whether a checkpoint plays better, not whether its
value improved. The panel's positions each carry 16 replays of the game to
its end with the bag's hidden order reshuffled, so their mean `p̂` estimates
the position's win probability `p`.

`(v − p̂)²` overstates `(v − p)²` by `p̂`'s own variance, `σ²/R`, and the
replays' sample variance `s²` estimates `σ²` without bias. So the error
reported is `mean((v − p̂)²) − mean(s²)/R`. Left uncorrected, every
checkpoint would look about 0.04 worse than it is in the early rounds, where
`p̂` is noisiest, and a gain there would be swamped.
"""

import struct
from pathlib import Path

import numpy as np
import torch

from .formats import INPUT, parity_bytes, read_checkpoint
from .model import Net

PANEL = Path(__file__).resolve().parent.parent.parent / "panel" / "positions.bin"
MOVE, BOUNDARY = 0, 1
RECORD = np.dtype([("kind", "u1"), ("round", "u1"), ("replays", "i1", (16,)), ("v", "<f4"),
                   ("obs", "<f4", (INPUT,))])
BOOTSTRAP = 2000


def read_panel(path: Path = PANEL) -> np.ndarray:
    data = Path(path).read_bytes()
    if data[:4] != b"AZPN" or struct.unpack_from("<4I", data, 4)[0::2] != (1, 16):
        raise ValueError(f"{path}: not a version-1 panel of 16 replays")
    version, count, replays, inp = struct.unpack_from("<4I", data, 4)
    if inp != INPUT or len(data) != 20 + count * RECORD.itemsize:
        raise ValueError(f"{path}: header and length disagree")
    return np.frombuffer(data, dtype=RECORD, offset=20)


def load_checked(path: Path) -> Net:
    """A checkpoint, refused unless it reproduces its own parity file ([Z11-13])."""
    path = Path(path)
    parity = path.with_suffix(".parity")
    if not parity.exists():
        raise ValueError(f"{path}: no parity file beside it")
    net, _ = read_checkpoint(path)
    net.eval()
    if parity_bytes(net) != parity.read_bytes():
        raise ValueError(f"{path}: does not reproduce {parity.name}")
    return net


def values(net: Net, obs: np.ndarray) -> np.ndarray:
    with torch.no_grad():
        return net(torch.from_numpy(np.ascontiguousarray(obs)))[1].numpy().astype(np.float64)


def error(v: np.ndarray, replays: np.ndarray) -> float:
    """`mean((v − p̂)²) − mean(s²)/R`: an unbiased estimate of `mean((v − p)²)`."""
    r = replays.astype(np.float64)
    phat = r.mean(1)
    return float(np.mean((v - phat) ** 2) - r.var(1, ddof=1).mean() / r.shape[1])


def groups(panel: np.ndarray) -> list[tuple[str, np.ndarray]]:
    """Moves by the round they are played in, then boundaries by the round about
    to be dealt, 1-based as the journal writes them; groups under 50 are left
    out of the table but kept in the totals."""
    out = [(name, m) for name, m in (("all moves", panel["kind"] == MOVE),
                                     ("all boundaries", panel["kind"] == BOUNDARY)) if m.any()]
    for kind, name in ((MOVE, "moves in round {}"), (BOUNDARY, "boundary into round {}")):
        for r in np.unique(panel["round"][panel["kind"] == kind]):
            m = (panel["kind"] == kind) & (panel["round"] == r)
            if m.sum() >= 50:
                out.append((name.format(int(r) + 1), m))
    return out


def interval(stat, n: int, seed: int) -> tuple[float, float]:
    """A 95% percentile bootstrap over positions, from a fixed seed."""
    rng = np.random.default_rng(seed)
    draws = [stat(rng.integers(0, n, n)) for _ in range(BOOTSTRAP)]
    lo, hi = np.percentile(draws, [2.5, 97.5])
    return float(lo), float(hi)


def score(v: np.ndarray, panel: np.ndarray, against: np.ndarray | None = None) -> list[dict]:
    """One row per group: its error against `p` with an interval, the mean bias
    `mean(v − p̂)`, and, given another checkpoint's values, the paired difference
    `error(v) − error(against)` with its own interval. The noise term is common
    to both, so the difference needs no correction and resampling the same
    positions for both removes most of its spread."""
    rows = []
    for k, (name, m) in enumerate(groups(panel)):
        vm, rm = v[m], panel["replays"][m]
        row = {"group": name, "n": int(m.sum()), "error": error(vm, rm),
               "errorInterval": interval(lambda i: error(vm[i], rm[i]), len(vm), k),
               "bias": float(np.mean(vm - rm.mean(1)))}
        if against is not None:
            am = against[m]
            diff = lambda i: error(vm[i], rm[i]) - error(am[i], rm[i])
            row["against"] = error(am, rm)
            row["difference"] = diff(np.arange(len(vm)))
            row["differenceInterval"] = interval(diff, len(vm), k)
        rows.append(row)
    return rows


def table(rows: list[dict]) -> str:
    paired = "difference" in rows[0]
    head = "| Positions | n | Error vs p | 95% | Bias v − p̂ |" + (" Against | Difference | 95% |" if paired else "")
    lines = [head, "| " + " | ".join(["---"] * (head.count("|") - 1)) + " |"]
    for r in rows:
        cells = [r["group"], str(r["n"]), f"{r['error']:.4f}",
                 f"{r['errorInterval'][0]:.4f} to {r['errorInterval'][1]:.4f}", f"{r['bias']:+.4f}"]
        if paired:
            cells += [f"{r['against']:.4f}", f"{r['difference']:+.4f}",
                      f"{r['differenceInterval'][0]:+.4f} to {r['differenceInterval'][1]:+.4f}"]
        lines.append("| " + " | ".join(cells) + " |")
    return "\n".join(lines)
