import test from 'node:test';
import assert from 'node:assert/strict';
import { loadDm } from './dm-harness.mjs';

const settle = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
const read = (app, expression) => JSON.parse(app.evaluate(`JSON.stringify(${expression})`));
function setup({ share = null, tested = 1, publishedRev } = {}) {
  const app = loadDm();
  app.evaluate(`(() => {
    const make = id => {
      const M = {W:12,H:9,cells:['S','E',...Array(106).fill(' ')],ground:Array(108).fill('s'),edges:new Map(),things:{}};
      normalize(M); const d = {id,v:2,size:'small',title:id,intro:'',things:{},rev:1,tested:1,share:null}; mapStore(d,M); return d;
    };
    forge.dungeons = [make('Dungeon A'), make('Dungeon B')];
    Object.assign(forge.dungeons[0], ${JSON.stringify({ share, tested, publishedRev })});
    KidSave.code = () => 'OTTER-4821';
    globalThis.requests = [];
    globalThis.fetch = (url, options) => new Promise((resolve, reject) => requests.push({url,method:options.method,body:JSON.parse(options.body),resolve,reject}));
    $('view-forge').hidden = false; forgeEdit('Dungeon A');
  })()`);
  return app;
}
async function reply(app, index, { status = 201, code = 'FOX-1234' } = {}) {
  app.evaluate(`requests[${index}].resolve({status:${status},ok:${status >= 200 && status < 300},json:async()=>({code:'${code}'})});`);
  await settle();
}
function rename(app, title) {
  app.element('fe-title').value = title; app.element('fe-title').dispatchEvent({type:'input'});
}
async function beat(app) {
  app.element('fe-test').click(); await app.evaluate('fpMove(1)'); app.evaluate("forgeEdit('Dungeon A')");
}

test('sharing requires the current revision to be tested, and only a successful response records publication', async () => {
  const app = setup({ tested:0 });
  app.element('fe-share').click();
  assert.equal(app.evaluate('requests.length'), 0);
  assert.match(app.element('fe-note').textContent, /Beat your own dungeon first/);
  await beat(app); app.element('fe-share').click();
  assert.equal(app.evaluate('requests.length'), 1);
  assert.equal(app.evaluate('forge.dungeons[0].publishedRev'), undefined);
  assert.equal(app.evaluate('requests[0].method'), 'POST');
  assert.equal(app.evaluate('requests[0].body.data.title'), 'Dungeon A');
  await reply(app, 0);
  assert.deepEqual(read(app, '({share:forge.dungeons[0].share,publishedRev:forge.dungeons[0].publishedRev})'), {share:'FOX-1234',publishedRev:1});
  assert.match(app.evaluate('forgeStatus(forge.dungeons[0])'), / · Shared$/);
  assert.match(app.element('fe-note').textContent, /FOX-1234/);
});

test('retesting an edited published map does not claim that its new revision was shared', async () => {
  const app = setup({ share:'FOX-1234', publishedRev:1 });
  rename(app, 'A changed map'); await beat(app);
  assert.equal(app.evaluate('forge.dungeons[0].tested'), 2);
  assert.equal(app.evaluate('forge.dungeons[0].publishedRev'), 1);
  assert.match(app.evaluate('forgeStatus(forge.dungeons[0])'), /Shared, changed since/);
  app.element('fe-share').click(); assert.equal(app.evaluate('requests[0].method'), 'PUT');
  await reply(app, 0, {status:204});
  assert.equal(app.evaluate('forge.dungeons[0].publishedRev'), 2);
  assert.match(app.evaluate('forgeStatus(forge.dungeons[0])'), / · Shared$/);
});

test('old saves with a share code require a new acknowledgement before claiming the current map is published', async () => {
  const app = setup({ share:'FOX-1234' });
  assert.match(app.evaluate('forgeStatus(forge.dungeons[0])'), /share again/);
  app.element('fe-share').click(); await reply(app, 0, {status:204});
  assert.equal(app.evaluate('forge.dungeons[0].publishedRev'), 1);
  assert.match(app.evaluate('forgeStatus(forge.dungeons[0])'), / · Shared$/);
});

test('one dungeon cannot send overlapping publications, and an old response cannot publish its newer edits', async () => {
  const app = setup({ share:'FOX-1234', publishedRev:1 });
  app.element('fe-share').click(); app.element('fe-share').click();
  assert.equal(app.evaluate('requests.length'), 1);
  rename(app, 'The newer map'); await beat(app); app.element('fe-share').click();
  assert.equal(app.evaluate('requests.length'), 1, 'a pending older PUT must finish before another PUT can start');
  await reply(app, 0, {status:204});
  assert.equal(app.evaluate('forge.dungeons[0].publishedRev'), 1);
  assert.match(app.element('fe-note').textContent, /earlier version/);
  assert.match(app.evaluate('forgeStatus(forge.dungeons[0])'), /changed since/);
  app.element('fe-share').click();
  assert.equal(app.evaluate('requests.length'), 2);
  assert.equal(app.evaluate('requests[1].body.data.title'), 'The newer map');
  await reply(app, 1, {status:204});
  assert.equal(app.evaluate('forge.dungeons[0].publishedRev'), 2);
});

test('independent dungeons may share while pending replies stay out of another dungeon’s editor', async () => {
  const app = setup(); app.element('fe-share').click();
  app.evaluate("forgeEdit('Dungeon B')"); app.element('fe-share').click();
  assert.equal(app.evaluate('requests.length'), 2);
  await reply(app, 0);
  assert.equal(app.element('fe-note').textContent, 'Sharing…');
  assert.equal(app.evaluate('forge.dungeons[0].share'), 'FOX-1234');
  assert.equal(app.evaluate('forge.dungeons[1].share'), null);
  await reply(app, 1, {code:'OWL-4567'});
  assert.match(app.element('fe-note').textContent, /OWL-4567/);
  assert.doesNotMatch(app.element('fe-note').textContent, /FOX-1234/);
});

test('a successful pending share updates the current saved object without certifying different same-revision content', async () => {
  const app = setup(); app.element('fe-share').click();
  app.evaluate(`forge.dungeons[0] = {...forge.dungeons[0],title:'Another device changed this map'}; forgeEdit('Dungeon A');`);
  await reply(app, 0);
  assert.equal(app.evaluate('forge.dungeons[0].share'), 'FOX-1234');
  assert.equal(app.evaluate('forge.dungeons[0].publishedRev'), null);
  assert.doesNotMatch(app.evaluate('forgeStatus(forge.dungeons[0])'), / · Shared$/);
  assert.match(app.element('fe-note').textContent, /earlier version/);
});

test('failed shares release the per-dungeon lock and cannot overwrite another editor’s notice', async () => {
  const app = setup(); app.element('fe-share').click(); app.evaluate("forgeEdit('Dungeon B')");
  app.evaluate("requests[0].reject(new Error('offline'));"); await settle();
  assert.equal(app.element('fe-note').textContent, '');
  app.evaluate("forgeEdit('Dungeon A')"); app.element('fe-share').click();
  assert.equal(app.evaluate('requests.length'), 2);
  await reply(app, 1);
  assert.equal(app.evaluate('forge.dungeons[0].publishedRev'), 1);
});
