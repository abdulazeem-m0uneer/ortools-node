// SimpleLinearSumAssignment binding (Python's
// ortools.graph.python.linear_sum_assignment).
//
// OR-Tools indexes its vectors without bounds checks and scales every cost by
// (numNodes + 1) without checking negative costs for overflow, so arguments
// and cost ranges are validated here first. Results are only readable after an
// OPTIMAL solve of the graph as it is now.

#include <napi.h>

#include <cstdint>
#include <limits>
#include <vector>

#include "common/int64.h"
#include "common/napi_util.h"
#include "graph/graph.h"
#include "graph/graph_common.h"
#include "ortools/graph/assignment.h"

using operations_research::SimpleLinearSumAssignment;

namespace ortools_node {
namespace {

// Solve() builds a graph with 2 * NumNodes() nodes, and index arrays one
// longer than that, all int32.
constexpr int64_t kMaxNodes = kInt32Max / 2;

const char* StatusName(SimpleLinearSumAssignment::Status status) {
  switch (status) {
    case SimpleLinearSumAssignment::OPTIMAL: return "OPTIMAL";
    case SimpleLinearSumAssignment::INFEASIBLE: return "INFEASIBLE";
    case SimpleLinearSumAssignment::POSSIBLE_OVERFLOW: return "POSSIBLE_OVERFLOW";
  }
  return "POSSIBLE_OVERFLOW";
}

// OR-Tools checks only positive costs against kint64max / (NumNodes() + 1);
// a large negative cost would overflow silently when scaled.
bool CostsFitScaling(const SimpleLinearSumAssignment& model) {
  const int64_t limit = std::numeric_limits<int64_t>::max() / (int64_t{model.NumNodes()} + 1);
  for (int32_t arc = 0; arc < model.NumArcs(); ++arc) {
    const int64_t cost = model.Cost(arc);
    if (cost > limit || cost < -limit) return false;
  }
  return true;
}

SolveOutcome RunSolve(SimpleLinearSumAssignment& model) {
  if (!CostsFitScaling(model)) return {"POSSIBLE_OVERFLOW", false};
  const SimpleLinearSumAssignment::Status status = model.Solve();
  return {StatusName(status), status == SimpleLinearSumAssignment::OPTIMAL};
}

class LinearSumAssignment : public Napi::ObjectWrap<LinearSumAssignment> {
 public:
  static void Init(Napi::Env env, Napi::Object exports);
  explicit LinearSumAssignment(const Napi::CallbackInfo& info)
      : Napi::ObjectWrap<LinearSumAssignment>(info), model_("SimpleLinearSumAssignment") {}

 private:
  // --- graph building ---
  Napi::Value AddArc(const Napi::CallbackInfo& info);   // (left, right, cost) -> arc
  Napi::Value AddArcs(const Napi::CallbackInfo& info);  // (lefts, rights, costs) -> Int32Array

  // --- solving ---
  Napi::Value Solve(const Napi::CallbackInfo& info);
  Napi::Value SolveSync(const Napi::CallbackInfo& info);

  // --- results ---
  Napi::Value OptimalCost(const Napi::CallbackInfo& info);
  Napi::Value RightMate(const Napi::CallbackInfo& info);       // (left)
  Napi::Value AssignmentCost(const Napi::CallbackInfo& info);  // (left)

  // --- user data ---
  Napi::Value NumNodes(const Napi::CallbackInfo& info);
  Napi::Value NumArcs(const Napi::CallbackInfo& info);
  Napi::Value LeftNode(const Napi::CallbackInfo& info);
  Napi::Value RightNode(const Napi::CallbackInfo& info);
  Napi::Value Cost(const Napi::CallbackInfo& info);

  Napi::Value IsBusy(const Napi::CallbackInfo& info) { return Napi::Boolean::New(info.Env(), model_.busy()); }
  Napi::Value Dispose(const Napi::CallbackInfo& info) { return model_.Dispose(info.Env()); }

  bool ReadArc(Napi::Env env, const Napi::Value& v, int32_t* arc) {
    size_t index;
    if (!ReadIndex(env, v, static_cast<size_t>(model_.get().NumArcs()), "arc", &index)) return false;
    *arc = static_cast<int32_t>(index);
    return true;
  }
  // A node of the current graph (results), in [0, NumNodes()).
  bool ReadLeftNode(Napi::Env env, const Napi::Value& v, int32_t* node) {
    size_t index;
    if (!ReadIndex(env, v, static_cast<size_t>(model_.get().NumNodes()), "left node", &index)) return false;
    *node = static_cast<int32_t>(index);
    return true;
  }
  // Any node index the graph can grow to.
  static bool ReadNewNode(Napi::Env env, const Napi::Value& v, const char* what, int32_t* node) {
    size_t index;
    if (!ReadIndex(env, v, static_cast<size_t>(kMaxNodes), what, &index)) return false;
    *node = static_cast<int32_t>(index);
    return true;
  }
  bool CheckArcCapacityLeft(Napi::Env env, size_t added) {
    if (static_cast<int64_t>(model_.get().NumArcs()) + static_cast<int64_t>(added) <= kInt32Max) return true;
    Napi::RangeError::New(env, "SimpleLinearSumAssignment: numArcs() must stay <= 2^31 - 1")
        .ThrowAsJavaScriptException();
    return false;
  }

  GraphModel<SimpleLinearSumAssignment> model_;
};

void LinearSumAssignment::Init(Napi::Env env, Napi::Object exports) {
  std::vector<Napi::ClassPropertyDescriptor<LinearSumAssignment>> properties = {
      InstanceMethod("addArcWithCost", &LinearSumAssignment::AddArc),
      InstanceMethod("addArcsWithCost", &LinearSumAssignment::AddArcs),
      InstanceMethod("solve", &LinearSumAssignment::Solve),
      InstanceMethod("solveSync", &LinearSumAssignment::SolveSync),
      InstanceMethod("optimalCost", &LinearSumAssignment::OptimalCost),
      InstanceMethod("rightMate", &LinearSumAssignment::RightMate),
      InstanceMethod("assignmentCost", &LinearSumAssignment::AssignmentCost),
      InstanceMethod("numNodes", &LinearSumAssignment::NumNodes),
      InstanceMethod("numArcs", &LinearSumAssignment::NumArcs),
      InstanceMethod("leftNode", &LinearSumAssignment::LeftNode),
      InstanceMethod("rightNode", &LinearSumAssignment::RightNode),
      InstanceMethod("cost", &LinearSumAssignment::Cost),
      InstanceAccessor("busy", &LinearSumAssignment::IsBusy, nullptr),
      InstanceMethod("dispose", &LinearSumAssignment::Dispose),
  };
  AddStatusConstants<LinearSumAssignment>(env, {"OPTIMAL", "INFEASIBLE", "POSSIBLE_OVERFLOW"}, &properties);
  exports.Set("SimpleLinearSumAssignment", DefineClass(env, "SimpleLinearSumAssignment", properties));
}

// ---- graph building ---------------------------------------------------------

Napi::Value LinearSumAssignment::AddArc(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (!model_.CheckUsable(env)) return env.Undefined();
  int32_t left, right;
  int64_t cost;
  if (!ReadNewNode(env, info[0], "left node", &left) || !ReadNewNode(env, info[1], "right node", &right) ||
      !ReadInt64(env, info[2], /*allow_infinite=*/false, "cost", &cost) || !CheckArcCapacityLeft(env, 1)) {
    return env.Undefined();
  }
  model_.MarkChanged();
  return Napi::Number::New(env, model_.get().AddArcWithCost(left, right, cost));
}

Napi::Value LinearSumAssignment::AddArcs(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (!model_.CheckUsable(env)) return env.Undefined();
  std::vector<int32_t> lefts, rights;
  std::vector<int64_t> costs;
  if (!ReadIndexArray(env, info[0], kMaxNodes, "leftNodes", &lefts) ||
      !ReadIndexArray(env, info[1], kMaxNodes, "rightNodes", &rights) ||
      !ReadInt64List(env, info[2], /*allow_infinite=*/false, /*non_negative=*/false, "costs", &costs) ||
      !CheckSameLengths(env, {lefts.size(), rights.size(), costs.size()},
                        "addArcsWithCost(leftNodes, rightNodes, costs)") ||
      !CheckArcCapacityLeft(env, lefts.size())) {
    return env.Undefined();
  }
  SimpleLinearSumAssignment& m = model_.get();
  const int32_t first = m.NumArcs();
  for (size_t i = 0; i < lefts.size(); ++i) m.AddArcWithCost(lefts[i], rights[i], costs[i]);
  model_.MarkChanged();
  return ArcRangeToJs(env, first, lefts.size());
}

// ---- solving ----------------------------------------------------------------

Napi::Value LinearSumAssignment::Solve(const Napi::CallbackInfo& info) { return model_.SolveAsync(info, RunSolve); }

Napi::Value LinearSumAssignment::SolveSync(const Napi::CallbackInfo& info) {
  return model_.SolveSync(info.Env(), RunSolve);
}

// ---- results ----------------------------------------------------------------

Napi::Value LinearSumAssignment::OptimalCost(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (!model_.CheckResult(env)) return env.Undefined();
  return Int64ToJs(env, model_.get().OptimalCost(), "optimalCost");
}

Napi::Value LinearSumAssignment::RightMate(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  int32_t left;
  if (!model_.CheckResult(env) || !ReadLeftNode(env, info[0], &left)) return env.Undefined();
  return Napi::Number::New(env, model_.get().RightMate(left));
}

Napi::Value LinearSumAssignment::AssignmentCost(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  int32_t left;
  if (!model_.CheckResult(env) || !ReadLeftNode(env, info[0], &left)) return env.Undefined();
  return Int64ToJs(env, model_.get().AssignmentCost(left), "assignmentCost");
}

// ---- user data ----------------------------------------------------------------

Napi::Value LinearSumAssignment::NumNodes(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (!model_.CheckUsable(env)) return env.Undefined();
  return Napi::Number::New(env, model_.get().NumNodes());
}

Napi::Value LinearSumAssignment::NumArcs(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (!model_.CheckUsable(env)) return env.Undefined();
  return Napi::Number::New(env, model_.get().NumArcs());
}

Napi::Value LinearSumAssignment::LeftNode(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  int32_t arc;
  if (!model_.CheckUsable(env) || !ReadArc(env, info[0], &arc)) return env.Undefined();
  return Napi::Number::New(env, model_.get().LeftNode(arc));
}

Napi::Value LinearSumAssignment::RightNode(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  int32_t arc;
  if (!model_.CheckUsable(env) || !ReadArc(env, info[0], &arc)) return env.Undefined();
  return Napi::Number::New(env, model_.get().RightNode(arc));
}

Napi::Value LinearSumAssignment::Cost(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  int32_t arc;
  if (!model_.CheckUsable(env) || !ReadArc(env, info[0], &arc)) return env.Undefined();
  return Int64ToJs(env, model_.get().Cost(arc), "cost");
}

}  // namespace

void InitLinearSumAssignment(Napi::Env env, Napi::Object exports) { LinearSumAssignment::Init(env, exports); }

}  // namespace ortools_node
