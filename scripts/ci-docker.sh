#!/usr/bin/env bash
# Runs the CI test job locally in a clean Ubuntu 24.04 container (the GitHub
# runner's OS), with the same pinned OR-Tools archive as .github/workflows/ci.yml.
#
# Usage:   scripts/ci-docker.sh <x64|arm64> <ortools-version> [node-major]
# Example: scripts/ci-docker.sh arm64 9.15.6755 22
#
# arm64 on an x64 host needs QEMU >= 10 binfmt handlers, registered once per boot
# (QEMU 9.2 fails GNU tar 1.35 extraction with "Cannot open: Invalid argument"):
#   docker run --privileged --rm tonistiigi/binfmt:latest --install arm64
# Archives are cached in $ORTOOLS_NODE_CACHE (default ~/.cache/ortools-node).
set -euo pipefail

arch=${1:?usage: scripts/ci-docker.sh <x64|arm64> <ortools-version> [node-major]}
version=${2:?usage: scripts/ci-docker.sh <x64|arm64> <ortools-version> [node-major]}
node_major=${3:-22}

case "$arch" in
  x64)   platform=linux/amd64; archive_os=amd64_ubuntu-24.04;     node_arch=x64 ;;
  # Google publishes Linux arm64 C++ archives only for AlmaLinux 8.10.
  arm64) platform=linux/arm64; archive_os=aarch64_AlmaLinux-8.10; node_arch=arm64 ;;
  *) echo "Unknown arch '$arch' (expected x64 or arm64)" >&2; exit 2 ;;
esac

# shellcheck source=scripts/common.sh
source "$(dirname "$0")/common.sh"
archive=$(fetch_ortools_archive "or-tools_${archive_os}_cpp_v${version}.tar.gz" "$version")

src=$(mktemp -d)
trap 'rm -rf "$src"' EXIT
copy_worktree "$src"

docker run --rm --platform "$platform" \
  -v "$src:/src:ro" \
  -v "$archive:/ortools.tar.gz:ro" \
  -e NODE_MAJOR="$node_major" -e NODE_ARCH="$node_arch" -e EXPECTED_VERSION="$version" \
  ubuntu:24.04 bash -euo pipefail -c '
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -qq
    apt-get install -y -qq --no-install-recommends ca-certificates curl xz-utils g++ make cmake python3 >/dev/null

    node_tar=$(curl -fsSL "https://nodejs.org/dist/latest-v${NODE_MAJOR}.x/" |
      grep -o "node-v[0-9.]*-linux-${NODE_ARCH}\.tar\.xz" | head -1)
    curl -fsSL "https://nodejs.org/dist/latest-v${NODE_MAJOR}.x/${node_tar}" | tar -xJ -C /opt
    export PATH="/opt/${node_tar%.tar.xz}/bin:$PATH"

    mkdir -p /opt/or-tools
    tar -xzf /ortools.tar.gz -C /opt/or-tools --strip-components=1
    export ORTOOLS_ROOT=/opt/or-tools

    cp -r /src /work && cd /work
    echo "== node $(node --version), $(cmake --version | head -1), OR-Tools archive $EXPECTED_VERSION"
    npm ci
    npm test
    node -e "const v = require(\".\").ortoolsVersion; if (v !== process.env.EXPECTED_VERSION) throw new Error(v)"
    npm run typecheck
    npm run example >/dev/null
    echo "== CI job passed in container"
  '
