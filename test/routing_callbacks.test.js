'use strict';
// Solution callbacks, interrupt(), busy state and concurrent solves.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { RoutingIndexManager, RoutingModel } = require('..');
const data = require('./fixtures/samples.json');

const PCA = { firstSolutionStrategy: 'PATH_CHEAPEST_ARC' };
// Guided local search never stops on its own: only a limit or interrupt() ends it.
const ENDLESS = { firstSolutionStrategy: 'PATH_CHEAPEST_ARC', localSearchMetaheuristic: 'GUIDED_LOCAL_SEARCH' };

function vrp(vehicles = 4) {
  const manager = new RoutingIndexManager(17, vehicles, 0);
  const model = new RoutingModel(manager);
  model.setArcCostEvaluatorOfAllVehicles(model.registerTransitMatrix(data.distance17));
  return model;
}

function assertImproving(snapshots) {
  assert.ok(snapshots.length > 0);
  snapshots.forEach((s, i) => assert.equal(s.solutionIndex, i));
  for (let i = 1; i < snapshots.length; i++) assert.ok(snapshots[i].objective <= snapshots[i - 1].objective);
}

test('async onSolution receives every solution before the Promise resolves', async () => {
  const model = vrp();
  const snapshots = [];
  const solution = await model.solveWithParameters(PCA, {
    onSolution: (s) => {
      assert.equal(model.busy, true, 'callbacks run while the solve holds the model');
      snapshots.push(s);
    },
  });
  assertImproving(snapshots);
  assert.equal(snapshots.at(-1).objective, solution.objectiveValue());
  assert.equal(snapshots[0].routes, undefined);
  assert.equal(model.busy, false);
});

test('includeRoutes adds the routes of each solution', async () => {
  const model = vrp();
  const snapshots = [];
  const solution = await model.solveWithParameters(PCA, { onSolution: (s) => snapshots.push(s), includeRoutes: true });
  assert.deepEqual(snapshots.at(-1).routes, solution.routes());
  for (const s of snapshots) assert.equal(s.routes.length, 4);
});

test('sync onSolution is called during solveWithParametersSync', () => {
  const model = vrp();
  const snapshots = [];
  const solution = model.solveWithParametersSync(PCA, { onSolution: (s) => snapshots.push(s), includeRoutes: true });
  assertImproving(snapshots);
  assert.equal(snapshots.at(-1).objective, solution.objectiveValue());
  assert.deepEqual(snapshots.at(-1).routes, solution.routes());
});

test('a throw in the async callback stops the search and rejects', { timeout: 60000 }, async () => {
  const model = vrp();
  const boom = new Error('callback failed');
  let calls = 0;
  await assert.rejects(model.solveWithParameters(ENDLESS, { onSolution: () => { calls++; throw boom; } }),
    (e) => e === boom);
  assert.ok(calls >= 1);
  assert.equal(model.busy, false);
  assert.ok(await model.solveWithParameters({ ...ENDLESS, solutionLimit: 5 }), 'the model stays usable');
});

test('a throw in the sync callback stops the search and is rethrown', { timeout: 60000 }, () => {
  const model = vrp();
  assert.throws(() => model.solveWithParametersSync(ENDLESS, { onSolution() { throw new RangeError('sync'); } }),
    (e) => e instanceof RangeError && e.message === 'sync');
  assert.equal(model.busy, false);
});

test('model calls from a callback hit the busy guard', { timeout: 60000 }, async () => {
  const model = vrp();
  await assert.rejects(model.solveWithParameters(ENDLESS, { onSolution: () => model.addDisjunction([1], 1) }), /busy/);
  assert.throws(() => model.solveWithParametersSync(ENDLESS, { onSolution: () => model.nextVar(1) }), /busy/);
});

test('interrupt() from the callback stops an endless search with its best solution', { timeout: 60000 }, async () => {
  const model = vrp();
  let calls = 0;
  const solution = await model.solveWithParameters(ENDLESS, {
    onSolution: () => {
      calls++;
      if (calls === 3) assert.equal(model.interrupt(), true);
    },
  });
  assert.ok(solution, 'the best solution so far is returned');
  assert.ok(calls >= 3);
  assert.equal(model.interrupt(), false, 'nothing runs any more');
});

test('interrupt() from outside the callback, and in a sync solve', { timeout: 60000 }, async () => {
  const model = vrp();
  const pending = model.solveWithParameters(ENDLESS);
  assert.equal(model.busy, true);
  setTimeout(() => model.interrupt(), 50);
  assert.ok(await pending);
  let calls = 0;
  const sync = model.solveWithParametersSync(ENDLESS, { onSolution: () => { if (++calls === 2) model.interrupt(); } });
  assert.ok(sync);
});

test('the model and its solver are locked during an async solve', async () => {
  const model = vrp();
  const solver = model.solver();
  const v = model.vehicleVar(1);
  const pending = model.solveWithParameters(PCA);
  assert.throws(() => model.addDisjunction([1], 1), /busy/);
  assert.throws(() => model.nextVar(1), /busy/);
  assert.throws(() => model.status(), /busy/);
  assert.throws(() => model.solveWithParametersSync(PCA), /busy/);
  assert.throws(() => model.dispose(), /busy/);
  assert.throws(() => solver.add(v.eq(0)), /busy/);
  assert.throws(() => v.min(), /busy/);
  await assert.rejects(model.solveWithParameters(PCA), /busy/);
  assert.ok(await pending);
  assert.equal(v.min(), -1);
});

test('concurrent solves on separate models', async () => {
  const models = [vrp(1), vrp(2), vrp(4)];
  const solutions = await Promise.all(models.map((m) => m.solveWithParameters(PCA)));
  assert.deepEqual(solutions.map((s) => s.objectiveValue()), [4384, 4384, 4384]);
});

test('onSolution must be a function', () => {
  const model = vrp();
  assert.throws(() => model.solveWithParametersSync(PCA, { onSolution: 'x' }), TypeError);
  const json = require('../lib/params').routingSearchParametersJson(PCA);
  assert.throws(() => model._n.solveSync(json, undefined, { onSolution: 1 }), TypeError);
  assert.throws(() => model._n.solveSync(json, undefined, 5), TypeError);
});

test('an objective beyond 2^53 reaches onSolution as a BigInt', async () => {
  const manager = new RoutingIndexManager(4, 1, 0);
  const model = new RoutingModel(manager);
  for (const i of [1, 2, 3]) model.addDisjunction([i], 1n << 52n);
  model.setAllowedVehiclesForIndex([0], 1);
  model.vehicleVar(1).removeValue(0);
  model.vehicleVar(2).removeValue(0);
  const snapshots = [];
  const solution = await model.solveWithParameters(PCA, { onSolution: (s) => snapshots.push(s) });
  assert.ok(solution);
  assert.equal(typeof snapshots.at(-1).objective, 'bigint');
  assert.equal(snapshots.at(-1).objective, 2n * (1n << 52n));
  assert.equal(solution.objectiveValue(), 2n * (1n << 52n), 'objectiveValue() returns a bigint, never a rounded number');
});

test('cumuls and values beyond 2^53 come back as bigints, safe ones as numbers', () => {
  const manager = new RoutingIndexManager(3, 1, 0);
  const model = new RoutingModel(manager);
  const huge = 1n << 54n;
  const t = model.registerTransitMatrix([[0n, huge, huge], [huge, 0n, huge], [huge, huge, 0n]]);
  model.setArcCostEvaluatorOfAllVehicles(t);
  model.addDimension(t, 0, Infinity, true, 'Far');
  const solution = model.solveWithParametersSync(PCA);
  assert.equal(solution.objectiveValue(), 3n * huge);
  assert.deepEqual(solution.cumuls('Far'), [[0, huge, 2n * huge, 3n * huge]]);
  const dim = model.getDimensionOrDie('Far');
  assert.equal(solution.value(dim.cumulVar(model.end(0))), 3n * huge);
  assert.equal(typeof solution.value(model.nextVar(0)), 'number');
});
