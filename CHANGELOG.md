# Changelog

All notable changes to this project are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
