'use strict';
// Terminating a worker thread while its solve() is in flight must not abort
// the process: the solve settles after JS can no longer run there.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { Worker } = require('node:worker_threads');

const root = path.join(__dirname, '..');

async function terminateMidSolve(withCallback) {
  const code = `
    const { parentPort, workerData } = require('node:worker_threads');
    const { CpModel, CpSolver } = require(workerData.root);
    const model = new CpModel();
    for (let i = 0; i < 40; ++i) model.newBoolVar('b' + i);
    const solver = new CpSolver();
    solver.parameters = { enumerateAllSolutions: true, maxTimeInSeconds: 1 };
    let count = 0;
    const onSolution = () => { if (++count === 100) parentPort.postMessage('searching'); };
    solver.solve(model, workerData.withCallback ? { onSolution } : undefined);
    if (!workerData.withCallback) parentPort.postMessage('searching');
  `;
  const worker = new Worker(code, { eval: true, workerData: { root, withCallback } });
  await new Promise((resolve, reject) => {
    worker.once('message', resolve);
    worker.once('error', reject);
  });
  assert.equal(await worker.terminate(), 1);
}

test('terminating a worker during solve() does not abort the process', async () => {
  await terminateMidSolve(false);
});

test('terminating a worker while solutions reach onSolution does not abort the process', async () => {
  await terminateMidSolve(true);
});
