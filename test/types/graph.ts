// Compile-time checks for lib/graph.d.ts (run by `npm run typecheck`).
import {
  LinearSumAssignmentStatus,
  MaxFlowStatus,
  MinCostFlowStatus,
  SimpleLinearSumAssignment,
  SimpleMaxFlow,
  SimpleMinCostFlow,
} from '../../lib/index';

const mcf = new SimpleMinCostFlow();
const arc: number = mcf.addArcWithCapacityAndUnitCost(0, 1, Infinity, 5n);
const arcs: Int32Array = mcf.addArcsWithCapacityAndUnitCost(Int32Array.of(1), [2], BigInt64Array.of(3n), [4]);
mcf.setNodesSupplies(Uint32Array.of(0, 2), Float64Array.of(3, -3));
const mcfStatus: MinCostFlowStatus = mcf.solveSync();
const optimal: boolean = mcfStatus === SimpleMinCostFlow.OPTIMAL || mcfStatus === mcf.BAD_CAPACITY_RANGE;
const flows: number[] = mcf.flows(arcs);
const pendingMcf: Promise<MinCostFlowStatus> = mcf.solveMaxFlowWithMinCost();

const maxFlow = new SimpleMaxFlow();
maxFlow.addArcsWithCapacity([0], [1], [10n]);
const maxFlowStatus: Promise<MaxFlowStatus> = maxFlow.solve(0, 1);
const cut: Int32Array = maxFlow.getSourceSideMinCut();
const busy: boolean = maxFlow.busy;

const lsa = new SimpleLinearSumAssignment();
lsa.addArcsWithCost([0, 1], [1, 0], [5, -5]);
const lsaStatus: LinearSumAssignmentStatus = lsa.solveSync();
const mate: number = lsa.rightMate(0);
lsa.dispose();

// @ts-expect-error capacities are integers, not strings
mcf.addArcWithCapacityAndUnitCost(0, 1, '10', 1);
// @ts-expect-error node indices are numbers
maxFlow.addArcWithCapacity(0n, 1, 1);
// @ts-expect-error solve() needs a source and a sink
maxFlow.solve();
// @ts-expect-error not a max-flow status
const wrongStatus: MaxFlowStatus = 'UNBALANCED';
// @ts-expect-error status constants are read-only
SimpleLinearSumAssignment.OPTIMAL = 'INFEASIBLE';
// @ts-expect-error busy is read-only
lsa.busy = true;
// @ts-expect-error bulk adders take arrays
lsa.addArcsWithCost(0, 1, 2);

export { arc, optimal, flows, pendingMcf, maxFlowStatus, cut, busy, lsaStatus, mate, wrongStatus };

// `using` frees each graph at scope exit (Symbol.dispose).
function scoped(): number {
  using flow = new SimpleMinCostFlow();
  using maxFlowScoped = new SimpleMaxFlow();
  using assignment = new SimpleLinearSumAssignment();
  return flow.numArcs() + maxFlowScoped.numArcs() + assignment.numArcs();
}
export { scoped };
