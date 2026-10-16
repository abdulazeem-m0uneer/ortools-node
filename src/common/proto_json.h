// Bridge between protobuf messages and JS objects, through proto3 JSON.
//
// The JS layer sends JSON.stringify(object) and receives a JSON string it
// parses back, so parameters keep protobuf's own field names, enum names and
// validation (unknown fields are rejected, never ignored).

#ifndef ORTOOLS_NODE_COMMON_PROTO_JSON_H_
#define ORTOOLS_NODE_COMMON_PROTO_JSON_H_

#include <napi.h>

#include "google/protobuf/descriptor.h"
#include "google/protobuf/message.h"

namespace ortools_node {

// Parses a JSON string argument into *out (cleared first). On failure throws a
// TypeError naming `what` and returns false.
bool ParseProtoJson(Napi::Env env, const Napi::Value& json, const char* what, google::protobuf::Message* out);

// Prints every field, including those left at their proto3 default, with
// lowerCamelCase names. On failure throws and returns env.Undefined().
Napi::Value ProtoToJson(Napi::Env env, const google::protobuf::Message& message);

// Sets every unset singular scalar field (outside oneofs) to its declared
// default, so a printed proto2 message shows its defaults instead of omitting them.
void SetUnsetScalarsToDefaults(google::protobuf::Message* message);

// Frozen { NAME: 'NAME' } object listing the values of a protobuf enum, so the
// JS constants always match the OR-Tools version the addon was built against.
Napi::Object EnumNames(Napi::Env env, const google::protobuf::EnumDescriptor* descriptor);

}  // namespace ortools_node

#endif  // ORTOOLS_NODE_COMMON_PROTO_JSON_H_
