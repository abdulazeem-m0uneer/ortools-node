// SatParameters as plain JS objects (cp_model.CpSolver().parameters).

#include "sat/sat_parameters.h"

#include <string>

#include "common/proto_json.h"
#include "common/proto_merge.h"
#include "common/proto_to_js.h"
#include "ortools/sat/parameters_validation.h"

namespace ortools_node {

using operations_research::sat::SatParameters;

namespace {

bool CheckParameters(Napi::Env env, const SatParameters& parameters) {
  const std::string error = operations_research::sat::ValidateParameters(parameters);
  if (error.empty()) return true;
  Napi::RangeError::New(env, BoundedErrorMessage("Invalid SatParameters: " + error)).ThrowAsJavaScriptException();
  return false;
}

// Only the fields the caller set (JSON in info[0]; proto2 keeps presence), validated.
// Merging onto an empty message applies the same key rules as routing parameters.
bool ReadOverrides(const Napi::CallbackInfo& info, SatParameters* out) {
  return MergeProtoJson(info.Env(), info[0], "SatParameters", out) && CheckParameters(info.Env(), *out);
}

// SatParameters is proto2, so defaults are only printed once materialised.
Napi::Value DefaultParameters(const Napi::CallbackInfo& info) {
  SatParameters parameters;
  SetUnsetScalarsToDefaults(&parameters);
  return MessageToJs(info.Env(), parameters);
}

Napi::Value ValidateSatParameters(const Napi::CallbackInfo& info) {
  SatParameters parameters;
  if (!ReadOverrides(info, &parameters)) return info.Env().Undefined();
  return MessageToJs(info.Env(), parameters);
}

// The same fields as JSON, for ReadSatParameters.
Napi::Value ParametersJson(const Napi::CallbackInfo& info) {
  SatParameters parameters;
  if (!ReadOverrides(info, &parameters)) return info.Env().Undefined();
  return ProtoToJson(info.Env(), parameters);
}

// Test hook: the parameters a solver reads (via ReadSatParameters) from the JSON
// that satParametersJson returns.
Napi::Value ReadParametersForTesting(const Napi::CallbackInfo& info) {
  SatParameters parameters;
  if (!ReadSatParameters(info.Env(), info[0], &parameters)) return info.Env().Undefined();
  return MessageToJs(info.Env(), parameters);
}

}  // namespace

bool ReadSatParameters(Napi::Env env, const Napi::Value& json, SatParameters* out) {
  return ParseProtoJson(env, json, "SatParameters", out) && CheckParameters(env, *out);
}

void InitSatParameters(Napi::Env env, Napi::Object exports) {
  exports.Set("defaultSatParameters", Napi::Function::New(env, DefaultParameters));
  exports.Set("validateSatParameters", Napi::Function::New(env, ValidateSatParameters));
  exports.Set("satParametersJson", Napi::Function::New(env, ParametersJson));
  exports.Set("readSatParametersForTesting", Napi::Function::New(env, ReadParametersForTesting));
}

}  // namespace ortools_node
