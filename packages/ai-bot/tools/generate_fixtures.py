"""The fixture generator [A8-34].

    pnpm -F ai-bot fixtures

Run on purpose, never by a test. It takes the position corpus that
`export-positions.mjs` wrote from **our** games, hands each position to the
original at the pinned commit, and records what the original did with it:
the board it holds, the moves it considers legal, and what its network
returns.

What it writes, under `test/fixtures/`:
  manifest.json   everything readable: games as seed + actions, the record
                  index, the constants, the versions, the checksums
  boards.i8       the original's board per record, 138 int8
  next.i8         its board after the ply our game played, canonical, 138 int8
  masks.u8        its `valid_moves` per record, 180 bytes of 0/1
  policy.f32      the raw policy its network returned, 180 little-endian float32
  value.f32       the value it returned, 2 little-endian float32

The searches of [A8-38] and the next boards of [A8-36] are recorded by the
same tool and land with the chunks that consume them.
"""

import json
import struct
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from encoder import encode, their_action
from upstream import (
    CHECKPOINT,
    CHECKPOINT_SHA256,
    COMMIT,
    LICENSE_SHA256,
    PACKAGE,
    REPOSITORY,
    sha256,
    upstream_dir,
    versions,
)

TOOLS = PACKAGE / "tools"
FIXTURES = PACKAGE / "test" / "fixtures"


def constants(mcts_module, board_class) -> dict:
    """The constants table of spec 0008, read from the original [A8-34]."""
    # A board both seats have finished, with equal scores and equal complete
    # rows: `check_end_game`'s draw.
    drawn = np.zeros((23, 6), dtype=np.int8)
    drawn[13, :5] = 1
    drawn[18, :5] = 1
    board = board_class()
    board.copy_state(drawn, False)
    outcome = board.check_end_game()
    assert outcome[0] == outcome[1], "the posed board is not a draw"
    return {
        "k": float(mcts_module.k),
        "EPS": float(mcts_module.EPS),
        "NAN": float(mcts_module.NAN),
        "universeSeed": int(mcts_module.magic_seeds[0]),
        "drawValue": float(outcome[0]),
        "drawValueDtype": str(outcome.dtype),
    }


def main() -> None:
    directory = upstream_dir()
    if sha256(directory / "LICENSE") != LICENSE_SHA256:
        raise SystemExit("upstream's LICENSE is not the pinned file")
    sys.path.insert(0, str(directory))
    import os

    os.chdir(directory)

    import MCTS
    from azul.AzulGame import AzulGame
    from azul.AzulLogicNumba import Board
    from azul.NNet import NNetWrapper

    work = json.loads((TOOLS / ".work" / "positions.json").read_text())
    game = AzulGame()
    net = NNetWrapper(
        game, dict(lr=None, dropout=0.0, epochs=None, batch_size=None, nn_version=-1)
    )
    checkpoint = net.load_checkpoint("azul", "pretrained.pt")
    settings = {
        "numMCTSSims": int(checkpoint["numMCTSSims"]),
        "cpuct": float(checkpoint["cpuct"]),
        "fpu": float(checkpoint["fpu"]),
        "forcedPlayouts": bool(checkpoint["forced_playouts"]),
        "universes": int(checkpoint["universes"]),
        "nn_version": int(checkpoint["nn_version"]),
        "temperature": [float(t) for t in checkpoint["temperature"]],
        **constants(MCTS, Board),
    }

    initial = game.getInitBoard().copy()

    played = {(g["id"], ply): action for g in work["games"] for ply, action in enumerate(g["actions"])}

    boards, masks, policies, values, index = bytearray(), bytearray(), bytearray(), bytearray(), []
    nexts = bytearray()
    for record in work["positions"]:
        position = record["position"]
        board = encode(position)
        valid = game.getValidMoves(board, 0)
        pi, v = net.predict(board, valid)
        boards += board.tobytes()
        masks += bytes(1 if bit else 0 for bit in valid)
        policies += struct.pack("<180f", *[float(p) for p in pi])
        values += struct.pack("<2f", *[float(x) for x in v])

        # The ply our game actually played, applied by the original with the
        # universe draw, exactly as its search applies one: `make_move(a, 0,
        # random_seed)` on the canonical board, then the canonical form of what
        # comes back [A8-36].
        action = their_action(played[(record["game"], record["ply"])])
        assert valid[action], f"{record['game']} ply {record['ply']}: the original calls it illegal"
        after, next_player = game.getNextState(board, 0, action, random_seed=settings["universeSeed"])
        canonical = game.getCanonicalForm(after, next_player)
        nexts += np.asarray(canonical, dtype=np.int8).tobytes()
        index.append(
            {
                "game": record["game"],
                "ply": record["ply"],
                # 0 when the original leaves the same seat to move, which is
                # how [A8-36] recognises `no-centre-take` without either side
                # deciding a rule for the other.
                "theirNextPlayer": int(next_player),
            }
        )

    FIXTURES.mkdir(parents=True, exist_ok=True)
    (FIXTURES / "boards.i8").write_bytes(bytes(boards))
    (FIXTURES / "next.i8").write_bytes(bytes(nexts))
    (FIXTURES / "masks.u8").write_bytes(bytes(masks))
    (FIXTURES / "policy.f32").write_bytes(bytes(policies))
    (FIXTURES / "value.f32").write_bytes(bytes(values))
    manifest = {
        "upstream": {"repository": REPOSITORY, "commit": COMMIT},
        "checkpoint": {"path": CHECKPOINT, "sha256": CHECKPOINT_SHA256},
        # Computed from the pinned checkout, so [A8-48]'s test compares our
        # copy against the original's file rather than against a constant
        # somebody typed twice.
        "licenseSha256": sha256(directory / "LICENSE"),
        "versions": versions(),
        "constants": settings,
        "initialBoard": [int(x) for x in initial.flatten()],
        "games": [
            {
                "id": g["id"],
                "seed": g["seed"],
                "players": g["players"],
                "actions": g["actions"],
                "deals": g["deals"],
            }
            for g in work["games"]
        ],
        "coverage": work["coverage"],
        "records": index,
        "files": {
            "boards": {"name": "boards.i8", "stride": 138, "type": "int8"},
            "next": {"name": "next.i8", "stride": 138, "type": "int8"},
            "masks": {"name": "masks.u8", "stride": 180, "type": "uint8"},
            "policy": {"name": "policy.f32", "stride": 180, "type": "float32"},
            "value": {"name": "value.f32", "stride": 2, "type": "float32"},
        },
    }
    (FIXTURES / "manifest.json").write_text(json.dumps(manifest, indent=1) + "\n")
    print(f"{len(index)} positions from {len(work['games'])} games")


if __name__ == "__main__":
    main()
