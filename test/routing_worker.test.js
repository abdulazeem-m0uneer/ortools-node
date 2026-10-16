'use strict';
// Terminating a worker thread during an async CP or routing solve (with a
// solution callback in flight) must not abort the process. Termination waits
// for the threadpool work, so each solve here has a short time limit.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { Worker } = require('node:worker_threads');

const root = path.join(__dirname, '..');

async function terminateWhileSolving(code) {
  const worker = new Worker(code, { eval: true, workerData: { root } });
  await new Promise((resolve, reject) => {
    worker.once('message', resolve);
    worker.once('error', reject);
  });
  assert.equal(await worker.terminate(), 1);
}

test('terminating a worker during an async routing solve with onSolution', async () => {
  await terminateWhileSolving(`
    const { parentPort, workerData } = require('node:worker_threads');
    const { RoutingIndexManager, RoutingModel } = require(workerData.root);
    const data = require(workerData.root + '/test/fixtures/samples.json');
    const manager = new RoutingIndexManager(17, 4, 0);
    const model = new RoutingModel(manager);
    model.setArcCostEvaluatorOfAllVehicles(model.registerTransitMatrix(data.distance17));
    let sent = false;
    model.solveWithParameters(
      { localSearchMetaheuristic: 'GUIDED_LOCAL_SEARCH', timeLimit: '1s' },
      { onSolution() { if (!sent) { sent = true; parentPort.postMessage('solving'); } }, includeRoutes: true });
  `);
});

test('terminating a worker during a CP solveAsync', async () => {
  await terminateWhileSolving(`
    const { parentPort, workerData } = require('node:worker_threads');
    const { CpSolver } = require(workerData.root).cp;
    const s = new CpSolver();
    const p = Array.from({ length: 13 }, () => s.intVar(0, 11));
    for (let i = 0; i < 13; i++) for (let j = i + 1; j < 13; j++) s.add(p[i].ne(p[j]));
    s.solveAsync(s.phase(p, 'CHOOSE_FIRST_UNBOUND', 'ASSIGN_MIN_VALUE'), [s.timeLimit(1000)]);
    parentPort.postMessage('solving');
  `);
});
