import test from 'node:test';
import assert from 'node:assert/strict';
import {loadDm} from './dm-harness.mjs';
import {indexedDB} from './indexeddb-harness.mjs';

const clone = value => JSON.parse(JSON.stringify(value));
const read = (app, value) => JSON.parse(app.evaluate(`JSON.stringify(${value})`));
const settle = async () => { for(let i=0;i<60;i++) await Promise.resolve(); };
const map = (id, text=id) => ({id,v:2,size:'small',title:text,intro:'',rev:1,tested:0,cells:'SE'+'.'.repeat(106),ground:'s'.repeat(108),walls:'.'.repeat(237),things:{}});
function storage(data) {
  const values = new Map(Object.entries(data).map(([k,v])=>[k,JSON.stringify(v)]));
  return {getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,String(v)),removeItem:k=>values.delete(k)};
}
function device(maps=[]) {
  return loadDm({localStorage:storage({'pda-forge':{dungeons:maps,board:[],played:{},stats:{right:0,tries:0,commissions:0}},'pda-updatedAt':200,'pda-syncedAt':100})});
}
class Server {
  constructor(state){this.state=state&&clone(state);this.version=1;this.mutations=new Set();this.lose=false;this.commits=0;this.watchers=[];}
  snapshot(){const state=this.state&&clone(this.state);return {exists:!!state,data:()=>state,metadata:{hasPendingWrites:false,etag:state?`v${this.version}`:'*'}};}
  ref(){return {get:async()=>this.snapshot(),onSnapshot:cb=>{this.watchers.push(cb);return ()=>{};},commit:async(candidate,options)=>{
    if(this.mutations.has(options.mutation))return this.snapshot();
    if(options.etag!==(this.state?`v${this.version}`:'*'))throw Object.assign(new Error('stale'),{code:'conflict'});
    if(this.gate){const gate=this.gate;this.gate=null;await gate;}
    this.state=clone(candidate);this.version++;this.commits++;this.mutations.add(options.mutation);
    if(this.lose){this.lose=false;throw Object.assign(new Error('lost ACK'),{code:'unavailable'});}
    return this.snapshot();
  }};}
}

test('real DM connect preserves local-only and server-only maps even when practice totals tie',async()=>{
  const app=device([map('local')]), remote=read(app,'snapshotLocal()');remote.forge.dungeons=[map('remote')];remote.updatedAt=300;
  const server=new Server(remote);app.setRemote(server.ref());await app.evaluate('cloudConnect()');
  assert.deepEqual(read(app,'forge.dungeons.map(d=>d.id)').sort(),['local','remote']);
  assert.deepEqual(server.state.forge.dungeons.map(d=>d.id).sort(),['local','remote']);
  assert.equal(app.evaluate('cloud.state'),'ok');
  assert.deepEqual(JSON.parse(app.evaluate("localStorage.getItem('pda-forge')")).dungeons.map(d=>d.id).sort(),['local','remote']);
});

test('separate DM devices with concurrent saves preserve both authored versions through CAS',async()=>{
  const a=device([map('same')]), initial=read(a,'snapshotLocal()'), server=new Server(initial), b=device([map('same')]);
  a.setRemote(server.ref());b.setRemote(server.ref());await a.evaluate('cloudConnect()');await b.evaluate('cloudConnect()');const initialCommits=server.commits;
  a.evaluate("forge.dungeons[0].title='Left version';forge.dungeons[0].rev++;forgeSave();");
  b.evaluate("forge.dungeons[0].title='Right version';forge.dungeons[0].rev++;forgeSave();");
  await Promise.all([a.evaluate('cloudFlush()'),b.evaluate('cloudFlush()')]);
  const titles=server.state.forge.dungeons.map(d=>d.title);
  assert.ok(titles.some(t=>t.startsWith('Left version')));assert.ok(titles.some(t=>t.startsWith('Right version')));
  assert.equal(titles.length,2);assert.equal(server.state.forge.dungeons.filter(d=>d.share).length,0);
});

test('lost DM save acknowledgment is retried once without duplicate maps or XP',async()=>{
  const app=device(), server=new Server(read(app,'snapshotLocal()'));app.setRemote(server.ref());await app.evaluate('cloudConnect()');
  app.evaluate("forge.dungeons.push({id:'offline-map',title:'Keep me',v:2,size:'small',rev:1,things:{},cells:'SE'+'.'.repeat(106),ground:'s'.repeat(108),walls:'.'.repeat(237)});progress.xp+=5;forgeSave();");
  server.lose=true;await app.evaluate('cloudFlush()');
  assert.equal(app.evaluate('dmSync.hasPending'),true);const count=server.commits;
  await app.evaluate('cloudFlush()');
  assert.equal(app.evaluate('dmSync.hasPending'),false);assert.equal(server.commits,count);
  assert.equal(server.state.progress.xp,5);assert.equal(server.state.forge.dungeons.length,1);
});

test('an in-flight backup preserves later construction and practice without replacing unchanged editor controls',async()=>{
  const app=device([map('build')]), server=new Server(read(app,'snapshotLocal()'));app.setRemote(server.ref());await app.evaluate('cloudConnect()');
  app.evaluate("show('forge');forgeEdit('build');ed.tool='t';renderInspect();globalThis.oldInspect=$('fe-inspect').firstChild;progress.xp+=5;save('pda-progress',progress);");
  let release;server.gate=new Promise(resolve=>{release=resolve;});const saving=app.evaluate('cloudFlush()');await settle();
  app.evaluate("forge.dungeons[0].intro='Written during upload';forge.dungeons[0].rev++;progress.xp+=5;forgeSave();");
  release();await saving;
  assert.equal(app.evaluate('forge.dungeons[0].intro'),'Written during upload');assert.equal(app.evaluate('progress.xp'),10);
  assert.equal(app.evaluate("$('fe-inspect').firstChild===oldInspect"),true,'an unchanged Forge acknowledgment keeps live controls');
  await app.evaluate('cloudFlush()');assert.equal(server.state.forge.dungeons[0].intro,'Written during upload');assert.equal(server.state.progress.xp,10);
});

test('sync during a test credits the canonical unchanged map, while changed maps must be retested',async()=>{
  for(const changed of [false,true]){
    const app=device([map('play')]);app.evaluate("show('forge');forgePlay(forge.dungeons[0],'test');");
    const remote=read(app,'snapshotLocal()');if(changed){remote.forge.dungeons[0].title='Changed during play';remote.forge.dungeons[0].rev++;}
    app.evaluate(`applyRemote(${JSON.stringify(remote)})`);await app.evaluate('fpMove(1)');
    assert.equal(app.evaluate('forge.dungeons[0].tested'),changed?0:1);
    const saved=JSON.parse(app.evaluate("localStorage.getItem('pda-forge')"));assert.equal(saved.dungeons[0].tested,changed?0:1);
    assert.match(app.element('fp-enc').textContent,changed?/latest version/:/share it now/);
  }
});

test('an acknowledgment waits for an active drawing stroke before merging remote maps',async()=>{
  for(const finish of ['feCancel()','feUp()']){
    const app=device([map('build')]), server=new Server(read(app,'snapshotLocal()'));app.setRemote(server.ref());await app.evaluate('cloudConnect()');
    app.evaluate("show('forge');forgeEdit('build');ed.tool='$';ed.size='s';progress.xp+=5;save('pda-progress',progress);");
    server.state.forge.dungeons.push(map('from-tablet'));server.version++;
    let release;server.gate=new Promise(resolve=>{release=resolve;});const saving=app.evaluate('cloudFlush()');await settle();
    app.evaluate('feDown({fx:2.5,fy:.5});');release();await saving;
    assert.equal(app.evaluate('!!cloud.deferred'),true);
    assert.equal(app.evaluate('ed.M.cells[2]'),'$');
    assert.equal(app.evaluate('forge.dungeons.length'),1,'a remote ACK must not replace the active stroke');
    app.evaluate(finish);app.evaluate('cloudFinish()');await settle();
    assert.deepEqual(read(app,'forge.dungeons.map(d=>d.id)').sort(),['build','from-tablet']);
    assert.equal(app.evaluate('ed.M.cells[2]'),finish==='feUp()'?'$':'.');
    assert.equal(app.evaluate('ed.d.cells[2]'),finish==='feUp()'?'$':'.');
    assert.equal(app.evaluate('cloud.deferred'),null);
  }
});

test('adopting a remote authored change clears old undo history without undoing the remote work',()=>{
  const app=device([map('build')]);
  app.evaluate("show('forge');forgeEdit('build');ed.tool='$';ed.size='s';feDown({fx:2.5,fy:.5});feUp();");
  assert.equal(app.evaluate('ed.undo.length'),1);
  const base=read(app,'snapshotLocal()'),remote=clone(base);
  remote.forge.dungeons[0].cells=remote.forge.dungeons[0].cells.slice(0,3)+'s'+remote.forge.dungeons[0].cells.slice(4);
  remote.forge.dungeons[0].things[3]={text:'The tablet wrote this clue.'};remote.forge.dungeons[0].rev++;
  app.evaluate(`cloudAdopt(${JSON.stringify(base)},${JSON.stringify(remote)})`);
  assert.equal(app.evaluate('ed.undo.length'),0);app.evaluate('edUndo()');
  assert.equal(app.evaluate('ed.d.cells.slice(2,4)'),'$s');
  assert.equal(app.evaluate('ed.d.things[3].text'),'The tablet wrote this clue.');
});

test('reloading before a deferred acknowledgment is adopted preserves received remote maps',async()=>{
  const app=device([map('build')]), server=new Server(read(app,'snapshotLocal()'));app.setRemote(server.ref());await app.evaluate('cloudConnect()');
  app.evaluate("show('forge');forgeEdit('build');ed.tool='$';progress.xp+=5;save('pda-progress',progress);");
  server.state.forge.dungeons.push(map('tablet-map'));server.version++;
  let release;server.gate=new Promise(resolve=>{release=resolve;});const saving=app.evaluate('cloudFlush()');await settle();
  app.evaluate('feDown({fx:2.5,fy:.5});');release();await saving;
  assert.equal(app.evaluate('!!cloud.deferred'),true);
  const reloaded=loadDm({localStorage:app.evaluate('localStorage')});reloaded.setRemote(server.ref());await reloaded.evaluate('cloudConnect()');
  assert.deepEqual(read(reloaded,'forge.dungeons.map(d=>d.id)').sort(),['build','tablet-map']);
  assert.deepEqual(server.state.forge.dungeons.map(d=>d.id).sort(),['build','tablet-map']);
  assert.equal(reloaded.evaluate('progress.xp'),5);
  await reloaded.evaluate('cloudFlush()');assert.equal(server.state.progress.xp,5);
});

test('a repeated reload after successful adoption cannot add received practice twice',async()=>{
  const app=device([map('build')]), remote=read(app,'snapshotLocal()');remote.progress.xp=10;
  const server=new Server(remote);app.setRemote(server.ref());await app.evaluate('cloudConnect()');
  const shared=app.evaluate('localStorage');
  for(let i=0;i<3;i++){
    const reloaded=loadDm({localStorage:shared});reloaded.setRemote(server.ref());await reloaded.evaluate('cloudConnect()');
    assert.equal(reloaded.evaluate('progress.xp'),10);assert.equal(server.state.progress.xp,10);
  }
});

test('remote title and story changes refresh their controls when adopting an editor map',()=>{
  const app=device([map('build')]);app.evaluate("show('forge');forgeEdit('build');");
  const remote=read(app,'snapshotLocal()');remote.forge.dungeons[0].title='Tablet title';remote.forge.dungeons[0].intro='A new tablet clue.';
  remote.forge.dungeons[0].rev++;app.evaluate(`applyRemote(${JSON.stringify(remote)})`);
  assert.equal(app.element('fe-title').value,'Tablet title');assert.equal(app.element('fe-intro').value,'A new tablet clue.');
});


test('partial component adoption and subsequent normal edits survive reload without crediting received XP twice',async()=>{
  for(const failedKey of ['pda-forge','pda-settings','pda-progress','pda-tracker','pda-save:adopted']){
    for(const edit of [false,true]){
      const underlying=storage({}), backend=indexedDB();let fail=false;
      const shared={...underlying,setItem(key,value){if(fail&&key===failedKey)throw new Error('quota');underlying.setItem(key,value);}};
      const app=loadDm({localStorage:shared,indexedDB:backend.factory}),remote=read(app,'snapshotLocal()');
      remote.progress.xp=10;remote.forge.dungeons=[map('tablet')];remote.tracker.round=2;
      const server=new Server(remote);app.setRemote(server.ref());fail=true;await app.evaluate('cloudConnect()');
      assert.equal(app.evaluate('progress.xp'),10);
      if(edit){fail=false;app.evaluate("progress.xp+=5;save('pda-progress',progress);forge.dungeons[0].intro='Kept after partial adoption';forgeSave();");}
      fail=false;
      for(let i=0;i<3;i++){
        const reloaded=loadDm({localStorage:shared,indexedDB:backend.factory});reloaded.setRemote(server.ref());await reloaded.evaluate('cloudConnect()');
        assert.equal(reloaded.evaluate('progress.xp'),edit?15:10,failedKey);
        assert.equal(server.state.progress.xp,edit?15:10,failedKey);
        assert.equal(reloaded.evaluate('forge.dungeons.length'),1,`${failedKey} edit=${edit} reload=${i}`);
        if(edit)assert.equal(reloaded.evaluate('forge.dungeons[0].intro'),'Kept after partial adoption');
      }
    }
  }
});

test('failed backups retain their intended retry delay with one active flush timer',async()=>{
  for(const [code,min,max] of [['unavailable',4000,7000],['resource_exhausted',4000,7000],['internal',30000,33000]]){
    let next=0;const scheduled=new Map(),timers={setTimeout(callback,delay){const id=++next;scheduled.set(id,{callback,delay});return id;},clearTimeout(id){scheduled.delete(id);}};
    const app=loadDm({timers}),server=new Server(read(app,'snapshotLocal()'));app.setRemote(server.ref());await app.evaluate('cloudConnect()');
    app.evaluate("progress.xp+=5;save('pda-progress',progress);");
    const broken=server.ref();broken.commit=async()=>{throw Object.assign(new Error('retry'),{code});};app.setRemote(broken);app.evaluate('cloud.ref=KidSyncStore.doc()');
    await app.evaluate('cloudFlush()');
    const flushTimers=[...scheduled.values()].filter(value=>value.callback.name==='cloudFlush');
    assert.equal(flushTimers.length,1);assert.ok(flushTimers[0].delay>=min&&flushTimers[0].delay<max,code);
  }
});

test('concurrent DM connection attempts open one journal controller',async()=>{
  const backend=indexedDB(),app=loadDm({indexedDB:backend.factory});
  await Promise.all([app.evaluate("ensureDmSync('OTTER-4821')"),app.evaluate("ensureDmSync('OTTER-4821')")]);
  assert.equal(app.evaluate('!!dmSync'),true);assert.equal(app.evaluate('dmSyncOpening'),null);
});

test('same-account DM tabs keep both practice deltas when a lost ACK races a stale metadata flush',async()=>{
  const shared=storage({}),backend=indexedDB(),a=loadDm({localStorage:shared,indexedDB:backend.factory}),b=loadDm({localStorage:shared,indexedDB:backend.factory});
  const initial=read(a,'snapshotLocal()'),server=new Server(initial);a.setRemote(server.ref());b.setRemote(server.ref());
  await a.evaluate('cloudConnect()');await b.evaluate('cloudConnect()');const initialCommits=server.commits;
  a.evaluate("progress.xp+=5;save('pda-progress',progress);");server.lose=true;await a.evaluate('cloudFlush()');
  const pending=read(a,"JSON.parse(dmStorage.getItem('pda-save:pending'))").mutation;
  await b.evaluate(`dmSync.reconcile(${JSON.stringify(initial)},${JSON.stringify(initial)});dmSync.flush()`);
  assert.ok(Object.values(backend.read().writers).some(slot=>slot.entries['pda-save:pending']&&JSON.parse(slot.entries['pda-save:pending']).mutation===pending));
  b.evaluate("progress.xp+=7;save('pda-progress',progress);");await b.evaluate('cloudFlush()');await a.evaluate('cloudFlush()');
  assert.equal(server.state.progress.xp,12);assert.equal(a.evaluate('progress.xp'),12);assert.equal(b.evaluate('progress.xp'),12);assert.equal(server.commits,initialCommits+2);
  const reloaded=loadDm({localStorage:shared,indexedDB:backend.factory});reloaded.setRemote(server.ref());await reloaded.evaluate('cloudConnect()');
  assert.equal(reloaded.evaluate('progress.xp'),12);assert.equal(server.state.progress.xp,12);assert.equal(server.commits,initialCommits+2);
  assert.ok(Object.values(backend.read().writers).every(slot=>!slot.entries['pda-save:pending']));
});

test('a fresh DM document recovers a closed tab’s pending save while preserving the latest local writer’s practice',async()=>{
  const shared=storage({}),backend=indexedDB(),a=loadDm({localStorage:shared,indexedDB:backend.factory}),b=loadDm({localStorage:shared,indexedDB:backend.factory});
  const initial=read(a,'snapshotLocal()'),server=new Server(initial);a.setRemote(server.ref());b.setRemote(server.ref());await a.evaluate('cloudConnect()');await b.evaluate('cloudConnect()');const initialCommits=server.commits;
  a.evaluate("progress.xp+=5;save('pda-progress',progress);");
  const unavailable=server.ref();unavailable.commit=async()=>{throw Object.assign(new Error('offline'),{code:'unavailable'});};a.setRemote(unavailable);a.evaluate('cloud.ref=KidSyncStore.doc()');await a.evaluate('cloudFlush()');
  b.evaluate("progress.xp+=7;save('pda-progress',progress);");
  await b.evaluate(`dmSync.reconcile(${JSON.stringify(initial)},${JSON.stringify(initial)});dmSync.flush()`);
  // Both old documents and both session stores are abandoned.
  const recovered=loadDm({localStorage:shared,indexedDB:backend.factory});recovered.setRemote(server.ref());await recovered.evaluate('cloudConnect()');
  assert.equal(recovered.evaluate('progress.xp'),12);assert.equal(server.state.progress.xp,12);assert.equal(server.commits,initialCommits+2);
  assert.ok(Object.values(backend.read().writers).every(slot=>!slot.entries['pda-save:pending']));
});

test('recovery uses each component’s writer when tabs last saved different working components',async()=>{
  const shared=storage({}),backend=indexedDB(),a=loadDm({localStorage:shared,indexedDB:backend.factory}),b=loadDm({localStorage:shared,indexedDB:backend.factory});
  const server=new Server(read(a,'snapshotLocal()'));a.setRemote(server.ref());b.setRemote(server.ref());await a.evaluate('cloudConnect()');await b.evaluate('cloudConnect()');
  a.evaluate("forge.stats.right+=5;forge.stats.tries+=5;forgeSave();");server.lose=true;await a.evaluate('cloudFlush()');
  b.evaluate("progress.xp+=7;save('pda-progress',progress);");
  // The disk Forge belongs to A and the progress component belongs to B.
  const reloaded=loadDm({localStorage:shared,indexedDB:backend.factory});reloaded.setRemote(server.ref());await reloaded.evaluate('cloudConnect()');
  assert.equal(server.state.forge.stats.right,5);assert.equal(server.state.forge.stats.tries,5);assert.equal(server.state.progress.xp,7);
  assert.equal(reloaded.evaluate('forge.stats.right'),5);assert.equal(reloaded.evaluate('progress.xp'),7);
});


test('practice earned before a stale tab first connects uses its frozen boot baseline',async()=>{
  const shared=storage({'pda-progress':{xp:0,modules:{},bestStreak:0}}),backend=indexedDB();
  const a=loadDm({localStorage:shared,indexedDB:backend.factory}),b=loadDm({localStorage:shared,indexedDB:backend.factory}),server=new Server(read(a,'snapshotLocal()'));
  a.setRemote(server.ref());b.setRemote(server.ref());await a.evaluate('cloudConnect()');a.evaluate("progress.xp+=5;save('pda-progress',progress);");await a.evaluate('cloudFlush()');
  b.evaluate("progress.xp+=7;save('pda-progress',progress);");await b.evaluate('cloudConnect()');
  assert.equal(server.state.progress.xp,12);assert.equal(b.evaluate('progress.xp'),12);
});

test('recovering a pending progress writer preserves a different Forge writer’s full delta',async()=>{
  const shared=storage({}),backend=indexedDB(),a=loadDm({localStorage:shared,indexedDB:backend.factory}),b=loadDm({localStorage:shared,indexedDB:backend.factory});
  const server=new Server(read(a,'snapshotLocal()'));a.setRemote(server.ref());b.setRemote(server.ref());await a.evaluate('cloudConnect()');await b.evaluate('cloudConnect()');
  a.evaluate("progress.xp+=5;save('pda-progress',progress);forge.stats.right+=3;forge.stats.tries+=3;forgeSave();");server.lose=true;await a.evaluate('cloudFlush()');
  b.evaluate("forge.stats.right+=7;forge.stats.tries+=7;forgeSave();");
  const reloaded=loadDm({localStorage:shared,indexedDB:backend.factory});reloaded.setRemote(server.ref());await reloaded.evaluate('cloudConnect()');
  assert.equal(server.state.progress.xp,5);assert.equal(server.state.forge.stats.right,10);assert.equal(server.state.forge.stats.tries,10);
});

test('an aborted initial composite-baseline checkpoint retries initialization before any upload',async()=>{
  const shared=storage({}),backend=indexedDB(),a=loadDm({localStorage:shared,indexedDB:backend.factory}),b=loadDm({localStorage:shared,indexedDB:backend.factory});
  const server=new Server(read(a,'snapshotLocal()'));a.setRemote(server.ref());b.setRemote(server.ref());await a.evaluate('cloudConnect()');await b.evaluate('cloudConnect()');
  a.evaluate("progress.xp+=5;save('pda-progress',progress);forge.stats.right+=3;forge.stats.tries+=3;forgeSave();");await a.evaluate('cloudFlush()');
  b.evaluate("forge.stats.right+=7;forge.stats.tries+=7;forgeSave();");
  const reloaded=loadDm({localStorage:shared,indexedDB:backend.factory});reloaded.setRemote(server.ref());await reloaded.evaluate("ensureDmSync('OTTER-4821')");backend.failNextWrite=true;
  await reloaded.evaluate('cloudConnect()');assert.equal(reloaded.evaluate('cloud.ref'),null);const commits=server.commits;
  await reloaded.evaluate('cloudFlush()');assert.equal(server.commits,commits,'a failed initialization cannot upload using its rolled-back baseline');
  await reloaded.evaluate('cloudConnect()');assert.equal(server.state.forge.stats.right,10);assert.equal(server.state.progress.xp,5);
});


test('a component that failed its normal local write still receives the recovered pending practice once',async()=>{
  const underlying=storage({}),backend=indexedDB();let fail=false;
  const shared={...underlying,setItem(key,value){if(fail&&key==='pda-progress')throw new Error('quota');underlying.setItem(key,value);}};
  const app=loadDm({localStorage:shared,indexedDB:backend.factory}),server=new Server(read(app,'snapshotLocal()'));app.setRemote(server.ref());await app.evaluate('cloudConnect()');
  fail=true;app.evaluate("progress.xp+=5;save('pda-progress',progress);");server.lose=true;await app.evaluate('cloudFlush()');
  assert.equal(JSON.parse(shared.getItem('pda-progress')).xp,0);assert.equal(server.state.progress.xp,5);fail=false;
  const reloaded=loadDm({localStorage:shared,indexedDB:backend.factory});reloaded.setRemote(server.ref());await reloaded.evaluate('cloudConnect()');
  assert.equal(reloaded.evaluate('progress.xp'),5);assert.equal(server.state.progress.xp,5);
});

test('an older component adoption receipt remains a valid baseline after its original writer saves again',async()=>{
  const shared=storage({}),backend=indexedDB(),a=loadDm({localStorage:shared,indexedDB:backend.factory}),server=new Server(read(a,'snapshotLocal()'));
  a.setRemote(server.ref());await a.evaluate('cloudConnect()');
  const stale=loadDm({localStorage:shared,indexedDB:backend.factory});stale.setRemote(server.ref());
  a.evaluate("progress.xp+=5;save('pda-progress',progress);");await a.evaluate('cloudFlush()');
  await stale.evaluate('cloudConnect()');assert.equal(stale.evaluate('progress.xp'),5);assert.equal(server.state.progress.xp,5);
});

test('reloading after a merged adoption but before a pending write preserves its unsent local intent',async()=>{
  const shared=storage({'pda-progress':{xp:0,modules:{},bestStreak:0}}),backend=indexedDB(),a=loadDm({localStorage:shared,indexedDB:backend.factory}),server=new Server(read(a,'snapshotLocal()'));
  a.setRemote(server.ref());await a.evaluate('cloudConnect()');
  const b=loadDm({localStorage:shared,indexedDB:backend.factory});b.setRemote(server.ref());
  a.evaluate("progress.xp+=5;save('pda-progress',progress);");await a.evaluate('cloudFlush()');
  b.evaluate("progress.xp+=7;save('pda-progress',progress);");
  const ref=server.ref(),get=ref.get;let calls=0,release;const gate=new Promise(resolve=>{release=resolve;});ref.get=async()=>{if(++calls===2)await gate;return get();};b.setRemote(ref);
  const connecting=b.evaluate('cloudConnect()');await settle();assert.equal(b.evaluate('progress.xp'),12);assert.equal(b.evaluate('dmSync.hasPending'),false);
  const reloaded=loadDm({localStorage:shared,indexedDB:backend.factory});reloaded.setRemote(server.ref());await reloaded.evaluate('cloudConnect()');
  assert.equal(reloaded.evaluate('progress.xp'),12);assert.equal(server.state.progress.xp,12);release();await connecting;
});


test('an existing save code preserves a stale tab’s boot baseline before its first network connection',async()=>{
  const shared=storage({'pda-progress':{xp:0,modules:{},bestStreak:0}}),backend=indexedDB(),options={localStorage:shared,indexedDB:backend.factory,saveCode:'OTTER-4821'};
  const a=loadDm(options),b=loadDm(options);await Promise.all([a.evaluate('dmSyncOpening'),b.evaluate('dmSyncOpening')]);
  const server=new Server(read(a,'snapshotLocal()'));a.setRemote(server.ref());await a.evaluate('cloudConnect()');a.evaluate("progress.xp+=5;save('pda-progress',progress);");await a.evaluate('cloudFlush()');
  b.evaluate("progress.xp+=7;save('pda-progress',progress);");
  const reloaded=loadDm(options);await reloaded.evaluate('dmSyncOpening');reloaded.setRemote(server.ref());await reloaded.evaluate('cloudConnect()');
  assert.equal(server.state.progress.xp,12);assert.equal(reloaded.evaluate('progress.xp'),12);
});

test('working writes wait for the local baseline commit and failures are visible until retry',async()=>{
  const shared=storage({'pda-progress':{xp:0,modules:{},bestStreak:0}}),backend=indexedDB();backend.failNextWrite=true;
  const app=loadDm({localStorage:shared,indexedDB:backend.factory,saveCode:'OTTER-4821'});
  app.evaluate("progress.xp+=7;save('pda-progress',progress);");
  assert.equal(JSON.parse(shared.getItem('pda-progress')).xp,0,'the new writer must not appear before its baseline is durable');
  await assert.rejects(app.evaluate('dmSyncOpening'),{code:'unavailable'});
  assert.match(app.element('sync-note').textContent,/Could not save these changes/);assert.equal(app.evaluate('progress.xp'),7);
  await app.evaluate("ensureDmSync('OTTER-4821')");assert.equal(JSON.parse(shared.getItem('pda-progress')).xp,7);
  assert.doesNotMatch(app.element('sync-note').textContent,/Could not save these changes/);
});


test('a boot receipt preserves early local practice when the first remote adoption hits quota',async()=>{
  const underlying=storage({'pda-progress':{xp:0,modules:{},bestStreak:0}}),backend=indexedDB();let fail=false;
  const shared={...underlying,setItem(key,value){if(fail&&key==='pda-progress')throw new Error('quota');underlying.setItem(key,value);}},options={localStorage:shared,indexedDB:backend.factory,saveCode:'OTTER-4821'};
  const app=loadDm(options);await app.evaluate('dmSyncOpening');app.evaluate("progress.xp+=5;save('pda-progress',progress);");
  const remote=read(app,'snapshotLocal()');remote.progress.xp=10;const server=new Server(remote);app.setRemote(server.ref());fail=true;await app.evaluate('cloudConnect()');
  assert.equal(app.evaluate('progress.xp'),15);assert.equal(JSON.parse(shared.getItem('pda-progress')).xp,5);assert.equal(server.state.progress.xp,10);fail=false;
  const reloaded=loadDm(options);await reloaded.evaluate('dmSyncOpening');reloaded.setRemote(server.ref());await reloaded.evaluate('cloudConnect()');
  assert.equal(reloaded.evaluate('progress.xp'),15);assert.equal(server.state.progress.xp,15);
});
