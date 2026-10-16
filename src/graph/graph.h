// Graph algorithms: min-cost flow, max flow and linear sum assignment
// (Python's ortools.graph.python.{min_cost_flow,max_flow,linear_sum_assignment}).

#ifndef ORTOOLS_NODE_GRAPH_GRAPH_H_
#define ORTOOLS_NODE_GRAPH_GRAPH_H_

#include <napi.h>

namespace ortools_node {

// Each registers one class on `exports`.
void InitMinCostFlow(Napi::Env env, Napi::Object exports);
void InitMaxFlow(Napi::Env env, Napi::Object exports);
void InitLinearSumAssignment(Napi::Env env, Napi::Object exports);

inline void InitGraph(Napi::Env env, Napi::Object exports) {
  InitMinCostFlow(env, exports);
  InitMaxFlow(env, exports);
  InitLinearSumAssignment(env, exports);
}

}  // namespace ortools_node

#endif  // ORTOOLS_NODE_GRAPH_GRAPH_H_
