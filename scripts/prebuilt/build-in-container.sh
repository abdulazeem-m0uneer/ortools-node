#!/usr/bin/env bash
# Runs inside quay.io/pypa/manylinux_2_28_*; started by scripts/package-prebuilt.sh.
# Inputs: /src (a read-only copy of the checkout), /ortools.tar.gz (an OR-Tools
# AlmaLinux 8.10 C++ archive), /node.tar.gz (Node.js), /out (writable), and the
# environment TARGET (e.g. linux-x64-gnu), ORTOOLS_VERSION, HOST_UID, HOST_GID.
# $ORIGIN and the node -e programs are literal on purpose:
# shellcheck disable=SC2016
set -euo pipefail
export npm_config_update_notifier=false npm_config_fund=false npm_config_audit=false

mkdir -p /opt/node /opt/or-tools
tar -xzf /node.tar.gz -C /opt/node --strip-components=1
tar -xzf /ortools.tar.gz -C /opt/or-tools --strip-components=1
export PATH="/opt/node/bin:$PATH" ORTOOLS_ROOT=/opt/or-tools

cp -r /src /work
cd /work
echo "== $TARGET, OR-Tools $ORTOOLS_VERSION: node $(node --version), $(g++ --version | head -1), $(cmake --version | head -1)"
npm ci --ignore-scripts >/dev/null
if ! npx cmake-js rebuild --CDORTOOLS_NODE_PREBUILT=ON --parallel "$(nproc)" >build.log 2>&1; then
  tail -n 60 build.log
  exit 1
fi
grep -i 'warning' build.log || echo "== built with no warnings"

pkg=/work/pkg
node scripts/prebuilt/assemble.js "$TARGET" "$ORTOOLS_VERSION" build/Release/ortools_node.node "$ORTOOLS_ROOT" "$pkg"
strip --strip-debug "$pkg/ortools_node.node" "$pkg"/*.so*
# A few archive libraries (libutf8_validity, libsoplexshared, libz, libbz2) have
# no RUNPATH; give them $ORIGIN too so each finds its siblings on its own.
for lib in "$pkg"/*.so*; do
  if [[ "$(patchelf --print-rpath "$lib")" != '$ORIGIN' ]]; then
    patchelf --set-rpath '$ORIGIN' "$lib"
    echo "set RUNPATH \$ORIGIN on $(basename "$lib")"
  fi
done

echo "== checking the package"
for file in "$pkg/ortools_node.node" "$pkg"/*.so*; do
  dynamic=$(readelf -d "$file")
  runpath=$(sed -n 's/.*(RUNPATH).*\[\(.*\)\]$/\1/p' <<<"$dynamic")
  if [[ "$runpath" != '$ORIGIN' ]] || grep -q '(RPATH)' <<<"$dynamic"; then
    echo "$(basename "$file") must have RUNPATH \$ORIGIN and no RPATH; it has:" >&2
    grep -E '\((RUNPATH|RPATH)\)' <<<"$dynamic" >&2 || echo '  (neither)' >&2
    exit 1
  fi
done

# Hide the archive so every bundled library must resolve inside the package.
mv /opt/or-tools /opt/or-tools.hidden
for file in "$pkg/ortools_node.node" "$pkg"/*.so*; do
  while read -r name _ resolved _; do
    if [[ "$resolved" == "not" ]]; then
      echo "$(basename "$file") needs $name, which does not resolve" >&2
      exit 1
    fi
    if [[ -e "$pkg/$name" && "$resolved" != "$pkg/$name" ]]; then
      echo "$(basename "$file") resolves $name to $resolved instead of the bundled copy" >&2
      exit 1
    fi
  done < <(ldd "$file" | grep '=>')
done

# manylinux_2_28 means no glibc symbol newer than 2.28.
newest_glibc=$(objdump -T "$pkg/ortools_node.node" "$pkg"/*.so* | grep -o 'GLIBC_[0-9.]*' | sort -uV | tail -n 1)
if [[ "$(printf '%s\n' "$newest_glibc" GLIBC_2.28 | sort -V | tail -n 1)" != GLIBC_2.28 ]]; then
  echo "The package needs $newest_glibc; the floor is GLIBC_2.28" >&2
  exit 1
fi
newest_glibcxx=$(objdump -T "$pkg/ortools_node.node" "$pkg"/*.so* | grep -o 'GLIBCXX_[0-9.]*' | sort -uV | tail -n 1)
echo "== newest symbol versions needed: $newest_glibc, $newest_glibcxx"

# Load it from the package directory, as an installed package would be.
node -e '
  const addon = require(process.argv[1]);
  const { ortoolsVersion } = addon.buildInfo;
  if (ortoolsVersion !== process.env.ORTOOLS_VERSION) throw new Error(`built against ${ortoolsVersion}`);
  if (addon.ortoolsVersion !== ortoolsVersion) throw new Error(`loaded OR-Tools ${addon.ortoolsVersion}`);
' "$pkg/ortools_node.node"

cd "$pkg"
npm pack --json --pack-destination /out >/work/pack.json
node -e '
  const [info] = JSON.parse(require("fs").readFileSync("/work/pack.json", "utf8"));
  const mb = (n) => (n / 1048576).toFixed(1);
  console.log(`== ${info.filename}: ${info.entryCount} files, packed ${mb(info.size)} MB, unpacked ${mb(info.unpackedSize)} MB`);
  require("fs").writeFileSync("/work/tarball", info.filename);
'
chown "$HOST_UID:$HOST_GID" "/out/$(cat /work/tarball)"
