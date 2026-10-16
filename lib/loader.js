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
/** Where `cmake-js compile --debug` and `cmake-js compile` put the addon; Debug wins a tie. */
const SOURCE_BUILD_DIRS = Object.freeze(['build/Debug', 'build/Release']);
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

/**
 * The node_modules directories Node would search from moduleRoot, nearest
 * first, but without NODE_PATH or the global folders: a prebuilt must be
 * installed with ortools-node, not picked up from elsewhere on the machine.
 */
function nodeModulesChain(moduleRoot) {
  const dirs = [];
  for (let dir = path.resolve(moduleRoot); ; dir = path.dirname(dir)) {
    if (path.basename(dir) !== 'node_modules') dirs.push(path.join(dir, 'node_modules'));
    if (path.dirname(dir) === dir) return dirs;
  }
}

/** The real directory of an installed package, or null when no search dir has it. */
function resolveInstalledPackage(name, searchDirs) {
  for (const dir of searchDirs) {
    const candidate = path.join(dir, ...name.split('/'));
    if (fs.existsSync(candidate)) return fs.realpathSync(candidate);
  }
  return null;
}

/** The version in an installed package's package.json; names the package when it cannot be read. */
function readPackageVersion(name, dir) {
  const manifest = path.join(dir, 'package.json');
  try {
    return JSON.parse(fs.readFileSync(manifest, 'utf8')).version;
  } catch (err) {
    throw new Error(`${name} has an unreadable ${manifest}; reinstall it`, { cause: err });
  }
}

/** The modification time of a file in ms, or null when it does not exist. */
function modifiedTime(file) {
  try {
    return fs.statSync(file).mtimeMs;
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * A local `cmake-js` build of the addon, if one exists. With both a Debug and
 * a Release build, the newer one loads, so `npm run build:debug` after
 * `npm run build` (or the reverse) takes effect.
 */
function findSourceBuild({ moduleRoot = MODULE_ROOT, mtimeOf = modifiedTime } = {}) {
  const tried = [];
  let newest = null;
  for (const dir of SOURCE_BUILD_DIRS) {
    const file = path.join(moduleRoot, dir, ADDON_FILE);
    const mtime = mtimeOf(file);
    if (mtime === null) tried.push(`source build ${file}: not found`);
    else if (newest === null || mtime > newest.mtime) newest = { file, mtime };
  }
  return { addon: newest && { path: newest.file, origin: 'source build' }, tried };
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
  searchDirs = nodeModulesChain(moduleRoot),
  resolvePackage = (name) => resolveInstalledPackage(name, searchDirs),
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
    const installed = readPackageVersion(name, dir);
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

/**
 * The addon this package would load: a source build first, then a prebuilt.
 * Returns { addon, tried, suggested } with addon null when there is none.
 * The loader and the install hook both decide through this function.
 */
function findAddon(options = {}) {
  const source = findSourceBuild(options);
  if (source.addon) return { addon: source.addon, tried: source.tried, suggested: null };
  const prebuilt = findPrebuilt(options);
  return { addon: prebuilt.addon, tried: [...source.tried, ...prebuilt.tried], suggested: prebuilt.suggested };
}

/** The addon to load. Throws an error listing every place tried when there is none. */
function resolveAddon(options = {}) {
  const found = findAddon(options);
  if (found.addon) return found.addon;

  const err = new Error(`ortools-node: no compiled addon found. ${notFoundMessage(found.tried, found.suggested)}`);
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
  findAddon,
  findPrebuilt,
  findSourceBuild,
  loadAddon,
  nodeModulesChain,
  notFoundMessage,
  parsePin,
  prebuiltPackageName,
  prebuiltTarget,
  resolveAddon,
};
