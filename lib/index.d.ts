/// <reference lib="esnext.disposable" />
export * from './params';
export * from './graph';
export * from './knapsack';
export * as modelBuilder from './model_builder';
export * as mathOpt from './math_opt';
export * as setCover from './set_cover';
export * from './bin_packing';
export * from './sat';

export type Backend =
  | 'GLOP' | 'PDLP' | 'CLP'              // LP
  | 'SCIP' | 'CBC' | 'HIGHS' | 'CP_SAT'  // MIP
  | 'GUROBI' | 'CPLEX' | 'XPRESS' | 'GLPK'
  | (string & {});

export type Status =
  | 'OPTIMAL' | 'FEASIBLE' | 'INFEASIBLE' | 'UNBOUNDED'
  | 'ABNORMAL' | 'MODEL_INVALID' | 'NOT_SOLVED' | 'UNKNOWN';

export class Variable {
  readonly index: number;
  readonly name: string;
  readonly isInteger: boolean;
  value(): number;
  reducedCost(): number;
  setBounds(lb: number, ub: number): this;
}

export class Constraint {
  readonly index: number;
  readonly name: string;
  setCoefficient(v: Variable, coef: number): this;
  setBounds(lb: number, ub: number): this;
  dualValue(): number;
}

export type Term = [Variable, number] | [number, Variable] | Variable;
export type LinearExpr =
  | Variable
  | Term[]
  | Map<Variable, number>
  | { terms: Term[] | Map<Variable, number>; constant?: number };

export class SolveResult {
  readonly status: Status;
  readonly optimal: boolean;
  readonly feasible: boolean;
  readonly objectiveValue: number;
  readonly bestBound: number;
  readonly wallTimeMs: number;
  readonly iterations: number;
  readonly nodes: number;
}

export class Solver {
  constructor(backend?: Backend, name?: string);
  readonly backend: string;
  readonly name: string;

  numVar(lb?: number, ub?: number, name?: string): Variable;
  intVar(lb?: number, ub?: number, name?: string): Variable;
  boolVar(name?: string): Variable;
  readonly variables: Variable[];

  addConstraint(expr: LinearExpr, lb?: number, ub?: number, name?: string): Constraint;
  addLessEq(expr: LinearExpr, rhs: number, name?: string): Constraint;
  addGreaterEq(expr: LinearExpr, rhs: number, name?: string): Constraint;
  addEquality(expr: LinearExpr, rhs: number, name?: string): Constraint;
  readonly constraints: Constraint[];

  minimize(expr: LinearExpr): this;
  maximize(expr: LinearExpr): this;

  setTimeLimit(ms: number): this;
  setNumThreads(n: number): this;
  enableOutput(on?: boolean): this;
  setSolverSpecificParameters(params: string): boolean;

  solve(): Promise<SolveResult>;
  solveSync(): SolveResult;
  /** Stop a pending solve() early; false if none is running or the backend can't be interrupted safely. */
  interrupt(): boolean;
  readonly busy: boolean;

  readonly numVariables: number;
  readonly numConstraints: number;
  solverVersion(): string;
  toLp(obfuscated?: boolean): string;
  toMps(fixed?: boolean, obfuscated?: boolean): string;
  /** Removes everything; existing Variable / Constraint handles become invalid. */
  clear(): this;
  /**
   * Frees the native model now (GC only runs after the event loop turns); later calls throw.
   * During a solve() it never throws: the model is freed once that solve settles.
   */
  dispose(): void;
  /**
   * Same as dispose(), so `using solver = new Solver(...)` frees it at scope exit. A solve()
   * still pending then (`return solver.solve()`) resolves normally, but read variable
   * values with `await solver.solve()` inside the scope: the model is gone afterwards.
   */
  [Symbol.dispose](): void;
}

export function supportsBackend(name: string): boolean;
export const INF: number;
/** Version of the OR-Tools library loaded at runtime, e.g. "9.15.6755". */
export const ortoolsVersion: string;
/** How this addon was built. Loading fails if the runtime OR-Tools differs from ortoolsVersion. */
export const buildInfo: Readonly<{ ortoolsVersion: string; napiVersion: number }>;
export const native: unknown;
