// MathOpt binding (Python's ortools.math_opt.python.mathopt).
//
// The JS layer owns the model and sends a ModelProto, SolveParametersProto and
// ModelSolveParametersProto as proto JSON; Solver::NonIncrementalSolve() from
// math_opt/core/solver.h solves them (the proto-level API the binary release
// exports for every registered solver) and the SolveResultProto goes back as
// JSON. MathOpt validates the model and parameters itself and returns a Status
// for bad input, which becomes a JS error.

#include "math_opt/math_opt.h"

#include <napi.h>

#include <memory>
#include <string>
#include <utility>

#include "absl/status/status.h"
#include "absl/status/statusor.h"
#include "common/async_worker.h"
#include "common/cpp_guard.h"
#include "common/napi_util.h"
#include "common/proto_json.h"
#include "ortools/linear_solver/linear_solver.h"
#include "ortools/math_opt/core/solver.h"
#include "ortools/math_opt/core/solver_interface.h"
#include "ortools/math_opt/model.pb.h"
#include "ortools/math_opt/model_parameters.pb.h"
#include "ortools/math_opt/parameters.pb.h"
#include "ortools/math_opt/result.pb.h"
#include "ortools/math_opt/solution.pb.h"
#include "ortools/util/solve_interrupter.h"

namespace math_opt = operations_research::math_opt;
using operations_research::SolveInterrupter;

namespace ortools_node {
namespace {

constexpr char kSolverTypePrefix[] = "SOLVER_TYPE_";

// Marks objects created by MathOptSolveInterrupter, so any other wrapped
// object passed in its place is rejected before Unwrap().
constexpr napi_type_tag kInterrupterTag = {0x6d6174686f707431ULL, 0x696e746572727570ULL};

// Registered and runnable: Gurobi and Xpress register in every build but load
// their library at run time (without it, Gurobi throws std::bad_function_call).
bool IsAvailable(math_opt::SolverTypeProto type) {
  using operations_research::MPSolver;
  if (type == math_opt::SOLVER_TYPE_UNSPECIFIED || !math_opt::AllSolversRegistry::Instance()->IsRegistered(type)) {
    return false;
  }
  if (type == math_opt::SOLVER_TYPE_GUROBI) return MPSolver::SupportsProblemType(MPSolver::GUROBI_LINEAR_PROGRAMMING);
  if (type == math_opt::SOLVER_TYPE_XPRESS) return MPSolver::SupportsProblemType(MPSolver::XPRESS_LINEAR_PROGRAMMING);
  return true;
}

// "GLOP", "CP_SAT"... (SolverTypeProto names without their prefix).
bool ParseRegisteredSolverType(const std::string& name, math_opt::SolverTypeProto* out) {
  return math_opt::SolverTypeProto_Parse(kSolverTypePrefix + name, out) && IsAvailable(*out);
}

class MathOptSolveInterrupter : public Napi::ObjectWrap<MathOptSolveInterrupter> {
 public:
  static void Init(Napi::Env env, Napi::Object exports) {
    exports.Set("MathOptSolveInterrupter",
                DefineClass(env, "MathOptSolveInterrupter",
                            {InstanceMethod("interrupt", &MathOptSolveInterrupter::Interrupt),
                             InstanceMethod("isInterrupted", &MathOptSolveInterrupter::IsInterrupted)}));
  }
  explicit MathOptSolveInterrupter(const Napi::CallbackInfo& info) : Napi::ObjectWrap<MathOptSolveInterrupter>(info) {
    info.This().As<Napi::Object>().TypeTag(&kInterrupterTag);
    GuardCpp(info.Env(), "new SolveInterrupter", [this] { interrupter_ = std::make_shared<SolveInterrupter>(); });
  }
  // Shared with running solves, which may outlive this wrapper's last JS reference.
  std::shared_ptr<const SolveInterrupter> interrupter() const { return interrupter_; }

 private:
  Napi::Value Interrupt(const Napi::CallbackInfo& info) {
    interrupter_->Interrupt();
    return info.Env().Undefined();
  }
  Napi::Value IsInterrupted(const Napi::CallbackInfo& info) {
    return Napi::Boolean::New(info.Env(), interrupter_->IsInterrupted());
  }

  std::shared_ptr<SolveInterrupter> interrupter_;
};

struct SolveInput {
  math_opt::ModelProto model;
  math_opt::SolverTypeProto solver_type = math_opt::SOLVER_TYPE_UNSPECIFIED;
  math_opt::SolveParametersProto parameters;
  math_opt::ModelSolveParametersProto model_parameters;
};

// (modelJson, solverType, parametersJson, modelParametersJson). Strings only:
// no user code runs while reading them.
bool ReadSolveInput(const Napi::CallbackInfo& info, SolveInput* input) {
  Napi::Env env = info.Env();
  if (!info[1].IsString()) {
    Napi::TypeError::New(env, "solverType must be a string").ThrowAsJavaScriptException();
    return false;
  }
  const std::string name = info[1].As<Napi::String>().Utf8Value();
  if (!ParseRegisteredSolverType(name, &input->solver_type)) {
    Napi::Error::New(env, "Unsupported or unregistered math_opt solver type: '" + name + "'")
        .ThrowAsJavaScriptException();
    return false;
  }
  bool parsed = false;
  if (!GuardCpp(env, "math_opt", [&] {
        parsed = ParseProtoJson(env, info[0], "ModelProto", &input->model) &&
                 ParseProtoJson(env, info[2], "SolveParametersProto", &input->parameters) &&
                 ParseProtoJson(env, info[3], "ModelSolveParametersProto", &input->model_parameters);
      })) {
    return false;
  }
  return parsed;
}

absl::StatusOr<math_opt::SolveResultProto> RunSolve(const SolveInput& input, const SolveInterrupter* interrupter) {
  math_opt::Solver::SolveArgs args;
  args.parameters = input.parameters;
  args.model_parameters = input.model_parameters;
  args.interrupter = interrupter;
  return math_opt::Solver::NonIncrementalSolve(input.model, input.solver_type, /*init_args=*/{}, args);
}

std::string StatusMessage(const absl::Status& status) { return "math_opt solve failed: " + status.ToString(); }

class MathOptSolveWorker : public PromiseWorker {
 public:
  MathOptSolveWorker(Napi::Env env, Napi::Object owner, SolveInput input,
                     std::shared_ptr<const SolveInterrupter> interrupter)
      : PromiseWorker(env, owner), input_(std::move(input)), interrupter_(std::move(interrupter)) {}

 protected:
  void Execute() override {
    RunGuarded("math_opt solve", [this] {
      result_ = RunSolve(input_, interrupter_.get());
      if (!result_.ok()) Fail(StatusMessage(result_.status()));
    });
  }
  Napi::Value Result(Napi::Env env) override { return ProtoToJson(env, *result_); }

 private:
  SolveInput input_;
  std::shared_ptr<const SolveInterrupter> interrupter_;
  absl::StatusOr<math_opt::SolveResultProto> result_;
};

// mathOptSolve(modelJson, solverType, parametersJson, modelParametersJson, interrupter?) -> Promise<string>
Napi::Value Solve(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  SolveInput input;
  if (!ReadSolveInput(info, &input)) return env.Undefined();
  std::shared_ptr<const SolveInterrupter> interrupter;
  Napi::Object owner = Napi::Object::New(env);
  if (!info[4].IsUndefined()) {
    if (!info[4].IsObject() || !info[4].As<Napi::Object>().CheckTypeTag(&kInterrupterTag)) {
      THROW_TYPE_AND_RETURN(env, "interrupter must be a SolveInterrupter", env.Undefined());
    }
    owner = info[4].As<Napi::Object>();
    interrupter = MathOptSolveInterrupter::Unwrap(owner)->interrupter();
  }
  auto* worker = new MathOptSolveWorker(env, owner, std::move(input), std::move(interrupter));
  worker->Queue();
  return worker->Promise();
}

// mathOptSolveSync(modelJson, solverType, parametersJson, modelParametersJson) -> string
Napi::Value SolveSync(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  SolveInput input;
  if (!ReadSolveInput(info, &input)) return env.Undefined();
  absl::StatusOr<math_opt::SolveResultProto> result;
  if (!GuardCpp(env, "math_opt solve", [&] { result = RunSolve(input, /*interrupter=*/nullptr); })) {
    return env.Undefined();
  }
  if (!result.ok()) THROW_AND_RETURN(env, StatusMessage(result.status()), env.Undefined());
  return ProtoToJson(env, *result);
}

}  // namespace

void InitMathOpt(Napi::Env env, Napi::Object exports) {
  MathOptSolveInterrupter::Init(env, exports);
  exports.Set("mathOptSolve", Napi::Function::New(env, Solve));
  exports.Set("mathOptSolveSync", Napi::Function::New(env, SolveSync));

  // Registered solver types, without the SOLVER_TYPE_ prefix.
  Napi::Array types = Napi::Array::New(env);
  const google::protobuf::EnumDescriptor* descriptor = math_opt::SolverTypeProto_descriptor();
  for (int i = 0; i < descriptor->value_count(); ++i) {
    const auto type = static_cast<math_opt::SolverTypeProto>(descriptor->value(i)->number());
    if (IsAvailable(type)) {
      types.Set(types.Length(), std::string(descriptor->value(i)->name()).substr(sizeof(kSolverTypePrefix) - 1));
    }
  }
  exports.Set("mathOptSolverTypes", types);

  Napi::Object enums = Napi::Object::New(env);
  enums.Set("TerminationReasonProto", EnumNames(env, math_opt::TerminationReasonProto_descriptor()));
  enums.Set("LimitProto", EnumNames(env, math_opt::LimitProto_descriptor()));
  enums.Set("FeasibilityStatusProto", EnumNames(env, math_opt::FeasibilityStatusProto_descriptor()));
  enums.Set("LPAlgorithmProto", EnumNames(env, math_opt::LPAlgorithmProto_descriptor()));
  enums.Set("EmphasisProto", EnumNames(env, math_opt::EmphasisProto_descriptor()));
  exports.Set("mathOptEnums", enums);
}

}  // namespace ortools_node
