// Python's ortools.set_cover.python.set_cover, exported as `setCover`.

export type SetCoverMipSolverName = 'SCIP' | 'SAT' | 'GUROBI' | 'GLOP' | 'PDLP';
/** MIP backends this build can run for SetCoverMip. */
export const SetCoverMipSolver: Readonly<Partial<{ [K in SetCoverMipSolverName]: K }>>;

/** Subset indices: an Array of integer numbers or BigInts, or an Int32Array, Uint32Array, Float64Array or BigInt64Array. */
export type SubsetList = ReadonlyArray<number | bigint> | Int32Array | Uint32Array | Float64Array | BigInt64Array;

/** SetCoverProto in protobuf's JSON form. */
export interface SetCoverProto {
  name?: string;
  subset?: Array<{ cost: number; element?: number[] }>;
}

/** Subsets with costs > 0 over elements 0..numElements - 1. */
export class SetCoverModel {
  constructor(name?: string);
  readonly name: string;
  setName(name: string): this;
  /** Returns the new subset's index. */
  addEmptySubset(cost: number): number;
  addElementToLastSubset(element: number): this;
  addElementToSubset(element: number, subset: number): this;
  setSubsetCost(subset: number, cost: number): this;
  readonly numElements: number;
  readonly numSubsets: number;
  readonly numNonzeros: number;
  readonly fillRate: number;
  readonly subsetCosts: number[];
  readonly columns: number[][];
  readonly rows: number[][];
  readonly allSubsets: number[];
  computeFeasibility(): boolean;
  exportModelAsProto(): Required<SetCoverProto>;
  importModelFromProto(proto: SetCoverProto): this;
}

/** A solution of a SetCoverModel, copied at construction. */
export class SetCoverInvariant {
  /** Throws unless the model is feasible (subsets, elements, every element covered). */
  constructor(model: SetCoverModel);
  readonly model: SetCoverModel;
  cost(): number;
  lowerBound(): number;
  numUncoveredElements(): number;
  isSelected(): boolean[];
  selectedSubsets(): number[];
  coverage(): number[];
  loadSolution(selected: readonly boolean[]): this;
  clear(): this;
  readonly busy: boolean;
  /** Idempotent; throws while a generator runs; later calls throw. */
  dispose(): void;
  [Symbol.dispose](): void;
}

export class SetCoverSolutionGenerator {
  protected constructor(inv: SetCoverInvariant, kind: string);
  readonly inv: SetCoverInvariant;
  readonly name: string;
  setMaxIterations(maxIterations: number): this;
  /** Resolves to whether a solution was produced; `focus` limits the subsets it may change. */
  nextSolution(focus?: SubsetList): Promise<boolean>;
  nextSolutionSync(focus?: SubsetList): boolean;
}

export class TrivialSolutionGenerator extends SetCoverSolutionGenerator {
  constructor(inv: SetCoverInvariant);
}
export class RandomSolutionGenerator extends SetCoverSolutionGenerator {
  constructor(inv: SetCoverInvariant);
}
export class GreedySolutionGenerator extends SetCoverSolutionGenerator {
  constructor(inv: SetCoverInvariant);
}
export class ElementDegreeSolutionGenerator extends SetCoverSolutionGenerator {
  constructor(inv: SetCoverInvariant);
}
export class LazyElementDegreeSolutionGenerator extends SetCoverSolutionGenerator {
  constructor(inv: SetCoverInvariant);
}
export class SteepestSearch extends SetCoverSolutionGenerator {
  constructor(inv: SetCoverInvariant);
}
export class GuidedLocalSearch extends SetCoverSolutionGenerator {
  constructor(inv: SetCoverInvariant);
}
export class GuidedTabuSearch extends SetCoverSolutionGenerator {
  constructor(inv: SetCoverInvariant);
  setLagrangianFactor(factor: number): this;
  setPenaltyFactor(factor: number): this;
  setEpsilon(epsilon: number): this;
  setTabuListSize(size: number): this;
}
export class SetCoverMip extends SetCoverSolutionGenerator {
  constructor(inv: SetCoverInvariant);
  /** MPSolver status of the last run, e.g. 'OPTIMAL'. */
  readonly solveStatus: string | undefined;
  useMipSolver(solver: SetCoverMipSolverName): this;
  useIntegers(useIntegers: boolean): this;
  setTimeLimitInSeconds(seconds: number): this;
}

export function clearRandomSubsets(inv: SetCoverInvariant, numSubsets: number, focus?: SubsetList): number[];
export function clearMostCoveredElements(inv: SetCoverInvariant, numSubsets: number, focus?: SubsetList): number[];
