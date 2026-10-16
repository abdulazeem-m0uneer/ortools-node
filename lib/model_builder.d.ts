// Python's ortools.linear_solver.python.model_builder, exported as `modelBuilder`.

export type SolveStatusName =
  | 'OPTIMAL' | 'FEASIBLE' | 'INFEASIBLE' | 'UNBOUNDED' | 'ABNORMAL' | 'NOT_SOLVED' | 'MODEL_IS_VALID'
  | 'CANCELLED_BY_USER' | 'UNKNOWN_STATUS' | 'MODEL_INVALID' | 'INVALID_SOLVER_PARAMETERS'
  | 'SOLVER_TYPE_UNAVAILABLE' | 'INCOMPATIBLE_OPTIONS';

export const SolveStatus: Readonly<{ [K in SolveStatusName]: K }>;

/** Anything usable where an expression is expected. */
export type LinearExprLike = LinearExpr | number;

/** An immutable affine expression: sum(coeff * variable) + constant. */
export class LinearExpr {
  protected constructor();
  static sum(items: readonly LinearExprLike[]): LinearExpr;
  static weightedSum(items: readonly LinearExprLike[], coeffs: readonly number[]): LinearExpr;
  static term(item: LinearExprLike, coeff: number): LinearExpr;
  static affine(item: LinearExprLike, coeff: number, constant: number): LinearExpr;
  static constant(value: number): LinearExpr;
  plus(other: LinearExprLike): LinearExpr;
  minus(other: LinearExprLike): LinearExpr;
  times(coeff: number): LinearExpr;
  neg(): LinearExpr;
  le(rhs: LinearExprLike): BoundedLinearExpression;
  ge(rhs: LinearExprLike): BoundedLinearExpression;
  eq(rhs: LinearExprLike): BoundedLinearExpression;
  readonly constant: number;
  terms(): Array<[Variable, number]>;
  toString(): string;
}

/** lowerBound <= expression <= upperBound; pass it to Model.add(). */
export class BoundedLinearExpression {
  constructor(expr: LinearExprLike, lowerBound: number, upperBound: number);
  readonly expression: LinearExpr;
  readonly lowerBound: number;
  readonly upperBound: number;
}

export class Variable extends LinearExpr {
  private constructor();
  readonly index: number;
  name: string;
  lowerBound: number;
  upperBound: number;
  isIntegral: boolean;
  objectiveCoefficient: number;
}

declare class ConstraintBase {
  protected constructor();
  readonly index: number;
  name: string;
  lowerBound: number;
  upperBound: number;
  setCoefficient(variable: Variable, coeff: number): this;
  addTerm(variable: Variable, coeff: number): this;
  clearTerms(): this;
  terms(): Array<[Variable, number]>;
}

export class LinearConstraint extends ConstraintBase {}

export class EnforcedLinearConstraint extends ConstraintBase {
  indicatorVariable: Variable;
  indicatorValue: boolean;
}

/** MPModelProto in protobuf's JSON form, as Model.exportToProto() returns it. */
export interface MPModelProto {
  name: string;
  maximize: boolean;
  objectiveOffset: number;
  variable: Array<{
    name: string; lowerBound: number; upperBound: number; isInteger: boolean; objectiveCoefficient: number;
  }>;
  constraint: MPConstraintProto[];
  generalConstraint: Array<{
    name: string;
    indicatorConstraint: { varIndex: number; varValue: number; constraint: MPConstraintProto };
  }>;
  solutionHint?: { varIndex: number[]; varValue: number[] };
}

export interface MPConstraintProto {
  name: string;
  lowerBound: number;
  upperBound: number;
  varIndex: number[];
  coefficient: number[];
}

export class Model {
  constructor(name?: string);
  name: string;

  newVar(lowerBound: number, upperBound: number, isIntegral: boolean, name?: string): Variable;
  newNumVar(lowerBound: number, upperBound: number, name?: string): Variable;
  newIntVar(lowerBound: number, upperBound: number, name?: string): Variable;
  newBoolVar(name?: string): Variable;
  readonly numVariables: number;
  getVariables(): Variable[];
  varFromIndex(index: number): Variable;

  addLinearConstraint(expr: LinearExprLike, lowerBound?: number, upperBound?: number, name?: string): LinearConstraint;
  add(bounded: BoundedLinearExpression, name?: string): LinearConstraint;
  addEnforcedLinearConstraint(
    expr: LinearExprLike, indicatorVariable: Variable, indicatorValue: boolean,
    lowerBound?: number, upperBound?: number, name?: string,
  ): EnforcedLinearConstraint;
  addEnforced(
    bounded: BoundedLinearExpression, indicatorVariable: Variable, indicatorValue: boolean, name?: string,
  ): EnforcedLinearConstraint;
  readonly numConstraints: number;
  readonly numEnforcedConstraints: number;
  getLinearConstraints(): LinearConstraint[];
  getEnforcedLinearConstraints(): EnforcedLinearConstraint[];
  linearConstraintFromIndex(index: number): LinearConstraint;
  enforcedLinearConstraintFromIndex(index: number): EnforcedLinearConstraint;

  minimize(expr: LinearExprLike): this;
  maximize(expr: LinearExprLike): this;
  setObjective(expr: LinearExprLike, maximize: boolean): this;
  clearObjective(): this;
  objectiveExpression(): LinearExpr;
  objectiveOffset: number;
  readonly maximizing: boolean;

  addHint(variable: Variable, value: number): this;
  clearHints(): this;

  clone(name?: string): Model;
  exportToProto(): MPModelProto;
  exportToLpString(obfuscate?: boolean): string;
  exportToMpsString(obfuscate?: boolean): string;
  /** OR-Tools' LP parser syntax, e.g. "min: x + 2 y; c1: x + y >= 3; int y;". Existing handles become invalid. */
  importFromLpString(text: string): this;
  importFromMpsString(text: string): this;
}

export class Solver {
  /** Throws for a backend that is unknown or not compiled in; see isSolverSupported(). */
  constructor(solverName: string);
  readonly solverName: string;

  /** Infinity removes the limit. */
  setTimeLimitInSeconds(seconds: number): this;
  setSolverSpecificParameters(parameters: string): this;
  enableOutput(enabled?: boolean): this;

  solve(model: Model): Promise<SolveStatusName>;
  solveSync(model: Model): SolveStatusName;
  /** False if no solve() is running or the backend cannot be interrupted. */
  interrupt(): boolean;
  readonly busy: boolean;

  readonly status: SolveStatusName;
  readonly statusString: string;
  /** Throws unless the last solve ended OPTIMAL or FEASIBLE. */
  readonly objectiveValue: number;
  readonly bestObjectiveBound: number;
  readonly wallTime: number;
  readonly userTime: number;
  value(expr: LinearExprLike): number;
  values(exprs: readonly LinearExprLike[]): number[];
  reducedCost(variable: Variable): number;
  reducedCosts(variables: readonly Variable[]): number[];
  dualValue(constraint: LinearConstraint): number;
  dualValues(constraints: readonly LinearConstraint[]): number[];
  activity(constraint: LinearConstraint): number;
  activities(constraints: readonly LinearConstraint[]): number[];
  /** Idempotent; throws while a solve() is pending; later calls throw. */
  dispose(): void;
  [Symbol.dispose](): void;
}

export function isSolverSupported(solverName: string): boolean;
