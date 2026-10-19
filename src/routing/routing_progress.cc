// ProgressMonitor (see the header).

#include "routing/routing_progress.h"

#include <napi.h>

#include "absl/time/clock.h"
#include "common/int64.h"

namespace ortools_node {

using operations_research::IntVar;
using operations_research::RoutingModel;

Napi::Value ProgressToJs(Napi::Env env, const ProgressSnapshot& snapshot) {
  Napi::Object out = Napi::Object::New(env);
  out.Set("solutions", Napi::Number::New(env, static_cast<double>(snapshot.solutions)));
  out.Set("objective", snapshot.has_objective ? Int64ToJsNumberOrBigInt(env, snapshot.objective) : env.Null());
  out.Set("branches", Napi::Number::New(env, static_cast<double>(snapshot.branches)));
  out.Set("failures", Napi::Number::New(env, static_cast<double>(snapshot.failures)));
  out.Set("wallTimeMs", Napi::Number::New(env, static_cast<double>(snapshot.wall_time_ms)));
  out.Set("done", Napi::Boolean::New(env, snapshot.done));
  if (env.IsExceptionPending()) return Napi::Value();
  return out;
}

ProgressMonitor::ProgressMonitor(const RoutingModel* model) : SearchMonitor(model->solver()), model_(model) {}

void ProgressMonitor::Attach(ProgressSink* sink, absl::Duration interval) {
  sink_ = sink;
  interval_ = interval;
  started_ = absl::Now();
  last_published_ = started_;
  solutions_ = 0;
  has_objective_ = false;
  best_objective_ = 0;
  base_branches_ = solver()->branches();
  base_failures_ = solver()->failures();
}

void ProgressMonitor::RecordSolution() {
  if (sink_ == nullptr) return;
  ++solutions_;
  IntVar* cost = model_->CostVar();
  if (cost == nullptr) return;
  const int64_t objective = cost->Bound() ? cost->Value() : cost->Min();
  if (!has_objective_ || objective < best_objective_) best_objective_ = objective;
  has_objective_ = true;
}

void ProgressMonitor::MaybePublish() {
  if (sink_ == nullptr) return;
  const absl::Time now = absl::Now();
  if (now - last_published_ < interval_) return;
  last_published_ = now;
  sink_->OnProgress(Take(false));
}

void ProgressMonitor::PublishFinal() {
  if (sink_ != nullptr) sink_->OnProgress(Take(true));
}

ProgressSnapshot ProgressMonitor::Take(bool done) const {
  ProgressSnapshot snapshot;
  snapshot.solutions = solutions_;
  snapshot.has_objective = has_objective_;
  snapshot.objective = best_objective_;
  snapshot.branches = solver()->branches() - base_branches_;
  snapshot.failures = solver()->failures() - base_failures_;
  snapshot.wall_time_ms = absl::ToInt64Milliseconds(absl::Now() - started_);
  snapshot.done = done;
  return snapshot;
}

}  // namespace ortools_node
