// Compile-time checks for lib/sat.d.ts (run by `npm run typecheck`).
import {
  BoundedLinearExpr,
  CpConstraint,
  CpLinearExpr,
  CpModel,
  CpSolver,
  CpSolverStatus,
  CpSolverStatusName,
  Domain,
  IntVar,
  Int,
  IntervalVar,
  NotBooleanVariable,
  SolutionSnapshot,
} from '../../lib/index';

const model = new CpModel();
const x: IntVar = model.newIntVar(0, 10, 'x');
const big: IntVar = model.newIntVar(0n, 2n ** 60n);
const b: IntVar = model.newBoolVar('b');
const notB: NotBooleanVariable = b.not();
const d: IntVar = model.newIntVarFromDomain(Domain.fromIntervals([[0, 2], [5]]), 'd');
const ble: BoundedLinearExpr = x.plus(d.times(2)).minus(1).le(big);
const ct: CpConstraint = model.add(ble).onlyEnforceIf(b, notB, true).withName('c');
model.addBoolOr([b, notB]);
model.addExactlyOne(b, notB);
model.addLinearConstraint(CpLinearExpr.sum([x, d, 3]), -Infinity, 10);
const interval: IntervalVar = model.newOptionalFixedSizeIntervalVar(x, 3, b, 'i');
model.addNoOverlap([interval]);
model.addCumulative([interval], [2], 4);
model.addCircuit([[0, 1, b], [1, 0, notB]]);
model.addElement(x, [1, 2, 3n], d);
model.addAutomaton([x], 0, [1], [[0, 1, 1]]);
model.addDecisionStrategy([x, notB], 'CHOOSE_FIRST', 'SELECT_MAX_VALUE');
model.addHint(b, true);
model.minimize(CpLinearExpr.weightedSum([x, d], [1, 2n]));
const problem: string = model.validate();

const solver = new CpSolver();
solver.parameters = { maxTimeInSeconds: 0.3, numWorkers: 1 };
async function run(): Promise<number> {
  const status: CpSolverStatusName = await solver.solve(model, {
    onSolution(s: SolutionSnapshot) {
      const v: Int = s.value(x);  // a BigInt beyond 2^53
      const lit: boolean = s.booleanValue(notB);
      if (v > 5 && lit) solver.stopSearch();
    },
  });
  // @ts-expect-error value() may be a BigInt, so it is not a number
  const asNumber: number = solver.value(x);
  if (status === CpSolverStatus.OPTIMAL) return Number(solver.value(x)) + solver.objectiveValue + asNumber;
  return solver.numBranches;
}
const syncStatus: CpSolverStatusName = solver.solveSync(model);

// @ts-expect-error solveSync cannot take a solution callback
solver.solveSync(model, { onSolution: () => {} });
// @ts-expect-error constraints need a bounded expression, not a bare expression
model.add(x.plus(1));
// @ts-expect-error literals must be Boolean variables, their negation or booleans
model.addBoolOr(['b']);
// @ts-expect-error unknown search strategy
model.addDecisionStrategy([x], 'CHOOSE_RANDOMLY', 'SELECT_MIN_VALUE');
// @ts-expect-error status names are a closed set
const wrong: CpSolverStatusName = 'NOT_SOLVED';
// @ts-expect-error interval lists hold IntervalVars only
model.addNoOverlap([x]);
// @ts-expect-error a variable index is read-only
x.index = 3;

export { ct, problem, run, syncStatus, wrong };

model.addHint(notB, 1n);
model.addHint(x, 2n ** 40n);
// @ts-expect-error a negated literal's hint is a boolean, 0 or 1
model.addHint(notB, 2);
