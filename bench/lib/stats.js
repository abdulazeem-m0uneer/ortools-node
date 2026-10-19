'use strict';
// Summary statistics for benchmark samples.

/** Nearest-rank percentile, p in [0, 100]: the sorted sample at index round(p/100 * (n-1)), like the spikes' pct(). */
function percentile(xs, p) {
  if (!xs.length) throw new RangeError('percentile of an empty sample');
  if (!(p >= 0 && p <= 100)) throw new RangeError(`percentile ${p} outside [0, 100]`);
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.round((p / 100) * (s.length - 1)))];
}

function median(xs) {
  if (!xs.length) throw new RangeError('median of an empty sample');
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[s.length >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
}

/** {n, p50, p95, p99, max} of a sample. */
function summary(xs) {
  return { n: xs.length, p50: percentile(xs, 50), p95: percentile(xs, 95), p99: percentile(xs, 99), max: Math.max(...xs) };
}

module.exports = { percentile, median, summary };
