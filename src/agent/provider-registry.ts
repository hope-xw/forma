export type ProviderProtocol =
  "openai-chat" | "anthropic-messages" | "gemini-native";

export type PresetProtocol = ProviderProtocol | "auto";
export type ProviderRegion = "global" | "china" | "local" | "custom";

export interface ProviderPreset {
  id: string;
  name: string;
  shortName: string;
  region: ProviderRegion;
  requiresKey: boolean;
  keyHint: string;
  defaultBaseUrl: string;
  baseUrls: string[];
  protocol: PresetProtocol;
  docsUrl: string;
  description: string;
  recommendedModels: string[];
  extraHeaders?: Record<string, string>;
}

export interface ProviderPresetPublic {
  id: string;
  name: string;
  shortName: string;
  region: ProviderRegion;
  requiresKey: boolean;
  keyHint: string;
  defaultBaseUrl: string;
  protocol: PresetProtocol;
  docsUrl: string;
  description: string;
  recommendedModels: string[];
}

export interface KeyDetectionResult {
  providerId: string | null;
  confidence: "high" | "low" | "none";
  candidates: string[];
}

export const PROVIDER_PRESETS: readonly ProviderPreset[] = [
  {
    id: "openai",
    name: "OpenAI",
    shortName: "OpenAI",
    region: "global",
    requiresKey: true,
    keyHint: "sk-proj-...",
    defaultBaseUrl: "https://api.openai.com/v1",
    baseUrls: ["https://api.openai.com/v1"],
    protocol: "openai-chat",
    docsUrl: "https://platform.openai.com/api-keys",
    description:
      "GPT-5.5 / GPT-5.4 与经典 GPT-4 系列，支持视觉、工具与结构化输出",
    recommendedModels: [
      "gpt-5.5",
      "gpt-5.4",
      "gpt-4.1",
      "gpt-4o",
      "gpt-5",
      "o4-mini",
      "gpt-4.1-mini",
      "gpt-4o-mini",
    ],
  },
  {
    id: "anthropic",
    name: "Claude / Anthropic",
    shortName: "Claude",
    region: "global",
    requiresKey: true,
    keyHint: "sk-ant-...",
    defaultBaseUrl: "https://api.anthropic.com/v1",
    baseUrls: ["https://api.anthropic.com/v1"],
    protocol: "anthropic-messages",
    docsUrl: "https://console.anthropic.com/settings/keys",
    description: "Claude Fable 5、Opus 与 Sonnet 系列，支持读图与原生工具调用",
    recommendedModels: [
      "claude-sonnet-5",
      "claude-opus-5",
      "claude-fable-5",
      "claude-opus-4-8",
      "claude-sonnet-4-6",
      "claude-sonnet-4-5",
      "claude-sonnet-4-20250514",
      "claude-3-7-sonnet-latest",
      "claude-3-5-sonnet-latest",
      "claude-opus-4-1",
      "claude-3-5-haiku-latest",
    ],
  },
  {
    id: "gemini",
    name: "Google Gemini",
    shortName: "Gemini",
    region: "global",
    requiresKey: true,
    keyHint: "AIza...",
    defaultBaseUrl: "https://generativelanguage.googleapis.com/v1beta",
    baseUrls: ["https://generativelanguage.googleapis.com/v1beta"],
    protocol: "gemini-native",
    docsUrl: "https://aistudio.google.com/apikey",
    description:
      "Gemini 4 Argon、Gemini 3 与 2.5 系列，支持长上下文与多模态输入",
    recommendedModels: [
      "gemini-4-argon",
      "gemini-3-flash-preview",
      "gemini-2.5-pro",
      "gemini-2.5-flash",
      "gemini-2.0-flash",
    ],
  },
  {
    id: "kimi",
    name: "Kimi / 月之暗面",
    shortName: "Kimi",
    region: "china",
    requiresKey: true,
    keyHint: "sk-...",
    defaultBaseUrl: "https://api.moonshot.cn/v1",
    baseUrls: ["https://api.moonshot.cn/v1", "https://api.moonshot.ai/v1"],
    protocol: "openai-chat",
    docsUrl: "https://platform.moonshot.cn/console/api-keys",
    description: "Kimi K3 / K2.5 与 K2 Thinking，支持国内及国际端点",
    recommendedModels: [
      "kimi-k3",
      "kimi-k2.5",
      "kimi-k2-thinking",
      "kimi-k2-0905-preview",
      "kimi-k2-0711-preview",
      "kimi-k2-turbo-preview",
      "moonshot-v1-128k",
    ],
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    shortName: "DeepSeek",
    region: "china",
    requiresKey: true,
    keyHint: "sk-...",
    defaultBaseUrl: "https://api.deepseek.com/v1",
    baseUrls: ["https://api.deepseek.com/v1"],
    protocol: "openai-chat",
    docsUrl: "https://platform.deepseek.com/api_keys",
    description:
      "DeepSeek-V4.1-Flash（1M 上下文 + 视觉识图）与 DeepSeek-V4-Pro",
    recommendedModels: [
      "deepseek-flash",
      "deepseek-v4-pro",
      "deepseek-chat",
      "deepseek-reasoner",
    ],
  },
  {
    id: "qwen",
    name: "通义千问 / DashScope",
    shortName: "通义千问",
    region: "china",
    requiresKey: true,
    keyHint: "sk-...",
    defaultBaseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    baseUrls: [
      "https://dashscope.aliyuncs.com/compatible-mode/v1",
      "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
    ],
    protocol: "openai-chat",
    docsUrl: "https://bailian.console.aliyun.com/",
    description: "Qwen3-Max、Qwen3-VL 与经典 Max / Plus 模型，支持国内及国际区",
    recommendedModels: [
      "qwen3-max",
      "qwen3-vl-plus",
      "qwen-max",
      "qwen-plus",
      "qwen3-coder-plus",
      "qwen-vl-max",
      "qwen2.5-72b-instruct",
    ],
  },
  {
    id: "zhipu",
    name: "智谱 GLM",
    shortName: "智谱 GLM",
    region: "china",
    requiresKey: true,
    keyHint: "id.secret",
    defaultBaseUrl: "https://open.bigmodel.cn/api/paas/v4",
    baseUrls: ["https://open.bigmodel.cn/api/paas/v4"],
    protocol: "openai-chat",
    docsUrl: "https://open.bigmodel.cn/usercenter/apikeys",
    description: "GLM-5 与 GLM-4.5 系列，包含视觉与文本模型",
    recommendedModels: [
      "glm-5",
      "glm-4.5",
      "glm-4-plus",
      "glm-4.5v",
      "glm-4v-plus",
      "glm-4-air",
    ],
  },
  {
    id: "minimax",
    name: "MiniMax",
    shortName: "MiniMax",
    region: "china",
    requiresKey: true,
    keyHint: "eyJ... / sk-...",
    defaultBaseUrl: "https://api.minimaxi.com/v1",
    baseUrls: ["https://api.minimaxi.com/v1", "https://api.minimax.io/v1"],
    protocol: "openai-chat",
    docsUrl: "https://platform.minimaxi.com/",
    description: "MiniMax-M2.7 / M2.5 与 M1 推理模型，支持国内及国际端点",
    recommendedModels: [
      "MiniMax-M2.7",
      "MiniMax-M2.5",
      "MiniMax-M1",
      "MiniMax-Text-01",
      "abab6.5s-chat",
    ],
  },
  {
    id: "doubao",
    name: "豆包 / 火山方舟",
    shortName: "豆包",
    region: "china",
    requiresKey: true,
    keyHint: "ARK API Key",
    defaultBaseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    baseUrls: ["https://ark.cn-beijing.volces.com/api/v3"],
    protocol: "openai-chat",
    docsUrl: "https://console.volcengine.com/ark",
    description: "豆包 Seed 2.x 与 1.5 系列，支持方舟模型 ID 与自定义接入点",
    recommendedModels: [
      "doubao-seed-2-1-lite-260915",
      "doubao-seed-2-0-pro-260215",
      "doubao-seed-1-6-250615",
      "doubao-1-5-pro-32k-250115",
      "doubao-1-5-vision-pro-32k-250115",
    ],
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    shortName: "OpenRouter",
    region: "global",
    requiresKey: true,
    keyHint: "sk-or-v1-...",
    defaultBaseUrl: "https://openrouter.ai/api/v1",
    baseUrls: ["https://openrouter.ai/api/v1"],
    protocol: "openai-chat",
    docsUrl: "https://openrouter.ai/keys",
    description: "聚合 GPT-5、Claude、Gemini 与 DeepSeek，按路由返回模型能力",
    recommendedModels: [
      "openai/gpt-5.4",
      "anthropic/claude-sonnet-4.6",
      "deepseek/deepseek-v4-pro",
      "anthropic/claude-sonnet-4",
      "openai/gpt-4.1",
      "google/gemini-2.5-pro",
      "deepseek/deepseek-chat-v3-0324",
    ],
    extraHeaders: {
      "HTTP-Referer": "https://forma.design",
      "X-Title": "Forma Design Tool",
    },
  },
  {
    id: "siliconflow",
    name: "硅基流动 SiliconFlow",
    shortName: "硅基流动",
    region: "china",
    requiresKey: true,
    keyHint: "sk-...",
    defaultBaseUrl: "https://api.siliconflow.cn/v1",
    baseUrls: [
      "https://api.siliconflow.cn/v1",
      "https://api.siliconflow.com/v1",
    ],
    protocol: "openai-chat",
    docsUrl: "https://cloud.siliconflow.cn/account/ak",
    description: "托管 Qwen3-VL、DeepSeek 与 GLM 系列，支持国内及国际端点",
    recommendedModels: [
      "deepseek-ai/DeepSeek-V4.1-Flash",
      "Qwen/Qwen3-VL-32B-Instruct",
      "deepseek-ai/DeepSeek-V3.2",
      "Qwen/Qwen2.5-72B-Instruct",
      "deepseek-ai/DeepSeek-V3",
      "deepseek-ai/DeepSeek-R1",
      "THUDM/GLM-4-9B-0414",
    ],
  },
  {
    id: "ollama",
    name: "Ollama 本地模型",
    shortName: "Ollama",
    region: "local",
    requiresKey: false,
    keyHint: "无需填写（默认 127.0.0.1:11434）",
    defaultBaseUrl: "http://127.0.0.1:11434/v1",
    baseUrls: ["http://127.0.0.1:11434/v1"],
    protocol: "openai-chat",
    docsUrl: "https://ollama.com/",
    description: "本机运行 Qwen3-VL、DeepSeek 等已下载模型，可读取本机模型能力",
    recommendedModels: [
      "qwen3-vl:8b",
      "qwen3:14b",
      "qwen2.5:14b",
      "qwen2.5-coder:14b",
      "llama3.2-vision",
      "deepseek-r1:14b",
    ],
  },
  {
    id: "custom",
    name: "自定义兼容网关",
    shortName: "自定义网关",
    region: "custom",
    requiresKey: false,
    keyHint: "服务商 API Key（可选）",
    defaultBaseUrl: "",
    baseUrls: [],
    protocol: "auto",
    docsUrl: "",
    description:
      "探测用户填写的 OpenAI / Anthropic / Gemini 兼容地址，支持自定义模型 ID",
    recommendedModels: ["gpt-5.4", "deepseek-flash", "claude-sonnet-4-6"],
  },
] as const;

const presetById = new Map<string, ProviderPreset>(
  PROVIDER_PRESETS.map((p) => [p.id, p]),
);

export function getProviderPreset(id: string): ProviderPreset | undefined {
  return presetById.get(id);
}

export function listPublicProviderPresets(): ProviderPresetPublic[] {
  return PROVIDER_PRESETS.map(
    ({ baseUrls: _baseUrls, extraHeaders: _extraHeaders, ...pub }) => ({
      ...pub,
      recommendedModels: [...pub.recommendedModels],
    }),
  );
}

const exclusiveKeyPrefixes: readonly [RegExp, string][] = [
  [/^sk-ant-/, "anthropic"],
  [/^AIza[0-9A-Za-z_-]{10,}$/, "gemini"],
  [/^sk-or-v1-/, "openrouter"],
  [/^sk-(proj|svcacct)-/, "openai"],
  [/^[0-9a-f]{32}\.[A-Za-z0-9_-]{8,}$/, "zhipu"],
];

export function detectProviderFromKey(apiKey: string): KeyDetectionResult {
  const key = apiKey.trim();
  const match = exclusiveKeyPrefixes.find(([pattern]) => pattern.test(key));
  return match
    ? { providerId: match[1], confidence: "high", candidates: [match[1]] }
    : { providerId: null, confidence: "none", candidates: [] };
}

export function maskApiKey(key: string): string {
  const trimmed = key.trim();
  if (!trimmed) return "";
  if (trimmed.length <= 10) return "••••";
  return `${trimmed.slice(0, 4)}••••${trimmed.slice(-4)}`;
}

export function normalizeBaseUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  if (!trimmed) return "";
  const parsed = new URL(trimmed);
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("模型服务地址协议无效，仅支持 http 或 https");
  }
  return trimmed.replace(/\/+$/, "");
}

export function findPresetByBaseUrl(
  baseUrl: string,
): ProviderPreset | undefined {
  const normalized = baseUrl.trim().replace(/\/+$/, "").toLowerCase();
  if (!normalized) return undefined;
  return PROVIDER_PRESETS.find((preset) =>
    preset.baseUrls.some((url) => url.toLowerCase() === normalized),
  );
}
