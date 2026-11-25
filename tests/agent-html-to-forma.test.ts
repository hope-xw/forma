import assert from "node:assert/strict";
import test from "node:test";
import {
  compileRenderedDomToForma,
  hydrateIconsInDom,
  parseCssBackdropFilter,
  parseCssBoxShadows,
  parseCssColor,
  parseCssGradient,
  sanitizeDesignHtml,
} from "../src/agent/html-to-forma";
import { computeArtboardPlacement } from "../src/agent/context-builder";
import { validateProposal } from "../src/agent/provider";
import { transact } from "../src/domain/commands";
import {
  parseDocument,
  createNode,
  type DesignDocument,
} from "../src/domain/document";
import { layoutBounds } from "../src/domain/geometry";
import { compileHtmlDraftInBrowser } from "../src/editor/html-forma-sandbox";

const base: DesignDocument = {
  id: "coffee",
  name: "Coffee",
  revision: 7,
  schemaVersion: 1,
  nodes: [],
  tokens: {},
};
const id = "img-" + "a".repeat(64);
const asset = {
  name: "Coffee.png",
  width: 1,
  height: 1,
  data: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jB1kAAAAASUVORK5CYII=",
};
type RectTuple = [number, number, number, number];
type Styles = Record<string, Record<string, string>>;
const htmlNamespace = "http://www.w3.org/1999/xhtml";
const svgNamespace = "http://www.w3.org/2000/svg";
const voidTags = new Set(
  "area base br col embed hr img input link meta param source track wbr".split(
    " ",
  ),
);

// Keep geometry on the prototype, like DOMRect. Spreading a range rectangle
// into a plain object must not accidentally work in the compiler tests.
class FixtureRect {
  constructor(private bounds: RectTuple = [0, 0, 0, 0]) {}
  get left() {
    return this.bounds[0];
  }
  get top() {
    return this.bounds[1];
  }
  get width() {
    return this.bounds[2];
  }
  get height() {
    return this.bounds[3];
  }
  get right() {
    return this.left + this.width;
  }
  get bottom() {
    return this.top + this.height;
  }
}

abstract class FixtureNode {
  abstract textContent: string;
  parentNode: FixtureContainer | null = null;
  get parentElement(): FixtureElement | null {
    return this.parentNode instanceof FixtureElement ? this.parentNode : null;
  }
  remove() {
    if (this.parentNode) {
      const siblings = this.parentNode.childNodes;
      siblings.splice(siblings.indexOf(this), 1);
      this.parentNode = null;
    }
  }
}

class FixtureText extends FixtureNode {
  readonly nodeType = 3;
  constructor(
    readonly ownerDocument: FixtureDocument,
    public textContent: string,
  ) {
    super();
  }
}

class FixtureContainer extends FixtureNode {
  readonly childNodes: FixtureNode[] = [];
  get children() {
    return this.childNodes.filter((node) => node instanceof FixtureElement);
  }
  get firstElementChild() {
    return this.children[0] ?? null;
  }
  get childElementCount() {
    return this.children.length;
  }
  get textContent(): string {
    return this.childNodes.map((node) => node.textContent).join("");
  }
  appendChild(node: FixtureNode) {
    node.remove();
    node.parentNode = this;
    this.childNodes.push(node);
    return node;
  }
  replaceChildren(...nodes: FixtureNode[]) {
    for (const child of this.childNodes) child.parentNode = null;
    this.childNodes.length = 0;
    for (const node of nodes) this.appendChild(node);
  }
  querySelectorAll(selector: string): FixtureElement[] {
    return this.children.flatMap((el) => [
      ...(el.matches(selector) ? [el] : []),
      ...el.querySelectorAll(selector),
    ]);
  }
  querySelector(selector: string) {
    return this.querySelectorAll(selector)[0] ?? null;
  }
}

function camelCase(name: string) {
  return name.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
}
function kebabCase(name: string) {
  return name.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase());
}
function declarations(css: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const part of css.split(";")) {
    const colon = part.indexOf(":");
    if (colon >= 0)
      values[part.slice(0, colon).trim()] = part.slice(colon + 1).trim();
  }
  return values;
}

class FixtureElement extends FixtureContainer {
  readonly nodeType = 1;
  readonly content?: FixtureContainer;
  private attrs = new Map<string, string>();
  private frameDocument?: FixtureDocument;
  constructor(
    readonly ownerDocument: FixtureDocument,
    readonly localName: string,
    readonly namespaceURI: string,
  ) {
    super();
    if (localName === "template") this.content = new FixtureContainer();
  }
  get tagName() {
    return this.namespaceURI === htmlNamespace
      ? this.localName.toUpperCase()
      : this.localName;
  }
  get attributes() {
    return Array.from(this.attrs, ([name, value]) => ({
      name,
      value,
      localName: name.split(":").pop()!,
    }));
  }
  getAttribute(name: string) {
    return this.attrs.get(name) ?? null;
  }
  setAttribute(name: string, value: string) {
    this.attrs.set(name, value);
    if (name === "srcdoc") this.frameDocument = undefined;
  }
  hasAttribute(name: string) {
    return this.attrs.has(name);
  }
  removeAttributeNode(attr: { name: string }) {
    this.attrs.delete(attr.name);
  }
  get id() {
    return this.getAttribute("id") ?? "";
  }
  set id(value: string) {
    this.setAttribute("id", value);
  }
  get dataset() {
    const data = Object.fromEntries(
      Array.from(this.attrs)
        .filter(([name]) => name.startsWith("data-"))
        .map(([name, value]) => [camelCase(name.slice(5)), value]),
    );
    return new Proxy(data, {
      set: (target, key: string, value: string) => {
        this.setAttribute("data-" + kebabCase(key), String(value));
        return Reflect.set(target, key, String(value));
      },
    });
  }
  get style() {
    const el = this;
    return {
      ...declarations(el.getAttribute("style") ?? ""),
      get cssText() {
        return el.getAttribute("style") ?? "";
      },
      set cssText(value: string) {
        el.setAttribute("style", value);
      },
    };
  }
  get srcdoc() {
    return this.getAttribute("srcdoc") ?? "";
  }
  set srcdoc(value: string) {
    this.setAttribute("srcdoc", value);
  }
  get contentDocument() {
    if (this.localName !== "iframe") return null;
    if (!this.frameDocument) {
      this.frameDocument = new FixtureDocument();
      if (this.srcdoc) this.frameDocument.write(this.srcdoc);
    }
    return this.frameDocument;
  }
  get textContent() {
    return super.textContent;
  }
  set textContent(value: string) {
    this.replaceChildren(this.ownerDocument.createTextNode(value));
  }
  get innerHTML(): string {
    if (this.localName === "style" || this.localName === "script")
      return this.textContent;
    return (this.content ?? this).childNodes.map(serializeNode).join("");
  }
  set innerHTML(html: string) {
    const target = this.content ?? this;
    target.replaceChildren();
    parseMarkup(html, target, this.ownerDocument);
  }
  matches(selectors: string): boolean {
    return selectors.split(",").some((selector) => {
      const chain = selector.trim().split(/\s*>\s*/);
      let el: FixtureElement | null = this;
      for (const part of chain.reverse()) {
        if (!el || !el.matchesSimple(part)) return false;
        el = el.parentElement;
      }
      return true;
    });
  }
  private matchesSimple(selector: string) {
    if (selector === "*") return true;
    if (selector.startsWith("#")) return this.id === selector.slice(1);
    if (selector.startsWith("."))
      return this.getAttribute("class")
        ?.split(/\s+/)
        .includes(selector.slice(1));
    const part = /^([\w-]+)?(?:\[([\w:-]+)(?:="([^"]*)")?\])?$/.exec(selector);
    if (!part || !selector) return false;
    const [, tag, attr, value] = part;
    return (
      (!tag || tag === this.localName) &&
      (!attr ||
        (value === undefined
          ? this.hasAttribute(attr)
          : this.getAttribute(attr) === value))
    );
  }
  closest(selector: string): FixtureElement | null {
    return this.matches(selector)
      ? this
      : (this.parentElement?.closest(selector) ?? null);
  }
  getBoundingClientRect() {
    return new FixtureRect(this.ownerDocument.boxes[this.id]);
  }
}

function decodeEntities(text: string) {
  const named: Record<string, string> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
  };
  return text.replace(
    /&(amp|lt|gt|quot|apos|#x[\da-f]+|#\d+);/gi,
    (_, entity: string) => {
      if (!entity.startsWith("#")) return named[entity.toLowerCase()];
      const hex = entity[1].toLowerCase() === "x";
      return String.fromCodePoint(
        parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10),
      );
    },
  );
}
function escapeHtml(text: string) {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
function serializeNode(node: FixtureNode): string {
  if (!(node instanceof FixtureElement)) return escapeHtml(node.textContent);
  const attrs = node.attributes
    .map(
      ({ name, value }) =>
        " " + name + '="' + escapeHtml(value).replaceAll('"', "&quot;") + '"',
    )
    .join("");
  const open = "<" + node.localName + attrs + ">";
  return voidTags.has(node.localName)
    ? open
    : open + node.innerHTML + "</" + node.localName + ">";
}

// The fixtures use balanced HTML/SVG, HTML void tags and quoted attributes.
// Keep text nodes (including whitespace) in their original sibling order.
function parseMarkup(
  html: string,
  root: FixtureContainer,
  doc: FixtureDocument,
) {
  const stack = [root];
  const tokens =
    /<!--[\s\S]*?-->|<!doctype\b[^>]*>|<(\/?)([\w:-]+)((?:[^<>"']|"[^"]*"|'[^']*')*)>|[^<]+|</gi;
  for (const [token, closing, name, attrs] of html.matchAll(tokens)) {
    const parent = stack[stack.length - 1];
    if (token.startsWith("<!")) continue;
    if (!name) {
      parent.appendChild(doc.createTextNode(decodeEntities(token)));
    } else if (closing) {
      if (stack.length > 1) stack.pop();
    } else {
      const svg =
        name === "svg" ||
        (parent instanceof FixtureElement &&
          parent.namespaceURI === svgNamespace);
      const el = svg
        ? doc.createElementNS(svgNamespace, name)
        : doc.createElement(name);
      const attributes =
        /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
      for (const [, key, double, single, bare] of attrs
        .replace(/\/$/, "")
        .matchAll(attributes))
        el.setAttribute(key, decodeEntities(double ?? single ?? bare ?? ""));
      parent.appendChild(el);
      if (!voidTags.has(el.localName) && !attrs.endsWith("/"))
        stack.push(el.content ?? el);
    }
  }
}

class FixtureDocument extends FixtureContainer {
  readonly nodeType = 9;
  readonly defaultView = {
    document: this,
    Element: FixtureElement,
    Text: FixtureText,
    Document: FixtureDocument,
    getComputedStyle: (el: FixtureElement) => this.computedStyle(el),
    close() {},
  };
  constructor(
    readonly boxes: Record<string, RectTuple> = {},
    private styles: Styles = {},
    private runs: Record<string, RectTuple[]> = {},
  ) {
    super();
    this.write("<html><head></head><body></body></html>");
  }
  get head() {
    return this.querySelector("head")!;
  }
  get body() {
    return this.querySelector("body")!;
  }
  open() {
    this.replaceChildren();
  }
  write(html: string) {
    if (/<html[\s>]/i.test(html)) {
      this.replaceChildren();
      parseMarkup(html, this, this);
    } else this.body.innerHTML = html;
  }
  close() {}
  createElement(tag: string) {
    return this.createElementNS(htmlNamespace, tag.toLowerCase());
  }
  createElementNS(ns: string, tag: string) {
    return new FixtureElement(this, tag, ns);
  }
  createTextNode(text: string) {
    return new FixtureText(this, text);
  }
  createRange() {
    let selected: FixtureNode;
    const rectangles = () => {
      const el =
        selected instanceof FixtureElement ? selected : selected.parentElement!;
      const key =
        selected instanceof FixtureText ? selected.textContent.trim() : el.id;
      return (this.runs[key] ?? [this.boxes[el.id]]).map(
        (tuple) => new FixtureRect(tuple),
      );
    };
    return {
      selectNodeContents(node: FixtureNode) {
        selected = node;
      },
      getClientRects: rectangles,
      getBoundingClientRect() {
        const rects = rectangles();
        if (!rects.length) return new FixtureRect();
        const left = Math.min(...rects.map((r) => r.left));
        const top = Math.min(...rects.map((r) => r.top));
        return new FixtureRect([
          left,
          top,
          Math.max(...rects.map((r) => r.right)) - left,
          Math.max(...rects.map((r) => r.bottom)) - top,
        ]);
      },
    };
  }
  private computedStyle(el: FixtureElement) {
    const values: Record<string, string> = {};
    for (const sheet of this.head.querySelectorAll("style")) {
      for (const [, selectors, css] of sheet.textContent.matchAll(
        /([^{}]+)\{([^{}]*)\}/g,
      ))
        if (el.matches(selectors)) Object.assign(values, declarations(css));
    }
    Object.assign(values, declarations(el.style.cssText), this.styles[el.id]);
    const getPropertyValue = (key: string) => values[key] ?? "";
    return new Proxy(
      { getPropertyValue },
      {
        get(target, key: string) {
          return key === "getPropertyValue"
            ? target.getPropertyValue
            : getPropertyValue(kebabCase(key));
        },
      },
    );
  }
}

function layoutFixture(
  html: string,
  boxes: Record<string, RectTuple>,
  styles: Styles = {},
  runs: Record<string, RectTuple[]> = {},
) {
  const doc = new FixtureDocument(boxes, styles, runs);
  doc.body.innerHTML = html;
  return {
    window: doc.defaultView,
    root: doc.querySelector("#root") as unknown as HTMLElement,
  };
}

async function withDocument(body: (doc: Document) => void | Promise<void>) {
  const window = new FixtureDocument().defaultView;
  const previous = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", {
    value: window.document,
    configurable: true,
  });
  try {
    await body(window.document as unknown as Document);
  } finally {
    if (previous) Object.defineProperty(globalThis, "document", previous);
    else Reflect.deleteProperty(globalThis, "document");
    window.close();
  }
}

test("sanitizes HTML, embedded styles and separate CSS while keeping local art and copy", async () => {
  await withDocument((doc) => {
    const css = `@import "https://example.invalid/theme.css"; .asset{background:url("${asset.data}")} .external{background:url(https://example.invalid/bg.png)} .old{width:expression(calc(4 + 2))}.label::after{content:"a;b"}`;
    const html = `<meta http-equiv="refresh"><base href="/"><link rel="stylesheet"><object>object</object><embed><iframe>frame</iframe><script>bad()</script>
    <style>${css}</style><a href="jAva&#x09;script:bad()" onclick="bad()">Coffee &amp; tea</a><img onerror="bad()" src="${asset.data}">
    <svg><a xlink:href="vbscript:bad()"><path d="M0 0L1 1"/></a></svg>
    <div style="background:url('//example.invalid/bg'); color: #abc"></div><template><script>bad()</script></template>`;
    const clean = sanitizeDesignHtml(html, css);
    const fragment = doc.createElement("template");
    fragment.innerHTML = clean.html;
    assert.equal(
      fragment.content.querySelector(
        "script,iframe,object,embed,link,meta,base,template,[onerror],[onclick]",
      ),
      null,
    );
    assert.doesNotMatch(
      clean.html + clean.css,
      /javascript:|vbscript:|@import|expression\(|example\.invalid/i,
    );
    assert.match(clean.css, /content:"a;b"/);
    assert.ok(clean.css.includes(asset.data));
    assert.equal(
      fragment.content.querySelector("img")!.getAttribute("src"),
      asset.data,
    );
    assert.equal(
      fragment.content.querySelector("a")!.textContent,
      "Coffee & tea",
    );
    assert.equal(clean.html, sanitizeDesignHtml(clean.html).html);
  });
});

test("resolves CSS color channels, percentages, alpha and hue units", () => {
  for (const [input, hex, alpha] of [
    ["#bAd", "#bbaadd", 1],
    ["#abcDEF", "#abcdef", 1],
    ["#12345680", "#123456", 128 / 255],
    ["transparent", "#000000", 0],
    ["rgb(100% 50% 0% / 25%)", "#ff8000", 0.25],
    ["rgba(12, 34, 56, 0.3)", "#0c2238", 0.3],
    ["hsl(.5turn 100% 50% / .4)", "#00ffff", 0.4],
  ] as const)
    assert.deepEqual(parseCssColor(input), { hex, opacity: alpha });
  assert.equal(parseCssColor("rgb(fail)"), null);
});

test("linear and radial gradients interpolate unspecified stops between adjacent anchors", () => {
  const linear = parseCssGradient(
    "linear-gradient(to top right, #000 10%, rgba(255,0,0,.5), #fff 70%, transparent)",
  )!;
  assert.equal(linear.angle, 45);
  assert.equal(linear.type, "linear");
  assert.deepEqual(
    linear.stops.map((s) => Math.round(s.offset * 100)),
    [10, 40, 70, 100],
  );
  assert.equal(linear.stops[1].color, "#ff0000");
  assert.equal(linear.stops[1].opacity, 0.5);
  assert.equal(
    parseCssGradient("linear-gradient(-90deg, #fff, #000)")!.angle,
    270,
  );
  const radial = parseCssGradient(
    "radial-gradient(circle at 30% 40%, hsl(120 100% 50%) 5% 25%, #0000 90%)",
  )!;
  assert.equal(radial.type, "radial");
  assert.deepEqual(
    radial.stops.map((s) => [s.color, s.opacity, s.offset]),
    [
      ["#00ff00", 1, 0.05],
      ["#00ff00", 1, 0.25],
      ["#000000", 0, 0.9],
    ],
  );
  assert.equal(parseCssGradient("none"), undefined);
});

test("shadows preserve CSS paint order and filters retain the saturation and brightness multipliers", () => {
  assert.deepEqual(
    parseCssBoxShadows(
      "rgba(1,2,3,.24) -4px 8px 12px -2px, inset 0 1px 0 #ffffff80",
    ),
    [
      {
        x: -4,
        y: 8,
        blur: 12,
        spread: -2,
        color: "#010203",
        opacity: 0.24,
        inset: false,
      },
      {
        x: 0,
        y: 1,
        blur: 0,
        spread: 0,
        color: "#ffffff",
        opacity: 128 / 255,
        inset: true,
      },
    ],
  );
  assert.equal(parseCssBoxShadows("none"), undefined);
  assert.deepEqual(
    parseCssBackdropFilter("blur(12px) saturate(160%) brightness(.9)"),
    {
      backdropBlur: 12,
      backdropBlurVisible: true,
      backdropSaturation: 1.6,
      backdropBrightness: 0.9,
    },
  );
  assert.deepEqual(parseCssBackdropFilter("none"), {});
  assert.deepEqual(
    parseCssBackdropFilter("blur(900px) saturate(11) brightness(80%)"),
    {
      backdropBlur: 512,
      backdropBlurVisible: true,
      backdropSaturation: 4,
      backdropBrightness: 0.8,
    },
  );
});

test("hydrates existing icon placeholders and forwards dimensions, color, stroke and layer names", () => {
  const { window, root } = layoutFixture(
    '<section id="root"><i data-icon="coffee" data-forma-name="Brew" data-size="26" data-color="#aced00" data-stroke-width="2"></i><span data-lucide="missing"></span><svg data-icon="star" width="12"></svg></section>',
    {},
  );
  try {
    assert.equal(
      hydrateIconsInDom(root, (key, opts) => {
        if (key === "coffee")
          assert.deepEqual(opts, {
            size: 26,
            color: "#aced00",
            strokeWidth: 2,
          });
        if (key === "star") {
          assert.equal(opts?.size, 12);
          assert.equal(opts?.strokeWidth, 1.75);
        }
        return key === "missing"
          ? null
          : '<svg viewBox="0 0 24 24"><circle r="4"/></svg>';
      }),
      2,
    );
    assert.equal(
      root.querySelector("i")!.getAttribute("data-forma-name"),
      "Brew",
    );
    assert.equal(
      root.querySelector("i > svg")!.getAttribute("data-forma-name"),
      "Brew",
    );
    assert.ok(root.querySelector('svg[data-icon="star"] > circle'));
    assert.equal(root.querySelector("span")!.children.length, 0);
  } finally {
    window.close();
  }
});

const mobileHtml = `<main id="root">
  <header id="bar" data-forma-name="Masthead"><span id="brand">Night roast</span>
    <svg id="mark" style="color:rgb(90,60,30)" aria-label="Roaster mark" viewBox="10 20 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M10 20L22 32"/><circle cx="16" cy="26" r="2"/><ellipse cx="22" cy="36" rx="3" ry="1"/>
      <rect x="18" y="24" width="4" height="6" rx="1"/><line x1="10" y1="20" x2="11" y2="23"/>
      <polyline points="10,21 11,22 12,24"/><polygon fill="#ffcc00" points="20,21 22,23 20,25"/>
    </svg>
  </header>
  <section id="hero" data-forma-name="Roast hero"><img id="photo" alt="Roasted beans" data-forma-asset-id="${id}">
    <div id="scrim" data-forma-name="Scrim"></div><span id="badge" data-forma-name="Limited badge">Limited</span>
  </section>
  <article id="card" data-forma-name="Glass card"><div id="shell"><h2 id="title">Midnight blend</h2></div>
    <div id="price" aria-label="Price"><i id="currency">$</i> 18.50 </div>
    <div id="grid" data-forma-name="Notes"><div id="swatch" aria-label="Origin photo"></div><div id="flavor">Cocoa</div></div>
  </article>
  <nav id="tabs" aria-label="Tab bar"><button id="cta">Subscribe</button><img id="thumb" alt="Thumbnail" src="${asset.data}"></nav>
  <div id="hidden" style="display:none">hidden</div><div id="zero">no area</div><div id="invisible" style="opacity:0"></div>
  <style>.unused{}</style><template><p>hidden</p></template>
</main>`;
const boxes: Record<string, RectTuple> = {
  root: [50, 40, 390, 844],
  bar: [66, 56, 358, 40],
  brand: [66, 66, 84, 20],
  mark: [400, 64, 24, 24],
  hero: [66, 108, 358, 220],
  photo: [66, 108, 358, 220],
  scrim: [66, 108, 358, 220],
  badge: [314, 128, 92, 30],
  card: [66, 340, 358, 152],
  shell: [78, 352, 334, 28],
  title: [78, 352, 334, 28],
  price: [78, 388, 334, 24],
  currency: [78, 388, 10, 24],
  grid: [78, 420, 334, 60],
  swatch: [78, 420, 162, 60],
  flavor: [250, 420, 162, 60],
  tabs: [66, 504, 358, 64],
  cta: [66, 519, 120, 36],
  thumb: [392, 521, 32, 32],
  hidden: [50, 40, 10, 10],
  invisible: [50, 40, 4, 4],
};
const mobileStyles: Styles = {
  root: {
    display: "flex",
    "flex-direction": "column",
    "padding-top": "16px",
    "padding-right": "16px",
    "padding-bottom": "16px",
    "padding-left": "16px",
    "row-gap": "12px",
  },
  bar: {
    display: "flex",
    "flex-direction": "row",
    "align-items": "center",
    "justify-content": "space-between",
    "column-gap": "6px",
  },
  brand: {
    display: "inline",
    "font-family": "Georgia",
    "font-size": "18px",
    "line-height": "20px",
  },
  mark: { color: "rgb(90,60,30)" },
  hero: {
    position: "relative",
    overflow: "hidden",
    "border-radius": "24px",
    "background-image": "linear-gradient(165deg,#121212,#863900)",
  },
  photo: {
    position: "absolute",
    "object-fit": "cover",
    opacity: ".84",
    "border-radius": "24px",
    "box-shadow": "0 3px 6px #0004",
  },
  scrim: {
    position: "absolute",
    "background-image":
      "linear-gradient(to bottom, transparent, rgba(0,0,0,.8))",
  },
  badge: {
    position: "absolute",
    "border-radius": "9999px",
    "background-color": "rgb(32,32,32)",
  },
  card: {
    display: "flex",
    "flex-direction": "column",
    "row-gap": "8px",
    "padding-top": "12px",
    "padding-right": "12px",
    "padding-bottom": "12px",
    "padding-left": "12px",
    "background-color": "rgba(255,255,255,.3)",
    "backdrop-filter": "blur(16px) saturate(130%) brightness(.95)",
    "box-shadow": "0 8px 24px -2px #0004, inset 0 1px #fff8",
    "border-top-left-radius": "30px",
    "border-top-right-radius": "20px",
    "border-bottom-right-radius": "10px",
    "border-bottom-left-radius": "0px",
  },
  shell: { display: "block" },
  title: {
    display: "block",
    "font-size": "22px",
    "font-family": "Georgia",
    "font-weight": "750",
    "font-style": "italic",
    "line-height": "28px",
    "letter-spacing": ".5px",
    color: "rgba(18,52,86,.8)",
    "text-align": "center",
    "text-transform": "uppercase",
    "text-decoration-line": "underline",
    "-webkit-line-clamp": "2",
  },
  price: { display: "flex", "align-items": "center", "column-gap": "6px" },
  grid: {
    display: "grid",
    "grid-template-columns": "162px 162px",
    "column-gap": "10px",
    "row-gap": "5px",
  },
  swatch: {
    "background-image": `linear-gradient(to right, transparent,#0008), url("${asset.data}")`,
    "background-size": "auto, contain",
  },
  tabs: {
    display: "flex",
    "justify-content": "space-between",
    "align-items": "center",
    "border-top-width": "2px",
    "border-top-style": "dashed",
    "border-top-color": "rgba(10,20,30,.5)",
  },
  cta: { "background-color": "rgb(18,32,48)", "border-radius": "16px" },
  thumb: { "object-fit": "contain", "object-position": "20% 70%" },
};

test("replays the entire measured mobile card as a single proposal with editable vectors, images and layout", () => {
  const { window, root } = layoutFixture(mobileHtml, boxes, mobileStyles, {
    "18.50": [[94, 388, 50, 24]],
    Limited: [[335, 134, 50, 18]],
  });
  try {
    const opts = {
      baseDocument: base,
      name: "Roast subscription",
      images: { [id]: asset },
      placement: { x: 120, y: 80 },
    };
    const result = compileRenderedDomToForma(root, opts);
    assert.deepEqual(result, compileRenderedDomToForma(root, opts));
    assert.deepEqual(result.warnings, []);
    const ops = result.transaction.operations;
    assert.equal(ops[0].type, "putImage");
    assert.equal(ops.filter((o) => o.type === "putImage").length, 1);
    const seen = new Set<string>();
    for (const op of ops.slice(1)) {
      assert.ok(op.type === "create");
      assert.ok(op.node.parentId === null || seen.has(op.node.parentId));
      seen.add(op.node.id);
    }
    const proposal = validateProposal(
      { prompt: "Create roast subscription", document: base, selection: null },
      result.transaction,
    );
    const doc = parseDocument(transact(base, proposal));
    const get = (name: string) => {
      const n = doc.nodes.find((n) => n.name === name);
      assert.ok(n, name);
      return n;
    };
    assert.equal(doc.revision, 8);
    assert.deepEqual(result.createdRootIds, [get("Roast subscription").id]);
    assert.deepEqual(result.stats, {
      created: doc.nodes.length,
      imagesLocalized: 1,
      vectorsConverted: 1,
      autoLayoutFrames: doc.nodes.filter((n) => n.style.layout !== "free")
        .length,
    });
    assert.deepEqual(get("Roast subscription").style.insets, {
      top: 16,
      right: 16,
      bottom: 16,
      left: 16,
    });
    assert.equal(get("Roast subscription").style.layout, "column");
    assert.equal(get("Roast subscription").style.gap, 12);
    const bar = get("Masthead").style;
    assert.equal(bar.layout, "row");
    assert.equal(bar.gap, 6);
    assert.equal(bar.justifyContent, "space-between");
    assert.equal(bar.alignY, "center");
    assert.equal(bar.widthMode, "fill");
    const photo = get("Roasted beans");
    assert.equal(photo.type, "rectangle");
    assert.equal(photo.image?.assetId, id);
    assert.equal(photo.image.fit, "cover");
    assert.equal(photo.style.opacity, 0.84);
    assert.equal(photo.style.radius, 24);
    assert.equal(photo.style.shadows?.length, 1);
    const hero = get("Roast hero");
    assert.equal(hero.style.gradient?.angle, 165);
    assert.equal(hero.style.clipContent, true);
    assert.equal(hero.style.layout, "free");
    assert.equal(get("Scrim").style.gradient?.stops[1].opacity, 0.8);
    assert.deepEqual(
      doc.nodes.filter((n) => n.parentId === hero.id).map((n) => n.name),
      ["Roasted beans", "Scrim", "Limited badge"],
    );
    const badge = get("Limited badge");
    assert.equal(badge.style.absolutePosition, true);
    assert.equal(badge.style.x, 248);
    assert.equal(badge.style.y, 20);
    assert.deepEqual(layoutBounds(doc).get(badge.id), {
      x: 384,
      y: 168,
      width: 92,
      height: 30,
    });
    const vector = get("Roaster mark");
    assert.equal(vector.type, "vector");
    assert.equal(vector.vector?.width, 24);
    assert.equal(vector.vector.height, 24);
    assert.equal(vector.vector.paths.length, 7);
    const p = vector.vector.paths[0];
    assert.equal(p.fill, false);
    assert.equal(p.d, "M0 0L12 12");
    assert.equal(p.strokeColor, "#5a3c1e");
    assert.equal(p.strokeWidth, 2);
    assert.equal(p.lineCap, "round");
    assert.equal(p.lineJoin, "round");
    assert.equal(vector.vector.paths[6].fillColor, "#ffcc00");
    const card = get("Glass card");
    assert.equal(card.style.backdropBlur, 16);
    assert.equal(card.style.backdropSaturation, 1.3);
    assert.equal(card.style.backdropBrightness, 0.95);
    assert.equal(card.style.fillOpacity, 0.3);
    assert.deepEqual(
      card.style.shadows?.map((s) => s.inset),
      [false, true],
    );
    assert.equal(card.style.cornerSmoothing, 0.6);
    assert.deepEqual(card.style.corners, { tl: 30, tr: 20, br: 10, bl: 0 });
    const title = get("Midnight blend");
    assert.equal(title.parentId, card.id);
    assert.equal(title.type, "text");
    assert.equal(title.style.fontWeight, 750);
    assert.equal(title.style.fontFamily, "Georgia");
    assert.equal(title.style.fontSize, 22);
    assert.equal(title.style.fontStyle, "italic");
    assert.equal(title.style.lineHeight, 28);
    assert.equal(title.style.letterSpacing, 0.5);
    assert.equal(title.style.maxLines, 2);
    assert.equal(title.style.textDecoration, "underline");
    assert.equal(title.style.textTransform, "uppercase");
    assert.equal(title.style.textAlign, "center");
    assert.equal(title.style.color, "#123456");
    assert.equal(title.style.colorOpacity, 0.8);
    assert.equal(get("18.50").parentId, get("Price").id);
    assert.equal(get("18.50").style.x, 16);
    assert.equal(get("18.50").style.width, 50);
    const grid = get("Notes");
    assert.equal(grid.style.columns, 2);
    assert.equal(grid.style.layout, "grid");
    assert.equal(grid.style.gap, 10);
    assert.equal(grid.style.rowGap, 5);
    assert.equal(get("Origin photo").image?.assetId, id);
    assert.equal(get("Origin photo").image?.fit, "contain");
    assert.equal(get("Origin photo").style.paints?.[0].gradient?.angle, 90);
    assert.equal(get("Night roast").style.width, 84);
    assert.equal(get("Night roast").style.x, 0);
    assert.equal(get("Thumbnail").image?.fit, "contain");
    assert.equal(get("Thumbnail").image?.y, 70);
    assert.equal(get("Subscribe").type, "button");
    const tabs = get("Tab bar").style;
    assert.deepEqual(tabs.strokeSides, {
      top: 2,
      right: 0,
      bottom: 0,
      left: 0,
    });
    assert.equal(tabs.strokeAlign, "inside");
    assert.equal(tabs.strokeStyle, "dashed");
    assert.equal(tabs.strokeOpacity, 0.5);
    assert.ok(
      !doc.nodes.some((n) => n.text === "hidden" || n.text === "no area"),
    );
    const bounds = layoutBounds(doc);
    const sourceNames = {
      root: "Roast subscription",
      bar: "Masthead",
      brand: "Night roast",
      mark: "Roaster mark",
      hero: "Roast hero",
      photo: "Roasted beans",
      scrim: "Scrim",
      badge: "Limited badge",
      card: "Glass card",
      title: "Midnight blend",
      price: "Price",
      currency: "$",
      grid: "Notes",
      swatch: "Origin photo",
      flavor: "Cocoa",
      tabs: "Tab bar",
      cta: "Subscribe",
      thumb: "Thumbnail",
    };
    for (const [element, name] of Object.entries(sourceNames)) {
      const [left, top, width, height] = boxes[element];
      assert.deepEqual(
        bounds.get(get(name).id),
        { x: left - 50 + 120, y: top - 40 + 80, width, height },
        name,
      );
    }
    assert.deepEqual(doc.images, { [id]: asset });
    assert.deepEqual(base.nodes, []);
  } finally {
    window.close();
  }
});

test("infers block flow from measured siblings, keeps overlaps free and preserves a fill item's measured size", () => {
  const { window, root } = layoutFixture(
    `<main id="root"><section id="stack" aria-label="Stack"><p id="one">First</p><p id="two">Second</p></section><section id="overlap" aria-label="Overlap"><i id="a">A</i><i id="b">B</i></section><div id="row" aria-label="Row"><div id="grow">Grows</div><div id="fixed">Fixed</div></div><div id="repeat" aria-label="Repeated grid"></div></main>`,
    {
      root: [0, 0, 300, 300],
      stack: [0, 0, 300, 70],
      one: [10, 4, 280, 20],
      two: [10, 34, 280, 20],
      overlap: [0, 80, 300, 70],
      a: [4, 82, 20, 20],
      b: [10, 90, 20, 20],
      row: [0, 155, 300, 40],
      grow: [0, 155, 244, 40],
      fixed: [252, 155, 48, 40],
      repeat: [0, 205, 300, 36],
    },
    {
      row: {
        display: "flex",
        "flex-wrap": "wrap",
        "column-gap": "8px",
        "row-gap": "12px",
      },
      grow: { "flex-grow": "1" },
      one: { "line-height": "20px" },
      repeat: {
        display: "grid",
        "grid-template-columns": "[start] repeat(3, minmax(0, 1fr)) [end]",
      },
    },
  );
  try {
    const result = compileRenderedDomToForma(root, { baseDocument: base });
    const doc = transact(base, result.transaction);
    const get = (name: string) => doc.nodes.find((n) => n.name === name)!;
    assert.equal(get("Stack").style.layout, "column");
    assert.equal(get("Stack").style.gap, 10);
    assert.equal(get("Stack").style.insets?.top, 4);
    assert.equal(get("Overlap").style.layout, "free");
    assert.equal(get("Row").style.wrap, true);
    assert.equal(get("Row").style.rowGap, 12);
    assert.equal(get("Grows").style.widthMode, "fill");
    assert.equal(get("Fixed").style.widthMode, "hug");
    assert.equal(get("First").style.heightMode, "hug");
    assert.equal(get("Repeated grid").style.columns, 3);
    assert.deepEqual(layoutBounds(doc).get(get("Grows").id), {
      x: 80,
      y: 235,
      width: 244,
      height: 40,
    });
    const limited = compileRenderedDomToForma(root, {
      baseDocument: doc,
      maxNodes: 3,
    });
    assert.equal(limited.stats.created, 3);
    assert.ok(limited.warnings.length);
    const next = transact(doc, limited.transaction);
    const nextRoot = next.nodes.find(
      (n) => n.id === limited.createdRootIds[0],
    )!;
    const placement = computeArtboardPlacement(doc, undefined, {
      width: 300,
      height: 300,
    });
    assert.equal(nextRoot.style.x, placement.x);
    assert.equal(nextRoot.style.y, placement.y);
  } finally {
    window.close();
  }
});

test("reuses stored images and emits a valid selection-scoped proposal with colliding IDs on inactive pages", () => {
  const parent = createNode("frame");
  parent.id = "selected";
  const inactive = createNode("frame");
  inactive.id = "html-7-1";
  const existing = parseDocument({
    ...base,
    activePage: "one",
    pages: [
      { id: "one", name: "One" },
      { id: "two", name: "Two", nodes: [inactive] },
    ],
    nodes: [parent],
    images: { [id]: asset },
  });
  const { window, root } = layoutFixture(
    `<main id="root"><img id="img" alt="Stored" src="${asset.data}"/><img id="unknown" alt="Unresolved"/></main>`,
    { root: [0, 0, 120, 80], img: [0, 0, 120, 40], unknown: [0, 40, 120, 40] },
    { img: { "object-fit": "fill" } },
  );
  try {
    const result = compileRenderedDomToForma(root, {
      baseDocument: existing,
      selectionParentId: parent.id,
      placement: { x: 8, y: 4 },
    });
    assert.equal(result.stats.imagesLocalized, 0);
    assert.ok(result.transaction.operations.every((o) => o.type === "create"));
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0], /Unresolved/);
    const proposal = validateProposal(
      { document: existing, selection: parent.id, prompt: "Add images" },
      result.transaction,
    );
    const doc = transact(existing, proposal),
      artboard = doc.nodes.find((n) => n.id === result.createdRootIds[0])!;
    assert.notEqual(artboard.id, inactive.id);
    assert.equal(artboard.parentId, parent.id);
    assert.equal(
      doc.nodes.find((n) => n.name === "Stored")!.image!.fit,
      "fill",
    );
  } finally {
    window.close();
  }
});

test("clamps extreme CSS at the document schema boundaries and omits zero-area geometry", () => {
  const { window, root } = layoutFixture(
    '<div id="root"><span id="label">Large</span><div id="tile" data-squircle aria-label="Tile"></div><div id="empty" aria-label="Zero"></div></div>',
    {
      root: [0, 0, 120000, 300],
      label: [0, 0, 100, 30],
      tile: [0, 40, 50, 50],
      empty: [10, 10, 0, 10],
    },
    {
      label: {
        "font-size": "750px",
        "line-height": "1300px",
        "font-weight": "998",
        "letter-spacing": "900px",
        "-webkit-line-clamp": "500",
      },
      tile: {
        "border-top-width": "90px",
        "border-top-style": "solid",
        "border-radius": "15000px",
        filter: "blur(180px)",
        "backdrop-filter": "blur(920px)",
      },
    },
  );
  try {
    const result = compileRenderedDomToForma(root, { baseDocument: base });
    const doc = parseDocument(transact(base, result.transaction));
    const s = doc.nodes.find((n) => n.text === "Large")!.style;
    assert.deepEqual(
      [s.fontSize, s.lineHeight, s.fontWeight, s.letterSpacing, s.maxLines],
      [500, 1000, 900, 200, 100],
    );
    const t = doc.nodes.find((n) => n.name === "Tile")!.style;
    assert.deepEqual(
      [t.strokeSides?.top, t.radius, t.blur, t.backdropBlur, t.cornerSmoothing],
      [64, 10000, 100, 512, 0.6],
    );
    assert.equal(doc.nodes[0].style.width, 100000);
    assert.ok(!doc.nodes.some((n) => n.name === "Zero"));
  } finally {
    window.close();
  }
});

test("browser adapter mounts CSP, utilities and scrubbed markup in a scriptless iframe and always removes it", async () => {
  await withDocument(async (doc) => {
    const draft = {
      name: "Utility sandbox",
      width: 220,
      height: 180,
      html: '<div class="flex gap-3"><i data-icon="cup"></i><img onerror="bad()"><script>bad()</script></div>',
      css: ".flex{padding:16px}",
    };
    let inspected = 0;
    const inspect = () => {
      const frame = doc.querySelector("iframe")!;
      assert.equal(frame.getAttribute("sandbox"), "allow-same-origin");
      assert.equal(frame.getAttribute("aria-hidden"), "true");
      assert.equal(frame.style.width, "220px");
      const inner = frame.contentDocument!,
        host = inner.querySelector<HTMLElement>("#forma-html-root")!;
      assert.equal(host.style.width, "220px");
      assert.equal(host.style.height, "180px");
      assert.match(
        inner.querySelector("meta[http-equiv]")!.getAttribute("content")!,
        /script-src 'none'/,
      );
      assert.match(
        inner.head.querySelector("style")!.textContent!,
        /\.gap-3\{gap:12px\}/,
      );
      assert.equal(host.querySelector("script,[onerror]"), null);
      assert.equal(
        inner.defaultView!.getComputedStyle(host.firstElementChild!).display,
        "flex",
      );
      inspected++;
      return '<svg viewBox="0 0 20 20"><path d="M0 0L10 10"/></svg>';
    };
    const result = await compileHtmlDraftInBrowser(draft, {
      baseDocument: base,
      iconResolver: inspect,
    });
    assert.equal(inspected, 1);
    assert.equal(doc.querySelector("iframe"), null);
    const compiled = transact(base, result.transaction);
    assert.equal(compiled.nodes[0].name, draft.name);
    assert.equal(compiled.nodes[0].style.width, 220);
    await assert.rejects(
      compileHtmlDraftInBrowser(draft, {
        baseDocument: base,
        iconResolver: () => {
          throw Error("resolver failed");
        },
      }),
      /resolver failed/,
    );
    assert.equal(doc.querySelector("iframe"), null);
  });
});

test("keeps inline emphasis, Unicode offsets and explicit line breaks in one editable text layer", () => {
  const { window, root } = layoutFixture(
    '<main id="root"><p id="desc" aria-label="Description">☕️ Try <em id="em" style="font-style:italic">dark</em> roast<br>today</p></main>',
    { root: [20, 20, 200, 90], desc: [20, 20, 200, 48], em: [68, 20, 35, 24] },
    {
      desc: { "line-height": "24px" },
      em: { display: "inline", "line-height": "24px" },
    },
  );
  try {
    const doc = transact(
      base,
      compileRenderedDomToForma(root, { baseDocument: base }).transaction,
    );
    const p = doc.nodes.find((n) => n.name === "Description")!;
    assert.equal(p.type, "text");
    assert.equal(p.text, "☕️ Try dark roast\ntoday");
    assert.equal(p.textRuns?.length, 1);
    const run = p.textRuns[0];
    assert.equal(p.text.slice(run.start, run.end), "dark");
    assert.equal(run.style.fontStyle, "italic");
  } finally {
    window.close();
  }
});

test("stacks multiple CSS gradients bottom-to-top and maps single-cell centered grid icon buttons to centered AutoLayout", () => {
  const { window, root } = layoutFixture(
    `<main id="root" aria-label="Phone"><button id="bellBtn" aria-label="Notifications"><svg id="bellIcon" viewBox="0 0 24 24"><path d="M6 8a6 6 0 0 1 12 0"/></svg><span id="dot" aria-label="Badge"></span></button></main>`,
    {
      root: [0, 0, 390, 844],
      bellBtn: [334, 16, 36, 36],
      bellIcon: [343, 25, 18, 18],
      dot: [358, 22, 6, 6],
    },
    {
      root: {
        "background-color": "rgba(0, 0, 0, 0)",
        "background-image":
          "radial-gradient(circle at 50% 40%, rgba(247, 237, 221, 0.9) 0%, rgba(247, 237, 221, 0) 66%), linear-gradient(180deg, #faf7f2 0%, #f4ede3 100%)",
      },
      bellBtn: {
        display: "grid",
        "grid-template-columns": "36px",
        "align-items": "center",
        "justify-items": "center",
        "background-color": "#ffffff",
        "border-radius": "18px",
      },
      dot: {
        position: "absolute",
        "background-color": "#f59e0b",
        "border-radius": "3px",
      },
    },
  );
  try {
    const doc = parseDocument(
      transact(
        base,
        validateProposal(
          { prompt: "multi-gradient", document: base, selection: null },
          compileRenderedDomToForma(root, { baseDocument: base }).transaction,
        ),
      ),
    );
    const phone = doc.nodes.find((n) => n.name === "Phone")!;
    assert.equal(phone.style.gradient?.type, "linear");
    assert.equal(phone.style.gradient?.stops[0].color, "#faf7f2");
    assert.equal(phone.style.paints?.length, 1);
    assert.equal(phone.style.paints?.[0].gradient?.type, "radial");
    const btn = doc.nodes.find((n) => n.name === "Notifications")!;
    assert.equal(btn.style.layout, "row");
    assert.equal(btn.style.alignX, "center");
    assert.equal(btn.style.alignY, "center");
  } finally {
    window.close();
  }
});
