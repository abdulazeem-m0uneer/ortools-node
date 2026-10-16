'use strict';

// RoutingSearchParameters and SatParameters as plain objects in protobuf's
// JSON form: lowerCamelCase field names (snake_case is accepted too), enum
// values as names, durations as strings such as "0.5s", and int64 fields read
// back as decimal strings. The native side merges, converts and validates them
// with the protobuf descriptors, and OR-Tools validates the result.

const native = require('./native');

/** Enum names from the OR-Tools build in use, e.g. FirstSolutionStrategy.PATH_CHEAPEST_ARC. */
const { FirstSolutionStrategy, LocalSearchMetaheuristic, RoutingSearchStatus } = native;

function isPlainObject(value) {
  if (value === null || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

// JSON cannot hold ±Infinity. They travel as these strings, which the native
// side accepts only for float and double fields; a caller's string equal to one is rejected.
const INFINITY_MARKERS = new Map([[Infinity, '\u0000+Infinity'], [-Infinity, '\u0000-Infinity']]);
const RESERVED_STRINGS = new Set(INFINITY_MARKERS.values());

function unbox(value) {
  const boxed = value instanceof Number || value instanceof String || value instanceof Boolean ||
    value instanceof BigInt;
  return boxed ? value.valueOf() : value;
}

function childPath(parentPath, holder, key) {
  if (Array.isArray(holder)) return `${parentPath}[${key}]`;
  return parentPath ? `${parentPath}.${key}` : key;
}

function hasToJSON(value) {
  return value !== null && typeof value === 'object' && typeof value.toJSON === 'function';
}

// Plain JSON data only: anything JSON.stringify would drop, turn into {} or
// replace through toJSON (which runs before the replacer) is an error.
// null and undefined pass (null keeps a default; inside an array the native side rejects it).
function encode(value, what) {
  const paths = new WeakMap([[value, '']]); // every holder but JSON.stringify's root wrapper
  return JSON.stringify(value, function replacer(key, raw) {
    const parentPath = paths.get(this);
    if (parentPath === undefined) return raw; // `value` itself, a plain object
    const path = childPath(parentPath, this, key);
    const fail = (problem) => new TypeError(`${what}: '${path}' ${problem}`);
    if (hasToJSON(this[key])) throw fail('must be JSON data, not an object with a toJSON method');
    const v = unbox(raw);
    switch (typeof v) {
      case 'bigint':
        return v.toString();
      case 'number':
        if (Number.isNaN(v)) throw fail('must not be NaN');
        return Number.isFinite(v) ? v : INFINITY_MARKERS.get(v);
      case 'string':
        if (RESERVED_STRINGS.has(v)) throw fail('is reserved for ±Infinity numbers');
        return v;
      case 'object':
        if (v !== null && !Array.isArray(v) && !isPlainObject(v)) throw fail('must be a plain object or an array');
        if (v !== null) paths.set(v, path);
        return v;
      case 'function':
      case 'symbol':
        throw fail(`must be JSON data, not a ${typeof v}`);
      default:
        return v;
    }
  });
}

// The caller's fields as JSON. The native side merges only the keys present,
// and a "__proto__" own key reaches it as an unknown field.
function overridesJson(params, what) {
  if (params === undefined) return '{}';
  if (!isPlainObject(params)) throw new TypeError(`${what} must be a plain object`);
  if (hasToJSON(params)) throw new TypeError(`${what} must not have a toJSON method`);
  return encode(params, what);
}

/** A fresh copy of OR-Tools' DefaultRoutingSearchParameters(). */
function defaultRoutingSearchParameters() {
  return native.defaultRoutingSearchParameters();
}

/** Validated JSON of the defaults with `params` merged on top (used by the routing solver). */
function routingSearchParametersJson(params) {
  return native.routingSearchParametersJson(overridesJson(params, 'RoutingSearchParameters'));
}

/**
 * The full parameter set OR-Tools would use: the defaults with `params` merged
 * on top (undefined or null keeps a default). Throws TypeError for unknown
 * fields or bad values, RangeError for combinations OR-Tools rejects.
 */
function validateRoutingSearchParameters(params) {
  return native.validateRoutingSearchParameters(overridesJson(params, 'RoutingSearchParameters'));
}

/** A fresh copy of CP-SAT's default SatParameters, every field listed. */
function defaultSatParameters() {
  return native.defaultSatParameters();
}

/** Validated JSON of the fields set in `params` (used by the CP-SAT solver). */
function satParametersJson(params) {
  return native.satParametersJson(overridesJson(params, 'SatParameters'));
}

/** The fields set in `params`, as CP-SAT parsed them. Throws like validateRoutingSearchParameters. */
function validateSatParameters(params) {
  return native.validateSatParameters(overridesJson(params, 'SatParameters'));
}

// protobuf Duration's range: ±315,576,000,000 s (about 10,000 years).
const MAX_DURATION_SECONDS = 315_576_000_000;

/** Milliseconds as a protobuf Duration string: durationMs(500) === '0.5s'. */
function durationMs(ms) {
  if (typeof ms !== 'number' || Number.isNaN(ms)) throw new TypeError('durationMs(ms): ms must be a number');
  if (!Number.isFinite(ms) || ms < 0) throw new RangeError('durationMs(ms): ms must be finite and >= 0');
  if (ms > MAX_DURATION_SECONDS * 1000) {
    throw new RangeError(`durationMs(ms): ms must be at most ${MAX_DURATION_SECONDS * 1000}`);
  }
  // Split before scaling to nanoseconds, which would overflow 2^53. Both steps are exact.
  const remainderMs = ms % 1000;
  let seconds = (ms - remainderMs) / 1000;
  let nanos = Math.round(remainderMs * 1e6);
  if (nanos === 1e9) {
    seconds += 1;
    nanos = 0;
  }
  if (nanos === 0) return `${seconds}s`;
  return `${seconds}.${String(nanos).padStart(9, '0').replace(/0+$/, '')}s`;
}

module.exports = {
  FirstSolutionStrategy,
  LocalSearchMetaheuristic,
  RoutingSearchStatus,
  defaultRoutingSearchParameters,
  validateRoutingSearchParameters,
  routingSearchParametersJson,
  defaultSatParameters,
  validateSatParameters,
  satParametersJson,
  durationMs,
};
