// The classic constraint programming solver (pywrapcp's Solver).

/** An int64 input: a safe integer, a BigInt, or ±Infinity where a bound may be unlimited. */
export type CpInt = number | bigint;

export type IntVarStrategyName =
  | 'INT_VAR_DEFAULT' | 'INT_VAR_SIMPLE' | 'CHOOSE_FIRST_UNBOUND' | 'CHOOSE_RANDOM'
  | 'CHOOSE_MIN_SIZE_LOWEST_MIN' | 'CHOOSE_MIN_SIZE_HIGHEST_MIN' | 'CHOOSE_MIN_SIZE_LOWEST_MAX'
  | 'CHOOSE_MIN_SIZE_HIGHEST_MAX' | 'CHOOSE_LOWEST_MIN' | 'CHOOSE_HIGHEST_MAX' | 'CHOOSE_MIN_SIZE'
  | 'CHOOSE_MAX_SIZE' | 'CHOOSE_MAX_REGRET_ON_MIN';
export type IntValueStrategyName =
  | 'INT_VALUE_DEFAULT' | 'INT_VALUE_SIMPLE' | 'ASSIGN_MIN_VALUE' | 'ASSIGN_MAX_VALUE'
  | 'ASSIGN_RANDOM_VALUE' | 'ASSIGN_CENTER_VALUE' | 'SPLIT_LOWER_HALF' | 'SPLIT_UPPER_HALF';

export const IntVarStrategy: Readonly<{ [K in IntVarStrategyName]: K }>;
export const IntValueStrategy: Readonly<{ [K in IntValueStrategyName]: K }>;

/** An integer expression; valid only for the CpSolver that created it. */
export class IntExpr {
  protected constructor();
  plus(other: IntExpr | CpInt): IntExpr;
  minus(other: IntExpr | CpInt): IntExpr;
  times(other: IntExpr | CpInt): IntExpr;
  abs(): IntExpr;
  square(): IntExpr;
  opposite(): IntExpr;

  eq(other: IntExpr | CpInt): CpConstraint;
  ne(other: IntExpr | CpInt): CpConstraint;
  le(other: IntExpr | CpInt): CpConstraint;
  lt(other: IntExpr | CpInt): CpConstraint;
  ge(other: IntExpr | CpInt): CpConstraint;
  gt(other: IntExpr | CpInt): CpConstraint;

  min(): number;
  max(): number;
  bound(): boolean;
  /** Outside a search only; an empty domain throws "CP solver failure". */
  setMin(value: CpInt): this;
  setMax(value: CpInt): this;
  setRange(min: CpInt, max: CpInt): this;
  setValue(value: CpInt): this;
  var(): IntVar;
}

export class IntVar extends IntExpr {
  /** The value at a solution; throws when the variable is not bound. */
  value(): number;
  removeValue(value: CpInt): this;
  removeValues(values: ArrayLike<CpInt>): this;
  contains(value: CpInt): boolean;
  size(): number;
  name(): string;
}

export class CpConstraint { protected constructor(); private readonly _brand: 'CpConstraint'; }
export class DecisionBuilder { protected constructor(); private readonly _brand: 'DecisionBuilder'; }
export class SearchMonitor { protected constructor(); private readonly _brandMonitor: 'SearchMonitor'; }

export class SolutionCollector extends SearchMonitor {
  add(vars: IntExpr | IntExpr[]): this;
  addObjective(objective: IntExpr): this;
  solutionCount(): number;
  value(n: number, variable: IntVar): number;
  objectiveValue(n: number): number;
  wallTime(n: number): number;
  branches(n: number): number;
  failures(n: number): number;
}

/** A JS object used as a search monitor by solve() and newSearch(). */
export interface JsSearchMonitor {
  enterSearch?(): void;
  exitSearch?(): void;
  /** Return false to stop the search, true to ask for more solutions. */
  atSolution?(): boolean | void;
}

export interface SearchLimitOptions {
  timeMs?: number;
  branches?: CpInt;
  failures?: CpInt;
  solutions?: CpInt;
  smartTimeCheck?: boolean;
  cumulative?: boolean;
}

export class CpSolver {
  constructor(name?: string);

  intVar(min: CpInt, max: CpInt, name?: string): IntVar;
  intVar(values: ArrayLike<CpInt>, name?: string): IntVar;
  boolVar(name?: string): IntVar;
  intConst(value: CpInt, name?: string): IntVar;

  sum(exprs: IntExpr[]): IntExpr;
  scalProd(vars: IntExpr[], coefficients: ArrayLike<CpInt>): IntExpr;
  min(exprs: IntExpr[]): IntExpr;
  min(a: IntExpr, b: IntExpr | CpInt): IntExpr;
  max(exprs: IntExpr[]): IntExpr;
  max(a: IntExpr, b: IntExpr | CpInt): IntExpr;
  element(values: ArrayLike<CpInt> | IntExpr[], index: IntExpr): IntExpr;

  add(constraint: CpConstraint): void;
  allDifferent(vars: IntExpr[]): CpConstraint;
  allowedAssignments(vars: IntExpr[], tuples: ArrayLike<CpInt>[]): CpConstraint;
  memberCt(expr: IntExpr, values: ArrayLike<CpInt>): CpConstraint;
  notMemberCt(expr: IntExpr, values: ArrayLike<CpInt>): CpConstraint;
  isEqualVar(a: IntExpr, b: IntExpr | CpInt): IntVar;
  isDifferentVar(a: IntExpr, b: IntExpr | CpInt): IntVar;
  isLessOrEqualVar(a: IntExpr, b: IntExpr | CpInt): IntVar;
  isLessVar(a: IntExpr, b: IntExpr | CpInt): IntVar;
  isGreaterOrEqualVar(a: IntExpr, b: IntExpr | CpInt): IntVar;
  isGreaterVar(a: IntExpr, b: IntExpr | CpInt): IntVar;
  isMemberVar(expr: IntExpr, values: ArrayLike<CpInt>): IntVar;

  phase(vars: IntExpr[], varStrategy: IntVarStrategyName, valueStrategy: IntValueStrategyName): DecisionBuilder;
  compose(...dbs: DecisionBuilder[]): DecisionBuilder;
  compose(dbs: DecisionBuilder[]): DecisionBuilder;
  minimize(objective: IntExpr, step?: CpInt): SearchMonitor;
  maximize(objective: IntExpr, step?: CpInt): SearchMonitor;
  limit(options?: SearchLimitOptions): SearchMonitor;
  timeLimit(ms: number): SearchMonitor;
  branchesLimit(branches: CpInt): SearchMonitor;
  failuresLimit(failures: CpInt): SearchMonitor;
  solutionsLimit(solutions: CpInt): SearchMonitor;
  searchLog(period: number, objective?: IntExpr): SearchMonitor;
  firstSolutionCollector(): SolutionCollector;
  lastSolutionCollector(): SolutionCollector;
  bestValueSolutionCollector(maximize: boolean): SolutionCollector;
  allSolutionCollector(): SolutionCollector;

  newSearch(db: DecisionBuilder, monitors?: Array<SearchMonitor | JsSearchMonitor>): void;
  nextSolution(): boolean;
  endSearch(): void;
  solve(db: DecisionBuilder, monitors?: Array<SearchMonitor | JsSearchMonitor>): boolean;
  solveAsync(db: DecisionBuilder, monitors?: SearchMonitor[]): Promise<boolean>;
  interrupt(): boolean;
  readonly busy: boolean;

  wallTime(): number;
  branches(): number;
  failures(): number;
  solutions(): number;
  /** Frees the native solver now; later calls throw. A RoutingModel's solver is freed with the model. */
  dispose(): void;
  [Symbol.dispose](): void;
}
