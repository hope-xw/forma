import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import {
  PROVIDER_PRESETS,
  detectProviderFromKey,
  listPublicProviderPresets,
  maskApiKey,
} from "../src/agent/provider-registry";
import {
  inferModelCapabilities,
  parseOpenAIModelsBody,
  resolveModelCapabilities,
  probeProvider,
} from "../src/agent/capabilities";
import {
  AnthropicAdapter,
  GeminiAdapter,
  OpenAICompatibleAdapter,
  extractJsonPayload,
} from "../src/agent/adapters";
import {
  lookupCatalogModel,
  parseModelsDevCatalog,
} from "../src/agent/model-catalog";
import { AgentConfigStore } from "../server/agent-config-store";
import { createAgentRequestHandler } from "../server/agent-http";
import { createStarter } from "../src/domain/seed";

test("provider registry exposes all 13 mainstream providers with complete metadata", () => {
  assert.equal(PROVIDER_PRESETS.length, 13);
  const publicList = listPublicProviderPresets();
  assert.equal(publicList.length, 13);
  const ids = new Set(publicList.map((p) => p.id));
  for (const required of [
    "openai",
    "anthropic",
    "gemini",
    "kimi",
    "deepseek",
    "qwen",
    "zhipu",
    "minimax",
    "doubao",
    "openrouter",
    "siliconflow",
    "ollama",
    "custom",
  ]) {
    assert.ok(ids.has(required), `Missing provider preset: ${required}`);
  }
  const ollama = publicList.find((p) => p.id === "ollama")!;
  assert.equal(ollama.requiresKey, false);
  assert.equal(ollama.defaultBaseUrl, "http://127.0.0.1:11434/v1");
  assert.deepEqual(
    publicList.find((p) => p.id === "deepseek")!.recommendedModels,
    ["deepseek-flash", "deepseek-v4-pro", "deepseek-chat", "deepseek-reasoner"],
  );
});

test("detectProviderFromKey classifies key formats accurately and maskApiKey never leaks keys", () => {
  assert.deepEqual(detectProviderFromKey("sk-ant-api03-abcdef123456"), {
    providerId: "anthropic",
    confidence: "high",
    candidates: ["anthropic"],
  });
  assert.deepEqual(detectProviderFromKey("AIzaSyD1234567890abcdef"), {
    providerId: "gemini",
    confidence: "high",
    candidates: ["gemini"],
  });
  assert.deepEqual(detectProviderFromKey("sk-or-v1-1234567890abcdef"), {
    providerId: "openrouter",
    confidence: "high",
    candidates: ["openrouter"],
  });
  assert.deepEqual(detectProviderFromKey("sk-proj-abcdef1234567890"), {
    providerId: "openai",
    confidence: "high",
    candidates: ["openai"],
  });
  assert.deepEqual(
    detectProviderFromKey("0123456789abcdef0123456789abcdef.SecretPart123"),
    {
      providerId: "zhipu",
      confidence: "high",
      candidates: ["zhipu"],
    },
  );
  assert.deepEqual(detectProviderFromKey("sk-svcacct-example"), {
    providerId: "openai",
    confidence: "high",
    candidates: ["openai"],
  });
  for (const key of [
    "sk-generic-1234567890",
    "eyJhbGciOiJIUzI1NiJ9.e30.signature",
    "12345678-1234-1234-1234-123456789abc",
    "AIza123456789",
    "0123456789abcdef0123456789abcdef.short",
    "",
    "unrelated",
    "prefix-sk-ant-secret",
  ]) {
    assert.deepEqual(detectProviderFromKey(key), {
      providerId: null,
      confidence: "none",
      candidates: [],
    });
  }

  assert.equal(maskApiKey("sk-proj-abcdef1234"), "sk-p••••1234");
  assert.equal(maskApiKey("short"), "••••");
  assert.equal(maskApiKey(""), "");
});

test("inferModelCapabilities identifies structured output, vision, reasoning, temperature & token params", () => {
  const gpt41 = inferModelCapabilities("openai", "openai-chat", "gpt-4.1");
  assert.equal(gpt41.structuredOutput, "json_schema");
  assert.equal(gpt41.supportsVision, true);
  assert.equal(gpt41.isReasoning, false);
  assert.equal(gpt41.temperatureMode, "normal");
  assert.equal(gpt41.tokenLimitParam, "max_tokens");

  const gpt5 = inferModelCapabilities("openai", "openai-chat", "gpt-5");
  assert.equal(gpt5.structuredOutput, "json_schema");
  assert.equal(gpt5.isReasoning, true);
  assert.equal(gpt5.temperatureMode, "omit");
  assert.equal(gpt5.tokenLimitParam, "max_completion_tokens");

  const o1Mini = inferModelCapabilities("openai", "openai-chat", "o1-mini");
  assert.equal(o1Mini.structuredOutput, "prompt_json");
  assert.equal(o1Mini.temperatureMode, "omit");
  assert.equal(o1Mini.tokenLimitParam, "max_completion_tokens");

  const claude = inferModelCapabilities(
    "anthropic",
    "anthropic-messages",
    "claude-sonnet-4-5",
  );
  assert.equal(claude.structuredOutput, "tool_call");
  assert.equal(claude.supportsVision, true);

  const gemini = inferModelCapabilities(
    "gemini",
    "gemini-native",
    "gemini-2.5-pro",
  );
  assert.equal(gemini.structuredOutput, "json_object");
  assert.equal(gemini.supportsVision, true);
  assert.equal(gemini.maxContextTokens, 1_000_000);

  const kimi = inferModelCapabilities("kimi", "openai-chat", "kimi-k2.5");
  assert.equal(kimi.structuredOutput, "json_object");
  assert.equal(kimi.supportsVision, true);
  assert.equal(kimi.temperatureMode, "fixed_one");

  const dsReasoner = inferModelCapabilities(
    "deepseek",
    "openai-chat",
    "deepseek-reasoner",
  );
  assert.equal(dsReasoner.structuredOutput, "prompt_json");
  assert.equal(dsReasoner.isReasoning, true);
  assert.equal(dsReasoner.temperatureMode, "omit");

  const ollama = inferModelCapabilities("ollama", "openai-chat", "qwen2.5:14b");
  assert.equal(ollama.structuredOutput, "prompt_json");
});

test("probeProvider handles Kimi .cn -> .ai region fallback and filters non-chat models", async () => {
  const visited: string[] = [];
  const fakeFetch: typeof fetch = async (url) => {
    const u = String(url);
    visited.push(u);
    if (u === "https://api.moonshot.cn/v1/models") {
      return new Response("invalid api key secret-kimi", { status: 401 });
    }
    if (u === "https://api.moonshot.ai/v1/models") {
      return new Response(
        JSON.stringify({
          data: [
            { id: "text-embedding-3-small" },
            { id: "whisper-1" },
            { id: "moonshot-v1-8k" },
            { id: "kimi-k2.5" },
            { id: "dall-e-3" },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    return new Response("not found", { status: 404 });
  };

  const result = await probeProvider(
    { providerId: "kimi", apiKey: "sk-kimi-intl-test-key" },
    fakeFetch,
  );
  assert.deepEqual(visited, [
    "https://api.moonshot.cn/v1/models",
    "https://api.moonshot.ai/v1/models",
  ]);
  assert.equal(result.baseUrl, "https://api.moonshot.ai/v1");
  assert.equal(result.selectedModel, "kimi-k2.5");
  assert.equal(result.capabilities.temperatureMode, "fixed_one");
  assert.equal(
    result.models.some(
      (m) => m.id.includes("embedding") || m.id.includes("whisper"),
    ),
    false,
  );
});

test("unrecognized keys without a destination are rejected before any fetch", async () => {
  let calls = 0;
  for (const providerId of ["auto", undefined]) {
    for (const apiKey of ["sk-generic", "eyJaaa.bbb.ccc", "arbitrary", ""]) {
      await assert.rejects(
        probeProvider({ providerId, apiKey }, async () => {
          calls++;
          return new Response(null, { status: 401 });
        }),
        {
          message: "无法仅凭密钥前缀唯一识别供应商，请先选择模型供应商后再连接",
        },
      );
    }
  }
  assert.equal(calls, 0);
});

test("auto probes only the dedicated provider or explicitly supplied base URL", async () => {
  const urls: string[] = [];
  const fetchModels: typeof fetch = async (url, init) => {
    assert.equal(init?.redirect, "error");
    urls.push(String(url));
    return Response.json({ data: [{ id: "deployment" }] });
  };
  const automatic = await probeProvider({ apiKey: "sk-ant-test" }, fetchModels);
  assert.equal(automatic.detectedBy, "key-prefix");
  await probeProvider(
    {
      providerId: "auto",
      apiKey: "sk-opaque",
      baseUrl: "https://my-gateway.invalid/v1",
    },
    fetchModels,
  );
  await probeProvider(
    { providerId: "deepseek", apiKey: "sk-ant-test" },
    fetchModels,
  );
  assert.deepEqual(urls, [
    "https://api.anthropic.com/v1/models",
    "https://my-gateway.invalid/v1/models",
    "https://api.deepseek.com/v1/models",
  ]);
});

test("explicit presets use curated fallbacks for restricted lists and redact upstream errors", async () => {
  // Explicit preset with 403 on /models falls back to recommended models
  const doubaoFallback = await probeProvider(
    { providerId: "doubao", apiKey: "ark-test-key-1234567890" },
    async () => new Response("forbidden", { status: 403 }),
  );
  assert.equal(doubaoFallback.providerId, "doubao");
  assert.ok(doubaoFallback.models.length > 0);
  assert.ok(doubaoFallback.probeNote);

  // Errors never leak raw key or vendor body
  await assert.rejects(
    () =>
      probeProvider(
        { providerId: "openai", apiKey: "sk-proj-super-secret-value-999" },
        async () =>
          new Response("leaked sk-proj-super-secret-value-999 body", {
            status: 401,
          }),
      ),
    (err) =>
      err instanceof Error &&
      err.message.includes("401") &&
      !err.message.includes("super-secret-value-999"),
  );
});

test("probeProvider auto-identifies custom gateway protocols (Anthropic & Gemini)", async () => {
  const anthropicProxy = await probeProvider(
    {
      providerId: "custom",
      baseUrl: "https://proxy.corp.invalid",
      apiKey: "custom-token-12345",
    },
    async (url, init) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      if (
        String(url) === "https://proxy.corp.invalid/v1/models" &&
        headers["anthropic-version"] === "2023-06-01"
      ) {
        return new Response(
          JSON.stringify({ data: [{ id: "claude-sonnet-4-5" }] }),
          { status: 200 },
        );
      }
      return new Response("nope", { status: 404 });
    },
  );
  assert.equal(anthropicProxy.protocol, "anthropic-messages");
  assert.equal(anthropicProxy.baseUrl, "https://proxy.corp.invalid/v1");
  assert.equal(anthropicProxy.selectedModel, "claude-sonnet-4-5");

  const geminiProxy = await probeProvider(
    {
      providerId: "custom",
      baseUrl: "https://gemini-gw.invalid",
      apiKey: "AIzaSyCustomGateway1234",
    },
    async (url, init) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      if (
        String(url) === "https://gemini-gw.invalid/v1beta/models" &&
        headers["x-goog-api-key"] === "AIzaSyCustomGateway1234"
      ) {
        return new Response(
          JSON.stringify({
            models: [
              {
                name: "models/gemini-2.5-pro",
                supportedGenerationMethods: ["generateContent"],
              },
              {
                name: "models/text-embedding-004",
                supportedGenerationMethods: ["embedContent"],
              },
            ],
          }),
          { status: 200 },
        );
      }
      return new Response("nope", { status: 404 });
    },
  );
  assert.equal(geminiProxy.protocol, "gemini-native");
  assert.equal(geminiProxy.baseUrl, "https://gemini-gw.invalid/v1beta");
  assert.equal(geminiProxy.selectedModel, "gemini-2.5-pro");
});

test("OpenAI adapter performs json_schema -> json_object -> prompt_json self-healing degradation and honors reasoning params", async () => {
  const seenBodies: Record<string, unknown>[] = [];
  const adapter = new OpenAICompatibleAdapter(
    {
      providerId: "openai",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-proj-test-123456",
      model: "gpt-5",
      capabilities: inferModelCapabilities("openai", "openai-chat", "gpt-5"),
    },
    async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      seenBodies.push(body);
      if (seenBodies.length <= 2) {
        return new Response("response_format unsupported", { status: 400 });
      }
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content:
                  '<think>analyzing layout</think>```json\n{"mode":"answer","reply":"OK {braces}"}\n```',
              },
            },
          ],
        }),
        { status: 200 },
      );
    },
  );

  const response = await adapter.complete(
    {
      messages: [{ role: "user", text: "hi" }],
      jsonSchema: { name: "test_schema", schema: { type: "object" } },
    },
    new AbortController().signal,
  );

  assert.equal(seenBodies.length, 3);
  assert.equal(
    (seenBodies[0].response_format as { type: string }).type,
    "json_schema",
  );
  assert.equal(
    (seenBodies[1].response_format as { type: string }).type,
    "json_object",
  );
  assert.equal(seenBodies[2].response_format, undefined);
  assert.equal(seenBodies[0].temperature, undefined);
  assert.equal(typeof seenBodies[0].max_completion_tokens, "number");
  assert.equal(response.structuredModeUsed, "prompt_json");
  assert.deepEqual(extractJsonPayload(response.text), {
    mode: "answer",
    reply: "OK {braces}",
  });
});

test("Anthropic and Gemini adapters send native headers, vision payloads, and parse structured & SSE outputs", async () => {
  let anthropicHeaders: Record<string, string> = {};
  let anthropicBody: Record<string, unknown> = {};
  const anthropic = new AnthropicAdapter(
    {
      providerId: "anthropic",
      baseUrl: "https://api.anthropic.com/v1",
      apiKey: "sk-ant-test-999999",
      model: "claude-sonnet-4-5",
      capabilities: inferModelCapabilities(
        "anthropic",
        "anthropic-messages",
        "claude-sonnet-4-5",
      ),
    },
    async (url, init) => {
      assert.equal(String(url), "https://api.anthropic.com/v1/messages");
      anthropicHeaders = init?.headers as Record<string, string>;
      anthropicBody = JSON.parse(String(init?.body));
      const sse = [
        'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"input_json_delta","partial_json":"{\\"mode\\":\\"answer\\","}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"input_json_delta","partial_json":"\\"reply\\":\\"from claude\\"}"}}\n\n',
      ].join("");
      return new Response(sse, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    },
  );

  const deltas: string[] = [];
  const claudeResp = await anthropic.stream(
    {
      messages: [
        { role: "system", text: "You are a designer" },
        {
          role: "user",
          text: "Inspect screenshot",
          images: [
            {
              mimeType: "image/png",
              dataUrl: "data:image/png;base64,iVBORw0KGgo=",
            },
          ],
        },
      ],
      jsonSchema: { name: "forma_design", schema: { type: "object" } },
    },
    (d) => deltas.push(d),
    new AbortController().signal,
  );
  assert.equal(anthropicHeaders["x-api-key"], "sk-ant-test-999999");
  assert.equal(anthropicHeaders["anthropic-version"], "2023-06-01");
  assert.equal(
    (anthropicBody.tool_choice as { name: string }).name,
    "forma_design",
  );
  assert.deepEqual(extractJsonPayload(claudeResp.text), {
    mode: "answer",
    reply: "from claude",
  });
  assert.equal(deltas.length, 2);

  let geminiUrl = "";
  let geminiHeaders: Record<string, string> = {};
  let geminiBody: Record<string, unknown> = {};
  const gemini = new GeminiAdapter(
    {
      providerId: "gemini",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
      apiKey: "AIzaSyGeminiKey123456",
      model: "gemini-2.5-pro",
      capabilities: inferModelCapabilities(
        "gemini",
        "gemini-native",
        "gemini-2.5-pro",
      ),
    },
    async (url, init) => {
      geminiUrl = String(url);
      geminiHeaders = init?.headers as Record<string, string>;
      geminiBody = JSON.parse(String(init?.body));
      return new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  { text: "internal thought", thought: true },
                  { text: '{"mode":"answer","reply":"from gemini"}' },
                ],
              },
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    },
  );

  const geminiResp = await gemini.complete(
    {
      messages: [
        { role: "system", text: "System rules" },
        {
          role: "user",
          text: "Design a screen",
          images: [
            {
              mimeType: "image/jpeg",
              dataUrl: "data:image/jpeg;base64,/9j/4AAQ=",
            },
          ],
        },
      ],
    },
    new AbortController().signal,
  );
  assert.ok(geminiUrl.endsWith("/models/gemini-2.5-pro:generateContent"));
  assert.ok(!geminiUrl.includes("AIzaSy"));
  assert.equal(geminiHeaders["x-goog-api-key"], "AIzaSyGeminiKey123456");
  assert.equal(
    (geminiBody.generationConfig as { responseMimeType: string })
      .responseMimeType,
    "application/json",
  );
  assert.deepEqual(extractJsonPayload(geminiResp.text), {
    mode: "answer",
    reply: "from gemini",
  });
});

test("AgentConfigStore and agent-http router manage profiles securely with 0600 permissions, masked keys, and SSE chat", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "forma-agent-test-"));
  const secretKey = "sk-proj-very-secret-key-987654321";

  const fakeUpstreamFetch: typeof fetch = async (url) => {
    const u = String(url);
    if (u.endsWith("/models")) {
      return new Response(
        JSON.stringify({
          data: [{ id: "gpt-4.1" }, { id: "gpt-4o-mini" }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (u.endsWith("/chat/completions")) {
      const sse = [
        'data: {"choices":[{"delta":{"content":"{\\"mode\\":\\"answer\\",\\"reply\\":\\"你好设计师\\"}"}}]}\n\n',
        "data: [DONE]\n\n",
      ].join("");
      return new Response(sse, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    }
    return new Response("not found", { status: 404 });
  };

  const store = new AgentConfigStore({ configDir: dir, env: {} });
  const handler = createAgentRequestHandler({
    store,
    origins: ["http://127.0.0.1:5173"],
    allowSameHostLoopback: false,
    fetchImpl: fakeUpstreamFetch,
    env: {},
  });

  const invoke = async (
    method: string,
    url: string,
    headers: Record<string, string> = {},
    body?: unknown,
  ) => {
    const rawBody = body === undefined ? "" : JSON.stringify(body);
    const req = Readable.from(
      rawBody ? [Buffer.from(rawBody)] : [],
    ) as unknown as IncomingMessage;
    req.method = method;
    req.url = url;
    req.headers = Object.fromEntries(
      Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]),
    );

    const resEmitter = new EventEmitter();
    const resHeaders: Record<string, string> = {};
    const chunks: Buffer[] = [];
    let statusCode = 200;
    let ended = false;

    const done = new Promise<void>((resolve) => {
      resEmitter.once("finish", resolve);
    });

    const res = Object.assign(resEmitter, {
      get writableEnded() {
        return ended;
      },
      writeHead(code: number, hdrs?: Record<string, string>) {
        statusCode = code;
        if (hdrs) {
          for (const [k, v] of Object.entries(hdrs)) {
            resHeaders[k.toLowerCase()] = String(v);
          }
        }
        return res;
      },
      setHeader(name: string, value: string) {
        resHeaders[name.toLowerCase()] = String(value);
      },
      write(chunk: string | Buffer) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        return true;
      },
      end(chunk?: string | Buffer) {
        if (chunk !== undefined) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        ended = true;
        resEmitter.emit("finish");
        resEmitter.emit("close");
        return res;
      },
    }) as unknown as ServerResponse;

    await handler(req, res);
    await done;
    const text = Buffer.concat(chunks).toString("utf8");
    return {
      status: statusCode,
      headers: resHeaders,
      text,
      json: () => JSON.parse(text),
    };
  };

  try {
    // 1. Disallowed origin blocked on mutating route
    const forbidden = await invoke(
      "POST",
      "/api/agent/detect",
      {
        Origin: "https://evil.example",
        "Content-Type": "application/json",
      },
      { providerId: "openai", apiKey: secretKey },
    );
    assert.equal(forbidden.status, 403);

    // 2. Initial status is unconfigured
    const initialStatus = (await invoke("GET", "/api/agent/status")).json();
    assert.equal(initialStatus.configured, false);
    assert.equal(initialStatus.profiles.length, 0);

    // 3. Create profile via POST /api/agent/profiles
    const createResp = await invoke(
      "POST",
      "/api/agent/profiles",
      {
        Origin: "http://127.0.0.1:5173",
        "Content-Type": "application/json",
      },
      { providerId: "auto", apiKey: secretKey },
    );
    assert.equal(createResp.status, 200);
    assert.ok(
      !createResp.text.includes(secretKey),
      "Raw API key must never appear in response",
    );
    const created = createResp.json();
    assert.equal(created.profile.providerId, "openai");
    assert.equal(created.profile.maskedKey, "sk-p••••4321");
    assert.equal(created.status.configured, true);

    // Verify file mode 0o600 on disk
    const fileMode =
      statSync(path.join(dir, "agent-profiles.json")).mode & 0o777;
    assert.equal(fileMode, 0o600);

    // 4. Switch model via PATCH /api/agent/profiles/:id
    const patchResp = await invoke(
      "PATCH",
      `/api/agent/profiles/${created.profile.id}`,
      {
        Origin: "http://127.0.0.1:5173",
        "Content-Type": "application/json",
      },
      { selectedModel: "gpt-4o-mini" },
    );
    assert.equal(patchResp.status, 200);
    const patched = patchResp.json();
    assert.equal(patched.profile.selectedModel, "gpt-4o-mini");

    // 5. SSE chat via POST /api/agent/chat
    const chatResp = await invoke(
      "POST",
      "/api/agent/chat",
      {
        Origin: "http://127.0.0.1:5173",
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      },
      {
        prompt: "给我配色建议",
        document: createStarter(),
        selection: null,
      },
    );
    assert.equal(chatResp.status, 200);
    assert.ok(chatResp.headers["content-type"]?.includes("text/event-stream"));
    assert.ok(chatResp.text.includes("event: progress"));
    assert.ok(chatResp.text.includes("event: result"));
    assert.ok(chatResp.text.includes("你好设计师"));

    // 6. Delete profile via DELETE /api/agent/profiles/:id
    const delResp = await invoke(
      "DELETE",
      `/api/agent/profiles/${created.profile.id}`,
      { Origin: "http://127.0.0.1:5173" },
    );
    assert.equal(delResp.status, 200);
    const deleted = delResp.json();
    assert.equal(deleted.deleted, true);
    assert.equal(deleted.status.configured, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("AgentConfigStore preserves .env fallback profile and supports Ollama local discovery", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "forma-agent-env-"));
  try {
    const store = new AgentConfigStore({
      configDir: dir,
      env: {
        MODEL_BASE_URL: "https://api.deepseek.com/v1",
        MODEL_API_KEY: "sk-env-secret-123456789",
        MODEL_ID: "deepseek-chat",
      },
    });
    const status = store.getStatus();
    assert.equal(status.configured, true);
    assert.equal(status.activeProfileId, "env-default");
    assert.equal(status.activeProfile?.source, "env");
    assert.equal(status.activeProfile?.providerId, "deepseek");
    assert.equal(status.activeProfile?.maskedKey, "sk-e••••6789");
    assert.throws(() => store.deleteProfile("env-default"), /环境变量/);

    const ollamaProbe = await probeProvider(
      { providerId: "ollama" },
      async (url) => {
        if (String(url) === "http://127.0.0.1:11434/v1/models") {
          return new Response(
            JSON.stringify({ data: [{ id: "qwen2.5:14b" }] }),
            { status: 200 },
          );
        }
        return new Response("not found", { status: 404 });
      },
    );
    assert.equal(ollamaProbe.providerId, "ollama");
    assert.equal(ollamaProbe.detectedBy, "local");
    assert.equal(ollamaProbe.selectedModel, "qwen2.5:14b");
    assert.equal(ollamaProbe.capabilities.structuredOutput, "prompt_json");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("DeepSeek discovery ranks Flash first and merges live limits with catalog defaults", async () => {
  const input = { providerId: "deepseek", apiKey: "sk-test" };
  const flash = { id: "deepseek-flash" };
  const discover = (metadata: object) =>
    probeProvider(input, async () =>
      Response.json({
        data: [
          { id: "deepseek-chat" },
          { id: "deepseek-reasoner" },
          { id: "deepseek-v4-pro" },
          { ...flash, ...metadata },
        ],
      }),
    );
  const live = await discover({
    name: "DeepSeek-V4.1-Flash",
    context_window: 1_000_000,
    max_output_tokens: 393_216,
    input_modalities: ["text", "image"],
  });
  assert.equal(live.selectedModel, flash.id);
  assert.equal(live.models[0].label, "deepseek-flash (DeepSeek-V4.1-Flash)");
  assert.equal(live.capabilities.maxContextTokens, 1_000_000);
  assert.equal(live.capabilities.maxOutputTokens, 393_216);
  assert.equal(live.capabilities.supportsVision, true);
  assert.equal(live.capabilities.supportsTools, true);
  assert.equal(live.capabilities.isReasoning, true);
  assert.equal(live.capabilities.capabilitySource, "provider-api");
  assert.equal(live.capabilities.visionKnown, true);
  assert.equal(live.capabilities.contextKnown, true);
  const fallback = await discover({});
  assert.deepEqual(
    fallback.models.slice(0, 2).map((m) => m.id),
    [flash.id, "deepseek-v4-pro"],
  );
  assert.equal(fallback.capabilities.capabilitySource, "builtin-catalog");
  assert.equal(fallback.capabilities.maxOutputTokens, 65_536);
  assert.equal(fallback.capabilities.maxContextTokens, 1_000_000);
  assert.equal(fallback.capabilities.supportsVision, true);
  assert.equal(fallback.models[1].capabilities.supportsVision, false);
  const alias = await probeProvider(input, async () =>
    Response.json({
      data: [
        { id: "deepseek-chat" },
        { id: "deepseek-v4-pro" },
        { id: "deepseek-v4.1-flash-1017" },
      ],
    }),
  );
  assert.equal(alias.selectedModel, "deepseek-v4.1-flash-1017");
  assert.equal(
    (await discover({ name: "Upstream title only" })).capabilities
      .capabilitySource,
    "builtin-catalog",
  );
});

test("catalog matches exact IDs, versioned aliases and namespaced families", () => {
  const cases: [string, number, boolean][] = [
    ["deepseek/deepseek-v4.1-flash-1017", 1_000_000, true],
    ["DeepSeek-V4-Flash-vision-exp", 1_000_000, true],
    ["deepseek-v4-0813", 1_000_000, false],
    ["deepseek-ai/DeepSeek-V3.2", 128_000, false],
    ["deepseek-r1-0528", 128_000, false],
    ["openai/o3", 200_000, true],
    ["o4-mini", 200_000, true],
    ["o1-preview", 128_000, false],
    ["gpt-4.1-mini", 1_000_000, true],
    ["gpt-4o-mini", 128_000, true],
    ["anthropic/claude-opus-5", 1_000_000, true],
    ["claude-fable-5-2", 1_000_000, true],
    ["claude-sonnet-5", 1_000_000, true],
    ["anthropic/claude-sonnet-4", 200_000, true],
    ["claude-opus-4-1", 200_000, true],
    ["claude-3-7-sonnet", 200_000, true],
    ["claude-3-5-haiku", 200_000, true],
    ["gemini-4-argon", 1_000_000, true],
    ["gemini-3-flash-preview", 1_000_000, true],
    ["gemini-2.5-pro", 1_000_000, true],
    ["gemini-2.0-flash", 1_000_000, true],
    ["kimi-k2.5", 256_000, true],
    ["kimi-k2-turbo-preview", 128_000, false],
    ["kimi-k3", 256_000, true],
    ["moonshot-v1-128k", 128_000, false],
    ["Qwen/Qwen3-VL-32B", 128_000, true],
    ["qwen-vl-plus", 128_000, true],
    ["qwen2.5-vl-72b", 128_000, true],
    ["qwen3-max", 128_000, false],
    ["qwen-max", 128_000, false],
    ["qwen-plus", 128_000, false],
    ["qwen2.5-72b-instruct", 128_000, false],
    ["glm-5", 200_000, true],
    ["glm-4.5v", 128_000, true],
    ["glm-4v-plus", 128_000, true],
    ["glm-4.5", 128_000, false],
    ["glm-4-plus", 128_000, false],
    ["MiniMax-M2.7", 1_000_000, false],
    ["MiniMax-M1", 128_000, false],
    ["MiniMax-Text-01", 1_000_000, false],
    ["doubao-seed-2-0-pro", 256_000, true],
    ["doubao-1-5-vision-pro", 128_000, true],
    ["doubao-1-5-pro-32k", 128_000, false],
  ];
  for (const [id, context, vision] of cases) {
    const spec = lookupCatalogModel("openrouter", id);
    assert.ok(spec, id);
    assert.equal(spec.maxContextTokens, context, id);
    assert.equal(spec.supportsVision, vision, id);
    assert.equal(spec.supportsTools, id !== "o1-preview", id);
  }
  assert.equal(lookupCatalogModel("deepseek", "my-deepseek-flash"), null);
  assert.equal(lookupCatalogModel("custom", "deepseek-flash-copy"), null);
});

test("OpenRouter returns input modalities, supported parameters and nested output limits", async () => {
  const probe = await probeProvider(
    { providerId: "openrouter", apiKey: "sk-test" },
    async () =>
      Response.json({
        data: [
          {
            id: "company/deployment",
            name: "Design Model",
            context_length: 321_000,
            architecture: {
              input_modalities: ["text", "image"],
              modality: "text->text",
            },
            top_provider: { max_completion_tokens: 12_345 },
            supported_parameters: [
              "tools",
              "include_reasoning",
              "structured_outputs",
            ],
          },
        ],
      }),
  );
  assert.equal(probe.models[0].label, "company/deployment (Design Model)");
  assert.deepEqual(probe.capabilities, {
    protocol: "openai-chat",
    maxContextTokens: 321_000,
    maxOutputTokens: 12_345,
    supportsVision: true,
    supportsTools: true,
    isReasoning: true,
    supportsStreaming: true,
    structuredOutput: "json_schema",
    temperatureMode: "normal",
    tokenLimitParam: "max_tokens",
    contextKnown: true,
    visionKnown: true,
    capabilitySource: "provider-api",
  });
});

test("OpenAI-compatible field aliases preserve explicit negatives and ignore malformed limits", () => {
  for (const [raw, vision] of [
    [{ input_modalities: ["vision"] }, true],
    [{ input_modalities: ["text"] }, false],
    [{ architecture: { modality: "text+image->text" } }, true],
    [{ architecture: { modality: "text->image" } }, false],
    [{ modalities: ["text", "image"] }, true],
    [{ modalities: { input: ["text"], output: ["image"] } }, false],
    [{ capabilities: { vision: false } }, false],
    [{ supports_vision: true }, true],
    [{ input_modalities: [] }, undefined],
    [{ input_modalities: [null] }, undefined],
  ] as const) {
    const model = parseOpenAIModelsBody({
      data: [{ id: "deepseek-flash", ...raw }],
    })![0];
    assert.equal(model.supportsVision, vision);
  }
  for (const contextKey of [
    "context_window",
    "context_length",
    "max_context_length",
    "max_input_tokens",
    "input_token_limit",
  ]) {
    const model = parseOpenAIModelsBody({
      data: [{ id: "id", [contextKey]: 456 }],
    })![0];
    assert.equal(model.contextWindow, 456);
  }
  for (const outputKey of [
    "max_output_tokens",
    "max_completion_tokens",
    "output_token_limit",
  ]) {
    const model = parseOpenAIModelsBody({
      data: [{ id: "id", [outputKey]: 123 }],
    })![0];
    assert.equal(model.maxOutputTokens, 123);
  }
  const parsed = parseOpenAIModelsBody({
    data: [
      null,
      { name: "missing ID" },
      {
        id: "deepseek-flash",
        display_name: "Upstream",
        max_context_length: -1,
        max_input_tokens: 8765,
        max_completion_tokens: 0,
        input_modalities: ["text"],
        capabilities: { function_calling: false, thinking: false },
        supported_parameters: ["tools", "reasoning"],
      },
    ],
  });
  assert.ok(parsed);
  assert.equal(parsed.length, 1);
  const [m] = parsed;
  assert.equal(m.displayName, "Upstream");
  const caps = inferModelCapabilities("deepseek", "openai-chat", m.id, m);
  assert.equal(caps.supportsVision, false);
  assert.equal(caps.supportsTools, false);
  assert.equal(caps.isReasoning, false);
  assert.equal(caps.maxContextTokens, 8765);
  assert.equal(caps.maxOutputTokens, 65_536);
  assert.equal(parseOpenAIModelsBody({ error: "invalid" }), null);
});

test("capability sources and known flags reflect only fields that contributed", () => {
  const params = {
    providerId: "custom",
    protocol: "openai-chat",
    modelId: "new-model",
  } as const;
  const unknown = resolveModelCapabilities(params);
  assert.equal(unknown.capabilitySource, "heuristic");
  assert.equal(unknown.contextKnown, false);
  assert.equal(unknown.visionKnown, false);
  assert.equal(typeof unknown.supportsTools, "boolean");
  const apiMeta = { id: "new-model", supportsTools: false };
  const toolsOnly = resolveModelCapabilities({
    ...params,
    apiMeta,
    overrides: {},
  });
  assert.equal(toolsOnly.capabilitySource, "provider-api");
  assert.equal(toolsOnly.contextKnown, false);
  assert.equal(toolsOnly.visionKnown, false);
  const manual = resolveModelCapabilities({
    ...params,
    apiMeta: { ...apiMeta, supportsVision: true },
    overrides: { supportsVision: false, supportsTools: true },
  });
  assert.equal(manual.capabilitySource, "user-override");
  assert.equal(manual.contextKnown, false);
  assert.equal(manual.visionKnown, true);
  assert.equal(manual.supportsVision, false);
  assert.equal(manual.supportsTools, true);
});

test("native and custom Gemini discovery preserve generation methods, labels and token limits", async () => {
  for (const providerId of ["gemini", "custom"]) {
    const probe = await probeProvider(
      {
        providerId,
        apiKey: "sk-test",
        baseUrl: "https://example.invalid/v1beta",
      },
      async () =>
        Response.json({
          models: [
            {
              name: "models/gemini-4-private",
              displayName: "Team Gemini",
              inputTokenLimit: 1_234_567,
              outputTokenLimit: 12_345,
              supportedGenerationMethods: ["generateContent"],
            },
            {
              name: "models/count-only",
              supportedGenerationMethods: ["countTokens"],
            },
          ],
        }),
    );
    assert.equal(probe.protocol, "gemini-native");
    assert.equal(probe.models.length, 1);
    assert.equal(probe.models[0].label, "gemini-4-private (Team Gemini)");
    assert.equal(probe.capabilities.maxContextTokens, 1_234_567);
    assert.equal(probe.capabilities.maxOutputTokens, 12_345);
    assert.equal(probe.capabilities.capabilitySource, "provider-api");
  }
});

test("Anthropic discovery reads native model limits and nested capability declarations", async () => {
  const result = await probeProvider(
    { providerId: "anthropic", apiKey: "sk-ant-test" },
    async () =>
      Response.json({
        data: [
          {
            id: "claude-sonnet-5",
            display_name: "Workspace Claude",
            type: "model",
            max_input_tokens: 820_000,
            max_tokens: 32_000,
            capabilities: {
              image_input: { supported: false },
              thinking: { supported: true },
            },
          },
        ],
      }),
  );
  assert.equal(result.models[0].label, "claude-sonnet-5 (Workspace Claude)");
  assert.equal(result.capabilities.capabilitySource, "provider-api");
  assert.equal(result.capabilities.maxContextTokens, 820_000);
  assert.equal(result.capabilities.maxOutputTokens, 32_000);
  assert.equal(result.capabilities.supportsVision, false);
  assert.equal(result.capabilities.isReasoning, true);
  assert.equal(result.capabilities.structuredOutput, "tool_call");
});

test("Ollama inspects the first eight local models concurrently and tolerates missing details", async () => {
  const ids = Array.from({ length: 10 }, (_, i) => `local-${i}`);
  const shown: string[] = [];
  let pending = 0;
  let peak = 0;
  const result = await probeProvider(
    { providerId: "ollama" },
    async (url, init) => {
      const endpoint = new URL(String(url));
      assert.equal(endpoint.origin, "http://127.0.0.1:11434");
      if (endpoint.pathname === "/v1/models")
        return new Response(null, { status: 404 });
      if (endpoint.pathname === "/api/tags")
        return Response.json({ models: ids.map((name) => ({ name })) });
      assert.equal(endpoint.pathname, "/api/show");
      assert.equal(init?.method, "POST");
      const { model } = JSON.parse(String(init?.body));
      shown.push(model);
      peak = Math.max(peak, ++pending);
      await new Promise<void>((resolve) => setImmediate(resolve));
      pending--;
      if (model === "local-0")
        return Response.json({
          capabilities: ["completion", "vision", "tools", "thinking"],
          model_info: { "llama.context_length": 98_000 },
        });
      if (model === "local-1")
        return Response.json({ capabilities: ["completion"] });
      throw new Error("unsupported details");
    },
  );
  assert.deepEqual(shown, ids.slice(0, 8));
  assert.equal(peak, 8);
  assert.equal(result.models.length, 10);
  const caps = (id: string) =>
    result.models.find((m) => m.id === id)!.capabilities;
  assert.equal(caps("local-0").supportsVision, true);
  assert.equal(caps("local-0").supportsTools, true);
  assert.equal(caps("local-0").isReasoning, true);
  assert.equal(caps("local-0").maxContextTokens, 98_000);
  assert.equal(caps("local-0").capabilitySource, "provider-api");
  assert.equal(caps("local-1").supportsVision, false);
  assert.equal(caps("local-1").visionKnown, true);
  assert.equal(caps("local-1").contextKnown, false);
  assert.equal(caps("local-2").capabilitySource, "heuristic");
  assert.equal(caps("local-9").visionKnown, false);
});

test("models.dev snapshots keep per-provider limits and ignore invalid rows offline", () => {
  const model = {
    id: "example",
    name: "Example model",
    limit: { context: 1_000_000, output: 4_000 },
    modalities: { input: ["text", "image"], output: ["text"] },
    tool_call: true,
    reasoning: false,
  };
  const parsed = parseModelsDevCatalog({
    first: {
      models: {
        example: model,
        broken: { ...model, limit: { context: -2, output: null } },
      },
    },
    second: {
      models: {
        example: { ...model, limit: { context: 32_000, output: 512 } },
        solo: {
          ...model,
          id: "solo",
          modalities: { input: ["text"], output: ["image"] },
        },
      },
    },
  });
  assert.deepEqual(parsed["first/example"], {
    displayName: "Example model",
    maxContextTokens: 1_000_000,
    maxOutputTokens: 4_000,
    supportsVision: true,
    supportsTools: true,
    isReasoning: false,
  });
  assert.equal(parsed["second/example"].maxContextTokens, 32_000);
  assert.equal(parsed.example, undefined);
  assert.equal(parsed.solo.supportsVision, false);
  assert.equal(parsed["first/broken"], undefined);
  assert.deepEqual(parseModelsDevCatalog(null), {});
});

test("version 1 profiles upgrade on read and preserve model-specific overrides through refresh and restart", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "forma-model-upgrade-"));
  const open = () => new AgentConfigStore({ configDir: dir, env: {} });
  const flash = "deepseek-flash";
  const pro = "deepseek-v4-pro";
  const id = "existing-profile";
  const legacy = {
    protocol: "openai-chat",
    structuredOutput: "json_object",
    supportsVision: false,
    supportsStreaming: true,
    isReasoning: false,
    maxContextTokens: 64_000,
    maxOutputTokens: 8192,
    temperatureMode: "normal",
    tokenLimitParam: "max_tokens",
  };
  const proOverride = { maxContextTokens: 89_000 };
  try {
    writeFileSync(
      path.join(dir, "agent-profiles.json"),
      JSON.stringify({
        version: 1,
        activeProfileId: id,
        profiles: [
          {
            id,
            providerId: "deepseek",
            providerName: "DeepSeek",
            label: "My workspace",
            apiKey: "sk-test",
            baseUrl: "https://api.deepseek.com/v1",
            protocol: "openai-chat",
            selectedModel: flash,
            capabilities: legacy,
            models: [
              { id: flash, label: flash, capabilities: legacy },
              {
                id: pro,
                label: pro,
                capabilities: { ...legacy, capabilitySource: "heuristic" },
              },
            ],
            modelOverrides: { [pro]: proOverride },
            updatedAt: "2026-01-01",
          },
        ],
      }),
      { mode: 0o600 },
    );
    let store = open();
    const upgraded = store.getStatus().activeProfile!;
    assert.equal(upgraded.capabilities.maxContextTokens, 1_000_000);
    assert.equal(upgraded.capabilities.supportsVision, true);
    assert.equal(upgraded.capabilities.supportsTools, true);
    assert.equal(upgraded.capabilities.capabilitySource, "builtin-catalog");
    assert.equal(
      upgraded.models.find((m) => m.id === pro)?.capabilities.maxContextTokens,
      89_000,
    );
    const override = {
      supportsVision: false,
      supportsTools: false,
      maxOutputTokens: 1024,
    };
    const saved = store.updateProfile(id, { capabilityOverrides: override });
    assert.deepEqual(saved.activeModelOverrides, override);
    assert.deepEqual(saved.modelOverrides, {
      [flash]: override,
      [pro]: proOverride,
    });
    assert.equal(saved.capabilities.capabilitySource, "user-override");
    assert.equal(saved.capabilities.supportsVision, false);
    assert.deepEqual(
      saved.models.find((m) => m.id === flash)!.capabilities,
      saved.capabilities,
    );
    store = open();
    const switched = store.updateProfile(id, { selectedModel: pro });
    assert.deepEqual(switched.activeModelOverrides, proOverride);
    assert.equal(switched.capabilities.supportsTools, true);
    assert.equal(switched.capabilities.maxContextTokens, 89_000);
    const auto = inferModelCapabilities("deepseek", "openai-chat", flash, {
      id: flash,
      supportsVision: true,
      supportsTools: true,
      maxOutputTokens: 393_216,
      contextWindow: 987_654,
    });
    const refreshed = store.updateProfile(id, {
      selectedModel: flash,
      models: [{ id: flash, label: flash, capabilities: auto }],
      capabilities: auto,
    });
    assert.deepEqual(refreshed.activeModelOverrides, override);
    assert.equal(refreshed.capabilities.maxOutputTokens, 1024);
    assert.equal(refreshed.capabilities.maxContextTokens, 987_654);
    store = open();
    assert.deepEqual(
      store.getResolvedProfile(id)!.capabilities,
      refreshed.capabilities,
    );
    const cleared = store.updateProfile(id, { capabilityOverrides: null });
    assert.equal(cleared.activeModelOverrides, undefined);
    assert.deepEqual(cleared.modelOverrides, { [pro]: proOverride });
    assert.deepEqual(cleared.capabilities, auto);
    assert.deepEqual(
      open().getResolvedProfile(id)!.models[0].capabilities,
      auto,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
