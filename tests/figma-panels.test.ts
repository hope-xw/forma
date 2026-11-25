import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { strFromU8, unzipSync } from "fflate";
import { inspectNodeForDev } from "../src/compiler/dev-inspect";
import { reactFileProject } from "../src/compiler/file-project";
import { gradientCss } from "../src/compiler/paints";
import { exportReact, nodeCss } from "../src/compiler/react";
import {
  pageForExport,
  prototypeProgram,
  runtimeNodes,
} from "../src/compiler/runtime";
import { transact, type Operation } from "../src/domain/commands";
import {
  checkDesigns,
  contrastRatio,
  wcagGrade,
} from "../src/domain/design-lint";
import {
  createNode,
  parseDocument,
  type DesignDocument,
  type DesignNode,
  type NodeStyle,
} from "../src/domain/document";
import { imagePaint, svgImagePaint } from "../src/domain/images";
import { addPage, duplicatePage, openPage } from "../src/domain/pages";
import { linkedPrototypeScene, prototypeIssues } from "../src/domain/prototype";
import { planScaleSelection } from "../src/domain/scale-tool";
import { findMatchingLayers, wrapInSection } from "../src/domain/section";
import { isContainer } from "../src/domain/tree";
import {
  collectExportTargets,
  exportBatchZip,
} from "../src/infrastructure/batch-export";
import { exportNodeToSvg } from "../src/infrastructure/static-export";
import {
  DesignNodeView,
  InteractionContext,
  separateImageOverlay,
} from "../src/runtime/FormaRuntime";
import { computeSmartAnimateMatches } from "../src/runtime/PrototypePlayer";
import { startFlow, trigger } from "../src/runtime/prototype-machine";

const SAMPLE_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const SAMPLE_IMG_ID = "img-" + "a".repeat(64);

const makeDoc = (...nodes: DesignNode[]): DesignDocument => ({
  schemaVersion: 1,
  id: "figma-panels-doc",
  name: "Figma Panels Test",
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
  extra: Partial<DesignNode> = {},
): DesignNode {
  const n = createNode(type, parentId);
  n.id = id;
  Object.assign(n.style, style);
  Object.assign(n, extra);
  return n;
}

test("section and slice node defaults, F06 hierarchy validation, wrapInSection, and findMatchingLayers", () => {
  const sec = createNode("section");
  assert.equal(sec.name, "分区");
  assert.equal(sec.style.width, 640);
  assert.equal(sec.style.height, 480);
  assert.equal(sec.style.radius, 8);
  assert.equal(sec.style.stroke, "#525866");
  assert.equal(sec.style.strokeWidth, 1);
  assert.equal(isContainer(sec), true);

  const slc = createNode("slice");
  assert.equal(slc.name, "切片");
  assert.equal(slc.style.width, 200);
  assert.equal(slc.style.height, 160);
  assert.equal(slc.style.fillOpacity, 0);
  assert.equal(isContainer(slc), false);

  // Valid: root section -> nested section -> frame -> slice & rect
  const validDoc = parseDocument(
    makeDoc(
      layer("section", "sec-root", null, {
        x: 0,
        y: 0,
        width: 1200,
        height: 900,
      }),
      layer("section", "sec-nested", "sec-root", {
        x: 40,
        y: 40,
        width: 800,
        height: 600,
      }),
      layer("frame", "art-1", "sec-nested", {
        x: 20,
        y: 20,
        width: 390,
        height: 844,
      }),
      layer("slice", "slice-1", "art-1", {
        x: 10,
        y: 10,
        width: 100,
        height: 100,
      }),
    ),
  );
  assert.equal(validDoc.nodes.length, 4);

  // Invalid F06: section inside a frame must fail validation
  assert.throws(
    () =>
      parseDocument(
        makeDoc(
          layer("frame", "frame-1", null),
          layer("section", "sec-bad", "frame-1"),
        ),
      ),
    /分区只能位于画布顶层或其他分区内/,
  );

  // Invalid F06: section inside a group must fail validation
  assert.throws(
    () =>
      parseDocument(
        makeDoc(
          layer("group", "grp-1", null),
          layer("section", "sec-bad-group", "grp-1"),
        ),
      ),
    /分区只能位于画布顶层或其他分区内/,
  );

  // wrapInSection preserves world positions and rejects wrapping inside a frame
  const base = makeDoc(
    layer("frame", "f1", null, { x: 100, y: 200, width: 300, height: 400 }),
    layer("frame", "f2", null, { x: 500, y: 200, width: 300, height: 400 }),
    layer("text", "t1", "f1", { x: 16, y: 16 }, { name: "Title" }),
    layer("text", "t2", "f2", { x: 16, y: 16 }, { name: "Title" }),
    layer("rectangle", "r2", "f2", { x: 16, y: 60 }, { name: "Title" }),
    layer("text", "stray", null, { x: 0, y: 0 }, { name: "Title" }),
  );
  const wrapped = wrapInSection(base, ["f1", "f2"], 40);
  const afterWrap = apply(base, ...wrapped.operations);
  const sectionNode = afterWrap.nodes.find((n) => n.id === wrapped.id)!;
  assert.equal(sectionNode.type, "section");
  assert.equal(sectionNode.style.x, 60);
  assert.equal(sectionNode.style.y, 160);
  assert.equal(sectionNode.style.width, 780);
  assert.equal(sectionNode.style.height, 480);
  const f1Moved = afterWrap.nodes.find((n) => n.id === "f1")!;
  assert.equal(f1Moved.parentId, sectionNode.id);
  assert.equal(sectionNode.style.x + f1Moved.style.x, 100);
  assert.equal(sectionNode.style.y + f1Moved.style.y, 200);

  assert.throws(
    () => wrapInSection(afterWrap, ["t1"]),
    /分区只能位于画布顶层或其他分区内/,
  );

  // findMatchingLayers matches same name + type across sibling artboards, ignores different type & stray root
  const matched = findMatchingLayers(afterWrap, ["t1"]);
  assert.deepEqual(matched, ["t1", "t2"]);
});

test("new optional schema fields, Zod bounds, and backward compatibility with legacy v1 documents", () => {
  const legacy = {
    schemaVersion: 1,
    id: "legacy-doc",
    name: "Legacy",
    revision: 3,
    tokens: { brand: { name: "Brand", value: "#635bff" } },
    nodes: [layer("frame", "f1", null)],
  };
  const parsedLegacy = parseDocument(legacy);
  assert.equal(parsedLegacy.comments, undefined);
  assert.equal(parsedLegacy.nodes[0].devStatus, undefined);

  const enriched = apply(parsedLegacy, {
    type: "update",
    id: "f1",
    patch: {
      devStatus: "ready",
      exportSettings: [
        { id: "e1", format: "png", scale: 2, suffix: "@2x" },
        { id: "e2", format: "svg", scale: 1, suffix: "" },
      ],
      annotations: [
        {
          id: "a1",
          category: "a11y",
          text: "保持对比度不低于 4.5:1",
          properties: ["color", "fill"],
        },
      ],
    },
    style: {
      cornerSmoothing: 0.6,
      layoutGuides: [
        {
          id: "g1",
          kind: "columns",
          visible: true,
          color: "#F24822",
          opacity: 0.12,
          size: 8,
          count: 12,
          gutter: 16,
          offset: 24,
          alignment: "stretch",
        },
      ],
    },
  });

  const roundTrip = parseDocument(JSON.parse(JSON.stringify(enriched)));
  assert.equal(roundTrip.nodes[0].devStatus, "ready");
  assert.equal(roundTrip.nodes[0].exportSettings?.length, 2);
  assert.equal(roundTrip.nodes[0].annotations?.[0].category, "a11y");
  assert.equal(roundTrip.nodes[0].style.cornerSmoothing, 0.6);
  assert.equal(roundTrip.nodes[0].style.layoutGuides?.[0].count, 12);

  // Invalid Zod inputs rejected
  assert.throws(() =>
    apply(roundTrip, {
      type: "update",
      id: "f1",
      patch: {},
      style: { cornerSmoothing: 1.5 },
    }),
  );
  assert.throws(() =>
    apply(roundTrip, {
      type: "update",
      id: "f1",
      patch: {
        exportSettings: [{ id: "bad", format: "png", scale: 8, suffix: "" }],
      },
    }),
  );
});

test("comments persist per page, use setComments fast path, and remap nodeId on duplicatePage", () => {
  const base = makeDoc(layer("frame", "home", null, { x: 0, y: 0 }));
  const commented = apply(base, {
    type: "setComments",
    comments: [
      {
        id: "c1",
        x: 120,
        y: 80,
        nodeId: "home",
        author: "设计师",
        text: "主标题再加大一点",
        createdAt: "2026-11-22T00:00:00Z",
        resolved: false,
        replies: [
          {
            id: "r1",
            author: "开发",
            text: "收到，已确认",
            createdAt: "2026-11-22T01:00:00Z",
          },
        ],
      },
    ],
  });
  assert.equal(commented.nodes, base.nodes);
  assert.equal(commented.revision, 1);
  assert.equal(commented.comments?.length, 1);

  // Page switching isolates comments
  const withPage2 = addPage(commented, "页面 2");
  assert.equal(withPage2.comments, undefined);
  const backToPage1 = openPage(withPage2, "first");
  assert.equal(backToPage1.comments?.[0].id, "c1");

  // Duplicating page generates new comment/reply IDs and remaps nodeId
  const dup = parseDocument(duplicatePage(backToPage1));
  assert.equal(dup.comments?.length, 1);
  assert.notEqual(dup.comments![0].id, "c1");
  assert.notEqual(dup.comments![0].replies[0].id, "r1");
  assert.equal(dup.comments![0].nodeId, dup.nodes[0].id);
  assert.notEqual(dup.comments![0].nodeId, "home");

  // Duplicate comment IDs rejected
  assert.throws(() =>
    apply(commented, {
      type: "setComments",
      comments: [
        {
          id: "dup",
          x: 0,
          y: 0,
          author: "A",
          text: "1",
          createdAt: "2026-11-22T00:00:00Z",
          resolved: false,
          replies: [],
        },
        {
          id: "dup",
          x: 10,
          y: 10,
          author: "B",
          text: "2",
          createdAt: "2026-11-22T00:00:00Z",
          resolved: false,
          replies: [],
        },
      ],
    }),
  );
});

test("image rotation and advanced color adjustments compile to CSS, SVG, and FormaRuntime", () => {
  const asset = {
    name: "photo.png",
    width: 100,
    height: 100,
    data: SAMPLE_PNG,
  };
  const legacyFill = {
    assetId: SAMPLE_IMG_ID,
    fit: "cover" as const,
    x: 50,
    y: 50,
    zoom: 1,
    brightness: 1.2,
  };
  const legacyPainted = imagePaint(legacyFill, asset);
  assert.equal(legacyPainted.filter, "brightness(1.2)");
  assert.equal(legacyPainted.transform, undefined);

  const advancedFill = {
    assetId: SAMPLE_IMG_ID,
    fit: "cover" as const,
    x: 50,
    y: 50,
    zoom: 1.5,
    rotation: 30,
    exposure: 0.5,
    temperature: 0.4,
    tint: -0.2,
    highlights: 0.3,
    shadows: -0.2,
  };
  const painted = imagePaint(advancedFill, asset);
  assert.equal(painted.rotation, 30);
  assert.equal(painted.transform, "rotate(30deg)");
  assert.match(painted.filter ?? "", /brightness\(/);
  assert.match(painted.filter ?? "", /contrast\(/);
  assert.match(painted.filter ?? "", /sepia\(/);
  assert.match(painted.filter ?? "", /hue-rotate\(/);

  const svg = svgImagePaint(advancedFill, asset, 200, 100, "p1");
  assert.match(svg, /transform="rotate\(30 100 50\)"/);
  assert.match(svg, /<feComponentTransfer>/);
  assert.match(svg, /<feColorMatrix type="matrix"/);

  const doc: DesignDocument = {
    ...makeDoc(
      layer(
        "rectangle",
        "img-box",
        null,
        { width: 120, height: 80 },
        { image: advancedFill },
      ),
    ),
    images: { [SAMPLE_IMG_ID]: asset },
  };
  const parsed = parseDocument(doc);
  const [rtNode] = runtimeNodes(parsed);
  const html = renderToStaticMarkup(
    createElement(DesignNodeView, { node: rtNode }),
  );
  assert.match(html, /rotate\(30deg\) scale\(1\.5\)/);
  assert.match(html, /sepia\(/);
});

test("angular and diamond gradients compile to CSS, FormaRuntime overlay separation, and SVG export", () => {
  const stops = [
    { offset: 0, color: "#ff0000", opacity: 1 },
    { offset: 1, color: "#0000ff", opacity: 1 },
  ];
  const angularCss = gradientCss({ type: "angular", angle: 45, stops }, 1);
  assert.match(angularCss, /^conic-gradient\(from 45deg at 50% 50%,/);

  const diamondCss = gradientCss({ type: "diamond", angle: 0, stops }, 1);
  assert.match(diamondCss, /linear-gradient\(to bottom right,/);
  assert.match(diamondCss, /bottom right \/ 50% 50% no-repeat/);
  assert.match(diamondCss, /top right \/ 50% 50% no-repeat/);

  // separateImageOverlay keeps all 4 diamond quadrants together as the base fill
  const styleObj: { background?: string; isolation?: "isolate" | "auto" } = {
    background: `linear-gradient(rgba(0, 0, 0, 0.2), rgba(0, 0, 0, 0.2)), ${diamondCss}`,
  };
  const overlay = separateImageOverlay(styleObj);
  assert.equal(
    overlay,
    "linear-gradient(rgba(0, 0, 0, 0.2), rgba(0, 0, 0, 0.2))",
  );
  assert.equal(styleObj.background, diamondCss);

  // SVG static export handles both angular and diamond gradients
  const doc = parseDocument(
    makeDoc(
      layer("rectangle", "ang", null, {
        width: 100,
        height: 100,
        gradient: { type: "angular", angle: 90, stops },
      }),
      layer("rectangle", "dia", null, {
        x: 120,
        width: 100,
        height: 100,
        gradient: { type: "diamond", angle: 0, stops },
      }),
    ),
  );
  const angSvg = exportNodeToSvg(doc, "ang");
  assert.match(angSvg, /<pattern[^>]+patternUnits="userSpaceOnUse"/);
  assert.match(angSvg, /<path d="M50 50L/);

  const diaSvg = exportNodeToSvg(doc, "dia");
  assert.match(diaSvg, /<pattern[^>]+patternUnits="objectBoundingBox"/);
  assert.equal((diaSvg.match(/<linearGradient/g) ?? []).length, 4);
});

test("proportional scale engine scales geometry, typography, corners, strokes, layout, effects, and respects locks/instances", () => {
  const card = layer("frame", "card", null, {
    x: 100,
    y: 100,
    width: 200,
    height: 100,
    layout: "column",
    padding: 16,
    insets: { top: 10, right: 20, bottom: 10, left: 20 },
    gap: 12,
    rowGap: 8,
    radius: 8,
    corners: { tl: 4, tr: 8, br: 12, bl: 16 },
    strokeWidth: 2,
    strokeSides: { top: 1, right: 2, bottom: 3, left: 4 },
    blur: 4,
    backdropBlur: 6,
    shadows: [
      {
        x: 2,
        y: 4,
        blur: 8,
        spread: 1,
        color: "#000000",
        opacity: 0.2,
        inset: false,
      },
    ],
  });
  const title = layer(
    "text",
    "title",
    "card",
    {
      x: 10,
      y: 20,
      width: 160,
      height: 30,
      fontSize: 16,
      lineHeight: 24,
      letterSpacing: 1,
    },
    { text: "Hello" },
  );
  const lockedChild = layer(
    "rectangle",
    "locked",
    "card",
    { x: 10, y: 60, width: 40, height: 20 },
    { locked: true },
  );

  const doc = parseDocument(makeDoc(card, title, lockedChild));

  // Scale 2x around center anchor ("mc")
  const ops = planScaleSelection(doc, ["card"], 2, "mc");
  const scaled = apply(doc, ...ops);

  const nextCard = scaled.nodes.find((n) => n.id === "card")!;
  // Center of (100, 100, 200x100) is (200, 150). At 2x -> 400x200 centered at (200, 150) => (0, 50)
  assert.equal(nextCard.style.x, 0);
  assert.equal(nextCard.style.y, 50);
  assert.equal(nextCard.style.width, 400);
  assert.equal(nextCard.style.height, 200);
  assert.equal(nextCard.style.padding, 32);
  assert.deepEqual(nextCard.style.insets, {
    top: 20,
    right: 40,
    bottom: 20,
    left: 40,
  });
  assert.equal(nextCard.style.gap, 24);
  assert.equal(nextCard.style.rowGap, 16);
  assert.equal(nextCard.style.radius, 16);
  assert.deepEqual(nextCard.style.corners, { tl: 8, tr: 16, br: 24, bl: 32 });
  assert.equal(nextCard.style.strokeWidth, 4);
  assert.deepEqual(nextCard.style.strokeSides, {
    top: 2,
    right: 4,
    bottom: 6,
    left: 8,
  });
  assert.equal(nextCard.style.blur, 8);
  assert.equal(nextCard.style.backdropBlur, 12);
  assert.equal(nextCard.style.shadows?.[0].x, 4);
  assert.equal(nextCard.style.shadows?.[0].y, 8);
  assert.equal(nextCard.style.shadows?.[0].blur, 16);
  assert.equal(nextCard.style.shadows?.[0].spread, 2);

  const nextTitle = scaled.nodes.find((n) => n.id === "title")!;
  assert.equal(nextTitle.style.fontSize, 32);
  assert.equal(nextTitle.style.lineHeight, 48);
  assert.equal(nextTitle.style.letterSpacing, 2);
  assert.equal(nextTitle.style.width, 320);

  // Locked child was untouched
  const nextLocked = scaled.nodes.find((n) => n.id === "locked")!;
  assert.equal(nextLocked.style.width, 40);
  assert.equal(nextLocked.style.height, 20);

  // Protected component instance root scales outer dimensions without touching protected children or layout props
  const libDoc = parseDocument({
    ...makeDoc(
      layer(
        "frame",
        "inst-root",
        null,
        {
          x: 0,
          y: 0,
          width: 100,
          height: 50,
          layout: "row",
          padding: 8,
          gap: 4,
        },
        {
          instance: {
            libraryId: "lib1",
            componentId: "comp1",
            variantId: "var1",
          },
        },
      ),
      layer(
        "text",
        "inst-child",
        "inst-root",
        { width: 60, height: 20, fontSize: 14 },
        { templateKey: "label", text: "OK" },
      ),
    ),
    libraries: {
      lib1: {
        format: "forma/library",
        version: 1,
        id: "lib1",
        name: "UI",
        description: "",
        revision: 1,
        source: { name: "local", license: "MIT" },
        components: [
          {
            id: "comp1",
            name: "Chip",
            category: "UI",
            description: "",
            variants: [
              {
                id: "var1",
                name: "Default",
                properties: { state: "default" },
                nodes: [
                  layer(
                    "frame",
                    "tpl-root",
                    null,
                    {
                      width: 100,
                      height: 50,
                      layout: "row",
                      padding: 8,
                      gap: 4,
                    },
                    { templateKey: "root" },
                  ),
                  layer(
                    "text",
                    "tpl-child",
                    "tpl-root",
                    { width: 60, height: 20, fontSize: 14 },
                    { templateKey: "label", text: "OK" },
                  ),
                ],
              },
            ],
          },
        ],
      },
    },
  });
  const instOps = planScaleSelection(libDoc, ["inst-root"], 1.5, "tl");
  const scaledInst = apply(libDoc, ...instOps);
  assert.equal(
    scaledInst.nodes.find((n) => n.id === "inst-root")!.style.width,
    150,
  );
  assert.equal(
    scaledInst.nodes.find((n) => n.id === "inst-root")!.style.padding,
    8,
  );
  assert.equal(
    scaledInst.nodes.find((n) => n.id === "inst-child")!.style.width,
    60,
  );
});

test("WCAG contrast calculation and checkDesigns lint engine with auto-fix operations", () => {
  assert.equal(contrastRatio("#000000", "#ffffff"), 21);
  assert.deepEqual(wcagGrade(21), {
    ratio: 21,
    aa: true,
    aaa: true,
    label: "AAA",
  });
  assert.deepEqual(wcagGrade(4.6), {
    ratio: 4.6,
    aa: true,
    aaa: false,
    label: "AA",
  });
  assert.deepEqual(wcagGrade(3.5, false), {
    ratio: 3.5,
    aa: false,
    aaa: false,
    label: "未通过",
  });
  assert.deepEqual(wcagGrade(3.5, true), {
    ratio: 3.5,
    aa: true,
    aaa: false,
    label: "AA",
  });

  const doc = parseDocument({
    ...makeDoc(
      layer(
        "frame",
        "screen",
        null,
        { fill: "#ffffff", width: 390, height: 844 },
        { name: "首页" },
      ),
      // Hardcoded color close to #635bff (RGB distance ~3 <= 12)
      layer(
        "rectangle",
        "rect-a",
        "screen",
        { fill: "#655cfe", width: 100, height: 40 },
        { name: "矩形" },
      ),
      layer(
        "rectangle",
        "rect-b",
        "screen",
        { fill: "#111111", width: 100, height: 40 },
        { name: "矩形" },
      ),
      // Unbound typography matching Body style + low contrast (#cccccc on #ffffff)
      layer(
        "text",
        "low-txt",
        "screen",
        { color: "#cccccc", fontSize: 16, fontWeight: 400 },
        { name: "弱提示", text: "难以阅读的浅灰文字" },
      ),
    ),
    designSystem: {
      collections: {
        c1: {
          id: "c1",
          name: "Brand",
          defaultModeId: "light",
          modes: [{ id: "light", name: "Light" }],
        },
      },
      activeModes: { c1: "light" },
      variables: {
        "var-brand": {
          id: "var-brand",
          collectionId: "c1",
          name: "color/brand-primary",
          type: "color",
          description: "",
          codeSyntax: "--brand-primary",
          platformCodeSyntax: {
            web: "var(--brand-primary)",
            react: "theme.colors.brand",
            ios: 'Color("BrandPrimary")',
            android: "BrandTheme.colors.primary",
          },
          scopes: [],
          values: { light: "#635bff" },
        },
      },
      styles: {
        "style-body": {
          id: "style-body",
          name: "Body Regular",
          kind: "text",
          description: "",
          properties: { fontSize: 16, fontWeight: 400 },
          bindings: {},
        },
      },
    },
  });

  const issues = checkDesigns(doc);
  const unboundColor = issues.find(
    (i) => i.kind === "unbound-color" && i.nodeId === "rect-a",
  );
  assert.ok(
    unboundColor,
    "expected unbound-color issue for near-matching fill",
  );
  assert.ok(unboundColor.fixOperations?.length);

  const unboundTypo = issues.find(
    (i) => i.kind === "unbound-typography" && i.nodeId === "low-txt",
  );
  assert.ok(
    unboundTypo,
    "expected unbound-typography issue for matching text style",
  );
  assert.ok(unboundTypo.fixOperations?.length);

  const lowContrast = issues.find(
    (i) => i.kind === "low-contrast" && i.nodeId === "low-txt",
  );
  assert.ok(lowContrast, "expected low-contrast issue for #cccccc on #ffffff");
  assert.ok((lowContrast.contrast?.ratio ?? 99) < 4.5);

  const genericIssues = issues.filter((i) => i.kind === "generic-name");
  assert.equal(genericIssues.length, 2);

  // Apply fixOperations and verify unbound issues disappear!
  const fixed = apply(
    doc,
    ...unboundColor.fixOperations!,
    ...unboundTypo.fixOperations!,
  );
  const afterIssues = checkDesigns(fixed);
  assert.equal(
    afterIssues.some(
      (i) => i.kind === "unbound-color" && i.nodeId === "rect-a",
    ),
    false,
  );
  assert.equal(
    afterIssues.some(
      (i) => i.kind === "unbound-typography" && i.nodeId === "low-txt",
    ),
    false,
  );
});

test("Dev Mode inspector generates box-model, platformCodeSyntax tokens, and px/rem CSS, Tailwind, React snippets", () => {
  const doc = parseDocument({
    ...makeDoc(
      layer(
        "frame",
        "cta",
        null,
        {
          width: 160,
          height: 48,
          layout: "row",
          padding: 16,
          gap: 8,
          radius: 8,
          fill: "#635bff",
          stroke: "#4338ca",
          strokeWidth: 2,
        },
        {
          name: "Primary CTA",
          devStatus: "ready",
          variableBindings: { fill: "v-primary" },
          annotations: [
            { id: "an1", category: "dev", text: "点击触发支付弹窗" },
          ],
        },
      ),
    ),
    designSystem: {
      collections: {
        c1: {
          id: "c1",
          name: "Colors",
          defaultModeId: "m1",
          modes: [{ id: "m1", name: "Default" }],
        },
      },
      activeModes: { c1: "m1" },
      variables: {
        "v-primary": {
          id: "v-primary",
          collectionId: "c1",
          name: "brand/primary",
          type: "color",
          description: "",
          codeSyntax: "--brand-primary",
          platformCodeSyntax: {
            web: "var(--brand-primary)",
            react: "tokens.brandPrimary",
            ios: 'Color("BrandPrimary")',
            android: "Tokens.brandPrimary",
          },
          scopes: [],
          values: { m1: "#635bff" },
        },
      },
      styles: {},
    },
  });

  const pxOut = inspectNodeForDev(doc, "cta", "px");
  assert.equal(pxOut.devStatus, "ready");
  assert.equal(pxOut.annotations.length, 1);
  assert.equal(pxOut.boxModel.width, 160);
  assert.equal(pxOut.boxModel.height, 48);
  assert.deepEqual(pxOut.boxModel.padding, {
    top: 16,
    right: 16,
    bottom: 16,
    left: 16,
  });
  assert.deepEqual(pxOut.boxModel.border, {
    top: 2,
    right: 2,
    bottom: 2,
    left: 2,
  });
  assert.equal(pxOut.boxModel.gap, 8);
  assert.equal(pxOut.tokens[0].codeSyntax.web, "var(--brand-primary)");
  assert.equal(pxOut.tokens[0].codeSyntax.react, "tokens.brandPrimary");
  assert.equal(pxOut.tokens[0].codeSyntax.ios, 'Color("BrandPrimary")');
  assert.equal(pxOut.tokens[0].codeSyntax.android, "Tokens.brandPrimary");
  assert.match(pxOut.snippets.css, /width: 160px;/);
  assert.match(pxOut.snippets.css, /background-color: var\(--brand-primary\);/);
  assert.match(pxOut.snippets.tailwind, /w-\[160px\]/);
  assert.match(pxOut.snippets.react, /width: "160px"/);

  const remOut = inspectNodeForDev(doc, "cta", "rem");
  assert.match(remOut.snippets.css, /width: 10rem;/);
  assert.match(remOut.snippets.css, /height: 3rem;/);
  assert.match(remOut.snippets.css, /padding: 1rem;/);
  assert.match(remOut.snippets.tailwind, /w-\[10rem\]/);
  assert.match(remOut.snippets.react, /padding: "1rem"/);
});

test("sections unwrap transparently, slices are excluded from React/Runtime, multi-trigger & smart-animate work end-to-end", () => {
  const doc = parseDocument({
    ...makeDoc(
      layer(
        "section",
        "sec1",
        null,
        { x: 100, y: 50, width: 900, height: 900 },
        { name: "登录流程" },
      ),
      layer(
        "frame",
        "screen-a",
        "sec1",
        { x: 20, y: 30, width: 390, height: 844, fill: "#ffffff" },
        { name: "登录页", interaction: { flow: "主流程" } },
      ),
      layer(
        "button",
        "btn-go",
        "screen-a",
        { x: 24, y: 100, width: 120, height: 44 },
        {
          name: "HeroCard",
          text: "下一步",
          interaction: {
            trigger: "hover",
            actions: [{ kind: "toggle", variable: "v-hovered" }],
          },
          interactions: [
            {
              trigger: "click",
              actions: [
                {
                  kind: "navigate",
                  target: "screen-b",
                  transition: {
                    type: "smart-animate",
                    duration: 300,
                    easing: "ease-out",
                  },
                },
              ],
            },
          ],
        },
      ),
      layer(
        "slice",
        "slice-a",
        "screen-a",
        { x: 0, y: 0, width: 150, height: 150 },
        { name: "crops/btn" },
      ),
      layer(
        "frame",
        "screen-b",
        "sec1",
        { x: 460, y: 30, width: 390, height: 844, fill: "#ffffff" },
        { name: "成功页" },
      ),
      layer(
        "rectangle",
        "card-b",
        "screen-b",
        { x: 24, y: 260, width: 240, height: 88, opacity: 0.8 },
        { name: "HeroCard" },
      ),
    ),
    designSystem: {
      collections: {
        c1: {
          id: "c1",
          name: "State",
          defaultModeId: "m1",
          modes: [{ id: "m1", name: "Base" }],
        },
      },
      activeModes: { c1: "m1" },
      variables: {
        "v-hovered": {
          id: "v-hovered",
          collectionId: "c1",
          name: "hovered",
          type: "boolean",
          description: "",
          codeSyntax: "",
          scopes: [],
          values: { m1: false },
        },
      },
      styles: {},
    },
  });

  // Frames inside sections are valid prototype flows & targets with zero issues
  assert.deepEqual(prototypeIssues(doc), []);
  assert.equal(linkedPrototypeScene(doc).nodes.length, doc.nodes.length);

  // React export excludes slice and section chrome while preserving section child at world coords
  const reactSource = exportReact(doc);
  assert.equal(reactSource.includes("sec1"), false);
  assert.equal(reactSource.includes("slice-a"), false);
  assert.equal(reactSource.includes("screen-a"), true);

  // Runtime nodes unwrap sections and strip slices, shifting screen-a to world (120, 80)
  const rt = runtimeNodes(doc);
  assert.deepEqual(
    rt.map((n) => n.id),
    ["screen-a", "screen-b"],
  );
  assert.equal(rt[0].style.left, 120);
  assert.equal(rt[0].style.top, 80);
  assert.equal(
    rt[0].children.some((c) => c.id === "slice-a"),
    false,
  );

  // pageForExport & reactFileProject also exclude slices and section chrome
  const exportedPage = pageForExport(doc, ["screen-a"]);
  assert.equal(
    exportedPage.nodes.some((n) => n.type === "section" || n.type === "slice"),
    false,
  );
  const projectFiles = reactFileProject(
    doc,
    ["screen-a"],
    "// runtime",
    {
      "src/PrototypePlayer.tsx": "// player",
      "src/prototype-machine.ts": "// machine",
    },
    "// router",
  );
  assert.match(projectFiles["src/pages.ts"], /screen-a/);
  assert.doesNotMatch(projectFiles["src/pages.ts"], /sec1/);
  assert.doesNotMatch(projectFiles["src/pages.ts"], /slice-a/);

  // Multi-trigger interactions compile into multiRules and execute both hover & click independently
  const program = prototypeProgram(doc)!;
  assert.equal(program.flows[0].id, "screen-a");
  assert.equal(program.multiRules?.["btn-go"]?.length, 2);

  let session = startFlow(program, "screen-a");
  session = trigger(program, session, "btn-go", true, "hover");
  assert.equal(session.variables["v-hovered"], true);
  assert.equal(session.screen, "screen-a");

  session = trigger(program, session, "btn-go", true, "click");
  assert.equal(session.screen, "screen-b");

  // SSR DesignNodeView renders BOTH hover and click attributes on the multi-trigger node
  const ssrHtml = renderToStaticMarkup(
    createElement(
      InteractionContext.Provider,
      {
        value: {
          wired: new Set(["btn-go"]),
          rules: program.rules,
          multiRules: program.multiRules,
          controls: {},
          changes: {},
        },
      },
      createElement(DesignNodeView, { node: rt[0] }),
    ),
  );
  assert.match(ssrHtml, /data-forma-hover=""/);
  assert.match(ssrHtml, /role="button"/);

  // Smart Animate matches layers by name across screens and computes exact FLIP deltas
  const matches = computeSmartAnimateMatches(rt[0], rt[1]);
  const heroMatch = matches.get("card-b");
  assert.ok(heroMatch, "expected HeroCard to match across screens");
  assert.equal(heroMatch.fromId, "btn-go");
  assert.equal(heroMatch.toId, "card-b");
  assert.equal(heroMatch.dx, 0);
  assert.equal(heroMatch.dy, 100 - 260);
  assert.equal(heroMatch.scaleX, 120 / 240);
  assert.equal(heroMatch.scaleY, 44 / 88);
  assert.equal(heroMatch.fromOpacity, 1);
  assert.equal(heroMatch.toOpacity, 0.8);

  // nodeCss handles scroll defined inside multi-trigger interactions[]
  const scrollFrame = layer(
    "frame",
    "scroller",
    null,
    {},
    { interactions: [{ scroll: "vertical" }] },
  );
  const css = nodeCss(scrollFrame, makeDoc(scrollFrame));
  assert.equal(css.overflowX, "hidden");
  assert.equal(css.overflowY, "auto");
});

test("slice static SVG crop export and batch ZIP export preserve subfolders and suffixes", async () => {
  const doc = parseDocument(
    makeDoc(
      layer(
        "frame",
        "board",
        null,
        { x: 0, y: 0, width: 400, height: 300, fill: "#ffffff" },
        { name: "画板" },
      ),
      layer(
        "rectangle",
        "icon-home",
        "board",
        { x: 20, y: 20, width: 48, height: 48, fill: "#635bff" },
        {
          name: "icons/nav/Home",
          exportSettings: [
            { id: "s1", format: "svg", scale: 1, suffix: "" },
            { id: "s2", format: "svg", scale: 2, suffix: "@2x" },
            { id: "s3", format: "png", scale: 2, suffix: "@2x" },
          ],
        },
      ),
      layer(
        "slice",
        "crop-1",
        "board",
        { x: 10, y: 10, width: 80, height: 60 },
        { name: "../banners/hero" },
      ),
    ),
  );

  // Slice SVG export produces a 2x cropped SVG of the scene bounds
  const sliceSvg = exportNodeToSvg(doc, "crop-1", 2);
  assert.match(sliceSvg, /width="160" height="120" viewBox="0 0 80 60"/);
  assert.match(sliceSvg, /#635bff/);

  // collectExportTargets collects configured exportSettings + slice, sanitizing traversal
  const targets = collectExportTargets(doc);
  assert.deepEqual(
    targets.map((t) => t.path),
    [
      "icons/nav/Home.svg",
      "icons/nav/Home@2x.svg",
      "icons/nav/Home@2x.png",
      "banners/hero.svg",
    ],
  );

  // exportBatchZip packs SVG + raster targets into a valid ZIP archive
  const zipBytes = await exportBatchZip(doc, undefined, {
    rasterize: async (_d, _id, opts) =>
      new Uint8Array([0x89, 0x50, 0x4e, 0x47, opts.scale]),
  });
  const unzipped = unzipSync(zipBytes);
  assert.deepEqual(Object.keys(unzipped).sort(), [
    "banners/hero.svg",
    "icons/nav/Home.svg",
    "icons/nav/Home@2x.png",
    "icons/nav/Home@2x.svg",
  ]);
  assert.match(
    strFromU8(unzipped["icons/nav/Home@2x.svg"]),
    /width="96" height="96"/,
  );
  assert.match(strFromU8(unzipped["banners/hero.svg"]), /viewBox="0 0 80 60"/);
  assert.equal(unzipped["icons/nav/Home@2x.png"][4], 2);
});
