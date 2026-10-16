# shellcheck shell=bash
# Shared helpers for the scripts in this directory. Source it; do not run it.
# Downloads are cached in $ORTOOLS_NODE_CACHE (default ~/.cache/ortools-node).
# The fetch_* helpers are called inside $(...), where bash ignores `set -e`,
# so every step returns on failure explicitly.

ortools_node_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
ortools_node_cache=${ORTOOLS_NODE_CACHE:-$HOME/.cache/ortools-node}

# fetch_ortools_archive <archive-file-name> <ortools-version>
# Downloads an OR-Tools C++ release archive once, checks it against the pinned
# SHA-256 in .github/ortools-sha256.txt, and prints its cached path.
fetch_ortools_archive() {
  local archive=$1 version=$2 expected
  expected=$(grep -F " $archive" "$ortools_node_root/.github/ortools-sha256.txt" | cut -d' ' -f1 || true)
  if [[ -z "$expected" ]]; then
    echo "No pinned SHA-256 for $archive in .github/ortools-sha256.txt" >&2
    return 1
  fi
  mkdir -p "$ortools_node_cache" || return 1
  if [[ ! -f "$ortools_node_cache/$archive" ]]; then
    curl -fsSL --retry 3 -o "$ortools_node_cache/$archive.part" \
      "https://github.com/google/or-tools/releases/download/v${version%.*}/$archive" || return 1
    mv "$ortools_node_cache/$archive.part" "$ortools_node_cache/$archive" || return 1
  fi
  echo "$expected  $ortools_node_cache/$archive" | sha256sum --check --quiet - >&2 || return 1
  echo "$ortools_node_cache/$archive"
}

# fetch_node <x64|arm64> <node-major>
# Downloads the newest official Node.js <major> Linux tarball once, checks it
# against the release's SHASUMS256.txt, and prints its cached path.
fetch_node() {
  local arch=$1 major=$2 base sums line file
  base="https://nodejs.org/dist/latest-v${major}.x"
  sums=$(curl -fsSL --retry 3 "$base/SHASUMS256.txt") || return 1
  line=$(grep -E "  node-v[0-9.]+-linux-${arch}\.tar\.gz$" <<<"$sums" || true)
  if [[ -z "$line" ]]; then
    echo "No Node.js ${major} tarball for linux-${arch} in $base/SHASUMS256.txt" >&2
    return 1
  fi
  file=${line##* }
  mkdir -p "$ortools_node_cache" || return 1
  if [[ ! -f "$ortools_node_cache/$file" ]]; then
    curl -fsSL --retry 3 -o "$ortools_node_cache/$file.part" "$base/$file" || return 1
    mv "$ortools_node_cache/$file.part" "$ortools_node_cache/$file" || return 1
  fi
  (cd "$ortools_node_cache" && sha256sum --check --quiet - <<<"$line" >&2) || return 1
  echo "$ortools_node_cache/$file"
}

# copy_worktree <dest>
# Copies the working tree (tracked and untracked, minus ignored files) so a
# container builds exactly what is on disk and never writes into the checkout.
copy_worktree() {
  local dest=$1
  git -C "$ortools_node_root" ls-files -z -co --exclude-standard |
    (cd "$ortools_node_root" && while IFS= read -r -d '' f; do [[ -e "$f" ]] && printf '%s\0' "$f"; done) |
    (cd "$ortools_node_root" && xargs -0 cp --parents -t "$dest")
}
