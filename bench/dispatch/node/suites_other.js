'use strict';
// t3_monthly.py, t4_gil.py, t5_det.py, t6_rescue_intercity.py and stack/gil_cpsat.py, ported line for
// line (mirror of run_py.py). Python's threads / processes become async solves on the libuv threadpool.

const { performance } = require('node:perf_hooks');
const ortools = require('./ortools');
const { solve, signature, tt, searchParams } = require('./caby_model');
const { build, check, key } = require('./t3_monthly');
const { msSince } = require('./common');
const { t2dInstance, progressDuring, pool, round } = require('./suites_t2');

const { RoutingIndexManager, RoutingModel, SimpleMinCostFlow, CpModel, CpSolver } = ortools;

// ---------------------------------------------------------------- t3: monthly placement
function t3Data(fx) {
  const base = { order: fx.base.order, times: new Map(fx.base.times.map(([a, b, t]) => [key(a, b), t])), obj: fx.base.obj };
  const fixed = Object.fromEntries(base.order.filter((k) => k[1] === 'P').map((k) => [k[0], base.times.get(key(...k))]));
  return [fx.riders, fx.depot, fx.seats, base, fixed, fx.newcomers];
}

function planSig(plan, st) {
  if (plan === null) return { status: st, plan: null };
  return {
    status: st, obj: Number(plan.obj), order: plan.order.map(([a, b]) => a + b).join(','),
    times: plan.order.map((k) => Number(plan.times.get(key(...k)))),
  };
}

const t3Insert = (riders, depot, seats, base, fixed, nc, kw) =>
  build(riders, depot, seats, { fixed, newcomers: [nc], initial: base.order, ...kw });

async function spikeT3(fx) {
  const [riders, depot, SEATS, base, fixed, ncs] = t3Data(fx);
  const recs = [], A = {};
  for (const tl of [200, 1000, 5000]) {
    const [plan, st, secs, ph] = await build(riders, depot, SEATS, { tlMs: tl });
    A[`GLS tl${tl}`] = {
      status: st, ms: Math.round(secs * 1000), obj: plan && Number(plan.obj),
      violations: plan ? check(riders, depot, SEATS, plan).length : null,
    };
    recs.push({ id: `nightly tl${tl}`, sig: planSig(plan, st), ms: ph });
  }
  const sigs = new Map();
  let secs = 0;
  for (let run = 0; run < 3; run++) {
    const [plan, st, s, ph] = await build(riders, depot, SEATS, { tlMs: 0, solutionLimit: 300 });
    secs = s;
    const p = planSig(plan, st);
    sigs.set(`${p.obj}|${p.order}`, p.obj);
    recs.push({ id: `nightly sl300/${run}`, sig: p, ms: ph });
  }
  A['GLS solution_limit=300 x3'] = { distinct: sigs.size, ms: Math.round(secs * 1000), obj: [...sigs.values()] };
  const B = { cases: 0, ortools_accept: 0, oracle_accept: 0, false_refusal: 0, violations: 0, moved_fixed: 0, ms: [] };
  for (const [c, nc] of ncs.entries()) {
    const [plan, st, s, ph] = await t3Insert(riders, depot, SEATS, base, fixed, nc, { tlMs: 500, ls: 'GREEDY_DESCENT' });
    B.ms.push(s * 1000); B.cases += 1;
    const acc = plan !== null && plan.times.has(key('new', 'P'));
    const orc = nc.oracle;
    B.ortools_accept += acc; B.oracle_accept += orc;
    B.false_refusal += orc && !acc;
    if (plan) {
      B.violations += check(riders, depot, SEATS, plan, fixed, [nc]).length > 0;
      B.moved_fixed += Object.entries(fixed).filter(([rid, t]) => Number(plan.times.get(key(rid, 'P'))) !== t).length;
    }
    recs.push({ id: `insert/${c}`, sig: planSig(plan, st), ms: ph });
  }
  return { metrics: { nightly_order_40: A, newcomer_insertion_40: B }, cases: recs };
}

async function exactT3(fx, ex) {
  const [riders, depot, SEATS, base, fixed, ncs] = t3Data(fx);
  for (const _ of ex.passes()) {
    const [plan, st, , ms] = await build(riders, depot, SEATS, { tlMs: 60000, solutionLimit: 50 });
    ex.record('t3 nightly order 40 riders, GLS sl=50', 'nightly', planSig(plan, st), ms, 60000);
    for (const [c, nc] of ncs.entries()) {
      const [p, s, , m] = await t3Insert(riders, depot, SEATS, base, fixed, nc, { tlMs: 0, ls: 'GREEDY_DESCENT' });
      ex.record('t3 newcomer insertion, fixed times, warm GD', String(c), planSig(p, s), m);
    }
  }
}

// ---------------------------------------------------------------- t4: event loop + threadpool (t4_gil.py)
function tsp(fx, seed = 1, { n = 150, tl = 1000, sl = null } = {}) {
  const pts = fx.points[String(seed)].slice(0, n);
  const M = pts.map((a) => pts.map((b) => Math.trunc(Math.abs(a[0] - b[0]) * 100 + Math.abs(a[1] - b[1]) * 100)));
  const m = new RoutingIndexManager(n, 1, 0), r = new RoutingModel(m);
  const t = r.registerTransitMatrix(M); r.setArcCostEvaluatorOfAllVehicles(t);
  const p = searchParams({ first: 'AUTOMATIC', ls: 'GUIDED_LOCAL_SEARCH', timeLimitMs: tl, solutionLimit: sl, log: false });
  r.closeModelWithParameters(p);
  return [r, p];
}

async function job(fx, seed) {
  const [r, p] = tsp(fx, seed);
  const t0 = performance.now();
  await r.solveWithParameters(p);
  r.dispose();
  return msSince(t0) / 1000;
}

async function spikeT4(fx) {
  const out = {};
  const [r, p] = tsp(fx);
  out.event_loop_progress_during_solveWithParameters_pct = await progressDuring(() => r.solveWithParameters(p));
  r.dispose();
  for (const n of [1, 4]) {
    const t0 = performance.now();
    await pool(n, Array.from({ length: 8 }, (_, seed) => () => job(fx, seed)));
    out[`threadpool=${n}: 8 x 1s solves wall s`] = round(msSince(t0) / 1000, 2);
  }
  return { metrics: out, cases: [] };
}

async function exactT4(fx, ex) {
  for (const _ of ex.passes()) {
    for (let seed = 0; seed < 8; seed++) {
      const t0 = performance.now();
      const [r, p] = tsp(fx, seed, { tl: 10000, sl: 100 });
      const t1 = performance.now(); const sol = await r.solveWithParameters(p); const t2 = performance.now();
      const route = [];
      let i = sol.value(r.nextVar(r.start(0)));
      while (!r.isEnd(i)) { route.push(i); i = sol.value(r.nextVar(i)); }
      const ms = [t1 - t0, t2 - t1, msSince(t2)];
      ex.record('t4 TSP 150 nodes, GLS sl=100', String(seed),
        { status: r.status(), objective: Number(sol.objectiveValue()), route }, ms, 10000);
      r.dispose();
    }
  }
}

// ---------------------------------------------------------------- t5: determinism under load (t5_det.py)
async function t5Run(fx, kind, mode) {
  const [buses, ncs, allowed] = t2dInstance(fx);
  const r = kind === 'tl'
    ? await solve(buses, ncs, { allowed, warm: true, timeLimitMs: 2000, ls: 'GUIDED_LOCAL_SEARCH', mode })
    : await solve(buses, ncs, { allowed, warm: true, timeLimitMs: 0, solutionLimit: 30, ls: 'GUIDED_LOCAL_SEARCH', mode });
  const s = signature(r);
  return [s.objective, Object.values(r.assigned).filter((v) => v !== null).length, round(r.seconds, 2), s.routes];
}

async function spikeT5(fx, mode) {
  const out = {}, recs = [];
  for (const kind of ['tl', 'sl']) {
    const alone = [await t5Run(fx, kind, mode), await t5Run(fx, kind, mode)];
    const loaded = await Promise.all(Array.from({ length: 6 }, () => t5Run(fx, kind, mode)));
    out[kind] = { alone: alone.map((x) => x.slice(0, 3)), loaded_6_parallel: loaded.map((x) => x.slice(0, 3)) };
    [...alone, ...loaded].forEach((x, j) => {
      recs.push({ id: `${kind}/${j < 2 ? 'alone' : 'loaded'}${j}`, sig: { objective: x[0], matched: x[1], routes: x[3] } });
    });
  }
  return { metrics: out, cases: recs };
}

// ---------------------------------------------------------------- t6: rescue + intercity (t6_rescue_intercity.py)
function rescueMcf(fx) {
  const { runs, buses } = fx;
  const k = runs.length, m = buses.length;
  const UNASSIGNED = 10_000_000;
  const smcf = new SimpleMinCostFlow();
  const src = k + m, sink = k + m + 1;
  const s = [], e = [], c = [], w = [];
  runs.forEach((r, i) => {
    s.push(src); e.push(i); c.push(1); w.push(0);
    s.push(i); e.push(sink); c.push(1); w.push(UNASSIGNED);
    buses.forEach((b, j) => {
      if (b.has_pos && b.seats >= r.need) { s.push(i); e.push(k + j); c.push(1); w.push(tt(b.pos, r.ref)); }
    });
  });
  for (let j = 0; j < m; j++) { s.push(k + j); e.push(sink); c.push(1); w.push(0); }
  smcf.addArcsWithCapacityAndUnitCost(s, e, c, w);
  const sup = new Array(k + m + 2).fill(0); sup[src] = k; sup[sink] = -k;
  smcf.setNodesSupplies([...sup.keys()], sup);
  const st = smcf.solveSync();
  const pick = new Map();
  for (let a = 0; a < smcf.numArcs(); a++) {
    if (smcf.flow(a) && k <= smcf.head(a) && smcf.head(a) < k + m) pick.set(smcf.tail(a), smcf.head(a) - k);
  }
  const ok = [...pick].every(([i, j]) => buses[j].seats >= runs[i].need && buses[j].has_pos);
  const out = {
    status: st, assigned: pick.size, seats_ok: ok, distinct_buses: new Set(pick.values()).size === pick.size,
    cost: smcf.optimalCost(), pick: [...pick].sort((a, b) => a[0] - b[0] || a[1] - b[1]),
  };
  smcf.dispose();
  return out;
}

const params = ({ tl = 0, sl = 0, first = 'AUTOMATIC' } = {}) =>
  searchParams({ first, ls: 'GUIDED_LOCAL_SEARCH', timeLimitMs: tl, solutionLimit: sl, log: false });

async function lockedOrder(fx, spKw) {
  const pts = fx.lock_points, fixedOrder = fx.fixed_order;
  const n = pts.length;
  const M = pts.map((a) => pts.map((b) => tt(a, b)));
  const man = new RoutingIndexManager(n, 1, [0], [n - 1]);
  const rt = new RoutingModel(man);
  const cb = rt.registerTransitMatrix(M); rt.setArcCostEvaluatorOfAllVehicles(cb);
  const sp = params(spKw);
  // Python returns False (and logs "The model is not closed yet"); ortools-node throws instead.
  let oklOpen;
  try {
    oklOpen = rt.applyLocksToAllVehicles([fixedOrder.map((x) => man.nodeToIndex(x))], true);
  } catch (err) {
    if (!/needs a closed model/.test(err.message)) throw err;
    oklOpen = false;
  }
  rt.closeModelWithParameters(sp);
  const okl = rt.applyLocksToAllVehicles([fixedOrder.map((x) => man.nodeToIndex(x))], true);
  const sol = await rt.solveWithParameters(sp);
  const route = [];
  let i = sol.value(rt.nextVar(rt.start(0)));
  while (!rt.isEnd(i)) { route.push(man.indexToNode(i)); i = sol.value(rt.nextVar(i)); }
  const rt2 = new RoutingModel(new RoutingIndexManager(n, 1, [0], [n - 1]));
  const cb2 = rt2.registerTransitMatrix(M); rt2.setArcCostEvaluatorOfAllVehicles(cb2);
  const sol2 = await rt2.solveWithParameters(sp);
  const out = {
    apply_locks_before_close: oklOpen, apply_locks_ok: okl, order_kept: JSON.stringify(route) === JSON.stringify(fixedOrder),
    locked_cost: Number(sol.objectiveValue()), free_cost: Number(sol2.objectiveValue()),
  };
  rt.dispose(); rt2.dispose();
  return out;
}

async function openPath(points, start, end, spKw) {
  const t0 = performance.now();
  const pts = [start, ...points, end], n = pts.length;
  const M = pts.map((a) => pts.map((b) => tt(a, b)));
  const man = new RoutingIndexManager(n, 1, [0], [n - 1]), rt = new RoutingModel(man);
  const cb = rt.registerTransitMatrix(M); rt.setArcCostEvaluatorOfAllVehicles(cb);
  const sp = params(spKw);
  const t1 = performance.now(); const sol = await rt.solveWithParameters(sp); const t2 = performance.now();
  const obj = Number(sol.objectiveValue());
  const ms = [t1 - t0, t2 - t1, msSince(t2)];
  rt.dispose();
  return [obj, Math.round(t2 - t1), ms];
}

async function pdModel(A, B, spKw) {
  const t0 = performance.now();
  const pts = [[8, 8], [408, 8], ...A.flatMap((a, q) => [a, B[q]])];
  const n = pts.length, M = pts.map((a) => pts.map((b) => tt(a, b)));
  const man = new RoutingIndexManager(n, 1, [0], [1]), rt = new RoutingModel(man);
  const cb = rt.registerTransitMatrix(M); rt.setArcCostEvaluatorOfAllVehicles(cb);
  rt.addDimension(cb, 0, 10 ** 7, true, 'Time'); const Tm = rt.getDimensionOrDie('Time'); const s_ = rt.solver();
  for (let q = 0; q < 40; q++) {
    const p = man.nodeToIndex(2 + 2 * q), d = man.nodeToIndex(3 + 2 * q);
    rt.addPickupAndDelivery(p, d); s_.add(rt.vehicleVar(p).eq(rt.vehicleVar(d))); s_.add(Tm.cumulVar(p).le(Tm.cumulVar(d)));
  }
  const sp = params({ first: 'PARALLEL_CHEAPEST_INSERTION', ...spKw });
  const t1 = performance.now(); const sol = await rt.solveWithParameters(sp); const t2 = performance.now();
  const obj = sol ? Number(sol.objectiveValue()) : null;
  const ms = [t1 - t0, t2 - t1, msSince(t2)];
  rt.dispose();
  return [obj, Math.round(t2 - t1), ms];
}

async function spikeT6(fx) {
  const out = {};
  const t0 = performance.now(); const res = rescueMcf(fx); res.ms = round(msSince(t0), 2);
  out.rescue_mcf_5x30 = res;
  out.rescue_locked_order = await lockedOrder(fx, { tl: 500 });
  const IC = {};
  for (const tl of [200, 1000]) {
    IC[`pickup tour tl${tl}`] = (await openPath(fx.A, [8, 8], [16, 8], { tl })).slice(0, 2);
    IC[`drop tour tl${tl}`] = (await openPath(fx.B, [400, 8], [408, 8], { tl })).slice(0, 2);
  }
  IC['one P&D model 40 pairs tl1000'] = (await pdModel(fx.A, fx.B, { tl: 1000 })).slice(0, 2);
  out.intercity_40 = IC;
  return { metrics: out, cases: [] };
}

async function exactT6(fx, ex) {
  for (const _ of ex.passes()) {
    let t0 = performance.now(); let res = rescueMcf(fx);
    ex.record('t6 rescue min cost flow 5x30', 'mcf', res, [msSince(t0), 0, 0]);
    t0 = performance.now(); res = await lockedOrder(fx, { sl: 100, tl: 10000 });
    ex.record('t6 locked order, 2 models, GLS sl=100', 'locks', res, [msSince(t0), 0, 0]);
    let [obj, , ms] = await openPath(fx.A, [8, 8], [16, 8], { sl: 200, tl: 10000 });
    ex.record('t6 intercity tour 42 nodes, GLS sl=200', 'pickup', obj, ms, 10000);
    [obj, , ms] = await openPath(fx.B, [400, 8], [408, 8], { sl: 200, tl: 10000 });
    ex.record('t6 intercity tour 42 nodes, GLS sl=200', 'drop', obj, ms, 10000);
    [obj, , ms] = await pdModel(fx.A, fx.B, { sl: 100, tl: 60000 });
    ex.record('t6 intercity 40 P&D pairs, GLS sl=100', 'pd', obj, ms, 60000);
  }
}

// ---------------------------------------------------------------- CP-SAT (stack/gil_cpsat.py)
async function cpsat(fx, seed = 0, { maxTime = 0.3, fixedSeed = false } = {}) {
  const t0 = performance.now();
  const costs = fx.costs[String(seed)], n = fx.n;
  const m = new CpModel();
  const x = Array.from({ length: n }, () => Array.from({ length: n }, () => m.newBoolVar('')));
  for (let i = 0; i < n; i++) { m.addExactlyOne(x[i]); m.addExactlyOne(x.map((row) => row[i])); }
  const terms = [], coeffs = [];
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) { terms.push(x[i][j]); coeffs.push(costs[i][j]); }
  m.minimize(ortools.CpLinearExpr.weightedSum(terms, coeffs));
  const s = new CpSolver();
  s.parameters = { numWorkers: 1, ...(maxTime ? { maxTimeInSeconds: maxTime } : {}), ...(fixedSeed ? { randomSeed: 1 } : {}) };
  const t1 = performance.now(); const st = await s.solve(m); const t2 = performance.now();
  const vals = [];
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) if (s.booleanValue(x[i][j])) vals.push(j);
  return [st, s.objectiveValue, vals, [t1 - t0, t2 - t1, msSince(t2)]];
}

/** stack/gil2.py's heartbeat probe on the event loop: a 1 ms timer; returns [elapsed s, worst gap ms]. */
async function probe(fn) {
  const gaps = [];
  let last = performance.now(), stop = false;
  const hb = () => {
    const now = performance.now(); gaps.push(now - last); last = now;
    if (!stop) setTimeout(hb, 1);
  };
  setTimeout(hb, 1);
  const t0 = performance.now(); await fn(); const el = msSince(t0) / 1000;
  stop = true;
  await new Promise((r) => setTimeout(r, 2));
  return [el, Math.max(...gaps)];
}

async function spikeCpsat(fx) {
  const [one, g1] = await probe(() => cpsat(fx));
  const [par, g4] = await probe(() => Promise.all([0, 1, 2, 3].map((seed) => cpsat(fx, seed))));
  return {
    metrics: { one_ms: Math.round(one * 1000), one_maxgap_ms: round(g1, 1), threads4_ms: Math.round(par * 1000), threads4_maxgap_ms: round(g4, 1) },
    cases: [],
  };
}

async function exactCpsat(fx, ex) {
  for (const _ of ex.passes()) {
    for (let seed = 0; seed < 4; seed++) {
      const [st, obj, vals, ms] = await cpsat(fx, seed, { maxTime: 0, fixedSeed: true });
      ex.record('CP-SAT 40x40 assignment, 1 worker, to optimality', String(seed), { status: st, objective: obj, values: vals }, ms);
    }
  }
}

module.exports = { spikeT3, exactT3, spikeT4, exactT4, spikeT5, spikeT6, exactT6, spikeCpsat, exactCpsat };
