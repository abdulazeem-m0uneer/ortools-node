'use strict';
// A small, deterministic port of the bus-dispatch spike model: riders are
// pickup/delivery pairs with time windows, seats, a maximum ride time, optional
// service (big penalty), an allowed-vehicle restriction, gender visit types with
// a hard incompatibility, and finalizers fixing the times. Solved with a
// solution limit, then warm-started from its own routes. Every constraint is
// checked on the returned routes.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { RoutingIndexManager, RoutingModel, VisitTypePolicy } = require('..');
const data = require('./fixtures/samples.json');

const SEATS = [3, 3, 2];
const BIG_PENALTY = 1_000_000;
const MAX_RIDE = 25;
const WINDOW = [0, 40];
const IMPOSSIBLE_RIDER = 7; // its pickup window [0, 1] cannot be reached from the depot
const WHEELCHAIR_RIDER = 0; // only vehicle 2 is equipped
const PARAMS = {
  firstSolutionStrategy: 'PARALLEL_CHEAPEST_INSERTION',
  localSearchMetaheuristic: 'GUIDED_LOCAL_SEARCH',
  solutionLimit: 30,
};

function buildModel() {
  const manager = new RoutingIndexManager(17, SEATS.length, 0);
  const model = new RoutingModel(manager);
  const solver = model.solver();
  const time = model.registerTransitCallback((i, j) => data.timeMatrix[manager.indexToNode(i)][manager.indexToNode(j)]);
  model.setArcCostEvaluatorOfAllVehicles(time);
  model.addDimension(time, 10, 1000, false, 'Time');
  const timeDim = model.getDimensionOrDie('Time');

  const riders = data.pickupsDeliveries.map(([p, d], r) => ({
    rider: r,
    pickup: manager.nodeToIndex(p),
    delivery: manager.nodeToIndex(d),
    gender: r % 2,
  }));
  const seatDemand = new Array(17).fill(0);
  for (const { pickup, delivery } of riders) {
    seatDemand[manager.indexToNode(pickup)] = 1;
    seatDemand[manager.indexToNode(delivery)] = -1;
  }
  const seats = model.registerUnaryTransitVector(seatDemand);
  model.addDimensionWithVehicleCapacity(seats, 0, SEATS, true, 'Seats');

  for (const { rider, pickup, delivery, gender } of riders) {
    model.addPickupAndDelivery(pickup, delivery);
    solver.add(model.vehicleVar(pickup).eq(model.vehicleVar(delivery)));
    solver.add(model.activeVar(pickup).eq(model.activeVar(delivery)));
    solver.add(timeDim.cumulVar(pickup).le(timeDim.cumulVar(delivery)));
    solver.add(timeDim.cumulVar(delivery).minus(timeDim.cumulVar(pickup)).le(MAX_RIDE));
    timeDim.cumulVar(pickup).setRange(...(rider === IMPOSSIBLE_RIDER ? [0, 1] : WINDOW));
    model.addDisjunction([pickup], BIG_PENALTY);
    model.addDisjunction([delivery], BIG_PENALTY);
    model.setVisitType(pickup, gender, VisitTypePolicy.TYPE_ADDED_TO_VEHICLE);
    model.setVisitType(delivery, gender, VisitTypePolicy.ADDED_TYPE_REMOVED_FROM_VEHICLE);
    model.addVariableMinimizedByFinalizer(timeDim.cumulVar(pickup));
    model.addVariableMinimizedByFinalizer(timeDim.cumulVar(delivery));
  }
  model.addHardTypeIncompatibility(0, 1);
  const wheelchair = riders[WHEELCHAIR_RIDER];
  model.setAllowedVehiclesForIndex([2], wheelchair.pickup);
  model.setAllowedVehiclesForIndex([2], wheelchair.delivery);
  // The spike also removes vehicles from a rider's domain directly.
  model.vehicleVar(riders[1].pickup).removeValues([2]);
  for (let v = 0; v < SEATS.length; v++) {
    model.addVariableMinimizedByFinalizer(timeDim.cumulVar(model.start(v)));
    model.addVariableMinimizedByFinalizer(timeDim.cumulVar(model.end(v)));
  }
  return { manager, model, riders, timeDim };
}

function checkSolution(solution, { model, riders, timeDim }) {
  assert.ok(solution, model.status());
  const routes = solution.routes();
  const times = solution.cumuls(timeDim);
  const seats = solution.cumuls('Seats');
  const where = new Map();
  routes.forEach((route, v) => route.forEach((index, k) => where.set(index, { v, k })));

  let served = 0;
  for (const { rider, pickup, delivery, gender } of riders) {
    const p = where.get(pickup);
    const d = where.get(delivery);
    assert.equal(p === undefined, d === undefined, `rider ${rider}: pickup and delivery served together`);
    if (p === undefined) continue;
    served++;
    assert.equal(p.v, d.v, `rider ${rider}: same vehicle`);
    assert.ok(p.k < d.k, `rider ${rider}: pickup before delivery`);
    assert.equal(solution.value(model.vehicleVar(pickup)), p.v);
    const tp = times[p.v][p.k];
    const td = times[d.v][d.k];
    assert.equal(solution.min(timeDim.cumulVar(pickup)), solution.max(timeDim.cumulVar(pickup)), 'finalized');
    assert.ok(tp >= WINDOW[0] && tp <= WINDOW[1], `rider ${rider}: pickup at ${tp}`);
    assert.ok(td - tp >= 0 && td - tp <= MAX_RIDE, `rider ${rider}: ride of ${td - tp}`);
    if (rider === WHEELCHAIR_RIDER) assert.equal(p.v, 2);
    if (rider === 1) assert.notEqual(p.v, 2);
    const genders = routes[p.v].map((i) => riders.find((r) => r.pickup === i || r.delivery === i))
      .filter(Boolean).map((r) => r.gender);
    assert.ok(genders.every((g) => g === gender), `vehicle ${p.v} mixes genders`);
  }
  assert.equal(where.has(riders[IMPOSSIBLE_RIDER].pickup), false, 'the unreachable rider is dropped');
  assert.ok(served >= 6, `only ${served} riders served`);
  seats.forEach((loads, v) => loads.forEach((load) => assert.ok(load >= 0 && load <= SEATS[v], `vehicle ${v}`)));
  routes.forEach((route, v) => {
    for (let k = 1; k < route.length; k++) {
      assert.ok(times[v][k] >= times[v][k - 1], 'time moves forward along a route');
    }
  });
  return routes;
}

test('dispatch spike model: solve with a solution limit, then warm-start', async () => {
  const built = buildModel();
  const { model } = built;
  const first = await model.solveWithParameters(PARAMS);
  const routes = checkSolution(first, built);
  const objective = first.objectiveValue();
  assert.ok(objective >= BIG_PENALTY * 2, 'the dropped rider pays both penalties');
  assert.ok(objective < BIG_PENALTY * 3);

  // Deterministic: the same model and parameters give the same answer.
  const again = buildModel();
  assert.equal((await again.model.solveWithParameters(PARAMS)).objectiveValue(), objective);

  const initial = model.readAssignmentFromRoutes(routes.map((r) => r.slice(1, -1)), true);
  assert.ok(initial, 'the solution routes read back as an assignment');
  assert.equal(initial.objectiveValue(), objective);
  const seeded = await model.solveFromAssignmentWithParameters(
    model.readAssignmentFromRoutes(routes.map((r) => r.slice(1, -1)), true), { ...PARAMS, solutionLimit: 1 });
  assert.deepEqual(seeded.routes(), routes, 'the warm start begins from the given routes');
  const warm = await model.solveFromAssignmentWithParameters(
    model.readAssignmentFromRoutes(routes.map((r) => r.slice(1, -1)), true), PARAMS);
  checkSolution(warm, built);
  assert.ok(warm.objectiveValue() <= objective);
});

test('dispatch spike model: re-planning with locks', () => {
  const built = buildModel();
  const { model } = built;
  const first = model.solveWithParametersSync(PARAMS);
  const routes = checkSolution(first, built);
  // Lock the first two stops already driven on each used route.
  const locks = routes.map((r) => r.slice(1, -1).slice(0, 2));
  assert.equal(model.applyLocksToAllVehicles(locks, false), true);
  const replanned = model.solveWithParametersSync(PARAMS);
  const after = checkSolution(replanned, built);
  locks.forEach((lock, v) => assert.deepEqual(after[v].slice(1, 1 + lock.length), lock));
});
