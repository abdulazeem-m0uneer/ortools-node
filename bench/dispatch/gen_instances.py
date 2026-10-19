"""Writes the caby-dispatch spike instances to JSON fixtures, so Python and Node solve IDENTICAL inputs.

Usage: python -I -B bench/dispatch/gen_instances.py [out_dir [name ...]]   (default: bench/dispatch/fixtures, all)
The generators are imported from $CABY_DISPATCH_DIR/spikes/ortools (read-only; no bytecode is written
there). Every seed and draw order matches the spike that consumes the instance; Python's and JS's RNGs
differ, so Node never generates instances itself.

t3's base plan comes from a time-limited solve (as in the spike), so it is solved once here and stored.
"""

import json
import os
import random
import subprocess
import sys

sys.dont_write_bytecode = True
SPIKES = os.path.join(os.environ.get("CABY_DISPATCH_DIR", "/mnt/5DBFBA707C791990/Projects/CABY/caby-dispatch"), "spikes")
sys.path.insert(0, os.path.join(SPIKES, "ortools"))

import numpy as np  # noqa: E402
import ortools  # noqa: E402
from caby_model import (  # noqa: E402
    ALL_RULES, Bus, make_bus, make_corridor_newcomer, make_newcomer, oracle_feasible, tt,
)
import t3_monthly  # noqa: E402

FORMAT = 1


# ---------------------------------------------------------------- serialisation
def rider_json(r):
    return dict(rid=r.rid, drop=list(r.drop), pick=list(r.pick) if r.pick is not None else None, seats=r.seats,
                gender=r.gender, direct=r.direct, boarded_at=r.boarded_at, promise_pick=r.promise_pick,
                promise_drop=r.promise_drop)


def bus_json(b):
    return dict(bid=b.bid, pos=list(b.pos), seats=b.seats, aboard=[rider_json(r) for r in b.aboard],
                waiting=[rider_json(r) for r in b.waiting], plan=[[r.rid, k] for r, k in b.plan], base_end=b.base_end)


# ---------------------------------------------------------------- t2's fleet() (t2 runs its experiments on import)
def fleet(rng, nb, na, nw, seats=14, spread=3, genders="MF", center=(15, 15)):
    out = []
    for i in range(nb):
        while True:
            try:
                out.append(make_bus(rng, i, rng.randint(0, na), rng.randint(0, nw), seats=seats, spread=spread,
                                    gender=rng.choice(genders), center=center)); break
            except RuntimeError: pass
    return out


# ---------------------------------------------------------------- per spike
def gen_t1(seed=7):
    """t1_rules_single_bus.py's search loop, with the oracle verdicts stored."""
    rng = random.Random(seed)
    RULES = ["seats", "cap", "detour", "delay", "wait"]
    want = 25
    cases, binding, accepts, refusals = [], {r: [] for r in RULES}, [], []
    tries = 0
    while (min(len(v) for v in binding.values()) < want or len(accepts) < 300) and tries < 60000:
        tries += 1
        na, nw = rng.randint(0, 3), rng.randint(0, 2)
        seats = rng.choice([2, 3, 3, 4, 14])
        if na + nw > seats: continue
        try:
            b = make_bus(rng, 0, na, nw, seats=seats, spread=rng.choice([1.5, 3, 5]))
        except RuntimeError:
            continue
        nc = make_newcomer(rng, "new", b.pos, spread=rng.choice([1.5, 3, 5, 7]), gender=b.gender or "M")
        full = oracle_feasible(b, nc)
        if full:
            if len(accepts) < 300:
                accepts.append(len(cases)); cases.append(dict(bus=bus_json(b), newcomer=rider_json(nc)))
            continue
        refusals.append(len(cases)); cases.append(dict(bus=bus_json(b), newcomer=rider_json(nc)))
        for R in RULES:
            if len(binding[R]) < want and oracle_feasible(b, nc, ALL_RULES - {R}):
                binding[R].append(refusals[-1])
    return dict(seed=seed, tries=tries, rules=RULES, cases=cases, binding=binding, accepts=accepts, refusals=refusals)


def gen_t2a(seed=11):
    rng = random.Random(seed)
    cases = []
    while len(cases) < 300:
        try: b = make_bus(rng, 0, 4, 4, seats=14, spread=3)
        except RuntimeError: continue
        cases.append(dict(bus=bus_json(b), newcomer=rider_json(make_corridor_newcomer(rng, "new", b))))
    return dict(seed=seed, corridor=True, cases=cases)


def gen_t2b(seed=21):
    rng = random.Random(seed)
    cases = []
    for _ in range(60):
        buses = fleet(rng, 20, 4, 2)
        nc = make_corridor_newcomer(rng, "new", rng.choice([b for b in buses if b.plan]), gender=rng.choice("MF"))
        cases.append(dict(buses=[bus_json(b) for b in buses], newcomers=[rider_json(nc)]))
    return dict(seed=seed, cases=cases)


def gen_t2c(seed=31, empty_seed=5):
    rng = random.Random(seed)
    cases = []
    for rule in ("gender", "stay"):
        for _ in range(80):
            buses = fleet(rng, 6, 3, 3, seats=rng.choice([4, 6, 14]), spread=2)
            ncs = [make_newcomer(rng, f"n{i}", (15, 15), spread=2, gender=rng.choice("MF")) for i in range(3)]
            cases.append(dict(rule=rule, buses=[bus_json(b) for b in buses], newcomers=[rider_json(r) for r in ncs]))
    rng = random.Random(empty_seed)
    m = make_newcomer(rng, "m", (15, 15), 1, "M"); f = make_newcomer(rng, "f", (15, 15), 1, "F")
    empty = dict(buses=[bus_json(Bus(0, (15, 15), 2))], newcomers=[rider_json(m), rider_json(f)])
    return dict(seed=seed, empty_seed=empty_seed, cases=cases, empty=empty)


def gen_t2d(seed=41, K=6):
    """t2 part D; t5_det.py's build() draws the same instance."""
    rng = random.Random(seed)
    buses = fleet(rng, 200, 2, 1, seats=14, spread=10, center=(25, 25))
    ncs = [make_newcomer(rng, f"n{i}", (25, 25), spread=10, gender=rng.choice("MF")) for i in range(50)]
    allowed = {}
    for nc in ncs:
        ok = [i for i, b in enumerate(buses) if b.gender in (None, nc.gender)]
        ok.sort(key=lambda i: tt(buses[i].pos, nc.pick))
        allowed[nc.rid] = ok[:K]
    dense = np.random.default_rng(1).integers(0, 5000, size=(50, 200))
    return dict(seed=seed, K=K, buses=[bus_json(b) for b in buses], newcomers=[rider_json(r) for r in ncs],
                allowed=allowed, dense_lsa_costs=dense.tolist())


def gen_fleet5(seed):
    """t2 parts E (seed 51) and F (seed 61)."""
    rng = random.Random(seed)
    buses = fleet(rng, 20, 4, 2)
    ncs = [make_newcomer(rng, f"n{i}", (15, 15), spread=3, gender=rng.choice("MF")) for i in range(5)]
    return dict(seed=seed, buses=[bus_json(b) for b in buses], newcomers=[rider_json(r) for r in ncs])


def gen_t3(seed=71, seed2=72):
    rng = random.Random(seed)
    depot = (8, 8)
    riders = t3_monthly.gen_group(rng, 40)
    SEATS = 45
    base, st, _ = t3_monthly.build(riders, depot, SEATS, tl_ms=5000)
    assert not t3_monthly.check(riders, depot, SEATS, base)
    fixed = {k[0]: base["times"][k] for k in base["order"] if k[1] == "P"}
    rng2 = random.Random(seed2)
    newcomers = []
    for _ in range(200):
        far = rng2.random() < 0.4
        nc = t3_monthly.gen_group(rng2, 1, home=(10, 10) if not far else (7, 13), k_pick=1, k_drop=1, hs=1.2)[0]
        nc["rid"] = "new"
        if rng2.random() < 0.3: nc["req"] = 3600 + rng2.randint(-2400, 4200)
        nc["oracle"] = t3_monthly.insertion_oracle(riders, depot, SEATS, base, fixed, nc)
        newcomers.append(nc)
    j = lambda r: dict(r, p=list(r["p"]), d=list(r["d"]))  # noqa: E731
    return dict(seed=seed, seed2=seed2, depot=list(depot), seats=SEATS, riders=[j(r) for r in riders],
                base=dict(order=[list(k) for k in base["order"]], times=[[k[0], k[1], base["times"][k]] for k in base["order"]],
                          obj=base["obj"]),
                newcomers=[j(r) for r in newcomers])


def gen_t4():
    """t4_gil.py's tsp(seed): 150 random points per seed; job() uses seeds 0..7, the GIL probe seed 1."""
    out = {}
    for seed in range(8):
        rng = random.Random(seed)
        out[str(seed)] = [[rng.random() * 30, rng.random() * 30] for _ in range(150)]
    return dict(n=150, points=out)


def gen_t6(seed=81):
    rng = random.Random(seed)
    k, m = 5, 30
    runs = [dict(ref=[rng.uniform(0, 30), rng.uniform(0, 30)], need=rng.randint(3, 14)) for _ in range(k)]
    buses = [dict(pos=[rng.uniform(0, 30), rng.uniform(0, 30)], seats=rng.choice([11, 14, 18]), has_pos=rng.random() > 0.05)
             for _ in range(m)]
    n = 12
    pts = [[rng.uniform(0, 10), rng.uniform(0, 10)] for _ in range(n)]
    fixed_order = list(range(1, n - 1)); rng.shuffle(fixed_order)
    A = [[rng.uniform(0, 16), rng.uniform(0, 16)] for _ in range(40)]
    B = [[400 + rng.uniform(0, 16), rng.uniform(0, 16)] for _ in range(40)]
    return dict(seed=seed, runs=runs, buses=buses, lock_points=pts, fixed_order=fixed_order, A=A, B=B)


def gen_cpsat(n=40):
    """stack/gil_cpsat.py's cpsat(seed) objective coefficients, row-major, seeds 0..3."""
    out = {}
    for seed in range(4):
        rnd = random.Random(seed)
        out[str(seed)] = [[rnd.randint(1, 1000) for _ in range(n)] for _ in range(n)]
    return dict(n=n, costs=out)


def gen_modules(seed=91):
    """The non-dispatch modules: knapsack, set cover, max flow and math_opt instances."""
    rng = random.Random(seed)
    n, dims = 60, 3
    mk = dict(profits=[rng.randint(1, 100) for _ in range(n)], weights=[[rng.randint(1, 50) for _ in range(n)] for _ in range(dims)])
    mk["capacities"] = [sum(w) // 3 for w in mk["weights"]]
    n = 500
    dp = dict(profits=[rng.randint(1, 1000) for _ in range(n)], weights=[[rng.randint(1, 100) for _ in range(n)]])
    dp["capacities"] = [sum(dp["weights"][0]) // 4]
    elements, subsets = 1000, 5000
    cover = [[rng.randint(1, 100), sorted(rng.sample(range(elements), 10))] for _ in range(subsets)]
    cover += [[1000, [e]] for e in range(elements)]  # singletons keep every element coverable
    nodes, arcs = 5000, 50000
    flow = dict(nodes=nodes, tails=[], heads=[], caps=[])
    for _ in range(arcs):
        t, h = rng.randrange(nodes), rng.randrange(nodes)
        if t == h: continue
        flow["tails"].append(t); flow["heads"].append(h); flow["caps"].append(rng.randint(1, 1000))
    S, D = 100, 100
    lp = dict(supply=[rng.randint(50, 150) for _ in range(S)], demand=[rng.randint(1, 100) for _ in range(D)],
              cost=[[rng.randint(1, 100) for _ in range(D)] for _ in range(S)])
    return dict(seed=seed, knapsack_md=mk, knapsack_dp=dp, set_cover=dict(elements=elements, subsets=cover),
                max_flow=flow, transport=lp)


GENERATORS = dict(t1=gen_t1, t2a=gen_t2a, t2b=gen_t2b, t2c=gen_t2c, t2d=gen_t2d, t2e=lambda: gen_fleet5(51),
                  t2f=lambda: gen_fleet5(61), t3=gen_t3, t4=gen_t4, t6=gen_t6, cpsat=gen_cpsat, modules=gen_modules)


def spikes_revision():
    try:
        return subprocess.run(["git", "-C", SPIKES, "rev-parse", "--short", "HEAD"], capture_output=True, text=True,
                              check=True).stdout.strip()
    except (OSError, subprocess.CalledProcessError):
        return None


def main():
    out_dir = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(os.path.abspath(__file__)), "fixtures")
    os.makedirs(out_dir, exist_ok=True)
    meta = dict(format=FORMAT, spikes_revision=spikes_revision(), python=sys.version.split()[0],
                ortools=ortools.__version__, note="t3.base is a 5 s GLS solve on the generating ortools")
    names = sys.argv[2:] or list(GENERATORS)
    for name in names:
        gen = GENERATORS[name]
        data = dict(meta=meta, **gen())
        with open(os.path.join(out_dir, f"{name}.json"), "w") as fh:
            json.dump(data, fh, separators=(",", ":"))
        print(name, os.path.getsize(os.path.join(out_dir, f"{name}.json")), "bytes", flush=True)


if __name__ == "__main__":
    main()
