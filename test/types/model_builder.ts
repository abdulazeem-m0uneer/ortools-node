// Compile-time checks for lib/model_builder.d.ts (run by `npm run typecheck`).
import { modelBuilder } from '../../lib/index';

const { Model, Solver, LinearExpr, SolveStatus, isSolverSupported } = modelBuilder;

const model = new Model('typed');
const x = model.newNumVar(0, Infinity, 'x');
const y = model.newIntVar(0, 10, 'y');
const b = model.newBoolVar('b');
const ct: modelBuilder.LinearConstraint = model.add(x.plus(y.times(7)).le(17.5), 'c0');
const enforced: modelBuilder.EnforcedLinearConstraint = model.addEnforced(x.le(2), b, true);
model.addLinearConstraint(LinearExpr.weightedSum([x, y, 3], [1, 2, 1]), 0, 10);
model.maximize(LinearExpr.sum([x, y.times(10)])).addHint(y, 2);
const proto: modelBuilder.MPModelProto = model.exportToProto();
const lp: string = model.exportToLpString();

const solver = new Solver('SCIP').setTimeLimitInSeconds(5).enableOutput(false);
const status: Promise<modelBuilder.SolveStatusName> = solver.solve(model);
const optimal: boolean = solver.solveSync(model) === SolveStatus.OPTIMAL;
const values: number[] = solver.values([x, y.plus(1)]);
const objective: number = solver.objectiveValue;
const supported: boolean = isSolverSupported('GLOP');
{
  using scoped = new Solver('GLOP');
  scoped.solveSync(model);
}

// @ts-expect-error constraints are not expressions
ct.plus(x);
// @ts-expect-error add() takes a bounded expression
model.add(x);
// @ts-expect-error coefficients are numbers
x.times('2');
// @ts-expect-error read-only
solver.objectiveValue = 1;
// @ts-expect-error an enforced constraint is not a linear constraint
const linear: modelBuilder.LinearConstraint = enforced;
// @ts-expect-error duals and activities exist only for linear constraints
solver.dualValue(enforced);
// @ts-expect-error nor the other way round
const reversed: modelBuilder.EnforcedLinearConstraint = ct;

export { linear, reversed, enforced, proto, lp, status, optimal, values, objective, supported };
