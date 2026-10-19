// Compile-time checks for lib/set_cover.d.ts (run by `npm run typecheck`).
import { setCover } from '../../lib/index';

const { SetCoverModel, SetCoverInvariant, GreedySolutionGenerator, GuidedTabuSearch, SetCoverMip } = setCover;

const model = new SetCoverModel('typed');
const subset: number = model.addEmptySubset(2);
model.addElementToLastSubset(0).addElementToSubset(1, subset).setSubsetCost(subset, 3);
const proto: setCover.SetCoverProto = model.exportModelAsProto();

using inv = new SetCoverInvariant(model);
const found: Promise<boolean> = new GreedySolutionGenerator(inv).setMaxIterations(10).nextSolution([0]);
const tabu: boolean = new GuidedTabuSearch(inv).setTabuListSize(7).setEpsilon(1e-3).nextSolutionSync(new Int32Array([0]));
const mip = new SetCoverMip(inv).useMipSolver('SCIP').useIntegers(false).setTimeLimitInSeconds(5);
const status: string | undefined = mip.solveStatus;
const cleared: number[] = setCover.clearRandomSubsets(inv, 1);
const focuses: setCover.SubsetList[] = [[0, 1n], new Uint32Array([0]), new Float64Array([0]), new BigInt64Array([0n])];
setCover.clearMostCoveredElements(inv, 1, focuses[3]);
const selected: number[] = inv.selectedSubsets();

// @ts-expect-error unknown MIP backend
mip.useMipSolver('CPLEX');
// @ts-expect-error the base class is abstract in spirit: its constructor is protected
new setCover.SetCoverSolutionGenerator(inv, 'GREEDY');
// @ts-expect-error a focus lists subset indices
new GreedySolutionGenerator(inv).nextSolutionSync(['0']);
// @ts-expect-error the addon does not read Uint8Array
new GreedySolutionGenerator(inv).nextSolutionSync(new Uint8Array([0]));

export { proto, found, tabu, status, cleared, selected };
