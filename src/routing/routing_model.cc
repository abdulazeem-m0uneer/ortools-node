// RoutingModel: registration, lifecycle, state machine, transits, costs,
// variables and closing. See routing_model.h for the overall design.

#include "routing/routing_model.h"

#include <napi.h>

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <limits>
#include <memory>
#include <string>
#include <utility>
#include <vector>

#include "common/cpp_guard.h"
#include "common/int64.h"
#include "common/napi_util.h"
#include "ortools/constraint_solver/routing_enums.pb.h"
#include "ortools/constraint_solver/routing_parameters.h"
#include "routing/index_manager.h"
#include "routing/routing_guards.h"
#include "routing/search_parameters.h"

namespace ortools_node {

using operations_research::Assignment;
using operations_research::IntVar;
using operations_research::RoutingModel;
using operations_research::RoutingSearchParameters;

namespace {

constexpr napi_type_tag kRoutingModelTag = {0x2f6b8e1c9d0a4b77ULL, 0xa3c51e7d08f2946bULL};
constexpr int64_t kMaxInt = std::numeric_limits<int32_t>::max();
// registerTransitCallback() stores one int64 per pair of indices: cap it at
// 2^28 values (2 GiB) so an absurd size is a RangeError, not an abort.
constexpr int64_t kMaxEagerTransitIndices = 16384;

RoutingModel::TransitEvaluatorSign SignOf(const std::vector<int64_t>& values) {
  const bool non_negative = std::all_of(values.begin(), values.end(), [](int64_t v) { return v >= 0; });
  if (non_negative) return RoutingModel::kTransitEvaluatorSignPositiveOrZero;
  const bool non_positive = std::all_of(values.begin(), values.end(), [](int64_t v) { return v <= 0; });
  return non_positive ? RoutingModel::kTransitEvaluatorSignNegativeOrZero
                      : RoutingModel::kTransitEvaluatorSignUnknown;
}

constexpr double kMaxSafeInteger = 9007199254740991.0;  // 2^53 - 1

// Calls fn(args...) and reads an int64 result (±Infinity allowed). The user
// function may throw or return anything; both become JS errors. `describe`
// names the call in the error and only runs on failure (this is a hot loop).
template <typename Describe>
bool CallForInt64(Napi::Env env, const Napi::Function& fn, std::initializer_list<napi_value> args,
                  Describe describe, int64_t* out) {
  Napi::Value result = fn.Call(env.Undefined(), args);
  if (env.IsExceptionPending()) return false;
  if (result.IsNumber()) {
    const double d = result.As<Napi::Number>().DoubleValue();
    if (d == std::floor(d) && std::fabs(d) <= kMaxSafeInteger) {
      *out = static_cast<int64_t>(d);
      return true;
    }
  }
  return ReadInt64(env, result, true, describe().c_str(), out);
}

}  // namespace

// ---------------------------------------------------------------------------
// Registration and lifecycle
// ---------------------------------------------------------------------------

Napi::Function RoutingModelWrap::Define(Napi::Env env) {
  return DefineClass(env, "RoutingModel", {
      InstanceMethod("dispose", &RoutingModelWrap::Dispose),
      InstanceMethod("isBusy", &RoutingModelWrap::IsBusy),
      InstanceMethod("isDisposed", &RoutingModelWrap::IsDisposed),
      InstanceMethod("isClosed", &RoutingModelWrap::IsClosed),
      InstanceMethod("status", &RoutingModelWrap::Status),
      InstanceMethod("interrupt", &RoutingModelWrap::Interrupt),
      InstanceMethod("closeModel", &RoutingModelWrap::CloseModel),
      InstanceMethod("size", &RoutingModelWrap::Size),
      InstanceMethod("vehicles", &RoutingModelWrap::Vehicles),
      InstanceMethod("nodes", &RoutingModelWrap::Nodes),
      InstanceMethod("start", &RoutingModelWrap::Start),
      InstanceMethod("end", &RoutingModelWrap::End),
      InstanceMethod("isStart", &RoutingModelWrap::IsStart),
      InstanceMethod("isEnd", &RoutingModelWrap::IsEnd),

      InstanceMethod("registerTransitMatrix", &RoutingModelWrap::RegisterTransitMatrix),
      InstanceMethod("registerUnaryTransitVector", &RoutingModelWrap::RegisterUnaryTransitVector),
      InstanceMethod("registerTransitCallback", &RoutingModelWrap::RegisterTransitCallback),
      InstanceMethod("registerUnaryTransitCallback", &RoutingModelWrap::RegisterUnaryTransitCallback),
      InstanceMethod("setArcCostEvaluatorOfAllVehicles", &RoutingModelWrap::SetArcCostEvaluatorOfAllVehicles),
      InstanceMethod("setArcCostEvaluatorOfVehicle", &RoutingModelWrap::SetArcCostEvaluatorOfVehicle),
      InstanceMethod("setFixedCostOfAllVehicles", &RoutingModelWrap::SetFixedCostOfAllVehicles),
      InstanceMethod("setFixedCostOfVehicle", &RoutingModelWrap::SetFixedCostOfVehicle),

      InstanceMethod("nextVar", &RoutingModelWrap::NextVar),
      InstanceMethod("vehicleVar", &RoutingModelWrap::VehicleVar),
      InstanceMethod("activeVar", &RoutingModelWrap::ActiveVar),
      InstanceMethod("costVar", &RoutingModelWrap::CostVar),

      InstanceMethod("addDimension", &RoutingModelWrap::AddDimension),
      InstanceMethod("addDimensionWithVehicleCapacity", &RoutingModelWrap::AddDimensionWithVehicleCapacity),
      InstanceMethod("addDimensionWithVehicleTransits", &RoutingModelWrap::AddDimensionWithVehicleTransits),
      InstanceMethod("addDimensionWithVehicleTransitAndCapacity",
                     &RoutingModelWrap::AddDimensionWithVehicleTransitAndCapacity),
      InstanceMethod("addConstantDimension", &RoutingModelWrap::AddConstantDimension),
      InstanceMethod("addVectorDimension", &RoutingModelWrap::AddVectorDimension),
      InstanceMethod("addMatrixDimension", &RoutingModelWrap::AddMatrixDimension),
      InstanceMethod("hasDimension", &RoutingModelWrap::HasDimension),
      InstanceMethod("dimensionVar", &RoutingModelWrap::DimensionVar),
      InstanceMethod("setSpanUpperBoundForVehicle", &RoutingModelWrap::SetSpanUpperBoundForVehicle),
      InstanceMethod("setSpanCostCoefficientForVehicle", &RoutingModelWrap::SetSpanCostCoefficientForVehicle),
      InstanceMethod("setSpanCostCoefficientForAllVehicles",
                     &RoutingModelWrap::SetSpanCostCoefficientForAllVehicles),
      InstanceMethod("setGlobalSpanCostCoefficient", &RoutingModelWrap::SetGlobalSpanCostCoefficient),
      InstanceMethod("setCumulVarSoftBound", &RoutingModelWrap::SetCumulVarSoftBound),

      InstanceMethod("addPickupAndDelivery", &RoutingModelWrap::AddPickupAndDelivery),
      InstanceMethod("addPickupAndDeliverySets", &RoutingModelWrap::AddPickupAndDeliverySets),
      InstanceMethod("setPickupAndDeliveryPolicy", &RoutingModelWrap::SetPickupAndDeliveryPolicy),
      InstanceMethod("addDisjunction", &RoutingModelWrap::AddDisjunction),
      InstanceMethod("setAllowedVehiclesForIndex", &RoutingModelWrap::SetAllowedVehiclesForIndex),
      InstanceMethod("setVisitType", &RoutingModelWrap::SetVisitType),
      InstanceMethod("addTypeIncompatibility", &RoutingModelWrap::AddTypeIncompatibility),
      InstanceMethod("addRequiredTypeAlternatives", &RoutingModelWrap::AddRequiredTypeAlternatives),
      InstanceMethod("addSoftSameVehicleConstraint", &RoutingModelWrap::AddSoftSameVehicleConstraint),
      InstanceMethod("addSameActivityGroup", &RoutingModelWrap::AddSameActivityGroup),
      InstanceMethod("addFinalizerVariable", &RoutingModelWrap::AddFinalizerVariable),
      InstanceMethod("addToAssignment", &RoutingModelWrap::AddToAssignment),
      InstanceMethod("applyLocks", &RoutingModelWrap::ApplyLocks),
      InstanceMethod("applyLocksToAllVehicles", &RoutingModelWrap::ApplyLocksToAllVehicles),
      InstanceMethod("readAssignmentFromRoutes", &RoutingModelWrap::ReadAssignmentFromRoutes),

      InstanceMethod("solve", &RoutingModelWrap::Solve),
      InstanceMethod("solveSync", &RoutingModelWrap::SolveSync),
      InstanceMethod("solutionObjective", &RoutingModelWrap::SolutionObjective),
      InstanceMethod("solutionValue", &RoutingModelWrap::SolutionValue),
      InstanceMethod("solutionRoutes", &RoutingModelWrap::SolutionRoutes),
      InstanceMethod("solutionDimension", &RoutingModelWrap::SolutionDimension),
      InstanceMethod("solutionIsValid", &RoutingModelWrap::SolutionIsValid),
  });
}

Napi::Object InitRouting(Napi::Env env, Napi::Object exports) {
  exports.Set("RoutingIndexManager", IndexManager::Define(env));
  exports.Set("RoutingModel", RoutingModelWrap::Define(env));
  SetBorrowedContextProvider(&RoutingModelWrap::ContextOf);
  return exports;
}

RoutingModelWrap::RoutingModelWrap(const Napi::CallbackInfo& info) : Napi::ObjectWrap<RoutingModelWrap>(info) {
  Napi::Env env = info.Env();
  const operations_research::RoutingIndexManager* manager = IndexManager::FromValue(env, info[0]);
  if (manager == nullptr) return;
  if (!GuardCpp(env, "new RoutingModel()", [&] {
        model_ = std::make_unique<RoutingModel>(*manager);
        // The interrupt limit and the solution hook must be in place before the
        // model closes; both stay idle unless a solve asks for them.
        AsyncSolveState* state = &solve_state_;
        model_->AddSearchMonitor(model_->solver()->MakeCustomLimit([state] { return state->stop_requested(); }));
        model_->AddAtSolutionCallback([this] {
          if (listener_ != nullptr) listener_->OnSolution(*model_);
        });
        context_ = std::make_shared<CpContext>(model_->solver(), &solve_state_, "RoutingModel");
      })) {
    model_.reset();
    return;
  }
  context_->set_on_mutation([this] { MarkChanged(); });
  size_ = model_->Size();
  vehicles_ = model_->vehicles();
  nodes_ = model_->nodes();
  info.This().As<Napi::Object>().TypeTag(&kRoutingModelTag);
}

RoutingModelWrap::~RoutingModelWrap() {
  if (context_) context_->Detach();
}

std::shared_ptr<CpContext> RoutingModelWrap::ContextOf(Napi::Env env, const Napi::Value& value) {
  if (!value.IsObject() || !value.As<Napi::Object>().CheckTypeTag(&kRoutingModelTag)) {
    Napi::TypeError::New(env, "new CpSolver(name?: string)").ThrowAsJavaScriptException();
    return nullptr;
  }
  RoutingModelWrap* wrap = Unwrap(value.As<Napi::Object>());
  if (!wrap->model_) {
    Napi::Error::New(env, "RoutingModel has been disposed").ThrowAsJavaScriptException();
    return nullptr;
  }
  return wrap->context_;
}

bool RoutingModelWrap::CheckUsable(Napi::Env env) const {
  if (!model_) THROW_AND_RETURN(env, "RoutingModel has been disposed", false);
  if (!CheckNotBusy(env, solve_state_, "RoutingModel")) return false;
  if (context_->search_open()) {
    THROW_AND_RETURN(env, "RoutingModel is in use by a search on its solver (call endSearch() first)", false);
  }
  if (broken_) {
    THROW_AND_RETURN(env, "RoutingModel is unusable: closing it failed with a CP solver failure", false);
  }
  return true;
}

bool RoutingModelWrap::CheckOpen(Napi::Env env, const char* what) const {
  if (!CheckUsable(env)) return false;
  if (closed_) {
    THROW_AND_RETURN(env, std::string(what) + " must be called before the model is closed (by closeModel(), "
                                              "a solve or readAssignmentFromRoutes())",
                     false);
  }
  return true;
}

bool RoutingModelWrap::EnsureClosed(Napi::Env env, const RoutingSearchParameters& parameters) {
  if (closed_) return true;
  closed_ = true;
  MarkChanged();
  if (!context_->RunGuarded(env, "closing the model", [&] { model_->CloseModelWithParameters(parameters); })) {
    broken_ = true;
    return false;
  }
  return true;
}

bool RoutingModelWrap::CheckEvaluator(Napi::Env env, int64_t id) const {
  if (id < 0 || id >= num_evaluators_) {
    Napi::RangeError::New(env, "unknown transit evaluator " + std::to_string(id) + " (register it first)")
        .ThrowAsJavaScriptException();
    return false;
  }
  return true;
}

Napi::Value RoutingModelWrap::VarToJs(Napi::Env env, IntVar* var) {
  int id = -1;
  if (!GuardCpp(env, "registering a variable", [&] { id = context_->RegisterExpr(var); })) return env.Undefined();
  return Napi::Number::New(env, id);
}

Napi::Value RoutingModelWrap::Dispose(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (!model_) return env.Undefined();  // already disposed
  if (!CheckNotBusy(env, solve_state_, "RoutingModel")) return env.Undefined();
  if (context_->search_open()) {
    THROW_AND_RETURN(env, "RoutingModel is in use by a search on its solver (call endSearch() first)",
                     env.Undefined());
  }
  context_->Detach();
  model_.reset();
  MarkChanged();
  return env.Undefined();
}

Napi::Value RoutingModelWrap::IsBusy(const Napi::CallbackInfo& info) {
  return Napi::Boolean::New(info.Env(), solve_state_.busy());
}

Napi::Value RoutingModelWrap::IsDisposed(const Napi::CallbackInfo& info) {
  return Napi::Boolean::New(info.Env(), !model_);
}

Napi::Value RoutingModelWrap::IsClosed(const Napi::CallbackInfo& info) {
  return Napi::Boolean::New(info.Env(), closed_);
}

Napi::Value RoutingModelWrap::Status(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (!model_) THROW_AND_RETURN(env, "RoutingModel has been disposed", env.Undefined());
  if (!CheckNotBusy(env, solve_state_, "RoutingModel")) return env.Undefined();
  return Napi::String::New(env, operations_research::RoutingSearchStatus::Value_Name(model_->status()));
}

// Asks a running solve to stop; false when none is running.
Napi::Value RoutingModelWrap::Interrupt(const Napi::CallbackInfo& info) {
  const bool running = solve_state_.busy();
  if (running) solve_state_.RequestStop();
  return Napi::Boolean::New(info.Env(), running);
}

// (paramsJson?) Closing an already closed model is a no-op.
Napi::Value RoutingModelWrap::CloseModel(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  RoutingSearchParameters parameters = operations_research::DefaultRoutingSearchParameters();
  if (info.Length() > 0 && !info[0].IsUndefined() && !ReadRoutingSearchParameters(env, info[0], &parameters)) {
    return env.Undefined();
  }
  if (!CheckUsable(env)) return env.Undefined();
  EnsureClosed(env, parameters);
  return env.Undefined();
}

// ---------------------------------------------------------------------------
// Sizes and path structure (fixed when the model is built)
// ---------------------------------------------------------------------------

Napi::Value RoutingModelWrap::Size(const Napi::CallbackInfo& info) {
  return Napi::Number::New(info.Env(), static_cast<double>(size_));
}

Napi::Value RoutingModelWrap::Vehicles(const Napi::CallbackInfo& info) {
  return Napi::Number::New(info.Env(), static_cast<double>(vehicles_));
}

Napi::Value RoutingModelWrap::Nodes(const Napi::CallbackInfo& info) {
  return Napi::Number::New(info.Env(), static_cast<double>(nodes_));
}

Napi::Value RoutingModelWrap::Start(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  int64_t vehicle;
  if (!ReadIntInRange(env, info[0], 0, vehicles_ - 1, "vehicle", &vehicle) || !CheckUsable(env)) {
    return env.Undefined();
  }
  return Napi::Number::New(env, static_cast<double>(model_->Start(static_cast<int>(vehicle))));
}

Napi::Value RoutingModelWrap::End(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  int64_t vehicle;
  if (!ReadIntInRange(env, info[0], 0, vehicles_ - 1, "vehicle", &vehicle) || !CheckUsable(env)) {
    return env.Undefined();
  }
  return Napi::Number::New(env, static_cast<double>(model_->End(static_cast<int>(vehicle))));
}

Napi::Value RoutingModelWrap::IsStart(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  int64_t index;
  if (!ReadIntInRange(env, info[0], 0, size_ + vehicles_ - 1, "index", &index) || !CheckUsable(env)) {
    return env.Undefined();
  }
  return Napi::Boolean::New(env, model_->IsStart(index));
}

Napi::Value RoutingModelWrap::IsEnd(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  int64_t index;
  if (!ReadIntInRange(env, info[0], 0, size_ + vehicles_ - 1, "index", &index) || !CheckUsable(env)) {
    return env.Undefined();
  }
  return Napi::Boolean::New(env, model_->IsEnd(index));
}

// ---------------------------------------------------------------------------
// Transits. Registering needs an OPEN model: the filters built at close keep
// references into OR-Tools' evaluator vectors, which a later registration
// would reallocate (use-after-free).
// ---------------------------------------------------------------------------

// (matrix: numNodes x numNodes, indexed by node) -> evaluator id
Napi::Value RoutingModelWrap::RegisterTransitMatrix(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  std::vector<std::vector<int64_t>> matrix;
  if (!ReadInt64Matrix(env, info[0], static_cast<size_t>(nodes_), static_cast<size_t>(nodes_), "matrix", &matrix) ||
      !CheckOpen(env, "registerTransitMatrix()")) {
    return env.Undefined();
  }
  int id = -1;
  if (!GuardCpp(env, "registerTransitMatrix()", [&] { id = model_->RegisterTransitMatrix(std::move(matrix)); })) {
    return env.Undefined();
  }
  NoteEvaluator(id);
  return Napi::Number::New(env, id);
}

// (values: numNodes, indexed by node) -> evaluator id
Napi::Value RoutingModelWrap::RegisterUnaryTransitVector(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  std::vector<int64_t> values;
  if (!ReadInt64Array(env, info[0], true, "values", &values)) return env.Undefined();
  if (values.size() != static_cast<size_t>(nodes_)) {
    THROW_AND_RETURN(env, "values must have one entry per node (" + std::to_string(nodes_) + ")", env.Undefined());
  }
  if (!CheckOpen(env, "registerUnaryTransitVector()")) return env.Undefined();
  int id = -1;
  if (!GuardCpp(env, "registerUnaryTransitVector()",
                [&] { id = model_->RegisterUnaryTransitVector(std::move(values)); })) {
    return env.Undefined();
  }
  NoteEvaluator(id);
  return Napi::Number::New(env, id);
}

// (fn(fromIndex, toIndex)) -> evaluator id. fn runs now, for every pair of
// indices: solving happens off the JS thread, where JS cannot be called.
Napi::Value RoutingModelWrap::RegisterTransitCallback(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (!info[0].IsFunction()) THROW_TYPE_AND_RETURN(env, "registerTransitCallback(fn): fn must be a function", env.Undefined());
  Napi::Function fn = info[0].As<Napi::Function>();
  const int64_t n = size_ + vehicles_;
  if (n > kMaxEagerTransitIndices) {
    Napi::RangeError::New(env, "registerTransitCallback() stores a value for every pair of indices; " +
                                   std::to_string(n) + " indices exceed the limit of " +
                                   std::to_string(kMaxEagerTransitIndices) + " (use registerTransitMatrix())")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }
  auto values = std::make_shared<std::vector<int64_t>>();
  if (!GuardCpp(env, "registerTransitCallback()", [&] { values->resize(static_cast<size_t>(n * n)); })) {
    return env.Undefined();
  }
  for (int64_t i = 0; i < n; ++i) {
    Napi::HandleScope scope(env);
    Napi::Value from = Napi::Number::New(env, static_cast<double>(i));
    for (int64_t j = 0; j < n; ++j) {
      auto describe = [i, j] {
        return "transit callback result for (" + std::to_string(i) + ", " + std::to_string(j) + ")";
      };
      if (!CallForInt64(env, fn, {from, Napi::Number::New(env, static_cast<double>(j))}, describe,
                        &(*values)[static_cast<size_t>(i * n + j)])) {
        return env.Undefined();
      }
    }
  }
  if (!CheckOpen(env, "registerTransitCallback()")) return env.Undefined();
  int id = -1;
  if (!GuardCpp(env, "registerTransitCallback()", [&] {
        const RoutingModel::TransitEvaluatorSign sign = SignOf(*values);
        id = model_->RegisterTransitCallback(
            [values, n](int64_t from, int64_t to) { return (*values)[static_cast<size_t>(from * n + to)]; }, sign);
      })) {
    return env.Undefined();
  }
  NoteEvaluator(id);
  return Napi::Number::New(env, id);
}

// (fn(fromIndex)) -> evaluator id, evaluated now for every index.
Napi::Value RoutingModelWrap::RegisterUnaryTransitCallback(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (!info[0].IsFunction()) {
    THROW_TYPE_AND_RETURN(env, "registerUnaryTransitCallback(fn): fn must be a function", env.Undefined());
  }
  Napi::Function fn = info[0].As<Napi::Function>();
  const int64_t n = size_ + vehicles_;
  auto values = std::make_shared<std::vector<int64_t>>();
  if (!GuardCpp(env, "registerUnaryTransitCallback()", [&] { values->resize(static_cast<size_t>(n)); })) {
    return env.Undefined();
  }
  for (int64_t i = 0; i < n; ++i) {
    Napi::HandleScope scope(env);
    auto describe = [i] { return "unary transit callback result for (" + std::to_string(i) + ")"; };
    if (!CallForInt64(env, fn, {Napi::Number::New(env, static_cast<double>(i))}, describe, &(*values)[i])) {
      return env.Undefined();
    }
  }
  if (!CheckOpen(env, "registerUnaryTransitCallback()")) return env.Undefined();
  int id = -1;
  if (!GuardCpp(env, "registerUnaryTransitCallback()", [&] {
        const RoutingModel::TransitEvaluatorSign sign = SignOf(*values);
        id = model_->RegisterUnaryTransitCallback([values](int64_t from) { return (*values)[from]; }, sign);
      })) {
    return env.Undefined();
  }
  NoteEvaluator(id);
  return Napi::Number::New(env, id);
}

// ---------------------------------------------------------------------------
// Costs
// ---------------------------------------------------------------------------

Napi::Value RoutingModelWrap::SetArcCostEvaluatorOfAllVehicles(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  int64_t evaluator;
  if (!ReadIntInRange(env, info[0], 0, kMaxInt, "evaluator", &evaluator) ||
      !CheckOpen(env, "setArcCostEvaluatorOfAllVehicles()") || !CheckEvaluator(env, evaluator)) {
    return env.Undefined();
  }
  GuardCpp(env, "setArcCostEvaluatorOfAllVehicles()",
           [&] { model_->SetArcCostEvaluatorOfAllVehicles(static_cast<int>(evaluator)); });
  MarkChanged();
  return env.Undefined();
}

Napi::Value RoutingModelWrap::SetArcCostEvaluatorOfVehicle(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  int64_t evaluator, vehicle;
  if (!ReadIntInRange(env, info[0], 0, kMaxInt, "evaluator", &evaluator) ||
      !ReadIntInRange(env, info[1], 0, vehicles_ - 1, "vehicle", &vehicle) ||
      !CheckOpen(env, "setArcCostEvaluatorOfVehicle()") || !CheckEvaluator(env, evaluator)) {
    return env.Undefined();
  }
  GuardCpp(env, "setArcCostEvaluatorOfVehicle()", [&] {
    model_->SetArcCostEvaluatorOfVehicle(static_cast<int>(evaluator), static_cast<int>(vehicle));
  });
  MarkChanged();
  return env.Undefined();
}

Napi::Value RoutingModelWrap::SetFixedCostOfAllVehicles(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  int64_t cost;
  // SetFixedCostOfVehicle DCHECKs a non-negative cost.
  if (!ReadIntInRange(env, info[0], 0, std::numeric_limits<int64_t>::max() - 1, "cost", &cost) ||
      !CheckOpen(env, "setFixedCostOfAllVehicles()")) {
    return env.Undefined();
  }
  GuardCpp(env, "setFixedCostOfAllVehicles()", [&] { model_->SetFixedCostOfAllVehicles(cost); });
  MarkChanged();
  return env.Undefined();
}

Napi::Value RoutingModelWrap::SetFixedCostOfVehicle(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  int64_t cost, vehicle;
  if (!ReadIntInRange(env, info[0], 0, std::numeric_limits<int64_t>::max() - 1, "cost", &cost) ||
      !ReadIntInRange(env, info[1], 0, vehicles_ - 1, "vehicle", &vehicle) ||
      !CheckOpen(env, "setFixedCostOfVehicle()")) {
    return env.Undefined();
  }
  GuardCpp(env, "setFixedCostOfVehicle()", [&] { model_->SetFixedCostOfVehicle(cost, static_cast<int>(vehicle)); });
  MarkChanged();
  return env.Undefined();
}

// ---------------------------------------------------------------------------
// CP variables of the model (ids in the solver's registry)
// ---------------------------------------------------------------------------

Napi::Value RoutingModelWrap::NextVar(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  int64_t index;
  if (!ReadIntInRange(env, info[0], 0, size_ - 1, "index", &index) || !CheckUsable(env)) return env.Undefined();
  return VarToJs(env, model_->NextVar(index));
}

Napi::Value RoutingModelWrap::VehicleVar(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  int64_t index;
  if (!ReadIntInRange(env, info[0], 0, size_ + vehicles_ - 1, "index", &index) || !CheckUsable(env)) {
    return env.Undefined();
  }
  return VarToJs(env, model_->VehicleVar(index));
}

Napi::Value RoutingModelWrap::ActiveVar(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  int64_t index;
  if (!ReadIntInRange(env, info[0], 0, size_ - 1, "index", &index) || !CheckUsable(env)) return env.Undefined();
  return VarToJs(env, model_->ActiveVar(index));
}

// The cost variable exists once the model is closed.
Napi::Value RoutingModelWrap::CostVar(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (!CheckUsable(env)) return env.Undefined();
  if (!closed_ || model_->CostVar() == nullptr) {
    THROW_AND_RETURN(env, "costVar() is available once the model is closed", env.Undefined());
  }
  return VarToJs(env, model_->CostVar());
}

}  // namespace ortools_node
