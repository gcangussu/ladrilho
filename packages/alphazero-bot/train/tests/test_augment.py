"""Display permutation ([Z11-65]) and a run started from another's checkpoint
([Z11-66])."""

import json
from pathlib import Path

import numpy as np
import torch

from azt.augment import permute_actions, permute_legal, permute_obs, permute_samples, random_perms
from azt.formats import SAMPLE, legal_bits, read_checkpoint, read_samples, sha256
from azt.train import init_from, init_run, paths, train_generation

from test_trainer import config, selfplay

FIXTURE = json.loads((Path(__file__).resolve().parent / "fixtures" / "displays.json").read_text())


def mask(actions) -> np.ndarray:
    m = np.zeros((1, 180), dtype=bool)
    m[0, actions] = True
    return m


def pack(m: np.ndarray) -> np.ndarray:
    return np.packbits(m, axis=1, bitorder="little")[:, :23]


def test_the_permutation_is_the_engines():
    """[Z11-65]: permuting a sample's observation and legal mask gives exactly
    what the engine encodes, and finds legal, for the position with its
    displays permuted — from both the unpacked and the packed mask. The
    fixture is the engine's, recorded by `augment-fixtures` and held to it by
    the lanes' suite. Mutation, seen red: the inverse permutation, and the
    flags left in place."""
    assert len(FIXTURE) >= 10
    for case in FIXTURE:
        perm = np.array([case["perm"]])
        obs = np.array([case["obs"]], dtype=np.float32)
        assert np.array_equal(permute_obs(obs, perm), np.array([case["permutedObs"]], dtype=np.float32)), case
        assert np.array_equal(permute_actions(mask(case["legal"]), perm), mask(case["permutedLegal"])), case
        assert np.array_equal(permute_legal(pack(mask(case["legal"])), perm), pack(mask(case["permutedLegal"])))


def one_sample(case, boundary=False) -> np.ndarray:
    s = np.zeros(1, dtype=SAMPLE)
    s["kind"] = 1 if boundary else 0
    s["result"] = -1
    s["obs"][0] = case["obs"]
    if not boundary:
        s["legal"][0] = pack(mask(case["legal"]))[0]
        for a in case["legal"]:
            s["visits"][0][a] = a + 1
    return s


def test_visits_move_with_their_actions_and_the_result_stays():
    """[Z11-65]: a move's visits land on the action the engine finds legal in
    the permuted position, each carrying its own count; the result is kept."""
    for case in FIXTURE:
        s = one_sample(case)
        out = permute_samples(s, np.array([case["perm"]]))
        assert out["result"][0] == -1 and out["kind"][0] == 0
        assert np.array_equal(out["visits"][0] > 0, mask(case["permutedLegal"])[0])
        assert sorted(out["visits"][0][out["visits"][0] > 0]) == sorted(a + 1 for a in case["legal"])
        assert np.array_equal(legal_bits(out["legal"]), mask(case["permutedLegal"]))


def test_a_boundary_sample_is_unchanged_and_the_inverse_undoes_it():
    """[Z11-65]: a boundary sample's displays are empty and it has no actions
    ([Z11-9], [Z11-27]), so a permutation leaves it as it was; and permuting by
    a permutation's inverse restores any sample."""
    case = FIXTURE[0]
    b = one_sample(case, boundary=True)
    b["obs"][0][126:156] = 0
    assert permute_samples(b, np.array([case["perm"]])).tobytes() == b.tobytes()
    rng = np.random.default_rng(5)
    s = np.concatenate([one_sample(c) for c in FIXTURE])
    perms = random_perms(rng, len(s))
    assert all(sorted(p) == [0, 1, 2, 3, 4] for p in perms)
    back = permute_samples(permute_samples(s, perms), np.argsort(perms, axis=1))
    assert back.tobytes() == s.tobytes()


def child(tmp_path: Path, parent: Path, name: str, generation: int, augment: str) -> Path:
    run = tmp_path / name
    run.mkdir()
    pc = json.loads((parent / "config.json").read_text())
    pc.update(seed=1234, augment=augment, **{"from": {
        "run": "parent", "generation": generation,
        "checkpointSha256": sha256(paths(parent, generation)["checkpoint"]),
        "windowGenerations": list(range(generation)), "latencyRun": "parent"}})
    (run / "config.json").write_text(json.dumps(pc))
    init_from(run, parent, generation)
    return run


def test_a_run_started_from_another_continues_its_window(tmp_path):
    """[Z11-66]: checkpoint 0 is the parent's checkpoint, relabelled; the
    optimiser state is the parent's; and the first generation trains on the
    parent's samples as well as its own. [Z11-65]: with `augment: displays`
    the same draws train to different weights. Mutation, seen red: the
    augmentation skipped, and the inherited samples left out."""
    parent = tmp_path / "parent"
    parent.mkdir()
    (parent / "config.json").write_text(json.dumps(config()))
    init_run(parent)
    p0 = paths(parent, 0)
    p0["samples"].parent.mkdir(parents=True)
    assert selfplay(p0["checkpoint"], parent / "config.json", p0["samples"], games=2).returncode == 0
    train_generation(parent, 0)

    runs = {a: child(tmp_path, parent, f"child-{a}", 1, a) for a in ("none", "displays")}
    for run in runs.values():
        net, g = read_checkpoint(paths(run, 0)["checkpoint"])
        parent_net, _ = read_checkpoint(paths(parent, 1)["checkpoint"])
        assert g == 0 and all(torch.equal(a, b) for a, b in zip(net.tensors(), parent_net.tensors()))
        assert paths(run, 0)["optimiser"].read_bytes() == paths(parent, 1)["optimiser"].read_bytes()
        assert paths(run, 0)["manifest"].exists()
        c0 = paths(run, 0)
        c0["samples"].parent.mkdir(parents=True)
        # The same self-play for both children, so only the augmentation differs.
        c0["samples"].write_bytes(p0["samples"].read_bytes()[: 40 * SAMPLE.itemsize])
        train_generation(run, 0)
        record = json.loads((run / "losses.json").read_text())["0"]
        assert record["window"]["inherited"] == {"run": "parent", "generations": [0]}
        assert record["window"]["samples"] == len(read_samples(p0["samples"])) + 40

    a, _ = read_checkpoint(paths(runs["none"], 1)["checkpoint"])
    b, _ = read_checkpoint(paths(runs["displays"], 1)["checkpoint"])
    assert not all(torch.equal(x, y) for x, y in zip(a.tensors(), b.tensors()))
