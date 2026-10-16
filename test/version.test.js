'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
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

const PUBLIC_API = [
  'Solver', 'Variable', 'Constraint', 'SolveResult', 'supportsBackend', 'INF', 'native', 'ortoolsVersion', 'buildInfo',
  'FirstSolutionStrategy', 'LocalSearchMetaheuristic', 'RoutingSearchStatus', 'defaultRoutingSearchParameters',
  'validateRoutingSearchParameters', 'defaultSatParameters', 'validateSatParameters', 'durationMs',
];

test('the public API is unchanged by the module split', () => {
  for (const name of PUBLIC_API) assert.ok(name in ortools, `missing export ${name}`);
});

// ESM sees only the names Node's cjs-module-lexer can detect in lib/index.js.
test('every export is a named export when the package is imported as ESM', async () => {
  const esm = await import(pathToFileURL(require.resolve('..')).href);
  for (const name of [...PUBLIC_API, ...Object.keys(ortools)]) {
    assert.ok(name in esm, `missing ESM export ${name}`);
    assert.equal(esm[name], ortools[name], name);
  }
});
