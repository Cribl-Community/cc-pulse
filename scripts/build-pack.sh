#!/usr/bin/env bash
# Builds the bundled Stream pack into public/ so the app can install it (GNU tar required).
set -euo pipefail; cd "$(dirname "$0")/../bundle/stream-pack"
TAR=$(command -v gtar || command -v tar)  # GNU tar: gtar on macOS (Homebrew), tar on Linux
"$TAR" --version 2>/dev/null | grep -q "GNU tar" || { echo "GNU tar required (macOS: brew install gnu-tar)" >&2; exit 1; }
"$TAR" -cz --exclude .DS_Store -f ../../public/cribl-pulse.crbl package.json README.md default data
echo "public/cribl-pulse.crbl $(wc -c < ../../public/cribl-pulse.crbl) bytes"
