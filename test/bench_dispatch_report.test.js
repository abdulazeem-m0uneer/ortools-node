'use strict';
// The dispatch report's parity gate (bench/dispatch/report.js): what passes, and each kind of failure.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { analyse } = require('../bench/dispatch/report');
const { RUNS, SPIKE_RUNS, SPIKE_SUITES, EXACT_SUITES, METRICS_ONLY } = require('../bench/dispatch/lib/matrix');

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

test('a spike suite with per-case results fails the gate when it recorded no cases; a metrics-only one does not', () => {
  const r = complete();
  for (const run of SPIKE_RUNS) r[run]['t1-spike'] = spikeResult([]);
  assert.deepEqual(analyse(r, []).failures, ['9.14 t1 spike: no cases recorded', '9.15 t1 spike: no cases recorded']);
  const m = complete();
  for (const run of SPIKE_RUNS) for (const s of METRICS_ONLY) m[run][`${s}-spike`] = spikeResult([]);
  assert.deepEqual(analyse(m, []).failures, []);
});

const finding = (over = {}) => ({
  flavor: 'spike', suite: 't2d', workload: 'g', pins: ['9.15'], ids: ['g/0'], verdict: 'Time limit', analysis: 'Explained.', ...over,
});

/** complete() with the given spike case ids of node-9.15-removevalues t2d differing from Python's. */
function withSpikeDiffs(...diffIds) {
  const r = complete();
  const ids = ['g/0', 'g/1'];
  r['py-9.15']['t2d-spike'] = spikeResult(ids.map((id) => ({ id, sig: sig(1) })));
  r['node-9.15-removevalues']['t2d-spike'] = spikeResult(ids.map((id) => ({ id, sig: sig(diffIds.includes(id) ? 20000001 : 1) })));
  return r;
}

test('a time-limited difference fails the gate until a finding lists its pin, workload and case id', () => {
  const r = withSpikeDiffs('g/0');
  const open = analyse(r, []);
  assert.deepEqual(open.failures, ['9.15 t2d / g/0 (spike): difference not analysed in findings.json']);
  assert.match(open.markdown, /\*\*Not yet analysed:\*\* `g\/0`\./);
  assert.match(open.markdown, /Python status ROUTING_SUCCESS, objective 1; Node status ROUTING_SUCCESS, objective 20000001/);
  const done = analyse(r, [finding()]);
  assert.deepEqual(done.failures, []);
  assert.match(done.markdown, /\*\*Time limit\.\*\* Explained\./);
  assert.match(done.markdown, /Spike flavour: 1 per-case difference/);
});

test('a difference outside a finding\'s ids, pins or workload is not explained by it', () => {
  assert.deepEqual(analyse(withSpikeDiffs('g/0', 'g/1'), [finding()]).failures,
    ['9.15 t2d / g/1 (spike): difference not analysed in findings.json']);
  assert.deepEqual(analyse(withSpikeDiffs('g/0'), [finding({ pins: ['9.14'] })]).failures, [
    '9.15 t2d / g/0 (spike): difference not analysed in findings.json',
    'stale finding: 9.14 t2d / g `g/0` no longer differs']);
  assert.deepEqual(analyse(withSpikeDiffs('g/0'), [finding({ workload: 'other', ids: ['other/0'] })]).failures, [
    '9.15 t2d / g/0 (spike): difference not analysed in findings.json',
    'stale finding: 9.15 t2d / other `other/0` no longer differs']);
});

test('a finding whose case no longer differs fails the gate as stale', () => {
  assert.deepEqual(analyse(withSpikeDiffs(), [finding()]).failures, ['stale finding: 9.15 t2d / g `g/0` no longer differs']);
  assert.deepEqual(analyse(withSpikeDiffs('g/0'), [finding({ ids: ['g/0', 'g/1'] })]).failures,
    ['stale finding: 9.15 t2d / g `g/1` no longer differs']);
});

test('an always finding never explains a time-limited difference, whatever suite it names', () => {
  const always = { flavor: 'spike', always: true, suite: 't2d', title: 'broad note', text: 'x' };
  assert.deepEqual(analyse(withSpikeDiffs('g/0'), [always]).failures,
    ['9.15 t2d / g/0 (spike): difference not analysed in findings.json']);
});

test('a spike finding without pins, workload or ids fails the gate', () => {
  for (const over of [{ pins: undefined }, { pins: [] }, { workload: undefined }, { ids: undefined }, { ids: [] }]) {
    const { failures } = analyse(withSpikeDiffs('g/0'), [finding(over)]);
    assert.ok(failures.some((x) => / needs pins, workload and ids$/.test(x)), `${JSON.stringify(over)}: ${failures.join('; ')}`);
  }
});

test('a missing time-limited run fails the gate', () => {
  const r = complete();
  delete r['py-9.14']['t5-spike'];
  assert.deepEqual(analyse(r, []).failures, ['9.14 t5 spike: not run (py-9.14)']);
});
