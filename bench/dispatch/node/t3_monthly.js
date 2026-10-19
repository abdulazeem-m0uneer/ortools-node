'use strict';
// Line-for-line port of caby-dispatch spikes/ortools/t3_monthly.py's build() and check(): monthly
// placement of a 40-rider group (time windows, max ride, seats, fixed pickup times for newcomers).
// insertion_oracle() is solver-independent, so its verdicts come with the fixture.

const { performance } = require('node:perf_hooks');
const { RoutingIndexManager, RoutingModel } = require('./ortools');
const { tt, searchParams } = require('./caby_model');

const SERVICE = 15;
const MAXRIDE = 45 * 60;
const WIN = 15 * 60;
const H = 6 * 3600;

const key = (rid, k) => `${rid}|${k}`;

/**
 * fixed: {rid: exact pickup time}. Returns [plan | null, status, seconds, [build, solve, read] ms];
 * plan = {order: [[rid, k]], times: Map(key -> t), obj}.
 */
async function build(riders, depot, seats, {
  fixed = null, newcomers = [], tlMs = 1000, ls = 'GUIDED_LOCAL_SEARCH', first = 'PARALLEL_CHEAPEST_INSERTION',
  initial = null, solutionLimit = null,
} = {}) {
  const t0 = performance.now();
  const allr = [...riders, ...newcomers];
  const locs = [depot, null];
  const node = new Map();
  for (const r of allr) {
    node.set(key(r.rid, 'P'), locs.length); locs.push(r.p);
    node.set(key(r.rid, 'D'), locs.length); locs.push(r.d);
  }
  const n = locs.length;
  const M = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    if (i === 1) continue;
    for (let j = 0; j < n; j++) {
      if (i === j || j === 0) continue;
      const svc = i === 0 ? 0 : SERVICE;
      M[i][j] = j === 1 ? svc : tt(locs[i], locs[j]) + svc;
    }
  }
  const man = new RoutingIndexManager(n, 1, [0], [1]);
  const rt = new RoutingModel(man);
  try {
    const tr = rt.registerTransitMatrix(M);
    rt.setArcCostEvaluatorOfAllVehicles(tr);
    rt.addDimension(tr, H, H, false, 'Time');
    const T = rt.getDimensionOrDie('Time');
    const dem = new Array(n).fill(0);
    for (const r of allr) { dem[node.get(key(r.rid, 'P'))] = 1; dem[node.get(key(r.rid, 'D'))] = -1; }
    rt.addDimensionWithVehicleCapacity(rt.registerUnaryTransitVector(dem), 0, [seats], true, 'Seats');
    const s = rt.solver();
    const newids = new Set(newcomers.map((r) => r.rid));
    for (const r of allr) {
      const p = man.nodeToIndex(node.get(key(r.rid, 'P'))), d = man.nodeToIndex(node.get(key(r.rid, 'D')));
      rt.addPickupAndDelivery(p, d);
      s.add(rt.vehicleVar(p).eq(rt.vehicleVar(d)));
      s.add(T.cumulVar(p).le(T.cumulVar(d)));
      s.add(T.cumulVar(d).minus(T.cumulVar(p)).le(MAXRIDE));
      if (fixed && r.rid in fixed) T.cumulVar(p).setRange(fixed[r.rid], fixed[r.rid]);
      else T.cumulVar(p).setRange(r.req - WIN, r.req + WIN);
      if (newids.has(r.rid)) {
        s.add(rt.activeVar(p).eq(rt.activeVar(d)));
        rt.addDisjunction([p], 10_000_000); rt.addDisjunction([d], 10_000_000);
      }
    }
    rt.addVariableMinimizedByFinalizer(T.cumulVar(rt.end(0)));
    rt.addVariableMaximizedByFinalizer(T.cumulVar(rt.start(0)));
    for (const r of allr) rt.addVariableMinimizedByFinalizer(T.cumulVar(man.nodeToIndex(node.get(key(r.rid, 'P')))));
    const sp = searchParams({ first, ls, timeLimitMs: tlMs, solutionLimit, log: false });
    let sol = null, t1, t2;
    if (initial !== null) {
      rt.closeModelWithParameters(sp);
      const a0 = rt.readAssignmentFromRoutes([initial.map(([rid, k]) => man.nodeToIndex(node.get(key(rid, k))))], true);
      t1 = performance.now();
      if (a0) sol = await rt.solveFromAssignmentWithParameters(a0, sp);
    } else {
      t1 = performance.now();
      sol = await rt.solveWithParameters(sp);
    }
    t2 = performance.now();
    const secs = (t2 - t0) / 1000;
    if (sol === null) return [null, rt.status(), secs, [t1 - t0, t2 - t1, 0]];
    const inv = new Map([...node].map(([k, v]) => [v, k.split('|')]));
    const order = [], times = new Map();
    let i = sol.value(rt.nextVar(rt.start(0)));
    while (!rt.isEnd(i)) {
      const k = inv.get(man.indexToNode(i)); order.push(k); times.set(key(...k), sol.value(T.cumulVar(i)));
      i = sol.value(rt.nextVar(i));
    }
    const plan = { order, times, obj: sol.objectiveValue() };
    return [plan, rt.status(), secs, [t1 - t0, t2 - t1, performance.now() - t2]];
  } finally {
    rt.dispose();
  }
}

/** Independent: earliest schedule with waiting; fixed pickups must be reachable by their time. */
function check(riders, depot, seats, plan, fixed = null, newcomers = []) {
  const by = new Map([...riders, ...newcomers].map((r) => [r.rid, r]));
  const v = [];
  let t = null, cur = depot, load = 0;
  const at = new Map();
  for (const k of plan.order) {
    const r = by.get(k[0]), pt = k[1] === 'P' ? r.p : r.d;
    let arr = t === null ? plan.times.get(key(...plan.order[0])) : t + tt(cur, pt) + SERVICE;
    if (t === null) arr = plan.times.get(key(...k));
    if (k[1] === 'P') {
      const lo = fixed && k[0] in fixed ? fixed[k[0]] : r.req - WIN;
      const hi = fixed && k[0] in fixed ? fixed[k[0]] : r.req + WIN;
      if (arr > hi) v.push(`late pickup ${k[0]} by ${arr - hi}s`);
      arr = Math.max(arr, lo);
      load += 1;
    } else {
      load -= 1;
      if (!at.has(key(k[0], 'P'))) v.push(`precedence ${k[0]}`);
      else if (arr - at.get(key(k[0], 'P')) > MAXRIDE) v.push(`ride ${k[0]} ${arr - at.get(key(k[0], 'P'))}s`);
    }
    if (load > seats) v.push('seats');
    at.set(key(...k), arr); t = arr; cur = pt;
  }
  const newRids = new Set(newcomers.map((x) => x.rid));
  for (const rid of by.keys()) {
    if (newRids.has(rid) && !at.has(key(rid, 'P'))) continue;
    if (!at.has(key(rid, 'D'))) v.push(`unserved ${rid}`);
  }
  return v;
}

module.exports = { SERVICE, MAXRIDE, WIN, H, key, build, check };
