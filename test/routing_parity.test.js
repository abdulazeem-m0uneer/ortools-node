'use strict';
// Parity with the OR-Tools C++ routing samples (examples/<name>/<name>.cc).
// The expected objectives come from compiling and running those samples
// against the same OR-Tools release, with the time limit and guided local
// search removed from vrp_capacity and vrp_drop_nodes so that every run ends at
// a deterministic local optimum.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { RoutingIndexManager, RoutingModel, PickupAndDeliveryPolicy } = require('..');
const data = require('./fixtures/samples.json');

const PATH_CHEAPEST_ARC = { firstSolutionStrategy: 'PATH_CHEAPEST_ARC' };
const PARALLEL_CHEAPEST_INSERTION = { firstSolutionStrategy: 'PARALLEL_CHEAPEST_INSERTION' };

function distanceCallback(manager, matrix) {
  return (i, j) => matrix[manager.indexToNode(i)][manager.indexToNode(j)];
}

function routeCost(solution, model, matrix, manager) {
  let total = 0;
  for (const route of solution.routes()) {
    for (let k = 0; k + 1 < route.length; k++) {
      total += matrix[manager.indexToNode(route[k])][manager.indexToNode(route[k + 1])];
    }
  }
  return total;
}

function assertVisitsAll(solution, model, except = []) {
  const visited = new Set(solution.routes().flatMap((r) => r.slice(1, -1)));
  for (let i = 0; i < model.size(); i++) {
    if (model.isStart(i) || except.includes(i)) continue;
    assert.ok(visited.has(i), `index ${i} not visited`);
  }
}

test('simple_routing_program: objective 8', async () => {
  const manager = new RoutingIndexManager(5, 1, 0);
  const model = new RoutingModel(manager);
  const t = model.registerTransitCallback((i, j) => Math.abs(manager.indexToNode(j) - manager.indexToNode(i)));
  model.setArcCostEvaluatorOfAllVehicles(t);
  const solution = await model.solveWithParameters(PATH_CHEAPEST_ARC);
  assert.equal(solution.objectiveValue(), 8);
  assert.equal(model.status(), 'ROUTING_SUCCESS');
  assertVisitsAll(solution, model);
});

test('tsp_cities: objective 7293', async () => {
  const manager = new RoutingIndexManager(data.tspCities.length, 1, 0);
  const model = new RoutingModel(manager);
  model.setArcCostEvaluatorOfAllVehicles(model.registerTransitMatrix(data.tspCities));
  const solution = await model.solveWithParameters(PATH_CHEAPEST_ARC);
  assert.equal(solution.objectiveValue(), 7293);
  assert.equal(routeCost(solution, model, data.tspCities, manager), 7293);
  const [route] = solution.routes();
  assert.equal(route.length, data.tspCities.length + 1);
});

test('tsp_distance_matrix (1 vehicle) and vrp (4 vehicles): objective 4384', async () => {
  for (const vehicles of [1, 4]) {
    const manager = new RoutingIndexManager(17, vehicles, 0);
    const model = new RoutingModel(manager);
    model.setArcCostEvaluatorOfAllVehicles(model.registerTransitCallback(distanceCallback(manager, data.distance17)));
    const solution = await model.solveWithParameters(PATH_CHEAPEST_ARC);
    assert.equal(solution.objectiveValue(), 4384, `${vehicles} vehicles`);
    assertVisitsAll(solution, model);
  }
});

test('vrp_global_span: objective 177500 with a 1712 longest route', async () => {
  const manager = new RoutingIndexManager(17, 4, 0);
  const model = new RoutingModel(manager);
  const t = model.registerTransitMatrix(data.distance17);
  model.setArcCostEvaluatorOfAllVehicles(t);
  assert.equal(model.addDimension(t, 0, 3000, true, 'Distance'), true);
  model.getDimensionOrDie('Distance').setGlobalSpanCostCoefficient(100);
  const solution = await model.solveWithParameters(PATH_CHEAPEST_ARC);
  assert.equal(solution.objectiveValue(), 177500);
  const ends = solution.cumuls('Distance').map((c) => c.at(-1));
  assert.equal(Math.max(...ends), 1712);
});

test('vrp_capacity (deterministic): objective 6872, loads within capacity', async () => {
  const manager = new RoutingIndexManager(17, 4, 0);
  const model = new RoutingModel(manager);
  model.setArcCostEvaluatorOfAllVehicles(model.registerTransitCallback(distanceCallback(manager, data.distance17)));
  const demand = model.registerUnaryTransitCallback((i) => data.capacityDemands[manager.indexToNode(i)]);
  model.addDimensionWithVehicleCapacity(demand, 0, [15, 15, 15, 15], true, 'Capacity');
  const solution = await model.solveWithParameters(PATH_CHEAPEST_ARC);
  assert.equal(solution.objectiveValue(), 6872);
  const loads = solution.cumuls(model.getDimensionOrDie('Capacity'));
  for (const route of loads) assert.ok(route.at(-1) <= 15);
  assert.equal(loads.reduce((sum, r) => sum + r.at(-1), 0), 60);
});

test('vrp_time_windows: objective 71, every arrival inside its window', async () => {
  const manager = new RoutingIndexManager(17, 4, 0);
  const model = new RoutingModel(manager);
  const t = model.registerTransitCallback(distanceCallback(manager, data.timeMatrix));
  model.setArcCostEvaluatorOfAllVehicles(t);
  model.addDimension(t, 30, 30, false, 'Time');
  const time = model.getDimensionOrDie('Time');
  for (let node = 1; node < data.timeWindows.length; node++) {
    time.cumulVar(manager.nodeToIndex(node)).setRange(...data.timeWindows[node]);
  }
  for (let v = 0; v < 4; v++) {
    time.cumulVar(model.start(v)).setRange(...data.timeWindows[0]);
    model.addVariableMinimizedByFinalizer(time.cumulVar(model.start(v)));
    model.addVariableMinimizedByFinalizer(time.cumulVar(model.end(v)));
  }
  const solution = await model.solveWithParameters(PATH_CHEAPEST_ARC);
  assert.equal(solution.objectiveValue(), 71);
  const routes = solution.routes();
  const cumuls = solution.cumuls(time);
  let total = 0;
  routes.forEach((route, v) => {
    route.forEach((index, k) => {
      const [lo, hi] = data.timeWindows[manager.indexToNode(index)];
      const variable = time.cumulVar(index);
      // The sample constrains every node and the starts; the ends are free.
      if (!model.isEnd(index)) assert.ok(solution.min(variable) >= lo && solution.max(variable) <= hi, `index ${index} outside its window`);
      assert.equal(solution.value(variable), cumuls[v][k]);
      assert.equal(solution.min(variable), cumuls[v][k], 'value() is the lower bound of the range');
    });
    total += cumuls[v].at(-1);
  });
  assert.equal(total, 82, 'the sample prints "Total time of all routes: 82min"');
});

function pickupDelivery(policy) {
  const manager = new RoutingIndexManager(17, 4, 0);
  const model = new RoutingModel(manager);
  const t = model.registerTransitMatrix(data.distance17);
  model.setArcCostEvaluatorOfAllVehicles(t);
  model.addDimension(t, 0, 3000, true, 'Distance');
  const distance = model.getDimensionOrDie('Distance');
  distance.setGlobalSpanCostCoefficient(100);
  const solver = model.solver();
  const pairs = data.pickupsDeliveries.map(([p, d]) => [manager.nodeToIndex(p), manager.nodeToIndex(d)]);
  for (const [p, d] of pairs) {
    model.addPickupAndDelivery(p, d);
    solver.add(model.vehicleVar(p).eq(model.vehicleVar(d)));
    solver.add(distance.cumulVar(p).le(distance.cumulVar(d)));
  }
  if (policy) model.setPickupAndDeliveryPolicyOfAllVehicles(policy);
  return { manager, model, pairs };
}

function assertPairsHold(solution, pairs) {
  const where = new Map();
  solution.routes().forEach((route, v) => route.forEach((index, k) => where.set(index, [v, k])));
  for (const [p, d] of pairs) {
    const [vp, kp] = where.get(p);
    const [vd, kd] = where.get(d);
    assert.equal(vp, vd, `pair ${p}->${d} split across vehicles`);
    assert.ok(kp < kd, `delivery ${d} before pickup ${p}`);
  }
}

test('vrp_pickup_delivery: objective 226116', async () => {
  const { model, pairs } = pickupDelivery();
  const solution = await model.solveWithParameters(PARALLEL_CHEAPEST_INSERTION);
  assert.equal(solution.objectiveValue(), 226116);
  assertPairsHold(solution, pairs);
});

test('vrp_pickup_delivery_fifo: objective 210892', async () => {
  const { model, pairs } = pickupDelivery(PickupAndDeliveryPolicy.PICKUP_AND_DELIVERY_FIFO);
  const solution = await model.solveWithParameters(PARALLEL_CHEAPEST_INSERTION);
  assert.equal(solution.objectiveValue(), 210892);
  assertPairsHold(solution, pairs);
});

test('vrp_pickup_delivery_lifo: objective 226116', async () => {
  const { model, pairs } = pickupDelivery(PickupAndDeliveryPolicy.PICKUP_AND_DELIVERY_LIFO);
  const solution = model.solveWithParametersSync(PARALLEL_CHEAPEST_INSERTION);
  assert.equal(solution.objectiveValue(), 226116);
  assertPairsHold(solution, pairs);
});

test('vrp_starts_ends (multiple depots): objective 115794, routes start and end where asked', async () => {
  const starts = [1, 2, 15, 16];
  const manager = new RoutingIndexManager(17, 4, starts, [0, 0, 0, 0]);
  const model = new RoutingModel(manager);
  const t = model.registerTransitCallback(distanceCallback(manager, data.distance17));
  model.setArcCostEvaluatorOfAllVehicles(t);
  model.addDimension(t, 0, 2000, true, 'Distance');
  model.getDimensionOrDie('Distance').setGlobalSpanCostCoefficient(100);
  const solution = await model.solveWithParameters(PATH_CHEAPEST_ARC);
  assert.equal(solution.objectiveValue(), 115794);
  solution.routes().forEach((route, v) => {
    assert.equal(manager.indexToNode(route[0]), starts[v]);
    assert.equal(manager.indexToNode(route.at(-1)), 0);
  });
  assert.equal(manager.nodeToIndex(0), -1, 'an end-only depot has no unique index');
});

test('vrp_drop_nodes (deterministic): objective 7936, drops nodes 6 and 15', async () => {
  const manager = new RoutingIndexManager(17, 4, 0);
  const model = new RoutingModel(manager);
  model.setArcCostEvaluatorOfAllVehicles(model.registerTransitMatrix(data.distance17));
  const demand = model.registerUnaryTransitVector(data.dropNodesDemands);
  model.addDimensionWithVehicleCapacity(demand, 0, [15, 15, 15, 15], true, 'Capacity');
  for (let node = 1; node < 17; node++) model.addDisjunction([manager.nodeToIndex(node)], 1000);
  const solution = await model.solveWithParameters(PATH_CHEAPEST_ARC);
  assert.equal(solution.objectiveValue(), 7936);
  const dropped = [];
  for (let node = 1; node < 17; node++) {
    if (solution.value(model.nextVar(manager.nodeToIndex(node))) === manager.nodeToIndex(node)) dropped.push(node);
  }
  assert.deepEqual(dropped, [6, 15]);
  for (const node of dropped) assert.equal(solution.value(model.activeVar(manager.nodeToIndex(node))), 0);
});
