'use strict';
// A node index in range can still need more memory than the process may use:
// OR-Tools sizes its vectors by the largest node index. std::bad_alloc must
// become a JS error, never std::terminate. Each case runs in a child process
// with its address space capped by `ulimit -v`, so the allocation fails fast
// and deterministically instead of zero-filling gigabytes.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const ADDRESS_SPACE_KB = 4000000; // ~4 GB: enough for Node, far too little for 2e9 nodes
const skip = process.platform === 'win32' && 'needs a POSIX shell with ulimit';

function runCapped(body) {
  const script = `
    const { SimpleMinCostFlow, SimpleMaxFlow, SimpleLinearSumAssignment } = require('.');
    const out = {};
    const attempt = (name, fn) => { try { out[name] = { value: fn() }; } catch (e) { out[name] = { type: e.constructor.name, error: e.message }; } };
    (async () => { ${body}; process.stdout.write(JSON.stringify(out)); })();`;
  const child = spawnSync('/bin/sh', ['-c', `ulimit -v ${ADDRESS_SPACE_KB} && exec "$0" -e "$1"`, process.execPath, script],
    { cwd: ROOT, encoding: 'utf8' });
  assert.equal(child.signal, null, `child killed by ${child.signal}: ${child.stderr}`);
  assert.equal(child.status, 0, child.stderr);
  return JSON.parse(child.stdout);
}

const OUT_OF_MEMORY = /out of memory \(the input is too large\)/;

test('min cost flow: an out-of-memory change throws and discards the graph', { skip }, () => {
  const out = runCapped(`
    const m = new SimpleMinCostFlow();
    attempt('supply', () => m.setNodeSupply(2e9, 1));
    attempt('after', () => m.numNodes());
    const bulk = new SimpleMinCostFlow();
    attempt('bulk', () => bulk.addArcsWithCapacityAndUnitCost([0], [2e9], [1], [1]));
    attempt('ok', () => { const f = new SimpleMinCostFlow(); f.addArcWithCapacityAndUnitCost(0, 1, 1, 1); return f.numArcs(); });`);
  assert.equal(out.supply.type, 'RangeError');
  assert.match(out.supply.error, OUT_OF_MEMORY);
  assert.match(out.after.error, /SimpleMinCostFlow was discarded after running out of memory/);
  assert.match(out.bulk.error, OUT_OF_MEMORY);
  assert.equal(out.ok.value, 1);
});

test('max flow: an out-of-memory solveSync throws and keeps the graph', { skip }, () => {
  const out = runCapped(`
    const m = new SimpleMaxFlow();
    m.addArcWithCapacity(2e9, 0, 1);
    attempt('solve', () => m.solveSync(0, 2e9));
    attempt('result', () => m.optimalFlow());
    attempt('arcs', () => m.numArcs());`);
  assert.equal(out.solve.type, 'RangeError');
  assert.match(out.solve.error, OUT_OF_MEMORY);
  assert.match(out.result.error, /No SimpleMaxFlow result/);
  assert.equal(out.arcs.value, 1);
});

test('assignment: an out-of-memory async solve rejects and keeps the graph', { skip }, () => {
  const out = runCapped(`
    const a = new SimpleLinearSumAssignment();
    a.addArcWithCost(1e9, 1e9, 1);
    try { out.solve = { value: await a.solve() }; } catch (e) { out.solve = { error: e.message, type: e.name }; }
    attempt('busy', () => a.busy);
    attempt('result', () => a.optimalCost());
    attempt('arcs', () => a.numArcs());
    attempt('sync', () => a.solveSync());`);
  assert.match(out.solve.error, OUT_OF_MEMORY);
  assert.equal(out.solve.type, 'RangeError'); // same error type as the synchronous paths
  assert.equal(out.busy.value, false);
  assert.match(out.result.error, /No SimpleLinearSumAssignment result/);
  assert.equal(out.arcs.value, 1);
  assert.match(out.sync.error, OUT_OF_MEMORY);
});

test('bulk adders: a huge sparse array throws instead of aborting', { skip }, () => {
  const out = runCapped(`
    const sparse = []; sparse.length = 2 ** 32 - 1;
    const m = new SimpleMaxFlow();
    attempt('sparse', () => m.addArcsWithCapacity(sparse, sparse, sparse));
    attempt('after', () => m.numArcs());`);
  assert.equal(out.sparse.type, 'TypeError'); // the first hole, before any large allocation
  assert.match(out.sparse.error, /^tails\[0\] must be an integer/);
  assert.equal(out.after.value, 0);
});
