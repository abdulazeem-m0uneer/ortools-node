# Changelog

All notable changes to this project are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `ortoolsVersion` (the OR-Tools release loaded at runtime) and `buildInfo`
  (the release the addon was compiled against). Loading fails with a clear error
  when the two differ.
- Builds and CI against both OR-Tools 9.14.6206 and 9.15.6755, on Linux x64 and
  arm64.
- Parameter objects: `defaultRoutingSearchParameters()`,
  `validateRoutingSearchParameters()`, `defaultSatParameters()` and
  `validateSatParameters()` work with plain objects in protobuf's JSON form
  (snake_case names accepted). Partial routing parameters are merged onto the
  OR-Tools defaults field by field: undefined or null keeps a default, and
  setting one member of a oneof replaces the others (the `Overrides<T>` input
  type allows null). NaN, enum numbers without a name, null array elements,
  ±Infinity outside float and double fields and values that are not JSON data
  are rejected with the field path, and OR-Tools itself validates every value.
- Enum constants `FirstSolutionStrategy`, `LocalSearchMetaheuristic` and
  `RoutingSearchStatus`, read from the OR-Tools build in use, and
  `durationMs(ms)` for protobuf Duration strings.
- `npm run typecheck` also compiles usage checks in `test/types/`.

### Changed

- Native sources are split by OR-Tools component under `src/`, and the JS layer
  under `lib/`. The public API is unchanged.

## [0.1.0] - 2026-10-16

First release.

### Added

- Native Node-API binding for the OR-Tools linear solver (`MPSolver`), built
  against OR-Tools 9.15.
- Backends: GLOP, PDLP, CLP, SCIP, CBC, HiGHS and CP-SAT, plus Gurobi and
  Xpress when installed and licensed.
- `Solver` API: continuous, integer and boolean variables; linear constraints
  and objectives written as term arrays, `Map`s or `{ terms, constant }`; time
  limits, thread count, backend parameters and solver logs.
- `solve()` runs on the libuv threadpool and returns a Promise; `solveSync()`
  blocks the calling thread.
- `interrupt()` stops a running solve on backends that support it safely (GLOP,
  PDLP, CP-SAT, Gurobi).
- `dispose()` and `Symbol.dispose` (`using`) free the native model immediately.
- Duals and reduced costs on LP backends; LP and MPS export.
- Strict error handling: reading a value with no current solution, using a
  handle from another solver or after `clear()` / `dispose()`, and invalid
  numbers all throw, and the model is left unchanged.
- TypeScript definitions.
- Benchmark against OR-Tools' official Python binding (`npm run bench`).

[Unreleased]: https://github.com/abdulazeem-m0uneer/ortools-node/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/abdulazeem-m0uneer/ortools-node/releases/tag/v0.1.0
