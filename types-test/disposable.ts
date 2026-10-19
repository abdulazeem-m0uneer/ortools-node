// Compile-time check: explicit resource management (`using`) disposes a Solver.
import { Solver } from '../lib/index';

export function solveScoped(): number {
  using solver = new Solver('GLOP');
  const x = solver.numVar(0, 1, 'x');
  solver.maximize(x);
  return solver.solveSync().objectiveValue;
}
