export type KnapsackSolverTypeName =
  | 'KNAPSACK_BRUTE_FORCE_SOLVER'
  | 'KNAPSACK_64ITEMS_SOLVER'
  | 'KNAPSACK_DYNAMIC_PROGRAMMING_SOLVER'
  | 'KNAPSACK_DIVIDE_AND_CONQUER_SOLVER'
  | 'KNAPSACK_MULTIDIMENSION_BRANCH_AND_BOUND_SOLVER'
  | 'KNAPSACK_MULTIDIMENSION_CP_SAT_SOLVER'
  | 'KNAPSACK_MULTIDIMENSION_CBC_MIP_SOLVER'
  | 'KNAPSACK_MULTIDIMENSION_SCIP_MIP_SOLVER'
  | 'KNAPSACK_MULTIDIMENSION_XPRESS_MIP_SOLVER'
  | 'KNAPSACK_MULTIDIMENSION_CPLEX_MIP_SOLVER';

/** Solver types this OR-Tools build can run; MIP-based ones only when their backend is compiled in. */
export const KnapsackSolverType: Readonly<Partial<{ [K in KnapsackSolverTypeName]: K }>>;

/** Non-negative integers: numbers (safe integers) or BigInts, or a typed array of them. */
export type KnapsackIntArray =
  | ReadonlyArray<number | bigint>
  | Int32Array
  | Uint32Array
  | Float64Array
  | BigInt64Array;

export class KnapsackSolver {
  /** Throws for a type that is unknown or not available in this build. */
  constructor(solverType: KnapsackSolverTypeName, name?: string);
  readonly solverType: KnapsackSolverTypeName;
  /**
   * profits[i]; weights[d][i] for item i in dimension d; capacities[d]. Needed
   * again before every solve(). The single-dimension types take exactly one
   * dimension; brute force takes at most 30 items, 64ITEMS at most 64.
   * The MIP types need each dimension's weights to add up to at most 2^20 (their
   * feasibility tolerance is relative), CP-SAT below 2^62.
   */
  init(profits: KnapsackIntArray, weights: ReadonlyArray<KnapsackIntArray>, capacities: KnapsackIntArray): this;
  /** Resolves to the best total profit. */
  solve(): Promise<number>;
  solveSync(): number;
  bestSolutionContains(item: number): boolean;
  /** False when the time limit stopped the search early. */
  isSolutionOptimal(): boolean;
  /** Seconds per solve; Infinity (the default) means no limit. */
  setTimeLimit(seconds: number): this;
  /** On by default; a change needs a new init(). */
  setUseReduction(useReduction: boolean): this;
  readonly useReduction: boolean;
  readonly name: string;
  readonly busy: boolean;
  /** Frees the native solver now; later calls throw. Idempotent. */
  dispose(): void;
  [Symbol.dispose](): void;
}
