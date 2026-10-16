#include "common/proto_to_js.h"

#include <charconv>
#include <string>

#include "absl/status/status.h"
#include "absl/strings/escaping.h"
#include "absl/strings/str_cat.h"
#include "common/proto_json.h"
#include "google/protobuf/json/json.h"

namespace ortools_node {

namespace {

using google::protobuf::FieldDescriptor;
using google::protobuf::Message;
using google::protobuf::Reflection;

// The shortest decimal that reads back as the same float (as protobuf JSON
// prints it), so 0.1f becomes 0.1 rather than 0.10000000149011612.
double FloatToDouble(float value) {
  char buffer[32];
  const auto printed = std::to_chars(buffer, buffer + sizeof(buffer), value);
  double out = value;
  std::from_chars(buffer, printed.ptr, out);
  return out;
}

// protobuf's own JSON form, parsed by JS: e.g. "0.5s" for a Duration.
Napi::Value WellKnownToJs(Napi::Env env, const Message& message) {
  std::string json;
  absl::Status status = google::protobuf::json::MessageToJsonString(message, &json);
  if (!status.ok()) {
    Napi::Error::New(env, absl::StrCat("Cannot convert ", message.GetTypeName(), " to JSON: ", status.message()))
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }
  Napi::Object json_object = env.Global().Get("JSON").As<Napi::Object>();
  return json_object.Get("parse").As<Napi::Function>().Call(json_object, {Napi::String::New(env, json)});
}

// One value of `field`: element `index` when repeated, the value when index < 0.
Napi::Value FieldValueToJs(Napi::Env env, const Message& message, const FieldDescriptor* field, int index) {
  const Reflection* reflection = message.GetReflection();
  const bool repeated = index >= 0;
  switch (field->cpp_type()) {
    case FieldDescriptor::CPPTYPE_INT32:
      return Napi::Number::New(env, repeated ? reflection->GetRepeatedInt32(message, field, index)
                                             : reflection->GetInt32(message, field));
    case FieldDescriptor::CPPTYPE_UINT32:
      return Napi::Number::New(env, repeated ? reflection->GetRepeatedUInt32(message, field, index)
                                             : reflection->GetUInt32(message, field));
    case FieldDescriptor::CPPTYPE_INT64:
      return Napi::String::New(env, absl::StrCat(repeated ? reflection->GetRepeatedInt64(message, field, index)
                                                          : reflection->GetInt64(message, field)));
    case FieldDescriptor::CPPTYPE_UINT64:
      return Napi::String::New(env, absl::StrCat(repeated ? reflection->GetRepeatedUInt64(message, field, index)
                                                          : reflection->GetUInt64(message, field)));
    case FieldDescriptor::CPPTYPE_DOUBLE:
      return Napi::Number::New(env, repeated ? reflection->GetRepeatedDouble(message, field, index)
                                             : reflection->GetDouble(message, field));
    case FieldDescriptor::CPPTYPE_FLOAT:
      return Napi::Number::New(env, FloatToDouble(repeated ? reflection->GetRepeatedFloat(message, field, index)
                                                           : reflection->GetFloat(message, field)));
    case FieldDescriptor::CPPTYPE_BOOL:
      return Napi::Boolean::New(env, repeated ? reflection->GetRepeatedBool(message, field, index)
                                              : reflection->GetBool(message, field));
    case FieldDescriptor::CPPTYPE_ENUM: {
      const int number = repeated ? reflection->GetRepeatedEnumValue(message, field, index)
                                  : reflection->GetEnumValue(message, field);
      const google::protobuf::EnumValueDescriptor* value = field->enum_type()->FindValueByNumber(number);
      if (value == nullptr) return Napi::Number::New(env, number);  // as protobuf JSON prints it
      return Napi::String::New(env, std::string(value->name()));
    }
    case FieldDescriptor::CPPTYPE_STRING: {
      const std::string text = repeated ? reflection->GetRepeatedString(message, field, index)
                                        : reflection->GetString(message, field);
      return Napi::String::New(env, field->type() == FieldDescriptor::TYPE_BYTES ? absl::Base64Escape(text) : text);
    }
    case FieldDescriptor::CPPTYPE_MESSAGE: {
      const Message& sub_message =
          repeated ? reflection->GetRepeatedMessage(message, field, index) : reflection->GetMessage(message, field);
      return IsWellKnownType(sub_message.GetDescriptor()) ? WellKnownToJs(env, sub_message)
                                                          : MessageToJs(env, sub_message);
    }
  }
  return env.Undefined();  // unreachable: the switch covers every CppType
}

Napi::Value FieldToJs(Napi::Env env, const Message& message, const FieldDescriptor* field) {
  if (!field->is_repeated()) return FieldValueToJs(env, message, field, -1);
  if (field->is_map()) {
    // No parameter message has one; fail loudly instead of printing entries as an array.
    Napi::Error::New(env, absl::StrCat("Cannot convert map field ", field->full_name())).ThrowAsJavaScriptException();
    return env.Undefined();
  }
  const int size = message.GetReflection()->FieldSize(message, field);
  Napi::Array array = Napi::Array::New(env, size);
  for (int i = 0; i < size; ++i) {
    Napi::Value element = FieldValueToJs(env, message, field, i);
    if (env.IsExceptionPending()) return env.Undefined();
    array.Set(i, element);
  }
  return array;
}

}  // namespace

Napi::Value MessageToJs(Napi::Env env, const Message& message) {
  const google::protobuf::Descriptor* descriptor = message.GetDescriptor();
  const Reflection* reflection = message.GetReflection();
  Napi::Object object = Napi::Object::New(env);
  for (int i = 0; i < descriptor->field_count(); ++i) {
    const FieldDescriptor* field = descriptor->field(i);
    if (!field->is_repeated() && field->has_presence() && !reflection->HasField(message, field)) continue;
    Napi::Value value = FieldToJs(env, message, field);
    if (env.IsExceptionPending()) return env.Undefined();
    object.Set(std::string(field->json_name()), value);
  }
  return object;
}

}  // namespace ortools_node
