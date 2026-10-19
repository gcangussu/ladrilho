#!/usr/bin/env bash
# Runs Python in the host's pinned environment of `requirements.txt` [0013 G13-7],
# as train/venv.sh does the trainer's [Z11-5]:
#
#   bash grzhx/host/venv.sh grzhx/host/host.py --cache ~/.cache/azul-grzhx
#
# The environment lives in `grzhx/host/.venv` and is built once, from binary
# wheels only and with every hash checked. It also holds the cmake that builds
# their library.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
VENV="$HERE/.venv"

if [ ! -x "$VENV/bin/python" ]; then
  if ! command -v uv >/dev/null 2>&1; then
    echo "grzhx/host/venv.sh needs uv (https://docs.astral.sh/uv/) to build $VENV" >&2
    exit 1
  fi
  uv venv --quiet --python 3.12 "$VENV"
  VIRTUAL_ENV="$VENV" uv pip install --quiet --only-binary :all: --require-hashes -r "$HERE/requirements.txt"
fi

exec "$VENV/bin/python" -I "$@"
