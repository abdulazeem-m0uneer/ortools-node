// Converts a protobuf message into a plain JS object by reflection, in the
// shape of protobuf's JSON mapping but with JS types where they are exact.

#ifndef ORTOOLS_NODE_COMMON_PROTO_TO_JS_H_
#define ORTOOLS_NODE_COMMON_PROTO_TO_JS_H_

#include <napi.h>

#include "google/protobuf/message.h"

namespace ortools_node {

// lowerCamelCase keys. Doubles and floats are numbers (±Infinity included),
// int64 and uint64 decimal strings, enums names, bytes base64, repeated
// fields arrays, sub-messages objects, and well-known types (Duration, ...)
// their protobuf JSON value. Fields without presence (proto3 scalars, repeated
// fields) are always listed; fields with presence only when set.
// Throws and returns env.Undefined() on failure.
Napi::Value MessageToJs(Napi::Env env, const google::protobuf::Message& message);

}  // namespace ortools_node

#endif  // ORTOOLS_NODE_COMMON_PROTO_TO_JS_H_
