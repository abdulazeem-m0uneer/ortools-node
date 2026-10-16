#include "sat/solution_channel.h"

#include "common/cpp_guard.h"

#include <algorithm>
#include <cstring>
#include <utility>

namespace ortools_node {

using operations_research::sat::CpSolverResponse;

namespace {

constexpr int64_t kMaxSafeInteger = 9007199254740991;  // 2^53 - 1

bool IsSafeInteger(int64_t v) { return v >= -kMaxSafeInteger && v <= kMaxSafeInteger; }

// The functions below use the plain C API and return its status: while a
// worker thread is terminated, calls that may run JS fail, and node-addon-api
// would turn such a failure into a fatal error.

napi_status ValuesToTypedArray(napi_env env, const std::vector<int64_t>& values, napi_value* out) {
  const size_t n = values.size();
  const bool safe = std::all_of(values.begin(), values.end(), IsSafeInteger);
  void* data = nullptr;
  napi_value buffer;
  napi_status status = napi_create_arraybuffer(env, n * sizeof(int64_t), &data, &buffer);
  if (status != napi_ok) return status;
  if (safe) {
    double* doubles = static_cast<double*>(data);
    for (size_t i = 0; i < n; ++i) doubles[i] = static_cast<double>(values[i]);
  } else if (n > 0) {
    std::memcpy(data, values.data(), n * sizeof(int64_t));
  }
  return napi_create_typedarray(env, safe ? napi_float64_array : napi_bigint64_array, n, buffer, 0, out);
}

napi_status SnapshotToJs(napi_env env, const SolutionSnapshot& snapshot, napi_value* out) {
  napi_status status = napi_create_object(env, out);
  const std::pair<const char*, double> numbers[] = {
      {"objectiveValue", snapshot.objective_value},
      {"bestObjectiveBound", snapshot.best_objective_bound},
      {"wallTime", snapshot.wall_time},
      {"userTime", snapshot.user_time},
      {"deterministicTime", snapshot.deterministic_time},
      {"solutionIndex", static_cast<double>(snapshot.solution_index)},
  };
  for (const auto& [name, number] : numbers) {
    napi_value value;
    if (status == napi_ok) status = napi_create_double(env, number, &value);
    if (status == napi_ok) status = napi_set_named_property(env, *out, name, value);
  }
  napi_value values;
  if (status == napi_ok) status = ValuesToTypedArray(env, snapshot.values, &values);
  if (status == napi_ok) status = napi_set_named_property(env, *out, "values", values);
  return status;
}

}  // namespace

Napi::Value SolutionValuesToJs(Napi::Env env, const std::vector<int64_t>& values) {
  napi_value array;
  NAPI_THROW_IF_FAILED(env, ValuesToTypedArray(env, values, &array), Napi::Value());
  return Napi::Value(env, array);
}

SolutionChannel::SolutionChannel(Napi::Env env, Napi::Function callback, std::atomic<bool>* stop_flag)
    : tsfn_(Tsfn::New(env, callback, "ortools-node:cpSatSolution", /*maxQueueSize=*/0, /*initialThreadCount=*/1,
                      this)),
      stop_flag_(stop_flag) {}

SolutionChannel::~SolutionChannel() { Release(); }

void SolutionChannel::Publish(const CpSolverResponse& response) {
  if (callback_failed_.load()) return;
  // An exception must not escape into a CP-SAT worker thread (std::terminate).
  auto failure = GuardCppOffThread("onSolution", [&] { Deliver(response); });
  if (!failure) return;
  std::lock_guard<std::mutex> lock(mutex_);
  native_failure_ = std::move(failure->message);
  callback_failed_.store(true);
  stop_flag_->store(true);
}

void SolutionChannel::Deliver(const CpSolverResponse& response) {
  SolutionSnapshot snapshot;
  snapshot.objective_value = response.objective_value();
  snapshot.best_objective_bound = response.best_objective_bound();
  snapshot.wall_time = response.wall_time();
  snapshot.user_time = response.user_time();
  snapshot.deterministic_time = response.deterministic_time();
  snapshot.solution_index = solution_count_.fetch_add(1);
  snapshot.values.assign(response.solution().begin(), response.solution().end());

  std::unique_lock<std::mutex> lock(mutex_);
  if (released_) return;
  // Once queued, CallJs always runs (with a null env if the environment shuts
  // down), so waiting for it is safe and `snapshot` outlives its use.
  if (tsfn_.NonBlockingCall(&snapshot) != napi_ok) return;
  const int64_t ticket = ++queued_;
  delivered_cv_.wait(lock, [this, ticket] { return delivered_ >= ticket; });
}

void SolutionChannel::Release() {
  std::lock_guard<std::mutex> lock(mutex_);
  if (released_) return;
  released_ = true;
  tsfn_.Release();
}

void SolutionChannel::MarkDelivered() {
  std::lock_guard<std::mutex> lock(mutex_);
  ++delivered_;
  delivered_cv_.notify_all();
}

// Main thread. `env` is null while the environment shuts down: the waiting
// solver thread is only released then.
void SolutionChannel::CallJs(Napi::Env env, Napi::Function callback, SolutionChannel* self,
                             SolutionSnapshot* snapshot) {
  if (env != nullptr && !self->callback_failed_.load()) self->CallCallback(env, callback, *snapshot);
  self->MarkDelivered();
}

void SolutionChannel::CallCallback(Napi::Env env, Napi::Function callback, const SolutionSnapshot& snapshot) {
  napi_value js_snapshot;
  napi_status status = SnapshotToJs(env, snapshot, &js_snapshot);
  if (status == napi_ok) {
    napi_value result;
    status = napi_call_function(env, env.Undefined(), callback, 1, &js_snapshot, &result);
  }
  if (status == napi_ok) return;
  // Either the callback threw, or the environment is shutting down and JS
  // cannot run (no pending exception then). Both end the search.
  callback_failed_.store(true);
  stop_flag_->store(true);
  bool pending = false;
  napi_value error;
  if (napi_is_exception_pending(env, &pending) != napi_ok || !pending) return;
  if (napi_get_and_clear_last_exception(env, &error) != napi_ok) return;
  napi_value holder;
  if (napi_create_object(env, &holder) != napi_ok || napi_set_named_property(env, holder, "error", error) != napi_ok) {
    return;
  }
  error_holder_ = Napi::Persistent(Napi::Object(env, holder));
}

bool SolutionChannel::ThrowCallbackError(Napi::Env env) {
  if (!callback_failed_.load()) return false;
  if (error_holder_.IsEmpty()) {
    // Main thread after the solve: no solver thread writes native_failure_ any more.
    const std::string message = native_failure_.empty() ? "The onSolution callback could not run" : native_failure_;
    Napi::Error::New(env, message).ThrowAsJavaScriptException();
  } else {
    napi_throw(env, error_holder_.Value().Get("error"));
  }
  return true;
}

}  // namespace ortools_node
