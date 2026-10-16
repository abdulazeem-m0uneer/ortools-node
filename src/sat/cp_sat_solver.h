#ifndef ORTOOLS_NODE_SAT_CP_SAT_SOLVER_H_
#define ORTOOLS_NODE_SAT_CP_SAT_SOLVER_H_

#include <napi.h>

namespace ortools_node {

// Registers the CpSatSolver class (used by lib/sat/cp_solver.js),
// validateCpModel, cpModelStats, cpSolverResponseStats and the CP-SAT enum
// constants CpSolverStatus, VariableSelectionStrategy and DomainReductionStrategy.
void InitCpSatSolver(Napi::Env env, Napi::Object exports);

}  // namespace ortools_node

#endif  // ORTOOLS_NODE_SAT_CP_SAT_SOLVER_H_
