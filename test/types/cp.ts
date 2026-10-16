// Compile-time checks for lib/cp.d.ts (run by `npm run typecheck`).
import { cp } from '../../lib/index';

const s = new cp.CpSolver('types');
const x: cp.IntVar = s.intVar(0, 10, 'x');
const y: cp.IntVar = s.intVar([1, 3, 5n]);
const e: cp.IntExpr = x.plus(y).times(2n).minus(1).abs();
s.add(e.le(10));
s.add(s.allDifferent([x, y]));
const db = s.phase([x, y], cp.IntVarStrategy.CHOOSE_FIRST_UNBOUND, cp.IntValueStrategy.ASSIGN_MIN_VALUE);
const best: cp.SolutionCollector = s.bestValueSolutionCollector(false).add([x, y]).addObjective(e);
const found: boolean = s.solve(db, [s.minimize(e), best, { atSolution: () => true }]);
const pending: Promise<boolean> = s.solveAsync(db, [best, s.timeLimit(100)]);
s.newSearch(db);
while (s.nextSolution()) {
  const v: number = x.value();
}
s.endSearch();
const count: number = best.solutionCount();
const objective: number = best.objectiveValue(0);
s.dispose();
{
  using scoped = new cp.CpSolver('scoped');
  scoped.boolVar('b');
}

// @ts-expect-error unknown variable strategy
s.phase([x], 'CHOOSE_PATH', 'ASSIGN_MIN_VALUE');
// @ts-expect-error strings are not integers
x.plus('1');
// @ts-expect-error value() exists on cp.IntVar, not on an expression
e.value();
// @ts-expect-error solveAsync() takes no JS monitors
s.solveAsync(db, [{ atSolution: () => true }]);
// @ts-expect-error a constraint is not an expression
s.add(x);
// @ts-expect-error collectors read IntVars only
best.value(0, e);
