'use strict';
// The TypeScript declarations must describe what the addon really exports: every
// declared export, class member and enum key exists at runtime with a matching
// type, and every public runtime member is declared. Classes are checked on real
// instances, so instance fields and getters count.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const ts = require('typescript');
const ortools = require('..');

const INDEX = path.join(__dirname, '..', 'lib', 'index.d.ts');
const program = ts.createProgram([INDEX], {
  strict: true, noEmit: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
  lib: ['lib.es2022.d.ts', 'lib.esnext.disposable.d.ts'],
});
const checker = program.getTypeChecker();
const indexFile = program.getSourceFile(INDEX);

test('the declarations compile without diagnostics', () => {
  const diagnostics = ts.getPreEmitDiagnostics(program)
    .map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'));
  assert.deepEqual(diagnostics, []);
});

const resolve = (s) => (s.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(s) : s);
const isPrivate = (s) => (s.declarations ?? []).some(
  (d) => ts.getCombinedModifierFlags(d) & (ts.ModifierFlags.Private | ts.ModifierFlags.Protected));
// Members every object or function has; declaring them adds nothing.
const OBJECT_MEMBERS = new Set(Object.getOwnPropertyNames(Object.prototype));
const FUNCTION_MEMBERS = new Set(['length', 'name', 'prototype', 'arguments', 'caller']);

/** The typeof results a declared type allows, or null when it allows anything. */
function allowedTypeofs(type) {
  const out = new Set();
  for (const t of type.isUnion() ? type.types : [type]) {
    const f = t.flags;
    if (f & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return null;
    if (f & ts.TypeFlags.NumberLike) out.add('number');
    else if (f & ts.TypeFlags.StringLike) out.add('string');
    else if (f & ts.TypeFlags.BooleanLike) out.add('boolean');
    else if (f & ts.TypeFlags.BigIntLike) out.add('bigint');
    else if (f & (ts.TypeFlags.Undefined | ts.TypeFlags.Void)) out.add('undefined');
    else if (f & ts.TypeFlags.Null) out.add('null');
    else if (t.getCallSignatures().length > 0) out.add('function');
    else out.add('object');
  }
  return out;
}
const typeofValue = (v) => (v === null ? 'null' : typeof v);

/** The values of a union of string literals (an enum key or status name), else null. */
function stringLiterals(type) {
  const parts = type.isUnion() ? type.types : [type];
  return parts.every((t) => t.isStringLiteral()) ? new Set(parts.map((t) => t.value)) : null;
}

/** Why `actual` does not fit the declared `type`, or null when it does. */
function mismatch(type, actual) {
  const allowed = allowedTypeofs(type);
  if (allowed && !allowed.has(typeofValue(actual))) {
    return `is ${typeofValue(actual)} at runtime, declared ${[...allowed].join(' | ')}`;
  }
  const literals = stringLiterals(type);
  if (literals && !literals.has(actual)) return `is '${actual}' at runtime, declared ${[...literals].join(' | ')}`;
  return null;
}

/** Public member names of a runtime object: its own, or also those of its prototype chain. */
function runtimeMembers(obj, ownOnly) {
  const names = new Set();
  for (let p = obj; p && p !== Object.prototype && p !== Function.prototype; p = Object.getPrototypeOf(p)) {
    if (ownOnly && p !== obj) break;
    for (const k of Object.getOwnPropertyNames(p)) {
      if (!k.startsWith('_') && k !== 'constructor' && !OBJECT_MEMBERS.has(k)) names.add(k);
    }
  }
  return names;
}

// Zero-argument methods that change state or start work; every other one is
// called on the samples to compare its result with the declared return type.
const MUTATING = new Set([
  'dispose', 'clear', 'clearHints', 'clearObjective', 'clearAssumptions', 'clearTerms', 'closeModel',
  'closeModelWithParameters', 'solve', 'solveSync', 'solveAsync', 'solveMaxFlowWithMinCost',
  'solveMaxFlowWithMinCostSync', 'solveWithParameters', 'solveWithParametersSync', 'nextSolution',
  'nextSolutionSync', 'endSearch', 'interrupt', 'stopSearch', 'enableOutput', 'not', 'neg', 'opposite',
  'abs', 'square', 'var', 'complement',
]);

// Members that throw on the samples by design (no solve result yet, a variable
// read outside a search...), with the message expected. Any other throw fails
// the test, and so does an entry that no longer throws.
const RESULT_REQUIRED = /^No (solve result|Simple\w+ result)/;
const EXPECTED_THROWS = new Map([
  ['new cp.CpSolver().compose()', /at least one decision builder is required/],
  ['new cp.IntVar().value()', /is not bound: values are only available at a solution/],
  ['new KnapsackSolver().isSolutionOptimal()', RESULT_REQUIRED],
  ['new modelBuilder.Model().exportToMpsString()', /General constraints are not supported/], // the sample has an enforced constraint
  ...['bestObjectiveBound', 'objectiveValue', 'status', 'statusString', 'userTime', 'wallTime']
    .map((m) => [`new modelBuilder.Solver().${m}`, RESULT_REQUIRED]),
  ['new SimpleLinearSumAssignment().optimalCost()', RESULT_REQUIRED],
  ...['flows()', 'getSinkSideMinCut()', 'getSourceSideMinCut()', 'optimalFlow()']
    .map((m) => [`new SimpleMaxFlow().${m}`, RESULT_REQUIRED]),
  ...['flows()', 'maximumFlow()', 'optimalCost()'].map((m) => [`new SimpleMinCostFlow().${m}`, RESULT_REQUIRED]),
]);
const thrown = new Set();

/** Reads a member (a getter, or a zero-argument call); records an expected throw, rethrows any other. */
function readMember(label, read, problems) {
  try {
    return { value: read() };
  } catch (e) {
    const expected = EXPECTED_THROWS.get(label);
    if (expected === undefined) problems.push(`${label} throws unexpectedly: ${e.message}`);
    else if (!expected.test(e.message)) problems.push(`${label} throws '${e.message}', expected ${expected}`);
    thrown.add(label);
    return null;
  }
}

/** Calls the safe zero-argument methods of `value` and checks what they return. */
function compareReturns(where, type, value) {
  const problems = [];
  for (const m of checker.getPropertiesOfType(type)) {
    if (!(m.flags & ts.SymbolFlags.Method) || isPrivate(m) || MUTATING.has(m.name)) continue;
    const signatures = checker.getTypeOfSymbol(m).getCallSignatures();
    const callable = signatures.find((sig) => sig.parameters.every((p) => {
      const decl = p.valueDeclaration;
      return decl && ts.isParameter(decl) && (decl.questionToken || decl.initializer || decl.dotDotDotToken);
    }));
    if (!callable || typeof value[m.name] !== 'function') continue;
    const read = readMember(`${where}.${m.name}()`, () => value[m.name](), problems);
    if (read === null) continue;
    const actual = read.value;
    const why = mismatch(checker.getReturnTypeOfSignature(callable), actual);
    if (why) problems.push(`${where}.${m.name}() ${why}`);
  }
  return problems;
}

/** Compares the declared members of `type` with `value`; returns the problems. */
function compareMembers(where, type, value, skipNames, ownOnly = false) {
  const problems = [];
  const declared = new Set();
  for (const m of checker.getPropertiesOfType(type)) {
    if (isPrivate(m) || m.name.startsWith('__@')) continue;
    declared.add(m.name);
    if (!(m.name in value)) {
      // Optional members (Partial<> enums of build-dependent backends) may be absent.
      if (m.flags & ts.SymbolFlags.Optional) continue;
      problems.push(`${where}.${m.name} is declared but missing at runtime`);
      continue;
    }
    const read = readMember(`${where}.${m.name}`, () => value[m.name], problems);
    if (read === null) continue;
    const actual = read.value;
    const why = mismatch(checker.getTypeOfSymbol(m), actual);
    if (why && !(actual === undefined && m.flags & ts.SymbolFlags.Optional)) problems.push(`${where}.${m.name} ${why}`);
  }
  for (const k of runtimeMembers(value, ownOnly)) {
    if (!declared.has(k) && !skipNames.has(k)) problems.push(`${where}.${k} exists at runtime but is not declared`);
  }
  return problems;
}

// One instance of every exported class, keyed by its qualified export name.
// Built lazily, inside the test, and released after it.
const toDispose = [];
const keep = (x) => { toDispose.push(x); return x; };

async function buildSamples() {
  const { cp, modelBuilder: mb, mathOpt: mo, setCover: sc } = ortools;
  const s = {};

  const lp = keep(new ortools.Solver('GLOP'));
  const x = lp.numVar(0, 10, 'x');
  const row = lp.addLessEq([[x, 1]], 4, 'row');
  lp.maximize([[x, 1]]);
  Object.assign(s, { Solver: lp, Variable: x, Constraint: row, SolveResult: lp.solveSync() });

  s.SimpleMinCostFlow = keep(new ortools.SimpleMinCostFlow());
  s.SimpleMaxFlow = keep(new ortools.SimpleMaxFlow());
  s.SimpleLinearSumAssignment = keep(new ortools.SimpleLinearSumAssignment());
  s.KnapsackSolver = keep(new ortools.KnapsackSolver('KNAPSACK_DYNAMIC_PROGRAMMING_SOLVER', 'k'));

  const model = new ortools.CpModel();
  const b = model.newBoolVar('b');
  const v = model.newIntVar(0, 5, 'v');
  const interval = model.newFixedSizeIntervalVar(v, 2, 'i');
  model.maximize(v);
  const satSolver = keep(new ortools.CpSolver());
  let snapshot;
  await satSolver.solve(model, { onSolution: (sol) => { snapshot ??= sol; } });
  Object.assign(s, {
    Domain: new ortools.Domain(0, 3), CpLinearExpr: v.plus(1), IntVar: v, NotBooleanVariable: b.not(),
    BoundedLinearExpr: v.le(3), CpConstraint: model.add(v.le(4)), IntervalVar: interval, CpModel: model,
    CpSolver: satSolver, SolutionSnapshot: snapshot,
  });

  const cs = keep(new cp.CpSolver('c'));
  const cx = cs.intVar(0, 3, 'cx');
  Object.assign(s, {
    'cp.CpSolver': cs, 'cp.IntVar': cx, 'cp.IntExpr': cx.plus(1), 'cp.CpConstraint': cx.le(2),
    'cp.DecisionBuilder': cs.phase([cx], 'CHOOSE_FIRST_UNBOUND', 'ASSIGN_MIN_VALUE'),
    'cp.SearchMonitor': cs.timeLimit(1000), 'cp.SolutionCollector': cs.lastSolutionCollector(),
  });

  const manager = new ortools.RoutingIndexManager(3, 1, 0);
  const routing = keep(new ortools.RoutingModel(manager));
  const transit = routing.registerTransitMatrix([[0, 1, 1], [1, 0, 1], [1, 1, 0]]);
  routing.setArcCostEvaluatorOfAllVehicles(transit);
  routing.addDimension(transit, 0, 10, true, 'd');
  const dimension = routing.getDimensionOrDie('d');
  Object.assign(s, {
    RoutingIndexManager: manager, RoutingModel: routing, RoutingDimension: dimension,
    RoutingSolution: routing.solveWithParametersSync(),
  });

  const m = new mb.Model('m');
  const mx = m.newIntVar(0, 3, 'mx');
  const mbSolver = keep(new mb.Solver('GLOP'));
  Object.assign(s, {
    'modelBuilder.Model': m, 'modelBuilder.Variable': mx, 'modelBuilder.LinearConstraint': m.add(mx.le(2)),
    'modelBuilder.EnforcedLinearConstraint': m.addEnforced(mx.ge(1), m.newBoolVar('e'), true),
    'modelBuilder.LinearExpr': mx.plus(1), 'modelBuilder.BoundedLinearExpression': mx.le(1),
    'modelBuilder.Solver': mbSolver,
  });

  const om = new mo.Model('o');
  const ox = om.addVariable({ lb: 0, ub: 2, name: 'ox' });
  const oc = om.addLinearConstraint(ox.le(1), 'oc');
  om.maximize(ox);
  Object.assign(s, {
    'mathOpt.Model': om, 'mathOpt.Variable': ox, 'mathOpt.LinearConstraint': oc,
    'mathOpt.LinearExpr': ox.plus(1), 'mathOpt.BoundedLinearExpression': ox.le(1),
    'mathOpt.SolveInterrupter': new mo.SolveInterrupter(), 'mathOpt.SolveResult': mo.solveSync(om, 'GLOP'),
  });

  const scm = new sc.SetCoverModel('sc');
  scm.addEmptySubset(1);
  scm.addElementToLastSubset(0);
  const inv = keep(new sc.SetCoverInvariant(scm));
  s['setCover.SetCoverModel'] = scm;
  s['setCover.SetCoverInvariant'] = inv;
  for (const name of ['TrivialSolutionGenerator', 'RandomSolutionGenerator', 'GreedySolutionGenerator',
    'ElementDegreeSolutionGenerator', 'LazyElementDegreeSolutionGenerator', 'SteepestSearch',
    'GuidedLocalSearch', 'GuidedTabuSearch', 'SetCoverMip']) {
    s[`setCover.${name}`] = new sc[name](inv);
  }
  s['setCover.SetCoverSolutionGenerator'] = s['setCover.TrivialSolutionGenerator'];
  return s;
}

// Classes declared with a protected constructor and only met through a subclass.
const VIA_SUBCLASS = {
  VariableBase: 'Variable',
};

/** Walks the declared exports of a module symbol next to its runtime object. */
function checkModule(moduleSymbol, runtime, prefix, samples, problems, seenClasses) {
  const declared = new Set();
  for (const exported of checker.getExportsOfModule(moduleSymbol)) {
    const s = resolve(exported);
    if (!(s.flags & ts.SymbolFlags.Value)) continue;
    const name = exported.name;
    const where = prefix + name;
    declared.add(name);
    const value = runtime[name];
    if (value === undefined) { problems.push(`${where} is declared but not exported`); continue; }
    if (s.flags & ts.SymbolFlags.Class) {
      if (typeof value !== 'function') { problems.push(`${where} is declared a class but is ${typeof value}`); continue; }
      seenClasses.add(where);
      const staticType = checker.getTypeOfSymbolAtLocation(s, indexFile);
      // Statics a class inherits at runtime belong to (and are checked on) its parent.
      problems.push(...compareMembers(where, staticType, value, FUNCTION_MEMBERS, true));
      const sampleKey = VIA_SUBCLASS[name] ? prefix + VIA_SUBCLASS[name] : where;
      const sample = samples[sampleKey];
      if (sample === undefined) { problems.push(`${where} has no runtime sample in this test`); continue; }
      if (!(sample instanceof value)) problems.push(`${where}: the sample is not an instance of it`);
      if (VIA_SUBCLASS[name]) continue; // the subclass check covers the members
      const instanceType = checker.getDeclaredTypeOfSymbol(s);
      problems.push(...compareMembers(`new ${where}()`, instanceType, sample, new Set()));
      problems.push(...compareReturns(`new ${where}()`, instanceType, sample));
    } else if (s.flags & ts.SymbolFlags.ValueModule) {
      checkModule(s, value, `${where}.`, samples, problems, seenClasses);
    } else if (s.flags & ts.SymbolFlags.Function) {
      if (typeof value !== 'function') problems.push(`${where} is declared a function but is ${typeof value}`);
    } else {
      const type = checker.getTypeOfSymbolAtLocation(s, indexFile);
      const why = mismatch(type, value);
      if (why) {
        problems.push(`${where} ${why}`);
      } else if (typeofValue(value) === 'object' && checker.getIndexInfosOfType(type).length === 0
        && checker.getPropertiesOfType(type).length > 0) {
        problems.push(...compareMembers(where, type, value, new Set()));
      }
    }
  }
  for (const k of Object.keys(runtime)) {
    if (!declared.has(k)) problems.push(`${prefix}${k} is exported but not declared`);
  }
}

test('the type declarations match the runtime exports, members and enum keys', async () => {
  const samples = await buildSamples();
  try {
    const problems = [];
    const seenClasses = new Set();
    checkModule(checker.getSymbolAtLocation(indexFile), ortools, '', samples, problems, seenClasses);
    for (const key of Object.keys(samples)) {
      if (!seenClasses.has(key)) problems.push(`sample ${key} matches no declared class`);
    }
    for (const label of EXPECTED_THROWS.keys()) {
      if (!thrown.has(label)) problems.push(`${label} is listed as throwing but did not throw`);
    }
    assert.deepEqual(problems, []);
  } finally {
    for (const x of toDispose.reverse()) x.dispose();
  }
});
