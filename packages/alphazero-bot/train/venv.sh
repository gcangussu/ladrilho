#!/usr/bin/env bash
# Runs the trainer in the pinned environment of `requirements.txt` [Z11-5].
#
#   bash train/venv.sh -m azt.cli init --run first
#
# The environment lives in `train/.venv` and is built once, from binary wheels
# only and with every hash checked: a trainer that silently installed another
# torch, or a NumPy 2 that `tensor.numpy()` cannot talk to, would not be the
# pinned environment.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
VENV="$HERE/.venv"

if [ ! -x "$VENV/bin/python" ]; then
  if ! command -v uv >/dev/null 2>&1; then
    echo "train/venv.sh needs uv (https://docs.astral.sh/uv/) to build $VENV" >&2
    exit 1
  fi
  uv venv --quiet --python 3.12 "$VENV"
  VIRTUAL_ENV="$VENV" uv pip install --quiet --only-binary :all: --require-hashes -r "$HERE/requirements.txt"
fi

cd "$HERE"
exec "$VENV/bin/python" "$@"
