'use strict';
// The dispatch report's parity gate (bench/dispatch/report.js): what passes, and each kind of failure.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { analyse } = require('../bench/dispatch/report');
const { RUNS, SPIKE_RUNS, SPIKE_SUITES, EXACT_SUITES } = require('../bench/dispatch/lib/matrix');

const sig = (objective) => ({ status: 'ROUTING_SUCCESS', objective, routes: '0:n0P,n0D', assigned: { n0: 0 } });
const exactResult = (cases = [{ workload: 'w', id: '0', sig: sig(1), guard_hit: false }]) => (
  { flavor: 'exact', cases, timings: {}, unstable: [], guard_hits: {}, repeats: 1 });
const spikeResult = (cases = [{ id: 'g/0', sig: sig(1) }]) => ({ flavor: 'spike', cases, metrics: {} });

/** Every run with every suite it has in the benchmark, all agreeing: the gate's passing input. */
function complete() {
  const results = {};
  for (const run of RUNS) {
    const r = (results[run.label] = {});
    for (const s of EXACT_SUITES) r[`${s}-exact`] = exactResult();
    if (SPIKE_RUNS.has(run.label)) for (const s of SPIKE_SUITES) r[`${s}-spike`] = spikeResult();
  }
  return results;
}

test('the gate passes when every comparison has identical cases', () => {
  const { markdown, failures } = analyse(complete(), []);
  assert.deepEqual(failures, []);
  assert.match(markdown, /\*\*Gate: PASS\.\*\*/);
  assert.match(markdown, /Exact flavour: no differences/);
});

test('the gate fails on empty input: nothing was compared', () => {
  const { markdown, failures } = analyse({}, []);
  assert.ok(failures.includes('no exact-flavour case was compared'));
  assert.ok(failures.some((f) => /^9\.14 t1: not run \(py-9\.14, node-9\.14-span\)$/.test(f)), failures.join('\n'));
  assert.match(markdown, /\*\*Gate: FAIL\*\*/);
  assert.doesNotMatch(markdown, /no differences/);
});

test('an exact case that differs fails the gate, for the Python pair and the modes pair', () => {
  const r = complete();
  r['node-9.14-span']['t1-exact'] = exactResult([{ workload: 'w', id: '0', sig: sig(2), guard_hit: false }]);
  const { markdown, failures } = analyse(r, []);
  assert.deepEqual(failures, ['9.14 t1 / w: 1 differ', '9.14 modes t1 / w: 1 differ']);
  assert.match(markdown, /0\/1 \(\*\*1 differ\*\*\)/);
  assert.doesNotMatch(markdown, /Exact flavour: no differences/);
});

test('a case only one side recorded fails the gate as missing', () => {
  const r = complete();
  r['py-9.15']['t2a-exact'] = exactResult([
    { workload: 'w', id: '0', sig: sig(1), guard_hit: false }, { workload: 'w', id: '1', sig: sig(1), guard_hit: false }]);
  assert.deepEqual(analyse(r, []).failures, ['9.15 t2a / w: 1 missing']);
});

test('an unstable case (a timed pass that changed its signature) fails the gate', () => {
  const r = complete();
  r['node-9.15-span']['t3-exact'] = { ...exactResult(), unstable: ['w/0'] };
  assert.deepEqual(analyse(r, []).failures, ['9.15 modes t3 / w: 1 unstable']);
});

test('a suite one run lacks fails the gate as not run', () => {
  const r = complete();
  delete r['node-9.14-removevalues']['cpsat-exact'];
  assert.deepEqual(analyse(r, []).failures, ['9.14 modes cpsat: not run (node-9.14-removevalues)']);
});

test('a workload one side of a comparison lacks fails the gate as not run', () => {
  const r = complete();
  const withV = exactResult([...exactResult().cases, { workload: 'v', id: '0', sig: sig(1), guard_hit: false }]);
  for (const run of ['py-9.14', 'node-9.14-span', 'node-9.14-removevalues']) r[run]['t4-exact'] = withV;
  assert.deepEqual(analyse(r, []).failures, ['9.15 t4 / v: not run', '9.15 modes t4 / v: not run']);
});

test('a suite whose runs recorded no cases fails the gate', () => {
  const r = complete();
  for (const run of RUNS) r[run.label]['t6-exact'] = exactResult([]);
  assert.deepEqual(analyse(r, []).failures,
    ['9.14 t6: no cases recorded', '9.15 t6: no cases recorded', '9.14 modes t6: no cases recorded', '9.15 modes t6: no cases recorded']);
});

test('a time-limited difference fails the gate until findings.json analyses it', () => {
  const r = complete();
  r['node-9.15-removevalues']['t2d-spike'] = spikeResult([{ id: 'g/0', sig: sig(20000001) }]);
  const open = analyse(r, []);
  assert.deepEqual(open.failures, ['9.15 t2d / g (spike): difference not analysed in findings.json']);
  assert.match(open.markdown, /\*\*Not yet analysed\.\*\*/);
  assert.match(open.markdown, /Python status ROUTING_SUCCESS, objective 1; Node status ROUTING_SUCCESS, objective 20000001/);
  const finding = { flavor: 'spike', suite: 't2d', workload: 'g', verdict: 'Time limit', analysis: 'Explained.' };
  const done = analyse(r, [finding]);
  assert.deepEqual(done.failures, []);
  assert.match(done.markdown, /\*\*Time limit\.\*\* Explained\./);
  assert.match(done.markdown, /Spike flavour: 1 per-case difference/);
});

test('a missing time-limited run fails the gate', () => {
  const r = complete();
  delete r['py-9.14']['t5-spike'];
  assert.deepEqual(analyse(r, []).failures, ['9.14 t5 spike: not run (py-9.14)']);
});
