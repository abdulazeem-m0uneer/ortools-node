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

The native code is in `src/addon.cc`, the JavaScript API in `lib/index.js`, and
the types in `lib/index.d.ts`. [How it works](README.md#how-it-works) explains
how the layers fit together and the rules for native code.

## Pull requests

- Keep each pull request to one change, and include tests for it. Cover the
  error paths as well as the happy path.
- Keep `lib/index.js`, `lib/index.d.ts`, the README API reference, and
  `CHANGELOG.md` (under *Unreleased*) in step with the change.
- `npm test` and `npm run typecheck` must pass. CI runs both on every supported
  Node.js version.
- If the change can affect performance, run `npm run bench` before and after,
  and include both tables.
- Write commit messages in the
  [Conventional Commits](https://www.conventionalcommits.org/) style, for
  example `feat: add CP-SAT interval variables`.

## License

By contributing you agree that your contributions are licensed under the
[MIT License](LICENSE).
