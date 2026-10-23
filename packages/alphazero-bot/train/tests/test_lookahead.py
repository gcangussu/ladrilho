"""Lookahead targets ([Z11-80], [Z11-81], [Z11-82])."""

import json

import numpy as np
import pytest

from azt import lookahead
from azt import train as train_module
from azt.formats import read_samples
from azt.train import init_run, paths, train_generation

from test_trainer import config, selfplay


def test_the_target_blends_exactly_where_there_is_a_lookahead_value():
    """[Z11-82]: `z + alpha * (L - z)`, in float64 and rounded to float32,
    where `L` is finite; the result `z` itself where it is NaN. Mutation,
    seen red: alpha dropped, so the target is `L` alone."""
    z = np.array([1, -1, 0, 1, -1, 0], dtype=np.int8)
    look = np.array([0.25, np.nan, -0.5, np.nan, 0.75, 0.1], dtype=np.float32)
    got = lookahead.targets(z, look, 0.9)
    assert got.dtype == np.float32
    want = [np.float32(float(zi) + 0.9 * (float(li) - float(zi))) if np.isfinite(li) else np.float32(zi)
            for zi, li in zip(z, look)]
    assert got.tolist() == [float(w) for w in want]
    assert got[1] == -1.0 and got[3] == 1.0
    assert lookahead.targets(z, look, 1.0)[0] == np.float32(0.25)


def test_the_settings_go_together():
    """[Z11-81]: absent is off; one without the other, or alpha outside
    (0, 1], is refused."""
    assert lookahead.settings({}) is None
    assert lookahead.settings({"lookaheadDeals": 8, "lookaheadAlpha": 0.9}) == 0.9
    for bad in ({"lookaheadDeals": 8}, {"lookaheadAlpha": 0.9},
                {"lookaheadDeals": 8, "lookaheadAlpha": 0}, {"lookaheadDeals": 8, "lookaheadAlpha": 1.5}):
        with pytest.raises(ValueError):
            lookahead.settings(bad)


def test_a_file_without_a_lookahead_file_has_no_values(tmp_path):
    """[Z11-82]: a sample file with no lookahead file beside it — a parent's
    inherited one — contributes NaN for every sample, so each trains on its
    result; one whose count disagrees is refused."""
    a, b = tmp_path / "3.bin", tmp_path / "4.bin"
    np.array([0.5, np.nan, -0.25], dtype="<f4").tofile(lookahead.look_path(a))
    assert lookahead.look_path(a).name == "3.look.bin"
    w = lookahead.window_look([b, a], [2, 3])
    assert np.isnan(w[:2]).all() and w[2] == 0.5 and np.isnan(w[3]) and w[4] == -0.25
    with pytest.raises(ValueError):
        lookahead.window_look([a], [4])


def test_training_draws_the_blended_target(tmp_path, monkeypatch):
    """[Z11-82] end to end: self-play writes the lookahead file ([Z11-80]); a
    generation trains every drawn sample's value on the blend where its file
    has a value and on its result elsewhere — generation 0's samples, whose
    lookahead file is removed before generation 1 trains, on their results
    alone — exactly as recomputed here from the files and the trainer's own
    draws; and `losses.json` records alpha and the shares. Mutation, seen red:
    the drawn targets left as the results."""
    run = tmp_path / "r"
    run.mkdir()
    cfg = config(lookaheadDeals=2, lookaheadAlpha=0.9, stepsPerGeneration=4, batch=64)
    (run / "config.json").write_text(json.dumps(cfg))
    init_run(run)
    seen = []
    real = train_module.losses
    monkeypatch.setattr(train_module, "losses", lambda *a: (seen.append(a[4].clone()), real(*a))[1])
    for g in (0, 1):
        pg = paths(run, g)
        pg["samples"].parent.mkdir(parents=True, exist_ok=True)
        r = selfplay(pg["checkpoint"], run / "config.json", pg["samples"], generation=g, games=2)
        assert r.returncode == 0, r.stderr
        assert lookahead.look_path(pg["samples"]).exists()
        if g == 1:
            lookahead.look_path(paths(run, 0)["samples"]).unlink()
        seen.clear()
        train_generation(run, g)
        files = [paths(run, k)["samples"] for k in range(g + 1)]
        results = np.concatenate([read_samples(f)["result"] for f in files])
        look = np.concatenate([
            np.fromfile(lookahead.look_path(f), dtype="<f4") if lookahead.look_path(f).exists()
            else np.full(len(read_samples(f)), np.nan, dtype=np.float32)
            for f in files])
        assert np.isfinite(look).any(), "self-play looked past no boundary"
        rng = np.random.default_rng((cfg["seed"], g))
        drawn = seen[-cfg["stepsPerGeneration"]:]
        with_value = 0
        for step in drawn:
            idx = rng.integers(0, len(results), size=cfg["batch"])
            want = [float(z) + 0.9 * (float(l) - float(z)) if np.isfinite(l) else float(z)
                    for z, l in zip(results[idx], look[idx])]
            assert step.tolist() == np.array(want, dtype=np.float32).tolist()
            with_value += int(np.isfinite(look[idx]).sum())
        rec = json.loads((run / "losses.json").read_text())[str(g)]["training"]["lookahead"]
        assert rec["alpha"] == 0.9
        assert rec["withTargets"] == with_value / (cfg["stepsPerGeneration"] * cfg["batch"])
        assert rec["windowWithTargets"] == pytest.approx(float(np.isfinite(look).mean()))
    assert not np.isfinite(look[:len(read_samples(paths(run, 0)["samples"]))]).any()


def test_without_the_keys_nothing_changes(tmp_path):
    """[Z11-81]: absent keys mean no lookahead file, and no lookahead record."""
    run = tmp_path / "r"
    run.mkdir()
    (run / "config.json").write_text(json.dumps(config()))
    init_run(run)
    p0 = paths(run, 0)
    p0["samples"].parent.mkdir(parents=True)
    assert selfplay(p0["checkpoint"], run / "config.json", p0["samples"], games=1).returncode == 0
    assert not lookahead.look_path(p0["samples"]).exists()
    train_generation(run, 0)
    assert "lookahead" not in json.loads((run / "losses.json").read_text())["0"]["training"]
