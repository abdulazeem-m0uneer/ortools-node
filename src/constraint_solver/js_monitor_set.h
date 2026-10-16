// JS objects used as search monitors of one synchronous CP search.

#ifndef ORTOOLS_NODE_CONSTRAINT_SOLVER_JS_MONITOR_SET_H_
#define ORTOOLS_NODE_CONSTRAINT_SOLVER_JS_MONITOR_SET_H_

#include <napi.h>

#include <memory>
#include <vector>

#include "constraint_solver/cp_context.h"
#include "ortools/constraint_solver/constraint_solver.h"

namespace ortools_node {

class JsMonitorSet {
 public:
  JsMonitorSet(Napi::Env env, CpContext* context);
  ~JsMonitorSet();
  JsMonitorSet(const JsMonitorSet&) = delete;
  JsMonitorSet& operator=(const JsMonitorSet&) = delete;

  // Phase 1: reads an array of monitor objects. Throws and returns false on bad input.
  bool Read(const Napi::Value& objects);
  // Phase 3: creates the OR-Tools monitors (after the lifecycle checks) and
  // appends them to `monitors`.
  void AppendTo(std::vector<operations_research::SearchMonitor*>* monitors);

  // Calls objects[method](); returns the result, or an empty value when the
  // method is missing, an earlier callback threw, or the set is disabled.
  Napi::Value Invoke(const Napi::ObjectReference& object, const char* method);
  // Stops calling JS (used when the search is ended from a finalizer).
  void Disable() { disabled_ = true; }
  bool failed() const { return failed_; }
  // Throws the recorded error, if any, and returns true.
  bool RethrowIfFailed(Napi::Env env);

 private:
  class Monitor;

  Napi::Env env_;
  CpContext* context_;
  std::vector<Napi::ObjectReference> objects_;
  std::vector<std::unique_ptr<Monitor>> monitors_;
  Napi::ObjectReference error_;  // {error: <the thrown value>}
  bool failed_ = false;
  bool disabled_ = false;
};

}  // namespace ortools_node

#endif  // ORTOOLS_NODE_CONSTRAINT_SOLVER_JS_MONITOR_SET_H_
