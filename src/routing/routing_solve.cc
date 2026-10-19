// RoutingModel: solving (synchronous, or on the libuv threadpool) with optional
// solution and progress callbacks, and reading solutions.
//
// Callbacks: the model registers one AddAtSolutionCallback hook and one
// ProgressMonitor when it is built; during a solve with onSolution / onProgress
// they forward snapshots of plain values (never live native objects):
// * synchronously, calling the JS functions directly;
// * asynchronously, through one Napi::ThreadSafeFunction per callback
//   (NonBlockingCall: the solver never waits for JS). Every solution snapshot
//   is queued (memory grows with the solutions found while JS is busy); progress
//   snapshots coalesce, at most one is queued and it carries the latest values.
//   The Promise settles only once the solve has ended AND every thread-safe
//   function has been finalized, so the final progress event and every
//   solution are delivered before it settles.
// The first throw in a callback stops the search (like interrupt()), no
// callback runs after it, and the solve rejects (or rethrows) with it.

#include <napi.h>

#include <atomic>
#include <cstdint>
#include <memory>
#include <mutex>
#include <optional>
#include <stdexcept>
#include <string>
#include <vector>

#include "absl/time/time.h"
#include "common/cpp_guard.h"
#include "common/int64.h"
#include "common/napi_util.h"
#include "routing/routing_guards.h"
#include "routing/routing_model.h"
#include "routing/routing_progress.h"
#include "routing/search_parameters.h"

namespace ortools_node {

using operations_research::Assignment;
using operations_research::IntVar;
using operations_research::RoutingDimension;
using operations_research::RoutingModel;
using operations_research::RoutingSearchParameters;

namespace {

constexpr int64_t kMaxHandle = INT32_MAX;
constexpr int64_t kDefaultProgressIntervalMs = 500;

// native._testing.failNextRoutingSolves(n): the next n solves throw a C++
// exception once OR-Tools has returned, to test the failure paths. Test-only
// and process-wide: shared by every worker thread's addon instance.
std::atomic<int64_t> solves_to_fail_for_testing{0};

void MaybeFailForTesting() {
  int64_t n = solves_to_fail_for_testing.load();
  while (n > 0 && !solves_to_fail_for_testing.compare_exchange_weak(n, n - 1)) {
  }
  if (n > 0) throw std::runtime_error("injected routing solve failure");
}

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
  out.Set("objective", Int64ToJsNumberOrBigInt(env, snapshot.objective));
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

// Holds a thrown JS value (references to primitives need Node-API 9). Empty
// when nothing was thrown: the call could not run (worker.terminate()).
Napi::ObjectReference CaptureException(Napi::Env env) {
  if (!env.IsExceptionPending()) return Napi::ObjectReference();
  napi_value error;
  napi_get_and_clear_last_exception(env, &error);
  Napi::Object holder = Napi::Object::New(env);
  holder.Set("error", Napi::Value(env, error));
  return Napi::Persistent(holder);
}

// The value to reject or rethrow with for a failed callback.
Napi::Value CallbackError(Napi::Env env, const Napi::ObjectReference& error) {
  if (error.IsEmpty()) return Napi::Error::New(env, "a solve callback could not be called").Value();
  return error.Value().Get("error");
}

// Calls `fn(to_js(env))`. When it throws, or cannot run at all, records the
// error, asks the solve to stop and returns false.
template <typename ToJs>
bool Deliver(Napi::Env env, const Napi::Function& fn, ToJs&& to_js, Napi::ObjectReference* error,
             AsyncSolveState* state) {
  Napi::HandleScope scope(env);
  Napi::Value value = to_js(env);
  Napi::Value result;
  if (!env.IsExceptionPending()) result = fn.Call(env.Undefined(), {value});
  if (!env.IsExceptionPending() && !result.IsEmpty()) return true;
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
  Napi::Function on_progress;  // empty when there is no callback
  int64_t progress_interval_ms = kDefaultProgressIntervalMs;
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
  Napi::Value progress = options.As<Napi::Object>().Get("onProgress");
  if (env.IsExceptionPending()) return false;
  Napi::Value interval = options.As<Napi::Object>().Get("progressIntervalMs");
  if (env.IsExceptionPending()) return false;
  if (!progress.IsUndefined()) {
    if (!progress.IsFunction()) THROW_TYPE_AND_RETURN(env, "options.onProgress must be a function", false);
    out->on_progress = progress.As<Napi::Function>();
  }
  return interval.IsUndefined() ||
         ReadIntInRange(env, interval, 0, INT32_MAX, "options.progressIntervalMs", &out->progress_interval_ms);
}

// The callbacks of a synchronous solve, called directly on the main thread.
class SyncCallbacks : public SolutionListener, public ProgressSink {
 public:
  SyncCallbacks(Napi::Env env, const SolveRequest& request, AsyncSolveState* state)
      : env_(env),
        on_solution_(request.on_solution),
        on_progress_(request.on_progress),
        include_routes_(request.include_routes),
        state_(state) {}

  void OnSolution(const RoutingModel& model) override {
    if (failed_) return;
    const SolutionSnapshot snapshot = TakeSnapshot(model, count_++, include_routes_);
    failed_ = !Deliver(
        env_, on_solution_, [&](Napi::Env env) { return SnapshotToJs(env, snapshot, include_routes_); }, &error_,
        state_);
  }
  void OnProgress(const ProgressSnapshot& snapshot) override {
    if (failed_) return;
    failed_ = !Deliver(
        env_, on_progress_, [&](Napi::Env env) { return ProgressToJs(env, snapshot); }, &error_, state_);
  }
  bool RethrowIfFailed() {
    if (!failed_) return false;
    napi_throw(env_, CallbackError(env_, error_));
    return true;
  }

 private:
  Napi::Env env_;
  Napi::Function on_solution_;  // handles of the solveSync() call, valid during it
  Napi::Function on_progress_;
  bool include_routes_;
  AsyncSolveState* state_;
  Napi::ObjectReference error_;  // the first throw
  bool failed_ = false;
  int count_ = 0;
};

// One async solve. Shared by the worker and the thread-safe functions'
// finalizers; settles the Promise when all are done (main thread).
class AsyncSession : public SolutionListener, public ProgressSink {
 public:
  AsyncSession(Napi::Env env, Napi::Object owner, RoutingModelWrap* wrap, bool include_routes)
      : deferred_(Napi::Promise::Deferred::New(env)),
        owner_(Napi::Persistent(owner)),
        wrap_(wrap),
        include_routes_(include_routes) {}

  Napi::Promise Promise() const { return deferred_.Promise(); }

  // Main thread, before the solve starts.
  void AttachSolutionCallback(Napi::ThreadSafeFunction tsfn) {
    solution_tsfn_ = tsfn;
    has_solution_tsfn_ = true;
    ++live_tsfns_;
  }
  void AttachProgressCallback(Napi::ThreadSafeFunction tsfn) {
    progress_tsfn_ = tsfn;
    has_progress_tsfn_ = true;
    ++live_tsfns_;
  }

  // Solving thread.
  void OnSolution(const RoutingModel& model) override {
    if (!has_solution_tsfn_) return;
    auto* snapshot = new SolutionSnapshot(TakeSnapshot(model, count_++, include_routes_));
    const napi_status status = solution_tsfn_.NonBlockingCall(
        snapshot, [this](Napi::Env env, Napi::Function fn, SolutionSnapshot* data) { DeliverSolution(env, fn, data); });
    if (status != napi_ok) delete snapshot;
  }
  // Solving thread. Coalesces: while a call is queued, newer snapshots replace
  // the pending one instead of queuing more calls. ProgressMonitor throttles
  // before calling this, so the uncontended lock is taken at most once per
  // interval; only progressIntervalMs 0 takes it on every search event.
  void OnProgress(const ProgressSnapshot& snapshot) override {
    if (!has_progress_tsfn_) return;
    {
      std::lock_guard<std::mutex> lock(progress_mutex_);
      pending_progress_ = snapshot;
      if (progress_queued_) return;
      progress_queued_ = true;
    }
    const napi_status status =
        progress_tsfn_.NonBlockingCall([this](Napi::Env env, Napi::Function fn) { DeliverProgress(env, fn); });
    if (status != napi_ok) {
      std::lock_guard<std::mutex> lock(progress_mutex_);
      progress_queued_ = false;
    }
  }
  // Solving thread, once the solve has returned and the final progress
  // snapshot is published.
  void SolveEnded(const Assignment* result, std::optional<CppFailure> failure) {
    result_ = result;
    worker_failure_ = std::move(failure);
    if (has_solution_tsfn_) solution_tsfn_.Release();
    if (has_progress_tsfn_) progress_tsfn_.Release();
  }

  // Main thread.
  void WorkerDone(Napi::Env env) {
    worker_done_ = true;
    MaybeSettle(env);
  }
  void CallbackFinalized(Napi::Env env) {
    --live_tsfns_;
    MaybeSettle(env);
  }

 private:
  void DeliverSolution(Napi::Env env, Napi::Function fn, SolutionSnapshot* data) {
    std::unique_ptr<SolutionSnapshot> snapshot(data);
    if (!CanCall(env)) return;
    callback_failed_ = !Deliver(
        env, fn, [&](Napi::Env e) { return SnapshotToJs(e, *snapshot, include_routes_); }, &callback_error_,
        &wrap_->solve_state());
  }
  void DeliverProgress(Napi::Env env, Napi::Function fn) {
    ProgressSnapshot snapshot;
    {
      std::lock_guard<std::mutex> lock(progress_mutex_);
      snapshot = pending_progress_;
      progress_queued_ = false;
    }
    if (!CanCall(env)) return;
    callback_failed_ = !Deliver(
        env, fn, [&](Napi::Env e) { return ProgressToJs(e, snapshot); }, &callback_error_, &wrap_->solve_state());
  }
  // False while tearing down, after a callback threw, or once settled.
  bool CanCall(Napi::Env env) const { return env != nullptr && !callback_failed_ && !settled_; }

  void MaybeSettle(Napi::Env env) {
    if (settled_ || !worker_done_ || live_tsfns_ > 0) return;
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
      deferred_.Reject(CallbackError(env, callback_error_));
    } else {
      deferred_.Resolve(handle >= 0 ? Napi::Value(Napi::Number::New(env, handle)) : env.Null());
    }
    owner_.Reset();
  }

  Napi::Promise::Deferred deferred_;
  Napi::ObjectReference owner_;  // keeps the JS model (and with it the native model) alive
  RoutingModelWrap* wrap_;
  const bool include_routes_;
  Napi::ThreadSafeFunction solution_tsfn_;
  Napi::ThreadSafeFunction progress_tsfn_;
  bool has_solution_tsfn_ = false;
  bool has_progress_tsfn_ = false;
  int live_tsfns_ = 0;  // main thread: thread-safe functions not finalized yet
  int count_ = 0;       // solving thread
  std::mutex progress_mutex_;
  ProgressSnapshot pending_progress_;  // guarded by progress_mutex_
  bool progress_queued_ = false;       // guarded by progress_mutex_
  const Assignment* result_ = nullptr;
  std::optional<CppFailure> worker_failure_;
  Napi::ObjectReference callback_error_;  // the first throw
  bool callback_failed_ = false;
  bool worker_done_ = false;
  bool settled_ = false;
};

class RoutingSolveWorker : public Napi::AsyncWorker {
 public:
  RoutingSolveWorker(Napi::Env env, std::shared_ptr<AsyncSession> session, RoutingModel* model,
                     ProgressMonitor* progress, RoutingSearchParameters parameters, const Assignment* initial)
      : Napi::AsyncWorker(env),
        session_(std::move(session)),
        model_(model),
        progress_(progress),
        parameters_(std::move(parameters)),
        initial_(initial) {}

 protected:
  void Execute() override {
    const Assignment* result = nullptr;
    std::optional<CppFailure> failure = GuardCppOffThread("solveWithParameters()", [&] {
      result = model_->SolveFromAssignmentWithParameters(initial_, parameters_);
      MaybeFailForTesting();
    });
    // Published even after a failure; the Promise settles after it is delivered.
    std::optional<CppFailure> publish_failure =
        GuardCppOffThread("solveWithParameters()", [&] { progress_->PublishFinal(); });
    if (!failure) failure = std::move(publish_failure);
    session_->SolveEnded(result, std::move(failure));
  }
  void OnOK() override { session_->WorkerDone(Env()); }

 private:
  std::shared_ptr<AsyncSession> session_;
  RoutingModel* model_;
  ProgressMonitor* progress_;
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
  teardown_watch_.reset();
  listener_ = nullptr;
  progress_->Detach();
  solve_state_.End();
  return solution == nullptr ? -1 : RecordAssignment(solution);
}

// (paramsJson, initialHandle?, options?) -> Promise<handle | null>
Napi::Value RoutingModelWrap::Solve(const Napi::CallbackInfo& info) { return StartSolve(info, true); }

// (paramsJson, initialHandle?, options?) -> handle | null
void InitRoutingSolveTesting(Napi::Env env, Napi::Object testing) {
  testing.Set("failNextRoutingSolves", Napi::Function::New(env, [](const Napi::CallbackInfo& info) {
                int64_t n;
                if (ReadIntInRange(info.Env(), info[0], 0, INT32_MAX, "n", &n)) solves_to_fail_for_testing.store(n);
                return info.Env().Undefined();
              }));
}

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
  const bool has_progress = !request.on_progress.IsEmpty();
  const absl::Duration interval = absl::Milliseconds(request.progress_interval_ms);

  if (!async) {
    SyncCallbacks callbacks(env, request, &solve_state_);
    listener_ = has_callback ? &callbacks : nullptr;
    if (has_progress) progress_->Attach(&callbacks, interval);
    solve_state_.Begin();
    const Assignment* result = nullptr;
    const bool solved = GuardCpp(env, "solveWithParametersSync()", [&] {
      result = model_->SolveFromAssignmentWithParameters(initial, request.parameters);
      MaybeFailForTesting();
    });
    // The final progress event is published even after a failure, which then
    // wins over anything the event's listener throws.
    std::optional<Napi::Error> failure;
    if (!solved) failure = env.GetAndClearPendingException();
    const bool published = GuardCpp(env, "solveWithParametersSync()", [&] { progress_->PublishFinal(); });
    int handle = -1;
    if (failure || !published) {
      FinishSolve(nullptr);
      if (failure) {
        if (env.IsExceptionPending()) env.GetAndClearPendingException();
        failure->ThrowAsJavaScriptException();
      }
      return env.Undefined();
    }
    if (!GuardCpp(env, "recording the solution", [&] { handle = FinishSolve(result); })) return env.Undefined();
    if (callbacks.RethrowIfFailed()) return env.Undefined();
    return handle >= 0 ? Napi::Value(Napi::Number::New(env, handle)) : env.Null();
  }

  std::unique_ptr<TeardownWatch> watch;
  if (!GuardCpp(env, "solveWithParameters()",
                [&] { watch = TeardownWatch::Start(env, [this] { solve_state_.RequestStop(); }); }) ||
      !watch) {
    return env.Undefined();
  }
  auto session = std::make_shared<AsyncSession>(env, info.This().As<Napi::Object>(), this, request.include_routes);
  // Unbounded queues (0): solution calls are never dropped, and at most one
  // progress call is queued at a time (AsyncSession::OnProgress).
  Napi::ThreadSafeFunction solution_tsfn;
  if (has_callback) {
    solution_tsfn = Napi::ThreadSafeFunction::New(
        env, request.on_solution, "ortools-node routing onSolution", 0, 1,
        [session](Napi::Env finalize_env) { session->CallbackFinalized(finalize_env); });
    if (env.IsExceptionPending()) return env.Undefined();
    session->AttachSolutionCallback(solution_tsfn);
  }
  if (has_progress) {
    Napi::ThreadSafeFunction tsfn = Napi::ThreadSafeFunction::New(
        env, request.on_progress, "ortools-node routing onProgress", 0, 1,
        [session](Napi::Env finalize_env) { session->CallbackFinalized(finalize_env); });
    if (env.IsExceptionPending()) {
      if (has_callback) solution_tsfn.Release();  // the solve never starts
      return env.Undefined();
    }
    session->AttachProgressCallback(tsfn);
  }
  listener_ = has_callback ? session.get() : nullptr;
  if (has_progress) progress_->Attach(session.get(), interval);
  teardown_watch_ = std::move(watch);
  solve_state_.Begin();
  auto* worker = new RoutingSolveWorker(env, session, model_.get(), progress_, request.parameters, initial);
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
  return Int64ToJsNumberOrBigInt(env, solution->ObjectiveValue());
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
  if (kind == "min") return Int64ToJsNumberOrBigInt(env, solution->Min(var));
  if (kind == "max") return Int64ToJsNumberOrBigInt(env, solution->Max(var));
  if (kind != "value") THROW_TYPE_AND_RETURN(env, "unknown solution value kind '" + kind + "'", env.Undefined());
  // As in OR-Tools (and pywrapcp), the value of a variable the solution leaves
  // as a range is its lower bound; min() / max() give the range.
  return Int64ToJsNumberOrBigInt(env, solution->Value(var));
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
      values.Set(static_cast<uint32_t>(k), Int64ToJsNumberOrBigInt(env, solution->Value(var)));
    }
    out.Set(static_cast<uint32_t>(v), values);
  }
  return out;
}

}  // namespace ortools_node
