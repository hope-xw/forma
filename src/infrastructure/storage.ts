import { parseDocument, type DesignDocument } from "../domain/document";

import {
  beginWorkspaceScopeFence,
  bumpWorkspaceScopeFence,
  registerCatalogFileGuard,
  withFenceOpClaim,
  fallbackFenceOpActive,
  isFallbackFenceOp,
  verifyFallbackFenceClaim,
  endWorkspaceScopeFence,
} from "./library-catalog-store";
import { splitDocument, useLargeDocumentFormat } from "./document-parts";
import { verifyEncodedAsset, checkImageMetadata } from "./verified-asset";
import { nativeDocumentBlob } from "./native-document";
import {
  removeFileMemoryState,
  clearFileMemoryTombstone,
  FileLifetimeMismatchError,
  withFileProjectScopeLock,
} from "./project-memory-store";
import {
  query,
  readSnapshot,
  readPreviewSnapshot,
  writeSnapshot,
  isPartitioned,
  isValidGeneration,
  transactionDone,
  partStore,
  assetStore,
  partitionRange,
  type StoredSnapshot,
} from "./storage-parts";

interface FileRecord {
  lifetimeToken?: string;
  replacementEpoch?: number;
  generation: number;
  current: StoredSnapshot;
  previous?: StoredSnapshot;
}
export interface DocumentRepository {
  load(): Promise<DesignDocument | null>;
  save(
    document: DesignDocument,
    options?: { replacedDocument?: boolean },
  ): Promise<void>;
  getLifetimeToken?(): string | undefined;
  getDocumentEpoch?(): number | undefined;
  recovery(): Promise<DesignDocument | null>;
  backup(): Promise<unknown>;
}
const storeName = "documents";
const catalogName = "files";
export interface LocalFileSummary {
  lifetimeToken?: string;
  key: string;
  name: string;
  updatedAt: number;
  pages: number;
}
export type FileSummary = LocalFileSummary;
const summary = (
  key: string,
  doc: DesignDocument,
  updatedAt = Date.now(),
  lifetimeToken: string = crypto.randomUUID(),
): FileSummary => ({
  key,
  lifetimeToken,
  name: doc.name,
  updatedAt,
  pages: doc.pages?.length ?? 1,
});
let sharedDb: Promise<IDBDatabase> | undefined;
let recentCatalog: FileSummary[] = [];
const cleanupQueueKey = "forma.pending-file-memory-cleanup";

const pendingCleanupRecordKey = "__forma_internal_pending_memory_cleanups__";
const committedOpsRecordKey = "__forma_internal_committed_ops__";
const commitRecordPrefix = "__forma_internal_commit__:";
const commitRecordKey = (commitId: string) => commitRecordPrefix + commitId;
const pendingFenceRecordKey = "__forma_internal_pending_file_fences__";
type FenceIntent = { fileKey: string; docId: string; opId: string };
const retiredLegacyRecordKey = "__forma_internal_retired_legacy_keys__";
type CleanupIntent = {
  fenceOp?: string;
  fenceInvalidated?: boolean;
  fileKey: string;
  deletedDocId?: string;
  deletedLifetimeToken?: string;
};
type RetiredLegacyKeys = {
  fenceClaims?: Record<string, number>;
  keys: string[];
  pendingLocalStorageRemovals: string[];
};

function internalKey(key: IDBValidKey) {
  return (
    key === committedOpsRecordKey ||
    (typeof key === "string" && key.startsWith(commitRecordPrefix)) ||
    key === pendingCleanupRecordKey ||
    key === retiredLegacyRecordKey ||
    key === pendingFenceRecordKey
  );
}
function checkFileKey(key: string) {
  if (internalKey(key)) throw new Error("此键由本地文件存储保留");
}

async function retiredLegacyKeys(
  store: IDBObjectStore,
): Promise<RetiredLegacyKeys> {
  return (
    (await query<RetiredLegacyKeys | undefined>(
      store.get(retiredLegacyRecordKey),
    )) ?? { keys: [], pendingLocalStorageRemovals: [] }
  );
}

async function retireLegacyKey(
  store: IDBObjectStore,
  key: string,
  queueRemoval: boolean,
) {
  const record = await retiredLegacyKeys(store);
  if (!queueRemoval && record.keys.includes(key)) return false;
  if (!record.keys.includes(key)) record.keys.push(key);
  if (queueRemoval && !record.pendingLocalStorageRemovals.includes(key))
    record.pendingLocalStorageRemovals.push(key);
  store.put(record, retiredLegacyRecordKey);
  return true;
}

// Acknowledge localStorage removal independently of project-memory cleanup.
async function retryLegacyRemovals(
  db: IDBDatabase,
  key?: string,
  deleted = false,
) {
  const tx = db.transaction(storeName, "readwrite");
  const store = tx.objectStore(storeName);
  const [retired] = await Promise.all([
    retiredLegacyKeys(store).then((record) => {
      // A committed cleanup from an older version can predate the retirement record.
      const newlyRetired =
        deleted && key !== undefined && !record.keys.includes(key);
      if (newlyRetired) record.keys.push(key);
      const retired = key !== undefined && record.keys.includes(key);
      const pending = new Set(record.pendingLocalStorageRemovals);
      if (retired) pending.add(key);
      const remaining: string[] = [];
      for (const entry of pending) {
        try {
          localStorage.removeItem(entry);
        } catch {
          remaining.push(entry);
        }
      }
      if (
        newlyRetired ||
        remaining.length !== record.pendingLocalStorageRemovals.length ||
        remaining.some(
          (entry, i) => entry !== record.pendingLocalStorageRemovals[i],
        )
      )
        store.put(
          { ...record, pendingLocalStorageRemovals: remaining },
          retiredLegacyRecordKey,
        );
      return retired;
    }),
    transactionDone(tx),
  ]);
  return retired;
}

function cleanupIntents(store: IDBObjectStore): Promise<CleanupIntent[]> {
  return query<
    (CleanupIntent | { key: string; deletedDocId?: string })[] | undefined
  >(store.get(pendingCleanupRecordKey)).then((rows) =>
    (rows ?? []).map((row) =>
      "fileKey" in row
        ? row
        : { fileKey: row.key, deletedDocId: row.deletedDocId },
    ),
  );
}

async function fenceIntents(store: IDBObjectStore): Promise<FenceIntent[]> {
  return (
    (await query<FenceIntent[] | undefined>(
      store.get(pendingFenceRecordKey),
    )) ?? []
  );
}

async function flushFenceIntent(db: IDBDatabase, intent: FenceIntent) {
  await bumpWorkspaceScopeFence({ fileKey: intent.fileKey });
  const tx = db.transaction(storeName, "readwrite");
  const store = tx.objectStore(storeName);
  await Promise.all([
    transactionDone(tx),
    fenceIntents(store).then((rows) => {
      const remaining = rows.filter((row) => row.opId !== intent.opId);
      if (remaining.length === rows.length) return;
      if (remaining.length) store.put(remaining, pendingFenceRecordKey);
      else store.delete(pendingFenceRecordKey);
    }),
  ]);
}

// Older versions recorded intents before the file transaction in localStorage.
function legacyCleanupKeys(): string[] {
  try {
    const keys: unknown = JSON.parse(
      localStorage.getItem(cleanupQueueKey) ?? "[]",
    );
    if (Array.isArray(keys))
      return keys.filter(
        (key): key is string => typeof key === "string" && !internalKey(key),
      );
  } catch {
    /* Storage access is optional. */
  }
  return [];
}

function forgetLegacyCleanup(key: string) {
  const keys = legacyCleanupKeys();
  if (!keys.includes(key)) return;
  try {
    const rest = keys.filter((other) => other !== key);
    if (rest.length)
      localStorage.setItem(cleanupQueueKey, JSON.stringify(rest));
    else localStorage.removeItem(cleanupQueueKey);
  } catch {
    /* IndexedDB tracks all new deletions. */
  }
}

let cleanupQueue = Promise.resolve();
function withCleanupLock<T>(work: () => Promise<T>): Promise<T> {
  const result = cleanupQueue.then(async () => {
    return (
      globalThis.navigator?.locks?.request(cleanupQueueKey, work) ?? work()
    );
  });
  cleanupQueue = result.then(
    () => {},
    () => {},
  );
  return result;
}

function deletionFenceClaims(db: IDBDatabase) {
  return {
    db,
    store: storeName,
    key: retiredLegacyRecordKey,
    initial: { keys: [], pendingLocalStorageRemovals: [] },
    inlineKey: false,
  };
}
export async function checkDeleteFenceOp(opId: string) {
  const db = await openDatabase();
  const rows = await cleanupIntents(
    db.transaction(storeName).objectStore(storeName),
  );
  if (rows.some((row) => row.fenceOp === opId)) return "completed" as const;
  if (
    isFallbackFenceOp(opId) &&
    (await fallbackFenceOpActive(deletionFenceClaims(db), opId))
  )
    return "active" as const;
  return "abandoned" as const;
}

async function finishDeletedFileCleanup(
  db: IDBDatabase,
  intent: CleanupIntent,
) {
  const { fileKey: key, deletedDocId, deletedLifetimeToken } = intent;
  // Invalidate independently of memory availability. Keeping both milestones
  // in the original deletion intent makes a crash between databases retryable.
  const invalidation = async () => {
    if (intent.fenceInvalidated) return;
    if (intent.fenceOp)
      await endWorkspaceScopeFence({ fileKey: key }, intent.fenceOp);
    else await bumpWorkspaceScopeFence({ fileKey: key });
    const tx = db.transaction(storeName, "readwrite");
    const store = tx.objectStore(storeName);
    await Promise.all([
      transactionDone(tx),
      cleanupIntents(store).then((rows) => {
        const row = rows.find(
          (row) =>
            row.fileKey === key &&
            row.fenceOp === intent.fenceOp &&
            row.deletedLifetimeToken === deletedLifetimeToken &&
            row.deletedDocId === deletedDocId,
        );
        if (row) {
          row.fenceInvalidated = true;
          store.put(rows, pendingCleanupRecordKey);
        }
      }),
    ]);
  };
  const [fence, memory] = await Promise.allSettled([
    invalidation(),
    removeFileMemoryState(key, { deletedDocId, deletedLifetimeToken }),
  ]);
  await retryLegacyRemovals(db, key, true);
  if (fence.status === "rejected") throw fence.reason;
  if (memory.status === "rejected") throw memory.reason;

  // A new file may have been saved at this key while memory writes were denied.
  // Retire the old lifetime first, then activate the committed replacement.
  const live = await readLiveFileState(key);
  if (!live) throw new Error("无法核验文件清理状态，请稍后重试");
  if (live.exists) {
    if (
      !live.docId ||
      !live.lifetimeToken ||
      live.lifetimeToken === deletedLifetimeToken
    )
      throw new Error("无法核验替换文件的生命周期，请稍后重试");
    await clearFileMemoryTombstone(
      key,
      {
        activeDocId: live.docId,
        activeDocGeneration: live.generation,
        activeDocEpoch: live.documentEpoch,
        activeLifetimeToken: live.lifetimeToken,
      },
      { requireDurable: true },
    );
  }

  // Without Web Locks a second tab may have committed a replacement during
  // activation. Acknowledge only the identity verified by this cleanup.
  const tx = db.transaction([storeName, catalogName, partStore], "readwrite");
  const store = tx.objectStore(storeName);
  await Promise.all([
    transactionDone(tx),
    Promise.all([cleanupIntents(store), liveFileIn(tx, key)]).then(
      ([rows, current]) => {
        if (
          !current ||
          live.exists !== current.exists ||
          live.lifetimeToken !== current.lifetimeToken ||
          live.docId !== current.docId ||
          live.generation !== current.generation
        )
          throw new Error("文件清理期间源文件已变更，请稍后重试");
        const remaining = rows.filter(
          (row) =>
            row.fileKey !== key ||
            row.fenceOp !== intent.fenceOp ||
            row.deletedDocId !== deletedDocId ||
            row.deletedLifetimeToken !== deletedLifetimeToken,
        );
        if (remaining.length === rows.length) return;
        if (remaining.length) store.put(remaining, pendingCleanupRecordKey);
        else store.delete(pendingCleanupRecordKey);
      },
    ),
  ]);
  forgetLegacyCleanup(key);
}

// All callers hold the cleanup lock. An intent is acknowledged only after the
// memory transaction commits, including when retrying an older journal format.
async function flushFileCleanup(db: IDBDatabase, key: string) {
  const store = db.transaction(storeName).objectStore(storeName);
  const rows = await cleanupIntents(store);
  let intent = rows.find((row) => row.fileKey === key);
  if (!intent && legacyCleanupKeys().includes(key)) {
    if (
      (await query(
        db.transaction(storeName).objectStore(storeName).getKey(key),
      )) === undefined
    )
      intent = { fileKey: key };
    else forgetLegacyCleanup(key);
  }
  if (!intent) return false;
  await finishDeletedFileCleanup(db, intent);
  return true;
}

export async function assertFileMemoryWritable(
  fileKey: string,
  expectedLifetimeToken?: string,
) {
  if (typeof indexedDB === "undefined") return;
  return withCleanupLock(async () => {
    const db = await openDatabase();
    if (await flushFileCleanup(db, fileKey))
      throw new Error("该设计文件已删除，请刷新文件列表后重试");
    const live = await readFileLifetime(db, fileKey);
    if (expectedLifetimeToken && live !== expectedLifetimeToken)
      throw new FileLifetimeMismatchError(
        "该设计文件已删除或已替换，请刷新文件列表后重试",
      );
    return live;
  });
}

// These checks can run inside the memory repository queue. They must never
// call back into memory cleanup, or keep a memory transaction open across databases.
export async function checkPendingFileDeletion(
  fileKey: string,
): Promise<"clean" | "pending" | "unavailable"> {
  try {
    const db = await openDatabase();
    const store = db.transaction(storeName).objectStore(storeName);
    const [rows, key] = await Promise.all([
      cleanupIntents(store),
      query(store.getKey(fileKey)),
    ]);
    return rows.some((row) => row.fileKey === fileKey) ||
      (key === undefined && legacyCleanupKeys().includes(fileKey))
      ? "pending"
      : "clean";
  } catch {
    return "unavailable";
  }
}

// The scope lock spans both checks. A connection can still close between the
// pending-intent read and the legacy catalog-token backfill.
export async function checkArchiveFile(
  fileKey: string,
  expectedLifetimeToken?: string,
) {
  const status = await checkPendingFileDeletion(fileKey);
  if (status !== "clean") return { status, token: expectedLifetimeToken };
  let token: string | undefined;
  try {
    token = await readFileLifetime(await openDatabase(), fileKey);
  } catch {
    return { status: "unavailable" as const, token: expectedLifetimeToken };
  }
  if (expectedLifetimeToken !== undefined && token !== expectedLifetimeToken)
    return { status: "stale" as const, token };
  return { status, token };
}

async function storedDocumentId(
  tx: IDBTransaction,
  key: string,
  current?: StoredSnapshot,
) {
  if (!isPartitioned(current)) return current?.id;
  if (!isValidGeneration(current.generation)) return undefined;
  const chunk = await query(
    tx.objectStore(partStore).get([key, current.generation, 0]),
  );
  const id = chunk?.[0]?.document?.id;
  return typeof id === "string" ? id : undefined;
}

async function liveFileIn(tx: IDBTransaction, fileKey: string) {
  const [record, entry] = await Promise.all([
    query<FileRecord | undefined>(tx.objectStore(storeName).get(fileKey)),
    query<FileSummary | undefined>(tx.objectStore(catalogName).get(fileKey)),
  ]);
  const docId = await storedDocumentId(tx, fileKey, record?.current);
  if (record && !docId) return null;
  return {
    exists: !!record,
    lifetimeToken: record?.lifetimeToken ?? entry?.lifetimeToken,
    docId,
    generation: record?.generation,
    documentEpoch: record && (record.replacementEpoch ?? 1),
  };
}
// This transaction shares the document writer's stores. A suspended caller can
// never authorize an identity it observed before a committed replacement.
export async function authorizeFileCommit(
  input: {
    commitId: string;
    fileKey: string;
    expectedDocId?: string;
    expectedDocumentEpoch?: number;
    expectedLifetimeToken?: string;
    requireNoPendingDeletion?: boolean;
    requireNoPendingReplacement?: boolean;
    requireBoundLifetime?: boolean;
    binding?: Record<string, unknown>;
  },
  stageExpiresAt = Infinity,
): Promise<"authorized" | "rejected" | "unavailable"> {
  try {
    const db = await openDatabase();
    const tx = db.transaction([storeName, catalogName, partStore], "readwrite");
    const done = transactionDone(tx);
    void done.catch(() => {});
    const store = tx.objectStore(storeName);
    // A catalog fence was captured before staging. Even an A→B→A import
    // invalidates that selection while its catalog epoch update is pending.
    const guardedMutation = input.commitId.startsWith("mut-");
    const rejectPendingReplacement =
      input.requireNoPendingReplacement ||
      input.commitId.startsWith("cat-") ||
      guardedMutation;
    const [live, deletions, replacements] = await Promise.all([
      liveFileIn(tx, input.fileKey),
      cleanupIntents(store),
      rejectPendingReplacement || input.expectedDocId !== undefined
        ? fenceIntents(store)
        : [],
    ]);
    if (
      !live ||
      !live.exists ||
      (input.requireBoundLifetime &&
        !input.expectedLifetimeToken &&
        live.lifetimeToken) ||
      deletions.some((row) => row.fileKey === input.fileKey) ||
      replacements.some(
        (row) =>
          row.fileKey === input.fileKey &&
          (rejectPendingReplacement || row.docId !== input.expectedDocId),
      ) ||
      (input.expectedDocId !== undefined &&
        live.docId !== input.expectedDocId) ||
      (input.expectedDocumentEpoch !== undefined &&
        live.documentEpoch !== input.expectedDocumentEpoch) ||
      (input.expectedLifetimeToken !== undefined &&
        (guardedMutation || live.lifetimeToken) &&
        live.lifetimeToken !== input.expectedLifetimeToken)
    ) {
      tx.abort();
      await done.catch(() => {});
      return live ? "rejected" : "unavailable";
    }
    // An expired stage may already be under collection by a peer that read
    // "missing". Compare its deadline inside the same transaction as the grant.
    if (Date.now() >= stageExpiresAt) {
      tx.abort();
      await done.catch(() => {});
      return "unavailable";
    }
    store.put(
      {
        commitId: input.commitId,
        authorizedAt: Date.now(),
        ...(input.binding && { binding: input.binding }),
      },
      commitRecordKey(input.commitId),
    );
    await done;
    return "authorized";
  } catch {
    return "unavailable";
  }
}

export async function isFileCommitAuthorized(
  commitId: string,
  expectedBinding?: Record<string, unknown>,
): Promise<"authorized" | "missing" | "unavailable"> {
  try {
    const db = await openDatabase();
    const decision = await query(
      db
        .transaction(storeName)
        .objectStore(storeName)
        .get(commitRecordKey(commitId)),
    );
    return decision?.commitId === commitId &&
      (expectedBinding === undefined ||
        canonicalJson(decision.binding) === canonicalJson(expectedBinding))
      ? "authorized"
      : "missing";
  } catch {
    return "unavailable";
  }
}

function canonicalJson(value: unknown) {
  return JSON.stringify(value, (_key, item) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(
          Object.keys(item)
            .sort()
            .map((key) => [key, item[key]]),
        )
      : item,
  );
}

export async function acknowledgeFileCommit(commitId: string): Promise<void> {
  const db = await openDatabase();
  const tx = db.transaction(storeName, "readwrite");
  tx.objectStore(storeName).delete(commitRecordKey(commitId));
  await transactionDone(tx);
}

export async function readLiveFileState(fileKey: string) {
  try {
    const db = await openDatabase();
    return await liveFileIn(
      db.transaction([storeName, catalogName, partStore]),
      fileKey,
    );
  } catch {
    return null;
  }
}

export async function checkCatalogFile(
  fileKey: string,
  expectedDocId?: string,
  expectedDocumentEpoch?: number,
): Promise<"ok" | "changed" | "unavailable"> {
  try {
    const db = await openDatabase();
    const tx = db.transaction([storeName, catalogName, partStore]);
    const store = tx.objectStore(storeName);
    const [deletions, replacements] = await Promise.all([
      cleanupIntents(store),
      fenceIntents(store),
    ]);
    const replacement = replacements.find((row) => row.fileKey === fileKey);
    const deleted = deletions.some((row) => row.fileKey === fileKey);
    if (deleted || replacement) {
      await withCleanupLock(async () => {
        if (deleted) await flushFileCleanup(db, fileKey).catch(() => {});
        if (replacement) await flushFenceIntent(db, replacement);
      }).catch(() => {});
      return "changed";
    }
    const live = await liveFileIn(tx, fileKey);
    if (!live) return "unavailable";
    if (
      !live.exists ||
      (expectedDocId !== undefined && expectedDocId !== live.docId) ||
      (expectedDocumentEpoch !== undefined &&
        expectedDocumentEpoch !== live.documentEpoch)
    ) {
      await bumpWorkspaceScopeFence({ fileKey }).catch(() => {});
      return "changed";
    }
    return "ok";
  } catch {
    return "unavailable";
  }
}
registerCatalogFileGuard(checkCatalogFile);

export async function canReplayFileMemory(
  fileKey: string,
  expectedLifetimeToken?: string,
): Promise<boolean> {
  if (typeof indexedDB === "undefined") return true;
  if ((await checkPendingFileDeletion(fileKey)) !== "clean") return false;
  if (expectedLifetimeToken === undefined) return true;
  const live = await readLiveFileState(fileKey);
  return !!live?.exists && live.lifetimeToken === expectedLifetimeToken;
}

let flushingCleanups: Promise<void> | undefined;
export function flushPendingFileMemoryCleanups(): Promise<void> {
  if (flushingCleanups) return flushingCleanups;
  flushingCleanups = withCleanupLock(async () => {
    const db = await openDatabase();
    await retryLegacyRemovals(db);
    const intents = await cleanupIntents(
      db.transaction(storeName).objectStore(storeName),
    );
    for (const key of legacyCleanupKeys()) {
      if (intents.some((intent) => intent.fileKey === key)) continue;
      const stored = await query(
        db.transaction(storeName).objectStore(storeName).getKey(key),
      );
      if (stored !== undefined) forgetLegacyCleanup(key);
      else intents.push({ fileKey: key });
    }
    for (const intent of intents)
      await finishDeletedFileCleanup(db, intent).catch(() => {
        /* Retry on next open. */
      });
    for (const intent of await fenceIntents(
      db.transaction(storeName).objectStore(storeName),
    ))
      await flushFenceIntent(db, intent).catch(() => {});
  }).finally(() => {
    flushingCleanups = undefined;
  });
  return flushingCleanups;
}

function upsertCatalog(entry: FileSummary) {
  recentCatalog = [
    entry,
    ...recentCatalog.filter((item) => item.key !== entry.key),
  ].sort((a, b) => b.updatedAt - a.updatedAt);
}

export function cachedRecentFiles(): FileSummary[] {
  return recentCatalog;
}

async function migrateCommitDecisions(db: IDBDatabase) {
  const legacy = await query(
    db.transaction(storeName).objectStore(storeName).get(committedOpsRecordKey),
  );
  if (!Array.isArray(legacy) || !legacy.length) return;
  const tx = db.transaction(storeName, "readwrite");
  const store = tx.objectStore(storeName);
  await Promise.all([
    transactionDone(tx),
    query(store.get(committedOpsRecordKey)).then((ids) => {
      if (!Array.isArray(ids)) return;
      for (const commitId of ids) {
        if (typeof commitId === "string")
          store.put(
            { commitId, authorizedAt: Date.now() },
            commitRecordKey(commitId),
          );
      }
      store.delete(committedOpsRecordKey);
    }),
  ]);
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
          if (!internalKey(item.key) && doc?.name)
            catalog.put(summary(String(item.key), doc, 0));
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
      migrateCommitDecisions(db).then(
        () => {
          resolve(db);
          void flushPendingFileMemoryCleanups().catch(() => {});
        },
        (error) => {
          db.close();
          reject(error);
        },
      );
    };
  }).catch((error) => {
    sharedDb = undefined;
    throw error;
  });
  return sharedDb;
}
const identityQueues = new Map<string, Promise<void>>();
export async function withDocumentIdentityGuard<T>(
  fileKey: string,
  task: () => Promise<T>,
): Promise<T> {
  const previous = identityQueues.get(fileKey) ?? Promise.resolve();
  const result = previous.then(async () => {
    const locks = globalThis.navigator?.locks;
    return locks?.request
      ? locks.request(
          "forma:doc-identity:" + fileKey,
          { mode: "exclusive" },
          task,
        )
      : task();
  });
  const tail = result.then(
    () => {},
    () => {},
  );
  identityQueues.set(fileKey, tail);
  try {
    return await result;
  } finally {
    if (identityQueues.get(fileKey) === tail) identityQueues.delete(fileKey);
  }
}
const transientReadErrors = new Set([
  "UnknownError",
  "AbortError",
  "InvalidStateError",
  "TransactionInactiveError",
  "SecurityError",
  "QuotaExceededError",
  "ReadOnlyError",
  "TimeoutError",
  "NotAllowedError",
]);
function isTransientStorageReadError(error: unknown): boolean {
  const seen = new Set<object>();
  while (error && typeof error === "object" && !seen.has(error)) {
    if (
      ("name" in error && transientReadErrors.has(String(error.name))) ||
      (error instanceof DOMException &&
        error.name !== "SyntaxError" &&
        error.name !== "InvalidCharacterError")
    )
      return true;
    seen.add(error);
    error = "cause" in error ? error.cause : undefined;
  }
  return false;
}
/** Each write verifies the loaded generation and retains the preceding complete snapshot atomically. */
export class BrowserDocumentRepository implements DocumentRepository {
  private generation = 0;
  private loadFailedWithoutBaseline = false;
  private failedLoadBaseline?: { generation: number; lifetimeToken?: string };
  private recoveryBaseline?: { generation: number; lifetimeToken?: string };
  private lifetimeToken?: string;
  private documentEpoch?: number;
  private queue: Promise<void> = Promise.resolve();
  constructor(readonly key = "forma.document.v1") {
    checkFileKey(key);
  }
  getLifetimeToken(): string | undefined {
    return this.lifetimeToken;
  }
  getDocumentEpoch(): number | undefined {
    return this.documentEpoch;
  }
  private database() {
    return openDatabase();
  }
  private knownAssets = new Map<string, string>();
  private readonly knownSizes = new Map<
    string,
    { width: number; height: number }
  >();
  private async read(
    which: "current" | "previous",
    remember = false,
  ): Promise<DesignDocument | null> {
    const db = await this.database(),
      tx = db.transaction([storeName, catalogName, partStore, assetStore]);
    const [record, entry] = await Promise.all([
      query<FileRecord | undefined>(tx.objectStore(storeName).get(this.key)),
      remember || which === "previous"
        ? query<FileSummary | undefined>(
            tx.objectStore(catalogName).get(this.key),
          )
        : undefined,
    ]);
    if (!record) {
      if (remember) {
        this.generation = 0;
        this.lifetimeToken = undefined;
        this.documentEpoch = undefined;
        this.failedLoadBaseline = this.recoveryBaseline = undefined;
      }
      return null;
    }
    const token = record.lifetimeToken ?? entry?.lifetimeToken;
    const observed = { generation: record.generation, lifetimeToken: token };
    if (which === "previous" && this.loadFailedWithoutBaseline) {
      let readable = false;
      if (record.current) {
        try {
          parseDocument(await readSnapshot(tx, this.key, record.current));
          readable = true;
        } catch (error) {
          // A denied or aborted read cannot prove that this generation is corrupt.
          if (isTransientStorageReadError(error)) throw error;
        }
      }
      if (readable)
        throw new Error("原文件当前版本可读，请刷新页面打开最新版本");
      this.failedLoadBaseline = observed;
      this.loadFailedWithoutBaseline = false;
    }
    if (remember) {
      this.recoveryBaseline = undefined;
      if (!record.current) {
        this.failedLoadBaseline = observed;
        throw new Error("当前设计快照缺失，请从文件菜单恢复上个版本");
      }
    }
    if (remember && !token) {
      // Backfill a legacy file, then bind to a fresh, single-transaction snapshot.
      await readFileLifetime(db, this.key);
      return this.read(which, true);
    }
    const snapshot = record[which];
    if (!snapshot) return null;
    const failed = this.failedLoadBaseline;
    if (
      which === "previous" &&
      failed &&
      (failed.generation !== observed.generation ||
        (failed.lifetimeToken && failed.lifetimeToken !== token))
    )
      throw new Error("此文件已在另一个标签页更新，请刷新页面打开最新版本");
    let doc: DesignDocument;
    try {
      doc = parseDocument(await readSnapshot(tx, this.key, snapshot));
    } catch (error) {
      if (remember) {
        this.loadFailedWithoutBaseline = isTransientStorageReadError(error);
        this.failedLoadBaseline = this.loadFailedWithoutBaseline
          ? undefined
          : observed;
      }
      throw error;
    }
    if (remember) {
      this.generation = record.generation;
      this.lifetimeToken = token;
      this.documentEpoch = record.replacementEpoch ?? 1;
      this.failedLoadBaseline = undefined;
    }
    if (which === "previous") this.recoveryBaseline = observed;
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
  private async loadCurrent() {
    this.recoveryBaseline = this.failedLoadBaseline = undefined;
    try {
      const current = await this.read("current", true);
      this.loadFailedWithoutBaseline = false;
      return current;
    } catch (error) {
      this.loadFailedWithoutBaseline = !this.failedLoadBaseline;
      throw error;
    }
  }
  async load() {
    const stored = await this.loadCurrent();
    if (stored) return stored;
    return withCleanupLock(async () => {
      // A save or deletion may have completed while this load waited for cleanup.
      const current = await this.loadCurrent();
      if (current) return current;
      const db = await this.database();
      if (await retryLegacyRemovals(db, this.key)) return null;
      let legacy: string | null;
      try {
        legacy = localStorage.getItem(this.key);
      } catch {
        return null;
      }
      if (!legacy) return null;
      const doc = parseDocument(JSON.parse(legacy));
      return (await this.write(doc, undefined, true)) ? doc : null;
    });
  }
  delete() {
    return deleteLocalFile(this.key, {
      expectedLifetimeToken: this.lifetimeToken,
    });
  }
  async recovery() {
    this.recoveryBaseline = undefined;
    return this.read("previous");
  }
  async backup() {
    const db = await this.database(),
      tx = db.transaction([storeName, partStore, assetStore]);
    const record = await query<FileRecord | undefined>(
      tx.objectStore(storeName).get(this.key),
    );
    if (!record) {
      if (await retryLegacyRemovals(db, this.key)) return null;
      return localStorage.getItem(this.key);
    }
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

  save(document: DesignDocument, options?: { replacedDocument?: boolean }) {
    const pending = this.queue
      .then(() =>
        withCleanupLock(async () => {
          await this.write(document, options);
          forgetLegacyCleanup(this.key);
        }),
      )
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
  private async write(
    document: DesignDocument,
    options?: { replacedDocument?: boolean },
    migratingLegacy = false,
  ): Promise<boolean> {
    return withDocumentIdentityGuard(this.key, async () => {
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
      const cleanupReady = await flushFileCleanup(db, this.key).then(
        () => true,
        () => false,
      );
      const tx = db.transaction(
          [storeName, catalogName, partStore, assetStore],
          "readwrite",
        ),
        done = transactionDone(tx);
      // Consume abort completion even when a request rejects first.
      void done.catch(() => {});
      const store = tx.objectStore(storeName),
        recovery =
          this.generation === 0 || this.failedLoadBaseline
            ? this.recoveryBaseline
            : undefined,
        baseline = recovery?.generation ?? this.generation,
        next = baseline + 1;
      let entry: FileSummary;
      let nextEpoch: number;
      let fenceIntent: FenceIntent | undefined;
      try {
        if (
          this.loadFailedWithoutBaseline ||
          (this.failedLoadBaseline && !recovery)
        )
          throw new Error("当前设计快照无法读取，请从文件菜单恢复上个版本");
        const old = await query<FileRecord | undefined>(store.get(this.key));
        if (
          migratingLegacy &&
          !(await retireLegacyKey(store, this.key, false))
        ) {
          await done;
          return false;
        }
        if (!cleanupReady && !old && legacyCleanupKeys().includes(this.key)) {
          const intents = await cleanupIntents(store);
          if (!intents.some((row) => row.fileKey === this.key))
            store.put(
              [...intents, { fileKey: this.key }],
              pendingCleanupRecordKey,
            );
        }
        const previousSummary =
          old &&
          (await query<FileSummary | undefined>(
            tx.objectStore(catalogName).get(this.key),
          ));
        const token =
          old?.lifetimeToken ??
          previousSummary?.lifetimeToken ??
          crypto.randomUUID();
        if (this.lifetimeToken && this.lifetimeToken !== token)
          throw new FileLifetimeMismatchError(
            "该设计文件已在其他窗口更新或替换，请刷新文件列表后重试",
          );
        if (
          (old?.generation ?? 0) !== baseline ||
          (recovery?.lifetimeToken && recovery.lifetimeToken !== token)
        )
          throw Error(
            "此文件已在另一个标签页更新。请先下载当前设计，再重新打开文件。",
          );
        const oldDocId = await storedDocumentId(tx, this.key, old?.current);
        const prevEpoch = old?.replacementEpoch ?? 1;
        if (
          this.documentEpoch !== undefined &&
          prevEpoch !== this.documentEpoch &&
          !options?.replacedDocument
        )
          throw new FileLifetimeMismatchError(
            "此文件已在另一个标签页更新，请重新打开文件",
          );
        const isReplacement = Boolean(
          recovery ||
          (oldDocId && oldDocId !== document.id) ||
          options?.replacedDocument,
        );
        nextEpoch = old ? prevEpoch + Number(isReplacement) : 1;
        if (isReplacement) {
          const intents = await fenceIntents(store);
          fenceIntent = {
            fileKey: this.key,
            docId: document.id,
            opId: crypto.randomUUID(),
          };
          store.put(
            [...intents.filter((row) => row.fileKey !== this.key), fenceIntent],
            pendingFenceRecordKey,
          );
        }
        // Explicit recovery retains the last readable snapshot as the backup.
        // The corrupt header may not even contain an iterable asset list.
        const retained = recovery ? old?.previous : old?.current;
        const discarded = recovery ? old?.current : old?.previous;
        const keep = new Set(isPartitioned(retained) ? retained.assets : []);
        const obsolete = isPartitioned(discarded) ? discarded : undefined;
        const oldAssets = Array.isArray(obsolete?.assets)
          ? obsolete.assets
          : [];
        const already = recovery ? keep : new Set([...keep, ...oldAssets]);
        const current = split
          ? await writeSnapshot(tx, this.key, next, split, already)
          : document;
        if (isPartitioned(current))
          for (const id of current.assets) keep.add(id);
        if (obsolete) {
          const generation = recovery ? baseline : obsolete.generation;
          if (isValidGeneration(generation))
            tx.objectStore(partStore).delete(
              partitionRange(this.key, generation),
            );
          for (const id of oldAssets)
            if (typeof id === "string" && !keep.has(id))
              tx.objectStore(assetStore).delete([this.key, id]);
        }
        store.put(
          {
            generation: next,
            replacementEpoch: nextEpoch,
            current,
            previous: retained,
            lifetimeToken: token,
          },
          this.key,
        );
        entry = summary(this.key, document, Date.now(), token);
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
      this.loadFailedWithoutBaseline = false;
      this.generation = next;
      this.documentEpoch = nextEpoch;
      this.recoveryBaseline = undefined;
      this.failedLoadBaseline = undefined;
      this.lifetimeToken = entry.lifetimeToken;
      this.knownAssets = split?.assets ?? new Map();
      upsertCatalog(entry);
      if (fenceIntent) await flushFenceIntent(db, fenceIntent).catch(() => {});
      if (cleanupReady)
        await clearFileMemoryTombstone(this.key, {
          activeDocId: document.id,
          activeDocGeneration: next,
          activeDocEpoch: nextEpoch,
          activeLifetimeToken: entry.lifetimeToken,
        }).catch(() => {});
      return true;
    });
  }
}
async function readFileLifetime(
  db: IDBDatabase,
  fileKey: string,
): Promise<string | undefined> {
  const catalog = db.transaction(catalogName).objectStore(catalogName);
  const entry = await query<FileSummary | undefined>(catalog.get(fileKey));
  if (entry?.lifetimeToken) return entry.lifetimeToken;
  // Backfill old catalog entries atomically. Concurrent first readers see one token.
  const tx = db.transaction([catalogName, storeName], "readwrite");
  const done = transactionDone(tx);
  const files = tx.objectStore(catalogName);
  const [token] = await Promise.all([
    (async () => {
      const current = await query<FileSummary | undefined>(files.get(fileKey));
      if (current?.lifetimeToken) return current.lifetimeToken;
      const docs = tx.objectStore(storeName);
      const record = await query<FileRecord | undefined>(docs.get(fileKey));
      if (!record) return undefined;
      const lifetimeToken = record.lifetimeToken ?? crypto.randomUUID();
      if (!record.lifetimeToken)
        docs.put({ ...record, lifetimeToken }, fileKey);
      if (current) files.put({ ...current, lifetimeToken });
      else if (record.current && !isPartitioned(record.current))
        files.put(summary(fileKey, record.current, 0, lifetimeToken));
      return lifetimeToken;
    })(),
    done,
  ]);
  return token;
}

export async function getLocalFileLifetimeToken(
  fileKey: string,
): Promise<string | undefined> {
  checkFileKey(fileKey);
  return readFileLifetime(await openDatabase(), fileKey);
}
export async function recentFiles(): Promise<FileSummary[]> {
  const db = await openDatabase();
  await flushPendingFileMemoryCleanups();
  const tx = db.transaction(catalogName, "readwrite");
  const files = tx.objectStore(catalogName);
  const [entries] = await Promise.all([
    query<FileSummary[]>(files.getAll()).then((rows) =>
      rows
        .filter((file) => !internalKey(file.key))
        .map((file) => {
          if (file.lifetimeToken) return file;
          const entry = { ...file, lifetimeToken: crypto.randomUUID() };
          files.put(entry);
          return entry;
        }),
    ),
    transactionDone(tx),
  ]);
  recentCatalog = entries.sort((a, b) => b.updatedAt - a.updatedAt);
  return recentCatalog;
}
export const listLocalFiles = recentFiles;
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
export async function createLocalFileWithKey(
  doc: DesignDocument,
): Promise<{ key: string; url: string }> {
  const key = "forma.file." + crypto.randomUUID();
  await new BrowserDocumentRepository(key).save(doc);
  return { key, url: fileUrl(key) };
}
export async function createLocalFile(doc: DesignDocument): Promise<string> {
  return (await createLocalFileWithKey(doc)).url;
}
export async function readLocalDocument(
  key: string,
  options?: { expectedLifetimeToken?: string },
): Promise<DesignDocument | null> {
  checkFileKey(key);
  const db = await openDatabase(),
    tx = db.transaction([storeName, catalogName, partStore, assetStore]);
  const [record, entry] = await Promise.all([
    query<FileRecord | undefined>(tx.objectStore(storeName).get(key)),
    query<FileSummary | undefined>(tx.objectStore(catalogName).get(key)),
  ]);
  const token = entry?.lifetimeToken ?? record?.lifetimeToken;
  if (options?.expectedLifetimeToken !== undefined) {
    if (!record)
      throw new FileLifetimeMismatchError("该设计文件已不存在，请刷新文件列表");
    if (token && token !== options.expectedLifetimeToken)
      throw new FileLifetimeMismatchError(
        "该设计文件已在其他窗口更新或替换，请刷新文件列表后重试",
      );
  }
  if (!record) return null;
  const document = parseDocument(await readSnapshot(tx, key, record.current));
  if (!token) {
    await readFileLifetime(db, key);
    if (options?.expectedLifetimeToken !== undefined)
      return readLocalDocument(key, options);
  }
  return document;
}
export async function readLocalPreview(key: string) {
  checkFileKey(key);
  const db = await openDatabase(),
    tx = db.transaction([storeName, partStore, assetStore]);
  const record = await query<FileRecord | undefined>(
    tx.objectStore(storeName).get(key),
  );
  if (!record) return null;
  const preview = isPartitioned(record.current)
    ? await readPreviewSnapshot(tx, key, record.current)
    : parseDocument(record.current);
  await readFileLifetime(db, key);
  return preview;
}
export async function deleteLocalFile(
  fileKey: string,
  options?: { expectedLifetimeToken?: string },
): Promise<void> {
  checkFileKey(fileKey);
  const db = await openDatabase();
  const remove = () =>
    withCleanupLock(() =>
      withFenceOpClaim(deletionFenceClaims(db), "delete", async (opId) => {
        const fenceOp = await beginWorkspaceScopeFence({ fileKey }, opId).catch(
          () => undefined,
        );
        let deletionCommitted = false;
        try {
          const tx = db.transaction(
            [storeName, catalogName, partStore, assetStore],
            "readwrite",
          );
          const store = tx.objectStore(storeName);
          let intent: CleanupIntent;
          const done = transactionDone(tx);
          void done.catch(() => {});
          try {
            if (fenceOp && isFallbackFenceOp(fenceOp))
              verifyFallbackFenceClaim(await retiredLegacyKeys(store), fenceOp);
            const old = await query<FileRecord | undefined>(store.get(fileKey));
            const entry = await query<FileSummary | undefined>(
              tx.objectStore(catalogName).get(fileKey),
            );
            const liveToken = entry?.lifetimeToken ?? old?.lifetimeToken;
            if (options?.expectedLifetimeToken !== undefined) {
              if (!old && !entry)
                throw new FileLifetimeMismatchError(
                  "该设计文件已不存在，请刷新文件列表",
                );
              if (liveToken && liveToken !== options.expectedLifetimeToken)
                throw new FileLifetimeMismatchError(
                  "该设计文件已在其他窗口更新或替换，请刷新文件列表后重试",
                );
            }
            const rows = await cleanupIntents(store);
            const priorIntent = rows.find((row) => row.fileKey === fileKey);
            const deletedDocId = await storedDocumentId(
              tx,
              fileKey,
              old?.current,
            );
            intent = {
              ...(fenceOp && { fenceOp }),
              fileKey,
              deletedLifetimeToken:
                liveToken ?? priorIntent?.deletedLifetimeToken,
              deletedDocId: deletedDocId ?? priorIntent?.deletedDocId,
            };
            store.put(
              [...rows.filter((row) => row.fileKey !== fileKey), intent],
              pendingCleanupRecordKey,
            );
            await retireLegacyKey(store, fileKey, true);
            tx.objectStore(partStore).delete(partitionRange(fileKey));
            tx.objectStore(assetStore).delete(partitionRange(fileKey));
            tx.objectStore(storeName).delete(fileKey);
            tx.objectStore(catalogName).delete(fileKey);
            await done;
          } catch (error) {
            try {
              tx.abort();
            } catch {
              /* Already aborted. */
            }
            await done.catch(() => {});
            throw error;
          }
          deletionCommitted = true;
          recentCatalog = recentCatalog.filter((f) => f.key !== fileKey);
          await finishDeletedFileCleanup(db, intent).catch(() => {
            /* The intent survives a failed memory or catalog write. */
          });
        } finally {
          if (!deletionCommitted && fenceOp)
            await endWorkspaceScopeFence({ fileKey }, fenceOp).catch(() => {});
        }
      }),
    );
  // Preserve normal cross-tab ordering, but a denied memory lease must not
  // veto the document transaction. Never retry a deletion that already ran.
  let started = false;
  let committed = false;
  try {
    await withFileProjectScopeLock(fileKey, async () => {
      started = true;
      await remove();
      committed = true;
    });
  } catch (error) {
    if (!started) await remove();
    else if (!committed) throw error;
  }
}
export async function renameLocalFile(
  key: string,
  name: string,
  options?: { expectedLifetimeToken?: string },
): Promise<void> {
  const trimmed = name.trim();
  if (!trimmed) return;
  const repo = new BrowserDocumentRepository(key);
  const doc = await repo.load();
  if (options?.expectedLifetimeToken !== undefined) {
    if (!doc)
      throw new FileLifetimeMismatchError("该设计文件已不存在，请刷新文件列表");
    if (repo.getLifetimeToken() !== options.expectedLifetimeToken)
      throw new FileLifetimeMismatchError(
        "该设计文件已在其他窗口更新或替换，请刷新文件列表后重试",
      );
  }
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
