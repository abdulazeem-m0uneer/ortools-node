'use strict';
// Terminating a worker thread mid-search must neither abort the process nor
// wait for the search's time limit (or forever, without one): sync searches
// stop once a callback can no longer run, async ones through the teardown
// watch. Each scenario runs in a child process, so a hang fails by timeout.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.join(__dirname, '..');

const ROUTING = `
  const { RoutingIndexManager, RoutingModel } = require(workerData.root);
  const data = require(workerData.root + '/test/fixtures/samples.json');
  const model = new RoutingModel(new RoutingIndexManager(17, 4, 0));
  model.setArcCostEvaluatorOfAllVehicles(model.registerTransitMatrix(data.distance17));
  // Guided local search with no time limit never ends on its own.
  const params = { localSearchMetaheuristic: 'GUIDED_LOCAL_SEARCH' };
  let sent = false;
  const busy = () => {
    if (!sent) { sent = true; parentPort.postMessage('searching'); }
    const until = Date.now() + 5;
    while (Date.now() < until);
  };
`;
// 13 pigeons in 12 holes: far longer than any test timeout.
const PIGEONS = `
  const { CpSolver } = require(workerData.root).cp;
  const s = new CpSolver();
  const p = Array.from({ length: 13 }, () => s.intVar(0, 11));
  for (let i = 0; i < 13; i++) for (let j = i + 1; j < 13; j++) s.add(p[i].ne(p[j]));
  const db = s.phase(p, 'CHOOSE_FIRST_UNBOUND', 'ASSIGN_MIN_VALUE');
`;

function terminateMidSearch(body) {
  const script = `
    const { Worker } = require('node:worker_threads');
    const code = 'const { parentPort, workerData } = require("node:worker_threads");' + ${JSON.stringify(body)};
    const worker = new Worker(code, { eval: true, workerData: { root: ${JSON.stringify(root)} } });
    worker.once('error', (e) => { console.error(e); process.exit(2); });
    worker.once('message', async () => {
      const started = Date.now();
      const code = await worker.terminate();
      console.log(JSON.stringify({ code, ms: Date.now() - started }));
    });
  `;
  const child = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 30000 });
  assert.equal(child.signal, null, `the child hung or crashed: ${child.stderr}`);
  assert.equal(child.status, 0, child.stderr);
  const { code, ms } = JSON.parse(child.stdout);
  assert.equal(code, 1);
  assert.ok(ms < 10000, `terminate took ${ms} ms`);
}

test('an async routing solve without callbacks stops when its worker terminates', () => {
  terminateMidSearch(`${ROUTING}
    model.solveWithParameters(params);
    setTimeout(() => parentPort.postMessage('searching'), 200);`);
});

test('an async routing solve with busy callbacks stops when its worker terminates', () => {
  terminateMidSearch(`${ROUTING}
    model.solveWithParameters(params, { onSolution: busy, onProgress: busy, progressIntervalMs: 0 });`);
});

test('a sync routing solve stops once its callbacks can no longer run', () => {
  terminateMidSearch(`${ROUTING}
    model.solveWithParametersSync(params, { onProgress: busy, progressIntervalMs: 0 });`);
});

test('a sync routing solve with onSolution only stops once it can no longer run', () => {
  terminateMidSearch(`${ROUTING}
    model.solveWithParametersSync(params, { onSolution: busy });`);
});

test('a CP solveAsync stops when its worker terminates', () => {
  terminateMidSearch(`${PIGEONS}
    s.solveAsync(db);
    setTimeout(() => parentPort.postMessage('searching'), 200);`);
});

test('a sync CP search with a JS monitor stops once the monitor can no longer run', () => {
  terminateMidSearch(`${PIGEONS}
    let sent = false;
    s.solve(db, [{ beginFail() { if (!sent) { sent = true; parentPort.postMessage('searching'); } } }]);`);
});
