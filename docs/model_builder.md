# Model builder (`modelBuilder`)

`modelBuilder` is Python's `ortools.linear_solver.python.model_builder`: a linear
or mixed-integer model built in JS with `LinearExpr` arithmetic, sent to OR-Tools
as an `MPModelProto` and solved by a `Solver` on any backend compiled into the
build. Import it with `const { modelBuilder } = require('ortools-node')`. Unlike
the top-level `Solver` (`MPSolver`, see [linear_solver.md](linear_solver.md)),
the model and the solver are separate objects: one `Model` can be cloned,
exported, imported from LP or MPS text and solved by several solvers. Enforced
(indicator) constraints are supported; general and quadratic constraints are not.
For Python's `mathopt` see [math_opt.md](math_opt.md). Back to the
[README](../README.md).

## Example

An LP on GLOP, with duals, reduced costs and activities:

```js
const { modelBuilder } = require('ortools-node');
const { Model, Solver } = modelBuilder;

const model = new Model('lp');
const x = model.newNumVar(0, Infinity, 'x');
const y = model.newNumVar(0, Infinity, 'y');
const c0 = model.add(x.plus(y.times(2)).le(14), 'c0');
const c1 = model.add(x.times(3).minus(y).ge(0), 'c1');
model.add(x.minus(y).le(2), 'c2');
model.maximize(x.times(3).plus(y.times(4)));

const solver = new Solver('GLOP');
console.log(await solver.solve(model));               //=> OPTIMAL
console.log(solver.objectiveValue.toFixed(2));         //=> 34.00
console.log(solver.values([x, y]).map((v) => v.toFixed(2)));   //=> [ '6.00', '4.00' ]
console.log(solver.dualValue(c0).toFixed(4));          //=> 2.3333
console.log(solver.reducedCost(x).toFixed(4));         //=> 0.0000
console.log(solver.activity(c1).toFixed(2));           //=> 14.00
solver.dispose();
```

A MIP with a time limit on SCIP:

```js
const { modelBuilder } = require('ortools-node');
const { Model, Solver, LinearExpr } = modelBuilder;

const weights = [4, 7, 5, 3];
const values = [10, 13, 9, 7];
const model = new Model('knapsack');
const take = weights.map((_, i) => model.newBoolVar(`take${i}`));
model.add(LinearExpr.weightedSum(take, weights).le(12), 'capacity');
model.maximize(LinearExpr.weightedSum(take, values));

const solver = new Solver('SCIP').setTimeLimitInSeconds(5);
console.log(solver.solveSync(model), solver.objectiveValue);   //=> OPTIMAL 26
console.log(take.map((t) => solver.value(t) > 0.5));           //=> [ true, false, true, true ]
solver.dispose();
```

An enforced (indicator) constraint: `v >= 5` holds only when `on` is 1, and
`v <= 0` only when it is 0. SCIP and CP_SAT accept them; CBC and HiGHS end
`MODEL_INVALID`.

```js
const { modelBuilder } = require('ortools-node');
const { Model, Solver } = modelBuilder;

const model = new Model();
const v = model.newIntVar(0, 10, 'v');
const on = model.newBoolVar('on');
model.addEnforced(v.ge(5), on, true);
model.addEnforced(v.le(0), on, false);
model.maximize(v.minus(on.times(3)));

const solver = new Solver('CP_SAT');
console.log(solver.solveSync(model), solver.objectiveValue);   //=> OPTIMAL 7
console.log(model.numEnforcedConstraints);                      //=> 2
solver.dispose();
```

LP import and export. OR-Tools' LP parser leaves a variable without a bound free
(`-Infinity` to `Infinity`):

```js
const { modelBuilder } = require('ortools-node');
const { Model, Solver } = modelBuilder;

const model = new Model().importFromLpString('max: 3x + 2y;\nc1: x + y <= 4;\nc2: x + 3y <= 6;\nx <= 3;\nint x;\n');
console.log(model.getVariables().map(String), model.numConstraints);   //=> [ 'x', 'y' ] 2
console.log(model.varFromIndex(0).upperBound, model.varFromIndex(0).isIntegral);   //=> 3 true

const copy = new Model().importFromMpsString(model.exportToMpsString());
const solver = new Solver('SCIP');
console.log(solver.solveSync(copy), solver.objectiveValue);   //=> OPTIMAL 11
console.log(model.exportToLpString().includes('c1:'));         //=> true
solver.dispose();
```

`solve()` runs off the main thread, so `interrupt()` can stop it on backends that
support it, such as CP_SAT (for SCIP and HiGHS `interrupt()` returns false).
This market split model takes CP-SAT about 10 s:

```js
const { modelBuilder } = require('ortools-node');
const { Model, Solver, LinearExpr } = modelBuilder;

let state = 12345;
const rand = () => { // mulberry32, deterministic
  state = (state + 0x6d2b79f5) | 0;
  let t = Math.imul(state ^ (state >>> 15), state | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) % 100;
};
const model = new Model('market split');
const x = Array.from({ length: 30 }, (_, j) => model.newBoolVar(`x${j}`));
for (let i = 0; i < 4; i++) {
  const a = x.map(() => rand());
  model.add(LinearExpr.weightedSum(x, a).eq(Math.floor(a.reduce((p, q) => p + q, 0) / 2)));
}

const solver = new Solver('CP_SAT').setTimeLimitInSeconds(60);
const pending = solver.solve(model);
console.log(solver.busy);                         //=> true
setTimeout(() => solver.interrupt(), 100);
console.log(await pending);                       //=> NOT_SOLVED
solver.dispose();
```

## API

### `Model`

A linear or mixed-integer model; handles are indices into it.

| Member | Description |
| --- | --- |
| `new Model(name = '')`, `name` | Model name (a string). |
| `newVar(lb, ub, isIntegral, name?)` | New variable; bounds may be `+-Infinity`. |
| `newNumVar(lb, ub, name?)`, `newIntVar(lb, ub, name?)`, `newBoolVar(name?)` | Continuous, integer, or integer in [0, 1]. |
| `numVariables`, `getVariables()`, `varFromIndex(i)` | Variable count, all handles (a copy), handle by index. |
| `addLinearConstraint(expr, lb = -Infinity, ub = Infinity, name?)` | `lb <= expr <= ub`; a constant in `expr` moves to the bounds. |
| `add(bounded, name?)` | Adds a `BoundedLinearExpression` such as `x.plus(y).le(5)`. |
| `addEnforcedLinearConstraint(expr, indicator, indicatorValue, lb?, ub?, name?)`, `addEnforced(bounded, indicator, indicatorValue, name?)` | Constraint that holds only when `indicator` equals `indicatorValue` (a boolean). |
| `numConstraints`, `getLinearConstraints()`, `linearConstraintFromIndex(i)` | Linear constraints. |
| `numEnforcedConstraints`, `getEnforcedLinearConstraints()`, `enforcedLinearConstraintFromIndex(i)` | Enforced constraints. |
| `minimize(expr)`, `maximize(expr)`, `setObjective(expr, maximize)` | Replace the objective (coefficients, offset and sense); chainable. |
| `clearObjective()` | Zeroes coefficients and offset; the sense is kept. |
| `objectiveExpression()`, `objectiveOffset`, `maximizing` | Objective as a `LinearExpr`, its constant, its sense (read-only). |
| `addHint(variable, value)`, `clearHints()` | Solution hint; a second hint for a variable replaces the first. HiGHS ignores hints. |
| `clone(name?)` | Independent copy (with new handles). |
| `exportToProto()` | `MPModelProto` as a plain object (infinite bounds stay `+-Infinity`). |
| `exportToLpString(obfuscate = false)`, `exportToMpsString(obfuscate = false)` | LP or MPS text; `obfuscate` renames variables and constraints. MPS cannot hold enforced constraints. |
| `importFromLpString(text)`, `importFromMpsString(text)` | Replace the model with parsed text (fixed or free MPS). Earlier handles become invalid; on a parse error the model is unchanged. |

### `Variable`

A decision variable, also a `LinearExpr` (`1 * variable`). `String(v)` is its name
or `variable#<index>`.

| Member | Description |
| --- | --- |
| `index` | Position in the model (read-only). |
| `name`, `lowerBound`, `upperBound`, `isIntegral`, `objectiveCoefficient` | Read and write. |

### `LinearConstraint` and `EnforcedLinearConstraint`

`lowerBound <= sum(coeff * variable) <= upperBound`; the enforced kind also has an
indicator. They are distinct types: `Solver.dualValue()` and `activity()` take
only a `LinearConstraint`.

| Member | Description |
| --- | --- |
| `index`, `name`, `lowerBound`, `upperBound` | Index is read-only; the rest read and write. |
| `setCoefficient(variable, coeff)` | Sets a coefficient (0 keeps a zero term); chainable. |
| `addTerm(variable, coeff)` | Adds to a coefficient; chainable. |
| `clearTerms()`, `terms()` | Remove all terms; `[variable, coefficient]` pairs. |
| `indicatorVariable`, `indicatorValue` | Enforced only: the indicator and the value (boolean) that enables the constraint. |

### `Solver`

Solves models with one backend and keeps the result of the last solve.

| Member | Description |
| --- | --- |
| `new Solver(solverName)`, `solverName` | Any backend this build has (`'GLOP'`, `'PDLP'`, `'CLP'`, `'SCIP'`, `'CBC'`, `'CP_SAT'`, `'SAT'`, `'BOP'`, `'HIGHS'`...; case-insensitive). |
| `isSolverSupported(solverName)` | Module function: whether `new Solver(solverName)` works here. |
| `setTimeLimitInSeconds(seconds)` | `Infinity` removes the limit; chainable. |
| `setSolverSpecificParameters(text)` | Backend parameter text, e.g. `'limits/gap = 0.01'` for SCIP; chainable. |
| `enableOutput(enabled = true)` | Backend log, off by default; chainable. |
| `solve(model)` | Solves a copy of the model off the main thread; resolves to a `SolveStatus` name. The model may change meanwhile. |
| `solveSync(model)` | Same, blocking; returns the status. |
| `interrupt()` | Stops a pending `solve()`; false if none runs or the backend cannot be interrupted. |
| `busy` | True while a `solve()` is pending; other calls then throw. |
| `status`, `statusString` | Status of the last solve and the backend's message. |
| `objectiveValue` | Throws unless the last solve ended `OPTIMAL` or `FEASIBLE`. |
| `bestObjectiveBound`, `wallTime`, `userTime` | Bound and times (seconds) of the last solve. |
| `value(expr)`, `values(exprs)` | Value of a variable or `LinearExpr` in the solution. |
| `reducedCost(variable)`, `reducedCosts(variables)` | LP backends only. |
| `dualValue(constraint)`, `dualValues(constraints)` | LP backends only, and not HiGHS (OR-Tools reports its duals wrong, so they are withheld). |
| `activity(constraint)`, `activities(constraints)` | `sum(coeff * value)` of a linear constraint as it was when solved. |
| `dispose()`, `[Symbol.dispose]()` | Drops the results. Idempotent; throws while a `solve()` is pending; later calls throw. |

### `SolveStatus`

Frozen `{ NAME: 'NAME' }` map of what `solve()` returns: `OPTIMAL`, `FEASIBLE`,
`INFEASIBLE`, `UNBOUNDED`, `ABNORMAL`, `NOT_SOLVED`, `MODEL_IS_VALID`,
`CANCELLED_BY_USER`, `UNKNOWN_STATUS`, `MODEL_INVALID`,
`INVALID_SOLVER_PARAMETERS`, `SOLVER_TYPE_UNAVAILABLE`, `INCOMPATIBLE_OPTIONS`.
A model OR-Tools rejects is a status, not an exception.

### `LinearExpr`

An immutable affine expression `sum(coeff * variable) + constant`, shared by
`modelBuilder` and `mathOpt` (each module's `Variable` extends it). Anywhere an
expression is expected, a `Variable` or a plain number also works.

```js
const { modelBuilder } = require('ortools-node');
const { Model, LinearExpr, BoundedLinearExpression } = modelBuilder;

const model = new Model();
const [x, y] = [model.newNumVar(0, 10, 'x'), model.newNumVar(0, 10, 'y')];
console.log(String(LinearExpr.sum([x, y, 3])));               //=> x + y + 3
console.log(String(LinearExpr.weightedSum([x, y], [2, -1]))); //=> 2 * x + -1 * y
console.log(String(LinearExpr.affine(x, 3, 2)));              //=> 3 * x + 2
console.log(String(x.plus(1).neg()), x.plus(7).constant);      //=> -1 * x + -1 7
console.log(String(x.plus(3).eq(y)));                          //=> -3 <= x + -1 * y <= -3
console.log(String(new BoundedLinearExpression(x.plus(1), 0, 5)));   //=> -1 <= x <= 4
```

| Member | Description |
| --- | --- |
| `LinearExpr.sum(items)`, `LinearExpr.weightedSum(items, coeffs)` | `sum(items)`, `sum(items[i] * coeffs[i])`; items are expressions, variables or numbers. |
| `LinearExpr.term(item, coeff)`, `LinearExpr.affine(item, coeff, constant)`, `LinearExpr.constant(value)` | `item * coeff`, `item * coeff + constant`, a constant. |
| `plus(other)`, `minus(other)`, `times(coeff)`, `neg()` | New expressions; repeated variables are merged. |
| `le(rhs)`, `ge(rhs)`, `eq(rhs)` | `BoundedLinearExpression` for `Model.add()` / `addEnforced()` (mathOpt: `addLinearConstraint()`). |
| `constant`, `terms()`, `toString()` | The constant, `[variable, coefficient]` pairs in insertion order, readable text. |
| `new BoundedLinearExpression(expr, lb, ub)` | `lb <= expr <= ub`; `expression`, `lowerBound`, `upperBound` hold it with the constant moved to the bounds. |

## Numbers

Everything is a JS `number` (double). BigInt is rejected wherever a number is
expected (bounds, coefficients, constants, hints, time limit) with a `TypeError`.
Bounds accept `-Infinity` and `Infinity`, but not `NaN`. Coefficients, constants,
`objectiveOffset`, `objectiveCoefficient` and hint values must be finite; an
expression whose coefficient or constant overflows to `Infinity` throws a
`RangeError`. Integer variables may have fractional bounds (the backend rounds
them). Results are doubles as the backend returns them, so LP values can be off
by a few ulps (`5.999999999999998`); round before comparing.

## Errors

| Situation | Error |
| --- | --- |
| Unknown or not compiled-in backend | `Error: Unsupported or unavailable solver: 'FOO' (check isSolverSupported())` |
| `new Solver(1)` | `TypeError: new Solver(solverName: string), e.g. 'GLOP', ...` |
| Bound is `NaN`, a BigInt or not a number | `TypeError: lowerBound must be a number (+-Infinity allowed)` |
| Coefficient not finite (`NaN`, `Infinity`, BigInt) | `TypeError: coefficient must be a finite number` |
| Constant not finite, or not an expression | `TypeError: constant must be a finite number`, `TypeError: Expected a LinearExpr, Variable or number` |
| Coefficient or constant sum overflows | `RangeError: Coefficient overflows`, `RangeError: Expression constant overflows` |
| `LinearExpr.weightedSum()` with arrays of different length | `RangeError: LinearExpr.weightedSum: items and coeffs differ in length` |
| Non-boolean `isIntegral`, `indicatorValue`, `maximize`, `enabled`, `obfuscate` | `TypeError: isIntegral must be a boolean` (and so on) |
| Non-string name | `TypeError: Variable name must be a string` |
| `add()` without a bounded expression | `TypeError: Expected a BoundedLinearExpression, e.g. x.plus(y).le(5)` |
| Variable of another model | `Error: Variable 0 belongs to a different Model` |
| Handle used after `importFrom...()` | `Error: Variable 0 is no longer valid (the Model was re-imported)` |
| `varFromIndex(1.5)`, `varFromIndex(99)` | `TypeError: variable index must be an integer`, `RangeError: variable index out of range` |
| LP or MPS text that does not parse | `Error: Cannot parse the LP model: ...`, `Error: Cannot parse the MPS model: ...` |
| Non-string LP or MPS text | `TypeError: LP model must be a string`, `TypeError: MPS model must be a string` |
| `exportToMpsString()` with enforced constraints | `Error: Cannot export the model as MPS: General constraints are not supported.` |
| `setTimeLimitInSeconds(NaN)`, negative | `TypeError: seconds must be a number`, `RangeError: seconds must be >= 0` |
| `solve()` with a non-model | `TypeError: solve(model): expected a Model` |
| Results before any solve | `Error: No solve result: call solve() first` |
| `objectiveValue`, `value()`... without a solution | `Error: No solution available: the last solve ended INFEASIBLE` |
| Variable added after the solve | `Error: Variable 2 was not part of the solved model` |
| Duals or reduced costs from a backend without them | `Error: Dual values are not available from HIGHS`, `Error: Reduced costs are not available from SCIP` |
| `dualValue()` / `activity()` on an enforced constraint | `TypeError: Expected a LinearConstraint` |
| Any call but `interrupt()` and `busy` while `solve()` is pending | `Error: Solver is busy: a solve() is in progress` |
| Any call after `dispose()` | `Error: Solver has been disposed` (`interrupt()` returns false) |
