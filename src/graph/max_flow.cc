// SimpleMaxFlow binding (Python's ortools.graph.python.max_flow).
//
// OR-Tools indexes its vectors without bounds checks, so every argument is
// validated here first. Results are only readable after an OPTIMAL solve of the
// graph as it is now.

#include <napi.h>

#include <cstdint>
#include <vector>

#include "common/int64.h"
#include "common/napi_util.h"
#include "graph/graph.h"
#include "graph/graph_common.h"
#include "ortools/graph/max_flow.h"

using operations_research::SimpleMaxFlow;

namespace ortools_node {
namespace {

// Solve() builds a graph whose index arrays hold NumNodes() + 1 int32 entries.
constexpr int64_t kMaxNodes = kInt32Max - 1;

const char* StatusName(SimpleMaxFlow::Status status) {
  switch (status) {
    case SimpleMaxFlow::OPTIMAL: return "OPTIMAL";
    case SimpleMaxFlow::POSSIBLE_OVERFLOW: return "POSSIBLE_OVERFLOW";
    case SimpleMaxFlow::BAD_INPUT: return "BAD_INPUT";
    case SimpleMaxFlow::BAD_RESULT: return "BAD_RESULT";
  }
  return "BAD_RESULT";
}

SolveOutcome RunSolve(SimpleMaxFlow& model, int32_t source, int32_t sink) {
  const SimpleMaxFlow::Status status = model.Solve(source, sink);
  return {StatusName(status), status == SimpleMaxFlow::OPTIMAL};
}

class MaxFlow : public Napi::ObjectWrap<MaxFlow> {
 public:
  static void Init(Napi::Env env, Napi::Object exports);
  explicit MaxFlow(const Napi::CallbackInfo& info) : Napi::ObjectWrap<MaxFlow>(info), model_("SimpleMaxFlow") {}

 private:
  // --- graph building ---
  Napi::Value AddArc(const Napi::CallbackInfo& info);          // (tail, head, capacity) -> arc
  Napi::Value AddArcs(const Napi::CallbackInfo& info);         // (tails, heads, capacities) -> Int32Array
  Napi::Value SetArcCapacity(const Napi::CallbackInfo& info);  // (arc, capacity)

  // --- solving ---
  Napi::Value Solve(const Napi::CallbackInfo& info);      // (source, sink) -> Promise<status>
  Napi::Value SolveSync(const Napi::CallbackInfo& info);  // (source, sink) -> status

  // --- results ---
  Napi::Value OptimalFlow(const Napi::CallbackInfo& info);
  Napi::Value Flow(const Napi::CallbackInfo& info);   // (arc)
  Napi::Value Flows(const Napi::CallbackInfo& info);  // (arcs?)
  Napi::Value GetSourceSideMinCut(const Napi::CallbackInfo& info);
  Napi::Value GetSinkSideMinCut(const Napi::CallbackInfo& info);

  // --- user data ---
  Napi::Value NumNodes(const Napi::CallbackInfo& info);
  Napi::Value NumArcs(const Napi::CallbackInfo& info);
  Napi::Value Tail(const Napi::CallbackInfo& info);
  Napi::Value Head(const Napi::CallbackInfo& info);
  Napi::Value Capacity(const Napi::CallbackInfo& info);

  Napi::Value IsBusy(const Napi::CallbackInfo& info) { return Napi::Boolean::New(info.Env(), model_.busy()); }
  Napi::Value Dispose(const Napi::CallbackInfo& info) { return model_.Dispose(info.Env()); }

  bool ReadArc(Napi::Env env, const Napi::Value& v, int32_t* arc) {
    size_t index;
    if (!ReadIndex(env, v, static_cast<size_t>(model_.get().NumArcs()), "arc", &index)) return false;
    *arc = static_cast<int32_t>(index);
    return true;
  }
  // Any node index the graph can hold; nodes are created by the arcs that use them.
  static bool ReadNode(Napi::Env env, const Napi::Value& v, const char* what, int32_t* node) {
    size_t index;
    if (!ReadIndex(env, v, static_cast<size_t>(kMaxNodes), what, &index)) return false;
    *node = static_cast<int32_t>(index);
    return true;
  }
  bool CheckArcCapacityLeft(Napi::Env env, size_t added) {
    if (static_cast<int64_t>(model_.get().NumArcs()) + static_cast<int64_t>(added) <= kInt32Max) return true;
    Napi::RangeError::New(env, "SimpleMaxFlow: numArcs() must stay <= 2^31 - 1").ThrowAsJavaScriptException();
    return false;
  }
  Napi::Value StartSolve(const Napi::CallbackInfo& info, bool async);
  Napi::Value MinCut(const Napi::CallbackInfo& info, bool source_side);

  GraphModel<SimpleMaxFlow> model_;
};

void MaxFlow::Init(Napi::Env env, Napi::Object exports) {
  std::vector<Napi::ClassPropertyDescriptor<MaxFlow>> properties = {
      InstanceMethod("addArcWithCapacity", &MaxFlow::AddArc),
      InstanceMethod("addArcsWithCapacity", &MaxFlow::AddArcs),
      InstanceMethod("setArcCapacity", &MaxFlow::SetArcCapacity),
      InstanceMethod("solve", &MaxFlow::Solve),
      InstanceMethod("solveSync", &MaxFlow::SolveSync),
      InstanceMethod("optimalFlow", &MaxFlow::OptimalFlow),
      InstanceMethod("flow", &MaxFlow::Flow),
      InstanceMethod("flows", &MaxFlow::Flows),
      InstanceMethod("getSourceSideMinCut", &MaxFlow::GetSourceSideMinCut),
      InstanceMethod("getSinkSideMinCut", &MaxFlow::GetSinkSideMinCut),
      InstanceMethod("numNodes", &MaxFlow::NumNodes),
      InstanceMethod("numArcs", &MaxFlow::NumArcs),
      InstanceMethod("tail", &MaxFlow::Tail),
      InstanceMethod("head", &MaxFlow::Head),
      InstanceMethod("capacity", &MaxFlow::Capacity),
      InstanceAccessor("busy", &MaxFlow::IsBusy, nullptr),
      InstanceMethod("dispose", &MaxFlow::Dispose),
  };
  AddStatusConstants<MaxFlow>(env, {"OPTIMAL", "POSSIBLE_OVERFLOW", "BAD_INPUT", "BAD_RESULT"}, &properties);
  exports.Set("SimpleMaxFlow", DefineClass(env, "SimpleMaxFlow", properties));
}

// ---- graph building ---------------------------------------------------------

Napi::Value MaxFlow::AddArc(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (!model_.CheckUsable(env)) return env.Undefined();
  int32_t tail, head;
  int64_t capacity;
  if (!ReadNode(env, info[0], "tail", &tail) || !ReadNode(env, info[1], "head", &head) ||
      !ReadCapacity(env, info[2], &capacity) || !CheckArcCapacityLeft(env, 1)) {
    return env.Undefined();
  }
  model_.MarkChanged();
  return Napi::Number::New(env, model_.get().AddArcWithCapacity(tail, head, capacity));
}

Napi::Value MaxFlow::AddArcs(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (!model_.CheckUsable(env)) return env.Undefined();
  std::vector<int32_t> tails, heads;
  std::vector<int64_t> capacities;
  if (!ReadIndexArray(env, info[0], kMaxNodes, "tails", &tails) ||
      !ReadIndexArray(env, info[1], kMaxNodes, "heads", &heads) ||
      !ReadInt64List(env, info[2], /*allow_infinite=*/true, /*non_negative=*/true, "capacities", &capacities) ||
      !CheckSameLengths(env, {tails.size(), heads.size(), capacities.size()},
                        "addArcsWithCapacity(tails, heads, capacities)") ||
      !CheckArcCapacityLeft(env, tails.size())) {
    return env.Undefined();
  }
  SimpleMaxFlow& m = model_.get();
  const int32_t first = m.NumArcs();
  for (size_t i = 0; i < tails.size(); ++i) m.AddArcWithCapacity(tails[i], heads[i], capacities[i]);
  model_.MarkChanged();
  return ArcRangeToJs(env, first, tails.size());
}

Napi::Value MaxFlow::SetArcCapacity(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (!model_.CheckUsable(env)) return env.Undefined();
  int32_t arc;
  int64_t capacity;
  if (!ReadArc(env, info[0], &arc) || !ReadCapacity(env, info[1], &capacity)) return env.Undefined();
  model_.get().SetArcCapacity(arc, capacity);
  model_.MarkChanged();
  return env.Undefined();
}

// ---- solving ----------------------------------------------------------------

// source == sink resolves to BAD_INPUT; a source or sink no arc touches gives
// an OPTIMAL flow of 0 (OR-Tools semantics).
Napi::Value MaxFlow::StartSolve(const Napi::CallbackInfo& info, bool async) {
  Napi::Env env = info.Env();
  if (!model_.CheckUsable(env)) return env.Undefined();
  int32_t source, sink;
  if (!ReadNode(env, info[0], "source", &source) || !ReadNode(env, info[1], "sink", &sink)) return env.Undefined();
  auto solve = [source, sink](SimpleMaxFlow& m) { return RunSolve(m, source, sink); };
  return async ? model_.SolveAsync(info, solve) : model_.SolveSync(env, solve);
}

Napi::Value MaxFlow::Solve(const Napi::CallbackInfo& info) { return StartSolve(info, true); }

Napi::Value MaxFlow::SolveSync(const Napi::CallbackInfo& info) { return StartSolve(info, false); }

// ---- results ----------------------------------------------------------------

Napi::Value MaxFlow::OptimalFlow(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (!model_.CheckResult(env)) return env.Undefined();
  return Int64ToJs(env, model_.get().OptimalFlow(), "optimalFlow");
}

Napi::Value MaxFlow::Flow(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  int32_t arc;
  if (!model_.CheckResult(env) || !ReadArc(env, info[0], &arc)) return env.Undefined();
  return Int64ToJs(env, model_.get().Flow(arc), "flow");
}

Napi::Value MaxFlow::Flows(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (!model_.CheckResult(env)) return env.Undefined();
  SimpleMaxFlow& m = model_.get();
  std::vector<int32_t> arcs;
  if (!ReadArcSelection(env, info[0], m.NumArcs(), &arcs)) return env.Undefined();
  std::vector<int64_t> flows(arcs.size());
  for (size_t i = 0; i < arcs.size(); ++i) flows[i] = m.Flow(arcs[i]);
  return Int64ArrayToJs(env, flows, "flow");
}

Napi::Value MaxFlow::MinCut(const Napi::CallbackInfo& info, bool source_side) {
  Napi::Env env = info.Env();
  if (!model_.CheckResult(env)) return env.Undefined();
  std::vector<int32_t> nodes;
  if (source_side) {
    model_.get().GetSourceSideMinCut(&nodes);
  } else {
    model_.get().GetSinkSideMinCut(&nodes);
  }
  return IndicesToJs(env, nodes);
}

Napi::Value MaxFlow::GetSourceSideMinCut(const Napi::CallbackInfo& info) { return MinCut(info, true); }

Napi::Value MaxFlow::GetSinkSideMinCut(const Napi::CallbackInfo& info) { return MinCut(info, false); }

// ---- user data ----------------------------------------------------------------

Napi::Value MaxFlow::NumNodes(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (!model_.CheckUsable(env)) return env.Undefined();
  return Napi::Number::New(env, model_.get().NumNodes());
}

Napi::Value MaxFlow::NumArcs(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (!model_.CheckUsable(env)) return env.Undefined();
  return Napi::Number::New(env, model_.get().NumArcs());
}

Napi::Value MaxFlow::Tail(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  int32_t arc;
  if (!model_.CheckUsable(env) || !ReadArc(env, info[0], &arc)) return env.Undefined();
  return Napi::Number::New(env, model_.get().Tail(arc));
}

Napi::Value MaxFlow::Head(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  int32_t arc;
  if (!model_.CheckUsable(env) || !ReadArc(env, info[0], &arc)) return env.Undefined();
  return Napi::Number::New(env, model_.get().Head(arc));
}

Napi::Value MaxFlow::Capacity(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  int32_t arc;
  if (!model_.CheckUsable(env) || !ReadArc(env, info[0], &arc)) return env.Undefined();
  return Int64ToJs(env, model_.get().Capacity(arc), "capacity");
}

}  // namespace

void InitMaxFlow(Napi::Env env, Napi::Object exports) { MaxFlow::Init(env, exports); }

}  // namespace ortools_node
