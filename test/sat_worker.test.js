'use strict';
// Terminating a worker thread while its solve() is in flight must neither
// abort the process nor wait for the search's time limit: teardown stops the
// search. Each scenario runs in a child process, so a hang fails by timeout.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.join(__dirname, '..');

function terminateMidSolve(withCallback) {
  const script = `
    const { Worker } = require('node:worker_threads');
    const code = \`
      const { parentPort, workerData } = require('node:worker_threads');
      const { CpModel, CpSolver } = require(workerData.root);
      const model = new CpModel();
      for (let i = 0; i < 40; ++i) model.newBoolVar('b' + i);
      const solver = new CpSolver();
      solver.parameters = { enumerateAllSolutions: true, maxTimeInSeconds: 600 };
      let count = 0;
      const onSolution = () => { if (++count === 100) parentPort.postMessage('searching'); };
      solver.solve(model, workerData.withCallback ? { onSolution } : undefined);
      if (!workerData.withCallback) setTimeout(() => parentPort.postMessage('searching'), 100);
    \`;
    const worker = new Worker(code, { eval: true, workerData: { root: ${JSON.stringify(root)}, withCallback: ${withCallback} } });
    worker.once('message', async () => {
      const started = Date.now();
      const code = await worker.terminate();
      console.log(JSON.stringify({ code, ms: Date.now() - started }));
    });
  `;
  const child = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 30000 });
  assert.equal(child.signal, null, `the child hung or crashed: ${child.stderr}`);
  assert.equal(child.status, 0, child.stderr);
  return JSON.parse(child.stdout);
}

test('terminating a worker during solve() stops the search promptly', () => {
  const { code, ms } = terminateMidSolve(false);
  assert.equal(code, 1);
  assert.ok(ms < 10000, `terminate took ${ms} ms`);
});

test('terminating a worker while solutions reach onSolution stops the search promptly', () => {
  const { code, ms } = terminateMidSolve(true);
  assert.equal(code, 1);
  assert.ok(ms < 10000, `terminate took ${ms} ms`);
});
