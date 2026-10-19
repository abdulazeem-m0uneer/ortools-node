'use strict';

// The classic constraint programming solver (pywrapcp's Solver), with
// camelCase names. The addon works with integer ids; this file wraps them in
// IntExpr / IntVar / CpConstraint / DecisionBuilder / SearchMonitor objects.
//
// A search can be run three ways:
// * solve(db, monitors): synchronous, JS monitors allowed;
// * newSearch / nextSolution / endSearch: synchronous iteration, values are
//   readable at each solution, JS monitors allowed;
// * solveAsync(db, monitors): on the libuv threadpool, results read from
//   solution collectors afterwards; interrupt() stops it.

const native = require('./native');

const VAR_STRATEGIES = Object.freeze([
  'INT_VAR_DEFAULT', 'INT_VAR_SIMPLE', 'CHOOSE_FIRST_UNBOUND', 'CHOOSE_RANDOM',
  'CHOOSE_MIN_SIZE_LOWEST_MIN', 'CHOOSE_MIN_SIZE_HIGHEST_MIN', 'CHOOSE_MIN_SIZE_LOWEST_MAX',
  'CHOOSE_MIN_SIZE_HIGHEST_MAX', 'CHOOSE_LOWEST_MIN', 'CHOOSE_HIGHEST_MAX', 'CHOOSE_MIN_SIZE',
  'CHOOSE_MAX_SIZE', 'CHOOSE_MAX_REGRET_ON_MIN',
]);
const VALUE_STRATEGIES = Object.freeze([
  'INT_VALUE_DEFAULT', 'INT_VALUE_SIMPLE', 'ASSIGN_MIN_VALUE', 'ASSIGN_MAX_VALUE',
  'ASSIGN_RANDOM_VALUE', 'ASSIGN_CENTER_VALUE', 'SPLIT_LOWER_HALF', 'SPLIT_UPPER_HALF',
]);
const enumOf = (names) => Object.freeze(Object.fromEntries(names.map((n) => [n, n])));
/** Variable selection strategies for CpSolver.phase(). */
const IntVarStrategy = enumOf(VAR_STRATEGIES);
/** Value selection strategies for CpSolver.phase(). */
const IntValueStrategy = enumOf(VALUE_STRATEGIES);

const isConstant = (v) => typeof v === 'number' || typeof v === 'bigint';

/** Base of every handle into a CpSolver: valid only for that solver and until it is disposed. */
class CpHandle {
  constructor(solver, id) {
    this._solver = solver;
    this._generation = solver._generation;
    this._id = id;
  }
  /** The id of this handle in `solver`; throws for a foreign or stale handle. */
  _idIn(solver, kind) {
    if (this._solver !== solver) throw new Error(`${kind} belongs to a different CpSolver`);
    if (this._generation !== solver._generation) {
      throw new Error(`${kind} is no longer valid (its CpSolver was disposed)`);
    }
    return this._id;
  }
  _native(kind) {
    this._idIn(this._solver, kind);
    return this._solver._n;
  }
}

/** An integer expression. Comparisons build constraints; add them with solver.add(). */
class IntExpr extends CpHandle {
  plus(other) { return this._binary('plus', other); }
  minus(other) { return this._binary('minus', other); }
  times(other) { return this._binary('times', other); }
  abs() { return this._unary('abs'); }
  square() { return this._unary('square'); }
  /** -expr */
  opposite() { return this._unary('opposite'); }

  eq(other) { return this._solver._compare('eq', this, other); }
  ne(other) { return this._solver._compare('ne', this, other); }
  le(other) { return this._solver._compare('le', this, other); }
  lt(other) { return this._solver._compare('lt', this, other); }
  ge(other) { return this._solver._compare('ge', this, other); }
  gt(other) { return this._solver._compare('gt', this, other); }

  /** Current lower bound of the domain. */
  min() { return this._native('IntExpr').exprMin(this._id); }
  /** Current upper bound of the domain. */
  max() { return this._native('IntExpr').exprMax(this._id); }
  bound() { return this._native('IntExpr').exprBound(this._id); }
  /** Domain changes are allowed outside a search only; an empty domain throws. */
  setMin(value) { this._native('IntExpr').exprSetMin(this._id, value); return this; }
  setMax(value) { this._native('IntExpr').exprSetMax(this._id, value); return this; }
  setRange(min, max) { this._native('IntExpr').exprSetRange(this._id, min, max); return this; }
  setValue(value) { this._native('IntExpr').exprSetValue(this._id, value); return this; }
  /** This expression as a variable (pywrapcp's Var()). */
  var() { return new IntVar(this._solver, this._native('IntExpr').exprToVar(this._id)); }

  _binary(op, other) {
    const n = this._native('IntExpr');
    if (isConstant(other)) return new IntExpr(this._solver, n.binaryConst(op, this._id, other));
    return new IntExpr(this._solver, n.binary(op, this._id, this._solver._exprId(other)));
  }
  _unary(op) {
    return new IntExpr(this._solver, this._native('IntExpr').unary(op, this._id));
  }
}

/** A decision variable. */
class IntVar extends IntExpr {
  /** The value at a solution; throws when the variable is not bound. */
  value() { return this._native('IntVar').varValue(this._id); }
  removeValue(value) { this._native('IntVar').varRemoveValue(this._id, value); return this; }
  removeValues(values) { this._native('IntVar').varRemoveValues(this._id, values); return this; }
  contains(value) { return this._native('IntVar').varContains(this._id, value); }
  size() { return this._native('IntVar').varSize(this._id); }
  name() { return this._native('IntVar').varName(this._id); }
  var() { this._native('IntVar'); return this; }
  toString() { return this.name(); }
}

class CpConstraint extends CpHandle {}
class DecisionBuilder extends CpHandle {}
class SearchMonitor extends CpHandle {}

/** Records solutions found by a search; add the variables to record with add(). */
class SolutionCollector extends SearchMonitor {
  add(vars) {
    const list = Array.isArray(vars) ? vars : [vars];
    this._native('SolutionCollector').collectorAdd(this._id, list.map((v) => this._solver._exprId(v)));
    return this;
  }
  addObjective(objective) {
    this._native('SolutionCollector').collectorAddObjective(this._id, this._solver._exprId(objective));
    return this;
  }
  solutionCount() { return this._native('SolutionCollector').collectorCount(this._id); }
  /** Value of `variable` in solution `n` (0-based). */
  value(n, variable) {
    const n2 = this._native('SolutionCollector');
    if (!(variable instanceof IntVar)) throw new TypeError('value(n, variable): variable must be an IntVar');
    return n2.collectorValue(this._id, n, variable._idIn(this._solver, 'IntVar'));
  }
  objectiveValue(n) { return this._stat('objective', n); }
  wallTime(n) { return this._stat('wallTime', n); }
  branches(n) { return this._stat('branches', n); }
  failures(n) { return this._stat('failures', n); }
  _stat(stat, n) { return this._native('SolutionCollector').collectorStat(this._id, stat, n); }
}

// OR-Tools' SearchMonitor methods, camelCased (kJsHookNames in
// src/constraint_solver/js_monitor_set.cc).
const JS_MONITOR_HOOKS = [
  'enterSearch', 'exitSearch', 'beginNextDecision', 'endNextDecision', 'applyDecision', 'refuteDecision',
  'afterDecision', 'beginFail', 'endFail', 'beginInitialPropagation', 'endInitialPropagation', 'acceptSolution',
  'atSolution', 'noMoreSolutions',
];

function isJsMonitor(m) {
  return m !== null && typeof m === 'object' && !(m instanceof CpHandle) &&
    JS_MONITOR_HOOKS.some((k) => k in m);  // `in` runs no getter: the addon reads each hook once
}

/**
 * Constraint programming solver.
 *
 *   const s = new CpSolver('example');
 *   const x = s.intVar(0, 10, 'x');
 *   s.add(x.plus(3).le(7));
 *   const db = s.phase([x], 'CHOOSE_FIRST_UNBOUND', 'ASSIGN_MAX_VALUE');
 *   s.newSearch(db);
 *   while (s.nextSolution()) console.log(x.value());
 *   s.endSearch();
 */
class CpSolver {
  constructor(name = 'CpSolver') {
    if (typeof name !== 'string') throw new TypeError('new CpSolver(name?: string)');
    this._n = new native.CpSolver(name);
    this._generation = 0;
  }

  /** Wraps the Solver of a native RoutingModel (used by RoutingModel.solver()). */
  static _forRoutingModel(routingNative) {
    const solver = Object.create(CpSolver.prototype);
    solver._n = new native.CpSolver(routingNative);
    solver._generation = 0;
    return solver;
  }

  // ---- variables -------------------------------------------------------------

  /** intVar(min, max, name?) or intVar(values, name?). Bounds may be ±Infinity. */
  intVar(minOrValues, maxOrName, name) {
    if (Array.isArray(minOrValues) || ArrayBuffer.isView(minOrValues)) {
      return new IntVar(this, this._n.intVarFromValues(minOrValues, maxOrName));
    }
    return new IntVar(this, this._n.intVar(minOrValues, maxOrName, name));
  }
  boolVar(name) { return new IntVar(this, this._n.boolVar(name)); }
  intConst(value, name) { return new IntVar(this, this._n.intConst(value, name)); }

  // ---- expressions -----------------------------------------------------------

  sum(exprs) { return new IntExpr(this, this._n.sum(this._exprIds(exprs))); }
  scalProd(vars, coefficients) { return new IntExpr(this, this._n.scalProd(this._exprIds(vars), coefficients)); }
  /** min(a, b) with b an expression or a constant, or min([e1, e2, ...]). */
  min(a, b) { return this._minMax('min', a, b); }
  max(a, b) { return this._minMax('max', a, b); }
  /** values[index] for a constant array, or vars[index] for an array of expressions. */
  element(values, index) {
    const indexId = this._exprId(index);
    if (Array.isArray(values) && values.length > 0 && values.every((v) => v instanceof IntExpr)) {
      return new IntExpr(this, this._n.elementVars(this._exprIds(values), indexId));
    }
    return new IntExpr(this, this._n.elementValues(values, indexId));
  }

  // ---- constraints -----------------------------------------------------------

  /** Posts a constraint (outside a search only). */
  add(constraint) {
    if (!(constraint instanceof CpConstraint)) throw new TypeError('add(constraint): expected a CpConstraint');
    this._n.add(constraint._idIn(this, 'CpConstraint'));
  }
  allDifferent(vars) { return new CpConstraint(this, this._n.allDifferent(this._exprIds(vars))); }
  /** The variables must take one of the given tuples (one value per variable). */
  allowedAssignments(vars, tuples) {
    return new CpConstraint(this, this._n.allowedAssignments(this._exprIds(vars), tuples));
  }
  memberCt(expr, values) { return new CpConstraint(this, this._n.member('member', this._exprId(expr), values)); }
  notMemberCt(expr, values) { return new CpConstraint(this, this._n.member('notMember', this._exprId(expr), values)); }

  // Boolean variables equal to the truth of a comparison.
  isEqualVar(a, b) { return this._isCompare('eq', a, b); }
  isDifferentVar(a, b) { return this._isCompare('ne', a, b); }
  isLessOrEqualVar(a, b) { return this._isCompare('le', a, b); }
  isLessVar(a, b) { return this._isCompare('lt', a, b); }
  isGreaterOrEqualVar(a, b) { return this._isCompare('ge', a, b); }
  isGreaterVar(a, b) { return this._isCompare('gt', a, b); }
  isMemberVar(expr, values) { return new IntVar(this, this._n.member('isMember', this._exprId(expr), values)); }

  // ---- search ------------------------------------------------------------------

  /** A decision builder assigning `vars` with the named strategies (see IntVarStrategy / IntValueStrategy). */
  phase(vars, varStrategy, valueStrategy) {
    return new DecisionBuilder(this, this._n.phase(this._exprIds(vars), varStrategy, valueStrategy));
  }
  compose(...dbs) {
    const list = dbs.length === 1 && Array.isArray(dbs[0]) ? dbs[0] : dbs;
    return new DecisionBuilder(this, this._n.compose(list.map((db) => this._handleId(db, DecisionBuilder))));
  }
  minimize(objective, step = 1) { return new SearchMonitor(this, this._n.optimize(false, this._exprId(objective), step)); }
  maximize(objective, step = 1) { return new SearchMonitor(this, this._n.optimize(true, this._exprId(objective), step)); }

  /** A search limit; every field is optional and unlimited by default. */
  limit({ timeMs = Infinity, branches = Infinity, failures = Infinity, solutions = Infinity,
    smartTimeCheck = false, cumulative = false } = {}) {
    return new SearchMonitor(this, this._n.limit(timeMs, branches, failures, solutions, smartTimeCheck, cumulative));
  }
  timeLimit(ms) { return this.limit({ timeMs: ms }); }
  branchesLimit(branches) { return this.limit({ branches }); }
  failuresLimit(failures) { return this.limit({ failures }); }
  solutionsLimit(solutions) { return this.limit({ solutions }); }
  /** Logs the search progress every `period` branches (absl INFO log). */
  searchLog(period, objective) {
    const id = objective === undefined ? undefined : this._exprId(objective);
    return new SearchMonitor(this, this._n.searchLog(period, id));
  }

  firstSolutionCollector() { return new SolutionCollector(this, this._n.collector('first')); }
  lastSolutionCollector() { return new SolutionCollector(this, this._n.collector('last')); }
  /** Keeps the best solution by the objective set with addObjective(). */
  bestValueSolutionCollector(maximize) {
    if (typeof maximize !== 'boolean') throw new TypeError('bestValueSolutionCollector(maximize: boolean)');
    return new SolutionCollector(this, this._n.collector('best', maximize));
  }
  allSolutionCollector() { return new SolutionCollector(this, this._n.collector('all')); }

  /**
   * Opens a search; call nextSolution() until it returns false, then endSearch().
   * `monitors` may mix SearchMonitor handles and plain objects with any of the
   * JS_MONITOR_HOOKS (atSolution returning false stops the search, true asks
   * to continue; see JsSearchMonitor in cp.d.ts).
   */
  newSearch(db, monitors = []) {
    const [ids, js] = this._splitMonitors(monitors, true);
    this._n.newSearch(this._handleId(db, DecisionBuilder), ids, js);
  }
  nextSolution() { return this._n.nextSolution(); }
  endSearch() { this._n.endSearch(); }
  /** Runs a whole search synchronously; true when a solution was found. */
  solve(db, monitors = []) {
    const [ids, js] = this._splitMonitors(monitors, true);
    return this._n.solve(this._handleId(db, DecisionBuilder), ids, js);
  }
  /** Runs a whole search on the threadpool; read results from solution collectors. */
  solveAsync(db, monitors = []) {
    const [ids] = this._splitMonitors(monitors, false);
    return this._n.solveAsync(this._handleId(db, DecisionBuilder), ids);
  }
  /** Asks the running search to stop; false when none is running. */
  interrupt() { return this._n.interrupt(); }
  get busy() { return this._n.isBusy(); }

  // ---- statistics --------------------------------------------------------------

  wallTime() { return this._n.wallTime(); }
  branches() { return this._n.branches(); }
  failures() { return this._n.failures(); }
  solutions() { return this._n.solutions(); }

  /**
   * Frees the native solver now (GC only runs after the event loop turns).
   * Later calls throw. Idempotent; throws while a search is running or open.
   * A RoutingModel's solver is freed by disposing the model.
   */
  dispose() {
    this._n.dispose();
    this._generation++;
  }

  // ---- internals ---------------------------------------------------------------

  _wrapVar(id) { return new IntVar(this, id); }
  _exprId(expr) {
    if (!(expr instanceof IntExpr)) throw new TypeError('expected an IntExpr or IntVar of this CpSolver');
    return expr._idIn(this, 'IntExpr');
  }
  _exprIds(exprs) {
    if (!Array.isArray(exprs)) throw new TypeError('expected an array of IntExpr');
    return exprs.map((e) => this._exprId(e));
  }
  _handleId(handle, type) {
    if (!(handle instanceof type)) throw new TypeError(`expected a ${type.name} of this CpSolver`);
    return handle._idIn(this, type.name);
  }
  _compare(op, a, b) {
    const left = this._exprId(a);
    if (isConstant(b)) return new CpConstraint(this, this._n.compareConst(op, left, b));
    return new CpConstraint(this, this._n.compare(op, left, this._exprId(b)));
  }
  _isCompare(op, a, b) {
    const left = this._exprId(a);
    if (isConstant(b)) return new IntVar(this, this._n.isCompareConstVar(op, left, b));
    return new IntVar(this, this._n.isCompareVar(op, left, this._exprId(b)));
  }
  _minMax(op, a, b) {
    if (Array.isArray(a)) {
      if (b !== undefined) throw new TypeError(`${op}(exprs[]) takes a single array`);
      return new IntExpr(this, this._n.minMaxArray(op === 'max', this._exprIds(a)));
    }
    const left = this._exprId(a);
    if (isConstant(b)) return new IntExpr(this, this._n.binaryConst(op, left, b));
    return new IntExpr(this, this._n.binary(op, left, this._exprId(b)));
  }
  _splitMonitors(monitors, allowJs) {
    if (!Array.isArray(monitors)) throw new TypeError('monitors must be an array');
    const ids = [];
    const js = [];
    for (const m of monitors) {
      if (m instanceof SearchMonitor) ids.push(m._idIn(this, 'SearchMonitor'));
      else if (isJsMonitor(m)) {
        if (!allowJs) throw new TypeError('JS search monitors run only in solve() and newSearch(), not solveAsync()');
        js.push(m);
      } else throw new TypeError('a monitor must be a SearchMonitor or an object with search monitor hooks (atSolution, beginFail, ...)');
    }
    return [ids, js];
  }
}

if (typeof Symbol.dispose === 'symbol') CpSolver.prototype[Symbol.dispose] = CpSolver.prototype.dispose;

module.exports = {
  CpSolver,
  IntExpr,
  IntVar,
  CpConstraint,
  DecisionBuilder,
  SearchMonitor,
  SolutionCollector,
  IntVarStrategy,
  IntValueStrategy,
};
