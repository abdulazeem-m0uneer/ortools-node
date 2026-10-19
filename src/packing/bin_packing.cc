// Vector bin packing with the arc-flow formulation
// (packing::SolveVectorBinPackingWithArcFlow).
//
// The problem arrives as VectorBinPackingProblem JSON and the solution goes
// back as a JS object. The OR-Tools function CHECKs or silently assumes a lot,
// so the problem and options are validated first:
// * at least one dimension and one item (no items underflows an index);
// * capacities in [1, 2^30], usages in [0, 2^30], one usage per dimension
//   (values are stored in int and added up, and the builder CHECKs > 0);
// * copy counts >= 0, their total within int; penalties and bin cost finite;
// * a MIP backend (the flow decomposition CHECKs integral arc values) whose
//   SetNumThreads() succeeds (the function CHECK_OKs it), threads >= 1;
// * a bound on the dynamic-programming states the graph builder would explore,
//   since it allocates per state and an absurd instance would exhaust memory;
// * an item with copies must use some resource (or have a per-bin limit below
//   its copies): otherwise its arc is a self-loop and a topological sort CHECKs.
// When no item can go in a bin at all (none demanded, or none fits an empty
// bin) the graph is degenerate and the builder crashes; that case has an exact
// answer, computed here instead.

#include "packing/bin_packing.h"

#include <napi.h>

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <limits>
#include <string>
#include <utility>
#include <vector>

#include "absl/strings/match.h"
#include "absl/strings/str_cat.h"
#include "common/async_worker.h"
#include "common/cpp_guard.h"
#include "common/napi_util.h"
#include "common/proto_json.h"
#include "common/proto_to_js.h"
#include "google/protobuf/text_format.h"
#include "ortools/linear_solver/linear_solver.h"
#include "ortools/linear_solver/linear_solver.pb.h"
#include "ortools/packing/arc_flow_solver.h"
#include "ortools/packing/vector_bin_packing.pb.h"
#include "ortools/sat/parameters_validation.h"
#include "ortools/sat/sat_parameters.pb.h"

namespace ortools_node {
namespace {

using operations_research::MPModelRequest;
using operations_research::MPSolver;
namespace vbp = operations_research::packing::vbp;

constexpr int64_t kMaxResourceValue = int64_t{1} << 30;
constexpr int64_t kMaxTotalCopies = int64_t{1} << 30;
// About a gigabyte of graph-builder states; see EstimatedDpStates().
constexpr double kMaxDpStates = 1e7;
constexpr int kMaxThreads = 1024;
constexpr double kMinTimeLimitSeconds = 0.001;

// MIP backends this build has whose SetNumThreads() works.
bool IsUsableBackend(MPSolver::OptimizationProblemType type) {
  const std::string name = MPModelRequest::SolverType_Name(static_cast<MPModelRequest::SolverType>(type));
  const bool integral = absl::EndsWith(name, "_MIXED_INTEGER_PROGRAMMING") || name == "SAT_INTEGER_PROGRAMMING";
  if (!integral || !MPSolver::SupportsProblemType(type)) return false;
  MPSolver probe("probe", type);
  return probe.SetNumThreads(1).ok();
}

// Backend names as MPSolver::ParseSolverType() reads them ("SCIP", "CBC", "CP_SAT"...).
bool ParseBackend(const std::string& name, MPSolver::OptimizationProblemType* out) {
  return MPSolver::ParseSolverType(name, out) && IsUsableBackend(*out);
}

bool Fail(Napi::Env env, const std::string& message) {
  Napi::RangeError::New(env, "Invalid VectorBinPackingProblem: " + message).ThrowAsJavaScriptException();
  return false;
}

// An upper bound on the states the arc-flow builder explores: at most one per
// (item, copies placed so far) pair and per reachable usage vector, and the
// usage vectors are bounded both by the capacities (and per-bin limits) and by the item mixes that
// fit. Saturates instead of overflowing.
double EstimatedDpStates(const std::vector<int64_t>& capacities, const vbp::VectorBinPackingProblem& problem) {
  double pairs = 0;
  double capacity_vectors = 1;
  double item_mixes = 1;
  for (const int64_t capacity : capacities) capacity_vectors *= static_cast<double>(capacity) + 1;
  for (const vbp::Item& item : problem.item()) {
    const int64_t demand = int64_t{item.num_copies()} + item.num_optional_copies();
    pairs += static_cast<double>(demand) + 1;
    int64_t fit = demand;
    for (int d = 0; d < item.resource_usage_size(); ++d) {
      if (item.resource_usage(d) > 0) fit = std::min(fit, capacities[d] / item.resource_usage(d));
    }
    const int64_t limit = item.max_number_of_copies_per_bin();
    if (limit > 0) fit = std::min<int64_t>(fit, limit);
    // A per-bin limit below the demand becomes one more dimension of the state.
    if (limit > 0 && limit < demand) capacity_vectors *= static_cast<double>(limit) + 1;
    item_mixes *= static_cast<double>(fit) + 1;
  }
  return pairs * std::min(capacity_vectors, item_mixes);
}

// Whether at least one demanded item fits in an empty bin.
bool HasPlaceableItem(const vbp::VectorBinPackingProblem& problem) {
  for (const vbp::Item& item : problem.item()) {
    if (int64_t{item.num_copies()} + item.num_optional_copies() == 0) continue;
    bool fits = true;
    for (int d = 0; d < item.resource_usage_size(); ++d) fits = fits && item.resource_usage(d) <= problem.resource_capacity(d);
    if (fits) return true;
  }
  return false;
}

// The answer when nothing can be packed: infeasible if a required copy exists,
// otherwise no bins and every optional copy missing.
vbp::VectorBinPackingSolution SolveWithoutPlaceableItems(const vbp::VectorBinPackingProblem& problem) {
  vbp::VectorBinPackingSolution solution;
  double penalty = 0;
  for (const vbp::Item& item : problem.item()) {
    if (item.num_copies() > 0) {
      solution.set_status(vbp::INFEASIBLE);
      return solution;
    }
    penalty += item.num_optional_copies() * item.penalty_per_missing_copy();
  }
  solution.set_status(vbp::OPTIMAL);
  solution.set_objective_value(penalty);
  return solution;
}

bool ValidateProblem(Napi::Env env, const vbp::VectorBinPackingProblem& problem) {
  const int num_dims = problem.resource_capacity_size();
  if (num_dims == 0) return Fail(env, "resourceCapacity is empty");
  if (problem.item_size() == 0) return Fail(env, "item is empty");
  std::vector<int64_t> capacities(problem.resource_capacity().begin(), problem.resource_capacity().end());
  for (int d = 0; d < num_dims; ++d) {
    if (capacities[d] < 1 || capacities[d] > kMaxResourceValue) {
      return Fail(env, absl::StrCat("resourceCapacity[", d, "] must be in [1, 2^30]"));
    }
  }
  int64_t total_copies = 0;
  for (int i = 0; i < problem.item_size(); ++i) {
    const vbp::Item& item = problem.item(i);
    const std::string what = absl::StrCat("item[", i, "]");
    if (item.resource_usage_size() != num_dims) {
      return Fail(env, absl::StrCat(what, ".resourceUsage has ", item.resource_usage_size(), " values for ", num_dims,
                                    " resources"));
    }
    for (int d = 0; d < num_dims; ++d) {
      if (item.resource_usage(d) < 0 || item.resource_usage(d) > kMaxResourceValue) {
        return Fail(env, absl::StrCat(what, ".resourceUsage[", d, "] must be in [0, 2^30]"));
      }
    }
    if (item.num_copies() < 0 || item.num_optional_copies() < 0 || item.max_number_of_copies_per_bin() < 0) {
      return Fail(env, what + ": numCopies, numOptionalCopies and maxNumberOfCopiesPerBin must be >= 0");
    }
    total_copies += int64_t{item.num_copies()} + item.num_optional_copies();
    if (total_copies > kMaxTotalCopies) return Fail(env, "the total number of copies exceeds 2^30");
    const int64_t demand = int64_t{item.num_copies()} + item.num_optional_copies();
    const bool limited = item.max_number_of_copies_per_bin() > 0 && item.max_number_of_copies_per_bin() < demand;
    const bool uses_resource =
        std::any_of(item.resource_usage().begin(), item.resource_usage().end(), [](int64_t u) { return u > 0; });
    if (demand > 0 && !uses_resource && !limited) {
      return Fail(env, what + " uses no resource; give it a resourceUsage or a maxNumberOfCopiesPerBin below its "
                              "copies");
    }
    if (!std::isfinite(item.penalty_per_missing_copy())) {
      return Fail(env, what + ".penaltyPerMissingCopy must be finite");
    }
  }
  if (problem.has_cost_per_bin() && !std::isfinite(problem.cost_per_bin())) {
    return Fail(env, "costPerBin must be finite");
  }
  if (problem.max_bins() < 0) return Fail(env, "maxBins must be >= 0");
  if (EstimatedDpStates(capacities, problem) > kMaxDpStates) {
    return Fail(env, "the arc-flow graph could need more than 1e7 states (capacities and copy counts are too large "
                     "for this formulation)");
  }
  return true;
}

// SolveVectorBinPackingWithArcFlow ignores whether the backend accepted the
// parameters: a typo would be dropped, or fail the solve with no explanation.
// A probe solver of the same backend checks them first; CP-SAT only checks the
// text format there, so its values are validated too.
bool CheckMipParameters(Napi::Env env, MPSolver::OptimizationProblemType backend, const std::string& backend_name,
                        const std::string& parameters) {
  if (parameters.empty()) return true;
  bool accepted = false;
  std::string problem;
  if (!GuardCpp(env, "solveVectorBinPacking", [&] {
        MPSolver probe("probe", backend);
        accepted = probe.SetSolverSpecificParametersAsString(parameters);
        if (accepted && backend == MPSolver::SAT_INTEGER_PROGRAMMING) {
          operations_research::sat::SatParameters sat_parameters;
          accepted = google::protobuf::TextFormat::ParseFromString(parameters, &sat_parameters);
          if (accepted) problem = operations_research::sat::ValidateParameters(sat_parameters);
        }
      })) {
    return false;
  }
  if (accepted && problem.empty()) return true;
  Napi::TypeError::New(env, "mipParameters rejected by " + backend_name + (problem.empty() ? "" : ": " + problem))
      .ThrowAsJavaScriptException();
  return false;
}

struct SolveInput {
  vbp::VectorBinPackingProblem problem;
  MPSolver::OptimizationProblemType backend = MPSolver::SCIP_MIXED_INTEGER_PROGRAMMING;
  std::string mip_parameters;
  double time_limit_seconds = std::numeric_limits<double>::infinity();
  int num_threads = 1;
  int max_bins = 0;  // 0: the problem's maxBins, or the total number of copies
};

// (problemJson, solverType, timeLimitSeconds, numThreads, mipParameters).
// Only primitives and a string: no user code runs while they are read.
bool ReadSolveInput(const Napi::CallbackInfo& info, SolveInput* input) {
  Napi::Env env = info.Env();
  bool parsed = false;
  if (!GuardCpp(env, "solveVectorBinPacking",
                [&] { parsed = ParseProtoJson(env, info[0], "VectorBinPackingProblem", &input->problem); }) ||
      !parsed) {
    return false;
  }
  if (!info[1].IsString()) THROW_TYPE_AND_RETURN(env, "solverType must be a string", false);
  const std::string backend = info[1].As<Napi::String>().Utf8Value();
  bool usable = false;
  if (!GuardCpp(env, "solveVectorBinPacking", [&] { usable = ParseBackend(backend, &input->backend); })) return false;
  if (!usable) {
    THROW_TYPE_AND_RETURN(env, "Unsupported or unavailable MIP solver for bin packing: '" + backend + "'", false);
  }
  double seconds;
  if (!ReadNumber(env, info[2], /*allow_infinite=*/true, "timeLimitSeconds", &seconds)) return false;
  if (seconds <= 0) {
    Napi::RangeError::New(env, "timeLimitSeconds must be > 0 (Infinity for no limit)").ThrowAsJavaScriptException();
    return false;
  }
  // MPSolver keeps whole milliseconds and reads 0 as "no limit": the shortest
  // limit it can honour is 1 ms.
  input->time_limit_seconds = std::max(seconds, kMinTimeLimitSeconds);
  double threads;
  if (!ReadNumber(env, info[3], /*allow_infinite=*/false, "numThreads", &threads)) return false;
  if (threads != std::floor(threads) || threads < 1 || threads > kMaxThreads) {
    Napi::RangeError::New(env, "numThreads must be an integer in [1, 1024]").ThrowAsJavaScriptException();
    return false;
  }
  input->num_threads = static_cast<int>(threads);
  if (!info[4].IsString()) THROW_TYPE_AND_RETURN(env, "mipParameters must be a string", false);
  input->mip_parameters = info[4].As<Napi::String>().Utf8Value();
  if (!CheckMipParameters(env, input->backend, backend, input->mip_parameters)) return false;
  if (!ValidateProblem(env, input->problem)) return false;
  input->max_bins = input->problem.max_bins();
  return true;
}

vbp::VectorBinPackingSolution RunSolve(const SolveInput& input) {
  if (!HasPlaceableItem(input.problem)) return SolveWithoutPlaceableItems(input.problem);
  return operations_research::packing::SolveVectorBinPackingWithArcFlow(
      input.problem, input.backend, input.mip_parameters, input.time_limit_seconds, input.num_threads,
      input.max_bins);
}

class BinPackingWorker : public PromiseWorker {
 public:
  BinPackingWorker(Napi::Env env, SolveInput input)
      : PromiseWorker(env, Napi::Object::New(env)), input_(std::move(input)) {}

 protected:
  void Execute() override {
    RunGuarded("solveVectorBinPacking", [this] { solution_ = RunSolve(input_); });
  }
  Napi::Value Result(Napi::Env env) override { return MessageToJs(env, solution_); }

 private:
  SolveInput input_;
  vbp::VectorBinPackingSolution solution_;
};

Napi::Value Solve(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  SolveInput input;
  if (!ReadSolveInput(info, &input)) return env.Undefined();
  auto* worker = new BinPackingWorker(env, std::move(input));
  worker->Queue();
  return worker->Promise();
}

Napi::Value SolveSync(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  SolveInput input;
  if (!ReadSolveInput(info, &input)) return env.Undefined();
  vbp::VectorBinPackingSolution solution;
  if (!GuardCpp(env, "solveVectorBinPacking", [&] { solution = RunSolve(input); })) return env.Undefined();
  return MessageToJs(env, solution);
}

}  // namespace

void InitBinPacking(Napi::Env env, Napi::Object exports) {
  exports.Set("solveVectorBinPacking", Napi::Function::New(env, Solve));
  exports.Set("solveVectorBinPackingSync", Napi::Function::New(env, SolveSync));
  Napi::Array backends = Napi::Array::New(env);
  for (const char* name : {"SCIP", "CBC", "CP_SAT", "HIGHS", "GUROBI", "CPLEX", "XPRESS", "GLPK"}) {
    MPSolver::OptimizationProblemType type;
    if (ParseBackend(name, &type)) backends.Set(backends.Length(), name);
  }
  exports.Set("vectorBinPackingSolvers", backends);
}

}  // namespace ortools_node
