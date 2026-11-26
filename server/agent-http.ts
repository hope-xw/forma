import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { imageAssets } from "../src/domain/images";
import { parseDocument } from "../src/domain/document";
import {
  assetTierSchema,
  libraryAiGuideSchema,
  parseLibrary,
} from "../src/domain/library-schema";
import { generateLibraryPlaybook } from "../src/agent/library-intelligence";
import {
  htmlArtboardSchema,
  scopeProposalSchema,
} from "../src/agent/forma-tools";
import {
  inferModelCapabilities,
  probeProvider,
} from "../src/agent/capabilities";
import {
  critiquePngDataUrl,
  designChatTimeoutMs,
  runDesignChat,
  runVisualCritique,
} from "../src/agent/design-engine";
import { generationSchema } from "../src/agent/provider";
import { listPublicProviderPresets } from "../src/agent/provider-registry";
import { AgentConfigStore } from "./agent-config-store";
import { sessionRequest } from "./agent-sessions";
import { SkillRegistry } from "./skill-registry";

export interface AgentHttpOptions {
  configDir?: string;
  origins?: string[];
  allowSameHostLoopback?: boolean;
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  store?: AgentConfigStore;
  skillRegistry?: SkillRegistry;
  workspaceDir?: string;
}

const DEFAULT_ORIGINS = [
  "http://127.0.0.1:5173",
  "http://localhost:5173",
  "http://127.0.0.1:4173",
  "http://localhost:4173",
  "forma://app",
];

const detectSchema = z.object({
  providerId: z.string().trim().max(64).optional(),
  apiKey: z.string().max(4096).optional(),
  baseUrl: z.string().trim().max(1024).optional(),
  preferredModel: z.string().trim().max(200).optional(),
});

const capabilityOverridesSchema = z
  .object({
    supportsVision: z.boolean().optional(),
    supportsTools: z.boolean().optional(),
    isReasoning: z.boolean().optional(),
    maxContextTokens: z.number().int().positive().optional(),
    maxOutputTokens: z.number().int().positive().optional(),
    structuredOutput: z
      .enum(["json_schema", "json_object", "tool_call", "prompt_json"])
      .optional(),
  })
  .nullish();

const createProfileSchema = z.object({
  capabilityOverrides: capabilityOverridesSchema,
  providerId: z.string().trim().max(64).optional(),
  apiKey: z.string().max(4096).optional(),
  baseUrl: z.string().trim().max(1024).optional(),
  selectedModel: z.string().trim().max(200).optional(),
  label: z.string().trim().max(120).optional(),
});

const updateProfileSchema = z.object({
  capabilityOverrides: capabilityOverridesSchema,
  activate: z.boolean().optional(),
  selectedModel: z.string().trim().min(1).max(200).optional(),
  label: z.string().trim().min(1).max(120).optional(),
  baseUrl: z.string().trim().max(1024).optional(),
  apiKey: z.string().max(4096).trim().optional(),
});

const skillImportSchema = z.union([
  z.strictObject({
    skillMd: z.string().min(1),
    slug: z.string().optional(),
    resources: z
      .array(z.object({ path: z.string(), content: z.string() }))
      .optional(),
  }),
  z.strictObject({ localDirPath: z.string().min(1) }),
]);
const skillSettingsSchema = z.strictObject({
  scanExternalStandardDirs: z.boolean().optional(),
});
const skillEnabledSchema = z.strictObject({ enabled: z.boolean() });
const libraryPlaybookRequestSchema = z.strictObject({
  library: z.unknown(),
  existingGuide: libraryAiGuideSchema.optional(),
});
const targetLibraryId = z.string().trim().min(1).max(128);
const memoryId = z.string().max(128).optional();
const episodeId = z.string().min(1).max(128);
const episodeName = z.string().max(200).trim().min(1);
const recalledEpisodeSchema = z.strictObject({
  id: episodeId,
  title: z.string().max(120).trim().min(1),
  sourceFileKey: z.string().min(1).max(200),
  sourceFileName: episodeName,
  isCurrentFile: z.boolean(),
  libraryId: episodeId.optional(),
  libraryName: episodeName.optional(),
  prompt: z.string().max(16000),
  summary: z.string().max(2000),
  mode: z.enum(["generate", "edit"]),
  screens: z
    .array(
      z.strictObject({
        rootId: episodeId,
        name: episodeName,
        role: z.enum(["primary", "overlay", "exception", "detail"]),
        width: z.number().nonnegative(),
        height: z.number().nonnegative(),
        nodeCount: z.number().int().positive(),
        componentIds: z.array(episodeId).max(64),
        sampleTexts: z.array(z.string().max(240)).max(6),
      }),
    )
    .max(24),
  componentsUsed: z
    .array(
      z.strictObject({
        libraryId: episodeId,
        componentId: episodeId,
        componentName: episodeName,
        assetTier: assetTierSchema.optional(),
        variantId: episodeId.optional(),
        count: z.number().int().positive(),
      }),
    )
    .max(64),
  customModules: z.array(episodeName).max(32),
  decisions: z
    .array(
      z.strictObject({
        question: z.string().max(240).trim().min(1),
        choice: z.string().max(400).trim().min(1),
      }),
    )
    .max(16),
  tags: z.array(z.string().max(64).trim().min(1)).max(32),
  createdAt: z.iso.datetime({ offset: true }).max(64),
  pinned: z.boolean().optional(),
  explicitlyMentioned: z.boolean().optional(),
  matchScore: z.number().optional(),
  matchReasons: z.array(z.string().max(160)).max(12).optional(),
});

const chatFields = z.object({
  targetLibraryId: targetLibraryId.nullable().optional(),
  confirmedScope: scopeProposalSchema.optional(),
  memoryScope: z
    .strictObject({
      projectId: z.string().max(205).optional(),
      projectName: z.string().max(160).optional(),
      fileKey: z.string().max(200).optional(),
      libraryId: memoryId,
      userId: memoryId,
    })
    .optional(),
  recalledEpisodes: z.array(recalledEpisodeSchema).max(8).optional(),
  generationMode: z.enum(["auto", "html", "blueprint"]).optional(),
  activeSkills: z.array(z.string().trim().min(1).max(120)).max(16).optional(),
  prompt: z.string().trim().min(1).max(16000),
  document: z.unknown(),
  selection: z.string().nullable(),
  selectionCount: z.number().int().nonnegative().max(100000).optional(),
  profileId: z.string().trim().min(1).max(128).optional(),
  model: z.string().trim().min(1).max(200).optional(),
  history: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        text: z.string().max(16000),
      }),
    )
    .max(40)
    .optional(),
  mentions: z
    .array(
      z.discriminatedUnion("kind", [
        z.object({
          kind: z.enum(["component", "variable", "style", "node"]),
          id: z.string().min(1).max(260),
          label: z.string().max(200),
        }),
        z.strictObject({
          kind: z.literal("episode"),
          id: episodeId,
          label: z.string().max(200),
        }),
      ]),
    )
    .max(40)
    .optional(),
  attachments: z
    .array(
      z.object({
        name: z.string().max(200),
        mimeType: z.string().max(64),
        dataUrl: z.string().max(20_000_000),
      }),
    )
    .max(4)
    .optional(),
  viewportCenter: z
    .object({
      x: z.number().finite(),
      y: z.number().finite(),
    })
    .optional(),
});

const chatRequestSchema = chatFields.superRefine((value, ctx) => {
  const mentions = value.mentions ?? [];
  if (mentions.filter((m) => m.kind === "episode").length > 8)
    ctx.addIssue({
      code: "custom",
      path: ["mentions"],
      message: "单轮最多引用 8 条历史需求档案",
    });
  const recalledIds = new Set(value.recalledEpisodes?.map((ep) => ep.id));
  mentions.forEach((mention, index) => {
    if (mention.kind === "episode" && !recalledIds.has(mention.id))
      ctx.addIssue({
        code: "custom",
        path: ["mentions", index, "id"],
        message: "引用的历史需求档案不在本轮召回上下文中",
      });
  });
});

const count = z.number().int().nonnegative().optional();
const localizedArtboard = htmlArtboardSchema.extend({
  // The original HTML can now contain up to twelve localized 1.5 MiB photos.
  html: z.string().min(1).max(27_000_000),
  css: z.string().max(27_000_000).optional(),
  placement: z.object({ x: z.number(), y: z.number() }).optional(),
  imagesLocalized: count,
  iconsHydrated: count,
  componentSlotsResolved: count,
});
const screenshotUrl = z.string().max(20_000_000).regex(critiquePngDataUrl);
const critiqueRequestSchema = chatFields
  .pick({
    prompt: true,
    activeSkills: true,
    profileId: true,
    model: true,
  })
  .extend({
    document: z.unknown().optional(),
    selection: z.string().nullable().optional(),
    renderedImageDataUrl: screenshotUrl.optional(),
    renderedImages: z
      .array(
        z.object({
          refId: z.string().min(1).max(256).optional(),
          name: z.string().min(1).max(120),
          dataUrl: screenshotUrl,
        }),
      )
      .min(1)
      .max(8)
      .optional(),
    htmlDraft: localizedArtboard
      .omit({ refId: true, role: true, parentRef: true })
      .extend({
        artboards: z.array(localizedArtboard).min(1).max(8).optional(),
        targetLibraryId: targetLibraryId.optional(),
        snapLibraryTokens: z.boolean().optional(),
        images: imageAssets.optional(),
        reply: z.string().min(1),
        summary: z.string(),
      }),
  })
  .refine(
    (ctx) => ctx.renderedImageDataUrl || ctx.renderedImages,
    "视觉自审需要 PNG 截图",
  );

function sendJson(res: ServerResponse, status: number, body: unknown) {
  if (res.writableEnded) return;
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(body));
}

async function readJsonBody(
  req: IncomingMessage,
  maxBytes = 128_000_000,
): Promise<unknown> {
  let bytes = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buf.length;
    if (bytes > maxBytes) {
      throw new Error("请求体积超过限制");
    }
    chunks.push(buf);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error("请求体不是有效的 JSON");
  }
}

function sanitizeError(
  error: unknown,
  fallback: string,
  secrets: string[] = [],
): string {
  let msg = error instanceof Error ? error.message : fallback;
  for (const secret of secrets) {
    const s = secret.trim();
    if (s && msg.includes(s)) {
      msg = msg.split(s).join("••••");
    }
  }
  return msg || fallback;
}

function isLoopbackHost(host: string): boolean {
  return /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(host);
}

async function hasRequestBody(req: IncomingMessage): Promise<boolean> {
  // Chunked requests may have a body even when Content-Length is absent.
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    if (chunk.length) return true;
  }
  return false;
}

export function createAgentRequestHandler(options: AgentHttpOptions = {}) {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? fetch;
  const store =
    options.store ??
    new AgentConfigStore({
      configDir: options.configDir,
      env,
    });
  const skillRegistry =
    options.skillRegistry ??
    new SkillRegistry({
      configDir: options.configDir,
      workspaceDir: options.workspaceDir,
    });

  const configuredOrigins = new Set(
    options.origins ??
      (env.DEV_ORIGINS ? env.DEV_ORIGINS.split(",") : DEFAULT_ORIGINS)
        .map((o) => o.trim())
        .filter(Boolean),
  );

  const allowSameHostLoopback = options.allowSameHostLoopback ?? true;

  const isAllowedOrigin = (req: IncomingMessage): boolean => {
    const origin = req.headers.origin;
    if (!origin) return false;
    if (configuredOrigins.has(origin)) return true;
    const host = req.headers.host ?? "";
    return (
      allowSameHostLoopback &&
      isLoopbackHost(host) &&
      (origin === `http://${host}` || origin === `https://${host}`)
    );
  };

  let activeGenerations = 0;

  const handler = async (req: IncomingMessage, res: ServerResponse) => {
    const urlObj = new URL(req.url ?? "/", "http://127.0.0.1");
    const pathname = urlObj.pathname;
    const method = (req.method ?? "GET").toUpperCase();

    // 1. Existing external MCP / Agent sessions (100% backward compatible)
    if (pathname.startsWith("/api/agent/sessions")) {
      try {
        const result = await sessionRequest(
          req,
          () => readJsonBody(req),
          isAllowedOrigin(req),
        );
        sendJson(res, 200, result);
      } catch (err) {
        sendJson(res, 400, {
          error: sanitizeError(err, "会话请求失败"),
        });
      }
      return;
    }

    // 2. GET /api/agent/providers
    if (pathname === "/api/agent/providers" && method === "GET") {
      sendJson(res, 200, { providers: listPublicProviderPresets() });
      return;
    }

    // 3. GET /api/agent/status
    if (pathname === "/api/agent/status" && method === "GET") {
      sendJson(res, 200, store.getStatus());
      return;
    }

    if (pathname === "/api/agent/skills" && method === "GET") {
      sendJson(res, 200, skillRegistry.listSkills());
      return;
    }

    const skillPath = /^\/api\/agent\/skills\/([^/]+)$/.exec(pathname)?.[1];
    const skillId =
      skillPath && !["rescan", "import", "settings"].includes(skillPath)
        ? skillPath
        : undefined;
    if (skillId && method === "GET") {
      const skill = skillRegistry.getSkillDetail(skillId);
      if (skill) sendJson(res, 200, { skill });
      else sendJson(res, 404, { error: "Skill 不存在" });
      return;
    }

    // All remaining endpoints are mutating — verify Origin!
    const profileIdMatch = /^\/api\/agent\/profiles\/([^/]+)$/.exec(pathname);
    const refreshMatch =
      method === "POST" &&
      /^\/api\/agent\/profiles\/([^/]+)\/refresh$/.exec(pathname);
    const rescan = skillPath === "rescan" && method === "POST";
    const importSkill = skillPath === "import" && method === "POST";
    const updateSettings =
      skillPath === "settings" && (method === "POST" || method === "PATCH");
    const isKnownMutatingRoute =
      refreshMatch ||
      rescan ||
      importSkill ||
      updateSettings ||
      (skillId && (method === "PATCH" || method === "DELETE")) ||
      (pathname === "/api/agent/detect" && method === "POST") ||
      (pathname === "/api/agent/profiles" && method === "POST") ||
      (Boolean(profileIdMatch) &&
        (method === "PATCH" || method === "DELETE")) ||
      (pathname === "/api/agent/chat" && method === "POST") ||
      (pathname === "/api/agent/library-playbook" && method === "POST") ||
      (pathname === "/api/agent/critique" && method === "POST") ||
      (pathname === "/api/agent/generate" && method === "POST");

    if (!isKnownMutatingRoute) {
      sendJson(res, 404, { error: "接口不存在" });
      return;
    }

    if (!isAllowedOrigin(req)) {
      sendJson(res, 403, { error: "请求来源不允许" });
      return;
    }

    if (method === "POST" || method === "PATCH") {
      const contentType = req.headers["content-type"]
        ?.split(";", 1)[0]
        .trim()
        .toLowerCase();
      const optionalBody = refreshMatch || rescan;
      try {
        if (contentType === "application/json") {
          if (optionalBody) await readJsonBody(req, 1_000_000);
        } else if (
          !optionalBody ||
          contentType !== undefined ||
          (await hasRequestBody(req))
        ) {
          sendJson(res, 415, { error: "必须使用 JSON 请求" });
          return;
        }
      } catch (err) {
        sendJson(res, 400, { error: sanitizeError(err, "读取请求失败") });
        return;
      }
    }

    if (pathname === "/api/agent/library-playbook") {
      try {
        const { library, existingGuide } = libraryPlaybookRequestSchema.parse(
          await readJsonBody(req),
        );
        sendJson(res, 200, {
          ok: true,
          ...generateLibraryPlaybook(parseLibrary(library), existingGuide),
        });
      } catch (err) {
        sendJson(res, 400, {
          error: sanitizeError(err, "生成组件库说明书失败"),
        });
      }
      return;
    }

    if (skillPath) {
      try {
        if (rescan) {
          sendJson(res, 200, skillRegistry.rescan());
        } else if (importSkill) {
          const input = skillImportSchema.parse(await readJsonBody(req));
          const skill =
            "skillMd" in input
              ? skillRegistry.importSkill(input)
              : skillRegistry.importLocalDirectory(input.localDirPath);
          sendJson(res, 200, { skill, ...skillRegistry.listSkills() });
        } else if (updateSettings) {
          const patch = skillSettingsSchema.parse(
            await readJsonBody(req, 1_000_000),
          );
          sendJson(res, 200, skillRegistry.updateSettings(patch));
        } else if (method === "PATCH") {
          const { enabled } = skillEnabledSchema.parse(
            await readJsonBody(req, 1_000_000),
          );
          sendJson(res, 200, skillRegistry.setSkillEnabled(skillPath, enabled));
        } else {
          sendJson(res, 200, skillRegistry.deleteUserSkill(skillPath));
        }
      } catch (err) {
        sendJson(res, 400, { error: sanitizeError(err, "Skill 管理请求失败") });
      }
      return;
    }

    // 4. POST /api/agent/detect
    if (pathname === "/api/agent/detect" && method === "POST") {
      let secretKey = "";
      const controller = new AbortController();
      req.on("aborted", () => controller.abort());
      res.on("close", () => {
        if (!res.writableEnded) controller.abort();
      });
      try {
        const input = detectSchema.parse(await readJsonBody(req, 1_000_000));
        secretKey = input.apiKey ?? "";
        const result = await probeProvider(input, fetchImpl, controller.signal);
        sendJson(res, 200, result);
      } catch (err) {
        sendJson(res, 400, {
          error: sanitizeError(err, "模型探测失败", [secretKey]),
        });
      }
      return;
    }

    // 5. POST /api/agent/profiles
    if (pathname === "/api/agent/profiles" && method === "POST") {
      let secretKey = "";
      const controller = new AbortController();
      req.on("aborted", () => controller.abort());
      res.on("close", () => {
        if (!res.writableEnded) controller.abort();
      });
      try {
        const input = createProfileSchema.parse(
          await readJsonBody(req, 1_000_000),
        );
        secretKey = input.apiKey ?? "";
        const probed = await probeProvider(
          {
            providerId: input.providerId,
            apiKey: input.apiKey,
            baseUrl: input.baseUrl,
            preferredModel: input.selectedModel,
          },
          fetchImpl,
          controller.signal,
        );
        const profile = store.createProfile({
          providerId: probed.providerId,
          providerName: probed.providerName,
          label: input.label,
          capabilityOverrides: input.capabilityOverrides,
          apiKey: (input.apiKey ?? "").trim(),
          baseUrl: probed.baseUrl,
          protocol: probed.protocol,
          selectedModel: probed.selectedModel,
          models: probed.models,
          capabilities: probed.capabilities,
        });
        sendJson(res, 200, {
          profile,
          status: store.getStatus(),
        });
      } catch (err) {
        sendJson(res, 400, {
          error: sanitizeError(err, "保存模型连接失败", [secretKey]),
        });
      }
      return;
    }

    // PATCH /profiles/:id and POST /profiles/:id/refresh share the credential probe.
    const updateMatch = refreshMatch || (method === "PATCH" && profileIdMatch);
    if (updateMatch) {
      let secretKey = "";
      const controller = new AbortController();
      req.on("aborted", () => controller.abort());
      res.on("close", () => {
        if (!res.writableEnded) controller.abort();
      });
      try {
        const id = decodeURIComponent(updateMatch[1]);
        const patch = refreshMatch
          ? {}
          : updateProfileSchema.parse(await readJsonBody(req, 1_000_000));
        secretKey = patch.apiKey ?? "";

        if (
          refreshMatch ||
          patch.apiKey !== undefined ||
          patch.baseUrl !== undefined
        ) {
          const existing = store.getResolvedProfile(id);
          if (existing?.id !== id) throw new Error("指定的模型连接配置不存在");
          if (existing.source === "env") {
            throw new Error(
              "环境变量配置为只读，请在服务端 .env 中修改或新建本地连接",
            );
          }
          secretKey = patch.apiKey ?? existing.apiKey;
          const probed = await probeProvider(
            {
              providerId: existing.providerId,
              apiKey: secretKey,
              baseUrl: patch.baseUrl ?? existing.baseUrl,
              preferredModel: patch.selectedModel ?? existing.selectedModel,
            },
            fetchImpl,
            controller.signal,
          );
          // A concurrent credential change must not pair its new key with the
          // old gateway from this probe. Unrelated edits and overrides can merge.
          const latest = store.getResolvedProfile(id);
          if (
            !latest ||
            latest.apiKey !== existing.apiKey ||
            latest.baseUrl !== existing.baseUrl ||
            latest.selectedModel !== existing.selectedModel
          ) {
            sendJson(res, 409, { error: "探测期间模型连接已变更，请重试" });
            return;
          }
          const profile = store.updateProfile(id, {
            ...patch,
            baseUrl: probed.baseUrl,
            protocol: probed.protocol,
            selectedModel: probed.selectedModel,
            models: probed.models,
            capabilities: probed.capabilities,
            providerId: probed.providerId,
            providerName: probed.providerName,
          });
          sendJson(res, 200, {
            profile,
            status: store.getStatus(),
            ...(refreshMatch && { probeNote: probed.probeNote }),
          });
          return;
        }

        const profile = store.updateProfile(id, patch);
        sendJson(res, 200, { profile, status: store.getStatus() });
      } catch (err) {
        sendJson(res, 400, {
          error: sanitizeError(err, "更新模型连接失败", [secretKey]),
        });
      }
      return;
    }

    // 7. DELETE /api/agent/profiles/:id
    if (profileIdMatch && method === "DELETE") {
      try {
        const id = decodeURIComponent(profileIdMatch[1]);
        store.deleteProfile(id);
        sendJson(res, 200, { deleted: true, status: store.getStatus() });
      } catch (err) {
        sendJson(res, 400, {
          error: sanitizeError(err, "删除模型连接失败"),
        });
      }
      return;
    }

    const critique = pathname === "/api/agent/critique";
    if ((pathname === "/api/agent/chat" || critique) && method === "POST") {
      if (activeGenerations >= 3) {
        sendJson(res, 429, { error: "生成任务繁忙，请稍后重试" });
        return;
      }
      const wantsSse =
        !critique &&
        (req.headers.accept ?? "").toLowerCase().includes("text/event-stream");
      activeGenerations++;
      const controller = new AbortController();
      req.on("aborted", () => controller.abort());
      res.on("close", () => {
        if (!res.writableEnded) controller.abort();
      });

      let profileApiKey = "";
      let sseStarted = false;
      const writeSse = (event: string, data: unknown) => {
        if (res.writableEnded) return;
        if (!sseStarted) {
          sseStarted = true;
          res.writeHead(200, {
            "Content-Type": "text/event-stream; charset=utf-8",
            "Cache-Control": "no-cache, no-store",
            Connection: "keep-alive",
            "X-Accel-Buffering": "no",
          });
        }
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      };

      try {
        const body = await readJsonBody(req);
        const input = critique
          ? { kind: "critique" as const, ...critiqueRequestSchema.parse(body) }
          : { kind: "chat" as const, ...chatRequestSchema.parse(body) };
        const profile = store.getResolvedProfile(input.profileId);
        if (!profile) {
          sendJson(res, 503, {
            error: "尚未配置模型供应商，请先点击配置模型连接",
          });
          return;
        }
        profileApiKey = profile.apiKey;

        const modelId = input.model ?? profile.selectedModel;
        const capabilities =
          modelId === profile.selectedModel
            ? profile.capabilities
            : (profile.models.find((m) => m.id === modelId)?.capabilities ??
              inferModelCapabilities(
                profile.providerId,
                profile.protocol,
                modelId,
              ));

        const signal = AbortSignal.any([
          controller.signal,
          AbortSignal.timeout(designChatTimeoutMs),
        ]);

        const runOptions = {
          adapterConfig: {
            providerId: profile.providerId,
            baseUrl: profile.baseUrl,
            apiKey: profile.apiKey,
            model: modelId,
            capabilities,
            extraHeaders: profile.extraHeaders,
          },
          providerName: profile.providerName,
          fetchImpl,
          signal,
        };
        if (input.kind === "critique") {
          const result = await runVisualCritique(
            {
              ...input,
              document:
                input.document === undefined
                  ? undefined
                  : parseDocument(input.document),
            },
            runOptions,
          );
          sendJson(res, 200, { ok: true, ...result });
          return;
        }
        const result = await runDesignChat(
          { ...input, document: parseDocument(input.document) },
          {
            ...runOptions,
            skillProvider: skillRegistry.asRuntimeProvider(),
            onProgress: wantsSse
              ? (progress) => writeSse("progress", progress)
              : undefined,
          },
        );

        if (wantsSse) {
          writeSse("result", result);
          res.end();
        } else {
          sendJson(res, 200, result);
        }
      } catch (err) {
        const errorMsg = sanitizeError(err, "生成失败", [profileApiKey]);
        if (wantsSse && sseStarted) {
          writeSse("error", { error: errorMsg });
          res.end();
        } else if (!res.writableEnded) {
          sendJson(res, 400, { error: errorMsg });
        }
      } finally {
        activeGenerations--;
      }
      return;
    }

    // 9. POST /api/agent/generate (100% backward compatible)
    if (pathname === "/api/agent/generate" && method === "POST") {
      if (activeGenerations >= 3) {
        sendJson(res, 429, { error: "生成任务繁忙，请稍后重试" });
        return;
      }
      const profile = store.getResolvedProfile();
      if (!profile) {
        sendJson(res, 503, {
          error:
            "模型未配置。请在模型设置面板中配置供应商，或设置服务端 MODEL_BASE_URL、MODEL_API_KEY 和 MODEL_ID。",
        });
        return;
      }
      activeGenerations++;
      const controller = new AbortController();
      req.on("aborted", () => controller.abort());
      res.on("close", () => {
        if (!res.writableEnded) controller.abort();
      });
      try {
        const input = generationSchema.parse(await readJsonBody(req));
        const document = parseDocument(input.document);
        const signal = AbortSignal.any([
          controller.signal,
          AbortSignal.timeout(180_000),
        ]);
        const result = await runDesignChat(
          {
            prompt: input.prompt,
            document,
            selection: input.selection,
            generationMode: "blueprint",
          },
          {
            adapterConfig: {
              providerId: profile.providerId,
              baseUrl: profile.baseUrl,
              apiKey: profile.apiKey,
              model: profile.selectedModel,
              capabilities: profile.capabilities,
              extraHeaders: profile.extraHeaders,
            },
            providerName: profile.providerName,
            enableScopePlan: false,
            skillProvider: skillRegistry.asRuntimeProvider(),
            fetchImpl,
            signal,
          },
        );
        if (!result.transaction) {
          sendJson(res, 400, { error: result.reply || "模型未返回设计事务" });
          return;
        }
        sendJson(res, 200, {
          transaction: result.transaction,
          toolTrace: result.toolTrace,
          activatedSkills: result.activatedSkills,
          diagnostics: result.diagnostics,
        });
      } catch (err) {
        if (!res.writableEnded) {
          sendJson(res, 400, {
            error: sanitizeError(err, "生成失败", [profile.apiKey]),
          });
        }
      } finally {
        activeGenerations--;
      }
    }
  };

  return Object.assign(handler, { store, skillRegistry });
}
