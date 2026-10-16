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
- Graph algorithms, mirroring Python's `ortools.graph.python` modules:
  `SimpleMinCostFlow`, `SimpleMaxFlow` and `SimpleLinearSumAssignment`, with
  bulk adders that take typed arrays, `solve()` on the threadpool (plus
  `solveSync()`), status constants on each class, and `dispose()`.
- The graph classes validate every index, capacity, supply and cost before it
  reaches OR-Tools, so bad input throws a JS error instead of aborting the
  process, and results throw unless the last solve was OPTIMAL on the current
  graph. Running out of memory on a huge node index throws a RangeError, and
  user code run while reading array arguments (getters that dispose, solve or
  throw) cannot crash them.
- `KnapsackSolver` (OR-Tools' `KnapsackSolver`): 0-1 knapsack problems with one
  or several dimensions, `solve()` off the main thread or `solveSync()`, time
  limit and reduction settings. `KnapsackSolverType` lists the solver types this
  build can run. Malformed problems throw JS errors instead of aborting. The
  profit returned is that of the packed items (OR-Tools truncates CP-SAT's
  objective), and `isSolutionOptimal()` is never true for CBC (its bounds can be
  wrong), XPRESS or CPLEX (unverified), nor for SCIP once the profit found
  reaches 1e4 (its 1e-4 gap).
- `modelBuilder` (Python's `model_builder`): `Model` with variables, linear and
  enforced (indicator) constraints, objective, hints, `clone()`, LP / MPS export
  and import; `LinearExpr` builders (`sum`, `weightedSum`, `plus`, `times`,
  `le` / `ge` / `eq`...); `Solver` for any compiled-in backend with `solve()` off
  the main thread, `interrupt()`, time limit, values, duals, reduced costs and
  activities. Duals from HiGHS are withheld: OR-Tools reports them wrong.
- `mathOpt` (Python's `mathopt`): `Model` with variables, linear constraints
  and a linear objective (ids never reused, deletion supported), `solve()` off
  the main thread with a `SolveInterrupter`, or `solveSync()`, on every MathOpt
  solver this build can run (`SolverType`: GSCIP, GLOP, CP_SAT, PDLP, HIGHS...).
  `SolveParameters` and `ModelSolveParameters` are plain objects (time limit in
  seconds, LP algorithm and emphasis names, hints keyed by `Variable`); a
  `SolveResult` gives the termination, statistics, values, duals and reduced
  costs. MathOpt validates models and parameters; bad input is a JS error.
- `modelBuilder` and `mathOpt` share one `LinearExpr` class.
- `setCover` (Python's `set_cover`): `SetCoverModel`, `SetCoverInvariant` (a
  solution, copied from the model), the trivial, random, greedy, element-degree
  and lazy element-degree generators, steepest search, guided local and tabu
  search, `SetCoverMip` (or its LP relaxation for a lower bound), and
  `clearRandomSubsets` / `clearMostCoveredElements`. Runs go off the main
  thread with `nextSolution()`, or `nextSolutionSync()`. Inputs OR-Tools would
  abort or misbehave on (zero costs, repeated elements, uncovered elements,
  focuses its heuristics cannot handle) throw JS errors instead.
- `solveVectorBinPacking()` / `solveVectorBinPackingSync()`: vector bin
  packing with OR-Tools' arc-flow formulation on a MIP backend
  (`VectorBinPackingSolverType`), taking a `VectorBinPackingProblem` and
  returning a `VectorBinPackingSolution` as plain objects; solver type, time
  limit, threads and backend parameters as options. Problems OR-Tools would
  abort on are rejected, and those where nothing can be packed get an exact
  answer without it. The backend's log goes to stdout only with
  `enableOutput: true` (OR-Tools would always enable it). On OR-Tools 9.14
  HiGHS prints only its banner whatever `enableOutput` says (that release's
  HiGHS interface ignores it); `new Solver('HIGHS')` prints that banner too.
- CP-SAT: `CpModel` builds a `CpModelProto` the way Python's `cp_model` does,
  with integer, Boolean, constant and interval variables, `Domain`, linear
  expressions (`CpLinearExpr.sum()`, `weightedSum()`, `.plus()`, `.times()`,
  `.le()`, `.eq()`...), every CP-SAT constraint (linear, Boolean, all-different,
  element, circuit, routes, table, automaton, inverse, reservoir, min / max /
  abs / product / division / modulo, NoOverlap, NoOverlap2D, cumulative) with
  `onlyEnforceIf()`, objectives, hints, assumptions and decision strategies.
  int64 values are exact: numbers, or BigInts beyond 2^53.
- `CpSolver`: `solve()` on the threadpool and `solveSync()`, `SatParameters` as
  a plain object, `stopSearch()`, values (BigInts beyond 2^53), objective,
  bound and statistics.
  Invalid models throw OR-Tools' own message instead of aborting the process;
  values throw when the last solve found no solution.
- CP-SAT solution callbacks: `solve(model, { onSolution })` passes each solution
  to JS while the search runs; `stopSearch()` works from inside it, and an
  exception stops the search and rejects `solve()`.

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
