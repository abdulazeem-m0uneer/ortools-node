#ifndef ORTOOLS_NODE_LINEAR_SOLVER_MP_SOLVER_H_
#define ORTOOLS_NODE_LINEAR_SOLVER_MP_SOLVER_H_

#include <napi.h>

namespace ortools_node {

// Registers the `Solver` class, `infinity` and `supportsProblemType`.
Napi::Object InitMpSolver(Napi::Env env, Napi::Object exports);

}  // namespace ortools_node

#endif  // ORTOOLS_NODE_LINEAR_SOLVER_MP_SOLVER_H_
