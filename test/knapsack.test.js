'use strict';
const { test } = require('node:test');
const { spawnSync } = require('node:child_process');
const assert = require('node:assert/strict');
const { KnapsackSolver, KnapsackSolverType } = require('..');

const BB = 'KNAPSACK_MULTIDIMENSION_BRANCH_AND_BOUND_SOLVER';
const DP = 'KNAPSACK_DYNAMIC_PROGRAMMING_SOLVER';
const SINGLE_DIMENSION = [
  'KNAPSACK_BRUTE_FORCE_SOLVER', 'KNAPSACK_64ITEMS_SOLVER', DP, 'KNAPSACK_DIVIDE_AND_CONQUER_SOLVER',
];
const ALL_TYPES = Object.keys(KnapsackSolverType);
const MULTI_TYPES = ALL_TYPES.filter((t) => !SINGLE_DIMENSION.includes(t));

// The OR-Tools knapsack sample (docs: "Solving a Knapsack Problem"), optimum 7534.
const SAMPLE_PROFITS = [
  360, 83, 59, 130, 431, 67, 230, 52, 93, 125, 670, 892, 600, 38, 48, 147, 78, 256, 63, 17, 120, 164, 432, 35, 92,
  110, 22, 42, 50, 323, 514, 28, 87, 73, 78, 15, 26, 78, 210, 36, 85, 189, 274, 43, 33, 10, 19, 389, 276, 312,
];
const SAMPLE_WEIGHTS = [[
  7, 0, 30, 22, 80, 94, 11, 81, 70, 64, 59, 18, 0, 36, 3, 8, 15, 42, 9, 0, 42, 47, 52, 32, 26, 48, 55, 6, 29, 84, 2,
  4, 18, 56, 7, 29, 93, 44, 71, 3, 86, 66, 31, 65, 0, 79, 20, 65, 52, 13,
]];
const SAMPLE_CAPACITIES = [850];

function packed(solver, n) {
  return Array.from({ length: n }, (_, i) => solver.bestSolutionContains(i));
}

// Asserts the reported solution fits every capacity and adds up to `best`.
function assertConsistent(solver, profits, weights, capacities, best) {
  const inside = packed(solver, profits.length);
  const total = profits.reduce((sum, p, i) => sum + (inside[i] ? Number(p) : 0), 0);
  assert.equal(total, best);
  weights.forEach((row, d) => {
    const used = row.reduce((sum, w, i) => sum + (inside[i] ? Number(w) : 0), 0);
    assert.ok(used <= Number(capacities[d]), `dimension ${d}: ${used} > ${capacities[d]}`);
  });
}

// Exhaustive optimum, for small cross-checks.
function bruteForce(profits, weights, capacities) {
  let best = 0;
  for (let mask = 0; mask < 1 << profits.length; mask++) {
    const fits = weights.every((row, d) => row.reduce((s, w, i) => s + (mask & (1 << i) ? w : 0), 0) <= capacities[d]);
    if (fits) best = Math.max(best, profits.reduce((s, p, i) => s + (mask & (1 << i) ? p : 0), 0));
  }
  return best;
}

test('the always-available solver types are listed and the constants are frozen', () => {
  for (const t of [...SINGLE_DIMENSION, BB, 'KNAPSACK_MULTIDIMENSION_CP_SAT_SOLVER']) {
    assert.equal(KnapsackSolverType[t], t);
  }
  assert.ok(Object.isFrozen(KnapsackSolverType));
});

test('solves the OR-Tools sample to 7534 off the main thread', async () => {
  const s = new KnapsackSolver(BB, 'sample');
  s.init(SAMPLE_PROFITS, SAMPLE_WEIGHTS, SAMPLE_CAPACITIES);
  const best = await s.solve();
  assert.equal(best, 7534);
  assert.equal(s.isSolutionOptimal(), true);
  assert.equal(s.name, 'sample');
  assert.equal(new KnapsackSolver(BB).name, 'knapsack');
  assertConsistent(s, SAMPLE_PROFITS, SAMPLE_WEIGHTS, SAMPLE_CAPACITIES, best);
});

test('every available solver type agrees on the sample, with and without reduction', () => {
  for (const type of ALL_TYPES) {
    // Brute force handles at most 30 items: compare it on the first 30 with the DP solver.
    const n = type === 'KNAPSACK_BRUTE_FORCE_SOLVER' ? 30 : SAMPLE_PROFITS.length;
    const profits = SAMPLE_PROFITS.slice(0, n);
    const weights = [SAMPLE_WEIGHTS[0].slice(0, n)];
    const expected = new KnapsackSolver(DP).init(profits, weights, SAMPLE_CAPACITIES).solveSync();
    for (const reduce of [true, false]) {
      const s = new KnapsackSolver(type).setUseReduction(reduce);
      s.init(profits, weights, SAMPLE_CAPACITIES);
      const best = s.solveSync();
      assert.equal(best, expected, `${type} reduction=${reduce}`);
      assertConsistent(s, profits, weights, SAMPLE_CAPACITIES, best);
      s.dispose();
    }
  }
});

test('multi-dimensional solvers match an exhaustive search', () => {
  const profits = [10, 13, 7, 8, 9, 4, 11, 6];
  const weights = [[3, 4, 2, 3, 5, 1, 4, 2], [5, 2, 4, 3, 1, 3, 2, 4], [1, 1, 1, 1, 1, 1, 1, 1]];
  const capacities = [10, 9, 4];
  const expected = bruteForce(profits, weights, capacities);
  for (const type of MULTI_TYPES) {
    const s = new KnapsackSolver(type).init(profits, weights, capacities);
    const best = s.solveSync();
    assert.equal(best, expected, type);
    assertConsistent(s, profits, weights, capacities, best);
  }
});

test('items weighing nothing are always packed (DP at capacity 0 regression)', () => {
  for (const type of ALL_TYPES) {
    for (const reduce of [true, false]) {
      const s = new KnapsackSolver(type).setUseReduction(reduce);
      assert.equal(s.init([5, 3], [[0, 0]], [0]).solveSync(), 8, type);
      assert.deepEqual(packed(s, 2), [true, true]);
      assert.equal(s.isSolutionOptimal(), true);
      assert.equal(s.init([3, 5, 4], [[0, 1, 2]], [1]).solveSync(), 8, type);
      assert.deepEqual(packed(s, 3), [true, true, false]);
    }
  }
});

test('no items, zero capacity and zero profits are valid problems', () => {
  for (const type of ALL_TYPES) {
    for (const reduce of [true, false]) {
      const s = new KnapsackSolver(type).setUseReduction(reduce);
      assert.equal(s.init([], [[]], [0]).solveSync(), 0, `${type} empty`);
      assert.equal(s.isSolutionOptimal(), true);
      assert.equal(s.init([], [[]], [5]).solveSync(), 0);
      assert.equal(s.init([5, 3], [[2, 1]], [0]).solveSync(), 0, `${type} zero capacity`);
      assert.deepEqual(packed(s, 2), [false, false]);
      assert.equal(s.init([0, 0], [[1, 1]], [1]).solveSync(), 0, `${type} zero profits`);
    }
  }
});

test('accepts BigInts and typed arrays, including weights near the int64 limit', () => {
  const s = new KnapsackSolver(BB);
  assert.equal(s.init(new Int32Array([4, 5]), [new Float64Array([2, 3])], new Uint32Array([3])).solveSync(), 5);
  assert.equal(s.init([4n, 5n], [new BigInt64Array([2n, 3n])], [3n]).solveSync(), 5);
  const big = 2n ** 61n;
  assert.equal(s.init([1, 2, 3], [[big, big, big]], [2n * big]).solveSync(), 5);
  // A capacity far above the total weight is fine (capped to the total internally).
  assert.equal(s.init([1, 2], [[1, 1]], [2n ** 63n - 1n]).solveSync(), 3);
  assert.equal(new KnapsackSolver(DP).init([1, 2], [[1, 1]], [2n ** 63n - 1n]).solveSync(), 3);
  // The largest total profit a JS number holds exactly.
  assert.equal(s.init([Number.MAX_SAFE_INTEGER], [[1]], [1]).solveSync(), Number.MAX_SAFE_INTEGER);
});

test('a time limit of 0 stops the search early with a feasible, non-optimal answer', () => {
  const n = 40;
  const profits = Array.from({ length: n }, (_, i) => 1000 + ((i * 7919) % 97));
  const weights = [Array.from({ length: n }, (_, i) => 1000 + ((i * 104729) % 89))];
  const capacities = [Math.floor(weights[0].reduce((a, b) => a + b) / 2)];
  const s = new KnapsackSolver(BB).setUseReduction(false).setTimeLimit(0);
  s.init(profits, weights, capacities);
  const best = s.solveSync();
  assert.equal(s.isSolutionOptimal(), false);
  assertConsistent(s, profits, weights, capacities, best);
  // Infinity lifts the limit again.
  s.setTimeLimit(Infinity).init(SAMPLE_PROFITS, SAMPLE_WEIGHTS, SAMPLE_CAPACITIES);
  assert.equal(s.solveSync(), 7534);
  assert.equal(s.isSolutionOptimal(), true);
});

test('MIP types honour a time limit of 0 or under 1 ms instead of solving without one', () => {
  const mipTypes = MULTI_TYPES.filter((t) => t.endsWith('_MIP_SOLVER'));
  // MPSolver counts whole milliseconds and reads 0 as "no limit": SCIP ran this for minutes.
  const out = runIsolated(`
    let seed = 7;
    const rnd = (m) => { seed = (seed * 48271) % 2147483647; return seed % m; };
    const profits = Array.from({ length: 400 }, () => 500 + rnd(500));
    const weights = Array.from({ length: 5 }, () => Array.from({ length: 400 }, () => 500 + rnd(500)));
    const capacities = weights.map((row) => Math.floor(row.reduce((a, b) => a + b) / 2));
    for (const type of ${JSON.stringify(mipTypes)}) {
      for (const limit of [0, 0.0004]) {
        const s = new KnapsackSolver(type).setTimeLimit(limit);
        s.init(profits, weights, capacities);
        const started = Date.now();
        s.solveSync();
        console.log(type, limit, s.isSolutionOptimal(), Date.now() - started < 5000);
      }
    }`);
  for (const line of out.split('\n')) assert.match(line, / false true$/);
});

test('capacity-sized solvers refuse capacities they would need gigabytes for', () => {
  const big = 2n ** 61n;
  for (const type of [DP, 'KNAPSACK_DIVIDE_AND_CONQUER_SOLVER']) {
    const s = new KnapsackSolver(type).setUseReduction(false);
    assert.throws(() => s.init([1, 1], [[big, big]], [big]), /handles at most 100000000/);
    assert.throws(() => s.solveSync(), /call init\(\) before each solve\(\)/);
    // The cap applies after capping the capacity to the total weight: this one is 2.
    assert.equal(s.init([1, 1], [[1, 1]], [big]).solveSync(), 2);
  }
  // Branch and bound has no such limit.
  assert.equal(new KnapsackSolver(BB).init([1, 1], [[big, big]], [big]).solveSync(), 1);
});

test('unknown, unavailable and malformed solver types throw', () => {
  assert.throws(() => new KnapsackSolver('NOPE'),
    /Unsupported or unavailable knapsack solver type: 'NOPE'.*KNAPSACK_64ITEMS_SOLVER/);
  assert.throws(() => new KnapsackSolver(), TypeError);
  assert.throws(() => new KnapsackSolver(3), TypeError);
  assert.throws(() => new KnapsackSolver(BB, 42), /name must be a string/);
  const missing = ['KNAPSACK_MULTIDIMENSION_XPRESS_MIP_SOLVER', 'KNAPSACK_MULTIDIMENSION_CPLEX_MIP_SOLVER']
    .filter((t) => !(t in KnapsackSolverType));
  for (const t of missing) assert.throws(() => new KnapsackSolver(t), /unavailable/);
});

test('init() rejects malformed problems before OR-Tools sees them', () => {
  const s = new KnapsackSolver(BB);
  const cases = [
    [[[1], [[1]]], TypeError, /capacities must be an Array/],                 // missing capacities
    [[[1], [1], [1]], TypeError, /weights\[0\] must be an Array/],                 // weights not nested
    [[[1], 'x', [1]], TypeError, /init\(profits/],
    [[[1, 2], [[1]], [1]], RangeError, /weights\[0\] has 1 items but profits has 2/],
    [[[1], [[1]], [1, 2]], RangeError, /capacities has 2 entries but weights has 1 dimensions/],
    [[[], [], []], RangeError, /at least one dimension/],
    [[[-1], [[1]], [1]], RangeError, /profits\[0\] must be >= 0/],
    [[[1], [[-1]], [1]], RangeError, /weights\[0\]\[0\] must be >= 0/],
    [[[1], [[1]], [-1]], RangeError, /capacities\[0\] must be >= 0/],
    [[[NaN], [[1]], [1]], TypeError, /NaN/],
    [[[Infinity], [[1]], [1]], TypeError, /finite/],
    [[[1.5], [[1]], [1]], TypeError, /integer/],
    [[['1'], [[1]], [1]], TypeError, /profits\[0\]/],
    [[[2 ** 53], [[1]], [1]], RangeError, /safe integer/],
    [[[2n ** 64n], [[1]], [1]], RangeError, /64-bit/],
    [[[1, 1], [[2n ** 62n, 2n ** 62n]], [1]], RangeError, /sum of weights\[0\] overflows/],
    [[[Number.MAX_SAFE_INTEGER, 1], [[1, 1]], [1]], RangeError, /sum of profits exceeds/],
  ];
  for (const [args, type, message] of cases) {
    assert.throws(() => s.init(...args), (e) => e instanceof type && message.test(e.message), String(args));
  }
});

test('size limits of the specialised solver types are enforced', () => {
  for (const type of SINGLE_DIMENSION) {
    assert.throws(() => new KnapsackSolver(type).init([1], [[1], [1]], [1, 1]), /handles exactly one dimension, got 2/);
  }
  const ones = (n) => new Array(n).fill(1);
  // 30 items are accepted (the sample test runs brute force on 30 items in full).
  assert.equal(new KnapsackSolver('KNAPSACK_BRUTE_FORCE_SOLVER').init(ones(30), [ones(30)], [30]).solveSync(), 30);
  assert.throws(() => new KnapsackSolver('KNAPSACK_BRUTE_FORCE_SOLVER').init(ones(31), [ones(31)], [10]),
    /at most 30 items, got 31/);
  const ascending = Array.from({ length: 64 }, (_, i) => i + 1);
  const items64 = new KnapsackSolver('KNAPSACK_64ITEMS_SOLVER').setUseReduction(false);
  assert.equal(items64.init(ascending, [ones(64)], [10]).solveSync(), 595); // 55 + ... + 64
  assert.throws(() => new KnapsackSolver('KNAPSACK_64ITEMS_SOLVER').init(ones(65), [ones(65)], [10]),
    /at most 64 items, got 65/);
});

test('a failed init() keeps the previously loaded problem', () => {
  const s = new KnapsackSolver(BB).init([4, 5], [[2, 3]], [3]);
  assert.throws(() => s.init([-1], [[1]], [1]), RangeError);
  assert.equal(s.solveSync(), 5);
});

test('results need a solve, and every solve needs its own init()', () => {
  const s = new KnapsackSolver(BB);
  assert.throws(() => s.solveSync(), /call init\(\) before each solve\(\)/);
  assert.throws(() => s.isSolutionOptimal(), /call init\(\) and solve\(\) first/);
  s.init([4, 5], [[2, 3]], [3]);
  assert.throws(() => s.bestSolutionContains(0), /call init\(\) and solve\(\) first/);
  assert.equal(s.solveSync(), 5);
  // OR-Tools' branch and bound returns a wrong profit when solved twice in a row.
  assert.throws(() => s.solveSync(), /call init\(\) before each solve\(\)/);
  assert.equal(s.bestSolutionContains(1), true); // the result stays readable
});

test('bestSolutionContains() validates the item index', () => {
  const s = new KnapsackSolver(BB).init([4, 5], [[2, 3]], [3]);
  s.solveSync();
  assert.throws(() => s.bestSolutionContains(2), RangeError);
  assert.throws(() => s.bestSolutionContains(-1), RangeError);
  assert.throws(() => s.bestSolutionContains(0.5), TypeError);
  assert.throws(() => s.bestSolutionContains('0'), TypeError);
});

test('changing setUseReduction() requires a new init(); setting the same value does not', () => {
  const s = new KnapsackSolver(BB).init([4, 5], [[2, 3]], [3]);
  assert.equal(s.useReduction, true);
  s.setUseReduction(true);
  assert.equal(s.solveSync(), 5);
  s.init([4, 5], [[2, 3]], [3]).setUseReduction(false);
  assert.equal(s.useReduction, false);
  assert.throws(() => s.solveSync(), /setUseReduction\(\) also needs a new init\(\)/);
  assert.throws(() => s.setUseReduction('no'), TypeError);
});

test('setTimeLimit() validates its argument', () => {
  const s = new KnapsackSolver(BB);
  assert.throws(() => s.setTimeLimit(-1), RangeError);
  assert.throws(() => s.setTimeLimit(-Infinity), RangeError);
  assert.throws(() => s.setTimeLimit(NaN), TypeError);
  assert.throws(() => s.setTimeLimit('1'), TypeError);
  s.setTimeLimit(0.5);
});

test('the solver is busy during solve(); concurrent solvers run independently', async () => {
  const a = new KnapsackSolver(BB).init(SAMPLE_PROFITS, SAMPLE_WEIGHTS, SAMPLE_CAPACITIES);
  const b = new KnapsackSolver('KNAPSACK_MULTIDIMENSION_CP_SAT_SOLVER')
    .init(SAMPLE_PROFITS, SAMPLE_WEIGHTS, SAMPLE_CAPACITIES);
  const pa = a.solve();
  const pb = b.solve();
  assert.equal(a.busy, true);
  for (const call of [() => a.init([1], [[1]], [1]), () => a.solveSync(), () => a.solve(), () => a.setTimeLimit(1),
    () => a.setUseReduction(false), () => a.bestSolutionContains(0), () => a.dispose(), () => a.name]) {
    assert.throws(call, /KnapsackSolver is busy/);
  }
  assert.deepEqual(await Promise.all([pa, pb]), [7534, 7534]);
  assert.equal(a.busy, false);
  assertConsistent(b, SAMPLE_PROFITS, SAMPLE_WEIGHTS, SAMPLE_CAPACITIES, 7534);
});

test('dispose() is idempotent and later calls throw', () => {
  const s = new KnapsackSolver(BB).init([1], [[1]], [1]);
  s.dispose();
  s.dispose();
  assert.equal(s.busy, false);
  assert.throws(() => s.solveSync(), /disposed/);
  assert.throws(() => s.init([1], [[1]], [1]), /disposed/);
  assert.throws(() => s.useReduction, /disposed/);
});

test('Symbol.dispose frees the solver', { skip: typeof Symbol.dispose !== 'symbol' && 'no Symbol.dispose' }, () => {
  const s = new KnapsackSolver(BB);
  s[Symbol.dispose]();
  assert.throws(() => s.name, /disposed/);
});

// Runs `body` in a child process, so a native crash fails the test instead of the run.
function runIsolated(body) {
  const script = `const { KnapsackSolver } = require(${JSON.stringify(require.resolve('..'))});\n${body}`;
  const child = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 60000 });
  assert.equal(child.status, 0, `child exited with ${child.status} (${child.signal}): ${child.stderr}`);
  return child.stdout.trim();
}

test('a getter that disposes the solver while init() reads its arguments is a JS error', () => {
  const out = runIsolated(`
    const s = new KnapsackSolver('KNAPSACK_MULTIDIMENSION_BRANCH_AND_BOUND_SOLVER');
    const profits = [1, 2];
    Object.defineProperty(profits, 1, { get() { s.dispose(); return 2; } });
    try { s.init(profits, [[1, 1]], [1]); console.log('no error'); } catch (e) { console.log(e.message); }`);
  assert.match(out, /disposed/);
});

test('a getter that starts a solve while init() reads its arguments is a JS error', () => {
  const out = runIsolated(`
    const s = new KnapsackSolver('KNAPSACK_MULTIDIMENSION_BRANCH_AND_BOUND_SOLVER').init([4, 5], [[2, 3]], [3]);
    let pending;
    const weights = [[1, 1]];
    Object.defineProperty(weights[0], 0, { get() { pending = s.solve(); return 1; } });
    try { s.init([1, 2], weights, [1]); console.log('no error'); } catch (e) { console.log(e.message); }
    pending.then((best) => console.log('solved', best));`);
  assert.match(out, /KnapsackSolver is busy/);
  assert.match(out, /solved 5/);
});

test('a throwing getter on the weights rows propagates its own error', () => {
  const out = runIsolated(`
    const s = new KnapsackSolver('KNAPSACK_MULTIDIMENSION_BRANCH_AND_BOUND_SOLVER');
    const weights = [];
    Object.defineProperty(weights, 0, { get() { throw new Error('row getter'); } });
    try { s.init([], weights, [1]); console.log('no error'); } catch (e) { console.log(e.message); }`);
  assert.equal(out, 'row getter');
});

test('a throwing getter on a profit propagates its own error', () => {
  const out = runIsolated(`
    const s = new KnapsackSolver('KNAPSACK_MULTIDIMENSION_BRANCH_AND_BOUND_SOLVER');
    const profits = [1, 2];
    Object.defineProperty(profits, 1, { get() { throw new Error('profit getter'); } });
    try { s.init(profits, [[1, 1]], [1]); console.log('no error'); } catch (e) { console.log(e.message); }`);
  assert.equal(out, 'profit getter');
});

test('MIP and CP-SAT types refuse numbers they cannot represent exactly', () => {
  const big = 2n ** 61n;
  const mipTypes = ['KNAPSACK_MULTIDIMENSION_CBC_MIP_SOLVER', 'KNAPSACK_MULTIDIMENSION_SCIP_MIP_SOLVER']
    .filter((t) => t in KnapsackSolverType);
  for (const type of mipTypes) {
    // CBC used to report this infeasible packing (item 0 alone exceeds the capacity) as optimal.
    assert.throws(() => new KnapsackSolver(type).init([5, 3, 7], [[big + 1n, big, 1n]], [big]),
      { name: 'RangeError', message: new RegExp(`${type}.*more than 2\\^20.*BRANCH_AND_BOUND`) });
    // SCIP used to pack a load of 1e7 + 1 into a capacity of 1e7 (its tolerance is relative).
    assert.throws(() => new KnapsackSolver(type).init([5, 3], [[1e7, 1]], [1e7]), /more than 2\^20/);
    // Weights adding up to 2^20 are checked exactly; one more unit is refused.
    const s = new KnapsackSolver(type).init([5, 3, 4], [[2 ** 19, 2 ** 19 - 4, 4]], [2 ** 19]);
    assert.equal(s.solveSync(), 7); // items 1 and 2; items 0 and 2 would weigh 2^19 + 4
    assert.equal(s.bestSolutionContains(0), false);
    assert.throws(() => s.init([5, 3], [[2 ** 20, 1]], [2 ** 20]), RangeError);
  }
  const cpSat = 'KNAPSACK_MULTIDIMENSION_CP_SAT_SOLVER';
  assert.throws(() => new KnapsackSolver(cpSat).init([5, 3], [[2n ** 61n, 2n ** 61n]], [2n ** 61n]),
    { name: 'RangeError', message: /KNAPSACK_MULTIDIMENSION_CP_SAT_SOLVER.*2\^62.*BRANCH_AND_BOUND/ });
  assert.equal(new KnapsackSolver(cpSat).init([5, 3], [[2n ** 60n, 2n ** 60n]], [2n ** 60n]).solveSync(), 5);
  // Branch and bound handles the same input exactly.
  assert.equal(new KnapsackSolver(BB).init([5, 3, 7], [[big + 1n, big, 1n]], [big]).solveSync(), 7);
});
