# ortools-node

[![CI](https://github.com/abdulazeem-m0uneer/ortools-node/actions/workflows/ci.yml/badge.svg)](https://github.com/abdulazeem-m0uneer/ortools-node/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Node.js](https://img.shields.io/badge/node-%E2%89%A522-339933?logo=node.js&logoColor=white)
![OR-Tools](https://img.shields.io/badge/OR--Tools-9.15-4285F4)

**Native Node.js bindings for [Google OR-Tools](https://developers.google.com/optimization)**:
linear and mixed-integer programming with GLOP, PDLP, CLP, SCIP, CBC, HiGHS and
CP-SAT, plus Gurobi, CPLEX or Xpress where your OR-Tools build can load them,
all behind one API, and the constraint programming solver with vehicle routing.

Google publishes official OR-Tools bindings for C++, Python, Java and .NET, but
not for Node.js. `ortools-node` calls the OR-Tools C++ library directly through
Node-API: there is no Python bridge, no subprocess and no WebAssembly port.

```js
const { Solver } = require('ortools-node');

const solver = new Solver('SCIP');
const x = solver.intVar(0, 10, 'x');
const y = solver.intVar(0, 10, 'y');
solver.addLessEq([[x, 1], [y, 2]], 14);   // x + 2y <= 14
solver.maximize([[x, 3], [y, 4]]);        // max 3x + 4y

const result = await solver.solve();      // runs off the main thread
console.log(result.status, result.objectiveValue, x.value(), y.value());
// OPTIMAL 38 10 2
```

> **Status: 0.1.0, early release.** The API is tested on Linux x64 with
> OR-Tools 9.15 and Node.js 22, 24 and 26. Installing builds the addon from source against
> an OR-Tools C++ release you download yourself. Prebuilt binaries, macOS and
> Windows CI are on the [roadmap](#roadmap).

## Contents

- [Features](#features)
- [Performance](#performance)
- [Installation](#installation)
- [Usage](#usage)
- [API reference](#api-reference)
- [Solver backends](#solver-backends)
- [Concurrency, memory and the threadpool](#concurrency-memory-and-the-threadpool)
- [How it works](#how-it-works)
- [Development](#development)
- [Roadmap](#roadmap)
- [License](#license)

## Features

- **One API for many solvers.** Switch between LP, MIP and constraint-programming
  backends by changing one string.
- **Non-blocking.** `solve()` runs on the libuv threadpool and returns a Promise;
  `solveSync()` is there for scripts.
- **Cancellable.** `interrupt()` stops a running solve on backends that support
  it safely, and `setTimeLimit()` bounds any solve.
- **Fails loudly.** Reading a value when there is no current solution, using a
  variable from another solver, or passing `NaN` all throw a clear error. You
  never silently get a stale `0`.
- **Constraint programming and vehicle routing.** `cp.CpSolver`, `RoutingModel`
  and `RoutingIndexManager` follow OR-Tools' Python API with camelCase names.
- **Typed.** TypeScript definitions are included.
- **Debuggable.** Export any model as LP or MPS text with `toLp()` and `toMps()`.
- **Faster than Python at building models.** Building a model is 2.3 to 5.8
  times faster than with OR-Tools' official Python binding, and solve times are
  identical. See [Performance](#performance).

## Performance

The repository includes a reproducible benchmark (`npm run bench`) that builds
**the same models** with `ortools-node` and with Python's official `pywraplp`
binding, both using **OR-Tools 9.15.6755**. Every run checks that both sides
reach the same status, objective value and solution checksum before any timing
is reported.

### Summary

Total time to build the model, solve it and read every variable back, using
each library's idiomatic API:

| Workload | ortools-node | Python | Node.js advantage |
|---|--:|--:|--:|
| Transportation LP, 100 × 100 (10k variables), GLOP | 23.2 ms | 48.6 ms | **2.1× faster** |
| Transportation LP, 400 × 400 (160k variables, 320k nonzeros), GLOP | 1,131 ms | 1,469 ms | **1.3× faster** |
| Multi-dimensional knapsack, 50 items × 5 constraints, SCIP | 51.4 ms | 50.4 ms | equal |
| 2,000 small LPs (10 variables × 5 constraints each), GLOP | 84.6 ms | 252 ms | **3.0× faster** |

**How to read this.** Both libraries run the same C++ solver, so solve times
are equal to within ±7%. The difference is the cost of crossing from the
scripting language into C++: on the transportation and small-LP workloads,
building the model is **2.3 to 5.8 times faster** and reading results back
**2.3 to 3 times faster** in Node.js. The advantage is
largest for many small models, such as one optimisation per API request, and
for large models that solve quickly. When the solver itself dominates, as in the
knapsack workload, both are the same.

### Full results

Median of 7 runs after one warm-up, both runtimes pinned to the same
performance core. The ratio is Python time divided by Node.js time, so a value
above 1 means Node.js is faster.

- **Idiomatic** is the code you would normally write:
  `solver.addLessEq([[x, 3], [y, 4]], 10)` in Node.js and
  `solver.Add(solver.Sum([3 * x, 4 * y]) <= 10)` in Python.
- **Low-level** sets one coefficient per call in both languages:
  `setConstraintCoefficient` in Node.js and `SetCoefficient` in Python.

| Workload | API style | Phase | Node.js (ms) | Python (ms) | Ratio |
|---|---|---|--:|--:|--:|
| transport-100 | idiomatic | build | 7.93 | 32.0 | 4.03× |
| transport-100 | idiomatic | solve | 14.5 | 14.6 | 1.00× |
| transport-100 | idiomatic | read | 0.77 | 1.94 | 2.52× |
| transport-100 | idiomatic | **total** | **23.2** | **48.6** | **2.09×** |
| transport-100 | low-level | build | 5.72 | 13.1 | 2.29× |
| transport-100 | low-level | solve | 14.4 | 15.1 | 1.05× |
| transport-100 | low-level | read | 0.79 | 2.05 | 2.59× |
| transport-100 | low-level | **total** | **21.3** | **30.8** | **1.44×** |
| transport-400 | idiomatic | build | 160 | 556 | 3.47× |
| transport-400 | idiomatic | solve | 948 | 885 | 0.93× |
| transport-400 | idiomatic | read | 13.2 | 32.0 | 2.43× |
| transport-400 | idiomatic | **total** | **1,131** | **1,469** | **1.30×** |
| transport-400 | low-level | build | 77.9 | 226 | 2.90× |
| transport-400 | low-level | solve | 897 | 862 | 0.96× |
| transport-400 | low-level | read | 13.4 | 31.0 | 2.31× |
| transport-400 | low-level | **total** | **1,008** | **1,113** | **1.10×** |
| knapsack-scip | idiomatic | build | 1.17 | 1.06 | 0.91× |
| knapsack-scip | idiomatic | solve | 50.1 | 49.3 | 0.98× |
| knapsack-scip | idiomatic | read | 0.02 | 0.03 | 1.67× |
| knapsack-scip | idiomatic | **total** | **51.4** | **50.4** | **0.98×** |
| knapsack-scip | low-level | build | 0.80 | 0.79 | 0.99× |
| knapsack-scip | low-level | solve | 51.7 | 51.2 | 0.99× |
| knapsack-scip | low-level | read | 0.01 | 0.03 | 2.14× |
| knapsack-scip | low-level | **total** | **52.6** | **52.0** | **0.99×** |
| small-lp ×2000 | idiomatic | build | 33.8 | 197 | 5.83× |
| small-lp ×2000 | idiomatic | solve | 49.0 | 49.6 | 1.01× |
| small-lp ×2000 | idiomatic | read | 2.05 | 6.14 | 2.99× |
| small-lp ×2000 | idiomatic | **total** | **84.6** | **252** | **2.99×** |
| small-lp ×2000 | low-level | build | 21.9 | 61.9 | 2.83× |
| small-lp ×2000 | low-level | solve | 44.9 | 44.8 | 1.00× |
| small-lp ×2000 | low-level | read | 1.94 | 5.81 | 2.99× |
| small-lp ×2000 | low-level | **total** | **68.7** | **112** | **1.64×** |

### Methodology

| | |
|---|---|
| **Machine** | Intel Core i7-12700H (20 logical CPUs), Linux 7.0, Ubuntu 26.04 |
| **Node.js side** | Node.js 24.21.0, `ortools-node` 0.1.0 built with GCC 15.2 (`-O3`) against the OR-Tools 9.15.6755 C++ release for Ubuntu 24.04 |
| **Python side** | Python 3.14.4, `ortools==9.15.6755` from PyPI (`pywraplp`) |
| **Models** | Generated in each language from the same seeded PRNG (mulberry32), so the coefficients are identical. Generating the data is not timed. |
| **Phases** | *build*: create the solver, variables, constraints and objective. *solve*: `solveSync()` / `Solve()`. *read*: read every variable's value. |
| **Validity** | The run aborts if status, objective value or solution checksum differ between the two languages. |
| **Noise control** | One warm-up run, then the median of 7. Both processes are pinned to the same performance core with `taskset`; on hybrid Intel CPUs a solve is about 1.7 times slower on an efficiency core. Two complete runs agreed within 6% on every total. |
| **Fairness** | Each solver is released after its run, outside the timed region: by `dispose()` in Node.js and by reference counting in Python. |

Results depend on hardware; reproduce them on yours:

```bash
uv venv bench/.venv
uv pip install --python bench/.venv/bin/python -r bench/requirements.txt
npm run bench          # BENCH_CPU=<n> picks the pinned CPU; BENCH_PYTHON=<path> another interpreter
```

The sources are in [`bench/`](bench): `bench.js` and `bench.py` are line-for-line
mirrors, and `run.js` drives both and prints the tables above.

## Installation

### 1. Prerequisites

| Platform | Toolchain |
|---|---|
| Linux | GCC ≥ 11 or Clang ≥ 14, CMake ≥ 3.18 |
| macOS | Xcode Command Line Tools, CMake ≥ 3.18 |
| Windows | Visual Studio 2022 Build Tools (C++ workload), CMake ≥ 3.18 |

You also need Node.js 22 or later. CI tests Node.js 22, 24 and 26.

### 2. OR-Tools C++ release

Download the **C++** archive (`_cpp_` in the file name) for your platform from
the [OR-Tools releases page](https://github.com/google/or-tools/releases), for
example `or-tools_amd64_ubuntu-24.04_cpp_v9.15.6755.tar.gz`, and extract it:

```bash
mkdir -p ~/or-tools
tar -xzf or-tools_amd64_ubuntu-24.04_cpp_v9.15.6755.tar.gz -C ~/or-tools --strip-components=1
export ORTOOLS_ROOT=~/or-tools        # add this to your shell profile
```

The directory must contain `include/`, `lib/` and `lib/cmake/ortools/`. An
OR-Tools build installed from source with `cmake --install` works as well.

### 3. Build and verify

```bash
npm install            # compiles the addon with cmake-js
npm test
npm run example
```

On Linux and macOS the addon records the path to `$ORTOOLS_ROOT/lib`, so it
finds `libortools` at runtime without `LD_LIBRARY_PATH`. On Windows, add
`%ORTOOLS_ROOT%\bin` to `PATH` or copy the DLLs next to
`build/Release/ortools_node.node`.

## Usage

### Linear programming with duals

```js
const { Solver } = require('ortools-node');

const lp = new Solver('GLOP');
const x = lp.numVar(0, Infinity, 'x');
const y = lp.numVar(0, Infinity, 'y');
const capacity = lp.addLessEq([[x, 1], [y, 2]], 14, 'capacity');
lp.addGreaterEq([[x, 3], [y, -1]], 0);
lp.addLessEq([[x, 1], [y, -1]], 2);
lp.maximize([[x, 3], [y, 4]]);

const r = lp.solveSync();
console.log(r.status, r.objectiveValue.toFixed(2));   // OPTIMAL 34.00
console.log(capacity.dualValue());         // 2.333…  (shadow price of `capacity`)
lp.dispose();
```

### Mixed-integer programming with a time limit

```js
const { Solver, supportsBackend } = require('ortools-node');

async function main() {
  const backend = ['SCIP', 'HIGHS', 'CBC', 'CP_SAT'].find(supportsBackend);
  const items = [
    { name: 'a', weight: 4, value: 10 }, { name: 'b', weight: 7, value: 13 },
    { name: 'c', weight: 5, value: 9 }, { name: 'd', weight: 3, value: 7 },
  ];

  const mip = new Solver(backend).setTimeLimit(5_000);
  const take = items.map((item) => mip.boolVar(item.name));
  mip.addLessEq(items.map((item, i) => [take[i], item.weight]), 12, 'capacity');
  mip.maximize(items.map((item, i) => [take[i], item.value]));

  const result = await mip.solve();
  if (!result.feasible) throw new Error(`no solution: ${result.status}`);
  const chosen = items.filter((_, i) => take[i].value() > 0.5).map((item) => item.name);
  console.log(result.status, result.objectiveValue, chosen);   // OPTIMAL 26 [ 'a', 'c', 'd' ]
  mip.dispose();
}

main();
```

### Stopping a long solve

```js
const { Solver } = require('ortools-node');

async function solveWithDeadline(solver, ms) {
  const timer = setTimeout(() => solver.interrupt(), ms);  // CP_SAT, GLOP, PDLP, Gurobi
  try {
    return await solver.solve();       // resolves early with NOT_SOLVED or FEASIBLE
  } finally {
    clearTimeout(timer);
  }
}
```

For backends that cannot be interrupted safely, `interrupt()` returns `false`.
Use `setTimeLimit()` instead, which every backend honours.

### Linear expressions

Every method that takes an expression accepts any of these forms:

```js
const { Solver } = require('ortools-node');

const s = new Solver('GLOP');
const x = s.numVar(0, 10, 'x');
const y = s.numVar(0, 10, 'y');

s.addLessEq([[x, 3], [y, 4]], 24);                 // [variable, coefficient] pairs
s.addLessEq([[3, x], [4, y]], 24);                 // [coefficient, variable] pairs
s.addLessEq(new Map([[x, 3], [y, 4]]), 24);        // Map<Variable, number>
s.addLessEq(x, 5);                                 // a single variable
s.addLessEq({ terms: [[x, 1], [y, 1]], constant: 2 }, 12);   // x + y + 2 <= 12
s.dispose();
```

### Constraint programming

`cp` is the classic constraint solver (pywrapcp); the top-level `CpModel` / `CpSolver` are CP-SAT.

```js
const { cp } = require('ortools-node');

const s = new cp.CpSolver('puzzle');
const [x, y, z] = ['x', 'y', 'z'].map((name) => s.intVar(0, 9, name));
s.add(s.allDifferent([x, y, z]));
s.add(x.plus(y).eq(z.times(2)));                              // x + y == 2z
const objective = s.maximize(x.times(100).plus(y.times(10)).plus(z), 1);
const best = s.lastSolutionCollector().add([x, y, z]);
s.solve(s.phase([x, y, z], 'CHOOSE_FIRST_UNBOUND', 'ASSIGN_MAX_VALUE'), [best, objective]);
console.log([x, y, z].map((v) => best.value(0, v)));          // [ 9, 7, 8 ]
s.dispose();
```

### Vehicle routing

```js
const { RoutingIndexManager, RoutingModel } = require('ortools-node');

async function main() {
  const distances = [[0, 2, 9, 10], [1, 0, 6, 4], [15, 7, 0, 8], [6, 3, 12, 0]];
  const manager = new RoutingIndexManager(distances.length, 1, 0);   // nodes, vehicles, depot
  const model = new RoutingModel(manager);
  model.setArcCostEvaluatorOfAllVehicles(model.registerTransitMatrix(distances));

  const solution = await model.solveWithParameters({ firstSolutionStrategy: 'PATH_CHEAPEST_ARC' });
  console.log(solution.objectiveValue());                     // 21
  console.log(manager.indicesToNodes(solution.routes()[0]));  // [ 0, 2, 3, 1, 0 ]
  model.dispose();
}

main();
```

## API reference

### `new Solver(backend = 'GLOP', name?)`

Creates a model with the given backend; see [Solver backends](#solver-backends).
It throws if the backend is not compiled into your OR-Tools build. `name`
appears in exported LP and MPS files.

| Method | Description |
|---|---|
| `numVar(lb?, ub?, name?)` | Continuous variable; bounds default to `-Infinity` / `Infinity`. |
| `intVar(lb?, ub?, name?)` | Integer variable. |
| `boolVar(name?)` | 0/1 integer variable. |
| `addConstraint(expr, lb?, ub?, name?)` | `lb ≤ expr ≤ ub`; returns a `Constraint`. |
| `addLessEq(expr, rhs, name?)` / `addGreaterEq` / `addEquality` | `expr ≤ rhs`, `expr ≥ rhs`, `expr = rhs`. |
| `minimize(expr)` / `maximize(expr)` | Replaces the objective. |
| `setTimeLimit(ms)` | Wall-clock limit; `0` means no limit. |
| `setNumThreads(n)` | Threads for backends that support it (SCIP, CP-SAT, …). |
| `setSolverSpecificParameters(text)` | Backend parameter string, for example SCIP `"limits/gap = 0.01"`. Returns `false` if the backend rejects it. |
| `enableOutput(on = true)` | Print the backend's search log. |
| `solve()` → `Promise<SolveResult>` | Solves on the libuv threadpool. |
| `solveSync()` → `SolveResult` | Solves on the calling thread. |
| `interrupt()` → `boolean` | Asks a pending `solve()` to stop. Returns `false` if nothing is running or the backend cannot be interrupted safely. |
| `clear()` | Removes all variables and constraints. Existing handles become invalid. |
| `dispose()` | Frees the native model immediately; later calls throw. During a `solve()` it frees the model once that solve settles. Also runs on scope exit with `using solver = new Solver(...)` (Node.js ≥ 24): `return solver.solve()` from the scope still resolves, but `await` it inside the scope to read variable values. |
| `toLp(obfuscated?)` / `toMps(fixed?, obfuscated?)` | The model in LP or MPS format. |
| `solverVersion()` | For example `"Glop solver v9.15.6755"`. |
| `numVariables`, `numConstraints`, `variables`, `constraints`, `busy` | Read-only properties. |

### `Variable` and `Constraint`

| Member | Description |
|---|---|
| `variable.value()` | Value in the current solution. |
| `variable.reducedCost()` | Reduced cost; LP backends only. |
| `variable.setBounds(lb, ub)` | Changes the bounds. |
| `constraint.dualValue()` | Dual value (shadow price); LP backends only. |
| `constraint.setCoefficient(variable, coef)` / `constraint.setBounds(lb, ub)` | Edits the row. |
| `index`, `name` (and `variable.isInteger`) | Read-only properties. |

### `SolveResult`

| Field | Description |
|---|---|
| `status` | `'OPTIMAL' \| 'FEASIBLE' \| 'INFEASIBLE' \| 'UNBOUNDED' \| 'ABNORMAL' \| 'MODEL_INVALID' \| 'NOT_SOLVED'` |
| `optimal`, `feasible` | Booleans derived from `status`. |
| `objectiveValue`, `bestBound` | `NaN` when there is no solution. |
| `wallTimeMs`, `iterations`, `nodes` | Solver statistics; `nodes` is `0` for LP backends. |

### Module exports

`supportsBackend(name)` reports whether a backend is compiled into your OR-Tools
build. `INF` is `Infinity`.

### `new cp.CpSolver(name?)`

The classic constraint programming solver (`pywrapcp.Solver`). Integer inputs
accept safe integers and BigInts; `removeValues`, `memberCt` and similar take an
Array or a typed array. Every int64 result (`min()`, `max()`, `value()`,
`size()`, collector values and objectives) is a number up to
`Number.MAX_SAFE_INTEGER`, an exact BigInt beyond it, and `-Infinity` /
`Infinity` for the int64 extremes (the unbounded markers, so
`intVar(-Infinity, Infinity)` reads back as it was made). `size()` is never
Infinity: the full int64 domain is `2n ** 64n`. Search counters (`wallTime()`,
`branches()`, `failures()`, `solutions()` and the collector's per-solution
ones) are plain numbers, exact up to 2^53, which no realistic search reaches.

| Method | Description |
|---|---|
| `intVar(min, max, name?)` / `intVar(values, name?)` / `boolVar` / `intConst` | Variables (`cp.IntVar`). |
| `x.plus(y)`, `minus`, `times`, `abs`, `square`, `opposite`; `sum`, `scalProd`, `min`, `max`, `element` | Integer expressions (`cp.IntExpr`). |
| `x.eq(y)`, `ne`, `le`, `lt`, `ge`, `gt`; `allDifferent`, `allowedAssignments`, `memberCt`, `notMemberCt` | Constraints; pass them to `add()`. |
| `isEqualVar(a, b)`, `isLessVar`, …, `isMemberVar` | 0/1 variables reifying a condition. |
| `x.setMin/setMax/setRange/setValue`, `x.removeValue(s)` | Domain changes outside a search; emptying a domain throws `CP solver failure`. |
| `phase(vars, varStrategy, valueStrategy)`, `compose(...)` | Decision builders. |
| `minimize(expr, step?)` / `maximize`, `limit({ timeMs, branches, failures, solutions })`, `searchLog(period)` | Search monitors. |
| `firstSolutionCollector()`, `lastSolutionCollector()`, `bestValueSolutionCollector(maximize)`, `allSolutionCollector()` | Collectors; read with `collector.value(n, x)` after the search. |
| `solve(db, monitors?)` → `boolean` | Searches on the calling thread. Monitors may be plain objects with `enterSearch`, `exitSearch` and `atSolution` (return `false` to stop). |
| `solveAsync(db, monitors?)` → `Promise<boolean>` | Searches on the libuv threadpool; `interrupt()` stops it. |
| `newSearch(db, monitors?)`, `nextSolution()`, `endSearch()` | Iterate solutions one by one; `x.value()` reads the current one. |
| `wallTime()`, `branches()`, `failures()`, `solutions()`, `busy`, `dispose()` | Statistics and lifetime. |

OR-Tools stores holes in a domain as a bitset of at most 2^32 values, so making
a hole in a wider domain (`removeValue(s)`, `memberCt`, `notMemberCt`,
`isMemberVar`) throws a `RangeError`; removing values at the bounds only moves
the bounds and is always accepted.

### Routing

`new RoutingIndexManager(numNodes, numVehicles, depot)`, or `(numNodes,
numVehicles, starts, ends)`, maps nodes to solver indices (`nodeToIndex`,
`indexToNode`, `nodesToIndices`, `indicesToNodes`). `new RoutingModel(manager)`
builds the model:

| Method | Description |
|---|---|
| `registerTransitMatrix(matrix)`, `registerUnaryTransitVector(values)` | Transit evaluators indexed by node; return an evaluator id. |
| `registerTransitCallback(fn)`, `registerUnaryTransitCallback(fn)` | `fn(fromIndex, toIndex)` is evaluated once per pair when registered, so it must be pure; limited to 16384 indices. |
| `setArcCostEvaluatorOfAllVehicles(id)`, `setFixedCostOfVehicle(cost, v)`, … | Costs. |
| `addDimension(id, slackMax, capacity, fixStartCumulToZero, name)` and its `WithVehicle…`, `Constant`, `Vector` and `Matrix` variants | Dimensions; `getDimensionOrDie(name)` returns one with `cumulVar(i)`, span bounds and costs, and soft bounds. |
| `addDisjunction(indices, penalty?, maxCardinality?)`, `addPickupAndDelivery(p, d)`, `setAllowedVehiclesForIndex`, visit types | Routing constraints. |
| `nextVar(i)`, `vehicleVar(i)`, `activeVar(i)`, `costVar()` | Model variables; constrain them through `model.solver()`, the model's `cp.CpSolver`. |
| `solveWithParameters(params?, { onSolution?, includeRoutes? })` → `Promise<RoutingSolution \| null>` | Solves on the libuv threadpool; `interrupt()` stops it with the best solution so far. `…Sync` variants and `solveFromAssignmentWithParameters` exist too. |
| `closeModelWithParameters(params?)`, `applyLocks`, `readAssignmentFromRoutes(routes, ignoreInactive)` | Close the model, fix route prefixes, build a solution from routes. |
| `status()`, `busy`, `dispose()` | Search status, lifetime. |

`params` are `RoutingSearchParameters` fields in camelCase, validated against
OR-Tools' protobuf (`defaultRoutingSearchParameters()`,
`validateRoutingSearchParameters(params)`, `durationMs(ms)` for time limits). A
`RoutingSolution` has `objectiveValue()`, `routes()`, `cumuls(dimension)`,
`slacks(dimension)` and `value/min/max(variable)`, and stays valid until the
model is solved again, changed or disposed. Solution values follow the CP rule
(numbers up to `Number.MAX_SAFE_INTEGER`, BigInts beyond, ±Infinity for the
int64 extremes), so large penalties are exact.

### Errors

The binding throws instead of returning a misleading number:

| Situation | Error |
|---|---|
| Reading `value()`, `objectiveValue`, … before a solve, or after the model changed | `No solve result` |
| Reading a value after a solve that ended without a solution | `No solution available` |
| `dualValue()` or `reducedCost()` on a MIP backend | `only available for LP backends` |
| Using a `Variable` or `Constraint` with another solver | `belongs to a different Solver` |
| Using a handle after `clear()` or `dispose()` | `no longer valid` |
| Any call while `solve()` is pending, except `busy` and `interrupt()` | `Solver is busy` |
| `NaN` bounds, non-finite coefficients, or non-numeric bounds | `TypeError`; the model is left unchanged |

## Solver backends

The OR-Tools 9.15 release archives include all open-source backends below. Run
`supportsBackend(name)` to check yours.

| Backend | Problem types | Duals and reduced costs | `interrupt()` |
|---|---|:-:|:-:|
| `GLOP` | LP | yes | yes |
| `PDLP` | LP, large scale | yes | yes |
| `CLP` | LP | yes | — |
| `SCIP` | MIP | — | — ¹ |
| `CBC` | MIP | — | — |
| `HIGHS` | LP and MIP | — | — |
| `CP_SAT` | MIP, integer models | — | yes |
| `GUROBI`, `XPRESS` | LP and MIP; loaded at runtime if installed and licensed | LP ids only | Gurobi only |
| `CPLEX` | LP and MIP; requires OR-Tools built from source with CPLEX | LP ids only | — |

¹ OR-Tools documents interruption as not thread-safe for SCIP, so
`interrupt()` returns `false`. Use `setTimeLimit()` instead.

## Concurrency, memory and the threadpool

- **One solve per `Solver` at a time.** While `solve()` is pending, every call
  except `busy` and `interrupt()` throws. Create one `Solver` per model or
  request; separate solvers can solve concurrently.
- **Free models you no longer need.** Node.js frees native objects only after
  the event loop turns, so a synchronous loop that creates models keeps all of
  them in memory until it ends. That is about 40 KB even for a tiny LP. Call
  `dispose()`, or declare `using solver = new Solver(...)` on Node.js ≥ 24.
- **Size the threadpool for servers.** Each pending `solve()` occupies one libuv
  threadpool thread, and Node.js also uses that pool for `fs`, `dns.lookup`,
  `crypto` and `zlib`. The default is 4 threads. Set `UV_THREADPOOL_SIZE` above
  your maximum number of concurrent solves before Node.js starts, and give every
  solve a time limit.

## How it works

```
lib/index.js     JavaScript API: Variable / Constraint handles, expression parsing,
                 ownership checks, SolveResult
lib/index.d.ts   TypeScript definitions
src/addon.cc     Napi::ObjectWrap<Solver> owning a std::unique_ptr<MPSolver>
                 - variables and constraints addressed by integer index
                 - SolveWorker (Napi::AsyncWorker) runs MPSolver::Solve() off the
                   main thread and resolves a Promise
CMakeLists.txt   find_package(ortools CONFIG) and link ortools::ortools via cmake-js
```

The C++ layer is deliberately small: it validates every argument and tracks
whether a current solution exists. Everything that does not need C++ lives in
JavaScript.

### Adding a method

1. Declare and implement it in the `Solver` class in `src/addon.cc`, then
   register it with `InstanceMethod("jsName", &Solver::CppName)` in `Solver::Init`.
2. Expose it in `lib/index.js` and `lib/index.d.ts`.
3. Add tests in `test/`, then run `npm run build && npm test`.

### Rules for native code

- Never touch `Napi::` values inside `AsyncWorker::Execute`, which runs on a
  worker thread.
- Read and convert every JavaScript argument first, then check that the object
  is still usable (not disposed, not busy), and only then touch the OR-Tools
  model. Reading an array element or property can run user code (a getter or
  a Proxy) that disposes the object or starts a solve.
- Never let a C++ exception escape: the addon builds with
  `NAPI_DISABLE_CPP_EXCEPTIONS`, so one would abort the process. Wrap OR-Tools
  calls that can allocate or throw in `GuardCpp()` (main thread,
  `src/common/cpp_guard.h`) or `PromiseWorker::RunGuarded()` (in `Execute`,
  `src/common/async_worker.h`).
- Validate every precondition behind an OR-Tools `CHECK` before the call: a
  failed `CHECK` aborts the process, it is not an exception.
- Keep the JavaScript object alive during async work (`Napi::ObjectReference`)
  so the `MPSolver` cannot be destroyed mid-solve.
- Build with the same compiler ABI as the OR-Tools binaries. On Linux that is
  GCC ≥ 11 with the C++11 ABI; `undefined symbol … abi:cxx11` means a mismatch.
- Let `find_package(ortools)` supply protobuf and abseil. Never mix in system
  copies.
- Never use `std::regex`. libstdc++'s implementation recurses once per
  character and crashes on long input; scan text with a plain loop instead.

## Development

```bash
npm run build          # incremental native build   (npm run rebuild for a clean one)
npm test               # node:test suite, 24 tests
npm run typecheck      # checks the TypeScript definitions
npm run example        # examples/basic.js
npm run bench          # Node.js vs Python benchmark (see Performance)
```

Tests cover solving, every error path, ownership after `clear()` and `dispose()`,
interruption, input validation and memory release. CI runs the tests, the type
check and the example on Node.js 22, 24 and 26 for every push and pull request.
See [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request; changes
are recorded in [CHANGELOG.md](CHANGELOG.md).

## Roadmap

- **Prebuilt binaries** for Linux, macOS and Windows, so installing needs no C++
  toolchain or OR-Tools download.
- **CI on macOS and Windows.** Linux CI already covers Node.js 22, 24 and 26.
- **CP-SAT API**: intervals, `NoOverlap`, `AllDifferent`, cumulative
  constraints and other scheduling features.
- **Bulk model building** from typed arrays for models with millions of nonzeros.

## License

[MIT](LICENSE) © Abdulazeem Mouneer, except for third-party code listed in
[NOTICE](NOTICE): `src/packing/arc_flow.cc` is a modified copy of OR-Tools'
`ortools/packing/arc_flow_solver.cc` (v9.15) under
[Apache-2.0](LICENSES/Apache-2.0.txt). OR-Tools is licensed under Apache-2.0.
The solvers bundled in its release archives carry their own licences: SCIP and SoPlex (Apache-2.0), HiGHS (MIT),
and the COIN-OR solvers CBC and CLP (Eclipse Public License).
