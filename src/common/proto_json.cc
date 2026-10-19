#include "common/proto_json.h"

#include <cmath>
#include <cstdint>
#include <string>
#include <vector>

#include "absl/status/status.h"
#include "absl/strings/ascii.h"
#include "absl/strings/match.h"
#include "absl/strings/str_cat.h"
#include "absl/strings/string_view.h"
#include "google/protobuf/json/json.h"
#include "google/protobuf/unknown_field_set.h"

namespace ortools_node {

namespace {

using google::protobuf::FieldDescriptor;
using google::protobuf::Message;
using google::protobuf::Reflection;

std::string FieldPath(const std::string& parent, const FieldDescriptor* field) {
  return parent.empty() ? std::string(field->json_name()) : absl::StrCat(parent, ".", field->json_name());
}

// Routing enums are nested as e.g. FirstSolutionStrategy.Value, so name the containing message too.
std::string EnumError(const std::string& path, const FieldDescriptor* field, int64_t number) {
  const google::protobuf::EnumDescriptor* type = field->enum_type();
  const google::protobuf::Descriptor* container = type->containing_type();
  return absl::StrCat("'", path, "': no ", container == nullptr ? "" : absl::StrCat(container->name(), "."),
                      type->name(), " value has number ", number);
}

// Closed (proto2) enums keep numbers they do not know as unknown fields.
std::string UnknownFieldError(const Message& message, const google::protobuf::UnknownField& unknown,
                              const std::string& path) {
  const FieldDescriptor* field = message.GetDescriptor()->FindFieldByNumber(unknown.number());
  if (field != nullptr && field->cpp_type() == FieldDescriptor::CPPTYPE_ENUM &&
      unknown.type() == google::protobuf::UnknownField::TYPE_VARINT) {
    return EnumError(FieldPath(path, field), field, static_cast<int64_t>(unknown.varint()));
  }
  return absl::StrCat("unknown field number ", unknown.number(), " in '", path.empty() ? "." : path, "'");
}

std::string FindInvalidValue(const Message& message, const std::string& path);

// Checks one value of `field`: element `index` when repeated, the value when index < 0.
std::string FindInvalidFieldValue(const Message& message, const FieldDescriptor* field, int index,
                                  const std::string& path) {
  const Reflection* reflection = message.GetReflection();
  const bool repeated = index >= 0;
  switch (field->cpp_type()) {
    case FieldDescriptor::CPPTYPE_DOUBLE: {
      const double value =
          repeated ? reflection->GetRepeatedDouble(message, field, index) : reflection->GetDouble(message, field);
      return std::isnan(value) ? absl::StrCat("'", path, "' must not be NaN") : "";
    }
    case FieldDescriptor::CPPTYPE_FLOAT: {
      const float value =
          repeated ? reflection->GetRepeatedFloat(message, field, index) : reflection->GetFloat(message, field);
      return std::isnan(value) ? absl::StrCat("'", path, "' must not be NaN") : "";
    }
    case FieldDescriptor::CPPTYPE_ENUM: {
      const int value = repeated ? reflection->GetRepeatedEnumValue(message, field, index)
                                 : reflection->GetEnumValue(message, field);
      return field->enum_type()->FindValueByNumber(value) == nullptr ? EnumError(path, field, value) : "";
    }
    case FieldDescriptor::CPPTYPE_MESSAGE:
      return FindInvalidValue(
          repeated ? reflection->GetRepeatedMessage(message, field, index) : reflection->GetMessage(message, field),
          path);
    default:
      return "";
  }
}

// The first NaN, enum number without a name or unknown field set in `message`, or "".
std::string FindInvalidValue(const Message& message, const std::string& path) {
  const Reflection* reflection = message.GetReflection();
  const google::protobuf::UnknownFieldSet& unknown = reflection->GetUnknownFields(message);
  if (!unknown.empty()) return UnknownFieldError(message, unknown.field(0), path);
  std::vector<const FieldDescriptor*> fields;
  reflection->ListFields(message, &fields);
  for (const FieldDescriptor* field : fields) {
    const std::string field_path = FieldPath(path, field);
    if (!field->is_repeated()) {
      std::string error = FindInvalidFieldValue(message, field, -1, field_path);
      if (!error.empty()) return error;
      continue;
    }
    for (int i = 0; i < reflection->FieldSize(message, field); ++i) {
      std::string error = FindInvalidFieldValue(message, field, i, absl::StrCat(field_path, "[", i, "]"));
      if (!error.empty()) return error;
    }
  }
  return "";
}

// The helpers below scan linearly on purpose. protobuf's errors echo the
// caller's text, and libstdc++'s std::regex recurses once per character, so a
// long value overflowed the stack (never use std::regex in this codebase).

bool IsSpace(char c) { return absl::ascii_isspace(static_cast<unsigned char>(c)); }

size_t SkipDigits(absl::string_view text, size_t i) {
  while (i < text.size() && absl::ascii_isdigit(static_cast<unsigned char>(text[i]))) ++i;
  return i;
}

// The end of ",? near <digits>:<digits> (offset <digits>)" starting at
// `start`, where each space may be any run of whitespace, or `start`. Only
// where the ':' that follows every real position comes next, so a lookalike
// inside the caller's value is not one.
size_t MatchJsonPosition(absl::string_view text, size_t start) {
  size_t i = start;
  // Consumes `literal` after at least one whitespace character; false if absent.
  const auto spaced = [&](absl::string_view literal) {
    const size_t before = i;
    while (i < text.size() && IsSpace(text[i])) ++i;
    if (i == before || !absl::StartsWith(text.substr(i), literal)) return false;
    i += literal.size();
    return true;
  };
  const auto digits = [&] {
    const size_t before = i;
    i = SkipDigits(text, i);
    return i != before;
  };
  if (i < text.size() && text[i] == ',') ++i;
  if (!spaced("near") || !spaced("") || !digits() || i >= text.size() || text[i++] != ':' || !digits() ||
      !spaced("(offset") || !spaced("") || !digits() || i + 1 >= text.size() || text[i] != ')' ||
      text[i + 1] != ':') {
    return start;
  }
  return i + 1;
}

// Where protobuf quotes a value, which may be the caller's text verbatim
// (unescaped, so it may hold quotes itself): a quote after a space, ':' or
// '(' opens.
bool OpensQuote(absl::string_view text, size_t i) {
  return text[i] == '\'' && (i == 0 || IsSpace(text[i - 1]) || text[i - 1] == ':' || text[i - 1] == '(');
}

// Drops protobuf's one "near L:C (offset N)" position (which points into JSON
// the binding prints internally) and leaves every other character, spacing
// included, as protobuf wrote it, so the caller's echoed text stays exactly as
// given. protobuf writes that position in its own prefix, before any quoted
// value, so the search for it ends at the first opening quote and never looks
// inside the caller's text.
std::string StripJsonPosition(absl::string_view text) {
  for (size_t i = 0; i < text.size() && !OpensQuote(text, i); ++i) {
    // Only where a position can begin (a comma, or the first of a run of
    // spaces), so a long run is scanned once and the search stays linear.
    if (text[i] != ',' && !(IsSpace(text[i]) && (i == 0 || !IsSpace(text[i - 1])))) continue;
    const size_t end = MatchJsonPosition(text, i);
    if (end != i) return absl::StrCat(text.substr(0, i), text.substr(end));
  }
  return std::string(text);
}

// Struct parse errors name internal paths such as " @ <struct>[0].struct_value.<struct>[0]...: ",
// where protobuf may write any run of whitespace in place of each space.
std::string StripStructPath(std::string text) {
  for (size_t at = text.find('@'); at != std::string::npos; at = text.find('@', at + 1)) {
    size_t start = at;
    while (start > 0 && IsSpace(text[start - 1])) --start;
    size_t path = at + 1;
    while (path < text.size() && IsSpace(text[path])) ++path;
    const bool spaced = start != at && path != at + 1;
    if (!spaced || !absl::StartsWith(absl::string_view(text).substr(path), "<struct>")) continue;
    size_t end = text.find(':', path);
    while (end != std::string::npos && (end + 1 == text.size() || !IsSpace(text[end + 1]))) end = text.find(':', end + 1);
    text.erase(start, end == std::string::npos ? std::string::npos : end - start);
    return text;
  }
  return text;
}

}  // namespace

std::string Abbreviate(absl::string_view text, size_t max_bytes) {
  if (text.size() <= max_bytes) return std::string(text);
  size_t cut = max_bytes;
  while (cut > 0 && (static_cast<unsigned char>(text[cut]) & 0xC0) == 0x80) --cut;  // keep UTF-8 whole
  return absl::StrCat(text.substr(0, cut), "\xE2\x80\xA6");  // "…" in UTF-8
}

std::string BoundedErrorMessage(absl::string_view message) { return Abbreviate(message, kMaxErrorMessageBytes); }

std::string JsonParseErrorMessage(const absl::Status& status) { return StripJsonPosition(status.message()); }

// Only here: a parameter message has no Struct field, so its errors cannot hold
// a Struct path, and " @ <struct>" in them is the caller's own value.
std::string StructParseErrorMessage(const absl::Status& status) {
  return StripStructPath(JsonParseErrorMessage(status));
}

bool ParseProtoJson(Napi::Env env, const Napi::Value& json, const char* what, google::protobuf::Message* out) {
  if (!json.IsString()) {
    Napi::TypeError::New(env, std::string(what) + " must be a JSON string").ThrowAsJavaScriptException();
    return false;
  }
  return ParseProtoJson(env, json.As<Napi::String>().Utf8Value(), what, out);
}

bool ParseProtoJson(Napi::Env env, const std::string& json, const char* what, google::protobuf::Message* out) {
  out->Clear();
  google::protobuf::json::ParseOptions options;
  options.ignore_unknown_fields = false;
  absl::Status status = google::protobuf::json::JsonStringToMessage(json, out, options);
  const std::string error = status.ok() ? FindInvalidValue(*out, "") : JsonParseErrorMessage(status);
  if (!error.empty()) {
    Napi::TypeError::New(env, BoundedErrorMessage(absl::StrCat("Invalid ", what, ": ", error)))
        .ThrowAsJavaScriptException();
    return false;
  }
  return true;
}

Napi::Value ProtoToJson(Napi::Env env, const google::protobuf::Message& message) {
  google::protobuf::json::PrintOptions options;
  options.always_print_fields_with_no_presence = true;
  std::string json;
  absl::Status status = google::protobuf::json::MessageToJsonString(message, &json, options);
  if (!status.ok()) {
    Napi::Error::New(env, "Cannot convert " + std::string(message.GetTypeName()) + " to JSON: " +
                              std::string(status.message()))
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }
  return Napi::String::New(env, json);
}

void SetUnsetScalarsToDefaults(google::protobuf::Message* message) {
  const google::protobuf::Descriptor* descriptor = message->GetDescriptor();
  const google::protobuf::Reflection* reflection = message->GetReflection();
  for (int i = 0; i < descriptor->field_count(); ++i) {
    const FieldDescriptor* field = descriptor->field(i);
    if (field->is_repeated() || field->real_containing_oneof() != nullptr || !field->has_presence() ||
        reflection->HasField(*message, field)) {
      continue;
    }
    switch (field->cpp_type()) {
      case FieldDescriptor::CPPTYPE_INT32: reflection->SetInt32(message, field, field->default_value_int32()); break;
      case FieldDescriptor::CPPTYPE_INT64: reflection->SetInt64(message, field, field->default_value_int64()); break;
      case FieldDescriptor::CPPTYPE_UINT32: reflection->SetUInt32(message, field, field->default_value_uint32()); break;
      case FieldDescriptor::CPPTYPE_UINT64: reflection->SetUInt64(message, field, field->default_value_uint64()); break;
      case FieldDescriptor::CPPTYPE_DOUBLE: reflection->SetDouble(message, field, field->default_value_double()); break;
      case FieldDescriptor::CPPTYPE_FLOAT: reflection->SetFloat(message, field, field->default_value_float()); break;
      case FieldDescriptor::CPPTYPE_BOOL: reflection->SetBool(message, field, field->default_value_bool()); break;
      case FieldDescriptor::CPPTYPE_ENUM: reflection->SetEnum(message, field, field->default_value_enum()); break;
      case FieldDescriptor::CPPTYPE_STRING:
        reflection->SetString(message, field, std::string(field->default_value_string()));
        break;
      case FieldDescriptor::CPPTYPE_MESSAGE: break;  // sub-messages stay unset (e.g. time limits)
    }
  }
}

Napi::Object EnumNames(Napi::Env env, const google::protobuf::EnumDescriptor* descriptor) {
  Napi::Object names = Napi::Object::New(env);
  for (int i = 0; i < descriptor->value_count(); ++i) {
    const std::string name(descriptor->value(i)->name());
    names.Set(name, Napi::String::New(env, name));
  }
  names.Freeze();
  return names;
}

}  // namespace ortools_node
