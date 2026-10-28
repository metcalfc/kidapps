import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import vm from 'node:vm';

const appUrl = process.env.CHAIN_APP_HTML ? pathToFileURL(process.env.CHAIN_APP_HTML) : new URL('../web/chain/index.html', import.meta.url);
const html = readFileSync(appUrl, 'utf8');
const sharedScripts = ['merge.js', 'sync.js', 'sync-store.js'].map(name => ({name, source:readFileSync(new URL('../web/shared/' + name, import.meta.url),'utf8')}));
let deviceNumber = 0;

// A small DOM for the app's event-driven tests, not a rendering substitute.
// Production handlers, navigation, question grading and initialization all run.
class Element {
  constructor(tag, ownerDocument) {
    this.tagName = tag.toUpperCase();
    this.ownerDocument = ownerDocument;
    this.children = [];
    this.parentElement = null;
    this.attributes = {};
    this.dataset = {};
    this.style = {setProperty() {}};
    this.listeners = {};
    this.hidden = false;
    this.disabled = false;
    this.value = '';
    this.className = '';
    this.id = '';
    this.clientWidth = 0; // Canvas layout is outside this unit test harness.
    this.scrollLeft = this.scrollTop = 0;
    this._text = '';
    this.classList = {
      add: (...names) => { this.className = [...new Set([...this.className.split(/\s+/).filter(Boolean), ...names])].join(' '); },
      remove: (...names) => { this.className = this.className.split(/\s+/).filter(n => !names.includes(n)).join(' '); },
      toggle: (name, force) => { const present = this.className.split(/\s+/).includes(name); const add = force === undefined ? !present : force; if (add) this.classList.add(name); else this.classList.remove(name); },
      contains: name => this.className.split(/\s+/).includes(name),
    };
  }
  set textContent(value) {
    this.children.forEach(c => { c.parentElement = null; });
    this.children = [];
    this._text = String(value ?? '');
  }
  get textContent() { return this._text + this.children.map(c => c.textContent).join(''); }
  set innerHTML(value) { this.textContent = ''; parseMarkup(String(value), this); }
  get innerHTML() { return this.textContent; }
  get firstChild() { return this.children[0] ?? null; }
  get lastChild() { return this.children.at(-1) ?? null; }
  append(...items) {
    for (const item of items) {
      const child = typeof item === 'object' ? item : this.ownerDocument.createTextNode(item);
      child.remove(); child.parentElement = this; this.children.push(child);
    }
  }
  appendChild(child) { this.append(child); return child; }
  prepend(...items) {
    for (const item of items.reverse()) {
      const child = typeof item === 'object' ? item : this.ownerDocument.createTextNode(item);
      child.remove(); child.parentElement = this; this.children.unshift(child);
    }
  }
  remove() {
    if (this.parentElement) {
      const siblings = this.parentElement.children;
      siblings.splice(siblings.indexOf(this), 1);
      this.parentElement = null;
    }
  }
  setAttribute(name, value) {
    this.attributes[name] = String(value);
    if (name === 'id') this.id = String(value);
    if (name === 'class') this.className = String(value);
    if (name === 'value') this.value = String(value);
    if (name === 'hidden') this.hidden = true;
    if (name === 'disabled') this.disabled = true;
    if (name.startsWith('data-')) this.dataset[name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = String(value);
  }
  getAttribute(name) {
    if (name === 'class') return this.className;
    if (name === 'id') return this.id;
    return this.attributes[name] ?? null;
  }
  removeAttribute(name) { delete this.attributes[name]; }
  addEventListener(type, callback) { (this.listeners[type] ??= []).push(callback); }
  removeEventListener(type, callback) { this.listeners[type] = (this.listeners[type] ?? []).filter(item => item !== callback); }
  dispatchEvent(event) {
    event.target ??= this; event.preventDefault ??= () => {};
    for (const callback of this.listeners[event.type] ?? []) callback(event);
    return true;
  }
  click() { if (!this.disabled) this.dispatchEvent({ type: 'click', detail: 0 }); }
  focus() { this.ownerDocument.activeElement = this; }
  select() {}
  closest(selector) {
    for (let node = this; node; node = node.parentElement) if (matches(node, selector)) return node;
    return null;
  }
  querySelectorAll(selector) {
    const tokens = selector.trim().split(/\s+/);
    const results = [];
    const visit = node => {
      for (const child of node.children) {
        if (matches(child, tokens.at(-1))) {
          let ancestor = child.parentElement, i = tokens.length - 2;
          while (ancestor && i >= 0) {
            if (matches(ancestor, tokens[i])) i--;
            ancestor = ancestor.parentElement;
          }
          if (i < 0) results.push(child);
        }
        visit(child);
      }
    };
    visit(this); return results;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
  getBoundingClientRect() { return { left: 0, top: 0, width: 0, height: 0 }; }
  getContext() { return new Proxy({}, { get: () => () => {} }); }
}

function matches(element, selector) {
  const attribute = selector.match(/^\[([\w-]+)(?:=["']?([^"'\]]+)["']?)?\]$/);
  if (attribute) return element.getAttribute(attribute[1]) !== null && (attribute[2] === undefined || element.getAttribute(attribute[1]) === attribute[2]);
  if (selector.startsWith('.')) return element.className.split(/\s+/).includes(selector.slice(1));
  if (selector.startsWith('#')) return element.id === selector.slice(1);
  return element.tagName.toLowerCase() === selector.toLowerCase();
}

function makeDocument() {
  const document = new Element('document', null);
  document.ownerDocument = document;
  document.createElement = tag => new Element(tag, document);
  document.createTextNode = text => { const n = new Element('#text', document); n.textContent = text; return n; };
  document.getElementById = id => document.querySelector('#' + id);
  document.visibilityState = 'visible';
  parseMarkup(html.slice(html.indexOf('<div class="glow">'), html.indexOf('<script>')), document);
  document.documentElement = new Element('html', document);
  document.activeElement = document;
  return document;
}

function parseMarkup(markup, parent) {
  const document = parent.ownerDocument, stack = [parent];
  const voidTags = new Set(['input', 'img', 'br', 'hr', 'meta', 'link']);
  for (const match of markup.matchAll(/<!--[\s\S]*?-->|<\/?([a-z][\w-]*)([^>]*)>|([^<]+)/gi)) {
    if (match[0].startsWith('<!--')) continue;
    if (match[3]) { stack.at(-1).append(document.createTextNode(match[3])); continue; }
    const tag = match[1].toLowerCase();
    if (match[0].startsWith('</')) {
      while (stack.length > 1) { if (stack.pop().tagName.toLowerCase() === tag) break; }
      continue;
    }
    const element = document.createElement(tag);
    for (const a of match[2].matchAll(/([\w-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) {
      element.setAttribute(a[1], a[2] ?? a[3] ?? a[4] ?? '');
    }
    stack.at(-1).append(element);
    if (!voidTags.has(tag) && !match[0].endsWith('/>')) stack.push(element);
  }
}

function storage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return { get length() { return values.size; }, key: i => [...values.keys()][i] ?? null, getItem: k => values.get(k) ?? null, setItem: (k, v) => values.set(k, String(v)), removeItem: k => values.delete(k) };
}

export function loadChain({ hash = '', boot = false, seed = 12345, storageValues = {}, wallTime = Date.UTC(2026, 9, 27, 12), globals = {} } = {}) {
  const document = makeDocument();
  const deviceID = ++deviceNumber; let mutationNumber = 0;
  let queued = [], state = seed >>> 0;
  const math = Object.create(Math);
  math.random = () => {
    if (queued.length) return queued.shift();
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
  const location = { hash };
  let now = 100, wall = wallTime, nextId = 0; const timers = new Map();
  class FakeDate extends Date {
    constructor(...args) { super(...(args.length ? args : [wall])); }
    static now() { return wall; }
  }
  const advance = milliseconds => {
    const target = now + milliseconds;
    for (let count = 0; ; count++) {
      if (count > 100000) throw new Error('Timer loop did not settle');
      const next = [...timers.entries()].filter(([, t]) => t.due <= target).sort((a,b) => a[1].due - b[1].due || a[0] - b[0])[0];
      if (!next) break;
      const [id, task] = next; timers.delete(id);
      wall += task.due - now; now = task.due; task.fn();
    }
    wall += target - now; now = target;
  };
  const context = {
    document, location, Math: math, Date: FakeDate, console,
    matchMedia: () => ({matches:true}), getComputedStyle: () => ({getPropertyValue:()=>'#fff'}),
    crypto:{randomUUID:()=>`chain-test-${deviceID}-mutation-${++mutationNumber}`},
    navigator:{}, performance:{now:()=>now}, innerWidth:1000,
    requestAnimationFrame:()=>1, cancelAnimationFrame:()=>{},
    localStorage: storage(storageValues), sessionStorage: storage(),
    history: { replaceState: (_state, _title, url) => { location.hash = url; } },
    setTimeout: (fn, delay = 0) => { timers.set(++nextId,{fn,due:now + Math.max(0, Number(delay) || 0)}); return nextId; }, clearTimeout: id => timers.delete(id), setInterval: () => ++nextId,
    addEventListener: () => {}, removeEventListener: () => {}, scrollTo: () => {},
    innerHeight: 900, devicePixelRatio: 1,
    ResizeObserver: class { observe() {} },
    Image: class {},
    KidSave: { code: () => null, normalize: value => value },
    ...globals,
  };
  context.window = context;
  vm.createContext(context);
  for (const script of sharedScripts) vm.runInContext(script.source, context, {filename:script.name});
  // A test may substitute only the remote transport; merge and durable sync remain production code.
  Object.assign(context, globals);
  let script = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map(m => m[1]).find(s => s.includes('const BASE'));
  if (!script) throw new Error('Chain production script was not found');
  if (!boot) script = script.slice(0, script.indexOf('/* ---------------- boot ---------------- */')) + '\n})();';
  script = script.replace(/\}\)\(\);\s*$/, 'globalThis.__dmEval = source => eval(source);\n})();');
  vm.runInContext(script, context, { filename: appUrl.pathname, timeout: 1000 });
  return {
    document, location, advance, timers, now: () => now,
    settle: async (turns = 200) => { for(let turn=0;turn<turns;turn++) await Promise.resolve(); },
    // Direct eval is injected only into the VM copy, inside the production IIFE.
    evaluate: source => context.__dmEval(source),
    random: values => { queued = [...values]; },
    element: id => {
      const element = document.getElementById(id);
      if (!element) throw new Error('Missing DOM element: ' + id);
      return element;
    },
  };
}
