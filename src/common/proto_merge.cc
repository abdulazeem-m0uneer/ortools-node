#include "common/proto_merge.h"

#include <map>
#include <memory>
#include <string>
#include <vector>

#include "absl/status/status.h"
#include "absl/strings/str_cat.h"
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

// Moves the fields named in `present` from *parsed (the same JSON, already
// parsed and checked) onto *target. Returns an error message, or "".
std::string MergePresentFields(const Struct& present, Message* parsed, Message* target, const std::string& path) {
  const Reflection* reflection = target->GetReflection();
  std::map<const FieldDescriptor*, std::string> keys;  // field -> path of the key that named it
  std::vector<const FieldDescriptor*> replaced;
  for (const auto& [key, value] : present.fields()) {
    const std::string key_path = path.empty() ? key : absl::StrCat(path, ".", key);
    const FieldDescriptor* field = FindFieldByKey(target->GetDescriptor(), key);
    if (field == nullptr) return absl::StrCat("unknown field '", key_path, "'");
    const auto [previous, inserted] = keys.emplace(field, key_path);
    if (!inserted) {
      return absl::StrCat("'", key_path, "' and '", previous->second, "' name the same field");
    }
    if (value.kind_case() == Value::kNullValue) continue;  // null keeps the base value
    if (!MergesIntoSubMessage(field, value)) {
      replaced.push_back(field);
      continue;
    }
    const OneofDescriptor* oneof = field->real_containing_oneof();
    if (oneof != nullptr && reflection->GetOneofFieldDescriptor(*target, oneof) != field) {
      reflection->ClearOneof(target, oneof);
    }
    std::string error = MergePresentFields(value.struct_value(), parsed->GetReflection()->MutableMessage(parsed, field),
                                           reflection->MutableMessage(target, field), key_path);
    if (!error.empty()) return error;
  }
  // *parsed is scratch, so swapping moves each value (and its presence) without a copy.
  if (!replaced.empty()) reflection->SwapFields(parsed, target, replaced);
  return "";
}

}  // namespace

bool MergeProtoJson(Napi::Env env, const Napi::Value& json, const char* what, Message* target) {
  std::unique_ptr<Message> parsed(target->New());
  if (!ParseProtoJson(env, json, what, parsed.get())) return false;
  Struct present;
  absl::Status status = google::protobuf::json::JsonStringToMessage(json.As<Napi::String>().Utf8Value(), &present);
  const std::string error =
      status.ok() ? MergePresentFields(present, parsed.get(), target, "") : std::string(status.message());
  if (!error.empty()) {
    Napi::TypeError::New(env, absl::StrCat("Invalid ", what, ": ", error)).ThrowAsJavaScriptException();
    return false;
  }
  return true;
}

}  // namespace ortools_node
