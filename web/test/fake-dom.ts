// A small stand-in for the browser DOM, enough for React's client renderer
// to mount, update and unmount ordinary elements and text — so a test can
// render a real tree with `createRoot`, run its effects, and read back what
// it drew (`textOf`). Not a browser: no layout, no styles, no events beyond
// listeners being kept. Install it once per test file, before React loads.

type Listener = (event: unknown) => void;

export class FakeNode {
  childNodes: FakeNode[] = [];
  parentNode: FakeNode | null = null;
  ownerDocument: FakeDocument;
  attributes = new Map<string, string>();
  style: Record<string, string> & { setProperty?: (k: string, v: string) => void; removeProperty?: (k: string) => void } = {};
  private listeners = new Map<string, Set<Listener>>();
  namespaceURI = "http://www.w3.org/1999/xhtml";
  constructor(
    readonly nodeType: number,
    readonly nodeName: string,
    owner: FakeDocument | null,
    public data = "",
  ) {
    this.ownerDocument = owner ?? (this as unknown as FakeDocument);
    this.style.setProperty = (k, v) => void (this.style[k] = v);
    this.style.removeProperty = (k) => void delete this.style[k];
  }
  get tagName(): string {
    return this.nodeName;
  }
  get localName(): string {
    return this.nodeName.toLowerCase();
  }
  get firstChild(): FakeNode | null {
    return this.childNodes[0] ?? null;
  }
  get lastChild(): FakeNode | null {
    return this.childNodes[this.childNodes.length - 1] ?? null;
  }
  get nextSibling(): FakeNode | null {
    if (!this.parentNode) return null;
    const siblings = this.parentNode.childNodes;
    return siblings[siblings.indexOf(this) + 1] ?? null;
  }
  get nodeValue(): string {
    return this.data;
  }
  set nodeValue(v: string) {
    this.data = v;
  }
  get textContent(): string {
    return this.nodeType === 3 ? this.data : this.childNodes.map((c) => c.textContent).join("");
  }
  set textContent(v: string) {
    if (this.nodeType === 3) this.data = v;
    else {
      for (const c of this.childNodes) c.parentNode = null;
      this.childNodes = v ? [this.ownerDocument.createTextNode(v)] : [];
      for (const c of this.childNodes) c.parentNode = this;
    }
  }
  appendChild(child: FakeNode): FakeNode {
    child.parentNode?.removeChild(child);
    this.childNodes.push(child);
    child.parentNode = this;
    return child;
  }
  insertBefore(child: FakeNode, before: FakeNode | null): FakeNode {
    if (!before) return this.appendChild(child);
    child.parentNode?.removeChild(child);
    this.childNodes.splice(this.childNodes.indexOf(before), 0, child);
    child.parentNode = this;
    return child;
  }
  removeChild(child: FakeNode): FakeNode {
    const i = this.childNodes.indexOf(child);
    if (i >= 0) this.childNodes.splice(i, 1);
    child.parentNode = null;
    return child;
  }
  setAttribute(name: string, value: unknown): void {
    this.attributes.set(name, String(value));
  }
  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }
  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }
  hasAttribute(name: string): boolean {
    return this.attributes.has(name);
  }
  setAttributeNS(_ns: string, name: string, value: unknown): void {
    this.setAttribute(name, value);
  }
  removeAttributeNS(_ns: string, name: string): void {
    this.removeAttribute(name);
  }
  addEventListener(type: string, fn: Listener): void {
    (this.listeners.get(type) ?? this.listeners.set(type, new Set()).get(type)!).add(fn);
  }
  removeEventListener(type: string, fn: Listener): void {
    this.listeners.get(type)?.delete(fn);
  }
  contains(other: FakeNode | null): boolean {
    for (let n = other; n; n = n.parentNode) if (n === this) return true;
    return false;
  }
  getRootNode(): FakeNode {
    let n: FakeNode = this;
    while (n.parentNode) n = n.parentNode;
    return n;
  }
  /**
   * Enough of `Element.matches` for the libraries mounted here (Base UI's
   * select asks `matches("html,body")`): a list of tag names. Anything richer —
   * attributes, pseudo-classes — never matches.
   */
  matches(selector: string): boolean {
    return selector.split(",").some((s) => s.trim().toUpperCase() === this.nodeName);
  }
  closest(selector: string): FakeNode | null {
    for (let n: FakeNode | null = this; n; n = n.parentNode) if (n.nodeType === 1 && n.matches(selector)) return n;
    return null;
  }
  /** No selector engine: a query finds nothing (a select's portal looks for tabbables in it). */
  querySelector(): null {
    return null;
  }
  querySelectorAll(): FakeNode[] {
    return [];
  }
  focus(): void {}
  blur(): void {}
  getBoundingClientRect() {
    return { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 };
  }
  /** A `<select>`'s options, which React walks to mark the chosen one. */
  get options(): FakeNode[] {
    const out: FakeNode[] = [];
    const walk = (n: FakeNode) => {
      for (const c of n.childNodes) {
        if (c.nodeName === "OPTION") out.push(c);
        else walk(c);
      }
    };
    if (this.nodeName === "SELECT") walk(this);
    return out;
  }
  /** Every element below this one (depth first) whose attribute `name` is set. */
  findAll(name: string): FakeNode[] {
    const out: FakeNode[] = [];
    const walk = (n: FakeNode) => {
      for (const c of n.childNodes) {
        if (c.attributes.has(name)) out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }
}

export class FakeDocument extends FakeNode {
  head: FakeNode;
  body: FakeNode;
  documentElement: FakeNode;
  activeElement: FakeNode | null = null;
  visibilityState = "visible";
  defaultView: unknown = null;
  constructor() {
    super(9, "#document", null);
    this.documentElement = this.createElement("html");
    // React hoists a `<style precedence>` (Base UI's select ships one) into the head.
    this.head = this.createElement("head");
    this.body = this.createElement("body");
    this.appendChild(this.documentElement);
    this.documentElement.appendChild(this.head);
    this.documentElement.appendChild(this.body);
  }
  createElement(tag: string): FakeNode {
    return new FakeNode(1, tag.toUpperCase(), this);
  }
  createElementNS(_ns: string, tag: string): FakeNode {
    return new FakeNode(1, tag, this);
  }
  createTextNode(text: string): FakeNode {
    return new FakeNode(3, "#text", this, text);
  }
  createComment(text: string): FakeNode {
    return new FakeNode(8, "#comment", this, text);
  }
}

function stubGlobal(name: string, value: unknown): void {
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}

/** A `Storage` kept in memory. */
class MemoryStorage {
  private values = new Map<string, string>();
  get length(): number {
    return this.values.size;
  }
  key(i: number): string | null {
    return [...this.values.keys()][i] ?? null;
  }
  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.values.set(key, String(value));
  }
  removeItem(key: string): void {
    this.values.delete(key);
  }
  clear(): void {
    this.values.clear();
  }
}

/** The DOM's classes, for the `instanceof` checks libraries make (all one class here). */
const DOM_CLASSES = [
  "Node",
  "Element",
  "HTMLElement",
  "SVGElement",
  "HTMLInputElement",
  "HTMLTextAreaElement",
  "HTMLSelectElement",
  "HTMLButtonElement",
  "HTMLAnchorElement",
  "HTMLIFrameElement",
  "Text",
  "Document",
  "DocumentFragment",
  "ShadowRoot",
];

/** Install the stand-in as the page's `document` and `window`; returns a container to render into. */
export function installFakeDom(): FakeNode {
  const doc = new FakeDocument();
  const classes = Object.fromEntries(DOM_CLASSES.map((name) => [name, name === "ShadowRoot" ? class ShadowRoot {} : FakeNode]));
  const win = {
    ...classes,
    document: doc,
    localStorage: new MemoryStorage(),
    sessionStorage: new MemoryStorage(),
    requestAnimationFrame: (fn: (t: number) => void) => setTimeout(() => fn(Date.now()), 16),
    cancelAnimationFrame: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    HTMLIFrameElement: class {},
    getComputedStyle: () => ({ getPropertyValue: () => "" }),
    matchMedia: () => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined }),
    location: globalThis.location,
    event: undefined,
  };
  doc.defaultView = win;
  stubGlobal("window", win);
  stubGlobal("self", win);
  stubGlobal("document", doc);
  stubGlobal("navigator", globalThis.navigator ?? { userAgent: "node" });
  stubGlobal("IS_REACT_ACT_ENVIRONMENT", false);
  for (const [name, value] of Object.entries(classes)) stubGlobal(name, value);
  for (const name of ["localStorage", "sessionStorage", "requestAnimationFrame", "cancelAnimationFrame"] as const) stubGlobal(name, win[name]);
  const container = doc.createElement("div");
  doc.body.appendChild(container);
  return container;
}
