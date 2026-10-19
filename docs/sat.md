# CP-SAT (`CpModel`, `CpSolver`)

`CpModel` and `CpSolver` are OR-Tools' CP-SAT solver, the equivalent of Python's
`ortools.sat.python.cp_model`: `CpModel` builds a `CpModelProto` in JS (integer,
Boolean and interval variables, linear and global constraints, objective, hints,
assumptions, decision strategies) and `CpSolver` solves it natively. Import the
names you need with
`const { CpModel, CpSolver, Domain, CpLinearExpr, CpSolverStatus } = require('ortools-node')`.
JS has no operator overloading, so `x + 2 * y <= 14` is written
`x.plus(y.times(2)).le(14)`. `CpLinearExpr` and `CpConstraint` carry a `Cp` prefix
because the linear solver already exports `Constraint` and `LinearExpr`. Solver
parameters are plain objects, see [params.md](params.md). Back to the
[README](../README.md).

## Example

```js
const { CpModel, CpSolver } = require('ortools-node');

const model = new CpModel();
const x = model.newIntVar(0, 10, 'x');
const y = model.newIntVar(0, 10, 'y');
model.add(x.plus(y.times(2)).le(14));
model.add(x.minus(y).ge(2));
model.maximize(x.plus(y));

const solver = new CpSolver();
solver.parameters = { maxTimeInSeconds: 10, numWorkers: 1 };
const status = await solver.solve(model);              // runs on the libuv threadpool
console.log(status);                                   //=> OPTIMAL
console.log(solver.value(x), solver.value(y), solver.objectiveValue);   //=> 10 2 12
console.log(String(x.plus(y.times(2)).le(14)));        //=> x + 2 * y in [-Infinity,14]
solver.dispose();
```

Every solution, in a callback (`enumerateAllSolutions` needs a model without objective):

```js
const { CpModel, CpSolver } = require('ortools-node');

const model = new CpModel();
const a = model.newIntVar(0, 2, 'a');
const b = model.newIntVar(0, 2, 'b');
model.add(a.plus(b).eq(2));

const solver = new CpSolver();
solver.parameters = { enumerateAllSolutions: true, numWorkers: 1 };
const found = [];
const status = await solver.solve(model, {
  onSolution: (s) => found.push(`${s.value(a)}+${s.value(b)}`),
});
console.log(status, found.sort());                     //=> OPTIMAL [ '0+2', '1+1', '2+0' ]

// stopSearch() inside the callback takes effect before the next solution.
let count = 0;
const stopped = await solver.solve(model, { onSolution: () => { count++; solver.stopSearch(); } });
console.log(stopped, count);                           //=> FEASIBLE 1
solver.dispose();
```

Stopping from outside (a timer, a request abort):

```js
const { CpModel, CpSolver, CpLinearExpr } = require('ortools-node');

const model = new CpModel();
const xs = Array.from({ length: 40 }, (_, i) => model.newIntVar(0, 100, `x${i}`));
model.addAllDifferent(xs);
model.add(CpLinearExpr.sum(xs).le(1000));
model.maximize(CpLinearExpr.weightedSum(xs, xs.map((_, i) => (i * 7919) % 31 + 1)));

const solver = new CpSolver();
solver.parameters = { maxTimeInSeconds: 30 };
const timer = setTimeout(() => solver.stopSearch(), 200);
const status = await solver.solve(model);
clearTimeout(timer);
console.log(status, solver.busy);                      // e.g. FEASIBLE false (UNKNOWN if no solution yet)
solver.dispose();
```

Intervals and scheduling:

```js
const { CpModel, CpSolver } = require('ortools-node');

const model = new CpModel();
const tasks = [3, 2, 4].map((duration, i) => {
  const start = model.newIntVar(0, 20, `start${i}`);
  return model.newFixedSizeIntervalVar(start, duration, `task${i}`);
});
model.addNoOverlap(tasks);
const makespan = model.newIntVar(0, 20, 'makespan');
model.addMaxEquality(makespan, tasks.map((t) => t.endExpr()));
model.minimize(makespan);

const solver = new CpSolver();
solver.parameters = { numWorkers: 1 };
console.log(solver.solveSync(model), solver.value(makespan));   //=> OPTIMAL 9
console.log(tasks[0].name, String(tasks[0].endExpr()));        //=> task0 start0 + 3
solver.dispose();
```

int64 values beyond 2^53 are BigInts, in and out:

```js
const { CpModel, CpSolver, Domain } = require('ortools-node');

const model = new CpModel();
const big = model.newIntVar(2n ** 60n, 2n ** 60n + 5n, 'big');
model.minimize(big);

const solver = new CpSolver();
solver.parameters = { numWorkers: 1 };
solver.solveSync(model);
console.log(solver.value(big));                        //=> 1152921504606846976n
console.log(solver.value(big.minus(2n ** 60n)));       //=> 0
console.log(solver.objectiveValue);                    //=> 1152921504606847000
console.log(new Domain(0, 2n ** 63n - 1n).toString()); //=> [0,Infinity]
solver.dispose();
```

Literals, assumptions and the infeasible core:

```js
const { CpModel, CpSolver } = require('ortools-node');

const model = new CpModel();
const p = model.newBoolVar('p');
const q = model.newBoolVar('q');
model.addImplication(p, q.not());                     // p => not q
model.addAssumptions(p, q);

const solver = new CpSolver();
solver.parameters = { numWorkers: 1 };
console.log(solver.solveSync(model));                  //=> INFEASIBLE
console.log(solver.sufficientAssumptionsForInfeasibility().sort());   //=> [ 0, 1 ]
console.log(q.not().index, String(q.not()));           //=> -2 not(q)
solver.dispose();
```

## API

Types used below: `Int` is a safe-integer `number` or a `bigint`; `LinearExprLike` is
a `CpLinearExpr` or an `Int`; `Literal` is a Boolean `IntVar`, its `not()`, or a
`boolean` constant; `Arc` is `[tail, head, literal]` with node indices in
`[0, 2^31 - 1]`. Methods taking a list (`addBoolOr`, `addAllDifferent`,
`addAssumptions`, `onlyEnforceIf`, ...) accept one Array or separate arguments where
the `.d.ts` shows both overloads.

### `CpSolverStatus`, `VariableSelectionStrategy`, `DomainReductionStrategy`

Frozen objects mapping each name to itself, read from the OR-Tools build in use.

| Member | Description |
| --- | --- |
| `CpSolverStatus` | `UNKNOWN`, `MODEL_INVALID`, `FEASIBLE`, `INFEASIBLE`, `OPTIMAL`. |
| `VariableSelectionStrategy` | `CHOOSE_FIRST`, `CHOOSE_LOWEST_MIN`, `CHOOSE_HIGHEST_MAX`, `CHOOSE_MIN_DOMAIN_SIZE`, `CHOOSE_MAX_DOMAIN_SIZE`. |
| `DomainReductionStrategy` | `SELECT_MIN_VALUE`, `SELECT_MAX_VALUE`, `SELECT_LOWER_HALF`, `SELECT_UPPER_HALF`, `SELECT_MEDIAN_VALUE`, `SELECT_RANDOM_HALF`. |

### `Domain`

An immutable, sorted list of disjoint integer intervals (OR-Tools' `Domain`).

| Member | Description |
| --- | --- |
| `new Domain(lb, ub)` | `[lb, ub]`; empty when `lb > ub`; `±Infinity` (or the BigInt int64 extremes) means unbounded. |
| `Domain.allValues()` | Every int64 value, `[-Infinity,Infinity]`. |
| `Domain.fromValues(values)` | The set of finite values, e.g. `[1, 3, 4]` gives `[1][3,4]`. |
| `Domain.fromIntervals(intervals)` | Union of `[lo, hi]` pairs; `[v]` means `[v, v]`. Overlapping or adjacent intervals merge. |
| `Domain.fromFlatIntervals(flat)` | Union of `[flat[0], flat[1]]`, `[flat[2], flat[3]]`, ... (even length). |
| `flattenedIntervals()` | `[lo0, hi0, lo1, hi1, ...]`, with `±Infinity` for the int64 extremes. |
| `isEmpty()`, `min()`, `max()` | Emptiness; smallest / largest value (`RangeError` on an empty domain). |
| `contains(value)` | Membership of a finite value. |
| `complement()` | Every int64 value not in the domain. |
| `toString()` | `[1,5]`, `[1][3,4]`, `[-Infinity,0][3,4][6,Infinity]`. |

### `CpLinearExpr`

An immutable integer linear expression. Not constructible: build expressions from
variables, the methods below and the static helpers. Integers are folded into the
constant; overflow is detected when the expression is used (added, solved, evaluated).

| Member | Description |
| --- | --- |
| `plus(other)`, `minus(other)` | `this + other`, `this - other`; `other` is a `LinearExprLike`. |
| `times(coefficient)`, `neg()` | `this * coefficient` (an `Int`), `-this`. |
| `le`, `ge`, `lt`, `gt`, `eq`, `ne` `(other)` | A `BoundedLinearExpr` for `this op other`; pass it to `CpModel.add()`. |
| `CpLinearExpr.sum(exprs)` | Sum of expressions and integers. |
| `CpLinearExpr.weightedSum(exprs, coefficients)` | `Σ exprs[i] * coefficients[i]`; arrays of the same length. |
| `CpLinearExpr.term(expr, c)`, `affine(expr, c, offset)` | `expr * c`, `expr * c + offset`. |
| `CpLinearExpr.constant(value)` | A constant expression. |
| `toString()` | Flattened form, e.g. `x + 2 * y + 3`. |

### `IntVar`

An integer variable, a `CpLinearExpr` with these extra members; only valid for the
`CpModel` that created it.

| Member | Description |
| --- | --- |
| `index` | Position in the model's `variables`. |
| `name`, `domain` | The name given (or `''`) and the `Domain`. `toString()` is the name, or `x<index>`. |
| `isBoolean` | `true` when the domain lies in `[0, 1]`; only then is it a literal. |
| `not()` | The negated literal (`NotBooleanVariable`); `TypeError` unless `isBoolean`. |

### `NotBooleanVariable`

`not(x)` for a Boolean variable `x`; as an expression it is `1 - x`.

| Member | Description |
| --- | --- |
| `index` | The proto literal, `-x.index - 1`. |
| `not()` | Back to `x`. `toString()` is `not(x)`. |

### `BoundedLinearExpr`

`expr ∈ domain`, returned by the comparison methods.

| Member | Description |
| --- | --- |
| `expr`, `domain` | The expression and the `Domain` it must lie in. `toString()` gives `x + 2 * y in [-Infinity,14]`. |

### `CpConstraint`

A constraint in a model, returned by every `CpModel.add*()` method.

| Member | Description |
| --- | --- |
| `index`, `name` | Position in the model's `constraints`; name (`''` when unset). |
| `onlyEnforceIf(...literals)` | Enforce only when every literal is true; may be called several times. Returns `this`. |
| `withName(name)` | Sets the name (shown in OR-Tools' messages). Returns `this`. |

### `IntervalVar`

An interval `start + size == end`, for `addNoOverlap`, `addNoOverlap2D` and `addCumulative`.

| Member | Description |
| --- | --- |
| `index`, `name` | Position of its interval constraint; name. |
| `startExpr()`, `sizeExpr()`, `endExpr()` | The expressions it was built from. |
| `presenceLiteral()` | The literal of an optional interval, else `null`. |

### `CpModel`

Builds a `CpModelProto` the way Python's `cp_model.CpModel` does.

| Member | Description |
| --- | --- |
| `new CpModel()`, `name` | An empty model; `name` is a read/write string. |
| `newIntVar(lb, ub, name?)`, `newIntVarFromDomain(domain, name?)` | Integer variables. CP-SAT requires bounds within `±(2^62 - 1)` (checked at validation). |
| `newBoolVar(name?)` | A variable in `[0, 1]`, usable as a literal. |
| `newConstant(value)` | A fixed variable; equal values share one variable. |
| `newIntervalVar(start, size, end, name?)` | Interval; each argument affine (at most one variable) or constant. |
| `newOptionalIntervalVar(start, size, end, isPresent, name?)` | Interval only present when `isPresent` is true. |
| `newFixedSizeIntervalVar(start, size, name?)`, `newOptionalFixedSizeIntervalVar(start, size, isPresent, name?)` | Same with an integer `size`, `end = start + size`. |
| `add(bounded \| boolean)` | Adds a `BoundedLinearExpr`; `true` / `false` add a trivially true / false constraint. |
| `addLinearConstraint(expr, lb, ub)`, `addLinearExpressionInDomain(expr, domain)` | `lb <= expr <= ub` (`±Infinity` leaves a side open); `expr ∈ domain`. |
| `addBoolOr`, `addAtLeastOne`, `addAtMostOne`, `addExactlyOne`, `addBoolAnd`, `addBoolXor` | Boolean constraints on literals. |
| `addImplication(a, b)` | `a => b`. |
| `addAllDifferent(exprs)` | Pairwise different. |
| `addElement(index, exprs, target)` | `target == exprs[index]`. |
| `addCircuit(arcs)`, `addMultipleCircuit(arcs)` | One circuit over the arcs whose literal is true (a self-loop skips its node); several routes through depot node 0. |
| `addAllowedAssignments(exprs, tuples)`, `addForbiddenAssignments(exprs, tuples)` | Table constraints. |
| `addAutomaton(exprs, startingState, finalStates, triples)` | `triples` are `[tail state, label, head state]`. |
| `addInverse(vars, inverseVars)` | `vars[i] == j <=> inverseVars[j] == i`. |
| `addReservoirConstraint(times, levelChanges, minLevel, maxLevel)`, `addReservoirConstraintWithActive(..., actives, minLevel, maxLevel)` | Reservoir; needs `minLevel <= 0 <= maxLevel`. |
| `addMinEquality`, `addMaxEquality` `(target, exprs)`, `addAbsEquality(target, expr)` | `target == min / max / abs`. |
| `addMultiplicationEquality(target, exprs)`, `addDivisionEquality(target, num, den)`, `addModuloEquality(target, expr, mod)` | Product, integer division, modulo. |
| `addNoOverlap(intervals)`, `addNoOverlap2D(xIntervals, yIntervals)`, `addCumulative(intervals, demands, capacity)` | Scheduling constraints. |
| `minimize(expr)`, `maximize(expr)`, `hasObjective()`, `clearObjective()` | Objective. |
| `addHint(var, value)`, `clearHints()` | Solution hint; a negated literal takes a boolean, 0 or 1. |
| `addAssumption(literal)`, `addAssumptions(literals)`, `clearAssumptions()` | Assumptions, see `sufficientAssumptionsForInfeasibility()`. |
| `addDecisionStrategy(vars, varStrategy, domainStrategy)` | Branching order on `IntVar`s or negated literals, by strategy name. |
| `toJSON()` | A copy of the `CpModelProto` in protobuf JSON form (int64 fields as strings). |
| `validate()` | `''` when valid, otherwise OR-Tools' description of the first problem. |
| `modelStats()` | OR-Tools' model statistics; throws `Invalid CpModel: ...` for an invalid model. |

### `CpSolver`

Solves a `CpModel`; result accessors read the last solve.

| Member | Description |
| --- | --- |
| `new CpSolver()`, `parameters` | `parameters` is a plain `SatParameters` object (see [params.md](params.md)), read back as assigned and validated at each solve; `null` or `undefined` leaves a field at its default. |
| `solve(model, { onSolution }?)` | Solves on the libuv threadpool; resolves to the status name. |
| `solveSync(model)` | Blocking solve; `onSolution` is not supported. |
| `stopSearch()` | Stops the running search (also from inside `onSolution`); `false` when none is running. |
| `busy` | `true` while a `solve()` is pending. |
| `dispose()`, `[Symbol.dispose]()` | Drops the last result; later solves and reads throw, `stopSearch()` returns `false`. Idempotent; throws while busy. |
| `statusName()` | `OPTIMAL`, `FEASIBLE`, `INFEASIBLE`, `MODEL_INVALID` or `UNKNOWN`. |
| `value(expr)`, `booleanValue(literal)` | Value of an expression (number, or BigInt beyond 2^53 - 1) or literal; need `OPTIMAL` / `FEASIBLE`. |
| `objectiveValue`, `bestObjectiveBound` | Doubles. `objectiveValue` needs a solution; `bestObjectiveBound` throws after `INFEASIBLE` / `MODEL_INVALID`. Both are `0` without objective. |
| `wallTime`, `userTime`, `deterministicTime` | Seconds. |
| `numBooleans`, `numBranches`, `numConflicts` | Search counters, as numbers. |
| `responseStats()`, `solutionInfo()` | OR-Tools' response summary text; the solution info string. |
| `responseProto()` | The `CpSolverResponse` in protobuf JSON form (int64 fields, including `solution`, as strings). |
| `sufficientAssumptionsForInfeasibility()` | Proto literal indices of assumptions infeasible together. |

`onSolution(snapshot)` runs on the main thread for each solution and the search waits
for it (like Python's `CpSolverSolutionCallback`). Inside it the solver is busy: its
result accessors throw, `stopSearch()` works. A throw stops the search and rejects
`solve()` with that error.

### `SolutionSnapshot`

One solution, passed to `onSolution`. Frozen; still readable after the callback returns.

| Member | Description |
| --- | --- |
| `value(expr)`, `booleanValue(literal)` | Values in this solution. |
| `objectiveValue`, `bestObjectiveBound` | At this solution, as numbers (`0` without objective). |
| `wallTime`, `userTime`, `deterministicTime` | Seconds spent when this solution was found. |
| `solutionIndex` | `0` for the first solution of the solve, then 1, 2, ... |

## int64 and BigInt

- Inputs (bounds, coefficients, constants, tuples, hints): a safe-integer `number`
  or a `bigint` within int64. A number outside `±(2^53 - 1)` is a `RangeError`
  ("pass a BigInt"); fractions, `NaN` and strings are `TypeError`s; a BigInt outside
  int64 is a `RangeError`.
- Results (`value()`, `Domain.min()`, `flattenedIntervals()`): a number when the value
  is a safe integer, a BigInt only beyond 2^53 - 1, so equal values compare with `===`.
  `objectiveValue` and `bestObjectiveBound` are doubles (like Python).
- In domains and bounds, `Infinity` / `-Infinity` and the BigInts `2n ** 63n - 1n` /
  `-(2n ** 63n)` all mean the int64 extremes ("unbounded") and read back as
  `±Infinity`. A single value (`Domain.fromValues`, `contains`) must be finite.
- Comparing with a constant keeps the constant in the domain: `x.le(Infinity)` is
  unbounded, `x.gt(Infinity)` and `x.lt(-Infinity)` are an empty domain (the model is
  `INFEASIBLE`; Python raises instead). `eq` with either extreme, `ge(INT64_MAX)` and
  `le(INT64_MIN)` throw a `RangeError` (Python: `ValueError` / `ArithmeticError`).
- Arithmetic that overflows int64 throws a `RangeError` when the expression is
  flattened (on `add()`, `value()`, `minimize()`...), never wraps.
- `toJSON()` and `responseProto()` write int64 fields as decimal strings.

## Errors

| Situation | Error |
| --- | --- |
| Non-integer bound or coefficient | `TypeError`: `Domain ub must be an integer`, `coefficient must be an integer` |
| `NaN` / string where an integer is expected | `TypeError`: `Domain lb must not be NaN`, `must be an integer number or a BigInt` |
| Number beyond 2^53 - 1 | `RangeError`: `Domain ub is outside the safe integer range; pass a BigInt` |
| BigInt outside int64 | `RangeError`: `Domain ub does not fit in a 64-bit integer` |
| int64 overflow in an expression | `RangeError`: `coefficient does not fit in a 64-bit integer` |
| `Infinity` coefficient or single value | `TypeError`: `coefficient must be finite`, `values[0] must be finite` |
| `eq` / `ge` / `le` with an int64 extreme | `RangeError`: `eq(INT64_MAX) is not supported`, `ge(INT64_MAX) ...`, `le(INT64_MIN) ...` |
| `min()` / `max()` of an empty domain | `RangeError`: `An empty Domain has no min()` |
| `new CpLinearExpr()` | `TypeError`: `CpLinearExpr is closed: build expressions from variables, ...` |
| `not()` on a non-Boolean variable | `TypeError`: `not(): 'x' is not a Boolean variable (domain [0,10])` |
| Non-Boolean variable as a literal | `TypeError`: `literal 0 'x' is not a Boolean variable` |
| `add()` with something other than a comparison or boolean | `TypeError`: `add(): expected a bounded linear expression (e.g. x.le(3)) or a boolean, got IntVar` |
| Variable from another model | `Error`: `Variable in linear expression 'x' belongs to a different CpModel` |
| Interval argument with two variables | `TypeError`: `interval start must be affine or constant, got 2 variables` |
| Boolean interval argument | `TypeError`: `interval start must be a linear expression or an integer, got boolean` |
| Arrays of different lengths | `RangeError`: `addCumulative: intervals and demands must have the same length (0 vs 1)` |
| Empty list where one is required | `RangeError`: `addMinEquality: expressions must not be empty` |
| Bad arc or tuple shape | `TypeError`: `arcs[0] must be [tail, head, literal]`, `tuples[0] must be an Array of 1 integers` |
| Constant element index out of range | `RangeError`: `index 5 is out of range for 2 expressions` |
| Reservoir levels | `RangeError`: `Reservoir constraint must have minLevel <= 0` |
| Negated literal hinted with 2 | `TypeError`: `A literal hint must be a boolean, 0 or 1` |
| Unknown strategy name | `TypeError`: `Unknown VariableSelectionStrategy 'NOPE'` |
| Name with a lone surrogate | `TypeError`: `withName(name): name must be well-formed Unicode (no lone surrogates)` |
| Model OR-Tools rejects (`solve`, `solveSync`, `modelStats`) | `Error`: `Invalid CpModel: ` + OR-Tools' text, e.g. `Division by 0: ...` |
| Variable bounds beyond `±(2^62 - 1)` | `Invalid CpModel: var #0 domain do not fall in [-kint64max / 2, kint64max / 2]...` |
| Bad `parameters` | `TypeError` / `RangeError`: `Invalid SatParameters: unknown field 'numWorker'`, see [params.md](params.md) |
| `onSolution` with `solveSync()` | `TypeError`: `onSolution needs solve(): solveSync() cannot call into JS during the search` |
| `onSolution` not a function, options not an object | `TypeError`: `onSolution must be a function`, `solve options must be an object` |
| Not a `CpModel` | `TypeError`: `Expected a CpModel, got Object` |
| Reading results before any solve | `Error`: `No solve result: call solve() first` |
| `value()` / `objectiveValue` without a solution | `Error`: `value(): no solution, the last solve ended INFEASIBLE` |
| `bestObjectiveBound` after `INFEASIBLE` | `Error`: `No objective bound: the last solve ended INFEASIBLE` |
| `value()` of a variable from another model, or created after the solve | `Error`: `Variable 'w' belongs to a different CpModel than the one solved`, `Variable 'late' was created after the solve` |
| `booleanValue()` of a non-Boolean variable | `TypeError`: `booleanValue(literal): 'x' is not a Boolean variable` |
| Solve, read or `dispose()` while a `solve()` is pending | `Error`: `CpSolver is busy: a solve() is in progress` |
| Anything after `dispose()` | `Error`: `CpSolver has been disposed` |
| `onSolution` throws | `solve()` rejects with that same error |
