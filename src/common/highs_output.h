// Keeping HiGHS quiet on stdout.

#ifndef ORTOOLS_NODE_COMMON_HIGHS_OUTPUT_H_
#define ORTOOLS_NODE_COMMON_HIGHS_OUTPUT_H_

#include <string>

#include "ortools/linear_solver/linear_solver.h"

namespace ortools_node {

inline bool IsHighs(operations_research::MPSolver::OptimizationProblemType type) {
  return type == operations_research::MPSolver::HIGHS_LINEAR_PROGRAMMING ||
         type == operations_research::MPSolver::HIGHS_MIXED_INTEGER_PROGRAMMING;
}

// HiGHS prints its banner to stdout even with output off, but only after it
// reads its solver-specific parameters. Putting output_flag=false first keeps it
// quiet while the caller's own output_flag still wins.
inline std::string QuietHighsParameters(const std::string& parameters) {
  return parameters.empty() ? "output_flag=false" : "output_flag=false\n" + parameters;
}

}  // namespace ortools_node

#endif  // ORTOOLS_NODE_COMMON_HIGHS_OUTPUT_H_
