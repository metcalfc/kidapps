import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const script = readFileSync(new URL('../web/shared/sync-store.js', import.meta.url), 'utf8');
const copy = value => JSON.parse(JSON.stringify(value));
function response(data, etag = '"version-1"', status = 200) {
  return { status, ok: status >= 200 && status < 300,
    headers: { get: name => name.toLowerCase() === 'etag' ? etag : null },
    text: async () => JSON.stringify(data) };
}
function loadTransport() {
  const replies = [], requests = [], timers = new Map(), listeners = new Map();
  let nextTimer = 0;
  const listen = (name, callback) => { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(callback); };
  const unlisten = (name, callback) => listeners.get(name)?.delete(callback);
  const document = { visibilityState: 'visible', addEventListener: listen, removeEventListener: unlisten };
  const context = { document, TextEncoder, addEventListener: listen, removeEventListener: unlisten,
    setTimeout(callback, delay) { const id = ++nextTimer; timers.set(id, { callback, delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    async fetch(url, options) {
      requests.push({ url, options: copy(options) });
      if (!replies.length) throw new Error('The test did not queue a response');
      const reply = replies.shift();
      if (reply instanceof Error) throw reply;
      return reply;
    },
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(script, context);
  return {
    doc: (...args) => context.KidSyncStore.doc(...args), requests, replies, timers, listeners, document,
    async poll() {
      const [id, timer] = timers.entries().next().value ?? [];
      assert.ok(timer, 'the watcher must have a scheduled poll');
      assert.equal(timer.delay, 20000);
      timers.delete(id);
      await timer.callback();
    },
  };
}

test('conditional PUT sends its ETag and stable mutation ID with the candidate JSON', async () => {
  const transport = loadTransport(), ref = transport.doc('chain', 'OTTER-4821', 'game-v2');
  transport.replies.push(response({ bank: 30 }, '"new-version"'));
  const saved = await ref.commit({ bank: 30 }, { mutation: 'fixed-mutation-id', etag: '"old-version"' });
  const request = transport.requests[0];
  assert.equal(request.url, '/chain/api/saves/OTTER-4821/game-v2');
  assert.equal(request.options.method, 'PUT');
  assert.equal(request.options.cache, 'no-store');
  assert.equal(request.options.keepalive, true);
  assert.deepEqual(request.options.headers, {
    'Content-Type': 'application/json', 'X-Kidapps-Mutation': 'fixed-mutation-id', 'If-Match': '"old-version"',
  });
  assert.deepEqual(JSON.parse(request.options.body), { bank: 30 });
  assert.equal(saved.metadata.etag, '"new-version"');
  assert.equal(saved.metadata.hasPendingWrites, false);
});

test('a replay returns the authoritative latest response instead of the submitted candidate', async () => {
  const transport = loadTransport(), ref = transport.doc('chain', 'OTTER-4821', 'game-v2');
  const candidate = { bank: 30 }, options = { mutation: 'replayed-mutation', etag: '"old"' };
  transport.replies.push(response({ bank: 75 }, '"v2"'), response({ bank: 90 }, '"v3"'));
  const first = await ref.commit(candidate, options), replay = await ref.commit(candidate, options);
  assert.equal(first.data().bank, 75);
  assert.equal(replay.data().bank, 90);
  assert.equal(replay.metadata.etag, '"v3"');
  assert.equal(transport.requests[0].options.headers['X-Kidapps-Mutation'], transport.requests[1].options.headers['X-Kidapps-Mutation']);
  assert.equal(transport.requests[0].options.body, transport.requests[1].options.body);
});

test('large Unicode Forge backups use a normal PUT instead of the small keepalive body budget', async () => {
  const transport=loadTransport(),ref=transport.doc('dm','OTTER-4821','pda-save');
  const data={forge:{notes:'界'.repeat(24000)}}; // 24,000 characters, over 64 KiB in UTF-8.
  transport.replies.push(response(data,'"large-map"'));
  await ref.commit(data,{mutation:'large-map-backup',etag:'"before"'});
  assert.equal(transport.requests[0].options.keepalive,false);
  assert.deepEqual(JSON.parse(transport.requests[0].options.body),data);
  assert.equal(transport.requests[0].options.headers['X-Kidapps-Mutation'],'large-map-backup');
});

test('a missing GET supplies the create-only wildcard for a conditional first write', async () => {
  const transport = loadTransport(), ref = transport.doc('signal', 'OTTER-4821', 'signal-save');
  transport.replies.push(response(null, null, 404));
  const missing = await ref.get();
  assert.equal(missing.exists, false);
  assert.equal(missing.data(), undefined);
  assert.equal(missing.metadata.etag, '*');
  transport.replies.push(response({ chapters: {} }, '"created"'));
  await ref.commit({ chapters: {} }, { mutation: 'create-once', etag: missing.metadata.etag });
  const headers = transport.requests[1].options.headers;
  assert.equal(headers['If-None-Match'], '*');
  assert.equal(headers['If-Match'], undefined);
  assert.equal(headers['X-Kidapps-Mutation'], 'create-once');
});

test('a rejected ETag becomes a conflict, and network failures remain retryable', async () => {
  const transport = loadTransport(), ref = transport.doc('chain', 'OTTER-4821', 'game-v2');
  transport.replies.push(response(null, null, 412));
  await assert.rejects(ref.commit({}, { mutation: 'stale', etag: '"old"' }), { code: 'conflict' });
  transport.replies.push(new Error('offline'));
  await assert.rejects(ref.get(), { code: 'unavailable' });
  transport.replies.push(response(null, null, 429));
  await assert.rejects(ref.get(), { code: 'resource_exhausted' });
});

test('successful responses without an ETag cannot be treated as confirmed writes', async () => {
  const transport = loadTransport(), ref = transport.doc('chain', 'OTTER-4821', 'game-v2');
  transport.replies.push(response({ bank: 30 }, null));
  await assert.rejects(ref.commit({ bank: 30 }, { mutation: 'unconfirmed', etag: '"old"' }), { code: 'unavailable' });
});

test('a rejected watcher delivery retries unchanged content, then stops redundant renders after acceptance', async () => {
  const transport = loadTransport(), ref = transport.doc('chain', 'OTTER-4821', 'game-v2');
  transport.replies.push(response({ bank: 0 }, '"v1"'));
  await ref.get();
  const delivered = [];
  let accepts = false;
  const unsubscribe = ref.onSnapshot(snapshot => { delivered.push(snapshot.data().bank); return accepts; });
  transport.replies.push(response({ bank: 30 }, '"v2"'));
  await transport.poll();
  assert.deepEqual(delivered, [30]);
  accepts = true;
  transport.replies.push(response({ bank: 30 }, '"v2"'));
  await transport.poll();
  assert.deepEqual(delivered, [30, 30]);
  transport.replies.push(response({ bank: 30 }, '"v2"'));
  await transport.poll();
  assert.deepEqual(delivered, [30, 30]);
  transport.replies.push(response({ bank: 45 }, '"v3"'));
  await transport.poll();
  assert.deepEqual(delivered, [30, 30, 45]);
  assert.equal(transport.timers.size, 1);
  unsubscribe();
  assert.equal(transport.timers.size, 0);
  for (const event of ['visibilitychange', 'online', 'focus']) assert.equal(transport.listeners.get(event).size, 0);
});

test('a hidden document skips network polling and continues scheduling until unsubscribed', async () => {
  const transport = loadTransport(), ref = transport.doc('signal', 'OTTER-4821', 'signal-save');
  transport.document.visibilityState = 'hidden';
  const unsubscribe = ref.onSnapshot(() => { throw new Error('a hidden page must not render'); });
  await transport.poll();
  assert.equal(transport.requests.length, 0);
  assert.equal(transport.timers.size, 1);
  unsubscribe();
  assert.equal(transport.timers.size, 0);
});

test('overlapping wake polls cannot mark a newer undelivered snapshot as already rendered', async () => {
  const transport = loadTransport(), ref = transport.doc('chain', 'OTTER-4821', 'game-v2');
  transport.replies.push(response({ bank: 0 }, '"v1"'));
  await ref.get();
  const delivered = [];
  const unsubscribe = ref.onSnapshot(snapshot => { delivered.push(snapshot.data().bank); });
  const tick = [...transport.timers.values()][0].callback;
  transport.replies.push(response({ bank: 30 }, '"v2"'), response({ bank: 45 }, '"v3"'));
  await Promise.all([tick(), tick()]); // A timer and focus wake can overlap.
  transport.replies.push(response({ bank: 45 }, '"v3"'));
  await transport.poll();
  assert.equal(delivered.at(-1), 45, 'the current server snapshot must eventually reach the UI');
  unsubscribe();
});
