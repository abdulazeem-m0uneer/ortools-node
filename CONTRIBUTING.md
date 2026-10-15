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
