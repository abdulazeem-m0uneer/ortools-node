'use strict';
// Micro-benchmark for the shared JS <-> int64 conversion (src/common/int64.cc),
// which every bulk input (graph arcs, routing matrices, CP-SAT domains) goes through.
// Run: node bench/int64-conversion.js   (times a round trip: JS -> int64 -> JS)

const { _testing: t } = require('..').native;

const N = 1_000_000;
const REPEATS = 5;
const floats = new Float64Array(N).map((_, i) => i);
const inputs = { Float64Array: floats, Int32Array: Int32Array.from(floats), Array: Array.from(floats) };

for (const [name, values] of Object.entries(inputs)) {
  t.int64ArrayRoundTrip(values, false); // warm up
  const start = process.hrtime.bigint();
  for (let i = 0; i < REPEATS; i++) t.int64ArrayRoundTrip(values, false);
  const ms = Number(process.hrtime.bigint() - start) / 1e6 / REPEATS;
  console.log(`${name.padEnd(12)} ${ms.toFixed(1)} ms per ${N.toLocaleString('en')} values`);
}
