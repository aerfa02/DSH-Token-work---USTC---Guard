import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { mountSnapshotRemote } from '../lib/remote.js';

test('snapshot Remote waits for restored state and registers its method', async () => {
  let release;
  let restored = false;
  const ready = new Promise(resolve => { release = resolve; });
  let service;
  let contribution;
  const ctx = {
    provide(name, value) { assert.equal(name, 'ustcGuard'); service = value; },
    typert: { register(value) { contribution = value; } },
  };
  mountSnapshotRemote(ctx, { snapshot() { assert.ok(restored); return { rpm: { used: 7 } }; } }, ready);
  assert.equal(contribution.face, 'host');
  assert.equal(contribution.invocations[0].method, 'snapshot');
  assert.equal(service.typertRemote.service, service);
  let finished = false;
  const pending = service.snapshot().then(value => { finished = true; return value; });
  await Promise.resolve();
  assert.equal(finished, false);
  restored = true;
  release();
  assert.deepEqual(await pending, { rpm: { used: 7 } });
});

test('Client mounts the matching Remote and reads its result without host.call', async () => {
  let plugin;
  let component;
  let props;
  let refresh;
  let snapshot;
  let calls = 0;
  const React = {
    createElement(type, value) { component = type; props = value; return {}; },
    useState(value) { return [value, next => { if (next?.rpm) snapshot = next; }]; },
    useRef(value) { return { current: value }; }, useCallback(callback) { if (callback.constructor.name === 'AsyncFunction') refresh = callback; return callback; },
    useEffect(callback) { callback(); },
  };
  runInNewContext(await readFile(new URL('../client.js', import.meta.url), 'utf8'), {
    window: { addEventListener() {}, removeEventListener() {}, __ModuleLoader__: { load({ factory }) { plugin = factory(() => React); } } },
    setInterval() {}, clearInterval() {},
  });
  let descriptor;
  const ctx = {
    remote: {
      async $mount(contribution) { descriptor = contribution.descriptors[0]; },
      ustcGuard: { async snapshot() { calls++; return { ok: true, value: { rpm: { used: 7 } } }; } },
    },
    get(name) { if (name === 'remote.ustcGuard') return this.remote.ustcGuard; }, effect() {},
    sessions: { list: { getSnapshot() { return { byId: {} }; }, subscribe() { return () => {}; } } },
    slots: { inject(_, callback) { callback(); }, register(_, render) { render(); } },
  };
  await plugin.apply(ctx);
  assert.equal(descriptor.namespace, 'ustcGuard');
  assert.equal(descriptor.method, 'snapshot');
  component(props);
  await Promise.resolve();
  await refresh();
  assert.equal(calls, 1);
  assert.equal(snapshot.rpm.used, 7);
});
