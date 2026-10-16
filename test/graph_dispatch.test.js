'use strict';
// The two dispatch workloads the graph binding was spiked against, on seeded
// data: request-to-bus matching (as a min-cost flow and as a padded linear sum
// assignment) and moving stranded passengers onto buses with free seats.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { SimpleMinCostFlow, SimpleLinearSumAssignment } = require('..');
const { seededRandom, randomInt } = require('./graph_fixtures');

const UNMATCHED_COST = 100000;

/** Requests x buses with a seeded compatibility pattern and costs in [1, 1000]. */
function matchingInstance(seed, numRequests, numBuses) {
  const random = seededRandom(seed);
  const pairs = [];
  for (let request = 0; request < numRequests; request++) {
    for (let bus = 0; bus < numBuses; bus++) {
      if (random() < 0.15) pairs.push({ request, bus, cost: randomInt(random, 1, 1000) });
    }
  }
  return { numRequests, numBuses, pairs };
}

// source -> request (cap 1) -> bus (cap 1) -> sink, plus request -> sink at
// UNMATCHED_COST so every request is routed somewhere.
function matchWithMinCostFlow({ numRequests, numBuses, pairs }) {
  const source = 0;
  const requestNode = (r) => 1 + r;
  const busNode = (b) => 1 + numRequests + b;
  const sink = 1 + numRequests + numBuses;
  const tails = [];
  const heads = [];
  const costs = [];
  const add = (tail, head, cost) => {
    tails.push(tail);
    heads.push(head);
    costs.push(cost);
  };
  for (let r = 0; r < numRequests; r++) add(source, requestNode(r), 0);
  const firstPairArc = tails.length;
  for (const { request, bus, cost } of pairs) add(requestNode(request), busNode(bus), cost);
  for (let b = 0; b < numBuses; b++) add(busNode(b), sink, 0);
  for (let r = 0; r < numRequests; r++) add(requestNode(r), sink, UNMATCHED_COST);

  const m = new SimpleMinCostFlow();
  m.addArcsWithCapacityAndUnitCost(Int32Array.from(tails), Int32Array.from(heads),
    new Int32Array(tails.length).fill(1), Int32Array.from(costs));
  m.setNodesSupplies([source, sink], [numRequests, -numRequests]);
  assert.equal(m.solveSync(), 'OPTIMAL');
  const pairFlows = m.flows(Int32Array.from(pairs, (_, i) => firstPairArc + i));
  const matches = pairs.filter((_, i) => pairFlows[i] === 1);
  return { cost: m.optimalCost(), matches };
}

// Square (requests + buses) matrix: request rows reach compatible buses or
// their own "unmatched" column; one dummy row per bus absorbs an unused bus or
// a freed unmatched column at cost 0.
function matchWithAssignment({ numRequests, numBuses, pairs }) {
  const lefts = [];
  const rights = [];
  const costs = [];
  const add = (left, right, cost) => {
    lefts.push(left);
    rights.push(right);
    costs.push(cost);
  };
  const unmatchedColumn = (r) => numBuses + r;
  for (const { request, bus, cost } of pairs) add(request, bus, cost);
  for (let r = 0; r < numRequests; r++) add(r, unmatchedColumn(r), UNMATCHED_COST);
  for (let b = 0; b < numBuses; b++) {
    const dummyRow = numRequests + b;
    add(dummyRow, b, 0);
    for (let r = 0; r < numRequests; r++) add(dummyRow, unmatchedColumn(r), 0);
  }

  const a = new SimpleLinearSumAssignment();
  a.addArcsWithCost(Int32Array.from(lefts), Int32Array.from(rights), Int32Array.from(costs));
  assert.equal(a.numNodes(), numRequests + numBuses);
  assert.equal(a.solveSync(), 'OPTIMAL');
  const matches = [];
  for (let r = 0; r < numRequests; r++) {
    const bus = a.rightMate(r);
    if (bus < numBuses) matches.push({ request: r, bus, cost: a.assignmentCost(r) });
  }
  return { cost: a.optimalCost(), matches };
}

function assertValidMatching(instance, matches) {
  const usedBuses = new Set();
  const usedRequests = new Set();
  for (const { request, bus, cost } of matches) {
    assert.ok(instance.pairs.some((p) => p.request === request && p.bus === bus && p.cost === cost));
    assert.ok(!usedBuses.has(bus) && !usedRequests.has(request));
    usedBuses.add(bus);
    usedRequests.add(request);
  }
}

test('dispatch matching: min-cost flow and padded assignment agree', () => {
  for (const [seed, numRequests, numBuses] of [[1, 25, 20], [2, 40, 15], [3, 12, 30], [4, 1, 1]]) {
    const instance = matchingInstance(seed, numRequests, numBuses);
    const flow = matchWithMinCostFlow(instance);
    const assignment = matchWithAssignment(instance);
    assertValidMatching(instance, flow.matches);
    assertValidMatching(instance, assignment.matches);
    assert.equal(flow.matches.length, assignment.matches.length, `seed ${seed}: matched count`);
    assert.equal(flow.cost, assignment.cost, `seed ${seed}: total cost`);
    const matchedCost = flow.matches.reduce((sum, m) => sum + m.cost, 0);
    assert.equal(flow.cost, matchedCost + UNMATCHED_COST * (numRequests - flow.matches.length));
  }
});

test('dispatch matching: seeded instances have the expected shape', () => {
  const instance = matchingInstance(1, 25, 20);
  const { matches } = matchWithMinCostFlow(instance);
  // Guard against a degenerate generator: some but not all requests match.
  assert.ok(matches.length > 0 && matches.length < 25, `matched ${matches.length}`);
});

/** Cheapest way to seat `passengers` on buses sorted by distance (the oracle). */
function greedyRescueCost(buses, passengers) {
  let left = passengers;
  let cost = 0;
  for (const { seats, distance } of [...buses].sort((x, y) => x.distance - y.distance)) {
    const taken = Math.min(seats, left);
    cost += taken * distance;
    left -= taken;
  }
  return { cost, seated: passengers - left };
}

test('dispatch rescue: 5 runs x 30 buses with seat filtering', async () => {
  const random = seededRandom(2026);
  const outcomes = [];
  for (let run = 0; run < 5; run++) {
    const fleet = Array.from({ length: 30 }, (_, id) => ({
      id, seats: randomInt(random, 0, 6), distance: randomInt(random, 1, 500),
    }));
    const buses = fleet.filter((bus) => bus.seats > 0); // seat filtering
    const totalSeats = buses.reduce((sum, bus) => sum + bus.seats, 0);
    // The last run strands more passengers than there are seats.
    const k = run === 4 ? totalSeats + 3 : randomInt(random, 5, Math.min(40, totalSeats));

    const m = new SimpleMinCostFlow();
    const source = 0;
    const sink = buses.length + 1;
    m.addArcsWithCapacityAndUnitCost(
      buses.map(() => source), buses.map((_, i) => i + 1), buses.map((b) => b.seats), buses.map((b) => b.distance));
    m.addArcsWithCapacityAndUnitCost(
      buses.map((_, i) => i + 1), buses.map(() => sink), buses.map((b) => b.seats), buses.map(() => 0));
    m.setNodeSupply(source, k);
    m.setNodeSupply(sink, -k);

    const oracle = greedyRescueCost(buses, k);
    const status = await m.solve();
    outcomes.push(status);
    if (oracle.seated === k) {
      assert.equal(status, 'OPTIMAL', `run ${run}`);
      assert.equal(m.maximumFlow(), k);
    } else {
      assert.equal(status, 'INFEASIBLE', `run ${run}`);
      assert.equal(await m.solveMaxFlowWithMinCost(), 'OPTIMAL');
      assert.equal(m.maximumFlow(), totalSeats);
    }
    assert.equal(m.optimalCost(), oracle.cost, `run ${run}: cost`);
    const seated = m.flows(Int32Array.from(buses, (_, i) => i));
    seated.forEach((n, i) => assert.ok(n >= 0 && n <= buses[i].seats));
    assert.equal(seated.reduce((sum, n) => sum + n, 0), oracle.seated);
    m.dispose();
  }
  assert.deepEqual(outcomes, ['OPTIMAL', 'OPTIMAL', 'OPTIMAL', 'OPTIMAL', 'INFEASIBLE']);
});
