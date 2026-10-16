'use strict';
// Shared JS <-> int64 conversion (src/common/int64.cc), exercised through the
// internal native._testing hooks. Every solver that takes int64 data uses it.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { native } = require('..');

const { int64RoundTrip: one, int64ArrayRoundTrip: many } = native._testing;
const SAFE = Number.MAX_SAFE_INTEGER;

test('safe integers and in-range BigInts round-trip exactly', () => {
  for (const v of [0, -0, 1, -1, 42, SAFE, -SAFE]) assert.equal(one(v, false), v === 0 ? 0 : v);
  assert.equal(one(5n, false), 5);
  assert.equal(one(BigInt(SAFE), false), SAFE);
});

test('+-Infinity map onto the int64 extremes only when allowed', () => {
  assert.equal(one(Infinity, true), Infinity);
  assert.equal(one(-Infinity, true), -Infinity);
  assert.equal(one(9223372036854775807n, false), Infinity); // kint64max reads back as Infinity
  assert.equal(one(-9223372036854775808n, false), -Infinity);
  assert.throws(() => one(Infinity, false), { name: 'TypeError', message: /finite/ });
});

test('NaN, fractions and non-numbers are TypeErrors', () => {
  assert.throws(() => one(NaN, true), { name: 'TypeError', message: /NaN/ });
  assert.throws(() => one(1.5, false), { name: 'TypeError', message: /integer/ });
  for (const bad of ['1', null, undefined, {}, true]) assert.throws(() => one(bad, false), TypeError);
});

test('values a JS number cannot hold exactly are RangeErrors, never rounded', () => {
  assert.throws(() => one(SAFE + 1, false), { name: 'RangeError', message: /BigInt/ });
  assert.throws(() => one(2n ** 63n, false), { name: 'RangeError', message: /64-bit/ });
  assert.throws(() => one(BigInt(SAFE) + 1n, false), { name: 'RangeError', message: /exactly/ });
});

test('arrays and typed arrays convert element by element', () => {
  assert.deepEqual(many([1, 2n, -3], false), [1, 2, -3]);
  assert.deepEqual(many([], false), []);
  assert.deepEqual(many(new Int32Array([1, -2]), false), [1, -2]);
  assert.deepEqual(many(new Uint32Array([4294967295]), false), [4294967295]);
  assert.deepEqual(many(new Float64Array([3, Infinity]), true), [3, Infinity]);
  assert.deepEqual(many(new BigInt64Array([7n, -8n]), false), [7, -8]);
});

test('array errors name the offending element', () => {
  assert.throws(() => many([1, 2.5], false), { name: 'TypeError', message: /values\[1\]/ });
  assert.throws(() => many(new Float64Array([1, NaN]), false), { name: 'TypeError', message: /values\[1\].*NaN/ });
  assert.throws(() => many(new Uint8Array([1]), false), { name: 'TypeError', message: /Int32Array/ });
  assert.throws(() => many('1,2', false), TypeError);
});
