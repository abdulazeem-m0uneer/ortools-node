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
#include <utility>

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
  // Execute() only: runs f() under GuardCppOffThread(); a C++ exception rejects
  // the Promise with a RangeError (out of memory) or Error naming `what`.
  template <typename F>
  void RunGuarded(const char* what, F&& f) {
    if (auto failure = GuardCppOffThread(what, std::forward<F>(f))) {
      failure_ = std::move(*failure);
      Napi::AsyncWorker::SetError(failure_.message);
    }
  }

  // Main thread, before the Promise settles; `succeeded` is false when
  // RunGuarded() caught a C++ exception. Typically ends the wrapper's AsyncSolveState.
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

  // Rejects from the C++ failure RunGuarded() recorded, never by reading the
  // JS `error` back: in an exiting worker JS can no longer run, and only the
  // settle call itself may fail there (swallowed, as on the OnOK() path; see
  // NODE_API_SWALLOW_UNTHROWABLE_EXCEPTIONS in CMakeLists.txt).
  void OnError(const Napi::Error&) override {
    Finish(false);
    Napi::Env env = Env();
    deferred_.Reject(failure_.out_of_memory ? Napi::RangeError::New(env, failure_.message).Value()
                                            : Napi::Error::New(env, failure_.message).Value());
  }

 private:
  // Subclasses fail through RunGuarded(), which records the failure OnError() needs.
  using Napi::AsyncWorker::SetError;

  Napi::Promise::Deferred deferred_;
  CppFailure failure_;
  Napi::ObjectReference owner_;
};

}  // namespace ortools_node

#endif  // ORTOOLS_NODE_COMMON_ASYNC_WORKER_H_
