#ifndef ORTOOLS_NODE_PACKING_BIN_PACKING_H_
#define ORTOOLS_NODE_PACKING_BIN_PACKING_H_

#include <napi.h>

namespace ortools_node {

// Registers solveVectorBinPacking / solveVectorBinPackingSync (arc-flow
// formulation; VectorBinPackingProblem JSON in, VectorBinPackingSolution out)
// and vectorBinPackingSolvers (the MIP backends it can use).
void InitBinPacking(Napi::Env env, Napi::Object exports);

}  // namespace ortools_node

#endif  // ORTOOLS_NODE_PACKING_BIN_PACKING_H_
