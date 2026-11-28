import { unzlibSync } from "fflate";
import {
  assetHash,
  encodeBase64,
  decodeBase64,
  maxAssetBytes,
} from "../domain/asset-bytes";
import { type FontAsset, fontFaceWeight } from "../domain/fonts";

type InstalledFont = {
  data: string;
  face?: FontFace;
  ready: Promise<void>;
};
const loaded = new Map<string, InstalledFont>();
const owners = new Map<string, Set<string>>();
const documents = new Map<string, Set<string>>();
const transient = new Set<string>();

function evict(key: string) {
  const entry = loaded.get(key);
  if (entry?.face) document.fonts.delete(entry.face);
  loaded.delete(key);
}

function holdTransient(key: string) {
  if (owners.has(key)) return;
  transient.delete(key);
  transient.add(key);
  if (transient.size > 8) {
    const oldest = transient.values().next().value!;
    transient.delete(oldest);
    evict(oldest);
  }
}

// The ID is the verified SHA-256 of the bytes. Legacy documents may use
// different CSS descriptors for the same bytes, which need independent faces.
function registrationKey(id: string, asset: FontAsset) {
  return [
    id,
    fontFaceWeight(asset) ?? "400",
    asset.italic ? "italic" : "normal",
  ].join("/");
}

function installFont(id: string, asset: FontAsset, verified?: ArrayBuffer) {
  const key = registrationKey(id, asset);
  const existing = loaded.get(key);
  if (existing) {
    if (existing.data !== asset.data)
      return Promise.reject(Error("字体资源标识冲突：" + asset.name));
    return existing.ready;
  }
  const entry: InstalledFont = { data: asset.data, ready: Promise.resolve() };
  loaded.set(key, entry);
  entry.ready = (async () => {
    const bytes = verified ?? decodeBase64(asset.data).buffer;
    if (!verified && "font-" + (await assetHash(new Uint8Array(bytes))) !== id)
      throw Error("字体资源标识冲突，内容与标识不一致：" + asset.name);
    const face = new FontFace(id, bytes, {
      weight: fontFaceWeight(asset) ?? "400",
      style: asset.italic ? "italic" : "normal",
    });
    await face.load();
    // A tab may close, replace the face or reopen while the browser decodes it.
    if (loaded.get(key) === entry) {
      document.fonts.add(face);
      entry.face = face;
    }
  })().catch((err) => {
    if (loaded.get(key) === entry) loaded.delete(key);
    throw err;
  });
  return entry.ready;
}

function dropOwner(owner: string, key: string) {
  const holders = owners.get(key);
  holders?.delete(owner);
  if (!holders?.size) {
    owners.delete(key);
    evict(key);
  }
}

export function releaseDocumentFonts(owner: string): void {
  for (const key of documents.get(owner) ?? []) dropOwner(owner, key);
  documents.delete(owner);
}

function reconcileOwner(owner: string, keys: Set<string>) {
  for (const key of documents.get(owner) ?? []) {
    if (!keys.has(key)) dropOwner(owner, key);
  }
  if (!keys.size) {
    documents.delete(owner);
    return;
  }
  documents.set(owner, keys);
  for (const key of keys) {
    transient.delete(key);
    const holders = owners.get(key) ?? new Set<string>();
    holders.add(owner);
    owners.set(key, holders);
  }
}

export async function retainDocumentFonts(
  owner: string,
  fonts?: Record<string, FontAsset>,
): Promise<void> {
  const entries = Object.entries(fonts ?? {});
  const keys = new Set(
    entries.map(([id, asset]) => registrationKey(id, asset)),
  );
  reconcileOwner(owner, keys);
  let failure: unknown;
  for (const [id, asset] of entries) {
    if (documents.get(owner) !== keys) return;
    try {
      await installFont(id, asset);
    } catch (error) {
      if (documents.get(owner) !== keys) return;
      const key = registrationKey(id, asset);
      keys.delete(key);
      dropOwner(owner, key);
      failure ??= error;
    }
  }
  if (!keys.size && documents.get(owner) === keys) documents.delete(owner);
  if (failure) throw failure;
}

export async function loadFonts(
  fonts?: Record<string, FontAsset>,
  owner?: string,
) {
  if (owner !== undefined) return retainDocumentFonts(owner, fonts);
  for (const [id, font] of Object.entries(fonts ?? {})) {
    holdTransient(registrationKey(id, font));
    await installFont(id, font);
  }
}
// A macOS PingFang collection exceeds 64 MiB. Check its signature before
// reading a large Blob; the extracted face still has the 32 MiB asset limit.
export async function readFontFileBytes(file: Blob) {
  if (file.size > maxCollectionBytes) throw Error("字体集超过 160 MiB");
  if (
    file.size > maxAssetBytes &&
    new DataView(await file.slice(0, 4).arrayBuffer()).getUint32(0) !==
      collection
  )
    throw Error("单字体文件超过 32 MiB");
  return new Uint8Array(await file.arrayBuffer());
}
export async function readFont(
  file: File,
  options?: NormalizeFontOptions,
  pending?: { owner: string; signal: AbortSignal },
) {
  const budget = new MetadataBudget();
  const { bytes } = await normalizeFontBytes(
    await readFontFileBytes(file),
    options,
    budget,
  );
  const result = await makeFontAsset(bytes, file.name, budget);
  pending?.signal.throwIfAborted();
  const key = registrationKey(result.id, result.asset);
  if (pending) reconcileOwner(pending.owner, new Set([key]));
  else holdTransient(key);
  await installFont(result.id, result.asset, new Uint8Array(bytes).buffer);
  pending?.signal.throwIfAborted();
  return result;
}
/** Normal horizontal AAT track; offsets are relative to the start of trak. */
export function horizontalTracking(
  view: DataView,
  unitsPerEm: number,
  budget = new MetadataBudget(),
) {
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
  budget.charge(tracks + count);
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
export function inspectFontBytes(
  bytes: Uint8Array,
  includeTracking = false,
  budget = new MetadataBudget(),
) {
  if (bytes.byteLength > maxAssetBytes || bytes.byteLength < 12)
    throw Error("请选择 32 MiB 以内的 TTF 或 OTF 字体");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (offset: number) =>
    String.fromCharCode(...bytes.subarray(offset, offset + 4));
  const format =
    tag(0) === "OTTO"
      ? "otf"
      : view.getUint32(0) === 0x10000 || tag(0) === "true"
        ? "ttf"
        : null;
  if (!format) throw Error("请选择有效的 TTF 或 OTF 字体");
  const { tables } = directory(bytes, 0, budget);
  const axes: FontAsset["axes"] = [];
  const features = new Set<string>();
  let weight: number | undefined, italic: boolean | undefined;
  let unitsPerEm = 0,
    trackTable: DataView | undefined;
  for (const { tag: tagCode, data } of tables) {
    const tableTag = String.fromCharCode(
      tagCode >>> 24,
      (tagCode >>> 16) & 255,
      (tagCode >>> 8) & 255,
      tagCode & 255,
    );
    const offset = data.byteOffset - bytes.byteOffset,
      size = data.length;
    if (includeTracking && tableTag === "head" && size >= 20)
      unitsPerEm = view.getUint16(offset + 18);
    if (includeTracking && tableTag === "trak")
      trackTable = new DataView(bytes.buffer, bytes.byteOffset + offset, size);
    if (tableTag === "OS/2" && size >= 64) {
      const usWeight = view.getUint16(offset + 4);
      if (usWeight >= 1 && usWeight <= 1000) weight = usWeight;
      italic = !!(view.getUint16(offset + 62) & 1);
    }
    if (tableTag === "GSUB" || tableTag === "GPOS") {
      if (size < 10) throw Error("字体布局表损坏");
      const list = view.getUint16(offset + 6);
      if (list + 2 > size) throw Error("字体特性目录无效");
      const count = view.getUint16(offset + list);
      if (list + 2 + count * 6 > size) throw Error("字体特性目录不完整");
      budget.charge(count);
      for (let j = 0; j < count; j++) {
        const key = tag(offset + list + 2 + j * 6);
        if (/^[A-Za-z0-9 ]{4}$/.test(key)) features.add(key);
        if (features.size > 512) throw Error("字体特性超过 512 项");
      }
    }
    if (tableTag !== "fvar") continue;
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
    budget.charge(count);
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
    tracking = trackTable && horizontalTracking(trackTable, unitsPerEm, budget);
  } catch (error) {
    trackingIssue =
      error instanceof Error ? error.message : "无法读取可选字号字距表";
  }
  return {
    format: format as "ttf" | "otf",
    axes,
    weight,
    italic,
    tracking,
    trackingIssue,
    features: [...features].sort(),
  };
}
async function makeFontAsset(
  bytes: Uint8Array,
  filename: string,
  budget: MetadataBudget,
) {
  const { format, tracking, trackingIssue, ...metadata } = inspectFontBytes(
    bytes,
    true,
    budget,
  );
  const id = "font-" + (await assetHash(bytes));
  const asset = {
    name:
      filename.replace(/\.(otf|ttf|ttc|otc|woff2?)$/i, "").slice(0, 255) ||
      "字体",
    ...metadata,
    data: "data:font/" + format + ";base64," + encodeBase64(bytes),
  };
  return { id, asset, tracking, trackingIssue };
}

const maxCollectionBytes = 160 * 1024 * 1024;
const trueType = 0x00010000,
  appleTrue = 0x74727565,
  openType = 0x4f54544f,
  collection = 0x74746366;
type NormalizeFontOptions = {
  faceIndex?: number;
  chooseFace?: (faces: ReturnType<typeof listTtcFaces>) => Promise<number>;
  weight?: number;
  italic?: boolean;
};
type Table = { tag: number; data: Uint8Array };
function viewOf(bytes: Uint8Array) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}
function padded(n: number) {
  return Math.ceil(n / 4) * 4;
}
function checkFlavor(flavor: number) {
  if (![trueType, appleTrue, openType].includes(flavor))
    throw Error("请选择有效的 OpenType 字体");
}
function checkedSlice(bytes: Uint8Array, start: number, length: number) {
  if (start + length > bytes.length) throw Error("字体表长度无效");
  return bytes.subarray(start, start + length);
}
// One unit per directory entry, name record, or layout feature visited.
class MetadataBudget {
  private remaining = 32768;
  charge(units: number) {
    this.remaining -= units;
    if (this.remaining < 0) throw Error("字体元数据超出处理预算");
  }
}
function directory(bytes: Uint8Array, offset: number, budget?: MetadataBudget) {
  if (offset + 12 > bytes.length) throw Error("字体目录已损坏");
  const view = viewOf(bytes),
    flavor = view.getUint32(offset),
    count = view.getUint16(offset + 4);
  checkFlavor(flavor);
  if (!count || count > 128 || offset + 12 + 16 * count > bytes.length)
    throw Error("字体目录已损坏");
  budget?.charge(count);
  const tags = new Set<number>();
  const tables = Array.from({ length: count }, (_, i) => {
    const at = offset + 12 + 16 * i;
    const tag = view.getUint32(at);
    if (tags.has(tag)) throw Error("字体目录含重复表");
    tags.add(tag);
    return {
      tag,
      data: checkedSlice(
        bytes,
        view.getUint32(at + 8),
        view.getUint32(at + 12),
      ),
    };
  });
  return { flavor, tables };
}
function checksum(bytes: Uint8Array) {
  const view = viewOf(bytes);
  let sum = 0;
  for (let i = 0; i < bytes.length; i += 4)
    sum = (sum + view.getUint32(i)) >>> 0;
  return sum;
}
// opentype.js 2 reads cmap records backwards and accepts Mac Roman before
// checking its format. Keep the Unicode maps and UVS data at their original
// offsets, omitting obsolete Mac Roman records only when a Unicode map exists.
function normalizeCollectionCmap(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint16(2);
  if (count > 256 || 4 + count * 8 > bytes.length)
    throw Error("字符映射目录无效");
  let unicode = false;
  const keep = [];
  for (let i = 0; i < count; i++) {
    const at = 4 + i * 8,
      platform = view.getUint16(at),
      encoding = view.getUint16(at + 2);
    const format = view.getUint16(view.getUint32(at + 4));
    if (
      (platform === 0 || (platform === 3 && [1, 10].includes(encoding))) &&
      (format === 4 || format === 12)
    )
      unicode = true;
    if (platform !== 1 || encoding !== 0) keep.push(at);
  }
  if (!unicode || keep.length === count) return;
  keep.forEach((at, i) => bytes.copyWithin(4 + 8 * i, at, at + 8));
  view.setUint16(2, keep.length);
}

// OpenType table checksums use a zeroed head.checkSumAdjustment. Write the
// adjustment last so the complete standalone file sums to 0xB1B0AFBA.
function rebuild(flavor: number, tables: Table[], fromCollection = false) {
  checkFlavor(flavor);
  const count = tables.length,
    header = 12 + count * 16;
  const total = tables.reduce((n, t) => n + padded(t.data.length), header);
  if (total > maxAssetBytes || !count || count > 128)
    throw Error("规范化字体超过 32 MiB 或目录无效");
  const bytes = new Uint8Array(total),
    view = viewOf(bytes);
  const exponent = Math.floor(Math.log2(count)),
    search = 16 * 2 ** exponent;
  view.setUint32(0, flavor === appleTrue ? trueType : flavor);
  view.setUint16(4, count);
  view.setUint16(6, search);
  view.setUint16(8, exponent);
  view.setUint16(10, count * 16 - search);
  let offset = header,
    head = 0;
  tables.sort((a, b) => a.tag - b.tag);
  tables.forEach(({ tag, data }, i) => {
    if (i && tables[i - 1].tag === tag) throw Error("字体目录含重复表");
    const at = 12 + i * 16,
      length = padded(data.length);
    bytes.set(data, offset);
    if (fromCollection && tag === 0x636d6170)
      normalizeCollectionCmap(bytes.subarray(offset, offset + data.length));
    if (tag === 0x68656164) {
      if (data.length < 12) throw Error("字体 head 表损坏");
      head = offset;
      view.setUint32(head + 8, 0);
    }
    view.setUint32(at, tag);
    view.setUint32(at + 4, checksum(bytes.subarray(offset, offset + length)));
    view.setUint32(at + 8, offset);
    view.setUint32(at + 12, data.length);
    offset += length;
  });
  if (!head) throw Error("字体缺少 head 表");
  view.setUint32(head + 8, (0xb1b0afba - checksum(bytes)) >>> 0);
  return bytes;
}
function ttcOffsets(bytes: Uint8Array, budget: MetadataBudget) {
  const view = viewOf(bytes);
  if (
    bytes.length > maxCollectionBytes ||
    bytes.length < 12 ||
    view.getUint32(0) !== collection
  )
    throw Error("无效的 TTC 字体集");
  const count = view.getUint32(8);
  if (!count || count > 4096 || 12 + count * 4 > bytes.length)
    throw Error("字体集目录损坏");
  budget.charge(count);
  return Array.from({ length: count }, (_, i) => view.getUint32(12 + i * 4));
}
export function extractTtcFace(
  bytes: Uint8Array,
  faceIndex = 0,
  budget = new MetadataBudget(),
): Uint8Array {
  const offsets = ttcOffsets(bytes, budget);
  if (
    !Number.isInteger(faceIndex) ||
    faceIndex < 0 ||
    faceIndex >= offsets.length
  )
    throw Error("字体集字面索引无效");
  const { flavor, tables } = directory(bytes, offsets[faceIndex], budget);
  return rebuild(flavor, tables, true);
}

function familyName(bytes: Uint8Array, budget: MetadataBudget) {
  if (bytes.length < 6) throw Error("字体名称目录已损坏");
  const view = viewOf(bytes),
    count = view.getUint16(2),
    storage = view.getUint16(4);
  budget.charge(count);
  if (6 + count * 12 > bytes.length) throw Error("字体名称目录已损坏");
  let family = "",
    best = -1;
  for (let i = 0; i < count; i++) {
    const at = 6 + 12 * i,
      id = view.getUint16(at + 6),
      platform = view.getUint16(at);
    if (
      (id !== 16 && id !== 1) ||
      (platform !== 0 && platform !== 1 && platform !== 3)
    )
      continue;
    const english =
      platform === 1
        ? view.getUint16(at + 4) === 0
        : view.getUint16(at + 4) === 0x409;
    const score =
      (english ? 4 : 0) + (id === 16 ? 2 : 0) + (platform === 3 ? 1 : 0);
    if (score <= best || (platform === 1 && view.getUint16(at + 2) !== 0))
      continue;
    budget.charge(Math.ceil(view.getUint16(at + 8) / 16));
    const name = new TextDecoder(platform === 1 ? "macintosh" : "utf-16be")
      .decode(
        checkedSlice(
          bytes,
          storage + view.getUint16(at + 10),
          view.getUint16(at + 8),
        ),
      )
      .trim();
    if (name) {
      family = name;
      best = score;
    }
  }
  return family;
}
export function listTtcFaces(bytes: Uint8Array, budget = new MetadataBudget()) {
  const directories = new Map<
    number,
    { family: string; weight: number; italic: boolean }
  >();
  const names = new Map<string, string>();
  function metadata(offset: number) {
    const cached = directories.get(offset);
    if (cached) return cached;
    const { tables } = directory(bytes, offset, budget);
    const table = (key: number) => tables.find((t) => t.tag === key)?.data;
    const os2 = table(0x4f532f32),
      head = table(0x68656164);
    const style = head && head.length >= 46 ? viewOf(head).getUint16(44) : 0;
    const name = table(0x6e616d65);
    let family = "";
    if (name) {
      const key = name.byteOffset + "/" + name.length;
      if (!names.has(key)) names.set(key, familyName(name, budget));
      family = names.get(key)!;
    }
    const result = {
      family,
      weight:
        (os2 && os2.length >= 6 && viewOf(os2).getUint16(4)) ||
        (style & 1 ? 700 : 400),
      italic: !!(
        style & 2 ||
        (os2 && os2.length >= 64 && viewOf(os2).getUint16(62) & 1)
      ),
    };
    directories.set(offset, result);
    return result;
  }
  return ttcOffsets(bytes, budget).map((offset, faceIndex) => ({
    faceIndex,
    ...metadata(offset),
  }));
}
export function decodeWoff1(bytes: Uint8Array): Uint8Array {
  const view = viewOf(bytes);
  if (
    bytes.length < 44 ||
    bytes.length > maxAssetBytes ||
    view.getUint32(0) !== 0x774f4646 ||
    view.getUint32(8) !== bytes.length
  )
    throw Error("WOFF 文件头无效");
  const flavor = view.getUint32(4),
    count = view.getUint16(12),
    total = view.getUint32(16);
  checkFlavor(flavor);
  if (
    total > maxAssetBytes ||
    !count ||
    count > 128 ||
    44 + 20 * count > bytes.length
  )
    throw Error("WOFF 字体超过 32 MiB 或目录损坏");
  let size = 12 + 16 * count;
  const entries = Array.from({ length: count }, (_, i) => {
    const at = 44 + 20 * i,
      start = view.getUint32(at + 4),
      compressed = view.getUint32(at + 8),
      length = view.getUint32(at + 12);
    if (compressed > length || start % 4 || start < 44 + count * 20)
      throw Error("WOFF 字体表无效");
    size += padded(length);
    return {
      tag: view.getUint32(at),
      data: checkedSlice(bytes, start, compressed),
      length,
    };
  });
  if (size !== total) throw Error("WOFF 解压长度无效");
  return rebuild(
    flavor,
    entries.map(({ tag, data, length }) => {
      if (data.length === length) return { tag, data };
      // Pass a bounded output buffer so forged deflate lengths cannot grow memory.
      const inflated = unzlibSync(data, { out: new Uint8Array(length + 1) });
      if (inflated.length !== length) throw Error("WOFF 解压长度无效");
      return { tag, data: inflated };
    }),
  );
}

function checkWoff2(bytes: Uint8Array) {
  const view = viewOf(bytes);
  if (
    bytes.length < 48 ||
    view.getUint32(8) !== bytes.length ||
    view.getUint32(16) > maxAssetBytes
  )
    throw Error("WOFF2 字体超过 32 MiB 或文件头无效");
  // The decoder derives allocation sizes from the compressed table directory,
  // independently of totalSfntSize. Bound both original and transformed lengths.
  let pos = 48;
  function base128() {
    let n = 0;
    for (let i = 0; i < 5; i++) {
      const b = view.getUint8(pos++);
      n = n * 128 + (b & 127);
      if (n > maxAssetBytes) break;
      if (!(b & 128)) return n;
    }
    throw Error("WOFF2 字体表超过 32 MiB");
  }
  const count = view.getUint16(12);
  if (!count || count > 128) throw Error("WOFF2 字体目录无效");
  let expanded = 12 + 16 * count,
    stream = 0;
  for (let i = 0; i < count; i++) {
    const flags = view.getUint8(pos++),
      tag = flags & 63,
      version = flags >>> 6;
    let glyfOrLoca = tag === 10 || tag === 11;
    if (tag === 63) {
      const custom = view.getUint32(pos);
      pos += 4;
      glyfOrLoca = custom === 0x676c7966 || custom === 0x6c6f6361;
    }
    const length = base128();
    expanded += padded(length);
    stream += (glyfOrLoca ? version === 0 : version !== 0) ? base128() : length;
    if (expanded > maxAssetBytes || stream > maxAssetBytes)
      throw Error("WOFF2 字体表超过 32 MiB");
  }
  if (pos + view.getUint32(20) > bytes.length) throw Error("WOFF2 数据不完整");
}
export async function normalizeFontBytes(
  bytes: Uint8Array,
  options: NormalizeFontOptions = {},
  budget = new MetadataBudget(),
): Promise<{ bytes: Uint8Array; format: "ttf" | "otf"; faceIndex: number }> {
  if (bytes.length < 12) throw Error("字体文件不完整");
  let flavor = viewOf(bytes).getUint32(0),
    faceIndex = 0;
  if (
    bytes.length > (flavor === collection ? maxCollectionBytes : maxAssetBytes)
  )
    throw Error("字体文件超过大小限制");
  if (flavor === 0x774f4632) {
    checkWoff2(bytes);
    const { default: decompress } = await import("wawoff2/decompress.js");
    bytes = await decompress(bytes);
    if (bytes.length > maxAssetBytes) throw Error("WOFF2 字体超过 32 MiB");
    flavor = viewOf(bytes).getUint32(0);
  }
  if (flavor === collection) {
    if (options.faceIndex !== undefined) faceIndex = options.faceIndex;
    else {
      const faces = listTtcFaces(bytes, budget);
      const score = (f: (typeof faces)[number]) =>
        Number(f.italic !== !!options.italic) * 65536 +
        Math.abs(f.weight - (options.weight ?? 400));
      const best = Math.min(...faces.map(score));
      const matches = faces.filter((f) => score(f) === best);
      const ambiguous =
        faces.length > 1 &&
        (options.weight === undefined || matches.length !== 1);
      faceIndex =
        ambiguous && options.chooseFace
          ? await options.chooseFace(faces)
          : matches[0].faceIndex;
    }
    bytes = extractTtcFace(bytes, faceIndex, budget);
  } else if (flavor === 0x774f4646) bytes = decodeWoff1(bytes);
  else if (flavor === appleTrue) {
    const sfnt = directory(bytes, 0, budget);
    bytes = rebuild(sfnt.flavor, sfnt.tables);
  } else checkFlavor(flavor);
  const { format } = inspectFontBytes(bytes, false, budget);
  return { bytes, format, faceIndex };
}

export async function importFontBytes(
  bytes: Uint8Array,
  filename: string,
  options?: NormalizeFontOptions,
) {
  const budget = new MetadataBudget();
  return makeFontAsset(
    (await normalizeFontBytes(bytes, options, budget)).bytes,
    filename,
    budget,
  );
}
