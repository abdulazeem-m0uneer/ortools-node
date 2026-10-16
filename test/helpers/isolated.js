'use strict';

// Runs misuse cases in a child `node` so that a regression that aborts the
// process (an OR-Tools CHECK failure) fails the test instead of killing the
// whole suite.

const { spawnSync } = require('node:child_process');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');

/**
 * `cases` maps a name to the source of a function body that must throw; `setup`
 * is source run first (with `ortools` in scope). Returns { status, signal,
 * stderr, results } where results maps each name to the thrown message, or to
 * null when the case did not throw.
 */
function runIsolated(setup, cases) {
  const body = Object.entries(cases).map(([name, code]) => `
    try { (() => { ${code} })(); results[${JSON.stringify(name)}] = null; }
    catch (e) { results[${JSON.stringify(name)}] = String(e && e.message !== undefined ? e.message : e); }`).join('\n');
  const script = `
    const ortools = require(${JSON.stringify(ROOT)});
    const results = {};
    ${setup}
    ${body}
    process.stdout.write(JSON.stringify(results));`;
  const child = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 60000 });
  let results = null;
  try {
    results = JSON.parse(child.stdout);
  } catch {
    results = null;
  }
  return { status: child.status, signal: child.signal, stderr: child.stderr, results };
}

module.exports = { runIsolated };
