import test from 'node:test';
import assert from 'node:assert/strict';
import {loadDm} from './dm-harness.mjs';

const read = (app, expression) => JSON.parse(app.evaluate(`JSON.stringify(${expression})`));
const settle = async () => { for(let i=0;i<40;i++) await Promise.resolve(); };
function start(app, {cells={0:'S',1:'.',2:'.',3:'.',4:'.',5:'.',6:'.',7:'m',8:'E'}, things={7:{mon:'Goblin'}}, edges=[]}={}) {
  app.evaluate(`(() => {
    const M={W:12,H:9,cells:Array(108).fill(' '),ground:Array(108).fill('s'),edges:new Map(${JSON.stringify(edges)}),things:${JSON.stringify(things)}};
    Object.assign(M.cells,${JSON.stringify(cells)});normalize(M);
    const d={id:'turns',v:2,size:'small',title:'Monsters on the move',intro:'Watch the corridor.',rev:1,things:M.things};
    mapStore(d,M);forge.dungeons=[d];forgePlay(d,'test');fp.hp=fp.max=1000;
  })()`);
}
const positions = app => read(app, '[...fp.monsters.values()].map(m=>[m.id,m.name,m.pos])');
function captureQuestions(app) {
  app.evaluate('const turnTestAsk=forgeAsk; forgeAsk=(box,st)=>{globalThis.turnTestAnswer=st.answer;return turnTestAsk(box,st);};');
}
async function answerQuestion(app) {
  const box=app.element('fp-enc'), answer=app.evaluate('turnTestAnswer'), input=box.querySelector('input');
  if(input) input.value=String(answer);
  else {
    const choice=box.querySelectorAll('button').find(b=>b.textContent===answer);
    assert.ok(choice, `the question should offer ${answer}`);choice.click();
  }
  const check=box.querySelectorAll('button').find(b=>b.textContent==='Check');
  assert.ok(check,'the question should be ready to grade');check.click();
  assert.equal(box.querySelector('.feedback').classList.contains('good'),true,box.textContent);
  const next=box.querySelectorAll('button').find(b=>!b.disabled&&['Continue','Next','Roll them'].includes(b.textContent));
  assert.ok(next,'the completed question should offer a next step');next.click();await settle();
}
function pointer(app,type,id,x,y=.5) {
  const scale=app.evaluate('fpView.s');
  app.element('fp-map').dispatchEvent({type,pointerId:id,pointerType:'touch',button:0,clientX:x*scale,clientY:y*scale});
}

test('a completed hero move and each Wait advance monsters exactly one square',async()=>{
  const app=loadDm();start(app);
  assert.equal(app.evaluate('fp.turn'),0);
  assert.deepEqual(positions(app),[[7,'Goblin',7]]);
  await app.evaluate('fpMove(1)');
  assert.equal(app.evaluate('fp.turn'),1);
  assert.deepEqual(positions(app),[[7,'Goblin',6]]);
  await settle();
  assert.deepEqual(positions(app),[[7,'Goblin',6]],'idle time does not give extra turns');
  await app.evaluate('fpWait()');
  assert.equal(app.evaluate('fp.pos'),1);
  assert.equal(app.evaluate('fp.turn'),2);
  assert.deepEqual(positions(app),[[7,'Goblin',5]]);
  app.element('fp-wait').click();await settle();
  assert.equal(app.evaluate('fp.turn'),3);
  assert.deepEqual(positions(app),[[7,'Goblin',4]]);
});

test('blocked, invalid, busy and declined movement attempts do not advance monsters',async()=>{
  const obstacles=[
    {m:'stone',door:null},{m:'cave',door:null},{m:'bars',door:null},
    {m:'stone',door:'locked'},{m:'wood',door:null},{m:'stone',door:'portcullis'},
  ];
  for(const edge of obstacles){
    const app=loadDm();start(app,{edges:[['v1,0',{...edge,manual:true}]]});
    app.evaluate('fpOffer=async()=>false;fpLift=async()=>false;');
    await app.evaluate('fpMove(1)');
    assert.equal(app.evaluate('fp.pos'),0,JSON.stringify(edge));
    assert.equal(app.evaluate('fp.turn'),0,JSON.stringify(edge));
    assert.deepEqual(positions(app),[[7,'Goblin',7]]);
  }
  const app=loadDm();start(app);
  for(const destination of [-1,12,2,108]) await app.evaluate(`fpMove(${destination})`);
  app.evaluate('fp.busy=true;');await app.evaluate('fpMove(1)');await app.evaluate('fpWait()');
  assert.equal(app.evaluate('fp.turn'),0);
  assert.deepEqual(positions(app),[[7,'Goblin',7]]);
});

test('opening a door and crossing it is one hero turn',async()=>{
  const app=loadDm();start(app,{edges:[['v1,0',{m:'stone',door:'door',manual:true}]]});
  await app.evaluate('fpMove(1)');
  assert.equal(app.evaluate("fp.opened.has('v1,0')"),true);
  assert.equal(app.evaluate('fp.turn'),1);
  assert.deepEqual(positions(app),[[7,'Goblin',6]]);
});

test('monsters wait for every chest and trap question before their single phase',async()=>{
  for(const [piece,thing,questions] of [['$',{size:'s'},1],['t',{trap:'spike'},2]]){
    const app=loadDm();start(app,{cells:{0:'S',1:piece,2:'.',3:'.',4:'.',5:'.',6:'.',7:'m',8:'E'},things:{1:thing,7:{mon:'Goblin'}}});
    captureQuestions(app);app.random([.999999,0,0]);
    const action=app.evaluate('fpMove(1)');await settle();
    for(let i=0;i<questions;i++){
      assert.equal(app.evaluate('fp.turn'),0,`${piece} question ${i+1}`);
      assert.deepEqual(positions(app),[[7,'Goblin',7]]);
      assert.equal(app.evaluate('fp.busy'),true);
      await app.evaluate('fpMove(2)');await app.evaluate('fpWait()');
      assert.equal(app.evaluate('fp.turn'),0,'inputs during the question are ignored');
      await answerQuestion(app);
    }
    await action;
    assert.equal(app.evaluate('fp.turn'),1);
    assert.deepEqual(positions(app),[[7,'Goblin',6]]);
    assert.equal(app.evaluate('fp.M.cells[1]'),'.');
  }
});

test('a successful or failed search gives monsters one turn after the question',async()=>{
  for(const random of [[.999999,0,0],[0,.999999,.999999]]){
    const app=loadDm();start(app);captureQuestions(app);app.random(random);
    const action=app.evaluate('fpSearch()');await settle();
    assert.equal(app.evaluate('fp.turn'),0);
    assert.deepEqual(positions(app),[[7,'Goblin',7]]);
    await answerQuestion(app);await action;
    assert.equal(app.evaluate('fp.turn'),1);
    assert.deepEqual(positions(app),[[7,'Goblin',6]]);
  }
});

test('escaping or dying ends play before another monster phase',async()=>{
  const win=loadDm();start(win,{cells:{0:'S',1:'E',2:'.',3:'.',4:'.',5:'.',6:'.',7:'m'}});
  await win.evaluate('fpMove(1)');
  assert.equal(win.evaluate('fp.over'),true);
  assert.deepEqual(positions(win),[[7,'Goblin',7]]);
  assert.equal(win.evaluate('fp.turn'),0);
  await win.evaluate('fpWait()');
  assert.deepEqual(positions(win),[[7,'Goblin',7]]);

  const loss=loadDm();start(loss,{cells:{0:'S',1:'m',2:'.',3:'.',4:'.',5:'.',6:'.',7:'m',8:'E'},things:{1:{mon:'Kobold'},7:{mon:'Goblin'}}});
  loss.evaluate('fpFight=async()=>{fp.hp=0;};');await loss.evaluate('fpMove(1)');
  assert.equal(loss.evaluate('fp.over'),true);
  assert.equal(loss.evaluate('fp.turn'),0);
  assert.equal(loss.evaluate('fp.monsters.get(7).pos'),7);
});

test('pathfinding follows a legal detour even when the first step increases distance',async()=>{
  const app=loadDm();start(app,{cells:{0:'S',2:'m',12:'.',13:'.',14:'.',24:'E'},things:{2:{mon:'Goblin'}}});
  assert.equal(app.evaluate('fpMonsterStep(fp.monsters.get(2))'),14);
  await app.evaluate('fpWait()');
  assert.deepEqual(positions(app),[[2,'Goblin',14]]);
});

test('closed walls and every closed door block pursuit until that edge is opened',()=>{
  const barriers=[
    {m:'stone',door:null},{m:'cave',door:null},{m:'wood',door:null},{m:'bars',door:null},
    ...['door','locked','portcullis','secret'].map(door=>({m:'stone',door})),
  ];
  for(const edge of barriers){
    const app=loadDm();start(app,{cells:{0:'S',1:'.',2:'.',3:'m',4:'E'},things:{3:{mon:'Goblin'}},edges:[['v2,0',{...edge,manual:true}]]});
    assert.equal(app.evaluate('fpMonsterStep(fp.monsters.get(3))'),null,JSON.stringify(edge));
    app.evaluate("fp.opened.add('v2,0');");
    assert.equal(app.evaluate('fpMonsterStep(fp.monsters.get(3))'),2,`${JSON.stringify(edge)} when opened`);
  }
});

test('monsters avoid hidden traps and open pits',()=>{
  const app=loadDm();start(app,{cells:{0:'S',1:'.',2:'t',3:'.',4:'m',5:'E'},things:{2:{trap:'pit',depth:30},4:{mon:'Goblin'}}});
  assert.equal(app.evaluate('fpMonsterStep(fp.monsters.get(4))'),null);
  app.evaluate("fp.M.cells[2]='.';fp.pits.add(2);");
  assert.equal(app.evaluate('fpMonsterStep(fp.monsters.get(4))'),null);
  app.evaluate('fp.pits.clear();');
  assert.equal(app.evaluate('fpMonsterStep(fp.monsters.get(4))'),3);
});

test('Large and Huge creatures cannot squeeze through narrow passages or move partway through a wall',()=>{
  for(const [name,span] of [['Ogre',2],['Hill Giant',3]]){
    const app=loadDm(), cells={0:'S',1:'.',107:'E'};
    for(let y=0;y<span;y++)for(let x=2;x<2+span;x++)cells[y*12+x]='.';
    cells[2]='m';start(app,{cells,things:{2:{mon:name}}});
    assert.equal(app.evaluate('fpMonsterStep(fp.monsters.get(2))'),null,`${name} needs its whole footprint`);

    const corridor={}, hero=12+span+3, wall=`v${span+1},1`;
    for(let y=1;y<=span;y++)for(let x=1;x<=span+3;x++)corridor[y*12+x]='.';
    corridor[13]='m';corridor[hero]='S';corridor[span*12+span+3]='E';
    start(app,{cells:corridor,things:{13:{mon:name}},edges:[[wall,{m:'stone',door:null,manual:true}]]});
    assert.equal(app.evaluate('fpMonsterStep(fp.monsters.get(13))'),null,`${name} cannot cross a wall under one part of its body`);
    app.evaluate(`fp.opened.add(${JSON.stringify(wall)});`);
    assert.equal(app.evaluate('fpMonsterStep(fp.monsters.get(13))'),14,`${name} can cross after the entire route is open`);
  }
});

test('each actor moves once without overlapping another actor, and a phase starts at most one fight',async()=>{
  const app=loadDm();start(app,{cells:{0:'S',1:'.',2:'.',3:'.',4:'.',5:'m',6:'m',7:'E'},things:{5:{mon:'Goblin'},6:{mon:'Kobold'}}});
  await app.evaluate('fpWait()');
  assert.deepEqual(positions(app),[[5,'Goblin',4],[6,'Kobold',5]]);
  assert.equal(app.evaluate('fp.occ.size'),2);
  assert.equal(app.evaluate('new Set(fp.occ.values()).size'),2);

  const near=loadDm();start(near,{cells:{0:'.',1:'m',2:'E',12:'S',13:'m'},things:{1:{mon:'Goblin'},13:{mon:'Kobold'}}});
  near.evaluate('globalThis.turnFights=[];fpFight=async(_box,name)=>{turnFights.push(name);fp.kills++;};');
  await near.evaluate('fpWait()');
  assert.equal(near.evaluate('turnFights.length'),1);
  assert.equal(near.evaluate('fp.monsters.size'),1);
  assert.equal(near.evaluate('fp.kills'),1);
});

test('moving actors preserve features underneath them and replay restores the built map',async()=>{
  const features={k:null,$:{size:'l'},s:{text:'The dragon sleeps here.'},S:null,E:null};
  for(const [piece,thing] of Object.entries(features)){
    const app=loadDm(), cells={0:'S',1:'.',2:'.',3:piece,4:'m',5:'.',6:'.',7:'E'};
    if(piece==='S')cells[0]='.';
    if(piece==='E')cells[7]='.';
    start(app,{cells,things:{3:thing,4:{mon:'Goblin'}}});
    app.evaluate('fp.pos=0;globalThis.turnBuilt=JSON.stringify(fp.d);');
    await app.evaluate('fpMonsterTurn()');
    assert.deepEqual(positions(app),[[4,'Goblin',3]],piece);
    assert.equal(app.evaluate('fp.M.cells[3]'),piece);
    assert.deepEqual(read(app,'fp.M.things[3]'),thing);
    assert.equal(app.evaluate('JSON.stringify(fp.d)===turnBuilt'),true,`${piece} must stay in the saved map`);
    assert.equal(app.evaluate('fp.M.things===fp.d.things'),false,'runtime metadata is a separate copy');
    app.evaluate("forgePlay(fp.d,'test');");
    assert.deepEqual(positions(app),[[4,'Goblin',4]],`${piece} replay position`);
    assert.equal(app.evaluate('fp.M.cells[3]'),piece);
    assert.equal(app.evaluate('fp.turn'),0);
  }
});

test('fighting a moving actor still resolves the key, sign, chest or exit beneath it',async()=>{
  for(const piece of ['k','s','$','E']){
    const app=loadDm(), cells={0:'S',1:'.',2:'.',3:piece,4:'m',5:'E'};
    if(piece==='E')cells[5]='.';
    const thing=piece==='$'?{size:'l'}:piece==='s'?{text:'A moving guard hid this sign.'}:null;
    start(app,{cells,things:{3:thing,4:{mon:'Goblin'}}});captureQuestions(app);
    app.evaluate('globalThis.turnFights=[];fpFight=async(_box,name)=>{turnFights.push(name);fp.kills++;};');
    await app.evaluate('fpMonsterTurn()');app.evaluate('fp.pos=2;');
    const action=app.evaluate('fpMove(3)');await settle();
    if(piece==='$')await answerQuestion(app);
    await action;
    assert.deepEqual(read(app,'turnFights'),['Goblin'],piece);
    assert.equal(app.evaluate('fp.monsters.size'),0,piece);
    if(piece==='k')assert.equal(app.evaluate('fp.keys'),1);
    if(piece==='$')assert.equal(app.evaluate('fp.gold'),100);
    if(piece==='s')assert.match(app.element('fp-read').textContent,/A moving guard hid this sign/);
    if(piece==='E')assert.equal(app.evaluate('fp.over'),true);
  }
});

test('navigation cancels a pending question without advancing monsters or awarding loot',async()=>{
  const app=loadDm();start(app,{cells:{0:'S',1:'$',2:'.',3:'.',4:'.',5:'.',6:'.',7:'m',8:'E'},things:{1:{size:'l'},7:{mon:'Goblin'}}});
  let finished=false;const action=app.evaluate('fpMove(1)').then(()=>{finished=true;});
  await settle();const session=app.evaluate('fp.session');
  app.evaluate("show('home');");await settle();
  assert.equal(finished,true,'leaving resolves the cancelled action instead of leaving it suspended');await action;
  assert.ok(app.evaluate('fp.session')>session);
  assert.equal(app.evaluate('fp.gold'),0);
  assert.equal(app.evaluate('fp.turn'),0);
  assert.equal(app.evaluate('fp.busy'),false);
  assert.deepEqual(positions(app),[[7,'Goblin',7]]);
});

test('an old fight cannot clear the movement lock or mutate a newly started game',async()=>{
  for(const navigation of ["show('home')","$('fp-leave').click()"]){
    const app=loadDm();start(app,{cells:{0:'S',1:'m',2:'E'},things:{1:{mon:'Kobold'}}});
    app.evaluate('fpFight=()=>new Promise(resolve=>{globalThis.turnFinishOldFight=resolve;});');
    const old=app.evaluate('fpMove(1)');await settle();app.evaluate(navigation);
    start(app,{cells:{0:'S',1:'$',2:'.',3:'.',4:'.',5:'.',6:'.',7:'m',8:'E'},things:{1:{size:'s'},7:{mon:'Goblin'}}});captureQuestions(app);
    const current=app.evaluate('fpMove(1)');await settle();
    const before=read(app,'({session:fp.session,hp:fp.hp,pos:fp.pos,gold:fp.gold,turn:fp.turn,monsters:[...fp.monsters],cells:fp.M.cells})');
    app.evaluate('turnFinishOldFight();');await old;await settle();
    assert.deepEqual(read(app,'({session:fp.session,hp:fp.hp,pos:fp.pos,gold:fp.gold,turn:fp.turn,monsters:[...fp.monsters],cells:fp.M.cells})'),before,navigation);
    assert.equal(app.evaluate('fp.busy'),true,'the new chest retains its movement lock');
    assert.equal(app.element('fp-enc').hidden,false,'the new question stays visible');
    await answerQuestion(app);await current;
    assert.equal(app.evaluate('fp.gold'),20);
    assert.equal(app.evaluate('fp.turn'),1);
    assert.deepEqual(positions(app),[[7,'Goblin',6]]);
  }
});

test('a touch tap moves and advances monsters only when the finger is released',async()=>{
  const app=loadDm();start(app);
  pointer(app,'pointerdown',1,1.5);await settle();
  assert.equal(app.evaluate('fp.pos'),0);
  assert.equal(app.evaluate('fp.turn'),0);
  assert.deepEqual(positions(app),[[7,'Goblin',7]]);
  pointer(app,'pointerup',1,1.5);await settle();
  assert.equal(app.evaluate('fp.pos'),1);
  assert.equal(app.evaluate('fp.turn'),1);
  assert.deepEqual(positions(app),[[7,'Goblin',6]]);
});

test('dragging or pinching the map does not spend a hero turn',async()=>{
  const app=loadDm();start(app);
  pointer(app,'pointerdown',1,1.5);
  pointer(app,'pointermove',1,2.5);
  pointer(app,'pointerup',1,2.5);await settle();
  assert.equal(app.evaluate('fp.pos'),0);
  assert.equal(app.evaluate('fp.turn'),0);

  pointer(app,'pointerdown',1,1.5);
  pointer(app,'pointerdown',2,3.5);
  pointer(app,'pointermove',2,4.5);
  pointer(app,'pointerup',2,4.5);
  pointer(app,'pointerup',1,1.5);await settle();
  assert.equal(app.evaluate('fp.pos'),0);
  assert.equal(app.evaluate('fp.turn'),0);
  assert.deepEqual(positions(app),[[7,'Goblin',7]]);
  pointer(app,'pointerdown',3,1.5);pointer(app,'pointerup',3,1.5);await settle();
  assert.equal(app.evaluate('fp.pos'),1,'a new tap works after all pinch fingers are released');
  assert.equal(app.evaluate('fp.turn'),1);
});

test('pointer cancellation or starting another game cancels the pending map tap',async()=>{
  for(const cancel of ['pointer','session']){
    const app=loadDm();start(app);
    pointer(app,'pointerdown',1,1.5);
    if(cancel==='pointer')pointer(app,'pointercancel',1,1.5);
    else start(app);
    pointer(app,'pointerup',1,1.5);await settle();
    assert.equal(app.evaluate('fp.pos'),0,cancel);
    assert.equal(app.evaluate('fp.turn'),0,cancel);
    assert.deepEqual(positions(app),[[7,'Goblin',7]],cancel);
    pointer(app,'pointerdown',2,1.5);pointer(app,'pointerup',2,1.5);await settle();
    assert.equal(app.evaluate('fp.pos'),1,`${cancel}: later taps still work`);
    assert.equal(app.evaluate('fp.turn'),1,cancel);
  }
});
