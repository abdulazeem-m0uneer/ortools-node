// RoutingModel: solving (synchronous, or on the libuv threadpool) with optional
// solution callbacks, and reading solutions.
//
// Solution callbacks: the model registers one AddAtSolutionCallback hook when
// it is built; during a solve with onSolution it forwards each solution to a
// SolutionListener as a snapshot (objective, optionally routes):
// * synchronously, calling the JS function directly;
// * asynchronously, through a Napi::ThreadSafeFunction (NonBlockingCall). The
//   Promise settles only once the solve has ended AND the thread-safe function
//   has been finalized, so every snapshot is delivered before it settles.
// A throw in the callback stops the search (like interrupt()) and rejects.

#include <napi.h>

#include <cstdint>
#include <memory>
#include <optional>
#include <string>
#include <vector>

#include "common/cpp_guard.h"
#include "common/int64.h"
#include "common/napi_util.h"
#include "routing/routing_guards.h"
#include "routing/routing_model.h"
#include "routing/search_parameters.h"

namespace ortools_node {

using operations_research::Assignment;
using operations_research::IntVar;
using operations_research::RoutingDimension;
using operations_research::RoutingModel;
using operations_research::RoutingSearchParameters;

namespace {

constexpr int64_t kMaxHandle = INT32_MAX;

struct SolutionSnapshot {
  int64_t objective = 0;
  int index = 0;
  bool has_routes = false;
  std::vector<std::vector<int64_t>> routes;
};

// Reads the current solution from the model's variables (they are bound at a
// solution). Runs on the solving thread; never touches JS.
SolutionSnapshot TakeSnapshot(const RoutingModel& model, int index, bool include_routes) {
  SolutionSnapshot snapshot;
  snapshot.index = index;
  IntVar* cost = model.CostVar();
  if (cost != nullptr) snapshot.objective = cost->Bound() ? cost->Value() : cost->Min();
  if (!include_routes) return snapshot;
  const int64_t limit = model.Size() + model.vehicles();
  snapshot.routes.resize(model.vehicles());
  for (int v = 0; v < model.vehicles(); ++v) {
    std::vector<int64_t>& route = snapshot.routes[v];
    int64_t i = model.Start(v);
    route.push_back(i);
    while (!model.IsEnd(i)) {
      IntVar* next = model.NextVar(i);
      if (!next->Bound() || static_cast<int64_t>(route.size()) > limit) return snapshot;  // has_routes stays false
      i = next->Value();
      route.push_back(i);
    }
  }
  snapshot.has_routes = true;
  return snapshot;
}

Napi::Value SnapshotToJs(Napi::Env env, const SolutionSnapshot& snapshot, bool include_routes) {
  Napi::Object out = Napi::Object::New(env);
  // Beyond 2^53 (large penalties) the objective comes as a BigInt rather than
  // failing the callback.
  constexpr int64_t kMaxSafe = 9007199254740991;
  out.Set("objective", snapshot.objective > kMaxSafe || snapshot.objective < -kMaxSafe
                           ? Napi::Value(Napi::BigInt::New(env, snapshot.objective))
                           : Napi::Value(Napi::Number::New(env, static_cast<double>(snapshot.objective))));
  out.Set("solutionIndex", Napi::Number::New(env, snapshot.index));
  if (include_routes) {
    if (!snapshot.has_routes) {
      out.Set("routes", env.Null());
    } else {
      Napi::Array routes = Napi::Array::New(env, snapshot.routes.size());
      for (size_t v = 0; v < snapshot.routes.size(); ++v) {
        Napi::Value route = Int64ArrayToJs(env, snapshot.routes[v], "route index");
        if (env.IsExceptionPending()) return Napi::Value();
        routes.Set(static_cast<uint32_t>(v), route);
      }
      out.Set("routes", routes);
    }
  }
  return out;
}

// Holds a thrown JS value (references to primitives need Node-API 9).
Napi::ObjectReference CaptureException(Napi::Env env) {
  napi_value error;
  napi_get_and_clear_last_exception(env, &error);
  Napi::Object holder = Napi::Object::New(env);
  holder.Set("error", Napi::Value(env, error));
  return Napi::Persistent(holder);
}

// Calls `fn(snapshot)`; on a throw records it, asks the solve to stop and returns false.
bool DeliverSnapshot(Napi::Env env, const Napi::Function& fn, const SolutionSnapshot& snapshot, bool include_routes,
                     Napi::ObjectReference* error, AsyncSolveState* state) {
  Napi::HandleScope scope(env);
  Napi::Value value = SnapshotToJs(env, snapshot, include_routes);
  if (!env.IsExceptionPending()) fn.Call(env.Undefined(), {value});
  if (!env.IsExceptionPending()) return true;
  *error = CaptureException(env);
  state->RequestStop();
  return false;
}

// What every solve reads before touching the model (phase 1).
struct SolveRequest {
  RoutingSearchParameters parameters;
  bool has_initial = false;
  int64_t initial = -1;
  Napi::Function on_solution;  // empty when there is no callback
  bool include_routes = false;
};

bool ReadSolveRequest(const Napi::CallbackInfo& info, SolveRequest* out) {
  Napi::Env env = info.Env();
  if (!ReadRoutingSearchParameters(env, info[0], &out->parameters)) return false;
  out->has_initial = !info[1].IsUndefined() && !info[1].IsNull();
  if (out->has_initial && !ReadIntInRange(env, info[1], 0, kMaxHandle, "assignment", &out->initial)) return false;
  const Napi::Value options = info[2];
  if (options.IsUndefined() || options.IsNull()) return true;
  if (!options.IsObject()) THROW_TYPE_AND_RETURN(env, "options must be an object", false);
  Napi::Value fn = options.As<Napi::Object>().Get("onSolution");
  if (env.IsExceptionPending()) return false;
  Napi::Value routes = options.As<Napi::Object>().Get("includeRoutes");
  if (env.IsExceptionPending()) return false;
  if (!fn.IsUndefined()) {
    if (!fn.IsFunction()) THROW_TYPE_AND_RETURN(env, "options.onSolution must be a function", false);
    out->on_solution = fn.As<Napi::Function>();
  }
  out->include_routes = routes.ToBoolean();
  return true;
}

class SyncListener : public SolutionListener {
 public:
  SyncListener(Napi::Env env, Napi::Function fn, bool include_routes, AsyncSolveState* state)
      : env_(env), fn_(fn), include_routes_(include_routes), state_(state) {}

  void OnSolution(const RoutingModel& model) override {
    if (failed_) return;
    const SolutionSnapshot snapshot = TakeSnapshot(model, count_++, include_routes_);
    if (!DeliverSnapshot(env_, fn_, snapshot, include_routes_, &error_, state_)) failed_ = true;
  }
  bool RethrowIfFailed() {
    if (!failed_) return false;
    napi_throw(env_, error_.Value().Get("error"));
    return true;
  }

 private:
  Napi::Env env_;
  Napi::Function fn_;  // a handle of the solveSync() call, valid during it
  bool include_routes_;
  AsyncSolveState* state_;
  Napi::ObjectReference error_;
  bool failed_ = false;
  int count_ = 0;
};

// One async solve. Shared by the worker and the thread-safe function's
// finalizer; settles the Promise when both are done (main thread).
class AsyncSession : public SolutionListener {
 public:
  AsyncSession(Napi::Env env, Napi::Object owner, RoutingModelWrap* wrap, bool include_routes)
      : deferred_(Napi::Promise::Deferred::New(env)),
        owner_(Napi::Persistent(owner)),
        wrap_(wrap),
        include_routes_(include_routes) {}

  Napi::Promise Promise() const { return deferred_.Promise(); }

  // Main thread, before the solve starts.
  void AttachCallback(Napi::ThreadSafeFunction tsfn) {
    tsfn_ = tsfn;
    has_tsfn_ = true;
  }

  // Solving thread.
  void OnSolution(const RoutingModel& model) override {
    if (!has_tsfn_) return;
    auto* snapshot = new SolutionSnapshot(TakeSnapshot(model, count_++, include_routes_));
    const napi_status status = tsfn_.NonBlockingCall(
        snapshot, [this](Napi::Env env, Napi::Function fn, SolutionSnapshot* data) { Deliver(env, fn, data); });
    if (status != napi_ok) delete snapshot;
  }
  // Solving thread, once the solve has returned.
  void SolveEnded(const Assignment* result, std::optional<CppFailure> failure) {
    result_ = result;
    worker_failure_ = std::move(failure);
    if (has_tsfn_) tsfn_.Release();
  }

  // Main thread.
  void WorkerDone(Napi::Env env) {
    worker_done_ = true;
    MaybeSettle(env);
  }
  void CallbackFinalized(Napi::Env env) {
    tsfn_done_ = true;
    MaybeSettle(env);
  }

 private:
  void Deliver(Napi::Env env, Napi::Function fn, SolutionSnapshot* data) {
    std::unique_ptr<SolutionSnapshot> snapshot(data);
    if (env == nullptr || callback_failed_ || settled_) return;  // tearing down, or already failed
    if (!DeliverSnapshot(env, fn, *snapshot, include_routes_, &callback_error_, &wrap_->solve_state())) {
      callback_failed_ = true;
    }
  }

  void MaybeSettle(Napi::Env env) {
    if (settled_ || !worker_done_ || (has_tsfn_ && !tsfn_done_)) return;
    settled_ = true;
    Napi::HandleScope scope(env);
    int handle = -1;
    const bool recorded = GuardCpp(env, "recording the solution", [&] { handle = wrap_->FinishSolve(result_); });
    if (!recorded) {
      deferred_.Reject(env.GetAndClearPendingException().Value());
    } else if (worker_failure_) {
      deferred_.Reject(worker_failure_->out_of_memory ? Napi::RangeError::New(env, worker_failure_->message).Value()
                                                      : Napi::Error::New(env, worker_failure_->message).Value());
    } else if (callback_failed_) {
      deferred_.Reject(callback_error_.Value().Get("error"));
    } else {
      deferred_.Resolve(handle >= 0 ? Napi::Value(Napi::Number::New(env, handle)) : env.Null());
    }
    owner_.Reset();
  }

  Napi::Promise::Deferred deferred_;
  Napi::ObjectReference owner_;  // keeps the JS model (and with it the native model) alive
  RoutingModelWrap* wrap_;
  const bool include_routes_;
  Napi::ThreadSafeFunction tsfn_;
  bool has_tsfn_ = false;
  int count_ = 0;  // solving thread
  const Assignment* result_ = nullptr;
  std::optional<CppFailure> worker_failure_;
  Napi::ObjectReference callback_error_;
  bool callback_failed_ = false;
  bool worker_done_ = false;
  bool tsfn_done_ = false;
  bool settled_ = false;
};

class RoutingSolveWorker : public Napi::AsyncWorker {
 public:
  RoutingSolveWorker(Napi::Env env, std::shared_ptr<AsyncSession> session, RoutingModel* model,
                     RoutingSearchParameters parameters, const Assignment* initial)
      : Napi::AsyncWorker(env),
        session_(std::move(session)),
        model_(model),
        parameters_(std::move(parameters)),
        initial_(initial) {}

 protected:
  void Execute() override {
    const Assignment* result = nullptr;
    std::optional<CppFailure> failure = GuardCppOffThread("solveWithParameters()", [&] {
      result = model_->SolveFromAssignmentWithParameters(initial_, parameters_);
    });
    session_->SolveEnded(result, std::move(failure));
  }
  void OnOK() override { session_->WorkerDone(Env()); }

 private:
  std::shared_ptr<AsyncSession> session_;
  RoutingModel* model_;
  RoutingSearchParameters parameters_;
  const Assignment* initial_;
};

}  // namespace

// ---------------------------------------------------------------------------
// Solving
// ---------------------------------------------------------------------------

int RoutingModelWrap::RecordAssignment(const Assignment* assignment) {
  assignments_.push_back({assignment, generation_});
  return static_cast<int>(assignments_.size() - 1);
}

int RoutingModelWrap::FinishSolve(const Assignment* solution) {
  listener_ = nullptr;
  solve_state_.End();
  return solution == nullptr ? -1 : RecordAssignment(solution);
}

// (paramsJson, initialHandle?, options?) -> Promise<handle | null>
Napi::Value RoutingModelWrap::Solve(const Napi::CallbackInfo& info) { return StartSolve(info, true); }

// (paramsJson, initialHandle?, options?) -> handle | null
Napi::Value RoutingModelWrap::SolveSync(const Napi::CallbackInfo& info) { return StartSolve(info, false); }

Napi::Value RoutingModelWrap::StartSolve(const Napi::CallbackInfo& info, bool async) {
  Napi::Env env = info.Env();
  SolveRequest request;
  if (!ReadSolveRequest(info, &request) || !CheckUsable(env)) return env.Undefined();
  const Assignment* initial = nullptr;
  if (request.has_initial) {
    initial = AssignmentOf(env, request.initial);
    if (initial == nullptr) return env.Undefined();
  }
  // Closing may reduce domains: do it here, under the fail intercept.
  if (!EnsureClosed(env, request.parameters)) return env.Undefined();
  MarkChanged();  // earlier solutions become invalid
  const bool has_callback = !request.on_solution.IsEmpty();

  if (!async) {
    SyncListener listener(env, request.on_solution, request.include_routes, &solve_state_);
    listener_ = has_callback ? &listener : nullptr;
    solve_state_.Begin();
    const Assignment* result = nullptr;
    const bool solved = GuardCpp(env, "solveWithParametersSync()", [&] {
      result = model_->SolveFromAssignmentWithParameters(initial, request.parameters);
    });
    int handle = -1;
    if (!solved) {
      FinishSolve(nullptr);
      return env.Undefined();
    }
    if (!GuardCpp(env, "recording the solution", [&] { handle = FinishSolve(result); })) return env.Undefined();
    if (listener.RethrowIfFailed()) return env.Undefined();
    return handle >= 0 ? Napi::Value(Napi::Number::New(env, handle)) : env.Null();
  }

  auto session = std::make_shared<AsyncSession>(env, info.This().As<Napi::Object>(), this, request.include_routes);
  if (has_callback) {
    Napi::ThreadSafeFunction tsfn = Napi::ThreadSafeFunction::New(
        env, request.on_solution, "ortools-node routing onSolution", 0, 1,
        [session](Napi::Env finalize_env) { session->CallbackFinalized(finalize_env); });
    if (env.IsExceptionPending()) return env.Undefined();
    session->AttachCallback(tsfn);
  }
  listener_ = has_callback ? session.get() : nullptr;
  solve_state_.Begin();
  auto* worker = new RoutingSolveWorker(env, session, model_.get(), request.parameters, initial);
  worker->Queue();
  return session->Promise();
}

// ---------------------------------------------------------------------------
// Reading solutions
// ---------------------------------------------------------------------------

const Assignment* RoutingModelWrap::AssignmentOf(Napi::Env env, int64_t handle) const {
  if (handle < 0 || handle >= static_cast<int64_t>(assignments_.size()) ||
      assignments_[handle].generation != generation_) {
    Napi::Error::New(env, "This solution is no longer valid: the model was solved again, changed or disposed")
        .ThrowAsJavaScriptException();
    return nullptr;
  }
  return assignments_[handle].assignment;
}

namespace {

// Follows the next variables of `solution` from each start to its end.
bool RoutesOf(Napi::Env env, const RoutingModel& model, const Assignment& solution,
              std::vector<std::vector<int64_t>>* routes) {
  const int64_t limit = model.Size() + model.vehicles();
  routes->assign(model.vehicles(), {});
  for (int v = 0; v < model.vehicles(); ++v) {
    std::vector<int64_t>& route = (*routes)[v];
    int64_t i = model.Start(v);
    route.push_back(i);
    while (!model.IsEnd(i)) {
      IntVar* next = model.NextVar(i);
      // Assignment::Value() dereferences null for a missing variable and only
      // DCHECKs it is bound.
      if (!solution.Contains(next) || !solution.Bound(next) || static_cast<int64_t>(route.size()) > limit) {
        THROW_AND_RETURN(env, "the solution does not fix the route of vehicle " + std::to_string(v), false);
      }
      i = solution.Value(next);
      route.push_back(i);
    }
  }
  return true;
}

Napi::Value RoutesToJs(Napi::Env env, const std::vector<std::vector<int64_t>>& routes) {
  Napi::Array out = Napi::Array::New(env, routes.size());
  for (size_t v = 0; v < routes.size(); ++v) {
    Napi::Value route = Int64ArrayToJs(env, routes[v], "route value");
    if (env.IsExceptionPending()) return env.Undefined();
    out.Set(static_cast<uint32_t>(v), route);
  }
  return out;
}

}  // namespace

Napi::Value RoutingModelWrap::SolutionIsValid(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  int64_t handle;
  if (!ReadIntInRange(env, info[0], 0, kMaxHandle, "solution", &handle)) return env.Undefined();
  const bool valid = model_ && handle < static_cast<int64_t>(assignments_.size()) &&
                     assignments_[handle].generation == generation_;
  return Napi::Boolean::New(env, valid);
}

Napi::Value RoutingModelWrap::SolutionObjective(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  int64_t handle;
  if (!ReadIntInRange(env, info[0], 0, kMaxHandle, "solution", &handle) || !CheckUsable(env)) return env.Undefined();
  const Assignment* solution = AssignmentOf(env, handle);
  if (solution == nullptr) return env.Undefined();
  if (!solution->HasObjective()) THROW_AND_RETURN(env, "this solution has no objective", env.Undefined());
  return Int64ToJs(env, solution->ObjectiveValue(), "objectiveValue");
}

// (handle, varId, kind: 'value' | 'min' | 'max')
Napi::Value RoutingModelWrap::SolutionValue(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  int64_t handle;
  uint32_t var_id;
  std::string kind;
  if (!ReadIntInRange(env, info[0], 0, kMaxHandle, "solution", &handle) ||
      !ReadId(env, info[1], "variable", &var_id) || !ReadString(env, info[2], "kind", &kind) || !CheckUsable(env)) {
    return env.Undefined();
  }
  const Assignment* solution = AssignmentOf(env, handle);
  if (solution == nullptr) return env.Undefined();
  IntVar* var = context_->VarById(env, var_id, "variable");
  if (var == nullptr) return env.Undefined();
  if (!solution->Contains(var)) {
    THROW_AND_RETURN(env, "IntVar '" + var->name() +
                              "' is not stored in solutions: call addToAssignment(var) before closing the model",
                     env.Undefined());
  }
  if (kind == "min") return Int64ToJs(env, solution->Min(var), "min");
  if (kind == "max") return Int64ToJs(env, solution->Max(var), "max");
  if (kind != "value") THROW_TYPE_AND_RETURN(env, "unknown solution value kind '" + kind + "'", env.Undefined());
  // As in OR-Tools (and pywrapcp), the value of a variable the solution leaves
  // as a range is its lower bound; min() / max() give the range.
  return Int64ToJs(env, solution->Value(var), "value");
}

Napi::Value RoutingModelWrap::SolutionRoutes(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  int64_t handle;
  if (!ReadIntInRange(env, info[0], 0, kMaxHandle, "solution", &handle) || !CheckUsable(env)) return env.Undefined();
  const Assignment* solution = AssignmentOf(env, handle);
  if (solution == nullptr) return env.Undefined();
  std::vector<std::vector<int64_t>> routes;
  if (!RoutesOf(env, *model_, *solution, &routes)) return env.Undefined();
  return RoutesToJs(env, routes);
}

// (handle, name, kind: 'cumul' | 'slack') -> per vehicle, one value per route
// index (the lower bound where the solution leaves a range, as Value() does).
// Ends have no slack: their entry is null.
Napi::Value RoutingModelWrap::SolutionDimension(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  int64_t handle;
  std::string name, kind;
  if (!ReadIntInRange(env, info[0], 0, kMaxHandle, "solution", &handle) || !ReadString(env, info[1], "name", &name) ||
      !ReadString(env, info[2], "kind", &kind) || !CheckUsable(env)) {
    return env.Undefined();
  }
  const bool cumul = kind == "cumul";
  if (!cumul && kind != "slack") THROW_TYPE_AND_RETURN(env, "unknown dimension value kind '" + kind + "'", env.Undefined());
  const Assignment* solution = AssignmentOf(env, handle);
  if (solution == nullptr) return env.Undefined();
  RoutingDimension* dimension = DimensionNamed(env, name);
  if (dimension == nullptr) return env.Undefined();
  std::vector<std::vector<int64_t>> routes;
  if (!RoutesOf(env, *model_, *solution, &routes)) return env.Undefined();
  Napi::Array out = Napi::Array::New(env, routes.size());
  for (size_t v = 0; v < routes.size(); ++v) {
    Napi::Array values = Napi::Array::New(env, routes[v].size());
    for (size_t k = 0; k < routes[v].size(); ++k) {
      const int64_t index = routes[v][k];
      if (!cumul && index >= size_) {
        values.Set(static_cast<uint32_t>(k), env.Null());
        continue;
      }
      IntVar* var = cumul ? dimension->CumulVar(index) : dimension->SlackVar(index);
      if (!solution->Contains(var)) {
        THROW_AND_RETURN(env, "the " + kind + " variables of dimension '" + name +
                                  "' are not stored in solutions: call addToAssignment() on them before closing",
                         env.Undefined());
      }
      Napi::Value value = Int64ToJs(env, solution->Value(var), "dimension value");
      if (env.IsExceptionPending()) return env.Undefined();
      values.Set(static_cast<uint32_t>(k), value);
    }
    out.Set(static_cast<uint32_t>(v), values);
  }
  return out;
}

}  // namespace ortools_node
