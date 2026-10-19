// CpSolver: registration, lifetime, variables and statistics.

#include "constraint_solver/cp_solver.h"

#include <cstdint>
#include <string>
#include <utility>
#include <vector>

#include "common/int64.h"
#include "common/napi_util.h"
#include "constraint_solver/domain_guard.h"

namespace ortools_node {

using operations_research::IntExpr;
using operations_research::Solver;

namespace {

std::string OptionalName(const Napi::CallbackInfo& info, size_t i) {
  return info.Length() > i && info[i].IsString() ? info[i].As<Napi::String>().Utf8Value() : std::string();
}

}  // namespace

Napi::Function CpSolver::Define(Napi::Env env) {
  return DefineClass(env, "CpSolver", {
      InstanceMethod("dispose", &CpSolver::Dispose),
      InstanceMethod("isBusy", &CpSolver::IsBusy),
      InstanceMethod("isDisposed", &CpSolver::IsDisposed),
      InstanceMethod("wallTime", &CpSolver::WallTime),
      InstanceMethod("branches", &CpSolver::Branches),
      InstanceMethod("failures", &CpSolver::Failures),
      InstanceMethod("solutions", &CpSolver::Solutions),

      InstanceMethod("intVar", &CpSolver::NewIntVar),
      InstanceMethod("intVarFromValues", &CpSolver::NewIntVarFromValues),
      InstanceMethod("boolVar", &CpSolver::NewBoolVar),
      InstanceMethod("intConst", &CpSolver::NewIntConst),
      InstanceMethod("exprMin", &CpSolver::ExprMin),
      InstanceMethod("exprMax", &CpSolver::ExprMax),
      InstanceMethod("exprBound", &CpSolver::ExprBound),
      InstanceMethod("exprIsVar", &CpSolver::ExprIsVar),
      InstanceMethod("exprSetMin", &CpSolver::ExprSetMin),
      InstanceMethod("exprSetMax", &CpSolver::ExprSetMax),
      InstanceMethod("exprSetRange", &CpSolver::ExprSetRange),
      InstanceMethod("exprSetValue", &CpSolver::ExprSetValue),
      InstanceMethod("exprToVar", &CpSolver::ExprToVar),
      InstanceMethod("varValue", &CpSolver::VarValue),
      InstanceMethod("varRemoveValue", &CpSolver::VarRemoveValue),
      InstanceMethod("varRemoveValues", &CpSolver::VarRemoveValues),
      InstanceMethod("varContains", &CpSolver::VarContains),
      InstanceMethod("varSize", &CpSolver::VarSize),
      InstanceMethod("varName", &CpSolver::VarName),

      InstanceMethod("sum", &CpSolver::Sum),
      InstanceMethod("scalProd", &CpSolver::ScalProd),
      InstanceMethod("binary", &CpSolver::Binary),
      InstanceMethod("binaryConst", &CpSolver::BinaryConst),
      InstanceMethod("unary", &CpSolver::Unary),
      InstanceMethod("minMaxArray", &CpSolver::MinMaxArray),
      InstanceMethod("elementValues", &CpSolver::ElementValues),
      InstanceMethod("elementVars", &CpSolver::ElementVars),
      InstanceMethod("compare", &CpSolver::Compare),
      InstanceMethod("compareConst", &CpSolver::CompareConst),
      InstanceMethod("isCompareVar", &CpSolver::IsCompareVar),
      InstanceMethod("isCompareConstVar", &CpSolver::IsCompareConstVar),
      InstanceMethod("allDifferent", &CpSolver::AllDifferent),
      InstanceMethod("allowedAssignments", &CpSolver::AllowedAssignments),
      InstanceMethod("member", &CpSolver::Member),
      InstanceMethod("add", &CpSolver::Add),

      InstanceMethod("phase", &CpSolver::Phase),
      InstanceMethod("compose", &CpSolver::Compose),
      InstanceMethod("optimize", &CpSolver::Optimize),
      InstanceMethod("limit", &CpSolver::Limit),
      InstanceMethod("searchLog", &CpSolver::SearchLog),
      InstanceMethod("collector", &CpSolver::Collector),
      InstanceMethod("collectorAdd", &CpSolver::CollectorAdd),
      InstanceMethod("collectorAddObjective", &CpSolver::CollectorAddObjective),
      InstanceMethod("collectorCount", &CpSolver::CollectorCount),
      InstanceMethod("collectorValue", &CpSolver::CollectorValue),
      InstanceMethod("collectorStat", &CpSolver::CollectorStat),
      InstanceMethod("newSearch", &CpSolver::NewSearch),
      InstanceMethod("nextSolution", &CpSolver::NextSolution),
      InstanceMethod("endSearch", &CpSolver::EndSearch),
      InstanceMethod("solve", &CpSolver::Solve),
      InstanceMethod("solveAsync", &CpSolver::SolveAsync),
      InstanceMethod("interrupt", &CpSolver::Interrupt),
  });
}

Napi::Object InitCpSolver(Napi::Env env, Napi::Object exports) {
  exports.Set("CpSolver", CpSolver::Define(env));
  return exports;
}

CpSolver::CpSolver(const Napi::CallbackInfo& info) : Napi::ObjectWrap<CpSolver>(info) {
  Napi::Env env = info.Env();
  if (info.Length() > 0 && info[0].IsObject()) {
    context_ = BorrowContext(env, info[0]);
    if (!context_) return;  // exception pending
    owner_ = Napi::Persistent(info[0].As<Napi::Object>());
    return;
  }
  if (info.Length() > 0 && !info[0].IsString() && !info[0].IsUndefined()) {
    THROW_TYPE_AND_RETURN(env, "new CpSolver(name?: string)", );
  }
  const std::string name = info.Length() > 0 && info[0].IsString() ? info[0].As<Napi::String>().Utf8Value() : "CpSolver";
  context_ = std::make_shared<CpContext>(name);
}

// ---- lifetime and statistics -----------------------------------------------

Napi::Value CpSolver::Dispose(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (!context_->owns_solver()) {
    if (context_->solver() == nullptr) return env.Undefined();
    THROW_AND_RETURN(env, "This CpSolver belongs to a RoutingModel: dispose the model instead", env.Undefined());
  }
  if (context_->solver() == nullptr) return env.Undefined();  // already disposed
  if (!CheckMutable(env)) return env.Undefined();
  context_->Detach();
  return env.Undefined();
}

Napi::Value CpSolver::IsBusy(const Napi::CallbackInfo& info) {
  return Napi::Boolean::New(info.Env(), context_->solve_state().busy());
}

Napi::Value CpSolver::IsDisposed(const Napi::CallbackInfo& info) {
  return Napi::Boolean::New(info.Env(), context_->solver() == nullptr);
}

Napi::Value CpSolver::WallTime(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (!CheckUsable(env)) return env.Undefined();
  return Napi::Number::New(env, static_cast<double>(context_->solver()->wall_time()));
}

Napi::Value CpSolver::Branches(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (!CheckUsable(env)) return env.Undefined();
  return Napi::Number::New(env, static_cast<double>(context_->solver()->branches()));
}

Napi::Value CpSolver::Failures(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (!CheckUsable(env)) return env.Undefined();
  return Napi::Number::New(env, static_cast<double>(context_->solver()->failures()));
}

Napi::Value CpSolver::Solutions(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (!CheckUsable(env)) return env.Undefined();
  return Napi::Number::New(env, static_cast<double>(context_->solver()->solutions()));
}

// ---- variables ---------------------------------------------------------------
//
// Each method reads its JS arguments first, then checks the lifecycle, then
// touches the Solver (see cp_context.h).

Napi::Value CpSolver::NewIntVar(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  int64_t lo, hi;
  if (!ReadInt64(env, info[0], true, "min", &lo) || !ReadInt64(env, info[1], true, "max", &hi)) {
    return env.Undefined();
  }
  const std::string name = OptionalName(info, 2);
  if (lo > hi) THROW_AND_RETURN(env, "intVar(min, max): min must be <= max", env.Undefined());
  if (!CheckMutable(env)) return env.Undefined();
  int id = -1;
  if (!context_->RunGuarded(env, "intVar()", [&] {
        id = context_->RegisterExpr(context_->solver()->MakeIntVar(lo, hi, name));
      })) {
    return env.Undefined();
  }
  return Napi::Number::New(env, id);
}

Napi::Value CpSolver::NewIntVarFromValues(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  std::vector<int64_t> values;
  if (!ReadInt64Array(env, info[0], false, "values", &values)) return env.Undefined();
  const std::string name = OptionalName(info, 1);
  if (values.empty()) THROW_AND_RETURN(env, "intVar(values): values must not be empty", env.Undefined());
  if (!CheckMutable(env)) return env.Undefined();
  int id = -1;
  if (!context_->RunGuarded(env, "intVar()", [&] {
        id = context_->RegisterExpr(context_->solver()->MakeIntVar(values, name));
      })) {
    return env.Undefined();
  }
  return Napi::Number::New(env, id);
}

Napi::Value CpSolver::NewBoolVar(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  const std::string name = OptionalName(info, 0);
  if (!CheckMutable(env)) return env.Undefined();
  int id = -1;
  if (!context_->RunGuarded(env, "boolVar()", [&] {
        id = context_->RegisterExpr(context_->solver()->MakeBoolVar(name));
      })) {
    return env.Undefined();
  }
  return Napi::Number::New(env, id);
}

Napi::Value CpSolver::NewIntConst(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  int64_t value;
  if (!ReadInt64(env, info[0], false, "value", &value)) return env.Undefined();
  const std::string name = OptionalName(info, 1);
  if (!CheckMutable(env)) return env.Undefined();
  int id = -1;
  if (!context_->RunGuarded(env, "intConst()", [&] {
        id = context_->RegisterExpr(context_->solver()->MakeIntConst(value, name));
      })) {
    return env.Undefined();
  }
  return Napi::Number::New(env, id);
}

// ---- reading bounds ------------------------------------------------------------

// Reads an expression id, checks the solver is usable and resolves the id.
#define READ_EXPR_OR_RETURN(env, value, expr)                                       \
  uint32_t expr##_id;                                                             \
  if (!ReadId((env), (value), "expression", &expr##_id) || !CheckUsable(env)) {   \
    return (env).Undefined();                                                     \
  }                                                                               \
  IntExpr* expr = context_->ExprById((env), expr##_id, "expression");             \
  if (expr == nullptr) return (env).Undefined()

#define READ_VAR_OR_RETURN(env, value, var)                                         \
  uint32_t var##_id;                                                              \
  if (!ReadId((env), (value), "variable", &var##_id) || !CheckUsable(env)) {      \
    return (env).Undefined();                                                     \
  }                                                                               \
  operations_research::IntVar* var = context_->VarById((env), var##_id, "variable"); \
  if (var == nullptr) return (env).Undefined()

Napi::Value CpSolver::ExprMin(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  READ_EXPR_OR_RETURN(env, info[0], expr);
  return Int64ToJsNumberOrBigInt(env, expr->Min());
}

Napi::Value CpSolver::ExprMax(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  READ_EXPR_OR_RETURN(env, info[0], expr);
  return Int64ToJsNumberOrBigInt(env, expr->Max());
}

Napi::Value CpSolver::ExprBound(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  READ_EXPR_OR_RETURN(env, info[0], expr);
  return Napi::Boolean::New(env, expr->Bound());
}

Napi::Value CpSolver::ExprIsVar(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  READ_EXPR_OR_RETURN(env, info[0], expr);
  return Napi::Boolean::New(env, expr->IsVar());
}

// ---- changing domains (outside search only) -------------------------------------

namespace {

enum class DomainOp { kSetMin, kSetMax, kSetValue, kRemoveValue };

const char* DomainOpName(DomainOp op) {
  switch (op) {
    case DomainOp::kSetMin: return "setMin()";
    case DomainOp::kSetMax: return "setMax()";
    case DomainOp::kSetValue: return "setValue()";
    case DomainOp::kRemoveValue: return "removeValue()";
  }
  return "";
}

}  // namespace

// (exprId, value) for setMin / setMax / setValue / removeValue.
static Napi::Value ApplyDomainOp(const Napi::CallbackInfo& info, CpContext* context, DomainOp op) {
  Napi::Env env = info.Env();
  uint32_t id;
  int64_t value;
  const bool bound = op == DomainOp::kSetMin || op == DomainOp::kSetMax;
  if (!ReadId(env, info[0], "expression", &id) || !ReadInt64(env, info[1], bound, "value", &value) ||
      !context->CheckMutable(env)) {
    return env.Undefined();
  }
  IntExpr* expr = op == DomainOp::kRemoveValue ? context->VarById(env, id, "variable")
                                               : context->ExprById(env, id, "expression");
  if (expr == nullptr) return env.Undefined();
  if (op == DomainOp::kRemoveValue && RemovalNeedsHugeBitset(expr->Min(), expr->Max(), {value})) {
    Napi::RangeError::New(env, std::string("removeValue()") + HugeBitsetMessage()).ThrowAsJavaScriptException();
    return env.Undefined();
  }
  if (!context->RunGuarded(env, DomainOpName(op), [&] {
        switch (op) {
          case DomainOp::kSetMin: expr->SetMin(value); break;
          case DomainOp::kSetMax: expr->SetMax(value); break;
          case DomainOp::kSetValue: expr->SetValue(value); break;
          case DomainOp::kRemoveValue: static_cast<operations_research::IntVar*>(expr)->RemoveValue(value); break;
        }
      })) {
    return env.Undefined();
  }
  context->NotifyMutation();
  return env.Undefined();
}

Napi::Value CpSolver::ExprSetMin(const Napi::CallbackInfo& info) {
  return ApplyDomainOp(info, context_.get(), DomainOp::kSetMin);
}

Napi::Value CpSolver::ExprSetMax(const Napi::CallbackInfo& info) {
  return ApplyDomainOp(info, context_.get(), DomainOp::kSetMax);
}

Napi::Value CpSolver::ExprSetValue(const Napi::CallbackInfo& info) {
  return ApplyDomainOp(info, context_.get(), DomainOp::kSetValue);
}

Napi::Value CpSolver::VarRemoveValue(const Napi::CallbackInfo& info) {
  return ApplyDomainOp(info, context_.get(), DomainOp::kRemoveValue);
}

Napi::Value CpSolver::ExprSetRange(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  uint32_t id;
  int64_t lo, hi;
  if (!ReadId(env, info[0], "expression", &id) || !ReadInt64(env, info[1], true, "min", &lo) ||
      !ReadInt64(env, info[2], true, "max", &hi)) {
    return env.Undefined();
  }
  // An empty range would fail after narrowing the operands of a sum.
  if (lo > hi) THROW_AND_RETURN(env, "setRange(min, max): min must be <= max", env.Undefined());
  if (!CheckMutable(env)) return env.Undefined();
  IntExpr* expr = context_->ExprById(env, id, "expression");
  if (expr == nullptr) return env.Undefined();
  if (!context_->RunGuarded(env, "setRange()", [&] { expr->SetRange(lo, hi); })) return env.Undefined();
  context_->NotifyMutation();
  return env.Undefined();
}

// How many values of `var` applying `removal` removes: the peeled bounds were
// all listed, so this costs O(values), never O(domain).
static uint64_t RemovedCount(const operations_research::IntVar* var, const Removal& removal) {
  uint64_t removed = 0;
  for (int64_t v = var->Min(); v < removal.lo; ++v) removed += var->Contains(v);
  for (int64_t v = var->Max(); v > removal.hi; --v) removed += var->Contains(v);
  for (int64_t v : removal.holes) removed += var->Contains(v);
  return removed;
}

Napi::Value CpSolver::VarRemoveValues(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  uint32_t id;
  std::vector<int64_t> values;
  if (!ReadId(env, info[0], "variable", &id) || !ReadInt64Array(env, info[1], false, "values", &values) ||
      !CheckMutable(env)) {
    return env.Undefined();
  }
  operations_research::IntVar* var = context_->VarById(env, id, "variable");
  if (var == nullptr) return env.Undefined();
  const Removal removal = PlanRemoval(var->Min(), var->Max(), std::move(values));
  if (NeedsHugeBitset(removal)) {
    Napi::RangeError::New(env, std::string("removeValues()") + HugeBitsetMessage()).ThrowAsJavaScriptException();
    return env.Undefined();
  }
  // Apply the plan the guard approved: OR-Tools' RemoveValues takes values in
  // the caller's order, where a bound value may still be interior and abort.
  if (!context_->RunGuarded(env, "removeValues()", [&] {
        // Removing every value fails with the domain left as it was. Size()
        // wraps to 0 on the full int64 domain, where an empty removal counts 0
        // too, but a live variable is never empty.
        const uint64_t removed = RemovedCount(var, removal);
        if (removed != 0 && removed == var->Size()) context_->solver()->Fail();
        var->SetRange(removal.lo, removal.hi);
        var->RemoveValues(removal.holes);
      })) {
    return env.Undefined();
  }
  context_->NotifyMutation();
  return env.Undefined();
}

Napi::Value CpSolver::ExprToVar(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  uint32_t id;
  if (!ReadId(env, info[0], "expression", &id) || !CheckMutable(env)) return env.Undefined();
  operations_research::IntVar* var = context_->VarOrCastById(env, id, "expression");
  return var == nullptr ? env.Undefined() : Napi::Number::New(env, context_->RegisterExpr(var));
}

// ---- reading variables -----------------------------------------------------------

Napi::Value CpSolver::VarValue(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  READ_VAR_OR_RETURN(env, info[0], var);
  // IntVar::Value() CHECK-fails on an unbound variable.
  if (!var->Bound()) {
    THROW_AND_RETURN(env, "IntVar '" + var->name() + "' is not bound: values are only available at a solution",
                     env.Undefined());
  }
  return Int64ToJsNumberOrBigInt(env, var->Value());
}

Napi::Value CpSolver::VarContains(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  int64_t value;
  if (!ReadInt64(env, info[1], true, "value", &value)) return env.Undefined();
  READ_VAR_OR_RETURN(env, info[0], var);
  return Napi::Boolean::New(env, var->Contains(value));
}

Napi::Value CpSolver::VarSize(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  READ_VAR_OR_RETURN(env, info[0], var);
  // Same rule as Int64ToJsNumberOrBigInt: a number up to 2^53 - 1, an exact BigInt beyond.
  // A count is never an unbounded marker, so never Infinity. Size() wraps to 0
  // on the full int64 domain (2^64 values; a domain is never empty).
  const uint64_t size = var->Size();
  constexpr uint64_t kMaxSafeSize = (uint64_t{1} << 53) - 1;
  if (size == 0) {
    const uint64_t two_pow_64[] = {0, 1};  // little-endian 64-bit words
    return Napi::BigInt::New(env, 0, 2, two_pow_64);
  }
  if (size > kMaxSafeSize) return Napi::BigInt::New(env, size);
  return Napi::Number::New(env, static_cast<double>(size));
}

Napi::Value CpSolver::VarName(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  READ_VAR_OR_RETURN(env, info[0], var);
  return Napi::String::New(env, var->name());
}

#undef READ_EXPR_OR_RETURN
#undef READ_VAR_OR_RETURN

}  // namespace ortools_node
