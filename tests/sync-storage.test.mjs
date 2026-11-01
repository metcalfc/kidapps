import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { indexedDB } from './indexeddb-harness.mjs';

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
let runtimeNumber = 0;
function runtime(storage = localStorage(), session = localStorage()) {
  let sequence = 0; const device = ++runtimeNumber;
  const context = vm.createContext({localStorage:storage,sessionStorage:session,crypto:{randomUUID:() => `storage-test-${device}-mutation-${++sequence}`}});
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
      result.attempts++;
      if (mutations.has(options.mutation)) return result.get();
      if (options.etag !== 'v' + version) throw Object.assign(new Error('stale'), {code:'conflict'});
      onCommit(candidate, options);
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
  for (const count of [4,12]) {
  const storage = localStorage(5 * 1024 * 1024), backend = indexedDB(), context = runtime(storage), initial = state();
  const things = Object.fromEntries(Array.from({length:766}, (_,i) => [i + 2,{text:'界'.repeat(160)}]));
  const dungeon = {v:2,size:'large',title:'A long story',intro:'',cells:'SE'+'s'.repeat(766),ground:'c'.repeat(768),walls:'.'.repeat(1592),things,rev:1,tested:1,share:null};
  initial.forge.dungeons = Array.from({length:count}, (_,i) => ({...dungeon,id:String(i)})); initial.progress.xp = 2000;
  storage.setItem('pda-forge', JSON.stringify(initial.forge));
  if (count === 4) storage.setItem('pda-save:sync', JSON.stringify({base:initial,migrated:true}));
  const adapter = await open(context,backend,storage), sync = controller(context,adapter,initial), local = clone(initial);
  local.forge.dungeons[0].title = 'Edited during play'; local.forge.dungeons[0].rev++;
  const remote = server(initial); const saved = await sync.save(remote,local);
  assert.equal(saved.forge.dungeons.length, count); assert.equal(remote.value.forge.dungeons[0].title, 'Edited during play');
  assert.ok(storage.bytes < 5 * 1024 * 1024); assert.equal(storage.getItem('pda-save:pending'), null);
  assert.equal(backend.read().entries['pda-save:pending'], null);
  const reopened = await open(context,backend,storage), reloaded = controller(context,reopened,local);
  assert.equal(reloaded.adoption.remote.forge.dungeons[0].title, 'Edited during play'); assert.equal(reloaded.hasPending, false);
  }
});


test('same-account stale adapters preserve each writer’s pending intent in serialized transactions', async () => {
  const storage = localStorage(), backend = indexedDB(), aContext = runtime(storage), bContext = runtime(storage);
  const [a,b] = await Promise.all([open(aContext,backend,storage),open(bContext,backend,storage)]);
  const aPending = JSON.stringify({mutation:'same-account-pending-a'}), bPending = JSON.stringify({mutation:'same-account-pending-b'});
  a.setItem('pda-save:pending',aPending); await a.flush();
  b.setItem('pda-save:sync','stale B metadata'); await b.flush();
  assert.equal(backend.read().writers[a.owner].entries['pda-save:pending'],aPending);
  b.setItem('pda-save:pending',bPending); await b.flush();
  assert.equal(backend.read().writers[a.owner].entries['pda-save:pending'],aPending);
  assert.equal(backend.read().writers[b.owner].entries['pda-save:pending'],bPending);
  assert.deepEqual(clone(await b.pendingRecords()).map(record=>record.mutation),['same-account-pending-a']);
});

test('two controllers sharing physical storage recover a lost ACK before saving both practice deltas', async () => {
  const storage = localStorage(), backend = indexedDB(), sessionA = localStorage(), sessionB = localStorage();
  const aContext = runtime(storage,sessionA), bContext = runtime(storage,sessionB), initial = state();
  const aAdapter = await open(aContext,backend,storage), bAdapter = await open(bContext,backend,storage);
  const a = controller(aContext,aAdapter,initial), b = controller(bContext,bAdapter,initial);
  a.reconcile(initial,initial);b.reconcile(initial,initial);await Promise.all([a.flush(),b.flush()]);
  const aLocal = clone(initial), bLocal = clone(initial); aLocal.progress.xp=5;bLocal.progress.xp=7;
  const remote = server(initial), commit = remote.commit;let lose=true;
  remote.commit = async (...args) => { const saved=await commit(...args);if(lose){lose=false;throw Object.assign(new Error('lost ACK'),{code:'unavailable'});}return saved; };
  await assert.rejects(a.save(remote,aLocal),{code:'unavailable'});
  const original = JSON.parse(backend.read().writers[aAdapter.owner].entries['pda-save:pending']).mutation;
  b.reconcile(initial,initial);await b.flush();
  assert.equal(JSON.parse(backend.read().writers[aAdapter.owner].entries['pda-save:pending']).mutation,original);
  assert.equal((await b.save(remote,bLocal)).progress.xp,12);
  assert.equal((await a.save(remote,aLocal)).progress.xp,12);
  assert.equal(remote.value.progress.xp,12);assert.equal(remote.mutations.size,2);
  const reloadedContext = runtime(storage,sessionA), reloaded = controller(reloadedContext,await open(reloadedContext,backend,storage),aLocal);
  assert.equal(reloaded.hasPending,false);assert.equal((await reloaded.save(remote,remote.value)).progress.xp,12);
  assert.ok(Object.values(backend.read().writers).every(slot=>!slot.entries['pda-save:pending']));
});

test('orphaned pending saves and duplicate-tab resume hints replay once without sharing writer ownership', async () => {
  const storage = localStorage(), backend = indexedDB(), initial = state(), aContext = runtime(storage), bContext = runtime(storage);
  const aAdapter = await open(aContext,backend,storage), bAdapter = await open(bContext,backend,storage);
  const pending = (id,xp) => { const local=clone(initial);local.progress.xp=xp;return JSON.stringify({mutation:id,base:initial,local,ui:local,kind:'save',candidate:local,etag:'v1'}); };
  aAdapter.setItem('pda-save:sync',JSON.stringify({base:initial,migrated:true}));aAdapter.setItem('pda-save:pending',pending('orphan-practice-a',5));await aAdapter.flush();
  bAdapter.setItem('pda-save:sync',JSON.stringify({base:initial,migrated:true}));bAdapter.setItem('pda-save:pending',pending('orphan-practice-b',7));await bAdapter.flush();
  // Neither old document is used again, and the new session has no resume hint.
  const newContext=runtime(storage), adapter=await open(newContext,backend,storage), sync=controller(newContext,adapter,initial), remote=server(initial), local=clone(initial);local.progress.xp=7;
  assert.equal((await sync.save(remote,local)).progress.xp,12);assert.equal(remote.mutations.size,2);
  assert.ok(Object.values(backend.read().writers).every(slot=>!slot.entries['pda-save:pending']));
  const hint=JSON.stringify(['dm:OTTER-4821','pda-save'])+':writer', originalSession=localStorage(), duplicateSession=localStorage();
  originalSession.setItem(hint,adapter.owner);duplicateSession.setItem(hint,adapter.owner);
  const original=runtime(storage,originalSession), duplicate=runtime(storage,duplicateSession);
  const [left,right]=await Promise.all([open(original,backend,storage),open(duplicate,backend,storage)]);
  assert.notEqual(left.owner,right.owner);left.setItem('pda-save:pending',pending('duplicate-left-keep',1));await left.flush();right.setItem('pda-save:sync','stale duplicate metadata');await right.flush();
  assert.equal(JSON.parse(backend.read().writers[left.owner].entries['pda-save:pending']).mutation,'duplicate-left-keep');
});
