# Parameter objects

Routing and CP-SAT parameters are plain objects in protobuf's JSON form: the
`RoutingSearchParameters` of `routing_parameters.proto` (Python's
`pywrapcp.DefaultRoutingSearchParameters()`) and the `SatParameters` of
`sat_parameters.proto` (Python's `solver.parameters`). Field names are lowerCamelCase
(snake_case is accepted on input), enums are names, durations are strings such as
`"0.5s"`, and int64 fields read back as decimal strings. The native side checks every
field against the protobuf descriptors, then OR-Tools validates the values. Import with
`const { defaultRoutingSearchParameters, validateRoutingSearchParameters, defaultSatParameters, validateSatParameters, durationMs, FirstSolutionStrategy, LocalSearchMetaheuristic, RoutingSearchStatus } = require('ortools-node')`.
Routing's `solveWithParameters(params)` and CP-SAT's `CpSolver.parameters`
(see [sat.md](sat.md)) take these objects. Back to the [README](../README.md).

## Example

```js
const {
  validateRoutingSearchParameters, FirstSolutionStrategy, LocalSearchMetaheuristic, durationMs,
} = require('ortools-node');

const params = validateRoutingSearchParameters({
  firstSolutionStrategy: FirstSolutionStrategy.PATH_CHEAPEST_ARC,
  local_search_metaheuristic: LocalSearchMetaheuristic.GUIDED_LOCAL_SEARCH,   // snake_case works too
  timeLimit: durationMs(1500),
  solutionLimit: 100,
});
console.log(durationMs(1500));                         //=> 1.5s
console.log(params.firstSolutionStrategy, params.localSearchMetaheuristic);   //=> PATH_CHEAPEST_ARC GUIDED_LOCAL_SEARCH
console.log(params.timeLimit, params.solutionLimit);   //=> 1.500s 100
console.log(params.lnsTimeLimit);                      //=> 0.100s
```

Defaults, partial overrides and nested merging (routing):

```js
const { defaultRoutingSearchParameters, validateRoutingSearchParameters } = require('ortools-node');

const defaults = defaultRoutingSearchParameters();
console.log(defaults.firstSolutionStrategy, 'timeLimit' in defaults);   //=> AUTOMATIC false
console.log(defaults.solutionLimit, typeof defaults.solutionLimit);    //=> 9223372036854775807 string

const p = validateRoutingSearchParameters({
  localSearchOperators: { useTwoOpt: 'BOOL_FALSE' },   // other operators keep their defaults
  guidedLocalSearchLambdaCoefficient: null,            // null or undefined keeps the default
});
console.log(p.localSearchOperators.useTwoOpt, p.localSearchOperators.useOrOpt);   //=> BOOL_FALSE BOOL_TRUE
console.log(p.guidedLocalSearchLambdaCoefficient);     //=> 0.1
```

SAT parameters, int64 fields and BigInts:

```js
const { CpModel, CpSolver, defaultSatParameters, validateSatParameters } = require('ortools-node');

const defaults = defaultSatParameters();
console.log(defaults.numWorkers, defaults.maxTimeInSeconds);   //=> 0 Infinity

const set = validateSatParameters({ max_time_in_seconds: 5, maxNumberOfConflicts: 2n ** 60n });
console.log(set.maxTimeInSeconds, set.maxNumberOfConflicts);   //=> 5 1152921504606846976
console.log('numWorkers' in set, set.subsolvers);       //=> false []

const model = new CpModel();
model.newIntVar(0, 3, 'x');
const solver = new CpSolver();
solver.parameters = { numWorkers: 1, random_seed: 7 };  // checked at each solve
console.log(solver.solveSync(model));                   //=> OPTIMAL
solver.dispose();
```

Setting one member of a oneof replaces the default member (OR-Tools 9.15, where
`bestSolutionAcceptanceStrategy` defaults to `greedyDescent`):

<!-- no-run -->

```js
const p = validateRoutingSearchParameters({
  iteratedLocalSearchParameters: { bestSolutionAcceptanceStrategy: { allNodesPerformed: {} } },
});
p.iteratedLocalSearchParameters.bestSolutionAcceptanceStrategy;   // { allNodesPerformed: {} }
```

## API

### `defaultRoutingSearchParameters()`

A fresh, independent copy of OR-Tools' `DefaultRoutingSearchParameters()`.

| Member | Description |
| --- | --- |
| return value | `RoutingSearchParameters` with every field OR-Tools sets; unset message fields such as `timeLimit` (no limit) are absent. |

### `validateRoutingSearchParameters(params?)`

The defaults with `params` merged on top, as OR-Tools validated them; this is the
parameter set routing would use.

| Member | Description |
| --- | --- |
| `params` | `Overrides<RoutingSearchParameters>`, a plain object; omitted or `{}` means the defaults. |
| merging | Field by field, also inside nested messages; `undefined` or `null` keeps a default. |
| oneofs | Setting one member replaces the default member; a `null` member keeps the default; two set members of one oneof are a `TypeError`. |
| return value | The full `RoutingSearchParameters`. |

### `defaultSatParameters()`

A fresh copy of CP-SAT's default `SatParameters`, every field listed.

| Member | Description |
| --- | --- |
| return value | `SatParameters`, e.g. `numWorkers: 0`, `maxTimeInSeconds: Infinity`, `maxNumberOfConflicts: '9223372036854775807'`. |

### `validateSatParameters(params?)`

The fields set in `params`, as CP-SAT validated them. Unlike routing, nothing is merged
onto the defaults: CP-SAT applies its own defaults to unset fields.

| Member | Description |
| --- | --- |
| `params` | `Overrides<SatParameters>`, a plain object; `undefined` or `null` leaves a field unset. |
| return value | The fields that were set, plus every repeated field (an empty array when not given). |

### `durationMs(ms)`

Milliseconds as a protobuf Duration string, for `timeLimit`, `lnsTimeLimit` and other
Duration fields.

| Member | Description |
| --- | --- |
| `ms` | A finite number in `[0, 315576000000000]` (protobuf's 10,000-year limit). |
| return value | Rounded to whole nanoseconds: `durationMs(500)` is `'0.5s'`, `durationMs(1500.25)` is `'1.50025s'`, `durationMs(1 / 3)` is `'0.000333333s'`. OR-Tools reads Durations back with 0, 3, 6 or 9 decimals (`'1.500s'`). |

### `FirstSolutionStrategy`, `LocalSearchMetaheuristic`, `RoutingSearchStatus`

Frozen objects mapping each name to itself, read from the OR-Tools build in use.

| Member | Description |
| --- | --- |
| `FirstSolutionStrategy` | `UNSET`, `AUTOMATIC`, `PATH_CHEAPEST_ARC`, `PATH_MOST_CONSTRAINED_ARC`, `EVALUATOR_STRATEGY`, `SAVINGS`, `PARALLEL_SAVINGS`, `SWEEP`, `CHRISTOFIDES`, `ALL_UNPERFORMED`, `BEST_INSERTION`, `PARALLEL_CHEAPEST_INSERTION`, `SEQUENTIAL_CHEAPEST_INSERTION`, `LOCAL_CHEAPEST_INSERTION`, `LOCAL_CHEAPEST_COST_INSERTION`, `GLOBAL_CHEAPEST_ARC`, `LOCAL_CHEAPEST_ARC`, `FIRST_UNBOUND_MIN_VALUE`. |
| `LocalSearchMetaheuristic` | `UNSET`, `AUTOMATIC`, `GREEDY_DESCENT`, `GUIDED_LOCAL_SEARCH`, `SIMULATED_ANNEALING`, `TABU_SEARCH`, `GENERIC_TABU_SEARCH`. |
| `RoutingSearchStatus` | `ROUTING_NOT_SOLVED`, `ROUTING_SUCCESS`, `ROUTING_PARTIAL_SUCCESS_LOCAL_OPTIMUM_NOT_REACHED`, `ROUTING_FAIL`, `ROUTING_FAIL_TIMEOUT`, `ROUTING_INVALID`, `ROUTING_INFEASIBLE`, `ROUTING_OPTIMAL`. |

### Types (`lib/params.d.ts`)

| Member | Description |
| --- | --- |
| `RoutingSearchParameters` | Typed common fields (`firstSolutionStrategy`, `localSearchMetaheuristic`, `timeLimit`, `lnsTimeLimit`, `solutionLimit`, `logSearch`, `useFullPropagation`, `guidedLocalSearchLambdaCoefficient`, `numberOfSolutionsToCollect`); any other proto field is accepted by name. |
| `SatParameters` | Typed common fields (`maxTimeInSeconds`, `numWorkers`, `randomSeed`, `logSearchProgress`, `enumerateAllSolutions`, `relativeGapLimit`, `absoluteGapLimit`); any other field by name. |
| `Overrides<T>` | `T` with `null` allowed on each field; input type of the `validate*()` functions and routing solves. |
| `Duration` | A Duration string such as `"0.5s"`. |
| `Int64` | `number \| bigint \| string`; what an int64 field accepts. |
| `FirstSolutionStrategyName`, `LocalSearchMetaheuristicName`, `RoutingSearchStatusName` | Unions of the enum names above. |

### Input rules

- Field names: lowerCamelCase or snake_case (`num_workers`); naming one field both
  ways is a `TypeError`. Results always use lowerCamelCase.
- Enums: names, or the proto number of a named value (`firstSolutionStrategy: 3`
  reads back as `'PATH_CHEAPEST_ARC'`).
- Durations: strings only (`'2s'`, `durationMs(250)`), not numbers or
  `{ seconds, nanos }` objects.
- Values must be JSON data: plain objects, arrays, strings, numbers, booleans,
  `null`. Boxed primitives are unwrapped. Functions, symbols, class instances
  (`Map`, `Date`), objects with a `toJSON` method, circular references and nesting
  deeper than 64 levels are rejected, as are `NaN`, `null` inside arrays and
  strings that are not well-formed Unicode.

## int64 and BigInt

- int64 fields (`solutionLimit`, `maxNumberOfConflicts`, ...) accept a number, a
  `bigint` or a canonical decimal string (`'42'`, not `'1e3'`, `'+7'` or `'007'`), and
  always read back as decimal strings: `solutionLimit: 10n` gives `'10'`. BigInts are
  encoded exactly, even with a `BigInt.prototype.toJSON` polyfill installed.
- A number for an integer field must be an exact integer that fits the field type
  (int32, uint32, int64); integers beyond 2^53 given as numbers are taken as their
  exact double value (`2 ** 60` gives `'1152921504606846976'`). Pass a BigInt or a
  string for exact values beyond 2^53.
- int32 and other non-64-bit fields read back as numbers.
- `Infinity` / `-Infinity` are accepted only for float and double fields
  (`maxTimeInSeconds: Infinity` reads back as `Infinity`); in an integer field they
  are a `TypeError`.

## Errors

Messages start with `Invalid RoutingSearchParameters:` / `Invalid SatParameters:`
when the native side rejects a field, or `RoutingSearchParameters:` /
`SatParameters:` when the JS encoder does. Field paths look like
`'subsolverParams[0].numWorkers'`.

| Situation | Error |
| --- | --- |
| `params` not a plain object (`null`, array, `Map`) | `TypeError`: `SatParameters must be a plain object` |
| Unknown field | `TypeError`: `Invalid RoutingSearchParameters: unknown field 'firstSolutionStratgy'` |
| `__proto__` key (from `JSON.parse`) | `TypeError`: `Invalid SatParameters: unknown field '__proto__'` |
| One field in camelCase and snake_case | `TypeError`: `Invalid SatParameters: 'numWorkers' and 'num_workers' name the same field` |
| Unknown enum name | `TypeError`: `Invalid RoutingSearchParameters: unknown enum value: 'NOPE'` |
| Enum number without a name | `TypeError`: `'firstSolutionStrategy': no FirstSolutionStrategy.Value value has number 999` |
| Two members of one oneof | `TypeError`: names the field path; protobuf's text says the member `has already been set` (its spacing varies) |
| Wrong JSON type (number for a Duration, `1` for a bool) | `TypeError`: protobuf's parse error with the field, e.g. `@ logSearchProgress: bool: expected 'true' or 'false'` |
| Duration as an object | `TypeError`: `'timeLimit' must be a Duration string such as "1.5s", not an object` |
| Fraction or bad decimal string in an integer field | `TypeError`: `'solutionLimit' must be an integer` |
| Integer out of field range | `TypeError`: `'numWorkers' must fit in int32`, `'maxNumberOfConflicts' must fit in int64` |
| `NaN` | `TypeError`: `SatParameters: 'maxTimeInSeconds' must not be NaN` |
| `±Infinity` in a non-float field | `TypeError`: `'solutionLimit' cannot be Infinity (only float and double fields can)` |
| `null` / nested array in a repeated field, bare value for one | `TypeError`: `'subsolvers[0]' must not be null`, `'subsolvers[0]' must not be an array`, `'subsolvers' must be an array` |
| Function, `Date` or other `toJSON` object | `TypeError`: `'logTag' must be JSON data, not a function`, `... not an object with a toJSON method` |
| Circular reference | `TypeError`: `'subsolverParams[0].self' is a circular reference` |
| Lone surrogate in a string | `TypeError`: `'logTag' must be well-formed Unicode` |
| Value OR-Tools rejects (routing) | `RangeError`: `Invalid RoutingSearchParameters: Invalid solution_limit: 0`, `Invalid time_limit: seconds: -1` |
| Value CP-SAT rejects | `RangeError`: `Invalid SatParameters: parameter 'num_workers' should be in [0,10000]. Current value is -1` |
| `durationMs` with a non-number or `NaN` | `TypeError`: `durationMs(ms): ms must be a number` |
| `durationMs` negative or infinite | `RangeError`: `durationMs(ms): ms must be finite and >= 0` |
| `durationMs` above the Duration range | `RangeError`: `durationMs(ms): ms must be at most 315576000000000` |
