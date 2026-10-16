'use strict';

// Throwaway module roots whose node_modules hold fake prebuilt packages, so the
// loader runs through the real require.resolve. Removed when the test file ends.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after } = require('node:test');
const { ADDON_FILE } = require('../../lib/loader');

/** The version the fake packages get unless a test asks for another. */
const FAKE_VERSION = '1.0.0';

const roots = [];
after(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

/** A module root with the given packages installed, each with an addon file unless withAddon is false. */
function moduleRootWith(packages, { withAddon = true, version = FAKE_VERSION } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ortools-node-loader-'));
  roots.push(root);
  for (const name of packages) {
    const dir = path.join(root, 'node_modules', ...name.split('/'));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, version }));
    if (withAddon) fs.writeFileSync(path.join(dir, ADDON_FILE), '');
  }
  return root;
}

module.exports = { FAKE_VERSION, moduleRootWith };
