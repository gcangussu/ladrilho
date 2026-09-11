#!/usr/bin/env bash
# Runs a tool in the pinned environment of `requirements.txt` [A8-34].
#
#   bash tools/venv.sh tools/export_weights.py
#
# The environment lives in `tools/.venv` and is built once, from the pinned
# versions and binary wheels only — a tool that silently compiled a different
# numba against a different NumPy would not be the pinned environment.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
VENV="$HERE/.venv"

if [ ! -x "$VENV/bin/python" ]; then
  if ! command -v uv >/dev/null 2>&1; then
    echo "tools/venv.sh needs uv (https://docs.astral.sh/uv/) to build $VENV" >&2
    exit 1
  fi
  uv venv --quiet --python 3.12 "$VENV"
  VIRTUAL_ENV="$VENV" uv pip install --quiet --only-binary :all: -r "$HERE/requirements.txt"
fi

exec "$VENV/bin/python" "$@"
