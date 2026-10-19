// Progress events of a routing solve (options.onProgress).
//
// A ProgressMonitor is installed on every RoutingModel when it is built (search
// monitors must be added before the model closes) and stays idle unless a solve
// attaches a ProgressSink. While attached, it runs on the solving thread: it
// counts solutions, keeps the best objective, and at most once per interval
// (checked from the search's own events) hands the sink a snapshot of plain
// values. A final snapshot (done = true) is published when the solve returns.

#ifndef ORTOOLS_NODE_ROUTING_ROUTING_PROGRESS_H_
#define ORTOOLS_NODE_ROUTING_ROUTING_PROGRESS_H_

#include <napi.h>

#include <cstdint>
#include <string>

#include "absl/time/time.h"
#include "ortools/constraint_solver/constraint_solver.h"
#include "ortools/constraint_solver/routing.h"

namespace ortools_node {

struct ProgressSnapshot {
  int64_t solutions = 0;
  bool has_objective = false;
  int64_t objective = 0;  // best so far, when has_objective
  int64_t branches = 0;
  int64_t failures = 0;
  int64_t wall_time_ms = 0;
  bool done = false;
};

// {solutions, objective (null before the first solution), branches, failures,
// wallTimeMs, done}. Throws and returns an empty value on failure.
Napi::Value ProgressToJs(Napi::Env env, const ProgressSnapshot& snapshot);

// Receives the snapshots (solving thread, or the main thread of a sync solve).
class ProgressSink {
 public:
  virtual ~ProgressSink() = default;
  virtual void OnProgress(const ProgressSnapshot& snapshot) = 0;
};

class ProgressMonitor : public operations_research::SearchMonitor {
 public:
  explicit ProgressMonitor(const operations_research::RoutingModel* model);

  // Main thread, before the solve starts / after it has returned.
  void Attach(ProgressSink* sink, absl::Duration interval);
  void Detach() { sink_ = nullptr; }
  // Solving thread: the routing at-solution hook reports each solution.
  void RecordSolution();
  // Solving thread, once the solve has returned: publishes the final snapshot.
  void PublishFinal();

  void BeginNextDecision(operations_research::DecisionBuilder*) override { MaybePublish(); }
  void BeginFail() override { MaybePublish(); }
  void AcceptNeighbor() override { MaybePublish(); }
  void AcceptUncheckedNeighbor() override { MaybePublish(); }
  void PeriodicCheck() override { MaybePublish(); }
  std::string DebugString() const override { return "ProgressMonitor"; }

 private:
  void MaybePublish();
  ProgressSnapshot Take(bool done) const;

  const operations_research::RoutingModel* model_;
  ProgressSink* sink_ = nullptr;
  absl::Duration interval_;
  absl::Time started_;
  absl::Time last_published_;
  int64_t solutions_ = 0;
  bool has_objective_ = false;
  int64_t best_objective_ = 0;
  int64_t base_branches_ = 0;  // the solver's counters when attached
  int64_t base_failures_ = 0;
};

}  // namespace ortools_node

#endif  // ORTOOLS_NODE_ROUTING_ROUTING_PROGRESS_H_
