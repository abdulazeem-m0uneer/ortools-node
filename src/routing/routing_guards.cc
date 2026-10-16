#include "routing/routing_guards.h"

#include "common/int64.h"

namespace ortools_node {

bool ReadIntInRange(Napi::Env env, const Napi::Value& v, int64_t lo, int64_t hi, const std::string& what,
                    int64_t* out) {
  if (!ReadInt64(env, v, false, what.c_str(), out)) return false;
  if (*out < lo || *out > hi) {
    Napi::RangeError::New(env, what + " (" + std::to_string(*out) + ") must be in [" + std::to_string(lo) + ", " +
                                   std::to_string(hi) + "]")
        .ThrowAsJavaScriptException();
    return false;
  }
  return true;
}

bool ReadIntArrayInRange(Napi::Env env, const Napi::Value& v, int64_t lo, int64_t hi, const std::string& what,
                         std::vector<int64_t>* out) {
  if (!ReadInt64Array(env, v, false, what.c_str(), out)) return false;
  for (size_t i = 0; i < out->size(); ++i) {
    const int64_t value = (*out)[i];
    if (value < lo || value > hi) {
      Napi::RangeError::New(env, what + "[" + std::to_string(i) + "] (" + std::to_string(value) + ") must be in [" +
                                     std::to_string(lo) + ", " + std::to_string(hi) + "]")
          .ThrowAsJavaScriptException();
      return false;
    }
  }
  return true;
}

namespace {

// Reads the elements of an array of arrays, one row at a time through `read_row`.
template <typename ReadRow>
bool ReadRows(Napi::Env env, const Napi::Value& v, const std::string& what, size_t* count, ReadRow read_row) {
  if (!v.IsArray()) {
    Napi::TypeError::New(env, what + " must be an array of arrays").ThrowAsJavaScriptException();
    return false;
  }
  Napi::Array rows = v.As<Napi::Array>();
  const uint32_t n = rows.Length();
  if (env.IsExceptionPending()) return false;
  *count = n;
  for (uint32_t i = 0; i < n; ++i) {
    Napi::Value row = rows.Get(i);
    if (env.IsExceptionPending()) return false;
    if (!read_row(i, row, what + "[" + std::to_string(i) + "]")) return false;
  }
  return true;
}

}  // namespace

bool ReadInt64Matrix(Napi::Env env, const Napi::Value& v, size_t rows, size_t cols, const std::string& what,
                     std::vector<std::vector<int64_t>>* out) {
  out->clear();
  size_t count = 0;
  const bool ok = ReadRows(env, v, what, &count, [&](uint32_t i, const Napi::Value& row, const std::string& name) {
    if (i >= rows) return true;  // reported below, after counting
    std::vector<int64_t> values;
    if (!ReadInt64Array(env, row, true, name.c_str(), &values)) return false;
    if (values.size() != cols) {
      Napi::RangeError::New(env, name + " must have " + std::to_string(cols) + " entries, not " +
                                     std::to_string(values.size()))
          .ThrowAsJavaScriptException();
      return false;
    }
    out->push_back(std::move(values));
    return true;
  });
  if (!ok) return false;
  if (count != rows) {
    Napi::RangeError::New(env, what + " must have " + std::to_string(rows) + " rows, not " + std::to_string(count))
        .ThrowAsJavaScriptException();
    return false;
  }
  return true;
}

bool ReadIntArrays(Napi::Env env, const Napi::Value& v, int64_t lo, int64_t hi, const std::string& what,
                   std::vector<std::vector<int64_t>>* out) {
  out->clear();
  size_t count = 0;
  return ReadRows(env, v, what, &count, [&](uint32_t, const Napi::Value& row, const std::string& name) {
    std::vector<int64_t> values;
    if (!ReadIntArrayInRange(env, row, lo, hi, name, &values)) return false;
    out->push_back(std::move(values));
    return true;
  });
}

bool ReadString(Napi::Env env, const Napi::Value& v, const std::string& what, std::string* out) {
  if (!v.IsString()) {
    Napi::TypeError::New(env, what + " must be a string").ThrowAsJavaScriptException();
    return false;
  }
  *out = v.As<Napi::String>().Utf8Value();
  return true;
}

}  // namespace ortools_node
