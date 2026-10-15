'use strict';
const { Solver, supportsBackend } = require('..');

async function lp() {
  // maximize 3x + 4y   s.t.  x + 2y <= 14,  3x - y >= 0,  x - y <= 2,  x,y >= 0
  const s = new Solver('GLOP');
  const x = s.numVar(0, Infinity, 'x');
  const y = s.numVar(0, Infinity, 'y');

  s.addLessEq([[x, 1], [y, 2]], 14, 'c1');
  s.addGreaterEq([[x, 3], [y, -1]], 0, 'c2');
  s.addLessEq([[x, 1], [y, -1]], 2, 'c3');
  s.maximize([[x, 3], [y, 4]]);

  const r = await s.solve();
  console.log('LP  status =', r.status, 'obj =', r.objectiveValue.toFixed(2),
              'x =', x.value().toFixed(2), 'y =', y.value().toFixed(2),
              `(${r.wallTimeMs} ms)`);
}

async function mip() {
  const backend = ['SCIP', 'CBC', 'HIGHS', 'CP_SAT'].find(supportsBackend);
  if (!backend) { console.log('No MIP backend in this OR-Tools build'); return; }

  // knapsack: maximize value, weight <= 15
  const items = [
    { n: 'a', w: 4, v: 10 }, { n: 'b', w: 7, v: 13 },
    { n: 'c', w: 5, v: 9 },  { n: 'd', w: 3, v: 7 }, { n: 'e', w: 6, v: 11 },
  ];
  const s = new Solver(backend);
  const take = items.map(it => s.boolVar(it.n));
  s.addLessEq(items.map((it, i) => [take[i], it.w]), 15, 'capacity');
  s.maximize(items.map((it, i) => [take[i], it.v]));
  s.setTimeLimit(5000);

  const r = await s.solve();
  const chosen = items.filter((_, i) => take[i].value() > 0.5).map(it => it.n);
  console.log(`MIP(${backend}) status =`, r.status, 'value =', r.objectiveValue, 'items =', chosen.join(','));
  console.log('\nModel as LP:\n' + s.toLp());
}

(async () => {
  await lp();
  await mip();
})().catch(err => { console.error(err); process.exit(1); });
