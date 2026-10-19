'use strict';
// Comparison of the per-case solution signatures that run_py.py and run_node.js record.

/** JSON with object keys sorted, so equal signatures compare equal whatever their key order. */
function canonical(value) {
  return JSON.stringify(value, (_, v) => (v && typeof v === 'object' && !Array.isArray(v)
    ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
    : v));
}

/** Exact-flavour cases carry a workload; spike-flavour ids are "<group>/<n>". */
const groupOf = (c) => c.workload ?? c.id.replace(/\/[^/]*$/, '');
const caseKey = (c) => `${c.workload ?? ''}/${c.id}`;

/**
 * Per workload: {cases, match, mismatches: [{id, a, b}], missing: [id], guardHits} for two runs'
 * cases. A case is missing when only one side has it; guard hits (time-limited solves) still compare.
 */
function compareCases(aCases, bCases) {
  const bByKey = new Map(bCases.map((c) => [caseKey(c), c]));
  const seen = new Set();
  const out = {};
  for (const a of aCases) {
    const w = (out[groupOf(a)] ||= { cases: 0, match: 0, mismatches: [], missing: [], guardHits: 0 });
    const key = caseKey(a);
    seen.add(key);
    const b = bByKey.get(key);
    w.cases += 1;
    if (a.guard_hit || (b && b.guard_hit)) w.guardHits += 1;
    if (!b) w.missing.push(a.id);
    else if (canonical(a.sig) === canonical(b.sig)) w.match += 1;
    else w.mismatches.push({ id: a.id, a: a.sig, b: b.sig });
  }
  for (const b of bCases) {
    if (seen.has(caseKey(b))) continue;
    const w = (out[groupOf(b)] ||= { cases: 0, match: 0, mismatches: [], missing: [], guardHits: 0 });
    w.cases += 1;
    w.missing.push(b.id);
  }
  return out;
}

module.exports = { canonical, groupOf, compareCases };
