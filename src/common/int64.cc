#include "common/int64.h"

#include <cmath>
#include <limits>
#include <string>

namespace ortools_node {
namespace {

constexpr double kMaxSafeInteger = 9007199254740991.0;  // 2^53 - 1
constexpr int64_t kInt64Max = std::numeric_limits<int64_t>::max();
constexpr int64_t kInt64Min = std::numeric_limits<int64_t>::min();

enum class Int64Error { kNone, kNaN, kInfinite, kFraction, kUnsafe, kTooBig, kNotInteger };

// The hot path: no allocation, no message. Callers build the message (with the
// element name) only when this returns an error.
Int64Error ConvertDouble(double d, bool allow_infinite, int64_t* out) {
  if (std::isnan(d)) return Int64Error::kNaN;
  if (std::isinf(d)) {
    if (!allow_infinite) return Int64Error::kInfinite;
    *out = d > 0 ? kInt64Max : kInt64Min;
    return Int64Error::kNone;
  }
  if (d != std::floor(d)) return Int64Error::kFraction;
  if (std::fabs(d) > kMaxSafeInteger) return Int64Error::kUnsafe;
  *out = static_cast<int64_t>(d);
  return Int64Error::kNone;
}

Int64Error ConvertValue(const Napi::Value& v, bool allow_infinite, int64_t* out) {
  if (v.IsNumber()) return ConvertDouble(v.As<Napi::Number>().DoubleValue(), allow_infinite, out);
  if (v.IsBigInt()) {
    bool lossless = false;
    *out = v.As<Napi::BigInt>().Int64Value(&lossless);
    return lossless ? Int64Error::kNone : Int64Error::kTooBig;
  }
  return Int64Error::kNotInteger;
}

bool Throw(Napi::Env env, Int64Error error, const std::string& what) {
  switch (error) {
    case Int64Error::kNone: return true;
    case Int64Error::kNaN: Napi::TypeError::New(env, what + " must not be NaN").ThrowAsJavaScriptException(); break;
    case Int64Error::kInfinite: Napi::TypeError::New(env, what + " must be finite").ThrowAsJavaScriptException(); break;
    case Int64Error::kFraction: Napi::TypeError::New(env, what + " must be an integer").ThrowAsJavaScriptException(); break;
    case Int64Error::kUnsafe:
      Napi::RangeError::New(env, what + " is outside the safe integer range; pass a BigInt").ThrowAsJavaScriptException();
      break;
    case Int64Error::kTooBig:
      Napi::RangeError::New(env, what + " does not fit in a 64-bit integer").ThrowAsJavaScriptException();
      break;
    case Int64Error::kNotInteger:
      Napi::TypeError::New(env, what + " must be an integer number or a BigInt").ThrowAsJavaScriptException();
      break;
  }
  return false;
}

std::string ElementName(const char* what, size_t i) { return std::string(what) + "[" + std::to_string(i) + "]"; }

template <typename T>
bool ReadNumericTypedArray(Napi::Env env, const Napi::TypedArray& typed, bool allow_infinite, const char* what,
                           std::vector<int64_t>* out) {
  Napi::TypedArrayOf<T> array = typed.As<Napi::TypedArrayOf<T>>();
  const T* data = array.Data();
  const size_t n = array.ElementLength();
  out->resize(n);
  for (size_t i = 0; i < n; ++i) {
    Int64Error error = ConvertDouble(static_cast<double>(data[i]), allow_infinite, &(*out)[i]);
    if (error != Int64Error::kNone) return Throw(env, error, ElementName(what, i));
  }
  return true;
}

const char kArrayTypes[] = " must be an Array, Int32Array, Uint32Array, Float64Array or BigInt64Array";

}  // namespace

bool ReadInt64(Napi::Env env, const Napi::Value& v, bool allow_infinite, const char* what, int64_t* out) {
  Int64Error error = ConvertValue(v, allow_infinite, out);
  return error == Int64Error::kNone || Throw(env, error, what);
}

bool ReadInt64Array(Napi::Env env, const Napi::Value& v, bool allow_infinite, const char* what,
                    std::vector<int64_t>* out) {
  if (v.IsTypedArray()) {
    Napi::TypedArray typed = v.As<Napi::TypedArray>();
    switch (typed.TypedArrayType()) {
      case napi_int32_array: return ReadNumericTypedArray<int32_t>(env, typed, allow_infinite, what, out);
      case napi_uint32_array: return ReadNumericTypedArray<uint32_t>(env, typed, allow_infinite, what, out);
      case napi_float64_array: return ReadNumericTypedArray<double>(env, typed, allow_infinite, what, out);
      case napi_bigint64_array: {
        Napi::TypedArrayOf<int64_t> array = typed.As<Napi::TypedArrayOf<int64_t>>();
        out->assign(array.Data(), array.Data() + array.ElementLength());
        return true;
      }
      default:
        Napi::TypeError::New(env, std::string(what) + kArrayTypes).ThrowAsJavaScriptException();
        return false;
    }
  }
  if (!v.IsArray()) {
    Napi::TypeError::New(env, std::string(what) + kArrayTypes).ThrowAsJavaScriptException();
    return false;
  }
  // Length() and Get() can run user code (a Proxy, a getter) that throws: stop
  // and let that exception propagate. Throwing a second one while it is
  // pending would abort the process.
  Napi::Array array = v.As<Napi::Array>();
  const uint32_t n = array.Length();
  if (env.IsExceptionPending()) return false;
  out->resize(n);
  for (uint32_t i = 0; i < n; ++i) {
    Napi::Value item = array.Get(i);
    if (env.IsExceptionPending()) return false;
    Int64Error error = ConvertValue(item, allow_infinite, &(*out)[i]);
    if (error != Int64Error::kNone) return Throw(env, error, ElementName(what, i));
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
