// KnapsackSolver binding (pywrapknapsack_solver's equivalent).
//
// OR-Tools CHECK-fails (aborting the whole process) on mismatched sizes, on a
// single-dimension algorithm given several dimensions, on too many items for
// the brute-force / 64-items algorithms, and indexes vectors unchecked in
// BestSolutionContains. Every one of those is validated here first. Negative
// values and int64 overflow in the sums OR-Tools computes are rejected too.
//
// Items weighing 0 in every dimension belong to some optimal solution (profits
// are >= 0), so they are taken up front and never reach OR-Tools: its dynamic
// programming solver drops them at capacity 0, and the 64-items solver reads
// past the end of an empty item list.
//
// Solving twice without a new init() returns a wrong profit from the
// branch-and-bound solver, so every solve() needs its own init().

#include "algorithms/knapsack_solver.h"

#include <napi.h>

#include <algorithm>
#include <cstdint>
#include <limits>
#include <memory>
#include <string>
#include <vector>

#include "common/async_worker.h"
#include "common/cpp_guard.h"
#include "common/int64.h"
#include "common/napi_util.h"
#include "ortools/algorithms/knapsack_solver.h"
#include "ortools/linear_solver/linear_solver.h"

using operations_research::MPSolver;
using NativeKnapsackSolver = operations_research::KnapsackSolver;

namespace ortools_node {
namespace {

struct SolverTypeInfo {
  const char* name;
  NativeKnapsackSolver::SolverType type;
  bool single_dimension;
  int max_items;  // 0 = no limit beyond int
  // MIP-based algorithms need their MPSolver backend in the build.
  bool needs_mp_backend;
  MPSolver::OptimizationProblemType mp_backend;
};

constexpr int kNoItemLimit = 0;
constexpr int64_t kMaxSafeInteger = 9007199254740991;  // 2^53 - 1
constexpr int kForcedItem = -1;  // an item taken up front, unseen by OR-Tools

const SolverTypeInfo kSolverTypes[] = {
    {"KNAPSACK_BRUTE_FORCE_SOLVER", NativeKnapsackSolver::KNAPSACK_BRUTE_FORCE_SOLVER, true, 30, false,
     MPSolver::GLOP_LINEAR_PROGRAMMING},
    {"KNAPSACK_64ITEMS_SOLVER", NativeKnapsackSolver::KNAPSACK_64ITEMS_SOLVER, true, 64, false,
     MPSolver::GLOP_LINEAR_PROGRAMMING},
    {"KNAPSACK_DYNAMIC_PROGRAMMING_SOLVER", NativeKnapsackSolver::KNAPSACK_DYNAMIC_PROGRAMMING_SOLVER, true,
     kNoItemLimit, false, MPSolver::GLOP_LINEAR_PROGRAMMING},
    {"KNAPSACK_DIVIDE_AND_CONQUER_SOLVER", NativeKnapsackSolver::KNAPSACK_DIVIDE_AND_CONQUER_SOLVER, true,
     kNoItemLimit, false, MPSolver::GLOP_LINEAR_PROGRAMMING},
    {"KNAPSACK_MULTIDIMENSION_BRANCH_AND_BOUND_SOLVER",
     NativeKnapsackSolver::KNAPSACK_MULTIDIMENSION_BRANCH_AND_BOUND_SOLVER, false, kNoItemLimit, false,
     MPSolver::GLOP_LINEAR_PROGRAMMING},
    {"KNAPSACK_MULTIDIMENSION_CP_SAT_SOLVER", NativeKnapsackSolver::KNAPSACK_MULTIDIMENSION_CP_SAT_SOLVER, false,
     kNoItemLimit, false, MPSolver::GLOP_LINEAR_PROGRAMMING},
    {"KNAPSACK_MULTIDIMENSION_CBC_MIP_SOLVER", NativeKnapsackSolver::KNAPSACK_MULTIDIMENSION_CBC_MIP_SOLVER, false,
     kNoItemLimit, true, MPSolver::CBC_MIXED_INTEGER_PROGRAMMING},
    {"KNAPSACK_MULTIDIMENSION_SCIP_MIP_SOLVER", NativeKnapsackSolver::KNAPSACK_MULTIDIMENSION_SCIP_MIP_SOLVER, false,
     kNoItemLimit, true, MPSolver::SCIP_MIXED_INTEGER_PROGRAMMING},
// OR-Tools 9.14 declares these two only when built with the solver.
#if ORTOOLS_VERSION_MAJOR > 9 || ORTOOLS_VERSION_MINOR >= 15 || defined(USE_XPRESS)
    {"KNAPSACK_MULTIDIMENSION_XPRESS_MIP_SOLVER", NativeKnapsackSolver::KNAPSACK_MULTIDIMENSION_XPRESS_MIP_SOLVER,
     false, kNoItemLimit, true, MPSolver::XPRESS_MIXED_INTEGER_PROGRAMMING},
#endif
#if ORTOOLS_VERSION_MAJOR > 9 || ORTOOLS_VERSION_MINOR >= 15 || defined(USE_CPLEX)
    {"KNAPSACK_MULTIDIMENSION_CPLEX_MIP_SOLVER", NativeKnapsackSolver::KNAPSACK_MULTIDIMENSION_CPLEX_MIP_SOLVER,
     false, kNoItemLimit, true, MPSolver::CPLEX_MIXED_INTEGER_PROGRAMMING},
#endif
};

// The dynamic programming and divide-and-conquer solvers allocate O(capacity)
// memory. Past this many units (about 1.6 GB) the allocation could succeed on
// an overcommitting kernel and get the process killed later, so it is refused.
constexpr int64_t kMaxCapacityPerUnitSolvers = 100000000;

bool AllocatesPerCapacityUnit(NativeKnapsackSolver::SolverType type) {
  return type == NativeKnapsackSolver::KNAPSACK_DYNAMIC_PROGRAMMING_SOLVER ||
         type == NativeKnapsackSolver::KNAPSACK_DIVIDE_AND_CONQUER_SOLVER;
}

bool IsAvailable(const SolverTypeInfo& info) {
  return !info.needs_mp_backend || MPSolver::SupportsProblemType(info.mp_backend);
}

const SolverTypeInfo* FindAvailableSolverType(const std::string& name) {
  for (const SolverTypeInfo& info : kSolverTypes) {
    if (name == info.name) return IsAvailable(info) ? &info : nullptr;
  }
  return nullptr;
}

std::string AvailableSolverTypeList() {
  std::string list;
  for (const SolverTypeInfo& info : kSolverTypes) {
    if (!IsAvailable(info)) continue;
    if (!list.empty()) list += ", ";
    list += info.name;
  }
  return list;
}

bool ThrowRange(Napi::Env env, const std::string& message) {
  Napi::RangeError::New(env, message).ThrowAsJavaScriptException();
  return false;
}

bool ReadNonNegativeArray(Napi::Env env, const Napi::Value& v, const std::string& what, std::vector<int64_t>* out) {
  if (!ReadInt64Array(env, v, /*allow_infinite=*/false, what.c_str(), out)) return false;
  for (size_t i = 0; i < out->size(); ++i) {
    if ((*out)[i] < 0) return ThrowRange(env, what + "[" + std::to_string(i) + "] must be >= 0");
  }
  return true;
}

// OR-Tools adds profits and weights up without overflow checks. `values` are >= 0.
bool CheckedSum(Napi::Env env, const std::vector<int64_t>& values, const std::string& what, int64_t* sum) {
  *sum = 0;
  for (int64_t value : values) {
    if (value > std::numeric_limits<int64_t>::max() - *sum) {
      return ThrowRange(env, "the sum of " + what + " overflows a 64-bit integer");
    }
    *sum += value;
  }
  return true;
}

class KnapsackSolver : public Napi::ObjectWrap<KnapsackSolver> {
 public:
  static void Init(Napi::Env env, Napi::Object exports);
  explicit KnapsackSolver(const Napi::CallbackInfo& info);

  // Runs on the worker thread while busy, or on the main thread for
  // solveSync(). May throw C++ exceptions: callers guard it.
  int64_t RunSolve() {
    if (native_item_count_ == 0) return forced_profit_;
    // OR-Tools starts the clock when the limit is set, so restart it here.
    solver_->set_time_limit(time_limit_seconds_);
    return forced_profit_ + solver_->Solve();
  }
  void FinishSolve(bool succeeded) {
    solve_state_.End();
    state_ = succeeded ? State::kSolved : State::kEmpty;
  }

 private:
  Napi::Value InitProblem(const Napi::CallbackInfo& info);  // (profits, weights[][], capacities)
  Napi::Value Solve(const Napi::CallbackInfo& info);        // () -> Promise<number>
  Napi::Value SolveSync(const Napi::CallbackInfo& info);    // () -> number
  Napi::Value BestSolutionContains(const Napi::CallbackInfo& info);  // (item) -> boolean
  Napi::Value IsSolutionOptimal(const Napi::CallbackInfo& info);
  Napi::Value SetTimeLimit(const Napi::CallbackInfo& info);    // (seconds)
  Napi::Value SetUseReduction(const Napi::CallbackInfo& info);  // (boolean)
  Napi::Value UseReduction(const Napi::CallbackInfo& info);
  Napi::Value Name(const Napi::CallbackInfo& info);
  Napi::Value IsBusy(const Napi::CallbackInfo& info);
  Napi::Value Dispose(const Napi::CallbackInfo& info);

  bool CheckUsable(Napi::Env env) const {
    if (!solver_) {
      Napi::Error::New(env, "KnapsackSolver has been disposed").ThrowAsJavaScriptException();
      return false;
    }
    return CheckNotBusy(env, solve_state_, "KnapsackSolver");
  }
  bool CheckLoaded(Napi::Env env) const {
    if (!CheckUsable(env)) return false;
    if (state_ != State::kLoaded) {
      Napi::Error::New(env,
                       "No problem loaded: call init() before each solve() "
                       "(setUseReduction() also needs a new init())")
          .ThrowAsJavaScriptException();
      return false;
    }
    return true;
  }
  bool CheckSolved(Napi::Env env) const {
    if (!CheckUsable(env)) return false;
    if (state_ != State::kSolved) {
      Napi::Error::New(env, "No solve result: call init() and solve() first").ThrowAsJavaScriptException();
      return false;
    }
    return true;
  }
  bool ValidateShape(Napi::Env env, size_t num_items, size_t num_dimensions) const;
  void LoadProblem(const std::vector<int64_t>& profits, const std::vector<std::vector<int64_t>>& weights,
                   const std::vector<int64_t>& capacities);

  enum class State { kEmpty, kLoaded, kSolved };

  std::unique_ptr<NativeKnapsackSolver> solver_;
  const SolverTypeInfo* type_ = nullptr;
  AsyncSolveState solve_state_;
  double time_limit_seconds_ = std::numeric_limits<double>::infinity();
  State state_ = State::kEmpty;
  // Per item: its index in the problem OR-Tools sees, or kForcedItem.
  std::vector<int> native_index_;
  size_t native_item_count_ = 0;
  int64_t forced_profit_ = 0;  // profit of the kForcedItem items
};

class KnapsackSolveWorker : public PromiseWorker {
 public:
  KnapsackSolveWorker(Napi::Env env, Napi::Object self, KnapsackSolver* wrapper)
      : PromiseWorker(env, self), wrapper_(wrapper) {}

 protected:
  void Execute() override {
    RunGuarded("knapsack solve", [this] { profit_ = wrapper_->RunSolve(); });
  }
  void Finish(bool succeeded) override { wrapper_->FinishSolve(succeeded); }
  Napi::Value Result(Napi::Env env) override { return Int64ToJs(env, profit_, "best profit"); }

 private:
  KnapsackSolver* wrapper_;
  int64_t profit_ = 0;
};

void KnapsackSolver::Init(Napi::Env env, Napi::Object exports) {
  Napi::Function func = DefineClass(env, "KnapsackSolver", {
      InstanceMethod("init", &KnapsackSolver::InitProblem),
      InstanceMethod("solve", &KnapsackSolver::Solve),
      InstanceMethod("solveSync", &KnapsackSolver::SolveSync),
      InstanceMethod("bestSolutionContains", &KnapsackSolver::BestSolutionContains),
      InstanceMethod("isSolutionOptimal", &KnapsackSolver::IsSolutionOptimal),
      InstanceMethod("setTimeLimit", &KnapsackSolver::SetTimeLimit),
      InstanceMethod("setUseReduction", &KnapsackSolver::SetUseReduction),
      InstanceMethod("useReduction", &KnapsackSolver::UseReduction),
      InstanceMethod("name", &KnapsackSolver::Name),
      InstanceMethod("isBusy", &KnapsackSolver::IsBusy),
      InstanceMethod("dispose", &KnapsackSolver::Dispose),
  });
  exports.Set("KnapsackSolver", func);

  Napi::Object types = Napi::Object::New(env);
  for (const SolverTypeInfo& info : kSolverTypes) {
    if (IsAvailable(info)) types.Set(info.name, Napi::String::New(env, info.name));
  }
  types.Freeze();
  exports.Set("knapsackSolverTypes", types);
}

// new KnapsackSolver(solverType: string, name?: string)
KnapsackSolver::KnapsackSolver(const Napi::CallbackInfo& info) : Napi::ObjectWrap<KnapsackSolver>(info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsString()) {
    THROW_TYPE_AND_RETURN(env, "new KnapsackSolver(solverType: string, name?: string)", );
  }
  if (info.Length() > 1 && !info[1].IsUndefined() && !info[1].IsString()) {
    THROW_TYPE_AND_RETURN(env, "KnapsackSolver name must be a string", );
  }
  const std::string type_name = info[0].As<Napi::String>().Utf8Value();
  type_ = FindAvailableSolverType(type_name);
  if (type_ == nullptr) {
    THROW_AND_RETURN(env, "Unsupported or unavailable knapsack solver type: '" + type_name +
                              "'. Available in this build: " + AvailableSolverTypeList(), );
  }
  const std::string name = info.Length() > 1 && info[1].IsString() ? info[1].As<Napi::String>().Utf8Value()
                                                                     : std::string("knapsack");
  GuardCpp(env, "new KnapsackSolver", [&] { solver_ = std::make_unique<NativeKnapsackSolver>(type_->type, name); });
}

bool KnapsackSolver::ValidateShape(Napi::Env env, size_t num_items, size_t num_dimensions) const {
  if (num_items > static_cast<size_t>(std::numeric_limits<int>::max())) {
    return ThrowRange(env, "too many items");
  }
  if (num_dimensions == 0) return ThrowRange(env, "weights must have at least one dimension");
  if (type_->single_dimension && num_dimensions != 1) {
    return ThrowRange(env, std::string(type_->name) + " handles exactly one dimension, got " +
                               std::to_string(num_dimensions));
  }
  if (type_->max_items != kNoItemLimit && num_items > static_cast<size_t>(type_->max_items)) {
    return ThrowRange(env, std::string(type_->name) + " handles at most " + std::to_string(type_->max_items) +
                               " items, got " + std::to_string(num_items));
  }
  return true;
}

// Reads every JS value before touching the native solver: element getters and
// Proxies run user code, which may dispose() this solver or start a solve().
Napi::Value KnapsackSolver::InitProblem(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 3 || !info[1].IsArray()) {
    THROW_TYPE_AND_RETURN(env, "init(profits: int[], weights: int[][], capacities: int[])", env.Undefined());
  }
  std::vector<int64_t> profits;
  int64_t profit_sum;
  if (!ReadNonNegativeArray(env, info[0], "profits", &profits) || !CheckedSum(env, profits, "profits", &profit_sum)) {
    return env.Undefined();
  }
  // The best profit comes back as a JS number, which must hold it exactly.
  if (profit_sum > kMaxSafeInteger) {
    ThrowRange(env, "the sum of profits exceeds Number.MAX_SAFE_INTEGER");
    return env.Undefined();
  }

  Napi::Array weight_rows = info[1].As<Napi::Array>();
  const uint32_t num_dimensions = weight_rows.Length();
  if (env.IsExceptionPending()) return env.Undefined();
  std::vector<std::vector<int64_t>> weights(num_dimensions);
  std::vector<int64_t> weight_sums(weights.size());
  for (uint32_t d = 0; d < weights.size(); ++d) {
    const std::string what = "weights[" + std::to_string(d) + "]";
    const Napi::Value row = weight_rows.Get(d);
    if (env.IsExceptionPending()) return env.Undefined();
    if (!ReadNonNegativeArray(env, row, what, &weights[d]) ||
        !CheckedSum(env, weights[d], what, &weight_sums[d])) {
      return env.Undefined();
    }
    if (weights[d].size() != profits.size()) {
      ThrowRange(env, what + " has " + std::to_string(weights[d].size()) + " items but profits has " +
                          std::to_string(profits.size()));
      return env.Undefined();
    }
  }
  std::vector<int64_t> capacities;
  if (!ReadNonNegativeArray(env, info[2], "capacities", &capacities)) return env.Undefined();
  if (capacities.size() != weights.size()) {
    ThrowRange(env, "capacities has " + std::to_string(capacities.size()) + " entries but weights has " +
                        std::to_string(weights.size()) + " dimensions");
    return env.Undefined();
  }
  // Every argument is read: no user code runs past this point.
  if (!CheckUsable(env) || !ValidateShape(env, profits.size(), weights.size())) return env.Undefined();

  // A capacity above the dimension's total weight binds nothing; capping it
  // keeps the optimum and bounds the memory of the dynamic-programming solvers,
  // which allocate O(capacity).
  for (size_t d = 0; d < capacities.size(); ++d) capacities[d] = std::min(capacities[d], weight_sums[d]);
  if (AllocatesPerCapacityUnit(type_->type) && capacities[0] > kMaxCapacityPerUnitSolvers) {
    ThrowRange(env, std::string(type_->name) + " needs memory proportional to the capacity; it handles at most " +
                        std::to_string(kMaxCapacityPerUnitSolvers) +
                        " (after capping it to the total weight). Use a branch-and-bound or CP-SAT solver type");
    return env.Undefined();
  }

  state_ = State::kEmpty;
  if (!GuardCpp(env, "knapsack init", [&] { LoadProblem(profits, weights, capacities); })) return env.Undefined();
  state_ = State::kLoaded;
  return env.Undefined();
}

void KnapsackSolver::LoadProblem(const std::vector<int64_t>& profits,
                                 const std::vector<std::vector<int64_t>>& weights,
                                 const std::vector<int64_t>& capacities) {
  std::vector<int64_t> native_profits;
  std::vector<std::vector<int64_t>> native_weights(weights.size());
  native_index_.assign(profits.size(), kForcedItem);
  forced_profit_ = 0;
  for (size_t item = 0; item < profits.size(); ++item) {
    bool weightless = true;
    for (const std::vector<int64_t>& row : weights) weightless = weightless && row[item] == 0;
    if (weightless) {
      forced_profit_ += profits[item];  // cannot overflow: the sum of all profits was checked
      continue;
    }
    native_index_[item] = static_cast<int>(native_profits.size());
    native_profits.push_back(profits[item]);
    for (size_t d = 0; d < weights.size(); ++d) native_weights[d].push_back(weights[d][item]);
  }
  native_item_count_ = native_profits.size();
  if (native_item_count_ > 0) solver_->Init(native_profits, native_weights, capacities);
}

Napi::Value KnapsackSolver::Solve(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (!CheckLoaded(env)) return env.Undefined();
  solve_state_.Begin();
  KnapsackSolveWorker* worker = new KnapsackSolveWorker(env, info.This().As<Napi::Object>(), this);
  worker->Queue();
  return worker->Promise();
}

Napi::Value KnapsackSolver::SolveSync(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (!CheckLoaded(env)) return env.Undefined();
  int64_t profit = 0;
  const bool ok = GuardCpp(env, "knapsack solve", [&] { profit = RunSolve(); });
  FinishSolve(ok);
  if (!ok) return env.Undefined();
  return Int64ToJs(env, profit, "best profit");
}

Napi::Value KnapsackSolver::BestSolutionContains(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (!CheckSolved(env)) return env.Undefined();
  size_t item;
  if (!ReadIndex(env, info[0], native_index_.size(), "item", &item)) return env.Undefined();
  const int native_item = native_index_[item];
  if (native_item == kForcedItem) return Napi::Boolean::New(env, true);
  bool contains = false;  // some OR-Tools solvers use vector::at()
  if (!GuardCpp(env, "bestSolutionContains", [&] { contains = solver_->BestSolutionContains(native_item); })) {
    return env.Undefined();
  }
  return Napi::Boolean::New(env, contains);
}

Napi::Value KnapsackSolver::IsSolutionOptimal(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (!CheckSolved(env)) return env.Undefined();
  return Napi::Boolean::New(env, native_item_count_ == 0 || solver_->IsSolutionOptimal());
}

Napi::Value KnapsackSolver::SetTimeLimit(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (!CheckUsable(env)) return env.Undefined();
  double seconds;
  if (!ReadNumber(env, info[0], /*allow_infinite=*/true, "seconds", &seconds)) return env.Undefined();
  if (seconds < 0) {
    ThrowRange(env, "setTimeLimit(seconds): must be >= 0 (Infinity = no limit)");
    return env.Undefined();
  }
  // Also bounds the reduction init() runs. MPSolver::infinity() is a real infinity.
  if (!GuardCpp(env, "setTimeLimit", [&] { solver_->set_time_limit(seconds); })) return env.Undefined();
  time_limit_seconds_ = seconds;
  return env.Undefined();
}

Napi::Value KnapsackSolver::SetUseReduction(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (!CheckUsable(env)) return env.Undefined();
  if (info.Length() < 1 || !info[0].IsBoolean()) {
    THROW_TYPE_AND_RETURN(env, "setUseReduction(useReduction: boolean)", env.Undefined());
  }
  const bool use_reduction = info[0].As<Napi::Boolean>().Value();
  // init() lays out the problem for one setting; reading it with the other
  // would index OR-Tools' item mapping out of bounds.
  if (use_reduction != solver_->use_reduction()) {
    solver_->set_use_reduction(use_reduction);
    state_ = State::kEmpty;
  }
  return env.Undefined();
}

Napi::Value KnapsackSolver::UseReduction(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (!CheckUsable(env)) return env.Undefined();
  return Napi::Boolean::New(env, solver_->use_reduction());
}

Napi::Value KnapsackSolver::Name(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (!CheckUsable(env)) return env.Undefined();
  std::string name;
  if (!GuardCpp(env, "name", [&] { name = solver_->GetName(); })) return env.Undefined();
  return Napi::String::New(env, name);
}

Napi::Value KnapsackSolver::IsBusy(const Napi::CallbackInfo& info) {
  return Napi::Boolean::New(info.Env(), solve_state_.busy());
}

Napi::Value KnapsackSolver::Dispose(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (!solver_) return env.Undefined();  // already disposed
  if (!CheckUsable(env)) return env.Undefined();
  solver_.reset();
  state_ = State::kEmpty;
  return env.Undefined();
}

}  // namespace

void InitKnapsackSolver(Napi::Env env, Napi::Object exports) { KnapsackSolver::Init(env, exports); }

}  // namespace ortools_node
