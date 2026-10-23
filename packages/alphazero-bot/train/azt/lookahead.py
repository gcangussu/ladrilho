"""Lookahead targets ([Z11-80], [Z11-81], [Z11-82]).

Self-play values each boundary sample into round 5 or later by searching
deals past it, and writes those values beside the sample file as
`<g>.look.bin`: one little-endian float32 per sample, NaN where there is none.
While the run sets `lookaheadAlpha`, such a sample's value trains on
`(1 - alpha) * z + alpha * L` rather than on its result `z` alone.
"""

from pathlib import Path

import numpy as np


def settings(config: dict) -> float | None:
    """`lookaheadAlpha`, or `None` when the run has no lookahead. The two keys
    go together ([Z11-81]): the crate refuses one without the other, and so
    does this."""
    deals, alpha = config.get("lookaheadDeals"), config.get("lookaheadAlpha")
    if (deals is None) != (alpha is None):
        raise ValueError("config: lookaheadDeals and lookaheadAlpha go together ([Z11-81])")
    if alpha is None:
        return None
    if not 0 < float(alpha) <= 1:
        raise ValueError(f"config: lookaheadAlpha {alpha} is not in (0, 1]")
    return float(alpha)


def look_path(samples: Path) -> Path:
    """The lookahead file beside a sample file: `16.bin` -> `16.look.bin`."""
    return Path(samples).with_suffix(".look.bin")


def read_look(samples: Path) -> np.ndarray | None:
    """A sample file's lookahead values, or `None` when it has no lookahead
    file — a run's samples without the lookahead, or a parent's."""
    f = look_path(samples)
    if not f.exists():
        return None
    data = f.read_bytes()
    if len(data) % 4:
        raise ValueError(f"{f}: not a whole number of lookahead values")
    return np.frombuffer(data, dtype="<f4")


def window_look(files: list[Path], counts: list[int]) -> np.ndarray:
    """One lookahead value per window sample, in window order: NaN for every
    sample of a file with no lookahead file, which then trains on its result."""
    out = np.full(sum(counts), np.nan, dtype=np.float32)
    at = 0
    for f, n in zip(files, counts):
        look = read_look(f)
        if look is not None:
            if len(look) != n:
                raise ValueError(f"{f}: {n} samples but {len(look)} lookahead values")
            out[at:at + n] = look
        at += n
    return out


def targets(result: np.ndarray, look: np.ndarray, alpha: float) -> np.ndarray:
    """[Z11-82]: each sample's value target, as float32: `z + alpha * (L - z)`,
    computed in float64 and rounded, where its lookahead value `L` is finite,
    and its result `z` elsewhere."""
    z = result.astype(np.float64)
    blended = z + alpha * (look.astype(np.float64) - z)
    return np.where(np.isfinite(look), blended, z).astype(np.float32)
