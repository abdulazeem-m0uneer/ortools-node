#ifndef ORTOOLS_NODE_MATH_OPT_MATH_OPT_H_
#define ORTOOLS_NODE_MATH_OPT_MATH_OPT_H_

#include <napi.h>

namespace ortools_node {

// Registers mathOptSolve / mathOptSolveSync (ModelProto JSON in,
// SolveResultProto JSON out), the MathOptSolveInterrupter class, the
// registered solver types and the enum names results use.
void InitMathOpt(Napi::Env env, Napi::Object exports);

}  // namespace ortools_node

#endif  // ORTOOLS_NODE_MATH_OPT_MATH_OPT_H_
