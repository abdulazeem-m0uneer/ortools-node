// CpSolver: decision builders, search monitors, limits, solution collectors and
// the three ways to search (newSearch/nextSolution/endSearch, solve, solveAsync).
//
// JS monitors are plain objects with optional enterSearch / exitSearch /
// atSolution methods, called synchronously from inside the search. A throw is
// recorded, the search is stopped through the interrupt limit, and the error is
// rethrown once OR-Tools has unwound. Searches never run with the fail
// intercept installed: a failure in a search is how OR-Tools backtracks.

#include <napi.h>

#include <cmath>
#include <cstdint>
#include <memory>
#include <string>
#include <unordered_set>
#include <vector>

#include "absl/time/time.h"
#include "common/async_worker.h"
#include "common/cpp_guard.h"
#include "common/int64.h"
#include "common/napi_util.h"
#include "constraint_solver/cp_solver.h"

namespace ortools_node {

using operations_research::DecisionBuilder;
using operations_research::IntVar;
using operations_research::SearchMonitor;
using operations_research::SolutionCollector;
using operations_research::Solver;

// ---------------------------------------------------------------------------
// JS search monitors
// ---------------------------------------------------------------------------

class JsMonitorSet::Monitor : public SearchMonitor {
 public:
  Monitor(Solver* solver, JsMonitorSet* set, const Napi::ObjectReference* object)
      : SearchMonitor(solver), set_(set), object_(object) {}

  void EnterSearch() override { set_->Invoke(*object_, "enterSearch"); }
  void ExitSearch() override { set_->Invoke(*object_, "exitSearch"); }
  bool AtSolution() override {
    Napi::HandleScope scope(set_->env_);
    Napi::Value result = set_->Invoke(*object_, "atSolution");
    if (result.IsEmpty() || !result.IsBoolean()) return false;
    if (!result.As<Napi::Boolean>().Value()) {
      // Not FinishCurrentSearch(): its flag outlives the search and would end
      // the next one at its first failure. The interrupt limit stops cleanly.
      set_->context_->stop_flag()->store(true);
      return false;
    }
    return true;
  }
  std::string DebugString() const override { return "JsSearchMonitor"; }

 private:
  JsMonitorSet* set_;
  const Napi::ObjectReference* object_;  // owned by the set
};

JsMonitorSet::JsMonitorSet(Napi::Env env, CpContext* context) : env_(env), context_(context) {}
JsMonitorSet::~JsMonitorSet() = default;

bool JsMonitorSet::Read(const Napi::Value& objects) {
  if (objects.IsUndefined()) return true;
  if (!objects.IsArray()) THROW_TYPE_AND_RETURN(env_, "JS search monitors must be an array", false);
  Napi::Array array = objects.As<Napi::Array>();
  const uint32_t n = array.Length();
  if (env_.IsExceptionPending()) return false;
  objects_.reserve(n);
  for (uint32_t i = 0; i < n; ++i) {
    Napi::Value v = array.Get(i);
    if (env_.IsExceptionPending()) return false;
    if (!v.IsObject()) THROW_TYPE_AND_RETURN(env_, "a JS search monitor must be an object", false);
    objects_.push_back(Napi::Persistent(v.As<Napi::Object>()));
  }
  return true;
}

void JsMonitorSet::AppendTo(std::vector<SearchMonitor*>* monitors) {
  // objects_ is never resized after Read(), so the pointers below stay valid.
  for (const Napi::ObjectReference& object : objects_) {
    monitors_.push_back(std::make_unique<Monitor>(context_->solver(), this, &object));
    monitors->push_back(monitors_.back().get());
  }
}

Napi::Value JsMonitorSet::Invoke(const Napi::ObjectReference& object, const char* method) {
  if (failed_ || disabled_) return Napi::Value();
  Napi::EscapableHandleScope scope(env_);
  Napi::Object target = object.Value();
  Napi::Value fn = target.Get(method);
  Napi::Value result;
  if (!env_.IsExceptionPending()) {
    if (!fn.IsFunction()) return Napi::Value();
    result = fn.As<Napi::Function>().Call(target, {});
  }
  if (env_.IsExceptionPending()) {
    napi_value error;
    napi_get_and_clear_last_exception(env_, &error);
    // References to primitives need Node-API 9: hold the thrown value in an object.
    Napi::Object holder = Napi::Object::New(env_);
    holder.Set("error", Napi::Value(env_, error));
    error_ = Napi::Persistent(holder);
    failed_ = true;
    context_->stop_flag()->store(true);  // stop at the next limit check
    return Napi::Value();
  }
  return scope.Escape(result);
}

bool JsMonitorSet::RethrowIfFailed(Napi::Env env) {
  if (!failed_) return false;
  napi_throw(env, error_.Value().Get("error"));
  return true;
}

CpSolver::~CpSolver() {
  // A newSearch() left open: end it without calling back into JS (this may run
  // during garbage collection). Nothing can be reported from a finalizer.
  if (open_search_monitors_ && context_ && context_->solver() != nullptr) {
    open_search_monitors_->Disable();
    try {
      CloseOpenSearch();
    } catch (const std::exception&) {
    }
  }
}

// ---------------------------------------------------------------------------
// Decision builders, monitors, limits, collectors
// ---------------------------------------------------------------------------

namespace {

bool ReadVarStrategy(Napi::Env env, const Napi::Value& v, Solver::IntVarStrategy* out) {
  static const struct { const char* name; Solver::IntVarStrategy value; } kNames[] = {
      {"INT_VAR_DEFAULT", Solver::INT_VAR_DEFAULT},
      {"INT_VAR_SIMPLE", Solver::INT_VAR_SIMPLE},
      {"CHOOSE_FIRST_UNBOUND", Solver::CHOOSE_FIRST_UNBOUND},
      {"CHOOSE_RANDOM", Solver::CHOOSE_RANDOM},
      {"CHOOSE_MIN_SIZE_LOWEST_MIN", Solver::CHOOSE_MIN_SIZE_LOWEST_MIN},
      {"CHOOSE_MIN_SIZE_HIGHEST_MIN", Solver::CHOOSE_MIN_SIZE_HIGHEST_MIN},
      {"CHOOSE_MIN_SIZE_LOWEST_MAX", Solver::CHOOSE_MIN_SIZE_LOWEST_MAX},
      {"CHOOSE_MIN_SIZE_HIGHEST_MAX", Solver::CHOOSE_MIN_SIZE_HIGHEST_MAX},
      {"CHOOSE_LOWEST_MIN", Solver::CHOOSE_LOWEST_MIN},
      {"CHOOSE_HIGHEST_MAX", Solver::CHOOSE_HIGHEST_MAX},
      {"CHOOSE_MIN_SIZE", Solver::CHOOSE_MIN_SIZE},
      {"CHOOSE_MAX_SIZE", Solver::CHOOSE_MAX_SIZE},
      {"CHOOSE_MAX_REGRET_ON_MIN", Solver::CHOOSE_MAX_REGRET_ON_MIN},
  };
  const std::string name = v.IsString() ? v.As<Napi::String>().Utf8Value() : "";
  for (const auto& entry : kNames) {
    if (name == entry.name) {
      *out = entry.value;
      return true;
    }
  }
  THROW_TYPE_AND_RETURN(env, "unknown variable strategy '" + name + "'", false);
}

bool ReadValueStrategy(Napi::Env env, const Napi::Value& v, Solver::IntValueStrategy* out) {
  static const struct { const char* name; Solver::IntValueStrategy value; } kNames[] = {
      {"INT_VALUE_DEFAULT", Solver::INT_VALUE_DEFAULT},
      {"INT_VALUE_SIMPLE", Solver::INT_VALUE_SIMPLE},
      {"ASSIGN_MIN_VALUE", Solver::ASSIGN_MIN_VALUE},
      {"ASSIGN_MAX_VALUE", Solver::ASSIGN_MAX_VALUE},
      {"ASSIGN_RANDOM_VALUE", Solver::ASSIGN_RANDOM_VALUE},
      {"ASSIGN_CENTER_VALUE", Solver::ASSIGN_CENTER_VALUE},
      {"SPLIT_LOWER_HALF", Solver::SPLIT_LOWER_HALF},
      {"SPLIT_UPPER_HALF", Solver::SPLIT_UPPER_HALF},
  };
  const std::string name = v.IsString() ? v.As<Napi::String>().Utf8Value() : "";
  for (const auto& entry : kNames) {
    if (name == entry.name) {
      *out = entry.value;
      return true;
    }
  }
  THROW_TYPE_AND_RETURN(env, "unknown value strategy '" + name + "'", false);
}

// A non-negative count where Infinity means "no limit".
bool ReadLimitCount(Napi::Env env, const Napi::Value& v, const char* what, int64_t* out) {
  if (!ReadInt64(env, v, true, what, out)) return false;
  if (*out < 0) THROW_AND_RETURN(env, std::string(what) + " must be >= 0", false);
  return true;
}

std::string ReadString(const Napi::Value& v) { return v.IsString() ? v.As<Napi::String>().Utf8Value() : ""; }

}  // namespace

// Registers the monitor built by `make` (guarded) and returns its id.
#define BUILD_MONITOR(env, what, make, collector, needs_objective)                     \
  do {                                                                                \
    int built_id = -1;                                                                \
    if (!context_->RunGuarded((env), (what), [&] {                                    \
          SearchMonitor* built = (make);                                              \
          built_id = context_->RegisterMonitor(                                       \
              {built, (collector) ? static_cast<SolutionCollector*>(built) : nullptr, \
               (needs_objective), false, {}});                                        \
        })) {                                                                         \
      return (env).Undefined();                                                       \
    }                                                                                 \
    return Napi::Number::New((env), built_id);                                        \
  } while (0)

Napi::Value CpSolver::Phase(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  std::vector<uint32_t> ids;
  Solver::IntVarStrategy var_strategy;
  Solver::IntValueStrategy value_strategy;
  if (!ReadIdArray(env, info[0], "phase() variable", &ids) || !ReadVarStrategy(env, info[1], &var_strategy) ||
      !ReadValueStrategy(env, info[2], &value_strategy) || !CheckMutable(env)) {
    return env.Undefined();
  }
  std::vector<IntVar*> vars;
  if (!context_->VarsOrCastById(env, ids, "phase() variable", &vars)) return env.Undefined();
  int id = -1;
  if (!context_->RunGuarded(env, "phase()", [&] {
        id = context_->RegisterDecisionBuilder(context_->solver()->MakePhase(vars, var_strategy, value_strategy));
      })) {
    return env.Undefined();
  }
  return Napi::Number::New(env, id);
}

Napi::Value CpSolver::Compose(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  std::vector<uint32_t> ids;
  if (!ReadIdArray(env, info[0], "decision builder", &ids)) return env.Undefined();
  if (ids.empty()) THROW_AND_RETURN(env, "compose(dbs): at least one decision builder is required", env.Undefined());
  if (!CheckMutable(env)) return env.Undefined();
  std::vector<DecisionBuilder*> dbs;
  for (uint32_t db_id : ids) {
    DecisionBuilder* db = context_->DecisionBuilderById(env, db_id);
    if (db == nullptr) return env.Undefined();
    dbs.push_back(db);
  }
  int id = -1;
  if (!context_->RunGuarded(env, "compose()", [&] {
        id = context_->RegisterDecisionBuilder(context_->solver()->Compose(dbs));
      })) {
    return env.Undefined();
  }
  return Napi::Number::New(env, id);
}

// (maximize, objective, step) -> monitor id
Napi::Value CpSolver::Optimize(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  const bool maximize = info[0].ToBoolean();
  uint32_t objective_id;
  int64_t step;
  if (!ReadId(env, info[1], "objective", &objective_id) || !ReadInt64(env, info[2], false, "step", &step)) {
    return env.Undefined();
  }
  // OptimizeVar DCHECKs a positive step; a step <= 0 never improves.
  if (step <= 0) THROW_AND_RETURN(env, "step must be > 0", env.Undefined());
  if (!CheckMutable(env)) return env.Undefined();
  IntVar* objective = context_->VarOrCastById(env, objective_id, "objective");
  if (objective == nullptr) return env.Undefined();
  Solver* s = context_->solver();
  BUILD_MONITOR(env, maximize ? "maximize()" : "minimize()",
                maximize ? s->MakeMaximize(objective, step) : s->MakeMinimize(objective, step), false, false);
}

// (timeMs, branches, failures, solutions, smartTimeCheck, cumulative) -> monitor id
Napi::Value CpSolver::Limit(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (!info[0].IsNumber()) THROW_TYPE_AND_RETURN(env, "timeMs must be a number", env.Undefined());
  const double time_ms = info[0].As<Napi::Number>().DoubleValue();
  if (std::isnan(time_ms) || time_ms < 0) THROW_AND_RETURN(env, "timeMs must be >= 0", env.Undefined());
  int64_t branches, failures, solutions;
  if (!ReadLimitCount(env, info[1], "branches", &branches) || !ReadLimitCount(env, info[2], "failures", &failures) ||
      !ReadLimitCount(env, info[3], "solutions", &solutions)) {
    return env.Undefined();
  }
  const bool smart = info[4].ToBoolean();
  const bool cumulative = info[5].ToBoolean();
  if (!CheckMutable(env)) return env.Undefined();
  const absl::Duration time = std::isinf(time_ms) ? absl::InfiniteDuration() : absl::Milliseconds(time_ms);
  BUILD_MONITOR(env, "limit()",
                context_->solver()->MakeLimit(time, branches, failures, solutions, smart, cumulative), false, false);
}

// (period, objective?) -> monitor id
Napi::Value CpSolver::SearchLog(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  int64_t period;
  if (!ReadInt64(env, info[0], false, "period", &period)) return env.Undefined();
  if (period < 1 || period > INT32_MAX) THROW_AND_RETURN(env, "period must be in [1, 2^31 - 1]", env.Undefined());
  const bool has_objective = info.Length() > 1 && !info[1].IsUndefined();
  uint32_t objective_id = 0;
  if (has_objective && !ReadId(env, info[1], "objective", &objective_id)) return env.Undefined();
  if (!CheckMutable(env)) return env.Undefined();
  IntVar* var = nullptr;
  if (has_objective) {
    var = context_->VarOrCastById(env, objective_id, "objective");
    if (var == nullptr) return env.Undefined();
  }
  Solver* s = context_->solver();
  const int p = static_cast<int>(period);
  BUILD_MONITOR(env, "searchLog()", var == nullptr ? s->MakeSearchLog(p) : s->MakeSearchLog(p, var), false, false);
}

// (kind: 'first' | 'last' | 'best' | 'all', maximize?) -> monitor id
Napi::Value CpSolver::Collector(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  const std::string kind = ReadString(info[0]);
  const bool maximize = info[1].ToBoolean();
  if (kind != "first" && kind != "last" && kind != "best" && kind != "all") {
    THROW_TYPE_AND_RETURN(env, "unknown collector kind '" + kind + "'", env.Undefined());
  }
  if (!CheckMutable(env)) return env.Undefined();
  Solver* s = context_->solver();
  BUILD_MONITOR(env, "a solution collector",
                kind == "first"  ? s->MakeFirstSolutionCollector()
                : kind == "last" ? s->MakeLastSolutionCollector()
                : kind == "best" ? s->MakeBestValueSolutionCollector(maximize)
                                 : s->MakeAllSolutionCollector(),
                true, kind == "best");
}

#undef BUILD_MONITOR

Napi::Value CpSolver::CollectorAdd(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  uint32_t monitor_id;
  std::vector<uint32_t> ids;
  if (!ReadId(env, info[0], "search monitor", &monitor_id) || !ReadIdArray(env, info[1], "collected variable", &ids) ||
      !CheckMutable(env)) {
    return env.Undefined();
  }
  CpContext::MonitorEntry* entry = context_->CollectorById(env, monitor_id);
  std::vector<IntVar*> vars;
  if (entry == nullptr || !context_->VarsOrCastById(env, ids, "collected variable", &vars)) return env.Undefined();
  context_->RunGuarded(env, "add()", [&] { entry->collector->Add(vars); });
  return env.Undefined();
}

Napi::Value CpSolver::CollectorAddObjective(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  uint32_t monitor_id, objective_id;
  if (!ReadId(env, info[0], "search monitor", &monitor_id) || !ReadId(env, info[1], "objective", &objective_id) ||
      !CheckMutable(env)) {
    return env.Undefined();
  }
  CpContext::MonitorEntry* entry = context_->CollectorById(env, monitor_id);
  if (entry == nullptr) return env.Undefined();
  if (entry->has_objective) THROW_AND_RETURN(env, "this collector already has an objective", env.Undefined());
  IntVar* objective = context_->VarOrCastById(env, objective_id, "objective");
  if (objective == nullptr) return env.Undefined();
  if (context_->RunGuarded(env, "addObjective()", [&] { entry->collector->AddObjective(objective); })) {
    entry->has_objective = true;
  }
  return env.Undefined();
}

Napi::Value CpSolver::CollectorCount(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  uint32_t monitor_id;
  if (!ReadId(env, info[0], "search monitor", &monitor_id) || !CheckUsable(env)) return env.Undefined();
  CpContext::MonitorEntry* entry = context_->CollectorById(env, monitor_id);
  if (entry == nullptr) return env.Undefined();
  return Napi::Number::New(env, entry->collector->solution_count());
}

namespace {

// OR-Tools CHECKs the solution index of a collector.
bool CheckSolutionIndex(Napi::Env env, const SolutionCollector* collector, int64_t n) {
  if (n < 0 || n >= collector->solution_count()) {
    Napi::RangeError::New(env, "solution index out of range").ThrowAsJavaScriptException();
    return false;
  }
  return true;
}

}  // namespace

// (monitor, n, var) -> value of var in solution n
Napi::Value CpSolver::CollectorValue(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  uint32_t monitor_id, var_id;
  int64_t n;
  if (!ReadId(env, info[0], "search monitor", &monitor_id) || !ReadInt64(env, info[1], false, "solution", &n) ||
      !ReadId(env, info[2], "variable", &var_id) || !CheckUsable(env)) {
    return env.Undefined();
  }
  CpContext::MonitorEntry* entry = context_->CollectorById(env, monitor_id);
  if (entry == nullptr || !CheckSolutionIndex(env, entry->collector, n)) return env.Undefined();
  IntVar* var = context_->VarById(env, var_id, "variable");
  if (var == nullptr) return env.Undefined();
  // Assignment::Value() of a variable the collector does not hold dereferences null.
  const operations_research::Assignment* solution = entry->collector->solution(static_cast<int>(n));
  if (!solution->Contains(var)) {
    THROW_AND_RETURN(env, "IntVar '" + var->name() + "' was not added to this collector", env.Undefined());
  }
  return Int64ToJsNumberOrBigInt(env, solution->Value(var));
}

// (monitor, stat: 'objective' | 'wallTime' | 'branches' | 'failures', n)
Napi::Value CpSolver::CollectorStat(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  uint32_t monitor_id;
  int64_t n;
  const std::string stat = ReadString(info[1]);
  if (!ReadId(env, info[0], "search monitor", &monitor_id) || !ReadInt64(env, info[2], false, "solution", &n) ||
      !CheckUsable(env)) {
    return env.Undefined();
  }
  CpContext::MonitorEntry* entry = context_->CollectorById(env, monitor_id);
  if (entry == nullptr || !CheckSolutionIndex(env, entry->collector, n)) return env.Undefined();
  const int i = static_cast<int>(n);
  SolutionCollector* c = entry->collector;
  if (stat == "objective") {
    if (!entry->has_objective) {
      THROW_AND_RETURN(env, "this collector has no objective (addObjective())", env.Undefined());
    }
    return Int64ToJsNumberOrBigInt(env, c->objective_value(i));
  }
  if (stat == "wallTime") return Napi::Number::New(env, static_cast<double>(c->wall_time(i)));
  if (stat == "branches") return Napi::Number::New(env, static_cast<double>(c->branches(i)));
  if (stat == "failures") return Napi::Number::New(env, static_cast<double>(c->failures(i)));
  THROW_TYPE_AND_RETURN(env, "unknown collector statistic '" + stat + "'", env.Undefined());
}

// ---------------------------------------------------------------------------
// Searching
// ---------------------------------------------------------------------------

namespace {

// The arguments of Solver::Solve / NewSearch, read in phase 1.
struct SearchArgs {
  uint32_t db = 0;
  std::vector<uint32_t> monitors;
};

bool ReadSearchArgs(Napi::Env env, const Napi::Value& db_id, const Napi::Value& monitor_ids, SearchArgs* out) {
  if (!ReadId(env, db_id, "decision builder", &out->db)) return false;
  return monitor_ids.IsUndefined() || ReadIdArray(env, monitor_ids, "search monitor", &out->monitors);
}

// Phase 3: resolves the ids, appends the interrupt limit and resets the stop
// flag. Throws and returns false on bad ids.
bool ResolveSearch(Napi::Env env, CpContext* context, const SearchArgs& args, DecisionBuilder** db,
                   std::vector<SearchMonitor*>* monitors) {
  *db = context->DecisionBuilderById(env, args.db);
  if (*db == nullptr) return false;
  monitors->clear();
  std::unordered_set<SearchMonitor*> seen;
  for (uint32_t id : args.monitors) {
    CpContext::MonitorEntry* entry = context->MonitorById(env, id);
    if (entry == nullptr) return false;
    if (entry->needs_objective && !entry->has_objective) {
      THROW_AND_RETURN(env, "a bestValueSolutionCollector needs addObjective() before searching", false);
    }
    // Installing one monitor twice would run its callbacks twice.
    if (seen.insert(entry->monitor).second) monitors->push_back(entry->monitor);
  }
  if (!context->RunGuarded(env, "creating the interrupt limit",
                           [&] { monitors->push_back(context->InterruptLimit()); })) {
    return false;
  }
  context->stop_flag()->store(false);
  return true;
}

class CpSolveWorker : public PromiseWorker {
 public:
  CpSolveWorker(Napi::Env env, Napi::Object owner, std::shared_ptr<CpContext> context, DecisionBuilder* db,
                std::vector<SearchMonitor*> monitors)
      : PromiseWorker(env, owner), context_(std::move(context)), db_(db), monitors_(std::move(monitors)) {}

 protected:
  void Execute() override {
    RunGuarded("solveAsync()", [&] { found_ = context_->solver()->Solve(db_, monitors_); });
  }
  void Finish(bool succeeded) override {
    context_->set_search_open(false);
    context_->solve_state().End();
  }
  Napi::Value Result(Napi::Env env) override { return Napi::Boolean::New(env, found_); }

 private:
  std::shared_ptr<CpContext> context_;
  DecisionBuilder* db_;
  std::vector<SearchMonitor*> monitors_;
  bool found_ = false;
};

bool CheckOpenSearch(Napi::Env env, bool open, const CpContext& context, const char* what) {
  if (!open) THROW_AND_RETURN(env, std::string(what) + ": no search is open (call newSearch() first)", false);
  if (context.in_native_search()) {
    THROW_AND_RETURN(env, std::string(what) + " cannot be called from a search monitor", false);
  }
  return true;
}

}  // namespace

// (db, monitorIds, jsMonitors) -> bool
Napi::Value CpSolver::Solve(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  SearchArgs args;
  JsMonitorSet js_monitors(env, context_.get());
  if (!ReadSearchArgs(env, info[0], info[1], &args) || !js_monitors.Read(info[2]) || !CheckMutable(env)) {
    return env.Undefined();
  }
  DecisionBuilder* db;
  std::vector<SearchMonitor*> monitors;
  if (!ResolveSearch(env, context_.get(), args, &db, &monitors)) return env.Undefined();
  js_monitors.AppendTo(&monitors);
  context_->set_search_open(true);
  context_->set_in_native_search(true);
  bool found = false;
  const bool ok = GuardCpp(env, "solve()", [&] { found = context_->solver()->Solve(db, monitors); });
  context_->set_in_native_search(false);
  context_->set_search_open(false);
  if (!ok || js_monitors.RethrowIfFailed(env)) return env.Undefined();
  return Napi::Boolean::New(env, found);
}

Napi::Value CpSolver::NewSearch(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  SearchArgs args;
  auto js_monitors = std::make_unique<JsMonitorSet>(env, context_.get());
  if (!ReadSearchArgs(env, info[0], info[1], &args) || !js_monitors->Read(info[2]) || !CheckMutable(env)) {
    return env.Undefined();
  }
  DecisionBuilder* db;
  std::vector<SearchMonitor*> monitors;
  if (!ResolveSearch(env, context_.get(), args, &db, &monitors)) return env.Undefined();
  js_monitors->AppendTo(&monitors);
  open_search_monitors_ = std::move(js_monitors);
  context_->set_search_open(true);
  context_->set_in_native_search(true);
  const bool ok = GuardCpp(env, "newSearch()", [&] { context_->solver()->NewSearch(db, monitors); });
  context_->set_in_native_search(false);
  if (!ok) {
    open_search_monitors_->Disable();
    CloseOpenSearch();
  }
  return env.Undefined();  // an enterSearch() throw surfaces on nextSolution()
}

Napi::Value CpSolver::NextSolution(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (!CheckUsable(env) || !CheckOpenSearch(env, open_search_monitors_ != nullptr, *context_, "nextSolution()")) {
    return env.Undefined();
  }
  bool found = false;
  bool ok = true;
  if (!open_search_monitors_->failed()) {  // else enterSearch() threw
    context_->set_in_native_search(true);
    ok = GuardCpp(env, "nextSolution()", [&] { found = context_->solver()->NextSolution(); });
    context_->set_in_native_search(false);
  }
  if (!ok || open_search_monitors_->failed()) {
    // End the search, then rethrow; exitSearch() is not called after a throw.
    open_search_monitors_->Disable();
    std::unique_ptr<JsMonitorSet> monitors = CloseOpenSearch();
    if (ok) monitors->RethrowIfFailed(env);
    return env.Undefined();
  }
  return Napi::Boolean::New(env, found);
}

Napi::Value CpSolver::EndSearch(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (!CheckUsable(env) || !CheckOpenSearch(env, open_search_monitors_ != nullptr, *context_, "endSearch()")) {
    return env.Undefined();
  }
  std::unique_ptr<JsMonitorSet> monitors = CloseOpenSearch();
  monitors->RethrowIfFailed(env);  // exitSearch() threw
  return env.Undefined();
}

// Ends the open search; EndSearch() only backtracks and frees memory.
std::unique_ptr<JsMonitorSet> CpSolver::CloseOpenSearch() {
  context_->set_in_native_search(true);
  context_->solver()->EndSearch();
  context_->set_in_native_search(false);
  context_->set_search_open(false);
  return std::move(open_search_monitors_);
}

// (db, monitorIds) -> Promise<boolean>, solved on the libuv threadpool.
Napi::Value CpSolver::SolveAsync(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  SearchArgs args;
  if (!ReadSearchArgs(env, info[0], info[1], &args) || !CheckMutable(env)) return env.Undefined();
  DecisionBuilder* db;
  std::vector<SearchMonitor*> monitors;
  if (!ResolveSearch(env, context_.get(), args, &db, &monitors)) return env.Undefined();
  context_->solve_state().Begin();
  context_->set_search_open(true);
  auto* worker = new CpSolveWorker(env, info.This().As<Napi::Object>(), context_, db, std::move(monitors));
  worker->Queue();
  return worker->Promise();
}

// Asks the running search (sync, async or an open newSearch) to stop.
Napi::Value CpSolver::Interrupt(const Napi::CallbackInfo& info) {
  const bool running = context_->solver() != nullptr && context_->search_open();
  if (running) context_->stop_flag()->store(true);
  return Napi::Boolean::New(info.Env(), running);
}

}  // namespace ortools_node
