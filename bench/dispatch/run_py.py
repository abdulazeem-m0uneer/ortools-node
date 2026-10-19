"""Python side of the caby-dispatch parity benchmark: the spikes' own code on the fixtures.

Usage: python -I -B bench/dispatch/run_py.py <suite> <flavor> [repeats] [fixtures_dir]
  suite:  t1 t2a t2b t2c t2d t2e t2f t3 t4 t5 t6 cpsat, and modules (knapsack, set cover, max flow, math_opt)
  flavor: spike  the spike's experiment as written (time limits; run once)
          exact  deterministic parameters (a solution limit under a far-off guard time limit, or
                 GREEDY_DESCENT to its local optimum), one untimed pass that records the solution
                 signatures, then `repeats` timed passes
Prints one JSON object. caby_model.solve() and t3_monthly.build() are the spikes' own functions,
imported from $CABY_DISPATCH_DIR/spikes/ortools; RoutingModel's solve methods are wrapped only to
time build / solve / read. t4, t5, t6 and stack/gil_cpsat.py run their experiments at import, so
their bodies are copied here unchanged apart from reading the fixtures. Mirror: run_node.js.
"""

import json
import os
import sys
import threading
import time
from concurrent.futures import ProcessPoolExecutor, ThreadPoolExecutor

sys.dont_write_bytecode = True
SPIKES = os.path.join(os.environ.get("CABY_DISPATCH_DIR", "/mnt/5DBFBA707C791990/Projects/CABY/caby-dispatch"), "spikes")
sys.path.insert(0, os.path.join(SPIKES, "ortools"))
HERE = os.path.dirname(os.path.abspath(__file__))

import numpy as np  # noqa: E402
import ortools  # noqa: E402
from ortools.constraint_solver import pywrapcp, routing_enums_pb2  # noqa: E402
from ortools.graph.python import linear_sum_assignment, min_cost_flow  # noqa: E402
from ortools.sat.python import cp_model  # noqa: E402

import caby_model  # noqa: E402
from caby_model import ALL_RULES, Bus, Rider, solve, tt, verify  # noqa: E402
import t3_monthly  # noqa: E402

FIXTURES = os.path.join(HERE, "fixtures")
STATUS = routing_enums_pb2.RoutingSearchStatus.Value.Name


# ---------------------------------------------------------------- timing: wrap the solve entry points
class Marks:
    solve_start = solve_end = 0.0


def _timed(orig):
    def wrapper(*a, **kw):
        Marks.solve_start = time.perf_counter()
        try:
            return orig(*a, **kw)
        finally:
            Marks.solve_end = time.perf_counter()
    return wrapper


for _name in ("SolveWithParameters", "SolveFromAssignmentWithParameters"):
    setattr(pywrapcp.RoutingModel, _name, _timed(getattr(pywrapcp.RoutingModel, _name)))


def phases(fn, *a, **kw):
    """Runs fn (one routing build + solve + read) and returns (result, [build, solve, read] ms)."""
    Marks.solve_start = Marks.solve_end = None
    t0 = time.perf_counter()
    out = fn(*a, **kw)
    t3 = time.perf_counter()
    if Marks.solve_start is None:  # no solve ran (e.g. no initial assignment): all build
        Marks.solve_start = Marks.solve_end = t3
    return out, [(Marks.solve_start - t0) * 1e3, (Marks.solve_end - Marks.solve_start) * 1e3, (t3 - Marks.solve_end) * 1e3]


def ms_since(t0):
    return (time.perf_counter() - t0) * 1e3


# ---------------------------------------------------------------- fixtures
def load(name):
    with open(os.path.join(FIXTURES, f"{name}.json")) as fh:
        return json.load(fh)


def rider(j):
    return Rider(j["rid"], tuple(j["drop"]), tuple(j["pick"]) if j["pick"] is not None else None, j["seats"], j["gender"],
                 j["direct"], j["boarded_at"], j["promise_pick"], j["promise_drop"])


def bus(j):
    aboard, waiting = [rider(r) for r in j["aboard"]], [rider(r) for r in j["waiting"]]
    by = {r.rid: r for r in aboard + waiting}
    return Bus(j["bid"], tuple(j["pos"]), j["seats"], aboard, waiting, [(by[rid], k) for rid, k in j["plan"]], j["base_end"])


def instance(case):
    return [bus(b) for b in case["buses"]], [rider(r) for r in case["newcomers"]]


def sig(res):
    routes = "|".join(f"{v}:" + ",".join(r.rid + k for r, k in st) for v, st in sorted(res.routes.items()))
    return dict(status=STATUS(res.status), objective=res.objective, routes=routes, assigned=res.assigned)


def allowed_mode():
    """What caby_model.allow() ends up doing on this ortools: 'span' or 'removevalues' (9.15, #5415)."""
    m = pywrapcp.RoutingIndexManager(3, 2, 0)
    return caby_model.allow(pywrapcp.RoutingModel(m), 1, [0], 2)


class Exact:
    """Signature pass + timed passes; workloads are named so the report can tabulate them.

    GUIDED_LOCAL_SEARCH with only a solution limit never stops on instances where it runs out of new
    solutions (about 1 in 10 single-bus cases), so those solves also get a guard time limit `guard_ms`.
    A solve that reaches it is recorded as a guard hit and left out of the latency figures.
    """

    def __init__(self, repeats):
        self.repeats, self.cases, self.timings, self.unstable, self.guard_hits = repeats, [], {}, [], {}
        self.rep, self._first = 0, {}

    def passes(self):
        for self.rep in range(self.repeats + 1):
            yield self.rep

    def record(self, workload, case_id, signature, ms, guard_ms=0):
        hit = bool(guard_ms) and ms[1] >= 0.95 * guard_ms
        if self.rep == 0:
            self.cases.append(dict(workload=workload, id=case_id, sig=signature, guard_hit=hit))
            self._first[(workload, case_id)] = signature
            return
        if self._first[(workload, case_id)] != signature:
            self.unstable.append(f"{workload}/{case_id}")
        if hit:
            self.guard_hits[workload] = self.guard_hits.get(workload, 0) + 1
        else:
            self.timings.setdefault(workload, []).append(ms)

    def result(self):
        return dict(cases=self.cases, timings=self.timings, unstable=sorted(set(self.unstable)), guard_hits=self.guard_hits)


# ---------------------------------------------------------------- t1: rules on one bus
def t1_cases(fx):
    return [(bus(c["bus"]), rider(c["newcomer"])) for c in fx["cases"]]


def spike_t1(fx):
    cases = t1_cases(fx)
    out, recs, fails = {"tries": fx["tries"]}, [], [0]

    def run(i, rules, tag):
        b, nc = cases[i]
        res, ms = phases(solve, [b], [nc], rules=rules, time_limit_ms=200, warm=True)
        if not res.routes: fails[0] += 1
        viol = verify([b], [nc], res, rules)
        recs.append(dict(id=f"{tag}/{i}", sig=sig(res), ms=ms))
        return res, viol

    for R in fx["rules"]:
        refused_all = accepted_without = viol = 0
        for i in fx["binding"][R]:
            res, v = run(i, ALL_RULES, f"{R}:all")
            refused_all += res.assigned["new"] is None
            viol += bool(v)
            res2, v2 = run(i, ALL_RULES - {R}, f"{R}:without")
            accepted_without += res2.assigned["new"] is not None
            viol += bool(v2)
        out[R] = dict(cases=len(fx["binding"][R]), refused_with_rule=refused_all, accepted_without_rule=accepted_without,
                      violations=viol)
    fa = fr = viol = 0
    for i in fx["accepts"]:
        res, v = run(i, ALL_RULES, "accept")
        viol += bool(v); fr += res.assigned["new"] is None
    for i in fx["refusals"]:
        res, v = run(i, ALL_RULES, "refusal")
        viol += bool(v); fa += res.assigned["new"] is not None
    out["oracle_feasible"] = dict(cases=len(fx["accepts"]), false_refusals=fr)
    out["oracle_infeasible"] = dict(cases=len(fx["refusals"]), false_accepts=fa)
    out["violations_in_any_returned_plan"] = viol
    out["no_solution_at_all"] = fails[0]
    return dict(metrics=out, cases=recs)


def exact_t1(fx, ex):
    """Warm GREEDY_DESCENT with no time limit (it stops at a local optimum): the binding and oracle-feasible
    cases, plus the first 300 oracle refusals."""
    cases = t1_cases(fx)
    ids = [(f"{R}:{tag}", i, rules) for R in fx["rules"] for i in fx["binding"][R]
           for tag, rules in (("all", ALL_RULES), ("without", ALL_RULES - {R}))]
    ids += [("accept", i, ALL_RULES) for i in fx["accepts"]] + [("refusal", i, ALL_RULES) for i in fx["refusals"][:300]]
    for _ in ex.passes():
        for tag, i, rules in ids:
            b, nc = cases[i]
            res, ms = phases(solve, [b], [nc], rules=rules, time_limit_ms=0, warm=True)
            ex.record("t1 one bus, GD", f"{tag}/{i}", sig(res), ms)


# ---------------------------------------------------------------- t2 A: one bus, 12 stops + newcomer
T2A_MODES = {
    "warm+GD(tl1000)": dict(warm=True, ls="GREEDY_DESCENT", time_limit_ms=1000),
    "warm+GLS(tl100)": dict(warm=True, ls="GUIDED_LOCAL_SEARCH", time_limit_ms=100),
    "warm+GLS(tl300)": dict(warm=True, ls="GUIDED_LOCAL_SEARCH", time_limit_ms=300),
    "cold PCA+GD(tl1000)": dict(warm=False, first="PATH_CHEAPEST_ARC", ls="GREEDY_DESCENT", time_limit_ms=1000),
    "warm+GD python-callback": dict(warm=True, ls="GREEDY_DESCENT", time_limit_ms=1000, use_callback=True),
}
T2A_EXACT = {
    "t2a one bus 12 stops, warm GD": dict(warm=True, ls="GREEDY_DESCENT", time_limit_ms=0),
    "t2a one bus 12 stops, warm GLS sl=100": dict(warm=True, ls="GUIDED_LOCAL_SEARCH", time_limit_ms=1000, solution_limit=100),
    "t2a one bus 12 stops, warm GD, transit callback": dict(warm=True, ls="GREEDY_DESCENT", time_limit_ms=0, use_callback=True),
}


def t2a_cases(fx):
    return [(bus(c["bus"]), rider(c["newcomer"])) for c in fx["cases"]]


def spike_t2a(fx):
    cases, A, recs = t2a_cases(fx), {}, []
    for name, kw in T2A_MODES.items():
        ms, acc, viol, nosol = [], 0, 0, 0
        for i, (b, nc) in enumerate(cases):
            res, ph = phases(solve, [b], [nc], **kw)
            ms.append(res.seconds * 1000)
            acc += res.assigned["new"] is not None
            nosol += not res.routes
            viol += bool(verify([b], [nc], res)) if res.routes else 0
            recs.append(dict(id=f"{name}/{i}", sig=sig(res), ms=ph))
        A[name] = dict(ms=ms, accepted=acc, violations=viol, no_solution=nosol)
    return dict(metrics=A, cases=recs)


def exact_t2a(fx, ex):
    cases = t2a_cases(fx)
    for _ in ex.passes():
        for name, kw in T2A_EXACT.items():
            for i, (b, nc) in enumerate(cases):
                res, ms = phases(solve, [b], [nc], **kw)
                ex.record(name, str(i), sig(res), ms, kw["time_limit_ms"])


# ---------------------------------------------------------------- t2 B: 20 candidate buses
def spike_t2b(fx):
    B = {"loop20_single": [], "one_model_20": []}
    acc_loop = acc_one = viol = 0
    recs = []
    for k, case in enumerate(fx["cases"]):
        buses, (nc,) = instance(case)
        t0 = time.perf_counter(); best = None
        for b in buses:
            if b.gender not in (None, nc.gender): continue
            r = solve([b], [nc], warm=True, time_limit_ms=1000)
            if r.assigned["new"] is not None:
                viol += bool(verify([b], [nc], r))
                c = r.objective
                if best is None or c < best[0]: best = (c, b.bid)
        B["loop20_single"].append((time.perf_counter() - t0) * 1000)
        r, ph = phases(solve, buses, [nc], warm=True, time_limit_ms=1000)
        B["one_model_20"].append(r.seconds * 1000)
        viol += bool(verify(buses, [nc], r))
        acc_loop += best is not None; acc_one += r.assigned["new"] is not None
        recs.append(dict(id=f"one_model/{k}", sig=sig(r), ms=ph))
        recs.append(dict(id=f"loop20/{k}", sig=dict(best=list(best) if best else None)))
    return dict(metrics=dict(loop20_single=dict(ms=B["loop20_single"], accepted=acc_loop),
                             one_model_20=dict(ms=B["one_model_20"], accepted=acc_one), violations=viol, n=len(fx["cases"])),
                cases=recs)


def exact_t2b(fx, ex):
    cases = [instance(c) for c in fx["cases"]]
    for _ in ex.passes():
        for k, (buses, ncs) in enumerate(cases):
            r, ms = phases(solve, buses, ncs, warm=True, time_limit_ms=5000, ls="GUIDED_LOCAL_SEARCH", solution_limit=50)
            ex.record("t2b 20 buses one model, warm GLS sl=50", str(k), sig(r), ms, 5000)


# ---------------------------------------------------------------- t2 C: gender + stay in multi-bus models
def spike_t2c(fx):
    C, recs = {}, []
    for rule in ("gender", "stay"):
        on_v = off_v = n = 0
        for k, case in enumerate(c for c in fx["cases"] if c["rule"] == rule):
            buses, ncs = instance(case)
            r_on, ph = phases(solve, buses, ncs, warm=True, time_limit_ms=300, ls="GUIDED_LOCAL_SEARCH")
            r_off = solve(buses, ncs, rules=ALL_RULES - {rule}, warm=True, time_limit_ms=300, ls="GUIDED_LOCAL_SEARCH")
            key = "gender" if rule == "gender" else "moved"
            on_v += sum(key in x for x in verify(buses, ncs, r_on))
            off_v += sum(key in x for x in verify(buses, ncs, r_off, ALL_RULES))
            n += 1
            recs.append(dict(id=f"{rule}:on/{k}", sig=sig(r_on), ms=ph))
            recs.append(dict(id=f"{rule}:off/{k}", sig=sig(r_off)))
        C[rule] = dict(instances=n, violations_rule_on=on_v, violations_rule_off=off_v)
    empty, (m, f) = instance(fx["empty"])
    r = solve(empty, [m, f], warm=True, time_limit_ms=300)
    r2 = solve(empty, [m, f], warm=True, time_limit_ms=300, gender_types=False)
    C["empty_bus_mixed_newcomers"] = dict(with_type_incompat=r.assigned, without=r2.assigned)
    return dict(metrics=C, cases=recs)


def exact_t2c(fx, ex):
    cases = [(c["rule"], instance(c)) for c in fx["cases"]]
    empty = instance(fx["empty"])
    for _ in ex.passes():
        for k, (rule, (buses, ncs)) in enumerate(cases):
            for tag, rules in (("on", ALL_RULES), ("off", ALL_RULES - {rule})):
                r, ms = phases(solve, buses, ncs, rules=rules, warm=True, time_limit_ms=5000, ls="GUIDED_LOCAL_SEARCH",
                               solution_limit=50)
                ex.record("t2c 6 buses 3 newcomers, warm GLS sl=50", f"{rule}:{tag}/{k}", sig(r), ms, 5000)
        for gt in (True, False):
            r, ms = phases(solve, *empty, warm=True, time_limit_ms=0, gender_types=gt)
            ex.record("t2c empty bus, mixed newcomers, GD", f"gender_types={gt}", sig(r), ms)


# ---------------------------------------------------------------- t2 D: batch 50 requests x 200 buses (+ two-stage)
UNMATCHED = 100_000


def t2d_instance(fx):
    return [bus(b) for b in fx["buses"]], [rider(r) for r in fx["newcomers"]], {k: v for k, v in fx["allowed"].items()}


def pair_costs(buses, ncs, allowed, **kw):
    pairs = {}
    for nc in ncs:
        for i in allowed[nc.rid]:
            b = buses[i]
            base = solve([b], [], warm=True, **kw).objective
            r = solve([b], [nc], warm=True, **kw)
            if r.assigned[nc.rid] is not None: pairs[(nc.rid, i)] = r.objective - base
    return pairs


def mcf_match(pairs, ncs, buses):
    smcf = min_cost_flow.SimpleMinCostFlow()
    R = len(ncs); NB = len(buses); src, sink = R + NB, R + NB + 1
    rid_ix = {nc.rid: j for j, nc in enumerate(ncs)}
    s, e, c, w = [], [], [], []
    for j in range(R): s.append(src); e.append(j); c.append(1); w.append(0)
    for (rid, i), cost in pairs.items(): s.append(rid_ix[rid]); e.append(R + i); c.append(1); w.append(int(cost))
    for j in range(R): s.append(j); e.append(sink); c.append(1); w.append(UNMATCHED)
    for i in range(NB): s.append(R + i); e.append(sink); c.append(1); w.append(0)
    smcf.add_arcs_with_capacity_and_unit_cost(np.array(s), np.array(e), np.array(c), np.array(w))
    sup = np.zeros(R + NB + 2, dtype=np.int64); sup[src] = R; sup[sink] = -R
    smcf.set_nodes_supplies(np.arange(R + NB + 2), sup)
    st = smcf.solve()
    matched = sum(1 for a in range(smcf.num_arcs()) if smcf.flow(a) and R <= smcf.head(a) < R + NB)
    return st.name, matched, smcf.optimal_cost()


def lsa_match(pairs, ncs, buses):
    R = len(ncs); NB = len(buses)
    rid_ix = {nc.rid: j for j, nc in enumerate(ncs)}
    lsa = linear_sum_assignment.SimpleLinearSumAssignment()
    for (rid, i), cost in pairs.items(): lsa.add_arc_with_cost(rid_ix[rid], i, int(cost))
    for j in range(R): lsa.add_arc_with_cost(j, NB + j, UNMATCHED)
    for i in range(NB):
        lsa.add_arc_with_cost(R + i, i, 0)
        for j in range(R): lsa.add_arc_with_cost(R + i, NB + j, 0)
    st = lsa.solve()
    return st.name, sum(1 for j in range(R) if lsa.right_mate(j) < NB), lsa.optimal_cost()


def dense_lsa(costs):
    lsa = linear_sum_assignment.SimpleLinearSumAssignment()
    for j in range(50):
        for i in range(200): lsa.add_arc_with_cost(j, i, int(costs[j][i]))
        lsa.add_arc_with_cost(j, 200 + j, UNMATCHED)
    for i in range(200):
        lsa.add_arc_with_cost(50 + i, i, 0)
        for j in range(50): lsa.add_arc_with_cost(50 + i, 200 + j, 0)
    st = lsa.solve()
    return st.name, lsa.optimal_cost()


def pairs_json(pairs):
    return sorted([rid, i, cost] for (rid, i), cost in pairs.items())


def spike_t2d(fx):
    buses, ncs, allowed = t2d_instance(fx)
    D, recs = {}, []
    for tl in (1000, 3000):
        r, ph = phases(solve, buses, ncs, allowed=allowed, warm=True, time_limit_ms=tl, ls="GUIDED_LOCAL_SEARCH")
        D[f"routing_one_model_tl{tl}"] = dict(ms=round(r.seconds * 1000), matched=sum(v is not None for v in r.assigned.values()),
                                              violations=len(verify(buses, ncs, r)), status=STATUS(r.status))
        recs.append(dict(id=f"one_model_tl{tl}", sig=sig(r), ms=ph))
    t0 = time.perf_counter()
    pairs = pair_costs(buses, ncs, allowed, time_limit_ms=200)
    t_pairs = ms_since(t0)
    t0 = time.perf_counter(); mcf = mcf_match(pairs, ncs, buses); t_mcf = ms_since(t0)
    t0 = time.perf_counter(); lsa = lsa_match(pairs, ncs, buses); t_lsa = ms_since(t0)
    D["two_stage"] = dict(pair_solves=len(ncs) * fx["K"] * 2, feasible_pairs=len(pairs), pair_ms=round(t_pairs),
                          mcf=dict(status=mcf[0], matched=mcf[1], cost=mcf[2], ms=round(t_mcf, 2)),
                          lsa=dict(status=lsa[0], matched=lsa[1], cost=lsa[2], ms=round(t_lsa, 2)))
    recs.append(dict(id="pairs", sig=dict(pairs=pairs_json(pairs))))
    t0 = time.perf_counter(); st3 = dense_lsa(fx["dense_lsa_costs"])
    D["dense_lsa_50x200_ms"] = round(ms_since(t0), 2); D["dense_lsa_status"] = st3[0]; D["dense_lsa_cost"] = st3[1]
    return dict(metrics=D, cases=recs)


def exact_t2d(fx, ex):
    buses, ncs, allowed = t2d_instance(fx)
    for _ in ex.passes():
        if ex.rep <= 1:  # 3 s per solve: one signature pass + one timed pass
            r, ms = phases(solve, buses, ncs, allowed=allowed, warm=True, time_limit_ms=60000, ls="GUIDED_LOCAL_SEARCH",
                           solution_limit=30)
            ex.record("t2d 200 buses x 50 newcomers, warm GLS sl=30", "one_model", sig(r), ms, 60000)
        t0 = time.perf_counter(); pairs = pair_costs(buses, ncs, allowed, time_limit_ms=0)
        ex.record("t2d two-stage: 600 single-bus GD solves", "pairs", dict(pairs=pairs_json(pairs)), [ms_since(t0), 0, 0])
        t0 = time.perf_counter(); mcf = mcf_match(pairs, ncs, buses)
        ex.record("t2d two-stage: min cost flow", "mcf", list(mcf), [ms_since(t0), 0, 0])
        t0 = time.perf_counter(); lsa = lsa_match(pairs, ncs, buses)
        ex.record("t2d two-stage: linear sum assignment", "lsa", list(lsa), [ms_since(t0), 0, 0])
        t0 = time.perf_counter(); d = dense_lsa(fx["dense_lsa_costs"])
        ex.record("t2d dense LSA 250x250", "dense", list(d), [ms_since(t0), 0, 0])


# ---------------------------------------------------------------- t2 E: determinism
T2E_MODES = {"GD tl5000": dict(ls="GREEDY_DESCENT", time_limit_ms=5000),
             "GLS tl300": dict(ls="GUIDED_LOCAL_SEARCH", time_limit_ms=300),
             "GLS solution_limit=200": dict(ls="GUIDED_LOCAL_SEARCH", time_limit_ms=0, solution_limit=200)}


def spike_t2e(fx):
    buses, ncs = instance(fx)
    E, recs = {}, []
    for name, kw in T2E_MODES.items():
        sigs, objs = set(), set()
        for run in range(8):
            r, ph = phases(solve, buses, ncs, warm=True, **kw)
            sigs.add(tuple((v, tuple((x.rid, k) for x, k in st)) for v, st in sorted(r.routes.items())))
            objs.add(r.objective)
            recs.append(dict(id=f"{name}/{run}", sig=sig(r), ms=ph))
        E[name] = dict(runs=8, distinct_plans=len(sigs), distinct_objectives=sorted(objs))
    return dict(metrics=E, cases=recs)


# ---------------------------------------------------------------- t2 F: GIL / threads
def spike_t2f(fx):
    buses, ncs = instance(fx)
    F = {}
    for cb in (False, True):
        ticks = [0]; stop = [False]
        def spin():
            while not stop[0]: ticks[0] += 1
        th = threading.Thread(target=spin); th.start()
        time.sleep(0.2); t_idle0 = ticks[0]; time.sleep(0.5); idle_rate = (ticks[0] - t_idle0) / 0.5
        t0 = ticks[0]; ts = time.perf_counter()
        solve(buses, ncs, warm=True, time_limit_ms=1000, ls="GUIDED_LOCAL_SEARCH", use_callback=cb)
        rate = (ticks[0] - t0) / (time.perf_counter() - ts)
        stop[0] = True; th.join()
        F[f"callback={cb}"] = dict(other_thread_progress_during_solve_pct=round(100 * rate / idle_rate, 1))
    def job(_):
        return solve(buses, ncs, warm=True, time_limit_ms=500, ls="GUIDED_LOCAL_SEARCH").seconds
    for n in (1, 4):
        t0 = time.perf_counter()
        with ThreadPoolExecutor(n) as ex: list(ex.map(job, range(8)))
        F[f"threads={n} 8 solves of 500ms"] = round(time.perf_counter() - t0, 2)
    return dict(metrics=F, cases=[])


# ---------------------------------------------------------------- t3: monthly placement
def t3_data(fx):
    def r(j): return dict(j, p=tuple(j["p"]), d=tuple(j["d"]))
    riders = [r(x) for x in fx["riders"]]
    base = dict(order=[tuple(k) for k in fx["base"]["order"]], times={(a, b): t for a, b, t in fx["base"]["times"]},
                obj=fx["base"]["obj"])
    fixed = {k[0]: base["times"][k] for k in base["order"] if k[1] == "P"}
    return riders, tuple(fx["depot"]), fx["seats"], base, fixed, [r(x) for x in fx["newcomers"]]


def plan_sig(plan, st):
    if plan is None: return dict(status=STATUS(st), plan=None)
    return dict(status=STATUS(st), obj=plan["obj"], order=",".join(a + b for a, b in plan["order"]),
                times=[plan["times"][k] for k in plan["order"]])


def t3_insert(riders, depot, seats, base, fixed, nc, **kw):
    return phases(t3_monthly.build, riders, depot, seats, fixed=fixed, newcomers=[nc], initial=base["order"], **kw)


def spike_t3(fx):
    riders, depot, SEATS, base, fixed, ncs = t3_data(fx)
    check, recs, A = t3_monthly.check, [], {}
    for tl in (200, 1000, 5000):
        (plan, st, secs), ph = phases(t3_monthly.build, riders, depot, SEATS, tl_ms=tl)
        A[f"GLS tl{tl}"] = dict(status=STATUS(st), ms=round(secs * 1000), obj=plan and plan["obj"],
                                violations=len(check(riders, depot, SEATS, plan)) if plan else None)
        recs.append(dict(id=f"nightly tl{tl}", sig=plan_sig(plan, st), ms=ph))
    sigs = set()
    for run in range(3):
        (plan, st, secs), ph = phases(t3_monthly.build, riders, depot, SEATS, tl_ms=0, solution_limit=300)
        sigs.add((plan["obj"], tuple(plan["order"])))
        recs.append(dict(id=f"nightly sl300/{run}", sig=plan_sig(plan, st), ms=ph))
    A["GLS solution_limit=300 x3"] = dict(distinct=len(sigs), ms=round(secs * 1000), obj=[x[0] for x in sigs])
    B = dict(cases=0, ortools_accept=0, oracle_accept=0, false_refusal=0, violations=0, moved_fixed=0, ms=[])
    for c, nc in enumerate(ncs):
        (plan, st, secs), ph = t3_insert(riders, depot, SEATS, base, fixed, nc, tl_ms=500, ls="GREEDY_DESCENT")
        B["ms"].append(secs * 1000); B["cases"] += 1
        acc = plan is not None and ("new", "P") in plan["times"]
        orc = nc["oracle"]
        B["ortools_accept"] += acc; B["oracle_accept"] += orc
        B["false_refusal"] += (orc and not acc)
        if plan:
            B["violations"] += bool(check(riders, depot, SEATS, plan, fixed, [nc]))
            B["moved_fixed"] += sum(plan["times"][(rid, "P")] != t for rid, t in fixed.items())
        recs.append(dict(id=f"insert/{c}", sig=plan_sig(plan, st), ms=ph))
    return dict(metrics=dict(nightly_order_40=A, newcomer_insertion_40=B), cases=recs)


def exact_t3(fx, ex):
    riders, depot, SEATS, base, fixed, ncs = t3_data(fx)
    for _ in ex.passes():
        (plan, st, _), ms = phases(t3_monthly.build, riders, depot, SEATS, tl_ms=60000, solution_limit=50)
        ex.record("t3 nightly order 40 riders, GLS sl=50", "nightly", plan_sig(plan, st), ms, 60000)
        for c, nc in enumerate(ncs):
            (plan, st, _), ms = t3_insert(riders, depot, SEATS, base, fixed, nc, tl_ms=0, ls="GREEDY_DESCENT")
            ex.record("t3 newcomer insertion, fixed times, warm GD", str(c), plan_sig(plan, st), ms)


# ---------------------------------------------------------------- t4: threads vs processes (spikes/ortools/t4_gil.py)
def tsp(seed=1, n=150, tl=1000, sl=None):
    pts = FX_T4["points"][str(seed)][:n]
    M = [[int(abs(a[0]-b[0])*100+abs(a[1]-b[1])*100) for b in pts] for a in pts]
    m = pywrapcp.RoutingIndexManager(n, 1, 0); r = pywrapcp.RoutingModel(m)
    t = r.RegisterTransitMatrix(M); r.SetArcCostEvaluatorOfAllVehicles(t)
    p = pywrapcp.DefaultRoutingSearchParameters()
    p.local_search_metaheuristic = routing_enums_pb2.LocalSearchMetaheuristic.GUIDED_LOCAL_SEARCH
    if tl: p.time_limit.FromMilliseconds(tl)
    if sl: p.solution_limit = sl
    r.CloseModelWithParameters(p)
    return r, p


def job(seed):
    r, p = tsp(seed); t0 = time.perf_counter(); r.SolveWithParameters(p); return time.perf_counter() - t0


def spike_t4(fx):
    out = {}
    ticks = [0]; stop = [False]
    def spin():
        while not stop[0]: ticks[0] += 1
    th = threading.Thread(target=spin); th.start()
    time.sleep(0.3); a = ticks[0]; time.sleep(1.0); idle = ticks[0] - a
    r, p = tsp()
    a = ticks[0]; t0 = time.perf_counter(); r.SolveWithParameters(p); dt = time.perf_counter() - t0; b = ticks[0]
    stop[0] = True; th.join()
    out["other_thread_progress_during_SolveWithParameters_pct"] = round(100 * (b - a) / dt / idle, 1)
    for n in (1, 4):
        t0 = time.perf_counter()
        with ThreadPoolExecutor(n) as ex: list(ex.map(job, range(8)))
        out[f"threads={n}: 8 x 1s solves wall s"] = round(time.perf_counter() - t0, 2)
        t0 = time.perf_counter()
        with ProcessPoolExecutor(n, initializer=_init_worker, initargs=(FIXTURES,)) as ex: list(ex.map(job, range(8)))
        out[f"processes={n}: 8 x 1s solves wall s"] = round(time.perf_counter() - t0, 2)
    return dict(metrics=out, cases=[])


def exact_t4(fx, ex):
    """The TSP models with GLS sl=100 instead of 1 s, for parity and build / solve / read latency."""
    for _ in ex.passes():
        for seed in range(8):
            t0 = time.perf_counter()
            r, p = tsp(seed, tl=10000, sl=100)
            t1 = time.perf_counter(); sol = r.SolveWithParameters(p); t2 = time.perf_counter()
            route, i = [], sol.Value(r.NextVar(r.Start(0)))
            while not r.IsEnd(i): route.append(i); i = sol.Value(r.NextVar(i))
            ms = [(t1 - t0) * 1e3, (t2 - t1) * 1e3, ms_since(t2)]
            ex.record("t4 TSP 150 nodes, GLS sl=100", str(seed),
                      dict(status=STATUS(r.status()), objective=sol.ObjectiveValue(), route=route), ms, 10000)


FX_T4 = None


def _init_worker(fixtures):
    global FIXTURES, FX_T4
    FIXTURES = fixtures
    FX_T4 = load("t4")


# ---------------------------------------------------------------- t5: determinism under load (t5_det.py)
def t5_build():
    fx = load("t2d")
    buses, ncs, allowed = t2d_instance(fx)
    return buses, ncs, allowed


def t5_run(kind):
    buses, ncs, allowed = t5_build()
    if kind == "tl": r = solve(buses, ncs, allowed=allowed, warm=True, time_limit_ms=2000, ls="GUIDED_LOCAL_SEARCH")
    else: r = solve(buses, ncs, allowed=allowed, warm=True, time_limit_ms=0, solution_limit=30, ls="GUIDED_LOCAL_SEARCH")
    return (r.objective, sum(v is not None for v in r.assigned.values()), round(r.seconds, 2), sig(r)["routes"])


def spike_t5(fx):
    out, recs = {}, []
    for kind in ("tl", "sl"):
        alone = [t5_run(kind) for _ in range(2)]
        with ProcessPoolExecutor(6, initializer=_init_worker, initargs=(FIXTURES,)) as ex:
            loaded = list(ex.map(t5_run, [kind] * 6))
        out[kind] = dict(alone=[x[:3] for x in alone], loaded_6_parallel=[x[:3] for x in loaded])
        for j, x in enumerate(alone + loaded):
            recs.append(dict(id=f"{kind}/{'alone' if j < 2 else 'loaded'}{j}", sig=dict(objective=x[0], matched=x[1], routes=x[3])))
    return dict(metrics=out, cases=recs)


# ---------------------------------------------------------------- t6: rescue + intercity (t6_rescue_intercity.py)
def rescue_mcf(fx):
    runs, buses = fx["runs"], fx["buses"]
    k, m = len(runs), len(buses)
    UNASSIGNED = 10_000_000
    smcf = min_cost_flow.SimpleMinCostFlow()
    src, sink = k + m, k + m + 1
    s, e, c, w = [], [], [], []
    for i, r in enumerate(runs):
        s.append(src); e.append(i); c.append(1); w.append(0)
        s.append(i); e.append(sink); c.append(1); w.append(UNASSIGNED)
        for j, b in enumerate(buses):
            if b["has_pos"] and b["seats"] >= r["need"]:
                s.append(i); e.append(k + j); c.append(1); w.append(tt(b["pos"], r["ref"]))
    for j in range(m): s.append(k + j); e.append(sink); c.append(1); w.append(0)
    smcf.add_arcs_with_capacity_and_unit_cost(np.array(s), np.array(e), np.array(c), np.array(w))
    sup = np.zeros(k + m + 2, dtype=np.int64); sup[src] = k; sup[sink] = -k
    smcf.set_nodes_supplies(np.arange(k + m + 2), sup)
    st = smcf.solve()
    pick = {smcf.tail(a): smcf.head(a) - k for a in range(smcf.num_arcs()) if smcf.flow(a) and k <= smcf.head(a) < k + m}
    ok = all(buses[j]["seats"] >= runs[i]["need"] and buses[j]["has_pos"] for i, j in pick.items())
    return dict(status=st.name, assigned=len(pick), seats_ok=ok, distinct_buses=len(set(pick.values())) == len(pick),
                cost=smcf.optimal_cost(), pick=sorted([i, j] for i, j in pick.items()))


def locked_order(fx, sp_kw):
    pts, fixed_order = fx["lock_points"], fx["fixed_order"]
    n = len(pts)
    M = [[tt(a, b) for b in pts] for a in pts]
    man = pywrapcp.RoutingIndexManager(n, 1, [0], [n - 1])
    rt = pywrapcp.RoutingModel(man)
    cb = rt.RegisterTransitMatrix(M); rt.SetArcCostEvaluatorOfAllVehicles(cb)
    sp = params(**sp_kw)
    okl_open = rt.ApplyLocksToAllVehicles([[man.NodeToIndex(x) for x in fixed_order]], True)
    rt.CloseModelWithParameters(sp)
    okl = rt.ApplyLocksToAllVehicles([[man.NodeToIndex(x) for x in fixed_order]], True)
    sol = rt.SolveWithParameters(sp)
    route = []; i = sol.Value(rt.NextVar(rt.Start(0)))
    while not rt.IsEnd(i): route.append(man.IndexToNode(i)); i = sol.Value(rt.NextVar(i))
    rt2 = pywrapcp.RoutingModel(pywrapcp.RoutingIndexManager(n, 1, [0], [n - 1]))
    cb2 = rt2.RegisterTransitMatrix(M); rt2.SetArcCostEvaluatorOfAllVehicles(cb2)
    sol2 = rt2.SolveWithParameters(sp)
    return dict(apply_locks_before_close=okl_open, apply_locks_ok=okl, order_kept=route == fixed_order,
                locked_cost=sol.ObjectiveValue(), free_cost=sol2.ObjectiveValue())


def params(tl=0, sl=0, first=None):
    sp = pywrapcp.DefaultRoutingSearchParameters()
    if tl: sp.time_limit.FromMilliseconds(tl)
    if sl: sp.solution_limit = sl
    if first: sp.first_solution_strategy = getattr(routing_enums_pb2.FirstSolutionStrategy, first)
    sp.local_search_metaheuristic = routing_enums_pb2.LocalSearchMetaheuristic.GUIDED_LOCAL_SEARCH
    return sp


def open_path(points, start, end, **sp_kw):
    t0 = time.perf_counter()
    pts = [start] + points + [end]; n = len(pts)
    M = [[tt(a, b) for b in pts] for a in pts]
    man = pywrapcp.RoutingIndexManager(n, 1, [0], [n - 1]); rt = pywrapcp.RoutingModel(man)
    cb = rt.RegisterTransitMatrix(M); rt.SetArcCostEvaluatorOfAllVehicles(cb)
    sp = params(**sp_kw)
    t1 = time.perf_counter(); sol = rt.SolveWithParameters(sp); t2 = time.perf_counter()
    obj = sol.ObjectiveValue()
    return obj, round((t2 - t1) * 1000), [(t1 - t0) * 1e3, (t2 - t1) * 1e3, ms_since(t2)]


def pd_model(A, B, **sp_kw):
    t0 = time.perf_counter()
    pts = [(8, 8), (408, 8)] + [x for pair in zip(A, B) for x in pair]
    n = len(pts); M = [[tt(a, b) for b in pts] for a in pts]
    man = pywrapcp.RoutingIndexManager(n, 1, [0], [1]); rt = pywrapcp.RoutingModel(man)
    cb = rt.RegisterTransitMatrix(M); rt.SetArcCostEvaluatorOfAllVehicles(cb)
    rt.AddDimension(cb, 0, 10**7, True, "Time"); Tm = rt.GetDimensionOrDie("Time"); s_ = rt.solver()
    for q in range(40):
        p, d = man.NodeToIndex(2 + 2 * q), man.NodeToIndex(3 + 2 * q)
        rt.AddPickupAndDelivery(p, d); s_.Add(rt.VehicleVar(p) == rt.VehicleVar(d)); s_.Add(Tm.CumulVar(p) <= Tm.CumulVar(d))
    sp = params(first="PARALLEL_CHEAPEST_INSERTION", **sp_kw)
    t1 = time.perf_counter(); sol = rt.SolveWithParameters(sp); t2 = time.perf_counter()
    obj = sol.ObjectiveValue() if sol else None
    return obj, round((t2 - t1) * 1000), [(t1 - t0) * 1e3, (t2 - t1) * 1e3, ms_since(t2)]


def spike_t6(fx):
    out = {}
    t0 = time.perf_counter(); res = rescue_mcf(fx); res["ms"] = round(ms_since(t0), 2)
    out["rescue_mcf_5x30"] = res
    out["rescue_locked_order"] = locked_order(fx, dict(tl=500))
    A, B = [tuple(p) for p in fx["A"]], [tuple(p) for p in fx["B"]]
    IC = {}
    for tl in (200, 1000):
        IC[f"pickup tour tl{tl}"] = open_path(A, (8, 8), (16, 8), tl=tl)[:2]
        IC[f"drop tour tl{tl}"] = open_path(B, (400, 8), (408, 8), tl=tl)[:2]
    IC["one P&D model 40 pairs tl1000"] = pd_model(A, B, tl=1000)[:2]
    out["intercity_40"] = IC
    return dict(metrics=out, cases=[])


def exact_t6(fx, ex):
    A, B = [tuple(p) for p in fx["A"]], [tuple(p) for p in fx["B"]]
    for _ in ex.passes():
        t0 = time.perf_counter(); res = rescue_mcf(fx)
        ex.record("t6 rescue min cost flow 5x30", "mcf", res, [ms_since(t0), 0, 0])
        t0 = time.perf_counter(); res = locked_order(fx, dict(sl=100, tl=10000))
        ex.record("t6 locked order, 2 models, GLS sl=100", "locks", res, [ms_since(t0), 0, 0])
        obj, _, ms = open_path(A, (8, 8), (16, 8), sl=200, tl=10000)
        ex.record("t6 intercity tour 42 nodes, GLS sl=200", "pickup", obj, ms, 10000)
        obj, _, ms = open_path(B, (400, 8), (408, 8), sl=200, tl=10000)
        ex.record("t6 intercity tour 42 nodes, GLS sl=200", "drop", obj, ms, 10000)
        obj, _, ms = pd_model(A, B, sl=100, tl=60000)
        ex.record("t6 intercity 40 P&D pairs, GLS sl=100", "pd", obj, ms, 60000)


# ---------------------------------------------------------------- CP-SAT (stack/gil_cpsat.py)
def cpsat(seed=0, max_time=0.3, fixed_seed=False):
    """Returns (status, objective, values, [build, solve, read] ms)."""
    t0 = time.perf_counter()
    costs = FX_CPSAT["costs"][str(seed)]; n = FX_CPSAT["n"]
    m = cp_model.CpModel(); x = [[m.new_bool_var("") for _ in range(n)] for _ in range(n)]
    for i in range(n): m.add_exactly_one(x[i]); m.add_exactly_one(x[j][i] for j in range(n))
    m.minimize(sum(costs[i][j] * x[i][j] for i in range(n) for j in range(n)))
    s = cp_model.CpSolver(); s.parameters.num_workers = 1
    if max_time: s.parameters.max_time_in_seconds = max_time
    if fixed_seed: s.parameters.random_seed = 1
    t1 = time.perf_counter(); st = s.solve(m); t2 = time.perf_counter()
    vals = [j for i in range(n) for j in range(n) if s.boolean_value(x[i][j])]
    return s.status_name(st), s.objective_value, vals, [(t1 - t0) * 1e3, (t2 - t1) * 1e3, ms_since(t2)]


FX_CPSAT = None


def probe(fn):
    """stack/gil2.py's heartbeat probe: a thread ticks every 1 ms; returns (elapsed s, worst gap ms)."""
    gaps, stop = [], threading.Event()
    def hb():
        last = time.perf_counter()
        while not stop.is_set():
            time.sleep(0.001); now = time.perf_counter(); gaps.append(now - last); last = now
    t = threading.Thread(target=hb); t.start()
    t0 = time.perf_counter(); fn(); el = time.perf_counter() - t0
    stop.set(); t.join()
    return el, max(gaps) * 1000


def spike_cpsat(fx):
    global FX_CPSAT
    FX_CPSAT = fx
    one, g1 = probe(cpsat)
    par, g4 = probe(lambda: list(ThreadPoolExecutor(4).map(cpsat, range(4))))
    return dict(metrics=dict(one_ms=round(one * 1000), one_maxgap_ms=round(g1, 1), threads4_ms=round(par * 1000),
                             threads4_maxgap_ms=round(g4, 1)), cases=[])


def exact_cpsat(fx, ex):
    global FX_CPSAT
    FX_CPSAT = fx
    for _ in ex.passes():
        for seed in range(4):
            st, obj, vals, ms = cpsat(seed, max_time=0, fixed_seed=True)
            ex.record("CP-SAT 40x40 assignment, 1 worker, to optimality", str(seed), dict(status=st, objective=obj, values=vals), ms)


# ---------------------------------------------------------------- non-dispatch modules
def knapsack(d, kind):
    from ortools.algorithms.python import knapsack_solver
    t0 = time.perf_counter()
    s = knapsack_solver.KnapsackSolver(getattr(knapsack_solver.SolverType, kind), "kp")
    s.init(d["profits"], d["weights"], d["capacities"])
    t1 = time.perf_counter(); profit = s.solve(); t2 = time.perf_counter()
    sel = [i for i in range(len(d["profits"])) if s.best_solution_contains(i)]
    return dict(profit=profit, selected=sel), [(t1 - t0) * 1e3, (t2 - t1) * 1e3, ms_since(t2)]


def set_cover_greedy_steepest(d):
    from ortools.set_cover.python import set_cover
    t0 = time.perf_counter()
    m = set_cover.SetCoverModel()
    for cost, elements in d["subsets"]:
        m.add_empty_subset(cost)
        for e in elements: m.add_element_to_last_subset(e)
    inv = set_cover.SetCoverInvariant(m)
    t1 = time.perf_counter()
    set_cover.GreedySolutionGenerator(inv).next_solution()
    set_cover.SteepestSearch(inv).next_solution()
    t2 = time.perf_counter()
    out = dict(cost=inv.cost(), selected=[i for i, x in enumerate(inv.is_selected()) if x])
    return out, [(t1 - t0) * 1e3, (t2 - t1) * 1e3, ms_since(t2)]


def max_flow_solve(d):
    from ortools.graph.python import max_flow
    t0 = time.perf_counter()
    f = max_flow.SimpleMaxFlow()
    f.add_arcs_with_capacity(np.array(d["tails"]), np.array(d["heads"]), np.array(d["caps"]))
    t1 = time.perf_counter(); st = f.solve(0, d["nodes"] - 1); t2 = time.perf_counter()
    flows = f.flows(np.arange(f.num_arcs()))
    checksum = int(sum((i + 1) * int(x) for i, x in enumerate(flows)) % 1_000_000_007)
    return dict(status=st.name, flow=f.optimal_flow(), checksum=checksum), [(t1 - t0) * 1e3, (t2 - t1) * 1e3, ms_since(t2)]


def mathopt_transport(d):
    from ortools.math_opt.python import mathopt
    t0 = time.perf_counter()
    S, D = len(d["supply"]), len(d["demand"])
    m = mathopt.Model(name="transport")
    x = [[m.add_variable(lb=0.0) for _ in range(D)] for _ in range(S)]
    for i in range(S): m.add_linear_constraint(mathopt.fast_sum(x[i]) <= d["supply"][i])
    for j in range(D): m.add_linear_constraint(mathopt.fast_sum(x[i][j] for i in range(S)) >= d["demand"][j])
    m.minimize(mathopt.fast_sum(d["cost"][i][j] * x[i][j] for i in range(S) for j in range(D)))
    t1 = time.perf_counter(); r = mathopt.solve(m, mathopt.SolverType.GLOP); t2 = time.perf_counter()
    total = sum(r.variable_values([v for row in x for v in row]))
    return dict(reason=r.termination.reason.name, objective=round(r.objective_value(), 6), shipped=round(total, 6)), \
        [(t1 - t0) * 1e3, (t2 - t1) * 1e3, ms_since(t2)]


def mathopt_knapsack(d):
    from ortools.math_opt.python import mathopt
    t0 = time.perf_counter()
    n = len(d["profits"])
    m = mathopt.Model(name="knapsack")
    x = [m.add_binary_variable() for _ in range(n)]
    for w, cap in zip(d["weights"], d["capacities"]):
        m.add_linear_constraint(mathopt.fast_sum(w[i] * x[i] for i in range(n)) <= cap)
    m.maximize(mathopt.fast_sum(d["profits"][i] * x[i] for i in range(n)))
    params = mathopt.SolveParameters(threads=1, random_seed=1)
    t1 = time.perf_counter(); r = mathopt.solve(m, mathopt.SolverType.CP_SAT, params=params); t2 = time.perf_counter()
    return dict(reason=r.termination.reason.name, objective=round(r.objective_value(), 6)), [(t1 - t0) * 1e3, (t2 - t1) * 1e3, ms_since(t2)]


def exact_modules(fx, ex):
    for _ in ex.passes():
        ex.record("knapsack 60 items x 3 dims, branch and bound", "md",
                  *knapsack(fx["knapsack_md"], "KNAPSACK_MULTIDIMENSION_BRANCH_AND_BOUND_SOLVER"))
        ex.record("knapsack 500 items, dynamic programming", "dp",
                  *knapsack(fx["knapsack_dp"], "KNAPSACK_DYNAMIC_PROGRAMMING_SOLVER"))
        ex.record("set cover 1000 x 6000, greedy + steepest", "cover", *set_cover_greedy_steepest(fx["set_cover"]))
        ex.record("max flow 5000 nodes x 50000 arcs", "flow", *max_flow_solve(fx["max_flow"]))
        ex.record("math_opt transport 100x100 LP, GLOP", "lp", *mathopt_transport(fx["transport"]))
        ex.record("math_opt knapsack 60x3 MIP, CP-SAT 1 thread", "mip", *mathopt_knapsack(fx["knapsack_md"]))


# ---------------------------------------------------------------- main
SUITES = {
    "t1": (spike_t1, exact_t1), "t2a": (spike_t2a, exact_t2a), "t2b": (spike_t2b, exact_t2b),
    "t2c": (spike_t2c, exact_t2c), "t2d": (spike_t2d, exact_t2d), "t2e": (spike_t2e, None), "t2f": (spike_t2f, None),
    "t3": (spike_t3, exact_t3), "t4": (spike_t4, exact_t4), "t5": (spike_t5, None), "t6": (spike_t6, exact_t6),
    "cpsat": (spike_cpsat, exact_cpsat), "modules": (None, exact_modules),
}
FIXTURE_OF = {"t5": "t2d"}


def main():
    global FIXTURES
    suite, flavor = sys.argv[1], sys.argv[2]
    repeats = int(sys.argv[3]) if len(sys.argv) > 3 else 5
    if len(sys.argv) > 4: FIXTURES = os.path.abspath(sys.argv[4])
    _init_worker(FIXTURES)
    spike, exact = SUITES[suite]
    fx = load(FIXTURE_OF.get(suite, suite))
    out = dict(suite=suite, flavor=flavor, runtime="python", ortools=ortools.__version__, python=sys.version.split()[0],
               mode=allowed_mode(), fixture_meta=fx.get("meta"))
    t0 = time.perf_counter()
    if flavor == "spike" and spike is not None:
        out.update(spike(fx))
    elif flavor == "spike" or exact is None:
        raise SystemExit(f"{suite} has no {flavor} flavor")
    else:
        ex = Exact(repeats); exact(fx, ex); out.update(ex.result()); out["repeats"] = repeats
    out["wall_s"] = round(time.perf_counter() - t0, 2)
    json.dump(out, sys.stdout, separators=(",", ":"))
    print()


if __name__ == "__main__":
    main()
