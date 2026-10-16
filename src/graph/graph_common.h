// Shared plumbing for the graph wrappers (SimpleMinCostFlow, SimpleMaxFlow,
// SimpleLinearSumAssignment).
//
// OR-Tools guards these classes with CHECKs and unchecked vector indexing, so
// every index and size is validated here before it reaches the library: a bad
// argument must become a JS exception, never a process abort.

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

namespace ortools_node {

constexpr int64_t kInt32Max = std::numeric_limits<int32_t>::max();

// What a solve produced: the status name returned to JS, and whether the
// result accessors may read the model afterwards.
struct SolveOutcome {
  const char* status;
  bool has_result;
};

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

// Reads the optional `arcs` argument of flows(): every arc when undefined.
bool ReadArcSelection(Napi::Env env, const Napi::Value& v, int32_t num_arcs, std::vector<int32_t>* out);

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

  Model& get() { return *model_; }
  bool busy() const { return solve_state_.busy(); }

  // Throws unless the model exists and no solve() is running.
  bool CheckUsable(Napi::Env env) const {
    if (!model_) {
      Napi::Error::New(env, std::string(class_name_) + " has been disposed").ThrowAsJavaScriptException();
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

  // Every mutation discards the previous result.
  void MarkChanged() { has_result_ = false; }

  // Runs `solve` on the threadpool; the Promise resolves to the status name.
  Napi::Value SolveAsync(const Napi::CallbackInfo& info, std::function<SolveOutcome(Model&)> solve);

  Napi::Value SolveSync(Napi::Env env, const std::function<SolveOutcome(Model&)>& solve) {
    if (!CheckUsable(env)) return env.Undefined();
    const SolveOutcome outcome = solve(*model_);
    has_result_ = outcome.has_result;
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
};

template <typename Model>
class GraphModel<Model>::Worker : public PromiseWorker {
 public:
  Worker(Napi::Env env, Napi::Object owner, GraphModel* model, std::function<SolveOutcome(Model&)> solve)
      : PromiseWorker(env, owner), model_(model), solve_(std::move(solve)) {}

 protected:
  // Threadpool: the model is ours alone, every JS-facing call throws while busy.
  void Execute() override { outcome_ = solve_(*model_->model_); }

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
