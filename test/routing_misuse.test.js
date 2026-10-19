'use strict';
// Every call below reaches an OR-Tools CHECK / LOG(FATAL), an unchecked vector
// index, a null dereference or Solver::Fail() outside a search unless the
// binding guards it first. Each runs in a child process so that a regression
// shows up as a crash of that child, not of the test runner.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { runIsolated } = require('./helpers/isolated');

const SETUP = `
  const { RoutingIndexManager, RoutingModel } = ortools;
  const build = (vehicles = 2, nodes = 5) => {
    const manager = new RoutingIndexManager(nodes, vehicles, 0);
    const model = new RoutingModel(manager);
    const transit = model.registerTransitCallback((i, j) => i + j);
    model.setArcCostEvaluatorOfAllVehicles(transit);
    model.addDimension(transit, 5, 100, false, 'D');
    return { manager, model, transit, d: model.getDimensionOrDie('D') };
  };
  // An array of length copies of value; reading the last element runs effect.
  const trap = (value, effect, length = 1) => {
    const array = new Array(length).fill(value);
    Object.defineProperty(array, length - 1, { get() { effect(); return value; } });
    return array;
  };`;

function expectAllThrow(cases) {
  const { status, signal, stderr, results } = runIsolated(SETUP, cases);
  assert.equal(signal, null, `child crashed: ${stderr}`);
  assert.equal(status, 0, `child failed: ${stderr}`);
  for (const name of Object.keys(cases)) {
    assert.equal(typeof results[name], 'string', `${name} did not throw`);
  }
  return results;
}

test('index manager CHECKs are guarded', () => {
  expectAllThrow({
    startsEndsSizeMismatch: 'new RoutingIndexManager(4, 2, [0], [0, 1])',  // CHECK_EQ(starts.size(), num_vehicles)
    depotOutOfRange: 'new RoutingIndexManager(4, 1, 4)',                    // CHECK_LE + node_to_index_[start]
    negativeEnd: 'new RoutingIndexManager(4, 1, [0], [-1])',                // CHECK_GE(end, 0)
    endOnlyNodeToIndices: 'new RoutingIndexManager(3, 1, [0], [2]).nodesToIndices([2])',  // CHECK_NE(kUnassigned)
    indexToNodeOutOfRange: 'new RoutingIndexManager(3, 1, 0).indexToNode(99)',          // DCHECK only
    nodeToIndexOutOfRange: 'new RoutingIndexManager(3, 1, 0).nodeToIndex(-1)',
    zeroVehicles: 'new RoutingIndexManager(3, 0, 0)',
    rawWrongManager: 'new ortools.native.RoutingModel({})',
  });
});

test('model CHECKs and unchecked indices are guarded', () => {
  const results = expectAllThrow({
    arcCostVehicle: 'const { model, transit } = build(); model.setArcCostEvaluatorOfVehicle(transit, 2)',
    arcCostEvaluator: 'build().model.setArcCostEvaluatorOfAllVehicles(42)',
    fixedCostVehicle: 'build().model.setFixedCostOfVehicle(1, 9)',
    capacitiesPerVehicle: 'const { model, transit } = build(); model.addDimensionWithVehicleCapacity(transit, 0, [1], true, "X")',
    negativeCapacity: 'const { model, transit } = build(); model.addDimension(transit, 0, -1, true, "X")',
    unknownEvaluator: 'build().model.addDimension(77, 0, 10, true, "X")',
    evaluatorsPerVehicle: 'const { model, transit } = build(); model.addDimensionWithVehicleTransits([transit], 0, 10, true, "X")',
    unknownDimension: 'build().model.getDimensionOrDie("Nope")',
    unknownDimensionRaw: 'build().model._n.dimensionVar("Nope", "cumul", 0)',
    disjunctionCardinality: 'build().model.addDisjunction([1], 10, 0)',
    disjunctionEnd: 'const { model } = build(); model.addDisjunction([model.end(0)], 10)',
    disjunctionStart: 'const { model } = build(); model.addDisjunction([model.start(1)], 10)',
    pickupOutOfRange: 'build().model.addPickupAndDelivery(1, 99)',
    pickupTwice: 'const { model } = build(); model.addPickupAndDelivery(1, 2); model.addPickupAndDelivery(1, 3)',
    pdSetsUnknownDisjunction: 'build().model.addPickupAndDeliverySets(0, 1)',
    policyVehicle: 'build().model.setPickupAndDeliveryPolicyOfVehicle("PICKUP_AND_DELIVERY_LIFO", 5)',
    allowedVehicle: 'build().model.setAllowedVehiclesForIndex([7], 1)',
    visitTypeIndex: 'build().model.setVisitType(99, 0, "TYPE_ADDED_TO_VEHICLE")',
    incompatibilityUnsetType: 'build().model.addHardTypeIncompatibility(0, 3)',
    requiredUnsetType: 'build().model.addRequiredTypeAlternativesWhenAddingType(4, [0])',
    spanUpperBoundNegative: 'build().d.setSpanUpperBoundForVehicle(-1, 0)',
    spanVehicle: 'build().d.setSpanUpperBoundForVehicle(1, 3)',
    spanCostNegative: 'build().d.setSpanCostCoefficientForVehicle(-1, 0)',
    spanCostAllNegative: 'build().d.setSpanCostCoefficientForAllVehicles(-1)',
    globalSpanNegative: 'build().d.setGlobalSpanCostCoefficient(-1)',
    softBoundNegativeCoefficient: 'build().d.setCumulVarSoftUpperBound(1, 5, -1)',
    applyLocksManyVehicles: 'build(2).model.applyLocks([1, 2])',      // CHECK_EQ(vehicles_, 1)
    applyLocksIndex: 'build(1).model.applyLocks([0, 99])',
    applyLocksNotClosed: 'build().model.applyLocksToAllVehicles([[1]], true)',
    cumulVarIndex: 'build().d.cumulVar(99)',
    slackVarOfEnd: 'const { model, d } = build(); d.slackVar(model.end(0))',
    vehicleVarIndex: 'build().model.vehicleVar(99)',
    nextVarOfEnd: 'const { model } = build(); model.nextVar(model.end(0))',
    costVarBeforeClose: 'build().model.costVar()',
    sameActivityEnd: 'const { model } = build(); model.addSameActivityGroup([model.end(1)])',
    valueNotInSolution: 'const { model, d } = build(); const s = model.solveWithParametersSync(); s.value(d.slackVar(1))',
    staleHandle: 'const { model } = build(); model.solveWithParametersSync(); model._n.solutionRoutes(57)',
    staleInitial: `const { model } = build(); const s = model.solveWithParametersSync();
      model.solveWithParametersSync(); model.solveFromAssignmentWithParametersSync(s)`,
    solutionAfterDispose: 'const { model } = build(); const s = model.solveWithParametersSync(); model.dispose(); s.routes()',
    callAfterDispose: 'const { model } = build(); model.dispose(); model.addDisjunction([1])',
    domainEmptiedOutsideSearch: 'build().model.nextVar(1).setMax(-5)',           // Solver::Fail() outside search
    cumulWindowEmptied: 'build().d.cumulVar(1).setRange(500, 600)',
    disposeDuringAsyncSolve: 'const { model } = build(); model.solveWithParameters(); model.dispose()',
    transitCallbackTooLarge: 'new RoutingModel(new RoutingIndexManager(20000, 1, 0)).registerTransitCallback(() => 0)',
    dimensionNameNotString: 'const { model, transit } = build(); model.addDimension(transit, 0, 1, true, {})',
  });
  assert.match(results.applyLocksManyVehicles, /exactly one vehicle/);
  assert.match(results.domainEmptiedOutsideSearch, /CP solver failure/);
  assert.match(results.transitCallbackTooLarge, /exceed the limit/);
});

// Rule: read JS arguments before touching the model. A getter, Proxy or
// callback met while reading may dispose or solve the very model.
test('argument getters and callbacks that dispose, solve or throw cannot crash a routing call', () => {
  const results = expectAllThrow({
    disposeInMatrixRow: `const { model } = build(1, 3);
      model.registerTransitMatrix([[0, 1, 2], trap(1, () => model.dispose(), 3), [2, 1, 0]])`,
    disposeInTransitCallback: `const { model } = build(1, 3);
      let n = 0; model.registerTransitCallback(() => { if (n++ === 3) model.dispose(); return 1; })`,
    solveInTransitCallback: `const { model } = build(1, 3);
      let n = 0; model.registerTransitCallback(() => { if (n++ === 3) model.solveWithParameters(); return 1; })`,
    disposeInDisjunction: 'const { model } = build(); model.addDisjunction(trap(1, () => model.dispose()), 5)',
    disposeInLocks: `const { model } = build(); model.closeModel();
      model.applyLocksToAllVehicles([trap(1, () => model.dispose())], true)`,
    solveInRoutes: 'const { model } = build(); model.readAssignmentFromRoutes([trap(1, () => model.solveWithParameters())], true)',
    disposeInCapacities: `const { model, transit } = build();
      model.addDimensionWithVehicleCapacity(transit, 0, trap(5, () => model.dispose(), 2), true, 'C')`,
    disposeInOptions: `const { model } = build();
      model._n.solveSync(require(${JSON.stringify(require.resolve('../lib/params'))}).routingSearchParametersJson({}), undefined,
        { get onSolution() { model.dispose(); return undefined; } })`,
    throwingGetter: 'const { model } = build(); model.addDisjunction(trap(1, () => { throw new Error("getter"); }), 5)',
    throwingTransitCallback: 'build().model.registerTransitCallback(() => { throw new Error("transit"); })',
    proxyLength: `build().model.registerTransitMatrix(new Proxy([], { get(t, k) { if (k === 'length') throw new Error('len'); return t[k]; } }))`,
  });
  for (const name of ['disposeInMatrixRow', 'disposeInTransitCallback', 'disposeInDisjunction', 'disposeInLocks',
    'disposeInCapacities', 'disposeInOptions']) {
    assert.match(results[name], /disposed/, name);
  }
  assert.match(results.solveInRoutes, /busy/);
  assert.match(results.throwingTransitCallback, /transit/);
});

// Review findings 1 and 2: these crashed (SIGSEGV) at close/solve before the
// index checks; each case solves, so a missing guard shows as a crash.
test('soft same-vehicle costs and visit types refuse the indices OR-Tools cannot handle', () => {
  const solve = (setup) => `const manager = new RoutingIndexManager(4, 2, 0);
    const model = new RoutingModel(manager);
    model.setArcCostEvaluatorOfAllVehicles(model.registerTransitMatrix([[0, 1, 2, 3], [1, 0, 1, 2], [2, 1, 0, 1], [3, 2, 1, 0]]));
    ${setup}
    model.solveWithParametersSync();`;
  const results = expectAllThrow({
    softSameVehicleEnd0: solve('model.addSoftSameVehicleConstraint([1, model.end(0)], 5)'),
    softSameVehicleEnd1: solve('model.addSoftSameVehicleConstraint([1, model.end(1)], 5)'),
    visitTypeOnEnd: solve(`model.setVisitType(model.end(0), 1, 'TYPE_ADDED_TO_VEHICLE');
      model.setVisitType(1, 0, 'TYPE_ADDED_TO_VEHICLE');
      model.addRequiredTypeAlternativesWhenAddingType(1, [0])`),
    visitTypeOnStart: solve(`model.setVisitType(model.start(1), 1, 'ADDED_TYPE_REMOVED_FROM_VEHICLE');
      model.setVisitType(1, 1, 'TYPE_ADDED_TO_VEHICLE');
      model.setVisitType(2, 0, 'TYPE_ADDED_TO_VEHICLE');
      model.addRequiredTypeAlternativesWhenRemovingType(1, [0])`),
  });
  assert.match(results.softSameVehicleEnd1, /must be in \[0, 4\]/);
  assert.match(results.visitTypeOnStart, /vehicle start/);
});
