'use strict';
// Exiting the process (process.exit(), an uncaught exception) while a solve()
// runs must not hang: the search is stopped and a solver thread waiting for
// onSolution is released. Each scenario runs in a child process with a timeout.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.join(__dirname, '..');

function runChild(body) {
  const script = `
    const { CpModel, CpSolver } = require(${JSON.stringify(root)});
    const model = new CpModel();
    for (let i = 0; i < 40; ++i) model.newBoolVar('b' + i);
    const solver = new CpSolver();
    solver.parameters = { enumerateAllSolutions: true, maxTimeInSeconds: 600 };
    ${body}
  `;
  const started = Date.now();
  const child = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 30000 });
  assert.equal(child.signal, null, `the child hung: ${child.stderr}`);
  return { status: child.status, ms: Date.now() - started, stderr: child.stderr };
}

test('process.exit() from a timer during solve() with onSolution exits', () => {
  const { status, ms } = runChild(`
    solver.solve(model, { onSolution() {} });
    setTimeout(() => process.exit(7), 300);
  `);
  assert.equal(status, 7);
  assert.ok(ms < 15000, `exit took ${ms} ms`);
});

test('process.exit() inside onSolution exits', () => {
  const { status } = runChild(`
    let n = 0;
    solver.solve(model, { onSolution() { if (++n === 50) process.exit(7); } });
  `);
  assert.equal(status, 7);
});

test('an uncaught exception during solve() with onSolution exits with code 1', () => {
  const { status, stderr } = runChild(`
    solver.solve(model, { onSolution() {} });
    setTimeout(() => { throw new Error('boom'); }, 300);
  `);
  assert.equal(status, 1);
  assert.match(stderr, /boom/);
});

test('an unhandled rejection during solve() with onSolution exits with code 1', () => {
  const { status } = runChild(`
    solver.solve(model, { onSolution() {} });
    setTimeout(() => Promise.reject(new Error('rejected')), 300);
  `);
  assert.equal(status, 1);
});

test('process.exit() during solve() without a callback stops the search instead of waiting for its limit', () => {
  const { status, ms } = runChild(`
    solver.solve(model);
    setTimeout(() => process.exit(7), 300);
  `);
  assert.equal(status, 7);
  assert.ok(ms < 15000, `exit took ${ms} ms`);
});
