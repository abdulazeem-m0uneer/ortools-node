'use strict';
// Shared JS <-> int64 conversion (src/common/int64.cc), exercised through the
// internal native._testing hooks. Every solver that takes int64 data uses it.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { native } = require('..');

const { int64RoundTrip: one, int64ArrayRoundTrip: many, int64NumberOrBigIntRoundTrip: exact } = native._testing;
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

test('Int64ToJsNumberOrBigInt returns results beyond MAX_SAFE_INTEGER as exact BigInts, never a throw', () => {
  for (const v of [0, 1, -1, SAFE, -SAFE]) assert.equal(exact(v, false), v);
  assert.equal(exact(BigInt(SAFE), false), SAFE, 'a safe BigInt input comes back as a number');
  assert.equal(exact(BigInt(SAFE) + 1n, false), BigInt(SAFE) + 1n);
  assert.equal(exact(-BigInt(SAFE) - 1n, false), -BigInt(SAFE) - 1n);
  assert.equal(exact(2n ** 63n - 2n, false), 2n ** 63n - 2n);
  assert.equal(exact(-(2n ** 63n) + 1n, false), -(2n ** 63n) + 1n);
  assert.equal(exact(2n ** 63n - 1n, false), Infinity, 'kint64max stays the unbounded marker');
  assert.equal(exact(-(2n ** 63n), false), -Infinity);
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

// Reading an Array runs user code. A regression here aborts the process, so
// run each case in a child process and require a clean exit.
const { spawnSync } = require('node:child_process');
const path = require('node:path');

function runIsolated(body) {
  const script = `const { native } = require(${JSON.stringify(path.join(__dirname, '..'))});\n${body}`;
  return spawnSync(process.execPath, ['-e', script], { encoding: 'utf8' });
}

test('an element getter that throws propagates its error instead of aborting', () => {
  const r = runIsolated(`
    const a = [1, 2];
    Object.defineProperty(a, 1, { get() { throw new Error('from getter'); } });
    try { native._testing.int64ArrayRoundTrip(a, false); console.log('no error'); }
    catch (e) { console.log('caught:' + e.message); }`);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), 'caught:from getter');
});

test('a Proxy is rejected as a non-array without reading it', () => {
  // N-API does not treat a Proxy as an Array, so its traps never run.
  const r = runIsolated(`
    const p = new Proxy([1, 2], { get(t, k) { if (k === 'length') throw new Error('from length'); return t[k]; } });
    try { native._testing.int64ArrayRoundTrip(p, false); console.log('no error'); }
    catch (e) { console.log(e.name + ':' + e.message); }`);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout.trim(), /^TypeError:values must be an Array/);
});

test('an element getter that returns a non-integer is a normal TypeError', () => {
  const a = [1, 2];
  Object.defineProperty(a, 1, { get: () => 'two' });
  assert.throws(() => many(a, false), { name: 'TypeError', message: /values\[1\]/ });
});

// A JS length is not backed by memory (`new Array(2 ** 32 - 1)` is free), and
// a typed array's int64 copy can be twice its size: neither may abort the
// process with std::bad_alloc. RLIMIT_AS is only enforced on Linux.
function runWithAddressSpaceLimit(body) {
  const script = `const { native } = require(${JSON.stringify(path.join(__dirname, '..'))});\n${body}`;
  return spawnSync('/bin/sh', ['-c', 'ulimit -v 3000000 && exec "$0" -e "$1"', process.execPath, script], {
    encoding: 'utf8',
  });
}
const noAddressSpaceLimit = process.platform !== 'linux' && 'RLIMIT_AS is only enforced on Linux';

test('a huge sparse Array is rejected by its first element, not pre-allocated', { skip: noAddressSpaceLimit }, () => {
  const r = runWithAddressSpaceLimit(`
    try { native._testing.int64ArrayRoundTrip(new Array(2 ** 32 - 1), false); console.log('no error'); }
    catch (e) { console.log(e.name + ':' + e.message); }`);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), 'TypeError:values[0] must be an integer number or a BigInt');
});

test('a typed array whose int64 copy does not fit is a RangeError', { skip: noAddressSpaceLimit }, () => {
  // 1.2 GB of Int32 needs 2.4 GB as int64: over the 3 GB limit with Node itself.
  const r = runWithAddressSpaceLimit(`
    const values = new Int32Array(3e8);
    try { native._testing.int64ArrayRoundTrip(values, false); console.log('no error'); }
    catch (e) { console.log(e.name + ':' + e.message); }`);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), 'RangeError:values: out of memory (the input is too large)');
});
