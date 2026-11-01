import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const sources = ['sync-storage.js', 'merge.js', 'sync.js'].map(name => readFileSync(new URL('../web/shared/' + name, import.meta.url), 'utf8'));
const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const settle = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
function localStorage(max = Infinity) {
  const values = new Map();
  const bytes = data => [...data].reduce((sum, [key, value]) => sum + Buffer.byteLength(key + value, 'utf16le'), 0);
  return {
    getItem: key => values.get(key) ?? null,
    removeItem: key => values.delete(key),
    setItem(key, value) {
      const next = new Map(values); next.set(key, String(value));
      if (bytes(next) > max) throw Object.assign(new Error('Storage is full'), {name:'QuotaExceededError'});
      values.set(key, String(value));
    },
    get bytes() { return bytes(values); },
  };
}
// The fake models IndexedDB's asynchronous request and transaction boundaries.
// Writes become visible only on commit; tests can pause or abort that boundary.
function indexedDB() {
  const records = new Map(), stores = new Set(), held = [];
  const backend = {
    holdWrites:false, failNextWrite:false,
    release() { assert.ok(held.length, 'a transaction must be waiting'); held.shift()(); },
    read(namespace = 'dm:OTTER-4821') { return clone(records.get(JSON.stringify([namespace, 'pda-save']))); },
  };
  const db = {
    objectStoreNames:{contains:name => stores.has(name)},
    createObjectStore:name => stores.add(name), close() {},
    transaction(_name, mode) {
      const operations = [], transaction = {
        objectStore:() => ({
          get(key) { const request = {}; operations.push({kind:'get',key,request}); return request; },
          put(value, key) { operations.push({kind:'put',key,value:clone(value)}); return {}; },
        }),
        abort() { transaction.error = new Error('aborted'); transaction.onabort?.(); },
      };
      const complete = () => {
        if (mode === 'readwrite' && backend.failNextWrite) {
          backend.failNextWrite = false; transaction.error = new Error('IndexedDB quota failure'); transaction.onabort?.(); return;
        }
        for (const operation of operations) {
          if (operation.kind === 'put') records.set(operation.key, clone(operation.value));
          else { operation.request.result = clone(records.get(operation.key)); operation.request.onsuccess?.(); }
        }
        transaction.oncomplete?.();
      };
      queueMicrotask(() => mode === 'readwrite' && backend.holdWrites ? held.push(complete) : complete());
      return transaction;
    },
  };
  backend.factory = {open() {
    const request = {result:db};
    queueMicrotask(() => { if (!stores.size) request.onupgradeneeded?.(); request.onsuccess?.(); }); return request;
  }};
  return backend;
}
function runtime(storage = localStorage()) {
  let sequence = 0;
  const context = vm.createContext({localStorage:storage,crypto:{randomUUID:() => `storage-test-mutation-${++sequence}`}});
  sources.forEach(source => vm.runInContext(source, context));
  return context;
}
const open = (context, backend, storage, namespace = 'dm:OTTER-4821') => context.KidSyncStorage.open({key:'pda-save',namespace,storage,indexedDB:backend.factory});
const state = () => ({updatedAt:1,settings:{},progress:{xp:0},forge:{dungeons:[],board:[],played:{},stats:{right:0,tries:0,commissions:0}}});
function controller(context, adapter, initial) {
  return context.KidSync.create({key:'pda-save',initial,storage:adapter,preserveAdoption:true,merge:context.KidMerge.dm,legacy:(local, remote) => context.KidMerge.legacy('dm',local,remote)});
}
function server(initial, onCommit = () => {}) {
  let value = clone(initial), version = 1;
  const mutations = new Set(), result = {
    attempts:0,
    get value() { return clone(value); },
    get mutations() { return mutations; },
    async get() { return {exists:true,data:() => clone(value),metadata:{etag:'v' + version}}; },
    async commit(candidate, options) {
      result.attempts++; onCommit(candidate, options);
      if (!mutations.has(options.mutation)) { value = clone(candidate); version++; mutations.add(options.mutation); }
      return result.get();
    },
  };
  return result;
}

test('without IndexedDB the adapter preserves localStorage behavior and scopes its keys', async () => {
  const storage = localStorage(), context = runtime(storage);
  const adapter = await context.KidSyncStorage.open({key:'pda-save',namespace:'dm:OTTER-4821',storage,indexedDB:null});
  adapter.setItem('pda-save:sync', 'metadata'); await adapter.flush();
  assert.equal(storage.getItem('pda-save:sync'), 'metadata');
  assert.throws(() => adapter.setItem('another-app:pending', 'secret'), /another storage key/);
  adapter.removeItem('pda-save:sync'); assert.equal(storage.getItem('pda-save:sync'), null);
});

test('legacy metadata and the exact pending JSON migrate only after IndexedDB commits', async () => {
  const storage = localStorage(), backend = indexedDB(), context = runtime(storage);
  const pending = '{"ui":{"z":1,"a":2},"mutation":"keep-this-mutation","candidate":{"last":3,"first":4}}';
  storage.setItem('pda-save:sync', '{"base":{"xp":5},"migrated":true}'); storage.setItem('pda-save:pending', pending);
  backend.holdWrites = true; const opening = open(context,backend,storage); await settle();
  assert.equal(storage.getItem('pda-save:pending'), pending); assert.equal(backend.read(), undefined);
  backend.release(); const adapter = await opening;
  assert.equal(adapter.getItem('pda-save:pending'), pending);
  assert.equal(backend.read().entries['pda-save:pending'], pending);
  assert.equal(storage.getItem('pda-save:pending'), null); assert.equal(storage.getItem('pda-save:sync'), null);
});

test('an aborted migration preserves the legacy pending write for the next attempt', async () => {
  const storage = localStorage(), backend = indexedDB(), context = runtime(storage), pending = '{"mutation":"original-mutation"}';
  storage.setItem('pda-save:pending', pending); backend.failNextWrite = true;
  await assert.rejects(open(context,backend,storage), {code:'unavailable'});
  assert.equal(storage.getItem('pda-save:pending'), pending); assert.equal(backend.read(), undefined);
  const adapter = await open(context,backend,storage);
  assert.equal(adapter.getItem('pda-save:pending'), pending); assert.equal(storage.getItem('pda-save:pending'), null);
});

test('flush includes writes queued during a transaction and retains aborted writes for retry', async () => {
  const storage = localStorage(), backend = indexedDB(), context = runtime(storage), adapter = await open(context,backend,storage);
  backend.holdWrites = true; adapter.setItem('pda-save:sync', 'one'); const flushing = adapter.flush(); await settle();
  adapter.setItem('pda-save:pending', 'two'); assert.equal(backend.read().entries['pda-save:sync'], null);
  backend.release(); await settle(); backend.release(); await flushing; backend.holdWrites = false;
  assert.deepEqual(backend.read().entries, {'pda-save:sync':'one','pda-save:pending':'two'});
  adapter.setItem('pda-save:sync', 'changed'); backend.failNextWrite = true;
  await assert.rejects(adapter.flush(), {code:'unavailable'});
  assert.equal(adapter.getItem('pda-save:sync'), 'changed'); assert.equal(backend.read().entries['pda-save:sync'], 'one');
  await adapter.flush(); assert.equal(backend.read().entries['pda-save:sync'], 'changed');
});

test('save-code namespaces cannot read or overwrite each other’s sync journals', async () => {
  const storage = localStorage(), backend = indexedDB(), context = runtime(storage);
  const a = await open(context,backend,storage); a.setItem('pda-save:pending', 'account A'); await a.flush();
  const b = await open(context,backend,storage,'dm:FOX-1234'); assert.equal(b.getItem('pda-save:pending'), null);
  b.setItem('pda-save:pending', 'account B'); await b.flush();
  a.setItem('pda-save:sync', 'A metadata'); await a.flush();
  assert.equal(backend.read().entries['pda-save:pending'], 'account A');
  assert.equal(backend.read('dm:FOX-1234').entries['pda-save:pending'], 'account B');
});

test('conflicting legacy and IndexedDB pending mutations are both preserved', async () => {
  const storage = localStorage(), backend = indexedDB(), context = runtime(storage), a = '{"mutation":"pending-account-a"}', b = '{"mutation":"pending-account-b"}';
  storage.setItem('pda-save:pending', a); await open(context,backend,storage); storage.setItem('pda-save:pending', b);
  await assert.rejects(open(context,backend,storage), {code:'unavailable'});
  assert.equal(storage.getItem('pda-save:pending'), b); assert.equal(backend.read().entries['pda-save:pending'], a);
});

test('network commits wait for durable pending state and save waits for atomic adoption and clear', async () => {
  const storage = localStorage(), backend = indexedDB(), context = runtime(storage), adapter = await open(context,backend,storage), initial = state();
  const sync = controller(context,adapter,initial); sync.reconcile(initial,initial); await sync.flush();
  const local = clone(initial); local.progress.xp = 5;
  const remote = server(initial, (_candidate, options) => {
    const durable = JSON.parse(backend.read().entries['pda-save:pending']);
    assert.equal(durable.mutation, options.mutation); assert.equal(durable.candidate.progress.xp, 5);
  });
  backend.holdWrites = true; let completed = false;
  const saving = sync.save(remote,local).then(value => { completed = true; return value; }); await settle();
  assert.equal(remote.attempts, 0); backend.release(); await settle();
  assert.equal(remote.attempts, 1); assert.equal(completed, false);
  assert.notEqual(backend.read().entries['pda-save:pending'], null);
  backend.release(); const saved = await saving;
  assert.equal(saved.progress.xp, 5); assert.equal(backend.read().entries['pda-save:pending'], null);
  const meta = JSON.parse(backend.read().entries['pda-save:sync']);
  assert.equal(meta.base.progress.xp, 5); assert.equal(meta.adoption.ui.progress.xp, 5); assert.equal(meta.adoption.remote.progress.xp, 5);
  assert.equal(sync.adoption.id, meta.adoption.id);
});

test('an aborted post-ack transaction retains and replays the original mutation exactly once', async () => {
  const storage = localStorage(), backend = indexedDB(), context = runtime(storage), adapter = await open(context,backend,storage), initial = state();
  const sync = controller(context,adapter,initial); sync.reconcile(initial,initial); await sync.flush();
  const local = clone(initial); local.progress.xp = 5; let fail = true;
  const remote = server(initial, () => { if (fail) { backend.failNextWrite = true; fail = false; } });
  await assert.rejects(sync.save(remote,local), {code:'unavailable'});
  assert.equal(sync.hasPending, true); const mutation = JSON.parse(backend.read().entries['pda-save:pending']).mutation;
  const saved = await sync.save(remote,local);
  assert.equal(saved.progress.xp, 5); assert.equal(remote.mutations.size, 1); assert.ok(remote.mutations.has(mutation));
  assert.equal(remote.attempts, 2); assert.equal(sync.hasPending, false);
});

test('a failed reconcile barrier does not advance the unseen in-memory baseline', async () => {
  const storage = localStorage(), backend = indexedDB(), context = runtime(storage), adapter = await open(context,backend,storage), initial = state();
  const sync = controller(context,adapter,initial); await sync.flush(); const remote = clone(initial); remote.progress.xp = 5;
  assert.equal(sync.reconcile(initial,remote).progress.xp, 5); backend.failNextWrite = true;
  await assert.rejects(sync.flush(), {code:'unavailable'});
  assert.equal(sync.reconcile(initial,remote).progress.xp, 5, 'retry must not subtract the remote activity the UI never received');
  await sync.flush(); assert.equal(sync.adoption.ui.progress.xp, 0); assert.equal(sync.adoption.remote.progress.xp, 5);
});

test('a reconciliation journal preserves its merged adoption target separately from the raw server baseline', async () => {
  const storage = localStorage(), backend = indexedDB(), context = runtime(storage), adapter = await open(context,backend,storage), initial = state();
  const dungeon = id => ({id,v:2,size:'small',title:id,intro:'',cells:'SE'+' '.repeat(106),ground:'s'.repeat(108),walls:'.'.repeat(237),things:{},rev:1,tested:0});
  initial.forge.dungeons = [dungeon('local-only')];
  const remote = clone(initial); remote.forge.dungeons = [dungeon('server-only')];
  const sync = controller(context,adapter,initial), desired = sync.reconcile(initial,remote); await sync.flush();
  assert.deepEqual(new Set(desired.forge.dungeons.map(d => d.id)), new Set(['local-only','server-only']));
  const meta = JSON.parse(backend.read().entries['pda-save:sync']);
  assert.deepEqual(meta.base.forge.dungeons.map(d => d.id), ['server-only']);
  assert.deepEqual(new Set(meta.adoption.remote.forge.dungeons.map(d => d.id)), new Set(['local-only','server-only']));
});

test('large Unicode Forge backups use IndexedDB without exhausting a five-MiB localStorage budget', async () => {
  const storage = localStorage(5 * 1024 * 1024), backend = indexedDB(), context = runtime(storage), initial = state();
  const things = Object.fromEntries(Array.from({length:766}, (_,i) => [i + 2,{text:'界'.repeat(160)}]));
  const dungeon = {v:2,size:'large',title:'A long story',intro:'',cells:'SE'+'s'.repeat(766),ground:'c'.repeat(768),walls:'.'.repeat(1592),things,rev:1,tested:1,share:null};
  initial.forge.dungeons = Array.from({length:4}, (_,i) => ({...dungeon,id:String(i)})); initial.progress.xp = 2000;
  storage.setItem('pda-forge', JSON.stringify(initial.forge)); storage.setItem('pda-save:sync', JSON.stringify({base:initial,migrated:true}));
  const adapter = await open(context,backend,storage), sync = controller(context,adapter,initial), local = clone(initial);
  local.forge.dungeons[0].title = 'Edited during play'; local.forge.dungeons[0].rev++;
  const remote = server(initial); const saved = await sync.save(remote,local);
  assert.equal(saved.forge.dungeons.length, 4); assert.equal(remote.value.forge.dungeons[0].title, 'Edited during play');
  assert.ok(storage.bytes < 5 * 1024 * 1024); assert.equal(storage.getItem('pda-save:pending'), null);
  assert.equal(backend.read().entries['pda-save:pending'], null);
  const reopened = await open(context,backend,storage), reloaded = controller(context,reopened,local);
  assert.equal(reloaded.adoption.remote.forge.dungeons[0].title, 'Edited during play'); assert.equal(reloaded.hasPending, false);
});
