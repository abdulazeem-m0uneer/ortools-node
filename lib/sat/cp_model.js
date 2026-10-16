'use strict';

// CpModel builds a CpModelProto in protobuf's JSON form, the way Python's
// cp_model.CpModel does: int64 fields are decimal strings, variables and
// literals are proto indices (a negated literal is -index - 1). Arguments are
// checked here; OR-Tools' own validator checks the rest at solve() / validate().

const native = require('../native');
const { Domain } = require('./domain');
const { toInt, negInt, int64Json } = require('./int');
const { CpLinearExpr, IntVar, NotBooleanVariable, BoundedLinearExpr, flatten, describe } = require('./linear_expr');
const { CpConstraint, IntervalVar, listArgs } = require('./constraint');

const INT32_MAX = 2 ** 31 - 1;

function nonEmptyArray(value, what) {
  if (!Array.isArray(value)) throw new TypeError(`${what} must be an Array`);
  if (value.length === 0) throw new RangeError(`${what} must not be empty`);
  return value;
}

function arrayArg(value, what) {
  if (!Array.isArray(value)) throw new TypeError(`${what} must be an Array`);
  return value;
}

function sameLength(a, b, what) {
  if (a.length !== b.length) throw new RangeError(`${what} must have the same length (${a.length} vs ${b.length})`);
}

// A graph node: a non-negative int32.
function nodeIndex(value, what) {
  if (typeof value !== 'number' || !Number.isInteger(value)) throw new TypeError(`${what} must be an integer`);
  if (value < 0 || value > INT32_MAX) throw new RangeError(`${what} must be in [0, ${INT32_MAX}]`);
  return value;
}

function asExpr(value, what) {
  if (value instanceof CpLinearExpr) return value;
  if (typeof value === 'number' || typeof value === 'bigint') return CpLinearExpr.constant(toInt(value, what));
  throw new TypeError(`${what} must be a linear expression or an integer, got ${describe(value)}`);
}

class CpModel {
  constructor() {
    this._proto = { name: '', variables: [], constraints: [] };
    this._constants = new Map();  // value -> IntVar, shared like Python's new_constant()
  }

  get name() {
    return this._proto.name;
  }
  set name(name) {
    if (typeof name !== 'string') throw new TypeError('CpModel name must be a string');
    this._proto.name = name;
  }

  // ---- variables -----------------------------------------------------------

  /** An integer variable in [lb, ub]. */
  newIntVar(lb, ub, name = '') {
    return this._newVar(new Domain(lb, ub), name);
  }
  /** An integer variable whose values are a Domain. */
  newIntVarFromDomain(domain, name = '') {
    if (!(domain instanceof Domain)) throw new TypeError('newIntVarFromDomain(domain): domain must be a Domain');
    return this._newVar(domain, name);
  }
  /** A Boolean variable (domain [0, 1]); usable as a literal. */
  newBoolVar(name = '') {
    return this._newVar(new Domain(0, 1), name);
  }
  /** A fixed value as a variable. Equal values share one variable. */
  newConstant(value) {
    const v = toInt(value, 'newConstant(value)');
    let variable = this._constants.get(v);
    if (variable === undefined) {
      variable = this._newVar(new Domain(v, v), '');
      this._constants.set(v, variable);
    }
    return variable;
  }

  _newVar(domain, name) {
    if (typeof name !== 'string') throw new TypeError('Variable name must be a string');
    const index = this._proto.variables.length;
    this._proto.variables.push({ name, domain: domain.flattenedIntervals().map(int64Json) });
    return new IntVar(this, index, name, domain);
  }

  // ---- intervals -----------------------------------------------------------

  /** The interval [start, end) with start + size == end; arguments are affine expressions. */
  newIntervalVar(start, size, end, name = '') {
    return this._newInterval(start, size, end, null, name);
  }
  /** Like newIntervalVar(), but only present (and constrained) when isPresent is true. */
  newOptionalIntervalVar(start, size, end, isPresent, name = '') {
    return this._newInterval(start, size, end, isPresent, name);
  }
  /** The interval [start, start + size) for a fixed integer size. */
  newFixedSizeIntervalVar(start, size, name = '') {
    const fixed = toInt(size, 'size');
    return this._newInterval(start, fixed, asExpr(start, 'start').plus(fixed), null, name);
  }
  /** Like newFixedSizeIntervalVar(), but only present when isPresent is true. */
  newOptionalFixedSizeIntervalVar(start, size, isPresent, name = '') {
    const fixed = toInt(size, 'size');
    return this._newInterval(start, fixed, asExpr(start, 'start').plus(fixed), isPresent, name);
  }

  _newInterval(start, size, end, presence, name) {
    if (typeof name !== 'string') throw new TypeError('Interval name must be a string');
    const interval = {
      start: this._expr(start, 'interval start'),
      end: this._expr(end, 'interval end'),
      size: this._expr(size, 'interval size'),
    };
    const ct = { name, interval };
    if (presence !== null) ct.enforcementLiteral = [this._literal(presence, 'interval presence literal')];
    const index = this._push(ct).index;
    return new IntervalVar(this, index, asExpr(start, 'start'), asExpr(size, 'size'), asExpr(end, 'end'), presence);
  }

  // ---- linear constraints --------------------------------------------------

  /**
   * Adds a bounded expression built with le / ge / lt / gt / eq / ne, e.g.
   * model.add(x.plus(y).le(10)); `true` / `false` add a trivially true / false constraint.
   */
  add(constraint) {
    if (constraint instanceof BoundedLinearExpr) {
      return this.addLinearExpressionInDomain(constraint.expr, constraint.domain);
    }
    if (typeof constraint === 'boolean') return this.addBoolOr(constraint ? [true] : []);
    throw new TypeError(`add(): expected a bounded linear expression (e.g. x.le(3)) or a boolean, got ${describe(constraint)}`);
  }
  /** lb <= expr <= ub; ±Infinity leaves a side open. */
  addLinearConstraint(expr, lb, ub) {
    return this.addLinearExpressionInDomain(expr, new Domain(lb, ub));
  }
  /** expr ∈ domain. */
  addLinearExpressionInDomain(expr, domain) {
    if (!(domain instanceof Domain)) throw new TypeError('addLinearExpressionInDomain(expr, domain): domain must be a Domain');
    const { vars, coeffs, offset } = this._flat(expr, 'linear expression');
    const shifted = domain._shifted(negInt(offset, 'offset'));
    return this._push({
      linear: { vars, coeffs: coeffs.map(int64Json), domain: shifted.flattenedIntervals().map(int64Json) },
    });
  }

  // ---- Boolean constraints -------------------------------------------------

  /** At least one literal is true (literals as one Array or separate arguments). */
  addBoolOr(...literals) {
    return this._push({ boolOr: { literals: this._literals(literals) } });
  }
  /** Same as addBoolOr(). */
  addAtLeastOne(...literals) {
    return this.addBoolOr(...literals);
  }
  addAtMostOne(...literals) {
    return this._push({ atMostOne: { literals: this._literals(literals) } });
  }
  addExactlyOne(...literals) {
    return this._push({ exactlyOne: { literals: this._literals(literals) } });
  }
  /** Every literal is true. */
  addBoolAnd(...literals) {
    return this._push({ boolAnd: { literals: this._literals(literals) } });
  }
  /** An odd number of literals is true. */
  addBoolXor(...literals) {
    return this._push({ boolXor: { literals: this._literals(literals) } });
  }
  /** a => b */
  addImplication(a, b) {
    const premise = this._literal(a, 'a');
    const conclusion = this._literal(b, 'b');
    return this._push({ enforcementLiteral: [premise], boolAnd: { literals: [conclusion] } });
  }

  // ---- general integer constraints -----------------------------------------

  /** All expressions take different values (expressions as one Array or separate arguments). */
  addAllDifferent(...expressions) {
    return this._push({ allDiff: { exprs: this._exprs(listArgs(expressions), 'expressions') } });
  }
  /** expressions[index] == target. */
  addElement(index, expressions, target) {
    nonEmptyArray(expressions, 'addElement(index, expressions, target): expressions');
    if (!(index instanceof CpLinearExpr)) {
      const i = toInt(index, 'index');
      if (i < 0 || i >= expressions.length) throw new RangeError(`index ${i} is out of range for ${expressions.length} expressions`);
      return this.add(asExpr(expressions[i], `expressions[${i}]`).eq(target));
    }
    return this._push({
      element: {
        linearIndex: this._expr(index, 'index'),
        linearTarget: this._expr(target, 'target'),
        exprs: this._exprs(expressions, 'expressions'),
      },
    });
  }
  /** A Hamiltonian circuit over arcs [tail, head, literal]; skipped nodes need a self loop. */
  addCircuit(arcs) {
    return this._push({ circuit: this._arcs(arcs, 'addCircuit(arcs)') });
  }
  /** Several circuits through node 0 (the routes / VRP constraint) over arcs [tail, head, literal]. */
  addMultipleCircuit(arcs) {
    return this._push({ routes: this._arcs(arcs, 'addMultipleCircuit(arcs)') });
  }
  /** The expressions take the values of one of the tuples. */
  addAllowedAssignments(expressions, tuples) {
    return this._push({ table: this._table(expressions, tuples, false, 'addAllowedAssignments') });
  }
  /** The expressions take the values of none of the tuples. */
  addForbiddenAssignments(expressions, tuples) {
    return this._push({ table: this._table(expressions, tuples, true, 'addForbiddenAssignments') });
  }
  /**
   * The values of transitionExpressions spell a word the automaton accepts.
   * transitionTriples are [tail state, label, head state].
   */
  addAutomaton(transitionExpressions, startingState, finalStates, transitionTriples) {
    const what = 'addAutomaton';
    nonEmptyArray(transitionExpressions, `${what}: transitionExpressions`);
    nonEmptyArray(finalStates, `${what}: finalStates`);
    nonEmptyArray(transitionTriples, `${what}: transitionTriples`);
    const automaton = {
      startingState: int64Json(toInt(startingState, 'startingState')),
      finalStates: finalStates.map((s, i) => int64Json(toInt(s, `finalStates[${i}]`))),
      transitionTail: [],
      transitionHead: [],
      transitionLabel: [],
      exprs: this._exprs(transitionExpressions, 'transitionExpressions'),
    };
    transitionTriples.forEach((triple, i) => {
      if (!Array.isArray(triple) || triple.length !== 3) throw new TypeError(`transitionTriples[${i}] must be [tail, label, head]`);
      automaton.transitionTail.push(int64Json(toInt(triple[0], `transitionTriples[${i}][0]`)));
      automaton.transitionLabel.push(int64Json(toInt(triple[1], `transitionTriples[${i}][1]`)));
      automaton.transitionHead.push(int64Json(toInt(triple[2], `transitionTriples[${i}][2]`)));
    });
    return this._push({ automaton });
  }
  /** variables[i] == j  <=>  inverseVariables[j] == i. */
  addInverse(variables, inverseVariables) {
    nonEmptyArray(variables, 'addInverse: variables');
    nonEmptyArray(inverseVariables, 'addInverse: inverseVariables');
    sameLength(variables, inverseVariables, 'addInverse: variables and inverseVariables');
    return this._push({
      inverse: {
        fDirect: variables.map((v, i) => this._var(v, `variables[${i}]`)),
        fInverse: inverseVariables.map((v, i) => this._var(v, `inverseVariables[${i}]`)),
      },
    });
  }
  /** A reservoir starting at level 0: levelChanges[i] happens at times[i]; the level stays in [minLevel, maxLevel]. */
  addReservoirConstraint(times, levelChanges, minLevel, maxLevel) {
    return this._reservoir(times, levelChanges, null, minLevel, maxLevel);
  }
  /** Like addReservoirConstraint(), but change i only happens when actives[i] is true. */
  addReservoirConstraintWithActive(times, levelChanges, actives, minLevel, maxLevel) {
    return this._reservoir(times, levelChanges, arrayArg(actives, 'actives'), minLevel, maxLevel);
  }
  /** target == min(expressions). */
  addMinEquality(target, expressions) {
    const exprs = nonEmptyArray(expressions, 'addMinEquality: expressions');
    return this._push({
      linMax: {
        target: this._expr(asExpr(target, 'target').neg(), 'target'),
        exprs: exprs.map((e, i) => this._expr(asExpr(e, `expressions[${i}]`).neg(), `expressions[${i}]`)),
      },
    });
  }
  /** target == max(expressions). */
  addMaxEquality(target, expressions) {
    return this._push({
      linMax: {
        target: this._expr(target, 'target'),
        exprs: this._exprs(nonEmptyArray(expressions, 'addMaxEquality: expressions'), 'expressions'),
      },
    });
  }
  /** target == |expr|. */
  addAbsEquality(target, expr) {
    return this._push({
      linMax: {
        target: this._expr(target, 'target'),
        exprs: [this._expr(expr, 'expr'), this._expr(asExpr(expr, 'expr').neg(), 'expr')],
      },
    });
  }
  /** target == product of the expressions (as one Array or separate arguments). */
  addMultiplicationEquality(target, ...expressions) {
    return this._push({
      intProd: { target: this._expr(target, 'target'), exprs: this._exprs(listArgs(expressions), 'expressions') },
    });
  }
  /** target == numerator / denominator, rounded towards zero. */
  addDivisionEquality(target, numerator, denominator) {
    return this._push({
      intDiv: {
        target: this._expr(target, 'target'),
        exprs: [this._expr(numerator, 'numerator'), this._expr(denominator, 'denominator')],
      },
    });
  }
  /** target == expr % modulus (C convention: the sign follows expr). */
  addModuloEquality(target, expr, modulus) {
    return this._push({
      intMod: {
        target: this._expr(target, 'target'),
        exprs: [this._expr(expr, 'expr'), this._expr(modulus, 'modulus')],
      },
    });
  }

  // ---- scheduling ----------------------------------------------------------

  /** The present intervals do not overlap. */
  addNoOverlap(intervals) {
    return this._push({ noOverlap: { intervals: this._intervals(arrayArg(intervals, 'intervals'), 'intervals') } });
  }
  /** The present rectangles (xIntervals[i] × yIntervals[i]) do not overlap. */
  addNoOverlap2D(xIntervals, yIntervals) {
    arrayArg(xIntervals, 'xIntervals');
    arrayArg(yIntervals, 'yIntervals');
    sameLength(xIntervals, yIntervals, 'addNoOverlap2D: xIntervals and yIntervals');
    return this._push({
      noOverlap2d: {
        xIntervals: this._intervals(xIntervals, 'xIntervals'),
        yIntervals: this._intervals(yIntervals, 'yIntervals'),
      },
    });
  }
  /** At any time, the demands of the running intervals sum to at most capacity. */
  addCumulative(intervals, demands, capacity) {
    arrayArg(intervals, 'intervals');
    arrayArg(demands, 'demands');
    sameLength(intervals, demands, 'addCumulative: intervals and demands');
    return this._push({
      cumulative: {
        capacity: this._expr(capacity, 'capacity'),
        intervals: this._intervals(intervals, 'intervals'),
        demands: this._exprs(demands, 'demands'),
      },
    });
  }

  // ---- objective -----------------------------------------------------------

  minimize(expr) {
    this._setObjective(expr, false);
  }
  maximize(expr) {
    this._setObjective(expr, true);
  }
  hasObjective() {
    return this._proto.objective !== undefined;
  }
  clearObjective() {
    delete this._proto.objective;
  }

  // CP-SAT always minimises: a maximisation is stored negated with scaling factor -1.
  _setObjective(expr, maximize) {
    const { vars, coeffs, offset } = this._flat(expr, 'objective');
    const sign = maximize ? -1 : 1;
    const objective = {
      vars,
      coeffs: coeffs.map((c) => int64Json(maximize ? negInt(c, 'coefficient') : c)),
      offset: sign * Number(offset) || 0,
    };
    if (maximize) objective.scalingFactor = -1;
    this._proto.objective = objective;
  }

  // ---- search --------------------------------------------------------------

  /** Suggests var == value (a number, or a boolean for a literal) as a starting point. */
  addHint(variable, value) {
    let index;
    let v;
    if (variable instanceof NotBooleanVariable) {
      this._own(variable, 'Hint literal');
      index = variable.not().index;
      v = 1 - this._hintBit(value);
    } else if (variable instanceof IntVar) {
      this._own(variable, 'Hint variable');
      index = variable.index;
      v = typeof value === 'boolean' ? Number(value) : toInt(value, 'hint value');
    } else {
      throw new TypeError(`addHint(variable, value): expected an IntVar or a negated literal, got ${describe(variable)}`);
    }
    const hint = (this._proto.solutionHint ??= { vars: [], values: [] });
    hint.vars.push(index);
    hint.values.push(int64Json(v));
  }
  clearHints() {
    delete this._proto.solutionHint;
  }
  _hintBit(value) {
    if (typeof value === 'boolean') return Number(value);
    if (value === 0 || value === 1) return value;
    throw new TypeError('A literal hint must be a boolean, 0 or 1');
  }

  /** Solves under the assumption that the literal is true (see sufficientAssumptionsForInfeasibility). */
  addAssumption(literal) {
    const ref = this._literal(literal, 'assumption');
    (this._proto.assumptions ??= []).push(ref);
  }
  /** Literals as one Array or separate arguments. */
  addAssumptions(...literals) {
    const refs = this._literals(literals);
    (this._proto.assumptions ??= []).push(...refs);
  }
  clearAssumptions() {
    delete this._proto.assumptions;
  }

  /**
   * Branch on `variables` (IntVars or literals) in this order first.
   * varStrategy / domainStrategy are VariableSelectionStrategy / DomainReductionStrategy names.
   */
  addDecisionStrategy(variables, varStrategy, domainStrategy) {
    arrayArg(variables, 'variables');
    if (native.VariableSelectionStrategy[varStrategy] !== varStrategy) {
      throw new TypeError(`Unknown VariableSelectionStrategy '${varStrategy}'`);
    }
    if (native.DomainReductionStrategy[domainStrategy] !== domainStrategy) {
      throw new TypeError(`Unknown DomainReductionStrategy '${domainStrategy}'`);
    }
    const exprs = variables.map((v, i) => {
      if (v instanceof NotBooleanVariable) {
        this._own(v, `variables[${i}]`);
        return { vars: [v.not().index], coeffs: ['-1'], offset: '1' };
      }
      return { vars: [this._var(v, `variables[${i}]`)], coeffs: ['1'], offset: '0' };
    });
    (this._proto.searchStrategy ??= []).push({
      exprs,
      variableSelectionStrategy: varStrategy,
      domainReductionStrategy: domainStrategy,
    });
  }

  // ---- export --------------------------------------------------------------

  /** A copy of the CpModelProto, in protobuf's JSON form (int64 fields as strings). */
  toJSON() {
    return structuredClone(this._proto);
  }
  /** '' when the model is valid, otherwise OR-Tools' description of the first problem. */
  validate() {
    return native.validateCpModel(this._json());
  }
  /** OR-Tools' statistics about the model. */
  modelStats() {
    return native.cpModelStats(this._json());
  }
  _json() {
    return JSON.stringify(this._proto);
  }

  // ---- argument conversion -------------------------------------------------

  _push(constraint) {
    const index = this._proto.constraints.length;
    this._proto.constraints.push(constraint);
    return new CpConstraint(this, index);
  }

  _own(handle, what) {
    if (handle._model !== this) throw new Error(`${what} '${handle}' belongs to a different CpModel`);
  }

  _flat(expr, what) {
    if (!(expr instanceof CpLinearExpr)) {
      if (typeof expr !== 'number' && typeof expr !== 'bigint') {
        throw new TypeError(`${what} must be a linear expression or an integer, got ${describe(expr)}`);
      }
      return { vars: [], coeffs: [], offset: toInt(expr, what) };
    }
    const flat = flatten(expr);
    for (const v of flat.vars) this._own(v, `Variable in ${what}`);
    return { vars: flat.vars.map((v) => v.index), coeffs: flat.coeffs, offset: flat.offset };
  }

  // LinearExpressionProto JSON.
  _expr(expr, what) {
    const { vars, coeffs, offset } = this._flat(expr, what);
    return { vars, coeffs: coeffs.map(int64Json), offset: int64Json(offset) };
  }

  _exprs(exprs, what) {
    return arrayArg(exprs, what).map((e, i) => this._expr(e, `${what}[${i}]`));
  }

  _var(variable, what) {
    if (!(variable instanceof IntVar)) throw new TypeError(`${what} must be an IntVar, got ${describe(variable)}`);
    this._own(variable, what);
    return variable.index;
  }

  // A literal's proto reference; booleans become shared constants.
  _literal(literal, what) {
    if (literal instanceof IntVar) {
      this._own(literal, what);
      if (!literal.isBoolean) throw new TypeError(`${what} '${literal}' is not a Boolean variable`);
      return literal.index;
    }
    if (literal instanceof NotBooleanVariable) {
      this._own(literal, what);
      return literal.index;
    }
    if (typeof literal === 'boolean') return this.newConstant(Number(literal)).index;
    throw new TypeError(`${what} must be a Boolean variable, its not() or a boolean, got ${describe(literal)}`);
  }

  _literals(args) {
    return listArgs(args).map((literal, i) => this._literal(literal, `literal ${i}`));
  }

  _intervals(intervals, what) {
    return intervals.map((interval, i) => {
      if (!(interval instanceof IntervalVar)) throw new TypeError(`${what}[${i}] must be an IntervalVar`);
      this._own(interval, `${what}[${i}]`);
      return interval.index;
    });
  }

  _arcs(arcs, what) {
    nonEmptyArray(arcs, `${what}: arcs`);
    const out = { tails: [], heads: [], literals: [] };
    arcs.forEach((arc, i) => {
      if (!Array.isArray(arc) || arc.length !== 3) throw new TypeError(`arcs[${i}] must be [tail, head, literal]`);
      out.tails.push(nodeIndex(arc[0], `arcs[${i}] tail`));
      out.heads.push(nodeIndex(arc[1], `arcs[${i}] head`));
      out.literals.push(this._literal(arc[2], `arcs[${i}] literal`));
    });
    return out;
  }

  _table(expressions, tuples, negated, what) {
    nonEmptyArray(expressions, `${what}: expressions`);
    arrayArg(tuples, `${what}: tuples`);
    const values = [];
    tuples.forEach((tuple, i) => {
      if (!Array.isArray(tuple) || tuple.length !== expressions.length) {
        throw new TypeError(`tuples[${i}] must be an Array of ${expressions.length} integers`);
      }
      tuple.forEach((value, j) => values.push(int64Json(toInt(value, `tuples[${i}][${j}]`))));
    });
    return { exprs: this._exprs(expressions, 'expressions'), values, negated };
  }

  _reservoir(times, levelChanges, actives, minLevel, maxLevel) {
    arrayArg(times, 'times');
    arrayArg(levelChanges, 'levelChanges');
    sameLength(times, levelChanges, 'Reservoir times and levelChanges');
    if (actives !== null) sameLength(times, actives, 'Reservoir times and actives');
    const min = toInt(minLevel, 'minLevel');
    const max = toInt(maxLevel, 'maxLevel');
    if (max < min) throw new RangeError('Reservoir constraint must have maxLevel >= minLevel');
    if (max < 0) throw new RangeError('Reservoir constraint must have maxLevel >= 0');
    if (min > 0) throw new RangeError('Reservoir constraint must have minLevel <= 0');
    const reservoir = {
      minLevel: int64Json(min),
      maxLevel: int64Json(max),
      timeExprs: this._exprs(times, 'times'),
      levelChanges: this._exprs(levelChanges, 'levelChanges'),
    };
    if (actives !== null) reservoir.activeLiterals = actives.map((a, i) => this._literal(a, `actives[${i}]`));
    return this._push({ reservoir });
  }
}

module.exports = { CpModel };
