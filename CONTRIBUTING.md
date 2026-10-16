# Contributing to ortools-node

Thank you for helping. Bug reports, benchmarks on other hardware, and pull
requests are all welcome.

## Reporting a bug

Open an issue that includes:

- your OS and CPU architecture, the Node.js version, and the OR-Tools release
  you built against;
- a minimal script that reproduces the problem. `solver.toLp()` output is often
  the quickest way to share a model;
- what you expected and what happened, including the full error message.

## Development setup

1. Follow [Installation](README.md#installation) to install a C++ toolchain and
   an OR-Tools C++ release, and set `ORTOOLS_ROOT`.
2. Then run:

   ```bash
   npm install        # builds the addon
   npm test           # node:test suite
   npm run typecheck  # checks lib/index.d.ts
   ```

The native code is in `src/`, one directory per OR-Tools component (for example
`src/linear_solver/`), with shared helpers in `src/common/` and module start-up
in `src/addon.cc`. The JavaScript API is in `lib/` (`lib/index.js` re-exports each
component), and the types in `lib/index.d.ts`. [How it works](README.md#how-it-works) explains
how the layers fit together and the rules for native code.

## Prebuilt binaries

`npm install ortools-node` needs no compiler on Linux x64 and arm64 with glibc
2.28 or newer: it installs a platform package such as
`@ortools-node/linux-x64-gnu-ortools9.15`, which holds the addon and the
OR-Tools shared libraries it links (RUNPATH `$ORIGIN`), with their licences.
There is one package per CPU and OR-Tools release. ortools-node lists the newest
release's packages in `optionalDependencies`; they are added by
`scripts/prebuilt/set-optional-deps.js` when packing a release, because
`npm ci` fails on dependencies the registry does not have yet.

- **Loading** (`lib/loader.js`): a local build in `build/Release` or
  `build/Debug` wins, then the platform package for this OS, CPU and C library.
  With several OR-Tools releases installed, the newest loads unless
  `ORTOOLS_NODE_PIN` names one (for example `ORTOOLS_NODE_PIN=9.14`). The
  package must have exactly ortools-node's version; otherwise the error names
  the `npm install <package>@<version>` to run. musl (Alpine) gets an error
  saying it is not supported.
- **Installing** (`scripts/install.js`, the npm `install` hook): skips the build
  when a platform package resolves, builds from source when `ORTOOLS_ROOT` is set
  or `npm install --build-from-source` is used, keeps an existing
  `build/Release` or `build/Debug` addon otherwise, and fails with what to do
  when there is none. An `ORTOOLS_NODE_PIN` without prebuilts only warns when
  `ORTOOLS_ROOT` is set or a source build exists. `npm run build` and `npm run rebuild` always build
  from source.
- **Building**: `scripts/package-prebuilt.sh <x64|arm64> <ortools-version>`
  builds the addon with `-DORTOOLS_NODE_PREBUILT=ON` in the
  `quay.io/pypa/manylinux_2_28` image against Google's AlmaLinux 8.10 archive,
  copies every library it needs (following `DT_NEEDED`), strips debug symbols,
  checks that everything resolves inside the package and needs no glibc newer
  than 2.28, then writes the npm tarball to `dist/`. Templates for the
  platform packages are in `npm/<target>/package.json`.
- **Testing**: `scripts/prebuilt/pack-main.sh` packs ortools-node as it would be
  published, and `scripts/smoke-prebuilt.sh <x64|arm64> <ortools-version> dist`
  installs both tarballs in clean `debian:trixie-slim` and `ubuntu:24.04`
  containers with no compiler and no `ORTOOLS_ROOT`, then runs the tests.

The [Prebuilt binaries workflow](.github/workflows/prebuild.yml) does all of
this for both CPUs and both OR-Tools releases on pull requests that touch the
packaging, and on demand. The [Publish workflow](.github/workflows/publish.yml)
runs it on a `v*` tag and, after approval on the `npm` environment, publishes
the tested tarballs.

## Pull requests

- Keep each pull request to one change, and include tests for it. Cover the
  error paths as well as the happy path.
- Keep `lib/`, `lib/index.d.ts`, the README API reference, and
  `CHANGELOG.md` (under *Unreleased*) in step with the change.
- `npm test` and `npm run typecheck` must pass. CI runs both on every supported
  Node.js version, OR-Tools version (9.14.6206 and 9.15.6755) and architecture
  (Linux x64 and arm64). To run that job locally in a clean Ubuntu 24.04
  container, use `scripts/ci-docker.sh <x64|arm64> <ortools-version>`; see the
  script header for arm64 emulation on an x64 machine.
- If the change can affect performance, run `npm run bench` before and after,
  and include both tables.
- Write commit messages in the
  [Conventional Commits](https://www.conventionalcommits.org/) style, for
  example `feat: add CP-SAT interval variables`.

## License

By contributing you agree that your contributions are licensed under the
[MIT License](LICENSE).
