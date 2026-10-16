'use strict';

// RoutingSearchParameters and SatParameters as plain objects in protobuf's
// JSON form: lowerCamelCase field names (snake_case is accepted too), enum
// values as names, durations as strings such as "0.5s", and int64 fields read
// back as decimal strings. OR-Tools itself parses and validates them.

const native = require('./native');

/** Enum names from the OR-Tools build in use, e.g. FirstSolutionStrategy.PATH_CHEAPEST_ARC. */
const { FirstSolutionStrategy, LocalSearchMetaheuristic, RoutingSearchStatus } = native;

function isPlainObject(value) {
  if (value === null || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

// first_solution_strategy -> firstSolutionStrategy (protobuf's json_name rule),
// so a snake_case override replaces the camelCase default instead of duplicating it.
// Keys that are not proto-style names pass through, so errors quote them as written.
function toLowerCamel(key) {
  if (!/^[a-z][a-z0-9_]*$/.test(key)) return key;
  return key.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());
}

// Prototype-less, so a "__proto__" key stays an ordinary (and, to protobuf,
// unknown) field instead of changing the object's prototype and vanishing.
function bareObject(entries = []) {
  const out = Object.create(null);
  for (const [key, value] of entries) Object.defineProperty(out, key, { value, enumerable: true, writable: true });
  return out;
}

function normaliseKeys(value) {
  if (Array.isArray(value)) return value.map(normaliseKeys);
  if (!isPlainObject(value)) return value;
  return bareObject(Object.entries(value).map(([key, v]) => [toLowerCamel(key), normaliseKeys(v)]));
}

// Overrides win key by key, so an explicit false or 0 replaces a default.
function mergeOnto(base, overrides) {
  const out = bareObject(Object.entries(base));
  for (const [key, value] of Object.entries(overrides)) {
    const merged = isPlainObject(out[key]) && isPlainObject(value) ? mergeOnto(out[key], value) : value;
    Object.defineProperty(out, key, { value: merged, enumerable: true, writable: true });
  }
  return out;
}

// JSON.stringify would turn ±Infinity into null, which protobuf reads as "unset".
function encode(value, what) {
  return JSON.stringify(value, (key, v) => {
    if (typeof v === 'bigint') return v.toString();
    if (typeof v !== 'number' || Number.isFinite(v)) return v;
    if (Number.isNaN(v)) throw new TypeError(`${what}: '${key}' must not be NaN`);
    return v > 0 ? 'Infinity' : '-Infinity';
  });
}

// Doubles print as "Infinity" / "-Infinity". A string field holding that text
// also becomes a number here, and encode() turns it back into the same string.
function decode(json) {
  return JSON.parse(json, (key, v) => {
    if (v === 'Infinity') return Infinity;
    if (v === '-Infinity') return -Infinity;
    return v;
  });
}

function readOverrides(params, what) {
  if (params === undefined) return {};
  if (!isPlainObject(params)) throw new TypeError(`${what} must be a plain object`);
  return normaliseKeys(params);
}

/** A fresh copy of OR-Tools' DefaultRoutingSearchParameters(). */
function defaultRoutingSearchParameters() {
  return decode(native.defaultRoutingSearchParameters());
}

/** Validated JSON of the defaults with `params` merged on top (used by the routing solver). */
function routingSearchParametersJson(params) {
  const overrides = readOverrides(params, 'RoutingSearchParameters');
  const merged = mergeOnto(defaultRoutingSearchParameters(), overrides);
  return native.canonicalRoutingSearchParameters(encode(merged, 'RoutingSearchParameters'));
}

/**
 * The full parameter set OR-Tools would use: the defaults with `params` merged
 * on top. Throws TypeError for unknown fields or bad values, RangeError for
 * combinations OR-Tools rejects.
 */
function validateRoutingSearchParameters(params) {
  return decode(routingSearchParametersJson(params));
}

/** A fresh copy of CP-SAT's default SatParameters, every field listed. */
function defaultSatParameters() {
  return decode(native.defaultSatParameters());
}

/** Validated JSON of the fields set in `params` (used by the CP-SAT solver). */
function satParametersJson(params) {
  const overrides = readOverrides(params, 'SatParameters');
  return native.canonicalSatParameters(encode(overrides, 'SatParameters'));
}

/** The fields set in `params`, as CP-SAT parsed them. Throws like validateRoutingSearchParameters. */
function validateSatParameters(params) {
  return decode(satParametersJson(params));
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
