'use strict';
// Getters that run while solve() reads its arguments may dispose the solver or
// start another solve. That must end in a JS error, never a crash, so each
// scenario runs in a child process whose exit status is checked.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.join(__dirname, '..');

function runScenario(body) {
  const script = `
    const { CpModel, CpSolver } = require(${JSON.stringify(root)});
    const model = new CpModel();
    const x = model.newIntVar(0, 10, 'x');
    model.maximize(x);
    const solver = new CpSolver();
    (async () => { ${body} })().then(
      (out) => console.log(JSON.stringify(out)),
      (e) => { console.error(e); process.exit(2); });
  `;
  const child = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 60000 });
  assert.equal(child.signal, null, child.stderr);
  assert.equal(child.status, 0, child.stderr);
  return JSON.parse(child.stdout);
}

test('an onSolution getter that disposes the solver makes solve() reject', () => {
  const out = runScenario(`
    const options = { get onSolution() { solver.dispose(); return undefined; } };
    const error = await solver.solve(model, options).catch((e) => e.message);
    return { error, busy: solver.busy };
  `);
  assert.match(out.error, /disposed/);
  assert.equal(out.busy, false);
});

test('a parameters getter that disposes the solver makes solveSync() throw', () => {
  const out = runScenario(`
    solver.parameters = { get numWorkers() { solver.dispose(); return 1; } };
    try { solver.solveSync(model); return { error: null }; } catch (e) { return { error: e.message }; }
  `);
  assert.match(out.error, /disposed/);
});

test('an onSolution getter that starts another solve makes the outer solve() reject busy', () => {
  const out = runScenario(`
    let inner;
    const options = { get onSolution() { inner = solver.solve(model); return undefined; } };
    const error = await solver.solve(model, options).catch((e) => e.message);
    return { error, inner: await inner, value: solver.value(x) };
  `);
  assert.match(out.error, /busy/);
  assert.equal(out.inner, 'OPTIMAL');
  assert.equal(out.value, 10);
});

test('a parameters getter that starts a solve makes solveSync() throw busy', () => {
  const out = runScenario(`
    let inner;
    let started = false;
    solver.parameters = {
      get numWorkers() {
        if (!started) { started = true; inner = solver.solve(model); }  // the inner solve reads this getter too
        return 1;
      },
    };
    let error = null;
    try { solver.solveSync(model); } catch (e) { error = e.message; }
    solver.parameters = {};
    return { error, inner: await inner };
  `);
  assert.match(out.error, /busy/);
  assert.equal(out.inner, 'OPTIMAL');
});
