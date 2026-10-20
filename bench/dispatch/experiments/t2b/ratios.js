'use strict';
// node ratios.js [results.json]: per-case solve ratios between the configurations the t2b finding cites.
const fs = require('node:fs');
const path = require('node:path');
const { median, percentile } = require('../../../lib/stats');

const COMPARISONS = [
  ['node-async', 'py', 'Node async / Python (baseline)'],
  ['node-sync', 'py', 'Node sync / Python'],
  ['node-wheellib', 'py', "Node with the wheel's libortools / Python"],
  ['py-thread', 'py', 'Python with one idle thread / Python'],
  ['node-async', 'py-thread', 'Node async / Python with one idle thread'],
  ['node-tcache', 'py-tcache', 'Node / Python, both with tcache_count=1000'],
  ['node-tcache', 'node-async', 'Node with tcache_count=1000 / Node'],
  ['hook-both', 'hook-none', 'Python with the binding\'s two hooks / Python'],
];

/** Median, p10 and p90 of the per-case ratios a/b. */
function caseRatios(a, b) {
  if (a.solve_case_median_ms.length !== b.solve_case_median_ms.length) throw new Error('different case counts');
  const r = a.solve_case_median_ms.map((x, i) => x / b.solve_case_median_ms[i]);
  return { median: median(r), p10: percentile(r, 10), p90: percentile(r, 90) };
}

function main(file = path.join(__dirname, 'results.json')) {
  const res = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const [a, b, label] of COMPARISONS) {
    if (!res[a] || !res[b]) throw new Error(`${file} has no ${res[a] ? b : a}`);
    const r = caseRatios(res[a], res[b]);
    console.log(`${label.padEnd(46)} ${r.median.toFixed(3)} (p10 ${r.p10.toFixed(2)}, p90 ${r.p90.toFixed(2)})`);
  }
}

if (require.main === module) main(process.argv[2]);

module.exports = { caseRatios };
