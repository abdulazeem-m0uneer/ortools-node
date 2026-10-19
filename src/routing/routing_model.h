// RoutingModel (pywrapcp's RoutingModel) as a Node-API class.
//
// Implementation is split by responsibility:
//   routing_model.cc      lifecycle, state machine, transits, costs, variables, close
//   routing_dimension.cc  dimensions and their variables, spans and soft bounds
//   routing_rules.cc      pickup and delivery, disjunctions, vehicles, visit types,
//                         finalizers, locks and reading routes
//   routing_solve.cc      solving (sync, async, solution callbacks) and solutions
//
// State machine: OPEN -> CLOSED (closeModel, solve, readAssignmentFromRoutes).
// Model-definition calls throw once CLOSED. Every binding reads its JS
// arguments first, then checks the lifecycle, then touches the model (a getter
// met while reading may dispose or solve this model).
//
// Solutions are handles into `assignments_`; each records the generation it
// was produced in and is invalid once the generation moves on (any solve, any
// change to the model or its solver, readAssignmentFromRoutes, dispose).

#ifndef ORTOOLS_NODE_ROUTING_ROUTING_MODEL_H_
#define ORTOOLS_NODE_ROUTING_ROUTING_MODEL_H_

#include <napi.h>

#include <algorithm>
#include <cstdint>
#include <memory>
#include <string>
#include <vector>

#include "common/async_worker.h"
#include "constraint_solver/cp_context.h"
#include "routing/routing_progress.h"
#include "ortools/constraint_solver/routing.h"

namespace ortools_node {

// Registers RoutingIndexManager, RoutingModel and the routing enums.
Napi::Object InitRouting(Napi::Env env, Napi::Object exports);
// Registers native._testing.failNextRoutingSolves(n) for the test suite.
void InitRoutingSolveTesting(Napi::Env env, Napi::Object testing);

// Receives each solution found while a solve with a callback runs (any thread).
class SolutionListener {
 public:
  virtual ~SolutionListener() = default;
  virtual void OnSolution(const operations_research::RoutingModel& model) = 0;
};

class RoutingModelWrap : public Napi::ObjectWrap<RoutingModelWrap> {
 public:
  static Napi::Function Define(Napi::Env env);
  explicit RoutingModelWrap(const Napi::CallbackInfo& info);  // (manager)
  ~RoutingModelWrap() override;

  // BorrowedContextProvider for new CpSolver(routingModel).
  static std::shared_ptr<CpContext> ContextOf(Napi::Env env, const Napi::Value& value);

  // --- used by the solve worker (routing_solve.cc) ---
  operations_research::RoutingModel* model() { return model_.get(); }
  AsyncSolveState& solve_state() { return solve_state_; }
  void set_listener(SolutionListener* listener) { listener_ = listener; }
  // Ends a solve: clears the busy state and the listener, records `solution`
  // (may be null) and returns its handle, or -1.
  int FinishSolve(const operations_research::Assignment* solution);

 private:
  // --- lifecycle and state (routing_model.cc) ---
  Napi::Value Dispose(const Napi::CallbackInfo& info);
  Napi::Value IsBusy(const Napi::CallbackInfo& info);
  Napi::Value IsDisposed(const Napi::CallbackInfo& info);
  Napi::Value IsClosed(const Napi::CallbackInfo& info);
  Napi::Value Status(const Napi::CallbackInfo& info);
  Napi::Value Interrupt(const Napi::CallbackInfo& info);
  Napi::Value CloseModel(const Napi::CallbackInfo& info);  // (paramsJson?)
  Napi::Value Size(const Napi::CallbackInfo& info);
  Napi::Value Vehicles(const Napi::CallbackInfo& info);
  Napi::Value Nodes(const Napi::CallbackInfo& info);
  Napi::Value Start(const Napi::CallbackInfo& info);
  Napi::Value End(const Napi::CallbackInfo& info);
  Napi::Value IsStart(const Napi::CallbackInfo& info);
  Napi::Value IsEnd(const Napi::CallbackInfo& info);

  // --- transits and costs (routing_model.cc) ---
  Napi::Value RegisterTransitMatrix(const Napi::CallbackInfo& info);
  Napi::Value RegisterUnaryTransitVector(const Napi::CallbackInfo& info);
  Napi::Value RegisterTransitCallback(const Napi::CallbackInfo& info);
  Napi::Value RegisterUnaryTransitCallback(const Napi::CallbackInfo& info);
  Napi::Value SetArcCostEvaluatorOfAllVehicles(const Napi::CallbackInfo& info);
  Napi::Value SetArcCostEvaluatorOfVehicle(const Napi::CallbackInfo& info);
  Napi::Value SetFixedCostOfAllVehicles(const Napi::CallbackInfo& info);
  Napi::Value SetFixedCostOfVehicle(const Napi::CallbackInfo& info);

  // --- CP variables (routing_model.cc) ---
  Napi::Value NextVar(const Napi::CallbackInfo& info);
  Napi::Value VehicleVar(const Napi::CallbackInfo& info);
  Napi::Value ActiveVar(const Napi::CallbackInfo& info);
  Napi::Value CostVar(const Napi::CallbackInfo& info);

  // --- dimensions (routing_dimension.cc) ---
  Napi::Value AddDimension(const Napi::CallbackInfo& info);
  Napi::Value AddDimensionWithVehicleCapacity(const Napi::CallbackInfo& info);
  Napi::Value AddDimensionWithVehicleTransits(const Napi::CallbackInfo& info);
  Napi::Value AddDimensionWithVehicleTransitAndCapacity(const Napi::CallbackInfo& info);
  Napi::Value AddConstantDimension(const Napi::CallbackInfo& info);
  Napi::Value AddVectorDimension(const Napi::CallbackInfo& info);
  Napi::Value AddMatrixDimension(const Napi::CallbackInfo& info);
  Napi::Value HasDimension(const Napi::CallbackInfo& info);
  Napi::Value DimensionVar(const Napi::CallbackInfo& info);  // (name, 'cumul'|'slack'|'transit', index)
  Napi::Value SetSpanUpperBoundForVehicle(const Napi::CallbackInfo& info);
  Napi::Value SetSpanCostCoefficientForVehicle(const Napi::CallbackInfo& info);
  Napi::Value SetSpanCostCoefficientForAllVehicles(const Napi::CallbackInfo& info);
  Napi::Value SetGlobalSpanCostCoefficient(const Napi::CallbackInfo& info);
  Napi::Value SetCumulVarSoftBound(const Napi::CallbackInfo& info);  // (name, upper, index, bound, coef)

  // --- ride rules, finalizers, locks (routing_rules.cc) ---
  Napi::Value AddPickupAndDelivery(const Napi::CallbackInfo& info);
  Napi::Value AddPickupAndDeliverySets(const Napi::CallbackInfo& info);
  Napi::Value SetPickupAndDeliveryPolicy(const Napi::CallbackInfo& info);  // (policy, vehicle?)
  Napi::Value AddDisjunction(const Napi::CallbackInfo& info);
  Napi::Value SetAllowedVehiclesForIndex(const Napi::CallbackInfo& info);
  Napi::Value SetVisitType(const Napi::CallbackInfo& info);
  Napi::Value AddTypeIncompatibility(const Napi::CallbackInfo& info);  // (temporal, t1, t2)
  Napi::Value AddRequiredTypeAlternatives(const Napi::CallbackInfo& info);  // (whenRemoving, type, types)
  Napi::Value AddSoftSameVehicleConstraint(const Napi::CallbackInfo& info);
  Napi::Value AddSameActivityGroup(const Napi::CallbackInfo& info);
  Napi::Value AddFinalizerVariable(const Napi::CallbackInfo& info);  // (kind, var, target?)
  Napi::Value AddToAssignment(const Napi::CallbackInfo& info);
  Napi::Value ApplyLocks(const Napi::CallbackInfo& info);
  Napi::Value ApplyLocksToAllVehicles(const Napi::CallbackInfo& info);
  Napi::Value ReadAssignmentFromRoutes(const Napi::CallbackInfo& info);

  // --- solving and solutions (routing_solve.cc) ---
  Napi::Value Solve(const Napi::CallbackInfo& info);      // (paramsJson, initial, options) -> Promise
  Napi::Value SolveSync(const Napi::CallbackInfo& info);  // (paramsJson, initial, options)
  Napi::Value SolutionObjective(const Napi::CallbackInfo& info);  // (handle)
  Napi::Value SolutionValue(const Napi::CallbackInfo& info);      // (handle, var, 'value'|'min'|'max')
  Napi::Value SolutionRoutes(const Napi::CallbackInfo& info);     // (handle)
  Napi::Value SolutionDimension(const Napi::CallbackInfo& info);  // (handle, name, 'cumul'|'slack')
  Napi::Value SolutionIsValid(const Napi::CallbackInfo& info);    // (handle)

  // --- helpers (routing_model.cc) ---
  // Not disposed, not busy, no CP search open on the solver, not broken.
  bool CheckUsable(Napi::Env env) const;
  // CheckUsable() and the model is still OPEN.
  bool CheckOpen(Napi::Env env, const char* what) const;
  // Invalidates every solution handle.
  void MarkChanged() { ++generation_; }
  // Closes the model with `parameters` on the main thread, under the fail
  // intercept, unless it is closed already. Throws and returns false on failure.
  bool EnsureClosed(Napi::Env env, const operations_research::RoutingSearchParameters& parameters);
  // A valid evaluator id (phase 3).
  bool CheckEvaluator(Napi::Env env, int64_t id) const;
  void NoteEvaluator(int id) { num_evaluators_ = std::max<int64_t>(num_evaluators_, id + 1); }
  // Registers `var` in the solver's context and returns its id as a JS number.
  Napi::Value VarToJs(Napi::Env env, operations_research::IntVar* var);
  // The dimension named `name`; throws and returns null when there is none.
  operations_research::RoutingDimension* DimensionNamed(Napi::Env env, const std::string& name) const;
  // Phase 3 of the solution accessors: a valid handle's assignment, or null.
  const operations_research::Assignment* AssignmentOf(Napi::Env env, int64_t handle) const;
  int RecordAssignment(const operations_research::Assignment* assignment);
  // Shared by Solve and SolveSync.
  Napi::Value StartSolve(const Napi::CallbackInfo& info, bool async);

  struct Slot {
    const operations_research::Assignment* assignment;
    uint64_t generation;
  };

  std::unique_ptr<operations_research::RoutingModel> model_;
  std::shared_ptr<CpContext> context_;
  AsyncSolveState solve_state_;
  SolutionListener* listener_ = nullptr;
  ProgressMonitor* progress_ = nullptr;  // owned by the solver
  // Fixed when the model is built; readable after dispose.
  int64_t size_ = 0;      // RoutingModel::Size(): indices with a next variable
  int64_t vehicles_ = 0;
  int64_t nodes_ = 0;
  int64_t num_evaluators_ = 0;
  bool closed_ = false;
  bool broken_ = false;  // a CP failure while closing left the model unusable
  uint64_t generation_ = 0;
  std::vector<Slot> assignments_;
};

}  // namespace ortools_node

#endif  // ORTOOLS_NODE_ROUTING_ROUTING_MODEL_H_
