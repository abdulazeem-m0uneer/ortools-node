#ifndef ORTOOLS_NODE_ROUTING_SEARCH_PARAMETERS_H_
#define ORTOOLS_NODE_ROUTING_SEARCH_PARAMETERS_H_

#include <napi.h>

#include "ortools/constraint_solver/routing_parameters.pb.h"

namespace ortools_node {

// Parses and validates a full RoutingSearchParameters set sent as JSON (as
// routingSearchParametersJson returns it). Throws a TypeError for malformed
// JSON, unknown fields, NaN or unnamed enum numbers and a RangeError for values
// OR-Tools rejects; returns false in both cases.
bool ReadRoutingSearchParameters(Napi::Env env, const Napi::Value& json,
                                 operations_research::RoutingSearchParameters* out);

// Registers defaultRoutingSearchParameters, validateRoutingSearchParameters,
// routingSearchParametersJson (the last two take the caller's overrides as JSON),
// the test hook readRoutingSearchParametersForTesting
// and the FirstSolutionStrategy / LocalSearchMetaheuristic / RoutingSearchStatus enums.
void InitRoutingSearchParameters(Napi::Env env, Napi::Object exports);

}  // namespace ortools_node

#endif  // ORTOOLS_NODE_ROUTING_SEARCH_PARAMETERS_H_
