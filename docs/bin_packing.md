# Vector bin packing

`solveVectorBinPacking()` packs item copies into the fewest bins (or the cheapest packing) when each item uses several resources, with OR-Tools' arc-flow formulation solved on a MIP backend (C++ `packing::SolveVectorBinPackingWithArcFlow`, the `vector_bin_packing.proto` model; Python has no direct wrapper). The problem and the solution are plain objects in protobuf's JSON form. Import it with `const { solveVectorBinPacking, solveVectorBinPackingSync, VectorBinPackingSolverType } = require('ortools-node');`. Back to the [README](../README.md).

## Example

Three copies of item `a` (size 6) and three of `b` (size 4) in bins of size 10:

```js
const { solveVectorBinPackingSync } = require('ortools-node');

const solution = solveVectorBinPackingSync({
  resourceCapacity: [10],
  item: [{ name: 'a', resourceUsage: [6], numCopies: 3 }, { name: 'b', resourceUsage: [4], numCopies: 3 }],
});
console.log(solution.status, solution.objectiveValue); //=> OPTIMAL 3
console.log(JSON.stringify(solution.bins[0])); //=> {"itemIndices":[0,1],"itemCopies":[1,1]}
```

Two resources, optional copies with a penalty, a bin cost, int64 fields as BigInt or string, and the async form with options. The backend is picked from `VectorBinPackingSolverType`, since the set depends on the build:

```js
const { solveVectorBinPacking, VectorBinPackingSolverType } = require('ortools-node');

const problem = {
  resourceCapacity: ['10', 8n],
  resourceName: ['weight', 'volume'],
  item: [
    { name: 'box', resourceUsage: [5n, '4'], numCopies: 4 },
    { name: 'bag', resourceUsage: [3, 3], numCopies: 2, numOptionalCopies: 1, penaltyPerMissingCopy: 0.5 },
  ],
  costPerBin: 2,
};
const solverType = VectorBinPackingSolverType.CP_SAT ?? VectorBinPackingSolverType.SCIP;
const solution = await solveVectorBinPacking(problem, { solverType, timeLimitSeconds: 10 });
console.log(solution.status, solution.objectiveValue, solution.bins.length); //=> OPTIMAL 6.5 3
```

`maxBins` caps the number of bins; a cap that cannot hold the copies gives `INFEASIBLE` and no bins:

```js
const { solveVectorBinPackingSync } = require('ortools-node');

const solution = solveVectorBinPackingSync({
  resourceCapacity: [10],
  item: [{ resourceUsage: [6], numCopies: 3 }, { resourceUsage: [4], numCopies: 3 }],
  maxBins: 2,
});
console.log(solution.status, solution.bins); //=> INFEASIBLE []
```

## API

### `solveVectorBinPacking(problem, options?)`

Solves on the libuv threadpool. Invalid arguments throw synchronously (the call does not return a rejected promise), like every async API in this package: only a failure during the solve rejects.

| Member | Description |
| --- | --- |
| `problem` | A `VectorBinPackingProblem`. |
| `options` | A `VectorBinPackingOptions`; `{}` by default. |
| returns | `Promise<VectorBinPackingSolution>`. |

### `solveVectorBinPackingSync(problem, options?)`

Blocking form of `solveVectorBinPacking()`.

| Member | Description |
| --- | --- |
| `problem`, `options` | As for `solveVectorBinPacking()`. |
| returns | `VectorBinPackingSolution`. |

### `VectorBinPackingSolverType`

Frozen object of the MIP backends this build can use, each mapped to its own name.

| Member | Description |
| --- | --- |
| `SCIP`, `CBC`, `CP_SAT`, `HIGHS` | The four a standard OR-Tools 9.15 build provides. |
| `GUROBI`, `CPLEX`, `XPRESS`, `GLPK` | Only when compiled into OR-Tools. |

### `VectorBinPackingProblem`

| Member | Description |
| --- | --- |
| `name?` | Free text. |
| `resourceCapacity` | One capacity per resource, int64 in `[1, 2^30]`; at least one resource. |
| `resourceName?` | Names of the resources. |
| `item` | At least one `VectorBinPackingItem`. |
| `maxBins?` | When > 0, the most bins the solution may use. |
| `costPerBin?` | Objective cost of each bin; 1 by default. |

### `VectorBinPackingItem`

| Member | Description |
| --- | --- |
| `name?` | Free text. |
| `resourceUsage` | One int64 value per resource, in `[0, 2^30]`. An item that uses no resource needs a `maxNumberOfCopiesPerBin` below its copies. |
| `numCopies?` | Copies that must be packed; 0 by default. |
| `numOptionalCopies?` | Copies that may be left out, each costing `penaltyPerMissingCopy`. |
| `maxNumberOfCopiesPerBin?` | 0 means no limit. |
| `penaltyPerMissingCopy?` | Objective cost of each optional copy left out. |

### `VectorBinPackingOptions`

| Member | Description |
| --- | --- |
| `solverType?` | A `VectorBinPackingSolverType` name; `'SCIP'` when available, else the first backend listed. |
| `timeLimitSeconds?` | > 0; `Infinity` (the default) means no limit. Limits under 1 ms count as 1 ms. |
| `numThreads?` | Integer in `[1, 1024]`; 1 by default. CBC prints `No match for threads` lines to stdout when it is above 1. |
| `mipParameters?` | Backend parameter text, for `SCIP` and `CP_SAT` only; any non-empty text throws for the others. |
| `enableOutput?` | Writes the backend's log to stdout; `false` by default. On OR-Tools 9.14, HiGHS prints its banner whatever this option says (that release's HiGHS interface ignores it). |

Unknown option keys are ignored.

### `VectorBinPackingSolution`

| Member | Description |
| --- | --- |
| `status` | `'OPTIMAL'`, `'FEASIBLE'`, `'INFEASIBLE'`, or `'VECTOR_BIN_PACKING_SOLVE_STATUS_UNSPECIFIED'` when no packing was found within the limits. |
| `bins` | One `{ itemIndices, itemCopies }` per bin: the items in the bin and how many copies of each. |
| `objectiveValue` | Bins times `costPerBin` plus the penalties of missing optional copies. |
| `solveTimeInSeconds`, `arcFlowTimeInSeconds` | Timings reported by OR-Tools, in seconds. |
| `solverInfo` | Free text from OR-Tools (often empty). |

## int64 and BigInt

- `resourceCapacity` and `resourceUsage` entries are int64 fields: a number, a BigInt or a decimal string (`'10'`, also `'1e1'`). They must still be integers within the ranges above.
- A fractional number or string, a value beyond int64, or a non-numeric string throws a TypeError naming the field path.
- The other numeric fields (`numCopies`, `maxBins`, `costPerBin`, ...) and every solution field are plain numbers.

## Errors

| Situation | Error |
| --- | --- |
| `problem` not a plain object | `TypeError: problem must be a VectorBinPackingProblem object` |
| `options` not a plain object | `TypeError: options must be a plain object` |
| `NaN` anywhere in the problem | `TypeError: VectorBinPackingProblem: 'item[1].resourceUsage[0]' must not be NaN` (the field path) |
| Unknown field | `TypeError: Invalid VectorBinPackingProblem: invalid JSON ... no such field: 'bogus'` (protobuf varies the spacing in these messages) |
| int64 field fractional, beyond int64 or not numeric | `TypeError: Invalid VectorBinPackingProblem: invalid JSON ... @ item[0].resourceUsage[0]: int64: invalid number: 'x'` |
| No resources, no items | `RangeError: Invalid VectorBinPackingProblem: resourceCapacity is empty`, `... item is empty` |
| Capacity outside `[1, 2^30]` | `RangeError: Invalid VectorBinPackingProblem: resourceCapacity[0] must be in [1, 2^30]` |
| Usage outside `[0, 2^30]` | `RangeError: Invalid VectorBinPackingProblem: item[0].resourceUsage[0] must be in [0, 2^30]` |
| Usage length differs from the resources | `RangeError: Invalid VectorBinPackingProblem: item[0].resourceUsage has 2 values for 1 resources` |
| Negative copy counts | `RangeError: Invalid VectorBinPackingProblem: item[0]: numCopies, numOptionalCopies and maxNumberOfCopiesPerBin must be >= 0` |
| Item that uses no resource and has no per-bin limit | `RangeError: Invalid VectorBinPackingProblem: item[0] uses no resource; give it a resourceUsage or a maxNumberOfCopiesPerBin below its copies` |
| Negative `maxBins` | `RangeError: Invalid VectorBinPackingProblem: maxBins must be >= 0` |
| Unknown or unavailable backend | `TypeError: Unsupported or unavailable MIP solver for bin packing: 'GUROBI'` |
| `timeLimitSeconds` <= 0 | `RangeError: timeLimitSeconds must be > 0 (Infinity for no limit)` |
| `numThreads` not an integer in range | `RangeError: numThreads must be an integer in [1, 1024]` |
| `mipParameters` for CBC or HIGHS | `TypeError: mipParameters: CBC takes none here (only SCIP and CP_SAT do)` (`HIGHS` likewise) |
| `mipParameters` the backend rejects | `TypeError: mipParameters rejected by SCIP` (`CP_SAT` likewise; CP-SAT also logs the parse error to stderr) |
| `enableOutput` not a boolean | `TypeError: enableOutput must be a boolean` |

An item larger than a bin is not an error: the solution's status is `INFEASIBLE`.
