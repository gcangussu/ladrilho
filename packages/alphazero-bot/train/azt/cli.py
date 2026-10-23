"""The trainer's commands, run by the loop through `venv.sh`:

    python -m azt.cli init --run-dir <runs/name> [--from-run-dir <runs/parent> --from-generation G]
    python -m azt.cli generation --run-dir <runs/name> --generation G
    python -m azt.cli fixture --out <path/checkpoint.bin>
    python -m azt.cli panel <checkpoint.bin> [--against <checkpoint.bin>] [--json <out.json>]
"""

import argparse
import json
from pathlib import Path

import torch

from .formats import write_atomic, write_checkpoint
from . import panel
from .model import Net
from .train import init_from, init_run, train_generation


def main() -> None:
    ap = argparse.ArgumentParser(prog="azt")
    sub = ap.add_subparsers(dest="command", required=True)
    a = sub.add_parser("init")
    a.add_argument("--run-dir", required=True)
    a.add_argument("--from-run-dir")
    a.add_argument("--from-generation", type=int)
    b = sub.add_parser("generation")
    b.add_argument("--run-dir", required=True)
    b.add_argument("--generation", type=int, required=True)
    c = sub.add_parser("fixture")
    c.add_argument("--out", required=True)
    d = sub.add_parser("panel")
    d.add_argument("checkpoint")
    d.add_argument("--against")
    d.add_argument("--json")
    args = ap.parse_args()
    if args.command == "init":
        if (args.from_run_dir is None) != (args.from_generation is None):
            ap.error("--from-run-dir and --from-generation go together")
        if args.from_run_dir is None:
            init_run(Path(args.run_dir))
        else:
            init_from(Path(args.run_dir), Path(args.from_run_dir), args.from_generation)
    elif args.command == "panel":
        # [Z11-83]: the value against the measured win probability.
        positions = panel.read_panel()
        v = panel.values(panel.load_checked(Path(args.checkpoint)), positions["obs"])
        against = None if args.against is None else panel.values(panel.load_checked(Path(args.against)), positions["obs"])
        rows = panel.score(v, positions, against)
        print(panel.table(rows))
        if args.json is not None:
            write_atomic(Path(args.json), (json.dumps(rows, indent=1) + "\n").encode())
    elif args.command == "generation":
        train_generation(Path(args.run_dir), args.generation)
    else:
        # [Z11-44]'s fixture: small, random, exported once and committed.
        torch.manual_seed(20260929)
        write_checkpoint(Net(16, 1), 0, Path(args.out))


if __name__ == "__main__":
    main()
