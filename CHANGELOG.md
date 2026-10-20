# Changelog

All notable changes to this project are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0] - 2026-10-20

Everything merged since 0.1.0: pull requests [#1] to [#11]. First release
published on npm, with prebuilt Linux x64 and arm64 packages.

### Added

- Reference documentation per module under `docs/`, with every JavaScript
  example run by the test suite, and tests that check the declarations against
  the runtime exports ([#10]).
- `npm run bench:dispatch`: caby-dispatch's routing, CP-SAT, graph and
  linear-solver spikes ported to Node and compared with Python OR-Tools on
  shared fixtures. The parity gate fails on any unexplained difference; results
  for 9.14 and 9.15 are in `bench/dispatch/RESULTS.md` ([#11]).

- Terminating a worker thread stops its running searches instead of waiting
  for their time limit (or forever, without one): async routing solves and CP
  `solveAsync()` are stopped by a teardown watch, as CP-SAT already was, and a
  synchronous routing or CP search stops at its first callback or JS monitor
  hook that can no longer run. ([#9])
- Routing progress events: `onProgress` and `progressIntervalMs` in the solve
  options report `{ solutions, objective, branches, failures, wallTimeMs, done }`
  from a native search monitor, at most once per interval and once more with
  `done: true` when the search ends. During an async solve progress events
  coalesce (at most one queued, carrying the latest values), so a slow listener
  never stalls the solver or grows memory. A throw stops the search and rejects.
  ([#9])
- Classic CP JS search monitors take 14 OR-Tools `SearchMonitor` hooks,
  camelCased: besides `enterSearch`, `exitSearch` and `atSolution`, now
  `beginNextDecision`, `endNextDecision`, `applyDecision`, `refuteDecision`,
  `afterDecision`, `beginFail`, `endFail`, `beginInitialPropagation`,
  `endInitialPropagation`, `acceptSolution` (return `false` to reject a
  solution) and `noMoreSolutions`. Decisions are passed as their description.
  Hooks are read once when the search starts, so a missing hook costs nothing;
  a throwing hook getter, or a hook that is neither undefined nor a function,
  throws from `solve()` / `newSearch()`. ([#9])
- `ortoolsVersion` (the OR-Tools release loaded at runtime) and `buildInfo`
  (the release the addon was compiled against). Loading fails with a clear error
  when the two differ. ([#1])
- Builds and CI against both OR-Tools 9.14.6206 and 9.15.6755, on Linux x64 and
  arm64. ([#1])
- Parameter objects: `defaultRoutingSearchParameters()`,
  `validateRoutingSearchParameters()`, `defaultSatParameters()` and
  `validateSatParameters()` work with plain objects in protobuf's JSON form
  (snake_case names accepted). Partial routing parameters are merged onto the
  OR-Tools defaults field by field: undefined or null keeps a default, and
  setting one member of a oneof replaces the others (the `Overrides<T>` input
  type allows null). NaN, enum numbers without a name, null array elements,
  ±Infinity outside float and double fields and values that are not JSON data
  are rejected with the field path, and OR-Tools itself validates every value.
  ([#2])
- Enum constants `FirstSolutionStrategy`, `LocalSearchMetaheuristic` and
  `RoutingSearchStatus`, read from the OR-Tools build in use, and
  `durationMs(ms)` for protobuf Duration strings. ([#2])
- `npm run typecheck` also compiles usage checks, now in `types-test/` (outside
  `test/`, so a bare `node --test` does not run them as tests). ([#2])
- Graph algorithms, mirroring Python's `ortools.graph.python` modules:
  `SimpleMinCostFlow`, `SimpleMaxFlow` and `SimpleLinearSumAssignment`, with
  bulk adders that take typed arrays, `solve()` on the threadpool (plus
  `solveSync()`), status constants on each class, and `dispose()`. ([#4])
- The graph classes validate every index, capacity, supply and cost before it
  reaches OR-Tools, so bad input throws a JS error instead of aborting the
  process, and results throw unless the last solve was OPTIMAL on the current
  graph. Running out of memory on a huge node index throws a RangeError, and
  user code run while reading array arguments (getters that dispose, solve or
  throw) cannot crash them. ([#4])
- `KnapsackSolver` (OR-Tools' `KnapsackSolver`): 0-1 knapsack problems with one
  or several dimensions, `solve()` off the main thread or `solveSync()`, time
  limit and reduction settings. `KnapsackSolverType` lists the solver types this
  build can run. Malformed problems throw JS errors instead of aborting. The
  profit returned is that of the packed items (OR-Tools truncates CP-SAT's
  objective), and `isSolutionOptimal()` is never true for CBC (its bounds can be
  wrong), XPRESS or CPLEX (unverified), nor for SCIP once the profit found
  reaches 1e4 (its 1e-4 gap). ([#5])
- `modelBuilder` (Python's `model_builder`): `Model` with variables, linear and
  enforced (indicator) constraints, objective, hints, `clone()`, LP / MPS export
  and import; `LinearExpr` builders (`sum`, `weightedSum`, `plus`, `times`,
  `le` / `ge` / `eq`...); `Solver` for any compiled-in backend with `solve()` off
  the main thread, `interrupt()`, time limit, values, duals, reduced costs and
  activities. Duals from HiGHS are withheld: OR-Tools reports them wrong. ([#5])
- `mathOpt` (Python's `mathopt`): `Model` with variables, linear constraints
  and a linear objective (ids never reused, deletion supported), `solve()` off
  the main thread with a `SolveInterrupter`, or `solveSync()` (which takes no
  interrupter: passing one is a `TypeError`), on every MathOpt
  solver this build can run (`SolverType`: GSCIP, GLOP, CP_SAT, PDLP, HIGHS...).
  `SolveParameters` and `ModelSolveParameters` are plain objects (time limit in
  seconds, LP algorithm and emphasis names, hints keyed by `Variable`); a
  `SolveResult` gives the termination, statistics, values, duals and reduced
  costs. MathOpt validates models and parameters; bad input is a JS error. ([#5])
- `modelBuilder` and `mathOpt` share one `LinearExpr` class. ([#5])
- `setCover` (Python's `set_cover`): `SetCoverModel`, `SetCoverInvariant` (a
  solution, copied from the model), the trivial, random, greedy, element-degree
  and lazy element-degree generators, steepest search, guided local and tabu
  search, `SetCoverMip` (or its LP relaxation for a lower bound), and
  `clearRandomSubsets` / `clearMostCoveredElements`. Runs go off the main
  thread with `nextSolution()`, or `nextSolutionSync()`. Inputs OR-Tools would
  abort or misbehave on (zero costs, repeated elements, uncovered elements,
  focuses its heuristics cannot handle) throw JS errors instead. ([#5])
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
  ([#5])
- CP-SAT: `CpModel` builds a `CpModelProto` the way Python's `cp_model` does,
  with integer, Boolean, constant and interval variables, `Domain`, linear
  expressions (`CpLinearExpr.sum()`, `weightedSum()`, `.plus()`, `.times()`,
  `.le()`, `.eq()`...), every CP-SAT constraint (linear, Boolean, all-different,
  element, circuit, routes, table, automaton, inverse, reservoir, min / max /
  abs / product / division / modulo, NoOverlap, NoOverlap2D, cumulative) with
  `onlyEnforceIf()`, objectives, hints, assumptions and decision strategies.
  int64 values are exact: numbers, or BigInts beyond 2^53.
  Interval start, size and end must be affine (at most one variable), as in
  Python; anything else throws a `TypeError` when the interval is built.
  Unlike Python, which reads `True` / `False` there as 1 / 0, a boolean start,
  size or end throws a `TypeError`: booleans are not integers. ([#6])
- `CpSolver`: `solve()` on the threadpool and `solveSync()`, `SatParameters` as
  a plain object (null keeps a field's default), `stopSearch()`, values
  (BigInts beyond 2^53), objective, bound and statistics.
  Invalid models throw OR-Tools' own message instead of aborting the process
  (`solve()` rejects with `Invalid CpModel: ...` rather than resolving
  `MODEL_INVALID` as Python does); values and `objectiveValue` throw when the
  last solve found no solution, and `bestObjectiveBound` after `INFEASIBLE`.
  Comparing with `==` either int64 extreme throws a `RangeError` where Python
  raises `ValueError`, and `>= INT64_MAX` or `<= INT64_MIN` a `RangeError` where
  Python raises `ArithmeticError`. Unlike Python,
  `< INT64_MIN` and `> INT64_MAX` are accepted and always false (empty domain,
  so the model is `INFEASIBLE`). ([#6])
- CP-SAT solution callbacks: `solve(model, { onSolution })` passes each solution
  to JS while the search runs; `stopSearch()` works from inside it, and an
  exception stops the search and rejects `solve()`. ([#6])
- Classic constraint programming solver under the `cp` namespace (`cp.CpSolver`,
  pywrapcp's `Solver`; the top-level `CpSolver` is CP-SAT's):
  integer variables and expressions, comparison, `allDifferent`,
  `allowedAssignments`, membership and reified constraints, `phase` decision
  builders, `minimize` / `maximize`, search limits, `searchLog`, solution
  collectors, synchronous `solve` and `newSearch` / `nextSolution` /
  `endSearch` with JS search monitors, and `solveAsync` on the threadpool with
  `interrupt()`. A domain change that empties a domain throws
  `CP solver failure` instead of aborting the process, and building or changing
  the model while a search is open throws. ([#7])
- Vehicle routing: `RoutingIndexManager` (single depot, or per-vehicle starts
  and ends) and `RoutingModel` with transit matrices, vectors and callbacks
  (evaluated once at registration, since solving runs off the JS thread;
  at most 16384 indices), arc
  and fixed costs, every `addDimension*` variant with span bounds, span costs
  and soft cumul bounds, pickup and delivery pairs and sets with policies,
  disjunctions, allowed vehicles, visit types with incompatibilities and
  requirements, soft same-vehicle costs, `addSameActivityGroup` (OR-Tools
  9.15+), finalizer variables, `applyLocks` / `applyLocksToAllVehicles`,
  `readAssignmentFromRoutes`, and model variables (`nextVar`, `vehicleVar`,
  `activeVar`, `cumulVar`...) usable as CP variables through `model.solver()`
  (a `cp.CpSolver`). ([#7])
- `solveWithParameters` / `solveFromAssignmentWithParameters` on the threadpool
  (plus `*Sync` variants) resolving to a `RoutingSolution` with bulk
  `routes()`, `cumuls()` and `slacks()` (values beyond 2^53 come back as
  bigints); `status()`; `interrupt()`; and an
  `onSolution` callback receiving a snapshot of each solution. Solutions become
  invalid after the next solve or any model change. Model-definition calls
  throw once the model is closed, and every argument OR-Tools would `CHECK` is
  validated first, so misuse throws instead of aborting the process. ([#7])
- Prebuilt binaries for Linux x64 and arm64 (glibc 2.28 or newer): platform
  packages such as `@ortools-node/linux-x64-gnu-ortools9.15` bundle the addon
  and the OR-Tools libraries, so installing needs no compiler and no
  `ORTOOLS_ROOT`. The OR-Tools 9.15 packages install automatically; 9.14 users
  install theirs at the same version as ortools-node
  (`npm install @ortools-node/linux-x64-gnu-ortools9.14@<version>`) and set
  `ORTOOLS_NODE_PIN=9.14` when both are present. A prebuilt at another version
  is not loaded; the error gives the exact install command. ([#8])
- The install step follows the loader's order: it keeps (or, with
  `ORTOOLS_ROOT`, rebuilds) an existing source build, else uses a matching
  prebuilt, else builds from source, and prints instructions only if that
  build fails. Loading reports every place it looked when
  no addon is found, and says that musl (Alpine) is not supported. ([#8])
- `scripts/package-prebuilt.sh` builds a platform package in the
  manylinux_2_28 image, and the Prebuilt binaries workflow builds and
  smoke-tests all of them in clean Debian 13 and Ubuntu 24.04 containers. ([#8])

- API reference per module in `docs/` (linear solver, graph, CP-SAT, classic
  CP with search monitors, routing, parameter objects, knapsack, set cover, bin
  packing, MathOpt, model builder, installation), linked from the README. A
  test runs every JavaScript example in the README and `docs/`, checks the
  output they show and their links, and another checks the TypeScript
  declarations against the runtime exports. `npm run typecheck` covers every declaration file.

### Changed

- The addon is located by `lib/loader.js` instead of the `bindings` package,
  which is no longer a dependency. With both a Debug and a Release build, the
  newer one loads (bindings always took Debug). ([#8])
- Native sources are split by OR-Tools component under `src/`, and the JS layer
  under `lib/`. The public API is unchanged. ([#1])

### Fixed

- The prebuilt smoke test no longer runs tests that need repository-only files
  (docs, benchmarks, TypeScript) against the installed package ([#11]).

- `new Solver('HIGHS')` no longer prints the HiGHS banner on every solve while
  output is off ([#5]).
- `dispose()` during a pending `solve()`, including the implicit one at the end
  of a `using` scope, no longer throws `Solver is busy`: the model is freed once
  that solve settles ([#3]). `Solver[Symbol.dispose]` is declared, so `using`
  type-checks ([#3]).
- A C++ exception inside OR-Tools (such as running out of memory on a huge
  model) no longer aborts the process: it throws a `RangeError` when out of
  memory and an `Error` otherwise, and an async `solve()` rejects ([#3]).
- Terminating a worker thread while one of its async solves is pending no
  longer aborts the whole process when the solve settles ([#3]).
- An unknown backend's error, and `supportsBackend()` called with a
  non-string, named the internal `supportsProblemType()`; both now name
  `supportsBackend()`.

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

[Unreleased]: https://github.com/abdulazeem-m0uneer/ortools-node/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/abdulazeem-m0uneer/ortools-node/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/abdulazeem-m0uneer/ortools-node/releases/tag/v0.1.0
[#1]: https://github.com/abdulazeem-m0uneer/ortools-node/pull/1
[#2]: https://github.com/abdulazeem-m0uneer/ortools-node/pull/2
[#3]: https://github.com/abdulazeem-m0uneer/ortools-node/pull/3
[#4]: https://github.com/abdulazeem-m0uneer/ortools-node/pull/4
[#5]: https://github.com/abdulazeem-m0uneer/ortools-node/pull/5
[#6]: https://github.com/abdulazeem-m0uneer/ortools-node/pull/6
[#7]: https://github.com/abdulazeem-m0uneer/ortools-node/pull/7
[#8]: https://github.com/abdulazeem-m0uneer/ortools-node/pull/8
[#9]: https://github.com/abdulazeem-m0uneer/ortools-node/pull/9
[#10]: https://github.com/abdulazeem-m0uneer/ortools-node/pull/10
[#11]: https://github.com/abdulazeem-m0uneer/ortools-node/pull/11
