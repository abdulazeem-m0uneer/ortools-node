'use strict';

// Public entry point: re-exports every OR-Tools component.

const native = require('./native');
const linearSolver = require('./linear_solver');

module.exports = {
  ...linearSolver,
  /** Version of the OR-Tools library loaded at runtime, e.g. "9.15.6755". */
  ortoolsVersion: native.ortoolsVersion,
  /** How this addon was built: the OR-Tools version it was compiled against. */
  buildInfo: Object.freeze({ ...native.buildInfo }),
  native,
};
