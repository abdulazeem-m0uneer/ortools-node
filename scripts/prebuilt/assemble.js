'use strict';

// Assembles a prebuilt platform package directory: the addon, every OR-Tools
// shared library it needs (found by following DT_NEEDED with readelf), the
// licence files shipped in the OR-Tools archive, ortools-node's own licence
// files, a third-party notice and a package.json made from
// npm/<target>/package.json.
//
// Usage: node scripts/prebuilt/assemble.js <target> <ortools-version> <addon> <ortools-root> <out-dir>
// Example: node scripts/prebuilt/assemble.js linux-x64-gnu 9.15.6755 build/Release/ortools_node.node /opt/or-tools pkg
//
// It fails when the addon needs a library that is neither in the OR-Tools
// archive nor part of the base system, or one with no known licence below.

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { ADDON_FILE, ORTOOLS_RELEASES, prebuiltPackageName } = require('../../lib/loader');

const REPO_ROOT = path.join(__dirname, '..', '..');

/** Libraries every glibc system provides; never bundled. */
const SYSTEM_LIBRARIES = new Set([
  'libc.so.6',
  'libm.so.6',
  'libdl.so.2',
  'libpthread.so.0',
  'librt.so.1',
  'libstdc++.so.6',
  'libgcc_s.so.1',
  'ld-linux-x86-64.so.2',
  'ld-linux-aarch64.so.1',
]);

/** What each bundled library is, and its licence. A library must match one entry. */
const COMPONENTS = [
  { name: 'OR-Tools', spdx: 'Apache-2.0', url: 'https://github.com/google/or-tools', match: /^libortools(?:_flatzinc)?\.so/ },
  { name: 'Abseil', spdx: 'Apache-2.0', url: 'https://github.com/abseil/abseil-cpp', match: /^libabsl_\w+\.so/ },
  { name: 'Protocol Buffers', spdx: 'BSD-3-Clause', url: 'https://github.com/protocolbuffers/protobuf', match: /^libproto(?:buf|buf-lite|c)\.so/ },
  { name: 'utf8_range (part of Protocol Buffers)', spdx: 'MIT', url: 'https://github.com/protocolbuffers/protobuf/tree/main/third_party/utf8_range', match: /^libutf8_(?:range|validity)\.so/ },
  { name: 'RE2', spdx: 'BSD-3-Clause', url: 'https://github.com/google/re2', match: /^libre2\.so/ },
  { name: 'HiGHS', spdx: 'MIT', url: 'https://github.com/ERGO-Code/HiGHS', match: /^libhighs\.so/ },
  { name: 'SCIP', spdx: 'Apache-2.0', url: 'https://github.com/scipopt/scip', match: /^libscip\.so/ },
  { name: 'SoPlex', spdx: 'Apache-2.0', url: 'https://github.com/scipopt/soplex', match: /^libsoplex\w*\.so/ },
  { name: 'COIN-OR Cbc, Cgl, Clp, CoinUtils and Osi', spdx: 'EPL-2.0', url: 'https://github.com/coin-or', match: /^lib(?:Cbc|CbcSolver|Cgl|Clp|ClpSolver|CoinUtils|Osi|OsiCbc|OsiClp)\.so/ },
  { name: 'zlib', spdx: 'Zlib', url: 'https://zlib.net', match: /^libz\.so/ },
  { name: 'bzip2', spdx: 'bzip2-1.0.6', url: 'https://sourceware.org/bzip2/', match: /^libbz2\.so/ },
];

/** DT_NEEDED entries from `readelf -d` output. */
function parseNeeded(readelfOutput) {
  return [...readelfOutput.matchAll(/\(NEEDED\)\s+Shared library: \[([^\]]+)\]/g)].map((m) => m[1]);
}

function readNeeded(file) {
  return parseNeeded(execFileSync('readelf', ['-d', file], { encoding: 'utf8' }));
}

/** The component a bundled library belongs to; throws for an unknown one. */
function componentOf(soname) {
  const component = COMPONENTS.find((c) => c.match.test(soname));
  if (!component) {
    throw new Error(`${soname} is not a known OR-Tools dependency; add it to COMPONENTS in ${__filename} with its licence`);
  }
  return component;
}

/**
 * Every library the addon needs, transitively, split into the ones to bundle
 * (found in libDir) and the system ones. Throws on anything else.
 */
function collectLibraries(addon, { libDir, needed = readNeeded, exists = fs.existsSync }) {
  const bundled = new Set();
  const system = new Set();
  const queue = [addon];
  while (queue.length > 0) {
    const file = queue.shift();
    for (const soname of needed(file)) {
      if (bundled.has(soname) || system.has(soname)) continue;
      const candidate = path.join(libDir, soname);
      if (exists(candidate)) {
        bundled.add(soname);
        queue.push(candidate);
      } else if (SYSTEM_LIBRARIES.has(soname)) {
        system.add(soname);
      } else {
        throw new Error(`${path.basename(file)} needs ${soname}, which is neither in ${libDir} nor a base system library`);
      }
    }
  }
  return { bundled: [...bundled].sort(), system: [...system].sort() };
}

/** The OR-Tools library directory: lib64/ in the AlmaLinux archives, lib/ elsewhere. */
function findLibDir(ortoolsRoot) {
  for (const dir of ['lib64', 'lib']) {
    const full = path.join(ortoolsRoot, dir);
    if (fs.existsSync(full) && fs.readdirSync(full).some((f) => f.startsWith('libortools.so'))) return full;
  }
  throw new Error(`No libortools.so under ${ortoolsRoot}/lib64 or ${ortoolsRoot}/lib`);
}

/**
 * The npm `license` expression: the addon's own (`license` of the root
 * package.json) plus each bundled component's licence.
 */
function licenseExpression(addonLicense, components) {
  const addonIds = typeof addonLicense === 'string' ? addonLicense.split(' AND ') : [];
  if (addonIds.some((id) => /^UNLICENSED$/i.test(id))) {
    throw new Error(`ortools-node must be licensed to ship prebuilts, but its package.json licence is ${JSON.stringify(addonLicense)}`);
  }
  if (addonIds.length === 0 || !addonIds.every((id) => /^[A-Za-z0-9][A-Za-z0-9.+-]*$/.test(id))) {
    throw new Error(`Cannot combine the package.json licence ${JSON.stringify(addonLicense)}: only SPDX ids joined by AND are supported`);
  }
  return [...new Set([...addonIds, ...components.map((c) => c.spdx)])].join(' AND ');
}

function noticeMarkdown({ ortoolsVersion, addonLicense, addonLicenceFiles, components, librariesByComponent, licenceFiles }) {
  const rows = components.map(
    (c) => `| [${c.name}](${c.url}) | ${c.spdx} | ${librariesByComponent.get(c).map((l) => `\`${l}\``).join(', ')} |`,
  );
  return [
    '# Third-party notices',
    '',
    `This package bundles shared libraries from the OR-Tools ${ortoolsVersion} C++ release`,
    `(https://github.com/google/or-tools/releases). The addon itself is licensed under ${addonLicense} (${addonLicenceFiles.join(', ')}).`,
    'The libraries may also contain code that their projects link statically.',
    '',
    '| Component | Licence | Libraries |',
    '| :-- | :-- | :-- |',
    ...rows,
    '',
    'Licence texts shipped in the OR-Tools archive are in LICENSES/:',
    '',
    ...licenceFiles.map((f) => `- \`${f}\``),
    '',
  ].join('\n');
}

function readmeMarkdown(name, version, ortoolsVersion) {
  return [
    `# ${name}`,
    '',
    `The [ortools-node](https://www.npmjs.com/package/ortools-node) addon prebuilt against OR-Tools ${ortoolsVersion},`,
    'with the OR-Tools shared libraries it needs. Install `ortools-node`; it loads this package when it',
    'matches your system. With packages for several OR-Tools releases installed, ortools-node loads the',
    'newest unless `ORTOOLS_NODE_PIN` names one (for example `ORTOOLS_NODE_PIN=9.14`).',
    '',
    `ortools-node loads this package only when its version is ortools-node's version, so install it as`,
    `\`npm install ${name}@<ortools-node version>\` (this is ${version}).`,
    '',
    'See THIRD_PARTY_NOTICES.md for the bundled libraries and their licences.',
    '',
  ].join('\n');
}

function ortoolsLicence(ortoolsRoot) {
  return path.join(ortoolsRoot, 'share', 'doc', 'ortools', 'LICENSE');
}

/** ortools-node's own licence files: LICENSE always, NOTICE and LICENSES/ when the repository has them. */
const ADDON_LICENCE_FILES = ['LICENSE', 'NOTICE', 'LICENSES'];

/** The files under `dir` (relative to `root`, following symlinks), as sorted paths relative to `root`. */
function filesUnder(root, dir) {
  const files = [];
  const walk = (rel) => {
    for (const name of fs.readdirSync(path.join(root, rel))) {
      const child = path.join(rel, name);
      if (fs.statSync(path.join(root, child)).isDirectory()) walk(child);
      else files.push(child);
    }
  };
  walk(dir);
  return files.sort();
}

/** fs.statSync, naming a symlink whose target is missing instead of a bare ENOENT. */
function statFollowingLink(file) {
  try {
    return fs.statSync(file);
  } catch (err) {
    if (err.code === 'ENOENT' && fs.lstatSync(file, { throwIfNoEntry: false })?.isSymbolicLink()) {
      throw new Error(`Broken symlink: ${file} -> ${fs.readlinkSync(file)}`, { cause: err });
    }
    throw err;
  }
}

/**
 * Copies the file or tree `src` to `dest` as regular files, following every
 * symlink (npm pack leaves symlinks out; fs.cpSync's `dereference` follows
 * only `src` itself) and failing with EEXIST rather than overwrite a file.
 */
function copyFollowingLinks(src, dest) {
  if (statFollowingLink(src).isDirectory()) {
    for (const name of fs.readdirSync(src)) copyFollowingLinks(path.join(src, name), path.join(dest, name));
    return;
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest, fs.constants.COPYFILE_EXCL);
}

/**
 * Copies ortools-node's licence files, failing rather than overwrite one from
 * the OR-Tools archive; returns the files copied, in ADDON_LICENCE_FILES order.
 */
function copyAddonLicences(repoRoot, outDir) {
  // lstat, not existsSync: a broken symlink must fail the copy, not drop the file.
  const entries = ADDON_LICENCE_FILES.filter((entry) => fs.lstatSync(path.join(repoRoot, entry), { throwIfNoEntry: false }));
  for (const entry of entries) copyFollowingLinks(path.join(repoRoot, entry), path.join(outDir, entry));
  return entries.flatMap((entry) => (fs.statSync(path.join(repoRoot, entry)).isDirectory() ? filesUnder(repoRoot, entry) : [entry]));
}

/** Copies the licence files of the OR-Tools archive; returns their paths in the package. */
function copyLicences(ortoolsRoot, outDir) {
  copyFollowingLinks(ortoolsLicence(ortoolsRoot), path.join(outDir, 'LICENSES', 'or-tools', 'LICENSE'));
  const thirdParty = path.join(ortoolsRoot, 'share', 'licenses');
  if (fs.existsSync(thirdParty)) copyFollowingLinks(thirdParty, path.join(outDir, 'LICENSES'));
  return filesUnder(outDir, 'LICENSES');
}

function releaseOf(ortoolsVersion) {
  const match = /^(\d+\.\d+)\.\d+$/.exec(ortoolsVersion);
  if (!match || !ORTOOLS_RELEASES.includes(match[1])) {
    throw new Error(`Unsupported OR-Tools version '${ortoolsVersion}' (releases: ${ORTOOLS_RELEASES.join(', ')})`);
  }
  return match[1];
}

/**
 * Writes the package directory. `templateDir`, `collect` (collectLibraries)
 * and `repoRoot` (version, licence and licence files) are injectable for tests.
 */
function assemble({
  target,
  ortoolsVersion,
  addon,
  ortoolsRoot,
  outDir,
  templateDir = path.join(REPO_ROOT, 'npm'),
  collect = collectLibraries,
  repoRoot = REPO_ROOT,
}) {
  const { version, license: addonLicense } = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  const templateFile = path.join(templateDir, target, 'package.json');
  if (!fs.existsSync(templateFile)) throw new Error(`No package template for target '${target}' (${templateFile})`);
  const name = prebuiltPackageName(target, releaseOf(ortoolsVersion));
  const libDir = findLibDir(ortoolsRoot);
  const { bundled, system } = collect(addon, { libDir });
  const librariesByComponent = new Map();
  for (const soname of bundled) {
    const component = componentOf(soname);
    librariesByComponent.set(component, [...(librariesByComponent.get(component) ?? []), soname]);
  }
  const components = COMPONENTS.filter((c) => librariesByComponent.has(c));
  const license = licenseExpression(addonLicense, components);

  if (!fs.existsSync(ortoolsLicence(ortoolsRoot))) {
    throw new Error(`The OR-Tools archive has no licence at ${ortoolsLicence(ortoolsRoot)}`);
  }
  if (!fs.existsSync(path.join(repoRoot, 'LICENSE'))) throw new Error(`ortools-node has no licence at ${path.join(repoRoot, 'LICENSE')}`);
  fs.mkdirSync(path.dirname(outDir), { recursive: true });
  try {
    // Not recursive: only a directory this call created is removed on failure below.
    fs.mkdirSync(outDir);
  } catch (err) {
    if (err.code === 'EEXIST') throw new Error(`${outDir} already exists`, { cause: err });
    throw err;
  }
  try {
    fs.copyFileSync(addon, path.join(outDir, ADDON_FILE));
    // Copy each library's real file under its SONAME: npm pack does not keep symlinks.
    for (const soname of bundled) fs.copyFileSync(path.join(libDir, soname), path.join(outDir, soname));

    const licenceFiles = copyLicences(ortoolsRoot, outDir);
    const addonLicenceFiles = copyAddonLicences(repoRoot, outDir);
    fs.writeFileSync(
      path.join(outDir, 'THIRD_PARTY_NOTICES.md'),
      noticeMarkdown({ ortoolsVersion, addonLicense, addonLicenceFiles, components, librariesByComponent, licenceFiles }),
    );
    fs.writeFileSync(path.join(outDir, 'README.md'), readmeMarkdown(name, version, ortoolsVersion));

    const template = JSON.parse(fs.readFileSync(templateFile, 'utf8'));
    // A template cannot set the identity or licence: those are computed here.
    const { name: _name, version: _version, license: _license, ...templateFields } = template;
    const manifest = {
      name,
      version,
      ...templateFields,
      description: `${template.description}, built against OR-Tools ${ortoolsVersion}`,
      license,
    };
    fs.writeFileSync(path.join(outDir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  } catch (err) {
    // This run created outDir: remove the partial package so a rerun is not blocked.
    fs.rmSync(outDir, { recursive: true, force: true });
    throw err;
  }
  return { name, bundled, system };
}

if (require.main === module) {
  const [target, ortoolsVersion, addon, ortoolsRoot, outDir] = process.argv.slice(2);
  if (!outDir) {
    console.error('usage: node scripts/prebuilt/assemble.js <target> <ortools-version> <addon> <ortools-root> <out-dir>');
    process.exit(2);
  }
  const result = assemble({ target, ortoolsVersion, addon, ortoolsRoot, outDir });
  console.log(`${result.name}: bundled ${result.bundled.length} libraries; needs from the system: ${result.system.join(' ')}`);
}

module.exports = {
  assemble,
  collectLibraries,
  componentOf,
  copyAddonLicences,
  copyLicences,
  findLibDir,
  licenseExpression,
  noticeMarkdown,
  ortoolsLicence,
  parseNeeded,
  releaseOf,
};
