'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { findPrebuilt } = require('../lib/loader');
const { buildFromSourceRequested, compileFromSource, decideInstall, main } = require('../scripts/install');
const { FAKE_VERSION, moduleRootWith } = require('./helpers/fake-packages');

const X64_15 = '@ortools-node/linux-x64-gnu-ortools9.15';
const found = () => ({ addon: { path: '/x/ortools_node.node', origin: X64_15 }, tried: [], suggested: null });
const missing = () => ({
  addon: null,
  tried: [`prebuilt ${X64_15}: not installed`],
  suggested: `${X64_15}@1.0.0`,
});
const unsupported = () => ({
  addon: null,
  tried: ['Prebuilt binaries need glibc; musl-based Linux (such as Alpine) is not supported'],
  suggested: null,
});
const notCalled = () => assert.fail('prebuilt lookup must not run');

describe('buildFromSourceRequested', () => {
  test('is set by npm --build-from-source and --build-from-source=ortools-node', () => {
    for (const value of ['true', 'TRUE', 'ortools-node']) {
      assert.equal(buildFromSourceRequested({ npm_config_build_from_source: value }), true, value);
    }
  });

  test('ignores a flag naming another package', () => {
    for (const value of ['sqlite3', 'ortools-node-extra', '@ortools-node/linux-x64-gnu-ortools9.15']) {
      assert.equal(buildFromSourceRequested({ npm_config_build_from_source: value }), false, value);
    }
  });

  test('is off when unset, empty, false or anything else', () => {
    assert.equal(buildFromSourceRequested({}), false);
    for (const value of ['', 'false', 'False', '0', '1', 'yes']) {
      assert.equal(buildFromSourceRequested({ npm_config_build_from_source: value }), false, value);
    }
  });

  test('another package named in the flag does not force a source build over a prebuilt', () => {
    const decision = decideInstall({ env: { npm_config_build_from_source: 'sqlite3' }, lookupPrebuilt: found });
    assert.equal(decision.action, 'skip');
  });
});

describe('decideInstall', () => {
  test('skips compiling when a prebuilt resolves', () => {
    assert.deepEqual(decideInstall({ env: {}, lookupPrebuilt: found }), {
      action: 'skip',
      message: `using the prebuilt addon from ${X64_15}`,
    });
  });

  test('prefers the prebuilt even when ORTOOLS_ROOT is set', () => {
    assert.equal(decideInstall({ env: { ORTOOLS_ROOT: '/opt/or-tools' }, lookupPrebuilt: found }).action, 'skip');
  });

  test('--build-from-source compiles without looking for a prebuilt', () => {
    const decision = decideInstall({ env: { npm_config_build_from_source: 'true' }, lookupPrebuilt: notCalled });
    assert.equal(decision.action, 'compile');
  });

  test('compiles against ORTOOLS_ROOT when no prebuilt resolves', () => {
    const decision = decideInstall({ env: { ORTOOLS_ROOT: '/opt/or-tools' }, lookupPrebuilt: missing });
    assert.deepEqual(decision, {
      action: 'compile',
      message: 'no prebuilt addon; building from source against ORTOOLS_ROOT=/opt/or-tools',
    });
  });

  test('compiles on an unsupported system when ORTOOLS_ROOT is set', () => {
    assert.equal(decideInstall({ env: { ORTOOLS_ROOT: '/opt/or-tools' }, lookupPrebuilt: unsupported }).action, 'compile');
  });

  test('an empty ORTOOLS_ROOT counts as unset', () => {
    assert.equal(decideInstall({ env: { ORTOOLS_ROOT: '' }, lookupPrebuilt: missing }).action, 'fail');
  });

  test('fails with both fixes when nothing is available', () => {
    const { action, message } = decideInstall({ env: {}, lookupPrebuilt: missing });
    assert.equal(action, 'fail');
    assert.match(message, /ORTOOLS_ROOT is not set/);
    assert.match(message, /prebuilt @ortools-node\/linux-x64-gnu-ortools9\.15: not installed/);
    assert.match(message, /\(npm install @ortools-node\/linux-x64-gnu-ortools9\.15@1\.0\.0\)/);
    assert.match(message, /set ORTOOLS_ROOT/);
  });

  test('on musl, fails with the reason and only the source-build fix', () => {
    const { action, message } = decideInstall({ env: {}, lookupPrebuilt: unsupported });
    assert.equal(action, 'fail');
    assert.match(message, /Alpine/);
    assert.doesNotMatch(message, /npm install/);
  });
});

describe('main', () => {
  const quiet = { log: () => {}, logError: () => {} };

  test('exits 0 without compiling when a prebuilt resolves', () => {
    const code = main({ ...quiet, env: {}, lookupPrebuilt: found, compile: () => assert.fail('compiled') });
    assert.equal(code, 0);
  });

  test('returns the compiler exit code', () => {
    const env = { ORTOOLS_ROOT: '/opt/or-tools' };
    assert.equal(main({ ...quiet, env, lookupPrebuilt: missing, compile: () => 0 }), 0);
    assert.equal(main({ ...quiet, env, lookupPrebuilt: missing, compile: () => 2 }), 2);
  });

  test('exits 1 with instructions when nothing is available', () => {
    const errors = [];
    const code = main({ env: {}, lookupPrebuilt: missing, compile: () => assert.fail('compiled'), log: () => {}, logError: (m) => errors.push(m) });
    assert.equal(code, 1);
    assert.match(errors.join('\n'), /^ortools-node: no prebuilt addon for this system/);
  });

  test('exits 1 when the prebuilt lookup throws, such as on an invalid pin', () => {
    const errors = [];
    const lookupPrebuilt = () => {
      throw new Error('ORTOOLS_NODE_PIN=9 is not an OR-Tools release with prebuilt binaries');
    };
    const code = main({ env: {}, lookupPrebuilt, compile: () => assert.fail('compiled'), log: () => {}, logError: (m) => errors.push(m) });
    assert.equal(code, 1);
    assert.match(errors[0], /ORTOOLS_NODE_PIN=9/);
  });

  test('looks up prebuilts with the environment it was given', () => {
    const errors = [];
    const code = main({ env: { ORTOOLS_NODE_PIN: 'bogus' }, log: () => {}, logError: (m) => errors.push(m) });
    assert.equal(code, 1);
    assert.match(errors[0], /ORTOOLS_NODE_PIN=bogus/);
  });
});

describe('an ORTOOLS_NODE_PIN with no prebuilt', () => {
  const env = { ORTOOLS_ROOT: '/opt/or-tools-9.16', ORTOOLS_NODE_PIN: '9.16' };

  test('does not block a source build against ORTOOLS_ROOT, and is reported', () => {
    const logged = [];
    const errors = [];
    let compiled = 0;
    const code = main({
      env,
      compile: () => ++compiled && 0,
      log: (m) => logged.push(m),
      logError: (m) => errors.push(m),
    });
    assert.equal(code, 0);
    assert.equal(compiled, 1);
    assert.match(errors[0], /^ortools-node: warning: ORTOOLS_NODE_PIN=9\.16 is not an OR-Tools release with prebuilt binaries.*; ignoring it/);
    assert.match(logged[0], /building from source against ORTOOLS_ROOT=\/opt\/or-tools-9\.16/);
  });

  test('still fails without ORTOOLS_ROOT', () => {
    const decision = () => decideInstall({ env: { ORTOOLS_NODE_PIN: '9.16' }, lookupPrebuilt: () => findPrebuilt({ env: { ORTOOLS_NODE_PIN: '9.16' } }) });
    assert.throws(decision, /ORTOOLS_NODE_PIN=9\.16/);
  });

  test('other lookup errors still fail even with ORTOOLS_ROOT', () => {
    const broken = () => {
      throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
    };
    assert.throws(() => decideInstall({ env, lookupPrebuilt: broken }), /EACCES/);
  });
});

describe('a prebuilt at another version than ortools-node', () => {
  const lookupIn = (root) => () =>
    findPrebuilt({ platform: 'linux', arch: 'x64', libc: 'glibc', env: {}, version: FAKE_VERSION, moduleRoot: root });

  test('counts as not found: the install fails with the versioned install command', () => {
    const errors = [];
    const code = main({
      env: {},
      lookupPrebuilt: lookupIn(moduleRootWith([X64_15], { version: '0.9.0' })),
      compile: () => assert.fail('compiled'),
      log: () => assert.fail('logged success'),
      logError: (m) => errors.push(m),
    });
    assert.equal(code, 1);
    assert.match(errors[0], /version 0\.9\.0 is installed, but ortools-node is 1\.0\.0/);
    assert.match(errors[0], /npm install @ortools-node\/linux-x64-gnu-ortools9\.15@1\.0\.0/);
  });

  test('is built from source instead when ORTOOLS_ROOT is set', () => {
    const decision = decideInstall({
      env: { ORTOOLS_ROOT: '/opt/or-tools' },
      lookupPrebuilt: lookupIn(moduleRootWith([X64_15], { version: '0.9.0' })),
    });
    assert.equal(decision.action, 'compile');
  });
});

describe('compileFromSource', () => {
  test('runs cmake-js compile with this Node.js', () => {
    const calls = [];
    const code = compileFromSource((cmd, args, options) => {
      calls.push({ cmd, args, options });
      return { status: 0, signal: null };
    });
    assert.equal(code, 0);
    assert.equal(calls[0].cmd, process.execPath);
    assert.equal(calls[0].args[0], require.resolve('cmake-js/bin/cmake-js'));
    assert.deepEqual(calls[0].args.slice(1), ['compile']);
    assert.equal(calls[0].options.stdio, 'inherit');
  });

  test('passes a failing exit code through', () => {
    assert.equal(compileFromSource(() => ({ status: 3, signal: null })), 3);
  });

  test('fails when cmake-js cannot start or is killed', (t) => {
    t.mock.method(console, 'error', () => {});
    assert.equal(compileFromSource(() => ({ error: new Error('spawn EACCES'), status: null })), 1);
    assert.equal(compileFromSource(() => ({ status: null, signal: 'SIGKILL' })), 1);
    assert.equal(console.error.mock.callCount(), 2);
  });
});
