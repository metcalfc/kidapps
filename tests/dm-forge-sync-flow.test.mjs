import test from 'node:test';
import assert from 'node:assert/strict';
import {loadDm} from './dm-harness.mjs';

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
  a.setRemote(server.ref());b.setRemote(server.ref());await a.evaluate('cloudConnect()');await b.evaluate('cloudConnect()');
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
