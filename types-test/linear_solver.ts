// Compile-time checks for the linear solver in lib/index.d.ts (run by `npm run typecheck`).
import {
  Constraint, INF, LinearExpr, SolveResult, Solver, Status, Variable, buildInfo, ortoolsVersion, supportsBackend,
} from '../lib/index';

const solver = new Solver('GLOP', 'lp');
const custom = new Solver('SOME_FUTURE_BACKEND');
const x: Variable = solver.numVar(0, INF, 'x');
const y: Variable = solver.intVar(0, 10);
const b: Variable = solver.boolVar('b');
const forms: LinearExpr[] = [x, [[x, 1], [2, y]], new Map([[x, 3]]), { terms: [[x, 1], b], constant: 2 }];
const c: Constraint = solver.addConstraint(forms[0]!, 0, 4, 'c').setCoefficient(y, 2).setBounds(0, 5);
solver.addLessEq(forms[1]!, 14).setBounds(-INF, 14);
solver.addGreaterEq(forms[2]!, 0);
solver.addEquality(forms[3]!, 3);
solver.maximize([[x, 3], [y, 4]]).setTimeLimit(1000).setNumThreads(2).enableOutput(false);
const accepted: boolean = solver.setSolverSpecificParameters('');
const pending: Promise<SolveResult> = solver.solve();
const result: SolveResult = solver.solveSync();
const status: Status = result.status;
const numbers: number[] = [result.objectiveValue, result.bestBound, result.wallTimeMs, result.iterations, result.nodes];
const values: number[] = [x.value(), x.reducedCost(), c.dualValue(), x.setBounds(0, 1).index];
const flags: boolean[] = [result.optimal, result.feasible, x.isInteger, solver.interrupt(), solver.busy];
const text: string[] = [solver.toLp(), solver.toMps(true, false), solver.solverVersion(), ortoolsVersion, buildInfo.ortoolsVersion];
const counts: number[] = [solver.numVariables, solver.numConstraints, solver.variables.length, buildInfo.napiVersion];
const glop: boolean = supportsBackend('GLOP');
solver.clear().dispose();
custom[Symbol.dispose]();

// @ts-expect-error a coefficient must be a number
solver.addLessEq([[x, '1']], 3);
// @ts-expect-error results are read-only
result.status = 'OPTIMAL';
// @ts-expect-error read-only
solver.busy = false;
// @ts-expect-error buildInfo is frozen
buildInfo.napiVersion = 9;

export { pending, status, numbers, values, flags, text, counts, accepted, glop };
