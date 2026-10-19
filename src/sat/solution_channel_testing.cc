// native._testing hooks for test/sat_callback.test.js: publishSolutionFailure
// proves a C++ exception while a solution is being delivered rejects the way
// RunGuarded() does (no real solve can make the delivery itself run out of
// memory); solutionChannelStats / resetSolutionChannelStats read the
// SolutionChannel::Stats counters.

#include "sat/solution_channel_testing.h"

#include <atomic>
#include <new>
#include <stdexcept>
#include <string>

#include "common/napi_util.h"
#include "sat/solution_channel.h"

namespace ortools_node {

void InitSolutionChannelTesting(Napi::Env env, Napi::Object testing) {
  // 'bad_alloc' and 'runtime' make the delivery throw the matching C++
  // exception, 'ok' returns normally. Throws what solve() would reject with,
  // else returns whether the search was told to stop.
  testing.Set("publishSolutionFailure", Napi::Function::New(env, [](const Napi::CallbackInfo& info) -> Napi::Value {
    Napi::Env env = info.Env();
    if (!info[0].IsString()) THROW_TYPE_AND_RETURN(env, "kind must be a string", env.Undefined());
    const std::string kind = info[0].As<Napi::String>().Utf8Value();
    // Static: the channel lives on until its thread-safe function is finalized.
    static std::atomic<bool> stop_flag;
    stop_flag.store(false);
    auto channel = SolutionChannel::Create(env, Napi::Function::New(env, [](const Napi::CallbackInfo&) {}), &stop_flag);
    if (!channel) return env.Undefined();
    channel->PublishWith([&] {
      if (kind == "bad_alloc") throw std::bad_alloc();
      if (kind == "runtime") throw std::runtime_error("boom");
    });
    channel->Release();
    if (channel->ThrowCallbackError(env)) return env.Undefined();
    return Napi::Boolean::New(env, stop_flag.load());
  }));
  // { issued, delivered, maxPending } since the last reset.
  testing.Set("solutionChannelStats", Napi::Function::New(env, [](const Napi::CallbackInfo& info) -> Napi::Value {
    const SolutionChannel::Stats stats = SolutionChannel::TestingStats();
    Napi::Object out = Napi::Object::New(info.Env());
    out.Set("issued", Napi::Number::New(info.Env(), static_cast<double>(stats.issued)));
    out.Set("delivered", Napi::Number::New(info.Env(), static_cast<double>(stats.delivered)));
    out.Set("maxPending", Napi::Number::New(info.Env(), static_cast<double>(stats.max_pending)));
    return out;
  }));
  testing.Set("resetSolutionChannelStats", Napi::Function::New(env, [](const Napi::CallbackInfo& info) -> Napi::Value {
    SolutionChannel::ResetTestingStats();
    return info.Env().Undefined();
  }));
}

}  // namespace ortools_node
