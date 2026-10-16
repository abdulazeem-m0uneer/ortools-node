'use strict';

// Vector bin packing with OR-Tools' arc-flow formulation
// (packing::SolveVectorBinPackingWithArcFlow). The problem and the solution are
// plain objects in protobuf's JSON form (vector_bin_packing.proto):
//
//   const solution = await solveVectorBinPacking({
//     resourceCapacity: [10],
//     item: [{ name: 'a', resourceUsage: [6], numCopies: 3 }, { name: 'b', resourceUsage: [4], numCopies: 3 }],
//   });
//   solution.status;  // 'OPTIMAL'
//   solution.bins;    // [{ itemIndices: [0, 1], itemCopies: [1, 1] }, ...]
//
// The backend's own log goes to stdout: OR-Tools enables it unconditionally.

const native = require('./native');
const { encode } = require('./proto_json');

/** MIP backends this build can use for bin packing, e.g. VectorBinPackingSolverType.SCIP. */
const VectorBinPackingSolverType = Object.freeze(
  Object.fromEntries(native.vectorBinPackingSolvers.map((name) => [name, name])),
);

function isPlainObject(value) {
  if (value === null || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function defaultSolverType() {
  return 'SCIP' in VectorBinPackingSolverType ? 'SCIP' : native.vectorBinPackingSolvers[0];
}

// [problemJson, solverType, timeLimitSeconds, numThreads, mipParameters]
function nativeArguments(problem, options) {
  if (!isPlainObject(problem)) throw new TypeError('problem must be a VectorBinPackingProblem object');
  if (!isPlainObject(options)) throw new TypeError('options must be a plain object');
  const {
    solverType = defaultSolverType(), timeLimitSeconds = Infinity, numThreads = 1, mipParameters = '',
  } = options;
  if (solverType === undefined) throw new Error('No MIP backend for bin packing in this OR-Tools build');
  return [encode(problem, 'VectorBinPackingProblem'), solverType, timeLimitSeconds, numThreads, mipParameters];
}

/**
 * Solves off the main thread. options: { solverType ('SCIP' by default),
 * timeLimitSeconds (Infinity), numThreads (1), mipParameters (backend-specific
 * text, '' by default) }. The problem's maxBins, when > 0, caps the bins.
 */
function solveVectorBinPacking(problem, options = {}) {
  return native.solveVectorBinPacking(...nativeArguments(problem, options));
}

/** Blocking solveVectorBinPacking(). */
function solveVectorBinPackingSync(problem, options = {}) {
  return native.solveVectorBinPackingSync(...nativeArguments(problem, options));
}

module.exports = { VectorBinPackingSolverType, solveVectorBinPacking, solveVectorBinPackingSync };
