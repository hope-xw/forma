import { Inflate, strFromU8, strToU8, zipSync, type Zippable } from "fflate";
import { exportNodeToSvg } from "../compiler/svg-export";
import {
  assetByteLength,
  decodeBase64,
  encodeBase64,
  maxAssetBytes,
  maxDocumentAssetBytes,
} from "../domain/asset-bytes";
import { parseDocument, type DesignDocument } from "../domain/document";
import {
  joinDocumentParts,
  nativePartsEnd,
  nativePartsPrefix,
  nativeTextParts,
  splitDocument,
  useLargeDocumentFormat,
  type DocumentPart,
} from "./document-parts";
import { crc32 } from "./design-import/archive";
import {
  checkDesignFileSize,
  maxManifestBytes,
  maxNativeBytes,
} from "./design-import/types";
import { checkImageMetadata, verifyEncodedAsset } from "./verified-asset";

export { isFormaPackageZip } from "./design-import/types";

export interface FormaPackageManifest {
  format: "forma/package";
  packageVersion: 1;
  schemaVersion: number;
  appVersion?: string;
  docId: string;
  name: string;
  pages: number;
  nodeCount: number;
  updatedAt: string;
  documentPath: "document.json" | "document.parts.ndjson";
  previewPath?: "preview.svg";
  assets: Record<
    string,
    { path: string; mime: string; bytes: number; sha256: string }
  >;
}

type Options = { appVersion?: string; includePreview?: boolean };
type MediaScope = Pick<DesignDocument, "images" | "fonts">;
type Kind = "images" | "fonts";
const maxPreviewBytes = 256 * 1024;

export function formaFilename(name: string): string {
  const slug = name
    .trim()
    .replace(/(?:\.(?:forma|json))+$/i, "")
    .replace(/[^\p{L}\p{M}\p{N}_-]+/gu, "-")
    .replace(/^-+|-+$/g, "");
  return (slug || "design") + ".forma";
}

function mapScopes(
  doc: DesignDocument,
  change: <T extends MediaScope>(scope: T) => T,
) {
  const result = change(doc);
  if (doc.libraries)
    result.libraries = Object.fromEntries(
      Object.entries(doc.libraries).map(([key, lib]) => [key, change(lib)]),
    );
  return result;
}

function mapMedia(
  doc: DesignDocument,
  change: (id: string, data: string, kind: Kind) => string,
) {
  return mapScopes(doc, (scope) => {
    const copy = { ...scope };
    for (const kind of ["images", "fonts"] as const) {
      const table = scope[kind];
      if (table)
        Object.assign(copy, {
          [kind]: Object.fromEntries(
            Object.entries(table).map(([id, asset]) => [
              id,
              { ...asset, data: change(id, asset.data, kind) },
            ]),
          ),
        });
    }
    return copy;
  });
}

const extension = new Map(
  Object.entries({
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/webp": "webp",
    "image/gif": "gif",
    "image/svg+xml": "svg",
    "font/woff2": "woff2",
    "font/woff": "woff",
    "font/ttf": "ttf",
    "font/otf": "otf",
  }),
);
function assetPath(id: string, mime: string, kind: Kind) {
  if (
    !(kind === "images" ? /^img-[a-f0-9]{64}$/ : /^font-[a-f0-9]{64}$/).test(id)
  )
    throw Error("资源标识无效：" + id);
  return "assets/" + kind + "/" + id + "." + (extension.get(mime) ?? "bin");
}
function pageNodeCount(doc: DesignDocument) {
  return (
    doc.nodes.length +
    (doc.pages ?? []).reduce((n, page) => n + (page.nodes?.length ?? 0), 0)
  );
}

// The native part writer owns page, component and diagnostic chunking. Keep media
// out of its resource-record stream and put only their metadata in its header.
function* structuralLines(doc: DesignDocument) {
  if (useLargeDocumentFormat(doc)) {
    yield* nativeTextParts(doc);
    return;
  }
  // Removing media may have taken the document below the legacy size threshold.
  yield nativePartsPrefix + "\n";
  for (const part of splitDocument(doc).parts())
    yield JSON.stringify(part) + ",\n";
  yield nativePartsEnd + "\n";
}
function partitionBytes(doc: DesignDocument) {
  const structure = mapScopes(doc, (scope) => {
    const copy = { ...scope };
    delete copy.images;
    delete copy.fonts;
    return copy;
  });
  const lines = structuralLines(structure);
  lines.next(); // fixed prefix
  const header = JSON.parse(lines.next().value!.slice(0, -2)) as Extract<
    DocumentPart,
    { kind: "header" }
  >;
  function attachTables(target: MediaScope, source: MediaScope) {
    if (source.images) target.images = source.images;
    if (source.fonts) target.fonts = source.fonts;
  }
  attachTables(header.document, doc);
  for (const [id, library] of Object.entries(doc.libraries ?? {}))
    attachTables(header.document.libraries![id], library);
  const chunks = [
    strToU8(nativePartsPrefix + "\n"),
    strToU8(JSON.stringify(header) + ",\n"),
  ];
  let size = chunks[0].length + chunks[1].length;
  for (const line of lines) {
    const chunk = strToU8(line);
    size += chunk.length;
    if (size > maxNativeBytes) throw Error("文件解压后超过 512 MiB");
    chunks.push(chunk);
  }
  const payload = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    payload.set(chunk, offset);
    offset += chunk.length;
  }
  return payload;
}
function preview(doc: DesignDocument) {
  try {
    for (const nodes of [
      doc.nodes,
      ...(doc.pages ?? []).flatMap((p) => (p.nodes ? [p.nodes] : [])),
    ]) {
      const root = nodes.find((n) => n.parentId === null && !n.hidden);
      if (!root) continue;
      const svg = exportNodeToSvg(
        nodes === doc.nodes ? doc : { ...doc, nodes },
        root.id,
      );
      if (svg.length > maxPreviewBytes) return;
      const bytes = strToU8(svg);
      if (bytes.length <= maxPreviewBytes) return bytes;
      return;
    }
  } catch {
    /* The cover is optional. */
  }
}

export function encodeFormaPackage(
  doc: DesignDocument,
  options: Options = {},
): Uint8Array<ArrayBuffer> {
  const files: Zippable = {};
  const assets: FormaPackageManifest["assets"] = {};
  const originals = new Map<string, string>();
  let assetTotal = 0;
  let hasOpaqueMedia = false;
  const stripped = mapMedia(doc, (id, data, kind) => {
    if (originals.has(id)) {
      if (originals.get(id) !== data)
        throw Error("同一资源 ID 的内容不一致：" + id);
      return Object.hasOwn(assets, id) ? "" : data;
    }
    originals.set(id, data);
    const mime = /^data:([\w.+-]+\/[\w.+-]+);base64,/.exec(data)?.[1];
    if (!mime) {
      hasOpaqueMedia = true;
      return data;
    }
    const path = assetPath(id, mime, kind);
    const length = assetByteLength(data);
    if (length > maxAssetBytes) throw Error("单个资源超过 32 MiB");
    assetTotal += length;
    if (assetTotal > maxDocumentAssetBytes)
      throw Error("文件资源总量超过 256 MiB");
    const bytes = decodeBase64(data);
    assets[id] = {
      path,
      mime,
      bytes: bytes.length,
      sha256: id.slice(id.indexOf("-") + 1),
    };
    files[path] = [
      bytes,
      { level: /\.(png|jpg|webp|gif|woff2)$/.test(path) ? 0 : 6 },
    ];
    return "";
  });
  const large = doc.nodes.length >= 10000 || useLargeDocumentFormat(doc);
  const documentPath = large ? "document.parts.ndjson" : "document.json";
  const payload = large
    ? partitionBytes(stripped)
    : strToU8(JSON.stringify(stripped));
  const cover =
    !large && !hasOpaqueMedia && options.includePreview !== false
      ? preview(doc)
      : undefined;
  const manifest: FormaPackageManifest = {
    format: "forma/package",
    packageVersion: 1,
    schemaVersion: doc.schemaVersion,
    appVersion: options.appVersion,
    docId: doc.id,
    name: doc.name,
    pages: doc.pages?.length ?? 1,
    nodeCount: pageNodeCount(doc),
    updatedAt: new Date().toISOString(),
    documentPath,
    previewPath: cover ? "preview.svg" : undefined,
    assets,
  };
  const meta = strToU8(JSON.stringify(manifest));
  if (
    meta.length > maxManifestBytes ||
    assetTotal + payload.length + meta.length + (cover?.length ?? 0) >
      maxNativeBytes
  )
    throw Error("文件解压后超过支持的大小");
  const bytes = zipSync(
    {
      "manifest.json": meta,
      [documentPath]: payload,
      ...(cover ? { "preview.svg": cover } : {}),
      ...files,
    },
    { level: 6 },
  );
  checkDesignFileSize(bytes.length, false);
  return bytes;
}
export function formaPackageBlob(doc: DesignDocument, options?: Options) {
  return new Blob([encodeFormaPackage(doc, options)], {
    type: "application/vnd.forma.design+zip",
  });
}

type ZipEntry = {
  start: number;
  size: number;
  compressed: number;
  method: number;
  crc: number;
};
// Inspect every central and local header before allocating any expanded entry.
// Forma v1 fits in classic single-disk ZIP (all offsets are below 512 MiB).
function packageDirectory(bytes: Uint8Array) {
  checkDesignFileSize(bytes.length, false);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = (p: number) => view.getUint16(p, true);
  const u32 = (p: number) => view.getUint32(p, true);
  const fail = () => new Error("Forma ZIP 文件目录无效");
  let end = bytes.length - 22;
  if (end < 4 || u32(0) !== 0x04034b50) throw fail();
  const lower = Math.max(0, end - 65535);
  while (
    end >= lower &&
    !(u32(end) === 0x06054b50 && end + 22 + u16(end + 20) === bytes.length)
  )
    end--;
  if (
    end < lower ||
    u16(end + 4) ||
    u16(end + 6) ||
    u16(end + 8) !== u16(end + 10)
  )
    throw fail();
  const startDir = u32(end + 16);
  if (startDir + u32(end + 12) !== end) throw fail();
  let cursor = startDir,
    total = 0,
    assetBytes = 0;
  const entries = new Map<string, ZipEntry>();
  const paths = new Set<string>();
  for (let i = 0; i < u16(end + 10); i++) {
    if (cursor + 46 > end || u32(cursor) !== 0x02014b50) throw fail();
    const nameEnd = cursor + 46 + u16(cursor + 28);
    const next = nameEnd + u16(cursor + 30) + u16(cursor + 32);
    if (next > end) throw fail();
    const name = strFromU8(bytes.subarray(cursor + 46, nameEnd));
    const normalized = name.normalize("NFC").replace(/\/$/, "");
    if (
      /^[A-Za-z]:|[\\\0]/.test(name) ||
      normalized.split("/").some((p) => !p || p === "." || p === "..") ||
      paths.has(normalized)
    )
      throw Error("ZIP 条目路径无效或重复：" + name);
    paths.add(normalized);
    const size = u32(cursor + 24),
      compressed = u32(cursor + 20);
    total += size;
    if (total > maxNativeBytes) throw Error("文件解压后超过 512 MiB");
    if (name.startsWith("assets/")) assetBytes += size;
    if (assetBytes > maxDocumentAssetBytes)
      throw Error("文件资源总量超过 256 MiB");
    const method = u16(cursor + 10),
      flags = u16(cursor + 8),
      local = u32(cursor + 42);
    if (
      (method !== 0 && method !== 8) ||
      flags & 1 ||
      (method === 0 && size !== compressed) ||
      local + 30 > startDir ||
      u32(local) !== 0x04034b50 ||
      u16(local + 6) !== flags ||
      u16(local + 8) !== method
    )
      throw fail();
    const localNameEnd = local + 30 + u16(local + 26),
      start = localNameEnd + u16(local + 28);
    if (
      start + compressed > startDir ||
      strFromU8(bytes.subarray(local + 30, localNameEnd)) !== name
    )
      throw Error("ZIP 本地路径或数据范围与目录不符");
    const crc = u32(cursor + 16);
    if (
      !(flags & 8) &&
      (u32(local + 14) !== crc ||
        u32(local + 18) !== compressed ||
        u32(local + 22) !== size)
    )
      throw Error("ZIP 本地条目与目录不符");
    entries.set(name, { start, size, compressed, method, crc });
    cursor = next;
  }
  if (cursor !== end) throw fail();
  return entries;
}
function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function parseManifest(input: unknown): FormaPackageManifest {
  if (
    !isObject(input) ||
    input.format !== "forma/package" ||
    input.packageVersion !== 1 ||
    input.schemaVersion !== 1 ||
    typeof input.docId !== "string" ||
    typeof input.name !== "string" ||
    typeof input.pages !== "number" ||
    !Number.isSafeInteger(input.pages) ||
    input.pages < 1 ||
    typeof input.nodeCount !== "number" ||
    !Number.isSafeInteger(input.nodeCount) ||
    input.nodeCount < 0 ||
    typeof input.updatedAt !== "string" ||
    !Number.isFinite(Date.parse(input.updatedAt)) ||
    (input.appVersion !== undefined && typeof input.appVersion !== "string") ||
    (input.previewPath !== undefined && input.previewPath !== "preview.svg") ||
    (input.documentPath !== "document.json" &&
      input.documentPath !== "document.parts.ndjson") ||
    !isObject(input.assets)
  )
    throw Error("无效的 Forma 包清单或不支持的版本");
  const assets: FormaPackageManifest["assets"] = {};
  let total = 0;
  for (const [id, a] of Object.entries(input.assets)) {
    if (
      !isObject(a) ||
      typeof a.mime !== "string" ||
      !/^[\w.+-]+\/[\w.+-]+$/.test(a.mime) ||
      typeof a.bytes !== "number" ||
      !Number.isSafeInteger(a.bytes) ||
      a.bytes <= 0 ||
      a.sha256 !== id.slice(id.indexOf("-") + 1) ||
      a.path !==
        assetPath(id, a.mime, id.startsWith("img-") ? "images" : "fonts")
    )
      throw Error("无效的资源清单：" + id);
    if (a.bytes > maxAssetBytes) throw Error("单个资源超过 32 MiB");
    total += a.bytes;
    if (total > maxDocumentAssetBytes) throw Error("文件资源总量超过 256 MiB");
    assets[id] = {
      path: a.path,
      mime: a.mime,
      bytes: a.bytes,
      sha256: a.sha256,
    };
  }
  return {
    format: input.format,
    packageVersion: input.packageVersion,
    schemaVersion: input.schemaVersion,
    docId: input.docId,
    name: input.name,
    pages: input.pages,
    nodeCount: input.nodeCount,
    updatedAt: input.updatedAt,
    documentPath: input.documentPath,
    previewPath: input.previewPath,
    appVersion: input.appVersion,
    assets,
  };
}
function unpackParts(
  bytes: Uint8Array,
  hydrate: (doc: DesignDocument) => DesignDocument,
) {
  const joined = joinDocumentParts();
  const media = new Map<string, string>();
  let offset = 0,
    first = true,
    ended = false;
  while (offset < bytes.length) {
    const newline = bytes.indexOf(10, offset);
    const end = newline < 0 ? bytes.length : newline;
    const line = strFromU8(bytes.subarray(offset, end));
    offset = end + 1;
    if (first) {
      if (line !== nativePartsPrefix) throw Error("分块设计文件头无效");
      first = false;
    } else if (ended) throw Error("设计文件结尾含额外数据");
    else if (line === nativePartsEnd) ended = true;
    else {
      if (!line.endsWith(",")) throw Error("分块设计文件截断");
      const part: DocumentPart = JSON.parse(line.slice(0, -1));
      if (part?.kind === "header") {
        part.document = mapMedia(hydrate(part.document), (id, data) => {
          media.set(id, data);
          return "@" + id;
        });
      }
      joined.push(part);
    }
  }
  if (!ended) throw Error("分块设计文件未完成");
  return joined.finish(media);
}

export async function decodeFormaPackage(
  bytes: Uint8Array,
): Promise<DesignDocument> {
  const entries = packageDirectory(bytes);
  function read(name: string, limit: number) {
    const entry = entries.get(name);
    if (!entry) throw Error("归档中缺少 " + name);
    if (entry.size > limit) throw Error("文件条目超过大小限制：" + name);
    const input = bytes.subarray(entry.start, entry.start + entry.compressed);
    let result = input;
    if (entry.method === 8) {
      // Inspect actual output length too, including streams with an understated header.
      result = new Uint8Array(entry.size);
      let written = 0;
      const inflater = new Inflate((chunk) => {
        if (written + chunk.length > entry.size)
          throw Error("解压长度超过声明值");
        result.set(chunk, written);
        written += chunk.length;
      });
      for (let i = 0; i < input.length; i += 8192)
        inflater.push(input.subarray(i, i + 8192), i + 8192 >= input.length);
      if (written !== entry.size) throw Error("解压长度不符：" + name);
    }
    if (crc32(result) !== entry.crc) throw Error("ZIP 内容校验失败：" + name);
    return result;
  }
  const manifest = parseManifest(
    JSON.parse(strFromU8(read("manifest.json", maxManifestBytes))),
  );
  const listedPaths = new Set(
    Object.values(manifest.assets).map((a) => a.path),
  );
  for (const path of entries.keys()) {
    if (
      path.startsWith("assets/") &&
      !path.endsWith("/") &&
      !listedPaths.has(path)
    )
      throw Error("归档包含未登记的资源：" + path);
  }
  if (manifest.previewPath) {
    const cover = entries.get(manifest.previewPath);
    if (!cover || cover.size > maxPreviewBytes)
      throw Error("包内预览图缺失或超限");
  }
  const dataById = new Map<string, string>();
  const sizes = new Map<string, { width: number; height: number }>();
  for (const [id, asset] of Object.entries(manifest.assets)) {
    if (entries.get(asset.path)?.size !== asset.bytes)
      throw Error("资源字节数与清单不符：" + id);
    const data =
      "data:" +
      asset.mime +
      ";base64," +
      encodeBase64(read(asset.path, maxAssetBytes));
    const size = await verifyEncodedAsset(id, data);
    if (size) sizes.set(id, size);
    dataById.set(id, data);
  }
  const used = new Set<string>();
  const hydrate = (doc: DesignDocument) =>
    mapMedia(doc, (id, data) => {
      const original = dataById.get(id);
      if (original === undefined) {
        if (
          !data ||
          data.startsWith("forma-asset://") ||
          data.includes(";base64,")
        )
          throw Error("文档缺少资源清单：" + id);
        return data;
      }
      if (data !== "" && data !== "forma-asset://" + id)
        throw Error("资源引用与清单不符：" + id);
      used.add(id);
      return original;
    });
  const payload = read(manifest.documentPath, maxNativeBytes);
  const restored =
    manifest.documentPath === "document.json"
      ? hydrate(JSON.parse(strFromU8(payload)))
      : unpackParts(payload, hydrate);
  if (used.size !== dataById.size) throw Error("清单包含未引用的资源");
  checkImageMetadata(restored, sizes);
  const doc = parseDocument(restored);
  if (
    manifest.docId !== doc.id ||
    manifest.name !== doc.name ||
    manifest.pages !== (doc.pages?.length ?? 1) ||
    manifest.nodeCount !== pageNodeCount(doc)
  )
    throw Error("文档与包清单不一致");
  return doc;
}
