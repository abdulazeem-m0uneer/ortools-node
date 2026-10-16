'use strict';

// Lists the prebuilt packages for the newest OR-Tools release in package.json's
// optionalDependencies, at this package's version, so npm installs the one that
// matches the user's system. Run it on a release checkout right before packing
// or publishing ortools-node, after the platform packages are published. They
// are not in the committed package.json because `npm ci` fails while the
// registry does not have them.
//
// Usage: node scripts/prebuilt/set-optional-deps.js [package.json]

const fs = require('node:fs');
const path = require('node:path');
const { ORTOOLS_RELEASES, PREBUILT_TARGETS, prebuiltPackageName } = require('../../lib/loader');

/** A copy of the manifest with the newest release's prebuilts as optional dependencies. */
function withPrebuiltOptionalDependencies(manifest) {
  const prebuilts = Object.fromEntries(
    PREBUILT_TARGETS.map((target) => [prebuiltPackageName(target, ORTOOLS_RELEASES[0]), manifest.version]),
  );
  return { ...manifest, optionalDependencies: { ...manifest.optionalDependencies, ...prebuilts } };
}

if (require.main === module) {
  const file = path.resolve(process.argv[2] ?? path.join(__dirname, '..', '..', 'package.json'));
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  const updated = withPrebuiltOptionalDependencies(manifest);
  fs.writeFileSync(file, `${JSON.stringify(updated, null, 2)}\n`);
  console.log(`${file}: optionalDependencies ${JSON.stringify(updated.optionalDependencies)}`);
}

module.exports = { withPrebuiltOptionalDependencies };
