'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { SimpleMinCostFlow } = require('..');
const { MIN_COST_FLOW_SAMPLE: SAMPLE, netOutflow } = require('./graph_fixtures');

const INT64_MAX = 2n ** 63n - 1n;
const INT64_MIN = -(2n ** 63n);

function sampleFlow(convert = (a) => a) {
  const m = new SimpleMinCostFlow();
  m.addArcsWithCapacityAndUnitCost(
    convert(SAMPLE.tails, 'index'), convert(SAMPLE.heads, 'index'),
    convert(SAMPLE.capacities, 'int64'), convert(SAMPLE.unitCosts, 'int64'));
  m.setNodesSupplies(convert(SAMPLE.supplies.map((_, i) => i), 'index'), convert(SAMPLE.supplies, 'int64'));
  return m;
}

function assertSampleSolution(m) {
  assert.equal(m.optimalCost(), SAMPLE.optimalCost);
  assert.equal(m.maximumFlow(), 20);
  const flows = m.flows();
  assert.equal(flows.length, SAMPLE.tails.length);
  flows.forEach((flow, arc) => {
    assert.ok(flow >= 0 && flow <= SAMPLE.capacities[arc], `arc ${arc} flow ${flow} within capacity`);
    assert.equal(m.flow(arc), flow);
  });
  assert.deepEqual(netOutflow(5, SAMPLE.tails, SAMPLE.heads, flows), SAMPLE.supplies);
  const cost = flows.reduce((sum, flow, arc) => sum + flow * SAMPLE.unitCosts[arc], 0);
  assert.equal(cost, SAMPLE.optimalCost);
}

test('min cost flow: docs sample solves to 150 (async)', async () => {
  const m = sampleFlow();
  assert.equal(await m.solve(), 'OPTIMAL');
  assertSampleSolution(m);
});

test('min cost flow: docs sample solves to 150 (sync), one arc at a time', () => {
  const m = new SimpleMinCostFlow();
  SAMPLE.tails.forEach((tail, i) => {
    assert.equal(m.addArcWithCapacityAndUnitCost(tail, SAMPLE.heads[i], SAMPLE.capacities[i], SAMPLE.unitCosts[i]), i);
  });
  SAMPLE.supplies.forEach((supply, node) => m.setNodeSupply(node, supply));
  assert.equal(m.solveSync(), m.OPTIMAL);
  assertSampleSolution(m);
});

test('min cost flow: typed and plain arrays give identical results', () => {
  const plain = sampleFlow();
  plain.solveSync();
  const variants = [
    (a, kind) => (kind === 'index' ? Int32Array.from(a) : Float64Array.from(a)),
    (a, kind) => (kind === 'index' ? Uint32Array.from(a) : BigInt64Array.from(a.map(BigInt))),
    (a) => a.map(BigInt),
    (a) => Float64Array.from(a),
  ];
  for (const convert of variants) {
    const m = sampleFlow(convert);
    assert.equal(m.solveSync(), 'OPTIMAL');
    assert.deepEqual(m.flows(), plain.flows());
    assert.equal(m.optimalCost(), plain.optimalCost());
  }
});

test('min cost flow: user data accessors read back the graph', () => {
  const m = sampleFlow();
  assert.equal(m.numNodes(), 5);
  assert.equal(m.numArcs(), 9);
  assert.equal(m.tail(4), 1);
  assert.equal(m.head(4), 4);
  assert.equal(m.capacity(4), 10);
  assert.equal(m.unitCost(4), 6);
  assert.equal(m.supply(4), -15);
});

test('min cost flow: bulk adders return the new arc indices', () => {
  const m = new SimpleMinCostFlow();
  m.addArcWithCapacityAndUnitCost(0, 1, 1, 1);
  const arcs = m.addArcsWithCapacityAndUnitCost([1, 2], [2, 3], [1, 1], [1, 1]);
  assert.ok(arcs instanceof Int32Array);
  assert.deepEqual([...arcs], [1, 2]);
  assert.deepEqual([...m.addArcsWithCapacityAndUnitCost([], [], [], [])], []);
  assert.equal(m.numArcs(), 3);
});

test('min cost flow: flows(arcs) selects arcs in the given order', () => {
  const m = sampleFlow();
  m.solveSync();
  const all = m.flows();
  assert.deepEqual(m.flows([8, 0, 0]), [all[8], all[0], all[0]]);
  assert.deepEqual(m.flows(Int32Array.of(3)), [all[3]]);
  assert.deepEqual(m.flows([]), []);
});

test('min cost flow: empty graph is OPTIMAL with nothing to read', () => {
  const m = new SimpleMinCostFlow();
  assert.equal(m.numNodes(), 0);
  assert.equal(m.solveSync(), 'OPTIMAL');
  assert.equal(m.optimalCost(), 0);
  assert.equal(m.maximumFlow(), 0);
  assert.deepEqual(m.flows(), []);
});

test('min cost flow: single node with zero supply, and a self loop', () => {
  const m = new SimpleMinCostFlow();
  m.setNodeSupply(0, 0);
  assert.equal(m.numNodes(), 1);
  assert.equal(m.solveSync(), 'OPTIMAL');
  m.addArcWithCapacityAndUnitCost(0, 0, 5, -3);
  assert.equal(m.solveSync(), 'OPTIMAL');
  // A negative-cost self loop is a negative cycle: saturating it is optimal.
  assert.equal(m.flow(0), 5);
  assert.equal(m.optimalCost(), -15);
});

test('min cost flow: unbalanced supplies', () => {
  const m = new SimpleMinCostFlow();
  m.addArcWithCapacityAndUnitCost(0, 1, 10, 2);
  m.setNodeSupply(0, 7);
  m.setNodeSupply(1, -4);
  assert.equal(m.solveSync(), 'UNBALANCED');
  assert.throws(() => m.optimalCost(), /No SimpleMinCostFlow result/);
  assert.throws(() => m.flows(), /No SimpleMinCostFlow result/);
  // Max flow with min cost sends what it can.
  assert.equal(m.solveMaxFlowWithMinCostSync(), 'OPTIMAL');
  assert.equal(m.maximumFlow(), 4);
  assert.equal(m.optimalCost(), 8);
  assert.deepEqual(m.flows(), [4]);
});

test('min cost flow: zero-capacity arcs carry nothing and can make it INFEASIBLE', async () => {
  const m = new SimpleMinCostFlow();
  m.addArcWithCapacityAndUnitCost(0, 1, 0, 1);
  m.addArcWithCapacityAndUnitCost(0, 1, 3, 5);
  m.setNodesSupplies([0, 1], [3, -3]);
  assert.equal(m.solveSync(), 'OPTIMAL');
  assert.deepEqual(m.flows(), [0, 3]);
  m.setArcCapacity(1, 0);
  assert.equal(m.capacity(1), 0);
  assert.equal(await m.solve(), 'INFEASIBLE');
  assert.throws(() => m.flow(0), /No SimpleMinCostFlow result/);
  assert.equal(await m.solveMaxFlowWithMinCost(), 'OPTIMAL');
  assert.equal(m.maximumFlow(), 0);
});

test('min cost flow: negative unit costs are allowed', () => {
  const m = new SimpleMinCostFlow();
  m.addArcWithCapacityAndUnitCost(0, 1, 2, -7);
  m.setNodesSupplies([0, 1], [2, -2]);
  assert.equal(m.solveSync(), 'OPTIMAL');
  assert.equal(m.optimalCost(), -14);
});

test('min cost flow: results never go stale', () => {
  const m = sampleFlow();
  assert.throws(() => m.optimalCost(), /call solve\(\) first/);
  m.solveSync();
  assert.equal(m.optimalCost(), 150);
  const mutations = [
    () => m.setArcCapacity(0, 15),
    () => m.setNodeSupply(0, 20),
    () => m.setNodesSupplies([], []),
    () => m.addArcWithCapacityAndUnitCost(0, 1, 0, 0),
    () => m.addArcsWithCapacityAndUnitCost([], [], [], []),
  ];
  for (const mutate of mutations) {
    m.solveSync();
    mutate();
    assert.throws(() => m.optimalCost(), /No SimpleMinCostFlow result/);
    assert.throws(() => m.maximumFlow(), /No SimpleMinCostFlow result/);
    assert.throws(() => m.flow(0), /No SimpleMinCostFlow result/);
    assert.throws(() => m.flows(), /No SimpleMinCostFlow result/);
  }
  assert.equal(m.solveSync(), 'OPTIMAL');
  assert.equal(m.optimalCost(), 150);
});

test('min cost flow: Infinity capacity means int64 max and still solves', () => {
  const m = new SimpleMinCostFlow();
  m.addArcWithCapacityAndUnitCost(0, 1, Infinity, 1);
  m.addArcWithCapacityAndUnitCost(0, 1, INT64_MAX, 2);
  assert.equal(m.capacity(0), Infinity);
  assert.equal(m.capacity(1), Infinity);
  m.setNodesSupplies([0, 1], [10, -10]);
  assert.equal(m.solveSync(), 'OPTIMAL');
  assert.deepEqual(m.flows(), [10, 0]);
});

test('min cost flow: int64 extremes are reported, never wrapped', () => {
  for (const [cost, readBack] of [[INT64_MAX, Infinity], [INT64_MIN, -Infinity], [2n ** 62n, RangeError]]) {
    const m = new SimpleMinCostFlow();
    m.addArcWithCapacityAndUnitCost(0, 1, 10, cost);
    m.setNodesSupplies([0, 1], [10, -10]);
    assert.equal(m.solveSync(), 'BAD_COST_RANGE', `unit cost ${cost}`);
    // int64 max / min read back as +-Infinity; other unsafe values throw.
    if (readBack === RangeError) assert.throws(() => m.unitCost(0), RangeError);
    else assert.equal(m.unitCost(0), readBack);
  }
  // Supplies whose totals overflow int64.
  const m = new SimpleMinCostFlow();
  m.setNodeSupply(0, 2n ** 62n);
  m.setNodeSupply(1, 2n ** 62n);
  m.setNodeSupply(2, -(2n ** 62n));
  m.setNodeSupply(3, -(2n ** 62n));
  assert.equal(m.solveSync(), 'BAD_CAPACITY_RANGE');
  assert.equal(m.solveMaxFlowWithMinCostSync(), 'BAD_CAPACITY_RANGE');
  // Each side is checked on its own, up to a total of exactly int64 max.
  const totals = (supplies) => {
    const flow = new SimpleMinCostFlow();
    supplies.forEach((supply, node) => flow.setNodeSupply(node, supply));
    return [flow.solveSync(), flow.solveMaxFlowWithMinCostSync()];
  };
  assert.deepEqual(totals([1, -(2n ** 62n), -(2n ** 62n)]), ['BAD_CAPACITY_RANGE', 'BAD_CAPACITY_RANGE']);
  assert.deepEqual(totals([1, -(2n ** 62n), -(2n ** 62n) + 1n]), ['UNBALANCED', 'OPTIMAL']);
  assert.deepEqual(totals([INT64_MAX, 1, -INT64_MAX]), ['BAD_CAPACITY_RANGE', 'BAD_CAPACITY_RANGE']);
  assert.deepEqual(totals([INT64_MAX - 1n, 1, -INT64_MAX]), ['INFEASIBLE', 'OPTIMAL']);
  // A safe-range total cost is exact.
  const big = new SimpleMinCostFlow();
  big.addArcWithCapacityAndUnitCost(0, 1, 2 ** 20, 2 ** 30);
  big.setNodesSupplies([0, 1], [2 ** 20, -(2 ** 20)]);
  assert.equal(big.solveSync(), 'OPTIMAL');
  assert.equal(big.optimalCost(), 2 ** 50);
});

test('min cost flow: misuse throws instead of aborting', () => {
  const m = sampleFlow();
  const cases = [
    [() => m.addArcWithCapacityAndUnitCost(-1, 0, 1, 1), RangeError],
    [() => m.addArcWithCapacityAndUnitCost(0, 1.5, 1, 1), TypeError],
    [() => m.addArcWithCapacityAndUnitCost(NaN, 0, 1, 1), TypeError],
    [() => m.addArcWithCapacityAndUnitCost('0', 0, 1, 1), TypeError],
    [() => m.addArcWithCapacityAndUnitCost(2 ** 31, 0, 1, 1), RangeError],
    [() => m.addArcWithCapacityAndUnitCost(2 ** 31 - 4, 0, 1, 1), RangeError],
    // numNodes() + numArcs() would pass 2^31 - 4 (checked before allocating).
    [() => m.addArcWithCapacityAndUnitCost(0, 2 ** 31 - 5, 1, 1), RangeError],
    [() => m.addArcsWithCapacityAndUnitCost([0], [2 ** 31 - 5], [1], [1]), RangeError],
    [() => m.setNodeSupply(2 ** 31 - 5, 1), RangeError],
    [() => m.setNodesSupplies([2 ** 31 - 5], [1]), RangeError],
    [() => m.addArcWithCapacityAndUnitCost(0, 1, -1, 1), RangeError],
    [() => m.addArcWithCapacityAndUnitCost(0, 1, 1, 0.5), TypeError],
    [() => m.addArcWithCapacityAndUnitCost(0, 1, 1, Infinity), TypeError],
    [() => m.addArcWithCapacityAndUnitCost(0, 1, 1, 2 ** 60), RangeError],
    [() => m.addArcWithCapacityAndUnitCost(0, 1, 1, INT64_MAX + 1n), RangeError],
    [() => m.addArcWithCapacityAndUnitCost(0, 1), TypeError],
    [() => m.addArcsWithCapacityAndUnitCost([0, 1], [1], [1, 1], [1, 1]), RangeError],
    [() => m.addArcsWithCapacityAndUnitCost([0], [1], [-1], [1]), RangeError],
    [() => m.addArcsWithCapacityAndUnitCost([0], [-1], [1], [1]), RangeError],
    [() => m.addArcsWithCapacityAndUnitCost(Int32Array.of(-1), [1], [1], [1]), RangeError],
    [() => m.addArcsWithCapacityAndUnitCost([0], [1], [1], [Infinity]), TypeError],
    [() => m.addArcsWithCapacityAndUnitCost('0', [1], [1], [1]), TypeError],
    [() => m.addArcsWithCapacityAndUnitCost(new Int8Array(1), [1], [1], [1]), TypeError],
    [() => m.setArcCapacity(9, 1), RangeError],
    [() => m.setArcCapacity(0, -1), RangeError],
    [() => m.setNodeSupply(-1, 1), RangeError],
    [() => m.setNodeSupply(0, INT64_MIN), RangeError],
    [() => m.setNodesSupplies([0, 1], [1]), RangeError],
    [() => m.setNodesSupplies([0], [INT64_MIN]), RangeError],
    [() => m.setNodesSupplies([2 ** 31], [1]), RangeError],
    [() => m.tail(9), RangeError],
    [() => m.head(-1), RangeError],
    [() => m.capacity(9), RangeError],
    [() => m.unitCost(100), RangeError],
    [() => m.supply(5), RangeError],
  ];
  for (const [call, errorType] of cases) assert.throws(call, errorType, call.toString());
  // Validation happens before any change: the graph is untouched.
  assert.equal(m.numArcs(), 9);
  assert.equal(m.numNodes(), 5);
  assert.equal(m.supply(0), 20);
  assert.equal(m.capacity(0), 15);
  m.solveSync();
  assert.throws(() => m.flow(9), RangeError);
  assert.throws(() => m.flows([0, 9]), RangeError);
  assert.throws(() => m.flows([0.5]), TypeError);
});
