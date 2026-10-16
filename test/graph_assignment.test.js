'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { SimpleLinearSumAssignment } = require('..');
const { ASSIGNMENT_SAMPLE: SAMPLE, matrixArcs } = require('./graph_fixtures');

function sampleAssignment(convert = (a) => a) {
  const a = new SimpleLinearSumAssignment();
  const arcs = matrixArcs(SAMPLE.costs);
  a.addArcsWithCost(convert(arcs.lefts), convert(arcs.rights), convert(arcs.costs));
  return a;
}

function assertSampleSolution(a) {
  assert.equal(a.optimalCost(), SAMPLE.optimalCost);
  const mates = [0, 1, 2, 3].map((left) => a.rightMate(left));
  assert.deepEqual([...mates].sort(), [0, 1, 2, 3]);
  let total = 0;
  mates.forEach((right, left) => {
    assert.equal(a.assignmentCost(left), SAMPLE.costs[left][right]);
    total += a.assignmentCost(left);
  });
  assert.equal(total, SAMPLE.optimalCost);
}

test('assignment: docs sample costs 265 (async)', async () => {
  const a = sampleAssignment();
  assert.equal(await a.solve(), 'OPTIMAL');
  assertSampleSolution(a);
});

test('assignment: docs sample costs 265 (sync), one arc at a time', () => {
  const a = new SimpleLinearSumAssignment();
  let expectedArc = 0;
  SAMPLE.costs.forEach((row, i) => row.forEach((cost, j) => {
    assert.equal(a.addArcWithCost(i, j, cost), expectedArc++);
  }));
  assert.equal(a.solveSync(), a.OPTIMAL);
  assertSampleSolution(a);
});

test('assignment: typed and plain arrays give identical results', () => {
  const plain = sampleAssignment();
  plain.solveSync();
  const converters = [
    (a) => Int32Array.from(a),
    (a) => Uint32Array.from(a),
    (a) => Float64Array.from(a),
    (a) => BigInt64Array.from(a.map(BigInt)),
  ];
  for (const convert of converters) {
    const a = sampleAssignment(convert);
    assert.equal(a.solveSync(), 'OPTIMAL');
    assert.equal(a.optimalCost(), plain.optimalCost());
    for (let left = 0; left < 4; left++) assert.equal(a.rightMate(left), plain.rightMate(left));
  }
});

test('assignment: user data accessors and bulk indices', () => {
  const a = sampleAssignment();
  assert.equal(a.numNodes(), 4);
  assert.equal(a.numArcs(), 16);
  assert.equal(a.leftNode(6), 1);
  assert.equal(a.rightNode(6), 2);
  assert.equal(a.cost(6), 55);
  const arcs = a.addArcsWithCost([4], [4], [-3]);
  assert.ok(arcs instanceof Int32Array);
  assert.deepEqual([...arcs], [16]);
  assert.equal(a.numNodes(), 5);
});

test('assignment: empty graph and a single node', () => {
  const empty = new SimpleLinearSumAssignment();
  assert.equal(empty.solveSync(), 'OPTIMAL');
  assert.equal(empty.optimalCost(), 0);
  assert.throws(() => empty.rightMate(0), RangeError);

  const single = new SimpleLinearSumAssignment();
  single.addArcWithCost(0, 0, -42);
  assert.equal(single.solveSync(), 'OPTIMAL');
  assert.equal(single.optimalCost(), -42);
  assert.equal(single.rightMate(0), 0);
});

test('assignment: no perfect matching is INFEASIBLE with no result', () => {
  // Left node 1 has no arc.
  const a = new SimpleLinearSumAssignment();
  a.addArcWithCost(0, 1, 1);
  assert.equal(a.solveSync(), 'INFEASIBLE');
  assert.throws(() => a.optimalCost(), /No SimpleLinearSumAssignment result/);
  assert.throws(() => a.rightMate(0), /No SimpleLinearSumAssignment result/);
  // Left nodes 0 and 1 both reach only right node 0.
  const b = new SimpleLinearSumAssignment();
  b.addArcsWithCost([0, 1, 2, 2], [0, 0, 1, 2], [1, 1, 1, 1]);
  assert.equal(b.solveSync(), 'INFEASIBLE');
  assert.throws(() => b.rightMate(0), /No SimpleLinearSumAssignment result/);
});

test('assignment: results never go stale', () => {
  const a = sampleAssignment();
  assert.throws(() => a.optimalCost(), /call solve\(\) first/);
  a.solveSync();
  a.addArcWithCost(0, 0, 1000); // does not change the optimum
  assert.throws(() => a.optimalCost(), /No SimpleLinearSumAssignment result/);
  assert.throws(() => a.assignmentCost(0), /No SimpleLinearSumAssignment result/);
  a.solveSync();
  a.addArcsWithCost([], [], []);
  assert.throws(() => a.rightMate(0), /No SimpleLinearSumAssignment result/);
  assert.equal(a.solveSync(), 'OPTIMAL');
  assert.equal(a.optimalCost(), 265);
});

test('assignment: cost magnitudes that overflow scaling are POSSIBLE_OVERFLOW', () => {
  for (const cost of [2n ** 62n, -(2n ** 62n), 2n ** 63n - 1n, -(2n ** 63n)]) {
    const a = new SimpleLinearSumAssignment();
    a.addArcWithCost(0, 0, cost);
    assert.equal(a.solveSync(), 'POSSIBLE_OVERFLOW', `cost ${cost}`);
    assert.throws(() => a.optimalCost(), /No SimpleLinearSumAssignment result/);
  }
  // Costs beyond int64 max / (numNodes + 1) are rejected before OR-Tools scales them.
  const limit = (2n ** 63n - 1n) / 3n;
  for (const cost of [limit + 1n, -limit - 1n]) {
    const a = new SimpleLinearSumAssignment();
    a.addArcsWithCost([0, 1], [1, 0], [0, 0]);
    a.addArcWithCost(0, 0, cost);
    assert.equal(a.solveSync(), 'POSSIBLE_OVERFLOW', `cost ${cost}`);
  }
  // OR-Tools' own price bounds reject costs under that limit too: 2^61 < 2^63 / 2.
  const single = new SimpleLinearSumAssignment();
  single.addArcWithCost(0, 0, 2n ** 61n);
  assert.equal(single.solveSync(), 'POSSIBLE_OVERFLOW');
  // Large costs well inside the range solve exactly.
  const a = new SimpleLinearSumAssignment();
  a.addArcsWithCost([0, 0, 1, 1], [0, 1, 0, 1], [2 ** 40, -(2 ** 40), -(2 ** 40), 2 ** 40]);
  assert.equal(a.solveSync(), 'OPTIMAL');
  assert.equal(a.optimalCost(), -(2 ** 41));
});

test('assignment: node index limits', () => {
  const a = new SimpleLinearSumAssignment();
  a.addArcWithCost(2 ** 30 - 2, 0, 1);
  assert.equal(a.numNodes(), 2 ** 30 - 1);
  assert.throws(() => a.addArcWithCost(2 ** 30 - 1, 0, 1), RangeError);
  assert.throws(() => a.addArcsWithCost([0], [2 ** 30 - 1], [1]), RangeError);
});

test('assignment: misuse throws instead of aborting', () => {
  const a = sampleAssignment();
  const cases = [
    [() => a.addArcWithCost(-1, 0, 1), RangeError],
    [() => a.addArcWithCost(0, 1.5, 1), TypeError],
    [() => a.addArcWithCost(0, 0, 0.5), TypeError],
    [() => a.addArcWithCost(0, 0, Infinity), TypeError],
    [() => a.addArcWithCost(0, 0, 2 ** 53), RangeError],
    [() => a.addArcWithCost(0, 0, 2n ** 63n), RangeError],
    [() => a.addArcWithCost(0, 0), TypeError],
    [() => a.addArcsWithCost([0, 1], [0], [1, 1]), RangeError],
    [() => a.addArcsWithCost([0], [0], [1, 2]), RangeError],
    [() => a.addArcsWithCost([0], [-1], [1]), RangeError],
    [() => a.addArcsWithCost(null, [0], [1]), TypeError],
    [() => a.leftNode(16), RangeError],
    [() => a.rightNode(-1), RangeError],
    [() => a.cost(16), RangeError],
  ];
  for (const [call, errorType] of cases) assert.throws(call, errorType, call.toString());
  assert.equal(a.numArcs(), 16);
  assert.equal(a.numNodes(), 4);
  a.solveSync();
  assert.throws(() => a.rightMate(4), RangeError);
  assert.throws(() => a.assignmentCost(-1), RangeError);
  assert.throws(() => a.rightMate('0'), TypeError);
});
