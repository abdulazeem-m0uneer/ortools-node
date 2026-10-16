// Keeps C++ exceptions out of N-API.
//
// The addon is built with NAPI_DISABLE_CPP_EXCEPTIONS, so a C++ exception that
// escapes a binding (std::bad_alloc from OR-Tools on a huge but valid input,
// std::length_error, ...) reaches std::terminate and kills the Node process.
// Wrap every OR-Tools call that can allocate or throw:
// * on the main thread with GuardCpp(), which throws a JS error instead;
// * in PromiseWorker::Execute() with GuardCppOffThread(), whose message goes to SetError().

#ifndef ORTOOLS_NODE_COMMON_CPP_GUARD_H_
#define ORTOOLS_NODE_COMMON_CPP_GUARD_H_

#include <napi.h>

#include <exception>
#include <new>
#include <string>
#include <utility>

namespace ortools_node {

// Message for a caught exception: out-of-memory is reported as a too-large input.
inline std::string DescribeCppFailure(const char* what, const std::exception& e, bool out_of_memory) {
  if (out_of_memory) return std::string(what) + ": out of memory (the input is too large)";
  return std::string(what) + ": " + e.what();
}

// Runs f() on the main thread. On a C++ exception throws a JS RangeError (out
// of memory) or Error and returns false.
template <typename F>
bool GuardCpp(Napi::Env env, const char* what, F&& f) {
  try {
    std::forward<F>(f)();
    return true;
  } catch (const std::bad_alloc& e) {
    Napi::RangeError::New(env, DescribeCppFailure(what, e, true)).ThrowAsJavaScriptException();
  } catch (const std::exception& e) {
    Napi::Error::New(env, DescribeCppFailure(what, e, false)).ThrowAsJavaScriptException();
  }
  return false;
}

// Runs f() off the main thread. Returns "" on success, otherwise the message
// to pass to AsyncWorker::SetError().
template <typename F>
std::string GuardCppOffThread(const char* what, F&& f) {
  try {
    std::forward<F>(f)();
    return "";
  } catch (const std::bad_alloc& e) {
    return DescribeCppFailure(what, e, true);
  } catch (const std::exception& e) {
    return DescribeCppFailure(what, e, false);
  }
}

}  // namespace ortools_node

#endif  // ORTOOLS_NODE_COMMON_CPP_GUARD_H_
