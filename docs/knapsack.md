# Knapsack

`KnapsackSolver` solves 0-1 knapsack problems with one or several dimensions: pick the items with the largest total profit whose weights fit every capacity. It wraps OR-Tools' C++ `KnapsackSolver` (Python: `ortools.algorithms.python.knapsack_solver`). Import it with `const { KnapsackSolver, KnapsackSolverType } = require('ortools-node');`. Back to the [README](../README.md).

## Example

The OR-Tools Python sample (50 items, one dimension):

```js
const { KnapsackSolver, KnapsackSolverType } = require('ortools-node');

const values = [360, 83, 59, 130, 431, 67, 230, 52, 93, 125, 670, 892, 600, 38, 48, 147, 78, 256, 63, 17, 120,
  164, 432, 35, 92, 110, 22, 42, 50, 323, 514, 28, 87, 73, 78, 15, 26, 78, 210, 36, 85, 189, 274, 43, 33, 10, 19,
  389, 276, 312];
const weights = [[7, 0, 30, 22, 80, 94, 11, 81, 70, 64, 59, 18, 0, 36, 3, 8, 15, 42, 9, 0, 42, 47, 52, 32, 26, 48,
  55, 6, 29, 84, 2, 4, 18, 56, 7, 29, 93, 44, 71, 3, 86, 66, 31, 65, 0, 79, 20, 65, 52, 13]];
const capacities = [850];

const solver = new KnapsackSolver(KnapsackSolverType.KNAPSACK_MULTIDIMENSION_BRANCH_AND_BOUND_SOLVER, 'KnapsackExample');
solver.init(values, weights, capacities);
const profit = await solver.solve(); // off the main thread
const packed = values.map((_, i) => i).filter((i) => solver.bestSolutionContains(i));
console.log(profit); //=> 7534
console.log(packed.length, packed.reduce((sum, i) => sum + weights[0][i], 0)); //=> 32 850
console.log(solver.isSolutionOptimal()); //=> true
solver.dispose();
```

Several dimensions (weight and volume), typed arrays, `solveSync()`, a time limit, and a re-solve (every solve needs a fresh `init()`):

```js
const { KnapsackSolver, KnapsackSolverType } = require('ortools-node');

const solver = new KnapsackSolver(KnapsackSolverType.KNAPSACK_MULTIDIMENSION_BRANCH_AND_BOUND_SOLVER);
const profits = Int32Array.of(10, 13, 7, 8);
const weights = [Int32Array.of(4, 6, 3, 5), Int32Array.of(2, 1, 4, 3)];
solver.setTimeLimit(5).init(profits, weights, [10, 6]);
console.log(solver.solveSync()); //=> 23
console.log([0, 1, 2, 3].map((i) => solver.bestSolutionContains(i))); //=> [ true, true, false, false ]

solver.setUseReduction(false).init(profits, weights, [14, 10]);
console.log(solver.useReduction, solver.solveSync()); //=> false 30
console.log(solver.name, solver.busy); //=> knapsack false
solver.dispose();
```

## API

### `KnapsackSolverType`

Frozen object of the solver types this OR-Tools build can run, each mapped to its own name. The MIP-based types appear only when their backend is compiled in.

| Member | Description |
| --- | --- |
| `KNAPSACK_BRUTE_FORCE_SOLVER` | One dimension, at most 30 items. |
| `KNAPSACK_64ITEMS_SOLVER` | One dimension, at most 64 items. |
| `KNAPSACK_DYNAMIC_PROGRAMMING_SOLVER`, `KNAPSACK_DIVIDE_AND_CONQUER_SOLVER` | One dimension. |
| `KNAPSACK_MULTIDIMENSION_BRANCH_AND_BOUND_SOLVER` | Any number of dimensions; always available. |
| `KNAPSACK_MULTIDIMENSION_CP_SAT_SOLVER` | CP-SAT; each dimension's weights must add up to less than 2^62. |
| `KNAPSACK_MULTIDIMENSION_CBC_MIP_SOLVER`, `..._SCIP_MIP_SOLVER`, `..._XPRESS_MIP_SOLVER`, `..._CPLEX_MIP_SOLVER` | MIP backends (build-dependent); each dimension's weights must add up to at most 2^20. |

### `KnapsackSolver`

One knapsack solver of a fixed type.

| Member | Description |
| --- | --- |
| `new KnapsackSolver(solverType, name = 'knapsack')` | Throws for a type that is unknown or not in `KnapsackSolverType`. |
| `solverType`, `name` | The type and name given to the constructor. |
| `init(profits, weights, capacities)` | Loads `profits[i]`, `weights[d][i]` (item `i`, dimension `d`) and `capacities[d]`: non-negative integers as Arrays (numbers or BigInts) or typed arrays. Needed again before every solve. Returns `this`. |
| `solve()` | Solves on the threadpool; resolves to the total profit of the packed items. |
| `solveSync()` | Blocking `solve()`. |
| `bestSolutionContains(item)` | Whether the item is packed in the best solution found. |
| `isSolutionOptimal()` | True only when the profit is proven optimal (see below). |
| `setTimeLimit(seconds)` | Limit per solve; `Infinity` (the default) means none, `0` is allowed. The MIP types count limits under 1 ms as 1 ms. Returns `this`. |
| `setUseReduction(useReduction)`, `useReduction` | OR-Tools' problem reduction, on by default; a change needs a new `init()`. Returns `this`. |
| `busy` | True while a `solve()` is pending. |
| `dispose()`, `[Symbol.dispose]()` | Frees the native solver. Idempotent; throws while busy; later calls throw. |

`isSolutionOptimal()` caveats:

- false when the time limit stopped the search early;
- always false for the CBC type (CBC can prove wrong bounds), and for XPRESS and CPLEX (their bounds are unverified);
- false for SCIP once the profit found (weightless items aside) reaches 1e4: SCIP stops within a relative gap of 1e-4 and OR-Tools gives no way to change it, so the profit itself may also be below the optimum;
- the MIP types may in general return less than the optimum. Prefer the branch and bound, dynamic programming or CP-SAT types when you need a proven optimum.

```js
const { KnapsackSolver, KnapsackSolverType } = require('ortools-node');

for (const type of [KnapsackSolverType.KNAPSACK_DYNAMIC_PROGRAMMING_SOLVER, KnapsackSolverType.KNAPSACK_MULTIDIMENSION_CBC_MIP_SOLVER]) {
  if (type === undefined) continue; // CBC is not in every build
  const solver = new KnapsackSolver(type);
  solver.init([10, 13, 7, 8], [[4, 6, 3, 5]], [10]);
  console.log(type, solver.solveSync(), solver.isSolutionOptimal());
  solver.dispose();
}
```

## int64 and BigInt

- Profits, weights and capacities are non-negative int64 values: safe-integer numbers, BigInts, or `Int32Array`, `Uint32Array`, `Float64Array` or `BigInt64Array` elements.
- A number outside the safe range throws a RangeError asking for a BigInt; a BigInt outside int64 throws a RangeError.
- The profits must add up to at most `Number.MAX_SAFE_INTEGER`, so the profit `solve()` returns is always an exact number.
- Each dimension's weights must add up to at most int64 max (all types), below 2^62 (CP-SAT) or at most 2^20 (MIP types).

```js
const { KnapsackSolver, KnapsackSolverType } = require('ortools-node');

const solver = new KnapsackSolver(KnapsackSolverType.KNAPSACK_MULTIDIMENSION_BRANCH_AND_BOUND_SOLVER);
solver.init([2n ** 52n, 1], [[2n ** 62n, 1]], BigInt64Array.of(2n ** 63n - 1n));
console.log(solver.solveSync()); //=> 4503599627370497
solver.dispose();
```

## Errors

| Situation | Error |
| --- | --- |
| Unknown or unavailable solver type | `Error: Unsupported or unavailable knapsack solver type: 'NOPE'. Available in this build: ...` |
| `solve()` or `solveSync()` without a fresh `init()` (also after `setUseReduction()`) | `Error: No problem loaded: call init() before each solve() (setUseReduction() also needs a new init())` |
| `bestSolutionContains()` before any solve | `Error: No solve result: call init() and solve() first` |
| Item index out of range | `RangeError: item index out of range` |
| More than one dimension on a single-dimension type | `RangeError: KNAPSACK_DYNAMIC_PROGRAMMING_SOLVER handles exactly one dimension, got 2` |
| Too many items | `RangeError: KNAPSACK_BRUTE_FORCE_SOLVER handles at most 30 items, got 31` (64 for `KNAPSACK_64ITEMS_SOLVER`) |
| No dimension | `RangeError: weights must have at least one dimension` |
| Lengths disagree | `RangeError: weights[0] has 1 items but profits has 2`, `RangeError: capacities has 2 entries but weights has 1 dimensions` |
| Negative value | `RangeError: profits[1] must be >= 0` |
| Non-integer value | `TypeError: profits[0] must be an integer` |
| Unsafe number, BigInt outside int64 | `RangeError: profits[0] is outside the safe integer range; pass a BigInt`, `RangeError: profits[0] does not fit in a 64-bit integer` |
| Profits add up beyond the safe range | `RangeError: the sum of profits exceeds Number.MAX_SAFE_INTEGER` |
| Weights of a dimension overflow int64 | `RangeError: the sum of weights[0] overflows a 64-bit integer` |
| Weights too large for CP-SAT or a MIP type | `RangeError: KNAPSACK_MULTIDIMENSION_CP_SAT_SOLVER: the weights of dimension 0 add up to 2^62 or more, ...`, `RangeError: KNAPSACK_MULTIDIMENSION_CBC_MIP_SOLVER: the weights of dimension 0 add up to more than 2^20, ...` |
| Negative or `NaN` time limit, non-number | `RangeError: setTimeLimit(seconds): must be >= 0 (Infinity = no limit)`, `TypeError: seconds must not be NaN`, `TypeError: seconds must be a number` |
| `setUseReduction()` with a non-boolean | `TypeError: setUseReduction(useReduction: boolean)` |
| Any call while `solve()` is pending | `Error: KnapsackSolver is busy: a solve() is in progress` |
| Any call after `dispose()` | `Error: KnapsackSolver has been disposed` |
