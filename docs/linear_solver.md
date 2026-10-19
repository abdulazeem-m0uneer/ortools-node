# Linear solver (`Solver`)

`Solver` is OR-Tools' `MPSolver` (Python's `pywraplp.Solver`): one API for linear
and mixed-integer programs over GLOP, PDLP, CLP, SCIP, CBC, HiGHS, CP-SAT and the
commercial backends your OR-Tools build can load. Import it with
`const { Solver } = require('ortools-node')`. For Python's `model_builder` and
`mathopt` APIs see [model_builder.md](model_builder.md) and
[math_opt.md](math_opt.md). Back to the [README](../README.md).

## Example

```js
const { Solver } = require('ortools-node');

const lp = new Solver('GLOP');
const x = lp.numVar(0, Infinity, 'x');
const y = lp.numVar(0, Infinity, 'y');
const capacity = lp.addLessEq([[x, 1], [y, 2]], 14, 'capacity');
lp.addGreaterEq([[x, 3], [y, -1]], 0);
lp.addLessEq([[x, 1], [y, -1]], 2);
lp.maximize([[x, 3], [y, 4]]);

const result = await lp.solve();                     // runs on the libuv threadpool
console.log(result.status, result.objectiveValue.toFixed(2));   //=> OPTIMAL 34.00
console.log(x.value().toFixed(2), y.value().toFixed(2));        //=> 6.00 4.00
console.log(capacity.dualValue().toFixed(4));        //=> 2.3333
lp.dispose();
```

A MIP with a time limit, on whichever MIP backend the build has:

```js
const { Solver, supportsBackend } = require('ortools-node');

const backend = ['SCIP', 'HIGHS', 'CBC', 'CP_SAT'].find(supportsBackend);
const items = [{ weight: 4, value: 10 }, { weight: 7, value: 13 }, { weight: 5, value: 9 }, { weight: 3, value: 7 }];

const mip = new Solver(backend).setTimeLimit(5_000);
const take = items.map((_, i) => mip.boolVar(`take${i}`));
mip.addLessEq(items.map((item, i) => [take[i], item.weight]), 12, 'capacity');
mip.maximize(items.map((item, i) => [take[i], item.value]));

const result = mip.solveSync();                      // blocks the calling thread
console.log(result.status, result.objectiveValue);   //=> OPTIMAL 26
console.log(take.map((t) => t.value() > 0.5));       //=> [ true, false, true, true ]
mip.dispose();
```

Every method that takes an expression accepts any of these forms:

```js
const { Solver } = require('ortools-node');

const s = new Solver('GLOP');
const x = s.numVar(0, 10, 'x');
const y = s.numVar(0, 10, 'y');
s.addLessEq([[x, 3], [y, 4]], 24);                          // [variable, coefficient] pairs
s.addLessEq([[3, x], [4, y]], 24);                          // [coefficient, variable] pairs
s.addLessEq(new Map([[x, 3], [y, 4]]), 24);                 // Map<Variable, number>
s.addLessEq(x, 5);                                          // a single variable
s.addLessEq({ terms: [[x, 1], [y, 1]], constant: 2 }, 12);  // x + y + 2 <= 12
console.log(s.numConstraints, s.toLp().includes('x'));      //=> 5 true
s.dispose();
```

Stopping a long solve: `interrupt()` returns `false` on backends that cannot be
interrupted safely (see [Solver backends](../README.md#solver-backends)); a time
limit works everywhere.

```js
const { Solver } = require('ortools-node');

const solver = new Solver('GLOP');
const x = solver.numVar(0, 1, 'x');
solver.maximize(x);
const pending = solver.solve();
console.log(solver.busy);                       //=> true
solver.interrupt();                             // true when GLOP was still running
const result = await pending;                   // OPTIMAL, or NOT_SOLVED if it stopped first
console.log(['OPTIMAL', 'NOT_SOLVED'].includes(result.status), solver.busy); //=> true false
solver.dispose();
```

## API

### `new Solver(backend = 'GLOP', name?)`

A model on one backend. `name` appears in exported LP and MPS text.

| Member | Description |
|---|---|
| `numVar(lb?, ub?, name?)` | Continuous variable; bounds default to `-Infinity` / `Infinity`. |
| `intVar(lb?, ub?, name?)` | Integer variable. |
| `boolVar(name?)` | 0/1 integer variable. |
| `addConstraint(expr, lb?, ub?, name?)` | `lb <= expr <= ub`; returns a `Constraint`. |
| `addLessEq(expr, rhs, name?)`, `addGreaterEq`, `addEquality` | `expr <= rhs`, `expr >= rhs`, `expr = rhs`. |
| `minimize(expr)`, `maximize(expr)` | Replaces the objective. Returns the solver. |
| `setTimeLimit(ms)` | Wall-clock limit in milliseconds; `0` means none. |
| `setNumThreads(n)` | Threads, for backends that support it (SCIP, CP-SAT, ...). |
| `setSolverSpecificParameters(text)` | Backend parameter text, for example SCIP `limits/gap = 0.01`. Returns `false` when the backend rejects it. |
| `enableOutput(on = true)` | Prints the backend's search log. |
| `solve()` | `Promise<SolveResult>`; solves on the libuv threadpool. |
| `solveSync()` | `SolveResult`; solves on the calling thread. |
| `interrupt()` | Asks a pending `solve()` to stop; `false` when none is running or the backend cannot be interrupted safely. |
| `busy` | `true` while a `solve()` is pending. |
| `clear()` | Removes every variable and constraint; existing handles become invalid. |
| `dispose()`, `[Symbol.dispose]()` | Frees the native model now; later calls throw. During a `solve()` it frees the model once that solve settles. `using solver = new Solver(...)` (Node.js 24 and later) calls it at scope exit. |
| `toLp(obfuscated?)`, `toMps(fixed?, obfuscated?)` | The model as LP or MPS text. |
| `solverVersion()` | For example `Glop solver v9.15.6755`. |
| `backend`, `name`, `numVariables`, `numConstraints`, `variables`, `constraints` | Read-only properties. |

### `Variable` and `Constraint`

Handles returned by the solver, valid until `clear()` or `dispose()`.

| Member | Description |
|---|---|
| `variable.value()` | Value in the current solution. |
| `variable.reducedCost()` | Reduced cost; LP backends only. |
| `variable.setBounds(lb, ub)` | Changes the bounds. |
| `constraint.dualValue()` | Dual value (shadow price); LP backends only. |
| `constraint.setCoefficient(variable, coef)`, `constraint.setBounds(lb, ub)` | Edits the row. |
| `index`, `name`, `variable.isInteger` | Read-only properties. |

### `SolveResult`

| Field | Description |
|---|---|
| `status` | `'OPTIMAL'`, `'FEASIBLE'`, `'INFEASIBLE'`, `'UNBOUNDED'`, `'ABNORMAL'`, `'MODEL_INVALID'`, `'NOT_SOLVED'`, or `'UNKNOWN'` for a status this binding does not know. |
| `optimal`, `feasible` | Booleans derived from `status`. |
| `objectiveValue`, `bestBound` | `NaN` when there is no solution. |
| `wallTimeMs`, `iterations`, `nodes` | Solver statistics; `nodes` is `0` for LP backends. |

### Module exports

| Export | Description |
|---|---|
| `supportsBackend(name)` | Whether a backend is compiled into the loaded OR-Tools build. |
| `INF` | `Infinity`. |
| `ortoolsVersion` | The OR-Tools release loaded at runtime, for example `9.15.6755`. |
| `buildInfo` | `{ ortoolsVersion, napiVersion }` the addon was compiled with; loading fails when the two releases differ. |

```js
const { supportsBackend, ortoolsVersion, buildInfo, INF } = require('ortools-node');

console.log(supportsBackend('GLOP'), supportsBackend('NOT_A_SOLVER'));  //=> true false
console.log(ortoolsVersion === buildInfo.ortoolsVersion, INF);          //=> true Infinity
```

## Numbers

This module is double-based: bounds, coefficients and results are JavaScript
numbers. `Infinity` and `-Infinity` are valid bounds. `NaN` bounds, non-finite
coefficients and non-numeric values throw a `TypeError` and leave the model
unchanged. Integer variables return their value as a double (round it).

## Errors

The binding throws instead of returning a stale or misleading number.

| Situation | Error |
|---|---|
| Unknown backend, or one not compiled in | `Error: Unsupported or unavailable solver backend: 'NAME' (check your OR-Tools build; try supportsBackend())` |
| Reading `value()`, `dualValue()`, ... before a solve, or after the model changed | `Error: No solve result: call solve() first (the model changed since the last solve)` |
| Reading a value after a solve that found no solution | `Error: No solution available: the last solve was not OPTIMAL or FEASIBLE` |
| `dualValue()` or `reducedCost()` on a MIP backend | `Error: dualValue is only available for LP backends (e.g. GLOP, PDLP)` |
| A `Variable` or `Constraint` from another solver | `Error: Variable 'y' belongs to a different Solver` |
| A handle used after `clear()` or `dispose()` | `Error: Variable 'y' is no longer valid (Solver.clear() or dispose() was called)` |
| Any call after `dispose()` | `Error: Solver has been disposed` |
| Any call while `solve()` is pending, except `busy` and `interrupt()` | `Error: Solver is busy: a solve() is in progress` |
| `NaN` bound | `TypeError: lb must not be NaN` |
| Non-numeric bound | `TypeError: lb must be a number` |
| Non-finite coefficient | `TypeError: Expected a finite numeric coefficient` |
| Negative time limit | `RangeError: setTimeLimit(milliseconds): must be >= 0 (0 = no limit)` |
| `setNumThreads(0)` | `Error: setNumThreads failed: num_threads must be a positive number.` |
