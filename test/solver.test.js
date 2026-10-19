'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { Solver, supportsBackend, ortoolsVersion } = require('..');

function assertNear(actual, expected, eps = 1e-6) {
  assert.ok(Math.abs(actual - expected) < eps, `expected ${actual} to be within ${eps} of ${expected}`);
}

test('GLOP solves a small LP', async () => {
  const s = new Solver('GLOP');
  const x = s.numVar(0, Infinity, 'x');
  const y = s.numVar(0, Infinity, 'y');
  s.addLessEq([[x, 1], [y, 2]], 14);
  s.addGreaterEq([[x, 3], [y, -1]], 0);
  s.addLessEq([[x, 1], [y, -1]], 2);
  s.maximize([[x, 3], [y, 4]]);
  const r = await s.solve();
  assert.equal(r.status, 'OPTIMAL');
  assert.ok(Math.abs(r.objectiveValue - 34) < 1e-6);
  assert.ok(Math.abs(x.value() - 6) < 1e-6);
  assert.ok(Math.abs(y.value() - 4) < 1e-6);
});

test('infeasible model reports INFEASIBLE', () => {
  const s = new Solver('GLOP');
  const x = s.numVar(0, 1, 'x');
  s.addGreaterEq(x, 5);
  s.minimize(x);
  const r = s.solveSync();
  assert.equal(r.status, 'INFEASIBLE');
  assert.equal(r.feasible, false);
});

test('mutating during an async solve throws', async () => {
  const s = new Solver('GLOP');
  const x = s.numVar(0, 10, 'x');
  s.maximize(x);
  const p = s.solve();
  assert.ok(s.busy);
  assert.throws(() => s.numVar(0, 1), /busy/);
  await p;
  assert.equal(s.busy, false);
});

test('bad backend name throws a clear error', () => {
  assert.throws(() => new Solver('NOT_A_SOLVER'), /Unsupported or unavailable/);
});

test('native index arguments must be in-range integers', () => {
  const s = new Solver('GLOP');
  s.numVar(0, 1, 'x');
  assert.throws(() => s._n.setVariableBounds(99, 0, 1), RangeError);
  assert.throws(() => s._n.setVariableBounds(-1, 0, 1), RangeError);
  assert.throws(() => s._n.setVariableBounds(0.5, 0, 1), TypeError);
  assert.throws(() => s._n.setVariableBounds('0', 0, 1), TypeError);
});

const mipBackend = ['SCIP', 'CBC', 'HIGHS', 'CP_SAT'].find(supportsBackend);
test('MIP backend solves knapsack', { skip: !mipBackend && 'no MIP backend compiled in' }, async () => {
  const s = new Solver(mipBackend);
  const a = s.boolVar('a'), b = s.boolVar('b'), c = s.boolVar('c');
  s.addLessEq([[a, 4], [b, 7], [c, 5]], 10);
  s.maximize([[a, 10], [b, 13], [c, 9]]);
  const r = await s.solve();
  assert.equal(r.status, 'OPTIMAL');
  // MIP solvers return values within a tolerance (e.g. -0 or 0.9999999), never compare exactly.
  assertNear(r.objectiveValue, 19);  // a + c
  assertNear(a.value(), 1);
  assertNear(c.value(), 1);
  assertNear(b.value(), 0);
});

test('LP solve reports zero branch-and-bound nodes', () => {
  const s = new Solver('GLOP');
  const x = s.numVar(0, 1, 'x');
  s.maximize(x);
  const r = s.solveSync();
  assert.equal(r.status, 'OPTIMAL');
  assert.equal(r.nodes, 0);
});

// Small LP with a known optimum (6, 4); binding rows c0 and c2 have duals 7/3 and 2/3.
function smallLp(backend = 'GLOP', name) {
  const s = new Solver(backend, name);
  const x = s.numVar(0, Infinity, 'x');
  const y = s.numVar(0, Infinity, 'y');
  const c0 = s.addLessEq([[x, 1], [y, 2]], 14);
  const c1 = s.addGreaterEq([[x, 3], [y, -1]], 0);
  const c2 = s.addLessEq([[x, 1], [y, -1]], 2);
  s.maximize([[x, 3], [y, 4]]);
  return { s, x, y, c0, c1, c2 };
}

// Market split (Cornuéjols & Dawande): tiny, yet takes CP-SAT seconds to settle.
function marketSplit(backend, m = 4, n = 30) {
  let state = 12345;
  const rand = () => { // mulberry32: deterministic, unlike Math.random
    state = (state + 0x6d2b79f5) | 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) % 100;
  };
  const s = new Solver(backend);
  const x = Array.from({ length: n }, (_, j) => s.boolVar(`x${j}`));
  for (let i = 0; i < m; i++) {
    const a = x.map(() => rand());
    s.addEquality(x.map((v, j) => [v, a[j]]), Math.floor(a.reduce((p, q) => p + q, 0) / 2));
  }
  s.minimize(x[0]);
  return s;
}

test('LP duals and reduced costs', () => {
  const { s, x, y, c0, c1, c2 } = smallLp();
  assert.equal(s.solveSync().status, 'OPTIMAL');
  assertNear(c0.dualValue(), 7 / 3);
  assertNear(c1.dualValue(), 0);
  assertNear(c2.dualValue(), 2 / 3);
  assertNear(x.reducedCost(), 0);
  assertNear(y.reducedCost(), 0);
});

test('duals and reduced costs throw on MIP backends', { skip: !mipBackend && 'no MIP backend compiled in' }, () => {
  const { s, x, c0 } = smallLp(mipBackend);
  assert.equal(s.solveSync().status, 'OPTIMAL');
  assert.throws(() => c0.dualValue(), /only available for LP backends/);
  assert.throws(() => x.reducedCost(), /only available for LP backends/);
});

test('solution accessors throw before any solve', () => {
  const { s, x } = smallLp();
  assert.throws(() => x.value(), /No solve result/);
  assert.throws(() => s._n.objectiveValue(), /No solve result/);
  assert.throws(() => s._n.iterations(), /No solve result/);
});

test('solution accessors throw after the model changes', () => {
  const { s, x, y } = smallLp();
  s.solveSync();
  assertNear(x.value(), 6);
  y.setBounds(0, 1);
  assert.throws(() => x.value(), /No solve result/);
  assertNear(s.solveSync().objectiveValue, 3 * 3 + 4 * 1);  // re-solve works: x=3, y=1
  assertNear(x.value(), 3);
});

test('solution accessors throw after an infeasible solve', () => {
  const s = new Solver('GLOP');
  const x = s.numVar(0, 1, 'x');
  s.addGreaterEq(x, 5);
  const r = s.solveSync();
  assert.equal(r.status, 'INFEASIBLE');
  assert.ok(Number.isNaN(r.objectiveValue));
  assert.throws(() => x.value(), /No solution available/);
});

test('clear() invalidates old variables and constraints', () => {
  const { s, x, c0 } = smallLp();
  s.clear();
  assert.equal(s.numVariables, 0);
  assert.throws(() => x.value(), /no longer valid/);
  assert.throws(() => x.setBounds(0, 1), /no longer valid/);
  assert.throws(() => c0.setBounds(0, 1), /no longer valid/);
  assert.throws(() => s.maximize(x), /no longer valid/);
  const z = s.numVar(0, 2, 'z');  // takes x's old index 0
  s.maximize(z);
  assert.equal(s.solveSync().status, 'OPTIMAL');
  assertNear(z.value(), 2);
  assert.throws(() => x.value(), /no longer valid/);
});

test('variables from another solver are rejected without touching the model', () => {
  const a = new Solver('GLOP');
  const b = new Solver('GLOP');
  const xa = a.numVar(0, 1, 'xa');
  const xb = b.numVar(0, 1, 'xb');
  assert.throws(() => b.addLessEq([[xb, 1], [xa, 1]], 1), /belongs to a different Solver/);
  assert.equal(b.numConstraints, 0);
  const c = b.addLessEq(xb, 1);
  assert.throws(() => c.setCoefficient(xa, 1), /belongs to a different Solver/);
  assert.throws(() => c.setCoefficient({ index: 0 }, 1), TypeError);
  assert.throws(() => b.minimize(xa), /belongs to a different Solver/);
});

test('invalid numbers are rejected before the model changes', () => {
  const s = new Solver('GLOP');
  const x = s.numVar(0, 1, 'x');
  const y = s.numVar(-Infinity, Infinity, 'y');  // infinite bounds are valid
  assert.throws(() => s.numVar(NaN, 1), /lb must not be NaN/);
  assert.throws(() => s.numVar(0, 'one'), /ub must be a number/);
  assert.throws(() => s.addLessEq([[x, 1], [y, NaN]], 1), /finite numeric coefficient/);
  assert.throws(() => s.addLessEq([[x, Infinity]], 1), /finite numeric coefficient/);
  assert.throws(() => s.addLessEq([[x, 1e308], [x, 1e308]], 1), /overflows/);
  assert.throws(() => s.addLessEq({ terms: [[x, 1]], constant: NaN }, 1), /finite numeric constant/);
  assert.throws(() => s.addConstraint(x, NaN, 1), /lb must not be NaN/);
  assert.throws(() => s.addLessEq(x, null), /bounds must be numbers/);
  assert.throws(() => s.addGreaterEq(x, '5'), /bounds must be numbers/);
  assert.equal(s.numVariables, 2);
  assert.equal(s.numConstraints, 0);
  assert.throws(() => x.setBounds(0, NaN), /ub must not be NaN/);
  assert.throws(() => s.setTimeLimit(-1), RangeError);
  assert.throws(() => s.setTimeLimit(NaN), TypeError);
});

test('reads throw while an async solve is running', async () => {
  const { s } = smallLp();
  const p = s.solve();
  assert.throws(() => s.numVariables, /busy/);
  assert.throws(() => s.numConstraints, /busy/);
  assert.throws(() => s.solverVersion(), /busy/);
  assert.throws(() => s.toLp(), /busy/);
  await p;
  assert.equal(s.numVariables, 2);
});

test('the model name is kept and solverVersion() reports the backend', () => {
  const { s } = smallLp('GLOP', 'my-model');
  assert.match(s.toLp(), /Name\s+: my-model/);
  assert.match(s.solverVersion(), /Glop/i);
});

test('interrupt() returns false when no solve is running', () => {
  const { s } = smallLp();
  assert.equal(s.interrupt(), false);
  assert.equal(s.solveSync().status, 'OPTIMAL');  // and leaves no stale interrupt behind
});

test('interrupt() refuses backends where it is not thread-safe', { skip: !supportsBackend('SCIP') && 'SCIP not compiled in' }, async () => {
  const s = marketSplit('SCIP').setTimeLimit(200);
  const p = s.solve();
  assert.equal(s.interrupt(), false);
  await p;
});

test('interrupt() stops a long CP-SAT solve early', { skip: !supportsBackend('CP_SAT') && 'CP_SAT not compiled in' }, async () => {
  const s = marketSplit('CP_SAT').setTimeLimit(30_000);
  const started = Date.now();
  const p = s.solve();
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(s.interrupt(), true);
  const r = await p;
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 10_000, `solve took ${elapsed}ms after interrupt`);
  assert.ok(!['OPTIMAL', 'INFEASIBLE'].includes(r.status), `unexpected ${r.status}`);
  assert.equal(s.busy, false);
});

test('dispose() frees the model; later calls throw', () => {
  const { s, x, c0 } = smallLp();
  s.solveSync();
  s.dispose();
  s.dispose();  // idempotent
  assert.throws(() => s.numVariables, /disposed/);
  assert.throws(() => s.solveSync(), /disposed/);
  assert.throws(() => s.numVar(0, 1), /disposed/);
  assert.throws(() => x.value(), /no longer valid/);
  assert.throws(() => c0.dualValue(), /no longer valid/);
  assert.equal(s.interrupt(), false);
  assert.equal(s.busy, false);
});

test('dispose() while a solve is pending frees the model once the solve settles', async () => {
  const { s, x } = smallLp();
  const p = s.solve();
  s.dispose();
  s.dispose();  // idempotent while pending too
  assert.ok(s.busy);
  assert.throws(() => s.numVariables, /busy/);
  const r = await p;
  assert.equal(r.status, 'OPTIMAL');
  assert.ok(Math.abs(r.objectiveValue - 34) < 1e-6);
  assert.equal(s.busy, false);
  assert.throws(() => s.numVariables, /disposed/);
  assert.throws(() => x.value(), /no longer valid/);
});

test('dispose() during a solve() that rejects still frees the model', async () => {
  // A native rejection (a C++ failure in the solver) cannot be triggered on
  // demand, so stub the native solve with one that rejects later.
  const { s } = smallLp();
  let busy = false;
  // Native methods are read-only on the prototype: shadow them on the instance.
  Object.defineProperties(s._n, {
    isBusy: { value: () => busy },
    solve: {
      value: () => {
        busy = true;
        return new Promise((resolve, reject) => setImmediate(() => { busy = false; reject(new Error('solve: boom')); }));
      },
    },
  });
  const p = s.solve();
  s.dispose();
  await assert.rejects(p, /solve: boom/);
  assert.throws(() => s.numVariables, /disposed/);
});

// `using` needs the syntax (Node.js >= 24), so compile it only where it parses.
let usingSyntax = null;
try { usingSyntax = new Function('Solver', 'smallLp', `
  return function solveInScope() {
    using s = smallLp().s;
    return { s, result: s.solve() };
  };`); } catch { /* no `using` syntax */ }

test('`using` + return s.solve() resolves the Promise, then frees the model', { skip: !usingSyntax && 'no `using` syntax' }, async () => {
  const { s, result } = usingSyntax(Solver, smallLp)();
  assert.equal((await result).status, 'OPTIMAL');
  assert.throws(() => s.numVariables, /disposed/);
});

test('Symbol.dispose releases the solver at scope exit', { skip: typeof Symbol.dispose !== 'symbol' && 'no Symbol.dispose' }, () => {
  const { s } = smallLp();
  s[Symbol.dispose]();
  assert.throws(() => s.numVariables, /disposed/);
});

test('dispose() keeps memory flat in a synchronous loop', () => {
  // Without dispose(), Node frees native models only after the event loop turns,
  // so this loop would hold ~40 KB per model (~200 MB here).
  const rss = () => process.memoryUsage().rss / 1048576;
  for (let i = 0; i < 500; i++) { const { s } = smallLp(); s.solveSync(); s.dispose(); }  // warm up allocator
  const before = rss();
  for (let i = 0; i < 5000; i++) { const { s } = smallLp(); s.solveSync(); s.dispose(); }
  const grown = rss() - before;
  assert.ok(grown < 50, `RSS grew by ${grown.toFixed(0)} MB over 5000 disposed models`);
});

// OR-Tools 9.14's HiGHS interface drops solver-specific parameters, so its banner cannot be turned off.
const highsQuietSkip = (!supportsBackend('HIGHS') && 'no HiGHS')
  || (/^9\.14\./.test(ortoolsVersion) && 'OR-Tools 9.14 always prints the HiGHS banner');
test('HiGHS writes nothing to stdout unless output is enabled', { skip: highsQuietSkip }, () => {
  const run = (body) => {
    const script = `const { Solver } = require(${JSON.stringify(require.resolve('..'))});
      function knapsack() {
        const s = new Solver('HIGHS');
        const a = s.boolVar('a'), b = s.boolVar('b'), c = s.boolVar('c');
        s.addLessEq([[a, 4], [b, 7], [c, 5]], 10);
        s.maximize([[a, 10], [b, 13], [c, 9]]);
        return s;
      }
      ${body}`;
    const child = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 60000 });
    assert.equal(child.status, 0, `child exited with ${child.status} (${child.signal}): ${child.stderr}`);
    return child.stdout;
  };
  const quiet = run(`
    const results = [];
    const s = knapsack();
    results.push(s.solveSync().status, s.solveSync().status);
    // A caller's own parameters still apply, and output can be switched back off.
    const tuned = knapsack();
    tuned.setSolverSpecificParameters('presolve=off');
    results.push(tuned.solveSync().status);
    tuned.enableOutput(true);
    tuned.enableOutput(false);
    results.push(tuned.solveSync().status);
    knapsack().solve().then((r) => { results.push(r.status); process.stdout.write(JSON.stringify(results)); });`);
  assert.deepEqual(JSON.parse(quiet), ['OPTIMAL', 'OPTIMAL', 'OPTIMAL', 'OPTIMAL', 'OPTIMAL']);
  assert.match(run('knapsack().enableOutput().solveSync();'), /HiGHS/);
  // The caller's own output_flag still wins.
  const flagged = run(`const s = knapsack(); s.setSolverSpecificParameters('output_flag=true'); s.solveSync();`);
  assert.match(flagged, /HiGHS/);
});
