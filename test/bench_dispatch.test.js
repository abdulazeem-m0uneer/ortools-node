'use strict';
// The caby-dispatch benchmark's helpers: statistics, CPU pinning, signature parity, the exact-flavour
// recorder, the runner's options, and the Python-compatible pieces of the caby_model port.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { percentile, median, summary } = require('../bench/lib/stats');
const { pinnedCpu, pinned } = require('../bench/lib/cpu');
const { canonical, groupOf, compareCases } = require('../bench/dispatch/lib/parity');
const { Exact } = require('../bench/dispatch/node/common');
const { parseArgs, command, checkRun, ADDON } = require('../bench/dispatch/bench');
const { RUNS } = require('../bench/dispatch/lib/matrix');
const caby = require('../bench/dispatch/node/caby_model');

test('percentile picks the nearest rank of the sorted sample', () => {
  const xs = [5, 1, 4, 2, 3];
  assert.equal(percentile(xs, 0), 1);
  assert.equal(percentile(xs, 50), 3);
  assert.equal(percentile(xs, 100), 5);
  assert.equal(percentile(xs, 99), 5);
  assert.equal(percentile([7], 95), 7);
  assert.deepEqual(xs, [5, 1, 4, 2, 3], 'the input is not sorted in place');
});

test('percentile and median reject empty samples and out-of-range ranks', () => {
  assert.throws(() => percentile([], 50), RangeError);
  assert.throws(() => percentile([1], -1), RangeError);
  assert.throws(() => percentile([1], 101), RangeError);
  assert.throws(() => percentile([1], NaN), RangeError);
  assert.throws(() => median([]), RangeError);
});

test('median averages the middle pair of an even sample', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
});

test('summary reports n, p50, p95, p99 and max', () => {
  const xs = Array.from({ length: 100 }, (_, i) => i + 1);
  assert.deepEqual(summary(xs), { n: 100, p50: 51, p95: 95, p99: 99, max: 100 });
});

test('pinnedCpu: BENCH_CPU wins, then the first P-core, then CPU 0; null off Linux', () => {
  const never = () => assert.fail('must not read sysfs');
  assert.equal(pinnedCpu({ env: { BENCH_CPU: '3' }, platform: 'linux', readFile: never }), '3');
  assert.equal(pinnedCpu({ env: {}, platform: 'darwin', readFile: never }), null);
  assert.equal(pinnedCpu({ env: {}, platform: 'linux', readFile: () => '0-11\n' }), '0');
  assert.equal(pinnedCpu({ env: {}, platform: 'linux', readFile: () => '4,6-9\n' }), '4');
  const missing = () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); };
  assert.equal(pinnedCpu({ env: {}, platform: 'linux', readFile: missing }), '0');
});

test('pinned prefixes taskset only when a CPU is given', () => {
  assert.deepEqual(pinned('2', 'node', ['a.js']), ['taskset', ['-c', '2', 'node', 'a.js']]);
  assert.deepEqual(pinned(null, 'node', ['a.js']), ['node', ['a.js']]);
});

test('canonical ignores object key order but not array order', () => {
  assert.equal(canonical({ b: 1, a: { d: [1, 2], c: null } }), canonical({ a: { c: null, d: [1, 2] }, b: 1 }));
  assert.notEqual(canonical({ a: [1, 2] }), canonical({ a: [2, 1] }));
});

test('groupOf uses the workload, else the id without its last segment', () => {
  assert.equal(groupOf({ workload: 'w', id: 'x/1' }), 'w');
  assert.equal(groupOf({ id: 'seats:all/12' }), 'seats:all');
  assert.equal(groupOf({ id: 'pairs' }), 'pairs');
});

test('compareCases counts matches, mismatches, one-sided cases and guard hits per workload', () => {
  const py = [
    { workload: 'w', id: '0', sig: { status: 'S', objective: 1 } },
    { workload: 'w', id: '1', sig: { status: 'S', objective: 2 }, guard_hit: true },
    { workload: 'w', id: '2', sig: { status: 'S', objective: 3 } },
  ];
  const node = [
    { workload: 'w', id: '0', sig: { objective: 1, status: 'S' } },
    { workload: 'w', id: '1', sig: { status: 'S', objective: 9 } },
    { workload: 'v', id: '7', sig: {} },
  ];
  const out = compareCases(py, node);
  assert.equal(out.w.cases, 3);
  assert.equal(out.w.match, 1);
  assert.deepEqual(out.w.mismatches, [{ id: '1', a: py[1].sig, b: node[1].sig }]);
  assert.deepEqual(out.w.missing, ['2']);
  assert.equal(out.w.guardHits, 1);
  assert.deepEqual(out.v, { cases: 1, match: 0, mismatches: [], missing: ['7'], guardHits: 0 });
  assert.deepEqual(compareCases([], []), {});
});

test('Exact records signatures once, then timings, unstable cases and guard hits', () => {
  const ex = new Exact(2);
  const seen = [];
  for (const rep of ex.passes()) {
    seen.push(rep);
    ex.record('w', 'a', { o: 1 }, [1, 2, 3]);
    ex.record('w', 'b', { o: rep === 2 ? 5 : 4 }, [1, 2, 3]);
    ex.record('g', 'c', { o: 0 }, [0, 99, 0], 100);
  }
  assert.deepEqual(seen, [0, 1, 2]);
  const r = ex.result();
  assert.deepEqual(r.cases.map((c) => [c.workload, c.id, c.guard_hit]), [['w', 'a', false], ['w', 'b', false], ['g', 'c', true]]);
  assert.equal(r.timings.w.length, 4, 'two timed passes x two cases');
  assert.equal(r.timings.g, undefined, 'guard hits are not timed');
  assert.deepEqual(r.guard_hits, { g: 2 });
  assert.deepEqual(r.unstable, ['w/b']);
});

test('parseArgs validates suites, runs and repeats', () => {
  const d = parseArgs([]);
  assert.equal(d.repeats, 5);
  assert.equal(d.force, false);
  assert.deepEqual(d.runs, RUNS.map((r) => r.label));
  const o = parseArgs(['--suites', 't1,t3', '--runs', 'py-9.15', '--repeats', '2', '--flavors', 'exact', '--force', '--results', 'r']);
  assert.deepEqual([o.suites, o.runs, o.repeats, o.flavors, o.force], [['t1', 't3'], ['py-9.15'], 2, ['exact'], true]);
  assert.equal(o.results, require('node:path').resolve('r'));
  assert.throws(() => parseArgs(['--suites', 'nope']), /unknown suite/);
  assert.throws(() => parseArgs(['--runs', 'py-8']), /unknown run/);
  assert.throws(() => parseArgs(['--repeats', '0']), /positive integer/);
  assert.throws(() => parseArgs(['--repeats']), /needs a value/);
  assert.throws(() => parseArgs(['--bogus', '1']), /unknown option/);
});

test('command pins latency suites but not concurrency ones, and selects the addon and mode', () => {
  const node914 = RUNS.find((r) => r.label === 'node-9.14-removevalues');
  const c = command(node914, 't1', 'exact', 3, '0');
  assert.equal(c.cmd, 'taskset');
  assert.deepEqual(c.args.slice(0, 2), ['-c', '0']);
  assert.equal(c.args.at(-1), 'removevalues');
  assert.equal(c.env.ORTOOLS_NODE_ADDON, ADDON['9.14']);
  const t4 = command(RUNS.find((r) => r.label === 'py-9.15'), 't4', 'spike', 3, '0');
  assert.equal(command(RUNS.find((r) => r.label === 'py-9.15'), 't4', 'exact', 3, '0').cmd, 'taskset');
  assert.notEqual(t4.cmd, 'taskset');
  assert.deepEqual(t4.args.slice(0, 2), ['-I', '-B']);
  assert.equal(command(RUNS.find((r) => r.label === 'node-9.15-span'), 't1', 'exact', 3, '0').env.ORTOOLS_NODE_ADDON,
    process.env.ORTOOLS_NODE_ADDON);
});

test('pyRound rounds halves to even like Python 3', () => {
  assert.deepEqual([0.5, 1.5, 2.5, -0.5, -1.5, 2.4999, 2.5001, 3].map(caby.pyRound), [0, 2, 2, 0, -2, 2, 3, 3]);
});

test('tt is the Manhattan travel time in whole seconds at 25 km/h', () => {
  assert.equal(caby.tt([0, 0], [1, 0]), 144);
  assert.equal(caby.tt([0, 0], [0.0025, 0.0025]), 1); // 0.72 s
  assert.equal(caby.tt([0, 0], [0.001, 0.001]), 0); // 0.288 s
  assert.equal(caby.tt([1, 1], [1, 1]), 0);
});

test('loadBus resolves the plan to rider objects; checkRoute flags seats and precedence', () => {
  const rider = (rid, pick, drop) => ({
    rid, pick, drop, seats: 1, gender: 'M', direct: 300, boarded_at: null, promise_pick: null, promise_drop: null,
  });
  const w = rider('b0w0', [0, 0], [1, 0]);
  const bus = caby.loadBus({ bid: 0, pos: [0, 0], seats: 0, aboard: [], waiting: [w], plan: [['b0w0', 'P'], ['b0w0', 'D']], base_end: 0 });
  assert.equal(bus.plan[0][0], w);
  assert.deepEqual(caby.checkRoute(bus, bus.plan), ['seats@b0w0P']);
  const reversed = { ...bus, seats: 1 };
  assert.deepEqual(caby.checkRoute(reversed, [[w, 'D'], [w, 'P']]), ['precedence b0w0']);
  assert.deepEqual(caby.checkRoute(reversed, []), ['unserved b0w0']);
});

test('checkRun names the missing interpreter or addon and its override', () => {
  const run = (label) => RUNS.find((r) => r.label === label);
  const none = () => false, all = () => true;
  assert.throws(() => checkRun(run('py-9.14'), { exists: none }), /py-9\.14: .* does not exist \(set DISPATCH_PY_914/);
  assert.throws(() => checkRun(run('py-9.15'), { exists: none }), /set DISPATCH_PY_915/);
  assert.throws(() => checkRun(run('node-9.14-span'), { exists: none }), /set DISPATCH_ADDON_914/);
  assert.doesNotThrow(() => checkRun(run('node-9.15-span'), { exists: none }), 'the 9.15 runs use the default addon');
  for (const r of RUNS) assert.doesNotThrow(() => checkRun(r, { exists: all }));
});

test('caby_model.solve() on one bus and one newcomer returns the exact route, objective and assignment', async () => {
  const bus = caby.loadBus({ bid: 0, pos: [0, 0], seats: 4, aboard: [], waiting: [], plan: [], base_end: 0 });
  const n0 = {
    rid: 'n0', pick: [1, 0], drop: [2, 0], seats: 1, gender: 'F', direct: 144, boarded_at: null, promise_pick: null, promise_drop: null,
  };
  for (const mode of ['span', 'removevalues']) {
    const res = await caby.solve([bus], [n0], { timeLimitMs: 0, mode });
    // start -> pickup 144 s, pickup -> drop 144 s + 30 s service, drop -> end 30 s service.
    assert.deepEqual(caby.signature(res), { status: 'ROUTING_SUCCESS', objective: 348, routes: '0:n0P,n0D', assigned: { n0: 0 } }, mode);
    assert.deepEqual(caby.verify([bus], [n0], res), [], mode);
  }
});

test('bench.js as the entry point writes its report and exits 1 when the gate fails (require-cycle regression)', () => {
  const { execFileSync } = require('node:child_process');
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-bench-'));
  try {
    // t5 has no exact flavour: nothing runs, so this needs no fixtures, Python or OR-Tools.
    // An empty results directory compares nothing, so the gate fails.
    assert.throws(() => execFileSync(process.execPath, [require.resolve('../bench/dispatch/bench'), '--flavors', 'exact',
      '--suites', 't5', '--results', dir], { stdio: 'pipe' }), (err) => {
      assert.equal(err.status, 1);
      assert.match(String(err.stderr), /parity gate: FAIL\n {2}.*not run/);
      return true;
    });
    assert.match(fs.readFileSync(path.join(dir, 'RESULTS.md'), 'utf8'), /^# caby-dispatch spikes[\s\S]*\*\*Gate: FAIL\*\*/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
