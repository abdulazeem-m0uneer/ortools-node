'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Node 24's `node --test` runs every .ts file under a test/ directory; the
// type-only usage checks live in types-test/ so a bare `node --test` passes.
test('no TypeScript file sits under test/', () => {
  const found = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (/\.[cm]?ts$/.test(entry.name)) found.push(path.relative(path.join(__dirname, '..'), file));
    }
  };
  walk(__dirname);
  assert.deepEqual(found, []);
});

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
