'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  RoutingIndexManager, RoutingModel, RoutingDimension, RoutingSolution, VisitTypePolicy,
  PickupAndDeliveryPolicy, buildInfo,
} = require('..');
const { IntVar } = require('..').cp;
const data = require('./fixtures/samples.json');

const PCA = { firstSolutionStrategy: 'PATH_CHEAPEST_ARC' };
const minor = Number(buildInfo.ortoolsVersion.split('.')[1]);

function vrp({ vehicles = 4, nodes = 17 } = {}) {
  const manager = new RoutingIndexManager(nodes, vehicles, 0);
  const model = new RoutingModel(manager);
  const matrix = data.distance17.slice(0, nodes).map((row) => row.slice(0, nodes));
  const transit = model.registerTransitMatrix(matrix);
  model.setArcCostEvaluatorOfAllVehicles(transit);
  return { manager, model, transit, matrix };
}

// ---- RoutingIndexManager --------------------------------------------------------

test('index manager with one depot', () => {
  const m = new RoutingIndexManager(5, 2, 0);
  assert.equal(m.getNumberOfNodes(), 5);
  assert.equal(m.getNumberOfVehicles(), 2);
  assert.equal(m.getNumberOfIndices(), 8, '4 customers, 2 starts, 2 ends');
  assert.deepEqual([m.getStartIndex(0), m.getStartIndex(1)], [0, 5]);
  assert.deepEqual([m.getEndIndex(0), m.getEndIndex(1)], [6, 7]);
  assert.deepEqual(m.nodesToIndices([1, 4]), [1, 4]);
  assert.deepEqual(m.indicesToNodes([0, 5, 6]), [0, 0, 0]);
  assert.equal(m.indexToNode(m.nodeToIndex(3)), 3);
});

test('index manager with separate starts and ends', () => {
  const m = new RoutingIndexManager(4, 2, [0, 1], [2, 3]);
  assert.equal(m.nodeToIndex(2), -1, 'an end-only node has no unique index');
  assert.throws(() => m.nodesToIndices([1, 2]), /only an end depot/);
  assert.deepEqual([m.indexToNode(m.getEndIndex(0)), m.indexToNode(m.getEndIndex(1))], [2, 3]);
});

test('index manager rejects invalid arguments', () => {
  assert.throws(() => new RoutingIndexManager(0, 1, 0), RangeError);
  assert.throws(() => new RoutingIndexManager(3, 0, 0), RangeError);
  assert.throws(() => new RoutingIndexManager(3, 1, 3), RangeError);
  assert.throws(() => new RoutingIndexManager(3, 1, -1), RangeError);
  assert.throws(() => new RoutingIndexManager(3, 2, [0], [0]), /one entry per vehicle/);
  assert.throws(() => new RoutingIndexManager(3, 1, [0], [5]), RangeError);
  assert.throws(() => new RoutingIndexManager(NaN, 1, 0), TypeError);
  assert.throws(() => new RoutingIndexManager(3.5, 1, 0), TypeError);
  assert.throws(() => new RoutingIndexManager('3', 1, 0), TypeError);
  const m = new RoutingIndexManager(3, 1, 0);
  assert.throws(() => m.nodeToIndex(3), RangeError);
  assert.throws(() => m.indexToNode(4), RangeError);
  assert.throws(() => m.getStartIndex(1), RangeError);
  assert.throws(() => m.nodesToIndices([0, 9]), RangeError);
  assert.throws(() => new RoutingModel({}), TypeError);
});

// ---- model basics -------------------------------------------------------------------

test('a single node and vehicle solves to an empty route', () => {
  const manager = new RoutingIndexManager(1, 1, 0);
  const model = new RoutingModel(manager);
  assert.deepEqual([model.size(), model.vehicles(), model.nodes()], [1, 1, 1]);
  const solution = model.solveWithParametersSync();
  assert.equal(solution.objectiveValue(), 0);
  assert.deepEqual(solution.routes(), [[0, 1]]);
  assert.match(model.status(), /^ROUTING_(SUCCESS|OPTIMAL)$/);
});

test('path structure: start, end, isStart, isEnd', () => {
  const { model } = vrp({ vehicles: 2, nodes: 4 });
  assert.equal(model.size(), 5);
  assert.deepEqual([model.start(0), model.start(1), model.end(0), model.end(1)], [0, 4, 5, 6]);
  assert.ok(model.isStart(4) && !model.isStart(1) && model.isEnd(6) && !model.isEnd(0));
  assert.throws(() => model.start(2), RangeError);
  assert.throws(() => model.isEnd(7), RangeError);
});

test('model variables are IntVars of model.solver()', () => {
  const { model } = vrp({ vehicles: 2, nodes: 4 });
  const v = model.vehicleVar(1);
  assert.ok(v instanceof IntVar);
  assert.deepEqual([v.min(), v.max()], [-1, 1]);
  assert.deepEqual([model.activeVar(1).min(), model.activeVar(1).max()], [0, 1]);
  assert.equal(model.nextVar(0).max(), 6);
  assert.equal(model.vehicleVar(5).max(), 1, 'ends have vehicle variables too');
  assert.throws(() => model.nextVar(5), RangeError, 'ends have no next variable');
  assert.throws(() => model.activeVar(-1), RangeError);
  assert.throws(() => model.costVar(), /once the model is closed/);
  model.closeModel();
  assert.ok(model.costVar() instanceof IntVar);
  assert.equal(model.solver(), model.solver());
});

test('CP constraints on model variables shape the solution', () => {
  const { model } = vrp({ vehicles: 2, nodes: 6 });
  const s = model.solver();
  s.add(model.vehicleVar(1).eq(model.vehicleVar(2)));
  model.vehicleVar(3).removeValues([0]);
  model.vehicleVar(1).setValue(0);
  const solution = model.solveWithParametersSync(PCA);
  const vehicleOf = (i) => solution.value(model.vehicleVar(i));
  assert.equal(vehicleOf(1), 0);
  assert.equal(vehicleOf(2), 0);
  assert.equal(vehicleOf(3), 1);
});

// ---- transits ------------------------------------------------------------------------

test('transit callbacks are evaluated eagerly and validated', () => {
  const { model, manager } = vrp({ vehicles: 1, nodes: 3 });
  const calls = [];
  model.registerTransitCallback((i, j) => { calls.push([i, j]); return i + j; });
  assert.equal(calls.length, 16, '(size + vehicles)^2 calls at registration');
  assert.throws(() => model.registerTransitCallback(() => 1.5), /\(0, 0\) must be an integer/);
  assert.throws(() => model.registerTransitCallback((i, j) => (j === 2 ? NaN : 0)), /\(0, 2\) must not be NaN/);
  assert.throws(() => model.registerTransitCallback(() => 'x'), TypeError);
  assert.throws(() => model.registerTransitCallback(() => { throw new Error('from fn'); }), /from fn/);
  assert.throws(() => model.registerUnaryTransitCallback((i) => (i === 3 ? 0.5 : 0)), /\(3\) must be an integer/);
  assert.throws(() => model.registerTransitCallback(5), TypeError);
  const big = model.registerTransitCallback(() => 2n ** 40n);
  const inf = model.registerUnaryTransitCallback(() => Infinity);
  assert.equal(typeof big, 'number');
  assert.equal(inf, big + 1);
  assert.equal(manager.getNumberOfIndices(), 4);
});

test('transit matrices and vectors must match the node count', () => {
  const { model } = vrp({ vehicles: 1, nodes: 3 });
  assert.throws(() => model.registerTransitMatrix([[0, 1, 2], [1, 0, 1]]), /3 rows/);
  assert.throws(() => model.registerTransitMatrix([[0, 1, 2], [1, 0], [2, 1, 0]]), /must have 3 entries/);
  assert.throws(() => model.registerTransitMatrix([[0, 1, NaN], [1, 0, 1], [2, 1, 0]]), TypeError);
  assert.throws(() => model.registerTransitMatrix('x'), TypeError);
  assert.throws(() => model.registerUnaryTransitVector([1, 2]), /one entry per node/);
  const typed = model.registerTransitMatrix([new Int32Array([0, 1, 2]), new Float64Array([1, 0, 1]), [2, 1, 0]]);
  const vector = model.registerUnaryTransitVector(new Int32Array([0, 1, 1]));
  assert.equal(vector, typed + 1);
});

test('costs: evaluator ids, vehicles and non-negative fixed costs are checked', () => {
  const { model, transit } = vrp({ vehicles: 2, nodes: 5 });
  assert.throws(() => model.setArcCostEvaluatorOfAllVehicles(99), /unknown transit evaluator/);
  assert.throws(() => model.setArcCostEvaluatorOfVehicle(transit, 2), RangeError);
  assert.throws(() => model.setFixedCostOfAllVehicles(-1), RangeError);
  assert.throws(() => model.setFixedCostOfVehicle(5, 7), RangeError);
  model.setFixedCostOfVehicle(1000, 1);
  model.setFixedCostOfAllVehicles(0);
  model.setFixedCostOfVehicle(1000, 1);
  const solution = model.solveWithParametersSync(PCA);
  assert.equal(solution.routes()[1].length, 2, 'the expensive vehicle stays home');
});

// ---- dimensions -----------------------------------------------------------------------

test('dimensions: creation, duplicates, lookup and variables', () => {
  const { model, transit } = vrp({ vehicles: 2, nodes: 5 });
  assert.equal(model.addDimension(transit, 10, 3000, true, 'Distance'), true);
  assert.equal(model.addDimension(transit, 10, 3000, true, 'Distance'), false, 'a taken name is refused');
  assert.equal(model.hasDimension('Distance'), true);
  assert.equal(model.hasDimension('Nope'), false);
  assert.throws(() => model.getDimensionOrDie('Nope'), /Unknown dimension 'Nope'/);
  const d = model.getDimensionOrDie('Distance');
  assert.ok(d instanceof RoutingDimension);
  assert.equal(d.name(), 'Distance');
  assert.deepEqual([d.cumulVar(model.start(0)).max(), d.cumulVar(model.end(1)).max()], [0, 3000]);
  assert.equal(d.slackVar(1).max(), 10);
  assert.ok(d.transitVar(1) instanceof IntVar);
  assert.throws(() => d.slackVar(model.end(0)), RangeError, 'ends have no slack');
  assert.throws(() => d.cumulVar(99), RangeError);
  const [constant, created] = model.addConstantDimension(1, 10, true, 'Stops');
  assert.equal(created, true);
  assert.equal(typeof constant, 'number');
  assert.deepEqual(model.addVectorDimension([0, 1, 1, 1, 1], 4, true, 'Load')[1], true);
  assert.deepEqual(model.addMatrixDimension(data.distance17.slice(0, 5).map((r) => r.slice(0, 5)), 5000, true,
    'Matrix')[1], true);
  assert.equal(model.addDimensionWithVehicleCapacity(constant, 0, [3, 4], true, 'Cap'), true);
  assert.equal(model.addDimensionWithVehicleTransits([transit, constant], 0, 5000, true, 'PerVehicle'), true);
  assert.equal(model.addDimensionWithVehicleTransitAndCapacity([transit, transit], 0, [4000, 5000], false, 'Both'),
    true);
  const solution = model.solveWithParametersSync(PCA);
  assert.ok(solution.cumuls('Load').every((route) => route.at(-1) <= 4));
  const caps = solution.cumuls('Cap');
  assert.ok(caps[0].at(-1) <= 3 && caps[1].at(-1) <= 4);
  assert.deepEqual(solution.routes().flat().length, 4 + 4, 'all 4 customers plus 2 starts and 2 ends');
});

test('dimension arguments are validated before reaching OR-Tools', () => {
  const { model, transit } = vrp({ vehicles: 2, nodes: 5 });
  assert.throws(() => model.addDimension(transit, -1, 10, true, 'D'), /slackMax must be >= 0/);
  assert.throws(() => model.addDimension(transit, 0, -1, true, 'D'), /capacity must be >= 0/);
  assert.throws(() => model.addDimension(42, 0, 10, true, 'D'), /unknown transit evaluator/);
  assert.throws(() => model.addDimension(transit, 0, 10, 'yes', 'D'), /must be a boolean/);
  assert.throws(() => model.addDimension(transit, 0, 10, true, 7), /name must be a string/);
  assert.throws(() => model.addDimensionWithVehicleCapacity(transit, 0, [1], true, 'D'), /one entry per vehicle/);
  assert.throws(() => model.addDimensionWithVehicleCapacity(transit, 0, [1, -1], true, 'D'), />= 0/);
  assert.throws(() => model.addDimensionWithVehicleTransits([transit], 0, 1, true, 'D'), /one entry per vehicle/);
  assert.throws(() => model.addDimensionWithVehicleTransits([transit, 9], 0, 1, true, 'D'), /unknown transit/);
  assert.throws(() => model.addVectorDimension([1, 2], 1, true, 'D'), /one entry per node/);
  assert.throws(() => model.addConstantDimension(NaN, 1, true, 'D'), TypeError);
  model.addDimension(transit, 0, Infinity, true, 'Unbounded');
  const d = model.getDimensionOrDie('Unbounded');
  assert.equal(d.cumulVar(model.end(0)).max(), Infinity, 'Infinity maps to kint64max and back');
  assert.throws(() => d.setSpanUpperBoundForVehicle(-1, 0), />= 0/);
  assert.throws(() => d.setSpanUpperBoundForVehicle(10, 2), RangeError);
  assert.throws(() => d.setSpanCostCoefficientForVehicle(-1, 0), />= 0/);
  assert.throws(() => d.setSpanCostCoefficientForAllVehicles(-5), />= 0/);
  assert.throws(() => d.setGlobalSpanCostCoefficient(-1), />= 0/);
  assert.throws(() => d.setCumulVarSoftUpperBound(1, 10, -1), />= 0/);
  assert.throws(() => d.setCumulVarSoftLowerBound(99, 10, 1), RangeError);
});

test('zero capacities leave demanding nodes unserved unless optional', () => {
  const { model } = vrp({ vehicles: 1, nodes: 4 });
  const demand = model.registerUnaryTransitVector([0, 1, 1, 0]);
  model.addDimension(demand, 0, 0, true, 'Load');
  for (const i of [1, 2, 3]) model.addDisjunction([i], 10000);
  const solution = model.solveWithParametersSync(PCA);
  assert.deepEqual(solution.routes()[0].slice(1, -1), [3]);
  assert.equal(solution.value(model.activeVar(1)), 0);

  const strict = vrp({ vehicles: 1, nodes: 3 }).model;
  strict.addDimension(strict.registerUnaryTransitVector([0, 1, 0]), 0, 0, true, 'Load');
  assert.equal(strict.solveWithParametersSync(PCA), null);
  assert.match(strict.status(), /ROUTING_(FAIL|INFEASIBLE)/);
});

test('span limits, span costs and soft bounds shape the routes', () => {
  const { model, transit } = vrp({ vehicles: 2, nodes: 6 });
  model.addDimension(transit, 0, 5000, true, 'Distance');
  const d = model.getDimensionOrDie('Distance');
  d.setSpanUpperBoundForVehicle(2000, 0);
  d.setSpanUpperBoundForVehicle(2000, 1);
  d.setSpanCostCoefficientForAllVehicles(1);
  d.setSpanCostCoefficientForVehicle(2, 1);
  d.setCumulVarSoftUpperBound(model.end(0), 1000, 5);
  d.setCumulVarSoftLowerBound(model.end(1), 10, 1);
  const solution = model.solveWithParametersSync(PCA);
  assert.ok(solution.cumuls(d).every((route) => route.at(-1) <= 2000));
});

// ---- ride rules ------------------------------------------------------------------------

test('disjunctions: penalties, cardinality and validation', () => {
  const { model } = vrp({ vehicles: 1, nodes: 6 });
  assert.equal(model.addDisjunction([1, 2], 1_000_000, 1), 0);
  assert.equal(model.addDisjunction([3], 0), 1, 'a zero penalty makes the node free to drop');
  const solution = model.solveWithParametersSync(PCA);
  const visited = solution.routes()[0].slice(1, -1);
  assert.equal(visited.filter((i) => i === 1 || i === 2).length, 1, 'max cardinality 1');
  assert.ok(!visited.includes(3));
  const fresh = vrp({ vehicles: 2, nodes: 6 }).model;
  assert.throws(() => fresh.addDisjunction([1], 10, 0), RangeError);
  assert.throws(() => fresh.addDisjunction([1, 1], 10), /twice/);
  assert.throws(() => fresh.addDisjunction([fresh.start(1)], 10), /vehicle start/);
  assert.throws(() => fresh.addDisjunction([fresh.end(0)], 10), RangeError);
  assert.throws(() => fresh.addDisjunction([NaN]), TypeError);
});

test('allowed vehicles restrict which vehicle serves an index', () => {
  const { model } = vrp({ vehicles: 3, nodes: 6 });
  model.setAllowedVehiclesForIndex([2], 1);
  model.setAllowedVehiclesForIndex([0, 1], 2);
  model.setAllowedVehiclesForIndex([], 3);
  assert.throws(() => model.setAllowedVehiclesForIndex([3], 1), RangeError);
  assert.throws(() => model.setAllowedVehiclesForIndex([0], 99), RangeError);
  const solution = model.solveWithParametersSync(PCA);
  assert.equal(solution.value(model.vehicleVar(1)), 2);
  assert.notEqual(solution.value(model.vehicleVar(2)), 2);
});

test('pickup and delivery pairs are validated', () => {
  const { model } = vrp({ vehicles: 2, nodes: 6 });
  model.addPickupAndDelivery(1, 2);
  assert.throws(() => model.addPickupAndDelivery(1, 3), /already in a pickup and delivery pair/);
  assert.throws(() => model.addPickupAndDelivery(3, 2), /already in a pickup and delivery pair/);
  assert.throws(() => model.addPickupAndDelivery(3, 3), /must differ/);
  assert.throws(() => model.addPickupAndDelivery(model.start(1), 3), /vehicle start/);
  assert.throws(() => model.addPickupAndDelivery(3, model.end(0)), RangeError);
  assert.throws(() => model.setPickupAndDeliveryPolicyOfAllVehicles('NOPE'), /unknown pickup and delivery policy/);
  assert.throws(() => model.setPickupAndDeliveryPolicyOfVehicle(PickupAndDeliveryPolicy.PICKUP_AND_DELIVERY_LIFO, 2),
    RangeError);
  assert.throws(() => model.setPickupAndDeliveryPolicyOfVehicle('PICKUP_AND_DELIVERY_LIFO'), TypeError);
  model.setPickupAndDeliveryPolicyOfVehicle(PickupAndDeliveryPolicy.PICKUP_AND_DELIVERY_FIFO, 1);
});

test('pickup and delivery sets between disjunctions', () => {
  const { model, transit } = vrp({ vehicles: 2, nodes: 7 });
  model.addDimension(transit, 0, 10000, true, 'Distance');
  const d = model.getDimensionOrDie('Distance');
  const pickups = model.addDisjunction([1, 2], 100000);
  const deliveries = model.addDisjunction([3, 4], 100000);
  model.addPickupAndDeliverySets(pickups, deliveries);
  assert.throws(() => model.addPickupAndDeliverySets(pickups, deliveries), /already in a pickup and delivery pair/);
  assert.throws(() => model.addPickupAndDeliverySets(9, deliveries), /unknown disjunction/);
  const loop = model.addDisjunction([5, 6], 10);
  assert.throws(() => model.addPickupAndDeliverySets(loop, loop), /must differ/);
  const solution = model.solveWithParametersSync({ firstSolutionStrategy: 'PARALLEL_CHEAPEST_INSERTION' });
  const routes = solution.routes();
  const vehicleOf = (i) => routes.findIndex((r) => r.includes(i));
  const picked = [1, 2].filter((i) => vehicleOf(i) >= 0);
  const dropped = [3, 4].filter((i) => vehicleOf(i) >= 0);
  assert.equal(picked.length, 1);
  assert.equal(dropped.length, 1);
  assert.equal(vehicleOf(picked[0]), vehicleOf(dropped[0]));
  assert.ok(solution.value(d.cumulVar(picked[0])) <= solution.value(d.cumulVar(dropped[0])));
});

test('visit types: incompatibilities and requirements', () => {
  const { model } = vrp({ vehicles: 2, nodes: 7 });
  assert.throws(() => model.addHardTypeIncompatibility(0, 1), /setVisitType\(\) first/);
  model.setVisitType(1, 0, VisitTypePolicy.TYPE_ADDED_TO_VEHICLE);
  model.setVisitType(2, 1, VisitTypePolicy.TYPE_ADDED_TO_VEHICLE);
  model.setVisitType(3, 1, VisitTypePolicy.TYPE_SIMULTANEOUSLY_ADDED_AND_REMOVED);
  model.setVisitType(4, 2, VisitTypePolicy.TYPE_ADDED_TO_VEHICLE);
  model.setVisitType(5, 3, VisitTypePolicy.TYPE_ON_VEHICLE_UP_TO_VISIT);
  model.setVisitType(6, 3, VisitTypePolicy.ADDED_TYPE_REMOVED_FROM_VEHICLE);
  model.addHardTypeIncompatibility(0, 1);
  model.addTemporalTypeIncompatibility(3, 1);
  // A type-2 visit needs a type-0 visit earlier on its vehicle.
  model.addRequiredTypeAlternativesWhenAddingType(2, [0]);
  model.addRequiredTypeAlternativesWhenRemovingType(3, [0, 1, 2, 3]);
  assert.throws(() => model.addHardTypeIncompatibility(0, 7), /setVisitType\(\) first/);
  assert.throws(() => model.addRequiredTypeAlternativesWhenAddingType(0, [9]), /setVisitType\(\) first/);
  assert.throws(() => model.setVisitType(1, -1, 'TYPE_ADDED_TO_VEHICLE'), RangeError);
  assert.throws(() => model.setVisitType(1, 2 ** 21, 'TYPE_ADDED_TO_VEHICLE'), RangeError);
  assert.throws(() => model.setVisitType(1, 0, 'NOPE'), /unknown visit type policy/);
  const solution = model.solveWithParametersSync({ firstSolutionStrategy: 'PARALLEL_CHEAPEST_INSERTION' });
  assert.ok(solution, model.status());
  const routes = solution.routes();
  const vehicleOf = (i) => routes.findIndex((r) => r.includes(i));
  assert.notEqual(vehicleOf(1), vehicleOf(2), 'types 0 and 1 are hard-incompatible');
  assert.notEqual(vehicleOf(1), vehicleOf(3));
  assert.equal(vehicleOf(4), vehicleOf(1), 'type 2 requires type 0 on its vehicle');
  const route = routes[vehicleOf(1)];
  assert.ok(route.indexOf(1) < route.indexOf(4));
});

test('soft same-vehicle costs and same-activity groups', () => {
  const { model } = vrp({ vehicles: 2, nodes: 7 });
  model.addSoftSameVehicleConstraint([1, 6], 100000);
  assert.throws(() => model.addSoftSameVehicleConstraint([99], 1), RangeError);
  for (const i of [2, 3]) model.addDisjunction([i], 0);
  if (minor >= 15) {
    model.addSameActivityGroup([2, 3]);
    assert.throws(() => model.addSameActivityGroup([model.end(0)]), RangeError);
  } else {
    assert.throws(() => model.addSameActivityGroup([2, 3]), /needs OR-Tools 9.15/);
  }
  const solution = model.solveWithParametersSync(PCA);
  assert.equal(solution.value(model.vehicleVar(1)), solution.value(model.vehicleVar(6)));
  if (minor >= 15) assert.equal(solution.value(model.activeVar(2)), solution.value(model.activeVar(3)));
});

test('finalizer variables and addToAssignment', () => {
  const { model, transit } = vrp({ vehicles: 1, nodes: 5 });
  model.addDimension(transit, 100, 10000, false, 'Time');
  const time = model.getDimensionOrDie('Time');
  model.addVariableMinimizedByFinalizer(time.cumulVar(model.start(0)));
  model.addVariableMaximizedByFinalizer(time.cumulVar(model.end(0)));
  model.addVariableTargetToFinalizer(time.cumulVar(2), 500);
  for (let i = 0; i < model.size(); i++) model.addToAssignment(time.slackVar(i));
  const extra = model.solver().intVar(0, 5, 'extra');
  assert.throws(() => model.addToAssignment(5), TypeError);
  const solution = model.solveWithParametersSync(PCA);
  assert.equal(solution.value(time.cumulVar(model.start(0))), 0);
  const slacks = solution.slacks(time);
  assert.equal(slacks[0].length, solution.routes()[0].length);
  assert.equal(slacks[0].at(-1), null, 'ends have no slack');
  assert.ok(slacks[0].slice(0, -1).every((s) => s >= 0 && s <= 100));
  assert.throws(() => solution.value(extra), /not stored in solutions/);
  assert.throws(() => solution.cumuls(42), TypeError);
  assert.throws(() => solution.cumuls('Nope'), /Unknown dimension/);
});

test('slacks() needs the slacks in the solution', () => {
  const { model, transit } = vrp({ vehicles: 1, nodes: 4 });
  model.addDimension(transit, 10, 10000, true, 'Time');
  const solution = model.solveWithParametersSync(PCA);
  assert.throws(() => solution.slacks('Time'), /addToAssignment/);
  assert.equal(solution.cumuls('Time')[0][0], 0);
});

// ---- state machine ---------------------------------------------------------------------

test('model-definition calls throw once the model is closed', () => {
  const { model, transit } = vrp({ vehicles: 2, nodes: 5 });
  model.addDimension(transit, 0, 3000, true, 'D');
  const d = model.getDimensionOrDie('D');
  assert.equal(model.closed, false);
  model.closeModelWithParameters(PCA);
  assert.equal(model.closed, true);
  model.closeModel(); // no-op once closed
  const closedCalls = [
    () => model.setArcCostEvaluatorOfAllVehicles(transit),
    () => model.setArcCostEvaluatorOfVehicle(transit, 0),
    () => model.setFixedCostOfAllVehicles(1),
    () => model.setFixedCostOfVehicle(1, 0),
    () => model.addDimension(transit, 0, 10, true, 'E'),
    () => model.addConstantDimension(1, 10, true, 'E'),
    () => model.addDisjunction([1], 10),
    () => model.addPickupAndDelivery(1, 2),
    () => model.setPickupAndDeliveryPolicyOfAllVehicles('PICKUP_AND_DELIVERY_LIFO'),
    () => model.setAllowedVehiclesForIndex([0], 1),
    () => model.setVisitType(1, 0, 'TYPE_ADDED_TO_VEHICLE'),
    () => model.addSoftSameVehicleConstraint([1, 2], 1),
    () => model.addVariableMinimizedByFinalizer(model.nextVar(1)),
    () => model.addToAssignment(model.nextVar(1)),
    () => d.setGlobalSpanCostCoefficient(1),
    () => d.setSpanUpperBoundForVehicle(1, 0),
    () => d.setCumulVarSoftUpperBound(1, 1, 1),
  ];
  for (const call of closedCalls) assert.throws(call, /before the model is closed/);
  // Still allowed: variables, CP constraints, solving.
  model.solver().add(model.vehicleVar(1).eq(0));
  const solution = model.solveWithParametersSync(PCA);
  assert.equal(solution.value(model.vehicleVar(1)), 0);
  // Registering after close would reallocate evaluators the solver's filters reference.
  const matrix = data.distance17.slice(0, 5).map((r) => r.slice(0, 5));
  assert.throws(() => model.registerTransitMatrix(matrix), /before the model is closed/);
  assert.throws(() => model.registerUnaryTransitVector([0, 1, 1, 1, 1]), /before the model is closed/);
  assert.throws(() => model.registerTransitCallback(() => 0), /before the model is closed/);
  assert.throws(() => model.registerUnaryTransitCallback(() => 0), /before the model is closed/);
});

test('solving closes the model', async () => {
  const { model } = vrp({ vehicles: 1, nodes: 4 });
  await model.solveWithParameters(PCA);
  assert.equal(model.closed, true);
  assert.throws(() => model.addDisjunction([1], 1), /closed/);
});

test('invalid parameters are rejected before closing', () => {
  const { model } = vrp({ vehicles: 1, nodes: 4 });
  assert.throws(() => model.closeModelWithParameters({ firstSolutionStrategy: 'NOPE' }), TypeError);
  assert.throws(() => model.solveWithParametersSync({ solutionLimit: -1 }), RangeError);
  assert.throws(() => model.solveWithParametersSync(PCA, { onSolution: 5 }), TypeError);
  assert.throws(() => model.solveWithParametersSync(PCA, 'x'), TypeError);
  assert.equal(model.closed, false);
});

// ---- solutions -------------------------------------------------------------------------

test('a solution is invalid after the next solve, a model change or dispose', async () => {
  const { model } = vrp({ vehicles: 2, nodes: 6 });
  const first = model.solveWithParametersSync(PCA);
  assert.ok(first instanceof RoutingSolution);
  assert.equal(first.valid, true);
  const objective = first.objectiveValue();
  const second = await model.solveWithParameters(PCA);
  assert.equal(first.valid, false);
  assert.throws(() => first.objectiveValue(), /no longer valid/);
  assert.throws(() => first.routes(), /no longer valid/);
  assert.equal(second.objectiveValue(), objective);
  model.solver().add(model.vehicleVar(1).ge(0));
  assert.throws(() => second.routes(), /no longer valid/, 'a CP change invalidates solutions');
  const third = model.solveWithParametersSync(PCA);
  model.nextVar(1).removeValue(1);
  assert.equal(third.valid, false, 'a domain change invalidates solutions');
  const fourth = model.solveWithParametersSync(PCA);
  model.dispose();
  assert.equal(fourth.valid, false);
  assert.throws(() => fourth.objectiveValue(), /disposed/);
});

test('solution min / max / value', () => {
  const { model, transit } = vrp({ vehicles: 1, nodes: 4 });
  model.addDimension(transit, 1000, 100000, false, 'Time');
  const time = model.getDimensionOrDie('Time');
  const solution = model.solveWithParametersSync(PCA);
  const start = time.cumulVar(model.start(0));
  assert.ok(solution.min(start) <= solution.max(start));
  assert.equal(solution.value(start), solution.min(start));
  assert.throws(() => solution.value(5), TypeError);
  const other = vrp({ vehicles: 1, nodes: 4 }).model;
  assert.throws(() => solution.value(other.nextVar(1)), /different CpSolver/);
});

test('readAssignmentFromRoutes and a warm start', async () => {
  const { model } = vrp({ vehicles: 2, nodes: 7 });
  const initial = model.readAssignmentFromRoutes([[1, 2, 3], [4, 5, 6]], true);
  assert.ok(initial instanceof RoutingSolution);
  assert.deepEqual(initial.routes(), [[0, 1, 2, 3, 8], [7, 4, 5, 6, 9]]);
  assert.equal(model.closed, true);
  const initialCost = initial.objectiveValue();
  const improved = await model.solveFromAssignmentWithParameters(initial, PCA);
  assert.ok(improved.objectiveValue() <= initialCost);
  assert.equal(initial.valid, false);
  const again = model.readAssignmentFromRoutes([[1, 2, 3, 4, 5, 6]], false);
  const againCost = again.objectiveValue();
  const sync = model.solveFromAssignmentWithParametersSync(again, PCA);
  assert.ok(sync.objectiveValue() <= againCost);
});

test('readAssignmentFromRoutes: null when infeasible, errors for invalid input', () => {
  const { model } = vrp({ vehicles: 2, nodes: 5 });
  model.setAllowedVehiclesForIndex([1], 1);
  assert.equal(model.readAssignmentFromRoutes([[1, 2]], true), null, 'vehicle 0 may not visit index 1');
  assert.equal(model.readAssignmentFromRoutes([[2, 2]], true), null, 'an index used twice');
  assert.throws(() => model.readAssignmentFromRoutes([[99]], true), RangeError);
  assert.throws(() => model.readAssignmentFromRoutes([[model.start(1), 2]], true), /must not contain vehicle starts/);
  assert.throws(() => model.readAssignmentFromRoutes([[1], [2], [3]], true), /more routes than/);
  assert.throws(() => model.readAssignmentFromRoutes([[1]], 'yes'), TypeError);
  assert.throws(() => model.readAssignmentFromRoutes('x', true), TypeError);
  const other = vrp({ vehicles: 2, nodes: 5 }).model;
  const foreign = other.readAssignmentFromRoutes([[1, 2, 3, 4]], true);
  assert.ok(foreign);
  assert.throws(() => model.solveFromAssignmentWithParametersSync(foreign, PCA), /different RoutingModel/);
  assert.throws(() => model.solveFromAssignmentWithParametersSync({}, PCA), TypeError);
});

test('applyLocksToAllVehicles fixes partial routes', () => {
  const { model } = vrp({ vehicles: 2, nodes: 7 });
  assert.throws(() => model.applyLocksToAllVehicles([[1]], false), /needs a closed model/);
  model.closeModelWithParameters(PCA);
  assert.equal(model.applyLocksToAllVehicles([[3, 1], [2]], false), true);
  const solution = model.solveWithParametersSync(PCA);
  const [r0, r1] = solution.routes();
  assert.deepEqual(r0.slice(1, 3), [3, 1]);
  assert.equal(r1[1], 2);
  assert.equal(model.applyLocksToAllVehicles([[1, 1]], false), false, 'invalid locks return false, as in OR-Tools');
  assert.throws(() => model.applyLocksToAllVehicles([[1], [2], [3]], true), /more routes/);
  assert.throws(() => model.applyLocksToAllVehicles([[100]], true), RangeError);
  assert.throws(() => model.applyLocksToAllVehicles([[model.start(1)]], true), /must not contain vehicle starts/);
  assert.throws(() => model.applyLocksToAllVehicles([[1]], 1), TypeError);
});

test('applyLocks needs exactly one vehicle', () => {
  const multi = vrp({ vehicles: 2, nodes: 5 }).model;
  assert.throws(() => multi.applyLocks([1, 2]), /exactly one vehicle/);
  const { model } = vrp({ vehicles: 1, nodes: 5 });
  const next = model.applyLocks([0, 3, 1]);
  assert.ok(next instanceof IntVar);
  assert.equal(model.applyLocks([]), null);
  model.applyLocks([0, 3, 1]);
  const solution = model.solveWithParametersSync(PCA);
  assert.deepEqual(solution.routes()[0].slice(0, 3), [0, 3, 1]);
  assert.throws(() => model.applyLocks([model.end(0)]), RangeError);
});

// ---- lifecycle -------------------------------------------------------------------------

test('dispose frees the model; every later call and old handle throws', () => {
  const { model } = vrp({ vehicles: 1, nodes: 4 });
  const v = model.nextVar(1);
  const solver = model.solver();
  model.dispose();
  model.dispose(); // idempotent
  assert.throws(() => model.nextVar(1), /disposed/);
  assert.throws(() => model.addDisjunction([1]), /disposed/);
  assert.throws(() => model.solveWithParametersSync(), /disposed/);
  assert.throws(() => model.status(), /disposed/);
  assert.throws(() => v.min(), /no longer valid/);
  assert.throws(() => solver.intVar(0, 1), /disposed/);
  assert.equal(model.interrupt(), false);
  assert.equal(model.size(), 5 - 2 + 1 - 1 + 1, 'sizes stay readable');
});

test('`using` disposes a model', () => {
  let leaked;
  {
    const { model } = vrp({ vehicles: 1, nodes: 3 });
    leaked = model;
    model[Symbol.dispose]();
  }
  assert.throws(() => leaked.nextVar(1), /disposed/);
});

test("the routing model's solver cannot be disposed on its own", () => {
  const { model } = vrp({ vehicles: 1, nodes: 3 });
  assert.throws(() => model.solver().dispose(), /dispose the model instead/);
  assert.equal(model.nextVar(1).max(), 3);
});

test('an open CP search on the model solver blocks the model', () => {
  const { model } = vrp({ vehicles: 1, nodes: 4 });
  const s = model.solver();
  const x = s.intVar(0, 3, 'x');
  s.newSearch(s.phase([x], 'CHOOSE_FIRST_UNBOUND', 'ASSIGN_MIN_VALUE'));
  assert.equal(s.nextSolution(), true);
  assert.throws(() => model.solveWithParametersSync(), /search on its solver/);
  assert.throws(() => model.dispose(), /search on its solver/);
  s.endSearch();
  assert.ok(model.solveWithParametersSync(PCA));
});
