// Vehicle routing (pywrapcp's RoutingIndexManager / RoutingModel).

import { CpInt, CpSolver, CpValue, Int64Values, IntExpr, IntVar } from './cp';
import { Overrides, RoutingSearchParameters, RoutingSearchStatusName } from './params';

export type VisitTypePolicyName =
  | 'TYPE_ADDED_TO_VEHICLE'
  | 'ADDED_TYPE_REMOVED_FROM_VEHICLE'
  | 'TYPE_ON_VEHICLE_UP_TO_VISIT'
  | 'TYPE_SIMULTANEOUSLY_ADDED_AND_REMOVED';
export type PickupAndDeliveryPolicyName =
  | 'PICKUP_AND_DELIVERY_NO_ORDER' | 'PICKUP_AND_DELIVERY_LIFO' | 'PICKUP_AND_DELIVERY_FIFO';

export const VisitTypePolicy: Readonly<{ [K in VisitTypePolicyName]: K }>;
export const PickupAndDeliveryPolicy: Readonly<{ [K in PickupAndDeliveryPolicyName]: K }>;

/** Indices, nodes and vehicles: an Array of integer numbers or BigInts, or an Int32Array, Uint32Array, Float64Array or BigInt64Array. */
export type IndexValues = ReadonlyArray<number | bigint> | Int32Array | Uint32Array | Float64Array | BigInt64Array;

export class RoutingIndexManager {
  constructor(numNodes: number, numVehicles: number, depot: number);
  constructor(numNodes: number, numVehicles: number, starts: IndexValues, ends: IndexValues);
  /** -1 for a node that is only an end depot. */
  nodeToIndex(node: number): number;
  indexToNode(index: number): number;
  nodesToIndices(nodes: IndexValues): number[];
  indicesToNodes(indices: IndexValues): number[];
  getNumberOfNodes(): number;
  getNumberOfVehicles(): number;
  getNumberOfIndices(): number;
  getStartIndex(vehicle: number): number;
  getEndIndex(vehicle: number): number;
}

export class RoutingDimension {
  private constructor();
  name(): string;
  cumulVar(index: number): IntVar;
  slackVar(index: number): IntVar;
  transitVar(index: number): IntVar;
  setSpanUpperBoundForVehicle(upperBound: CpInt, vehicle: number): void;
  setSpanCostCoefficientForVehicle(coefficient: CpInt, vehicle: number): void;
  setSpanCostCoefficientForAllVehicles(coefficient: CpInt): void;
  setGlobalSpanCostCoefficient(coefficient: CpInt): void;
  setCumulVarSoftUpperBound(index: number, upperBound: CpInt, coefficient: CpInt): void;
  setCumulVarSoftLowerBound(index: number, lowerBound: CpInt, coefficient: CpInt): void;
}

/** An exact solution value; the same rule as every CP int64 result (CpValue). */
export type SolutionValue = CpValue;

/** Valid until the model is solved again, changed or disposed; then every call throws. */
export class RoutingSolution {
  private constructor();
  readonly valid: boolean;
  objectiveValue(): SolutionValue;
  value(variable: IntVar): SolutionValue;
  min(variable: IntVar): SolutionValue;
  max(variable: IntVar): SolutionValue;
  /** Per vehicle, the visited indices from its start to its end. */
  routes(): number[][];
  /** Per vehicle, the cumul at each index of routes(). */
  cumuls(dimension: RoutingDimension | string): SolutionValue[][];
  /**
   * Per vehicle, the slack at each index of routes(), null at the end. Throws
   * unless the slack variables were stored in solutions: call
   * model.addToAssignment(dimension.slackVar(i)) for them before closing the model.
   */
  slacks(dimension: RoutingDimension | string): Array<Array<SolutionValue | null>>;
}

export interface RoutingSolutionSnapshot {
  /** A bigint beyond Number.MAX_SAFE_INTEGER (e.g. large penalties). */
  objective: SolutionValue;
  /** 0 for the first solution of the solve, then 1, 2... */
  solutionIndex: number;
  /** With includeRoutes: per vehicle, start to end (null if not readable). */
  routes?: number[][] | null;
}

/** A progress event of a routing solve (SolveOptions.onProgress). */
export interface RoutingProgress {
  /** Solutions found so far in this solve. */
  solutions: number;
  /** The best objective so far; null before the first solution. */
  objective: SolutionValue | null;
  /** Search counters of this solve. */
  branches: number;
  failures: number;
  wallTimeMs: number;
  /** True for the final event, sent once when the search has ended. */
  done: boolean;
}

export interface SolveOptions {
  /**
   * Called for each solution found; a throw stops the search and rejects.
   * During an async solve every snapshot is queued, so a slow callback costs
   * memory (one snapshot per solution), never solver time.
   */
  onSolution?: (snapshot: RoutingSolutionSnapshot) => void;
  includeRoutes?: boolean;
  /**
   * Called at most every progressIntervalMs while the search runs, then once
   * with done: true. During an async solve, events coalesce while the callback
   * is busy: the next call carries the latest values. A throw stops the search
   * and rejects.
   */
  onProgress?: (progress: RoutingProgress) => void;
  /** Minimum time between progress events: an integer in [0, 2^31 - 1]. Default 500. */
  progressIntervalMs?: number;
}

export type RoutingParameters = Overrides<RoutingSearchParameters>;

export class RoutingModel {
  constructor(manager: RoutingIndexManager);
  solver(): CpSolver;

  registerTransitMatrix(matrix: ReadonlyArray<Int64Values>): number;
  registerUnaryTransitVector(values: Int64Values): number;
  /**
   * Evaluated now, for every pair of indices (solving runs off the JS thread):
   * fn must be pure and return integers. Limited to 16384 indices, since it
   * stores one value per pair; use registerTransitMatrix() for larger models.
   */
  registerTransitCallback(fn: (fromIndex: number, toIndex: number) => CpInt): number;
  registerUnaryTransitCallback(fn: (fromIndex: number) => CpInt): number;
  setArcCostEvaluatorOfAllVehicles(evaluator: number): void;
  setArcCostEvaluatorOfVehicle(evaluator: number, vehicle: number): void;
  setFixedCostOfAllVehicles(cost: CpInt): void;
  setFixedCostOfVehicle(cost: CpInt, vehicle: number): void;

  addDimension(evaluator: number, slackMax: CpInt, capacity: CpInt, fixStartCumulToZero: boolean, name: string): boolean;
  addDimensionWithVehicleCapacity(evaluator: number, slackMax: CpInt, vehicleCapacities: Int64Values,
    fixStartCumulToZero: boolean, name: string): boolean;
  addDimensionWithVehicleTransits(evaluators: IndexValues, slackMax: CpInt, capacity: CpInt,
    fixStartCumulToZero: boolean, name: string): boolean;
  addDimensionWithVehicleTransitAndCapacity(evaluators: IndexValues, slackMax: CpInt,
    vehicleCapacities: Int64Values, fixStartCumulToZero: boolean, name: string): boolean;
  addConstantDimension(value: CpInt, capacity: CpInt, fixStartCumulToZero: boolean, name: string): [number, boolean];
  addVectorDimension(values: Int64Values, capacity: CpInt, fixStartCumulToZero: boolean, name: string): [number, boolean];
  addMatrixDimension(matrix: ReadonlyArray<Int64Values>, capacity: CpInt, fixStartCumulToZero: boolean,
    name: string): [number, boolean];
  hasDimension(name: string): boolean;
  getDimensionOrDie(name: string): RoutingDimension;

  addPickupAndDelivery(pickup: number, delivery: number): void;
  addPickupAndDeliverySets(pickupDisjunction: number, deliveryDisjunction: number): void;
  setPickupAndDeliveryPolicyOfAllVehicles(policy: PickupAndDeliveryPolicyName): void;
  setPickupAndDeliveryPolicyOfVehicle(policy: PickupAndDeliveryPolicyName, vehicle: number): void;
  /** Returns the disjunction index. The default penalty -1 makes it mandatory. */
  addDisjunction(indices: IndexValues, penalty?: CpInt, maxCardinality?: CpInt): number;
  setAllowedVehiclesForIndex(vehicles: IndexValues, index: number): void;
  setVisitType(index: number, type: number, policy: VisitTypePolicyName): void;
  addHardTypeIncompatibility(type1: number, type2: number): void;
  addTemporalTypeIncompatibility(type1: number, type2: number): void;
  addRequiredTypeAlternativesWhenAddingType(dependentType: number, requiredTypes: IndexValues): void;
  addRequiredTypeAlternativesWhenRemovingType(dependentType: number, requiredTypes: IndexValues): void;
  addSoftSameVehicleConstraint(indices: IndexValues, cost: CpInt): void;
  /** OR-Tools 9.15 and later. */
  addSameActivityGroup(indices: IndexValues): void;

  nextVar(index: number): IntVar;
  vehicleVar(index: number): IntVar;
  activeVar(index: number): IntVar;
  costVar(): IntVar;
  start(vehicle: number): number;
  end(vehicle: number): number;
  isStart(index: number): boolean;
  isEnd(index: number): boolean;
  size(): number;
  vehicles(): number;
  nodes(): number;

  addVariableMinimizedByFinalizer(variable: IntExpr): void;
  addVariableMaximizedByFinalizer(variable: IntExpr): void;
  addVariableTargetToFinalizer(variable: IntExpr, target: CpInt): void;
  addToAssignment(variable: IntExpr): void;

  closeModel(): void;
  closeModelWithParameters(params?: RoutingParameters): void;
  readonly closed: boolean;
  applyLocks(locks: IndexValues): IntVar | null;
  applyLocksToAllVehicles(locks: ReadonlyArray<IndexValues>, closeRoutes: boolean): boolean;
  readAssignmentFromRoutes(routes: ReadonlyArray<IndexValues>, ignoreInactiveIndices: boolean): RoutingSolution | null;

  solveWithParameters(params?: RoutingParameters, options?: SolveOptions): Promise<RoutingSolution | null>;
  solveFromAssignmentWithParameters(assignment: RoutingSolution, params?: RoutingParameters,
    options?: SolveOptions): Promise<RoutingSolution | null>;
  solveWithParametersSync(params?: RoutingParameters, options?: SolveOptions): RoutingSolution | null;
  solveFromAssignmentWithParametersSync(assignment: RoutingSolution, params?: RoutingParameters,
    options?: SolveOptions): RoutingSolution | null;
  status(): RoutingSearchStatusName;
  interrupt(): boolean;
  readonly busy: boolean;
  dispose(): void;
  [Symbol.dispose](): void;
}
