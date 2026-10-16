'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { SimpleMaxFlow } = require('..');
const { MAX_FLOW_SAMPLE: SAMPLE, netOutflow } = require('./graph_fixtures');

function sampleFlow(convert = (a) => a) {
  const m = new SimpleMaxFlow();
  m.addArcsWithCapacity(convert(SAMPLE.tails), convert(SAMPLE.heads), convert(SAMPLE.capacities));
  return m;
}

function assertSampleSolution(m) {
  assert.equal(m.optimalFlow(), SAMPLE.optimalFlow);
  const flows = m.flows();
  flows.forEach((flow, arc) => {
    assert.ok(flow >= 0 && flow <= SAMPLE.capacities[arc], `arc ${arc} flow ${flow} within capacity`);
    assert.equal(m.flow(arc), flow);
  });
  const net = netOutflow(5, SAMPLE.tails, SAMPLE.heads, flows);
  assert.deepEqual(net, [60, 0, 0, 0, -60]);
}

test('max flow: docs sample solves to 60 (async)', async () => {
  const m = sampleFlow();
  assert.equal(await m.solve(SAMPLE.source, SAMPLE.sink), 'OPTIMAL');
  assertSampleSolution(m);
});

test('max flow: docs sample solves to 60 (sync), one arc at a time', () => {
  const m = new SimpleMaxFlow();
  SAMPLE.tails.forEach((tail, i) => {
    assert.equal(m.addArcWithCapacity(tail, SAMPLE.heads[i], SAMPLE.capacities[i]), i);
  });
  assert.equal(m.solveSync(SAMPLE.source, SAMPLE.sink), m.OPTIMAL);
  assertSampleSolution(m);
});

test('max flow: the min cut separates source and sink and its capacity is the flow', () => {
  const m = sampleFlow();
  m.solveSync(SAMPLE.source, SAMPLE.sink);
  const sourceSide = new Set(m.getSourceSideMinCut());
  const sinkSide = new Set(m.getSinkSideMinCut());
  assert.ok(m.getSourceSideMinCut() instanceof Int32Array);
  assert.ok(sourceSide.has(SAMPLE.source) && !sourceSide.has(SAMPLE.sink));
  assert.ok(sinkSide.has(SAMPLE.sink) && !sinkSide.has(SAMPLE.source));
  const cutCapacity = SAMPLE.tails.reduce((sum, tail, arc) =>
    sum + (sourceSide.has(tail) && !sourceSide.has(SAMPLE.heads[arc]) ? SAMPLE.capacities[arc] : 0), 0);
  assert.equal(cutCapacity, SAMPLE.optimalFlow);
});

test('max flow: typed and plain arrays give identical results', () => {
  const plain = sampleFlow();
  plain.solveSync(0, 4);
  const converters = [
    (a) => Int32Array.from(a),
    (a) => Uint32Array.from(a),
    (a) => Float64Array.from(a),
    (a) => BigInt64Array.from(a.map(BigInt)),
  ];
  for (const convert of converters) {
    const m = sampleFlow(convert);
    assert.equal(m.solveSync(0, 4), 'OPTIMAL');
    assert.deepEqual(m.flows(), plain.flows());
    assert.deepEqual(m.getSourceSideMinCut(), plain.getSourceSideMinCut());
  }
});

test('max flow: user data accessors and bulk indices', () => {
  const m = sampleFlow();
  assert.equal(m.numNodes(), 5);
  assert.equal(m.numArcs(), 9);
  assert.equal(m.tail(3), 1);
  assert.equal(m.head(3), 2);
  assert.equal(m.capacity(3), 40);
  assert.deepEqual([...m.addArcsWithCapacity([4], [5], [1])], [9]);
  assert.equal(m.numNodes(), 6);
});

test('max flow: source equals sink is BAD_INPUT with no result', () => {
  const m = sampleFlow();
  assert.equal(m.solveSync(2, 2), 'BAD_INPUT');
  assert.throws(() => m.optimalFlow(), /No SimpleMaxFlow result/);
  assert.throws(() => m.getSourceSideMinCut(), /No SimpleMaxFlow result/);
});

test('max flow: source or sink outside the graph gives a flow of 0', () => {
  const m = sampleFlow();
  assert.equal(m.solveSync(0, 99), 'OPTIMAL');
  assert.equal(m.optimalFlow(), 0);
  assert.deepEqual(m.flows(), new Array(9).fill(0));
  // OR-Tools builds no flow network then, so both cuts are empty, even though
  // the source itself and the nodes it reaches are in the graph.
  assert.deepEqual([...m.getSourceSideMinCut()], []);
  assert.deepEqual([...m.getSinkSideMinCut()], []);
  const path = new SimpleMaxFlow();
  path.addArcsWithCapacity([0, 1], [1, 2], [5, 5]);
  assert.equal(path.solveSync(0, 7), 'OPTIMAL');
  assert.deepEqual([...path.getSourceSideMinCut()], []);
  assert.equal(path.solveSync(7, 2), 'OPTIMAL');
  assert.deepEqual([...path.getSinkSideMinCut()], []);
});

test('max flow: empty graph, single self loop, zero capacities', () => {
  const empty = new SimpleMaxFlow();
  assert.equal(empty.numNodes(), 0);
  assert.equal(empty.solveSync(0, 1), 'OPTIMAL');
  assert.equal(empty.optimalFlow(), 0);
  assert.deepEqual(empty.flows(), []);

  const loop = new SimpleMaxFlow();
  loop.addArcWithCapacity(0, 0, 5);
  assert.equal(loop.solveSync(0, 0), 'BAD_INPUT');

  const zero = new SimpleMaxFlow();
  zero.addArcsWithCapacity([0, 1], [1, 2], [0, 10]);
  assert.equal(zero.solveSync(0, 2), 'OPTIMAL');
  assert.equal(zero.optimalFlow(), 0);
  zero.setArcCapacity(0, 7);
  assert.throws(() => zero.optimalFlow(), /No SimpleMaxFlow result/);
  assert.equal(zero.solveSync(0, 2), 'OPTIMAL');
  assert.equal(zero.optimalFlow(), 7);
  assert.deepEqual(zero.flows([1, 0]), [7, 7]);
});

test('max flow: flow above int64 is POSSIBLE_OVERFLOW, never wrapped', () => {
  const m = new SimpleMaxFlow();
  m.addArcWithCapacity(0, 1, Infinity);
  m.addArcWithCapacity(0, 1, 2n ** 63n - 1n);
  assert.equal(m.capacity(0), Infinity);
  assert.equal(m.solveSync(0, 1), 'POSSIBLE_OVERFLOW');
  assert.throws(() => m.optimalFlow(), /No SimpleMaxFlow result/);
  m.setArcCapacity(1, 0);
  assert.equal(m.solveSync(0, 1), 'OPTIMAL');
  assert.equal(m.optimalFlow(), Infinity);
});

test('max flow: the largest node index is accepted without solving', () => {
  const m = new SimpleMaxFlow();
  m.addArcWithCapacity(2 ** 31 - 3, 0, 1);
  assert.equal(m.numNodes(), 2 ** 31 - 2);
  assert.throws(() => m.addArcWithCapacity(2 ** 31 - 2, 0, 1), RangeError);
});

test('max flow: misuse throws instead of aborting', () => {
  const m = sampleFlow();
  const cases = [
    [() => m.addArcWithCapacity(-1, 0, 1), RangeError],
    [() => m.addArcWithCapacity(0, 0.5, 1), TypeError],
    [() => m.addArcWithCapacity(0, 1, -1), RangeError],
    [() => m.addArcWithCapacity(0, 1, NaN), TypeError],
    [() => m.addArcWithCapacity(0, 1, '1'), TypeError],
    [() => m.addArcWithCapacity(0, 1, -(2n ** 63n)), RangeError],
    [() => m.addArcsWithCapacity([0], [1, 2], [1]), RangeError],
    [() => m.addArcsWithCapacity([0], [1], [-5]), RangeError],
    [() => m.addArcsWithCapacity([0], [2 ** 31], [1]), RangeError],
    [() => m.addArcsWithCapacity({ length: 1, 0: 0 }, [1], [1]), TypeError],
    [() => m.setArcCapacity(9, 1), RangeError],
    [() => m.setArcCapacity(0, -1), RangeError],
    [() => m.solveSync(-1, 4), RangeError],
    [() => m.solveSync(0, 2 ** 31), RangeError],
    [() => m.solveSync(0), TypeError],
    [() => m.solve(0.5, 4), TypeError],
    [() => m.tail(9), RangeError],
    [() => m.head(9), RangeError],
    [() => m.capacity(-1), RangeError],
  ];
  for (const [call, errorType] of cases) assert.throws(call, errorType, call.toString());
  assert.equal(m.numArcs(), 9);
  assert.equal(m.numNodes(), 5);
  assert.equal(m.capacity(0), 20);
  assert.equal(m.busy, false);
  m.solveSync(0, 4);
  assert.throws(() => m.flow(9), RangeError);
  assert.throws(() => m.flows([9]), RangeError);
});
