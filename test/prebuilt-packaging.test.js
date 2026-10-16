'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ADDON_FILE, PREBUILT_TARGETS } = require('../lib/loader');
const { collectLibraries, componentOf, licenseExpression, parseNeeded, releaseOf } = require('../scripts/prebuilt/assemble');
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

test('licenseExpression lists the addon licence first and each licence once', () => {
  const components = ['libortools.so.9', 'libscip.so.10.0', 'libhighs.so.1', 'libz.so.1'].map(componentOf);
  assert.equal(licenseExpression(components), 'MIT AND Apache-2.0 AND Zlib');
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
      assert.equal(template.repository.directory, `npm/${target}`);
      // Set per OR-Tools release by scripts/prebuilt/assemble.js.
      for (const field of ['name', 'version', 'license']) assert.equal(template[field], undefined, field);
    });
  }
});
