// Applies a caller's partial parameters, sent as JSON, onto a base message.
//
// Only keys present in the JSON change the base: a nested object merges into
// the sub-message field by field, null keeps the base value, and any other
// value (including 0 and false) replaces it. Setting one member of a oneof
// clears the others, as protobuf's generated setters do.

#ifndef ORTOOLS_NODE_COMMON_PROTO_MERGE_H_
#define ORTOOLS_NODE_COMMON_PROTO_MERGE_H_

#include <napi.h>

#include "google/protobuf/message.h"

namespace ortools_node {

// Parses and checks `json` like ParseProtoJson, then merges the keys it holds
// onto *target. Keys may be lowerCamelCase or snake_case, but naming one field
// twice is an error, and so are null array elements and Infinity markers (see
// lib/params.js) anywhere but as the whole value of a float or double field.
// On failure throws a TypeError naming `what`, leaves *target unchanged and
// returns false.
bool MergeProtoJson(Napi::Env env, const Napi::Value& json, const char* what, google::protobuf::Message* target);

}  // namespace ortools_node

#endif  // ORTOOLS_NODE_COMMON_PROTO_MERGE_H_
