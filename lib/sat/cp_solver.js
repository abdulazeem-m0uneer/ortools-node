'use strict';

// CpSolver solves a CpModel with CP-SAT (cp_model.CpSolver's equivalent):
// solve() runs on the libuv threadpool, solveSync() blocks. Accessors read the
// last solve; values throw unless it found a solution, never a stale 0.

const native = require('../native');
const { satParametersJson } = require('../params');
const { CpModel } = require('./cp_model');
const { toInt, fromBigInt } = require('./int');
const { CpLinearExpr, IntVar, NotBooleanVariable, flatten, describe } = require('./linear_expr');

// Native solvers with a solve() in flight. When the process exits (process.exit(),
// an uncaught exception...), JS never runs again: abandon() stops each search
// and releases solver threads waiting for onSolution, so the exit is not held
// up by the libuv threadpool.
const running = new Set();
process.on('exit', () => {
  for (const n of running) n.abandon();
});

// Doubles in protobuf JSON: numbers, or "Infinity" / "-Infinity" / "NaN" strings.
// A field left at its default may be omitted.
function toDouble(value) {
  return value === undefined ? 0 : Number(value);
}

// int64 counters print as decimal strings.
function toCount(value) {
  return value === undefined ? 0 : Number(value);
}

/** Variable `v` of the solved `model` as an index into `values`. */
function solvedIndex(model, values, v, what) {
  if (v._model !== model) throw new Error(`${what} '${v}' belongs to a different CpModel than the one solved`);
  if (v.index >= values.length) throw new Error(`${what} '${v}' was created after the solve`);
  return v.index;
}

/**
 * The value of an expression in a solution (Float64Array of safe integers, or
 * BigInt64Array): a number when it is a safe integer, otherwise a BigInt.
 */
function evaluate(model, values, expr) {
  if (typeof expr === 'number' || typeof expr === 'bigint') return toInt(expr, 'value');
  if (!(expr instanceof CpLinearExpr)) {
    throw new TypeError(`value(expr): expected a linear expression or an integer, got ${describe(expr)}`);
  }
  const { vars, coeffs, offset } = flatten(expr);
  const indices = vars.map((v) => solvedIndex(model, values, v, 'Variable'));
  if (values instanceof Float64Array && typeof offset === 'number') {
    // Exact while every step stays a safe integer; otherwise redo it in BigInt.
    let sum = offset;
    let exact = true;
    for (let i = 0; i < indices.length && exact; ++i) {
      const c = coeffs[i];
      const term = typeof c === 'number' ? c * values[indices[i]] : NaN;
      sum += term;
      exact = Number.isSafeInteger(term) && Number.isSafeInteger(sum);
    }
    if (exact) return sum === 0 ? 0 : sum;
  }
  let sum = BigInt(offset);
  for (let i = 0; i < indices.length; ++i) sum += BigInt(coeffs[i]) * BigInt(values[indices[i]]);
  return fromBigInt(sum, 'value');
}

function evaluateLiteral(model, values, literal) {
  if (typeof literal === 'boolean') return literal;
  if (literal instanceof IntVar) {
    if (!literal.isBoolean) throw new TypeError(`booleanValue(literal): '${literal}' is not a Boolean variable`);
    return Number(values[solvedIndex(model, values, literal, 'Literal')]) !== 0;
  }
  if (literal instanceof NotBooleanVariable) return !evaluateLiteral(model, values, literal.not());
  throw new TypeError(`booleanValue(literal): expected a Boolean variable, its not() or a boolean, got ${describe(literal)}`);
}

/** One solution found during the search, passed to solve()'s onSolution callback. */
class SolutionSnapshot {
  constructor(model, raw) {
    this._model = model;
    this._values = raw.values;
    this.objectiveValue = raw.objectiveValue;
    this.bestObjectiveBound = raw.bestObjectiveBound;
    this.wallTime = raw.wallTime;
    this.userTime = raw.userTime;
    this.deterministicTime = raw.deterministicTime;
    /** 0 for the first solution of the solve, then 1, 2, ... */
    this.solutionIndex = raw.solutionIndex;
    Object.freeze(this);
  }
  value(expr) {
    return evaluate(this._model, this._values, expr);
  }
  booleanValue(literal) {
    return evaluateLiteral(this._model, this._values, literal);
  }
}

class CpSolver {
  constructor() {
    /** SatParameters as a plain object, e.g. { maxTimeInSeconds: 10, numWorkers: 8 }. */
    this.parameters = {};
    this._n = new native.CpSatSolver();
    this._last = null;  // { model, status, response, responseJson, values, hasObjective }
    this._disposed = false;
  }

  /**
   * Solves on the libuv threadpool; resolves to the status name. With
   * onSolution, each solution found is passed as a SolutionSnapshot while the
   * search runs; if the callback throws, the search stops and the Promise
   * rejects with that exception. Rejects on an invalid model or parameters.
   */
  async solve(model, options) {
    const { modelJson, paramsJson, onSolution, hasObjective } = this._prepare(model, options);
    const callback = onSolution && ((raw) => onSolution(new SolutionSnapshot(model, raw)));
    const n = this._n;
    const pending = n.solve(modelJson, paramsJson, callback);
    this._last = null;
    running.add(n);
    try {
      return this._record(model, hasObjective, await pending);
    } finally {
      running.delete(n);
    }
  }

  /** Blocking solve; returns the status name. Solution callbacks need solve(). */
  solveSync(model, options) {
    const { modelJson, paramsJson, onSolution, hasObjective } = this._prepare(model, options);
    if (onSolution) throw new TypeError('onSolution needs solve(): solveSync() cannot call into JS during the search');
    return this._record(model, hasObjective, this._n.solveSync(modelJson, paramsJson));
  }

  /** Stops the running search (also from inside onSolution); false when nothing runs. */
  stopSearch() {
    return !this._disposed && this._n.stopSearch();
  }

  get busy() {
    return !this._disposed && this._n.isBusy();
  }

  /**
   * Drops the last result. Later solves and result reads throw; stopSearch()
   * returns false and busy is false (nothing can run). Idempotent; throws
   * while a solve() is pending.
   */
  dispose() {
    if (this._disposed) return;
    if (this._n.isBusy()) throw new Error('CpSolver is busy: a solve() is in progress');
    this._disposed = true;
    this._last = null;
  }

  // ---- results -------------------------------------------------------------

  /** OPTIMAL, FEASIBLE, INFEASIBLE, MODEL_INVALID or UNKNOWN. */
  statusName() {
    return this._solved().status;
  }
  value(expr) {
    const last = this._withSolution('value()');
    return evaluate(last.model, last.values, expr);
  }
  booleanValue(literal) {
    const last = this._withSolution('booleanValue()');
    return evaluateLiteral(last.model, last.values, literal);
  }
  get objectiveValue() {
    return toDouble(this._withSolution('objectiveValue').response.objectiveValue);
  }
  get bestObjectiveBound() {
    const last = this._solved();
    if (last.status === 'INFEASIBLE' || last.status === 'MODEL_INVALID') {
      throw new Error(`No objective bound: the last solve ended ${last.status}`);
    }
    return toDouble(last.response.bestObjectiveBound);
  }
  get wallTime() {
    return toDouble(this._solved().response.wallTime);
  }
  get userTime() {
    return toDouble(this._solved().response.userTime);
  }
  get deterministicTime() {
    return toDouble(this._solved().response.deterministicTime);
  }
  get numBooleans() {
    return toCount(this._solved().response.numBooleans);
  }
  get numBranches() {
    return toCount(this._solved().response.numBranches);
  }
  get numConflicts() {
    return toCount(this._solved().response.numConflicts);
  }
  /** OR-Tools' statistics about the last solve. */
  responseStats() {
    const last = this._solved();
    return native.cpSolverResponseStats(last.responseJson, last.hasObjective);
  }
  /** The CpSolverResponse in protobuf's JSON form (int64 fields as strings). */
  responseProto() {
    const last = this._solved();
    const proto = JSON.parse(last.responseJson);
    proto.solution = Array.from(last.values, String);
    return proto;
  }
  /** Proto indices of assumption literals that are infeasible together (after an INFEASIBLE solve). */
  sufficientAssumptionsForInfeasibility() {
    return (this._solved().response.sufficientAssumptionsForInfeasibility ?? []).slice();
  }
  solutionInfo() {
    return this._solved().response.solutionInfo ?? '';
  }

  // ---- internals -----------------------------------------------------------

  // Reads every argument first: getters on options or parameters may run user
  // code (even dispose() or solve() on this solver), so the lifecycle checks
  // come after, here for dispose() and natively for busy.
  _prepare(model, options = {}) {
    if (!(model instanceof CpModel)) throw new TypeError(`Expected a CpModel, got ${describe(model)}`);
    if (options === null || typeof options !== 'object') throw new TypeError('solve options must be an object');
    const { onSolution } = options;
    if (onSolution !== undefined && typeof onSolution !== 'function') {
      throw new TypeError('onSolution must be a function');
    }
    const prepared = {
      paramsJson: satParametersJson(this.parameters),
      modelJson: model._json(),
      hasObjective: model.hasObjective(),
      onSolution,
    };
    this._checkUsable();
    return prepared;
  }

  _record(model, hasObjective, raw) {
    const response = JSON.parse(raw.response);
    const status = response.status ?? 'UNKNOWN';  // proto3 JSON may omit the default
    this._last = {
      model,
      status,
      response,
      responseJson: raw.response,
      values: raw.solution,
      hasObjective,
    };
    return status;
  }

  _checkUsable() {
    if (this._disposed) throw new Error('CpSolver has been disposed');
  }

  _solved() {
    this._checkUsable();
    if (this._n.isBusy()) throw new Error('CpSolver is busy: a solve() is in progress');
    if (this._last === null) throw new Error('No solve result: call solve() first');
    return this._last;
  }

  _withSolution(what) {
    const last = this._solved();
    if (last.status !== 'OPTIMAL' && last.status !== 'FEASIBLE') {
      throw new Error(`${what}: no solution, the last solve ended ${last.status}`);
    }
    return last;
  }
}

// `using solver = new CpSolver()` (explicit resource management) disposes on scope exit.
if (typeof Symbol.dispose === 'symbol') CpSolver.prototype[Symbol.dispose] = CpSolver.prototype.dispose;

module.exports = { CpSolver, SolutionSnapshot };
