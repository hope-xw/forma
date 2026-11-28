import { parseFontFamilies } from "../../electron/system-fonts.mjs";
import svgpath from "svgpath";
import { decodeBase64, assetByteLength } from "../domain/asset-bytes";
import type { DesignDocument, NodeStyle } from "../domain/document";
import { currentTextLayout } from "../domain/text-shape";
import { layoutBounds } from "../domain/geometry";
import { resolveNode } from "../domain/design-system";
import type { FontAsset } from "../domain/fonts";
import { findLayer } from "../domain/scene-index";
import {
  normalizedGlyphPath,
  requireOutlineText,
  outlineLineBreak,
  createOutlinedVectorFromTextOperations,
  outlineTextFromShapeOperations,
} from "../domain/vector-outline";
import { readContours, vectorBounds } from "../domain/vector-path";
import {
  normalizeFontBytes,
  listTtcFaces,
  extractTtcFace,
  readFontFileBytes,
} from "./font-import";

type HarfBuzz = typeof import("harfbuzzjs");
type Buffer = InstanceType<HarfBuzz["Buffer"]>;
type Font = InstanceType<HarfBuzz["Font"]>;
type Candidate = {
  font: Font;
  unit: number;
  features: ReturnType<typeof configureFont>;
  paths: Map<number, string>;
};
type Glyph = ReturnType<Buffer["getGlyphInfosAndPositions"]>[number] & {
  candidate: Candidate;
};
type Row = { text: string; glyphs: Glyph[]; advance: number; wrapped: boolean };

function embeddedFont(doc: DesignDocument, style: NodeStyle, family: string) {
  const fonts = doc.fonts ?? {};
  if (fonts[family]?.data) return fonts[family];
  const weight = style.fontWeight ?? 400;
  function weightDistance(asset: FontAsset) {
    const axis = asset.axes.find((axis) => axis.tag === "wght");
    return axis
      ? Math.max(axis.min - weight, weight - axis.max, 0)
      : Math.abs(weight - (asset.weight ?? 400));
  }
  const italic = style.fontStyle === "italic";
  return Object.values(fonts)
    .filter((f) => f.data && f.name.toLowerCase() === family)
    .sort(
      (a, b) =>
        Number(!!a.italic !== italic) - Number(!!b.italic !== italic) ||
        weightDistance(a) - weightDistance(b),
    )[0];
}

function transformedText(text: string, mode: NodeStyle["textTransform"]) {
  if (mode === "uppercase") return text.toUpperCase();
  if (mode === "lowercase") return text.toLowerCase();
  if (mode === "capitalize") {
    return Array.from(
      new Intl.Segmenter(undefined, { granularity: "word" }).segment(text),
      (word) =>
        word.isWordLike
          ? word.segment.replace(/\p{L}/u, (c) => c.toUpperCase())
          : word.segment,
    ).join("");
  }
  return text;
}

function coversSourceText(
  text: string,
  lines: NonNullable<ReturnType<typeof currentTextLayout>>["lines"],
) {
  let offset = 0;
  for (const line of lines) {
    if (
      outlineLineBreak.test(line.text) ||
      line.x.length !== Array.from(line.text).length
    )
      return false;
    // At a row boundary the importer may omit hard breaks or soft-wrap space.
    // Within a row (including interior spaces), require an exact source slice.
    while (!text.startsWith(line.text, offset)) {
      if (
        offset >= text.length ||
        !/[ \t\r\n\f\u2028\u2029]/u.test(text[offset])
      )
        return false;
      offset++;
    }
    offset += line.text.length;
  }
  return /^[ \t\r\n\f\u2028\u2029]*$/u.test(text.slice(offset));
}

function configureFont(hb: HarfBuzz, font: Font, style: NodeStyle) {
  const axes = new Map([
    ["wght", style.fontWeight ?? 400],
    ["opsz", style.fontSize],
  ]);
  for (const item of style.fontVariationSettings?.split(",") ?? []) {
    const axis = hb.Variation.fromString(item.trim());
    if (axis) axes.set(axis.tag, axis.value);
  }
  font.setVariations(
    [...axes].map(([tag, value]) => new hb.Variation(tag, value)),
  );
  const options = style.fontFeatureSettings?.split(",") ?? [];
  if (style.letterSpacing) options.unshift("liga=0", "clig=0");
  return options
    .map((s) => hb.Feature.fromString(s.trim()))
    .filter((f) => f !== undefined);
}

function glyphAdvance(g: Glyph, next: Glyph | undefined, tracking: number) {
  return (
    (g.xAdvance ?? 0) * g.candidate.unit +
    (g.cluster !== next?.cluster ? tracking : 0)
  );
}

// Unicode 17.0 LineBreak.txt. JavaScript has no Line_Break property escape.
// Pe/Pf and Ps/Pi also cover our directional closing and opening quotes.
// CJ is treated as NS for strict Japanese breaks. Remaining dots, dashes and
// the fullwidth tilde follow the editor's typography rules.
const NO_LINE_START = new RegExp(
  "^[" +
    [
      String.raw`\p{Pe}\p{Pf}`, // CL, CP and final punctuation
      String.raw`/\-`, // SY and HY
      String.raw`\u0009|\u00AD\u0964-\u0965\u0E5A-\u0E5B\u0F0B\u0F34\u0F7F\u0F85\u0FBE-\u0FBF\u0FD2\u104A-\u104B\u1361\u1680`, // BA
      String.raw`\u16EB-\u16ED\u1735-\u1736\u17D4-\u17D5\u17D8\u17DA\u1804-\u1805\u1B4E-\u1B4F\u1B5A-\u1B5B\u1B5D-\u1B60`,
      String.raw`\u1B7D-\u1B7F\u1C3B-\u1C3F\u1C7E-\u1C7F\u2000-\u2006\u2008-\u200A\u2027\u2056\u2058-\u205B\u205D-\u205F\u2800`,
      String.raw`\u2CFA-\u2CFC\u2CFF\u2D70\u2E0E-\u2E15\u2E19\u2E2A-\u2E2D\u2E30-\u2E31\u2E33-\u2E34\u2E3C-\u2E3E\u2E41`,
      String.raw`\u2E43-\u2E4A\u2E4C\u2E4E-\u2E4F\u3000\uA4FE-\uA4FF\uA60D\uA60F\uA6F3-\uA6F7\uA8CE-\uA8CF\uA92E-\uA92F`,
      String.raw`\uA9C7-\uA9C9\uA9CF\uAA40-\uAA42\uAA44-\uAA4B\uAA5D-\uAA5F\uAAF0-\uAAF1\uABEB\u{10100}-\u{10102}\u{1039F}`,
      String.raw`\u{103D0}\u{10857}\u{1091F}\u{10A50}-\u{10A57}\u{10AF0}-\u{10AF5}\u{10B39}-\u{10B3F}\u{10ED0}`,
      String.raw`\u{11047}-\u{11048}\u{110BE}-\u{110C1}\u{11140}-\u{11143}\u{111C5}-\u{111C6}\u{111C8}\u{111DD}-\u{111DF}`,
      String.raw`\u{11238}-\u{11239}\u{1123B}-\u{1123C}\u{112A9}\u{1133D}\u{1135D}\u{1144B}-\u{1144E}\u{1145A}-\u{1145B}`,
      String.raw`\u{115C2}-\u{115C3}\u{115C9}-\u{115D7}\u{11641}-\u{11642}\u{1173C}-\u{1173E}\u{11944}-\u{11946}`,
      String.raw`\u{11A41}-\u{11A44}\u{11A9A}-\u{11A9C}\u{11AA1}-\u{11AA2}\u{11C41}-\u{11C45}\u{11EF2}\u{11EF7}-\u{11EF8}`,
      String.raw`\u{11F43}-\u{11F44}\u{11FFF}\u{12470}-\u{12474}\u{16A6E}-\u{16A6F}\u{16AF5}\u{16B37}-\u{16B39}\u{16B44}`,
      String.raw`\u{16D6E}-\u{16D6F}\u{16E97}-\u{16E98}\u{1BC9F}\u{1DA87}-\u{1DA8A}`,
      String.raw`\u058A\u05BE\u1400\u2010\u2012-\u2013\u2E17\u2E40\u2E5D\u{10D6E}\u{10EAD}`, // HH
      String.raw`、。\uFE10-\uFE12﹐﹒，．｡､\u{1325B}-\u{1325D}\u{13282}\u{13287}\u{13289}\u{1337A}\u{1337B}\u{13438}\u{1343D}\u{1343F}\u{145CF}`, // other CL
      String.raw`!?\u05C6\u061B\u061D-\u061F\u06D4\u07F9\u0F0D-\u0F11\u0F14\u1802\u1803\u1808\u1809\u1944\u1945\u2762\u2763\u2CF9\u2CFE\u2E2E\u2E53\u2E54\uA60E\uA876\uA877︕︖﹖﹗！？\u{115C4}\u{115C5}\u{11C71}`, // EX
      String.raw`,.:;\u037E\u0589\u060C\u060D\u07F8\u2044`, // IS
      String.raw`\u17D6‼‽⁇-⁉々〜〻〼゛-ゞ゠・ヽヾ\uA015︓︔﹔﹕：；･ﾞﾟ\u{16FE0}-\u{16FE3}\u{16FF2}\u{16FF3}\u{1F679}-\u{1F67B}`, // NS
      String.raw`%¢°\u0609-\u060B\u066A\u09F2\u09F3\u09F9\u0D79\u2030-\u2037\u2057\u20A7\u20B6\u20BB\u20BE\u20C0℃℉\uA838\uFDFC﹪％￠\u{11FDD}-\u{11FE0}\u{1ECAC}\u{1ECB0}`, // PO
      String.raw`ぁぃぅぇぉっゃゅょゎゕゖァィゥェォッャュョヮヵヶーㇰ-ㇿｧ-ｰ\u{1B132}\u{1B150}-\u{1B152}\u{1B155}\u{1B164}-\u{1B167}`, // CJ
      String.raw`․-…⋯︙\u{10AF6}`, // IN
      "·•‑—―～",
    ].join("") +
    "]",
  "u",
);
const NO_LINE_END = new RegExp(
  "[" +
    [
      String.raw`\p{Ps}\p{Pi}¡¿⸘\u{13258}-\u{1325A}\u{13286}\u{13288}\u{13379}\u{1342F}\u{13437}\u{1343C}\u{1343E}\u{145CE}\u{1E95E}\u{1E95F}`, // OP and initial punctuation
      String.raw`$+\\£-¥±\u058F\u07FE\u07FF\u09FB\u0AF1\u0BF9\u0E3F\u17DB\u20A0-\u20A6\u20A8-\u20B5\u20B7-\u20BA\u20BC\u20BD\u20BF\u20C1-\u20CF№−∓﹩＄￡￥￦\u{1E2FF}`, // PR
    ].join("") +
    String.raw`][\p{M}\p{Default_Ignorable_Code_Point}]*$`,
  "u",
);

// Choose breaks in logical cluster order. Reshape every resulting row so the
// actual kerning, ligatures and contextual forms are computed at line boundaries.
function wrapRow(
  row: Row,
  width: number,
  tracking: number,
  shape: (s: string) => Row,
) {
  if (row.advance <= width || !row.glyphs.length) return [row];
  const advances = new Map<number, number>();
  row.glyphs.forEach((g, i) =>
    advances.set(
      g.cluster,
      (advances.get(g.cluster) ?? 0) +
        glyphAdvance(g, row.glyphs[i + 1], tracking),
    ),
  );
  const clusters = [...advances.keys()].sort((a, b) => a - b);
  const breaks = new Set(
    Array.from(
      new Intl.Segmenter(undefined, { granularity: "word" }).segment(row.text),
      (s) => s.index + s.segment.length,
    ),
  );
  const cjk =
    /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
  // A soft break trims trailing spaces. Enforce kinsoku on the visible neighbors
  // as well, so an intervening space cannot leave an opener at the line end.
  const forbidden = new Set<number>();
  let preceding = "",
    following = "";
  for (const [i, at] of clusters.entries()) {
    const next = clusters[i + 1] ?? row.text.length;
    preceding = row.text.slice(at, next).trimEnd() || preceding;
    if (NO_LINE_END.test(preceding)) forbidden.add(next);
  }
  for (let i = clusters.length - 1; i >= 0; i--) {
    const at = clusters[i];
    const cluster = row.text.slice(at, clusters[i + 1]);
    following = cluster.trimStart() || following;
    if (NO_LINE_START.test(cluster) || NO_LINE_START.test(following))
      forbidden.add(at);
  }
  const rows: Row[] = [];
  let start = 0;
  while (start < clusters.length) {
    let used = 0,
      end = start,
      lastBreak = start,
      emergency = start;
    for (; end < clusters.length; end++) {
      const idx = clusters[end],
        next = clusters[end + 1] ?? row.text.length;
      const part = row.text.slice(idx, next),
        following = row.text.slice(next, clusters[end + 2]);
      used += advances.get(idx)!;
      if (used > width && !/^\s+$/u.test(part) && emergency > start) {
        end = lastBreak > start ? lastBreak : emergency;
        break;
      }
      if (!forbidden.has(next)) {
        emergency = end + 1;
        if (
          breaks.has(next) ||
          /[/-]$/u.test(part) ||
          cjk.test(part) ||
          cjk.test(following)
        )
          lastBreak = emergency;
      }
    }
    let text = row.text.slice(
      clusters[start],
      clusters[end] ?? row.text.length,
    );
    const wrapped = end < clusters.length;
    if (wrapped) text = text.trimEnd();
    rows.push({ ...shape(text), wrapped });
    start = end;
  }
  return rows;
}

const visible = /[^\s\p{Cc}\p{Default_Ignorable_Code_Point}]/u;

function drawablePath(candidate: Candidate, id: number) {
  const cached = candidate.paths.get(id);
  if (cached !== undefined) return cached;
  const path = id ? candidate.font.glyphToPath(id) : "";
  const result = path && normalizedGlyphPath(path);
  candidate.paths.set(id, result);
  return result;
}

function missingGlyphs(family: string, chars: Iterable<string>) {
  const unique = [...new Set(chars)];
  const label = unique
    .slice(0, 12)
    .map(
      (c) =>
        "「" +
        c +
        "」 (U+" +
        c.codePointAt(0)!.toString(16).toUpperCase() +
        ")",
    )
    .join("、");
  return Error(
    "字体「" +
      family +
      "」缺少部分字形的矢量轮廓：" +
      label +
      (unique.length > 12 ? " 等" : "") +
      "（可能为位图或彩色表情字体），无法转为矢量轮廓",
  );
}

function glyphArtwork(
  hb: HarfBuzz,
  candidates: Candidate[],
  buffer: Buffer,
  style: NodeStyle,
  text: string,
  missing: Set<string>,
  layout: ReturnType<typeof currentTextLayout>,
) {
  const primary = candidates[0];
  const tracking = style.letterSpacing ?? 0;
  function shape(text: string, positioned = false): Row {
    const accepted: Glyph[] = [];
    let rtl = false,
      pending = [{ start: 0, end: text.length }];
    for (const candidate of candidates) {
      const retry: typeof pending = [];
      function shapeGroups(start: number, end: number) {
        buffer.reset();
        buffer.addText(text.slice(start, end));
        buffer.setFlags(hb.BufferFlag.REMOVE_DEFAULT_IGNORABLES);
        buffer.guessSegmentProperties();
        if (rtl) buffer.setDirection(hb.Direction.RTL);
        hb.shape(candidate.font, buffer, candidate.features);
        const glyphs = buffer.getGlyphInfosAndPositions();
        if (
          candidate === primary &&
          start === 0 &&
          end === text.length &&
          glyphs.length > 1
        )
          rtl = glyphs[0].cluster > glyphs.at(-1)!.cluster;
        const groups = new Map<number, Glyph[]>();
        groups.set(start, []);
        for (const g of glyphs) {
          const cluster = g.cluster + start;
          const group = groups.get(cluster) ?? [];
          group.push({ ...g, cluster, candidate });
          groups.set(cluster, group);
        }
        return groups;
      }
      for (const { start, end } of pending) {
        if (end === start) continue;
        const groups = shapeGroups(start, end);
        if (positioned) {
          const starts = [...groups.keys()].sort((a, b) => a - b);
          for (const [i, pos] of starts.entries()) {
            const characters = Array.from(
              text.slice(pos, starts[i + 1] ?? end),
            );
            if (characters.length < 2) continue;
            // The runtime positions each Unicode character in its own tspan.
            // Reshape only the merged cluster, leaving contextual neighbors intact.
            let offset = pos;
            for (const ch of characters) {
              for (const [cluster, glyphs] of shapeGroups(
                offset,
                offset + ch.length,
              ))
                groups.set(cluster, glyphs);
              offset += ch.length;
            }
          }
        }
        const starts = [...groups.keys()].sort((a, b) => a - b);
        for (const [i, pos] of starts.entries()) {
          const until = starts[i + 1] ?? end,
            group = groups.get(pos)!;
          if (
            !visible.test(text.slice(pos, until)) ||
            (group.length &&
              group.every((g) => drawablePath(candidate, g.codepoint)))
          ) {
            for (const g of group) accepted.push(g);
          } else {
            const last = retry.at(-1);
            if (last?.end === pos) last.end = until;
            else retry.push({ start: pos, end: until });
          }
        }
      }
      pending = retry;
      if (!pending.length) break;
    }
    for (const { start, end } of pending)
      for (const ch of text.slice(start, end))
        if (visible.test(ch)) missing.add(ch);
    const glyphs = accepted.sort((a, b) =>
      rtl ? b.cluster - a.cluster : a.cluster - b.cluster,
    );
    const advance = glyphs.reduce(
      (w, g, i) => w + glyphAdvance(g, glyphs[i + 1], tracking),
      0,
    );
    return { text, glyphs, advance, wrapped: false };
  }
  const rows = layout
    ? layout.lines.map((line) => shape(line.text, true))
    : text.split(outlineLineBreak).flatMap((line) => {
        const row = shape(line);
        return style.widthMode === "hug" || missing.size
          ? [row]
          : wrapRow(row, style.width, tracking, shape);
      });
  if (missing.size) return;
  const extents = primary.font.hExtents(),
    height = style.lineHeight ?? style.fontSize * 1.4;
  const freeY =
    style.heightMode === "hug" ? 0 : style.height - rows.length * height;
  const top =
    style.verticalAlign === "bottom"
      ? freeY
      : style.verticalAlign === "middle"
        ? freeY / 2
        : 0;
  const firstBaseline =
    top + (height + (extents.ascender + extents.descender) * primary.unit) / 2;
  const artwork: string[] = [];
  for (const [i, row] of rows.entries()) {
    const freeX = style.width - row.advance;
    let x =
      style.textAlign === "right"
        ? freeX
        : style.textAlign === "center"
          ? freeX / 2
          : 0;
    let y = firstBaseline + i * height;
    const spaces =
      row.wrapped && style.textAlign === "justify"
        ? row.glyphs.filter((g) => row.text[g.cluster] === " ").length
        : 0;
    const native = layout?.lines[i];
    const origins = new Map<number, number>();
    if (native) {
      let offset = 0;
      for (const [j, ch] of Array.from(native.text).entries()) {
        origins.set(offset, native.x[j]);
        offset += ch.length;
      }
    }
    for (const [j, g] of row.glyphs.entries()) {
      if (native && row.glyphs[j - 1]?.cluster !== g.cluster) {
        // Saved x already includes the first shaped glyph offset.
        x = origins.get(g.cluster)! - (g.xOffset ?? 0) * g.candidate.unit;
        y = native.y;
      }
      const { unit } = g.candidate;
      const d = drawablePath(g.candidate, g.codepoint);
      if (d)
        artwork.push(
          svgpath(d)
            .scale(unit, -unit)
            .translate(x + (g.xOffset ?? 0) * unit, y - (g.yOffset ?? 0) * unit)
            .round(5)
            .toString(),
        );
      x += glyphAdvance(g, row.glyphs[j + 1], tracking);
      if (spaces && row.text[g.cluster] === " ") x += freeX / spaces;
      y -= (g.yAdvance ?? 0) * unit;
    }
  }
  return artwork.join(" ");
}

type ResolvedFace = SystemFontFace & {
  faceId?: string;
  familyRank?: number;
  declaredMatch?: boolean;
};
type Resolver = (
  request: SystemFontRequest,
) => Promise<ResolvedFace[] | SystemFontFailure>;
function resolvedFaces(reply: ResolvedFace[] | SystemFontFailure) {
  if (Array.isArray(reply)) return reply;
  throw Object.assign(Error(reply.error), { code: reply.code });
}
const localSans = [
  "sf pro text",
  "sf pro display",
  "sf pro",
  "pingfang sc",
  "hiragino sans gb",
  "helvetica neue",
  "stheiti",
  "arial unicode ms",
  "arial",
  "noto sans cjk sc",
  "segoe ui",
  "microsoft yahei",
  "dejavu sans",
];
function browserFamilyOrder(css: string) {
  const families: string[] = [];
  for (const { name, quoted } of parseFontFamilies(css)) {
    const family = name.toLowerCase();
    if (
      !quoted &&
      [
        "system-ui",
        "-apple-system",
        "blinkmacsystemfont",
        "sans-serif",
      ].includes(family)
    )
      families.push(...localSans);
    else if (!quoted && family === "serif")
      families.push(
        "new york",
        "songti sc",
        "stsong",
        "times new roman",
        "georgia",
        "noto serif cjk sc",
      );
    else if (!quoted && ["monospace", "ui-monospace"].includes(family))
      families.push(
        "sf mono",
        "menlo",
        "monaco",
        "jetbrains mono",
        "pingfang sc",
        "courier new",
      );
    else families.push(family);
  }
  return families;
}
function browserWeight(style: string) {
  if (/thin/i.test(style)) return 100;
  if (/extra.?light|ultra.?light/i.test(style)) return 200;
  if (/light/i.test(style)) return 300;
  if (/medium/i.test(style)) return 500;
  if (/semi.?bold|demi/i.test(style)) return 600;
  if (/extra.?bold|ultra.?bold/i.test(style)) return 800;
  if (/black|heavy/i.test(style)) return 900;
  return /bold/i.test(style) ? 700 : 400;
}
async function* localCandidates(
  request: SystemFontRequest,
): AsyncGenerator<ResolvedFace> {
  if (typeof window === "undefined") return;
  if (window.formaDesktop?.resolveSystemFonts) {
    const faces = await window.formaDesktop
      .resolveSystemFonts(request)
      .catch(() => undefined);
    if (faces) {
      yield* resolvedFaces(faces);
      return;
    }
  }
  if (
    ["127.0.0.1", "localhost", "[::1]", "::1"].includes(
      window.location.hostname,
    ) &&
    typeof window.fetch === "function"
  ) {
    const response = await window
      .fetch("/api/system-fonts/resolve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
        redirect: "error",
      })
      .catch(() => undefined);
    const payload = await response?.json().catch(() => undefined);
    if (payload?.ok === false) throw Error(String(payload.error));
    const faces = response?.ok ? payload?.faces : undefined;
    if (Array.isArray(faces)) {
      yield* faces;
      return;
    }
  }
  // FontData.blob() is permission-gated. Read one candidate at a time so a
  // successful match never loads the rest of the user's installed font files.
  const local = await window.queryLocalFonts?.().catch(() => []);
  if (!local) return;
  const families = browserFamilyOrder(request.fontFamily);
  const ranked = local
    .map((f) => {
      const rank = families.findIndex((s) =>
        [f.family, f.fullName, f.postscriptName].some(
          (n) => n.toLowerCase() === s,
        ),
      );
      return {
        f,
        rank: rank < 0 ? families.length : rank,
        style: Number(
          /italic|oblique/i.test(f.style) !== (request.fontStyle === "italic"),
        ),
        weight: Math.abs(browserWeight(f.style) - request.fontWeight),
      };
    })
    .sort(
      (a, b) => a.rank - b.rank || a.style - b.style || a.weight - b.weight,
    );
  for (const { f, rank } of ranked) {
    if (request.declaredOnly && rank === families.length) break;
    if (request.excludeFaces?.includes(f.postscriptName)) continue;
    const blob = await f.blob().catch(() => undefined);
    if (!blob || blob.size < 12) continue;
    const bytes = await readFontFileBytes(blob).catch(() => undefined);
    if (!bytes) continue;
    const signature = String.fromCharCode(...bytes.subarray(0, 4));
    let faceIndex = 0;
    if (signature === "ttcf") {
      const faces = listTtcFaces(bytes).filter(
        (face) => face.family.toLowerCase() === f.family.toLowerCase(),
      );
      faceIndex =
        faces.sort(
          (a, b) =>
            Number(a.italic !== /italic|oblique/i.test(f.style)) -
              Number(b.italic !== /italic|oblique/i.test(f.style)) ||
            Math.abs(a.weight - browserWeight(f.style)) -
              Math.abs(b.weight - browserWeight(f.style)),
        )[0]?.faceIndex ?? 0;
    }
    const data =
      signature === "ttcf" ? extractTtcFace(bytes, faceIndex) : bytes;
    yield {
      family: f.family,
      faceId: f.postscriptName,
      familyRank: rank,
      declaredMatch: rank < families.length,
      data,
      faceIndex: 0,
      format:
        String.fromCharCode(...data.subarray(0, 4)) === "OTTO" ? "otf" : "ttf",
    };
  }
}
export async function outlineTextNode(
  doc: DesignDocument,
  nodeId: string,
  options: { resolveSystemFonts?: Resolver } = {},
) {
  requireOutlineText(doc, nodeId);
  const saved = outlineTextFromShapeOperations(doc, nodeId);
  if (saved) return saved;
  const n = resolveNode(doc, findLayer(doc, nodeId)!);
  const text = transformedText(n.text, n.style.textTransform);
  const family = n.style.fontFamily ?? "system-ui, sans-serif";
  const hb = await import("harfbuzzjs");
  // 1.6.x registers each wrapper with FinalizationRegistry. Only invoke an
  // explicit destructor on wrappers that actually expose it; raw WASM frees
  // would double-free when the finalizer runs. Register as each allocation succeeds.
  const resources: object[] = [];
  function own<T extends object>(object: T) {
    resources.push(object);
    return object;
  }
  try {
    const candidates: Candidate[] = [];
    const missing = new Set(Array.from(text).filter((c) => visible.test(c)));
    const rect = layoutBounds(doc).get(nodeId)!;
    const style = { ...n.style, width: rect.width, height: rect.height };
    const native = currentTextLayout(n);
    const layout =
      native &&
      coversSourceText(text, native.lines) &&
      Math.abs(native.width - rect.width) <= 1 &&
      Math.abs(native.height - rect.height) <= 1
        ? native
        : undefined;
    const buffer = own(new hb.Buffer());
    let d: string | undefined;
    function add(bytes: Uint8Array, faceIndex: number) {
      const blob = own(new hb.Blob(bytes)),
        face = own(new hb.Face(blob, faceIndex)),
        font = own(new hb.Font(face));
      candidates.push({
        font,
        unit: style.fontSize / face.upem,
        features: configureFont(hb, font, style),
        paths: new Map(),
      });
      missing.clear();
      d = glyphArtwork(hb, candidates, buffer, style, text, missing, layout);
    }
    const declarations = parseFontFamilies(family).map(({ css, name }) => ({
      css,
      asset: embeddedFont(doc, style, name.toLowerCase()),
    }));
    const seen = new Set<string>();
    // Older/custom resolvers may include undeclared fallbacks in a family lookup.
    const deferred = new Map<string, ResolvedFace>();
    let systemBytes = 0;
    function reserve(face: ResolvedFace) {
      systemBytes +=
        typeof face.data === "string"
          ? assetByteLength(face.data)
          : face.data.length;
      if (systemBytes > 48 * 1024 * 1024)
        throw Error("系统字体响应超过字节预算");
    }
    function useFace(key: string, face: ResolvedFace) {
      if (!deferred.delete(key)) reserve(face);
      seen.add(key);
      add(
        typeof face.data === "string" ? decodeBase64(face.data) : face.data,
        face.faceIndex,
      );
    }
    async function system(css: string, declaredOnly: boolean) {
      const declared = browserFamilyOrder(css);
      while (!d && missing.size && seen.size < 24) {
        const before = seen.size;
        const request: SystemFontRequest = {
          fontFamily: css,
          fontWeight: style.fontWeight ?? 400,
          fontStyle: style.fontStyle ?? "normal",
          text: [...missing].join(""),
          ...(declaredOnly ? { declaredOnly: true } : {}),
          ...(seen.size ? { excludeFaces: [...seen] } : {}),
        };
        const source = options.resolveSystemFonts
          ? resolvedFaces(await options.resolveSystemFonts(request))
          : localCandidates(request);

        // Bridge results carry ranks for aliases. Injected resolvers can return just family names.
        const rank = (f: ResolvedFace) => {
          const index = declared.indexOf(f.family.toLowerCase());
          return f.familyRank ?? (index < 0 ? Infinity : index);
        };
        const ordered = Array.isArray(source)
          ? [...source].sort((a, b) => rank(a) - rank(b))
          : source;
        const occurrences = new Map<string, number>();
        for await (const face of ordered) {
          const ordinal = occurrences.get(face.family) ?? 0;
          occurrences.set(face.family, ordinal + 1);
          const key =
            face.faceId ?? face.family + "/" + face.faceIndex + "/" + ordinal;
          if (seen.has(key)) continue;
          if (
            declaredOnly &&
            !face.declaredMatch &&
            !declared.includes(face.family.toLowerCase())
          ) {
            if (!deferred.has(key) && deferred.size < 6) {
              reserve(face);
              deferred.set(key, face);
            }
            continue;
          }
          useFace(key, face);
          if (d || seen.size >= 24) break;
        }
        if (seen.size === before) return;
      }
    }
    let i = 0;
    while (i < declarations.length && !d) {
      const { asset } = declarations[i];
      if (asset) {
        i++;
        const normalized = await normalizeFontBytes(decodeBase64(asset.data), {
          weight: style.fontWeight,
          italic: style.fontStyle === "italic",
        });
        add(normalized.bytes, 0);
      } else {
        const start = i++;
        while (i < declarations.length && !declarations[i].asset) i++;
        const css = declarations
          .slice(start, i)
          .map((f) => f.css)
          .join(", ");
        await system(css, true);
      }
    }
    for (const [key, face] of deferred) {
      if (d) break;
      useFace(key, face);
    }
    if (!d) await system(family, false);
    if (!d) throw missingGlyphs(family, missing.size ? missing : text);
    const bounds = vectorBounds(
      [{ contours: readContours(d), fill: true, strokeWidth: 0 }],
      0,
    );
    return createOutlinedVectorFromTextOperations(doc, nodeId, d, bounds);
  } finally {
    for (const resource of resources.reverse()) {
      if ("destroy" in resource && typeof resource.destroy === "function")
        resource.destroy();
    }
  }
}
