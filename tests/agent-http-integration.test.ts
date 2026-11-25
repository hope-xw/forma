import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { randomInt, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request, type IncomingMessage } from "node:http";
import { registerHooks } from "node:module";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { duplexPair } from "node:stream";
import test, { type TestContext } from "node:test";
import { DOMParser } from "@xmldom/xmldom";
import { createAgentRequestHandler } from "../server/agent-http";
import { resolveMcpSession } from "../server/mcp";
import { SkillRegistry } from "../server/skill-registry";
import type { ExternalChatRequest } from "../src/editor/AgentPanel";
import type { AgentChatRequest } from "../src/editor/agent-client";
import type { AgentChatResult } from "../src/agent/design-engine";
import { validateProposal } from "../src/agent/provider";
import type { SkillSummary } from "../src/agent/skills";
import { transact } from "../src/domain/commands";
import { createLibraryFromSelection } from "../src/domain/library";
import { createStarter } from "../src/domain/seed";

const origin = "forma://app";
const craft = "forma-design-system-craft";
const audit = "mobile-h5-accessibility-audit";
const apiKey = "sk-test-http-fixture-12345678";
const model = "deepseek-flash";
const deepseek = { providerId: "deepseek", apiKey, selectedModel: model };
const noUpstream: typeof fetch = async () =>
  assert.fail("Unexpected upstream request");

function fixture(
  t: TestContext,
  fetchImpl = noUpstream,
  env: NodeJS.ProcessEnv = {},
) {
  const directory = mkdtempSync(path.join(tmpdir(), "forma-agent-http-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const configDir = path.join(directory, "config");
  const workspaceDir = path.join(directory, "workspace");
  const externalDir = path.join(directory, "external");
  const handler = createAgentRequestHandler({
    configDir,
    workspaceDir,
    env,
    fetchImpl,
    skillRegistry: new SkillRegistry({
      configDir,
      workspaceDir,
      externalDirs: [externalDir],
    }),
  });
  const server = createServer(handler);

  // Node's HTTP client and server exchange complete HTTP/1.1 messages over a
  // fresh duplex connection. This exercises both parsers without opening a port.
  async function send(
    method: string,
    route: string,
    body?: string,
    headers: Record<string, string> = {},
  ) {
    const response = await new Promise<IncomingMessage>((resolve, reject) => {
      const req = request(
        {
          method,
          path: "/api/agent" + route,
          headers: { origin, connection: "close", ...headers },
          createConnection() {
            const [client, peer] = duplexPair();
            server.emit("connection", peer);
            return client;
          },
        },
        resolve,
      );
      req.on("error", reject);
      req.end(body);
    });
    const chunks: Buffer[] = [];
    for await (const chunk of response) chunks.push(chunk);
    return {
      status: response.statusCode,
      headers: response.headers,
      text: Buffer.concat(chunks).toString("utf8"),
    };
  }

  async function json(
    method: string,
    route: string,
    input?: unknown,
    status = 200,
  ) {
    const response = await send(
      method,
      route,
      JSON.stringify(input),
      input === undefined
        ? {}
        : { "content-type": "application/json; charset=utf-8" },
    );
    assert.equal(
      response.status,
      status,
      method + " " + route + " " + response.text,
    );
    assert.match(
      response.headers["content-type"] ?? "",
      /^application\/json\b/,
    );
    assert.ok(
      !response.text.includes(apiKey),
      "Response contains the unmasked fixture key",
    );
    return JSON.parse(response.text);
  }
  return { send, json, directory, workspaceDir, externalDir };
}

test("detect rejects a generic sk- key before making any upstream request", async (t) => {
  const upstream = t.mock.fn(noUpstream);
  const { json } = fixture(t, upstream);
  const result = await json(
    "POST",
    "/detect",
    { providerId: "auto", apiKey },
    400,
  );
  assert.deepEqual(result, {
    error: "无法仅凭密钥前缀唯一识别供应商，请先选择模型供应商后再连接",
  });
  assert.equal(upstream.mock.callCount(), 0);
});

test("DeepSeek refresh preserves the selected model's overrides and clearing them restores refreshed metadata", async (t) => {
  let contextWindow = 1_000_000;
  const upstream = t.mock.fn<typeof fetch>(async (url, init) => {
    assert.equal(String(url), "https://api.deepseek.com/v1/models");
    assert.equal(
      new Headers(init?.headers).get("authorization"),
      "Bearer " + apiKey,
    );
    return Response.json({
      data: [
        {
          id: model,
          context_window: contextWindow,
          input_modalities: ["text", "image"],
        },
        ...(contextWindow === 1_000_000 ? [] : [{ id: "deepseek-v4-pro" }]),
      ],
    });
  });
  const { json } = fixture(t, upstream);
  const { profile } = await json("POST", "/profiles", {
    ...deepseek,
    capabilityOverrides: null,
  });
  const route = "/profiles/" + profile.id;
  const { activeProfile } = await json("GET", "/status");
  assert.equal(activeProfile.id, profile.id);
  assert.equal(activeProfile.selectedModel, model);
  assert.equal(activeProfile.capabilities.maxContextTokens, 1_000_000);
  assert.equal(activeProfile.capabilities.supportsVision, true);
  assert.equal(activeProfile.capabilities.capabilitySource, "provider-api");

  const overrides = { supportsVision: false, maxContextTokens: 8192 };
  const patched = await json("PATCH", route, {
    capabilityOverrides: overrides,
  });
  assert.deepEqual(patched.profile.activeModelOverrides, overrides);
  contextWindow = 1_200_000;
  const refreshed = await json("POST", route + "/refresh");
  assert.equal(upstream.mock.callCount(), 2);
  assert.equal(refreshed.profile.selectedModel, model);
  assert.ok(
    refreshed.profile.models.some(
      (m: { id: string }) => m.id === "deepseek-v4-pro",
    ),
  );
  assert.deepEqual(refreshed.profile.modelOverrides, { [model]: overrides });
  assert.equal(
    refreshed.profile.capabilities.capabilitySource,
    "user-override",
  );
  assert.equal(refreshed.profile.capabilities.maxContextTokens, 8192);
  assert.equal(refreshed.profile.capabilities.supportsVision, false);
  assert.deepEqual(refreshed.status.activeProfile, refreshed.profile);

  const cleared = await json("PATCH", route, { capabilityOverrides: null });
  assert.equal(cleared.profile.modelOverrides, undefined);
  assert.equal(cleared.profile.capabilities.capabilitySource, "provider-api");
  assert.equal(cleared.profile.capabilities.maxContextTokens, contextWindow);
  assert.equal(cleared.profile.capabilities.supportsVision, true);
  assert.deepEqual(
    (await json("GET", "/status")).activeProfile,
    cleared.profile,
  );
  assert.equal(upstream.mock.callCount(), 2);
});

test("create and credential rotation apply overrides to their selected model", async (t) => {
  const keys: (string | null)[] = [];
  const { json } = fixture(t, async (_url, init) => {
    keys.push(new Headers(init?.headers).get("authorization"));
    return Response.json({ data: [{ id: model }, { id: "deepseek-chat" }] });
  });
  const overrides = {
    supportsTools: false,
    isReasoning: false,
    maxOutputTokens: 1024,
    structuredOutput: "prompt_json",
  };
  const created = await json("POST", "/profiles", {
    ...deepseek,
    capabilityOverrides: overrides,
  });
  assert.deepEqual(created.profile.activeModelOverrides, overrides);
  const route = "/profiles/" + created.profile.id;
  const otherOverrides = { maxContextTokens: 32768 };
  const rotated = await json("PATCH", route, {
    apiKey: "rotated-fixture",
    baseUrl: "https://fixture.invalid/v1",
    selectedModel: "deepseek-chat",
    capabilityOverrides: otherOverrides,
  });
  assert.equal(rotated.profile.baseUrl, "https://fixture.invalid/v1");
  assert.deepEqual(rotated.profile.modelOverrides, {
    [model]: overrides,
    "deepseek-chat": otherOverrides,
  });
  assert.equal(rotated.profile.capabilities.maxContextTokens, 32768);
  const cleared = await json("PATCH", route, {
    baseUrl: "https://fixture.invalid/v1",
    capabilityOverrides: null,
  });
  assert.deepEqual(cleared.profile.modelOverrides, { [model]: overrides });
  assert.deepEqual(keys, [
    "Bearer " + apiKey,
    "Bearer rotated-fixture",
    "Bearer rotated-fixture",
  ]);
});

test("an in-flight refresh cannot restore the old gateway after credential rotation", async (t) => {
  let started!: () => void;
  let release!: () => void;
  const probing = new Promise<void>((resolve) => {
    started = resolve;
  });
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  const { json } = fixture(t, async () => {
    if (++calls === 2) {
      started();
      await pending;
    }
    return Response.json({ data: [{ id: model }] });
  });
  const { profile } = await json("POST", "/profiles", deepseek);
  const route = "/profiles/" + profile.id;
  const refresh = json("POST", route + "/refresh", undefined, 409);
  await probing;
  try {
    await json("PATCH", route, {
      apiKey: "rotated-fixture",
      baseUrl: "https://rotated.invalid/v1",
    });
  } finally {
    release();
    await refresh;
  }
  assert.equal(
    (await json("GET", "/status")).activeProfile.baseUrl,
    "https://rotated.invalid/v1",
  );
});

test("refresh rejects missing and read-only profiles and redacts saved keys from probe errors", async (t) => {
  let status = 200;
  const upstream = t.mock.fn(async () =>
    Response.json({ data: [{ id: model }] }, { status }),
  );
  const { json } = fixture(t, upstream, {
    MODEL_BASE_URL: "https://fixture.invalid/v1",
    MODEL_API_KEY: apiKey,
    MODEL_ID: model,
  });
  const initial = await json("GET", "/status");
  assert.match(
    (
      await json(
        "POST",
        "/profiles/" + initial.activeProfile.id + "/refresh",
        undefined,
        400,
      )
    ).error,
    /只读/,
  );
  assert.match(
    (await json("POST", "/profiles/missing/refresh", undefined, 400)).error,
    /不存在/,
  );
  assert.equal(upstream.mock.callCount(), 0);

  // This short saved key also occurs in the upstream HTTP status in the probe error.
  const { profile } = await json("POST", "/profiles", {
    ...deepseek,
    apiKey: "401",
  });
  status = 401;
  const failure = await json(
    "POST",
    "/profiles/" + profile.id + "/refresh",
    {},
    400,
  );
  assert.match(failure.error, /鉴权失败/);
  assert.doesNotMatch(failure.error, /401/);
  assert.deepEqual((await json("GET", "/status")).activeProfile, profile);
});

const skillMd = (name: string) =>
  "---\nname: " + name + "\ndescription: 排版规范\n---\n按参考文档设置标题。";
const ids = (skills: SkillSummary[]) => skills.map((skill) => skill.id).sort();

test("skills can be imported with references, inspected, toggled and deleted through HTTP", async (t) => {
  const { json } = fixture(t);
  const initial = await json("GET", "/skills");
  assert.deepEqual(ids(initial.skills), [craft, audit]);
  assert.ok(
    initial.skills.every(
      (s: SkillSummary) => s.source === "builtin" && s.enabled,
    ),
  );
  assert.equal(initial.settings.scanExternalStandardDirs, false);

  const name = "team-typography";
  const resource = "references/guide.md";
  const imported = await json("POST", "/skills/import", {
    skillMd: skillMd(name),
    slug: "team-import",
    resources: [{ path: resource, content: "Use a 24px heading." }],
  });
  assert.equal(imported.skill.source, "user");
  assert.equal(imported.skill.id, name);
  assert.equal(imported.skills.length, 3);
  const route = "/skills/" + name;
  const { skill } = await json("GET", route);
  assert.match(skill.instructions, /按参考文档设置标题/);
  assert.deepEqual(skill.resources, [resource]);
  for (const enabled of [false, true]) {
    const list = await json("PATCH", route, { enabled });
    assert.equal(
      list.skills.find((s: SkillSummary) => s.id === name).enabled,
      enabled,
    );
    assert.equal((await json("GET", route)).skill.enabled, enabled);
  }
  await json("PATCH", route, { enabled: "false" }, 400);
  assert.deepEqual(ids((await json("DELETE", route)).skills), [craft, audit]);
  await json("GET", route, undefined, 404);
  assert.match(
    (await json("DELETE", "/skills/" + craft, undefined, 400)).error,
    /仅可删除用户/,
  );
});

test("rescan, directory import and both settings methods use only the chosen skill roots", async (t) => {
  const { directory, workspaceDir, externalDir, json } = fixture(t);
  function writeSkill(parent: string, name: string) {
    const dir = path.join(parent, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "SKILL.md"), skillMd(name));
    return dir;
  }
  const localDirPath = writeSkill(directory, "local-brand");
  writeSkill(path.join(workspaceDir, ".forma", "skills"), "workspace-brand");
  writeSkill(externalDir, "external-brand");
  const scan = await json("POST", "/skills/rescan");
  assert.deepEqual(ids(scan.skills), [craft, audit, "workspace-brand"]);
  await json(
    "POST",
    "/skills/import",
    { localDirPath, skillMd: skillMd("ambiguous") },
    400,
  );
  assert.equal(
    (await json("POST", "/skills/import", { localDirPath })).skill.id,
    "local-brand",
  );
  const enabled = await json("POST", "/skills/settings", {
    scanExternalStandardDirs: true,
  });
  assert.equal(enabled.settings.scanExternalStandardDirs, true);
  assert.equal(
    enabled.skills.find((s: SkillSummary) => s.id === "external-brand").source,
    "external-standard",
  );
  const disabled = await json("PATCH", "/skills/settings", {
    scanExternalStandardDirs: false,
  });
  assert.equal(disabled.settings.scanExternalStandardDirs, false);
  assert.ok(!ids(disabled.skills).includes("external-brand"));
  await json("POST", "/skills/settings", { scanExternalStandardDirs: 1 }, 400);
  for (const action of ["rescan", "import", "settings"]) {
    await json("GET", "/skills/" + action, undefined, 404);
  }
});

test("refresh and rescan accept an untyped empty POST and require JSON for every nonempty body", async (t) => {
  const { json, send } = fixture(t, async () =>
    Response.json({ data: [{ id: model }] }),
  );
  const { profile } = await json("POST", "/profiles", deepseek);
  for (const route of [
    "/skills/rescan",
    "/profiles/" + profile.id + "/refresh",
  ]) {
    await json("POST", route);
    await json("POST", route, {});
    assert.equal(
      (await send("POST", route, undefined, { "transfer-encoding": "chunked" }))
        .status,
      200,
    );
    assert.equal((await send("POST", route, "{}")).status, 415);
    assert.equal(
      (await send("POST", route, " ", { "transfer-encoding": "chunked" }))
        .status,
      415,
    );
    assert.equal(
      (await send("POST", route, "{}", { "content-type": "text/plain" }))
        .status,
      415,
    );
    assert.equal(
      (await send("POST", route, "{", { "content-type": "application/json" }))
        .status,
      400,
    );
  }
});

test("every new mutating route rejects a foreign Origin before parsing or probing", async (t) => {
  const upstream = t.mock.fn(noUpstream);
  const { send } = fixture(t, upstream);
  for (const [method, route] of [
    ["POST", "/profiles/missing/refresh"],
    ["POST", "/skills/rescan"],
    ["POST", "/critique"],
    ["POST", "/library-playbook"],
    ["POST", "/skills/import"],
    ["POST", "/skills/settings"],
    ["PATCH", "/skills/settings"],
    ["PATCH", "/skills/" + craft],
    ["DELETE", "/skills/" + craft],
  ]) {
    const response = await send(method, route, undefined, {
      origin: "https://foreign.invalid",
    });
    assert.equal(response.status, 403, method + " " + route);
    assert.match(JSON.parse(response.text).error, /来源/);
  }
  assert.equal(upstream.mock.callCount(), 0);
});

const toolCall = (index: number, name: string, args: unknown) => ({
  index,
  id: name,
  type: "function",
  function: { name, arguments: JSON.stringify(args) },
});
function streamedDelta(delta: unknown) {
  const event = JSON.stringify({ choices: [{ delta }] });
  return new Response("data: " + event + "\n\ndata: [DONE]\n\n", {
    headers: { "content-type": "text/event-stream" },
  });
}

for (const transport of ["SSE chat", "JSON chat", "generate"] as const) {
  test(
    transport +
      " returns the validated transaction, tool trace, skills and diagnostics",
    async (t) => {
      const document = createStarter();
      const selection = document.nodes[0].id;
      const libraryDocument = createStarter();
      const lib = createLibraryFromSelection(
        libraryDocument,
        libraryDocument.nodes[0].id,
        "Team library",
      );
      document.libraries = { [lib.id]: lib };
      const context = { prompt: "根据规范更新画板名称", document, selection };
      let round = 0;
      const { json, send } = fixture(t, async (url, init) => {
        if (String(url).endsWith("/models"))
          return Response.json({ data: [{ id: "gpt-4.1" }] });
        assert.equal(String(url), "https://api.openai.com/v1/chat/completions");
        const body = JSON.parse(String(init?.body));
        assert.equal(body.stream, true);
        switch (++round) {
          case 1:
            assert.ok(
              body.tools.some(
                (tool: { function: { name: string } }) =>
                  tool.function.name === "activate_skill",
              ),
            );
            if (transport !== "generate")
              assert.match(body.messages[0].content, /44×44pt/);
            return streamedDelta({
              tool_calls: [
                toolCall(0, "search_components", {
                  query: lib.components[0].name,
                }),
                toolCall(1, "activate_skill", { name: craft }),
              ],
            });
          case 2: {
            const results = body.messages.filter(
              (m: { role: string }) => m.role === "tool",
            );
            assert.equal(results[0].tool_call_id, "search_components");
            assert.equal(
              JSON.parse(results[0].content).components[0].componentId,
              lib.components[0].id,
            );
            assert.equal(results[1].tool_call_id, "activate_skill");
            assert.match(JSON.parse(results[1].content).instructions, /8px/);
            return streamedDelta({
              tool_calls: [
                toolCall(0, "propose_design_changes", {
                  mode: "edit",
                  reply: "画板已重命名",
                  edits: [
                    {
                      op: "update",
                      id: selection,
                      patch: { name: "结账页面" },
                    },
                  ],
                }),
              ],
            });
          }
          case 3: {
            const receipt = JSON.parse(body.messages.at(-1).content);
            assert.equal(receipt.ok, true, JSON.stringify(receipt));
            assert.equal(typeof receipt.lintSummary.issueCount, "number");
            assert.ok(Array.isArray(receipt.lintSummary.topIssues));
            return streamedDelta({ content: "已完成" });
          }
          default:
            assert.fail("Unexpected model turn");
        }
      });
      await json("POST", "/profiles", { providerId: "openai", apiKey });
      const timeouts = t.mock.method(AbortSignal, "timeout");
      const input = { ...context, activeSkills: [audit] };
      const expectedTools = [
        "search_components",
        "activate_skill",
        "propose_design_changes",
      ];
      let result: AgentChatResult;
      if (transport === "SSE chat") {
        const sse = await send("POST", "/chat", JSON.stringify(input), {
          "content-type": "application/json",
          accept: "text/event-stream",
        });
        assert.equal(sse.status, 200);
        assert.match(
          sse.headers["content-type"] ?? "",
          /^text\/event-stream\b/,
        );
        const events = sse.text
          .trimEnd()
          .split("\n\n")
          .map((frame) => {
            const match = /^event: (\w+)\ndata: (.+)$/.exec(frame);
            assert.ok(match, frame);
            return { event: match[1], data: JSON.parse(match[2]) };
          });
        assert.deepEqual(
          events.filter((e) => e.event !== "progress").map((e) => e.event),
          ["result"],
          sse.text,
        );
        assert.deepEqual(
          events
            .filter(
              (e) =>
                e.event === "progress" && expectedTools.includes(e.data.detail),
            )
            .map((e) => e.data.detail),
          expectedTools,
        );
        assert.equal(events.at(-1)?.event, "result");
        result = events.at(-1)!.data;
      } else if (transport === "JSON chat") {
        result = await json("POST", "/chat", input);
      } else {
        result = await json("POST", "/generate", context);
      }
      assert.equal(round, 3);
      assert.deepEqual(
        timeouts.mock.calls.map((call) => call.arguments[0]),
        [transport === "generate" ? 180_000 : 240_000, 240_000],
      );
      const next = transact(
        document,
        validateProposal(context, result.transaction),
      );
      assert.equal(next.revision, document.revision + 1);
      assert.equal(
        next.nodes.find((node) => node.id === selection)?.name,
        "结账页面",
      );
      assert.deepEqual(
        result.toolTrace?.map((tool) => [tool.name, tool.status]),
        expectedTools.map((name) => [name, "ok"]),
      );
      assert.deepEqual(
        result.activatedSkills,
        transport === "generate" ? [craft] : [audit, craft],
      );
      assert.deepEqual(result.diagnostics, []);
    },
  );
}

const draftInput = {
  name: "咖啡首页",
  width: 390,
  height: 844,
  reply: "已完成排版",
  html: '<main><i data-icon="coffee"></i><h1>咖啡</h1></main>',
  css: "main{padding:20px}",
};
const screenshot =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jB1kAAAAASUVORK5CYII=";

for (const format of ["JSON", "SSE"]) {
  test(
    format +
      " chat returns a localized HTML draft for the requested generation mode",
    async (t) => {
      let round = 0;
      const { send, json } = fixture(t, async (url, init) => {
        if (String(url).endsWith("/models"))
          return Response.json({ data: [{ id: "gpt-4.1" }] });
        const body = JSON.parse(String(init?.body));
        assert.match(body.messages[0].content, /HTML-First Modern Engine/);
        if (++round === 1)
          return streamedDelta({
            tool_calls: [
              toolCall(0, "propose_html_design", {
                ...draftInput,
                html: draftInput.html + '<img src="' + screenshot + '">',
              }),
            ],
          });
        assert.equal(JSON.parse(body.messages.at(-1).content).iconsHydrated, 1);
        return streamedDelta({ content: "可以预览咖啡首页。" });
      });
      await json("POST", "/profiles", { providerId: "openai", apiKey });
      const document = createStarter();
      const input = {
        prompt: "新建咖啡首页",
        document,
        selection: null,
        generationMode: "html",
      };
      let result: AgentChatResult;
      if (format === "JSON") result = await json("POST", "/chat", input);
      else {
        const response = await send("POST", "/chat", JSON.stringify(input), {
          "content-type": "application/json",
          accept: "text/event-stream",
        });
        assert.equal(response.status, 200);
        assert.match(response.headers["content-type"]!, /text\/event-stream/);
        assert.match(
          response.text,
          /event: progress\ndata: .*propose_html_design/,
        );
        const frame = response.text.trimEnd().split("\n\n").at(-1)!;
        assert.match(frame, /^event: result\ndata: /);
        result = JSON.parse(frame.split("\ndata: ")[1]);
      }
      assert.equal(round, 2);
      assert.equal(result.reply, "可以预览咖啡首页。");
      assert.equal(result.mode, "generate");
      assert.equal(result.transaction, undefined);
      assert.deepEqual(result.createdRootIds, []);
      assert.deepEqual(result.stats, {
        created: 0,
        updated: 0,
        removed: 0,
        componentsInserted: 0,
        tokensBound: 0,
      });
      assert.deepEqual(result.diagnostics, []);
      assert.deepEqual(result.activatedSkills, []);
      assert.deepEqual(
        result.toolTrace?.map((t) => [t.name, t.status]),
        [["propose_html_design", "ok"]],
      );
      assert.match(result.htmlDraft!.html, /<svg\b/);
      assert.match(result.htmlDraft!.html, /data-forma-asset-id="img-/);
      assert.equal(result.htmlDraft?.imagesLocalized, 1);
    },
  );
}

test("critique HTTP uses the selected profile, enforces PNG input and deadline, and redacts provider errors", async (t) => {
  let requests = 0;
  const { json } = fixture(t, async (url, init) => {
    if (String(url).endsWith("/models"))
      return Response.json({ data: [{ id: "gpt-4.1" }] });
    requests++;
    if (requests > 1) throw new Error("Fixture failure for " + apiKey);
    const body = JSON.parse(String(init?.body));
    assert.equal(body.model, "gpt-4.1");
    assert.equal(
      body.messages[1].content.find(
        (p: { type: string }) => p.type === "image_url",
      ).image_url.url,
      screenshot,
    );
    assert.ok(init?.signal);
    return Response.json({
      choices: [
        {
          message: {
            tool_calls: [
              toolCall(0, "propose_html_design", {
                ...draftInput,
                css: "main{padding:24px}",
                reply: "增加卡片边距。\n加深照片上的遮罩。",
              }),
            ],
          },
        },
      ],
    });
  });
  const input = {
    prompt: "检查画板",
    htmlDraft: { ...draftInput, summary: "咖啡首页初稿" },
    renderedImageDataUrl: screenshot,
  };
  await json("POST", "/critique", input, 503);
  await json("POST", "/profiles", { providerId: "openai", apiKey });
  await json(
    "POST",
    "/critique",
    {
      ...input,
      renderedImageDataUrl: "https://example.invalid/screenshot.png",
    },
    400,
  );
  const timeouts = t.mock.method(AbortSignal, "timeout");
  const result = await json("POST", "/critique", input);
  assert.equal(result.ok, true);
  assert.equal(result.improved, true);
  assert.equal(result.modelUsed, "gpt-4.1");
  assert.deepEqual(result.critiqueNotes, [
    "增加卡片边距。",
    "加深照片上的遮罩。",
  ]);
  assert.match(result.htmlDraft.css, /padding:24px/);
  assert.ok(timeouts.mock.calls.some((c) => c.arguments[0] === 240_000));
  const error = await json("POST", "/critique", input, 400);
  assert.match(error.error, /••••/);
  assert.equal(requests, 2);
});

test("library playbook validates the portable snapshot and regenerates offline with authored guidance", async (t) => {
  const upstream = t.mock.fn(noUpstream);
  const { json } = fixture(t, upstream);
  const doc = createStarter();
  const lib = createLibraryFromSelection(doc, doc.nodes[0].id, "订单组件库");
  lib.components[0].name = "断网提示";
  lib.components[0].assetTier = "block";
  const result = await json("POST", "/library-playbook", {
    library: lib,
    existingGuide: { summary: "支付设计规范", platform: "H5" },
  });
  assert.equal(result.ok, true);
  assert.equal(result.manifest.libraryId, lib.id);
  assert.deepEqual(result.manifest.tierCounts, {
    page: 0,
    block: 1,
    component: 0,
  });
  assert.equal(
    result.manifest.exceptionComponents[0].componentId,
    lib.components[0].id,
  );
  assert.equal(result.aiGuide.summary, "支付设计规范");
  assert.equal(result.aiGuide.platform, "H5");
  assert.equal(result.markdown, result.aiGuide.playbookMarkdown);
  assert.match(result.markdown, /异常与边界态对照表/);
  await json("POST", "/library-playbook", { library: {} }, 400);
  await json(
    "POST",
    "/library-playbook",
    { library: lib, existingGuide: { revision: -1 } },
    400,
  );
  assert.equal(upstream.mock.callCount(), 0);
});

for (const format of ["JSON", "SSE"]) {
  test(
    format +
      " chat carries the memory and target scope through confirmation and a full HTML matrix",
    async (t) => {
      const document = createStarter();
      const library = createLibraryFromSelection(
        document,
        document.nodes[0].id,
        "结账规范",
      );
      document.libraries = { [library.id]: library };
      const memoryScope = {
        projectId: "shop",
        userId: "designer",
        libraryId: library.id,
      };
      const request = {
        document,
        selection: null,
        targetLibraryId: library.id,
        memoryScope,
        prompt: "规划购物流程",
      };
      const screens = [
        {
          refId: "home",
          role: "primary",
          name: "订单",
          width: 390,
          height: 844,
          summary: "所有订单",
        },
        {
          refId: "empty",
          role: "exception",
          parentRef: "home",
          name: "空订单",
          width: 390,
          height: 320,
          summary: "没有订单",
        },
      ];
      const scope = {
        summary: "订单含空态",
        targetLibraryId: library.id,
        targetLibraryName: library.name,
        screens,
        reusedAssets: [],
        customModules: [],
      };
      let turns = 0;
      const { json, send } = fixture(t, async (url, init) => {
        if (String(url).endsWith("/models"))
          return Response.json({ data: [{ id: "gpt-4.1" }] });
        const body = JSON.parse(String(init?.body));
        const context = JSON.parse(
          body.messages[1].content.split("Context (JSON)\n")[1],
        );
        assert.deepEqual(context.memoryScope, memoryScope);
        assert.equal(context.targetLibraryId, library.id);
        assert.deepEqual(context.confirmedScope, turns ? scope : null);
        const names = body.tools.map(
          (t: { function: { name: string } }) => t.function.name,
        );
        assert.equal(names.includes("propose_scope_plan"), turns === 0);
        if (turns)
          assert.ok(
            body.messages[0].content.includes(
              JSON.stringify(context.confirmedScope),
            ),
          );
        switch (++turns) {
          case 1:
            return streamedDelta({
              tool_calls: [
                toolCall(0, "propose_scope_plan", {
                  summary: scope.summary,
                  screens,
                  reply: "请确认默认范围。",
                }),
              ],
            });
          case 2:
            return streamedDelta({
              tool_calls: [toolCall(0, "propose_scope_plan", {})],
            });
          case 3:
            assert.match(
              JSON.parse(body.messages.at(-1).content).error,
              /范围已确认/,
            );
            return streamedDelta({
              tool_calls: [toolCall(0, "get_library_playbook", {})],
            });
          case 4:
            assert.equal(
              JSON.parse(body.messages.at(-1).content).libraryId,
              library.id,
            );
            return streamedDelta({
              tool_calls: [
                toolCall(0, "propose_html_design", {
                  reply: "已完成订单与空态",
                  snapLibraryTokens: false,
                  artboards: screens.map(({ summary, ...board }) => ({
                    ...board,
                    html: "<main><h1>" + summary + "</h1></main>",
                  })),
                }),
              ],
            });
          case 5:
            return streamedDelta({ content: "两张画板已完成。" });
          default:
            assert.fail("Unexpected model turn");
        }
      });
      const chat = async (input: unknown): Promise<AgentChatResult> => {
        if (format === "JSON") return json("POST", "/chat", input);
        const res = await send("POST", "/chat", JSON.stringify(input), {
          "content-type": "application/json",
          accept: "text/event-stream",
        });
        assert.equal(res.status, 200);
        assert.match(res.headers["content-type"]!, /text\/event-stream/);
        assert.match(res.text, /event: progress\ndata:/);
        const end = res.text.trimEnd().split("\n\n").at(-1)!;
        assert.match(end, /^event: result\ndata: /, end);
        return JSON.parse(end.split("\ndata: ")[1]);
      };
      await json("POST", "/profiles", { providerId: "openai", apiKey });
      const planned = await chat(request);
      assert.equal(turns, 1);
      assert.equal(planned.mode, "clarify");
      assert.deepEqual(planned.scopeProposal, scope);
      assert.equal(planned.targetLibraryId, library.id);
      assert.equal(planned.htmlDraft, undefined);
      assert.equal(planned.transaction, undefined);
      const result = await chat({
        ...request,
        confirmedScope: planned.scopeProposal,
        prompt: "确认并生成",
      });
      assert.equal(turns, 5);
      assert.equal(result.mode, "generate");
      assert.equal(result.targetLibraryId, library.id);
      const draft = result.htmlDraft!;
      assert.equal(draft.targetLibraryId, library.id);
      assert.equal(draft.snapLibraryTokens, false);
      assert.deepEqual(
        draft.artboards?.map(({ refId, parentRef, role }) => [
          refId,
          parentRef,
          role,
        ]),
        [
          ["home", undefined, "primary"],
          ["empty", "home", "exception"],
        ],
      );
      for (const fields of [
        { targetLibraryId: "" },
        { memoryScope: { projectId: "x".repeat(129) } },
        { confirmedScope: { ...scope, screens: [] } },
        { confirmedScope: { ...scope, extra: 1 } },
      ]) {
        await json("POST", "/chat", { ...request, ...fields }, 400);
      }
      assert.equal(turns, 5);
    },
  );
}

test("critique HTTP revises the first board and retains sibling roles, localized media and token settings", async (t) => {
  const { json } = fixture(t, async (url, init) => {
    if (String(url).endsWith("/models"))
      return Response.json({ data: [{ id: "gpt-4.1" }] });
    const body = JSON.parse(String(init?.body));
    assert.match(body.messages[0].content, /仅审阅首张画板的局部视觉自审/);
    assert.doesNotMatch(
      body.messages[1].content.find(
        (part: { type: string }) => part.type === "text",
      ).text,
      /不应重画/,
    );
    return Response.json({
      choices: [
        {
          message: {
            tool_calls: [
              toolCall(0, "propose_html_design", {
                ...draftInput,
                width: 999,
                height: 888,
                refId: "rewritten",
                role: "detail",
                parentRef: "invalid",
                html: "<main><h1>修订后的首页</h1></main>",
              }),
            ],
          },
        },
      ],
    });
  });
  await json("POST", "/profiles", { providerId: "openai", apiKey });
  const imageId = "img-" + "a".repeat(64);
  const images = {
    [imageId]: { name: "空态插图", data: screenshot, width: 1, height: 1 },
  };
  const first = { ...draftInput, refId: "home", role: "primary" };
  const other = {
    refId: "empty",
    parentRef: "home",
    role: "exception",
    name: "空态",
    width: 390,
    height: 320,
    html: '<main>不应重画<img data-forma-asset-id="' + imageId + '"></main>',
    css: "main{padding:12px}",
    placement: { x: 80, y: 1004 },
    imagesLocalized: 1,
    iconsHydrated: 0,
    componentSlotsResolved: 0,
  };
  const result = await json("POST", "/critique", {
    prompt: "检查首页间距",
    renderedImageDataUrl: screenshot,
    htmlDraft: {
      ...draftInput,
      summary: "两张画板",
      images,
      placement: { x: 80, y: 80 },
      artboards: [first, other],
      targetLibraryId: "shop",
      snapLibraryTokens: false,
    },
  });
  assert.equal(result.improved, true);
  const revised = result.htmlDraft;
  assert.ok(result.critiqueNotes.includes("仅审阅首张画板的局部视觉自审"));
  for (const k of ["width", "height", "refId", "role", "parentRef"] as const)
    assert.equal(
      revised.artboards[0][k],
      (first as Record<string, unknown>)[k],
    );
  assert.match(revised.html, /修订后的首页/);
  assert.equal(revised.artboards[0].html, revised.html);
  assert.equal(revised.artboards[0].refId, "home");
  assert.equal(revised.artboards[0].role, "primary");
  assert.deepEqual(revised.artboards[1], other);
  assert.deepEqual(revised.images, images);
  assert.deepEqual(revised.placement, { x: 80, y: 80 });
  assert.equal(revised.targetLibraryId, "shop");
  assert.equal(revised.snapLibraryTokens, false);
  assert.equal(revised.imagesLocalized, 1);
});

test("legacy generate offers only transaction proposals even on an unselected canvas", async (t) => {
  let turns = 0;
  const { json } = fixture(t, async (url, init) => {
    if (String(url).endsWith("/models"))
      return Response.json({ data: [{ id: "gpt-4.1" }] });
    const body = JSON.parse(String(init?.body));
    const proposals = body.tools
      .map((tool: { function: { name: string } }) => tool.function.name)
      .filter((name: string) => name.startsWith("propose_"));
    assert.deepEqual(proposals, ["propose_design_changes"]);
    if (++turns === 1)
      return streamedDelta({
        tool_calls: [
          toolCall(0, "propose_design_changes", {
            mode: "generate",
            reply: "新增订单画板",
            artboards: [{ type: "frame", name: "订单" }],
          }),
        ],
      });
    return streamedDelta({ content: "已完成" });
  });
  await json("POST", "/profiles", { providerId: "openai", apiKey });
  const result = await json("POST", "/generate", {
    prompt: "创建购物流程",
    document: createStarter(),
    selection: null,
  });
  assert.ok(
    result.transaction.operations.some(
      (op: { type: string }) => op.type === "create",
    ),
  );
  assert.equal(turns, 2);
});

test("default HTTP origin policy enforces loopback port parity on chat and playbooks", async (t) => {
  const { json, send } = fixture(t, async (url) =>
    String(url).endsWith("/models")
      ? Response.json({ data: [{ id: "gpt-4.1" }] })
      : streamedDelta({ content: "设计咨询答复" }),
  );
  await json("POST", "/profiles", { providerId: "openai", apiKey });
  const document = createStarter();
  const host = "127.0.0.1:5174";
  for (const [route, body] of [
    [
      "/library-playbook",
      {
        library: createLibraryFromSelection(
          document,
          document.nodes[0].id,
          "Test",
        ),
      },
    ],
    ["/chat", { prompt: "你好", selection: null, document }],
  ] as const) {
    for (const [origin, status] of [
      ["http://127.0.0.1:9999", 403],
      ["http://" + host, 200],
      ["forma://app", 200],
    ] as const) {
      const res = await send("POST", route, JSON.stringify(body), {
        host,
        origin,
        "content-type": "application/json",
      });
      assert.equal(res.status, status, route + " " + origin + " " + res.text);
    }
  }
});

test("visual critique pairs every screenshot with its HTML and merges revisions into the original board identities", async (t) => {
  const { reply: _reply, ...source } = draftInput;
  const home = {
    ...source,
    refId: "home",
    role: "primary",
    placement: { x: 5, y: 10 },
  };
  const empty = {
    ...source,
    name: "空态",
    refId: "empty",
    role: "exception",
    parentRef: "home",
    height: 320,
    html: "<main>原始空态</main>",
  };
  const images = {
    ["img-" + "1".repeat(64)]: {
      name: "cover",
      data: screenshot,
      width: 1,
      height: 1,
    },
  };
  const input = {
    prompt: "检查全部",
    htmlDraft: {
      ...draftInput,
      summary: "双画板",
      artboards: [home, empty],
      snapLibraryTokens: false,
      targetLibraryId: "shop",
      images,
    },
    renderedImages: [
      {
        name: empty.name,
        refId: empty.refId,
        dataUrl: "data:image/png;base64,AAAA",
      },
      { name: home.name, refId: home.refId, dataUrl: screenshot },
    ],
  };
  let rounds = 0;
  const { json } = fixture(t, async (url, init) => {
    if (String(url).endsWith("/models"))
      return Response.json({ data: [{ id: "gpt-4.1" }] });
    rounds++;
    const content = JSON.parse(String(init?.body)).messages[1].content;
    const prompt = JSON.parse(content[0].text);
    assert.deepEqual(
      prompt.artboards.map((b: { html: string; css: string }) => [
        b.html,
        b.css,
      ]),
      [
        [home.html, home.css],
        [empty.html, empty.css],
      ],
    );
    assert.deepEqual(
      content
        .slice(1)
        .map((part: { image_url: { url: string } }) => part.image_url.url),
      [screenshot, input.renderedImages[0].dataUrl],
    );
    const edit = {
      ...empty,
      role: "primary",
      parentRef: "missing-parent",
      width: 600,
      height: 900,
      html: "<main>已精修空态</main>",
    };
    const revised =
      rounds === 1
        ? {
            artboards: [
              edit,
              { ...home, width: 600, html: "<main>已精修首页</main>" },
            ],
          }
        : {
            name: empty.name,
            refId: empty.refId,
            role: empty.role,
            parentRef: empty.parentRef,
            width: 600,
            height: 900,
            html: "<main>仅精修异常态的边距与对齐</main>",
          };
    return Response.json({
      choices: [
        {
          message: {
            tool_calls: [
              toolCall(0, "propose_html_design", { reply: "完成", ...revised }),
            ],
          },
        },
      ],
    });
  });
  await json("POST", "/profiles", { providerId: "openai", apiKey });
  for (const renderedImages of [
    input.renderedImages.slice(0, 1),
    Array(2).fill(input.renderedImages[0]),
    input.renderedImages.map(({ name, dataUrl }) => ({ name, dataUrl })),
    [
      { ...input.renderedImages[0], dataUrl: "invalid" },
      input.renderedImages[1],
    ],
  ]) {
    await json("POST", "/critique", { ...input, renderedImages }, 400);
  }
  for (const mode of ["matrix", "one"]) {
    const result = await json("POST", "/critique", input);
    assert.equal(result.improved, true);
    const draft = result.htmlDraft;
    assert.deepEqual(draft.images, images);
    assert.equal(draft.targetLibraryId, "shop");
    assert.equal(draft.snapLibraryTokens, false);
    assert.equal(draft.artboards.length, 2);
    for (const [i, original] of [home, empty].entries()) {
      const board: Record<string, unknown> = original;
      for (const k of [
        "name",
        "refId",
        "role",
        "parentRef",
        "width",
        "height",
        "placement",
      ])
        assert.deepEqual(draft.artboards[i][k], board[k]);
    }
    if (mode === "matrix") assert.match(draft.html, /已精修首页/);
    else assert.deepEqual(draft.artboards[0], home);
    assert.match(draft.artboards[1].html, /精修/);
  }
});

const moduleUrl = (source: string) =>
  "data:text/javascript," + encodeURIComponent(source);

function desktopListener(port: number) {
  return moduleUrl(`export const agentServer=()=>({
    once(){}, close(){},
    listen(port,host,ready){if(port!==0||host!=="127.0.0.1")throw Error("expected ephemeral loopback port");ready()},
    address:()=>({port:${port}})
  });`);
}

async function desktopProtocol(
  t: TestContext,
  service: string,
  userData: string,
) {
  const electron = moduleUrl(`
    import { EventEmitter } from "node:events";
    export let handle;
    export const protocol={registerSchemesAsPrivileged(){},handle(_scheme, handler){handle=handler}};
    export const app=Object.assign(new EventEmitter(),{getAppPath:()=>".",getPath:()=>${JSON.stringify(userData)},setName(){},setAboutPanelOptions(){},whenReady:async()=>{}});
    export const BrowserWindow={getAllWindows:()=>[{}]},Menu={setApplicationMenu(){},buildFromTemplate(){}},ipcMain={handle(){}},dialog={},shell={};
  `);
  const hooks = registerHooks({
    resolve(specifier, ctx, next) {
      const url =
        specifier === "electron"
          ? electron
          : specifier === "../out-electron/agent-service.mjs"
            ? service
            : undefined;
      return url ? { url, shortCircuit: true } : next(specifier, ctx);
    },
  });
  t.after(() => hooks.deregister());
  for (const key of ["AGENT_PORT", "FORMA_DEV_URL"]) {
    const saved = process.env[key];
    delete process.env[key];
    t.after(() => {
      if (saved === undefined) delete process.env[key];
      else process.env[key] = saved;
    });
  }
  await import(
    new URL("../electron/main.mjs?test=" + randomUUID(), import.meta.url).href
  );
  const { handle, app } = (await import(electron)) as {
    handle: (request: Request) => Promise<Response>;
    app: import("node:events").EventEmitter;
  };
  t.after(() => {
    app.emit("before-quit");
  });
  return handle;
}

test("desktop protocol forwards trusted app requests to its owned listener unless an external port is explicit", async (t) => {
  const sockets = t.mock.method(net, "createConnection", () => {
    throw Error("desktop probe used a raw TCP connection");
  });
  const handle = await desktopProtocol(t, desktopListener(39281), "/dev/null");
  const calls: string[] = [];
  let forwarded = () => Response.json({ ok: true });
  let probe: () => Response = () => Response.json({ ok: true });
  let contextProbe = () => Response.json({ ok: true });
  t.mock.method(
    globalThis,
    "fetch",
    async (url: URL | string, init: RequestInit) => {
      calls.push(String(url));
      if (["43219", "5174"].includes(new URL(url).port) && !init.headers) {
        assert.equal(init.redirect, "error");
        assert.equal(init.body, undefined);
        return String(url).endsWith("/providers") ? probe() : contextProbe();
      }
      return forwarded();
    },
  );
  const send = (
    route: string,
    method: string,
    headers: Record<string, string>,
    base = "forma://app",
  ) => handle(new Request(base + "/api/agent/" + route, { method, headers }));
  for (const method of ["GET", "POST", "PATCH", "DELETE"]) {
    for (const headers of [
      { origin: "null" },
      { origin: "http://localhost:9999", "sec-fetch-site": "same-origin" },
      { "sec-fetch-site": "cross-site" },
      { "sec-fetch-site": "same-site" },
      { referer: "https://evil.example/app" },
      { referer: "forma://app.evil/" },
    ] as Record<string, string>[])
      assert.equal((await send("profiles", method, headers)).status, 403);
  }
  for (const base of ["https://app", "forma://foreign", "forma://app:4040"])
    assert.equal(
      (await send("providers", "GET", { origin }, base)).status,
      404,
    );
  assert.equal(calls.length, 0);
  // Real Electron custom scheme `forma://app/` same-origin requests omit
  // Origin, Referer, and Sec-Fetch-Site headers; verify both GET and POST pass.
  assert.equal((await send("providers", "GET", {})).status, 200);
  assert.equal((await send("critique", "POST", {})).status, 200);
  calls.length = 0;
  for (const value of ["", " ", "0", "65536", "invalid", "1e3"]) {
    process.env.AGENT_PORT = value;
    for (const route of [
      "profiles",
      "detect",
      "chat",
      "critique",
      "library-playbook",
      "sessions",
      "sessions/context",
      "skills",
    ]) {
      const headers: Record<string, string> =
        route === "skills"
          ? { referer: "forma://app/editor" }
          : { "sec-fetch-site": "same-origin" };
      assert.equal(
        (await send(route, route === "skills" ? "GET" : "POST", headers))
          .status,
        200,
      );
    }
  }
  assert.ok(calls.every((url) => url.startsWith("http://127.0.0.1:39281/")));
  delete process.env.AGENT_PORT;
  await send("profiles", "POST", { origin });
  assert.ok(calls.at(-1)?.includes(":39281/"));
  for (const route of ["sessions", "sessions/context"]) {
    const before: number = calls.length;
    await send(route, "POST", { origin });
    assert.deepEqual(calls.slice(before), [
      "http://127.0.0.1:39281/api/agent/" + route,
    ]);
  }
  assert.equal(sockets.mock.callCount(), 0);
  process.env.AGENT_PORT = "43219";
  for (const invalid of [
    () => new Response("OK"),
    () => Response.json({ ok: true }),
    () => Response.json({ providers: [] }),
    () => Response.json({ agent: "forma", providers: {} }),
  ]) {
    probe = invalid;
    await send("profiles", "POST", { origin });
    assert.match(calls.at(-1)!, /:39281\/api\/agent\/profiles$/);
  }
  await send("sessions", "POST", { origin });
  assert.match(calls.at(-1)!, /:39281\/api\/agent\/sessions$/);
  // Verify the fingerprint against actual handler output, without a listener.
  const api = fixture(t);
  const catalog = await api.json("GET", "/providers");
  const expired = await api.send("GET", "/sessions/context");
  assert.deepEqual(JSON.parse(expired.text), {
    error: "外部 Agent 会话已结束",
  });
  contextProbe = () => new Response(expired.text, { status: expired.status });
  for (const valid of [
    () => Response.json(catalog),
    () => Response.json({ agent: "forma", providers: [] }),
    () => Response.json({}, { headers: { "x-forma-agent": "1" } }),
  ]) {
    probe = valid;
    await send("profiles", "POST", { origin });
    assert.match(calls.at(-1)!, /:43219\/api\/agent\/profiles$/);
  }
  await send("sessions", "POST", { origin });
  assert.match(calls.at(-1)!, /:43219\/api\/agent\/sessions$/);
  for (const [port, key, status, expected] of [
    ["43219", "token", 201, "43219.token"],
    ["43219", "43219.token", 201, "43219.token"],
    ["43219", "token", 400, "token"],
    ["5174", "token", 201, "token"],
  ] as const) {
    process.env.AGENT_PORT = port;
    forwarded = () => Response.json({ key, editor: "editor" }, { status });
    const response = await send("sessions", "POST", { origin });
    assert.equal(response.status, status);
    assert.deepEqual(await response.json(), {
      key: expected,
      editor: "editor",
    });
  }
});

test("MCP accepts legacy keys, valid embedded ports and an explicit port override", () => {
  assert.throws(() => resolveMcpSession({}), /FORMA_SESSION/);
  for (const [key, configured, port, token] of [
    ["plain", undefined, 5174, "plain"],
    ["plain", " 40123 ", 40123, "plain"],
    ["1.secret", " ", 1, "secret"],
    ["65535.secret", undefined, 65535, "secret"],
    ["49999.part.two", " 40001 ", 40001, "part.two"],
    ["0.secret", undefined, 5174, "0.secret"],
    ["65536.secret", undefined, 5174, "65536.secret"],
  ] as const)
    assert.deepEqual(
      resolveMcpSession({ FORMA_SESSION: key, AGENT_PORT: configured }),
      { port, token },
    );
  for (const AGENT_PORT of ["", "0", "invalid", "65536", "1e3"]) {
    assert.deepEqual(
      resolveMcpSession({ FORMA_SESSION: "52819.secret", AGENT_PORT }),
      {
        port: 52819,
        token: "secret",
      },
    );
    assert.deepEqual(
      resolveMcpSession({ FORMA_SESSION: "plain", AGENT_PORT }),
      {
        port: 5174,
        token: "plain",
      },
    );
  }
});

test(
  "desktop-owned session pairs with MCP initialize and read_design using FORMA_SESSION alone",
  { timeout: 15000 },
  async (t) => {
    const api = fixture(t);
    let service = new URL("../server/agent-service.ts", import.meta.url).href;
    let fetchRelay: string | undefined;
    const probe = net.createServer();
    try {
      await new Promise<void>((resolve, reject) => {
        probe.once("error", reject).listen(0, "127.0.0.1", resolve);
      });
      await new Promise<void>((resolve) => probe.close(() => resolve()));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
      t.diagnostic(
        "Loopback listen denied (EPERM). Running the pairing over in-process HTTP/1.1 streams.",
      );
      const port = randomInt(49152, 65536);
      service = desktopListener(port);
      // Relay the child's sequential fetches to the same HTTP fixture as Electron.
      fetchRelay = moduleUrl(`
        globalThis.fetch = (url, init) => new Promise(resolve => {
          process.once("message", ({text, status}) => resolve(new Response(text, {status})));
          process.send({url, init});
        });
      `);
      t.mock.method(
        globalThis,
        "fetch",
        async (url: URL | string, init: RequestInit) => {
          const request = new Request(url, init);
          assert.equal(new URL(request.url).origin, "http://127.0.0.1:" + port);
          const route = new URL(request.url).pathname.slice(
            "/api/agent".length,
          );
          const headers = Object.fromEntries(request.headers);
          if (route === "/sessions/context")
            assert.match(headers.authorization, /^Bearer [\w-]+$/);
          const result = await api.send(
            request.method,
            route,
            await request.text(),
            headers,
          );
          return new Response(result.text, { status: result.status });
        },
      );
    }
    const handle = await desktopProtocol(t, service, api.directory);
    const url = origin + "/api/agent/sessions";
    const document = createStarter();
    const selection = document.nodes[0].id;
    const response = await handle(
      new Request(url, {
        method: "POST",
        headers: { origin, "content-type": "application/json" },
        body: JSON.stringify({ document, selection }),
      }),
    );
    assert.equal(response.status, 200);
    const { key, editor } = await response.json();
    assert.match(key, /^[1-9]\d{0,4}\.[\w-]+$/);
    assert.equal(process.env.AGENT_PORT, undefined);
    const child = fork(new URL("../server/mcp.ts", import.meta.url), {
      env: { ...process.env, FORMA_SESSION: key },
      execArgv: [
        "--import",
        "tsx",
        ...(fetchRelay ? ["--import", fetchRelay] : []),
      ],
      silent: true,
    });
    if (fetchRelay)
      child.on(
        "message",
        async ({ url, init }: { url: string; init: RequestInit }) => {
          try {
            const response = await fetch(url, init);
            child.send({
              text: await response.text(),
              status: response.status,
            });
          } catch (error) {
            child.send({
              text: JSON.stringify({ error: String(error) }),
              status: 500,
            });
          }
        },
      );
    const lines = createInterface({ input: child.stdout! });
    t.after(() => {
      child.stdin!.end();
      child.kill();
      lines.close();
    });
    const replies = lines[Symbol.asyncIterator]();
    const send = (message: object) =>
      child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
    async function rpc(id: number, method: string, params: object) {
      send({ id, method, params });
      const reply = JSON.parse((await replies.next()).value!);
      assert.equal(reply.id, id);
      assert.equal(reply.error, undefined);
      return reply.result;
    }
    const hello = await rpc(1, "initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "pairing-test", version: "1" },
    });
    assert.equal(hello.serverInfo.name, "forma-design");
    send({ method: "notifications/initialized" });
    const readDesign = (id: number) =>
      rpc(id, "tools/call", { name: "read_design", arguments: {} });
    const result = await readDesign(2);
    assert.ok(!result.isError, result.content[0].text);
    const design = JSON.parse(result.content[0].text);
    assert.equal(design.id, document.id);
    assert.equal(design.selection, selection);
    assert.ok(
      design.nodes.some((node: { id: string }) => node.id === selection),
    );
    const headers = {
      origin,
      authorization: "Bearer " + key,
      "x-forma-editor": editor,
    };
    const poll = await handle(new Request(url + "/proposal", { headers }));
    assert.equal(poll.status, 200);
    assert.deepEqual(await poll.json(), { proposal: null });
    const close = await handle(new Request(url, { method: "DELETE", headers }));
    assert.equal(close.status, 200);
    assert.deepEqual(await close.json(), { closed: true });
    const expired = await readDesign(3);
    assert.equal(expired.isError, true);
    assert.match(expired.content[0].text, /外部 Agent 会话已结束/);
  },
);

function loadAgentPanel(t: TestContext) {
  const hooks = registerHooks({
    load(url, context, next) {
      return url.endsWith(".css")
        ? { format: "module", source: "", shortCircuit: true }
        : next(url, context);
    },
  });
  t.after(() => hooks.deregister());
  return import("../src/editor/AgentPanel");
}

// Mount React in Node using the existing DOM parser and a delegated click target.
function composerTestHost(t: TestContext) {
  if (typeof document !== "undefined")
    return {
      host: document.createElement("div"),
      click: (button: Element) => (button as HTMLButtonElement).click(),
    };
  const doc = new DOMParser().parseFromString("<html/>", "text/html");
  const makeElement = doc.createElement.bind(doc);
  const makeElementNS = doc.createElementNS.bind(doc);
  const noop = () => {};
  const forReact = (element: Element) =>
    Object.assign(element, {
      style: { setProperty: noop },
      options: [],
      addEventListener: noop,
      removeEventListener: noop,
      focus: noop,
      scrollIntoView: noop,
    });
  t.mock.method(doc, "createElement", (name: string) =>
    forReact(makeElement(name)),
  );
  t.mock.method(doc, "createElementNS", (ns: string, name: string) =>
    forReact(makeElementNS(ns, name)),
  );
  doc.addEventListener = noop;
  const host = doc.createElement("div");
  const events = new EventTarget();
  host.addEventListener = events.addEventListener.bind(events);
  const globals = {
    document: doc,
    window: Object.assign(new EventTarget(), {
      document: doc,
      HTMLIFrameElement: class {},
    }),
    requestAnimationFrame: (fn: FrameRequestCallback) => fn(0),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const before = Object.getOwnPropertyDescriptors(globalThis);
  Object.assign(globalThis, globals);
  t.after(() => {
    for (const key of Object.keys(globals)) {
      if (before[key]) Object.defineProperty(globalThis, key, before[key]);
      else Reflect.deleteProperty(globalThis, key);
    }
  });
  return {
    host,
    click(button: Element) {
      const event = new Event("click", { bubbles: true });
      Object.defineProperty(event, "target", { value: button });
      events.dispatchEvent(event);
    },
  };
}

test("panel and canvas send buttons both post the latest two-layer selection", async (t) => {
  const { host, click } = composerTestHost(t);
  const { AgentPanel } = await loadAgentPanel(t);
  const { CanvasAgentBar } = await import("../src/editor/CanvasAgentBar");
  const { createElement, act, useState, Fragment } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const doc = createStarter();
  const api = fixture(t, async (url, init) => {
    if (String(url).endsWith("/models"))
      return Response.json({ data: [{ id: "gpt-4.1" }] });
    const { tools, messages } = JSON.parse(String(init?.body));
    const proposals = tools
      .map((tool: { function: { name: string } }) => tool.function.name)
      .filter((name: string) => name.startsWith("propose_"));
    assert.deepEqual(proposals, ["propose_design_changes"]);
    assert.doesNotMatch(
      messages[0].content,
      /HTML-First Modern Engine|CANVAS SCOPE/,
    );
    if (messages.at(-1).role === "tool")
      return streamedDelta({ content: "已调整标题" });
    return streamedDelta({
      tool_calls: [
        toolCall(0, "propose_design_changes", {
          mode: "edit",
          reply: "已调整标题",
          edits: [
            { op: "update", id: doc.nodes[0].id, patch: { name: "订单标题" } },
          ],
        }),
      ],
    });
  });
  await api.json("POST", "/profiles", { providerId: "openai", apiKey });
  const status = await api.json("GET", "/status");
  const requests: AgentChatRequest[] = [];
  let response: Promise<AgentChatResult> | undefined;
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    assert.equal(url, "/api/agent/chat");
    const body = JSON.parse(String(init.body));
    requests.push(body);
    response = api.json("POST", "/chat", body);
    return Response.json(await response);
  });
  const noop = () => {};
  function Composers({ selectionCount }: { selectionCount: number }) {
    const [externalChatRequest, dispatch] =
      useState<ExternalChatRequest | null>(null);
    const shared = { document: doc, selection: null, selectionCount, status };
    return createElement(
      Fragment,
      null,
      createElement(AgentPanel, {
        ...shared,
        apply: noop,
        externalChatRequest,
      }),
      createElement(CanvasAgentBar, {
        ...shared,
        open: true,
        busy: false,
        progressText: "",
        error: "",
        pendingProposal: null,
        onSendPrompt: (input) => dispatch({ id: 1, ...input }),
        onClose: noop,
        onOpenConfig: noop,
        onCancel: noop,
        onApplyProposal: noop,
        onDiscardProposal: noop,
        onOpenFullChat: noop,
      }),
    );
  }
  const root = createRoot(host);
  try {
    for (const selectionCount of [0, 2])
      await act(() =>
        root.render(createElement(Composers, { selectionCount })),
      );
    const buttons = () => Array.from(host.getElementsByTagName("button"));
    for (const [chip, submit] of [
      ["agent-quick-chip", "生成设计"],
      ["canvas-agent-starter-chip", "发送 AI 指令"],
    ]) {
      const starter = buttons().find((b) =>
        b.getAttribute("class")?.split(" ").includes(chip),
      )!;
      await act(() => click(starter));
      const button = buttons().find(
        (b) =>
          (b.getAttribute("aria-label") || b.textContent?.trim()) === submit,
      )!;
      assert.ok(button && !button.hasAttribute("disabled"));
      await act(() => click(button));
      assert.equal(requests.at(-1)?.prompt, starter.textContent);
      assert.equal(requests.at(-1)?.selection, null);
      assert.equal(requests.at(-1)?.selectionCount, 2);
      assert.equal(requests.at(-1)?.generationMode, "blueprint");
      const result = await response;
      assert.equal(result?.mode, "edit");
      assert.equal(result.scopeProposal, undefined);
    }
    assert.equal(requests.length, 2);
    // A direct HTTP client can request HTML even after the editor has selected two layers.
    const input = {
      ...requests[0],
      generationMode: "html",
      confirmedScope: {
        summary: "此前确认的订单页",
        screens: [
          {
            refId: "orders",
            name: "订单",
            role: "primary",
            width: 390,
            height: 844,
            summary: "订单列表",
          },
        ],
        reusedAssets: [],
        customModules: [],
      },
    };
    assert.equal((await api.json("POST", "/chat", input)).mode, "edit");
    for (const selectionCount of [-1, 1.5, 100001])
      await api.json("POST", "/chat", { ...input, selectionCount }, 400);
  } finally {
    await act(() => root.unmount());
  }
});

test("scope card eligibility, decisions and retry payload are shared by panel and canvas submissions", async (t) => {
  const { scopeProblem, composeConfirmedScope, chatGeneration } =
    await loadAgentPanel(t);
  const { guideSaveNotice } = await import("../src/editor/LibraryManagerModal");
  const doc = createStarter();
  const scope = {
    summary: "活动流程",
    reusedAssets: [],
    customModules: [],
    screens: Array.from({ length: 9 }, (_, i) => ({
      name: "页面" + i,
      refId: "p" + i,
      role: "primary" as const,
      width: 390,
      height: 844,
      summary: "界面",
    })),
    decisions: [
      { question: "主活动？", defaultChoice: "满减", alternatives: ["折扣"] },
    ],
  };
  const card = {
    scopeProposal: scope,
    sourcePrompt: "规划活动",
    scopeChoices: ["折扣"],
  };
  assert.equal(scopeProblem(card, null, "blueprint", undefined), undefined);
  assert.match(scopeProblem(card, null, "html", undefined)!, /最多支持 8 张/);
  assert.equal(
    scopeProblem(
      {
        ...card,
        scopeProposal: { ...scope, screens: scope.screens.slice(0, 8) },
      },
      null,
      "html",
      undefined,
    ),
    undefined,
  );
  assert.match(
    scopeProblem(card, doc.nodes[0].id, "html", undefined)!,
    /已选中图层，整页范围规划已失效/,
  );
  assert.match(
    scopeProblem(card, null, "html", undefined, 2)!,
    /已选中图层，整页范围规划已失效/,
  );
  for (const mode of ["auto", "html", "blueprint"] as const) {
    assert.deepEqual(chatGeneration(true, mode, scope), {
      generationMode: "blueprint",
    });
    assert.deepEqual(chatGeneration(false, mode, scope), {
      generationMode: mode,
      confirmedScope: scope,
    });
  }
  assert.match(
    scopeProblem(
      { ...card, invalidatedReason: "已选中图层" },
      null,
      "blueprint",
      undefined,
    )!,
    /已选中图层/,
  );
  const attachment = {
    name: "参考图.png",
    mimeType: "image/png",
    dataUrl: screenshot,
  };
  const original = {
    mentions: [{ kind: "node" as const, id: "hero", label: "标题" }],
    attachments: [attachment],
  };
  const external = {
    id: 3,
    prompt: "补充说明",
    mentions: [{ kind: "component" as const, id: "card", label: "商品" }],
    attachments: [{ ...attachment, name: "补充图.png" }],
  };
  const first = composeConfirmedScope(scope, card, external, original);
  assert.equal(first.prompt, "规划活动\n\n补充说明");
  assert.deepEqual(first.mentions, [
    ...external.mentions,
    ...original.mentions,
  ]);
  assert.deepEqual(first.attachments, [
    ...external.attachments,
    ...original.attachments,
  ]);
  assert.equal(first.confirmedScope.decisions?.[0].defaultChoice, "折扣");
  assert.deepEqual(
    composeConfirmedScope(
      scope,
      { ...card, scopeRetryInput: first },
      { prompt: "", mentions: [] },
      original,
    ),
    first,
  );
  const lib = createLibraryFromSelection(
    doc,
    doc.nodes.find((n) => n.parentId === null)!.id,
    "活动",
  );
  const record = {
    id: lib.id,
    name: lib.name,
    revision: lib.revision,
    savedAt: "2026-11-25",
    sourceKind: "json" as const,
    componentCount: lib.components.length,
    variantCount: 1,
    library: lib,
  };
  assert.deepEqual(guideSaveNotice("活动", { status: "updated", record }), {
    error: false,
    message: "已应用「活动」AI 说明书到当前文档（工作区已同步）",
  });
  const warning = "当前文档持久化失败";
  for (const [result, message] of [
    [{ status: "not-found" }, "到当前文档"],
    [{ status: "conflict", currentRevision: 7 }, "r7"],
    [{ status: "error", message: "工作区离线" }, "工作区离线"],
  ] as const) {
    const notice = guideSaveNotice("活动", result, warning);
    assert.equal(notice.error, true);
    for (const term of ["已应用", message, warning])
      assert.ok(notice.message.includes(term));
    assert.doesNotMatch(notice.message, /已保存/);
  }
});
