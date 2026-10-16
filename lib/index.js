'use strict';

// Public entry point: re-exports every OR-Tools component.

const native = require('./native');
const linearSolver = require('./linear_solver');
const params = require('./params');

module.exports = {
  ...linearSolver,
  FirstSolutionStrategy: params.FirstSolutionStrategy,
  LocalSearchMetaheuristic: params.LocalSearchMetaheuristic,
  RoutingSearchStatus: params.RoutingSearchStatus,
  defaultRoutingSearchParameters: params.defaultRoutingSearchParameters,
  validateRoutingSearchParameters: params.validateRoutingSearchParameters,
  defaultSatParameters: params.defaultSatParameters,
  validateSatParameters: params.validateSatParameters,
  durationMs: params.durationMs,
  /** Version of the OR-Tools library loaded at runtime, e.g. "9.15.6755". */
  ortoolsVersion: native.ortoolsVersion,
  /** How this addon was built: the OR-Tools version it was compiled against. */
  buildInfo: Object.freeze({ ...native.buildInfo }),
  native,
};
