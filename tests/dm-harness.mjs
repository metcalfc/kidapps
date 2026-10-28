import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import vm from 'node:vm';

const appUrl = process.env.DM_APP_HTML ? pathToFileURL(process.env.DM_APP_HTML) : new URL('../web/dm/index.html', import.meta.url);
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
    this.scrollLeft = this.scrollTop = 0;
    this._text = '';
    this.classList = {
      add: (...names) => { this.className = [...new Set([...this.className.split(/\s+/).filter(Boolean), ...names])].join(' '); },
      remove: (...names) => { this.className = this.className.split(/\s+/).filter(n => !names.includes(n)).join(' '); },
      contains: name => this.className.split(/\s+/).includes(name),
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
  removeAttribute(name) { delete this.attributes[name]; }
  addEventListener(type, callback) { (this.listeners[type] ??= []).push(callback); }
  dispatchEvent(event) {
    event.target ??= this; event.preventDefault ??= () => {};
    for (const callback of this.listeners[event.type] ?? []) callback(event);
    return true;
  }
  click() { if (!this.disabled) this.dispatchEvent({ type: 'click' }); }
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
  const markup = html.slice(html.indexOf('<div class="wrap">'), html.indexOf('<script>'));
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

export function loadDm({ hash = '', boot = false, seed = 12345 } = {}) {
  const document = makeDocument();
  let queued = [], state = seed >>> 0;
  const math = Object.create(Math);
  math.random = () => {
    if (queued.length) return queued.shift();
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
  const location = { hash };
  const context = {
    document, location, Math: math, console,
    localStorage: storage(), sessionStorage: storage(),
    history: { replaceState: (_state, _title, url) => { location.hash = url; } },
    setTimeout: () => 1, clearTimeout: () => {},
    addEventListener: () => {}, scrollTo: () => {},
    innerHeight: 900, devicePixelRatio: 1,
    ResizeObserver: class { observe() {} },
    Image: class {},
    KidSave: { code: () => null, normalize: value => value },
  };
  context.window = context;
  vm.createContext(context);
  let script = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map(m => m[1]).find(s => s.includes('const MODULES'));
  if (!script) throw new Error('DM production script was not found');
  if (!boot) script = script.slice(0, script.indexOf('// ---------- Boot ----------')) + '\n})();';
  script = script.replace(/\}\)\(\);\s*$/, 'globalThis.__dmEval = source => eval(source);\n})();');
  vm.runInContext(script, context, { filename: appUrl.pathname, timeout: 1000 });
  return {
    document, location,
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
