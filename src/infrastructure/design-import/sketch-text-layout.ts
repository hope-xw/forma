import { resolveNode } from "../../domain/design-system";
import type {
  DesignDocument,
  DesignNode,
  NodeStyle,
} from "../../domain/document";
import { textLayoutStyleKey } from "../../domain/text-shape";
import type { Warn } from "./sketch-source";

type HarfBuzz = typeof import("harfbuzzjs");
type Layout = NonNullable<DesignNode["sourceTextLayout"]>;

type Face = InstanceType<HarfBuzz["Face"]>;
type Font = InstanceType<HarfBuzz["Font"]>;
type ShapeFace = { face: Face; fonts: Map<string, Font> };
function shapeLines(
  hb: HarfBuzz,
  { face, fonts }: ShapeFace,
  buffer: InstanceType<HarfBuzz["Buffer"]>,
  style: NodeStyle,
  str: string,
  origin: { x: number; y: number },
): Layout["lines"] | undefined {
  const size = style.fontSize;
  if (!(size > 0) || !str.trim() || str.length > 1000 || str.includes("\t"))
    return;
  const lines = str.split(/\r\n?|\n/);
  if (lines.length > 128 || style.textAlign === "justify") return;
  const axes = new Map([
    ["opsz", size],
    ["wght", style.fontWeight ?? 400],
  ]);
  for (const v of style.fontVariationSettings?.split(",") ?? []) {
    const variation = hb.Variation.fromString(v.trim());
    if (variation) axes.set(variation.tag, variation.value);
  }
  const variationsKey = JSON.stringify([...axes]);
  let font = fonts.get(variationsKey);
  if (!font) {
    // The JS wrapper finalizes WASM objects through GC. Reconfigure an existing
    // font when a face has more than 32 distinct variation combinations.
    if (fonts.size >= 32) {
      const oldest = fonts.keys().next().value!;
      font = fonts.get(oldest)!;
      fonts.delete(oldest);
    } else font = new hb.Font(face);
    font.setVariations(
      [...axes].map(([tag, value]) => new hb.Variation(tag, value)),
    );
    fonts.set(variationsKey, font);
  }
  const features = (style.fontFeatureSettings?.split(",") ?? [])
    .map((s) => hb.Feature.fromString(s.trim()))
    .filter((f) => f !== undefined);
  const unit = size / face.upem;
  const extents = font.hExtents();
  const lineHeight =
    style.lineHeight ??
    (extents.ascender - extents.descender + extents.lineGap) * unit;
  const tracking = style.letterSpacing ?? 0;
  function positions(text: string) {
    buffer.clearContents();
    buffer.addText(text);
    buffer.guessSegmentProperties();
    hb.shape(font!, buffer, features);
    const glyphs = buffer.getGlyphInfosAndPositions(),
      chars = [...text];
    if (glyphs.length !== chars.length) return;
    const x: number[] = [];
    let advance = 0,
      index = 0;
    for (let j = 0; j < glyphs.length; j++) {
      const g = glyphs[j];
      // Preserve contextual clusters, fallback faces and bidirectional text in the browser shaper.
      if (!g.codepoint || g.cluster !== index || g.yOffset || g.yAdvance)
        return;
      x.push(advance + (g.xOffset ?? 0) * unit);
      advance += (g.xAdvance ?? 0) * unit + tracking;
      index += chars[j].length;
    }
    return { x, advance };
  }
  const runs: { text: string; x: number[]; advance: number }[] = [];
  for (const raw of lines) {
    const text =
      style.textTransform === "uppercase"
        ? raw.toUpperCase()
        : style.textTransform === "lowercase"
          ? raw.toLowerCase()
          : raw;
    const run = positions(text);
    if (!run) return;
    if (style.widthMode === "hug" || run.advance <= style.width + 0.5) {
      runs.push({ text, ...run });
      continue;
    }
    // Each row is shaped afresh so line breaks do not carry contextual kerning across words.
    // Leave languages with more complex line breaking to the platform's Unicode layout engine.
    if (!/^[\x20-\x7e]+$/.test(text)) return;
    let rest = text;
    while (rest) {
      let best = "",
        next = "";
      for (const word of rest.match(/\S+\s*|\s+/g) ?? []) {
        const candidate = best + word,
          width = positions(candidate.trimEnd())?.advance;
        if (width === undefined || width > style.width + 0.5) break;
        best = candidate;
        next = rest.slice(best.length);
      }
      if (!best) return;
      const shaped = positions(best);
      if (!shaped) return;
      runs.push({ text: best, ...shaped });
      rest = next;
    }
  }
  const blockHeight = runs.length * lineHeight;
  if (runs.length > lines.length && blockHeight > style.height + 1) return;
  const top =
    style.verticalAlign === "middle"
      ? (style.height - blockHeight) / 2
      : style.verticalAlign === "bottom"
        ? style.height - blockHeight
        : 0;
  const result: Layout["lines"] = [];
  // CoreGraphics' grayscale glyph origins are snapped in document space, after parent translations.
  const multiplePaints = style.paints?.some((p) => p.visible);
  const phases = size >= 34 ? 1 : size >= 17 ? 2 : size > 12 ? 3 : 4;
  for (const [i, run] of runs.entries()) {
    if (!run.text) continue;
    const offset =
      style.textAlign === "center"
        ? (style.width - run.advance) / 2
        : style.textAlign === "right"
          ? style.width - run.advance
          : 0;
    const baseline =
      top +
      i * lineHeight +
      (lineHeight + (extents.ascender + extents.descender) * unit) / 2;
    result.push({
      text: run.text,
      x: run.x.map((x) =>
        multiplePaints
          ? offset + x
          : Math.floor((origin.x + offset + x) * phases + 1e-6) / phases -
            origin.x,
      ),
      y:
        (style.lineHeight === undefined
          ? Math.floor(origin.y + baseline + 1e-6)
          : Math.round(origin.y + baseline)) - origin.y,
    });
  }
  return result.length ? result : undefined;
}

export async function attachSketchTextLayouts(
  doc: DesignDocument,
  bytes: ReadonlyMap<string, Uint8Array>,
  warn: Warn,
) {
  if (!bytes.size) return;
  let hb: HarfBuzz, buffer: InstanceType<HarfBuzz["Buffer"]>;
  try {
    hb = await import("harfbuzzjs");
    buffer = new hb.Buffer();
  } catch {
    warn("document", "嵌入字体排版引擎无法加载，文字已保留为可编辑文本");
    return;
  }
  const faces = new Map<string, ShapeFace | null>();
  const cache = new Map<string, Layout | undefined>();
  const nodes = [
    doc.nodes,
    ...(doc.pages ?? []).flatMap((p) => (p.nodes ? [p.nodes] : [])),
    ...Object.values(doc.libraries ?? {}).flatMap((lib) =>
      lib.components.flatMap((c) => c.variants.map((v) => v.nodes)),
    ),
  ];
  for (const group of nodes) {
    const lookup = new Map(group.map((n) => [n.id, n]));
    const origins = new Map<string, { x: number; y: number }>();
    function originOf(n: DesignNode) {
      const chain: DesignNode[] = [],
        seen = new Set<string>();
      let cursor: DesignNode | undefined = n;
      while (cursor && !origins.has(cursor.id)) {
        if (seen.has(cursor.id)) {
          warn(n.id, "图层父级循环，已跳过源文字排版");
          return;
        }
        seen.add(cursor.id);
        chain.push(cursor);
        cursor = cursor.parentId ? lookup.get(cursor.parentId) : undefined;
      }
      let origin = cursor ? origins.get(cursor.id)! : { x: 0, y: 0 };
      for (const child of chain.reverse()) {
        if (child.parentId && lookup.has(child.parentId))
          origin = { x: origin.x + child.style.x, y: origin.y + child.style.y };
        origins.set(child.id, origin);
      }
      return origin;
    }
    for (const n of group) {
      if (n.type !== "text" || !n.text || n.textRuns?.length) continue;
      const style = resolveNode(doc, n, lookup).style;
      const id = style.fontFamily;
      if (!id || !bytes.has(id) || style.width > 10000 || style.height > 10000)
        continue;
      const position = originOf(n);
      if (!position) continue;
      const origin = {
        x: Math.round((position.x - Math.floor(position.x)) * 1000) / 1000,
        y: Math.round((position.y - Math.floor(position.y)) * 1000) / 1000,
      };
      const styleKey = textLayoutStyleKey(style),
        key = JSON.stringify([n.text, styleKey, origin.x, origin.y]);
      if (!cache.has(key)) {
        let face = faces.get(id);
        if (face === undefined) {
          try {
            const source = new hb.Face(new hb.Blob(bytes.get(id)!), 0);
            if (!source.referenceTable("head")?.length)
              throw Error("缺少字体头");
            face = { face: source, fonts: new Map() };
          } catch {
            warn(n.id, "嵌入字体无法解码，已保留可编辑文字");
            face = null;
          }
          faces.set(id, face);
        }
        if (!face) continue;
        let lines;
        try {
          lines = shapeLines(hb, face, buffer, style, n.text, origin);
        } catch {
          warn(n.id, "嵌入字体排版失败，已保留可编辑文字");
        }
        cache.set(
          key,
          lines
            ? {
                text: n.text,
                styleKey,
                width: style.width,
                height: style.height,
                lines,
              }
            : undefined,
        );
      }
      const layout = cache.get(key);
      if (layout) n.sourceTextLayout = layout;
    }
  }
}
