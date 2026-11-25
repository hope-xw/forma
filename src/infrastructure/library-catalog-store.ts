import { z } from "zod";
import { parseLibrary, type ComponentLibrary } from "../domain/library-schema";

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
    const request = indexedDB.open("forma-workspace-libraries-v1", 1);
    let blocked = false;
    request.onblocked = () => {
      blocked = true;
      reject(new Error("组件库仓库被其他窗口占用"));
    };
    request.onerror = () => reject(request.error);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(storeName))
        request.result.createObjectStore(storeName, { keyPath: "id" });
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
    tx.onabort = tx.onerror = () => reject(tx.error ?? request.error);
  });
}

// Cache the last readable catalog. A failed write or delete shadows its older disk entry.
const memory = new Map<string, WorkspaceLibraryRecord>();
const pending = new Set<string>();

export async function listWorkspaceLibraries(): Promise<
  WorkspaceLibraryRecord[]
> {
  try {
    const entries = await catalogRequest("readonly", (store) => store.getAll());
    for (const id of memory.keys()) if (!pending.has(id)) memory.delete(id);
    for (const entry of entries) {
      const record = readRecord(entry);
      if (record && !pending.has(record.id)) memory.set(record.id, record);
    }
  } catch {
    // Serve the in-memory catalog when IndexedDB is unavailable.
  }
  return Array.from(memory.values(), (record) => structuredClone(record)).sort(
    (a, b) => b.savedAt.localeCompare(a.savedAt),
  );
}

export async function saveWorkspaceLibrary(
  input: ComponentLibrary,
  sourceKind: WorkspaceLibrarySourceKind,
): Promise<WorkspaceLibraryRecord> {
  const library = parseLibrary(input);
  const record = {
    id: library.id,
    name: library.name,
    revision: library.revision,
    savedAt: new Date().toISOString(),
    sourceKind: sourceKinds.parse(sourceKind),
    componentCount: library.components.length,
    variantCount: variantCount(library),
    library,
  };
  try {
    await catalogRequest("readwrite", (store) => store.put(record));
    pending.delete(record.id);
  } catch {
    pending.add(record.id);
  }
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
              savedAt: new Date().toISOString(),
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
