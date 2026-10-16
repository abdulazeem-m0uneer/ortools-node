#ifndef ORTOOLS_NODE_COMMON_CPP_GUARD_TESTING_H_
#define ORTOOLS_NODE_COMMON_CPP_GUARD_TESTING_H_

#include <napi.h>

namespace ortools_node {

// Registers native._testing.{guardCpp,guardCppAsync}(kind) for the test suite.
void InitCppGuardTesting(Napi::Env env, Napi::Object testing);

}  // namespace ortools_node

#endif  // ORTOOLS_NODE_COMMON_CPP_GUARD_TESTING_H_
