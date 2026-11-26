import { z } from "zod";
import { query, transactionDone } from "./storage-parts";
import {
  isSafeIdentifierKey,
  migratedLibraryId,
  parseLibrary,
  type ComponentLibrary,
} from "../domain/library-schema";

const preferenceKey = (docId: string) => "forma-enabled-builtin-libs:" + docId;

function savedPreference(docId: string): string[] | undefined {
  try {
    const ids: unknown = JSON.parse(
      localStorage.getItem(preferenceKey(docId)) ?? "null",
    );
    if (Array.isArray(ids) && ids.every((id) => typeof id === "string"))
      return [...new Set<string>(ids)];
  } catch {
    // Storage may be disabled, or an older preference may be unreadable.
  }
}

export function hasSavedBuiltinPreference(docId: string): boolean {
  return savedPreference(docId) !== undefined;
}

export function getEnabledBuiltinLibraries(
  docId: string,
  installedLibraryIds?: Iterable<string>,
  defaultIds: readonly string[] = ["forma-mobile-v1"],
): string[] {
  return (
    savedPreference(docId) ?? [
      ...new Set([...defaultIds, ...(installedLibraryIds ?? [])]),
    ]
  );
}

export function setEnabledBuiltinLibraries(
  docId: string,
  ids: readonly string[],
): string[] {
  const enabled = [...new Set(ids)];
  try {
    localStorage.setItem(preferenceKey(docId), JSON.stringify(enabled));
  } catch {
    // The caller can still apply the selection for this session.
  }
  return enabled;
}

const sourceKinds = z.enum(["json", "figma", "sketch", "packaged"]);
export type WorkspaceLibrarySourceKind = z.infer<typeof sourceKinds>;
export type WorkspaceLibraryRecord = {
  id: string;
  name: string;
  revision: number;
  savedAt: string;
  sourceKind: WorkspaceLibrarySourceKind;
  componentCount: number;
  variantCount: number;
  library: ComponentLibrary;
};

export class WorkspaceLibraryConflictError extends Error {
  constructor(readonly current: WorkspaceLibraryRecord) {
    super("工作区组件库已变更，请刷新后重试");
    this.name = "WorkspaceLibraryConflictError";
  }
}

const storedRecord = z.object({
  id: z.string(),
  name: z.string(),
  revision: z.number().int().nonnegative(),
  savedAt: z.iso.datetime(),
  sourceKind: sourceKinds,
  componentCount: z.number().int().nonnegative(),
  variantCount: z.number().int().nonnegative(),
  library: z.unknown(),
});
const variantCount = (library: ComponentLibrary) =>
  library.components.reduce(
    (sum, component) => sum + component.variants.length,
    0,
  );

const fenceStore = "fences";
const sourceChanged = "所属项目空间或源文件状态已变更，请刷新后重试";
const fenceChanged = "所属项目空间已变更，请重新确认目标组件库后再沉淀";
type FenceScope = { fileKey?: string; projectId?: string | null };
export type WorkspaceScopeFence = {
  fileKey: string;
  projectId: string | null;
  fileEpoch: number;
  projectEpoch: number;
  expectedDocId?: string;
  expectedDocumentEpoch?: number;
  expectedLifetimeToken?: string;
};
type CatalogFileGuard = (
  fileKey: string,
  expectedDocId?: string,
  expectedDocumentEpoch?: number,
) => Promise<"ok" | "changed" | "unavailable">;
let catalogFileGuard: CatalogFileGuard;
export function registerCatalogFileGuard(guard: CatalogFileGuard) {
  catalogFileGuard = guard;
}
async function verifyCatalogFile(
  fileKey: string,
  expectedDocId?: string,
  expectedDocumentEpoch?: number,
) {
  const guard =
    catalogFileGuard ?? (await import("./storage")).checkCatalogFile;
  if ((await guard(fileKey, expectedDocId, expectedDocumentEpoch)) !== "ok")
    throw new Error(sourceChanged);
}
type FenceRow = {
  id: string;
  __formaFence: true;
  epoch: number;
  inFlightOps: string[];
};
const memoryFences = new Map<string, FenceRow>();
function emptyFence(id: string): FenceRow {
  return { id, __formaFence: true, epoch: 0, inFlightOps: [] };
}
function fenceKeys({ fileKey, projectId }: FenceScope) {
  const keys: string[] = [];
  if (fileKey !== undefined) keys.push("file:" + fileKey);
  if (projectId) keys.push("project:" + projectId);
  return keys;
}
async function readFences(
  scope: FenceScope,
  store?: IDBObjectStore,
): Promise<FenceRow[]> {
  return Promise.all(
    fenceKeys(scope).map(async (id) => {
      const row = store ? await query(store.get(id)) : memoryFences.get(id);
      if (row === undefined) return emptyFence(id);
      if (
        row.__formaFence !== true ||
        !Number.isSafeInteger(row.epoch) ||
        !Array.isArray(row.inFlightOps) ||
        !row.inFlightOps.every((id: unknown) => typeof id === "string")
      )
        throw new Error("项目归属校验记录损坏");
      return row;
    }),
  );
}

type FenceOpStatus = "active" | "completed" | "abandoned";
let checkStoredFenceOp: ((id: string) => Promise<FenceOpStatus>) | undefined;
export function registerFenceOpStatusChecker(
  check: (opId: string) => Promise<FenceOpStatus>,
) {
  checkStoredFenceOp = check;
}
// Without Web Locks a different tab cannot see this module's active operations.
// Keep a renewable claim in the mutation's own database. A resumed writer must
// still own that claim in its commit transaction after a peer reclaimed it.
export type FenceClaimLocation = {
  db: IDBDatabase;
  store: string;
  key: string;
  initial: Record<string, unknown>;
  inlineKey: boolean;
};
const claimDuration = 15_000;
async function changeFenceClaim(
  location: FenceClaimLocation,
  id: string,
  action: "begin" | "renew" | "status" | "release",
) {
  const tx = location.db.transaction(location.store, "readwrite");
  const store = tx.objectStore(location.store);
  const done = transactionDone(tx);
  const [active] = await Promise.all([
    (async () => {
      const row = (await query(store.get(location.key))) ?? location.initial;
      const claims: Record<string, number> = { ...row.fenceClaims };
      const now = Date.now();
      const wasActive = claims[id] > now;
      // Expiration is irreversible once observed, even after a clock adjustment.
      for (const [key, expires] of Object.entries(claims))
        if (expires <= now) delete claims[key];
      if (action === "begin" || (action === "renew" && wasActive))
        claims[id] = now + claimDuration;
      if (action === "release") delete claims[id];
      if (
        action === "begin" ||
        (action === "renew" && wasActive) ||
        Object.keys(claims).length !== Object.keys(row.fenceClaims ?? {}).length
      ) {
        const next = { ...row, fenceClaims: claims };
        if (location.inlineKey) store.put(next);
        else store.put(next, location.key);
      }
      return wasActive;
    })(),
    done,
  ]);
  return active;
}
export const isFallbackFenceOp = (opId: string) => opId.includes(":lease:");
export async function fallbackFenceOpActive(
  location: FenceClaimLocation,
  id: string,
) {
  return changeFenceClaim(location, id, "status");
}
export function verifyFallbackFenceClaim(
  row: { fenceClaims?: Record<string, number> } | undefined,
  id: string,
) {
  if (isFallbackFenceOp(id) && !row?.fenceClaims?.[id])
    throw new Error("项目归属变更已过期，请重试");
}
export async function withFenceOpClaim<T>(
  location: FenceClaimLocation | undefined,
  kind: "memory" | "delete",
  task: (id: string) => Promise<T>,
): Promise<T> {
  const uuid = crypto.randomUUID();
  if (
    !location ||
    (typeof globalThis.navigator?.locks?.query === "function" &&
      typeof globalThis.navigator?.locks?.request === "function")
  )
    return task(kind + ":" + uuid);
  const id = kind + ":lease:" + uuid;
  await changeFenceClaim(location, id, "begin");
  const timer = setInterval(() => {
    void changeFenceClaim(location, id, "renew").catch(() => {});
  }, claimDuration / 3);
  try {
    return await task(id);
  } finally {
    clearInterval(timer);
    await changeFenceClaim(location, id, "release").catch(() => {});
  }
}
type FenceOwner = { release: () => void; finished?: Promise<unknown> };
const activeFenceOps = new Map<string, FenceOwner>();
async function fenceOpStatus(id: string): Promise<FenceOpStatus> {
  if (activeFenceOps.has(id)) return "active";
  const locks = globalThis.navigator?.locks;
  if (
    locks?.query &&
    (await locks.query()).held?.some(
      (lock) => lock.name === "forma:fence-op:" + id,
    )
  )
    return "active";
  // Catalog-only readers can load the storage checker on first orphan.
  const check =
    checkStoredFenceOp ??
    (await import("./project-memory-store")).checkWorkspaceFenceOp;
  return check(id);
}

async function mutateFences(
  scope: FenceScope,
  change: (row: FenceRow) => FenceRow,
) {
  if (typeof indexedDB === "undefined") {
    for (const id of fenceKeys(scope))
      memoryFences.set(id, change(memoryFences.get(id) ?? emptyFence(id)));
    return;
  }
  const tx = (await database()).transaction(fenceStore, "readwrite");
  const done = transactionDone(tx);
  void done.catch(() => {});
  const store = tx.objectStore(fenceStore);
  try {
    for (const row of await readFences(scope, store)) {
      const next = change(row);
      if (next !== row) store.put(next);
    }
    await done;
  } catch (error) {
    try {
      tx.abort();
    } catch {
      /* already finished */
    }
    throw error;
  }
}

// Cross-database status reads happen outside the catalog transaction. Only retire
// the specific immutable operation IDs observed, preserving any later begin.
async function reconcileFences(scope: FenceScope): Promise<FenceRow[]> {
  for (;;) {
    const store =
      typeof indexedDB === "undefined"
        ? undefined
        : (await database()).transaction(fenceStore).objectStore(fenceStore);
    const rows = await readFences(scope, store);
    const ids = new Set(rows.flatMap((row) => row.inFlightOps));
    const retired = new Set<string>();
    for (const id of ids)
      if ((await fenceOpStatus(id)) !== "active") retired.add(id);
    if (!retired.size) return rows;
    await mutateFences(scope, (row) => {
      const remaining = row.inFlightOps.filter((id) => !retired.has(id));
      const removed = row.inFlightOps.length - remaining.length;
      return removed
        ? { ...row, inFlightOps: remaining, epoch: row.epoch + removed }
        : row;
    });
  }
}

export async function readWorkspaceScopeFence(
  fileKey: string,
  projectId?: string | null,
  expectedDocId?: string,
  expectedDocumentEpoch?: number,
): Promise<WorkspaceScopeFence> {
  await verifyCatalogFile(fileKey, expectedDocId, expectedDocumentEpoch);
  const rows = await reconcileFences({ fileKey, projectId });
  if (rows.some((row) => row.inFlightOps.length))
    throw new Error("项目归属正在变更，请稍后重试");
  return {
    fileKey,
    projectId: projectId || null,
    fileEpoch: rows[0].epoch,
    projectEpoch: rows[1]?.epoch ?? 0,
    ...(expectedDocId !== undefined && { expectedDocId }),
    ...(expectedDocumentEpoch !== undefined && { expectedDocumentEpoch }),
  };
}

export async function beginWorkspaceScopeFence(
  scope: FenceScope,
  opId: string = crypto.randomUUID(),
): Promise<string> {
  await reconcileFences(scope);
  const begin = async () => {
    await mutateFences(scope, (row) => ({
      ...row,
      epoch: row.epoch + 1,
      inFlightOps: [...row.inFlightOps, opId],
    }));
    return opId;
  };
  let release!: () => void;
  const lifetime = new Promise<void>((resolve) => {
    release = resolve;
  });
  const owner: FenceOwner = { release };
  activeFenceOps.set(opId, owner);
  try {
    const locks = globalThis.navigator?.locks;
    if (!locks?.request) return await begin();
    return await new Promise<string>((resolve, reject) => {
      owner.finished = locks
        .request("forma:fence-op:" + opId, { mode: "exclusive" }, async () => {
          resolve(await begin());
          await lifetime;
        })
        .catch(reject);
    });
  } catch (error) {
    activeFenceOps.delete(opId);
    release();
    throw error;
  }
}
export async function endWorkspaceScopeFence(
  scope: FenceScope,
  opId: string,
): Promise<void> {
  try {
    await mutateFences(scope, (row) =>
      row.inFlightOps.includes(opId)
        ? {
            ...row,
            epoch: row.epoch + 1,
            inFlightOps: row.inFlightOps.filter((id) => id !== opId),
          }
        : row,
    );
  } finally {
    const owner = activeFenceOps.get(opId);
    owner?.release();
    await owner?.finished;
    activeFenceOps.delete(opId);
  }
}
export async function bumpWorkspaceScopeFence(scope: FenceScope) {
  await mutateFences(scope, (row) => ({ ...row, epoch: row.epoch + 1 }));
}

class LibraryStageUnavailable extends Error {}
class LibraryStageConflict extends Error {}
class FenceInFlightError extends LibraryStageConflict {}
function checkFence(
  expected: WorkspaceScopeFence,
  [file, project]: FenceRow[],
) {
  if (file.inFlightOps.length || project?.inFlightOps.length)
    throw new FenceInFlightError(fenceChanged);
  if (
    file.epoch !== expected.fileEpoch ||
    (expected.projectId && project.epoch !== expected.projectEpoch)
  )
    throw new LibraryStageConflict(fenceChanged);
}

function readRecord(raw: unknown): WorkspaceLibraryRecord | undefined {
  try {
    const record = storedRecord.parse(raw);
    const library = parseLibrary(record.library);
    if (
      record.id === library.id &&
      record.name === library.name &&
      record.revision === library.revision &&
      record.componentCount === library.components.length &&
      record.variantCount === variantCount(library)
    )
      return { ...record, library };
  } catch {
    // One damaged snapshot must not hide other libraries in the catalog.
  }
}

const storeName = "libraries";
let opening: Promise<IDBDatabase> | undefined;

function database(): Promise<IDBDatabase> {
  if (opening) return opening;
  opening = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("forma-workspace-libraries-v1", 2);
    let blocked = false;
    request.onblocked = () => {
      blocked = true;
      reject(new Error("组件库仓库被其他窗口占用"));
    };
    request.onerror = () => reject(request.error);
    request.onupgradeneeded = (event) => {
      if (!request.result.objectStoreNames.contains(storeName))
        request.result.createObjectStore(storeName, { keyPath: "id" });
      const fences = request.result.createObjectStore(fenceStore, {
        keyPath: "id",
      });
      if (event.oldVersion === 1) {
        const cursor = request.transaction!.objectStore(storeName).openCursor();
        cursor.onsuccess = () => {
          const item = cursor.result;
          if (!item) return;
          const row = item.value;
          const prefix = "__forma_fence__:";
          if (
            row?.__formaFence === true &&
            typeof item.key === "string" &&
            item.key.startsWith(prefix) &&
            !readRecord(row)
          ) {
            // Invalidate every v1 publisher. An old connection cannot write past the upgrade.
            fences.put({
              ...emptyFence(item.key.slice(prefix.length)),
              epoch: (Number.isSafeInteger(row.epoch) ? row.epoch : 0) + 1,
            });
            item.delete();
          }
          item.continue();
        };
      }
    };
    request.onsuccess = () => {
      const db = request.result;
      if (blocked) {
        db.close();
        return;
      }
      db.onversionchange = () => {
        opening = undefined;
        db.close();
      };
      db.onclose = () => {
        opening = undefined;
      };
      resolve(db);
    };
  }).catch((error) => {
    opening = undefined;
    throw error;
  });
  return opening;
}

async function catalogRequest<T>(
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await database();
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    const request = operation(tx.objectStore(storeName));
    tx.oncomplete = () => resolve(request.result);
    tx.onerror = (event) =>
      reject(
        (event?.target as IDBRequest | null)?.error ??
          tx.error ??
          new Error("工作区事务失败"),
      );
    tx.onabort = () => reject(tx.error ?? new Error("工作区事务已取消"));
  });
}

// Keep an alias under the retired key so old project bindings survive both the
// migration and a collision with a designer's existing safe library ID.
async function recoverLegacyLibrary(
  id: string,
): Promise<WorkspaceLibraryRecord | null> {
  const db = await database();
  const tx = db.transaction(storeName, "readwrite");
  const done = transactionDone(tx);
  void done.catch(() => {});
  const store = tx.objectStore(storeName);
  try {
    const raw = await query(store.get(id));
    let record: WorkspaceLibraryRecord | undefined;
    if (
      raw?.redirectTo &&
      typeof raw.redirectTo === "string" &&
      isSafeIdentifierKey(raw.redirectTo)
    )
      record = readRecord(await query(store.get(raw.redirectTo)));
    else if (raw) {
      const base = migratedLibraryId(id);
      let target = base;
      for (
        let suffix = 2;
        (await query(store.getKey(target))) !== undefined;
        suffix++
      )
        target = base + "-" + suffix;
      if (raw.id === id && raw.library?.id === id)
        record = readRecord({
          ...raw,
          id: target,
          library: { ...raw.library, id: target },
        });
      if (!record) throw new Error("工作区组件库记录损坏");
      store.put(record);
      store.put({ id, redirectTo: target });
    }
    await done;
    return record ?? null;
  } catch (error) {
    try {
      tx.abort();
    } catch {
      /* already complete */
    }
    throw error;
  }
}

// Memory-only saves and uncommitted deletes shadow older entries in the catalog list.
const memory = new Map<string, WorkspaceLibraryRecord>();
const pending = new Set<string>();

export async function listWorkspaceLibraries(): Promise<
  WorkspaceLibraryRecord[]
> {
  try {
    await reconcileLibraryStages();
    const entries = await catalogRequest("readonly", (store) => store.getAll());
    for (const id of memory.keys()) if (!pending.has(id)) memory.delete(id);
    for (const entry of entries) {
      const record =
        typeof entry?.id === "string" && !isSafeIdentifierKey(entry.id)
          ? await recoverLegacyLibrary(entry.id).catch(() => null)
          : readRecord(entry);
      if (record && !pending.has(record.id)) memory.set(record.id, record);
    }
  } catch (error) {
    if (error instanceof LibraryStageUnavailable) throw error;
    // Serve the in-memory catalog when IndexedDB is unavailable.
  }
  return Array.from(memory.values(), (record) => structuredClone(record)).sort(
    (a, b) => b.savedAt.localeCompare(a.savedAt),
  );
}

export async function getWorkspaceLibraryRecord(
  id: string,
): Promise<WorkspaceLibraryRecord | null> {
  if (typeof indexedDB === "undefined") {
    if (typeof window !== "undefined")
      throw new Error("当前环境不支持本机持久化组件库仓库");
    return structuredClone(memory.get(id) ?? null);
  }
  await reconcileLibraryStages(id);
  if (!isSafeIdentifierKey(id)) return recoverLegacyLibrary(id);
  const raw = await catalogRequest("readonly", (store) => store.get(id));
  if (raw === undefined) return null;
  const record = readRecord(raw);
  if (!record) throw new Error("工作区组件库记录损坏");
  return record;
}

export const getWorkspaceLibrary = getWorkspaceLibraryRecord;

function makeRecord(
  input: ComponentLibrary,
  sourceKind: WorkspaceLibrarySourceKind,
): WorkspaceLibraryRecord {
  const library = parseLibrary(input);
  return {
    id: library.id,
    name: library.name,
    revision: library.revision,
    savedAt: new Date().toISOString(),
    sourceKind: sourceKinds.parse(sourceKind),
    componentCount: library.components.length,
    variantCount: variantCount(library),
    library,
  };
}

// A guide-only save must change the compare-and-swap token, including when two
// transactions run in the same millisecond or the system clock moves back.
function nextSavedAt(previous?: string) {
  return new Date(
    previous ? Math.max(Date.now(), Date.parse(previous) + 1) : Date.now(),
  ).toISOString();
}

function persistenceError(reason: unknown) {
  return new Error(
    "无法持久化组件库到本机工作区：" +
      (reason instanceof Error
        ? reason.message
        : String(reason ?? "事务已取消")),
  );
}

async function writeWorkspaceRecord(
  record: WorkspaceLibraryRecord,
  check?: (existing: WorkspaceLibraryRecord | undefined, raw: unknown) => void,
) {
  let db: IDBDatabase;
  try {
    db = await database();
  } catch (error) {
    throw persistenceError(error);
  }
  return new Promise<WorkspaceLibraryRecord>((resolve, reject) => {
    try {
      const tx = db.transaction(storeName, "readwrite");
      const store = tx.objectStore(storeName);

      tx.onerror = (event) =>
        reject(
          persistenceError(
            (event?.target as IDBRequest | null)?.error ?? tx.error,
          ),
        );
      tx.onabort = () => reject(persistenceError(tx.error));
      tx.oncomplete = () => {
        pending.delete(record.id);
        memory.set(record.id, record);
        resolve(structuredClone(record));
      };
      const request = store.get(record.id);
      request.onsuccess = () => {
        const existing =
          request.result === undefined ? undefined : readRecord(request.result);
        try {
          check?.(existing, request.result);
        } catch (error) {
          reject(error);
          tx.abort();
          return;
        }
        try {
          record.savedAt = nextSavedAt(existing?.savedAt);
          store.put(record);
        } catch (error) {
          reject(persistenceError(error));
          tx.abort();
        }
      };
    } catch (error) {
      reject(persistenceError(error));
    }
  });
}

type LibraryVersion = Pick<WorkspaceLibraryRecord, "revision" | "savedAt">;
function compareLibrary(
  expected: LibraryVersion | null | undefined,
  existing: WorkspaceLibraryRecord | undefined,
  raw: unknown,
) {
  if (raw !== undefined && !existing) throw new Error("工作区组件库记录损坏");
  if (!existing) {
    if (expected)
      throw new LibraryStageConflict("工作区组件库已删除，请刷新后重试");
    return;
  }
  if (
    !expected ||
    existing.revision !== expected.revision ||
    existing.savedAt !== expected.savedAt
  )
    throw new WorkspaceLibraryConflictError(existing);
}

const libraryStagePrefix = "__staged_lib__:";
const catalogOutcomeKey = (id: string) => "__applied_cat__:" + id;
type CompactCatalogOutcome = {
  id: string;
  commitId: string;
  libraryId: string;
  revision: number;
  savedAt: string;
  sourceKind: WorkspaceLibrarySourceKind;
};
type CatalogOutcome =
  CompactCatalogOutcome | { id: string; record: WorkspaceLibraryRecord };
const sessionOutcomes = new Map<string, CompactCatalogOutcome>();
const libraryStageGraceMs = 60_000;
const activeLibraryStages = new Set<string>();
type LibraryStage = {
  id: string;
  __stagedLib: true;
  commitId: string;
  record: WorkspaceLibraryRecord;
  expectedRevision: number | null;
  expectedSavedAt: string | null;
  expectedFence: WorkspaceScopeFence;
  createdAt: number;
  keepOutcome?: boolean;
};

async function restorePublication(
  outcome: CompactCatalogOutcome,
  fallbackRecord?: WorkspaceLibraryRecord,
  libraries?: IDBObjectStore,
): Promise<WorkspaceLibraryRecord> {
  if (
    fallbackRecord?.id === outcome.libraryId &&
    fallbackRecord.revision === outcome.revision
  )
    return {
      ...fallbackRecord,
      savedAt: outcome.savedAt,
      sourceKind: outcome.sourceKind,
      library: structuredClone(fallbackRecord.library),
    };
  const current = libraries
    ? readRecord(await query(libraries.get(outcome.libraryId)))
    : structuredClone(memory.get(outcome.libraryId));
  if (!current)
    throw new LibraryStageConflict("工作区组件库已删除，请刷新后重试");
  return current;
}

async function appliedLibrary(
  tx: IDBTransaction,
  commitId: string,
  fallbackRecord?: WorkspaceLibraryRecord,
) {
  const outcome = await query<CatalogOutcome | undefined>(
    tx.objectStore(fenceStore).get(catalogOutcomeKey(commitId)),
  );
  if (!outcome) return;
  if ("record" in outcome) return outcome.record;
  return restorePublication(outcome, fallbackRecord, tx.objectStore(storeName));
}

function catalogOutcome(
  commitId: string,
  record: WorkspaceLibraryRecord,
): CompactCatalogOutcome {
  return {
    id: catalogOutcomeKey(commitId),
    commitId,
    libraryId: record.id,
    revision: record.revision,
    savedAt: record.savedAt,
    sourceKind: record.sourceKind,
  };
}

async function editLibraryStage<T>(
  db: IDBDatabase,
  work: (tx: IDBTransaction) => Promise<T>,
) {
  const tx = db.transaction([storeName, fenceStore], "readwrite");
  const done = transactionDone(tx);
  void done.catch(() => {});
  try {
    const value = await work(tx);
    await done;
    return value;
  } catch (error) {
    try {
      tx.abort();
    } catch {
      /* already complete */
    }
    throw error;
  }
}

async function checkLibraryStage(
  stage: LibraryStage,
  libraries: IDBObjectStore,
  fences: IDBObjectStore,
) {
  checkFence(
    stage.expectedFence,
    await readFences(stage.expectedFence, fences),
  );
  if (pending.has(stage.record.id))
    throw new Error("工作区有未持久化的组件库变更，请刷新后重试");
  const raw = await query(libraries.get(stage.record.id));
  const existing = raw === undefined ? undefined : readRecord(raw);
  const expected =
    stage.expectedRevision === null || stage.expectedSavedAt === null
      ? null
      : { revision: stage.expectedRevision, savedAt: stage.expectedSavedAt };
  compareLibrary(expected, existing, raw);
  return existing;
}

async function discardLibraryStage(db: IDBDatabase, stage: LibraryStage) {
  const tx = db.transaction(fenceStore, "readwrite");
  const store = tx.objectStore(fenceStore);
  await Promise.all([
    transactionDone(tx),
    query(store.get(stage.id)).then((current) => {
      if (current?.createdAt === stage.createdAt) store.delete(stage.id);
    }),
  ]);
}

async function finalizeLibraryStage(db: IDBDatabase, stage: LibraryStage) {
  let materialized = false;
  const result = await editLibraryStage(db, async (tx) => {
    const libraries = tx.objectStore(storeName),
      fences = tx.objectStore(fenceStore);
    const stored: LibraryStage | undefined = await query(fences.get(stage.id));
    if (!stored) {
      const applied = await appliedLibrary(tx, stage.commitId, stage.record);
      if (applied) return applied;
      // A reader may already have materialized this exact publication.
      const raw = await query(libraries.get(stage.record.id));
      if (raw?.commitId === stage.commitId) {
        const published = readRecord(raw);
        if (published) return published;
      }
      throw new LibraryStageConflict(fenceChanged);
    }
    if (stored.createdAt !== stage.createdAt)
      throw new LibraryStageUnavailable("组件库发布正在重试，请稍后重试");
    await checkLibraryStage(stored, libraries, fences);
    libraries.put({ ...stored.record, commitId: stored.commitId });
    if (stored.keepOutcome)
      fences.put(catalogOutcome(stored.commitId, stored.record));
    fences.delete(stored.id);
    materialized = true;
    return stored.record;
  });
  if (materialized) {
    pending.delete(result.id);
    memory.set(result.id, result);
  }
  const { acknowledgeFileCommit } = await import("./storage");
  await acknowledgeFileCommit(stage.commitId).catch(() => {});
  return structuredClone(result);
}

async function reconcileLibraryStages(libraryId?: string) {
  if (typeof IDBKeyRange === "undefined") return;
  const db = await database();
  const stages: LibraryStage[] = await query(
    db
      .transaction(fenceStore)
      .objectStore(fenceStore)
      .getAll(
        IDBKeyRange.bound(libraryStagePrefix, libraryStagePrefix + "\uffff"),
      ),
  );
  for (const stage of stages) {
    if (
      !stage?.__stagedLib ||
      typeof stage.record?.id !== "string" ||
      stage.id !== libraryStagePrefix + stage.commitId ||
      (libraryId !== undefined && stage.record.id !== libraryId)
    )
      continue;
    await reconcileLibraryStage(db, stage);
  }
}

async function reconcileLibraryStage(db: IDBDatabase, stage: LibraryStage) {
  const { isFileCommitAuthorized } = await import("./storage");
  const expired = stage.createdAt + libraryStageGraceMs <= Date.now();
  const state = await isFileCommitAuthorized(stage.commitId);
  if (state === "unavailable")
    throw new LibraryStageUnavailable("无法核验组件库的暂存发布，请稍后重试");
  if (state === "authorized") {
    try {
      await finalizeLibraryStage(db, stage);
    } catch (error) {
      if (!(
        error instanceof WorkspaceLibraryConflictError ||
        error instanceof LibraryStageConflict
      ))
        throw new LibraryStageUnavailable(
          "无法完成已授权的组件库发布，请稍后重试",
          { cause: error },
        );
      await discardLibraryStage(db, stage);
      const { acknowledgeFileCommit } = await import("./storage");
      await acknowledgeFileCommit(stage.commitId).catch(() => {});
    }
  } else if (
    state === "missing" &&
    expired &&
    !activeLibraryStages.has(stage.id)
  ) {
    await discardLibraryStage(db, stage);
  }
}

export async function hasAppliedCatalogCommit(
  commitId: string,
): Promise<boolean> {
  try {
    if (typeof indexedDB === "undefined") return sessionOutcomes.has(commitId);
    const db = await database();
    const tx = db.transaction(fenceStore);
    const fences = tx.objectStore(fenceStore);
    const [outcome, stage] = await Promise.all([
      query(fences.get(catalogOutcomeKey(commitId))),
      query<LibraryStage | undefined>(
        fences.get(libraryStagePrefix + commitId),
      ),
      transactionDone(tx),
    ]);
    if (outcome || !stage) return !!outcome;
    await reconcileLibraryStage(db, stage);
    const read = db.transaction(fenceStore);
    const [applied] = await Promise.all([
      query(read.objectStore(fenceStore).get(catalogOutcomeKey(commitId))),
      transactionDone(read),
    ]);
    return !!applied;
  } catch (error) {
    if (error instanceof LibraryStageUnavailable) throw error;
    throw new LibraryStageUnavailable("无法核验组件库的暂存发布，请稍后重试", {
      cause: error,
    });
  }
}

export async function acknowledgeCatalogCommit(
  commitId: string,
): Promise<void> {
  sessionOutcomes.delete(commitId);
  if (typeof indexedDB === "undefined") return;
  const tx = (await database()).transaction(fenceStore, "readwrite");
  tx.objectStore(fenceStore).delete(catalogOutcomeKey(commitId));
  await transactionDone(tx);
}

async function retryPublication(
  commitId: string,
  fallbackRecord: WorkspaceLibraryRecord,
): Promise<WorkspaceLibraryRecord | undefined> {
  const db = await database();
  const tx = db.transaction([storeName, fenceStore]);
  const [applied, stage] = await Promise.all([
    appliedLibrary(tx, commitId, fallbackRecord),
    query<LibraryStage | undefined>(
      tx.objectStore(fenceStore).get(libraryStagePrefix + commitId),
    ),
    transactionDone(tx),
  ]);
  if (applied || !stage) return applied;
  const { isFileCommitAuthorized } = await import("./storage");
  const status = await isFileCommitAuthorized(commitId);
  if (status === "authorized") return finalizeLibraryStage(db, stage);
  // A peer may have atomically replaced the stage with its outcome, then acknowledged
  // the studio grant between our catalog read and decision lookup.
  const published = await appliedLibrary(
    db.transaction([storeName, fenceStore]),
    commitId,
    fallbackRecord,
  );
  if (published) return published;
  if (status === "unavailable")
    throw new LibraryStageUnavailable("无法核验组件库的暂存发布，请稍后重试");
  if (stage.createdAt + libraryStageGraceMs <= Date.now()) {
    await discardLibraryStage(db, stage);
    return;
  }
  const expected =
    stage.expectedRevision === null || stage.expectedSavedAt === null
      ? null
      : { revision: stage.expectedRevision, savedAt: stage.expectedSavedAt };
  return saveScopedLibrary(
    stage.record,
    expected,
    stage.expectedFence,
    commitId,
  );
}

async function saveScopedLibrary(
  record: WorkspaceLibraryRecord,
  expected: LibraryVersion | null | undefined,
  fence: WorkspaceScopeFence,
  callerCommitId?: string,
) {
  const db = await database();
  const commitId = callerCommitId ?? "cat-" + crypto.randomUUID();
  const { authorizeFileCommit, isFileCommitAuthorized, acknowledgeFileCommit } =
    await import("./storage");
  await verifyCatalogFile(
    fence.fileKey,
    fence.expectedDocId,
    fence.expectedDocumentEpoch,
  );
  let stage: LibraryStage = {
    id: libraryStagePrefix + commitId,
    __stagedLib: true,
    commitId,
    record,
    expectedRevision: expected?.revision ?? null,
    expectedSavedAt: expected?.savedAt ?? null,
    expectedFence: fence,
    createdAt: Date.now(),
    keepOutcome: callerCommitId !== undefined,
  };
  let staged = false;
  let authorized = false;
  activeLibraryStages.add(stage.id);
  try {
    const applied = await editLibraryStage(db, async (tx) => {
      const libraries = tx.objectStore(storeName),
        fences = tx.objectStore(fenceStore);
      if (stage.keepOutcome) {
        const outcome = await appliedLibrary(tx, commitId, record);
        if (outcome) return outcome;
        const existingStage: LibraryStage | undefined = await query(
          fences.get(stage.id),
        );
        if (existingStage) {
          stage = existingStage;
          return;
        }
      }
      const existing = await checkLibraryStage(stage, libraries, fences);
      record.savedAt = nextSavedAt(existing?.savedAt);
      fences.put(stage);
    });
    if (applied) return applied;
    staged = true;
    const captured = stage.expectedFence;
    const decision = await authorizeFileCommit(
      {
        commitId,
        fileKey: captured.fileKey,
        expectedDocId: captured.expectedDocId,
        expectedDocumentEpoch: captured.expectedDocumentEpoch,
        expectedLifetimeToken: captured.expectedLifetimeToken,
        requireNoPendingReplacement: true,
      },
      stage.createdAt + libraryStageGraceMs,
    );
    if (decision !== "authorized") {
      // A simultaneous retry may already hold a grant for this exact stage.
      const prior =
        callerCommitId === undefined
          ? "missing"
          : await isFileCommitAuthorized(commitId);
      if (prior === "unavailable")
        throw new LibraryStageUnavailable(
          "无法核验组件库的暂存发布，请稍后重试",
        );
      if (prior === "missing") {
        if (stage.keepOutcome) {
          const result = await appliedLibrary(
            db.transaction([storeName, fenceStore]),
            commitId,
            stage.record,
          );
          if (result) return result;
        }
        throw new Error(sourceChanged);
      }
    }
    authorized = true;
    return await finalizeLibraryStage(db, stage);
  } catch (error) {
    if (
      staged &&
      !(error instanceof LibraryStageUnavailable) &&
      (!authorized ||
        error instanceof LibraryStageConflict ||
        error instanceof WorkspaceLibraryConflictError)
    ) {
      await discardLibraryStage(db, stage).catch(() => {});
      if (authorized) await acknowledgeFileCommit(commitId).catch(() => {});
    }
    throw error;
  } finally {
    activeLibraryStages.delete(stage.id);
  }
}

export async function saveWorkspaceLibraryDurable(
  input: ComponentLibrary,
  sourceKind: WorkspaceLibrarySourceKind,
  expected?: { revision: number; savedAt: string },
): Promise<WorkspaceLibraryRecord> {
  if (typeof indexedDB === "undefined")
    throw new Error("当前环境不支持本机持久化组件库仓库");
  return saveWorkspaceLibraryIfUnchanged(input, sourceKind, expected);
}

export async function saveWorkspaceLibraryIfUnchanged(
  input: ComponentLibrary,
  sourceKind: WorkspaceLibrarySourceKind,
  expected?: Pick<WorkspaceLibraryRecord, "revision" | "savedAt"> | null,
  options?: { expectedFence?: WorkspaceScopeFence; commitId?: string },
): Promise<WorkspaceLibraryRecord> {
  const fence = options?.expectedFence;
  const commitId = options?.commitId;
  const record = makeRecord(input, sourceKind);
  if (typeof indexedDB === "undefined") {
    let outcome =
      commitId === undefined ? undefined : sessionOutcomes.get(commitId);
    if (fence && !outcome) {
      await verifyCatalogFile(
        fence.fileKey,
        fence.expectedDocId,
        fence.expectedDocumentEpoch,
      );
      await reconcileFences(fence);
      checkFence(
        fence,
        fenceKeys(fence).map((id) => memoryFences.get(id) ?? emptyFence(id)),
      );
      // A concurrent retry may have completed while the fence was checked.
      if (commitId !== undefined) outcome = sessionOutcomes.get(commitId);
    }
    if (outcome) return restorePublication(outcome, record);
    if (typeof window !== "undefined")
      throw new Error("当前环境不支持本机持久化组件库仓库");
    const existing = memory.get(record.id);
    compareLibrary(expected, existing, existing);
    record.savedAt = nextSavedAt(existing?.savedAt);
    memory.set(record.id, record);
    pending.add(record.id);
    if (commitId !== undefined)
      sessionOutcomes.set(commitId, catalogOutcome(commitId, record));
    return structuredClone(record);
  }
  if (commitId !== undefined) {
    const applied = await retryPublication(commitId, record);
    if (applied) return structuredClone(applied);
  }
  try {
    if (fence)
      return await saveScopedLibrary(record, expected, fence, commitId);
    if (commitId !== undefined) {
      const result = await editLibraryStage(await database(), async (tx) => {
        const libraries = tx.objectStore(storeName);
        const applied = await appliedLibrary(tx, commitId, record);
        if (applied) return applied;
        if (pending.has(record.id))
          throw new Error("工作区有未持久化的组件库变更，请刷新后重试");
        const raw = await query(libraries.get(record.id));
        const existing = readRecord(raw);
        compareLibrary(expected, existing, raw);
        record.savedAt = nextSavedAt(existing?.savedAt);
        libraries.put(record);
        tx.objectStore(fenceStore).put(catalogOutcome(commitId, record));
        return record;
      });
      return structuredClone(result);
    }
    return await writeWorkspaceRecord(record, (existing, raw) => {
      if (pending.has(record.id))
        throw new Error("工作区有未持久化的组件库变更，请刷新后重试");
      compareLibrary(expected, existing, raw);
    });
  } catch (error) {
    // The catalog transaction has stopped before any library write. Consult
    // the source database outside that transaction and durably retire orphans.
    if (error instanceof FenceInFlightError && options?.expectedFence)
      await reconcileFences(options.expectedFence);
    throw error;
  }
}

export async function saveWorkspaceLibrary(
  input: ComponentLibrary,
  sourceKind: WorkspaceLibrarySourceKind,
): Promise<WorkspaceLibraryRecord> {
  const record = makeRecord(input, sourceKind);
  if (typeof indexedDB !== "undefined") return writeWorkspaceRecord(record);
  if (typeof window !== "undefined")
    throw new Error("当前环境不支持本机持久化组件库仓库");
  pending.add(record.id);
  memory.set(record.id, record);
  return structuredClone(record);
}

export async function deleteWorkspaceLibrary(id: string): Promise<void> {
  try {
    await catalogRequest("readwrite", (store) => store.delete(id));
    pending.delete(id);
  } catch {
    pending.add(id);
  }
  memory.delete(id);
}

export type WorkspaceAiGuideUpdateResult =
  | { status: "updated"; record: WorkspaceLibraryRecord }
  | { status: "not-found" }
  | { status: "conflict"; currentRevision: number }
  | { status: "error"; message: string };

export async function updateWorkspaceLibraryAiGuide(
  id: string,
  expectedRevision: number,
  aiGuide: ComponentLibrary["aiGuide"],
): Promise<WorkspaceAiGuideUpdateResult> {
  try {
    const db = await database();
    return await new Promise<WorkspaceAiGuideUpdateResult>(
      (resolve, reject) => {
        const tx = db.transaction(storeName, "readwrite");
        const store = tx.objectStore(storeName);
        const request = store.get(id);
        let result: WorkspaceAiGuideUpdateResult;
        tx.onabort = () => reject(tx.error ?? new Error("工作区事务已取消"));
        tx.oncomplete = () => {
          if (result.status === "updated") memory.set(id, result.record);
          resolve(structuredClone(result));
        };
        request.onsuccess = () => {
          try {
            if (pending.has(id))
              throw new Error("工作区有未持久化的组件库变更");
            if (request.result === undefined) {
              result = { status: "not-found" };
              return;
            }
            const existing = readRecord(request.result);
            if (!existing) throw new Error("工作区组件库记录损坏");
            if (existing.revision !== expectedRevision) {
              result = {
                status: "conflict",
                currentRevision: existing.revision,
              };
              return;
            }
            const record = {
              ...existing,
              savedAt: nextSavedAt(existing.savedAt),
              library: parseLibrary({ ...existing.library, aiGuide }),
            };
            store.put(record);
            result = { status: "updated", record };
          } catch (error) {
            tx.abort();
            reject(error);
          }
        };
      },
    );
  } catch (error) {
    return {
      status: "error",
      message:
        "无法保存工作区说明书：" +
        (error instanceof Error ? error.message : String(error)),
    };
  }
}
