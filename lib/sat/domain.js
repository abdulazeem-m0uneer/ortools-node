'use strict';

// Domain: a sorted list of disjoint integer intervals (OR-Tools'
// sorted_interval_list.Domain). Bounds are int64 values; ±Infinity stands for
// the int64 extremes, which OR-Tools reads as "unbounded".

const { toInt, fromBigInt } = require('./int');

const INT64_MAX = 2n ** 63n - 1n;
const INT64_MIN = -(2n ** 63n);

function compare(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

// Sorts and merges [lo, hi] pairs (overlapping or adjacent ones join).
function normalise(intervals) {
  const sorted = intervals.filter(([lo, hi]) => lo <= hi).sort((x, y) => compare(x[0], y[0]));
  const out = [];
  for (const [lo, hi] of sorted) {
    const last = out[out.length - 1];
    if (last && (last[1] === Infinity || lo <= step(last[1], 1))) {
      if (hi > last[1]) last[1] = hi;
    } else {
      out.push([lo, hi]);
    }
  }
  return out;
}

// value + delta, saturating: reaching an int64 extreme means "unbounded".
// ±Infinity counts as the int64 extreme it stands for.
function step(value, delta) {
  if (typeof value === 'number' && typeof delta === 'number') {
    const next = value + delta;
    if (Number.isSafeInteger(next)) return next;
  }
  const big = value === Infinity ? INT64_MAX : value === -Infinity ? INT64_MIN : BigInt(value);
  const next = big + BigInt(delta);
  if (next >= INT64_MAX) return Infinity;
  if (next <= INT64_MIN) return -Infinity;
  return fromBigInt(next, 'Domain bound');
}

const isUnbounded = (bound) => bound === Infinity || bound === -Infinity;

// A single value: a finite integer, where the BigInt int64 extremes become
// ±Infinity like every bound, so one value always has one representation.
function toValue(value, what) {
  if (value === Infinity || value === -Infinity) throw new TypeError(`${what} must be finite`);
  return toInt(value, what, true);
}

class Domain {
  /** The interval [lb, ub]; empty when lb > ub. ±Infinity means unbounded. */
  constructor(lb, ub) {
    const lo = toInt(lb, 'Domain lb', true);
    const hi = toInt(ub, 'Domain ub', true);
    this._intervals = lo <= hi ? [[lo, hi]] : [];
    Object.freeze(this);
  }

  static _of(intervals) {
    const domain = Object.create(Domain.prototype);
    domain._intervals = normalise(intervals);
    return Object.freeze(domain);
  }

  /** Every int64 value. */
  static allValues() {
    return new Domain(-Infinity, Infinity);
  }

  /** The set of the given values, e.g. Domain.fromValues([1, 3, 4]) is [1,1][3,4]. */
  static fromValues(values) {
    if (!Array.isArray(values)) throw new TypeError('Domain.fromValues(values): values must be an Array');
    return Domain._of(values.map((v, i) => {
      const value = toValue(v, `values[${i}]`);
      return [value, value];
    }));
  }

  /** The union of [lo, hi] pairs; a one-element [v] means [v, v]. */
  static fromIntervals(intervals) {
    if (!Array.isArray(intervals)) throw new TypeError('Domain.fromIntervals(intervals): intervals must be an Array');
    return Domain._of(intervals.map((interval, i) => {
      if (!Array.isArray(interval) || (interval.length !== 1 && interval.length !== 2)) {
        throw new TypeError(`intervals[${i}] must be [lo, hi] or [value]`);
      }
      const lo = toInt(interval[0], `intervals[${i}][0]`, true);
      return [lo, interval.length === 1 ? lo : toInt(interval[1], `intervals[${i}][1]`, true)];
    }));
  }

  /** The union of the intervals [flat[0], flat[1]], [flat[2], flat[3]], ... */
  static fromFlatIntervals(flat) {
    if (!Array.isArray(flat) || flat.length % 2 !== 0) {
      throw new TypeError('Domain.fromFlatIntervals(flat): flat must be an Array of even length');
    }
    const intervals = [];
    for (let i = 0; i < flat.length; i += 2) {
      intervals.push([toInt(flat[i], `flat[${i}]`, true), toInt(flat[i + 1], `flat[${i + 1}]`, true)]);
    }
    return Domain._of(intervals);
  }

  /** [lo0, hi0, lo1, hi1, ...]: numbers, BigInts beyond 2^53 - 1, ±Infinity for the int64 extremes. */
  flattenedIntervals() {
    return this._intervals.flat();
  }

  isEmpty() {
    return this._intervals.length === 0;
  }

  /** Smallest value; throws on an empty domain. */
  min() {
    if (this.isEmpty()) throw new RangeError('An empty Domain has no min()');
    return this._intervals[0][0];
  }

  /** Largest value; throws on an empty domain. */
  max() {
    if (this.isEmpty()) throw new RangeError('An empty Domain has no max()');
    return this._intervals[this._intervals.length - 1][1];
  }

  contains(value) {
    const v = toValue(value, 'value');
    return this._intervals.some(([lo, hi]) => lo <= v && v <= hi);
  }

  /** Every int64 value not in this domain. */
  complement() {
    const out = [];
    let next = -Infinity;  // smallest value not yet covered
    for (const [lo, hi] of this._intervals) {
      if (lo !== -Infinity && next <= step(lo, -1)) out.push([next, step(lo, -1)]);
      if (hi === Infinity) return Domain._of(out);
      next = step(hi, 1);
    }
    out.push([next, Infinity]);
    return Domain._of(out);
  }

  /** Every value plus `delta` (an integer), saturating; unbounded ends stay unbounded. */
  _shifted(delta) {
    return Domain._of(this._intervals.map(([lo, hi]) => [
      isUnbounded(lo) ? lo : step(lo, delta),
      isUnbounded(hi) ? hi : step(hi, delta),
    ]));
  }

  toString() {
    return this._intervals.map(([lo, hi]) => (lo === hi ? `[${lo}]` : `[${lo},${hi}]`)).join('');
  }
}

module.exports = { Domain };
