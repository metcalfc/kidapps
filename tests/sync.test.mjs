import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const scripts = ['merge.js','sync.js'].map(name => readFileSync(new URL('../web/shared/' + name, import.meta.url),'utf8'));
const copy = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const error = code => Object.assign(new Error(code), {code});
const day = '2026-10-27';
const chain = bank => ({v:1,updatedAt:0,settings:{weekdayCap:45,weekendCap:90},bank,bestChain:0,days:{},facts:{},tickets:[],merged:[]});
const signal = () => ({v:1,updatedAt:0,settings:{lang:'en'},chapters:{},byLang:{},days:{}});
function memoryStorage() {
  const values = new Map();
  return {getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,String(v)),removeItem:k=>values.delete(k)};
}
let devices = 0;
function device(app, initial, storage = memoryStorage()) {
  const prefix = ++devices; let ids = 0;
  const context = {localStorage:storage,crypto:{randomUUID:()=>`device-${prefix}-mutation-${++ids}`}};
  vm.createContext(context); scripts.forEach(script=>vm.runInContext(script,context));
  const sync = context.KidSync.create({key:app,initial:copy(initial),merge:context.KidMerge[app],legacy:(l,r)=>context.KidMerge.legacy(app,l,r)});
  return {sync,storage,context};
}
class Server {
  constructor(state) { this.state=copy(state); this.version=state===undefined?0:1; this.mutations=new Set(); this.applied=0; this.gets=0; this.commits=0; }
  snapshot() { const data=copy(this.state);return {exists:data!==undefined,data:()=>data,metadata:{etag:`v${this.version}`}}; }
  ref() { return {get:async()=>{this.gets++;if(this.getError)throw error(this.getError);return this.snapshot();},commit:async(candidate,options)=>{
    this.commits++;
    if(this.mutations.has(options.mutation))return this.snapshot();
    if(this.beforeCommit)await this.beforeCommit(candidate,options);
    if(this.commitError)throw error(this.commitError);
    const expected=this.state===undefined?'*':`v${this.version}`;
    if(options.etag!==expected)throw error('conflict');
    this.state=copy(candidate);this.version++;this.applied++;this.mutations.add(options.mutation);
    if(this.loseResponses){this.loseResponses--;throw error('unavailable');}
    return this.snapshot();
  }}; }
  write(state) { this.state=copy(state);this.version++; }
}
function earn(state, minutes) {
  state.bank+=minutes;
  state.days[day]??={tries:0,correct:0,earned:0,redeemed:0};
  state.days[day].earned+=minutes;state.days[day].correct++;state.days[day].tries++;
}
function spend(minutes, receipt) { return state=>{
  if(state.bank<minutes)throw error('conflict');
  state.bank-=minutes;state.days[day]??={tries:0,correct:0,earned:0,redeemed:0};state.days[day].redeemed+=minutes;state.tickets.push(copy(receipt));return state;
}; }
function solve(state, language, puzzle) {
  const progress=language==='en'?state.chapters:(state.byLang[language]??={});
  const ch=progress.c1??={docs:[],puzzles:{},done:false};
  ch.docs.push(`doc-${puzzle}`);ch.puzzles[puzzle]={solved:true,tries:1,hints:0,first:true,answer:puzzle,at:1};
  state.days[day]??={secs:0,solved:0,docs:0};state.days[day].solved++;state.days[day].docs++;
}

test('independent Signal puzzles and language progress survive concurrent stale saves', async()=>{
  const initial=signal(),server=new Server(initial),a=device('signal',initial),b=device('signal',initial);
  const left=copy(initial),right=copy(initial);solve(left,'en','p1');solve(right,'en','p2');solve(right,'fr','p1');
  await a.sync.save(server.ref(),left);const saved=await b.sync.save(server.ref(),right);
  assert.equal(saved.chapters.c1.puzzles.p1.solved,true);assert.equal(saved.chapters.c1.puzzles.p2.solved,true);
  assert.equal(saved.byLang.fr.c1.puzzles.p1.solved,true);assert.equal(saved.days[day].solved,3);
});

test('independent Chain credits of 30 and 45 become exactly 75', async()=>{
  const initial=chain(0),server=new Server(initial),a=device('chain',initial),b=device('chain',initial);
  const left=copy(initial),right=copy(initial);earn(left,30);earn(right,45);
  await a.sync.save(server.ref(),left);const saved=await b.sync.save(server.ref(),right);
  assert.equal(saved.bank,75);assert.equal(saved.days[day].earned,75);assert.equal(saved.days[day].correct,2);
  assert.equal((await b.sync.save(server.ref(),saved)).bank,75);
});

test('a stale CAS spend rebases its single debit and fixed receipt once', async()=>{
  const initial=chain(100),server=new Server(initial),a=device('chain',initial),receipt={id:'ticket-a',at:1,minutes:30};
  let raced=false;
  server.beforeCommit=async candidate=>{if(!raced&&candidate.tickets.some(t=>t.id===receipt.id)){raced=true;const next=copy(server.state);earn(next,45);server.write(next);}};
  const saved=await a.sync.transact(server.ref(),copy(initial),spend(30,receipt),receipt);
  assert.equal(saved.state.bank,115);assert.equal(saved.state.days[day].earned,45);assert.equal(saved.state.days[day].redeemed,30);
  assert.equal(saved.state.tickets.length,1);assert.equal(saved.result.id,receipt.id);assert.equal(server.applied,1);
});

test('lost ACK replay after another write returns the latest state without double credit', async()=>{
  const initial=chain(0),server=new Server(initial),a=device('chain',initial),left=copy(initial);earn(left,30);server.loseResponses=1;
  await assert.rejects(a.sync.save(server.ref(),left),{code:'unavailable'});assert.equal(a.sync.hasPending,true);
  const originalPending=JSON.parse(a.storage.getItem('chain:pending'));
  const b=device('chain',copy(server.state)),right=copy(server.state);earn(right,45);await b.sync.save(server.ref(),right);
  const gets=server.gets;const saved=await a.sync.save(server.ref(),left);
  assert.equal(saved.bank,75);assert.equal(saved.days[day].earned,75);assert.equal(server.applied,2);
  assert.equal(server.gets,gets,'persisted request is replayed before any GET');assert.equal(a.sync.hasPending,false);
  assert.ok(server.mutations.has(originalPending.mutation));
});

test('an offline pending write survives reload and is durably present before PUT', async()=>{
  const initial=chain(0),server=new Server(initial),storage=memoryStorage(),a=device('chain',initial,storage),local=copy(initial);earn(local,30);
  server.commitError='unavailable';
  await assert.rejects(a.sync.save(server.ref(),local),{code:'unavailable'});
  const pending=JSON.parse(storage.getItem('chain:pending'));
  const reloaded=device('chain',local,storage);assert.equal(reloaded.sync.hasPending,true);delete server.commitError;
  server.beforeCommit=async(candidate,options)=>{
    const durable=JSON.parse(storage.getItem('chain:pending'));
    assert.equal(options.mutation,pending.mutation);assert.equal(durable.mutation,options.mutation);assert.deepEqual(copy(candidate),durable.candidate);
  };
  const saved=await reloaded.sync.save(server.ref(),local);
  assert.equal(saved.bank,30);assert.equal(server.applied,1);assert.equal(storage.getItem('chain:pending'),null);
});

test('reconcile leaves the UI untouched while a write has an uncertain outcome', async()=>{
  const initial=chain(0),server=new Server(initial),a=device('chain',initial),local=copy(initial);earn(local,30);server.loseResponses=1;
  await assert.rejects(a.sync.save(server.ref(),local),{code:'unavailable'});
  const remote=copy(server.state);earn(remote,45);
  assert.deepEqual(copy(a.sync.reconcile(local,remote)),local);
  assert.equal(a.sync.hasPending,true);
});

test('practice performed while awaiting a response is saved in a second mutation', async()=>{
  const initial=chain(0),server=new Server(initial),a=device('chain',initial),local=copy(initial);earn(local,30);
  let release,entered;const gate=new Promise(r=>release=r),inside=new Promise(r=>entered=r);
  server.beforeCommit=async()=>{server.beforeCommit=null;entered();await gate;};
  const saving=a.sync.save(server.ref(),local);await inside;earn(local,45);release();
  const saved=await saving;
  assert.equal(saved.bank,75);assert.equal(saved.days[day].earned,75);assert.equal(saved.days[day].correct,2);assert.equal(server.applied,2);
});

test('bank or daily-cap conflicts after rejected CAS apply no ticket and expose current remote', async()=>{
  for(const scenario of ['bank','cap']){
    const initial=chain(100),server=new Server(initial),a=device('chain',initial),receipt={id:`ticket-${scenario}`,at:1,minutes:30};
    let raced=false;server.beforeCommit=async candidate=>{if(!raced&&candidate.tickets.some(t=>t.id===receipt.id)){
      raced=true;const remote=copy(server.state);
      if(scenario==='bank')remote.bank=0;else remote.days[day]={redeemed:45};server.write(remote);
    }};
    const failure=await a.sync.transact(server.ref(),copy(initial),spend(30,receipt),receipt).then(()=>null,e=>e);
    assert.equal(failure.code,'conflict');assert.deepEqual(copy(failure.remote),server.state);
    assert.equal(server.state.tickets.length,0);assert.equal(server.applied,0);assert.equal(a.sync.hasPending,false);
    assert.equal(a.storage.getItem('chain:pending'),null);assert.deepEqual(JSON.parse(a.storage.getItem('chain:sync')).base,server.state);
  }
});

test('missing remote preserves an existing legacy balance and practice added since boot', async()=>{
  const initial=chain(120),server=new Server(undefined),a=device('chain',initial),local=copy(initial);earn(local,30);
  assert.equal(a.sync.reconcile(local,undefined).bank,150);
  const saved=await a.sync.save(server.ref(),local);
  assert.equal(saved.bank,150);assert.equal(saved.days[day].earned,30);
});

test('first reconcile chooses a legacy seed and adds only practice since the boot baseline', async()=>{
  const initial={...chain(50),updatedAt:10},remote={...chain(100),updatedAt:20},server=new Server(remote),a=device('chain',initial),local=copy(initial);earn(local,30);
  const desired=a.sync.reconcile(local,remote);assert.equal(desired.bank,130);
  const saved=await a.sync.save(server.ref(),desired);assert.equal(saved.bank,130);assert.equal(saved.days[day].earned,30);
});

test('pending transaction retry returns its original receipt and never makes a second debit', async()=>{
  const initial=chain(100),server=new Server(initial),storage=memoryStorage(),a=device('chain',initial,storage),local=copy(initial),receipt={id:'original-ticket',at:1,minutes:30};
  server.loseResponses=1;let changes=0;
  await assert.rejects(a.sync.transact(server.ref(),local,state=>{changes++;return spend(30,receipt)(state);},receipt),{code:'unavailable'});
  assert.equal(local.bank,100,'transaction is not shown before ACK');assert.equal(server.state.bank,70);
  const b=device('chain',copy(server.state)),right=copy(server.state);earn(right,15);await b.sync.save(server.ref(),right);
  const reloaded=device('chain',local,storage);
  const saved=await reloaded.sync.transact(server.ref(),local,()=>{changes++;throw new Error('must not start another transaction');},{id:'new-ticket'});
  assert.equal(changes,1);assert.equal(saved.result.id,'original-ticket');assert.equal(saved.state.bank,85);
  assert.equal(saved.state.tickets.length,1);assert.equal(saved.state.days[day].redeemed,30);assert.equal(reloaded.sync.hasPending,false);
});

test('save recovery of an unshown transaction preserves later practice without crediting back the spend', async()=>{
  const initial=chain(100),server=new Server(initial),a=device('chain',initial),local=copy(initial),receipt={id:'ticket',at:1,minutes:30};
  server.loseResponses=1;await assert.rejects(a.sync.transact(server.ref(),local,spend(30,receipt),receipt),{code:'unavailable'});
  earn(local,15);
  const saved=await a.sync.save(server.ref(),local);
  assert.equal(saved.bank,85);assert.equal(saved.days[day].earned,15);assert.equal(saved.days[day].redeemed,30);assert.equal(saved.tickets.length,1);
});

test('persistent contention has a finite retry bound and preserves the pending mutation', async()=>{
  const initial=chain(0),server=new Server(initial),a=device('chain',initial),local=copy(initial);earn(local,30);
  server.beforeCommit=async()=>{const remote=copy(server.state);earn(remote,1);server.write(remote);};
  await assert.rejects(a.sync.save(server.ref(),local),{code:'unavailable'});
  assert.equal(server.commits,8);assert.equal(a.sync.hasPending,true);assert.equal(server.applied,0);
  server.beforeCommit=null;const saved=await a.sync.save(server.ref(),local);
  assert.equal(saved.bank,38);assert.equal(saved.days[day].earned,38);assert.equal(server.applied,1);
});

test('shared explicit transaction IDs make a once-only legacy import idempotent across devices', async()=>{
  const initial=chain(0),server=new Server(initial),a=device('chain',initial),b=device('chain',initial);
  const migrate=state=>{if(!state.merged.includes('legacy')){state.bank+=60;state.merged.push('legacy');}return state;};
  await a.sync.transact(server.ref(),copy(initial),migrate,{source:'legacy'},{mutation:'migrate-account-game-v2'});
  const saved=await b.sync.transact(server.ref(),copy(initial),migrate,{source:'legacy'},{mutation:'migrate-account-game-v2'});
  assert.equal(saved.state.bank,60);assert.equal(saved.state.merged.length,1);assert.equal(server.applied,1);
  await assert.rejects(b.sync.transact(server.ref(),copy(saved.state),migrate,{}, {mutation:'bad id'}),{code:'invalid_argument'});
  await assert.rejects(b.sync.transact(server.ref(),copy(saved.state),migrate,{}, {mutation:'é'}),{code:'invalid_argument'});
});

test('transaction validation rejects an already invalid balance or daily cap before PUT', async()=>{
  for(const scenario of ['bank','cap']){
    const initial=chain(scenario==='bank'?10:100),server=new Server(initial),a=device('chain',initial);
    if(scenario==='cap')initial.days[day]={redeemed:40};
    server.write(initial);
    const receipt={id:'invalid-ticket',minutes:30,at:1};
    const change=state=>{state.bank-=30;state.days[day]??={redeemed:0};state.days[day].redeemed+=30;state.tickets.push(receipt);return state;};
    await assert.rejects(a.sync.transact(server.ref(),copy(initial),change,receipt),{code:'conflict'});
    assert.equal(server.applied,0);assert.equal(server.state.tickets.length,0);assert.equal(a.sync.hasPending,false);
  }
});

test('a pending record must be durable before any commit can reach the server', async()=>{
  const initial=chain(0),server=new Server(initial),storage=memoryStorage();
  const write=storage.setItem;storage.setItem=(key,value)=>{if(key.endsWith(':pending'))throw new Error('quota');write(key,value);};
  const a=device('chain',initial,storage),local=copy(initial);earn(local,30);
  await assert.rejects(a.sync.save(server.ref(),local),{code:'unavailable'});
  assert.equal(server.commits,0);assert.equal(server.applied,0);assert.equal(server.state.bank,0);
});

test('pending-storage failure preserves the common baseline for retry and reload', async()=>{
  for(const reload of [false,true]){
    const initial=chain(0),server=new Server(initial),storage=memoryStorage(),a=device('chain',initial,storage),local=copy(initial);
    a.sync.reconcile(local,initial);earn(local,30);const remote=copy(initial);earn(remote,45);server.write(remote);
    const write=storage.setItem;let blocked=true;
    storage.setItem=(key,value)=>{if(blocked&&key.endsWith(':pending'))throw new Error('quota');write(key,value);};
    await assert.rejects(a.sync.save(server.ref(),local),{code:'unavailable'});
    assert.equal(server.commits,0);assert.equal(JSON.parse(storage.getItem('chain:sync')).base.bank,0);
    blocked=false;const retry=reload?device('chain',local,storage):a;
    const saved=await retry.sync.save(server.ref(),local);
    assert.equal(saved.bank,75,reload?'reload':'in-memory retry');assert.equal(saved.days[day].earned,75);
  }
});

test('metadata-storage failure does not advance the in-memory reconcile baseline', async()=>{
  const initial=chain(0),server=new Server(initial),storage=memoryStorage(),a=device('chain',initial,storage),local=copy(initial);
  a.sync.reconcile(local,initial);earn(local,30);const remote=copy(initial);earn(remote,45);server.write(remote);
  const write=storage.setItem;let blocked=true;
  storage.setItem=(key,value)=>{if(blocked&&key.endsWith(':sync'))throw new Error('quota');write(key,value);};
  assert.throws(()=>a.sync.reconcile(local,remote),{code:'unavailable'});
  blocked=false;const saved=await a.sync.save(server.ref(),local);
  assert.equal(saved.bank,75);assert.equal(saved.days[day].earned,75);
});

test('explicit mutation IDs use the same alphabet and length limits as the server', async()=>{
  const initial=chain(0),server=new Server(initial),a=device('chain',initial);
  for(const mutation of ['shortid','bad/id:123','bad!id:123','x'.repeat(129),12345678]){
    await assert.rejects(a.sync.transact(server.ref(),copy(initial),s=>s,{}, {mutation}),{code:'invalid_argument'});
  }
  for(const mutation of ['aB09._:-','x'.repeat(128)]){
    const saved=await a.sync.transact(server.ref(),copy(initial),s=>s,{}, {mutation});
    assert.equal(saved.state.bank,0);assert.ok(server.mutations.has(mutation));
  }
});
