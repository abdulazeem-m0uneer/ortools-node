// Compile-time checks for lib/routing.d.ts (run by `npm run typecheck`).
import {
  FirstSolutionStrategy,
  cp,
  PickupAndDeliveryPolicy,
  RoutingDimension,
  RoutingIndexManager,
  RoutingModel,
  RoutingProgress,
  RoutingSolution,
  RoutingSolutionSnapshot,
  VisitTypePolicy,
} from '../../lib/index';

const manager = new RoutingIndexManager(5, 2, 0);
const multiDepot = new RoutingIndexManager(5, 2, [0, 1], [2, 2]);
const bigDepots = new RoutingIndexManager(5, 2, [0n, 1], new BigInt64Array([2n, 2n]));
const viaBigInt: number[] = bigDepots.nodesToIndices(new BigInt64Array([3n])).concat(manager.indicesToNodes([1n]));
const model = new RoutingModel(manager);
const transit: number = model.registerTransitCallback((i, j) => i + j);
const matrix: number = model.registerTransitMatrix([new Int32Array(5), [0, 1, 2, 3, 4n], [], [], []]);
model.setArcCostEvaluatorOfAllVehicles(transit);
const created: boolean = model.addDimensionWithVehicleCapacity(transit, 0, [10, 10n], true, 'Load');
const [evaluator, fresh]: [number, boolean] = model.addVectorDimension([0, 1, 1, 1, 1], 4, true, 'Stops');
const time: RoutingDimension = model.getDimensionOrDie('Load');
const v: cp.IntVar = model.vehicleVar(1);
model.solver().add(v.eq(model.vehicleVar(2)));
model.solver().add(time.cumulVar(1).minus(time.cumulVar(2)).le(10));
model.addPickupAndDelivery(1, 2);
model.setPickupAndDeliveryPolicyOfAllVehicles(PickupAndDeliveryPolicy.PICKUP_AND_DELIVERY_FIFO);
const disjunction: number = model.addDisjunction([3], 1_000_000);
model.setVisitType(3, 0, VisitTypePolicy.TYPE_ADDED_TO_VEHICLE);
model.addVariableMinimizedByFinalizer(time.cumulVar(model.start(0)));
model.closeModelWithParameters({ firstSolutionStrategy: FirstSolutionStrategy.PATH_CHEAPEST_ARC, timeLimit: null });

async function run(): Promise<void> {
  const solution: RoutingSolution | null = await model.solveWithParameters(
    { solutionLimit: 10 },
    { onSolution: (s: RoutingSolutionSnapshot) => s.objective, includeRoutes: true },
  );
  if (solution !== null) {
    const routes: number[][] = solution.routes();
    const loads: Array<Array<number | bigint>> = solution.cumuls(time);
    const cost: number | bigint = solution.objectiveValue();
    const slacks: Array<Array<number | bigint | null>> = solution.slacks('Load');
    const warm = model.solveFromAssignmentWithParametersSync(solution);
  }
  const initial = model.readAssignmentFromRoutes([[1, 2], [3]], true);
  await model.solveWithParameters({}, {
    onProgress: (p: RoutingProgress) => {
      const best: number | bigint | null = p.objective;
      const counters: number = p.solutions + p.branches + p.failures + p.wallTimeMs;
      const last: boolean = p.done;
    },
    progressIntervalMs: 250,
  });
}

{
  using scoped = new RoutingModel(multiDepot);
  scoped.solveWithParametersSync();
}

// @ts-expect-error unknown visit type policy
model.setVisitType(3, 0, 'TYPE_MAYBE');
// @ts-expect-error unknown first solution strategy
model.solveWithParametersSync({ firstSolutionStrategy: 'NOPE' });
// @ts-expect-error onSolution receives a snapshot, not a number
model.solveWithParametersSync({}, { onSolution: (s: number) => s });
// @ts-expect-error the progress objective is null before the first solution
model.solveWithParametersSync({}, { onProgress: (p) => { const o: number | bigint = p.objective; } });
// @ts-expect-error progressIntervalMs is a number of milliseconds
model.solveWithParametersSync({}, { onProgress() {}, progressIntervalMs: '1s' });
// @ts-expect-error objective values may be bigints
const exact: number = model.solveWithParametersSync()!.objectiveValue();
// @ts-expect-error the manager is required
new RoutingModel();
// @ts-expect-error status names are RoutingSearchStatus names
const status: 'SUCCESS' = model.status();

// Index and integer arrays: Arrays or the typed arrays the addon reads.
new RoutingIndexManager(3, 2, new Int32Array([0, 1]), [2, 2]);
model.addDisjunction(new Uint32Array([3]), 10);
// @ts-expect-error array-like objects are rejected at runtime
model.addDisjunction({ length: 1, 0: 3 }, 10);
// @ts-expect-error Uint8Array is not read by the addon
model.setAllowedVehiclesForIndex(new Uint8Array([0]), 1);
// @ts-expect-error the outer array of routes must be an Array
model.readAssignmentFromRoutes({ length: 1, 0: [1] }, true);
