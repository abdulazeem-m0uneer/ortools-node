// Compile-time checks for lib/knapsack.d.ts (run by `npm run typecheck`).
import { KnapsackSolver, KnapsackSolverType } from '../lib/index';

const solver = new KnapsackSolver('KNAPSACK_MULTIDIMENSION_BRANCH_AND_BOUND_SOLVER', 'sample');
solver.setTimeLimit(10).setUseReduction(true).init([1, 2n], [new BigInt64Array([1n, 2n]), [3, 4]], new Uint32Array([5]));
const best: Promise<number> = solver.solve();
const now: number = solver.solveSync();
const inside: boolean = solver.bestSolutionContains(0);
const optimal: boolean = solver.isSolutionOptimal();
const dp: string | undefined = KnapsackSolverType.KNAPSACK_DYNAMIC_PROGRAMMING_SOLVER;
{
  using scoped = new KnapsackSolver('KNAPSACK_DYNAMIC_PROGRAMMING_SOLVER');
  scoped.init([1], [[1]], [1]);
}

// @ts-expect-error unknown solver type
new KnapsackSolver('KNAPSACK_NOPE');
// @ts-expect-error weights are per dimension
solver.init([1], [1], [1]);
// @ts-expect-error the constants are read-only
KnapsackSolverType.KNAPSACK_64ITEMS_SOLVER = 'KNAPSACK_64ITEMS_SOLVER';
// @ts-expect-error read-only
solver.busy = true;

export { best, now, inside, optimal, dp };
