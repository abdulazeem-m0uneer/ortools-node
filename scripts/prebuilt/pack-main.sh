#!/usr/bin/env bash
# Packs ortools-node as it would be published: the working tree with the
# prebuilt packages added to optionalDependencies (scripts/prebuilt/set-optional-deps.js).
# The checkout itself is not modified.
#
# Usage: scripts/prebuilt/pack-main.sh [out-dir]   (default dist/)
set -euo pipefail

# shellcheck source=scripts/common.sh
source "$(dirname "$0")/../common.sh"
out=${1:-$ortools_node_root/dist}
mkdir -p "$out"
out=$(cd "$out" && pwd)

src=$(mktemp -d)
trap 'rm -rf "$src"' EXIT
copy_worktree "$src"
node "$src/scripts/prebuilt/set-optional-deps.js" "$src/package.json"
(cd "$src" && npm pack --ignore-scripts --pack-destination "$out")
