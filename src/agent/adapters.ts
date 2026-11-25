import type { ModelCapabilities, StructuredOutputMode } from "./capabilities";
import { normalizeBaseUrl } from "./provider-registry";

export interface AdapterImageAttachment {
  name?: string;
  mimeType: string;
  dataUrl: string;
}

export interface AdapterToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}
export interface AdapterToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface AdapterMessage {
  role: "system" | "user" | "assistant" | "tool";
  toolCalls?: AdapterToolCall[];
  toolCallId?: string;
  toolName?: string;
  reasoningContent?: string;
  geminiParts?: GeminiPart[];
  text: string;
  images?: AdapterImageAttachment[];
}

export interface AdapterJsonSchema {
  name: string;
  schema: Record<string, unknown>;
  description?: string;
}

export interface AdapterRequest {
  messages: AdapterMessage[];
  jsonSchema?: AdapterJsonSchema;
  tools?: AdapterToolDefinition[];
  toolChoice?: "auto" | "required" | "none";
  maxOutputTokens?: number;
  temperature?: number;
  structuredOutputOverride?: StructuredOutputMode;
}

export interface AdapterResponse {
  toolCalls?: AdapterToolCall[];
  finishReason?: string;
  reasoningContent?: string;
  geminiParts?: GeminiPart[];
  text: string;
  structuredModeUsed: StructuredOutputMode;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
  };
}

export interface AdapterConfig {
  providerId: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  capabilities: ModelCapabilities;
  extraHeaders?: Record<string, string>;
}

export interface UnifiedModelAdapter {
  complete(
    request: AdapterRequest,
    signal: AbortSignal,
  ): Promise<AdapterResponse>;
  stream(
    request: AdapterRequest,
    onDelta: (delta: string) => void,
    signal: AbortSignal,
  ): Promise<AdapterResponse>;
}

const MAX_RESPONSE_CHARS = 2_000_000;

export class AdapterHttpError extends Error {
  constructor(
    public readonly status: number,
    message?: string,
  ) {
    super(message ?? `模型服务请求失败（HTTP ${status}），请检查配置或额度`);
    this.name = "AdapterHttpError";
  }
}

export function stripThinkingTags(raw: string): string {
  return raw
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<reasoning>[\s\S]*?<\/reasoning>/gi, "")
    .trim();
}

function findBalancedJsonObjects(text: string): string[] {
  const candidates: string[] = [];
  let i = 0;
  while (i < text.length) {
    const start = text.indexOf("{", i);
    if (start === -1) break;
    let depth = 0;
    let inString = false;
    let escaped = false;
    let end = -1;
    for (let j = start; j < text.length; j++) {
      const ch = text[j];
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (ch === "\\") {
          escaped = true;
        } else if (ch === '"') {
          inString = false;
        }
        continue;
      }
      if (ch === '"') {
        inString = true;
      } else if (ch === "{") {
        depth++;
      } else if (ch === "}") {
        depth--;
        if (depth === 0) {
          end = j;
          break;
        }
      }
    }
    if (end !== -1) {
      candidates.push(text.slice(start, end + 1));
      i = end + 1;
    } else {
      i = start + 1;
    }
  }
  return candidates;
}

export function extractJsonPayload(rawText: string): unknown {
  if (rawText.length > MAX_RESPONSE_CHARS) {
    throw new Error("模型输出超过大小限制");
  }
  const cleaned = stripThinkingTags(rawText);
  if (!cleaned) {
    throw new Error("模型返回格式无效，请重试");
  }

  // 1. Direct JSON parse
  try {
    const parsed = JSON.parse(cleaned);
    if (parsed && typeof parsed === "object") return parsed;
  } catch {
    // try fenced or balanced extraction
  }

  // 2. Markdown code fences (```json ... ``` or ``` ... ```)
  const fenceRegex = /```(?:json)?\s*([\s\S]*?)```/gi;
  let match: RegExpExecArray | null;
  while ((match = fenceRegex.exec(cleaned)) !== null) {
    const inner = match[1].trim();
    if (!inner) continue;
    try {
      const parsed = JSON.parse(inner);
      if (parsed && typeof parsed === "object") return parsed;
    } catch {
      // continue scanning
    }
  }

  // 3. Balanced JSON object extraction (prefer largest valid object)
  const candidates = findBalancedJsonObjects(cleaned).sort(
    (a, b) => b.length - a.length,
  );
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object") return parsed;
    } catch {
      // keep trying
    }
  }

  throw new Error("模型返回格式无效，请重试");
}

function parseImageDataUrl(
  attachment: AdapterImageAttachment,
): { mimeType: string; base64: string } | null {
  const match =
    /^data:(image\/(?:png|jpeg|jpg|webp|gif));base64,([A-Za-z0-9+/=\s]+)$/i.exec(
      attachment.dataUrl.trim(),
    );
  if (!match) return null;
  const mimeType =
    match[1].toLowerCase() === "image/jpg"
      ? "image/jpeg"
      : match[1].toLowerCase();
  return {
    mimeType,
    base64: match[2].replace(/\s+/g, ""),
  };
}

function degradationChain(mode: StructuredOutputMode): StructuredOutputMode[] {
  switch (mode) {
    case "json_schema":
      return ["json_schema", "json_object", "prompt_json"];
    case "json_object":
      return ["json_object", "prompt_json"];
    case "tool_call":
      return ["tool_call", "prompt_json"];
    case "prompt_json":
      return ["prompt_json"];
  }
}

async function runWithDegradation(
  initialMode: StructuredOutputMode,
  execute: (mode: StructuredOutputMode) => Promise<AdapterResponse>,
): Promise<AdapterResponse> {
  const chain = degradationChain(initialMode);
  let lastError: unknown;
  for (let i = 0; i < chain.length; i++) {
    const mode = chain[i];
    try {
      return await execute(mode);
    } catch (error) {
      lastError = error;
      const isRecoverable400 =
        error instanceof AdapterHttpError &&
        error.status === 400 &&
        i < chain.length - 1;
      if (!isRecoverable400) {
        throw error;
      }
    }
  }
  throw lastError;
}

interface ParsedSseEvent {
  event: string;
  data: string;
}

async function readSseStream(
  body: ReadableStream<Uint8Array>,
  onEvent: (ev: ParsedSseEvent) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let currentEvent = "message";
  let dataLines: string[] = [];

  const flush = () => {
    if (dataLines.length > 0) {
      onEvent({ event: currentEvent, data: dataLines.join("\n") });
      dataLines = [];
    }
    currentEvent = "message";
  };

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line === "") {
          flush();
          continue;
        }
        if (line.startsWith(":")) continue;
        if (line.startsWith("event:")) {
          currentEvent = line.slice(6).trim() || "message";
        } else if (line.startsWith("data:")) {
          const piece = line.slice(5);
          dataLines.push(piece.startsWith(" ") ? piece.slice(1) : piece);
        }
      }
    }
    if (buffer.trim()) {
      const line = buffer.trim();
      if (line.startsWith("data:")) {
        const piece = line.slice(5);
        dataLines.push(piece.startsWith(" ") ? piece.slice(1) : piece);
      }
    }
    flush();
  } finally {
    reader.releaseLock();
  }
}

function buildOpenAIContent(
  msg: AdapterMessage,
  supportsVision: boolean,
): string | Array<Record<string, unknown>> {
  if (!supportsVision || !msg.images?.length) {
    return msg.text;
  }
  const parts: Array<Record<string, unknown>> = [
    { type: "text", text: msg.text },
  ];
  for (const img of msg.images) {
    const parsed = parseImageDataUrl(img);
    if (!parsed) continue;
    parts.push({
      type: "image_url",
      image_url: { url: `data:${parsed.mimeType};base64,${parsed.base64}` },
    });
  }
  return parts.length > 1 ? parts : msg.text;
}

function extractOpenAIMessageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (
          part &&
          typeof part === "object" &&
          (part as { type?: unknown }).type === "text" &&
          typeof (part as { text?: unknown }).text === "string"
        ) {
          return (part as { text: string }).text;
        }
        return "";
      })
      .join("");
  }
  return "";
}

// Keep the transport and size limit identical for complete(), SSE and JSON-only proxies.
interface ResponseDecoder {
  json(payload: unknown): void;
  event(payload: unknown): void;
  finish(): AdapterResponse;
}

class ResponseBuffer {
  readonly calls = new Map<number, AdapterToolCall>();
  text = "";
  usage?: AdapterResponse["usage"];
  finishReason?: string;
  private size = 0;

  constructor(
    readonly mode: StructuredOutputMode,
    readonly onDelta?: (piece: string) => void,
  ) {}

  count(piece: string) {
    this.size += piece.length;
    if (this.size > MAX_RESPONSE_CHARS) throw new Error("模型输出超过大小限制");
  }

  append(piece: string) {
    if (!piece) return;
    this.count(piece);
    this.text += piece;
    this.onDelta?.(piece);
  }

  finish(): AdapterResponse {
    const toolCalls = [...this.calls.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, call]) => call);
    if (!this.text.trim() && !toolCalls.length)
      throw new Error("模型未返回设计内容");
    return {
      text: this.text,
      structuredModeUsed: this.mode,
      usage: this.usage,
      ...(this.finishReason && { finishReason: this.finishReason }),
      ...(toolCalls.length && { toolCalls }),
    };
  }
}

abstract class HttpModelAdapter implements UnifiedModelAdapter {
  constructor(
    protected readonly config: AdapterConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}
  protected abstract endpoint(stream: boolean): string;
  protected abstract headers(): Record<string, string>;
  protected abstract buildBody(
    request: AdapterRequest,
    mode: StructuredOutputMode,
    stream: boolean,
  ): Record<string, unknown>;
  protected abstract decoder(
    buffer: ResponseBuffer,
    native: boolean,
  ): ResponseDecoder;

  complete(request: AdapterRequest, signal: AbortSignal) {
    return this.send(request, signal);
  }
  stream(
    request: AdapterRequest,
    onDelta: (delta: string) => void,
    signal: AbortSignal,
  ) {
    return this.send(request, signal, onDelta);
  }

  private async send(
    request: AdapterRequest,
    signal: AbortSignal,
    onDelta?: (delta: string) => void,
  ) {
    const native = Boolean(request.tools?.length);
    const execute = async (mode: StructuredOutputMode) => {
      const stream = !!onDelta;
      const response = await this.fetchImpl(this.endpoint(stream), {
        method: "POST",
        signal,
        headers: this.headers(),
        body: JSON.stringify(this.buildBody(request, mode, stream)),
      });
      if (!response.ok) throw new AdapterHttpError(response.status);
      const decoder = this.decoder(new ResponseBuffer(mode, onDelta), native);
      if (
        !onDelta ||
        !response.body ||
        response.headers.get("content-type")?.includes("application/json")
      ) {
        decoder.json(await response.json());
      } else {
        await readSseStream(response.body, ({ data }) => {
          let payload: unknown;
          try {
            payload = JSON.parse(data);
          } catch {
            return;
          } // [DONE] and keep-alives
          if (payload && typeof payload === "object" && "error" in payload)
            throw new Error("模型服务中断了流式响应");
          decoder.event(payload);
        });
      }
      return decoder.finish();
    };
    // Native tools must fail directly so the engine can switch prompts on the first 400.
    return native
      ? execute("tool_call")
      : runWithDegradation(
          request.structuredOutputOverride ??
            this.config.capabilities.structuredOutput,
          execute,
        );
  }
}

interface OpenAIChoiceMessage {
  content?: unknown;
  reasoning_content?: string;
  tool_calls?: Array<{
    index?: number;
    id?: string;
    function?: { name?: string; arguments?: string };
  }>;
}
interface OpenAIPayload {
  choices?: Array<{
    message?: OpenAIChoiceMessage;
    delta?: OpenAIChoiceMessage;
    finish_reason?: string;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

export class OpenAICompatibleAdapter extends HttpModelAdapter {
  protected buildBody(
    request: AdapterRequest,
    mode: StructuredOutputMode,
    stream: boolean,
  ): Record<string, unknown> {
    const { capabilities, model } = this.config;
    const maxTokens = request.maxOutputTokens ?? capabilities.maxOutputTokens;
    const body: Record<string, unknown> = {
      model,
      stream,
      messages: request.messages.map((msg) => ({
        role: msg.role,
        content: buildOpenAIContent(msg, capabilities.supportsVision),
        ...(msg.role === "assistant" &&
          msg.toolCalls?.length && {
            tool_calls: msg.toolCalls.map((c) => ({
              id: c.id,
              type: "function",
              function: { name: c.name, arguments: c.arguments },
            })),
          }),
        ...(msg.role === "assistant" &&
          msg.reasoningContent !== undefined && {
            reasoning_content: msg.reasoningContent,
          }),
        ...(msg.role === "tool" && { tool_call_id: msg.toolCallId }),
      })),
      [capabilities.tokenLimitParam]: maxTokens,
    };

    if (capabilities.temperatureMode === "fixed_one") {
      body.temperature = 1;
    } else if (capabilities.temperatureMode === "normal") {
      body.temperature = request.temperature ?? 0.3;
    }

    if (request.tools?.length) {
      body.tools = request.tools.map((t) => ({
        type: "function",
        function: t,
      }));
      if (request.toolChoice) body.tool_choice = request.toolChoice;
    } else if (mode === "json_schema" && request.jsonSchema) {
      body.response_format = {
        type: "json_schema",
        json_schema: {
          name: request.jsonSchema.name,
          strict: false,
          schema: request.jsonSchema.schema,
        },
      };
    } else if (mode === "json_object") {
      body.response_format = { type: "json_object" };
    }

    return body;
  }

  protected headers(): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...(this.config.extraHeaders ?? {}),
    };
    if (this.config.apiKey.trim()) {
      headers.Authorization = `Bearer ${this.config.apiKey.trim()}`;
    }
    return headers;
  }

  protected endpoint(): string {
    const base = normalizeBaseUrl(this.config.baseUrl);
    if (!base) throw new Error("模型服务地址未配置");
    return `${base}/chat/completions`;
  }

  protected decoder(buffer: ResponseBuffer, native: boolean): ResponseDecoder {
    let reasoning: string | undefined;
    const consume = (raw: unknown, streaming: boolean) => {
      const payload = raw as OpenAIPayload;
      const choice = payload.choices?.[0];
      const msg = streaming ? choice?.delta : choice?.message;
      if (choice?.finish_reason) buffer.finishReason = choice.finish_reason;
      if (payload.usage)
        buffer.usage = {
          inputTokens: payload.usage.prompt_tokens,
          outputTokens: payload.usage.completion_tokens,
        };
      buffer.append(extractOpenAIMessageText(msg?.content));
      if (!native) return;
      if (typeof msg?.reasoning_content === "string") {
        buffer.count(msg.reasoning_content);
        reasoning = (reasoning ?? "") + msg.reasoning_content;
      }
      for (const [position, delta] of (msg?.tool_calls ?? []).entries()) {
        const index = delta.index ?? position;
        const call = buffer.calls.get(index) ?? {
          id: "",
          name: "",
          arguments: "",
        };
        buffer.count(
          (delta.id ?? "") +
            (delta.function?.name ?? "") +
            (delta.function?.arguments ?? ""),
        );
        call.id += delta.id ?? "";
        call.name += delta.function?.name ?? "";
        call.arguments += delta.function?.arguments ?? "";
        buffer.calls.set(index, call);
      }
    };
    return {
      json: (raw) => consume(raw, false),
      event: (raw) => consume(raw, true),
      finish: () => {
        const res = buffer.finish();
        if (
          native &&
          !res.toolCalls?.length &&
          /DSML[\uFF5C|]+\s*invoke/i.test(res.text)
        ) {
          const recovered = parseLeakedDsmlToolCalls(res.text);
          if (recovered.calls.length > 0) {
            return {
              ...res,
              text: recovered.cleanedText,
              toolCalls: recovered.calls,
              ...(reasoning !== undefined && { reasoningContent: reasoning }),
            };
          }
        }
        return {
          ...res,
          ...(reasoning !== undefined && { reasoningContent: reasoning }),
        };
      },
    };
  }
}

function parseLeakedDsmlToolCalls(text: string): {
  calls: AdapterToolCall[];
  cleanedText: string;
} {
  const calls: AdapterToolCall[] = [];
  const invokeRe =
    /<[\uFF5C|]+DSML[\uFF5C|]+\s*invoke\s+name="([^"]+)"[^>]*>([\s\S]*?)<\/[\uFF5C|]+DSML[\uFF5C|]+\s*invoke>/gi;
  const paramRe =
    /<[\uFF5C|]+DSML[\uFF5C|]+\s*parameter\s+name="([^"]+)"(?:\s+string="(true|false)")?[^>]*>([\s\S]*?)<\/[\uFF5C|]+DSML[\uFF5C|]+\s*parameter>/gi;
  let match: RegExpExecArray | null;
  let index = 0;
  while ((match = invokeRe.exec(text)) !== null) {
    const name = match[1].trim();
    const body = match[2];
    const args: Record<string, unknown> = {};
    paramRe.lastIndex = 0;
    let p: RegExpExecArray | null;
    while ((p = paramRe.exec(body)) !== null) {
      const key = p[1].trim();
      const isStr = p[2] !== "false";
      const rawVal = p[3];
      if (!isStr) {
        try {
          args[key] = JSON.parse(rawVal.trim());
        } catch {
          args[key] = rawVal;
        }
      } else {
        args[key] = rawVal;
      }
    }
    calls.push({
      id: `dsml_call_${++index}`,
      name,
      arguments: JSON.stringify(args),
    });
  }
  const cleanedText = text
    .replace(
      /<[\uFF5C|]+DSML[\uFF5C|]+\s*(?:function_)?calls>[\s\S]*?<\/[\uFF5C|]+DSML[\uFF5C|]+\s*(?:function_)?calls>/gi,
      "",
    )
    .replace(invokeRe, "")
    .trim();
  return { calls, cleanedText };
}

function appendToolResult(
  history: Record<string, unknown>[],
  field: "parts" | "content",
  result: Record<string, unknown>,
) {
  const last = history.at(-1);
  if (last?.role === "user" && Array.isArray(last[field]))
    last[field].push(result);
  else history.push({ role: "user", [field]: [result] });
}

interface AnthropicBlock {
  type: string;
  id?: string;
  name?: string;
  input?: unknown;
  text?: string;
}
interface AnthropicPayload {
  type?: string;
  index?: number;
  content?: AnthropicBlock[];
  content_block?: AnthropicBlock;
  stop_reason?: string;
  message?: { usage?: { input_tokens?: number } };
  delta?: { text?: string; partial_json?: string; stop_reason?: string };
  usage?: { input_tokens?: number; output_tokens?: number };
}

export class AnthropicAdapter extends HttpModelAdapter {
  protected endpoint(): string {
    const base = normalizeBaseUrl(this.config.baseUrl);
    if (!base) throw new Error("模型服务地址未配置");
    return `${base}/messages`;
  }

  protected headers(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      "x-api-key": this.config.apiKey.trim(),
      "anthropic-version": "2023-06-01",
      ...(this.config.extraHeaders ?? {}),
    };
  }

  protected buildBody(
    request: AdapterRequest,
    mode: StructuredOutputMode,
    stream: boolean,
  ): Record<string, unknown> {
    const { capabilities, model } = this.config;
    const systemParts: string[] = [];
    const messages: Array<Record<string, unknown>> = [];

    for (const msg of request.messages) {
      if (msg.role === "system") {
        systemParts.push(msg.text);
        continue;
      }
      if (msg.role === "tool") {
        appendToolResult(messages, "content", {
          type: "tool_result",
          tool_use_id: msg.toolCallId,
          content: msg.text,
        });
        continue;
      }
      if (msg.role === "assistant" && msg.toolCalls?.length) {
        messages.push({
          role: "assistant",
          content: [
            ...(msg.text ? [{ type: "text", text: msg.text }] : []),
            ...msg.toolCalls.map((c) => ({
              type: "tool_use",
              id: c.id,
              name: c.name,
              input: JSON.parse(c.arguments),
            })),
          ],
        });
        continue;
      }
      if (capabilities.supportsVision && msg.images?.length) {
        const content: Array<Record<string, unknown>> = [];
        for (const img of msg.images) {
          const parsed = parseImageDataUrl(img);
          if (!parsed) continue;
          content.push({
            type: "image",
            source: {
              type: "base64",
              media_type: parsed.mimeType,
              data: parsed.base64,
            },
          });
        }
        content.push({ type: "text", text: msg.text });
        messages.push({ role: msg.role, content });
      } else {
        messages.push({ role: msg.role, content: msg.text });
      }
    }

    const body: Record<string, unknown> = {
      model,
      max_tokens: request.maxOutputTokens ?? capabilities.maxOutputTokens,
      messages,
      stream,
    };

    if (systemParts.length > 0) {
      body.system = systemParts.join("\n\n");
    }
    if (capabilities.temperatureMode === "normal") {
      body.temperature = request.temperature ?? 0.3;
    } else if (capabilities.temperatureMode === "fixed_one") {
      body.temperature = 1;
    }

    if (request.tools?.length) {
      body.tools = request.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.parameters,
      }));
      body.tool_choice = {
        type:
          request.toolChoice === "required"
            ? "any"
            : (request.toolChoice ?? "auto"),
      };
    } else if (mode === "tool_call" && request.jsonSchema) {
      body.tools = [
        {
          name: request.jsonSchema.name,
          description:
            request.jsonSchema.description ??
            "Return the structured Forma design blueprint or edit response.",
          input_schema: request.jsonSchema.schema,
        },
      ];
      body.tool_choice = {
        type: "tool",
        name: request.jsonSchema.name,
      };
    }

    return body;
  }

  protected decoder(buffer: ResponseBuffer, native: boolean): ResponseDecoder {
    let legacyJson = "";
    const initialInputs = new Map<number, string>();
    const block = (b: AnthropicBlock, index: number) => {
      if (b.type === "text") buffer.append(b.text ?? "");
      if (native && b.type === "tool_use") {
        const input = JSON.stringify(b.input ?? {});
        buffer.count(input + (b.name ?? "") + (b.id ?? ""));
        initialInputs.set(index, input);
        buffer.calls.set(index, {
          id: b.id ?? "",
          name: b.name ?? "",
          arguments: "",
        });
      }
    };
    return {
      json: (raw) => {
        const p = raw as AnthropicPayload;
        const blocks = p.content ?? [];
        const forced = !native && blocks.find((b) => b.type === "tool_use");
        if (forced) buffer.append(JSON.stringify(forced.input ?? {}));
        else blocks.forEach(block);
        if (p.usage)
          buffer.usage = {
            inputTokens: p.usage.input_tokens,
            outputTokens: p.usage.output_tokens,
          };
        buffer.finishReason = p.stop_reason;
      },
      event: (raw) => {
        const p = raw as AnthropicPayload;
        const index = p.index ?? 0;
        if (p.message?.usage || p.usage)
          buffer.usage = {
            inputTokens:
              p.message?.usage?.input_tokens ?? buffer.usage?.inputTokens,
            outputTokens: p.usage?.output_tokens ?? buffer.usage?.outputTokens,
          };
        if (p.content_block) block(p.content_block, index);
        if (p.delta?.stop_reason) buffer.finishReason = p.delta.stop_reason;
        if (p.delta?.text) buffer.append(p.delta.text);
        const piece = p.delta?.partial_json;
        if (piece !== undefined) {
          buffer.count(piece);
          const call = buffer.calls.get(index);
          if (call) call.arguments += piece;
          else if (!native) {
            legacyJson += piece;
            buffer.onDelta?.(piece);
          }
        }
      },
      finish: () => {
        for (const [index, call] of buffer.calls)
          if (!call.arguments)
            call.arguments = initialInputs.get(index) ?? "{}";
        if (legacyJson.trim()) buffer.text = legacyJson.trim();
        return buffer.finish();
      },
    };
  }
}

interface GeminiPart {
  text?: string;
  thought?: boolean;
  thoughtSignature?: string;
  functionCall?: { id?: string; name: string; args?: Record<string, unknown> };
}
interface GeminiPayload {
  candidates?: Array<{
    content?: { parts?: GeminiPart[] };
    finishReason?: string;
  }>;
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
}

export class GeminiAdapter extends HttpModelAdapter {
  protected endpoint(stream: boolean): string {
    const base = normalizeBaseUrl(this.config.baseUrl);
    if (!base) throw new Error("模型服务地址未配置");
    const model = encodeURIComponent(
      this.config.model.replace(/^models\//, ""),
    );
    return stream
      ? `${base}/models/${model}:streamGenerateContent?alt=sse`
      : `${base}/models/${model}:generateContent`;
  }

  protected headers(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      "x-goog-api-key": this.config.apiKey.trim(),
      ...(this.config.extraHeaders ?? {}),
    };
  }

  protected buildBody(
    request: AdapterRequest,
    mode: StructuredOutputMode,
  ): Record<string, unknown> {
    const { capabilities } = this.config;
    const systemTexts: string[] = [];
    const contents: Array<Record<string, unknown>> = [];

    for (const msg of request.messages) {
      if (msg.role === "system") {
        systemTexts.push(msg.text);
        continue;
      }
      if (msg.role === "tool") {
        let response: unknown;
        try {
          response = JSON.parse(msg.text);
        } catch {
          response = msg.text;
        }
        if (
          !response ||
          typeof response !== "object" ||
          Array.isArray(response)
        )
          response = { result: response };
        const nativeCall = msg.toolCallId
          ? request.messages
              .flatMap((m) => m.geminiParts ?? [])
              .find((p) => p.functionCall?.id === msg.toolCallId)?.functionCall
          : undefined;
        const name =
          msg.toolName ??
          request.messages
            .flatMap((m) => m.toolCalls ?? [])
            .find((c) => c.id === msg.toolCallId)?.name;
        if (!name) throw new Error("工具结果缺少对应的函数名");
        appendToolResult(contents, "parts", {
          functionResponse: {
            name,
            ...(nativeCall?.id && { id: nativeCall.id }),
            response,
          },
        });
        continue;
      }
      if (msg.role === "assistant" && msg.toolCalls?.length) {
        contents.push({
          role: "model",
          parts: msg.geminiParts ?? [
            ...(msg.text ? [{ text: msg.text }] : []),
            ...msg.toolCalls.map((c) => ({
              functionCall: { name: c.name, args: JSON.parse(c.arguments) },
            })),
          ],
        });
        continue;
      }
      const parts: Array<Record<string, unknown>> = [{ text: msg.text }];
      if (capabilities.supportsVision && msg.images?.length) {
        for (const img of msg.images) {
          const parsed = parseImageDataUrl(img);
          if (!parsed) continue;
          parts.push({
            inlineData: {
              mimeType: parsed.mimeType,
              data: parsed.base64,
            },
          });
        }
      }
      contents.push({
        role: msg.role === "assistant" ? "model" : "user",
        parts,
      });
    }

    const generationConfig: Record<string, unknown> = {
      maxOutputTokens: request.maxOutputTokens ?? capabilities.maxOutputTokens,
    };
    if (capabilities.temperatureMode === "normal") {
      generationConfig.temperature = request.temperature ?? 0.3;
    } else if (capabilities.temperatureMode === "fixed_one") {
      generationConfig.temperature = 1;
    }
    if (
      !request.tools?.length &&
      (mode === "json_object" || mode === "json_schema")
    ) {
      generationConfig.responseMimeType = "application/json";
    }

    const body: Record<string, unknown> = {
      contents,
      generationConfig,
    };
    if (request.tools?.length) {
      body.tools = [
        {
          functionDeclarations: request.tools.map((t) => ({
            name: t.name,
            description: t.description,
            parametersJsonSchema: t.parameters,
          })),
        },
      ];
      if (request.toolChoice)
        body.toolConfig = {
          functionCallingConfig: {
            mode: { auto: "AUTO", required: "ANY", none: "NONE" }[
              request.toolChoice
            ],
          },
        };
    }
    if (systemTexts.length > 0) {
      body.systemInstruction = {
        parts: [{ text: systemTexts.join("\n\n") }],
      };
    }
    return body;
  }

  protected decoder(buffer: ResponseBuffer, native: boolean): ResponseDecoder {
    const history: GeminiPart[] = [];
    const consume = (raw: unknown) => {
      const p = raw as GeminiPayload;
      const candidate = p.candidates?.[0];
      if (candidate?.finishReason) buffer.finishReason = candidate.finishReason;
      if (p.usageMetadata)
        buffer.usage = {
          inputTokens: p.usageMetadata.promptTokenCount,
          outputTokens: p.usageMetadata.candidatesTokenCount,
        };
      for (const part of candidate?.content?.parts ?? []) {
        if (!part.thought) buffer.append(part.text ?? "");
        if (!native) continue;
        if (part.thoughtSignature) buffer.count(part.thoughtSignature);
        if (part.thought && part.text) buffer.count(part.text);
        history.push(part);
        const call = part.functionCall;
        if (call) {
          const args = JSON.stringify(call.args ?? {});
          buffer.count(args + call.name);
          buffer.calls.set(buffer.calls.size, {
            id: call.id || crypto.randomUUID(),
            name: call.name,
            arguments: args,
          });
        }
      }
    };
    return {
      json: consume,
      event: consume,
      finish: () => ({
        ...buffer.finish(),
        ...(buffer.calls.size && { geminiParts: history }),
      }),
    };
  }
}

export function createModelAdapter(
  config: AdapterConfig,
  fetchImpl: typeof fetch = fetch,
): UnifiedModelAdapter {
  switch (config.capabilities.protocol) {
    case "anthropic-messages":
      return new AnthropicAdapter(config, fetchImpl);
    case "gemini-native":
      return new GeminiAdapter(config, fetchImpl);
    case "openai-chat":
      return new OpenAICompatibleAdapter(config, fetchImpl);
  }
}
