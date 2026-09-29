"""The files the trainer shares with the crate: checkpoints ([Z11-11]), the
parity corpus ([Z11-55]) and parity files ([Z11-12]), and samples ([Z11-27]).

Everything is little-endian, and every file is written to a temporary name and
renamed when complete ([Z11-30]).
"""

import hashlib
import json
import os
import struct
from pathlib import Path

import numpy as np
import torch

from .model import INPUT, POLICY, VALUE_HIDDEN, Net

HERE = Path(__file__).resolve().parent.parent
CORPUS = HERE / "parity-corpus.bin"
LEGAL_BYTES = 23

SAMPLE = np.dtype([
    ("kind", "u1"),
    ("result", "i1"),
    ("obs", "<f4", (INPUT,)),
    ("legal", "u1", (LEGAL_BYTES,)),
    ("visits", "<u2", (POLICY,)),
])
assert SAMPLE.itemsize == 1113


def write_atomic(path: Path, data: bytes) -> None:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f"{path.name}.tmp-{os.getpid()}")
    with open(tmp, "wb") as f:
        f.write(data)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)


def write_json(path: Path, value) -> None:
    write_atomic(path, (json.dumps(value, indent=2) + "\n").encode())


def sha256(path: Path) -> str:
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def checkpoint_bytes(net: Net, generation: int) -> bytes:
    header = b"AZ11" + struct.pack("<7I", 1, INPUT, net.width, len(net.blocks), POLICY,
                                   VALUE_HIDDEN, generation)
    body = b"".join(t.detach().to(torch.float32).contiguous().cpu().numpy().astype("<f4").tobytes()
                    for t in net.tensors())
    return header + body


def read_checkpoint(path: Path) -> tuple[Net, int]:
    data = Path(path).read_bytes()
    if data[:4] != b"AZ11":
        raise ValueError(f"{path}: magic is not AZ11")
    version, inp, width, blocks, policy, hidden, generation = struct.unpack_from("<7I", data, 4)
    if (version, inp, policy, hidden) != (1, INPUT, POLICY, VALUE_HIDDEN):
        raise ValueError(f"{path}: header {(version, inp, policy, hidden)}")
    net = Net(width, blocks)
    floats = np.frombuffer(data, dtype="<f4", offset=32)
    at = 0
    with torch.no_grad():
        for t in net.tensors():
            n = t.numel()
            if at + n > floats.size:
                raise ValueError(f"{path}: shorter than its header implies")
            t.copy_(torch.from_numpy(floats[at:at + n].copy()).view_as(t))
            at += n
    if at != floats.size:
        raise ValueError(f"{path}: longer than its header implies")
    return net, generation


def read_corpus() -> tuple[np.ndarray, np.ndarray, bytes]:
    """The observations, the legal masks, and the corpus's sha256."""
    data = CORPUS.read_bytes()
    if data[:4] != b"AZPC" or struct.unpack_from("<2I", data, 4) != (1, 64):
        raise ValueError("the parity corpus's header")
    entry = np.dtype([("obs", "<f4", (INPUT,)), ("legal", "u1", (LEGAL_BYTES,))])
    entries = np.frombuffer(data, dtype=entry, offset=12)
    return entries["obs"].copy(), entries["legal"].copy(), hashlib.sha256(data).digest()


def parity_bytes(net: Net) -> bytes:
    """PyTorch's logits and value on every corpus entry ([Z11-12])."""
    obs, _, digest = read_corpus()
    with torch.no_grad():
        logits, value = net(torch.from_numpy(obs))
    out = [b"AZPF", struct.pack("<I", 1), digest, struct.pack("<I", obs.shape[0])]
    both = torch.cat([logits, value.unsqueeze(1)], dim=1).numpy().astype("<f4")
    out.append(both.tobytes())
    return b"".join(out)


def write_checkpoint(net: Net, generation: int, path: Path) -> None:
    """A checkpoint and, beside it, its parity file."""
    path = Path(path)
    write_atomic(path, checkpoint_bytes(net, generation))
    write_atomic(path.with_suffix(".parity"), parity_bytes(net))


def read_samples(path: Path) -> np.ndarray:
    data = Path(path).read_bytes()
    if len(data) % SAMPLE.itemsize:
        raise ValueError(f"{path}: not a whole number of records")
    return np.frombuffer(data, dtype=SAMPLE)


def legal_bits(masks: np.ndarray) -> np.ndarray:
    """`[n, 23]` bytes to `[n, 180]` booleans: action `a` at bit `a % 8` of byte `a // 8`."""
    bits = np.unpackbits(masks, axis=1, bitorder="little")
    return bits[:, :POLICY].astype(bool)
