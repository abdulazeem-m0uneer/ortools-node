'use strict';

// Shared data for the graph tests: the OR-Tools documentation samples and a
// seeded PRNG so generated workloads are deterministic.

/** OR-Tools docs min-cost flow sample (optimal cost 150). */
const MIN_COST_FLOW_SAMPLE = {
  tails: [0, 0, 1, 1, 1, 2, 2, 3, 4],
  heads: [1, 2, 2, 3, 4, 3, 4, 4, 2],
  capacities: [15, 8, 20, 4, 10, 15, 4, 20, 5],
  unitCosts: [4, 4, 2, 2, 6, 1, 3, 2, 3],
  supplies: [20, 0, 0, -5, -15],
  optimalCost: 150,
};

/** OR-Tools docs max flow sample, source 0 to sink 4 (optimal flow 60). */
const MAX_FLOW_SAMPLE = {
  tails: [0, 0, 0, 1, 1, 2, 2, 3, 3],
  heads: [1, 2, 3, 2, 4, 3, 4, 2, 4],
  capacities: [20, 30, 10, 40, 30, 10, 20, 5, 20],
  source: 0,
  sink: 4,
  optimalFlow: 60,
};

/** OR-Tools docs linear sum assignment sample (total cost 265). */
const ASSIGNMENT_SAMPLE = {
  costs: [
    [90, 76, 75, 70],
    [35, 85, 55, 65],
    [125, 95, 90, 105],
    [45, 110, 95, 115],
  ],
  optimalCost: 265,
};

/** Arc lists of a dense cost matrix. */
function matrixArcs(costs) {
  const lefts = [];
  const rights = [];
  const values = [];
  costs.forEach((row, i) => row.forEach((cost, j) => {
    lefts.push(i);
    rights.push(j);
    values.push(cost);
  }));
  return { lefts, rights, costs: values };
}

/** Deterministic PRNG (mulberry32): returns floats in [0, 1). */
function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Integer in [min, max] from a seededRandom() source. */
function randomInt(random, min, max) {
  return min + Math.floor(random() * (max - min + 1));
}

/** Net outflow per node (outgoing - incoming flow). */
function netOutflow(numNodes, tails, heads, flows) {
  const net = new Array(numNodes).fill(0);
  flows.forEach((flow, arc) => {
    net[tails[arc]] += flow;
    net[heads[arc]] -= flow;
  });
  return net;
}

module.exports = {
  MIN_COST_FLOW_SAMPLE,
  MAX_FLOW_SAMPLE,
  ASSIGNMENT_SAMPLE,
  matrixArcs,
  seededRandom,
  randomInt,
  netOutflow,
};
