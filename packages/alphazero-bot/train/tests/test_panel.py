"""The value against the measured win probability ([Z11-83])."""

from pathlib import Path

import numpy as np
import pytest
import torch

from azt.formats import write_checkpoint
from azt.model import Net
from azt.panel import BOUNDARY, RECORD, error, load_checked, read_panel, score, values

TWELFTH = Path(__file__).resolve().parents[2] / "milestones" / "twelfth" / "120" / "checkpoint.bin"


def bernoulli_panel(n: int, seed: int) -> tuple[np.ndarray, np.ndarray]:
    """Positions whose true win probability is known, each replayed 16 times."""
    rng = np.random.default_rng(seed)
    p = rng.uniform(-1, 1, n)
    wins = rng.random((n, 16)) < (1 + p[:, None]) / 2
    return p, np.where(wins, 1, -1).astype(np.int8)


def test_the_error_is_corrected_for_the_replays_noise():
    """[Z11-83]: a value equal to the true `p` scores about 0, where the
    uncorrected `mean((v − p̂)²)` would score about 0.042 here. Mutation, seen
    red: the `mean(s²)/R` term dropped."""
    p, replays = bernoulli_panel(4000, 1)
    assert abs(error(p, replays)) < 0.005
    off = p + 0.2
    assert error(off, replays) == pytest.approx(0.04, abs=0.006)


def test_the_paired_difference_favours_the_closer_value():
    """[Z11-83]: the difference is the first checkpoint's error less the
    other's, on the same resampled positions: zero against itself, negative
    for a value nearer `p`. Mutation, seen red: the subtraction reversed."""
    p, replays = bernoulli_panel(2000, 2)
    panel = np.zeros(len(p), RECORD)
    panel["kind"] = BOUNDARY
    panel["round"] = 4
    panel["replays"] = replays
    near, far = p + 0.05, p + 0.3
    same = score(near, panel, near)[0]
    assert same["difference"] == 0 and same["differenceInterval"] == (0.0, 0.0)
    row = next(r for r in score(near, panel, far) if r["group"] == "boundary into round 5")
    assert row["difference"] < 0 and row["differenceInterval"][1] < 0


def test_the_committed_panel_reproduces_twelfths_value():
    """[Z11-83]: the observations line up with the values recorded beside them,
    bit for bit, and the boundary into round 5 scores the journal's 0.155."""
    panel = read_panel()
    assert len(panel) == 4000 and (panel["kind"] == BOUNDARY).sum() == 2000
    v = values(load_checked(TWELFTH), panel["obs"])
    assert np.array_equal(v.astype(np.float32), panel["v"])
    row = next(r for r in score(v, panel) if r["group"] == "boundary into round 5")
    assert row["n"] == 487 and row["error"] == pytest.approx(0.1553, abs=0.0005)


def test_a_checkpoint_loads_only_beside_its_own_parity(tmp_path):
    """[Z11-83], [Z11-13]: no parity file, or one another network wrote, is
    refused. Mutation, seen red: the comparison with the parity file skipped."""
    torch.manual_seed(3)
    a, b = tmp_path / "a" / "checkpoint.bin", tmp_path / "b" / "checkpoint.bin"
    a.parent.mkdir()
    b.parent.mkdir()
    write_checkpoint(Net(16, 1), 0, a)
    write_checkpoint(Net(16, 1), 0, b)
    load_checked(a)
    a.with_suffix(".parity").write_bytes(b.with_suffix(".parity").read_bytes())
    with pytest.raises(ValueError, match="does not reproduce"):
        load_checked(a)
    a.with_suffix(".parity").unlink()
    with pytest.raises(ValueError, match="no parity file"):
        load_checked(a)
