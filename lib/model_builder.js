'use strict';

// Linear and mixed-integer models in the style of Python's
// ortools.linear_solver.python.model_builder. The Model lives in JS and is sent
// to OR-Tools as an MPModelProto, which OR-Tools validates; a Solver solves it
// with any backend compiled into the build and keeps the results.

const native = require('./native');
const { encode } = require('./proto_json');

/** Statuses Solver.solve() returns (Python's model_builder.SolveStatus). */
const SolveStatus = Object.freeze(Object.fromEntries([
  'OPTIMAL', 'FEASIBLE', 'INFEASIBLE', 'UNBOUNDED', 'ABNORMAL', 'NOT_SOLVED', 'MODEL_IS_VALID',
  'CANCELLED_BY_USER', 'UNKNOWN_STATUS', 'MODEL_INVALID', 'INVALID_SOLVER_PARAMETERS',
  'SOLVER_TYPE_UNAVAILABLE', 'INCOMPATIBLE_OPTIONS',
].map((name) => [name, name])));

function checkFinite(value, what) {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new TypeError(`${what} must be a finite number`);
  return value;
}
function checkBound(value, what) {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    throw new TypeError(`${what} must be a number (+-Infinity allowed)`);
  }
  return value;
}
function checkName(name, what) {
  if (typeof name !== 'string') throw new TypeError(`${what} name must be a string`);
  return name;
}
function checkBoolean(value, what) {
  if (typeof value !== 'boolean') throw new TypeError(`${what} must be a boolean`);
  return value;
}

// ---------------------------------------------------------------------------
// Expressions
// ---------------------------------------------------------------------------

// { terms: Map<Variable, coeff>, constant } of anything usable as an expression.
function flatten(item) {
  if (item instanceof LinearExpr) return item._flat();
  if (typeof item === 'number') return { terms: new Map(), constant: checkFinite(item, 'constant') };
  throw new TypeError('Expected a LinearExpr, Variable or number');
}

// terms[key] += coeff, keyed by Variable (expressions) or variable index (constraints).
function accumulate(terms, key, coeff) {
  const sum = (terms.get(key) ?? 0) + coeff;
  if (!Number.isFinite(sum)) throw new RangeError('Coefficient overflows');
  terms.set(key, sum);
}

function weighted(items, coeffs) {
  const terms = new Map();
  let constant = 0;
  items.forEach((item, i) => {
    const c = checkFinite(coeffs[i], 'coefficient');
    if (item instanceof Variable) { // fast path for large sums
      accumulate(terms, item, c);
      return;
    }
    const flat = flatten(item);
    for (const [variable, coeff] of flat.terms) accumulate(terms, variable, coeff * c);
    constant += flat.constant * c;
  });
  if (!Number.isFinite(constant)) throw new RangeError('Expression constant overflows');
  return new LinearExpr(terms, constant);
}

/** An immutable affine expression: sum(coeff * variable) + constant. */
class LinearExpr {
  /** @private Use the static builders or the methods of Variable / LinearExpr. */
  constructor(terms, constant) {
    this._terms = terms;
    this._constant = constant;
  }

  /** sum(items); items are LinearExpr, Variable or number. */
  static sum(items) {
    if (!Array.isArray(items)) throw new TypeError('LinearExpr.sum(items): items must be an array');
    return weighted(items, items.map(() => 1));
  }
  /** sum(items[i] * coeffs[i]). */
  static weightedSum(items, coeffs) {
    if (!Array.isArray(items) || !Array.isArray(coeffs)) {
      throw new TypeError('LinearExpr.weightedSum(items, coeffs): both must be arrays');
    }
    if (items.length !== coeffs.length) throw new RangeError('LinearExpr.weightedSum: items and coeffs differ in length');
    return weighted(items, coeffs);
  }
  /** item * coeff. */
  static term(item, coeff) {
    return weighted([item], [coeff]);
  }
  /** item * coeff + constant. */
  static affine(item, coeff, constant) {
    return weighted([item, constant], [coeff, 1]);
  }
  static constant(value) {
    return weighted([value], [1]);
  }

  plus(other) {
    return weighted([this, other], [1, 1]);
  }
  minus(other) {
    return weighted([this, other], [1, -1]);
  }
  times(coeff) {
    return weighted([this], [coeff]);
  }
  neg() {
    return weighted([this], [-1]);
  }
  /** this <= rhs */
  le(rhs) {
    return BoundedLinearExpression._of(this.minus(rhs), -Infinity, 0);
  }
  /** this >= rhs */
  ge(rhs) {
    return BoundedLinearExpression._of(this.minus(rhs), 0, Infinity);
  }
  /** this == rhs */
  eq(rhs) {
    return BoundedLinearExpression._of(this.minus(rhs), 0, 0);
  }

  get constant() {
    return this._flat().constant;
  }
  /** [variable, coefficient] pairs, in insertion order. */
  terms() {
    return [...this._flat().terms];
  }
  _flat() {
    return { terms: this._terms, constant: this._constant };
  }
  toString() {
    const parts = this.terms().map(([v, c]) => (c === 1 ? v.toString() : `${c} * ${v}`));
    if (this.constant !== 0 || parts.length === 0) parts.push(String(this.constant));
    return parts.join(' + ');
  }
}

/** lowerBound <= expression <= upperBound, from le() / ge() / eq(); pass it to Model.add(). */
class BoundedLinearExpression {
  constructor(expr, lowerBound, upperBound) {
    const { terms, constant } = flatten(expr);
    this.expression = new LinearExpr(terms, 0);
    this.lowerBound = checkBound(lowerBound, 'lowerBound') - constant;
    this.upperBound = checkBound(upperBound, 'upperBound') - constant;
  }
  static _of(expr, lowerBound, upperBound) {
    return new BoundedLinearExpression(expr, lowerBound, upperBound);
  }
  toString() {
    return `${this.lowerBound} <= ${this.expression} <= ${this.upperBound}`;
  }
}

// ---------------------------------------------------------------------------
// Model handles
// ---------------------------------------------------------------------------

// Handles are plain indices into one Model, valid until that Model is re-imported.
function initHandle(handle, model, index) {
  handle._model = model;
  handle._index = index;
  handle._generation = model._generation;
}

function checkHandle(handle, model, cls) {
  if (!(handle instanceof cls)) throw new TypeError(`Expected a ${cls.name}`);
  if (handle._model !== model) throw new Error(`${cls.name} ${handle._index} belongs to a different Model`);
  if (handle._generation !== model._generation) {
    throw new Error(`${cls.name} ${handle._index} is no longer valid (the Model was re-imported)`);
  }
}

/** A decision variable. Also a LinearExpr (1 * variable). */
class Variable extends LinearExpr {
  /** @private Use Model.newVar() and friends. */
  constructor(model, index) {
    super(null, 0);
    initHandle(this, model, index);
  }
  get index() {
    return this._index;
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
  get isIntegral() {
    return this._record().integer;
  }
  set isIntegral(integer) {
    this._record().integer = checkBoolean(integer, 'isIntegral');
  }
  get objectiveCoefficient() {
    return this._record().obj;
  }
  set objectiveCoefficient(coeff) {
    this._record().obj = checkFinite(coeff, 'objectiveCoefficient');
  }
  _record() {
    checkHandle(this, this._model, Variable);
    return this._model._vars[this._index];
  }
  _flat() {
    return { terms: new Map([[this, 1]]), constant: 0 };
  }
  toString() {
    return this.name || `variable#${this._index}`;
  }
}

// Shared by linear and enforced constraints: bounds, name and terms.
class ConstraintBase {
  constructor(model, index) {
    initHandle(this, model, index);
  }
  get index() {
    return this._index;
  }
  get name() {
    return this._record().name;
  }
  set name(name) {
    this._record().name = checkName(name, 'Constraint');
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
  /** Sets the coefficient of `variable`, replacing any previous one. */
  setCoefficient(variable, coeff) {
    const ct = this._record();
    checkHandle(variable, this._model, Variable);
    ct.terms.set(variable._index, checkFinite(coeff, 'coefficient'));
    return this;
  }
  /** Adds `coeff` to the coefficient of `variable`. */
  addTerm(variable, coeff) {
    const ct = this._record();
    checkHandle(variable, this._model, Variable);
    accumulate(ct.terms, variable._index, checkFinite(coeff, 'coefficient'));
    return this;
  }
  clearTerms() {
    this._record().terms.clear();
    return this;
  }
  /** [variable, coefficient] pairs. */
  terms() {
    return [...this._record().terms].map(([index, coeff]) => [this._model._varHandles[index], coeff]);
  }
  _record() {
    checkHandle(this, this._model, this.constructor);
    return this._model[this._listName][this._index];
  }
}

/** lowerBound <= sum(coeff * variable) <= upperBound. */
class LinearConstraint extends ConstraintBase {
  get _listName() {
    return '_cts';
  }
}

/** A linear constraint that only holds when indicatorVariable == indicatorValue. */
class EnforcedLinearConstraint extends ConstraintBase {
  get _listName() {
    return '_enforced';
  }
  get indicatorVariable() {
    return this._model._varHandles[this._record().indicator];
  }
  set indicatorVariable(variable) {
    const ct = this._record();
    checkHandle(variable, this._model, Variable);
    ct.indicator = variable._index;
  }
  get indicatorValue() {
    return this._record().indicatorValue;
  }
  set indicatorValue(value) {
    this._record().indicatorValue = checkBoolean(value, 'indicatorValue');
  }
}

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

// Unset proto2 fields are absent from an imported MPModelProto.
function protoNumber(value) {
  return value ?? 0;
}

function constraintRecord(proto) {
  const varIndex = proto.varIndex ?? [];
  const coefficient = proto.coefficient ?? [];
  return {
    name: proto.name ?? '',
    lb: protoNumber(proto.lowerBound ?? -Infinity),
    ub: protoNumber(proto.upperBound ?? Infinity),
    terms: new Map(varIndex.map((index, i) => [index, protoNumber(coefficient[i])])),
  };
}

function constraintProto(record) {
  return {
    name: record.name,
    lowerBound: record.lb,
    upperBound: record.ub,
    varIndex: [...record.terms.keys()],
    coefficient: [...record.terms.values()],
  };
}

/** A linear or mixed-integer model. */
class Model {
  constructor(name = '') {
    this._name = checkName(name, 'Model');
    this._generation = 0;
    this._load({ vars: [], cts: [], enforced: [], maximize: false, offset: 0, hints: new Map() });
  }

  get name() {
    return this._name;
  }
  set name(name) {
    this._name = checkName(name, 'Model');
  }

  // ---- variables -----------------------------------------------------------

  newVar(lowerBound, upperBound, isIntegral, name = '') {
    const record = {
      name: checkName(name, 'Variable'),
      lb: checkBound(lowerBound, 'lowerBound'),
      ub: checkBound(upperBound, 'upperBound'),
      integer: checkBoolean(isIntegral, 'isIntegral'),
      obj: 0,
    };
    this._vars.push(record);
    const variable = new Variable(this, this._vars.length - 1);
    this._varHandles.push(variable);
    return variable;
  }
  newNumVar(lowerBound, upperBound, name) {
    return this.newVar(lowerBound, upperBound, false, name);
  }
  newIntVar(lowerBound, upperBound, name) {
    return this.newVar(lowerBound, upperBound, true, name);
  }
  newBoolVar(name) {
    return this.newVar(0, 1, true, name);
  }
  get numVariables() {
    return this._vars.length;
  }
  getVariables() {
    return this._varHandles.slice();
  }
  varFromIndex(index) {
    return this._handleAt(this._varHandles, index, 'variable');
  }

  // ---- constraints ---------------------------------------------------------

  /** lowerBound <= expr <= upperBound; a constant inside expr moves to the bounds. */
  addLinearConstraint(expr, lowerBound = -Infinity, upperBound = Infinity, name = '') {
    const record = this._constraintRecord(expr, lowerBound, upperBound, name);
    this._cts.push(record);
    const ct = new LinearConstraint(this, this._cts.length - 1);
    this._ctHandles.push(ct);
    return ct;
  }
  /** Adds x.le(5), x.plus(y).eq(z)... */
  add(bounded, name = '') {
    const b = checkBounded(bounded);
    return this.addLinearConstraint(b.expression, b.lowerBound, b.upperBound, name);
  }
  /** lowerBound <= expr <= upperBound whenever indicatorVariable == indicatorValue. */
  addEnforcedLinearConstraint(expr, indicatorVariable, indicatorValue, lowerBound = -Infinity, upperBound = Infinity,
    name = '') {
    checkHandle(indicatorVariable, this, Variable);
    checkBoolean(indicatorValue, 'indicatorValue');
    const record = this._constraintRecord(expr, lowerBound, upperBound, name);
    record.indicator = indicatorVariable._index;
    record.indicatorValue = indicatorValue;
    this._enforced.push(record);
    const ct = new EnforcedLinearConstraint(this, this._enforced.length - 1);
    this._enforcedHandles.push(ct);
    return ct;
  }
  addEnforced(bounded, indicatorVariable, indicatorValue, name = '') {
    const b = checkBounded(bounded);
    return this.addEnforcedLinearConstraint(b.expression, indicatorVariable, indicatorValue, b.lowerBound,
      b.upperBound, name);
  }
  get numConstraints() {
    return this._cts.length;
  }
  get numEnforcedConstraints() {
    return this._enforced.length;
  }
  getLinearConstraints() {
    return this._ctHandles.slice();
  }
  getEnforcedLinearConstraints() {
    return this._enforcedHandles.slice();
  }
  linearConstraintFromIndex(index) {
    return this._handleAt(this._ctHandles, index, 'linear constraint');
  }
  enforcedLinearConstraintFromIndex(index) {
    return this._handleAt(this._enforcedHandles, index, 'enforced linear constraint');
  }

  // ---- objective -----------------------------------------------------------

  minimize(expr) {
    return this.setObjective(expr, false);
  }
  maximize(expr) {
    return this.setObjective(expr, true);
  }
  /** Replaces the objective (coefficients, offset and sense). */
  setObjective(expr, maximize) {
    const { terms, constant } = this._ownTerms(expr);
    checkBoolean(maximize, 'maximize');
    for (const record of this._vars) record.obj = 0;
    for (const [index, coeff] of terms) this._vars[index].obj = coeff;
    this._offset = constant;
    this._maximize = maximize;
    return this;
  }
  clearObjective() {
    for (const record of this._vars) record.obj = 0;
    this._offset = 0;
    return this;
  }
  objectiveExpression() {
    const terms = new Map();
    this._vars.forEach((record, i) => {
      if (record.obj !== 0) terms.set(this._varHandles[i], record.obj);
    });
    return new LinearExpr(terms, this._offset);
  }
  get objectiveOffset() {
    return this._offset;
  }
  set objectiveOffset(offset) {
    this._offset = checkFinite(offset, 'objectiveOffset');
  }
  /** True when the objective is maximized. */
  get maximizing() {
    return this._maximize;
  }

  // ---- hints ---------------------------------------------------------------

  /** Suggests a value for `variable` to the solver; a second hint replaces the first. */
  addHint(variable, value) {
    checkHandle(variable, this, Variable);
    this._hints.set(variable._index, checkFinite(value, 'hint value'));
    return this;
  }
  clearHints() {
    this._hints.clear();
    return this;
  }

  // ---- copies, import and export --------------------------------------------

  clone(name = this._name) {
    checkName(name, 'Model');
    return new Model()._loadProto({ ...this.exportToProto(), name });
  }
  /** The model as an MPModelProto in protobuf's JSON form (infinite bounds as +-Infinity). */
  exportToProto() {
    const proto = {
      name: this._name,
      maximize: this._maximize,
      objectiveOffset: this._offset,
      variable: this._vars.map((v) => ({
        name: v.name, lowerBound: v.lb, upperBound: v.ub, isInteger: v.integer, objectiveCoefficient: v.obj,
      })),
      constraint: this._cts.map(constraintProto),
      generalConstraint: this._enforced.map((e) => ({
        name: e.name,
        indicatorConstraint: { varIndex: e.indicator, varValue: e.indicatorValue ? 1 : 0, constraint: constraintProto(e) },
      })),
    };
    if (this._hints.size > 0) {
      proto.solutionHint = { varIndex: [...this._hints.keys()], varValue: [...this._hints.values()] };
    }
    return proto;
  }
  exportToLpString(obfuscate = false) {
    return native.mbExportToLpString(encode(this.exportToProto(), 'MPModelProto'), checkBoolean(obfuscate, 'obfuscate'));
  }
  exportToMpsString(obfuscate = false) {
    return native.mbExportToMpsString(encode(this.exportToProto(), 'MPModelProto'), checkBoolean(obfuscate, 'obfuscate'));
  }
  /**
   * Replaces the model with one in OR-Tools' LP syntax (as its LP parser reads
   * it, e.g. "min: x + 2 y; c1: x + y >= 3; int y;"). Existing handles become
   * invalid. Throws, leaving the model unchanged, if the text does not parse.
   */
  importFromLpString(text) {
    return this._loadProto(native.mbImportFromLpString(text));
  }
  /** Replaces the model with one in MPS format (fixed or free). See importFromLpString(). */
  importFromMpsString(text) {
    return this._loadProto(native.mbImportFromMpsString(text));
  }

  // ---- internals -----------------------------------------------------------

  _handleAt(handles, index, what) {
    if (!Number.isInteger(index)) throw new TypeError(`${what} index must be an integer`);
    if (index < 0 || index >= handles.length) throw new RangeError(`${what} index out of range`);
    return handles[index];
  }
  // Flattens expr into { terms: Map<variable index, coeff>, constant }, checking every variable.
  _ownTerms(expr) {
    const { terms, constant } = flatten(expr);
    const own = new Map();
    for (const [variable, coeff] of terms) {
      checkHandle(variable, this, Variable);
      own.set(variable._index, coeff);
    }
    return { terms: own, constant };
  }
  _constraintRecord(expr, lowerBound, upperBound, name) {
    const { terms, constant } = this._ownTerms(expr);
    return {
      name: checkName(name, 'Constraint'),
      lb: checkBound(lowerBound, 'lowerBound') - constant,
      ub: checkBound(upperBound, 'upperBound') - constant,
      terms,
    };
  }
  // Builds the new contents completely before replacing anything.
  _loadProto(proto) {
    const general = proto.generalConstraint ?? [];
    const unsupported = general.find((g) => !g.indicatorConstraint);
    if (unsupported || proto.quadraticObjective) {
      throw new Error('The model uses general constraints or a quadratic objective, which model_builder does not support');
    }
    const hint = proto.solutionHint ?? {};
    const contents = {
      vars: (proto.variable ?? []).map((v) => ({
        name: v.name ?? '',
        lb: protoNumber(v.lowerBound ?? -Infinity),
        ub: protoNumber(v.upperBound ?? Infinity),
        integer: v.isInteger ?? false,
        obj: protoNumber(v.objectiveCoefficient),
      })),
      cts: (proto.constraint ?? []).map(constraintRecord),
      enforced: general.map((g) => {
        const indicator = g.indicatorConstraint;
        return {
          ...constraintRecord({ ...indicator.constraint, name: g.name ?? indicator.constraint?.name }),
          indicator: indicator.varIndex ?? 0,
          indicatorValue: (indicator.varValue ?? 0) === 1,
        };
      }),
      maximize: proto.maximize ?? false,
      offset: protoNumber(proto.objectiveOffset),
      hints: new Map((hint.varIndex ?? []).map((index, i) => [index, protoNumber(hint.varValue[i])])),
    };
    this._name = proto.name ?? '';
    this._generation++;
    this._load(contents);
    return this;
  }
  _load({ vars, cts, enforced, maximize, offset, hints }) {
    this._vars = vars;
    this._cts = cts;
    this._enforced = enforced;
    this._maximize = maximize;
    this._offset = offset;
    this._hints = hints;
    this._varHandles = vars.map((_, i) => new Variable(this, i));
    this._ctHandles = cts.map((_, i) => new LinearConstraint(this, i));
    this._enforcedHandles = enforced.map((_, i) => new EnforcedLinearConstraint(this, i));
  }
}

function checkBounded(bounded) {
  if (!(bounded instanceof BoundedLinearExpression)) {
    throw new TypeError('Expected a BoundedLinearExpression, e.g. x.plus(y).le(5)');
  }
  return bounded;
}

// ---------------------------------------------------------------------------
// Solver
// ---------------------------------------------------------------------------

function hasSolution(status) {
  return status === 'OPTIMAL' || status === 'FEASIBLE';
}

/** Solves Models with one backend ('GLOP', 'SCIP', 'CP_SAT', 'HIGHS', 'PDLP'...). */
class Solver {
  constructor(solverName) {
    this._n = new native.ModelBuilderSolver(solverName);
    this.solverName = solverName;
    this._timeLimit = undefined;
    this._specificParameters = undefined;
    this._output = false;
    this._result = undefined;
    this._disposed = false;
  }

  // ---- parameters ----------------------------------------------------------

  /** Infinity removes the limit. */
  setTimeLimitInSeconds(seconds) {
    this._checkIdle();
    if (typeof seconds !== 'number' || Number.isNaN(seconds)) throw new TypeError('seconds must be a number');
    if (seconds < 0) throw new RangeError('seconds must be >= 0');
    this._timeLimit = seconds === Infinity ? undefined : seconds;
    return this;
  }
  /** Backend-specific parameters, e.g. "limits/gap = 0.01" for SCIP. */
  setSolverSpecificParameters(parameters) {
    this._checkIdle();
    if (typeof parameters !== 'string') throw new TypeError('parameters must be a string');
    this._specificParameters = parameters;
    return this;
  }
  enableOutput(enabled = true) {
    this._checkIdle();
    this._output = checkBoolean(enabled, 'enabled');
    return this;
  }

  // ---- solving -------------------------------------------------------------

  /**
   * Solves off the main thread and resolves to a SolveStatus. The model is
   * copied first, so it may change while the solve runs.
   */
  solve(model) {
    const { json, snapshot } = this._prepare(model);
    return this._n.solve(json).then((response) => this._store(snapshot, response));
  }
  solveSync(model) {
    const { json, snapshot } = this._prepare(model);
    return this._store(snapshot, this._n.solveSync(json));
  }
  /** Stops a pending solve(); false if none runs or the backend cannot be interrupted (e.g. SCIP, HiGHS). */
  interrupt() {
    return !this._disposed && this._n.interrupt();
  }
  get busy() {
    return this._n.isBusy();
  }

  // ---- results of the last solve -------------------------------------------

  get status() {
    return this._response().status;
  }
  get statusString() {
    return this._response().statusString;
  }
  get objectiveValue() {
    return this._solution().objectiveValue;
  }
  get bestObjectiveBound() {
    return this._response().bestObjectiveBound;
  }
  get wallTime() {
    return this._response().wallTime;
  }
  get userTime() {
    return this._response().userTime;
  }
  /** Value of a Variable or LinearExpr in the solution. */
  value(expr) {
    const response = this._solution();
    const { terms, constant } = flatten(expr);
    let total = constant;
    for (const [variable, coeff] of terms) total += coeff * response.variableValues[this._varIndex(variable)];
    return total;
  }
  values(exprs) {
    return exprs.map((expr) => this.value(expr));
  }
  /** LP backends only. */
  reducedCost(variable) {
    const costs = this._solution().reducedCosts;
    const index = this._varIndex(variable);
    if (costs.length === 0) throw new Error(`Reduced costs are not available from ${this.solverName}`);
    return costs[index];
  }
  reducedCosts(variables) {
    return variables.map((v) => this.reducedCost(v));
  }
  /** LP backends only (not HiGHS: OR-Tools reports its duals wrong). */
  dualValue(constraint) {
    const duals = this._solution().dualValues;
    const index = this._constraintIndex(constraint);
    if (duals.length === 0) throw new Error(`Dual values are not available from ${this.solverName}`);
    return duals[index];
  }
  dualValues(constraints) {
    return constraints.map((c) => this.dualValue(c));
  }
  /** sum(coeff * value) of a linear constraint, as it was when solved. */
  activity(constraint) {
    const values = this._solution().variableValues;
    const ct = this._result.constraints[this._constraintIndex(constraint)];
    return ct.varIndex.reduce((sum, index, i) => sum + ct.coefficient[i] * values[index], 0);
  }
  activities(constraints) {
    return constraints.map((c) => this.activity(c));
  }

  /** Drops the results. Idempotent; throws while a solve() is pending; later calls throw. */
  dispose() {
    if (this._disposed) return;
    this._checkIdle();
    this._disposed = true;
    this._result = undefined;
  }

  // ---- internals -----------------------------------------------------------

  _checkIdle() {
    if (this._disposed) throw new Error('Solver has been disposed');
    if (this.busy) throw new Error('Solver is busy: a solve() is in progress');
  }
  _prepare(model) {
    if (!(model instanceof Model)) throw new TypeError('solve(model): expected a Model');
    // Read the model first: a Proxy around it could run code that disposes this solver.
    const proto = model.exportToProto();
    this._checkIdle();
    const request = { model: proto, enableInternalSolverOutput: this._output };
    if (this._timeLimit !== undefined) request.solverTimeLimitSeconds = this._timeLimit;
    if (this._specificParameters !== undefined) request.solverSpecificParameters = this._specificParameters;
    const snapshot = {
      model,
      generation: model._generation,
      numVariables: proto.variable.length,
      constraints: proto.constraint,
    };
    return { json: encode(request, 'MPModelRequest'), snapshot };
  }
  _store(snapshot, response) {
    this._result = { ...snapshot, response };
    return response.status;
  }
  _response() {
    this._checkIdle();
    if (!this._result) throw new Error('No solve result: call solve() first');
    return this._result.response;
  }
  _solution() {
    const response = this._response();
    if (!hasSolution(response.status)) {
      throw new Error(`No solution available: the last solve ended ${response.status}`);
    }
    return response;
  }
  _checkSolvedHandle(handle, cls, count) {
    const { model, generation } = this._result;
    checkHandle(handle, model, cls);
    if (handle._generation !== generation || handle._index >= count) {
      throw new Error(`${cls.name} ${handle._index} was not part of the solved model`);
    }
    return handle._index;
  }
  _varIndex(variable) {
    return this._checkSolvedHandle(variable, Variable, this._result.numVariables);
  }
  _constraintIndex(constraint) {
    return this._checkSolvedHandle(constraint, LinearConstraint, this._result.constraints.length);
  }
}

if (typeof Symbol.dispose === 'symbol') Solver.prototype[Symbol.dispose] = Solver.prototype.dispose;

/** Whether a backend name ('SCIP', 'glop', 'CP_SAT'...) is compiled into this build. */
function isSolverSupported(solverName) {
  return native.mbIsSolverSupported(solverName);
}

module.exports = {
  Model,
  Solver,
  LinearExpr,
  BoundedLinearExpression,
  Variable,
  LinearConstraint,
  EnforcedLinearConstraint,
  SolveStatus,
  isSolverSupported,
};
