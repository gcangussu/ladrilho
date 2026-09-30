"""The value head by round beside the formula ([Z11-54])."""

import json

import numpy as np

from azt.formats import SAMPLE
from azt.measure import FitData, round_of, value_by_round
from azt.train import init_run, paths, train_generation

from test_trainer import config, selfplay


def samples(rounds, diffs, results) -> np.ndarray:
    """Samples holding only what the formula reads: the round and the scores,
    encoded as the engine encodes them (round / 10, score / 100)."""
    s = np.zeros(len(rounds), dtype=SAMPLE)
    s["obs"][:, 175] = np.asarray(rounds, dtype=np.float32) / 10
    s["obs"][:, 124] = np.maximum(np.asarray(diffs), 0) / 100
    s["obs"][:, 125] = np.maximum(-np.asarray(diffs), 0) / 100
    s["result"] = results
    return s


def test_rounds_are_read_as_the_engine_encodes_them():
    """[Z11-54]: round `r` is stored as `r / 10`, and read back as `r`.
    Mutation, seen red: the scale left out, which puts every sample in round 0."""
    assert list(round_of(samples([0, 1, 4, 5], [0] * 4, [0] * 4)["obs"])) == [0, 1, 4, 5]


def test_errors_by_round_and_the_formula_out_of_sample():
    """[Z11-54]: squared errors per round, the network's beside the formula's,
    and the formula fitted only on the data it is given. Here the fit data
    says the leader wins; the scored samples say the opposite, so an honest
    out-of-sample formula scores badly on them. Mutation, seen red: fitting
    the formula on the scored samples."""
    rng = np.random.default_rng(1)
    n = 400
    rounds = rng.integers(0, 5, size=n)
    diffs = rng.integers(-30, 31, size=n)
    diffs[diffs == 0] = 1
    fit = FitData()
    fit.add(samples(rounds, diffs, np.sign(diffs)))
    scored = samples(rounds, diffs, -np.sign(diffs))
    values = np.zeros(n)
    out = value_by_round(values, scored, fit.weights())
    assert out["network"] == 1.0  # predicting 0 against ±1 results
    assert out["formula"] > 1.0  # confidently wrong, as a leaked fit would never be
    assert [r["round"] for r in out["rounds"]] == [0, 1, 2, 3, 4]
    assert sum(r["samples"] for r in out["rounds"]) == n
    assert all(r["network"] == 1.0 for r in out["rounds"])
    # Without anything to fit on, the formula is absent rather than invented.
    assert value_by_round(values, scored, FitData().weights())["formula"] is None


def test_a_generation_records_the_value_by_round(tmp_path):
    """[Z11-54]: a trained generation's losses carry `byRound` under `before`;
    generation 0 of a fresh run has nothing else in its window, so no formula;
    generation 1 fits it on generation 0."""
    run = tmp_path / "run"
    run.mkdir()
    (run / "config.json").write_text(json.dumps(config()))
    init_run(run)
    for g in (0, 1):
        pg = paths(run, g)
        pg["samples"].parent.mkdir(parents=True, exist_ok=True)
        assert selfplay(pg["checkpoint"], run / "config.json", pg["samples"], generation=g, games=2).returncode == 0
        train_generation(run, g)
    record = json.loads((run / "losses.json").read_text())
    first, second = record["0"]["before"]["byRound"], record["1"]["before"]["byRound"]
    assert first["formula"] is None and first["network"] >= 0
    assert second["formula"] is not None
    assert sum(r["samples"] for r in second["rounds"]) == record["1"]["before"]["samples"]
