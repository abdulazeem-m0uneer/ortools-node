// The arc-flow solve of vector bin packing, with the backend's log optional.

#ifndef ORTOOLS_NODE_PACKING_ARC_FLOW_H_
#define ORTOOLS_NODE_PACKING_ARC_FLOW_H_

#include <string>

#include "ortools/linear_solver/linear_solver.h"
#include "ortools/packing/vector_bin_packing.pb.h"

namespace ortools_node {

// packing::SolveVectorBinPackingWithArcFlow, except that the backend writes its
// log to stdout only when `enable_output` is set: OR-Tools always enables it.
// The problem and parameters must already be validated (see bin_packing.cc).
// Throws std::runtime_error where OR-Tools would CHECK-fail.
operations_research::packing::vbp::VectorBinPackingSolution SolveWithArcFlow(
    const operations_research::packing::vbp::VectorBinPackingProblem& problem,
    operations_research::MPSolver::OptimizationProblemType solver_type, const std::string& mip_params,
    double time_limit, int num_threads, int max_bins, bool enable_output);

}  // namespace ortools_node

#endif  // ORTOOLS_NODE_PACKING_ARC_FLOW_H_
