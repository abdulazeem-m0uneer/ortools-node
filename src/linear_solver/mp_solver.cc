// MPSolver binding: linear and mixed-integer models (pywraplp's equivalent).
//
// Design notes
// ------------
// * One ObjectWrap (`Solver`) owns a `MPSolver`.  Variables and constraints are
//   referred to by their integer index (the position in solver->variables() /
//   solver->constraints()).  This keeps the C++ surface tiny; the JS layer in
//   lib/linear_solver.js turns indices into nice objects.
// * `solve()` runs on the libuv threadpool via Napi::AsyncWorker and returns a
//   Promise.  While a solve is in flight the wrapper is marked busy and every
//   mutating call throws, so there is no data race on the MPSolver.
// * Solution accessors throw unless the last solve found a solution and the
//   model has not changed since; MPSolver itself would only log and return 0.

#include "linear_solver/mp_solver.h"

#include <napi.h>

#include <memory>
#include <string>

#include "common/napi_util.h"
#include "ortools/linear_solver/linear_solver.h"

using operations_research::MPConstraint;
using operations_research::MPSolver;
using operations_research::MPVariable;

namespace ortools_node {
namespace {

bool IsSolutionStatus(MPSolver::ResultStatus s) {
  return s == MPSolver::OPTIMAL || s == MPSolver::FEASIBLE;
}

// MPSolver::InterruptSolve() may be called from another thread only for these
// backends; OR-Tools documents it as not thread-safe for SCIP.
bool SupportsThreadSafeInterrupt(MPSolver::OptimizationProblemType t) {
  switch (t) {
    case MPSolver::GLOP_LINEAR_PROGRAMMING:
    case MPSolver::PDLP_LINEAR_PROGRAMMING:
    case MPSolver::SAT_INTEGER_PROGRAMMING:
    case MPSolver::GUROBI_LINEAR_PROGRAMMING:
    case MPSolver::GUROBI_MIXED_INTEGER_PROGRAMMING:
      return true;
    default:
      return false;
  }
}

const char* StatusToString(MPSolver::ResultStatus s) {
  switch (s) {
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

// ---------------------------------------------------------------------------
// Solver wrapper
// ---------------------------------------------------------------------------

class Solver : public Napi::ObjectWrap<Solver> {
 public:
  static Napi::Object Init(Napi::Env env, Napi::Object exports);
  explicit Solver(const Napi::CallbackInfo& info);

  // Used by the async worker.
  MPSolver* raw() { return solver_.get(); }
  void FinishSolve(MPSolver::ResultStatus status) {
    busy_ = false;
    solved_ = true;
    has_solution_ = IsSolutionStatus(status);
  }
  void AbortSolve() {
    busy_ = false;
    MarkModelChanged();
  }

 private:
  // --- model building ---
  Napi::Value AddVariable(const Napi::CallbackInfo& info);          // (lb, ub, isInteger, name) -> index
  Napi::Value AddConstraint(const Napi::CallbackInfo& info);        // (lb, ub, name) -> index
  Napi::Value SetConstraintBounds(const Napi::CallbackInfo& info);  // (ci, lb, ub)
  Napi::Value SetConstraintCoefficient(const Napi::CallbackInfo& info);  // (ci, vi, coef)
  Napi::Value SetVariableBounds(const Napi::CallbackInfo& info);    // (vi, lb, ub)
  Napi::Value SetObjectiveCoefficient(const Napi::CallbackInfo& info);   // (vi, coef)
  Napi::Value SetObjectiveOffset(const Napi::CallbackInfo& info);   // (offset)
  Napi::Value SetObjectiveSense(const Napi::CallbackInfo& info);    // (maximize: bool)
  Napi::Value ClearObjective(const Napi::CallbackInfo& info);
  Napi::Value Clear(const Napi::CallbackInfo& info);

  // --- parameters ---
  Napi::Value SetTimeLimit(const Napi::CallbackInfo& info);         // (milliseconds)
  Napi::Value SetNumThreads(const Napi::CallbackInfo& info);        // (n)
  Napi::Value EnableOutput(const Napi::CallbackInfo& info);         // (bool)
  Napi::Value SetSolverSpecificParameters(const Napi::CallbackInfo& info);  // (string)

  // --- solving ---
  Napi::Value Solve(const Napi::CallbackInfo& info);      // () -> Promise<string>
  Napi::Value SolveSync(const Napi::CallbackInfo& info);  // () -> string
  Napi::Value Interrupt(const Napi::CallbackInfo& info);  // () -> bool

  // --- results / introspection ---
  Napi::Value ObjectiveValue(const Napi::CallbackInfo& info);
  Napi::Value BestBound(const Napi::CallbackInfo& info);
  Napi::Value VariableValue(const Napi::CallbackInfo& info);     // (vi)
  Napi::Value ReducedCost(const Napi::CallbackInfo& info);       // (vi)
  Napi::Value DualValue(const Napi::CallbackInfo& info);         // (ci)
  Napi::Value NumVariables(const Napi::CallbackInfo& info);
  Napi::Value NumConstraints(const Napi::CallbackInfo& info);
  Napi::Value WallTime(const Napi::CallbackInfo& info);
  Napi::Value Iterations(const Napi::CallbackInfo& info);
  Napi::Value Nodes(const Napi::CallbackInfo& info);
  Napi::Value SolverVersion(const Napi::CallbackInfo& info);
  Napi::Value ExportModelAsLpFormat(const Napi::CallbackInfo& info);
  Napi::Value ExportModelAsMpsFormat(const Napi::CallbackInfo& info);
  Napi::Value IsBusy(const Napi::CallbackInfo& info);
  Napi::Value Dispose(const Napi::CallbackInfo& info);

  // helpers
  bool CheckUsable(Napi::Env env) const {
    if (!solver_) {
      Napi::Error::New(env, "Solver has been disposed").ThrowAsJavaScriptException();
      return false;
    }
    if (busy_) {
      Napi::Error::New(env, "Solver is busy: a solve() is in progress").ThrowAsJavaScriptException();
      return false;
    }
    return true;
  }
  // Any model change invalidates the previous solve (MPSolver does the same).
  void MarkModelChanged() {
    solved_ = false;
    has_solution_ = false;
  }
  bool CheckSolved(Napi::Env env) const {
    if (!CheckUsable(env)) return false;
    if (!solved_) {
      Napi::Error::New(env, "No solve result: call solve() first (the model changed since the last solve)")
          .ThrowAsJavaScriptException();
      return false;
    }
    return true;
  }
  bool CheckHasSolution(Napi::Env env) const {
    if (!CheckSolved(env)) return false;
    if (!has_solution_) {
      Napi::Error::New(env, "No solution available: the last solve was not OPTIMAL or FEASIBLE")
          .ThrowAsJavaScriptException();
      return false;
    }
    return true;
  }
  bool CheckContinuous(Napi::Env env, const char* what) const {
    if (solver_->IsMIP()) {
      Napi::Error::New(env, std::string(what) + " is only available for LP backends (e.g. GLOP, PDLP)")
          .ThrowAsJavaScriptException();
      return false;
    }
    return true;
  }
  MPVariable* VarAt(Napi::Env env, const Napi::Value& v) const {
    size_t i;
    if (!ReadIndex(env, v, solver_->variables().size(), "variable", &i)) return nullptr;
    return solver_->variables()[i];
  }
  MPConstraint* CtAt(Napi::Env env, const Napi::Value& v) const {
    size_t i;
    if (!ReadIndex(env, v, solver_->constraints().size(), "constraint", &i)) return nullptr;
    return solver_->constraints()[i];
  }

  std::unique_ptr<MPSolver> solver_;
  bool busy_ = false;
  bool solved_ = false;        // a solve completed and the model is unchanged since
  bool has_solution_ = false;  // ...and it ended OPTIMAL or FEASIBLE
};

// ---------------------------------------------------------------------------
// Async solve worker
// ---------------------------------------------------------------------------

class SolveWorker : public Napi::AsyncWorker {
 public:
  SolveWorker(Napi::Env env, Napi::Object self, Solver* wrapper)
      : Napi::AsyncWorker(env),
        deferred_(Napi::Promise::Deferred::New(env)),
        self_ref_(Napi::Persistent(self)),  // keep JS object (and MPSolver) alive
        wrapper_(wrapper) {}

  Napi::Promise Promise() { return deferred_.Promise(); }

 protected:
  void Execute() override {
    // Runs on the threadpool.  Do NOT touch any Napi:: value here.
    status_ = wrapper_->raw()->Solve();
  }

  void OnOK() override {
    wrapper_->FinishSolve(status_);
    deferred_.Resolve(Napi::String::New(Env(), StatusToString(status_)));
  }

  void OnError(const Napi::Error& e) override {
    wrapper_->AbortSolve();
    deferred_.Reject(e.Value());
  }

 private:
  Napi::Promise::Deferred deferred_;
  Napi::ObjectReference self_ref_;
  Solver* wrapper_;
  MPSolver::ResultStatus status_ = MPSolver::NOT_SOLVED;
};

// ---------------------------------------------------------------------------
// Solver implementation
// ---------------------------------------------------------------------------

Napi::Object Solver::Init(Napi::Env env, Napi::Object exports) {
  Napi::Function func = DefineClass(env, "Solver", {
      InstanceMethod("addVariable", &Solver::AddVariable),
      InstanceMethod("addConstraint", &Solver::AddConstraint),
      InstanceMethod("setConstraintBounds", &Solver::SetConstraintBounds),
      InstanceMethod("setConstraintCoefficient", &Solver::SetConstraintCoefficient),
      InstanceMethod("setVariableBounds", &Solver::SetVariableBounds),
      InstanceMethod("setObjectiveCoefficient", &Solver::SetObjectiveCoefficient),
      InstanceMethod("setObjectiveOffset", &Solver::SetObjectiveOffset),
      InstanceMethod("setObjectiveSense", &Solver::SetObjectiveSense),
      InstanceMethod("clearObjective", &Solver::ClearObjective),
      InstanceMethod("clear", &Solver::Clear),

      InstanceMethod("setTimeLimit", &Solver::SetTimeLimit),
      InstanceMethod("setNumThreads", &Solver::SetNumThreads),
      InstanceMethod("enableOutput", &Solver::EnableOutput),
      InstanceMethod("setSolverSpecificParameters", &Solver::SetSolverSpecificParameters),

      InstanceMethod("solve", &Solver::Solve),
      InstanceMethod("solveSync", &Solver::SolveSync),
      InstanceMethod("interrupt", &Solver::Interrupt),

      InstanceMethod("objectiveValue", &Solver::ObjectiveValue),
      InstanceMethod("bestBound", &Solver::BestBound),
      InstanceMethod("variableValue", &Solver::VariableValue),
      InstanceMethod("reducedCost", &Solver::ReducedCost),
      InstanceMethod("dualValue", &Solver::DualValue),
      InstanceMethod("numVariables", &Solver::NumVariables),
      InstanceMethod("numConstraints", &Solver::NumConstraints),
      InstanceMethod("wallTime", &Solver::WallTime),
      InstanceMethod("iterations", &Solver::Iterations),
      InstanceMethod("nodes", &Solver::Nodes),
      InstanceMethod("solverVersion", &Solver::SolverVersion),
      InstanceMethod("exportModelAsLpFormat", &Solver::ExportModelAsLpFormat),
      InstanceMethod("exportModelAsMpsFormat", &Solver::ExportModelAsMpsFormat),
      InstanceMethod("isBusy", &Solver::IsBusy),
      InstanceMethod("dispose", &Solver::Dispose),
  });

  Napi::FunctionReference* ctor = new Napi::FunctionReference();
  *ctor = Napi::Persistent(func);
  env.SetInstanceData(ctor);

  exports.Set("Solver", func);
  exports.Set("infinity", Napi::Number::New(env, MPSolver::infinity()));
  exports.Set("supportsProblemType", Napi::Function::New(env, [](const Napi::CallbackInfo& info) -> Napi::Value {
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsString()) {
      THROW_TYPE_AND_RETURN(env, "supportsProblemType(name: string)", env.Undefined());
    }
    MPSolver::OptimizationProblemType type;
    bool ok = MPSolver::ParseSolverType(info[0].As<Napi::String>().Utf8Value(), &type);
    return Napi::Boolean::New(env, ok && MPSolver::SupportsProblemType(type));
  }));
  return exports;
}

// new Solver(backend: string, name?: string)
Solver::Solver(const Napi::CallbackInfo& info) : Napi::ObjectWrap<Solver>(info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsString()) {
    THROW_TYPE_AND_RETURN(env, "new Solver(backend: string, name?: string) — backend e.g. 'GLOP', 'SCIP', 'CBC', 'CP_SAT', 'HIGHS', 'PDLP'", );
  }
  std::string backend = info[0].As<Napi::String>().Utf8Value();
  std::string name = (info.Length() > 1 && info[1].IsString()) ? info[1].As<Napi::String>().Utf8Value() : "ortools-node";

  // Same checks as MPSolver::CreateSolver(), but keeps the caller's model name.
  MPSolver::OptimizationProblemType type;
  if (!MPSolver::ParseSolverType(backend, &type) || !MPSolver::SupportsProblemType(type)) {
    THROW_AND_RETURN(env, "Unsupported or unavailable solver backend: '" + backend +
                     "' (check your OR-Tools build; try supportsProblemType())", );
  }
  solver_ = std::make_unique<MPSolver>(name, type);
}

// ---- model building --------------------------------------------------------

Napi::Value Solver::AddVariable(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (!CheckUsable(env)) return env.Undefined();
  if (info.Length() < 3 || !info[2].IsBoolean()) {
    THROW_TYPE_AND_RETURN(env, "addVariable(lb: number, ub: number, isInteger: boolean, name?: string)", env.Undefined());
  }
  double lb, ub;
  if (!ReadBound(env, info[0], "lb", &lb) || !ReadBound(env, info[1], "ub", &ub)) return env.Undefined();
  bool integer = info[2].As<Napi::Boolean>().Value();
  std::string name = (info.Length() > 3 && info[3].IsString()) ? info[3].As<Napi::String>().Utf8Value() : "";
  if (name.empty()) name = "x" + std::to_string(solver_->variables().size());
  solver_->MakeVar(lb, ub, integer, name);
  MarkModelChanged();
  return Napi::Number::New(env, static_cast<double>(solver_->variables().size() - 1));
}

Napi::Value Solver::AddConstraint(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (!CheckUsable(env)) return env.Undefined();
  if (info.Length() < 2) {
    THROW_TYPE_AND_RETURN(env, "addConstraint(lb: number, ub: number, name?: string)", env.Undefined());
  }
  double lb, ub;
  if (!ReadBound(env, info[0], "lb", &lb) || !ReadBound(env, info[1], "ub", &ub)) return env.Undefined();
  std::string name = (info.Length() > 2 && info[2].IsString()) ? info[2].As<Napi::String>().Utf8Value() : "";
  if (name.empty()) name = "c" + std::to_string(solver_->constraints().size());
  solver_->MakeRowConstraint(lb, ub, name);
  MarkModelChanged();
  return Napi::Number::New(env, static_cast<double>(solver_->constraints().size() - 1));
}

Napi::Value Solver::SetConstraintBounds(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (!CheckUsable(env)) return env.Undefined();
  if (info.Length() < 3) {
    THROW_TYPE_AND_RETURN(env, "setConstraintBounds(ci, lb, ub)", env.Undefined());
  }
  MPConstraint* c = CtAt(env, info[0]);
  if (!c) return env.Undefined();
  double lb, ub;
  if (!ReadBound(env, info[1], "lb", &lb) || !ReadBound(env, info[2], "ub", &ub)) return env.Undefined();
  c->SetBounds(lb, ub);
  MarkModelChanged();
  return env.Undefined();
}

Napi::Value Solver::SetConstraintCoefficient(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (!CheckUsable(env)) return env.Undefined();
  if (info.Length() < 3) {
    THROW_TYPE_AND_RETURN(env, "setConstraintCoefficient(ci, vi, coef)", env.Undefined());
  }
  MPConstraint* c = CtAt(env, info[0]);
  if (!c) return env.Undefined();
  MPVariable* v = VarAt(env, info[1]);
  if (!v) return env.Undefined();
  double coef;
  if (!ReadCoefficient(env, info[2], &coef)) return env.Undefined();
  c->SetCoefficient(v, coef);
  MarkModelChanged();
  return env.Undefined();
}

Napi::Value Solver::SetVariableBounds(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (!CheckUsable(env)) return env.Undefined();
  if (info.Length() < 3) {
    THROW_TYPE_AND_RETURN(env, "setVariableBounds(vi, lb, ub)", env.Undefined());
  }
  MPVariable* v = VarAt(env, info[0]);
  if (!v) return env.Undefined();
  double lb, ub;
  if (!ReadBound(env, info[1], "lb", &lb) || !ReadBound(env, info[2], "ub", &ub)) return env.Undefined();
  v->SetBounds(lb, ub);
  MarkModelChanged();
  return env.Undefined();
}

Napi::Value Solver::SetObjectiveCoefficient(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (!CheckUsable(env)) return env.Undefined();
  if (info.Length() < 2) {
    THROW_TYPE_AND_RETURN(env, "setObjectiveCoefficient(vi, coef)", env.Undefined());
  }
  MPVariable* v = VarAt(env, info[0]);
  if (!v) return env.Undefined();
  double coef;
  if (!ReadCoefficient(env, info[1], &coef)) return env.Undefined();
  solver_->MutableObjective()->SetCoefficient(v, coef);
  MarkModelChanged();
  return env.Undefined();
}

Napi::Value Solver::SetObjectiveOffset(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (!CheckUsable(env)) return env.Undefined();
  double offset;
  if (!ReadNumber(env, info[0], /*allow_infinite=*/false, "offset", &offset)) return env.Undefined();
  solver_->MutableObjective()->SetOffset(offset);
  MarkModelChanged();
  return env.Undefined();
}

Napi::Value Solver::SetObjectiveSense(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (!CheckUsable(env)) return env.Undefined();
  if (info.Length() < 1 || !info[0].IsBoolean()) {
    THROW_TYPE_AND_RETURN(env, "setObjectiveSense(maximize: boolean)", env.Undefined());
  }
  if (info[0].As<Napi::Boolean>().Value()) {
    solver_->MutableObjective()->SetMaximization();
  } else {
    solver_->MutableObjective()->SetMinimization();
  }
  MarkModelChanged();
  return env.Undefined();
}

Napi::Value Solver::ClearObjective(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (!CheckUsable(env)) return env.Undefined();
  solver_->MutableObjective()->Clear();
  MarkModelChanged();
  return env.Undefined();
}

Napi::Value Solver::Clear(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (!CheckUsable(env)) return env.Undefined();
  solver_->Clear();
  MarkModelChanged();
  return env.Undefined();
}

// ---- parameters ------------------------------------------------------------

Napi::Value Solver::SetTimeLimit(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (!CheckUsable(env)) return env.Undefined();
  double ms;
  if (!ReadNumber(env, info[0], /*allow_infinite=*/false, "milliseconds", &ms)) return env.Undefined();
  if (ms < 0) {
    Napi::RangeError::New(env, "setTimeLimit(milliseconds): must be >= 0 (0 = no limit)").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  solver_->set_time_limit(static_cast<int64_t>(ms));
  return env.Undefined();
}

Napi::Value Solver::SetNumThreads(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (!CheckUsable(env)) return env.Undefined();
  if (info.Length() < 1 || !info[0].IsNumber()) {
    THROW_TYPE_AND_RETURN(env, "setNumThreads(n: number)", env.Undefined());
  }
  absl::Status st = solver_->SetNumThreads(info[0].As<Napi::Number>().Int32Value());
  if (!st.ok()) {
    THROW_AND_RETURN(env, std::string("setNumThreads failed: ") + std::string(st.message()), env.Undefined());
  }
  return env.Undefined();
}

Napi::Value Solver::EnableOutput(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (!CheckUsable(env)) return env.Undefined();
  bool on = info.Length() < 1 || !info[0].IsBoolean() || info[0].As<Napi::Boolean>().Value();
  if (on) solver_->EnableOutput(); else solver_->SuppressOutput();
  return env.Undefined();
}

Napi::Value Solver::SetSolverSpecificParameters(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (!CheckUsable(env)) return env.Undefined();
  if (info.Length() < 1 || !info[0].IsString()) {
    THROW_TYPE_AND_RETURN(env, "setSolverSpecificParameters(params: string)", env.Undefined());
  }
  bool ok = solver_->SetSolverSpecificParametersAsString(info[0].As<Napi::String>().Utf8Value());
  return Napi::Boolean::New(env, ok);
}

// ---- solving ---------------------------------------------------------------

Napi::Value Solver::Solve(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (!CheckUsable(env)) return env.Undefined();
  busy_ = true;
  SolveWorker* w = new SolveWorker(env, info.This().As<Napi::Object>(), this);
  w->Queue();
  return w->Promise();
}

Napi::Value Solver::SolveSync(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (!CheckUsable(env)) return env.Undefined();
  MPSolver::ResultStatus status = solver_->Solve();
  FinishSolve(status);
  return Napi::String::New(env, StatusToString(status));
}

// Asks a running solve() to stop early. Returns false when no async solve is
// in flight or the backend cannot be interrupted safely from another thread.
Napi::Value Solver::Interrupt(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  bool interrupted = busy_ && solver_ && SupportsThreadSafeInterrupt(solver_->ProblemType()) && solver_->InterruptSolve();
  return Napi::Boolean::New(env, interrupted);
}

// ---- results / introspection ----------------------------------------------

Napi::Value Solver::ObjectiveValue(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (!CheckHasSolution(env)) return env.Undefined();
  return Napi::Number::New(env, solver_->Objective().Value());
}

Napi::Value Solver::BestBound(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (!CheckHasSolution(env)) return env.Undefined();
  return Napi::Number::New(env, solver_->Objective().BestBound());
}

Napi::Value Solver::VariableValue(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (!CheckHasSolution(env)) return env.Undefined();
  MPVariable* v = VarAt(env, info[0]);
  if (!v) return env.Undefined();
  return Napi::Number::New(env, v->solution_value());
}

Napi::Value Solver::ReducedCost(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (!CheckHasSolution(env) || !CheckContinuous(env, "reducedCost")) return env.Undefined();
  MPVariable* v = VarAt(env, info[0]);
  if (!v) return env.Undefined();
  return Napi::Number::New(env, v->reduced_cost());
}

Napi::Value Solver::DualValue(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (!CheckHasSolution(env) || !CheckContinuous(env, "dualValue")) return env.Undefined();
  MPConstraint* c = CtAt(env, info[0]);
  if (!c) return env.Undefined();
  return Napi::Number::New(env, c->dual_value());
}

Napi::Value Solver::NumVariables(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (!CheckUsable(env)) return env.Undefined();
  return Napi::Number::New(env, solver_->NumVariables());
}

Napi::Value Solver::NumConstraints(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (!CheckUsable(env)) return env.Undefined();
  return Napi::Number::New(env, solver_->NumConstraints());
}

Napi::Value Solver::WallTime(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (!CheckUsable(env)) return env.Undefined();
  return Napi::Number::New(env, static_cast<double>(solver_->wall_time()));
}

Napi::Value Solver::Iterations(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (!CheckSolved(env)) return env.Undefined();
  return Napi::Number::New(env, static_cast<double>(solver_->iterations()));
}

Napi::Value Solver::Nodes(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (!CheckSolved(env)) return env.Undefined();
  // LP backends log an error for nodes(); branch-and-bound nodes only exist for MIP.
  if (!solver_->IsMIP()) return Napi::Number::New(env, 0);
  return Napi::Number::New(env, static_cast<double>(solver_->nodes()));
}

Napi::Value Solver::SolverVersion(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (!CheckUsable(env)) return env.Undefined();
  return Napi::String::New(env, solver_->SolverVersion());
}

Napi::Value Solver::ExportModelAsLpFormat(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (!CheckUsable(env)) return env.Undefined();
  bool obfuscated = info.Length() > 0 && info[0].IsBoolean() && info[0].As<Napi::Boolean>().Value();
  std::string model;
  if (!solver_->ExportModelAsLpFormat(obfuscated, &model)) {
    THROW_AND_RETURN(env, "exportModelAsLpFormat failed", env.Undefined());
  }
  return Napi::String::New(env, model);
}

Napi::Value Solver::ExportModelAsMpsFormat(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (!CheckUsable(env)) return env.Undefined();
  bool fixed = info.Length() > 0 && info[0].IsBoolean() && info[0].As<Napi::Boolean>().Value();
  bool obfuscated = info.Length() > 1 && info[1].IsBoolean() && info[1].As<Napi::Boolean>().Value();
  std::string model;
  if (!solver_->ExportModelAsMpsFormat(fixed, obfuscated, &model)) {
    THROW_AND_RETURN(env, "exportModelAsMpsFormat failed", env.Undefined());
  }
  return Napi::String::New(env, model);
}

Napi::Value Solver::IsBusy(const Napi::CallbackInfo& info) {
  return Napi::Boolean::New(info.Env(), busy_);
}

// Frees the MPSolver now. Node-API runs ObjectWrap finalizers only after the
// event loop turns, so without this a synchronous loop keeps every model alive.
Napi::Value Solver::Dispose(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (!solver_) return env.Undefined();  // already disposed
  if (!CheckUsable(env)) return env.Undefined();
  solver_.reset();
  MarkModelChanged();
  return env.Undefined();
}

}  // namespace

Napi::Object InitMpSolver(Napi::Env env, Napi::Object exports) {
  return Solver::Init(env, exports);
}

}  // namespace ortools_node
