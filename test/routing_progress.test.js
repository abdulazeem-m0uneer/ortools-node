'use strict';
// Routing progress events (onProgress): content, throttling, coalescing under a
// slow listener, throws, re-entrancy, interrupt() and option validation.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { RoutingIndexManager, RoutingModel } = require('..');
const data = require('./fixtures/samples.json');

const PCA = { firstSolutionStrategy: 'PATH_CHEAPEST_ARC' };
// Guided local search never stops on its own: only a limit or interrupt() ends it.
const ENDLESS = { firstSolutionStrategy: 'PATH_CHEAPEST_ARC', localSearchMetaheuristic: 'GUIDED_LOCAL_SEARCH' };
const timed = (ms) => ({ ...ENDLESS, timeLimit: `${ms / 1000}s` });

function vrp(vehicles = 4) {
  const manager = new RoutingIndexManager(17, vehicles, 0);
  const model = new RoutingModel(manager);
  model.setArcCostEvaluatorOfAllVehicles(model.registerTransitMatrix(data.distance17));
  return model;
}

function assertWellFormed(events) {
  assert.ok(events.length > 0);
  for (const e of events) {
    assert.deepEqual(Object.keys(e).sort(), ['branches', 'done', 'failures', 'objective', 'solutions', 'wallTimeMs']);
    for (const k of ['solutions', 'branches', 'failures', 'wallTimeMs']) {
      assert.equal(typeof e[k], 'number');
      assert.ok(e[k] >= 0);
    }
  }
  for (let i = 1; i < events.length; i++) {
    assert.ok(events[i].wallTimeMs >= events[i - 1].wallTimeMs);
    assert.ok(events[i].solutions >= events[i - 1].solutions);
    if (events[i - 1].objective !== null) assert.ok(events[i].objective <= events[i - 1].objective, 'best so far');
  }
  assert.equal(events.at(-1).done, true, 'the last event is the final one');
  assert.equal(events.filter((e) => e.done).length, 1);
}

test('async onProgress reports counters and ends with a final event before the Promise resolves', async () => {
  const model = vrp();
  const events = [];
  let solutions = 0;
  const solution = await model.solveWithParameters(timed(500), {
    onSolution: () => { solutions++; },
    onProgress: (p) => {
      assert.equal(model.busy, true, 'progress runs while the solve holds the model');
      events.push(p);
    },
    progressIntervalMs: 50,
  });
  assertWellFormed(events);
  const last = events.at(-1);
  assert.equal(last.solutions, solutions);
  assert.equal(last.objective, solution.objectiveValue());
  assert.ok(last.branches > 0);
  assert.ok(last.wallTimeMs >= 400 && last.wallTimeMs < 5000, `wallTimeMs ${last.wallTimeMs}`);
  assert.ok(events.length >= 3, `periodic events during the search (${events.length})`);
});

test('sync onProgress is called during solveWithParametersSync', () => {
  const model = vrp();
  const events = [];
  const solution = model.solveWithParametersSync(timed(300), { onProgress: (p) => events.push(p), progressIntervalMs: 50 });
  assertWellFormed(events);
  assert.equal(events.at(-1).objective, solution.objectiveValue());
  assert.ok(events.length >= 3);
});

test('a solve that ends at once still reports one final event', async () => {
  const events = [];
  await vrp().solveWithParameters(PCA, { onProgress: (p) => events.push(p) });
  assertWellFormed(events);
  assert.ok(events.at(-1).solutions >= 1);
});

test('an infeasible solve reports a null objective', () => {
  const manager = new RoutingIndexManager(3, 1, 0);
  const model = new RoutingModel(manager);
  model.setArcCostEvaluatorOfAllVehicles(model.registerTransitMatrix([[0, 1, 1], [1, 0, 1], [1, 1, 0]]));
  model.solver().add(model.nextVar(model.start(0)).eq(model.end(0)));  // node 1 and 2 cannot be visited
  const events = [];
  assert.equal(model.solveWithParametersSync(PCA, { onProgress: (p) => events.push(p) }), null);
  assertWellFormed(events);
  assert.equal(events.at(-1).solutions, 0);
  assert.equal(events.at(-1).objective, null);
});

test('progressIntervalMs throttles the periodic events', async () => {
  const events = [];
  await vrp().solveWithParameters(timed(600), { onProgress: (p) => events.push(p), progressIntervalMs: 250 });
  assertWellFormed(events);
  assert.ok(events.length <= 5, `${events.length} events for 600 ms at 250 ms`);
  for (let i = 1; i < events.length - 1; i++) {
    assert.ok(events[i].wallTimeMs - events[i - 1].wallTimeMs >= 240, 'periodic events are >= the interval apart');
  }
});

test('a slow async listener gets coalesced events and never stalls the solver', { timeout: 30000 }, async () => {
  const model = vrp();
  const events = [];
  const started = Date.now();
  await model.solveWithParameters(timed(1000), {
    progressIntervalMs: 0,  // ask for every check
    onProgress: (p) => {
      events.push(p);
      const until = Date.now() + 100;
      while (Date.now() < until);  // a listener far slower than the solver
    },
  });
  assertWellFormed(events);
  // At most one event is queued at a time: ~1000/100 deliveries, not thousands.
  assert.ok(events.length <= 25, `${events.length} events were delivered`);
  assert.ok(Date.now() - started < 5000, 'the solve ended near its time limit');
  assert.ok(events.at(-1).branches > events.length, 'the solver kept working between deliveries');
});

test('a throw in async onProgress stops the search and rejects with it', { timeout: 60000 }, async () => {
  const model = vrp();
  const boom = new Error('progress failed');
  let calls = 0;
  await assert.rejects(model.solveWithParameters(ENDLESS, {
    progressIntervalMs: 10,
    onProgress: () => { calls++; throw boom; },
  }), (e) => e === boom);
  assert.equal(calls, 1, 'no event is delivered after a throw');
  assert.equal(model.busy, false);
  assert.ok(await model.solveWithParameters(PCA), 'the model stays usable');
});

test('a throw in sync onProgress stops the search and is rethrown', { timeout: 60000 }, () => {
  const model = vrp();
  let calls = 0;
  assert.throws(() => model.solveWithParametersSync(ENDLESS, {
    progressIntervalMs: 10,
    onProgress() { calls++; throw new RangeError('sync progress'); },
  }), (e) => e instanceof RangeError && e.message === 'sync progress');
  assert.equal(calls, 1);
  assert.equal(model.busy, false);
});

test('the first throw wins when onSolution and onProgress both throw', { timeout: 60000 }, () => {
  const model = vrp();
  assert.throws(() => model.solveWithParametersSync(ENDLESS, {
    onSolution() { throw new Error('solution first'); },
    onProgress() { throw new Error('progress'); },
    progressIntervalMs: 0,
  }), /solution first|progress/);
  assert.equal(model.busy, false);
});

test('model calls from onProgress hit the busy guard', { timeout: 60000 }, async () => {
  const model = vrp();
  await assert.rejects(model.solveWithParameters(timed(200), { onProgress: () => model.addDisjunction([1], 1) }),
    /busy/);
  assert.throws(() => model.solveWithParametersSync(timed(200), { onProgress: () => model.solveWithParametersSync(PCA) }),
    /busy/);
});

test('interrupt() from onProgress stops an endless search with its best solution', { timeout: 60000 }, async () => {
  const model = vrp();
  const events = [];
  const solution = await model.solveWithParameters(ENDLESS, {
    progressIntervalMs: 20,
    onProgress: (p) => { events.push(p); if (events.length === 2) model.interrupt(); },
  });
  assert.ok(solution);
  assertWellFormed(events);
  let syncEvents = 0;
  assert.ok(model.solveWithParametersSync(ENDLESS, {
    progressIntervalMs: 20,
    onProgress: () => { if (++syncEvents === 2) model.interrupt(); },
  }));
});

test('interrupt() from outside ends the search with a final event', { timeout: 60000 }, async () => {
  const model = vrp();
  const events = [];
  const pending = model.solveWithParameters(ENDLESS, { onProgress: (p) => events.push(p), progressIntervalMs: 20 });
  setTimeout(() => model.interrupt(), 200);
  assert.ok(await pending);
  assertWellFormed(events);
});

test('progress options are validated', () => {
  const model = vrp();
  assert.throws(() => model.solveWithParametersSync(PCA, { onProgress: 'x' }), TypeError);
  const withInterval = (ms) => () => model.solveWithParametersSync(PCA, { onProgress() {}, progressIntervalMs: ms });
  for (const outOfRange of [-1, 2 ** 31]) assert.throws(withInterval(outOfRange), RangeError, String(outOfRange));
  for (const notInteger of [NaN, Infinity, 1.5, '10', null]) {
    assert.throws(withInterval(notInteger), TypeError, String(notInteger));
  }
  const json = require('../lib/params').routingSearchParametersJson(PCA);
  assert.throws(() => model._n.solveSync(json, undefined, { onProgress: 1 }), TypeError);
  assert.throws(() => model._n.solveSync(json, undefined, { onProgress() {}, progressIntervalMs: -5 }), RangeError);
  assert.ok(model.solveWithParametersSync(PCA, { progressIntervalMs: 10 }), 'an interval alone is accepted');
});

test('an objective beyond 2^53 reaches onProgress as a BigInt', async () => {
  const manager = new RoutingIndexManager(4, 1, 0);
  const model = new RoutingModel(manager);
  for (const i of [1, 2, 3]) model.addDisjunction([i], 1n << 52n);
  model.setAllowedVehiclesForIndex([0], 1);
  model.vehicleVar(1).removeValue(0);
  model.vehicleVar(2).removeValue(0);
  const events = [];
  await model.solveWithParameters(PCA, { onProgress: (p) => events.push(p) });
  assert.equal(events.at(-1).objective, 2n * (1n << 52n));
});

test('a later solve without onProgress never calls an earlier solve\'s listener', async () => {
  const model = vrp();
  let calls = 0;
  model.solveWithParametersSync(timed(100), { onProgress: () => { calls++; }, progressIntervalMs: 0 });
  const after = calls;
  assert.ok(after > 0);
  model.solveWithParametersSync(timed(100));
  await model.solveWithParameters(timed(100));
  assert.equal(calls, after);
});

test('a later solve without onProgress never calls an earlier async solve\'s listener', async () => {
  const model = vrp();
  let calls = 0;
  await model.solveWithParameters(timed(100), { onProgress: () => { calls++; }, progressIntervalMs: 0 });
  const after = calls;
  assert.ok(after > 0);
  model.solveWithParametersSync(timed(100));
  await model.solveWithParameters(timed(100));
  assert.equal(calls, after);
});

// native._testing.failNextRoutingSolves(n) makes the next n routing solves
// throw a C++ exception right after OR-Tools returns.
const { _testing } = require('../lib/native');

test('a native failure still delivers the final event, then rejects or throws', async () => {
  const model = vrp();
  const events = [];
  _testing.failNextRoutingSolves(1);
  await assert.rejects(model.solveWithParameters(timed(100), { onProgress: (p) => events.push(p) }),
    /injected routing solve failure/);
  assertWellFormed(events);
  events.length = 0;
  _testing.failNextRoutingSolves(1);
  assert.throws(() => model.solveWithParametersSync(timed(100), { onProgress: (p) => events.push(p) }),
    /injected routing solve failure/);
  assertWellFormed(events);
  assert.equal(model.busy, false);
  assert.ok(model.solveWithParametersSync(PCA), 'the model stays usable');
});

test('a native failure wins over a throw in the final onProgress call', () => {
  const model = vrp();
  _testing.failNextRoutingSolves(1);
  assert.throws(() => model.solveWithParametersSync(PCA, {
    onProgress(p) { if (p.done) throw new Error('listener'); },
  }), /injected routing solve failure/);
});
