import test from "node:test";
import assert from "node:assert/strict";
import { createStarter } from "../src/domain/seed";
import { transact } from "../src/domain/commands";
import {
  createLibraryFromSelection,
  instantiateComponent,
} from "../src/domain/library";
import {
  createNode,
  parseDocument,
  type DesignDocument,
} from "../src/domain/document";
import { compileBlueprintToTransaction } from "../src/agent/blueprint-compiler";
import {
  buildDesignContextPayload,
  computeArtboardPlacement,
} from "../src/agent/context-builder";
import { inferModelCapabilities } from "../src/agent/capabilities";
import {
  runDesignChat,
  type AgentProgressEvent,
} from "../src/agent/design-engine";
import { validateProposal } from "../src/agent/provider";
import { layoutBounds } from "../src/domain/geometry";
import { sizingMode, sizingCss } from "../src/domain/sizing";
import { searchToolbarBlueprint } from "./fixtures/agent-search-toolbar";

function createDocumentWithSystemAndLibrary(): DesignDocument {
  const base = createStarter();
  return parseDocument({
    ...base,
    designSystem: {
      collections: {
        "col-theme": {
          id: "col-theme",
          name: "主题色",
          defaultModeId: "mode-light",
          modes: [
            { id: "mode-light", name: "浅色" },
            { id: "mode-dark", name: "深色" },
          ],
        },
      },
      variables: {
        "var-primary": {
          id: "var-primary",
          collectionId: "col-theme",
          name: "Brand/Primary",
          type: "color",
          description: "品牌主色",
          codeSyntax: "--brand-primary",
          scopes: ["fill", "color"],
          values: {
            "mode-light": "#0d99ff",
            "mode-dark": "#38bdf8",
          },
        },
        "var-radius": {
          id: "var-radius",
          collectionId: "col-theme",
          name: "Radius/Card",
          type: "number",
          description: "卡片圆角",
          codeSyntax: "--radius-card",
          scopes: ["radius"],
          values: {
            "mode-light": 16,
            "mode-dark": 16,
          },
        },
      },
      styles: {
        "style-h1": {
          id: "style-h1",
          name: "Heading/H1",
          kind: "text",
          description: "页面大标题",
          properties: { fontSize: 28, fontWeight: 700, lineHeight: 36 },
          bindings: {},
        },
      },
      activeModes: {
        "col-theme": "mode-light",
      },
    },
    libraries: {
      "lib-ui": {
        format: "forma/library",
        version: 1,
        id: "lib-ui",
        name: "Forma UI Kit",
        description: "Test UI library",
        revision: 1,
        source: {
          name: "Forma",
          license: "MIT",
        },
        components: [
          {
            id: "comp-btn",
            name: "主按钮",
            category: "操作",
            description: "Primary CTA button",
            variants: [
              {
                id: "var-primary-btn",
                name: "默认",
                properties: { 尺寸: "中", 状态: "默认" },
                nodes: [
                  {
                    id: "tpl-btn-root",
                    parentId: null,
                    type: "button",
                    name: "主按钮",
                    text: "确认提交",
                    hidden: false,
                    locked: false,
                    templateKey: "root",
                    style: {
                      x: 0,
                      y: 0,
                      width: 160,
                      height: 44,
                      fill: "#0d99ff",
                      color: "#ffffff",
                      radius: 10,
                      fontSize: 15,
                      padding: 12,
                      gap: 8,
                      layout: "row",
                    },
                  },
                ],
              },
            ],
          },
        ],
      },
    },
  });
}

test("compileBlueprintToTransaction builds multi-screen auto-layout, normalizes colors & lineHeight, resolves prototype links, and avoids artboard overlap", () => {
  const doc = createDocumentWithSystemAndLibrary();
  const existingMaxRight = Math.max(
    ...doc.nodes
      .filter((n) => n.parentId === null)
      .map((n) => n.style.x + n.style.width),
  );

  const compiled = compileBlueprintToTransaction(
    {
      mode: "generate",
      reply: "已生成登录页与首页双屏原型",
      summary: "创建 2 个 H5 画板含原型跳转与组件复用",
      artboards: [
        {
          refId: "login-screen",
          type: "frame",
          name: "登录页 (H5)",
          style: {
            width: 390,
            height: 844,
            layout: "column",
            padding: 24,
            gap: 20,
            fill: "#0f172a",
            radius: 24,
          },
          children: [
            {
              type: "text",
              name: "标题",
              text: "欢迎使用 Forma",
              style: {
                fontSize: 28,
                fontWeight: "bold",
                lineHeight: 1.4,
                color: "#fff",
                widthMode: "fill",
              },
              styleBindings: { text: "style-h1", paint: "nonexistent-style" },
            },
            {
              type: "frame",
              name: "输入卡片",
              style: {
                widthMode: "fill",
                height: 160,
                layout: "column",
                padding: 16,
                gap: 12,
                fill: "#1e293b80",
                stroke: "#334155",
                strokeWidth: 1,
                shadows: [
                  { x: 0, y: 8, blur: 24, color: "#000", opacity: 0.2 },
                ],
              },
              variableBindings: {
                radius: "var-radius",
                fill: "nonexistent-var",
                width: "var-primary", // wrong type -> safely dropped
              },
              children: [
                {
                  type: "rectangle",
                  name: "邮箱输入框",
                  style: { widthMode: "fill", height: 44, fill: "#0f172a" },
                  control: {
                    kind: "textfield",
                    label: "工作邮箱",
                    value: "designer@forma.app",
                  },
                },
              ],
            },
            {
              type: "component",
              libraryId: "lib-ui",
              componentId: "comp-btn",
              variantId: "var-primary-btn",
            },
            {
              type: "button",
              name: "立即登录",
              text: "立即登录",
              style: {
                widthMode: "fill",
                height: 48,
                fill: "#09f",
                color: "white",
                radius: 12,
              },
              variableBindings: { fill: "var-primary" },
              interaction: {
                navigateToRef: "home-screen",
                transition: {
                  type: "slide-in",
                  direction: "left",
                  duration: 240,
                },
              },
            },
          ],
        },
        {
          refId: "home-screen",
          type: "frame",
          name: "工作台首页 (H5)",
          style: {
            width: 390,
            height: 844,
            layout: "column",
            padding: 24,
            gap: 16,
            fill: "#f8fafc",
          },
          children: [
            {
              type: "button",
              name: "返回按钮",
              text: "返回登录",
              interaction: { back: true },
            },
          ],
        },
      ],
    },
    { document: doc, selection: null },
  );

  assert.equal(compiled.mode, "generate");
  assert.ok(compiled.transaction);
  assert.equal(compiled.createdRootIds.length, 2);
  assert.equal(compiled.stats.componentsInserted, 1);
  assert.equal(compiled.stats.tokensBound, 3); // style-h1 + var-radius + var-primary

  // Must pass strict validateProposal & transact!
  const validated = validateProposal(
    { prompt: "login flow", document: doc, selection: null },
    compiled.transaction,
  );
  const nextDoc = transact(doc, validated);

  const loginBoard = nextDoc.nodes.find(
    (n) => n.id === compiled.createdRootIds[0],
  )!;
  const homeBoard = nextDoc.nodes.find(
    (n) => n.id === compiled.createdRootIds[1],
  )!;
  assert.equal(loginBoard.style.x, existingMaxRight + 80);
  assert.equal(
    homeBoard.style.x,
    loginBoard.style.x + loginBoard.style.width + 80,
  );

  const heading = nextDoc.nodes.find(
    (n) => n.parentId === loginBoard.id && n.name === "标题",
  )!;
  assert.equal(heading.style.color, "#ffffff");
  assert.equal(heading.style.fontWeight, 700);
  assert.equal(heading.style.lineHeight, 39); // 1.4 * 28 rounded
  assert.equal(heading.styleBindings?.text, "style-h1");
  assert.equal(heading.styleBindings?.paint, undefined);

  const card = nextDoc.nodes.find(
    (n) => n.parentId === loginBoard.id && n.name === "输入卡片",
  )!;
  assert.equal(card.style.fill, "#1e293b");
  assert.ok(
    card.style.fillOpacity !== undefined &&
      card.style.fillOpacity > 0.49 &&
      card.style.fillOpacity < 0.51,
  );
  assert.equal(card.variableBindings?.radius, "var-radius");
  assert.equal(card.variableBindings?.fill, undefined);
  assert.equal(card.variableBindings?.width, undefined);

  const loginBtn = nextDoc.nodes.find(
    (n) => n.parentId === loginBoard.id && n.name === "立即登录",
  )!;
  assert.equal(loginBtn.style.fill, "#0099ff");
  assert.equal(loginBtn.interaction?.actions?.[0]?.kind, "navigate");
  if (loginBtn.interaction?.actions?.[0]?.kind === "navigate") {
    assert.equal(loginBtn.interaction.actions[0].target, homeBoard.id);
  }
});

test("implicit wrappers preserve the dark banner and leave room for inline search, a chip and a button", () => {
  const document = { ...createStarter(), nodes: [] };
  const ctx = { document, selection: null, prompt: "发现页" };
  const result = compileBlueprintToTransaction(searchToolbarBlueprint, ctx);
  const next = transact(document, validateProposal(ctx, result.transaction));
  const named = (name: string) => next.nodes.find((n) => n.name === name)!;
  const root = named("发现页").style;
  assert.deepEqual(
    [
      root.width,
      root.height,
      root.fill,
      root.fillOpacity ?? 1,
      root.layout,
      root.radius,
      root.padding,
      root.gap,
    ],
    [390, 844, "#ffffff", 1, "column", 0, 24, 12],
  );
  const wrapper = named("标题容器").style;
  assert.deepEqual(
    [
      wrapper.fill,
      wrapper.fillOpacity,
      wrapper.padding,
      wrapper.radius,
      wrapper.gap,
      wrapper.widthMode,
      wrapper.heightMode,
      wrapper.height,
    ],
    ["#ffffff", 0, 0, 0, 0, "fill", "hug", 40],
  );
  assert.equal(named("深色横幅").style.fillOpacity ?? 1, 1);
  const modes = (name: string) => [
    named(name).style.widthMode,
    named(name).style.heightMode,
  ];
  assert.deepEqual(modes("标题"), ["fill", "hug"]);
  assert.deepEqual(modes("搜索框"), ["fill", "hug"]);
  assert.deepEqual(modes("搜索提示"), ["hug", "hug"]);
  assert.deepEqual(modes("筛选胶囊"), ["hug", "hug"]);
  const chip = named("筛选胶囊").style;
  assert.deepEqual(
    [chip.width, chip.height, chip.radius, chip.fillOpacity ?? 1],
    [80, 40, 16, 1],
  );
  const button = named("地图按钮"),
    row = named("搜索工具栏");
  assert.deepEqual([button.style.width, button.style.height], [96, 36]);
  assert.equal(sizingMode(button, row, "width"), "hug");
  assert.equal(sizingCss(button, row).width, "max-content");
  const bounds = layoutBounds(next);
  const box = (name: string) => bounds.get(named(name).id)!;
  const search = box("搜索框"),
    hint = box("搜索提示"),
    pill = box("筛选胶囊");
  assert.ok(hint.width >= 7 * 16 && hint.width + 16 <= search.width);
  assert.equal(pill.width, box("筛选标签").width + 16);
  assert.ok(search.x + search.width + 8 <= pill.x);
  assert.ok(
    box("地图按钮").x + box("地图按钮").width <=
      box("搜索工具栏").x + box("搜索工具栏").width,
  );
});

test("child frame transparency respects every paint source, alpha and explicit layout geometry", () => {
  const document = createDocumentWithSystemAndLibrary();
  document.designSystem!.styles.surface = {
    id: "surface",
    name: "Surface",
    kind: "paint",
    description: "Card surface",
    properties: { fill: "#123456" },
    bindings: {},
  };
  const ctx = { document, selection: null, prompt: "卡片" };
  const paint = { id: "surface", visible: true, opacity: 1, color: "#123456" };
  const result = compileBlueprintToTransaction(
    {
      artboards: [
        {
          children: [
            {
              name: "solid",
              style: {
                fill: "#fff",
                padding: 17,
                gap: 5,
                radius: 9,
                width: 111,
                height: 37,
              },
            },
            { name: "alias", style: { backgroundColor: "#fff" } },
            {
              name: "gradient",
              style: {
                gradient: {
                  stops: [
                    { offset: 0, color: "#111111" },
                    { offset: 1, color: "#eeeeee" },
                  ],
                },
              },
            },
            { name: "paints", style: { paints: [paint] } },
            { name: "token", fillToken: "brand" },
            { name: "variable", variableBindings: { fill: "var-primary" } },
            { name: "style", styleBindings: { paint: "surface" } },
            {
              name: "alpha",
              style: {
                fillOpacity: 0.4,
                widthMode: "hug",
                heightMode: "fixed",
              },
            },
            { name: "empty paints", style: { paints: [] } },
          ],
        },
      ],
    },
    ctx,
  );
  assert.deepEqual(result.diagnostics, []);
  const next = transact(document, validateProposal(ctx, result.transaction));
  const style = (name: string) =>
    next.nodes.find((n) => n.name === name)!.style;
  for (const name of [
    "solid",
    "alias",
    "gradient",
    "paints",
    "token",
    "variable",
    "style",
  ])
    assert.equal(style(name).fillOpacity ?? 1, 1, name);
  const solid = style("solid");
  assert.deepEqual(
    [
      solid.width,
      solid.height,
      solid.widthMode ?? "fixed",
      solid.heightMode ?? "fixed",
      solid.padding,
      solid.gap,
      solid.radius,
    ],
    [111, 37, "fixed", "fixed", 17, 5, 9],
  );
  assert.deepEqual(
    [
      style("alpha").fillOpacity,
      style("alpha").widthMode,
      style("alpha").heightMode,
    ],
    [0.4, "hug", "fixed"],
  );
  assert.equal(style("empty paints").fillOpacity, 0);
});

test("selection and create edits inherit the existing parent layout and preserve explicit dimensions", () => {
  const document = createStarter();
  const root = document.nodes[0];
  root.style.layout = "row";
  const ctx = { document, selection: root.id, prompt: "添加筛选" };
  const result = compileBlueprintToTransaction(
    {
      artboards: [
        {
          type: "frame",
          name: "当前筛选",
          children: [{ type: "text", text: "今天" }],
        },
      ],
      edits: [
        {
          op: "create",
          parentId: root.id,
          node: { type: "text", name: "行内文案" },
          children: [
            {
              type: "button",
              name: "定宽按钮",
              style: { width: 128, height: 48 },
            },
          ],
        },
        { op: "update", id: root.id, style: { layout: "column" } },
        {
          op: "create",
          parentId: root.id,
          node: { type: "text", name: "列内文案" },
        },
      ],
    },
    ctx,
  );
  const next = transact(document, validateProposal(ctx, result.transaction));
  const child = (name: string) =>
    next.nodes.find((n) => n.name === name)!.style;
  assert.equal(child("当前筛选").widthMode, "hug");
  assert.equal(child("行内文案").widthMode, "hug");
  assert.equal(child("列内文案").widthMode, "fill");
  assert.deepEqual(
    [
      child("定宽按钮").width,
      child("定宽按钮").height,
      child("定宽按钮").widthMode ?? "fixed",
    ],
    [128, 48, "fixed"],
  );
});

test("computeArtboardPlacement places cleanly on blank canvas and respects non-overlapping viewportCenter", () => {
  const blankDoc = parseDocument({
    ...createStarter(),
    nodes: [],
  });
  assert.deepEqual(computeArtboardPlacement(blankDoc), {
    x: 80,
    y: 80,
    gap: 80,
  });
  assert.deepEqual(
    computeArtboardPlacement(
      blankDoc,
      { x: 500, y: 600 },
      { width: 400, height: 800 },
    ),
    { x: 300, y: 200, gap: 80 },
  );
});

test("compileBlueprintToTransaction strictly enforces selection scope", () => {
  const doc = createStarter();
  const selectedBoard = doc.nodes[0];
  const outsideNode = doc.nodes.find(
    (n) => n.id !== selectedBoard.id && n.parentId !== selectedBoard.id,
  );

  const compiled = compileBlueprintToTransaction(
    {
      mode: "edit",
      reply: "优化当前选中画板",
      edits: [
        {
          op: "update",
          id: selectedBoard.id,
          patch: { name: "已优化画板" },
          style: { fill: "#111827" },
        },
        ...(outsideNode
          ? [{ op: "update", id: outsideNode.id, patch: { name: "越界修改" } }]
          : []),
        {
          op: "putToken",
          id: "brand",
          token: { name: "Brand", value: "#0d99ff" },
        },
      ],
      artboards: [
        {
          type: "text",
          name: "新增副标题",
          text: "在选区内生成",
          style: { color: "#e2e8f0" },
        },
      ],
    },
    { document: doc, selection: selectedBoard.id },
  );

  assert.ok(compiled.transaction);
  const validated = validateProposal(
    {
      prompt: "optimize selection",
      document: doc,
      selection: selectedBoard.id,
    },
    compiled.transaction,
  );
  const nextDoc = transact(doc, validated);
  assert.equal(
    nextDoc.nodes.find((n) => n.id === selectedBoard.id)?.name,
    "已优化画板",
  );
  const added = nextDoc.nodes.find((n) => n.name === "新增副标题");
  assert.equal(added?.parentId, selectedBoard.id);
});

test("buildDesignContextPayload resolves @mentions for components, variables, styles, and nodes", () => {
  const doc = createDocumentWithSystemAndLibrary();
  const caps = inferModelCapabilities("openai", "openai-chat", "gpt-4.1");
  const payload = buildDesignContextPayload(
    {
      prompt: "使用主按钮与主色变量",
      document: doc,
      selection: null,
      mentions: [
        { kind: "component", id: "lib-ui/comp-btn", label: "主按钮" },
        { kind: "variable", id: "var-primary", label: "Brand/Primary" },
        { kind: "style", id: "style-h1", label: "Heading/H1" },
        { kind: "node", id: doc.nodes[0].id, label: doc.nodes[0].name },
      ],
    },
    caps,
  );

  assert.equal(payload.resolvedMentions.length, 4);
  assert.ok(payload.resolvedMentions.every((m) => m.resolved !== null));
});

test("runDesignChat executes automatic self-repair turn when initial model output fails validation", async () => {
  const doc = createStarter();
  const events: AgentProgressEvent[] = [];
  let attempt = 0;

  const fakeFetch: typeof fetch = async () => {
    attempt++;
    if (attempt === 1) {
      // First response fails: broken JSON / empty ops in generate mode
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: '{"mode":"generate","reply":"broken","artboards":[]}',
              },
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    // Repair turn succeeds!
    return new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                mode: "generate",
                reply: "已修复并生成 SaaS 数据卡片",
                summary: "新增 1 个数据卡片画板",
                artboards: [
                  {
                    type: "frame",
                    name: "SaaS 数据卡片",
                    style: {
                      width: 360,
                      height: 220,
                      layout: "column",
                      padding: 20,
                      gap: 12,
                      fill: "#ffffff",
                      radius: 16,
                    },
                    children: [
                      {
                        type: "text",
                        name: "指标名",
                        text: "本月活跃设计师",
                        style: { fontSize: 14, color: "#64748b" },
                      },
                      {
                        type: "text",
                        name: "指标值",
                        text: "12,840",
                        style: {
                          fontSize: 32,
                          fontWeight: 700,
                          color: "#0f172a",
                        },
                      },
                    ],
                  },
                ],
              }),
            },
          },
        ],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };

  const result = await runDesignChat(
    {
      prompt: "生成一个 SaaS 数据卡片",
      document: doc,
      selection: null,
    },
    {
      adapterConfig: {
        providerId: "openai",
        baseUrl: "https://api.openai.com/v1",
        apiKey: "sk-proj-test-repair",
        model: "gpt-4.1",
        capabilities: {
          ...inferModelCapabilities("openai", "openai-chat", "gpt-4.1"),
          supportsStreaming: false,
        },
      },
      providerName: "OpenAI",
      fetchImpl: fakeFetch,
      signal: new AbortController().signal,
      onProgress: (ev) => events.push(ev),
    },
  );

  assert.equal(attempt, 2);
  assert.ok(events.some((e) => e.stage === "repairing"));
  assert.equal(events.at(-1)?.stage, "done");
  assert.equal(result.mode, "generate");
  assert.equal(result.createdRootIds.length, 1);
  assert.ok(result.transaction);
  const nextDoc = transact(doc, result.transaction);
  assert.ok(nextDoc.nodes.some((n) => n.name === "SaaS 数据卡片"));
});

test("compileBlueprintToTransaction accepts raw Forma transactions seamlessly", () => {
  const doc = createStarter();
  const target = doc.nodes[0];
  const compiled = compileBlueprintToTransaction(
    {
      baseRevision: doc.revision,
      operations: [
        { type: "update", id: target.id, patch: { name: "Raw Tx Title" } },
      ],
    },
    { document: doc, selection: null },
  );
  assert.equal(compiled.mode, "edit");
  assert.equal(compiled.stats.updated, 1);
  assert.ok(compiled.transaction);
  const nextDoc = transact(doc, compiled.transaction);
  assert.equal(nextDoc.nodes[0].name, "Raw Tx Title");
});

test("named component and property-selected variant preserve protected child overrides through transaction replay", () => {
  const doc = createDocumentWithSystemAndLibrary();
  const button = doc.libraries!["lib-ui"].components[0];
  button.variants[0].nodes[0].type = "frame";
  const compact = structuredClone(button.variants[0]);
  compact.id = "compact";
  compact.name = "紧凑";
  compact.properties = { 尺寸: "小", 状态: "默认" };
  const frame = compact.nodes[0];
  frame.type = "frame";
  const title = {
    ...structuredClone(frame),
    id: "label",
    parentId: frame.id,
    templateKey: "title",
    type: "text" as const,
  };
  compact.nodes.push(title, {
    ...structuredClone(title),
    id: "secondary",
    templateKey: "subtitle",
  });
  button.variants.push(compact);
  const ctx = {
    prompt: "插入小号按钮",
    document: doc,
    selection: doc.nodes[0].id,
  };
  for (const tree of [true, false]) {
    const data = {
      componentId: "主按钮",
      variantProperties: { 尺寸: "小" },
      overrides: {
        text: "立即购买",
        textByTemplateKey: { subtitle: "限时优惠" },
        fill: "#123456",
        color: "#abcdef",
        opacity: 0.8,
      },
    };
    const bp = tree
      ? {
          artboards: [
            { type: "frame", children: [{ type: "component", ...data }] },
          ],
        }
      : {
          edits: [{ op: "insertComponent", parentId: ctx.selection, ...data }],
        };
    const compiled = compileBlueprintToTransaction(bp, ctx);
    assert.deepEqual(
      compiled.diagnostics.map((d) => d.code),
      ["component-name-resolved"],
    );
    const tx = validateProposal(ctx, compiled.transaction);
    const next = transact(doc, JSON.parse(JSON.stringify(tx)));
    assert.equal(next.revision, doc.revision + 1);
    const root = next.nodes.find((n) => n.instance)!;
    assert.equal(root.instance?.variantId, "compact");
    assert.equal(root.style.fill, "#123456");
    assert.equal(root.style.opacity, 0.8);
    const label = next.nodes.find(
      (n) => n.parentId === root.id && n.templateKey === "title",
    )!;
    assert.equal(label.text, "立即购买");
    assert.equal(label.style.color, "#abcdef");
    assert.equal(
      next.nodes.find(
        (n) => n.parentId === root.id && n.templateKey === "subtitle",
      )?.text,
      "限时优惠",
    );
    assert.equal(
      doc.nodes.some((n) => n.instance),
      false,
    );
  }
});

test("paint style applies to explicit stroke slot and collection modes remain node-local", () => {
  const doc = createDocumentWithSystemAndLibrary();
  doc.designSystem!.styles.brand = {
    id: "brand",
    name: "品牌",
    kind: "paint",
    description: "",
    properties: { fill: "#123456" },
    bindings: {},
  };
  const id = doc.nodes[0].id;
  const ctx = { prompt: "应用样式", document: doc, selection: id };
  const compiled = compileBlueprintToTransaction(
    {
      mode: "edit",
      edits: [
        { op: "applyStyle", id, slot: "stroke", styleId: "brand" },
        {
          op: "setVariableMode",
          id,
          collectionId: "col-theme",
          modeId: "mode-dark",
        },
        {
          op: "update",
          id,
          style: {
            strokeDash: "4 2",
            strokeSides: { top: 1, right: 2, bottom: 3, left: 4 },
            fontFamily: "Inter",
            fontStyle: "italic",
            textDecoration: "underline",
            textTransform: "uppercase",
            verticalAlign: "bottom",
            strokeAlign: "inside",
            strokeStyle: "dashed",
          },
        },
      ],
    },
    ctx,
  );
  const next = transact(doc, validateProposal(ctx, compiled.transaction));
  assert.deepEqual(compiled.diagnostics, []);
  assert.deepEqual(next.nodes[0].styleBindings, { stroke: "brand" });
  assert.equal(next.nodes[0].variableModes?.["col-theme"], "mode-dark");
  assert.equal(next.designSystem?.activeModes["col-theme"], "mode-light");
  assert.equal(next.nodes[0].style.strokeDash, "4 2");
  assert.equal(next.nodes[0].style.strokeSides?.left, 4);
  assert.equal(next.nodes[0].style.verticalAlign, "bottom");
});

test("each rejected component, variable, style, node, instance and selection reference is diagnosed", () => {
  const doc = createDocumentWithSystemAndLibrary(),
    id = doc.nodes[0].id;
  const edits = [
    { op: "update", id: "missing", patch: { name: "x" } },
    {
      op: "update",
      id: doc.nodes.find((n) => !n.parentId && n.id !== id)!.id,
      patch: { name: "outside" },
    },
    { op: "bindVariable", id, property: "padding", variableId: "var-radius" },
    { op: "bindVariable", id, property: "width", variableId: "var-primary" },
    { op: "bindVariable", id, property: "color", variableId: "missing" },
    { op: "applyStyle", id, slot: "stroke", styleId: "style-h1" },
    { op: "applyStyle", id, styleId: "missing" },
    { op: "insertComponent", componentId: "missing" },
    { op: "switchInstance", id, variantId: "missing" },
    { op: "swapInstance", id, componentId: "comp-btn" },
  ];
  const compiled = compileBlueprintToTransaction(
    { mode: "edit", edits },
    { document: doc, selection: id },
  );
  assert.equal(compiled.transaction, undefined);
  assert.equal(compiled.diagnostics.length, edits.length);
  assert.ok(compiled.diagnostics.every((d) => d.suggestion && d.message));
  assert.match(
    compiled.diagnostics.find((d) => d.code === "unknown-component")!
      .suggestion!,
    /comp-btn/,
  );
});

test("explicit detach unlocks a child layout edit in the same selected-subtree transaction", () => {
  const doc = createDocumentWithSystemAndLibrary();
  const variant = doc.libraries!["lib-ui"].components[0].variants[0];
  variant.nodes[0].type = "frame";
  variant.nodes.push({
    ...structuredClone(variant.nodes[0]),
    id: "label",
    parentId: variant.nodes[0].id,
    type: "text",
    templateKey: "label",
  });
  const inserted = compileBlueprintToTransaction(
    { edits: [{ op: "insertComponent", componentId: "comp-btn" }] },
    { document: doc, selection: null },
  );
  const current = transact(doc, inserted.transaction);
  const root = current.nodes.find((n) => n.instance)!;
  const child = current.nodes.find((n) => n.parentId === root.id)!;
  const ctx = {
    prompt: "分离并调整标签位置",
    document: current,
    selection: root.id,
  };
  const compiled = compileBlueprintToTransaction(
    {
      edits: [
        { op: "detachInstance", id: root.id },
        { op: "update", id: child.id, style: { x: 20 } },
      ],
    },
    ctx,
  );
  assert.deepEqual(compiled.diagnostics, []);
  const next = transact(current, validateProposal(ctx, compiled.transaction));
  assert.equal(next.nodes.find((n) => n.id === root.id)?.instance, undefined);
  assert.equal(next.nodes.find((n) => n.id === child.id)?.style.x, 20);
});

test("an exposed instance slot can be overridden on insertion, reset in selection and inspected after replay", () => {
  const base = createStarter(),
    root = createNode("frame"),
    title = createNode("text", root.id);
  title.text = "Profile";
  function badge(text: string) {
    const frame = createNode("frame"),
      label = createNode("text", frame.id);
    label.text = text;
    return createLibraryFromSelection(
      { ...base, nodes: [frame, label] },
      frame.id,
      text,
    );
  }
  const regular = badge("Member"),
    featured = badge("Featured");
  const author = { ...base, nodes: [root, title] };
  const placed = instantiateComponent(
    author,
    regular,
    "component",
    "default",
    root.id,
    { x: 8, y: 8 },
  );
  const master = transact(author, {
    baseRevision: author.revision,
    operations: placed.operations,
  });
  const panel = createLibraryFromSelection(master, root.id, "Profile");
  const component = panel.components[0],
    slot = component.variants[0].nodes.find((n) => n.nestedSlot)!;
  component.exposed = [
    { id: "badge", name: "Badge", kind: "swap", target: slot.templateKey! },
  ];
  const consumer = transact(base, {
    baseRevision: base.revision,
    operations: [panel, featured].map((library) => ({
      type: "putLibrary",
      library,
    })),
  });
  const context = {
    prompt: "插入并覆写徽章",
    document: consumer,
    selection: consumer.nodes[0].id,
  };
  const bp = {
    mode: "edit",
    edits: [
      {
        op: "insertComponent",
        componentId: component.id,
        libraryId: panel.id,
        overrides: {
          text: "账户",
          slots: {
            badge: { libraryId: featured.id, componentId: "component" },
          },
        },
      },
    ],
  };
  const compiled = compileBlueprintToTransaction(bp, context);
  assert.deepEqual(compiled.diagnostics, []);
  const next = transact(
    consumer,
    validateProposal(context, compiled.transaction),
  );
  const instance = next.nodes.find((n) => n.instance?.libraryId === panel.id)!;
  assert.equal(
    instance.instance?.slots?.[slot.templateKey!]?.libraryId,
    featured.id,
  );
  assert.ok(next.nodes.some((n) => n.text === "Featured"));
  assert.ok(next.nodes.some((n) => n.text === "账户"));
  const ctx = { ...context, document: next, selection: instance.id };
  const reset = compileBlueprintToTransaction(
    {
      edits: [
        {
          op: "setInstanceSlot",
          id: instance.id,
          property: "badge",
          value: null,
        },
      ],
    },
    ctx,
  );
  const restored = transact(next, validateProposal(ctx, reset.transaction));
  assert.ok(restored.nodes.some((n) => n.text === "Member"));
  assert.ok(!restored.nodes.some((n) => n.text === "Featured"));
});

test("multi-paint and explicit responsive grid properties survive validated Blueprint creation", () => {
  const doc = createStarter();
  const paints = [
    { id: "surface", visible: true, opacity: 0.8, color: "#123456" },
  ];
  const style = {
    layout: "grid",
    gridTracks: "1fr 2fr",
    gridRowTracks: "auto 32px",
    layoutBreakpoints: [{ maxWidth: 480, columns: 1 }],
    paints,
    strokePaints: paints,
  };
  const ctx = { prompt: "响应式网格", document: doc, selection: null };
  const result = compileBlueprintToTransaction(
    { artboards: [{ type: "frame", style }] },
    ctx,
  );
  const node = transact(
    doc,
    validateProposal(ctx, result.transaction),
  ).nodes.find((n) => n.id === result.createdRootIds[0])!;
  for (const [key, value] of Object.entries(style))
    assert.deepEqual(node.style[key as keyof typeof node.style], value);
});

test("real-world LLM style shorthands (strokeSides array/booleans, fill none, stroke-only shapes, CSS box arrays) compile safely", () => {
  const doc = createStarter();
  const ctx = { prompt: "移动端深色页", document: doc, selection: null };
  const result = compileBlueprintToTransaction(
    {
      artboards: [
        {
          type: "frame",
          name: "Root",
          style: {
            width: 390,
            height: 844,
            fill: "#111216",
            layout: "column",
            padding: [16, 20],
            corners: [24, 24, 0, 0],
          },
          children: [
            {
              type: "frame",
              name: "TabBar",
              style: {
                fill: "#181a20",
                stroke: "#2d313c",
                strokeWidth: 1,
                strokeSides: ["top"],
                paddingX: 16,
                paddingY: 10,
                strokeDash: 999, // malformed non-string should be ignored safely, not crash
              },
            },
            {
              type: "frame",
              name: "Divider",
              style: {
                fill: "none",
                stroke: "#c9965b",
                strokeWidth: 2,
                strokeSides: { bottom: true },
              },
            },
            {
              type: "ellipse",
              name: "DecorativeRing",
              style: {
                width: 80,
                height: 80,
                stroke: "#c9965b",
                strokeWidth: 1,
              },
            },
            {
              type: "ellipse",
              name: "FilledDot",
              style: {
                width: 12,
                height: 12,
                fill: "#c9965b",
              },
            },
          ],
        },
      ],
    },
    ctx,
  );
  assert.deepEqual(result.diagnostics, []);
  const next = transact(doc, validateProposal(ctx, result.transaction));
  const root = next.nodes.find((n) => n.id === result.createdRootIds[0])!;
  const tabBar = next.nodes.find((n) => n.name === "TabBar")!;
  const divider = next.nodes.find((n) => n.name === "Divider")!;
  const ring = next.nodes.find((n) => n.name === "DecorativeRing")!;
  const dot = next.nodes.find((n) => n.name === "FilledDot")!;

  assert.deepEqual(root.style.insets, {
    top: 16,
    right: 20,
    bottom: 16,
    left: 20,
  });
  assert.deepEqual(root.style.corners, { tl: 24, tr: 24, br: 0, bl: 0 });
  assert.deepEqual(tabBar.style.strokeSides, {
    top: 1,
    right: 0,
    bottom: 0,
    left: 0,
  });
  assert.deepEqual(tabBar.style.insets, {
    top: 10,
    right: 16,
    bottom: 10,
    left: 16,
  });
  assert.equal(tabBar.style.strokeDash, undefined);
  assert.equal(divider.style.fillOpacity, 0);
  assert.deepEqual(divider.style.strokeSides, {
    top: 0,
    right: 0,
    bottom: 2,
    left: 0,
  });
  assert.equal(ring.style.fillOpacity, 0);
  assert.equal(dot.style.fill, "#c9965b");
  assert.notEqual(dot.style.fillOpacity, 0);
});
