// RoutingModel: pickup and delivery, disjunctions, allowed vehicles, visit
// types, soft same-vehicle costs, finalizers, locks and reading routes.
//
// OR-Tools only DCHECKs most of these inputs, so a bad one corrupts memory in a
// release build instead of failing: every index, vehicle, type and disjunction
// is validated here first.

#include <napi.h>

#include <cstdint>
#include <limits>
#include <string>
#include <unordered_set>
#include <vector>

#include "absl/container/flat_hash_set.h"
#include "common/cpp_guard.h"
#include "common/int64.h"
#include "common/napi_util.h"
#include "constraint_solver/cp_context.h"
#include "routing/routing_guards.h"
#include "ortools/constraint_solver/routing_parameters.h"
#include "routing/routing_model.h"

namespace ortools_node {

using operations_research::Assignment;
using operations_research::IntVar;
using operations_research::RoutingModel;

namespace {

// Visit types index per-type vectors that OR-Tools sizes to the largest type.
constexpr int64_t kMaxVisitType = (1 << 20) - 1;
constexpr int64_t kMaxInt = std::numeric_limits<int32_t>::max();

bool CheckNoDuplicates(Napi::Env env, const std::vector<int64_t>& values, const char* what) {
  std::unordered_set<int64_t> seen;
  for (int64_t v : values) {
    if (!seen.insert(v).second) {
      THROW_AND_RETURN(env, std::string(what) + " contains index " + std::to_string(v) + " twice", false);
    }
  }
  return true;
}

bool ReadPolicy(Napi::Env env, const Napi::Value& v, RoutingModel::PickupAndDeliveryPolicy* out) {
  const std::string name = v.IsString() ? v.As<Napi::String>().Utf8Value() : "";
  if (name == "PICKUP_AND_DELIVERY_NO_ORDER") *out = RoutingModel::PICKUP_AND_DELIVERY_NO_ORDER;
  else if (name == "PICKUP_AND_DELIVERY_LIFO") *out = RoutingModel::PICKUP_AND_DELIVERY_LIFO;
  else if (name == "PICKUP_AND_DELIVERY_FIFO") *out = RoutingModel::PICKUP_AND_DELIVERY_FIFO;
  else THROW_TYPE_AND_RETURN(env, "unknown pickup and delivery policy '" + name + "'", false);
  return true;
}

bool ReadVisitTypePolicy(Napi::Env env, const Napi::Value& v, RoutingModel::VisitTypePolicy* out) {
  const std::string name = v.IsString() ? v.As<Napi::String>().Utf8Value() : "";
  if (name == "TYPE_ADDED_TO_VEHICLE") *out = RoutingModel::TYPE_ADDED_TO_VEHICLE;
  else if (name == "ADDED_TYPE_REMOVED_FROM_VEHICLE") *out = RoutingModel::ADDED_TYPE_REMOVED_FROM_VEHICLE;
  else if (name == "TYPE_ON_VEHICLE_UP_TO_VISIT") *out = RoutingModel::TYPE_ON_VEHICLE_UP_TO_VISIT;
  else if (name == "TYPE_SIMULTANEOUSLY_ADDED_AND_REMOVED") *out = RoutingModel::TYPE_SIMULTANEOUSLY_ADDED_AND_REMOVED;
  else THROW_TYPE_AND_RETURN(env, "unknown visit type policy '" + name + "'", false);
  return true;
}

// Phase 3 check for a pickup or delivery index: not a vehicle start, not in
// another pair (OR-Tools DCHECKs both).
bool CheckFreeForPair(Napi::Env env, const RoutingModel& model, int64_t index) {
  if (model.IsStart(index)) {
    THROW_AND_RETURN(env, "index " + std::to_string(index) + " is a vehicle start and cannot be a pickup or delivery",
                     false);
  }
  if (model.IsPickup(index) || model.IsDelivery(index)) {
    THROW_AND_RETURN(env, "index " + std::to_string(index) + " is already in a pickup and delivery pair", false);
  }
  return true;
}

// Routes and lock chains list the visits only: a vehicle start inside one
// makes OR-Tools log an error and fail late, so reject it up front.
bool CheckNoStarts(Napi::Env env, const RoutingModel& model, const std::vector<std::vector<int64_t>>& routes,
                   const char* what) {
  for (const auto& route : routes) {
    for (int64_t index : route) {
      if (model.IsStart(index)) {
        THROW_AND_RETURN(env, std::string(what) + " must not contain vehicle starts (index " + std::to_string(index) +
                                  ")",
                         false);
      }
    }
  }
  return true;
}

bool CheckVisitType(Napi::Env env, const RoutingModel& model, int64_t type) {
  // The incompatibility and requirement tables are sized by the number of types set.
  if (type >= model.GetNumberOfVisitTypes()) {
    THROW_AND_RETURN(env, "visit type " + std::to_string(type) + " is not used by any index (call setVisitType() first)",
                     false);
  }
  return true;
}

}  // namespace

// ---------------------------------------------------------------------------
// Pickup and delivery
// ---------------------------------------------------------------------------

Napi::Value RoutingModelWrap::AddPickupAndDelivery(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  int64_t pickup, delivery;
  if (!ReadIntInRange(env, info[0], 0, size_ - 1, "pickup", &pickup) ||
      !ReadIntInRange(env, info[1], 0, size_ - 1, "delivery", &delivery)) {
    return env.Undefined();
  }
  if (pickup == delivery) THROW_AND_RETURN(env, "pickup and delivery must differ", env.Undefined());
  if (!CheckOpen(env, "addPickupAndDelivery()") || !CheckFreeForPair(env, *model_, pickup) ||
      !CheckFreeForPair(env, *model_, delivery)) {
    return env.Undefined();
  }
  GuardCpp(env, "addPickupAndDelivery()", [&] { model_->AddPickupAndDelivery(pickup, delivery); });
  MarkChanged();
  return env.Undefined();
}

// (pickupDisjunction, deliveryDisjunction)
Napi::Value RoutingModelWrap::AddPickupAndDeliverySets(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  int64_t pickup_disjunction, delivery_disjunction;
  if (!ReadIntInRange(env, info[0], 0, kMaxInt, "pickupDisjunction", &pickup_disjunction) ||
      !ReadIntInRange(env, info[1], 0, kMaxInt, "deliveryDisjunction", &delivery_disjunction) ||
      !CheckOpen(env, "addPickupAndDeliverySets()")) {
    return env.Undefined();
  }
  const int64_t count = model_->GetNumberOfDisjunctions();
  if (pickup_disjunction >= count || delivery_disjunction >= count) {
    THROW_AND_RETURN(env, "unknown disjunction (addDisjunction() returns its index)", env.Undefined());
  }
  if (pickup_disjunction == delivery_disjunction) {
    THROW_AND_RETURN(env, "the pickup and delivery disjunctions must differ", env.Undefined());
  }
  const RoutingModel::DisjunctionIndex pickups(static_cast<int>(pickup_disjunction));
  const RoutingModel::DisjunctionIndex deliveries(static_cast<int>(delivery_disjunction));
  const std::vector<int64_t>& pickup_indices = model_->GetDisjunctionNodeIndices(pickups);
  const std::vector<int64_t>& delivery_indices = model_->GetDisjunctionNodeIndices(deliveries);
  std::unordered_set<int64_t> pickup_set(pickup_indices.begin(), pickup_indices.end());
  for (int64_t index : pickup_indices) {
    if (!CheckFreeForPair(env, *model_, index)) return env.Undefined();
  }
  for (int64_t index : delivery_indices) {
    if (!CheckFreeForPair(env, *model_, index)) return env.Undefined();
    if (pickup_set.count(index) > 0) {
      THROW_AND_RETURN(env, "index " + std::to_string(index) + " is in both disjunctions", env.Undefined());
    }
  }
  GuardCpp(env, "addPickupAndDeliverySets()", [&] { model_->AddPickupAndDeliverySets(pickups, deliveries); });
  MarkChanged();
  return env.Undefined();
}

// (policy, vehicle?) for one vehicle, or all when vehicle is undefined.
Napi::Value RoutingModelWrap::SetPickupAndDeliveryPolicy(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  RoutingModel::PickupAndDeliveryPolicy policy;
  if (!ReadPolicy(env, info[0], &policy)) return env.Undefined();
  const bool all = info[1].IsUndefined();
  int64_t vehicle = 0;
  if (!all && !ReadIntInRange(env, info[1], 0, vehicles_ - 1, "vehicle", &vehicle)) return env.Undefined();
  if (!CheckOpen(env, all ? "setPickupAndDeliveryPolicyOfAllVehicles()" : "setPickupAndDeliveryPolicyOfVehicle()")) {
    return env.Undefined();
  }
  GuardCpp(env, "setPickupAndDeliveryPolicy()", [&] {
    if (all) {
      model_->SetPickupAndDeliveryPolicyOfAllVehicles(policy);
    } else {
      model_->SetPickupAndDeliveryPolicyOfVehicle(policy, static_cast<int>(vehicle));
    }
  });
  MarkChanged();
  return env.Undefined();
}

// ---------------------------------------------------------------------------
// Disjunctions, vehicles, types
// ---------------------------------------------------------------------------

// (indices, penalty, maxCardinality) -> disjunction index. Penalty -1
// (pywrapcp's default) makes the disjunction mandatory.
Napi::Value RoutingModelWrap::AddDisjunction(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  std::vector<int64_t> indices;
  int64_t penalty, max_cardinality;
  if (!ReadIntArrayInRange(env, info[0], 0, size_ - 1, "indices", &indices) ||
      !ReadInt64(env, info[1], true, "penalty", &penalty) ||
      // AddDisjunction CHECKs max_cardinality >= 1.
      !ReadIntInRange(env, info[2], 1, std::numeric_limits<int64_t>::max(), "maxCardinality", &max_cardinality) ||
      !CheckNoDuplicates(env, indices, "indices") || !CheckOpen(env, "addDisjunction()")) {
    return env.Undefined();
  }
  for (int64_t index : indices) {
    // Starts and ends cannot be in a disjunction (ends are already out of range).
    if (model_->IsStart(index)) {
      THROW_AND_RETURN(env, "index " + std::to_string(index) + " is a vehicle start and cannot be in a disjunction",
                       env.Undefined());
    }
  }
  int disjunction = -1;
  if (!GuardCpp(env, "addDisjunction()", [&] {
        disjunction = model_->AddDisjunction(indices, penalty, max_cardinality).value();
      })) {
    return env.Undefined();
  }
  MarkChanged();
  return Napi::Number::New(env, disjunction);
}

// (vehicles, index). An empty list allows every vehicle, as in OR-Tools.
Napi::Value RoutingModelWrap::SetAllowedVehiclesForIndex(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  std::vector<int64_t> vehicles;
  int64_t index;
  if (!ReadIntArrayInRange(env, info[0], 0, vehicles_ - 1, "vehicles", &vehicles) ||
      !ReadIntInRange(env, info[1], 0, size_ + vehicles_ - 1, "index", &index) ||
      !CheckOpen(env, "setAllowedVehiclesForIndex()")) {
    return env.Undefined();
  }
  // A std::vector converts to both the 9.14 (const vector&) and 9.15 (Span) parameter.
  const std::vector<int> allowed(vehicles.begin(), vehicles.end());
  GuardCpp(env, "setAllowedVehiclesForIndex()", [&] { model_->SetAllowedVehiclesForIndex(allowed, index); });
  MarkChanged();
  return env.Undefined();
}

// (index, type, policy)
Napi::Value RoutingModelWrap::SetVisitType(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  int64_t index, type;
  RoutingModel::VisitTypePolicy policy;
  if (!ReadIntInRange(env, info[0], 0, size_ + vehicles_ - 1, "index", &index) ||
      !ReadIntInRange(env, info[1], 0, kMaxVisitType, "type", &type) || !ReadVisitTypePolicy(env, info[2], &policy) ||
      !CheckOpen(env, "setVisitType()")) {
    return env.Undefined();
  }
  GuardCpp(env, "setVisitType()", [&] { model_->SetVisitType(index, static_cast<int>(type), policy); });
  MarkChanged();
  return env.Undefined();
}

// (temporal, type1, type2)
Napi::Value RoutingModelWrap::AddTypeIncompatibility(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  const bool temporal = info[0].ToBoolean();
  int64_t type1, type2;
  const char* what = temporal ? "addTemporalTypeIncompatibility()" : "addHardTypeIncompatibility()";
  if (!ReadIntInRange(env, info[1], 0, kMaxVisitType, "type1", &type1) ||
      !ReadIntInRange(env, info[2], 0, kMaxVisitType, "type2", &type2) || !CheckOpen(env, what) ||
      !CheckVisitType(env, *model_, type1) || !CheckVisitType(env, *model_, type2)) {
    return env.Undefined();
  }
  GuardCpp(env, what, [&] {
    if (temporal) {
      model_->AddTemporalTypeIncompatibility(static_cast<int>(type1), static_cast<int>(type2));
    } else {
      model_->AddHardTypeIncompatibility(static_cast<int>(type1), static_cast<int>(type2));
    }
  });
  MarkChanged();
  return env.Undefined();
}

// (whenRemoving, dependentType, requiredTypes[])
Napi::Value RoutingModelWrap::AddRequiredTypeAlternatives(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  const bool when_removing = info[0].ToBoolean();
  int64_t dependent;
  std::vector<int64_t> required;
  const char* what = when_removing ? "addRequiredTypeAlternativesWhenRemovingType()"
                                   : "addRequiredTypeAlternativesWhenAddingType()";
  if (!ReadIntInRange(env, info[1], 0, kMaxVisitType, "dependentType", &dependent) ||
      !ReadIntArrayInRange(env, info[2], 0, kMaxVisitType, "requiredTypes", &required) || !CheckOpen(env, what) ||
      !CheckVisitType(env, *model_, dependent)) {
    return env.Undefined();
  }
  for (int64_t type : required) {
    if (!CheckVisitType(env, *model_, type)) return env.Undefined();
  }
  GuardCpp(env, what, [&] {
    absl::flat_hash_set<int> alternatives(required.begin(), required.end());
    if (when_removing) {
      model_->AddRequiredTypeAlternativesWhenRemovingType(static_cast<int>(dependent), std::move(alternatives));
    } else {
      model_->AddRequiredTypeAlternativesWhenAddingType(static_cast<int>(dependent), std::move(alternatives));
    }
  });
  MarkChanged();
  return env.Undefined();
}

// (indices, cost)
Napi::Value RoutingModelWrap::AddSoftSameVehicleConstraint(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  std::vector<int64_t> indices;
  int64_t cost;
  if (!ReadIntArrayInRange(env, info[0], 0, size_ + vehicles_ - 1, "indices", &indices) ||
      !ReadInt64(env, info[1], false, "cost", &cost) || !CheckOpen(env, "addSoftSameVehicleConstraint()")) {
    return env.Undefined();
  }
  GuardCpp(env, "addSoftSameVehicleConstraint()",
           [&] { model_->AddSoftSameVehicleConstraint(std::move(indices), cost); });
  MarkChanged();
  return env.Undefined();
}

// (indices): all performed or all unperformed. OR-Tools 9.15 and later.
Napi::Value RoutingModelWrap::AddSameActivityGroup(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  std::vector<int64_t> indices;
  if (!ReadIntArrayInRange(env, info[0], 0, size_ - 1, "indices", &indices) ||
      !CheckOpen(env, "addSameActivityGroup()")) {
    return env.Undefined();
  }
#if ORTOOLS_VERSION_MAJOR > 9 || (ORTOOLS_VERSION_MAJOR == 9 && ORTOOLS_VERSION_MINOR >= 15)
  const std::vector<int> group(indices.begin(), indices.end());
  if (!context_->RunGuarded(env, "addSameActivityGroup()", [&] { model_->AddSameActivityGroup(group); })) {
    return env.Undefined();
  }
  MarkChanged();
  return env.Undefined();
#else
  THROW_AND_RETURN(env, "addSameActivityGroup() needs OR-Tools 9.15 or later (this build uses " ORTOOLS_VERSION_STRING
                        ")",
                   env.Undefined());
#endif
}

// ---------------------------------------------------------------------------
// Finalizers and the solution assignment
// ---------------------------------------------------------------------------

// (kind: 'minimize' | 'maximize' | 'target', var, target?)
Napi::Value RoutingModelWrap::AddFinalizerVariable(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  std::string kind;
  uint32_t var_id;
  int64_t target = 0;
  if (!ReadString(env, info[0], "kind", &kind) || !ReadId(env, info[1], "variable", &var_id)) return env.Undefined();
  if (kind != "minimize" && kind != "maximize" && kind != "target") {
    THROW_TYPE_AND_RETURN(env, "unknown finalizer kind '" + kind + "'", env.Undefined());
  }
  if (kind == "target" && !ReadInt64(env, info[2], false, "target", &target)) return env.Undefined();
  if (!CheckOpen(env, "a finalizer")) return env.Undefined();
  IntVar* var = context_->VarOrCastById(env, var_id, "variable");
  if (var == nullptr) return env.Undefined();
  GuardCpp(env, "a finalizer", [&] {
    if (kind == "minimize") model_->AddVariableMinimizedByFinalizer(var);
    else if (kind == "maximize") model_->AddVariableMaximizedByFinalizer(var);
    else model_->AddVariableTargetToFinalizer(var, target);
  });
  MarkChanged();
  return env.Undefined();
}

// (var): also store this variable in solutions (e.g. slack variables).
Napi::Value RoutingModelWrap::AddToAssignment(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  uint32_t var_id;
  if (!ReadId(env, info[0], "variable", &var_id) || !CheckOpen(env, "addToAssignment()")) return env.Undefined();
  IntVar* var = context_->VarOrCastById(env, var_id, "variable");
  if (var == nullptr) return env.Undefined();
  GuardCpp(env, "addToAssignment()", [&] { model_->AddToAssignment(var); });
  MarkChanged();
  return env.Undefined();
}

// ---------------------------------------------------------------------------
// Locks and routes
// ---------------------------------------------------------------------------

// (locks) -> id of the next variable at the end of the chain, or null.
// RoutingModel::ApplyLocks CHECKs a single vehicle.
Napi::Value RoutingModelWrap::ApplyLocks(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  std::vector<int64_t> locks;
  if (!ReadIntArrayInRange(env, info[0], 0, size_ - 1, "locks", &locks) || !CheckUsable(env)) return env.Undefined();
  if (vehicles_ != 1) {
    THROW_AND_RETURN(env, "applyLocks() needs a model with exactly one vehicle; use applyLocksToAllVehicles()",
                     env.Undefined());
  }
  IntVar* next = nullptr;
  if (!GuardCpp(env, "applyLocks()", [&] { next = model_->ApplyLocks(locks); })) return env.Undefined();
  MarkChanged();
  return next == nullptr ? env.Null() : VarToJs(env, next);
}

// (locks: one array per vehicle, without starts and ends, closeRoutes) -> bool.
// Needs a closed model (OR-Tools returns false and logs an error otherwise).
Napi::Value RoutingModelWrap::ApplyLocksToAllVehicles(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  std::vector<std::vector<int64_t>> locks;
  if (!ReadIntArrays(env, info[0], 0, size_ - 1, "locks", &locks)) return env.Undefined();
  if (!info[1].IsBoolean()) THROW_TYPE_AND_RETURN(env, "closeRoutes must be a boolean", env.Undefined());
  const bool close_routes = info[1].As<Napi::Boolean>().Value();
  if (locks.size() > static_cast<size_t>(vehicles_)) {
    THROW_AND_RETURN(env, "locks has more routes than the model has vehicles", env.Undefined());
  }
  if (!CheckUsable(env) || !CheckNoStarts(env, *model_, locks, "locks")) return env.Undefined();
  if (!closed_) {
    THROW_AND_RETURN(env, "applyLocksToAllVehicles() needs a closed model: call closeModelWithParameters() first",
                     env.Undefined());
  }
  bool applied = false;
  if (!GuardCpp(env, "applyLocksToAllVehicles()",
                [&] { applied = model_->ApplyLocksToAllVehicles(locks, close_routes); })) {
    return env.Undefined();
  }
  MarkChanged();
  return Napi::Boolean::New(env, applied);
}

// (routes: one array per vehicle, without starts and ends, ignoreInactiveIndices)
// -> solution handle, or null when the routes are not feasible. Closes the
// model with the default parameters if needed, as OR-Tools does.
Napi::Value RoutingModelWrap::ReadAssignmentFromRoutes(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  std::vector<std::vector<int64_t>> routes;
  if (!ReadIntArrays(env, info[0], 0, size_ - 1, "routes", &routes)) return env.Undefined();
  if (!info[1].IsBoolean()) THROW_TYPE_AND_RETURN(env, "ignoreInactiveIndices must be a boolean", env.Undefined());
  const bool ignore_inactive = info[1].As<Napi::Boolean>().Value();
  if (routes.size() > static_cast<size_t>(vehicles_)) {
    THROW_AND_RETURN(env, "routes has more routes than the model has vehicles", env.Undefined());
  }
  if (!CheckUsable(env) || !CheckNoStarts(env, *model_, routes, "routes") ||
      !EnsureClosed(env, operations_research::DefaultRoutingSearchParameters())) {
    return env.Undefined();
  }
  MarkChanged();  // the previous solutions share the collector this reuses
  // It runs a search: hold the busy state (resets the stop flag) meanwhile.
  solve_state_.Begin();
  const Assignment* assignment = nullptr;
  const bool ok = GuardCpp(env, "readAssignmentFromRoutes()",
                           [&] { assignment = model_->ReadAssignmentFromRoutes(routes, ignore_inactive); });
  solve_state_.End();
  if (!ok) return env.Undefined();
  if (assignment == nullptr) return env.Null();
  int handle = -1;
  if (!GuardCpp(env, "readAssignmentFromRoutes()", [&] { handle = RecordAssignment(assignment); })) {
    return env.Undefined();
  }
  return Napi::Number::New(env, handle);
}

}  // namespace ortools_node
