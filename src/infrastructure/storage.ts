import { parseDocument, type DesignDocument } from "../domain/document";

import { splitDocument, useLargeDocumentFormat } from "./document-parts";
import { verifyEncodedAsset, checkImageMetadata } from "./verified-asset";
import { nativeDocumentBlob } from "./native-document";
import {
  query,
  readSnapshot,
  readPreviewSnapshot,
  writeSnapshot,
  isPartitioned,
  transactionDone,
  partStore,
  assetStore,
  partitionRange,
  type StoredSnapshot,
} from "./storage-parts";

interface FileRecord {
  generation: number;
  current: StoredSnapshot;
  previous?: StoredSnapshot;
}
export interface DocumentRepository {
  load(): Promise<DesignDocument | null>;
  save(document: DesignDocument): Promise<void>;
  recovery(): Promise<DesignDocument | null>;
  backup(): Promise<unknown>;
}
const storeName = "documents";
const catalogName = "files";
export interface FileSummary {
  key: string;
  name: string;
  updatedAt: number;
  pages: number;
}
const summary = (
  key: string,
  doc: DesignDocument,
  updatedAt = Date.now(),
): FileSummary => ({
  key,
  name: doc.name,
  updatedAt,
  pages: doc.pages?.length ?? 1,
});
let sharedDb: Promise<IDBDatabase> | undefined;
let recentCatalog: FileSummary[] = [];

function upsertCatalog(entry: FileSummary) {
  recentCatalog = [
    entry,
    ...recentCatalog.filter((item) => item.key !== entry.key),
  ].sort((a, b) => b.updatedAt - a.updatedAt);
}

export function cachedRecentFiles(): FileSummary[] {
  return recentCatalog;
}

function openDatabase(): Promise<IDBDatabase> {
  if (sharedDb) return sharedDb;
  sharedDb = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("forma-studio", 3);
    request.onupgradeneeded = () => {
      const db = request.result;
      for (const name of [partStore, assetStore])
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name);
      if (!db.objectStoreNames.contains(storeName))
        db.createObjectStore(storeName);
      if (!db.objectStoreNames.contains(catalogName)) {
        const catalog = db.createObjectStore(catalogName, { keyPath: "key" });
        const cursor = request.transaction!.objectStore(storeName).openCursor();
        cursor.onsuccess = () => {
          const item = cursor.result;
          if (!item) return;
          const doc = item.value?.current;
          if (doc?.name) catalog.put(summary(String(item.key), doc, 0));
          item.continue();
        };
      }
    };
    request.onerror = () => {
      sharedDb = undefined;
      reject(request.error);
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => {
        sharedDb = undefined;
        db.close();
      };
      db.onclose = () => {
        sharedDb = undefined;
      };
      resolve(db);
    };
  });
  return sharedDb;
}
/** Each write verifies the loaded generation and retains the preceding complete snapshot atomically. */
export class BrowserDocumentRepository implements DocumentRepository {
  private generation = 0;
  private queue: Promise<void> = Promise.resolve();
  constructor(readonly key = "forma.document.v1") {}
  private database() {
    return openDatabase();
  }
  private knownAssets = new Map<string, string>();
  private readonly knownSizes = new Map<
    string,
    { width: number; height: number }
  >();
  private async read(which: "current" | "previous", remember = false) {
    const db = await this.database(),
      tx = db.transaction([storeName, partStore, assetStore]);
    const record = await query<FileRecord | undefined>(
      tx.objectStore(storeName).get(this.key),
    );
    if (remember) this.generation = record?.generation ?? 0;
    const snapshot = record?.[which];
    if (!snapshot) return null;
    const doc = parseDocument(await readSnapshot(tx, this.key, snapshot));
    if (remember && isPartitioned(snapshot)) {
      this.knownAssets.clear();
      this.knownSizes.clear();
      for (const scope of [doc, ...Object.values(doc.libraries ?? {})]) {
        for (const [id, image] of Object.entries(scope.images ?? {})) {
          this.knownAssets.set(id, image.data);
          this.knownSizes.set(id, { width: image.width, height: image.height });
        }
        for (const [id, font] of Object.entries(scope.fonts ?? {}))
          this.knownAssets.set(id, font.data);
      }
    }
    return doc;
  }
  async load() {
    const stored = await this.read("current", true);
    void recentFiles().catch(() => {});
    if (stored) return stored;
    const legacy = localStorage.getItem(this.key);
    if (!legacy) return null;
    const doc = parseDocument(JSON.parse(legacy));
    await this.save(doc);
    return doc;
  }
  async recovery() {
    return this.read("previous");
  }
  async backup() {
    const db = await this.database(),
      tx = db.transaction([storeName, partStore, assetStore]);
    const record = await query<FileRecord | undefined>(
      tx.objectStore(storeName).get(this.key),
    );
    if (!record) return localStorage.getItem(this.key);
    if (!isPartitioned(record.current) && !isPartitioned(record.previous))
      return record;
    // Keep the sibling read alive when one IDB request (rather than the data it
    // returned) fails. Both generations still share a consistent readonly view.
    tx.onerror = (event) => event.preventDefault();
    const pieces: BlobPart[] = ['{"generation":', String(record.generation)];
    async function recover(
      which: "current" | "previous",
      snap: StoredSnapshot,
      key: string,
    ): Promise<BlobPart[]> {
      try {
        return [
          ',"' + which + '":',
          nativeDocumentBlob(await readSnapshot(tx, key, snap)),
        ];
      } catch (error) {
        return [
          ',"' + which + 'Error":',
          JSON.stringify(
            error instanceof Error ? error.message : String(error),
          ),
        ];
      }
    }
    const [current, previous] = await Promise.all([
      recover("current", record.current, this.key),
      record.previous ? recover("previous", record.previous, this.key) : [],
    ]);
    pieces.push(...current, ...previous);
    pieces.push("}");
    return new Blob(pieces, { type: "application/json" });
  }

  save(document: DesignDocument) {
    const pending = this.queue
      .then(() => this.write(document))
      .catch((error: unknown) => {
        if (
          error &&
          typeof error === "object" &&
          "name" in error &&
          error.name === "QuotaExceededError"
        )
          throw Error(
            "浏览器本地存储空间不足，请先清理旧设计文件或下载本地副本后重试。",
            { cause: error },
          );
        throw error;
      });
    this.queue = pending.catch(() => {});
    return pending;
  }
  private async write(document: DesignDocument): Promise<void> {
    const split = useLargeDocumentFormat(document)
      ? splitDocument(document)
      : undefined;
    for (const [id, data] of split?.assets ?? [])
      if (this.knownAssets.get(id) !== data) {
        const dimensions = await verifyEncodedAsset(id, data);
        if (dimensions) this.knownSizes.set(id, dimensions);
      }
    if (split) checkImageMetadata(document, this.knownSizes);
    const db = await this.database();
    const tx = db.transaction(
        [storeName, catalogName, partStore, assetStore],
        "readwrite",
      ),
      done = transactionDone(tx);
    // Consume abort completion even when a request rejects first.
    void done.catch(() => {});
    const store = tx.objectStore(storeName),
      next = this.generation + 1;
    let entry: FileSummary;
    try {
      const old = await query<FileRecord | undefined>(store.get(this.key));
      if ((old?.generation ?? 0) !== this.generation)
        throw Error(
          "此文件已在另一个标签页更新。请先下载当前设计，再重新打开文件。",
        );
      const keep = new Set(
          isPartitioned(old?.current) ? old.current.assets : [],
        ),
        previous = isPartitioned(old?.previous) ? old.previous : undefined;
      const already = new Set([...keep, ...(previous?.assets ?? [])]);
      const current = split
        ? await writeSnapshot(tx, this.key, next, split, already)
        : document;
      if (isPartitioned(current)) for (const id of current.assets) keep.add(id);
      if (previous) {
        tx.objectStore(partStore).delete(
          partitionRange(this.key, previous.generation),
        );
        for (const id of previous.assets)
          if (!keep.has(id)) tx.objectStore(assetStore).delete([this.key, id]);
      }
      store.put(
        { generation: next, current, previous: old?.current },
        this.key,
      );
      entry = summary(this.key, document);
      tx.objectStore(catalogName).put(entry);
      await done;
    } catch (error) {
      try {
        tx.abort();
      } catch {
        /* Already aborted or complete. */
      }
      throw error;
    }
    this.generation = next;
    this.knownAssets = split?.assets ?? new Map();
    upsertCatalog(entry);
  }
}
export async function recentFiles(): Promise<FileSummary[]> {
  const db = await openDatabase();
  const files = await new Promise<FileSummary[]>((resolve, reject) => {
    const r = db.transaction(catalogName).objectStore(catalogName).getAll();
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  recentCatalog = files.sort((a, b) => b.updatedAt - a.updatedAt);
  return recentCatalog;
}
export const fileUrl = (key: string) =>
  key === "forma.document.v1"
    ? "./"
    : key === "forma.example.aura-showcase.v1"
      ? "?example=aura-showcase"
      : key === "forma.example.mobile-studio.atlas"
        ? "?example=mobile-studio&edition=atlas"
        : key === "forma.example.mobile-studio.v1"
          ? "?example=mobile-studio"
          : key === "forma.example.mobile-studio.flows"
            ? "?example=mobile-studio&edition=flows"
            : "?file=" + encodeURIComponent(key);
export async function createLocalFile(doc: DesignDocument) {
  const key = "forma.file." + crypto.randomUUID();
  await new BrowserDocumentRepository(key).save(doc);
  return fileUrl(key);
}
export async function readLocalDocument(
  key: string,
): Promise<DesignDocument | null> {
  const db = await openDatabase(),
    tx = db.transaction([storeName, partStore, assetStore]);
  const record = await query<FileRecord | undefined>(
    tx.objectStore(storeName).get(key),
  );
  return record
    ? parseDocument(await readSnapshot(tx, key, record.current))
    : null;
}
export async function readLocalPreview(key: string) {
  const db = await openDatabase(),
    tx = db.transaction([storeName, partStore, assetStore]);
  const record = await query<FileRecord | undefined>(
    tx.objectStore(storeName).get(key),
  );
  if (!record) return null;
  return isPartitioned(record.current)
    ? readPreviewSnapshot(tx, key, record.current)
    : parseDocument(record.current);
}
export async function deleteLocalFile(key: string): Promise<void> {
  const db = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(
      [storeName, catalogName, partStore, assetStore],
      "readwrite",
    );
    tx.objectStore(partStore).delete(partitionRange(key));
    tx.objectStore(assetStore).delete(partitionRange(key));
    tx.objectStore(storeName).delete(key);
    tx.objectStore(catalogName).delete(key);
    tx.oncomplete = () => {
      recentCatalog = recentCatalog.filter((f) => f.key !== key);
      localStorage.removeItem(key);
      resolve();
    };
    tx.onabort = () => reject(tx.error ?? Error("删除本机文件中断"));
  });
}
export async function renameLocalFile(
  key: string,
  name: string,
): Promise<void> {
  const trimmed = name.trim();
  if (!trimmed) return;
  const repo = new BrowserDocumentRepository(key);
  const doc = await repo.load();
  if (!doc) return;
  await repo.save({ ...doc, name: trimmed });
}
export function download(
  name: string,
  content: string | Blob,
  type = "application/json",
) {
  const url = URL.createObjectURL(
    content instanceof Blob ? content : new Blob([content], { type }),
  );
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
