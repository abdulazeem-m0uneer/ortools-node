// Off-thread solving shared by every wrapper whose solve() returns a Promise.
//
// A wrapper keeps an AsyncSolveState: while busy, every call that touches the
// native model must throw (CheckNotBusy), so the worker thread has the model to
// itself. A PromiseWorker runs Execute() on the libuv threadpool, keeps the JS
// wrapper alive until it settles, and settles on the main thread.

#ifndef ORTOOLS_NODE_COMMON_ASYNC_WORKER_H_
#define ORTOOLS_NODE_COMMON_ASYNC_WORKER_H_

#include <napi.h>

#include <atomic>
#include <string>

#include "common/cpp_guard.h"

namespace ortools_node {

class AsyncSolveState {
 public:
  bool busy() const { return busy_; }
  // Main thread only.
  void Begin() {
    busy_ = true;
    stop_requested_.store(false);
  }
  void End() { busy_ = false; }
  // Any thread. Solvers poll it through their own limit hooks.
  void RequestStop() { stop_requested_.store(true); }
  bool stop_requested() const { return stop_requested_.load(); }
  std::atomic<bool>* stop_flag() { return &stop_requested_; }

 private:
  bool busy_ = false;
  std::atomic<bool> stop_requested_{false};
};

// Throws "<what> is busy: a solve() is in progress" and returns false while busy.
inline bool CheckNotBusy(Napi::Env env, const AsyncSolveState& state, const char* what) {
  if (!state.busy()) return true;
  Napi::Error::New(env, std::string(what) + " is busy: a solve() is in progress").ThrowAsJavaScriptException();
  return false;
}

class PromiseWorker : public Napi::AsyncWorker {
 public:
  // `owner` is kept alive (and with it the native model) until the Promise settles.
  PromiseWorker(Napi::Env env, Napi::Object owner)
      : Napi::AsyncWorker(env), deferred_(Napi::Promise::Deferred::New(env)), owner_(Napi::Persistent(owner)) {}

  Napi::Promise Promise() { return deferred_.Promise(); }

 protected:
  // Main thread, before the Promise settles; `succeeded` is false when Execute()
  // called SetError(). Typically ends the wrapper's AsyncSolveState.
  virtual void Finish(bool succeeded) {}
  // Main thread, after a successful Execute(): the resolution value. Throwing a
  // JS exception here rejects the Promise with it instead.
  virtual Napi::Value Result(Napi::Env env) = 0;

  void OnOK() override {
    Finish(true);
    Napi::Env env = Env();
    Napi::Value value = Result(env);
    if (env.IsExceptionPending()) {
      deferred_.Reject(env.GetAndClearPendingException().Value());
    } else {
      deferred_.Resolve(value);
    }
  }

  // SetError() messages from GuardCppOffThread() that report out-of-memory
  // reject with a RangeError, matching GuardCpp() on the main thread.
  void OnError(const Napi::Error& error) override {
    Finish(false);
    const std::string message = error.Message();
    const std::string suffix(kOutOfMemorySuffix);
    const bool out_of_memory =
        message.size() >= suffix.size() && message.compare(message.size() - suffix.size(), suffix.size(), suffix) == 0;
    deferred_.Reject(out_of_memory ? Napi::RangeError::New(Env(), message).Value() : error.Value());
  }

 private:
  Napi::Promise::Deferred deferred_;
  Napi::ObjectReference owner_;
};

}  // namespace ortools_node

#endif  // ORTOOLS_NODE_COMMON_ASYNC_WORKER_H_
