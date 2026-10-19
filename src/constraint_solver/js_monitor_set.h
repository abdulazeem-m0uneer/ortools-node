// JS objects used as search monitors of one synchronous CP search.
//
// A JS monitor is a plain object with any of the JsHook hooks (OR-Tools'
// SearchMonitor methods, camelCased; names in js_monitor_set.cc). The hooks are
// read once, when the search starts, and called synchronously from inside the
// search on the main thread. A throw is recorded, no hook runs after it, the
// search is stopped through the interrupt limit, and the error is rethrown once
// OR-Tools has unwound.

#ifndef ORTOOLS_NODE_CONSTRAINT_SOLVER_JS_MONITOR_SET_H_
#define ORTOOLS_NODE_CONSTRAINT_SOLVER_JS_MONITOR_SET_H_

#include <napi.h>

#include <array>
#include <cstddef>
#include <memory>
#include <vector>

#include "constraint_solver/cp_context.h"
#include "ortools/constraint_solver/constraint_solver.h"

namespace ortools_node {

enum class JsHook : size_t {
  kEnterSearch,
  kExitSearch,
  kBeginNextDecision,
  kEndNextDecision,
  kApplyDecision,
  kRefuteDecision,
  kAfterDecision,
  kBeginFail,
  kEndFail,
  kBeginInitialPropagation,
  kEndInitialPropagation,
  kAcceptSolution,
  kAtSolution,
  kNoMoreSolutions,
  kCount,
};

class JsMonitorSet {
 public:
  JsMonitorSet(Napi::Env env, CpContext* context);
  ~JsMonitorSet();
  JsMonitorSet(const JsMonitorSet&) = delete;
  JsMonitorSet& operator=(const JsMonitorSet&) = delete;

  // Phase 1: reads an array of monitor objects and their hooks. Throws and
  // returns false on bad input or a throwing getter.
  bool Read(const Napi::Value& objects);
  // Phase 3: creates the OR-Tools monitors (after the lifecycle checks) and
  // appends them to `monitors`.
  void AppendTo(std::vector<operations_research::SearchMonitor*>* monitors);

  // Stops calling JS (used when the search is ended from a finalizer).
  void Disable() { disabled_ = true; }
  bool failed() const { return failed_; }
  // Throws the recorded error, if any, and returns true.
  bool RethrowIfFailed(Napi::Env env);

 private:
  class Monitor;
  struct Entry {
    Napi::ObjectReference object;
    std::array<Napi::FunctionReference, static_cast<size_t>(JsHook::kCount)> hooks;
  };

  // Calls entry.object[hook](...args) and returns the result, or an empty
  // value when the hook is missing, an earlier hook threw, or the set is
  // disabled. The arguments are built only when the hook is called.
  template <typename MakeArgs>
  Napi::Value Invoke(const Entry& entry, JsHook hook, MakeArgs&& make_args);
  Napi::Value Invoke(const Entry& entry, JsHook hook);

  Napi::Env env_;
  CpContext* context_;
  std::vector<Entry> entries_;
  std::vector<std::unique_ptr<Monitor>> monitors_;
  Napi::ObjectReference error_;  // {error: <the thrown value>}
  bool failed_ = false;
  bool disabled_ = false;
};

}  // namespace ortools_node

#endif  // ORTOOLS_NODE_CONSTRAINT_SOLVER_JS_MONITOR_SET_H_
