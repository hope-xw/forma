import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { strToU8, strFromU8, zipSync } from "fflate";
import { validateProposal } from "../src/agent/provider";
import { commit, travel } from "../src/application/history";
import { nodeCss } from "../src/compiler/react";
import { prototypeProgram, runtimeNodes } from "../src/compiler/runtime";
import { reactFileProject } from "../src/compiler/file-project";
import { transact, type Operation } from "../src/domain/commands";
import {
  createNode,
  parseDocument,
  type DesignDocument,
  type DesignNode,
  type NodeStyle,
} from "../src/domain/document";
import { designSystemSchema } from "../src/domain/design-system-schema";
import { layoutBounds } from "../src/domain/geometry";
import { addPage, duplicatePage, openPage } from "../src/domain/pages";
import { actionSchema, interactionSchema } from "../src/domain/prototype";
import { flowInsets } from "../src/domain/sizing";
import {
  inspectProjectRevision,
  mergeProjectRevision,
  readSourceProject,
  withProjectManifest,
} from "../src/infrastructure/project-revision";
import {
  exportNodeToSvg,
  exportNodeAsRaster,
  downloadStaticExport,
} from "../src/infrastructure/static-export";
import { DesignNodeView } from "../src/runtime/FormaRuntime";
import { PrototypePlayer } from "../src/runtime/PrototypePlayer";
import {
  actionsFor,
  startFlow,
  trigger,
} from "../src/runtime/prototype-machine";

const file = (...nodes: DesignNode[]): DesignDocument => ({
  schemaVersion: 1,
  id: "phase2",
  name: "Phase 2",
  revision: 0,
  tokens: {},
  nodes,
});
const apply = (doc: DesignDocument, ...operations: Operation[]) =>
  transact(doc, { baseRevision: doc.revision, operations });
function layer(
  type: DesignNode["type"],
  id: string,
  parentId: string | null,
  style: Partial<NodeStyle> = {},
) {
  const n = createNode(type, parentId);
  n.id = id;
  Object.assign(n.style, style);
  return n;
}
test("page background patches share nodes, survive save, duplicate independently and undo/redo", () => {
  const d = file(layer("frame", "frame", null));
  const bg = apply(d, {
    type: "setPageBackground",
    color: "#123aBC",
    opacity: 0.6,
    visible: true,
  });
  assert.equal(bg.nodes, d.nodes);
  const hidden = apply(
    bg,
    { type: "setPageBackground", visible: false },
    { type: "setPageBackground", opacity: 0 },
  );
  assert.equal(hidden.revision, 2);
  const undo = travel(
    commit({ present: bg, past: [], future: [] }, hidden),
    "undo",
  );
  assert.equal(undo.present.pageBackgroundOpacity, 0.6);
  assert.equal(travel(undo, "redo").present.pageBackgroundVisible, false);
  const blank = addPage(hidden, "Second");
  assert.equal(blank.pageBackground, undefined);
  const second = apply(blank, { type: "setPageBackground", color: "#ffffff" });
  const first = openPage(
    parseDocument(JSON.parse(JSON.stringify(second))),
    "first",
  );
  assert.deepEqual(
    [
      first.pageBackground,
      first.pageBackgroundOpacity,
      first.pageBackgroundVisible,
    ],
    ["#123aBC", 0, false],
  );
  const copy = duplicatePage(first);
  assert.equal(copy.pageBackgroundOpacity, 0);
  const changed = apply(
    copy,
    { type: "setPageBackground", color: "#eeffee" },
    { type: "update", id: copy.nodes[0].id, patch: { name: "copy" } },
  );
  assert.equal(openPage(changed, "first").pageBackground, first.pageBackground);
  assert.throws(() => apply(d, { type: "setPageBackground", color: "#fff" }));
  assert.throws(() => apply(d, { type: "setPageBackground", opacity: 1.01 }));
  assert.throws(() =>
    validateProposal(
      { prompt: "edit selection", document: d, selection: "frame" },
      {
        baseRevision: 0,
        operations: [{ type: "setPageBackground", opacity: 0 }],
      },
    ),
  );
});
test("stroke sides override individual widths, visibility and alignment control content insets", () => {
  const n = layer("frame", "n", null, {
    layout: "row",
    stroke: "#abcdef",
    strokeWidth: 6,
    strokeSides: { left: 2, top: 0, right: 8 },
    padding: 3,
  });
  const child = layer("rectangle", "child", "n");
  const doc = file(n, child);
  assert.deepEqual(flowInsets(n), { left: 5, top: 3, right: 11, bottom: 9 });
  assert.equal(nodeCss(n, doc).borderTopWidth, "0px");
  assert.equal(nodeCss(n, doc).borderBottomWidth, "6px");
  assert.equal(layoutBounds(doc).get("child")!.x, 5);
  n.style.strokeAlign = "center";
  assert.equal(flowInsets(n).right, 7);
  n.style.strokeDash = "6, 4";
  assert.match(
    decodeURIComponent(String(nodeCss(n, doc).borderImageSource)),
    /stroke-dasharray="6, 4"/,
  );
  n.style.strokeAlign = "outside";
  assert.deepEqual(flowInsets(n), { left: 3, right: 3, top: 3, bottom: 3 });
  n.style.strokeVisible = false;
  assert.equal(nodeCss(n, doc).border, 0);
  assert.equal(n.style.strokeWidth, 6);
  assert.equal(n.style.strokeSides?.right, 8);
  n.style.strokeSides = { left: 80 };
  assert.doesNotThrow(() => parseDocument(doc));
  n.style.strokeSides = { left: 101 };
  assert.throws(() => parseDocument(doc));
});
test("typography and effect visibility agree in compiled CSS and rendered runtime markup", () => {
  const shadow = {
    x: 1,
    y: 2,
    blur: 3,
    spread: 0,
    color: "#334455",
    opacity: 0.6,
    inset: false,
  };
  const n = layer("text", "label", null, {
    fontStyle: "italic",
    textDecoration: "underline",
    textTransform: "uppercase",
    verticalAlign: "middle",
    blendMode: "pass-through",
    blur: 6,
    blurVisible: false,
    backdropBlur: 8,
    backdropBlurVisible: false,
    shadows: [{ ...shadow, x: 99, visible: false }, shadow],
  });
  const d = file(n);
  assert.equal(nodeCss(n, d).display, "flex");
  assert.equal(nodeCss(n, d).justifyContent, "center");
  n.style.maxLines = 2;
  const css = nodeCss(n, parseDocument(d));
  assert.deepEqual(
    [css.display, css.WebkitLineClamp, css.WebkitBoxOrient, css.overflow],
    ["-webkit-box", 2, "vertical", "hidden"],
  );
  assert.equal(css.mixBlendMode, undefined);
  assert.equal(css.filter, undefined);
  assert.equal(css.backdropFilter, undefined);
  assert.match(String(css.boxShadow), /^1px 2px/);
  const html = renderToStaticMarkup(
    createElement(DesignNodeView, { node: runtimeNodes(d)[0] }),
  );
  for (const property of [
    "-webkit-line-clamp:2",
    "font-style:italic",
    "text-transform:uppercase",
    "text-decoration:underline",
  ])
    assert.ok(html.includes(property), property);
  assert.doesNotMatch(html, /99px|mix-blend-mode|backdrop-filter/);
  n.hidden = true;
  assert.equal(nodeCss(n, d).display, "none");
  n.style.maxLines = 101;
  assert.throws(() => parseDocument(d));
});
test("row, column, wrap and Hug allocate only in-flow children; offsets survive responsive measurement", () => {
  for (const row of [true, false]) {
    const p = layer("frame", "parent", null, {
      layout: row ? "row" : "column",
      width: 200,
      height: 200,
      padding: 10,
      gap: 5,
      justifyContent: "space-between",
    });
    const items = ["a", "b", "c"].map((id) =>
      layer("rectangle", id, "parent", { width: 20, height: 20 }),
    );
    const absolute = layer("rectangle", "overlay", "parent", {
      absolutePosition: true,
      x: 31,
      y: 47,
      width: 1300,
      height: 1200,
      widthMode: "fill",
    });
    const doc = file(p, items[0], absolute, ...items.slice(1)),
      bounds = layoutBounds(doc);
    assert.deepEqual(
      items.map((n) => bounds.get(n.id)![row ? "x" : "y"]),
      [10, 90, 170],
    );
    assert.deepEqual(bounds.get("overlay"), {
      x: 31,
      y: 47,
      width: 1300,
      height: 1200,
    });
    const css = nodeCss(absolute, doc);
    assert.deepEqual(
      [css.position, css.left, css.top, css.width],
      ["absolute", 31, 47, 1300],
    );
    assert.equal(nodeCss(p, doc).justifyContent, "space-between");
    p.style[row ? "widthMode" : "heightMode"] = "hug";
    assert.equal(
      layoutBounds(doc).get("parent")![row ? "width" : "height"],
      90,
    );
  }
  const p = layer("frame", "p", null, {
    layout: "row",
    width: 120,
    padding: 0,
    gap: 5,
    wrap: true,
    justifyContent: "space-between",
  });
  const children = ["a", "b", "c"].map((id) =>
    layer("rectangle", id, "p", { width: 50, height: 25 }),
  );
  const boxes = layoutBounds(file(p, ...children));
  assert.equal(boxes.get("b")!.x, 70);
  assert.deepEqual(boxes.get("c"), { x: 0, y: 30, width: 50, height: 25 });
});
test("prototype triggers select one branch, HTTP links validate, and transitions survive page compilation", () => {
  const screen = layer("frame", "home", null),
    next = layer("frame", "detail", null),
    hotspot = layer("rectangle", "hot", "home");
  hotspot.interaction = interactionSchema.parse({
    trigger: "hover",
    actions: [
      { kind: "openLink", url: "https://example.org/" },
      {
        kind: "navigate",
        target: "detail",
        transition: {
          type: "push",
          direction: "top",
          duration: 200,
          easing: "linear",
        },
      },
    ],
  });
  next.interaction = interactionSchema.parse({
    trigger: "delay",
    delayMs: 30,
    actions: [
      {
        kind: "overlay",
        target: "home",
        position: "bottom",
        transition: { type: "dissolve", duration: 50 },
      },
    ],
  });
  const d = parseDocument(file(screen, next, hotspot)),
    program = prototypeProgram(d)!;
  const start = startFlow(program, "home");
  assert.equal(trigger(program, start, "hot", true), start);
  assert.equal(actionsFor(program.rules.hot, start)[0].kind, "openLink");
  const hovered = trigger(program, start, "hot", true, "hover");
  assert.equal(hovered.screen, "detail");
  assert.deepEqual(hovered.controls, {});
  assert.equal(trigger(program, hovered, "detail", true), hovered);
  assert.equal(
    trigger(program, hovered, "detail", true, "delay").overlays[0].target,
    "home",
  );
  assert.throws(() =>
    actionSchema.parse({ kind: "openLink", url: "javascript:alert(1)" }),
  );
  assert.throws(() =>
    actionSchema.parse({ kind: "openLink", url: "//example.org" }),
  );
  assert.throws(() =>
    interactionSchema.parse({ trigger: "delay", delayMs: -1 }),
  );
  assert.ok(
    actionSchema.safeParse({ kind: "openLink", url: "http://example.org" })
      .success,
  );
  const html = renderToStaticMarkup(
    createElement(PrototypePlayer, {
      nodes: runtimeNodes(d),
      program,
      start: "home",
    }),
  );
  assert.match(html, /data-forma-hover=""/);
  assert.match(html, /data-forma-hotspot=""/);
  assert.match(html, /data-active-screen=""/);
  const exported = reactFileProject(d, [], "", {}, "")["src/Page1.tsx"];
  for (const fragment of [
    '"trigger": "hover"',
    '"duration": 200',
    '"delayMs": 30',
    "ProjectPrototypePlayer as PrototypePlayer",
  ])
    assert.ok(exported.includes(fragment));
});
test("standalone SVG resolves tokens, visual order, images, geometry, vector paths and rich text without executable markup", () => {
  const frame = layer("frame", "root", null, {
    x: 124,
    y: 60,
    layout: "row",
    justifyContent: "space-between",
    width: 240,
    height: 100,
    padding: 0,
    radius: 11,
    clipContent: true,
  });
  const box = layer("rectangle", "shape", "root", {
    width: 70,
    height: 50,
    stroke: "#123456",
    strokeWidth: 2,
    strokeSides: { left: 7 },
    strokeDash: "6, 4",
    rotation: 10,
    flipX: true,
    blur: 2,
  });
  const text = layer("text", "text", "root", {
    width: 120,
    fontStyle: "italic",
  });
  text.text = "A<& B";
  text.textRuns = [
    { start: 1, end: 3, style: { fontWeight: 700, color: "#bb0000" } },
  ];
  const vector = layer("vector", "v", "root", {
    absolutePosition: true,
    x: 5,
    y: 7,
    width: 15,
    height: 15,
  });
  vector.vector = {
    width: 10,
    height: 10,
    paths: [
      { d: "M0 0L10 10", fill: false, strokeWidth: 1, strokeColor: "#246810" },
    ],
  };
  const hidden = layer("rectangle", "hidden", "root", { fill: "#decade" });
  hidden.hidden = true;
  const d = file(frame, box, text, vector, hidden);
  frame.fillToken = "old";
  d.tokens.old = { name: "base", value: "#987654" };
  box.style.paints = [
    { id: "top", color: "#123abc", opacity: 0.4, visible: true },
    { id: "under", color: "#aabbdd", opacity: 1, visible: true },
  ];
  box.style.gradient = {
    type: "linear",
    angle: 33,
    stops: [
      { offset: 0, color: "#000000", opacity: 1, variableId: "ink" },
      { offset: 1, color: "#ffffff", opacity: 0.5 },
    ],
  };
  d.designSystem = designSystemSchema.parse({
    collections: {
      core: {
        id: "core",
        name: "Core",
        defaultModeId: "day",
        modes: [{ id: "day", name: "Day" }],
      },
    },
    variables: {
      ink: {
        id: "ink",
        collectionId: "core",
        name: "ink",
        type: "color",
        values: { day: "#cdcd19" },
      },
    },
    styles: {},
    activeModes: { core: "day" },
  });
  box.style.shadows = [
    {
      x: 4,
      y: 5,
      blur: 6,
      spread: 1,
      color: "#333444",
      opacity: 0.7,
      inset: false,
    },
  ];
  const asset = "img-" + "1".repeat(64);
  d.images = {
    [asset]: {
      name: "dot",
      width: 1,
      height: 1,
      data: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j2foAAAAASUVORK5CYII=",
    },
  };
  box.image = { assetId: asset, x: 50, y: 50, zoom: 1, fit: "contain" };
  const svg = exportNodeToSvg(d, frame.id);
  assert.match(
    svg,
    /^<svg xmlns="http:\/\/www.w3.org\/2000\/svg" width="240" height="100" viewBox="0 0 240 100">/,
  );
  for (const part of [
    "#987654",
    "#cdcd19",
    "linearGradient",
    "feGaussianBlur",
    "feOffset",
    'stroke-width="7"',
    'stroke-dasharray="6, 4"',
    "<image",
    "data:image/png;base64,",
    "<clipPath",
    "M0 0L10 10",
    "#246810",
    'font-weight="700"',
    "&lt;&amp;",
    "matrix(",
  ])
    assert.ok(svg.includes(part), part);
  assert.ok(
    svg.indexOf("<image") < svg.indexOf("#aabbdd") &&
      svg.indexOf("#aabbdd") < svg.indexOf("#123abc"),
  );
  assert.doesNotMatch(svg, /#decade|foreignObject|<script/);
  const selected = exportNodeToSvg(d, "text");
  assert.match(selected, /viewBox="0 0 120 36"/);
  assert.doesNotMatch(selected, /data:image|linearGradient/);
  assert.throws(() => exportNodeToSvg(d, "missing"));
});
test("revision inspection collects edit, removal and add collisions; choices preserve exact binary bytes and developer files", async () => {
  const identity = {
    documentId: "d",
    pageId: "first",
    scope: "file" as const,
    selection: [],
  };
  const binary = "src/assets/icon.png";
  const previous = await withProjectManifest(
    {
      "src/Page1.tsx": strToU8("first"),
      "src/Page2.tsx": strToU8("remove"),
      "src/Page3.tsx": strToU8("old"),
      "src/Page4.tsx": strToU8("unused"),
      "src/main.tsx": strToU8("developer"),
      "src/tokens.css": strToU8("stable"),
    },
    identity,
  );
  previous["src/Page1.tsx"] = strToU8("local");
  previous["src/Page2.tsx"] = strToU8("edited before deletion");
  previous[binary] = Uint8Array.of(255, 254, 3);
  const zip = zipSync(previous),
    next = {
      "src/Page1.tsx": "first updated",
      "src/Page3.tsx": "new",
      "src/Page5.tsx": "added",
      "src/main.tsx": "template",
      "src/tokens.css": "stable",
      [binary]: Uint8Array.of(240, 128, 255),
    };
  const result = await inspectProjectRevision(zip, next);
  assert.deepEqual(result.added, ["src/Page5.tsx"]);
  assert.deepEqual(result.removed, ["src/Page4.tsx"]);
  assert.deepEqual(result.modified, ["src/Page3.tsx"]);
  assert.deepEqual(result.preserved, ["src/main.tsx", "src/tokens.css"]);
  assert.deepEqual(
    result.conflicts.map((c) => c.path),
    ["src/Page1.tsx", "src/Page2.tsx", binary],
  );
  assert.deepEqual(result.conflicts[0], {
    path: "src/Page1.tsx",
    localContent: "local",
    incomingContent: "first updated",
  });
  assert.equal(result.conflicts[1].incomingContent, "");
  assert.match(
    result.conflicts[2].localContent,
    /^data:application\/octet-stream;base64,/,
  );
  await assert.rejects(mergeProjectRevision(zip, next), /本地改动/);
  await assert.rejects(
    mergeProjectRevision(zip, next, { "src/Page1.tsx": "local" }),
    /Page2/,
  );
  const merged = await mergeProjectRevision(readSourceProject(zip), next, {
    "src/Page1.tsx": "local",
    "src/Page2.tsx": "incoming",
    [binary]: "incoming",
  });
  assert.equal(strFromU8(merged["src/Page1.tsx"]), "local");
  assert.ok(!Object.hasOwn(merged, "src/Page2.tsx"));
  assert.deepEqual(merged[binary], next[binary]);
  assert.equal(strFromU8(merged["src/main.tsx"]), "developer");
  assert.equal(
    (await inspectProjectRevision(zipSync(merged), next)).conflicts.length,
    0,
  );
  const again = await mergeProjectRevision(zip, next, {
    "src/Page1.tsx": "incoming",
    "src/Page2.tsx": "local",
    [binary]: "local",
  });
  assert.deepEqual(again[binary], previous[binary]);
  assert.equal(strFromU8(again["src/Page2.tsx"]), "edited before deletion");
});

test("independent SVG viewport includes outside strokes, shadow ink and overflowing children", () => {
  const frame = layer("frame", "f", null, {
    width: 100,
    height: 100,
    strokeWidth: 4,
    strokeAlign: "outside",
  });
  const child = layer("rectangle", "c", "f", {
    x: 90,
    y: 0,
    width: 50,
    height: 30,
  });
  const d = file(frame, child);
  assert.match(exportNodeToSvg(d, "f"), /viewBox="0 0 144 108"/);
  frame.style.clipContent = true;
  assert.match(exportNodeToSvg(d, "f"), /viewBox="0 0 108 108"/);
  frame.style.strokeVisible = false;
  frame.style.shadows = [
    {
      x: 10,
      y: 0,
      blur: 4,
      spread: 0,
      inset: false,
      opacity: 1,
      color: "#000000",
    },
  ];
  assert.match(exportNodeToSvg(d, "f"), /viewBox="0 0 116 112"/);
});

test("raster adapter draws scaled dimensions, forwards encoder arguments, rejects fallback MIME and names downloads", async (t) => {
  const doc = file(
    layer("rectangle", "export", null, { width: 7, height: 5, radius: 0 }),
  );
  doc.nodes[0].name = "Card/Front";
  const draws: number[][] = [],
    fills: number[][] = [],
    encodings: { mime: string; quality?: number }[] = [];
  let encodedType: string | undefined,
    downloads: string[] = [];
  const canvas = {
    width: 0,
    height: 0,
    getContext: () => ({
      drawImage: (_image: unknown, ...rect: number[]) => draws.push(rect),
      fillRect: (...rect: number[]) => fills.push(rect),
    }),
    toBlob: (
      callback: (blob: Blob) => void,
      mime: string,
      quality?: number,
    ) => {
      encodings.push({ mime, quality });
      callback(new Blob(["encoded-by-test"], { type: encodedType ?? mime }));
    },
  };
  function setGlobal(key: string, value: unknown) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, {
      value,
      writable: true,
      configurable: true,
    });
    t.after(() => {
      if (previous) Object.defineProperty(globalThis, key, previous);
      else Reflect.deleteProperty(globalThis, key);
    });
  }
  setGlobal(
    "Image",
    class {
      async decode() {}
    },
  );
  setGlobal("document", {
    createElement: (tag: string) =>
      tag === "canvas"
        ? canvas
        : {
            download: "",
            click(this: { download: string }) {
              downloads.push(this.download);
            },
          },
  });
  const release = t.mock.method(URL, "revokeObjectURL", () => {});
  t.mock.method(URL, "createObjectURL", () => "blob:forma-test");
  for (const format of ["png", "jpeg", "webp"] as const) {
    const blob = await exportNodeAsRaster(doc, "export", {
      format,
      scale: 3,
      quality: 0.8,
    });
    assert.equal(blob.type, "image/" + format);
    assert.deepEqual(draws.at(-1), [0, 0, 21, 15]);
    assert.deepEqual(encodings.at(-1), {
      mime: "image/" + format,
      quality: 0.8,
    });
  }
  assert.deepEqual(fills, [[0, 0, 21, 15]]);
  encodedType = "image/png";
  await assert.rejects(
    exportNodeAsRaster(doc, "export", { format: "webp", scale: 2 }),
    /编码/,
  );
  assert.equal(release.mock.callCount(), 4);
  encodedType = undefined;
  await downloadStaticExport(doc, "export", { format: "svg", scale: 1 });
  await downloadStaticExport(doc, "export", { format: "png", scale: 2 });
  assert.deepEqual(downloads, ["Card_Front@1x.svg", "Card_Front@2x.png"]);
});

test("accepting a local deletion survives retries and a later upstream edit reopens its conflict", async () => {
  const path = "src/Page1.tsx",
    next = { [path]: "generated" };
  const previous = await withProjectManifest(
    { [path]: strToU8("generated") },
    { documentId: "d", pageId: "first", scope: "file", selection: [] },
  );
  delete previous[path];
  const archive = zipSync(previous);
  await assert.rejects(mergeProjectRevision(archive, next), /缺少生成文件/);
  const resolved = zipSync(
    await mergeProjectRevision(archive, next, { [path]: "local" }),
  );
  assert.equal(
    (await inspectProjectRevision(resolved, next)).conflicts.length,
    0,
  );
  assert.ok(!Object.hasOwn(await mergeProjectRevision(resolved, next), path));
  const later = { [path]: "regenerated" };
  assert.equal(
    (await inspectProjectRevision(resolved, later)).conflicts[0].path,
    path,
  );
  assert.equal(
    strFromU8(
      (await mergeProjectRevision(resolved, later, { [path]: "incoming" }))[
        path
      ],
    ),
    "regenerated",
  );
});
