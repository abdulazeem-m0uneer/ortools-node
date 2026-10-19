'use strict';

// Vehicle routing (pywrapcp's RoutingIndexManager / RoutingModel), with
// camelCase names. Model variables (nextVar, vehicleVar, activeVar, cumulVar...)
// are IntVars of model.solver(), the model's cp.CpSolver, so CP constraints on
// them work as in Python:
//
//   model.solver().add(model.vehicleVar(p).eq(model.vehicleVar(d)));
//   model.solver().add(time.cumulVar(p).le(time.cumulVar(d)));
//
// Solving runs on the libuv threadpool (or synchronously with the *Sync
// variants) and yields a RoutingSolution, valid until the model is solved
// again, changed or disposed.

const native = require('./native');
const { CpSolver, IntExpr } = require('./cp');
const { routingSearchParametersJson } = require('./params');

const enumOf = (names) => Object.freeze(Object.fromEntries(names.map((n) => [n, n])));

/** How a visit of a typed node changes the types on the vehicle (RoutingModel::VisitTypePolicy). */
const VisitTypePolicy = enumOf([
  'TYPE_ADDED_TO_VEHICLE',
  'ADDED_TYPE_REMOVED_FROM_VEHICLE',
  'TYPE_ON_VEHICLE_UP_TO_VISIT',
  'TYPE_SIMULTANEOUSLY_ADDED_AND_REMOVED',
]);

/** Ordering of pickups and deliveries on a route (RoutingModel::PickupAndDeliveryPolicy). */
const PickupAndDeliveryPolicy = enumOf([
  'PICKUP_AND_DELIVERY_NO_ORDER',
  'PICKUP_AND_DELIVERY_LIFO',
  'PICKUP_AND_DELIVERY_FIFO',
]);

/** Maps nodes (your locations) to the variable indices used by RoutingModel. */
class RoutingIndexManager {
  /**
   * new RoutingIndexManager(numNodes, numVehicles, depot)
   * new RoutingIndexManager(numNodes, numVehicles, starts, ends)
   */
  constructor(numNodes, numVehicles, depotOrStarts, ends) {
    this._n = ends === undefined
      ? new native.RoutingIndexManager(numNodes, numVehicles, depotOrStarts)
      : new native.RoutingIndexManager(numNodes, numVehicles, depotOrStarts, ends);
  }
  /** -1 for a node that is only an end depot (it has one index per vehicle). */
  nodeToIndex(node) { return this._n.nodeToIndex(node); }
  indexToNode(index) { return this._n.indexToNode(index); }
  nodesToIndices(nodes) { return this._n.nodesToIndices(nodes); }
  indicesToNodes(indices) { return this._n.indicesToNodes(indices); }
  getNumberOfNodes() { return this._n.getNumberOfNodes(); }
  getNumberOfVehicles() { return this._n.getNumberOfVehicles(); }
  getNumberOfIndices() { return this._n.getNumberOfIndices(); }
  getStartIndex(vehicle) { return this._n.getStartIndex(vehicle); }
  getEndIndex(vehicle) { return this._n.getEndIndex(vehicle); }
}

function readOptions(options) {
  if (options === undefined) return undefined;
  if (options === null || typeof options !== 'object') throw new TypeError('options must be an object');
  if (options.onSolution !== undefined && typeof options.onSolution !== 'function') {
    throw new TypeError('options.onSolution must be a function');
  }
  return { onSolution: options.onSolution, includeRoutes: Boolean(options.includeRoutes) };
}

/** A dimension (time, load, distance...) of a RoutingModel. */
class RoutingDimension {
  constructor(model, name) {
    this._model = model;
    this._name = name;
  }
  name() { return this._name; }
  /** Cumul variable at any index (including starts and ends). */
  cumulVar(index) { return this._var('cumul', index); }
  /** Slack variable at an index that has a next (not an end). */
  slackVar(index) { return this._var('slack', index); }
  transitVar(index) { return this._var('transit', index); }
  setSpanUpperBoundForVehicle(upperBound, vehicle) {
    this._model._n.setSpanUpperBoundForVehicle(this._name, upperBound, vehicle);
  }
  setSpanCostCoefficientForVehicle(coefficient, vehicle) {
    this._model._n.setSpanCostCoefficientForVehicle(this._name, coefficient, vehicle);
  }
  setSpanCostCoefficientForAllVehicles(coefficient) {
    this._model._n.setSpanCostCoefficientForAllVehicles(this._name, coefficient);
  }
  setGlobalSpanCostCoefficient(coefficient) {
    this._model._n.setGlobalSpanCostCoefficient(this._name, coefficient);
  }
  setCumulVarSoftUpperBound(index, upperBound, coefficient) {
    this._model._n.setCumulVarSoftBound(this._name, true, index, upperBound, coefficient);
  }
  setCumulVarSoftLowerBound(index, lowerBound, coefficient) {
    this._model._n.setCumulVarSoftBound(this._name, false, index, lowerBound, coefficient);
  }
  _var(kind, index) { return this._model._wrapVar(this._model._n.dimensionVar(this._name, kind, index)); }
}

/**
 * A solution (or an assignment read from routes). Values come back exact: a
 * number up to 2^53, a bigint beyond (large penalties), ±Infinity at the int64
 * extremes. Valid until the model is
 * solved again, changed (including its solver) or disposed; then every call throws.
 */
class RoutingSolution {
  constructor(model, handle) {
    this._model = model;
    this._handle = handle;
  }
  /** False once the model was solved again, changed or disposed. */
  get valid() { return this._model._n.solutionIsValid(this._handle); }
  objectiveValue() { return this._model._n.solutionObjective(this._handle); }
  /**
   * Value of a variable stored in the solution (model variables, cumuls,
   * addToAssignment()). As in OR-Tools, a variable the solution leaves as a
   * range (often a time cumul) reads as its lower bound: use min() / max().
   */
  value(variable) { return this._read(variable, 'value'); }
  min(variable) { return this._read(variable, 'min'); }
  max(variable) { return this._read(variable, 'max'); }
  /** Per vehicle, the visited indices from its start to its end. */
  routes() { return this._model._n.solutionRoutes(this._handle); }
  /** Per vehicle, the cumul of `dimension` at each index of routes() (as value(): the lower bound of a range). */
  cumuls(dimension) { return this._model._n.solutionDimension(this._handle, dimensionName(dimension), 'cumul'); }
  /** Per vehicle, the slack at each index of routes() (null at the end); needs addToAssignment() of the slacks. */
  slacks(dimension) { return this._model._n.solutionDimension(this._handle, dimensionName(dimension), 'slack'); }
  _read(variable, kind) {
    return this._model._n.solutionValue(this._handle, this._model.solver()._exprId(variable), kind);
  }
}

function dimensionName(dimension) {
  if (dimension instanceof RoutingDimension) return dimension.name();
  if (typeof dimension === 'string') return dimension;
  throw new TypeError('expected a RoutingDimension or a dimension name');
}

/** The vehicle routing model. */
class RoutingModel {
  constructor(manager) {
    if (!(manager instanceof RoutingIndexManager)) throw new TypeError('new RoutingModel(manager: RoutingIndexManager)');
    this._n = new native.RoutingModel(manager._n);
    this._manager = manager;
    this._solver = null;
  }

  /** The cp.CpSolver of this model: add CP constraints on model variables with it. */
  solver() {
    if (this._solver === null) this._solver = CpSolver._forRoutingModel(this._n);
    return this._solver;
  }

  // ---- transits and costs ------------------------------------------------------

  /** A transit evaluator from a numNodes x numNodes matrix indexed by node. */
  registerTransitMatrix(matrix) { return this._n.registerTransitMatrix(matrix); }
  /** A unary transit evaluator from one value per node. */
  registerUnaryTransitVector(values) { return this._n.registerUnaryTransitVector(values); }
  /**
   * fn(fromIndex, toIndex) is called NOW for every pair of indices and the
   * results stored, because solving runs off the JS thread. fn must be pure and
   * return integers (±Infinity allowed). Costs O(n²) calls for n indices.
   */
  registerTransitCallback(fn) { return this._n.registerTransitCallback(fn); }
  /** fn(fromIndex), called NOW for every index (see registerTransitCallback). */
  registerUnaryTransitCallback(fn) { return this._n.registerUnaryTransitCallback(fn); }
  setArcCostEvaluatorOfAllVehicles(evaluator) { this._n.setArcCostEvaluatorOfAllVehicles(evaluator); }
  setArcCostEvaluatorOfVehicle(evaluator, vehicle) { this._n.setArcCostEvaluatorOfVehicle(evaluator, vehicle); }
  setFixedCostOfAllVehicles(cost) { this._n.setFixedCostOfAllVehicles(cost); }
  setFixedCostOfVehicle(cost, vehicle) { this._n.setFixedCostOfVehicle(cost, vehicle); }

  // ---- dimensions --------------------------------------------------------------

  /** false (and no new dimension) when the name is taken, as in OR-Tools. */
  addDimension(evaluator, slackMax, capacity, fixStartCumulToZero, name) {
    return this._n.addDimension(evaluator, slackMax, capacity, fixStartCumulToZero, name);
  }
  addDimensionWithVehicleCapacity(evaluator, slackMax, vehicleCapacities, fixStartCumulToZero, name) {
    return this._n.addDimensionWithVehicleCapacity(evaluator, slackMax, vehicleCapacities, fixStartCumulToZero, name);
  }
  addDimensionWithVehicleTransits(evaluators, slackMax, capacity, fixStartCumulToZero, name) {
    return this._n.addDimensionWithVehicleTransits(evaluators, slackMax, capacity, fixStartCumulToZero, name);
  }
  addDimensionWithVehicleTransitAndCapacity(evaluators, slackMax, vehicleCapacities, fixStartCumulToZero, name) {
    return this._n.addDimensionWithVehicleTransitAndCapacity(
      evaluators, slackMax, vehicleCapacities, fixStartCumulToZero, name);
  }
  /** Returns [evaluator, created]. */
  addConstantDimension(value, capacity, fixStartCumulToZero, name) {
    return this._n.addConstantDimension(value, capacity, fixStartCumulToZero, name);
  }
  addVectorDimension(values, capacity, fixStartCumulToZero, name) {
    return this._n.addVectorDimension(values, capacity, fixStartCumulToZero, name);
  }
  addMatrixDimension(matrix, capacity, fixStartCumulToZero, name) {
    return this._n.addMatrixDimension(matrix, capacity, fixStartCumulToZero, name);
  }
  hasDimension(name) { return this._n.hasDimension(name); }
  /** The dimension called `name`; throws (never aborts) when there is none. */
  getDimensionOrDie(name) {
    if (!this._n.hasDimension(name)) throw new Error(`Unknown dimension '${name}'`);
    return new RoutingDimension(this, name);
  }

  // ---- ride rules ----------------------------------------------------------------

  addPickupAndDelivery(pickup, delivery) { this._n.addPickupAndDelivery(pickup, delivery); }
  addPickupAndDeliverySets(pickupDisjunction, deliveryDisjunction) {
    this._n.addPickupAndDeliverySets(pickupDisjunction, deliveryDisjunction);
  }
  setPickupAndDeliveryPolicyOfAllVehicles(policy) { this._n.setPickupAndDeliveryPolicy(policy); }
  setPickupAndDeliveryPolicyOfVehicle(policy, vehicle) {
    if (vehicle === undefined) throw new TypeError('setPickupAndDeliveryPolicyOfVehicle(policy, vehicle)');
    this._n.setPickupAndDeliveryPolicy(policy, vehicle);
  }
  /**
   * At most `maxCardinality` of `indices` are visited; each missing one costs
   * `penalty`. The default penalty -1 makes the disjunction mandatory.
   * Returns the disjunction index.
   */
  addDisjunction(indices, penalty = -1, maxCardinality = 1) {
    return this._n.addDisjunction(indices, penalty, maxCardinality);
  }
  /** An empty list allows every vehicle. */
  setAllowedVehiclesForIndex(vehicles, index) { this._n.setAllowedVehiclesForIndex(vehicles, index); }
  setVisitType(index, type, policy) { this._n.setVisitType(index, type, policy); }
  addHardTypeIncompatibility(type1, type2) { this._n.addTypeIncompatibility(false, type1, type2); }
  addTemporalTypeIncompatibility(type1, type2) { this._n.addTypeIncompatibility(true, type1, type2); }
  addRequiredTypeAlternativesWhenAddingType(dependentType, requiredTypes) {
    this._n.addRequiredTypeAlternatives(false, dependentType, requiredTypes);
  }
  addRequiredTypeAlternativesWhenRemovingType(dependentType, requiredTypes) {
    this._n.addRequiredTypeAlternatives(true, dependentType, requiredTypes);
  }
  addSoftSameVehicleConstraint(indices, cost) { this._n.addSoftSameVehicleConstraint(indices, cost); }
  /** All of `indices` are performed or none is. Needs OR-Tools 9.15+. */
  addSameActivityGroup(indices) { this._n.addSameActivityGroup(indices); }

  // ---- variables -------------------------------------------------------------------

  nextVar(index) { return this._wrapVar(this._n.nextVar(index)); }
  vehicleVar(index) { return this._wrapVar(this._n.vehicleVar(index)); }
  activeVar(index) { return this._wrapVar(this._n.activeVar(index)); }
  /** The objective; available once the model is closed. */
  costVar() { return this._wrapVar(this._n.costVar()); }
  start(vehicle) { return this._n.start(vehicle); }
  end(vehicle) { return this._n.end(vehicle); }
  isStart(index) { return this._n.isStart(index); }
  isEnd(index) { return this._n.isEnd(index); }
  /** Number of indices that have a next variable (not the vehicle ends). */
  size() { return this._n.size(); }
  vehicles() { return this._n.vehicles(); }
  nodes() { return this._n.nodes(); }

  addVariableMinimizedByFinalizer(variable) { this._n.addFinalizerVariable('minimize', this._varId(variable)); }
  addVariableMaximizedByFinalizer(variable) { this._n.addFinalizerVariable('maximize', this._varId(variable)); }
  addVariableTargetToFinalizer(variable, target) {
    this._n.addFinalizerVariable('target', this._varId(variable), target);
  }
  /** Stores `variable` in solutions too (e.g. slack variables). */
  addToAssignment(variable) { this._n.addToAssignment(this._varId(variable)); }

  // ---- closing and re-planning ----------------------------------------------------

  closeModel() { this._n.closeModel(); }
  closeModelWithParameters(params) { this._n.closeModel(routingSearchParametersJson(params)); }
  get closed() { return this._n.isClosed(); }
  /** Single-vehicle models only; returns the next variable at the end of the chain, or null. */
  applyLocks(locks) {
    const id = this._n.applyLocks(locks);
    return id === null ? null : this._wrapVar(id);
  }
  /** Locks partial routes (no starts or ends) for the next solve; needs a closed model. */
  applyLocksToAllVehicles(locks, closeRoutes) { return this._n.applyLocksToAllVehicles(locks, closeRoutes); }
  /** An assignment following `routes` (no starts or ends), or null when they are infeasible. */
  readAssignmentFromRoutes(routes, ignoreInactiveIndices) {
    return this._solution(this._n.readAssignmentFromRoutes(routes, ignoreInactiveIndices));
  }

  // ---- solving ----------------------------------------------------------------------

  /**
   * Solves on the threadpool; resolves to a RoutingSolution, or null when no
   * solution was found (see status()). `options.onSolution(snapshot)` receives
   * { objective, solutionIndex, routes? } for each improving solution
   * (`options.includeRoutes` adds the routes); a throw there stops the search
   * and rejects.
   */
  async solveWithParameters(params, options) {
    return this._solution(await this._n.solve(routingSearchParametersJson(params), undefined, readOptions(options)));
  }
  async solveFromAssignmentWithParameters(assignment, params, options) {
    const handle = this._assignmentHandle(assignment);
    return this._solution(await this._n.solve(routingSearchParametersJson(params), handle, readOptions(options)));
  }
  solveWithParametersSync(params, options) {
    return this._solution(this._n.solveSync(routingSearchParametersJson(params), undefined, readOptions(options)));
  }
  solveFromAssignmentWithParametersSync(assignment, params, options) {
    const handle = this._assignmentHandle(assignment);
    return this._solution(this._n.solveSync(routingSearchParametersJson(params), handle, readOptions(options)));
  }
  /** The RoutingSearchStatus name of the last solve, e.g. 'ROUTING_SUCCESS'. */
  status() { return this._n.status(); }
  /** Stops a running solve (it returns the best solution so far); false when none runs. */
  interrupt() { return this._n.interrupt(); }
  get busy() { return this._n.isBusy(); }

  /** Frees the native model and its solver now; later calls and old handles throw. */
  dispose() {
    this._n.dispose();
    if (this._solver !== null) this._solver._generation++;
  }

  // ---- internals ------------------------------------------------------------------------

  _wrapVar(id) { return this.solver()._wrapVar(id); }
  _varId(variable) {
    if (!(variable instanceof IntExpr)) throw new TypeError('expected an IntVar of this model\'s solver');
    return this.solver()._exprId(variable);
  }
  _solution(handle) { return handle === null ? null : new RoutingSolution(this, handle); }
  _assignmentHandle(assignment) {
    if (!(assignment instanceof RoutingSolution)) {
      throw new TypeError('assignment must be a RoutingSolution (from a solve or readAssignmentFromRoutes())');
    }
    if (assignment._model !== this) throw new Error('assignment belongs to a different RoutingModel');
    return assignment._handle;
  }
}

if (typeof Symbol.dispose === 'symbol') RoutingModel.prototype[Symbol.dispose] = RoutingModel.prototype.dispose;

module.exports = {
  RoutingIndexManager,
  RoutingModel,
  RoutingDimension,
  RoutingSolution,
  VisitTypePolicy,
  PickupAndDeliveryPolicy,
};
