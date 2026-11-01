import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../web/shared/sw.js',import.meta.url),'utf8');
const origin = 'https://kidapps.test';
const key = request => new URL(typeof request === 'string' ? request : request.url,origin).href;

function worker({precache=[],network=async request=>new Response('network '+key(request))}={}) {
  const stores = new Map(), listeners = {};
  const caches = {
    async open(name) {
      if(!stores.has(name)) stores.set(name,new Map());
      const entries = stores.get(name);
      return {
        async match(request,{ignoreSearch=false}={}) {
          const wanted = key(request);
          for(const [url,response] of entries) {
            if(url === wanted || (ignoreSearch && url.split('?')[0] === wanted.split('?')[0])) return response.clone();
          }
        },
        async put(request,response) { entries.set(key(request),response.clone()); },
        async addAll(urls) { for(const url of urls) { const response = await network(url); if(!response.ok) throw Error('precache failed'); entries.set(key(url),response.clone()); } },
      };
    },
    async keys() { return [...stores.keys()]; },
    async delete(name) { return stores.delete(name); },
    async match(request,options) { for(const name of stores.keys()) { const hit=await (await this.open(name)).match(request,options); if(hit) return hit; } },
  };
  const context = vm.createContext({
    APP:'dm',VERSION:'new-release',PRECACHE:precache,caches,location:{origin},URL,Response,
    fetch:network,setTimeout:()=>1,
    self:{addEventListener:(name,callback)=>listeners[name]=callback,skipWaiting:async()=>{},clients:{claim:async()=>{}}},
  });
  vm.runInContext(source,context);
  return {
    caches,
    async lifecycle(name) { let work; listeners[name]({waitUntil:value=>work=value}); await work; },
    async fetch(path,{method='GET',mode='cors'}={}) {
      let response;
      listeners.fetch({request:{url:new URL(path,origin).href,method,mode},respondWith:value=>response=value});
      return response && await response;
    },
  };
}

test('shared scripts are read from this app release rather than another app cache',async()=>{
  const app = worker();
  await (await app.caches.open('signal-old')).put('/shared/merge.js',new Response('stale other app'));
  await (await app.caches.open('dm-new-release')).put('/shared/merge.js',new Response('current DM'));
  assert.equal(await (await app.fetch('/shared/merge.js')).text(),'current DM');
});

test('worker does not treat distinct script queries as the same cached resource',async()=>{
  const app = worker();
  await (await app.caches.open('dm-new-release')).put('/dm/module.js?v=1',new Response('old query'));
  assert.match(await (await app.fetch('/dm/module.js?v=2')).text(),/network .*v=2/);
});

test('an offline navigation uses this release shell even if another cache has the same URL',async()=>{
  const app = worker({network:async()=>{throw Error('offline');}});
  await (await app.caches.open('signal-old')).put('/dm/',new Response('stale shell'));
  await (await app.caches.open('dm-new-release')).put('/dm/',new Response('current shell'));
  assert.equal(await (await app.fetch('/dm/',{mode:'navigate'})).text(),'current shell');
});

test('installed release precaches matching scripts and reopens offline after activation',async()=>{
  const script = '/assets/new-release/dm/forge-map.js';
  let online = true;
  const app = worker({precache:['/dm/',script],network:async request=>{
    if(!online) throw Error('offline');
    return new Response(key(request).endsWith('/dm/') ? `<script src="${script}"></script>` : 'current map module');
  }});
  await (await app.caches.open('dm-old')).put('/dm/forge-map.js',new Response('old module'));
  await app.lifecycle('install'); await app.lifecycle('activate'); online = false;
  assert.deepEqual(await app.caches.keys(),['dm-new-release']);
  assert.match(await (await app.fetch('/dm/',{mode:'navigate'})).text(),/assets\/new-release/);
  assert.equal(await (await app.fetch(script)).text(),'current map module');
  assert.equal(await app.fetch('/dm/api/saves/OTTER-4821/pda-save'),undefined);
  assert.equal(await app.fetch('/dm/api/shares',{method:'POST'}),undefined);
});
