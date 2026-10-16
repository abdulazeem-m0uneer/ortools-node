'use strict';
// ESM `import { CpModel } from 'ortools-node'` sees only the named exports
// cjs-module-lexer can detect in lib/index.js.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const SAT_EXPORTS = [
  'CpModel', 'CpSolver', 'CpLinearExpr', 'CpConstraint', 'IntVar', 'NotBooleanVariable', 'BoundedLinearExpr',
  'IntervalVar', 'Domain', 'SolutionSnapshot', 'CpSolverStatus', 'VariableSelectionStrategy',
  'DomainReductionStrategy',
];

test('every CP-SAT export is a named ESM export', async () => {
  const esm = await import(pathToFileURL(path.join(__dirname, '..', 'lib', 'index.js')).href);
  const cjs = require('..');
  for (const name of SAT_EXPORTS) {
    assert.ok(name in esm, `import { ${name} } is missing`);
    assert.equal(esm[name], cjs[name], name);
  }
  const model = new esm.CpModel();
  model.newBoolVar('b');
  assert.equal(new esm.CpSolver().solveSync(model), 'OPTIMAL');
});
