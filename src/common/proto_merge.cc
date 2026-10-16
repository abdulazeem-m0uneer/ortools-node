#include "common/proto_merge.h"

#include <cmath>
#include <map>
#include <memory>
#include <string>
#include <vector>

#include "absl/status/status.h"
#include "absl/strings/match.h"
#include "absl/strings/str_cat.h"
#include "absl/strings/str_format.h"
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
// Infinity. Only a whole string value of a float or double field becomes
// protobuf's "Infinity" / "-Infinity"; a marker anywhere else is an error, so
// no caller's text is ever rewritten.
constexpr absl::string_view kPlusInfinityMarker("\0+Infinity", 10);
constexpr absl::string_view kMinusInfinityMarker("\0-Infinity", 10);

bool ContainsInfinityMarker(absl::string_view text) {
  return absl::StrContains(text, kPlusInfinityMarker) || absl::StrContains(text, kMinusInfinityMarker);
}

std::string MarkerInValueError(const std::string& path) {
  return absl::StrCat("'", path, "' contains a reserved Infinity marker");
}

std::string MarkerInKeyError(const std::string& path) {
  return absl::StrCat("a key ", path.empty() ? "at the top level" : absl::StrCat("in '", path, "'"),
                      " contains a reserved Infinity marker");
}

// A marker anywhere in a value no descriptor describes (e.g. an object given for a well-known type).
std::string FindInfinityMarker(const Value& value, const std::string& path) {
  switch (value.kind_case()) {
    case Value::kStringValue:
      return ContainsInfinityMarker(value.string_value()) ? MarkerInValueError(path) : "";
    case Value::kListValue:
      for (int i = 0; i < value.list_value().values_size(); ++i) {
        std::string error = FindInfinityMarker(value.list_value().values(i), absl::StrCat(path, "[", i, "]"));
        if (!error.empty()) return error;
      }
      return "";
    case Value::kStructValue:
      for (const auto& [key, field_value] : value.struct_value().fields()) {
        if (ContainsInfinityMarker(key)) return MarkerInKeyError(path);
        std::string error = FindInfinityMarker(field_value, KeyPath(path, key));
        if (!error.empty()) return error;
      }
      return "";
    default:
      return "";
  }
}

std::string CheckObject(Struct* object, const Descriptor* descriptor, const std::string& path);

// The Struct holds numbers as doubles, and printing it again would write large
// integers in exponent form ("1e+18"), which protobuf's integer parser refuses.
// So a number given to an integer field must be integral and in range, and is
// rewritten as its exact decimal string.
std::string CheckIntegerNumber(Value* value, const FieldDescriptor* field, const std::string& path) {
  double lower = 0;
  double upper = 0;  // exclusive
  switch (field->cpp_type()) {
    case FieldDescriptor::CPPTYPE_INT32:
      lower = -std::ldexp(1.0, 31);
      upper = std::ldexp(1.0, 31);
      break;
    case FieldDescriptor::CPPTYPE_UINT32:
      upper = std::ldexp(1.0, 32);
      break;
    case FieldDescriptor::CPPTYPE_INT64:
      lower = -std::ldexp(1.0, 63);
      upper = std::ldexp(1.0, 63);
      break;
    case FieldDescriptor::CPPTYPE_UINT64:
      upper = std::ldexp(1.0, 64);
      break;
    default:
      return "";
  }
  const double number = value->number_value();
  if (number != std::trunc(number)) return absl::StrCat("'", path, "' must be an integer");
  if (number < lower || number >= upper) {
    return absl::StrCat("'", path, "' must fit in ", FieldDescriptor::CppTypeName(field->cpp_type()));
  }
  value->set_string_value(absl::StrFormat("%.0f", number + 0.0));  // + 0.0 turns -0 into 0
  return "";
}

// Checks what the JSON parser lets through or cannot see: null array elements
// (it reads them as zero values), Infinity markers and integers too large for
// a double's exponent-free printing. Turns each marker given to a float or
// double field into "Infinity" / "-Infinity", and integers into decimal strings.
std::string CheckValue(Value* value, const FieldDescriptor* field, const std::string& path) {
  switch (value->kind_case()) {
    case Value::kListValue:
      for (int i = 0; i < value->list_value().values_size(); ++i) {
        Value* element = value->mutable_list_value()->mutable_values(i);
        const std::string element_path = absl::StrCat(path, "[", i, "]");
        if (element->kind_case() == Value::kNullValue) return absl::StrCat("'", element_path, "' must not be null");
        std::string error = CheckValue(element, field, element_path);
        if (!error.empty()) return error;
      }
      return "";
    case Value::kStructValue:
      if (field->cpp_type() != FieldDescriptor::CPPTYPE_MESSAGE || IsWellKnownType(field->message_type())) {
        return FindInfinityMarker(*value, path);
      }
      return CheckObject(value->mutable_struct_value(), field->message_type(), path);
    case Value::kStringValue: {
      const bool plus = value->string_value() == kPlusInfinityMarker;
      if (!plus && value->string_value() != kMinusInfinityMarker) {
        return ContainsInfinityMarker(value->string_value()) ? MarkerInValueError(path) : "";
      }
      if (field->cpp_type() != FieldDescriptor::CPPTYPE_DOUBLE && field->cpp_type() != FieldDescriptor::CPPTYPE_FLOAT) {
        return absl::StrCat("'", path, "' cannot be Infinity (only float and double fields can)");
      }
      value->set_string_value(plus ? "Infinity" : "-Infinity");
      return "";
    }
    case Value::kNumberValue:
      return CheckIntegerNumber(value, field, path);
    default:
      return "";
  }
}

// Also rejects one field named twice (camelCase and snake_case).
std::string CheckObject(Struct* object, const Descriptor* descriptor, const std::string& path) {
  std::map<const FieldDescriptor*, std::string> keys;  // field -> path of the key that named it
  for (auto& [key, value] : *object->mutable_fields()) {
    if (ContainsInfinityMarker(key)) return MarkerInKeyError(path);
    const std::string key_path = KeyPath(path, key);
    const FieldDescriptor* field = FindFieldByKey(descriptor, key);
    if (field == nullptr) return absl::StrCat("unknown field '", key_path, "'");
    const auto [previous, inserted] = keys.emplace(field, key_path);
    if (!inserted) return absl::StrCat("'", key_path, "' and '", previous->second, "' name the same field");
    std::string error = CheckValue(&value, field, key_path);
    if (!error.empty()) return error;
  }
  return "";
}

// Moves the fields named in `present` (already checked by CheckObject)
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
  // The message is parsed from the checked Struct, printed again, never from the caller's text.
  Struct present;
  absl::Status status = google::protobuf::json::JsonStringToMessage(json.As<Napi::String>().Utf8Value(), &present);
  std::string error = status.ok() ? CheckObject(&present, target->GetDescriptor(), "") : std::string(status.message());
  std::string checked_json;
  if (error.empty()) {
    status = google::protobuf::json::MessageToJsonString(present, &checked_json);
    if (!status.ok()) error = std::string(status.message());
  }
  if (!error.empty()) {
    Napi::TypeError::New(env, absl::StrCat("Invalid ", what, ": ", error)).ThrowAsJavaScriptException();
    return false;
  }
  std::unique_ptr<Message> parsed(target->New());
  if (!ParseProtoJson(env, checked_json, what, parsed.get())) return false;
  MergePresentFields(present, parsed.get(), target);
  return true;
}

}  // namespace ortools_node
