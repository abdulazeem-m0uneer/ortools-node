'use strict';

// Linear expressions shared by modelBuilder and mathOpt: immutable
// sum(coeff * variable) + constant, built with LinearExpr.sum(), x.plus(y),
// x.times(3)... and compared with le() / ge() / eq(). Each module's Variable
// extends VariableBase; its Model checks that every variable belongs to it.

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
    if (item instanceof VariableBase) { // fast path for large sums
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

/** Base class of the Variable handles: a variable is the expression 1 * variable. */
class VariableBase extends LinearExpr {
  constructor() {
    super(null, 0);
  }
  _flat() {
    return { terms: new Map([[this, 1]]), constant: 0 };
  }
}

module.exports = {
  LinearExpr,
  BoundedLinearExpression,
  VariableBase,
  flatten,
  accumulate,
  checkFinite,
  checkBound,
  checkName,
  checkBoolean,
};
