'use strict';

// int64 values on the JS side of CP-SAT, following the rules of
// src/common/int64.h: a safe-integer number, or a BigInt that fits in int64.
// Values are kept canonical: a number whenever the value is a safe integer,
// a BigInt only beyond 2^53 - 1, so equal values always compare with ===.
// In domains, ±Infinity stands for the int64 extremes (OR-Tools' "unbounded").

const INT64_MAX = 2n ** 63n - 1n;
const INT64_MIN = -(2n ** 63n);
const INT64_MAX_STRING = INT64_MAX.toString();
const INT64_MIN_STRING = INT64_MIN.toString();

/** BigInt -> canonical value. Throws a RangeError outside int64. */
function fromBigInt(value, what) {
  if (value > INT64_MAX || value < INT64_MIN) throw new RangeError(`${what} does not fit in a 64-bit integer`);
  return value >= -BigInt(Number.MAX_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value;
}

/**
 * Reads a user-supplied integer. With allowInfinite, ±Infinity passes through
 * (and the BigInt int64 extremes become ±Infinity).
 */
function toInt(value, what, allowInfinite = false) {
  if (typeof value === 'number') {
    if (Number.isNaN(value)) throw new TypeError(`${what} must not be NaN`);
    if (!Number.isFinite(value)) {
      if (allowInfinite) return value;
      throw new TypeError(`${what} must be finite`);
    }
    if (!Number.isInteger(value)) throw new TypeError(`${what} must be an integer`);
    if (!Number.isSafeInteger(value)) throw new RangeError(`${what} is outside the safe integer range; pass a BigInt`);
    return value === 0 ? 0 : value;  // never -0
  }
  if (typeof value === 'bigint') {
    if (allowInfinite && value === INT64_MAX) return Infinity;
    if (allowInfinite && value === INT64_MIN) return -Infinity;
    return fromBigInt(value, what);
  }
  throw new TypeError(`${what} must be an integer number or a BigInt`);
}

/** a + b on canonical finite values; throws a RangeError on int64 overflow. */
function addInt(a, b, what = 'value') {
  if (typeof a === 'number' && typeof b === 'number') {
    const sum = a + b;
    if (Number.isSafeInteger(sum)) return sum;
  }
  return fromBigInt(BigInt(a) + BigInt(b), what);
}

/** a * b on canonical finite values; throws a RangeError on int64 overflow. */
function mulInt(a, b, what = 'value') {
  if (typeof a === 'number' && typeof b === 'number') {
    const product = a * b;
    if (Number.isSafeInteger(product)) return product === 0 ? 0 : product;  // never -0
  }
  return fromBigInt(BigInt(a) * BigInt(b), what);
}

function negInt(a, what = 'value') {
  return mulInt(a, -1, what);
}

/** The protobuf JSON form of an int64 (a decimal string); ±Infinity -> int64 extremes. */
function int64Json(value) {
  if (value === Infinity) return INT64_MAX_STRING;
  if (value === -Infinity) return INT64_MIN_STRING;
  return String(value);
}

module.exports = { toInt, addInt, mulInt, negInt, int64Json, fromBigInt };
