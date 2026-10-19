'use strict';

// Linear and mixed-integer models (MPSolver).  The addon works with integer
// indices; this file wraps them in Variable / Constraint objects and offers a
// linear-expression helper so models read naturally.

const native = require('./native');

const INF = Infinity;

/**
 * Native handles are plain indices, so a Variable or Constraint is only valid
 * for the solver that created it and only until its next clear() or dispose().
 */
function assertOwnedBy(handle, solver, kind) {
  if (handle._solver !== solver) {
    throw new Error(`${kind} '${handle.name}' belongs to a different Solver`);
  }
  if (handle._generation !== solver._generation) {
    throw new Error(`${kind} '${handle.name}' is no longer valid (Solver.clear() or dispose() was called)`);
  }
}

/** A decision variable. */
class Variable {
  constructor(solver, index, name, isInteger) {
    this._solver = solver;
    this._generation = solver._generation;
    this.index = index;
    this.name = name;
    this.isInteger = isInteger;
  }
  /** Solution value after a solve that ended OPTIMAL or FEASIBLE. */
  value() {
    return this._native().variableValue(this.index);
  }
  /** Reduced cost (LP backends only). */
  reducedCost() {
    return this._native().reducedCost(this.index);
  }
  setBounds(lb, ub) {
    this._native().setVariableBounds(this.index, lb, ub);
    return this;
  }
  _native() {
    assertOwnedBy(this, this._solver, 'Variable');
    return this._solver._n;
  }
  toString() {
    return this.name;
  }
}

/** A linear (row) constraint  lb <= Σ coef·var <= ub. */
class Constraint {
  constructor(solver, index, name) {
    this._solver = solver;
    this._generation = solver._generation;
    this.index = index;
    this.name = name;
  }
  setCoefficient(variable, coef) {
    const n = this._native();
    if (!(variable instanceof Variable)) throw new TypeError('Expected a Variable');
    assertOwnedBy(variable, this._solver, 'Variable');
    n.setConstraintCoefficient(this.index, variable.index, coef);
    return this;
  }
  setBounds(lb, ub) {
    this._native().setConstraintBounds(this.index, lb, ub);
    return this;
  }
  /** Dual value (LP backends only). */
  dualValue() {
    return this._native().dualValue(this.index);
  }
  _native() {
    assertOwnedBy(this, this._solver, 'Constraint');
    return this._solver._n;
  }
  toString() {
    return this.name;
  }
}

/**
 * Normalise the many ways to spell a linear expression into
 * { terms: Map<Variable, number>, constant: number }.
 *
 * Accepted:
 *   [[x, 3], [y, 4]]              array of [variable, coef] pairs
 *   [[3, x], [4, y]]              array of [coef, variable] pairs
 *   new Map([[x, 3], [y, 4]])     Map<Variable, number>
 *   x                             a bare Variable (coef 1)
 *   { terms: [...], constant: 5 } explicit form
 */
function normaliseExpr(expr, solver) {
  const terms = new Map();
  let constant = 0;

  const add = (v, c) => {
    if (!(v instanceof Variable)) throw new TypeError('Expected a Variable in linear expression');
    // Validate up front: the native calls that follow must not fail half-way.
    if (!Number.isFinite(c)) throw new TypeError('Expected a finite numeric coefficient');
    assertOwnedBy(v, solver, 'Variable');
    const sum = (terms.get(v) || 0) + c;
    if (!Number.isFinite(sum)) throw new TypeError(`Coefficient of '${v.name}' overflows`);
    terms.set(v, sum);
  };

  if (expr instanceof Variable) {
    add(expr, 1);
  } else if (expr instanceof Map) {
    for (const [v, c] of expr) add(v, c);
  } else if (Array.isArray(expr)) {
    for (const t of expr) {
      if (t instanceof Variable) add(t, 1);
      else if (Array.isArray(t) && t.length === 2) {
        if (t[0] instanceof Variable) add(t[0], t[1]);
        else add(t[1], t[0]);
      } else throw new TypeError('Bad term in linear expression: ' + String(t));
    }
  } else if (expr && typeof expr === 'object' && expr.terms) {
    const inner = normaliseExpr(expr.terms, solver);
    for (const [v, c] of inner.terms) add(v, c);
    constant = expr.constant ?? 0;
    if (!Number.isFinite(constant)) throw new TypeError('Expected a finite numeric constant');
  } else {
    throw new TypeError('Unrecognised linear expression');
  }
  return { terms, constant };
}

/** Result of a solve. */
class SolveResult {
  constructor(solver, status) {
    this.status = status;
    this.optimal = status === 'OPTIMAL';
    this.feasible = status === 'OPTIMAL' || status === 'FEASIBLE';
    if (this.feasible) {
      this.objectiveValue = solver._n.objectiveValue();
      this.bestBound = solver._n.bestBound();
      this.wallTimeMs = solver._n.wallTime();
      this.iterations = solver._n.iterations();
      this.nodes = solver._n.nodes();
    } else {
      this.objectiveValue = NaN;
      this.bestBound = NaN;
      this.wallTimeMs = solver._n.wallTime();
      this.iterations = 0;
      this.nodes = 0;
    }
  }
}

/**
 * Linear / mixed-integer solver.
 *
 *   const s = new Solver('GLOP');          // LP
 *   const s = new Solver('SCIP');          // MIP
 *   const s = new Solver('CP_SAT');        // MIP via CP-SAT (integer vars only)
 *   const s = new Solver('CBC'), 'HIGHS', 'PDLP', 'GUROBI' ... depending on your OR-Tools build
 */
class Solver {
  constructor(backend = 'GLOP', name = 'ortools-node') {
    this._n = new native.Solver(backend, name);
    this.backend = backend;
    this.name = name;
    this._vars = [];
    this._cts = [];
    this._generation = 0;  // bumped by clear() to invalidate old handles
    this._disposeWhenSettled = false;  // dispose() was called during a solve()
  }

  // ---- variables -----------------------------------------------------------

  numVar(lb = -INF, ub = INF, name) {
    return this._addVar(lb, ub, false, name);
  }
  intVar(lb = -INF, ub = INF, name) {
    return this._addVar(lb, ub, true, name);
  }
  boolVar(name) {
    return this._addVar(0, 1, true, name);
  }
  _addVar(lb, ub, isInteger, name) {
    if (!name) name = `${isInteger ? 'i' : 'x'}${this._vars.length}`;
    const idx = this._n.addVariable(lb, ub, isInteger, name);
    const v = new Variable(this, idx, name, isInteger);
    this._vars.push(v);
    return v;
  }
  get variables() {
    return this._vars.slice();
  }

  // ---- constraints ---------------------------------------------------------

  /**
   * addConstraint(expr, lb, ub, name?)  →  lb <= expr <= ub
   * Any constant inside expr is moved to the bounds.
   */
  addConstraint(expr, lb = -INF, ub = INF, name) {
    // `null - constant` would silently become 0, so require real numbers.
    if (typeof lb !== 'number' || typeof ub !== 'number') {
      throw new TypeError('Constraint bounds must be numbers');
    }
    const { terms, constant } = normaliseExpr(expr, this);
    if (!name) name = `c${this._cts.length}`;
    const idx = this._n.addConstraint(lb - constant, ub - constant, name);
    const c = new Constraint(this, idx, name);
    for (const [v, coef] of terms) this._n.setConstraintCoefficient(idx, v.index, coef);
    this._cts.push(c);
    return c;
  }
  /** expr <= rhs */
  addLessEq(expr, rhs, name) {
    return this.addConstraint(expr, -INF, rhs, name);
  }
  /** expr >= rhs */
  addGreaterEq(expr, rhs, name) {
    return this.addConstraint(expr, rhs, INF, name);
  }
  /** expr == rhs */
  addEquality(expr, rhs, name) {
    return this.addConstraint(expr, rhs, rhs, name);
  }
  get constraints() {
    return this._cts.slice();
  }

  // ---- objective -----------------------------------------------------------

  minimize(expr) {
    return this._setObjective(expr, false);
  }
  maximize(expr) {
    return this._setObjective(expr, true);
  }
  _setObjective(expr, maximize) {
    const { terms, constant } = normaliseExpr(expr, this);
    this._n.clearObjective();
    for (const [v, coef] of terms) this._n.setObjectiveCoefficient(v.index, coef);
    this._n.setObjectiveOffset(constant);
    this._n.setObjectiveSense(maximize);
    return this;
  }

  // ---- parameters ----------------------------------------------------------

  /** Wall-clock limit in milliseconds (0 = unlimited). */
  setTimeLimit(ms) {
    this._n.setTimeLimit(ms);
    return this;
  }
  setNumThreads(n) {
    this._n.setNumThreads(n);
    return this;
  }
  enableOutput(on = true) {
    this._n.enableOutput(on);
    return this;
  }
  /** Backend-specific parameter string (e.g. SCIP "limits/gap = 0.01"). */
  setSolverSpecificParameters(params) {
    return this._n.setSolverSpecificParameters(params);
  }

  // ---- solving -------------------------------------------------------------

  /** Solve off the main thread. Resolves to a SolveResult. */
  async solve() {
    try {
      const status = await this._n.solve();
      return new SolveResult(this, status);
    } finally {
      if (this._disposeWhenSettled) this.dispose();
    }
  }
  /** Blocking solve (handy in scripts / tests). */
  solveSync() {
    const status = this._n.solveSync();
    return new SolveResult(this, status);
  }
  /**
   * Ask a pending solve() to stop early; it then resolves with the best status
   * reached. Returns false when nothing is running or the backend cannot be
   * interrupted safely (only GLOP, PDLP, CP_SAT and Gurobi can).
   */
  interrupt() {
    return this._n.interrupt();
  }
  get busy() {
    return this._n.isBusy();
  }

  // ---- introspection -------------------------------------------------------

  get numVariables() {
    return this._n.numVariables();
  }
  get numConstraints() {
    return this._n.numConstraints();
  }
  solverVersion() {
    return this._n.solverVersion();
  }
  /** Export model as LP text — great for debugging. */
  toLp(obfuscated = false) {
    return this._n.exportModelAsLpFormat(obfuscated);
  }
  toMps(fixed = false, obfuscated = false) {
    return this._n.exportModelAsMpsFormat(fixed, obfuscated);
  }
  /** Remove all variables and constraints; existing handles become invalid. */
  clear() {
    this._n.clear();
    this._forgetHandles();
    return this;
  }
  /**
   * Free the native model now instead of at garbage collection, which Node only
   * runs after the event loop turns: a synchronous loop that never yields keeps
   * every Solver it created alive until it ends. Any later call throws.
   * Idempotent. During a solve() the model is freed once that solve settles,
   * after its SolveResult is built; until then calls still throw "busy".
   */
  dispose() {
    if (this._n.isBusy()) {
      this._disposeWhenSettled = true;
      return;
    }
    this._n.dispose();
    this._forgetHandles();
  }
  _forgetHandles() {
    this._vars = [];
    this._cts = [];
    this._generation++;
  }
}

// `using s = new Solver(...)` (explicit resource management) disposes on scope exit.
if (typeof Symbol.dispose === 'symbol') Solver.prototype[Symbol.dispose] = Solver.prototype.dispose;

/** Is a given backend compiled into your OR-Tools build? */
function supportsBackend(name) {
  return native.supportsProblemType(name);
}

module.exports = {
  Solver,
  Variable,
  Constraint,
  SolveResult,
  supportsBackend,
  INF,
};
