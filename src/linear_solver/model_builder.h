#ifndef ORTOOLS_NODE_LINEAR_SOLVER_MODEL_BUILDER_H_
#define ORTOOLS_NODE_LINEAR_SOLVER_MODEL_BUILDER_H_

#include <napi.h>

namespace ortools_node {

// Registers `ModelBuilderSolver` (solves an MPModelRequest sent as JSON) and
// the mb* helpers: LP / MPS import and export, solver support checks.
void InitModelBuilder(Napi::Env env, Napi::Object exports);

}  // namespace ortools_node

#endif  // ORTOOLS_NODE_LINEAR_SOLVER_MODEL_BUILDER_H_
