// Bridge between protobuf messages and JS, through proto3 JSON.
//
// The JS layer sends JSON.stringify(object). Parsing keeps protobuf's own field
// names, enum names and type checks, and then rejects what the JSON parser lets
// through: unknown fields, NaN, and enum numbers with no named value.

#ifndef ORTOOLS_NODE_COMMON_PROTO_JSON_H_
#define ORTOOLS_NODE_COMMON_PROTO_JSON_H_

#include <napi.h>

#include <string>

#include "absl/status/status.h"
#include "absl/strings/string_view.h"
#include "google/protobuf/descriptor.h"
#include "google/protobuf/message.h"

namespace ortools_node {

// Parses a JSON string argument into *out (cleared first) and checks every
// parsed value. On failure throws a TypeError naming `what` and returns false.
bool ParseProtoJson(Napi::Env env, const Napi::Value& json, const char* what, google::protobuf::Message* out);
bool ParseProtoJson(Napi::Env env, const std::string& json, const char* what, google::protobuf::Message* out);

// A protobuf JSON parse error without its "near L:C (offset N)" part, which
// points into JSON the caller never saw, and with protobuf's irregular
// whitespace collapsed. The field path and expected type stay. It may echo the
// caller's value at any length: throw it through BoundedErrorMessage.
std::string JsonParseErrorMessage(const absl::Status& status);

// JsonParseErrorMessage for a google.protobuf.Struct parse, also without
// Struct's internal paths ("<struct>[0].struct_value...").
std::string StructParseErrorMessage(const absl::Status& status);

// `text` cut to at most `max_bytes` (on a UTF-8 boundary) plus "…" when longer.
std::string Abbreviate(absl::string_view text, size_t max_bytes);

// Errors echo caller values and keys of any length; every native error that
// can carry one is thrown through this, cut to kMaxErrorMessageBytes.
inline constexpr size_t kMaxErrorMessageBytes = 500;
std::string BoundedErrorMessage(absl::string_view message);

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
