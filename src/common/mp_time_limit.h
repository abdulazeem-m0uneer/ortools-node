// Time limits handed to MPSolver.

#ifndef ORTOOLS_NODE_COMMON_MP_TIME_LIMIT_H_
#define ORTOOLS_NODE_COMMON_MP_TIME_LIMIT_H_

#include <algorithm>

namespace ortools_node {

// MPSolver keeps whole milliseconds and reads 0 as "no limit": the shortest
// limit it can honour is 1 ms, so shorter ones (0 included) become 1 ms.
// Infinity stays "no limit".
inline double MpSolverTimeLimitSeconds(double seconds) { return std::max(seconds, 0.001); }

}  // namespace ortools_node

#endif  // ORTOOLS_NODE_COMMON_MP_TIME_LIMIT_H_
