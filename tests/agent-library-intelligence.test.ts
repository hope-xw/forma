import assert from "node:assert/strict";
import test from "node:test";
import {
  buildLibraryManifest,
  classifyComponentTier,
  CUSTOM_NOTES_END,
  CUSTOM_NOTES_START,
  extractComponentManifest,
  extractCustomNotes,
  extractLibraryTokensSummary,
  generateLibraryPlaybook,
  isExceptionComponent,
  mergeCustomNotes,
  searchLibraryAssets,
} from "../src/agent/library-intelligence";
import { mobileLibrary } from "../src/design-system/mobile";
import { material3Library } from "../src/design-system/material3";
import { antd5Library } from "../src/design-system/antd5";
import { shadcnLibrary } from "../src/design-system/shadcn";
import { nativeDesignSystem } from "../src/design-system/tokens";
import {
  defaultStyle,
  type DesignDocument,
  type DesignNode,
} from "../src/domain/document";
import {
  extractLibrariesFromDocument,
  packageDocumentAsLibrary,
} from "../src/domain/library-packaging";
import {
  componentAiHintsSchema,
  libraryAiGuideSchema,
  parseLibrary,
  type AssetTier,
  type ComponentLibrary,
  type LibraryComponent,
} from "../src/domain/library-schema";

function layer(
  key: string,
  type: DesignNode["type"],
  width: number,
  height: number,
): DesignNode {
  return {
    id: key,
    templateKey: key,
    name: key,
    parentId: "root",
    type,
    text: "",
    hidden: false,
    locked: false,
    style: { ...defaultStyle, width, height, padding: 0 },
  };
}
function asset(
  id: string,
  name: string,
  category: string,
  width: number,
  height: number,
  children: DesignNode[] = [],
): LibraryComponent {
  const root = layer("root", "frame", width, height);
  root.parentId = null;
  return {
    id,
    name,
    category,
    description: "",
    variants: [
      {
        id: "light",
        name: "浅色",
        properties: { 外观: "浅色" },
        nodes: [...children, root],
      },
    ],
  };
}
const imgId = "img-" + "a".repeat(64);
function commerce(): ComponentLibrary {
  const title = layer("title", "text", 140, 40);
  title.text = "当季好物";
  title.style.fontSize = 14;
  title.style.lineHeight = 20;
  const photo = layer("cover", "rectangle", 160, 120);
  photo.image = { assetId: imgId, fit: "cover", x: 50, y: 50, zoom: 1 };
  const badge = layer("badge", "frame", 32, 16);
  badge.nestedSlot = true;
  const products = asset(
    "goods-double-card",
    "双列商品卡楼层",
    "商品陈列",
    240,
    210,
    [title, photo, badge],
  );
  products.aiHints = {
    whenToUse: "猜你喜欢货架",
    avoidWhen: "仅有一件商品",
    tags: ["双列", "推荐流"],
    maxTextChars: 12,
    slotsNote: "商品主图保留四周留白",
  };
  products.exposed = [
    { id: "caption", name: "商品名称", target: "title", kind: "text" },
    { id: "promo", name: "营销角标", target: "badge", kind: "swap" },
  ];
  const dark = structuredClone(products.variants[0]);
  dark.id = "festival-dark";
  dark.name = "大促夜场";
  dark.properties = { 外观: "深色", 密度: "紧凑" };
  dark.nodes.find((n) => !n.parentId)!.style.width = 260;
  dark.nodes[0].text = "夜场标题";
  dark.nodes.push(layer("price", "text", 60, 20));
  products.variants.push(dark);
  const header = asset(
    "location-search",
    "顶部定位搜索头",
    "频道工具",
    375,
    60,
    ["location", "pin", "search", "camera"].map((k) =>
      layer(k, "text", 80, 20),
    ),
  );
  const empty = asset("empty-state", "空状态", "反馈", 160, 100, [
    layer("message", "text", 100, 20),
  ]);
  empty.description = "没有符合筛选条件的商品";
  return parseLibrary({
    format: "forma/library",
    version: 1,
    id: "taobao-mobile",
    name: "淘宝移动端电商组件库",
    revision: 2,
    description: "电商频道与促销素材",
    source: { name: "淘宝测试设计系统", license: "测试" },
    images: {
      [imgId]: {
        name: "封面",
        width: 1,
        height: 1,
        data: "data:image/png;base64,AAAA",
      },
    },
    components: [
      asset("channel", "频道", "主流程", 375, 812),
      header,
      products,
      asset("promo-button", "主促渐变按钮", "操作", 150, 44, [title]),
      asset("coupon", "满减标签", "促销", 48, 20),
      empty,
    ],
  });
}
function documentWith(...libs: ComponentLibrary[]): DesignDocument {
  return {
    schemaVersion: 1,
    id: "doc",
    name: "画布",
    revision: 1,
    nodes: [],
    tokens: {},
    libraries: Object.fromEntries(libs.map((l) => [l.id, l])),
  };
}

test("v1 libraries round-trip without synthesizing optional AI fields", () => {
  const legacy = commerce();
  for (const c of legacy.components) delete c.aiHints;
  const json = JSON.parse(JSON.stringify(legacy));
  assert.deepEqual(parseLibrary(json), json);
  assert.equal("aiGuide" in parseLibrary(json), false);
  for (const c of parseLibrary(json).components) {
    assert.equal("assetTier" in c, false);
    assert.equal("aiHints" in c, false);
  }
});

test("parse, package and Figma/Sketch document extraction preserve authored metadata and isolate source libraries", () => {
  const lib = commerce();
  lib.components[2].assetTier = "component";
  lib.aiGuide = {
    summary: "货架说明",
    platform: "手机 H5",
    visualPrinciples: ["品牌橙"],
    compositionRules: ["复用卡片"],
    exceptionPatterns: ["无结果用空态"],
    revision: 2,
    generatedAt: "2026-11-25",
    playbookMarkdown: CUSTOM_NOTES_START + "团队备注" + CUSTOM_NOTES_END,
  };
  const before = structuredClone(lib);
  assert.deepEqual(parseLibrary(JSON.parse(JSON.stringify(lib))), lib);
  const doc = documentWith(lib);
  const options = { name: "活动库", libraryIds: [lib.id] };
  const packed = packageDocumentAsLibrary(doc, options);
  assert.deepEqual(packed.aiGuide, lib.aiGuide);
  assert.deepEqual(packed.components, lib.components);
  assert.deepEqual(
    packageDocumentAsLibrary(doc, {
      ...options,
      aiGuide: { summary: "新指南" },
    }).aiGuide,
    { summary: "新指南" },
  );
  for (const format of ["Figma", "Sketch"] as const) {
    doc.importReport = {
      version: 1,
      format,
      filename: format === "Figma" ? "demo.fig" : "demo.sketch",
      sha256: "0".repeat(64),
      sourceNodes: 32,
      issues: [],
    };
    const extracted = extractLibrariesFromDocument(doc);
    assert.deepEqual(extracted.aiGuide, lib.aiGuide);
    assert.deepEqual(extracted.components, lib.components);
    assert.deepEqual(
      extractLibrariesFromDocument(doc, { aiGuide: {} }).aiGuide,
      {},
    );
  }
  const other = { ...lib, id: "other", aiGuide: { summary: "另一份指南" } };
  const multi = extractLibrariesFromDocument(documentWith(lib, other));
  assert.equal("aiGuide" in multi, false);
  assert.deepEqual(
    multi.components[lib.components.length + 2].aiHints,
    lib.components[2].aiHints,
  );
  assert.deepEqual(lib, before);
});

test("new optional fields enforce the schema bounds", () => {
  assert.throws(() =>
    parseLibrary({ ...commerce(), aiGuide: { revision: -1 } }),
  );
  assert.throws(() =>
    parseLibrary({
      ...commerce(),
      components: [{ ...commerce().components[0], assetTier: "atom" }],
    }),
  );
  for (const hints of [
    { whenToUse: "a".repeat(501) },
    { avoidWhen: "a".repeat(501) },
    { tags: Array(17).fill("a") },
    { tags: ["a".repeat(41)] },
    { maxTextChars: 0 },
    { maxTextChars: 2.5 },
    { maxTextChars: 2001 },
    { slotsNote: "a".repeat(501) },
  ])
    assert.equal(componentAiHintsSchema.safeParse(hints).success, false);
  for (const guide of [
    { summary: "a".repeat(1001) },
    { platform: "a".repeat(81) },
    { compositionRules: Array(21).fill("a") },
    { exceptionPatterns: ["a".repeat(241)] },
    { playbookMarkdown: "a".repeat(64001) },
  ])
    assert.equal(libraryAiGuideSchema.safeParse(guide).success, false);
});

test("page and block rules respect exact size, child-count, naming and explicit tier precedence", () => {
  function classify(
    name: string,
    w: number,
    h: number,
    count: number,
    assetTier?: AssetTier,
  ) {
    const children = Array.from({ length: count }, (_, i) =>
      layer("n" + i, "rectangle", 10, 10),
    );
    return classifyComponentTier({
      ...asset("test", name, "素材", w, h, children),
      assetTier,
    });
  }
  assert.equal(classify("频道", 320, 520, 0), "page");
  assert.equal(classify("频道", 319, 520, 0), "component");
  assert.equal(classify("ChannelScreen", 280, 400, 0), "page");
  assert.equal(classify("会场", 280, 399, 0), "component");
  assert.equal(classify("工具", 260, 80, 4), "block");
  assert.equal(classify("工具", 259, 80, 4), "component");
  assert.equal(classify("工具", 260, 80, 3), "component");
  assert.equal(classify("TabBar", 220, 48, 2), "block");
  assert.equal(classify("TabBar", 220, 48, 1), "component");
  assert.equal(classify("Tablet", 220, 48, 2), "component");
  assert.equal(classify("Page", 390, 844, 8, "component"), "component");
  assert.equal(classify("控件", 30, 20, 0, "block"), "block");
  for (const name of [
    "网络异常",
    "骨架屏",
    "EmptyState",
    "OfflineNotice",
    "WarningDialog",
    "Modal",
    "Loading",
  ]) {
    assert.ok(isExceptionComponent(asset("x", name, "资源", 10, 10)), name);
  }
});

test("commerce manifest exposes six classified assets, variant matrices, copy limits, image geometry and swap targets", () => {
  const lib = commerce();
  const manifest = buildLibraryManifest(lib);
  assert.deepEqual(manifest.tierCounts, { page: 1, block: 2, component: 3 });
  assert.deepEqual(
    manifest.components.map((c) => c.assetTier),
    ["page", "block", "block", "component", "component", "component"],
  );
  assert.deepEqual(
    manifest.categories,
    lib.components.map((c) => c.category),
  );
  assert.deepEqual(
    manifest.exceptionComponents.map((c) => c.componentId),
    ["empty-state"],
  );
  const card = manifest.components[2];
  assert.deepEqual(card.rootSize, {
    width: 240,
    height: 210,
    widthMode: "fixed",
    heightMode: "fixed",
    layout: "free",
  });
  assert.equal(card.defaultVariantId, "light");
  assert.deepEqual(card.variantAxes, {
    外观: ["浅色", "深色"],
    密度: ["紧凑"],
  });
  assert.deepEqual(card.variants[1], {
    variantId: "festival-dark",
    name: "大促夜场",
    properties: { 外观: "深色", 密度: "紧凑" },
    width: 260,
    height: 210,
  });
  assert.deepEqual(card.textSlots, [
    {
      templateKey: "title",
      name: "title",
      defaultText: "当季好物",
      recommendedMaxChars: 12,
      exposedId: "caption",
    },
    {
      templateKey: "price",
      name: "price",
      defaultText: "",
      recommendedMaxChars: 12,
    },
  ]);
  assert.equal(manifest.components[3].textSlots[0].recommendedMaxChars, 28);
  assert.deepEqual(card.imageSlots, [
    {
      templateKey: "cover",
      name: "cover",
      width: 160,
      height: 120,
      aspectRatio: 4 / 3,
    },
  ]);
  assert.deepEqual(card.swapSlots, [
    { exposedId: "promo", name: "营销角标", targetTemplateKey: "badge" },
  ]);
  assert.deepEqual(card.aiHints, lib.components[2].aiHints);
  lib.components[2].variants[0].nodes[1].style.height = 0;
  assert.equal(
    extractComponentManifest(lib, lib.components[2]).imageSlots[0].aspectRatio,
    null,
  );
});

test("token summary resolves cross-collection aliases for both appearances and includes numeric modes, typography and effects", () => {
  const lib = commerce();
  const ds = nativeDesignSystem();
  lib.designSystem = ds;
  const semantic = ds.collections.semantic;
  semantic.defaultModeId = "dark";
  semantic.modes = [
    { id: "dark", name: "深色" },
    { id: "light", name: "浅色" },
  ];
  ds.collections.brand = {
    id: "brand",
    name: "Brand",
    defaultModeId: "base",
    modes: [{ id: "base", name: "Base" }],
  };
  ds.variables.brand = {
    ...ds.variables["color-accent"],
    id: "brand",
    collectionId: "brand",
    name: "品牌主色",
    values: { base: { alias: "color-accent" } },
  };
  ds.activeModes.layout = "compact";
  const title = lib.components[2].variants[0].nodes[0];
  title.styleBindings = { text: "text-title" };
  title.variableBindings = { color: "brand", text: "content-label" };
  const root = lib.components[2].variants[0].nodes.at(-1)!;
  root.variableModes = { semantic: "dark" };
  root.style.widthMode = "fill";
  root.style.heightMode = "hug";
  const parsed = parseLibrary(lib);
  const summary = extractLibraryTokensSummary(parsed);
  assert.deepEqual(
    summary.colors.find((v) => v.id === "brand"),
    {
      id: "brand",
      name: "品牌主色",
      light: ds.variables["palette-light-accent"].values.base,
      dark: ds.variables["palette-dark-accent"].values.base,
    },
  );
  assert.equal(summary.radii.find((v) => v.id === "radius-md")?.value, 12);
  assert.deepEqual(
    summary.spacing.find((v) => v.id === "space-sm")?.valuesByMode,
    { comfortable: 8, compact: 4 },
  );
  assert.equal(
    summary.textStyles.find((s) => s.id === "text-title")?.properties.fontSize,
    24,
  );
  assert.equal(
    summary.effectStyles.find((s) => s.id === "effect-glass")?.properties
      .backdropBlur,
    24,
  );
  const card = extractComponentManifest(parsed, parsed.components[2]);
  assert.equal(card.rootSize.widthMode, "fill");
  assert.equal(card.rootSize.heightMode, "hug");
  assert.equal(
    card.textSlots[0].defaultText,
    ds.variables["content-label"].values.dark,
  );
  for (const id of [
    "brand",
    "color-accent",
    "palette-light-accent",
    "palette-dark-accent",
    "font-family",
    "text-title",
    "content-label",
  ])
    assert.ok(card.boundTokens.includes(id), id);
  assert.equal(card.boundTokens.includes("space-lg"), false);
  const channel = parsed.components[0];
  const channelRoot = channel.variants[0].nodes[0];
  channelRoot.variableBindings = { height: "space-sm" };
  assert.equal(classifyComponentTier(channel, parsed), "component");
  assert.equal(extractComponentManifest(parsed, channel).rootSize.height, 4);
  const { markdown } = generateLibraryPlaybook(parsed);
  for (const value of [
    "品牌主色",
    "Heading/Large",
    "Radius/radius-md",
    "Spacing/space-sm",
    "Material/Glass",
  ])
    assert.ok(markdown.includes(value), value);
});

for (const [library, platform] of [
  [mobileLibrary, "iOS / iPadOS"],
  [material3Library, "Android"],
  [antd5Library, "Web 中后台"],
  [shadcnLibrary, "Web"],
] as const) {
  test(
    library.name +
      " offline playbook covers every component and variant in its library snapshot",
    () => {
      const { manifest, markdown, aiGuide } = generateLibraryPlaybook(library);
      assert.equal(manifest.platform, platform);
      assert.equal(manifest.components.length, library.components.length);
      assert.equal(
        Object.values(manifest.tierCounts).reduce((sum, n) => sum + n, 0),
        library.components.length,
      );
      assert.ok(manifest.tierCounts.block && manifest.tierCounts.component);
      assert.ok(
        manifest.exceptionComponents.length &&
          manifest.tokensSummary.colors.length,
      );
      libraryAiGuideSchema.parse(aiGuide);
      assert.equal(markdown, aiGuide.playbookMarkdown);
      for (const heading of [
        "视觉与 Token 铁律",
        "Page 页面样板",
        "Block 业务模块与楼层",
        "Component 原子组件",
        "异常与边界态对照表",
        "混合装配调用规则",
        CUSTOM_NOTES_START,
        CUSTOM_NOTES_END,
      ])
        assert.ok(markdown.includes(heading), heading);
      for (const [i, c] of library.components.entries()) {
        const entry = manifest.components[i];
        assert.equal(entry.libraryId, library.id);
        assert.equal(entry.componentId, c.id);
        assert.equal(entry.assetTier, classifyComponentTier(c, library));
        assert.ok(markdown.includes("`" + c.id + "`"), c.id);
        assert.deepEqual(
          entry.variants.map((v) => v.variantId),
          c.variants.map((v) => v.id),
        );
        assert.ok(entry.variants.every((v) => v.width >= 0 && v.height >= 0));
        const nodes = c.variants.flatMap((v) => v.nodes);
        assert.deepEqual(
          new Set(entry.textSlots.map((s) => s.templateKey)),
          new Set(
            nodes
              .filter((n) => ["text", "button"].includes(n.type))
              .map((n) => n.templateKey),
          ),
        );
        assert.deepEqual(
          new Set(entry.imageSlots.map((s) => s.templateKey)),
          new Set(nodes.filter((n) => n.image).map((n) => n.templateKey)),
        );
      }
    },
  );
}

test("refresh adds new assets, removes deleted entries and preserves human rules and custom notes byte-for-byte", () => {
  const lib = commerce();
  const { markdown, aiGuide } = generateLibraryPlaybook(lib);
  const notes = "\r\n  大促通栏叫腰封。\r\n\r\n\t- 上线前核对 $& 和 $$  \r\n";
  const marked = CUSTOM_NOTES_START + notes + CUSTOM_NOTES_END;
  assert.equal(extractCustomNotes(mergeCustomNotes("正文", marked)), notes);
  assert.equal(extractCustomNotes(), "");
  const oldGuide = {
    ...aiGuide,
    summary: "团队资产",
    platform: "淘宝 H5",
    visualPrinciples: ["  品牌橙  ", "品牌橙"],
    compositionRules: ["先放腰封"],
    exceptionPatterns: ["断货进入补货提醒"],
    playbookMarkdown: mergeCustomNotes(markdown, marked),
  };
  const updated = {
    ...lib,
    revision: 3,
    components: [
      ...lib.components.slice(1),
      asset("waist-banner", "腰封模块", "促销", 375, 60),
    ],
  };
  const before = structuredClone(oldGuide);
  const next = generateLibraryPlaybook(updated, oldGuide);
  assert.deepEqual(oldGuide, before);
  assert.equal(next.aiGuide.summary, "团队资产");
  assert.equal(next.manifest.platform, "淘宝 H5");
  assert.equal(extractCustomNotes(next.markdown), notes);
  assert.equal(next.aiGuide.revision, 3);
  assert.ok(next.markdown.includes("`waist-banner`"));
  assert.ok(!next.markdown.includes("`channel`"));
  assert.deepEqual(
    next.aiGuide.visualPrinciples!.filter((v) => v.trim() === "品牌橙"),
    ["  品牌橙  "],
  );
  for (const s of [
    "先放腰封",
    "断货进入补货提醒",
    "≤12 字",
    "160×120",
    "猜你喜欢货架",
    "data-forma-component",
    "adapt",
    "propose_html_design",
  ])
    assert.ok(next.markdown.includes(s), s);
  assert.deepEqual(
    generateLibraryPlaybook({ ...updated, aiGuide: next.aiGuide }),
    next,
  );
  const saved = { ...updated, aiGuide: next.aiGuide };
  assert.equal(
    extractCustomNotes(
      generateLibraryPlaybook(saved, { playbookMarkdown: "导入正文" }).markdown,
    ),
    notes,
  );
  assert.equal(
    extractCustomNotes(
      generateLibraryPlaybook(saved, {
        playbookMarkdown: CUSTOM_NOTES_START + CUSTOM_NOTES_END,
      }).markdown,
    ),
    "",
  );
});

test("long playbooks stay within the persisted schema while preserving the complete manifest, full rule arrays and verbatim notes", () => {
  const lib = commerce();
  const notes = "\n" + "  大促通栏叫腰封。\r\n".repeat(4000);
  const rules = Array.from({ length: 20 }, (_, i) => "手写规则 " + i);
  const tagged = lib.components[2];
  lib.components = Array.from({ length: 400 }, (_, i) => ({
    ...tagged,
    id: "goods-" + i,
  }));
  lib.name += CUSTOM_NOTES_START;
  const result = generateLibraryPlaybook(lib, {
    visualPrinciples: rules,
    playbookMarkdown: CUSTOM_NOTES_START + notes + CUSTOM_NOTES_END,
  });
  assert.equal(result.manifest.components.length, 400);
  assert.deepEqual(result.aiGuide.visualPrinciples, rules);
  assert.equal(extractCustomNotes(result.markdown), notes);
  assert.ok(result.markdown.includes("详见 Manifest 中的完整条目"));
  assert.ok(result.markdown.includes("`goods-399`"));
  libraryAiGuideSchema.parse(result.aiGuide);
});

test("asset search ranks exact identities and pages full manifests after tier, category, exception and library filters", () => {
  const lib = commerce();
  const other = {
    ...lib,
    id: "second",
    name: "其他库",
    components: [asset("other", "猜你喜欢货架", "陈列", 200, 40)],
  };
  const doc = documentWith(lib, other);
  const ids = (opts: Parameters<typeof searchLibraryAssets>[1]) =>
    searchLibraryAssets(doc, opts).components.map((c) => c.componentId);
  assert.deepEqual(ids({ tier: "block" }), [
    "location-search",
    "goods-double-card",
  ]);
  assert.deepEqual(ids({ query: "楼层", tier: "block" }), [
    "goods-double-card",
    "location-search",
  ]);
  assert.deepEqual(ids({ onlyExceptions: true }), ["empty-state"]);
  assert.deepEqual(ids({ query: "猜你喜欢货架" }), [
    "other",
    "goods-double-card",
  ]);
  assert.deepEqual(ids({ query: "猜你喜欢货架", libraryId: lib.id }), [
    "goods-double-card",
  ]);
  assert.deepEqual(ids({ query: "推荐流 紧凑", category: "商品陈列" }), [
    "goods-double-card",
  ]);
  assert.deepEqual(ids({ query: "推荐流", category: "反馈" }), []);
  assert.deepEqual(ids({ query: "双列" }), ["goods-double-card"]);
  assert.deepEqual(ids({ query: "FESTIVAL-DARK" }), ["goods-double-card"]);
  assert.deepEqual(ids({ query: "模板" }), ["channel"]);
  assert.deepEqual(
    ids({ query: "淘宝移动端" }),
    lib.components.map((c) => c.id),
  );
  assert.deepEqual(ids({ libraryId: "missing" }), []);
  const options = { tier: "block" as const, limit: 1 };
  const first = searchLibraryAssets(doc, options);
  assert.equal(first.total, 2);
  assert.equal(first.nextOffset, 1);
  const second = searchLibraryAssets(doc, {
    ...options,
    offset: first.nextOffset,
  });
  assert.equal(second.nextOffset, null);
  assert.deepEqual(second.components, [
    extractComponentManifest(lib, lib.components[2]),
  ]);
  assert.deepEqual(ids({ ...options, offset: 3 }), []);
  assert.equal(searchLibraryAssets(documentWith()).total, 0);
});
