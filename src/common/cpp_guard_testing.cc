// native._testing hooks that prove C++ exceptions become JS errors (test/cpp_guard.test.js).

#include "common/cpp_guard_testing.h"

#include <new>
#include <stdexcept>
#include <string>
#include <type_traits>

#include "common/async_worker.h"
#include "common/cpp_guard.h"
#include "common/napi_util.h"

namespace ortools_node {
namespace {

// 'ok' returns normally, 'bad_alloc' and 'runtime' throw the matching C++ exception
// ('fail', 'fail_oom' and 'fail_empty' are handled by GuardWorker without one).
void Raise(const std::string& kind) {
  if (kind == "bad_alloc") throw std::bad_alloc();
  if (kind == "runtime") throw std::runtime_error("boom");
}

class GuardWorker : public PromiseWorker {
 public:
  GuardWorker(Napi::Env env, Napi::Object owner, std::string kind) : PromiseWorker(env, owner), kind_(std::move(kind)) {}

 protected:
  void Execute() override {
    if (kind_ == "fail") return Fail("custom message");
    if (kind_ == "fail_oom") return Fail("custom out of memory", true);
    if (kind_ == "fail_empty") return Fail("");
    RunGuarded("guardCppAsync", [this] { Raise(kind_); });
  }
  Napi::Value Result(Napi::Env env) override { return Napi::String::New(env, "ok"); }

 private:
  std::string kind_;
};

// Pins that subclasses cannot bypass Fail() with AsyncWorker::SetError(), which
// would reject with an empty Error.
static_assert(!std::is_convertible_v<GuardWorker*, Napi::AsyncWorker*>, "PromiseWorker must inherit AsyncWorker privately");

}  // namespace

void InitCppGuardTesting(Napi::Env env, Napi::Object testing) {
  testing.Set("guardCpp", Napi::Function::New(env, [](const Napi::CallbackInfo& info) -> Napi::Value {
    if (!info[0].IsString()) THROW_TYPE_AND_RETURN(info.Env(), "kind must be a string", info.Env().Undefined());
    const std::string kind = info[0].As<Napi::String>().Utf8Value();
    if (!GuardCpp(info.Env(), "guardCpp", [&] { Raise(kind); })) return info.Env().Undefined();
    return Napi::String::New(info.Env(), "ok");
  }));
  testing.Set("guardCppAsync", Napi::Function::New(env, [](const Napi::CallbackInfo& info) -> Napi::Value {
    if (!info[0].IsString()) THROW_TYPE_AND_RETURN(info.Env(), "kind must be a string", info.Env().Undefined());
    auto* worker = new GuardWorker(info.Env(), info.This().As<Napi::Object>(), info[0].As<Napi::String>().Utf8Value());
    worker->Queue();
    return worker->Promise();
  }));
}

}  // namespace ortools_node
