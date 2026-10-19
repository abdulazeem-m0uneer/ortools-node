// CpSolver: expressions and constraints.
//
// Every builder needs a mutable context (no search open: allocating at a leaf
// node is fatal) and runs under the fail intercept, because simplifications at
// build time may already reduce domains.

#include <cstdint>
#include <limits>
#include <string>
#include <vector>

#include "common/int64.h"
#include "common/napi_util.h"
#include "constraint_solver/cp_solver.h"
#include "constraint_solver/domain_guard.h"
#include "ortools/util/tuple_set.h"

namespace ortools_node {

using operations_research::Constraint;
using operations_research::IntExpr;
using operations_research::IntTupleSet;
using operations_research::IntVar;
using operations_research::Solver;

namespace {

enum class Comparison { kEq, kNe, kLe, kLt, kGe, kGt };

bool ReadComparison(Napi::Env env, const Napi::Value& v, Comparison* out) {
  const std::string op = v.IsString() ? v.As<Napi::String>().Utf8Value() : "";
  if (op == "eq") *out = Comparison::kEq;
  else if (op == "ne") *out = Comparison::kNe;
  else if (op == "le") *out = Comparison::kLe;
  else if (op == "lt") *out = Comparison::kLt;
  else if (op == "ge") *out = Comparison::kGe;
  else if (op == "gt") *out = Comparison::kGt;
  else THROW_TYPE_AND_RETURN(env, "comparison must be one of eq, ne, le, lt, ge, gt", false);
  return true;
}

std::string ReadOp(const Napi::Value& v) { return v.IsString() ? v.As<Napi::String>().Utf8Value() : ""; }

template <typename T>
Constraint* MakeComparison(Solver* s, Comparison op, IntExpr* left, T right) {
  switch (op) {
    case Comparison::kEq: return s->MakeEquality(left, right);
    case Comparison::kNe: return s->MakeNonEquality(left, right);
    case Comparison::kLe: return s->MakeLessOrEqual(left, right);
    case Comparison::kLt: return s->MakeLess(left, right);
    case Comparison::kGe: return s->MakeGreaterOrEqual(left, right);
    case Comparison::kGt: return s->MakeGreater(left, right);
  }
  return nullptr;
}

IntVar* MakeIsComparisonVar(Solver* s, Comparison op, IntExpr* left, IntExpr* right) {
  switch (op) {
    case Comparison::kEq: return s->MakeIsEqualVar(left, right);
    case Comparison::kNe: return s->MakeIsDifferentVar(left, right);
    case Comparison::kLe: return s->MakeIsLessOrEqualVar(left, right);
    case Comparison::kLt: return s->MakeIsLessVar(left, right);
    case Comparison::kGe: return s->MakeIsGreaterOrEqualVar(left, right);
    case Comparison::kGt: return s->MakeIsGreaterVar(left, right);
  }
  return nullptr;
}

IntVar* MakeIsComparisonCstVar(Solver* s, Comparison op, IntExpr* left, int64_t right) {
  // OR-Tools computes right - 1 / right + 1 here, which overflows at the limits.
  if ((op == Comparison::kLt && right == std::numeric_limits<int64_t>::min()) ||
      (op == Comparison::kGt && right == std::numeric_limits<int64_t>::max())) {
    return s->MakeIntConst(0);
  }
  switch (op) {
    case Comparison::kEq: return s->MakeIsEqualCstVar(left, right);
    case Comparison::kNe: return s->MakeIsDifferentCstVar(left, right);
    case Comparison::kLe: return s->MakeIsLessOrEqualCstVar(left, right);
    case Comparison::kLt: return s->MakeIsLessCstVar(left, right);
    case Comparison::kGe: return s->MakeIsGreaterOrEqualCstVar(left, right);
    case Comparison::kGt: return s->MakeIsGreaterCstVar(left, right);
  }
  return nullptr;
}

}  // namespace

// Shared tail of every builder: run `build` guarded (it must not touch JS) and
// register the result.
#define BUILD_EXPR(env, what, build)                                                         \
  do {                                                                                       \
    int built_id = -1;                                                                       \
    if (!context_->RunGuarded((env), (what), [&] { built_id = context_->RegisterExpr(build); })) { \
      return (env).Undefined();                                                              \
    }                                                                                        \
    return Napi::Number::New((env), built_id);                                               \
  } while (0)

#define BUILD_CONSTRAINT(env, what, build)                                                   \
  do {                                                                                       \
    int built_id = -1;                                                                       \
    if (!context_->RunGuarded((env), (what), [&] { built_id = context_->RegisterConstraint(build); })) { \
      return (env).Undefined();                                                              \
    }                                                                                        \
    return Napi::Number::New((env), built_id);                                               \
  } while (0)

// ---- expressions -------------------------------------------------------------

Napi::Value CpSolver::Sum(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  std::vector<uint32_t> ids;
  if (!ReadIdArray(env, info[0], "sum() term", &ids) || !CheckMutable(env)) return env.Undefined();
  std::vector<IntVar*> vars;
  if (!context_->VarsOrCastById(env, ids, "sum() term", &vars)) return env.Undefined();
  BUILD_EXPR(env, "sum()", context_->solver()->MakeSum(vars));
}

Napi::Value CpSolver::ScalProd(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  std::vector<uint32_t> ids;
  std::vector<int64_t> coefs;
  if (!ReadIdArray(env, info[0], "scalProd() variable", &ids) ||
      !ReadInt64Array(env, info[1], false, "coefficients", &coefs)) {
    return env.Undefined();
  }
  if (ids.size() != coefs.size()) {
    THROW_AND_RETURN(env, "scalProd(vars, coefficients): both arrays must have the same length", env.Undefined());
  }
  if (!CheckMutable(env)) return env.Undefined();
  std::vector<IntVar*> vars;
  if (!context_->VarsOrCastById(env, ids, "scalProd() variable", &vars)) return env.Undefined();
  BUILD_EXPR(env, "scalProd()", context_->solver()->MakeScalProd(vars, coefs));
}

Napi::Value CpSolver::Binary(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  const std::string op = ReadOp(info[0]);
  uint32_t a_id, b_id;
  if (!ReadId(env, info[1], "left expression", &a_id) || !ReadId(env, info[2], "right expression", &b_id) ||
      !CheckMutable(env)) {
    return env.Undefined();
  }
  IntExpr* a = context_->ExprById(env, a_id, "left expression");
  if (a == nullptr) return env.Undefined();
  IntExpr* b = context_->ExprById(env, b_id, "right expression");
  if (b == nullptr) return env.Undefined();
  Solver* s = context_->solver();
  if (op == "plus") BUILD_EXPR(env, "plus()", s->MakeSum(a, b));
  if (op == "minus") BUILD_EXPR(env, "minus()", s->MakeDifference(a, b));
  if (op == "times") BUILD_EXPR(env, "times()", s->MakeProd(a, b));
  if (op == "min") BUILD_EXPR(env, "min()", s->MakeMin(a, b));
  if (op == "max") BUILD_EXPR(env, "max()", s->MakeMax(a, b));
  THROW_TYPE_AND_RETURN(env, "unknown binary operation '" + op + "'", env.Undefined());
}

Napi::Value CpSolver::BinaryConst(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  const std::string op = ReadOp(info[0]);
  uint32_t a_id;
  int64_t c;
  if (!ReadId(env, info[1], "expression", &a_id) || !ReadInt64(env, info[2], false, "constant", &c)) {
    return env.Undefined();
  }
  if (op == "minus" && c == std::numeric_limits<int64_t>::min()) {
    THROW_AND_RETURN(env, "minus(): the constant must be greater than -2^63", env.Undefined());
  }
  if (!CheckMutable(env)) return env.Undefined();
  IntExpr* a = context_->ExprById(env, a_id, "expression");
  if (a == nullptr) return env.Undefined();
  Solver* s = context_->solver();
  if (op == "plus") BUILD_EXPR(env, "plus()", s->MakeSum(a, c));
  if (op == "minus") BUILD_EXPR(env, "minus()", s->MakeSum(a, -c));
  if (op == "rminus") BUILD_EXPR(env, "minus()", s->MakeDifference(c, a));
  if (op == "times") BUILD_EXPR(env, "times()", s->MakeProd(a, c));
  if (op == "min") BUILD_EXPR(env, "min()", s->MakeMin(a, c));
  if (op == "max") BUILD_EXPR(env, "max()", s->MakeMax(a, c));
  THROW_TYPE_AND_RETURN(env, "unknown binary operation '" + op + "'", env.Undefined());
}

Napi::Value CpSolver::Unary(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  const std::string op = ReadOp(info[0]);
  uint32_t a_id;
  if (!ReadId(env, info[1], "expression", &a_id) || !CheckMutable(env)) return env.Undefined();
  IntExpr* a = context_->ExprById(env, a_id, "expression");
  if (a == nullptr) return env.Undefined();
  Solver* s = context_->solver();
  if (op == "abs") BUILD_EXPR(env, "abs()", s->MakeAbs(a));
  if (op == "square") BUILD_EXPR(env, "square()", s->MakeSquare(a));
  if (op == "opposite") BUILD_EXPR(env, "opposite()", s->MakeOpposite(a));
  THROW_TYPE_AND_RETURN(env, "unknown unary operation '" + op + "'", env.Undefined());
}

Napi::Value CpSolver::MinMaxArray(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  const bool is_max = info[0].ToBoolean();
  const char* what = is_max ? "max() term" : "min() term";
  std::vector<uint32_t> ids;
  if (!ReadIdArray(env, info[1], what, &ids)) return env.Undefined();
  if (ids.empty()) {
    THROW_AND_RETURN(env, std::string(is_max ? "max" : "min") + "([]): at least one expression is required",
                     env.Undefined());
  }
  if (!CheckMutable(env)) return env.Undefined();
  std::vector<IntVar*> vars;
  if (!context_->VarsOrCastById(env, ids, what, &vars)) return env.Undefined();
  if (is_max) BUILD_EXPR(env, "max()", context_->solver()->MakeMax(vars));
  BUILD_EXPR(env, "min()", context_->solver()->MakeMin(vars));
}

Napi::Value CpSolver::ElementValues(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  std::vector<int64_t> values;
  uint32_t index_id;
  if (!ReadInt64Array(env, info[0], false, "values", &values) || !ReadId(env, info[1], "index", &index_id)) {
    return env.Undefined();
  }
  if (values.empty()) THROW_AND_RETURN(env, "element(values, index): values must not be empty", env.Undefined());
  if (!CheckMutable(env)) return env.Undefined();
  IntVar* index = context_->VarOrCastById(env, index_id, "index");
  if (index == nullptr) return env.Undefined();
  BUILD_EXPR(env, "element()", context_->solver()->MakeElement(values, index));
}

Napi::Value CpSolver::ElementVars(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  std::vector<uint32_t> ids;
  uint32_t index_id;
  if (!ReadIdArray(env, info[0], "element() variable", &ids) || !ReadId(env, info[1], "index", &index_id)) {
    return env.Undefined();
  }
  if (ids.empty()) THROW_AND_RETURN(env, "element(vars, index): vars must not be empty", env.Undefined());
  if (!CheckMutable(env)) return env.Undefined();
  std::vector<IntVar*> vars;
  if (!context_->VarsOrCastById(env, ids, "element() variable", &vars)) return env.Undefined();
  IntVar* index = context_->VarOrCastById(env, index_id, "index");
  if (index == nullptr) return env.Undefined();
  BUILD_EXPR(env, "element()", context_->solver()->MakeElement(vars, index));
}

// ---- constraints and reified variables ----------------------------------------

namespace {

// (op, a, b) where b is an expression id or, for the *Const variants, a constant.
struct ComparisonArgs {
  Comparison op;
  uint32_t left;
  uint32_t right;    // expression id
  int64_t constant;  // the *Const variants
};

bool ReadComparisonArgs(const Napi::CallbackInfo& info, bool constant, ComparisonArgs* out) {
  Napi::Env env = info.Env();
  if (!ReadComparison(env, info[0], &out->op) || !ReadId(env, info[1], "left expression", &out->left)) return false;
  return constant ? ReadInt64(env, info[2], false, "constant", &out->constant)
                  : ReadId(env, info[2], "right expression", &out->right);
}

}  // namespace

Napi::Value CpSolver::Compare(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  ComparisonArgs args;
  if (!ReadComparisonArgs(info, false, &args) || !CheckMutable(env)) return env.Undefined();
  IntExpr* a = context_->ExprById(env, args.left, "left expression");
  if (a == nullptr) return env.Undefined();
  IntExpr* b = context_->ExprById(env, args.right, "right expression");
  if (b == nullptr) return env.Undefined();
  BUILD_CONSTRAINT(env, "a comparison", MakeComparison(context_->solver(), args.op, a, b));
}

Napi::Value CpSolver::CompareConst(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  ComparisonArgs args;
  if (!ReadComparisonArgs(info, true, &args) || !CheckMutable(env)) return env.Undefined();
  IntExpr* a = context_->ExprById(env, args.left, "expression");
  if (a == nullptr) return env.Undefined();
  BUILD_CONSTRAINT(env, "a comparison", MakeComparison(context_->solver(), args.op, a, args.constant));
}

Napi::Value CpSolver::IsCompareVar(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  ComparisonArgs args;
  if (!ReadComparisonArgs(info, false, &args) || !CheckMutable(env)) return env.Undefined();
  IntExpr* a = context_->ExprById(env, args.left, "left expression");
  if (a == nullptr) return env.Undefined();
  IntExpr* b = context_->ExprById(env, args.right, "right expression");
  if (b == nullptr) return env.Undefined();
  // A bound right side takes OR-Tools' constant path: apply the overflow guard.
  if (b->Bound()) {
    BUILD_EXPR(env, "a reified comparison", MakeIsComparisonCstVar(context_->solver(), args.op, a, b->Min()));
  }
  BUILD_EXPR(env, "a reified comparison", MakeIsComparisonVar(context_->solver(), args.op, a, b));
}

Napi::Value CpSolver::IsCompareConstVar(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  ComparisonArgs args;
  if (!ReadComparisonArgs(info, true, &args) || !CheckMutable(env)) return env.Undefined();
  IntExpr* a = context_->ExprById(env, args.left, "expression");
  if (a == nullptr) return env.Undefined();
  BUILD_EXPR(env, "a reified comparison", MakeIsComparisonCstVar(context_->solver(), args.op, a, args.constant));
}

Napi::Value CpSolver::AllDifferent(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  std::vector<uint32_t> ids;
  if (!ReadIdArray(env, info[0], "allDifferent() variable", &ids) || !CheckMutable(env)) return env.Undefined();
  std::vector<IntVar*> vars;
  if (!context_->VarsOrCastById(env, ids, "allDifferent() variable", &vars)) return env.Undefined();
  BUILD_CONSTRAINT(env, "allDifferent()", context_->solver()->MakeAllDifferent(vars));
}

Napi::Value CpSolver::AllowedAssignments(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  std::vector<uint32_t> ids;
  if (!ReadIdArray(env, info[0], "allowedAssignments() variable", &ids)) return env.Undefined();
  if (ids.empty()) THROW_AND_RETURN(env, "allowedAssignments(): vars must not be empty", env.Undefined());
  if (!info[1].IsArray()) THROW_TYPE_AND_RETURN(env, "allowedAssignments(): tuples must be an array", env.Undefined());
  Napi::Array rows = info[1].As<Napi::Array>();
  const uint32_t num_rows = rows.Length();
  if (env.IsExceptionPending()) return env.Undefined();
  std::vector<std::vector<int64_t>> tuples;
  for (uint32_t i = 0; i < num_rows; ++i) {
    const std::string what = "tuples[" + std::to_string(i) + "]";
    Napi::Value row = rows.Get(i);
    std::vector<int64_t> tuple;
    if (env.IsExceptionPending() || !ReadInt64Array(env, row, false, what.c_str(), &tuple)) return env.Undefined();
    // IntTupleSet::Insert() CHECKs the arity.
    if (tuple.size() != ids.size()) THROW_AND_RETURN(env, what + " must have one value per variable", env.Undefined());
    tuples.push_back(std::move(tuple));
  }
  if (!CheckMutable(env)) return env.Undefined();
  std::vector<IntVar*> vars;
  if (!context_->VarsOrCastById(env, ids, "allowedAssignments() variable", &vars)) return env.Undefined();
  int id = -1;
  if (!context_->RunGuarded(env, "allowedAssignments()", [&] {
        IntTupleSet set(static_cast<int>(vars.size()));
        for (const auto& tuple : tuples) set.Insert(tuple);
        id = context_->RegisterConstraint(context_->solver()->MakeAllowedAssignments(vars, set));
      })) {
    return env.Undefined();
  }
  return Napi::Number::New(env, id);
}

// (kind: 'member' | 'notMember' | 'isMember', expr, values)
Napi::Value CpSolver::Member(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  const std::string kind = ReadOp(info[0]);
  uint32_t expr_id;
  std::vector<int64_t> values;
  if (!ReadId(env, info[1], "expression", &expr_id) || !ReadInt64Array(env, info[2], false, "values", &values) ||
      !CheckMutable(env)) {
    return env.Undefined();
  }
  IntExpr* expr = context_->ExprById(env, expr_id, "expression");
  if (expr == nullptr) return env.Undefined();
  // In search these keep (member, true isMember) or remove (notMember, false
  // isMember) values, which may need a bitset OR-Tools CHECKs.
  const bool keeps = kind == "member" || kind == "isMember";
  const bool removes = kind == "notMember" || kind == "isMember";
  if ((keeps && KeepingNeedsHugeBitset(expr->Min(), expr->Max(), values)) ||
      (removes && RemovalNeedsHugeBitset(expr->Min(), expr->Max(), values))) {
    Napi::RangeError::New(env, kind + "()" + HugeBitsetMessage()).ThrowAsJavaScriptException();
    return env.Undefined();
  }
  Solver* s = context_->solver();
  if (kind == "member") BUILD_CONSTRAINT(env, "memberCt()", s->MakeMemberCt(expr, values));
  if (kind == "notMember") BUILD_CONSTRAINT(env, "notMemberCt()", s->MakeNotMemberCt(expr, values));
  if (kind == "isMember") BUILD_EXPR(env, "isMemberVar()", s->MakeIsMemberVar(expr, values));
  THROW_TYPE_AND_RETURN(env, "unknown membership kind '" + kind + "'", env.Undefined());
}

Napi::Value CpSolver::Add(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  uint32_t id;
  if (!ReadId(env, info[0], "constraint", &id) || !CheckMutable(env)) return env.Undefined();
  Constraint* ct = context_->ConstraintById(env, id);
  if (ct == nullptr) return env.Undefined();
  if (!context_->RunGuarded(env, "add()", [&] { context_->solver()->AddConstraint(ct); })) return env.Undefined();
  context_->NotifyMutation();
  return env.Undefined();
}

#undef BUILD_EXPR
#undef BUILD_CONSTRAINT

}  // namespace ortools_node
