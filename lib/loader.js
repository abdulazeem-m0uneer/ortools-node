'use strict';

// Finds the compiled addon: a local source build first, then the prebuilt
// platform package for this OS, CPU, C library and OR-Tools release.
//
// Every function takes its environment (platform, env, file checks, package
// resolution) as arguments so the decisions can be tested without installing
// anything; loadAddon() wires in the real process.

const fs = require('node:fs');
const path = require('node:path');

const ADDON_FILE = 'ortools_node.node';
const PACKAGE_SCOPE = '@ortools-node';
const PIN_ENV = 'ORTOOLS_NODE_PIN';
const MODULE_ROOT = path.join(__dirname, '..');
/** A prebuilt package must have exactly this ortools-node's version. */
const PACKAGE_VERSION = require('../package.json').version;
/** Where `cmake-js compile` and `cmake-js compile --debug` put the addon. */
const SOURCE_BUILD_DIRS = Object.freeze(['build/Release', 'build/Debug']);
/** OR-Tools releases (major.minor) that have prebuilt packages, newest first. */
const ORTOOLS_RELEASES = Object.freeze(['9.15', '9.14']);
/** `${platform}-${arch}` with a glibc prebuilt package, and its package key. */
const GLIBC_TARGETS = Object.freeze({ 'linux-x64': 'linux-x64-gnu', 'linux-arm64': 'linux-arm64-gnu' });
/** Every prebuilt package key; each has a template in npm/<key>/package.json. */
const PREBUILT_TARGETS = Object.freeze(Object.values(GLIBC_TARGETS));

const BUILD_FROM_SOURCE_FIX =
  'build from source: install a C++17 toolchain and CMake, download an OR-Tools C++ release, ' +
  'set ORTOOLS_ROOT to it and run `npm rebuild ortools-node`';

/** npm package name of a prebuilt, e.g. `@ortools-node/linux-x64-gnu-ortools9.15`. */
function prebuiltPackageName(targetKey, release) {
  return `${PACKAGE_SCOPE}/${targetKey}-ortools${release}`;
}

/** The C library this process runs on: 'glibc', 'musl', 'unknown', or null off Linux. */
function detectLibc(platform = process.platform, readReport = readProcessReport) {
  if (platform !== 'linux') return null;
  const report = readReport();
  if (report?.header?.glibcVersionRuntime) return 'glibc';
  const sharedObjects = report?.sharedObjects ?? [];
  if (sharedObjects.some((file) => /(?:^|\/)(?:ld-musl-|libc\.musl-)/.test(file))) return 'musl';
  return 'unknown';
}

function readProcessReport() {
  // Skip the network section: it can block on DNS and is not needed here.
  const report = process.report;
  if (!('excludeNetwork' in report)) return report.getReport();
  const previous = report.excludeNetwork;
  report.excludeNetwork = true;
  try {
    return report.getReport();
  } finally {
    report.excludeNetwork = previous;
  }
}

/**
 * The prebuilt package key for a machine, e.g. `linux-x64-gnu`, or the reason
 * there is none.
 */
function prebuiltTarget({ platform, arch, libc }) {
  if (platform === 'linux' && libc === 'musl') {
    return {
      key: null,
      reason: 'Prebuilt binaries need glibc; musl-based Linux (such as Alpine) is not supported. ' +
        'Use a glibc-based image such as Debian or Ubuntu',
    };
  }
  if (platform === 'linux' && libc !== 'glibc') {
    return { key: null, reason: 'Could not detect the C library of this Linux system; prebuilt binaries need glibc' };
  }
  const key = GLIBC_TARGETS[`${platform}-${arch}`];
  if (!key) {
    const supported = Object.keys(GLIBC_TARGETS).join(', ');
    return { key: null, reason: `No prebuilt binaries for ${platform}-${arch} (available for ${supported} with glibc)` };
  }
  return { key, reason: null };
}

/** The OR-Tools release chosen with ORTOOLS_NODE_PIN, or null when unset. */
function parsePin(value) {
  if (value === undefined || value === '') return null;
  if (!ORTOOLS_RELEASES.includes(value)) {
    const err = new Error(
      `${PIN_ENV}=${value} is not an OR-Tools release with prebuilt binaries; ` +
        `set it to one of ${ORTOOLS_RELEASES.join(', ')} or unset it`,
    );
    err.code = 'ORTOOLS_NODE_INVALID_PIN';
    throw err;
  }
  return value;
}

/** The directory of an installed package, or null when it is not installed. */
function resolveInstalledPackage(name, moduleRoot = MODULE_ROOT) {
  try {
    return path.dirname(require.resolve(`${name}/package.json`, { paths: [moduleRoot] }));
  } catch (err) {
    if (err.code === 'MODULE_NOT_FOUND') return null;
    throw err;
  }
}

/** A local `cmake-js` build of the addon, if one exists. */
function findSourceBuild({ moduleRoot = MODULE_ROOT, fileExists = fs.existsSync } = {}) {
  const tried = [];
  for (const dir of SOURCE_BUILD_DIRS) {
    const file = path.join(moduleRoot, dir, ADDON_FILE);
    if (fileExists(file)) return { addon: { path: file, origin: 'source build' }, tried };
    tried.push(`source build ${file}: not found`);
  }
  return { addon: null, tried };
}

/**
 * The installed prebuilt package for this machine. With several OR-Tools
 * releases installed, ORTOOLS_NODE_PIN picks one, otherwise the newest wins.
 * The chosen package must have `version` (this ortools-node's version);
 * otherwise there is no addon and no fallback to an older release.
 * `suggested` is the `name@version` to install when there is no addon (null
 * when this machine has no prebuilts). Throws when the pin is invalid or an
 * installed package has no addon.
 */
function findPrebuilt({
  platform = process.platform,
  arch = process.arch,
  libc = detectLibc(platform),
  env = process.env,
  version = PACKAGE_VERSION,
  moduleRoot = MODULE_ROOT,
  resolvePackage = (name) => resolveInstalledPackage(name, moduleRoot),
  fileExists = fs.existsSync,
} = {}) {
  const pin = parsePin(env[PIN_ENV]);
  const target = prebuiltTarget({ platform, arch, libc });
  if (!target.key) return { addon: null, tried: [target.reason], suggested: null };

  const releases = pin ? [pin] : ORTOOLS_RELEASES;
  const tried = [];
  for (const release of releases) {
    const name = prebuiltPackageName(target.key, release);
    const dir = resolvePackage(name);
    if (dir === null) {
      tried.push(`prebuilt ${name}${pin ? ` (${PIN_ENV}=${pin})` : ''}: not installed`);
      continue;
    }
    const installed = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version;
    if (installed !== version) {
      tried.push(`prebuilt ${name}: version ${installed} is installed, but ortools-node is ${version}`);
      return { addon: null, tried, suggested: `${name}@${version}` };
    }
    const file = path.join(dir, ADDON_FILE);
    if (!fileExists(file)) {
      throw new Error(`${name} is installed at ${dir} but has no ${ADDON_FILE}; reinstall it`);
    }
    return { addon: { path: file, origin: name }, tried, suggested: null };
  }
  return { addon: null, tried, suggested: `${prebuiltPackageName(target.key, releases[0])}@${version}` };
}

/** The error message for a missing addon: what was tried and how to fix it. */
function notFoundMessage(tried, suggested) {
  const fixes = suggested
    ? [`install the prebuilt package for your OR-Tools release (npm install ${suggested})`, BUILD_FROM_SOURCE_FIX]
    : [BUILD_FROM_SOURCE_FIX];
  return `Tried:\n${tried.map((line) => `  - ${line}`).join('\n')}\nTo fix it, ${fixes.join(', or ')}.`;
}

/** The addon to load. Throws an error listing every place tried when there is none. */
function resolveAddon(options = {}) {
  const source = findSourceBuild(options);
  if (source.addon) return source.addon;
  const prebuilt = findPrebuilt(options);
  if (prebuilt.addon) return prebuilt.addon;

  const err = new Error(
    `ortools-node: no compiled addon found. ${notFoundMessage([...source.tried, ...prebuilt.tried], prebuilt.suggested)}`,
  );
  err.code = 'ORTOOLS_NODE_ADDON_NOT_FOUND';
  throw err;
}

/** Resolves and loads the addon, naming where it came from when loading fails. */
function loadAddon(options = {}, requireAddon = require) {
  const addon = resolveAddon(options);
  try {
    return requireAddon(addon.path);
  } catch (err) {
    throw new Error(`ortools-node: failed to load the addon from ${addon.origin} (${addon.path}): ${err.message}`, {
      cause: err,
    });
  }
}

module.exports = {
  ADDON_FILE,
  ORTOOLS_RELEASES,
  PIN_ENV,
  PREBUILT_TARGETS,
  detectLibc,
  findPrebuilt,
  findSourceBuild,
  loadAddon,
  notFoundMessage,
  parsePin,
  prebuiltPackageName,
  prebuiltTarget,
  resolveAddon,
};
