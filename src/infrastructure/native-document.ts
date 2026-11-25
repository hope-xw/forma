import { verifyEncodedAsset, checkImageMetadata } from "./verified-asset";
import { parseDocument, type DesignDocument } from "../domain/document";
import {
  assetByteLength,
  maxDocumentAssetBytes,
  maxEncodedAssetLength,
} from "../domain/asset-bytes";
import {
  joinDocumentParts,
  splitDocument,
  useLargeDocumentFormat,
  type DocumentPart,
} from "./document-parts";
const prefix = '{"format":"forma/design-parts","version":1,"records":[';
const end = '{"kind":"end"}]}';
type DataRow = {
  kind: "asset";
  id: string;
  offset: number;
  size: number;
  data: string;
};

// Each line is a bounded complete JSON value. The outer file is ordinary
// valid JSON and can be inspected without a custom decompressor.
function* nativeTextParts(doc: DesignDocument): Generator<string> {
  if (!useLargeDocumentFormat(doc)) {
    yield JSON.stringify(doc, null, 2);
    return;
  }
  const split = splitDocument(doc);
  yield prefix + "\n";
  for (const part of split.parts()) yield JSON.stringify(part) + ",\n";
  for (const [id, value] of split.assets)
    for (let offset = 0; offset < value.length; offset += 512 * 1024)
      yield (
        JSON.stringify({
          kind: "asset",
          id,
          offset,
          size: value.length,
          data: value.slice(offset, offset + 512 * 1024),
        } satisfies DataRow) + ",\n"
      );
  yield end + "\n";
}
/** Synchronous compiler API for callers that require the source as text. */
export function nativeDocumentText(doc: DesignDocument): string {
  return Array.from(nativeTextParts(doc)).join("");
}
export function nativeDocumentBlob(doc: DesignDocument): Blob {
  const groups: Blob[] = [],
    batch: string[] = [];
  let length = 0;
  for (const line of nativeTextParts(doc)) {
    batch.push(line);
    length += line.length;
    if (length >= 2 * 1024 * 1024) {
      groups.push(new Blob(batch));
      batch.length = 0;
      length = 0;
    }
  }
  if (batch.length) groups.push(new Blob(batch));
  return new Blob(groups, { type: "application/json" });
}

export async function readNativeDocument(file: Blob): Promise<DesignDocument> {
  const canonical =
    (await file.slice(0, prefix.length + 1).text()) === prefix + "\n";
  const result = joinDocumentParts(),
    assets = new Map<string, string>(),
    sizes = new Map<string, { width: number; height: number }>();
  function finish() {
    const doc = result.finish(assets);
    checkImageMetadata(doc, sizes);
    return parseDocument(doc);
  }
  let pending:
    { id: string; size: number; length: number; parts: string[] } | undefined;
  let first = true,
    ended = false,
    total = 0;
  async function line(text: string) {
    if (first) {
      first = false;
      if (text !== prefix) throw Error("分块设计文件头无效");
      return;
    }
    if (ended) throw Error("设计文件结尾含额外数据");
    if (text === end) {
      if (pending) throw Error("设计文件资源末尾不完整");
      ended = true;
      return;
    }
    if (!text.endsWith(",")) throw Error("分块设计文件截断");
    await record(JSON.parse(text.slice(0, -1)));
  }
  async function record(row: DocumentPart | DataRow) {
    if (!row || typeof row !== "object") throw Error("分块文件包含无效的记录");
    if (row.kind !== "asset") {
      if (pending) throw Error("设计文件资源分块错序");
      result.push(row);
      return;
    }
    if (
      typeof row.data !== "string" ||
      typeof row.id !== "string" ||
      !/^((img)|(font))-[a-f0-9]{64}$/.test(row.id) ||
      !Number.isInteger(row.size) ||
      row.size < 1 ||
      row.size > maxEncodedAssetLength ||
      !row.data.length ||
      row.data.length > 512 * 1024
    )
      throw Error("资源分块无效");
    if (!pending) {
      if (assets.has(row.id) || row.offset !== 0)
        throw Error("资源分块 ID 或顺序无效");
      pending = { id: row.id, size: row.size, length: 0, parts: [] };
    }
    if (
      row.id !== pending.id ||
      row.offset !== pending.length ||
      row.size !== pending.size ||
      row.offset + row.data.length > row.size
    )
      throw Error("资源分块错序");
    pending.length += row.data.length;
    pending.parts.push(row.data);
    if (pending.length === pending.size) {
      const value = pending.parts.join("");
      pending = undefined;
      total += assetByteLength(value);
      if (total > maxDocumentAssetBytes)
        throw Error("文件资源总量超过 256 MiB");
      const size = await verifyEncodedAsset(row.id, value);
      if (size) sizes.set(row.id, size);
      assets.set(row.id, value);
    }
  }
  if (!canonical) {
    const object = JSON.parse(await file.text());
    if (object?.format !== "forma/design-parts") return parseDocument(object);
    if (
      object.version !== 1 ||
      !Array.isArray(object.records) ||
      object.records.at(-1)?.kind !== "end"
    )
      throw Error("无效的分块设计文件");
    for (let i = 0; i < object.records.length - 1; i++)
      await record(object.records[i]);
    if (pending) throw Error("设计文件资源末尾不完整");
    return finish();
  }
  const reader = file.stream().getReader(),
    decoder = new TextDecoder("utf-8", { fatal: true });
  let tail = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      const chunk =
        tail +
        (done ? decoder.decode() : decoder.decode(value, { stream: true }));
      const lines = chunk.split("\n");
      tail = lines.pop()!;
      for (const row of lines) await line(row);
      if (tail.length > 64 * 1024 * 1024) throw Error("设计文件的单行数据超限");
      if (done) break;
    }
    if (tail) await line(tail);
    if (!ended) throw Error("分块设计文件未完成");
    return finish();
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
