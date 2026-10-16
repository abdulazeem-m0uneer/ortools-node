'use strict';

// 0-1 knapsack problems, one or several dimensions (pywrapknapsack_solver's
// equivalent). The addon validates every argument before OR-Tools sees it.

const native = require('./native');

/** Solver types this OR-Tools build can run, e.g. KnapsackSolverType.KNAPSACK_DYNAMIC_PROGRAMMING_SOLVER. */
const KnapsackSolverType = native.knapsackSolverTypes;

/**
 * Picks the subset of items with the largest total profit whose weights fit
 * every capacity.
 *
 *   const s = new KnapsackSolver(KnapsackSolverType.KNAPSACK_MULTIDIMENSION_BRANCH_AND_BOUND_SOLVER);
 *   s.init(profits, [weights], [capacity]);
 *   const best = await s.solve();
 *   const packed = profits.map((_, i) => s.bestSolutionContains(i));
 */
class KnapsackSolver {
  /** `name` defaults to 'knapsack'. */
  constructor(solverType, name) {
    this._n = new native.KnapsackSolver(solverType, name);
    this.solverType = solverType;
  }

  /**
   * Loads a problem: profits[i] and weights[d][i] for item i in dimension d,
   * capacities[d] per dimension. All values are non-negative integers (numbers
   * or BigInts). Needed again before every solve().
   */
  init(profits, weights, capacities) {
    this._n.init(profits, weights, capacities);
    return this;
  }
  /** Solves off the main thread; resolves to the best total profit. */
  solve() {
    return this._n.solve();
  }
  /** Blocking solve; returns the best total profit. */
  solveSync() {
    return this._n.solveSync();
  }
  /** Whether item `item` is packed in the best solution found. */
  bestSolutionContains(item) {
    return this._n.bestSolutionContains(item);
  }
  /** False when the time limit stopped the search early. */
  isSolutionOptimal() {
    return this._n.isSolutionOptimal();
  }
  /** Time limit in seconds for each solve (Infinity, the default, means none). */
  setTimeLimit(seconds) {
    this._n.setTimeLimit(seconds);
    return this;
  }
  /** Toggles OR-Tools' problem reduction (on by default); a change needs a new init(). */
  setUseReduction(useReduction) {
    this._n.setUseReduction(useReduction);
    return this;
  }
  get useReduction() {
    return this._n.useReduction();
  }
  get name() {
    return this._n.name();
  }
  get busy() {
    return this._n.isBusy();
  }
  /** Frees the native solver now. Idempotent; throws while a solve() is pending. */
  dispose() {
    this._n.dispose();
  }
}

if (typeof Symbol.dispose === 'symbol') KnapsackSolver.prototype[Symbol.dispose] = KnapsackSolver.prototype.dispose;

module.exports = { KnapsackSolver, KnapsackSolverType };
