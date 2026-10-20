#!/usr/bin/env bash
# Installs a packed ortools-node and one prebuilt platform package in clean
# containers with no compiler and no ORTOOLS_ROOT, checks the install hook used
# the prebuilt, then runs the test suite against the installed package, with
# ORTOOLS_NODE_PIN set to the release under test.
#
# Usage:   scripts/smoke-prebuilt.sh <x64|arm64> <ortools-version> <tarball-dir> [image ...]
# Example: scripts/smoke-prebuilt.sh x64 9.15.6755 dist debian:trixie-slim
#
# tarball-dir holds ortools-node-<version>.tgz (scripts/prebuilt/pack-main.sh)
# and the platform tarball (scripts/package-prebuilt.sh). Images default to
# debian:trixie-slim and ubuntu:24.04. NODE_MAJOR (default 22) picks Node.js.
set -euo pipefail

usage='usage: scripts/smoke-prebuilt.sh <x64|arm64> <ortools-version> <tarball-dir> [image ...]'
arch=${1:?$usage}
version=${2:?$usage}
tarballs=$(cd "${3:?$usage}" && pwd)
shift 3
images=("$@")
[[ ${#images[@]} -gt 0 ]] || images=(debian:trixie-slim ubuntu:24.04)

case "$arch" in
  x64)   platform=linux/amd64 ;;
  arm64) platform=linux/arm64 ;;
  *) echo "Unknown arch '$arch' (expected x64 or arm64)" >&2; exit 2 ;;
esac

# exactly_one <dir> <glob>: the single file in dir matching glob, or an error.
exactly_one() {
  local matches=() f
  # shellcheck disable=SC2231 # $2 is a glob on purpose
  for f in "$1"/$2; do [[ -e "$f" ]] && matches+=("$f"); done
  if [[ ${#matches[@]} -ne 1 ]]; then
    echo "Expected exactly one $2 in $1, found ${#matches[@]}" >&2
    return 1
  fi
  echo "${matches[0]}"
}
main_tgz=$(exactly_one "$tarballs" 'ortools-node-[0-9]*.tgz')
platform_tgz=$(exactly_one "$tarballs" "ortools-nodejs-linux-${arch}-gnu-ortools${version%.*}-*.tgz")

# shellcheck source=scripts/common.sh
source "$(dirname "$0")/common.sh"
node_tarball=$(fetch_node "$arch" "${NODE_MAJOR:-22}")

src=$(mktemp -d)
trap 'rm -rf "$src"' EXIT
copy_worktree "$src"

for image in "${images[@]}"; do
  echo "== $image: $(basename "$main_tgz") + $(basename "$platform_tgz")"
  docker run --rm --platform "$platform" \
    -v "$src/test:/tests:ro" \
    -v "$node_tarball:/node.tar.gz:ro" \
    -v "$main_tgz:/pkgs/main.tgz:ro" \
    -v "$platform_tgz:/pkgs/platform.tgz:ro" \
    -e EXPECTED_VERSION="$version" \
    "$image" bash -euo pipefail -c '
      export npm_config_update_notifier=false npm_config_fund=false npm_config_audit=false
      unset ORTOOLS_ROOT
      # Pinned so the result does not depend on which optional prebuilts the
      # registry already has (the 9.15 ones install alongside a 9.14 tarball).
      export ORTOOLS_NODE_PIN=${EXPECTED_VERSION%.*}
      for tool in cc gcc g++ c++ clang cmake make; do
        if command -v "$tool" >/dev/null; then echo "$tool is installed; the image must have no build tools" >&2; exit 1; fi
      done
      mkdir -p /opt/node && tar -xzf /node.tar.gz -C /opt/node --strip-components=1
      export PATH="/opt/node/bin:$PATH"
      # Node.js 26 and newer need libatomic, which slim images leave out.
      if ldd /opt/node/bin/node | grep -q "libatomic.so.1 => not found"; then
        apt-get update -qq && apt-get install -y -qq --no-install-recommends libatomic1 >/dev/null
      fi
      grep PRETTY_NAME /etc/os-release
      echo "node $(node --version), $(ldd --version | head -n 1)"

      mkdir /app && cd /app && npm init -y >/dev/null
      npm install --foreground-scripts /pkgs/main.tgz /pkgs/platform.tgz 2>&1 | tee /tmp/install.log | tail -n 3
      grep -q "ortools-node: using the prebuilt addon from @ortools-nodejs/" /tmp/install.log ||
        { echo "the install hook did not use the prebuilt" >&2; exit 1; }

      cd node_modules/ortools-node
      cp -r /tests test
      # Tests that need files or tools the published package does not ship. A listed file
      # that no longer exists fails the smoke test, so the list cannot go stale.
      repo_only=(
        prebuilt-packaging.test.js     # the packaging scripts (scripts/prebuilt, scripts/*.sh)
        docs_examples.test.js          # docs/ and the README links into the repository
        types_runtime.test.js          # the typescript devDependency
        bench_dispatch.test.js         # bench/
        bench_dispatch_report.test.js  # bench/
      )
      for f in "${repo_only[@]}"; do
        [[ -f "test/$f" ]] || { echo "smoke-prebuilt.sh lists test/$f, which does not exist" >&2; exit 1; }
        rm "test/$f"
      done
      status=0
      npm test > /tmp/test.log 2>&1 || status=$?
      grep -E "^not ok|^\s*✖" /tmp/test.log || true
      # On failure, also print the reporter details (assertion messages, actual and expected).
      [[ $status -eq 0 ]] || awk "/✖ failing tests:/ { f = 1 } f && n++ < 150" /tmp/test.log
      tail -n 9 /tmp/test.log
      [[ $status -eq 0 ]] || { echo "npm test failed in the installed package" >&2; exit 1; }
      node -e "
        const ortools = require(\".\");
        const addon = Object.keys(require.cache).find((f) => f.endsWith(\".node\"));
        if (!addon.includes(\"/node_modules/@ortools-nodejs/\")) throw new Error(\"loaded \" + addon);
        if (ortools.ortoolsVersion !== process.env.EXPECTED_VERSION) throw new Error(ortools.ortoolsVersion);
        console.log(\"loaded OR-Tools \" + ortools.ortoolsVersion + \" from \" + addon);
      "
      echo "== smoke test passed"
    '
done
