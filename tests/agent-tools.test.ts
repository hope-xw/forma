import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { SkillRegistry } from "../server/skill-registry";
import {
  createModelAdapter,
  type AdapterConfig,
  type AdapterMessage,
} from "../src/agent/adapters";
import { inferModelCapabilities } from "../src/agent/capabilities";
import { runDesignChat, runVisualCritique } from "../src/agent/design-engine";
import {
  getFormaToolDefinitions,
  FormaToolExecutor,
  type SkillRuntimeProvider,
} from "../src/agent/forma-tools";
import {
  computeArtboardPlacement,
  buildDesignContextPayload,
  buildDesignSystemPrompt,
  buildToolModeSystemPrompt,
} from "../src/agent/context-builder";
import { nativeDesignSystem } from "../src/design-system/tokens";
import { createNode, parseDocument } from "../src/domain/document";
import { createStarter } from "../src/domain/seed";
import { createLibraryFromSelection } from "../src/domain/library";
import { transact } from "../src/domain/commands";
import { resolveVariable } from "../src/domain/design-system";
import { validateProposal } from "../src/agent/provider";
import type { ProviderProtocol } from "../src/agent/provider-registry";
import { searchToolbarBlueprint } from "./fixtures/agent-search-toolbar";

const signal = new AbortController().signal;
const json = (value: unknown) =>
  new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
  });
const sse = (events: unknown[]) =>
  new Response(
    events.map((e) => "data: " + JSON.stringify(e) + "\r\n\r\n").join("") +
      "data: [DONE]\n\n",
    { headers: { "content-type": "text/event-stream" } },
  );
const openAI = (message: unknown) => json({ choices: [{ message }] });
const toolCall = (id: string, name: string, args: unknown) => ({
  id,
  type: "function",
  function: { name, arguments: JSON.stringify(args) },
});
const protocolInfo = {
  "openai-chat": ["openai", "gpt-4.1"],
  "anthropic-messages": ["anthropic", "claude-sonnet-4-5"],
  "gemini-native": ["gemini", "gemini-2.5-pro"],
};
function config(
  protocol: ProviderProtocol = "openai-chat",
  streaming = false,
): AdapterConfig {
  const [providerId, model] = protocolInfo[protocol];
  return {
    providerId,
    model,
    baseUrl: "https://gateway.invalid",
    apiKey: "",
    capabilities: {
      ...inferModelCapabilities(providerId, protocol, model),
      supportsStreaming: streaming,
    },
  };
}
function fixture() {
  const base = createStarter(),
    root = createNode("frame"),
    label = createNode("text", root.id);
  root.name = "Checkout";
  label.name = "Title";
  label.text = "Buy";
  const lib = createLibraryFromSelection(
    { ...base, nodes: [root, label] },
    root.id,
    "商店",
  );
  const doc = parseDocument({
    ...base,
    designSystem: nativeDesignSystem(),
    libraries: { [lib.id]: lib },
  });
  return {
    ctx: {
      document: doc,
      selection: doc.nodes[0].id,
      prompt: "使用已有组件和变量设计结账按钮",
    },
    lib: doc.libraries![lib.id],
  };
}

const names = ["search_nodes", "get_canvas_overview"];
const requestTools = getFormaToolDefinitions({ hasSkills: true });
const callId = ["one", "two"];
const args = [{ query: "订单" }, {}];
const sharedCalls = names.map((name, i) => toolCall(callId[i], name, args[i]));
function reply(protocol: ProviderProtocol, streaming: boolean) {
  switch (protocol) {
    case "openai-chat":
      return streaming
        ? sse([
            {
              choices: [
                {
                  delta: {
                    reasoning_content: "internal",
                    tool_calls: [
                      {
                        index: 1,
                        id: "t",
                        function: { name: "get_canvas_", arguments: "{" },
                      },
                      {
                        index: 0,
                        id: "o",
                        function: { name: "search_", arguments: '{"query":' },
                      },
                    ],
                  },
                },
              ],
            },
            {
              choices: [
                {
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        id: "ne",
                        function: { name: "nodes", arguments: '"订单"}' },
                      },
                      {
                        index: 1,
                        id: "wo",
                        function: { name: "overview", arguments: "}" },
                      },
                    ],
                  },
                  finish_reason: "tool_calls",
                },
              ],
            },
          ])
        : json({
            choices: [
              {
                message: {
                  content: null,
                  reasoning_content: "internal",
                  tool_calls: sharedCalls,
                },
                finish_reason: "tool_calls",
              },
            ],
          });
    case "anthropic-messages": {
      const blocks = names.map((name, i) => ({
        type: "tool_use",
        id: callId[i],
        name,
        input: args[i],
      }));
      return streaming
        ? sse([
            ...blocks.map((b, index) => ({
              type: "content_block_start",
              index,
              content_block: { ...b, input: {} },
            })),
            {
              type: "content_block_delta",
              index: 0,
              delta: { type: "input_json_delta", partial_json: '{"query":' },
            },
            {
              type: "content_block_delta",
              index: 1,
              delta: { type: "input_json_delta", partial_json: "{}" },
            },
            {
              type: "content_block_delta",
              index: 0,
              delta: { type: "input_json_delta", partial_json: '"订单"}' },
            },
            {
              type: "message_delta",
              delta: { stop_reason: "tool_use" },
              usage: { output_tokens: 32 },
            },
          ])
        : json({ content: blocks, stop_reason: "tool_use" });
    }
    case "gemini-native": {
      const parts = names.map((name, i) => ({
        functionCall: { name, args: args[i] },
        ...(i === 0 && { thoughtSignature: "signature" }),
      }));
      return streaming
        ? sse(
            parts.map((part, i) => ({
              candidates: [
                {
                  content: { parts: [part] },
                  ...(i === 1 && { finishReason: "STOP" }),
                },
              ],
            })),
          )
        : json({ candidates: [{ content: { parts }, finishReason: "STOP" }] });
    }
  }
}

for (const protocol of Object.keys(protocolInfo) as ProviderProtocol[])
  for (const streaming of [false, true]) {
    test(
      protocol +
        " " +
        (streaming ? "SSE" : "JSON") +
        " preserves parallel native calls and replays matched results",
      async () => {
        const cfg = config(protocol, streaming);
        const bodies: Record<string, any>[] = [];
        const adapter = createModelAdapter(cfg, async (_url, init) => {
          bodies.push(JSON.parse(String(init?.body)));
          return reply(protocol, streaming && bodies.length === 1);
        });
        const messages: AdapterMessage[] = [
          { role: "user", text: "inspect canvas" },
        ];
        const request = {
          messages,
          tools: requestTools,
          toolChoice: "required" as const,
          jsonSchema: { name: "legacy", schema: { type: "object" } },
        };
        const deltas: string[] = [];
        const result = streaming
          ? await adapter.stream(request, (piece) => deltas.push(piece), signal)
          : await adapter.complete(request, signal);
        assert.equal(result.text, "");
        assert.deepEqual(deltas, []);
        assert.equal(result.structuredModeUsed, "tool_call");
        assert.ok(result.finishReason);
        const calls = result.toolCalls!;
        assert.deepEqual(
          calls.map((c) => c.name),
          names,
        );
        assert.deepEqual(
          calls.map((c) => JSON.parse(c.arguments)),
          args,
        );
        assert.equal(new Set(calls.map((c) => c.id)).size, 2);
        if (protocol !== "gemini-native")
          assert.deepEqual(
            calls.map((c) => c.id),
            callId,
          );
        const results = calls.map((c, i) => ({
          role: "tool" as const,
          toolName: c.name,
          toolCallId: c.id,
          text: JSON.stringify({ count: i }),
        }));
        await adapter.complete(
          {
            ...request,
            messages: [
              ...messages,
              {
                role: "assistant",
                text: result.text,
                toolCalls: calls,
                reasoningContent: result.reasoningContent,
                geminiParts: result.geminiParts,
              },
              ...results,
            ],
          },
          signal,
        );
        const [first, second] = bodies;
        if (protocol === "openai-chat") {
          assert.equal(first.response_format, undefined);
          assert.equal(first.tool_choice, "required");
          assert.deepEqual(
            first.tools,
            requestTools.map((t) => ({ type: "function", function: t })),
          );
          assert.deepEqual(second.messages[1].tool_calls, sharedCalls);
          assert.equal(second.messages[1].reasoning_content, "internal");
          assert.deepEqual(
            second.messages.slice(2),
            results.map((r) => ({
              role: "tool",
              tool_call_id: r.toolCallId,
              content: r.text,
            })),
          );
        } else if (protocol === "anthropic-messages") {
          assert.deepEqual(first.tool_choice, { type: "any" });
          assert.deepEqual(
            first.tools,
            requestTools.map((t) => ({
              name: t.name,
              description: t.description,
              input_schema: t.parameters,
            })),
          );
          assert.deepEqual(
            second.messages[1].content,
            names.map((name, i) => ({
              type: "tool_use",
              id: callId[i],
              name,
              input: args[i],
            })),
          );
          assert.equal(second.messages.length, 3);
          assert.deepEqual(second.messages[2], {
            role: "user",
            content: results.map((r) => ({
              type: "tool_result",
              tool_use_id: r.toolCallId,
              content: r.text,
            })),
          });
        } else {
          assert.equal(first.generationConfig.responseMimeType, undefined);
          assert.deepEqual(first.toolConfig, {
            functionCallingConfig: { mode: "ANY" },
          });
          assert.deepEqual(
            first.tools[0].functionDeclarations.map(
              (t: { name: string }) => t.name,
            ),
            requestTools.map((t) => t.name),
          );
          assert.equal(second.contents[1].role, "model");
          assert.equal(
            second.contents[1].parts[0].thoughtSignature,
            "signature",
          );
          assert.deepEqual(
            second.contents[1].parts.map(
              (p: { functionCall: unknown }) => p.functionCall,
            ),
            names.map((name, i) => ({ name, args: args[i] })),
          );
          assert.deepEqual(second.contents[2], {
            role: "user",
            parts: names.map((name, i) => ({
              functionResponse: { name, response: { count: i } },
            })),
          });
        }
      },
    );
  }

test("model explores components and variables, gets actionable rejection and resubmits one complete atomic proposal", async () => {
  const { ctx, lib } = fixture();
  const original = JSON.stringify(ctx.document),
    seen: string[] = [];
  const component = lib.components[0];
  const edits = (componentId: string) => [
    { op: "update", id: ctx.selection, patch: { name: "结账" } },
    {
      op: "insertComponent",
      libraryId: lib.id,
      componentId,
      overrides: { text: "支付" },
    },
    {
      op: "bindVariable",
      id: ctx.selection,
      property: "fill",
      variableId: "color-accent",
    },
  ];
  let round = 0;
  const callbacks: string[] = [];
  const result = await runDesignChat(ctx, {
    adapterConfig: config(),
    providerName: "Test",
    signal,
    onProgress: (e) => callbacks.push(e.message),
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      assert.ok(body.tools?.length);
      const responses = body.messages
        .filter((m: { role: string }) => m.role === "tool")
        .map((m: { content: string }) => JSON.parse(m.content));
      switch (round++) {
        case 0:
          return openAI({
            tool_calls: [
              toolCall("lookup", "search_components", { query: "Checkout" }),
              toolCall("tokens", "get_design_system", {
                kind: "variables",
                query: "color-accent",
              }),
            ],
          });
        case 1:
          assert.equal(responses[0].components[0].componentId, component.id);
          assert.equal(responses[1].variables[0].id, "color-accent");
          return openAI({
            tool_calls: [
              toolCall("broken", "propose_design_changes", {
                mode: "edit",
                reply: "提交",
                edits: edits("wrong-id"),
              }),
            ],
          });
        case 2:
          assert.equal(responses[2].ok, false);
          assert.match(responses[2].error, /wrong-id/);
          assert.match(
            responses[2].diagnostics[0].suggestion,
            new RegExp(component.id),
          );
          seen.push(responses[2].diagnostics[0].code);
          return openAI({
            tool_calls: [
              toolCall("fixed", "propose_design_changes", {
                mode: "edit",
                reply: "按钮已就绪",
                edits: edits(component.id),
              }),
            ],
          });
        case 3:
          assert.equal(responses[3].ok, true);
          assert.deepEqual(responses[3].diagnostics, []);
          return openAI({ content: "已完成" });
        default:
          throw new Error("unexpected round");
      }
    },
  });
  assert.deepEqual(seen, ["unknown-component"]);
  assert.deepEqual(
    result.toolTrace?.map((t) => t.status),
    ["ok", "ok", "error", "ok"],
  );
  assert.ok(result.toolTrace?.every((t) => t.durationMs >= 0));
  assert.ok(callbacks.some((s) => s.includes("检索组件")));
  assert.ok(callbacks.some((s) => s.includes("校验设计事务")));
  assert.equal(JSON.stringify(ctx.document), original);
  const next = transact(
    ctx.document,
    validateProposal(ctx, result.transaction),
  );
  assert.equal(next.revision, ctx.document.revision + 1);
  assert.equal(next.nodes[0].name, "结账");
  assert.equal(next.nodes[0].variableBindings?.fill, "color-accent");
  assert.ok(next.nodes.find((n) => n.text === "支付" && n.templateKey));
});

test("rejects entire mixed or raw proposal outside the selection and returns the scope to the model", async () => {
  const { ctx } = fixture(),
    outside = ctx.document.nodes.find(
      (n) => !n.parentId && n.id !== ctx.selection,
    )!;
  const executor = new FormaToolExecutor(ctx);
  const data = { mode: "edit", reply: "修改画板" };
  const update = { type: "update", id: outside.id, patch: { name: "越界" } };
  for (const body of [
    {
      ...data,
      edits: [
        { op: "update", id: ctx.selection, patch: { name: "局部" } },
        update,
      ],
    },
    { ...data, operations: [update] },
  ]) {
    const result = executor.execute("propose_design_changes", body);
    assert.equal(result.ok, false);
    assert.match(String(result.error), /选区/);
    assert.equal(result.editableSelectionId, ctx.selection);
    assert.equal(executor.latestProposal, undefined);
  }
});

const skill = {
  id: "local-brand",
  name: "brand-craft",
  description: "品牌配色规范",
  source: "workspace" as const,
};
const resource = "references/colors.json";
const skillProvider: SkillRuntimeProvider = {
  listEnabledSkills: () => [skill],
  activateSkill: (id) =>
    id === skill.id
      ? {
          ...skill,
          instructions: "Use the brand's Pine palette.",
          resources: [resource],
          hasScripts: true,
        }
      : null,
  readSkillResource: (id, path) =>
    id === skill.id && path === resource
      ? { path, content: '{"pine":"#124536"}' }
      : null,
};

test("skills disclose catalog, instructions and exact resource in successive model turns", async () => {
  const { ctx } = fixture();
  const executor = new FormaToolExecutor(ctx, skillProvider);
  assert.equal(
    executor.execute("read_skill_resource", {
      name: skill.name,
      path: resource,
    }).ok,
    false,
  );
  let turn = 0;
  const result = await runDesignChat(ctx, {
    adapterConfig: config(),
    providerName: "Test",
    signal,
    skillProvider,
    fetchImpl: async (_url, init) => {
      const b = JSON.parse(String(init?.body));
      const last = b.messages.at(-1);
      if (turn++ === 0) {
        assert.match(b.messages[0].content, /品牌配色规范/);
        assert.doesNotMatch(b.messages[0].content, /Pine palette|124536/);
        return openAI({
          tool_calls: [
            toolCall("activate", "activate_skill", { name: skill.name }),
          ],
        });
      }
      if (turn === 2) {
        const payload = JSON.parse(last.content);
        assert.match(payload.instructions, /Pine palette/);
        assert.deepEqual(payload.resources, [resource]);
        assert.doesNotMatch(last.content, /124536/);
        return openAI({
          tool_calls: [
            toolCall("read", "read_skill_resource", {
              name: skill.id,
              path: resource,
            }),
          ],
        });
      }
      assert.match(JSON.parse(last.content).content, /124536/);
      return openAI({ content: "品牌松绿色为 #124536。" });
    },
  });
  assert.equal(result.mode, "answer");
  assert.deepEqual(result.activatedSkills, [skill.id]);
  assert.deepEqual(
    result.toolTrace?.map((t) => t.name),
    ["activate_skill", "read_skill_resource"],
  );
  assert.equal(executor.execute("activate_skill", { name: skill.id }).ok, true);
  assert.equal(
    executor.execute("read_skill_resource", {
      name: skill.id,
      path: "references/../private.txt",
    }).ok,
    false,
  );
});

test("first upstream HTTP 400 falls back once, keeps selected skill and repairs invalid Blueprint", async () => {
  const { ctx } = fixture();
  let turn = 0;
  const result = await runDesignChat(
    { ...ctx, activeSkills: [skill.name] },
    {
      adapterConfig: config(),
      providerName: "Test",
      signal,
      skillProvider,
      fetchImpl: async (_url, init) => {
        const b = JSON.parse(String(init?.body));
        assert.match(b.messages[0].content, /Pine palette/);
        assert.match(b.messages[0].content, /Never output HTML\/CSS\/Tailwind/);
        assert.match(b.messages[0].content, /without pausing/);
        assert.match(b.messages[0].content, /references\/colors\.json/);
        assert.match(b.messages[0].content, /search_skill_resources/);
        if (++turn === 1) {
          assert.ok(b.tools);
          return new Response("unsupported tools", { status: 400 });
        }
        assert.equal(b.tools, undefined);
        assert.equal(b.response_format.type, "json_schema");
        if (turn === 2)
          return openAI({
            content: JSON.stringify({
              mode: "edit",
              edits: [{ op: "update", id: "bad-node", patch: { text: "x" } }],
            }),
          });
        assert.match(b.messages.at(-1).content, /bad-node/);
        return openAI({
          content: JSON.stringify({
            mode: "edit",
            edits: [
              { op: "update", id: ctx.selection, patch: { name: "修复成功" } },
            ],
          }),
        });
      },
    },
  );
  assert.equal(turn, 3);
  assert.deepEqual(result.activatedSkills, [skill.id]);
  assert.deepEqual(result.diagnostics, []);
  assert.equal(
    transact(ctx.document, result.transaction).nodes[0].name,
    "修复成功",
  );
});

test("activated community CSV palette drives a native artboard through the model tool loop", async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "forma-palette-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const registry = new SkillRegistry({
    configDir: dir,
    workspaceDir: dir,
    externalDirs: [],
  });
  const name = "palette-guide",
    file = "data/colors.csv";
  registry.importSkill({
    skillMd:
      "---\nname: palette-guide\ndescription: Choose brand palettes\n---\nRun python scripts/search.py, ask for confirmation and write CSS.",
    resources: [
      {
        path: file,
        content:
          'Name,Surface,Ink\nOcean,#003344,#FFFFFF\n"Forest, dusk",#123C2A,#F5F7F2',
      },
    ],
  });
  const ctx = {
    ...fixture().ctx,
    selection: null,
    prompt: "用 Forest dusk 色板做一张首页画板",
  };
  const runtime = registry.asRuntimeProvider();
  let turn = 0;
  const result = await runDesignChat(ctx, {
    adapterConfig: config(),
    providerName: "Test",
    signal,
    skillProvider: runtime,
    fetchImpl: async (_url, init) => {
      const b = JSON.parse(String(init?.body));
      const call = (tool: string, args: unknown) =>
        openAI({ tool_calls: [toolCall(tool, tool, args)] });
      if (++turn === 1) {
        assert.doesNotMatch(
          b.messages[0].content,
          /123C2A|scripts\/search\.py/,
        );
        return call("activate_skill", { name });
      }
      const response = JSON.parse(b.messages.at(-1).content);
      assert.equal(response.ok, true, JSON.stringify(response));
      if (turn === 2) {
        assert.equal(response.compatibility.level, "adapted");
        assert.match(response.formaAdaptationNote, /propose_design_changes/);
        assert.deepEqual(response.resources, [file]);
        return call("search_skill_resources", {
          name,
          query: "forest dusk",
          pathPrefix: "data/colors",
          limit: 1,
        });
      }
      if (turn === 3) {
        assert.equal(response.searchedFiles, 1);
        const [match] = response.matches;
        assert.equal(match.location, "row 3");
        return call("propose_design_changes", {
          mode: "generate",
          reply: "已采用森林色板生成首页。",
          artboards: [
            {
              type: "frame",
              name: match.record.Name,
              style: { width: 390, height: 844, fill: match.record.Surface },
              children: [
                {
                  type: "text",
                  name: "Title",
                  text: "林间漫步",
                  style: { color: match.record.Ink },
                },
              ],
            },
          ],
        });
      }
      assert.equal(turn, 4);
      return openAI({ content: "画板已生成。" });
    },
  });
  assert.deepEqual(
    result.toolTrace?.map((item) => [item.name, item.status]),
    [
      ["activate_skill", "ok"],
      ["search_skill_resources", "ok"],
      ["propose_design_changes", "ok"],
    ],
  );
  assert.deepEqual(result.activatedSkills, [name]);
  const doc = transact(ctx.document, validateProposal(ctx, result.transaction));
  const root = doc.nodes.find((n) => n.name === "Forest, dusk")!;
  assert.equal(root.style.fill, "#123c2a");
  assert.equal(
    doc.nodes.find((n) => n.parentId === root.id && n.text === "林间漫步")
      ?.style.color,
    "#f5f7f2",
  );

  let activations = 0;
  const fresh = registry.asRuntimeProvider();
  const executor = new FormaToolExecutor(ctx, {
    ...fresh,
    activateSkill(id) {
      activations++;
      return fresh.activateSkill(id);
    },
  });
  assert.equal(
    executor.execute("search_skill_resources", {
      name,
      query: "ocean",
      pathPrefix: "../",
    }).ok,
    false,
  );
  assert.equal(
    executor.execute("search_skill_resources", {
      name,
      query: "ocean",
      limit: 17,
    }).ok,
    false,
  );
  assert.equal(activations, 0);
  for (const query of ["ocean", "forest"])
    assert.equal(
      executor.execute("search_skill_resources", { name, query }).ok,
      true,
    );
  assert.equal(activations, 1);
  assert.deepEqual([...executor.activatedSkills], [name]);
  const page = executor.execute("read_skill_resource", {
    name,
    path: file,
    offset: 5,
    limit: 7,
  });
  assert.equal(page.content, "Surface");
  assert.equal(page.truncated, true);
  registry.setSkillEnabled(name, false);
  assert.equal(
    executor.execute("search_skill_resources", { name, query: "ocean" }).ok,
    false,
  );
});

test("catalog summaries respect per-entry and total character budgets in both prompts", () => {
  const { ctx } = fixture(),
    entries = Array.from({ length: 80 }, (_, i) => ({
      ...skill,
      name: "skill-" + i,
      description: "x".repeat(1000),
    }));
  for (const make of [buildToolModeSystemPrompt, buildDesignSystemPrompt]) {
    const prompt = make(ctx, config().capabilities, entries, []);
    const catalog = prompt
      .split("## Available Skills\n")[1]
      .split("\n")
      .filter((s) => s.startsWith("- skill-"))
      .join("\n");
    assert.ok(catalog.length > 3000 && catalog.length <= 4000);
    assert.ok(catalog.split("\n").every((s) => s.length <= 220));
  }
});

test("lint reports unbound variables, contrast, empty text, overflow and fixed siblings overlapping", () => {
  const doc = createStarter(),
    ds = nativeDesignSystem(),
    root = doc.nodes[0];
  root.style.layout = "free";
  root.style.fill = "#ffffff";
  const label = doc.nodes[1];
  label.style.color = "#eeeeee";
  const empty = doc.nodes[2];
  empty.text = "";
  empty.style = { ...label.style };
  doc.nodes[3].style.x = root.style.width + 16;
  const value = resolveVariable(ds, "color-accent", ds.activeModes);
  assert.equal(typeof value, "string");
  doc.nodes[3].style.fill = String(value);
  const executor = new FormaToolExecutor({
    prompt: "体检",
    selection: root.id,
    document: parseDocument({ ...doc, designSystem: ds }),
  });
  const issues = executor.execute("lint_design", { rootId: root.id })
    .issues as { kind: string; nodeId: string; suggestion: string }[];
  for (const kind of [
    "unbound-color",
    "low-contrast",
    "empty-text",
    "out-of-bounds",
    "overlap",
  ])
    assert.ok(
      issues.some((i) => i.kind === kind && i.suggestion),
      kind,
    );
});

test("successful proposal returns scoped lint and makes unsaved search layers inspectable", () => {
  const document = parseDocument({
    ...createStarter(),
    nodes: [],
    designSystem: nativeDesignSystem(),
  });
  const executor = new FormaToolExecutor({
    document,
    prompt: "发现页",
    selection: null,
  });
  const result = executor.execute(
    "propose_design_changes",
    searchToolbarBlueprint,
  );
  assert.equal(result.ok, true);
  const [rootId] = result.createdRootIds as string[];
  const summary = result.lintSummary as Record<string, number>;
  assert.deepEqual(
    [
      summary.contrastIssues,
      summary.overflowIssues,
      summary.overlapIssues,
      summary.emptyTextIssues,
    ],
    [0, 0, 0, 0],
  );
  assert.ok(summary.unboundColorIssues > 0);
  assert.match(String(result.guidance), /无需再次调用 lint_design/);
  for (const args of [{ rootId }, {}]) {
    const lint = executor.execute("lint_design", args);
    assert.equal(lint.source, "proposed-shadow");
    assert.equal(lint.total, summary.issueCount);
    assert.deepEqual((lint.issues as unknown[]).slice(0, 6), summary.topIssues);
  }
  for (const args of [{ query: "搜索提示" }, { rootId, query: "搜索提示" }]) {
    const search = executor.execute("search_nodes", args);
    assert.equal(search.source, "proposed-shadow");
    const [hint] = search.nodes as { id: string; text: string }[];
    assert.equal(hint.text, "搜索展览与活动");
    const byId = executor.execute("search_nodes", { ids: [hint.id] });
    assert.equal(byId.source, "proposed-shadow");
    assert.deepEqual(byId.nodes, search.nodes);
    const detail = executor.execute("get_node_details", {
      ids: [hint.id, "missing"],
    });
    assert.equal(detail.source, "proposed-shadow");
    assert.deepEqual(detail.missingIds, ["missing"]);
    assert.equal(
      (detail.nodes as { style: { widthMode: string } }[])[0].style.widthMode,
      "hug",
    );
  }
  assert.equal(document.nodes.length, 0);
  assert.equal(executor.execute("get_canvas_overview", {}).totalNodes, 0);
  const bad = executor.execute("propose_design_changes", {
    mode: "edit",
    reply: "重试",
    edits: [{ op: "remove", id: rootId }],
  });
  assert.equal(bad.ok, false);
  assert.equal(executor.execute("lint_design", { rootId }).ok, true);
  executor.execute("propose_design_changes", {
    mode: "generate",
    reply: "替换",
    artboards: [{ name: "另一版" }],
  });
  assert.equal(executor.execute("lint_design", { rootId }).ok, false);
  assert.equal(
    executor.execute("search_nodes", { query: "搜索提示" }).total,
    0,
  );
});

test("shadow contrast follows the linear gradient behind transparent wrappers and catches light-on-light text", () => {
  const document = { ...createStarter(), nodes: [] };
  const executor = new FormaToolExecutor({
    document,
    prompt: "检查横幅",
    selection: null,
  });
  const result = executor.execute("propose_design_changes", {
    mode: "generate",
    reply: "横幅",
    artboards: [
      {
        name: "横幅",
        style: { fill: "#ffffff", padding: 0 },
        children: [
          {
            name: "主视觉",
            style: {
              layout: "free",
              height: 100,
              gradient: {
                type: "linear",
                angle: 90,
                stops: [
                  { offset: 0, color: "#16362a" },
                  { offset: 0.45, color: "#275440" },
                  { offset: 0.55, color: "#16362a", opacity: 0 },
                  { offset: 1, color: "#16362a", opacity: 0 },
                ],
              },
            },
            children: [0, 300].map((x) => ({
              name: "横幅文案",
              style: { x, width: 80 },
              children: [
                {
                  type: "text",
                  name: x ? "右侧白字" : "左侧白字",
                  text: "晨曦花魁",
                  style: { color: "#ffffff" },
                },
              ],
            })),
          },
        ],
      },
    ],
  });
  assert.equal(result.ok, true);
  const summary = result.lintSummary as {
    contrastIssues: number;
    topIssues: { kind: string; nodeName: string }[];
  };
  assert.equal(summary.contrastIssues, 1);
  assert.deepEqual(
    summary.topIssues
      .filter((i) => i.kind === "low-contrast")
      .map((i) => i.nodeName),
    ["右侧白字"],
  );
});

test("proposal lint counts all issues across new roots before pagination and excludes existing screens", () => {
  const document = createStarter();
  document.nodes[1].text = "";
  const executor = new FormaToolExecutor({
    document,
    prompt: "体检",
    selection: null,
  });
  const text = (i: number) => ({
    type: "text",
    name: "标题" + i,
    text: i === 0 ? " " : "低对比度",
    style: { color: "#ffffff", width: 60, height: 20, x: i < 2 ? 430 : 0 },
  });
  const result = executor.execute("propose_design_changes", {
    mode: "generate",
    reply: "草案",
    artboards: [2, 48].map((count) => ({
      name: "样稿" + count,
      style: { layout: "free" },
      children: Array.from({ length: count }, (_, i) => text(i)),
    })),
  });
  assert.equal(result.ok, true);
  const summary = result.lintSummary as Record<string, number>;
  assert.equal(summary.emptyTextIssues, 2);
  assert.equal(summary.contrastIssues, 48);
  assert.equal(summary.overflowIssues, 4);
  assert.ok(summary.overlapIssues > 0);
  assert.equal(summary.unboundColorIssues, 0);
  assert.equal(summary.issueCount, 54 + summary.overlapIssues);
  assert.equal(
    (result.lintSummary as { topIssues: unknown[] }).topIssues.length,
    6,
  );
  assert.doesNotMatch(String(result.guidance), /无需再次调用/);
  const [first, second] = result.createdRootIds as string[];
  const search = executor.execute("search_nodes", {
    rootId: first,
    types: ["text"],
  });
  assert.equal(search.total, 2);
  assert.equal(
    executor.execute("search_nodes", { rootId: second, types: ["text"] }).total,
    48,
  );
  const details = executor.execute("get_node_details", {
    ids: [first, document.nodes[0].id],
  });
  assert.equal(details.source, "proposed-shadow");
  assert.equal(details.total, 2);
  assert.equal(executor.execute("lint_design", {}).source, undefined);
  assert.equal(
    executor.execute("lint_design", { rootId: document.nodes[0].id }).source,
    undefined,
  );
  assert.equal(
    executor.execute("get_node_details", { ids: [document.nodes[0].id] })
      .source,
    undefined,
  );
});

test("selection lint uses the edited subtree even when its root ID already exists or was removed", () => {
  const document = createStarter();
  const label = document.nodes[1];
  const executor = new FormaToolExecutor({
    document,
    prompt: "修改标题",
    selection: label.id,
  });
  const edit = (op: object) =>
    executor.execute("propose_design_changes", {
      mode: "edit",
      reply: "修改",
      edits: [op],
    });
  const update = edit({ op: "update", id: label.id, patch: { text: "" } });
  assert.equal(
    (update.lintSummary as { emptyTextIssues: number }).emptyTextIssues,
    1,
  );
  const remove = edit({ op: "remove", id: label.id });
  assert.equal((remove.lintSummary as { issueCount: number }).issueCount, 0);
  assert.notEqual(label.text, "");
});

test("read tools find late cross-page nodes, full component variants and effective selection modes", () => {
  const { ctx, lib } = fixture(),
    doc = ctx.document;
  doc.nodes[0].variableModes = { semantic: "dark" };
  const remote = Array.from({ length: 350 }, (_, i) => ({
    ...createNode("rectangle"),
    id: "other-" + i,
    name: "层 " + i,
  }));
  doc.pages = [
    { id: "here", name: "当前" },
    { id: "there", name: "其他", nodes: remote },
  ];
  doc.activePage = "here";
  const source = lib.components[0];
  lib.components = Array.from({ length: 90 }, (_, i) => ({
    ...source,
    id: "comp-" + i,
    name: "组件" + i,
  }));
  lib.components[89].variants = Array.from({ length: 17 }, (_, i) => ({
    ...source.variants[0],
    id: "v" + i,
    name: "Variant" + i,
    properties: { Size: String(i) },
  }));
  const executor = new FormaToolExecutor(ctx);
  assert.equal(
    executor.execute("get_canvas_overview", {}).editableSelectionId,
    ctx.selection,
  );
  const nodes = executor.execute("search_nodes", {
    pageId: "there",
    query: "other-349",
  }).nodes as { id: string; editableOnCurrentPage: boolean }[];
  assert.deepEqual(
    nodes.map((n) => [n.id, n.editableOnCurrentPage]),
    [["other-349", false]],
  );
  assert.deepEqual(
    executor.execute("search_nodes", { pageId: "there", withinSelection: true })
      .nodes,
    [],
  );
  const details = executor.execute("get_node_details", { ids: [nodes[0].id] })
    .nodes as { style: unknown }[];
  assert.deepEqual(details[0].style, remote[349].style);
  const matches = executor.execute("search_components", { query: "comp-89" })
    .components as { variants: unknown[] }[];
  assert.equal(matches[0].variants.length, 17);
  const value = executor.execute("get_design_system", {
    kind: "variables",
    scope: "fill",
    query: "color-accent",
  }).variables as { value: unknown }[];
  assert.equal(
    value[0].value,
    resolveVariable(doc.designSystem!, "color-accent", { semantic: "dark" }),
  );
  assert.equal(getFormaToolDefinitions({ hasSkills: false }).length, 12);
  assert.equal(requestTools.length, 15);
  assert.equal(
    getFormaToolDefinitions({ hasSkills: true, enableScopePlan: true }).length,
    16,
  );
});

test("an out-of-scope model call receives an explicit tool result before its next reply", async () => {
  const { ctx } = fixture();
  const outside = ctx.document.nodes.find(
    (n) => !n.parentId && n.id !== ctx.selection,
  )!;
  let turn = 0;
  const result = await runDesignChat(ctx, {
    adapterConfig: config(),
    providerName: "Test",
    signal,
    fetchImpl: async (_url, init) => {
      if (turn++ === 0)
        return openAI({
          tool_calls: [
            toolCall("scope", "propose_design_changes", {
              mode: "edit",
              reply: "修改画板",
              edits: [
                { op: "update", id: outside.id, patch: { name: "越界" } },
              ],
            }),
          ],
        });
      const history = JSON.parse(String(init?.body)).messages;
      assert.equal(history.at(-1).tool_call_id, "scope");
      const response = JSON.parse(history.at(-1).content);
      assert.equal(response.ok, false);
      assert.equal(response.editableSelectionId, ctx.selection);
      assert.match(response.error, /超出当前选区/);
      return openAI({ content: "请选中要修改的画板。" });
    },
  });
  assert.equal(result.transaction, undefined);
  assert.equal(result.mode, "answer");
  assert.equal(result.toolTrace?.[0].status, "error");
});

test("capability opt-out, final tool-turn budget and abort are honored", async () => {
  const { ctx } = fixture();
  const cfg = config();
  const off = {
    ...cfg,
    capabilities: { ...cfg.capabilities, supportsTools: false },
  };
  await runDesignChat(ctx, {
    adapterConfig: off,
    providerName: "Test",
    signal,
    fetchImpl: async (_url, init) => {
      const req = JSON.parse(String(init?.body));
      assert.equal(req.tools, undefined);
      return openAI({ content: '{"mode":"answer","reply":"OK"}' });
    },
  });
  let calls = 0;
  await assert.rejects(
    runDesignChat(ctx, {
      adapterConfig: cfg,
      providerName: "Test",
      signal,
      maxToolTurns: 1,
      fetchImpl: async (_url, init) => {
        assert.equal(
          JSON.parse(String(init?.body)).tool_choice,
          calls++ === 0 ? "auto" : "none",
        );
        return openAI({
          tool_calls: [toolCall("again", "get_canvas_overview", {})],
        });
      },
    }),
    /轮数上限/,
  );
  assert.equal(calls, 2);
  const controller = new AbortController();
  await assert.rejects(
    runDesignChat(ctx, {
      adapterConfig: cfg,
      providerName: "Test",
      signal: controller.signal,
      fetchImpl: async () => {
        controller.abort();
        return openAI({
          tool_calls: [toolCall("cancelled", "get_canvas_overview", {})],
        });
      },
    }),
    { name: "AbortError" },
  );
});

test("raw proposal with empty Blueprint arrays preserves supplied reply, statistics and base revision", () => {
  const { ctx } = fixture(),
    executor = new FormaToolExecutor(ctx);
  const response = executor.execute("propose_design_changes", {
    mode: "edit",
    reply: "更新结账画板",
    summary: "重命名当前画板",
    artboards: [],
    edits: [],
    operations: [
      { type: "update", id: ctx.selection, patch: { name: "结账画板" } },
    ],
  });
  assert.equal(response.ok, true);
  assert.equal(executor.latestProposal?.reply, "更新结账画板");
  assert.equal(executor.latestProposal?.stats.updated, 1);
  const transaction = executor.latestProposal?.transaction;
  assert.equal(transaction?.baseRevision, ctx.document.revision);
  assert.equal(transact(ctx.document, transaction).nodes[0].name, "结账画板");
});

test("FormaToolExecutor recovers from trailing text after JSON and ignores extra metadata keys on proposals", () => {
  const { ctx } = fixture(),
    executor = new FormaToolExecutor({ ...ctx, selection: null });
  const rawArgs =
    JSON.stringify({
      mode: "generate",
      reply: "已生成方案",
      designPlan: { aesthetic: "editorial" },
      artboards: [
        {
          type: "frame",
          name: "Coffee Home",
          style: { width: 390, height: 844, fill: "#12100e", layout: "column" },
          children: [
            {
              type: "text",
              name: "Title",
              text: "Roaster",
              style: { color: "#f6efe7" },
            },
          ],
        },
      ],
    }) + "\n```extra trailing commentary";
  const response = executor.execute("propose_design_changes", rawArgs);
  assert.equal(response.ok, true);
  assert.equal(executor.latestProposal?.reply, "已生成方案");
  assert.equal(executor.latestProposal?.createdRootIds.length, 1);
});

const photoUrl = "https://images.unsplash.com/photo-1511920170033-f8396924c348";
const photoData =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jB1kAAAAASUVORK5CYII=";
const htmlProposal = {
  reply: "已排好咖啡首页",
  name: "晨间咖啡",
  width: 390,
  height: 844,
  html: "<main><h1>晨间咖啡</h1></main>",
};

test("HTML tool is enabled by default; prompts distinguish screen creation and scoped Blueprint edits", () => {
  const enabled = getFormaToolDefinitions({ hasSkills: false }).map(
    (t) => t.name,
  );
  for (const name of [
    "search_icons",
    "search_stock_images",
    "propose_html_design",
  ])
    assert.ok(enabled.includes(name));
  assert.deepEqual(
    getFormaToolDefinitions({ hasSkills: false, enableHtmlDesign: false }).map(
      (t) => t.name,
    ),
    enabled.filter((t) => t !== "propose_html_design"),
  );
  const { ctx } = fixture();
  for (const context of [
    { ...ctx, selection: null },
    { ...ctx, selection: null, generationMode: "html" as const },
  ]) {
    const prompt = buildToolModeSystemPrompt(context, config().capabilities);
    for (const term of [
      "HTML-First Modern Engine",
      "search_stock_images",
      "data-icon",
      "propose_html_design",
      "7:1",
      "8pt",
    ])
      assert.ok(prompt.includes(term), term);
  }
  for (const context of [
    ctx,
    { ...ctx, generationMode: "html" as const },
    { ...ctx, selection: null, generationMode: "blueprint" as const },
  ]) {
    const prompt = buildToolModeSystemPrompt(context, config().capabilities);
    assert.match(prompt, /propose_design_changes/);
    assert.doesNotMatch(prompt, /HTML-First Modern Engine/);
  }
});

test("async HTML proposal sanitizes markup, hydrates editable icons, and localizes photo placements across all styles", async () => {
  const ctx = { ...fixture().ctx, selection: null };
  const executor = new FormaToolExecutor(ctx);
  const offline = {
    allowNetworkMedia: false,
    fetchImpl: async () => assert.fail("Offline media used the network"),
  };
  const icon = executor.execute("search_icons", { query: "咖啡", limit: 1 });
  assert.equal((icon.icons as { name: string }[])[0].name, "coffee");
  const photos = await executor.executeAsync(
    "search_stock_images",
    { query: "coffee", limit: 2, orientation: "landscape", mood: "warm" },
    offline,
  );
  const candidates = photos.images as {
    url: string;
    tags: string[];
    orientation: string;
  }[];
  assert.ok(candidates.length && candidates.length <= 2);
  assert.ok(
    candidates.every(
      (c) => c.orientation === "landscape" && c.tags.length <= 5,
    ),
  );
  const url = candidates[0].url;
  const args = {
    ...htmlProposal,
    html: `<main><script>alert(0)</script><div data-icon="search"></div><i class="nav" style="opacity:.9" data-lucide="coffee" data-forma-name="咖啡图标" data-size="20" data-color="#f2b15c" data-stroke-width="1.75"></i><img src="${url}" onload="bad()"><section style="background:url('${url}')"></section><style>main > section { background: url("${url}") }</style><span data-icon="coffee">保留文字</span></main>`,
    css: `@import url("https://example.invalid/font"); .hero { background-image: url('${url}') }`,
  };
  const result = await executor.executeAsync(
    "propose_html_design",
    JSON.stringify(args) + "\n完成",
    offline,
  );
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.iconsHydrated, 2);
  assert.equal(result.imagesLocalized, 4);
  assert.equal(result.fallbackImages, 4);
  const draft = executor.latestHtmlDraft!;
  assert.doesNotMatch(
    draft.html + draft.css,
    /<script|onload|@import|images\.unsplash|example\.invalid/i,
  );
  assert.match(draft.html, /<svg[^>]*data-forma-name="咖啡图标"/);
  assert.match(draft.html, /stroke="#f2b15c"/i);
  assert.match(draft.html, /stroke-width="1.75"/);
  assert.match(draft.html, /class="nav"/);
  assert.match(draft.html, /style="opacity:.9"/);
  assert.match(draft.html, /保留文字/);
  assert.match(draft.html, /main > section/);
  const assetId = /data-forma-asset-id="(img-[a-f0-9]{64})"/.exec(
    draft.html,
  )?.[1];
  assert.ok(assetId && draft.images?.[assetId]);
  assert.equal(Object.keys(draft.images!).length, 1);
  assert.match(draft.css!, /url\(data:image\/png;base64,/);
  const { x, y } = computeArtboardPlacement(ctx.document, undefined, args);
  assert.deepEqual(draft.placement, { x, y });
  assert.equal(executor.toolTrace.at(-1)?.status, "ok");
  assert.equal(
    (
      await executor.executeAsync(
        "propose_html_design",
        { ...args, width: 10 },
        offline,
      )
    ).ok,
    false,
  );
  assert.equal(executor.latestHtmlDraft, draft);
});

test("Blueprint proposals localize URL and stock shorthand, reuse image IDs and replace only successful draft proposals", async () => {
  const ctx = { ...fixture().ctx, selection: null };
  const executor = new FormaToolExecutor(ctx);
  const candidates = await executor.executeAsync(
    "search_stock_images",
    { query: "coffee", limit: 1, orientation: "landscape" },
    { allowNetworkMedia: false },
  );
  const url = (candidates.images as { url: string }[])[0].url;
  let calls = 0;
  const fetchImpl: typeof fetch = async (input) => {
    assert.equal(String(input), url);
    calls++;
    return new Response(Buffer.from(photoData.split(",")[1], "base64"), {
      headers: { "content-type": "image/png" },
    });
  };
  await executor.executeAsync("propose_html_design", htmlProposal);
  const proposal = {
    mode: "generate",
    reply: "摄影排版",
    artboards: [
      {
        type: "frame",
        name: "图库",
        children: [
          { type: "image", name: "A", image: { url, fit: "contain" } },
          { type: "image", name: "B", image: url },
          { type: "image", name: "C", image: "stock:coffee" },
        ],
      },
    ],
    edits: [
      {
        op: "create",
        parentId: ctx.document.nodes[0].id,
        node: { type: "image", name: "D", image: url },
      },
    ],
  };
  const result = await executor.executeAsync(
    "propose_design_changes",
    proposal,
    { fetchImpl },
  );
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(proposal.artboards[0].children[1].image, url);
  assert.equal(calls, 1);
  assert.equal(executor.latestHtmlDraft, undefined);
  const transaction = executor.latestProposal!.transaction!;
  assert.equal(
    transaction.operations.filter((op) => op.type === "putImage").length,
    1,
  );
  const after = transact(ctx.document, validateProposal(ctx, transaction));
  const images = after.nodes.filter((n) =>
    ["A", "B", "C", "D"].includes(n.name),
  );
  assert.equal(images.length, 4);
  const assetId = Object.keys(after.images!)[0];
  assert.ok(images.every((n) => n.image?.assetId === assetId));
  assert.equal(images.find((n) => n.name === "A")?.image?.fit, "contain");
  assert.equal(
    (await executor.executeAsync("propose_html_design", htmlProposal)).ok,
    true,
  );
  assert.equal(executor.latestProposal, undefined);
  assert.equal(
    (executor.execute("search_nodes", { query: "图库" }).nodes as unknown[])
      .length,
    0,
  );
});

test("visual critique sends the actual screenshot and compact reusable photo references, then returns a refined draft", async () => {
  const executor = new FormaToolExecutor({ ...fixture().ctx, selection: null });
  const first = await executor.executeAsync(
    "propose_html_design",
    {
      ...htmlProposal,
      html: `<main><img src="${photoUrl}"><h1>晨间咖啡</h1></main>`,
      css: `.hero{background:url('${photoUrl}')}`,
    },
    { allowNetworkMedia: false },
  );
  assert.equal(first.ok, true);
  const original = executor.latestHtmlDraft!;
  const assetId = Object.keys(original.images!)[0];
  const renderedImageDataUrl = photoData;
  let requests = 0;
  const result = await runVisualCritique(
    { htmlDraft: original, renderedImageDataUrl, prompt: "让首屏更清晰" },
    {
      adapterConfig: config(),
      providerName: "Test",
      signal,
      allowNetworkMedia: false,
      fetchImpl: async (_url, init) => {
        requests++;
        const body = JSON.parse(String(init?.body));
        const content = body.messages[1].content;
        assert.deepEqual(
          content.find((p: { type: string }) => p.type === "image_url")
            .image_url.url,
          renderedImageDataUrl,
        );
        const text = content.find(
          (p: { type: string }) => p.type === "text",
        ).text;
        assert.ok(text.includes("让首屏更清晰") && text.includes("晨间咖啡"));
        assert.ok(text.includes("forma-asset:" + assetId));
        assert.doesNotMatch(text, /;base64,/);
        assert.deepEqual(
          body.tools
            .map((t: { function: { name: string } }) => t.function.name)
            .sort(),
          ["propose_html_design", "search_icons", "search_stock_images"],
        );
        if (requests === 1)
          return openAI({
            tool_calls: [
              toolCall("icons", "search_icons", { query: "coffee" }),
            ],
          });
        assert.equal(JSON.parse(body.messages.at(-1).content).ok, true);
        const source = JSON.parse(text);
        return openAI({
          tool_calls: [
            toolCall("refine", "propose_html_design", {
              ...htmlProposal,
              html: source.html,
              css: source.css + "main{padding:24px}",
              reply: "增加首屏留白。\n修正底部间距。",
              summary: "咖啡首页精修",
            }),
          ],
        });
      },
    },
  );
  assert.equal(requests, 2);
  assert.equal(result.improved, true);
  assert.deepEqual(result.critiqueNotes, ["增加首屏留白。", "修正底部间距。"]);
  assert.deepEqual(result.htmlDraft.placement, original.placement);
  assert.deepEqual(Object.keys(result.htmlDraft.images!), [assetId]);
  assert.match(result.htmlDraft.css!, /padding:24px/);
  assert.doesNotMatch(result.htmlDraft.css!, /forma-asset:/);
  assert.deepEqual(
    result.toolTrace.map((t) => t.name),
    ["search_icons", "propose_html_design"],
  );
});

test("critique retains the draft on a visual pass or non-vision skip and stops after three model turns", async () => {
  const htmlDraft = { ...htmlProposal, summary: "初稿" };
  const ctx = {
    prompt: "检查布局",
    renderedImageDataUrl: photoData,
    htmlDraft,
  };
  const cfg = config();
  for (const mode of ["no-vision", "approved", "exhausted"]) {
    let calls = 0;
    const result = await runVisualCritique(ctx, {
      adapterConfig: {
        ...cfg,
        capabilities: {
          ...cfg.capabilities,
          supportsVision: mode !== "no-vision",
        },
      },
      providerName: "Test",
      signal,
      fetchImpl: async () => {
        calls++;
        return mode === "approved"
          ? openAI({ content: "字号和边距合适。" })
          : openAI({
              tool_calls: [
                toolCall("s" + calls, "search_icons", { query: "coffee" }),
              ],
            });
      },
    });
    assert.equal(calls, mode === "no-vision" ? 0 : mode === "approved" ? 1 : 3);
    assert.equal(result.htmlDraft, htmlDraft);
    assert.equal(result.improved, false);
    assert.equal(result.modelUsed, cfg.model);
    assert.ok(result.critiqueNotes[0]);
    if (mode === "no-vision")
      assert.deepEqual(result.critiqueNotes, [
        "当前模型未开启视觉识图，已保留初稿。",
      ]);
  }
});

test("OpenAI adapter recovers leaked DeepSeek DSML XML tool invocations into native toolCalls", async () => {
  const adapter = createModelAdapter(config("openai-chat", false), async () =>
    openAI({
      content:
        '<｜｜DSML｜｜ calls>\n<｜｜DSML｜｜ invoke name="search_icons">\n<｜｜DSML｜｜ parameter name="limit" string="false">10</｜｜DSML｜｜ parameter>\n<｜｜DSML｜｜ parameter name="query" string="true">coffee</｜｜DSML｜｜ parameter>\n</｜｜DSML｜｜ invoke>\n</｜｜DSML｜｜ calls>',
    }),
  );
  const res = await adapter.complete(
    {
      messages: [{ role: "user", text: "find coffee icon" }],
      tools: requestTools,
      toolChoice: "auto",
    },
    signal,
  );
  assert.equal(res.text, "");
  assert.equal(res.toolCalls?.length, 1);
  assert.equal(res.toolCalls?.[0].name, "search_icons");
  assert.deepEqual(JSON.parse(res.toolCalls![0].arguments), {
    limit: 10,
    query: "coffee",
  });
});

test("target library discovery preserves the selected variant's hierarchy and slot contracts", () => {
  const { ctx, lib } = fixture();
  const block = lib.components[0];
  block.name = "离线通知";
  block.assetTier = "block";
  block.aiHints = { maxTextChars: 8 };
  const variant = block.variants[0];
  const root = variant.nodes.find((n) => !n.parentId)!;
  const title = variant.nodes.find((n) => n.type === "text")!;
  const atom = {
    ...block,
    id: "retry",
    name: "重试按钮",
    assetTier: "component" as const,
  };
  const page = {
    ...block,
    id: "home",
    name: "商品首页",
    assetTier: "page" as const,
  };
  const source = {
    libraryId: lib.id,
    componentId: atom.id,
    variantId: variant.id,
  };
  const retry = {
    ...createNode("frame", root.id),
    templateKey: "retry",
    nestedSlot: true as const,
    nestedSource: source,
  };
  const second = structuredClone(variant);
  second.id = "detail";
  second.nodes.find((n) => n.id === title.id)!.text = "点击重试";
  second.nodes.push(retry);
  block.variants.push(second);
  block.exposed = [
    { kind: "text", id: "message", name: "提示", target: title.templateKey! },
    { kind: "swap", id: "action", name: "操作", target: "retry" },
  ];
  lib.components.push(atom, page);
  lib.aiGuide = { summary: "订单流程规范" };
  const otherLib = {
    ...lib,
    id: "another",
    name: "其他库",
    components: [atom],
  };
  const context = {
    ...ctx,
    selection: null,
    targetLibraryId: lib.id,
    document: {
      ...ctx.document,
      libraries: { another: otherLib, [lib.id]: lib },
    },
  };
  const executor = new FormaToolExecutor(context);
  const book = executor.execute("get_library_playbook", {});
  assert.equal(book.libraryId, lib.id);
  assert.equal(book.summary, lib.aiGuide.summary);
  assert.deepEqual(book.tierCounts, { page: 1, block: 1, component: 1 });
  assert.equal(book.exceptionCount, 1);
  assert.ok(Array.isArray(book.exceptionComponents));
  assert.equal(book.exceptionComponents[0].componentId, block.id);
  assert.match(String(book.playbookMarkdown), /异常与边界态对照表/);
  assert.ok(Array.isArray(book.components));
  assert.deepEqual(
    executor.execute("get_library_playbook", {
      libraryId: "another",
      includeComponents: false,
    }).components,
    undefined,
  );
  assert.equal(
    executor.execute("get_library_playbook", { libraryId: "missing" }).ok,
    false,
  );
  const search = executor.execute("search_components", {
    tier: "block",
    onlyExceptions: true,
  });
  assert.equal(search.total, 1);
  assert.ok(Array.isArray(search.components));
  const [hit] = search.components;
  assert.equal(hit.assetTier, "block");
  assert.equal(hit.isException, true);
  assert.deepEqual(hit.aiHints, block.aiHints);
  assert.equal(hit.textSlots[0].exposedId, "message");
  assert.equal(hit.textSlots[0].recommendedMaxChars, 8);
  assert.deepEqual(hit.imageSlots, []);
  assert.equal(hit.swapSlots[0].targetTemplateKey, "retry");
  const detail = executor.execute("inspect_component_structure", {
    componentId: block.name,
    variantId: second.id,
  });
  assert.equal(detail.variantId, second.id);
  assert.ok(Array.isArray(detail.nodes));
  const nested = detail.nodes.find((n) => n.templateKey === retry.templateKey);
  assert.equal(nested.parentTemplateKey, root.templateKey);
  assert.equal(nested.nestedSlot, true);
  assert.deepEqual(nested.nestedSource, source);
  assert.equal(nested.exposed[0].id, "action");
  assert.equal(
    detail.nodes.find((n) => n.templateKey === title.templateKey).text,
    "点击重试",
  );
  assert.ok(detail.manifest && "swapSlots" in Object(detail.manifest));
  const caps = config().capabilities;
  const payload = buildDesignContextPayload(context, caps);
  assert.equal(payload.confirmedScope, null);
  assert.equal(payload.memoryScope, null);
  assert.equal(payload.targetLibraryId, lib.id);
  const entry = payload.componentCatalog[1].components[0];
  assert.equal(entry.assetTier, "block");
  assert.equal(entry.isException, true);
  for (const make of [buildDesignSystemPrompt, buildToolModeSystemPrompt]) {
    const prompt = make(context, caps);
    assert.match(prompt, /Forma AI/);
    assert.match(
      prompt,
      /Page 1 \/ Block 1 \/ Component 1 · 异常态 1 · AI 说明书已有/,
    );
    assert.doesNotMatch(prompt, /其他库/);
  }
});

const scopeInput = {
  reply: "请确认以下范围。",
  summary: "结账与离线反馈",
  screens: [
    {
      refId: "pay",
      name: "结账",
      width: 390,
      height: 844,
      summary: "填写订单",
    },
    {
      refId: "offline",
      role: "exception",
      parentRef: "pay",
      name: "断网",
      width: 390,
      height: 320,
      summary: "重试支付",
    },
  ],
  decisions: [
    {
      question: "离线如何处理？",
      defaultChoice: "保留订单",
      alternatives: ["仅提示"],
    },
  ],
};

test("scope confirmation stops the tool batch and disables a second proposal", async () => {
  const { ctx, lib } = fixture();
  const context = { ...ctx, targetLibraryId: lib.id, selection: null };
  const executor = new FormaToolExecutor(context);
  for (const malformed of [
    { ...scopeInput, screens: [] },
    { ...scopeInput, decisions: Array(4).fill(scopeInput.decisions[0]) },
    { ...scopeInput, screens: [{ ...scopeInput.screens[0], unknown: 1 }] },
  ])
    assert.equal(executor.execute("propose_scope_plan", malformed).ok, false);
  await executor.executeAsync("propose_html_design", htmlProposal);
  assert.ok(executor.latestHtmlDraft);
  assert.equal(executor.execute("propose_scope_plan", scopeInput).ok, true);
  assert.equal(executor.latestHtmlDraft, undefined);
  let calls = 0;
  const result = await runDesignChat(context, {
    adapterConfig: config(),
    providerName: "fixture",
    signal,
    fetchImpl: async (_url, init) => {
      assert.equal(++calls, 1);
      const body = JSON.parse(String(init?.body));
      assert.ok(
        body.tools.some(
          (t: { function: { name: string } }) =>
            t.function.name === "propose_scope_plan",
        ),
      );
      return openAI({
        tool_calls: [
          toolCall("plan", "propose_scope_plan", scopeInput),
          toolCall("generate", "propose_html_design", htmlProposal),
        ],
      });
    },
  });
  assert.equal(result.mode, "clarify");
  assert.equal(result.reply, scopeInput.reply);
  assert.equal(result.targetLibraryId, lib.id);
  assert.deepEqual(
    result.toolTrace?.map((t) => t.name),
    ["propose_scope_plan"],
  );
  assert.deepEqual(
    result.scopeProposal,
    executor.latestScopeProposal?.scopeProposal,
  );
  assert.equal(result.scopeProposal?.screens[0].role, "primary");
  assert.equal(result.scopeProposal?.targetLibraryName, lib.name);
  assert.deepEqual(result.scopeProposal?.reusedAssets, []);
  const confirmed = { ...context, confirmedScope: result.scopeProposal! };
  assert.ok(
    !getFormaToolDefinitions({ hasSkills: true }).some(
      (t) => t.name === "propose_scope_plan",
    ),
  );
  assert.match(
    String(
      new FormaToolExecutor(confirmed).execute("propose_scope_plan", scopeInput)
        .error,
    ),
    /范围已确认，请直接生成画板，不要再次提问/,
  );
  assert.equal(
    new FormaToolExecutor(ctx).execute("propose_scope_plan", scopeInput).ok,
    false,
  );
  for (const make of [buildToolModeSystemPrompt, buildDesignSystemPrompt]) {
    const prompt = make(confirmed, config().capabilities);
    assert.match(prompt, /禁止再次提问或澄清/);
    assert.ok(prompt.includes(JSON.stringify(confirmed.confirmedScope)));
  }
});

test("HTML matrix preserves sanitized component attributes and diagnoses missing slots atomically", async () => {
  const { ctx, lib } = fixture();
  const executor = new FormaToolExecutor({
    ...ctx,
    selection: null,
    targetLibraryId: lib.id,
  });
  const component = lib.components[0];
  const variant = component.variants[0];
  const slot =
    '<div data-forma-component="' +
    component.id +
    '" data-library="' +
    lib.id +
    '" data-variant="' +
    variant.id +
    '" data-overrides=\'{"text":"支付"}\' onclick="discard()"></div>';
  const boards = [
    {
      refId: "pay",
      role: "primary",
      name: "支付",
      width: 390,
      height: 844,
      html: slot + '<i data-icon="coffee"></i>',
    },
    {
      refId: "offline",
      role: "exception",
      parentRef: "pay",
      name: "断网",
      width: 390,
      height: 320,
      html:
        "<main>" +
        slot +
        '<script>discard()</script><img src="' +
        photoData +
        '"></main>',
      css: "main{color:#303030}",
    },
  ];
  const submit = (input: unknown) =>
    executor.executeAsync("propose_html_design", input, {
      allowNetworkMedia: false,
    });
  const result = await submit({
    reply: "已完成",
    artboards: boards,
    snapLibraryTokens: false,
  });
  assert.equal(result.ok, true, String(result.error));
  assert.equal(result.componentSlotsResolved, 2);
  const draft = executor.latestHtmlDraft!;
  assert.equal(draft.targetLibraryId, lib.id);
  assert.equal(draft.snapLibraryTokens, false);
  assert.equal(draft.componentSlotsResolved, 2);
  assert.equal(draft.artboards?.length, 2);
  assert.match(draft.html, /<svg/);
  for (const key of ["name", "width", "height", "html", "css"] as const)
    assert.equal(draft[key], draft.artboards![0][key]);
  const exception = draft.artboards![1];
  assert.equal(exception.parentRef, "pay");
  assert.equal(exception.role, "exception");
  assert.match(exception.html, /data-forma-asset-id="img-/);
  assert.ok(Object.keys(draft.images!).length);
  for (const board of draft.artboards!) {
    assert.doesNotMatch(board.html, /<script|onclick|discard/);
    for (const attr of [
      "data-forma-component",
      "data-library",
      "data-variant",
      "data-overrides",
    ])
      assert.ok(board.html.includes(attr + "="));
    assert.match(board.html, /支付/);
  }
  const missing = {
    ...boards[1],
    html: '<div DATA-FORMA-COMPONENT="missing-ref"></div>',
  };
  for (const artboards of [[missing], [boards[0], missing]]) {
    const bad = await submit({ reply: "重试", artboards });
    assert.equal(bad.ok, false);
    assert.match(String(bad.error), /断网.*missing-ref.*search_components/s);
    assert.equal(executor.latestHtmlDraft, draft);
  }
  for (const bad of [
    { artboards: [] },
    { artboards: Array(9).fill(boards[0]) },
    { name: "缺少尺寸", html: slot },
  ]) {
    assert.equal((await submit({ reply: "无效", ...bad })).ok, false);
  }
});

test("confirmed flow can use its final tool turn to repair an incomplete proposal", async () => {
  const { ctx } = fixture();
  const confirmedScope = {
    summary: scopeInput.summary,
    screens: scopeInput.screens.map((s) => ({
      ...s,
      role: s.parentRef ? ("exception" as const) : ("primary" as const),
    })),
    reusedAssets: [],
    customModules: [],
  };
  let turns = 0;
  const result = await runDesignChat(
    { ...ctx, selection: null, confirmedScope },
    {
      adapterConfig: config(),
      providerName: "fixture",
      signal,
      maxToolTurns: 1,
      fetchImpl: async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        if (++turns === 1)
          return openAI({
            tool_calls: [
              toolCall("incomplete", "propose_html_design", htmlProposal),
            ],
          });
        assert.equal(body.tool_choice, "required");
        assert.match(
          JSON.parse(body.messages.at(-1).content).error,
          /已确认 2 张画板/,
        );
        const names = body.tools
          .map((t: { function: { name: string } }) => t.function.name)
          .sort();
        assert.deepEqual(names, [
          "propose_design_changes",
          "propose_html_design",
        ]);
        return openAI({
          tool_calls: [
            toolCall("complete", "propose_design_changes", {
              mode: "generate",
              reply: "已生成支付与断网页面",
              artboards: confirmedScope.screens.map(
                ({ refId, name, role, parentRef, width, height }) => ({
                  type: "frame",
                  refId,
                  name,
                  role,
                  parentRef,
                  style: { width, height },
                }),
              ),
            }),
          ],
        });
      },
    },
  );
  assert.equal(turns, 2);
  assert.equal(result.mode, "generate");
  assert.equal(result.createdRootIds.length, 2);
  assert.ok(result.transaction);
});

test("playbook reads preserve authored Markdown and search covers designer hints and tier aliases", () => {
  const { ctx, lib } = fixture();
  const markdown = "  # 活动规则\n\n支付失败时保持库存。\n";
  lib.aiGuide = { playbookMarkdown: markdown, platform: "活动端" };
  const c = lib.components[0];
  c.aiHints = {
    whenToUse: "火山专场",
    avoidWhen: "会员日",
    tags: ["大促"],
    slotsNote: "双行价格",
  };
  c.assetTier = "block";
  const executor = new FormaToolExecutor(ctx);
  const guide = executor.execute("get_library_playbook", {});
  assert.equal(guide.playbookMarkdown, markdown);
  for (const blank of ["", "  \n\t"]) {
    lib.aiGuide.playbookMarkdown = blank;
    assert.equal(
      executor.execute("get_library_playbook", {}).playbookMarkdown,
      blank,
    );
  }
  assert.deepEqual(guide.tierCounts, { page: 0, component: 0, block: 1 });
  for (const query of [
    "火山专场",
    "会员日",
    "大促",
    "双行价格",
    "业务楼层",
    "活动端",
    "大促 火山专场",
  ]) {
    const hits = executor.execute("search_components", { query });
    assert.equal(hits.total, 1, query);
    assert.ok(Array.isArray(hits.components));
    assert.equal(hits.components[0].componentId, c.id);
  }
});

test("scope planning matches engine capacity and rejects duplicate, missing, self and non-primary parents", async () => {
  const ctx = { ...fixture().ctx, selection: null };
  const executor = new FormaToolExecutor(ctx);
  const plan = (screens: unknown[]) =>
    executor.execute("propose_scope_plan", { ...scopeInput, screens });
  const nine = Array.from({ length: 9 }, (_, i) => ({
    ...scopeInput.screens[0],
    refId: "board-" + i,
  }));
  assert.equal(plan(nine.slice(0, 8)).ok, true);
  assert.match(String(plan(nine).error), /8/);
  assert.equal(
    new FormaToolExecutor({ ...ctx, generationMode: "blueprint" }).execute(
      "propose_scope_plan",
      { ...scopeInput, screens: nine },
    ).ok,
    true,
  );
  const [home, state] = scopeInput.screens;
  for (const [screens, reason] of [
    [[home, home], /重复.*refId/],
    [[home, { ...state, parentRef: "missing" }], /parentRef/],
    [[home, { ...state, parentRef: state.refId }], /parentRef/],
    [[{ ...home, role: "detail", parentRef: state.refId }, state], /parentRef/],
  ] as const) {
    assert.match(String(plan([...screens]).error), reason);
    const blueprint = executor.execute("propose_design_changes", {
      mode: "generate",
      reply: "生成画板",
      artboards: screens.map((board) => ({
        ...board,
        type: "frame",
        style: { width: board.width, height: board.height },
      })),
    });
    assert.equal(blueprint.ok, false);
    assert.match(String(blueprint.error), reason);
    const result = await executor.executeAsync("propose_html_design", {
      reply: "提交",
      artboards: screens.map((s) => ({ ...s, html: htmlProposal.html })),
    });
    assert.match(String(result.error), reason);
  }
});

test("HTML and Blueprint check confirmed board identities, roles, parents and actual layout dimensions", async () => {
  const ctx = { ...fixture().ctx, selection: null };
  const home = { ...scopeInput.screens[0], role: "primary" as const };
  const state = { ...scopeInput.screens[1], role: "exception" as const };
  const other = { ...home, refId: "orders", name: "订单列表" };
  const confirmedScope = {
    summary: "支付",
    screens: [home, state, other],
    reusedAssets: [],
    customModules: [],
  };
  const executor = new FormaToolExecutor({ ...ctx, confirmedScope });
  for (const [field, patch] of Object.entries({
    refId: { refId: "renamed" },
    role: { role: "overlay" },
    parentRef: { parentRef: "orders" },
    width: { width: 400 },
    height: { height: 340 },
  })) {
    const boards = [home, { ...state, ...patch }, other];
    const html = await executor.executeAsync("propose_html_design", {
      reply: "提交",
      artboards: boards.map((b) => ({ ...b, html: htmlProposal.html })),
    });
    const blueprint = executor.execute("propose_design_changes", {
      reply: "提交",
      mode: "generate",
      artboards: boards.map((b) => ({
        ...b,
        type: "frame",
        style: { width: b.width, height: b.height },
      })),
    });
    for (const result of [html, blueprint]) {
      assert.equal(result.ok, false, field);
      assert.match(String(result.error), new RegExp(field));
    }
  }
  const reordered = [state, other, home].map((b) => ({
    ...b,
    html: htmlProposal.html,
  }));
  assert.equal(
    (
      await executor.executeAsync("propose_html_design", {
        reply: "提交",
        artboards: reordered,
      })
    ).ok,
    true,
  );
});

test("mixed HTML proposal formats and excessive aggregate image placements fail before fetching", async () => {
  const ctx = { ...fixture().ctx, selection: null };
  const executor = new FormaToolExecutor(ctx);
  const board = { ...htmlProposal, html: '<img src="' + photoUrl + '">' };
  const submit = (input: unknown) =>
    executor.executeAsync("propose_html_design", input, {
      fetchImpl: async () => assert.fail("unexpected fetch"),
    });
  for (const field of ["name", "width", "height", "html", "css"] as const) {
    const mixed = await submit({
      reply: "混传",
      artboards: [board],
      [field]: field === "css" ? "main{}" : htmlProposal[field],
    });
    assert.match(String(mixed.error), /混传/);
  }
  const home = {
    ...board,
    name: "首页",
    html: ('<img src="' + photoUrl + '">').repeat(7),
  };
  const state = {
    ...board,
    name: "异常态",
    html: '<main style="background:url(' + photoUrl + ')"></main>',
    css: ('.a{background:image-set("' + photoUrl + '" 1x)}').repeat(5),
  };
  const over = await submit({ reply: "多图", artboards: [home, state] });
  assert.equal(over.ok, false);
  for (const term of ["13", "12", "首页", "异常态"])
    assert.ok(String(over.error).includes(term));
  const asset = "img-" + "a".repeat(64);
  ctx.document.images = {
    [asset]: { name: "logo", data: photoData, width: 1, height: 1 },
  };
  const reference = `<div DATA-FORMA-ASSET-ID="${asset}"></div>`;
  const existingAssets = await submit({
    reply: "已有资源",
    artboards: [
      { ...home, html: reference.repeat(7) },
      { ...state, html: reference.repeat(6), css: "" },
    ],
  });
  assert.match(String(existingAssets.error), /13.*12.*首页 7.*异常态 6/);
  const overlap = await submit({
    reply: "同一位置",
    artboards: [
      { ...home, html: reference.repeat(11) },
      {
        ...state,
        html: `<img src="${photoData}" data-forma-asset-id="${asset}" data-stock-query="logo" style="background-image:url('${photoData}')">`,
        css: "",
      },
    ],
  });
  assert.equal(overlap.ok, true, String(overlap.error));
  const atLimit = await executor.executeAsync(
    "propose_html_design",
    {
      reply: "十二个位置",
      artboards: [home, { ...state, html: "<main>状态</main>" }],
    },
    { allowNetworkMedia: false },
  );
  assert.equal(atLimit.ok, true, String(atLimit.error));
  assert.equal(atLimit.imagesLocalized, 12);
});

test("HTML preflight reports the board, component and invalid explicit field before publishing a draft", async () => {
  const { ctx, lib } = fixture();
  const component = lib.components[0];
  ctx.document.libraries!.other = {
    ...lib,
    id: "other",
    components: [{ ...component, id: "different", name: "Different" }],
  };
  const executor = new FormaToolExecutor({ ...ctx, selection: null });
  const resolved = await executor.executeAsync(
    "propose_html_design",
    htmlProposal,
  );
  assert.equal(resolved.ok, true);
  const previous = executor.latestHtmlDraft;
  const badSlot = (key: string) =>
    JSON.stringify({
      slots: {
        [key]: {
          libraryId: lib.id,
          componentId: "missing",
          variantId: "unknown",
        },
      },
    });
  component.exposed = [
    {
      kind: "text",
      id: "label",
      name: "Label",
      target: component.variants[0].nodes[0].templateKey!,
    },
    {
      kind: "swap",
      id: "icon",
      name: "Icon",
      target: component.variants[0].nodes[0].templateKey!,
    },
  ];
  for (const [attr, value, reason] of [
    ["data-library", "uninstalled", "data-library"],
    ["data-library", "other", "data-library"],
    ["data-variant", "missing", "data-variant"],
    ["data-overrides", "{", "JSON"],
    ["data-variant-props", "{", "JSON"],
    ["data-overrides", badSlot("absent"), "slots.absent"],
    ["data-overrides", badSlot("label"), "slots.label"],
    ["data-overrides", badSlot("icon"), "找不到替换"],
  ]) {
    const result = await executor.executeAsync("propose_html_design", {
      ...htmlProposal,
      html: `<div data-forma-component="${component.id}" ${attr}='${value}'></div>`,
    });
    assert.equal(result.ok, false);
    for (const term of [htmlProposal.name, component.id, reason])
      assert.ok(String(result.error).includes(term), String(result.error));
    assert.equal(executor.latestHtmlDraft, previous);
  }
});

test("forced HTML mode with a selection exposes and executes only the scoped Blueprint proposal", async () => {
  const { ctx } = fixture();
  let calls = 0;
  const result = await runDesignChat(
    { ...ctx, generationMode: "html" },
    {
      adapterConfig: config(),
      providerName: "fixture",
      signal,
      maxToolTurns: 1,
      fetchImpl: async (_url, init) => {
        calls++;
        const body = JSON.parse(String(init?.body));
        const names = body.tools.map(
          (t: { function: { name: string } }) => t.function.name,
        );
        assert.ok(names.includes("propose_design_changes"));
        assert.ok(!names.includes("propose_html_design"));
        assert.doesNotMatch(
          body.messages[0].content,
          /HTML-First|propose_html_design/,
        );
        return openAI({
          tool_calls: [
            toolCall("edit", "propose_design_changes", {
              mode: "edit",
              reply: "已修改",
              edits: [
                { op: "update", id: ctx.selection, patch: { name: "已修改" } },
              ],
            }),
          ],
        });
      },
    },
  );
  assert.equal(calls, 1);
  const next = transact(ctx.document, result.transaction!);
  assert.equal(next.nodes.find((n) => n.id === ctx.selection)?.name, "已修改");
});

test("single HTML board cannot discard explicit identity when a scope is confirmed", async () => {
  const screen = { ...scopeInput.screens[0], role: "primary" as const };
  const executor = new FormaToolExecutor({
    ...fixture().ctx,
    selection: null,
    confirmedScope: {
      screens: [screen],
      summary: "支付",
      reusedAssets: [],
      customModules: [],
    },
  });
  const submit = (patch: Record<string, unknown>) =>
    executor.executeAsync("propose_html_design", {
      ...htmlProposal,
      ...screen,
      ...patch,
    });
  assert.match(String((await submit({ refId: "other" })).error), /refId/);
  assert.match(String((await submit({ role: "detail" })).error), /role/);
  assert.equal((await submit({})).ok, true);
  assert.equal(executor.latestHtmlDraft?.artboards?.[0].refId, screen.refId);
});

test("single-board critique counts the pictures on retained sibling boards before localizing a revision", async () => {
  const htmlDraft = {
    ...htmlProposal,
    summary: "首页与空状态",
    artboards: [
      { ...htmlProposal, refId: "home", role: "primary" as const },
      {
        ...htmlProposal,
        name: "空状态",
        refId: "empty",
        role: "exception" as const,
        parentRef: "home",
        html: ('<img src="' + photoData + '">').repeat(7),
      },
    ],
  };
  let rounds = 0;
  const result = await runVisualCritique(
    { prompt: "仅修改首页", htmlDraft, renderedImageDataUrl: photoData },
    {
      adapterConfig: config(),
      providerName: "fixture",
      signal,
      fetchImpl: async (url, init) => {
        assert.notEqual(String(url), photoUrl);
        if (++rounds === 1)
          return openAI({
            tool_calls: [
              toolCall("update", "propose_html_design", {
                ...htmlProposal,
                html: ('<img SRC="' + photoUrl + '">').repeat(6),
              }),
            ],
          });
        assert.match(
          JSON.parse(JSON.parse(String(init?.body)).messages.at(-1).content)
            .error,
          /13.*12.*晨间咖啡.*空状态/,
        );
        return openAI({ content: "保留原稿" });
      },
    },
  );
  assert.equal(result.improved, false);
  assert.equal(result.htmlDraft, htmlDraft);
});

test("same-name HTML boards receive stable unique IDs and can be refined in reverse screenshot order", async () => {
  const executor = new FormaToolExecutor({ ...fixture().ctx, selection: null });
  const input = {
    reply: "创建",
    artboards: [
      htmlProposal,
      htmlProposal,
      { ...htmlProposal, refId: "board-1" },
    ],
  };
  for (let i = 0; i < 2; i++) {
    assert.equal(
      (await executor.executeAsync("propose_html_design", input)).ok,
      true,
    );
    assert.deepEqual(
      executor.latestHtmlDraft!.artboards!.map((b) => b.refId),
      ["board-2", "board-3", "board-1"],
    );
  }
  const htmlDraft = executor.latestHtmlDraft!;
  const boards = htmlDraft.artboards!;
  const result = await runVisualCritique(
    {
      prompt: "审阅",
      htmlDraft,
      renderedImages: boards
        .map(({ name, refId }) => ({ name, refId, dataUrl: photoData }))
        .reverse(),
    },
    {
      adapterConfig: config(),
      providerName: "fixture",
      signal,
      fetchImpl: async () =>
        openAI({
          tool_calls: [
            toolCall("one", "propose_html_design", {
              ...htmlProposal,
              refId: boards[1].refId,
              html: "<main>只修改中间的画板，另外两张保留</main>",
            }),
          ],
        }),
    },
  );
  assert.equal(result.improved, true);
  assert.deepEqual(result.htmlDraft!.artboards![0], boards[0]);
  assert.match(result.htmlDraft!.artboards![1].html, /只修改中间/);
  assert.deepEqual(result.htmlDraft!.artboards![2], boards[2]);
});
