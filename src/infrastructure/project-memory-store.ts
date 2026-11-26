import { z } from "zod";
import {
  beginWorkspaceScopeFence,
  endWorkspaceScopeFence,
  getWorkspaceLibraryRecord,
  registerFenceOpStatusChecker,
  withFenceOpClaim,
  fallbackFenceOpActive,
  isFallbackFenceOp,
  verifyFallbackFenceClaim,
} from "./library-catalog-store";
import { isSafeIdentifierKey } from "../domain/library-schema";
import {
  assertFileMemoryWritable,
  checkArchiveFile,
  authorizeFileCommit,
  acknowledgeFileCommit,
  isFileCommitAuthorized,
  checkPendingFileDeletion,
  readLiveFileState,
  withDocumentIdentityGuard,
  checkDeleteFenceOp,
} from "./storage";
import { stableHash } from "../domain/stable-hash";
import { transactionDone } from "./storage-parts";
import {
  UNSAVED_EPISODE_TIMESTAMP,
  designEpisodeSchema,
  episodeIdentityKey,
  freezeLegacyIdentity,
  fileProjectAssignmentSchema,
  fileScopeId,
  legacySnapshotContent,
  projectScopeId,
  projectSpaceSchema,
  sanitizeEpisodeThumbnailSvg,
  type DesignEpisode,
  type FileProjectAssignment,
  type ProjectSpace,
} from "../agent/project-memory";

type ProjectInput = Pick<
  ProjectSpace,
  "name" | "description" | "defaultLibraryId"
>;
type ProjectPatch = Partial<Pick<ProjectSpace, "name" | "description">> & {
  defaultLibraryId?: string | null;
};
type EpisodePatch = Partial<
  Pick<DesignEpisode, "title" | "pinned" | "summary">
>;
export class ProjectMemoryUnavailableError extends Error {
  readonly code = "PROJECT_MEMORY_UNAVAILABLE" as const;
}
export function isProjectMemoryUnavailableError(error: unknown): boolean {
  return (
    !!error &&
    typeof error === "object" &&
    "code" in error &&
    error.code === "PROJECT_MEMORY_UNAVAILABLE"
  );
}
export class FileLifetimeMismatchError extends Error {
  readonly code = "FILE_LIFETIME_MISMATCH" as const;
}
export function isFileLifetimeMismatchError(error: unknown): boolean {
  return (
    !!error &&
    typeof error === "object" &&
    "code" in error &&
    error.code === "FILE_LIFETIME_MISMATCH"
  );
}
export type GetFileProjectOptions = {
  expectedDocumentEpoch?: number;
  requireBoundLifetime?: boolean;
  requireDurable?: boolean;
  expectedLifetimeToken?: string;
  expectedDocId?: string;
};
export type EpisodeMutationGuard = {
  expectedDocumentEpoch?: number;
  expectedIdentityKey?: string;
  expectedScopeId?: string;
  sourceFileKey?: string;
  expectedLifetimeToken?: string;
  requireBoundLifetime?: boolean;
  expectedDocId?: string;
  expectedSnapshotKey?: string;
};
export type EpisodeSaveReceipt = { episode: DesignEpisode; durable: boolean };
export type AssignmentOptions = {
  expectedLifetimeToken?: string;
  migrateDraftEpisodes?: boolean;
  requireDurable?: boolean;
};
type DeletionOptions = { deletedDocId?: string; deletedLifetimeToken?: string };
type ActiveFile = {
  activeDocEpoch?: number;
  activeDocId?: string;
  activeLifetimeToken?: string;
  activeDocGeneration?: number;
};
type Activation = string | ActiveFile;
type LiveFileState = {
  documentEpoch?: number;
  docId?: string;
  lifetimeToken?: string;
  generation?: number;
  exists: boolean;
};
type LiveFileStateReader = (fileKey: string) => Promise<LiveFileState | null>;
let readLiveFile: LiveFileStateReader = readLiveFileState;
export function registerLiveFileStateReader(reader: LiveFileStateReader) {
  readLiveFile = reader;
}
type FileMutationCheck = (
  fileKey: string,
  expectedLifetimeToken?: string,
) => Promise<string | void>;
type FileWrite = {
  fileKey: string;
  docId?: string;
  documentEpoch?: number;
  mutationGuard?: boolean;
  requireBoundLifetime?: boolean;
  mutation?: EpisodeMutation;
  authorizedMutationStage?: MutationStage;
  token?: string;
  activation?: ActiveFile;
  requiresDocDbVerification?: boolean;
  expectedProjectId?: string | null;
  verifyProjectOnFlush?: boolean;
  live?: LiveFileState | null;
  archive?: Pick<ArchiveStage, "episode" | "archivedAt">;
  queuedPins?: QueuedPinState[];
  foldPins?: boolean;
  foldedPinIds?: Set<string>;
  authorizedStage?: ArchiveStage;
};
type HeldLock = { name: string; db: IDBDatabase | null };
type RunContext = {
  lock?: HeldLock;
  fileWrite?: FileWrite;
  mutation?: EpisodeMutation;
  resources?: Set<string>;
  fenceScope?: FenceScope;
};
type FenceScope = Parameters<typeof beginWorkspaceScopeFence>[0];
const completedOpsKey = "__forma_completed_fence_ops__";
const archiveStageGraceMs = 60_000;
const archiveStagePrefix = "__forma_staged_ep__:";
const mutationStagePrefix = "__staged_mut__:";
const appliedCommitPrefix = "__forma_applied_commit__:";
function memoryFenceClaims(db: IDBDatabase) {
  return {
    db,
    store: "tombstones",
    key: completedOpsKey,
    initial: { fileKey: completedOpsKey },
    inlineKey: true,
  };
}
async function withScopeChange<T>(
  scope: FenceScope | undefined,
  change: (opId?: string) => Promise<T>,
  db?: IDBDatabase,
): Promise<T> {
  if (!scope) return change();
  return withFenceOpClaim(
    db && memoryFenceClaims(db),
    "memory",
    async (opId) => {
      await beginWorkspaceScopeFence(scope, opId);
      try {
        return await change(opId);
      } finally {
        await endWorkspaceScopeFence(scope, opId).catch(() => {});
      }
    },
  );
}
const scopeQueues = new Map<string, Promise<void>>();
const unleasedFiles = new Set<string>();
function checkMemoryFileKey(key: string) {
  if (
    key.startsWith(leasePrefix) ||
    key.startsWith(archiveStagePrefix) ||
    key.startsWith(mutationStagePrefix) ||
    key.startsWith(appliedCommitPrefix) ||
    key === completedOpsKey
  )
    throw new Error("此键由项目记忆锁保留");
}
const fileLockName = (key: string) => {
  checkMemoryFileKey(key);
  return "forma:file-lock:" + key;
};
const projectLockName = (id: string) => "forma:project-lock:" + id;
const leasePrefix = "__forma_lock__:";
const leaseDuration = 15_000;
class ScopeLockBusy extends Error {}
type Lease = { fileKey: string; lockOwner: string; lockExpiresAt: number };

async function changeLease(
  db: IDBDatabase,
  key: string,
  owner: string,
  action: "acquire" | "renew" | "release",
) {
  const tx = db.transaction(["tombstones"], "readwrite");
  const done = new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error("项目记忆锁事务已取消"));
  });
  void done.catch(() => {});
  const store = tx.objectStore("tombstones");
  const lease: Lease | undefined = await requestResult(store.get(key));
  const ours = lease?.lockOwner === owner;
  if (
    action === "acquire" ? lease && lease.lockExpiresAt > Date.now() : !ours
  ) {
    tx.abort();
    await done.catch(() => {});
    return false;
  }
  if (action === "release") store.delete(key);
  else
    store.put({
      fileKey: key,
      lockOwner: owner,
      lockExpiresAt: Date.now() + leaseDuration,
    } satisfies Lease);
  await done;
  return true;
}

async function withLease<T>(
  db: IDBDatabase | null,
  name: string,
  task: () => Promise<T>,
  tryOnly: boolean,
) {
  if (!db) return task();
  const key = leasePrefix + name,
    owner = crypto.randomUUID();
  const deadline = Date.now() + leaseDuration;
  while (!(await changeLease(db, key, owner, "acquire"))) {
    if (tryOnly || Date.now() >= deadline)
      throw new ScopeLockBusy("项目记忆锁正忙，请重试");
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  // Publication can outlast the initial lease while another database commits.
  let renewal = Promise.resolve();
  const timer = setInterval(() => {
    renewal = renewal.then(async () => {
      if (!(await changeLease(db, key, owner, "renew")))
        throw new ScopeLockBusy("项目记忆锁已过期");
    });
    void renewal.catch(() => {});
  }, leaseDuration / 3);
  try {
    return await task();
  } finally {
    clearInterval(timer);
    try {
      await renewal;
    } finally {
      await changeLease(db, key, owner, "release");
    }
  }
}

async function acquireCrossTabLock<T>(
  name: string,
  task: () => Promise<T>,
  db: IDBDatabase | null,
  tryOnly = false,
): Promise<T> {
  if (tryOnly && scopeQueues.has(name)) throw new ScopeLockBusy();
  const previous = scopeQueues.get(name) ?? Promise.resolve();
  const result = previous.then(async () => {
    const locks = globalThis.navigator?.locks;
    const run = () => withLease(db, name, task, tryOnly);
    return locks?.request
      ? await locks.request(
          name,
          { mode: "exclusive", ...(tryOnly && { ifAvailable: true }) },
          (lock) => {
            if (tryOnly && !lock) throw new ScopeLockBusy();
            return run();
          },
        )
      : run();
  });
  const tail = result.then(
    () => {},
    () => {},
  );
  scopeQueues.set(name, tail);
  try {
    return await result;
  } finally {
    if (scopeQueues.get(name) === tail) scopeQueues.delete(name);
  }
}

export async function withFileProjectScopeLock<T>(
  fileKey: string,
  task: () => Promise<T>,
  options?: { projectId?: string },
): Promise<T> {
  const db = await defaultConnection.database();
  const file = () =>
    acquireCrossTabLock(
      fileLockName(fileKey),
      async () => {
        if (db) return task();
        // Reopening mid-publication cannot retroactively acquire the missing IDB lease.
        unleasedFiles.add(fileKey);
        try {
          return await task();
        } finally {
          unleasedFiles.delete(fileKey);
        }
      },
      db,
    );
  return options?.projectId
    ? acquireCrossTabLock(projectLockName(options.projectId), file, db)
    : file();
}

type AssignmentResult = {
  project: ProjectSpace | null;
  migratedEpisodes: number;
};

export interface ProjectMemoryRepository {
  isDurable(): Promise<boolean>;
  listProjects(): Promise<ProjectSpace[]>;
  getProject(id: string): Promise<ProjectSpace | null>;
  createProject(
    input: ProjectInput,
    options?: { requireDurable?: boolean },
  ): Promise<ProjectSpace>;
  updateProject(
    id: string,
    patch: ProjectPatch,
    options?: { expectedAssignedFileKey?: string },
  ): Promise<ProjectSpace>;
  deleteProject(
    id: string,
  ): Promise<{ unassignedFiles: string[]; deletedEpisodes: number }>;
  listFileAssignments(): Promise<Record<string, string>>;
  getFileProject(
    fileKey: string,
    options?: GetFileProjectOptions,
  ): Promise<ProjectSpace | null>;
  assignFileToProject(
    fileKey: string,
    projectId: string | null,
    options?: AssignmentOptions,
  ): Promise<AssignmentResult>;
  removeFileState(fileKey: string, options?: DeletionOptions): Promise<void>;
  clearFileTombstone(
    fileKey: string,
    activation?: Activation,
  ): Promise<{ activeLifetimeToken: string }>;
  getEpisode(id: string): Promise<DesignEpisode | null>;
  saveEpisodeWithReceipt(episode: DesignEpisode): Promise<EpisodeSaveReceipt>;
  listEpisodes(
    scopeProjectId: string,
    options?: { requireDurable?: boolean },
  ): Promise<DesignEpisode[]>;
  countEpisodesByScope(): Promise<Record<string, number>>;
  saveEpisode(episode: DesignEpisode): Promise<DesignEpisode>;
  updateEpisode(
    id: string,
    patch: EpisodePatch,
    guard?: EpisodeMutationGuard,
  ): Promise<DesignEpisode | null>;
  deleteEpisode(id: string, guard?: EpisodeMutationGuard): Promise<boolean>;
}

const dbName = "forma-project-memory-v1";
const listeners = new Set<() => void>();
let channel: BroadcastChannel | undefined;
function notifyListeners() {
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      /* A view listener cannot roll back a committed write. */
    }
  }
}
function broadcastChange() {
  notifyListeners();
  try {
    if (channel) channel.postMessage("changed");
    else if (
      !listeners.size &&
      typeof window !== "undefined" &&
      typeof BroadcastChannel !== "undefined"
    ) {
      const transient = new BroadcastChannel(dbName);
      try {
        transient.postMessage("changed");
      } finally {
        transient.close();
      }
    }
  } catch {
    /* Some storage partitions disable cross-tab delivery. */
  }
}
export function subscribeProjectMemory(listener: () => void): () => void {
  const first = !listeners.size;
  listeners.add(listener);
  if (first && typeof BroadcastChannel !== "undefined") {
    try {
      channel = new BroadcastChannel(dbName);
      channel.onmessage = (event) => {
        if (event.data === "changed") notifyListeners();
      };
      (channel as { unref?: () => void }).unref?.();
    } catch {
      /* Local subscriptions still work. */
    }
  }
  return () => {
    listeners.delete(listener);
    if (!listeners.size && channel) {
      channel.close();
      channel = undefined;
    }
  };
}

interface Records {
  projects: ProjectSpace;
  assignments: FileProjectAssignment;
  episodes: DesignEpisode;
  tombstones: {
    fileKey: string;
    activeDocEpoch?: number;
    activeLifetimeToken?: string;
    activeDocGeneration?: number;
    deletedLifetimeTokens: string[];
    activeDocId?: string;
    deletedDocIds: string[];
    deletedAt?: string;
  };
}
type Store = keyof Records;
type Data = { [K in Store]: Map<string, Records[K]> };
interface Tables {
  durable: boolean;
  get<K extends Store>(store: K, key: string): Promise<Records[K] | null>;
  all<K extends Store>(store: K): Promise<Records[K][]>;
  episodesIn(scope: string): Promise<DesignEpisode[]>;
  episodeKeysIn(scope: string): Promise<IDBValidKey[]>;
  eachEpisode(visit: (episode: DesignEpisode) => void): Promise<void>;
  put<K extends Store>(store: K, record: Records[K]): void;
  remove(store: Store, key: IDBValidKey): void;
}
class StaleFileError extends Error {}
type Operation<T> = (tables: Tables, replaying?: boolean) => Promise<T>;
const now = () => new Date().toISOString();
const storeSchemas: { [K in Store]: z.ZodType<Records[K]> } = {
  // This read schema preserves old bindings until the catalog has resolved its durable alias.
  projects: projectSpaceSchema.extend({
    defaultLibraryId: z.string().max(128).optional(),
  }),
  assignments: fileProjectAssignmentSchema,
  episodes: designEpisodeSchema,
  tombstones: z
    .object({
      fileKey: z.string(),
      activeDocId: z.string().optional(),
      activeDocEpoch: z.number().int().positive().optional(),
      activeDocGeneration: z.number().int().nonnegative().optional(),
      activeLifetimeToken: z.string().optional(),
      deletedLifetimeTokens: z.array(z.string()).default([]),
      deletedDocIds: z.array(z.string()).default([]),
      deletedDocId: z.string().optional(),
      deletedAt: z.iso.datetime({ offset: true }).optional(),
    })
    .transform(({ deletedDocId, deletedDocIds, ...row }) => ({
      ...row,
      deletedDocIds: deletedDocId
        ? [...new Set([...deletedDocIds, deletedDocId])].slice(-64)
        : deletedDocIds,
    })),
};
async function recoverProjectBinding(
  project: ProjectSpace,
): Promise<ProjectSpace> {
  const id = project.defaultLibraryId;
  if (!id || isSafeIdentifierKey(id)) return project;
  const library = await getWorkspaceLibraryRecord(id);
  return { ...project, defaultLibraryId: library?.id };
}

function checkLifetime(
  tombstone: Records["tombstones"] | null,
  token: string,
  message: string,
) {
  if (
    tombstone?.deletedAt ||
    tombstone?.deletedLifetimeTokens.includes(token) ||
    (tombstone?.activeLifetimeToken && tombstone.activeLifetimeToken !== token)
  )
    throw new FileLifetimeMismatchError(message);
}

function hasFileLifetime(tombstone: Records["tombstones"] | null) {
  return !!(
    tombstone?.activeLifetimeToken ||
    tombstone?.deletedAt ||
    tombstone?.deletedLifetimeTokens.length
  );
}
function epochChanged(
  tombstone: Records["tombstones"] | null,
  expected?: number,
) {
  return (
    expected !== undefined &&
    tombstone?.activeDocEpoch !== undefined &&
    tombstone.activeDocEpoch !== expected
  );
}

function mutationFileWrite(
  guard: EpisodeMutationGuard | undefined,
  op: EpisodeMutation["op"],
  targetId: string,
  patch?: EpisodePatch,
  updatedAt?: string,
): FileWrite | undefined {
  if (!guard?.sourceFileKey) return;
  return {
    fileKey: guard.sourceFileKey,
    token: guard.expectedLifetimeToken,
    docId: guard.expectedDocId,
    documentEpoch: guard.expectedDocumentEpoch,
    mutationGuard: true,
    requireBoundLifetime: guard.requireBoundLifetime,
    mutation: { op, targetId, patch, updatedAt, guard },
  };
}

function verifyArchiveIdentity(
  episode: DesignEpisode,
  token: string | undefined,
  live: LiveFileState | null | undefined,
): asserts live is LiveFileState {
  if (!live)
    throw new ProjectMemoryUnavailableError(
      "无法连接文件存储，稍后重试项目记忆同步",
    );
  if (!live.exists)
    throw new StaleFileError("该设计文件已删除，历史档案未写入");
  if (
    live.docId !== episode.sourceDocId ||
    (episode.sourceDocumentEpoch !== undefined &&
      live.documentEpoch !== episode.sourceDocumentEpoch) ||
    (live.lifetimeToken &&
      episode.sourceLifetimeToken &&
      live.lifetimeToken !== episode.sourceLifetimeToken) ||
    (live.lifetimeToken && token && live.lifetimeToken !== token)
  )
    throw new StaleFileError("该设计文件已替换为新版本，旧版历史档案未写入");
}

async function reconcileArchiveLifetime(
  t: Tables,
  fileKey: string,
  live?: LiveFileState | null,
  replacedToken?: string,
): Promise<Records["tombstones"] | null> {
  const previous = await t.get("tombstones", fileKey);
  if (
    !live?.exists ||
    !live.docId ||
    !live.lifetimeToken ||
    previous?.deletedLifetimeTokens.includes(live.lifetimeToken)
  )
    return previous;
  const sameLifetime = previous?.activeLifetimeToken === live.lifetimeToken;
  if (
    previous?.activeLifetimeToken &&
    !sameLifetime &&
    previous.activeLifetimeToken !== replacedToken
  )
    return previous;
  if (
    sameLifetime &&
    ((live.documentEpoch !== undefined &&
      live.documentEpoch < (previous.activeDocEpoch ?? 1)) ||
      (live.generation ?? 0) < (previous.activeDocGeneration ?? 0) ||
      (live.generation === previous.activeDocGeneration &&
        live.docId === previous.activeDocId &&
        (live.documentEpoch === undefined ||
          live.documentEpoch === previous.activeDocEpoch) &&
        !previous.deletedAt))
  )
    return previous;
  const next = {
    fileKey,
    activeDocId: live.docId,
    activeDocGeneration: live.generation,
    activeDocEpoch:
      live.documentEpoch ??
      (sameLifetime ? previous.activeDocEpoch : undefined),
    activeLifetimeToken: live.lifetimeToken,
    deletedDocIds: previous?.deletedDocIds ?? [],
    deletedLifetimeTokens: previous?.deletedLifetimeTokens ?? [],
  };
  t.put("tombstones", next);
  return next;
}

async function checkEpisodeMutation(
  t: Tables,
  ep: DesignEpisode | null,
  guard?: EpisodeMutationGuard,
) {
  if (
    guard?.sourceFileKey &&
    (guard.requireBoundLifetime ||
      guard.expectedLifetimeToken !== undefined ||
      guard.expectedDocId !== undefined ||
      guard.expectedDocumentEpoch !== undefined)
  ) {
    const tombstone = await t.get("tombstones", guard.sourceFileKey);
    if (
      (guard.expectedDocId !== undefined &&
        tombstone?.activeDocId &&
        tombstone.activeDocId !== guard.expectedDocId) ||
      epochChanged(tombstone, guard.expectedDocumentEpoch)
    )
      throw new FileLifetimeMismatchError(
        "当前文件已替换为新文档，无法修改历史档案",
      );
    if (
      guard.requireBoundLifetime &&
      !guard.expectedLifetimeToken &&
      hasFileLifetime(tombstone)
    )
      throw new FileLifetimeMismatchError(
        "当前文件未绑定有效会话，无法修改历史档案",
      );
    if (guard.expectedLifetimeToken !== undefined)
      checkLifetime(
        tombstone,
        guard.expectedLifetimeToken,
        "当前文件已在其他窗口删除或替换，无法修改历史档案",
      );
  }
  if (
    guard?.expectedSnapshotKey !== undefined &&
    (ep?.snapshotKey ?? ep?.id) !== guard.expectedSnapshotKey
  ) {
    const scope = guard.expectedScopeId ?? ep?.scopeProjectId;
    if (
      scope &&
      (await t.episodesIn(scope)).some(
        (row) => (row.snapshotKey ?? row.id) === guard.expectedSnapshotKey,
      )
    )
      throw new StaleFileError(
        "该历史需求档案的标识已更新，请刷新档案列表后重试",
      );
    if (ep)
      throw new StaleFileError("该历史需求档案已变更，请刷新档案列表后重试");
  }
  if (!ep || !guard?.expectedScopeId) return;
  if (ep.scopeProjectId !== guard.expectedScopeId)
    throw new StaleFileError("该历史档案所属项目空间已变更，请刷新后再操作");
  if (guard.sourceFileKey) {
    const assignment = await t.get("assignments", guard.sourceFileKey);
    const scope = assignment
      ? projectScopeId(assignment.projectId)
      : fileScopeId(guard.sourceFileKey);
    if (scope !== guard.expectedScopeId)
      throw new StaleFileError("当前文件所属项目空间已变更，请刷新后再操作");
  }
}
// Reconciliation may deduplicate a session snapshot onto a different display ID.
// A later pin or delete must follow that snapshot, never an unrelated ID occupant.
function episodeMutationTarget(mutation: EpisodeMutation) {
  const { targetId: id, guard } = mutation;
  return async (tables: Tables, replaying = false) => {
    const original = mutation.provisionalTarget;
    if (original === null) return null;
    const byId = await tables.get("episodes", id);
    const expected = guard?.expectedIdentityKey;
    if (expected !== undefined) {
      if (byId && episodeIdentityKey(byId) === expected) return byId;
      if (!byId || replaying) {
        const rows = guard?.expectedScopeId
          ? await tables.episodesIn(guard.expectedScopeId)
          : await tables.all("episodes");
        const matches = rows.filter(
          (row) => episodeIdentityKey(row) === expected,
        );
        if (matches.length === 1) return matches[0];
      }
      throw new StaleFileError(
        "该历史需求档案已变更或由新版本替代，请刷新档案列表后重试",
      );
    }
    // Older callers supply just the fingerprint. Let their existing guard reject an occupied ID.
    if (
      byId &&
      guard?.expectedSnapshotKey !== undefined &&
      (byId.snapshotKey ?? byId.id) !== guard.expectedSnapshotKey
    )
      return byId;
    if (original === undefined) {
      if (!tables.durable)
        mutation.provisionalTarget = byId && {
          scope: byId.scopeProjectId,
          identity: episodeIdentityKey(byId),
        };
      return byId;
    }
    const { scope, identity } = original;
    if (byId?.scopeProjectId === scope && episodeIdentityKey(byId) === identity)
      return byId;
    const matches = (await tables.episodesIn(scope)).filter(
      (row) => episodeIdentityKey(row) === identity,
    );
    return matches.length === 1 ? matches[0] : null;
  };
}

function byPriority(
  a: DesignEpisode,
  b: DesignEpisode,
  pendingPinnedIds?: ReadonlySet<string>,
) {
  return (
    Number(Boolean(b.pinned || pendingPinnedIds?.has(b.id))) -
      Number(Boolean(a.pinned || pendingPinnedIds?.has(a.id))) ||
    Date.parse(b.createdAt) - Date.parse(a.createdAt)
  );
}
async function enforceScopeLimit(
  tables: Tables,
  scope: string,
  incomingIds: Set<string>,
  pendingPinnedIds: ReadonlySet<string>,
) {
  if ((await tables.episodeKeysIn(scope)).length <= 100) return;
  const episodes = await tables.episodesIn(scope);
  const evicted = episodes
    .sort(
      (a, b) =>
        byPriority(a, b, pendingPinnedIds) ||
        Number(incomingIds.has(b.id)) - Number(incomingIds.has(a.id)) ||
        a.id.localeCompare(b.id),
    )
    .slice(100);
  if (
    evicted.some(
      (ep) =>
        ep.pinned || pendingPinnedIds.has(ep.id) || incomingIds.has(ep.id),
    )
  )
    throw new StaleFileError(
      "目标记忆空间已满（置顶档案已达上限），无法写入或迁移新档案，请先取消部分置顶",
    );
  for (const ep of evicted) tables.remove("episodes", ep.id);
}
function snapshotKey(ep: DesignEpisode) {
  if (ep.snapshotKey) return ep.snapshotKey;
  return ep.id.startsWith("ep-snapshot-") ? ep.id : undefined;
}

function snapshotsMatch(
  a: DesignEpisode,
  b: DesignEpisode,
  activeLifetimeToken?: string,
) {
  if (a.sourceFileKey !== b.sourceFileKey || a.sourceDocId !== b.sourceDocId)
    return false;
  const aModern = a.snapshotKey?.startsWith("v2:");
  const bModern = b.snapshotKey?.startsWith("v2:");
  if (a.sourceLifetimeToken !== b.sourceLifetimeToken) {
    const unbound = a.sourceLifetimeToken === undefined ? a : b;
    const bound = unbound === a ? b : a;
    if (
      unbound.sourceLifetimeToken !== undefined ||
      unbound.snapshotKey?.startsWith("v2:") ||
      bound.sourceLifetimeToken !== activeLifetimeToken
    )
      return false;
  }
  if (aModern && bModern) return a.snapshotKey === b.snapshotKey;
  if (!aModern && !bModern) {
    if (
      (a.legacyIdentity !== undefined || b.legacyIdentity !== undefined) &&
      episodeIdentityKey(a) !== episodeIdentityKey(b)
    )
      return false;
    if (
      a.createdAt !== UNSAVED_EPISODE_TIMESTAMP &&
      b.createdAt !== UNSAVED_EPISODE_TIMESTAMP &&
      a.createdAt !== b.createdAt
    )
      return false;
    return (
      (a.snapshotKey ?? a.id) === (b.snapshotKey ?? b.id) &&
      legacySnapshotContent(a) === legacySnapshotContent(b)
    );
  }
  // Matching previews cannot establish equality for data omitted from legacy rows.
  return false;
}

async function migrateDraftEpisodes(
  t: Tables,
  fileKey: string,
  scopeProjectId: string,
  updatedAt: string,
  verifiedToken?: string,
) {
  const drafts = await t.episodesIn(fileScopeId(fileKey));
  const tombstone = drafts.length ? await t.get("tombstones", fileKey) : null;
  const activeLifetimeToken = tombstone?.deletedAt
    ? undefined
    : (verifiedToken ?? tombstone?.activeLifetimeToken);
  if (
    drafts.length &&
    verifiedToken &&
    !tombstone?.deletedAt &&
    !tombstone?.activeLifetimeToken
  ) {
    t.put("tombstones", {
      fileKey,
      deletedDocIds: [],
      deletedLifetimeTokens: [],
      ...tombstone,
      activeLifetimeToken: verifiedToken,
    });
  }
  const destination = drafts.length ? await t.episodesIn(scopeProjectId) : [];
  const migrated = new Set<string>();
  for (const draft of drafts) {
    const ep =
      !draft.sourceLifetimeToken &&
      !draft.snapshotKey?.startsWith("v2:") &&
      activeLifetimeToken
        ? {
            ...draft,
            legacyIdentity: freezeLegacyIdentity(draft),
            sourceLifetimeToken: activeLifetimeToken,
          }
        : draft;
    const key = snapshotKey(ep);
    const existing = destination.find(
      (candidate) =>
        candidate.title === ep.title &&
        candidate.summary === ep.summary &&
        snapshotsMatch(candidate, ep, activeLifetimeToken),
    );
    if (existing) {
      const shouldPin = ep.pinned && !existing.pinned;
      const shouldBackfillToken =
        !existing.sourceLifetimeToken && ep.sourceLifetimeToken;
      if (shouldPin || shouldBackfillToken) {
        const merged = {
          ...existing,
          ...(shouldBackfillToken && {
            legacyIdentity: freezeLegacyIdentity(existing),
            sourceLifetimeToken: ep.sourceLifetimeToken,
          }),
          ...(shouldPin && { pinned: true }),
          updatedAt,
        };
        t.put("episodes", merged);
        destination[destination.indexOf(existing)] = merged;
      }
      t.remove("episodes", ep.id);
      migrated.add(existing.id);
    } else {
      const moved = {
        ...ep,
        ...(key && { snapshotKey: key }),
        scopeProjectId,
        updatedAt,
      };
      t.put("episodes", moved);
      destination.push(moved);
      migrated.add(ep.id);
    }
  }
  return migrated;
}
function safeThumbnail(episode: DesignEpisode): DesignEpisode {
  return episode.thumbnailSvg
    ? {
        ...episode,
        thumbnailSvg: sanitizeEpisodeThumbnailSvg(episode.thumbnailSvg),
      }
    : episode;
}

async function publishArchive(
  t: Tables,
  snapshot: DesignEpisode,
  archivedAt: string,
  fileWrite: FileWrite,
  resources: Set<string>,
  replaying = false,
): Promise<EpisodeSaveReceipt> {
  let episode = snapshot;
  const lifetime = await reconcileArchiveLifetime(
    t,
    episode.sourceFileKey,
    t.durable || replaying ? fileWrite.live : null,
  );
  if (
    lifetime?.deletedAt ||
    (episode.sourceLifetimeToken
      ? lifetime?.deletedLifetimeTokens.includes(episode.sourceLifetimeToken)
      : lifetime?.deletedDocIds.includes(episode.sourceDocId))
  )
    throw new StaleFileError("该设计文件已删除，历史档案未写入");
  if (
    (episode.sourceLifetimeToken &&
      lifetime?.activeLifetimeToken &&
      episode.sourceLifetimeToken !== lifetime.activeLifetimeToken) ||
    (lifetime?.activeDocId && lifetime.activeDocId !== episode.sourceDocId) ||
    epochChanged(lifetime, episode.sourceDocumentEpoch)
  )
    throw new StaleFileError("该设计文件已替换为新版本，旧版历史档案未写入");
  const assignment = await t.get("assignments", episode.sourceFileKey);
  let incomingIds = new Set<string>();
  if (episode.scopeProjectId.startsWith("proj:")) {
    const projectId = episode.scopeProjectId.slice(5);
    if (!fileWrite.verifyProjectOnFlush || t.durable || replaying) {
      if (!(await t.get("projects", projectId)))
        throw new StaleFileError("目标项目空间已不存在，历史档案未写入");
      if (assignment?.projectId !== projectId)
        throw new StaleFileError("文件所属项目已变更，历史档案未写入");
    }
  } else {
    if (episode.scopeProjectId !== fileScopeId(episode.sourceFileKey))
      throw new Error("历史档案作用域与来源文件不匹配");
    if (assignment) {
      const project = await t.get("projects", assignment.projectId);
      if (!project)
        throw new StaleFileError("目标项目空间已不存在，历史档案未写入");
      episode = {
        ...episode,
        scopeProjectId: projectScopeId(project.id),
      };
      incomingIds = await migrateDraftEpisodes(
        t,
        episode.sourceFileKey,
        episode.scopeProjectId,
        archivedAt,
      );
    }
  }
  const targetScope = episode.scopeProjectId;
  resources.add(targetScope);
  const pins = await prepareScopePins(t, targetScope, fileWrite);
  const incomingKey = snapshotKey(episode);
  const occupied = await t.get("episodes", snapshot.id);
  if (!incomingKey && occupied && occupied.scopeProjectId !== targetScope)
    throw new StaleFileError("历史档案 ID 已被其他记忆空间使用，档案未写入");
  if (incomingKey || occupied) {
    if (incomingKey) episode = { ...episode, snapshotKey: incomingKey };
    const existing = (await t.episodesIn(targetScope)).find((ep) =>
      snapshotsMatch(ep, episode, lifetime?.activeLifetimeToken),
    );
    if (existing) {
      resources.add("episode:" + existing.id);
      if (incomingIds.size)
        await enforceScopeLimit(t, targetScope, incomingIds, pins.reserved);
      return { episode: safeThumbnail(existing), durable: t.durable };
    }
    if (occupied) {
      // Repeated moves can leave both canonical IDs in other projects.
      const scopedId =
        "ep-snapshot-" + stableHash(targetScope + ":" + snapshot.id);
      let id = scopedId;
      for (let copy = 2; await t.get("episodes", id); copy++)
        id = scopedId + "-" + copy;
      episode = { ...episode, id, snapshotKey: incomingKey ?? snapshot.id };
    }
  }
  if (snapshot.createdAt === UNSAVED_EPISODE_TIMESTAMP)
    episode = { ...episode, createdAt: archivedAt, updatedAt: archivedAt };
  episode = pins.prepare(episode);
  resources.add("episode:" + episode.id);
  t.put("episodes", episode);
  incomingIds.add(episode.id);
  await enforceScopeLimit(t, targetScope, incomingIds, pins.reserved);
  return { episode, durable: t.durable };
}

abstract class ProjectMemoryOperations implements ProjectMemoryRepository {
  constructor(protected readonly checkFile?: FileMutationCheck) {}
  abstract isDurable(): Promise<boolean>;
  protected abstract run<T>(
    stores: Store[],
    mode: IDBTransactionMode,
    operation: Operation<T>,
    requireDurable?: boolean,
    context?: RunContext,
  ): Promise<T>;
  protected async database(): Promise<IDBDatabase | null> {
    return null;
  }
  private async locked<T>(name: string, task: (lock: HeldLock) => Promise<T>) {
    const db = await this.database();
    return acquireCrossTabLock(name, () => task({ name, db }), db);
  }

  listProjects() {
    return this.run(["projects"], "readonly", async (t) =>
      (await t.all("projects")).sort(
        (a, b) =>
          Date.parse(b.updatedAt) - Date.parse(a.updatedAt) ||
          a.id.localeCompare(b.id),
      ),
    ).then((projects) => Promise.all(projects.map(recoverProjectBinding)));
  }
  getProject(id: string) {
    return this.run(["projects"], "readonly", (t) =>
      t.get("projects", id),
    ).then((project) => project && recoverProjectBinding(project));
  }
  createProject(input: ProjectInput, options?: { requireDurable?: boolean }) {
    const date = now();
    const id = "proj-" + crypto.randomUUID();
    return this.run(
      ["projects"],
      "readwrite",
      async (t) => {
        const project = projectSpaceSchema.parse({
          ...input,
          id,
          createdAt: date,
          updatedAt: date,
        });
        t.put("projects", project);
        return project;
      },
      options?.requireDurable,
      { resources: new Set([projectScopeId(id)]) },
    );
  }
  async updateProject(
    id: string,
    patch: ProjectPatch,
    options?: { expectedAssignedFileKey?: string },
  ) {
    const updatedAt = now();
    if (patch.defaultLibraryId != null)
      projectSpaceSchema.shape.defaultLibraryId.parse(patch.defaultLibraryId);
    const resources = new Set([projectScopeId(id)]);
    if (options?.expectedAssignedFileKey)
      resources.add(fileScopeId(options.expectedAssignedFileKey));
    return this.run(
      ["projects", "assignments"],
      "readwrite",
      async (t) => {
        if (
          options?.expectedAssignedFileKey !== undefined &&
          (await t.get("assignments", options.expectedAssignedFileKey))
            ?.projectId !== id
        )
          throw new StaleFileError(
            "当前文件已移出该项目空间，未更新项目默认组件库",
          );
        const current = await t.get("projects", id);
        if (!current) throw new StaleFileError("项目空间不存在");
        const next = storeSchemas.projects.parse({
          ...current,
          name: patch.name ?? current.name,
          description: patch.description ?? current.description,
          defaultLibraryId:
            patch.defaultLibraryId === undefined
              ? current.defaultLibraryId
              : (patch.defaultLibraryId ?? undefined),
          updatedAt,
        });
        t.put("projects", next);
        return next;
      },
      false,
      { resources },
    ).then(recoverProjectBinding);
  }
  deleteProject(id: string) {
    const resources = new Set([projectScopeId(id)]);
    return this.locked(projectLockName(id), (lock) =>
      this.run(
        ["projects", "assignments", "episodes"],
        "readwrite",
        async (t) => {
          if (!(await t.get("projects", id)))
            return { unassignedFiles: [], deletedEpisodes: 0 };
          const assignments = (await t.all("assignments")).filter(
            (a) => a.projectId === id,
          );
          const episodes = await t.episodeKeysIn(projectScopeId(id));
          for (const a of assignments) {
            resources.add(fileScopeId(a.fileKey));
            t.remove("assignments", a.fileKey);
          }
          for (const key of episodes) t.remove("episodes", key);
          t.remove("projects", id);
          return {
            unassignedFiles: assignments.map((a) => a.fileKey).sort(),
            deletedEpisodes: episodes.length,
          };
        },
        false,
        { lock, resources, fenceScope: { projectId: id } },
      ),
    );
  }
  listFileAssignments() {
    return this.run(["assignments"], "readonly", async (t) =>
      Object.fromEntries(
        (await t.all("assignments")).map((a) => [a.fileKey, a.projectId]),
      ),
    );
  }
  private async checkLiveLifetime(
    fileKey: string,
    options: GetFileProjectOptions | undefined,
    mismatch: string,
    unbound: string,
  ) {
    const token = options?.expectedLifetimeToken;
    if (
      ((token !== undefined || options?.requireBoundLifetime) &&
        this.checkFile === assertFileMemoryWritable) ||
      options?.expectedDocId !== undefined ||
      options?.expectedDocumentEpoch !== undefined
    ) {
      if ((await checkPendingFileDeletion(fileKey)) === "pending")
        throw new FileLifetimeMismatchError(
          token === undefined ? unbound : mismatch,
        );
      const live = await readLiveFile(fileKey);
      if (
        (options?.expectedDocId !== undefined &&
          live?.docId &&
          live.exists &&
          live.docId !== options.expectedDocId) ||
        (options?.expectedDocumentEpoch !== undefined &&
          live &&
          live.documentEpoch !== options.expectedDocumentEpoch)
      )
        throw new FileLifetimeMismatchError(
          "当前文件已导入或替换为新文档，请刷新后再操作",
        );
      if (options?.requireBoundLifetime && token === undefined && live?.exists)
        throw new FileLifetimeMismatchError(unbound);
      if (
        token !== undefined &&
        live &&
        (!live.exists || (live.lifetimeToken && live.lifetimeToken !== token))
      )
        throw new FileLifetimeMismatchError(mismatch);
      return live;
    }
  }

  async getFileProject(
    fileKey: string,
    options?: GetFileProjectOptions,
  ): Promise<ProjectSpace | null> {
    if (options?.requireDurable && unleasedFiles.has(fileKey))
      throw new ProjectMemoryUnavailableError(
        "无法连接项目记忆存储，无法核验当前项目作用域",
      );
    const token = options?.expectedLifetimeToken;
    const mismatch = "当前文件已在其他窗口删除或替换，请重新打开文件";
    const live = await this.checkLiveLifetime(
      fileKey,
      options,
      mismatch,
      "当前文件未绑定有效会话，请重新打开文件",
    );
    const resources = new Set([fileScopeId(fileKey)]);
    const project = await this.run(
      ["projects", "assignments", "tombstones"],
      "readonly",
      async (t) => {
        if (
          token !== undefined ||
          options?.requireBoundLifetime ||
          options?.expectedDocId !== undefined ||
          options?.expectedDocumentEpoch !== undefined
        ) {
          const tombstone = await t.get("tombstones", fileKey);
          if (
            (options?.expectedDocId !== undefined &&
              tombstone?.activeDocId &&
              tombstone.activeDocId !== options.expectedDocId) ||
            epochChanged(tombstone, options?.expectedDocumentEpoch)
          )
            throw new FileLifetimeMismatchError(
              "当前文件已导入或替换为新文档，请刷新后再操作",
            );
          if (
            options?.requireBoundLifetime &&
            token === undefined &&
            hasFileLifetime(tombstone)
          )
            throw new FileLifetimeMismatchError(
              "当前文件未绑定有效会话，请重新打开文件",
            );
          if (token !== undefined) checkLifetime(tombstone, token, mismatch);
          if (
            (options?.expectedDocId !== undefined ||
              options?.expectedDocumentEpoch !== undefined) &&
            options.requireDurable &&
            live === null
          )
            throw new ProjectMemoryUnavailableError(
              "无法核验当前文件的文档标识，请稍后重试",
            );
        }
        const assignment = await t.get("assignments", fileKey);
        if (assignment) resources.add(projectScopeId(assignment.projectId));
        return assignment ? t.get("projects", assignment.projectId) : null;
      },
      options?.requireDurable,
      { resources },
    );
    return project && recoverProjectBinding(project);
  }
  assignFileToProject(
    fileKey: string,
    projectId: string | null,
    options?: AssignmentOptions,
  ) {
    let sessionAssignment: string | null | undefined;
    const resources = new Set([fileScopeId(fileKey)]);
    if (projectId) resources.add(projectScopeId(projectId));
    return this.locked(fileLockName(fileKey), async (lock) => {
      const token =
        (await this.checkFile?.(fileKey, options?.expectedLifetimeToken)) ||
        options?.expectedLifetimeToken;
      const updatedAt = now();
      const fileWrite: FileWrite = { fileKey, token };
      return this.run(
        ["projects", "assignments", "episodes", "tombstones"],
        "readwrite",
        async (t) => {
          const lifetime = await t.get("tombstones", fileKey);
          if (
            options?.expectedLifetimeToken &&
            (lifetime?.deletedAt ||
              lifetime?.deletedLifetimeTokens.includes(
                options.expectedLifetimeToken,
              ) ||
              (lifetime?.activeLifetimeToken &&
                lifetime.activeLifetimeToken !== options.expectedLifetimeToken))
          )
            throw new StaleFileError(
              "该设计文件已删除或已替换，请刷新文件列表后重试",
            );
          if (!t.durable) {
            const current =
              (await t.get("assignments", fileKey))?.projectId ?? null;
            if (current) resources.add(projectScopeId(current));
            if (sessionAssignment === undefined) sessionAssignment = current;
            else if (current !== sessionAssignment && current !== projectId)
              throw new StaleFileError("文件所属项目已变更，请刷新后重试");
          }
          if (projectId === null) {
            t.remove("assignments", fileKey);
            return { project: null, migratedEpisodes: 0 };
          }
          if (lifetime?.deletedAt)
            throw new StaleFileError("该设计文件已删除，无法修改项目归属");
          const project = await t.get("projects", projectId);
          if (!project) throw new StaleFileError("目标项目空间不存在");
          const assignment = fileProjectAssignmentSchema.parse({
            fileKey,
            projectId,
            updatedAt,
          });
          t.put("assignments", assignment);
          if (options?.migrateDraftEpisodes === false)
            return { project, migratedEpisodes: 0 };
          const scope = projectScopeId(projectId);
          const migrated = await migrateDraftEpisodes(
            t,
            fileKey,
            scope,
            updatedAt,
            token,
          );
          if (migrated.size) {
            const pins = await prepareScopePins(t, scope, fileWrite);
            await enforceScopeLimit(t, scope, migrated, pins.reserved);
          }
          return { project, migratedEpisodes: migrated.size };
        },
        options?.requireDurable,
        {
          lock,
          resources,
          fileWrite,
          fenceScope: { fileKey },
        },
      ).then(async (result) => ({
        ...result,
        project:
          result.project && (await recoverProjectBinding(result.project)),
      }));
    });
  }
  removeFileState(fileKey: string, options?: DeletionOptions) {
    checkMemoryFileKey(fileKey);
    const deletedAt = now();
    return this.run(
      ["assignments", "episodes", "tombstones"],
      "readwrite",
      async (t) => {
        const previous = await t.get("tombstones", fileKey);
        if (
          options?.deletedLifetimeToken &&
          previous?.activeLifetimeToken &&
          previous.activeLifetimeToken !== options.deletedLifetimeToken &&
          previous.deletedLifetimeTokens.includes(options.deletedLifetimeToken)
        )
          return;
        const deletedIds = new Set(previous?.deletedDocIds);
        const deletedDocId = options?.deletedDocId ?? previous?.activeDocId;
        if (deletedDocId) {
          deletedIds.delete(deletedDocId);
          deletedIds.add(deletedDocId);
        }
        const tokens = new Set(previous?.deletedLifetimeTokens);
        for (const token of [
          previous?.activeLifetimeToken,
          options?.deletedLifetimeToken,
        ]) {
          if (token) {
            tokens.delete(token);
            tokens.add(token);
          }
        }
        const privateEpisodes = await t.episodeKeysIn(fileScopeId(fileKey));
        for (const key of privateEpisodes) t.remove("episodes", key);
        t.remove("assignments", fileKey);
        t.put("tombstones", {
          fileKey,
          deletedLifetimeTokens: [...tokens].slice(-64),
          deletedDocIds: [...deletedIds].slice(-64),
          deletedAt,
        });
      },
      false,
      { resources: new Set([fileScopeId(fileKey)]), fenceScope: { fileKey } },
    );
  }
  clearFileTombstone(
    fileKey: string,
    activation?: Activation,
    options?: { requireDurable?: boolean },
  ) {
    checkMemoryFileKey(fileKey);
    const incoming: ActiveFile =
      typeof activation === "string"
        ? { activeDocId: activation }
        : (activation ?? {});
    const { activeDocId, activeDocGeneration, activeDocEpoch } = incoming;
    const activeLifetimeToken =
      incoming.activeLifetimeToken ?? crypto.randomUUID();
    return this.run(
      ["tombstones"],
      "readwrite",
      async (t) => {
        const previous = await t.get("tombstones", fileKey);
        const sameLifetime =
          previous?.activeLifetimeToken === incoming.activeLifetimeToken;
        const epoch =
          activeDocEpoch ??
          (sameLifetime ? previous?.activeDocEpoch : undefined);
        if (
          sameLifetime &&
          ((activeDocEpoch !== undefined &&
            activeDocEpoch < (previous?.activeDocEpoch ?? 1)) ||
            (previous?.activeDocGeneration !== undefined &&
              activeDocGeneration !== undefined &&
              activeDocGeneration < previous.activeDocGeneration))
        )
          return { activeLifetimeToken };
        if (previous?.deletedLifetimeTokens.includes(activeLifetimeToken))
          throw new StaleFileError("该设计文件已删除，不能恢复旧文件生命周期");
        if (
          previous?.activeLifetimeToken !== activeLifetimeToken ||
          previous.activeDocId !== activeDocId ||
          (activeDocEpoch !== undefined &&
            activeDocEpoch !== previous.activeDocEpoch) ||
          (activeDocGeneration !== undefined &&
            previous.activeDocGeneration !== activeDocGeneration) ||
          previous.deletedAt
        )
          t.put("tombstones", {
            fileKey,
            activeDocId,
            ...(epoch !== undefined && { activeDocEpoch: epoch }),
            ...((activeDocGeneration !== undefined ||
              (sameLifetime &&
                previous?.activeDocGeneration !== undefined)) && {
              activeDocGeneration:
                activeDocGeneration ?? previous?.activeDocGeneration,
            }),
            activeLifetimeToken,
            deletedDocIds: previous?.deletedDocIds ?? [],
            deletedLifetimeTokens: previous?.deletedLifetimeTokens ?? [],
          });
        return { activeLifetimeToken };
      },
      options?.requireDurable,
      {
        fileWrite: {
          fileKey,
          activation: {
            activeDocId,
            activeLifetimeToken,
            activeDocGeneration,
            activeDocEpoch,
          },
        },
      },
    );
  }
  getEpisode(id: string) {
    return this.run(["episodes"], "readonly", async (t) => {
      const ep = await t.get("episodes", id);
      return ep && safeThumbnail(ep);
    });
  }
  listEpisodes(scopeProjectId: string, options?: { requireDurable?: boolean }) {
    return this.run(
      ["episodes"],
      "readonly",
      async (t) =>
        (await t.episodesIn(scopeProjectId))
          .sort((a, b) => byPriority(a, b) || a.id.localeCompare(b.id))
          .map(safeThumbnail),
      options?.requireDurable,
      { resources: new Set([scopeProjectId]) },
    );
  }
  countEpisodesByScope() {
    return this.run(["episodes"], "readonly", async (t) => {
      const counts = new Map<string, number>();
      await t.eachEpisode((ep) => {
        counts.set(ep.scopeProjectId, 1 + (counts.get(ep.scopeProjectId) ?? 0));
      });
      return Object.fromEntries(counts);
    });
  }
  async saveEpisode(input: DesignEpisode) {
    return (await this.saveEpisodeWithReceipt(input)).episode;
  }
  async saveEpisodeWithReceipt(
    input: DesignEpisode,
  ): Promise<EpisodeSaveReceipt> {
    const snapshot = safeThumbnail(designEpisodeSchema.parse(input));
    // A queued save and every replay identify the same capture, even across tabs.
    if (
      !snapshot.captureId &&
      (snapshot.snapshotKey?.startsWith("v2:") ||
        snapshot.createdAt === UNSAVED_EPISODE_TIMESTAMP)
    )
      snapshot.captureId = crypto.randomUUID();
    const archivedAt = new Date(Date.now()).toISOString();
    const resources = new Set([
      fileScopeId(snapshot.sourceFileKey),
      snapshot.scopeProjectId,
      "episode:" + snapshot.id,
    ]);
    return this.locked(fileLockName(snapshot.sourceFileKey), (lock) =>
      withDocumentIdentityGuard(snapshot.sourceFileKey, async () => {
        const { status, token } =
          this.checkFile === assertFileMemoryWritable
            ? await checkArchiveFile(
                snapshot.sourceFileKey,
                snapshot.sourceLifetimeToken,
              )
            : {
                status: "clean",
                token:
                  (await this.checkFile?.(
                    snapshot.sourceFileKey,
                    snapshot.sourceLifetimeToken,
                  )) || snapshot.sourceLifetimeToken,
              };
        if (status === "stale")
          throw new StaleFileError(
            "该设计文件已删除或已替换，请刷新文件列表后重试",
          );
        if (status === "pending")
          throw new StaleFileError("该设计文件已删除，历史档案未写入");
        // Read Forma's committed document while holding the file lock, before
        // opening the separate memory transaction. Journal replay refreshes it.
        const checkDocument =
          this.checkFile !== undefined && typeof indexedDB !== "undefined";
        const live =
          checkDocument && status === "clean"
            ? await readLiveFile(snapshot.sourceFileKey)
            : null;
        if (live && snapshot.sourceDocumentEpoch !== undefined)
          verifyArchiveIdentity(snapshot, token, live);
        const fileWrite: FileWrite = {
          fileKey: snapshot.sourceFileKey,
          token,
          archive: { episode: snapshot, archivedAt },
          expectedProjectId: snapshot.scopeProjectId.startsWith("proj:")
            ? snapshot.scopeProjectId.slice(5)
            : null,
          live,
          requiresDocDbVerification: checkDocument && !live,
        };
        return this.run(
          ["projects", "assignments", "episodes", "tombstones"],
          "readwrite",
          (t, replaying) =>
            publishArchive(
              t,
              snapshot,
              archivedAt,
              fileWrite,
              resources,
              replaying,
            ),
          false,
          {
            lock,
            resources,
            fileWrite,
          },
        );
      }),
    ).catch((error: unknown) => {
      if (error instanceof ArchivePublishedByPeer) return error.receipt;
      throw error;
    });
  }
  updateEpisode(id: string, patch: EpisodePatch, guard?: EpisodeMutationGuard) {
    return this.mutateEpisode("update", id, guard, patch);
  }
  deleteEpisode(id: string, guard?: EpisodeMutationGuard) {
    return this.mutateEpisode("delete", id, guard);
  }
  private mutateEpisode(
    op: "delete",
    id: string,
    guard?: EpisodeMutationGuard,
  ): Promise<boolean>;
  private mutateEpisode(
    op: "update",
    id: string,
    guard: EpisodeMutationGuard | undefined,
    patch: EpisodePatch,
  ): Promise<DesignEpisode | null>;
  private async mutateEpisode(
    op: EpisodeMutation["op"],
    id: string,
    guard?: EpisodeMutationGuard,
    patch?: EpisodePatch,
  ) {
    guard = guard && { ...guard };
    patch =
      patch &&
      designEpisodeSchema
        .pick({ title: true, summary: true, pinned: true })
        .partial()
        .parse(patch);
    if (
      guard?.sourceFileKey &&
      (guard.requireBoundLifetime ||
        guard.expectedDocId !== undefined ||
        guard.expectedDocumentEpoch !== undefined ||
        guard.expectedLifetimeToken !== undefined)
    )
      await this.checkLiveLifetime(
        guard.sourceFileKey,
        guard,
        "当前文件已在其他窗口删除或替换，无法修改历史档案",
        "当前文件未绑定有效会话，无法修改历史档案",
      );
    const resources = new Set(["episode:" + id]);
    if (guard?.sourceFileKey) resources.add(fileScopeId(guard.sourceFileKey));
    if (guard?.expectedScopeId) resources.add(guard.expectedScopeId);
    const updatedAt = op === "update" ? now() : undefined;
    const fileWrite = mutationFileWrite(guard, op, id, patch, updatedAt);
    const mutation = fileWrite?.mutation ?? {
      op,
      targetId: id,
      patch,
      updatedAt,
      guard: guard ?? {},
    };
    return this.run(
      mutationStores,
      "readwrite",
      episodeMutationOperation(mutation, resources),
      false,
      { resources, fileWrite, mutation },
    ).catch((error: unknown) => {
      if (error instanceof MutationAppliedByPeer) return error.result;
      throw error;
    });
  }
}

export class MemoryProjectMemoryRepository extends ProjectMemoryOperations {
  async isDurable(): Promise<boolean> {
    return false;
  }
  protected data: Data = {
    projects: new Map(),
    assignments: new Map(),
    episodes: new Map(),
    tombstones: new Map(),
  };
  private pending: Promise<void> = Promise.resolve();

  protected run<T>(
    _stores: Store[],
    mode: IDBTransactionMode,
    operation: Operation<T>,
    requireDurable = false,
    context?: RunContext,
  ): Promise<T> {
    if (requireDurable)
      return Promise.reject(
        new ProjectMemoryUnavailableError(
          "当前浏览器未启用本地持久存储，跨页跳转后项目归属无法保存",
        ),
      );
    const result = this.pending.then(() =>
      withScopeChange(
        typeof indexedDB === "undefined" ? context?.fenceScope : undefined,
        async () => {
          // Replace maps only on commit. Records are immutable inside a transaction.
          const data =
            mode === "readonly"
              ? this.data
              : {
                  projects: new Map(this.data.projects),
                  assignments: new Map(this.data.assignments),
                  episodes: new Map(this.data.episodes),
                  tombstones: new Map(this.data.tombstones),
                };
          const table = <K extends Store>(key: K): Map<string, Records[K]> =>
            data[key];
          let changed = false;
          const value = await operation({
            durable: false,
            get: async (store, key) => table(store).get(key) ?? null,
            all: async (store) => [...table(store).values()],
            eachEpisode: async (visit) => {
              data.episodes.forEach(visit);
            },
            episodesIn: async (scope) =>
              [...data.episodes.values()].filter(
                (ep) => ep.scopeProjectId === scope,
              ),
            episodeKeysIn: async (scope) =>
              [...data.episodes.values()]
                .filter((ep) => ep.scopeProjectId === scope)
                .map((ep) => ep.id),
            put: (store, record) => {
              table(store).set(
                "fileKey" in record ? record.fileKey : record.id,
                record,
              );
              changed = true;
            },
            remove: (store, key) => {
              if (typeof key === "string")
                changed = table(store).delete(key) || changed;
            },
          });
          if (changed) {
            this.data = data;
            notifyListeners();
          }
          return structuredClone(value);
        },
      ),
    );
    this.pending = result.then(
      () => {},
      () => {},
    );
    return result;
  }
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
function parseRow<K extends Store>(store: K, raw: unknown): Records[K] | null {
  if (
    store === "tombstones" &&
    raw &&
    typeof raw === "object" &&
    "fileKey" in raw &&
    typeof raw.fileKey === "string" &&
    (raw.fileKey.startsWith(leasePrefix) ||
      raw.fileKey.startsWith(archiveStagePrefix) ||
      raw.fileKey.startsWith(mutationStagePrefix) ||
      raw.fileKey.startsWith(appliedCommitPrefix) ||
      raw.fileKey === completedOpsKey)
  )
    return null;
  const parsed = storeSchemas[store].safeParse(raw);
  return parsed.success ? parsed.data : null;
}
function parseRows<K extends Store>(store: K, raw: unknown[]): Records[K][] {
  const valid: Records[K][] = [];
  for (const row of raw) {
    const parsed = parseRow(store, row);
    if (parsed) valid.push(parsed);
  }
  return valid;
}

// A failed commit can still serve a coherent view of disk plus session changes.
// Buffer only touched rows; reads of episode scopes keep using the IndexedDB index.
function stagedTables(base: Tables) {
  const changes = new Map<Store, Map<string, Records[Store] | null>>();
  function rows(store: Store) {
    let values = changes.get(store);
    if (!values) changes.set(store, (values = new Map()));
    return values;
  }
  const keyOf = (record: Records[Store]) =>
    "fileKey" in record ? record.fileKey : record.id;
  function merge<K extends Store>(
    store: K,
    persisted: Records[K][],
    include: (row: Records[K]) => boolean = () => true,
  ) {
    const delta = rows(store);
    const result = persisted.filter((row) => !delta.has(keyOf(row)));
    for (const row of delta.values())
      if (row && include(row as Records[K])) result.push(row as Records[K]);
    return result;
  }
  const tables: Tables = {
    durable: false,
    get: async <K extends Store>(store: K, key: string) => {
      const row = rows(store).get(key);
      return row === undefined
        ? base.get(store, key)
        : (row as Records[K] | null);
    },
    all: async (store) => merge(store, await base.all(store)),
    episodesIn: async (scope) =>
      merge(
        "episodes",
        await base.episodesIn(scope),
        (ep) => ep.scopeProjectId === scope,
      ),
    episodeKeysIn: async (scope) => {
      const delta = rows("episodes");
      const keys = (await base.episodeKeysIn(scope)).filter(
        (key) => !delta.has(String(key)),
      );
      for (const [id, ep] of delta)
        if (ep && "scopeProjectId" in ep && ep.scopeProjectId === scope)
          keys.push(id);
      return keys;
    },
    eachEpisode: async (visit) => {
      const delta = rows("episodes");
      await base.eachEpisode((ep) => {
        if (!delta.has(ep.id)) visit(ep);
      });
      for (const ep of delta.values())
        if (ep && "scopeProjectId" in ep) visit(ep);
    },
    put: (store, row) => {
      rows(store).set(keyOf(row), row);
    },
    remove: (store, key) => {
      rows(store).set(String(key), null);
    },
  };
  return {
    tables,
    apply(target: Tables = base) {
      for (const [store, delta] of changes)
        for (const [id, row] of delta) {
          if (row) target.put(store, row);
          else target.remove(store, id);
        }
    },
  };
}

type EpisodeMutation = {
  op: "delete" | "update";
  targetId: string;
  patch?: EpisodePatch;
  updatedAt?: string;
  guard: EpisodeMutationGuard;
  // Readers completing a session edit must resolve the same provisional selection.
  provisionalTarget?: { scope: string; identity: string } | null;
};
type QueuedPinState = {
  targetId: string;
  guard: EpisodeMutationGuard;
  state: "pinned" | "unpinned" | "deleted";
  updatedAt?: string;
  foldId?: string;
  pinOnly?: boolean;
};
type MutationBinding = {
  op: EpisodeMutation["op"];
  fileKey: string;
  targetId: string;
  expectedScopeId: string | null;
  expectedIdentityKey: string | null;
  expectedSnapshotKey: string | null;
  expectedDocId: string | null;
  expectedDocumentEpoch: number | null;
  expectedLifetimeToken: string | null;
};
type MutationStage = EpisodeMutation & {
  fileKey: string;
  __formaStagedMutation: true;
  commitId: string;
  stagedAt: number;
  binding: MutationBinding;
};
function mutationBinding({
  op,
  targetId,
  guard,
}: EpisodeMutation): MutationBinding {
  return {
    op,
    targetId,
    fileKey: guard.sourceFileKey!,
    expectedScopeId: guard.expectedScopeId ?? null,
    expectedIdentityKey: guard.expectedIdentityKey ?? null,
    expectedSnapshotKey: guard.expectedSnapshotKey ?? null,
    expectedDocId: guard.expectedDocId ?? null,
    expectedDocumentEpoch: guard.expectedDocumentEpoch ?? null,
    expectedLifetimeToken: guard.expectedLifetimeToken ?? null,
  };
}
const mutationStores: Store[] = ["assignments", "episodes", "tombstones"];
function episodeMutationOperation(
  mutation: EpisodeMutation,
  resources?: Set<string>,
): Operation<boolean | DesignEpisode | null> {
  const { op, guard, patch, updatedAt } = mutation;
  const target = episodeMutationTarget(mutation);
  return async (t, replaying = false) => {
    const ep = await target(t, replaying);
    if (ep) resources?.add(ep.scopeProjectId);
    await checkEpisodeMutation(t, ep, guard);
    if (!ep) return op === "delete" ? false : null;
    if (op === "delete") {
      t.remove("episodes", ep.id);
      return true;
    }
    // The archive transaction may already have published this queued pin.
    if (
      patch?.pinned === true &&
      ep.pinned &&
      patch.title === undefined &&
      patch.summary === undefined
    )
      return ep;
    const freezeIdentity =
      !ep.legacyIdentity &&
      !ep.snapshotKey?.startsWith("v2:") &&
      ((patch?.title !== undefined && patch.title !== ep.title) ||
        (patch?.summary !== undefined && patch.summary !== ep.summary));
    const next = safeThumbnail(
      designEpisodeSchema.parse({
        ...ep,
        ...(freezeIdentity && { legacyIdentity: freezeLegacyIdentity(ep) }),
        title: patch?.title ?? ep.title,
        pinned: patch?.pinned ?? ep.pinned,
        summary: patch?.summary ?? ep.summary,
        updatedAt,
      }),
    );
    t.put("episodes", next);
    return next;
  };
}

type ArchiveStage = {
  fileKey: string;
  __formaStagedEpisode: true;
  commitId: string;
  stagedAt: number;
  archivedAt: string;
  episode: DesignEpisode;
  live: LiveFileState;
  expectedProjectId?: string | null;
  queuedPins?: QueuedPinState[];
  // Legacy reservation-only stages did not persist mutation guards.
  pendingPinned?: { ids: Set<string>; identityKeys: Set<string> };
  pendingPin?: boolean;
};
const archiveStores: Store[] = [
  "projects",
  "assignments",
  "episodes",
  "tombstones",
];
class MutationAppliedByPeer extends Error {
  constructor(readonly result: DesignEpisode | null | boolean) {
    super();
  }
}
class ArchivePublishedByPeer extends Error {
  constructor(readonly receipt: EpisodeSaveReceipt) {
    super();
  }
}

class MemoryDatabaseConnection {
  private opening?: Promise<IDBDatabase | null>;
  database(): Promise<IDBDatabase | null> {
    if (this.opening) return this.opening;
    this.opening = new Promise<IDBDatabase | null>((resolve, reject) => {
      let request: IDBOpenDBRequest;
      try {
        if (typeof indexedDB === "undefined") {
          resolve(null);
          return;
        }
        request = indexedDB.open(dbName, 2);
      } catch {
        resolve(null);
        return;
      }
      let blocked = false;
      request.onblocked = () => {
        blocked = true;
        reject(new ProjectMemoryUnavailableError("项目记忆仓库被其他窗口占用"));
      };
      request.onerror = () => {
        if (
          [
            "SecurityError",
            "InvalidStateError",
            "UnknownError",
            "NotAllowedError",
          ].includes(request.error?.name ?? "")
        )
          resolve(null);
        else reject(request.error);
      };
      request.onupgradeneeded = () => {
        if (blocked) {
          request.transaction?.abort();
          return;
        }
        const db = request.result;
        if (!db.objectStoreNames.contains("projects"))
          db.createObjectStore("projects", { keyPath: "id" });
        if (!db.objectStoreNames.contains("assignments"))
          db.createObjectStore("assignments", { keyPath: "fileKey" });
        if (!db.objectStoreNames.contains("episodes"))
          db.createObjectStore("episodes", { keyPath: "id" }).createIndex(
            "byScope",
            "scopeProjectId",
          );
        if (!db.objectStoreNames.contains("tombstones"))
          db.createObjectStore("tombstones", { keyPath: "fileKey" });
      };
      request.onsuccess = () => {
        const db = request.result;
        if (blocked) {
          db.close();
          return;
        }
        db.onclose = () => {
          this.opening = undefined;
        };
        db.onversionchange = () => {
          this.opening = undefined;
          db.close();
        };
        resolve(db);
      };
    })
      .then((db) => {
        if (!db) this.opening = undefined;
        return db;
      })
      .catch((error) => {
        this.opening = undefined;
        throw error;
      });
    return this.opening;
  }
}

const defaultConnection = new MemoryDatabaseConnection();

export async function checkWorkspaceFenceOp(
  id: string,
): Promise<"active" | "completed" | "abandoned"> {
  if (id.startsWith("delete:")) return checkDeleteFenceOp(id);
  const db = await defaultConnection.database();
  if (!db && typeof indexedDB !== "undefined")
    throw new ProjectMemoryUnavailableError(
      "无法连接项目记忆存储，无法核验归属变更",
    );
  const row =
    db &&
    (await requestResult(
      db
        .transaction("tombstones")
        .objectStore("tombstones")
        .get(completedOpsKey),
    ));
  if (row?.opIds?.includes(id)) return "completed";
  if (
    db &&
    isFallbackFenceOp(id) &&
    (await fallbackFenceOpActive(memoryFenceClaims(db), id))
  )
    return "active";
  return "abandoned";
}
registerFenceOpStatusChecker(checkWorkspaceFenceOp);

type JournalEntry = {
  commitId?: string;
  foldId?: string;
  authorizationAttempted?: boolean;
  fenceScope?: FenceScope;
  stores: Store[];
  operation: Operation<unknown>;
  fileWrite?: FileWrite;
  mutation?: EpisodeMutation;
  lockName?: string;
  resources: Set<string>;
};

function pendingJournalPins(journal: JournalEntry[], index: number) {
  const targets = new Map<string, QueuedPinState>();
  for (let i = index + 1; i < journal.length; i++) {
    const edit = journal[i].mutation;
    if (
      !edit ||
      edit.provisionalTarget === null ||
      (edit.op !== "delete" && edit.patch?.pinned === undefined)
    )
      continue;
    const guard = {
      ...edit.guard,
      expectedIdentityKey:
        edit.guard.expectedIdentityKey ?? edit.provisionalTarget?.identity,
      expectedScopeId:
        edit.guard.expectedScopeId ?? edit.provisionalTarget?.scope,
    };
    const key = JSON.stringify([
      guard.expectedIdentityKey,
      guard.expectedIdentityKey === undefined ? edit.targetId : null,
      guard.expectedScopeId,
      guard.expectedSnapshotKey,
    ]);
    if (targets.get(key)?.state === "deleted") continue;
    // Preserve the order of the last decisions when an ID-only selector and a
    // capture selector end up matching the same durable row.
    targets.delete(key);
    const pinOnly =
      edit.op === "update" &&
      edit.patch?.pinned === true &&
      edit.patch.title === undefined &&
      edit.patch.summary === undefined;
    const foldId = pinOnly
      ? (journal[i].commitId ?? (journal[i].foldId ??= "fold-" + i))
      : undefined;
    targets.set(key, {
      targetId: edit.targetId,
      guard,
      state:
        edit.op === "delete"
          ? "deleted"
          : edit.patch?.pinned
            ? "pinned"
            : "unpinned",
      updatedAt: edit.updatedAt,
      ...(foldId && { foldId, pinOnly }),
    });
  }
  const changes = [...targets.values()];
  return changes.some((edit) => edit.state === "pinned") ? changes : undefined;
}

// Evaluate in journal order against the row selected by publication, after deduplication
// and ID remapping. A deleted capture cannot be revived by a later edit of its old ID.
function netQueuedPin(row: DesignEpisode, changes: QueuedPinState[]) {
  let pin: QueuedPinState | undefined;
  let identity: string | undefined;
  for (const edit of changes) {
    const { guard } = edit;
    const expected = guard.expectedIdentityKey;
    const scope = guard.expectedScopeId;
    if (
      (scope !== undefined && scope !== row.scopeProjectId) ||
      (guard.expectedSnapshotKey !== undefined &&
        guard.expectedSnapshotKey !== (row.snapshotKey ?? row.id)) ||
      (expected === undefined
        ? edit.targetId !== row.id
        : expected !== (identity ??= episodeIdentityKey(row)))
    )
      continue;
    if (edit.state === "deleted") return;
    pin = edit.state === "pinned" ? edit : undefined;
  }
  return pin;
}

function sharesArchiveGrant(guard: EpisodeMutationGuard, stage: ArchiveStage) {
  const { episode, live } = stage;
  return (
    guard.sourceFileKey === episode.sourceFileKey &&
    guard.expectedDocId === episode.sourceDocId &&
    guard.expectedDocumentEpoch !== undefined &&
    guard.expectedDocumentEpoch === episode.sourceDocumentEpoch &&
    guard.expectedLifetimeToken !== undefined &&
    guard.expectedLifetimeToken === live.lifetimeToken
  );
}

function archivePinBinding(stage: ArchiveStage) {
  if (
    stage.queuedPins?.some(
      (edit) =>
        edit.state === "pinned" && sharesArchiveGrant(edit.guard, stage),
    )
  )
    return {
      sourceFileKey: stage.episode.sourceFileKey,
      docId: stage.episode.sourceDocId,
      lifetimeToken: stage.live.lifetimeToken,
      documentEpoch: stage.episode.sourceDocumentEpoch,
      queuedPins: stage.queuedPins,
    };
}

async function hasArchivePinGrant(stage: ArchiveStage) {
  const binding = archivePinBinding(stage);
  if (!binding) return false;
  const status = await isFileCommitAuthorized(stage.commitId, binding);
  if (status === "unavailable")
    throw new ProjectMemoryUnavailableError(
      "无法核验置顶档案的源文件，请稍后重试",
    );
  return status === "authorized";
}

async function prepareScopePins(t: Tables, scope: string, write: FileWrite) {
  const stage = write.authorizedStage;
  const changes = stage ? stage.queuedPins : write.queuedPins;
  const legacy = stage?.pendingPinned;
  const reserved = new Set<string>();
  function prepare(row: DesignEpisode) {
    if (row.pinned) return row;
    const pin = changes && netQueuedPin(row, changes);
    if (
      pin &&
      stage &&
      write.foldPins &&
      sharesArchiveGrant(pin.guard, stage)
    ) {
      if (pin.pinOnly && pin.foldId)
        (write.foldedPinIds ??= new Set()).add(pin.foldId);
      return {
        ...row,
        pinned: true,
        updatedAt: pin.updatedAt ?? row.updatedAt,
      };
    }
    // An assignment or a different file's archive cannot authorize this edit.
    if (
      pin ||
      (legacy?.identityKeys.size
        ? legacy.identityKeys.has(episodeIdentityKey(row))
        : legacy?.ids.has(row.id)) ||
      (stage?.pendingPin &&
        episodeIdentityKey(stage.episode) === episodeIdentityKey(row))
    )
      reserved.add(row.id);
    return row;
  }
  if (changes || legacy || stage?.pendingPin)
    for (const row of await t.episodesIn(scope)) {
      const next = prepare(row);
      if (next !== row) t.put("episodes", next);
    }
  return { prepare, reserved };
}

function staleJournalEntry(error: unknown) {
  return (
    error instanceof StaleFileError ||
    error instanceof ArchivePublishedByPeer ||
    error instanceof MutationAppliedByPeer ||
    isFileLifetimeMismatchError(error)
  );
}

export class IndexedDbProjectMemoryRepository extends MemoryProjectMemoryRepository {
  constructor(
    checkFile: FileMutationCheck = assertFileMemoryWritable,
    private readonly connection = new MemoryDatabaseConnection(),
  ) {
    super(checkFile);
  }
  private queue: Promise<void> = Promise.resolve();
  private journal: JournalEntry[] = [];

  override async isDurable(): Promise<boolean> {
    if (!this.journal.length) {
      const db = await this.database();
      await this.queue;
      if (!this.journal.length) return !!db;
    }
    return this.run(["tombstones"], "readonly", async (t) => t.durable);
  }

  async removeDeletedFileState(fileKey: string, options?: DeletionOptions) {
    await this.removeFileState(fileKey, options);
    if (!(await this.isDurable()))
      throw new Error("项目记忆仓库暂不可用，稍后重试文件清理");
  }

  protected override database() {
    return this.connection.database();
  }

  private async replayStatus(
    write: FileWrite | undefined,
  ): Promise<"ready" | "stale" | "defer"> {
    if (!write || write.authorizedStage || write.authorizedMutationStage)
      return "ready";
    if (write.mutationGuard) {
      const deletion = await checkPendingFileDeletion(write.fileKey);
      if (deletion === "pending") return "stale";
      if (deletion === "unavailable") return "defer";
      const live = await readLiveFile(write.fileKey);
      if (!live) return "defer";
      return !live.exists ||
        (write.token !== undefined && live.lifetimeToken !== write.token) ||
        (write.docId !== undefined && live.docId !== write.docId) ||
        (write.documentEpoch !== undefined &&
          live.documentEpoch !== write.documentEpoch)
        ? "stale"
        : "ready";
    }
    if (write.activation) {
      const live = await readLiveFile(write.fileKey);
      if (!live) return "defer";
      const { activeDocId, activeLifetimeToken, activeDocGeneration } =
        write.activation;
      if (
        !live.exists ||
        (activeLifetimeToken && live.lifetimeToken !== activeLifetimeToken) ||
        (activeDocId && live.docId !== activeDocId) ||
        (write.activation.activeDocEpoch !== undefined &&
          live.documentEpoch !== write.activation.activeDocEpoch) ||
        (activeDocGeneration !== undefined &&
          live.generation !== undefined &&
          live.generation > activeDocGeneration)
      )
        return "stale";
    }
    if (!write.archive && this.checkFile !== assertFileMemoryWritable)
      return "ready";
    const status = await checkPendingFileDeletion(write.fileKey);
    if (status === "unavailable") return "defer";
    if (status === "pending") return "stale";
    if (write.archive) {
      write.live = await readLiveFile(write.fileKey);
      verifyArchiveIdentity(write.archive.episode, write.token, write.live);
    } else if (write.token) {
      const live = await readLiveFile(write.fileKey);
      if (!live) return "defer";
      if (!live.exists || live.lifetimeToken !== write.token) return "stale";
    }
    return "ready";
  }

  // Replay under one scope lock and one transaction per entry. A stale target
  // retires just that entry. A transient failure preserves ordered dependencies
  // (for example a pin following an offline archive) for the next attempt.
  private async flushJournal(db: IDBDatabase, held?: HeldLock) {
    const pending: JournalEntry[] = [];
    const blocked = new Set<string>();
    const foldedPins = new Set<string>();
    let firstFailure: unknown;
    for (const [i, entry] of this.journal.entries()) {
      const entryFoldId = entry.commitId ?? entry.foldId;
      if (entryFoldId && foldedPins.has(entryFoldId)) continue;
      const write = entry.fileWrite;
      if (write) write.foldedPinIds = undefined;
      // Both archiving and a file assignment that migrates drafts can evict rows.
      if (write && (write.archive || entry.fenceScope))
        write.queuedPins = pendingJournalPins(this.journal, i);
      if ([...entry.resources].some((key) => blocked.has(key))) {
        pending.push(entry);
        for (const key of entry.resources) blocked.add(key);
        continue;
      }
      const commit = async () => {
        const status = await this.replayStatus(entry.fileWrite);
        if (status === "stale") return;
        if (status === "defer")
          throw new ProjectMemoryUnavailableError(
            "无法连接文件存储，稍后重试项目记忆同步",
          );
        await withScopeChange(
          entry.fenceScope,
          (opId) =>
            this.commitOperation(
              db,
              entry.stores,
              "readwrite",
              async (t) => {
                const write = entry.fileWrite;
                if (
                  write?.expectedProjectId !== undefined &&
                  ((await t.get("assignments", write.fileKey))?.projectId ??
                    null) !== write.expectedProjectId
                )
                  throw new StaleFileError(
                    "文件所属项目已变更，历史档案未写入",
                  );
                const step = stagedTables(t);
                const value = await entry.operation(step.tables, true);
                if ([...entry.resources].some((key) => blocked.has(key)))
                  throw new ScopeLockBusy("相关项目记忆仍在等待同步");
                step.apply();
                return value;
              },
              opId,
              entry,
              true,
            ),
          db,
        );
      };
      try {
        if (await this.commitAlreadyApplied(db, entry)) {
          await this.retireCommit(db, entry);
          continue;
        }
        if (entry.lockName && entry.lockName !== held?.name) {
          // A committed deletion can be observed while the deleting caller
          // still owns the file lock. Retiring its obsolete work needs no lock.
          if (held || scopeQueues.size) {
            if ((await this.replayStatus(entry.fileWrite)) !== "stale")
              throw new ScopeLockBusy("项目记忆锁正忙，请重试");
          } else await acquireCrossTabLock(entry.lockName, commit, db, true);
        } else await commit();
      } catch (error) {
        if (error instanceof ArchivePublishedByPeer && write?.authorizedStage) {
          for (const pin of write.authorizedStage.queuedPins ?? [])
            if (
              pin.state === "pinned" &&
              pin.pinOnly &&
              pin.foldId &&
              sharesArchiveGrant(pin.guard, write.authorizedStage)
            )
              foldedPins.add(pin.foldId);
        }
        if (!staleJournalEntry(error)) {
          firstFailure ??= error;
          pending.push(entry);
          for (const key of entry.resources) blocked.add(key);
          continue;
        }
      }
      if (write?.foldedPinIds)
        for (const id of write.foldedPinIds) foldedPins.add(id);
      await this.retireCommit(db, entry);
    }
    this.journal = pending;
    if (!pending.length)
      for (const map of Object.values(this.data)) map.clear();
    return firstFailure;
  }

  protected override run<T>(
    stores: Store[],
    mode: IDBTransactionMode,
    operation: Operation<T>,
    requireDurable = false,
    context: RunContext = {},
  ): Promise<T> {
    const { lock, fileWrite } = context;
    const connection = lock ? Promise.resolve(lock.db) : this.database();
    void connection.catch(() => {});
    const entry: JournalEntry = {
      commitId: fileWrite?.archive
        ? "ep-" + crypto.randomUUID()
        : fileWrite?.mutation
          ? "mut-" + crypto.randomUUID()
          : undefined,
      fenceScope: context.fenceScope,
      stores,
      operation,
      fileWrite,
      mutation: context.mutation,
      resources:
        context.resources ??
        new Set(fileWrite ? [fileScopeId(fileWrite.fileKey)] : []),
      lockName: lock?.name ?? (fileWrite && fileLockName(fileWrite.fileKey)),
    };
    const work = this.queue.then(async () => {
      const db = await connection;
      if (
        fileWrite?.archive &&
        typeof indexedDB !== "undefined" &&
        (!db || fileWrite.requiresDocDbVerification)
      ) {
        fileWrite.requiresDocDbVerification = true;
        fileWrite.verifyProjectOnFlush = true;
      }
      if (!db) {
        if (
          fileWrite?.mutationGuard &&
          (await this.replayStatus(fileWrite)) === "stale"
        )
          throw new FileLifetimeMismatchError(
            "当前文件已在其他窗口删除或替换，无法修改历史档案",
          );
        if (fileWrite?.archive && fileWrite.live)
          verifyArchiveIdentity(
            fileWrite.archive.episode,
            fileWrite.token,
            fileWrite.live,
          );
        if (requireDurable && mode === "readonly")
          throw new ProjectMemoryUnavailableError(
            "无法连接项目记忆存储，无法核验当前项目作用域",
          );
        const result = await super.run(
          stores,
          mode,
          operation,
          requireDurable,
          context,
        );
        if (mode === "readwrite") this.journal.push(entry);
        return result;
      }
      if (stores.includes("episodes") || fileWrite?.activation)
        await this.reconcileArchiveStages(
          db,
          mode === "readonly" ? context.resources : undefined,
        );
      const failure = this.journal.length
        ? await this.flushJournal(db, lock)
        : undefined;
      if (!this.journal.length) {
        try {
          return await withScopeChange(
            entry.fenceScope,
            (opId) =>
              this.commitOperation(db, stores, mode, operation, opId, entry),
            db,
          );
        } catch (error) {
          if (
            !(fileWrite?.archive || fileWrite?.mutationGuard) ||
            !isProjectMemoryUnavailableError(error)
          ) {
            if (
              (fileWrite?.authorizedStage ||
                fileWrite?.authorizedMutationStage) &&
              !staleJournalEntry(error)
            )
              this.journal.push(entry);
            throw error;
          }
          fileWrite.requiresDocDbVerification = true;
          fileWrite.verifyProjectOnFlush = true;
        }
      }
      const unavailable = () =>
        new ProjectMemoryUnavailableError(
          failure instanceof Error
            ? failure.message
            : "无法核验尚未同步的项目记忆",
          { cause: failure },
        );
      const dependsOnPending = () =>
        this.journal.some((pending) =>
          [...entry.resources].some((key) => pending.resources.has(key)),
        );
      if (requireDurable && (!entry.resources.size || dependsOnPending()))
        throw unavailable();

      // A failed commit or unavailable document database can still serve the
      // session view without representing that view as durable.
      const pendingStores = [
        ...new Set([...stores, ...this.journal.flatMap((item) => item.stores)]),
      ];
      const { result, edits } = await this.diskTransaction(
        db,
        pendingStores,
        "readonly",
        async (t) => {
          const merged = stagedTables(t);
          for (const pending of this.journal) {
            // Never overlay an unverified active document on a reachable disk view.
            if (pending.fileWrite?.activation) continue;
            const step = stagedTables(merged.tables);
            try {
              await pending.operation(step.tables);
              step.apply();
            } catch (error) {
              if (!staleJournalEntry(error)) throw error;
            }
          }
          const edits = stagedTables(merged.tables);
          return { result: await operation(edits.tables), edits };
        },
      );
      // Evaluation above also discovered any assignment, colliding episode ID,
      // or shared scope consulted by this operation.
      if (
        entry.resources.size &&
        !dependsOnPending() &&
        !fileWrite?.requiresDocDbVerification
      ) {
        try {
          return await withScopeChange(
            entry.fenceScope,
            (opId) =>
              this.commitOperation(
                db,
                stores,
                mode,
                async (t) => {
                  const value = await operation(t);
                  if (dependsOnPending())
                    throw new ScopeLockBusy("相关项目记忆仍在等待同步");
                  return value;
                },
                opId,
                entry,
              ),
            db,
          );
        } catch (error) {
          if (requireDurable || staleJournalEntry(error)) throw error;
        }
      } else if (requireDurable) throw unavailable();
      if (mode === "readwrite") {
        await super.run(stores, mode, async (t) => edits.apply(t));
        this.journal.push(entry);
      }
      return result;
    });
    this.queue = work.then(
      () => {},
      () => {},
    );
    return work;
  }

  private async commitAlreadyApplied(db: IDBDatabase, entry: JournalEntry) {
    if (!entry.commitId || !entry.authorizationAttempted) return false;
    const store = db.transaction("tombstones").objectStore("tombstones");
    const write = entry.fileWrite;
    const prefix = write?.mutation ? mutationStagePrefix : archiveStagePrefix;
    const [applied, stage] = await Promise.all([
      requestResult(store.get(appliedCommitPrefix + entry.commitId)),
      requestResult(store.get(prefix + entry.commitId)),
    ]);
    if (applied) return true;
    const decision = await isFileCommitAuthorized(
      entry.commitId,
      write?.mutation && mutationBinding(write.mutation),
    );
    if (decision === "unavailable")
      throw new ProjectMemoryUnavailableError(
        "无法核验暂存档案的提交状态，请稍后重试",
      );
    if (write?.mutation)
      write.authorizedMutationStage =
        decision === "authorized" ? stage : undefined;
    else if (write) {
      write.authorizedStage = decision === "authorized" ? stage : undefined;
      write.foldPins =
        write.authorizedStage &&
        (await hasArchivePinGrant(write.authorizedStage));
    }
    return decision === "authorized" && !stage;
  }

  private async retireCommit(db: IDBDatabase, entry: JournalEntry) {
    if (!entry.commitId || !entry.authorizationAttempted) return;
    // Keep the memory-side outcome if studio acknowledgement needs another attempt.
    try {
      await acknowledgeFileCommit(entry.commitId);
      await this.discardArchiveStage(db, appliedCommitPrefix + entry.commitId);
    } catch {
      /* Completion is durable even if cleanup is interrupted. */
    }
  }

  private async reconcileArchiveStages(db: IDBDatabase, scopes?: Set<string>) {
    if (typeof IDBKeyRange === "undefined") return;
    const store = db.transaction("tombstones").objectStore("tombstones");
    const [rows, mutations] = await Promise.all(
      [archiveStagePrefix, mutationStagePrefix].map((prefix) =>
        requestResult(
          store.getAll(IDBKeyRange.bound(prefix, prefix + "\uffff")),
        ),
      ),
    );
    for (const row of rows) {
      if (
        typeof row.fileKey !== "string" ||
        !row.fileKey.startsWith(archiveStagePrefix)
      )
        continue;
      if (!row.__formaStagedEpisode) continue;
      // Stages from the previous format carry no commit decision.
      if (!row.commitId) {
        if (row.stagedAt + archiveStageGraceMs <= Date.now())
          await this.discardArchiveStage(db, row.fileKey);
        continue;
      }
      if (
        row.fileKey !== archiveStagePrefix + row.commitId ||
        !row.episode?.scopeProjectId
      )
        continue;
      const stage: ArchiveStage = row;
      if (scopes?.size && !scopes.has(stage.episode.scopeProjectId)) {
        if (
          stage.episode.scopeProjectId !==
          fileScopeId(stage.episode.sourceFileKey)
        )
          continue;
        const assignment = await requestResult(
          db
            .transaction("assignments")
            .objectStore("assignments")
            .get(stage.episode.sourceFileKey),
        );
        if (!assignment || !scopes.has(projectScopeId(assignment.projectId)))
          continue;
      }
      const expired = stage.stagedAt + archiveStageGraceMs <= Date.now();
      const status = await isFileCommitAuthorized(stage.commitId);
      if (status === "unavailable")
        throw new ProjectMemoryUnavailableError(
          "无法核验暂存档案的提交状态，请稍后重试",
        );
      if (status === "missing" && expired)
        await this.discardArchiveStage(db, stage.fileKey, stage.stagedAt);
      if (status !== "authorized") continue;
      const foldPins = await hasArchivePinGrant(stage);
      try {
        await this.diskTransaction(
          db,
          archiveStores,
          "readwrite",
          async (t) => {
            if (
              stage.expectedProjectId !== undefined &&
              ((await t.get("assignments", stage.episode.sourceFileKey))
                ?.projectId ?? null) !== stage.expectedProjectId
            )
              throw new StaleFileError("文件所属项目已变更，历史档案未写入");
            return publishArchive(
              t,
              stage.episode,
              stage.archivedAt,
              {
                fileKey: stage.episode.sourceFileKey,
                live: stage.live,
                authorizedStage: stage,
                foldPins,
              },
              new Set(),
            );
          },
          undefined,
          stage,
          (receipt) => receipt.episode,
        );
      } catch (error) {
        if (
          error instanceof ArchivePublishedByPeer ||
          error instanceof ProjectMemoryUnavailableError
        )
          continue;
        if (!(error instanceof StaleFileError)) throw error;
        await this.discardArchiveStage(db, stage.fileKey);
      }
    }
    for (const stage of mutations as MutationStage[]) {
      if (
        !stage.__formaStagedMutation ||
        !stage.commitId?.startsWith("mut-") ||
        stage.fileKey !== mutationStagePrefix + stage.commitId ||
        !stage.guard?.sourceFileKey
      )
        continue;
      if (
        scopes?.size &&
        stage.guard.expectedScopeId &&
        !scopes.has(stage.guard.expectedScopeId)
      )
        continue;
      // Reconstruct the binding from the executable operation before consulting Studio.
      const binding = mutationBinding(stage);
      const matchesBinding =
        stage.binding &&
        (Object.keys(binding) as (keyof MutationBinding)[]).every(
          (key) => binding[key] === stage.binding[key],
        );
      const status = matchesBinding
        ? await isFileCommitAuthorized(stage.commitId, stage.binding)
        : "missing";
      if (status === "unavailable")
        throw new ProjectMemoryUnavailableError(
          "无法核验历史档案的源文件，请稍后重试",
        );
      if (status === "missing") {
        if (stage.stagedAt + archiveStageGraceMs <= Date.now())
          await this.discardArchiveStage(db, stage.fileKey, stage.stagedAt);
        continue;
      }
      try {
        await this.diskTransaction(
          db,
          mutationStores,
          "readwrite",
          episodeMutationOperation(stage),
          undefined,
          stage,
        );
      } catch (error) {
        if (!staleJournalEntry(error)) throw error;
      }
    }
  }

  private async discardArchiveStage(
    db: IDBDatabase,
    key: string,
    stagedAt?: number,
  ) {
    const tx = db.transaction("tombstones", "readwrite");
    const store = tx.objectStore("tombstones");
    await Promise.all([
      transactionDone(tx),
      (async () => {
        if (
          stagedAt === undefined ||
          (await requestResult(store.get(key)))?.stagedAt === stagedAt
        )
          store.delete(key);
      })(),
    ]);
  }

  private async commitOperation<T>(
    db: IDBDatabase,
    stores: Store[],
    mode: IDBTransactionMode,
    operation: Operation<T>,
    fenceOp?: string,
    entry?: JournalEntry,
    replaying = false,
  ): Promise<T> {
    const write = entry?.fileWrite;
    if (write?.mutation && entry?.commitId) {
      let stage = write.authorizedMutationStage;
      if (!stage) {
        const commitId = entry.commitId;
        if (replaying)
          await this.diskTransaction(db, stores, "readonly", (t) =>
            operation(stagedTables(t).tables),
          );
        stage = {
          ...write.mutation,
          fileKey: mutationStagePrefix + commitId,
          __formaStagedMutation: true,
          commitId,
          stagedAt: Date.now(),
          binding: mutationBinding(write.mutation),
        };
        const tx = db.transaction("tombstones", "readwrite");
        tx.objectStore("tombstones").put(stage);
        await transactionDone(tx);
        entry.authorizationAttempted = true;
        const auth = await authorizeFileCommit(
          {
            commitId,
            fileKey: write.fileKey,
            expectedDocId: write.docId,
            expectedDocumentEpoch: write.documentEpoch,
            expectedLifetimeToken: write.token,
            requireBoundLifetime: write.requireBoundLifetime,
            requireNoPendingReplacement: true,
            binding: stage.binding,
          },
          stage.stagedAt + archiveStageGraceMs,
        );
        if (auth === "unavailable") {
          if (
            (await isFileCommitAuthorized(commitId, stage.binding)) ===
            "missing"
          )
            await this.discardArchiveStage(db, stage.fileKey, stage.stagedAt);
          throw new ProjectMemoryUnavailableError(
            "无法核验历史档案的源文件，请稍后重试",
          );
        }
        if (auth === "rejected") {
          await this.discardArchiveStage(db, stage.fileKey, stage.stagedAt);
          throw new FileLifetimeMismatchError(
            "当前文件已在其他窗口删除或替换，无法修改历史档案",
          );
        }
        write.authorizedMutationStage = stage;
      }
      try {
        const result = await this.diskTransaction(
          db,
          stores,
          mode,
          operation,
          fenceOp,
          stage,
        );
        if (!replaying) await this.retireCommit(db, entry);
        return result;
      } catch (error) {
        if (!replaying && staleJournalEntry(error))
          await this.retireCommit(db, entry);
        throw error;
      }
    }
    if (!write?.archive || !entry?.commitId)
      return this.diskTransaction(db, stores, mode, operation, fenceOp);
    const { episode, archivedAt } = write.archive;
    let live = write.live;
    let stage = write.authorizedStage;
    try {
      if (!stage) {
        verifyArchiveIdentity(episode, write.token, write.live);
        // Discover replay dependencies before a peer can finalize the stage.
        if (replaying)
          await this.diskTransaction(db, stores, "readonly", (t) =>
            operation(stagedTables(t).tables),
          );
        const commitId = entry.commitId;
        stage = {
          fileKey: archiveStagePrefix + commitId,
          __formaStagedEpisode: true,
          stagedAt: Date.now(),
          archivedAt,
          commitId,
          episode,
          live: write.live,
          ...(write.queuedPins && { queuedPins: write.queuedPins }),
          ...(replaying && { expectedProjectId: write.expectedProjectId }),
        };
        const tx = db.transaction("tombstones", "readwrite");
        tx.objectStore("tombstones").put(stage);
        await transactionDone(tx);
        live = await readLiveFile(write.fileKey).catch(() => null);
        verifyArchiveIdentity(episode, write.token, live);
        entry.authorizationAttempted = true;
        const identity = {
          commitId,
          fileKey: write.fileKey,
          expectedDocId: episode.sourceDocId,
          expectedDocumentEpoch: episode.sourceDocumentEpoch,
          expectedLifetimeToken:
            episode.sourceLifetimeToken ?? write.token ?? live.lifetimeToken,
        };
        const expiresAt = stage.stagedAt + archiveStageGraceMs;
        const binding = archivePinBinding(stage);
        let auth = await authorizeFileCommit(
          binding
            ? {
                ...identity,
                expectedLifetimeToken: binding.lifetimeToken,
                requireNoPendingReplacement: true,
                binding,
              }
            : identity,
          expiresAt,
        );
        write.foldPins = !!binding && auth === "authorized";
        // A pending same-document replacement can allow the archive alone. A reader
        // distinguishes that ordinary grant from the one bound to the queued edits.
        if (binding && auth === "rejected")
          auth = await authorizeFileCommit(identity, expiresAt);
        if (auth === "unavailable")
          throw new ProjectMemoryUnavailableError(
            "无法连接文件存储，稍后重试项目记忆同步",
          );
        if (auth === "rejected") {
          live = await readLiveFile(write.fileKey).catch(() => null);
          throw new StaleFileError(
            live?.exists
              ? "该设计文件已替换为新版本，旧版历史档案未写入"
              : "该设计文件已删除，历史档案未写入",
          );
        }
        write.live = live;
        write.authorizedStage = stage;
      }
      const result = await this.diskTransaction(
        db,
        stores,
        mode,
        operation,
        fenceOp,
        stage,
      );
      if (!replaying) await this.retireCommit(db, entry);
      return result;
    } catch (error) {
      if (!stage) throw error;
      if (error instanceof ArchivePublishedByPeer) {
        if (!replaying) await this.retireCommit(db, entry);
        throw error;
      }
      // Once authorized, an interrupted publish remains recoverable by a reader.
      if (write.authorizedStage && !staleJournalEntry(error)) throw error;
      if (
        !write.authorizedStage &&
        entry.authorizationAttempted &&
        isProjectMemoryUnavailableError(error) &&
        (await isFileCommitAuthorized(entry.commitId)) !== "missing"
      )
        throw error;
      const stageKey = stage.fileKey;
      await this.diskTransaction(db, ["tombstones"], "readwrite", async (t) => {
        t.remove("tombstones", stageKey);
        if (error instanceof StaleFileError && live?.exists)
          await reconcileArchiveLifetime(t, write.fileKey, live, write.token);
      }).catch(() => {});
      if (!replaying && staleJournalEntry(error))
        await this.retireCommit(db, entry);
      throw error;
    }
  }

  private async diskTransaction<T>(
    db: IDBDatabase,
    stores: Store[],
    mode: IDBTransactionMode,
    operation: Operation<T>,
    fenceOp?: string,
    stage?: ArchiveStage | MutationStage,
    peerResult?: (value: T) => DesignEpisode,
  ): Promise<T> {
    const tx = db.transaction(
      fenceOp && !stores.includes("tombstones")
        ? [...stores, "tombstones"]
        : stores,
      mode,
    );
    let changed = false;
    const complete = new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error ?? new Error("项目记忆事务已取消"));
    });
    // Only IndexedDB requests are awaited within the transaction. Concurrent tabs
    // serialize on these stores, including validation, migration and eviction.
    const tables: Tables = {
      durable: true,
      get: async (store, key) =>
        parseRow(store, await requestResult(tx.objectStore(store).get(key))),
      all: async (store) =>
        parseRows(store, await requestResult(tx.objectStore(store).getAll())),
      episodesIn: async (scope) =>
        parseRows(
          "episodes",
          await requestResult(
            tx.objectStore("episodes").index("byScope").getAll(scope),
          ),
        ),
      episodeKeysIn: (scope) =>
        requestResult(
          tx.objectStore("episodes").index("byScope").getAllKeys(scope),
        ),
      eachEpisode: (visit) =>
        new Promise<void>((resolve, reject) => {
          // Count incrementally, retaining only one thumbnail-bearing record at a time.
          const request = tx.objectStore("episodes").openCursor();
          request.onerror = () => reject(request.error);
          request.onsuccess = () => {
            const cursor = request.result;
            if (!cursor) {
              resolve();
              return;
            }
            const episode = parseRow("episodes", cursor.value);
            if (episode) visit(episode);
            cursor.continue();
          };
        }),
      put: (store, record) => {
        tx.objectStore(store).put(record);
        changed = true;
      },
      remove: (store, key) => {
        tx.objectStore(store).delete(key);
        if (
          store !== "tombstones" ||
          !String(key).startsWith(archiveStagePrefix)
        )
          changed = true;
      },
    };
    let consumingMutation: MutationStage | undefined;
    const work = (async () => {
      if (stage) {
        const store = tx.objectStore("tombstones");
        const pending = await requestResult(store.get(stage.fileKey));
        const mutation = "__formaStagedMutation" in stage;
        if (
          (mutation
            ? pending?.__formaStagedMutation
            : pending?.__formaStagedEpisode) !== true
        ) {
          const receipt = await requestResult(
            store.get(appliedCommitPrefix + stage.commitId),
          );
          if (mutation && receipt?.kind === "mutation") {
            if (receipt.rejected) throw new StaleFileError(receipt.rejected);
            throw new MutationAppliedByPeer(receipt.result);
          }
          if (receipt?.episodeId) {
            const published = await tables.get("episodes", receipt.episodeId);
            if (
              published &&
              episodeIdentityKey(published) === receipt.identityKey
            )
              throw new ArchivePublishedByPeer({
                episode: safeThumbnail(published),
                durable: true,
              });
          }
          throw new StaleFileError(
            "该历史需求档案已变更，请刷新档案列表后重试",
          );
        }
        store.delete(stage.fileKey);
        if (mutation) consumingMutation = stage;
      }
      return operation(tables);
    })()
      .then(async (value) => {
        if (stage && "__formaStagedMutation" in stage) {
          tx.objectStore("tombstones").put({
            fileKey: appliedCommitPrefix + stage.commitId,
            kind: "mutation",
            result: value,
          });
        } else if (stage) {
          // A resumed writer can acknowledge a reader's commit without ever
          // re-inserting an episode subsequently pinned, moved or deleted.
          const episode = peerResult?.(value);
          tx.objectStore("tombstones").put({
            fileKey: appliedCommitPrefix + stage.commitId,
            ...(episode && {
              episodeId: episode.id,
              identityKey: episodeIdentityKey(episode),
            }),
          });
        }
        if (fenceOp) {
          const store = tx.objectStore("tombstones");
          const previous = await requestResult(store.get(completedOpsKey));
          verifyFallbackFenceClaim(previous, fenceOp);
          store.put({
            ...previous,
            fileKey: completedOpsKey,
            opIds: [...(previous?.opIds ?? []), fenceOp].slice(-256),
          });
        }
        return value;
      })
      .catch(async (error) => {
        if (
          consumingMutation &&
          (error instanceof StaleFileError ||
            isFileLifetimeMismatchError(error))
        ) {
          // Target validation precedes the edit. Commit its rejection with stage consumption.
          tx.objectStore("tombstones").put({
            fileKey: appliedCommitPrefix + consumingMutation.commitId,
            kind: "mutation",
            rejected: error.message,
          });
          await complete;
          throw error;
        }
        try {
          tx.abort();
        } catch {
          /* IndexedDB may already have aborted. */
        }
        throw error;
      });
    const [result] = await Promise.all([work, complete]);
    if (changed) broadcastChange();
    return result;
  }
}

const repository = new IndexedDbProjectMemoryRepository(
  assertFileMemoryWritable,
  defaultConnection,
);
export const listProjectSpaces = () => repository.listProjects();
export const isProjectMemoryDurable = () => repository.isDurable();
export const createProjectSpace = (
  input: ProjectInput,
  options?: { requireDurable?: boolean },
): Promise<ProjectSpace> => repository.createProject(input, options);
export const updateProjectSpace = (
  id: string,
  patch: ProjectPatch,
  options?: { expectedAssignedFileKey?: string },
): Promise<ProjectSpace> => repository.updateProject(id, patch, options);
export const deleteProjectSpace = (id: string) => repository.deleteProject(id);
export const listFileProjectAssignments = () =>
  repository.listFileAssignments();
export const getFileProjectSpace = (
  fileKey: string,
  options?: GetFileProjectOptions,
): Promise<ProjectSpace | null> => repository.getFileProject(fileKey, options);
export const assignFileToProject = (
  fileKey: string,
  projectId: string | null,
  options?: AssignmentOptions,
): Promise<{ project: ProjectSpace | null; migratedEpisodes: number }> =>
  repository.assignFileToProject(fileKey, projectId, options);
export const removeFileMemoryState = (
  fileKey: string,
  options?: DeletionOptions,
): Promise<void> => repository.removeDeletedFileState(fileKey, options);
export const clearFileMemoryTombstone = (
  fileKey: string,
  activation?: Activation,
  options?: { requireDurable?: boolean },
) => repository.clearFileTombstone(fileKey, activation, options);
export const listScopeEpisodes = (
  scopeProjectId: string,
  options?: { requireDurable?: boolean },
): Promise<DesignEpisode[]> => repository.listEpisodes(scopeProjectId, options);
export const countEpisodesByScope = () => repository.countEpisodesByScope();
export async function saveDesignEpisodeWithReceipt(
  episode: DesignEpisode,
): Promise<EpisodeSaveReceipt> {
  return repository.saveEpisodeWithReceipt(episode);
}
export const saveDesignEpisode = (episode: DesignEpisode) =>
  repository.saveEpisode(episode);
export const updateDesignEpisode = (
  id: string,
  patch: EpisodePatch,
  guard?: EpisodeMutationGuard,
): Promise<DesignEpisode | null> => repository.updateEpisode(id, patch, guard);
export const deleteDesignEpisode = (
  id: string,
  guard?: EpisodeMutationGuard,
): Promise<boolean> => repository.deleteEpisode(id, guard);
