'use strict';
// Reading a JS array runs user code (element getters, Proxy traps). That code
// may dispose the instance, start a solve or throw while a bulk method is
// still reading its arguments. Each case runs in a child process because the
// failure mode is a crash (SIGSEGV / abort), not an exception.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

// Each method: how to build a ready instance (`m`), and how to call the bulk
// method with `hostile` as its last array argument.
const METHODS = {
  'SimpleMinCostFlow.addArcsWithCapacityAndUnitCost': {
    setup: 'const m = new SimpleMinCostFlow();',
    call: 'm.addArcsWithCapacityAndUnitCost([0, 1], [1, 2], [1, 1], hostile)',
  },
  'SimpleMinCostFlow.setNodesSupplies': {
    setup: 'const m = new SimpleMinCostFlow(); m.addArcWithCapacityAndUnitCost(0, 1, 5, 1);',
    call: 'm.setNodesSupplies([0, 1], hostile)',
  },
  'SimpleMinCostFlow.flows': {
    setup: 'const m = new SimpleMinCostFlow(); m.addArcsWithCapacityAndUnitCost([0, 0], [1, 1], [5, 5], [1, 2]);'
      + ' m.setNodesSupplies([0, 1], [6, -6]); m.solveSync();',
    call: 'm.flows(hostile)',
  },
  'SimpleMaxFlow.addArcsWithCapacity': {
    setup: 'const m = new SimpleMaxFlow();',
    call: 'm.addArcsWithCapacity([0, 1], [1, 2], hostile)',
  },
  'SimpleMaxFlow.flows': {
    setup: 'const m = new SimpleMaxFlow(); m.addArcsWithCapacity([0, 1], [1, 2], [3, 4]); m.solveSync(0, 2);',
    call: 'm.flows(hostile)',
  },
  'SimpleLinearSumAssignment.addArcsWithCost': {
    setup: 'const m = new SimpleLinearSumAssignment();',
    call: 'm.addArcsWithCost([0, 1], [1, 0], hostile)',
  },
};

// Element 1 of `hostile` runs `action` when read; element 0 is a valid value.
const ACTIONS = {
  dispose: 'm.dispose()',
  solve: 'pending = m instanceof SimpleMaxFlow ? m.solve(0, 1) : m.solve()',
  throw: 'throw new Error("getter boom")',
};

function childScript(spec) {
  const hostileWithGetter = (action) => `(() => {
      const a = [0, 0];
      Object.defineProperty(a, 1, { get() { ${action}; return 0; } });
      return a;
    })()`;
  const cases = Object.entries(ACTIONS).map(([name, action]) => `
    {
      ${spec.setup}
      let pending = null;
      const hostile = ${hostileWithGetter(action)};
      let error = null;
      try { ${spec.call}; } catch (e) { error = e.message; }
      const settled = pending ? await pending : null;
      out[${JSON.stringify(name)}] = { error, settled };
    }`).join('\n');
  return `
    const { SimpleMinCostFlow, SimpleMaxFlow, SimpleLinearSumAssignment } = require('.');
    (async () => {
      const out = {};
      ${cases}
      {
        ${spec.setup}
        const hostile = new Proxy([0, 0], { get(t, k) { if (k === 'length') throw new Error('length boom'); return t[k]; } });
        let error = null;
        try { ${spec.call}; } catch (e) { error = e.message; }
        out.proxy = { error };
      }
      process.stdout.write(JSON.stringify(out));
    })();`;
}

for (const [name, spec] of Object.entries(METHODS)) {
  test(`${name}: user code running during argument reads cannot crash it`, () => {
    const child = spawnSync(process.execPath, ['-e', childScript(spec)], { cwd: ROOT, encoding: 'utf8' });
    assert.equal(child.signal, null, `child killed by ${child.signal}: ${child.stderr}`);
    assert.equal(child.status, 0, child.stderr);
    const out = JSON.parse(child.stdout);
    const className = name.split('.')[0];
    assert.match(out.dispose.error, new RegExp(`${className} has been disposed`));
    assert.match(out.solve.error, /is busy: a solve\(\) is in progress/);
    assert.equal(out.solve.settled, 'OPTIMAL');
    assert.equal(out.throw.error, 'getter boom');
    // A Proxy is not an Array to N-API, so it is rejected before any trap runs.
    assert.match(out.proxy.error, /must be an Array, Int32Array/);
  });
}
