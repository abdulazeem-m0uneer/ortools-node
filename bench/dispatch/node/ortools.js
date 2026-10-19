'use strict';
// ortools-node, optionally backed by another compiled addon: ORTOOLS_NODE_ADDON=/path/ortools_node.node
// (e.g. a build against OR-Tools 9.14 in build/v9.14). lib/native.js is the only place lib/ loads
// the addon, so pre-seeding its module cache entry swaps the native code for every module.

const Module = require('node:module');
const path = require('node:path');

const addon = process.env.ORTOOLS_NODE_ADDON;
if (addon) {
  const nativePath = require.resolve('../../../lib/native.js');
  const m = new Module(nativePath, module);
  m.filename = nativePath;
  m.paths = Module._nodeModulePaths(path.dirname(nativePath));
  m.exports = require(path.resolve(addon));
  m.loaded = true;
  require.cache[nativePath] = m;
}

module.exports = require('../../../lib');
