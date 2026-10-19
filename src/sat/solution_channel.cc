#include "sat/solution_channel.h"

#include <algorithm>
#include <atomic>
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

// SolutionChannel::Stats, process-wide (test-only).
std::atomic<int64_t> g_issued{0};
std::atomic<int64_t> g_delivered{0};
std::atomic<int64_t> g_max_pending{0};

void RaiseMaxPending(int64_t pending) {
  int64_t seen = g_max_pending.load();
  while (pending > seen && !g_max_pending.compare_exchange_weak(seen, pending)) {
  }
}

}  // namespace

SolutionChannel::Stats SolutionChannel::TestingStats() {
  return {g_issued.load(), g_delivered.load(), g_max_pending.load()};
}

void SolutionChannel::ResetTestingStats() {
  g_issued.store(0);
  g_delivered.store(0);
  g_max_pending.store(0);
}

Napi::Value SolutionValuesToJs(Napi::Env env, const std::vector<int64_t>& values) {
  napi_value array;
  NAPI_THROW_IF_FAILED(env, ValuesToTypedArray(env, values, &array), Napi::Value());
  return Napi::Value(env, array);
}

std::shared_ptr<SolutionChannel> SolutionChannel::Create(Napi::Env env, Napi::Function callback,
                                                         std::atomic<bool>* stop_flag) {
  auto channel = std::make_shared<SolutionChannel>(stop_flag);
  // The thread-safe function owns a reference, dropped by Finalize().
  auto* self_ref = new std::shared_ptr<SolutionChannel>(channel);
  channel->tsfn_ = Tsfn::New(env, callback, "ortools-node:cpSatSolution", /*maxQueueSize=*/0,
                             /*initialThreadCount=*/1, channel.get(), &SolutionChannel::Finalize, self_ref);
  if (env.IsExceptionPending()) {
    delete self_ref;
    channel->released_ = true;  // nothing to release
    return nullptr;
  }
  return channel;
}

void SolutionChannel::Finalize(Napi::Env, std::shared_ptr<SolutionChannel>* self_ref, SolutionChannel*) {
  delete self_ref;
}

SolutionChannel::~SolutionChannel() { Release(); }

void SolutionChannel::Publish(const CpSolverResponse& response) {
  PublishWith([&] { Deliver(response); });
}

void SolutionChannel::RecordFailure(CppFailure failure) {
  std::lock_guard<std::mutex> lock(mutex_);
  native_failure_ = std::move(failure);
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
  if (released_ || abandoned_) return;
  // CallJs owns the snapshot: the wait below may end (Abandon) before it runs.
  auto* queued = new SolutionSnapshot(std::move(snapshot));
  if (tsfn_.NonBlockingCall(queued) != napi_ok) {
    delete queued;
    released_ = true;  // Node is closing it: it must not be used, nor released, again
    return;
  }
  const int64_t ticket = ++queued_;
  g_issued.fetch_add(1);
  RaiseMaxPending(queued_ - delivered_);
  delivered_cv_.wait(lock, [this, ticket] { return delivered_ >= ticket || abandoned_; });
}

void SolutionChannel::Abandon() {
  std::lock_guard<std::mutex> lock(mutex_);
  abandoned_ = true;
  callback_failed_.store(true);
  stop_flag_->store(true);
  delivered_cv_.notify_all();
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
  g_delivered.fetch_add(1);
  delivered_cv_.notify_all();
}

// Main thread. `env` is null while the environment shuts down: the snapshot
// is only freed then.
void SolutionChannel::CallJs(Napi::Env env, Napi::Function callback, SolutionChannel* self,
                             SolutionSnapshot* snapshot) {
  std::unique_ptr<SolutionSnapshot> owned(snapshot);
  if (env != nullptr && !self->callback_failed_.load()) self->CallCallback(env, callback, *owned);
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
    const std::string message =
        native_failure_.message.empty() ? "The onSolution callback could not run" : native_failure_.message;
    if (native_failure_.out_of_memory) {
      Napi::RangeError::New(env, message).ThrowAsJavaScriptException();
    } else {
      Napi::Error::New(env, message).ThrowAsJavaScriptException();
    }
  } else {
    napi_throw(env, error_holder_.Value().Get("error"));
  }
  return true;
}

}  // namespace ortools_node
