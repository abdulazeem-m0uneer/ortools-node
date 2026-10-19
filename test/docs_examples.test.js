'use strict';
// Runs every ```js block of README.md and docs/*.md, so the documentation cannot
// drift from the API. A block preceded by `<!-- no-run -->` is a fragment (it
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

/** The ```js blocks of a Markdown text: { line, code, run } with 1-based fence lines. */
function jsBlocks(markdown) {
  const lines = markdown.split('\n');
  const blocks = [];
  for (let i = 0; i < lines.length; ++i) {
    const fence = /^(\s*)```(\w*)\s*$/.exec(lines[i]);
    if (!fence) continue;
    const end = lines.findIndex((l, j) => j > i && l.trim() === '```');
    if (end === -1) throw new Error(`unclosed code fence at line ${i + 1}`);
    if (fence[2] === 'js') {
      let prev = i - 1;
      while (prev >= 0 && lines[prev].trim() === '') --prev;
      const run = prev < 0 || lines[prev].trim() !== NO_RUN;
      blocks.push({ line: i + 1, code: lines.slice(i + 1, end).join('\n'), run });
    }
    i = end;
  }
  return blocks;
}

const EXPECT = /^(\s*)console\.log\((.*)\);?\s*\/\/=> (.*)$/;

/** The block's code with each `console.log(...); //=> text` turned into a checked log. */
function instrument(code) {
  const prelude = "const __format = require('node:util').format;\n"
    + 'const __expect = (line, expected, ...args) => {\n'
    + '  const actual = __format(...args);\n'
    + '  console.log(actual);\n'
    + '  if (actual !== expected) throw new Error(`line ${line}: printed ${actual}, documented ${expected}`);\n'
    + '};\n';
  return prelude + code.split('\n').map((l, i) => {
    const m = EXPECT.exec(l);
    return m ? `${m[1]}__expect(${i + 1}, ${JSON.stringify(m[3].trim())}, ${m[2]});` : l;
  }).join('\n');
}

function docFiles() {
  const docs = path.join(ROOT, 'docs');
  const names = fs.existsSync(docs) ? fs.readdirSync(docs).filter((f) => f.endsWith('.md')).sort() : [];
  return ['README.md', ...names.map((f) => path.join('docs', f))];
}

test('jsBlocks finds js fences, skips other languages and honours no-run', () => {
  const md = ['```bash', 'npm i', '```', '```js', 'a()', '```', NO_RUN, '', '```js', 'b()', '```'].join('\n');
  assert.deepEqual(jsBlocks(md), [{ line: 4, code: 'a()', run: true }, { line: 9, code: 'b()', run: false }]);
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
});

// A scratch package whose node_modules/ortools-node is this checkout.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'ortools-docs-'));
fs.mkdirSync(path.join(sandbox, 'node_modules'));
fs.symlinkSync(ROOT, path.join(sandbox, 'node_modules', 'ortools-node'), 'dir');
process.on('exit', () => fs.rmSync(sandbox, { recursive: true, force: true }));

for (const file of docFiles()) {
  const blocks = jsBlocks(fs.readFileSync(path.join(ROOT, file), 'utf8'));
  for (const block of blocks.filter((b) => b.run)) {
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
