// Bridge between protobuf messages and JS, through proto3 JSON.
//
// The JS layer sends JSON.stringify(object). Parsing keeps protobuf's own field
// names, enum names and type checks, and then rejects what the JSON parser lets
// through: unknown fields, NaN, and enum numbers with no named value.

#ifndef ORTOOLS_NODE_COMMON_PROTO_JSON_H_
#define ORTOOLS_NODE_COMMON_PROTO_JSON_H_

#include <napi.h>

#include <string>

#include "google/protobuf/descriptor.h"
#include "google/protobuf/message.h"

namespace ortools_node {

// Parses a JSON string argument into *out (cleared first) and checks every
// parsed value. On failure throws a TypeError naming `what` and returns false.
bool ParseProtoJson(Napi::Env env, const Napi::Value& json, const char* what, google::protobuf::Message* out);
bool ParseProtoJson(Napi::Env env, const std::string& json, const char* what, google::protobuf::Message* out);

// Prints every field, including those left at their proto3 default, with
// lowerCamelCase names. On failure throws and returns env.Undefined().
Napi::Value ProtoToJson(Napi::Env env, const google::protobuf::Message& message);

// Sets every unset singular scalar field (outside oneofs) to its declared
// default, so a printed proto2 message shows its defaults instead of omitting them.
void SetUnsetScalarsToDefaults(google::protobuf::Message* message);

// Frozen { NAME: 'NAME' } object listing the values of a protobuf enum, so the
// JS constants always match the OR-Tools version the addon was built against.
Napi::Object EnumNames(Napi::Env env, const google::protobuf::EnumDescriptor* descriptor);

// Duration, Timestamp, Struct and the other google.protobuf types with a
// special JSON form.
inline bool IsWellKnownType(const google::protobuf::Descriptor* descriptor) {
  return descriptor->well_known_type() != google::protobuf::Descriptor::WELLKNOWNTYPE_UNSPECIFIED;
}

}  // namespace ortools_node

#endif  // ORTOOLS_NODE_COMMON_PROTO_JSON_H_
