// Compile-time checks for lib/params.d.ts (run by `npm run typecheck`).
import {
  FirstSolutionStrategy,
  LocalSearchMetaheuristic,
  RoutingSearchParameters,
  defaultSatParameters,
  durationMs,
  validateRoutingSearchParameters,
  validateSatParameters,
} from '../../lib/index';

const routing: RoutingSearchParameters = {
  firstSolutionStrategy: FirstSolutionStrategy.PATH_CHEAPEST_ARC,
  localSearchMetaheuristic: LocalSearchMetaheuristic.GUIDED_LOCAL_SEARCH,
  timeLimit: durationMs(500),
  solutionLimit: 30n,
  first_solution_strategy: 'SAVINGS', // snake_case names are accepted too
};
const checked: RoutingSearchParameters = validateRoutingSearchParameters(routing);
const strategy: string | undefined = checked.firstSolutionStrategy;
validateSatParameters({ maxTimeInSeconds: 0.3, numWorkers: 1 });
const maxTime: number | undefined = defaultSatParameters().maxTimeInSeconds;

// @ts-expect-error unknown enum name
validateRoutingSearchParameters({ firstSolutionStrategy: 'NOPE' });
// @ts-expect-error enum constants are read-only
FirstSolutionStrategy.SAVINGS = 'SWEEP';
// @ts-expect-error durationMs takes milliseconds as a number
durationMs('500');

export { strategy, maxTime };
