'use strict';
// Fixture loading and the exact-flavour recorder shared by the Node suites (mirror of run_py.py's).

const fs = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { loadBus } = require('./caby_model');

const DEFAULT_FIXTURES = path.join(__dirname, '..', 'fixtures');

function loadFixture(dir, name) {
  return JSON.parse(fs.readFileSync(path.join(dir, `${name}.json`), 'utf8'));
}

/** A fixture case {buses, newcomers} as [buses, newcomers]. */
const instance = (c) => [c.buses.map(loadBus), c.newcomers];

const msSince = (t0) => performance.now() - t0;

/** Deep equality of JSON-shaped values (signatures). */
function sameJson(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * One untimed pass that records signatures, then `repeats` timed passes checked against it.
 * GUIDED_LOCAL_SEARCH with only a solution limit never stops on instances where it runs out of new
 * solutions, so those solves also get a guard time limit `guardMs`; a solve that reaches it is a
 * guard hit, left out of the latency figures.
 */
class Exact {
  constructor(repeats) {
    this.repeats = repeats;
    this.rep = 0;
    this.cases = [];
    this.timings = {};
    this.guardHits = {};
    this.unstable = new Set();
    this.first = new Map();
  }

  *passes() {
    for (this.rep = 0; this.rep <= this.repeats; this.rep++) yield this.rep;
  }

  record(workload, id, sig, ms, guardMs = 0) {
    const hit = Boolean(guardMs) && ms[1] >= 0.95 * guardMs;
    const key = `${workload}/${id}`;
    if (this.rep === 0) {
      this.cases.push({ workload, id, sig, guard_hit: hit });
      this.first.set(key, sig);
      return;
    }
    if (!sameJson(this.first.get(key), sig)) this.unstable.add(key);
    if (hit) this.guardHits[workload] = (this.guardHits[workload] || 0) + 1;
    else (this.timings[workload] ||= []).push(ms);
  }

  result() {
    return { cases: this.cases, timings: this.timings, unstable: [...this.unstable].sort(), guard_hits: this.guardHits };
  }
}

/** [build, solve, read] ms of a caby solve() result. */
const phaseMs = (res) => [res.buildMs, res.solveMs, res.readMs];

module.exports = { DEFAULT_FIXTURES, loadFixture, instance, msSince, sameJson, Exact, phaseMs };
