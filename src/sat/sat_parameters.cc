// SatParameters as plain JS objects (cp_model.CpSolver().parameters).

#include "sat/sat_parameters.h"

#include <string>

#include "common/proto_json.h"
#include "ortools/sat/parameters_validation.h"

namespace ortools_node {

using operations_research::sat::SatParameters;

bool ReadSatParameters(Napi::Env env, const Napi::Value& json, SatParameters* out) {
  if (!ParseProtoJson(env, json, "SatParameters", out)) return false;
  const std::string error = operations_research::sat::ValidateParameters(*out);
  if (!error.empty()) {
    Napi::RangeError::New(env, "Invalid SatParameters: " + error).ThrowAsJavaScriptException();
    return false;
  }
  return true;
}

namespace {

// SatParameters is proto2, so defaults are only printed once materialised.
Napi::Value DefaultParameters(const Napi::CallbackInfo& info) {
  SatParameters parameters;
  SetUnsetScalarsToDefaults(&parameters);
  return ProtoToJson(info.Env(), parameters);
}

// Validates and returns only the fields that were set (proto2 keeps presence).
Napi::Value CanonicalParameters(const Napi::CallbackInfo& info) {
  SatParameters parameters;
  if (!ReadSatParameters(info.Env(), info[0], &parameters)) return info.Env().Undefined();
  return ProtoToJson(info.Env(), parameters);
}

}  // namespace

void InitSatParameters(Napi::Env env, Napi::Object exports) {
  exports.Set("defaultSatParameters", Napi::Function::New(env, DefaultParameters));
  exports.Set("canonicalSatParameters", Napi::Function::New(env, CanonicalParameters));
}

}  // namespace ortools_node
