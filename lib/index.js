'use strict';

// Public entry point: re-exports every OR-Tools component.
//
// Every export is a local name listed in shorthand below, the form Node's
// cjs-module-lexer detects, so `import { Solver } from 'ortools-node'` works
// from ESM. Spreads and `key: object.member` properties would hide names.

const native = require('./native');
const { Solver, Variable, Constraint, SolveResult, supportsBackend, INF } = require('./linear_solver');
const {
  FirstSolutionStrategy,
  LocalSearchMetaheuristic,
  RoutingSearchStatus,
  defaultRoutingSearchParameters,
  validateRoutingSearchParameters,
  defaultSatParameters,
  validateSatParameters,
  durationMs,
} = require('./params');
const { SimpleMinCostFlow, SimpleMaxFlow, SimpleLinearSumAssignment } = require('./graph');
const { KnapsackSolver, KnapsackSolverType } = require('./knapsack');
const modelBuilder = require('./model_builder');
const mathOpt = require('./math_opt');
const setCover = require('./set_cover');
const {
  VectorBinPackingSolverType, solveVectorBinPacking, solveVectorBinPackingSync,
} = require('./bin_packing');
const {
  CpModel, CpSolver, CpLinearExpr, CpConstraint, IntVar, NotBooleanVariable, BoundedLinearExpr, IntervalVar, Domain,
  SolutionSnapshot, CpSolverStatus, VariableSelectionStrategy, DomainReductionStrategy,
} = require('./sat');
const cp = require('./cp');
const {
  RoutingIndexManager, RoutingModel, RoutingDimension, RoutingSolution, VisitTypePolicy, PickupAndDeliveryPolicy,
} = require('./routing');

/** Version of the OR-Tools library loaded at runtime, e.g. "9.15.6755". */
const { ortoolsVersion } = native;
/** How this addon was built: the OR-Tools version it was compiled against. */
const buildInfo = Object.freeze({ ...native.buildInfo });

module.exports = {
  Solver,
  Variable,
  Constraint,
  SolveResult,
  supportsBackend,
  INF,
  SimpleMinCostFlow,
  SimpleMaxFlow,
  SimpleLinearSumAssignment,
  FirstSolutionStrategy,
  LocalSearchMetaheuristic,
  RoutingSearchStatus,
  defaultRoutingSearchParameters,
  validateRoutingSearchParameters,
  defaultSatParameters,
  validateSatParameters,
  durationMs,
  KnapsackSolver,
  KnapsackSolverType,
  modelBuilder,
  mathOpt,
  setCover,
  VectorBinPackingSolverType,
  solveVectorBinPacking,
  solveVectorBinPackingSync,
  CpModel,
  CpSolver,
  CpLinearExpr,
  CpConstraint,
  IntVar,
  NotBooleanVariable,
  BoundedLinearExpr,
  IntervalVar,
  Domain,
  SolutionSnapshot,
  CpSolverStatus,
  VariableSelectionStrategy,
  DomainReductionStrategy,
  cp,
  RoutingIndexManager,
  RoutingModel,
  RoutingDimension,
  RoutingSolution,
  VisitTypePolicy,
  PickupAndDeliveryPolicy,
  ortoolsVersion,
  buildInfo,
  native,
};
