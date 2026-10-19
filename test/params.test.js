'use strict';
const { test } = require('node:test');
const { spawnSync } = require('node:child_process');
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
const native = require('../lib/native');

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
      assert.deepEqual(p.iteratedLocalSearchParameters[strategy], { [member]: value });
      const sibling = strategy === 'referenceSolutionAcceptanceStrategy'
        ? 'bestSolutionAcceptanceStrategy' : 'referenceSolutionAcceptanceStrategy';
      assert.deepEqual(p.iteratedLocalSearchParameters[sibling], ils[sibling]);
      assert.equal(p.iteratedLocalSearchParameters.improvePerturbedSolution, ils.improvePerturbedSolution);
    }
  });
}

test('null oneof members keep the default; two set members of one oneof are a TypeError', {
  skip: 'bestSolutionAcceptanceStrategy' in ils ? false : 'this OR-Tools version has no acceptance-strategy oneofs',
}, () => {
  const best = (strategy) =>
    validateRoutingSearchParameters({ iteratedLocalSearchParameters: { bestSolutionAcceptanceStrategy: strategy } })
      .iteratedLocalSearchParameters.bestSolutionAcceptanceStrategy;
  assert.deepEqual(ils.bestSolutionAcceptanceStrategy, { greedyDescent: {} });
  assert.deepEqual(best({ simulatedAnnealing: null }), { greedyDescent: {} });
  assert.deepEqual(best({ greedyDescent: null, allNodesPerformed: {} }), { allNodesPerformed: {} });
  assert.throws(() => best({ greedyDescent: {}, allNodesPerformed: {} }),
    { name: 'TypeError', message: /allNodesPerformed|greedyDescent/ });
});

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

test('integer fields take any exact integer given as a JS number', () => {
  for (const value of [1e16, 2 ** 53 + 2, 1e18]) {
    assert.equal(validateRoutingSearchParameters({ solutionLimit: value }).solutionLimit, BigInt(value).toString());
  }
  assert.equal(validateSatParameters({ maxNumberOfConflicts: -(2 ** 60) }).maxNumberOfConflicts, '-1152921504606846976');
  assert.equal(validateSatParameters({ randomSeed: 2 ** 31 - 1 }).randomSeed, 2 ** 31 - 1);
});

test('bigints are encoded exactly, even with a BigInt.prototype.toJSON polyfill', () => {
  const descriptor = Object.getOwnPropertyDescriptor(BigInt.prototype, 'toJSON');
  try {
    BigInt.prototype.toJSON = function toJSON() { return Number(this); }; // a common, lossy polyfill
    assert.equal(validateRoutingSearchParameters({ solutionLimit: 9007199254740993n }).solutionLimit, '9007199254740993');
    assert.equal(validateRoutingSearchParameters({ solutionLimit: Object(9007199254740993n) }).solutionLimit, '9007199254740993');
    assert.deepEqual(validateSatParameters({ subsolverParams: [{ name: 'a', maxNumberOfConflicts: -9007199254740993n }] })
      .subsolverParams[0].maxNumberOfConflicts, '-9007199254740993');
  } finally {
    if (descriptor) Object.defineProperty(BigInt.prototype, 'toJSON', descriptor);
    else delete BigInt.prototype.toJSON;
  }
});

test('strings must be well-formed Unicode', () => {
  assert.throws(() => validateRoutingSearchParameters({ logTag: 'a\uD800' }),
    { name: 'TypeError', message: /'logTag' must be well-formed Unicode/ });
  assert.throws(() => validateSatParameters({ subsolvers: ['default_lp', '\uDC00b'] }),
    { name: 'TypeError', message: /'subsolvers\[1\]' must be well-formed Unicode/ });
  assert.equal(validateRoutingSearchParameters({ logTag: 'r\u00e9seau \u{1F69A}' }).logTag, 'r\u00e9seau \u{1F69A}');
});

test('object keys must be well-formed Unicode', () => {
  assert.throws(() => validateSatParameters({ ['num\uD800']: 1 }),
    { name: 'TypeError', message: /^SatParameters has a top-level key that is not well-formed Unicode/ });
  assert.throws(() => validateRoutingSearchParameters({ localSearchOperators: { ['\uDC00']: 'BOOL_TRUE' } }),
    { name: 'TypeError', message: /'localSearchOperators' has a key that is not well-formed Unicode/ });
  assert.throws(() => validateSatParameters({ subsolverParams: [{ name: 'a', ['x\uD83D']: 1 }] }),
    { name: 'TypeError', message: /'subsolverParams\[0\]' has a key that is not well-formed Unicode/ });
});

test('protobuf parse errors keep the field and expected type but not positions in the internal JSON', () => {
  const messageOf = (fn) => { try { fn(); } catch (error) { return error; } return assert.fail('expected a TypeError'); };
  const routing = messageOf(() => validateRoutingSearchParameters({ timeLimit: 5 }));
  const sat = messageOf(() => validateSatParameters({ logSearchProgress: 1 }));
  for (const [error, field, type] of [[routing, 'timeLimit', 'google.protobuf.Duration'], [sat, 'logSearchProgress', 'bool']]) {
    assert.equal(error.name, 'TypeError');
    // protobuf may space its own words irregularly, so match its words, not its spacing.
    assert.match(error.message, new RegExp(`@\\s+${field}:\\s`));
    assert.ok(error.message.includes(type), error.message);
    assert.doesNotMatch(error.message, /near|offset|\d+:\d+/);
  }
});

test('cleaning protobuf errors never rewrites the caller\'s echoed value', () => {
  const combined = [];
  // Quotes, a lookalike position (with and without the ':' real ones have, and
  // after a single space, a double space or a tab), ':' and '@ <struct>' in
  // every order inside the value.
  for (const gap of [' ', '  ', '\t']) {
    const position = `${gap}near 1:2 (offset 3)`;
    for (const quote of ['', "'", "';", " '"]) {
      for (const fake of [position, `${position}:`, `${position}: y`, `,${position}: y`]) {
        for (const tail of ['', ': z', ' @ <struct>q: z', "' @ <struct>q: z"]) {
          combined.push(`x${quote}${fake}${tail}`, `${quote}x @ <struct>p${fake}${tail}`);
        }
      }
    }
  }
  for (const value of ['A near 1:2 (offset 3)', 'A  B', ' lead\ttab  ', "it's  x", 'x, near 1:2 (offset 3)',
    'x @ <struct>y: z', "x' near 1:2 (offset 3)", "x' near 1:2 (offset 3): y", ...combined]) {
    for (const call of [
      () => validateRoutingSearchParameters({ firstSolutionStrategy: value }),
      () => validateSatParameters({ searchBranching: value }),
      () => native.readSatParametersForTesting(JSON.stringify({ searchBranching: value })),
    ]) {
      assert.throws(call, (error) => error instanceof TypeError && error.message.includes(`'${value}'`), JSON.stringify(value));
    }
  }
});

// In a child process: a crash here (e.g. a regex executor overflowing the
// stack on caller-controlled text) must fail this test, not kill the runner.
test('huge values and keys echoed in errors neither crash nor flood the message', () => {
  const script = `
    const assert = require('node:assert/strict');
    const { validateRoutingSearchParameters, validateSatParameters } = require(${JSON.stringify(require.resolve('..'))});
    const native = require(${JSON.stringify(require.resolve('../lib/native'))});
    for (const huge of [' '.repeat(1e6), '9'.repeat(1e6), ' near 1:2 (offset '.repeat(5e4) + '9'.repeat(1e6)]) {
      for (const call of [
        () => validateRoutingSearchParameters({ firstSolutionStrategy: huge }),
        () => validateSatParameters({ searchBranching: huge }),
        () => native.readSatParametersForTesting(JSON.stringify({ searchBranching: huge })),
      ]) {
        assert.throws(call, (error) => error instanceof TypeError && error.message.length < 1000);
      }
    }
    const key = 'k'.repeat(1e6);
    for (const call of [
      () => validateSatParameters({ [key]: 1 }),
      () => validateSatParameters({ subsolverParams: [{ name: 'a', [key]: 1 }] }),
      () => validateSatParameters({ [key]: NaN }),
      () => validateRoutingSearchParameters({ [key]: { [key]: [Symbol('x')] } }),
      () => native.validateSatParameters(JSON.stringify({ subsolverParams: [{ [key]: 1 }] })),
    ]) {
      assert.throws(call, (error) => error instanceof TypeError && error.message.length < 1000 && error.message.includes('kkkk'));
    }
  `;
  const child = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8' });
  assert.equal(child.signal, null, child.stderr);
  assert.equal(child.status, 0, child.stderr);
});

test('circular references are a short TypeError naming the path', () => {
  const routing = {};
  routing.localSearchOperators = { self: routing };
  assert.throws(() => validateRoutingSearchParameters(routing),
    { name: 'TypeError', message: /^RoutingSearchParameters: 'localSearchOperators\.self' is a circular reference$/ });
  const list = [];
  list.push({ again: list });
  assert.throws(() => validateSatParameters({ subsolverParams: list }),
    { name: 'TypeError', message: /^SatParameters: 'subsolverParams\[0\]\.again' is a circular reference$/ });
  const longKeyed = {};
  longKeyed['k'.repeat(1e6)] = { x: longKeyed };
  assert.throws(() => validateSatParameters(longKeyed),
    (error) => error instanceof TypeError && error.message.startsWith('SatParameters: ') &&
      /circular reference$/.test(error.message) && error.message.length < 1000);
  // The same object twice, without a cycle, is not circular.
  const shared = { name: 'a' };
  assert.doesNotThrow(() => validateSatParameters({ subsolverParams: [shared, shared] }));
});

test('deeply nested values are a short TypeError, without protobuf-internal Struct paths', () => {
  const nest = (levels, key) => {
    let value = {};
    for (let i = 0; i < levels; i++) value = { [key]: value };
    return value;
  };
  assert.throws(() => validateRoutingSearchParameters(nest(65, 'localSearchOperators')),
    { name: 'TypeError', message: /^RoutingSearchParameters: 'localSearchOperators(\.localSearchOperators)+\.l?\u2026' is nested more than 64 levels deep/ });
  assert.throws(() => validateSatParameters({ subsolverParams: [nest(70, 'x')] }),
    { name: 'TypeError', message: /is nested more than 64 levels deep/ });
  assert.throws(() => validateRoutingSearchParameters({ localSearchOperators: nest(63, 'x') }), { name: 'TypeError', message: /'localSearchOperators\.x/ });
  // The native layer, reached without the JS limit, must not echo Struct-internal paths either.
  // Protobuf picks random spacing on every call, so one call hits a given spacing variant only
  // some of the time; 64 calls make a variant the stripping misses all but certain to fail.
  const deep = JSON.stringify(nest(150, 'localSearchOperators'));
  for (let call = 0; call < 64; call++) {
    assert.throws(() => native.validateRoutingSearchParameters(deep),
      (error) => error instanceof TypeError && !error.message.includes('<struct>') && error.message.length < 1000);
  }
});

test('integer fields given as strings take only canonical decimals that fit the field type', () => {
  for (const bad of ['1e3', '007', ' 7', '7 ', '+7', '-0', '1.5', '', '-', '0x10']) {
    assert.throws(() => validateRoutingSearchParameters({ solutionLimit: bad }),
      { name: 'TypeError', message: /'solutionLimit' must be an integer/ }, JSON.stringify(bad));
  }
  for (const bad of ['2147483648', '-2147483649']) {
    assert.throws(() => validateSatParameters({ randomSeed: bad }), { name: 'TypeError', message: /'randomSeed' must fit in int32/ });
  }
  for (const good of ['2147483647', '-2147483648', '0']) assert.equal(validateSatParameters({ randomSeed: good }).randomSeed, Number(good));
  for (const bad of ['9223372036854775808', '-9223372036854775809']) {
    assert.throws(() => validateSatParameters({ maxNumberOfConflicts: bad }),
      { name: 'TypeError', message: /'maxNumberOfConflicts' must fit in int64/ });
  }
  for (const good of ['9223372036854775807', '-9223372036854775808', '7']) {
    assert.equal(validateSatParameters({ maxNumberOfConflicts: good }).maxNumberOfConflicts, good);
  }
  const ruin = (value) => ({ iteratedLocalSearchParameters: { ruinRecreateParameters: { routeSelectionMinNeighbors: value } } });
  for (const bad of ['-1', '4294967296']) {
    assert.throws(() => validateRoutingSearchParameters(ruin(bad)),
      { name: 'TypeError', message: /'iteratedLocalSearchParameters\.ruinRecreateParameters\.routeSelectionMinNeighbors' must fit in uint32/ });
  }
  assert.equal(validateRoutingSearchParameters(ruin('7')).iteratedLocalSearchParameters.ruinRecreateParameters.routeSelectionMinNeighbors, 7);
});

test('integer fields reject numbers that are not integers or do not fit the field type', () => {
  assert.throws(() => validateSatParameters({ numWorkers: 1e16 }),
    { name: 'TypeError', message: /'numWorkers' must fit in int32/ });
  assert.throws(() => validateSatParameters({ numWorkers: 2 ** 31 }), { name: 'TypeError', message: /'numWorkers' must fit in int32/ });
  assert.throws(() => validateRoutingSearchParameters({ solutionLimit: 2 ** 63 }),
    { name: 'TypeError', message: /'solutionLimit' must fit in int64/ });
  assert.throws(() => validateRoutingSearchParameters({ solutionLimit: 1.5 }),
    { name: 'TypeError', message: /'solutionLimit' must be an integer/ });
  assert.throws(() => validateSatParameters({ subsolverParams: [{ name: 'a', numWorkers: 0.5 }] }),
    { name: 'TypeError', message: /'subsolverParams\[0\]\.numWorkers' must be an integer/ });
});

test('a Duration must be given as a string, not in object form', () => {
  for (const timeLimit of [{ seconds: 1, nanos: -5 }, { seconds: '9223372036854775807' }, { seconds: 1, nanos: 2e9 }, { seconds: 1 }]) {
    assert.throws(() => validateRoutingSearchParameters({ timeLimit }),
      { name: 'TypeError', message: /'timeLimit' must be a Duration string/ });
    assert.throws(() => routingSearchParametersJson({ timeLimit }), { name: 'TypeError', message: /'timeLimit'/ });
  }
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

test('routingSearchParametersJson and satParametersJson return the full validated set as JSON', () => {
  const parsed = JSON.parse(routingSearchParametersJson({ solutionLimit: 3, logTag: 'Infinity', firstSolutionStrategy: null }));
  assert.equal(parsed.solutionLimit, '3');
  assert.equal(parsed.logTag, 'Infinity');
  assert.equal(parsed.firstSolutionStrategy, 'AUTOMATIC');
  assert.deepEqual(parsed.localSearchOperators, defaultRoutingSearchParameters().localSearchOperators);
  assert.deepEqual(JSON.parse(satParametersJson({ numWorkers: 2, maxTimeInSeconds: Infinity, randomSeed: null })),
    { ...JSON.parse(satParametersJson({})), numWorkers: 2, maxTimeInSeconds: 'Infinity' });
});

// The solvers read these strings with ReadRoutingSearchParameters / ReadSatParameters.
test('the JSON from routingSearchParametersJson and satParametersJson parses back natively unchanged', () => {
  const { readRoutingSearchParametersForTesting, readSatParametersForTesting } = native;
  for (const params of [{}, { solutionLimit: 1e18, timeLimit: '1.5s', logTag: 'Infinity', localSearchOperators: { useRelocate: 'BOOL_FALSE' } }]) {
    assert.deepEqual(readRoutingSearchParametersForTesting(routingSearchParametersJson(params)), validateRoutingSearchParameters(params));
  }
  for (const params of [{}, { maxTimeInSeconds: Infinity, maxNumberOfConflicts: -(2 ** 60), subsolvers: ['default_lp'] }]) {
    assert.deepEqual(readSatParametersForTesting(satParametersJson(params)), validateSatParameters(params));
  }
  const full = JSON.parse(routingSearchParametersJson({}));
  assert.throws(() => readRoutingSearchParametersForTesting(JSON.stringify({ ...full, solutionLimit: '0' })),
    { name: 'RangeError', message: /solution_limit/ });
  assert.throws(() => readSatParametersForTesting('{"maxTimeInSeconds": "NaN"}'), { name: 'TypeError', message: /NaN/ });
  assert.throws(() => readSatParametersForTesting(5), { name: 'TypeError', message: /JSON string/ });
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
  assert.equal(validateRoutingSearchParameters({ solutionLimit: Object(5n) }).solutionLimit, '5');
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

test('repeated fields must be arrays, not a bare value', () => {
  assert.throws(() => validateSatParameters({ subsolvers: 'default_lp' }), { name: 'TypeError', message: /'subsolvers' must be an array/ });
  assert.throws(() => validateSatParameters({ restartAlgorithms: 'LUBY_RESTART' }),
    { name: 'TypeError', message: /'restartAlgorithms' must be an array/ });
  assert.throws(() => validateSatParameters({ subsolverParams: { name: 'a' } }),
    { name: 'TypeError', message: /'subsolverParams' must be an array/ });
  const p = validateSatParameters({ subsolvers: ['default_lp'], restartAlgorithms: ['LUBY_RESTART'], subsolverParams: [{ name: 'a' }] });
  assert.deepEqual([p.subsolvers, p.restartAlgorithms, p.subsolverParams[0].name], [['default_lp'], ['LUBY_RESTART'], 'a']);
  assert.deepEqual(validateSatParameters({ subsolvers: null }).subsolvers, []);
});

test('arrays nested inside a repeated field are TypeErrors, not flattened', () => {
  assert.throws(() => validateSatParameters({ subsolvers: [['default_lp', ['no_lp']]] }),
    { name: 'TypeError', message: /'subsolvers\[0\]' must not be an array/ });
  assert.throws(() => validateSatParameters({ subsolvers: ['default_lp', []] }),
    { name: 'TypeError', message: /'subsolvers\[1\]' must not be an array/ });
  assert.throws(() => validateSatParameters({ subsolvers: [[]] }), { name: 'TypeError', message: /'subsolvers\[0\]' must not be an array/ });
  assert.throws(() => validateSatParameters({ restartAlgorithms: [['LUBY_RESTART']] }),
    { name: 'TypeError', message: /'restartAlgorithms\[0\]' must not be an array/ });
  assert.throws(() => validateSatParameters({ subsolverParams: [[{ name: 'a' }]] }),
    { name: 'TypeError', message: /'subsolverParams\[0\]' must not be an array/ });
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
