import { createServer } from "node:http";

export const modelId = "deepseek-flash";
export const craftId = "forma-design-system-craft";
export const instructions = "使用当前画板的间距变量，检查登录表单的标签。";
export const htmlPrompt = "新建一屏手冲咖啡订阅卡";
export const firstTitle = "早安手冲";
export const refinedTitle = "本周手冲精选";
export const critiqueNote = "卡片间距调整为 16 px。";
export const projectName = "淘宝移动端";
export const projectPrompt = "复用历史大促的尖货促销楼层";
export const isolationPrompt = "草稿项目切换前的预览";
export const libraryId = "tb-mobile";
export const libraryName = "淘宝移动端电商库（模拟）";
export const campaignPrompt =
  "为淘宝移动端设计大促完整购物流程，包含主会场和关联异常态，请规划页面范围。";
export const customNote = "\n  行话：开门红先上尖货池。  \n\n";
export const brand = "#ff5000";
export const screens = [
  {
    refId: "tb-home",
    name: "淘宝主会场",
    role: "primary",
    width: 390,
    height: 600,
    summary: "搜索商品并浏览促销楼层",
  },
  {
    refId: "tb-empty",
    name: "淘宝搜索空态",
    role: "exception",
    parentRef: "tb-home",
    width: 390,
    height: 320,
    summary: "没有搜索结果时展示缺省反馈",
  },
];
export const scopePlan = {
  reply: "请选择本次大促的页面范围。",
  summary: "生成主会场及关联搜索空态",
  screens,
  reusedAssets: ["顶部搜索导航栏", "搜索空状态"],
  customModules: ["尖货促销楼层"],
  decisions: [
    {
      question: "主推促销类型",
      defaultChoice: "秒杀",
      alternatives: ["满减"],
    },
  ],
};
const htmlBoards = screens.map(({ summary, ...board }, i) => ({
  ...board,
  html:
    i === 0
      ? `<main><div data-forma-component="tb-nav-search" data-overrides='{"textByTemplateKey":{"旧槽位":"促销"}}'></div><section data-forma-name="尖货促销楼层"><h2>满减专场</h2></section></main>`
      : '<main><div data-forma-component="tb-empty-state"></div></main>',
  css:
    "main{display:flex;flex-direction:column;width:100%;gap:16px}section{background:" +
    brand +
    ";height:96px;padding:16px;border-radius:12px}",
}));
export const campaignReviewNote = "促销楼层内边距已调整，空态补充无结果提示。";
const revisedBoards = htmlBoards.map((board, index) => ({
  ...board,
  css: board.css + "section{padding:24px}",
  html: index
    ? board.html.replace("</main>", "<p>换个关键词试试</p></main>")
    : board.html.replace(/ data-overrides='[^']*'/, ""),
}));
export const photo =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEElEQVR4nGNoD7EAIgYIBQAfXgRNqpqd+wAAAABJRU5ErkJggg==";

export function toolCall(name, args) {
  return {
    id: "qa-" + name,
    type: "function",
    function: { name, arguments: JSON.stringify(args) },
  };
}
export function shoppingLibrary() {
  const style = {
    x: 0,
    y: 0,
    width: 350,
    height: 48,
    fill: "#ffffff",
    color: "#202020",
    radius: 0,
    fontSize: 14,
    padding: 0,
    gap: 0,
    layout: "free",
  };
  const components = [
    ["tb-campaign-page", "频道首页样板", "page", "频道首页", 390, 600],
    ["tb-nav-search", "顶部搜索导航栏", "block", "搜索宝贝", 350, 48],
    ["tb-promo-btn", "主促按钮", "component", "立即抢购", 120, 40],
    ["tb-empty-state", "搜索空状态", "component", "暂无相关商品", 320, 120],
  ].map(([id, name, assetTier, text, width, height]) => {
    const root = {
      id: "root",
      templateKey: "root",
      type: "frame",
      parentId: null,
      name,
      text: "",
      hidden: false,
      locked: false,
      style: { ...style, width, height },
    };
    if (id === "tb-promo-btn") {
      root.style.fill = brand;
      root.variableBindings = { fill: "tb-brand" };
    }
    const label = {
      id: "label",
      templateKey: "label",
      type: "text",
      parentId: "root",
      name: "文案",
      text,
      hidden: false,
      locked: false,
      style: { ...style, x: 8, y: 8, width: width - 16, height: 24 },
    };
    const children = [label];
    if (id === "tb-nav-search") {
      children.push({
        ...label,
        id: "location",
        templateKey: "location",
        name: "当前定位",
        text: "杭州",
        style: { ...label.style, width: 48 },
      });
      label.style = { ...label.style, x: 64, width: width - 72 };
    }
    if (assetTier === "page") {
      children.push(
        {
          ...label,
          id: "search",
          templateKey: "search",
          name: "频道搜索",
          text: "搜索活动商品",
          style: { ...label.style, y: 48, height: 40, fill: "#f5f5f5" },
        },
        {
          ...label,
          id: "campaign",
          templateKey: "campaign",
          name: "主促楼层",
          text: "开门红满减专场",
          style: {
            ...label.style,
            y: 104,
            height: 96,
            fontSize: 24,
            fill: brand,
            radius: 12,
          },
          variableBindings: { fill: "tb-brand", radius: "tb-radius" },
        },
      );
    }
    const options =
      id === "tb-nav-search"
        ? ["日常态", "大促态"]
        : id === "tb-promo-btn"
          ? ["主按钮", "次按钮"]
          : ["默认"];
    return {
      id,
      name,
      category: "购物",
      assetTier,
      description: name,
      exposed: [{ id: "label", name: "文案", kind: "text", target: "label" }],
      variants: options.map((name, index) => ({
        id: index ? "alternate" : "default",
        name,
        properties: options.length > 1 ? { State: name } : {},
        nodes: [
          index
            ? {
                ...root,
                style: { ...root.style, fill: "#fff1e6" },
                variableBindings: undefined,
              }
            : root,
          ...children,
        ],
      })),
    };
  });
  return {
    format: "forma/library",
    version: 1,
    id: libraryId,
    name: libraryName,
    description: "移动购物与促销",
    revision: 1,
    source: { name: "Forma 测试", license: "测试夹具" },
    components,
    designSystem: {
      collections: {
        tb: {
          id: "tb",
          name: "淘宝品牌语义色",
          defaultModeId: "light",
          modes: [{ id: "light", name: "浅色" }],
        },
      },
      variables: {
        "tb-radius": {
          id: "tb-radius",
          name: "楼层圆角",
          collectionId: "tb",
          type: "number",
          scopes: ["radius"],
          values: { light: 12 },
        },
        "tb-brand": {
          id: "tb-brand",
          name: "品牌主色",
          collectionId: "tb",
          type: "color",
          scopes: ["fill"],
          values: { light: brand },
        },
      },
      styles: {},
      activeModes: { tb: "light" },
    },
  };
}

export async function contrastWhenVisible(container, selector) {
  return container.evaluate(async (root, selector) => {
    // Observe the actual extraction status: a tiny invalid input can finish within a frame.
    const element =
      root.querySelector(selector) ??
      (await new Promise((resolve, reject) => {
        const observer = new MutationObserver(() => {
          const found = root.querySelector(selector);
          if (found) {
            clearTimeout(timer);
            observer.disconnect();
            resolve(found);
          }
        });
        const timer = setTimeout(() => {
          observer.disconnect();
          reject(Error("Missing contrast sample " + selector));
        }, 8000);
        observer.observe(root, { childList: true, subtree: true });
      }));
    const rgb = (css) => css.match(/[.\d]+/g).map(Number);
    let bg;
    for (let node = element; node; node = node.parentElement) {
      const color = rgb(getComputedStyle(node).backgroundColor);
      if (color[3] === 0) continue;
      if ((color[3] ?? 1) !== 1)
        throw Error("Expected opaque status background");
      bg = color;
      break;
    }
    const luminance = (color) =>
      color.slice(0, 3).reduce((sum, channel, i) => {
        const c = channel / 255;
        return (
          sum +
          [0.2126, 0.7152, 0.0722][i] *
            (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
        );
      }, 0);
    const fg = luminance(rgb(getComputedStyle(element).color)),
      back = luminance(bg);
    return (Math.max(fg, back) + 0.05) / (Math.min(fg, back) + 0.05);
  }, selector);
}

export function coffeeDesign(refined) {
  return {
    name: "手冲订阅",
    width: 320,
    height: 240,
    summary: refined ? "手冲订阅精修稿" : "手冲订阅初稿",
    reply: refined ? critiqueNote : "请预览手冲订阅卡。",
    html: `<article data-forma-name="咖啡卡片"><span data-icon="coffee"></span><img src="${photo}" alt="咖啡配图"><h2>${refined ? refinedTitle : firstTitle}</h2></article>`,
    css: `article{display:flex;flex-direction:column;width:320px;height:240px;padding:16px;gap:${refined ? 16 : 8}px;background:#f2dfc8;color:#392720}img{width:80px;height:48px;object-fit:cover}h2{font-size:20px}`,
  };
}
export function respondToModel(res, stream, tool_calls, content) {
  const message = tool_calls.length ? { tool_calls } : { content };
  const finish_reason = tool_calls.length ? "tool_calls" : "stop";
  if (stream) {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const delta = tool_calls.length
      ? {
          tool_calls: tool_calls.map((item, index) => ({ ...item, index })),
        }
      : message;
    res.write(
      `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
    );
    res.end("data: [DONE]\n\n");
  } else {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message, finish_reason }] }));
  }
}

export async function createMockProvider() {
  const controls = {
    isolationRoot: undefined,
    projectFixture: undefined,
    delayedConfirmation: undefined,
    critiqueGate: Promise.withResolvers(),
    modelReads: 0,
  };
  const receivedRounds = [];
  const projectRounds = [];
  const campaignRounds = [];
  const campaignScreenshots = [];
  const upstreamScreenshots = [];
  async function campaignModel(body, res, tools, results) {
    if (!tools.includes("get_canvas_overview")) {
      const parts = body.messages.find((m) => m.role === "user")?.content;
      campaignScreenshots.push(
        (Array.isArray(parts) ? parts : [])
          .filter((p) => p.type === "image_url")
          .map((p) => p.image_url.url),
      );
      respondToModel(
        res,
        body.stream,
        [
          toolCall("propose_html_design", {
            reply: campaignReviewNote,
            artboards: revisedBoards,
          }),
        ],
        campaignReviewNote,
      );
      return;
    }
    const message = body.messages.findLast(
      (m) =>
        m.role === "user" &&
        typeof m.content === "string" &&
        m.content.includes("Context (JSON)\n"),
    );
    if (!message) {
      res.writeHead(422).end("Missing shopping context");
      return;
    }
    const ctx = JSON.parse(message.content.split("Context (JSON)\n").at(-1));
    const toolResult = results.length
      ? JSON.parse(results.at(-1).content)
      : null;
    campaignRounds.push({ tools, ctx, toolResult });
    if (ctx.confirmedScope && controls.delayedConfirmation) {
      controls.delayedConfirmation.received.resolve();
      await controls.delayedConfirmation.resume.promise;
      if (res.destroyed) return;
    }
    const calls = ctx.confirmedScope
      ? results.length
        ? []
        : [
            toolCall("propose_html_design", {
              reply: "两张画板已就绪。",
              artboards: htmlBoards,
            }),
          ]
      : results.length
        ? [toolCall("propose_scope_plan", scopePlan)]
        : [toolCall("get_library_playbook", { libraryId })];
    respondToModel(res, body.stream, calls, "两张购物画板已就绪。");
  }

  const mockServer = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    if (req.url === "/v1/models" && req.method === "GET") {
      controls.modelReads++;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          data: [
            {
              id: modelId,
              name: "DeepSeek-V4.1-Flash",
              context_window: 1000000,
              max_output_tokens: 393216,
              input_modalities: ["text", "image"],
            },
          ],
        }),
      );
      return;
    }
    if (req.url === "/v1/chat/completions" && req.method === "POST") {
      const blueprint = {
        mode: "generate",
        reply: "已根据您的需求生成深色主题 H5 登录页，采用自动布局与圆角卡片。",
        summary: "新增 H5 登录页（含标题、表单卡片与登录按钮）",
        artboards: [
          {
            refId: "ai-h5-login",
            type: "frame",
            name: "AI 生成 · H5 登录页",
            style: {
              width: 390,
              height: 844,
              layout: "column",
              padding: 24,
              gap: 20,
              fill: "#0F172A",
              radius: 24,
            },
            children: [
              {
                type: "text",
                name: "登录标题",
                text: "欢迎回到 Forma",
                style: {
                  fontSize: 28,
                  fontWeight: 700,
                  color: "#F8FAFC",
                  widthMode: "fill",
                  heightMode: "hug",
                },
              },
              {
                type: "frame",
                name: "表单卡片",
                style: {
                  layout: "column",
                  padding: 20,
                  gap: 14,
                  fill: "#1E293B",
                  radius: 16,
                  widthMode: "fill",
                  heightMode: "hug",
                },
                children: [
                  {
                    type: "text",
                    name: "邮箱标签",
                    text: "工作邮箱",
                    style: {
                      fontSize: 13,
                      color: "#94A3B8",
                      widthMode: "fill",
                      heightMode: "hug",
                    },
                  },
                  {
                    type: "button",
                    name: "主登录按钮",
                    text: "立即登录",
                    style: {
                      widthMode: "fill",
                      height: 46,
                      fill: "#0D99FF",
                      color: "#FFFFFF",
                      radius: 12,
                      fontSize: 15,
                      fontWeight: 600,
                    },
                  },
                ],
              },
            ],
          },
        ],
      };
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const tools = body.tools?.map((tool) => tool.function.name) ?? [];
      const results = body.messages.filter((m) => m.role === "tool");
      // The latest user turn identifies the scenario. Recalled campaign titles
      // also occur in the user context of the second file.
      const userTurn = body.messages.findLast(
        (message) =>
          message.role === "user" &&
          typeof message.content === "string" &&
          message.content.includes("Context (JSON)\n"),
      );
      const requestText = userTurn?.content.split("Context (JSON)\n")[0] ?? "";
      if (controls.isolationRoot && requestText.includes(isolationPrompt)) {
        respondToModel(
          res,
          body.stream,
          results.length
            ? []
            : [
                toolCall("propose_design_changes", {
                  mode: "edit",
                  reply: isolationPrompt,
                  operations: [
                    {
                      type: "update",
                      id: controls.isolationRoot,
                      patch: { name: isolationPrompt },
                    },
                  ],
                }),
              ],
          isolationPrompt,
        );
        return;
      }
      if (controls.projectFixture && requestText.includes(projectPrompt)) {
        const ctx = JSON.parse(
          userTurn.content.split("Context (JSON)\n").at(-1),
        );
        const result = results.length
          ? JSON.parse(results.at(-1).content)
          : null;
        projectRounds.push({
          ctx,
          system: body.messages
            .filter((m) => m.role === "system")
            .map((m) => m.content)
            .join("\n"),
          tools,
          result,
        });
        const calls = [
          toolCall("search_project_episodes", { query: "尖货促销楼层" }),
          toolCall("get_episode_details", {
            episodeId: controls.projectFixture.episodeId,
          }),
          toolCall("propose_design_changes", {
            mode: "generate",
            reply: "已复用项目模块",
            operations: [
              {
                type: "insertComponent",
                libraryId: controls.projectFixture.libraryId,
                componentId: controls.projectFixture.componentId,
                variantId: controls.projectFixture.variantId,
                parentId: null,
                position: { x: 40, y: 40 },
              },
            ],
          }),
        ];
        respondToModel(
          res,
          body.stream,
          calls[results.length] ? [calls[results.length]] : [],
          "请预览项目模块",
        );
        return;
      }
      if (JSON.stringify(body.messages).includes(campaignPrompt)) {
        await campaignModel(body, res, tools, results);
        return;
      }
      if (JSON.stringify(body.messages).includes(htmlPrompt)) {
        if (body.model !== modelId || !tools.includes("propose_html_design")) {
          res.writeHead(422).end("HTML proposal tool missing");
          return;
        }
        const critique = !tools.includes("get_canvas_overview");
        if (critique) {
          const parts = body.messages.find((m) => m.role === "user")?.content;
          const screenshot =
            Array.isArray(parts) &&
            parts.find((p) => p.type === "image_url")?.image_url?.url;
          upstreamScreenshots.push(screenshot);
          await controls.critiqueGate.promise;
        }
        const calls = results.length
          ? []
          : [
              {
                id: critique ? "qa-html-refine" : "qa-html-draft",
                type: "function",
                function: {
                  name: "propose_html_design",
                  arguments: JSON.stringify(coffeeDesign(critique)),
                },
              },
            ];
        respondToModel(res, body.stream, calls, "手冲订阅初稿已就绪。");
        return;
      }
      const advertised = [
        "get_canvas_overview",
        "activate_skill",
        "propose_design_changes",
      ];
      if (
        body.model !== modelId ||
        !advertised.every((name) => tools.includes(name)) ||
        (receivedRounds.length < 3 &&
          !JSON.stringify(body.messages).includes(instructions))
      ) {
        res.writeHead(422);
        res.end(
          "Expected Forma tools and the explicitly selected Skill instructions",
        );
        return;
      }
      const call = (id, name, args) => ({
        id,
        type: "function",
        function: { name, arguments: JSON.stringify(args) },
      });
      const ids = results.map((m) => m.tool_call_id);
      const expected = ["qa-overview", "qa-craft", "qa-propose"];
      if (
        ![0, 2, 3].includes(ids.length) ||
        !ids.every((id, i) => id === expected[i]) ||
        results.some((m) => !JSON.parse(m.content).ok)
      ) {
        res.writeHead(422);
        res.end("Unexpected tool results");
        return;
      }
      receivedRounds.push(ids);
      const tool_calls =
        results.length === 0
          ? [
              call(expected[0], advertised[0], {}),
              call(expected[1], advertised[1], { name: craftId }),
            ]
          : results.length === 2
            ? [call(expected[2], advertised[2], blueprint)]
            : [];
      respondToModel(res, body.stream, tool_calls, "登录页已准备好供预览。");
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise((resolve, reject) => {
    mockServer.once("error", reject);
    mockServer.listen(0, "127.0.0.1", resolve);
  });
  const port = mockServer.address().port;
  const mockBaseUrl = `http://127.0.0.1:${port}/v1`;
  return {
    mockServer,
    mockBaseUrl,
    controls,
    receivedRounds,
    projectRounds,
    campaignRounds,
    campaignScreenshots,
    upstreamScreenshots,
  };
}
