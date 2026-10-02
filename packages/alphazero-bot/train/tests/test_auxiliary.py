"""Auxiliary targets: the final margin and the final walls ([Z11-67])."""

import json

import numpy as np
import torch

from azt import auxiliary
from azt.formats import AUX, aux_path, read_aux, read_checkpoint, read_samples
from azt.train import evaluate_aux, init_run, paths, train_generation

from test_trainer import config, selfplay


def rows(margins, walls, has):
    r = np.zeros(len(margins), dtype=[("aux", AUX), ("has", "?")])
    r["aux"]["margin"] = margins
    r["aux"]["walls"] = walls
    r["has"] = has
    return r


def test_targets_are_the_margin_scaled_and_the_cells_in_order():
    """[Z11-67]: the margin over 20 points; cell `i` of the seat's wall is
    target `i`, cell `i` of the other's is target `25 + i`. Mutation, seen
    red: the cells read from bit 24 down."""
    margin, walls, has = auxiliary.targets(rows([40, -10], [[1 << 3, 1 << 24], [0, 0b11]], [True, False]))
    assert margin.tolist() == [2.0, -0.5]
    assert walls[0].nonzero().flatten().tolist() == [3, 49]
    assert walls[1].nonzero().flatten().tolist() == [25, 26]
    assert has.tolist() == [True, False]


def test_samples_without_targets_carry_no_aux_loss():
    """[Z11-67]: only samples with an aux record enter the aux losses, and a
    batch with none gives zero rather than NaN. Mutation, seen red: the `has`
    mask ignored."""
    torch.manual_seed(0)
    out = (torch.randn(4), torch.randn(4, 50))
    r = rows([20, -20, 0, 7], [[1, 2], [3, 4], [5, 6], [7, 8]], [True, True, False, False])
    m_all, w_all = auxiliary.losses(out, *auxiliary.targets(r))
    m_two, w_two = auxiliary.losses((out[0][:2], out[1][:2]), *auxiliary.targets(r[:2]))
    assert torch.allclose(m_all, m_two) and torch.allclose(w_all, w_two)
    m0, w0 = auxiliary.losses(out, *auxiliary.targets(rows([1] * 4, [[0, 0]] * 4, [False] * 4)))
    assert float(m0) == 0.0 and float(w0) == 0.0


def run_with(tmp_path, name: str, **over) -> tuple:
    run = tmp_path / name
    run.mkdir()
    (run / "config.json").write_text(json.dumps(config(**over)))
    init_run(run)
    for g in (0, 1):
        pg = paths(run, g)
        pg["samples"].parent.mkdir(parents=True, exist_ok=True)
        assert selfplay(pg["checkpoint"], run / "config.json", pg["samples"], generation=g, games=2).returncode == 0
        train_generation(run, g)
    return run, json.loads((run / "losses.json").read_text())


def test_self_play_writes_an_aux_record_per_sample(tmp_path):
    """[Z11-67]: the crate writes `<g>.aux.bin` beside `<g>.bin`, one record
    per sample, which the trainer reads."""
    run = tmp_path / "r"
    run.mkdir()
    (run / "config.json").write_text(json.dumps(config()))
    init_run(run)
    p0 = paths(run, 0)
    p0["samples"].parent.mkdir(parents=True)
    assert selfplay(p0["checkpoint"], run / "config.json", p0["samples"], games=2).returncode == 0
    a = read_aux(p0["samples"])
    assert aux_path(p0["samples"]).name == "0.aux.bin"
    assert a is not None and len(a) == len(read_samples(p0["samples"]))
    assert (a["walls"] >> 25 == 0).all() and (a["walls"] != 0).any()


def test_the_heads_train_persist_and_stay_out_of_the_checkpoint(tmp_path):
    """[Z11-67]: with the weights set, each generation records the aux losses
    before and during training, saves the heads and their optimiser beside
    the next checkpoint (named in its manifest), and the next generation
    starts from them; the checkpoint keeps its shape. With the weights absent
    nothing of it exists and training is what it was: the same draws give the
    same checkpoint whether the weights are absent or 0, and a different one
    when they are set — the aux gradient reaches the body.

    Mutations, seen red: the heads not saved (fresh every generation); the aux
    loss left out of the total; the aux loss added with the weights at 0."""
    on, rec_on = run_with(tmp_path, "on", auxMarginWeight=0.5, auxWallsWeight=0.5)
    off, rec_off = run_with(tmp_path, "off")
    zero, _ = run_with(tmp_path, "zero", auxMarginWeight=0, auxWallsWeight=0)

    for g in ("0", "1"):
        assert set(rec_on[g]["training"]["aux"]) >= {"margin", "walls", "marginWeight", "wallsWeight"}
        assert rec_on[g]["training"]["aux"]["withTargets"] == 1.0
        assert set(rec_on[g]["before"]["aux"]) == {"margin", "walls"}
        assert "aux" not in rec_off[g]["training"] and "aux" not in rec_off[g]["before"]
    for g in (1, 2):
        assert paths(on, g)["aux"].exists() and not paths(off, g)["aux"].exists()
        assert "aux" in json.loads(paths(on, g)["manifest"].read_text())
    # Generation 1 started from the heads generation 0 saved: its `before`
    # aux losses are exactly those of checkpoint 1 with `aux/1.pt`'s heads.
    cfg = json.loads((on / "config.json").read_text())
    net1, _ = read_checkpoint(paths(on, 1)["checkpoint"])
    heads1, _ = auxiliary.load(paths(on, 1)["aux"], net1.width, cfg)
    own1 = read_samples(paths(on, 1)["samples"])
    again = evaluate_aux(net1, heads1, own1, auxiliary.window_aux([paths(on, 1)["samples"]], [len(own1)]))
    assert again == rec_on["1"]["before"]["aux"]

    def tensors(run):
        return read_checkpoint(paths(run, 2)["checkpoint"])[0].tensors()
    assert all(torch.equal(a, b) for a, b in zip(tensors(off), tensors(zero)))
    assert not all(torch.equal(a, b) for a, b in zip(tensors(off), tensors(on)))
    assert paths(on, 2)["checkpoint"].stat().st_size == paths(off, 2)["checkpoint"].stat().st_size
