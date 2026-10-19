// int64 conversion between JS and OR-Tools.
//
// JS numbers are exact only up to 2^53 - 1, so:
// * Input: a safe-integer number, or a BigInt that fits in int64. When
//   allow_infinite, +-Infinity maps onto kint64max / kint64min, which OR-Tools
//   uses for "unbounded". NaN, fractions and unsafe numbers are rejected.
// * Output (Int64ToJs): a number; kint64max / kint64min come back as
//   +-Infinity, and any other value outside the safe range throws a RangeError
//   (never a silent rounding).
// * Output (Int64ToJsNumberOrBigInt): the same, except that a value outside the
//   safe range comes back as an exact BigInt instead of throwing.

#ifndef ORTOOLS_NODE_COMMON_INT64_H_
#define ORTOOLS_NODE_COMMON_INT64_H_

#include <napi.h>

#include <cstdint>
#include <vector>

namespace ortools_node {

// Reads one int64. On failure throws (TypeError / RangeError naming `what`) and returns false.
bool ReadInt64(Napi::Env env, const Napi::Value& v, bool allow_infinite, const char* what, int64_t* out);

// Reads an Array of int64 values, or an Int32Array, Uint32Array, Float64Array
// or BigInt64Array (the fast path for bulk data). Elements follow ReadInt64;
// a result too large to allocate throws a RangeError naming `what`.
bool ReadInt64Array(Napi::Env env, const Napi::Value& v, bool allow_infinite, const char* what,
                    std::vector<int64_t>* out);

// Converts an int64 result to a JS number. On failure throws a RangeError and
// returns env.Undefined().
Napi::Value Int64ToJs(Napi::Env env, int64_t v, const char* what);

// Converts a vector of int64 results to a JS Array (same rules as Int64ToJs).
Napi::Value Int64ArrayToJs(Napi::Env env, const std::vector<int64_t>& values, const char* what);

// Converts an int64 result to a JS number, +-Infinity or exact BigInt. Never throws.
Napi::Value Int64ToJsNumberOrBigInt(Napi::Env env, int64_t v);

// Registers native._testing.{int64RoundTrip,int64ArrayRoundTrip,int64NumberOrBigIntRoundTrip} for the test suite.
void InitInt64Testing(Napi::Env env, Napi::Object testing);

}  // namespace ortools_node

#endif  // ORTOOLS_NODE_COMMON_INT64_H_
