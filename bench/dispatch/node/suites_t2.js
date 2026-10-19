'use strict';
// t1_rules_single_bus.py and t2_live_latency.py, ported line for line (mirror of run_py.py's t1 / t2 suites).

const { performance } = require('node:perf_hooks');
const { ALL_RULES, without, busGender, loadBus, solve, verify, signature } = require('./caby_model');
const { SimpleMinCostFlow, SimpleLinearSumAssignment } = require('./ortools');
const { instance, msSince, phaseMs } = require('./common');

const sig = signature;

// ---------------------------------------------------------------- t1: rules on one bus
const t1Cases = (fx) => fx.cases.map((c) => [loadBus(c.bus), c.newcomer]);

async function spikeT1(fx, mode) {
  const cases = t1Cases(fx);
  const out = { tries: fx.tries }, recs = [];
  let fails = 0;
  const run = async (i, rules, tag) => {
    const [b, nc] = cases[i];
    const res = await solve([b], [nc], { rules, timeLimitMs: 200, warm: true, mode });
    if (!res.routes.size) fails += 1;
    const viol = verify([b], [nc], res, rules);
    recs.push({ id: `${tag}/${i}`, sig: sig(res), ms: phaseMs(res) });
    return [res, viol];
  };
  for (const R of fx.rules) {
    let refusedAll = 0, acceptedWithout = 0, viol = 0;
    for (const i of fx.binding[R]) {
      const [res, v] = await run(i, ALL_RULES, `${R}:all`);
      refusedAll += res.assigned.new === null;
      viol += v.length > 0;
      const [res2, v2] = await run(i, without(ALL_RULES, R), `${R}:without`);
      acceptedWithout += res2.assigned.new !== null;
      viol += v2.length > 0;
    }
    out[R] = { cases: fx.binding[R].length, refused_with_rule: refusedAll, accepted_without_rule: acceptedWithout, violations: viol };
  }
  let fa = 0, fr = 0, viol = 0;
  for (const i of fx.accepts) {
    const [res, v] = await run(i, ALL_RULES, 'accept');
    viol += v.length > 0; fr += res.assigned.new === null;
  }
  for (const i of fx.refusals) {
    const [res, v] = await run(i, ALL_RULES, 'refusal');
    viol += v.length > 0; fa += res.assigned.new !== null;
  }
  out.oracle_feasible = { cases: fx.accepts.length, false_refusals: fr };
  out.oracle_infeasible = { cases: fx.refusals.length, false_accepts: fa };
  out.violations_in_any_returned_plan = viol;
  out.no_solution_at_all = fails;
  return { metrics: out, cases: recs };
}

async function exactT1(fx, ex, mode) {
  const cases = t1Cases(fx);
  const ids = [];
  for (const R of fx.rules) {
    for (const i of fx.binding[R]) {
      ids.push([`${R}:all`, i, ALL_RULES], [`${R}:without`, i, without(ALL_RULES, R)]);
    }
  }
  for (const i of fx.accepts) ids.push(['accept', i, ALL_RULES]);
  for (const i of fx.refusals.slice(0, 300)) ids.push(['refusal', i, ALL_RULES]);
  for (const _ of ex.passes()) {
    for (const [tag, i, rules] of ids) {
      const [b, nc] = cases[i];
      const res = await solve([b], [nc], { rules, timeLimitMs: 0, warm: true, mode });
      ex.record('t1 one bus, GD', `${tag}/${i}`, sig(res), phaseMs(res));
    }
  }
}

// ---------------------------------------------------------------- t2 A: one bus, 12 stops + newcomer
const T2A_MODES = {
  'warm+GD(tl1000)': { warm: true, ls: 'GREEDY_DESCENT', timeLimitMs: 1000 },
  'warm+GLS(tl100)': { warm: true, ls: 'GUIDED_LOCAL_SEARCH', timeLimitMs: 100 },
  'warm+GLS(tl300)': { warm: true, ls: 'GUIDED_LOCAL_SEARCH', timeLimitMs: 300 },
  'cold PCA+GD(tl1000)': { warm: false, first: 'PATH_CHEAPEST_ARC', ls: 'GREEDY_DESCENT', timeLimitMs: 1000 },
  'warm+GD python-callback': { warm: true, ls: 'GREEDY_DESCENT', timeLimitMs: 1000, useCallback: true },
};
const T2A_EXACT = {
  't2a one bus 12 stops, warm GD': { warm: true, ls: 'GREEDY_DESCENT', timeLimitMs: 0 },
  't2a one bus 12 stops, warm GLS sl=100': { warm: true, ls: 'GUIDED_LOCAL_SEARCH', timeLimitMs: 1000, solutionLimit: 100 },
  't2a one bus 12 stops, warm GD, transit callback': { warm: true, ls: 'GREEDY_DESCENT', timeLimitMs: 0, useCallback: true },
};

const t2aCases = (fx) => fx.cases.map((c) => [loadBus(c.bus), c.newcomer]);

async function spikeT2a(fx, mode) {
  const cases = t2aCases(fx), A = {}, recs = [];
  for (const [name, kw] of Object.entries(T2A_MODES)) {
    const ms = [];
    let acc = 0, viol = 0, nosol = 0;
    for (const [i, [b, nc]] of cases.entries()) {
      const res = await solve([b], [nc], { ...kw, mode });
      ms.push(res.seconds * 1000);
      acc += res.assigned.new !== null;
      nosol += !res.routes.size;
      viol += res.routes.size ? verify([b], [nc], res).length > 0 : 0;
      recs.push({ id: `${name}/${i}`, sig: sig(res), ms: phaseMs(res) });
    }
    A[name] = { ms, accepted: acc, violations: viol, no_solution: nosol };
  }
  return { metrics: A, cases: recs };
}

async function exactT2a(fx, ex, mode) {
  const cases = t2aCases(fx);
  for (const _ of ex.passes()) {
    for (const [name, kw] of Object.entries(T2A_EXACT)) {
      for (const [i, [b, nc]] of cases.entries()) {
        const res = await solve([b], [nc], { ...kw, mode });
        ex.record(name, String(i), sig(res), phaseMs(res), kw.timeLimitMs);
      }
    }
  }
}

// ---------------------------------------------------------------- t2 B: 20 candidate buses
async function spikeT2b(fx, mode) {
  const loop = [], one = [], recs = [];
  let accLoop = 0, accOne = 0, viol = 0;
  for (const [k, c] of fx.cases.entries()) {
    const [buses, [nc]] = instance(c);
    const t0 = performance.now();
    let best = null;
    for (const b of buses) {
      if (![null, nc.gender].includes(busGender(b))) continue;
      const r = await solve([b], [nc], { warm: true, timeLimitMs: 1000, mode });
      if (r.assigned.new !== null) {
        viol += verify([b], [nc], r).length > 0;
        const cost = Number(r.objective);
        if (best === null || cost < best[0]) best = [cost, b.bid];
      }
    }
    loop.push(msSince(t0));
    const r = await solve(buses, [nc], { warm: true, timeLimitMs: 1000, mode });
    one.push(r.seconds * 1000);
    viol += verify(buses, [nc], r).length > 0;
    accLoop += best !== null; accOne += r.assigned.new !== null;
    recs.push({ id: `one_model/${k}`, sig: sig(r), ms: phaseMs(r) });
    recs.push({ id: `loop20/${k}`, sig: { best } });
  }
  return {
    metrics: {
      loop20_single: { ms: loop, accepted: accLoop }, one_model_20: { ms: one, accepted: accOne },
      violations: viol, n: fx.cases.length,
    },
    cases: recs,
  };
}

async function exactT2b(fx, ex, mode) {
  const cases = fx.cases.map(instance);
  for (const _ of ex.passes()) {
    for (const [k, [buses, ncs]] of cases.entries()) {
      const r = await solve(buses, ncs, { warm: true, timeLimitMs: 5000, ls: 'GUIDED_LOCAL_SEARCH', solutionLimit: 50, mode });
      ex.record('t2b 20 buses one model, warm GLS sl=50', String(k), sig(r), phaseMs(r), 5000);
    }
  }
}

// ---------------------------------------------------------------- t2 C: gender + stay in multi-bus models
async function spikeT2c(fx, mode) {
  const C = {}, recs = [];
  for (const rule of ['gender', 'stay']) {
    let onV = 0, offV = 0, n = 0;
    for (const [k, c] of fx.cases.filter((x) => x.rule === rule).entries()) {
      const [buses, ncs] = instance(c);
      const rOn = await solve(buses, ncs, { warm: true, timeLimitMs: 300, ls: 'GUIDED_LOCAL_SEARCH', mode });
      const rOff = await solve(buses, ncs, { rules: without(ALL_RULES, rule), warm: true, timeLimitMs: 300, ls: 'GUIDED_LOCAL_SEARCH', mode });
      const key = rule === 'gender' ? 'gender' : 'moved';
      onV += verify(buses, ncs, rOn).filter((x) => x.includes(key)).length;
      offV += verify(buses, ncs, rOff, ALL_RULES).filter((x) => x.includes(key)).length;
      n += 1;
      recs.push({ id: `${rule}:on/${k}`, sig: sig(rOn), ms: phaseMs(rOn) });
      recs.push({ id: `${rule}:off/${k}`, sig: sig(rOff) });
    }
    C[rule] = { instances: n, violations_rule_on: onV, violations_rule_off: offV };
  }
  const [empty, [m, f]] = instance(fx.empty);
  const r = await solve(empty, [m, f], { warm: true, timeLimitMs: 300, mode });
  const r2 = await solve(empty, [m, f], { warm: true, timeLimitMs: 300, genderTypes: false, mode });
  C.empty_bus_mixed_newcomers = { with_type_incompat: r.assigned, without: r2.assigned };
  return { metrics: C, cases: recs };
}

async function exactT2c(fx, ex, mode) {
  const cases = fx.cases.map((c) => [c.rule, instance(c)]);
  const [empty, ncs0] = instance(fx.empty);
  for (const _ of ex.passes()) {
    for (const [k, [rule, [buses, ncs]]] of cases.entries()) {
      for (const [tag, rules] of [['on', ALL_RULES], ['off', without(ALL_RULES, rule)]]) {
        const r = await solve(buses, ncs, { rules, warm: true, timeLimitMs: 5000, ls: 'GUIDED_LOCAL_SEARCH', solutionLimit: 50, mode });
        ex.record('t2c 6 buses 3 newcomers, warm GLS sl=50', `${rule}:${tag}/${k}`, sig(r), phaseMs(r), 5000);
      }
    }
    for (const gt of [true, false]) {
      const r = await solve(empty, ncs0, { warm: true, timeLimitMs: 0, genderTypes: gt, mode });
      ex.record('t2c empty bus, mixed newcomers, GD', `gender_types=${gt ? 'True' : 'False'}`, sig(r), phaseMs(r));
    }
  }
}

// ---------------------------------------------------------------- t2 D: batch 50 requests x 200 buses (+ two-stage)
const UNMATCHED = 100_000;

const t2dInstance = (fx) => [fx.buses.map(loadBus), fx.newcomers, fx.allowed];

async function pairCosts(buses, ncs, allowed, kw) {
  const pairs = new Map();
  for (const nc of ncs) {
    for (const i of allowed[nc.rid]) {
      const b = buses[i];
      const base = Number((await solve([b], [], { warm: true, ...kw })).objective);
      const r = await solve([b], [nc], { warm: true, ...kw });
      if (r.assigned[nc.rid] !== null) pairs.set(`${nc.rid}|${i}`, Number(r.objective) - base);
    }
  }
  return pairs;
}

const pairEntries = (pairs) => [...pairs].map(([key, cost]) => {
  const [rid, i] = key.split('|');
  return [rid, Number(i), cost];
});

function mcfMatch(pairs, ncs, buses) {
  const smcf = new SimpleMinCostFlow();
  const R = ncs.length, NB = buses.length, src = R + NB, sink = R + NB + 1;
  const ridIx = new Map(ncs.map((nc, j) => [nc.rid, j]));
  const s = [], e = [], c = [], w = [];
  for (let j = 0; j < R; j++) { s.push(src); e.push(j); c.push(1); w.push(0); }
  for (const [rid, i, cost] of pairEntries(pairs)) { s.push(ridIx.get(rid)); e.push(R + i); c.push(1); w.push(cost); }
  for (let j = 0; j < R; j++) { s.push(j); e.push(sink); c.push(1); w.push(UNMATCHED); }
  for (let i = 0; i < NB; i++) { s.push(R + i); e.push(sink); c.push(1); w.push(0); }
  smcf.addArcsWithCapacityAndUnitCost(s, e, c, w);
  const sup = new Array(R + NB + 2).fill(0); sup[src] = R; sup[sink] = -R;
  smcf.setNodesSupplies([...sup.keys()], sup);
  const st = smcf.solveSync();
  let matched = 0;
  for (let a = 0; a < smcf.numArcs(); a++) if (smcf.flow(a) && R <= smcf.head(a) && smcf.head(a) < R + NB) matched += 1;
  const out = [st, matched, smcf.optimalCost()];
  smcf.dispose();
  return out;
}

function lsaMatch(pairs, ncs, buses) {
  const R = ncs.length, NB = buses.length;
  const ridIx = new Map(ncs.map((nc, j) => [nc.rid, j]));
  const lsa = new SimpleLinearSumAssignment();
  for (const [rid, i, cost] of pairEntries(pairs)) lsa.addArcWithCost(ridIx.get(rid), i, cost);
  for (let j = 0; j < R; j++) lsa.addArcWithCost(j, NB + j, UNMATCHED);
  for (let i = 0; i < NB; i++) {
    lsa.addArcWithCost(R + i, i, 0);
    for (let j = 0; j < R; j++) lsa.addArcWithCost(R + i, NB + j, 0);
  }
  const st = lsa.solveSync();
  let matched = 0;
  for (let j = 0; j < R; j++) if (lsa.rightMate(j) < NB) matched += 1;
  const out = [st, matched, lsa.optimalCost()];
  lsa.dispose();
  return out;
}

function denseLsa(costs) {
  const lsa = new SimpleLinearSumAssignment();
  for (let j = 0; j < 50; j++) {
    for (let i = 0; i < 200; i++) lsa.addArcWithCost(j, i, costs[j][i]);
    lsa.addArcWithCost(j, 200 + j, UNMATCHED);
  }
  for (let i = 0; i < 200; i++) {
    lsa.addArcWithCost(50 + i, i, 0);
    for (let j = 0; j < 50; j++) lsa.addArcWithCost(50 + i, 200 + j, 0);
  }
  const st = lsa.solveSync();
  const out = [st, lsa.optimalCost()];
  lsa.dispose();
  return out;
}

/** Python sorts [rid, i, cost] lists; the same order here. */
function pairsJson(pairs) {
  return pairEntries(pairs).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] - b[1] || a[2] - b[2]));
}

const round = (x, d = 0) => Math.round(x * 10 ** d) / 10 ** d;

async function spikeT2d(fx, mode) {
  const [buses, ncs, allowed] = t2dInstance(fx);
  const D = {}, recs = [];
  for (const tl of [1000, 3000]) {
    const r = await solve(buses, ncs, { allowed, warm: true, timeLimitMs: tl, ls: 'GUIDED_LOCAL_SEARCH', mode });
    D[`routing_one_model_tl${tl}`] = {
      ms: round(r.seconds * 1000), matched: Object.values(r.assigned).filter((v) => v !== null).length,
      violations: verify(buses, ncs, r).length, status: r.status,
    };
    recs.push({ id: `one_model_tl${tl}`, sig: sig(r), ms: phaseMs(r) });
  }
  let t0 = performance.now();
  const pairs = await pairCosts(buses, ncs, allowed, { timeLimitMs: 200, mode });
  const tPairs = msSince(t0);
  t0 = performance.now(); const mcf = mcfMatch(pairs, ncs, buses); const tMcf = msSince(t0);
  t0 = performance.now(); const lsa = lsaMatch(pairs, ncs, buses); const tLsa = msSince(t0);
  D.two_stage = {
    pair_solves: ncs.length * fx.K * 2, feasible_pairs: pairs.size, pair_ms: round(tPairs),
    mcf: { status: mcf[0], matched: mcf[1], cost: mcf[2], ms: round(tMcf, 2) },
    lsa: { status: lsa[0], matched: lsa[1], cost: lsa[2], ms: round(tLsa, 2) },
  };
  recs.push({ id: 'pairs', sig: { pairs: pairsJson(pairs) } });
  t0 = performance.now(); const st3 = denseLsa(fx.dense_lsa_costs);
  D.dense_lsa_50x200_ms = round(msSince(t0), 2); D.dense_lsa_status = st3[0]; D.dense_lsa_cost = st3[1];
  return { metrics: D, cases: recs };
}

async function exactT2d(fx, ex, mode) {
  const [buses, ncs, allowed] = t2dInstance(fx);
  for (const _ of ex.passes()) {
    if (ex.rep <= 1) { // 3 s per solve: one signature pass + one timed pass
      const r = await solve(buses, ncs, { allowed, warm: true, timeLimitMs: 60000, ls: 'GUIDED_LOCAL_SEARCH', solutionLimit: 30, mode });
      ex.record('t2d 200 buses x 50 newcomers, warm GLS sl=30', 'one_model', sig(r), phaseMs(r), 60000);
    }
    let t0 = performance.now();
    const pairs = await pairCosts(buses, ncs, allowed, { timeLimitMs: 0, mode });
    ex.record('t2d two-stage: 600 single-bus GD solves', 'pairs', { pairs: pairsJson(pairs) }, [msSince(t0), 0, 0]);
    t0 = performance.now(); const mcf = mcfMatch(pairs, ncs, buses);
    ex.record('t2d two-stage: min cost flow', 'mcf', mcf, [msSince(t0), 0, 0]);
    t0 = performance.now(); const lsa = lsaMatch(pairs, ncs, buses);
    ex.record('t2d two-stage: linear sum assignment', 'lsa', lsa, [msSince(t0), 0, 0]);
    t0 = performance.now(); const d = denseLsa(fx.dense_lsa_costs);
    ex.record('t2d dense LSA 250x250', 'dense', d, [msSince(t0), 0, 0]);
  }
}

// ---------------------------------------------------------------- t2 E: determinism
const T2E_MODES = {
  'GD tl5000': { ls: 'GREEDY_DESCENT', timeLimitMs: 5000 },
  'GLS tl300': { ls: 'GUIDED_LOCAL_SEARCH', timeLimitMs: 300 },
  'GLS solution_limit=200': { ls: 'GUIDED_LOCAL_SEARCH', timeLimitMs: 0, solutionLimit: 200 },
};

async function spikeT2e(fx, mode) {
  const [buses, ncs] = instance(fx);
  const E = {}, recs = [];
  for (const [name, kw] of Object.entries(T2E_MODES)) {
    const sigs = new Set(), objs = new Set();
    for (let run = 0; run < 8; run++) {
      const r = await solve(buses, ncs, { warm: true, ...kw, mode });
      const s = sig(r);
      sigs.add(s.routes);
      objs.add(s.objective);
      recs.push({ id: `${name}/${run}`, sig: s, ms: phaseMs(r) });
    }
    E[name] = { runs: 8, distinct_plans: sigs.size, distinct_objectives: [...objs].sort((a, b) => a - b) };
  }
  return { metrics: E, cases: recs };
}

// ---------------------------------------------------------------- t2 F: event loop / threadpool
/** Iterations per second of a setImmediate loop (Python: a spinning thread). */
function spinRate(ms) {
  return new Promise((resolve) => {
    let ticks = 0;
    const t0 = performance.now();
    const spin = () => {
      ticks += 1;
      if (performance.now() - t0 < ms) setImmediate(spin);
      else resolve(ticks / ((performance.now() - t0) / 1000));
    };
    setImmediate(spin);
  });
}

/** Event-loop progress while `fn` runs, as a percentage of the idle rate. */
async function progressDuring(fn) {
  const idleRate = await spinRate(500);
  let ticks = 0, stop = false;
  const spin = () => { ticks += 1; if (!stop) setImmediate(spin); };
  const ts = performance.now();
  setImmediate(spin);
  await fn();
  stop = true;
  const rate = ticks / ((performance.now() - ts) / 1000);
  return Math.round(1000 * rate / idleRate) / 10;
}

/** Runs jobs with at most n in flight; resolves to their results. */
async function pool(n, jobs) {
  const out = new Array(jobs.length);
  let next = 0;
  const worker = async () => { while (next < jobs.length) { const i = next++; out[i] = await jobs[i](); } };
  await Promise.all(Array.from({ length: n }, worker));
  return out;
}

async function spikeT2f(fx, mode) {
  const [buses, ncs] = instance(fx);
  const F = {};
  for (const cb of [false, true]) {
    const pct = await progressDuring(() => solve(buses, ncs, { warm: true, timeLimitMs: 1000, ls: 'GUIDED_LOCAL_SEARCH', useCallback: cb, mode }));
    F[`callback=${cb ? 'True' : 'False'}`] = { other_thread_progress_during_solve_pct: pct };
  }
  const job = () => solve(buses, ncs, { warm: true, timeLimitMs: 500, ls: 'GUIDED_LOCAL_SEARCH', mode });
  for (const n of [1, 4]) {
    const t0 = performance.now();
    await pool(n, Array.from({ length: 8 }, () => job));
    F[`threads=${n} 8 solves of 500ms`] = round(msSince(t0) / 1000, 2);
  }
  return { metrics: F, cases: [] };
}

module.exports = {
  spikeT1, exactT1, spikeT2a, exactT2a, spikeT2b, exactT2b, spikeT2c, exactT2c, spikeT2d, exactT2d, spikeT2e, spikeT2f,
  t2dInstance, progressDuring, pool, round,
};
