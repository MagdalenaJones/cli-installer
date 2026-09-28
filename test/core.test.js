import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import {
  installGlobalErrorHandler,
  uninstallGlobalErrorHandler,
  normalizeErrorEvent,
} from '../src/index.js';

/**
 * The source uses `typeof window !== 'undefined'` to detect browsers. In Node
 * there is no global `window`, so the library attaches to `process` instead.
 * We test the Node path here, which is the environment `node --test` runs in.
 *
 * To make process-listener tests deterministic and isolated from Node's real
 * process-wide error handling, we create a fake process-like EventEmitter and
 * temporarily swap it onto globalThis. The library checks for `process.on`
 * and `process.removeListener`, both of which EventEmitter provides.
 */
function withFakeProcess(callback) {
  const fakeProcess = new EventEmitter();
  fakeProcess.removeListener = fakeProcess.off.bind(fakeProcess);
  const saved = globalThis.process;
  // We must keep the real process available so Node's test runner keeps
  // working; we only swap during the callback body.
  globalThis.process = fakeProcess;
  try {
    return callback(fakeProcess);
  } finally {
    globalThis.process = saved;
  }
}

test('normalizeErrorEvent maps an Error to message and error fields', () => {
  const err = new TypeError('boom');
  const evt = normalizeErrorEvent(err, 'test');
  assert.equal(evt.source, 'test');
  assert.equal(evt.message, 'boom');
  assert.equal(evt.error, err);
  assert.equal(evt.value, err);
  assert.equal(evt.filename, null);
  assert.equal(evt.lineno, null);
  assert.equal(evt.colno, null);
  assert.equal(typeof evt.timestamp, 'number');
});

test('normalizeErrorEvent maps a string to message with null error', () => {
  const evt = normalizeErrorEvent('something broke', 'test');
  assert.equal(evt.message, 'something broke');
  assert.equal(evt.error, null);
  assert.equal(evt.value, 'something broke');
});

test('normalizeErrorEvent maps an object with a message property', () => {
  const evt = normalizeErrorEvent({ message: 'weird', extra: 1 }, 'test');
  assert.equal(evt.message, 'weird');
  assert.equal(evt.error, null);
  assert.equal(evt.value.extra, 1);
});

test('normalizeErrorEvent stringifies other primitives', () => {
  assert.equal(normalizeErrorEvent(42, 't').message, '42');
  assert.equal(normalizeErrorEvent(true, 't').message, 'true');
});

test('normalizeErrorEvent handles null and undefined with empty message', () => {
  assert.equal(normalizeErrorEvent(null, 't').message, '');
  assert.equal(normalizeErrorEvent(undefined, 't').message, '');
});

test('installGlobalErrorHandler throws on non-function callback', () => {
  assert.throws(
    () => installGlobalErrorHandler('not a function'),
    { name: 'TypeError' }
  );
});

test('Node path: uncaughtException is routed to callback with normalized event', () => {
  withFakeProcess((proc) => {
    const received = [];
    const handle = installGlobalErrorHandler((evt) => received.push(evt));

    const err = new Error('node boom');
    proc.emit('uncaughtException', err);

    assert.equal(received.length, 1);
    assert.equal(received[0].source, 'process.uncaughtException');
    assert.equal(received[0].error, err);
    assert.equal(received[0].message, 'node boom');

    handle.uninstall();
    assert.equal(proc.listenerCount('uncaughtException'), 0);
  });
});

test('Node path: unhandledRejection is routed with correct source', () => {
  withFakeProcess((proc) => {
    const received = [];
    const handle = installGlobalErrorHandler((evt) => received.push(evt));

    proc.emit('unhandledRejection', 'rejected string');

    assert.equal(received.length, 1);
    assert.equal(received[0].source, 'process.unhandledRejection');
    assert.equal(received[0].message, 'rejected string');
    assert.equal(received[0].error, null);

    handle.uninstall();
    assert.equal(proc.listenerCount('unhandledRejection'), 0);
  });
});

test('Reinstalling replaces the previous handler (idempotent)', () => {
  withFakeProcess((proc) => {
    const first = [];
    const second = [];
    installGlobalErrorHandler((e) => first.push(e));
    installGlobalErrorHandler((e) => second.push(e));

    proc.emit('uncaughtException', new Error('once'));

    assert.equal(first.length, 0, 'first handler should have been replaced');
    assert.equal(second.length, 1);

    uninstallGlobalErrorHandler();
  });
});

test('uninstallGlobalErrorHandler is safe when nothing is installed', () => {
  assert.doesNotThrow(() => uninstallGlobalErrorHandler());
});

test('A callback that throws does not propagate or crash the emitter', () => {
  withFakeProcess((proc) => {
    const handle = installGlobalErrorHandler(() => {
      throw new Error('callback itself failed');
    });

    // If the callback's throw escaped, EventEmitter would re-throw and this
    // emit would raise. We assert it does not.
    assert.doesNotThrow(() => proc.emit('uncaughtException', new Error('orig')));

    handle.uninstall();
  });
});

test('uninstall removes both Node listeners', () => {
  withFakeProcess((proc) => {
    const handle = installGlobalErrorHandler(() => {});
    assert.equal(proc.listenerCount('uncaughtException'), 1);
    assert.equal(proc.listenerCount('unhandledRejection'), 1);

    handle.uninstall();
    assert.equal(proc.listenerCount('uncaughtException'), 0);
    assert.equal(proc.listenerCount('unhandledRejection'), 0);
  });
});

test('handle.uninstall is idempotent', () => {
  withFakeProcess((proc) => {
    const handle = installGlobalErrorHandler(() => {});
    handle.uninstall();
    assert.doesNotThrow(() => handle.uninstall());
    assert.doesNotThrow(() => handle.uninstall());
    assert.equal(proc.listenerCount('uncaughtException'), 0);
  });
});
