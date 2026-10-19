// Set cover binding (Python's ortools.set_cover.python.set_cover).
//
// The JS layer owns the SetCoverModel. A SetCoverInvariant copies it here
// (subset costs and columns) and keeps the current solution; heuristics run
// against it, off the main thread when async.
//
// OR-Tools assumes a lot that it only DCHECKs (compiled out of release builds,
// so a violation is undefined behaviour) or CHECKs (an abort). Each one is
// validated first:
// * the model: at least one subset and one element, costs finite and > 0,
//   no element twice in a subset, every element 0..max in some subset;
// * a focus: subset indices in range, deduplicated (duplicates corrupt the
//   priority queues);
// * greedy and element-degree generators: the focus must be able to cover
//   every element the solution leaves uncovered (otherwise they pop an empty
//   heap or select subset -1); greedy also writes out of bounds for any
//   unselected subset with free elements left out of its focus;
// * guided local / tabu search: the solution must already be a cover;
// * the MIP: an available backend and a finite time limit (an infinite one is
//   cast to int64 milliseconds).
// Before every run the invariant is recomputed, since some generators expect
// free-element counts that LoadSolution() and the MIP leave stale.

#include "set_cover/set_cover.h"

#include <napi.h>

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <limits>
#include <memory>
#include <optional>
#include <string>
#include <utility>
#include <vector>

#include "common/async_worker.h"
#include "common/cpp_guard.h"
#include "common/int64.h"
#include "common/napi_util.h"
#include "ortools/linear_solver/linear_solver.h"
#include "ortools/set_cover/base_types.h"
#include "ortools/set_cover/set_cover_heuristics.h"
#include "ortools/set_cover/set_cover_invariant.h"
#include "ortools/set_cover/set_cover_mip.h"
#include "ortools/set_cover/set_cover_model.h"

namespace ortools_node {
namespace {

using operations_research::BaseInt;
using operations_research::MPSolver;
using operations_research::SetCoverInvariant;
using operations_research::SetCoverMipSolver;
using operations_research::SetCoverModel;
using operations_research::SubsetBoolVector;
using operations_research::SubsetIndex;
using CL = SetCoverInvariant::ConsistencyLevel;

constexpr int64_t kMaxElement = std::numeric_limits<BaseInt>::max() - 1;  // num_elements = max + 1 must fit
constexpr double kMaxTimeLimitSeconds = 1e9;  // the MIP converts it to int64 milliseconds
constexpr int64_t kMaxTabuListSize = 1000000;

bool ThrowType(Napi::Env env, const std::string& message) {
  Napi::TypeError::New(env, message).ThrowAsJavaScriptException();
  return false;
}
bool ThrowRange(Napi::Env env, const std::string& message) {
  Napi::RangeError::New(env, message).ThrowAsJavaScriptException();
  return false;
}

// An Array of numbers or a Float64Array. Element getters run user code: an
// exception they throw stays pending and is returned as is.
bool ReadDoubleArray(Napi::Env env, const Napi::Value& v, const char* what, std::vector<double>* out) {
  if (v.IsTypedArray() && v.As<Napi::TypedArray>().TypedArrayType() == napi_float64_array) {
    Napi::Float64Array array = v.As<Napi::Float64Array>();
    out->assign(array.Data(), array.Data() + array.ElementLength());
    return true;
  }
  if (!v.IsArray()) return ThrowType(env, std::string(what) + " must be an Array or a Float64Array");
  Napi::Array array = v.As<Napi::Array>();
  const uint32_t n = array.Length();
  if (env.IsExceptionPending()) return false;
  out->resize(n);
  for (uint32_t i = 0; i < n; ++i) {
    Napi::Value item = array.Get(i);
    if (env.IsExceptionPending()) return false;
    if (!item.IsNumber()) return ThrowType(env, std::string(what) + "[" + std::to_string(i) + "] must be a number");
    (*out)[i] = item.As<Napi::Number>().DoubleValue();
  }
  return true;
}

// Integers in [0, limit): numbers, BigInts or a typed array of them.
bool ReadIndexArray(Napi::Env env, const Napi::Value& v, const std::string& what, int64_t limit,
                    std::vector<BaseInt>* out) {
  std::vector<int64_t> values;
  if (!ReadInt64Array(env, v, /*allow_infinite=*/false, what.c_str(), &values)) return false;
  out->resize(values.size());
  for (size_t i = 0; i < values.size(); ++i) {
    if (values[i] < 0 || values[i] >= limit) {
      return ThrowRange(env, what + "[" + std::to_string(i) + "] = " + std::to_string(values[i]) +
                                 " is out of range [0, " + std::to_string(limit) + ")");
    }
    (*out)[i] = static_cast<BaseInt>(values[i]);
  }
  return true;
}

// Checks what SetCoverModel CHECKs or assumes (see the file comment).
bool ValidateModel(Napi::Env env, const std::vector<double>& costs, const std::vector<std::vector<BaseInt>>& columns) {
  if (costs.empty()) return ThrowRange(env, "the model has no subsets");
  if (costs.size() != columns.size()) return ThrowRange(env, "costs and columns differ in length");
  for (size_t s = 0; s < costs.size(); ++s) {
    if (!std::isfinite(costs[s]) || costs[s] <= 0) {
      return ThrowRange(env, "the cost of subset " + std::to_string(s) + " must be finite and > 0");
    }
  }
  std::vector<BaseInt> all_elements;
  for (size_t s = 0; s < columns.size(); ++s) {
    std::vector<BaseInt> sorted = columns[s];
    std::sort(sorted.begin(), sorted.end());
    if (std::adjacent_find(sorted.begin(), sorted.end()) != sorted.end()) {
      return ThrowRange(env, "subset " + std::to_string(s) + " lists an element twice");
    }
    all_elements.insert(all_elements.end(), sorted.begin(), sorted.end());
  }
  if (all_elements.empty()) return ThrowRange(env, "the model has no elements");
  // Elements are 0..max: each must be in some subset. Sorting avoids a
  // max-sized allocation for a model naming one huge element.
  std::sort(all_elements.begin(), all_elements.end());
  all_elements.erase(std::unique(all_elements.begin(), all_elements.end()), all_elements.end());
  for (size_t e = 0; e < all_elements.size(); ++e) {
    if (all_elements[e] != static_cast<BaseInt>(e)) {
      return ThrowRange(env, "element " + std::to_string(e) + " is in no subset (elements are 0.." +
                                 std::to_string(all_elements.back()) + ")");
    }
  }
  return true;
}

enum class Kind {
  kTrivial, kRandom, kGreedy, kElementDegree, kLazyElementDegree, kSteepest, kGuidedLocalSearch, kGuidedTabuSearch,
  kMip
};

std::optional<Kind> ParseKind(const std::string& name) {
  static const std::pair<const char*, Kind> kKinds[] = {
      {"TRIVIAL", Kind::kTrivial},
      {"RANDOM", Kind::kRandom},
      {"GREEDY", Kind::kGreedy},
      {"ELEMENT_DEGREE", Kind::kElementDegree},
      {"LAZY_ELEMENT_DEGREE", Kind::kLazyElementDegree},
      {"STEEPEST", Kind::kSteepest},
      {"GUIDED_LOCAL_SEARCH", Kind::kGuidedLocalSearch},
      {"GUIDED_TABU_SEARCH", Kind::kGuidedTabuSearch},
      {"MIP", Kind::kMip},
  };
  for (const auto& [kind_name, kind] : kKinds) {
    if (name == kind_name) return kind;
  }
  return std::nullopt;
}

struct MipBackend {
  const char* name;
  SetCoverMipSolver solver;
  MPSolver::OptimizationProblemType problem_type;
};

constexpr MipBackend kMipBackends[] = {
    {"SCIP", SetCoverMipSolver::SCIP, MPSolver::SCIP_MIXED_INTEGER_PROGRAMMING},
    {"SAT", SetCoverMipSolver::SAT, MPSolver::SAT_INTEGER_PROGRAMMING},
    {"GUROBI", SetCoverMipSolver::GUROBI, MPSolver::GUROBI_MIXED_INTEGER_PROGRAMMING},
    {"GLOP", SetCoverMipSolver::GLOP, MPSolver::GLOP_LINEAR_PROGRAMMING},
    {"PDLP", SetCoverMipSolver::PDLP, MPSolver::PDLP_LINEAR_PROGRAMMING},
};

const MipBackend* FindMipBackend(const std::string& name) {
  for (const MipBackend& backend : kMipBackends) {
    if (name == backend.name) return MPSolver::SupportsProblemType(backend.problem_type) ? &backend : nullptr;
  }
  return nullptr;
}

const char* MpStatusName(MPSolver::ResultStatus status) {
  switch (status) {
    case MPSolver::OPTIMAL: return "OPTIMAL";
    case MPSolver::FEASIBLE: return "FEASIBLE";
    case MPSolver::INFEASIBLE: return "INFEASIBLE";
    case MPSolver::UNBOUNDED: return "UNBOUNDED";
    case MPSolver::ABNORMAL: return "ABNORMAL";
    case MPSolver::MODEL_INVALID: return "MODEL_INVALID";
    case MPSolver::NOT_SOLVED: return "NOT_SOLVED";
    default: return "UNKNOWN";
  }
}

// One heuristic run, fully read from JS before anything native is touched.
struct RunRequest {
  Kind kind = Kind::kTrivial;
  std::optional<std::vector<SubsetIndex>> focus;  // nullopt: every subset
  std::optional<int64_t> max_iterations;
  std::optional<double> time_limit_seconds;
  std::optional<double> epsilon, lagrangian_factor, penalty_factor;
  std::optional<int64_t> tabu_list_size;
  const MipBackend* mip_backend = nullptr;
  bool use_integers = true;
};

struct RunResult {
  bool found = false;
  std::optional<MPSolver::ResultStatus> mip_status;
};

// Reads options.<key> when present (undefined counts as absent).
bool ReadOptionalNumber(Napi::Env env, const Napi::Object& options, const char* key, std::optional<double>* out) {
  Napi::Value v = options.Get(key);
  if (env.IsExceptionPending()) return false;
  if (v.IsUndefined()) return true;
  if (!v.IsNumber() || !std::isfinite(v.As<Napi::Number>().DoubleValue())) {
    return ThrowType(env, std::string(key) + " must be a finite number");
  }
  *out = v.As<Napi::Number>().DoubleValue();
  return true;
}

bool ReadOptionalCount(Napi::Env env, const Napi::Object& options, const char* key, int64_t min, int64_t max,
                       std::optional<int64_t>* out) {
  Napi::Value v = options.Get(key);
  if (env.IsExceptionPending()) return false;
  if (v.IsUndefined()) return true;
  int64_t value;
  if (!ReadInt64(env, v, /*allow_infinite=*/false, key, &value)) return false;
  if (value < min || value > max) {
    return ThrowRange(env, std::string(key) + " must be in [" + std::to_string(min) + ", " + std::to_string(max) + "]");
  }
  *out = value;
  return true;
}

class SetCoverInvariantWrap : public Napi::ObjectWrap<SetCoverInvariantWrap> {
 public:
  static void Init(Napi::Env env, Napi::Object exports);
  explicit SetCoverInvariantWrap(const Napi::CallbackInfo& info);

  // Runs on the worker thread while busy, or on the main thread for runSync().
  // May throw C++ exceptions: callers guard it.
  RunResult Execute(const RunRequest& request);
  void EndRun() { state_.End(); }

 private:
  Napi::Value Run(const Napi::CallbackInfo& info);      // (kind, options, focus?) -> Promise<result>
  Napi::Value RunSync(const Napi::CallbackInfo& info);  // (kind, options, focus?) -> result
  Napi::Value Cost(const Napi::CallbackInfo& info);
  Napi::Value LowerBound(const Napi::CallbackInfo& info);
  Napi::Value NumUncoveredElements(const Napi::CallbackInfo& info);
  Napi::Value IsSelected(const Napi::CallbackInfo& info);
  Napi::Value Coverage(const Napi::CallbackInfo& info);
  Napi::Value LoadSolution(const Napi::CallbackInfo& info);  // (boolean[])
  Napi::Value Clear(const Napi::CallbackInfo& info);
  Napi::Value ClearRandomSubsets(const Napi::CallbackInfo& info);        // (count, focus?) -> number[]
  Napi::Value ClearMostCoveredElements(const Napi::CallbackInfo& info);  // (count, focus?) -> number[]
  Napi::Value IsBusy(const Napi::CallbackInfo& info);
  Napi::Value Dispose(const Napi::CallbackInfo& info);

  bool CheckUsable(Napi::Env env) const {
    if (!invariant_) {
      Napi::Error::New(env, "SetCoverInvariant has been disposed").ThrowAsJavaScriptException();
      return false;
    }
    return CheckNotBusy(env, state_, "SetCoverInvariant");
  }
  bool ReadFocus(Napi::Env env, const Napi::Value& v, std::optional<std::vector<SubsetIndex>>* out) const;
  bool ReadRunRequest(const Napi::CallbackInfo& info, RunRequest* request) const;
  bool CheckPreconditions(Napi::Env env, const RunRequest& request);
  Napi::Value ClearSubsets(const Napi::CallbackInfo& info, bool most_covered);
  std::vector<SubsetIndex> FocusOrAll(const std::optional<std::vector<SubsetIndex>>& focus) const {
    return focus ? *focus : model_->all_subsets();
  }

  std::unique_ptr<SetCoverModel> model_;
  std::unique_ptr<SetCoverInvariant> invariant_;  // points into model_
  BaseInt num_subsets_ = 0;
  AsyncSolveState state_;
};

Napi::Object RunResultToJs(Napi::Env env, const RunResult& result) {
  Napi::Object out = Napi::Object::New(env);
  out.Set("found", result.found);
  if (result.mip_status) out.Set("mipStatus", MpStatusName(*result.mip_status));
  return out;
}

class RunWorker : public PromiseWorker {
 public:
  RunWorker(Napi::Env env, Napi::Object owner, SetCoverInvariantWrap* wrapper, RunRequest request)
      : PromiseWorker(env, owner), wrapper_(wrapper), request_(std::move(request)) {}

 protected:
  void Execute() override {
    RunGuarded("set cover", [this] { result_ = wrapper_->Execute(request_); });
  }
  void Finish(bool succeeded) override { wrapper_->EndRun(); }
  Napi::Value Result(Napi::Env env) override { return RunResultToJs(env, result_); }

 private:
  SetCoverInvariantWrap* wrapper_;
  RunRequest request_;
  RunResult result_;
};

void SetCoverInvariantWrap::Init(Napi::Env env, Napi::Object exports) {
  exports.Set("SetCoverInvariant", DefineClass(env, "SetCoverInvariant", {
      InstanceMethod("run", &SetCoverInvariantWrap::Run),
      InstanceMethod("runSync", &SetCoverInvariantWrap::RunSync),
      InstanceMethod("cost", &SetCoverInvariantWrap::Cost),
      InstanceMethod("lowerBound", &SetCoverInvariantWrap::LowerBound),
      InstanceMethod("numUncoveredElements", &SetCoverInvariantWrap::NumUncoveredElements),
      InstanceMethod("isSelected", &SetCoverInvariantWrap::IsSelected),
      InstanceMethod("coverage", &SetCoverInvariantWrap::Coverage),
      InstanceMethod("loadSolution", &SetCoverInvariantWrap::LoadSolution),
      InstanceMethod("clear", &SetCoverInvariantWrap::Clear),
      InstanceMethod("clearRandomSubsets", &SetCoverInvariantWrap::ClearRandomSubsets),
      InstanceMethod("clearMostCoveredElements", &SetCoverInvariantWrap::ClearMostCoveredElements),
      InstanceMethod("isBusy", &SetCoverInvariantWrap::IsBusy),
      InstanceMethod("dispose", &SetCoverInvariantWrap::Dispose),
  }));
}

// new SetCoverInvariant(costs: number[], columns: number[][], name?: string)
SetCoverInvariantWrap::SetCoverInvariantWrap(const Napi::CallbackInfo& info)
    : Napi::ObjectWrap<SetCoverInvariantWrap>(info) {
  Napi::Env env = info.Env();
  std::vector<double> costs;
  if (!ReadDoubleArray(env, info[0], "costs", &costs)) return;
  if (!info[1].IsArray()) {
    ThrowType(env, "columns must be an Array of element arrays");
    return;
  }
  Napi::Array column_array = info[1].As<Napi::Array>();
  const uint32_t num_columns = column_array.Length();
  if (env.IsExceptionPending()) return;
  std::vector<std::vector<BaseInt>> columns(num_columns);
  for (uint32_t s = 0; s < num_columns; ++s) {
    Napi::Value column = column_array.Get(s);
    if (env.IsExceptionPending()) return;
    if (!ReadIndexArray(env, column, "columns[" + std::to_string(s) + "]", kMaxElement + 1, &columns[s])) return;
  }
  const std::string name = info[2].IsString() ? info[2].As<Napi::String>().Utf8Value() : "SetCoverModel";
  if (!ValidateModel(env, costs, columns)) return;
  GuardCpp(env, "new SetCoverInvariant", [&] {
    auto model = std::make_unique<SetCoverModel>(name);
    for (size_t s = 0; s < costs.size(); ++s) {
      model->AddEmptySubset(costs[s]);
      for (const BaseInt element : columns[s]) model->AddElementToLastSubset(element);
    }
    invariant_ = std::make_unique<SetCoverInvariant>(model.get());  // Initialize() builds the row view
    model_ = std::move(model);
    num_subsets_ = static_cast<BaseInt>(costs.size());
  });
}

bool SetCoverInvariantWrap::ReadFocus(Napi::Env env, const Napi::Value& v,
                                      std::optional<std::vector<SubsetIndex>>* out) const {
  if (v.IsUndefined() || v.IsNull()) return true;
  std::vector<BaseInt> subsets;
  if (!ReadIndexArray(env, v, "focus", num_subsets_, &subsets)) return false;
  std::sort(subsets.begin(), subsets.end());
  subsets.erase(std::unique(subsets.begin(), subsets.end()), subsets.end());
  out->emplace();
  for (const BaseInt subset : subsets) (*out)->push_back(SubsetIndex(subset));
  return true;
}

bool SetCoverInvariantWrap::ReadRunRequest(const Napi::CallbackInfo& info, RunRequest* request) const {
  Napi::Env env = info.Env();
  if (!info[0].IsString()) return ThrowType(env, "kind must be a string");
  const std::string kind_name = info[0].As<Napi::String>().Utf8Value();
  const std::optional<Kind> kind = ParseKind(kind_name);
  if (!kind) return ThrowType(env, "Unknown set cover heuristic: '" + kind_name + "'");
  request->kind = *kind;
  if (!info[1].IsObject()) return ThrowType(env, "options must be an object");
  const Napi::Object options = info[1].As<Napi::Object>();
  constexpr int64_t kMaxSafe = 9007199254740991;
  if (!ReadOptionalCount(env, options, "maxIterations", 0, kMaxSafe, &request->max_iterations) ||
      !ReadOptionalNumber(env, options, "timeLimitSeconds", &request->time_limit_seconds) ||
      !ReadOptionalNumber(env, options, "epsilon", &request->epsilon) ||
      !ReadOptionalNumber(env, options, "lagrangianFactor", &request->lagrangian_factor) ||
      !ReadOptionalNumber(env, options, "penaltyFactor", &request->penalty_factor) ||
      !ReadOptionalCount(env, options, "tabuListSize", 1, kMaxTabuListSize, &request->tabu_list_size)) {
    return false;
  }
  if (request->time_limit_seconds &&
      (*request->time_limit_seconds < 0 || *request->time_limit_seconds > kMaxTimeLimitSeconds)) {
    return ThrowRange(env, "timeLimitSeconds must be in [0, 1e9]");
  }
  if (request->kind == Kind::kMip) {
    Napi::Value solver = options.Get("mipSolver");
    if (env.IsExceptionPending()) return false;
    const std::string solver_name = solver.IsString() ? solver.As<Napi::String>().Utf8Value() : "SCIP";
    request->mip_backend = FindMipBackend(solver_name);
    if (request->mip_backend == nullptr) {
      return ThrowType(env, "Unsupported or unavailable MIP solver: '" + solver_name + "'");
    }
    Napi::Value use_integers = options.Get("useIntegers");
    if (env.IsExceptionPending()) return false;
    if (!use_integers.IsUndefined()) {
      if (!use_integers.IsBoolean()) return ThrowType(env, "useIntegers must be a boolean");
      request->use_integers = use_integers.As<Napi::Boolean>().Value();
    }
  }
  return ReadFocus(env, info[2], &request->focus);
}

// Main thread, not busy: brings the invariant up to date and checks what the
// chosen heuristic assumes about it.
bool SetCoverInvariantWrap::CheckPreconditions(Napi::Env env, const RunRequest& request) {
  if (!GuardCpp(env, "set cover", [&] { invariant_->Recompute(CL::kFreeAndUncovered); })) return false;
  switch (request.kind) {
    case Kind::kGreedy:
    case Kind::kElementDegree:
    case Kind::kLazyElementDegree: {
      if (!request.focus) return true;  // the model is feasible
      SubsetBoolVector in_focus(SubsetIndex(num_subsets_), false);
      for (const SubsetIndex subset : *request.focus) in_focus[subset] = true;
      if (request.kind == Kind::kGreedy) {
        // Greedy updates the queue entry of every subset that shares an element
        // with the one it selects, focus or not; one never queued is written at
        // position -1. So every subset that can still be updated must be queued.
        for (const SubsetIndex subset : model_->SubsetRange()) {
          if (!in_focus[subset] && !invariant_->is_selected()[subset] && invariant_->num_free_elements()[subset] > 0) {
            return ThrowRange(env, "GREEDY's focus must include every unselected subset that still covers an "
                                   "uncovered element; subset " + std::to_string(subset.value()) + " is missing");
          }
        }
      }
      const auto& coverage = invariant_->coverage();
      const auto& rows = model_->rows();
      for (const auto element : model_->ElementRange()) {
        if (coverage[element] != 0) continue;
        const auto& row = rows[element];
        if (std::none_of(row.begin(), row.end(), [&](SubsetIndex s) { return in_focus[s]; })) {
          return ThrowRange(env, "the focus cannot cover element " + std::to_string(element.value()) +
                                     ", which the current solution leaves uncovered");
        }
      }
      return true;
    }
    case Kind::kGuidedLocalSearch:
    case Kind::kGuidedTabuSearch:
      if (invariant_->num_uncovered_elements() != 0) {
        return ThrowRange(env, "local search needs a complete cover first (run a solution generator)");
      }
      return true;
    default:
      return true;
  }
}

RunResult SetCoverInvariantWrap::Execute(const RunRequest& request) {
  using namespace operations_research;  // NOLINT: the heuristic classes
  RunResult result;
  SetCoverInvariant* inv = invariant_.get();
  const std::vector<SubsetIndex> focus = FocusOrAll(request.focus);
  SubsetBoolVector in_focus(SubsetIndex(num_subsets_), false);
  for (const SubsetIndex subset : focus) in_focus[subset] = true;
  // Calls the overload each generator implements (the others are broken
  // adapters upstream), after applying the shared settings.
  auto run_list = [&](SetCoverSolutionGenerator& generator) {
    if (request.max_iterations) generator.SetMaxIterations(*request.max_iterations);
    return generator.NextSolution(absl::MakeConstSpan(focus));
  };
  auto run_bools = [&](SetCoverSolutionGenerator& generator) {
    if (request.max_iterations) generator.SetMaxIterations(*request.max_iterations);
    return generator.NextSolution(in_focus);
  };
  switch (request.kind) {
    case Kind::kTrivial: { TrivialSolutionGenerator g(inv); result.found = run_list(g); break; }
    case Kind::kRandom: { RandomSolutionGenerator g(inv); result.found = run_list(g); break; }
    case Kind::kGreedy: { GreedySolutionGenerator g(inv); result.found = run_list(g); break; }
    case Kind::kElementDegree: { ElementDegreeSolutionGenerator g(inv); result.found = run_bools(g); break; }
    case Kind::kLazyElementDegree: { LazyElementDegreeSolutionGenerator g(inv); result.found = run_bools(g); break; }
    case Kind::kSteepest: { SteepestSearch g(inv); result.found = run_bools(g); break; }
    case Kind::kGuidedLocalSearch: {
      GuidedLocalSearch g(inv);  // its epsilon and alpha setters are private upstream
      result.found = run_list(g);
      break;
    }
    case Kind::kGuidedTabuSearch: {
      GuidedTabuSearch g(inv);
      if (request.epsilon) g.SetEpsilon(*request.epsilon);
      if (request.lagrangian_factor) g.SetLagrangianFactor(*request.lagrangian_factor);
      if (request.penalty_factor) g.SetPenaltyFactor(*request.penalty_factor);
      if (request.tabu_list_size) g.SetTabuListSize(static_cast<int>(*request.tabu_list_size));
      result.found = run_list(g);
      break;
    }
    case Kind::kMip: {
      SetCoverMip g(inv);
      g.UseMipSolver(request.mip_backend->solver).UseIntegers(request.use_integers);
      g.SetTimeLimitInSeconds(request.time_limit_seconds.value_or(kMaxTimeLimitSeconds));
      result.found = run_list(g);
      result.mip_status = g.solve_status();
      break;
    }
  }
  inv->Recompute(CL::kFreeAndUncovered);
  return result;
}

Napi::Value SetCoverInvariantWrap::Run(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  RunRequest request;
  if (!ReadRunRequest(info, &request) || !CheckUsable(env) || !CheckPreconditions(env, request)) {
    return env.Undefined();
  }
  state_.Begin();
  auto* worker = new RunWorker(env, info.This().As<Napi::Object>(), this, std::move(request));
  worker->Queue();
  return worker->Promise();
}

Napi::Value SetCoverInvariantWrap::RunSync(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  RunRequest request;
  if (!ReadRunRequest(info, &request) || !CheckUsable(env) || !CheckPreconditions(env, request)) {
    return env.Undefined();
  }
  RunResult result;
  if (!GuardCpp(env, "set cover", [&] { result = Execute(request); })) return env.Undefined();
  return RunResultToJs(env, result);
}

Napi::Value SetCoverInvariantWrap::Cost(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (!CheckUsable(env)) return env.Undefined();
  return Napi::Number::New(env, invariant_->cost());
}

Napi::Value SetCoverInvariantWrap::LowerBound(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (!CheckUsable(env)) return env.Undefined();
  return Napi::Number::New(env, invariant_->LowerBound());
}

Napi::Value SetCoverInvariantWrap::NumUncoveredElements(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (!CheckUsable(env)) return env.Undefined();
  return Napi::Number::New(env, invariant_->num_uncovered_elements());
}

Napi::Value SetCoverInvariantWrap::IsSelected(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (!CheckUsable(env)) return env.Undefined();
  const SubsetBoolVector& selected = invariant_->is_selected();
  Napi::Array out = Napi::Array::New(env, selected.size());
  for (BaseInt s = 0; s < num_subsets_; ++s) out.Set(s, Napi::Boolean::New(env, selected[SubsetIndex(s)]));
  return out;
}

Napi::Value SetCoverInvariantWrap::Coverage(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (!CheckUsable(env)) return env.Undefined();
  const auto& coverage = invariant_->coverage();
  Napi::Array out = Napi::Array::New(env, coverage.size());
  for (const auto element : model_->ElementRange()) out.Set(element.value(), coverage[element]);
  return out;
}

// (selected: boolean[]) with one entry per subset.
Napi::Value SetCoverInvariantWrap::LoadSolution(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (!info[0].IsArray()) THROW_TYPE_AND_RETURN(env, "loadSolution(selected: boolean[])", env.Undefined());
  Napi::Array array = info[0].As<Napi::Array>();
  const uint32_t n = array.Length();
  if (env.IsExceptionPending()) return env.Undefined();
  std::vector<bool> selected(n);
  for (uint32_t i = 0; i < n; ++i) {
    Napi::Value item = array.Get(i);
    if (env.IsExceptionPending()) return env.Undefined();
    if (!item.IsBoolean()) THROW_TYPE_AND_RETURN(env, "selected[" + std::to_string(i) + "] must be a boolean", env.Undefined());
    selected[i] = item.As<Napi::Boolean>().Value();
  }
  if (!CheckUsable(env)) return env.Undefined();
  if (n != static_cast<uint32_t>(num_subsets_)) {
    ThrowRange(env, "selected has " + std::to_string(n) + " entries; the model has " + std::to_string(num_subsets_) +
                        " subsets");
    return env.Undefined();
  }
  GuardCpp(env, "loadSolution", [&] {
    SubsetBoolVector solution(selected.begin(), selected.end());
    invariant_->LoadSolution(solution);
    invariant_->Recompute(CL::kFreeAndUncovered);
  });
  return env.Undefined();
}

Napi::Value SetCoverInvariantWrap::Clear(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (!CheckUsable(env)) return env.Undefined();
  GuardCpp(env, "clear", [&] { invariant_->Clear(); });
  return env.Undefined();
}

// (count, focus?) -> subset indices that can be reused as a focus (OR-Tools'
// contract). ClearRandomSubsets also clears the selected subsets intersecting the
// ones it picks, so more than `count` may be deselected.
Napi::Value SetCoverInvariantWrap::ClearSubsets(const Napi::CallbackInfo& info, bool most_covered) {
  Napi::Env env = info.Env();
  int64_t count;
  std::optional<std::vector<SubsetIndex>> focus;
  if (!ReadInt64(env, info[0], /*allow_infinite=*/false, "numSubsets", &count) || !ReadFocus(env, info[1], &focus) ||
      !CheckUsable(env)) {
    return env.Undefined();
  }
  if (count < 0) {
    ThrowRange(env, "numSubsets must be >= 0");
    return env.Undefined();
  }
  const BaseInt bounded = static_cast<BaseInt>(std::min<int64_t>(count, num_subsets_));
  std::vector<SubsetIndex> cleared;
  if (!GuardCpp(env, most_covered ? "clearMostCoveredElements" : "clearRandomSubsets", [&] {
        invariant_->Recompute(CL::kCostAndCoverage);
        const std::vector<SubsetIndex> subsets = FocusOrAll(focus);
        cleared = most_covered ? operations_research::ClearMostCoveredElements(subsets, bounded, invariant_.get())
                               : operations_research::ClearRandomSubsets(subsets, bounded, invariant_.get());
        invariant_->Recompute(CL::kFreeAndUncovered);
      })) {
    return env.Undefined();
  }
  Napi::Array out = Napi::Array::New(env, cleared.size());
  for (size_t i = 0; i < cleared.size(); ++i) out.Set(static_cast<uint32_t>(i), cleared[i].value());
  return out;
}

Napi::Value SetCoverInvariantWrap::ClearRandomSubsets(const Napi::CallbackInfo& info) {
  return ClearSubsets(info, /*most_covered=*/false);
}

Napi::Value SetCoverInvariantWrap::ClearMostCoveredElements(const Napi::CallbackInfo& info) {
  return ClearSubsets(info, /*most_covered=*/true);
}

Napi::Value SetCoverInvariantWrap::IsBusy(const Napi::CallbackInfo& info) {
  return Napi::Boolean::New(info.Env(), state_.busy());
}

Napi::Value SetCoverInvariantWrap::Dispose(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (!invariant_) return env.Undefined();  // already disposed
  if (!CheckUsable(env)) return env.Undefined();
  invariant_.reset();
  model_.reset();
  return env.Undefined();
}

}  // namespace

void InitSetCover(Napi::Env env, Napi::Object exports) {
  SetCoverInvariantWrap::Init(env, exports);
  Napi::Array solvers = Napi::Array::New(env);
  for (const MipBackend& backend : kMipBackends) {
    if (FindMipBackend(backend.name) != nullptr) solvers.Set(solvers.Length(), backend.name);
  }
  exports.Set("setCoverMipSolvers", solvers);
}

}  // namespace ortools_node
