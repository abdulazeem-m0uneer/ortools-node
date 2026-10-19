// JsMonitorSet: plain JS objects as OR-Tools search monitors (see the header).
//
// Every hook runs inside its own HandleScope: a search may call beginFail()
// millions of times within one solve() call. Decisions reach JS as their
// DebugString(), never as native objects, so nothing can outlive the search.

#include "constraint_solver/js_monitor_set.h"

#include <napi.h>

#include <iterator>
#include <string>
#include <utility>
#include <vector>

#include "common/napi_util.h"

namespace ortools_node {

using operations_research::Decision;
using operations_research::DecisionBuilder;
using operations_research::SearchMonitor;
using operations_research::Solver;

namespace {

// Indexed by JsHook.
constexpr const char* kJsHookNames[] = {
    "enterSearch",
    "exitSearch",
    "beginNextDecision",
    "endNextDecision",
    "applyDecision",
    "refuteDecision",
    "afterDecision",
    "beginFail",
    "endFail",
    "beginInitialPropagation",
    "endInitialPropagation",
    "acceptSolution",
    "atSolution",
    "noMoreSolutions",
};
static_assert(std::size(kJsHookNames) == static_cast<size_t>(JsHook::kCount), "one name per JsHook");

std::vector<napi_value> DecisionArgs(Napi::Env env, const Decision* decision) {
  if (decision == nullptr) return {env.Null()};
  return {Napi::String::New(env, decision->DebugString())};
}

}  // namespace

class JsMonitorSet::Monitor : public SearchMonitor {
 public:
  Monitor(Solver* solver, JsMonitorSet* set, const Entry* entry) : SearchMonitor(solver), set_(set), entry_(entry) {}

  void EnterSearch() override { Call(JsHook::kEnterSearch); }
  void ExitSearch() override { Call(JsHook::kExitSearch); }
  void BeginNextDecision(DecisionBuilder*) override { Call(JsHook::kBeginNextDecision); }
  void EndNextDecision(DecisionBuilder*, Decision* d) override {
    Call(JsHook::kEndNextDecision, [d](Napi::Env env) { return DecisionArgs(env, d); });
  }
  void ApplyDecision(Decision* d) override {
    Call(JsHook::kApplyDecision, [d](Napi::Env env) { return DecisionArgs(env, d); });
  }
  void RefuteDecision(Decision* d) override {
    Call(JsHook::kRefuteDecision, [d](Napi::Env env) { return DecisionArgs(env, d); });
  }
  void AfterDecision(Decision* d, bool apply) override {
    Call(JsHook::kAfterDecision, [d, apply](Napi::Env env) {
      std::vector<napi_value> args = DecisionArgs(env, d);
      args.push_back(Napi::Boolean::New(env, apply));
      return args;
    });
  }
  void BeginFail() override { Call(JsHook::kBeginFail); }
  void EndFail() override { Call(JsHook::kEndFail); }
  void BeginInitialPropagation() override { Call(JsHook::kBeginInitialPropagation); }
  void EndInitialPropagation() override { Call(JsHook::kEndInitialPropagation); }
  void NoMoreSolutions() override { Call(JsHook::kNoMoreSolutions); }

  // Only `false` rejects the solution. Once any hook has thrown, every
  // solution is rejected, so that no other monitor (a collector) records one
  // before the interrupt limit stops the search.
  bool AcceptSolution() override {
    if (set_->failed_) return false;
    if (!Has(JsHook::kAcceptSolution)) return true;
    Napi::HandleScope scope(set_->env_);
    Napi::Value result = set_->Invoke(*entry_, JsHook::kAcceptSolution);
    if (result.IsEmpty()) return !set_->failed_;
    return !result.IsBoolean() || result.As<Napi::Boolean>().Value();
  }
  // `true` asks for more solutions, `false` stops the search, anything else
  // leaves the decision to the other monitors.
  bool AtSolution() override {
    if (!Has(JsHook::kAtSolution)) return false;
    Napi::HandleScope scope(set_->env_);
    Napi::Value result = set_->Invoke(*entry_, JsHook::kAtSolution);
    if (result.IsEmpty() || !result.IsBoolean()) return false;
    if (!result.As<Napi::Boolean>().Value()) {
      // Not FinishCurrentSearch(): its flag outlives the search and would end
      // the next one at its first failure. The interrupt limit stops cleanly.
      set_->context_->stop_flag()->store(true);
      return false;
    }
    return true;
  }
  std::string DebugString() const override { return "JsSearchMonitor"; }

 private:
  bool Has(JsHook hook) const {
    return !set_->failed_ && !set_->disabled_ && !entry_->hooks[static_cast<size_t>(hook)].IsEmpty();
  }
  template <typename MakeArgs>
  void Call(JsHook hook, MakeArgs&& make_args) {
    if (!Has(hook)) return;  // the common case: no HandleScope, no JS
    Napi::HandleScope scope(set_->env_);
    set_->Invoke(*entry_, hook, std::forward<MakeArgs>(make_args));
  }
  void Call(JsHook hook) {
    Call(hook, [](Napi::Env) { return std::vector<napi_value>(); });
  }

  JsMonitorSet* set_;
  const Entry* entry_;  // owned by the set
};

JsMonitorSet::JsMonitorSet(Napi::Env env, CpContext* context) : env_(env), context_(context) {}
JsMonitorSet::~JsMonitorSet() = default;

bool JsMonitorSet::Read(const Napi::Value& objects) {
  if (objects.IsUndefined()) return true;
  if (!objects.IsArray()) THROW_TYPE_AND_RETURN(env_, "JS search monitors must be an array", false);
  Napi::Array array = objects.As<Napi::Array>();
  const uint32_t n = array.Length();
  if (env_.IsExceptionPending()) return false;
  entries_.reserve(n);
  for (uint32_t i = 0; i < n; ++i) {
    Napi::HandleScope scope(env_);
    Napi::Value v = array.Get(i);
    if (env_.IsExceptionPending()) return false;
    if (!v.IsObject()) THROW_TYPE_AND_RETURN(env_, "a JS search monitor must be an object", false);
    Napi::Object object = v.As<Napi::Object>();
    Entry entry;
    entry.object = Napi::Persistent(object);
    for (size_t h = 0; h < entry.hooks.size(); ++h) {
      Napi::Value fn = object.Get(kJsHookNames[h]);  // may run a getter
      if (env_.IsExceptionPending()) return false;
      if (fn.IsUndefined()) continue;
      if (!fn.IsFunction()) {
        THROW_TYPE_AND_RETURN(env_, std::string("search monitor hook '") + kJsHookNames[h] + "' must be a function",
                              false);
      }
      entry.hooks[h] = Napi::Persistent(fn.As<Napi::Function>());
    }
    entries_.push_back(std::move(entry));
  }
  return true;
}

void JsMonitorSet::AppendTo(std::vector<SearchMonitor*>* monitors) {
  // entries_ is never resized after Read(), so the pointers below stay valid.
  for (const Entry& entry : entries_) {
    monitors_.push_back(std::make_unique<Monitor>(context_->solver(), this, &entry));
    monitors->push_back(monitors_.back().get());
  }
}

Napi::Value JsMonitorSet::Invoke(const Entry& entry, JsHook hook) {
  return Invoke(entry, hook, [](Napi::Env) { return std::vector<napi_value>(); });
}

template <typename MakeArgs>
Napi::Value JsMonitorSet::Invoke(const Entry& entry, JsHook hook, MakeArgs&& make_args) {
  const Napi::FunctionReference& fn = entry.hooks[static_cast<size_t>(hook)];
  if (failed_ || disabled_ || fn.IsEmpty()) return Napi::Value();
  Napi::EscapableHandleScope scope(env_);
  const std::vector<napi_value> args = make_args(env_);
  Napi::Value result = fn.Value().Call(entry.object.Value(), args);
  // An empty result without a pending exception: the call could not run (the
  // environment is shutting down, e.g. worker.terminate()).
  if (env_.IsExceptionPending() || result.IsEmpty()) {
    failed_ = true;
    context_->stop_flag()->store(true);  // stop at the next limit check
    if (env_.IsExceptionPending()) {
      napi_value error;
      napi_get_and_clear_last_exception(env_, &error);
      // References to primitives need Node-API 9: hold the thrown value in an object.
      Napi::Object holder = Napi::Object::New(env_);
      holder.Set("error", Napi::Value(env_, error));
      error_ = Napi::Persistent(holder);
    }
    return Napi::Value();
  }
  return scope.Escape(result);
}

bool JsMonitorSet::RethrowIfFailed(Napi::Env env) {
  if (!failed_) return false;
  if (error_.IsEmpty()) {
    Napi::Error::New(env, "a JS search monitor could not be called").ThrowAsJavaScriptException();
  } else {
    napi_throw(env, error_.Value().Get("error"));
  }
  return true;
}

}  // namespace ortools_node
