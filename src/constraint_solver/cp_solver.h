// The classic CP solver (pywrapcp's Solver) as a Node-API class.
//
// Implementation is split by responsibility:
//   cp_solver.cc  class registration, lifetime, variable operations, stats
//   cp_model.cc   expressions and constraints
//   cp_search.cc  decision builders, monitors, limits, collectors, searches

#ifndef ORTOOLS_NODE_CONSTRAINT_SOLVER_CP_SOLVER_H_
#define ORTOOLS_NODE_CONSTRAINT_SOLVER_CP_SOLVER_H_

#include <napi.h>

#include <memory>

#include "constraint_solver/cp_context.h"
#include "constraint_solver/js_monitor_set.h"

namespace ortools_node {

// Registers the native `CpSolver` class.
Napi::Object InitCpSolver(Napi::Env env, Napi::Object exports);


class CpSolver : public Napi::ObjectWrap<CpSolver> {
 public:
  static Napi::Function Define(Napi::Env env);
  // new CpSolver(name?: string) owns a new Solver; new CpSolver(routingModel)
  // wraps the Solver of that native RoutingModel.
  explicit CpSolver(const Napi::CallbackInfo& info);
  ~CpSolver() override;

  CpContext& context() { return *context_; }

 private:
  // --- lifetime, stats (cp_solver.cc) ---
  Napi::Value Dispose(const Napi::CallbackInfo& info);
  Napi::Value IsBusy(const Napi::CallbackInfo& info);
  Napi::Value IsDisposed(const Napi::CallbackInfo& info);
  Napi::Value WallTime(const Napi::CallbackInfo& info);
  Napi::Value Branches(const Napi::CallbackInfo& info);
  Napi::Value Failures(const Napi::CallbackInfo& info);
  Napi::Value Solutions(const Napi::CallbackInfo& info);

  // --- variables and expression bounds (cp_solver.cc) ---
  Napi::Value NewIntVar(const Napi::CallbackInfo& info);            // (min, max, name) -> id
  Napi::Value NewIntVarFromValues(const Napi::CallbackInfo& info);  // (values, name) -> id
  Napi::Value NewBoolVar(const Napi::CallbackInfo& info);           // (name) -> id
  Napi::Value NewIntConst(const Napi::CallbackInfo& info);          // (value) -> id
  Napi::Value ExprMin(const Napi::CallbackInfo& info);
  Napi::Value ExprMax(const Napi::CallbackInfo& info);
  Napi::Value ExprBound(const Napi::CallbackInfo& info);
  Napi::Value ExprIsVar(const Napi::CallbackInfo& info);
  Napi::Value ExprSetMin(const Napi::CallbackInfo& info);
  Napi::Value ExprSetMax(const Napi::CallbackInfo& info);
  Napi::Value ExprSetRange(const Napi::CallbackInfo& info);
  Napi::Value ExprSetValue(const Napi::CallbackInfo& info);
  Napi::Value ExprToVar(const Napi::CallbackInfo& info);
  Napi::Value VarValue(const Napi::CallbackInfo& info);
  Napi::Value VarRemoveValue(const Napi::CallbackInfo& info);
  Napi::Value VarRemoveValues(const Napi::CallbackInfo& info);
  Napi::Value VarContains(const Napi::CallbackInfo& info);
  Napi::Value VarSize(const Napi::CallbackInfo& info);
  Napi::Value VarName(const Napi::CallbackInfo& info);

  // --- expressions and constraints (cp_model.cc) ---
  Napi::Value Sum(const Napi::CallbackInfo& info);          // (ids) -> id
  Napi::Value ScalProd(const Napi::CallbackInfo& info);     // (ids, coefs) -> id
  Napi::Value Binary(const Napi::CallbackInfo& info);       // (op, a, b) -> id
  Napi::Value BinaryConst(const Napi::CallbackInfo& info);  // (op, a, c) -> id
  Napi::Value Unary(const Napi::CallbackInfo& info);        // (op, a) -> id
  Napi::Value MinMaxArray(const Napi::CallbackInfo& info);  // (isMax, ids) -> id
  Napi::Value ElementValues(const Napi::CallbackInfo& info);  // (values, index) -> id
  Napi::Value ElementVars(const Napi::CallbackInfo& info);    // (ids, index) -> id
  Napi::Value Compare(const Napi::CallbackInfo& info);        // (op, a, b) -> constraint id
  Napi::Value CompareConst(const Napi::CallbackInfo& info);   // (op, a, c) -> constraint id
  Napi::Value IsCompareVar(const Napi::CallbackInfo& info);   // (op, a, b) -> var id
  Napi::Value IsCompareConstVar(const Napi::CallbackInfo& info);  // (op, a, c) -> var id
  Napi::Value AllDifferent(const Napi::CallbackInfo& info);       // (ids) -> constraint id
  Napi::Value AllowedAssignments(const Napi::CallbackInfo& info);  // (ids, tuples) -> constraint id
  Napi::Value Member(const Napi::CallbackInfo& info);              // (kind, id, values) -> id
  Napi::Value Add(const Napi::CallbackInfo& info);                 // (constraint id)

  // --- search (cp_search.cc) ---
  Napi::Value Phase(const Napi::CallbackInfo& info);     // (ids, varStrategy, valueStrategy) -> db id
  Napi::Value Compose(const Napi::CallbackInfo& info);   // (db ids) -> db id
  Napi::Value Optimize(const Napi::CallbackInfo& info);  // (maximize, id, step) -> monitor id
  Napi::Value Limit(const Napi::CallbackInfo& info);     // (timeMs, branches, failures, solutions, smart, cumulative)
  Napi::Value SearchLog(const Napi::CallbackInfo& info);  // (period, id?) -> monitor id
  Napi::Value Collector(const Napi::CallbackInfo& info);  // (kind, maximize?) -> monitor id
  Napi::Value CollectorAdd(const Napi::CallbackInfo& info);           // (monitor, ids)
  Napi::Value CollectorAddObjective(const Napi::CallbackInfo& info);  // (monitor, id)
  Napi::Value CollectorCount(const Napi::CallbackInfo& info);
  Napi::Value CollectorValue(const Napi::CallbackInfo& info);      // (monitor, n, varId)
  Napi::Value CollectorStat(const Napi::CallbackInfo& info);       // (monitor, stat, n)
  Napi::Value NewSearch(const Napi::CallbackInfo& info);     // (db, monitorIds, jsMonitors)
  Napi::Value NextSolution(const Napi::CallbackInfo& info);  // () -> bool
  Napi::Value EndSearch(const Napi::CallbackInfo& info);
  Napi::Value Solve(const Napi::CallbackInfo& info);       // (db, monitorIds, jsMonitors) -> bool
  Napi::Value SolveAsync(const Napi::CallbackInfo& info);  // (db, monitorIds) -> Promise<bool>
  Napi::Value Interrupt(const Napi::CallbackInfo& info);

  // Ends the open newSearch() and hands back its JS monitors.
  std::unique_ptr<JsMonitorSet> CloseOpenSearch();

  // Leaves a JS exception pending and returns false when `this` is unusable.
  bool CheckUsable(Napi::Env env) const { return context_->CheckUsable(env); }
  bool CheckMutable(Napi::Env env) const { return context_->CheckMutable(env); }

  std::shared_ptr<CpContext> context_;
  // The JS monitors of the open newSearch(), released by endSearch().
  std::unique_ptr<JsMonitorSet> open_search_monitors_;
  // The native RoutingModel whose Solver this wraps, kept alive with it.
  Napi::ObjectReference owner_;
};

}  // namespace ortools_node

#endif  // ORTOOLS_NODE_CONSTRAINT_SOLVER_CP_SOLVER_H_
