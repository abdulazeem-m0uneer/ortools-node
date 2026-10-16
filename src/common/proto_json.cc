#include "common/proto_json.h"

#include <string>

#include "absl/status/status.h"
#include "google/protobuf/json/json.h"

namespace ortools_node {

bool ParseProtoJson(Napi::Env env, const Napi::Value& json, const char* what, google::protobuf::Message* out) {
  if (!json.IsString()) {
    Napi::TypeError::New(env, std::string(what) + " must be a JSON string").ThrowAsJavaScriptException();
    return false;
  }
  out->Clear();
  google::protobuf::json::ParseOptions options;
  options.ignore_unknown_fields = false;
  absl::Status status = google::protobuf::json::JsonStringToMessage(json.As<Napi::String>().Utf8Value(), out, options);
  if (!status.ok()) {
    Napi::TypeError::New(env, std::string("Invalid ") + what + ": " + std::string(status.message()))
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
  using google::protobuf::FieldDescriptor;
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
