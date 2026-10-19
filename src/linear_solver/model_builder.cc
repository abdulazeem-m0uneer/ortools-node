// model_builder binding (Python's ortools.linear_solver.python.model_builder).
//
// The JS layer owns the model and sends it as an MPModelRequest in proto JSON;
// this file solves it with SolveMPModel() and converts the response to a plain
// object. OR-Tools validates the model itself (an invalid one comes back as
// MODEL_INVALID with a message), so no model data is checked here.
//
// ModelSolverHelper is not used: its Solve(ModelBuilderHelper) dereferences an
// empty std::optional when a backend fails, and its SolveRequest() always
// passes an interrupter, which SolveMPModel() rejects with
// INCOMPATIBLE_OPTIONS for every backend that cannot be interrupted (SCIP, CBC,
// HiGHS...). Here an interrupter is passed only when the backend supports it.

#include "linear_solver/model_builder.h"

#include <napi.h>

#include <cstring>
#include <memory>
#include <string>
#include <utility>

#include "absl/status/statusor.h"
#include "common/async_worker.h"
#include "common/cpp_guard.h"
#include "common/napi_util.h"
#include "common/proto_json.h"
#include "common/proto_to_js.h"
#include "ortools/linear_solver/linear_solver.h"
#include "ortools/linear_solver/linear_solver.pb.h"
#include "ortools/linear_solver/model_exporter.h"
#include "ortools/linear_solver/solve_mp_model.h"
#include "ortools/lp_data/lp_parser.h"
#include "ortools/lp_data/mps_reader.h"
#include "ortools/util/solve_interrupter.h"

using operations_research::MPModelExportOptions;
using operations_research::MPModelProto;
using operations_research::MPModelRequest;
using operations_research::MPSolutionResponse;
using operations_research::MPSolver;
using operations_research::MPSolverResponseStatus;
using operations_research::SolveInterrupter;

namespace ortools_node {
namespace {

// The names Python's model_builder.SolveStatus uses.
const char* SolveStatusName(MPSolverResponseStatus status) {
  switch (status) {
    case operations_research::MPSOLVER_OPTIMAL: return "OPTIMAL";
    case operations_research::MPSOLVER_FEASIBLE: return "FEASIBLE";
    case operations_research::MPSOLVER_INFEASIBLE: return "INFEASIBLE";
    case operations_research::MPSOLVER_UNBOUNDED: return "UNBOUNDED";
    case operations_research::MPSOLVER_ABNORMAL: return "ABNORMAL";
    case operations_research::MPSOLVER_NOT_SOLVED: return "NOT_SOLVED";
    case operations_research::MPSOLVER_MODEL_IS_VALID: return "MODEL_IS_VALID";
    case operations_research::MPSOLVER_CANCELLED_BY_USER: return "CANCELLED_BY_USER";
    case operations_research::MPSOLVER_MODEL_INVALID:
    case operations_research::MPSOLVER_MODEL_INVALID_SOLUTION_HINT: return "MODEL_INVALID";
    case operations_research::MPSOLVER_MODEL_INVALID_SOLVER_PARAMETERS: return "INVALID_SOLVER_PARAMETERS";
    case operations_research::MPSOLVER_SOLVER_TYPE_UNAVAILABLE: return "SOLVER_TYPE_UNAVAILABLE";
    case operations_research::MPSOLVER_INCOMPATIBLE_OPTIONS: return "INCOMPATIBLE_OPTIONS";
    default: return "UNKNOWN_STATUS";
  }
}

// Solver names as MPSolver::ParseSolverType() reads them ("SCIP", "glop",
// "CP_SAT"...), and only backends compiled into this build.
bool ParseAvailableSolver(const std::string& name, MPModelRequest::SolverType* out) {
  MPSolver::OptimizationProblemType type;
  if (!MPSolver::ParseSolverType(name, &type) || !MPSolver::SupportsProblemType(type)) return false;
  *out = static_cast<MPModelRequest::SolverType>(type);
  return true;
}

Napi::Float64Array ToFloat64Array(Napi::Env env, const google::protobuf::RepeatedField<double>& values) {
  Napi::Float64Array array = Napi::Float64Array::New(env, values.size());
  if (!values.empty()) std::memcpy(array.Data(), values.data(), values.size() * sizeof(double));
  return array;
}

bool IsHighs(MPModelRequest::SolverType type) {
  return type == MPModelRequest::HIGHS_LINEAR_PROGRAMMING || type == MPModelRequest::HIGHS_MIXED_INTEGER_PROGRAMMING;
}

// OR-Tools' HiGHS proto solver stores row activities in dual_value (both 9.14
// and 9.15), so its duals are withheld rather than reported wrong.
bool ReportsDualValues(MPModelRequest::SolverType type) {
  return !IsHighs(type);
}

Napi::Object ResponseToJs(Napi::Env env, const MPSolutionResponse& response, MPModelRequest::SolverType type) {
  Napi::Object out = Napi::Object::New(env);
  out.Set("status", SolveStatusName(response.status()));
  out.Set("statusString", response.status_str());
  out.Set("objectiveValue", response.objective_value());
  out.Set("bestObjectiveBound", response.best_objective_bound());
  out.Set("variableValues", ToFloat64Array(env, response.variable_value()));
  out.Set("dualValues", ReportsDualValues(type) ? ToFloat64Array(env, response.dual_value())
                                                 : Napi::Float64Array::New(env, 0));
  out.Set("reducedCosts", ToFloat64Array(env, response.reduced_cost()));
  out.Set("wallTime", response.solve_info().solve_wall_time_seconds());
  out.Set("userTime", response.solve_info().solve_user_time_seconds());
  return out;
}


class ModelBuilderSolver : public Napi::ObjectWrap<ModelBuilderSolver> {
 public:
  static void Init(Napi::Env env, Napi::Object exports);
  explicit ModelBuilderSolver(const Napi::CallbackInfo& info);

  void EndSolve() { solve_state_.End(); }
  MPModelRequest::SolverType solver_type() const { return solver_type_; }

 private:
  Napi::Value Solve(const Napi::CallbackInfo& info);      // (requestJson) -> Promise<response>
  Napi::Value SolveSync(const Napi::CallbackInfo& info);  // (requestJson) -> response
  Napi::Value Interrupt(const Napi::CallbackInfo& info);  // () -> boolean
  Napi::Value IsBusy(const Napi::CallbackInfo& info);

  // Parses the request and points it at this solver's backend.
  bool ReadRequest(const Napi::CallbackInfo& info, MPModelRequest* request) {
    Napi::Env env = info.Env();
    if (!ParseProtoJson(env, info[0], "MPModelRequest", request)) return false;
    if (!CheckNotBusy(env, solve_state_, "Solver")) return false;  // after reading the arguments
    request->set_solver_type(solver_type_);
    // OR-Tools' HiGHS wrapper segfaults on any solution hint (9.14 and 9.15).
    // A hint is only advice, so it is dropped rather than refused.
    if (IsHighs(solver_type_)) request->mutable_model()->clear_solution_hint();
    // HiGHS prints its banner to stdout even without internal output. Put
    // first, so the caller's own output_flag still wins.
    if (IsHighs(solver_type_) && !request->enable_internal_solver_output()) {
      request->set_solver_specific_parameters("output_flag=false\n" + request->solver_specific_parameters());
    }
    return true;
  }

  MPModelRequest::SolverType solver_type_ = MPModelRequest::GLOP_LINEAR_PROGRAMMING;
  bool interruptible_ = false;
  AsyncSolveState solve_state_;
  // One per async solve: an interrupted SolveInterrupter stays interrupted.
  std::unique_ptr<SolveInterrupter> interrupter_;
};

class ModelBuilderSolveWorker : public PromiseWorker {
 public:
  ModelBuilderSolveWorker(Napi::Env env, Napi::Object self, ModelBuilderSolver* wrapper, MPModelRequest request,
                          const SolveInterrupter* interrupter)
      : PromiseWorker(env, self), wrapper_(wrapper), request_(std::move(request)), interrupter_(interrupter) {}

 protected:
  void Execute() override {
    RunGuarded("solve", [this] {
      response_ = operations_research::SolveMPModel(std::move(request_), interrupter_);
    });
  }
  void Finish(bool succeeded) override { wrapper_->EndSolve(); }
  Napi::Value Result(Napi::Env env) override { return ResponseToJs(env, response_, wrapper_->solver_type()); }

 private:
  ModelBuilderSolver* wrapper_;
  MPModelRequest request_;
  const SolveInterrupter* interrupter_;  // owned by the wrapper, which outlives the worker
  MPSolutionResponse response_;
};

void ModelBuilderSolver::Init(Napi::Env env, Napi::Object exports) {
  Napi::Function func = DefineClass(env, "ModelBuilderSolver", {
      InstanceMethod("solve", &ModelBuilderSolver::Solve),
      InstanceMethod("solveSync", &ModelBuilderSolver::SolveSync),
      InstanceMethod("interrupt", &ModelBuilderSolver::Interrupt),
      InstanceMethod("isBusy", &ModelBuilderSolver::IsBusy),
  });
  exports.Set("ModelBuilderSolver", func);
}

// new ModelBuilderSolver(solverName: string)
ModelBuilderSolver::ModelBuilderSolver(const Napi::CallbackInfo& info) : Napi::ObjectWrap<ModelBuilderSolver>(info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsString()) {
    THROW_TYPE_AND_RETURN(env, "new Solver(solverName: string), e.g. 'GLOP', 'SCIP', 'CP_SAT', 'HIGHS', 'PDLP'", );
  }
  const std::string name = info[0].As<Napi::String>().Utf8Value();
  if (!ParseAvailableSolver(name, &solver_type_)) {
    THROW_AND_RETURN(env, "Unsupported or unavailable solver: '" + name + "' (check isSolverSupported())", );
  }
  interruptible_ = operations_research::SolverTypeSupportsInterruption(solver_type_);
}

Napi::Value ModelBuilderSolver::Solve(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  MPModelRequest request;
  if (!ReadRequest(info, &request)) return env.Undefined();
  interrupter_ = interruptible_ ? std::make_unique<SolveInterrupter>() : nullptr;
  solve_state_.Begin();
  auto* worker = new ModelBuilderSolveWorker(env, info.This().As<Napi::Object>(), this, std::move(request),
                                             interrupter_.get());
  worker->Queue();
  return worker->Promise();
}

Napi::Value ModelBuilderSolver::SolveSync(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  MPModelRequest request;
  if (!ReadRequest(info, &request)) return env.Undefined();
  MPSolutionResponse response;
  if (!GuardCpp(env, "solveSync", [&] {
        response = operations_research::SolveMPModel(std::move(request), /*interrupter=*/nullptr);
      })) {
    return env.Undefined();
  }
  return ResponseToJs(env, response, solver_type_);
}

// Asks a running solve() to stop. False when none is running or the backend
// cannot be interrupted (MPSolver::SolverTypeSupportsInterruption).
Napi::Value ModelBuilderSolver::Interrupt(const Napi::CallbackInfo& info) {
  const bool interrupted = solve_state_.busy() && interrupter_ != nullptr;
  if (interrupted) interrupter_->Interrupt();
  return Napi::Boolean::New(info.Env(), interrupted);
}

Napi::Value ModelBuilderSolver::IsBusy(const Napi::CallbackInfo& info) {
  return Napi::Boolean::New(info.Env(), solve_state_.busy());
}

// ---- LP / MPS ---------------------------------------------------------------

using Exporter = absl::StatusOr<std::string> (*)(const MPModelProto&, const MPModelExportOptions&);

// (modelJson: string, obfuscate: boolean) -> string
Napi::Value ExportModel(const Napi::CallbackInfo& info, Exporter exporter, const char* format) {
  Napi::Env env = info.Env();
  MPModelProto model;
  if (!ParseProtoJson(env, info[0], "MPModelProto", &model)) return env.Undefined();
  MPModelExportOptions options;
  options.obfuscate = info[1].ToBoolean();
  absl::StatusOr<std::string> text;
  if (!GuardCpp(env, format, [&] { text = exporter(model, options); })) return env.Undefined();
  if (!text.ok()) {
    THROW_AND_RETURN(env, std::string("Cannot export the model as ") + format + ": " + std::string(text.status().message()),
                     env.Undefined());
  }
  return Napi::String::New(env, *text);
}

// (text: string) -> MPModelProto as a JS object (unset proto2 fields are absent)
template <typename Parser>
Napi::Value ImportModel(const Napi::CallbackInfo& info, Parser parser, const char* format) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsString()) {
    THROW_TYPE_AND_RETURN(env, std::string(format) + " model must be a string", env.Undefined());
  }
  const std::string text = info[0].As<Napi::String>().Utf8Value();
  absl::StatusOr<MPModelProto> model;
  if (!GuardCpp(env, format, [&] { model = parser(text); })) return env.Undefined();
  if (!model.ok()) {
    THROW_AND_RETURN(env, std::string("Cannot parse the ") + format + " model: " + std::string(model.status().message()),
                     env.Undefined());
  }
  return MessageToJs(env, *model);
}

}  // namespace

void InitModelBuilder(Napi::Env env, Napi::Object exports) {
  ModelBuilderSolver::Init(env, exports);
  exports.Set("mbIsSolverSupported", Napi::Function::New(env, [](const Napi::CallbackInfo& info) -> Napi::Value {
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsString()) {
      THROW_TYPE_AND_RETURN(env, "isSolverSupported(solverName: string)", env.Undefined());
    }
    MPModelRequest::SolverType type;
    return Napi::Boolean::New(env, ParseAvailableSolver(info[0].As<Napi::String>().Utf8Value(), &type));
  }));
  exports.Set("mbExportToLpString", Napi::Function::New(env, [](const Napi::CallbackInfo& info) {
    return ExportModel(info, &operations_research::ExportModelAsLpFormat, "LP");
  }));
  exports.Set("mbExportToMpsString", Napi::Function::New(env, [](const Napi::CallbackInfo& info) {
    return ExportModel(info, &operations_research::ExportModelAsMpsFormat, "MPS");
  }));
  exports.Set("mbImportFromLpString", Napi::Function::New(env, [](const Napi::CallbackInfo& info) {
    return ImportModel(info, [](const std::string& text) { return operations_research::ModelProtoFromLpFormat(text); },
                       "LP");
  }));
  exports.Set("mbImportFromMpsString", Napi::Function::New(env, [](const Napi::CallbackInfo& info) {
    return ImportModel(
        info, [](const std::string& text) { return operations_research::glop::MpsDataToMPModelProto(text); }, "MPS");
  }));
}

}  // namespace ortools_node
