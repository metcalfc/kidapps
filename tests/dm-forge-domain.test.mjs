import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { loadDm } from './dm-harness.mjs';

const source = readFileSync(new URL('../web/dm/forge-map.js', import.meta.url), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));
const sizes = {small:{w:12,h:9},medium:{w:24,h:18},large:{w:32,h:24}};
function domain() {
  const context = vm.createContext({});
  vm.runInContext(source, context);
  return context.KidForgeMap.create({
    SIZES:sizes, GROUNDS:{s:{wall:'stone'},c:{wall:'cave'},w:{wall:'wood'}},
    PIECES:Object.fromEntries([...' .SEkmt$s'].map(c => [c,{}])),
    TRAPS:{spike:{},pit:{},spiked:{},net:{},dart:{}},
    monSpan:name => name === 'Ogre' ? 2 : name === 'Hill Giant' ? 3 : 1,
    isPit:t => !!t && ['pit','spiked'].includes(t.trap),
  });
}
function dungeon(D, size = 'small') {
  const {w,h} = sizes[size], count = w*h;
  return {id:'source',v:2,size,title:'The original',rev:4,
    cells:'S$sm' + '.'.repeat(count-5) + 'E', ground:'s'.repeat(count),
    walls:'.'.repeat(D.wallCount(w,h)),things:{1:{size:'l'},2:{text:'Keep this clue.'},3:{mon:'Goblin'}}};
}

test('map codec round-trips every material, door and manual-wall bit on all map sizes', () => {
  const D = domain();
  for(const size of Object.keys(sizes)) {
    const d = dungeon(D,size), {w,h} = sizes[size];
    d.walls = Array.from({length:D.wallCount(w,h)}, (_,i) => D.WALL_CH[i%D.WALL_CH.length]).join('');
    const copy = {title:'Preserved metadata',rev:9};
    D.mapStore(copy,D.mapOf(d));
    for(const field of ['cells','ground','walls','things']) assert.deepEqual(plain(copy[field]),d[field],`${size}: ${field}`);
    assert.equal(copy.title,'Preserved metadata');
    assert.equal(copy.rev,9);
    for(let i=0;i<D.wallCount(w,h);i++) assert.equal(D.wallIndex(w,h,D.wallKey(w,h,i)),i);
  }
});

test('working maps own piece metadata and commit all map fields as an independent snapshot', () => {
  const D = domain(), d = dungeon(D), before = plain(d), working = D.mapOf(d), borrowed = D.mapRead(d);
  assert.equal(borrowed.things,d.things,'the read adapter explicitly borrows metadata');
  assert.notEqual(working.things,d.things);
  assert.notEqual(working.things[2],d.things[2]);
  working.cells[1]='k'; working.ground[1]='c'; working.things[2].text='Edited clue';
  delete working.things[1]; working.edges.set('v1,0',{m:'wood',door:'locked',manual:true});
  assert.deepEqual(d,before,'uncommitted editor changes do not mutate a dungeon');
  D.mapStore(d,working);
  assert.equal(d.cells[1],'k'); assert.equal(d.ground[1],'c');
  assert.equal(d.things[1],undefined); assert.equal(d.things[2].text,'Edited clue');
  assert.deepEqual(plain(D.mapOf(d).edges.get('v1,0')),{m:'wood',door:'locked',manual:true});
  const committed = plain(d);
  working.things[2].text='Unfinished next edit'; working.cells[1]='.';
  working.edges.get('v1,0').door='secret';
  assert.deepEqual(plain(d),committed,'later working changes do not mutate the saved snapshot');
});

test('room boundaries and footprints use the same wall topology, including opened edges', () => {
  const D = domain(), M = {W:4,H:3,cells:Array(12).fill('.'),ground:Array(12).fill('s'),edges:new Map(),things:{}};
  for(let y=0;y<3;y++) M.edges.set(`v2,${y}`,{m:'stone',door:y===1?'door':null,manual:true});
  D.normalize(M);
  const rooms = D.forgeRooms(M).rooms;
  assert.deepEqual(plain(rooms.map(r=>({area:r.cells.length,perimeter:r.perimeter,rect:r.rect}))),[
    {area:6,perimeter:10,rect:true},{area:6,perimeter:10,rect:true},
  ]);
  assert.equal(D.footprint(M,1,2),null,'a closed edge cannot run through a creature');
  assert.deepEqual(plain(D.footprint(M,1,2,new Set(['v2,0','v2,1']))),[1,2,5,6]);
  M.cells[0]='m'; M.things[0]={mon:'Ogre'};
  assert.equal(D.monsterFits(M,0,'Ogre',0),true);
  M.cells[5]='$'; M.things[5]={size:'s'};
  assert.equal(D.monsterFits(M,0,'Ogre',0),false,'a creature cannot cover another piece');
});

test('pit groups stop at walls, differing depths and differing trap types', () => {
  const D = domain(), M = {W:4,H:2,cells:[...'tttttttt'],ground:Array(8).fill('s'),edges:new Map(),things:{}};
  for(let i=0;i<8;i++) M.things[i]={trap:'pit',depth:10};
  M.things[3].depth=20; M.things[6].trap='spiked'; M.things[7].depth=20;
  M.edges.set('v1,0',{m:'stone',manual:true}); M.edges.set('h0,1',{m:'stone',manual:true});
  assert.deepEqual(plain(D.pitGroup(M,0)),[0]);
  assert.deepEqual(plain(D.pitGroup(M,1)).sort((a,b)=>a-b),[1,2,4,5]);
});

test('legacy upgrade preserves authored metadata, installs its door and is idempotent', () => {
  const D = domain(), d = {id:'legacy',title:'Old rooms',rev:5,cells:'SDEt'+' '.repeat(104),things:{}};
  assert.equal(D.forgeUpgrade(d),d,'legacy callers explicitly upgrade their supplied snapshot');
  assert.equal(d.cells.slice(0,4),'S.Et');
  assert.deepEqual(plain(D.mapOf(d).edges.get('v1,0')),{m:'stone',door:'locked',manual:true});
  assert.deepEqual(plain(d.things[3]),{trap:'spike'});
  assert.equal(d.id,'legacy'); assert.equal(d.title,'Old rooms'); assert.equal(d.rev,5);
  const upgraded = plain(d); D.forgeUpgrade(d); assert.deepEqual(plain(d),upgraded);
});

test('a play run consumes keys, loot and pits without changing its authored dungeon or editor copy', async () => {
  const app = loadDm();
  app.evaluate(`(() => {
    const M={W:12,H:9,cells:Array(108).fill(' '),ground:Array(108).fill('s'),edges:new Map(),things:{2:{size:'l'},3:{trap:'pit',depth:20},4:{text:'The original clue'}}};
    Object.assign(M.cells,{0:'S',1:'k',2:'$',3:'t',4:'s',5:'E'}); normalize(M);
    const d={id:'owned-run',v:2,size:'small',title:'Owned run',rev:1}; mapStore(d,M);
    forge.dungeons=[d]; ed.d=d; ed.M=mapOf(d); globalThis.domainBefore=JSON.stringify(d);
    forgeAsk=async(_box,step)=>step.answer; forgePlay(d,'test'); fp.hp=fp.max=1000;
  })()`);
  for(let i=1;i<=4;i++) await app.evaluate(`fpMove(${i})`);
  assert.equal(app.evaluate('fp.keys'),1); assert.equal(app.evaluate('fp.gold'),100);
  assert.equal(app.evaluate('fp.pits.has(3)'),true);
  assert.equal(app.evaluate('fp.M.cells.slice(1,4).join(\'\')'),'...');
  app.evaluate("fp.M.things[4].text='A run-only change'; fp.M.ground[4]='w';");
  assert.equal(app.evaluate('JSON.stringify(fp.d)===domainBefore'),true);
  assert.equal(app.evaluate('ed.M.things[4].text'),'The original clue');
  app.evaluate("forgePlay(fp.d,'test');");
  assert.equal(app.evaluate('fp.M.cells.slice(1,4).join(\'\')'),'k$t');
  assert.equal(app.evaluate('fp.M.things[4].text'),'The original clue');
});
