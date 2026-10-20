'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ADDON_FILE, findAddon } = require('../lib/loader');
const { buildFromSourceRequested, compileFromSource, decideInstall, main } = require('../scripts/install');
const { FAKE_VERSION, confinedTo, moduleRootWith } = require('./helpers/fake-packages');

const X64_15 = '@ortools-nodejs/linux-x64-gnu-ortools9.15';
const SOURCE_TRIED = 'source build /pkg/build/Release/ortools_node.node: not found';
// Results of findAddon, the loader's own resolution.
const prebuiltFound = () => ({ addon: { path: '/x/ortools_node.node', origin: X64_15 }, tried: [SOURCE_TRIED], suggested: null });
const sourceFound = () => ({ addon: { path: '/pkg/build/Release/ortools_node.node', origin: 'source build' }, tried: [], suggested: null });
const missing = () => ({
  addon: null,
  tried: [SOURCE_TRIED, `prebuilt ${X64_15}: not installed`],
  suggested: `${X64_15}@1.0.0`,
});
const unsupported = () => ({
  addon: null,
  tried: [SOURCE_TRIED, 'Prebuilt binaries need glibc; musl-based Linux (such as Alpine) is not supported'],
  suggested: null,
});
const notCalled = () => assert.fail('lookup must not run');
const quiet = { log: () => {}, logError: () => {} };

/** findAddon on a Linux x64 glibc machine, confined to a temporary module root. */
const lookupIn = (root, env = {}) => () =>
  findAddon({ platform: 'linux', arch: 'x64', libc: 'glibc', env, version: FAKE_VERSION, ...confinedTo(root) });

/** A temporary module root with a Release source build and the given packages. */
function builtRoot(packages = [], options) {
  const root = moduleRootWith(packages, options);
  fs.mkdirSync(path.join(root, 'build', 'Release'), { recursive: true });
  fs.writeFileSync(path.join(root, 'build', 'Release', ADDON_FILE), '');
  return root;
}

describe('buildFromSourceRequested', () => {
  test('is set by npm --build-from-source and --build-from-source=ortools-node', () => {
    for (const value of ['true', 'TRUE', 'ortools-node']) {
      assert.equal(buildFromSourceRequested({ npm_config_build_from_source: value }), true, value);
    }
  });

  test('ignores a flag naming another package', () => {
    for (const value of ['sqlite3', 'ortools-node-extra', '@ortools-nodejs/linux-x64-gnu-ortools9.15']) {
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
    const decision = decideInstall({ env: { npm_config_build_from_source: 'sqlite3' }, lookup: prebuiltFound });
    assert.equal(decision.action, 'skip');
  });
});

describe('decideInstall', () => {
  test('skips compiling when a prebuilt resolves', () => {
    assert.deepEqual(decideInstall({ env: {}, lookup: prebuiltFound }), {
      action: 'skip',
      message: `using the prebuilt addon from ${X64_15}`,
    });
  });

  test('prefers the prebuilt even when ORTOOLS_ROOT is set', () => {
    assert.equal(decideInstall({ env: { ORTOOLS_ROOT: '/opt/or-tools' }, lookup: prebuiltFound }).action, 'skip');
  });

  test('--build-from-source compiles without looking anything up', () => {
    const decision = decideInstall({ env: { npm_config_build_from_source: 'true' }, lookup: notCalled });
    assert.equal(decision.action, 'compile');
  });

  test('compiles against ORTOOLS_ROOT when nothing resolves', () => {
    const decision = decideInstall({ env: { ORTOOLS_ROOT: '/opt/or-tools' }, lookup: missing });
    assert.deepEqual(decision, {
      action: 'compile',
      message: 'no prebuilt addon; building from source against ORTOOLS_ROOT=/opt/or-tools',
    });
  });

  test('compiles on an unsupported system when ORTOOLS_ROOT is set', () => {
    assert.equal(decideInstall({ env: { ORTOOLS_ROOT: '/opt/or-tools' }, lookup: unsupported }).action, 'compile');
  });

  test('an empty ORTOOLS_ROOT counts as unset', () => {
    assert.ok(decideInstall({ env: { ORTOOLS_ROOT: '' }, lookup: missing }).helpOnFailure);
  });

  test('without ORTOOLS_ROOT, still tries a source build, since CMake may find OR-Tools elsewhere', () => {
    const decision = decideInstall({ env: {}, lookup: missing });
    assert.equal(decision.action, 'compile');
    assert.match(decision.message, /ORTOOLS_ROOT is not set; trying a source build with CMake's own search/);
  });

  test('keeps both fixes for when that source build fails', () => {
    const { helpOnFailure: message } = decideInstall({ env: {}, lookup: missing });
    assert.match(message, /^no prebuilt addon for this system, and the source build failed/);
    assert.match(message, /source build .*: not found/);
    assert.match(message, /prebuilt @ortools-nodejs\/linux-x64-gnu-ortools9\.15: not installed/);
    assert.match(message, /\(npm install @ortools-nodejs\/linux-x64-gnu-ortools9\.15@1\.0\.0\)/);
    assert.match(message, /set ORTOOLS_ROOT/);
  });

  test('on musl, tries a source build and keeps the reason and only the source-build fix', () => {
    const { action, helpOnFailure: message } = decideInstall({ env: {}, lookup: unsupported });
    assert.equal(action, 'compile');
    assert.match(message, /Alpine/);
    assert.doesNotMatch(message, /npm install/);
  });
});

describe('main', () => {
  test('exits 0 without compiling when a prebuilt resolves', () => {
    assert.equal(main({ ...quiet, env: {}, lookup: prebuiltFound, compile: () => assert.fail('compiled') }), 0);
  });

  test('returns the compiler exit code', () => {
    const env = { ORTOOLS_ROOT: '/opt/or-tools' };
    assert.equal(main({ ...quiet, env, lookup: missing, compile: () => 0 }), 0);
    assert.equal(main({ ...quiet, env, lookup: missing, compile: () => 2 }), 2);
  });

  test('prints the instructions only when the fallback source build fails', () => {
    const errors = [];
    const code = main({ env: {}, lookup: missing, compile: () => 1, log: () => {}, logError: (m) => errors.push(m) });
    assert.equal(code, 1);
    assert.match(errors.join('\n'), /^ortools-node: no prebuilt addon for this system, and the source build failed/);
  });

  test('succeeds quietly when the fallback source build finds OR-Tools', () => {
    const code = main({ env: {}, lookup: missing, compile: () => 0, log: () => {}, logError: (m) => assert.fail(m) });
    assert.equal(code, 0);
  });

  test('exits 1 when the lookup throws', () => {
    const errors = [];
    const lookup = () => {
      throw new Error('@ortools-nodejs/linux-x64-gnu-ortools9.15 has an unreadable package.json; reinstall it');
    };
    const code = main({ env: {}, lookup, compile: () => assert.fail('compiled'), log: () => {}, logError: (m) => errors.push(m) });
    assert.equal(code, 1);
    assert.match(errors[0], /unreadable package\.json/);
  });
});

describe('the install hook follows the loader', () => {
  test('a source build and a prebuilt together: the hook keeps the source build the loader loads', () => {
    const root = builtRoot([X64_15]);
    const options = { platform: 'linux', arch: 'x64', libc: 'glibc', env: {}, version: FAKE_VERSION, ...confinedTo(root) };
    assert.equal(findAddon(options).addon.origin, 'source build');
    const decision = decideInstall({ env: {}, lookup: lookupIn(root) });
    assert.equal(decision.action, 'skip');
    assert.match(decision.message, /^keeping the source build at .*build[/\\]Release[/\\]ortools_node\.node/);
  });

  test('a source build and a prebuilt together: ORTOOLS_ROOT recompiles the source build', () => {
    const decision = decideInstall({ env: { ORTOOLS_ROOT: '/opt/or-tools' }, lookup: lookupIn(builtRoot([X64_15])) });
    assert.equal(decision.action, 'compile');
  });

  test('a broken prebuilt cannot fail an install that has a source build', () => {
    const root = builtRoot([X64_15], { withAddon: false });
    assert.equal(decideInstall({ env: {}, lookup: lookupIn(root) }).action, 'skip');
  });
});

describe('an existing source build', () => {
  test('lets the install succeed without ORTOOLS_ROOT or a prebuilt', () => {
    const logged = [];
    const code = main({
      env: {},
      lookup: lookupIn(builtRoot()),
      compile: () => assert.fail('compiled'),
      log: (m) => logged.push(m),
      logError: (m) => assert.fail(m),
    });
    assert.equal(code, 0);
    assert.match(logged[0], /keeping the source build at .*build[/\\]Release[/\\]ortools_node\.node/);
    assert.match(logged[0], /npm run build/);
  });

  test('is recompiled when ORTOOLS_ROOT is set', () => {
    assert.equal(decideInstall({ env: { ORTOOLS_ROOT: '/opt/or-tools' }, lookup: lookupIn(builtRoot()) }).action, 'compile');
  });

  test('is kept even when ORTOOLS_NODE_PIN names a release without prebuilts', () => {
    const env = { ORTOOLS_NODE_PIN: '9.16' };
    const code = main({ ...quiet, env, lookup: lookupIn(builtRoot(), env), compile: () => assert.fail('compiled') });
    assert.equal(code, 0);
  });

  test('the failure lists the source build paths it looked at', () => {
    const { helpOnFailure: message } = decideInstall({ env: {}, lookup: lookupIn(moduleRootWith([])) });
    assert.match(message, /source build .*build[/\\]Release[/\\]ortools_node\.node: not found/);
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
      lookup: lookupIn(moduleRootWith([]), env),
      compile: () => ++compiled && 0,
      log: (m) => logged.push(m),
      logError: (m) => errors.push(m),
    });
    assert.equal(code, 0);
    assert.equal(compiled, 1);
    assert.match(errors[0], /^ortools-node: warning: ORTOOLS_NODE_PIN=9\.16 is not an OR-Tools release with prebuilt binaries.*; ignoring it/);
    assert.match(logged[0], /building from source against ORTOOLS_ROOT=\/opt\/or-tools-9\.16/);
  });

  test('without ORTOOLS_ROOT, warns, tries a source build and repeats the pin error if it fails', () => {
    const pin = { ORTOOLS_NODE_PIN: '9.16' };
    const decision = decideInstall({ env: pin, lookup: lookupIn(moduleRootWith([]), pin) });
    assert.equal(decision.action, 'compile');
    assert.match(decision.warning, /ORTOOLS_NODE_PIN=9\.16/);
    assert.match(decision.helpOnFailure, /ORTOOLS_NODE_PIN=9\.16 is not an OR-Tools release/);
  });

  test('other lookup errors still fail even with ORTOOLS_ROOT', () => {
    const broken = () => {
      throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
    };
    assert.throws(() => decideInstall({ env, lookup: broken }), /EACCES/);
  });
});

describe('a prebuilt at another version than ortools-node', () => {
  test('counts as not found: the install fails with the versioned install command', () => {
    const errors = [];
    const code = main({
      env: {},
      lookup: lookupIn(moduleRootWith([X64_15], { version: '0.9.0' })),
      compile: () => 1,
      log: () => {},
      logError: (m) => errors.push(m),
    });
    assert.equal(code, 1);
    assert.match(errors[0], /version 0\.9\.0 is installed, but ortools-node is 1\.0\.0/);
    assert.match(errors[0], /npm install @ortools-nodejs\/linux-x64-gnu-ortools9\.15@1\.0\.0/);
  });

  test('is built from source instead when ORTOOLS_ROOT is set', () => {
    const lookup = lookupIn(moduleRootWith([X64_15], { version: '0.9.0' }));
    assert.equal(decideInstall({ env: { ORTOOLS_ROOT: '/opt/or-tools' }, lookup }).action, 'compile');
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
