#include "constraint_solver/cp_context.h"

#include <cmath>
#include <cstdint>
#include <string>
#include <utility>

#include "common/napi_util.h"

namespace ortools_node {

using operations_research::Constraint;
using operations_research::DecisionBuilder;
using operations_research::IntExpr;
using operations_research::IntVar;
using operations_research::SearchMonitor;
using operations_research::Solver;

CpContext::CpContext(const std::string& name)
    : owned_(std::make_unique<Solver>(name)), solver_(owned_.get()), state_(&own_state_), owner_name_("CpSolver") {}

CpContext::CpContext(Solver* borrowed, AsyncSolveState* owner_state, std::string owner_name)
    : solver_(borrowed), state_(owner_state), owner_name_(std::move(owner_name)) {}

CpContext::~CpContext() { Detach(); }

void CpContext::Detach() {
  ClearRegistries();
  interrupt_limit_ = nullptr;
  solver_ = nullptr;
  owned_.reset();
  on_mutation_ = nullptr;
}

void CpContext::ClearRegistries() {
  exprs_.clear();
  expr_ids_.clear();
  constraints_.clear();
  decision_builders_.clear();
  monitors_.clear();
}

bool CpContext::CheckUsable(Napi::Env env) const {
  if (solver_ == nullptr) {
    THROW_AND_RETURN(env, owner_name_ + " has been disposed", false);
  }
  return CheckNotBusy(env, *state_, owner_name_.c_str());
}

bool CpContext::CheckMutable(Napi::Env env) const {
  if (!CheckUsable(env)) return false;
  if (search_open_) {
    THROW_AND_RETURN(env, "Cannot build or change the model while a search is open (call endSearch() first)",
                     false);
  }
  return true;
}

void CpContext::ThrowFailure(Napi::Env env, const char* what) {
  Napi::Error::New(env, std::string("CP solver failure: ") + what + " leaves a variable with an empty domain")
      .ThrowAsJavaScriptException();
}

// ---- reading ids (phase 1) ---------------------------------------------------

bool ReadId(Napi::Env env, const Napi::Value& v, const char* what, uint32_t* out) {
  if (!v.IsNumber()) THROW_TYPE_AND_RETURN(env, std::string(what) + " id must be a number", false);
  const double d = v.As<Napi::Number>().DoubleValue();
  if (d != std::floor(d)) THROW_TYPE_AND_RETURN(env, std::string(what) + " id must be an integer", false);
  if (d < 0 || d > static_cast<double>(INT32_MAX)) {
    Napi::RangeError::New(env, std::string(what) + " id out of range").ThrowAsJavaScriptException();
    return false;
  }
  *out = static_cast<uint32_t>(d);
  return true;
}

bool ReadIdArray(Napi::Env env, const Napi::Value& v, const char* what, std::vector<uint32_t>* out) {
  if (!v.IsArray()) THROW_TYPE_AND_RETURN(env, std::string(what) + " ids must be an array", false);
  Napi::Array array = v.As<Napi::Array>();
  const uint32_t n = array.Length();
  if (env.IsExceptionPending()) return false;
  out->clear();
  for (uint32_t i = 0; i < n; ++i) {
    Napi::Value element = array.Get(i);
    if (env.IsExceptionPending()) return false;
    uint32_t id;
    if (!ReadId(env, element, what, &id)) return false;
    out->push_back(id);
  }
  return true;
}

namespace {

template <typename T>
T* ById(Napi::Env env, const std::vector<T*>& registry, uint32_t id, const char* what) {
  if (id >= registry.size()) {
    Napi::RangeError::New(env, std::string(what) + " id out of range").ThrowAsJavaScriptException();
    return nullptr;
  }
  return registry[id];
}

}  // namespace

// ---- expressions (phase 3) ---------------------------------------------------

int CpContext::RegisterExpr(IntExpr* expr) {
  auto it = expr_ids_.find(expr);
  if (it != expr_ids_.end()) return it->second;
  const int id = static_cast<int>(exprs_.size());
  exprs_.push_back(expr);
  expr_ids_.emplace(expr, id);
  return id;
}

IntExpr* CpContext::ExprById(Napi::Env env, uint32_t id, const char* what) const {
  return ById(env, exprs_, id, what);
}

IntVar* CpContext::VarById(Napi::Env env, uint32_t id, const char* what) const {
  IntExpr* expr = ExprById(env, id, what);
  if (expr == nullptr) return nullptr;
  if (!expr->IsVar()) {
    Napi::TypeError::New(env, std::string(what) + " must be an IntVar, not an expression (use expr.var())")
        .ThrowAsJavaScriptException();
    return nullptr;
  }
  return static_cast<IntVar*>(expr);
}

IntVar* CpContext::VarOrCastById(Napi::Env env, uint32_t id, const char* what) {
  IntExpr* expr = ExprById(env, id, what);
  if (expr == nullptr) return nullptr;
  if (expr->IsVar()) return static_cast<IntVar*>(expr);
  IntVar* var = nullptr;
  if (!RunGuarded(env, "casting an expression to a variable", [&] {
        var = expr->Var();
        RegisterExpr(var);
      })) {
    return nullptr;
  }
  return var;
}

bool CpContext::ExprsById(Napi::Env env, const std::vector<uint32_t>& ids, const char* what,
                          std::vector<IntExpr*>* out) const {
  out->clear();
  for (uint32_t id : ids) {
    IntExpr* expr = ExprById(env, id, what);
    if (expr == nullptr) return false;
    out->push_back(expr);
  }
  return true;
}

bool CpContext::VarsOrCastById(Napi::Env env, const std::vector<uint32_t>& ids, const char* what,
                               std::vector<IntVar*>* out) {
  out->clear();
  for (uint32_t id : ids) {
    IntVar* var = VarOrCastById(env, id, what);
    if (var == nullptr) return false;
    out->push_back(var);
  }
  return true;
}

// ---- constraints, decision builders, monitors --------------------------------

int CpContext::RegisterConstraint(Constraint* ct) {
  constraints_.push_back(ct);
  return static_cast<int>(constraints_.size() - 1);
}

Constraint* CpContext::ConstraintById(Napi::Env env, uint32_t id) const {
  return ById(env, constraints_, id, "constraint");
}

int CpContext::RegisterDecisionBuilder(DecisionBuilder* db) {
  decision_builders_.push_back(db);
  return static_cast<int>(decision_builders_.size() - 1);
}

DecisionBuilder* CpContext::DecisionBuilderById(Napi::Env env, uint32_t id) const {
  return ById(env, decision_builders_, id, "decision builder");
}

int CpContext::RegisterMonitor(MonitorEntry entry) {
  monitors_.push_back(std::move(entry));
  return static_cast<int>(monitors_.size() - 1);
}

CpContext::MonitorEntry* CpContext::MonitorById(Napi::Env env, uint32_t id) {
  if (id >= monitors_.size()) {
    Napi::RangeError::New(env, "search monitor id out of range").ThrowAsJavaScriptException();
    return nullptr;
  }
  return &monitors_[id];
}

CpContext::MonitorEntry* CpContext::CollectorById(Napi::Env env, uint32_t id) {
  MonitorEntry* entry = MonitorById(env, id);
  if (entry == nullptr) return nullptr;
  if (entry->collector == nullptr) {
    THROW_TYPE_AND_RETURN(env, "search monitor is not a solution collector", nullptr);
  }
  return entry;
}

SearchMonitor* CpContext::InterruptLimit() {
  if (interrupt_limit_ == nullptr) {
    std::atomic<bool>* stop = &stop_;
    interrupt_limit_ = solver_->MakeCustomLimit([stop] { return stop->load(); });
  }
  return interrupt_limit_;
}

namespace {
std::atomic<BorrowedContextProvider> borrowed_context_provider{nullptr};
}  // namespace

void SetBorrowedContextProvider(BorrowedContextProvider provider) { borrowed_context_provider.store(provider); }

std::shared_ptr<CpContext> BorrowContext(Napi::Env env, const Napi::Value& owner) {
  BorrowedContextProvider provider = borrowed_context_provider.load();
  if (provider == nullptr) {
    Napi::TypeError::New(env, "new CpSolver(name?: string)").ThrowAsJavaScriptException();
    return nullptr;
  }
  return provider(env, owner);
}

}  // namespace ortools_node
