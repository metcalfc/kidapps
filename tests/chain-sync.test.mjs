import test from 'node:test';
import assert from 'node:assert/strict';
import { loadChain } from './chain-harness.mjs';

const KEY='chain-reaction:v2';
const copy=value=>value===undefined?undefined:JSON.parse(JSON.stringify(value));
const read=(app,expression)=>JSON.parse(app.evaluate(`JSON.stringify(${expression})`));
const failure=code=>Object.assign(new Error(code),{code});
const initial=bank=>({v:1,updatedAt:0,bank,bestChain:0,days:{},facts:{},tickets:[],merged:[],settings:{tries:100,weekdayCap:45,weekendCap:90,sound:false,wk90:true}});
const deferred=()=>{let resolve;const promise=new Promise(done=>resolve=done);return {promise,resolve};};

// Models the server's atomic ETag check and mutation replay. Only transport is
// substituted: app handlers, merge rules and durable pending writes run unchanged.
class CASServer {
  constructor(state) { this.state=copy(state);this.version=state===undefined?0:1;this.mutations=new Set();this.commits=[];this.applied=0; }
  snapshot() { const data=copy(this.state);return {exists:data!==undefined,data:()=>copy(data),metadata:{etag:this.state===undefined?'*':`v${this.version}`,hasPendingWrites:false}}; }
  write(state) { this.state=copy(state);this.version++; }
  ref() { return {
    get:async()=>{if(this.getError)throw failure(this.getError);return this.snapshot();},
    commit:async(candidate,options)=>{
      this.commits.push({...copy(options),candidate:copy(candidate)});
      if(this.mutations.has(options.mutation))return this.snapshot();
      if(this.beforeCommit)await this.beforeCommit(candidate,options);
      // The second check represents acquiring the transaction lock after a
      // concurrent request with this same mutation has completed.
      if(this.mutations.has(options.mutation))return this.snapshot();
      if(this.commitError)throw failure(this.commitError);
      const expected=this.state===undefined?'*':`v${this.version}`;
      if(options.etag!==expected)throw failure('conflict');
      this.write(candidate);this.mutations.add(options.mutation);this.applied++;
      if(this.loseResponseWhen?.(candidate)){this.loseResponseWhen=null;throw failure('unavailable');}
      return this.snapshot();
    },
    onSnapshot:callback=>{(this.watchers??=new Set()).add(callback);return()=>this.watchers.delete(callback);},
  }; }
}

function appFor(server,state=server.state,{legacy,storageValues={}}={}) {
  const oldRef={get:async()=>({exists:!!legacy,data:()=>copy(legacy)}),update:async()=>{}};
  const db={doc:path=>{assert.ok(path.endsWith('/game'));return oldRef;}};
  return loadChain({storageValues:{[KEY]:JSON.stringify(state),...storageValues},globals:{
    KidSyncStore:{doc:(app,code,doc)=>{assert.equal(app,'chain');assert.equal(code,'OTTER-4821');assert.equal(doc,'game-v2');return server.ref();}},
    KidSave:{code:()=> 'OTTER-4821'},
    claude:{use:async kind=>kind==='db'?db:{id:async()=> 'OTTER-4821'}},
  }});
}
async function connected(server,state=server.state,options) {
  const app=appFor(server,state,options);await app.evaluate('connect()');await app.settle();return app;
}
function cash(app,minutes=5) {
  app.element('shopBtn').click();
  const choice=app.element('choices').querySelectorAll('button').find(button=>button.firstChild.textContent===String(minutes));
  assert.ok(choice&&!choice.disabled,`${minutes} minutes must be selectable`);choice.click();
  app.element('redeemBtn').click();app.element('redeemBtn').click();
}
function answer(app,a,b) {
  app.evaluate(`cur={a:${a},b:${b}};typed='';locked=false;t0=performance.now();$('qa').textContent=cur.a;$('qb').textContent=cur.b;renderAns('');`);
  for(const digit of String(a*b)){
    const key=app.element('pad').querySelectorAll('button').find(button=>button.dataset.k===digit);
    app.element('pad').dispatchEvent({type:'pointerdown',target:key});
  }
}
function earn(state,seconds,day) {
  state.bank+=seconds;
  const d=state.days[day]??={tries:0,bonusTries:0,correct:0,earned:0,redeemed:0,bestChain:0,lightning:0};
  d.tries++;d.correct++;d.earned+=seconds;
  state.facts['2x2']={n:1,ok:1,ms:1000};
}

test('cash-in waits for the server before showing a ticket or changing the displayed bank',async()=>{
  const server=new CASServer(initial(600)),app=await connected(server),gate=deferred();let entered=false;
  server.beforeCommit=async candidate=>{if(candidate.tickets.length){entered=true;await gate.promise;}};
  cash(app);await app.settle();
  try{
    assert.equal(entered,true);assert.equal(app.element('ticket').hidden,true);
    assert.equal(app.evaluate('S.bank'),600);assert.equal(app.evaluate('today().redeemed'),0);
    assert.equal(app.element('redeemBtn').disabled,true);assert.match(app.element('redeemBtn').textContent,/Confirming/);
  }finally{gate.resolve();}
  await app.settle();
  assert.equal(app.element('ticket').hidden,false);assert.equal(app.element('tMin').textContent,'5');
  assert.equal(app.evaluate('S.bank'),300);assert.equal(server.state.bank,300);
  assert.equal(server.state.tickets.length,1);assert.equal(app.evaluate('today().redeemed'),5);
});

test('offline and missing-remote cash-in attempts issue no ticket and spend no local credit',async()=>{
  const server=new CASServer(initial(600)),app=await connected(server);server.getError='unavailable';
  cash(app);await app.settle();
  assert.equal(app.element('ticket').hidden,true);assert.equal(app.evaluate('S.bank'),600);
  assert.equal(server.state.bank,600);assert.equal(server.state.tickets.length,0);
  assert.match(app.element('sHint').textContent,/Could not confirm/);
  const disconnected=loadChain({storageValues:{[KEY]:JSON.stringify(initial(600))}});
  await disconnected.evaluate('connect()');cash(disconnected);await disconnected.settle();
  assert.equal(disconnected.element('ticket').hidden,true);assert.equal(disconnected.evaluate('S.bank'),600);
  assert.equal(disconnected.evaluate('S.tickets.length'),0);
});

test('lost cash-in acknowledgement retries the same debit and receipt exactly once',async()=>{
  const server=new CASServer(initial(600)),app=await connected(server);
  server.loseResponseWhen=candidate=>candidate.tickets.length>0;
  cash(app);await app.settle();
  assert.equal(app.element('ticket').hidden,true);assert.equal(app.evaluate('S.bank'),600);
  assert.equal(server.state.bank,300);assert.equal(server.state.tickets.length,1);
  const receiptID=server.state.tickets[0].id;
  const pending=read(app,`JSON.parse(localStorage.getItem('${KEY}:pending'))`);
  assert.equal(pending.kind,'transaction');
  app.element('redeemBtn').click();app.element('redeemBtn').click();await app.settle();
  assert.equal(app.element('ticket').hidden,false);assert.equal(app.evaluate('S.bank'),300);
  assert.equal(server.state.bank,300);assert.equal(server.state.tickets.length,1);
  assert.equal(server.state.tickets[0].id,receiptID);
  assert.equal(app.evaluate('S.tickets[0].id'),receiptID);
  assert.equal(app.evaluate('today().redeemed'),5);
  assert.equal(server.commits.filter(write=>write.mutation===pending.mutation).length,2);
  assert.equal(app.evaluate('sync.hasPending'),false);
});

test('a reset racing with cash-in cannot display a receipt removed by the authoritative reset',async()=>{
  const server=new CASServer(initial(600)),app=await connected(server);let reset=false;
  server.beforeCommit=async candidate=>{
    if(!reset&&candidate.tickets.length){reset=true;const state=initial(0);state.reset={at:Date.UTC(2026,9,28),id:'remote-reset'};server.write(state);}
  };
  cash(app);await app.settle();
  assert.equal(reset,true);assert.equal(app.element('ticket').hidden,true);
  assert.equal(app.evaluate('S.bank'),0);assert.equal(server.state.bank,0);
  assert.equal(server.state.tickets.length,0);assert.equal(app.evaluate('S.tickets.length'),0);
  assert.match(app.element('sHint').textContent,/save changed/);
});

test('two app devices importing the same old account balance share one mutation and add it once',async()=>{
  const server=new CASServer(initial(0)),legacy=initial(600),a=appFor(server,initial(0),{legacy}),b=appFor(server,initial(0),{legacy}),gate=deferred();let entered=0;
  server.beforeCommit=async candidate=>{if(candidate.merged.includes('db:game')){entered++;await gate.promise;}};
  const left=a.evaluate('connect()'),right=b.evaluate('connect()');await a.settle();await b.settle();
  try{assert.equal(entered,2);}finally{gate.resolve();}
  await Promise.all([left,right]);await a.settle();await b.settle();
  assert.equal(server.state.bank,600);assert.deepEqual(server.state.merged,['db:game']);
  const imports=server.commits.filter(write=>write.candidate.merged.includes('db:game'));
  assert.equal(imports.length,2);assert.equal(imports[0].mutation,imports[1].mutation);
  assert.equal(server.applied,1);assert.equal(a.evaluate('S.bank'),600);assert.equal(b.evaluate('S.bank'),600);
});

test('a cash-in blocked by an ongoing import leaves the import write lock intact',async()=>{
  const server=new CASServer(initial(600)),legacy=initial(300),app=appFor(server,initial(600),{legacy}),gate=deferred();let entered=false;
  server.beforeCommit=async candidate=>{if(candidate.merged.includes('db:game')){entered=true;await gate.promise;}};
  const connecting=app.evaluate('connect()');await app.settle();
  assert.equal(entered,true);assert.equal(app.evaluate('writing'),true);
  app.advance(4000);cash(app);await app.settle();
  try{
    assert.equal(app.element('ticket').hidden,true);assert.equal(app.evaluate('writing'),true);
    assert.equal(app.evaluate('cashing'),false);assert.match(app.element('sHint').textContent,/still syncing/);
  }finally{gate.resolve();}
  await connecting;await app.settle();
  assert.equal(server.state.bank,900);assert.equal(server.state.tickets.length,0);assert.equal(app.evaluate('writing'),false);
});

test('legacy local-save discovery excludes durable sync and pending metadata',()=>{
  const app=loadChain({storageValues:{
    [KEY]:JSON.stringify(initial(0)),
    'chain-reaction:v1':JSON.stringify(initial(60)),
    [KEY+':pending']:JSON.stringify({kind:'transaction'}),
    [KEY+':sync']:JSON.stringify({base:initial(0),migrated:true}),
    [KEY+':pending:merged']:'archived',
    'chain-reaction:v0:merged':'archived',
    unrelated:'value',
  }});
  assert.deepEqual(read(app,'legacyLocalKeys()'),['chain-reaction:v1']);
});

test('app flush preserves practice completed in flight and earnings from another device',async()=>{
  const server=new CASServer(initial(0)),app=await connected(server),gate=deferred();let entered=false;
  app.element('playBtn').click();await app.settle();answer(app,7,8);
  const day=app.evaluate('todayKey()');
  server.beforeCommit=async candidate=>{if(!entered&&candidate.bank>0){entered=true;await gate.promise;}};
  const saving=app.evaluate('flush()');await app.settle();assert.equal(entered,true);
  app.advance(170);answer(app,6,9);
  const other=copy(server.state);earn(other,60,day);server.write(other);
  gate.resolve();await saving;await app.settle();
  assert.equal(app.evaluate('S.bank'),108);
  app.advance(100);await app.settle();
  assert.equal(server.state.bank,108);assert.equal(server.state.days[day].earned,108);
  assert.equal(server.state.days[day].tries,3);assert.equal(server.state.days[day].correct,3);
  assert.equal(server.state.facts['7x8'].ok,1);assert.equal(server.state.facts['6x9'].ok,1);assert.equal(server.state.facts['2x2'].ok,1);
  assert.equal(app.evaluate('dirty'),false);
});
