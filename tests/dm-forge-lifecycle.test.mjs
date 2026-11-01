import test from 'node:test';
import assert from 'node:assert/strict';
import {loadDm} from './dm-harness.mjs';

const clone = value => JSON.parse(JSON.stringify(value));
const read = (app, value) => JSON.parse(app.evaluate(`JSON.stringify(${value})`));
const settle = async () => { for(let i=0;i<60;i++) await Promise.resolve(); };
const legacy = () => ({id:'legacy-map',title:'The old map',cells:'S.DE'+' '.repeat(104),things:{},rev:1,tested:0,share:null});

test('normalization is pure and identical legacy snapshots merge into one map', () => {
  const app = loadDm(), old = read(app, 'snapshotLocal()');
  old.forge.dungeons = [legacy()];
  app.evaluate(`globalThis.oldSnapshot = ${JSON.stringify(old)}; globalThis.normalized = normalizeDmSnapshot(oldSnapshot);`);
  assert.deepEqual(read(app, 'oldSnapshot'), old, 'normalizing does not mutate a merge input');
  assert.equal(app.evaluate('normalized.forge.dungeons[0].v'), 2);
  assert.deepEqual(read(app, 'normalizeDmSnapshot(normalized)'), read(app, 'normalized'));
  for(const expression of ['dmLegacy(normalized,oldSnapshot)', 'dmMerge(oldSnapshot,normalized,oldSnapshot)']) {
    assert.equal(app.evaluate(`${expression}.forge.dungeons.length`), 1);
    assert.equal(app.evaluate(`${expression}.forge.dungeons[0].id`), 'legacy-map');
  }
});

test('browser storage receipts cannot enter shared game state through an older page', () => {
  const app=loadDm(),old=read(app,'snapshotLocal()');
  for(const field of ['settings','progress','tracker','forge']) Object.assign(old[field],{_kidSyncAdoption:'local-receipt',_kidSyncWriter:'local-tab',_kidSyncWrite:7});
  app.evaluate(`globalThis.receiptInput=${JSON.stringify(old)};globalThis.cleanSnapshot=normalizeDmSnapshot(receiptInput);`);
  for(const field of ['settings','progress','tracker','forge']) {
    assert.equal(app.evaluate(`cleanSnapshot.${field}._kidSyncWriter`),undefined);
    assert.equal(app.evaluate(`cleanSnapshot.${field}._kidSyncAdoption`),undefined);
    assert.equal(app.evaluate(`cleanSnapshot.${field}._kidSyncWrite`),undefined);
    assert.equal(app.evaluate(`receiptInput.${field}._kidSyncWriter`),'local-tab','normalization must leave its input unchanged');
  }
});

test('connecting identical local and server legacy maps does not invent a recovered copy', async () => {
  const values = new Map([['pda-forge',JSON.stringify({dungeons:[legacy()],board:[],played:{},stats:{}})]]);
  const storage = {getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,String(value)),removeItem:key=>values.delete(key)};
  const app = loadDm({localStorage:storage});
  let remote = read(app, 'snapshotLocal()'), version = 1;
  remote.forge.dungeons = [legacy()];
  const snapshot = () => { const value = clone(remote); return {exists:true,data:()=>value,metadata:{etag:'v'+version,hasPendingWrites:false}}; };
  app.setRemote({get:async()=>snapshot(),onSnapshot:()=>()=>{},commit:async value=>{remote=clone(value);version++;return snapshot();}});
  await app.evaluate('cloudConnect()');
  assert.equal(app.evaluate('forge.dungeons.length'), 1);
  assert.equal(app.evaluate('forge.dungeons[0].v'), 2);
  assert.equal(remote.forge.dungeons.length, 1);
  assert.equal(remote.forge.dungeons[0].id, 'legacy-map');
});

function joining() {
  const app = loadDm();
  app.evaluate(`show('forge'); globalThis.requests=[];
    globalThis.fetch = () => new Promise((resolve,reject)=>requests.push({resolve,reject}));
    globalThis.sharedMap = title => ({v:2,size:'small',title,cells:'SE'+' '.repeat(106),ground:'s'.repeat(108),walls:'.'.repeat(237),things:{}});`);
  return app;
}
async function reply(app, i, title) {
  app.evaluate(`requests[${i}].resolve({ok:true,status:200,json:async()=>sharedMap(${JSON.stringify(title)})});`);
  await settle();
}

test('the newest dungeon-code request wins even when older responses finish last', async () => {
  const app = joining();
  const first = app.evaluate("forgeJoin('FOX-1234')"), second = app.evaluate("forgeJoin('OWL-4567')");
  await reply(app, 1, 'New dungeon'); await second;
  const session = app.evaluate('fp.session');
  await reply(app, 0, 'Old dungeon'); await first;
  assert.equal(app.evaluate('fp.d.title'), 'New dungeon');
  assert.equal(app.evaluate('fp.code'), 'OWL-4567');
  assert.equal(app.evaluate('fp.session'), session);
  assert.equal(app.evaluate("forge.played['FOX-1234']"), undefined);
});

test('an older JSON body cannot open a dungeon after a newer request', async () => {
  const app = joining();
  const first = app.evaluate("forgeJoin('FOX-1234')");
  app.evaluate('requests[0].resolve({ok:true,status:200,json:()=>new Promise(resolve=>globalThis.finishBody=resolve)});');
  await settle();
  const second = app.evaluate("forgeJoin('OWL-4567')");
  await reply(app, 1, 'New dungeon'); await second;
  app.evaluate("finishBody(sharedMap('Old dungeon'))"); await first;
  assert.equal(app.evaluate('fp.d.title'), 'New dungeon');
});

test('leaving Forge or starting another map cancels a pending join', async () => {
  for(const action of ["show('home')", "renderForge()", "forgePlay(sharedMap('My map'),'test')", "forgeEdit('missing-map')"]) {
    const app = joining(), waiting = app.evaluate("forgeJoin('FOX-1234')");
    app.evaluate(action); const session = app.evaluate('fp.session');
    await reply(app, 0, 'Late dungeon'); await waiting;
    assert.equal(app.evaluate('fp.session'), session, action);
    assert.equal(app.evaluate("forge.played['FOX-1234']"), undefined, action);
  }
});

test('stale failures cannot replace the current join notice, and malformed bodies are handled', async () => {
  const app = joining(), first = app.evaluate("forgeJoin('FOX-1234')"), second = app.evaluate("forgeJoin('OWL-4567')");
  app.evaluate("requests[0].reject(new Error('offline'))"); await first;
  assert.equal(app.element('forge-join-msg').textContent, 'Opening…');
  app.evaluate("requests[1].resolve({ok:true,status:200,json:async()=>{throw new Error('bad JSON')}})"); await second;
  assert.match(app.element('forge-join-msg').textContent, /could not be read/);
});
