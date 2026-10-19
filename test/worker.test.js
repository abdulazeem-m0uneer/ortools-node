'use strict';
// Terminating a worker thread while its solve() is in flight must not abort
// the process: the Promise settles after JS can no longer run in that worker.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { Worker } = require('node:worker_threads');

const root = path.join(__dirname, '..');

test('terminating a worker during an async MPSolver solve does not abort the process', async () => {
  // A multi-dimensional knapsack on CP-SAT with a 1 s limit: still solving when terminated.
  const code = `
    const { parentPort, workerData } = require('node:worker_threads');
    const { Solver } = require(workerData.root);
    const s = new Solver('CP_SAT');
    const n = 120;
    let seed = 7;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) % 1000 + 1;
    const x = Array.from({ length: n }, (_, i) => s.boolVar('x' + i));
    for (let d = 0; d < 8; d++) s.addLessEq(x.map((v) => [v, rnd()]), 25000);
    s.maximize(x.map((v) => [v, rnd()]));
    s.setTimeLimit(1000);
    s.solve();
    parentPort.postMessage('solving');
  `;
  const worker = new Worker(code, { eval: true, workerData: { root } });
  await new Promise((resolve, reject) => {
    worker.once('message', resolve);
    worker.once('error', reject);
  });
  assert.equal(await worker.terminate(), 1);
});

// A rejection (a C++ exception caught by RunGuarded()) that settles while its worker exits
// must not abort the process either. Run in a child: an abort kills the runner.
for (const kind of ['runtime', 'bad_alloc']) {
  test(`exiting a worker while guardCppAsync('${kind}') rejections are pending does not abort the process`, () => {
    const script = `
      const { Worker } = require('node:worker_threads');
      const code = 'const { native } = require(' + JSON.stringify(${JSON.stringify(root)}) + ');' +
        'for (let i = 0; i < 50; i++) native._testing.guardCppAsync(${JSON.stringify(kind)}).catch(() => {});' +
        'process.exit(0);';
      new Worker(code, { eval: true }).once('exit', (c) => console.log('worker exit ' + c));
    `;
    const { status, signal, stdout, stderr } = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8' });
    assert.deepEqual({ status, signal, stdout }, { status: 0, signal: null, stdout: 'worker exit 0\n' }, stderr);
  });
}
