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
  await assert.rejects(guardCppAsync('bad_alloc'), { message: /^guardCppAsync: out of memory/ });
});

test('threadpool: other std::exception rejects with its message', async () => {
  await assert.rejects(guardCppAsync('runtime'), { message: 'guardCppAsync: boom' });
});
