import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const scripts=['merge.js','sync.js'].map(name=>readFileSync(new URL('../web/shared/'+name,import.meta.url),'utf8'));
const copy=value=>value===undefined?undefined:JSON.parse(JSON.stringify(value));
const error=code=>Object.assign(new Error(code),{code});
const day='2026-11-01';
const dungeon=(id,extra={})=>({id,v:2,size:'small',title:`Dungeon ${id}`,intro:'A guarded door.',cells:'SmE'+' '.repeat(105),ground:'s'.repeat(108),walls:'.'.repeat(237),things:{1:{mon:'Goblin'}},rev:1,tested:1,share:`code-${id}`,...extra});
const state=()=>({updatedAt:1,settings:{dm:'Pip',level:3,party:['Pip','Mabel','Thorne'],places:['The old mill']},progress:{xp:100,modules:{dice:{correct:5,tries:6}},bestStreak:3,bosses:{Goblin:1},days:{[day]:6},review:{genDiceAverage:2},reviewPrompts:{genDiceAverage:'Average of 2d6?'},daily:{date:day,done:2,complete:false,streak:1}},tracker:{round:1,turn:0,started:false,list:[]},forge:{dungeons:[dungeon('one')],board:[{id:'job-a',kind:'area',n:12},{id:'job-b',kind:'pit',depth:20}],played:{'friend-a':{title:'A friend map',cleared:false}},stats:{right:2,tries:3,commissions:1}}});
function storage(){const values=new Map();return{getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,String(value)),removeItem:key=>values.delete(key)};}
let devices=0;
function device(initial=state(),saved=storage()){
  const id=++devices;let mutation=0;
  const context=vm.createContext({localStorage:saved,crypto:{randomUUID:()=>`dm-device-${id}-mutation-${++mutation}`}});
  for(const script of scripts)vm.runInContext(script,context);
  const merge=context.KidMerge;
  const sync=context.KidSync.create({key:'pda-save',initial:copy(initial),merge:merge.dm,legacy:(l,r)=>merge.legacy('dm',l,r)});
  return{context,merge,sync,storage:saved};
}
class Server{
  constructor(value){this.value=copy(value);this.version=value===undefined?0:1;this.applied=0;this.mutations=new Set();}
  snapshot(){const data=copy(this.value);return{exists:data!==undefined,data:()=>data,metadata:{etag:`v${this.version}`}};}
  write(value){this.value=copy(value);this.version++;}
  ref(){return{get:async()=>this.snapshot(),commit:async(value,options)=>{
    if(this.mutations.has(options.mutation))return this.snapshot();
    if(this.beforeCommit)await this.beforeCommit(value,options);
    if(this.fail)throw error('unavailable');
    if(options.etag!==(this.value===undefined?'*':`v${this.version}`))throw error('conflict');
    this.value=copy(value);this.version++;this.applied++;this.mutations.add(options.mutation);
    if(this.loseResponse){this.loseResponse=false;throw error('unavailable');}
    return this.snapshot();
  }};}
}
function edit(d,title,monster='Ogre'){
  d.title=title;d.things[1]={mon:monster};d.rev++;d.tested=0;
}

test('DM merge APIs preserve unchanged remote state without changing any input',()=>{
  const {merge}=device(),base=state(),local=copy(base),remote=state();
  edit(remote.forge.dungeons[0],'Remote dungeon');remote.progress.xp+=40;
  const before=copy({base,local,remote});
  for(const apply of [()=>merge.dm(base,local,remote),()=>merge.mergeDm(base,local,remote),()=>merge.merge('dm',base,local,remote)]){
    const result=copy(apply());assert.deepEqual(result,remote);result.forge.dungeons[0].things[1].mon='Troll';
  }
  assert.deepEqual({base,local,remote},before);
});

test('independent dungeon additions and edits survive in the same merged save',()=>{
  const {merge}=device(),base=state(),local=copy(base),remote=copy(base);
  local.forge.dungeons.push(dungeon('local'));remote.forge.dungeons.push(dungeon('remote'));
  edit(local.forge.dungeons[0],'Local changed original');
  const result=copy(merge.dm(base,local,remote));
  assert.deepEqual(new Set(result.forge.dungeons.map(d=>d.id)),new Set(['one','local','remote']));
  assert.equal(result.forge.dungeons.find(d=>d.id==='one').title,'Local changed original');
});

test('competing edits preserve both complete dungeons and reset sharing on the recovered copy',()=>{
  const {merge}=device(),base=state(),local=copy(base),remote=copy(base);
  edit(local.forge.dungeons[0],'Local poison hallway','Troll');
  local.forge.dungeons[0].things[12]={trap:'dart'};local.forge.dungeons[0].intro='Local clue.';
  edit(remote.forge.dungeons[0],'Remote spider chamber','Giant Spider');remote.forge.dungeons[0].intro='Remote clue.';
  const result=copy(merge.dm(base,local,remote)),primary=result.forge.dungeons.find(d=>d.id==='one'),recovered=result.forge.dungeons.find(d=>d.id!=='one');
  assert.deepEqual(primary,remote.forge.dungeons[0]);
  assert.match(recovered.title,/Local poison hallway.*recovered copy/);
  assert.deepEqual(recovered.things,local.forge.dungeons[0].things);
  assert.equal(recovered.intro,'Local clue.');assert.equal(recovered.cells,local.forge.dungeons[0].cells);
  assert.equal(recovered.ground,local.forge.dungeons[0].ground);assert.equal(recovered.walls,local.forge.dungeons[0].walls);
  assert.equal(recovered.tested,0);assert.equal(recovered.share,null);
  assert.equal(recovered.publishedRev,0);
  assert.equal(new Set(result.forge.dungeons.map(d=>d.id)).size,2);
  assert.deepEqual(copy(merge.dm(base,local,result)).forge.dungeons,result.forge.dungeons,'a CAS rebase reuses its recovery instead of making another copy');
});

test('map recoveries never discard existing dungeons when the editor limit is reached',()=>{
  const {merge}=device(),base=state();base.forge.dungeons=Array.from({length:12},(_,i)=>dungeon(String(i)));
  const local=copy(base),remote=copy(base);edit(local.forge.dungeons[0],'Left');edit(remote.forge.dungeons[0],'Right');
  const result=copy(merge.dm(base,local,remote));
  assert.equal(result.forge.dungeons.length,13);
  for(const d of base.forge.dungeons)assert.ok(result.forge.dungeons.some(r=>r.id===d.id));
});

test('recovered titles fit the editor limit while keeping their recovery label',()=>{
  const {merge}=device(),base=state(),local=copy(base),remote=copy(base);
  edit(local.forge.dungeons[0],'A'.repeat(40));edit(remote.forge.dungeons[0],'Remote changes');
  const result=copy(merge.dm(base,local,remote)),recovered=result.forge.dungeons.find(d=>d.id!=='one');
  assert.equal(recovered.title.length,40);assert.match(recovered.title,/ \(recovered copy\)$/);
  assert.deepEqual(copy(merge.dm(base,local,result)).forge.dungeons,result.forge.dungeons);
});

test('recovery IDs cannot overwrite an existing different dungeon or collapse duplicate legacy IDs',()=>{
  const {merge}=device(),base=state(),local=copy(base),remote=copy(base);edit(local.forge.dungeons[0],'Left');edit(remote.forge.dungeons[0],'Right');
  const first=copy(merge.dm(base,local,remote)),recoveryId=first.forge.dungeons.find(d=>d.id!=='one').id;
  remote.forge.dungeons.push(dungeon(recoveryId,{title:'Keep this unrelated dungeon'}));
  const result=copy(merge.dm(base,local,remote));assert.equal(result.forge.dungeons.length,3);
  assert.equal(result.forge.dungeons.find(d=>d.id===recoveryId).title,'Keep this unrelated dungeon');
  assert.ok(result.forge.dungeons.some(d=>d.title==='Left (recovered copy)'&&d.id!==recoveryId));
  local.forge.dungeons.push(dungeon('one',{title:'An old duplicate ID'}));
  const legacy=copy(merge.legacy('dm',local,remote));
  assert.ok(legacy.forge.dungeons.some(d=>d.title.startsWith('An old duplicate ID')));
  assert.equal(new Set(legacy.forge.dungeons.map(d=>d.id)).size,legacy.forge.dungeons.length);
});

test('deleting an unchanged dungeon stays deleted, while an independently edited version survives',()=>{
  const {merge}=device(),base=state();
  for(const deleted of ['local','remote']){
    const local=copy(base),remote=copy(base);({local,remote})[deleted].forge.dungeons=[];
    assert.equal(merge.dm(base,local,remote).forge.dungeons.length,0,`${deleted} deletion versus unchanged`);
    const other=deleted==='local'?remote:local;edit(other.forge.dungeons[0],'Rescued edit');
    const result=copy(merge.dm(base,local,remote));
    assert.equal(result.forge.dungeons.length,1);assert.equal(result.forge.dungeons[0].title,'Rescued edit');
  }
});

test('testing or publishing an unchanged dungeon on another device does not reverse deletion',()=>{
  const {merge}=device(),base=state();
  for(const deleted of ['local','remote']){
    const local=copy(base),remote=copy(base),branches={local,remote};branches[deleted].forge.dungeons=[];
    const other=branches[deleted==='local'?'remote':'local'].forge.dungeons[0];
    other.rev=3;other.tested=3;other.share='NEW-CODE';other.publishedRev=3;
    assert.equal(merge.dm(base,local,remote).forge.dungeons.length,0,`${deleted} deletion wins over metadata changes`);
  }
});

test('identical authored edits and test or share metadata do not manufacture conflicting copies',()=>{
  const {merge}=device(),base=state(),local=copy(base),remote=copy(base);
  edit(local.forge.dungeons[0],'The same dungeon');edit(remote.forge.dungeons[0],'The same dungeon');
  local.forge.dungeons[0].tested=2;remote.forge.dungeons[0].share='new-code';remote.forge.dungeons[0].publishedRev=2;
  const result=copy(merge.dm(base,local,remote));
  assert.equal(result.forge.dungeons.length,1);assert.equal(result.forge.dungeons[0].tested,2);assert.equal(result.forge.dungeons[0].share,'new-code');
});

test('publishing on one device and editing on another retains the published code without testing changed content',()=>{
  const {merge}=device(),base=state();base.forge.dungeons[0].share=null;base.forge.dungeons[0].tested=0;
  const local=copy(base),remote=copy(base);local.forge.dungeons[0].share='published-code';local.forge.dungeons[0].publishedRev=1;local.forge.dungeons[0].tested=1;
  edit(remote.forge.dungeons[0],'Changed elsewhere');
  const result=copy(merge.dm(base,local,remote));assert.equal(result.forge.dungeons.length,1);
  assert.equal(result.forge.dungeons[0].share,'published-code');assert.equal(result.forge.dungeons[0].publishedRev,null);assert.equal(result.forge.dungeons[0].tested,0);
  assert.equal(result.forge.dungeons[0].rev,2);
  const legacy=copy(merge.legacy('dm',base,local));assert.equal(legacy.forge.dungeons.length,1);assert.equal(legacy.forge.dungeons[0].share,'published-code');
});

test('equal revision numbers cannot certify publication of different authored content',()=>{
  const {merge}=device(),base=state();base.forge.dungeons[0].share=null;base.forge.dungeons[0].tested=0;
  const local=copy(base),remote=copy(base);
  Object.assign(local.forge.dungeons[0],{rev:3,tested:3,share:'FOX-1234',publishedRev:3});
  Object.assign(remote.forge.dungeons[0],{title:'Different map',rev:3,tested:3});
  const result=copy(merge.dm(base,local,remote)).forge.dungeons[0];
  assert.equal(result.title,'Different map');assert.equal(result.share,'FOX-1234');assert.equal(result.publishedRev,null);
  assert.equal(result.rev,3);assert.equal(result.tested,3,'the independent test still applies to its own chosen content');
});

test('missing legacy revision metadata cannot turn an untested dungeon into a tested one',()=>{
  const {merge}=device(),base=state();for(const key of ['rev','tested','share'])delete base.forge.dungeons[0][key];
  const local=copy(base),remote=copy(base);local.forge.dungeons[0].share=null;remote.forge.dungeons[0].publishedRev=0;
  const result=copy(merge.dm(base,local,remote)).forge.dungeons[0];
  assert.equal(result.tested,0);assert.ok(result.rev>0);assert.notEqual(result.tested,result.rev);
});

test('practice, trophies, daily activity and Forge grading add only changes since the base',()=>{
  const {merge}=device(),base=state(),local=copy(base),remote=copy(base);
  local.progress.xp+=15;remote.progress.xp+=30;
  local.progress.modules.dice.correct+=1;local.progress.modules.dice.tries+=2;
  remote.progress.modules.dice.correct+=3;remote.progress.modules.dice.tries+=4;
  local.progress.bosses.Goblin++;remote.progress.bosses.Goblin+=2;
  local.progress.days[day]+=2;remote.progress.days[day]+=4;
  local.progress.bestStreak=4;remote.progress.bestStreak=6;
  local.progress.daily.done++;remote.progress.daily.done+=2;remote.progress.daily.complete=true;remote.progress.daily.streak=2;
  local.forge.stats.right++;local.forge.stats.tries++;remote.forge.stats.right+=2;remote.forge.stats.tries+=3;
  local.forge.stats.commissions++;remote.forge.stats.commissions+=2;
  const result=copy(merge.dm(base,local,remote));
  assert.equal(result.progress.xp,145);assert.deepEqual(result.progress.modules.dice,{correct:9,tries:12});
  assert.equal(result.progress.bosses.Goblin,4);assert.equal(result.progress.days[day],12);assert.equal(result.progress.bestStreak,6);
  assert.deepEqual(result.progress.daily,{date:day,done:5,complete:true,streak:2});
  assert.deepEqual(result.forge.stats,{right:5,tries:7,commissions:4});
  assert.deepEqual(copy(merge.dm(local,local,result)),result,'an unchanged acknowledged branch adds nothing again');
});

test('explicit local settings and tracker edits win while unrelated remote fields remain',()=>{
  const {merge}=device(),base=state(),local=copy(base),remote=copy(base);
  local.settings.dm='Local name';remote.settings.level=5;remote.settings.party=['New hero'];
  remote.tracker={round:3,turn:1,started:true,list:[{name:'Remote',hp:8}]};
  const first=copy(merge.dm(base,local,remote));
  assert.equal(first.settings.dm,'Local name');assert.equal(first.settings.level,5);assert.deepEqual(first.settings.party,['New hero']);
  assert.deepEqual(first.tracker,remote.tracker);
  local.tracker={round:2,turn:0,started:true,list:[{name:'Local',hp:9}]};
  assert.deepEqual(copy(merge.dm(base,local,remote)).tracker,local.tracker);
  delete local.settings.places;assert.equal(Object.hasOwn(merge.dm(base,local,remote).settings,'places'),false);
});

test('played clears unite, completed base commissions stay removed, and new jobs survive',()=>{
  const {merge}=device(),base=state(),local=copy(base),remote=copy(base);
  local.forge.played['friend-a'].cleared=true;remote.forge.played['friend-b']={title:'Another map',cleared:true};
  local.forge.board=local.forge.board.filter(c=>c.id!=='job-a');remote.forge.board=remote.forge.board.filter(c=>c.id!=='job-b');
  local.forge.board.push({id:'left',kind:'story'});remote.forge.board.push({id:'right',kind:'jail'});
  const result=copy(merge.dm(base,local,remote));
  assert.equal(result.forge.played['friend-a'].cleared,true);assert.equal(result.forge.played['friend-b'].cleared,true);
  assert.deepEqual(new Set(result.forge.board.map(c=>c.id)),new Set(['left','right']));
});

test('review clears survive unchanged branches and concurrent misses remain scheduled',()=>{
  const {merge}=device(),base=state(),local=copy(base),remote=copy(base);
  delete local.progress.review.genDiceAverage;delete local.progress.reviewPrompts.genDiceAverage;
  const cleared=copy(merge.dm(base,local,remote));assert.equal(cleared.progress.review.genDiceAverage,undefined);
  remote.progress.review.genDiceAverage=1;remote.progress.reviewPrompts.genDiceAverage='A new review example';
  const pending=copy(merge.dm(base,local,remote));assert.equal(pending.progress.review.genDiceAverage,1);
  assert.equal(pending.progress.reviewPrompts.genDiceAverage,'A new review example');
});

test('a progress reset cannot be undone by a stale device and does not erase Forge maps',()=>{
  const {merge}=device(),base=state(),local=copy(base),remote=copy(base);
  remote.progress={xp:0,modules:{},bestStreak:0,reset:{at:2,id:'reset-one'}};
  local.progress.xp+=10;local.forge.dungeons.push(dungeon('new-local'));
  const result=copy(merge.dm(base,local,remote));assert.deepEqual(result.progress,remote.progress);
  assert.deepEqual(new Set(result.forge.dungeons.map(d=>d.id)),new Set(['one','new-local']));
});

test('legacy migration retains remote maps and divergent local maps without duplicating counters',()=>{
  const {merge}=device(),local=state(),remote=state();local.updatedAt=5;remote.updatedAt=4;
  edit(local.forge.dungeons[0],'Old laptop version','Troll');edit(remote.forge.dungeons[0],'Tablet version','Wolf');
  local.forge.dungeons.push(dungeon('laptop'));remote.forge.dungeons.push(dungeon('tablet'));
  local.progress.xp=150;remote.progress.xp=200;local.forge.stats.tries=9;remote.forge.stats.tries=12;
  const result=copy(merge.seedLegacy('dm',local,remote));
  assert.equal(result.forge.dungeons.length,4);assert.equal(result.forge.dungeons.find(d=>d.id==='one').title,'Tablet version');
  assert.ok(result.forge.dungeons.some(d=>d.title.includes('Old laptop version')&&d.title.includes('recovered copy')));
  assert.equal(result.progress.xp,200);assert.equal(result.forge.stats.tries,12);
  assert.deepEqual(copy(merge.legacy('dm',local,result)).forge.dungeons,result.forge.dungeons);
  assert.deepEqual(copy(merge.legacy('dm',local,undefined)),local);
});

test('an empty legacy snapshot cannot erase a populated DM profile on an equal timestamp',()=>{
  const {merge}=device(),local=state(),remote=state();remote.settings={dm:'',level:3};remote.progress={xp:0,modules:{}};remote.forge.dungeons=[];
  const result=copy(merge.legacy('dm',local,remote));assert.deepEqual(result.settings,local.settings);
  assert.equal(result.forge.dungeons[0].id,'one');assert.equal(result.progress.xp,100);
});

test('a fresh device’s newer default timestamp cannot replace a populated server profile',()=>{
  const {merge}=device(),remote=state(),local=state();
  local.updatedAt=999;local.settings={dm:'',level:3};local.progress={xp:0,modules:{},bestStreak:0};local.forge.dungeons=[];
  const result=copy(merge.legacy('dm',local,remote));assert.deepEqual(result.settings,remote.settings);
  assert.equal(result.progress.xp,100);assert.equal(result.forge.dungeons[0].id,'one');
});

test('concurrent CAS saves preserve both map edits and each device’s practice once',async()=>{
  const base=state(),server=new Server(base),a=device(base),b=device(base),local=copy(base),remote=copy(base);
  a.sync.reconcile(base,base);b.sync.reconcile(base,base);
  edit(local.forge.dungeons[0],'Laptop corridor','Troll');local.progress.xp+=10;
  edit(remote.forge.dungeons[0],'Tablet chamber','Wolf');remote.progress.xp+=15;
  await a.sync.save(server.ref(),local);const result=copy(await b.sync.save(server.ref(),remote));
  assert.equal(result.progress.xp,125);assert.equal(result.forge.dungeons.length,2);
  assert.ok(result.forge.dungeons.some(d=>d.title==='Laptop corridor'));
  assert.ok(result.forge.dungeons.some(d=>d.title.includes('Tablet chamber')));
  assert.deepEqual(copy(await b.sync.save(server.ref(),result)),result);
});

test('a lost acknowledgement survives reload and preserves map conflicts without duplicate rewards',async()=>{
  const base=state(),server=new Server(base),saved=storage(),a=device(base,saved),local=copy(base);
  a.sync.reconcile(base,base);edit(local.forge.dungeons[0],'Offline laptop edit');local.progress.xp+=10;
  server.loseResponse=true;await assert.rejects(a.sync.save(server.ref(),local),{code:'unavailable'});
  const mutation=JSON.parse(saved.getItem('pda-save:pending')).mutation;
  const b=device(server.value),right=copy(server.value);b.sync.reconcile(right,right);edit(right.forge.dungeons[0],'New tablet edit','Wolf');right.progress.xp+=15;
  await b.sync.save(server.ref(),right);
  const reloaded=device(local,saved),result=copy(await reloaded.sync.save(server.ref(),local));
  assert.equal(result.progress.xp,125);assert.equal(result.forge.dungeons.length,1);
  assert.equal(result.forge.dungeons[0].title,'New tablet edit');
  assert.ok(server.mutations.has(mutation));assert.equal(server.applied,2);assert.equal(saved.getItem('pda-save:pending'),null);
});

test('edits made while a save is in flight remain in both the UI result and the server',async()=>{
  const base=state(),server=new Server(base),a=device(base),local=copy(base);a.sync.reconcile(base,base);
  edit(local.forge.dungeons[0],'First edit');let delayed=false;
  server.beforeCommit=async()=>{if(!delayed){delayed=true;local.forge.dungeons.push(dungeon('during-request'));local.progress.xp+=5;}};
  const result=copy(await a.sync.save(server.ref(),local));
  assert.ok(result.forge.dungeons.some(d=>d.id==='during-request'));assert.equal(result.progress.xp,105);
  assert.deepEqual(server.value,result);
});
