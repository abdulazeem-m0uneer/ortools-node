# Graph algorithms

Min-cost flow, max flow and linear sum assignment: the OR-Tools C++ classes `SimpleMinCostFlow`, `SimpleMaxFlow` and `SimpleLinearSumAssignment`, the same ones Python exposes as `ortools.graph.python.min_cost_flow`, `max_flow` and `linear_sum_assignment`. Import them with `const { SimpleMinCostFlow, SimpleMaxFlow, SimpleLinearSumAssignment } = require('ortools-node');`. Back to the [README](../README.md).

## Example

Min-cost flow (the OR-Tools Python sample): node 0 supplies 20 units, nodes 3 and 4 demand 5 and 15.

```js
const { SimpleMinCostFlow } = require('ortools-node');

const g = new SimpleMinCostFlow();
const tails = [0, 0, 1, 1, 1, 2, 2, 3, 4];
const heads = [1, 2, 2, 3, 4, 3, 4, 4, 2];
const capacities = [15, 8, 20, 4, 10, 15, 4, 20, 5];
const unitCosts = [4, 4, 2, 2, 6, 1, 3, 2, 3];
for (let i = 0; i < tails.length; i++) {
  g.addArcWithCapacityAndUnitCost(tails[i], heads[i], capacities[i], unitCosts[i]);
}
[20, 0, 0, -5, -15].forEach((supply, node) => g.setNodeSupply(node, supply));

const status = g.solveSync();
console.log(status === SimpleMinCostFlow.OPTIMAL); //=> true
console.log(g.optimalCost()); //=> 150
console.log(g.flows().join(' ')); //=> 12 8 8 4 0 12 4 11 0
g.dispose();
```

Bulk adders take Arrays or typed arrays (`Int32Array` is the fastest for indices) and return the new arc indices. `solve()` runs on the libuv threadpool and resolves to the status; the object is `busy` until it settles. The min cut of a max flow:

```js
const { SimpleMaxFlow } = require('ortools-node');

const g = new SimpleMaxFlow();
const arcs = g.addArcsWithCapacity(
  Int32Array.of(0, 0, 0, 1, 1, 2, 2, 3, 3),
  Int32Array.of(1, 2, 3, 2, 4, 3, 4, 2, 4),
  Int32Array.of(20, 30, 10, 40, 30, 10, 20, 5, 20),
);
console.log(arcs.length, g.numNodes()); //=> 9 5

const pending = g.solve(0, 4);
console.log(g.busy); //=> true
console.log(await pending); //=> OPTIMAL
console.log(g.optimalFlow()); //=> 60
console.log(Array.from(g.getSourceSideMinCut())); //=> [ 0 ]
console.log(Array.from(g.getSinkSideMinCut()).sort()); //=> [ 1, 4 ]
console.log(g.flows([0, 1, 2])); //=> [ 20, 30, 10 ]
g.dispose();
```

Assignment of 4 workers to 4 tasks, every pair allowed:

```js
const { SimpleLinearSumAssignment } = require('ortools-node');

const costs = [[90, 76, 75, 70], [35, 85, 55, 65], [125, 95, 90, 105], [45, 110, 95, 115]];
const lefts = [];
const rights = [];
for (let w = 0; w < 4; w++) for (let t = 0; t < 4; t++) { lefts.push(w); rights.push(t); }
const a = new SimpleLinearSumAssignment();
a.addArcsWithCost(Int32Array.from(lefts), Int32Array.from(rights), costs.flat());

console.log(await a.solve()); //=> OPTIMAL
console.log(a.optimalCost()); //=> 265
console.log([0, 1, 2, 3].map((w) => a.rightMate(w))); //=> [ 3, 2, 1, 0 ]
console.log([0, 1, 2, 3].map((w) => a.assignmentCost(w))); //=> [ 70, 55, 95, 45 ]
a.dispose();
```

`dispose()` frees the native graph at once; `[Symbol.dispose]` makes the classes work with `using` where the runtime supports it (Node 24, not Node 22):

<!-- no-run -->

```js
{
  using g = new SimpleMaxFlow();
  g.addArcWithCapacity(0, 1, 5);
  g.solveSync(0, 1);
} // g.dispose() runs here
```

## API

Shared rules: node and arc indices are integers; nodes exist once an arc (or a supply) uses them, so valid nodes are `[0, numNodes())`. Bulk methods take Arrays, `Int32Array`, `Uint32Array`, `Float64Array` or `BigInt64Array` of one length and validate everything before adding anything. Result getters throw unless the last solve returned `OPTIMAL` and the graph has not changed since. Every call throws while a `solve()` is pending and after `dispose()`.

### `SimpleMinCostFlow`

Minimum-cost flow that satisfies node supplies and demands.

| Member | Description |
| --- | --- |
| `new SimpleMinCostFlow()` | Empty graph. |
| `NOT_SOLVED`, `OPTIMAL`, `FEASIBLE`, `INFEASIBLE`, `UNBALANCED`, `BAD_RESULT`, `BAD_COST_RANGE`, `BAD_CAPACITY_RANGE` | Status strings, static and on instances. |
| `addArcWithCapacityAndUnitCost(tail, head, capacity, unitCost)` | Adds an arc; `capacity >= 0`, `unitCost` may be negative. Returns the arc index. |
| `addArcsWithCapacityAndUnitCost(tails, heads, capacities, unitCosts)` | Bulk version; returns an `Int32Array` of new arc indices. |
| `setArcCapacity(arc, capacity)` | Changes an arc's capacity. |
| `setNodeSupply(node, supply)`, `setNodesSupplies(nodes, supplies)` | Supply per node; a demand is a negative supply. |
| `solve()`, `solveSync()` | Supplies must balance and be satisfiable. `solve()` runs on the threadpool and resolves to the status. `BAD_CAPACITY_RANGE` also covers total supply or demand beyond int64. |
| `solveMaxFlowWithMinCost()`, `solveMaxFlowWithMinCostSync()` | Sends as much supply as possible at minimum cost; supplies need not balance. |
| `optimalCost()` | Total cost; `Infinity` when it overflows int64 (the flows stay valid). |
| `maximumFlow()` | Total flow sent. |
| `flow(arc)`, `flows(arcs?)` | Flow of one arc; flows of the given arcs, or of every arc. |
| `numNodes()`, `numArcs()`, `tail(arc)`, `head(arc)`, `capacity(arc)`, `unitCost(arc)`, `supply(node)` | Graph inspection; works without a solve. |
| `busy` | True while a `solve()` is pending. |
| `dispose()`, `[Symbol.dispose]()` | Frees the native graph. Idempotent; throws while busy. |

### `SimpleMaxFlow`

Maximum flow from a source to a sink.

| Member | Description |
| --- | --- |
| `new SimpleMaxFlow()` | Empty graph. |
| `OPTIMAL`, `POSSIBLE_OVERFLOW`, `BAD_INPUT`, `BAD_RESULT` | Status strings, static and on instances. |
| `addArcWithCapacity(tail, head, capacity)` | Adds an arc with `capacity >= 0`; returns its index. |
| `addArcsWithCapacity(tails, heads, capacities)` | Bulk version; returns an `Int32Array` of new arc indices. |
| `setArcCapacity(arc, capacity)` | Changes an arc's capacity. |
| `solve(source, sink)`, `solveSync(source, sink)` | `BAD_INPUT` when `source === sink`. A source or sink no arc touches gives `OPTIMAL` with flow 0 and empty min cuts. |
| `optimalFlow()` | Value of the maximum flow. |
| `flow(arc)`, `flows(arcs?)` | Flow of one arc; flows of the given arcs, or of every arc. |
| `getSourceSideMinCut()` | `Int32Array` of nodes reachable from the source through non-saturated arcs. |
| `getSinkSideMinCut()` | `Int32Array` of nodes that reach the sink through non-saturated arcs. |
| `numNodes()`, `numArcs()`, `tail(arc)`, `head(arc)`, `capacity(arc)` | Graph inspection. |
| `busy`, `dispose()`, `[Symbol.dispose]()` | As for `SimpleMinCostFlow`. |

### `SimpleLinearSumAssignment`

Minimum-cost perfect matching of left nodes `[0, n)` to right nodes `[0, n)`.

| Member | Description |
| --- | --- |
| `new SimpleLinearSumAssignment()` | Empty problem. |
| `OPTIMAL`, `INFEASIBLE`, `POSSIBLE_OVERFLOW` | Status strings, static and on instances. |
| `addArcWithCost(leftNode, rightNode, cost)` | Adds an allowed pair; the cost may be negative. Returns the arc index. |
| `addArcsWithCost(leftNodes, rightNodes, costs)` | Bulk version; returns an `Int32Array` of new arc indices. |
| `solve()`, `solveSync()` | `INFEASIBLE` when no perfect matching exists. `POSSIBLE_OVERFLOW` when costs are too large to scale: any cost magnitude above `(2^63 - 1) / (numNodes() + 1)` is rejected, and smaller ones can be too, so keep costs well below that. |
| `optimalCost()` | Total cost of the matching. |
| `rightMate(leftNode)`, `assignmentCost(leftNode)` | Right node matched to a left node, and that arc's cost. |
| `numNodes()`, `numArcs()`, `leftNode(arc)`, `rightNode(arc)`, `cost(arc)` | Problem inspection. |
| `busy`, `dispose()`, `[Symbol.dispose]()` | As for `SimpleMinCostFlow`. |

## int64 and BigInt

- Capacities, costs and supplies take a safe integer (`Number.isSafeInteger`) or a BigInt in int64 range. Capacities also take `Infinity`, meaning int64 max (unbounded).
- A number outside the safe range throws a RangeError asking for a BigInt; a BigInt outside int64 throws a RangeError.
- Every result (costs, flows, capacities, supplies) is a number. int64 max and int64 min come back as `Infinity` and `-Infinity`; any other value beyond `Number.MAX_SAFE_INTEGER` throws a RangeError.
- `optimalCost()` of a min-cost flow returns `Infinity` when the total cost overflows int64.

```js
const { SimpleMinCostFlow } = require('ortools-node');

const g = new SimpleMinCostFlow();
g.addArcWithCapacityAndUnitCost(0, 1, Infinity, 2n ** 40n);
g.setNodeSupply(0, 2n ** 40n);
g.setNodeSupply(1, -(2n ** 40n));
console.log(g.capacity(0)); //=> Infinity
console.log(g.solveSync()); //=> OPTIMAL
console.log(g.optimalCost()); //=> Infinity
console.log(g.flow(0)); //=> 1099511627776
g.dispose();
```

## Errors

| Situation | Error |
| --- | --- |
| Result getter with no `OPTIMAL` solve on the current graph | `Error: No SimpleMaxFlow result: call solve() first and check it returned OPTIMAL (any change to the graph discards the previous result)` (class name varies) |
| Any call (including `solve()`, `dispose()`) while `solve()` is pending | `Error: SimpleMinCostFlow is busy: a solve() is in progress` (thrown synchronously) |
| Any call after `dispose()` | `Error: SimpleMinCostFlow has been disposed` |
| Arc index not an arc | `RangeError: arc index out of range` |
| Node index negative or too large | `RangeError: tail index out of range` (also `head`, `source`, `left node`...) |
| Index not an integer, or not a number | `TypeError: arc index must be an integer`, `TypeError: sink index must be a number` |
| Negative capacity | `RangeError: capacity must be >= 0` (bulk: `capacities[1] must be >= 0`) |
| Capacity, cost or supply not an integer or BigInt | `TypeError: capacity must be an integer`, `TypeError: capacity must be an integer number or a BigInt` |
| Unsafe number | `RangeError: capacity is outside the safe integer range; pass a BigInt` |
| BigInt outside int64 | `RangeError: supply does not fit in a 64-bit integer` |
| `Infinity` or `NaN` cost | `TypeError: unitCost must be finite`, `TypeError: unitCost must not be NaN` |
| Result beyond the safe range (not int64 max or min) | `RangeError: capacity (1152921504606846976) is outside the range a JS number holds exactly` |
| Bulk arrays of different lengths | `RangeError: addArcsWithCapacityAndUnitCost(tails, heads, capacities, unitCosts): every array must have the same length` |
| Bulk argument of another type | `TypeError: tails must be an Array, Int32Array, Uint32Array, Float64Array or BigInt64Array` |
| Bulk element not an integer | `TypeError: tails[0] must be an integer` |

Statuses other than `OPTIMAL` (`UNBALANCED`, `INFEASIBLE`, `BAD_INPUT`, `POSSIBLE_OVERFLOW`...) are returned, not thrown.
