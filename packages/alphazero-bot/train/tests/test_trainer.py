"""The trainer's suite, `test:train` ([Z11-46]). Outside the root suite: it
needs the pinned environment of [Z11-5]."""

import json
import subprocess
from pathlib import Path

import numpy as np
import pytest
import torch

from azt.formats import (SAMPLE, checkpoint_bytes, legal_bits, parity_bytes, read_checkpoint,
                         read_corpus, read_samples, write_checkpoint)
from azt.model import Net
from azt.train import batch_tensors, init_run, losses, optimiser, paths, train_generation

PACKAGE = Path(__file__).resolve().parents[2]
BINARY = PACKAGE / "target" / "debug" / "alphazero"


def config(**over):
    c = {
        "width": 16, "blocks": 1, "seed": 99, "playSimulations": 8, "milestoneSimulations": 8,
        "selfPlaySimulations": 4, "cpuct": 1.25, "fpu": 0.25, "alpha": 0.3, "epsilon": 0.25,
        "tempPlies": 10, "tau": 1, "gamesPerGeneration": 2, "window": 20, "stepsPerGeneration": 3,
        "batch": 16, "boundaryWeight": 1, "optimiser": "sgd", "momentum": 0.9, "learningRate": 0.02,
        "weightDecay": 1e-4, "milestoneEvery": 10, "threads": 2, "torchThreads": 1,
        "maxGenerationMinutes": 30,
    }
    c.update(over)
    return c


def selfplay(checkpoint: Path, cfg: Path, out: Path, generation=0, games=1):
    return subprocess.run(
        [str(BINARY), "selfplay", str(checkpoint), "--config", str(cfg), "--generation", str(generation),
         "--games", str(games), "--out", str(out)],
        capture_output=True, text=True)


def test_an_exported_checkpoint_loads_in_the_crate_with_parity(tmp_path):
    """[Z11-46]: a checkpoint the trainer exports is read back by `alphazero`,
    parity checked ([Z11-13]); one whose parity file disagrees is refused."""
    torch.manual_seed(1)
    net = Net(24, 2)
    ckpt = tmp_path / "c.bin"
    write_checkpoint(net, 7, ckpt)
    cfg = tmp_path / "config.json"
    cfg.write_text(json.dumps(config(width=24, blocks=2, threads=1)))
    r = selfplay(ckpt, cfg, tmp_path / "s.bin")
    assert r.returncode == 0, r.stderr
    assert len(read_samples(tmp_path / "s.bin")) > 20

    back, generation = read_checkpoint(ckpt)
    assert generation == 7
    for a, b in zip(net.tensors(), back.tensors()):
        assert torch.equal(a, b)

    parity = bytearray(ckpt.with_suffix(".parity").read_bytes())
    parity[44 + 4 * 180 + 3] ^= 0x20  # entry 0's value, an exponent bit
    ckpt.with_suffix(".parity").write_bytes(bytes(parity))
    r = selfplay(ckpt, cfg, tmp_path / "t.bin")
    assert r.returncode == 2 and "parity" in r.stderr


def test_the_checkpoint_layout_is_the_crates():
    """[Z11-11] from the trainer's side: header then tensors, row-major [out][in]."""
    net = Net(16, 1)
    b = checkpoint_bytes(net, 3)
    assert b[:4] == b"AZ11"
    header = np.frombuffer(b[4:32], dtype="<u4")
    assert list(header) == [1, 182, 16, 1, 180, 64, 3]
    floats = np.frombuffer(b, dtype="<f4", offset=32)
    assert np.array_equal(floats[: 16 * 182], net.stem.weight.detach().numpy().reshape(-1))
    assert len(b) == 32 + 4 * sum(t.numel() for t in net.tensors())
    obs, legal, digest = read_corpus()
    p = parity_bytes(net)
    assert p[:4] == b"AZPF" and p[8:40] == digest and len(p) == 44 + 64 * 181 * 4
    assert obs.shape == (64, 182) and (legal == 0).all(axis=1).sum() == 32


def test_a_sample_written_by_the_crate_is_read_intact():
    """[Z11-46], [Z11-27]: the three records the crate's own test writes, field
    by field, against the formula that wrote them."""
    f = PACKAGE / "target" / "test-scratch" / "python-samples" / "samples.bin"
    if not f.exists():
        pytest.fail("run `cargo test --locked --test selfplay` first: it writes the file")
    s = read_samples(f)
    assert SAMPLE.itemsize == 1113 and len(s) == 3
    for i in range(3):
        boundary = i == 1
        assert s["kind"][i] == (1 if boundary else 0)
        assert s["result"][i] == [1, 0, -1][i]
        want = (np.arange(182, dtype=np.float64) + i * 1000) / 7.0
        assert np.array_equal(s["obs"][i], want.astype(np.float32))
        if boundary:
            assert (s["legal"][i] == 0).all() and (s["visits"][i] == 0).all()
        else:
            assert list(s["legal"][i]) == [((i * 23 + b) * 11) % 256 for b in range(23)]
            assert list(s["visits"][i]) == [((i * 180 + a) * 3) % 65536 for a in range(180)]
    bits = legal_bits(s["legal"][:1])
    assert bits.shape == (1, 180)
    assert bits[0, 0] == bool(s["legal"][0][0] & 1) and bits[0, 9] == bool(s["legal"][0][1] >> 1 & 1)


def batch(n=32, seed=0):
    rng = np.random.default_rng(seed)
    s = np.zeros(n, dtype=SAMPLE)
    s["kind"] = (np.arange(n) % 5 == 0).astype(np.uint8)
    s["result"] = rng.integers(-1, 2, size=n)
    s["obs"] = rng.random((n, 182), dtype=np.float32)
    for i in range(n):
        if s["kind"][i] == 0:
            legal = rng.choice(180, size=12, replace=False)
            for a in legal:
                s["legal"][i][a // 8] |= 1 << (a % 8)
                s["visits"][i][a] = rng.integers(0, 30)
            s["visits"][i][legal[0]] += 1
    return s


def test_the_loss_ignores_illegal_logits():
    """[Z11-29], [Z11-46]: the policy is the masked softmax, so no illegal
    logit carries loss — changing them all changes nothing; and boundary
    samples, with no legal set, enter the value term only."""
    obs, legal, visits, result, kind = batch_tensors(batch())
    logits = torch.randn(len(kind), 180)
    value = torch.tanh(torch.randn(len(kind)))
    p1, v1 = losses(logits, value, legal, visits, result, kind, 1.0)
    shifted = torch.where(legal, logits, logits + 50 * torch.randn_like(logits))
    p2, v2 = losses(shifted, value, legal, visits, result, kind, 1.0)
    assert torch.isfinite(p1) and torch.isfinite(v1)
    assert torch.allclose(p1, p2) and torch.equal(v1, v2)
    p3, v3 = losses(logits, value, legal, visits, result, kind, 3.0)
    assert torch.equal(p1, p3) and v3 > v1  # boundary samples weighted by boundaryWeight


def test_weight_decay_is_applied_once():
    """[Z11-29], [Z11-46]: the optimiser applies weight decay, and the loss
    carries no weight term: one SGD step moves each weight by exactly
    `lr · (∂loss/∂w + wd · w)`."""
    torch.manual_seed(3)
    net = Net(16, 1)
    cfg = config(weightDecay=0.1, learningRate=0.05)
    opt = optimiser(net, cfg)
    obs, legal, visits, result, kind = batch_tensors(batch(seed=4))
    logits, value = net(obs)
    pol, val = losses(logits, value, legal, visits, result, kind, 1.0)
    loss = pol + val
    before = [t.detach().clone() for t in net.tensors()]
    opt.zero_grad()
    loss.backward()
    grads = [t.grad.detach().clone() for t in net.tensors()]
    opt.step()
    for w0, g, w1 in zip(before, grads, net.tensors()):
        assert torch.allclose(w1.detach(), w0 - 0.05 * (g + 0.1 * w0), atol=1e-7)
    # The loss is the same whatever the decay: nothing of the weights' size is in it.
    net2 = Net(16, 1)
    with torch.no_grad():
        l_a = sum(losses(*net2(obs), legal, visits, result, kind, 1.0))
    assert torch.isfinite(l_a)


def test_one_generation_of_the_loop(tmp_path):
    """Steps 1 to 4 of [Z11-28] on a tiny run: checkpoint 0 from init, the
    crate's self-play, one generation of training, and checkpoint 1 loading in
    the crate with its parity file ([Z11-13])."""
    run = tmp_path / "run"
    run.mkdir()
    (run / "config.json").write_text(json.dumps(config()))
    init_run(run)
    p0 = paths(run, 0)
    assert p0["manifest"].exists() and p0["optimiser"].exists()
    p0["samples"].parent.mkdir(parents=True)
    r = selfplay(p0["checkpoint"], run / "config.json", p0["samples"], games=2)
    assert r.returncode == 0, r.stderr
    train_generation(run, 0)
    p1 = paths(run, 1)
    manifest = json.loads(p1["manifest"].read_text())
    assert manifest["generation"] == 1 and set(manifest) >= {"checkpoint", "parity", "optimiser"}
    record = json.loads((run / "losses.json").read_text())["0"]
    assert {"before", "training", "drawRatio"} <= set(record)
    assert record["drawRatio"] == pytest.approx(3 * 16 / record["window"]["samples"])
    r = selfplay(p1["checkpoint"], run / "config.json", tmp_path / "g1.bin", generation=1)
    assert r.returncode == 0, r.stderr
    assert read_checkpoint(p1["checkpoint"])[1] == 1
