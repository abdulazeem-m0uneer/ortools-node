// Argument parsing and error helpers shared by every ortools-node wrapper.
//
// Exceptions are disabled (NAPI_DISABLE_CPP_EXCEPTIONS): helpers raise with
// ThrowAsJavaScriptException() and return false, and callers return early.

#ifndef ORTOOLS_NODE_COMMON_NAPI_UTIL_H_
#define ORTOOLS_NODE_COMMON_NAPI_UTIL_H_

#include <napi.h>

#include <cmath>
#include <cstddef>
#include <string>

#include "ortools/linear_solver/linear_solver.h"

namespace ortools_node {

#define THROW_AND_RETURN(env, msg, ret)                          \
  do {                                                           \
    Napi::Error::New((env), (msg)).ThrowAsJavaScriptException(); \
    return ret;                                                  \
  } while (0)

#define THROW_TYPE_AND_RETURN(env, msg, ret)                         \
  do {                                                               \
    Napi::TypeError::New((env), (msg)).ThrowAsJavaScriptException(); \
    return ret;                                                      \
  } while (0)

// Reads a numeric argument into *out. NaN is always rejected; ±Infinity only
// when allow_infinite (bounds), and it maps onto ±MPSolver::infinity().
inline bool ReadNumber(Napi::Env env, const Napi::Value& v, bool allow_infinite, const char* what, double* out) {
  if (!v.IsNumber()) {
    Napi::TypeError::New(env, std::string(what) + " must be a number").ThrowAsJavaScriptException();
    return false;
  }
  double d = v.As<Napi::Number>().DoubleValue();
  if (std::isnan(d) || (!allow_infinite && std::isinf(d))) {
    Napi::TypeError::New(env, std::string(what) + (allow_infinite ? " must not be NaN" : " must be finite"))
        .ThrowAsJavaScriptException();
    return false;
  }
  if (std::isinf(d)) d = d > 0 ? operations_research::MPSolver::infinity() : -operations_research::MPSolver::infinity();
  *out = d;
  return true;
}

inline bool ReadBound(Napi::Env env, const Napi::Value& v, const char* what, double* out) {
  return ReadNumber(env, v, /*allow_infinite=*/true, what, out);
}

inline bool ReadCoefficient(Napi::Env env, const Napi::Value& v, double* out) {
  return ReadNumber(env, v, /*allow_infinite=*/false, "coefficient", out);
}

// Index arguments must be integral and in [0, size).
inline bool ReadIndex(Napi::Env env, const Napi::Value& v, size_t size, const char* what, size_t* out) {
  if (!v.IsNumber()) {
    Napi::TypeError::New(env, std::string(what) + " index must be a number").ThrowAsJavaScriptException();
    return false;
  }
  double d = v.As<Napi::Number>().DoubleValue();
  if (d != std::floor(d)) {
    Napi::TypeError::New(env, std::string(what) + " index must be an integer").ThrowAsJavaScriptException();
    return false;
  }
  if (d < 0 || d >= static_cast<double>(size)) {
    Napi::RangeError::New(env, std::string(what) + " index out of range").ThrowAsJavaScriptException();
    return false;
  }
  *out = static_cast<size_t>(d);
  return true;
}

}  // namespace ortools_node

#endif  // ORTOOLS_NODE_COMMON_NAPI_UTIL_H_
