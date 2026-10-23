#!/usr/bin/env sh
set -eu

APP_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PYTHON_BIN=${PYTHON_EXECUTABLE:-python3}
WHEELHOUSE="$APP_DIR/python-tools/di-spatiotemporal/wheelhouse"
REQUIREMENTS="$APP_DIR/python-tools/di-spatiotemporal/requirements.txt"

if [ ! -d "$WHEELHOUSE" ]; then
    echo "Offline wheelhouse not found: $WHEELHOUSE" >&2
    echo "Build the release with npm run pack:offline first." >&2
    exit 1
fi

"$PYTHON_BIN" -m pip install --no-index --find-links "$WHEELHOUSE" --upgrade pip
"$PYTHON_BIN" -m pip install --no-index --find-links "$WHEELHOUSE" -r "$REQUIREMENTS"
