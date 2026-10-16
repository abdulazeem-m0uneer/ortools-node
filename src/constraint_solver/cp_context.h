// State shared by a CP Solver and every JS handle into it.
//
// A CpContext either owns an operations_research::Solver (new CpSolver()) or
// borrows the one owned by a RoutingModel (model.solver()). JS refers to the
// solver's objects by integer ids into the registries below; the objects
// themselves are owned by the Solver, so ids stay valid for its lifetime.
//
// Every binding works in three phases (a JS getter or Proxy met while reading
// arguments can run user code that disposes or solves this very solver):
//   1. read and convert all JS arguments (ReadId / ReadIdArray, int64 helpers);
//   2. check the lifecycle (CheckUsable / CheckMutable);
//   3. resolve ids to OR-Tools pointers (ExprById...) and call OR-Tools, guarded.
//
// Safety rules enforced here, because OR-Tools aborts the process otherwise:
// * Solver::Fail() outside a search CHECK-fails or longjmps; every call that
//   can fail runs under a fail intercept that turns it into a JS Error.
// * Allocating while a search is open is fatal ("allocating at a leaf node")
//   or leaves dangling pointers after backtracking, so building and mutating
//   calls throw while a search is open.

#ifndef ORTOOLS_NODE_CONSTRAINT_SOLVER_CP_CONTEXT_H_
#define ORTOOLS_NODE_CONSTRAINT_SOLVER_CP_CONTEXT_H_

#include <napi.h>

#include <atomic>
#include <cstdint>
#include <functional>
#include <memory>
#include <string>
#include <unordered_map>
#include <vector>

#include "common/async_worker.h"
#include "common/cpp_guard.h"
#include "ortools/constraint_solver/constraint_solver.h"

namespace ortools_node {

// Thrown by the fail intercept; never escapes RunGuarded().
struct CpFailure {};

class CpContext {
 public:
  struct MonitorEntry {
    operations_research::SearchMonitor* monitor;
    operations_research::SolutionCollector* collector;  // null unless a collector
    bool needs_objective;                                // best-value collectors
    bool has_objective;
    std::vector<operations_research::IntVar*> vars;      // collected variables
  };

  // A context that owns a new Solver.
  explicit CpContext(const std::string& name);
  // A context over a Solver owned elsewhere (a RoutingModel), whose busy state
  // is `owner_state`. The owner calls Detach() before freeing the Solver.
  CpContext(operations_research::Solver* borrowed, AsyncSolveState* owner_state, std::string owner_name);
  ~CpContext();

  CpContext(const CpContext&) = delete;
  CpContext& operator=(const CpContext&) = delete;

  operations_research::Solver* solver() const { return solver_; }
  bool owns_solver() const { return owned_ != nullptr; }
  // Frees an owned Solver, or forgets a borrowed one; every later call throws.
  void Detach();

  AsyncSolveState& solve_state() { return *state_; }
  // Cooperative stop flag polled by the interrupt limit of every CP search.
  std::atomic<bool>* stop_flag() { return &stop_; }

  // Throws unless the solver is alive and no async solve is running.
  bool CheckUsable(Napi::Env env) const;
  // CheckUsable() and no search open: required to build or change the model.
  bool CheckMutable(Napi::Env env) const;
  bool search_open() const { return search_open_; }
  void set_search_open(bool open) { search_open_ = open; }
  bool in_native_search() const { return in_native_search_; }
  void set_in_native_search(bool in) { in_native_search_ = in; }

  // Called after anything that changes the model (routing invalidates its
  // solutions through it).
  void set_on_mutation(std::function<void()> hook) { on_mutation_ = std::move(hook); }
  void NotifyMutation() const {
    if (on_mutation_) on_mutation_();
  }

  // Runs `f` (no JS access inside) with Solver::Fail() turned into a C++
  // exception and any other C++ exception caught by GuardCpp(); on failure
  // throws a JS Error naming `what` and returns false. Not for searches, which
  // backtrack through Fail().
  template <typename F>
  bool RunGuarded(Napi::Env env, const char* what, F&& f) {
    try {
      FailInterceptScope scope(solver_);
      return GuardCpp(env, what, f);
    } catch (const CpFailure&) {
      ThrowFailure(env, what);
      return false;
    }
  }

  // --- registries (phase 3: no JS access) -----------------------------------
  int RegisterExpr(operations_research::IntExpr* expr);
  // Resolve ids read with ReadId(); throw a RangeError and return null when invalid.
  operations_research::IntExpr* ExprById(Napi::Env env, uint32_t id, const char* what) const;
  // A variable (not just an expression).
  operations_research::IntVar* VarById(Napi::Env env, uint32_t id, const char* what) const;
  // An expression as a variable, casting a non-variable expression (allocates:
  // only while mutable).
  operations_research::IntVar* VarOrCastById(Napi::Env env, uint32_t id, const char* what);
  bool ExprsById(Napi::Env env, const std::vector<uint32_t>& ids, const char* what,
                 std::vector<operations_research::IntExpr*>* out) const;
  bool VarsOrCastById(Napi::Env env, const std::vector<uint32_t>& ids, const char* what,
                      std::vector<operations_research::IntVar*>* out);

  int RegisterConstraint(operations_research::Constraint* ct);
  operations_research::Constraint* ConstraintById(Napi::Env env, uint32_t id) const;

  int RegisterDecisionBuilder(operations_research::DecisionBuilder* db);
  operations_research::DecisionBuilder* DecisionBuilderById(Napi::Env env, uint32_t id) const;

  int RegisterMonitor(MonitorEntry entry);
  MonitorEntry* MonitorById(Napi::Env env, uint32_t id);
  MonitorEntry* CollectorById(Napi::Env env, uint32_t id);

  // The interrupt limit (created on first use, so only while mutable).
  operations_research::SearchMonitor* InterruptLimit();

 private:
  class FailInterceptScope {
   public:
    explicit FailInterceptScope(operations_research::Solver* s) : solver_(s) {
      solver_->set_fail_intercept([] { throw CpFailure{}; });
    }
    ~FailInterceptScope() { solver_->clear_fail_intercept(); }
    FailInterceptScope(const FailInterceptScope&) = delete;
    FailInterceptScope& operator=(const FailInterceptScope&) = delete;

   private:
    operations_research::Solver* solver_;
  };

  static void ThrowFailure(Napi::Env env, const char* what);
  void ClearRegistries();

  std::unique_ptr<operations_research::Solver> owned_;
  operations_research::Solver* solver_ = nullptr;
  AsyncSolveState own_state_;
  AsyncSolveState* state_;
  std::string owner_name_;
  std::atomic<bool> stop_{false};
  bool search_open_ = false;
  bool in_native_search_ = false;
  std::function<void()> on_mutation_;

  std::vector<operations_research::IntExpr*> exprs_;
  std::unordered_map<operations_research::IntExpr*, int> expr_ids_;
  std::vector<operations_research::Constraint*> constraints_;
  std::vector<operations_research::DecisionBuilder*> decision_builders_;
  std::vector<MonitorEntry> monitors_;
  operations_research::SearchMonitor* interrupt_limit_ = nullptr;
};

// Phase 1 helpers: read a handle id (a non-negative integer), or an array of them.
bool ReadId(Napi::Env env, const Napi::Value& v, const char* what, uint32_t* out);
bool ReadIdArray(Napi::Env env, const Napi::Value& v, const char* what, std::vector<uint32_t>* out);

// Components that own a Solver (RoutingModel) register how to get the context
// of one of their JS objects, so `new CpSolver(owner)` can wrap that Solver.
// The provider throws and returns null when `owner` is not one of its objects.
using BorrowedContextProvider = std::shared_ptr<CpContext> (*)(Napi::Env env, const Napi::Value& owner);
void SetBorrowedContextProvider(BorrowedContextProvider provider);
std::shared_ptr<CpContext> BorrowContext(Napi::Env env, const Napi::Value& owner);

}  // namespace ortools_node

#endif  // ORTOOLS_NODE_CONSTRAINT_SOLVER_CP_CONTEXT_H_
