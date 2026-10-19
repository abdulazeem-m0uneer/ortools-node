// Compile-time checks for lib/bin_packing.d.ts (run by `npm run typecheck`).
import {
  VectorBinPackingProblem, VectorBinPackingSolution, VectorBinPackingSolverType, solveVectorBinPacking,
  solveVectorBinPackingSync,
} from '../lib/index';

const problem: VectorBinPackingProblem = {
  resourceCapacity: [10, 10n],
  item: [{ name: 'a', resourceUsage: [6, '2'], numCopies: 2, maxNumberOfCopiesPerBin: 1 }],
  costPerBin: 2,
};
const pending: Promise<VectorBinPackingSolution> = solveVectorBinPacking(problem, { solverType: 'CP_SAT', numThreads: 2 });
const solution = solveVectorBinPackingSync(problem, { timeLimitSeconds: 5, mipParameters: '', enableOutput: true });
const bins: number = solution.bins.length;
const scip: string | undefined = VectorBinPackingSolverType.SCIP;

// @ts-expect-error resourceCapacity is required
solveVectorBinPackingSync({ item: [] });
// @ts-expect-error numThreads is a number
solveVectorBinPackingSync(problem, { numThreads: '2' });
// @ts-expect-error enableOutput is a boolean
solveVectorBinPackingSync(problem, { enableOutput: 1 });

export { pending, bins, scip };
