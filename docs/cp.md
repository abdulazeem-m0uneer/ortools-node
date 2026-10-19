# Classic constraint programming (`cp`)

`cp.CpSolver` is the classic OR-Tools constraint programming solver, the C++
`operations_research::Solver` that Python exposes as `pywrapcp.Solver`. It
builds integer variables, expressions and constraints, searches with decision
builders and search monitors, and can call plain JS objects as search monitors.
It is also the solver behind every routing model (`model.solver()`, see
[Routing](routing.md)). Import it as `const { cp } = require('ortools-node');`.
The top-level `CpModel` / `CpSolver` exports are CP-SAT, a different solver.
Back to the [README](../README.md).

## Example

Enumerate every solution with `newSearch()` / `nextSolution()` / `endSearch()`;
`x.value()` reads the current solution.

```js
const { cp } = require('ortools-node');

const solver = new cp.CpSolver('demo');
const x = solver.intVar(0, 5, 'x');
const y = solver.intVar(0, 5, 'y');
solver.add(x.plus(y).eq(5));
solver.add(x.lt(y));
const db = solver.phase([x, y], cp.IntVarStrategy.CHOOSE_FIRST_UNBOUND, cp.IntValueStrategy.ASSIGN_MIN_VALUE);

solver.newSearch(db);
const found = [];
while (solver.nextSolution()) found.push([x.value(), y.value()]);
solver.endSearch();
console.log(JSON.stringify(found)); //=> [[0,5],[1,4],[2,3]]
console.log(solver.solutions()); //=> 3
solver.dispose();
```

### Solution collectors and optimization

`solve(db, monitors)` runs a whole search and returns `true` when it found a
solution. Without a monitor that asks for more (an all, last or best collector,
an objective, or a JS `atSolution()` returning `true`) it stops at the first
solution. Collectors record the variables added to them; read them after the
search.

```js
const { cp } = require('ortools-node');

const solver = new cp.CpSolver('collectors');
const items = [solver.intVar(0, 3, 'a'), solver.intVar(0, 3, 'b'), solver.intVar(0, 3, 'c')];
solver.add(solver.sum(items).le(6));
solver.add(solver.allDifferent(items));
const value = solver.scalProd(items, [4, 3, 2]);
const db = solver.phase(items, 'CHOOSE_FIRST_UNBOUND', 'ASSIGN_MIN_VALUE');

const all = solver.allSolutionCollector().add(items);
solver.solve(db, [all]);
console.log(all.solutionCount()); //=> 24

const best = solver.bestValueSolutionCollector(true).add(items).addObjective(value);
console.log(solver.solve(db, [best, solver.maximize(value, 1)])); //=> true
console.log(items.map((v) => best.value(0, v)), best.objectiveValue(0)); //=> [ 3, 2, 1 ] 20

const firstThree = solver.allSolutionCollector().add(items);
solver.solve(db, [firstThree, solver.solutionsLimit(3)]);
console.log(firstThree.solutionCount()); //=> 3
solver.dispose();
```

### JS search monitors

`solve()` and `newSearch()` accept plain objects next to `SearchMonitor`
handles. Each hook is an OR-Tools `SearchMonitor` method, camelCased, called
synchronously from inside the search. A decision is passed as its description,
which reflects the domains at that call.

```js
const { cp } = require('ortools-node');

const solver = new cp.CpSolver('hooks');
const x = solver.intVar(0, 2, 'x');
const db = solver.phase([x], 'CHOOSE_FIRST_UNBOUND', 'ASSIGN_MIN_VALUE');
const events = [];
const trace = {
  enterSearch() { events.push('enter'); },
  applyDecision(decision) { events.push(`apply ${decision}`); },
  beginFail() { events.push('fail'); },
  acceptSolution() { return x.value() !== 1; },  // reject x = 1
  atSolution() { events.push(`x=${x.value()}`); return true; },  // ask for more
  noMoreSolutions() { events.push('exhausted'); },
  exitSearch() { events.push('exit'); },
};
console.log(solver.solve(db, [trace])); //=> true
console.log(events.join(', ')); //=> enter, apply [x(0..2) == 0] or [x(0..2) != 0], x=0, fail, apply [x(1..2) == 1] or [x(1..2) != 1], fail, x=2, fail, exhausted, exit

// atSolution returning false stops the search.
const seen = [];
solver.solve(db, [{ atSolution() { seen.push(x.value()); return seen.length < 2; } }]);
console.log(seen); //=> [ 0, 1 ]

// A throw stops the search and is rethrown; the solver stays usable.
try {
  solver.solve(db, [{ atSolution() { throw new Error('stop'); } }]);
} catch (e) {
  console.log(e.message); //=> stop
}
console.log(solver.solve(db)); //=> true
solver.dispose();
```

### Searching off the JS thread

`solveAsync()` runs the search on the libuv threadpool and resolves to the
same boolean as `solve()`. It takes `SearchMonitor` handles only (JS cannot run
on the threadpool), so read results from collectors. `interrupt()` stops it.

```js
const { cp } = require('ortools-node');

// 13 pigeons in 12 holes: infeasible, and far too slow to prove by enumeration.
const solver = new cp.CpSolver('pigeons');
const pigeons = Array.from({ length: 13 }, (_, i) => solver.intVar(0, 11, `p${i}`));
for (let i = 0; i < 13; i++) for (let j = i + 1; j < 13; j++) solver.add(pigeons[i].ne(pigeons[j]));
const db = solver.phase(pigeons, 'CHOOSE_FIRST_UNBOUND', 'ASSIGN_MIN_VALUE');

console.log(await solver.solveAsync(db, [solver.timeLimit(100)])); //=> false

const running = solver.solveAsync(db);
console.log(solver.busy); //=> true
setTimeout(() => solver.interrupt(), 100);
console.log(await running); //=> false
console.log(solver.busy, solver.interrupt()); //=> false false
solver.dispose();
```

### Worker threads

`worker.terminate()` stops a `solveAsync()` running in that worker as soon as
JS can no longer run there. A synchronous `solve()` or `nextSolution()` blocks
the worker's thread: it stops at its next JS monitor hook, and without one it
runs to its limits like any blocking native call. See
[Routing](routing.md#worker-threads) for a runnable example.

## API

### `CpSolver`

`new cp.CpSolver(name = 'CpSolver')` creates a solver; every handle it returns is valid for that solver only.

| Member | Description |
|---|---|
| `intVar(min, max, name?)`, `intVar(values, name?)`, `boolVar(name?)`, `intConst(value, name?)` | Variables (`IntVar`); bounds may be `±Infinity`, `values` an Array or typed array. |
| `sum(exprs)`, `scalProd(vars, coefficients)`, `min(exprs)` / `min(a, b)`, `max(exprs)` / `max(a, b)`, `element(values, index)` | Expressions (`IntExpr`); `element` takes constants or expressions. |
| `add(constraint)` | Posts a constraint (outside a search only). |
| `allDifferent(vars)`, `allowedAssignments(vars, tuples)`, `memberCt(expr, values)`, `notMemberCt(expr, values)` | Constraints (`CpConstraint`). |
| `isEqualVar`, `isDifferentVar`, `isLessOrEqualVar`, `isLessVar`, `isGreaterOrEqualVar`, `isGreaterVar` `(a, b)`, `isMemberVar(expr, values)` | 0/1 variables reifying a condition. |
| `phase(vars, varStrategy, valueStrategy)`, `compose(...dbs)` / `compose(dbs)` | Decision builders. |
| `minimize(objective, step = 1)`, `maximize(objective, step = 1)` | Objective monitors; `step` must be > 0. |
| `limit({ timeMs, branches, failures, solutions, smartTimeCheck, cumulative })` | Search limit; every field optional and unlimited by default. |
| `timeLimit(ms)`, `branchesLimit(n)`, `failuresLimit(n)`, `solutionsLimit(n)` | Shorthands for `limit()`. |
| `searchLog(period, objective?)` | Logging monitor, every `period` branches (1 to 2^31 - 1). |
| `firstSolutionCollector()`, `lastSolutionCollector()`, `bestValueSolutionCollector(maximize)`, `allSolutionCollector()` | `SolutionCollector`s; the best collector needs `addObjective()`. |
| `newSearch(db, monitors?)`, `nextSolution()`, `endSearch()` | Iterate solutions on the calling thread; JS monitors allowed. |
| `solve(db, monitors?)` | Whole search on the calling thread; `true` when a solution was found. |
| `solveAsync(db, monitors?)` | Whole search on the threadpool; `Promise<boolean>`, `SearchMonitor` handles only. |
| `interrupt()` | Stops the running search; `false` when none runs. |
| `busy` | `true` while a `solveAsync()` is pending. |
| `wallTime()`, `branches()`, `failures()`, `solutions()` | Search counters (plain numbers). |
| `dispose()`, `[Symbol.dispose]()` | Frees the native solver now; idempotent, later calls throw. |

**Busy.** `busy` is `true` only while a `solveAsync()` is pending; any call
except `busy` and `interrupt()` then throws.

**Counters.** `solutions()` counts the solutions of the last search;
`branches()`, `failures()` and `wallTime()` (ms) are OR-Tools' totals since the
solver was created. `searchLog(period, objective?)` logs through OR-Tools'
absl `LOG(INFO)`, which prints nothing with the default absl log settings.

**Domain holes.** OR-Tools stores holes in a domain as a bitset of at most 2^32
values, so making a hole in a wider domain (`removeValue(s)`, `notMemberCt`,
`isMemberVar`, or `memberCt` with kept values more than 2^32 apart) throws a
`RangeError`; removing values at the bounds only moves the bounds and is always
accepted.

### `JsSearchMonitor`

A plain object passed to `solve()` or `newSearch()` (not `solveAsync()`); `lib/cp.d.ts` declares these 14 optional hooks.

| Member | Description |
|---|---|
| `enterSearch()`, `exitSearch()` | When the search starts and ends. |
| `beginInitialPropagation()`, `endInitialPropagation()` | Around the propagation before the first decision. |
| `beginNextDecision()`, `endNextDecision(decision \| null)` | Around asking the decision builder for a decision; `null` means none is left (a solution). |
| `applyDecision(decision)`, `refuteDecision(decision)`, `afterDecision(decision, apply)` | When a decision is taken, when it is refuted, and after either (`apply` is `true` after `applyDecision`). |
| `beginFail()`, `endFail()` | Around each backtrack. |
| `acceptSolution()` | Return `false` to reject the solution; any other value accepts it. |
| `atSolution()` | Return `false` to stop the search, `true` to ask for more solutions. Any other value keeps the default: `solve()` stops at the first solution, `newSearch()` iterates all. |
| `noMoreSolutions()` | When the search space is exhausted. |

Not exposed: `RestartSearch`, `AtLocalOptimum`, `AcceptDelta`,
`AcceptNeighbor`, `AcceptUncheckedNeighbor`, `IsUncheckedSolutionLimitReached`,
`PeriodicCheck` and `ProgressPercent` (restart, local search and progress
hooks: nothing in this API can trigger them), nor the internal `Accept` and
`Install`.

- Hooks are read once, when the search starts; replacing a method later has no
  effect, and a missing hook costs nothing. A hook set to `undefined` counts as
  missing; any other value that is not a function throws a `TypeError` naming
  the hook from `solve()` / `newSearch()`; a hook getter that throws makes
  them throw its error.
- An object is a JS monitor when it has at least one hook name as a property;
  any other monitor value throws a `TypeError`.
- Inside a hook, values can be read (`x.value()`, `x.min()`, counters) and
  `interrupt()` stops the search. Changing the model or starting, advancing or
  ending a search (`add`, `intVar`, `setMin`, `solve`, `newSearch`,
  `nextSolution`, `endSearch`, `dispose`) throws.
- A throw stops the search through the interrupt limit. No hook runs after it,
  not even `exitSearch()`, and the `solve()`, `nextSolution()` or `endSearch()`
  call that was running rethrows it once OR-Tools has unwound. After a throw
  from `nextSolution()` the search is already closed. The solver stays usable.

### `IntExpr`

An integer expression; `IntVar` extends it.

| Member | Description |
|---|---|
| `plus(o)`, `minus(o)`, `times(o)`, `abs()`, `square()`, `opposite()` | New expressions; `o` is an expression or an integer. |
| `eq(o)`, `ne(o)`, `le(o)`, `lt(o)`, `ge(o)`, `gt(o)` | Constraints; pass them to `add()`. |
| `min()`, `max()`, `bound()` | Current bounds, and whether they are equal. |
| `setMin(v)`, `setMax(v)`, `setRange(min, max)`, `setValue(v)` | Domain changes outside a search; return `this`. |
| `var()` | The expression as an `IntVar` (pywrapcp's `Var()`). |

### `IntVar`

A decision variable.

| Member | Description |
|---|---|
| `value()` | Value at a solution; throws when not bound. |
| `removeValue(v)`, `removeValues(values)` | Domain changes outside a search; return `this`. |
| `contains(v)`, `size()`, `name()` | Domain membership, number of values, name (`toString()` too). |

### `SolutionCollector`

A `SearchMonitor` that records solutions.

| Member | Description |
|---|---|
| `add(vars)`, `addObjective(objective)` | What to record; return `this`. |
| `solutionCount()` | Solutions recorded. |
| `value(n, variable)`, `objectiveValue(n)` | Recorded values of solution `n` (0-based). |
| `wallTime(n)`, `branches(n)`, `failures(n)` | Solver counters when solution `n` was found. |

### `CpConstraint`, `DecisionBuilder`, `SearchMonitor`

Opaque handles returned by the constraint, `phase()` / `compose()` and monitor factories; they have no public members.

### `IntVarStrategy`, `IntValueStrategy`

Frozen objects mapping each strategy name to itself; `phase()` also takes the plain strings.

| Member | Description |
|---|---|
| `IntVarStrategy` | `INT_VAR_DEFAULT`, `INT_VAR_SIMPLE`, `CHOOSE_FIRST_UNBOUND`, `CHOOSE_RANDOM`, `CHOOSE_MIN_SIZE_LOWEST_MIN`, `CHOOSE_MIN_SIZE_HIGHEST_MIN`, `CHOOSE_MIN_SIZE_LOWEST_MAX`, `CHOOSE_MIN_SIZE_HIGHEST_MAX`, `CHOOSE_LOWEST_MIN`, `CHOOSE_HIGHEST_MAX`, `CHOOSE_MIN_SIZE`, `CHOOSE_MAX_SIZE`, `CHOOSE_MAX_REGRET_ON_MIN`. |
| `IntValueStrategy` | `INT_VALUE_DEFAULT`, `INT_VALUE_SIMPLE`, `ASSIGN_MIN_VALUE`, `ASSIGN_MAX_VALUE`, `ASSIGN_RANDOM_VALUE`, `ASSIGN_CENTER_VALUE`, `SPLIT_LOWER_HALF`, `SPLIT_UPPER_HALF`. |

## int64 and BigInt

- **Inputs** (`CpInt`): a safe integer, a BigInt within int64, or `±Infinity`
  where a bound may be unlimited (`-Infinity` is int64 min, `Infinity` int64
  max). A number beyond `Number.MAX_SAFE_INTEGER` throws a `RangeError` asking
  for a BigInt; a fraction or `NaN` throws a `TypeError`.
- **Results** (`CpValue`: `min()`, `max()`, `value()`, collector values and
  objectives): a number up to `Number.MAX_SAFE_INTEGER`, an exact BigInt beyond,
  and `-Infinity` / `Infinity` for the int64 extremes, so
  `intVar(-Infinity, Infinity)` reads back as it was made. Overflowing
  arithmetic saturates to the extremes.
- **`size()`** is never Infinity: a BigInt beyond `Number.MAX_SAFE_INTEGER`, and
  `2n ** 64n` for the full int64 domain.
- **Search counters** (`wallTime()`, `branches()`, `failures()`,
  `solutions()`, and the collector's per-solution ones) are plain numbers,
  exact up to 2^53, which no realistic search reaches.

```js
const { cp } = require('ortools-node');

const solver = new cp.CpSolver();
const full = solver.intVar(-Infinity, Infinity, 'full');
console.log(full.min(), full.max(), full.size()); //=> -Infinity Infinity 18446744073709551616n
const big = solver.intVar(0, 2n ** 60n, 'big');
console.log(big.max(), big.size()); //=> 1152921504606846976n 1152921504606846977n
console.log(solver.intVar(0, Number.MAX_SAFE_INTEGER).max()); //=> 9007199254740991
console.log(solver.intVar(0, 2n ** 62n).times(4).max()); //=> Infinity
solver.dispose();
```

## Errors

Every row below was produced by running the call. Errors are `Error` unless
the class is given.

| Situation | Error |
|---|---|
| A domain change empties a domain (`setMin`, `setMax`, `setValue`, `removeValues`) | `CP solver failure: setMin() leaves a variable with an empty domain` |
| `x.value()` on an unbound variable | `IntVar 'x' is not bound: values are only available at a solution` |
| `intVar(min, max)` with `min > max` | `intVar(min, max): min must be <= max` |
| A number beyond `Number.MAX_SAFE_INTEGER` | `RangeError: max is outside the safe integer range; pass a BigInt` |
| A BigInt outside int64 | `RangeError: max does not fit in a 64-bit integer` |
| A fraction or `NaN` | `TypeError: max must be an integer`, `TypeError: max must not be NaN` |
| A hole in a domain wider than 2^32 values | `RangeError: removeValue(): OR-Tools cannot make holes in a domain wider than 2^32 values; narrow it first (setRange)` |
| Unknown strategy name | `TypeError: unknown variable strategy 'BOGUS'` (or `value strategy`) |
| A handle from another solver | `CpConstraint belongs to a different CpSolver` (or `IntExpr`, `SearchMonitor`, ...) |
| A handle after `dispose()` | `IntVar is no longer valid (its CpSolver was disposed)` |
| A solver call after `dispose()` | `CpSolver has been disposed` |
| Building or changing the model while a search is open, or inside a hook | `Cannot build or change the model while a search is open (call endSearch() first)` |
| `nextSolution()` / `endSearch()` with no open search | `nextSolution(): no search is open (call newSearch() first)` |
| Any call except `busy` / `interrupt()` during `solveAsync()` | `CpSolver is busy: a solve() is in progress` |
| A JS monitor passed to `solveAsync()` | `TypeError: JS search monitors run only in solve() and newSearch(), not solveAsync()` |
| A hook that is not a function | `TypeError: search monitor hook 'atSolution' must be a function` |
| A monitor that is neither a handle nor an object with a hook | `TypeError: a monitor must be a SearchMonitor or an object with search monitor hooks (atSolution, beginFail, ...)` |
| `monitors` not an array | `TypeError: monitors must be an array` |
| A hook throws | the hook's own error, rethrown by `solve()` / `nextSolution()` |
| Best collector without `addObjective()` | `a bestValueSolutionCollector needs addObjective() before searching` |
| Collector read of a variable not added | `IntVar 'y' was not added to this collector` |
| Collector solution index out of range | `RangeError: solution index out of range` |
| `objectiveValue(n)` without an objective | `this collector has no objective (addObjective())` |
| Tuple of the wrong length | `tuples[0] must have one value per variable` |
| `minimize(x, 0)` | `step must be > 0` |
| `searchLog(0)` | `period must be in [1, 2^31 - 1]` |
| `limit({ timeMs: -1 })` | `timeMs must be >= 0` |
| `min([])`, `element([], x)` | `min([]): at least one expression is required`, `element(values, index): values must not be empty` |
| `new cp.CpSolver(3)` | `TypeError: new CpSolver(name?: string)` |
| `dispose()` on `model.solver()` | `This CpSolver belongs to a RoutingModel: dispose the model instead` |
