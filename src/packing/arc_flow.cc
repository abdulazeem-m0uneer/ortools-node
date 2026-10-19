// Copyright 2010-2025 Google LLC
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
//
// Modified copy of ortools/packing/arc_flow_solver.cc (OR-Tools 9.14 and 9.15,
// identical in both); a copy of the License is in LICENSES/Apache-2.0.txt.
// Changes: the backend's output follows `enable_output` (OR-Tools calls
// EnableOutput() unconditionally), HiGHS gets output_flag=false while quiet,
// CHECK failures throw instead of aborting, and the model-dump flag is dropped.

#include "packing/arc_flow.h"

#include <cmath>
#include <stdexcept>
#include <string>
#include <vector>

#include "absl/container/btree_map.h"
#include "absl/strings/str_cat.h"
#include "absl/time/clock.h"
#include "absl/time/time.h"
#include "common/highs_output.h"
#include "ortools/packing/arc_flow_builder.h"

namespace ortools_node {
namespace {

using operations_research::MPConstraint;
using operations_research::MPObjective;
using operations_research::MPSolver;
using operations_research::MPVariable;
using operations_research::packing::ArcFlowGraph;
namespace vbp = operations_research::packing::vbp;

void Require(bool condition, const char* what) {
  if (!condition) throw std::runtime_error(std::string("arc-flow solution decoding: ") + what);
}

ArcFlowGraph BuildGraph(const vbp::VectorBinPackingProblem& input) {
  const int num_items = input.item_size();
  const int num_dims = input.resource_capacity_size();
  std::vector<std::vector<int>> shapes(num_items);
  std::vector<int> demands(num_items);
  std::vector<int> capacities(num_dims);
  for (int i = 0; i < num_items; ++i) {
    shapes[i].assign(input.item(i).resource_usage().begin(), input.item(i).resource_usage().end());
    demands[i] = input.item(i).num_copies() + input.item(i).num_optional_copies();
  }
  for (int i = 0; i < num_dims; ++i) capacities[i] = input.resource_capacity(i);

  // Extra dimensions encode max_number_of_copies_per_bin.
  for (int i = 0; i < num_items; ++i) {
    const int max_copies = input.item(i).max_number_of_copies_per_bin();
    if (max_copies == 0 || max_copies >= demands[i]) continue;
    capacities.push_back(max_copies);
    for (int j = 0; j < num_items; ++j) shapes[j].push_back(i == j);
  }
  return operations_research::packing::BuildArcFlowGraph(capacities, shapes, demands);
}

// Unrolls the integral flow from source to sink into bins.
void DecodeBins(const ArcFlowGraph& graph, const std::vector<MPVariable*>& arc_to_var, double num_bins,
                vbp::VectorBinPackingSolution* solution) {
  struct NextCountItem {
    int next = -1;
    int count = 0;
    int item = -1;
  };
  std::vector<std::vector<NextCountItem>> node_to_next_count_item(graph.nodes.size());
  for (size_t v = 0; v < graph.arcs.size(); ++v) {
    const int count = static_cast<int>(std::round(arc_to_var[v]->solution_value()));
    if (count == 0) continue;
    const ArcFlowGraph::Arc& arc = graph.arcs[v];
    node_to_next_count_item[arc.source].push_back({arc.destination, count, arc.item_index});
  }
  const auto pop_next = [&node_to_next_count_item](int node) {
    Require(!node_to_next_count_item[node].empty(), "the flow leaves a node it never entered");
    NextCountItem& top = node_to_next_count_item[node].back();
    Require(top.next != -1 && top.count > 0, "an arc carries no flow");
    const NextCountItem result = top;
    if (--top.count == 0) node_to_next_count_item[node].pop_back();
    return result;
  };

  const int start_node = 0;
  const int end_node = static_cast<int>(graph.nodes.size()) - 1;
  while (!node_to_next_count_item[start_node].empty()) {
    absl::btree_map<int, int> item_count;
    for (int current = start_node; current != end_node;) {
      const NextCountItem step = pop_next(current);
      if (step.item != -1) item_count[step.item]++;
      current = step.next;
    }
    vbp::VectorBinPackingOneBinInSolution* bin = solution->add_bins();
    for (const auto& [item, count] : item_count) {
      bin->add_item_indices(item);
      bin->add_item_copies(count);
    }
  }
  Require(solution->bins_size() == std::round(num_bins), "the bins do not match the bin count");
  for (const auto& next_counts : node_to_next_count_item) Require(next_counts.empty(), "some flow is unused");
}

}  // namespace

vbp::VectorBinPackingSolution SolveWithArcFlow(const vbp::VectorBinPackingProblem& problem,
                                               MPSolver::OptimizationProblemType solver_type,
                                               const std::string& mip_params, double time_limit, int num_threads,
                                               int max_bins, bool enable_output) {
  const absl::Time graph_start = absl::Now();
  const ArcFlowGraph graph = BuildGraph(problem);
  const double arc_flow_time = absl::ToDoubleSeconds(absl::Now() - graph_start);

  int max_num_bins = max_bins;
  if (max_num_bins <= 0) {
    max_num_bins = 0;
    for (const auto& item : problem.item()) max_num_bins += item.num_copies() + item.num_optional_copies();
  }
  const int num_types = problem.item_size();
  std::vector<std::vector<MPVariable*>> incoming_vars(graph.nodes.size());
  std::vector<std::vector<MPVariable*>> outgoing_vars(graph.nodes.size());
  std::vector<MPVariable*> arc_to_var(graph.arcs.size());
  std::vector<std::vector<MPVariable*>> item_to_vars(num_types);

  MPSolver solver("VectorBinPacking", solver_type);
  const absl::Status threads = solver.SetNumThreads(num_threads);
  if (!threads.ok()) throw std::runtime_error("SetNumThreads: " + std::string(threads.message()));
  MPObjective* const objective = solver.MutableObjective();

  for (size_t v = 0; v < graph.arcs.size(); ++v) {
    const ArcFlowGraph::Arc& arc = graph.arcs[v];
    MPVariable* const var = solver.MakeIntVar(0, max_num_bins, absl::StrCat("a", v));
    incoming_vars[arc.destination].push_back(var);
    outgoing_vars[arc.source].push_back(var);
    if (arc.item_index != -1) item_to_vars[arc.item_index].push_back(var);
    arc_to_var[v] = var;
  }

  // Per item demand.
  for (int i = 0; i < num_types; ++i) {
    const vbp::Item& item = problem.item(i);
    const int max_copies = item.num_copies() + item.num_optional_copies();
    MPConstraint* const ct = solver.MakeRowConstraint(item.num_copies(), max_copies);
    objective->SetOffset(max_copies * item.penalty_per_missing_copy() + objective->offset());
    for (MPVariable* const var : item_to_vars[i]) {
      objective->SetCoefficient(var, -item.penalty_per_missing_copy());
      ct->SetCoefficient(var, 1.0);
    }
  }

  // Flow conservation, except at the source and the sink.
  for (size_t n = 1; n + 1 < graph.nodes.size(); ++n) {
    MPConstraint* const ct = solver.MakeRowConstraint(0.0, 0.0);
    for (MPVariable* const var : incoming_vars[n]) ct->SetCoefficient(var, 1.0);
    for (MPVariable* const var : outgoing_vars[n]) ct->SetCoefficient(var, -1.0);
  }

  MPVariable* const num_bins_var = solver.MakeIntVar(0, max_num_bins, "num_bins_var");
  objective->SetCoefficient(num_bins_var, problem.has_cost_per_bin() ? problem.cost_per_bin() : 1.0);
  {  // Source.
    MPConstraint* const ct = solver.MakeRowConstraint(0.0, 0.0);
    ct->SetCoefficient(num_bins_var, 1.0);
    for (MPVariable* const var : outgoing_vars[/*source*/ 0]) ct->SetCoefficient(var, -1.0);
  }
  {  // Sink.
    MPConstraint* const ct = solver.MakeRowConstraint(0.0, 0.0);
    for (MPVariable* const var : incoming_vars[graph.nodes.size() - 1]) ct->SetCoefficient(var, 1.0);
    ct->SetCoefficient(num_bins_var, -1.0);
  }

  if (enable_output) solver.EnableOutput();
  // CBC and HiGHS report false for any text; HiGHS still applies it.
  solver.SetSolverSpecificParametersAsString(
      IsHighs(solver_type) && !enable_output ? QuietHighsParameters(mip_params) : mip_params);
  solver.SetTimeLimit(absl::Seconds(time_limit));
  const MPSolver::ResultStatus result_status = solver.Solve();

  vbp::VectorBinPackingSolution solution;
  solution.set_solve_time_in_seconds(solver.wall_time() / 1000.0);
  solution.set_arc_flow_time_in_seconds(arc_flow_time);
  if (result_status == MPSolver::OPTIMAL) {
    solution.set_status(vbp::OPTIMAL);
  } else if (result_status == MPSolver::FEASIBLE) {
    solution.set_status(vbp::FEASIBLE);
  } else {
    if (result_status == MPSolver::INFEASIBLE) solution.set_status(vbp::INFEASIBLE);
    return solution;
  }
  solution.set_objective_value(objective->Value());
  DecodeBins(graph, arc_to_var, num_bins_var->solution_value(), &solution);
  return solution;
}

}  // namespace ortools_node
