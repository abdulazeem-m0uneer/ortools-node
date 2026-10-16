// CP-SAT binding (cp_model.CpSolver's equivalent).
//
// Design notes
// ------------
// * The JS layer (lib/sat/) builds the CpModelProto itself, exactly like
//   Python's cp_model.py, and sends it as protobuf JSON. Native code only
//   parses, validates and solves it, so nothing the user writes can reach an
//   OR-Tools CHECK: ValidateInputCpModel rejects every malformed model first.
// * A CpSatSolver wrapper owns one AsyncSolveState: one solve at a time, and
//   its stop flag is registered on the solve's TimeLimit, so stopSearch()
//   interrupts every CP-SAT worker. Different wrappers solve concurrently.
// * Results come back as { response: <CpSolverResponse JSON without the
//   solution>, solution: Float64Array | BigInt64Array }.

#include "sat/cp_sat_solver.h"

#include <napi.h>

#include <memory>
#include <string>
#include <utility>
#include <vector>

#include "common/async_worker.h"
#include "common/cpp_guard.h"
#include "common/napi_util.h"
#include "common/proto_json.h"
#include "ortools/sat/cp_model.pb.h"
#include "ortools/sat/cp_model_checker.h"
#include "ortools/sat/cp_model_solver.h"
#include "ortools/sat/model.h"
#include "ortools/sat/sat_parameters.pb.h"
#include "ortools/util/time_limit.h"
#include "sat/sat_parameters.h"
#include "sat/solution_channel.h"
#include "sat/teardown_watch.h"

namespace ortools_node {
namespace {

using operations_research::TimeLimit;
using operations_research::sat::CpModelProto;
using operations_research::sat::CpSolverResponse;
using operations_research::sat::SatParameters;

// Any thread. `channel` may be null (no solution callback).
CpSolverResponse RunSolve(const CpModelProto& model, const SatParameters& params, std::atomic<bool>* stop_flag,
                          SolutionChannel* channel) {
  operations_research::sat::Model sat_model;
  sat_model.Add(operations_research::sat::NewSatParameters(params));
  sat_model.GetOrCreate<TimeLimit>()->RegisterExternalBooleanAsLimit(stop_flag);
  if (channel != nullptr) {
    sat_model.Add(operations_research::sat::NewFeasibleSolutionObserver(
        [channel](const CpSolverResponse& response) { channel->Publish(response); }));
  }
  return operations_research::sat::SolveCpModel(model, &sat_model);
}

// Main thread. { response: JSON string without the solution, solution: typed array }.
Napi::Value ResponseToJs(Napi::Env env, CpSolverResponse* response) {
  Napi::Value result = env.Undefined();
  GuardCpp(env, "CpSolverResponse", [&] {
    const std::vector<int64_t> values(response->solution().begin(), response->solution().end());
    response->clear_solution();
    Napi::Value json = ProtoToJson(env, *response);
    if (env.IsExceptionPending()) return;
    Napi::Object out = Napi::Object::New(env);
    out.Set("response", json);
    out.Set("solution", SolutionValuesToJs(env, values));
    result = out;
  });
  return env.IsExceptionPending() ? env.Undefined() : result;
}

// Parses a JSON proto argument; a C++ exception (e.g. out of memory on a huge
// model) becomes a JS error.
bool ParseProtoArgument(Napi::Env env, const Napi::Value& json, const char* what, google::protobuf::Message* out) {
  bool parsed = false;
  return GuardCpp(env, what, [&] { parsed = ParseProtoJson(env, json, what, out); }) && parsed;
}

// Parses and validates the (modelJson, paramsJson) arguments of solve().
bool ReadSolveArguments(const Napi::CallbackInfo& info, CpModelProto* model, SatParameters* params) {
  Napi::Env env = info.Env();
  if (!ParseProtoArgument(env, info[0], "CpModelProto", model)) return false;
  bool read = false;
  if (!GuardCpp(env, "SatParameters", [&] { read = ReadSatParameters(env, info[1], params); }) || !read) return false;
  std::string error;
  if (!GuardCpp(env, "ValidateCpModel", [&] { error = operations_research::sat::ValidateInputCpModel(*params, *model); })) {
    return false;
  }
  if (!error.empty()) THROW_AND_RETURN(env, "Invalid CpModel: " + error, false);
  return true;
}

class CpSatSolver : public Napi::ObjectWrap<CpSatSolver> {
 public:
  static Napi::Function Define(Napi::Env env) {
    return DefineClass(env, "CpSatSolver", {
        InstanceMethod("solve", &CpSatSolver::Solve),
        InstanceMethod("solveSync", &CpSatSolver::SolveSync),
        InstanceMethod("stopSearch", &CpSatSolver::StopSearch),
        InstanceMethod("isBusy", &CpSatSolver::IsBusy),
        InstanceMethod("abandon", &CpSatSolver::AbandonMethod),
    });
  }

  explicit CpSatSolver(const Napi::CallbackInfo& info) : Napi::ObjectWrap<CpSatSolver>(info) {}

  std::atomic<bool>* stop_flag() { return solve_state_.stop_flag(); }

  // Main thread: a solve starts / ends. While it runs, a TeardownWatch
  // abandons it once JS can no longer run, so terminating a worker thread
  // stops the search instead of waiting for its time limit.
  void BeginSolve(std::shared_ptr<SolutionChannel> channel, std::unique_ptr<TeardownWatch> watch) {
    solve_state_.Begin();
    active_channel_ = std::move(channel);
    teardown_watch_ = std::move(watch);
  }
  void EndSolve() {
    teardown_watch_.reset();
    active_channel_.reset();
    solve_state_.End();
  }

 private:
  Napi::Value Solve(const Napi::CallbackInfo& info);      // (modelJson, paramsJson, onSolution?) -> Promise
  Napi::Value SolveSync(const Napi::CallbackInfo& info);  // (modelJson, paramsJson) -> result
  // Raises the stop flag of the running solve; false when none is running.
  Napi::Value StopSearch(const Napi::CallbackInfo& info) {
    if (!solve_state_.busy()) return Napi::Boolean::New(info.Env(), false);
    solve_state_.RequestStop();
    return Napi::Boolean::New(info.Env(), true);
  }
  Napi::Value IsBusy(const Napi::CallbackInfo& info) { return Napi::Boolean::New(info.Env(), solve_state_.busy()); }
  // For process exit (lib/sat/cp_solver.js): JS will not run again.
  Napi::Value AbandonMethod(const Napi::CallbackInfo& info) {
    Abandon();
    return info.Env().Undefined();
  }

  // Stops the running solve and releases solver threads waiting for JS.
  void Abandon() {
    if (!solve_state_.busy()) return;
    solve_state_.RequestStop();
    if (active_channel_) active_channel_->Abandon();
  }

  AsyncSolveState solve_state_;
  std::shared_ptr<SolutionChannel> active_channel_;  // while a solve() with onSolution runs
  std::unique_ptr<TeardownWatch> teardown_watch_;    // while a solve() runs
};

class SolveWorker : public PromiseWorker {
 public:
  SolveWorker(Napi::Env env, Napi::Object owner, CpSatSolver* solver, CpModelProto model, SatParameters params,
              std::shared_ptr<SolutionChannel> channel)
      : PromiseWorker(env, owner),
        solver_(solver),
        model_(std::move(model)),
        params_(std::move(params)),
        channel_(std::move(channel)) {}

 protected:
  void Execute() override {
    RunGuarded("solve", [this] { response_ = RunSolve(model_, params_, solver_->stop_flag(), channel_.get()); });
    if (channel_) channel_->Release();
  }

  void Finish(bool succeeded) override { solver_->EndSolve(); }

  Napi::Value Result(Napi::Env env) override {
    if (channel_ && channel_->ThrowCallbackError(env)) return env.Undefined();
    return ResponseToJs(env, &response_);
  }

 private:
  CpSatSolver* solver_;
  CpModelProto model_;
  SatParameters params_;
  std::shared_ptr<SolutionChannel> channel_;
  CpSolverResponse response_;
};

// Every argument is read and converted before the busy check, so nothing read
// from JS can start or end a solve between the check and its use.
Napi::Value CpSatSolver::Solve(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  const bool has_callback = info.Length() > 2 && !info[2].IsUndefined();
  if (has_callback && !info[2].IsFunction()) {
    THROW_TYPE_AND_RETURN(env, "onSolution must be a function", env.Undefined());
  }
  CpModelProto model;
  SatParameters params;
  if (!ReadSolveArguments(info, &model, &params)) return env.Undefined();
  if (!CheckNotBusy(env, solve_state_, "CpSolver")) return env.Undefined();
  SolveWorker* worker = nullptr;
  std::shared_ptr<SolutionChannel> channel;
  std::unique_ptr<TeardownWatch> watch;
  const bool created = GuardCpp(env, "solve", [&] {
    if (has_callback) {
      channel = SolutionChannel::Create(env, info[2].As<Napi::Function>(), stop_flag());
      if (!channel) return;  // the thread-safe function could not be created
    }
    watch = TeardownWatch::Start(env, [this] { Abandon(); });
    if (!watch) return;
    worker = new SolveWorker(env, info.This().As<Napi::Object>(), this, std::move(model), std::move(params), channel);
  });
  if (!created || worker == nullptr) return env.Undefined();
  BeginSolve(std::move(channel), std::move(watch));
  worker->Queue();
  return worker->Promise();
}

Napi::Value CpSatSolver::SolveSync(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  CpModelProto model;
  SatParameters params;
  if (!ReadSolveArguments(info, &model, &params)) return env.Undefined();
  if (!CheckNotBusy(env, solve_state_, "CpSolver")) return env.Undefined();
  solve_state_.Begin();
  CpSolverResponse response;
  const bool solved = GuardCpp(env, "solveSync", [&] { response = RunSolve(model, params, stop_flag(), nullptr); });
  solve_state_.End();
  if (!solved) return env.Undefined();
  return ResponseToJs(env, &response);
}

// (modelJson) -> '' when the model is valid, else OR-Tools' description of the first error.
Napi::Value ValidateModel(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  CpModelProto model;
  if (!ParseProtoArgument(env, info[0], "CpModelProto", &model)) return env.Undefined();
  std::string error;
  if (!GuardCpp(env, "validate", [&] { error = operations_research::sat::ValidateCpModel(model); })) {
    return env.Undefined();
  }
  return Napi::String::New(env, error);
}

// (modelJson) -> CpModelStats() text.
Napi::Value ModelStats(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  CpModelProto model;
  if (!ParseProtoArgument(env, info[0], "CpModelProto", &model)) return env.Undefined();
  std::string stats;
  if (!GuardCpp(env, "modelStats", [&] { stats = operations_research::sat::CpModelStats(model); })) {
    return env.Undefined();
  }
  return Napi::String::New(env, stats);
}

// (responseJson, hasObjective) -> CpSolverResponseStats() text.
Napi::Value ResponseStats(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 2 || !info[1].IsBoolean()) {
    THROW_TYPE_AND_RETURN(env, "hasObjective must be a boolean", env.Undefined());
  }
  const bool has_objective = info[1].As<Napi::Boolean>().Value();
  CpSolverResponse response;
  if (!ParseProtoArgument(env, info[0], "CpSolverResponse", &response)) return env.Undefined();
  std::string stats;
  if (!GuardCpp(env, "responseStats", [&] {
        stats = operations_research::sat::CpSolverResponseStats(response, has_objective);
      })) {
    return env.Undefined();
  }
  return Napi::String::New(env, stats);
}

}  // namespace

void InitCpSatSolver(Napi::Env env, Napi::Object exports) {
  using operations_research::sat::CpSolverStatus_descriptor;
  using operations_research::sat::DecisionStrategyProto_DomainReductionStrategy_descriptor;
  using operations_research::sat::DecisionStrategyProto_VariableSelectionStrategy_descriptor;
  exports.Set("CpSatSolver", CpSatSolver::Define(env));
  exports.Set("validateCpModel", Napi::Function::New(env, ValidateModel));
  exports.Set("cpModelStats", Napi::Function::New(env, ModelStats));
  exports.Set("cpSolverResponseStats", Napi::Function::New(env, ResponseStats));
  exports.Set("CpSolverStatus", EnumNames(env, CpSolverStatus_descriptor()));
  exports.Set("VariableSelectionStrategy", EnumNames(env, DecisionStrategyProto_VariableSelectionStrategy_descriptor()));
  exports.Set("DomainReductionStrategy", EnumNames(env, DecisionStrategyProto_DomainReductionStrategy_descriptor()));
}

}  // namespace ortools_node
