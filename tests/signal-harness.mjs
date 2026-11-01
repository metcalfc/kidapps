import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import vm from 'node:vm';

const appUrl = process.env.SIGNAL_APP_HTML ? pathToFileURL(process.env.SIGNAL_APP_HTML) : new URL('../web/signal/index.html', import.meta.url);
const html = readFileSync(appUrl, 'utf8');

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
    this.style = {};
    this.listeners = {};
    this.hidden = false;
    this.disabled = false;
    this.value = '';
    this.className = '';
    this.id = '';
    this.clientWidth = 0; // Canvas layout is outside this unit test harness.
    this.offsetWidth = this.offsetHeight = 0;
    this.scrollLeft = this.scrollTop = 0;
    this._text = '';
    this.classList = {
      add: (...names) => { this.className = [...new Set([...this.className.split(/\s+/).filter(Boolean), ...names])].join(' '); },
      remove: (...names) => { this.className = this.className.split(/\s+/).filter(n => !names.includes(n)).join(' '); },
      contains: name => this.className.split(/\s+/).includes(name),
      toggle: (name, force) => { const on = force ?? !this.classList.contains(name); if (on) this.classList.add(name); else this.classList.remove(name); return on; },
    };
  }
  set textContent(value) {
    this.children.forEach(c => { c.parentElement = null; });
    this.children = [];
    this._text = String(value ?? '');
  }
  get textContent() { return this._text + this.children.map(c => c.textContent).join(''); }
  set innerHTML(value) { this.textContent = value; }
  get innerHTML() { return this.textContent; }
  get childNodes() {
    if (!this._text) return this.children;
    const text = new Element('#text', this.ownerDocument); text._text = this._text;
    return [text, ...this.children];
  }
  get firstChild() { return this.children[0] ?? null; }
  get lastChild() { return this.children.at(-1) ?? null; }
  append(...items) {
    for (const item of items) {
      const child = typeof item === 'object' ? item : this.ownerDocument.createTextNode(item);
      child.remove(); child.parentElement = this; this.children.push(child);
    }
  }
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
  removeAttribute(name) { delete this.attributes[name]; if (name === 'disabled') this.disabled = false; }
  addEventListener(type, callback, options = {}) {
    const capture = options === true || !!options.capture;
    (this.listeners[type] ??= []).push({callback, capture});
  }
  dispatchEvent(event) {
    event.target ??= this; event.defaultPrevented ??= false;
    let stopped = false, immediate = false;
    event.preventDefault = () => { if (event.cancelable !== false) event.defaultPrevented = true; };
    event.stopPropagation = () => { stopped = true; };
    event.stopImmediatePropagation = () => { stopped = true; immediate = true; };
    const path = [];
    for (let node = this.parentElement; node; node = node.parentElement) path.push(node);
    const invoke = (node, capture, phase) => {
      event.currentTarget = node; event.eventPhase = phase;
      for (const listener of node.listeners[event.type] ?? []) {
        if (listener.capture === capture) listener.callback(event);
        if (immediate) break;
      }
    };
    for (const node of [...path].reverse()) {
      invoke(node, true, 1);
      if (stopped) break;
    }
    if (!stopped) {
      invoke(this, true, 2);
      if (!immediate) invoke(this, false, 2);
    }
    if (event.bubbles && !stopped) {
      for (const node of path) { invoke(node, false, 3); if (stopped) break; }
    }
    event.currentTarget = null; event.eventPhase = 0;
    return !event.defaultPrevented;
  }
  click() { if (!this.disabled) this.dispatchEvent({ type: 'click', bubbles: true, cancelable: true }); }
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
  getBoundingClientRect() { return { left: 0, top: 0, bottom: 0, right: 0, width: 0, height: 0 }; }
  getContext() { return new Proxy({}, { get: () => () => {} }); }
}

function matches(element, selector) {
  const attr = selector.match(/^\[([\w-]+)(?:=["']?([^"'\]]+)["']?)?\]$/);
  if (attr) return element.getAttribute(attr[1]) !== null && (attr[2] === undefined || element.getAttribute(attr[1]) === attr[2]);
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
  const markup = html.slice(html.indexOf('<div class="sky">'), html.indexOf('<script>'));
  const stack = [document];
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
  document.activeElement = document;
  return document;
}

function storage() {
  const values = new Map();
  return { getItem: k => values.get(k) ?? null, setItem: (k, v) => values.set(k, String(v)), removeItem: k => values.delete(k) };
}

export function loadSignal({ hash = '', boot = false, seed = 12345 } = {}) {
  const document = makeDocument(); document.documentElement = {lang:'en'}; document.createElementNS = (_ns, tag) => document.createElement(tag);
  let queued = [], state = seed >>> 0, clock = 0, nextTimer = 0;
  const timers = new Map();
  const schedule = (fn, delay = 0) => { const id = ++nextTimer; timers.set(id, {fn, at:clock + delay, delay}); return id; };
  const math = Object.create(Math);
  math.random = () => {
    if (queued.length) return queued.shift();
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
  const location = { hash };
  const context = { TextEncoder,
    document, location, Math: math, console,
    localStorage: storage(), sessionStorage: storage(),
    history: { replaceState: (_state, _title, url) => { location.hash = url; } },
    setTimeout: schedule, clearTimeout: id => timers.delete(id), setInterval: () => 1, matchMedia: () => ({matches:true}), navigator: {},
    performance: { now: () => clock }, requestAnimationFrame: fn => schedule(() => fn(clock), 16),
    addEventListener: () => {}, scrollTo: () => {},
    innerWidth: 1280, innerHeight: 900, devicePixelRatio: 1,
    ResizeObserver: class { observe() {} },
    Image: class {},
    KidSave: { code: () => null, normalize: value => value },
  };
  context.window = context;
  vm.createContext(context);
  const storiesUrl = new URL('../web/signal/index.html', import.meta.url);
  for (const name of ['merge.js','sync.js']) vm.runInContext(readFileSync(new URL('../web/shared/' + name, import.meta.url), 'utf8'), context);
  for (const name of ['story-fr.js','story-es.js']) vm.runInContext(readFileSync(new URL(name, storiesUrl), 'utf8'), context);
  let script = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map(m => m[1]).find(s => s.includes('const STORY_EN'));
  if (!script) throw new Error('Signal production script was not found');
  if (!boot) script = script.slice(0, script.indexOf('/* ---------------- boot ---------------- */')) + '\n})();';
  script = script.replace(/\}\)\(\);\s*$/, 'globalThis.__signalEval = source => eval(source);\n})();');
  vm.runInContext(script, context, { filename: appUrl.pathname, timeout: 1000 });
  return {
    document, location, context,
    // Direct eval is injected only into the VM copy, inside the production IIFE.
    evaluate: source => context.__signalEval(source),
    random: values => { queued = [...values]; },
    pressKey: (element, key) => {
      element.focus();
      const accepted = element.dispatchEvent({type:'keydown', key, bubbles:true, cancelable:true});
      if (accepted && element.tagName === 'BUTTON' && (key === 'Enter' || key === ' ')) element.click();
      element.dispatchEvent({type:'keyup', key, bubbles:true});
    },
    timers: () => [...timers.values()],
    advance: ms => {
      const target = clock + ms;
      for (let runs = 0; runs < 1000; runs++) {
        const next = [...timers.entries()].filter(([, t]) => t.at <= target).sort((a,b) => a[1].at - b[1].at)[0];
        if (!next) { clock = target; return; }
        clock = next[1].at; timers.delete(next[0]); next[1].fn();
      }
      throw new Error('Timer queue did not settle');
    },
    element: id => {
      const element = document.getElementById(id);
      if (!element) throw new Error('Missing DOM element: ' + id);
      return element;
    },
  };
}
