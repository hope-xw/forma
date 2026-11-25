import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import * as lucide from "lucide-react";
import svgpath from "svgpath";
import {
  compileBlueprintToTransaction,
  normalizeStylePatch,
  type BlueprintNode,
  type BlueprintCompileContext,
} from "../src/agent/blueprint-compiler";
import {
  ICON_COUNT,
  iconPrimitivesToSvgPaths,
  iconToFormaVector,
  iconToInlineSvg,
  resolveIconName,
  searchIcons,
  type IconPrimitive,
} from "../src/agent/icon-library";
import { validateProposal } from "../src/agent/provider";
import { transact } from "../src/domain/commands";
import { nodeSchema, parseDocument } from "../src/domain/document";
import { createStarter } from "../src/domain/seed";
import { nodeCss } from "../src/compiler/react";
import { separateImageOverlay } from "../src/runtime/FormaRuntime";

function replay(
  blueprint: unknown,
  options: Partial<BlueprintCompileContext> = {},
) {
  const ctx = {
    document: createStarter(),
    selection: null,
    prompt: "Visual primitives",
    ...options,
  };
  const result = compileBlueprintToTransaction(blueprint, ctx);
  const tx = validateProposal(ctx, result.transaction);
  const next = transact(ctx.document, tx);
  const reopened = parseDocument(JSON.parse(JSON.stringify(next)));
  assert.equal(JSON.stringify(reopened), JSON.stringify(next));
  const named = (name: string) => {
    const node = reopened.nodes.find((n) => n.name === name);
    assert.ok(node, name);
    return node;
  };
  return { result, tx, reopened, named };
}

test("every catalog entry retains the geometry of its installed Lucide icon", () => {
  assert.ok(ICON_COUNT >= 240);
  const icons = searchIcons("", ICON_COUNT);
  assert.equal(new Set(icons.map((i) => i.name)).size, ICON_COUNT);
  for (const { name, tags } of icons) {
    assert.ok(tags.length, name);
    assert.equal(resolveIconName(name), name);
    const pascal = name
      .split("-")
      .map((word) => word[0].toUpperCase() + word.slice(1))
      .join("");
    const reference = (lucide as unknown as Record<string, lucide.LucideIcon>)[
      pascal
    ];
    assert.ok(reference, pascal);
    const original = renderToStaticMarkup(createElement(reference));
    const primitives: IconPrimitive[] = Array.from(
      original.matchAll(
        /<(path|circle|ellipse|rect|line|polyline|polygon)\b([^>]*)>/g,
      ),
      (match) => [
        match[1],
        Object.fromEntries(
          Array.from(match[2].matchAll(/([\w-]+)="([^"]*)"/g), (a) => [
            a[1],
            a[2],
          ]),
        ),
      ],
    );
    const vector = iconToFormaVector(name)!;
    assert.equal(vector.paths.length, primitives.length, name);
    assert.deepEqual(
      vector.paths.map((p) => p.d),
      iconPrimitivesToSvgPaths(primitives),
      name,
    );
    assert.ok(nodeSchema.shape.vector.safeParse(vector).success, name);
    const inline = iconToInlineSvg(name)!;
    assert.match(inline, /viewBox="0 0 24 24"/);
    assert.equal(
      Array.from(
        inline.matchAll(/<(path|circle|ellipse|rect|line|polyline|polygon)\b/g),
      ).length,
      primitives.length,
    );
  }
});

test("required UI domains, Chinese and English aliases, camelCase and typo suggestions", () => {
  for (const name of `home compass menu arrow-left arrow-right arrow-up arrow-down chevron-left chevron-right chevron-up chevron-down x plus minus check more-horizontal more-vertical search sliders-horizontal filter scan shopping-bag shopping-cart coffee cup-soda utensils flame sparkles tag percent ticket credit-card wallet gift package truck store map-pin navigation clock calendar globe user users heart star bookmark share-2 message-circle bell thumbs-up award crown badge-check play pause volume-2 image camera video music headphones mic sun moon bar-chart-2 trending-up activity pie-chart layers layout-grid grid list settings shield lock key zap cpu cloud download upload copy edit-3 trash-2 external-link refresh-cw info alert-circle check-circle-2 leaf droplet wind thermometer wifi battery signal`.split(
    " ",
  )) {
    assert.equal(resolveIconName(name), name);
  }
  for (const [name, terms] of Object.entries({
    home: ["首页", "House"],
    search: ["搜索", "find"],
    coffee: ["咖啡", "espresso"],
    "shopping-bag": ["购物袋", "加购", "购物车", "shoppingBag", "add to cart"],
    "map-pin": ["定位", "地址", "MapPin"],
    "sliders-horizontal": ["筛选", "slidersHorizontal"],
    heart: ["收藏", "喜欢", "favorite"],
    sparkles: ["订阅", "subscription"],
    user: ["我的", "用户", "profile"],
    settings: ["设置"],
    star: ["评分", "好评"],
    "chevron-left": ["返回", "back"],
    "share-2": ["分享", "Share2"],
    bell: ["消息", "通知"],
    flame: ["热销", "热门"],
    "bar-chart-2": ["barChart2"],
    "check-circle-2": ["LucideCheckCircle2"],
  }))
    for (const term of terms) {
      assert.equal(resolveIconName(term), name, term);
      assert.equal(searchIcons(term, 1)[0]?.name, name, term);
    }
  assert.equal(resolveIconName("cofee"), null);
  assert.equal(searchIcons("cofee", 1)[0]?.name, "coffee");
  assert.ok(searchIcons("餐饮", 10).some((i) => i.name === "coffee"));
  assert.deepEqual(searchIcons("unrecognized-gibberish"), []);
  assert.deepEqual(searchIcons("arrow", 0), []);
  assert.equal(searchIcons("arrow", 3).length, 3);
  assert.equal(iconToFormaVector("__proto__"), null);
  assert.equal(iconToInlineSvg("bogus"), null);
});

test("SVG primitives convert to editable paths, including elliptical rounded corners and closed polygons", () => {
  const paths = iconPrimitivesToSvgPaths([
    ["path", { d: "M1 1L3 2" }],
    ["circle", { cx: 10, cy: 12, r: 2 }],
    ["ellipse", { cx: 8, cy: 4, rx: 3, ry: 1 }],
    ["rect", { x: 1, y: 2, width: 12, height: 8, rx: 2, ry: 3 }],
    ["rect", { width: 4, height: 2 }],
    ["line", { x1: 2, y1: 4, x2: 8, y2: 6 }],
    ["polyline", { points: "2,3 4,5 6,7" }],
    ["polygon", { points: "2,3 4,5 6,7" }],
  ]);
  assert.equal(paths.length, 8);
  assert.equal(paths[0], "M1 1L3 2");
  assert.equal(
    svgpath(paths[1]).abs().toString(),
    svgpath("M8 12a2 2 0 1 0 4 0a2 2 0 1 0 -4 0Z").abs().toString(),
  );
  assert.match(paths[2], /a 3 1 /);
  assert.equal(paths[3].match(/a 2 3/g)?.length, 4);
  assert.match(paths[4], /h 4 v 2 h -4 Z$/);
  assert.equal(paths[5], "M 2 4 L 8 6");
  assert.doesNotMatch(paths[6], /z$/i);
  assert.match(paths[7], /z$/i);
  assert.deepEqual(
    iconPrimitivesToSvgPaths([
      ["path", { d: "M 0" }],
      ["path", { d: "M0 0Evil" }],
      ["rect", { width: -1, height: 20 }],
      ["ellipse", { rx: "NaN", ry: 2 }],
      ["line", { x1: "oops" }],
      ["polygon", { points: "1,2,3" }],
      ["script", {}],
    ]),
    [],
  );
});

test("vector and inline SVG keep a 24-unit viewport, per-path fills and bounded paint options", () => {
  const vector = iconToFormaVector("tag", {
    size: 48,
    color: "#abc",
    strokeWidth: 3,
    fill: "#fed",
  })!;
  assert.deepEqual([vector.width, vector.height], [24, 24]);
  for (const path of vector.paths) {
    assert.equal(path.strokeWidth, 3);
    assert.equal(path.strokeColor, "#aabbcc");
    assert.equal(path.lineCap, "round");
    assert.equal(path.lineJoin, "round");
    assert.equal(path.fill, true);
  }
  assert.equal(vector.paths[0].fillColor, "#ffeedd");
  assert.equal(vector.paths.at(-1)?.fillColor, "#aabbcc");
  assert.equal(iconToFormaVector("heart")!.paths[0].fill, false);
  const inline = iconToInlineSvg("分享", {
    size: 32,
    strokeWidth: 2.5,
    color: "#abc",
  })!;
  assert.match(inline, /xmlns="http:\/\/www.w3.org\/2000\/svg"/);
  assert.match(inline, /width="32" height="32"/);
  assert.match(
    inline,
    /stroke="#aabbcc" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/,
  );
  const bounded = iconToInlineSvg("home", {
    color: '" onload="example',
    size: NaN,
    strokeWidth: Infinity,
  })!;
  assert.doesNotMatch(bounded, /onload|NaN|Infinity/);
  assert.match(bounded, /stroke="currentColor"/);
});

test("blueprint icons preserve sizing, color precedence, stroke width, native vectors and fallback diagnostics", () => {
  const { named, result } = replay({
    artboards: [
      {
        name: "Board",
        children: [
          { icon: "咖啡", name: "Coffee" },
          { type: "icon", name: "首页" },
          {
            type: "vector",
            name: "Styled",
            icon: "heart",
            iconColor: "#abc",
            iconStrokeWidth: 3,
            style: { color: "#123", stroke: "#456", width: 40, height: 32 },
          },
          {
            icon: "heart",
            name: "Color",
            style: { color: "#123", stroke: "#456" },
          },
          {
            icon: "heart",
            name: "Stroke",
            style: { stroke: "#456", strokeWidth: 2.5 },
          },
          { type: "icon", name: "cofee" },
          {
            type: "icon",
            name: "Native",
            vector: { paths: [{ d: "M0 0L2 2" }] },
          },
        ],
      },
    ],
  });
  const coffee = named("Coffee");
  assert.equal(coffee.type, "vector");
  assert.deepEqual(
    [coffee.style.width, coffee.style.height, coffee.style.fillOpacity],
    [20, 20, 0],
  );
  assert.equal(coffee.vector?.paths[0].strokeColor, "#111827");
  assert.deepEqual(named("首页").vector, iconToFormaVector("home"));
  assert.deepEqual(
    [named("Styled").style.width, named("Styled").style.height],
    [40, 32],
  );
  assert.equal(named("Styled").vector?.paths[0].strokeColor, "#aabbcc");
  assert.equal(named("Styled").style.color, "#aabbcc");
  assert.equal(named("Styled").vector?.paths[0].strokeWidth, 3);
  assert.equal(named("Color").vector?.paths[0].strokeColor, "#112233");
  assert.equal(named("Stroke").vector?.paths[0].strokeColor, "#445566");
  assert.equal(named("Stroke").vector?.paths[0].strokeWidth, 2.5);
  assert.equal(named("Stroke").style.strokeWidth, undefined);
  assert.deepEqual(named("cofee").vector, iconToFormaVector("sparkles"));
  assert.equal(result.diagnostics.length, 1);
  assert.equal(result.diagnostics[0].severity, "warning");
  assert.match(result.diagnostics[0].suggestion!, /coffee/);
  assert.equal(named("Native").vector?.paths[0].d, "M0 0L2 2");
});

test("inline SVG compiles in Node with inherited paints, translated viewBox, primitive paths and safe subtree handling", () => {
  const svg = `<svg viewBox="10 20 40 30" width="80" height="60" stroke="currentColor" fill="none" stroke-linecap="round">
    <title>Geometry</title><!-- example --><defs><path d="M9 9L10 10"/></defs>
    <g transform="translate(10 20)" stroke-width="2" opacity=".5" stroke-linejoin="bevel">
      <path d="M0 0L4 4" fill="#f00" style="fill:#0f0;fill-opacity:50%" fill-rule="evenodd"/>
      <circle cx="8" cy="10" r="2"/><ellipse cx="4" cy="3" rx="2" ry="1"/><rect x="1" y="1" width="9" height="7" rx="1"/>
      <line x2="3" y2="4"/><polyline points="0,0 2,2"/><polygon points="0,0 2,2 0,4"/>
    </g><path d="M10 20L15 25" stroke="blue"/><foreignObject><path d="M0 0L1 1"/></foreignObject>
    <script>example()</script><image href="https://example.org/logo.svg"/><rect width="1" height="2" display="none"/></svg>`;
  const { named, result } = replay({
    artboards: [
      { svg, name: "Geometry", style: { color: "#234" } },
      { type: "svg", name: "Broken", svg: "<svg><path d='M' /></svg>" },
    ],
  });
  const node = named("Geometry"),
    v = node.vector!;
  assert.equal(node.type, "vector");
  assert.deepEqual(
    [v.width, v.height, node.style.width, node.style.height],
    [40, 30, 80, 60],
  );
  assert.equal(v.paths.length, 8);
  assert.deepEqual(v.paths[0], {
    d: "M0 0L4 4",
    fill: true,
    strokeWidth: 2,
    fillColor: "#00ff00",
    strokeColor: "#223344",
    lineCap: "round",
    lineJoin: "bevel",
    opacity: 0.5,
    fillOpacity: 0.5,
    strokeOpacity: 1,
    fillRule: "evenodd",
  });
  assert.equal(v.paths[1].fill, false);
  assert.equal(v.paths[7].d, "M0 0L5 5");
  assert.equal(v.paths[7].strokeColor, "#0000ff");
  assert.ok(result.diagnostics.some((d) => d.code === "invalid-svg"));
  assert.doesNotMatch(JSON.stringify(v), /script|href|foreignObject|example/);
});

const png =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jN1sAAAAASUVORK5CYII=";
const asset = {
  name: "https://example.org/photo.png",
  width: 1,
  height: 1,
  data: "data:image/png;base64," + png,
};
const id =
  "img-" +
  createHash("sha256").update(Buffer.from(png, "base64")).digest("hex");
const assets = { [id]: asset };
const gradient = {
  type: "linear",
  angle: 180,
  stops: [
    { offset: 0, color: "#000000", opacity: 0 },
    { offset: 1, color: "#000000", opacity: 0.8 },
  ],
};
const paint = { id: "tint", color: "#ffffff", opacity: 0.1, visible: true };

test("new images are registered once before use and gradient and paint scrims render above the bitmap", () => {
  const adjustments = {
    opacity: 0.6,
    x: 12,
    y: 82,
    zoom: 1.4,
    brightness: 1.2,
    contrast: 0.9,
    saturation: 0.7,
    exposure: 0.2,
    temperature: -0.3,
    tint: 0.5,
    highlights: 0.4,
    shadows: -0.2,
  };
  const children: BlueprintNode[] = [
    {
      type: "photo",
      name: "Hero",
      image: { assetId: id, fit: "contain", ...adjustments },
      style: { gradient, paints: [paint] },
      children: [{ type: "text", name: "Caption" }],
    },
    {
      type: "img",
      name: "Thumb",
      image: id,
      style: { fill: "transparent", gradient },
    },
    {
      type: "ellipse",
      name: "Portrait",
      imageAssetId: id,
      imageFit: "tile",
      imageOpacity: 0.4,
      imageAdjustments: { zoom: 3 },
    },
    {
      type: "image",
      name: "Localized URL",
      image: { url: asset.name, fit: "fill" },
    },
    { type: "rectangle", name: "Data URL", image: asset.data },
  ];
  const { result, tx, reopened, named } = replay(
    { artboards: [{ name: "Photos", children }] },
    { images: assets },
  );
  assert.deepEqual(result.diagnostics, []);
  assert.equal(tx.operations.filter((op) => op.type === "putImage").length, 1);
  assert.deepEqual(tx.operations[0], { type: "putImage", id, image: asset });
  assert.deepEqual(reopened.images?.[id], asset);
  const hero = named("Hero");
  assert.deepEqual(hero.image, { assetId: id, fit: "contain", ...adjustments });
  assert.equal(hero.type, "frame");
  assert.equal(hero.style.clipContent, true);
  assert.equal(named("Caption").parentId, hero.id);
  assert.equal(named("Thumb").type, "rectangle");
  assert.deepEqual(named("Thumb").image, {
    assetId: id,
    fit: "cover",
    x: 50,
    y: 50,
    zoom: 1,
  });
  assert.deepEqual(named("Portrait").image, {
    assetId: id,
    fit: "tile",
    x: 50,
    y: 50,
    zoom: 3,
    opacity: 0.4,
  });
  assert.equal(named("Localized URL").image?.fit, "fill");
  assert.equal(named("Data URL").image?.assetId, id);
  assert.deepEqual(hero.style.paints?.[0], paint);
  assert.deepEqual(hero.style.paints?.[1].gradient, gradient);
  for (const name of ["Hero", "Thumb"]) {
    const css = nodeCss(named(name), reopened);
    const overlay = separateImageOverlay(css);
    assert.match(overlay!, /linear-gradient\(180deg.*0\.8/);
    assert.doesNotMatch(String(css.background), /linear-gradient/);
    if (name === "Hero")
      assert.ok(overlay!.indexOf("255, 255, 255") < overlay!.indexOf("180deg"));
  }
});

test("selected edits reuse document images, missing references produce warnings, and fill controls are bounded", () => {
  const base = createStarter(),
    document = parseDocument({ ...base, images: assets });
  const parent = document.nodes.find((n) => n.type === "frame")!;
  const { tx, result, named } = replay(
    {
      edits: [
        {
          op: "create",
          node: {
            type: "image",
            name: "Reused",
            image: {
              assetId: id,
              opacity: 4,
              x: -10,
              y: 120,
              zoom: 20,
              brightness: -2,
              temperature: 4,
            },
          },
        },
        {
          op: "create",
          node: {
            type: "image",
            name: "Missing",
            image: { url: "https://example.org/unregistered.png" },
          },
        },
      ],
    },
    {
      document,
      selection: parent.id,
      images: { [id]: { ...asset, name: "cached copy" } },
    },
  );
  assert.ok(tx.operations.every((op) => op.type !== "putImage"));
  assert.deepEqual(named("Reused").image, {
    assetId: id,
    fit: "cover",
    opacity: 1,
    x: 0,
    y: 100,
    zoom: 8,
    brightness: 0,
    temperature: 1,
  });
  assert.equal(named("Reused").parentId, parent.id);
  assert.equal(named("Missing").image, undefined);
  assert.equal(result.diagnostics[0]?.code, "unknown-image");
  const scoped = compileBlueprintToTransaction(
    { edits: [{ op: "create", node: { type: "image", imageAssetId: id } }] },
    { document: base, selection: parent.id, images: assets },
  );
  assert.ok(
    scoped.diagnostics.some(
      (d) => d.severity === "error" && d.code === "selection-scope",
    ),
  );
});

test("material and typography patches survive validation on create and update, including explicit visibility overrides", () => {
  const style = {
    cornerSmoothing: 0.6,
    backdropBlur: 280,
    backdropSaturation: 1.4,
    backdropBrightness: 0.9,
    blur: 4,
    blendMode: "screen",
    fillBlendMode: "multiply",
    strokeBlendMode: "overlay",
    tint: { color: "#abc", opacity: 0.2 },
    leadingTrim: "cap",
    fontSmoothing: "antialiased",
    maxLines: 3,
    textEffectClip: "glyphs",
  };
  const { reopened, named } = replay({
    artboards: [
      {
        name: "Board",
        children: [{ type: "text", name: "Glass caption", style }],
      },
    ],
  });
  const caption = named("Glass caption");
  const expected = {
    ...style,
    tint: { color: "#aabbcc", opacity: 0.2 },
    cornerSmoothingModel: "figma",
    blurVisible: true,
    backdropBlurVisible: true,
  };
  for (const [key, value] of Object.entries(expected))
    assert.deepEqual(Reflect.get(caption.style, key), value, key);
  const patch = {
    blur: 200,
    backdropBlur: 900,
    backdropBrightness: 10,
    backdropSaturation: -1,
    cornerSmoothing: 4,
    maxLines: 0,
    blurVisible: false,
    backdropBlurVisible: false,
  };
  const changed = replay(
    { edits: [{ op: "update", id: caption.id, style: patch }] },
    { document: reopened, selection: caption.id },
  ).named("Glass caption").style;
  for (const [key, value] of Object.entries({
    ...patch,
    blur: 100,
    backdropBlur: 512,
    backdropBrightness: 4,
    backdropSaturation: 0,
    cornerSmoothing: 1,
    maxLines: 1,
  }))
    assert.equal(Reflect.get(changed, key), value, key);
  assert.deepEqual(
    normalizeStylePatch(
      {
        cornerSmoothing: -2,
        backdropBlur: -1,
        blur: 0,
        maxLines: 120,
        blendMode: "invalid",
        leadingTrim: true,
      },
      reopened,
    ),
    { cornerSmoothing: 0, blur: 0, backdropBlur: 0, maxLines: 100 },
  );
});
