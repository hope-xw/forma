import { lookupCatalogModel } from "./model-catalog";
import {
  detectProviderFromKey,
  findPresetByBaseUrl,
  getProviderPreset,
  normalizeBaseUrl,
  type ProviderPreset,
  type ProviderProtocol,
} from "./provider-registry";

export type StructuredOutputMode =
  "json_schema" | "json_object" | "tool_call" | "prompt_json";

export type CapabilitySource =
  "user-override" | "provider-api" | "builtin-catalog" | "heuristic";

export interface ModelCapabilityOverrides {
  supportsVision?: boolean;
  supportsTools?: boolean;
  isReasoning?: boolean;
  maxContextTokens?: number;
  maxOutputTokens?: number;
  structuredOutput?: StructuredOutputMode;
}

export interface RawDiscoveredModelMetadata {
  id: string;
  displayName?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  supportsVision?: boolean;
  supportsTools?: boolean;
  isReasoning?: boolean;
  structuredOutput?: StructuredOutputMode;
}

export interface ModelCapabilities {
  supportsTools?: boolean;
  capabilitySource?: CapabilitySource;
  visionKnown?: boolean;
  contextKnown?: boolean;
  protocol: ProviderProtocol;
  structuredOutput: StructuredOutputMode;
  supportsVision: boolean;
  supportsStreaming: boolean;
  isReasoning: boolean;
  maxContextTokens: number;
  maxOutputTokens: number;
  temperatureMode: "normal" | "fixed_one" | "omit";
  tokenLimitParam: "max_tokens" | "max_completion_tokens";
}

export interface DiscoveredModel {
  id: string;
  label: string;
  capabilities: ModelCapabilities;
  recommended?: boolean;
}

export interface ProbeInput {
  providerId?: string;
  apiKey?: string;
  baseUrl?: string;
  preferredModel?: string;
}

export interface ProbeResult {
  ok: true;
  providerId: string;
  providerName: string;
  baseUrl: string;
  protocol: ProviderProtocol;
  detectedBy: "key-prefix" | "probe" | "preset" | "custom-probe" | "local";
  selectedModel: string;
  models: DiscoveredModel[];
  capabilities: ModelCapabilities;
  probeNote?: string;
}

const NON_CHAT_MODEL_PATTERN =
  /(embedding|embed|whisper|tts|dall-e|image-gen|imagen|moderation|rerank|audio-preview|realtime|transcribe|speech|veo-|sora|flux|stable-diffusion|midjourney|bge-|text-similarity|code-search|davinci-002|babbage-002|computer-use|aqa|text-bison|chat-bison|gemma-2b-it-embed)/i;

const PROBE_TIMEOUT_MS = 6000;

function stripModelNamespace(modelId: string): string {
  const trimmed = modelId.trim();
  const slash = trimmed.lastIndexOf("/");
  return slash >= 0 ? trimmed.slice(slash + 1) : trimmed;
}

function positiveTokenLimit(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function mergeCapabilityFields(
  base: ModelCapabilities,
  fields: ModelCapabilityOverrides | undefined,
  source: "provider-api" | "user-override",
): ModelCapabilities {
  if (!fields) return base;
  const { supportsVision, supportsTools, isReasoning, structuredOutput } =
    fields;
  const context = positiveTokenLimit(fields.maxContextTokens)
    ? fields.maxContextTokens
    : undefined;
  const output = positiveTokenLimit(fields.maxOutputTokens)
    ? fields.maxOutputTokens
    : undefined;
  if (
    [
      supportsVision,
      supportsTools,
      isReasoning,
      structuredOutput,
      context,
      output,
    ].every((value) => value === undefined)
  )
    return base;
  return {
    ...base,
    supportsVision: supportsVision ?? base.supportsVision,
    supportsTools: supportsTools ?? base.supportsTools ?? false,
    isReasoning: isReasoning ?? base.isReasoning,
    structuredOutput: structuredOutput ?? base.structuredOutput,
    maxContextTokens: context ?? base.maxContextTokens,
    maxOutputTokens: output ?? base.maxOutputTokens,
    visionKnown: supportsVision !== undefined || Boolean(base.visionKnown),
    contextKnown: context !== undefined || Boolean(base.contextKnown),
    capabilitySource: source,
  };
}

export function applyCapabilityOverrides(
  base: ModelCapabilities,
  overrides?: ModelCapabilityOverrides,
): ModelCapabilities {
  return mergeCapabilityFields(base, overrides, "user-override");
}

export function resolveModelCapabilities({
  providerId,
  protocol,
  modelId,
  apiMeta,
  overrides,
}: {
  providerId: string;
  protocol: ProviderProtocol;
  modelId: string;
  apiMeta?: RawDiscoveredModelMetadata;
  overrides?: ModelCapabilityOverrides;
}): ModelCapabilities {
  const id = stripModelNamespace(modelId).toLowerCase();
  const local = providerId === "ollama";
  const catalog = lookupCatalogModel(providerId, modelId);
  const openAIReasoner = /^o1(?:[-_.]|$)/.test(id);
  const base: ModelCapabilities = {
    protocol,
    supportsStreaming: true,
    supportsVision:
      catalog?.supportsVision ??
      /vision|llava|minicpm-v|pixtral|qwen2-vl|^claude-(3|4|sonnet|opus)|^gemini-/.test(
        id,
      ),
    supportsTools: catalog?.supportsTools ?? false,
    isReasoning:
      catalog?.isReasoning ??
      (openAIReasoner || /thinking|reasoner|^r1|^qwq/.test(id)),
    maxContextTokens: catalog?.maxContextTokens ?? (local ? 32_000 : 128_000),
    maxOutputTokens: catalog?.maxOutputTokens ?? (local ? 4_096 : 8_192),
    temperatureMode:
      catalog?.temperatureMode ?? (openAIReasoner ? "omit" : "normal"),
    tokenLimitParam:
      catalog?.tokenLimitParam ??
      (openAIReasoner && protocol === "openai-chat"
        ? "max_completion_tokens"
        : "max_tokens"),
    structuredOutput:
      catalog?.structuredOutput ??
      (protocol === "anthropic-messages"
        ? "tool_call"
        : local
          ? "prompt_json"
          : "json_object"),
    capabilitySource: catalog ? "builtin-catalog" : "heuristic",
    visionKnown: Boolean(catalog),
    contextKnown: Boolean(catalog),
  };
  const auto = mergeCapabilityFields(
    base,
    apiMeta && { ...apiMeta, maxContextTokens: apiMeta.contextWindow },
    "provider-api",
  );
  return applyCapabilityOverrides(auto, overrides);
}

export function inferModelCapabilities(
  providerId: string,
  protocol: ProviderProtocol,
  modelId: string,
  apiMeta?: RawDiscoveredModelMetadata,
  overrides?: ModelCapabilityOverrides,
): ModelCapabilities {
  return resolveModelCapabilities({
    providerId,
    protocol,
    modelId,
    apiMeta,
    overrides,
  });
}

export function isChatDesignModel(modelId: string): boolean {
  const id = modelId.trim();
  if (!id) return false;
  if (NON_CHAT_MODEL_PATTERN.test(id)) return false;
  return true;
}

function scoreModelForDesign(
  modelId: string,
  recommendedOrder: readonly string[],
): number {
  const lower = modelId.toLowerCase();
  const base = stripModelNamespace(lower);
  let score = 0;

  const flash = /^deepseek-(?:flash$|v4(?:\.1)?-flash)/.test(base);
  const pro = /^deepseek-v4(?!.*flash)/.test(base);
  const recIndex = recommendedOrder.findIndex(
    (rec) =>
      rec.toLowerCase() === lower ||
      (flash && rec === "deepseek-flash") ||
      (pro && rec === "deepseek-v4-pro"),
  );
  if (recIndex >= 0) {
    score += 1000 - recIndex * 35;
  }

  // Flagship UI-design suitability boosts
  if (flash) score += 540;
  else if (
    pro ||
    /^(claude-(opus|sonnet|fable)-5|gemini-[34]|kimi-k3|glm-5|minimax-m2)/.test(
      base,
    )
  )
    score += 500;
  else if (base.startsWith("claude-sonnet-4")) score += 460;
  else if (base.startsWith("claude-3-7-sonnet")) score += 440;
  else if (base.startsWith("claude-3-5-sonnet")) score += 420;
  else if (base.startsWith("claude-opus-4")) score += 410;
  else if (
    base.startsWith("gpt-4.1") &&
    !base.includes("nano") &&
    !base.includes("mini")
  )
    score += 450;
  else if (
    base.startsWith("gpt-5") &&
    !base.includes("nano") &&
    !base.includes("mini")
  )
    score += 440;
  else if (base === "gpt-4o" || base.startsWith("gpt-4o-20")) score += 425;
  else if (base.startsWith("gemini-2.5-pro")) score += 450;
  else if (base.startsWith("gemini-2.5-flash") && !base.includes("lite"))
    score += 420;
  else if (base.startsWith("gemini-2.0-flash")) score += 390;
  else if (base.includes("kimi-k2.5")) score += 450;
  else if (base.includes("kimi-k2")) score += 420;
  else if (base === "deepseek-chat" || base.includes("deepseek-v3"))
    score += 430;
  else if (base.startsWith("qwen-max") || base.startsWith("qwen3-coder"))
    score += 430;
  else if (base.startsWith("qwen-plus") || base.includes("qwen2.5-72b"))
    score += 400;
  else if (
    base.startsWith("glm-4.5") &&
    !base.includes("air") &&
    !base.includes("flash")
  )
    score += 430;
  else if (base.startsWith("glm-4-plus")) score += 410;
  else if (base.includes("minimax-m1")) score += 420;
  else if (base.includes("doubao-seed")) score += 420;
  else if (base.includes("doubao-1-5-pro")) score += 400;

  // Mild preference for non-mini/non-lite models as default flagship
  if (
    base.includes("mini") ||
    base.includes("lite") ||
    base.includes("haiku") ||
    base.includes("nano")
  ) {
    score -= 30;
  }
  if (base.includes("reasoner") || base.includes("-r1")) {
    score -= 25;
  }
  if (
    base.includes("deprecated") ||
    base.includes("legacy") ||
    base.includes("0301") ||
    base.includes("0613")
  ) {
    score -= 200;
  }

  return score;
}

export function buildDiscoveredModels(
  providerId: string,
  protocol: ProviderProtocol,
  rawModels: readonly (string | RawDiscoveredModelMetadata)[],
  recommendedOrder: readonly string[] = [],
  preferredModel?: string,
): DiscoveredModel[] {
  const byId = new Map<string, RawDiscoveredModelMetadata>();
  for (const raw of rawModels) {
    const model = typeof raw === "string" ? { id: raw } : raw;
    const id = model.id.trim();
    if (isChatDesignModel(id) && !byId.has(id)) byId.set(id, model);
  }
  const preferred = preferredModel?.trim();
  if (preferred && !byId.has(preferred)) byId.set(preferred, { id: preferred });

  const ids = [...byId.keys()].sort(
    (a, b) =>
      scoreModelForDesign(b, recommendedOrder) -
        scoreModelForDesign(a, recommendedOrder) || a.localeCompare(b),
  );
  const recSet = new Set(recommendedOrder.map((m) => m.toLowerCase()));
  return ids.map((id, index) => {
    const model = byId.get(id)!;
    const displayName =
      model.displayName?.trim() ||
      lookupCatalogModel(providerId, id)?.displayName;
    return {
      id,
      label:
        displayName && displayName !== id
          ? `${id} (${displayName.slice(0, 256)})`
          : id,
      capabilities: inferModelCapabilities(providerId, protocol, id, model),
      recommended: index < 3 || recSet.has(id.toLowerCase()),
    };
  });
}

interface EndpointProbeOutcome {
  ok: boolean;
  status: number;
  protocol: ProviderProtocol;
  baseUrl: string;
  models: RawDiscoveredModelMetadata[];
}

function makeTimeoutSignal(
  callerSignal?: AbortSignal,
  timeoutMs = PROBE_TIMEOUT_MS,
): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return callerSignal ? AbortSignal.any([callerSignal, timeout]) : timeout;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function textValue(value: unknown): string | undefined {
  return typeof value === "string" ? value.trim() || undefined : undefined;
}

function boolValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function visionFromModalities(raw: unknown): boolean | undefined {
  if (
    !Array.isArray(raw) ||
    !raw.length ||
    !raw.every((v) => typeof v === "string" && v.trim())
  )
    return undefined;
  return raw.some((v) => /^(image|vision)$/i.test(v.trim()));
}

export function parseOpenAIModelsBody(
  body: unknown,
  protocol: ProviderProtocol = "openai-chat",
): RawDiscoveredModelMetadata[] | null {
  const obj = record(body);
  const standard = Array.isArray(obj.data);
  const items = standard ? obj.data : obj.models;
  if (!Array.isArray(items)) return null;
  const models: RawDiscoveredModelMetadata[] = [];
  for (const item of items) {
    const m = record(item);
    // Some compatible gateways use a models list of bare IDs or name-only objects.
    const id =
      textValue(m.id) ??
      (!standard ? (textValue(item) ?? textValue(m.name)) : undefined);
    if (!id) continue;
    const architecture = record(m.architecture);
    const caps = record(m.capabilities);
    const parameters = Array.isArray(m.supported_parameters)
      ? m.supported_parameters
      : [];
    const input = textValue(architecture.modality)?.split("->")[0];
    models.push({
      id,
      displayName: textValue(m.display_name) ?? textValue(m.name),
      contextWindow: [
        m.context_window,
        m.context_length,
        m.max_context_length,
        m.max_input_tokens,
        m.input_token_limit,
      ].find(positiveTokenLimit),
      maxOutputTokens: [
        m.max_output_tokens,
        m.max_completion_tokens,
        m.output_token_limit,
        record(m.top_provider).max_completion_tokens,
        protocol === "anthropic-messages" ? m.max_tokens : undefined,
      ].find(positiveTokenLimit),
      supportsVision:
        visionFromModalities(m.input_modalities) ??
        visionFromModalities(architecture.input_modalities) ??
        (input ? /image|vision/i.test(input) : undefined) ??
        visionFromModalities(m.modalities) ??
        visionFromModalities(record(m.modalities).input) ??
        boolValue(caps.vision) ??
        boolValue(record(caps.image_input).supported) ??
        boolValue(m.supports_vision),
      supportsTools:
        boolValue(caps.tools) ??
        boolValue(caps.function_calling) ??
        (parameters.includes("tools") || undefined),
      isReasoning:
        boolValue(caps.reasoning) ??
        boolValue(caps.thinking) ??
        boolValue(record(caps.thinking).supported) ??
        (parameters.includes("reasoning") ||
          parameters.includes("include_reasoning") ||
          undefined),
      structuredOutput: parameters.includes("structured_outputs")
        ? "json_schema"
        : undefined,
    });
  }
  return models;
}

export function parseGeminiModelsBody(
  body: unknown,
): RawDiscoveredModelMetadata[] | null {
  const items = record(body).models;
  if (!Array.isArray(items)) return null;
  const models: RawDiscoveredModelMetadata[] = [];
  for (const item of items) {
    const m = record(item);
    const id = textValue(m.name)?.replace(/^models\//, "");
    if (
      !id ||
      (Array.isArray(m.supportedGenerationMethods) &&
        !m.supportedGenerationMethods.includes("generateContent"))
    )
      continue;
    models.push({
      id,
      displayName: textValue(m.displayName),
      contextWindow: positiveTokenLimit(m.inputTokenLimit)
        ? m.inputTokenLimit
        : undefined,
      maxOutputTokens: positiveTokenLimit(m.outputTokenLimit)
        ? m.outputTokenLimit
        : undefined,
    });
  }
  return models;
}

async function probeSingleEndpoint(
  baseUrl: string,
  protocol: ProviderProtocol,
  apiKey: string,
  extraHeaders: Record<string, string> | undefined,
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
  detectGatewayProtocol = false,
): Promise<EndpointProbeOutcome> {
  const cleanUrl = normalizeBaseUrl(baseUrl);
  const endpoint = `${cleanUrl}/models`;
  const headers: Record<string, string> = {
    Accept: "application/json",
    ...(extraHeaders ?? {}),
  };

  if (protocol === "openai-chat") {
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  } else if (protocol === "anthropic-messages") {
    if (apiKey) headers["x-api-key"] = apiKey;
    headers["anthropic-version"] = "2023-06-01";
  } else if (protocol === "gemini-native") {
    if (apiKey) headers["x-goog-api-key"] = apiKey;
  }

  try {
    const response = await fetchImpl(endpoint, {
      method: "GET",
      headers,
      // Regional fallback uses preset URLs. A redirect must not forward API-key headers.
      redirect: "error",
      signal: makeTimeoutSignal(signal),
    });

    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        protocol,
        baseUrl: cleanUrl,
        models: [],
      };
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return {
        ok: false,
        status: 502,
        protocol,
        baseUrl: cleanUrl,
        models: [],
      };
    }

    // A custom gateway may answer an OpenAI-style probe with a native Gemini list.
    const items = record(body).models;
    const nativeGatewayList =
      detectGatewayProtocol &&
      Array.isArray(items) &&
      items.some((item) => {
        const { id, name, supportedGenerationMethods } = record(item);
        return (
          !id &&
          typeof name === "string" &&
          name.startsWith("models/") &&
          (Array.isArray(supportedGenerationMethods) ||
            name.startsWith("models/gemini"))
        );
      });
    let effectiveProtocol: ProviderProtocol = nativeGatewayList
      ? "gemini-native"
      : protocol;
    let models =
      effectiveProtocol === "gemini-native"
        ? parseGeminiModelsBody(body)
        : parseOpenAIModelsBody(body, protocol);
    // Other Gemini proxies return OpenAI-style IDs with a native models/ prefix.
    if (
      detectGatewayProtocol &&
      effectiveProtocol === "openai-chat" &&
      models?.length &&
      models.every((model) => model.id.startsWith("models/gemini"))
    ) {
      effectiveProtocol = "gemini-native";
      models = models.map((model) => ({
        ...model,
        id: model.id.slice("models/".length),
      }));
    }
    return {
      ok: models !== null,
      status: models !== null ? 200 : 502,
      protocol: effectiveProtocol,
      baseUrl: cleanUrl,
      models: models ?? [],
    };
  } catch {
    return {
      ok: false,
      status: 0,
      protocol,
      baseUrl: cleanUrl,
      models: [],
    };
  }
}

async function probeOllama(
  baseUrl: string,
  preferredModel: string | undefined,
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
): Promise<ProbeResult> {
  const preset = getProviderPreset("ollama")!;
  const cleanUrl = normalizeBaseUrl(baseUrl || preset.defaultBaseUrl);
  const openAIResult = await probeSingleEndpoint(
    cleanUrl,
    "openai-chat",
    "",
    undefined,
    fetchImpl,
    signal,
  );

  let models = openAIResult.models;
  const origin = new URL(cleanUrl).origin;
  let reachable = openAIResult.ok;

  if (!reachable) {
    // Also try Ollama native /api/tags endpoint on the same origin
    try {
      const resp = await fetchImpl(`${origin}/api/tags`, {
        method: "GET",
        headers: { Accept: "application/json" },
        signal: makeTimeoutSignal(signal),
      });
      if (resp.ok) {
        reachable = true;
        const items = record(await resp.json()).models;
        if (Array.isArray(items)) {
          models = items.flatMap((item) => {
            const m = record(item);
            const id = textValue(m.name) ?? textValue(m.model);
            return id ? [{ id }] : [];
          });
        }
      }
    } catch {
      // ignore fallback failure
    }
  }

  if (!reachable) {
    throw new Error(
      "无法连接本机 Ollama 服务（请先运行 ollama serve，或检查地址设置）",
    );
  }

  await Promise.all(
    models.slice(0, 8).map(async (model) => {
      try {
        const response = await fetchImpl(`${origin}/api/show`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: model.id }),
          signal: makeTimeoutSignal(signal, 2000),
        });
        if (!response.ok) return;
        const detail = record(await response.json());
        if (
          Array.isArray(detail.capabilities) &&
          detail.capabilities.every((c) => typeof c === "string")
        ) {
          model.supportsVision = detail.capabilities.includes("vision");
          model.supportsTools = detail.capabilities.includes("tools");
          model.isReasoning = detail.capabilities.includes("thinking");
        }
        for (const [key, value] of Object.entries(record(detail.model_info))) {
          if (key.endsWith(".context_length") && positiveTokenLimit(value)) {
            model.contextWindow = value;
            break;
          }
        }
      } catch {
        // Older Ollama versions and remote proxies may not expose model details.
      }
    }),
  );
  signal?.throwIfAborted();
  const useFallback = models.length === 0;
  const discovered = buildDiscoveredModels(
    "ollama",
    "openai-chat",
    useFallback ? preset.recommendedModels : models,
    preset.recommendedModels,
    preferredModel,
  );
  const selected =
    (preferredModel &&
      discovered.find((m) => m.id === preferredModel.trim())) ||
    discovered[0];

  return {
    ok: true,
    providerId: "ollama",
    providerName: preset.name,
    baseUrl: cleanUrl,
    protocol: "openai-chat",
    detectedBy: "local",
    selectedModel: selected.id,
    models: discovered,
    capabilities: selected.capabilities,
    ...(useFallback
      ? {
          probeNote:
            "已连接本机 Ollama，但尚未拉取任何模型，请先执行 ollama pull 后刷新",
        }
      : {}),
  };
}

async function probePreset(
  preset: ProviderPreset,
  apiKey: string,
  overrideBaseUrl: string | undefined,
  preferredModel: string | undefined,
  detectedBy: ProbeResult["detectedBy"],
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
): Promise<ProbeResult> {
  const protocol: ProviderProtocol =
    preset.protocol === "auto" ? "openai-chat" : preset.protocol;
  const candidateUrls = overrideBaseUrl?.trim()
    ? [normalizeBaseUrl(overrideBaseUrl)]
    : preset.baseUrls;

  if (!candidateUrls.length) {
    throw new Error("请提供有效的模型服务地址");
  }

  let saw401 = false;
  let fallbackUrl: string | null = null;
  let lastStatus = 0;

  for (const url of candidateUrls) {
    const outcome = await probeSingleEndpoint(
      url,
      protocol,
      apiKey,
      preset.extraHeaders,
      fetchImpl,
      signal,
    );

    if (outcome.ok) {
      const usableModels = outcome.models.filter((model) =>
        isChatDesignModel(model.id),
      );
      const useCuratedFallback = usableModels.length === 0;
      const models = buildDiscoveredModels(
        preset.id,
        protocol,
        useCuratedFallback ? preset.recommendedModels : usableModels,
        preset.recommendedModels,
        preferredModel,
      );
      if (!models.length) {
        throw new Error(`未在 ${preset.shortName} 找到可用的对话模型`);
      }
      const selected =
        (preferredModel &&
          models.find((m) => m.id === preferredModel.trim())) ||
        models[0];
      return {
        ok: true,
        providerId: preset.id,
        providerName: preset.name,
        baseUrl: outcome.baseUrl,
        protocol,
        detectedBy,
        selectedModel: selected.id,
        models,
        capabilities: selected.capabilities,
        ...(useCuratedFallback
          ? { probeNote: "模型列表为空，已载入推荐模型" }
          : {}),
      };
    }

    lastStatus = outcome.status;
    if (outcome.status === 401) {
      saw401 = true;
      continue;
    }
    if (outcome.status === 403 || outcome.status === 404) {
      if (!fallbackUrl) fallbackUrl = outcome.baseUrl;
      continue;
    }
  }

  if (
    fallbackUrl &&
    (preset.recommendedModels.length > 0 || preferredModel?.trim())
  ) {
    const models = buildDiscoveredModels(
      preset.id,
      protocol,
      preset.recommendedModels,
      preset.recommendedModels,
      preferredModel,
    );
    const selected =
      (preferredModel && models.find((m) => m.id === preferredModel.trim())) ||
      models[0];
    return {
      ok: true,
      providerId: preset.id,
      providerName: preset.name,
      baseUrl: fallbackUrl,
      protocol,
      detectedBy,
      selectedModel: selected.id,
      models,
      capabilities: selected.capabilities,
      probeNote: "该网关限制了模型列表接口，已自动载入推荐模型",
    };
  }

  if (saw401) {
    throw new Error(
      `${preset.shortName} 鉴权失败（HTTP 401），请检查 API Key 是否正确或已启用`,
    );
  }
  if (lastStatus >= 400) {
    throw new Error(
      `${preset.shortName} 连接失败（HTTP ${lastStatus}），请检查服务地址或账户状态`,
    );
  }
  throw new Error(`无法连接到 ${preset.shortName}，请检查网络连接或稍后重试`);
}

async function probeCustomGateway(
  baseUrl: string,
  apiKey: string,
  preferredModel: string | undefined,
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
): Promise<ProbeResult> {
  const cleanUrl = normalizeBaseUrl(baseUrl);
  if (!cleanUrl) {
    throw new Error("自定义网关需要提供 Base URL");
  }

  // Build candidate protocol probes:
  // 1) OpenAI-compatible on cleanUrl (and cleanUrl/v1 if not versioned)
  // 2) Anthropic Messages on cleanUrl (and cleanUrl/v1 if not versioned)
  // 3) Gemini Native on cleanUrl (and cleanUrl/v1beta if not versioned)
  const hasVersionSuffix = /\/v\d+(beta\d*)?$/i.test(cleanUrl);
  const attempts: { url: string; protocol: ProviderProtocol }[] = [
    { url: cleanUrl, protocol: "openai-chat" },
    { url: cleanUrl, protocol: "anthropic-messages" },
    { url: cleanUrl, protocol: "gemini-native" },
  ];
  if (!hasVersionSuffix) {
    attempts.push(
      { url: `${cleanUrl}/v1`, protocol: "openai-chat" },
      { url: `${cleanUrl}/v1`, protocol: "anthropic-messages" },
      { url: `${cleanUrl}/v1beta`, protocol: "gemini-native" },
    );
  }

  // Reorder subtly if key prefix gives a strong hint for protocol
  const keyHint = detectProviderFromKey(apiKey);
  if (keyHint.providerId === "anthropic") {
    attempts.sort((a, b) =>
      a.protocol === "anthropic-messages"
        ? -1
        : b.protocol === "anthropic-messages"
          ? 1
          : 0,
    );
  } else if (keyHint.providerId === "gemini") {
    attempts.sort((a, b) =>
      a.protocol === "gemini-native"
        ? -1
        : b.protocol === "gemini-native"
          ? 1
          : 0,
    );
  }

  let saw401 = false;
  let sawForbiddenOrNotFound = false;

  for (const attempt of attempts) {
    const outcome = await probeSingleEndpoint(
      attempt.url,
      attempt.protocol,
      apiKey,
      undefined,
      fetchImpl,
      signal,
      true,
    );
    if (outcome.ok) {
      const models = buildDiscoveredModels(
        "custom",
        outcome.protocol,
        outcome.models,
        [],
        preferredModel,
      );
      if (!models.length) continue;
      const selected =
        (preferredModel &&
          models.find((m) => m.id === preferredModel.trim())) ||
        models[0];
      return {
        ok: true,
        providerId: "custom",
        providerName: "自定义兼容网关",
        baseUrl: outcome.baseUrl,
        protocol: outcome.protocol,
        detectedBy: "custom-probe",
        selectedModel: selected.id,
        models,
        capabilities: selected.capabilities,
      };
    }
    if (outcome.status === 401) saw401 = true;
    if (outcome.status === 403 || outcome.status === 404) {
      sawForbiddenOrNotFound = true;
    }
  }

  if (sawForbiddenOrNotFound && preferredModel?.trim()) {
    const fallbackProtocol: ProviderProtocol =
      keyHint.providerId === "anthropic"
        ? "anthropic-messages"
        : keyHint.providerId === "gemini"
          ? "gemini-native"
          : "openai-chat";
    const models = buildDiscoveredModels(
      "custom",
      fallbackProtocol,
      [preferredModel.trim()],
      [],
      preferredModel,
    );
    return {
      ok: true,
      providerId: "custom",
      providerName: "自定义兼容网关",
      baseUrl: cleanUrl,
      protocol: fallbackProtocol,
      detectedBy: "custom-probe",
      selectedModel: models[0].id,
      models,
      capabilities: models[0].capabilities,
      probeNote: "网关未开放 /models 列表接口，已按指定模型保存配置",
    };
  }

  if (saw401) {
    throw new Error("自定义网关鉴权失败（HTTP 401），请检查 API Key");
  }
  throw new Error(
    "无法自动识别该自定义网关协议，请检查 Base URL 是否可访问，或在高级选项中填写模型名称",
  );
}

export async function probeProvider(
  input: ProbeInput,
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<ProbeResult> {
  const rawProviderId = (input.providerId ?? "auto").trim() || "auto";
  const apiKey = (input.apiKey ?? "").trim();
  const rawBaseUrl = (input.baseUrl ?? "").trim();
  const preferredModel = input.preferredModel?.trim() || undefined;

  if (rawProviderId === "ollama") {
    return probeOllama(rawBaseUrl, preferredModel, fetchImpl, signal);
  }

  if (rawProviderId === "custom") {
    return probeCustomGateway(
      rawBaseUrl,
      apiKey,
      preferredModel,
      fetchImpl,
      signal,
    );
  }

  if (rawProviderId !== "auto") {
    const preset = getProviderPreset(rawProviderId);
    if (!preset) {
      throw new Error(`未知的模型供应商：${rawProviderId}`);
    }
    if (preset.requiresKey && !apiKey) {
      throw new Error(`请输入 ${preset.shortName} 的 API Key`);
    }
    return probePreset(
      preset,
      apiKey,
      rawBaseUrl || undefined,
      preferredModel,
      "preset",
      fetchImpl,
      signal,
    );
  }

  // providerId === "auto"
  if (rawBaseUrl) {
    const matchedPreset = findPresetByBaseUrl(rawBaseUrl);
    if (matchedPreset) {
      if (matchedPreset.id === "ollama") {
        return probeOllama(rawBaseUrl, preferredModel, fetchImpl, signal);
      }
      if (matchedPreset.requiresKey && !apiKey) {
        throw new Error(`请输入 ${matchedPreset.shortName} 的 API Key`);
      }
      return probePreset(
        matchedPreset,
        apiKey,
        rawBaseUrl,
        preferredModel,
        "preset",
        fetchImpl,
        signal,
      );
    }
    return probeCustomGateway(
      rawBaseUrl,
      apiKey,
      preferredModel,
      fetchImpl,
      signal,
    );
  }

  const keyMatch = detectProviderFromKey(apiKey);
  if (keyMatch.confidence === "high" && keyMatch.providerId) {
    const preset = getProviderPreset(keyMatch.providerId)!;
    return probePreset(
      preset,
      apiKey,
      undefined,
      preferredModel,
      "key-prefix",
      fetchImpl,
      signal,
    );
  }

  throw new Error("无法仅凭密钥前缀唯一识别供应商，请先选择模型供应商后再连接");
}
