/// <reference lib="esnext.disposable" />
// Graph algorithms: min-cost flow, max flow and linear sum assignment
// (Python's ortools.graph.python.{min_cost_flow,max_flow,linear_sum_assignment}).
//
// Conventions shared by the three classes:
// * Node and arc indices are integer numbers. Nodes are created by the arcs
//   (and supplies) that use them, so valid nodes are always [0, numNodes()).
// * int64 inputs (capacities, costs, supplies) take a safe-integer number or a
//   BigInt; capacities also take Infinity (int64 max, "unbounded"). int64
//   results come back as numbers; int64 max / min come back as +-Infinity and
//   anything else beyond Number.MAX_SAFE_INTEGER throws a RangeError.
// * Bulk methods take Arrays or typed arrays (Int32Array, Uint32Array,
//   Float64Array, BigInt64Array; Int32Array is the fastest for indices), all of
//   the same length. They validate everything before adding anything.
// * Results throw unless the last solve returned OPTIMAL and the graph has not
//   changed since. Every call throws while a solve() is pending, and after
//   dispose().
// * Memory grows with the largest node index. When OR-Tools runs out of
//   memory, the call throws a RangeError instead of aborting the process (an
//   async solve() rejects). A failed change discards the instance (later calls
//   throw); a failed solve keeps the graph.

/** An integer number or a BigInt holding an int64. */
export type Int64Input = number | bigint;
/** A list of indices or int64 values. */
export type IntList = ReadonlyArray<number | bigint> | Int32Array | Uint32Array | Float64Array | BigInt64Array;

export type MinCostFlowStatus =
  | 'NOT_SOLVED' | 'OPTIMAL' | 'FEASIBLE' | 'INFEASIBLE' | 'UNBALANCED'
  | 'BAD_RESULT' | 'BAD_COST_RANGE' | 'BAD_CAPACITY_RANGE';
export type MaxFlowStatus = 'OPTIMAL' | 'POSSIBLE_OVERFLOW' | 'BAD_INPUT' | 'BAD_RESULT';
export type LinearSumAssignmentStatus = 'OPTIMAL' | 'INFEASIBLE' | 'POSSIBLE_OVERFLOW';

/** Min-cost flow with node supplies (OR-Tools SimpleMinCostFlow). */
export class SimpleMinCostFlow {
  constructor();

  static readonly NOT_SOLVED: 'NOT_SOLVED';
  static readonly OPTIMAL: 'OPTIMAL';
  static readonly FEASIBLE: 'FEASIBLE';
  static readonly INFEASIBLE: 'INFEASIBLE';
  static readonly UNBALANCED: 'UNBALANCED';
  static readonly BAD_RESULT: 'BAD_RESULT';
  static readonly BAD_COST_RANGE: 'BAD_COST_RANGE';
  static readonly BAD_CAPACITY_RANGE: 'BAD_CAPACITY_RANGE';
  readonly NOT_SOLVED: 'NOT_SOLVED';
  readonly OPTIMAL: 'OPTIMAL';
  readonly FEASIBLE: 'FEASIBLE';
  readonly INFEASIBLE: 'INFEASIBLE';
  readonly UNBALANCED: 'UNBALANCED';
  readonly BAD_RESULT: 'BAD_RESULT';
  readonly BAD_COST_RANGE: 'BAD_COST_RANGE';
  readonly BAD_CAPACITY_RANGE: 'BAD_CAPACITY_RANGE';

  /** Adds tail -> head; capacity >= 0, the unit cost may be negative. Returns the arc index. */
  addArcWithCapacityAndUnitCost(tail: number, head: number, capacity: Int64Input, unitCost: Int64Input): number;
  /** Bulk addArcWithCapacityAndUnitCost; returns the new arc indices. */
  addArcsWithCapacityAndUnitCost(tails: IntList, heads: IntList, capacities: IntList, unitCosts: IntList): Int32Array;
  setArcCapacity(arc: number, capacity: Int64Input): void;
  /** A demand is a negative supply. */
  setNodeSupply(node: number, supply: Int64Input): void;
  setNodesSupplies(nodes: IntList, supplies: IntList): void;

  /**
   * Supplies must balance and be satisfiable; solves on the threadpool.
   * BAD_CAPACITY_RANGE also covers total supply or demand beyond int64.
   */
  solve(): Promise<MinCostFlowStatus>;
  solveSync(): MinCostFlowStatus;
  /** Sends as much of the supply as possible at minimum cost (no balance needed). */
  solveMaxFlowWithMinCost(): Promise<MinCostFlowStatus>;
  solveMaxFlowWithMinCostSync(): MinCostFlowStatus;

  /** Infinity when the total cost overflows int64 (the flows stay valid). */
  optimalCost(): number;
  maximumFlow(): number;
  flow(arc: number): number;
  /** Flows of the given arcs, or of every arc. */
  flows(arcs?: IntList): number[];

  numNodes(): number;
  numArcs(): number;
  tail(arc: number): number;
  head(arc: number): number;
  capacity(arc: number): number;
  unitCost(arc: number): number;
  supply(node: number): number;

  /** True while a solve() is pending. */
  readonly busy: boolean;
  /** Frees the native graph now; later calls throw. Idempotent; throws while busy. */
  dispose(): void;
  /** Same as dispose(), so `using graph = new ...()` frees it at scope exit. */
  [Symbol.dispose](): void;
}

/** Maximum flow from a source to a sink (OR-Tools SimpleMaxFlow). */
export class SimpleMaxFlow {
  constructor();

  static readonly OPTIMAL: 'OPTIMAL';
  static readonly POSSIBLE_OVERFLOW: 'POSSIBLE_OVERFLOW';
  static readonly BAD_INPUT: 'BAD_INPUT';
  static readonly BAD_RESULT: 'BAD_RESULT';
  readonly OPTIMAL: 'OPTIMAL';
  readonly POSSIBLE_OVERFLOW: 'POSSIBLE_OVERFLOW';
  readonly BAD_INPUT: 'BAD_INPUT';
  readonly BAD_RESULT: 'BAD_RESULT';

  /** Adds tail -> head with capacity >= 0. Returns the arc index. */
  addArcWithCapacity(tail: number, head: number, capacity: Int64Input): number;
  /** Bulk addArcWithCapacity; returns the new arc indices. */
  addArcsWithCapacity(tails: IntList, heads: IntList, capacities: IntList): Int32Array;
  setArcCapacity(arc: number, capacity: Int64Input): void;

  /** BAD_INPUT when source === sink; a source or sink outside the graph gives a flow of 0. */
  solve(source: number, sink: number): Promise<MaxFlowStatus>;
  solveSync(source: number, sink: number): MaxFlowStatus;

  optimalFlow(): number;
  flow(arc: number): number;
  /** Flows of the given arcs, or of every arc. */
  flows(arcs?: IntList): number[];
  /** Nodes reachable from the source through non-saturated arcs. */
  getSourceSideMinCut(): Int32Array;
  /** Nodes that reach the sink through non-saturated arcs. */
  getSinkSideMinCut(): Int32Array;

  numNodes(): number;
  numArcs(): number;
  tail(arc: number): number;
  head(arc: number): number;
  capacity(arc: number): number;

  /** True while a solve() is pending. */
  readonly busy: boolean;
  /** Frees the native graph now; later calls throw. Idempotent; throws while busy. */
  dispose(): void;
  /** Same as dispose(), so `using graph = new ...()` frees it at scope exit. */
  [Symbol.dispose](): void;
}

/**
 * Minimum-cost perfect matching of left nodes [0, n) to right nodes [0, n)
 * (OR-Tools SimpleLinearSumAssignment).
 */
export class SimpleLinearSumAssignment {
  constructor();

  static readonly OPTIMAL: 'OPTIMAL';
  static readonly INFEASIBLE: 'INFEASIBLE';
  static readonly POSSIBLE_OVERFLOW: 'POSSIBLE_OVERFLOW';
  readonly OPTIMAL: 'OPTIMAL';
  readonly INFEASIBLE: 'INFEASIBLE';
  readonly POSSIBLE_OVERFLOW: 'POSSIBLE_OVERFLOW';

  /** Adds an arc; the cost may be negative. Returns the arc index. */
  addArcWithCost(leftNode: number, rightNode: number, cost: Int64Input): number;
  /** Bulk addArcWithCost; returns the new arc indices. */
  addArcsWithCost(leftNodes: IntList, rightNodes: IntList, costs: IntList): Int32Array;

  /**
   * POSSIBLE_OVERFLOW when costs are too large to scale safely. Any cost
   * magnitude above (2^63 - 1) / (numNodes() + 1) is always rejected, and
   * OR-Tools' own price bounds reject smaller costs too (from about 2^63 / 6
   * with one node, less on larger graphs), so keep costs well below that.
   */
  solve(): Promise<LinearSumAssignmentStatus>;
  solveSync(): LinearSumAssignmentStatus;

  optimalCost(): number;
  rightMate(leftNode: number): number;
  assignmentCost(leftNode: number): number;

  numNodes(): number;
  numArcs(): number;
  leftNode(arc: number): number;
  rightNode(arc: number): number;
  cost(arc: number): number;

  /** True while a solve() is pending. */
  readonly busy: boolean;
  /** Frees the native graph now; later calls throw. Idempotent; throws while busy. */
  dispose(): void;
  /** Same as dispose(), so `using graph = new ...()` frees it at scope exit. */
  [Symbol.dispose](): void;
}
