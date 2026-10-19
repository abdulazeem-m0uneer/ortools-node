// Compile-time checks for lib/params.d.ts (run by `npm run typecheck`).
import {
  FirstSolutionStrategy,
  LocalSearchMetaheuristic,
  Overrides,
  RoutingSearchParameters,
  SatParameters,
  defaultSatParameters,
  durationMs,
  validateRoutingSearchParameters,
  validateSatParameters,
} from '../lib/index';

const routing: RoutingSearchParameters = {
  firstSolutionStrategy: FirstSolutionStrategy.PATH_CHEAPEST_ARC,
  localSearchMetaheuristic: LocalSearchMetaheuristic.GUIDED_LOCAL_SEARCH,
  timeLimit: durationMs(500),
  solutionLimit: 30n,
};
const checked: RoutingSearchParameters = validateRoutingSearchParameters(routing);
validateRoutingSearchParameters({ first_solution_strategy: 'SAVINGS' }); // snake_case names are accepted too
// null, like undefined, keeps a default.
validateRoutingSearchParameters({ firstSolutionStrategy: null, timeLimit: null, solutionLimit: undefined });
validateSatParameters({ numWorkers: null });
const overrides: Overrides<SatParameters> = { maxTimeInSeconds: null };
const strategy: string | undefined = checked.firstSolutionStrategy;
validateSatParameters({ maxTimeInSeconds: 0.3, numWorkers: 1 });
const maxTime: number | undefined = defaultSatParameters().maxTimeInSeconds;

// @ts-expect-error unknown enum name
validateRoutingSearchParameters({ firstSolutionStrategy: 'NOPE' });
// @ts-expect-error a validated parameter set never holds null
const notNull: RoutingSearchParameters = { firstSolutionStrategy: null };
// @ts-expect-error enum constants are read-only
FirstSolutionStrategy.SAVINGS = 'SWEEP';
// @ts-expect-error durationMs takes milliseconds as a number
durationMs('500');

export { strategy, maxTime, overrides, notNull };
