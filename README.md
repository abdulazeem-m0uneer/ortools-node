# ortools-node

[![CI](https://github.com/abdulazeem-m0uneer/ortools-node/actions/workflows/ci.yml/badge.svg)](https://github.com/abdulazeem-m0uneer/ortools-node/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Node.js](https://img.shields.io/badge/node-%E2%89%A522-339933?logo=node.js&logoColor=white)
![OR-Tools](https://img.shields.io/badge/OR--Tools-9.14%20%7C%209.15-4285F4)

**Native Node.js bindings for [Google OR-Tools](https://developers.google.com/optimization)**:
linear and mixed-integer programming with GLOP, PDLP, CLP, SCIP, CBC, HiGHS and
CP-SAT (plus Gurobi, CPLEX or Xpress where your OR-Tools build can load them),
the CP-SAT and classic constraint solvers, vehicle routing, graph algorithms,
knapsack, set cover and bin packing.

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
console.log(result.status, result.objectiveValue, x.value(), y.value()); //=> OPTIMAL 38 10 2
solver.dispose();
```

> **Status: 0.1.0, early release. Not yet published on npm; build from source
> until the first release** ([how](#building-from-source), [roadmap](#roadmap)).
> The API is tested on Linux x64 and arm64 with OR-Tools 9.14 and 9.15 and
> Node.js 22, 24 and 26. Once published, `npm install` on Linux x64 and arm64
> with glibc uses a prebuilt addon that bundles OR-Tools and needs no compiler.

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
  backends by changing one string, or use Python's `model_builder` and
  `mathopt` APIs (`modelBuilder`, `mathOpt`).
- **Every major OR-Tools component.** CP-SAT (`CpModel`, `CpSolver`), the
  classic constraint solver (`cp`) with JS search monitors, vehicle routing with
  progress events, min-cost flow, max flow, linear sum assignment, knapsack, set
  cover and vector bin packing. Names follow OR-Tools' Python API in camelCase.
- **Non-blocking.** `solve()` runs on the libuv threadpool and returns a Promise;
  `solveSync()` is there for scripts.
- **Cancellable.** `interrupt()` (or `stopSearch()`) stops a running solve on
  backends that support it safely, and a time limit bounds any solve.
- **Fails loudly.** Reading a value when there is no current solution, using a
  variable from another model, or passing `NaN` all throw a clear error, and
  input OR-Tools would abort on is rejected first. You never silently get a
  stale `0`, and a bad call never kills the process.
- **Exact integers.** int64 inputs take numbers or BigInts, and int64 results
  beyond 2^53 come back as BigInts where the module allows them.
- **Typed.** TypeScript definitions are included and tested against the runtime.
- **Debuggable.** Export models as LP or MPS text, or as protobuf JSON.
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

### Dispatch workloads

[`bench/dispatch/RESULTS.md`](bench/dispatch/RESULTS.md) runs the caby-dispatch
OR-Tools spikes (vehicle routing with pickups and deliveries, time windows,
allowed vehicles and visit types; min cost flow; linear sum assignment; CP-SAT)
in Python and as a line-for-line Node.js port on identical fixtures, on OR-Tools
9.14 and 9.15. It checks that both return the same solutions and compares
p50 / p95 / p99 build, solve and read latency, plus knapsack, set cover, max flow
and math_opt. `npm run bench:dispatch` regenerates it; the header of
[`bench/dispatch/bench.js`](bench/dispatch/bench.js) lists the one-time setup.

## Installation

You need Node.js 22 or later. CI tests Node.js 22, 24 and 26.

> **Not yet published on npm; build from source until the first release.** The
> `npm install` commands below describe the published package; until then,
> follow [Building from source](#building-from-source) in a clone.

### Prebuilt binaries (Linux x64 and arm64)

```bash
npm install ortools-node
```

On Linux x64 and arm64 with glibc 2.28 or newer (for example Debian 10+,
Ubuntu 20.04+, RHEL/AlmaLinux 8+), npm also installs a platform package with
the addon built against OR-Tools 9.15 and the OR-Tools shared libraries it
needs. There is nothing to compile and no OR-Tools to download. Check what
loaded with `node -p "require('ortools-node').buildInfo"`.

The platform package must have exactly ortools-node's version. For OR-Tools
9.14, install its package yourself
(`npm install @ortools-node/linux-x64-gnu-ortools9.14@0.1.0`, or `linux-arm64-gnu`)
and set `ORTOOLS_NODE_PIN=9.14` when both are present. Alpine and other musl
systems have no prebuilts: use a glibc-based image such as `node:22-trixie-slim`,
or build from source. The packages, load order, install hook, environment
variables and loader errors are in [docs/install.md](docs/install.md).

### Building from source

Other platforms, other OR-Tools builds, and musl systems build the addon from
source. `npm install` builds from source when no matching prebuilt is installed,
against `ORTOOLS_ROOT` when it is set. `npm install --build-from-source` (or
`--build-from-source=ortools-node`) builds from source even when a prebuilt is
installed. A local build always takes precedence over a prebuilt when the addon
loads.

#### 1. Prerequisites

| Platform | Toolchain |
|---|---|
| Linux | GCC ≥ 11 or Clang ≥ 14, CMake ≥ 3.18 |
| macOS | Xcode Command Line Tools, CMake ≥ 3.18 |
| Windows | Visual Studio 2022 Build Tools (C++ workload), CMake ≥ 3.18 |

#### 2. OR-Tools C++ release

Download the **C++** archive (`_cpp_` in the file name) for your platform from
the [OR-Tools releases page](https://github.com/google/or-tools/releases), for
example `or-tools_amd64_ubuntu-24.04_cpp_v9.15.6755.tar.gz`, and extract it:

```bash
mkdir -p ~/or-tools
tar -xzf or-tools_amd64_ubuntu-24.04_cpp_v9.15.6755.tar.gz -C ~/or-tools --strip-components=1
export ORTOOLS_ROOT=~/or-tools        # add this to your shell profile
```

The directory must contain `include/` and `lib/cmake/ortools/` (the libraries
are in `lib/`, or `lib64/` in the AlmaLinux archives). An OR-Tools build
installed from source with `cmake --install` works as well.

#### 3. Build and verify

```bash
npm install ortools-node --build-from-source   # in a project
npm install && npm test && npm run example     # in a clone of this repository
```

Without a prebuilt or `ORTOOLS_ROOT`, the install still tries a source build,
which works when CMake finds OR-Tools another way (`CMAKE_PREFIX_PATH`, a system
install); if that fails, it says what to do. In a clone that already has a
build in `build/Release` or `build/Debug`, `npm install` keeps it (or rebuilds
it when `ORTOOLS_ROOT` is set); `npm run build` recompiles. On Linux and macOS the addon records the path to the
OR-Tools libraries, so it finds `libortools` at runtime without
`LD_LIBRARY_PATH`. On Windows, add `%ORTOOLS_ROOT%\bin` to `PATH` or copy the
DLLs next to `build/Release/ortools_node.node`.


## Usage

More examples, one page per module, are in the [API reference](#api-reference).

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
console.log(r.status, r.objectiveValue.toFixed(2));   //=> OPTIMAL 34.00
console.log(capacity.dualValue().toFixed(3));         //=> 2.333
lp.dispose();
```

### CP-SAT

```js
const { CpModel, CpSolver } = require('ortools-node');

const model = new CpModel();
const x = model.newIntVar(0, 10, 'x');
const y = model.newIntVar(0, 10, 'y');
model.add(x.plus(y.times(2)).le(14));
model.addAllDifferent([x, y]);
model.maximize(x.times(3).plus(y.times(4)));

const solver = new CpSolver();
const status = await solver.solve(model);              // off the main thread
console.log(status, solver.objectiveValue, solver.value(x), solver.value(y)); //=> OPTIMAL 38 10 2
solver.dispose();
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
console.log([x, y, z].map((v) => best.value(0, v)));          //=> [ 9, 7, 8 ]
s.dispose();
```

### Vehicle routing

```js
const { RoutingIndexManager, RoutingModel } = require('ortools-node');

const distances = [[0, 2, 9, 10], [1, 0, 6, 4], [15, 7, 0, 8], [6, 3, 12, 0]];
const manager = new RoutingIndexManager(distances.length, 1, 0);   // nodes, vehicles, depot
const model = new RoutingModel(manager);
model.setArcCostEvaluatorOfAllVehicles(model.registerTransitMatrix(distances));

const solution = await model.solveWithParameters({ firstSolutionStrategy: 'PATH_CHEAPEST_ARC' });
console.log(solution.objectiveValue());                     //=> 21
console.log(manager.indicesToNodes(solution.routes()[0]));  //=> [ 0, 2, 3, 1, 0 ]
model.dispose();
```

### Graph algorithms

```js
const { SimpleMaxFlow } = require('ortools-node');

const flow = new SimpleMaxFlow();
flow.addArcsWithCapacity([0, 0, 1, 1, 2], [1, 2, 2, 3, 3], [20, 30, 10, 30, 20]);
console.log(await flow.solve(0, 3), flow.optimalFlow());   //=> OPTIMAL 40
flow.dispose();
```

## API reference

One page per module. Each page has runnable examples, every class and member,
the errors it throws and its int64 rules.

| Module | Main exports | Reference |
|---|---|---|
| Linear solver (`MPSolver`) | `Solver`, `supportsBackend`, `INF` | [docs/linear_solver.md](docs/linear_solver.md) |
| Model builder (Python's `model_builder`) | `modelBuilder` | [docs/model_builder.md](docs/model_builder.md) |
| MathOpt (Python's `mathopt`) | `mathOpt` | [docs/math_opt.md](docs/math_opt.md) |
| CP-SAT | `CpModel`, `CpSolver`, `Domain`, `CpLinearExpr` | [docs/sat.md](docs/sat.md) |
| Classic constraint solver, search monitors | `cp` | [docs/cp.md](docs/cp.md) |
| Vehicle routing, progress events | `RoutingIndexManager`, `RoutingModel` | [docs/routing.md](docs/routing.md) |
| Parameter objects | `defaultRoutingSearchParameters`, `defaultSatParameters`, `durationMs` | [docs/params.md](docs/params.md) |
| Graph algorithms | `SimpleMinCostFlow`, `SimpleMaxFlow`, `SimpleLinearSumAssignment` | [docs/graph.md](docs/graph.md) |
| Knapsack | `KnapsackSolver`, `KnapsackSolverType` | [docs/knapsack.md](docs/knapsack.md) |
| Set cover | `setCover` | [docs/set_cover.md](docs/set_cover.md) |
| Vector bin packing | `solveVectorBinPacking` | [docs/bin_packing.md](docs/bin_packing.md) |
| Installation and loading | `ortoolsVersion`, `buildInfo` | [docs/install.md](docs/install.md) |

### Conventions

Every module follows the same rules:

- **Async and sync.** `solve()` (and `solveAsync()`, `nextSolution()`,
  `solveWithParameters()`) returns a Promise and runs on the libuv threadpool;
  the `...Sync` variant blocks the calling thread. One solve per object at a
  time: while it is pending, every other call throws, except `busy` and
  `interrupt()` (or `stopSearch()`).
- **Explicit lifetime.** Objects that own native memory have `dispose()` and
  `[Symbol.dispose]()`, so `using solver = new Solver(...)` (Node.js 24 and
  later) frees them at scope exit. Later calls throw.
- **int64 and BigInt.** Integer inputs take a safe-integer number or a BigInt.
  Results are numbers up to `Number.MAX_SAFE_INTEGER`. Beyond it, CP-SAT,
  classic CP and routing return an exact BigInt (classic CP and routing return
  `-Infinity` / `Infinity` for the int64 extremes); graph results are
  `-Infinity` / `Infinity` at the extremes and throw a `RangeError` in between.
  Parameter objects read int64 fields back as decimal strings. The linear
  solver, `modelBuilder`, `mathOpt` and set cover work in doubles.
- **Errors, not stale values.** Reading a result without a current solution
  throws, and so does a handle from another model or a disposed one. Arguments
  OR-Tools would `CHECK` (and abort the process on) are validated first and
  throw a `TypeError` or `RangeError`; running out of memory inside OR-Tools is
  a `RangeError`.
- **Callbacks run on the JS thread** that started the solve and receive
  copies of the values, never live native objects. A throw stops the search and
  the solve rejects (or rethrows) with it. See CP-SAT `onSolution`
  ([docs/sat.md](docs/sat.md)), classic CP search monitors with 14 hooks
  ([docs/cp.md](docs/cp.md)) and routing `onSolution` / `onProgress`
  ([docs/routing.md](docs/routing.md)).

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
- **Terminating a worker thread stops its searches.** `worker.terminate()`
  waits for threadpool work, so async CP-SAT, routing and CP `solveAsync()`
  searches are stopped as soon as JS can no longer run. A synchronous routing or
  CP search blocks the worker's thread: it stops at its next callback or JS
  monitor hook, and without one it runs to its limits like any blocking native
  call.


## How it works

```
lib/index.js         Entry point: re-exports every module
lib/<module>.js      JavaScript API per OR-Tools component: handles, validation, results
lib/<module>.d.ts    TypeScript declarations
lib/loader.js        Finds the source build or the prebuilt addon (docs/install.md)
src/addon.cc         Registers every component; checks the loaded OR-Tools release
src/<component>/     Napi::ObjectWrap classes per OR-Tools component; async work in
                     PromiseWorker (src/common/async_worker.h) off the main thread
CMakeLists.txt       find_package(ortools CONFIG) and link ortools::ortools via cmake-js
```

The C++ layer validates every argument and tracks whether a current solution
exists. Everything that does not need C++ lives in JavaScript.

### Adding a method

1. Implement it in the component's class under `src/<component>/` and register
   it in that class's `Init`.
2. Expose it in `lib/<module>.js` and declare it in `lib/<module>.d.ts`;
   `test/types_runtime.test.js` fails until the declaration matches the
   runtime.
3. Add tests in `test/`, a usage check in `types-test/` and an entry in the
   module's page in `docs/`, then run `npm run build && npm test && npm run typecheck`.

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
npm test               # node:test suite, including every example in README.md and docs/
npm run typecheck      # compiles lib/**/*.d.ts and the usage checks in types-test/
npm run example        # examples/basic.js
npm run bench          # Node.js vs Python benchmark (see Performance)
npm run bench:dispatch # dispatch parity + latency vs Python (bench/dispatch/RESULTS.md)
```

Tests cover solving, every error path, ownership after `clear()` and `dispose()`,
interruption, worker termination, input validation and memory release.
`test/types_runtime.test.js` checks the TypeScript declarations against the
loaded addon. `test/docs_examples.test.js` runs every ```` ```js ```` block of
this README and `docs/` as a script: `console.log(...); //=> text` lines must
print exactly `text`, and a block preceded by `<!-- no-run -->` is a fragment
that is not run; it also checks every relative link and anchor. CI runs the tests, the type check and the example against
OR-Tools 9.14 and 9.15 on Node.js 22, 24 and 26 for every push and pull
request. See [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request;
changes are recorded in [CHANGELOG.md](CHANGELOG.md).

## Roadmap

- **Publish to npm.** Neither `ortools-node` nor the `@ortools-node/*` platform
  packages are on npm yet; the publish workflow releases them from a `v*` tag.
- **Prebuilt binaries for macOS and Windows,** with CI on both. Linux x64 and
  arm64 with glibc have prebuilts; musl (Alpine) has none.
- **More search monitor hooks.** JS monitors on `cp.CpSolver` do not get
  `restartSearch`, `periodicCheck`, `progressPercent` or the local search hooks
  (`atLocalOptimum`, `acceptDelta`, `acceptNeighbor`, `acceptUncheckedNeighbor`):
  nothing in the API can trigger them until restarts and local search are
  exposed. `solveAsync()` takes `SearchMonitor` handles only.
- **CP-SAT `onSolution` in `solveSync()`,** which supports no callbacks today.
- **Live routing callbacks.** Transit callbacks are evaluated once, when
  registered (at most 16384 indices), because solving runs off the JS thread.
- **Quadratic and general constraints.** `mathOpt` models are linear only, and
  `modelBuilder` rejects models with general constraints other than indicators,
  or a quadratic objective.
- **Exact large graph results.** Graph results beyond 2^53 throw a `RangeError`
  instead of returning a BigInt.
- **Bulk model building** from typed arrays for linear models with millions of
  nonzeros.

## License

[MIT](LICENSE) © Abdulazeem Mouneer, except for third-party code listed in
[NOTICE](NOTICE): `src/packing/arc_flow.cc` is a modified copy of OR-Tools'
`ortools/packing/arc_flow_solver.cc` (v9.15) under
[Apache-2.0](LICENSES/Apache-2.0.txt). OR-Tools is licensed under Apache-2.0.
The solvers bundled in its release archives carry their own licences: SCIP and SoPlex (Apache-2.0), HiGHS (MIT),
and the COIN-OR solvers CBC and CLP (Eclipse Public License).
