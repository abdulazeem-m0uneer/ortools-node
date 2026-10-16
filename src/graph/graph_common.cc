#include "graph/graph_common.h"

#include <cstring>

#include "common/int64.h"
#include "common/napi_util.h"

namespace ortools_node {
namespace {

bool OutOfRange(Napi::Env env, const char* what, size_t i, int64_t limit) {
  Napi::RangeError::New(env, std::string(what) + "[" + std::to_string(i) + "] must be an index in [0, " +
                                 std::to_string(limit) + ")")
      .ThrowAsJavaScriptException();
  return false;
}

bool CheckIndicesBelow(Napi::Env env, const std::vector<int32_t>& indices, int64_t limit, const char* what) {
  for (size_t i = 0; i < indices.size(); ++i) {
    if (indices[i] < 0 || indices[i] >= limit) return OutOfRange(env, what, i, limit);
  }
  return true;
}

}  // namespace

bool ReadIndexBelow(Napi::Env env, const Napi::Value& v, int64_t limit, const char* what, int32_t* out) {
  size_t index;
  if (!ReadIndex(env, v, static_cast<size_t>(limit), what, &index)) return false;
  *out = static_cast<int32_t>(index);
  return true;
}

bool ReadIndexArray(Napi::Env env, const Napi::Value& v, int64_t limit, const char* what, std::vector<int32_t>* out) {
  if (v.IsTypedArray() && v.As<Napi::TypedArray>().TypedArrayType() == napi_int32_array) {
    Napi::Int32Array array = v.As<Napi::Int32Array>();
    if (!GuardCpp(env, what, [&] { out->assign(array.Data(), array.Data() + array.ElementLength()); })) return false;
    return CheckIndicesBelow(env, *out, limit, what);
  }
  std::vector<int64_t> values;
  if (!ReadInt64Array(env, v, /*allow_infinite=*/false, what, &values)) return false;
  if (!GuardCpp(env, what, [&] { out->resize(values.size()); })) return false;
  for (size_t i = 0; i < values.size(); ++i) {
    if (values[i] < 0 || values[i] >= limit) return OutOfRange(env, what, i, limit);
    (*out)[i] = static_cast<int32_t>(values[i]);
  }
  return true;
}

bool ReadInt64List(Napi::Env env, const Napi::Value& v, bool allow_infinite, bool non_negative, const char* what,
                   std::vector<int64_t>* out) {
  if (!ReadInt64Array(env, v, allow_infinite, what, out)) return false;
  if (!non_negative) return true;
  for (size_t i = 0; i < out->size(); ++i) {
    if ((*out)[i] < 0) {
      Napi::RangeError::New(env, std::string(what) + "[" + std::to_string(i) + "] must be >= 0")
          .ThrowAsJavaScriptException();
      return false;
    }
  }
  return true;
}

bool ReadCapacity(Napi::Env env, const Napi::Value& v, int64_t* out) {
  if (!ReadInt64(env, v, /*allow_infinite=*/true, "capacity", out)) return false;
  if (*out < 0) {
    Napi::RangeError::New(env, "capacity must be >= 0").ThrowAsJavaScriptException();
    return false;
  }
  return true;
}

bool CheckSameLengths(Napi::Env env, std::initializer_list<size_t> sizes, const char* signature) {
  for (size_t size : sizes) {
    if (size != *sizes.begin()) {
      Napi::RangeError::New(env, std::string(signature) + ": every array must have the same length")
          .ThrowAsJavaScriptException();
      return false;
    }
  }
  return true;
}

bool CheckIndexBelow(Napi::Env env, int32_t index, int64_t size, const char* what) {
  if (index < size) return true;
  Napi::RangeError::New(env, std::string(what) + " index out of range").ThrowAsJavaScriptException();
  return false;
}

bool ReadArcSelection(Napi::Env env, const Napi::Value& v, ArcSelection* out) {
  out->all = v.IsUndefined();
  return out->all || ReadIndexArray(env, v, kInt32Max, "arcs", &out->arcs);
}

bool ResolveArcSelection(Napi::Env env, int32_t num_arcs, ArcSelection* selection) {
  if (!selection->all) return CheckIndicesBelow(env, selection->arcs, num_arcs, "arcs");
  return GuardCpp(env, "flows", [&] {
    selection->arcs.resize(static_cast<size_t>(num_arcs));
    for (int32_t arc = 0; arc < num_arcs; ++arc) selection->arcs[static_cast<size_t>(arc)] = arc;
  });
}

Napi::Value ArcRangeToJs(Napi::Env env, int32_t first, size_t count) {
  Napi::Int32Array array = Napi::Int32Array::New(env, count);
  for (size_t i = 0; i < count; ++i) array[i] = first + static_cast<int32_t>(i);
  return array;
}

Napi::Value IndicesToJs(Napi::Env env, const std::vector<int32_t>& indices) {
  Napi::Int32Array array = Napi::Int32Array::New(env, indices.size());
  if (!indices.empty()) std::memcpy(array.Data(), indices.data(), indices.size() * sizeof(int32_t));
  return array;
}

}  // namespace ortools_node
