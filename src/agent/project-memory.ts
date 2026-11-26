import { DOMParser, XMLSerializer } from "@xmldom/xmldom";
import { z } from "zod";
import type { DesignDocument, DesignNode } from "../domain/document";
import { layoutBounds } from "../domain/geometry";
import {
  effectiveModes,
  resolveNode,
  styleForSlot,
} from "../domain/design-system";
import type { DesignSystem } from "../domain/design-system-schema";
import { assetTierSchema, isSafeIdentifierKey } from "../domain/library-schema";
import { openPage, pageList } from "../domain/pages";
import { paintVariables } from "../domain/paint-bindings";
import { isSceneFrame } from "../domain/prototype";
import { stableHash } from "../domain/stable-hash";
import { ancestors, selectionRoots } from "../domain/tree";
import {
  indexPublishedScene,
  isPublished,
  childrenOf,
} from "../domain/scene-index";
import { exportNodeToSvg } from "../infrastructure/static-export";
import { classifyComponentTier } from "./library-intelligence";

export const DEFAULT_MEMORY_USER_ID = "local-default";
const id = z.string().min(1).max(128);
const fileKeySchema = z.string().min(1).max(200);
const name = z.string().trim().min(1).max(200);
const timestamp = z.iso.datetime({ offset: true });
const scope = z.union([
  z.string().startsWith("proj:").min(6).max(133),
  z.string().startsWith("file:").min(6).max(205),
]);
export const projectSpaceSchema = z.strictObject({
  id,
  name: z.string().trim().min(1).max(120),
  description: z.string().max(400).optional(),
  defaultLibraryId: id
    .refine(isSafeIdentifierKey, "默认组件库 ID 不能为保留键名")
    .optional(),
  createdAt: timestamp,
  updatedAt: timestamp,
});
export type ProjectSpace = z.infer<typeof projectSpaceSchema>;

export const fileProjectAssignmentSchema = z.strictObject({
  fileKey: fileKeySchema,
  projectId: id,
  updatedAt: timestamp,
});
export type FileProjectAssignment = z.infer<typeof fileProjectAssignmentSchema>;

export const episodeScreenSchema = z.strictObject({
  rootId: id,
  name,
  role: z.enum(["primary", "overlay", "exception", "detail"]),
  width: z.number().nonnegative(),
  height: z.number().nonnegative(),
  nodeCount: z.number().int().positive(),
  componentIds: z.array(id).max(64),
  sampleTexts: z.array(z.string().max(240)).max(6),
});
export type EpisodeScreenSummary = z.infer<typeof episodeScreenSchema>;
export const episodeComponentRefSchema = z.strictObject({
  libraryId: id,
  componentId: id,
  componentName: name,
  assetTier: assetTierSchema.optional(),
  variantId: id.optional(),
  count: z.number().int().positive(),
});
export type EpisodeComponentRef = z.infer<typeof episodeComponentRefSchema>;
export const episodeDecisionSchema = z.strictObject({
  question: z.string().trim().min(1).max(240),
  choice: z.string().trim().min(1).max(400),
});
export type EpisodeDecisionRecord = z.infer<typeof episodeDecisionSchema>;

const episodeFields = {
  id,
  title: z.string().trim().min(1).max(120),
  sourceFileKey: fileKeySchema,
  sourceFileName: name,
  libraryId: id.optional(),
  libraryName: name.optional(),
  prompt: z.string().max(16000),
  summary: z.string().max(2000),
  mode: z.enum(["generate", "edit"]),
  screens: z.array(episodeScreenSchema).max(24),
  componentsUsed: z.array(episodeComponentRefSchema).max(64),
  customModules: z.array(name).max(32),
  decisions: z.array(episodeDecisionSchema).max(16),
  tags: z.array(z.string().trim().min(1).max(64)).max(32),
  createdAt: timestamp,
  pinned: z.boolean().optional(),
};
export const designEpisodeSchema = z.strictObject({
  ...episodeFields,
  scopeProjectId: scope,
  sourceDocId: id,
  sourceLifetimeToken: id.optional(),
  sourceDocumentEpoch: z.number().int().positive().optional(),
  snapshotKey: z.string().min(1).max(160).optional(),
  captureId: id.optional(),
  legacyIdentity: z.string().min(1).max(512).optional(),
  userId: id.default(DEFAULT_MEMORY_USER_ID),
  thumbnailSvg: z.string().max(48_000).optional(),
  updatedAt: timestamp,
});
export type DesignEpisode = z.infer<typeof designEpisodeSchema>;
function legacyIdentityPrefix(ep: DesignEpisode) {
  return `legacy:${ep.snapshotKey ?? ep.id}:${ep.createdAt}:`;
}
function legacyEpisodeIdentity(ep: DesignEpisode, stored?: string): string {
  if (!stored) {
    if (ep.captureId)
      return `legacy:${ep.snapshotKey ?? ep.id}:${ep.captureId}`;
    return legacyIdentityPrefix(ep) + stableHash(legacySnapshotContent(ep));
  }
  if (/^digest:[0-9a-f]{16}$/.test(stored))
    return legacyIdentityPrefix(ep) + stored.slice(7);
  return stored;
}
export function episodeIdentityKey(ep: DesignEpisode): string {
  const modern = ep.snapshotKey?.startsWith("v2:");
  const stored = !modern ? ep.legacyIdentity : undefined;
  if (stored?.startsWith("[")) return stored;
  const unbound = stored?.startsWith("unbound:");
  const capture = modern
    ? ep.captureId
      ? `${ep.snapshotKey}#${ep.captureId}`
      : `${ep.snapshotKey}@${ep.createdAt}`
    : legacyEpisodeIdentity(ep, unbound ? stored?.slice(8) : stored);
  return JSON.stringify([
    ep.sourceFileKey,
    ep.sourceDocId,
    unbound ? null : (ep.sourceLifetimeToken ?? null),
    capture,
  ]);
}
export function freezeLegacyIdentity(ep: DesignEpisode): string {
  const identity = episodeIdentityKey(ep);
  if (identity.length <= 512) return identity;
  // Long file/document keys are already stored on the row. Preserve just the
  // original lifetime binding and capture fragment for a backfill or rename.
  const fragment =
    ep.legacyIdentity ??
    (ep.captureId
      ? legacyEpisodeIdentity(ep)
      : "digest:" + stableHash(legacySnapshotContent(ep)));
  return ep.sourceLifetimeToken || fragment.startsWith("unbound:")
    ? fragment
    : "unbound:" + fragment;
}
// Keep the full legacy content for comparison: older rows have no revision
// fingerprint, and a shortened hash alone cannot prove their contents equal.
export function legacySnapshotContent(ep: DesignEpisode): string {
  return JSON.stringify([
    ep.sourceFileKey,
    ep.sourceFileName,
    ep.sourceDocId,
    ep.libraryId,
    ep.libraryName,
    ep.userId,
    ep.title,
    ep.prompt,
    ep.summary,
    ep.mode,
    ep.screens,
    ep.componentsUsed,
    ep.customModules,
    ep.decisions,
    ep.tags,
    ep.thumbnailSvg,
  ]);
}
export function deriveLegacySnapshotKey(ep: DesignEpisode): string {
  return "legacy-" + stableHash(legacySnapshotContent(ep));
}
export const recalledEpisodeSchema = z.strictObject({
  ...episodeFields,
  isCurrentFile: z.boolean(),
  explicitlyMentioned: z.boolean().optional(),
  matchScore: z.number().optional(),
  matchReasons: z.array(z.string().max(160)).max(12).optional(),
});
export type RecalledEpisodePayload = z.infer<typeof recalledEpisodeSchema>;

export interface ResolvedMemoryScope {
  scopeProjectId: string;
  projectSpaceId?: string;
  scopeLabel: string;
  isProjectSpace: boolean;
  fileKey: string;
  libraryId?: string;
  userId: string;
}
export const projectScopeId = (projectId: string) => "proj:" + projectId;
export const fileScopeId = (fileKey: string) => "file:" + fileKey;
export function resolveProjectMemoryScope(input: {
  fileKey: string;
  project?: ProjectSpace | null;
  libraryId?: string;
  userId?: string;
}): ResolvedMemoryScope {
  const { fileKey, project } = input;
  return {
    scopeProjectId: project ? projectScopeId(project.id) : fileScopeId(fileKey),
    projectSpaceId: project?.id,
    scopeLabel: project?.name ?? "未归类草稿（单稿记忆）",
    isProjectSpace: !!project,
    fileKey,
    libraryId: input.libraryId ?? project?.defaultLibraryId,
    userId: input.userId ?? DEFAULT_MEMORY_USER_ID,
  };
}

export function tokenizeMemoryText(text: string): string[] {
  const tokens = new Set<string>();
  for (const [run] of text
    .toLowerCase()
    .matchAll(/[\p{Script=Latin}\p{Nd}]+|\p{Script=Han}+/gu)) {
    if (/^\p{Script=Han}/u.test(run)) {
      const chars = Array.from(run);
      for (let i = 0; i + 1 < chars.length && tokens.size < 256; i++) {
        tokens.add(chars[i] + chars[i + 1]);
        if (i + 2 < chars.length && tokens.size < 256)
          tokens.add(chars[i] + chars[i + 1] + chars[i + 2]);
      }
    } else if (run.length >= 2 && run.length <= 64) tokens.add(run);
    if (tokens.size >= 256) break;
  }
  return [...tokens];
}

const svgNamespace = "http://www.w3.org/2000/svg";
const thumbnailElements = new Set(
  "svg title desc defs g symbol use path rect circle ellipse line polyline polygon text tspan image linearGradient radialGradient stop clipPath mask pattern filter feGaussianBlur feOffset feFlood feComposite feMerge feMergeNode feColorMatrix feBlend".split(
    " ",
  ),
);
const thumbnailAttributes = new Set(
  "id width height x y x1 x2 y1 y2 cx cy r rx ry fx fy d points viewBox preserveAspectRatio transform opacity fill fill-opacity fill-rule stroke stroke-width stroke-opacity stroke-linejoin stroke-linecap stroke-dasharray stroke-dashoffset clip-path clip-rule mask maskUnits maskContentUnits gradientUnits gradientTransform spreadMethod offset stop-color stop-opacity filter filterUnits in in2 result stdDeviation dx dy flood-color flood-opacity operator mode type values font-family font-size font-weight font-style text-anchor dominant-baseline text-decoration letter-spacing textLength lengthAdjust patternUnits patternTransform".split(
    " ",
  ),
);

export function sanitizeEpisodeThumbnailSvg(
  rawSvg: string | undefined,
): string | undefined {
  if (!rawSvg || rawSvg.length > 160_000 || /<!DOCTYPE/i.test(rawSvg)) return;
  try {
    let invalid = false;
    // The XML parser tolerates stray text outside the document element. Put
    // the input in a wrapper so leading/trailing garbage is validated too.
    const source = rawSvg.trim().replace(/^<\?xml\s[^?]*\?>/, "");
    const parsed = new DOMParser({
      errorHandler: () => {
        invalid = true;
      },
    }).parseFromString(
      "<thumbnail>" + source + "</thumbnail>",
      "image/svg+xml",
    );
    let root: Element | undefined;
    for (
      let node = parsed.documentElement.firstChild;
      node;
      node = node.nextSibling
    ) {
      if (
        node.nodeType === 8 ||
        (node.nodeType === 3 && !node.nodeValue?.trim())
      )
        continue;
      if (root || node.nodeType !== 1) return;
      root = node as Element;
    }
    if (
      invalid ||
      !root ||
      root.tagName !== "svg" ||
      (root.namespaceURI && root.namespaceURI !== svgNamespace)
    )
      return;
    const clean = parsed.implementation.createDocument(
      svgNamespace,
      "svg",
      null,
    );
    // Rebuild inert drawing primitives. Stylesheets, animation, foreign namespaces
    // and external resources never cross the local thumbnail boundary.
    function copy(element: Element, target: Element) {
      for (let i = 0; i < element.attributes.length; i++) {
        const { name: key, value } = element.attributes.item(i)!;
        if (key === "href" || key === "xlink:href") {
          const fragment = /^#[\w.-]+$/.test(value);
          const raster =
            element.tagName === "image" &&
            /^data:image\/(?:png|jpeg|gif|webp);base64,[a-z0-9+/=]{1,8192}$/i.test(
              value,
            );
          if (fragment || raster) target.setAttribute("href", value);
        } else if (thumbnailAttributes.has(key)) {
          if (/javascript\s*:|data\s*:|[\\@;]/i.test(value)) continue;
          if (
            /(?:url|var)\s*\(|\/\*/i.test(value) &&
            !/^url\(#[\w.-]+\)$/.test(value)
          )
            continue;
          target.setAttribute(key, value);
        }
      }
      for (let child = element.firstChild; child; child = child.nextSibling) {
        if (child.nodeType === 3 || child.nodeType === 4) {
          target.appendChild(clean.createTextNode(child.nodeValue ?? ""));
        } else if (child.nodeType === 1) {
          const el = child as Element;
          if (
            !thumbnailElements.has(el.tagName) ||
            (el.namespaceURI && el.namespaceURI !== svgNamespace)
          )
            continue;
          const next = clean.createElementNS(svgNamespace, el.tagName);
          copy(el, next);
          target.appendChild(next);
        }
      }
    }
    copy(root, clean.documentElement);
    const svg = new XMLSerializer().serializeToString(clean.documentElement);
    if (svg.length <= 48_000 && new TextEncoder().encode(svg).length <= 48_000)
      return svg;
  } catch {
    // A damaged or excessively deep image must not prevent archiving the design.
  }
}

interface RecallOptions {
  currentFileKey: string;
  explicitlyMentioned?: boolean;
  matchScore?: number;
  matchReasons?: string[];
}
export function toRecalledEpisodePayload(
  episode: DesignEpisode,
  options: RecallOptions,
): RecalledEpisodePayload {
  const {
    thumbnailSvg: _svg,
    scopeProjectId: _scope,
    sourceDocId: _doc,
    sourceLifetimeToken: _lifetime,
    sourceDocumentEpoch: _epoch,
    snapshotKey: _snapshot,
    captureId: _capture,
    legacyIdentity: _legacyIdentity,
    userId: _user,
    updatedAt: _updated,
    ...shared
  } = episode;
  const { currentFileKey, ...match } = options;
  return recalledEpisodeSchema.parse({
    ...shared,
    ...match,
    isCurrentFile: episode.sourceFileKey === currentFileKey,
  });
}

export function rankProjectEpisodes(options: {
  episodes: DesignEpisode[];
  prompt: string;
  currentFileKey: string;
  targetLibraryId?: string | null;
  explicitEpisodeIds?: string[];
  limit?: number;
  now?: number;
}): RecalledEpisodePayload[] {
  const limit = Math.max(1, Math.min(8, Math.trunc(options.limit ?? 5) || 1));
  const now = options.now ?? Date.now();
  const query = new Set(tokenizeMemoryText(options.prompt));
  const explicitIds = [...new Set(options.explicitEpisodeIds)];
  const ranked = options.episodes.map((episode) => {
    const explicit = explicitIds.indexOf(episode.id);
    const reasons: string[] = explicit < 0 ? [] : ["显式引用"];
    let score = 0;
    if (options.targetLibraryId && episode.libraryId) {
      if (options.targetLibraryId === episode.libraryId) {
        score += 30;
        reasons.push("同组件库");
      } else score -= 10;
    }
    const affinity = score;
    if (episode.sourceFileKey === options.currentFileKey) {
      score += 12;
      reasons.push("当前设计稿");
    } else reasons.push("同项目跨稿");
    const matched = new Set<string>();
    const fields: [number, string[]][] = [
      [3, [episode.title]],
      [
        2.2,
        [
          ...episode.tags,
          ...episode.customModules,
          ...episode.componentsUsed.map((c) => c.componentName),
        ],
      ],
      [1.8, [...episode.screens.map((s) => s.name), episode.summary]],
      [1, [episode.prompt, ...episode.screens.flatMap((s) => s.sampleTexts)]],
    ];
    for (const [weight, values] of fields) {
      if (!query.size) break;
      const hits = new Set<string>();
      for (const value of values)
        for (const token of tokenizeMemoryText(value))
          if (query.has(token)) hits.add(token);
      score += hits.size * weight;
      for (const term of hits) matched.add(term);
    }
    if (matched.size)
      reasons.push(
        "关键词：" + [...matched].slice(0, 3).join("、").slice(0, 150),
      );
    if (episode.pinned) {
      score += 8;
      reasons.push("已置顶");
    }
    const created = Date.parse(episode.createdAt);
    score +=
      6 * Math.max(0, Math.min(1, 1 - (now - created) / (30 * 86400000)));
    return {
      episode,
      explicit,
      matched: matched.size > 0,
      score,
      reasons,
      created,
      affinity,
    };
  });
  ranked.sort(
    (a, b) =>
      (a.explicit < 0 ? explicitIds.length : a.explicit) -
        (b.explicit < 0 ? explicitIds.length : b.explicit) ||
      Number(b.matched) - Number(a.matched) ||
      (!a.matched && !b.matched
        ? b.affinity - a.affinity ||
          Number(!!b.episode.pinned) - Number(!!a.episode.pinned) ||
          b.created - a.created
        : 0) ||
      b.score - a.score ||
      b.created - a.created ||
      a.episode.id.localeCompare(b.episode.id),
  );
  const result: RecalledEpisodePayload[] = [];
  let baseline = 0;
  for (const { episode, explicit, matched, score, reasons } of ranked) {
    if (result.length >= 8 || (explicit < 0 && result.length >= limit)) break;
    if (explicit < 0 && !matched && ++baseline > 2) break;
    result.push(
      toRecalledEpisodePayload(episode, {
        currentFileKey: options.currentFileKey,
        explicitlyMentioned: explicit >= 0 || undefined,
        matchScore: score,
        matchReasons: reasons,
      }),
    );
  }
  return result;
}

interface ArchiveInput {
  scopeProjectId: string;
  sourceFileKey: string;
  sourceLifetimeToken?: string;
  sourceDocumentEpoch?: number;
  libraryId?: string;
  userId?: string;
  prompt: string;
  summary?: string;
  mode?: DesignEpisode["mode"];
  decisions?: EpisodeDecisionRecord[];
  customModules?: string[];
  screenRoles?: Record<string, EpisodeScreenSummary["role"]>;
}
type ArchiveStamp = Pick<DesignEpisode, "id" | "createdAt">;
// Documents have revisions but no wall clock. Unstamped snapshots get a stable
// identity here and their actual archive time on the first repository commit.
export const UNSAVED_EPISODE_TIMESTAMP = "1970-01-01T00:00:00.000Z";
const excerpt = (text: string, length: number) =>
  text.trim().replace(/\s+/g, " ").slice(0, length);

function indexedSnapshot(doc: DesignDocument) {
  if (isPublished(doc)) return doc;
  const snapshot = { ...doc };
  indexPublishedScene(snapshot);
  return snapshot;
}

type PreviewStyle = DesignNode["style"];
type PreviewGradient = NonNullable<PreviewStyle["gradient"]>;

function previewPaint(
  gradient: PreviewGradient | undefined,
  color: string,
  opacity = 1,
) {
  if (gradient?.type === "angular" || gradient?.type === "diamond") {
    const stop = gradient.stops[0];
    return {
      color: stop.color,
      opacity: opacity * stop.opacity,
      gradient: undefined,
    };
  }
  return {
    color,
    opacity,
    gradient: gradient && { ...gradient, stops: gradient.stops.slice(0, 6) },
  };
}

function previewStyle(style: PreviewStyle) {
  const fill = previewPaint(style.gradient, style.fill, style.fillOpacity);
  const layers = (paints: PreviewStyle["paints"]) =>
    paints?.slice(0, 2).map((paint) => ({
      ...paint,
      ...previewPaint(paint.gradient, paint.color, paint.opacity),
    }));
  return {
    ...style,
    fill: fill.color,
    fillOpacity: fill.opacity,
    gradient: fill.gradient,
    paints: layers(style.paints),
    strokePaints: layers(style.strokePaints),
    shadows: style.shadows?.slice(0, 2).map((shadow) => ({
      ...shadow,
      ...previewPaint(shadow.gradient, shadow.color, shadow.opacity),
    })),
  };
}

function previewPrimitiveCount(node: DesignNode) {
  const { gradient, paints, strokePaints, shadows } = node.style;
  return (
    2 +
    (gradient?.stops.length ?? 0) +
    (node.vector?.paths.length ?? 0) +
    [...(paints ?? []), ...(strokePaints ?? [])].reduce(
      (n, p) => n + 2 + (p.gradient?.stops.length ?? 0),
      0,
    ) +
    (shadows?.length ?? 0) * 10 +
    (node.text ? node.text.split("\n").length : 0)
  );
}

// Parsing a saved document can reorder object properties. Arrays carry paint,
// layer and text-run order and must retain their original ordering.
function snapshotHash(value: unknown) {
  return stableHash(
    JSON.stringify(value, (_key, item: unknown) =>
      item && typeof item === "object" && !Array.isArray(item)
        ? Object.fromEntries(
            Object.entries(item).sort(([a], [b]) =>
              a < b ? -1 : a > b ? 1 : 0,
            ),
          )
        : item,
    ),
  );
}

function instanceComponent(doc: DesignDocument, node: DesignNode) {
  const instance = node.instance;
  return (
    instance &&
    doc.libraries?.[instance.libraryId]?.components.find(
      (component) => component.id === instance.componentId,
    )
  );
}

function caseFoldFontName(name: string): string {
  return name
    .normalize("NFC")
    .toLowerCase()
    .toUpperCase()
    .toLowerCase()
    .normalize("NFC");
}

// Keyword recognition applies to decoded identifiers. A quoted keyword names a face.
const fontFamilyKeyword =
  /^(?:serif|sans-serif|monospace|cursive|fantasy|system-ui|ui-serif|ui-sans-serif|ui-monospace|ui-rounded|emoji|math|fangsong)$/i;
const reservedFamilyIdent =
  /^(?:inherit|initial|unset|revert|revert-layer|default)$/i;

function parseCssFontFamilies(value: string): string[] {
  const families: string[] = [];
  // CSS input preprocessing makes CRLF one newline, including after a hex escape.
  const input = value
    .replace(/\r\n?|\f/g, "\n")
    .replace(/[\0\uD800-\uDFFF]/gu, "\uFFFD");
  const hexEscape = /[0-9a-fA-F]{1,6}[ \t\n]?/y;
  const identStart = /--|-?(?:[a-zA-Z_\u0080-\u{10ffff}]|\\(?!\n))/uy;
  const identChars = /[\w\u0080-\u{10ffff}-]+/uy;
  let i = 0;
  function readEscape(quoted: boolean): string {
    hexEscape.lastIndex = ++i;
    const hex = hexEscape.exec(input);
    if (hex) {
      i = hexEscape.lastIndex;
      const point = parseInt(hex[0], 16);
      return point === 0 ||
        point > 0x10ffff ||
        (point >= 0xd800 && point <= 0xdfff)
        ? "\uFFFD"
        : String.fromCodePoint(point);
    }
    if (i === input.length) return quoted ? "" : "\uFFFD";
    const ch = input[i++];
    return ch === "\n" ? "" : ch;
  }

  let tokens: string[] = [];
  let quoted = false;
  function finishFamily() {
    if (
      !tokens.length ||
      (quoted && tokens.length !== 1) ||
      (!quoted && tokens.some((token) => reservedFamilyIdent.test(token)))
    )
      return false;
    const name = tokens.join(" ");
    if (quoted || !fontFamilyKeyword.test(name))
      families.push(caseFoldFontName(name));
    tokens = [];
    quoted = false;
    return true;
  }
  while (i < input.length) {
    const ch = input[i];
    if (ch === ",") {
      if (!finishFamily()) return [];
      i++;
    } else if (input.startsWith("/*", i)) {
      const end = input.indexOf("*/", i + 2);
      i = end === -1 ? input.length : end + 2;
    } else if (/[ \t\n]/.test(ch)) {
      i++;
    } else if (ch === '"' || ch === "'") {
      quoted = true;
      i++;
      let token = "";
      while (i < input.length && input[i] !== ch && input[i] !== "\n")
        token += input[i] === "\\" ? readEscape(true) : input[i++];
      if (input[i] === ch) i++;
      else if (input[i] === "\n") return [];
      tokens.push(token);
    } else {
      identStart.lastIndex = i;
      if (!identStart.test(input)) return [];
      let token = "";
      for (;;) {
        identChars.lastIndex = i;
        const chars = identChars.exec(input);
        if (chars) {
          token += chars[0];
          i = identChars.lastIndex;
        } else if (input[i] === "\\" && input[i + 1] !== "\n") {
          token += readEscape(false);
        } else break;
      }
      tokens.push(token);
    }
  }
  return finishFamily() ? families : [];
}

// With no mode selection, the archive identity includes every alias branch.
function collectVariableDependencies(
  system: DesignSystem,
  ids: Set<string>,
  modes?: Record<string, string>,
  addFamily?: (family: string) => void,
) {
  for (const id of ids) {
    const token = system.variables[id];
    if (!token) continue;
    const collection = system.collections[token.collectionId];
    if (modes && !collection) continue;
    const values = modes
      ? [token.values[modes[collection.id] ?? collection.defaultModeId]]
      : Object.values(token.values);
    for (const value of values) {
      if (typeof value === "object" && value) ids.add(value.alias);
      else if (typeof value === "string") addFamily?.(value);
    }
  }
}

function fingerprintAssets(doc: DesignDocument) {
  const { images, fonts } = doc;
  const digests = new Map<object, string>();
  // One placed image or component may supply hundreds of nodes on the same board.
  function hash(asset?: object) {
    if (!asset) return null;
    const cached = digests.get(asset);
    if (cached) return cached;
    const digest = snapshotHash(asset);
    digests.set(asset, digest);
    return digest;
  }
  const fontEntries = Object.entries(fonts ?? {})
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, { data, ...face }]) => {
      let digest: string | undefined;
      return {
        id: caseFoldFontName(key),
        family: caseFoldFontName(face.name),
        entry: () => [
          key,
          (digest ??= snapshotHash({ ...face, data: stableHash(data) })),
        ],
      };
    });
  function referencedFonts(
    node: DesignNode,
    resolved: DesignNode,
    resources: ReturnType<typeof boundDesignResources>,
    activeModes?: Record<string, string>,
  ) {
    if (!fontEntries.length) return null;
    const names = new Set<string>();
    const add = (family?: string) => {
      if (family)
        for (const token of parseCssFontFamilies(family)) names.add(token);
    };
    for (const source of activeModes || node === resolved
      ? [resolved]
      : [node, resolved]) {
      add(source.style.fontFamily);
      for (const run of source.textRuns ?? []) add(run.style.fontFamily);
    }
    const familyIds = new Set<string>();
    if (node.variableBindings?.fontFamily)
      familyIds.add(node.variableBindings.fontFamily);
    for (const [, style] of resources?.styles ?? []) {
      if (!activeModes && style?.kind === "text")
        add(style.properties.fontFamily);
      if (
        style?.bindings.fontFamily &&
        (!activeModes || !overridesStyleBinding(node, "fontFamily"))
      )
        familyIds.add(style.bindings.fontFamily);
    }
    if (doc.designSystem)
      collectVariableDependencies(
        doc.designSystem,
        familyIds,
        activeModes,
        add,
      );
    const used = fontEntries.filter(
      ({ id, family }) => names.has(id) || names.has(family),
    );
    return used.length ? used.map((font) => font.entry()) : null;
  }
  // Hash each asset once, sharing the digest between node matching and capture identity.
  const fontDigest = () =>
    fontEntries.length
      ? snapshotHash(fontEntries.map((font) => font.entry()))
      : undefined;
  return { images, referencedFonts, fontDigest, hash };
}

function overridesStyleBinding(node: DesignNode, property: string) {
  return (
    node.styleOverrides?.includes(property) ||
    Object.hasOwn(node.variableBindings ?? {}, property)
  );
}

function boundDesignResources(
  doc: DesignDocument,
  node: DesignNode,
  resolved: DesignNode,
  activeModes?: Record<string, string>,
) {
  const system = doc.designSystem;
  if (!system) return;
  const variables = new Set(Object.values(node.variableBindings ?? {}));
  for (const { id } of paintVariables(
    activeModes ? resolved.style : node.style,
  ))
    variables.add(id);
  const styleIds = new Set<string>();
  for (const [slot, id] of Object.entries(node.styleBindings ?? {})) {
    styleIds.add(id);
    const style = system.styles[id];
    if (!style) continue;
    const bindings = activeModes
      ? styleForSlot(style, slot).bindings
      : style.bindings;
    for (const [key, variable] of Object.entries(bindings))
      if (!activeModes || !overridesStyleBinding(node, key))
        variables.add(variable);
    if (!activeModes)
      for (const paint of paintVariables(style.properties))
        variables.add(paint.id);
  }
  collectVariableDependencies(system, variables, activeModes);
  if (variables.size || styleIds.size)
    return {
      styles: [...styleIds]
        .sort()
        .map((id) => [id, system.styles[id] ?? null] as const),
      variables: [...variables].sort().map((id) => {
        const variable = system.variables[id];
        return [
          id,
          variable ?? null,
          variable ? (system.collections[variable.collectionId] ?? null) : null,
        ] as const;
      }),
    };
}

function nodeEffectiveFingerprint(
  doc: DesignDocument,
  node: DesignNode,
  byId: ReadonlyMap<string, DesignNode>,
  assets: ReturnType<typeof fingerprintAssets>,
  activeOnly = false,
): string {
  let resolved = node;
  try {
    resolved = resolveNode(doc, node, byId);
  } catch {
    // Broken bindings still have a raw node to archive.
  }
  const modes = doc.designSystem ? effectiveModes(doc, node, byId) : {};
  const activeModes = activeOnly ? modes : undefined;
  const resources = boundDesignResources(doc, node, resolved, activeModes);
  const collections = new Set<string>();
  // Mode IDs belong to the full archive. The visual pass compares their resolved values.
  if (!activeOnly)
    for (const [, variable] of resources?.variables ?? [])
      if (variable) collections.add(variable.collectionId);
  const resolvedFillToken = resolved.fillToken
    ? doc.tokens?.[resolved.fillToken]
    : undefined;
  return snapshotHash({
    node: activeOnly ? undefined : node,
    resolved:
      activeOnly && resolved.variableModes
        ? { ...resolved, variableModes: undefined }
        : resolved,
    modes: collections.size
      ? [...collections]
          .sort()
          .map((id) => [
            id,
            modes[id] ??
              doc.designSystem?.collections[id]?.defaultModeId ??
              null,
          ])
      : null,
    rawFillToken:
      !activeOnly && node.fillToken
        ? (doc.tokens?.[node.fillToken] ?? null)
        : null,
    resolvedFillToken: activeOnly
      ? (resolvedFillToken?.value ?? null)
      : resolved.fillToken !== node.fillToken
        ? (resolvedFillToken ?? null)
        : null,
    imageAsset: resolved.image?.assetId
      ? assets.hash(assets.images?.[resolved.image.assetId])
      : null,
    instanceComponent: assets.hash(instanceComponent(doc, node)),
    fontAsset: assets.referencedFonts(node, resolved, resources, activeModes),
    designResources: activeOnly ? undefined : resources,
    colorProfile: doc.colorProfile ?? null,
  });
}

function archiveThumbnail(
  doc: DesignDocument,
  primaryRoot: DesignNode,
  primary: EpisodeScreenSummary,
  byId: ReadonlyMap<string, DesignNode>,
) {
  if (primaryRoot.type === "slice" || primary.nodeCount > 400) return;
  try {
    const rawNodes = [primaryRoot];
    for (let i = 0; i < rawNodes.length; i++)
      rawNodes.push(...childrenOf(doc, rawNodes[i].id));
    let previewChars = 0;
    let placedImageBytes = 0;
    const MAX_PLACED_IMAGE_BYTES = 14_000;
    const images: NonNullable<DesignDocument["images"]> = {};
    const preview: DesignDocument = {
      ...doc,
      designSystem: undefined,
      nodes: rawNodes.map((source, index) => {
        const node = resolveNode(doc, source, byId);
        const text = node.text
          .slice(0, 240)
          .split(/\r\n?|\n/, 6)
          .join("\n");
        const pathChars =
          node.vector?.paths.reduce((n, path) => n + path.d.length, 0) ?? 0;
        previewChars += text.length + (pathChars <= 4000 ? pathChars : 0);
        const style = previewStyle(node.style);
        let image = node.image;
        if (image) {
          const asset = doc.images?.[image.assetId];
          if (
            !asset ||
            asset.data.length > 8_000 ||
            placedImageBytes + asset.data.length > MAX_PLACED_IMAGE_BYTES
          ) {
            image = undefined;
            if (
              !style.fill ||
              style.fill === "none" ||
              style.fill === "transparent"
            )
              style.fill = "#e5e7eb";
          } else {
            placedImageBytes += asset.data.length;
            images[image.assetId] = asset;
          }
        }
        return {
          ...node,
          image,
          parentId: index === 0 ? null : node.parentId,
          style:
            index === 0
              ? { ...style, width: primary.width, height: primary.height }
              : style,
          text,
          textRuns: undefined,
          sourceTextShape: undefined,
          sourceTextLayout: undefined,
          vector: pathChars <= 4000 ? node.vector : undefined,
        };
      }),
      pages: undefined,
      libraries: undefined,
      fonts: undefined,
      images,
    };
    const primitives = () =>
      preview.nodes.reduce((sum, node) => sum + previewPrimitiveCount(node), 0);
    // Flatten layered decoration on dense boards before the SVG renderer expands it.
    if (primitives() > 220) {
      for (const node of preview.nodes) {
        const top = node.style.paints?.find((paint) => paint.visible);
        node.style.fill =
          top?.gradient?.stops[0].color ??
          top?.color ??
          node.style.gradient?.stops[0].color ??
          node.style.fill;
        node.style.gradient = undefined;
        node.style.paints = undefined;
        node.style.strokePaints = undefined;
        node.style.shadows = undefined;
      }
    }
    if (previewChars <= 24_000 && primitives() <= 440)
      return sanitizeEpisodeThumbnailSvg(
        exportNodeToSvg(preview, primary.rootId),
      );
  } catch {
    /* Metadata remains usable when a preview cannot be rendered. */
  }
}

type ArchiveScene = {
  doc: DesignDocument;
  roots: DesignNode[];
  previousIds: Set<string>;
};

function archiveRoots(
  scenes: ArchiveScene[],
  input: ArchiveInput,
  stamp: ArchiveStamp | undefined,
  manualTitle?: string,
  extraFingerprint?: unknown,
): DesignEpisode {
  const refs = new Map<string, EpisodeComponentRef>();
  const modules = new Set(
    (input.customModules ?? []).map((s) => excerpt(s, 200)).filter(Boolean),
  );
  const doc = scenes[0].doc;
  const assets = fingerprintAssets(doc);
  const boardNodeHashes: string[] = [];
  const boards: Array<{
    doc: DesignDocument;
    root: DesignNode;
    screen: EpisodeScreenSummary;
    byId: ReadonlyMap<string, DesignNode>;
  }> = [];
  for (const { doc, roots, previousIds } of scenes) {
    if (!roots.length) continue;
    const bounds = layoutBounds(doc);
    const byId = new Map(doc.nodes.map((n) => [n.id, n]));
    for (const root of roots) {
      const componentIds = new Set<string>();
      const texts = new Set<string>();
      const queue = [
        {
          node: root,
          inInstance: ancestors(doc, root.id).some((p) => !!p.instance),
        },
      ];
      for (let i = 0; i < queue.length; i++) {
        const { node, inInstance } = queue[i];
        boardNodeHashes.push(nodeEffectiveFingerprint(doc, node, byId, assets));
        const children = childrenOf(doc, node.id);
        for (const child of children)
          queue.push({
            node: child,
            inInstance: inInstance || !!node.instance,
          });
        if (boards.length >= 24) continue;
        if (node.instance) {
          const { libraryId, componentId, variantId } = node.instance;
          componentIds.add(componentId);
          const key = JSON.stringify([libraryId, componentId, variantId]);
          const ref = refs.get(key);
          if (ref) ref.count++;
          else {
            const library = doc.libraries?.[libraryId];
            const component = instanceComponent(doc, node);
            refs.set(key, {
              libraryId,
              componentId,
              componentName:
                component?.name || excerpt(node.name, 200) || componentId,
              variantId,
              assetTier: component && classifyComponentTier(component, library),
              count: 1,
            });
          }
        } else if (
          !inInstance &&
          node.id !== root.id &&
          node.type === "frame" &&
          children.length &&
          !previousIds.has(node.id) &&
          node.name.trim()
        ) {
          modules.add(excerpt(node.name, 200));
        }
        if (texts.size < 6 && node.text.trim())
          texts.add(excerpt(node.text, 240));
      }
      if (boards.length >= 24) continue;
      const box = bounds.get(root.id) ?? root.style;
      boards.push({
        doc,
        root,
        byId,
        screen: {
          rootId: root.id,
          name: excerpt(root.name, 200) || "未命名图层",
          role:
            input.screenRoles && Object.hasOwn(input.screenRoles, root.id)
              ? input.screenRoles[root.id]
              : "primary",
          width: box.width,
          height: box.height,
          nodeCount: queue.length,
          componentIds: [...componentIds].slice(0, 64),
          sampleTexts: [...texts],
        },
      });
    }
  }
  const screens = boards.map(({ screen }) => screen);
  const primaryBoard =
    boards.find(({ screen }) => screen.role === "primary") ?? boards[0];
  const thumbnailSvg =
    primaryBoard &&
    archiveThumbnail(
      primaryBoard.doc,
      primaryBoard.root,
      primaryBoard.screen,
      primaryBoard.byId,
    );
  const title = excerpt(
    manualTitle?.trim() ||
      input.prompt.trim() ||
      primaryBoard?.screen.name ||
      doc.name,
    80,
  );
  const customModules = [...modules].slice(0, 32);
  const componentsUsed = [...refs.values()].slice(0, 64);
  const namedTags = [
    ...screens.map((s) => s.name),
    ...customModules,
    ...componentsUsed.map((c) => c.componentName),
  ];
  const tags = [
    ...new Set([
      ...namedTags.map((s) => excerpt(s, 64)),
      ...tokenizeMemoryText(title + " " + input.prompt),
    ]),
  ].slice(0, 32);
  const details = {
    scopeProjectId: input.scopeProjectId,
    sourceFileKey: input.sourceFileKey,
    sourceFileName: doc.name,
    sourceDocId: doc.id,
    libraryId: input.libraryId,
    libraryName: input.libraryId && doc.libraries?.[input.libraryId]?.name,
    userId: input.userId ?? DEFAULT_MEMORY_USER_ID,
    title,
    prompt: input.prompt.slice(0, 16000),
    summary: (
      input.summary?.trim() ||
      (screens.length ? screens.map((s) => s.name).join("、") : title)
    ).slice(0, 2000),
    mode: input.mode ?? "generate",
    screens,
    componentsUsed,
    customModules,
    decisions: input.decisions ?? [],
    tags,
  };
  const { scopeProjectId: _scope, ...fingerprint } = details;
  const fontDigest = assets.fontDigest();
  const modernFingerprint = snapshotHash([
    doc.revision,
    fingerprint,
    stableHash(boardNodeHashes.join("")),
    thumbnailSvg && stableHash(thumbnailSvg),
    ...(fontDigest ? [fontDigest] : []),
    ...(extraFingerprint !== undefined ? [extraFingerprint] : []),
  ]);
  // Preserve historical display IDs independently of the capture fingerprint.
  const historicalId =
    "ep-snapshot-" +
    stableHash(
      JSON.stringify([
        doc.revision,
        { ...details, scopeProjectId: fileScopeId(input.sourceFileKey) },
      ]),
    );
  const createdAt = stamp?.createdAt ?? UNSAVED_EPISODE_TIMESTAMP;
  return designEpisodeSchema.parse({
    ...details,
    sourceLifetimeToken: input.sourceLifetimeToken,
    ...(input.sourceDocumentEpoch !== undefined && {
      sourceDocumentEpoch: input.sourceDocumentEpoch,
    }),
    snapshotKey: `v2:${modernFingerprint}`,
    id: stamp?.id ?? historicalId,
    createdAt,
    updatedAt: createdAt,
    thumbnailSvg,
  });
}

function sceneFrameIds(doc: DesignDocument) {
  const byId = new Map(doc.nodes.map((n) => [n.id, n]));
  return new Set(
    doc.nodes.filter((n) => isSceneFrame(n, byId)).map((n) => n.id),
  );
}

function expandSectionRoots(
  doc: DesignDocument,
  roots: DesignNode[],
  frames: Set<string>,
) {
  const ids = new Set(roots.map((n) => n.id));
  const sections = new Set(
    roots.filter((n) => n.type === "section").map((n) => n.id),
  );
  if (sections.size) {
    for (const frame of frames) {
      for (const parent of ancestors(doc, frame)) {
        if (sections.has(parent.id)) {
          ids.delete(parent.id);
          ids.add(frame);
        }
      }
    }
  }
  return doc.nodes.filter((n) => ids.has(n.id));
}

// A descendant edit belongs to its scene frame, even under nested sections.
function changedRoots(
  before: DesignDocument,
  after: DesignDocument,
  frames: Set<string>,
  activeOnly: boolean,
) {
  const beforeById = new Map(before.nodes.map((n) => [n.id, n]));
  const afterById = new Map(after.nodes.map((n) => [n.id, n]));
  const beforeAssets = fingerprintAssets(before);
  const afterAssets = fingerprintAssets(after);
  const roots = new Set<string>();
  function mark(node: DesignNode) {
    const lineage = [node, ...ancestors(after, node.id)];
    const frame = lineage.find((n) => frames.has(n.id));
    const root =
      frame ??
      (lineage.every((n) => n.type === "section")
        ? node
        : lineage[lineage.length - 1]);
    roots.add(root.id);
  }
  function markReordered(
    parentId: string | null,
    next: DesignNode[],
    previous: DesignNode[],
  ) {
    const shared = next.filter(
      (n) => beforeById.get(n.id)?.parentId === parentId,
    );
    const sharedIds = new Set(shared.map((n) => n.id));
    const oldOrder = previous.filter((n) => sharedIds.has(n.id));
    shared.forEach((n, i) => {
      if (n.id !== oldOrder[i].id) mark(n);
    });
  }
  for (const n of after.nodes) {
    const prev = beforeById.get(n.id);
    if (
      !prev ||
      nodeEffectiveFingerprint(
        before,
        prev,
        beforeById,
        beforeAssets,
        activeOnly,
      ) !==
        nodeEffectiveFingerprint(after, n, afterById, afterAssets, activeOnly)
    ) {
      mark(n);
      continue;
    }
    const a = childrenOf(after, n.id),
      b = childrenOf(before, n.id);
    if (a.length === b.length && a.every((child, i) => child.id === b[i].id))
      continue;
    if (n.type === "section" && a.length) {
      // New children are visited individually. Reordering boards only affects
      // the siblings whose relative position changed.
      markReordered(n.id, a, b);
      const remaining = new Set(a.map((child) => child.id));
      if (
        b.some(
          (child) =>
            !remaining.has(child.id) &&
            child.type !== "frame" &&
            child.type !== "section",
        )
      )
        mark(n);
    } else mark(n);
  }
  markReordered(null, childrenOf(after, null), childrenOf(before, null));
  return after.nodes.filter((n) => roots.has(n.id));
}

export function buildEpisodeFromAppliedProposal(
  input: ArchiveInput & {
    beforeDoc: DesignDocument;
    afterDoc: DesignDocument;
    createdRootIds: string[];
  },
  stamp?: ArchiveStamp,
): DesignEpisode {
  const { createdRootIds } = input;
  const beforeDoc = indexedSnapshot(input.beforeDoc);
  const afterDoc = indexedSnapshot(input.afterDoc);
  const pages = pageList(afterDoc);
  const activePage = afterDoc.activePage ?? pages[0].id;
  const beforePages = pageList(beforeDoc);
  const pageIds = [
    activePage,
    ...pages.map((page) => page.id).filter((id) => id !== activePage),
  ];
  const comparisons = pageIds.map((id) => {
    const after = indexedSnapshot(openPage(afterDoc, id));
    const before = beforePages.some((page) => page.id === id)
      ? indexedSnapshot(openPage(beforeDoc, id))
      : indexedSnapshot({ ...beforeDoc, nodes: [] });
    return { after, before, frames: sceneFrameIds(after) };
  });
  function collectScenes(activeOnly: boolean): ArchiveScene[] {
    return comparisons.map(({ after, before, frames }) => ({
      doc: after,
      roots: expandSectionRoots(
        after,
        [
          ...selectionRoots(after, createdRootIds),
          ...changedRoots(before, after, frames, activeOnly),
        ],
        frames,
      ),
      previousIds: new Set(before.nodes.map((node) => node.id)),
    }));
  }
  let scenes = collectScenes(true);
  if (scenes.every((scene) => !scene.roots.length))
    scenes = collectScenes(false);
  const removedNodes = scenes.every((scene) => !scene.roots.length)
    ? comparisons.map(({ before, after }) => {
        const afterIds = new Set(after.nodes.map((node) => node.id));
        return before.nodes
          .filter((node) => !afterIds.has(node.id))
          .map((node) => node.id);
      })
    : undefined;
  return archiveRoots(
    scenes,
    {
      ...input,
      mode: input.mode ?? (createdRootIds.length ? "generate" : "edit"),
    },
    stamp,
    undefined,
    removedNodes?.some((ids) => ids.length) ? removedNodes : undefined,
  );
}

export function buildManualEpisodeFromSelection(
  input: {
    document: DesignDocument;
    selectionIds: string[];
    scopeProjectId: string;
    sourceFileKey: string;
    sourceLifetimeToken?: string;
    sourceDocumentEpoch?: number;
    title?: string;
    prompt?: string;
    summary?: string;
    libraryId?: string;
    userId?: string;
  },
  stamp?: ArchiveStamp,
): DesignEpisode {
  const doc = indexedSnapshot(input.document);
  const frames = sceneFrameIds(doc);
  let roots = selectionRoots(doc, input.selectionIds);
  if (input.selectionIds.length) {
    if (!roots.length)
      throw new Error("当前选区尚未提交或已不存在，请重新选择后再归档");
    roots = selectionRoots(
      doc,
      roots.map((n) =>
        n.type === "frame" || n.type === "slice"
          ? n.id
          : (ancestors(doc, n.id)
              .filter((p) => p.type === "frame")
              .at(-1)?.id ?? n.id),
      ),
    );
  } else {
    roots = frames.size
      ? doc.nodes.filter((n) => frames.has(n.id))
      : childrenOf(doc, null);
  }
  roots = expandSectionRoots(doc, roots, frames);
  if (!roots.length) throw new Error("当前页面暂无可归档的画板或图层");
  return archiveRoots(
    [{ doc, roots, previousIds: new Set() }],
    { ...input, prompt: input.prompt ?? "", mode: "edit" },
    stamp,
    input.title,
  );
}

export function formatEpisodePromptSection(
  episodes: RecalledEpisodePayload[],
  scopeLabel?: string,
): string {
  if (!episodes.length) return "";
  const heading =
    "## 项目历史需求记忆（L2）" +
    (scopeLabel ? " · " + excerpt(scopeLabel, 120) : "");
  const rows = episodes.slice(0, 8).map((ep) => {
    const source =
      (ep.isCurrentFile ? "当前稿" : "跨稿") +
      "《" +
      excerpt(ep.sourceFileName, 100) +
      "》";
    const lines = [
      "- " +
        excerpt(ep.title, 120) +
        "（" +
        [
          source,
          ep.libraryName ?? ep.libraryId,
          ep.explicitlyMentioned && "显式引用",
        ]
          .filter(Boolean)
          .join(" · ") +
        "，ID " +
        ep.id +
        "）",
    ];
    const details = [
      ["需求", excerpt(ep.prompt, 160)],
      ["摘要", excerpt(ep.summary, 240)],
      [
        "画板",
        ep.screens
          .slice(0, 5)
          .map((s) => s.name + " " + s.width + "×" + s.height)
          .join("、"),
      ],
      [
        "复用组件",
        ep.componentsUsed
          .slice(0, 6)
          .map((c) => c.componentName + " ×" + c.count)
          .join("、"),
      ],
      ["自建模块", ep.customModules.slice(0, 6).join("、")],
      [
        "已确认决策",
        ep.decisions
          .slice(0, 6)
          .map((d) => d.question + " → " + d.choice)
          .join("；"),
      ],
    ];
    for (const [label, value] of details)
      if (value) lines.push("  " + label + "：" + excerpt(value, 320));
    return lines.join("\n");
  });
  return [heading, ...rows].join("\n");
}
