# MathOpt (`mathOpt`)

`mathOpt` is Python's `ortools.math_opt.python.mathopt`: a linear or
mixed-integer model built in JS, sent to MathOpt as a `ModelProto` and solved by
any MathOpt solver this build has (`SolverType`). Import it with
`const { mathOpt } = require('ortools-node')`. Unlike the top-level `Solver`
(`MPSolver`, see [linear_solver.md](linear_solver.md)), there is no solver
object: `solve(model, solverType, options)` takes plain-object parameters and
returns an immutable `SolveResult`. Variable and constraint ids are never
reused, so they can be deleted. MathOpt validates the model and the parameters;
bad input is a JS error. Expressions use the `LinearExpr` class documented in
[model_builder.md](model_builder.md#linearexpr). Back to the [README](../README.md).

## Example

```js
const { mathOpt } = require('ortools-node');
const { Model, solve, TerminationReason } = mathOpt;

const model = new Model('getting started');
const x = model.addVariable({ lb: -1, ub: 1.5, name: 'x' });
const y = model.addVariable({ lb: 0, ub: 1, name: 'y' });
model.addLinearConstraint(x.plus(y).le(1.5), 'c');
model.maximize(x.plus(y.times(2)));

const result = await solve(model, 'GLOP');            // runs on the libuv threadpool
console.log(result.termination.reason === TerminationReason.OPTIMAL);   //=> true
console.log(result.objectiveValue(), result.variableValues([x, y]));   //=> 2.5 [ 0.5, 1 ]
```

A MIP with a time limit (seconds, or a Duration string such as `'5s'`), a
solution hint and an LP-style parameter:

```js
const { mathOpt } = require('ortools-node');
const { Model, solveSync, LinearExpr } = mathOpt;

const weights = [4, 7, 5, 3];
const values = [10, 13, 9, 7];
const model = new Model('knapsack');
const take = weights.map((_, i) => model.addBinaryVariable({ name: `take${i}` }));
model.addLinearConstraint(LinearExpr.weightedSum(take, weights).le(12), 'capacity');
model.maximize(LinearExpr.weightedSum(take, values));

const result = solveSync(model, 'GSCIP', {
  parameters: { timeLimit: 5, presolve: 'OFF' },
  modelParameters: { solutionHints: [new Map([[take[0], 1]])] },
});
console.log(result.termination.reason, result.objectiveValue());   //=> OPTIMAL 26
console.log(result.variableValues(take));                          //=> [ 1, 0, 1, 1 ]
console.log(result.bestObjectiveBound());                          //=> 26
```

Duals and reduced costs on an LP. `variableValues()`, `reducedCosts()` and
`dualValues()` take one handle, an array, or nothing (a `Map` keyed by handle):

```js
const { mathOpt } = require('ortools-node');
const { Model, solveSync } = mathOpt;

const model = new Model();
const x = model.addVariable({ lb: 0, name: 'x' });
const y = model.addVariable({ lb: 0, name: 'y' });
const c0 = model.addLinearConstraint(x.plus(y.times(2)).le(14), 'c0');
const c1 = model.addLinearConstraint({ lb: 0, expr: x.times(3).minus(y), name: 'c1' });
const c2 = model.addLinearConstraint(x.minus(y).le(2), 'c2');
model.maximize(x.times(3).plus(y.times(4)));

const result = solveSync(model, 'GLOP', { parameters: { lpAlgorithm: 'DUAL_SIMPLEX' } });
console.log(result.objectiveValue().toFixed(2));                         //=> 34.00
console.log(result.dualValues([c0, c1, c2]).map((d) => d.toFixed(4)));   //=> [ '2.3333', '0.0000', '0.6667' ]
console.log([...result.reducedCosts()].map(([v, r]) => `${v}:${r.toFixed(1)}`));   //=> [ 'x:0.0', 'y:0.0' ]
```

A `SolveInterrupter` stops `solve()` calls it was passed to, and stays
interrupted. HiGHS ignores it. This market split model takes CP-SAT about 10 s:

```js
const { mathOpt } = require('ortools-node');
const { Model, solve, SolveInterrupter, LinearExpr } = mathOpt;

let state = 12345;
const rand = () => { // mulberry32, deterministic
  state = (state + 0x6d2b79f5) | 0;
  let t = Math.imul(state ^ (state >>> 15), state | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) % 100;
};
const model = new Model('market split');
const x = Array.from({ length: 30 }, () => model.addBinaryVariable());
for (let i = 0; i < 4; i++) {
  const a = x.map(() => rand());
  model.addLinearConstraint(LinearExpr.weightedSum(x, a).eq(Math.floor(a.reduce((p, q) => p + q, 0) / 2)));
}
model.minimize(x[0]);

const interrupter = new SolveInterrupter();
const pending = solve(model, 'CP_SAT', { parameters: { timeLimit: 60 }, interrupter });
setTimeout(() => interrupter.interrupt(), 100);
const result = await pending;
console.log(result.termination.reason, result.termination.limit);   //=> NO_SOLUTION_FOUND INTERRUPTED
console.log(interrupter.interrupted);                                //=> true
```

Deleting, and exporting the model as a `ModelProto` object:

```js
const { mathOpt } = require('ortools-node');
const { Model } = mathOpt;

const model = new Model('m');
const x = model.addVariable({ lb: 0, ub: 4, name: 'x' });
const y = model.addIntegerVariable({ lb: 0, ub: 3, name: 'y' });
const c = model.addLinearConstraint(x.plus(y).ge(1), 'c');
model.deleteVariable(x);
console.log(c.terms().map(([v, k]) => `${v}*${k}`), model.numVariables);   //=> [ 'y*1' ] 1
const proto = model.exportModel();
console.log(proto.variables.ids, proto.variables.integers, proto.linearConstraints.lowerBounds);   //=> [ 1 ] [ true ] [ 1 ]
```

## API

### `Model`

A linear or mixed-integer model; handles are ids in it, never reused.

| Member | Description |
| --- | --- |
| `new Model(name = '')`, `name` | Model name (a string). |
| `addVariable({ lb = -Infinity, ub = Infinity, isInteger = false, name = '' })` | New variable; any other option key is a `TypeError`. |
| `addIntegerVariable({ lb, ub, name })`, `addBinaryVariable({ name })` | Integer variable; integer in [0, 1]. |
| `deleteVariable(variable)` | Removes it from the model, every constraint and the objective; the handle becomes invalid. |
| `numVariables`, `variables()`, `getVariable(id)` | Variable count, handles in creation order, handle by id. |
| `addLinearConstraint(bounded, name?)` | Adds a `BoundedLinearExpression` such as `x.plus(y).le(5)`. |
| `addLinearConstraint({ lb = -Infinity, ub = Infinity, expr = 0, name = '' })` | Same from options; a constant in `expr` moves to the bounds. |
| `deleteLinearConstraint(constraint)` | Removes it; the handle becomes invalid. |
| `numLinearConstraints`, `linearConstraints()`, `getLinearConstraint(id)` | Constraint count, handles, handle by id. |
| `minimize(expr)`, `maximize(expr)`, `setObjective(expr, isMaximize)` | Replace the objective (coefficients, offset and sense); chainable. |
| `isMaximize`, `objectiveOffset` | Sense and constant, read and write. |
| `objectiveCoefficient(variable)`, `setObjectiveCoefficient(variable, coeff)` | One objective coefficient (0 removes it). |
| `objectiveExpression()` | The objective as a `LinearExpr`. |
| `exportModel()` | The `ModelProto` as a plain object (infinite bounds stay `+-Infinity`). |

### `Variable`

A decision variable, also a `LinearExpr` (`1 * variable`). `String(v)` is its name
or `variable#<id>`.

| Member | Description |
| --- | --- |
| `id` | Id in the model (read-only). |
| `name`, `lowerBound`, `upperBound`, `integer` | Read and write; throw once the variable is deleted. |

### `LinearConstraint`

`lowerBound <= sum(coeff * variable) <= upperBound`.

| Member | Description |
| --- | --- |
| `id` | Id in the model (read-only). |
| `name`, `lowerBound`, `upperBound` | Read and write; throw once the constraint is deleted. |
| `setCoefficient(variable, coeff)`, `getCoefficient(variable)` | One coefficient; 0 removes the variable from the constraint. |
| `terms()` | `[variable, coefficient]` pairs. |

### `LinearExpr` and `BoundedLinearExpression`

Shared with `modelBuilder`; see [model_builder.md](model_builder.md#linearexpr).

### `solve(model, solverType, options?)` and `solveSync(model, solverType, options?)`

`solve()` copies the model and solves it off the main thread, resolving to a
`SolveResult`; the model may change meanwhile. `solveSync()` blocks. Invalid
arguments throw synchronously; a model MathOpt rejects makes `solve()` reject.

| Member | Description |
| --- | --- |
| `solverType` | A `SolverType` name, e.g. `'GLOP'`, `'GSCIP'`, `'CP_SAT'`, `'PDLP'`, `'HIGHS'`. |
| `options.parameters` | `SolveParameters` (below). |
| `options.modelParameters` | `ModelSolveParameters` (below). |
| `options.interrupter` | A `SolveInterrupter` (`solve()` only; `solveSync()` throws a `TypeError`). |

### `SolveParameters`

A plain object of `SolveParametersProto` fields in protobuf JSON form; unknown
fields throw.

| Member | Description |
| --- | --- |
| `timeLimit` | Seconds (`Infinity`: none) or a Duration string such as `'1.5s'`. |
| `iterationLimit`, `nodeLimit`, `solutionLimit`, `cutoffLimit`, `objectiveLimit`, `bestBoundLimit` | Limits; a solver that does not support one rejects it. |
| `enableOutput`, `threads`, `randomSeed` | Solver log, thread count, seed. |
| `absoluteGapTolerance`, `relativeGapTolerance`, `solutionPoolSize` | MIP gap tolerances and pool size. |
| `lpAlgorithm` | An `LPAlgorithm` name (`'DUAL_SIMPLEX'`) or the proto name (`'LP_ALGORITHM_DUAL_SIMPLEX'`). |
| `presolve`, `cuts`, `heuristics`, `scaling` | An `Emphasis` name (`'OFF'`...`'VERY_HIGH'`) or the proto name (`'EMPHASIS_OFF'`). |
| `gscip`, `glop`, `cpSat`, `pdlp`, `highs`... | Solver-specific messages in proto JSON form. |

### `ModelSolveParameters`

A plain object of `ModelSolveParametersProto` fields; unknown fields throw.

| Member | Description |
| --- | --- |
| `solutionHints` | Array of `Map<Variable, number>` (or `SolutionHintProto` objects). |
| `branchingPriorities` | `Map<Variable, integer>` (or a `SparseInt32VectorProto` object). |
| other fields | Proto JSON, e.g. `variableValuesFilter`. |

### `SolveInterrupter`

Stops the `solve()` calls it is passed to; once interrupted it stays
interrupted. HiGHS ignores it (the solve runs to its own limits).

| Member | Description |
| --- | --- |
| `new SolveInterrupter()` | Not interrupted. |
| `interrupt()`, `interrupted` | Interrupt; whether it has been. |

### `SolveResult`

The outcome of a solve. Values are looked up by the handles of the model as it
was when solved.

| Member | Description |
| --- | --- |
| `termination.reason`, `termination.limit`, `termination.detail` | `TerminationReason` and `Limit` names (`'UNSPECIFIED'` when no limit was hit), and the solver's message. |
| `termination.problemStatus` | `{ primalStatus, dualStatus, primalOrDualInfeasible }` with `FeasibilityStatus` names. |
| `termination.objectiveBounds` | `{ primalBound, dualBound }`. |
| `solveStats` | `{ solveTime (s), simplexIterations, barrierIterations, firstOrderIterations, nodeCount }`. |
| `proto` | The `SolveResultProto` as MathOpt returned it (protobuf JSON). |
| `hasPrimalFeasibleSolution()`, `hasDualFeasibleSolution()` | Whether the best solution has a feasible primal / dual part. |
| `objectiveValue()` | Objective of the best primal solution; throws without one. |
| `bestObjectiveBound()`, `solveTime()` | Dual bound; seconds. |
| `variableValues(x)`, `variableValues([x, y])`, `variableValues()` | Primal values: a number, an array, or a `Map<Variable, number>`. Throw without a primal solution. |
| `reducedCosts(...)`, `dualValues(...)` | Same overloads, by `Variable` / `LinearConstraint`. Throw without a dual solution (MIP solvers give none). |

### Constants

Frozen `{ NAME: 'NAME' }` maps.

| Member | Description |
| --- | --- |
| `SolverType` | Solvers compiled into this build and usable here, e.g. `GSCIP`, `GLOP`, `CP_SAT`, `PDLP`, `HIGHS`. |
| `TerminationReason` | `OPTIMAL`, `INFEASIBLE`, `UNBOUNDED`, `INFEASIBLE_OR_UNBOUNDED`, `IMPRECISE`, `FEASIBLE`, `NO_SOLUTION_FOUND`, `NUMERICAL_ERROR`, `OTHER_ERROR`. |
| `Limit` | `UNDETERMINED`, `ITERATION`, `TIME`, `NODE`, `SOLUTION`, `MEMORY`, `CUTOFF`, `OBJECTIVE`, `NORM`, `INTERRUPTED`, `SLOW_PROGRESS`, `OTHER`. |
| `FeasibilityStatus` | `UNDETERMINED`, `FEASIBLE`, `INFEASIBLE`. |
| `LPAlgorithm` | `PRIMAL_SIMPLEX`, `DUAL_SIMPLEX`, `BARRIER`, `FIRST_ORDER`. |
| `Emphasis` | `OFF`, `LOW`, `MEDIUM`, `HIGH`, `VERY_HIGH`. |

## Numbers

Model data is JS `number` (double). BigInt is rejected for bounds, coefficients,
constants, hints and `timeLimit` with a `TypeError`. Bounds accept `-Infinity`
and `Infinity`, but not `NaN`; coefficients, constants, `objectiveOffset` and
hint values must be finite, and a sum that overflows to `Infinity` throws a
`RangeError`. Integer variables may have fractional bounds (the solver rounds
them). Integer `SolveParameters` fields (`iterationLimit`, `threads`...) go
through protobuf JSON, which rejects fractions and also accepts a BigInt or a
decimal string. In results, int64 counters (`simplexIterations`, `nodeCount`...)
are numbers, and infinite bounds (an unbounded model's `objectiveBounds`) are
`+-Infinity`.

## Errors

| Situation | Error |
| --- | --- |
| Solver not in `SolverType` | `Error: Unsupported or unregistered math_opt solver type: 'GUROBI'` |
| `solverType` not a string, `model` not a `Model` | `TypeError: solverType must be a string, e.g. SolverType.GLOP`, `TypeError: solve(model, solverType): expected a Model` |
| Unknown option key | `TypeError: addVariable: unknown option "lower" (expected lb, ub, isInteger, name)` (also `addLinearConstraint`, `solve options`) |
| Options not a plain object | `TypeError: addVariable: options must be a plain object` |
| Bound is `NaN`, a BigInt or not a number | `TypeError: lb must be a number (+-Infinity allowed)` |
| Coefficient or constant not finite | `TypeError: coefficient must be a finite number`, `TypeError: constant must be a finite number` |
| Not an expression | `TypeError: Expected a LinearExpr, Variable or number` |
| Coefficient or constant sum overflows | `RangeError: Coefficient overflows`, `RangeError: Expression constant overflows` |
| Non-boolean `isInteger`, `isMaximize`; non-string name | `TypeError: isInteger must be a boolean`, `TypeError: Variable name must be a string` |
| Variable of another model | `Error: Variable 0 belongs to a different Model` |
| Deleted variable or constraint | `Error: Variable 3 was deleted` |
| `getVariable(99)`, `getLinearConstraint(99)` | `RangeError: No variable with id 99`, `RangeError: No linear constraint with id 99` |
| Unknown or ill-typed parameter field | `TypeError: Invalid SolveParametersProto: ...` (`Invalid ModelSolveParametersProto: ...`) |
| Unknown `lpAlgorithm` or emphasis name | `TypeError: Invalid SolveParametersProto: unknown enum value: 'LP_ALGORITHM_FOO'` |
| `timeLimit` `NaN`, negative, too large, BigInt | `TypeError: SolveParameters.timeLimit must not be NaN`, `RangeError: SolveParameters.timeLimit must be >= 0 seconds`, `RangeError: ... must be at most 315576000000 seconds (or Infinity)`, `TypeError: ... must be a number of seconds or a Duration string` |
| `interrupter` not a `SolveInterrupter` | `TypeError: interrupter must be a SolveInterrupter` |
| `interrupter` passed to `solveSync()` | `TypeError: interrupter needs solve(): nothing can call interrupt() while solveSync() blocks the thread` |
| Hint value not finite, priority not an integer | `TypeError: solution hint value must be a finite number`, `TypeError: branching priority must be an integer` |
| Parameter or model the solver rejects (e.g. `cuts` on GLOP, integer variables on GLOP, `lb > ub`) | `Error: math_opt solve failed: INVALID_ARGUMENT: ...` |
| Values without a primal solution | `Error: No primal feasible solution (termination: INFEASIBLE)` |
| Duals or reduced costs without a dual solution | `Error: No dual feasible solution (termination: OPTIMAL)` |
| Handle added after the solve | `Error: Variable 4 was not part of the solved model` |
| Wrong handle type in a lookup | `TypeError: Expected a Variable` |
