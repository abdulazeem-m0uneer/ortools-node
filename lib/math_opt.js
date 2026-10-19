'use strict';

// Linear and mixed-integer models in the style of Python's
// ortools.math_opt.python.mathopt. The Model lives in JS and is sent to
// MathOpt as a ModelProto (MathOpt validates it); solve() returns a SolveResult
// whose values are keyed by this module's Variable and LinearConstraint handles.

const native = require('./native');
const { encode } = require('./proto_json');
const { durationMs } = require('./params');
const {
  LinearExpr, BoundedLinearExpression, VariableBase, flatten, accumulate,
  checkFinite, checkBound, checkName, checkBoolean,
} = require('./linear_expr');

// { NAME: 'NAME' } for a proto enum, without its prefix and UNSPECIFIED value.
function stripEnum(names, prefix) {
  const out = {};
  for (const name of Object.keys(names)) {
    const short = name.slice(prefix.length);
    if (name.startsWith(prefix) && short !== 'UNSPECIFIED') out[short] = short;
  }
  return Object.freeze(out);
}

const enums = native.mathOptEnums;
/** Solver types compiled into this build and usable, e.g. SolverType.GLOP. */
const SolverType = Object.freeze(Object.fromEntries(native.mathOptSolverTypes.map((name) => [name, name])));
const TerminationReason = stripEnum(enums.TerminationReasonProto, 'TERMINATION_REASON_');
const Limit = stripEnum(enums.LimitProto, 'LIMIT_');
const FeasibilityStatus = stripEnum(enums.FeasibilityStatusProto, 'FEASIBILITY_STATUS_');
const LPAlgorithm = stripEnum(enums.LPAlgorithmProto, 'LP_ALGORITHM_');
const Emphasis = stripEnum(enums.EmphasisProto, 'EMPHASIS_');

function isPlainObject(value) {
  if (value === null || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

// ---------------------------------------------------------------------------
// Handles
// ---------------------------------------------------------------------------

// A handle is an id in one Model; ids are never reused, so a deleted one stays invalid.
function checkHandle(handle, model, cls) {
  if (!(handle instanceof cls)) throw new TypeError(`Expected a ${cls.name}`);
  if (handle._model !== model) throw new Error(`${cls.name} ${handle._id} belongs to a different Model`);
  if (!handle._records().has(handle._id)) throw new Error(`${cls.name} ${handle._id} was deleted`);
  return handle._id;
}

/** A decision variable. Also a LinearExpr (1 * variable). */
class Variable extends VariableBase {
  /** @private Use Model.addVariable() and friends. */
  constructor(model, id) {
    super();
    this._model = model;
    this._id = id;
  }
  get id() {
    return this._id;
  }
  get name() {
    return this._record().name;
  }
  set name(name) {
    this._record().name = checkName(name, 'Variable');
  }
  get lowerBound() {
    return this._record().lb;
  }
  set lowerBound(lb) {
    this._record().lb = checkBound(lb, 'lowerBound');
  }
  get upperBound() {
    return this._record().ub;
  }
  set upperBound(ub) {
    this._record().ub = checkBound(ub, 'upperBound');
  }
  get integer() {
    return this._record().integer;
  }
  set integer(integer) {
    this._record().integer = checkBoolean(integer, 'integer');
  }
  toString() {
    return this._records().get(this._id)?.name || `variable#${this._id}`;
  }
  _records() {
    return this._model._vars;
  }
  _record() {
    return this._records().get(checkHandle(this, this._model, Variable));
  }
}

/** lowerBound <= sum(coeff * variable) <= upperBound. */
class LinearConstraint {
  /** @private Use Model.addLinearConstraint(). */
  constructor(model, id) {
    this._model = model;
    this._id = id;
  }
  get id() {
    return this._id;
  }
  get name() {
    return this._record().name;
  }
  set name(name) {
    this._record().name = checkName(name, 'LinearConstraint');
  }
  get lowerBound() {
    return this._record().lb;
  }
  set lowerBound(lb) {
    this._record().lb = checkBound(lb, 'lowerBound');
  }
  get upperBound() {
    return this._record().ub;
  }
  set upperBound(ub) {
    this._record().ub = checkBound(ub, 'upperBound');
  }
  /** Sets the coefficient of `variable` (0 removes it). */
  setCoefficient(variable, coeff) {
    const record = this._record();
    const id = checkHandle(variable, this._model, Variable);
    if (checkFinite(coeff, 'coefficient') === 0) record.terms.delete(id);
    else record.terms.set(id, coeff);
    return this;
  }
  getCoefficient(variable) {
    const record = this._record();
    return record.terms.get(checkHandle(variable, this._model, Variable)) ?? 0;
  }
  /** [variable, coefficient] pairs. */
  terms() {
    return [...this._record().terms].map(([id, coeff]) => [this._model._varHandles.get(id), coeff]);
  }
  _records() {
    return this._model._cts;
  }
  _record() {
    return this._records().get(checkHandle(this, this._model, LinearConstraint));
  }
}

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

function sortedEntries(map) {
  return [...map].sort((a, b) => a[0] - b[0]);
}

/** A linear or mixed-integer optimization model. */
class Model {
  constructor(name = '') {
    this._name = checkName(name, 'Model');
    this._vars = new Map();       // id -> { name, lb, ub, integer }
    this._varHandles = new Map(); // id -> Variable
    this._cts = new Map();        // id -> { name, lb, ub, terms: Map<variable id, coeff> }
    this._ctHandles = new Map();
    this._nextVarId = 0;
    this._nextCtId = 0;
    this._maximize = false;
    this._offset = 0;
    this._objective = new Map();  // variable id -> coeff
  }

  get name() {
    return this._name;
  }
  set name(name) {
    this._name = checkName(name, 'Model');
  }

  // ---- variables -----------------------------------------------------------

  /** addVariable({ lb = -Infinity, ub = Infinity, isInteger = false, name = '' }) */
  addVariable(options = {}) {
    const { lb = -Infinity, ub = Infinity, isInteger = false, name = '' } = checkOptions(options, 'addVariable');
    const record = {
      name: checkName(name, 'Variable'),
      lb: checkBound(lb, 'lb'),
      ub: checkBound(ub, 'ub'),
      integer: checkBoolean(isInteger, 'isInteger'),
    };
    const id = this._nextVarId++;
    this._vars.set(id, record);
    const variable = new Variable(this, id);
    this._varHandles.set(id, variable);
    return variable;
  }
  addIntegerVariable(options = {}) {
    return this.addVariable({ ...checkOptions(options, 'addIntegerVariable'), isInteger: true });
  }
  addBinaryVariable(options = {}) {
    return this.addVariable({ ...checkOptions(options, 'addBinaryVariable'), lb: 0, ub: 1, isInteger: true });
  }
  /** Removes the variable from the model, its constraints and the objective. */
  deleteVariable(variable) {
    const id = checkHandle(variable, this, Variable);
    this._vars.delete(id);
    this._varHandles.delete(id);
    this._objective.delete(id);
    for (const ct of this._cts.values()) ct.terms.delete(id);
  }
  get numVariables() {
    return this._vars.size;
  }
  variables() {
    return [...this._varHandles.values()];
  }
  getVariable(id) {
    const variable = this._varHandles.get(id);
    if (!variable) throw new RangeError(`No variable with id ${id}`);
    return variable;
  }

  // ---- constraints ---------------------------------------------------------

  /**
   * addLinearConstraint(x.plus(y).le(5), name?) or
   * addLinearConstraint({ lb = -Infinity, ub = Infinity, expr = 0, name = '' }).
   */
  addLinearConstraint(boundedOrOptions = {}, name = '') {
    let lb;
    let ub;
    let expr;
    if (boundedOrOptions instanceof BoundedLinearExpression) {
      ({ lowerBound: lb, upperBound: ub, expression: expr } = boundedOrOptions);
    } else {
      ({ lb = -Infinity, ub = Infinity, expr = 0, name = '' } = checkOptions(boundedOrOptions, 'addLinearConstraint'));
    }
    const { terms, constant } = this._ownTerms(expr);
    const record = {
      name: checkName(name, 'LinearConstraint'),
      lb: checkBound(lb, 'lb') - constant,
      ub: checkBound(ub, 'ub') - constant,
      terms,
    };
    const id = this._nextCtId++;
    this._cts.set(id, record);
    const ct = new LinearConstraint(this, id);
    this._ctHandles.set(id, ct);
    return ct;
  }
  deleteLinearConstraint(constraint) {
    const id = checkHandle(constraint, this, LinearConstraint);
    this._cts.delete(id);
    this._ctHandles.delete(id);
  }
  get numLinearConstraints() {
    return this._cts.size;
  }
  linearConstraints() {
    return [...this._ctHandles.values()];
  }
  getLinearConstraint(id) {
    const ct = this._ctHandles.get(id);
    if (!ct) throw new RangeError(`No linear constraint with id ${id}`);
    return ct;
  }

  // ---- objective -----------------------------------------------------------

  minimize(expr) {
    return this.setObjective(expr, false);
  }
  maximize(expr) {
    return this.setObjective(expr, true);
  }
  /** Replaces the objective (coefficients, offset and sense). */
  setObjective(expr, isMaximize) {
    const { terms, constant } = this._ownTerms(expr);
    this._maximize = checkBoolean(isMaximize, 'isMaximize');
    this._objective = terms;
    this._offset = constant;
    return this;
  }
  get isMaximize() {
    return this._maximize;
  }
  set isMaximize(isMaximize) {
    this._maximize = checkBoolean(isMaximize, 'isMaximize');
  }
  get objectiveOffset() {
    return this._offset;
  }
  set objectiveOffset(offset) {
    this._offset = checkFinite(offset, 'objectiveOffset');
  }
  objectiveCoefficient(variable) {
    return this._objective.get(checkHandle(variable, this, Variable)) ?? 0;
  }
  setObjectiveCoefficient(variable, coeff) {
    const id = checkHandle(variable, this, Variable);
    if (checkFinite(coeff, 'coefficient') === 0) this._objective.delete(id);
    else this._objective.set(id, coeff);
    return this;
  }
  objectiveExpression() {
    const terms = new Map([...this._objective].map(([id, coeff]) => [this._varHandles.get(id), coeff]));
    return new LinearExpr(terms, this._offset);
  }

  // ---- export --------------------------------------------------------------

  /** The model as a MathOpt ModelProto in protobuf's JSON form. */
  exportModel() {
    const vars = [...this._vars];
    const cts = [...this._cts];
    const matrix = { rowIds: [], columnIds: [], coefficients: [] };
    for (const [rowId, ct] of cts) {
      for (const [columnId, coeff] of sortedEntries(ct.terms)) {
        matrix.rowIds.push(rowId);
        matrix.columnIds.push(columnId);
        matrix.coefficients.push(coeff);
      }
    }
    const objective = sortedEntries(this._objective);
    return {
      name: this._name,
      variables: {
        ids: vars.map(([id]) => id),
        lowerBounds: vars.map(([, v]) => v.lb),
        upperBounds: vars.map(([, v]) => v.ub),
        integers: vars.map(([, v]) => v.integer),
        names: vars.map(([, v]) => v.name),
      },
      objective: {
        maximize: this._maximize,
        offset: this._offset,
        linearCoefficients: { ids: objective.map(([id]) => id), values: objective.map(([, c]) => c) },
      },
      linearConstraints: {
        ids: cts.map(([id]) => id),
        lowerBounds: cts.map(([, c]) => c.lb),
        upperBounds: cts.map(([, c]) => c.ub),
        names: cts.map(([, c]) => c.name),
      },
      linearConstraintMatrix: matrix,
    };
  }

  // Flattens expr into { terms: Map<variable id, coeff> without zeros, constant }.
  _ownTerms(expr) {
    const { terms, constant } = flatten(expr);
    const own = new Map();
    for (const [variable, coeff] of terms) {
      const id = checkHandle(variable, this, Variable);
      if (coeff !== 0) accumulate(own, id, coeff);
    }
    return { terms: own, constant };
  }
}

function checkOptions(options, what) {
  if (!isPlainObject(options)) throw new TypeError(`${what}: options must be a plain object`);
  return options;
}

// ---------------------------------------------------------------------------
// Solving
// ---------------------------------------------------------------------------

/** Stops the solves it was passed to; once interrupted it stays interrupted. */
class SolveInterrupter {
  constructor() {
    this._n = new native.MathOptSolveInterrupter();
  }
  interrupt() {
    this._n.interrupt();
  }
  get interrupted() {
    return this._n.isInterrupted();
  }
}

// protobuf Duration's range, in seconds.
const MAX_TIME_LIMIT_SECONDS = 315_576_000_000;

// SolveParameters.timeLimit: seconds (returned) or a Duration string (undefined).
function checkTimeLimit(timeLimit) {
  if (typeof timeLimit === 'string') return undefined;
  const what = 'SolveParameters.timeLimit';
  if (typeof timeLimit !== 'number') throw new TypeError(`${what} must be a number of seconds or a Duration string`);
  if (Number.isNaN(timeLimit)) throw new TypeError(`${what} must not be NaN`);
  if (timeLimit < 0) throw new RangeError(`${what} must be >= 0 seconds`);
  if (timeLimit > MAX_TIME_LIMIT_SECONDS && timeLimit !== Infinity) {
    throw new RangeError(`${what} must be at most ${MAX_TIME_LIMIT_SECONDS} seconds (or Infinity)`);
  }
  return timeLimit;
}

// SolveParameters with friendly values -> SolveParametersProto JSON fields.
function solveParametersProto(parameters) {
  const out = { ...checkOptions(parameters, 'parameters') };
  if (out.timeLimit !== undefined) {
    const seconds = checkTimeLimit(out.timeLimit);
    if (seconds === Infinity) delete out.timeLimit;
    else if (seconds !== undefined) out.timeLimit = durationMs(seconds * 1000);
  }
  if (typeof out.lpAlgorithm === 'string' && !out.lpAlgorithm.startsWith('LP_ALGORITHM_')) {
    out.lpAlgorithm = `LP_ALGORITHM_${out.lpAlgorithm}`;
  }
  for (const key of ['presolve', 'cuts', 'heuristics', 'scaling']) {
    if (typeof out[key] === 'string' && !out[key].startsWith('EMPHASIS_')) out[key] = `EMPHASIS_${out[key]}`;
  }
  return out;
}

// Map<Variable, number> -> a sparse vector proto sorted by id; anything else passes through.
function sparseVector(values, model, what, integral) {
  if (!(values instanceof Map)) return values;
  const entries = [...values].map(([variable, value]) => {
    checkFinite(value, what);
    if (integral && !Number.isInteger(value)) throw new TypeError(`${what} must be an integer`);
    return [checkHandle(variable, model, Variable), value];
  });
  entries.sort((a, b) => a[0] - b[0]);
  return { ids: entries.map(([id]) => id), values: entries.map(([, value]) => value) };
}

// ModelSolveParameters: solutionHints may be Map<Variable, number>s and
// branchingPriorities a Map<Variable, integer>; other fields are proto JSON.
function modelParametersProto(modelParameters, model) {
  const out = { ...checkOptions(modelParameters, 'modelParameters') };
  if (Array.isArray(out.solutionHints)) {
    out.solutionHints = out.solutionHints.map((hint) =>
      (hint instanceof Map ? { variableValues: sparseVector(hint, model, 'solution hint value', false) } : hint));
  }
  out.branchingPriorities = sparseVector(out.branchingPriorities, model, 'branching priority', true);
  if (out.branchingPriorities === undefined) delete out.branchingPriorities;
  return out;
}

function prepare(model, solverType, options) {
  if (!(model instanceof Model)) throw new TypeError('solve(model, solverType): expected a Model');
  if (typeof solverType !== 'string') throw new TypeError('solverType must be a string, e.g. SolverType.GLOP');
  // Read every option first: getters may run code that changes the model.
  const { parameters = {}, modelParameters = {}, interrupter } = checkOptions(options, 'solve options');
  if (interrupter !== undefined && !(interrupter instanceof SolveInterrupter)) {
    throw new TypeError('interrupter must be a SolveInterrupter');
  }
  const parametersJson = encode(solveParametersProto(parameters), 'SolveParametersProto');
  const modelParametersJson = encode(modelParametersProto(modelParameters, model), 'ModelSolveParametersProto');
  // The snapshot and the exported model describe the same moment.
  const snapshot = { variables: new Map(model._varHandles), constraints: new Map(model._ctHandles) };
  const args = [encode(model.exportModel(), 'ModelProto'), solverType, parametersJson, modelParametersJson];
  return { args, snapshot, interrupter };
}

/**
 * Solves off the main thread; resolves to a SolveResult. The model is copied
 * first, so it may change while the solve runs.
 * options: { parameters, modelParameters, interrupter }.
 */
function solve(model, solverType, options = {}) {
  const { args, snapshot, interrupter } = prepare(model, solverType, options);
  return native.mathOptSolve(...args, interrupter?._n).then((json) => new SolveResult(JSON.parse(json), snapshot));
}

/** Blocking solve (no interrupter). */
function solveSync(model, solverType, options = {}) {
  const { args, snapshot } = prepare(model, solverType, options);
  return new SolveResult(JSON.parse(native.mathOptSolveSync(...args)), snapshot);
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

// Proto JSON prints int64 as strings and non-finite doubles as "Infinity" / "NaN".
function num(value) {
  return value === undefined ? 0 : Number(value);
}
function stripPrefix(value, prefix) {
  return typeof value === 'string' && value.startsWith(prefix) ? value.slice(prefix.length) : value;
}
function seconds(duration) {
  return duration ? Number.parseFloat(duration) : 0;
}

/** The outcome of solve(): termination, statistics and the solutions found. */
class SolveResult {
  constructor(proto, snapshot) {
    const termination = proto.termination ?? {};
    const status = termination.problemStatus ?? {};
    const bounds = termination.objectiveBounds ?? {};
    const stats = proto.solveStats ?? {};
    this.termination = Object.freeze({
      reason: stripPrefix(termination.reason, 'TERMINATION_REASON_'),
      limit: stripPrefix(termination.limit, 'LIMIT_'),
      detail: termination.detail ?? '',
      problemStatus: Object.freeze({
        primalStatus: stripPrefix(status.primalStatus, 'FEASIBILITY_STATUS_'),
        dualStatus: stripPrefix(status.dualStatus, 'FEASIBILITY_STATUS_'),
        primalOrDualInfeasible: status.primalOrDualInfeasible ?? false,
      }),
      objectiveBounds: Object.freeze({ primalBound: num(bounds.primalBound), dualBound: num(bounds.dualBound) }),
    });
    this.solveStats = Object.freeze({
      solveTime: seconds(stats.solveTime),
      simplexIterations: num(stats.simplexIterations),
      barrierIterations: num(stats.barrierIterations),
      firstOrderIterations: num(stats.firstOrderIterations),
      nodeCount: num(stats.nodeCount),
    });
    /** The SolveResultProto as MathOpt returned it (protobuf JSON). */
    this.proto = proto;
    this._snapshot = snapshot;
    const best = proto.solutions?.[0] ?? {};
    this._primal = best.primalSolution;
    this._dual = best.dualSolution;
  }

  hasPrimalFeasibleSolution() {
    return this._primal?.feasibilityStatus === 'SOLUTION_STATUS_FEASIBLE';
  }
  hasDualFeasibleSolution() {
    return this._dual?.feasibilityStatus === 'SOLUTION_STATUS_FEASIBLE';
  }
  /** Objective of the best primal feasible solution. */
  objectiveValue() {
    return num(this._requirePrimal().objectiveValue);
  }
  /** The best proven bound on the objective (dual bound). */
  bestObjectiveBound() {
    return this.termination.objectiveBounds.dualBound;
  }
  solveTime() {
    return this.solveStats.solveTime;
  }
  /** variableValues(x) -> number; ([x, y]) -> numbers; () -> Map<Variable, number>. */
  variableValues(variables) {
    return this._lookup(this._requirePrimal().variableValues, this._snapshot.variables, Variable, variables);
  }
  reducedCosts(variables) {
    return this._lookup(this._requireDual().reducedCosts, this._snapshot.variables, Variable, variables);
  }
  dualValues(constraints) {
    return this._lookup(this._requireDual().dualValues, this._snapshot.constraints, LinearConstraint, constraints);
  }

  _requirePrimal() {
    if (!this.hasPrimalFeasibleSolution()) {
      throw new Error(`No primal feasible solution (termination: ${this.termination.reason})`);
    }
    return this._primal;
  }
  _requireDual() {
    if (!this.hasDualFeasibleSolution()) {
      throw new Error(`No dual feasible solution (termination: ${this.termination.reason})`);
    }
    return this._dual;
  }
  // Values of a SparseDoubleVectorProto by handle, for handles that were in the solved model.
  _lookup(vector, handles, cls, which) {
    const values = new Map();
    const ids = vector?.ids ?? [];
    ids.forEach((id, i) => values.set(Number(id), num(vector.values[i])));
    const valueOf = (handle) => {
      if (!(handle instanceof cls)) throw new TypeError(`Expected a ${cls.name}`);
      if (handles.get(handle._id) !== handle) throw new Error(`${cls.name} ${handle._id} was not part of the solved model`);
      if (!values.has(handle._id)) throw new Error(`No value for ${cls.name} ${handle._id} in the result`);
      return values.get(handle._id);
    };
    if (which === undefined) {
      return new Map([...handles.values()].filter((h) => values.has(h._id)).map((h) => [h, values.get(h._id)]));
    }
    return Array.isArray(which) ? which.map(valueOf) : valueOf(which);
  }
}

module.exports = {
  Model,
  Variable,
  LinearConstraint,
  LinearExpr,
  BoundedLinearExpression,
  SolveInterrupter,
  SolveResult,
  SolverType,
  TerminationReason,
  Limit,
  FeasibilityStatus,
  LPAlgorithm,
  Emphasis,
  solve,
  solveSync,
};
