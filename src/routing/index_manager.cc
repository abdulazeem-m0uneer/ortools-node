// RoutingIndexManager binding. Validates what RoutingIndexManager CHECKs
// (vehicle count matching starts/ends, depots in range) and range-checks the
// conversions, whose bounds are only DCHECKed.

#include "routing/index_manager.h"

#include <cstdint>
#include <limits>
#include <string>
#include <vector>

#include "common/cpp_guard.h"
#include "common/int64.h"
#include "common/napi_util.h"
#include "routing/routing_guards.h"

namespace ortools_node {

using operations_research::RoutingIndexManager;
using NodeIndex = RoutingIndexManager::NodeIndex;

namespace {

// Tags native RoutingIndexManager objects so FromValue() can tell them apart.
constexpr napi_type_tag kIndexManagerTag = {0x5c2e9a0d3b7f4c11ULL, 0x8d41f6a2e09b7c35ULL};
constexpr int64_t kMaxCount = std::numeric_limits<int32_t>::max();

std::vector<NodeIndex> ToNodes(const std::vector<int64_t>& values) {
  std::vector<NodeIndex> nodes;
  nodes.reserve(values.size());
  for (int64_t v : values) nodes.emplace_back(static_cast<int>(v));
  return nodes;
}

}  // namespace

Napi::Function IndexManager::Define(Napi::Env env) {
  return DefineClass(env, "RoutingIndexManager", {
      InstanceMethod("nodeToIndex", &IndexManager::NodeToIndex),
      InstanceMethod("indexToNode", &IndexManager::IndexToNode),
      InstanceMethod("nodesToIndices", &IndexManager::NodesToIndices),
      InstanceMethod("indicesToNodes", &IndexManager::IndicesToNodes),
      InstanceMethod("getNumberOfNodes", &IndexManager::NumberOfNodes),
      InstanceMethod("getNumberOfVehicles", &IndexManager::NumberOfVehicles),
      InstanceMethod("getNumberOfIndices", &IndexManager::NumberOfIndices),
      InstanceMethod("getStartIndex", &IndexManager::StartIndex),
      InstanceMethod("getEndIndex", &IndexManager::EndIndex),
  });
}

IndexManager::IndexManager(const Napi::CallbackInfo& info) : Napi::ObjectWrap<IndexManager>(info) {
  Napi::Env env = info.Env();
  int64_t num_nodes, num_vehicles;
  if (!ReadIntInRange(env, info[0], 1, kMaxCount, "numNodes", &num_nodes) ||
      !ReadIntInRange(env, info[1], 1, kMaxCount, "numVehicles", &num_vehicles)) {
    return;
  }
  std::vector<int64_t> starts, ends;
  if (info.Length() <= 3) {
    int64_t depot;
    if (!ReadIntInRange(env, info[2], 0, num_nodes - 1, "depot", &depot)) return;
    starts.assign(static_cast<size_t>(num_vehicles), depot);
    ends = starts;
  } else {
    if (!ReadIntArrayInRange(env, info[2], 0, num_nodes - 1, "starts", &starts) ||
        !ReadIntArrayInRange(env, info[3], 0, num_nodes - 1, "ends", &ends)) {
      return;
    }
    // RoutingIndexManager CHECKs both sizes.
    if (starts.size() != static_cast<size_t>(num_vehicles) || ends.size() != static_cast<size_t>(num_vehicles)) {
      THROW_AND_RETURN(env, "starts and ends must have one entry per vehicle", );
    }
  }
  if (!GuardCpp(env, "new RoutingIndexManager()", [&] {
        manager_ = std::make_unique<RoutingIndexManager>(static_cast<int>(num_nodes), static_cast<int>(num_vehicles),
                                                         ToNodes(starts), ToNodes(ends));
      })) {
    return;
  }
  info.This().As<Napi::Object>().TypeTag(&kIndexManagerTag);
}

const RoutingIndexManager* IndexManager::FromValue(Napi::Env env, const Napi::Value& value) {
  if (!value.IsObject() || !value.As<Napi::Object>().CheckTypeTag(&kIndexManagerTag)) {
    Napi::TypeError::New(env, "expected a RoutingIndexManager").ThrowAsJavaScriptException();
    return nullptr;
  }
  return Unwrap(value.As<Napi::Object>())->manager_.get();
}

// Returns -1 for a node that is only an end depot, as pywrapcp does.
Napi::Value IndexManager::NodeToIndex(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  int64_t node;
  if (!ReadIntInRange(env, info[0], 0, manager_->num_nodes() - 1, "node", &node)) return env.Undefined();
  return Napi::Number::New(env, static_cast<double>(manager_->NodeToIndex(NodeIndex(static_cast<int>(node)))));
}

Napi::Value IndexManager::IndexToNode(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  int64_t index;
  if (!ReadIntInRange(env, info[0], 0, manager_->num_indices() - 1, "index", &index)) return env.Undefined();
  return Napi::Number::New(env, manager_->IndexToNode(index).value());
}

Napi::Value IndexManager::NodesToIndices(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  std::vector<int64_t> nodes;
  if (!ReadIntArrayInRange(env, info[0], 0, manager_->num_nodes() - 1, "nodes", &nodes)) return env.Undefined();
  std::vector<int64_t> indices;
  indices.reserve(nodes.size());
  for (int64_t node : nodes) {
    const int64_t index = manager_->NodeToIndex(NodeIndex(static_cast<int>(node)));
    // RoutingIndexManager::NodesToIndices CHECKs this.
    if (index == RoutingIndexManager::kUnassigned) {
      THROW_AND_RETURN(env, "node " + std::to_string(node) + " is only an end depot and has no unique index",
                       env.Undefined());
    }
    indices.push_back(index);
  }
  return Int64ArrayToJs(env, indices, "index");
}

Napi::Value IndexManager::IndicesToNodes(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  std::vector<int64_t> indices;
  if (!ReadIntArrayInRange(env, info[0], 0, manager_->num_indices() - 1, "indices", &indices)) {
    return env.Undefined();
  }
  std::vector<int64_t> nodes;
  nodes.reserve(indices.size());
  for (int64_t index : indices) nodes.push_back(manager_->IndexToNode(index).value());
  return Int64ArrayToJs(env, nodes, "node");
}

Napi::Value IndexManager::NumberOfNodes(const Napi::CallbackInfo& info) {
  return Napi::Number::New(info.Env(), manager_->num_nodes());
}

Napi::Value IndexManager::NumberOfVehicles(const Napi::CallbackInfo& info) {
  return Napi::Number::New(info.Env(), manager_->num_vehicles());
}

Napi::Value IndexManager::NumberOfIndices(const Napi::CallbackInfo& info) {
  return Napi::Number::New(info.Env(), manager_->num_indices());
}

Napi::Value IndexManager::StartIndex(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  int64_t vehicle;
  if (!ReadIntInRange(env, info[0], 0, manager_->num_vehicles() - 1, "vehicle", &vehicle)) return env.Undefined();
  return Napi::Number::New(env, static_cast<double>(manager_->GetStartIndex(static_cast<int>(vehicle))));
}

Napi::Value IndexManager::EndIndex(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  int64_t vehicle;
  if (!ReadIntInRange(env, info[0], 0, manager_->num_vehicles() - 1, "vehicle", &vehicle)) return env.Undefined();
  return Napi::Number::New(env, static_cast<double>(manager_->GetEndIndex(static_cast<int>(vehicle))));
}

}  // namespace ortools_node
