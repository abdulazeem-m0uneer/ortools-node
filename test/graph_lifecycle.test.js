'use strict';
const { test } = require('node:test');
const v8 = require('node:v8');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const ortools = require('..');
const { SimpleMinCostFlow, SimpleMaxFlow, SimpleLinearSumAssignment } = ortools;
const {
  MIN_COST_FLOW_SAMPLE, MAX_FLOW_SAMPLE, ASSIGNMENT_SAMPLE, matrixArcs, seededRandom, randomInt,
} = require('./graph_fixtures');

// One entry per class: how to build a solvable graph, solve it, mutate it and
// read a result, so every lifecycle rule is checked on all three.
const KINDS = [
  {
    Class: SimpleMinCostFlow,
    statuses: ['NOT_SOLVED', 'OPTIMAL', 'FEASIBLE', 'INFEASIBLE', 'UNBALANCED', 'BAD_RESULT', 'BAD_COST_RANGE',
      'BAD_CAPACITY_RANGE'],
    build() {
      const m = new SimpleMinCostFlow();
      const s = MIN_COST_FLOW_SAMPLE;
      m.addArcsWithCapacityAndUnitCost(s.tails, s.heads, s.capacities, s.unitCosts);
      m.setNodesSupplies([0, 1, 2, 3, 4], s.supplies);
      return m;
    },
    solve: (m) => m.solve(),
    solveSync: (m) => m.solveSync(),
    mutate: (m) => m.addArcWithCapacityAndUnitCost(0, 1, 1, 1),
    read: (m) => m.numArcs(),
    result: (m) => m.optimalCost(),
    expected: MIN_COST_FLOW_SAMPLE.optimalCost,
  },
  {
    Class: SimpleMaxFlow,
    statuses: ['OPTIMAL', 'POSSIBLE_OVERFLOW', 'BAD_INPUT', 'BAD_RESULT'],
    build() {
      const m = new SimpleMaxFlow();
      m.addArcsWithCapacity(MAX_FLOW_SAMPLE.tails, MAX_FLOW_SAMPLE.heads, MAX_FLOW_SAMPLE.capacities);
      return m;
    },
    solve: (m) => m.solve(0, 4),
    solveSync: (m) => m.solveSync(0, 4),
    mutate: (m) => m.addArcWithCapacity(0, 1, 1),
    read: (m) => m.numArcs(),
    result: (m) => m.optimalFlow(),
    expected: MAX_FLOW_SAMPLE.optimalFlow,
  },
  {
    Class: SimpleLinearSumAssignment,
    statuses: ['OPTIMAL', 'INFEASIBLE', 'POSSIBLE_OVERFLOW'],
    build() {
      const a = new SimpleLinearSumAssignment();
      const arcs = matrixArcs(ASSIGNMENT_SAMPLE.costs);
      a.addArcsWithCost(arcs.lefts, arcs.rights, arcs.costs);
      return a;
    },
    solve: (a) => a.solve(),
    solveSync: (a) => a.solveSync(),
    mutate: (a) => a.addArcWithCost(0, 0, 1000),
    read: (a) => a.numArcs(),
    result: (a) => a.optimalCost(),
    expected: ASSIGNMENT_SAMPLE.optimalCost,
  },
];

for (const kind of KINDS) {
  const name = kind.Class.name;

  test(`${name}: exported from the package entry point`, () => {
    assert.equal(typeof kind.Class, 'function');
    assert.equal(ortools[name], kind.Class);
  });

  test(`${name}: status constants on the class and its instances are read-only`, () => {
    const instance = new kind.Class();
    for (const status of kind.statuses) {
      assert.equal(kind.Class[status], status);
      assert.equal(instance[status], status);
    }
    assert.throws(() => { kind.Class.OPTIMAL = 'X'; }, TypeError);
    assert.equal(kind.Class.OPTIMAL, 'OPTIMAL');
  });

  test(`${name}: every call throws while a solve() is pending`, async () => {
    const m = kind.build();
    const pending = kind.solve(m);
    assert.ok(pending instanceof Promise);
    assert.equal(m.busy, true);
    assert.throws(() => kind.mutate(m), /is busy/);
    assert.throws(() => kind.read(m), /is busy/);
    assert.throws(() => kind.result(m), /is busy/);
    assert.throws(() => kind.solveSync(m), /is busy/);
    assert.throws(() => kind.solve(m), /is busy/);
    assert.throws(() => m.dispose(), /is busy/);
    assert.equal(await pending, 'OPTIMAL');
    assert.equal(m.busy, false);
    assert.equal(kind.result(m), kind.expected);
  });

  test(`${name}: dispose() is idempotent and later calls throw`, async () => {
    const m = kind.build();
    await kind.solve(m);
    m.dispose();
    m.dispose();
    assert.throws(() => kind.read(m), /has been disposed/);
    assert.throws(() => kind.mutate(m), /has been disposed/);
    assert.throws(() => kind.result(m), /has been disposed/);
    assert.throws(() => kind.solveSync(m), /has been disposed/);
    assert.throws(() => kind.solve(m), /has been disposed/);
  });

  test(`${name}: Symbol.dispose releases it at scope exit`, { skip: typeof Symbol.dispose !== 'symbol' && 'no Symbol.dispose' }, () => {
    const m = kind.build();
    m[Symbol.dispose]();
    assert.throws(() => kind.read(m), /has been disposed/);
  });

  test(`${name}: a pending solve keeps the instance alive without a JS reference`, async () => {
    v8.setFlagsFromString('--expose-gc');
    const gc = vm.runInNewContext('gc');
    const pending = kind.solve(kind.build());
    gc();
    assert.equal(await pending, 'OPTIMAL');
  });

  test(`${name}: re-solving refreshes the result and a mutation discards it`, async () => {
    const m = kind.build();
    kind.solveSync(m);
    assert.equal(kind.result(m), kind.expected);
    assert.equal(await kind.solve(m), 'OPTIMAL');
    assert.equal(kind.result(m), kind.expected);
    kind.mutate(m);
    assert.throws(() => kind.result(m), /call solve\(\) first/);
  });
}

test('concurrent solves on separate instances match their sync results', async () => {
  const random = seededRandom(7);
  const graphs = Array.from({ length: 8 }, () => {
    const n = 40;
    const lefts = [];
    const rights = [];
    const costs = [];
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        lefts.push(i);
        rights.push(j);
        costs.push(randomInt(random, 1, 1000));
      }
    }
    return { lefts, rights, costs };
  });
  const build = ({ lefts, rights, costs }) => {
    const a = new SimpleLinearSumAssignment();
    a.addArcsWithCost(Int32Array.from(lefts), Int32Array.from(rights), Int32Array.from(costs));
    return a;
  };
  const expected = graphs.map((g) => {
    const a = build(g);
    a.solveSync();
    return a.optimalCost();
  });
  const instances = graphs.map(build);
  const flows = graphs.map(() => KINDS[0].build());
  const statuses = await Promise.all([...instances.map((a) => a.solve()), ...flows.map((m) => m.solve())]);
  assert.ok(statuses.every((s) => s === 'OPTIMAL'));
  assert.deepEqual(instances.map((a) => a.optimalCost()), expected);
  assert.ok(flows.every((m) => m.optimalCost() === MIN_COST_FLOW_SAMPLE.optimalCost));
});
