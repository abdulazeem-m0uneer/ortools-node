#include "common/proto_json.h"

#include <cmath>
#include <cstdint>
#include <string>
#include <vector>

#include "absl/status/status.h"
#include "absl/strings/str_cat.h"
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

std::string EnumError(const std::string& path, const FieldDescriptor* field, int64_t number) {
  return absl::StrCat("'", path, "': no ", field->enum_type()->name(), " value has number ", number);
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

}  // namespace

bool ParseProtoJson(Napi::Env env, const Napi::Value& json, const char* what, google::protobuf::Message* out) {
  if (!json.IsString()) {
    Napi::TypeError::New(env, std::string(what) + " must be a JSON string").ThrowAsJavaScriptException();
    return false;
  }
  out->Clear();
  google::protobuf::json::ParseOptions options;
  options.ignore_unknown_fields = false;
  absl::Status status = google::protobuf::json::JsonStringToMessage(json.As<Napi::String>().Utf8Value(), out, options);
  const std::string error = status.ok() ? FindInvalidValue(*out, "") : std::string(status.message());
  if (!error.empty()) {
    Napi::TypeError::New(env, absl::StrCat("Invalid ", what, ": ", error)).ThrowAsJavaScriptException();
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
