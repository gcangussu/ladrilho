"""What the original is, and where this machine keeps it [A8-34].

Every tool here is pinned to one commit of
https://github.com/cestpasphoto/alpha-zero-general and one checkpoint, and
refuses to run against anything else. A fixture generated from a different
commit is not evidence about the player this package ports.

The checkout lives wherever `AZUL_UPSTREAM` says, or in `tools/.upstream`,
which is not committed. It is cloned on first use.
"""

import hashlib
import os
import subprocess
from pathlib import Path

REPOSITORY = "https://github.com/cestpasphoto/alpha-zero-general.git"
COMMIT = "5d6d1f129b76659837f6afd6fb082e8da57e5428"
CHECKPOINT = "azul/pretrained.pt"
CHECKPOINT_SHA256 = "7d2fbf9203e46837668cd5b8f7bb29b7ea6f9e500f25f148c79e0038a76fe2f9"
LICENSE_SHA256 = "032f110f14ced6c9199c4f1650baa30be60982d883184c1310c7455493e3e5eb"

TOOLS = Path(__file__).resolve().parent
PACKAGE = TOOLS.parent


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def upstream_dir() -> Path:
    """The pinned checkout, cloned if this machine has none."""
    directory = Path(os.environ.get("AZUL_UPSTREAM", TOOLS / ".upstream")).resolve()
    if not (directory / ".git").exists():
        directory.parent.mkdir(parents=True, exist_ok=True)
        subprocess.run(["git", "clone", "--quiet", REPOSITORY, str(directory)], check=True)
    head = subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=directory, check=True, capture_output=True, text=True
    ).stdout.strip()
    if head != COMMIT:
        subprocess.run(["git", "checkout", "--quiet", COMMIT], cwd=directory, check=True)
    checkpoint = directory / CHECKPOINT
    actual = sha256(checkpoint)
    if actual != CHECKPOINT_SHA256:
        raise SystemExit(
            f"{checkpoint} has sha256 {actual}, not the pinned {CHECKPOINT_SHA256}. "
            "This is not the checkpoint spec 0008 describes; refusing to run."
        )
    return directory


def versions() -> dict:
    """The pinned environment, recorded in every manifest [A8-34]."""
    import sys

    import numpy
    import numba
    import onnx
    import onnxruntime
    import torch

    if not numpy.__version__.startswith("2."):
        raise SystemExit(f"numpy must be 2.x, not {numpy.__version__} — see [A8-50]")
    return {
        "python": sys.version.split()[0],
        "numpy": numpy.__version__,
        "numba": numba.__version__,
        "torch": torch.__version__,
        "onnx": onnx.__version__,
        "onnxruntime": onnxruntime.__version__,
    }
