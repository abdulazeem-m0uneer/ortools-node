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
const { routingSearchParametersJson, satParametersJson } = require('../lib/params');

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

test('a full parameter set read back from the library is accepted unchanged', () => {
  assert.deepEqual(validateRoutingSearchParameters(defaultRoutingSearchParameters()), defaultRoutingSearchParameters());
  assert.deepEqual(validateSatParameters(defaultSatParameters()), defaultSatParameters());
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

test('an explicit false or 0 replaces a non-default true or non-zero nested default', () => {
  const ils = defaultRoutingSearchParameters().iteratedLocalSearchParameters;
  assert.equal(ils.improvePerturbedSolution, true);
  assert.equal(ils.ruinRecreateParameters.routeSelectionMinNeighbors, 10);
  const p = validateRoutingSearchParameters({
    iteratedLocalSearchParameters: { improvePerturbedSolution: false, ruinRecreateParameters: { routeSelectionMinNeighbors: 0 } },
  }).iteratedLocalSearchParameters;
  assert.equal(p.improvePerturbedSolution, false);
  assert.equal(p.ruinRecreateParameters.routeSelectionMinNeighbors, 0);
  assert.equal(p.ruinRecreateParameters.routeSelectionMaxNeighbors, ils.ruinRecreateParameters.routeSelectionMaxNeighbors);
});

test('undefined and null overrides keep the OR-Tools default', () => {
  const defaults = defaultRoutingSearchParameters();
  for (const value of [undefined, null]) {
    for (const key of ['guidedLocalSearchLambdaCoefficient', 'firstSolutionStrategy', 'solutionLimit', 'localSearchOperators',
      'lnsTimeLimit']) {
      assert.deepEqual(validateRoutingSearchParameters({ [key]: value }), defaults, `${key}: ${value}`);
    }
    assert.deepEqual(validateRoutingSearchParameters({ localSearchOperators: { useRelocate: value } }), defaults);
    assert.deepEqual(validateSatParameters({ numWorkers: value, max_time_in_seconds: value }), validateSatParameters({}));
  }
});

// Python's protobuf clears the other members when one member of a oneof is set.
const ACCEPTANCE_MEMBERS = ['greedyDescent', 'simulatedAnnealing', 'allNodesPerformed', 'moreNodesPerformed'];
const ils = defaultRoutingSearchParameters().iteratedLocalSearchParameters;
for (const strategy of ['referenceSolutionAcceptanceStrategy', 'bestSolutionAcceptanceStrategy']) {
  test(`${strategy} can switch away from its default oneof member`, {
    skip: strategy in ils ? false : 'this OR-Tools version has no acceptance-strategy oneofs',
  }, () => {
    const annealing = ils.referenceSolutionAcceptanceStrategy.simulatedAnnealing;
    const [defaultMember] = Object.keys(ils[strategy]);
    for (const member of ACCEPTANCE_MEMBERS.filter((m) => m !== defaultMember)) {
      const value = member === 'simulatedAnnealing' ? annealing : {};
      const p = validateRoutingSearchParameters({ iteratedLocalSearchParameters: { [strategy]: { [member]: value } } });
      assert.deepEqual(Object.keys(p.iteratedLocalSearchParameters[strategy]), [member]);
      assert.equal(p.iteratedLocalSearchParameters.improvePerturbedSolution, ils.improvePerturbedSolution);
    }
  });
}

test('a partial override of the current oneof member keeps its other fields', {
  skip: 'referenceSolutionAcceptanceStrategy' in ils ? false : 'this OR-Tools version has no acceptance-strategy oneofs',
}, () => {
  const annealing = ils.referenceSolutionAcceptanceStrategy.simulatedAnnealing;
  assert.notEqual(annealing.coolingScheduleStrategy, 'LINEAR');
  const p = validateRoutingSearchParameters({
    iteratedLocalSearchParameters: { referenceSolutionAcceptanceStrategy: { simulatedAnnealing: { coolingScheduleStrategy: 'LINEAR' } } },
  });
  assert.deepEqual(p.iteratedLocalSearchParameters.referenceSolutionAcceptanceStrategy,
    { simulatedAnnealing: { ...annealing, coolingScheduleStrategy: 'LINEAR' } });
});

test('the same field given in snake_case and camelCase is a TypeError', () => {
  assert.throws(() => validateRoutingSearchParameters({ logSearch: true, log_search: false }),
    { name: 'TypeError', message: /log_search|logSearch/ });
  assert.throws(() => validateRoutingSearchParameters({ localSearchOperators: { useRelocate: 'BOOL_FALSE', use_relocate: 'BOOL_TRUE' } }),
    { name: 'TypeError', message: /localSearchOperators/ });
  assert.throws(() => validateSatParameters({ numWorkers: 1, num_workers: 2 }), { name: 'TypeError', message: /num_?[wW]orkers/ });
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

test('enum numbers without a named value are TypeErrors', () => {
  for (const bad of [999, -5]) {
    assert.throws(() => validateRoutingSearchParameters({ useCpSat: bad }), { name: 'TypeError', message: /useCpSat/ });
    assert.throws(() => validateRoutingSearchParameters({ iteratedLocalSearchParameters: { perturbationStrategy: bad } }),
      { name: 'TypeError', message: /iteratedLocalSearchParameters\.perturbationStrategy/ });
    assert.throws(() => validateSatParameters({ searchBranching: bad }), { name: 'TypeError', message: /searchBranching/ });
  }
  // Nested enums (FirstSolutionStrategy.Value) are named by their containing message.
  assert.throws(() => validateRoutingSearchParameters({ firstSolutionStrategy: 999 }),
    { name: 'TypeError', message: /'firstSolutionStrategy': no FirstSolutionStrategy\.Value value has number 999/ });
  assert.equal(validateRoutingSearchParameters({ firstSolutionStrategy: 3 }).firstSolutionStrategy,
    validateRoutingSearchParameters({ firstSolutionStrategy: 'PATH_CHEAPEST_ARC' }).firstSolutionStrategy);
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
  assert.throws(() => validateRoutingSearchParameters({ guidedLocalSearchLambdaCoefficient: 'NaN' }),
    { name: 'TypeError', message: /guidedLocalSearchLambdaCoefficient.*NaN/ });
  assert.throws(() => validateRoutingSearchParameters({
    iteratedLocalSearchParameters: { ruinRecreateParameters: { routeSelectionNeighborsRatio: 'NaN' } },
  }), { name: 'TypeError', message: /iteratedLocalSearchParameters\.ruinRecreateParameters\.routeSelectionNeighborsRatio.*NaN/ });
  assert.throws(() => validateSatParameters({ maxTimeInSeconds: 'NaN' }), { name: 'TypeError', message: /maxTimeInSeconds.*NaN/ });
});

test('string fields holding "Infinity" stay strings; double fields read back as numbers', () => {
  assert.equal(validateRoutingSearchParameters({ logTag: 'Infinity' }).logTag, 'Infinity');
  assert.equal(validateSatParameters({ name: '-Infinity' }).name, '-Infinity');
  assert.equal(validateSatParameters({ maxTimeInSeconds: 'Infinity' }).maxTimeInSeconds, Infinity);
  assert.equal(validateRoutingSearchParameters({ guidedLocalSearchLambdaCoefficient: '0.5' }).guidedLocalSearchLambdaCoefficient, 0.5);
});

test('routingSearchParametersJson returns the full validated set as JSON that OR-Tools parses back', () => {
  const parsed = JSON.parse(routingSearchParametersJson({ solutionLimit: 3, logTag: 'Infinity', firstSolutionStrategy: null }));
  assert.equal(parsed.solutionLimit, '3');
  assert.equal(parsed.logTag, 'Infinity');
  assert.equal(parsed.firstSolutionStrategy, 'AUTOMATIC');
  assert.deepEqual(parsed.localSearchOperators, defaultRoutingSearchParameters().localSearchOperators);
  assert.deepEqual(JSON.parse(satParametersJson({ numWorkers: 2, maxTimeInSeconds: Infinity, randomSeed: null })),
    { ...JSON.parse(satParametersJson({})), numWorkers: 2, maxTimeInSeconds: 'Infinity' });
});

// ---- input checks ---------------------------------------------------------------

test('null, undefined and holes inside repeated fields are TypeErrors naming the element', () => {
  for (const restartAlgorithms of [[null, 'LUBY_RESTART'], [undefined, 'LUBY_RESTART'], new Array(2)]) {
    assert.throws(() => validateSatParameters({ restartAlgorithms }), { name: 'TypeError', message: /'restartAlgorithms\[0\]' must not be null/ });
  }
  assert.throws(() => validateSatParameters({ ignoreSubsolvers: ['default_lp', undefined] }),
    { name: 'TypeError', message: /'ignoreSubsolvers\[1\]'/ });
  assert.throws(() => validateSatParameters({ subsolverParams: [{ name: 'a', restartAlgorithms: [null] }] }),
    { name: 'TypeError', message: /'subsolverParams\[0\]\.restartAlgorithms\[0\]'/ });
  assert.throws(() => validateRoutingSearchParameters({ iteratedLocalSearchParameters: { ruinRecreateParameters: { ruinStrategies: [null] } } }),
    { name: 'TypeError', message: /'iteratedLocalSearchParameters\.ruinRecreateParameters\.ruinStrategies\[0\]'/ });
  assert.deepEqual(validateSatParameters({ restartAlgorithms: [] }).restartAlgorithms, []);
});

test('±Infinity numbers are accepted only for float and double fields', () => {
  assert.throws(() => validateRoutingSearchParameters({ logTag: Infinity }), { name: 'TypeError', message: /'logTag'.*Infinity/ });
  assert.throws(() => validateSatParameters({ name: -Infinity }), { name: 'TypeError', message: /'name'.*Infinity/ });
  assert.throws(() => validateSatParameters({ numWorkers: Infinity }),
    { name: 'TypeError', message: /'numWorkers' cannot be Infinity/ });
  assert.throws(() => validateSatParameters({ searchBranching: -Infinity }),
    { name: 'TypeError', message: /'searchBranching' cannot be Infinity/ });
  assert.throws(() => validateRoutingSearchParameters({ localSearchOperators: { useRelocate: Infinity } }),
    { name: 'TypeError', message: /'localSearchOperators\.useRelocate' cannot be Infinity/ });
  assert.throws(() => validateSatParameters({ subsolverParams: [{ name: Infinity }] }),
    { name: 'TypeError', message: /'subsolverParams\[0\]\.name'/ });
  assert.equal(validateSatParameters({ subsolverParams: [{ name: 'a', maxTimeInSeconds: Infinity }] })
    .subsolverParams[0].maxTimeInSeconds, Infinity);
  assert.equal(validateSatParameters({ maxTimeInSeconds: Infinity }).maxTimeInSeconds, Infinity);
  assert.throws(() => validateSatParameters({ name: '\u0000+Infinity' }), { name: 'TypeError', message: /'name' is reserved/ });
});

test('strings and keys that contain an Infinity marker are rejected, never rewritten', () => {
  assert.throws(() => validateSatParameters({ logPrefix: '"\u0000+Infinity' }),
    { name: 'TypeError', message: /'logPrefix' contains a reserved Infinity marker/ });
  assert.throws(() => validateSatParameters({ logPrefix: 'a\\"\u0000-Infinity"b' }),
    { name: 'TypeError', message: /'logPrefix' contains a reserved Infinity marker/ });
  assert.throws(() => validateSatParameters({ subsolvers: ['default_lp', 'x\u0000-Infinity'] }),
    { name: 'TypeError', message: /'subsolvers\[1\]' contains a reserved Infinity marker/ });
  assert.throws(() => validateSatParameters({ '\u0000+Infinity': 1 }),
    { name: 'TypeError', message: /contains a reserved Infinity marker/ });
  assert.equal(validateSatParameters({ logPrefix: '"Infinity"' }).logPrefix, '"Infinity"');
});

test('numbers reach protobuf unchanged', () => {
  for (const value of [0.1, 1 / 3, 5e-324, Number.MAX_VALUE, 123456789.123456789, 1e21]) {
    assert.equal(validateSatParameters({ maxTimeInSeconds: value }).maxTimeInSeconds, value);
  }
  for (const value of [1, 1e15, Number.MAX_SAFE_INTEGER]) {
    assert.equal(validateRoutingSearchParameters({ solutionLimit: value }).solutionLimit, String(value));
  }
});

test('NaN errors give the full path of the field', () => {
  assert.throws(() => validateSatParameters({ subsolverParams: [{ name: 'a', maxTimeInSeconds: NaN }] }),
    { name: 'TypeError', message: /'subsolverParams\[0\]\.maxTimeInSeconds' must not be NaN/ });
  assert.throws(() => validateRoutingSearchParameters({ savingsParameters: { neighborsRatio: NaN } }),
    { name: 'TypeError', message: /'savingsParameters\.neighborsRatio' must not be NaN/ });
});

test('boxed primitives are unwrapped before the NaN and Infinity checks', () => {
  assert.equal(validateSatParameters({ maxTimeInSeconds: new Number(Infinity) }).maxTimeInSeconds, Infinity);
  assert.throws(() => validateSatParameters({ maxTimeInSeconds: new Number(NaN) }),
    { name: 'TypeError', message: /'maxTimeInSeconds' must not be NaN/ });
  assert.equal(validateRoutingSearchParameters({ firstSolutionStrategy: new String('SAVINGS') }).firstSolutionStrategy, 'SAVINGS');
  assert.equal(validateSatParameters({ logSearchProgress: new Boolean(true) }).logSearchProgress, true);
});

test('values that are not JSON data are TypeErrors naming the path', () => {
  const cases = [
    [{ localSearchOperators: new Map([['useRelocate', 'BOOL_FALSE']]) }, /'localSearchOperators'/],
    [{ localSearchOperators: { useRelocate: Symbol('BOOL_FALSE') } }, /'localSearchOperators\.useRelocate'/],
    [{ logTag: () => 'x' }, /'logTag'/],
    [{ savingsParameters: new (class Savings {})() }, /'savingsParameters'/],
    [{ iteratedLocalSearchParameters: { ruinRecreateParameters: { ruinStrategies: [new Set()] } } },
      /'iteratedLocalSearchParameters\.ruinRecreateParameters\.ruinStrategies\[0\]'/],
  ];
  for (const [params, message] of cases) {
    assert.throws(() => validateRoutingSearchParameters(params), { name: 'TypeError', message });
  }
});

test('values with a toJSON method are TypeErrors, at the root or nested', () => {
  const root = { toJSON: () => ({}), solutionLimit: 0, logTag: () => 'x' };
  assert.throws(() => validateRoutingSearchParameters(root), { name: 'TypeError', message: /toJSON/ });
  assert.throws(() => validateSatParameters({ numWorkers: 1, toJSON: () => ({ maxTimeInSeconds: NaN }) }),
    { name: 'TypeError', message: /toJSON/ });
  assert.throws(() => validateRoutingSearchParameters({ timeLimit: { toJSON: () => '2s' } }),
    { name: 'TypeError', message: /'timeLimit'.*toJSON/ });
  assert.throws(() => validateRoutingSearchParameters({ timeLimit: new Date() }), { name: 'TypeError', message: /'timeLimit'/ });
  assert.throws(() => validateSatParameters({ subsolverParams: [{ name: 'a', maxTimeInSeconds: { toJSON: () => 1 } }] }),
    { name: 'TypeError', message: /'subsolverParams\[0\]\.maxTimeInSeconds'.*toJSON/ });
});

test('the same field twice inside a repeated message is a TypeError', () => {
  assert.throws(() => validateSatParameters({ subsolverParams: [{ name: 'a', numWorkers: 1, num_workers: 2 }] }),
    { name: 'TypeError', message: /subsolverParams\[0\]/ });
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

test('SAT parameters list every repeated field, empty when not given', () => {
  const p = validateSatParameters({});
  assert.ok(Object.keys(p).length > 0);
  for (const [key, value] of Object.entries(p)) assert.deepEqual(value, [], key);
  assert.deepEqual(validateSatParameters({ subsolvers: ['default_lp'] }).subsolvers, ['default_lp']);
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
  assert.throws(() => durationMs(MAX_DURATION_MS + 1), RangeError);
});

const MAX_DURATION_MS = 315_576_000_000_000; // protobuf Duration's maximum, 315,576,000,000 s

test('durationMs covers the whole protobuf Duration range', () => {
  assert.equal(durationMs(365 * 24 * 3600 * 1000), '31536000s');
  assert.equal(durationMs(1e13), '10000000000s');
  assert.equal(durationMs(1e13 + 0.5), '10000000000.0005s');
  assert.equal(durationMs(MAX_DURATION_MS), '315576000000s');
  assert.equal(durationMs(MAX_DURATION_MS - 0.5), '315575999999.9995s');
  assert.equal(durationMs(999.9999999), '1s'); // nanosecond rounding carries into the seconds
  assert.equal(validateRoutingSearchParameters({ timeLimit: durationMs(MAX_DURATION_MS) }).timeLimit, '315576000000s');
});

test('a "__proto__" key is rejected as an unknown field, not swallowed', () => {
  const hostile = JSON.parse('{"__proto__": {"firstSolutionStrategy": "SAVINGS"}}');
  assert.throws(() => validateRoutingSearchParameters(hostile), { name: 'TypeError', message: /__proto__/ });
  assert.throws(() => validateSatParameters(JSON.parse('{"__proto__": {"numWorkers": 1}}')),
    { name: 'TypeError', message: /__proto__/ });
  assert.equal({}.firstSolutionStrategy, undefined); // nothing leaked into Object.prototype
});
