'use strict';
// CPU pinning shared by the benchmarks: both runtimes run on the same core so neither lands on a
// slower one. Needs Linux `taskset`.

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');

/**
 * The CPU to pin to: BENCH_CPU, else the first performance core on hybrid Intel CPUs (a solve runs
 * ~1.7x slower on an efficiency core), else CPU 0; null off Linux.
 */
function pinnedCpu({ env = process.env, platform = process.platform, readFile = fs.readFileSync } = {}) {
  if (env.BENCH_CPU) return env.BENCH_CPU;
  if (platform !== 'linux') return null;
  try {
    return readFile('/sys/devices/cpu_core/cpus', 'utf8').trim().split(/[-,]/)[0];
  } catch {
    return '0';
  }
}

function hasTaskset() {
  try {
    execFileSync('taskset', ['-V'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** [cmd, args] prefixed with `taskset -c cpu` when cpu is set. */
function pinned(cpu, cmd, args) {
  return cpu === null ? [cmd, args] : ['taskset', ['-c', cpu, cmd, ...args]];
}

module.exports = { pinnedCpu, hasTaskset, pinned };
