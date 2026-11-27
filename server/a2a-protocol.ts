import { z } from "zod";

const id = z.string().min(1);
const metadata = z.record(z.string(), z.unknown()).optional();
const timestamp = z.iso.datetime({ offset: true });
const strings = z.array(z.string());

export const a2aTaskStateSchema = z.enum([
  "submitted",
  "working",
  "input-required",
  "completed",
  "failed",
  "canceled",
  "rejected",
]);
export type A2ATaskState = z.infer<typeof a2aTaskStateSchema>;

export const a2aPartSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("text"), text: z.string(), metadata }),
  z.object({
    kind: z.literal("data"),
    data: z.record(z.string(), z.unknown()),
    metadata,
  }),
  z.object({
    kind: z.literal("file"),
    file: z
      .object({
        name: z.string().optional(),
        mimeType: z.string().min(1),
        bytes: z.base64().optional(),
        uri: z.url().optional(),
      })
      .refine(
        (file) => (file.bytes !== undefined) !== (file.uri !== undefined),
        {
          message: "Supply exactly one of bytes or uri",
        },
      ),
    metadata,
  }),
]);
export type A2APart = z.infer<typeof a2aPartSchema>;

export const a2aMessageInputSchema = z.object({
  kind: z.literal("message").optional(),
  messageId: id,
  role: z.enum(["user", "agent"]),
  parts: z.array(a2aPartSchema).min(1),
  taskId: id.optional(),
  contextId: id.optional(),
  metadata,
});
export type A2AMessage = z.infer<typeof a2aMessageInputSchema>;
export const a2aArtifactSchema = z.object({
  artifactId: id,
  name: z.string(),
  description: z.string().optional(),
  parts: z.array(a2aPartSchema),
  metadata,
});
export type A2AArtifact = z.infer<typeof a2aArtifactSchema>;

export const a2aTaskStatusSchema = z.object({
  state: a2aTaskStateSchema,
  message: a2aMessageInputSchema.optional(),
  timestamp,
});
export type A2ATaskStatus = z.infer<typeof a2aTaskStatusSchema>;

export const a2aTaskSchema = z.object({
  id,
  contextId: id,
  kind: z.literal("task"),
  status: a2aTaskStatusSchema,
  artifacts: z.array(a2aArtifactSchema),
  history: z.array(a2aMessageInputSchema),
  metadata,
});
export type A2ATask = z.infer<typeof a2aTaskSchema>;

export const a2aStatusUpdateEventSchema = z.object({
  kind: z.literal("status-update"),
  taskId: id,
  contextId: id,
  status: a2aTaskStatusSchema,
  final: z.boolean(),
  metadata,
});
export type A2AStatusUpdateEvent = z.infer<typeof a2aStatusUpdateEventSchema>;
export const a2aArtifactUpdateEventSchema = z.object({
  kind: z.literal("artifact-update"),
  taskId: id,
  contextId: id,
  artifact: a2aArtifactSchema,
  append: z.boolean().optional(),
  lastChunk: z.boolean().optional(),
});
export type A2AArtifactUpdateEvent = z.infer<
  typeof a2aArtifactUpdateEventSchema
>;

export const a2aSkillIdSchema = z.enum([
  "generate_ui",
  "refine_artboard",
  "audit_design_system",
  "design_to_react",
]);
export type A2ASkillId = z.infer<typeof a2aSkillIdSchema>;
const skillSchema = z.object({
  id: a2aSkillIdSchema,
  name: z.string(),
  description: z.string(),
  tags: strings,
  examples: strings,
  inputModes: strings,
  outputModes: strings,
});

export const a2aAgentCardSchema = z.object({
  name: z.string(),
  description: z.string(),
  url: z.url(),
  version: z.string(),
  protocolVersion: z.literal("0.3.0"),
  preferredTransport: z.literal("JSONRPC").optional(),
  provider: z.object({ organization: z.string(), url: z.url() }),
  capabilities: z.object({
    streaming: z.boolean(),
    pushNotifications: z.boolean(),
    stateTransitionHistory: z.boolean(),
  }),
  securitySchemes: z.object({
    bearer: z.object({ type: z.literal("http"), scheme: z.literal("bearer") }),
  }),
  security: z.array(z.object({ bearer: strings })),
  defaultInputModes: strings,
  defaultOutputModes: strings,
  skills: z.array(skillSchema),
});
export type A2AAgentCard = z.infer<typeof a2aAgentCardSchema>;

export function buildFormaAgentCard({
  baseUrl,
  version = "0.15.0",
}: {
  baseUrl: string;
  version?: string;
}): A2AAgentCard {
  const inputModes = ["text/plain", "application/json"];
  const outputModes = [...inputModes, "image/svg+xml"];
  return {
    name: "Forma Design Agent",
    description:
      "Assemble design-system components on a live Forma canvas, audit the design, and deliver the reviewed artboard as a React/TypeScript project.",
    url: baseUrl.replace(/\/+$/, "") + "/api/a2a",
    version,
    protocolVersion: "0.3.0",
    preferredTransport: "JSONRPC",
    provider: {
      organization: "Forma",
      url: "https://github.com/hope-xw/forma",
    },
    capabilities: {
      streaming: true,
      pushNotifications: false,
      stateTransitionHistory: true,
    },
    securitySchemes: { bearer: { type: "http", scheme: "bearer" } },
    security: [{ bearer: [] }],
    defaultInputModes: inputModes,
    defaultOutputModes: outputModes,
    skills: [
      {
        id: "generate_ui",
        name: "Generate UI",
        description:
          "Propose an editable layout using the document's design system.",
        tags: ["canvas", "layout"],
        examples: ["Create a mobile checkout screen"],
        inputModes,
        outputModes,
      },
      {
        id: "refine_artboard",
        name: "Refine artboard",
        description:
          "Propose changes to the selected design for review on the canvas.",
        tags: ["canvas", "editing"],
        examples: ["Refine the spacing of this form"],
        inputModes,
        outputModes,
      },
      {
        id: "audit_design_system",
        name: "Audit design system",
        description: "Inspect the design and return a structured issue report.",
        tags: ["audit", "design-system"],
        examples: ["Check this artboard for design system issues"],
        inputModes,
        outputModes: ["application/json"],
      },
      {
        id: "design_to_react",
        name: "Design to React",
        description:
          "Export the live artboard as React/TypeScript files with a visual preview.",
        tags: ["react", "typescript", "export"],
        examples: ["Export this artboard to React"],
        inputModes,
        outputModes,
      },
    ],
  };
}

export const jsonRpcIdSchema = z.union([z.string(), z.number(), z.null()]);
export type JsonRpcId = z.infer<typeof jsonRpcIdSchema>;
export const jsonRpcRequestSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: jsonRpcIdSchema,
  method: z.string().min(1),
  params: z.unknown().optional(),
});

export const jsonRpcErrorCodes = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
  taskNotFound: -32001,
  taskNotCancelable: -32002,
  // Forma's integration contract assigns these two application errors.
  permissionDenied: -32003,
  modelNotConfigured: -32004,
} as const;

export function makeJsonRpcResult<T>(id: JsonRpcId, result: T) {
  return { jsonrpc: "2.0" as const, id, result };
}
export function makeJsonRpcError(
  id: JsonRpcId,
  code: number,
  message: string,
  data?: unknown,
) {
  return {
    jsonrpc: "2.0" as const,
    id,
    error: { code, message, ...(data === undefined ? {} : { data }) },
  };
}

const historyLength = z.int().nonnegative().optional();
export const messageSendParamsSchema = z.object({
  message: a2aMessageInputSchema,
  configuration: z
    .object({
      acceptedOutputModes: strings.optional(),
      blocking: z.boolean().optional(),
      historyLength,
    })
    .optional(),
  metadata,
});
export const tasksGetParamsSchema = z.object({ id, historyLength });
export const tasksCancelParamsSchema = z.object({
  id,
  reason: z.string().optional(),
});
export const tasksListParamsSchema = z.object({
  contextId: id.optional(),
  limit: z.int().min(1).max(100).optional(),
});

export function inferFormaSkill(
  message: A2AMessage,
  metadata?: Record<string, unknown>,
): A2ASkillId {
  const dataParts = message.parts.filter((part) => part.kind === "data");
  for (const candidate of [
    metadata?.skill,
    ...dataParts.map((part) => part.data.skill),
    message.metadata?.skill,
  ]) {
    const parsed = a2aSkillIdSchema.safeParse(candidate);
    if (parsed.success) return parsed.data;
  }
  const text = message.parts
    .filter((part) => part.kind === "text")
    .map((part) => part.text)
    .join("\n");
  if (/export|react|tsx|code|导出|代码/i.test(text)) return "design_to_react";
  if (/audit|lint|contrast|accessibility|规范|校验|对比度|检查/i.test(text))
    return "audit_design_system";
  if (/refine|polish|edit|update|fix|修改|调整|优化|精修/i.test(text))
    return "refine_artboard";
  return "generate_ui";
}
