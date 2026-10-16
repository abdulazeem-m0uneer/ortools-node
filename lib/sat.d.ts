// CP-SAT: CpModel builds a CpModelProto in JS, CpSolver solves it natively.
// Integers are safe-integer numbers or BigInts (int64); ±Infinity in bounds and
// domains means unbounded. CpLinearExpr / CpConstraint carry a Cp prefix
// because the linear solver already exports Constraint and LinearExpr.

import { SatParameters } from './params';

/** An int64 value: a safe integer number, or a BigInt beyond 2^53 - 1. */
export type Int = number | bigint;
/** Anything usable where a linear expression is expected. */
export type LinearExprLike = CpLinearExpr | Int;
/** A Boolean variable, its negation, or a constant. */
export type Literal = IntVar | NotBooleanVariable | boolean;
/** A circuit / routes arc: [tail node, head node, literal]. */
export type Arc = [number, number, Literal];

export type CpSolverStatusName = 'UNKNOWN' | 'MODEL_INVALID' | 'FEASIBLE' | 'INFEASIBLE' | 'OPTIMAL';
export type VariableSelectionStrategyName =
  | 'CHOOSE_FIRST' | 'CHOOSE_LOWEST_MIN' | 'CHOOSE_HIGHEST_MAX'
  | 'CHOOSE_MIN_DOMAIN_SIZE' | 'CHOOSE_MAX_DOMAIN_SIZE';
export type DomainReductionStrategyName =
  | 'SELECT_MIN_VALUE' | 'SELECT_MAX_VALUE' | 'SELECT_LOWER_HALF' | 'SELECT_UPPER_HALF'
  | 'SELECT_MEDIAN_VALUE' | 'SELECT_RANDOM_HALF';

export const CpSolverStatus: Readonly<{ [K in CpSolverStatusName]: K }>;
export const VariableSelectionStrategy: Readonly<{ [K in VariableSelectionStrategyName]: K }>;
export const DomainReductionStrategy: Readonly<{ [K in DomainReductionStrategyName]: K }>;

/** A sorted list of disjoint integer intervals. */
export class Domain {
  /** [lb, ub]; empty when lb > ub; ±Infinity means unbounded. */
  constructor(lb: Int, ub: Int);
  static allValues(): Domain;
  static fromValues(values: Int[]): Domain;
  /** [lo, hi] pairs; [v] means [v, v]. */
  static fromIntervals(intervals: Array<[Int, Int] | [Int]>): Domain;
  static fromFlatIntervals(flat: Int[]): Domain;
  /** [lo0, hi0, lo1, hi1, ...], with ±Infinity for the int64 extremes. */
  flattenedIntervals(): Int[];
  isEmpty(): boolean;
  min(): Int;
  max(): Int;
  contains(value: Int): boolean;
  complement(): Domain;
  toString(): string;
}

/** An immutable integer linear expression. */
export class CpLinearExpr {
  plus(other: LinearExprLike): CpLinearExpr;
  minus(other: LinearExprLike): CpLinearExpr;
  times(coefficient: Int): CpLinearExpr;
  neg(): CpLinearExpr;
  le(other: LinearExprLike): BoundedLinearExpr;
  ge(other: LinearExprLike): BoundedLinearExpr;
  lt(other: LinearExprLike): BoundedLinearExpr;
  gt(other: LinearExprLike): BoundedLinearExpr;
  eq(other: LinearExprLike): BoundedLinearExpr;
  ne(other: LinearExprLike): BoundedLinearExpr;
  static sum(exprs: LinearExprLike[]): CpLinearExpr;
  static weightedSum(exprs: LinearExprLike[], coefficients: Int[]): CpLinearExpr;
  static term(expr: LinearExprLike, coefficient: Int): CpLinearExpr;
  static affine(expr: LinearExprLike, coefficient: Int, offset: Int): CpLinearExpr;
  static constant(value: Int): CpLinearExpr;
  toString(): string;
}

/** An integer variable; only valid for the CpModel that created it. */
export class IntVar extends CpLinearExpr {
  private constructor();
  readonly index: number;
  readonly name: string;
  readonly domain: Domain;
  /** True when the domain lies in [0, 1]. */
  readonly isBoolean: boolean;
  /** The negated literal; throws unless isBoolean. */
  not(): NotBooleanVariable;
}

/** not(x) for a Boolean variable x; as an expression it is 1 - x. */
export class NotBooleanVariable extends CpLinearExpr {
  private constructor();
  /** The proto literal, -x.index - 1. */
  readonly index: number;
  not(): IntVar;
}

/** expr ∈ domain; pass it to CpModel.add(). */
export class BoundedLinearExpr {
  private constructor();
  readonly expr: CpLinearExpr;
  readonly domain: Domain;
}

export class CpConstraint {
  private constructor();
  readonly index: number;
  readonly name: string;
  /** Only enforce the constraint when every literal is true. */
  onlyEnforceIf(literals: Literal[]): this;
  onlyEnforceIf(...literals: Literal[]): this;
  withName(name: string): this;
}

export class IntervalVar {
  private constructor();
  readonly index: number;
  readonly name: string;
  startExpr(): CpLinearExpr;
  sizeExpr(): CpLinearExpr;
  endExpr(): CpLinearExpr;
  presenceLiteral(): Literal | null;
}

export class CpModel {
  constructor();
  name: string;

  newIntVar(lb: Int, ub: Int, name?: string): IntVar;
  newIntVarFromDomain(domain: Domain, name?: string): IntVar;
  newBoolVar(name?: string): IntVar;
  newConstant(value: Int): IntVar;

  newIntervalVar(start: LinearExprLike, size: LinearExprLike, end: LinearExprLike, name?: string): IntervalVar;
  newOptionalIntervalVar(
    start: LinearExprLike, size: LinearExprLike, end: LinearExprLike, isPresent: Literal, name?: string): IntervalVar;
  newFixedSizeIntervalVar(start: LinearExprLike, size: Int, name?: string): IntervalVar;
  newOptionalFixedSizeIntervalVar(start: LinearExprLike, size: Int, isPresent: Literal, name?: string): IntervalVar;

  add(constraint: BoundedLinearExpr | boolean): CpConstraint;
  addLinearConstraint(expr: LinearExprLike, lb: Int, ub: Int): CpConstraint;
  addLinearExpressionInDomain(expr: LinearExprLike, domain: Domain): CpConstraint;

  addBoolOr(literals: Literal[]): CpConstraint;
  addBoolOr(...literals: Literal[]): CpConstraint;
  addAtLeastOne(literals: Literal[]): CpConstraint;
  addAtLeastOne(...literals: Literal[]): CpConstraint;
  addAtMostOne(literals: Literal[]): CpConstraint;
  addAtMostOne(...literals: Literal[]): CpConstraint;
  addExactlyOne(literals: Literal[]): CpConstraint;
  addExactlyOne(...literals: Literal[]): CpConstraint;
  addBoolAnd(literals: Literal[]): CpConstraint;
  addBoolAnd(...literals: Literal[]): CpConstraint;
  addBoolXor(literals: Literal[]): CpConstraint;
  addBoolXor(...literals: Literal[]): CpConstraint;
  addImplication(a: Literal, b: Literal): CpConstraint;

  addAllDifferent(expressions: LinearExprLike[]): CpConstraint;
  addAllDifferent(...expressions: LinearExprLike[]): CpConstraint;
  addElement(index: LinearExprLike, expressions: LinearExprLike[], target: LinearExprLike): CpConstraint;
  addCircuit(arcs: Arc[]): CpConstraint;
  addMultipleCircuit(arcs: Arc[]): CpConstraint;
  addAllowedAssignments(expressions: LinearExprLike[], tuples: Int[][]): CpConstraint;
  addForbiddenAssignments(expressions: LinearExprLike[], tuples: Int[][]): CpConstraint;
  /** transitionTriples are [tail state, label, head state]. */
  addAutomaton(
    transitionExpressions: LinearExprLike[], startingState: Int, finalStates: Int[],
    transitionTriples: Array<[Int, Int, Int]>): CpConstraint;
  addInverse(variables: IntVar[], inverseVariables: IntVar[]): CpConstraint;
  addReservoirConstraint(times: LinearExprLike[], levelChanges: LinearExprLike[], minLevel: Int, maxLevel: Int): CpConstraint;
  addReservoirConstraintWithActive(
    times: LinearExprLike[], levelChanges: LinearExprLike[], actives: Literal[], minLevel: Int, maxLevel: Int): CpConstraint;
  addMinEquality(target: LinearExprLike, expressions: LinearExprLike[]): CpConstraint;
  addMaxEquality(target: LinearExprLike, expressions: LinearExprLike[]): CpConstraint;
  addAbsEquality(target: LinearExprLike, expr: LinearExprLike): CpConstraint;
  addMultiplicationEquality(target: LinearExprLike, expressions: LinearExprLike[]): CpConstraint;
  addMultiplicationEquality(target: LinearExprLike, ...expressions: LinearExprLike[]): CpConstraint;
  addDivisionEquality(target: LinearExprLike, numerator: LinearExprLike, denominator: LinearExprLike): CpConstraint;
  addModuloEquality(target: LinearExprLike, expr: LinearExprLike, modulus: LinearExprLike): CpConstraint;

  addNoOverlap(intervals: IntervalVar[]): CpConstraint;
  addNoOverlap2D(xIntervals: IntervalVar[], yIntervals: IntervalVar[]): CpConstraint;
  addCumulative(intervals: IntervalVar[], demands: LinearExprLike[], capacity: LinearExprLike): CpConstraint;

  minimize(expr: LinearExprLike): void;
  maximize(expr: LinearExprLike): void;
  hasObjective(): boolean;
  clearObjective(): void;

  addHint(variable: IntVar | NotBooleanVariable, value: Int | boolean): void;
  clearHints(): void;
  addAssumption(literal: Literal): void;
  addAssumptions(literals: Literal[]): void;
  addAssumptions(...literals: Literal[]): void;
  clearAssumptions(): void;
  addDecisionStrategy(
    variables: Array<IntVar | NotBooleanVariable>, varStrategy: VariableSelectionStrategyName,
    domainStrategy: DomainReductionStrategyName): void;

  /** A copy of the CpModelProto in protobuf's JSON form (int64 fields as strings). */
  toJSON(): Record<string, unknown>;
  /** '' when valid, otherwise OR-Tools' description of the first problem. */
  validate(): string;
  modelStats(): string;
}

/** One solution, passed to onSolution while the search runs. */
export class SolutionSnapshot {
  private constructor();
  readonly objectiveValue: number;
  readonly bestObjectiveBound: number;
  readonly wallTime: number;
  readonly userTime: number;
  readonly deterministicTime: number;
  /** 0 for the first solution of the solve, then 1, 2, ... */
  readonly solutionIndex: number;
  value(expr: LinearExprLike): number;
  booleanValue(literal: Literal): boolean;
}

export interface CpSolveOptions {
  /** Runs on the main thread for each solution; the search waits for it. Throwing stops the search and rejects solve(). */
  onSolution?: (solution: SolutionSnapshot) => void;
}

export class CpSolver {
  constructor();
  parameters: SatParameters;
  /** Solves on the threadpool; resolves to the status name. */
  solve(model: CpModel, options?: CpSolveOptions): Promise<CpSolverStatusName>;
  /** Blocking solve; onSolution is not supported here. */
  solveSync(model: CpModel, options?: { onSolution?: undefined }): CpSolverStatusName;
  /** Stops the running search (also from inside onSolution); false when none is running. */
  stopSearch(): boolean;
  readonly busy: boolean;
  /** Drops the last result; later calls throw. Throws while a solve() is pending. */
  dispose(): void;

  statusName(): CpSolverStatusName;
  /** Throws unless the last solve ended OPTIMAL or FEASIBLE. */
  value(expr: LinearExprLike): number;
  booleanValue(literal: Literal): boolean;
  readonly objectiveValue: number;
  readonly bestObjectiveBound: number;
  readonly wallTime: number;
  readonly userTime: number;
  readonly deterministicTime: number;
  readonly numBooleans: number;
  readonly numBranches: number;
  readonly numConflicts: number;
  responseStats(): string;
  /** The CpSolverResponse in protobuf's JSON form (int64 fields as strings). */
  responseProto(): Record<string, unknown>;
  /** Proto literal indices of assumptions that are infeasible together. */
  sufficientAssumptionsForInfeasibility(): number[];
  solutionInfo(): string;
}
