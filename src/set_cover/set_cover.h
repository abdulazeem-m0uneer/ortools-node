#ifndef ORTOOLS_NODE_SET_COVER_SET_COVER_H_
#define ORTOOLS_NODE_SET_COVER_SET_COVER_H_

#include <napi.h>

namespace ortools_node {

// Registers `SetCoverInvariant` (a solution of a set cover model, built from
// subset costs and columns) and `setCoverMipSolvers`.
void InitSetCover(Napi::Env env, Napi::Object exports);

}  // namespace ortools_node

#endif  // ORTOOLS_NODE_SET_COVER_SET_COVER_H_
