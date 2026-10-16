// Shared plumbing for the graph wrappers (SimpleMinCostFlow, SimpleMaxFlow,
// SimpleLinearSumAssignment).
//
// OR-Tools guards these classes with CHECKs and unchecked vector indexing, so
// every index and size is validated here before it reaches the library: a bad
// argument must become a JS exception, never a process abort.
//
// Every method follows the same order, because reading a JS Array runs user
// code (element getters, Proxy traps) that may call dispose() or solve():
//   1. read every JS argument into C++ values (model-independent limits only);
//   2. CheckUsable() / CheckResult();
//   3. only then take get() and check indices against the model's sizes.
// No model reference is held across a JS read.

#ifndef ORTOOLS_NODE_GRAPH_GRAPH_COMMON_H_
#define ORTOOLS_NODE_GRAPH_GRAPH_COMMON_H_

#include <napi.h>

#include <cstdint>
#include <functional>
#include <initializer_list>
#include <limits>
#include <memory>
#include <string>
#include <utility>
#include <vector>

#include "common/async_worker.h"
#include "common/cpp_guard.h"

namespace ortools_node {

constexpr int64_t kInt32Max = std::numeric_limits<int32_t>::max();

// What a solve produced: the status name returned to JS, and whether the
// result accessors may read the model afterwards.
struct SolveOutcome {
  const char* status;
  bool has_result;
};

// Reads one index: an integer number in [0, limit).
bool ReadIndexBelow(Napi::Env env, const Napi::Value& v, int64_t limit, const char* what, int32_t* out);

// Reads an index list: an Int32Array (copied as is) or anything ReadInt64Array
// accepts. Every element must lie in [0, limit).
bool ReadIndexArray(Napi::Env env, const Napi::Value& v, int64_t limit, const char* what, std::vector<int32_t>* out);

// Reads an int64 list (see ReadInt64Array); with non_negative, rejects values < 0.
bool ReadInt64List(Napi::Env env, const Napi::Value& v, bool allow_infinite, bool non_negative, const char* what,
                   std::vector<int64_t>* out);

// Reads one int64 that must be >= 0 (+Infinity allowed: OR-Tools' "unbounded").
bool ReadCapacity(Napi::Env env, const Napi::Value& v, int64_t* out);

// Throws a RangeError unless every size equals the first one.
bool CheckSameLengths(Napi::Env env, std::initializer_list<size_t> sizes, const char* signature);

// Throws the same RangeError as ReadIndexBelow unless index < size.
bool CheckIndexBelow(Napi::Env env, int32_t index, int64_t size, const char* what);

// The optional `arcs` argument of flows(): read raw first, resolved against
// the model's arc count once the model is known to be usable.
struct ArcSelection {
  bool all = true;
  std::vector<int32_t> arcs;
};
bool ReadArcSelection(Napi::Env env, const Napi::Value& v, ArcSelection* out);
bool ResolveArcSelection(Napi::Env env, int32_t num_arcs, ArcSelection* selection);

// SimpleMaxFlow::Solve() and SimpleMinCostFlow::Solve() build a
// util::ReverseArcStaticGraph, whose arc arrays (head_, opposite_) come from
// malloc followed by CHECK(new_storage != nullptr): running out of memory there
// aborts the process instead of throwing std::bad_alloc. Call this inside the
// solve's GuardCpp / RunGuarded, right before Solve(), with the graph
// OR-Tools will build. It mallocs together blocks the size of what is live when
// the last of those mallocs runs (plus a 25% margin), frees them, and throws
// std::bad_alloc if any failed, which the guard turns into a RangeError.
// Residual race: memory the probe freed can be taken (by another thread or
// process) before Solve() allocates it; then the abort is still possible.
void ProbeFlowGraphMemory(int64_t num_nodes, int64_t num_arcs);

// The arcs [first, first + count) as an Int32Array (what the bulk adders return).
Napi::Value ArcRangeToJs(Napi::Env env, int32_t first, size_t count);

// Node or arc indices as an Int32Array.
Napi::Value IndicesToJs(Napi::Env env, const std::vector<int32_t>& indices);

// Exposes each status name as a constant on the class and its instances, like
// Python's `smcf.OPTIMAL`: SimpleMinCostFlow.OPTIMAL === 'OPTIMAL'.
template <typename T>
void AddStatusConstants(Napi::Env env, std::initializer_list<const char*> names,
                        std::vector<Napi::ClassPropertyDescriptor<T>>* properties) {
  for (const char* name : names) {
    properties->push_back(Napi::ObjectWrap<T>::StaticValue(name, Napi::String::New(env, name), napi_enumerable));
    properties->push_back(Napi::ObjectWrap<T>::InstanceValue(name, Napi::String::New(env, name), napi_enumerable));
  }
}

// Owns one OR-Tools graph model and its lifecycle: disposed, busy while a
// solve() runs on the threadpool, and whether the last solve left results that
// still describe the current model.
template <typename Model>
class GraphModel {
 public:
  explicit GraphModel(const char* class_name) : class_name_(class_name), model_(std::make_unique<Model>()) {}

  // Only after CheckUsable() / CheckResult(), and after every JS read.
  Model& get() { return *model_; }
  bool busy() const { return solve_state_.busy(); }

  // Throws unless the model exists and no solve() is running.
  bool CheckUsable(Napi::Env env) const {
    if (!model_) {
      Napi::Error::New(env, std::string(class_name_) +
                                (discarded_ ? " was discarded after running out of memory" : " has been disposed"))
          .ThrowAsJavaScriptException();
      return false;
    }
    return CheckNotBusy(env, solve_state_, class_name_);
  }

  // CheckUsable, and the last solve succeeded on the model as it is now.
  bool CheckResult(Napi::Env env) const {
    if (!CheckUsable(env)) return false;
    if (!has_result_) {
      Napi::Error::New(env, std::string("No ") + class_name_ +
                                " result: call solve() first and check it returned OPTIMAL (any change to the "
                                "graph discards the previous result)")
          .ThrowAsJavaScriptException();
      return false;
    }
    return true;
  }

  // Applies a change to the model. Discards the previous result; if OR-Tools
  // throws (out of memory) the model may be half-changed, so it is discarded
  // too and the call throws.
  template <typename F>
  bool Mutate(Napi::Env env, const char* what, F&& change) {
    has_result_ = false;
    if (GuardCpp(env, what, std::forward<F>(change))) return true;
    model_.reset();
    discarded_ = true;
    return false;
  }

  // Runs `solve` on the threadpool; the Promise resolves to the status name, or
  // rejects if OR-Tools throws (the graph itself stays usable).
  Napi::Value SolveAsync(const Napi::CallbackInfo& info, std::function<SolveOutcome(Model&)> solve);

  Napi::Value SolveSync(Napi::Env env, const char* what, const std::function<SolveOutcome(Model&)>& solve) {
    if (!CheckUsable(env)) return env.Undefined();
    SolveOutcome outcome{"NOT_SOLVED", false};
    const bool ok = GuardCpp(env, what, [&] { outcome = solve(*model_); });
    has_result_ = ok && outcome.has_result;
    if (!ok) return env.Undefined();
    return Napi::String::New(env, outcome.status);
  }

  // Frees the model now rather than at GC. Idempotent; throws while busy.
  Napi::Value Dispose(Napi::Env env) {
    if (!model_) return env.Undefined();
    if (!CheckNotBusy(env, solve_state_, class_name_)) return env.Undefined();
    model_.reset();
    has_result_ = false;
    return env.Undefined();
  }

 private:
  class Worker;

  const char* class_name_;
  std::unique_ptr<Model> model_;
  AsyncSolveState solve_state_;
  bool has_result_ = false;
  bool discarded_ = false;  // model_ was dropped after an out-of-memory mutation
};

template <typename Model>
class GraphModel<Model>::Worker : public PromiseWorker {
 public:
  Worker(Napi::Env env, Napi::Object owner, GraphModel* model, std::function<SolveOutcome(Model&)> solve)
      : PromiseWorker(env, owner), model_(model), solve_(std::move(solve)) {}

 protected:
  // Threadpool: the model is ours alone, every JS-facing call throws while busy.
  void Execute() override {
    RunGuarded("solve", [this] { outcome_ = solve_(*model_->model_); });
  }

  void Finish(bool succeeded) override {
    model_->solve_state_.End();
    model_->has_result_ = succeeded && outcome_.has_result;
  }

  Napi::Value Result(Napi::Env env) override { return Napi::String::New(env, outcome_.status); }

 private:
  GraphModel* model_;
  std::function<SolveOutcome(Model&)> solve_;
  SolveOutcome outcome_{"NOT_SOLVED", false};
};

template <typename Model>
Napi::Value GraphModel<Model>::SolveAsync(const Napi::CallbackInfo& info, std::function<SolveOutcome(Model&)> solve) {
  Napi::Env env = info.Env();
  if (!CheckUsable(env)) return env.Undefined();
  solve_state_.Begin();
  has_result_ = false;
  Worker* worker = new Worker(env, info.This().As<Napi::Object>(), this, std::move(solve));
  worker->Queue();
  return worker->Promise();
}

}  // namespace ortools_node

#endif  // ORTOOLS_NODE_GRAPH_GRAPH_COMMON_H_
