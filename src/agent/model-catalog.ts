import { z } from "zod";
import type { StructuredOutputMode } from "./capabilities";

export interface CatalogModelSpec {
  displayName?: string;
  maxContextTokens: number;
  maxOutputTokens: number;
  supportsVision: boolean;
  supportsTools: boolean;
  isReasoning?: boolean;
  temperatureMode?: "normal" | "fixed_one" | "omit";
  tokenLimitParam?: "max_tokens" | "max_completion_tokens";
  structuredOutput?: StructuredOutputMode;
}

const text128k: CatalogModelSpec = {
  maxContextTokens: 128_000,
  maxOutputTokens: 16_384,
  supportsVision: false,
  supportsTools: true,
};

const vision128k = { ...text128k, supportsVision: true };
const longVision = {
  ...vision128k,
  maxContextTokens: 1_000_000,
  maxOutputTokens: 65_536,
};
const deepseekV4: CatalogModelSpec = {
  ...longVision,
  isReasoning: true,
  temperatureMode: "omit",
  structuredOutput: "json_object",
};
const openaiReasoning: CatalogModelSpec = {
  ...vision128k,
  maxContextTokens: 200_000,
  maxOutputTokens: 100_000,
  isReasoning: true,
  temperatureMode: "omit",
  tokenLimitParam: "max_completion_tokens",
  structuredOutput: "json_schema",
};

// Specific aliases precede the broader families that also match their IDs.
const families: readonly [RegExp, CatalogModelSpec][] = [
  [
    /^(deepseek-flash$|deepseek-v4(?:\.1)?-flash)/,
    { ...deepseekV4, displayName: "DeepSeek-V4.1-Flash" },
  ],
  [
    /^deepseek-v4(?!.*flash)/,
    { ...deepseekV4, displayName: "DeepSeek-V4-Pro", supportsVision: false },
  ],
  [
    /^(deepseek-chat(?:$|-)|deepseek-v3)/,
    {
      ...text128k,
      maxOutputTokens: 8_192,
      isReasoning: false,
      structuredOutput: "json_object",
    },
  ],
  [
    /^(deepseek-reasoner$|deepseek-r1)/,
    {
      ...text128k,
      maxOutputTokens: 32_768,
      isReasoning: true,
      temperatureMode: "omit",
      structuredOutput: "prompt_json",
    },
  ],

  [
    /^gpt-5\.[45](?:$|-20)/,
    {
      ...openaiReasoning,
      maxContextTokens: 1_050_000,
      maxOutputTokens: 128_000,
    },
  ],
  [
    /^gpt-5/,
    { ...openaiReasoning, maxContextTokens: 400_000, maxOutputTokens: 128_000 },
  ],
  [
    /^gpt-4\.1/,
    {
      ...vision128k,
      maxContextTokens: 1_000_000,
      maxOutputTokens: 32_768,
      structuredOutput: "json_schema",
    },
  ],
  [/^gpt-4o/, { ...vision128k, structuredOutput: "json_schema" }],
  [/^o[34]/, openaiReasoning],
  [
    /^o1-(mini|preview)/,
    {
      ...openaiReasoning,
      maxContextTokens: 128_000,
      maxOutputTokens: 32_768,
      supportsVision: false,
      supportsTools: false,
      structuredOutput: "prompt_json",
    },
  ],

  [
    /^claude-(opus|sonnet|fable)-5/,
    { ...longVision, structuredOutput: "tool_call" },
  ],
  [
    /^claude-((sonnet|opus)-4|3-[75])/,
    { ...vision128k, maxContextTokens: 200_000, structuredOutput: "tool_call" },
  ],
  [
    /^gemini-(4|3|2\.5)/,
    { ...longVision, isReasoning: true, structuredOutput: "json_object" },
  ],
  [
    /^gemini-2\.0/,
    { ...longVision, maxOutputTokens: 16_384, structuredOutput: "json_object" },
  ],

  [
    /^kimi-k2\.5/,
    { ...vision128k, maxContextTokens: 256_000, temperatureMode: "fixed_one" },
  ],
  [/^kimi-k3/, { ...vision128k, maxContextTokens: 256_000 }],
  [/^kimi-k2-thinking/, { ...text128k, isReasoning: true }],
  [/^kimi-k2|^moonshot-v1-128k$/, text128k],
  [/^qwen(3|2\.5)?-vl/, vision128k],
  [/^qwen(3|2\.5-72b)|^qwen-(max|plus)$/, text128k],
  [/^glm-5/, { ...vision128k, maxContextTokens: 200_000 }],
  [/^glm-4(\.5)?v/, vision128k],
  [/^glm-4\.5|^glm-4-plus$/, text128k],
  [
    /^minimax-m2/,
    { ...text128k, maxContextTokens: 1_000_000, isReasoning: true },
  ],
  [/^minimax-m1/, { ...text128k, isReasoning: true }],
  [/^minimax-text-01$/, { ...text128k, maxContextTokens: 1_000_000 }],
  [/^doubao-seed/, { ...vision128k, maxContextTokens: 256_000 }],
  [/^doubao-1-5-vision/, vision128k],
  [/^doubao-1-5-pro/, text128k],
];

export function lookupCatalogModel(
  _providerId: string,
  modelId: string,
): CatalogModelSpec | null {
  // Gateways and local servers can host the same model under an org namespace.
  const id = modelId.trim().toLowerCase().split("/").at(-1) ?? "";
  const match = families.find(([pattern]) => pattern.test(id));
  return match ? { ...match[1] } : null;
}

const snapshotModelSchema = z.object({
  id: z.string().trim().min(1).optional(),
  name: z.string().optional(),
  limit: z.object({
    context: z.number().int().positive(),
    output: z.number().int().positive(),
  }),
  modalities: z.object({ input: z.array(z.string()) }),
  tool_call: z.boolean(),
  reasoning: z.boolean().optional(),
});

function recordEntries(value: unknown): [string, unknown][] {
  return value && typeof value === "object" && !Array.isArray(value)
    ? Object.entries(value)
    : [];
}

// Keep provider-qualified keys when multiple hosts advertise the same ID.
// A unique unqualified ID also has a short alias for offline lookups.
export function parseModelsDevCatalog(
  rawJson: unknown,
): Record<string, CatalogModelSpec> {
  const entries = new Map<string, CatalogModelSpec>();
  const aliases = new Map<string, CatalogModelSpec | null>();
  for (const [provider, value] of recordEntries(rawJson)) {
    if (!value || typeof value !== "object" || !("models" in value)) continue;
    for (const [key, raw] of recordEntries(value.models)) {
      const parsed = snapshotModelSchema.safeParse(raw);
      if (!parsed.success) continue;
      const model = parsed.data;
      const id = model.id ?? key;
      const spec: CatalogModelSpec = {
        displayName: model.name,
        maxContextTokens: model.limit.context,
        maxOutputTokens: model.limit.output,
        supportsVision: model.modalities.input.includes("image"),
        supportsTools: model.tool_call,
        isReasoning: model.reasoning,
      };
      entries.set(`${provider}/${id}`, spec);
      aliases.set(id, aliases.has(id) ? null : spec);
    }
  }
  for (const [id, spec] of aliases) {
    if (spec && !entries.has(id)) entries.set(id, spec);
  }
  return Object.fromEntries(entries);
}
