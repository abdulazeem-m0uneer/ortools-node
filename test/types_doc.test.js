'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Editors show only the JSDoc block right before a declaration, so a block
// followed by another block documents nothing.
test('no JSDoc block in the type declarations is orphaned', () => {
  const lib = path.join(__dirname, '..', 'lib');
  for (const file of fs.readdirSync(lib).filter((f) => f.endsWith('.d.ts'))) {
    const lines = fs.readFileSync(path.join(lib, file), 'utf8').split('\n');
    lines.forEach((line, i) => {
      const next = lines[i + 1];
      if (line.trimEnd().endsWith('*/') && next !== undefined && next.trimStart().startsWith('/**')) {
        assert.fail(`${file}:${i + 1}: JSDoc block is followed by another one`);
      }
    });
  }
});
