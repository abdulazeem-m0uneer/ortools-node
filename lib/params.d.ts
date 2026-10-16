// Parameter objects in protobuf's JSON form: lowerCamelCase names (snake_case
// is accepted on input), enums as names, durations as strings such as "0.5s",
// int64 fields read back as decimal strings.

export type FirstSolutionStrategyName =
  | 'UNSET' | 'AUTOMATIC' | 'PATH_CHEAPEST_ARC' | 'PATH_MOST_CONSTRAINED_ARC'
  | 'EVALUATOR_STRATEGY' | 'SAVINGS' | 'PARALLEL_SAVINGS' | 'SWEEP' | 'CHRISTOFIDES'
  | 'ALL_UNPERFORMED' | 'BEST_INSERTION' | 'PARALLEL_CHEAPEST_INSERTION'
  | 'SEQUENTIAL_CHEAPEST_INSERTION' | 'LOCAL_CHEAPEST_INSERTION'
  | 'LOCAL_CHEAPEST_COST_INSERTION' | 'GLOBAL_CHEAPEST_ARC' | 'LOCAL_CHEAPEST_ARC'
  | 'FIRST_UNBOUND_MIN_VALUE';

export type LocalSearchMetaheuristicName =
  | 'UNSET' | 'AUTOMATIC' | 'GREEDY_DESCENT' | 'GUIDED_LOCAL_SEARCH'
  | 'SIMULATED_ANNEALING' | 'TABU_SEARCH' | 'GENERIC_TABU_SEARCH';

export type RoutingSearchStatusName =
  | 'ROUTING_NOT_SOLVED' | 'ROUTING_SUCCESS' | 'ROUTING_PARTIAL_SUCCESS_LOCAL_OPTIMUM_NOT_REACHED'
  | 'ROUTING_FAIL' | 'ROUTING_FAIL_TIMEOUT' | 'ROUTING_INVALID' | 'ROUTING_INFEASIBLE'
  | 'ROUTING_OPTIMAL';

export const FirstSolutionStrategy: Readonly<{ [K in FirstSolutionStrategyName]: K }>;
export const LocalSearchMetaheuristic: Readonly<{ [K in LocalSearchMetaheuristicName]: K }>;
export const RoutingSearchStatus: Readonly<{ [K in RoutingSearchStatusName]: K }>;

/** A protobuf Duration string such as "0.5s"; see durationMs(). */
export type Duration = string;
/** An int64 field: numbers and bigints are accepted, values are read back as strings. */
export type Int64 = number | bigint | string;

/** routing_parameters.proto. Common fields are typed; every other field is accepted by name. */
export interface RoutingSearchParameters {
  firstSolutionStrategy?: FirstSolutionStrategyName;
  localSearchMetaheuristic?: LocalSearchMetaheuristicName;
  timeLimit?: Duration;
  lnsTimeLimit?: Duration;
  solutionLimit?: Int64;
  logSearch?: boolean;
  useFullPropagation?: boolean;
  guidedLocalSearchLambdaCoefficient?: number;
  numberOfSolutionsToCollect?: number;
  [field: string]: unknown;
}

/** sat_parameters.proto. Common fields are typed; every other field is accepted by name. */
export interface SatParameters {
  maxTimeInSeconds?: number;
  numWorkers?: number;
  randomSeed?: number;
  logSearchProgress?: boolean;
  enumerateAllSolutions?: boolean;
  relativeGapLimit?: number;
  absoluteGapLimit?: number;
  [field: string]: unknown;
}

/**
 * Parameters as given to validate*(): like T, but null, like undefined, keeps a
 * field's default. Naming one field in both camelCase and snake_case is a TypeError.
 */
export type Overrides<T> = { [K in keyof T]?: T[K] | null | undefined };

/** A fresh copy of OR-Tools' DefaultRoutingSearchParameters(). */
export function defaultRoutingSearchParameters(): RoutingSearchParameters;
/**
 * The defaults with `params` merged on top field by field, as OR-Tools validated
 * them. undefined or null keeps a default; setting one member of a oneof
 * replaces the default member.
 */
export function validateRoutingSearchParameters(params?: Overrides<RoutingSearchParameters>): RoutingSearchParameters;
/** A fresh copy of CP-SAT's default SatParameters, every field listed. */
export function defaultSatParameters(): SatParameters;
/**
 * The fields set in `params` (undefined or null leaves a field unset), as CP-SAT
 * validated them, plus every repeated field: an empty array when not given.
 */
export function validateSatParameters(params?: Overrides<SatParameters>): SatParameters;
/** Milliseconds as a Duration string, rounded to whole nanoseconds: durationMs(500) === '0.5s'. */
export function durationMs(ms: number): Duration;
