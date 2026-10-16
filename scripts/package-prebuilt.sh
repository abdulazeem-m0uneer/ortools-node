#!/usr/bin/env bash
# Builds a prebuilt platform package (an npm tarball) for Linux <x64|arm64> and
# one OR-Tools release, inside the manylinux_2_28 image so it runs on glibc 2.28
# or newer. The package holds the addon, the OR-Tools shared libraries it needs
# (found with readelf, RUNPATH $ORIGIN) and their licences.
#
# Usage:   scripts/package-prebuilt.sh <x64|arm64> <ortools-version> [out-dir]
# Example: scripts/package-prebuilt.sh x64 9.15.6755
#
# The tarball lands in out-dir (default dist/). The addon is built with Node.js
# 22; it uses Node-API 8, so it also loads in newer Node.js releases. arm64 on
# an x64 host needs QEMU binfmt handlers (see scripts/ci-docker.sh) and is slow.
set -euo pipefail

usage='usage: scripts/package-prebuilt.sh <x64|arm64> <ortools-version> [out-dir]'
arch=${1:?$usage}
version=${2:?$usage}

case "$arch" in
  x64)   platform=linux/amd64; archive_arch=x86_64 ;;
  arm64) platform=linux/arm64; archive_arch=aarch64 ;;
  *) echo "Unknown arch '$arch' (expected x64 or arm64)" >&2; exit 2 ;;
esac

# shellcheck source=scripts/common.sh
source "$(dirname "$0")/common.sh"
out=${3:-$ortools_node_root/dist}
mkdir -p "$out"
out=$(cd "$out" && pwd)

# Google publishes the glibc 2.28 (AlmaLinux 8.10) archives for both CPUs.
archive=$(fetch_ortools_archive "or-tools_${archive_arch}_AlmaLinux-8.10_cpp_v${version}.tar.gz" "$version")
node_tarball=$(fetch_node "$arch" 22)

src=$(mktemp -d)
trap 'rm -rf "$src"' EXIT
copy_worktree "$src"

docker run --rm --platform "$platform" \
  -v "$src:/src:ro" \
  -v "$archive:/ortools.tar.gz:ro" \
  -v "$node_tarball:/node.tar.gz:ro" \
  -v "$out:/out" \
  -e TARGET="linux-${arch}-gnu" -e ORTOOLS_VERSION="$version" \
  -e HOST_UID="$(id -u)" -e HOST_GID="$(id -g)" \
  "quay.io/pypa/manylinux_2_28_${archive_arch}" \
  bash /src/scripts/prebuilt/build-in-container.sh
