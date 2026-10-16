'use strict';

// npm "install" hook: keep or rebuild a source build, use a prebuilt platform
// package when one is installed, otherwise compile the addon from source.

const { spawnSync } = require('node:child_process');
const { findAddon, notFoundMessage } = require('../lib/loader');

const PACKAGE_NAME = require('../package.json').name;

/**
 * True for `npm install --build-from-source` or `--build-from-source=ortools-node`
 * (npm exports it as npm_config_build_from_source). A flag naming another
 * package, as node-pre-gyp allows, is not for this one.
 */
function buildFromSourceRequested(env) {
  const value = env.npm_config_build_from_source;
  return value !== undefined && (value.toLowerCase() === 'true' || value === PACKAGE_NAME);
}

/**
 * What the install hook does: { action: 'compile' | 'skip', message, warning?,
 * helpOnFailure? }, where helpOnFailure is printed if that compile fails.
 * `lookup` is findAddon (injected for tests), the same resolution the loader
 * uses, so the hook acts on the addon that would load: a source
 * build (recompiled when ORTOOLS_ROOT is set, else kept, as `cmake-js compile`
 * used to), then a prebuilt. --build-from-source skips the lookup, and an
 * ORTOOLS_NODE_PIN without prebuilts only warns. With nothing to load and no
 * ORTOOLS_ROOT it still tries a source build, and explains what to do only if
 * that fails.
 */
function decideInstall({ env, lookup }) {
  if (buildFromSourceRequested(env)) {
    return { action: 'compile', message: 'building from source (--build-from-source)' };
  }
  let found;
  try {
    found = lookup();
  } catch (err) {
    if (err.code !== 'ORTOOLS_NODE_INVALID_PIN') throw err;
    const warning = `${err.message}; ignoring it for the source build`;
    if (env.ORTOOLS_ROOT) return { ...compileAgainstRoot(env), warning };
    return { ...compileWithCMakeSearch(), warning, helpOnFailure: `the source build failed, and ${err.message}` };
  }
  if (found.addon?.origin === 'source build') {
    if (env.ORTOOLS_ROOT) return { action: 'compile', message: `recompiling the source build against ORTOOLS_ROOT=${env.ORTOOLS_ROOT}` };
    return {
      action: 'skip',
      message: `keeping the source build at ${found.addon.path} (run \`npm run build\` to recompile it)`,
    };
  }
  if (found.addon) return { action: 'skip', message: `using the prebuilt addon from ${found.addon.origin}` };
  if (env.ORTOOLS_ROOT) return compileAgainstRoot(env);
  return {
    ...compileWithCMakeSearch(),
    helpOnFailure: `no prebuilt addon for this system, and the source build failed. ${notFoundMessage(found.tried, found.suggested)}`,
  };
}

function compileAgainstRoot(env) {
  return { action: 'compile', message: `no prebuilt addon; building from source against ORTOOLS_ROOT=${env.ORTOOLS_ROOT}` };
}

// As `cmake-js compile` did: find_package(ortools) may still succeed through
// CMAKE_PREFIX_PATH, ortools_DIR or a system install.
function compileWithCMakeSearch() {
  return {
    action: 'compile',
    message: "no prebuilt addon and ORTOOLS_ROOT is not set; trying a source build with CMake's own search for OR-Tools",
  };
}

/** Runs `cmake-js compile` with this Node.js; returns its exit code. */
function compileFromSource(spawn = spawnSync) {
  const cmakeJs = require.resolve('cmake-js/bin/cmake-js');
  const result = spawn(process.execPath, [cmakeJs, 'compile'], { stdio: 'inherit' });
  if (result.error) {
    console.error(`ortools-node: could not run cmake-js: ${result.error.message}`);
    return 1;
  }
  if (result.status === null) {
    console.error(`ortools-node: cmake-js was killed by ${result.signal}`);
    return 1;
  }
  return result.status;
}

/** Runs the install hook; returns the process exit code. */
function main({
  env = process.env,
  lookup = () => findAddon({ env }),
  compile = compileFromSource,
  log = console.log,
  logError = console.error,
} = {}) {
  let decision;
  try {
    decision = decideInstall({ env, lookup });
  } catch (err) {
    decision = { action: 'fail', message: err.message };
  }
  if (decision.action === 'fail') {
    logError(`ortools-node: ${decision.message}`);
    return 1;
  }
  if (decision.warning) logError(`ortools-node: warning: ${decision.warning}`);
  log(`ortools-node: ${decision.message}`);
  if (decision.action !== 'compile') return 0;
  const code = compile();
  if (code !== 0 && decision.helpOnFailure) logError(`ortools-node: ${decision.helpOnFailure}`);
  return code;
}

if (require.main === module) process.exitCode = main();

module.exports = { buildFromSourceRequested, compileFromSource, decideInstall, main };
