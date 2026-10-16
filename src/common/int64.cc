#include "common/int64.h"

#include <cmath>
#include <limits>
#include <string>

namespace ortools_node {
namespace {

constexpr double kMaxSafeInteger = 9007199254740991.0;  // 2^53 - 1
constexpr int64_t kInt64Max = std::numeric_limits<int64_t>::max();
constexpr int64_t kInt64Min = std::numeric_limits<int64_t>::min();

bool Fail(Napi::Env env, bool range, const std::string& message) {
  if (range) {
    Napi::RangeError::New(env, message).ThrowAsJavaScriptException();
  } else {
    Napi::TypeError::New(env, message).ThrowAsJavaScriptException();
  }
  return false;
}

bool ReadDouble(Napi::Env env, double d, bool allow_infinite, const std::string& what, int64_t* out) {
  if (std::isnan(d)) return Fail(env, false, what + " must not be NaN");
  if (std::isinf(d)) {
    if (!allow_infinite) return Fail(env, false, what + " must be finite");
    *out = d > 0 ? kInt64Max : kInt64Min;
    return true;
  }
  if (d != std::floor(d)) return Fail(env, false, what + " must be an integer");
  if (std::fabs(d) > kMaxSafeInteger) {
    return Fail(env, true, what + " is outside the safe integer range; pass a BigInt");
  }
  *out = static_cast<int64_t>(d);
  return true;
}

bool ReadBigInt(Napi::Env env, const Napi::BigInt& b, const std::string& what, int64_t* out) {
  bool lossless = false;
  int64_t value = b.Int64Value(&lossless);
  if (!lossless) return Fail(env, true, what + " does not fit in a 64-bit integer");
  *out = value;
  return true;
}

template <typename T>
bool ReadNumericTypedArray(Napi::Env env, const Napi::TypedArray& typed, bool allow_infinite, const std::string& what,
                           std::vector<int64_t>* out) {
  Napi::TypedArrayOf<T> array = typed.As<Napi::TypedArrayOf<T>>();
  const size_t n = array.ElementLength();
  out->resize(n);
  for (size_t i = 0; i < n; ++i) {
    if (!ReadDouble(env, static_cast<double>(array[i]), allow_infinite, what + "[" + std::to_string(i) + "]",
                    &(*out)[i])) {
      return false;
    }
  }
  return true;
}

}  // namespace

bool ReadInt64(Napi::Env env, const Napi::Value& v, bool allow_infinite, const char* what, int64_t* out) {
  if (v.IsNumber()) return ReadDouble(env, v.As<Napi::Number>().DoubleValue(), allow_infinite, what, out);
  if (v.IsBigInt()) return ReadBigInt(env, v.As<Napi::BigInt>(), what, out);
  return Fail(env, false, std::string(what) + " must be an integer number or a BigInt");
}

bool ReadInt64Array(Napi::Env env, const Napi::Value& v, bool allow_infinite, const char* what,
                    std::vector<int64_t>* out) {
  const std::string name(what);
  if (v.IsTypedArray()) {
    Napi::TypedArray typed = v.As<Napi::TypedArray>();
    switch (typed.TypedArrayType()) {
      case napi_int32_array: return ReadNumericTypedArray<int32_t>(env, typed, allow_infinite, name, out);
      case napi_uint32_array: return ReadNumericTypedArray<uint32_t>(env, typed, allow_infinite, name, out);
      case napi_float64_array: return ReadNumericTypedArray<double>(env, typed, allow_infinite, name, out);
      case napi_bigint64_array: {
        Napi::TypedArrayOf<int64_t> array = typed.As<Napi::TypedArrayOf<int64_t>>();
        out->assign(array.Data(), array.Data() + array.ElementLength());
        return true;
      }
      default:
        return Fail(env, false,
                    name + " must be an Array, Int32Array, Uint32Array, Float64Array or BigInt64Array");
    }
  }
  if (!v.IsArray()) {
    return Fail(env, false, name + " must be an Array, Int32Array, Uint32Array, Float64Array or BigInt64Array");
  }
  Napi::Array array = v.As<Napi::Array>();
  const uint32_t n = array.Length();
  out->resize(n);
  for (uint32_t i = 0; i < n; ++i) {
    const std::string element = name + "[" + std::to_string(i) + "]";
    if (!ReadInt64(env, array.Get(i), allow_infinite, element.c_str(), &(*out)[i])) return false;
  }
  return true;
}

Napi::Value Int64ToJs(Napi::Env env, int64_t v, const char* what) {
  if (v == kInt64Max) return Napi::Number::New(env, std::numeric_limits<double>::infinity());
  if (v == kInt64Min) return Napi::Number::New(env, -std::numeric_limits<double>::infinity());
  if (std::fabs(static_cast<double>(v)) > kMaxSafeInteger) {
    Napi::RangeError::New(env, std::string(what) + " (" + std::to_string(v) +
                                   ") is outside the range a JS number holds exactly")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }
  return Napi::Number::New(env, static_cast<double>(v));
}

Napi::Value Int64ArrayToJs(Napi::Env env, const std::vector<int64_t>& values, const char* what) {
  Napi::Array array = Napi::Array::New(env, values.size());
  for (size_t i = 0; i < values.size(); ++i) {
    Napi::Value element = Int64ToJs(env, values[i], what);
    if (env.IsExceptionPending()) return env.Undefined();
    array.Set(static_cast<uint32_t>(i), element);
  }
  return array;
}

void InitInt64Testing(Napi::Env env, Napi::Object testing) {
  // (value, allowInfinite) -> the value after a JS -> int64 -> JS round trip.
  testing.Set("int64RoundTrip", Napi::Function::New(env, [](const Napi::CallbackInfo& info) -> Napi::Value {
    int64_t v;
    if (!ReadInt64(info.Env(), info[0], info[1].ToBoolean(), "value", &v)) return info.Env().Undefined();
    return Int64ToJs(info.Env(), v, "value");
  }));
  testing.Set("int64ArrayRoundTrip", Napi::Function::New(env, [](const Napi::CallbackInfo& info) -> Napi::Value {
    std::vector<int64_t> values;
    if (!ReadInt64Array(info.Env(), info[0], info[1].ToBoolean(), "values", &values)) return info.Env().Undefined();
    return Int64ArrayToJs(info.Env(), values, "values");
  }));
}

}  // namespace ortools_node
