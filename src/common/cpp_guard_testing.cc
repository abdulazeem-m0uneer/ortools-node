// native._testing hooks that prove C++ exceptions become JS errors (test/cpp_guard.test.js).

#include "common/cpp_guard_testing.h"

#include <new>
#include <stdexcept>
#include <string>

#include "common/async_worker.h"
#include "common/cpp_guard.h"

namespace ortools_node {
namespace {

// 'ok' returns normally, 'bad_alloc' and 'runtime' throw the matching C++ exception.
void Raise(const std::string& kind) {
  if (kind == "bad_alloc") throw std::bad_alloc();
  if (kind == "runtime") throw std::runtime_error("boom");
}

class GuardWorker : public PromiseWorker {
 public:
  GuardWorker(Napi::Env env, Napi::Object owner, std::string kind) : PromiseWorker(env, owner), kind_(std::move(kind)) {}

 protected:
  void Execute() override {
    RunGuarded("guardCppAsync", [this] { Raise(kind_); });
  }
  Napi::Value Result(Napi::Env env) override { return Napi::String::New(env, "ok"); }

 private:
  std::string kind_;
};

}  // namespace

void InitCppGuardTesting(Napi::Env env, Napi::Object testing) {
  testing.Set("guardCpp", Napi::Function::New(env, [](const Napi::CallbackInfo& info) -> Napi::Value {
    const std::string kind = info[0].ToString().Utf8Value();
    if (!GuardCpp(info.Env(), "guardCpp", [&] { Raise(kind); })) return info.Env().Undefined();
    return Napi::String::New(info.Env(), "ok");
  }));
  testing.Set("guardCppAsync", Napi::Function::New(env, [](const Napi::CallbackInfo& info) -> Napi::Value {
    auto* worker = new GuardWorker(info.Env(), info.This().As<Napi::Object>(), info[0].ToString().Utf8Value());
    worker->Queue();
    return worker->Promise();
  }));
}

}  // namespace ortools_node
