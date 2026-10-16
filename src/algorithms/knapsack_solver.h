#ifndef ORTOOLS_NODE_ALGORITHMS_KNAPSACK_SOLVER_H_
#define ORTOOLS_NODE_ALGORITHMS_KNAPSACK_SOLVER_H_

#include <napi.h>

namespace ortools_node {

// Registers the `KnapsackSolver` class and `knapsackSolverTypes` (the solver
// types this OR-Tools build can run).
void InitKnapsackSolver(Napi::Env env, Napi::Object exports);

}  // namespace ortools_node

#endif  // ORTOOLS_NODE_ALGORITHMS_KNAPSACK_SOLVER_H_
