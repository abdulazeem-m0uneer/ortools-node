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
#include <mutex>
#include <string>
#include <vector>

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

class SolutionChannel {
 public:
  // Main thread. `callback` receives one plain object per solution; `stop_flag`
  // is the solve's stop flag, raised when the callback throws.
  SolutionChannel(Napi::Env env, Napi::Function callback, std::atomic<bool>* stop_flag);
  ~SolutionChannel();
  SolutionChannel(const SolutionChannel&) = delete;
  SolutionChannel& operator=(const SolutionChannel&) = delete;

  // Solver threads: passes a snapshot of `response` to the callback and waits
  // until it ran. Does nothing once the callback has failed. Never throws.
  void Publish(const operations_research::sat::CpSolverResponse& response);

  // Any thread, once the solve returned: releases the thread-safe function.
  void Release();

  // Main thread, after the solve: when the callback failed, makes its exception
  // the pending JS exception and returns true.
  bool ThrowCallbackError(Napi::Env env);

 private:
  static void CallJs(Napi::Env env, Napi::Function callback, SolutionChannel* self, SolutionSnapshot* snapshot);
  void Deliver(const operations_research::sat::CpSolverResponse& response);  // solver thread; may throw
  void CallCallback(Napi::Env env, Napi::Function callback, const SolutionSnapshot& snapshot);
  void MarkDelivered();

  using Tsfn = Napi::TypedThreadSafeFunction<SolutionChannel, SolutionSnapshot, &SolutionChannel::CallJs>;
  Tsfn tsfn_;
  bool released_ = false;  // guarded by mutex_
  std::atomic<bool>* stop_flag_;
  std::atomic<bool> callback_failed_{false};
  std::atomic<int64_t> solution_count_{0};

  std::mutex mutex_;
  std::condition_variable delivered_cv_;
  int64_t queued_ = 0;     // guarded by mutex_; snapshots are delivered in queue order
  int64_t delivered_ = 0;  // guarded by mutex_
  std::string native_failure_;  // guarded by mutex_: a C++ exception while publishing

  // Main thread only: { error } holding the value the callback threw (a holder
  // object, since a reference to a primitive needs Node-API 10).
  Napi::ObjectReference error_holder_;
};

}  // namespace ortools_node

#endif  // ORTOOLS_NODE_SAT_SOLUTION_CHANNEL_H_
