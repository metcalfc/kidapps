// Run against a disposable local server: KIDAPPS_BASE_URL=http://127.0.0.1:8765 node tests/http-sync-integration.mjs
// Creates one new save code per app; never reads or changes an existing family's save.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import vm from 'node:vm';

const baseUrl = process.env.KIDAPPS_BASE_URL;
if (!baseUrl) throw new Error('Set KIDAPPS_BASE_URL to the disposable test server.');
const copy = value => JSON.parse(JSON.stringify(value));
const scripts = ['merge.js','sync-store.js','sync.js'].map(name => readFileSync(new URL('../web/shared/' + name, import.meta.url), 'utf8'));
function device(app, code, initial) {
  const values = new Map();
  const context = vm.createContext({
    crypto:{randomUUID}, console,
    localStorage:{getItem:key => values.get(key) || null, setItem:(key,value) => values.set(key,String(value)), removeItem:key => values.delete(key)},
    fetch:(url, options) => fetch(new URL(url, baseUrl), options),
    document:{visibilityState:'visible', addEventListener(){}, removeEventListener(){}},
    addEventListener(){}, removeEventListener(){}, setTimeout, clearTimeout,
  });
  context.window = context;
  scripts.forEach(script => vm.runInContext(script, context));
  const ref = context.KidSyncStore.doc(app, code, app === 'chain' ? 'game-v2' : 'signal-save');
  const sync = context.KidSync.create({key:app, initial:copy(initial), merge:context.KidMerge[app], legacy:(local,remote) => context.KidMerge.legacy(app,local,remote)});
  return {ref,sync};
}
async function newCode(app) {
  const response = await fetch(new URL('/' + app + '/api/codes', baseUrl), {method:'POST'});
  assert.equal(response.status, 201);
  return (await response.json()).code;
}

const chain = {v:1,updatedAt:1,bank:0,bestChain:0,days:{},facts:{},tickets:[],merged:[],settings:{tries:100,weekdayCap:45,weekendCap:90,sound:false}};
const chainCode = await newCode('chain');
const a = device('chain',chainCode,chain), b = device('chain',chainCode,chain);
await a.ref.commit(chain,{mutation:randomUUID(),etag:'*'});
a.sync.reconcile(chain,chain); b.sync.reconcile(chain,chain);
const first = {...copy(chain),bank:30,updatedAt:2}, second = {...copy(chain),bank:45,updatedAt:3};
await Promise.all([a.sync.save(a.ref,first),b.sync.save(b.ref,second)]);
let snapshot = await a.ref.get();
assert.equal(snapshot.data().bank,75);
const current = snapshot.data();
const c = device('chain',chainCode,current), d = device('chain',chainCode,current);
c.sync.reconcile(current,current); d.sync.reconcile(current,current);
const spend = ticket => state => {
  if (state.bank < 60) { const error = new Error('Insufficient bank'); error.code = 'conflict'; throw error; }
  state.bank -= 60; state.tickets.push(ticket); state.updatedAt++;
};
const receipts = [0,1].map(() => ({id:randomUUID(),at:Date.now(),min:1}));
const attempts = await Promise.allSettled([
  c.sync.transact(c.ref,copy(current),spend(receipts[0]),receipts[0]),
  d.sync.transact(d.ref,copy(current),spend(receipts[1]),receipts[1]),
]);
assert.equal(attempts.filter(result => result.status === 'fulfilled').length,1);
snapshot = await a.ref.get();
assert.equal(snapshot.data().bank,15);
assert.equal(snapshot.data().tickets.length,1);
console.log('Chain: concurrent HTTP credits preserved; concurrent cash-ins cannot overspend.');

const signal = {v:1,updatedAt:1,settings:{sound:false,lang:'en'},chapters:{},byLang:{},days:{}};
const signalCode = await newCode('signal');
const e = device('signal',signalCode,signal), f = device('signal',signalCode,signal);
await e.ref.commit(signal,{mutation:randomUUID(),etag:'*'});
e.sync.reconcile(signal,signal); f.sync.reconcile(signal,signal);
const solved = id => ({docs:[id],done:false,puzzles:{[id]:{solved:true,tries:1,hints:0,first:true}}});
const left = {...copy(signal),chapters:{c1:solved('p1')},updatedAt:2};
const right = {...copy(signal),chapters:{c1:solved('p2')},byLang:{fr:{c1:solved('p1')}},updatedAt:3};
await Promise.all([e.sync.save(e.ref,left),f.sync.save(f.ref,right)]);
const combined = (await e.ref.get()).data();
assert.equal(combined.chapters.c1.puzzles.p1.solved,true);
assert.equal(combined.chapters.c1.puzzles.p2.solved,true);
assert.equal(combined.byLang.fr.c1.puzzles.p1.solved,true);
console.log('Signal: concurrent HTTP saves preserve separate puzzles and languages.');
