'use strict';

// Graph algorithms: min-cost flow, max flow and linear sum assignment
// (Python's ortools.graph.python.{min_cost_flow,max_flow,linear_sum_assignment}).
// The native classes are the public API; this module only adds
// `using` support (Symbol.dispose) on top of their dispose().

const native = require('./native');

const { SimpleMinCostFlow, SimpleMaxFlow, SimpleLinearSumAssignment } = native;

if (typeof Symbol.dispose === 'symbol') {
  for (const cls of [SimpleMinCostFlow, SimpleMaxFlow, SimpleLinearSumAssignment]) {
    cls.prototype[Symbol.dispose] = cls.prototype.dispose;
  }
}

module.exports = { SimpleMinCostFlow, SimpleMaxFlow, SimpleLinearSumAssignment };
