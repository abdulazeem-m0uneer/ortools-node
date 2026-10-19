'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { setCover } = require('..');

const {
  SetCoverModel, SetCoverInvariant, TrivialSolutionGenerator, RandomSolutionGenerator, GreedySolutionGenerator,
  ElementDegreeSolutionGenerator, LazyElementDegreeSolutionGenerator, SteepestSearch, GuidedLocalSearch,
  GuidedTabuSearch, SetCoverMip, SetCoverMipSolver, clearRandomSubsets, clearMostCoveredElements,
} = setCover;

// Elements 0..5. The optimum is subsets 0 and 2 (cost 5); greedy picks 0, 2 and 4 (cost 6).
function smallModel() {
  const model = new SetCoverModel('small');
  const subsets = [[3, [0, 1, 2]], [2, [2, 3]], [2, [3, 4, 5]], [4, [0, 5]], [1, [1]], [5, [0, 1, 2, 3, 4, 5]]];
  for (const [cost, elements] of subsets) {
    model.addEmptySubset(cost);
    for (const element of elements) model.addElementToLastSubset(element);
  }
  return model;
}

// A reproducible random instance where every element is covered at least twice.
function randomModel(numElements = 300, numSubsets = 120) {
  let state = 2024;
  const rand = (n) => { // mulberry32
    state = (state + 0x6d2b79f5) | 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) % n;
  };
  const columns = Array.from({ length: numSubsets }, () => new Set());
  for (let e = 0; e < numElements; e++) {
    columns[rand(numSubsets)].add(e);
    columns[rand(numSubsets)].add(e);
    for (let k = rand(4); k > 0; k--) columns[rand(numSubsets)].add(e);
  }
  const model = new SetCoverModel('random');
  columns.forEach((column) => {
    model.addEmptySubset(1 + rand(20));
    for (const e of column) model.addElementToLastSubset(e);
  });
  return model;
}

function assertCover(inv) {
  assert.equal(inv.numUncoveredElements(), 0);
  const columns = inv.model.columns;
  const covered = new Set(inv.selectedSubsets().flatMap((s) => columns[s]));
  assert.equal(covered.size, inv.model.numElements);
  const cost = inv.selectedSubsets().reduce((sum, s) => sum + inv.model.subsetCosts[s], 0);
  assert.ok(Math.abs(cost - inv.cost()) < 1e-9, `cost ${inv.cost()} != ${cost}`);
}

test('greedy then steepest search reaches the optimum of a small model, off the main thread', async () => {
  const inv = new SetCoverInvariant(smallModel());
  assert.equal(await new GreedySolutionGenerator(inv).nextSolution(), true);
  assert.equal(inv.cost(), 6);
  assertCover(inv);
  assert.equal(await new SteepestSearch(inv).nextSolution(), true);
  assert.equal(inv.cost(), 5);
  assert.deepEqual(inv.selectedSubsets(), [0, 2]);
  assert.deepEqual(inv.isSelected(), [true, false, true, false, false, false]);
  assert.deepEqual(inv.coverage(), [1, 1, 1, 1, 1, 1]);
});

test('every generator produces a cover, and local search never makes it worse', () => {
  const generators = [TrivialSolutionGenerator, RandomSolutionGenerator, GreedySolutionGenerator,
    ElementDegreeSolutionGenerator, LazyElementDegreeSolutionGenerator];
  for (const Generator of generators) {
    const inv = new SetCoverInvariant(randomModel());
    assert.equal(new Generator(inv).nextSolutionSync(), true, Generator.name);
    assertCover(inv);
    let cost = inv.cost();
    for (const Search of [SteepestSearch, GuidedLocalSearch, GuidedTabuSearch]) {
      const search = new Search(inv).setMaxIterations(200);
      assert.equal(search.nextSolutionSync(), true, `${Generator.name} + ${Search.name}`);
      assertCover(inv);
      assert.ok(inv.cost() <= cost + 1e-9, `${Search.name} raised the cost from ${cost} to ${inv.cost()}`);
      cost = inv.cost();
    }
  }
});

test('the MIP finds the optimum, and its LP relaxation a lower bound', { skip: !SetCoverMipSolver.SCIP && 'no SCIP' }, () => {
  const exact = new SetCoverInvariant(smallModel());
  const mip = new SetCoverMip(exact).setTimeLimitInSeconds(30);
  assert.equal(mip.nextSolutionSync(), true);
  assert.equal(mip.solveStatus, 'OPTIMAL');
  assert.equal(exact.cost(), 5);
  assertCover(exact);

  const large = new SetCoverInvariant(randomModel());
  new SetCoverMip(large).useMipSolver('SCIP').setTimeLimitInSeconds(60).nextSolutionSync();
  const optimum = large.cost();
  const greedy = new SetCoverInvariant(randomModel());
  new GreedySolutionGenerator(greedy).nextSolutionSync();
  assert.ok(optimum <= greedy.cost() + 1e-9);

  const relaxed = new SetCoverInvariant(randomModel());
  const lp = new SetCoverMip(relaxed).useMipSolver('GLOP');
  assert.equal(lp.nextSolutionSync(), true);
  assert.equal(relaxed.selectedSubsets().length, 0); // a relaxation selects nothing
  assert.ok(relaxed.lowerBound() > 0 && relaxed.lowerBound() <= optimum + 1e-6);
});

test('every available MIP backend solves the small model', async () => {
  for (const solver of ['SCIP', 'SAT'].filter((s) => s in SetCoverMipSolver)) {
    const inv = new SetCoverInvariant(smallModel());
    const mip = new SetCoverMip(inv).useMipSolver(solver).useIntegers(true);
    assert.equal(await mip.nextSolution(), true, solver);
    assert.equal(inv.cost(), 5, solver);
  }
  assert.throws(() => new SetCoverMip(new SetCoverInvariant(smallModel())).useMipSolver('NOPE'), /unavailable MIP solver/);
  for (const bad of [-1, NaN, 2e9]) {
    assert.throws(() => new SetCoverMip(new SetCoverInvariant(smallModel())).setTimeLimitInSeconds(bad));
  }
});

test('the model validates what OR-Tools would abort on', () => {
  const model = new SetCoverModel();
  assert.throws(() => model.addElementToLastSubset(0), /no subset yet/);
  for (const cost of [0, -1, NaN, Infinity, '1']) assert.throws(() => model.addEmptySubset(cost), RangeError);
  model.addEmptySubset(1);
  assert.throws(() => model.addElementToLastSubset(-1), RangeError);
  assert.throws(() => model.addElementToLastSubset(2 ** 31 - 1), RangeError);
  assert.throws(() => model.addElementToLastSubset(1.5), TypeError);
  model.addElementToLastSubset(0);
  assert.throws(() => model.addElementToLastSubset(0), /already has element 0/);
  assert.throws(() => model.addElementToSubset(1, 3), /subset 3 does not exist/);
  assert.throws(() => model.setSubsetCost(0, 0), RangeError);
  assert.throws(() => model.setName(3), TypeError);
});

test('the model exposes its structure and round-trips through SetCoverProto', () => {
  const model = smallModel();
  assert.deepEqual([model.name, model.numElements, model.numSubsets, model.numNonzeros], ['small', 6, 6, 17]);
  assert.ok(Math.abs(model.fillRate - 17 / 36) < 1e-12);
  assert.deepEqual(model.subsetCosts, [3, 2, 2, 4, 1, 5]);
  assert.deepEqual(model.columns[3], [0, 5]);
  assert.deepEqual(model.rows[0], [0, 3, 5]);
  assert.deepEqual(model.allSubsets, [0, 1, 2, 3, 4, 5]);
  assert.equal(model.computeFeasibility(), true);
  model.setSubsetCost(5, 9).addElementToSubset(4, 1).setName('renamed');
  const proto = model.exportModelAsProto();
  assert.deepEqual(proto.subset[1], { cost: 2, element: [2, 3, 4] });
  const copy = new SetCoverModel().importModelFromProto(proto);
  assert.deepEqual(copy.exportModelAsProto(), proto);
  assert.throws(() => copy.importModelFromProto({ subset: [{ cost: 0, element: [0] }] }), RangeError);
  assert.equal(copy.numSubsets, 6); // unchanged
  assert.throws(() => copy.importModelFromProto(null), TypeError);
});

test('infeasible models are rejected when the invariant is created', () => {
  assert.equal(new SetCoverModel().computeFeasibility(), false);
  assert.throws(() => new SetCoverInvariant(new SetCoverModel()), /no subsets/);
  const noElements = new SetCoverModel();
  noElements.addEmptySubset(1);
  assert.throws(() => new SetCoverInvariant(noElements), /no elements/);
  const gap = new SetCoverModel();
  gap.addEmptySubset(1);
  gap.addElementToLastSubset(0).addElementToLastSubset(2);
  assert.equal(gap.computeFeasibility(), false);
  assert.throws(() => new SetCoverInvariant(gap), /element 1 is in no subset/);
  // A single huge element needs no element-sized allocation to be rejected.
  const huge = new SetCoverModel();
  huge.addEmptySubset(1);
  huge.addElementToLastSubset(2 ** 31 - 2);
  assert.throws(() => new SetCoverInvariant(huge), /element 0 is in no subset/);
  assert.throws(() => new SetCoverInvariant({}), TypeError);
});

test('the invariant copies the model and accepts loaded solutions', () => {
  const model = smallModel();
  const inv = new SetCoverInvariant(model);
  model.addEmptySubset(1); // not seen by the invariant
  assert.equal(inv.isSelected().length, 6);
  inv.loadSolution([false, false, false, true, true, false]);
  assert.equal(inv.cost(), 5);
  assert.equal(inv.numUncoveredElements(), 3);
  assert.deepEqual(inv.coverage(), [1, 1, 0, 0, 0, 1]);
  assert.throws(() => inv.loadSolution([true]), /selected has 1 entries; the model has 6 subsets/);
  assert.throws(() => inv.loadSolution([1, 0, 0, 0, 0, 0]), TypeError);
  inv.clear();
  assert.deepEqual([inv.cost(), inv.numUncoveredElements(), inv.selectedSubsets()], [0, 6, []]);
});

test('a focus limits what generators change and is validated', () => {
  const inv = new SetCoverInvariant(smallModel());
  assert.equal(new TrivialSolutionGenerator(inv).nextSolutionSync([0, 2, 2, 0]), true); // duplicates are fine
  assert.deepEqual(inv.selectedSubsets(), [0, 2]);
  inv.clear();
  // OR-Tools' greedy writes out of bounds for useful subsets left out of the focus.
  assert.throws(() => new GreedySolutionGenerator(inv).nextSolutionSync([0, 2, 5]), /subset 1 is missing/);
  assert.throws(() => new GreedySolutionGenerator(inv).nextSolutionSync([0]), /subset 1 is missing/);
  assert.throws(() => new ElementDegreeSolutionGenerator(inv).nextSolutionSync([4]), /cannot cover element 0/);
  assert.throws(() => new LazyElementDegreeSolutionGenerator(inv).nextSolutionSync([0, 1]), /cannot cover element 4/);
  assert.equal(new ElementDegreeSolutionGenerator(inv).nextSolutionSync(new Int32Array([0, 2])), true);
  assert.equal(inv.cost(), 5);
  assert.throws(() => new SteepestSearch(inv).nextSolutionSync([6]), /focus\[0\] = 6 is out of range/);
  assert.throws(() => new SteepestSearch(inv).nextSolutionSync([0.5]), TypeError);
  assert.throws(() => new SteepestSearch(inv).nextSolutionSync('0'), TypeError);
});

test('a focus may be any integer list the declarations allow', () => {
  for (const focus of [[0n, 2n], [0, 2n], new Uint32Array([0, 2]), new Float64Array([0, 2]), new BigInt64Array([0n, 2n])]) {
    const inv = new SetCoverInvariant(smallModel());
    assert.equal(new TrivialSolutionGenerator(inv).nextSolutionSync(focus), true, focus.constructor.name);
    assert.deepEqual(inv.selectedSubsets(), [0, 2]);
    assert.ok(Array.isArray(clearMostCoveredElements(inv, 1, focus)));
  }
  const inv = new SetCoverInvariant(smallModel());
  assert.throws(() => new TrivialSolutionGenerator(inv).nextSolutionSync(new Uint8Array([0])), TypeError);
});

test('local search needs a complete cover', () => {
  const inv = new SetCoverInvariant(smallModel());
  assert.equal(new SteepestSearch(inv).nextSolutionSync(), false);
  assert.throws(() => new GuidedLocalSearch(inv).nextSolutionSync(), /complete cover first/);
  assert.throws(() => new GuidedTabuSearch(inv).nextSolutionSync(), /complete cover first/);
});

test('generator settings are validated', () => {
  const inv = new SetCoverInvariant(smallModel());
  assert.throws(() => new GreedySolutionGenerator(inv).setMaxIterations(-1), RangeError);
  assert.throws(() => new GreedySolutionGenerator(inv).setMaxIterations(1.5), TypeError);
  const tabu = new GuidedTabuSearch(inv);
  assert.throws(() => tabu.setTabuListSize(0), RangeError);
  assert.throws(() => tabu.setEpsilon(NaN), TypeError);
  assert.throws(() => tabu.setLagrangianFactor(Infinity), TypeError);
  new GreedySolutionGenerator(inv).nextSolutionSync();
  tabu.setTabuListSize(5).setEpsilon(1e-3).setPenaltyFactor(0.5).setLagrangianFactor(50).setMaxIterations(50);
  assert.equal(tabu.nextSolutionSync(), true);
  assert.equal(tabu.name, 'GuidedTabuSearch');
  assert.throws(() => new GreedySolutionGenerator({}), TypeError);
});

test('clearRandomSubsets and clearMostCoveredElements deselect part of a solution', () => {
  const inv = new SetCoverInvariant(smallModel());
  new GreedySolutionGenerator(inv).nextSolutionSync();
  const cleared = clearRandomSubsets(inv, 1);
  assert.ok(cleared.length <= 1 && cleared.every((s) => !inv.isSelected()[s]));
  new GreedySolutionGenerator(inv).nextSolutionSync();
  assertCover(inv);
  inv.loadSolution([true, true, true, false, true, false]); // elements 1, 2, 3 are over-covered
  const most = clearMostCoveredElements(inv, 10);
  assert.ok(most.length > 0 && most.every((s) => !inv.isSelected()[s]));
  assert.deepEqual(clearMostCoveredElements(inv, 0), []);
  assert.deepEqual(clearRandomSubsets(inv, 2 ** 40, []), []);
  assert.throws(() => clearRandomSubsets(inv, -1), RangeError);
  assert.throws(() => clearRandomSubsets(inv, 1, [99]), RangeError);
  assert.throws(() => clearRandomSubsets({}, 1), TypeError);
});

test('the invariant is busy while a generator runs; separate invariants run concurrently', async () => {
  const a = new SetCoverInvariant(randomModel());
  const b = new SetCoverInvariant(randomModel());
  const pa = new GreedySolutionGenerator(a).nextSolution();
  const pb = new ElementDegreeSolutionGenerator(b).nextSolution();
  assert.equal(a.busy, true);
  for (const call of [() => a.cost(), () => a.clear(), () => a.loadSolution([]), () => a.dispose(),
    () => new SteepestSearch(a).nextSolutionSync(), () => new SteepestSearch(a).nextSolution(),
    () => clearRandomSubsets(a, 1)]) {
    assert.throws(call, /SetCoverInvariant is busy/);
  }
  assert.deepEqual(await Promise.all([pa, pb]), [true, true]);
  assert.equal(a.busy, false);
  assertCover(a);
  assertCover(b);
});

test('dispose() is idempotent and later calls throw', () => {
  const inv = new SetCoverInvariant(smallModel());
  inv.dispose();
  inv.dispose();
  assert.equal(inv.busy, false);
  assert.throws(() => inv.cost(), /disposed/);
  assert.throws(() => new GreedySolutionGenerator(inv).nextSolutionSync(), /disposed/);
  const other = new SetCoverInvariant(smallModel());
  other[Symbol.dispose]();
  assert.throws(() => other.coverage(), /disposed/);
});

// Runs `body` in a child process, so a native crash fails the test instead of the run.
function runIsolated(body) {
  const script = `const { setCover } = require(${JSON.stringify(require.resolve('..'))});
    const model = new setCover.SetCoverModel();
    for (const [cost, elements] of [[3, [0, 1, 2]], [2, [2, 3]], [2, [3, 4, 5]], [4, [0, 5]]]) {
      model.addEmptySubset(cost);
      for (const e of elements) model.addElementToLastSubset(e);
    }
    const inv = new setCover.SetCoverInvariant(model);
    const greedy = new setCover.GreedySolutionGenerator(inv);
    ${body}`;
  const child = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 60000 });
  assert.equal(child.status, 0, `child exited with ${child.status} (${child.signal}): ${child.stderr}`);
  return child.stdout.trim();
}

test('a focus getter that disposes the invariant is a JS error', () => {
  const out = runIsolated(`
    const focus = [0, 1, 2, 3];
    Object.defineProperty(focus, 3, { get() { inv.dispose(); return 3; } });
    try { greedy.nextSolutionSync(focus); console.log('no error'); } catch (e) { console.log(e.message); }`);
  assert.match(out, /disposed/);
});

test('a focus getter that starts a run is a JS error; the run completes', () => {
  const out = runIsolated(`
    let pending;
    const focus = [0, 1, 2, 3];
    Object.defineProperty(focus, 3, { get() { pending = greedy.nextSolution(); return 3; } });
    try { new setCover.TrivialSolutionGenerator(inv).nextSolutionSync(focus); console.log('no error'); }
    catch (e) { console.log(e.message); }
    pending.then((found) => console.log('found', found, inv.cost()));`);
  assert.match(out, /SetCoverInvariant is busy/);
  assert.match(out, /found true 5/);
});

test('throwing getters in a focus or in the model columns propagate their own error', () => {
  const out = runIsolated(`
    const focus = [0];
    Object.defineProperty(focus, 0, { get() { throw new Error('focus getter'); } });
    try { greedy.nextSolutionSync(focus); } catch (e) { console.log(e.message); }
    model._columns[0] = [0, 1];
    Object.defineProperty(model._columns[0], 1, { get() { throw new Error('column getter'); } });
    try { new setCover.SetCoverInvariant(model); } catch (e) { console.log(e.message); }`);
  assert.equal(out, 'focus getter\ncolumn getter');
});
