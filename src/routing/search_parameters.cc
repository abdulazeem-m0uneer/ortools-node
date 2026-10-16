// RoutingSearchParameters as plain JS objects (pywrapcp's
// DefaultRoutingSearchParameters() and routing_enums_pb2).

#include "routing/search_parameters.h"

#include <string>

#include "common/proto_json.h"
#include "common/proto_merge.h"
#include "common/proto_to_js.h"
#include "ortools/constraint_solver/routing_enums.pb.h"
#include "ortools/constraint_solver/routing_parameters.h"

namespace ortools_node {

using operations_research::RoutingSearchParameters;

namespace {

bool CheckParameters(Napi::Env env, const RoutingSearchParameters& parameters) {
  const std::string error = operations_research::FindErrorInRoutingSearchParameters(parameters);
  if (error.empty()) return true;
  Napi::RangeError::New(env, "Invalid RoutingSearchParameters: " + error).ThrowAsJavaScriptException();
  return false;
}

// The defaults with the caller's overrides (JSON in info[0]) merged on top, validated.
bool ReadOverrides(const Napi::CallbackInfo& info, RoutingSearchParameters* out) {
  *out = operations_research::DefaultRoutingSearchParameters();
  return MergeProtoJson(info.Env(), info[0], "RoutingSearchParameters", out) && CheckParameters(info.Env(), *out);
}

Napi::Value DefaultParameters(const Napi::CallbackInfo& info) {
  return MessageToJs(info.Env(), operations_research::DefaultRoutingSearchParameters());
}

Napi::Value ValidateParameters(const Napi::CallbackInfo& info) {
  RoutingSearchParameters parameters;
  if (!ReadOverrides(info, &parameters)) return info.Env().Undefined();
  return MessageToJs(info.Env(), parameters);
}

// The same full parameter set as JSON, for ReadRoutingSearchParameters.
Napi::Value ParametersJson(const Napi::CallbackInfo& info) {
  RoutingSearchParameters parameters;
  if (!ReadOverrides(info, &parameters)) return info.Env().Undefined();
  return ProtoToJson(info.Env(), parameters);
}

}  // namespace

bool ReadRoutingSearchParameters(Napi::Env env, const Napi::Value& json, RoutingSearchParameters* out) {
  return ParseProtoJson(env, json, "RoutingSearchParameters", out) && CheckParameters(env, *out);
}

void InitRoutingSearchParameters(Napi::Env env, Napi::Object exports) {
  exports.Set("defaultRoutingSearchParameters", Napi::Function::New(env, DefaultParameters));
  exports.Set("validateRoutingSearchParameters", Napi::Function::New(env, ValidateParameters));
  exports.Set("routingSearchParametersJson", Napi::Function::New(env, ParametersJson));
  exports.Set("FirstSolutionStrategy",
              EnumNames(env, operations_research::FirstSolutionStrategy::Value_descriptor()));
  exports.Set("LocalSearchMetaheuristic",
              EnumNames(env, operations_research::LocalSearchMetaheuristic::Value_descriptor()));
  exports.Set("RoutingSearchStatus",
              EnumNames(env, operations_research::RoutingSearchStatus::Value_descriptor()));
}

}  // namespace ortools_node
