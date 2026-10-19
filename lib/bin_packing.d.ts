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
  /**
   * An integer in [1, 1024]; 1 by default. Known limitation: CBC above 1 prints
   * `No match for threads` lines to stdout, even with enableOutput false.
   */
  numThreads?: number;
  /**
   * Backend-specific parameter text, for SCIP and CP_SAT only: CBC and HIGHS
   * take none here, so any non-empty text throws a TypeError for them. Parameters
   * the backend rejects throw a TypeError.
   */
  mipParameters?: string;
  /**
   * Writes the backend's log to stdout; false by default. On OR-Tools 9.14,
   * HiGHS prints only its banner whatever this option says (that release's
   * HiGHS interface ignores it).
   */
  enableOutput?: boolean;
}

/**
 * Solves off the main thread. Invalid input throws a TypeError or RangeError
 * synchronously (as every async API here does); only a failure during the solve
 * rejects. Option keys other than those of VectorBinPackingOptions are ignored.
 */
export function solveVectorBinPacking(
  problem: VectorBinPackingProblem, options?: VectorBinPackingOptions,
): Promise<VectorBinPackingSolution>;
/** Blocking solveVectorBinPacking(); invalid input throws the same errors. */
export function solveVectorBinPackingSync(
  problem: VectorBinPackingProblem, options?: VectorBinPackingOptions,
): VectorBinPackingSolution;
