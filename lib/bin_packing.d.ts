// Vector bin packing with the arc-flow formulation (vector_bin_packing.proto).

export type VectorBinPackingSolverName =
  | 'SCIP' | 'CBC' | 'CP_SAT' | 'HIGHS' | 'GUROBI' | 'CPLEX' | 'XPRESS' | 'GLPK' | (string & {});
/** MIP backends this build can use for bin packing. */
export const VectorBinPackingSolverType: Readonly<Record<string, string>>;

/** An int64 field: a number, a BigInt or a decimal string. */
export type VbpInt64 = number | bigint | string;

export interface VectorBinPackingItem {
  name?: string;
  /** One value per resource, in [0, 2^30]. */
  resourceUsage: VbpInt64[];
  /** Copies that must be packed. */
  numCopies?: number;
  /** Copies that may be left out, each costing penaltyPerMissingCopy. */
  numOptionalCopies?: number;
  /** 0: no limit. */
  maxNumberOfCopiesPerBin?: number;
  penaltyPerMissingCopy?: number;
}

export interface VectorBinPackingProblem {
  name?: string;
  /** One capacity per resource, in [1, 2^30]. */
  resourceCapacity: VbpInt64[];
  resourceName?: string[];
  item: VectorBinPackingItem[];
  /** When > 0, the most bins the solution may use. */
  maxBins?: number;
  /** 1 by default. */
  costPerBin?: number;
}

export interface VectorBinPackingSolution {
  solverInfo: string;
  bins: Array<{ itemIndices: number[]; itemCopies: number[] }>;
  /** ..._UNSPECIFIED: no packing found within the limits. */
  status: 'OPTIMAL' | 'FEASIBLE' | 'INFEASIBLE' | 'VECTOR_BIN_PACKING_SOLVE_STATUS_UNSPECIFIED';
  objectiveValue: number;
  solveTimeInSeconds: number;
  arcFlowTimeInSeconds: number;
}

export interface VectorBinPackingOptions {
  /** 'SCIP' when available. */
  solverType?: VectorBinPackingSolverName;
  /** > 0; Infinity (the default) for no limit. Limits under 1 ms count as 1 ms. */
  timeLimitSeconds?: number;
  /** An integer in [1, 1024]; 1 by default. */
  numThreads?: number;
  /** Backend-specific parameter text; parameters the backend rejects throw a TypeError. */
  mipParameters?: string;
}

/** Solves off the main thread. Invalid problems throw a RangeError or TypeError. */
export function solveVectorBinPacking(
  problem: VectorBinPackingProblem, options?: VectorBinPackingOptions,
): Promise<VectorBinPackingSolution>;
export function solveVectorBinPackingSync(
  problem: VectorBinPackingProblem, options?: VectorBinPackingOptions,
): VectorBinPackingSolution;
