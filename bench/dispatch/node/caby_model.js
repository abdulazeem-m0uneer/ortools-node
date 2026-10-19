'use strict';
// Line-for-line port of caby-dispatch spikes/ortools/caby_model.py (rules, warm start, gender types,
// allowed vehicles), plus fixture loading. Riders and buses come from bench/dispatch/fixtures (written
// by gen_instances.py), never from a JS RNG. Integer seconds throughout, now = 0.

const { performance } = require('node:perf_hooks');
const { RoutingIndexManager, RoutingModel, durationMs } = require('./ortools');

const SPEED_KMH = 25.0;
const SERVICE = 30;
const DETOUR = 480, DELAY = 360, WAIT = 900;
const HORIZON = 6 * 3600;
const BIG_PENALTY = 10_000_000;
const ALL_RULES = Object.freeze(['seats', 'cap', 'detour', 'delay', 'wait', 'gender', 'stay']);

/** Python 3's round(): half to even. */
function pyRound(x) {
  const f = Math.floor(x), d = x - f;
  if (d > 0.5) return f + 1;
  if (d < 0.5) return f;
  return f % 2 === 0 ? f : f + 1;
}

const rideCap = (direct) => Math.max(420, 2 * direct + 600);
const tt = (a, b) => pyRound((Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1])) / SPEED_KMH * 3600);
const without = (rules, rule) => rules.filter((r) => r !== rule);

/** Bus.gender: the gender of its first rider, or null when empty. */
function busGender(b) {
  const rs = [...b.aboard, ...b.waiting];
  return rs.length ? rs[0].gender : null;
}

/** A fixture bus with its plan's [rid, kind] pairs resolved to [rider, kind]. */
function loadBus(j) {
  const byRid = new Map([...j.aboard, ...j.waiting].map((r) => [r.rid, r]));
  return { ...j, plan: j.plan.map(([rid, k]) => [byRid.get(rid), k]) };
}

// ---------------------------------------------------------------- schedule / checker (independent of OR-Tools)
function schedule(pos, stops) {
  let t = 0, cur = pos, first = true;
  const times = [];
  for (const [r, k] of stops) {
    const p = k === 'P' ? r.pick : r.drop;
    t += tt(cur, p) + (first ? 0 : SERVICE);
    first = false;
    times.push(t);
    cur = p;
  }
  const end = t + (stops.length ? SERVICE : 0);
  return [times, end];
}

function checkRoute(bus, stops, newcomers = [], rules = ALL_RULES) {
  const has = (x) => rules.includes(x);
  const v = [];
  const [times, end] = schedule(bus.pos, stops);
  const at = new Map();
  let load = bus.aboard.reduce((s, r) => s + r.seats, 0);
  if (load > bus.seats && has('seats')) v.push('seats@start');
  stops.forEach(([r, k], i) => {
    at.set(`${r.rid}|${k}`, times[i]);
    load += k === 'P' ? r.seats : -r.seats;
    if (load > bus.seats && has('seats')) v.push(`seats@${r.rid}${k}`);
  });
  const everyone = [...bus.aboard, ...bus.waiting, ...newcomers];
  const genders = new Set(everyone.map((r) => r.gender));
  if (genders.size > 1 && has('gender')) v.push('gender');
  const newRids = new Set(newcomers.map((r) => r.rid));
  for (const r of everyone) {
    if (!at.has(`${r.rid}|D`)) { v.push(`unserved ${r.rid}`); continue; }
    const d = at.get(`${r.rid}|D`);
    if (r.pick !== null) {
      if (!at.has(`${r.rid}|P`) || at.get(`${r.rid}|P`) > d) { v.push(`precedence ${r.rid}`); continue; }
      const p = at.get(`${r.rid}|P`);
      if (d - p > rideCap(r.direct) && has('cap')) v.push(`cap ${r.rid}`);
    } else if (d - r.boarded_at > rideCap(r.direct) && has('cap')) {
      v.push(`cap ${r.rid}`);
    }
    if (r.promise_drop !== null && d > r.promise_drop + DELAY && has('delay')) v.push(`delay-drop ${r.rid}`);
    if (r.promise_pick !== null && at.get(`${r.rid}|P`) > r.promise_pick + DELAY && has('delay')) v.push(`delay-pick ${r.rid}`);
    if (newRids.has(r.rid) && at.get(`${r.rid}|P`) > WAIT && has('wait')) v.push(`wait ${r.rid}`);
  }
  if (newcomers.length && bus.plan.length && end > bus.base_end + DETOUR && has('detour')) v.push('detour');
  return v;
}

// ---------------------------------------------------------------- OR-Tools model
/**
 * Restricts a node to vehicles `ok`. mode 'span' calls SetAllowedVehiclesForIndex (what Python 9.14 does);
 * 'removevalues' removes the other vehicles from VehicleVar (the spike's workaround for Python 9.15).
 */
function allow(routing, index, ok, nv, mode) {
  if (mode === 'span') { routing.setAllowedVehiclesForIndex(ok, index); return; }
  const okSet = new Set(ok);
  const forbidden = [];
  for (let v = 0; v < nv; v++) if (!okSet.has(v)) forbidden.push(v);
  if (forbidden.length) routing.vehicleVar(index).removeValues(forbidden);
}

/** Search parameters as the spike sets them on DefaultRoutingSearchParameters(). */
function searchParams({ first, ls, timeLimitMs, solutionLimit, log }) {
  const sp = { firstSolutionStrategy: first, localSearchMetaheuristic: ls, logSearch: log };
  if (timeLimitMs) sp.timeLimit = durationMs(timeLimitMs);
  if (solutionLimit) sp.solutionLimit = solutionLimit;
  return sp;
}

/**
 * caby_model.solve(). Returns {status, routes: Map(v -> [[rider, k]]), assigned: {rid: v|null}, objective,
 * seconds (build + solve, as the spike measures), buildMs, solveMs, readMs}.
 */
async function solve(buses, newcomers, {
  rules = ALL_RULES, allowed = null, timeLimitMs = 200, ls = 'GREEDY_DESCENT', first = 'PARALLEL_CHEAPEST_INSERTION',
  warm = false, solutionLimit = null, useCallback = false, log = false, genderTypes = true, mode = 'span',
} = {}) {
  const has = (x) => rules.includes(x);
  const t0 = performance.now();
  const nv = buses.length;
  const locs = [], info = [];
  for (const b of buses) { locs.push(b.pos); info.push(['start', b, null]); }
  for (const b of buses) { locs.push(null); info.push(['end', b, null]); }
  const nodeOf = new Map();
  const add = (r, k, b) => {
    nodeOf.set(`${r.rid}|${k}`, locs.length);
    locs.push(k === 'P' ? r.pick : r.drop); info.push([k, b, r]);
  };
  for (const b of buses) {
    for (const r of b.aboard) add(r, 'D', b);
    for (const r of b.waiting) { add(r, 'P', b); add(r, 'D', b); }
  }
  for (const r of newcomers) { add(r, 'P', null); add(r, 'D', null); }
  const n = locs.length;
  const starts = [...Array(nv).keys()], ends = starts.map((v) => nv + v);
  const M = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    if (info[i][0] === 'end') continue;
    const svc = info[i][0] === 'start' ? 0 : SERVICE;
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      if (info[j][0] === 'end') M[i][j] = svc;
      else if (info[j][0] === 'start') M[i][j] = 0;
      else M[i][j] = tt(locs[i], locs[j]) + svc;
    }
  }
  const manager = new RoutingIndexManager(n, nv, starts, ends);
  const routing = new RoutingModel(manager);
  try {
    const transit = useCallback
      ? routing.registerTransitCallback((fi, ti) => M[manager.indexToNode(fi)][manager.indexToNode(ti)])
      : routing.registerTransitMatrix(M);
    routing.setArcCostEvaluatorOfAllVehicles(transit);
    routing.addDimension(transit, 0, HORIZON, true, 'Time');
    const T = routing.getDimensionOrDie('Time');
    const demand = new Array(n).fill(0);
    info.forEach(([k, , r], i) => {
      if (k === 'P') demand[i] = r.seats;
      else if (k === 'D') demand[i] = -r.seats;
    });
    const dem = routing.registerUnaryTransitVector(demand);
    const caps = buses.map((b) => (has('seats') ? b.seats : 10_000));
    routing.addDimensionWithVehicleCapacity(dem, 0, caps, false, 'Seats');
    const S = routing.getDimensionOrDie('Seats');
    const solver = routing.solver();
    buses.forEach((b, v) => {
      S.cumulVar(routing.start(v)).setValue(b.aboard.reduce((s, r) => s + r.seats, 0));
      if (has('detour') && newcomers.length && b.plan.length) T.setSpanUpperBoundForVehicle(b.base_end + DETOUR, v);
    });
    const idx = (rid, k) => manager.nodeToIndex(nodeOf.get(`${rid}|${k}`));
    buses.forEach((b, v) => {
      for (const r of b.aboard) {
        const d = idx(r.rid, 'D');
        allow(routing, d, [v], nv, mode);
        let ub = HORIZON;
        if (has('cap')) ub = Math.min(ub, r.boarded_at + rideCap(r.direct));
        if (has('delay')) ub = Math.min(ub, r.promise_drop + DELAY);
        T.cumulVar(d).setMax(ub);
      }
      for (const r of b.waiting) {
        const p = idx(r.rid, 'P'), d = idx(r.rid, 'D');
        routing.addPickupAndDelivery(p, d);
        solver.add(routing.vehicleVar(p).eq(routing.vehicleVar(d)));
        solver.add(T.cumulVar(p).le(T.cumulVar(d)));
        if (has('stay')) { allow(routing, p, [v], nv, mode); allow(routing, d, [v], nv, mode); }
        if (has('delay')) {
          T.cumulVar(p).setMax(r.promise_pick + DELAY); T.cumulVar(d).setMax(r.promise_drop + DELAY);
        }
        if (has('cap')) solver.add(T.cumulVar(d).minus(T.cumulVar(p)).le(rideCap(r.direct)));
      }
    });
    for (const r of newcomers) {
      const p = idx(r.rid, 'P'), d = idx(r.rid, 'D');
      routing.addPickupAndDelivery(p, d);
      solver.add(routing.activeVar(p).eq(routing.activeVar(d)));
      solver.add(routing.vehicleVar(p).eq(routing.vehicleVar(d)));
      solver.add(T.cumulVar(p).le(T.cumulVar(d)));
      routing.addDisjunction([p], BIG_PENALTY); routing.addDisjunction([d], BIG_PENALTY);
      let ok = allowed === null ? [...Array(nv).keys()] : [...allowed[r.rid]];
      if (has('gender')) ok = ok.filter((v) => [null, r.gender].includes(busGender(buses[v])));
      if (!ok.length) {
        routing.activeVar(p).setValue(0); routing.activeVar(d).setValue(0);
      } else if (ok.length < nv) {
        allow(routing, p, ok, nv, mode); allow(routing, d, ok, nv, mode);
      }
      if (has('wait')) T.cumulVar(p).setMax(WAIT);
      if (has('cap')) solver.add(T.cumulVar(d).minus(T.cumulVar(p)).le(rideCap(r.direct)));
    }
    if (has('gender') && genderTypes && new Set(newcomers.map((r) => r.gender)).size > 1) {
      const tmap = { M: 0, F: 1 };
      info.forEach(([k, , r], i) => {
        if (k === 'P' || k === 'D') {
          const pol = k === 'P' ? 'TYPE_ADDED_TO_VEHICLE'
            : (r.pick === null ? 'TYPE_ON_VEHICLE_UP_TO_VISIT' : 'ADDED_TYPE_REMOVED_FROM_VEHICLE');
          routing.setVisitType(manager.nodeToIndex(i), tmap[r.gender], pol);
        }
      });
      routing.addHardTypeIncompatibility(0, 1);
    }
    for (let v = 0; v < nv; v++) routing.addVariableMinimizedByFinalizer(T.cumulVar(routing.end(v)));
    const sp = searchParams({ first, ls, timeLimitMs, solutionLimit, log });
    let sol, t1;
    if (warm) {
      routing.closeModelWithParameters(sp);
      const init = buses.map((b) => b.plan.map(([r, k]) => idx(r.rid, k)));
      const a0 = routing.readAssignmentFromRoutes(init, true);
      t1 = performance.now();
      sol = a0 ? await routing.solveFromAssignmentWithParameters(a0, sp) : await routing.solveWithParameters(sp);
    } else {
      t1 = performance.now();
      sol = await routing.solveWithParameters(sp);
    }
    const t2 = performance.now();
    const timing = { buildMs: t1 - t0, solveMs: t2 - t1, seconds: (t2 - t0) / 1000 };
    const assigned = Object.fromEntries(newcomers.map((r) => [r.rid, null]));
    if (sol === null) return { status: routing.status(), routes: new Map(), assigned, objective: null, ...timing, readMs: 0 };
    const routes = new Map();
    const newset = new Set(newcomers.map((r) => r.rid));
    buses.forEach((b, v) => {
      let i = sol.value(routing.nextVar(routing.start(v)));
      const st = [];
      while (!routing.isEnd(i)) {
        const [k, , r] = info[manager.indexToNode(i)];
        st.push([r, k]);
        if (newset.has(r.rid)) assigned[r.rid] = v;
        i = sol.value(routing.nextVar(i));
      }
      routes.set(v, st);
    });
    const objective = sol.objectiveValue();
    return { status: routing.status(), routes, assigned, objective, ...timing, readMs: performance.now() - t2 };
  } finally {
    routing.dispose();
  }
}

/** caby_model.verify(): an independent check of a solution; returns the violations. */
function verify(buses, newcomers, res, rules = ALL_RULES) {
  const v = [];
  const by = new Map(newcomers.map((r) => [r.rid, r]));
  buses.forEach((b, vi) => {
    const st = res.routes.get(vi) || [];
    const newHere = Object.entries(res.assigned).filter(([, bv]) => bv === vi).map(([rid]) => by.get(rid));
    const here = new Set(st.map(([r]) => r.rid));
    for (const r of [...b.aboard, ...b.waiting]) if (!here.has(r.rid) && rules.includes('stay')) v.push(`moved ${r.rid}`);
    const foreign = st.map(([r]) => r).filter((r) => !by.has(r.rid) && !r.rid.startsWith(`b${b.bid}`));
    if (foreign.length && rules.includes('stay')) v.push(`foreign on bus ${b.bid}`);
    const bb = { ...b, waiting: [...b.waiting.filter((r) => here.has(r.rid)), ...foreign.filter((r) => r.pick)] };
    for (const x of checkRoute(bb, st, newHere, rules)) v.push(`bus${b.bid}:${x}`);
  });
  return v;
}

/** A comparable signature of a SolveResult: status, objective, routes and assignments. */
function signature(res) {
  const routes = [...res.routes.entries()].sort((a, b) => a[0] - b[0])
    .map(([v, st]) => `${v}:${st.map(([r, k]) => r.rid + k).join(',')}`).join('|');
  return { status: res.status, objective: res.objective === null ? null : Number(res.objective), routes, assigned: res.assigned };
}

module.exports = {
  SERVICE, DETOUR, DELAY, WAIT, HORIZON, BIG_PENALTY, ALL_RULES,
  pyRound, rideCap, tt, without, busGender, loadBus, schedule, checkRoute, allow, searchParams, solve, verify, signature,
};
