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
    crypto:{randomUUID}, console, TextEncoder,
    localStorage:{getItem:key => values.get(key) || null, setItem:(key,value) => values.set(key,String(value)), removeItem:key => values.delete(key)},
    fetch:(url, options) => fetch(new URL(url, baseUrl), options),
    document:{visibilityState:'visible', addEventListener(){}, removeEventListener(){}},
    addEventListener(){}, removeEventListener(){}, setTimeout, clearTimeout,
  });
  context.window = context;
  scripts.forEach(script => vm.runInContext(script, context));
  const ref = context.KidSyncStore.doc(app, code, app === 'chain' ? 'game-v2' : app === 'dm' ? 'pda-save' : 'signal-save');
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

const dm={updatedAt:1,settings:{dm:'Test builder'},progress:{xp:0,modules:{},bestStreak:0},tracker:{round:1,list:[]},forge:{dungeons:[],board:[],played:{},stats:{right:0,tries:0,commissions:0}}};
const dmCode=await newCode('dm'),g=device('dm',dmCode,dm),h=device('dm',dmCode,dm);
await g.ref.commit(dm,{mutation:randomUUID(),etag:'*'});g.sync.reconcile(dm,dm);h.sync.reconcile(dm,dm);
const dungeon=id=>({id,v:2,size:'small',title:id,intro:'',rev:1,tested:0,cells:'SE'+'.'.repeat(106),ground:'s'.repeat(108),walls:'.'.repeat(237),things:{}});
const laptop=copy(dm),tablet=copy(dm);laptop.forge.dungeons.push(dungeon('laptop'));tablet.forge.dungeons.push(dungeon('tablet'));
laptop.progress.xp=5;tablet.progress.xp=10;laptop.updatedAt=tablet.updatedAt=2;
await Promise.all([g.sync.save(g.ref,laptop),h.sync.save(h.ref,tablet)]);
const dmCurrent=(await g.ref.get()).data();
assert.deepEqual(copy(dmCurrent.forge.dungeons.map(d=>d.id)).sort(),['laptop','tablet']);assert.equal(dmCurrent.progress.xp,15);
const i=device('dm',dmCode,dmCurrent),j=device('dm',dmCode,dmCurrent);i.sync.reconcile(dmCurrent,dmCurrent);j.sync.reconcile(dmCurrent,dmCurrent);
const one=copy(dmCurrent),two=copy(dmCurrent);one.forge.dungeons[0].title='First builder version';two.forge.dungeons[0].title='Second builder version';
one.forge.dungeons[0].rev++;two.forge.dungeons[0].rev++;
await Promise.all([i.sync.save(i.ref,one),j.sync.save(j.ref,two)]);
const dmSaved=(await i.ref.get()).data();
assert.equal(dmSaved.forge.dungeons.length,3);
assert.ok(dmSaved.forge.dungeons.some(d=>d.title.startsWith('First builder version')));
assert.ok(dmSaved.forge.dungeons.some(d=>d.title.startsWith('Second builder version')));
const oldWrite=await fetch(new URL('/dm/api/saves/'+dmCode+'/pda-save',baseUrl),{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(dm)});
assert.equal(oldWrite.status,409,'an older open app cannot replace conditional Forge saves');
console.log('DM Forge: concurrent HTTP maps and practice preserved; competing edits recover both versions; old unconditional writes rejected.');
