// RoutingIndexManager (pywrapcp's RoutingIndexManager) as a Node-API class.
// Immutable once built, so it needs no lifecycle checks.

#ifndef ORTOOLS_NODE_ROUTING_INDEX_MANAGER_H_
#define ORTOOLS_NODE_ROUTING_INDEX_MANAGER_H_

#include <napi.h>

#include <memory>

#include "ortools/constraint_solver/routing_index_manager.h"

namespace ortools_node {

class IndexManager : public Napi::ObjectWrap<IndexManager> {
 public:
  static Napi::Function Define(Napi::Env env);
  // new RoutingIndexManager(numNodes, numVehicles, depot)
  // new RoutingIndexManager(numNodes, numVehicles, starts, ends)
  explicit IndexManager(const Napi::CallbackInfo& info);

  // The manager of a native RoutingIndexManager object; throws and returns null
  // for anything else.
  static const operations_research::RoutingIndexManager* FromValue(Napi::Env env, const Napi::Value& value);

 private:
  Napi::Value NodeToIndex(const Napi::CallbackInfo& info);
  Napi::Value IndexToNode(const Napi::CallbackInfo& info);
  Napi::Value NodesToIndices(const Napi::CallbackInfo& info);
  Napi::Value IndicesToNodes(const Napi::CallbackInfo& info);
  Napi::Value NumberOfNodes(const Napi::CallbackInfo& info);
  Napi::Value NumberOfVehicles(const Napi::CallbackInfo& info);
  Napi::Value NumberOfIndices(const Napi::CallbackInfo& info);
  Napi::Value StartIndex(const Napi::CallbackInfo& info);
  Napi::Value EndIndex(const Napi::CallbackInfo& info);

  std::unique_ptr<operations_research::RoutingIndexManager> manager_;
};

}  // namespace ortools_node

#endif  // ORTOOLS_NODE_ROUTING_INDEX_MANAGER_H_
