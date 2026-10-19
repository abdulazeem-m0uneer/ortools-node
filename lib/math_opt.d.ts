// Python's ortools.math_opt.python.mathopt, exported as `mathOpt`.
import { BoundedLinearExpression, LinearExpr, LinearExprLike, VariableBase } from './linear_expr';

export { BoundedLinearExpression, LinearExpr, LinearExprLike };

export type SolverTypeName =
  | 'GSCIP' | 'GUROBI' | 'GLOP' | 'CP_SAT' | 'PDLP' | 'GLPK' | 'OSQP' | 'ECOS' | 'SCS' | 'HIGHS' | 'SANTORINI' | 'XPRESS';
export type TerminationReasonName =
  | 'OPTIMAL' | 'INFEASIBLE' | 'UNBOUNDED' | 'INFEASIBLE_OR_UNBOUNDED' | 'IMPRECISE' | 'FEASIBLE'
  | 'NO_SOLUTION_FOUND' | 'NUMERICAL_ERROR' | 'OTHER_ERROR';
export type LimitName =
  | 'UNSPECIFIED' | 'UNDETERMINED' | 'ITERATION' | 'TIME' | 'NODE' | 'SOLUTION' | 'MEMORY' | 'CUTOFF'
  | 'OBJECTIVE' | 'NORM' | 'INTERRUPTED' | 'SLOW_PROGRESS' | 'OTHER';
export type FeasibilityStatusName = 'UNSPECIFIED' | 'UNDETERMINED' | 'FEASIBLE' | 'INFEASIBLE';
export type LPAlgorithmName = 'PRIMAL_SIMPLEX' | 'DUAL_SIMPLEX' | 'BARRIER' | 'FIRST_ORDER';
export type EmphasisName = 'OFF' | 'LOW' | 'MEDIUM' | 'HIGH' | 'VERY_HIGH';

/** Solver types compiled into this build and usable here. */
export const SolverType: Readonly<Partial<{ [K in SolverTypeName]: K }>>;
export const TerminationReason: Readonly<{ [K in TerminationReasonName]: K }>;
export const Limit: Readonly<Partial<{ [K in LimitName]: K }>>;
export const FeasibilityStatus: Readonly<Partial<{ [K in FeasibilityStatusName]: K }>>;
export const LPAlgorithm: Readonly<{ [K in LPAlgorithmName]: K }>;
export const Emphasis: Readonly<{ [K in EmphasisName]: K }>;

export class Variable extends VariableBase {
  private constructor();
  readonly id: number;
  name: string;
  lowerBound: number;
  upperBound: number;
  integer: boolean;
}

export class LinearConstraint {
  private constructor();
  readonly id: number;
  name: string;
  lowerBound: number;
  upperBound: number;
  /** 0 removes the variable from the constraint. */
  setCoefficient(variable: Variable, coeff: number): this;
  getCoefficient(variable: Variable): number;
  terms(): Array<[Variable, number]>;
}

export interface VariableOptions {
  lb?: number;
  ub?: number;
  isInteger?: boolean;
  name?: string;
}

export interface LinearConstraintOptions {
  lb?: number;
  ub?: number;
  expr?: LinearExprLike;
  name?: string;
}

/** MathOpt ModelProto in protobuf's JSON form, as Model.exportModel() returns it. */
export interface ModelProto {
  name: string;
  variables: { ids: number[]; lowerBounds: number[]; upperBounds: number[]; integers: boolean[]; names: string[] };
  objective: { maximize: boolean; offset: number; linearCoefficients: { ids: number[]; values: number[] } };
  linearConstraints: { ids: number[]; lowerBounds: number[]; upperBounds: number[]; names: string[] };
  linearConstraintMatrix: { rowIds: number[]; columnIds: number[]; coefficients: number[] };
}

export class Model {
  constructor(name?: string);
  name: string;

  addVariable(options?: VariableOptions): Variable;
  addIntegerVariable(options?: Omit<VariableOptions, 'isInteger'>): Variable;
  addBinaryVariable(options?: { name?: string }): Variable;
  /** Also removes it from every constraint and the objective; its handle becomes invalid. */
  deleteVariable(variable: Variable): void;
  readonly numVariables: number;
  variables(): Variable[];
  getVariable(id: number): Variable;

  addLinearConstraint(bounded: BoundedLinearExpression, name?: string): LinearConstraint;
  addLinearConstraint(options?: LinearConstraintOptions): LinearConstraint;
  deleteLinearConstraint(constraint: LinearConstraint): void;
  readonly numLinearConstraints: number;
  linearConstraints(): LinearConstraint[];
  getLinearConstraint(id: number): LinearConstraint;

  minimize(expr: LinearExprLike): this;
  maximize(expr: LinearExprLike): this;
  setObjective(expr: LinearExprLike, isMaximize: boolean): this;
  isMaximize: boolean;
  objectiveOffset: number;
  objectiveCoefficient(variable: Variable): number;
  setObjectiveCoefficient(variable: Variable, coeff: number): this;
  objectiveExpression(): LinearExpr;

  exportModel(): ModelProto;
}

/** SolveParametersProto fields; a few accept friendlier values. Unknown fields throw. */
export interface SolveParameters {
  /** Seconds (Infinity: none), or a protobuf Duration string such as "1.5s". */
  timeLimit?: number | string;
  iterationLimit?: number;
  nodeLimit?: number;
  cutoffLimit?: number;
  objectiveLimit?: number;
  bestBoundLimit?: number;
  solutionLimit?: number;
  enableOutput?: boolean;
  threads?: number;
  randomSeed?: number;
  absoluteGapTolerance?: number;
  relativeGapTolerance?: number;
  solutionPoolSize?: number;
  lpAlgorithm?: LPAlgorithmName | `LP_ALGORITHM_${LPAlgorithmName}`;
  presolve?: EmphasisName | `EMPHASIS_${EmphasisName}`;
  cuts?: EmphasisName | `EMPHASIS_${EmphasisName}`;
  heuristics?: EmphasisName | `EMPHASIS_${EmphasisName}`;
  scaling?: EmphasisName | `EMPHASIS_${EmphasisName}`;
  /** Solver-specific messages (gscip, glop, cpSat, pdlp, highs...) in proto JSON form. */
  [field: string]: unknown;
}

/** ModelSolveParametersProto fields; hints and priorities may be keyed by Variable. */
export interface ModelSolveParameters {
  solutionHints?: Array<Map<Variable, number> | object>;
  branchingPriorities?: Map<Variable, number> | object;
  [field: string]: unknown;
}

export interface SolveOptions {
  parameters?: SolveParameters;
  modelParameters?: ModelSolveParameters;
  interrupter?: SolveInterrupter;
}

/**
 * Stops the solves it was passed to; once interrupted it stays interrupted.
 * HiGHS ignores it (the solve runs to its own limits).
 */
export class SolveInterrupter {
  constructor();
  interrupt(): void;
  readonly interrupted: boolean;
}

export class SolveResult {
  private constructor();
  readonly termination: Readonly<{
    reason: TerminationReasonName;
    limit: LimitName;
    detail: string;
    problemStatus: Readonly<{
      primalStatus: FeasibilityStatusName;
      dualStatus: FeasibilityStatusName;
      primalOrDualInfeasible: boolean;
    }>;
    objectiveBounds: Readonly<{ primalBound: number; dualBound: number }>;
  }>;
  readonly solveStats: Readonly<{
    solveTime: number;
    simplexIterations: number;
    barrierIterations: number;
    firstOrderIterations: number;
    nodeCount: number;
  }>;
  /** The SolveResultProto as MathOpt returned it (protobuf JSON). */
  readonly proto: unknown;
  hasPrimalFeasibleSolution(): boolean;
  hasDualFeasibleSolution(): boolean;
  /** Throws without a primal feasible solution. */
  objectiveValue(): number;
  bestObjectiveBound(): number;
  /** Seconds. */
  solveTime(): number;
  variableValues(variable: Variable): number;
  variableValues(variables: readonly Variable[]): number[];
  variableValues(): Map<Variable, number>;
  reducedCosts(variable: Variable): number;
  reducedCosts(variables: readonly Variable[]): number[];
  reducedCosts(): Map<Variable, number>;
  dualValues(constraint: LinearConstraint): number;
  dualValues(constraints: readonly LinearConstraint[]): number[];
  dualValues(): Map<LinearConstraint, number>;
}

/** Solves off the main thread. The model may change while it runs. */
export function solve(model: Model, solverType: SolverTypeName, options?: SolveOptions): Promise<SolveResult>;
export function solveSync(model: Model, solverType: SolverTypeName, options?: Omit<SolveOptions, 'interrupter'>): SolveResult;
