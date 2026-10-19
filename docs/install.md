# Installing and loading the addon

How `npm install ortools-node` gets a compiled addon, and how
`require('ortools-node')` finds it: a prebuilt platform package on Linux x64
and arm64 with glibc, a source build everywhere else. The steps to install are
in the [README](../README.md#installation); this page is the reference for what
happens and why.

> **Not yet published on npm; build from source until the first release**
> ([Building from source](../README.md#building-from-source)). The packages and
> install commands below describe the published package.

## Example

What loaded, and against which OR-Tools release:

```js
const { ortoolsVersion, buildInfo } = require('ortools-node');

console.log(ortoolsVersion === buildInfo.ortoolsVersion);  //=> true
console.log(/^9\.1[45]\.\d+$/.test(ortoolsVersion));        //=> true
console.log(buildInfo.napiVersion);                         //=> 8
```

From a shell: `node -p "require('ortools-node').buildInfo"`.

## Prebuilt packages

| Platform | OR-Tools 9.15 (installed automatically) | OR-Tools 9.14 (install it yourself) |
|---|---|---|
| Linux x64, glibc 2.28 or newer | `@ortools-node/linux-x64-gnu-ortools9.15` | `@ortools-node/linux-x64-gnu-ortools9.14` |
| Linux arm64, glibc 2.28 or newer | `@ortools-node/linux-arm64-gnu-ortools9.15` | `@ortools-node/linux-arm64-gnu-ortools9.14` |

Each package holds the addon (`ortools_node.node`) and the OR-Tools shared
libraries it links, so it needs no compiler and no `ORTOOLS_ROOT`. The 9.15
packages are optional dependencies of the published `ortools-node` (added when
it is packed, by `scripts/prebuilt/set-optional-deps.js`); npm installs the one
for your CPU. A 9.14 package is installed by hand at ortools-node's own version:
`npm install @ortools-node/linux-x64-gnu-ortools9.14@0.1.0`.

Rules:

- **Exact version.** A platform package loads only at exactly ortools-node's
  version; any other version is not loaded (there is no fallback to another
  release), and the error prints the `npm install name@version` to run.
- **Only next to ortools-node.** Packages are looked up in the `node_modules`
  directories above ortools-node itself, never through `NODE_PATH` or global
  folders.
- **Newest release wins.** With both 9.15 and 9.14 installed, 9.15 loads unless
  `ORTOOLS_NODE_PIN=9.14` is set.
- **glibc only.** musl systems (Alpine) and unknown C libraries get no
  prebuilt: use a glibc image such as `node:22-trixie-slim`, or build from
  source.

## Load order

`require('ortools-node')` loads the first of:

1. A **source build** in `build/Debug` or `build/Release` of the package. With
   both, the newer file loads (Debug on a tie), so `npm run build:debug` after
   `npm run build` takes effect.
2. The **prebuilt package** for this platform and OR-Tools release, chosen as
   above.

The addon then checks that the OR-Tools library it loaded is the release it was
compiled against, since the OR-Tools C++ API has no ABI stability across
releases.

## Install hook

`npm install` runs `scripts/install.js`, which decides with the same lookup as
the loader, so it acts on the addon that would load:

| Situation | What the hook does |
|---|---|
| `--build-from-source` or `--build-from-source=ortools-node` | Compiles from source, whatever is installed. A flag naming another package is ignored. |
| A source build exists, `ORTOOLS_ROOT` set | Recompiles it against `ORTOOLS_ROOT`. |
| A source build exists, no `ORTOOLS_ROOT` | Keeps it (`npm run build` recompiles). |
| A matching prebuilt is installed | Uses it; nothing is compiled. |
| Nothing to load, `ORTOOLS_ROOT` set | Compiles against `ORTOOLS_ROOT`. |
| Nothing to load, no `ORTOOLS_ROOT` | Tries a source build with CMake's own search (`CMAKE_PREFIX_PATH`, `ortools_DIR`, a system install) and prints what to do only if it fails. |
| `ORTOOLS_NODE_PIN` names a release without prebuilts | Warns and builds from source. |

Every message starts with `ortools-node:`. The hook's exit code is the
compiler's, so a failed source build fails the install.

## Environment variables

| Variable | Effect |
|---|---|
| `ORTOOLS_ROOT` | An extracted OR-Tools C++ release (with `include/` and `lib/cmake/ortools/`) to compile against. |
| `ORTOOLS_NODE_PIN` | `9.15` or `9.14`: the prebuilt release to load when several are installed. |
| `npm_config_build_from_source` | Set by `npm install --build-from-source`; see the table above. |

## Errors

| Situation | Error |
|---|---|
| No source build and no matching prebuilt | `Error: ortools-node: no compiled addon found. Tried: ...` listing every place, then the `npm install` command or the source-build steps; `err.code` is `ORTOOLS_NODE_ADDON_NOT_FOUND`. |
| A prebuilt at another version | Listed as `prebuilt NAME: version X is installed, but ortools-node is Y`, with `npm install NAME@Y` as the fix. |
| `ORTOOLS_NODE_PIN` not `9.15` or `9.14` | `Error: ORTOOLS_NODE_PIN=VALUE is not an OR-Tools release with prebuilt binaries; set it to one of 9.15, 9.14 or unset it`; `err.code` is `ORTOOLS_NODE_INVALID_PIN`. |
| An installed prebuilt without its addon file | `Error: NAME is installed at DIR but has no ortools_node.node; reinstall it` |
| The addon file fails to load (missing library, wrong ABI) | `Error: ortools-node: failed to load the addon from ORIGIN (PATH): MESSAGE`, with the loader's error as `cause`. |
| The OR-Tools library loaded is not the build's release | `Error: ortools-node was built against OR-Tools X but loaded OR-Tools Y; rebuild it (npm run rebuild)` |
| musl Linux | Listed as `Prebuilt binaries need glibc; musl-based Linux (such as Alpine) is not supported.` |
