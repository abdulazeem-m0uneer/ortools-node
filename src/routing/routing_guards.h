// Argument readers for the routing bindings. They only read JS values (phase 1
// of every binding, see constraint_solver/cp_context.h) and validate ranges
// that are fixed when the manager or model is built, so they can run before the
// lifecycle checks.

#ifndef ORTOOLS_NODE_ROUTING_ROUTING_GUARDS_H_
#define ORTOOLS_NODE_ROUTING_ROUTING_GUARDS_H_

#include <napi.h>

#include <cstdint>
#include <string>
#include <vector>

namespace ortools_node {

// An integer in [lo, hi]: TypeError when not an integer, RangeError outside.
bool ReadIntInRange(Napi::Env env, const Napi::Value& v, int64_t lo, int64_t hi, const std::string& what,
                    int64_t* out);

// An array of integers, each in [lo, hi].
bool ReadIntArrayInRange(Napi::Env env, const Napi::Value& v, int64_t lo, int64_t hi, const std::string& what,
                         std::vector<int64_t>* out);

// A rows x cols matrix (an array of arrays or typed arrays) of int64 values,
// ±Infinity allowed. Throws and returns false on any other shape.
bool ReadInt64Matrix(Napi::Env env, const Napi::Value& v, size_t rows, size_t cols, const std::string& what,
                     std::vector<std::vector<int64_t>>* out);

// An array of arrays of integers in [lo, hi] (routes, locks).
bool ReadIntArrays(Napi::Env env, const Napi::Value& v, int64_t lo, int64_t hi, const std::string& what,
                   std::vector<std::vector<int64_t>>* out);

// A string argument; TypeError otherwise.
bool ReadString(Napi::Env env, const Napi::Value& v, const std::string& what, std::string* out);

}  // namespace ortools_node

#endif  // ORTOOLS_NODE_ROUTING_ROUTING_GUARDS_H_
