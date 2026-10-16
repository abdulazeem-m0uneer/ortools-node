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
// Only Linux enforces RLIMIT_AS (`ulimit -v`); macOS rejects or ignores it.
const skip = process.platform !== 'linux' && 'needs Linux ulimit -v (RLIMIT_AS)';

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

// OR-Tools builds the max-flow / min-cost-flow graph with malloc + CHECK (not
// std::bad_alloc), so a solve on a graph too large for memory must be refused
// before OR-Tools allocates. 60M arcs fit in the capped child but their
// solve does not.
test('max flow and min cost flow: a solve too large for memory throws, sync and async', { skip }, () => {
  const out = runCapped(`
    const chunk = 1000000, arcs = 60000000;
    const tails = new Int32Array(chunk).map((_, i) => i % 1000);
    const heads = new Int32Array(chunk).map((_, i) => (i * 7 + 1) % 1000);
    const capacities = new Int32Array(chunk).fill(5);
    const settle = async (name, p) => { try { out[name] = { value: await p }; } catch (e) { out[name] = { type: e.name, error: e.message }; } };

    const mf = new SimpleMaxFlow();
    for (let n = 0; n < arcs; n += chunk) mf.addArcsWithCapacity(tails, heads, capacities);
    attempt('maxFlowSync', () => mf.solveSync(0, 999));
    await settle('maxFlowAsync', mf.solve(0, 999));
    attempt('maxFlowArcs', () => mf.numArcs());
    mf.dispose();

    const mcf = new SimpleMinCostFlow();
    for (let n = 0; n < arcs; n += chunk) mcf.addArcsWithCapacityAndUnitCost(tails, heads, capacities, capacities);
    mcf.setNodesSupplies([0, 999], [5, -5]);
    attempt('minCostSync', () => mcf.solveSync());
    await settle('minCostAsync', mcf.solve());
    attempt('minCostArcs', () => mcf.numArcs());`);
  for (const name of ['maxFlowSync', 'maxFlowAsync', 'minCostSync', 'minCostAsync']) {
    assert.equal(out[name].type, 'RangeError', name);
    assert.match(out[name].error, OUT_OF_MEMORY, name);
  }
  assert.equal(out.maxFlowArcs.value, 60000000);
  assert.equal(out.minCostArcs.value, 60000000);
});
