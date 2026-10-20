'use strict';
// node -r ./sync_patch.js run_node.js ...: routes the async routing solves to their Sync variants, so
// the same suite times solveWithParametersSync() (main thread) instead of the libuv threadpool.
const path = require('node:path');
const { RoutingModel } = require(path.join(__dirname, '..', '..', '..', '..', 'lib'));

const P = RoutingModel.prototype;
P.solveWithParameters = async function solveWithParameters(params, options) {
  return this.solveWithParametersSync(params, options);
};
P.solveFromAssignmentWithParameters = async function solveFromAssignmentWithParameters(assignment, params, options) {
  return this.solveFromAssignmentWithParametersSync(assignment, params, options);
};
