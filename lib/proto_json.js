'use strict';

// Plain objects -> standard proto3 JSON for the native ParseProtoJson()
// (src/common/proto_json.h), as modelBuilder and mathOpt send their models.

// JSON.stringify would turn ±Infinity into null, which protobuf reads as "unset".
function encode(value, what) {
  return JSON.stringify(value, (key, v) => {
    if (typeof v === 'bigint') return v.toString();
    if (typeof v !== 'number' || Number.isFinite(v)) return v;
    if (Number.isNaN(v)) throw new TypeError(`${what}: '${key}' must not be NaN`);
    return v > 0 ? 'Infinity' : '-Infinity';
  });
}

module.exports = { encode };
