'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const ortools = require('..');

test('reports the loaded OR-Tools version as major.minor.patch', () => {
  assert.match(ortools.ortoolsVersion, /^\d+\.\d+\.\d+$/);
});

test('the runtime OR-Tools is the one the addon was compiled against', () => {
  assert.equal(ortools.buildInfo.ortoolsVersion, ortools.ortoolsVersion);
  assert.equal(ortools.buildInfo.napiVersion, 8);
});

test('buildInfo cannot be mutated', () => {
  assert.ok(Object.isFrozen(ortools.buildInfo));
});

test('the public API is unchanged by the module split', () => {
  for (const name of ['Solver', 'Variable', 'Constraint', 'SolveResult', 'supportsBackend', 'INF', 'native']) {
    assert.ok(name in ortools, `missing export ${name}`);
  }
});
