'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  FirstSolutionStrategy,
  LocalSearchMetaheuristic,
  RoutingSearchStatus,
  defaultRoutingSearchParameters,
  validateRoutingSearchParameters,
  defaultSatParameters,
  validateSatParameters,
  durationMs,
} = require('..');

// ---- enums ------------------------------------------------------------------

test('routing enums map each name to itself and are frozen', () => {
  assert.equal(FirstSolutionStrategy.PATH_CHEAPEST_ARC, 'PATH_CHEAPEST_ARC');
  assert.equal(FirstSolutionStrategy.PARALLEL_CHEAPEST_INSERTION, 'PARALLEL_CHEAPEST_INSERTION');
  assert.equal(LocalSearchMetaheuristic.GUIDED_LOCAL_SEARCH, 'GUIDED_LOCAL_SEARCH');
  assert.equal(RoutingSearchStatus.ROUTING_INFEASIBLE, 'ROUTING_INFEASIBLE');
  for (const e of [FirstSolutionStrategy, LocalSearchMetaheuristic, RoutingSearchStatus]) {
    assert.ok(Object.isFrozen(e));
    for (const [k, v] of Object.entries(e)) assert.equal(k, v);
  }
});

// ---- RoutingSearchParameters --------------------------------------------------

test('default routing parameters match OR-Tools defaults', () => {
  const p = defaultRoutingSearchParameters();
  assert.equal(p.firstSolutionStrategy, 'AUTOMATIC');
  assert.equal(p.localSearchMetaheuristic, 'AUTOMATIC');
  assert.equal(p.solutionLimit, '9223372036854775807'); // int64 max, as a string
  assert.equal(p.timeLimit, undefined); // no time limit
});

test('each default routing parameters call returns an independent copy', () => {
  const a = defaultRoutingSearchParameters();
  a.firstSolutionStrategy = 'SAVINGS';
  a.localSearchOperators.useRelocate = 'BOOL_FALSE';
  const b = defaultRoutingSearchParameters();
  assert.equal(b.firstSolutionStrategy, 'AUTOMATIC');
  assert.notEqual(b.localSearchOperators.useRelocate, 'BOOL_FALSE');
});

test('partial routing parameters merge onto the defaults', () => {
  const p = validateRoutingSearchParameters({
    firstSolutionStrategy: FirstSolutionStrategy.PATH_CHEAPEST_ARC,
    localSearchMetaheuristic: LocalSearchMetaheuristic.GUIDED_LOCAL_SEARCH,
    timeLimit: durationMs(500),
    solutionLimit: 30,
  });
  assert.equal(p.firstSolutionStrategy, 'PATH_CHEAPEST_ARC');
  assert.equal(p.localSearchMetaheuristic, 'GUIDED_LOCAL_SEARCH');
  assert.equal(p.timeLimit, '0.500s');
  assert.equal(p.solutionLimit, '30');
  // Untouched fields keep their defaults.
  assert.deepEqual(p.localSearchOperators, defaultRoutingSearchParameters().localSearchOperators);
});

test('no argument and {} both mean the defaults', () => {
  assert.deepEqual(validateRoutingSearchParameters(), defaultRoutingSearchParameters());
  assert.deepEqual(validateRoutingSearchParameters({}), defaultRoutingSearchParameters());
});

test('snake_case field names (as in Python) are accepted and override the default', () => {
  const p = validateRoutingSearchParameters({ first_solution_strategy: 'SAVINGS', log_search: true });
  assert.equal(p.firstSolutionStrategy, 'SAVINGS');
  assert.equal(p.logSearch, true);
  assert.equal('first_solution_strategy' in p, false);
});

// A protobuf MergeFrom would silently drop these: proto3 zero means "not set".
test('an explicit 0 overrides a non-zero default', () => {
  const defaults = defaultRoutingSearchParameters();
  assert.equal(defaults.guidedLocalSearchLambdaCoefficient, 0.1);
  assert.equal(defaults.heuristicCloseNodesLnsNumNodes, 5);
  const p = validateRoutingSearchParameters({ guidedLocalSearchLambdaCoefficient: 0, heuristicCloseNodesLnsNumNodes: 0 });
  assert.equal(p.guidedLocalSearchLambdaCoefficient, 0);
  assert.equal(p.heuristicCloseNodesLnsNumNodes, 0);
});

test('an explicit false overrides an earlier true in the same object chain', () => {
  assert.equal(validateRoutingSearchParameters({ logSearch: true }).logSearch, true);
  assert.equal(validateRoutingSearchParameters({ ...validateRoutingSearchParameters({ logSearch: true }), logSearch: false })
    .logSearch, false);
});

test('nested routing parameters merge field by field', () => {
  const p = validateRoutingSearchParameters({ localSearchOperators: { useRelocate: 'BOOL_FALSE' } });
  const d = defaultRoutingSearchParameters().localSearchOperators;
  assert.equal(p.localSearchOperators.useRelocate, 'BOOL_FALSE');
  assert.equal(p.localSearchOperators.useExchange, d.useExchange);
});

test('int64 routing fields accept numbers, bigints and strings', () => {
  assert.equal(validateRoutingSearchParameters({ solutionLimit: 7 }).solutionLimit, '7');
  assert.equal(validateRoutingSearchParameters({ solutionLimit: 7n }).solutionLimit, '7');
  assert.equal(validateRoutingSearchParameters({ solutionLimit: '7' }).solutionLimit, '7');
  assert.equal(validateRoutingSearchParameters({ solutionLimit: 9223372036854775807n }).solutionLimit,
    '9223372036854775807');
});

test('unknown routing fields and enum names are TypeErrors', () => {
  assert.throws(() => validateRoutingSearchParameters({ firstSolutionStratgy: 'SAVINGS' }),
    { name: 'TypeError', message: /firstSolutionStratgy/ });
  assert.throws(() => validateRoutingSearchParameters({ firstSolutionStrategy: 'NOPE' }),
    { name: 'TypeError', message: /NOPE/ });
  assert.throws(() => validateRoutingSearchParameters({ timeLimit: 'soon' }), TypeError);
  assert.throws(() => validateRoutingSearchParameters({ solutionLimit: 1.5 }), TypeError);
});

test('values OR-Tools rejects are RangeErrors', () => {
  assert.throws(() => validateRoutingSearchParameters({ solutionLimit: 0 }),
    { name: 'RangeError', message: /solution_limit/ });
  assert.throws(() => validateRoutingSearchParameters({ timeLimit: '-1s' }),
    { name: 'RangeError', message: /time_limit/ });
});

test('routing parameters must be a plain object', () => {
  for (const bad of [null, 5, 'x', [], new Map(), new Date()]) {
    assert.throws(() => validateRoutingSearchParameters(bad), { name: 'TypeError', message: /plain object/ });
  }
});

test('NaN parameter values are rejected before reaching OR-Tools', () => {
  assert.throws(() => validateRoutingSearchParameters({ guidedLocalSearchLambdaCoefficient: NaN }),
    { name: 'TypeError', message: /guidedLocalSearchLambdaCoefficient.*NaN/ });
});

// ---- SatParameters --------------------------------------------------------------

test('default SAT parameters list every field with its default', () => {
  const p = defaultSatParameters();
  assert.equal(p.maxTimeInSeconds, Infinity);
  assert.equal(p.numWorkers, 0);
  assert.ok(Object.keys(p).length > 100);
});

test('SAT parameters keep only the fields that were set', () => {
  const p = validateSatParameters({ maxTimeInSeconds: 0.3, num_workers: 1 });
  assert.equal(p.maxTimeInSeconds, 0.3);
  assert.equal(p.numWorkers, 1);
  assert.equal('randomSeed' in p, false);
});

test('infinite SAT values round-trip as numbers', () => {
  assert.equal(validateSatParameters({ maxTimeInSeconds: Infinity }).maxTimeInSeconds, Infinity);
});

test('SAT values CP-SAT rejects are RangeErrors; unknown fields are TypeErrors', () => {
  assert.throws(() => validateSatParameters({ numWorkers: -1 }), { name: 'RangeError', message: /num_workers/ });
  assert.throws(() => validateSatParameters({ maxTimeInSeconds: -1 }),
    { name: 'RangeError', message: /max_time_in_seconds/ });
  assert.throws(() => validateSatParameters({ numWorker: 1 }), { name: 'TypeError', message: /numWorker/ });
  assert.throws(() => validateSatParameters({ maxTimeInSeconds: NaN }), { name: 'TypeError', message: /NaN/ });
  assert.throws(() => validateSatParameters(null), { name: 'TypeError', message: /plain object/ });
});

// ---- durationMs -------------------------------------------------------------------

test('durationMs formats milliseconds as a protobuf Duration', () => {
  assert.equal(durationMs(0), '0s');
  assert.equal(durationMs(500), '0.5s');
  assert.equal(durationMs(1000), '1s');
  assert.equal(durationMs(1500.25), '1.50025s');
  assert.equal(durationMs(1 / 3), '0.000333333s'); // rounded to whole nanoseconds
  assert.equal(durationMs(1e-7), '0s');
});

test('durationMs output is accepted by OR-Tools', () => {
  for (const ms of [1, 250, 1500.25, 86_400_000]) {
    assert.doesNotThrow(() => validateRoutingSearchParameters({ timeLimit: durationMs(ms) }));
  }
});

test('durationMs rejects invalid input', () => {
  assert.throws(() => durationMs('500'), TypeError);
  assert.throws(() => durationMs(NaN), TypeError);
  assert.throws(() => durationMs(-1), RangeError);
  assert.throws(() => durationMs(Infinity), RangeError);
  assert.throws(() => durationMs(1e13), RangeError);
});

test('a "__proto__" key is rejected as an unknown field, not swallowed', () => {
  const hostile = JSON.parse('{"__proto__": {"firstSolutionStrategy": "SAVINGS"}}');
  assert.throws(() => validateRoutingSearchParameters(hostile), { name: 'TypeError', message: /__proto__/ });
  assert.throws(() => validateSatParameters(JSON.parse('{"__proto__": {"numWorkers": 1}}')),
    { name: 'TypeError', message: /__proto__/ });
  assert.equal({}.firstSolutionStrategy, undefined); // nothing leaked into Object.prototype
});
