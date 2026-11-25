import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { z } from "zod";
import {
  applyCapabilityOverrides,
  buildDiscoveredModels,
  inferModelCapabilities,
  type DiscoveredModel,
  type ModelCapabilities,
  type ModelCapabilityOverrides,
} from "../src/agent/capabilities";
import {
  detectProviderFromKey,
  findPresetByBaseUrl,
  getProviderPreset,
  maskApiKey,
  normalizeBaseUrl,
  type ProviderProtocol,
} from "../src/agent/provider-registry";

const protocolSchema = z.enum([
  "openai-chat",
  "anthropic-messages",
  "gemini-native",
]);

const structuredOutputSchema = z.enum([
  "json_schema",
  "json_object",
  "tool_call",
  "prompt_json",
]);
const capabilityOverridesSchema = z.object({
  supportsVision: z.boolean().optional(),
  supportsTools: z.boolean().optional(),
  isReasoning: z.boolean().optional(),
  maxContextTokens: z.number().int().positive().optional(),
  maxOutputTokens: z.number().int().positive().optional(),
  structuredOutput: structuredOutputSchema.optional(),
});
const capabilitiesSchema = z.object({
  protocol: protocolSchema,
  structuredOutput: structuredOutputSchema,
  supportsTools: z.boolean().optional(),
  capabilitySource: z
    .enum(["user-override", "provider-api", "builtin-catalog", "heuristic"])
    .optional(),
  visionKnown: z.boolean().optional(),
  contextKnown: z.boolean().optional(),
  supportsVision: z.boolean(),
  supportsStreaming: z.boolean(),
  isReasoning: z.boolean(),
  maxContextTokens: z.number().int().positive(),
  maxOutputTokens: z.number().int().positive(),
  temperatureMode: z.enum(["normal", "fixed_one", "omit"]),
  tokenLimitParam: z.enum(["max_tokens", "max_completion_tokens"]),
});

const discoveredModelSchema = z.object({
  id: z.string().min(1).max(200),
  label: z.string().min(1).max(512),
  capabilities: capabilitiesSchema,
  recommended: z.boolean().optional(),
});

const storedProfileSchema = z.object({
  id: z.string().min(1).max(128),
  providerId: z.string().min(1).max(64),
  providerName: z.string().min(1).max(120),
  label: z.string().min(1).max(120),
  apiKey: z.string().max(4096),
  baseUrl: z.string().min(1).max(1024),
  protocol: protocolSchema,
  selectedModel: z.string().min(1).max(200),
  models: z.array(discoveredModelSchema).max(500),
  modelOverrides: z
    .record(z.string().min(1).max(200), capabilityOverridesSchema)
    .optional(),
  capabilities: capabilitiesSchema,
  updatedAt: z.string().max(64),
});

const storeFileSchema = z.object({
  version: z.literal(1),
  activeProfileId: z.string().nullable(),
  profiles: z.array(storedProfileSchema).max(64),
});

export type StoredProviderProfile = z.infer<typeof storedProfileSchema>;

export interface MaskedProviderProfile {
  id: string;
  providerId: string;
  providerName: string;
  label: string;
  maskedKey: string;
  baseUrl: string;
  protocol: ProviderProtocol;
  selectedModel: string;
  models: DiscoveredModel[];
  capabilities: ModelCapabilities;
  modelOverrides?: Record<string, ModelCapabilityOverrides>;
  activeModelOverrides?: ModelCapabilityOverrides;
  source: "saved" | "env";
  updatedAt: string;
}

export interface ResolvedProviderProfile {
  id: string;
  providerId: string;
  providerName: string;
  label: string;
  apiKey: string;
  baseUrl: string;
  protocol: ProviderProtocol;
  selectedModel: string;
  models: DiscoveredModel[];
  capabilities: ModelCapabilities;
  extraHeaders?: Record<string, string>;
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

export interface CreateProfileInput {
  capabilityOverrides?: ModelCapabilityOverrides | null;
  providerId: string;
  providerName: string;
  label?: string;
  apiKey: string;
  baseUrl: string;
  protocol: ProviderProtocol;
  selectedModel: string;
  models: DiscoveredModel[];
  capabilities: ModelCapabilities;
}

export interface UpdateProfileInput {
  capabilityOverrides?: ModelCapabilityOverrides | null;
  activate?: boolean;
  label?: string;
  apiKey?: string;
  baseUrl?: string;
  protocol?: ProviderProtocol;
  selectedModel?: string;
  models?: DiscoveredModel[];
  capabilities?: ModelCapabilities;
  providerId?: string;
  providerName?: string;
}

export const ENV_PROFILE_ID = "env-default";

export function defaultAgentConfigDir(): string {
  return process.env.FORMA_AGENT_CONFIG_DIR ?? path.join(homedir(), ".forma");
}

// Keep the last automatic result on disk. Materialize user overrides for clients
// and adapters so clearing an override after a restart restores upstream metadata.
function effectiveProfile(profile: StoredProviderProfile) {
  const overrides = new Map(Object.entries(profile.modelOverrides ?? {}));
  const activeModelOverrides = overrides.get(profile.selectedModel);
  return {
    ...profile,
    activeModelOverrides,
    models: profile.models.map((model) => ({
      ...model,
      capabilities: applyCapabilityOverrides(
        model.capabilities,
        overrides.get(model.id),
      ),
    })),
    capabilities: applyCapabilityOverrides(
      profile.capabilities,
      activeModelOverrides,
    ),
  };
}

function upgradeProfile(profile: StoredProviderProfile): StoredProviderProfile {
  function upgrade(id: string, saved: ModelCapabilities): ModelCapabilities {
    if (saved.capabilitySource && saved.capabilitySource !== "heuristic")
      return saved;
    const automatic = inferModelCapabilities(
      profile.providerId,
      profile.protocol,
      id,
    );
    return automatic.capabilitySource === "builtin-catalog"
      ? automatic
      : { ...automatic, ...saved };
  }
  const models = profile.models.map((model) => ({
    ...model,
    capabilities: upgrade(model.id, model.capabilities),
  }));
  const active = models.find((model) => model.id === profile.selectedModel);
  const capabilities = upgrade(profile.selectedModel, profile.capabilities);
  // Some v1 files only carry the selected model's full snapshot at profile level.
  if (
    active &&
    capabilities.capabilitySource === "provider-api" &&
    active.capabilities.capabilitySource !== "provider-api"
  ) {
    active.capabilities = capabilities;
  }
  return {
    ...profile,
    models,
    capabilities: active?.capabilities ?? capabilities,
  };
}

function toMasked(
  stored: StoredProviderProfile,
  source: "saved" | "env",
): MaskedProviderProfile {
  const profile = effectiveProfile(stored);
  return {
    id: profile.id,
    providerId: profile.providerId,
    providerName: profile.providerName,
    label: profile.label,
    modelOverrides: profile.modelOverrides,
    activeModelOverrides: profile.activeModelOverrides,
    maskedKey: maskApiKey(profile.apiKey),
    baseUrl: profile.baseUrl,
    protocol: profile.protocol,
    selectedModel: profile.selectedModel,
    models: profile.models,
    capabilities: profile.capabilities,
    source,
    updatedAt: profile.updatedAt,
  };
}

function toResolved(
  stored: StoredProviderProfile,
  source: "saved" | "env",
): ResolvedProviderProfile {
  const profile = effectiveProfile(stored);
  const preset = getProviderPreset(profile.providerId);
  return {
    ...profile,
    source,
    ...(preset?.extraHeaders ? { extraHeaders: preset.extraHeaders } : {}),
  };
}

function buildEnvProfile(env: NodeJS.ProcessEnv): StoredProviderProfile | null {
  const rawBaseUrl = env.MODEL_BASE_URL?.trim();
  const apiKey = env.MODEL_API_KEY?.trim();
  const modelId = env.MODEL_ID?.trim();
  if (!rawBaseUrl || !apiKey || !modelId) return null;

  let baseUrl: string;
  try {
    baseUrl = normalizeBaseUrl(rawBaseUrl);
  } catch {
    return null;
  }

  const matchedByUrl = findPresetByBaseUrl(baseUrl);
  const matchedByKey = detectProviderFromKey(apiKey);
  const preset =
    matchedByUrl ??
    (matchedByKey.providerId
      ? getProviderPreset(matchedByKey.providerId)
      : undefined);

  const providerId = preset?.id ?? "custom";
  const providerName = preset?.name ?? "环境变量网关";
  const protocol: ProviderProtocol =
    preset && preset.protocol !== "auto" ? preset.protocol : "openai-chat";
  const capabilities = inferModelCapabilities(providerId, protocol, modelId);
  const models = buildDiscoveredModels(
    providerId,
    protocol,
    [modelId, ...(preset?.recommendedModels ?? [])],
    preset?.recommendedModels ?? [],
    modelId,
  );

  return {
    id: ENV_PROFILE_ID,
    providerId,
    providerName,
    label: `${preset?.shortName ?? "环境变量"} (.env)`,
    apiKey,
    baseUrl,
    protocol,
    selectedModel: modelId,
    models,
    capabilities,
    updatedAt: new Date(0).toISOString(),
  };
}

export class AgentConfigStore {
  private readonly filePath: string;
  private readonly dirPath: string;
  private readonly env: NodeJS.ProcessEnv;
  private activeProfileId: string | null = null;
  private profiles: StoredProviderProfile[] = [];

  constructor(options: { configDir?: string; env?: NodeJS.ProcessEnv } = {}) {
    this.dirPath = options.configDir ?? defaultAgentConfigDir();
    this.filePath = path.join(this.dirPath, "agent-profiles.json");
    this.env = options.env ?? process.env;
    this.loadFromDisk();
  }

  private loadFromDisk() {
    try {
      const raw = readFileSync(this.filePath, "utf8");
      const parsed = storeFileSchema.safeParse(JSON.parse(raw));
      if (parsed.success) {
        this.activeProfileId = parsed.data.activeProfileId;
        this.profiles = parsed.data.profiles.map(upgradeProfile);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        this.activeProfileId = null;
        this.profiles = [];
      }
    }
  }

  private persistToDisk() {
    mkdirSync(this.dirPath, { recursive: true, mode: 0o700 });
    const data = JSON.stringify(
      {
        version: 1,
        activeProfileId: this.activeProfileId,
        profiles: this.profiles,
      },
      null,
      2,
    );
    const tmpPath = `${this.filePath}.${randomUUID()}.tmp`;
    try {
      writeFileSync(tmpPath, data, { mode: 0o600, flag: "wx" });
      renameSync(tmpPath, this.filePath);
    } finally {
      rmSync(tmpPath, { force: true });
    }
  }

  private resolveEffectiveActiveId(
    envProfile: StoredProviderProfile | null,
  ): string | null {
    if (this.activeProfileId) {
      if (this.profiles.some((p) => p.id === this.activeProfileId)) {
        return this.activeProfileId;
      }
      if (this.activeProfileId === ENV_PROFILE_ID && envProfile) {
        return ENV_PROFILE_ID;
      }
    }
    if (this.profiles.length > 0) return this.profiles[0].id;
    if (envProfile) return ENV_PROFILE_ID;
    return null;
  }

  getStatus(): AgentStatusResponse {
    const envProfile = buildEnvProfile(this.env);
    const masked: MaskedProviderProfile[] = this.profiles.map((p) =>
      toMasked(p, "saved"),
    );
    if (envProfile) {
      masked.push(toMasked(envProfile, "env"));
    }
    const activeId = this.resolveEffectiveActiveId(envProfile);
    const activeProfile = masked.find((p) => p.id === activeId) ?? null;
    return {
      configured: Boolean(activeProfile),
      activeProfileId: activeProfile?.id ?? null,
      activeProfile,
      profiles: masked,
    };
  }

  getResolvedProfile(profileId?: string): ResolvedProviderProfile | null {
    const envProfile = buildEnvProfile(this.env);
    const targetId =
      profileId?.trim() || this.resolveEffectiveActiveId(envProfile);
    if (!targetId) return null;

    if (targetId === ENV_PROFILE_ID && envProfile) {
      return toResolved(envProfile, "env");
    }
    const saved = this.profiles.find((p) => p.id === targetId);
    return saved ? toResolved(saved, "saved") : null;
  }

  createProfile(input: CreateProfileInput): MaskedProviderProfile {
    const preset = getProviderPreset(input.providerId);
    const now = new Date().toISOString();
    const label =
      input.label?.trim() ||
      `${preset?.shortName ?? input.providerName} · ${input.selectedModel}`;

    const profile = upgradeProfile(
      storedProfileSchema.parse({
        id: `prof-${randomUUID().slice(0, 12)}`,
        providerId: input.providerId,
        providerName: input.providerName,
        label: label.slice(0, 120),
        apiKey: input.apiKey,
        baseUrl: normalizeBaseUrl(input.baseUrl),
        protocol: input.protocol,
        selectedModel: input.selectedModel,
        models: input.models,
        modelOverrides: input.capabilityOverrides
          ? { [input.selectedModel]: input.capabilityOverrides }
          : undefined,
        capabilities: input.capabilities,
        updatedAt: now,
      }),
    );

    this.profiles.unshift(profile);
    this.activeProfileId = profile.id;
    this.persistToDisk();
    return toMasked(profile, "saved");
  }

  updateProfile(id: string, patch: UpdateProfileInput): MaskedProviderProfile {
    const envProfile = buildEnvProfile(this.env);
    if (id === ENV_PROFILE_ID) {
      if (!envProfile) throw new Error("配置不存在");
      const hasMutation =
        patch.apiKey !== undefined ||
        patch.baseUrl !== undefined ||
        patch.selectedModel !== undefined ||
        patch.label !== undefined ||
        patch.capabilityOverrides !== undefined;
      if (hasMutation) {
        throw new Error(
          "环境变量配置为只读，请在服务端 .env 中修改或新建本地连接",
        );
      }
      if (patch.activate) {
        this.activeProfileId = ENV_PROFILE_ID;
        this.persistToDisk();
      }
      return toMasked(envProfile, "env");
    }

    const index = this.profiles.findIndex((p) => p.id === id);
    if (index === -1) throw new Error("指定的模型连接配置不存在");

    const current = this.profiles[index];
    const nextProviderId = patch.providerId ?? current.providerId;
    const nextProtocol = patch.protocol ?? current.protocol;
    const nextSelectedModel =
      patch.selectedModel?.trim() || current.selectedModel;

    let nextModels = patch.models ?? current.models;
    const existingModelEntry = nextModels.find(
      (m) => m.id === nextSelectedModel,
    );
    const nextCapabilities =
      patch.capabilities ??
      existingModelEntry?.capabilities ??
      (nextSelectedModel === current.selectedModel &&
      nextProviderId === current.providerId &&
      nextProtocol === current.protocol
        ? current.capabilities
        : undefined) ??
      inferModelCapabilities(nextProviderId, nextProtocol, nextSelectedModel);

    if (existingModelEntry && patch.capabilities) {
      nextModels = nextModels.map((m) =>
        m.id === nextSelectedModel
          ? { ...m, capabilities: nextCapabilities }
          : m,
      );
    } else if (!existingModelEntry) {
      nextModels = [
        {
          id: nextSelectedModel,
          label: nextSelectedModel,
          capabilities: nextCapabilities,
          recommended: true,
        },
        ...nextModels,
      ];
    }

    const overrides = new Map(Object.entries(current.modelOverrides ?? {}));
    if (patch.capabilityOverrides === null) {
      overrides.delete(nextSelectedModel);
    } else if (patch.capabilityOverrides !== undefined) {
      overrides.set(
        nextSelectedModel,
        capabilityOverridesSchema.parse(patch.capabilityOverrides),
      );
    }

    const updated = upgradeProfile(
      storedProfileSchema.parse({
        ...current,
        providerId: nextProviderId,
        providerName: patch.providerName ?? current.providerName,
        label: patch.label?.trim().slice(0, 120) || current.label,
        apiKey: patch.apiKey !== undefined ? patch.apiKey : current.apiKey,
        baseUrl:
          patch.baseUrl !== undefined
            ? normalizeBaseUrl(patch.baseUrl)
            : current.baseUrl,
        protocol: nextProtocol,
        selectedModel: nextSelectedModel,
        models: nextModels,
        modelOverrides: overrides.size
          ? Object.fromEntries(overrides)
          : undefined,
        capabilities: nextCapabilities,
        updatedAt: new Date().toISOString(),
      }),
    );

    this.profiles[index] = updated;
    if (patch.activate) {
      this.activeProfileId = updated.id;
    }
    this.persistToDisk();
    return toMasked(updated, "saved");
  }

  deleteProfile(id: string): boolean {
    if (id === ENV_PROFILE_ID) {
      throw new Error("环境变量配置请在服务端 .env 中移除");
    }
    const index = this.profiles.findIndex((p) => p.id === id);
    if (index === -1) throw new Error("指定的模型连接配置不存在");

    this.profiles.splice(index, 1);
    if (this.activeProfileId === id) {
      const envProfile = buildEnvProfile(this.env);
      this.activeProfileId =
        this.profiles[0]?.id ?? (envProfile ? ENV_PROFILE_ID : null);
    }
    this.persistToDisk();
    return true;
  }
}
