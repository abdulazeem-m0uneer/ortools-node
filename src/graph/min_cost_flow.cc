// SimpleMinCostFlow binding (Python's ortools.graph.python.min_cost_flow).
//
// OR-Tools indexes its vectors without bounds checks and sums supplies without
// overflow checks, so every argument is validated here first. Results are only
// readable after an OPTIMAL solve of the graph as it is now.

#include <napi.h>

#include <algorithm>
#include <cstdint>
#include <limits>
#include <string>
#include <vector>

#include "common/cpp_guard.h"
#include "common/int64.h"
#include "graph/graph.h"
#include "graph/graph_common.h"
#include "ortools/graph/min_cost_flow.h"

using operations_research::SimpleMinCostFlow;

namespace ortools_node {
namespace {

// Solve() adds a source, a sink and one arc per node with a non-zero supply,
// and sizes the graph's index arrays to its node count + 1, all int32.
constexpr int64_t kMaxNodesPlusArcs = kInt32Max - 3;

const char* StatusName(SimpleMinCostFlow::Status status) {
  switch (status) {
    case SimpleMinCostFlow::NOT_SOLVED: return "NOT_SOLVED";
    case SimpleMinCostFlow::OPTIMAL: return "OPTIMAL";
    case SimpleMinCostFlow::FEASIBLE: return "FEASIBLE";
    case SimpleMinCostFlow::INFEASIBLE: return "INFEASIBLE";
    case SimpleMinCostFlow::UNBALANCED: return "UNBALANCED";
    case SimpleMinCostFlow::BAD_RESULT: return "BAD_RESULT";
    case SimpleMinCostFlow::BAD_COST_RANGE: return "BAD_COST_RANGE";
    case SimpleMinCostFlow::BAD_CAPACITY_RANGE: return "BAD_CAPACITY_RANGE";
  }
  return "BAD_RESULT";
}

// OR-Tools sums supplies and demands in int64 without overflow checks, so
// totals that do not fit are reported up front. (Supplies are > kint64min, so
// -supply never overflows.)
bool SuppliesFitInt64(const SimpleMinCostFlow& model) {
  constexpr int64_t kMax = std::numeric_limits<int64_t>::max();
  int64_t total_supply = 0;
  int64_t total_demand = 0;
  for (int32_t node = 0; node < model.NumNodes(); ++node) {
    const int64_t supply = model.Supply(node);
    if (supply > 0) {
      if (total_supply > kMax - supply) return false;
      total_supply += supply;
    } else if (supply < 0) {
      if (total_demand > kMax + supply) return false;
      total_demand -= supply;
    }
  }
  return true;
}

SolveOutcome RunSolve(SimpleMinCostFlow& model, bool max_flow_with_min_cost) {
  if (!SuppliesFitInt64(model)) return {"BAD_CAPACITY_RANGE", false};
  const SimpleMinCostFlow::Status status =
      max_flow_with_min_cost ? model.SolveMaxFlowWithMinCost() : model.Solve();
  return {StatusName(status), status == SimpleMinCostFlow::OPTIMAL};
}

class MinCostFlow : public Napi::ObjectWrap<MinCostFlow> {
 public:
  static void Init(Napi::Env env, Napi::Object exports);
  explicit MinCostFlow(const Napi::CallbackInfo& info)
      : Napi::ObjectWrap<MinCostFlow>(info), model_("SimpleMinCostFlow") {}

 private:
  // --- graph building ---
  Napi::Value AddArc(const Napi::CallbackInfo& info);    // (tail, head, capacity, unitCost) -> arc
  Napi::Value AddArcs(const Napi::CallbackInfo& info);   // (tails, heads, capacities, unitCosts) -> Int32Array
  Napi::Value SetArcCapacity(const Napi::CallbackInfo& info);    // (arc, capacity)
  Napi::Value SetNodeSupply(const Napi::CallbackInfo& info);     // (node, supply)
  Napi::Value SetNodesSupplies(const Napi::CallbackInfo& info);  // (nodes, supplies)

  // --- solving ---
  Napi::Value Solve(const Napi::CallbackInfo& info);
  Napi::Value SolveSync(const Napi::CallbackInfo& info);
  Napi::Value SolveMaxFlowWithMinCost(const Napi::CallbackInfo& info);
  Napi::Value SolveMaxFlowWithMinCostSync(const Napi::CallbackInfo& info);

  // --- results ---
  Napi::Value OptimalCost(const Napi::CallbackInfo& info);
  Napi::Value MaximumFlow(const Napi::CallbackInfo& info);
  Napi::Value Flow(const Napi::CallbackInfo& info);   // (arc)
  Napi::Value Flows(const Napi::CallbackInfo& info);  // (arcs?)

  // --- user data ---
  Napi::Value NumNodes(const Napi::CallbackInfo& info);
  Napi::Value NumArcs(const Napi::CallbackInfo& info);
  Napi::Value Tail(const Napi::CallbackInfo& info);
  Napi::Value Head(const Napi::CallbackInfo& info);
  Napi::Value Capacity(const Napi::CallbackInfo& info);
  Napi::Value UnitCost(const Napi::CallbackInfo& info);
  Napi::Value Supply(const Napi::CallbackInfo& info);

  Napi::Value IsBusy(const Napi::CallbackInfo& info) { return Napi::Boolean::New(info.Env(), model_.busy()); }
  Napi::Value Dispose(const Napi::CallbackInfo& info) { return model_.Dispose(info.Env()); }

  // Throws unless a graph with `num_nodes` nodes and `num_arcs` arcs stays solvable.
  bool CheckSize(Napi::Env env, int64_t num_nodes, int64_t num_arcs) const {
    if (num_nodes + num_arcs <= kMaxNodesPlusArcs) return true;
    Napi::RangeError::New(env, "SimpleMinCostFlow: numNodes() + numArcs() must stay <= " +
                                   std::to_string(kMaxNodesPlusArcs))
        .ThrowAsJavaScriptException();
    return false;
  }
  // Arc indices are read raw (step 1) and checked against the model later (step 3).
  static bool ReadArc(Napi::Env env, const Napi::Value& v, int32_t* arc) {
    return ReadIndexBelow(env, v, kInt32Max, "arc", arc);
  }
  // A node that may be new: any index the graph can grow to.
  static bool ReadNewNode(Napi::Env env, const Napi::Value& v, const char* what, int32_t* node) {
    return ReadIndexBelow(env, v, kMaxNodesPlusArcs, what, node);
  }
  // Reads the arc argument, then checks the model is usable and has that arc.
  bool ReadExistingArc(Napi::Env env, const Napi::Value& v, int32_t* arc) {
    return ReadArc(env, v, arc) && model_.CheckUsable(env) && CheckIndexBelow(env, *arc, model_.get().NumArcs(), "arc");
  }
  static bool ReadSupply(Napi::Env env, const Napi::Value& v, const char* what, int64_t* supply) {
    if (!ReadInt64(env, v, /*allow_infinite=*/false, what, supply)) return false;
    if (*supply != std::numeric_limits<int64_t>::min()) return true;
    Napi::RangeError::New(env, std::string(what) + " must be > -(2^63)").ThrowAsJavaScriptException();
    return false;
  }

  GraphModel<SimpleMinCostFlow> model_;
};

void MinCostFlow::Init(Napi::Env env, Napi::Object exports) {
  std::vector<Napi::ClassPropertyDescriptor<MinCostFlow>> properties = {
      InstanceMethod("addArcWithCapacityAndUnitCost", &MinCostFlow::AddArc),
      InstanceMethod("addArcsWithCapacityAndUnitCost", &MinCostFlow::AddArcs),
      InstanceMethod("setArcCapacity", &MinCostFlow::SetArcCapacity),
      InstanceMethod("setNodeSupply", &MinCostFlow::SetNodeSupply),
      InstanceMethod("setNodesSupplies", &MinCostFlow::SetNodesSupplies),
      InstanceMethod("solve", &MinCostFlow::Solve),
      InstanceMethod("solveSync", &MinCostFlow::SolveSync),
      InstanceMethod("solveMaxFlowWithMinCost", &MinCostFlow::SolveMaxFlowWithMinCost),
      InstanceMethod("solveMaxFlowWithMinCostSync", &MinCostFlow::SolveMaxFlowWithMinCostSync),
      InstanceMethod("optimalCost", &MinCostFlow::OptimalCost),
      InstanceMethod("maximumFlow", &MinCostFlow::MaximumFlow),
      InstanceMethod("flow", &MinCostFlow::Flow),
      InstanceMethod("flows", &MinCostFlow::Flows),
      InstanceMethod("numNodes", &MinCostFlow::NumNodes),
      InstanceMethod("numArcs", &MinCostFlow::NumArcs),
      InstanceMethod("tail", &MinCostFlow::Tail),
      InstanceMethod("head", &MinCostFlow::Head),
      InstanceMethod("capacity", &MinCostFlow::Capacity),
      InstanceMethod("unitCost", &MinCostFlow::UnitCost),
      InstanceMethod("supply", &MinCostFlow::Supply),
      InstanceAccessor("busy", &MinCostFlow::IsBusy, nullptr),
      InstanceMethod("dispose", &MinCostFlow::Dispose),
  };
  AddStatusConstants<MinCostFlow>(env,
                                  {"NOT_SOLVED", "OPTIMAL", "FEASIBLE", "INFEASIBLE", "UNBALANCED", "BAD_RESULT",
                                   "BAD_COST_RANGE", "BAD_CAPACITY_RANGE"},
                                  &properties);
  exports.Set("SimpleMinCostFlow", DefineClass(env, "SimpleMinCostFlow", properties));
}

// ---- graph building ---------------------------------------------------------

Napi::Value MinCostFlow::AddArc(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  int32_t tail, head;
  int64_t capacity, unit_cost;
  if (!ReadNewNode(env, info[0], "tail", &tail) || !ReadNewNode(env, info[1], "head", &head) ||
      !ReadCapacity(env, info[2], &capacity) ||
      !ReadInt64(env, info[3], /*allow_infinite=*/false, "unitCost", &unit_cost) || !model_.CheckUsable(env)) {
    return env.Undefined();
  }
  SimpleMinCostFlow& m = model_.get();
  const int64_t num_nodes = std::max<int64_t>(m.NumNodes(), std::max(tail, head) + int64_t{1});
  if (!CheckSize(env, num_nodes, int64_t{m.NumArcs()} + 1)) return env.Undefined();
  int32_t arc = 0;
  if (!model_.Mutate(env, "addArcWithCapacityAndUnitCost",
                     [&] { arc = m.AddArcWithCapacityAndUnitCost(tail, head, capacity, unit_cost); })) {
    return env.Undefined();
  }
  return Napi::Number::New(env, arc);
}

Napi::Value MinCostFlow::AddArcs(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  std::vector<int32_t> tails, heads;
  std::vector<int64_t> capacities, unit_costs;
  if (!ReadIndexArray(env, info[0], kMaxNodesPlusArcs, "tails", &tails) ||
      !ReadIndexArray(env, info[1], kMaxNodesPlusArcs, "heads", &heads) ||
      !ReadInt64List(env, info[2], /*allow_infinite=*/true, /*non_negative=*/true, "capacities", &capacities) ||
      !ReadInt64List(env, info[3], /*allow_infinite=*/false, /*non_negative=*/false, "unitCosts", &unit_costs) ||
      !CheckSameLengths(env, {tails.size(), heads.size(), capacities.size(), unit_costs.size()},
                        "addArcsWithCapacityAndUnitCost(tails, heads, capacities, unitCosts)") ||
      !model_.CheckUsable(env)) {
    return env.Undefined();
  }
  SimpleMinCostFlow& m = model_.get();
  int64_t num_nodes = m.NumNodes();
  for (size_t i = 0; i < tails.size(); ++i) {
    num_nodes = std::max<int64_t>(num_nodes, std::max(tails[i], heads[i]) + int64_t{1});
  }
  if (!CheckSize(env, num_nodes, int64_t{m.NumArcs()} + static_cast<int64_t>(tails.size()))) return env.Undefined();
  const int32_t first = m.NumArcs();
  if (!model_.Mutate(env, "addArcsWithCapacityAndUnitCost", [&] {
        for (size_t i = 0; i < tails.size(); ++i) {
          m.AddArcWithCapacityAndUnitCost(tails[i], heads[i], capacities[i], unit_costs[i]);
        }
      })) {
    return env.Undefined();
  }
  return ArcRangeToJs(env, first, tails.size());
}

Napi::Value MinCostFlow::SetArcCapacity(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  int32_t arc;
  int64_t capacity;
  if (!ReadArc(env, info[0], &arc) || !ReadCapacity(env, info[1], &capacity) || !model_.CheckUsable(env) ||
      !CheckIndexBelow(env, arc, model_.get().NumArcs(), "arc")) {
    return env.Undefined();
  }
  SimpleMinCostFlow& m = model_.get();
  model_.Mutate(env, "setArcCapacity", [&] { m.SetArcCapacity(arc, capacity); });
  return env.Undefined();
}

Napi::Value MinCostFlow::SetNodeSupply(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  int32_t node;
  int64_t supply;
  if (!ReadNewNode(env, info[0], "node", &node) || !ReadSupply(env, info[1], "supply", &supply) ||
      !model_.CheckUsable(env)) {
    return env.Undefined();
  }
  SimpleMinCostFlow& m = model_.get();
  if (!CheckSize(env, std::max<int64_t>(m.NumNodes(), node + int64_t{1}), m.NumArcs())) return env.Undefined();
  model_.Mutate(env, "setNodeSupply", [&] { m.SetNodeSupply(node, supply); });
  return env.Undefined();
}

Napi::Value MinCostFlow::SetNodesSupplies(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  std::vector<int32_t> nodes;
  std::vector<int64_t> supplies;
  if (!ReadIndexArray(env, info[0], kMaxNodesPlusArcs, "nodes", &nodes) ||
      !ReadInt64List(env, info[1], /*allow_infinite=*/false, /*non_negative=*/false, "supplies", &supplies) ||
      !CheckSameLengths(env, {nodes.size(), supplies.size()}, "setNodesSupplies(nodes, supplies)")) {
    return env.Undefined();
  }
  for (size_t i = 0; i < supplies.size(); ++i) {
    if (supplies[i] == std::numeric_limits<int64_t>::min()) {
      Napi::RangeError::New(env, "supplies[" + std::to_string(i) + "] must be > -(2^63)")
          .ThrowAsJavaScriptException();
      return env.Undefined();
    }
  }
  if (!model_.CheckUsable(env)) return env.Undefined();
  SimpleMinCostFlow& m = model_.get();
  int64_t num_nodes = m.NumNodes();
  for (int32_t node : nodes) num_nodes = std::max<int64_t>(num_nodes, node + int64_t{1});
  if (!CheckSize(env, num_nodes, m.NumArcs())) return env.Undefined();
  model_.Mutate(env, "setNodesSupplies", [&] {
    for (size_t i = 0; i < nodes.size(); ++i) m.SetNodeSupply(nodes[i], supplies[i]);
  });
  return env.Undefined();
}

// ---- solving ----------------------------------------------------------------

Napi::Value MinCostFlow::Solve(const Napi::CallbackInfo& info) {
  return model_.SolveAsync(info, [](SimpleMinCostFlow& m) { return RunSolve(m, false); });
}

Napi::Value MinCostFlow::SolveSync(const Napi::CallbackInfo& info) {
  return model_.SolveSync(info.Env(), "solveSync", [](SimpleMinCostFlow& m) { return RunSolve(m, false); });
}

Napi::Value MinCostFlow::SolveMaxFlowWithMinCost(const Napi::CallbackInfo& info) {
  return model_.SolveAsync(info, [](SimpleMinCostFlow& m) { return RunSolve(m, true); });
}

Napi::Value MinCostFlow::SolveMaxFlowWithMinCostSync(const Napi::CallbackInfo& info) {
  return model_.SolveSync(info.Env(), "solveMaxFlowWithMinCostSync",
                          [](SimpleMinCostFlow& m) { return RunSolve(m, true); });
}

// ---- results ----------------------------------------------------------------

Napi::Value MinCostFlow::OptimalCost(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (!model_.CheckResult(env)) return env.Undefined();
  return Int64ToJs(env, model_.get().OptimalCost(), "optimalCost");
}

Napi::Value MinCostFlow::MaximumFlow(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (!model_.CheckResult(env)) return env.Undefined();
  return Int64ToJs(env, model_.get().MaximumFlow(), "maximumFlow");
}

Napi::Value MinCostFlow::Flow(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  int32_t arc;
  if (!ReadArc(env, info[0], &arc) || !model_.CheckResult(env) ||
      !CheckIndexBelow(env, arc, model_.get().NumArcs(), "arc")) {
    return env.Undefined();
  }
  return Int64ToJs(env, model_.get().Flow(arc), "flow");
}

Napi::Value MinCostFlow::Flows(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  ArcSelection selection;
  if (!ReadArcSelection(env, info[0], &selection) || !model_.CheckResult(env)) return env.Undefined();
  SimpleMinCostFlow& m = model_.get();
  if (!ResolveArcSelection(env, m.NumArcs(), &selection)) return env.Undefined();
  std::vector<int64_t> flows;
  if (!GuardCpp(env, "flows", [&] { flows.resize(selection.arcs.size()); })) return env.Undefined();
  for (size_t i = 0; i < flows.size(); ++i) flows[i] = m.Flow(selection.arcs[i]);
  return Int64ArrayToJs(env, flows, "flow");
}

// ---- user data ----------------------------------------------------------------

Napi::Value MinCostFlow::NumNodes(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (!model_.CheckUsable(env)) return env.Undefined();
  return Napi::Number::New(env, model_.get().NumNodes());
}

Napi::Value MinCostFlow::NumArcs(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (!model_.CheckUsable(env)) return env.Undefined();
  return Napi::Number::New(env, model_.get().NumArcs());
}

Napi::Value MinCostFlow::Tail(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  int32_t arc;
  if (!ReadExistingArc(env, info[0], &arc)) return env.Undefined();
  return Napi::Number::New(env, model_.get().Tail(arc));
}

Napi::Value MinCostFlow::Head(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  int32_t arc;
  if (!ReadExistingArc(env, info[0], &arc)) return env.Undefined();
  return Napi::Number::New(env, model_.get().Head(arc));
}

Napi::Value MinCostFlow::Capacity(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  int32_t arc;
  if (!ReadExistingArc(env, info[0], &arc)) return env.Undefined();
  return Int64ToJs(env, model_.get().Capacity(arc), "capacity");
}

Napi::Value MinCostFlow::UnitCost(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  int32_t arc;
  if (!ReadExistingArc(env, info[0], &arc)) return env.Undefined();
  return Int64ToJs(env, model_.get().UnitCost(arc), "unitCost");
}

Napi::Value MinCostFlow::Supply(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  int32_t node;
  if (!ReadIndexBelow(env, info[0], kInt32Max, "node", &node) || !model_.CheckUsable(env) ||
      !CheckIndexBelow(env, node, model_.get().NumNodes(), "node")) {
    return env.Undefined();
  }
  return Int64ToJs(env, model_.get().Supply(node), "supply");
}

}  // namespace

void InitMinCostFlow(Napi::Env env, Napi::Object exports) { MinCostFlow::Init(env, exports); }

}  // namespace ortools_node
