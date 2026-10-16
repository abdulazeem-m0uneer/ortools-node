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

// JSON.stringify would turn ±Infinity into null, which means "keep the default".
function encode(value, what) {
  return JSON.stringify(value, (key, v) => {
    if (typeof v === 'bigint') return v.toString();
    if (typeof v !== 'number' || Number.isFinite(v)) return v;
    if (Number.isNaN(v)) throw new TypeError(`${what}: '${key}' must not be NaN`);
    return v > 0 ? 'Infinity' : '-Infinity';
  });
}

// The caller's fields as JSON. The native side merges only the keys present,
// and a "__proto__" own key reaches it as an unknown field.
function overridesJson(params, what) {
  if (params === undefined) return '{}';
  if (!isPlainObject(params)) throw new TypeError(`${what} must be a plain object`);
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

/** Milliseconds as a protobuf Duration string: durationMs(500) === '0.5s'. */
function durationMs(ms) {
  if (typeof ms !== 'number' || Number.isNaN(ms)) throw new TypeError('durationMs(ms): ms must be a number');
  if (!Number.isFinite(ms) || ms < 0) throw new RangeError('durationMs(ms): ms must be finite and >= 0');
  const totalNanos = Math.round(ms * 1e6);
  if (!Number.isSafeInteger(totalNanos)) throw new RangeError('durationMs(ms): ms is too large');
  const seconds = Math.floor(totalNanos / 1e9);
  const nanos = totalNanos % 1e9;
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
