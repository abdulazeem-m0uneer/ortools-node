'use strict';
const { test, describe, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  ADDON_FILE,
  detectLibc,
  findPrebuilt,
  findSourceBuild,
  loadAddon,
  parsePin,
  prebuiltPackageName,
  prebuiltTarget,
  resolveAddon,
} = require('../lib/loader');
const { FAKE_VERSION, moduleRootWith } = require('./helpers/fake-packages');

const X64_15 = '@ortools-node/linux-x64-gnu-ortools9.15';
const X64_14 = '@ortools-node/linux-x64-gnu-ortools9.14';
const linuxX64 = { platform: 'linux', arch: 'x64', libc: 'glibc', env: {}, version: FAKE_VERSION };

test('prebuilt package names carry the target and the OR-Tools release', () => {
  assert.equal(prebuiltPackageName('linux-arm64-gnu', '9.14'), '@ortools-node/linux-arm64-gnu-ortools9.14');
});

describe('detectLibc', () => {
  test('is null off Linux, without reading the process report', () => {
    assert.equal(detectLibc('darwin', () => assert.fail('report read')), null);
  });

  test('is glibc when the report has a glibc runtime version', () => {
    assert.equal(detectLibc('linux', () => ({ header: { glibcVersionRuntime: '2.41' }, sharedObjects: [] })), 'glibc');
  });

  test('is musl when the musl loader is mapped', () => {
    const report = { header: {}, sharedObjects: ['/usr/bin/node', '/lib/ld-musl-x86_64.so.1'] };
    assert.equal(detectLibc('linux', () => report), 'musl');
  });

  test('is unknown when neither shows up', () => {
    assert.equal(detectLibc('linux', () => ({ header: {}, sharedObjects: ['/usr/bin/node'] })), 'unknown');
    assert.equal(detectLibc('linux', () => ({})), 'unknown');
  });

  test('detects this machine', () => {
    const libc = detectLibc();
    if (process.platform === 'linux') assert.ok(['glibc', 'musl'].includes(libc), libc);
    else assert.equal(libc, null);
  });
});

describe('prebuiltTarget', () => {
  test('maps glibc Linux x64 and arm64 to their packages', () => {
    assert.equal(prebuiltTarget({ platform: 'linux', arch: 'x64', libc: 'glibc' }).key, 'linux-x64-gnu');
    assert.equal(prebuiltTarget({ platform: 'linux', arch: 'arm64', libc: 'glibc' }).key, 'linux-arm64-gnu');
  });

  test('rejects musl with a hint to use a glibc image', () => {
    const { key, reason } = prebuiltTarget({ platform: 'linux', arch: 'x64', libc: 'musl' });
    assert.equal(key, null);
    assert.match(reason, /musl/);
    assert.match(reason, /Alpine/);
    assert.match(reason, /Debian or Ubuntu/);
  });

  test('rejects an undetected C library', () => {
    assert.match(prebuiltTarget({ platform: 'linux', arch: 'x64', libc: 'unknown' }).reason, /Could not detect/);
  });

  test('rejects other CPUs and operating systems', () => {
    assert.match(prebuiltTarget({ platform: 'linux', arch: 'ia32', libc: 'glibc' }).reason, /linux-ia32/);
    const darwin = prebuiltTarget({ platform: 'darwin', arch: 'arm64', libc: null });
    assert.equal(darwin.key, null);
    assert.match(darwin.reason, /No prebuilt binaries for darwin-arm64/);
  });
});

describe('parsePin', () => {
  test('is null when unset or empty', () => {
    assert.equal(parsePin(undefined), null);
    assert.equal(parsePin(''), null);
  });

  test('accepts the supported releases', () => {
    assert.equal(parsePin('9.14'), '9.14');
    assert.equal(parsePin('9.15'), '9.15');
  });

  test('rejects anything else, naming the valid values', () => {
    for (const value of ['9.13', '9.14.6206', ' 9.14', 'latest']) {
      assert.throws(
        () => parsePin(value),
        (err) => err.code === 'ORTOOLS_NODE_INVALID_PIN' && /ORTOOLS_NODE_PIN=.* set it to one of 9\.15, 9\.14/.test(err.message),
        value,
      );
    }
  });
});

describe('findSourceBuild', () => {
  const root = path.join(path.sep, 'pkg');
  const release = path.join(root, 'build', 'Release', ADDON_FILE);
  const debug = path.join(root, 'build', 'Debug', ADDON_FILE);

  test('prefers the Release build', () => {
    const exists = new Set([release, debug]);
    assert.deepEqual(findSourceBuild({ moduleRoot: root, fileExists: (f) => exists.has(f) }).addon, {
      path: release,
      origin: 'source build',
    });
  });

  test('falls back to the Debug build', () => {
    assert.equal(findSourceBuild({ moduleRoot: root, fileExists: (f) => f === debug }).addon.path, debug);
  });

  test('lists both places when there is no build', () => {
    const { addon, tried } = findSourceBuild({ moduleRoot: root, fileExists: () => false });
    assert.equal(addon, null);
    assert.deepEqual(tried, [`source build ${release}: not found`, `source build ${debug}: not found`]);
  });
});

describe('findPrebuilt', () => {
  let both;
  before(() => {
    both = moduleRootWith([X64_15, X64_14]);
  });

  test('picks the newest OR-Tools release when several are installed', () => {
    const { addon } = findPrebuilt({ ...linuxX64, moduleRoot: both });
    assert.equal(addon.origin, X64_15);
    assert.equal(addon.path, path.join(both, 'node_modules', '@ortools-node', 'linux-x64-gnu-ortools9.15', ADDON_FILE));
  });

  test('ORTOOLS_NODE_PIN selects an older release', () => {
    const { addon } = findPrebuilt({ ...linuxX64, env: { ORTOOLS_NODE_PIN: '9.14' }, moduleRoot: both });
    assert.equal(addon.origin, X64_14);
  });

  test('uses the only release installed', () => {
    const root = moduleRootWith([X64_14]);
    assert.equal(findPrebuilt({ ...linuxX64, moduleRoot: root }).addon.origin, X64_14);
  });

  test('refuses a prebuilt whose version is not ortools-node\'s, naming the exact install', () => {
    const root = moduleRootWith([X64_15], { version: '0.9.0' });
    const result = findPrebuilt({ ...linuxX64, moduleRoot: root });
    assert.equal(result.addon, null);
    assert.deepEqual(result.tried, [`prebuilt ${X64_15}: version 0.9.0 is installed, but ortools-node is 1.0.0`]);
    assert.equal(result.suggested, `${X64_15}@1.0.0`);
  });

  test('a mismatched newest release does not fall back to an older one', () => {
    const root = moduleRootWith([X64_15], { version: '1.1.0' });
    fs.cpSync(moduleRootWith([X64_14]), root, { recursive: true });
    const result = findPrebuilt({ ...linuxX64, moduleRoot: root });
    assert.equal(result.addon, null);
    assert.equal(result.suggested, `${X64_15}@1.0.0`);
  });

  test('compares against the version of this ortools-node by default', () => {
    const own = require('../package.json').version;
    const { version, ...noVersion } = linuxX64;
    assert.equal(version, FAKE_VERSION);
    assert.equal(findPrebuilt({ ...noVersion, moduleRoot: moduleRootWith([X64_15], { version: own }) }).addon.origin, X64_15);
    assert.equal(findPrebuilt({ ...noVersion, moduleRoot: moduleRootWith([X64_15], { version: `${own}-other` }) }).addon, null);
  });

  test('a pin never falls back to another release', () => {
    const root = moduleRootWith([X64_15]);
    const result = findPrebuilt({ ...linuxX64, env: { ORTOOLS_NODE_PIN: '9.14' }, moduleRoot: root });
    assert.equal(result.addon, null);
    assert.deepEqual(result.tried, [`prebuilt ${X64_14} (ORTOOLS_NODE_PIN=9.14): not installed`]);
    assert.equal(result.suggested, `${X64_14}@1.0.0`);
  });

  test('suggests the newest package when none is installed', () => {
    const root = moduleRootWith([]);
    const result = findPrebuilt({ ...linuxX64, moduleRoot: root });
    assert.equal(result.addon, null);
    assert.deepEqual(result.tried, [`prebuilt ${X64_15}: not installed`, `prebuilt ${X64_14}: not installed`]);
    assert.equal(result.suggested, `${X64_15}@1.0.0`);
  });

  test('ignores packages for another CPU', () => {
    const root = moduleRootWith(['@ortools-node/linux-arm64-gnu-ortools9.15']);
    assert.equal(findPrebuilt({ ...linuxX64, moduleRoot: root }).addon, null);
    assert.equal(
      findPrebuilt({ ...linuxX64, arch: 'arm64', moduleRoot: root }).addon.origin,
      '@ortools-node/linux-arm64-gnu-ortools9.15',
    );
  });

  test('does not look for packages on musl', () => {
    const result = findPrebuilt({
      ...linuxX64,
      libc: 'musl',
      resolvePackage: () => assert.fail('package resolved'),
    });
    assert.equal(result.addon, null);
    assert.equal(result.suggested, null);
    assert.match(result.tried[0], /musl/);
  });

  test('fails loudly when an installed package has no addon', () => {
    const root = moduleRootWith([X64_15], { withAddon: false });
    assert.throws(() => findPrebuilt({ ...linuxX64, moduleRoot: root }), /linux-x64-gnu-ortools9\.15 is installed at .* but has no ortools_node\.node; reinstall it/);
  });

  test('rejects an invalid pin even when a package is installed', () => {
    assert.throws(() => findPrebuilt({ ...linuxX64, env: { ORTOOLS_NODE_PIN: '9' }, moduleRoot: both }), /ORTOOLS_NODE_PIN=9/);
  });

  test('propagates errors from an injected resolver', () => {
    const broken = Object.assign(new Error('EACCES'), { code: 'EACCES' });
    assert.throws(
      () => findPrebuilt({ ...linuxX64, resolvePackage: () => { throw broken; } }),
      (err) => err === broken,
    );
  });

  // These go through the real require.resolve, so only MODULE_NOT_FOUND may
  // read as "not installed"; a broken package must not be skipped silently.
  test('a corrupt package.json is an error, not "not installed"', () => {
    const root = moduleRootWith([X64_15]);
    fs.writeFileSync(path.join(root, 'node_modules', '@ortools-node', 'linux-x64-gnu-ortools9.15', 'package.json'), '{');
    assert.throws(() => findPrebuilt({ ...linuxX64, moduleRoot: root }), (err) => err.code === 'ERR_INVALID_PACKAGE_CONFIG');
  });

  test('a package that does not export its package.json is an error, not "not installed"', () => {
    const root = moduleRootWith([X64_15]);
    const manifest = { name: X64_15, version: FAKE_VERSION, exports: { '.': './ortools_node.node' } };
    fs.writeFileSync(path.join(root, 'node_modules', '@ortools-node', 'linux-x64-gnu-ortools9.15', 'package.json'), JSON.stringify(manifest));
    assert.throws(() => findPrebuilt({ ...linuxX64, moduleRoot: root }), (err) => err.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED');
  });
});

describe('resolveAddon', () => {
  test('a local source build wins over an installed prebuilt', () => {
    const root = moduleRootWith([X64_15]);
    const built = path.join(root, 'build', 'Release', ADDON_FILE);
    fs.mkdirSync(path.dirname(built), { recursive: true });
    fs.writeFileSync(built, '');
    assert.deepEqual(resolveAddon({ ...linuxX64, moduleRoot: root }), { path: built, origin: 'source build' });
  });

  test('without any addon, lists every place tried and both fixes', () => {
    const root = moduleRootWith([]);
    assert.throws(
      () => resolveAddon({ ...linuxX64, moduleRoot: root }),
      (err) => {
        assert.equal(err.code, 'ORTOOLS_NODE_ADDON_NOT_FOUND');
        assert.match(err.message, /build[/\\]Release[/\\]ortools_node\.node: not found/);
        assert.match(err.message, /build[/\\]Debug[/\\]ortools_node\.node: not found/);
        assert.match(err.message, /prebuilt @ortools-node\/linux-x64-gnu-ortools9\.14: not installed/);
        assert.match(err.message, /\(npm install @ortools-node\/linux-x64-gnu-ortools9\.15@1\.0\.0\)/);
        assert.match(err.message, /set ORTOOLS_ROOT to it and run `npm rebuild ortools-node`/);
        return true;
      },
    );
  });

  test('with a mismatched prebuilt, gives the versioned install command', () => {
    const root = moduleRootWith([X64_15], { version: '0.9.0' });
    assert.throws(
      () => resolveAddon({ ...linuxX64, moduleRoot: root }),
      (err) => {
        assert.equal(err.code, 'ORTOOLS_NODE_ADDON_NOT_FOUND');
        assert.match(err.message, /version 0\.9\.0 is installed, but ortools-node is 1\.0\.0/);
        assert.match(err.message, /\(npm install @ortools-node\/linux-x64-gnu-ortools9\.15@1\.0\.0\)/);
        return true;
      },
    );
  });

  test('on an unsupported system, only suggests building from source', () => {
    const root = moduleRootWith([]);
    assert.throws(
      () => resolveAddon({ ...linuxX64, libc: 'musl', moduleRoot: root }),
      (err) => {
        assert.match(err.message, /musl-based Linux \(such as Alpine\) is not supported/);
        assert.doesNotMatch(err.message, /npm install/);
        assert.match(err.message, /To fix it, build from source/);
        return true;
      },
    );
  });
});

describe('loadAddon', () => {
  test('requires the resolved addon', () => {
    const root = moduleRootWith([X64_15]);
    const loaded = [];
    const addon = loadAddon({ ...linuxX64, moduleRoot: root }, (file) => {
      loaded.push(file);
      return { ok: true };
    });
    assert.deepEqual(addon, { ok: true });
    assert.deepEqual(loaded, [path.join(root, 'node_modules', '@ortools-node', 'linux-x64-gnu-ortools9.15', ADDON_FILE)]);
  });

  test('names the package when loading fails, keeping the cause', () => {
    const root = moduleRootWith([X64_15]);
    const cause = new Error('libortools.so.9: cannot open shared object file');
    assert.throws(
      () => loadAddon({ ...linuxX64, moduleRoot: root }, () => { throw cause; }),
      (err) => {
        assert.match(err.message, /failed to load the addon from @ortools-node\/linux-x64-gnu-ortools9\.15 \(.*\): libortools\.so\.9/);
        assert.equal(err.cause, cause);
        return true;
      },
    );
  });
});
