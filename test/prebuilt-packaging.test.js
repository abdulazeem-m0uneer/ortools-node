'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ADDON_FILE, PREBUILT_TARGETS } = require('../lib/loader');
const {
  assemble,
  collectLibraries,
  componentOf,
  copyAddonLicences,
  copyLicences,
  findLibDir,
  licenseExpression,
  noticeMarkdown,
  ortoolsLicence,
  parseNeeded,
  releaseOf,
} = require('../scripts/prebuilt/assemble');
const { withPrebuiltOptionalDependencies } = require('../scripts/prebuilt/set-optional-deps');

const NPM_DIR = path.join(__dirname, '..', 'npm');

test('parseNeeded reads the DT_NEEDED entries of readelf -d', () => {
  const output = [
    'Dynamic section at offset 0x1e8d8 contains 30 entries:',
    '  Tag        Type                         Name/Value',
    ' 0x0000000000000001 (NEEDED)             Shared library: [libortools.so.9]',
    ' 0x0000000000000001 (NEEDED)             Shared library: [libstdc++.so.6]',
    ' 0x000000000000000e (SONAME)             Library soname: [libfoo.so.1]',
    ' 0x000000000000001d (RUNPATH)            Library runpath: [$ORIGIN]',
  ].join('\n');
  assert.deepEqual(parseNeeded(output), ['libortools.so.9', 'libstdc++.so.6']);
  assert.deepEqual(parseNeeded(''), []);
});

describe('collectLibraries', () => {
  const libDir = '/opt/or-tools/lib64';
  const graph = {
    '/build/ortools_node.node': ['libortools.so.9', 'libabsl_base.so.1', 'libc.so.6'],
    [`${libDir}/libortools.so.9`]: ['libabsl_base.so.1', 'libz.so.1', 'libstdc++.so.6'],
    // A cycle back to libortools must not loop.
    [`${libDir}/libabsl_base.so.1`]: ['libortools.so.9', 'libm.so.6'],
    [`${libDir}/libz.so.1`]: ['libc.so.6'],
  };
  const needed = (file) => graph[file] ?? assert.fail(`unexpected readelf ${file}`);
  const exists = (file) => file in graph;

  test('follows DT_NEEDED transitively, splitting bundled from system libraries', () => {
    assert.deepEqual(collectLibraries('/build/ortools_node.node', { libDir, needed, exists }), {
      bundled: ['libabsl_base.so.1', 'libortools.so.9', 'libz.so.1'],
      system: ['libc.so.6', 'libm.so.6', 'libstdc++.so.6'],
    });
  });

  test('fails on a library that is neither bundled nor part of the base system', () => {
    const withGomp = { ...graph, [`${libDir}/libz.so.1`]: ['libgomp.so.1'] };
    assert.throws(
      () => collectLibraries('/build/ortools_node.node', { libDir, needed: (f) => withGomp[f], exists }),
      /libz\.so\.1 needs libgomp\.so\.1, which is neither in \/opt\/or-tools\/lib64 nor a base system library/,
    );
  });
});

describe('componentOf', () => {
  test('maps the OR-Tools archive libraries to their projects', () => {
    const cases = {
      'libortools.so.9': 'OR-Tools',
      'libabsl_flags_parse.so.2508.0.0': 'Abseil',
      'libprotobuf.so.33.1.0': 'Protocol Buffers',
      'libutf8_validity.so.33.1.0': 'utf8_range (part of Protocol Buffers)',
      'libre2.so.11': 'RE2',
      'libhighs.so.1': 'HiGHS',
      'libscip.so.10.0': 'SCIP',
      'libsoplexshared.so.8.0': 'SoPlex',
      'libCbcSolver.so.2': 'COIN-OR Cbc, Cgl, Clp, CoinUtils and Osi',
      'libOsiClp.so.1': 'COIN-OR Cbc, Cgl, Clp, CoinUtils and Osi',
      'libz.so.1': 'zlib',
      'libbz2.so.1': 'bzip2',
    };
    for (const [soname, name] of Object.entries(cases)) assert.equal(componentOf(soname).name, name, soname);
  });

  test('fails on an unknown library so its licence gets reviewed', () => {
    assert.throws(() => componentOf('libgurobi.so.12'), /libgurobi\.so\.12 is not a known OR-Tools dependency; add it to COMPONENTS/);
  });
});

describe('licenseExpression', () => {
  const components = ['libortools.so.9', 'libscip.so.10.0', 'libhighs.so.1', 'libz.so.1'].map(componentOf);

  test('lists the addon licence first and each licence once', () => {
    assert.equal(licenseExpression('MIT', components), 'MIT AND Apache-2.0 AND Zlib');
  });

  test('keeps every licence of a compound addon licence', () => {
    assert.equal(licenseExpression('MIT AND Apache-2.0', components), 'MIT AND Apache-2.0 AND Zlib');
    assert.equal(licenseExpression('MIT AND BSD-3-Clause', []), 'MIT AND BSD-3-Clause');
  });

  test('fails on an addon licence it cannot combine with AND', () => {
    for (const bad of [undefined, '', 'MIT OR Apache-2.0', '(MIT AND Apache-2.0)', 'MIT AND ', '-', 'MIT AND -x', { type: 'MIT' }]) {
      assert.throws(() => licenseExpression(bad, components), /Cannot combine the package\.json licence/, String(bad));
    }
  });

  test('refuses an UNLICENSED addon: a prebuilt ships under the addon licence', () => {
    for (const bad of ['UNLICENSED', 'unlicensed', 'MIT AND UNLICENSED']) {
      assert.throws(() => licenseExpression(bad, components), /ortools-node must be licensed to ship prebuilts/, bad);
    }
  });
});

test('releaseOf accepts only full versions of supported releases', () => {
  assert.equal(releaseOf('9.15.6755'), '9.15');
  assert.equal(releaseOf('9.14.6206'), '9.14');
  for (const bad of ['9.13.4544', '9.15', 'v9.15.6755', '']) {
    assert.throws(() => releaseOf(bad), /Unsupported OR-Tools version/, bad);
  }
});

describe('withPrebuiltOptionalDependencies', () => {
  test('adds the newest release prebuilts at the package version', () => {
    const manifest = { name: 'ortools-node', version: '1.2.3' };
    assert.deepEqual(withPrebuiltOptionalDependencies(manifest).optionalDependencies, {
      '@ortools-node/linux-x64-gnu-ortools9.15': '1.2.3',
      '@ortools-node/linux-arm64-gnu-ortools9.15': '1.2.3',
    });
    assert.equal(manifest.optionalDependencies, undefined, 'input left unchanged');
  });

  test('keeps other optional dependencies', () => {
    const updated = withPrebuiltOptionalDependencies({ version: '1.0.0', optionalDependencies: { other: '^1' } });
    assert.equal(updated.optionalDependencies.other, '^1');
  });
});

describe('platform package templates', () => {
  test('exist for exactly the targets the loader knows', () => {
    assert.deepEqual(fs.readdirSync(NPM_DIR).sort(), [...PREBUILT_TARGETS].sort());
  });

  for (const target of PREBUILT_TARGETS) {
    test(`${target} restricts npm to its OS, CPU and C library`, () => {
      const template = JSON.parse(fs.readFileSync(path.join(NPM_DIR, target, 'package.json'), 'utf8'));
      const [os, cpu] = target.split('-');
      assert.deepEqual(template.os, [os]);
      assert.deepEqual(template.cpu, [cpu]);
      assert.deepEqual(template.libc, ['glibc']);
      assert.equal(template.main, ADDON_FILE);
      assert.ok(template.files.includes(ADDON_FILE));
      assert.ok(template.files.includes('*.so*'));
      // assemble() copies ortools-node's NOTICE and LICENSES/ when the repository has them.
      assert.ok(template.files.includes('NOTICE'));
      assert.ok(template.files.includes('LICENSES/'));
      assert.equal(template.repository.directory, `npm/${target}`);
      // Set per OR-Tools release by scripts/prebuilt/assemble.js.
      for (const field of ['name', 'version', 'license']) assert.equal(template[field], undefined, field);
    });
  }
});

// copy_worktree runs only in the Linux packaging scripts and uses bash and GNU
// cp --parents, which macOS and Windows do not have.
const hasBash = spawnSync('bash', ['-c', 'true']).status === 0;
const worktreeSkip = process.platform !== 'linux' ? 'copy_worktree needs Linux (GNU cp)' : !hasBash && 'copy_worktree needs bash';

// Git that ignores the developer's global and system config (signing, hooks,
// templates), so the test commit works on any machine.
function hermeticGitEnv() {
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  for (const key of Object.keys(env)) {
    if (/^GIT_CONFIG_(COUNT|KEY_\d+|VALUE_\d+|PARAMETERS)$/.test(key)) delete env[key];
  }
  return env;
}

describe('copy_worktree (scripts/common.sh)', { skip: worktreeSkip }, () => {
  const commonSh = path.join(__dirname, '..', 'scripts', 'common.sh');

  test('copies the working tree and succeeds when the last tracked file was deleted', (t) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ortools-node-worktree-'));
    t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
    const repo = path.join(tmp, 'repo');
    const dest = path.join(tmp, 'dest');
    fs.mkdirSync(path.join(repo, 'sub'), { recursive: true });
    fs.mkdirSync(dest);
    fs.writeFileSync(path.join(repo, 'sub', 'kept.txt'), 'kept');
    fs.writeFileSync(path.join(repo, 'zz-deleted.txt'), 'gone');
    fs.writeFileSync(path.join(repo, 'untracked.txt'), 'new');
    fs.writeFileSync(path.join(repo, '.gitignore'), 'ignored.txt\n');
    fs.writeFileSync(path.join(repo, 'ignored.txt'), 'ignored');
    const gitEnv = hermeticGitEnv();
    const git = (...args) => execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe', env: gitEnv });
    git('init', '-q');
    git('add', '.gitignore', 'sub/kept.txt', 'zz-deleted.txt');
    git(
      '-c', 'user.name=test', '-c', 'user.email=test@example.com',
      '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null',
      'commit', '-q', '-m', 'init',
    );
    // git ls-files still lists it, and sorts it last.
    fs.rmSync(path.join(repo, 'zz-deleted.txt'));

    const script = 'set -euo pipefail; source "$1"; ortools_node_root=$2; copy_worktree "$3"; echo survived';
    const result = spawnSync('bash', ['-c', script, 'bash', commonSh, repo, dest], { encoding: 'utf8', env: gitEnv });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), 'survived');
    assert.equal(fs.readFileSync(path.join(dest, 'sub', 'kept.txt'), 'utf8'), 'kept');
    assert.ok(fs.existsSync(path.join(dest, 'untracked.txt')));
    assert.ok(!fs.existsSync(path.join(dest, 'zz-deleted.txt')));
    assert.ok(!fs.existsSync(path.join(dest, 'ignored.txt')));
  });
});

describe('assemble', () => {
  // A fake OR-Tools root: libraries in libDirName, with a licence unless told not to.
  function fakeOrtools(t, { libDirName = 'lib64', licence = true } = {}) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ortools-node-assemble-'));
    t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
    const root = path.join(tmp, 'or-tools');
    const libDir = path.join(root, libDirName);
    fs.mkdirSync(libDir, { recursive: true });
    fs.writeFileSync(path.join(libDir, 'libortools.so.9.15.6755'), 'ortools-real');
    fs.symlinkSync('libortools.so.9.15.6755', path.join(libDir, 'libortools.so.9'));
    fs.writeFileSync(path.join(libDir, 'libz.so.1'), 'zlib');
    if (licence) {
      fs.mkdirSync(path.join(root, 'share', 'doc', 'ortools'), { recursive: true });
      fs.writeFileSync(path.join(root, 'share', 'doc', 'ortools', 'LICENSE'), 'Apache');
      fs.mkdirSync(path.join(root, 'share', 'licenses', 'scip'), { recursive: true });
      fs.writeFileSync(path.join(root, 'share', 'licenses', 'scip', 'LICENSE'), 'scip');
    }
    const addon = path.join(tmp, ADDON_FILE);
    fs.writeFileSync(addon, 'addon');
    const templateDir = path.join(tmp, 'npm');
    fs.mkdirSync(path.join(templateDir, 'linux-x64-gnu'), { recursive: true });
    const writeTemplate = (template) =>
      fs.writeFileSync(path.join(templateDir, 'linux-x64-gnu', 'package.json'), JSON.stringify(template));
    writeTemplate({ description: 'Prebuilt', os: ['linux'], cpu: ['x64'] });
    // A fake ortools-node repository: its version, licence and licence files.
    const repoRoot = path.join(tmp, 'repo');
    fs.mkdirSync(repoRoot);
    const writeRootPackage = (fields) =>
      fs.writeFileSync(path.join(repoRoot, 'package.json'), JSON.stringify({ name: 'ortools-node', version: '2.3.4', license: 'MIT', ...fields }));
    writeRootPackage({});
    fs.writeFileSync(path.join(repoRoot, 'LICENSE'), 'MIT licence');
    return { root, libDir, addon, templateDir, writeTemplate, repoRoot, writeRootPackage, outDir: path.join(tmp, 'pkg') };
  }
  // What the solvers' vendored Apache-2.0 code adds to the repository.
  function addApacheCode(f) {
    f.writeRootPackage({ license: 'MIT AND Apache-2.0' });
    fs.writeFileSync(path.join(f.repoRoot, 'NOTICE'), 'arc_flow.cc: Apache-2.0 (LICENSES/Apache-2.0.txt)');
    fs.mkdirSync(path.join(f.repoRoot, 'LICENSES'));
    fs.writeFileSync(path.join(f.repoRoot, 'LICENSES', 'Apache-2.0.txt'), 'Apache text');
  }
  const collect = () => ({ bundled: ['libortools.so.9', 'libz.so.1'], system: ['libc.so.6'] });
  const run = (f, extra = {}) =>
    assemble({
      target: 'linux-x64-gnu',
      ortoolsVersion: '9.15.6755',
      addon: f.addon,
      ortoolsRoot: f.root,
      outDir: f.outDir,
      templateDir: f.templateDir,
      collect,
      repoRoot: f.repoRoot,
      ...extra,
    });

  test('findLibDir picks lib64/ (AlmaLinux archives) or lib/', (t) => {
    const alma = fakeOrtools(t);
    assert.equal(findLibDir(alma.root), path.join(alma.root, 'lib64'));
    const ubuntu = fakeOrtools(t, { libDirName: 'lib' });
    assert.equal(findLibDir(ubuntu.root), path.join(ubuntu.root, 'lib'));
  });

  test('findLibDir prefers lib64/ when both have libortools.so', (t) => {
    const f = fakeOrtools(t);
    fs.mkdirSync(path.join(f.root, 'lib'));
    fs.writeFileSync(path.join(f.root, 'lib', 'libortools.so.9'), '');
    assert.equal(findLibDir(f.root), path.join(f.root, 'lib64'));
  });

  test('findLibDir ignores a lib64/ without libortools.so', (t) => {
    const f = fakeOrtools(t, { libDirName: 'lib' });
    fs.mkdirSync(path.join(f.root, 'lib64'));
    fs.writeFileSync(path.join(f.root, 'lib64', 'libz.so.1'), '');
    assert.equal(findLibDir(f.root), path.join(f.root, 'lib'));
  });

  test('findLibDir fails without libortools.so', (t) => {
    const f = fakeOrtools(t);
    for (const file of fs.readdirSync(f.libDir)) if (file.startsWith('libortools')) fs.rmSync(path.join(f.libDir, file));
    assert.throws(() => findLibDir(f.root), /No libortools\.so under .*lib64 or .*lib/);
  });

  test('refuses an OR-Tools root without its licence, before writing anything', (t) => {
    const f = fakeOrtools(t, { licence: false });
    assert.throws(() => run(f), new RegExp(`The OR-Tools archive has no licence at ${ortoolsLicence(f.root).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    assert.ok(!fs.existsSync(f.outDir));
  });

  test('refuses a repository without its LICENSE, before writing anything', (t) => {
    const f = fakeOrtools(t);
    fs.rmSync(path.join(f.repoRoot, 'LICENSE'));
    assert.throws(() => run(f), /ortools-node has no licence at .*repo.LICENSE/);
    assert.ok(!fs.existsSync(f.outDir));
  });

  test('refuses a root licence it cannot combine, before writing anything', (t) => {
    const f = fakeOrtools(t);
    f.writeRootPackage({ license: 'MIT OR Apache-2.0' });
    assert.throws(() => run(f), /Cannot combine the package\.json licence "MIT OR Apache-2\.0"/);
    assert.ok(!fs.existsSync(f.outDir));
  });

  test('refuses an UNLICENSED root, before writing anything', (t) => {
    const f = fakeOrtools(t);
    f.writeRootPackage({ license: 'UNLICENSED' });
    assert.throws(() => run(f), /ortools-node must be licensed to ship prebuilts/);
    assert.ok(!fs.existsSync(f.outDir));
  });

  test('refuses an existing output directory', (t) => {
    const f = fakeOrtools(t);
    fs.mkdirSync(f.outDir);
    fs.writeFileSync(path.join(f.outDir, 'keep'), 'x');
    assert.throws(() => run(f), /pkg already exists/);
    assert.deepEqual(fs.readdirSync(f.outDir), ['keep']);
  });

  test('copies each library as a real file under its SONAME, plus the addon', (t) => {
    const f = fakeOrtools(t);
    run(f);
    const lib = path.join(f.outDir, 'libortools.so.9');
    assert.ok(!fs.lstatSync(lib).isSymbolicLink());
    assert.equal(fs.readFileSync(lib, 'utf8'), 'ortools-real');
    assert.equal(fs.readFileSync(path.join(f.outDir, 'libz.so.1'), 'utf8'), 'zlib');
    assert.equal(fs.readFileSync(path.join(f.outDir, ADDON_FILE), 'utf8'), 'addon');
    assert.ok(!fs.existsSync(path.join(f.outDir, 'libortools.so.9.15.6755')));
  });

  test('writes name, version and licence that a template cannot override', (t) => {
    const f = fakeOrtools(t);
    f.writeTemplate({ name: 'evil', version: '9.9.9', license: 'UNLICENSED', description: 'Prebuilt', cpu: ['x64'] });
    run(f);
    const manifest = JSON.parse(fs.readFileSync(path.join(f.outDir, 'package.json'), 'utf8'));
    assert.equal(manifest.name, '@ortools-node/linux-x64-gnu-ortools9.15');
    assert.equal(manifest.version, '2.3.4');
    assert.equal(manifest.license, 'MIT AND Apache-2.0 AND Zlib');
    assert.equal(manifest.description, 'Prebuilt, built against OR-Tools 9.15.6755');
    assert.deepEqual(manifest.cpu, ['x64']);
  });

  test('takes the licence from the root package.json and copies its LICENSE', (t) => {
    const f = fakeOrtools(t);
    run(f);
    const manifest = JSON.parse(fs.readFileSync(path.join(f.outDir, 'package.json'), 'utf8'));
    assert.equal(manifest.license, 'MIT AND Apache-2.0 AND Zlib');
    assert.equal(fs.readFileSync(path.join(f.outDir, 'LICENSE'), 'utf8'), 'MIT licence');
    assert.ok(!fs.existsSync(path.join(f.outDir, 'NOTICE')));
    const notice = fs.readFileSync(path.join(f.outDir, 'THIRD_PARTY_NOTICES.md'), 'utf8');
    assert.match(notice, /The addon itself is licensed under MIT \(LICENSE\)\./);
  });

  test('carries a compound root licence, its NOTICE and its LICENSES/ into the package', (t) => {
    const f = fakeOrtools(t);
    addApacheCode(f);
    run(f);
    const manifest = JSON.parse(fs.readFileSync(path.join(f.outDir, 'package.json'), 'utf8'));
    assert.equal(manifest.license, 'MIT AND Apache-2.0 AND Zlib');
    assert.equal(fs.readFileSync(path.join(f.outDir, 'NOTICE'), 'utf8'), 'arc_flow.cc: Apache-2.0 (LICENSES/Apache-2.0.txt)');
    assert.equal(fs.readFileSync(path.join(f.outDir, 'LICENSES', 'Apache-2.0.txt'), 'utf8'), 'Apache text');
    // The OR-Tools archive's licences sit beside ortools-node's own.
    assert.equal(fs.readFileSync(path.join(f.outDir, 'LICENSES', 'scip', 'LICENSE'), 'utf8'), 'scip');
    const notice = fs.readFileSync(path.join(f.outDir, 'THIRD_PARTY_NOTICES.md'), 'utf8');
    assert.match(notice, /The addon itself is licensed under MIT AND Apache-2\.0 \(LICENSE, NOTICE, LICENSES\/Apache-2\.0\.txt\)\./);
  });

  test('copies symlinked root licence files as the files they point to', (t) => {
    const f = fakeOrtools(t);
    addApacheCode(f);
    fs.renameSync(path.join(f.repoRoot, 'LICENSE'), path.join(f.repoRoot, 'REAL_LICENSE'));
    fs.symlinkSync('REAL_LICENSE', path.join(f.repoRoot, 'LICENSE'));
    fs.renameSync(path.join(f.repoRoot, 'LICENSES', 'Apache-2.0.txt'), path.join(f.repoRoot, 'Apache.txt'));
    fs.symlinkSync(path.join(f.repoRoot, 'Apache.txt'), path.join(f.repoRoot, 'LICENSES', 'Apache-2.0.txt'));
    run(f);
    // npm pack leaves symlinks out, so each licence must be a regular file.
    for (const file of ['LICENSE', path.join('LICENSES', 'Apache-2.0.txt')]) {
      assert.ok(fs.lstatSync(path.join(f.outDir, file)).isFile(), file);
    }
    assert.equal(fs.readFileSync(path.join(f.outDir, 'LICENSE'), 'utf8'), 'MIT licence');
    assert.equal(fs.readFileSync(path.join(f.outDir, 'LICENSES', 'Apache-2.0.txt'), 'utf8'), 'Apache text');
  });

  test('refuses a broken NOTICE or LICENSES/ symlink in the repository, naming it', (t) => {
    for (const [entry, dangling] of [['NOTICE', 'NOTICE'], ['LICENSES', 'LICENSES'], ['LICENSES', path.join('LICENSES', 'Apache-2.0.txt')]]) {
      const f = fakeOrtools(t);
      if (dangling !== entry) fs.mkdirSync(path.join(f.repoRoot, entry));
      fs.symlinkSync(path.join(f.repoRoot, 'missing'), path.join(f.repoRoot, dangling));
      const escaped = path.join(f.repoRoot, dangling).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      assert.throws(() => run(f), new RegExp(`Broken symlink: ${escaped} `), dangling);
      assert.ok(!fs.existsSync(f.outDir), dangling);
    }
  });

  test('never deletes an output directory another process created first', (t) => {
    const f = fakeOrtools(t);
    // A licence clash makes assembly fail after outDir is created.
    fs.mkdirSync(path.join(f.repoRoot, 'LICENSES', 'scip'), { recursive: true });
    fs.writeFileSync(path.join(f.repoRoot, 'LICENSES', 'scip', 'LICENSE'), 'ours');
    // The other process wins the race just before assemble creates outDir.
    const mkdirSync = fs.mkdirSync;
    t.mock.method(fs, 'mkdirSync', (dir, ...rest) => {
      if (dir === f.outDir && !fs.existsSync(f.outDir)) {
        mkdirSync(f.outDir);
        fs.writeFileSync(path.join(f.outDir, 'theirs'), 'x');
      }
      return mkdirSync(dir, ...rest);
    });
    assert.throws(() => run(f), /pkg already exists/);
    assert.equal(fs.readFileSync(path.join(f.outDir, 'theirs'), 'utf8'), 'x');
  });

  test('removes the partial package when a root licence clashes with the OR-Tools archive', (t) => {
    const f = fakeOrtools(t);
    fs.mkdirSync(path.join(f.repoRoot, 'LICENSES', 'scip'), { recursive: true });
    fs.writeFileSync(path.join(f.repoRoot, 'LICENSES', 'scip', 'LICENSE'), 'ours');
    assert.throws(() => run(f), { code: 'EEXIST' });
    assert.ok(!fs.existsSync(f.outDir));
    // With the clash gone, a rerun is not blocked by leftovers.
    fs.rmSync(path.join(f.repoRoot, 'LICENSES'), { recursive: true });
    run(f);
    assert.equal(fs.readFileSync(path.join(f.outDir, 'LICENSES', 'scip', 'LICENSE'), 'utf8'), 'scip');
  });

  test('copyAddonLicences refuses to overwrite a licence from the OR-Tools archive', (t) => {
    const f = fakeOrtools(t);
    fs.mkdirSync(path.join(f.repoRoot, 'LICENSES', 'scip'), { recursive: true });
    fs.writeFileSync(path.join(f.repoRoot, 'LICENSES', 'scip', 'LICENSE'), 'ours');
    fs.mkdirSync(f.outDir);
    copyLicences(f.root, f.outDir);
    assert.throws(() => copyAddonLicences(f.repoRoot, f.outDir), { code: 'EEXIST' });
    assert.equal(fs.readFileSync(path.join(f.outDir, 'LICENSES', 'scip', 'LICENSE'), 'utf8'), 'scip');
  });

  test('copyLicences copies the OR-Tools licence and the archive\'s third-party ones', (t) => {
    const f = fakeOrtools(t);
    fs.mkdirSync(f.outDir);
    const files = copyLicences(f.root, f.outDir);
    assert.deepEqual(files, [path.join('LICENSES', 'or-tools', 'LICENSE'), path.join('LICENSES', 'scip', 'LICENSE')]);
    assert.equal(fs.readFileSync(path.join(f.outDir, 'LICENSES', 'or-tools', 'LICENSE'), 'utf8'), 'Apache');
  });

  test('copyLicences copies symlinked archive licences as the files they point to', (t) => {
    const f = fakeOrtools(t);
    const scip = path.join(f.root, 'share', 'licenses', 'scip', 'LICENSE');
    fs.renameSync(scip, path.join(f.root, 'scip.txt'));
    fs.symlinkSync(path.join(f.root, 'scip.txt'), scip);
    fs.mkdirSync(f.outDir);
    copyLicences(f.root, f.outDir);
    const copied = path.join(f.outDir, 'LICENSES', 'scip', 'LICENSE');
    assert.ok(fs.lstatSync(copied).isFile());
    assert.equal(fs.readFileSync(copied, 'utf8'), 'scip');
  });

  test('THIRD_PARTY_NOTICES has one row per component and lists the licence files', (t) => {
    const f = fakeOrtools(t);
    run(f);
    const notice = fs.readFileSync(path.join(f.outDir, 'THIRD_PARTY_NOTICES.md'), 'utf8');
    assert.match(notice, /OR-Tools 9\.15\.6755 C\+\+ release/);
    const rows = notice.split('\n').filter((l) => /^\| \[/.test(l));
    assert.deepEqual(rows, [
      '| [OR-Tools](https://github.com/google/or-tools) | Apache-2.0 | `libortools.so.9` |',
      '| [zlib](https://zlib.net) | Zlib | `libz.so.1` |',
    ]);
    assert.match(notice, /- `LICENSES\/scip\/LICENSE`/);
  });

  test('noticeMarkdown joins several libraries of one component', () => {
    const absl = componentOf('libabsl_base.so.1');
    const md = noticeMarkdown({
      ortoolsVersion: '9.14.6206',
      addonLicense: 'MIT',
      addonLicenceFiles: ['LICENSE'],
      components: [absl],
      librariesByComponent: new Map([[absl, ['libabsl_base.so.1', 'libabsl_city.so.1']]]),
      licenceFiles: [],
    });
    assert.match(md, /\| Apache-2\.0 \| `libabsl_base\.so\.1`, `libabsl_city\.so\.1` \|/);
  });
});
