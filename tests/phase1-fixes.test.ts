import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { commit, travel } from "../src/application/history";
import { exportReact, nodeCss } from "../src/compiler/react";
import { runtimeNodes } from "../src/compiler/runtime";
import { nativeDesignSystem } from "../src/design-system/tokens";
import {
  changeProfile,
  convertColor,
  displayColor,
  displayNode,
} from "../src/domain/color-profile";
import { transact, type Operation } from "../src/domain/commands";
import {
  createNode,
  parseDocument,
  type DesignDocument,
  type Guide,
} from "../src/domain/document";
import { createLibraryFromSelection } from "../src/domain/library";
import { selectedRevision } from "../src/domain/library-review";
import { openPage } from "../src/domain/pages";
import { createStarter } from "../src/domain/seed";
import { CanvasNode } from "../src/editor/CanvasNode";
import { DesignNodeView } from "../src/runtime/FormaRuntime";

const apply = (doc: DesignDocument, ...operations: Operation[]) =>
  transact(doc, { baseRevision: doc.revision, operations });

test("P3 display and profile conversion preserve embedded alpha", () => {
  const doc = createStarter();
  const root = doc.nodes[0];
  root.style.fill = "#336699aB";
  root.text = "#336699aB";
  root.style.paints = [
    { id: "tint", visible: true, color: "#ff000000", opacity: 1 },
  ];
  const displayed = displayNode(root, "display-p3");
  assert.equal(
    displayed.style.fill,
    `color(display-p3 0.2 0.4 0.6 / ${171 / 255})`,
  );
  assert.equal(
    displayed.style.paints?.[0].color,
    "color(display-p3 1 0 0 / 0)",
  );
  assert.equal(
    displayColor("#ff0000ff", "display-p3"),
    "color(display-p3 1 0 0 / 1)",
  );
  assert.equal(
    displayColor("#336699", "display-p3"),
    "color(display-p3 0.2 0.4 0.6)",
  );
  assert.equal(displayColor(root.style.fill), "#336699aB");
  const converted = changeProfile(doc, "display-p3", "convert");
  assert.equal(converted.nodes[0].style.fill, "#406595aB");
  assert.equal(converted.nodes[0].text, root.text);
  assert.equal(
    changeProfile(converted, "srgb", "convert").nodes[0].style.fill,
    root.style.fill,
  );
  assert.equal(convertColor("#336699", "srgb", "display-p3"), "#406595");
});

test("compiled fills, gradient stops and overlays multiply embedded alpha by paint opacity", () => {
  const doc = createStarter();
  const node = doc.nodes[0];
  node.style.fill = "#ff000066";
  node.style.fillOpacity = 0.5;
  node.style.paints = [
    { id: "overlay", color: "#00ff0066", visible: true, opacity: 0.25 },
  ];
  assert.equal(
    nodeCss(node, doc).background,
    "linear-gradient(rgba(0, 255, 0, 0.1), rgba(0, 255, 0, 0.1)), rgba(255, 0, 0, 0.2)",
  );
  doc.colorProfile = "display-p3";
  node.style.gradient = {
    type: "linear",
    angle: 45,
    stops: [
      { offset: 0, color: "#ff000066", opacity: 0.5 },
      { offset: 1, color: "#0000ff00", opacity: 1 },
    ],
  };
  assert.equal(
    nodeCss(node, doc).background,
    "linear-gradient(color(display-p3 0 1 0 / 0.1), color(display-p3 0 1 0 / 0.1)), linear-gradient(45deg, color(display-p3 1 0 0 / 0.1) 0%, color(display-p3 0 0 1 / 0) 100%)",
  );
});

test("a shared revision can be applied on its own or before deferred components", () => {
  const source = createStarter();
  const root = createNode("rectangle");
  root.styleBindings = { paint: "paint-accent" };
  source.nodes = [root];
  source.designSystem = nativeDesignSystem();
  const library = createLibraryFromSelection(source, root.id, "Shared");
  const doc = apply(createStarter(), { type: "putLibrary", library });
  const old = doc.libraries![library.id];
  const incoming = structuredClone(old);
  incoming.revision++;
  assert.throws(() => selectedRevision(old, incoming, []), /至少一项/);
  const update = (doc: DesignDocument, componentIds: string[]) =>
    apply(doc, {
      type: "updateLibrary",
      expectedRevision: old.revision,
      componentIds,
      library: incoming,
    });
  const system = incoming.designSystem!;
  system.variables["palette-light-accent"].values.base = "#163852";
  system.styles["paint-accent"].name = "New accent";
  system.collections.semantic.name = "New collection";
  for (const group of ["variables", "styles", "collections"] as const) {
    const single = {
      ...incoming,
      designSystem: { ...old.designSystem!, [group]: system[group] },
    };
    assert.equal(selectedRevision(old, single, []), single);
  }
  const sharedOnly = update(doc, []);
  assert.equal(sharedOnly.libraries![library.id].revision, incoming.revision);
  assert.deepEqual(sharedOnly.designSystem, system);

  incoming.components[0].name = "New component";
  const partial = update(doc, []);
  assert.deepEqual(partial.designSystem, system);
  assert.deepEqual(partial.libraries![library.id].components, old.components);
  assert.equal(partial.libraries![library.id].revision, old.revision);
  assert.throws(() => update(partial, []), /至少一项/);
  assert.equal(
    update(partial, [old.components[0].id]).libraries![library.id].components[0]
      .name,
    "New component",
  );
});

test("static React vectors retain P3 path colors, independent opacity and stroke geometry", () => {
  const node = createNode("vector");
  node.vector = {
    width: 20,
    height: 20,
    stretch: true,
    paths: [
      {
        d: "M0 0L10 10Z",
        fill: true,
        fillColor: "#336699",
        fillRule: "evenodd",
        strokeWidth: 2.5,
        strokeColor: "#ff0000",
        lineCap: "square",
        lineJoin: "bevel",
        fillOpacity: 0,
        strokeOpacity: 0.4,
        opacity: 0.75,
      },
      { d: "M1 1L5 5", fill: false, strokeWidth: 0 },
      { d: "M2 2L6 6", fill: true, strokeWidth: 1 },
    ],
  };
  const source = exportReact({
    ...createStarter(),
    nodes: [node],
    colorProfile: "display-p3",
  });
  const paths = source.match(/<path [^>]+\/>/g) ?? [];
  assert.equal(paths.length, 3);
  for (const attribute of [
    'fill={"color(display-p3 0.2 0.4 0.6)"}',
    'stroke={"color(display-p3 1 0 0)"}',
    'fillRule={"evenodd"}',
    "strokeWidth={2.5}",
    'strokeLinecap={"square"}',
    'strokeLinejoin={"bevel"}',
    "fillOpacity={0}",
    "strokeOpacity={0.4}",
    "opacity={0.75}",
  ])
    assert.ok(paths[0].includes(attribute), attribute);
  for (const attribute of [
    'fill={"none"}',
    'stroke={"none"}',
    'strokeLinecap={"round"}',
    'strokeLinejoin={"round"}',
  ])
    assert.ok(paths[1].includes(attribute), attribute);
  assert.match(paths[2], /fill=\{"currentColor"\} stroke=\{"currentColor"\}/);
});

test("canvas and runtime layer visible paints between the cropped image and content", () => {
  const assetId = "img-" + "a".repeat(64);
  const frame = createNode("frame");
  frame.text = "Caption";
  frame.image = { assetId, fit: "contain", x: 30, y: 40, zoom: 2 };
  frame.style.gradient = {
    type: "linear",
    angle: 10,
    stops: [
      { offset: 0, color: "#112233", opacity: 1 },
      { offset: 1, color: "#445566", opacity: 0.8 },
    ],
  };
  const child = createNode("text", frame.id);
  const doc = {
    ...createStarter(),
    nodes: [frame, child],
    images: {
      [assetId]: {
        name: "Photo",
        data: "data:image/png;base64,AA==",
        width: 1,
        height: 1,
      },
    },
  };
  const markup = () => [
    renderToStaticMarkup(
      createElement(CanvasNode, {
        node: frame,
        document: doc,
        selection: [],
        editing: null,
      }),
    ),
    renderToStaticMarkup(
      createElement(DesignNodeView, { node: runtimeNodes(doc)[0] }),
    ),
  ];
  const plain = markup();
  for (const html of plain) {
    assert.doesNotMatch(html, /isolation:isolate|z-index:-1/);
    assert.equal(html.match(/linear-gradient/g)?.length, 1);
  }
  const paint = { id: "tint", color: "#ff0000", opacity: 0.5, visible: false };
  frame.style.paints = [paint];
  assert.deepEqual(markup(), plain);
  frame.style.paints = [
    { ...paint, visible: true },
    {
      ...paint,
      id: "scrim",
      visible: true,
      gradient: { ...frame.style.gradient, angle: 90 },
    },
  ];
  for (const html of markup()) {
    assert.match(
      html,
      /background:linear-gradient\(10deg[^"]*isolation:isolate/,
    );
    assert.match(html, /pointer-events:none;z-index:-1[^>]*><img/);
    assert.match(html, /object-fit:contain[^"]*scale\(2\)/);
    const layers = [
      "<img",
      "linear-gradient(rgba(255, 0, 0, 0.5)",
      "linear-gradient(90deg",
      "Caption",
      child.id,
    ];
    let previous = -1;
    for (const layer of layers) {
      const position = html.indexOf(layer);
      assert.ok(position > previous, layer);
      previous = position;
    }
    assert.equal(html.match(/linear-gradient/g)?.length, 3);
  }
});

test("setGuides shares scene data, isolates pages and supports undo and redo", () => {
  const doc = createStarter();
  const otherGuide: Guide = { id: "other-guide", axis: "y", value: 4 };
  doc.activePage = "design";
  doc.pages = [
    { id: "design", name: "Design" },
    { id: "other", name: "Other", nodes: [], guides: [otherGuide] },
  ];
  const guide: Guide = { id: "origin", axis: "x", value: -12.5 };
  const created = apply(doc, { type: "setGuides", guides: [guide] });
  assert.equal(created.nodes, doc.nodes);
  assert.equal(created.pages, doc.pages);
  assert.equal(created.tokens, doc.tokens);
  assert.equal(created.revision, doc.revision + 1);
  assert.equal(doc.guides, undefined);
  assert.deepEqual(parseDocument(created).guides, [guide]);
  const other = openPage(created, "other");
  assert.deepEqual(other.guides, [otherGuide]);
  assert.deepEqual(openPage(other, "design").guides, [guide]);
  const moved = apply(created, {
    type: "setGuides",
    guides: [{ ...guide, value: 55 }],
  });
  const removed = apply(moved, { type: "setGuides", guides: [] });
  const undo = travel(
    commit({ present: moved, past: [], future: [] }, removed),
    "undo",
  );
  assert.deepEqual(undo.present.guides, [{ ...guide, value: 55 }]);
  assert.equal(undo.present.revision, removed.revision + 1);
  assert.deepEqual(travel(undo, "redo").present.guides, []);
  assert.throws(
    () => apply(created, { type: "setGuides", guides: [guide, guide] }),
    /辅助线 ID 重复/,
  );
  assert.throws(
    () =>
      transact(created, {
        baseRevision: doc.revision,
        operations: [{ type: "setGuides", guides: [] }],
      }),
    /文件已变化/,
  );
  const mixed = apply(
    created,
    { type: "setGuides", guides: [] },
    { type: "update", id: created.nodes[0].id, patch: { name: "Renamed" } },
  );
  assert.equal(mixed.nodes[0].name, "Renamed");
  assert.deepEqual(mixed.guides, []);
  assert.equal(mixed.revision, created.revision + 1);
});
