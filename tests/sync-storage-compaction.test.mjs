import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {indexedDB} from './indexeddb-harness.mjs';

const source=readFileSync(new URL('../web/shared/sync-storage.js',import.meta.url),'utf8');
const storage=()=>{const data=new Map();return {getItem:key=>data.get(key)??null,setItem:(key,value)=>data.set(key,String(value)),removeItem:key=>data.delete(key)};};
const plain=value=>JSON.parse(JSON.stringify(value));

test('many document receipts share large map payloads instead of copying them on every reload',async()=>{
  const local=storage(),backend=indexedDB(),context=vm.createContext({localStorage:local});
  vm.runInContext(source,context);
  const forge={dungeons:Array.from({length:4},(_,map)=>({id:'map-'+map,v:2,size:'large',title:'Written map',
    cells:'S'+'s'.repeat(766)+'E',ground:'s'.repeat(768),walls:'.'.repeat(1592),
    things:Object.fromEntries(Array.from({length:766},(_,i)=>[i+1,{text:map+':'+i+':'+'漢'.repeat(150)}]))}))};
  let firstSize=0,last;
  for(let i=0;i<20;i++) {
    const adapter=await context.KidSyncStorage.open({key:'pda-save',namespace:'dm:OTTER-4821',owner:'document-'+i,indexedDB:backend.factory,fresh:true,initial:{progress:{xp:i},forge}});
    const body={progress:{xp:i},forge};
    adapter.setItem('pda-save:sync',JSON.stringify({base:body,migrated:true,adoption:{id:'receipt-'+i,ui:body,remote:body,covered:true}}));
    await adapter.flush();
    const size=Buffer.byteLength(JSON.stringify(backend.read()));
    if(!i) firstSize=size;
    last=adapter;
    const saved=JSON.parse(adapter.getItem('pda-save:sync'));
    assert.equal(saved.base.forge.dungeons[3].things[766].text,forge.dungeons[3].things[766].text);
  }
  const record=backend.read(),finalSize=Buffer.byteLength(JSON.stringify(record));
  assert.equal(Object.keys(record.writers).length,20,'all writer provenance remains recoverable');
  assert.equal(Object.keys(record.receipts).length,20);
  assert.ok(finalSize<firstSize*1.3+100000,`journal grew from ${firstSize} to ${finalSize} bytes`);
  // Hydrate a receipt from the first document after the newest one has saved.
  const base=await last.workingBase({forge:{writer:'document-0',adoption:'receipt-0',sequence:0}});
  assert.deepEqual(plain(base.forge),forge);
});

test('journal v2 upgrade excludes older whole-record adapters and compact storage preserves opaque strings',async()=>{
  const local=storage(),backend=indexedDB(),versions=[],open=backend.factory.open;
  backend.factory.open=(name,version)=>{versions.push(version);return open(name,version);};
  const context=vm.createContext({localStorage:local});vm.runInContext(source,context);
  const options={key:'pda-save',namespace:'dm:OTTER-4821',indexedDB:backend.factory};
  const first=await context.KidSyncStorage.open({...options,owner:'one'});
  first.setItem('pda-save:sync','"a JSON string"');
  first.setItem('pda-save:pending','not JSON');await first.flush();
  const second=await context.KidSyncStorage.open({...options,owner:'two'});
  assert.equal(second.getItem('pda-save:sync'),'"a JSON string"');
  assert.equal(second.getItem('pda-save:pending'),'not JSON');
  assert.deepEqual(versions,[2,2]);
});
