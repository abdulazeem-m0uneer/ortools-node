'use strict';
// C++ exceptions from OR-Tools must become JS errors, never abort the process
// (src/common/cpp_guard.h), on the main thread and on the threadpool.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { native } = require('..');

const { guardCpp, guardCppAsync } = native._testing;

test('main thread: no exception passes through', () => {
  assert.equal(guardCpp('ok'), 'ok');
});

test('main thread: std::bad_alloc becomes a RangeError naming the call', () => {
  assert.throws(() => guardCpp('bad_alloc'), { name: 'RangeError', message: /^guardCpp: out of memory/ });
});

test('main thread: other std::exception becomes an Error with its message', () => {
  assert.throws(() => guardCpp('runtime'), (e) => e.constructor === Error && e.message === 'guardCpp: boom');
});

test('threadpool: no exception resolves', async () => {
  assert.equal(await guardCppAsync('ok'), 'ok');
});

test('threadpool: std::bad_alloc rejects the Promise with the out-of-memory message', async () => {
  await assert.rejects(guardCppAsync('bad_alloc'), { name: 'RangeError', message: /^guardCppAsync: out of memory/ });
});

test('threadpool: other std::exception rejects with its message', async () => {
  await assert.rejects(guardCppAsync('runtime'), (e) => e.constructor === Error && e.message === 'guardCppAsync: boom');
});

test('threadpool: Fail() rejects with exactly its message', async () => {
  await assert.rejects(guardCppAsync('fail'), (e) => e.constructor === Error && e.message === 'custom message');
});

test('threadpool: Fail(message, true) rejects with a RangeError', async () => {
  await assert.rejects(guardCppAsync('fail_oom'), (e) => e.constructor === RangeError && e.message === 'custom out of memory');
});

test('threadpool: Fail("") still rejects, with a non-empty message', async () => {
  await assert.rejects(guardCppAsync('fail_empty'), (e) => e.constructor === Error && e.message === 'native operation failed');
});

test('the test hooks throw a TypeError for a kind that is not a string instead of aborting', () => {
  const { spawnSync } = require('node:child_process');
  const script = `const { native } = require(${JSON.stringify(require('node:path').join(__dirname, '..'))});
    for (const hook of ['guardCpp', 'guardCppAsync', 'publishSolutionFailure']) {
      for (const kind of [Symbol('s'), 1, undefined]) {
        try { native._testing[hook](kind); console.log(hook + ': no error'); }
        catch (e) { console.log(hook + ': ' + e.constructor.name + ': ' + e.message); }
      }
    }`;
  const r = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const expected = ['guardCpp', 'guardCppAsync', 'publishSolutionFailure']
    .flatMap((hook) => Array(3).fill(`${hook}: TypeError: kind must be a string`));
  assert.deepEqual(r.stdout.trim().split('\n'), expected);
});
