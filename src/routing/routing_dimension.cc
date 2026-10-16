// RoutingModel: dimensions, their variables, span costs and soft bounds.
//
// Guards cover what OR-Tools CHECKs or indexes without bounds checks:
// capacities >= 0 (InitializeCumuls CHECK, and CHECK_EQ(0, start cumul min)),
// one capacity / evaluator per vehicle (CHECK_EQ), registered evaluators,
// span bounds and coefficients >= 0 (CHECK_GE), vehicle and index ranges.

#include <napi.h>

#include <cstdint>
#include <limits>
#include <string>
#include <utility>
#include <vector>

#include "common/cpp_guard.h"
#include "common/int64.h"
#include "common/napi_util.h"
#include "routing/routing_guards.h"
#include "routing/routing_model.h"

namespace ortools_node {

using operations_research::IntVar;
using operations_research::RoutingDimension;

namespace {

constexpr int64_t kMaxInt = std::numeric_limits<int32_t>::max();

// A non-negative int64 where +Infinity means unbounded (kint64max).
bool ReadNonNegative(Napi::Env env, const Napi::Value& v, bool allow_infinite, const char* what, int64_t* out) {
  if (!ReadInt64(env, v, allow_infinite, what, out)) return false;
  if (*out < 0) THROW_AND_RETURN(env, std::string(what) + " must be >= 0", false);
  return true;
}

bool ReadNonNegativeArray(Napi::Env env, const Napi::Value& v, size_t size, const char* what,
                          std::vector<int64_t>* out) {
  if (!ReadInt64Array(env, v, true, what, out)) return false;
  if (out->size() != size) {
    THROW_AND_RETURN(env, std::string(what) + " must have one entry per vehicle (" + std::to_string(size) + ")",
                     false);
  }
  for (int64_t value : *out) {
    if (value < 0) THROW_AND_RETURN(env, std::string(what) + " must all be >= 0", false);
  }
  return true;
}

// The trailing (fixStartCumulToZero, name) arguments of every AddDimension*.
struct DimensionTail {
  bool fix_start_cumul_to_zero = false;
  std::string name;
};

bool ReadDimensionTail(Napi::Env env, const Napi::Value& fix, const Napi::Value& name, DimensionTail* out) {
  if (!fix.IsBoolean()) THROW_TYPE_AND_RETURN(env, "fixStartCumulToZero must be a boolean", false);
  out->fix_start_cumul_to_zero = fix.As<Napi::Boolean>().Value();
  return ReadString(env, name, "name", &out->name);
}

Napi::Value PairToJs(Napi::Env env, int evaluator, bool created) {
  Napi::Array pair = Napi::Array::New(env, 2);
  pair.Set(0u, Napi::Number::New(env, evaluator));
  pair.Set(1u, Napi::Boolean::New(env, created));
  return pair;
}

}  // namespace

RoutingDimension* RoutingModelWrap::DimensionNamed(Napi::Env env, const std::string& name) const {
  // GetDimensionOrDie() aborts on an unknown name.
  if (!model_->HasDimension(name)) {
    Napi::Error::New(env, "Unknown dimension '" + name + "'").ThrowAsJavaScriptException();
    return nullptr;
  }
  return model_->GetMutableDimension(name);
}

// Runs an AddDimension* call (guarded: it may reduce domains) and marks the change.
#define ADD_DIMENSION(env, what, call)                                           \
  do {                                                                         \
    bool created = false;                                                      \
    if (!context_->RunGuarded((env), (what), [&] { created = (call); })) {     \
      return (env).Undefined();                                                \
    }                                                                          \
    MarkChanged();                                                             \
    return Napi::Boolean::New((env), created);                                 \
  } while (0)

// (evaluator, slackMax, capacity, fixStartCumulToZero, name) -> created
Napi::Value RoutingModelWrap::AddDimension(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  int64_t evaluator, slack_max, capacity;
  DimensionTail tail;
  if (!ReadIntInRange(env, info[0], 0, kMaxInt, "evaluator", &evaluator) ||
      !ReadNonNegative(env, info[1], true, "slackMax", &slack_max) ||
      !ReadNonNegative(env, info[2], true, "capacity", &capacity) || !ReadDimensionTail(env, info[3], info[4], &tail) ||
      !CheckOpen(env, "addDimension()") || !CheckEvaluator(env, evaluator)) {
    return env.Undefined();
  }
  ADD_DIMENSION(env, "addDimension()",
                model_->AddDimension(static_cast<int>(evaluator), slack_max, capacity, tail.fix_start_cumul_to_zero,
                                     tail.name));
}

// (evaluator, slackMax, capacities[], fixStartCumulToZero, name) -> created
Napi::Value RoutingModelWrap::AddDimensionWithVehicleCapacity(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  int64_t evaluator, slack_max;
  std::vector<int64_t> capacities;
  DimensionTail tail;
  if (!ReadIntInRange(env, info[0], 0, kMaxInt, "evaluator", &evaluator) ||
      !ReadNonNegative(env, info[1], true, "slackMax", &slack_max) ||
      !ReadNonNegativeArray(env, info[2], static_cast<size_t>(vehicles_), "capacities", &capacities) ||
      !ReadDimensionTail(env, info[3], info[4], &tail) || !CheckOpen(env, "addDimensionWithVehicleCapacity()") ||
      !CheckEvaluator(env, evaluator)) {
    return env.Undefined();
  }
  ADD_DIMENSION(env, "addDimensionWithVehicleCapacity()",
                model_->AddDimensionWithVehicleCapacity(static_cast<int>(evaluator), slack_max, std::move(capacities),
                                                        tail.fix_start_cumul_to_zero, tail.name));
}

namespace {

bool ReadEvaluators(Napi::Env env, const Napi::Value& v, int64_t vehicles, std::vector<int>* out) {
  std::vector<int64_t> ids;
  if (!ReadIntArrayInRange(env, v, 0, kMaxInt, "evaluators", &ids)) return false;
  if (ids.size() != static_cast<size_t>(vehicles)) {
    THROW_AND_RETURN(env, "evaluators must have one entry per vehicle (" + std::to_string(vehicles) + ")", false);
  }
  out->assign(ids.begin(), ids.end());
  return true;
}

}  // namespace

// (evaluators[], slackMax, capacity, fixStartCumulToZero, name) -> created
Napi::Value RoutingModelWrap::AddDimensionWithVehicleTransits(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  std::vector<int> evaluators;
  int64_t slack_max, capacity;
  DimensionTail tail;
  if (!ReadEvaluators(env, info[0], vehicles_, &evaluators) ||
      !ReadNonNegative(env, info[1], true, "slackMax", &slack_max) ||
      !ReadNonNegative(env, info[2], true, "capacity", &capacity) || !ReadDimensionTail(env, info[3], info[4], &tail) ||
      !CheckOpen(env, "addDimensionWithVehicleTransits()")) {
    return env.Undefined();
  }
  for (int id : evaluators) {
    if (!CheckEvaluator(env, id)) return env.Undefined();
  }
  ADD_DIMENSION(env, "addDimensionWithVehicleTransits()",
                model_->AddDimensionWithVehicleTransits(evaluators, slack_max, capacity, tail.fix_start_cumul_to_zero,
                                                        tail.name));
}

// (evaluators[], slackMax, capacities[], fixStartCumulToZero, name) -> created
Napi::Value RoutingModelWrap::AddDimensionWithVehicleTransitAndCapacity(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  std::vector<int> evaluators;
  int64_t slack_max;
  std::vector<int64_t> capacities;
  DimensionTail tail;
  if (!ReadEvaluators(env, info[0], vehicles_, &evaluators) ||
      !ReadNonNegative(env, info[1], true, "slackMax", &slack_max) ||
      !ReadNonNegativeArray(env, info[2], static_cast<size_t>(vehicles_), "capacities", &capacities) ||
      !ReadDimensionTail(env, info[3], info[4], &tail) ||
      !CheckOpen(env, "addDimensionWithVehicleTransitAndCapacity()")) {
    return env.Undefined();
  }
  for (int id : evaluators) {
    if (!CheckEvaluator(env, id)) return env.Undefined();
  }
  ADD_DIMENSION(env, "addDimensionWithVehicleTransitAndCapacity()",
                model_->AddDimensionWithVehicleTransitAndCapacity(evaluators, slack_max, std::move(capacities),
                                                                  tail.fix_start_cumul_to_zero, tail.name));
}

#undef ADD_DIMENSION

// Runs an Add*Dimension call returning (evaluator, created).
#define ADD_DIMENSION_PAIR(env, what, call)                                        \
  do {                                                                           \
    std::pair<int, bool> result{-1, false};                                      \
    if (!context_->RunGuarded((env), (what), [&] { result = (call); })) {        \
      return (env).Undefined();                                                  \
    }                                                                            \
    NoteEvaluator(result.first);                                                 \
    MarkChanged();                                                               \
    return PairToJs((env), result.first, result.second);                         \
  } while (0)

// (value, capacity, fixStartCumulToZero, name) -> [evaluator, created]
Napi::Value RoutingModelWrap::AddConstantDimension(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  int64_t value, capacity;
  DimensionTail tail;
  if (!ReadInt64(env, info[0], false, "value", &value) || !ReadNonNegative(env, info[1], true, "capacity", &capacity) ||
      !ReadDimensionTail(env, info[2], info[3], &tail) || !CheckOpen(env, "addConstantDimension()")) {
    return env.Undefined();
  }
  ADD_DIMENSION_PAIR(env, "addConstantDimension()",
                     model_->AddConstantDimension(value, capacity, tail.fix_start_cumul_to_zero, tail.name));
}

// (values: one per node, capacity, fixStartCumulToZero, name) -> [evaluator, created]
Napi::Value RoutingModelWrap::AddVectorDimension(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  std::vector<int64_t> values;
  int64_t capacity;
  DimensionTail tail;
  if (!ReadInt64Array(env, info[0], true, "values", &values)) return env.Undefined();
  if (values.size() != static_cast<size_t>(nodes_)) {
    THROW_AND_RETURN(env, "values must have one entry per node (" + std::to_string(nodes_) + ")", env.Undefined());
  }
  if (!ReadNonNegative(env, info[1], true, "capacity", &capacity) || !ReadDimensionTail(env, info[2], info[3], &tail) ||
      !CheckOpen(env, "addVectorDimension()")) {
    return env.Undefined();
  }
  ADD_DIMENSION_PAIR(env, "addVectorDimension()",
                     model_->AddVectorDimension(std::move(values), capacity, tail.fix_start_cumul_to_zero, tail.name));
}

// (matrix: numNodes x numNodes, capacity, fixStartCumulToZero, name) -> [evaluator, created]
Napi::Value RoutingModelWrap::AddMatrixDimension(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  std::vector<std::vector<int64_t>> matrix;
  int64_t capacity;
  DimensionTail tail;
  if (!ReadInt64Matrix(env, info[0], static_cast<size_t>(nodes_), static_cast<size_t>(nodes_), "matrix", &matrix) ||
      !ReadNonNegative(env, info[1], true, "capacity", &capacity) || !ReadDimensionTail(env, info[2], info[3], &tail) ||
      !CheckOpen(env, "addMatrixDimension()")) {
    return env.Undefined();
  }
  ADD_DIMENSION_PAIR(env, "addMatrixDimension()",
                     model_->AddMatrixDimension(std::move(matrix), capacity, tail.fix_start_cumul_to_zero, tail.name));
}

#undef ADD_DIMENSION_PAIR

Napi::Value RoutingModelWrap::HasDimension(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  std::string name;
  if (!ReadString(env, info[0], "name", &name) || !CheckUsable(env)) return env.Undefined();
  return Napi::Boolean::New(env, model_->HasDimension(name));
}

// (name, kind: 'cumul' | 'slack' | 'transit', index) -> variable id
Napi::Value RoutingModelWrap::DimensionVar(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  std::string name, kind;
  if (!ReadString(env, info[0], "name", &name) || !ReadString(env, info[1], "kind", &kind)) return env.Undefined();
  // Cumuls exist for every index; slacks and transits only for indices with a next.
  const bool cumul = kind == "cumul";
  if (!cumul && kind != "slack" && kind != "transit") {
    THROW_TYPE_AND_RETURN(env, "unknown dimension variable kind '" + kind + "'", env.Undefined());
  }
  int64_t index;
  if (!ReadIntInRange(env, info[2], 0, (cumul ? size_ + vehicles_ : size_) - 1, "index", &index) ||
      !CheckUsable(env)) {
    return env.Undefined();
  }
  RoutingDimension* dimension = DimensionNamed(env, name);
  if (dimension == nullptr) return env.Undefined();
  IntVar* var = cumul ? dimension->CumulVar(index)
                      : kind == "slack" ? dimension->SlackVar(index) : dimension->TransitVar(index);
  return VarToJs(env, var);
}

// (name, upperBound, vehicle)
Napi::Value RoutingModelWrap::SetSpanUpperBoundForVehicle(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  std::string name;
  int64_t bound, vehicle;
  if (!ReadString(env, info[0], "name", &name) || !ReadNonNegative(env, info[1], true, "upperBound", &bound) ||
      !ReadIntInRange(env, info[2], 0, vehicles_ - 1, "vehicle", &vehicle) ||
      !CheckOpen(env, "setSpanUpperBoundForVehicle()")) {
    return env.Undefined();
  }
  RoutingDimension* dimension = DimensionNamed(env, name);
  if (dimension == nullptr) return env.Undefined();
  GuardCpp(env, "setSpanUpperBoundForVehicle()",
           [&] { dimension->SetSpanUpperBoundForVehicle(bound, static_cast<int>(vehicle)); });
  MarkChanged();
  return env.Undefined();
}

// (name, coefficient, vehicle)
Napi::Value RoutingModelWrap::SetSpanCostCoefficientForVehicle(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  std::string name;
  int64_t coefficient, vehicle;
  if (!ReadString(env, info[0], "name", &name) || !ReadNonNegative(env, info[1], false, "coefficient", &coefficient) ||
      !ReadIntInRange(env, info[2], 0, vehicles_ - 1, "vehicle", &vehicle) ||
      !CheckOpen(env, "setSpanCostCoefficientForVehicle()")) {
    return env.Undefined();
  }
  RoutingDimension* dimension = DimensionNamed(env, name);
  if (dimension == nullptr) return env.Undefined();
  GuardCpp(env, "setSpanCostCoefficientForVehicle()",
           [&] { dimension->SetSpanCostCoefficientForVehicle(coefficient, static_cast<int>(vehicle)); });
  MarkChanged();
  return env.Undefined();
}

// (name, coefficient)
Napi::Value RoutingModelWrap::SetSpanCostCoefficientForAllVehicles(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  std::string name;
  int64_t coefficient;
  if (!ReadString(env, info[0], "name", &name) || !ReadNonNegative(env, info[1], false, "coefficient", &coefficient) ||
      !CheckOpen(env, "setSpanCostCoefficientForAllVehicles()")) {
    return env.Undefined();
  }
  RoutingDimension* dimension = DimensionNamed(env, name);
  if (dimension == nullptr) return env.Undefined();
  GuardCpp(env, "setSpanCostCoefficientForAllVehicles()",
           [&] { dimension->SetSpanCostCoefficientForAllVehicles(coefficient); });
  MarkChanged();
  return env.Undefined();
}

// (name, coefficient)
Napi::Value RoutingModelWrap::SetGlobalSpanCostCoefficient(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  std::string name;
  int64_t coefficient;
  if (!ReadString(env, info[0], "name", &name) || !ReadNonNegative(env, info[1], false, "coefficient", &coefficient) ||
      !CheckOpen(env, "setGlobalSpanCostCoefficient()")) {
    return env.Undefined();
  }
  RoutingDimension* dimension = DimensionNamed(env, name);
  if (dimension == nullptr) return env.Undefined();
  GuardCpp(env, "setGlobalSpanCostCoefficient()", [&] { dimension->SetGlobalSpanCostCoefficient(coefficient); });
  MarkChanged();
  return env.Undefined();
}

// (name, upper: boolean, index, bound, coefficient): SetCumulVarSoftUpperBound
// or SetCumulVarSoftLowerBound. The coefficient feeds MakeSemiContinuousExpr,
// which requires it to be >= 0.
Napi::Value RoutingModelWrap::SetCumulVarSoftBound(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  std::string name;
  const bool upper = info[1].ToBoolean();
  int64_t index, bound, coefficient;
  if (!ReadString(env, info[0], "name", &name) ||
      !ReadIntInRange(env, info[2], 0, size_ + vehicles_ - 1, "index", &index) ||
      !ReadInt64(env, info[3], false, upper ? "upperBound" : "lowerBound", &bound) ||
      !ReadNonNegative(env, info[4], false, "coefficient", &coefficient) ||
      !CheckOpen(env, upper ? "setCumulVarSoftUpperBound()" : "setCumulVarSoftLowerBound()")) {
    return env.Undefined();
  }
  RoutingDimension* dimension = DimensionNamed(env, name);
  if (dimension == nullptr) return env.Undefined();
  GuardCpp(env, "setCumulVarSoftBound()", [&] {
    if (upper) {
      dimension->SetCumulVarSoftUpperBound(index, bound, coefficient);
    } else {
      dimension->SetCumulVarSoftLowerBound(index, bound, coefficient);
    }
  });
  MarkChanged();
  return env.Undefined();
}

}  // namespace ortools_node
