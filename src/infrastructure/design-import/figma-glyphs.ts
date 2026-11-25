import { textShapeStyleKey } from "../../domain/text-shape";
import { resolveNode } from "../../domain/design-system";
import type { DesignDocument } from "../../domain/document";
import type { DesignNode } from "../../domain/node";
import type { Fields, LayerContext } from "./figma-layer";
import { guid, obj, rows, str } from "./figma-layer";

const maxPathLength = 100000;
const commandNames = ["Z", "M", "L", "Q", "C"];
const coordinateCount = [0, 2, 2, 4, 6];
type Outcome =
  | Pick<
      NonNullable<DesignNode["sourceTextShape"]>,
      "d" | "width" | "height" | "coverageOffsets"
    >
  | { reason: string };
const unsupported = (reason: string): Outcome => ({ reason });

// Glyph commands use font units with Y pointing up. Glyph positions already
// contain kerning, baseline, alignment and line placement in text-box pixels.
export function readGlyphShape(
  raw: Fields,
  node: DesignNode,
  blobs: Fields[],
): Outcome {
  const text = node.text,
    derived = obj(raw.derivedTextData),
    glyphs = rows(derived.glyphs);
  if (
    !text ||
    node.textRuns?.length ||
    /[\r\n]/.test(text) ||
    node.style.textDecoration ||
    node.style.textTransform ||
    rows(raw.fillPaints)
      .filter((p) => p.visible !== false)
      .some((p) => p.type !== "SOLID") ||
    rows(raw.fillPaints).filter((p) => p.visible !== false).length !== 1 ||
    rows(raw.strokePaints).some((p) => p.visible !== false)
  )
    return unsupported("混合、分段或特殊文字绘制");
  const meta = rows(derived.fontMetaData);
  if (
    meta.length !== 1 ||
    str(obj(meta[0].key).family) !== str(obj(raw.fontName).family) ||
    (typeof derived.truncationStartIndex === "number" &&
      derived.truncationStartIndex >= 0)
  )
    return unsupported("字形字体信息不完整或已截断");
  const size = obj(raw.size),
    box = obj(derived.layoutSize);
  if (
    typeof size.x !== "number" ||
    typeof size.y !== "number" ||
    size.x <= 0 ||
    size.y <= 0 ||
    size.x > 10000 ||
    size.y > 10000 ||
    Math.abs(Number(box.x) - size.x) > 0.01 ||
    Math.abs(Number(box.y) - size.y) > 0.01 ||
    !Number.isFinite(Number(box.x) + Number(box.y))
  )
    return unsupported("文字布局框与缓存不一致");
  if (!glyphs.length || text !== str(obj(raw.textData).characters))
    return unsupported("未取得完整字形");
  if (glyphs.length > 512 || text.length > 2048)
    return unsupported("单层字形数量超限");
  // The native text painter positions each line box on the pixel grid while
  // retaining the font's fractional ascent and the advances of individual glyphs.
  const lineShift = new Map<number, number>();
  for (const baseline of rows(derived.baselines)) {
    const y = obj(baseline.position).y;
    if (typeof y === "number" && typeof baseline.lineY === "number")
      lineShift.set(y, Math.round(baseline.lineY) - baseline.lineY);
  }
  const coverageOffsets: { start: number; shiftY: number }[] = [];
  const commands: string[] = [];
  let length = 0,
    drew = false;
  for (const g of glyphs) {
    const first = g.firstCharacter,
      pos = obj(g.position),
      size = g.fontSize;
    if (
      typeof first !== "number" ||
      !Number.isInteger(first) ||
      first < 0 ||
      first >= text.length ||
      typeof pos.x !== "number" ||
      typeof pos.y !== "number" ||
      !Number.isFinite(pos.x + pos.y) ||
      typeof size !== "number" ||
      size <= 0 ||
      size > 500 ||
      Math.abs(size - node.style.fontSize) > 0.01 ||
      (g.rotation !== undefined && g.rotation !== 0)
    )
      return unsupported("字形位置或字号与文字不一致");
    const data = Number.isInteger(g.commandsBlob)
      ? blobs[Number(g.commandsBlob)]?.bytes
      : undefined;
    if (!(data instanceof Uint8Array) || data.byteLength > 64000)
      return unsupported("字形轮廓缺失或超限");
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    let drewGlyph = false;
    const start = length;
    for (let offset = 0; offset < data.byteLength;) {
      const opcode = data[offset++],
        count = coordinateCount[opcode];
      if (count === undefined || offset + count * 4 > data.byteLength)
        return unsupported("字形路径编码无效");
      const coords: number[] = [];
      for (let i = 0; i < count; i += 2, offset += 8) {
        const x = pos.x + size * view.getFloat32(offset, true),
          y = pos.y - size * view.getFloat32(offset + 4, true);
        if (
          !Number.isFinite(x + y) ||
          Math.max(Math.abs(x), Math.abs(y)) > 100000
        )
          return unsupported("字形路径坐标无效");
        coords.push(Number(x.toFixed(3)), Number(y.toFixed(3)));
      }
      if (opcode === 0 && !drewGlyph) continue;
      const command = commandNames[opcode] + coords.join(" ");
      length += command.length + 1;
      if (length > maxPathLength) return unsupported("单层字形路径超限");
      commands.push(command);
      if (opcode >= 2) drewGlyph = true;
    }
    if (!drewGlyph && !/\s/u.test(text[first]))
      return unsupported("源字符的轮廓为空");
    if (drewGlyph) {
      const shiftY = lineShift.get(pos.y) ?? 0;
      if (shiftY !== (coverageOffsets.at(-1)?.shiftY ?? 0))
        coverageOffsets.push({ start, shiftY });
    }
    drew ||= drewGlyph;
  }
  return drew
    ? {
        d: commands.join(" "),
        width: size.x,
        height: size.y,
        ...(coverageOffsets.length ? { coverageOffsets } : {}),
      }
    : unsupported("未取得有墨迹的字形");
}

export function prepareGlyphShapes(ctx: LayerContext) {
  // Font-family availability cannot identify the exact binary, variation instance or native spacing.
  // Keep the original glyph geometry for compatible layers regardless of installed font names.
  let remaining = 96 * 1024 * 1024;
  const skips = new Map<string, { id: string; count: number }>();
  function skip(id: string, family: string, reason: string) {
    const detail = family + " · " + reason;
    const old = skips.get(detail);
    if (old) old.count++;
    else skips.set(detail, { id, count: 1 });
  }
  function apply(
    doc: DesignDocument,
    entries: readonly { source: Fields; layer: DesignNode }[],
  ) {
    const byId = new Map(entries.map(({ layer }) => [layer.id, layer]));
    for (const { layer, source } of entries) {
      const family = str(obj(source.fontName).family);
      if (layer.type !== "text" || !layer.text.trim()) continue;
      const id = guid(source.guid) || layer.id;
      if (remaining <= 0) {
        skip(id, family, "文件字形预算已用尽");
        continue;
      }
      const resolved = resolveNode(doc, layer, byId);
      const styleKey = textShapeStyleKey(layer.style);
      if (
        resolved.text !== layer.text ||
        resolved.style.fontFamily !== family ||
        textShapeStyleKey(resolved.style) !== styleKey
      ) {
        skip(id, family, "变量模式或样式与源字形不同");
        continue;
      }
      const glyph = readGlyphShape(source, layer, ctx.blobs);
      if ("reason" in glyph) {
        skip(id, family, glyph.reason);
        continue;
      }
      if (glyph.d.length > remaining) {
        skip(id, family, "文件字形预算不足");
        continue;
      }
      remaining -= glyph.d.length;
      layer.sourceTextShape = { ...glyph, text: layer.text, styleKey };
    }
  }
  return {
    apply,
    finish() {
      for (const [detail, s] of skips)
        ctx.report(
          s.id,
          "保留原文，未采用源字形：" +
            detail +
            "（" +
            s.count +
            " 个文字位置）",
        );
    },
  };
}
