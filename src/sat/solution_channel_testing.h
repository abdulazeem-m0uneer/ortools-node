#ifndef ORTOOLS_NODE_SAT_SOLUTION_CHANNEL_TESTING_H_
#define ORTOOLS_NODE_SAT_SOLUTION_CHANNEL_TESTING_H_

#include <napi.h>

namespace ortools_node {

// Registers native._testing.publishSolutionFailure(kind) for the test suite.
void InitSolutionChannelTesting(Napi::Env env, Napi::Object testing);

}  // namespace ortools_node

#endif  // ORTOOLS_NODE_SAT_SOLUTION_CHANNEL_TESTING_H_
