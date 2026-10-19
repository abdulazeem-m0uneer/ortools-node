# Vehicle routing

`RoutingIndexManager` and `RoutingModel` wrap the OR-Tools vehicle routing
library, the C++ classes that Python exposes as `pywrapcp.RoutingIndexManager`
and `pywrapcp.RoutingModel`, with camelCase names. Solving runs on the libuv
threadpool (or on the calling thread with the `...Sync` variants) and yields a
`RoutingSolution`. Model variables are `cp.IntVar`s of the model's
[`cp.CpSolver`](cp.md), so CP constraints on them work as in Python. Import with
`const { RoutingIndexManager, RoutingModel } = require('ortools-node');`.
Back to the [README](../README.md).

## Example

A single-vehicle tour; the manager maps nodes (your locations) to the solver
indices the model works with.

```js
const { RoutingIndexManager, RoutingModel } = require('ortools-node');

const distances = [[0, 2, 9, 10], [1, 0, 6, 4], [15, 7, 0, 8], [6, 3, 12, 0]];
const manager = new RoutingIndexManager(distances.length, 1, 0);  // nodes, vehicles, depot
const model = new RoutingModel(manager);
model.setArcCostEvaluatorOfAllVehicles(model.registerTransitMatrix(distances));

const solution = await model.solveWithParameters({ firstSolutionStrategy: 'PATH_CHEAPEST_ARC' });
console.log(solution.objectiveValue()); //=> 21
console.log(manager.indicesToNodes(solution.routes()[0])); //=> [ 0, 2, 3, 1, 0 ]
console.log(model.status()); //=> ROUTING_SUCCESS
model.dispose();
```

`params` are `RoutingSearchParameters` fields in camelCase, validated against
OR-Tools' protobuf and merged onto the defaults (`defaultRoutingSearchParameters()`,
`validateRoutingSearchParameters(params)`, `durationMs(ms)` for durations).

### Capacity dimension

```js
const { RoutingIndexManager, RoutingModel, durationMs } = require('ortools-node');

const distances = [
  [0, 4, 6, 7, 5],
  [4, 0, 3, 6, 8],
  [6, 3, 0, 4, 7],
  [7, 6, 4, 0, 3],
  [5, 8, 7, 3, 0],
];
const demands = [0, 2, 3, 2, 4];
const manager = new RoutingIndexManager(distances.length, 2, 0);
const model = new RoutingModel(manager);
model.setArcCostEvaluatorOfAllVehicles(model.registerTransitMatrix(distances));
const demand = model.registerUnaryTransitVector(demands);
model.addDimensionWithVehicleCapacity(demand, 0, [6, 6], true, 'load');

const solution = await model.solveWithParameters({ firstSolutionStrategy: 'PATH_CHEAPEST_ARC', timeLimit: durationMs(500) });
console.log(solution.objectiveValue()); //=> 28
console.log(JSON.stringify(solution.routes().map((r) => manager.indicesToNodes(r)))); //=> [[0,4,3,0],[0,1,2,0]]
console.log(JSON.stringify(solution.cumuls('load'))); //=> [[0,0,4,6],[0,0,2,5]]
model.dispose();
```

### `onSolution` and `onProgress`

`onSolution` receives a snapshot of each solution the search reports
(`includeRoutes: true` adds the routes). `onProgress` receives the search
counters at most every `progressIntervalMs` (default 500, `0` for every check)
while the search runs, then once with `done: true`.

```js
const { RoutingIndexManager, RoutingModel } = require('ortools-node');

const distances = [[0, 2, 9, 10], [1, 0, 6, 4], [15, 7, 0, 8], [6, 3, 12, 0]];
const model = new RoutingModel(new RoutingIndexManager(distances.length, 1, 0));
model.setArcCostEvaluatorOfAllVehicles(model.registerTransitMatrix(distances));

const snapshots = [];
const events = [];
await model.solveWithParameters({ firstSolutionStrategy: 'PATH_CHEAPEST_ARC' }, {
  includeRoutes: true,
  onSolution: (snapshot) => snapshots.push(snapshot),
  progressIntervalMs: 0,
  onProgress: (event) => events.push(event),
});
console.log(JSON.stringify(snapshots)); //=> [{"objective":33,"solutionIndex":0,"routes":[[0,1,3,2,4]]},{"objective":21,"solutionIndex":1,"routes":[[0,2,3,1,4]]}]
const last = events[events.length - 1];
console.log(last.done, last.solutions, last.objective); //=> true 2 21
console.log(Object.keys(last).join(', ')); //=> solutions, objective, branches, failures, wallTimeMs, done
model.dispose();
```

### Interrupting a solve

`interrupt()` stops a running solve, which then resolves with the best solution
found so far. It also works from inside a callback.

```js
const { RoutingIndexManager, RoutingModel } = require('ortools-node');

const manager = new RoutingIndexManager(30, 2, 0);
const model = new RoutingModel(manager);
const cost = model.registerTransitCallback((i, j) => Math.abs(((i * 37) % 101) - ((j * 37) % 101)));
model.setArcCostEvaluatorOfAllVehicles(cost);

// Guided local search runs until its time limit; stop it 100 ms after the first solution.
const solving = model.solveWithParameters({ localSearchMetaheuristic: 'GUIDED_LOCAL_SEARCH', timeLimit: '10s' }, {
  onSolution: ({ solutionIndex }) => { if (solutionIndex === 0) setTimeout(() => model.interrupt(), 100); },
});
console.log(model.busy); //=> true
const solution = await solving;                // well before the 10 s limit
console.log(solution !== null, solution.routes().length); //=> true 2
console.log(model.busy, model.interrupt()); //=> false false
model.dispose();
```

### Pickup and delivery, disjunctions

```js
const { RoutingIndexManager, RoutingModel, PickupAndDeliveryPolicy } = require('ortools-node');

const distances = [
  [0, 4, 6, 7, 5, 9],
  [4, 0, 3, 6, 8, 9],
  [6, 3, 0, 4, 7, 9],
  [7, 6, 4, 0, 3, 9],
  [5, 8, 7, 3, 0, 9],
  [9, 9, 9, 9, 9, 0],
];
const manager = new RoutingIndexManager(distances.length, 2, 0);
const model = new RoutingModel(manager);
const transit = model.registerTransitMatrix(distances);
model.setArcCostEvaluatorOfAllVehicles(transit);
model.addDimension(transit, 0, 100, true, 'distance');
const distance = model.getDimensionOrDie('distance');
const solver = model.solver();
for (const [pickupNode, deliveryNode] of [[1, 3], [4, 2]]) {
  const pickup = manager.nodeToIndex(pickupNode);
  const delivery = manager.nodeToIndex(deliveryNode);
  model.addPickupAndDelivery(pickup, delivery);
  solver.add(model.vehicleVar(pickup).eq(model.vehicleVar(delivery)));
  solver.add(distance.cumulVar(pickup).le(distance.cumulVar(delivery)));
}
model.setPickupAndDeliveryPolicyOfAllVehicles(PickupAndDeliveryPolicy.PICKUP_AND_DELIVERY_FIFO);
model.addDisjunction([manager.nodeToIndex(5)], 5);  // node 5 is optional: skipping it costs 5

const solution = model.solveWithParametersSync({ firstSolutionStrategy: 'PARALLEL_CHEAPEST_INSERTION', timeLimit: '1s' });
console.log(solution.objectiveValue()); //=> 30
console.log(JSON.stringify(solution.routes().map((r) => manager.indicesToNodes(r)))); //=> [[0,1,4,3,2,0],[0,0]]
console.log(solution.value(model.activeVar(manager.nodeToIndex(5)))); //=> 0
model.dispose();
```

### Starting from routes, locks

Routes passed to `readAssignmentFromRoutes()` and `applyLocksToAllVehicles()`
are index lists per vehicle, without starts and ends.

```js
const { RoutingIndexManager, RoutingModel } = require('ortools-node');

const distances = [[0, 4, 6, 7, 5], [4, 0, 3, 6, 8], [6, 3, 0, 4, 7], [7, 6, 4, 0, 3], [5, 8, 7, 3, 0]];
const manager = new RoutingIndexManager(distances.length, 2, 0);
const model = new RoutingModel(manager);
model.setArcCostEvaluatorOfAllVehicles(model.registerTransitMatrix(distances));
const params = { firstSolutionStrategy: 'PATH_CHEAPEST_ARC' };
model.closeModelWithParameters(params);

const plan = model.readAssignmentFromRoutes([manager.nodesToIndices([3, 1]), manager.nodesToIndices([2, 4])], false);
console.log(plan.objectiveValue()); //=> 35
const better = model.solveFromAssignmentWithParametersSync(plan, params);
console.log(better.objectiveValue(), plan.valid); //=> 19 false

// Vehicle 0 must start with node 2.
console.log(model.applyLocksToAllVehicles([manager.nodesToIndices([2]), []], false)); //=> true
const locked = model.solveWithParametersSync(params);
console.log(JSON.stringify(locked.routes().map((r) => manager.indicesToNodes(r)))); //=> [[0,2,1,3,4,0],[0,0]]
model.dispose();
```

### Worker threads

`worker.terminate()` waits for threadpool work, so an async routing solve, a CP
`solveAsync()` or an async CP-SAT solve in that worker is stopped as soon as JS
can no longer run there, instead of running to its time limit (or forever). A
synchronous routing or CP search blocks the worker's thread: it stops at its
next callback or JS monitor hook, and without one it runs to its limits like
any blocking native call.

```js
const { Worker } = require('node:worker_threads');

const code = `
const { parentPort } = require('node:worker_threads');
const { RoutingIndexManager, RoutingModel } = require('ortools-node');
const model = new RoutingModel(new RoutingIndexManager(30, 2, 0));
model.setArcCostEvaluatorOfAllVehicles(
  model.registerTransitCallback((i, j) => Math.abs(((i * 37) % 101) - ((j * 37) % 101))));
// Guided local search without a time limit never ends on its own.
model.solveWithParameters({ localSearchMetaheuristic: 'GUIDED_LOCAL_SEARCH' }, {
  onSolution: ({ solutionIndex }) => { if (solutionIndex === 0) parentPort.postMessage('searching'); },
});
`;
const worker = new Worker(code, { eval: true });
await new Promise((resolve) => worker.once('message', resolve));
// Resolves once the search has stopped; without that, it would wait forever.
console.log(await worker.terminate()); //=> 1
```

## API

### `RoutingIndexManager`

`new RoutingIndexManager(numNodes, numVehicles, depot)` or `(numNodes, numVehicles, starts, ends)` maps nodes to solver indices.

| Member | Description |
|---|---|
| `nodeToIndex(node)`, `indexToNode(index)` | One conversion; `nodeToIndex` is `-1` for a node that is only an end depot. |
| `nodesToIndices(nodes)`, `indicesToNodes(indices)` | Bulk conversions, returning arrays. |
| `getNumberOfNodes()`, `getNumberOfVehicles()`, `getNumberOfIndices()` | Sizes. |
| `getStartIndex(vehicle)`, `getEndIndex(vehicle)` | A vehicle's start and end index. |

### `RoutingModel`

`new RoutingModel(manager)` builds the model. Model-definition calls throw once the model is closed (by `closeModel()`, a solve or `readAssignmentFromRoutes()`).

| Member | Description |
|---|---|
| `solver()` | The model's `cp.CpSolver`; add CP constraints on model variables with it. Freed with the model. |
| `registerTransitMatrix(matrix)`, `registerUnaryTransitVector(values)` | Transit evaluators indexed by node; return an evaluator id. |
| `registerTransitCallback(fn)`, `registerUnaryTransitCallback(fn)` | `fn(fromIndex, toIndex)` / `fn(fromIndex)` is called now, for every pair / index, and the results stored (solving runs off the JS thread), so it must be pure and return integers. The pair form accepts at most 16384 indices. |
| `setArcCostEvaluatorOfAllVehicles(id)`, `setArcCostEvaluatorOfVehicle(id, v)`, `setFixedCostOfAllVehicles(cost)`, `setFixedCostOfVehicle(cost, v)` | Costs. |
| `addDimension(id, slackMax, capacity, fixStartCumulToZero, name)`, `addDimensionWithVehicleCapacity`, `addDimensionWithVehicleTransits`, `addDimensionWithVehicleTransitAndCapacity` | Dimensions; `false` (and no new dimension) when the name is taken. |
| `addConstantDimension`, `addVectorDimension`, `addMatrixDimension` | Dimensions with their own evaluator; return `[evaluator, created]`. |
| `hasDimension(name)`, `getDimensionOrDie(name)` | Look up a `RoutingDimension`; the latter throws for an unknown name. |
| `addPickupAndDelivery(pickup, delivery)`, `addPickupAndDeliverySets(pickupDisjunction, deliveryDisjunction)` | Pickup and delivery pairs, by index or by disjunction index. |
| `setPickupAndDeliveryPolicyOfAllVehicles(policy)`, `setPickupAndDeliveryPolicyOfVehicle(policy, v)` | A `PickupAndDeliveryPolicy` name. |
| `addDisjunction(indices, penalty = -1, maxCardinality = 1)` | At most `maxCardinality` of `indices` visited, each missing one costs `penalty`; a negative penalty makes it mandatory. Returns the disjunction index. |
| `setAllowedVehiclesForIndex(vehicles, index)` | Vehicles allowed at an index; an empty list allows all. |
| `setVisitType(index, type, policy)`, `addHardTypeIncompatibility(t1, t2)`, `addTemporalTypeIncompatibility(t1, t2)`, `addRequiredTypeAlternativesWhenAddingType(t, types)`, `addRequiredTypeAlternativesWhenRemovingType(t, types)` | Visit types and their rules; a type must be set with `setVisitType()` first. |
| `addSoftSameVehicleConstraint(indices, cost)` | Pays `cost` when `indices` are not on one vehicle. |
| `addSameActivityGroup(indices)` | All of `indices` performed or none. OR-Tools 9.15 and later; on 9.14 it throws `addSameActivityGroup() needs OR-Tools 9.15 or later (this build uses 9.14...)`. |
| `nextVar(i)`, `vehicleVar(i)`, `activeVar(i)`, `costVar()` | Model variables; `costVar()` once the model is closed. |
| `start(v)`, `end(v)`, `isStart(i)`, `isEnd(i)`, `size()`, `vehicles()`, `nodes()` | Structure; `size()` counts the indices that have a next variable (not the ends). |
| `addVariableMinimizedByFinalizer(x)`, `addVariableMaximizedByFinalizer(x)`, `addVariableTargetToFinalizer(x, target)` | Finalizer variables. |
| `addToAssignment(x)` | Stores `x` in solutions too (needed for `slacks()` and for reading other variables). |
| `closeModel()`, `closeModelWithParameters(params?)`, `closed` | Close the model explicitly. |
| `applyLocks(locks)` | Single-vehicle models: fixes a route prefix; returns the next variable at the end of the chain, or `null`. |
| `applyLocksToAllVehicles(locks, closeRoutes)` | Locks partial routes per vehicle for the next solve; needs a closed model. |
| `readAssignmentFromRoutes(routes, ignoreInactiveIndices)` | A `RoutingSolution` following `routes`, or `null` when they are infeasible. |
| `solveWithParameters(params?, options?)`, `solveFromAssignmentWithParameters(assignment, params?, options?)` | Solve on the threadpool: `Promise<RoutingSolution \| null>` (`null`: no solution, see `status()`). |
| `solveWithParametersSync(...)`, `solveFromAssignmentWithParametersSync(...)` | The same on the calling thread. |
| `status()` | The `RoutingSearchStatus` name of the last solve, e.g. `ROUTING_SUCCESS`, `ROUTING_FAIL`. |
| `interrupt()` | Stops a running solve (it keeps the best solution so far), including a CP `solveAsync()` on `model.solver()`; `false` when none runs. |
| `busy` | `true` while a solve or a callback runs. |
| `dispose()`, `[Symbol.dispose]()` | Frees the model and its solver now; later calls and old handles throw. |

### `SolveOptions`

The second argument of every solve method.

| Member | Description |
|---|---|
| `onSolution(snapshot)` | Called for each solution with a `RoutingSolutionSnapshot`. |
| `includeRoutes` | Adds `routes` to each snapshot. |
| `onProgress(progress)` | Called with a `RoutingProgress` at most every `progressIntervalMs` while the search runs, then once with `done: true`. |
| `progressIntervalMs` | Minimum time between progress events, an integer in [0, 2^31 - 1]; default 500. |

Callbacks run on the JS thread that started the solve and receive copies of
the values, never live native objects.

- **During an async solve the solver never waits for JS.** A snapshot is queued
  per solution, so a slow `onSolution` costs memory (one snapshot per solution,
  with `includeRoutes` one route list each), never solver time. Progress
  coalesces: at most one event is queued, and newer values replace it, so a slow
  `onProgress` sees fewer events, each with the latest values. The final
  `done: true` event arrives even when the solve fails natively, unless a
  callback threw or the worker thread is terminating. The Promise settles after
  the last callback has run.
- **The first throw in either callback stops the search** (like `interrupt()`),
  no callback runs after it, and the solve rejects or rethrows with it.
- **Inside a callback the model is busy:** every model call throws except
  `busy` and `interrupt()`, which stops the search and keeps the best solution.

### `RoutingSolutionSnapshot`, `RoutingProgress`

The plain objects passed to `onSolution` and `onProgress`.

| Member | Description |
|---|---|
| `snapshot.objective`, `snapshot.solutionIndex` | The solution's objective; 0 for the first solution of the solve, then 1, 2, ... |
| `snapshot.routes` | With `includeRoutes`: per vehicle, start to end (`null` if not readable). |
| `progress.solutions`, `progress.objective` | Solutions found so far in this solve; the best objective, `null` before the first solution. |
| `progress.branches`, `progress.failures`, `progress.wallTimeMs` | Search counters of this solve. |
| `progress.done` | `true` for the final event, sent once when the search has ended. |

### `RoutingDimension`

A dimension (load, time, distance...), from `getDimensionOrDie(name)`.

| Member | Description |
|---|---|
| `name()` | The dimension's name. |
| `cumulVar(i)`, `slackVar(i)`, `transitVar(i)` | Its variables at index `i` (no slack or transit at an end). |
| `setSpanUpperBoundForVehicle(bound, v)`, `setSpanCostCoefficientForVehicle(c, v)`, `setSpanCostCoefficientForAllVehicles(c)`, `setGlobalSpanCostCoefficient(c)` | Span bounds and costs. |
| `setCumulVarSoftUpperBound(i, bound, c)`, `setCumulVarSoftLowerBound(i, bound, c)` | Soft cumul bounds. |

### `RoutingSolution`

A solution or an assignment read from routes; valid until the model is solved again, changed (including through its solver) or disposed, after which every call throws.

| Member | Description |
|---|---|
| `valid` | `false` once the solution can no longer be read. |
| `objectiveValue()` | The objective. |
| `value(x)`, `min(x)`, `max(x)` | A variable stored in the solution (model variables, cumuls, `addToAssignment()`); a variable left as a range reads as its lower bound with `value()`. |
| `routes()` | Per vehicle, the visited indices from start to end. |
| `cumuls(dimension)`, `slacks(dimension)` | Per vehicle, the cumul or slack at each index of `routes()` (slack `null` at the end; needs `addToAssignment()` of the slacks). `dimension` is a `RoutingDimension` or its name. |

### `VisitTypePolicy`, `PickupAndDeliveryPolicy`

Frozen objects mapping each policy name to itself; the methods also take the plain strings.

| Member | Description |
|---|---|
| `VisitTypePolicy` | `TYPE_ADDED_TO_VEHICLE`, `ADDED_TYPE_REMOVED_FROM_VEHICLE`, `TYPE_ON_VEHICLE_UP_TO_VISIT`, `TYPE_SIMULTANEOUSLY_ADDED_AND_REMOVED`. |
| `PickupAndDeliveryPolicy` | `PICKUP_AND_DELIVERY_NO_ORDER`, `PICKUP_AND_DELIVERY_LIFO`, `PICKUP_AND_DELIVERY_FIFO`. |

## int64 and BigInt

Routing inputs (costs, capacities, penalties, matrix entries, callback results)
follow the CP input rule: safe integers, BigInts within int64, or `±Infinity`.
Index, node and vehicle lists are Arrays of integer numbers or BigInts, or an
`Int32Array`, `Uint32Array`, `Float64Array` or `BigInt64Array`.
Every solution value (`objectiveValue()`, `value()`, `min()`, `max()`,
`cumuls()`, `slacks()`, snapshot and progress objectives) follows the CP result
rule: a number up to `Number.MAX_SAFE_INTEGER`, an exact BigInt beyond it,
`-Infinity` / `Infinity` for the int64 extremes. Indices, nodes, vehicles and
the progress counters are plain numbers.

```js
const { RoutingIndexManager, RoutingModel } = require('ortools-node');

const model = new RoutingModel(new RoutingIndexManager(3, 1, 0));
model.setArcCostEvaluatorOfAllVehicles(model.registerTransitMatrix([[0, 1, 1], [1, 0, 1], [1, 1, 0]]));
model.setFixedCostOfAllVehicles(2n ** 60n);
const objectives = [];
const solution = model.solveWithParametersSync({}, { onSolution: ({ objective }) => objectives.push(objective) });
console.log(solution.objectiveValue(), objectives); //=> 1152921504606846979n [ 1152921504606846979n ]
model.dispose();
```

## Errors

Every row below was produced by running the call. Errors are `Error` unless
the class is given.

| Situation | Error |
|---|---|
| Out-of-range node, vehicle or index | `RangeError: depot (9) must be in [0, 3]`, `RangeError: index (99) must be in [0, 3]` |
| `starts` / `ends` lengths differ from the vehicle count | `starts and ends must have one entry per vehicle` |
| `new RoutingModel(notAManager)` | `TypeError: new RoutingModel(manager: RoutingIndexManager)` |
| Matrix row of the wrong length | `RangeError: matrix[0] must have 4 entries, not 2` |
| Vector of the wrong length | `values must have one entry per node (4)` |
| Fraction or `NaN` in a matrix | `TypeError: matrix[0][1] must be an integer`, `TypeError: matrix[0][1] must not be NaN` |
| Transit callback returns a fraction | `TypeError: transit callback result for (0, 0) must be an integer` |
| Transit callback throws | the callback's own error, from `registerTransitCallback()` |
| Pair transit callback on more than 16384 indices | `RangeError: registerTransitCallback() stores a value for every pair of indices; 16386 indices exceed the limit of 16384 (use registerTransitMatrix())` |
| Unknown evaluator id | `RangeError: unknown transit evaluator 99 (register it first)` |
| Negative slack or capacity | `slackMax must be >= 0`, `capacity must be >= 0` |
| Capacities not one per vehicle | `capacities must have one entry per vehicle (1)` |
| `getDimensionOrDie()` of an unknown name | `Unknown dimension 'nope'` |
| Pickup equal to delivery, or a vehicle start in a pair or disjunction | `pickup and delivery must differ`, `index 0 is a vehicle start and cannot be a pickup or delivery` |
| Unknown disjunction index | `unknown disjunction (addDisjunction() returns its index)` |
| Unknown policy name | `TypeError: unknown pickup and delivery policy 'NOPE'`, `TypeError: unknown visit type policy 'NOPE'` |
| Type rule on a type no index uses | `visit type 5 is not used by any index (call setVisitType() first)` |
| Model definition after the model is closed | `addDimension() must be called before the model is closed (by closeModel(), a solve or readAssignmentFromRoutes())` |
| `costVar()` before closing | `costVar() is available once the model is closed` |
| `applyLocksToAllVehicles()` before closing | `applyLocksToAllVehicles() needs a closed model: call closeModelWithParameters() first` |
| Routes containing a start, or too many routes | `routes must not contain vehicle starts (index 0)`, `routes has more routes than the model has vehicles` |
| Unknown or ill-typed parameter | `TypeError: Invalid RoutingSearchParameters: unknown field 'bogusField'`, `TypeError: Invalid RoutingSearchParameters: unknown enum value: 'NOPE'` |
| Parameter rejected by OR-Tools validation | `RangeError: Invalid RoutingSearchParameters: Invalid time_limit: seconds: -1` |
| Bad options | `TypeError: options must be an object`, `TypeError: options.onSolution must be a function` |
| Bad `progressIntervalMs` | `RangeError: options.progressIntervalMs (-1) must be in [0, 2147483647]`, `TypeError: options.progressIntervalMs must be an integer` |
| Any call except `busy` / `interrupt()` during a solve or inside a callback | `RoutingModel is busy: a solve() is in progress` |
| A callback throws | the callback's own error; the solve rejects or rethrows it |
| Reading a solution after a new solve, a model change or `dispose()` | `This solution is no longer valid: the model was solved again, changed or disposed` |
| `value(x)` of a variable not stored in solutions | `IntVar 'z' is not stored in solutions: call addToAssignment(var) before closing the model` |
| `slacks()` without the slacks in the assignment | `the slack variables of dimension 'load' are not stored in solutions: call addToAssignment() on them before closing` |
| `slacks()` / `cumuls()` with neither a dimension nor a name | `TypeError: expected a RoutingDimension or a dimension name` |
| `model.solver().dispose()` | `This CpSolver belongs to a RoutingModel: dispose the model instead` |
| Any call after `dispose()` | `RoutingModel has been disposed` |
