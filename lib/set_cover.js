'use strict';

// Set cover in the style of Python's ortools.set_cover.python.set_cover: build
// a SetCoverModel, create a SetCoverInvariant (the current solution) from it,
// then improve the solution with generators and local searches:
//
//   const model = new SetCoverModel();
//   model.addEmptySubset(2); model.addElementToLastSubset(0); ...
//   const inv = new SetCoverInvariant(model);
//   await new GreedySolutionGenerator(inv).nextSolution();
//   await new SteepestSearch(inv).nextSolution();
//   inv.cost(); inv.selectedSubsets();

const native = require('./native');

const MAX_ELEMENT = 2 ** 31 - 2; // OR-Tools indexes elements with int32
const MAX_NONZEROS = 2 ** 31 - 1;

/** MIP backends this build can run for SetCoverMip, e.g. SetCoverMipSolver.SCIP. */
const SetCoverMipSolver = Object.freeze(Object.fromEntries(native.setCoverMipSolvers.map((name) => [name, name])));

function checkCost(cost) {
  if (typeof cost !== 'number' || !Number.isFinite(cost) || cost <= 0) {
    throw new RangeError('cost must be a finite number > 0');
  }
  return cost;
}
function checkInteger(value, min, max, what) {
  if (typeof value !== 'number' || !Number.isInteger(value)) throw new TypeError(`${what} must be an integer`);
  if (value < min || value > max) throw new RangeError(`${what} must be in [${min}, ${max}]`);
  return value;
}
function checkName(name) {
  if (typeof name !== 'string') throw new TypeError('name must be a string');
  return name;
}

/** Subsets with positive costs over elements 0..numElements - 1. */
class SetCoverModel {
  constructor(name = 'SetCoverModel') {
    this._name = checkName(name);
    this._costs = [];
    this._columns = []; // subset -> elements, in insertion order
    this._members = []; // subset -> Set of its elements
    this._numElements = 0;
    this._numNonzeros = 0;
  }

  get name() {
    return this._name;
  }
  setName(name) {
    this._name = checkName(name);
    return this;
  }

  /** Adds a subset with no elements; returns its index. */
  addEmptySubset(cost) {
    this._costs.push(checkCost(cost));
    this._columns.push([]);
    this._members.push(new Set());
    return this._costs.length - 1;
  }
  addElementToLastSubset(element) {
    if (this._costs.length === 0) throw new Error('addElementToLastSubset: the model has no subset yet');
    return this.addElementToSubset(element, this._costs.length - 1);
  }
  addElementToSubset(element, subset) {
    this._checkSubset(subset);
    checkInteger(element, 0, MAX_ELEMENT, 'element');
    if (this._members[subset].has(element)) throw new RangeError(`subset ${subset} already has element ${element}`);
    if (this._numNonzeros >= MAX_NONZEROS) throw new RangeError('the model is too large');
    this._members[subset].add(element);
    this._columns[subset].push(element);
    this._numElements = Math.max(this._numElements, element + 1);
    this._numNonzeros++;
    return this;
  }
  setSubsetCost(subset, cost) {
    this._checkSubset(subset);
    this._costs[subset] = checkCost(cost);
    return this;
  }

  get numElements() {
    return this._numElements;
  }
  get numSubsets() {
    return this._costs.length;
  }
  get numNonzeros() {
    return this._numNonzeros;
  }
  get fillRate() {
    const cells = this._numElements * this._costs.length;
    return cells === 0 ? 0 : this._numNonzeros / cells;
  }
  get subsetCosts() {
    return this._costs.slice();
  }
  /** subset -> its elements. */
  get columns() {
    return this._columns.map((column) => column.slice());
  }
  /** element -> the subsets that contain it. */
  get rows() {
    const rows = Array.from({ length: this._numElements }, () => []);
    this._columns.forEach((column, subset) => column.forEach((element) => rows[element].push(subset)));
    return rows;
  }
  get allSubsets() {
    return this._costs.map((_, i) => i);
  }
  /** True when the model has subsets and elements and every element is in some subset. */
  computeFeasibility() {
    if (this._costs.length === 0 || this._numElements === 0) return false;
    const covered = new Uint8Array(this._numElements);
    for (const column of this._columns) for (const element of column) covered[element] = 1;
    return covered.every((c) => c === 1);
  }

  /** The model as a SetCoverProto in protobuf's JSON form (elements sorted). */
  exportModelAsProto() {
    return {
      name: this._name,
      subset: this._costs.map((cost, i) => ({ cost, element: this._columns[i].slice().sort((a, b) => a - b) })),
    };
  }
  /** Replaces the model with a SetCoverProto object; throws, changing nothing, if it is invalid. */
  importModelFromProto(proto) {
    if (proto === null || typeof proto !== 'object') throw new TypeError('proto must be a SetCoverProto object');
    const subsets = proto.subset ?? [];
    if (!Array.isArray(subsets)) throw new TypeError('proto.subset must be an array');
    const copy = new SetCoverModel(proto.name ?? 'SetCoverModel');
    for (const subset of subsets) {
      const index = copy.addEmptySubset(subset?.cost);
      for (const element of subset.element ?? []) copy.addElementToSubset(element, index);
    }
    Object.assign(this, copy);
    return this;
  }

  _checkSubset(subset) {
    checkInteger(subset, 0, Number.MAX_SAFE_INTEGER, 'subset');
    if (subset >= this._costs.length) throw new RangeError(`subset ${subset} does not exist`);
  }
}

/**
 * A solution of a SetCoverModel, copied at construction: later changes to the
 * model do not reach it. Generators and local searches update it in place.
 */
class SetCoverInvariant {
  constructor(model) {
    if (!(model instanceof SetCoverModel)) throw new TypeError('SetCoverInvariant(model): expected a SetCoverModel');
    this._n = new native.SetCoverInvariant(model._costs, model._columns, model._name);
    this.model = model;
  }
  cost() {
    return this._n.cost();
  }
  /** The bound a SetCoverMip run with useIntegers(false) reports (0 otherwise). */
  lowerBound() {
    return this._n.lowerBound();
  }
  numUncoveredElements() {
    return this._n.numUncoveredElements();
  }
  /** subset -> whether it is in the solution. */
  isSelected() {
    return this._n.isSelected();
  }
  selectedSubsets() {
    return this._n.isSelected().flatMap((selected, i) => (selected ? [i] : []));
  }
  /** element -> how many selected subsets contain it. */
  coverage() {
    return this._n.coverage();
  }
  /** Replaces the solution; one boolean per subset. */
  loadSolution(selected) {
    this._n.loadSolution(selected);
    return this;
  }
  /** Empties the solution. */
  clear() {
    this._n.clear();
    return this;
  }
  get busy() {
    return this._n.isBusy();
  }
  /** Frees the native solution. Idempotent; throws while a generator runs; later calls throw. */
  dispose() {
    this._n.dispose();
  }
}

if (typeof Symbol.dispose === 'symbol') SetCoverInvariant.prototype[Symbol.dispose] = SetCoverInvariant.prototype.dispose;

function checkInvariant(inv) {
  if (!(inv instanceof SetCoverInvariant)) throw new TypeError('expected a SetCoverInvariant');
  return inv;
}

/** Base of the generators and searches: each run updates the invariant's solution. */
class SetCoverSolutionGenerator {
  constructor(inv, kind) {
    this.inv = checkInvariant(inv);
    this._kind = kind;
    this._options = {};
  }
  get name() {
    return this.constructor.name;
  }
  setMaxIterations(maxIterations) {
    this._options.maxIterations = checkInteger(maxIterations, 0, Number.MAX_SAFE_INTEGER, 'maxIterations');
    return this;
  }
  /**
   * Runs off the main thread; resolves to whether it produced a solution.
   * `focus` (subset indices) limits the subsets it may change.
   */
  nextSolution(focus) {
    return this.inv._n.run(this._kind, { ...this._options }, focus).then((result) => this._finish(result));
  }
  nextSolutionSync(focus) {
    return this._finish(this.inv._n.runSync(this._kind, { ...this._options }, focus));
  }
  _finish(result) {
    return result.found;
  }
}

/** Selects every subset in the focus. */
class TrivialSolutionGenerator extends SetCoverSolutionGenerator {
  constructor(inv) {
    super(inv, 'TRIVIAL');
  }
}
/** Selects random useful subsets until everything is covered. */
class RandomSolutionGenerator extends SetCoverSolutionGenerator {
  constructor(inv) {
    super(inv, 'RANDOM');
  }
}
/** Chvatal's greedy: cheapest cost per newly covered element first. */
class GreedySolutionGenerator extends SetCoverSolutionGenerator {
  constructor(inv) {
    super(inv, 'GREEDY');
  }
}
/** Covers elements in decreasing degree order with the best subset for each. */
class ElementDegreeSolutionGenerator extends SetCoverSolutionGenerator {
  constructor(inv) {
    super(inv, 'ELEMENT_DEGREE');
  }
}
class LazyElementDegreeSolutionGenerator extends SetCoverSolutionGenerator {
  constructor(inv) {
    super(inv, 'LAZY_ELEMENT_DEGREE');
  }
}
/** Removes redundant subsets, most expensive first. Needs a complete cover (else resolves false). */
class SteepestSearch extends SetCoverSolutionGenerator {
  constructor(inv) {
    super(inv, 'STEEPEST');
  }
}
/** Guided local search from a complete cover. Penalties start afresh on every run. */
class GuidedLocalSearch extends SetCoverSolutionGenerator {
  constructor(inv) {
    super(inv, 'GUIDED_LOCAL_SEARCH');
  }
}
/** Guided tabu search from a complete cover. Penalties and the tabu list start afresh on every run. */
class GuidedTabuSearch extends SetCoverSolutionGenerator {
  constructor(inv) {
    super(inv, 'GUIDED_TABU_SEARCH');
  }
  setLagrangianFactor(factor) {
    this._options.lagrangianFactor = checkFiniteNumber(factor, 'factor');
    return this;
  }
  setPenaltyFactor(factor) {
    this._options.penaltyFactor = checkFiniteNumber(factor, 'factor');
    return this;
  }
  setEpsilon(epsilon) {
    this._options.epsilon = checkFiniteNumber(epsilon, 'epsilon');
    return this;
  }
  setTabuListSize(size) {
    this._options.tabuListSize = checkInteger(size, 1, 1000000, 'size');
    return this;
  }
}
/**
 * Solves the focus as a MIP (or its LP relaxation with useIntegers(false),
 * which only reports inv.lowerBound()). Subsets already selected stay selected.
 */
class SetCoverMip extends SetCoverSolutionGenerator {
  constructor(inv) {
    super(inv, 'MIP');
    this.solveStatus = undefined;
  }
  useMipSolver(solver) {
    if (!(solver in SetCoverMipSolver)) throw new TypeError(`Unsupported or unavailable MIP solver: '${solver}'`);
    this._options.mipSolver = solver;
    return this;
  }
  useIntegers(useIntegers) {
    if (typeof useIntegers !== 'boolean') throw new TypeError('useIntegers must be a boolean');
    this._options.useIntegers = useIntegers;
    return this;
  }
  setTimeLimitInSeconds(seconds) {
    if (typeof seconds !== 'number' || Number.isNaN(seconds)) throw new TypeError('seconds must be a number');
    if (seconds < 0 || seconds > 1e9) throw new RangeError('seconds must be in [0, 1e9]');
    this._options.timeLimitSeconds = seconds;
    return this;
  }
  _finish(result) {
    this.solveStatus = result.mipStatus;
    return result.found;
  }
}

function checkFiniteNumber(value, what) {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new TypeError(`${what} must be a finite number`);
  return value;
}

/**
 * Deselects random selected subsets in the focus, and the selected subsets that
 * share elements with them, so it may deselect more than numSubsets. Returns
 * subset indices that can be reused as a focus (OR-Tools' contract).
 */
function clearRandomSubsets(inv, numSubsets, focus) {
  return checkInvariant(inv)._n.clearRandomSubsets(numSubsets, focus);
}
/**
 * Deselects up to numSubsets selected subsets covering the most covered elements
 * (chosen at random past the cap). Returns the chosen indices, for use as a focus.
 */
function clearMostCoveredElements(inv, numSubsets, focus) {
  return checkInvariant(inv)._n.clearMostCoveredElements(numSubsets, focus);
}

module.exports = {
  SetCoverModel,
  SetCoverInvariant,
  SetCoverSolutionGenerator,
  TrivialSolutionGenerator,
  RandomSolutionGenerator,
  GreedySolutionGenerator,
  ElementDegreeSolutionGenerator,
  LazyElementDegreeSolutionGenerator,
  SteepestSearch,
  GuidedLocalSearch,
  GuidedTabuSearch,
  SetCoverMip,
  SetCoverMipSolver,
  clearRandomSubsets,
  clearMostCoveredElements,
};
