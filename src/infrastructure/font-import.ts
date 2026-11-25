import {
  assetHash,
  encodeBase64,
  decodeBase64,
  maxAssetBytes,
} from "../domain/asset-bytes";
import { type FontAsset, fontFaceWeight } from "../domain/fonts";

const loaded = new Map<string, { data: string; ready: Promise<void> }>();
async function fontId(bytes: ArrayBuffer) {
  return "font-" + (await assetHash(new Uint8Array(bytes)));
}
function installFont(id: string, asset: FontAsset, verified?: ArrayBuffer) {
  const existing = loaded.get(id);
  if (existing) {
    if (existing.data !== asset.data)
      return Promise.reject(Error("字体资源标识冲突：" + asset.name));
    return existing.ready;
  }
  const ready = (async () => {
    let bytes = verified;
    if (!bytes) {
      bytes = decodeBase64(asset.data).buffer;
      if ((await fontId(bytes)) !== id)
        throw Error("字体内容与标识不一致：" + asset.name);
    }
    const weight = fontFaceWeight(asset);
    const face = new FontFace(id, bytes, {
      ...(weight ? { weight } : {}),
      ...(asset.italic ? { style: "italic" } : {}),
    });
    await face.load();
    document.fonts.add(face);
  })().catch((err) => {
    loaded.delete(id);
    throw err;
  });
  loaded.set(id, { data: asset.data, ready });
  return ready;
}
export async function loadFonts(fonts?: Record<string, FontAsset>) {
  for (const [id, font] of Object.entries(fonts ?? {}))
    await installFont(id, font);
}
/** Read the SFNT table directory and fvar axis records. Actual glyph decoding is delegated to the browser. */
export async function readFont(file: File) {
  if (file.size > maxAssetBytes)
    throw Error("请选择 32 MiB 以内的 TTF 或 OTF 字体");
  const data = await file.arrayBuffer();
  const result = await importFontBytes(new Uint8Array(data), file.name);
  await installFont(result.id, result.asset, data);
  return result;
}
/** Normal horizontal AAT track; offsets are relative to the start of trak. */
export function horizontalTracking(view: DataView, unitsPerEm: number) {
  if (
    !unitsPerEm ||
    view.byteLength < 12 ||
    view.getUint32(0) !== 0x10000 ||
    view.getUint16(4) !== 0
  )
    return;
  const horizontal = view.getUint16(6);
  if (!horizontal) return;
  if (horizontal + 8 > view.byteLength) throw Error("字体水平字距表损坏");
  const tracks = view.getUint16(horizontal),
    count = view.getUint16(horizontal + 2),
    sizes = view.getUint32(horizontal + 4);
  if (
    horizontal + 8 + tracks * 8 > view.byteLength ||
    sizes + count * 4 > view.byteLength
  )
    throw Error("字体字距目录无效");
  if (!count) return;
  for (let track = 0; track < tracks; track++) {
    const at = horizontal + 8 + track * 8;
    if (view.getInt32(at) !== 0) continue;
    const values = view.getUint16(at + 6);
    if (values + count * 2 > view.byteLength) throw Error("字体字距值越界");
    const pairs = Array.from({ length: count }, (_, i) => ({
      size: view.getInt32(sizes + i * 4) / 65536,
      units: view.getInt16(values + i * 2),
    }));
    if (
      pairs.some(
        (p, i) => p.size <= 0 || (i > 0 && p.size <= pairs[i - 1].size),
      )
    )
      throw Error("字体字号次序无效");
    return (size: number) => {
      let end = pairs.findIndex((p) => p.size >= size);
      if (end < 0) end = pairs.length - 1;
      const right = pairs[end],
        left = end ? pairs[end - 1] : right;
      const blend =
        left === right
          ? 0
          : Math.max(
              0,
              Math.min(1, (size - left.size) / (right.size - left.size)),
            );
      return (
        (size * (left.units + (right.units - left.units) * blend)) / unitsPerEm
      );
    };
  }
}
export function inspectFontBytes(bytes: Uint8Array, includeTracking = false) {
  if (bytes.byteLength > maxAssetBytes || bytes.byteLength < 12)
    throw Error("请选择 32 MiB 以内的 TTF 或 OTF 字体");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (offset: number) =>
    String.fromCharCode(...bytes.subarray(offset, offset + 4));
  const format =
    tag(0) === "OTTO" ? "otf" : view.getUint32(0) === 0x10000 ? "ttf" : null;
  if (!format) throw Error("请选择有效的 TTF 或 OTF 字体");
  const tables = view.getUint16(4);
  if (12 + tables * 16 > bytes.byteLength) throw Error("字体目录已损坏");
  const axes: FontAsset["axes"] = [];
  const features = new Set<string>();
  let weight: number | undefined, italic: boolean | undefined;
  let unitsPerEm = 0,
    trackTable: DataView | undefined;
  for (let i = 0; i < tables; i++) {
    const at = 12 + i * 16,
      offset = view.getUint32(at + 8),
      size = view.getUint32(at + 12);
    if (offset + size > bytes.byteLength) throw Error("字体表长度无效");
    if (includeTracking && tag(at) === "head" && size >= 20)
      unitsPerEm = view.getUint16(offset + 18);
    if (includeTracking && tag(at) === "trak")
      trackTable = new DataView(bytes.buffer, bytes.byteOffset + offset, size);
    if (tag(at) === "OS/2" && size >= 64) {
      const usWeight = view.getUint16(offset + 4);
      if (usWeight >= 1 && usWeight <= 1000) weight = usWeight;
      italic = !!(view.getUint16(offset + 62) & 1);
    }
    if (tag(at) === "GSUB" || tag(at) === "GPOS") {
      if (size < 10) throw Error("字体布局表损坏");
      const list = view.getUint16(offset + 6);
      if (list + 2 > size) throw Error("字体特性目录无效");
      const count = view.getUint16(offset + list);
      if (list + 2 + count * 6 > size) throw Error("字体特性目录不完整");
      for (let j = 0; j < count; j++) {
        const key = tag(offset + list + 2 + j * 6);
        if (/^[A-Za-z0-9 ]{4}$/.test(key)) features.add(key);
        if (features.size > 512) throw Error("字体特性超过 512 项");
      }
    }
    if (tag(at) !== "fvar") continue;
    if (size < 16) throw Error("字体轴表损坏");
    const start = view.getUint16(offset + 4),
      count = view.getUint16(offset + 8),
      stride = view.getUint16(offset + 10);
    if (
      start < 16 ||
      count > 64 ||
      stride < 20 ||
      start + count * stride > size
    )
      throw Error("字体轴目录无效");
    for (let j = 0; j < count; j++) {
      const a = offset + start + j * stride;
      const axis = {
        tag: tag(a),
        min: view.getInt32(a + 4) / 65536,
        default: view.getInt32(a + 8) / 65536,
        max: view.getInt32(a + 12) / 65536,
      };
      if (
        !/^[A-Za-z0-9 ]{4}$/.test(axis.tag) ||
        axis.min > axis.default ||
        axis.default > axis.max
      )
        throw Error("字体轴标签或取值范围无效");
      axes.push(axis);
    }
  }
  let tracking, trackingIssue;
  try {
    tracking = trackTable && horizontalTracking(trackTable, unitsPerEm);
  } catch (error) {
    trackingIssue =
      error instanceof Error ? error.message : "无法读取可选字号字距表";
  }
  return {
    format,
    axes,
    weight,
    italic,
    tracking,
    trackingIssue,
    features: [...features].sort(),
  };
}
export async function importFontBytes(bytes: Uint8Array, filename: string) {
  const { format, tracking, trackingIssue, ...metadata } = inspectFontBytes(
    bytes,
    true,
  );
  const id = "font-" + (await assetHash(bytes));
  const asset = {
    name: filename.replace(/\.(otf|ttf)$/i, "").slice(0, 255) || "字体",
    ...metadata,
    data: "data:font/" + format + ";base64," + encodeBase64(bytes),
  };
  return { id, asset, tracking, trackingIssue };
}
