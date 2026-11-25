import assert from "node:assert/strict";
import test from "node:test";
import {
  compileRenderedDomToForma,
  computeMatrixArtboardPlacements,
  mergeHtmlArtboardResults,
  resolveHtmlComponentSlot,
  sanitizeDesignHtml,
  type HtmlArtboardSpec,
  type HtmlToFormaOptions,
} from "../src/agent/html-to-forma";
import {
  compileHtmlDraftInBrowser,
  hydrateComponentPlaceholdersInDom,
} from "../src/editor/html-forma-sandbox";
import { addPage, currentPageOnly } from "../src/domain/pages";
import { commit, travel } from "../src/application/history";
import { transact } from "../src/domain/commands";
import {
  createNode,
  parseDocument,
  type DesignDocument,
  type DesignNode,
} from "../src/domain/document";
import { resolveNode } from "../src/domain/design-system";
import { validateInstanceStructure } from "../src/domain/library";
import { parseLibrary } from "../src/domain/library-schema";
import { mobileComponentLibrary } from "../src/design-system/mobile";

type Box = [number, number, number, number];
const styles: string[] = [];
const stubDocument = {
  defaultView: { getComputedStyle: (el: Layer) => el.computed },
  head: {
    prepend: (style: { textContent: string }) => styles.push(style.textContent),
  },
  createElement: () => ({ textContent: "" }),
  createRange: () => ({ selectNodeContents() {} }),
};

// Only element geometry and the attributes/styles consumed by the compiler are stubbed.
class Layer {
  nodeType = 1;
  ownerDocument = stubDocument;
  childNodes: Layer[] = [];
  parentElement?: Layer;
  localName: string;
  attrs: Map<string, string>;
  computed;
  style = {
    width: "",
    height: "",
    boxSizing: "",
    setProperty: (key: string, value: string) => this.cssVars.set(key, value),
  };
  cssVars = new Map<string, string>();
  constructor(
    tag: string,
    private box: Box = [0, 0, 180, 60],
    css: Record<string, string> = {},
    children: Layer[] = [],
  ) {
    this.localName = tag.match(/^<(\w+)/)![1];
    this.attrs = new Map(
      Array.from(tag.matchAll(/([\w-]+)=(?:"([^"]*)"|'([^']*)')/g), (m) => [
        m[1],
        m[2] ?? m[3],
      ]),
    );
    this.computed = Object.assign(
      {
        color: "#000000",
        display: "block",
        flexDirection: "row",
        lineHeight: "normal",
        ...css,
      },
      { getPropertyValue: (key: string) => css[key] ?? "" },
    );
    this.childNodes = children;
    for (const child of children) child.parentElement = this;
  }
  get childElementCount() {
    return this.childNodes.length;
  }
  getAttribute(key: string) {
    return this.attrs.get(key) ?? null;
  }
  hasAttribute(key: string) {
    return this.attrs.has(key);
  }
  matches(selector: string) {
    return this.hasAttribute(selector.slice(1, -1));
  }
  querySelectorAll(selector: string): Layer[] {
    return this.childNodes.flatMap((n) => [
      ...(n.matches(selector) ? [n] : []),
      ...n.querySelectorAll(selector),
    ]);
  }
  getBoundingClientRect() {
    const [left, top, width, height] = this.box;
    return { left, top, width, height };
  }
  element() {
    return this as unknown as HTMLElement;
  }
}
function template(
  type: DesignNode["type"],
  key: string,
  parent: string | null = null,
) {
  return { ...createNode(type, parent), id: key, name: key, templateKey: key };
}
const assetId = "img-" + "c".repeat(64);
const asset = {
  name: "Dot",
  width: 1,
  height: 1,
  data: "data:image/png;base64,iVBORw0KGgo=",
};
function fixture(): DesignDocument {
  const root = template("frame", "card");
  Object.assign(root.style, { width: 180, height: 60, fill: "#123456" });
  const price = template("text", "price", root.id);
  price.name = "Price label";
  const title = template("text", "title", root.id);
  const badge = template("rectangle", "badge", root.id);
  badge.nestedSlot = true;
  Object.assign(badge.style, { width: 24, height: 18, x: 14, y: 8 });
  const image = template("rectangle", "photo", root.id);
  image.image = { assetId, fit: "cover", x: 50, y: 50, zoom: 1 };
  const replacement = template("rectangle", "replacement");
  replacement.style.fill = "#778899";
  const vars = [
    {
      id: "wrong-scope",
      type: "color",
      scopes: ["stroke"],
      values: { day: "#123457", night: "#abcdef" },
    },
    {
      id: "brand",
      type: "color",
      scopes: ["fill", "color"],
      values: { day: "#123456", night: "#fedcba" },
    },
    {
      id: "surface",
      type: "color",
      scopes: ["fill"],
      values: { day: { alias: "brand" }, night: { alias: "brand" } },
    },
    {
      id: "radius",
      type: "number",
      scopes: ["radius"],
      values: { day: 8, night: 16 },
    },
    {
      id: "negative-in-dark",
      type: "number",
      scopes: [],
      values: { day: 7.9, night: -2 },
    },
  ];
  const library = parseLibrary({
    format: "forma/library",
    version: 1,
    id: "shop",
    revision: 1,
    name: "Shop",
    description: "",
    source: { name: "Fixture", license: "test" },
    images: { [assetId]: asset },
    designSystem: {
      collections: {
        theme: {
          id: "theme",
          name: "Theme",
          defaultModeId: "day",
          modes: [
            { id: "day", name: "Day" },
            { id: "night", name: "Night" },
          ],
        },
      },
      activeModes: { theme: "day" },
      styles: {},
      variables: Object.fromEntries(
        vars.map((v) => [v.id, { ...v, name: v.id, collectionId: "theme" }]),
      ),
    },
    components: [
      {
        id: "card",
        name: "Product Card",
        category: "Shop",
        description: "",
        exposed: [
          { id: "label", name: "Label", kind: "text", target: "title" },
          { id: "icon", name: "Icon", kind: "swap", target: "badge" },
        ],
        variants: ["plain", "promo"].map((id) => ({
          id,
          name: id,
          properties: { state: id },
          nodes: [root, price, title, badge, image],
        })),
      },
      {
        id: "mark",
        name: "Mark",
        category: "Icon",
        description: "",
        variants: [
          { id: "new", name: "New", properties: {}, nodes: [replacement] },
        ],
      },
    ],
  });
  return parseDocument({
    id: "hybrid",
    revision: 4,
    name: "Hybrid",
    schemaVersion: 1,
    tokens: {},
    nodes: [],
    libraries: { shop: library },
  });
}
function compile(
  doc: DesignDocument,
  children: Layer[],
  options: Partial<HtmlToFormaOptions> = {},
) {
  const root = new Layer(
    '<main data-forma-name="Board"></main>',
    [10, 20, 400, 320],
    { display: "flex", flexDirection: "column" },
    children,
  );
  return compileRenderedDomToForma(root.element(), {
    baseDocument: doc,
    ...options,
  });
}
function replay(doc: DesignDocument, result: ReturnType<typeof compile>) {
  const next = parseDocument(transact(doc, result.transaction));
  for (const n of next.nodes)
    if (n.instance) validateInstanceStructure(next, n);
  return next;
}
const tag =
  '<div data-forma-component="shop:Product Card" data-variant-props=\'{"state":"promo"}\' data-overrides=\'{"text":"Buy","textByTemplateKey":{"Price label":"$29"},"fill":"#ABC","color":"rgb(18, 52, 86)","opacity":0.55,"slots":{"icon":{"libraryId":"shop","componentId":"mark","variantId":"new"}}}\'></div>';

test("HTML slots instantiate protected variants, apply public text/appearance/swap overrides and reuse resources", () => {
  const doc = fixture(),
    before = structuredClone(doc);
  const el = new Layer(tag, [34, 53, 180, 60], { position: "absolute" }, [
    new Layer('<div data-forma-name="Discard"></div>'),
  ]);
  const result = compile(
    doc,
    [
      el,
      new Layer('<div data-forma-component="card" data-variant="plain"></div>'),
    ],
    { activeLibraryId: "shop" },
  );
  const next = replay(doc, result);
  assert.deepEqual(doc, before);
  assert.deepEqual(result.warnings, []);
  assert.equal(result.stats.componentsInserted, 2);
  assert.equal(result.stats.tokensBound, 0);
  assert.equal(next.nodes.length, result.stats.created);
  const [first, second] = next.nodes.filter((n) => n.instance);
  assert.equal(first.instance!.variantId, "promo");
  assert.equal(second.instance!.variantId, "plain");
  assert.equal(first.instance!.libraryId, second.instance!.libraryId);
  assert.equal(first.parentId, result.createdRootIds[0]);
  assert.deepEqual(
    [first.style.x, first.style.y, first.style.absolutePosition],
    [24, 33, true],
  );
  assert.deepEqual([first.style.fill, first.style.opacity], ["#aabbcc", 0.55]);
  const children = next.nodes.filter((n) => n.parentId === first.id);
  assert.equal(children.find((n) => n.templateKey === "title")!.text, "Buy");
  assert.equal(
    children.find((n) => n.templateKey === "title")!.style.color,
    "#123456",
  );
  assert.equal(children.find((n) => n.templateKey === "price")!.text, "$29");
  assert.equal(
    children.find((n) => n.templateKey === "badge")!.style.fill,
    "#778899",
  );
  assert.deepEqual(first.instance!.slots?.badge, {
    libraryId: "shop",
    componentId: "mark",
    variantId: "new",
  });
  assert.deepEqual(children.find((n) => n.templateKey === "title")!.style, {
    ...doc.libraries!.shop.components[0].variants[1].nodes.find(
      (n) => n.templateKey === "title",
    )!.style,
    color: "#123456",
  });
  assert.ok(!next.nodes.some((n) => n.name === "Discard"));
  assert.equal(
    result.transaction.operations.filter((o) => o.type === "putImage").length,
    1,
  );
  assert.equal(
    result.transaction.operations.filter((o) => o.type === "setDesignSystem")
      .length,
    1,
  );
  assert.equal(
    result.transaction.operations.filter((o) => o.type === "setInstanceSlot")
      .length,
    1,
  );
  assert.throws(
    () =>
      transact(next, {
        baseRevision: next.revision,
        operations: [
          { type: "update", id: children[0].id, patch: {}, style: { x: 999 } },
        ],
      }),
    /受保护/,
  );
});

test("qualified IDs and names resolve exact variants and reject malformed metadata", () => {
  const doc = fixture();
  for (const ref of ["shop/card", "shop:card", "product CARD"]) {
    const el = new Layer(
      `<div data-forma-component="${ref}" data-variant="plain" data-variant-props='{"state":"plain"}'></div>`,
    );
    assert.equal(
      resolveHtmlComponentSlot(doc, el.element(), "missing")?.variant.id,
      "plain",
    );
  }
  doc.libraries!.empty = {
    ...doc.libraries!.shop,
    id: "empty",
    components: [doc.libraries!.shop.components[1]],
  };
  doc.libraries!.shop.components.push({
    ...doc.libraries!.shop.components[1],
    id: "uninstalled/card",
    name: "Inputs / Search",
  });
  assert.equal(
    resolveHtmlComponentSlot(
      doc,
      new Layer('<div data-forma-component="Inputs / Search"></div>').element(),
    )?.component.id,
    "uninstalled/card",
  );
  for (const ref of ["empty/card", "empty:card", "uninstalled/card"]) {
    const el = new Layer(`<div data-forma-component="${ref}"></div>`);
    assert.throws(
      () => resolveHtmlComponentSlot(doc, el.element(), "shop"),
      /data-library/,
    );
  }
  for (const attrs of [
    `data-variant-props='{"state":"plain","missing":"x"}'`,
    `data-variant-props='{"state":"unknown"}'`,
    `data-variant="plain" data-variant-props='{"state":"promo"}'`,
  ]) {
    const el = new Layer(
      `<div data-forma-component="shop/card" ${attrs}></div>`,
    );
    assert.throws(
      () => resolveHtmlComponentSlot(doc, el.element()),
      /data-variant-props.*完整匹配/,
    );
  }
  const el = new Layer(
    '<div data-forma-component="" data-component="card" data-overrides="{" data-variant-props="false"></div>',
  );
  assert.throws(
    () => resolveHtmlComponentSlot(doc, el.element()),
    /data-variant-props.*JSON/,
  );
  el.attrs.delete("data-variant-props");
  assert.throws(
    () => resolveHtmlComponentSlot(doc, el.element()),
    /data-overrides.*JSON/,
  );
  const result = compile(doc, [
    new Layer('<div data-forma-component="missing"></div>', [20, 30, 0, 0]),
  ]);
  assert.match(result.warnings.join(" "), /找不到组件插槽.*missing/);
  assert.ok(
    replay(doc, result).nodes.some((n) => n.name === "missing" && !n.instance),
  );
});

test("unsafe and unavailable swap requests leave the original instance intact", () => {
  const doc = fixture();
  for (const [key, componentId, variantId] of [
    ["private", "mark", "new"],
    ["icon", "card", "plain"],
    ["icon", "mark", "absent"],
  ]) {
    const overrides = JSON.stringify({
      slots: { [key]: { libraryId: "shop", componentId, variantId } },
    });
    assert.throws(
      () =>
        compile(doc, [
          new Layer(
            `<div data-forma-component="card" data-overrides='${overrides}'></div>`,
          ),
        ]),
      /data-overrides.slots/,
    );
  }
});

test("custom colors and radii snap to in-scope tokens in the inherited mode, excluding gradients and asymmetric corners", () => {
  const doc = fixture(),
    system = structuredClone(doc.libraries!.shop.designSystem!);
  // The document supplies the same exact value under another ID. The target library wins the tie.
  system.variables.local = {
    ...system.variables.brand,
    id: "local",
    name: "Local",
  };
  system.variables = { local: system.variables.local, ...system.variables };
  doc.designSystem = system;
  const parent = createNode("frame");
  parent.variableModes = { theme: "night" };
  doc.nodes = [parent];
  const css = {
    backgroundColor: "#fedcb0",
    borderRadius: "16px",
    "border-top-width": "1px",
    "border-top-style": "solid",
    "border-top-color": "#abcdef",
  };
  const tile = new Layer('<div data-forma-name="Tile"></div>', undefined, css);
  const uneven = new Layer('<div data-forma-name="Uneven"></div>', undefined, {
    ...css,
    borderTopLeftRadius: "12px",
    backgroundColor: "#000099",
  });
  const gradient = new Layer(
    '<div data-forma-name="Gradient"></div>',
    undefined,
    { ...css, backgroundImage: "linear-gradient(#123456, #ffffff)" },
  );
  const result = compile(doc, [tile, uneven, gradient], {
    selectionParentId: parent.id,
    activeLibraryId: "shop",
  });
  const next = replay(doc, result);
  const found = next.nodes.find((n) => n.name === "Tile")!;
  assert.deepEqual(found.variableBindings, {
    fill: "brand",
    radius: "radius",
    stroke: "wrong-scope",
  });
  assert.equal(found.style.fill, "#fedcba");
  assert.equal(found.style.radius, 16);
  assert.equal(resolveNode(next, found).style.fill, "#fedcba");
  assert.equal(
    next.nodes.find((n) => n.name === "Gradient")!.variableBindings?.fill,
    undefined,
  );
  assert.equal(
    next.nodes.find((n) => n.name === "Uneven")!.variableBindings?.radius,
    undefined,
  );
  assert.equal(
    next.nodes.find((n) => n.name === "Uneven")!.variableBindings?.fill,
    undefined,
  );
  assert.equal(result.stats.tokensBound, 6);
  const off = compile(fixture(), [tile], {
    activeLibraryId: "shop",
    snapLibraryTokens: false,
  });
  assert.equal(off.stats.tokensBound, 0);
  assert.equal(replay(fixture(), off).designSystem, undefined);
  const fresh = fixture(),
    alone = compile(
      fresh,
      [
        new Layer('<div data-forma-name="New"></div>', undefined, {
          backgroundColor: "#123457",
          borderRadius: "7.9px",
        }),
      ],
      { activeLibraryId: "shop" },
    );
  assert.equal(alone.stats.tokensBound, 1);
  assert.deepEqual(replay(fresh, alone).nodes[1].variableBindings, {
    fill: "brand",
  });
});

test("placeholder hydration uses the chosen variant's size and keeps explicit dimensions and flex growth", () => {
  const doc = fixture();
  const normal = new Layer(tag),
    flexible = new Layer(tag, undefined, { flexGrow: "1" });
  normal.style.width = "50%";
  const root = new Layer("<main>", undefined, { display: "flex" }, [
    normal,
    flexible,
    new Layer('<div data-forma-component="missing">'),
  ]);
  assert.equal(hydrateComponentPlaceholdersInDom(root.element(), doc), 2);
  assert.equal(normal.style.width, "50%");
  assert.equal(normal.style.boxSizing, "border-box");
  assert.equal(normal.cssVars.get("--forma-slot-width"), "180px");
  assert.equal(flexible.cssVars.get("--forma-slot-width"), "auto");
  assert.equal(flexible.cssVars.get("--forma-slot-height"), "60px");
  assert.ok(styles.some((s) => s.includes("@layer forma-slot-defaults")));
  assert.equal(hydrateComponentPlaceholdersInDom(normal.element(), doc), 1);
});

test("four boards compiled against the same revision remap IDs, share resources and undo in a single history step", () => {
  const doc = fixture();
  const boards: Pick<
    HtmlArtboardSpec,
    "width" | "height" | "refId" | "parentRef" | "role"
  >[] = [
    { refId: "home", role: "primary", width: 300, height: 200 },
    { refId: "detail", role: "primary", width: 200, height: 150 },
    { parentRef: "home", role: "exception", width: 300, height: 80 },
    { parentRef: "home", role: "overlay", width: 240, height: 100 },
  ];
  const positions = computeMatrixArtboardPlacements(doc, boards);
  assert.deepEqual(positions, [
    { x: 80, y: 80 },
    { x: 460, y: 80 },
    { x: 80, y: 360 },
    { x: 80, y: 520 },
  ]);
  const results = boards.map((b, i) =>
    compile(
      doc,
      [
        new Layer(tag),
        new Layer('<div data-forma-name="Tile">', undefined, {
          backgroundColor: "#123456",
        }),
      ],
      {
        ...b,
        name: "Board " + i,
        placement: positions[i],
        activeLibraryId: "shop",
      },
    ),
  );
  const originalIds = results.map((r) => r.createdRootIds[0]);
  assert.equal(new Set(originalIds).size, 4);
  const result = mergeHtmlArtboardResults(doc, results);
  const next = replay(doc, result);
  assert.equal(result.stats.componentsInserted, 4);
  assert.equal(result.stats.tokensBound, 4);
  assert.equal(result.stats.imagesLocalized, 1);
  assert.equal(
    result.transaction.operations.filter((o) => o.type === "setDesignSystem")
      .length,
    1,
  );
  assert.equal(
    result.transaction.operations.filter((o) => o.type === "putImage").length,
    1,
  );
  assert.equal(next.revision, doc.revision + 1);
  assert.deepEqual(
    next.nodes.filter((n) => !n.parentId).map((n) => n.id),
    result.createdRootIds,
  );
  assert.equal(new Set(result.createdRootIds).size, 4);
  assert.deepEqual(
    results.map((r) => r.createdRootIds[0]),
    originalIds,
  );
  assert.deepEqual(
    next.nodes
      .filter((n) => !n.parentId)
      .map((n) => ({ x: n.style.x, y: n.style.y })),
    positions,
  );
  const undone = travel(
    commit({ present: doc, past: [], future: [] }, next),
    "undo",
  );
  assert.deepEqual({ ...undone.present, revision: doc.revision }, doc);
});

test("matrix layout reserves explicit coordinates, rejects missing parents and supports forward parent references", () => {
  const doc = fixture(),
    old = createNode("frame");
  Object.assign(old.style, { x: -100, y: 15, width: 200, height: 80 });
  doc.nodes.push(old);
  const board = { width: 100, height: 60 };
  const boards = [
    { ...board, role: "detail" as const, parentRef: "a" },
    { ...board, refId: "a" },
    { ...board, role: "exception" as const },
    { ...board, placement: { x: 180, y: 15 } },
  ];
  assert.throws(
    () =>
      computeMatrixArtboardPlacements(doc, [
        ...boards,
        { ...board, role: "detail", parentRef: "unknown" },
      ]),
    /parentRef.*unknown/,
  );
  assert.deepEqual(
    computeMatrixArtboardPlacements(doc, boards, { x: 1, y: 1 }),
    [
      { x: 360, y: 155 },
      { x: 360, y: 15 },
      { x: 540, y: 15 },
      { x: 180, y: 15 },
    ],
  );
  assert.deepEqual(
    computeMatrixArtboardPlacements(fixture(), [board], { x: 200, y: 100 }),
    [{ x: 150, y: 70 }],
  );
  assert.throws(
    () =>
      computeMatrixArtboardPlacements(doc, [
        { ...board, placement: { x: 0, y: 20 } },
      ]),
    /重叠/,
  );
});

test("custom text and button ink observes the inclusive RGB threshold and scope", () => {
  const doc = fixture();
  const label = (name: string, color: string) => {
    const text = Object.assign(new Layer("<span>"), {
      nodeType: 3,
      textContent: name,
    });
    return new Layer(
      `<button data-forma-name="${name}">`,
      undefined,
      { color, backgroundColor: "#ffffff" },
      [text],
    );
  };
  const result = compile(
    doc,
    [label("within", "#123462"), label("outside", "#123463")],
    { activeLibraryId: "shop" },
  );
  const buttons = replay(doc, result).nodes.filter((n) => n.type === "button");
  assert.equal(buttons.length, 2);
  assert.equal(buttons[0].variableBindings?.color, "brand");
  assert.equal(buttons[0].style.color, "#123456");
  assert.equal(buttons[1].variableBindings?.color, undefined);
  assert.equal(result.stats.tokensBound, 1);
});

test("browser entry sanitizes slot metadata, measures each board in a separate scriptless iframe and returns one transaction", async () => {
  // These fragments are deliberately flat. The legacy suite covers nested HTML parsing.
  class Fragment extends Layer {
    removed = false;
    set innerHTML(html: string) {
      this.childNodes = Array.from(html.matchAll(/<[a-z][^>]*>/gi), ([tag]) => {
        const el = new Fragment(tag);
        el.parentElement = this;
        return el;
      });
    }
    get innerHTML(): string {
      return (this.childNodes as Fragment[])
        .filter((n) => !n.removed)
        .map(
          (n) =>
            `<${n.localName} ${Array.from(n.attrs, ([k, v]) => `${k}='${v}'`).join(" ")}></${n.localName}>`,
        )
        .join("");
    }
    get attributes() {
      return Array.from(this.attrs, ([name, value]) => ({
        name,
        localName: name,
        value,
      }));
    }
    setAttribute(key: string, value: string) {
      this.attrs.set(key, value);
    }
    removeAttributeNode(attr: { name: string }) {
      this.attrs.delete(attr.name);
    }
    remove() {
      this.removed = true;
    }
  }
  const frames: { removed: boolean; attrs: Map<string, string> }[] = [];
  const htmlDocument = {
    body: { appendChild() {} },
    createElement(name: string) {
      if (name === "template") {
        const fragment = new Fragment("<div>");
        return Object.assign(fragment, {
          content: { querySelectorAll: () => fragment.childNodes },
        });
      }
      assert.equal(name, "iframe");
      const frame = Object.assign(new Fragment("<iframe>"), {
        contentDocument: {
          open() {},
          write(scaffold: string) {
            assert.match(scaffold, /script-src 'none'/);
          },
          close() {},
          head: { appendChild() {} },
          body: { appendChild() {} },
          createElement(tag: string) {
            return new Fragment(`<${tag}>`);
          },
        },
      });
      frames.push(frame);
      return frame;
    },
  };
  const previous = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: htmlDocument,
  });
  try {
    const metadata = tag.replace(
      "></div>",
      ` data-library="shop" data-component="card" data-variant="promo" data-forma-name="Buy" data-icon="cart" data-forma-asset-id="${assetId}" onclick="run()" href="javascript:bad()"></div><script></script><iframe></iframe>`,
    );
    const clean = sanitizeDesignHtml(
      metadata,
      '@import "https://example.invalid"; .ok{color:red}',
    );
    for (const attr of [
      "data-forma-component",
      "data-library",
      "data-component",
      "data-variant",
      "data-variant-props",
      "data-overrides",
      "data-forma-name",
      "data-forma-asset-id",
      "data-icon",
    ])
      assert.ok(clean.html.includes(attr + "="), attr);
    assert.doesNotMatch(clean.html, /onclick|javascript:|<script|<iframe/i);
    assert.doesNotMatch(clean.css, /@import/);
    const doc = fixture();
    const first = {
      name: "Buy",
      refId: "buy",
      width: 320,
      height: 480,
      html: metadata,
    };
    const result = await compileHtmlDraftInBrowser(
      {
        ...first,
        targetLibraryId: "shop",
        snapLibraryTokens: true,
        artboards: [
          first,
          {
            ...first,
            name: "Failed",
            refId: "failed",
            role: "exception",
            parentRef: "buy",
          },
        ],
      },
      { baseDocument: doc },
    );
    assert.equal(frames.length, 2);
    assert.ok(
      frames.every(
        (f) => f.removed && f.attrs.get("sandbox") === "allow-same-origin",
      ),
    );
    const next = replay(doc, result);
    assert.equal(next.revision, doc.revision + 1);
    assert.equal(result.stats.componentsInserted, 2);
    assert.deepEqual(
      next.nodes
        .filter((n) => !n.parentId)
        .map((n) => [n.name, n.style.x, n.style.y]),
      [
        ["Buy", 80, 80],
        ["Failed", 80, 640],
      ],
    );
    assert.equal(
      result.transaction.operations.filter((o) => o.type === "setDesignSystem")
        .length,
      1,
    );
    assert.equal(
      result.transaction.operations.filter((o) => o.type === "putImage").length,
      1,
    );
    assert.deepEqual(result.warnings, []);
  } finally {
    if (previous) Object.defineProperty(globalThis, "document", previous);
    else Reflect.deleteProperty(globalThis, "document");
  }
});

test("Forma Mobile dark button keeps its source, theme and editable text after save and reopen", () => {
  const library = mobileComponentLibrary("button");
  const doc = parseDocument({
    ...fixture(),
    libraries: { [library.id]: library },
  });
  const result = compile(doc, [
    new Layer(
      `<div data-forma-component="${library.id}/button" data-variant-props='{"Appearance":"Dark","Size":"Large","Style":"Primary","State":"Default"}' data-overrides='{"text":"加入购物车","fill":"#456"}'></div>`,
      [0, 0, 220, 54],
    ),
  ]);
  const reopened = parseDocument(
    JSON.parse(JSON.stringify(replay(doc, result))),
  );
  const button = reopened.nodes.find((n) => n.instance)!;
  assert.equal(button.type, "button");
  assert.equal(button.instance!.variantId, "Dark-Primary-Large-Default");
  assert.equal(button.text, "加入购物车");
  assert.equal(resolveNode(reopened, button).style.fill, "#445566");
  assert.equal(result.stats.componentsInserted, 1);
  assert.equal(result.stats.tokensBound, 0);
  validateInstanceStructure(reopened, button);
});

test("merging independently compiled boards unions disjoint libraries and token definitions", () => {
  const doc = fixture();
  const shop = doc.libraries!.shop;
  const system = shop.designSystem!;
  const second = parseLibrary({
    ...shop,
    id: "catalog",
    name: "Catalog",
    designSystem: {
      collections: {
        catalogTheme: { ...system.collections.theme, id: "catalogTheme" },
      },
      activeModes: { catalogTheme: "night" },
      variables: {
        catalogInk: {
          ...system.variables.brand,
          id: "catalogInk",
          collectionId: "catalogTheme",
        },
      },
      styles: {},
    },
  });
  // Each branch starts with its own library available. Both assets will be installed in the destination transaction.
  const base: DesignDocument = { ...doc, libraries: {} };
  const results = [shop, shop, second].map((library) => {
    const source = { ...base, libraries: { [library.id]: library } };
    const result = compile(
      source,
      [new Layer('<div data-forma-component="card"></div>')],
      { activeLibraryId: library.id },
    );
    result.transaction.operations.unshift({ type: "putLibrary", library });
    return result;
  });
  const combined = mergeHtmlArtboardResults(base, results);
  assert.equal(
    combined.transaction.operations.filter((o) => o.type === "putLibrary")
      .length,
    2,
  );
  assert.equal(
    combined.transaction.operations.filter((o) => o.type === "setDesignSystem")
      .length,
    1,
  );
  assert.equal(
    combined.transaction.operations.filter((o) => o.type === "putImage").length,
    1,
  );
  const next = replay(base, combined);
  assert.deepEqual(Object.keys(next.libraries!).sort(), ["catalog", "shop"]);
  assert.deepEqual(next.designSystem!.activeModes, {
    theme: "day",
    catalogTheme: "night",
  });
  assert.ok(
    next.designSystem!.variables.brand &&
      next.designSystem!.variables.catalogInk,
  );
  assert.deepEqual(
    next.nodes.filter((n) => n.instance).map((n) => n.instance!.libraryId),
    ["shop", "shop", "catalog"],
  );
});

test("current-page-only compilation replays on the full file beside legacy inactive-page IDs", () => {
  const original = fixture();
  original.nodes = [{ ...createNode("frame"), id: "html-4-1" }];
  const full = addPage(original, "New page");
  full.revision = 4;
  const result = compile(currentPageOnly(full), [new Layer("<div>")]);
  assert.match(result.createdRootIds[0], /^html-[a-f0-9-]{36}$/);
  const next = replay(full, result);
  assert.equal(next.nodes.length, 2);
  assert.ok(
    next.pages?.some((page) => page.nodes?.some((n) => n.id === "html-4-1")),
  );
});

test("target library excludes foreign colors and radii; document-only compilation uses them", () => {
  const doc = fixture();
  const system = structuredClone(doc.libraries!.shop.designSystem!);
  system.variables.foreign = {
    ...system.variables.brand,
    id: "foreign",
    name: "Foreign paint",
    values: { day: "#aabbcc", night: "#aabbcc" },
  };
  system.variables.foreignRadius = {
    ...system.variables.radius,
    id: "foreignRadius",
    name: "Foreign radius",
    values: { day: 8.5, night: 8.5 },
  };
  doc.designSystem = system;
  doc.libraries!.other = {
    ...doc.libraries!.shop,
    id: "other",
    designSystem: system,
  };
  const tile = new Layer('<div data-forma-name="Tile"></div>', undefined, {
    backgroundColor: "#aabbcc",
    borderRadius: "8.5px",
  });
  for (const activeLibraryId of ["shop", "missing", undefined]) {
    const result = compile(doc, [tile], { activeLibraryId });
    const node = replay(doc, result).nodes.find((n) => n.name === "Tile")!;
    assert.equal(
      node.variableBindings?.fill,
      activeLibraryId ? undefined : "foreign",
    );
    assert.equal(
      node.variableBindings?.radius,
      activeLibraryId ? undefined : "foreignRadius",
    );
    assert.equal(node.style.radius, 8.5);
  }
});

test("multiple public swap choices preserve a __proto__ template key", () => {
  const doc = fixture();
  const component = doc.libraries!.shop.components[0];
  for (const variant of component.variants) {
    const badge = variant.nodes.find((n) => n.templateKey === "badge")!;
    badge.templateKey = "__proto__";
    variant.nodes.push({ ...badge, id: "second", templateKey: "second" });
  }
  component.exposed!.find((p) => p.id === "icon")!.target = "__proto__";
  component.exposed!.push({
    id: "another",
    name: "Another",
    kind: "swap",
    target: "second",
  });
  const choice = { libraryId: "shop", componentId: "mark", variantId: "new" };
  const el = new Layer(
    `<div data-forma-component="card" data-overrides='${JSON.stringify({ slots: { icon: choice, another: choice } })}'></div>`,
  );
  const slot = resolveHtmlComponentSlot(doc, el.element())!;
  for (const key of ["__proto__", "second"])
    assert.deepEqual(
      slot.live.nodes.find((n) => n.templateKey === key)?.nestedSource,
      choice,
    );
  const result = compile(doc, [el]);
  assert.equal(
    result.transaction.operations.filter((op) => op.type === "setInstanceSlot")
      .length,
    2,
  );
  const next = replay(doc, result);
  for (const state of [next, parseDocument(JSON.parse(JSON.stringify(next)))]) {
    const instance = state.nodes.find(
      (n) => n.instance?.componentId === "card",
    )!.instance!;
    assert.deepEqual(Object.keys(instance.slots!).sort(), [
      "__proto__",
      "second",
    ]);
    assert.equal(Object.getPrototypeOf(instance.slots), null);
    for (const key of ["__proto__", "second"]) {
      assert.deepEqual(instance.slots![key], choice);
      assert.deepEqual(
        state.nodes.find((n) => n.templateKey === key)?.nestedSource,
        choice,
      );
    }
  }
  const saved = JSON.parse(JSON.stringify(next));
  const root = saved.nodes.find(
    (n: DesignNode) => n.instance?.componentId === "card",
  );
  root.instance.slotProperties = JSON.parse(
    JSON.stringify(root.instance.slots),
  );
  for (const property of saved.libraries.shop.components[0].exposed)
    if (property.kind === "swap") property.id = property.target;
  const reopened = parseDocument(saved);
  const props = reopened.nodes.find((n) => n.id === root.id)!.instance!
    .slotProperties!;
  assert.equal(Object.getPrototypeOf(props), null);
  assert.deepEqual(Object.entries(props), Object.entries(root.instance.slots));
  const changed = transact(reopened, {
    baseRevision: reopened.revision,
    operations: [{ type: "switchInstance", id: root.id, variantId: "promo" }],
  });
  assert.deepEqual(
    changed.nodes.find((n) => n.id === root.id)!.instance!.slots,
    next.nodes.find((n) => n.id === root.id)!.instance!.slots,
  );
  for (const key of ["slots", "slotProperties"] as const) {
    const invalid = JSON.parse(JSON.stringify(changed));
    const ref = invalid.nodes.find((n: DesignNode) => n.id === root.id)
      .instance[key];
    ref["__proto__"] = { componentId: "bad" };
    assert.throws(() => parseDocument(invalid));
  }
  assert.equal(Object.hasOwn(Object.prototype, "componentId"), false);
});

test("matrix placement rejects duplicate symbolic IDs and cyclic parent relationships directly", () => {
  const board = { width: 200, height: 300 };
  const home = { ...board, refId: "home", role: "primary" as const };
  const state = {
    ...board,
    refId: "state",
    role: "detail" as const,
    parentRef: "home",
  };
  assert.throws(
    () => computeMatrixArtboardPlacements(fixture(), [home, home]),
    /重复.*home/,
  );
  assert.throws(
    () =>
      computeMatrixArtboardPlacements(fixture(), [
        home,
        { ...state, parentRef: "state" },
      ]),
    /parentRef.*state/,
  );
  assert.throws(
    () =>
      computeMatrixArtboardPlacements(fixture(), [
        { ...home, role: "exception", parentRef: "state" },
        state,
      ]),
    /parentRef/,
  );
});
