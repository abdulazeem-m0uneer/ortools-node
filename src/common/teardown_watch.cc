#include "common/teardown_watch.h"

#include <chrono>
#include <condition_variable>
#include <mutex>
#include <thread>
#include <utility>

namespace ortools_node {
namespace {

constexpr std::chrono::milliseconds kPingInterval(100);

// A Node-API call that may run JS fails, without a pending exception, once
// the environment is shutting down. Defining an own data property on a fresh
// object takes that path but, unlike a [[Set]], never calls user JS (such as
// a setter on Object.prototype). Nothing the probe leaves pending may escape.
bool CanRunJs(napi_env env) {
  napi_handle_scope scope;
  if (napi_open_handle_scope(env, &scope) != napi_ok) return false;
  napi_value object;
  napi_value value;
  bool ok = napi_create_object(env, &object) == napi_ok && napi_get_boolean(env, true, &value) == napi_ok;
  if (ok) {
    const napi_property_descriptor probe = {"probe", nullptr, nullptr, nullptr, nullptr, value, napi_default, nullptr};
    ok = napi_define_properties(env, object, 1, &probe) == napi_ok;
  }
  napi_value exception;
  napi_get_and_clear_last_exception(env, &exception);
  napi_close_handle_scope(env, scope);
  return ok;
}

}  // namespace

struct TeardownWatch::State {
  static void Ping(Napi::Env env, Napi::Function, State* state, std::nullptr_t*);
  static void Finalize(Napi::Env, std::shared_ptr<State>* self_ref, State*) { delete self_ref; }
  using Tsfn = Napi::TypedThreadSafeFunction<State, std::nullptr_t, &State::Ping>;

  std::function<void()> on_teardown;  // main thread only
  bool stopped = false;               // main thread only
  bool fired = false;                 // main thread only
  Tsfn tsfn;

  std::mutex mutex;
  std::condition_variable wake;
  bool done = false;     // guarded by mutex: ends the watchdog thread
  bool closing = false;  // guarded by mutex: Node closed the thread-safe function; never touch it again
};

void TeardownWatch::State::Ping(Napi::Env env, Napi::Function, State* state, std::nullptr_t*) {
  if (env == nullptr || state->stopped || state->fired || CanRunJs(env)) return;
  state->fired = true;
  state->on_teardown();
}

std::unique_ptr<TeardownWatch> TeardownWatch::Start(Napi::Env env, std::function<void()> on_teardown) {
  auto state = std::make_shared<State>();
  state->on_teardown = std::move(on_teardown);
  auto* self_ref = new std::shared_ptr<State>(state);
  state->tsfn = State::Tsfn::New(env, "ortools-node:teardownWatch", /*maxQueueSize=*/0, /*initialThreadCount=*/1,
                                 state.get(), &State::Finalize, self_ref);
  if (env.IsExceptionPending()) {
    delete self_ref;
    return nullptr;
  }
  state->tsfn.Unref(env);  // the solve itself keeps the event loop alive
  // The thread only pings; the main thread releases the thread-safe function
  // (~TeardownWatch), before environment cleanup could free it.
  std::thread([state] {
    std::unique_lock<std::mutex> lock(state->mutex);
    while (!state->wake.wait_for(lock, kPingInterval, [&] { return state->done; })) {
      if (state->tsfn.NonBlockingCall() != napi_ok) {
        state->closing = true;
        return;
      }
    }
  }).detach();
  return std::unique_ptr<TeardownWatch>(new TeardownWatch(std::move(state)));
}

TeardownWatch::~TeardownWatch() {
  state_->stopped = true;
  std::lock_guard<std::mutex> lock(state_->mutex);
  state_->done = true;
  state_->wake.notify_all();
  if (!state_->closing) state_->tsfn.Release();
}

}  // namespace ortools_node
