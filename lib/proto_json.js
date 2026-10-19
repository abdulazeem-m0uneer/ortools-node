'use strict';

// Plain objects -> standard proto3 JSON for the native ParseProtoJson()
// (src/common/proto_json.h), as modelBuilder and mathOpt send their models.

// JSON.stringify would turn ±Infinity into null, which protobuf reads as "unset".
// A NaN is an error naming its field path, e.g. 'item[1].resourceUsage[0]'.
function encode(value, what) {
  // The path of each object or array being serialised. JSON.stringify visits
  // depth first, so an object reached twice has the path of the current visit.
  const paths = new WeakMap();
  return JSON.stringify(value, function replacer(key, v) {
    const parent = paths.get(this);
    const path = parent === undefined ? key : Array.isArray(this) ? `${parent}[${key}]` : parent ? `${parent}.${key}` : key;
    if (typeof v === 'bigint') return v.toString();
    if (v !== null && typeof v === 'object') paths.set(v, path);
    if (typeof v !== 'number' || Number.isFinite(v)) return v;
    if (Number.isNaN(v)) throw new TypeError(`${what}: '${path}' must not be NaN`);
    return v > 0 ? 'Infinity' : '-Infinity';
  });
}

module.exports = { encode };
