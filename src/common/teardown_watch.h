// Notices that JS can no longer run in this environment while a solve() is in
// flight, so the search can be stopped.
//
// worker.terminate() (and the end of a Worker) first waits for every pending
// threadpool task, and runs environment cleanup hooks only after that: a hook
// cannot stop a search that has no time limit. The event loop still turns
// during that wait, so a watchdog thread pings the main thread through a
// thread-safe function every 100 ms; once a probe shows that JS cannot run,
// on_teardown() is called there.

#ifndef ORTOOLS_NODE_COMMON_TEARDOWN_WATCH_H_
#define ORTOOLS_NODE_COMMON_TEARDOWN_WATCH_H_

#include <napi.h>

#include <functional>
#include <memory>

namespace ortools_node {

class TeardownWatch {
 public:
  // Main thread. Returns null with a pending JS exception on failure.
  static std::unique_ptr<TeardownWatch> Start(Napi::Env env, std::function<void()> on_teardown);
  // Main thread: stops the watchdog; on_teardown() is never called afterwards.
  ~TeardownWatch();
  TeardownWatch(const TeardownWatch&) = delete;
  TeardownWatch& operator=(const TeardownWatch&) = delete;

  struct State;  // shared with the watchdog thread and the thread-safe function

 private:
  explicit TeardownWatch(std::shared_ptr<State> state) : state_(std::move(state)) {}
  std::shared_ptr<State> state_;
};

}  // namespace ortools_node

#endif  // ORTOOLS_NODE_COMMON_TEARDOWN_WATCH_H_
