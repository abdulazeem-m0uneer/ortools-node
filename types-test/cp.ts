// Compile-time checks for lib/cp.d.ts (run by `npm run typecheck`).
import { cp } from '../lib/index';

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
  const v: cp.CpValue = x.value();
}
s.endSearch();
const count: number = best.solutionCount();
const objective: cp.CpValue = best.objectiveValue(0);
const bounds: Array<number | bigint> = [e.min(), e.max(), x.size(), best.value(0, x)];
// Counters are plain numbers, so arithmetic needs no narrowing.
const counters: number[] = [s.solutions(), s.branches() + 1, s.failures(), s.wallTime() / 1000];
const rate: number = best.branches(0) / (best.wallTime(0) + 1) + best.failures(0);
// @ts-expect-error int64 results past 2^53 are bigints, so they are not plain numbers
const narrow: number = x.max();
// @ts-expect-error size() of a wide domain is a bigint
const narrowSize: number = x.size();
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

// Every JS search monitor hook.
const hooks: cp.JsSearchMonitor = {
  enterSearch() {}, exitSearch() {}, beginNextDecision() {},
  endNextDecision(d: string | null) { void d; },
  applyDecision(d: string) { void d; }, refuteDecision(d: string) { void d; },
  afterDecision(d: string, apply: boolean) { void d; void apply; },
  beginFail() {}, endFail() {}, beginInitialPropagation() {}, endInitialPropagation() {},
  acceptSolution: () => false, atSolution: () => true, noMoreSolutions() {},
};
s.solve(db, [hooks, s.minimize(e)]);
s.newSearch(db, [{ beginFail() {} }]);
// @ts-expect-error decisions arrive as strings
s.solve(db, [{ applyDecision(d: number) { void d; } }]);
// @ts-expect-error acceptSolution returns a boolean or nothing
s.solve(db, [{ acceptSolution: () => 1 }]);
// @ts-expect-error a constraint is not an expression
s.add(x);
// @ts-expect-error collectors read IntVars only
best.value(0, e);

// Integer arrays are Arrays or the typed arrays the addon reads.
const sparse = new cp.CpSolver('arrays');
sparse.intVar(new Int32Array([1, 3]));
sparse.intVar(new BigInt64Array([1n, 3n]));
// @ts-expect-error array-like objects are rejected at runtime
sparse.intVar({ length: 1, 0: 3 });
// @ts-expect-error Int8Array is not read by the addon
sparse.intVar(new Int8Array([1]));
// @ts-expect-error BigUint64Array is not read by the addon
sparse.memberCt(sparse.intVar(0, 1), new BigUint64Array([1n]));
