'use strict';
// Runs every ```js (or ```javascript) block of README.md and docs/*.md, so the
// documentation cannot drift from the API, and checks their relative links and
// anchors. ```ts blocks are counted but not run. A block preceded by `<!-- no-run -->` is a fragment (it
// uses names it does not define) and is skipped. Each block runs as a CommonJS
// script in its own process, inside an async function so top-level `await`
// works, with `require('ortools-node')` resolving to this checkout.
// A one-line `console.log(args); //=> text` also checks its output: the block
// fails unless util.format(args) is exactly `text`.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const NO_RUN = '<!-- no-run -->';

const RUNNABLE = new Set(['js', 'javascript']);
const TYPESCRIPT = new Set(['ts', 'typescript']);

/**
 * The code blocks of a Markdown text that matter here: { line, lang, code, run },
 * with 1-based fence lines. `run` is true for a js block not marked no-run.
 */
function jsBlocks(markdown) {
  const lines = markdown.split('\n');
  const blocks = [];
  for (let i = 0; i < lines.length; ++i) {
    const fence = /^(\s*)```(\w*)\s*$/.exec(lines[i]);
    if (!fence) continue;
    const end = lines.findIndex((l, j) => j > i && l.trim() === '```');
    if (end === -1) throw new Error(`unclosed code fence at line ${i + 1}`);
    const lang = fence[2];
    if (RUNNABLE.has(lang) || TYPESCRIPT.has(lang)) {
      let prev = i - 1;
      while (prev >= 0 && lines[prev].trim() === '') --prev;
      const run = RUNNABLE.has(lang) && (prev < 0 || lines[prev].trim() !== NO_RUN);
      blocks.push({ line: i + 1, lang, code: lines.slice(i + 1, end).join('\n'), run });
    }
    i = end;
  }
  return blocks;
}

const EXPECT = /^(\s*)console\.log\((.*)\);?\s*\/\/=> (.*)$/;
const CLOCK = /\b(Date\.now|performance\.now)\s*\(|\bnew\s+Date\b/;

/**
 * The block's code with each `console.log(...); //=> text` turned into a checked
 * log. Throws for a `//=>` it cannot check (not on a one-line console.log), and
 * for a block with checked output that reads the clock anywhere (Date.now(),
 * new Date(), performance.now()), which would make the docs test flaky.
 */
function instrument(code) {
  if (code.includes('//=>') && CLOCK.test(code)) {
    throw new Error('a block with //=> checks must not read the clock (Date.now(), new Date(), performance.now())');
  }
  const prelude = "const __format = require('node:util').format;\n"
    + 'const __expect = (line, expected, ...args) => {\n'
    + '  const actual = __format(...args);\n'
    + '  console.log(actual);\n'
    + '  if (actual !== expected) throw new Error(`line ${line}: printed ${actual}, documented ${expected}`);\n'
    + '};\n';
  return prelude + code.split('\n').map((l, i) => {
    const m = EXPECT.exec(l);
    if (!m) {
      if (l.includes('//=>')) throw new Error(`line ${i + 1}: //=> must end a one-line console.log(...): ${l.trim()}`);
      return l;
    }
    return `${m[1]}__expect(${i + 1}, ${JSON.stringify(m[3].trim())}, ${m[2]});`;
  }).join('\n');
}

function docFiles() {
  const docs = path.join(ROOT, 'docs');
  const names = fs.existsSync(docs) ? fs.readdirSync(docs).filter((f) => f.endsWith('.md')).sort() : [];
  return ['README.md', ...names.map((f) => path.join('docs', f))];
}

test('jsBlocks finds js fences, skips other languages and honours no-run', () => {
  const md = ['```bash', 'npm i', '```', '```js', 'a()', '```', NO_RUN, '', '```js', 'b()', '```',
    '```javascript', 'c()', '```', '```ts', 'let d: number;', '```'].join('\n');
  assert.deepEqual(jsBlocks(md), [
    { line: 4, lang: 'js', code: 'a()', run: true }, { line: 9, lang: 'js', code: 'b()', run: false },
    { line: 12, lang: 'javascript', code: 'c()', run: true }, { line: 15, lang: 'ts', code: 'let d: number;', run: false },
  ]);
  assert.throws(() => jsBlocks('```js\nx'), /unclosed code fence at line 1/);
});

test('instrument checks only the logs marked //=>', () => {
  const code = instrument("console.log('a', 1); //=> a 1\nconsole.log('b'); // b\n  console.log(2) //=> 3");
  assert.match(code, /__expect\(1, "a 1", 'a', 1\);/);
  assert.match(code, /console\.log\('b'\); \/\/ b/);
  assert.match(code, /\n  __expect\(3, "3", 2\);$/);
  const logs = [];
  const run = new Function('require', 'console', code);
  assert.throws(() => run(require, { log: (x) => logs.push(x) }), /line 3: printed 2, documented 3/);
  assert.deepEqual(logs, ['a 1', 'b', '2']);
  assert.throws(() => instrument('console.log(\n  1); //=> 1'), /line 2: \/\/=> must end a one-line console\.log/);
  assert.throws(() => instrument('const x = 1; //=> 1'), /line 1: \/\/=> must end/);
  assert.throws(() => instrument('console.log(Date.now() - t < 5000); //=> true'), /must not read the clock/);
  assert.throws(() => instrument('console.log(performance.now() > 0); //=> true'), /must not read the clock/);
  assert.throws(() => instrument('const t = Date.now();\nconsole.log(1); //=> 1'), /must not read the clock/);
  assert.throws(() => instrument('const d = new Date();\nconsole.log(1); //=> 1'), /must not read the clock/);
  assert.doesNotThrow(() => instrument('const t = Date.now();\nconsole.log(t > 0);'));
});

/** GitHub's heading anchor: lower case, punctuation dropped, spaces as dashes. */
function anchorOf(heading) {
  return heading.trim().toLowerCase().replace(/[^\w\- ]/g, '').replace(/ /g, '-');
}

/** The relative links of a Markdown file whose target file or heading does not exist. */
function brokenLinks(file) {
  const anchorsOf = (target) => new Set(fs.readFileSync(target, 'utf8').split('\n')
    .map((l) => /^#+ (.*)/.exec(l)).filter(Boolean).map((m) => anchorOf(m[1])));
  const broken = [];
  const source = path.join(ROOT, file);
  for (const [, target, fragment] of fs.readFileSync(source, 'utf8').matchAll(/\]\(([^)#\s]*)(?:#([^)\s]*))?\)/g)) {
    if (/^[a-z]+:/i.test(target)) continue; // https:, mailto:...
    const resolved = target ? path.resolve(path.dirname(source), target) : source;
    if (!fs.existsSync(resolved)) broken.push(target);
    else if (fragment && resolved.endsWith('.md') && !anchorsOf(resolved).has(fragment)) broken.push(`${target}#${fragment}`);
  }
  return broken;
}

test('anchorOf matches GitHub heading anchors', () => {
  assert.equal(anchorOf('Concurrency, memory and the threadpool'), 'concurrency-memory-and-the-threadpool');
  assert.equal(anchorOf('`new Solver(backend)` and `Variable`'), 'new-solverbackend-and-variable');
});

// Until the first npm release, every place that tells readers how to install
// must say so (README status and Installation, docs/install.md).
const NOT_PUBLISHED = 'Not yet published on npm; build from source until the first release';
test('every install guide says the package is not on npm yet', () => {
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8').replace(/\n> /g, ' ').replace(/\s+/g, ' ');
  const section = (text, heading) => text.split(`## ${heading} `)[1]?.split(' ## ')[0] ?? '';
  assert.ok(readme.includes('## Contents'), 'README has no ## Contents heading to end the status block');
  const status = readme.split('## Contents')[0];
  const install = fs.readFileSync(path.join(ROOT, 'docs', 'install.md'), 'utf8').replace(/\n> /g, ' ').replace(/\s+/g, ' ');
  for (const [where, text] of [['README status', status], ['README Installation', section(readme, 'Installation')],
    ['docs/install.md', install]]) {
    assert.ok(text.includes(NOT_PUBLISHED), `${where} does not say: ${NOT_PUBLISHED}`);
  }
});

for (const file of docFiles()) {
  test(`${file} has no broken relative links`, () => assert.deepEqual(brokenLinks(file), []));
}

// A scratch package whose node_modules/ortools-node is this checkout.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'ortools-docs-'));
fs.mkdirSync(path.join(sandbox, 'node_modules'));
fs.symlinkSync(ROOT, path.join(sandbox, 'node_modules', 'ortools-node'), 'dir');
process.on('exit', () => fs.rmSync(sandbox, { recursive: true, force: true }));

for (const file of docFiles()) {
  const blocks = jsBlocks(fs.readFileSync(path.join(ROOT, file), 'utf8'));
  const runnable = blocks.filter((b) => b.run);
  const typescript = blocks.filter((b) => TYPESCRIPT.has(b.lang)).length;
  test(`${file} has runnable examples (${runnable.length} run, ${typescript} ts blocks not run)`, () => {
    assert.ok(runnable.length >= 1, `${file} has no runnable js block`);
    for (const block of runnable) instrument(block.code); // every //=> is checkable
  });
  for (const block of runnable) {
    test(`${file}:${block.line} runs`, () => {
      const script = path.join(sandbox, `${path.basename(file, '.md')}-${block.line}.js`);
      fs.writeFileSync(script, `'use strict';\n(async () => {\n${instrument(block.code)}\n})().catch((e) => {\n`
        + '  console.error(e);\n  process.exitCode = 1;\n});\n');
      const run = spawnSync(process.execPath, [script], { cwd: sandbox, encoding: 'utf8', timeout: 60_000 });
      assert.equal(run.status, 0, `${file}:${block.line} exited ${run.status} (${run.signal ?? 'no signal'})\n`
        + `${run.stdout}\n${run.stderr}`);
    });
  }
}
