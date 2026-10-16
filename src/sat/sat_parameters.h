#ifndef ORTOOLS_NODE_SAT_SAT_PARAMETERS_H_
#define ORTOOLS_NODE_SAT_SAT_PARAMETERS_H_

#include <napi.h>

#include "ortools/sat/sat_parameters.pb.h"

namespace ortools_node {

// Parses and validates SatParameters sent as JSON. Throws a TypeError for
// malformed JSON or unknown fields and a RangeError for values CP-SAT rejects.
bool ReadSatParameters(Napi::Env env, const Napi::Value& json, operations_research::sat::SatParameters* out);

// Registers defaultSatParameters and canonicalSatParameters.
void InitSatParameters(Napi::Env env, Napi::Object exports);

}  // namespace ortools_node

#endif  // ORTOOLS_NODE_SAT_SAT_PARAMETERS_H_
