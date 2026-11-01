// Forge map domain. Rules are supplied by the app; this module has no DOM, storage or random calls.
(function(root){
'use strict';
function create({ SIZES, GROUNDS, PIECES, TRAPS, monSpan, isPit }){
// ----- The map: squares, and walls on the lines between them -----
// A wall key is "hX,Y" for the line along the top of square X,Y, or "vX,Y" for the line down its left side.
const parseKey = k => { const c = k.indexOf(','); return [k[0], +k.slice(1, c), +k.slice(c + 1)]; };
const wallSides = (t, x, y) => t === 'h' ? [[x, y - 1], [x, y]] : [[x - 1, y], [x, y]];
const wallCount = (W, H) => W * (H + 1) + (W + 1) * H;
function wallKey(W, H, i){ if(i < W * (H + 1)) return 'h' + (i % W) + ',' + Math.floor(i / W); i -= W * (H + 1); return 'v' + (i % (W + 1)) + ',' + Math.floor(i / (W + 1)); }
function wallIndex(W, H, k){ const [t, x, y] = parseKey(k); return t === 'h' ? y * W + x : W * (H + 1) + y * (W + 1) + x; }
// One character per wall: what it is made of, the door in it, and whether it was drawn by hand.
// Hand-drawn walls stay when there is floor on both sides; the automatic ones come down.
const WALL_M = ['stone','cave','wood','bars'], DOOR_K = ['','door','locked','portcullis','secret'];
const WALL_CH = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmn';
function decodeWalls(W, H, s){
  const m = new Map();
  for(let i = 0; i < s.length; i++){
    const n = WALL_CH.indexOf(s[i]);
    if(n >= 0) m.set(wallKey(W, H, i), { m: WALL_M[Math.floor(n / 10)], door: DOOR_K[Math.floor(n % 10 / 2)] || null, manual: n % 2 === 1 });
  }
  return m;
}
function encodeWalls(M){
  const out = new Array(wallCount(M.W, M.H)).fill('.');
  M.edges.forEach((e, k) => { out[wallIndex(M.W, M.H, k)] = WALL_CH[WALL_M.indexOf(e.m) * 10 + Math.max(0, DOOR_K.indexOf(e.door || '')) * 2 + (e.manual ? 1 : 0)]; });
  return out.join('');
}
// Map fields are independent working data: { W, H, cells:[], ground:[], edges:Map, things }.
// mapRead owns arrays and edges, but borrows things for callers that only read them.
// mapOf is the editor/play boundary and owns every mutable field, including piece metadata.
const cloneThings = things => JSON.parse(JSON.stringify(things || {}));
function mapRead(d){ const S = SIZES[d.size] || SIZES.small; return { W:S.w, H:S.h, cells:[...d.cells], ground:[...d.ground], edges:decodeWalls(S.w, S.h, d.walls || ''), things:d.things || {} }; }
function mapOf(d){ const M = mapRead(d); M.things = cloneThings(M.things); return M; }
// Commit every map field together. Later working edits cannot alter this saved snapshot.
function mapStore(d, M){ d.cells = M.cells.join(''); d.ground = M.ground.join(''); d.walls = encodeWalls(M); d.things = cloneThings(M.things); return d; }
const inMap = (M, x, y) => x >= 0 && y >= 0 && x < M.W && y < M.H;
const isFloor = (M, x, y) => inMap(M, x, y) && M.cells[y * M.W + x] !== ' ';
const cellWalls = (x, y) => ['h' + x + ',' + y, 'h' + x + ',' + (y + 1), 'v' + x + ',' + y, 'v' + (x + 1) + ',' + y];
// The squares beside square i, each with the wall line between them: [[j, key]].
function steps(M, i){
  const x = i % M.W, y = Math.floor(i / M.W), out = [];
  if(y > 0) out.push([i - M.W, 'h' + x + ',' + y]);
  if(x < M.W - 1) out.push([i + 1, 'v' + (x + 1) + ',' + y]);
  if(y < M.H - 1) out.push([i + M.W, 'h' + x + ',' + (y + 1)]);
  if(x > 0) out.push([i - 1, 'v' + x + ',' + y]);
  return out;
}
function edgeBetween(M, a, b){ const s = steps(M, a).find(([j]) => j === b); return s ? s[1] : null; }
// Floor beside rock always has a wall, made of what the floor is. A wall between two floors stays
// only if it was drawn by hand, and a wall with no floor on either side goes.
function normalize(M){
  const one = (t, x, y) => {
    const k = t + x + ',' + y, [[ax, ay], [bx, by]] = wallSides(t, x, y), a = isFloor(M, ax, ay), b = isFloor(M, bx, by), e = M.edges.get(k);
    if(a && b){ if(e && !e.manual) M.edges.delete(k); }
    else if(a || b){ if(!e){ const [fx, fy] = a ? [ax, ay] : [bx, by]; M.edges.set(k, { m:(GROUNDS[M.ground[fy * M.W + fx]] || GROUNDS.s).wall, door:null, manual:false }); } }
    else if(e) M.edges.delete(k);
  };
  for(let y = 0; y <= M.H; y++) for(let x = 0; x < M.W; x++) one('h', x, y);
  for(let y = 0; y < M.H; y++) for(let x = 0; x <= M.W; x++) one('v', x, y);
}
// Rooms are floor squares with no wall between them. Walls and doors split them apart.
function forgeRooms(M){
  const roomOf = new Array(M.cells.length).fill(-1), rooms = [];
  for(let i = 0; i < M.cells.length; i++){
    if(roomOf[i] >= 0 || M.cells[i] === ' ') continue;
    const r = { cells:[], walls:0, wallKeys:new Set(), doors:[], mats:new Set(), minX:M.W, maxX:-1, minY:M.H, maxY:-1 }, stack = [i];
    roomOf[i] = rooms.length;
    while(stack.length){
      const j = stack.pop(), x = j % M.W, y = Math.floor(j / M.W);
      r.cells.push(j); r.minX = Math.min(r.minX, x); r.maxX = Math.max(r.maxX, x); r.minY = Math.min(r.minY, y); r.maxY = Math.max(r.maxY, y);
      steps(M, j).forEach(([n, k]) => { if(roomOf[n] < 0 && M.cells[n] !== ' ' && !M.edges.has(k)){ roomOf[n] = rooms.length; stack.push(n); } });
      cellWalls(x, y).forEach(k => { const e = M.edges.get(k); if(e && !r.wallKeys.has(k)){ r.wallKeys.add(k); r.walls++; r.mats.add(e.m); if(e.door) r.doors.push(e.door); } });
    }
    r.w = r.maxX - r.minX + 1; r.h = r.maxY - r.minY + 1; r.rect = r.cells.length === r.w * r.h;
    const floor = new Set(r.cells);
    r.perimeter = r.cells.reduce((sum, j) => sum + 4 - steps(M, j).filter(([n]) => floor.has(n)).length, 0);
    rooms.push(r);
  }
  return { rooms, roomOf };
}
// The squares a monster covers when it stands with its top-left corner on square i, or null unless
// they are all floor with no walls running between them.
function footprint(M, i, n, opened){
  const x0 = i % M.W, y0 = Math.floor(i / M.W), out = [];
  for(let y = y0; y < y0 + n; y++) for(let x = x0; x < x0 + n; x++){
    if(!isFloor(M, x, y)) return null;
    if(x > x0 && M.edges.has('v' + x + ',' + y) && !(opened && opened.has('v' + x + ',' + y))) return null;
    if(y > y0 && M.edges.has('h' + x + ',' + y) && !(opened && opened.has('h' + x + ',' + y))) return null;
    out.push(y * M.W + x);
  }
  return out;
}
// Which monster is on each square: Map(square → the square its monster is listed on).
function monsterSquares(M){
  const occ = new Map();
  M.cells.forEach((c, i) => { if(c === 'm') (footprint(M, i, monSpan((M.things[i] || {}).mon)) || [i]).forEach(j => occ.set(j, i)); });
  return occ;
}
// Replacement may reuse its own footprint, but cannot cover another piece or monster.
function monsterFits(M, i, name, replacing = -1){
  const f = footprint(M, i, monSpan(name)), occ = monsterSquares(M);
  return !!f && f.every(j => (M.cells[j] === '.' || j === replacing) && (!occ.has(j) || occ.get(j) === replacing));
}
// A pit can cover several squares; stepping on any of them opens all of it.
function pitGroup(M, i){
  const seen = new Set([i]), stack = [i], trap = M.things[i];
  while(stack.length){ const j = stack.pop(); steps(M, j).forEach(([n, k]) => {
    const next = M.things[n];
    if(!seen.has(n) && M.cells[n] === 't' && isPit(next) && next.trap === trap.trap && next.depth === trap.depth && !M.edges.has(k)){ seen.add(n); stack.push(n); }
  }); }
  return [...seen];
}

// A version 1 dungeon: 12 × 9 squares, rock squares as walls and locked doors on squares of their
// own. Its floor becomes stone, and each door square becomes floor with a locked door on the line
// that splits the two rooms it joined.
function forgeUpgrade(d){
  if(d.v === 2 && SIZES[d.size]) return d;
  const W = 12, H = 9, cells = [...String(d.cells || '').slice(0, W * H).padEnd(W * H, ' ')], things = d.things || {}, doors = [];
  cells.forEach((c, i) => { if(c === 'D'){ cells[i] = '.'; doors.push(i); } else if(!PIECES[c]) cells[i] = ' '; });
  const M = { W, H, cells, ground:new Array(W * H).fill('s'), edges:new Map(), things };
  normalize(M);
  doors.forEach(i => {
    const x = i % W, y = Math.floor(i / W), f = (a, b) => isFloor(M, a, b);
    const k = f(x - 1, y) && f(x + 1, y) ? 'v' + x + ',' + y : f(x, y - 1) && f(x, y + 1) ? 'h' + x + ',' + y
      : f(x - 1, y) ? 'v' + x + ',' + y : f(x + 1, y) ? 'v' + (x + 1) + ',' + y : f(x, y - 1) ? 'h' + x + ',' + y : 'h' + x + ',' + (y + 1);
    M.edges.set(k, { m:'stone', door:'locked', manual:true });
  });
  cells.forEach((c, i) => { if(c === 't' && !(things[i] && TRAPS[things[i].trap])) things[i] = { trap:'spike' }; });
  return Object.assign(d, { v:2, size:'small', cells:cells.join(''), ground:M.ground.join(''), walls:encodeWalls(M), things });
}
return { parseKey, wallSides, wallCount, wallKey, wallIndex, WALL_M, DOOR_K, WALL_CH, decodeWalls, encodeWalls, mapRead, mapOf, mapStore, inMap, isFloor, cellWalls, steps, edgeBetween, normalize, forgeRooms, footprint, monsterSquares, monsterFits, pitGroup, forgeUpgrade };
}
root.KidForgeMap = { create };
})(globalThis);
