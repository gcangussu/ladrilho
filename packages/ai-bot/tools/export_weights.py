"""Generates `src/weights.ts` from the checkpoint [A8-15], [A8-16].

    pnpm -F ai-bot weights

A deliberate act with a commit message, like [0005 M5-31]'s reference values:
the module it writes is the network this package plays, and regenerating it
from a different checkpoint would change how the expert plays without changing
a line anyone reads.

The module exports a base64 string and a frozen table, and nothing a session
could write to — a typed array cannot be frozen, so a module-level one would be
exactly the state [A8-3] forbids. Each session decodes its own arrays.

Alongside it, `test/fixtures/weights.json` records the `state_dict` as the
script read it, so [A8-16]'s test can fail when the table and the checkpoint
disagree.
"""

import base64
import json
import struct
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from upstream import CHECKPOINT, CHECKPOINT_SHA256, COMMIT, PACKAGE, upstream_dir, versions

# The buffers batch norm keeps for its own bookkeeping. They are integers, they
# say how many batches trained the layer, and nothing in a forward pass reads
# them [A8-16].
OMITTED = "num_batches_tracked"

HEADER = """/**
 * GENERATED FILE — do not edit. Written by `packages/ai-bot/tools/export_weights.py`
 * ([A8-15]), which refuses any checkpoint but the one recorded here.
 *
 * The network of the original: {repository}
 * at commit {commit}, checkpoint `{checkpoint}`,
 * sha256 {sha256}.
 *
 * MIT licensed, "Copyright (c) 2018 Surag Nair". The notice travels with these
 * weights in `packages/ai-bot/LICENSE.alpha-zero-general` ([A8-48]).
 *
 * Every tensor of the checkpoint's `state_dict` except its `{omitted}`
 * buffers, as little-endian float32, base64-encoded, concatenated in the order
 * of the table below. {count} values, {bytes} bytes.
 */

"""


def main() -> None:
    directory = upstream_dir()
    sys.path.insert(0, str(directory))
    import torch

    checkpoint = torch.load(directory / CHECKPOINT, map_location="cpu", weights_only=False)
    state = checkpoint["state_dict"]

    payload = bytearray()
    table = []
    recorded = []
    for name, tensor in state.items():
        shape = list(tensor.shape)
        recorded.append({"name": name, "shape": shape, "dtype": str(tensor.dtype)})
        if name.endswith(OMITTED):
            continue
        values = tensor.detach().flatten().tolist()
        table.append({"name": name, "shape": shape, "offset": len(payload) // 4})
        payload += struct.pack(f"<{len(values)}f", *values)

    count = len(payload) // 4
    lines = [
        HEADER.format(
            repository="cestpasphoto/alpha-zero-general",
            commit=COMMIT,
            checkpoint=CHECKPOINT,
            sha256=CHECKPOINT_SHA256,
            omitted=OMITTED,
            count=count,
            bytes=len(payload),
        ),
        "/** Every tensor, little-endian float32, base64. */\n",
        f"export const WEIGHTS_BASE64 =\n  '{base64.b64encode(bytes(payload)).decode()}';\n\n",
        "/** How many float32 values {@link WEIGHTS_BASE64} holds. */\n",
        f"export const WEIGHTS_COUNT = {count};\n\n",
        "/** Name, shape and offset (in values) of each tensor [A8-16]. */\n",
        "export const TENSORS = Object.freeze([\n",
    ]
    for entry in table:
        shape = ", ".join(str(n) for n in entry["shape"])
        lines.append(
            f"  Object.freeze({{ name: '{entry['name']}', "
            f"shape: Object.freeze([{shape}]), offset: {entry['offset']} }}),\n"
        )
    lines.append("]);\n")
    (PACKAGE / "src" / "weights.ts").write_text("".join(lines))

    fixtures = PACKAGE / "test" / "fixtures"
    fixtures.mkdir(parents=True, exist_ok=True)
    (fixtures / "weights.json").write_text(
        json.dumps(
            {
                "commit": COMMIT,
                "checkpoint": CHECKPOINT,
                "checkpointSha256": CHECKPOINT_SHA256,
                "omittedSuffix": OMITTED,
                "count": count,
                "versions": versions(),
                "stateDict": recorded,
            },
            indent=1,
        )
        + "\n"
    )
    print(f"wrote src/weights.ts: {len(table)} tensors, {count} values")


if __name__ == "__main__":
    main()
