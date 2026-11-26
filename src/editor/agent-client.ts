import type { DesignDocument } from "../domain/document";
import type {
  ComponentLibrary,
  LibraryAiGuide,
} from "../domain/library-schema";
import type {
  DesignMemoryScope,
  EpisodeDecisionRecord,
  RecalledEpisodePayload,
  ScopeProposal,
} from "../agent/context-builder";
import type { DesignEpisode } from "../agent/project-memory";
import type { GeneratedLibraryPlaybook } from "../agent/library-intelligence";
import type { Transaction } from "../agent/provider";

import {
  detectProviderFromKey,
  listPublicProviderPresets,
  type ProviderPresetPublic,
  type KeyDetectionResult,
} from "../agent/provider-registry";
import type {
  CapabilitySource,
  DiscoveredModel,
  ModelCapabilities,
  ModelCapabilityOverrides,
} from "../agent/capabilities";
import type {
  SkillCompatibilityReport,
  SkillSummary as AgentSkillSummary,
  SkillSettings,
  SkillsListResponse as AgentSkillsListResponse,
} from "../agent/skills";
import type {
  AgentToolTraceItem,
  HtmlDesignDraftProposal,
} from "../agent/forma-tools";
import type { VisualCritiqueResult } from "../agent/design-engine";
import type { CompileDiagnostic } from "../agent/blueprint-compiler";

export type {
  DesignMemoryScope,
  EpisodeScreenSummary,
  EpisodeComponentRef,
  EpisodeDecisionRecord,
  RecalledEpisodePayload,
  ScopeDecisionOption,
  ScopeProposal,
  ScopeScreenPlan,
} from "../agent/context-builder";
export type { GeneratedLibraryPlaybook } from "../agent/library-intelligence";

export type {
  ProviderPresetPublic,
  CapabilitySource,
  DiscoveredModel,
  ModelCapabilities,
  ModelCapabilityOverrides,
  SkillCompatibilityReport,
  SkillSettings,
  AgentToolTraceItem,
  HtmlDesignDraftProposal,
  VisualCritiqueResult,
  CompileDiagnostic,
};
export type { ProviderRegion } from "../agent/provider-registry";
export type { StructuredOutputMode } from "../agent/capabilities";
export type { SkillCompatibilityLevel } from "../agent/skills";
export type AgentProtocol = ModelCapabilities["protocol"];
export type GenerationMode = "auto" | "html" | "blueprint";
export type ProviderProtocol = ProviderPresetPublic["protocol"];
export interface SkillSummary extends Omit<AgentSkillSummary, "compatibility"> {
  compatibility?: SkillCompatibilityReport;
}
export interface SkillsListResponse extends Omit<
  AgentSkillsListResponse,
  "skills"
> {
  skills: SkillSummary[];
}
export type SkillDetail = SkillSummary & { instructions: string };
export type ImportSkillPayload =
  | {
      skillMd: string;
      slug?: string;
      resources?: { path: string; content: string }[];
    }
  | { localDirPath: string };

export interface MaskedProviderProfile {
  id: string;
  providerId: string;
  providerName: string;
  label: string;
  maskedKey: string;
  baseUrl: string;
  protocol: AgentProtocol;
  selectedModel: string;
  models: DiscoveredModel[];
  capabilities: ModelCapabilities;
  modelOverrides?: Record<string, ModelCapabilityOverrides>;
  activeModelOverrides?: ModelCapabilityOverrides;
  source: "saved" | "env";
  updatedAt: string;
}

export interface AgentStatusResponse {
  configured: boolean;
  activeProfileId: string | null;
  activeProfile: MaskedProviderProfile | null;
  profiles: MaskedProviderProfile[];
}

export interface DetectProviderRequest {
  providerId: string;
  apiKey?: string;
  baseUrl?: string;
  preferredModel?: string;
}

export interface DetectProviderResponse {
  ok: true;
  providerId: string;
  providerName: string;
  baseUrl: string;
  protocol: AgentProtocol;
  detectedBy: string;
  selectedModel: string;
  models: DiscoveredModel[];
  capabilities: ModelCapabilities;
  probeNote?: string;
}

export interface SaveProviderProfileRequest {
  capabilityOverrides?: ModelCapabilityOverrides;
  providerId: string;
  apiKey?: string;
  baseUrl?: string;
  selectedModel?: string;
  label?: string;
}

export interface UpdateProviderProfileRequest {
  capabilityOverrides?: ModelCapabilityOverrides | null;
  activate?: boolean;
  selectedModel?: string;
  label?: string;
  baseUrl?: string;
  apiKey?: string;
}

export interface AgentMention {
  kind: "component" | "variable" | "style" | "node" | "episode";
  id: string;
  label: string;
}

export interface AgentAttachment {
  name: string;
  mimeType: string;
  dataUrl: string;
}

export interface AgentHistoryTurn {
  role: "user" | "assistant";
  text: string;
}

export interface AgentChatRequest {
  targetLibraryId?: string | null;
  confirmedScope?: ScopeProposal;
  memoryScope?: DesignMemoryScope;
  recalledEpisodes?: RecalledEpisodePayload[];
  generationMode?: GenerationMode;
  activeSkills?: string[];
  prompt: string;
  document: DesignDocument;
  selection: string | null;
  selectionCount?: number;
  profileId?: string;
  model?: string;
  history?: AgentHistoryTurn[];
  mentions?: AgentMention[];
  attachments?: AgentAttachment[];
  viewportCenter?: { x: number; y: number };
}

export interface AgentChatProgress {
  stage: string;
  message: string;
  detail?: string;
}

export interface AgentChatStats {
  created: number;
  updated: number;
  removed: number;
  componentsInserted: number;
  tokensBound: number;
}

export interface AgentChatResult {
  recalledEpisodeIds?: string[];
  htmlDraft?: HtmlDesignDraftProposal;
  critiqueNotes?: string[];
  toolTrace?: AgentToolTraceItem[];
  activatedSkills?: string[];
  diagnostics?: CompileDiagnostic[];
  mode: "generate" | "edit" | "answer" | "clarify";
  scopeProposal?: ScopeProposal;
  targetLibraryId?: string;
  reply: string;
  summary: string;
  transaction?: Transaction;
  createdRootIds: string[];
  stats: AgentChatStats;
  modelUsed: string;
  providerId: string;
  providerName: string;
  capabilities: ModelCapabilities;
}

export interface ProposalEpisodeMeta {
  prompt: string;
  summary?: string;
  mode: "generate" | "edit";
  targetLibraryId?: string;
  decisions?: EpisodeDecisionRecord[];
  customModules?: string[];
  screenRoles?: Record<string, "primary" | "overlay" | "exception" | "detail">;
  recalledEpisodeIds?: string[];
}

export interface PendingAgentProposal {
  transaction: Transaction;
  summary: string;
  reply: string;
  createdRootIds: string[];
  stats?: AgentChatResult["stats"];
  source: "chat" | "external" | "manual";
  episodeMeta?: ProposalEpisodeMeta;
}

export interface KeyProviderGuess extends KeyDetectionResult {
  label?: string;
}

export const FALLBACK_PROVIDERS = listPublicProviderPresets();

const PROVIDER_META: Record<string, { monogram: string; accent: string }> = {
  openai: { monogram: "OA", accent: "#10a37f" },
  anthropic: { monogram: "CL", accent: "#d97757" },
  gemini: { monogram: "GM", accent: "#4285f4" },
  openrouter: { monogram: "OR", accent: "#6366f1" },
  kimi: { monogram: "KM", accent: "#0d99ff" },
  deepseek: { monogram: "DS", accent: "#4d6bfe" },
  qwen: { monogram: "QW", accent: "#6f42c1" },
  zhipu: { monogram: "ZP", accent: "#2563eb" },
  minimax: { monogram: "MM", accent: "#ec4899" },
  doubao: { monogram: "DB", accent: "#14b8a6" },
  siliconflow: { monogram: "SF", accent: "#8b5cf6" },
  ollama: { monogram: "OL", accent: "#64748b" },
  custom: { monogram: "GW", accent: "#f59e0b" },
};

export function providerBadgeStyle(providerId: string): {
  monogram: string;
  accent: string;
} {
  return (
    PROVIDER_META[providerId] ?? {
      monogram: providerId.slice(0, 2).toUpperCase() || "AI",
      accent: "#0d99ff",
    }
  );
}

export function guessProviderFromKey(rawKey: string): KeyProviderGuess {
  const guess = detectProviderFromKey(rawKey);
  if (!guess.providerId) return guess;
  return {
    ...guess,
    label: FALLBACK_PROVIDERS.find((p) => p.id === guess.providerId)?.name,
  };
}

export function formatCapabilitySourceLabel(source?: CapabilitySource): string {
  return {
    "provider-api": "接口实时声明",
    "builtin-catalog": "模型目录",
    "user-override": "手动覆写",
    heuristic: "启发式估算",
  }[source ?? "heuristic"];
}

export function formatContextWindow(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens <= 0) return "标准上下文";
  if (tokens >= 1_000_000) {
    const m = tokens / 1_000_000;
    return `${Number.isInteger(m) ? m : m.toFixed(1)}M`;
  }
  if (tokens >= 1000) {
    return `${Math.round(tokens / 1000)}K`;
  }
  return String(tokens);
}

export function formatProtocolLabel(protocol: ProviderProtocol): string {
  switch (protocol) {
    case "openai-chat":
      return "OpenAI 协议";
    case "anthropic-messages":
      return "Anthropic 协议";
    case "gemini-native":
      return "Gemini 原生";
    case "auto":
      return "自动适配协议";
  }
}

export function formatStructuredOutputLabel(
  mode: ModelCapabilities["structuredOutput"],
): string {
  switch (mode) {
    case "json_schema":
      return "JSON Schema";
    case "json_object":
      return "JSON 模式";
    case "tool_call":
      return "Tool Call";
    case "prompt_json":
      return "Prompt JSON";
  }
}

export function collectDocumentMentions(
  doc: DesignDocument,
  episodes: readonly DesignEpisode[] = [],
): AgentMention[] {
  const items: AgentMention[] = [];
  const seen = new Set<string>();
  const push = (item: AgentMention) => {
    const key = `${item.kind}:${item.id}`;
    if (seen.has(key)) return;
    seen.add(key);
    items.push(item);
  };

  for (const library of Object.values(doc.libraries ?? {})) {
    for (const component of library.components) {
      push({
        kind: "component",
        id: `${library.id}/${component.id}`,
        label: component.name,
      });
    }
  }

  for (const variable of Object.values(doc.designSystem?.variables ?? {})) {
    push({
      kind: "variable",
      id: variable.id,
      label: variable.name,
    });
  }
  for (const [tokenId, token] of Object.entries(doc.tokens ?? {})) {
    push({
      kind: "variable",
      id: tokenId,
      label: token.name,
    });
  }

  for (const style of Object.values(doc.designSystem?.styles ?? {})) {
    push({
      kind: "style",
      id: style.id,
      label: style.name,
    });
  }

  for (const node of doc.nodes) {
    if (
      node.parentId === null ||
      node.type === "frame" ||
      node.type === "section"
    ) {
      push({
        kind: "node",
        id: node.id,
        label: node.name,
      });
    }
  }

  for (const ep of episodes) {
    push({ kind: "episode", id: ep.id, label: ep.title });
  }
  return items;
}

export function readImageFileAsAttachment(
  file: File,
  maxBytes = 8 * 1024 * 1024,
): Promise<AgentAttachment> {
  return new Promise((resolve, reject) => {
    if (!file.type.startsWith("image/")) {
      reject(new Error("请选择 PNG、JPEG 或 WebP 参考图"));
      return;
    }
    if (file.size > maxBytes) {
      reject(new Error("参考图大小不能超过 8 MB"));
      return;
    }
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("读取参考图失败"));
    reader.onload = () => {
      if (typeof reader.result !== "string") {
        reject(new Error("无法编码参考图"));
        return;
      }
      resolve({
        name: file.name || "参考图",
        mimeType: file.type,
        dataUrl: reader.result,
      });
    };
    reader.readAsDataURL(file);
  });
}

function normalizeStatus(raw: unknown): AgentStatusResponse {
  const data = (
    raw && typeof raw === "object" ? raw : {}
  ) as Partial<AgentStatusResponse>;
  const profiles = Array.isArray(data.profiles) ? data.profiles : [];
  const activeProfile = data.activeProfile ?? null;
  const activeProfileId =
    typeof data.activeProfileId === "string"
      ? data.activeProfileId
      : (activeProfile?.id ?? null);
  return {
    configured: Boolean(data.configured),
    activeProfileId,
    activeProfile,
    profiles,
  };
}

async function parseErrorResponse(
  response: Response,
  fallback: string,
): Promise<string> {
  const text = await response.text().catch(() => "");
  if (!text) return `${fallback}（HTTP ${response.status}）`;
  try {
    const parsed = JSON.parse(text) as { error?: unknown; message?: unknown };
    if (typeof parsed.error === "string" && parsed.error.trim()) {
      return parsed.error;
    }
    if (typeof parsed.message === "string" && parsed.message.trim()) {
      return parsed.message;
    }
  } catch {
    // Plain text fallback below
  }
  return text.length > 220 ? `${text.slice(0, 220)}…` : text;
}

export async function fetchProviders(
  signal?: AbortSignal,
): Promise<ProviderPresetPublic[]> {
  const response = await fetch("/api/agent/providers", {
    method: "GET",
    headers: { Accept: "application/json" },
    signal,
  });
  if (!response.ok) {
    throw new Error(
      await parseErrorResponse(response, "获取模型供应商列表失败"),
    );
  }
  const data = (await response.json()) as {
    providers?: ProviderPresetPublic[];
  };
  return Array.isArray(data.providers) && data.providers.length > 0
    ? data.providers
    : FALLBACK_PROVIDERS;
}

export async function fetchAgentStatus(
  signal?: AbortSignal,
): Promise<AgentStatusResponse> {
  const response = await fetch("/api/agent/status", {
    method: "GET",
    headers: { Accept: "application/json" },
    signal,
  });
  if (!response.ok) {
    throw new Error(await parseErrorResponse(response, "无法连接本地 AI 服务"));
  }
  return normalizeStatus(await response.json());
}

function requireSelectedProvider(id: string) {
  if (!id?.trim() || id.trim() === "auto")
    throw new Error("请先选择模型供应商");
}

export async function detectProvider(
  payload: DetectProviderRequest,
  signal?: AbortSignal,
): Promise<DetectProviderResponse> {
  requireSelectedProvider(payload.providerId);
  const response = await fetch("/api/agent/detect", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(payload),
    signal,
  });
  if (!response.ok) {
    throw new Error(await parseErrorResponse(response, "连接模型服务失败"));
  }
  return (await response.json()) as DetectProviderResponse;
}

export async function saveProviderProfile(
  payload: SaveProviderProfileRequest,
  signal?: AbortSignal,
): Promise<{ profile: MaskedProviderProfile; status: AgentStatusResponse }> {
  requireSelectedProvider(payload.providerId);
  const response = await fetch("/api/agent/profiles", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(payload),
    signal,
  });
  if (!response.ok) {
    throw new Error(await parseErrorResponse(response, "保存模型配置失败"));
  }
  const data = (await response.json()) as {
    profile: MaskedProviderProfile;
    status: AgentStatusResponse;
  };
  return {
    profile: data.profile,
    status: normalizeStatus(data.status),
  };
}

export async function updateProviderProfile(
  id: string,
  payload: UpdateProviderProfileRequest,
  signal?: AbortSignal,
): Promise<{ profile: MaskedProviderProfile; status: AgentStatusResponse }> {
  const response = await fetch(
    `/api/agent/profiles/${encodeURIComponent(id)}`,
    {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(payload),
      signal,
    },
  );
  if (!response.ok) {
    throw new Error(await parseErrorResponse(response, "更新模型配置失败"));
  }
  const data = (await response.json()) as {
    profile: MaskedProviderProfile;
    status: AgentStatusResponse;
  };
  return {
    profile: data.profile,
    status: normalizeStatus(data.status),
  };
}

export async function deleteProviderProfile(
  id: string,
  signal?: AbortSignal,
): Promise<{ deleted: true; status: AgentStatusResponse }> {
  const response = await fetch(
    `/api/agent/profiles/${encodeURIComponent(id)}`,
    {
      method: "DELETE",
      headers: { Accept: "application/json" },
      signal,
    },
  );
  if (!response.ok) {
    throw new Error(await parseErrorResponse(response, "删除模型配置失败"));
  }
  const data = (await response.json()) as {
    deleted: true;
    status: AgentStatusResponse;
  };
  return {
    deleted: true,
    status: normalizeStatus(data.status),
  };
}

async function requestAgentJson<T>(
  path: string,
  method: string,
  signal?: AbortSignal,
  body?: unknown,
): Promise<T> {
  const response = await fetch(`/api/agent/${path}`, {
    method,
    signal,
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok)
    throw new Error(await parseErrorResponse(response, "本机 AI 服务请求失败"));
  return response.json();
}

export function fetchLibraryPlaybook(
  library: ComponentLibrary,
  existingGuide?: LibraryAiGuide,
  signal?: AbortSignal,
) {
  return requestAgentJson<GeneratedLibraryPlaybook>(
    "library-playbook",
    "POST",
    signal,
    { library, existingGuide },
  );
}

export async function requestVisualCritique(
  req: {
    prompt: string;
    htmlDraft: HtmlDesignDraftProposal;
    renderedImageDataUrl: string;
    renderedImages?: Array<{ refId?: string; name: string; dataUrl: string }>;
    document?: DesignDocument;
    selection?: string | null;
    profileId?: string;
    model?: string;
    activeSkills?: string[];
  },
  signal?: AbortSignal,
): Promise<VisualCritiqueResult> {
  return requestAgentJson<VisualCritiqueResult>(
    "critique",
    "POST",
    signal,
    req,
  );
}

export function refreshProviderProfile(id: string, signal?: AbortSignal) {
  return requestAgentJson<{
    profile: MaskedProviderProfile;
    status: AgentStatusResponse;
    probeNote?: string;
  }>(`profiles/${encodeURIComponent(id)}/refresh`, "POST", signal, {});
}

export function fetchSkills(signal?: AbortSignal) {
  return requestAgentJson<SkillsListResponse>("skills", "GET", signal);
}

export async function fetchSkillDetail(id: string, signal?: AbortSignal) {
  const { skill } = await requestAgentJson<{ skill: SkillDetail }>(
    `skills/${encodeURIComponent(id)}`,
    "GET",
    signal,
  );
  return skill;
}

export function rescanSkills(signal?: AbortSignal) {
  return requestAgentJson<SkillsListResponse>(
    "skills/rescan",
    "POST",
    signal,
    {},
  );
}

export function updateSkillSettings(
  patch: Pick<SkillSettings, "scanExternalStandardDirs">,
  signal?: AbortSignal,
) {
  return requestAgentJson<SkillsListResponse>(
    "skills/settings",
    "POST",
    signal,
    patch,
  );
}

export function importSkill(payload: ImportSkillPayload, signal?: AbortSignal) {
  return requestAgentJson<SkillsListResponse & { skill: SkillSummary }>(
    "skills/import",
    "POST",
    signal,
    payload,
  );
}

export function setSkillEnabled(
  id: string,
  enabled: boolean,
  signal?: AbortSignal,
) {
  return requestAgentJson<SkillsListResponse>(
    `skills/${encodeURIComponent(id)}`,
    "PATCH",
    signal,
    { enabled },
  );
}

export function deleteSkill(id: string, signal?: AbortSignal) {
  return requestAgentJson<SkillsListResponse>(
    `skills/${encodeURIComponent(id)}`,
    "DELETE",
    signal,
  );
}

function parseSseBlock(block: string): { event: string; data: string } | null {
  const trimmed = block.trim();
  if (!trimmed) return null;
  let event = "message";
  const dataLines: string[] = [];
  for (const rawLine of trimmed.split(/\r?\n/)) {
    if (rawLine.startsWith(":")) continue;
    const colon = rawLine.indexOf(":");
    const field = colon === -1 ? rawLine : rawLine.slice(0, colon);
    let value = colon === -1 ? "" : rawLine.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") {
      event = value || "message";
    } else if (field === "data") {
      dataLines.push(value);
    }
  }
  if (!dataLines.length) return null;
  return { event, data: dataLines.join("\n") };
}

export async function streamAgentChat(
  payload: AgentChatRequest,
  onProgress?: (progress: AgentChatProgress) => void,
  signal?: AbortSignal,
): Promise<AgentChatResult> {
  const response = await fetch("/api/agent/chat", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "text/event-stream, application/json",
    },
    body: JSON.stringify(payload),
    signal,
  });

  if (!response.ok) {
    throw new Error(await parseErrorResponse(response, "AI 设计生成失败"));
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("text/event-stream") || !response.body) {
    const json = (await response.json()) as AgentChatResult & {
      error?: string;
    };
    if (json.error) {
      throw new Error(json.error);
    }
    return json;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let finalResult: AgentChatResult | null = null;
  let streamError: string | null = null;

  const handleBlock = (rawBlock: string) => {
    const parsed = parseSseBlock(rawBlock);
    if (!parsed) return;
    let body: unknown;
    try {
      body = JSON.parse(parsed.data);
    } catch {
      if (parsed.event === "error") {
        streamError = parsed.data || "生成失败";
      }
      return;
    }

    if (parsed.event === "progress") {
      const p = body as Partial<AgentChatProgress>;
      if (typeof p.message === "string") {
        onProgress?.({
          stage: typeof p.stage === "string" ? p.stage : "generating",
          message: p.message,
          detail: typeof p.detail === "string" ? p.detail : undefined,
        });
      }
    } else if (parsed.event === "result") {
      finalResult = body as AgentChatResult;
    } else if (parsed.event === "error") {
      const errObj = body as { error?: unknown; message?: unknown };
      streamError =
        typeof errObj.error === "string"
          ? errObj.error
          : typeof errObj.message === "string"
            ? errObj.message
            : "AI 生成失败";
    }
  };

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const blocks = buffer.split(/\r?\n\r?\n/);
      buffer = blocks.pop() ?? "";
      for (const block of blocks) {
        handleBlock(block);
        if (streamError) {
          throw new Error(streamError);
        }
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) {
      handleBlock(buffer);
    }
  } finally {
    reader.releaseLock();
  }

  if (streamError) {
    throw new Error(streamError);
  }
  if (!finalResult) {
    throw new Error("模型连接提前中断，未收到完整生成结果");
  }
  return finalResult;
}
