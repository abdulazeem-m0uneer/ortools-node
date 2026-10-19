// Vehicle routing (pywrapcp's RoutingIndexManager / RoutingModel).

import { CpInt, CpSolver, IntExpr, IntVar } from './cp';
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

/** Integer values for transits and capacities; ±Infinity maps to the int64 extremes. */
export type Int64Array = ArrayLike<CpInt> | Int32Array | Uint32Array | Float64Array | BigInt64Array;

export class RoutingIndexManager {
  constructor(numNodes: number, numVehicles: number, depot: number);
  constructor(numNodes: number, numVehicles: number, starts: ArrayLike<number>, ends: ArrayLike<number>);
  /** -1 for a node that is only an end depot. */
  nodeToIndex(node: number): number;
  indexToNode(index: number): number;
  nodesToIndices(nodes: ArrayLike<number>): number[];
  indicesToNodes(indices: ArrayLike<number>): number[];
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

/** Valid until the model is solved again, changed or disposed; then every call throws. */
/** An exact solution value: a number up to 2^53, a bigint beyond, ±Infinity for the int64 extremes. */
export type SolutionValue = number | bigint;

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
  /** Per vehicle, the slack at each index of routes(), null at the end. */
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

export interface SolveOptions {
  /** Called for each solution found; a throw stops the search and rejects. */
  onSolution?: (snapshot: RoutingSolutionSnapshot) => void;
  includeRoutes?: boolean;
}

export type RoutingParameters = Overrides<RoutingSearchParameters>;

export class RoutingModel {
  constructor(manager: RoutingIndexManager);
  solver(): CpSolver;

  registerTransitMatrix(matrix: ArrayLike<Int64Array>): number;
  registerUnaryTransitVector(values: Int64Array): number;
  /** Evaluated now, for every pair of indices: fn must be pure and return integers. */
  registerTransitCallback(fn: (fromIndex: number, toIndex: number) => CpInt): number;
  registerUnaryTransitCallback(fn: (fromIndex: number) => CpInt): number;
  setArcCostEvaluatorOfAllVehicles(evaluator: number): void;
  setArcCostEvaluatorOfVehicle(evaluator: number, vehicle: number): void;
  setFixedCostOfAllVehicles(cost: CpInt): void;
  setFixedCostOfVehicle(cost: CpInt, vehicle: number): void;

  addDimension(evaluator: number, slackMax: CpInt, capacity: CpInt, fixStartCumulToZero: boolean, name: string): boolean;
  addDimensionWithVehicleCapacity(evaluator: number, slackMax: CpInt, vehicleCapacities: Int64Array,
    fixStartCumulToZero: boolean, name: string): boolean;
  addDimensionWithVehicleTransits(evaluators: ArrayLike<number>, slackMax: CpInt, capacity: CpInt,
    fixStartCumulToZero: boolean, name: string): boolean;
  addDimensionWithVehicleTransitAndCapacity(evaluators: ArrayLike<number>, slackMax: CpInt,
    vehicleCapacities: Int64Array, fixStartCumulToZero: boolean, name: string): boolean;
  addConstantDimension(value: CpInt, capacity: CpInt, fixStartCumulToZero: boolean, name: string): [number, boolean];
  addVectorDimension(values: Int64Array, capacity: CpInt, fixStartCumulToZero: boolean, name: string): [number, boolean];
  addMatrixDimension(matrix: ArrayLike<Int64Array>, capacity: CpInt, fixStartCumulToZero: boolean,
    name: string): [number, boolean];
  hasDimension(name: string): boolean;
  getDimensionOrDie(name: string): RoutingDimension;

  addPickupAndDelivery(pickup: number, delivery: number): void;
  addPickupAndDeliverySets(pickupDisjunction: number, deliveryDisjunction: number): void;
  setPickupAndDeliveryPolicyOfAllVehicles(policy: PickupAndDeliveryPolicyName): void;
  setPickupAndDeliveryPolicyOfVehicle(policy: PickupAndDeliveryPolicyName, vehicle: number): void;
  /** Returns the disjunction index. The default penalty -1 makes it mandatory. */
  addDisjunction(indices: ArrayLike<number>, penalty?: CpInt, maxCardinality?: CpInt): number;
  setAllowedVehiclesForIndex(vehicles: ArrayLike<number>, index: number): void;
  setVisitType(index: number, type: number, policy: VisitTypePolicyName): void;
  addHardTypeIncompatibility(type1: number, type2: number): void;
  addTemporalTypeIncompatibility(type1: number, type2: number): void;
  addRequiredTypeAlternativesWhenAddingType(dependentType: number, requiredTypes: ArrayLike<number>): void;
  addRequiredTypeAlternativesWhenRemovingType(dependentType: number, requiredTypes: ArrayLike<number>): void;
  addSoftSameVehicleConstraint(indices: ArrayLike<number>, cost: CpInt): void;
  /** OR-Tools 9.15 and later. */
  addSameActivityGroup(indices: ArrayLike<number>): void;

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
  applyLocks(locks: ArrayLike<number>): IntVar | null;
  applyLocksToAllVehicles(locks: ArrayLike<number>[], closeRoutes: boolean): boolean;
  readAssignmentFromRoutes(routes: ArrayLike<number>[], ignoreInactiveIndices: boolean): RoutingSolution | null;

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
