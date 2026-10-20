# Set cover

The `setCover` namespace solves weighted set cover: choose the cheapest subsets whose union covers every element. It mirrors Python's `ortools.set_cover.python.set_cover`: build a `SetCoverModel`, create a `SetCoverInvariant` (the current solution) from it, then improve that solution with generators, local searches and a MIP. Import it with `const { setCover } = require('ortools-node');`. Back to the [README](../README.md).

## Example

Six elements, six subsets. Greedy finds cost 6; steepest search then drops a redundant subset:

```js
const { setCover } = require('ortools-node');
const { SetCoverModel, SetCoverInvariant, GreedySolutionGenerator, SteepestSearch } = setCover;

const model = new SetCoverModel('small');
for (const [cost, elements] of [[3, [0, 1, 2]], [2, [2, 3]], [2, [3, 4, 5]], [4, [0, 5]], [1, [1]], [5, [0, 1, 2, 3, 4, 5]]]) {
  model.addEmptySubset(cost);
  for (const element of elements) model.addElementToLastSubset(element);
}
console.log(model.numElements, model.numSubsets, model.computeFeasibility()); //=> 6 6 true

const inv = new SetCoverInvariant(model);
console.log(await new GreedySolutionGenerator(inv).nextSolution()); //=> true
console.log(inv.cost(), inv.selectedSubsets()); //=> 6 [ 0, 2, 4 ]
console.log(new SteepestSearch(inv).nextSolutionSync()); //=> true
console.log(inv.cost(), inv.selectedSubsets()); //=> 5 [ 0, 2 ]
console.log(inv.coverage()); //=> [ 1, 1, 1, 1, 1, 1 ]
inv.dispose();
```

A heuristic pipeline: a constructive generator, local search, then a large-neighbourhood loop that clears part of the cover and repairs it, keeping the best. `SetCoverMip` gives the proven optimum and, with `useIntegers(false)`, an LP lower bound:

```js
const { setCover } = require('ortools-node');
const {
  SetCoverModel, SetCoverInvariant, ElementDegreeSolutionGenerator, GreedySolutionGenerator, SteepestSearch,
  GuidedTabuSearch, SetCoverMip, SetCoverMipSolver, clearMostCoveredElements,
} = setCover;

const model = new SetCoverModel('grid');
for (let s = 0; s < 30; s++) model.addEmptySubset(1 + ((s * 7) % 5));
for (let e = 0; e < 200; e++) {
  for (const s of new Set([e % 30, (e * 7 + 3) % 30, (e * 11 + 5) % 30])) model.addElementToSubset(e, s);
}

const inv = new SetCoverInvariant(model);
await new ElementDegreeSolutionGenerator(inv).nextSolution();
await new SteepestSearch(inv).nextSolution();
await new GuidedTabuSearch(inv).setMaxIterations(500).nextSolution();
let best = inv.isSelected();
let bestCost = inv.cost();
for (let round = 0; round < 20; round++) {
  clearMostCoveredElements(inv, 5); // random when more than 5 qualify
  await new GreedySolutionGenerator(inv).nextSolution();
  await new SteepestSearch(inv).nextSolution();
  if (inv.cost() < bestCost) [best, bestCost] = [inv.isSelected(), inv.cost()];
}
inv.loadSolution(best);
console.log(inv.numUncoveredElements(), bestCost >= 39); //=> 0 true

const exact = new SetCoverInvariant(model);
const mip = new SetCoverMip(exact).useMipSolver(SetCoverMipSolver.SCIP ?? SetCoverMipSolver.SAT);
console.log(await mip.nextSolution(), mip.solveStatus, exact.cost()); //=> true OPTIMAL 39
exact.clear();
new SetCoverMip(exact).useIntegers(false).nextSolutionSync();
console.log(Math.ceil(exact.lowerBound()), exact.cost()); //=> 32 0
inv.dispose();
exact.dispose();
```

A `focus` (subset indices) limits the subsets a run may change:

```js
const { setCover } = require('ortools-node');
const { SetCoverModel, SetCoverInvariant, TrivialSolutionGenerator } = setCover;

const model = new SetCoverModel().importModelFromProto({
  name: 'proto',
  subset: [{ cost: 3, element: [0, 1, 2] }, { cost: 2, element: [2, 3] }, { cost: 2, element: [3, 4, 5] }],
});
const inv = new SetCoverInvariant(model);
console.log(new TrivialSolutionGenerator(inv).nextSolutionSync(Int32Array.of(0, 2))); //=> true
console.log(inv.selectedSubsets(), inv.cost()); //=> [ 0, 2 ] 5
console.log(JSON.stringify(model.exportModelAsProto().subset[1])); //=> {"cost":2,"element":[2,3]}
inv.dispose();
```

## API

### `SetCoverModel`

Subsets with costs > 0 over elements `0 .. numElements - 1`; a plain JS object (no native memory).

| Member | Description |
| --- | --- |
| `new SetCoverModel(name = 'SetCoverModel')`, `name`, `setName(name)` | Model name. |
| `addEmptySubset(cost)` | Adds a subset with a finite cost > 0; returns its index. |
| `addElementToLastSubset(element)`, `addElementToSubset(element, subset)` | Adds an element (integer in `[0, 2^31 - 2]`) once per subset. Return `this`. |
| `setSubsetCost(subset, cost)` | Changes a cost. Returns `this`. |
| `numElements`, `numSubsets`, `numNonzeros`, `fillRate` | Sizes; `fillRate` is nonzeros / (elements x subsets). |
| `subsetCosts`, `columns`, `rows`, `allSubsets` | Copies: costs, subset to elements, element to subsets, `[0, numSubsets)`. |
| `computeFeasibility()` | True when there are subsets and elements and every element is in some subset. |
| `exportModelAsProto()` | `{ name, subset: [{ cost, element }] }` (SetCoverProto JSON, elements sorted). |
| `importModelFromProto(proto)` | Replaces the model; throws and changes nothing when the proto is invalid. Returns `this`. |

### `SetCoverInvariant`

A solution of a model. It copies the model at construction, so later model changes do not reach it.

| Member | Description |
| --- | --- |
| `new SetCoverInvariant(model)` | Throws unless `model.computeFeasibility()` holds. Starts with nothing selected. |
| `model` | The model given to the constructor. |
| `cost()`, `numUncoveredElements()` | Cost of the selected subsets; elements no selected subset covers. |
| `lowerBound()` | The bound of the last `SetCoverMip` run with `useIntegers(false)`; 0 otherwise. |
| `isSelected()`, `selectedSubsets()` | One boolean per subset; indices of the selected subsets. |
| `coverage()` | Per element, how many selected subsets contain it. |
| `loadSolution(selected)`, `clear()` | Replaces the solution (one boolean per subset) or empties it. Return `this`. |
| `busy` | True while a `nextSolution()` runs. |
| `dispose()`, `[Symbol.dispose]()` | Frees the native solution. Idempotent; throws while busy; later calls throw. |

### `SetCoverSolutionGenerator`

Base class of every generator and search below; each run updates its invariant in place.

| Member | Description |
| --- | --- |
| `inv`, `name` | The invariant; the class name. |
| `setMaxIterations(n)` | Integer >= 0 bounding the iterations of a search. Returns `this`. |
| `nextSolution(focus?)` | Runs on the libuv threadpool; resolves to whether it produced a solution. Throws synchronously on invalid input or while the invariant is busy. |
| `nextSolutionSync(focus?)` | Blocking form. |

`focus` is an Array or typed array of subset indices (default: every subset). Greedy and the element-degree generators need a focus that can cover every element the solution leaves uncovered (`RangeError: the focus cannot cover element ...`); greedy also needs every unselected subset that still covers an uncovered element.

### Generators and searches

| Class | Description |
| --- | --- |
| `TrivialSolutionGenerator` | Selects every subset in the focus. |
| `RandomSolutionGenerator` | Selects random useful subsets until everything is covered (not deterministic). |
| `GreedySolutionGenerator` | Chvatal's greedy: cheapest cost per newly covered element first. |
| `ElementDegreeSolutionGenerator`, `LazyElementDegreeSolutionGenerator` | Cover elements in decreasing degree order with the best subset for each. |
| `SteepestSearch` | Removes redundant subsets, most expensive first; resolves `false` without a complete cover. OR-Tools itself can occasionally leave an element uncovered (about 0.5% of runs after `RandomSolutionGenerator`, also in Python 9.15); check `numUncoveredElements()`. |
| `GuidedLocalSearch` | Guided local search from a complete cover; penalties restart on every run. |
| `GuidedTabuSearch` | Guided tabu search from a complete cover; also `setLagrangianFactor(f)`, `setPenaltyFactor(f)`, `setEpsilon(e)` (finite numbers) and `setTabuListSize(n)` (integer in `[1, 1e6]`), each returning `this`. |
| `SetCoverMip` | Solves the focus as a MIP; subsets already selected stay selected. Also `useMipSolver(name)`, `useIntegers(bool)` (`false`: LP relaxation, sets only `lowerBound()`), `setTimeLimitInSeconds(s)` (`[0, 1e9]`), each returning `this`, and `solveStatus` (MPSolver status of the last run, e.g. `'OPTIMAL'`, `undefined` before). |

### `SetCoverMipSolver`

Frozen object of the `SetCoverMip` backends this build can run, each mapped to its own name.

| Member | Description |
| --- | --- |
| `SCIP` (the default), `SAT` | MIP backends. |
| `GLOP`, `PDLP` | LP backends: they solve the relaxation, as with `useIntegers(false)`. |
| `GUROBI` | Only when compiled into OR-Tools. |

### `clearRandomSubsets(inv, numSubsets, focus?)` and `clearMostCoveredElements(inv, numSubsets, focus?)`

Deselect part of the solution to start a new neighbourhood (OR-Tools' `ClearRandomSubsets` / `ClearMostCoveredElements`), restricted to `focus` when given.

| Member | Description |
| --- | --- |
| `clearRandomSubsets` | Deselects random selected subsets and the selected subsets that share elements with them; can deselect more than `numSubsets`. |
| `clearMostCoveredElements` | Deselects up to `numSubsets` subsets covering the most covered elements, chosen at random past the cap. |
| returns | Subset indices that can be reused as a focus (OR-Tools' contract). The choice is random; read `inv.isSelected()` for what is selected now. |

## int64 and BigInt

Set cover has no int64 values: costs are finite doubles > 0, and elements, subsets and counts are JS integer numbers. A `focus` may also hold BigInts or come as a `Float64Array` or `BigInt64Array`, as long as each value is an integer in range.

## Errors

| Situation | Error |
| --- | --- |
| Cost zero, negative or not finite | `RangeError: cost must be a finite number > 0` |
| Element out of range, not an integer | `RangeError: element must be in [0, 2147483646]`, `TypeError: element must be an integer` |
| Element twice in a subset | `RangeError: subset 0 already has element 1` |
| Unknown subset | `RangeError: subset 3 does not exist` |
| `addElementToLastSubset()` on an empty model | `Error: addElementToLastSubset: the model has no subset yet` |
| Name not a string | `TypeError: name must be a string` |
| Invalid proto | `TypeError: proto must be a SetCoverProto object`, `TypeError: proto.subset must be an array` |
| Invariant from an infeasible model | `RangeError: the model has no subsets`, `RangeError: element 0 is in no subset (elements are 0..1)` |
| Invariant from something else | `TypeError: SetCoverInvariant(model): expected a SetCoverModel` |
| Generator or clear helper given something else | `TypeError: expected a SetCoverInvariant` |
| `loadSolution()` with the wrong input | `TypeError: selected[0] must be a boolean`, `TypeError: loadSolution(selected: boolean[])` |
| Focus index out of range, not an integer, wrong type | `RangeError: focus[0] = 5 is out of range [0, 1)`, `TypeError: focus[0] must be an integer`, `TypeError: focus must be an Array, Int32Array, Uint32Array, Float64Array or BigInt64Array` |
| Greedy focus missing a needed subset | `RangeError: GREEDY's focus must include every unselected subset that still covers an uncovered element; subset 1 is missing` |
| Guided local or tabu search without a complete cover | `RangeError: local search needs a complete cover first (run a solution generator)` |
| Invalid setter value | `RangeError: maxIterations must be in [0, 9007199254740991]`, `RangeError: size must be in [1, 1000000]`, `TypeError: epsilon must be a finite number`, `TypeError: factor must be a finite number` |
| Unknown or unavailable MIP backend | `TypeError: Unsupported or unavailable MIP solver: 'GUROBI'` |
| Bad `useIntegers()` or time limit | `TypeError: useIntegers must be a boolean`, `RangeError: seconds must be in [0, 1e9]`, `TypeError: seconds must be a number` |
| Negative or fractional `numSubsets` | `RangeError: numSubsets must be >= 0`, `TypeError: numSubsets must be an integer` |
| Any invariant call while a run is pending | `Error: SetCoverInvariant is busy: a solve() is in progress` |
| Any invariant call after `dispose()` | `Error: SetCoverInvariant has been disposed` |
