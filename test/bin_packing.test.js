'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { solveVectorBinPacking, solveVectorBinPackingSync, VectorBinPackingSolverType } = require('..');

const SOLVERS = Object.keys(VectorBinPackingSolverType);

// Capacity 10; three 6s, three 4s and two 3s: 36 units need 4 bins, and 4 suffice.
function classic() {
  return {
    name: 'classic',
    resourceCapacity: [10],
    item: [
      { name: 'six', resourceUsage: [6], numCopies: 3 },
      { name: 'four', resourceUsage: [4], numCopies: 3 },
      { name: 'three', resourceUsage: [3], numCopies: 2 },
    ],
  };
}

// Checks the bins respect every capacity and per-bin limit and pack each item's
// copies within [numCopies, numCopies + numOptionalCopies].
function assertValidPacking(problem, solution) {
  const packed = problem.item.map(() => 0);
  for (const bin of solution.bins) {
    const used = problem.resourceCapacity.map(() => 0);
    bin.itemIndices.forEach((item, k) => {
      const copies = bin.itemCopies[k];
      packed[item] += copies;
      problem.item[item].resourceUsage.forEach((u, d) => { used[d] += Number(u) * copies; });
      const limit = problem.item[item].maxNumberOfCopiesPerBin ?? 0;
      assert.ok(limit === 0 || copies <= limit, `item ${item}: ${copies} copies in one bin`);
    });
    used.forEach((u, d) => assert.ok(u <= Number(problem.resourceCapacity[d]), `resource ${d} over capacity`));
  }
  problem.item.forEach((item, i) => {
    const min = item.numCopies ?? 0;
    assert.ok(packed[i] >= min && packed[i] <= min + (item.numOptionalCopies ?? 0), `item ${i}: ${packed[i]} copies`);
  });
}

test('the MIP backends this build has are listed', () => {
  assert.ok(Object.isFrozen(VectorBinPackingSolverType));
  for (const lp of ['GLOP', 'PDLP', 'CLP']) assert.ok(!(lp in VectorBinPackingSolverType));
  assert.ok(SOLVERS.length > 0);
});

test('packs the classic instance into 4 bins off the main thread', async () => {
  const problem = classic();
  const solution = await solveVectorBinPacking(problem);
  assert.equal(solution.status, 'OPTIMAL');
  assert.equal(solution.objectiveValue, 4);
  assert.equal(solution.bins.length, 4);
  assertValidPacking(problem, solution);
  assert.ok(solution.solveTimeInSeconds >= 0 && solution.arcFlowTimeInSeconds >= 0);
  assert.equal(typeof solution.solverInfo, 'string');
});

test('every backend finds the same optimum', () => {
  for (const solverType of SOLVERS) {
    const problem = classic();
    const solution = solveVectorBinPackingSync(problem, { solverType, timeLimitSeconds: 60 });
    assert.equal(solution.status, 'OPTIMAL', solverType);
    assert.equal(solution.objectiveValue, 4, solverType);
    assertValidPacking(problem, solution);
  }
});

test('several resources, per-bin limits and bin costs', () => {
  const twoDims = {
    resourceCapacity: [10, 10],
    item: [{ resourceUsage: [6, 2], numCopies: 2 }, { resourceUsage: [2, 6], numCopies: 2 }, { resourceUsage: [5, 5], numCopies: 1 }],
  };
  let solution = solveVectorBinPackingSync(twoDims);
  assert.equal(solution.objectiveValue, 3);
  assertValidPacking(twoDims, solution);

  const limited = { resourceCapacity: [10], item: [{ resourceUsage: [1], numCopies: 6, maxNumberOfCopiesPerBin: 2 }] };
  solution = solveVectorBinPackingSync(limited);
  assert.equal(solution.bins.length, 3);
  assertValidPacking(limited, solution);

  solution = solveVectorBinPackingSync({ ...classic(), costPerBin: 2.5 });
  assert.equal(solution.objectiveValue, 10);
});

test('optional copies are left out when their penalty is cheaper than a bin', () => {
  const problem = {
    resourceCapacity: [10],
    item: [{ resourceUsage: [6], numCopies: 2 }, { resourceUsage: [6], numOptionalCopies: 2, penaltyPerMissingCopy: 0.5 }],
  };
  const solution = solveVectorBinPackingSync(problem);
  assert.equal(solution.objectiveValue, 3); // 2 bins + 2 missing copies at 0.5
  assertValidPacking(problem, solution);
  problem.item[1].penaltyPerMissingCopy = 5;
  assert.equal(solveVectorBinPackingSync(problem).objectiveValue, 4); // now packing them is cheaper
});

test('maxBins caps the bins; too few bins is INFEASIBLE', () => {
  assert.equal(solveVectorBinPackingSync({ ...classic(), maxBins: 4 }).status, 'OPTIMAL');
  const solution = solveVectorBinPackingSync({ ...classic(), maxBins: 3 });
  assert.equal(solution.status, 'INFEASIBLE');
  assert.deepEqual(solution.bins, []);
});

test('problems where nothing can be packed get an exact answer (the arc-flow graph would be empty)', () => {
  const tooBig = solveVectorBinPackingSync({ resourceCapacity: [10], item: [{ resourceUsage: [11], numCopies: 1 }] });
  assert.equal(tooBig.status, 'INFEASIBLE');
  const optional = solveVectorBinPackingSync({
    resourceCapacity: [10],
    item: [{ resourceUsage: [11], numOptionalCopies: 2, penaltyPerMissingCopy: 1.5 }],
  });
  assert.deepEqual([optional.status, optional.objectiveValue, optional.bins], ['OPTIMAL', 3, []]);
  const nothing = solveVectorBinPackingSync({ resourceCapacity: [10], item: [{ resourceUsage: [3], numCopies: 0 }] });
  assert.deepEqual([nothing.status, nothing.objectiveValue, nothing.bins], ['OPTIMAL', 0, []]);
  // One item that never fits among others that do.
  const mixed = solveVectorBinPackingSync({
    resourceCapacity: [10], item: [{ resourceUsage: [6], numCopies: 2 }, { resourceUsage: [11], numCopies: 1 }],
  });
  assert.equal(mixed.status, 'INFEASIBLE');
});

test('int64 values may be BigInts or decimal strings', () => {
  const solution = solveVectorBinPackingSync({
    resourceCapacity: [10n], item: [{ resourceUsage: ['6'], numCopies: 2 }, { resourceUsage: [4n], numCopies: 2 }],
  });
  assert.equal(solution.objectiveValue, 2);
});

test('invalid problems are rejected before OR-Tools sees them', () => {
  const item = { resourceUsage: [1], numCopies: 1 };
  const cases = [
    [{ item: [item] }, /resourceCapacity is empty/],
    [{ resourceCapacity: [10] }, /item is empty/],
    [{ resourceCapacity: [0], item: [item] }, /resourceCapacity\[0\] must be in \[1, 2\^30\]/],
    [{ resourceCapacity: [2 ** 31], item: [item] }, /resourceCapacity\[0\]/],
    [{ resourceCapacity: [10, 5], item: [item] }, /has 1 values for 2 resources/],
    [{ resourceCapacity: [10], item: [{ resourceUsage: [-1], numCopies: 1 }] }, /resourceUsage\[0\] must be in/],
    [{ resourceCapacity: [10], item: [{ resourceUsage: [1], numCopies: -1 }] }, /must be >= 0/],
    [{ resourceCapacity: [10], item: [{ resourceUsage: [0], numCopies: 2 }] }, /uses no resource/],
    [{ resourceCapacity: [10], item: [{ resourceUsage: [1], numCopies: 2 ** 30 }, item] }, /total number of copies/],
    [{ resourceCapacity: [10], item: [{ ...item, penaltyPerMissingCopy: Infinity }] }, /must be finite/],
    [{ resourceCapacity: [10], item: [item], costPerBin: -Infinity }, /costPerBin must be finite/],
    [{ resourceCapacity: [10], item: [item], maxBins: -1 }, /maxBins must be >= 0/],
    [{ resourceCapacity: [1e9], item: Array.from({ length: 30 }, (_, i) => ({ resourceUsage: [1000 + i], numCopies: 1000 })) },
      /more than 1e7 states/],
  ];
  for (const [problem, message] of cases) {
    assert.throws(() => solveVectorBinPackingSync(problem), { name: 'RangeError', message }, JSON.stringify(problem));
  }
  assert.throws(() => solveVectorBinPackingSync({ ...classic(), nope: 1 }), { name: 'TypeError', message: /nope/ });
  assert.throws(() => solveVectorBinPackingSync({ resourceCapacity: [NaN], item: [item] }), TypeError);
  assert.throws(() => solveVectorBinPackingSync(null), TypeError);
  assert.throws(() => solveVectorBinPackingSync([]), TypeError);
  // A zero-usage item is fine with a per-bin limit below its copies.
  const limited = solveVectorBinPackingSync({
    resourceCapacity: [10], item: [{ resourceUsage: [0], numCopies: 4, maxNumberOfCopiesPerBin: 2 }],
  });
  assert.equal(limited.objectiveValue, 2);
});

test('options are validated', () => {
  const problem = classic();
  assert.throws(() => solveVectorBinPackingSync(problem, { solverType: 'GLOP' }), /Unsupported or unavailable MIP solver/);
  assert.throws(() => solveVectorBinPackingSync(problem, { solverType: 3 }), TypeError);
  assert.throws(() => solveVectorBinPackingSync(problem, { numThreads: 0 }), RangeError);
  assert.throws(() => solveVectorBinPackingSync(problem, { numThreads: 1.5 }), RangeError);
  assert.throws(() => solveVectorBinPackingSync(problem, { timeLimitSeconds: -1 }), RangeError);
  assert.throws(() => solveVectorBinPackingSync(problem, { timeLimitSeconds: NaN }), TypeError);
  assert.throws(() => solveVectorBinPackingSync(problem, { mipParameters: 1 }), TypeError);
  assert.throws(() => solveVectorBinPackingSync(problem, 'fast'), TypeError);
  const threaded = solveVectorBinPackingSync(problem, { numThreads: 2, timeLimitSeconds: 30 });
  assert.equal(threaded.objectiveValue, 4);
  assert.throws(() => solveVectorBinPackingSync(problem, { mipParameters: 'not a parameter' }), /mipParameters rejected/);
});

test('concurrent solves are independent', async () => {
  const twoDims = {
    resourceCapacity: [10, 10],
    item: [{ resourceUsage: [6, 2], numCopies: 2 }, { resourceUsage: [2, 6], numCopies: 2 }],
  };
  const [a, b] = await Promise.all([solveVectorBinPacking(classic()), solveVectorBinPacking(twoDims, { solverType: SOLVERS.at(-1) })]);
  assert.equal(a.objectiveValue, 4);
  assert.equal(b.objectiveValue, 2);
});

// Runs `body` in a child process, so a native crash fails the test instead of the run.
function runIsolated(body) {
  const script = `const ortools = require(${JSON.stringify(require.resolve('..'))});\n${body}`;
  const child = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 60000 });
  assert.equal(child.status, 0, `child exited with ${child.status} (${child.signal}): ${child.stderr}`);
  return child.stderr.trim();
}

test('getters in the problem or options run before the solve and may start another', () => {
  const out = runIsolated(`
    const problem = { resourceCapacity: [10], item: [{ resourceUsage: [6], numCopies: 2 }] };
    let nested;
    const options = { get solverType() { nested = ortools.solveVectorBinPacking(problem); return 'SCIP'; } };
    Promise.all([ortools.solveVectorBinPacking(problem, options), Promise.resolve().then(() => nested)])
      .then(([outer, inner]) => console.error('solved', outer.objectiveValue, inner.objectiveValue));
    const throwing = { resourceCapacity: [10], get item() { throw new Error('item getter'); } };
    try { ortools.solveVectorBinPackingSync(throwing); } catch (e) { console.error(e.message); }`);
  assert.match(out, /item getter/);
  assert.match(out, /solved 2 2/);
});

test('a time limit under 1 ms is rounded up to 1 ms; 0 is refused', () => {
  // 3000 tiny copies in one huge bin: CP-SAT needs about a second to prove 1 bin optimal.
  const problem = { resourceCapacity: [2 ** 30], item: [{ resourceUsage: [1], numCopies: 3000 }] };
  let started = Date.now();
  const full = solveVectorBinPackingSync(problem, { solverType: 'CP_SAT' });
  const fullMs = Date.now() - started;
  assert.equal(full.status, 'OPTIMAL');
  started = Date.now();
  // MPSolver counts whole milliseconds and reads 0 as "no limit": this used to run to OPTIMAL.
  solveVectorBinPackingSync(problem, { solverType: 'CP_SAT', timeLimitSeconds: 0.0004 });
  const limitedMs = Date.now() - started;
  assert.ok(limitedMs < fullMs / 2, `a 0.4 ms limit took ${limitedMs} ms vs ${fullMs} ms without one`);
  for (const timeLimitSeconds of [0, -0]) {
    assert.throws(() => solveVectorBinPackingSync(problem, { timeLimitSeconds }), /timeLimitSeconds must be > 0/);
  }
});

test('mipParameters the backend rejects are an error, not ignored or an UNSPECIFIED status', () => {
  const problem = classic();
  const bad = [['SCIP', 'garbage = = {{'], ['SCIP', 'limits/time = -5'], ['CBC', 'garbage = = {{'],
    ['CP_SAT', 'garbage = = {{'], ['CP_SAT', 'num_workers: -1'], ['HIGHS', 'garbage']];
  for (const [solverType, mipParameters] of bad.filter(([s]) => s in VectorBinPackingSolverType)) {
    assert.throws(() => solveVectorBinPackingSync(problem, { solverType, mipParameters }),
      { name: 'TypeError', message: new RegExp(`mipParameters.*${solverType}`) }, `${solverType}: ${mipParameters}`);
  }
  const good = [['SCIP', 'limits/gap = 0.01'], ['CP_SAT', 'num_workers: 2'], ['CBC', '']];
  for (const [solverType, mipParameters] of good.filter(([s]) => s in VectorBinPackingSolverType)) {
    assert.equal(solveVectorBinPackingSync(problem, { solverType, mipParameters }).objectiveValue, 4, solverType);
  }
});

test('CBC and HIGHS say they take no mipParameters, even valid ones', () => {
  const problem = classic();
  const valid = [['CBC', '-maxnodes 10'], ['CBC', ' '], ['HIGHS', 'output_flag=false'], ['HIGHS', 'threads = 1']];
  for (const [solverType, mipParameters] of valid.filter(([s]) => s in VectorBinPackingSolverType)) {
    assert.throws(() => solveVectorBinPackingSync(problem, { solverType, mipParameters }),
      { name: 'TypeError', message: `mipParameters: ${solverType} takes none here (only SCIP and CP_SAT do)` });
  }
});
