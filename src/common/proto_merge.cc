#include "common/proto_merge.h"

#include <map>
#include <memory>
#include <string>
#include <vector>

#include "absl/status/status.h"
#include "absl/strings/str_cat.h"
#include "absl/strings/str_replace.h"
#include "absl/strings/string_view.h"
#include "common/proto_json.h"
#include "google/protobuf/json/json.h"
#include "google/protobuf/struct.pb.h"

namespace ortools_node {

namespace {

using google::protobuf::Descriptor;
using google::protobuf::FieldDescriptor;
using google::protobuf::Message;
using google::protobuf::OneofDescriptor;
using google::protobuf::Reflection;
using google::protobuf::Struct;
using google::protobuf::Value;

// The JSON parser accepts both the json_name and the proto field name.
const FieldDescriptor* FindFieldByKey(const Descriptor* descriptor, const std::string& key) {
  for (int i = 0; i < descriptor->field_count(); ++i) {
    const FieldDescriptor* field = descriptor->field(i);
    if (field->json_name() == key || field->name() == key) return field;
  }
  return nullptr;
}

// An object given for a singular sub-message merges into it; anything else replaces the field.
bool MergesIntoSubMessage(const FieldDescriptor* field, const Value& value) {
  return !field->is_repeated() && field->cpp_type() == FieldDescriptor::CPPTYPE_MESSAGE &&
         !IsWellKnownType(field->message_type()) && value.kind_case() == Value::kStructValue;
}

std::string KeyPath(const std::string& parent, const std::string& key) {
  return parent.empty() ? key : absl::StrCat(parent, ".", key);
}

// lib/params.js sends ±Infinity numbers as these strings, since JSON has no
// Infinity. They become protobuf's "Infinity" / "-Infinity" only where a float
// or double field receives them; string fields accept any text.
constexpr absl::string_view kPlusInfinityMarker("\0+Infinity", 10);
constexpr absl::string_view kMinusInfinityMarker("\0-Infinity", 10);

std::string ReplaceInfinityMarkers(const std::string& json) {
  return absl::StrReplaceAll(json, {{R"("\u0000+Infinity")", R"("Infinity")"},
                                    {R"("\u0000-Infinity")", R"("-Infinity")"}});
}

std::string FindInvalidObject(const Struct& object, const Descriptor* descriptor, const std::string& path);

// Checks what the JSON parser lets through or cannot see: null array elements
// (it reads them as zero values) and Infinity numbers sent to non-float fields.
std::string FindInvalidValue(const Value& value, const FieldDescriptor* field, const std::string& path) {
  switch (value.kind_case()) {
    case Value::kListValue:
      for (int i = 0; i < value.list_value().values_size(); ++i) {
        const Value& element = value.list_value().values(i);
        const std::string element_path = absl::StrCat(path, "[", i, "]");
        if (element.kind_case() == Value::kNullValue) return absl::StrCat("'", element_path, "' must not be null");
        std::string error = FindInvalidValue(element, field, element_path);
        if (!error.empty()) return error;
      }
      return "";
    case Value::kStructValue:
      if (field->cpp_type() != FieldDescriptor::CPPTYPE_MESSAGE || IsWellKnownType(field->message_type())) return "";
      return FindInvalidObject(value.struct_value(), field->message_type(), path);
    case Value::kStringValue: {
      const std::string& text = value.string_value();
      const bool infinity = text == kPlusInfinityMarker || text == kMinusInfinityMarker;
      const bool floating =
          field->cpp_type() == FieldDescriptor::CPPTYPE_DOUBLE || field->cpp_type() == FieldDescriptor::CPPTYPE_FLOAT;
      return infinity && !floating ? absl::StrCat("'", path, "' cannot be Infinity (only float and double fields can)")
                                   : "";
    }
    default:
      return "";
  }
}

// Also rejects one field named twice (camelCase and snake_case).
std::string FindInvalidObject(const Struct& object, const Descriptor* descriptor, const std::string& path) {
  std::map<const FieldDescriptor*, std::string> keys;  // field -> path of the key that named it
  for (const auto& [key, value] : object.fields()) {
    const std::string key_path = KeyPath(path, key);
    const FieldDescriptor* field = FindFieldByKey(descriptor, key);
    if (field == nullptr) return absl::StrCat("unknown field '", key_path, "'");
    const auto [previous, inserted] = keys.emplace(field, key_path);
    if (!inserted) return absl::StrCat("'", key_path, "' and '", previous->second, "' name the same field");
    std::string error = FindInvalidValue(value, field, key_path);
    if (!error.empty()) return error;
  }
  return "";
}

// Moves the fields named in `present` (already checked by FindInvalidObject)
// from *parsed (the same JSON, parsed and checked) onto *target.
void MergePresentFields(const Struct& present, Message* parsed, Message* target) {
  const Reflection* reflection = target->GetReflection();
  std::vector<const FieldDescriptor*> replaced;
  for (const auto& [key, value] : present.fields()) {
    const FieldDescriptor* field = FindFieldByKey(target->GetDescriptor(), key);
    if (value.kind_case() == Value::kNullValue) continue;  // null keeps the base value
    if (!MergesIntoSubMessage(field, value)) {
      replaced.push_back(field);
      continue;
    }
    const OneofDescriptor* oneof = field->real_containing_oneof();
    if (oneof != nullptr && reflection->GetOneofFieldDescriptor(*target, oneof) != field) {
      reflection->ClearOneof(target, oneof);
    }
    MergePresentFields(value.struct_value(), parsed->GetReflection()->MutableMessage(parsed, field),
                       reflection->MutableMessage(target, field));
  }
  // *parsed is scratch, so swapping moves each value (and its presence) without a copy.
  if (!replaced.empty()) reflection->SwapFields(parsed, target, replaced);
}

}  // namespace

bool MergeProtoJson(Napi::Env env, const Napi::Value& json, const char* what, Message* target) {
  if (!json.IsString()) {
    Napi::TypeError::New(env, std::string(what) + " must be a JSON string").ThrowAsJavaScriptException();
    return false;
  }
  const std::string text = json.As<Napi::String>().Utf8Value();
  std::unique_ptr<Message> parsed(target->New());
  if (!ParseProtoJson(env, ReplaceInfinityMarkers(text), what, parsed.get())) return false;
  Struct present;
  absl::Status status = google::protobuf::json::JsonStringToMessage(text, &present);
  const std::string error =
      status.ok() ? FindInvalidObject(present, target->GetDescriptor(), "") : std::string(status.message());
  if (!error.empty()) {
    Napi::TypeError::New(env, absl::StrCat("Invalid ", what, ": ", error)).ThrowAsJavaScriptException();
    return false;
  }
  MergePresentFields(present, parsed.get(), target);
  return true;
}

}  // namespace ortools_node
