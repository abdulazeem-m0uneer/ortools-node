// ortools-node: N-API bindings for Google OR-Tools.
//
// This file only initialises the module; each OR-Tools component lives in its
// own directory under src/ and registers its exports through an Init function.

#include <napi.h>

#include <mutex>
#include <string>

#include "absl/log/initialize.h"
#include "absl/log/internal/globals.h"
#include "algorithms/knapsack_solver.h"
#include "common/cpp_guard_testing.h"
#include "common/int64.h"
#include "constraint_solver/cp_solver.h"
#include "graph/graph.h"
#include "linear_solver/model_builder.h"
#include "linear_solver/mp_solver.h"
#include "math_opt/math_opt.h"
#include "ortools/base/version.h"
#include "packing/bin_packing.h"
#include "routing/routing_model.h"
#include "routing/search_parameters.h"
#include "sat/cp_sat_solver.h"
#include "set_cover/set_cover.h"
#include "sat/sat_parameters.h"
#include "sat/solution_channel_testing.h"

#ifndef ORTOOLS_VERSION_STRING
#error "ORTOOLS_VERSION_STRING must be defined by the build (see CMakeLists.txt)"
#endif

namespace ortools_node {
namespace {

// Route OR-Tools' absl logs through the configured sinks (errors still reach
// stderr) instead of the "before absl::InitializeLog()" fallback. A second
// InitializeLog() in one process is fatal, hence the guards.
void InitializeAbseilLoggingOnce() {
  static std::once_flag once;
  std::call_once(once, [] {
    if (!absl::log_internal::IsInitialized()) absl::InitializeLog();
  });
}

// The addon is compiled against one OR-Tools release and must load that same
// release: the C++ API has no ABI stability across versions.
bool CheckLinkedVersion(Napi::Env env) {
  const std::string linked = operations_research::OrToolsVersionString();
  if (linked == ORTOOLS_VERSION_STRING) return true;
  Napi::Error::New(env, "ortools-node was built against OR-Tools " ORTOOLS_VERSION_STRING
                        " but loaded OR-Tools " + linked + "; rebuild it (npm run rebuild)")
      .ThrowAsJavaScriptException();
  return false;
}

void InitVersion(Napi::Env env, Napi::Object exports) {
  exports.Set("ortoolsVersion", Napi::String::New(env, operations_research::OrToolsVersionString()));
  Napi::Object build_info = Napi::Object::New(env);
  build_info.Set("ortoolsVersion", Napi::String::New(env, ORTOOLS_VERSION_STRING));
  build_info.Set("napiVersion", Napi::Number::New(env, NAPI_VERSION));
  exports.Set("buildInfo", build_info);
}

Napi::Object InitAll(Napi::Env env, Napi::Object exports) {
  InitializeAbseilLoggingOnce();
  if (!CheckLinkedVersion(env)) return exports;
  InitVersion(env, exports);
  Napi::Object testing = Napi::Object::New(env);  // internal hooks for test/, not public API
  InitInt64Testing(env, testing);
  InitCppGuardTesting(env, testing);
  InitSolutionChannelTesting(env, testing);
  exports.Set("_testing", testing);
  InitRoutingSearchParameters(env, exports);
  InitSatParameters(env, exports);
  InitGraph(env, exports);
  InitKnapsackSolver(env, exports);
  InitModelBuilder(env, exports);
  InitMathOpt(env, exports);
  InitSetCover(env, exports);
  InitBinPacking(env, exports);
  InitCpSatSolver(env, exports);
  InitCpSolver(env, exports);
  InitRouting(env, exports);
  return InitMpSolver(env, exports);
}

}  // namespace
}  // namespace ortools_node

// NODE_API_MODULE pastes the name into an identifier, so it must be unqualified.
static Napi::Object Init(Napi::Env env, Napi::Object exports) {
  return ortools_node::InitAll(env, exports);
}

NODE_API_MODULE(ortools_node, Init)
