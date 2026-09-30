"""The loss of [Z11-29] and one generation's training (steps 2 to 4 of [Z11-28])."""

import json
import math
import os
import shutil
from pathlib import Path

import numpy as np
import torch

from .augment import permute_samples, random_perms
from .measure import FitData, predict_values, value_by_round
from .formats import (legal_bits, read_checkpoint, read_samples, sha256, write_atomic,
                      write_checkpoint, write_json)
from .model import Net


def batch_tensors(samples: np.ndarray):
    obs = torch.from_numpy(samples["obs"].copy())
    legal = torch.from_numpy(legal_bits(samples["legal"]))
    visits = torch.from_numpy(samples["visits"].astype(np.float32))
    result = torch.from_numpy(samples["result"].astype(np.float32))
    kind = torch.from_numpy(samples["kind"].astype(np.int64))
    return obs, legal, visits, result, kind


def losses(logits, value, legal, visits, result, kind, boundary_weight: float):
    """Policy cross-entropy against the normalised root visits over move
    samples, through the masked softmax so illegal actions carry no loss; and
    the value's squared error over all samples, a boundary sample's weighted.
    No weight decay here: the optimiser applies it, once."""
    moves = kind == 0
    if bool(moves.any()):
        lg = logits[moves].masked_fill(~legal[moves], float("-inf"))
        logp = torch.log_softmax(lg, dim=1)
        v = visits[moves]
        pi = v / v.sum(dim=1, keepdim=True).clamp_min(1.0)
        ce = -torch.where(legal[moves], pi * logp, torch.zeros_like(logp)).sum(dim=1)
        policy = ce.mean()
    else:
        policy = logits.sum() * 0.0
    weight = torch.where(kind == 1, torch.full_like(result, boundary_weight), torch.ones_like(result))
    value_loss = (weight * (value - result) ** 2).mean()
    return policy, value_loss


def optimiser(net: Net, config: dict):
    return torch.optim.SGD(net.parameters(), lr=config["learningRate"], momentum=config["momentum"],
                           weight_decay=config["weightDecay"])


def evaluate(net: Net, samples: np.ndarray, boundary_weight: float, chunk: int = 4096):
    """Mean policy and value losses over a set of samples, no training."""
    total_p = total_v = 0.0
    moves = int((samples["kind"] == 0).sum())
    with torch.no_grad():
        for i in range(0, len(samples), chunk):
            part = samples[i:i + chunk]
            obs, legal, visits, result, kind = batch_tensors(part)
            logits, value = net(obs)
            p, v = losses(logits, value, legal, visits, result, kind, boundary_weight)
            total_p += float(p) * int((part["kind"] == 0).sum())
            total_v += float(v) * len(part)
    return total_p / max(moves, 1), total_v / max(len(samples), 1)


def paths(run: Path, g: int):
    return {
        "checkpoint": run / "checkpoints" / f"{g}.bin",
        "parity": run / "checkpoints" / f"{g}.parity",
        "optimiser": run / "optimiser" / f"{g}.pt",
        "manifest": run / "generations" / f"{g}.json",
        "samples": run / "samples" / f"{g}.bin",
    }


def write_manifest(run: Path, g: int) -> None:
    """The commit point of a generation ([Z11-28] step 4): written last."""
    p = paths(run, g)
    write_json(p["manifest"], {
        "generation": g,
        "checkpoint": {"path": str(p["checkpoint"].relative_to(run)), "sha256": sha256(p["checkpoint"])},
        "parity": {"path": str(p["parity"].relative_to(run)), "sha256": sha256(p["parity"])},
        "optimiser": {"path": str(p["optimiser"].relative_to(run)), "sha256": sha256(p["optimiser"])},
    })


def save_optimiser(opt, path: Path) -> None:
    import io
    buf = io.BytesIO()
    torch.save(opt.state_dict(), buf)
    write_atomic(path, buf.getvalue())


def init_run(run: Path) -> None:
    """Checkpoint 0 at initialisation, its parity file, a fresh optimiser
    state, and the manifest ([Z11-58])."""
    config = json.loads((run / "config.json").read_text())
    torch.manual_seed(config["seed"] % (2**63))
    net = Net(config["width"], config["blocks"])
    p = paths(run, 0)
    write_checkpoint(net, 0, p["checkpoint"])
    save_optimiser(optimiser(net, config), p["optimiser"])
    write_manifest(run, 0)


def inherited_path(run: Path, k: int) -> Path:
    """A parent generation's samples, linked into this run's window ([Z11-66])."""
    return run / "inherited" / f"{k}.bin"


def init_from(run: Path, parent: Path, generation: int) -> None:
    """[Z11-66]: checkpoint 0 is the parent's checkpoint `generation`, relabelled
    generation 0, with a parity file of its own; generation 0's optimiser state
    is the parent's at that generation; and the parent's samples the config
    names are linked in to fill the window."""
    config = json.loads((run / "config.json").read_text())
    origin = config["from"]
    src = paths(parent, generation)
    if sha256(src["checkpoint"]) != origin["checkpointSha256"]:
        raise ValueError(f"{src['checkpoint']} is not the checkpoint the config names")
    net, header_generation = read_checkpoint(src["checkpoint"])
    if header_generation != generation:
        raise ValueError(f"{src['checkpoint']} says it is generation {header_generation}")
    p = paths(run, 0)
    write_checkpoint(net, 0, p["checkpoint"])
    write_atomic(p["optimiser"], src["optimiser"].read_bytes())
    for k in origin["windowGenerations"]:
        dest = inherited_path(run, k)
        dest.parent.mkdir(parents=True, exist_ok=True)
        # Sample files are never written again once complete, so a hard link
        # is as good as a copy and costs no space.
        try:
            os.link(paths(parent, k)["samples"], dest)
        except OSError:
            shutil.copyfile(paths(parent, k)["samples"], dest)
    write_manifest(run, 0)


def window_files(run: Path, config: dict, g: int) -> tuple[list[Path], list[int]]:
    """The sample files generation `g` trains on ([Z11-28] step 3): the last
    `window` generations of the run, and while it has fewer than that, the
    parent's latest ones before them ([Z11-66]). Also the parent generations used."""
    first = max(0, g - config["window"] + 1)
    own = [paths(run, k)["samples"] for k in range(first, g + 1) if paths(run, k)["samples"].exists()]
    need = config["window"] - (g + 1)
    origin = config.get("from")
    inherited = origin["windowGenerations"][-need:] if origin is not None and need > 0 else []
    return [inherited_path(run, k) for k in inherited] + own, inherited


def read_losses(run: Path) -> dict:
    f = run / "losses.json"
    return json.loads(f.read_text()) if f.exists() else {}


def train_generation(run: Path, g: int) -> None:
    """Steps 2 to 4 of [Z11-28] for generation `g`."""
    config = json.loads((run / "config.json").read_text())
    torch.set_num_threads(config.get("torchThreads", 4))
    torch.manual_seed((config["seed"] * 1_000_003 + g) % (2**63))
    rng = np.random.default_rng((config["seed"], g))
    # Its own stream, so the draws are the same with and without augmentation.
    perm_rng = np.random.default_rng((config["seed"], g, 1))
    p = paths(run, g)
    net, header_generation = read_checkpoint(p["checkpoint"])
    if header_generation != g:
        raise ValueError(f"checkpoint {g} says it is generation {header_generation}")
    bw = float(config["boundaryWeight"])

    first = max(0, g - config["window"] + 1)
    files, inherited = window_files(run, config, g)
    parts = [read_samples(f) for f in files]

    # Step 2: checkpoint g on its own samples, before training on them [Z11-54],
    # in total and by round beside the formula fitted on the rest of the window.
    record = read_losses(run)
    key = str(g)
    entry = record.get(key, {})
    own = read_samples(p["samples"])
    if "before" not in entry:
        pol, val = evaluate(net, own, bw)
        entry = {"generation": g, "before": {"policy": pol, "value": val, "samples": len(own)}}
    if "byRound" not in entry["before"]:
        fit = FitData()
        for f, part in zip(files, parts):
            if f != p["samples"]:
                fit.add(part)
        entry["before"]["byRound"] = value_by_round(predict_values(net, own), own, fit.weights())
    record[key] = entry
    write_json(run / "losses.json", record)

    # Step 3: the last `window` generations, `stepsPerGeneration` steps.
    window = np.concatenate(parts)
    del parts
    augment = config.get("augment", "none")
    if augment not in ("none", "displays"):
        raise ValueError(f"config: augment {augment!r} is neither none nor displays")
    opt = optimiser(net, config)
    opt.load_state_dict(torch.load(p["optimiser"]))
    steps, batch = config["stepsPerGeneration"], config["batch"]
    sum_p = sum_v = 0.0
    net.train()
    for _ in range(steps):
        idx = rng.integers(0, len(window), size=batch)
        drawn = window[idx]
        if augment == "displays":
            drawn = permute_samples(drawn, random_perms(perm_rng, batch))
        obs, legal, visits, result, kind = batch_tensors(drawn)
        logits, value = net(obs)
        pol, val = losses(logits, value, legal, visits, result, kind, bw)
        loss = pol + val
        opt.zero_grad(set_to_none=True)
        loss.backward()
        opt.step()
        sum_p += float(pol)
        sum_v += float(val)
        if not math.isfinite(float(loss)):
            raise FloatingPointError(f"generation {g}: the loss is {float(loss)}")
    entry["training"] = {"policy": sum_p / steps, "value": sum_v / steps, "steps": steps, "batch": batch}
    entry["window"] = {"generations": [first, g], "samples": int(len(window))}
    if inherited:
        entry["window"]["inherited"] = {"run": config["from"]["run"], "generations": inherited}
    entry["drawRatio"] = steps * batch / len(window)
    record[key] = entry

    # Step 4: optimiser, then checkpoint and parity, then the manifest.
    nxt = paths(run, g + 1)
    save_optimiser(opt, nxt["optimiser"])
    write_checkpoint(net, g + 1, nxt["checkpoint"])
    write_json(run / "losses.json", record)
    write_manifest(run, g + 1)
