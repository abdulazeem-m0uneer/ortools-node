// Guards for OR-Tools' domain bitsets.
//
// A DomainIntVar stores holes in a bitset spanning [min, max], and both bitset
// classes CHECK that the span holds at most 0xFFFFFFFF values (expressions.cc,
// "Bitset too large"). A hole made in a wider domain aborts the process, either
// at the call or later during propagation (MemberCt / IsMemberCt / NotMemberCt
// remove or keep values in search), so bindings refuse such holes up front.
// Domains only shrink, so checking when a constraint is built is enough.

#ifndef ORTOOLS_NODE_CONSTRAINT_SOLVER_DOMAIN_GUARD_H_
#define ORTOOLS_NODE_CONSTRAINT_SOLVER_DOMAIN_GUARD_H_

#include <algorithm>
#include <cstdint>
#include <vector>

namespace ortools_node {

// True when OR-Tools can hold a bitset over [lo, hi] (lo <= hi).
inline bool SpanFitsBitset(int64_t lo, int64_t hi) {
  return static_cast<uint64_t>(hi) - static_cast<uint64_t>(lo) < 0xFFFFFFFFull;
}

// True when removing `values` from the domain [lo, hi] would need a bitset
// OR-Tools refuses. Values at the bounds only move the bounds (SetMin/SetMax),
// so they are peeled off first, as RemoveValues does one value at a time.
inline bool RemovalNeedsHugeBitset(int64_t lo, int64_t hi, std::vector<int64_t> values) {
  values.erase(std::remove_if(values.begin(), values.end(), [&](int64_t v) { return v < lo || v > hi; }),
               values.end());
  std::sort(values.begin(), values.end());
  values.erase(std::unique(values.begin(), values.end()), values.end());
  size_t first = 0;
  size_t last = values.size();
  while (first < last && lo < hi && values[first] == lo) {
    ++lo;
    ++first;
  }
  while (first < last && lo < hi && values[last - 1] == hi) {
    --hi;
    --last;
  }
  const bool holes_left = first < last && lo < hi;
  return holes_left && !SpanFitsBitset(lo, hi);
}

// True when keeping only `values` of [lo, hi] (MemberCt, a true IsMemberCt)
// would need a bitset OR-Tools refuses.
inline bool KeepingNeedsHugeBitset(int64_t lo, int64_t hi, const std::vector<int64_t>& values) {
  int64_t vmin = INT64_MAX;
  int64_t vmax = INT64_MIN;
  for (int64_t v : values) {
    if (v < lo || v > hi) continue;
    vmin = std::min(vmin, v);
    vmax = std::max(vmax, v);
  }
  return vmin < vmax && !SpanFitsBitset(vmin, vmax);
}

// The message of the RangeError thrown when a guard above refuses a call.
inline const char* HugeBitsetMessage() {
  return ": OR-Tools cannot make holes in a domain wider than 2^32 values; narrow it first (setRange)";
}

}  // namespace ortools_node

#endif  // ORTOOLS_NODE_CONSTRAINT_SOLVER_DOMAIN_GUARD_H_
