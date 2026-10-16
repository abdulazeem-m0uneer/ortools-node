// SimpleMaxFlow binding (Python's ortools.graph.python.max_flow).
//
// OR-Tools indexes its vectors without bounds checks, so every argument is
// validated here first. Results are only readable after an OPTIMAL solve of the
// graph as it is now.

#include <napi.h>

#include <cstdint>
#include <vector>

#include "common/cpp_guard.h"
#include "common/int64.h"
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

  // Arc indices are read raw (step 1) and checked against the model later (step 3).
  static bool ReadArc(Napi::Env env, const Napi::Value& v, int32_t* arc) {
    return ReadIndexBelow(env, v, kInt32Max, "arc", arc);
  }
  // Reads the arc argument, then checks the model is usable and has that arc.
  bool ReadExistingArc(Napi::Env env, const Napi::Value& v, int32_t* arc) {
    return ReadArc(env, v, arc) && model_.CheckUsable(env) && CheckIndexBelow(env, *arc, model_.get().NumArcs(), "arc");
  }
  // Any node index the graph can hold; nodes are created by the arcs that use them.
  static bool ReadNode(Napi::Env env, const Napi::Value& v, const char* what, int32_t* node) {
    return ReadIndexBelow(env, v, kMaxNodes, what, node);
  }
  // Call after CheckUsable().
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
  int32_t tail, head;
  int64_t capacity;
  if (!ReadNode(env, info[0], "tail", &tail) || !ReadNode(env, info[1], "head", &head) ||
      !ReadCapacity(env, info[2], &capacity) || !model_.CheckUsable(env) || !CheckArcCapacityLeft(env, 1)) {
    return env.Undefined();
  }
  SimpleMaxFlow& m = model_.get();
  int32_t arc = 0;
  if (!model_.Mutate(env, "addArcWithCapacity", [&] { arc = m.AddArcWithCapacity(tail, head, capacity); })) {
    return env.Undefined();
  }
  return Napi::Number::New(env, arc);
}

Napi::Value MaxFlow::AddArcs(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  std::vector<int32_t> tails, heads;
  std::vector<int64_t> capacities;
  if (!ReadIndexArray(env, info[0], kMaxNodes, "tails", &tails) ||
      !ReadIndexArray(env, info[1], kMaxNodes, "heads", &heads) ||
      !ReadInt64List(env, info[2], /*allow_infinite=*/true, /*non_negative=*/true, "capacities", &capacities) ||
      !CheckSameLengths(env, {tails.size(), heads.size(), capacities.size()},
                        "addArcsWithCapacity(tails, heads, capacities)") ||
      !model_.CheckUsable(env) || !CheckArcCapacityLeft(env, tails.size())) {
    return env.Undefined();
  }
  SimpleMaxFlow& m = model_.get();
  const int32_t first = m.NumArcs();
  if (!model_.Mutate(env, "addArcsWithCapacity", [&] {
        for (size_t i = 0; i < tails.size(); ++i) m.AddArcWithCapacity(tails[i], heads[i], capacities[i]);
      })) {
    return env.Undefined();
  }
  return ArcRangeToJs(env, first, tails.size());
}

Napi::Value MaxFlow::SetArcCapacity(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  int32_t arc;
  int64_t capacity;
  if (!ReadArc(env, info[0], &arc) || !ReadCapacity(env, info[1], &capacity) || !model_.CheckUsable(env) ||
      !CheckIndexBelow(env, arc, model_.get().NumArcs(), "arc")) {
    return env.Undefined();
  }
  SimpleMaxFlow& m = model_.get();
  model_.Mutate(env, "setArcCapacity", [&] { m.SetArcCapacity(arc, capacity); });
  return env.Undefined();
}

// ---- solving ----------------------------------------------------------------

// source == sink resolves to BAD_INPUT; a source or sink no arc touches gives
// an OPTIMAL flow of 0 (OR-Tools semantics).
Napi::Value MaxFlow::StartSolve(const Napi::CallbackInfo& info, bool async) {
  Napi::Env env = info.Env();
  int32_t source, sink;
  if (!ReadNode(env, info[0], "source", &source) || !ReadNode(env, info[1], "sink", &sink)) return env.Undefined();
  auto solve = [source, sink](SimpleMaxFlow& m) { return RunSolve(m, source, sink); };
  return async ? model_.SolveAsync(info, solve) : model_.SolveSync(env, "solveSync", solve);
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
  if (!ReadArc(env, info[0], &arc) || !model_.CheckResult(env) ||
      !CheckIndexBelow(env, arc, model_.get().NumArcs(), "arc")) {
    return env.Undefined();
  }
  return Int64ToJs(env, model_.get().Flow(arc), "flow");
}

Napi::Value MaxFlow::Flows(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  ArcSelection selection;
  if (!ReadArcSelection(env, info[0], &selection) || !model_.CheckResult(env)) return env.Undefined();
  SimpleMaxFlow& m = model_.get();
  if (!ResolveArcSelection(env, m.NumArcs(), &selection)) return env.Undefined();
  std::vector<int64_t> flows;
  if (!GuardCpp(env, "flows", [&] { flows.resize(selection.arcs.size()); })) return env.Undefined();
  for (size_t i = 0; i < flows.size(); ++i) flows[i] = m.Flow(selection.arcs[i]);
  return Int64ArrayToJs(env, flows, "flow");
}

Napi::Value MaxFlow::MinCut(const Napi::CallbackInfo& info, bool source_side) {
  Napi::Env env = info.Env();
  if (!model_.CheckResult(env)) return env.Undefined();
  SimpleMaxFlow& m = model_.get();
  std::vector<int32_t> nodes;
  const bool ok = GuardCpp(env, source_side ? "getSourceSideMinCut" : "getSinkSideMinCut", [&] {
    if (source_side) {
      m.GetSourceSideMinCut(&nodes);
    } else {
      m.GetSinkSideMinCut(&nodes);
    }
  });
  return ok ? IndicesToJs(env, nodes) : env.Undefined();
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
  if (!ReadExistingArc(env, info[0], &arc)) return env.Undefined();
  return Napi::Number::New(env, model_.get().Tail(arc));
}

Napi::Value MaxFlow::Head(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  int32_t arc;
  if (!ReadExistingArc(env, info[0], &arc)) return env.Undefined();
  return Napi::Number::New(env, model_.get().Head(arc));
}

Napi::Value MaxFlow::Capacity(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  int32_t arc;
  if (!ReadExistingArc(env, info[0], &arc)) return env.Undefined();
  return Int64ToJs(env, model_.get().Capacity(arc), "capacity");
}

}  // namespace

void InitMaxFlow(Napi::Env env, Napi::Object exports) { MaxFlow::Init(env, exports); }

}  // namespace ortools_node
