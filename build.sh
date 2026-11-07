#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

if ! command -v vsce >/dev/null 2>&1; then
  printf '%s\n' 'vsce is required. Install it with: npm install --global @vscode/vsce' >&2
  exit 1
fi

PACKAGE_FILE="$(node -e 'const p = require("./package.json"); process.stdout.write(`${p.name}-${p.version}.vsix`);')"
mkdir -p build
vsce package --out "build/$PACKAGE_FILE"
