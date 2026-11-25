import { resolveNode } from "../domain/design-system";
import type { DesignDocument } from "../domain/document";
import {
  joinDocumentParts,
  splitDocument,
  type DocumentPart,
} from "./document-parts";

export const partStore = "document-parts",
  assetStore = "document-assets";
export interface LocalSnapshot {
  format: "parts-v1";
  generation: number;
  chunks: number;
  assets: string[];
}
export type StoredSnapshot = LocalSnapshot | DesignDocument;
export function isPartitioned(
  s: StoredSnapshot | undefined,
): s is LocalSnapshot {
  return (
    !!s && typeof s === "object" && "format" in s && s.format === "parts-v1"
  );
}
export function query<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((res, rej) => {
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
}
export function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise((res, rej) => {
    tx.oncomplete = () => res();
    tx.onabort = () => rej(tx.error ?? Error("写入中断"));
  });
}
export function partitionRange(key: string, generation?: number) {
  const prefix = generation === undefined ? [key] : [key, generation];
  return IDBKeyRange.bound(prefix, [...prefix, []]);
}
export async function readSnapshot(
  tx: IDBTransaction,
  key: string,
  snap: StoredSnapshot,
) {
  if (!isPartitioned(snap)) return snap;
  const builder = joinDocumentParts(),
    assets = new Map<string, string>();
  const storedAssets = tx.objectStore(assetStore),
    chunks = tx.objectStore(partStore);
  let read = 0;
  await new Promise<void>((resolve, reject) => {
    const req = chunks.openCursor(partitionRange(key, snap.generation));
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) {
        resolve();
        return;
      }
      try {
        if ((cursor.key as IDBValidKey[])[2] !== read++)
          throw Error("存储分片次序无效");
        if (!Array.isArray(cursor.value)) throw Error("本机文档的存储分片无效");
        for (const part of cursor.value as DocumentPart[]) builder.push(part);
        cursor.continue();
      } catch (e) {
        reject(e);
      }
    };
  });
  if (read !== snap.chunks) throw Error("本机文档存储分片缺失");
  for (const id of snap.assets) {
    const data = await query(storedAssets.get([key, id]));
    if (typeof data !== "string") throw Error("本机文档缺少资源：" + id);
    assets.set(id, data);
  }
  return builder.finish(assets);
}
export async function writeSnapshot(
  tx: IDBTransaction,
  key: string,
  generation: number,
  split: ReturnType<typeof splitDocument>,
  existing: Set<string>,
) {
  const asset = tx.objectStore(assetStore),
    chunks = tx.objectStore(partStore);
  for (const [id, data] of split.assets)
    if (!existing.has(id)) await query(asset.put(data, [key, id]));
  let index = 0,
    count = 0,
    batch: DocumentPart[] = [];
  for (const part of split.parts()) {
    const weight =
      part.kind === "page" || part.kind === "variant" ? part.nodes.length : 1;
    batch.push(part);
    count += weight;
    if (
      part.kind === "issues" ||
      part.kind === "page" ||
      part.kind === "variant" ||
      count >= 128 ||
      batch.length >= 32
    ) {
      await query(chunks.put(batch, [key, generation, index++]));
      batch = [];
      count = 0;
    }
  }
  if (batch.length) await query(chunks.put(batch, [key, generation, index++]));
  return {
    format: "parts-v1",
    chunks: index,
    generation,
    assets: [...split.assets.keys()],
  } satisfies LocalSnapshot;
}

// The first page is stored before inactive pages and library definitions. File
// cards only need that scene and the binary assets reachable from its layers.
export async function readPreviewSnapshot(
  tx: IDBTransaction,
  key: string,
  snap: LocalSnapshot,
): Promise<DesignDocument> {
  let preview: DesignDocument | undefined;
  await new Promise<void>((resolve, reject) => {
    const req = tx
      .objectStore(partStore)
      .openCursor(partitionRange(key, snap.generation));
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) {
        resolve();
        return;
      }
      try {
        for (const part of cursor.value as DocumentPart[]) {
          if (part.kind === "header") {
            const { pages, activePage, libraries, ...rest } = part.document;
            preview = { ...rest, nodes: [] };
          } else if (part.kind === "page" && part.page === null && preview)
            preview.nodes.push(...part.nodes);
          else {
            resolve();
            return;
          }
        }
        cursor.continue();
      } catch (err) {
        reject(err);
      }
    };
  });
  if (!preview) throw Error("文件预览缺少文档头");
  const scene = preview as DesignDocument,
    byId = new Map(scene.nodes.map((n) => [n.id, n]));
  const images = new Set<string>(),
    fonts = new Set<string>();
  for (const n of scene.nodes) {
    const node = resolveNode(scene, n, byId);
    if (node.image) images.add(node.image.assetId);
    for (const family of [
      node.style.fontFamily,
      ...(node.textRuns ?? []).map((r) => r.style.fontFamily),
    ])
      for (const id of family?.match(/font-[a-f0-9]{64}/g) ?? []) fonts.add(id);
  }
  const assets = tx.objectStore(assetStore);
  for (const [keyName, ids] of [
    ["images", images],
    ["fonts", fonts],
  ] as const) {
    const source = scene[keyName];
    const target: Record<string, unknown> = {};
    for (const id of ids) {
      if (!source?.[id]) continue;
      const data = await query(assets.get([key, id]));
      if (typeof data !== "string") throw Error("预览缺少资源：" + id);
      target[id] = { ...source[id], data };
    }
    Object.assign(scene, { [keyName]: target });
  }
  return scene;
}
