'use strict';

// Integer linear expressions for CP-SAT. JS has no operator overloading, so
// `x + 2 * y <= 10` is written x.plus(y.times(2)).le(10), and long sums use
// CpLinearExpr.sum() / weightedSum(). Expressions are immutable trees, flattened
// on demand without recursion, so chaining .plus() many times stays safe.

const { Domain } = require('./domain');
const { toInt, addInt, mulInt } = require('./int');

class CpLinearExpr {
  // Abstract: expressions come from variables, arithmetic and the static helpers.
  constructor() {
    if (new.target === CpLinearExpr) {
      throw new TypeError('CpLinearExpr is abstract: build expressions from variables, .plus() / .times() or CpLinearExpr.sum()');
    }
  }

  /** this + other */
  plus(other) {
    return new SumExpr([this, other], [1, 1]);
  }
  /** this - other */
  minus(other) {
    return new SumExpr([this, other], [1, -1]);
  }
  /** this * coefficient (an integer). */
  times(coefficient) {
    return new SumExpr([this], [coefficient]);
  }
  /** -this */
  neg() {
    return new SumExpr([this], [-1]);
  }

  /** this <= other */
  le(other) {
    return new BoundedLinearExpr(this.minus(other), new Domain(-Infinity, 0));
  }
  /** this >= other */
  ge(other) {
    return new BoundedLinearExpr(this.minus(other), new Domain(0, Infinity));
  }
  /** this < other */
  lt(other) {
    return new BoundedLinearExpr(this.minus(other), new Domain(-Infinity, -1));
  }
  /** this > other */
  gt(other) {
    return new BoundedLinearExpr(this.minus(other), new Domain(1, Infinity));
  }
  /** this == other */
  eq(other) {
    return new BoundedLinearExpr(this.minus(other), new Domain(0, 0));
  }
  /** this != other */
  ne(other) {
    return new BoundedLinearExpr(this.minus(other), Domain.fromValues([0]).complement());
  }

  /** Σ exprs[i]; entries may be expressions or integers. */
  static sum(exprs) {
    if (!Array.isArray(exprs)) throw new TypeError('CpLinearExpr.sum(exprs): exprs must be an Array');
    return new SumExpr(exprs, exprs.map(() => 1));
  }
  /** Σ exprs[i] * coefficients[i]. */
  static weightedSum(exprs, coefficients) {
    if (!Array.isArray(exprs) || !Array.isArray(coefficients)) {
      throw new TypeError('CpLinearExpr.weightedSum(exprs, coefficients): both must be Arrays');
    }
    if (exprs.length !== coefficients.length) {
      throw new TypeError('CpLinearExpr.weightedSum(exprs, coefficients): the arrays must have the same length');
    }
    return new SumExpr(exprs, coefficients);
  }
  /** expr * coefficient */
  static term(expr, coefficient) {
    return new SumExpr([expr], [coefficient]);
  }
  /** expr * coefficient + offset */
  static affine(expr, coefficient, offset) {
    return new SumExpr([expr], [coefficient], offset);
  }
  /** A constant expression. */
  static constant(value) {
    return new SumExpr([], [], value);
  }

  toString() {
    const { vars, coeffs, offset } = flatten(this);
    const parts = vars.map((v, i) => (coeffs[i] === 1 ? String(v) : `${coeffs[i]} * ${v}`));
    if (offset !== 0 || parts.length === 0) parts.push(String(offset));
    return parts.join(' + ');
  }
}

/** Σ children[i] * coeffs[i] + offset; integer children are folded into the offset. */
class SumExpr extends CpLinearExpr {
  constructor(children, coeffs, offset = 0) {
    super();
    let constant = toInt(offset, 'offset');
    this._children = [];
    this._coeffs = [];
    for (let i = 0; i < children.length; ++i) {
      const child = children[i];
      const coeff = toInt(coeffs[i], 'coefficient');
      if (child instanceof CpLinearExpr) {
        this._children.push(child);
        this._coeffs.push(coeff);
      } else if (typeof child === 'number' || typeof child === 'bigint') {
        constant = addInt(constant, mulInt(toInt(child, 'constant'), coeff));
      } else {
        throw new TypeError(`Expected a linear expression or an integer, got ${describe(child)}`);
      }
    }
    this._offset = constant;
    this._flat = null;
    Object.freeze(this._children);
  }
}

/** An integer variable. Create them with CpModel.newIntVar() and friends. */
class IntVar extends CpLinearExpr {
  constructor(model, index, name, domain) {
    super();
    this._model = model;
    this.index = index;
    this.name = name;
    this.domain = domain;
    this._negation = this.isBoolean ? new NotBooleanVariable(this) : null;
    Object.freeze(this);
  }
  /** True when the domain lies in [0, 1], so the variable can be used as a literal. */
  get isBoolean() {
    const d = this.domain;
    return !d.isEmpty() && d.min() >= 0 && d.max() <= 1;
  }
  /** The negated literal (1 - this); only for Boolean variables. */
  not() {
    if (this._negation === null) {
      throw new TypeError(`not(): '${this}' is not a Boolean variable (domain ${this.domain})`);
    }
    return this._negation;
  }
  toString() {
    return this.name || `x${this.index}`;
  }
}

/** The negation of a Boolean variable; as an expression it is 1 - variable. */
class NotBooleanVariable extends CpLinearExpr {
  constructor(variable) {
    super();
    this._variable = variable;
    Object.freeze(this);
  }
  /** The proto literal: -index - 1. */
  get index() {
    return -this._variable.index - 1;
  }
  get _model() {
    return this._variable._model;
  }
  not() {
    return this._variable;
  }
  toString() {
    return `not(${this._variable})`;
  }
}

/** expr ∈ domain, as built by le / ge / lt / gt / eq / ne; pass it to CpModel.add(). */
class BoundedLinearExpr {
  constructor(expr, domain) {
    this.expr = expr;
    this.domain = domain;
    Object.freeze(this);
  }
  toString() {
    return `${this.expr} in ${this.domain}`;
  }
}

function describe(value) {
  if (value === null) return 'null';
  if (typeof value === 'object') return value.constructor ? value.constructor.name : 'object';
  return typeof value === 'number' ? String(value) : typeof value;
}

/**
 * { vars: IntVar[], coeffs, offset } with each variable once and no zero
 * coefficient. Iterative, so deep .plus() chains cannot overflow the stack.
 */
function flatten(expr) {
  if (expr instanceof IntVar) return { vars: [expr], coeffs: [1], offset: 0 };
  if (expr._flat) return expr._flat;
  const coeffByVar = new Map();
  let offset = 0;
  const addTerm = (variable, coeff) => {
    coeffByVar.set(variable, addInt(coeffByVar.get(variable) ?? 0, coeff, 'coefficient'));
  };
  const stack = [[expr, 1]];
  while (stack.length > 0) {
    const [node, multiplier] = stack.pop();
    if (node instanceof IntVar) {
      addTerm(node, multiplier);
    } else if (node instanceof NotBooleanVariable) {
      offset = addInt(offset, multiplier, 'offset');
      addTerm(node._variable, mulInt(multiplier, -1, 'coefficient'));
    } else {
      offset = addInt(offset, mulInt(node._offset, multiplier, 'offset'), 'offset');
      // Pushed in reverse so variables come out in the order they were written.
      for (let i = node._children.length - 1; i >= 0; --i) {
        stack.push([node._children[i], mulInt(node._coeffs[i], multiplier, 'coefficient')]);
      }
    }
  }
  const vars = [];
  const coeffs = [];
  for (const [variable, coeff] of coeffByVar) {
    if (coeff === 0) continue;
    vars.push(variable);
    coeffs.push(coeff);
  }
  const flat = Object.freeze({ vars, coeffs, offset });
  if (expr instanceof SumExpr) expr._flat = flat;
  return flat;
}

module.exports = { CpLinearExpr, IntVar, NotBooleanVariable, BoundedLinearExpr, flatten, describe };
