// Delivers the solutions CP-SAT finds on its worker threads to a JS callback.
//
// The solution observer runs on solver threads. Like Python's solution
// callback, it waits until the JS callback has run on the main thread, so a
// stopSearch() from inside the callback takes effect before the next solution
// and no callback can run after the solve returns. A callback that throws stops
// the search; its exception is kept for the solve() Promise to reject with.

#ifndef ORTOOLS_NODE_SAT_SOLUTION_CHANNEL_H_
#define ORTOOLS_NODE_SAT_SOLUTION_CHANNEL_H_

#include <napi.h>

#include <atomic>
#include <condition_variable>
#include <cstdint>
#include <memory>
#include <mutex>
#include <string>
#include <utility>
#include <vector>

#include "common/cpp_guard.h"
#include "ortools/sat/cp_model.pb.h"

namespace ortools_node {

struct SolutionSnapshot {
  double objective_value = 0;
  double best_objective_bound = 0;
  double wall_time = 0;
  double user_time = 0;
  double deterministic_time = 0;
  int64_t solution_index = 0;
  std::vector<int64_t> values;
};

// Solution values as a Float64Array when every value is a safe integer (the
// usual case), otherwise as a BigInt64Array, so no value is ever rounded.
Napi::Value SolutionValuesToJs(Napi::Env env, const std::vector<int64_t>& values);

// Shared by the solve worker and the thread-safe function: the channel lives
// until both are done, so a snapshot still queued at teardown never reaches a
// freed channel.
class SolutionChannel : public std::enable_shared_from_this<SolutionChannel> {
 public:
  // Main thread. `callback` receives one plain object per solution; `stop_flag`
  // is the solve's stop flag, raised when the callback throws. Returns null
  // with a pending JS exception when the thread-safe function cannot be made.
  static std::shared_ptr<SolutionChannel> Create(Napi::Env env, Napi::Function callback,
                                                 std::atomic<bool>* stop_flag);
  explicit SolutionChannel(std::atomic<bool>* stop_flag) : stop_flag_(stop_flag) {}
  ~SolutionChannel();
  SolutionChannel(const SolutionChannel&) = delete;
  SolutionChannel& operator=(const SolutionChannel&) = delete;

  // Solver threads: passes a snapshot of `response` to the callback and waits
  // until it ran. Does nothing once the callback has failed. Never throws.
  void Publish(const operations_research::sat::CpSolverResponse& response);

  // Publish() with `deliver` in place of the delivery itself (the test hooks
  // pass one that throws): a C++ exception from it ends the search, and
  // ThrowCallbackError() reports it. Never throws.
  template <typename F>
  void PublishWith(F&& deliver) {
    if (callback_failed_.load()) return;
    // An exception must not escape into a CP-SAT worker thread (std::terminate).
    if (auto failure = GuardCppOffThread("onSolution", std::forward<F>(deliver))) RecordFailure(std::move(*failure));
  }

  // Any thread, once the solve returned: releases the thread-safe function.
  void Release();

  // Main thread, when JS can no longer run (process exit, environment
  // teardown): stops the search and releases every solver thread waiting for a
  // callback; later solutions are dropped.
  void Abandon();

  // Main thread, after the solve: when the callback failed, makes its exception
  // the pending JS exception and returns true.
  bool ThrowCallbackError(Napi::Env env);

 private:
  static void CallJs(Napi::Env env, Napi::Function callback, SolutionChannel* self, SolutionSnapshot* snapshot);
  void Deliver(const operations_research::sat::CpSolverResponse& response);  // solver thread; may throw
  void CallCallback(Napi::Env env, Napi::Function callback, const SolutionSnapshot& snapshot);
  void MarkDelivered();
  void RecordFailure(CppFailure failure);  // any thread
  static void Finalize(Napi::Env env, std::shared_ptr<SolutionChannel>* self_ref, SolutionChannel* self);

  using Tsfn = Napi::TypedThreadSafeFunction<SolutionChannel, SolutionSnapshot, &SolutionChannel::CallJs>;
  Tsfn tsfn_;
  bool released_ = false;   // guarded by mutex_
  bool abandoned_ = false;  // guarded by mutex_
  std::atomic<bool>* stop_flag_;
  std::atomic<bool> callback_failed_{false};
  std::atomic<int64_t> solution_count_{0};

  std::mutex mutex_;
  std::condition_variable delivered_cv_;
  int64_t queued_ = 0;     // guarded by mutex_; snapshots are delivered in queue order
  int64_t delivered_ = 0;  // guarded by mutex_
  CppFailure native_failure_;  // guarded by mutex_: a C++ exception while publishing

  // Main thread only: { error } holding the value the callback threw (a holder
  // object, since a reference to a primitive needs Node-API 10).
  Napi::ObjectReference error_holder_;
};

}  // namespace ortools_node

#endif  // ORTOOLS_NODE_SAT_SOLUTION_CHANNEL_H_
