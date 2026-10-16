// RoutingSearchParameters as plain JS objects (pywrapcp's
// DefaultRoutingSearchParameters() and routing_enums_pb2).

#include "routing/search_parameters.h"

#include <string>

#include "common/proto_json.h"
#include "ortools/constraint_solver/routing_enums.pb.h"
#include "ortools/constraint_solver/routing_parameters.h"

namespace ortools_node {

using operations_research::RoutingSearchParameters;

bool ReadRoutingSearchParameters(Napi::Env env, const Napi::Value& json, RoutingSearchParameters* out) {
  if (!ParseProtoJson(env, json, "RoutingSearchParameters", out)) return false;
  const std::string error = operations_research::FindErrorInRoutingSearchParameters(*out);
  if (!error.empty()) {
    Napi::RangeError::New(env, "Invalid RoutingSearchParameters: " + error).ThrowAsJavaScriptException();
    return false;
  }
  return true;
}

namespace {

Napi::Value DefaultParameters(const Napi::CallbackInfo& info) {
  return ProtoToJson(info.Env(), operations_research::DefaultRoutingSearchParameters());
}

// Validates and returns the full parameter set, with defaults for omitted fields.
Napi::Value CanonicalParameters(const Napi::CallbackInfo& info) {
  RoutingSearchParameters parameters;
  if (!ReadRoutingSearchParameters(info.Env(), info[0], &parameters)) return info.Env().Undefined();
  return ProtoToJson(info.Env(), parameters);
}

}  // namespace

void InitRoutingSearchParameters(Napi::Env env, Napi::Object exports) {
  exports.Set("defaultRoutingSearchParameters", Napi::Function::New(env, DefaultParameters));
  exports.Set("canonicalRoutingSearchParameters", Napi::Function::New(env, CanonicalParameters));
  exports.Set("FirstSolutionStrategy",
              EnumNames(env, operations_research::FirstSolutionStrategy::Value_descriptor()));
  exports.Set("LocalSearchMetaheuristic",
              EnumNames(env, operations_research::LocalSearchMetaheuristic::Value_descriptor()));
  exports.Set("RoutingSearchStatus",
              EnumNames(env, operations_research::RoutingSearchStatus::Value_descriptor()));
}

}  // namespace ortools_node
