'use strict';

// CP-SAT: CpModel builds the model in JS, CpSolver solves it natively.
// CpLinearExpr and CpConstraint carry a Cp prefix because the linear solver
// already exports Constraint (and a LinearExpr type).

const native = require('../native');
const { Domain } = require('./domain');
const { CpLinearExpr, IntVar, NotBooleanVariable, BoundedLinearExpr } = require('./linear_expr');
const { CpConstraint, IntervalVar } = require('./constraint');
const { CpModel } = require('./cp_model');
const { CpSolver, SolutionSnapshot } = require('./cp_solver');

module.exports = {
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
  /** CP-SAT status names, read from the OR-Tools build in use. */
  CpSolverStatus: native.CpSolverStatus,
  VariableSelectionStrategy: native.VariableSelectionStrategy,
  DomainReductionStrategy: native.DomainReductionStrategy,
};
