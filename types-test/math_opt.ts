// Compile-time checks for lib/math_opt.d.ts (run by `npm run typecheck`).
import { mathOpt } from '../lib/index';

const { Model, LinearExpr, SolveInterrupter, SolverType, TerminationReason, solve, solveSync } = mathOpt;

const model = new Model('typed');
const x = model.addVariable({ lb: -1, ub: 1.5, name: 'x' });
const y = model.addIntegerVariable({ lb: 0, ub: 3 });
const b = model.addBinaryVariable({ name: 'b' });
const c: mathOpt.LinearConstraint = model.addLinearConstraint(x.plus(y).le(1.5), 'c');
model.addLinearConstraint({ lb: 0, expr: LinearExpr.sum([x, b]), name: 'd' });
model.maximize(x.plus(y.times(2)));

const interrupter = new SolveInterrupter();
const pending: Promise<mathOpt.SolveResult> = solve(model, 'GSCIP', {
  parameters: { timeLimit: 10, lpAlgorithm: 'DUAL_SIMPLEX', presolve: 'OFF', gscip: {} },
  modelParameters: { solutionHints: [new Map([[x, 1]])] },
  interrupter,
});
const result = solveSync(model, 'GLOP');
solveSync(model, 'GLOP', { parameters: { iterationLimit: 10n, nodeLimit: '5', threads: 1 } });
const optimal: boolean = result.termination.reason === TerminationReason.OPTIMAL;
const value: number = result.variableValues(x);
const values: number[] = result.variableValues([x, y]);
const all: Map<mathOpt.Variable, number> = result.variableValues();
const dual: number = result.dualValues(c);
const glop: string | undefined = SolverType.GLOP;

// @ts-expect-error unknown solver type
solveSync(model, 'NOPE');
// @ts-expect-error no interrupter for a blocking solve
solveSync(model, 'GLOP', { interrupter });
// @ts-expect-error lpAlgorithm names are checked
solveSync(model, 'GLOP', { parameters: { lpAlgorithm: 'FASTEST' } });
// @ts-expect-error iterationLimit is an integer, not a boolean
solveSync(model, 'GLOP', { parameters: { iterationLimit: true } });
// @ts-expect-error ids are read-only
x.id = 3;

export { pending, optimal, value, values, all, dual, glop };
