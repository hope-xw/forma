import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  readWorkspaceScopeFence,
  listWorkspaceLibraries,
  getWorkspaceLibrary,
  saveWorkspaceLibraryIfUnchanged,
  saveWorkspaceLibraryDurable,
} from "../src/infrastructure/library-catalog-store";
import { registerHooks } from "node:module";
import { mock } from "node:test";
import { DOMParser } from "@xmldom/xmldom";
import {
  DEFAULT_MEMORY_USER_ID,
  UNSAVED_EPISODE_TIMESTAMP,
  buildEpisodeFromAppliedProposal,
  buildManualEpisodeFromSelection,
  designEpisodeSchema,
  deriveLegacySnapshotKey,
  episodeIdentityKey,
  episodeComponentRefSchema,
  episodeDecisionSchema,
  episodeScreenSchema,
  fileProjectAssignmentSchema,
  fileScopeId,
  formatEpisodePromptSection,
  projectScopeId,
  projectSpaceSchema,
  rankProjectEpisodes,
  recalledEpisodeSchema,
  resolveProjectMemoryScope,
  sanitizeEpisodeThumbnailSvg,
  tokenizeMemoryText,
  toRecalledEpisodePayload,
  type DesignEpisode,
} from "../src/agent/project-memory";
import {
  createNode,
  type DesignDocument,
  type DesignNode,
} from "../src/domain/document";
import { indexPublishedScene } from "../src/domain/scene-index";
import { validateProposalSnapshot } from "../src/agent/provider";
import type { PendingAgentProposal } from "../src/editor/CanvasAgentBar";
import {
  IndexedDbProjectMemoryRepository,
  MemoryProjectMemoryRepository,
  subscribeProjectMemory,
  withFileProjectScopeLock,
  getFileProjectSpace,
  isFileLifetimeMismatchError,
  isProjectMemoryUnavailableError,
  registerLiveFileStateReader,
  saveDesignEpisodeWithReceipt,
  listScopeEpisodes,
} from "../src/infrastructure/project-memory-store";
import {
  BrowserDocumentRepository,
  authorizeFileCommit,
  acknowledgeFileCommit,
  isFileCommitAuthorized,
  createLocalFileWithKey,
  deleteLocalFile,
  flushPendingFileMemoryCleanups,
  readLocalDocument,
  renameLocalFile,
  readLiveFileState,
  recentFiles,
  assertFileMemoryWritable,
  getLocalFileLifetimeToken,
  listLocalFiles,
} from "../src/infrastructure/storage";

// The project-wide suite uses node:test. Register the same cases with Vitest
// when this track is verified independently.
const runner = process.env.VITEST ? "vitest" : "node:test";
const { test }: Pick<typeof import("node:test"), "test"> = await import(runner);

const date = "2026-11-25T12:00:00.000Z";
const source = { sourceFileKey: "file-a", sourceFileName: "结算设计稿" };
const scope = fileScopeId(source.sourceFileKey);
const fullScopeError =
  "目标记忆空间已满（置顶档案已达上限），无法写入或迁移新档案，请先取消部分置顶";
function episode(
  id: string,
  patch: Partial<DesignEpisode> = {},
): DesignEpisode {
  return designEpisodeSchema.parse({
    id,
    ...source,
    scopeProjectId: scope,
    sourceDocId: "doc-a",
    title: "历史",
    prompt: "",
    summary: "",
    mode: "generate",
    screens: [],
    componentsUsed: [],
    customModules: [],
    decisions: [],
    tags: [],
    createdAt: date,
    updatedAt: date,
    ...patch,
  });
}

test("project CRUD trims names, validates changes, binds and clears the default library", async () => {
  const repo = new MemoryProjectMemoryRepository();
  const p = await repo.createProject({ name: " 电商 ", description: "移动端" });
  assert.equal(p.name, "电商");
  assert.equal((await repo.listProjects()).length, 1);
  const renamed = await repo.updateProject(p.id, {
    name: "购物",
    defaultLibraryId: "mobile",
  });
  assert.equal(renamed.description, "移动端");
  assert.equal(renamed.name, "购物");
  assert.equal((await repo.getProject(p.id))?.defaultLibraryId, "mobile");
  assert.equal(
    (await repo.updateProject(p.id, { defaultLibraryId: null }))
      .defaultLibraryId,
    undefined,
  );
  await assert.rejects(repo.updateProject(p.id, { name: "  " }));
  assert.equal((await repo.getProject(p.id))?.name, "购物");
  await assert.rejects(repo.updateProject("missing", {}), /项目空间不存在/);
});

test("deleting a project unassigns its files and removes only that project's shared history", async () => {
  const repo = new MemoryProjectMemoryRepository();
  const a = await repo.createProject({ name: "甲" });
  const b = await repo.createProject({ name: "乙" });
  await repo.assignFileToProject("first", a.id);
  await repo.assignFileToProject("second", a.id);
  await repo.assignFileToProject("third", b.id);
  for (const [id, key, scopeId] of [
    ["shared", "first", projectScopeId(a.id)],
    ["other", "third", projectScopeId(b.id)],
    ["draft", "unassigned", fileScopeId("unassigned")],
  ])
    await repo.saveEpisode(
      episode(id, { sourceFileKey: key, scopeProjectId: scopeId }),
    );
  assert.deepEqual(await repo.deleteProject(a.id), {
    unassignedFiles: ["first", "second"],
    deletedEpisodes: 1,
  });
  assert.deepEqual(await repo.listFileAssignments(), { third: b.id });
  assert.equal(await repo.getFileProject("first"), null);
  assert.equal(await repo.getProject(a.id), null);
  assert.deepEqual(await repo.countEpisodesByScope(), {
    [fileScopeId("unassigned")]: 1,
    [projectScopeId(b.id)]: 1,
  });
});

test("stale drawer pin and delete cannot mutate a migrated draft or a former project's shared history", async () => {
  const repo = new MemoryProjectMemoryRepository();
  const project = await repo.createProject({ name: "项目甲" });
  const other = await repo.createProject({ name: "项目乙" });
  const key = source.sourceFileKey;
  const draft = await repo.saveEpisode(episode("migrated"));
  await repo.assignFileToProject(key, project.id);
  const sharedScope = projectScopeId(project.id);
  const [shared] = await repo.listEpisodes(sharedScope);
  const check = async (expectedScopeId: string, message: string) => {
    const guard = { expectedScopeId, sourceFileKey: key };
    await assert.rejects(
      repo.updateEpisode(draft.id, { pinned: true }, guard),
      { message },
    );
    await assert.rejects(repo.deleteEpisode(draft.id, guard), { message });
    assert.deepEqual(await repo.listEpisodes(sharedScope), [shared]);
  };
  await check(scope, "该历史档案所属项目空间已变更，请刷新后再操作");
  await repo.assignFileToProject(key, other.id);
  await check(sharedScope, "当前文件所属项目空间已变更，请刷新后再操作");
  await repo.assignFileToProject(key, project.id);
  const guard = { expectedScopeId: sharedScope, sourceFileKey: key };
  assert.equal(
    (await repo.updateEpisode(draft.id, { pinned: true }, guard))?.pinned,
    true,
  );
  assert.equal(await repo.deleteEpisode(draft.id, guard), true);
});

test("a default library update requires the originating file's current assignment", async () => {
  const repo = new MemoryProjectMemoryRepository();
  const p = await repo.createProject({ name: "商城" });
  const key = source.sourceFileKey;
  await repo.assignFileToProject(key, p.id);
  const guard = { expectedAssignedFileKey: key };
  const original = await repo.updateProject(
    p.id,
    { defaultLibraryId: "original" },
    guard,
  );
  await repo.assignFileToProject(key, null);
  await assert.rejects(
    repo.updateProject(p.id, { defaultLibraryId: "stale" }, guard),
    { message: "当前文件已移出该项目空间，未更新项目默认组件库" },
  );
  assert.deepEqual(await repo.getProject(p.id), original);
});

test("scope resolution falls back to a private file and honors project and explicit library choices", async () => {
  const repo = new MemoryProjectMemoryRepository();
  const project = await repo.createProject({
    name: "商城",
    defaultLibraryId: "default",
  });
  const draft = resolveProjectMemoryScope({ fileKey: "key", project: null });
  assert.equal(draft.scopeProjectId, "file:key");
  assert.equal(draft.scopeLabel, "未归类草稿（单稿记忆）");
  assert.equal(draft.userId, DEFAULT_MEMORY_USER_ID);
  assert.equal(draft.isProjectSpace, false);
  const linked = resolveProjectMemoryScope({ fileKey: "key", project });
  assert.equal(linked.scopeProjectId, "proj:" + project.id);
  assert.equal(linked.projectSpaceId, project.id);
  assert.equal(linked.scopeLabel, project.name);
  assert.equal(linked.libraryId, "default");
  assert.equal(linked.isProjectSpace, true);
  const override = resolveProjectMemoryScope({
    fileKey: "key",
    project,
    libraryId: "other",
    userId: "designer",
  });
  assert.equal(override.libraryId, "other");
  assert.equal(override.userId, "designer");
});

test("draft migration preserves origin, can be deferred and retried, and never moves shared history", async () => {
  const repo = new MemoryProjectMemoryRepository();
  const a = await repo.createProject({ name: "甲" });
  const b = await repo.createProject({ name: "乙" });
  const key = source.sourceFileKey;
  await repo.saveEpisode(
    episode("draft", { scopeProjectId: fileScopeId(key) }),
  );
  await assert.rejects(
    repo.assignFileToProject(key, "missing"),
    /项目空间不存在/,
  );
  assert.equal(await repo.getFileProject(key), null);
  assert.equal(
    (await repo.assignFileToProject(key, a.id, { migrateDraftEpisodes: false }))
      .migratedEpisodes,
    0,
  );
  assert.equal((await repo.assignFileToProject(key, a.id)).migratedEpisodes, 1);
  assert.equal((await repo.assignFileToProject(key, a.id)).migratedEpisodes, 0);
  assert.deepEqual(await repo.listEpisodes(fileScopeId(key)), []);
  await repo.assignFileToProject(key, b.id);
  assert.deepEqual(await repo.listEpisodes(projectScopeId(b.id)), []);
  await repo.assignFileToProject(key, null);
  const [shared] = await repo.listEpisodes(projectScopeId(a.id));
  assert.equal(shared.id, "draft");
  assert.equal(shared.sourceFileKey, key);
  assert.equal(shared.sourceFileName, source.sourceFileName);
});

test("removeFileState clears only its assignment and private scope, including prototype-named keys", async () => {
  const repo = new MemoryProjectMemoryRepository();
  const project = await repo.createProject({ name: "商城" });
  await repo.saveEpisode(
    episode("private", {
      sourceFileKey: "__proto__",
      scopeProjectId: "file:__proto__",
    }),
  );
  await repo.assignFileToProject("__proto__", project.id, {
    migrateDraftEpisodes: false,
  });
  assert.equal((await repo.listFileAssignments())["__proto__"], project.id);
  await repo.saveEpisode(
    episode("other", { sourceFileKey: "other", scopeProjectId: "file:other" }),
  );
  await repo.saveEpisode(
    episode("shared", {
      sourceFileKey: "__proto__",
      scopeProjectId: projectScopeId(project.id),
    }),
  );
  await repo.removeFileState("__proto__");
  assert.deepEqual(await repo.listFileAssignments(), {});
  assert.deepEqual(await repo.countEpisodesByScope(), {
    "file:other": 1,
    [projectScopeId(project.id)]: 1,
  });
});

test("per-scope eviction protects pins and evicts oldest unpinned entries across concurrent saves", async () => {
  const repo = new MemoryProjectMemoryRepository();
  await Promise.all(
    Array.from({ length: 104 }, (_, i) =>
      repo.saveEpisode(
        episode("ep-" + i, {
          createdAt: new Date(Date.parse(date) + i * 1000).toISOString(),
          pinned: i === 0,
        }),
      ),
    ),
  );
  await repo.saveEpisode(
    episode("other", { sourceFileKey: "other", scopeProjectId: "file:other" }),
  );
  const found = await repo.listEpisodes(scope);
  assert.equal(found.length, 100);
  assert.deepEqual(
    found.slice(0, 2).map((ep) => ep.id),
    ["ep-0", "ep-103"],
  );
  assert.equal(found.at(-1)?.id, "ep-5");
  await assert.rejects(
    repo.saveEpisode(
      episode("backfill", { createdAt: "2020-01-01T00:00:00Z" }),
    ),
    { message: fullScopeError },
  );
  assert.deepEqual(
    (await repo.listEpisodes(scope)).map((ep) => ep.id),
    found.map((ep) => ep.id),
  );
  assert.deepEqual(await repo.countEpisodesByScope(), {
    [scope]: 100,
    "file:other": 1,
  });
});

test("a full pinned project rejects incoming saves and rolls back every migrated draft and its assignment", async () => {
  const repo = new IndexedDbProjectMemoryRepository();
  const project = await repo.createProject({ name: "已满" });
  const target = projectScopeId(project.id);
  await repo.assignFileToProject(source.sourceFileKey, project.id);
  await Promise.all(
    Array.from({ length: 100 }, (_, i) =>
      repo.saveEpisode(
        episode("pin-" + i, {
          scopeProjectId: target,
          pinned: true,
        }),
      ),
    ),
  );
  const original = await repo.listEpisodes(target);
  for (const pinned of [false, true]) {
    await assert.rejects(
      repo.saveEpisode(episode("incoming", { scopeProjectId: target, pinned })),
      { message: fullScopeError },
    );
  }
  const draft = (id: string) =>
    episode(id, { sourceFileKey: "draft", scopeProjectId: "file:draft" });
  await repo.saveEpisode(draft("draft-1"));
  await repo.saveEpisode(draft("draft-2"));
  const privateHistory = await repo.listEpisodes("file:draft");
  await assert.rejects(repo.assignFileToProject("draft", project.id), {
    message: fullScopeError,
  });
  assert.equal(await repo.getFileProject("draft"), null);
  assert.deepEqual(await repo.listEpisodes("file:draft"), privateHistory);
  assert.deepEqual(await repo.listEpisodes(target), original);
  await repo.assignFileToProject("draft", project.id, {
    migrateDraftEpisodes: false,
  });
  await assert.rejects(repo.saveEpisode(draft("late")), {
    message: fullScopeError,
  });
  assert.deepEqual(await repo.listEpisodes("file:draft"), privateHistory);
  assert.deepEqual(await repo.listEpisodes(target), original);
  await repo.deleteProject(project.id);
  await repo.removeFileState("draft");
});

test("a delayed project archive cannot recreate a deleted project's history", async () => {
  const repo = new IndexedDbProjectMemoryRepository();
  const p = await repo.createProject({ name: "甲" });
  const scopeProjectId = projectScopeId(p.id);
  await repo.assignFileToProject(source.sourceFileKey, p.id);
  await repo.saveEpisode(episode("existing", { scopeProjectId }));
  const late = episode("late", { scopeProjectId });
  await repo.deleteProject(p.id);
  await assert.rejects(repo.saveEpisode(late), {
    message: "目标项目空间已不存在，历史档案未写入",
  });
  assert.deepEqual(await repo.countEpisodesByScope(), {});
});

test("a delayed project archive rejects both a move and an unassignment, including snapshot replay", async () => {
  const repo = new IndexedDbProjectMemoryRepository();
  const a = await repo.createProject({ name: "甲" });
  const b = await repo.createProject({ name: "乙" });
  await repo.assignFileToProject(source.sourceFileKey, a.id);
  const scopeProjectId = projectScopeId(a.id);
  const snapshot = buildManualEpisodeFromSelection({
    ...archive,
    scopeProjectId,
    document: checkoutDesign(),
    selectionIds: [],
  });
  const archived = await repo.saveEpisode(snapshot);
  for (const projectId of [b.id, null]) {
    await repo.assignFileToProject(source.sourceFileKey, projectId);
    for (const late of [episode("late", { scopeProjectId }), snapshot]) {
      await assert.rejects(repo.saveEpisode(late), {
        message: "文件所属项目已变更，历史档案未写入",
      });
    }
    assert.deepEqual(await repo.listEpisodes(scopeProjectId), [archived]);
    assert.deepEqual(await repo.countEpisodesByScope(), {
      [scopeProjectId]: 1,
    });
  }
  await repo.deleteProject(a.id);
  await repo.deleteProject(b.id);
});

test("a late draft archive follows the file into its project together with remaining private drafts", async () => {
  const repo = new IndexedDbProjectMemoryRepository();
  const project = await repo.createProject({ name: "甲" });
  const target = projectScopeId(project.id);
  await repo.saveEpisode(episode("private"));
  await repo.assignFileToProject(source.sourceFileKey, project.id, {
    migrateDraftEpisodes: false,
  });
  await assert.rejects(
    repo.saveEpisode(episode("mismatch", { scopeProjectId: "file:wrong" })),
    { message: "历史档案作用域与来源文件不匹配" },
  );
  const redirected = await repo.saveEpisode(episode("late"));
  assert.equal(redirected.scopeProjectId, target);
  assert.equal(redirected.sourceFileKey, source.sourceFileKey);
  assert.deepEqual(
    (await repo.listEpisodes(target)).map((ep) => ep.id),
    ["late", "private"],
  );
  assert.deepEqual(await repo.listEpisodes(scope), []);
  await repo.deleteProject(project.id);
});

test("repository result objects are isolated, successful mutations notify and missing episodes are handled", async () => {
  const repo = new MemoryProjectMemoryRepository();
  let updates = 0;
  const unsub = subscribeProjectMemory(() => updates++);
  try {
    const ep = await repo.saveEpisode(episode("one", { tags: ["ok"] }));
    ep.tags.push("changed");
    assert.deepEqual((await repo.listEpisodes(scope))[0].tags, ["ok"]);
    await repo.updateEpisode("one", {
      title: "更新",
      pinned: true,
      summary: "已确认",
    });
    assert.equal(updates, 2);
    assert.equal((await repo.listEpisodes(scope))[0].pinned, true);
    assert.equal(await repo.updateEpisode("missing", {}), null);
    assert.equal(await repo.deleteEpisode("missing"), false);
    assert.equal(updates, 2);
    unsub();
    assert.equal(await repo.deleteEpisode("one"), true);
    assert.equal(updates, 2);
  } finally {
    unsub();
  }
});

function replaceGlobals(replacements: Record<string, unknown>) {
  const originals = Object.getOwnPropertyDescriptors(globalThis);
  for (const [key, value] of Object.entries(replacements)) {
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  return () => {
    for (const key of Object.keys(replacements)) {
      if (originals[key])
        Object.defineProperty(globalThis, key, originals[key]);
      else Reflect.deleteProperty(globalThis, key);
    }
  };
}

function successfulRequest<T>(result: T) {
  const request = { result, onsuccess: () => {} };
  queueMicrotask(() => request.onsuccess());
  return request;
}

function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("shared broadcasts close at the last unsubscribe and listenerless browser writes use one transient channel", async () => {
  const channels: Channel[] = [];
  class Channel {
    messages: string[] = [];
    closed = false;
    unreferenced = false;
    onmessage?: (event: { data: string }) => void;
    constructor(readonly name: string) {
      channels.push(this);
    }
    postMessage(message: string) {
      assert.equal(this.closed, false);
      this.messages.push(message);
    }
    close() {
      this.closed = true;
    }
    unref() {
      this.unreferenced = true;
    }
  }
  const db = {
    transaction() {
      const tx = { oncomplete: () => {}, objectStore: () => ({ put() {} }) };
      setImmediate(() => tx.oncomplete());
      return tx;
    },
  };
  const restore = replaceGlobals({
    window: {},
    BroadcastChannel: Channel,
    indexedDB: { open: () => successfulRequest(db) },
  });
  const repo = new IndexedDbProjectMemoryRepository();
  let local = 0;
  let other = 0;
  const off = subscribeProjectMemory(() => local++);
  const offOther = subscribeProjectMemory(() => other++);
  try {
    assert.equal(channels.length, 1);
    const [shared] = channels;
    assert.equal(shared.unreferenced, true);
    assert.equal(shared.name, "forma-project-memory-v1");
    await repo.createProject({ name: "甲" });
    assert.deepEqual([local, other], [1, 1]);
    assert.deepEqual(shared.messages, ["changed"]);
    off();
    assert.equal(shared.closed, false);
    shared.onmessage!({ data: "changed" });
    assert.deepEqual([local, other], [1, 2]);
    offOther();
    assert.equal(shared.closed, true);
    await repo.createProject({ name: "乙" });
    assert.equal(channels.length, 2);
    assert.deepEqual(channels[1].messages, ["changed"]);
    assert.ok(channels.every((channel) => channel.closed));
    const resubscribe = subscribeProjectMemory(() => {});
    try {
      assert.equal(channels.length, 3);
    } finally {
      resubscribe();
    }
    assert.ok(channels.every((channel) => channel.closed));
  } finally {
    off();
    offOther();
    restore();
  }
});

function documentDatabase(
  documents: Map<string, unknown>,
  shouldAbort = () => false,
  beforeTransaction?: (stores: unknown, mode?: string) => void,
  afterCommit?: (keys: string[]) => Promise<void> | undefined,
  partitionReadError?: () => Error | undefined,
) {
  const catalog = new Map<string, unknown>();
  const parts = new Map<string, unknown>();
  return {
    onclose: () => {},
    transaction(stores: unknown, mode?: string) {
      beforeTransaction?.(stores, mode);
      const putKeys: string[] = [];
      // Publish staged document and journal changes together only on commit.
      const staged = new Map(documents);
      const stagedCatalog = new Map(catalog);
      const stagedParts = new Map(parts);
      let aborted = false;
      const tx = {
        error: new Error("delete aborted"),
        abort() {
          aborted = true;
        },
        onabort: () => {},
        oncomplete: () => {},
        objectStore: (name: string) => ({
          openCursor(range: { lower: [string, number] }) {
            assert.equal(name, "document-parts");
            const chunks = [...stagedParts]
              .map(([key, value]) => ({
                key: JSON.parse(key) as [string, number, number],
                value,
              }))
              .filter(
                ({ key }) =>
                  key[0] === range.lower[0] && key[1] === range.lower[1],
              )
              .sort((a, b) => a.key[2] - b.key[2]);
            const request = {
              result: null as null | {
                key: [string, number, number];
                value: unknown;
                continue(): void;
              },
              error: partitionReadError?.(),
              onerror() {},
              onsuccess() {},
            };
            function next() {
              queueMicrotask(() => {
                if (request.error) return request.onerror();
                const chunk = chunks.shift();
                request.result = chunk ? { ...chunk, continue: next } : null;
                request.onsuccess();
              });
            }
            next();
            return request;
          },
          delete(key: string) {
            if (name === "documents") staged.delete(key);
            if (name === "files") stagedCatalog.delete(key);
          },
          put(value: unknown, key: string) {
            if (name === "documents") putKeys.push(key);
            if (name === "files")
              assert.ok(
                !(value as { key: string }).key.startsWith("__forma_internal_"),
              );
            if (name === "files")
              stagedCatalog.set(
                (value as { key: string }).key,
                structuredClone(value),
              );
            if (name === "documents") staged.set(key, structuredClone(value));
            if (name === "document-parts")
              stagedParts.set(JSON.stringify(key), structuredClone(value));
            return successfulRequest(key);
          },
          getKey: (key: string) =>
            successfulRequest(staged.has(key) ? key : undefined),
          get: (key: string) =>
            successfulRequest(
              name === "documents"
                ? staged.get(key)
                : name === "document-parts"
                  ? stagedParts.get(JSON.stringify(key))
                  : stagedCatalog.get(key),
            ),
          getAll: () =>
            successfulRequest(
              name === "files" ? [...stagedCatalog.values()] : [],
            ),
        }),
      };
      if (mode === "readwrite")
        setImmediate(() => {
          if (aborted || shouldAbort()) tx.onabort();
          else {
            documents.clear();
            staged.forEach((value, key) => documents.set(key, value));
            parts.clear();
            stagedParts.forEach((value, key) => parts.set(key, value));
            catalog.clear();
            stagedCatalog.forEach((value, key) => catalog.set(key, value));
            const delayed = afterCommit?.(putKeys);
            if (delayed) void delayed.then(() => tx.oncomplete());
            else tx.oncomplete();
          }
        });
      return tx;
    },
  };
}

test("deleteLocalFile waits for memory cleanup, journals failures and retries only committed deletions when listing files", async () => {
  const marker = "__forma_internal_pending_memory_cleanups__";
  const keys = ["current", "retry", "still-here"];
  const documents = new Map<string, unknown>(
    keys.map((key) => [
      key,
      { generation: 1, current: { ...design([]), id: "doc-" + key } },
    ]),
  );
  const pending = () =>
    (
      (documents.get(marker) ?? []) as {
        fileKey: string;
        deletedDocId?: string;
        deletedLifetimeToken?: string;
        fenceOp?: string;
      }[]
    ).map(({ fileKey, deletedDocId, deletedLifetimeToken, fenceOp }) => {
      assert.match(fenceOp!, /^delete:/);
      return { fileKey, deletedDocId, deletedLifetimeToken };
    });
  let abortDelete = false;
  const db = documentDatabase(documents, () => abortDelete);
  const denied = () => {
    throw new DOMException("disabled", "SecurityError");
  };
  const { db: memoryDb } = memoryDatabaseFixture();
  const { db: catalogDb } = memoryDatabaseFixture();
  const restore = replaceGlobals({
    indexedDB: {
      open: (name: string) =>
        successfulRequest(
          name === "forma-studio"
            ? db
            : name === "forma-workspace-libraries-v1"
              ? catalogDb
              : memoryDb,
        ),
    },
    IDBKeyRange: { bound: () => ({}) },
    localStorage: { getItem: denied, setItem: denied, removeItem: denied },
  });
  const state = new MemoryProjectMemoryRepository(assertFileMemoryWritable);
  const project = await state.createProject({ name: "甲" });
  for (const key of keys) {
    await state.saveEpisode(
      episode(key, { sourceFileKey: key, scopeProjectId: fileScopeId(key) }),
    );
    await state.assignFileToProject(key, project.id, {
      migrateDraftEpisodes: false,
    });
  }
  const currentToken = await getLocalFileLifetimeToken("current");
  const retryToken = await getLocalFileLifetimeToken("retry");
  assert.ok(currentToken && retryToken);
  const started = signal();
  const proceed = signal();

  let attempts = 0;
  const cleanup = mock.method(
    IndexedDbProjectMemoryRepository.prototype,
    "removeFileState",
    async (key: string, options?: { deletedDocId?: string }) => {
      assert.equal(
        options?.deletedDocId,
        key === "legacy-deleted" ? undefined : "doc-" + key,
      );
      assert.equal(documents.has(key), false);
      if (key === "current") {
        started.resolve();
        await proceed.promise;
      }
      if (key === "retry" && ++attempts <= 2)
        throw new Error("memory DB blocked");
      await state.removeFileState(key, options);
    },
  );
  try {
    let resolved = false;
    const deleting = deleteLocalFile("current").then(() => {
      resolved = true;
    });
    await started.promise;
    await new Promise<void>((done) => setImmediate(done));
    assert.equal(resolved, false);
    assert.deepEqual(pending(), [
      {
        fileKey: "current",
        deletedDocId: "doc-current",
        deletedLifetimeToken: currentToken,
      },
    ]);
    proceed.resolve();
    await deleting;
    assert.deepEqual(pending(), []);
    assert.deepEqual(await state.listEpisodes("file:current"), []);
    assert.equal(await state.getFileProject("current"), null);

    await deleteLocalFile("retry");
    assert.deepEqual(pending(), [
      {
        fileKey: "retry",
        deletedDocId: "doc-retry",
        deletedLifetimeToken: retryToken,
      },
    ]);
    assert.equal((await state.listEpisodes("file:retry")).length, 1);
    await assert.rejects(
      state.assignFileToProject("retry", project.id),
      /memory DB blocked/,
    );
    await assert.rejects(
      state.saveEpisode(
        episode("stale", {
          sourceFileKey: "retry",
          scopeProjectId: "file:retry",
        }),
      ),
      /该设计文件已删除/,
    );
    assert.deepEqual(await state.listEpisodes(projectScopeId(project.id)), []);
    abortDelete = true;
    await assert.rejects(deleteLocalFile("still-here"), /delete aborted/);
    assert.deepEqual(pending(), [
      {
        fileKey: "retry",
        deletedDocId: "doc-retry",
        deletedLifetimeToken: retryToken,
      },
    ]);
    abortDelete = false;
    db.onclose(); // Reopen the document DB with localStorage still denied.
    assert.deepEqual(
      (await recentFiles()).map((file) => file.key),
      ["still-here"],
    );
    await flushPendingFileMemoryCleanups();
    assert.deepEqual(pending(), []);
    assert.equal(attempts, 3);

    assert.equal(await new BrowserDocumentRepository("retry").load(), null);
    await assert.rejects(
      state.saveEpisode(
        episode("late", {
          sourceFileKey: "retry",
          sourceDocId: "doc-retry",
          scopeProjectId: "file:retry",
        }),
      ),
      /该设计文件已删除/,
    );
    // A committed replacement activates only its own document generation.
    const clear = mock.method(
      IndexedDbProjectMemoryRepository.prototype,
      "clearFileTombstone",
      (key: string, activeDocId?: string) =>
        state.clearFileTombstone(key, activeDocId),
    );
    try {
      await new BrowserDocumentRepository("retry").save(design([]));
      const next = await state.saveEpisode(
        episode("recreated", {
          sourceFileKey: "retry",
          scopeProjectId: "file:retry",
          createdAt: UNSAVED_EPISODE_TIMESTAMP,
        }),
      );
      assert.equal(next.sourceDocId, "doc-a");
      const late = episode("old-snapshot", {
        sourceFileKey: "retry",
        sourceDocId: "doc-retry",
        scopeProjectId: "file:retry",
      });
      await assert.rejects(state.saveEpisode(late), /该设计文件已删除/);
      await assert.rejects(
        state.saveEpisode({ ...late, sourceDocId: "unknown" }),
        /已替换为新版本/,
      );
      await state.deleteEpisode(next.id);
      await state.assignFileToProject("retry", project.id);
      await assert.rejects(
        state.saveEpisode({
          ...late,
          scopeProjectId: projectScopeId(project.id),
        }),
        /该设计文件已删除/,
      );
      const replacement = new BrowserDocumentRepository("retry");
      const saved = await replacement.load();
      assert.ok(saved);
      await replacement.save({ ...saved, id: "next-version" });
      await assert.rejects(state.saveEpisode(next), /已替换为新版本/);
      await state.assignFileToProject("retry", null);
    } finally {
      clear.mock.restore();
    }
    // Old pre-commit localStorage markers still distinguish a rollback from a committed delete.
    const legacyMarker = "forma.pending-file-memory-cleanup";
    const legacy = new Map([
      [legacyMarker, JSON.stringify(["still-here", "legacy-deleted"])],
    ]);
    await state.saveEpisode(
      episode("old", {
        sourceFileKey: "legacy-deleted",
        scopeProjectId: "file:legacy-deleted",
      }),
    );
    const restoreLegacy = replaceGlobals({
      localStorage: {
        getItem: (key: string) => legacy.get(key) ?? null,
        setItem: (key: string, value: string) => legacy.set(key, value),
        removeItem: (key: string) => legacy.delete(key),
      },
    });
    try {
      await flushPendingFileMemoryCleanups();
      assert.equal(legacy.has(legacyMarker), false);
    } finally {
      restoreLegacy();
    }
    assert.deepEqual(await state.listFileAssignments(), {
      "still-here": project.id,
    });
    assert.deepEqual(await state.countEpisodesByScope(), {
      "file:still-here": 1,
    });
  } finally {
    proceed.resolve();
    cleanup.mock.restore();
    db.onclose();
    memoryDb.onclose();
    catalogDb.onclose();
    restore();
  }
});

test("a migrated legacy file stays deleted when localStorage access returns after deletion", async () => {
  const key = "legacy-file";
  const doc = { ...design([]), id: "old-doc" };
  const documents = new Map<string, unknown>();
  const db = documentDatabase(documents);
  const retired = "__forma_internal_retired_legacy_keys__";
  const storage = new Map([[key, JSON.stringify(doc)]]);
  let deny = false;
  let legacyReads = 0;
  const access = () => {
    if (deny) throw new DOMException("denied", "SecurityError");
  };
  const { db: memoryDb } = memoryDatabaseFixture();
  const { db: catalogDb } = memoryDatabaseFixture();
  const restore = replaceGlobals({
    indexedDB: {
      open: (name: string) =>
        successfulRequest(
          name === "forma-studio"
            ? db
            : name === "forma-workspace-libraries-v1"
              ? catalogDb
              : memoryDb,
        ),
    },
    localStorage: {
      getItem: (k: string) => {
        access();
        if (k === key) legacyReads++;
        return storage.get(k) ?? null;
      },
      removeItem: (k: string) => {
        access();
        storage.delete(k);
      },
    },
    IDBKeyRange: { bound: () => ({}) },
  });
  const cleanup = mock.method(
    IndexedDbProjectMemoryRepository.prototype,
    "removeFileState",
    async () => {},
  );
  try {
    assert.equal(
      (await new BrowserDocumentRepository(key).load())?.id,
      "old-doc",
    );
    assert.equal((await readLocalDocument(key))?.id, "old-doc");
    assert.deepEqual(documents.get(retired), {
      keys: [key],
      pendingLocalStorageRemovals: [],
    });
    deny = true;
    await deleteLocalFile(key);
    assert.equal(storage.has(key), true);
    assert.deepEqual(documents.get(retired), {
      keys: [key],
      pendingLocalStorageRemovals: [key],
    });
    assert.equal(
      documents.has("__forma_internal_pending_memory_cleanups__"),
      false,
    );
    db.onclose();
    deny = false;
    assert.equal(await new BrowserDocumentRepository(key).load(), null);
    assert.equal(storage.has(key), false);
    assert.equal(legacyReads, 1);
    assert.deepEqual(documents.get(retired), {
      keys: [key],
      pendingLocalStorageRemovals: [],
    });
    assert.equal(await readLocalDocument(key), null);
    // A stale legacy copy written again after acknowledgement is also suppressed.
    storage.set(key, JSON.stringify(doc));
    assert.equal(await new BrowserDocumentRepository(key).backup(), null);
    storage.set(key, JSON.stringify(doc));
    assert.equal(await new BrowserDocumentRepository(key).load(), null);
    assert.equal(legacyReads, 1);
    assert.equal(storage.has(key), false);
    assert.deepEqual(await recentFiles(), []);
    assert.throws(() => new BrowserDocumentRepository(retired), /保留/);
  } finally {
    cleanup.mock.restore();
    db.onclose();
    memoryDb.onclose();
    catalogDb.onclose();
    restore();
  }
});

test("durable assignment retries a transiently denied open on the same repository; v2 file tombstones survive reopen", async () => {
  const projects = new Map<string, { id: string }>();
  const assignments = new Map<string, { fileKey: string }>();
  const tombstones = new Map<string, unknown>([
    [
      "retired",
      { fileKey: "retired", deletedDocId: "old-doc", deletedAt: date },
    ],
  ]);
  const stores = new Set(["projects", "assignments", "episodes"]);
  const db = {
    objectStoreNames: { contains: (name: string) => stores.has(name) },
    createObjectStore(name: string, options: { keyPath: string }) {
      assert.equal(name, "tombstones");
      assert.equal(options.keyPath, "fileKey");
      assert.ok(!stores.has(name));
      stores.add(name);
    },
    transaction() {
      const tx = {
        oncomplete: () => {},
        objectStore(name: string) {
          if (name === "projects")
            return {
              get: (id: string) => successfulRequest(projects.get(id)),
              put: (p: { id: string }) => projects.set(p.id, p),
            };
          if (name === "assignments")
            return {
              put: (a: { fileKey: string }) => assignments.set(a.fileKey, a),
              get: (key: string) => successfulRequest(assignments.get(key)),
            };
          assert.equal(name, "tombstones");
          return {
            get: (key: string) => successfulRequest(tombstones.get(key)),
            delete: (key: string) => tombstones.delete(key),
            put: (record: { fileKey: string }) =>
              tombstones.set(record.fileKey, record),
          };
        },
      };
      setImmediate(() => tx.oncomplete());
      return tx;
    },
  };
  const catalog = memoryDatabaseFixture();
  const studio = documentDatabase(
    new Map([
      ["retired", { generation: 1, current: { ...design([]), id: "old-doc" } }],
    ]),
  );
  let version = 1;
  let denied: "synchronous" | "asynchronous" | undefined;
  let opens = 0;
  const restore = replaceGlobals({
    indexedDB: {
      open(name: string, targetVersion: number) {
        if (name === "forma-studio") return successfulRequest(studio);
        if (name === "forma-workspace-libraries-v1")
          return successfulRequest(catalog.db);
        opens++;
        if (denied) {
          const error = new DOMException("Storage denied", "SecurityError");
          if (denied === "synchronous") throw error;
          const request = { error, onerror: () => {} };
          queueMicrotask(() => request.onerror());
          return request;
        }
        const req = {
          result: db,
          onupgradeneeded: () => {},
          onsuccess: () => {},
        };
        queueMicrotask(() => {
          assert.equal(targetVersion, 2);
          if (version < targetVersion) {
            req.onupgradeneeded();
            version = targetVersion;
          }
          req.onsuccess();
        });
        return req;
      },
    },
  });
  try {
    const repo = new IndexedDbProjectMemoryRepository(async () => {});
    assert.equal(await repo.isDurable(), true);
    const p = await repo.createProject(
      { name: "持久项目" },
      { requireDurable: true },
    );
    await repo.assignFileToProject("shared-key", p.id, {
      requireDurable: true,
      migrateDraftEpisodes: false,
    });
    assert.deepEqual(
      await new IndexedDbProjectMemoryRepository(async () => {}).getFileProject(
        "shared-key",
      ),
      p,
    );
    assert.equal(stores.size, 4);
    for (const denial of ["synchronous", "asynchronous"] as const) {
      const retry = new IndexedDbProjectMemoryRepository(async () => {});
      const options = { requireDurable: true, migrateDraftEpisodes: false };
      const before = opens;
      denied = denial;
      await assert.rejects(
        retry.assignFileToProject(denial, p.id, options),
        /未启用本地持久存储/,
      );
      assert.equal(assignments.has(denial), false);
      denied = undefined;
      assert.deepEqual(
        (await retry.assignFileToProject(denial, p.id, options)).project,
        p,
      );
      assert.equal(await retry.isDurable(), true);
      assert.equal(opens, before + 2);
    }
    await assert.rejects(
      repo.assignFileToProject("retired", p.id),
      /该设计文件已删除/,
    );
    const activation = await repo.clearFileTombstone("retired", "replacement");
    assert.deepEqual(tombstones.get("retired"), {
      fileKey: "retired",
      ...activation,
      deletedLifetimeTokens: [],
      activeDocId: "replacement",
      deletedDocIds: ["old-doc"],
    });
    await assert.rejects(
      new IndexedDbProjectMemoryRepository(async () => {}).saveEpisode(
        episode("late", {
          sourceFileKey: "retired",
          sourceDocId: "old-doc",
          scopeProjectId: "file:retired",
        }),
      ),
      /该设计文件已删除/,
    );
  } finally {
    await flushPendingFileMemoryCleanups();
    studio.onclose();
    catalog.db.onclose();
    restore();
  }
});

test("deleted file generations cannot rewrite private history, including undated or stale archives", async () => {
  const repo = new MemoryProjectMemoryRepository();
  const key = source.sourceFileKey;
  await repo.removeFileState(key, { deletedDocId: "doc-1" });
  const later = "2099-01-01T00:00:00.000Z";
  for (const [sourceDocId, createdAt] of [
    ["doc-1", later],
    ["doc-2", UNSAVED_EPISODE_TIMESTAMP],
    ["doc-2", "2000-01-01T00:00:00Z"],
  ])
    await assert.rejects(
      repo.saveEpisode(episode("late", { sourceDocId, createdAt })),
      { message: "该设计文件已删除，历史档案未写入" },
    );
  assert.deepEqual(await repo.listEpisodes(scope), []);
  await repo.clearFileTombstone(key, "doc-2");
  await repo.saveEpisode(
    episode("new", { sourceDocId: "doc-2", createdAt: later }),
  );
  assert.equal((await repo.listEpisodes(scope))[0].sourceDocId, "doc-2");
  await repo.removeFileState(key);
  await assert.rejects(
    repo.saveEpisode(episode("unknown-generation", { createdAt: later })),
    /已删除/,
  );
  const project = await repo.createProject({ name: "新归属" });
  await repo.clearFileTombstone(key, "doc-3");
  await repo.assignFileToProject(key, project.id);
  await repo.assignFileToProject(key, null);
  await repo.saveEpisode(episode("reassigned", { sourceDocId: "doc-3" }));
});

test("assigning a deleted key from a stale file list cannot revive or migrate its private snapshot", async () => {
  const repo = new MemoryProjectMemoryRepository();
  const p = await repo.createProject({ name: "项目" });
  const key = source.sourceFileKey;
  const old = await repo.saveEpisode(
    episode("old-snapshot", { sourceDocId: "old-doc" }),
  );
  await repo.removeFileState(key, { deletedDocId: "old-doc" });
  await assert.rejects(repo.assignFileToProject(key, p.id), {
    message: "该设计文件已删除，无法修改项目归属",
  });
  for (const scopeProjectId of [scope, projectScopeId(p.id)])
    await assert.rejects(repo.saveEpisode({ ...old, scopeProjectId }), {
      message: "该设计文件已删除，历史档案未写入",
    });
  assert.equal(await repo.getFileProject(key), null);
  assert.deepEqual(await repo.countEpisodesByScope(), {});
});

test("reactivation without a document ID keeps the 64 most recently deleted generations", async () => {
  const repo = new MemoryProjectMemoryRepository();
  const key = source.sourceFileKey;
  for (let i = 0; i <= 64; i++) {
    await repo.clearFileTombstone(key, "doc-" + i);
    await repo.removeFileState(key, { deletedDocId: "doc-" + i });
  }
  await repo.removeFileState(key, { deletedDocId: "doc-1" });
  await repo.clearFileTombstone(key);
  // The oldest generation has expired; the repeated delete used a single slot.
  await repo.saveEpisode(episode("expired", { sourceDocId: "doc-0" }));
  for (let i = 1; i <= 64; i++)
    await assert.rejects(
      repo.saveEpisode(episode("late", { sourceDocId: "doc-" + i })),
      /该设计文件已删除/,
    );
});

test("without IndexedDB, durable creation and reassignment reject before changing session state", async () => {
  const restore = replaceGlobals({ indexedDB: undefined });
  try {
    for (const repo of [
      new MemoryProjectMemoryRepository(),
      new IndexedDbProjectMemoryRepository(async () => {}),
    ]) {
      const options = { requireDurable: true };
      assert.equal(await repo.isDurable(), false);
      await assert.rejects(
        repo.createProject({ name: "持久项目" }, options),
        /未启用本地持久存储/,
      );
      assert.deepEqual(await repo.listProjects(), []);
      const project = await repo.createProject({ name: "会话项目" });
      await repo.assignFileToProject("draft", project.id);
      await assert.rejects(
        repo.assignFileToProject("draft", null, options),
        /未启用本地持久存储/,
      );
      assert.deepEqual(await repo.getFileProject("draft"), project);
    }
  } finally {
    restore();
  }
});

test("IndexedDB repository works with unavailable browser storage and returns independent snapshots", async () => {
  const repo = new IndexedDbProjectMemoryRepository(async () => {});
  const p = await repo.createProject({ name: "离线" });
  const key = "file-" + p.id;
  await repo.saveEpisode(
    episode("ep-" + p.id, {
      sourceFileKey: key,
      scopeProjectId: fileScopeId(key),
    }),
  );
  assert.equal((await repo.assignFileToProject(key, p.id)).migratedEpisodes, 1);
  p.name = "副本";
  assert.equal((await repo.getFileProject(key))?.name, "离线");
  assert.equal((await repo.deleteProject(p.id)).deletedEpisodes, 1);
});

test("a blocked open reports the conflict, closes a late connection and retries; denied storage falls back for the session", async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
  const request = {} as IDBOpenDBRequest;
  let attempts = 0;
  let closed = 0;
  Object.defineProperty(globalThis, "indexedDB", {
    configurable: true,
    value: {
      open() {
        if (++attempts === 1) return request;
        throw new DOMException("disabled", "SecurityError");
      },
    },
  });
  try {
    const repo = new IndexedDbProjectMemoryRepository(async () => {});
    const pending = repo.listProjects();
    request.onblocked!.call(
      request,
      new Event("blocked") as IDBVersionChangeEvent,
    );
    await assert.rejects(pending, /其他窗口占用/);
    Object.defineProperty(request, "result", {
      value: {
        close() {
          closed++;
        },
      },
    });
    request.onsuccess!.call(request, new Event("success"));
    assert.equal(closed, 1);
    const options = { requireDurable: true };
    const error = {
      message: "当前浏览器未启用本地持久存储，跨页跳转后项目归属无法保存",
    };
    assert.equal(await repo.isDurable(), false);
    await assert.rejects(
      repo.createProject({ name: "拒绝落盘" }, options),
      error,
    );
    assert.deepEqual(await repo.listProjects(), []);
    const p = await repo.createProject({ name: "无存储权限" });
    await assert.rejects(repo.assignFileToProject("key", p.id, options), error);
    assert.deepEqual(await repo.listFileAssignments(), {});
    assert.deepEqual(await repo.getProject(p.id), p);
    await repo.assignFileToProject("key", p.id);
    await assert.rejects(
      repo.removeDeletedFileState("key"),
      /稍后重试文件清理/,
    );
    assert.equal(await repo.getFileProject("key"), null);
    // Durable cleanup probes storage again even if the session had fallen back.
    assert.ok(attempts > 3);
  } finally {
    if (original) Object.defineProperty(globalThis, "indexedDB", original);
    else Reflect.deleteProperty(globalThis, "indexedDB");
  }
});

(typeof indexedDB === "undefined" ? test.skip : test)(
  "IndexedDB transactions coordinate independent connections, ignore corrupt records and persist after reopen",
  async () => {
    const repo = new IndexedDbProjectMemoryRepository();
    const other = new IndexedDbProjectMemoryRepository();
    assert.equal(await repo.isDurable(), true);
    const p = await repo.createProject(
      { name: "两窗口" },
      { requireDurable: true },
    );
    const key = "source-" + p.id;
    const target = projectScopeId(p.id);
    await new BrowserDocumentRepository(key).save(design([]));
    await new BrowserDocumentRepository("orphan").save(design([]));
    const raw = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open("forma-project-memory-v1", 2);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    try {
      assert.deepEqual(Array.from(raw.objectStoreNames), [
        "assignments",
        "episodes",
        "projects",
        "tombstones",
      ]);
      await new Promise<void>((resolve, reject) => {
        const tx = raw.transaction(
          ["projects", "assignments", "episodes"],
          "readwrite",
        );
        const store = tx.objectStore("episodes");
        assert.equal(store.index("byScope").keyPath, "scopeProjectId");
        store.put({ id: "bad", scopeProjectId: target });
        tx.objectStore("projects").put({ id: "bad" });
        tx.objectStore("assignments").put({ fileKey: "bad", projectId: p.id });
        tx.objectStore("assignments").put({
          fileKey: "orphan",
          projectId: "missing",
          updatedAt: date,
        });
        tx.oncomplete = () => resolve();
        tx.onabort = () => reject(tx.error);
      });
      await assert.rejects(
        repo.saveEpisode(
          episode("orphan", {
            sourceFileKey: "orphan",
            scopeProjectId: "file:orphan",
          }),
        ),
        { message: "目标项目空间已不存在，历史档案未写入" },
      );
      assert.deepEqual(await other.listEpisodes("file:orphan"), []);
      await repo.removeFileState("orphan");
      await repo.saveEpisode(
        episode("good-" + p.id, {
          sourceFileKey: key,
          scopeProjectId: fileScopeId(key),
        }),
      );
      const results = await Promise.all([
        repo.assignFileToProject(key, p.id),
        other.assignFileToProject(key, p.id, { requireDurable: true }),
      ]);
      assert.equal(
        results.reduce((n, r) => n + r.migratedEpisodes, 0),
        1,
      );
      const reopened = new IndexedDbProjectMemoryRepository();
      assert.equal((await reopened.listEpisodes(target)).length, 1);
      assert.equal((await reopened.countEpisodesByScope())[target], 1);
      assert.equal(await reopened.getProject("bad"), null);
      assert.equal(await reopened.getFileProject("bad"), null);
      const doomed = await createLocalFileWithKey(
        design([layer("frame", "page", "画板")]),
      );
      const privateScope = fileScopeId(doomed.key);
      await repo.saveEpisode(
        episode("private-" + p.id, {
          sourceFileKey: doomed.key,
          scopeProjectId: privateScope,
        }),
      );
      await repo.assignFileToProject(doomed.key, p.id, {
        migrateDraftEpisodes: false,
      });
      await deleteLocalFile(doomed.key);
      assert.equal(await readLocalDocument(doomed.key), null);
      assert.equal(await reopened.getFileProject(doomed.key), null);
      assert.deepEqual(await reopened.listEpisodes(privateScope), []);
      assert.deepEqual(await other.deleteProject(p.id), {
        unassignedFiles: [key],
        deletedEpisodes: 2,
      });
    } finally {
      raw.close();
      await deleteLocalFile(key);
      await deleteLocalFile("orphan");
    }
  },
);

test("hybrid tokens are deduplicated within continuous Han runs and Latin/digit words", () => {
  assert.deepEqual(tokenizeMemoryText("订单页 · CHECKOUT checkout 42！单 X"), [
    "订单",
    "订单页",
    "单页",
    "checkout",
    "42",
  ]);
  assert.deepEqual(tokenizeMemoryText("商 品"), []);
  assert.deepEqual(tokenizeMemoryText("𠀀商品"), ["𠀀商", "𠀀商品", "商品"]);
  assert.ok(
    tokenizeMemoryText(
      Array.from({ length: 600 }, (_, i) => "word" + i).join(" "),
    ).length <= 256,
  );
});

const search = (
  episodes: DesignEpisode[],
  prompt: string,
  extra: Partial<Parameters<typeof rankProjectEpisodes>[0]> = {},
) =>
  rankProjectEpisodes({
    episodes,
    prompt,
    currentFileKey: source.sourceFileKey,
    now: Date.parse(date),
    ...extra,
  });

test("same library and file boost with exact weights, cross-file CJK and English matches retain reasons", () => {
  const base = { title: "Checkout 订单页", libraryId: "mobile" };
  const eps = [
    episode("different-lib", { ...base, libraryId: "other" }),
    episode("same-file", base),
    episode("cross", { ...base, sourceFileKey: "file-b" }),
    episode("no-lib", { ...base, libraryId: undefined }),
  ];
  const ranked = search(eps, "CHECKOUT，订单", { targetLibraryId: "mobile" });
  assert.deepEqual(
    ranked.map((ep) => ep.id),
    ["same-file", "cross", "no-lib", "different-lib"],
  );
  const [same, cross, none, other] = ranked;
  assert.equal(same.matchScore! - cross.matchScore!, 12);
  assert.equal(same.matchScore! - none.matchScore!, 30);
  assert.equal(other.matchScore! - none.matchScore!, -10);
  assert.ok(same.matchReasons?.includes("当前设计稿"));
  assert.ok(cross.matchReasons?.includes("同项目跨稿"));
  assert.ok(cross.matchReasons?.includes("同组件库"));
  assert.match(cross.matchReasons!.join(" "), /checkout.*订单/);
});

test("each semantic field contributes its declared weight and recent and pinned boosts stay bounded", () => {
  const screen = {
    rootId: "r",
    name: "首页",
    role: "primary" as const,
    width: 10,
    height: 10,
    nodeCount: 1,
    componentIds: [],
    sampleTexts: ["checkout"],
  };
  const rich = episode("rich", {
    title: "checkout",
    tags: ["checkout"],
    summary: "checkout",
    screens: [screen],
    pinned: true,
  });
  const [ranked] = search([rich], "checkout");
  assert.equal(ranked.matchScore, 12 + 6 + 8 + 3 + 2.2 + 1.8 + 1);
  assert.ok(ranked.matchReasons?.includes("已置顶"));
  assert.equal(
    search([{ ...rich, createdAt: "2026-01-01T00:00:00Z" }], "checkout")[0]
      .matchScore,
    ranked.matchScore! - 6,
  );
  assert.equal(
    search([{ ...rich, createdAt: "2027-01-01T00:00:00Z" }], "checkout")[0]
      .matchScore,
    ranked.matchScore,
  );
  for (const patch of [
    { customModules: ["Checkout"] },
    {
      componentsUsed: [
        {
          libraryId: "l",
          componentId: "c",
          componentName: "Checkout",
          count: 1,
        },
      ],
    },
    { screens: [{ ...screen, name: "Checkout", sampleTexts: [] }] },
    { prompt: "Checkout" },
  ]) {
    assert.match(
      search([episode("hit", patch)], "checkout")[0].matchReasons!.join(" "),
      /checkout/,
    );
  }
});

test("explicit references precede semantic hits, exceed top-K in mention order and stop at eight", () => {
  const eps = Array.from({ length: 10 }, (_, i) =>
    episode("ep-" + i, { libraryId: "other" }),
  );
  eps.push(episode("hit", { title: "订单", libraryId: "mobile" }));
  const mentions = eps
    .slice(0, 10)
    .map((ep) => ep.id)
    .reverse();
  const found = search(eps, "订单", {
    limit: 1,
    targetLibraryId: "mobile",
    explicitEpisodeIds: ["missing", ...mentions, mentions[0]],
  });
  assert.deepEqual(
    found.map((ep) => ep.id),
    mentions.slice(0, 8),
  );
  assert.ok(
    found.every(
      (ep) => ep.explicitlyMentioned && ep.matchReasons?.includes("显式引用"),
    ),
  );
  assert.deepEqual(
    search(eps, "订单", {
      limit: 2,
      targetLibraryId: "mobile",
      explicitEpisodeIds: ["ep-5"],
    }).map((ep) => ep.id),
    ["ep-5", "hit"],
  );
});

test("short prompts recall two baseline episodes and semantic results honor bounded limits", () => {
  const eps = ["a", "b", "c", "d", "e", "f", "g", "h", "i"].map((id) =>
    episode(id, { title: "支付" }),
  );
  eps[7].pinned = true;
  eps[8].libraryId = "mobile";
  assert.deepEqual(
    search(eps, "做", { targetLibraryId: "mobile" }).map((ep) => ep.id),
    ["i", "h"],
  );
  assert.equal(search(eps, "支付").length, 5);
  assert.equal(search(eps, "支付", { limit: 0 }).length, 1);
  assert.equal(search(eps, "支付", { limit: 90 }).length, 8);
});

function layer(
  type: DesignNode["type"],
  id: string,
  name: string,
  parentId: string | null = null,
): DesignNode {
  return { ...createNode(type, parentId), id, name };
}
function design(nodes: DesignNode[]): DesignDocument {
  return {
    schemaVersion: 1,
    id: "doc-a",
    name: source.sourceFileName,
    revision: 1,
    tokens: {},
    nodes,
  };
}
function checkoutDesign() {
  const main = layer("frame", "main", "结算");
  const sheet = layer("frame", "sheet", "优惠弹层");
  const row = layer("frame", "row", "配送方式", "main");
  const template = layer("frame", "template", "付款按钮");
  template.templateKey = "payment";
  template.style.width = 120;
  template.style.height = 44;
  const instance = (id: string, parentId: string) => ({
    ...layer("frame", id, "按钮", parentId),
    instance: { libraryId: "mobile", componentId: "pay", variantId: "light" },
  });
  const doc = design([
    sheet,
    main,
    row,
    instance("pay1", "row"),
    instance("pay2", "sheet"),
    layer("frame", "internal", "实例内部", "pay1"),
    { ...layer("text", "ct", "标题", "internal"), text: "确认支付" },
    ...Array.from({ length: 8 }, (_, i) => ({
      ...layer("text", "text-" + i, "标签", "row"),
      text: "配送" + i,
    })),
  ]);
  doc.libraries = {
    mobile: {
      format: "forma/library",
      version: 1,
      id: "mobile",
      name: "移动端组件库",
      revision: 1,
      description: "",
      source: { name: "商城", license: "测试" },
      components: [
        {
          id: "pay",
          name: "付款按钮",
          category: "操作",
          description: "",
          variants: [
            { id: "light", name: "浅色", properties: {}, nodes: [template] },
          ],
        },
      ],
    },
  };
  return doc;
}
const archive = {
  scopeProjectId: scope,
  sourceFileKey: source.sourceFileKey,
  libraryId: "mobile",
};
const stamp = { id: "fixed", createdAt: date };

test("applied proposal archives touched screens, variant counts, custom frames, decisions, tags and the primary SVG", () => {
  const afterDoc = checkoutDesign();
  const input = {
    ...archive,
    beforeDoc: design([]),
    afterDoc,
    createdRootIds: ["sheet", "main", "row"],
    prompt: "生成 Checkout 结算流程",
    summary: "确认配送方式后付款",
    decisions: [{ question: "提交方式", choice: "一次确认" }],
    customModules: ["配送方式", "推荐楼层"],
    screenRoles: { sheet: "overlay" as const, main: "primary" as const },
  };
  const ep = buildEpisodeFromAppliedProposal(input, stamp);
  assert.deepEqual(ep, buildEpisodeFromAppliedProposal(input, stamp));
  assert.deepEqual(
    ep.screens.map((s) => [s.rootId, s.role]),
    [
      ["sheet", "overlay"],
      ["main", "primary"],
    ],
  );
  const main = ep.screens[1];
  assert.deepEqual([main.width, main.height, main.nodeCount], [390, 844, 13]);
  assert.equal(main.sampleTexts.length, 6);
  assert.ok(main.sampleTexts.every(Boolean));
  assert.deepEqual(main.componentIds, ["pay"]);
  assert.deepEqual(ep.componentsUsed, [
    {
      libraryId: "mobile",
      componentId: "pay",
      componentName: "付款按钮",
      count: 2,
      variantId: "light",
      assetTier: "component",
    },
  ]);
  assert.deepEqual(ep.customModules, ["配送方式", "推荐楼层"]);
  assert.deepEqual(ep.decisions, input.decisions);
  assert.equal(ep.libraryName, "移动端组件库");
  assert.ok(ep.tags.includes("checkout"));
  assert.match(ep.thumbnailSvg!, /<title>结算<\/title>/);
  assert.ok(ep.thumbnailSvg!.length <= 48000);
});

test("edit fallback finds the changed top-level frame after a descendant deletion or reordering", () => {
  const beforeDoc = checkoutDesign();
  const edit = (nodes: DesignNode[]) =>
    buildEpisodeFromAppliedProposal(
      {
        ...archive,
        beforeDoc,
        afterDoc: { ...beforeDoc, nodes },
        prompt: "调整标签",
        createdRootIds: [],
      },
      stamp,
    );
  const removed = edit(beforeDoc.nodes.filter((n) => n.id !== "text-5"));
  assert.deepEqual(
    removed.screens.map((s) => s.rootId),
    ["main"],
  );
  assert.equal(removed.mode, "edit");
  assert.deepEqual(removed.customModules, []);
  const reordered = edit([
    ...beforeDoc.nodes.slice(0, -2),
    ...beforeDoc.nodes.slice(-2).reverse(),
  ]);
  assert.deepEqual(
    reordered.screens.map((s) => s.rootId),
    ["main"],
  );
  assert.deepEqual(edit(structuredClone(beforeDoc.nodes)).screens, []);
  const [sheet, main, ...contents] = beforeDoc.nodes;
  assert.deepEqual(
    edit([main, sheet, ...contents]).screens.map((s) => s.rootId),
    ["main", "sheet"],
  );
});

test("mixed proposals archive both edited and created boards once in scene order", () => {
  const beforeDoc = checkoutDesign();
  const afterDoc = {
    ...beforeDoc,
    nodes: [
      ...beforeDoc.nodes.map((n) =>
        n.id === "text-0" ? { ...n, text: "送达时间" } : n,
      ),
      layer("frame", "receipt", "收据"),
    ],
  };
  const result = buildEpisodeFromAppliedProposal({
    ...archive,
    beforeDoc,
    afterDoc,
    createdRootIds: ["receipt", "receipt"],
    prompt: "修改配送并创建收据",
  });
  assert.deepEqual(
    result.screens.map((s) => s.rootId),
    ["main", "receipt"],
  );
  assert.ok(result.screens[0].sampleTexts.includes("送达时间"));
});

test("nested sections archive their individual scene frames and a descendant edit captures only its board", () => {
  const section = layer("section", "flow", "购买流程");
  const subsection = layer("section", "details", "明细", "flow");
  const beforeDoc = design([
    section,
    subsection,
    layer("frame", "checkout", "结算", "flow"),
    { ...layer("text", "title", "标题", "checkout"), text: "去结算" },
    layer("frame", "receipt", "收据", "details"),
    { ...layer("text", "total", "金额", "receipt"), text: "合计" },
    layer("frame", "home", "首页"),
  ]);
  const ids = (ep: DesignEpisode) => ep.screens.map((s) => s.rootId);
  const manual = (selectionIds: string[]) =>
    buildManualEpisodeFromSelection({
      ...archive,
      document: beforeDoc,
      selectionIds,
    });
  const boards = manual(["flow"]);
  assert.deepEqual(
    boards.screens.map((s) => [s.rootId, s.name, s.nodeCount, s.sampleTexts]),
    [
      ["checkout", "结算", 2, ["去结算"]],
      ["receipt", "收据", 2, ["合计"]],
    ],
  );
  assert.deepEqual(ids(manual([])), ["checkout", "receipt", "home"]);
  assert.deepEqual(ids(manual(["total"])), ["receipt"]);
  const proposal = (
    prior: DesignDocument,
    afterDoc: DesignDocument,
    createdRootIds: string[] = [],
  ) =>
    buildEpisodeFromAppliedProposal({
      ...archive,
      beforeDoc: prior,
      afterDoc,
      createdRootIds,
      prompt: "记录流程",
    });
  assert.deepEqual(ids(proposal(design([]), beforeDoc, ["flow"])), [
    "checkout",
    "receipt",
    "home",
  ]);
  const edited = {
    ...beforeDoc,
    nodes: beforeDoc.nodes.map((n) =>
      n.id === "total" ? { ...n, text: "总计" } : n,
    ),
  };
  assert.deepEqual(ids(proposal(beforeDoc, edited)), ["receipt"]);
  const added = {
    ...edited,
    nodes: [...edited.nodes, layer("frame", "done", "已完成", "flow")],
  };
  assert.deepEqual(ids(proposal(beforeDoc, added, ["done"])), [
    "receipt",
    "done",
  ]);
  const empty = design([section]);
  assert.deepEqual(
    ids(
      buildManualEpisodeFromSelection({
        ...archive,
        document: empty,
        selectionIds: [],
      }),
    ),
    ["flow"],
  );
  assert.deepEqual(ids(proposal(design([]), empty, ["flow"])), ["flow"]);
});

test("identical offline snapshots replay deterministically and keep the first persisted date, pin and migrated scope", async () => {
  const repo = new MemoryProjectMemoryRepository();
  const project = await repo.createProject({ name: "商城" });
  const input = {
    ...archive,
    scopeProjectId: fileScopeId(source.sourceFileKey),
    document: checkoutDesign(),
    selectionIds: ["main"],
  };
  const draft = buildManualEpisodeFromSelection(input);
  assert.deepEqual(
    buildManualEpisodeFromSelection(structuredClone(input)),
    draft,
  );
  const saved = await repo.saveEpisode(draft);
  assert.equal(saved.id, draft.id);
  assert.notEqual(saved.createdAt, draft.createdAt);
  await repo.updateEpisode(saved.id, { title: "新标题", pinned: true });
  await repo.assignFileToProject(source.sourceFileKey, project.id);
  const replay = await repo.saveEpisode(draft);
  assert.equal(replay.createdAt, saved.createdAt);
  assert.equal(replay.scopeProjectId, projectScopeId(project.id));
  assert.equal(replay.pinned, true);
  assert.equal(replay.title, "新标题");
  assert.deepEqual(await repo.listEpisodes(input.scopeProjectId), []);
});

test("archiving the unchanged draft after leaving a project replays only in the private scope", async () => {
  const repo = new MemoryProjectMemoryRepository();
  const key = source.sourceFileKey;
  const input = {
    ...archive,
    document: checkoutDesign(),
    selectionIds: ["main"],
  };
  const capture = () =>
    repo.saveEpisode(buildManualEpisodeFromSelection(input));
  const first = await capture();
  const p = await repo.createProject({ name: "项目 P" });
  await repo.assignFileToProject(key, p.id);
  const shared = await repo.updateEpisode(first.id, {
    title: "共享记录",
    pinned: true,
  });
  await repo.assignFileToProject(key, null);
  const draft = await capture();
  assert.equal(draft.scopeProjectId, fileScopeId(key));
  assert.notEqual(draft.id, first.id);
  assert.notEqual(draft.title, shared!.title);
  assert.deepEqual(await capture(), draft);
  assert.deepEqual(await repo.listEpisodes(fileScopeId(key)), [draft]);
  assert.deepEqual(await repo.listEpisodes(projectScopeId(p.id)), [shared]);
  const pinned = await repo.updateEpisode(draft.id, {
    pinned: true,
    title: "保留私有记录",
  });
  assert.equal(await repo.deleteEpisode(first.id), true);
  assert.deepEqual(await capture(), pinned);
  assert.deepEqual(await repo.listEpisodes(fileScopeId(key)), [pinned]);
  await assert.rejects(
    repo.saveEpisode(
      episode("collision", { scopeProjectId: projectScopeId(p.id) }),
    ),
    /所属项目已变更/,
  );
  await repo.saveEpisode(episode("collision"));
  await assert.rejects(
    repo.saveEpisode(
      episode("collision", {
        sourceFileKey: "other",
        scopeProjectId: "file:other",
      }),
    ),
    /ID 已被其他记忆空间使用/,
  );
  assert.deepEqual(await repo.listEpisodes("file:other"), []);
});

for (const field of ["summary", "title", "unchanged"] as const) {
  test(`returning a modern draft to its former project preserves its ${field} metadata`, async () => {
    const { restore } = memoryDatabaseForReconnect();
    try {
      const file = new BrowserDocumentRepository(source.sourceFileKey);
      const document = design([layer("frame", "board", "Board")]);
      await file.save(document);
      const repo = new IndexedDbProjectMemoryRepository();
      const capture = () =>
        repo.saveEpisode(
          buildManualEpisodeFromSelection({
            ...archive,
            document,
            selectionIds: ["board"],
            sourceLifetimeToken: file.getLifetimeToken(),
          }),
        );
      const original = await capture();
      assert.match(original.snapshotKey!, /^v2:/);
      const project = await repo.createProject({ name: "P" });
      const destination = projectScopeId(project.id);
      await repo.assignFileToProject(file.key, project.id);
      const shared = await repo.getEpisode(original.id);
      await repo.assignFileToProject(file.key, null);
      const draft = await capture();
      assert.equal(draft.snapshotKey, original.snapshotKey);
      assert.notEqual(draft.captureId, original.captureId);
      const guard = {
        expectedIdentityKey: episodeIdentityKey(draft),
        sourceFileKey: file.key,
        expectedLifetimeToken: file.getLifetimeToken(),
      };
      if (field !== "unchanged") {
        const edited = await repo.updateEpisode(
          draft.id,
          { [field]: "Edited privately" },
          guard,
        );
        assert.equal(edited?.[field], "Edited privately");
      }
      await repo.assignFileToProject(file.key, project.id);
      const peer = new IndexedDbProjectMemoryRepository();
      assert.deepEqual(
        await peer.listEpisodes(scope, { requireDurable: true }),
        [],
      );
      const rows = await peer.listEpisodes(destination, {
        requireDurable: true,
      });
      assert.deepEqual(
        rows.find((row) => row.id === original.id),
        shared,
      );
      assert.equal(rows.length, field === "unchanged" ? 1 : 2);
      if (field !== "unchanged") {
        const moved = rows.find((row) => row.id === draft.id);
        assert.ok(moved);
        assert.equal(moved[field], "Edited privately");
        assert.equal(moved.captureId, draft.captureId);
        const pin = await peer.updateEpisode(
          draft.id,
          { pinned: true },
          {
            ...guard,
            expectedScopeId: destination,
          },
        );
        assert.equal(pin?.pinned, true);
        assert.equal((await repo.getEpisode(draft.id))?.pinned, true);
      }
    } finally {
      restore();
    }
  });
}

test("repeated migrations to separate projects leave the third private replay stable after both shared copies are deleted", async () => {
  const repo = new MemoryProjectMemoryRepository();
  const snapshot = buildManualEpisodeFromSelection({
    ...archive,
    document: checkoutDesign(),
    selectionIds: ["main"],
  });
  const shared: string[] = [];
  for (const name of ["甲", "乙"]) {
    shared.push((await repo.saveEpisode(snapshot)).id);
    const project = await repo.createProject({ name });
    await repo.assignFileToProject(snapshot.sourceFileKey, project.id);
    await repo.assignFileToProject(snapshot.sourceFileKey, null);
  }
  const privateCopy = await repo.saveEpisode(snapshot);
  assert.ok(!shared.includes(privateCopy.id));
  const pinned = await repo.updateEpisode(privateCopy.id, { pinned: true });
  for (const id of shared) await repo.deleteEpisode(id);
  assert.deepEqual(await repo.saveEpisode(snapshot), pinned);
  assert.deepEqual(await repo.listEpisodes(snapshot.scopeProjectId), [pinned]);
});

test("unresolved preview selections never archive other committed boards", () => {
  const document = checkoutDesign();
  assert.equal(
    buildManualEpisodeFromSelection({ ...archive, document, selectionIds: [] })
      .screens.length,
    2,
  );
  assert.throws(
    () =>
      buildManualEpisodeFromSelection({
        ...archive,
        document,
        selectionIds: ["preview-only", "stale"],
      }),
    { message: "当前选区尚未提交或已不存在，请重新选择后再归档" },
  );
  assert.deepEqual(
    buildManualEpisodeFromSelection({
      ...archive,
      document,
      selectionIds: ["stale", "main"],
    }).screens.map((s) => s.rootId),
    ["main"],
  );
});

test("slice archives never call the thumbnail parser or include unrelated text", () => {
  const document = checkoutDesign();
  const slice = layer("slice", "slice", "100px 切片");
  slice.style.width = 100;
  document.nodes.push(slice);
  const parser = mock.method(DOMParser.prototype, "parseFromString");
  try {
    for (const parent of [null, "main"]) {
      slice.parentId = parent;
      const ep = buildManualEpisodeFromSelection({
        ...archive,
        document,
        selectionIds: [slice.id],
      });
      assert.equal(ep.thumbnailSvg, undefined);
      assert.deepEqual(
        ep.screens.map((s) => [s.rootId, s.sampleTexts]),
        [["slice", []]],
      );
      assert.ok(!JSON.stringify(ep).includes("确认支付"));
    }
    assert.equal(parser.mock.callCount(), 0);
  } finally {
    parser.mock.restore();
  }
});

test("thumbnail export bounds multiline text and vector path data on preview copies", () => {
  const root = layer("frame", "frame", "画板");
  const label = layer("text", "text", "正文", root.id);
  label.text = ("line\n".repeat(6) + "off-preview\n".repeat(1000)).slice(
    0,
    12000,
  );
  const vector = layer("vector", "shape", "形状", root.id);
  const path = "M0 0 " + "L1 1 ".repeat(1000);
  vector.vector = {
    width: 16,
    height: 16,
    paths: [{ d: path, fill: true, strokeWidth: 0 }],
  };
  const doc = design([root, label, vector]);
  const before = structuredClone(doc);
  const ep = buildManualEpisodeFromSelection({
    ...archive,
    document: doc,
    selectionIds: [root.id],
  });
  assert.ok(ep.thumbnailSvg && Buffer.byteLength(ep.thumbnailSvg) < 16_000);
  assert.match(ep.thumbnailSvg, /line/);
  assert.doesNotMatch(ep.thumbnailSvg, /off-preview|L1 1 L1 1/);
  assert.deepEqual(doc, before);
});

test("a board fingerprints its shared font bytes once and keeps them out of the thumbnail", () => {
  const root = layer("frame", "board", "画板"),
    label = layer("text", "label", "标签", root.id);
  label.text = "Label";
  const document = design([root, label]);
  const id = "font-" + "a".repeat(64);
  root.style.fontFamily = id;
  label.style.fontFamily = id;
  let reads = 0;
  let data = "data:font/otf;base64," + "A".repeat(1_000_000);
  document.fonts = {
    [id]: {
      name: "字体",
      axes: [],
      get data() {
        reads++;
        return data;
      },
    },
  };
  const capture = () =>
    buildManualEpisodeFromSelection({
      ...archive,
      document,
      selectionIds: [root.id],
    });
  const ep = capture();
  assert.equal(reads, 1);
  assert.ok(ep.thumbnailSvg && ep.thumbnailSvg.length < 4000);
  assert.match(ep.thumbnailSvg, /Label/);
  assert.doesNotMatch(ep.thumbnailSvg, /data:font|@font-face/);
  data = data.slice(0, -1) + "B";
  const changed = capture();
  assert.equal(reads, 2);
  assert.notEqual(changed.snapshotKey, ep.snapshotKey);
  assert.equal(changed.thumbnailSvg, ep.thumbnailSvg);
});

test("image, font, component and color profile changes fingerprint the selection and mark their affected boards", () => {
  const before = checkoutDesign();
  before.nodes.push(layer("frame", "unbound", "Unbound"));
  const label = before.nodes.find((node) => node.id === "ct")!;
  const font = "font-" + "a".repeat(64);
  label.style.fontFamily = font;
  before.fonts = {
    [font]: { name: "Brand", data: "data:font/otf;base64,AAAA", axes: [] },
  };
  const image = "img-" + "b".repeat(64);
  const row = before.nodes.find((node) => node.id === "row")!;
  row.image = { assetId: image, x: 0, y: 0, fit: "fill", zoom: 1 };
  before.images = {
    [image]: {
      name: "Logo",
      data: "data:image/png;base64,AAAA",
      width: 1,
      height: 1,
    },
  };
  const capture = (document: DesignDocument) =>
    buildManualEpisodeFromSelection({
      ...archive,
      document,
      selectionIds: ["sheet", "main", "unbound"],
    });
  const original = capture(before);
  const check = (edit: (doc: DesignDocument) => void, affected: string[]) => {
    const after = structuredClone(before);
    edit(after);
    assert.notEqual(capture(after).snapshotKey, original.snapshotKey);
    const changed = buildEpisodeFromAppliedProposal({
      ...archive,
      beforeDoc: before,
      afterDoc: after,
      prompt: "",
      createdRootIds: [],
    });
    assert.deepEqual(
      changed.screens.map((screen) => screen.rootId),
      affected,
    );
  };
  check(
    (doc) => {
      doc.images![image].data = "data:image/png;base64,AAAB";
    },
    ["main"],
  );
  check(
    (doc) => {
      doc.fonts![font].weight = 700;
    },
    ["main"],
  );
  check(
    (doc) => {
      doc.libraries!.mobile.components[0].description = "New definition";
    },
    ["sheet", "main"],
  );
  check(
    (doc) => {
      doc.colorProfile = "display-p3";
    },
    ["sheet", "main", "unbound"],
  );
});

test("manual offline archive resolves selection, active-page frames and standalone layers", () => {
  const document = checkoutDesign();
  document.pages = [
    { id: "open", name: "当前" },
    {
      id: "other",
      name: "其他页面",
      nodes: [layer("frame", "ignored", "其他稿")],
    },
  ];
  document.activePage = "open";
  const capture = (selectionIds: string[]) =>
    buildManualEpisodeFromSelection(
      { ...archive, document, selectionIds, title: "手动归档" },
      stamp,
    );
  assert.deepEqual(
    capture(["text-1"]).screens.map((s) => s.rootId),
    ["main"],
  );
  assert.deepEqual(
    capture(["row"]).screens.map((s) => s.rootId),
    ["row"],
  );
  assert.deepEqual(
    capture(["main", "row"]).screens.map((s) => s.rootId),
    ["main"],
  );
  const full = capture([]);
  assert.equal(full.title, "手动归档");
  assert.deepEqual(
    full.screens.map((s) => s.rootId),
    ["sheet", "main"],
  );
  assert.ok(designEpisodeSchema.safeParse(full).success);
  const standalone = buildManualEpisodeFromSelection({
    ...archive,
    document: design([layer("text", "note", "备忘")]),
    selectionIds: [],
  });
  assert.equal(standalone.screens[0].rootId, "note");
  assert.throws(
    () =>
      buildManualEpisodeFromSelection({
        ...archive,
        document: design([]),
        selectionIds: [],
      }),
    /当前页面暂无可归档的画板或图层/,
  );
});

test("chat payload uses the section 2.2 fields and formatted Chinese context preserves design decisions", () => {
  const ep = episode("one", {
    thumbnailSvg: "<svg/>",
    decisions: [{ question: "密度", choice: "紧凑" }],
  });
  const payload = toRecalledEpisodePayload(ep, {
    currentFileKey: "other",
    explicitlyMentioned: true,
  });
  assert.equal(payload.isCurrentFile, false);
  for (const field of [
    "thumbnailSvg",
    "scopeProjectId",
    "sourceDocId",
    "userId",
    "updatedAt",
  ])
    assert.ok(!(field in payload));
  assert.ok(recalledEpisodeSchema.safeParse(payload).success);
  assert.equal(formatEpisodePromptSection([]), "");
  const markdown = formatEpisodePromptSection([payload], "商城");
  for (const hint of [
    "项目历史需求记忆",
    "商城",
    "结算设计稿",
    "显式引用",
    "密度",
    "紧凑",
  ])
    assert.ok(markdown.includes(hint));
});

test("thumbnail sanitization preserves safe drawing primitives, internal references and small raster images", () => {
  const raw =
    '<svg xmlns="http://www.w3.org/2000/svg" onload="run()"><title>结算</title><script>run()</script><foreignObject><p>HTML</p></foreignObject><image href="data:image/png;base64,' +
    "A".repeat(9000) +
    '"/><image href="data:image/png;base64,AAAA"/><use href="#a"/><use href="javascript:run()"/><rect id="a" width="8" fill="url(#paint)" onclick="run()"/></svg>';
  const clean = sanitizeEpisodeThumbnailSvg(raw)!;
  assert.match(clean, /<rect/);
  assert.match(clean, /href="#a"/);
  assert.match(clean, /url\(#paint\)/);
  assert.match(clean, /data:image\/png;base64,AAAA"/);
  assert.doesNotMatch(
    clean,
    /<script|foreignObject|onload=|onclick=|javascript:|A{100}|run\(\)/i,
  );
  assert.equal(sanitizeEpisodeThumbnailSvg(clean), clean);
  assert.equal(sanitizeEpisodeThumbnailSvg(undefined), undefined);
  assert.equal(sanitizeEpisodeThumbnailSvg("<html/>"), undefined);
  assert.equal(sanitizeEpisodeThumbnailSvg("<svg><rect></svg>"), undefined);
  assert.equal(sanitizeEpisodeThumbnailSvg("before<svg/>after"), undefined);
  assert.equal(sanitizeEpisodeThumbnailSvg("<svg/><svg/>"), undefined);
  assert.equal(
    sanitizeEpisodeThumbnailSvg(
      "<svg><title>" + "x".repeat(48000) + "</title></svg>",
    ),
    undefined,
  );
  assert.equal(
    sanitizeEpisodeThumbnailSvg(
      "<svg><title>" + "字".repeat(20000) + "</title></svg>",
    ),
    undefined,
  );
});

test("oversized raw SVG is rejected before the XML parser runs", () => {
  const parser = mock.method(DOMParser.prototype, "parseFromString");
  try {
    // Comments disappear during sanitization, so a final-size check alone would accept this.
    assert.equal(
      sanitizeEpisodeThumbnailSvg(
        "<svg><!--" + "x".repeat(160_001) + "--></svg>",
      ),
      undefined,
    );
    assert.equal(parser.mock.callCount(), 0);
    assert.ok(sanitizeEpisodeThumbnailSvg("<svg/>"));
    assert.equal(parser.mock.callCount(), 1);
  } finally {
    parser.mock.restore();
  }
});

test("image-heavy boards preserve metadata, omit large photos before SVG export and skip thumbnails above 400 nodes", () => {
  const document = checkoutDesign();
  const largeId = "img-" + "a".repeat(64);
  const smallId = "img-" + "b".repeat(64);
  const small = {
    name: "图",
    width: 1,
    height: 1,
    data: "data:image/png;base64,AAAA",
  };
  const data = "data:image/png;base64," + "B".repeat(1_000_000);
  document.images = { [largeId]: { ...small, data }, [smallId]: small };
  for (let i = 0; i < 12; i++) {
    const node = layer("rectangle", "photo-" + i, "配图", "row");
    node.image = {
      assetId: i ? largeId : smallId,
      fit: "fill",
      x: 0,
      y: 0,
      zoom: 1,
    };
    document.nodes.push(node);
  }
  const capture = () =>
    buildManualEpisodeFromSelection({
      ...archive,
      document,
      selectionIds: ["main"],
      prompt: "结算照片",
    });
  const parser = mock.method(DOMParser.prototype, "parseFromString");
  try {
    const saved = capture();
    assert.equal(parser.mock.callCount(), 1);
    const svgInput = parser.mock.calls[0].arguments[0];
    assert.doesNotMatch(svgInput, /B{100}/);
    assert.match(saved.thumbnailSvg!, /data:image\/png;base64,AAAA/);
    assert.equal(document.images[largeId].data, data);
    assert.equal(saved.screens[0].nodeCount, 25);
    assert.equal(saved.screens[0].sampleTexts.length, 6);
    assert.deepEqual(saved.screens[0].componentIds, ["pay"]);
    assert.equal(saved.componentsUsed[0].count, 1);
    assert.deepEqual(saved.customModules, ["配送方式"]);
    // The fingerprint still reads the image table, while the preview skips SVG export.
    const dense = {
      ...document,
      nodes: [
        ...document.nodes,
        ...Array.from({ length: 376 }, (_, i) =>
          layer("rectangle", "extra-" + i, "内容", "main"),
        ),
      ],
    };
    let reads = 0;
    indexPublishedScene(dense);
    Object.defineProperty(dense, "images", {
      get() {
        reads++;
        return document.images;
      },
    });
    const skipped = buildManualEpisodeFromSelection({
      ...archive,
      document: dense,
      selectionIds: ["main"],
    });
    assert.equal(skipped.thumbnailSvg, undefined);
    assert.equal(skipped.screens[0].nodeCount, 401);
    assert.deepEqual(
      skipped.screens[0].sampleTexts,
      saved.screens[0].sampleTexts,
    );
    assert.deepEqual(skipped.componentsUsed, saved.componentsUsed);
    assert.deepEqual(skipped.customModules, saved.customModules);
    assert.equal(parser.mock.callCount(), 1);
    assert.equal(reads, 1);
  } finally {
    parser.mock.restore();
  }
});

test("external and encoded references, active SVG and styles are removed before storage", async () => {
  const svg =
    '<svg xmlns:xlink="http://www.w3.org/1999/xlink"><use xlink:href="java&#x73;cript:run()"/><image href="https://invalid.example/a"/><style>@import "bad";</style><animate attributeName="href"/><rect fill="url(https://invalid.example/a)"/></svg>';
  const repo = new MemoryProjectMemoryRepository();
  const saved = await repo.saveEpisode(episode("safe", { thumbnailSvg: svg }));
  const clean = saved.thumbnailSvg!;
  assert.ok(clean.startsWith("<svg"));
  assert.doesNotMatch(clean, /javascript|style|animate|invalid\.example/i);
  assert.equal((await repo.listEpisodes(scope))[0].thumbnailSvg, clean);
});

test("strict schemas reject oversized, malformed or undeclared archive and request fields", async () => {
  const ep = episode("validate");
  assert.equal(ep.userId, DEFAULT_MEMORY_USER_ID);
  for (const patch of [
    { scopeProjectId: "project:bad" },
    { scopeProjectId: "file:" },
    { scopeProjectId: "proj:" + "x".repeat(129) },
    { thumbnailSvg: "s".repeat(48001) },
    { sourceFileKey: "x".repeat(201) },
    { mode: "copy" },
    { title: " " },
    { createdAt: "yesterday" },
    { unexpected: true },
  ])
    assert.equal(
      designEpisodeSchema.safeParse({ ...ep, ...patch }).success,
      false,
    );
  const project = { id: "id", name: "名字", createdAt: date, updatedAt: date };
  for (const patch of [
    { name: " " },
    { name: "a".repeat(121) },
    { description: "z".repeat(401) },
    { defaultLibraryId: "x".repeat(129) },
    { id: "" },
    { unknown: 0 },
  ])
    assert.equal(
      projectSpaceSchema.safeParse({ ...project, ...patch }).success,
      false,
    );
  assert.equal(
    fileProjectAssignmentSchema.safeParse({
      fileKey: "",
      projectId: "p",
      updatedAt: date,
    }).success,
    false,
  );
  assert.equal(
    episodeDecisionSchema.safeParse({ question: "q", choice: " " }).success,
    false,
  );
  assert.equal(
    episodeComponentRefSchema.safeParse({
      libraryId: "l",
      componentId: "c",
      componentName: "c",
      count: -1,
    }).success,
    false,
  );
  assert.equal(
    episodeScreenSchema.safeParse({
      rootId: "a",
      name: "a",
      width: -1,
      height: 1,
      nodeCount: 1,
      role: "primary",
      sampleTexts: [],
      componentIds: [],
    }).success,
    false,
  );
  const payload = toRecalledEpisodePayload(ep, { currentFileKey: "a" });
  assert.equal(
    recalledEpisodeSchema.safeParse({ ...payload, thumbnailSvg: "<svg/>" })
      .success,
    false,
  );
});

test("restoring the same document at a reused key gets a fresh lifetime and rejects the stale row and archive", async () => {
  const db = documentDatabase(new Map());
  const { db: memoryDb } = memoryDatabaseFixture();
  const { db: catalogDb } = memoryDatabaseFixture();
  const restore = replaceGlobals({
    indexedDB: {
      open: (name: string) =>
        successfulRequest(
          name === "forma-studio"
            ? db
            : name === "forma-workspace-libraries-v1"
              ? catalogDb
              : memoryDb,
        ),
    },
    IDBKeyRange: { bound: () => ({}) },
  });
  const state = new MemoryProjectMemoryRepository(assertFileMemoryWritable);
  const cleanup = mock.method(
    IndexedDbProjectMemoryRepository.prototype,
    "removeFileState",
    state.removeFileState.bind(state),
  );
  const activate = mock.method(
    IndexedDbProjectMemoryRepository.prototype,
    "clearFileTombstone",
    state.clearFileTombstone.bind(state),
  );
  try {
    const key = "restored",
      doc = design([layer("frame", "board", "画板")]);
    const capture = (sourceLifetimeToken?: string) =>
      buildManualEpisodeFromSelection({
        document: doc,
        selectionIds: ["board"],
        sourceFileKey: key,
        scopeProjectId: fileScopeId(key),
        sourceLifetimeToken,
      });
    const old = new BrowserDocumentRepository(key);
    await old.save(doc);
    const first = (await listLocalFiles())[0].lifetimeToken;
    assert.ok(first);
    await old.save(doc);
    assert.equal(await getLocalFileLifetimeToken(key), first);
    const archive = await state.saveEpisode(capture(first));
    await old.delete();
    assert.equal(await getLocalFileLifetimeToken(key), undefined);
    const replacement = new BrowserDocumentRepository(key);
    await replacement.save(doc);
    const fresh = await getLocalFileLifetimeToken(key);
    assert.ok(fresh && fresh !== first);
    assert.equal((await listLocalFiles())[0].lifetimeToken, fresh);
    const shared = await state.createProject({ name: "新项目" });
    await assert.rejects(
      state.assignFileToProject(key, shared.id, {
        expectedLifetimeToken: first,
      }),
      /已替换/,
    );
    await assert.rejects(state.saveEpisode(archive), /已替换|已删除/);
    await assert.rejects(state.saveEpisode(capture()), /已删除/);
    const saved = await state.saveEpisode(capture(fresh));
    assert.equal(saved.sourceLifetimeToken, fresh);
    assert.equal(saved.sourceDocId, archive.sourceDocId);
    assert.deepEqual(await state.listEpisodes(fileScopeId(key)), [saved]);
    assert.equal(
      (
        await state.assignFileToProject(key, shared.id, {
          expectedLifetimeToken: fresh,
        })
      ).migratedEpisodes,
      1,
    );
    await assert.rejects(
      state.assignFileToProject(key, null, { expectedLifetimeToken: first }),
      /已替换/,
    );
    assert.equal((await state.getFileProject(key))?.id, shared.id);
  } finally {
    activate.mock.restore();
    cleanup.mock.restore();
    db.onclose();
    memoryDb.onclose();
    catalogDb.onclose();
    restore();
  }
});

test("applied proposal archive rejects the old tab and accepts the restored tab at the same file key and document ID", async () => {
  const cssHook = registerHooks({
    load(url, context, next) {
      return url.endsWith(".css")
        ? { format: "module", source: "", shortCircuit: true }
        : next(url, context);
    },
  });
  const { restore } = memoryDatabaseForReconnect();
  const restoreRange = replaceGlobals({ IDBKeyRange: { bound: () => ({}) } });
  try {
    const { archiveAppliedProposal } = await import("../src/editor/AgentPanel");
    const { key } = await createLocalFileWithKey(design([]));
    const repo1 = new BrowserDocumentRepository(key);
    const before = await repo1.load();
    assert.ok(before);
    const token1 = repo1.getLifetimeToken();
    assert.ok(token1);

    const repo2 = new BrowserDocumentRepository(key);
    await repo2.delete();
    await repo2.save(before);
    const token2 = repo2.getLifetimeToken();
    assert.ok(token2);
    assert.notEqual(token2, token1);
    assert.equal(repo1.getLifetimeToken(), token1);

    const board = layer("frame", "board", "画板");
    const after = { ...before, revision: before.revision + 1, nodes: [board] };
    const proposal: PendingAgentProposal = {
      source: "chat",
      transaction: {
        baseRevision: before.revision,
        operations: [{ type: "create", node: board }],
      },
      createdRootIds: [board.id],
      scopeProjectId: fileScopeId(key),
      summary: "新增画板",
      reply: "已生成画板",
    };
    const archiveFrom = (repo: BrowserDocumentRepository) =>
      archiveAppliedProposal(
        proposal,
        before,
        after,
        key,
        repo.getLifetimeToken(),
      );
    assert.match(await archiveFrom(repo1), /记录保存失败：.*已删除或已替换/);
    assert.deepEqual(await listScopeEpisodes(proposal.scopeProjectId), []);
    assert.equal(await archiveFrom(repo2), "已应用并存入设计记忆");
    const archived = await listScopeEpisodes(proposal.scopeProjectId);
    assert.equal(archived.length, 1);
    assert.equal(archived[0].sourceLifetimeToken, token2);
    assert.equal(archived[0].sourceDocId, before.id);
  } finally {
    restoreRange();
    restore();
    cssHook.deregister();
  }
});

test("scope publication and assignment wait for the same exclusive Web Lock and per-file FIFO", async () => {
  const key = "file-publish",
    name = "forma:file-lock:" + key;
  const waiting = signal(),
    releaseRemote = signal(),
    started = signal(),
    finish = signal();
  const locks: string[] = [];
  const restore = replaceGlobals({
    navigator: {
      locks: {
        async request(
          label: string,
          options: { mode: string },
          task: () => Promise<unknown>,
        ) {
          assert.equal(options.mode, "exclusive");
          locks.push(label);
          waiting.resolve();
          if (label === name) await releaseRemote.promise;
          return task();
        },
      },
    },
  });
  try {
    const state = new MemoryProjectMemoryRepository();
    const project = await state.createProject({ name: "B" });
    const publish = withFileProjectScopeLock(key, async () => {
      assert.equal(await state.getFileProject(key), null);
      started.resolve();
      await finish.promise;
      assert.equal(await state.getFileProject(key), null);
    });
    await waiting.promise;
    const move = state.assignFileToProject(key, project.id);
    await withFileProjectScopeLock("independent", async () => {});
    assert.deepEqual(locks, [name, "forma:file-lock:independent"]);
    releaseRemote.resolve();
    await started.promise;
    assert.equal(await state.getFileProject(key), null);
    finish.resolve();
    await Promise.all([publish, move]);
    assert.deepEqual(locks.slice(0, 3), [
      name,
      "forma:file-lock:independent",
      name,
    ]);
    assert.equal(locks.length, 4);
    assert.match(locks[3], /^forma:fence-op:/);
    assert.equal((await state.getFileProject(key))?.id, project.id);
  } finally {
    releaseRemote.resolve();
    finish.resolve();
    restore();
  }
});

test("scope-independent snapshot identity survives two migrations, a private pin and deletion in project A", async () => {
  const repo = new MemoryProjectMemoryRepository();
  const input = {
    ...archive,
    document: checkoutDesign(),
    selectionIds: ["main"],
    sourceLifetimeToken: "live",
  };
  const draft = buildManualEpisodeFromSelection(input);
  const a = await repo.createProject({ name: "A" }),
    b = await repo.createProject({ name: "B" });
  const first = await repo.saveEpisode(draft);
  await repo.assignFileToProject(draft.sourceFileKey, a.id);
  await repo.assignFileToProject(draft.sourceFileKey, null);
  const privateCopy = await repo.saveEpisode(draft);
  assert.notEqual(privateCopy.id, first.id);
  await repo.updateEpisode(privateCopy.id, { pinned: true });
  await repo.assignFileToProject(draft.sourceFileKey, b.id);
  await repo.deleteEpisode(first.id);
  const recaptured = buildManualEpisodeFromSelection({
    ...input,
    scopeProjectId: projectScopeId(b.id),
  });
  assert.ok(recaptured.snapshotKey);
  assert.equal(recaptured.snapshotKey, draft.snapshotKey);
  const replay = await repo.saveEpisode(recaptured);
  assert.equal(replay.id, privateCopy.id);
  assert.equal(replay.pinned, true);
  assert.deepEqual(await repo.listEpisodes(projectScopeId(b.id)), [replay]);
  const auto = buildEpisodeFromAppliedProposal({
    ...input,
    beforeDoc: design([]),
    afterDoc: input.document,
    createdRootIds: ["main"],
    prompt: "自动归档",
  });
  assert.equal(auto.sourceLifetimeToken, "live");
  assert.ok(auto.snapshotKey);
});

test("33 angular gradient palette layers have bounded raw SVG before sanitization", () => {
  const board = layer("frame", "palette", "色板");
  const nodes = [
    board,
    ...Array.from({ length: 32 }, (_, i) =>
      layer("rectangle", "swatch-" + i, "色块", board.id),
    ),
  ];
  const stops = Array.from({ length: 16 }, (_, i) => ({
    color: i % 2 ? "#112233" : "#ffeecc",
    opacity: 1,
    offset: i / 15,
  }));
  for (const [i, node] of nodes.entries()) {
    const gradient = { type: "angular" as const, angle: 45, stops };
    node.style.gradient = gradient;
    const paints = Array.from({ length: 4 }, (_, j) => ({
      id: "p" + j,
      color: "#333333",
      opacity: 1,
      visible: true,
      gradient: {
        ...gradient,
        type: j % 2 ? ("diamond" as const) : ("angular" as const),
      },
    }));
    node.style.paints = paints;
    node.style.strokePaints = paints;
    node.style.x = (i % 8) * 20;
    node.style.y = Math.floor(i / 8) * 20;
  }
  const parser = mock.method(DOMParser.prototype, "parseFromString");
  try {
    const basic = nodes.map((node) => ({
      ...node,
      style: { ...node.style, paints: undefined, strokePaints: undefined },
    }));
    for (const palette of [basic, nodes]) {
      const result = buildManualEpisodeFromSelection({
        ...archive,
        document: design(palette),
        selectionIds: [board.id],
      });
      assert.equal(result.screens[0].nodeCount, 33);
      assert.ok(
        result.thumbnailSvg && Buffer.byteLength(result.thumbnailSvg) < 20_000,
      );
      const raw = String(parser.mock.calls.at(-1)!.arguments[0]);
      assert.ok(Buffer.byteLength(raw) < 20_000);
      assert.ok((raw.match(/<path\b/g) ?? []).length < 160);
      assert.equal(palette[0].style.gradient?.type, "angular");
    }
    assert.equal(parser.mock.callCount(), 2);
  } finally {
    parser.mock.restore();
  }
});

// Model transaction commit and abort separately from individual successful requests.
function memoryDatabaseFixture() {
  const transactions: {
    mode?: string;
    reads: string[];
    puts: string[];
    aborted: boolean;
  }[] = [];
  type Row = { id?: string; fileKey?: string; scopeProjectId?: string };
  const disk = new Map<string, Map<string, Row>>();
  const state = {
    denials: 0,
    abortWrites: false,
    abortTransaction: (_stores: readonly string[], _puts: readonly string[]) =>
      false,
    delayCompletion: (
      _stores: readonly string[],
      _puts: readonly string[],
    ): Promise<void> | undefined => undefined,
    studioDenied: false,
    studioLiveReadFailures: 0,
    partitionReadError: (): Error | undefined => undefined,
    afterStudioCommit: (_keys: string[]): Promise<void> | undefined =>
      undefined,
    denyAuthorization: false,
    observedLeases: new Set<string>(),
  };
  // Schedule transactions in creation order. Contenders must read the last
  // committed lease even when their transactions were opened simultaneously.
  let tail = Promise.resolve();
  const db = {
    onclose() {},
    transaction(stores: string | string[], mode?: string) {
      const names = Array.isArray(stores) ? stores : [stores];
      const trace = {
        mode,
        reads: [] as string[],
        puts: [] as string[],
        aborted: false,
      };
      transactions.push(trace);
      const staged = new Map<string, Map<string, Row>>();
      const ready = tail.then(() => {
        for (const name of names) staged.set(name, new Map(disk.get(name)));
      });
      let aborted = false;
      const tx = {
        oncomplete() {},
        onabort() {},
        abort() {
          aborted = true;
          trace.aborted = true;
        },
        error: new Error("commit failed"),
        objectStore(name: string) {
          const rows = () => staged.get(name)!;
          function request<T>(read: () => T) {
            const req = { result: undefined as T, onsuccess() {} };
            void ready.then(() => {
              req.result = read();
              req.onsuccess();
            });
            return req;
          }
          return {
            get: (key: string) =>
              request(() => {
                trace.reads.push(key);
                const row = rows().get(key);
                if (row && key.startsWith("__forma_lock__:"))
                  state.observedLeases.add(key);
                return row;
              }),
            getAll: (range?: { lower?: string; upper?: string }) =>
              request(() =>
                [...rows()]
                  .filter(
                    ([key]) =>
                      (range?.lower === undefined || key >= range.lower) &&
                      (range?.upper === undefined || key <= range.upper),
                  )
                  .map(([, row]) => row),
              ),
            put: (row: Row) => {
              const key = (row.fileKey ?? row.id)!;
              trace.puts.push(key);
              return request(() => rows().set(key, structuredClone(row)));
            },
            delete: (key: string) => request(() => rows().delete(key)),
            index: () => ({
              getAll: (scope: string) =>
                request(() =>
                  [...rows().values()].filter(
                    (row) => row.scopeProjectId === scope,
                  ),
                ),
              getAllKeys: (scope: string) =>
                request(() =>
                  [...rows()]
                    .filter(([, row]) => row.scopeProjectId === scope)
                    .map(([key]) => key),
                ),
            }),
          };
        },
      };
      tail = ready
        .then(() => new Promise<void>((resolve) => setImmediate(resolve)))
        .then(() => {
          if (
            aborted ||
            (mode === "readwrite" &&
              (state.abortWrites || state.abortTransaction(names, trace.puts)))
          ) {
            trace.aborted = true;
            return tx.onabort();
          }
          if (mode === "readwrite")
            for (const [name, rows] of staged) disk.set(name, rows);
          const delay = state.delayCompletion(names, trace.puts);
          if (delay) void delay.then(() => tx.oncomplete());
          else tx.oncomplete();
        });
      return tx;
    },
  };
  return { state, disk, db, transactions };
}
function memoryDatabaseForReconnect() {
  const { state, disk, db, transactions } = memoryDatabaseFixture();
  const documents = new Map<string, unknown>();
  const catalog = memoryDatabaseFixture();
  const catalogConnections = new Set<{ onclose(): void }>();
  const studio = documentDatabase(
    documents,
    undefined,
    (stores, mode) => {
      if (
        state.denyAuthorization &&
        mode === "readwrite" &&
        Array.isArray(stores) &&
        stores.length === 3 &&
        stores.includes("document-parts")
      )
        throw new DOMException("authorization denied", "SecurityError");
      if (
        !mode &&
        Array.isArray(stores) &&
        stores.length === 3 &&
        stores.includes("document-parts") &&
        state.studioLiveReadFailures > 0
      ) {
        state.studioLiveReadFailures--;
        throw new DOMException("interrupted document read", "SecurityError");
      }
    },
    (keys) => state.afterStudioCommit(keys),
    () => state.partitionReadError(),
  );
  const studioConnections = new Set<{ onclose(): void }>();
  const closeStudio = () => {
    for (const connection of studioConnections) connection.onclose();
    studioConnections.clear();
  };
  const connections = new Set<{ onclose(): void }>();
  const closeMemory = () => {
    for (const connection of connections) connection.onclose();
    connections.clear();
  };

  const reset = replaceGlobals({
    indexedDB: {
      open(name: string) {
        if (name === "forma-studio") {
          if (state.studioDenied)
            throw new DOMException("disabled", "SecurityError");
          const connection = { ...studio };
          studioConnections.add(connection);
          return successfulRequest(connection);
        }
        if (name === "forma-workspace-libraries-v1") {
          const connection = { ...catalog.db };
          catalogConnections.add(connection);
          return successfulRequest(connection);
        }
        assert.equal(name, "forma-project-memory-v1");
        if (state.denials > 0) {
          state.denials--;
          throw new DOMException("denied", "SecurityError");
        }
        const connection = { ...db };
        connections.add(connection);
        return successfulRequest(connection);
      },
    },
    IDBKeyRange: {
      bound: (lower: unknown, upper: unknown) => {
        if (Array.isArray(lower) && lower.includes(null))
          throw new DOMException("Invalid key", "DataError");
        return { lower, upper };
      },
    },
  });
  const connect = () => new IndexedDbProjectMemoryRepository(async () => {});
  return {
    state,
    disk,
    transactions,
    catalog: catalog.disk,
    catalogTransactions: catalog.transactions,
    catalogState: catalog.state,
    documents,
    closeStudio,
    restore: () => {
      closeStudio();
      for (const connection of catalogConnections) connection.onclose();
      closeMemory();
      reset();
    },
    connect,
    closeMemory,
  };
}

test("first open denied only on archive save returns a session receipt and the next scope read commits it", async () => {
  const { state, restore, connect, closeMemory } = memoryDatabaseForReconnect();
  try {
    const file = new BrowserDocumentRepository(source.sourceFileKey);
    await file.save(design([]));
    closeMemory();
    const ep = episode("first-denial", {
      sourceLifetimeToken: file.getLifetimeToken(),
    });
    state.denials = 1;
    assert.deepEqual(await saveDesignEpisodeWithReceipt(ep), {
      episode: ep,
      durable: false,
    });
    assert.deepEqual(await listScopeEpisodes(scope), [ep]);
    assert.deepEqual(await connect().getEpisode(ep.id), ep);
    assert.deepEqual(await saveDesignEpisodeWithReceipt(ep), {
      episode: ep,
      durable: true,
    });
  } finally {
    restore();
  }
});

test("failed fallback reconciliation merges disk and session, keeps pins and deletes until the next commit", async () => {
  const { state, restore, connect, closeMemory } = memoryDatabaseForReconnect();
  try {
    await new BrowserDocumentRepository(source.sourceFileKey).save(design([]));
    const disk = connect(),
      session = connect(),
      ep = episode("session");
    await disk.saveEpisode(episode("disk"));
    state.denials = 1;
    assert.equal((await session.saveEpisodeWithReceipt(ep)).durable, false);
    state.abortWrites = true;
    assert.deepEqual(
      (await session.listEpisodes(scope)).map((ep) => ep.id),
      ["disk", "session"],
    );
    const pinned = await session.updateEpisode(ep.id, { pinned: true });
    assert.equal((await session.getEpisode(ep.id))?.pinned, true);
    assert.equal(await session.deleteEpisode("disk"), true);
    assert.deepEqual(await session.listEpisodes(scope), [pinned]);
    closeMemory();
    state.denials = 1;
    assert.deepEqual(await session.listEpisodes(scope), [pinned]);
    state.abortWrites = false;
    assert.deepEqual(await session.listEpisodes(scope), [pinned]);
    assert.deepEqual(await connect().listEpisodes(scope), [pinned]);
    await session.removeFileState(source.sourceFileKey);
    assert.deepEqual(await connect().listEpisodes(scope), []);
  } finally {
    restore();
  }
});

test("session projects and assignments retain stable IDs at reconnect and deleted lifetimes are never replayed", async () => {
  const { state, restore, connect } = memoryDatabaseForReconnect();
  try {
    const session = connect(),
      other = connect();
    const file = new BrowserDocumentRepository(source.sourceFileKey);
    await file.save(design([]));
    const refreshed = await other.clearFileTombstone(source.sourceFileKey, {
      activeDocId: "doc-a",
      activeLifetimeToken: file.getLifetimeToken(),
    });
    state.denials = 3;
    const p = await session.createProject({ name: "Session" });
    await session.assignFileToProject("another-file", p.id);
    const ep = episode("late", {
      sourceLifetimeToken: refreshed.activeLifetimeToken,
    });
    assert.equal((await session.saveEpisodeWithReceipt(ep)).durable, false);
    await other.removeFileState(source.sourceFileKey, {
      deletedDocId: "doc-a",
      deletedLifetimeToken: refreshed.activeLifetimeToken,
    });
    assert.deepEqual(await session.listEpisodes(scope), []);
    assert.deepEqual(await connect().getFileProject("another-file"), p);
    assert.deepEqual(await connect().getProject(p.id), p);
  } finally {
    restore();
  }
});

test("legacy tokenless deletion permits same-doc restore with the issued lifetime and rejects the ambiguous replay", async () => {
  const repo = new MemoryProjectMemoryRepository();
  const initial = await repo.saveEpisode(episode("original"));
  await repo.removeFileState(initial.sourceFileKey, {
    deletedDocId: initial.sourceDocId,
  });
  const { activeLifetimeToken } = await repo.clearFileTombstone(
    initial.sourceFileKey,
    initial.sourceDocId,
  );
  await assert.rejects(repo.saveEpisode(initial), /已删除/);
  const restored = await repo.saveEpisode({
    ...initial,
    id: "restored",
    sourceLifetimeToken: activeLifetimeToken,
  });
  assert.equal(restored.sourceDocId, initial.sourceDocId);
  assert.deepEqual(await repo.listEpisodes(scope), [restored]);
});

test("fallback pins follow snapshot identity when disk already stores the snapshot under a different ID", async () => {
  const { state, restore, connect } = memoryDatabaseForReconnect();
  try {
    await new BrowserDocumentRepository(source.sourceFileKey).save(design([]));
    const disk = connect(),
      session = connect();
    const original = episode("disk-id", { snapshotKey: "same-fingerprint" });
    await disk.saveEpisode(original);
    state.denials = 2;
    const volatile = await session.saveEpisodeWithReceipt({
      ...original,
      id: "session-id",
    });
    assert.equal(volatile.durable, false);
    await session.updateEpisode(volatile.episode.id, { pinned: true });
    const merged = await session.listEpisodes(scope);
    assert.deepEqual(
      merged.map((ep) => [ep.id, ep.pinned]),
      [["disk-id", true]],
    );
    assert.deepEqual(await connect().listEpisodes(scope), merged);
  } finally {
    restore();
  }
});

test("reconnecting a queued reassignment preserves a newer durable assignment from another tab", async () => {
  const { state, restore, connect } = memoryDatabaseForReconnect();
  try {
    const session = connect(),
      other = connect(),
      key = "offline-file";
    state.denials = 2;
    const a = await session.createProject({ name: "A" });
    await session.assignFileToProject(key, a.id);
    const b = await other.createProject({ name: "B" });
    await other.assignFileToProject(key, b.id);
    assert.equal((await session.getFileProject(key))?.id, b.id);
    assert.equal((await connect().getFileProject(key))?.id, b.id);
  } finally {
    restore();
  }
});

test("authoritative scope reads reject an open denial and an uncommitted journal, even with a session assignment", async () => {
  const { state, connect, restore } = memoryDatabaseForReconnect();
  try {
    const repo = connect();
    state.denials = 4;
    const project = await repo.createProject({ name: "Session project" });
    await repo.assignFileToProject("offline", project.id);
    assert.equal((await repo.getFileProject("offline"))?.id, project.id);
    await assert.rejects(
      repo.getFileProject("offline", { requireDurable: true }),
      {
        code: "PROJECT_MEMORY_UNAVAILABLE",
        message: "无法连接项目记忆存储，无法核验当前项目作用域",
      },
    );
    state.abortWrites = true;
    await assert.rejects(
      repo.getFileProject("offline", { requireDurable: true }),
      (error) =>
        isProjectMemoryUnavailableError(error) &&
        error instanceof Error &&
        /commit failed/.test(error.message),
    );
    state.abortWrites = false;
    assert.equal(
      (await repo.getFileProject("offline", { requireDurable: true }))?.id,
      project.id,
    );
  } finally {
    restore();
  }
});

test("stale file row deletion preserves the restored document, token, and its one durable private archive", async () => {
  const { restore, connect, documents } = memoryDatabaseForReconnect();
  try {
    const { key } = await createLocalFileWithKey(design([]));
    const token1 = (await listLocalFiles()).find(
      (row) => row.key === key,
    )!.lifetimeToken!;
    const staleRow = { expectedLifetimeToken: token1 };
    await deleteLocalFile(key, staleRow);
    await assert.rejects(
      deleteLocalFile(key, staleRow),
      isFileLifetimeMismatchError,
    );
    const replacement = new BrowserDocumentRepository(key);
    await replacement.save({ ...design([]), id: "new-doc" });
    const token2 = replacement.getLifetimeToken();
    assert.ok(token2 && token2 !== token1);
    const ep = episode("restored-private", {
      sourceDocId: "new-doc",
      sourceFileKey: key,
      scopeProjectId: fileScopeId(key),
      sourceLifetimeToken: token2,
    });
    assert.equal((await saveDesignEpisodeWithReceipt(ep)).durable, true);
    const before = structuredClone(documents);
    await assert.rejects(
      deleteLocalFile(key, staleRow),
      isFileLifetimeMismatchError,
    );
    assert.deepEqual(documents, before);
    assert.equal((await readLocalDocument(key))?.id, "new-doc");
    assert.equal(await getLocalFileLifetimeToken(key), token2);
    assert.deepEqual(await connect().listEpisodes(fileScopeId(key)), [ep]);
  } finally {
    restore();
  }
});

test("scope reads and transaction-guarded pin and delete reject the former editor lifetime after reassignment, including session fallback", async () => {
  const { connect, restore, documents } = memoryDatabaseForReconnect();
  try {
    const { key } = await createLocalFileWithKey(design([]));
    const first = (await getLocalFileLifetimeToken(key))!;
    await deleteLocalFile(key);
    const replacement = new BrowserDocumentRepository(key);
    await replacement.save(design([]));
    const fresh = replacement.getLifetimeToken()!;
    assert.notEqual(fresh, first);
    const state = connect();
    const p = await state.createProject({ name: "B" });
    await state.assignFileToProject(key, p.id, {
      expectedLifetimeToken: fresh,
    });
    const ep = await state.saveEpisode(
      episode("replacement", {
        sourceFileKey: key,
        scopeProjectId: projectScopeId(p.id),
        sourceLifetimeToken: fresh,
      }),
    );
    const guard = {
      sourceFileKey: key,
      expectedScopeId: ep.scopeProjectId,
      expectedLifetimeToken: first,
    };
    await assert.rejects(
      getFileProjectSpace(key, {
        requireDurable: true,
        expectedLifetimeToken: first,
      }),
      isFileLifetimeMismatchError,
    );
    await assert.rejects(
      state.getFileProject(key, { expectedLifetimeToken: first }),
      isFileLifetimeMismatchError,
    );
    await assert.rejects(
      state.updateEpisode(ep.id, { pinned: true }, guard),
      isFileLifetimeMismatchError,
    );
    await assert.rejects(
      state.deleteEpisode(ep.id, guard),
      isFileLifetimeMismatchError,
    );
    assert.deepEqual(await connect().getEpisode(ep.id), ep);
    assert.equal(
      (
        await getFileProjectSpace(key, {
          requireDurable: true,
          expectedLifetimeToken: fresh,
        })
      )?.id,
      p.id,
    );
    documents.set("__forma_internal_pending_memory_cleanups__", [
      { fileKey: key, deletedLifetimeToken: fresh },
    ]);
    await assert.rejects(
      getFileProjectSpace(key, { expectedLifetimeToken: fresh }),
      isFileLifetimeMismatchError,
    );
    const session = new MemoryProjectMemoryRepository();
    await session.clearFileTombstone(key, { activeLifetimeToken: fresh });
    await assert.rejects(
      session.getFileProject(key, { expectedLifetimeToken: first }),
      isFileLifetimeMismatchError,
    );
  } finally {
    restore();
  }
});

// Each URL instantiates a new scope queue and database connection, as in a second tab.
async function isolatedMemoryTab() {
  const url = new URL(
    "../src/infrastructure/project-memory-store.ts",
    import.meta.url,
  );
  url.searchParams.set("tab", crypto.randomUUID());
  return (await import(
    url.href
  )) as typeof import("../src/infrastructure/project-memory-store");
}

for (const useWebLocks of [false, true]) {
  test(`publication serializes with file moves and project deletion across isolated modules using ${useWebLocks ? "real exclusive Web Locks" : "only IndexedDB leases"}`, async () => {
    const {
      restore,
      connect,
      disk,
      catalog,
      catalogTransactions,
      state: storage,
    } = memoryDatabaseForReconnect();
    const restoreLocks = useWebLocks
      ? () => {}
      : replaceGlobals({ navigator: {} });
    const finish = signal();
    try {
      const remote = await isolatedMemoryTab();
      assert.notEqual(
        remote.withFileProjectScopeLock,
        withFileProjectScopeLock,
      );
      const other = new remote.IndexedDbProjectMemoryRepository(async () => {});
      const state = connect();
      const a = await state.createProject({ name: "A" }),
        b = await state.createProject({ name: "B" });
      const key = "publication";
      await new BrowserDocumentRepository(key).save(design([]));
      const library = {
        ...checkoutDesign().libraries!.mobile,
        id: "catalog-" + a.id,
      };
      await state.assignFileToProject(key, a.id);
      const checked = signal();
      const publish = (work: () => Promise<void>) =>
        withFileProjectScopeLock(
          key,
          async () => {
            if (
              (await state.getFileProject(key, { requireDurable: true }))
                ?.id !== a.id
            )
              return false;
            await work();
            return true;
          },
          { projectId: a.id },
        );
      const first = publish(async () => {
        const expectedFence = await readWorkspaceScopeFence(key, a.id);
        checked.resolve();
        await finish.promise;
        assert.equal(
          (await state.getFileProject(key, { requireDurable: true }))?.id,
          a.id,
        );
        await saveWorkspaceLibraryIfUnchanged(library, "packaged", null, {
          expectedFence,
        });
      });
      await checked.promise;
      const names = ["forma:project-lock:" + a.id, "forma:file-lock:" + key];
      for (const name of names)
        assert.ok(disk.get("tombstones")?.has("__forma_lock__:" + name));
      if (useWebLocks) {
        const { held } = await navigator.locks.query();
        for (const name of names)
          assert.ok(
            held?.some(
              (lock) => lock.name === name && lock.mode === "exclusive",
            ),
          );
      }
      storage.observedLeases.clear();
      let moved = false,
        deleted = false;
      const move = other.assignFileToProject(key, b.id).then(() => {
        moved = true;
      });
      const remove = other.deleteProject(a.id).then(() => {
        deleted = true;
      });
      const deadline = Date.now() + 2000;
      for (;;) {
        const waiters = useWebLocks
          ? ((await navigator.locks.query()).pending?.map(
              (lock) => lock.name,
            ) ?? [])
          : [...storage.observedLeases].map((key) =>
              key.slice("__forma_lock__:".length),
            );
        if (names.every((name) => waiters.includes(name))) break;
        assert.ok(
          Date.now() < deadline,
          "both remote operations must attempt the held locks",
        );
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      assert.deepEqual([moved, deleted], [false, false]);
      assert.equal((await listWorkspaceLibraries()).length, 0);
      finish.resolve();
      assert.equal(await first, true);
      const stageKey = catalogTransactions
        .flatMap((tx) => tx.puts)
        .find((id) => id.startsWith("__staged_lib__:cat-"));
      assert.ok(stageKey);
      assert.deepEqual(
        catalogTransactions.find((tx) => tx.puts.includes(library.id)),
        {
          mode: "readwrite",
          reads: [stageKey, "file:" + key, "project:" + a.id, library.id],
          puts: [library.id],
          aborted: false,
        },
      );
      await Promise.all([move, remove]);
      assert.equal((await state.getFileProject(key))?.id, b.id);
      assert.equal(await state.getProject(a.id), null);
      assert.deepEqual(
        (await listWorkspaceLibraries()).map((row) => row.id),
        [library.id],
      );
      assert.ok(catalog.get("libraries")?.has(library.id));
      assert.deepEqual(
        [...disk.get("tombstones")!.keys()],
        [key, "__forma_completed_fence_ops__"],
      );
      // Deletion first: an assigned file becomes private and the subsequent publish never writes.
      const c = await state.createProject({ name: "C" });
      await state.assignFileToProject(key, c.id);
      await other.deleteProject(c.id);
      await withFileProjectScopeLock(
        key,
        async () => {
          const project = await state.getFileProject(key, {
            requireDurable: true,
          });
          if (project)
            await saveWorkspaceLibraryDurable(
              { ...library, id: "stale-publication" },
              "packaged",
            );
          assert.equal(project, null);
        },
        { projectId: c.id },
      );
      assert.deepEqual(
        (await listWorkspaceLibraries()).map((row) => row.id),
        [library.id],
      );
      assert.ok(catalog.get("libraries")?.has(library.id));
    } finally {
      finish.resolve();
      restoreLocks();
      restore();
    }
  });
}

test("reconnection retires a queued activation after another tab saves a newer document generation in the same lifetime", async () => {
  const { state, restore, connect, disk } = memoryDatabaseForReconnect();
  try {
    const key = "two-tab-import";
    // The document commits normally while its post-save activation is denied.
    state.denials = 1;
    const first = new BrowserDocumentRepository(key);
    await first.save(design([]));
    const token = first.getLifetimeToken()!;
    assert.equal(disk.get("tombstones")?.get(key), undefined);
    const tab = await isolatedMemoryTab();
    const other = new tab.IndexedDbProjectMemoryRepository();
    // Route only the importing tab's activation to its independent repository.
    const activate = mock.method(
      IndexedDbProjectMemoryRepository.prototype,
      "clearFileTombstone",
      other.clearFileTombstone.bind(other),
    );
    try {
      const file = new BrowserDocumentRepository(key);
      await file.load();
      await file.save({ ...design([]), id: "new-doc" });
      assert.equal(file.getLifetimeToken(), token);
    } finally {
      activate.mock.restore();
    }
    const row = () =>
      disk.get("tombstones")?.get(key) as {
        activeDocId: string;
        activeDocGeneration: number;
      };
    assert.equal(row().activeDocId, "new-doc");
    assert.equal(row().activeDocGeneration, 2);
    await other.clearFileTombstone(key, {
      activeDocId: "doc-a",
      activeLifetimeToken: token,
      activeDocGeneration: 1,
    });
    assert.equal(row().activeDocId, "new-doc");
    await getFileProjectSpace(key, {
      requireDurable: true,
      expectedLifetimeToken: token,
    });
    assert.equal(row().activeDocId, "new-doc");
    const session = new IndexedDbProjectMemoryRepository();
    const ep = episode("archive", {
      sourceFileKey: key,
      scopeProjectId: fileScopeId(key),
      sourceLifetimeToken: token,
    });
    await assert.rejects(session.saveEpisode(ep), /已替换/);
    assert.equal(
      (await session.saveEpisodeWithReceipt({ ...ep, sourceDocId: "new-doc" }))
        .durable,
      true,
    );
    assert.equal((await connect().getEpisode(ep.id))?.sourceDocId, "new-doc");
  } finally {
    restore();
  }
});

test("a stale queued project rename retires on reconnect while a private archive and unrelated reads and writes succeed", async () => {
  const { state, connect, restore, closeMemory } = memoryDatabaseForReconnect();
  try {
    await new BrowserDocumentRepository(source.sourceFileKey).save(design([]));
    const other = connect(),
      session = connect();
    const removed = await other.createProject({ name: "删除目标" });
    const kept = await other.createProject({ name: "保留" });
    const ep = episode("offline-private");
    state.denials = 1;
    assert.equal((await session.saveEpisodeWithReceipt(ep)).durable, false);
    state.abortWrites = true;
    await session.updateProject(removed.id, { name: "临时改名" });
    // Once staged, another rename can be accepted with the open itself denied.
    closeMemory();
    state.denials = 1;
    await session.updateProject(removed.id, { name: "排队的改名" });
    state.abortWrites = false;
    await other.deleteProject(removed.id);
    assert.deepEqual(await session.listProjects(), [kept]);
    assert.deepEqual(await session.listEpisodes(scope), [ep]);
    assert.deepEqual(await session.getProject(kept.id), kept);
    const created = await session.createProject(
      { name: "恢复后创建" },
      { requireDurable: true },
    );
    assert.deepEqual(await connect().getEpisode(ep.id), ep);
    assert.deepEqual(await connect().getProject(created.id), created);
    assert.equal(await connect().getProject(removed.id), null);
  } finally {
    restore();
  }
});

test("legacy snapshots lacking snapshotKey retain the pinned B copy after two migrations and deletion in A", async () => {
  const { connect, restore, disk, documents } = memoryDatabaseForReconnect();
  try {
    const state = connect();
    const input = {
      ...archive,
      document: checkoutDesign(),
      selectionIds: ["main"],
    };
    documents.set(input.sourceFileKey, {
      generation: 1,
      current: input.document,
    });
    const legacy = buildManualEpisodeFromSelection(input);
    delete legacy.snapshotKey;
    const a = await state.createProject({ name: "A" }),
      b = await state.createProject({ name: "B" });
    // Seed an actual schema-valid pre-fix row, bypassing modern insertion backfill.
    disk.set(
      "episodes",
      new Map([[legacy.id, designEpisodeSchema.parse(legacy)]]),
    );
    await state.assignFileToProject(legacy.sourceFileKey, a.id);
    const first = (await state.listEpisodes(projectScopeId(a.id)))[0];
    assert.ok(first.snapshotKey);
    await state.assignFileToProject(legacy.sourceFileKey, null);
    const copy = await state.saveEpisode(legacy);
    assert.notEqual(copy.id, first.id);
    await state.assignFileToProject(legacy.sourceFileKey, b.id);
    await state.updateEpisode(copy.id, { pinned: true });
    await state.deleteEpisode(first.id);
    const pinned = await state.saveEpisode(legacy);
    assert.equal(pinned.id, copy.id);
    assert.equal(pinned.pinned, true);
    // A scoped copy whose migration key was lost cannot prove its original
    // historical identity. Preserve its pin and archive the distinct capture.
    const oldB = { ...pinned };
    delete oldB.snapshotKey;
    disk.get("episodes")!.set(oldB.id, oldB);
    const recaptured = buildManualEpisodeFromSelection({
      ...input,
      scopeProjectId: projectScopeId(b.id),
    });
    const replay = await state.saveEpisode(recaptured);
    assert.notEqual(replay.id, copy.id);
    assert.deepEqual(await connect().listEpisodes(projectScopeId(b.id)), [
      oldB,
      replay,
    ]);
  } finally {
    restore();
  }
});

test("33-node thumbnail charges the 5,702-character PNG at each placement before SVG sanitization", async () => {
  const png = await readFile(
    new URL("../docs/evidence/2026-11-21/v0.6.5/display.png", import.meta.url),
  );
  const data = "data:image/png;base64," + png.toString("base64");
  assert.equal(data.length, 5702);
  const board = layer("frame", "palette", "色板"),
    assetId = "img-" + "a".repeat(64);
  const document = design([
    board,
    ...Array.from({ length: 32 }, (_, i) => ({
      ...layer("rectangle", "swatch-" + i, "色块", board.id),
      image: { assetId, fit: "fill" as const, x: 0, y: 0, zoom: 1 },
    })),
  ]);
  document.images = {
    [assetId]: { name: "重复位图", data, width: 122, height: 95 },
  };
  const parser = mock.method(DOMParser.prototype, "parseFromString");
  try {
    const result = buildManualEpisodeFromSelection({
      ...archive,
      document,
      selectionIds: [board.id],
    });
    assert.equal(result.screens[0].nodeCount, 33);
    assert.ok(result.thumbnailSvg);
    assert.equal(parser.mock.callCount(), 1);
    const raw = String(parser.mock.calls[0].arguments[0]);
    assert.ok(Buffer.byteLength(raw) < 24_000);
    assert.equal(raw.split(data).length - 1, 2);
    assert.equal(document.nodes.filter((n) => n.image).length, 32);
  } finally {
    parser.mock.restore();
  }
});

for (const restoreFile of [false, true]) {
  test(`document DB SecurityError returns a session receipt and recovery ${restoreFile ? "retires a replaced lifetime" : "persists a verified lifetime"}`, async () => {
    const { state, restore, connect, closeStudio } =
      memoryDatabaseForReconnect();
    try {
      const { key } = await createLocalFileWithKey(design([]));
      const token = (await getLocalFileLifetimeToken(key))!;
      const ep = episode("unverified", {
        sourceFileKey: key,
        scopeProjectId: fileScopeId(key),
        sourceLifetimeToken: token,
      });
      closeStudio();
      state.studioDenied = true;
      const result = await saveDesignEpisodeWithReceipt(ep);
      assert.deepEqual(result, { episode: ep, durable: false });
      assert.deepEqual(await listScopeEpisodes(ep.scopeProjectId), [ep]);
      assert.equal(await connect().getEpisode(ep.id), null);
      state.studioDenied = false;
      if (restoreFile) {
        await deleteLocalFile(key, { expectedLifetimeToken: token });
        await new BrowserDocumentRepository(key).save(design([]));
        assert.notEqual(await getLocalFileLifetimeToken(key), token);
      }
      const expected = restoreFile ? [] : [ep];
      assert.deepEqual(await listScopeEpisodes(ep.scopeProjectId), expected);
      assert.deepEqual(
        await connect().listEpisodes(ep.scopeProjectId),
        expected,
      );
    } finally {
      restore();
    }
  });
}

test("an unavailable live document defers activation without blocking unrelated durable work, then its mismatched doc ID retires it", async () => {
  const { state, restore, closeStudio, disk, connect } =
    memoryDatabaseForReconnect();
  try {
    const { key } = await createLocalFileWithKey({
      ...design([]),
      id: "current",
    });
    const token = (await getLocalFileLifetimeToken(key))!;
    const repo = new IndexedDbProjectMemoryRepository();
    state.denials = 1;
    // A larger incoming generation cannot bypass an independent live doc-ID check.
    await repo.clearFileTombstone(key, {
      activeLifetimeToken: token,
      activeDocId: "obsolete",
      activeDocGeneration: 9,
    });
    closeStudio();
    state.studioDenied = true;
    await assert.rejects(
      repo.getFileProject(key, { requireDurable: true }),
      /文件存储/,
    );
    const unrelated = await repo.createProject(
      { name: "Independent" },
      { requireDurable: true },
    );
    assert.deepEqual(await connect().getProject(unrelated.id), unrelated);
    assert.equal(
      await repo.getFileProject("unrelated-file", { requireDurable: true }),
      null,
    );
    assert.equal(
      (disk.get("tombstones")?.get(key) as { activeDocId: string }).activeDocId,
      "current",
    );
    state.studioDenied = false;
    assert.equal(
      await repo.getFileProject(key, {
        requireDurable: true,
        expectedLifetimeToken: token,
      }),
      null,
    );
    assert.equal(
      (disk.get("tombstones")?.get(key) as { activeDocId: string }).activeDocId,
      "current",
    );
  } finally {
    restore();
  }
});

test("synchronous SecurityError from every IndexedDB open returns a session-only archive receipt", async () => {
  const { state, restore, connect, closeStudio } = memoryDatabaseForReconnect();
  try {
    state.denials = 2;
    closeStudio();
    state.studioDenied = true;
    const ep = episode("no-databases", { sourceLifetimeToken: "former-token" });
    assert.deepEqual(await saveDesignEpisodeWithReceipt(ep), {
      episode: ep,
      durable: false,
    });
    assert.deepEqual(await listScopeEpisodes(ep.scopeProjectId), [ep]);
    state.denials = 0;
    state.studioDenied = false;
    assert.deepEqual(await listScopeEpisodes(ep.scopeProjectId), []);
    assert.equal(await connect().getEpisode(ep.id), null);
  } finally {
    restore();
  }
});

test("publication cannot validate against a connection reopened after its lease acquisition was denied", async () => {
  const { state, restore, connect } = memoryDatabaseForReconnect();
  const restoreNavigator = replaceGlobals({ navigator: {} });
  try {
    const repo = connect();
    const a = await repo.createProject({ name: "A" });
    await repo.assignFileToProject("publishing", a.id);
    state.denials = 1;
    await assert.rejects(
      withFileProjectScopeLock(
        "publishing",
        () => getFileProjectSpace("publishing", { requireDurable: true }),
        { projectId: a.id },
      ),
      /无法核验/,
    );
    assert.equal(
      (await getFileProjectSpace("publishing", { requireDurable: true }))?.id,
      a.id,
    );
  } finally {
    restoreNavigator();
    restore();
  }
});

test("ordinary document open, save and deletion commit while memory writes abort", async () => {
  const { state, restore, documents } = memoryDatabaseForReconnect();
  try {
    const key = "memory-denied";
    const first = new BrowserDocumentRepository(key);
    await first.save(design([]));
    state.abortWrites = true;
    const file = new BrowserDocumentRepository(key);
    const doc = await file.load();
    assert.equal(doc?.revision, 1);
    assert.equal(file.getLifetimeToken(), first.getLifetimeToken());
    await file.save({ ...doc!, revision: 2 });
    assert.equal(
      (await new BrowserDocumentRepository(key).load())?.revision,
      2,
    );
    assert.equal((await file.recovery())?.revision, 1);
    assert.equal((await readLiveFileState(key))?.generation, 2);
    await deleteLocalFile(key, {
      expectedLifetimeToken: first.getLifetimeToken(),
    });
    assert.equal(await readLocalDocument(key), null);
    const [cleanup] = documents.get(
      "__forma_internal_pending_memory_cleanups__",
    ) as { fenceOp: string }[];
    assert.match(cleanup.fenceOp, /^delete:/);
    assert.deepEqual(
      documents.get("__forma_internal_pending_memory_cleanups__"),
      [
        {
          fileKey: key,
          fenceOp: cleanup.fenceOp,
          fenceInvalidated: true,
          deletedDocId: doc!.id,
          deletedLifetimeToken: first.getLifetimeToken(),
        },
      ],
    );
    const replacement = new BrowserDocumentRepository(key);
    await replacement.save({ ...design([]), id: "new-doc" });
    assert.notEqual(replacement.getLifetimeToken(), first.getLifetimeToken());
    state.abortWrites = false;
    await flushPendingFileMemoryCleanups();
    assert.equal(
      documents.has("__forma_internal_pending_memory_cleanups__"),
      false,
    );
    const current = episode("replacement-after-cleanup", {
      sourceFileKey: key,
      scopeProjectId: fileScopeId(key),
      sourceDocId: "new-doc",
      sourceLifetimeToken: replacement.getLifetimeToken(),
    });
    assert.equal(
      (
        await new IndexedDbProjectMemoryRepository().saveEpisodeWithReceipt(
          current,
        )
      ).durable,
      true,
    );
  } finally {
    restore();
  }
});

for (const change of ["move", "delete"] as const) {
  test(`catalog commit rejects a paused publisher after lease expiry and remote project ${change}`, async () => {
    const { restore, connect, catalog, catalogTransactions } =
      memoryDatabaseForReconnect();
    const restoreLocks = replaceGlobals({ navigator: {} });
    const resume = signal();
    const checked = signal();
    const start = Date.now();
    const clock = mock.method(Date, "now", () => start);
    let publication: Promise<unknown> | undefined;
    try {
      const tab = await isolatedMemoryTab();
      const remote = new tab.IndexedDbProjectMemoryRepository(async () => {});
      const state = connect();
      const key = "paused-" + change;
      await new BrowserDocumentRepository(key).save(design([]));
      const a = await state.createProject({ name: "A" });
      const b = await state.createProject({ name: "B" });
      await state.assignFileToProject(key, a.id);
      const library = {
        ...checkoutDesign().libraries!.mobile,
        id: "library-" + change,
      };
      publication = withFileProjectScopeLock(
        key,
        async () => {
          const expectedFence = await readWorkspaceScopeFence(key, a.id);
          assert.equal(
            (await state.getFileProject(key, { requireDurable: true }))?.id,
            a.id,
          );
          checked.resolve();
          await resume.promise;
          return saveWorkspaceLibraryIfUnchanged(library, "packaged", null, {
            expectedFence,
          });
        },
        { projectId: a.id },
      );
      await Promise.race([checked.promise, publication]);
      clock.mock.mockImplementation(() => start + 16_001);
      if (change === "move") await remote.assignFileToProject(key, b.id);
      else await remote.deleteProject(a.id);
      assert.equal(
        (await state.getFileProject(key))?.id,
        change === "move" ? b.id : undefined,
      );
      resume.resolve();
      await assert.rejects(publication, /所属项目空间已变更/);
      const transaction = catalogTransactions.at(-1);
      assert.deepEqual(transaction, {
        mode: "readwrite",
        reads: ["file:" + key, "project:" + a.id],
        puts: [],
        aborted: true,
      });
      assert.ok(!catalog.get("libraries")?.has(library.id));
      assert.deepEqual(await listWorkspaceLibraries(), []);
    } finally {
      resume.resolve();
      await publication?.catch(() => {});
      clock.mock.restore();
      restoreLocks();
      restore();
    }
  });
}

for (const partitioned of [false, true]) {
  test(`durable archive reconciles a missed generation-2 activation from a live ${partitioned ? "partitioned" : "inline"} document`, async () => {
    const { state, restore, disk } = memoryDatabaseForReconnect();
    try {
      const key = "import-" + partitioned;
      const original = new BrowserDocumentRepository(key);
      await original.save(design([]));
      const importing = new BrowserDocumentRepository(key);
      const old = await importing.load();
      assert.ok(old);
      const replacement = { ...old, id: "new-doc", revision: 2 };
      if (partitioned)
        replacement.importReport = {
          version: 1,
          format: "Sketch",
          filename: "import.sketch",
          sha256: "0".repeat(64),
          sourceNodes: 2001,
          issues: Array.from({ length: 2001 }, () => ({
            node: "board",
            detail: "import",
          })),
        };
      state.abortWrites = true;
      await importing.save(replacement);
      state.abortWrites = false;
      const token = original.getLifetimeToken()!;
      assert.deepEqual(await readLiveFileState(key), {
        exists: true,
        docId: "new-doc",
        lifetimeToken: token,
        generation: 2,
        documentEpoch: 2,
      });
      const row = () =>
        disk.get("tombstones")?.get(key) as {
          activeDocId: string;
          activeDocGeneration: number;
        };
      assert.equal(row().activeDocId, "doc-a");
      assert.equal(row().activeDocGeneration, 1);
      const repo = new IndexedDbProjectMemoryRepository();
      const ep = episode("original", {
        sourceFileKey: key,
        scopeProjectId: fileScopeId(key),
        sourceLifetimeToken: token,
      });
      await assert.rejects(repo.saveEpisodeWithReceipt(ep), /已替换/);
      assert.equal(await repo.getEpisode(ep.id), null);
      const current = { ...ep, id: "imported", sourceDocId: replacement.id };
      assert.deepEqual(await repo.saveEpisodeWithReceipt(current), {
        episode: current,
        durable: true,
      });
      assert.equal(row().activeDocId, replacement.id);
      assert.equal(row().activeDocGeneration, 2);
      assert.deepEqual(
        await new IndexedDbProjectMemoryRepository().listEpisodes(
          ep.scopeProjectId,
        ),
        [current],
      );
    } finally {
      restore();
    }
  });
}

test("an editor with no bound lifetime cannot read, pin or delete replacement history", async () => {
  const { restore, disk } = memoryDatabaseForReconnect();
  try {
    const key = "unbound-editor";
    const repo = new IndexedDbProjectMemoryRepository();
    const guard = {
      sourceFileKey: key,
      requireBoundLifetime: true,
      expectedLifetimeToken: undefined,
    };
    assert.equal(await repo.getFileProject(key, guard), null);
    await new BrowserDocumentRepository(key).save(design([]));
    await deleteLocalFile(key);
    await assert.rejects(
      repo.getFileProject(key, guard),
      isFileLifetimeMismatchError,
    );
    const file = new BrowserDocumentRepository(key);
    await file.save(design([]));
    const b = await repo.createProject({ name: "B" });
    await repo.assignFileToProject(key, b.id);
    const ep = await repo.saveEpisode(
      episode("replacement", {
        sourceFileKey: key,
        scopeProjectId: projectScopeId(b.id),
        sourceLifetimeToken: file.getLifetimeToken(),
      }),
    );
    await assert.rejects(
      repo.getFileProject(key, guard),
      isFileLifetimeMismatchError,
    );
    await assert.rejects(
      repo.updateEpisode(ep.id, { pinned: true }, guard),
      isFileLifetimeMismatchError,
    );
    await assert.rejects(
      repo.deleteEpisode(ep.id, guard),
      isFileLifetimeMismatchError,
    );
    assert.deepEqual(
      await new IndexedDbProjectMemoryRepository().getEpisode(ep.id),
      ep,
    );
    disk.get("tombstones")!.delete(key); // A failed activation leaves only the document as evidence.
    await assert.rejects(
      repo.getFileProject(key, guard),
      isFileLifetimeMismatchError,
    );
    await assert.rejects(
      repo.updateEpisode(ep.id, { pinned: true }, guard),
      isFileLifetimeMismatchError,
    );
    await assert.rejects(
      repo.deleteEpisode(ep.id, guard),
      isFileLifetimeMismatchError,
    );
  } finally {
    restore();
  }
});

test("a legacy snapshot retains First brief and separately archives Revised brief", async () => {
  const { restore, disk } = memoryDatabaseForReconnect();
  try {
    const key = "revised-brief";
    const file = new BrowserDocumentRepository(key);
    const board = layer("frame", "brief", "Brief");
    const doc = design([
      board,
      { ...layer("text", "body", "Text", board.id), text: "First brief" },
    ]);
    await file.save(doc);
    const capture = (document: DesignDocument) =>
      buildManualEpisodeFromSelection({
        document,
        selectionIds: [board.id],
        sourceFileKey: key,
        scopeProjectId: fileScopeId(key),
        sourceLifetimeToken: file.getLifetimeToken(),
      });
    const first = capture(doc);
    const legacy = { ...first };
    delete legacy.snapshotKey;
    disk.set(
      "episodes",
      new Map([[legacy.id, designEpisodeSchema.parse(legacy)]]),
    );
    const next = {
      ...doc,
      revision: doc.revision + 1,
      nodes: [board, { ...doc.nodes[1], text: "Revised brief" }],
    };
    await file.save(next);
    const revised = capture(next);
    assert.notEqual(first.snapshotKey, revised.snapshotKey);
    assert.notEqual(
      deriveLegacySnapshotKey(legacy),
      deriveLegacySnapshotKey(revised),
    );
    const repo = new IndexedDbProjectMemoryRepository();
    const result = await repo.saveEpisodeWithReceipt(revised);
    assert.equal(result.durable, true);
    assert.deepEqual(result.episode.screens[0].sampleTexts, ["Revised brief"]);
    const rows = await new IndexedDbProjectMemoryRepository().listEpisodes(
      fileScopeId(key),
    );
    assert.deepEqual(rows.map((row) => row.screens[0].sampleTexts[0]).sort(), [
      "First brief",
      "Revised brief",
    ]);
  } finally {
    restore();
  }
});

test("a tokenless legacy draft keeps its pinned B archive alongside modern recaptures after two migrations", async () => {
  const { restore, disk } = memoryDatabaseForReconnect();
  try {
    const key = "legacy-with-live-file";
    const file = new BrowserDocumentRepository(key);
    const document = checkoutDesign();
    await file.save(document);
    const token = file.getLifetimeToken()!;
    const input = {
      ...archive,
      document,
      selectionIds: ["main"],
      sourceFileKey: key,
      scopeProjectId: fileScopeId(key),
    };
    const legacy = buildManualEpisodeFromSelection(input);
    delete legacy.snapshotKey;
    assert.equal(legacy.sourceLifetimeToken, undefined);
    disk.set(
      "episodes",
      new Map([[legacy.id, designEpisodeSchema.parse(legacy)]]),
    );
    const repo = new IndexedDbProjectMemoryRepository();
    const a = await repo.createProject({ name: "A" }),
      b = await repo.createProject({ name: "B" });
    await repo.assignFileToProject(key, a.id);
    const [first] = await repo.listEpisodes(projectScopeId(a.id));
    assert.equal(first.sourceLifetimeToken, token);
    assert.equal(first.snapshotKey, legacy.id);
    await repo.assignFileToProject(key, null);
    const copy = await repo.saveEpisode(legacy);
    assert.notEqual(copy.id, first.id);
    assert.equal(copy.snapshotKey, legacy.id);
    await repo.assignFileToProject(key, b.id);
    const pinned = await repo.updateEpisode(copy.id, { pinned: true });
    assert.ok(pinned?.pinned);
    assert.equal(pinned.sourceLifetimeToken, token);
    assert.equal(pinned.snapshotKey, legacy.id);
    await repo.deleteEpisode(first.id);
    const current = buildManualEpisodeFromSelection({
      ...input,
      scopeProjectId: projectScopeId(b.id),
      sourceLifetimeToken: token,
    });
    const result = await repo.saveEpisodeWithReceipt(current);
    assert.equal(result.durable, true);
    assert.notEqual(result.episode.id, copy.id);
    assert.match(result.episode.snapshotKey!, /^v2:[^:]+$/);
    assert.equal(result.episode.pinned, undefined);
    assert.deepEqual(await repo.saveEpisodeWithReceipt(current), result);
    assert.deepEqual(
      await new IndexedDbProjectMemoryRepository().listEpisodes(
        projectScopeId(b.id),
      ),
      [pinned, result.episode],
    );
  } finally {
    restore();
  }
});

test("stale file-list read and rename reject deleted and replaced rows without modifying the replacement", async () => {
  const { restore } = memoryDatabaseForReconnect();
  try {
    const key = "stale-file-row";
    const first = new BrowserDocumentRepository(key);
    await first.save(design([]));
    const stale = { expectedLifetimeToken: first.getLifetimeToken() };
    const rejectStale = async () => {
      await assert.rejects(
        readLocalDocument(key, stale),
        isFileLifetimeMismatchError,
      );
      await assert.rejects(
        renameLocalFile(key, "stale", stale),
        isFileLifetimeMismatchError,
      );
    };
    await deleteLocalFile(key, stale);
    await rejectStale();
    const second = new BrowserDocumentRepository(key);
    await second.save({
      ...design([]),
      id: "replacement",
      name: "Replacement design",
    });
    const guard = { expectedLifetimeToken: second.getLifetimeToken() };
    const before = await readLocalDocument(key, guard);
    await rejectStale();
    assert.equal(before?.name, "Replacement design");
    assert.deepEqual(await readLocalDocument(key, guard), before);
    assert.equal((await readLiveFileState(key))?.generation, 1);
    await renameLocalFile(key, "current", guard);
    assert.equal((await readLocalDocument(key, guard))?.name, "current");
  } finally {
    restore();
  }
});

for (const recovery of [
  "unchanged",
  "moved",
  "deleted project",
  "imported document",
  "replaced file",
] as const) {
  test(`dual-database denial retains a project archive in the session and verifies recovery with ${recovery}`, async () => {
    const { state, closeMemory, closeStudio, restore, disk } =
      memoryDatabaseForReconnect();
    try {
      const key = "dual-denial";
      const file = new BrowserDocumentRepository(key);
      await file.save(design([]));
      const other = new IndexedDbProjectMemoryRepository();
      const p = await other.createProject({ name: "P" });
      await other.assignFileToProject(key, p.id);
      closeStudio();
      closeMemory();
      state.studioDenied = true;
      state.denials = Infinity;
      const session = new IndexedDbProjectMemoryRepository();
      const ep = episode("offline-in-P", {
        sourceFileKey: key,
        scopeProjectId: projectScopeId(p.id),
        sourceLifetimeToken: file.getLifetimeToken(),
      });
      assert.deepEqual(await session.saveEpisodeWithReceipt(ep), {
        durable: false,
        episode: ep,
      });
      assert.deepEqual(await session.listEpisodes(ep.scopeProjectId), [ep]);
      assert.equal(disk.get("episodes")?.has(ep.id), false);
      state.denials = 0;
      state.studioDenied = false;
      if (recovery === "moved")
        await other.assignFileToProject(
          key,
          (await other.createProject({ name: "B" })).id,
        );
      if (recovery === "deleted project") await other.deleteProject(p.id);
      if (recovery === "imported document")
        await file.save({ ...design([]), id: "new-doc" });
      if (recovery === "replaced file") {
        await deleteLocalFile(key);
        await new BrowserDocumentRepository(key).save(design([]));
        await other.assignFileToProject(key, p.id);
      }
      const expected = recovery === "unchanged" ? [ep] : [];
      assert.deepEqual(await session.listEpisodes(ep.scopeProjectId), expected);
      assert.equal(await session.isDurable(), true);
      assert.deepEqual(
        await new IndexedDbProjectMemoryRepository().listEpisodes(
          ep.scopeProjectId,
        ),
        expected,
      );
    } finally {
      restore();
    }
  });
}

test("replaying an offline project deletion also invalidates publication fences", async () => {
  const { state, connect, restore } = memoryDatabaseForReconnect();
  try {
    const online = connect(),
      offline = connect(),
      key = "journaled-delete";
    await new BrowserDocumentRepository(key).save(design([]));
    const project = await online.createProject({ name: "Queued deletion" });
    await online.assignFileToProject(key, project.id);
    state.denials = 1;
    await offline.deleteProject(project.id);
    const expectedFence = await readWorkspaceScopeFence(key, project.id);
    assert.equal((await online.getFileProject(key))?.id, project.id);
    assert.equal(await offline.getProject(project.id), null);
    assert.equal(await online.getFileProject(key), null);
    const library = {
      ...checkoutDesign().libraries!.mobile,
      id: "queued-deletion",
    };
    await assert.rejects(
      saveWorkspaceLibraryIfUnchanged(library, "packaged", null, {
        expectedFence,
      }),
      /所属项目空间已变更/,
    );
  } finally {
    restore();
  }
});

for (const heal of ["read", "second move", "catalog save"] as const) {
  test(`a committed assignment with only its closing fence write aborted is healed by ${heal}`, async () => {
    const {
      connect,
      restore,
      disk,
      catalog,
      catalogState,
      catalogTransactions,
    } = memoryDatabaseForReconnect();
    const noLocks = replaceGlobals({ navigator: {} });
    try {
      const repo = connect(),
        key = "interrupted-move";
      await new BrowserDocumentRepository(key).save(design([]));
      const a = await repo.createProject({ name: "A" }),
        b = await repo.createProject({ name: "B" });
      const stale = await readWorkspaceScopeFence(key);
      let writes = 0;
      catalogState.abortTransaction = (stores, puts) =>
        stores.includes("fences") &&
        puts.includes("file:" + key) &&
        ++writes === 2;
      await repo.assignFileToProject(key, a.id);
      assert.equal(writes, 2);
      assert.equal((await repo.getFileProject(key))?.id, a.id);
      const fence = () =>
        catalog.get("fences")!.get("file:" + key) as unknown as {
          epoch: number;
          inFlightOps: string[];
        };
      const [op] = fence().inFlightOps;
      assert.ok(op);
      assert.equal(fence().epoch, stale.fileEpoch + 1);
      assert.deepEqual(
        (
          disk.get("tombstones")?.get("__forma_completed_fence_ops__") as {
            opIds: string[];
          }
        ).opIds,
        [op],
      );
      const library = {
        ...checkoutDesign().libraries!.mobile,
        id: "interrupted-publish",
      };
      const publish = () =>
        saveWorkspaceLibraryIfUnchanged(library, "packaged", null, {
          expectedFence: stale,
        });
      if (heal === "read")
        assert.equal(
          (await readWorkspaceScopeFence(key)).fileEpoch,
          stale.fileEpoch + 2,
        );
      else if (heal === "second move")
        await repo.assignFileToProject(key, b.id);
      else await assert.rejects(publish(), /所属项目空间已变更/);
      assert.deepEqual(fence().inFlightOps, []);
      assert.ok(fence().epoch >= stale.fileEpoch + 2);
      await assert.rejects(publish(), /所属项目空间已变更/);
      assert.ok(
        !catalogTransactions.some((tx) => tx.puts.includes(library.id)),
      );
    } finally {
      noLocks();
      restore();
    }
  });
}

test("a private draft fence rejects publication after the draft is assigned", async () => {
  const { connect, restore, catalogTransactions } =
    memoryDatabaseForReconnect();
  try {
    const key = "draft-publish",
      repo = connect();
    await new BrowserDocumentRepository(key).save(design([]));
    const fence = await readWorkspaceScopeFence(key, null);
    assert.deepEqual(fence, {
      fileKey: key,
      projectId: null,
      fileEpoch: 0,
      projectEpoch: 0,
    });
    assert.deepEqual(await readWorkspaceScopeFence(key), fence);
    await repo.assignFileToProject(
      key,
      (await repo.createProject({ name: "B" })).id,
    );
    const library = {
      ...checkoutDesign().libraries!.mobile,
      id: "stale-draft",
    };
    await assert.rejects(
      saveWorkspaceLibraryIfUnchanged(library, "packaged", null, {
        expectedFence: fence,
      }),
      /已变更/,
    );
    assert.deepEqual(catalogTransactions.at(-1)?.reads, ["file:" + key]);
    assert.ok(!catalogTransactions.some((tx) => tx.puts.includes(library.id)));
  } finally {
    restore();
  }
});

for (const failure of ["none", "memory writes", "catalog writes"] as const) {
  test(`source deletion invalidates the publisher fence and recovers its intent with failure: ${failure}`, async () => {
    const {
      state,
      catalogState,
      catalogTransactions,
      catalog,
      restore,
      documents,
    } = memoryDatabaseForReconnect();
    try {
      const key = "deleted-publisher",
        repo = new IndexedDbProjectMemoryRepository();
      const file = new BrowserDocumentRepository(key);
      await file.save(design([]));
      const project = await repo.createProject({ name: "A" });
      await repo.assignFileToProject(key, project.id);
      const fence = await readWorkspaceScopeFence(key, project.id);
      state.abortWrites = failure === "memory writes";
      catalogState.abortWrites = failure === "catalog writes";
      await deleteLocalFile(key);
      assert.equal((await readLiveFileState(key))?.exists, false);
      const marker = "__forma_internal_pending_memory_cleanups__";
      assert.equal(documents.has(marker), failure !== "none");
      const fileEpoch = () =>
        (catalog.get("fences")!.get("file:" + key) as { epoch: number }).epoch;
      assert.deepEqual([fence.fileEpoch, fence.projectEpoch], [2, 0]);
      if (failure === "catalog writes")
        assert.equal(fileEpoch(), fence.fileEpoch);
      if (failure === "memory writes") assert.ok(fileEpoch() > fence.fileEpoch);
      state.abortWrites = catalogState.abortWrites = false;
      const library = {
        ...checkoutDesign().libraries!.mobile,
        id: "from-deleted-file",
      };
      await assert.rejects(
        saveWorkspaceLibraryIfUnchanged(library, "packaged", null, {
          expectedFence: fence,
        }),
        { message: "所属项目空间或源文件状态已变更，请刷新后重试" },
      );
      assert.ok(fileEpoch() > fence.fileEpoch);
      assert.equal(documents.has(marker), false);
      assert.equal(await repo.getFileProject(key), null);
      await assert.rejects(
        readWorkspaceScopeFence(key, project.id),
        /源文件状态已变更/,
      );
      assert.ok(
        !catalogTransactions.some((tx) => tx.puts.includes(library.id)),
      );
    } finally {
      restore();
    }
  });
}

for (const scenario of [
  "shared guard",
  "isolated insert",
  "isolated eviction",
  "isolated replay",
] as const) {
  test(`an ordinary save replacing document identity overlaps archive validation: ${scenario}`, async () => {
    const { state, disk, restore } = memoryDatabaseForReconnect();
    const noLocks = replaceGlobals({ navigator: {} });
    const captured = signal(),
      resume = signal();
    try {
      const key = "overlapping-archive";
      const local = new BrowserDocumentRepository(key);
      const doc = design([layer("frame", "board", "Board")]);
      await local.save(doc);
      const repo = new IndexedDbProjectMemoryRepository();
      const ep = buildManualEpisodeFromSelection({
        document: doc,
        selectionIds: ["board"],
        sourceFileKey: key,
        scopeProjectId: fileScopeId(key),
        sourceLifetimeToken: local.getLifetimeToken(),
      });
      const prior = Array.from(
        { length: scenario === "isolated eviction" ? 100 : 0 },
        (_, i) =>
          episode("existing-" + i, {
            sourceFileKey: key,
            scopeProjectId: fileScopeId(key),
            sourceLifetimeToken: local.getLifetimeToken(),
            createdAt: "2020-01-01T00:00:00.000Z",
          }),
      );
      if (prior.length)
        disk.set("episodes", new Map(prior.map((row) => [row.id, row])));
      if (scenario === "isolated replay")
        await repo.saveEpisode({ ...ep, pinned: true });
      let writer = local;
      if (scenario !== "shared guard") {
        const url = new URL(
          "../src/infrastructure/storage.ts",
          import.meta.url,
        );
        url.searchParams.set("tab", crypto.randomUUID());
        const remote = (await import(
          url.href
        )) as typeof import("../src/infrastructure/storage");
        assert.notEqual(
          remote.BrowserDocumentRepository,
          BrowserDocumentRepository,
        );
        writer = new remote.BrowserDocumentRepository(key);
        await writer.load();
      }
      // Pause precisely after the pre-commit live identity snapshot was read.
      let first = true;
      registerLiveFileStateReader(async (fileKey) => {
        const read = await readLiveFileState(fileKey);
        if (first && fileKey === key) {
          first = false;
          captured.resolve();
          await resume.promise;
        }
        return read;
      });
      const archiving = repo.saveEpisodeWithReceipt(ep);
      await Promise.race([
        captured.promise,
        archiving.then(() => {
          throw Error("missing live check");
        }),
      ]);
      // Abort just the replacement's standalone memory activation.
      state.abortTransaction = (stores, puts) => {
        if (
          stores.length !== 1 ||
          stores[0] !== "tombstones" ||
          !puts.includes(key)
        )
          return false;
        state.abortTransaction = () => false;
        return true;
      };
      const saving = writer.save({ ...doc, id: "new-doc" });
      if (scenario === "shared guard") {
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal((await readLiveFileState(key))?.generation, 1);
        resume.resolve();
        assert.equal((await archiving).durable, true);
        await saving;
      } else {
        await saving;
        assert.equal((await readLiveFileState(key))?.generation, 2);
        assert.equal(
          (disk.get("tombstones")!.get(key) as { activeDocId: string })
            .activeDocId,
          doc.id,
        );
        resume.resolve();
        await assert.rejects(
          archiving,
          /该设计文件已替换为新版本，旧版历史档案未写入/,
        );
        assert.equal(
          (disk.get("tombstones")!.get(key) as { activeDocId: string })
            .activeDocId,
          "new-doc",
        );
      }
      assert.equal((await readLiveFileState(key))?.docId, "new-doc");
      const rows = await new IndexedDbProjectMemoryRepository().listEpisodes(
        fileScopeId(key),
      );
      if (scenario === "isolated eviction")
        assert.deepEqual(
          rows.map((row) => row.id).sort(),
          prior.map((row) => row.id).sort(),
        );
      else assert.equal(rows.length, scenario === "isolated insert" ? 0 : 1);
      if (scenario === "isolated replay") assert.equal(rows[0].pinned, true);
    } finally {
      resume.resolve();
      registerLiveFileStateReader(readLiveFileState);
      noLocks();
      restore();
    }
  });
}

test("a 401-node board keeps distinct legacy and modern fill revisions without a thumbnail", async () => {
  const { disk, restore } = memoryDatabaseForReconnect();
  try {
    const key = "dense-board",
      file = new BrowserDocumentRepository(key);
    const doc = design([
      layer("frame", "board", "Board"),
      ...Array.from({ length: 400 }, (_, i) =>
        layer("rectangle", "rect-" + i, "Rectangle", "board"),
      ),
    ]);
    const capture = (document: DesignDocument) =>
      buildManualEpisodeFromSelection({
        document,
        selectionIds: ["board"],
        sourceFileKey: key,
        scopeProjectId: fileScopeId(key),
        sourceLifetimeToken: file.getLifetimeToken(),
      });
    await file.save(doc);
    const branchA = structuredClone(doc);
    branchA.revision++;
    branchA.nodes[1].style.fill = "#aa1155";
    await file.save(branchA);
    const first = capture(branchA);
    const legacy = { ...first, pinned: true };
    delete legacy.snapshotKey;
    disk.set("episodes", new Map([[legacy.id, legacy]]));

    const branchB = (await file.recovery())!;
    assert.equal(branchB.revision, 1);
    await file.save(branchB);
    branchB.nodes[1].style.fill = "#11aaff";
    branchB.revision++;
    await file.save(branchB);
    const second = capture(branchB);
    assert.equal(branchA.revision, branchB.revision);
    assert.equal(first.id, second.id);
    assert.notEqual(first.snapshotKey, second.snapshotKey);
    assert.deepEqual(first.screens, second.screens);
    assert.equal(second.screens[0].nodeCount, 401);
    assert.equal(first.thumbnailSvg, undefined);
    assert.equal(second.thumbnailSvg, undefined);
    const repo = new IndexedDbProjectMemoryRepository();
    const saved = await repo.saveEpisodeWithReceipt(second);
    assert.equal(saved.durable, true);
    assert.notEqual(saved.episode.id, legacy.id);
    assert.equal(saved.episode.snapshotKey, second.snapshotKey);
    assert.deepEqual(await repo.saveEpisodeWithReceipt(second), saved);
    assert.deepEqual(
      await new IndexedDbProjectMemoryRepository().listEpisodes(
        fileScopeId(key),
      ),
      [legacy, saved.episode],
    );
    assert.deepEqual(disk.get("episodes")!.get(legacy.id), legacy);
  } finally {
    restore();
  }
});

for (const before of ["private", "project"] as const) {
  test(`a session archive in ${before} history retires when the durable assignment changes`, async () => {
    const { state, restore, closeMemory, closeStudio, disk } =
      memoryDatabaseForReconnect();
    try {
      const key = "outage-move",
        file = new BrowserDocumentRepository(key);
      await file.save(design([]));
      const online = new IndexedDbProjectMemoryRepository();
      const project = await online.createProject({ name: "Shared" });
      if (before === "project")
        await online.assignFileToProject(key, project.id);
      closeMemory();
      closeStudio();
      state.denials = Infinity;
      state.studioDenied = true;
      const offline = new IndexedDbProjectMemoryRepository();
      const ep = episode("offline-before-move", {
        sourceFileKey: key,
        sourceLifetimeToken: file.getLifetimeToken(),
        scopeProjectId:
          before === "private" ? fileScopeId(key) : projectScopeId(project.id),
      });
      assert.deepEqual(await offline.saveEpisodeWithReceipt(ep), {
        episode: ep,
        durable: false,
      });
      state.denials = 0;
      state.studioDenied = false;
      await online.assignFileToProject(
        key,
        before === "private" ? project.id : null,
      );
      assert.deepEqual(await offline.listEpisodes(ep.scopeProjectId), []);
      assert.equal(await offline.isDurable(), true);
      assert.ok(!disk.get("episodes")?.has(ep.id));
    } finally {
      restore();
    }
  });
}

for (const concurrent of [false, true]) {
  test(`recovering a corrupt generation binds its lifetime and generation (concurrent update: ${concurrent})`, async () => {
    const { documents, restore } = memoryDatabaseForReconnect();
    try {
      const key = "corrupt-snapshot",
        original = new BrowserDocumentRepository(key);
      const first = design([layer("frame", "original", "Original")]);
      await original.save(first);
      await original.save({ ...first, revision: 2 });
      const token = original.getLifetimeToken();
      const old = documents.get(key) as {
        generation: number;
        lifetimeToken: string;
        current: unknown;
      };
      assert.equal(old.generation, 2);
      documents.set(key, { ...old, current: { id: "broken", nodes: false } });
      const fresh = new BrowserDocumentRepository(key);
      await assert.rejects(fresh.load());
      const recovered = await fresh.recovery();
      assert.equal(recovered?.revision, 1);
      if (concurrent) {
        await original.save({
          ...first,
          revision: 3,
          name: "Concurrent version",
        });
        await assert.rejects(fresh.save(recovered!), /另一个标签页更新/);
      } else {
        await fresh.save(recovered!);
        assert.equal(fresh.getLifetimeToken(), token);
      }
      assert.equal((await readLiveFileState(key))?.generation, 3);
      assert.equal(await getLocalFileLifetimeToken(key), token);
      const reopened = await new BrowserDocumentRepository(key).load();
      assert.equal(reopened?.revision, concurrent ? 3 : first.revision);
      assert.equal(
        reopened?.name,
        concurrent ? "Concurrent version" : first.name,
      );
    } finally {
      restore();
    }
  });
}

test("migration backfills a pinned legacy draft with the studio token after activation failed", async () => {
  const { state, disk, restore } = memoryDatabaseForReconnect();
  try {
    const key = "missing-activation",
      file = new BrowserDocumentRepository(key);
    const doc = checkoutDesign();
    state.abortWrites = true;
    await file.save(doc);
    state.abortWrites = false;
    const token = file.getLifetimeToken();
    assert.ok(token);
    assert.ok(!disk.get("tombstones")?.has(key));
    const input = {
      ...archive,
      document: doc,
      selectionIds: ["main"],
      sourceFileKey: key,
      scopeProjectId: fileScopeId(key),
    };
    const legacy = { ...buildManualEpisodeFromSelection(input), pinned: true };
    delete legacy.snapshotKey;
    disk.set("episodes", new Map([[legacy.id, legacy]]));
    const repo = new IndexedDbProjectMemoryRepository();
    const p = await repo.createProject({ name: "Recovered" });
    assert.equal(
      (
        await repo.assignFileToProject(key, p.id, {
          expectedLifetimeToken: token,
        })
      ).migratedEpisodes,
      1,
    );
    const scope = projectScopeId(p.id);
    const [migrated] = await repo.listEpisodes(scope);
    assert.equal(migrated.sourceLifetimeToken, token);
    assert.equal(migrated.snapshotKey, legacy.id);
    assert.equal(
      (disk.get("tombstones")!.get(key) as { activeLifetimeToken: string })
        .activeLifetimeToken,
      token,
    );
    assert.equal(migrated.pinned, true);
    const current = buildManualEpisodeFromSelection({
      ...input,
      scopeProjectId: scope,
      sourceLifetimeToken: token,
    });
    const replay = await repo.saveEpisodeWithReceipt(current);
    assert.equal(replay.durable, true);
    assert.notEqual(replay.episode.id, legacy.id);
    assert.match(replay.episode.snapshotKey!, /^v2:[^:]+$/);
    assert.equal(replay.episode.pinned, undefined);
    assert.deepEqual(await repo.saveEpisodeWithReceipt(current), replay);
    assert.deepEqual(
      await new IndexedDbProjectMemoryRepository().listEpisodes(scope),
      [migrated, replay.episode],
    );
  } finally {
    restore();
  }
});

test("a peer without Web Locks recognizes a live writer and an expired writer cannot commit after reconciliation", async () => {
  const { catalogState, connect, disk, restore } = memoryDatabaseForReconnect();
  const noLocks = replaceGlobals({ navigator: {} });
  const paused = signal(),
    resume = signal();
  const time = Date.now(),
    clock = mock.method(Date, "now", () => time);
  let move: Promise<unknown> | undefined;
  try {
    const key = "suspended-writer",
      repo = connect();
    await new BrowserDocumentRepository(key).save(design([]));
    const project = await repo.createProject({ name: "Target" });
    const url = new URL(
      "../src/infrastructure/library-catalog-store.ts",
      import.meta.url,
    );
    url.searchParams.set("tab", crypto.randomUUID());
    const peer = (await import(
      url.href
    )) as typeof import("../src/infrastructure/library-catalog-store");
    const before = await peer.readWorkspaceScopeFence(key);
    catalogState.delayCompletion = (stores, puts) => {
      if (stores.includes("fences") && puts.includes("file:" + key)) {
        catalogState.delayCompletion = () => undefined;
        paused.resolve();
        return resume.promise;
      }
    };
    move = repo.assignFileToProject(key, project.id);
    await Promise.race([paused.promise, move]);
    await assert.rejects(peer.readWorkspaceScopeFence(key), /正在变更/);
    clock.mock.mockImplementation(() => time + 16_001);
    const healed = await peer.readWorkspaceScopeFence(key);
    assert.equal(healed.fileEpoch, before.fileEpoch + 2);
    resume.resolve();
    await assert.rejects(move, /已过期/);
    assert.equal(await repo.getFileProject(key), null);
    assert.equal(
      (
        disk.get("tombstones")!.get("__forma_completed_fence_ops__") as {
          opIds?: string[];
        }
      )?.opIds?.length ?? 0,
      0,
    );
  } finally {
    resume.resolve();
    await move?.catch(() => {});
    clock.mock.restore();
    noLocks();
    restore();
  }
});

test("committed fence receipts keep the latest 256 operations for move, project deletion and file cleanup", async () => {
  const { connect, restore, disk } = memoryDatabaseForReconnect();
  try {
    const repo = connect(),
      key = "receipt-ring",
      project = await repo.createProject({ name: "Old" });
    const oldIds = Array.from({ length: 256 }, (_, i) => "completed-" + i);
    const id = "__forma_completed_fence_ops__";
    disk.set("tombstones", new Map([[id, { fileKey: id, opIds: oldIds }]]));
    await repo.assignFileToProject(key, project.id);
    await repo.deleteProject(project.id);
    await repo.removeFileState(key);
    const receipts = (disk.get("tombstones")!.get(id) as { opIds: string[] })
      .opIds;
    assert.deepEqual(receipts.slice(0, 253), oldIds.slice(3));
    assert.equal(receipts.length, 256);
    assert.equal(new Set(receipts).size, 256);
  } finally {
    restore();
  }
});

test("modern board identity survives save and reopen and distinguishes a fill edit at the same document revision", async () => {
  const { restore } = memoryDatabaseForReconnect();
  try {
    const key = "board-reopen",
      file = new BrowserDocumentRepository(key);
    const board = layer("frame", "board", "Board"),
      child = layer("rectangle", "rect", "Rectangle", board.id);
    const doc = design([board, child]);
    await file.save(doc);
    const capture = (document: DesignDocument) =>
      buildManualEpisodeFromSelection({
        document,
        selectionIds: [board.id],
        scopeProjectId: fileScopeId(key),
        sourceFileKey: key,
        sourceLifetimeToken: file.getLifetimeToken(),
      });
    const first = capture(doc);
    const reopened = (await new BrowserDocumentRepository(key).load())!;
    assert.equal(capture(reopened).snapshotKey, first.snapshotKey);
    const repo = new IndexedDbProjectMemoryRepository();
    await repo.saveEpisode({ ...first, pinned: true });
    assert.equal((await repo.saveEpisode(capture(reopened))).pinned, true);
    reopened.nodes[1].style.fill = "#934566";
    const changed = capture(reopened);
    assert.equal(changed.id, first.id);
    assert.notEqual(changed.snapshotKey, first.snapshotKey);
    const second = await repo.saveEpisode(changed);
    assert.notEqual(second.id, first.id);
    assert.equal((await repo.listEpisodes(fileScopeId(key))).length, 2);
  } finally {
    restore();
  }
});

test("a second repository sees all 100 original rows until the staged archive passes the final document read", async () => {
  const { disk, restore } = memoryDatabaseForReconnect();
  const paused = signal(),
    resume = signal();
  let saving:
    | ReturnType<IndexedDbProjectMemoryRepository["saveEpisodeWithReceipt"]>
    | undefined;
  try {
    const key = source.sourceFileKey;
    const file = new BrowserDocumentRepository(key);
    await file.save(design([]));
    const original = Array.from({ length: 100 }, (_, i) =>
      episode("old-" + i, {
        createdAt: new Date(i * 1000).toISOString(),
      }),
    );
    disk.set("episodes", new Map(original.map((ep) => [ep.id, ep])));
    const incoming = episode("staged", {
      sourceLifetimeToken: file.getLifetimeToken(),
    });
    let reads = 0;
    registerLiveFileStateReader(async (key) => {
      if (++reads === 2) {
        paused.resolve();
        await resume.promise;
      }
      return readLiveFileState(key);
    });
    saving = new IndexedDbProjectMemoryRepository().saveEpisodeWithReceipt(
      incoming,
    );
    await Promise.race([
      paused.promise,
      saving.then(() => assert.fail("post-stage identity read did not pause")),
    ]);
    const stages = () =>
      [...disk.get("tombstones")!.keys()].filter((key) =>
        key.startsWith("__forma_staged_ep__:"),
      );
    assert.equal(stages().length, 1);
    const peer = new IndexedDbProjectMemoryRepository();
    assert.deepEqual(
      (await peer.listEpisodes(scope, { requireDurable: true }))
        .map((ep) => ep.id)
        .sort(),
      original.map((ep) => ep.id).sort(),
    );
    assert.equal(await peer.getEpisode(incoming.id), null);
    resume.resolve();
    assert.equal((await saving).durable, true);
    const published = await peer.listEpisodes(scope);
    assert.equal(published.length, 100);
    assert.deepEqual(published[0], incoming);
    assert.ok(!published.some((ep) => ep.id === original[0].id));
    assert.deepEqual(stages(), []);
  } finally {
    resume.resolve();
    await saving?.catch(() => {});
    registerLiveFileStateReader(readLiveFileState);
    restore();
  }
});

for (const interrupt of ["before staging", "after staging"] as const) {
  test(`a failed document read ${interrupt} returns a session receipt and preserves it through a failed replay`, async () => {
    const { disk, restore } = memoryDatabaseForReconnect();
    try {
      const file = new BrowserDocumentRepository(source.sourceFileKey);
      await file.save(design([]));
      const ep = episode("retryable-archive", {
        sourceLifetimeToken: file.getLifetimeToken(),
      });
      const repo = new IndexedDbProjectMemoryRepository();
      let reads = 0;
      const failAt = interrupt === "before staging" ? 1 : 2;
      registerLiveFileStateReader(async (key) => {
        if (++reads === failAt) return null;
        return readLiveFileState(key);
      });
      assert.deepEqual(await repo.saveEpisodeWithReceipt(ep), {
        episode: ep,
        durable: false,
      });
      const peer = new IndexedDbProjectMemoryRepository();
      assert.deepEqual(await peer.listEpisodes(scope), []);
      reads = 0;
      await assert.rejects(
        repo.listEpisodes(scope, { requireDurable: true }),
        isProjectMemoryUnavailableError,
      );
      assert.equal(reads, failAt);
      assert.deepEqual(await peer.listEpisodes(scope), []);
      assert.ok(
        ![...disk.get("tombstones")!.keys()].some((k) =>
          k.startsWith("__forma_staged_ep__:"),
        ),
      );
      registerLiveFileStateReader(readLiveFileState);
      assert.deepEqual(
        await repo.listEpisodes(scope, { requireDurable: true }),
        [ep],
      );
      assert.deepEqual(await peer.listEpisodes(scope), [ep]);
      assert.equal(await repo.isDurable(), true);
    } finally {
      registerLiveFileStateReader(readLiveFileState);
      restore();
    }
  });
}

test("cleanup retains the deletion intent across a failed live read and failed durable replacement activation", async () => {
  const { state, documents, disk, closeMemory, restore } =
    memoryDatabaseForReconnect();
  try {
    const key = "cleanup-replacement";
    const file = new BrowserDocumentRepository(key);
    await file.save(design([]));
    const marker = "__forma_internal_pending_memory_cleanups__";
    state.abortWrites = true;
    await deleteLocalFile(key);
    const replacement = new BrowserDocumentRepository(key);
    await replacement.save({ ...design([]), id: "replacement" });
    assert.notEqual(replacement.getLifetimeToken(), file.getLifetimeToken());
    state.abortWrites = false;
    state.studioLiveReadFailures = 1;
    await flushPendingFileMemoryCleanups();
    const tombstone = () =>
      disk.get("tombstones")!.get(key) as {
        deletedAt?: string;
        activeLifetimeToken?: string;
        activeDocId?: string;
      };
    assert.equal(state.studioLiveReadFailures, 0);
    assert.ok(tombstone().deletedAt);
    assert.ok(documents.has(marker));
    state.abortTransaction = (stores, puts) =>
      stores.length === 1 && stores[0] === "tombstones" && puts.includes(key);
    await flushPendingFileMemoryCleanups();
    assert.ok(documents.has(marker));
    assert.ok(tombstone().deletedAt);
    state.abortTransaction = () => false;
    // Deny only activation's open after the deletion tombstone has committed.
    // A session-only activation would otherwise let cleanup erase the intent.
    const prototype = IndexedDbProjectMemoryRepository.prototype;
    const activate = prototype.clearFileTombstone;
    const denial = mock.method(
      prototype,
      "clearFileTombstone",
      function (
        this: IndexedDbProjectMemoryRepository,
        ...args: Parameters<typeof activate>
      ) {
        closeMemory();
        state.denials = 1;
        return activate.apply(this, args);
      },
    );
    try {
      await flushPendingFileMemoryCleanups();
      assert.equal(denial.mock.callCount(), 1);
      assert.ok(documents.has(marker));
      assert.ok(tombstone().deletedAt);
    } finally {
      denial.mock.restore();
    }
    await flushPendingFileMemoryCleanups();
    assert.ok(!documents.has(marker));
    assert.equal(tombstone().deletedAt, undefined);
    assert.equal(tombstone().activeDocId, "replacement");
    assert.equal(
      tombstone().activeLifetimeToken,
      replacement.getLifetimeToken(),
    );
    assert.equal(
      await getFileProjectSpace(key, {
        requireDurable: true,
        expectedLifetimeToken: replacement.getLifetimeToken(),
        expectedDocId: "replacement",
      }),
      null,
    );
  } finally {
    restore();
  }
});

test("restore rejects generation 4 when the current snapshot failed at generation 2 before the backup was read", async () => {
  const { documents, restore } = memoryDatabaseForReconnect();
  try {
    const key = "corrupt-before-restore",
      writer = new BrowserDocumentRepository(key);
    const first = design([]);
    await writer.save(first);
    await writer.save({ ...first, revision: 2 });
    documents.set(key, {
      ...(documents.get(key) as object),
      current: { id: first.id, nodes: false },
    });
    const stale = new BrowserDocumentRepository(key);
    await assert.rejects(stale.load());
    await writer.save({ ...first, revision: 3, name: "Healthy 3" });
    await writer.save({ ...first, revision: 4, name: "Healthy 4" });
    await assert.rejects(stale.recovery(), {
      message: "此文件已在另一个标签页更新，请刷新页面打开最新版本",
    });
    await assert.rejects(stale.save(first));
    assert.equal((await readLiveFileState(key))?.generation, 4);
    assert.equal(
      (await new BrowserDocumentRepository(key).load())?.name,
      "Healthy 4",
    );
  } finally {
    restore();
  }
});

test("a missing current snapshot protects its backup until an explicit recovery is saved", async () => {
  const { documents, restore } = memoryDatabaseForReconnect();
  try {
    const key = "missing-current",
      file = new BrowserDocumentRepository(key);
    const first = design([layer("frame", "backup", "Last readable board")]);
    await file.save(first);
    await file.save({ ...first, revision: 2 });
    const raw = documents.get(key) as { previous: unknown };
    documents.set(key, { ...raw, current: null });
    const reader = new BrowserDocumentRepository(key);
    await assert.rejects(reader.load(), {
      message: "当前设计快照缺失，请从文件菜单恢复上个版本",
    });
    await assert.rejects(reader.save(design([])));
    const backup = await reader.recovery();
    assert.equal(backup?.nodes[0].name, "Last readable board");
    await reader.save(backup!);
    assert.equal((await readLiveFileState(key))?.generation, 3);
    assert.deepEqual(
      (documents.get(key) as { previous: unknown }).previous,
      raw.previous,
    );
    assert.deepEqual(await new BrowserDocumentRepository(key).load(), backup);
    assert.equal(reader.getLifetimeToken(), file.getLifetimeToken());
  } finally {
    restore();
  }
});

test("restoring revision 1 and editing its fill preserves both revision-2 captures and their different previews", async () => {
  const { disk, restore } = memoryDatabaseForReconnect();
  try {
    const key = "legacy-revision-branch",
      file = new BrowserDocumentRepository(key);
    const board = layer("frame", "board", "Board");
    const first = design([
      board,
      layer("rectangle", "rect", "Rectangle", board.id),
    ]);
    await file.save(first);
    const withFill = (base: DesignDocument, fill: string) => {
      const next = structuredClone(base);
      next.revision++;
      next.nodes[1].style.fill = fill;
      return next;
    };
    const capture = (document: DesignDocument) =>
      buildManualEpisodeFromSelection({
        document,
        selectionIds: [board.id],
        sourceFileKey: key,
        scopeProjectId: fileScopeId(key),
        sourceLifetimeToken: file.getLifetimeToken(),
      });
    const branchA = withFill(first, "#aa1155");
    await file.save(branchA);
    const legacy = capture(branchA);
    delete legacy.snapshotKey;
    disk.set("episodes", new Map([[legacy.id, legacy]]));
    const recovered = await file.recovery();
    assert.equal(recovered?.revision, 1);
    await file.save(recovered!);
    const branchB = withFill(recovered!, "#11aaff");
    await file.save(branchB);
    assert.equal(branchA.revision, branchB.revision);
    const incoming = capture(branchB);
    assert.equal(incoming.id, legacy.id);
    assert.ok(legacy.thumbnailSvg && incoming.thumbnailSvg);
    assert.notEqual(incoming.thumbnailSvg, legacy.thumbnailSvg);
    const repo = new IndexedDbProjectMemoryRepository();
    const receipt = await repo.saveEpisodeWithReceipt(incoming);
    assert.equal(receipt.durable, true);
    assert.notEqual(receipt.episode.id, legacy.id);
    assert.deepEqual(await repo.saveEpisode(incoming), receipt.episode);
    const rows = await new IndexedDbProjectMemoryRepository().listEpisodes(
      fileScopeId(key),
    );
    assert.deepEqual(
      rows.map((row) => row.thumbnailSvg).sort(),
      [legacy.thumbnailSvg, incoming.thumbnailSvg].sort(),
    );
    assert.equal(
      rows.find((row) => row.id === legacy.id)?.snapshotKey,
      undefined,
    );
  } finally {
    restore();
  }
});

for (const outage of [false, true]) {
  test(`replacing doc-1 with doc-2 invalidates a same-lifetime publisher (catalog outage: ${outage})`, async () => {
    const { catalogState, catalogTransactions, documents, disk, restore } =
      memoryDatabaseForReconnect();
    try {
      const key = "import-publisher",
        file = new BrowserDocumentRepository(key);
      await file.save({ ...design([]), id: "doc-1" });
      const repo = new IndexedDbProjectMemoryRepository(),
        project = await repo.createProject({ name: "Workspace" });
      await repo.assignFileToProject(key, project.id);
      const token = file.getLifetimeToken();
      const fence = await readWorkspaceScopeFence(key, project.id, "doc-1");
      assert.equal(fence.expectedDocId, "doc-1");
      catalogState.abortWrites = outage;
      await file.save({ ...design([]), id: "doc-2" });
      assert.equal(file.getLifetimeToken(), token);
      const marker = "__forma_internal_pending_file_fences__";
      assert.equal(documents.has(marker), outage);
      assert.equal(
        (await repo.getFileProject(key, { expectedDocId: "doc-2" }))?.id,
        project.id,
      );
      await assert.rejects(
        repo.getFileProject(key, {
          expectedDocId: "doc-1",
          expectedLifetimeToken: token,
          requireDurable: true,
        }),
        isFileLifetimeMismatchError,
      );
      // Either database can independently prove that the captured ID is stale.
      registerLiveFileStateReader(async () => null);
      await assert.rejects(
        repo.getFileProject(key, { expectedDocId: "doc-1" }),
        isFileLifetimeMismatchError,
      );
      registerLiveFileStateReader(readLiveFileState);
      const tombstones = disk.get("tombstones")!;
      const current = tombstones.get(key)!;
      tombstones.delete(key);
      await assert.rejects(
        repo.getFileProject(key, { expectedDocId: "doc-1" }),
        isFileLifetimeMismatchError,
      );
      tombstones.set(key, current);
      catalogState.abortWrites = false;
      const library = {
        ...checkoutDesign().libraries!.mobile,
        id: "stale-import",
      };
      await assert.rejects(
        saveWorkspaceLibraryIfUnchanged(library, "packaged", null, {
          expectedFence: fence,
        }),
        { message: "所属项目空间或源文件状态已变更，请刷新后重试" },
      );
      assert.ok(
        !catalogTransactions.some((tx) => tx.puts.includes(library.id)),
      );
      assert.ok(!documents.has(marker));
      const fresh = await readWorkspaceScopeFence(key, project.id, "doc-2");
      assert.ok(fresh.fileEpoch > fence.fileEpoch);
      assert.equal(fresh.projectEpoch, fence.projectEpoch);
      assert.equal(
        (
          await saveWorkspaceLibraryIfUnchanged(library, "packaged", null, {
            expectedFence: fresh,
          })
        ).id,
        library.id,
      );
    } finally {
      registerLiveFileStateReader(readLiveFileState);
      restore();
    }
  });
}

test("durable listScopeEpisodes rejects an open denial and a dependent journal before returning the committed scope", async () => {
  const { state, closeMemory, restore } = memoryDatabaseForReconnect();
  try {
    const file = new BrowserDocumentRepository(source.sourceFileKey);
    await file.save(design([]));
    const ep = episode("recall-after-outage", {
      sourceLifetimeToken: file.getLifetimeToken(),
    });
    closeMemory();
    state.denials = Infinity;
    assert.equal((await saveDesignEpisodeWithReceipt(ep)).durable, false);
    assert.deepEqual(await listScopeEpisodes(scope), [ep]);
    await assert.rejects(
      listScopeEpisodes(scope, { requireDurable: true }),
      isProjectMemoryUnavailableError,
    );
    state.denials = 0;
    state.abortWrites = true;
    await assert.rejects(
      listScopeEpisodes(scope, { requireDurable: true }),
      isProjectMemoryUnavailableError,
    );
    state.abortWrites = false;
    assert.deepEqual(await listScopeEpisodes(scope, { requireDurable: true }), [
      ep,
    ]);
    await new IndexedDbProjectMemoryRepository().deleteEpisode(ep.id);
    assert.deepEqual(
      await listScopeEpisodes(scope, { requireDurable: true }),
      [],
    );
  } finally {
    restore();
  }
});

test("reopening discards an expired archive stage without publishing it", async () => {
  const { disk, restore } = memoryDatabaseForReconnect();
  const paused = signal(),
    resume = signal();
  const start = Date.now(),
    clock = mock.method(Date, "now", () => start);
  let saving: Promise<unknown> | undefined;
  try {
    const file = new BrowserDocumentRepository(source.sourceFileKey);
    await file.save(design([]));
    const ep = episode("abandoned-stage", {
      sourceLifetimeToken: file.getLifetimeToken(),
    });
    const repo = new IndexedDbProjectMemoryRepository();
    let reads = 0;
    registerLiveFileStateReader(async (key) => {
      if (++reads === 2) {
        paused.resolve();
        await resume.promise;
      }
      return readLiveFileState(key);
    });
    saving = repo.saveEpisodeWithReceipt(ep);
    await Promise.race([
      paused.promise,
      saving.then(() => assert.fail("expected durable stage")),
    ]);
    const stages = () =>
      [...disk.get("tombstones")!.keys()].filter((key) =>
        key.startsWith("__forma_staged_ep__:"),
      );
    assert.equal(stages().length, 1);
    const commitId = stages()[0].slice("__forma_staged_ep__:".length);
    clock.mock.mockImplementation(() => start + 61_000);
    const peer = new IndexedDbProjectMemoryRepository();
    assert.deepEqual(
      await peer.listEpisodes(scope, { requireDurable: true }),
      [],
    );
    assert.deepEqual(stages(), []);
    resume.resolve();
    assert.deepEqual(await saving, { episode: ep, durable: false });
    assert.equal(await isFileCommitAuthorized(commitId), "missing");
    assert.deepEqual(await peer.listEpisodes(scope), []);
    assert.deepEqual(await repo.listEpisodes(scope, { requireDurable: true }), [
      ep,
    ]);
  } finally {
    resume.resolve();
    await saving?.catch(() => {});
    registerLiveFileStateReader(readLiveFileState);
    clock.mock.restore();
    restore();
  }
});

test("aborting the verified publish transaction preserves every original episode at the scope limit", async () => {
  const { disk, state, restore } = memoryDatabaseForReconnect();
  try {
    const file = new BrowserDocumentRepository(source.sourceFileKey);
    await file.save(design([]));
    const original = Array.from({ length: 100 }, (_, i) =>
      episode("existing-" + i, { createdAt: new Date(i * 1000).toISOString() }),
    );
    disk.set("episodes", new Map(original.map((ep) => [ep.id, ep])));
    const next = episode("abort-publish", {
      sourceLifetimeToken: file.getLifetimeToken(),
    });
    let attempted = false;
    state.abortTransaction = (stores, puts) => {
      if (!puts.includes(next.id)) return false;
      assert.deepEqual([...stores].sort(), [
        "assignments",
        "episodes",
        "projects",
        "tombstones",
      ]);
      attempted = true;
      return true;
    };
    const repo = new IndexedDbProjectMemoryRepository();
    await assert.rejects(repo.saveEpisodeWithReceipt(next), /commit failed/);
    assert.equal(attempted, true);
    assert.deepEqual(
      [...disk.get("episodes")!.keys()].sort(),
      original.map((ep) => ep.id).sort(),
    );
    assert.ok(
      [...disk.get("tombstones")!.keys()].some((key) =>
        key.startsWith("__forma_staged_ep__:ep-"),
      ),
    );
    const peer = new IndexedDbProjectMemoryRepository();
    await assert.rejects(
      peer.listEpisodes(scope, { requireDurable: true }),
      /commit failed/,
    );
    state.abortTransaction = () => false;
    const recovered = await peer.listEpisodes(scope, { requireDurable: true });
    assert.equal(recovered.length, 100);
    assert.deepEqual(recovered[0], next);
    assert.ok(!recovered.some((ep) => ep.id === original[0].id));
  } finally {
    restore();
  }
});

test("a publisher cannot capture or commit a fence while the source database is unavailable", async () => {
  const { catalogTransactions, state, closeStudio, restore } =
    memoryDatabaseForReconnect();
  try {
    const key = "guard-offline",
      file = new BrowserDocumentRepository(key);
    await file.save(design([]));
    const fence = await readWorkspaceScopeFence(key, null, "doc-a");
    const library = {
      ...checkoutDesign().libraries!.mobile,
      id: "offline-guard",
    };
    closeStudio();
    state.studioDenied = true;
    const changed = { message: "所属项目空间或源文件状态已变更，请刷新后重试" };
    await assert.rejects(readWorkspaceScopeFence(key, null, "doc-a"), changed);
    await assert.rejects(
      saveWorkspaceLibraryIfUnchanged(library, "packaged", null, {
        expectedFence: fence,
      }),
      changed,
    );
    assert.ok(!catalogTransactions.some((tx) => tx.puts.includes(library.id)));
    state.studioDenied = false;
    assert.equal(
      (
        await saveWorkspaceLibraryIfUnchanged(library, "packaged", null, {
          expectedFence: fence,
        })
      ).id,
      library.id,
    );
    await flushPendingFileMemoryCleanups();
  } finally {
    restore();
  }
});

const commitPrefix = "__forma_internal_commit__:";

test("file commit authorization serializes source identity and retains each reserved decision until acknowledged", async () => {
  const { documents, state, closeStudio, restore } =
    memoryDatabaseForReconnect();
  try {
    const key = "commit-source",
      file = new BrowserDocumentRepository(key);
    await file.save(design([]));
    const input = {
      fileKey: key,
      expectedLifetimeToken: file.getLifetimeToken(),
      expectedDocId: "doc-a",
    };
    documents.set("__forma_internal_committed_ops__", ["pre-upgrade-grant"]);
    closeStudio();
    assert.equal(
      await isFileCommitAuthorized("pre-upgrade-grant"),
      "authorized",
    );
    assert.equal(documents.has("__forma_internal_committed_ops__"), false);
    await acknowledgeFileCommit("pre-upgrade-grant");
    const rejected = async (patch: Partial<typeof input>) => {
      const commitId = crypto.randomUUID();
      assert.equal(
        await authorizeFileCommit({ ...input, ...patch, commitId }),
        "rejected",
      );
      assert.equal(await isFileCommitAuthorized(commitId), "missing");
    };
    await rejected({ fileKey: "missing" });
    await rejected({ expectedLifetimeToken: "former-token" });
    await rejected({ expectedDocId: "former-doc" });
    for (const [marker, intent] of [
      [
        "__forma_internal_pending_file_fences__",
        { fileKey: key, docId: "replacement" },
      ],
      ["__forma_internal_pending_memory_cleanups__", { fileKey: key }],
    ] as const) {
      documents.set(marker, [intent]);
      await rejected({});
      documents.delete(marker);
    }
    for (let i = 0; i < 257; i++)
      assert.equal(
        await authorizeFileCommit({ ...input, commitId: "op-" + i }),
        "authorized",
      );
    assert.equal(
      [...documents.keys()].filter((id) => id.startsWith(commitPrefix)).length,
      257,
    );
    assert.equal(await isFileCommitAuthorized("op-0"), "authorized");
    await acknowledgeFileCommit("op-0");
    assert.equal(await isFileCommitAuthorized("op-0"), "missing");
    assert.equal(await isFileCommitAuthorized("op-256"), "authorized");
    assert.throws(
      () => new BrowserDocumentRepository(commitPrefix + "op-256"),
      /保留/,
    );
    assert.deepEqual(
      (await recentFiles()).map((f) => f.key),
      [key],
    );
    closeStudio();
    state.studioDenied = true;
    assert.equal(await isFileCommitAuthorized("op-256"), "unavailable");
    assert.equal(
      await authorizeFileCommit({ ...input, commitId: "denied" }),
      "unavailable",
    );
  } finally {
    restore();
  }
});

async function isolatedDocumentTab() {
  const url = new URL("../src/infrastructure/storage.ts", import.meta.url);
  url.searchParams.set("tab", crypto.randomUUID());
  return (await import(
    url.href
  )) as typeof import("../src/infrastructure/storage");
}

for (const replay of [false, true]) {
  for (const authorized of [false, true]) {
    test(`archive ${replay ? "journal replay" : "save"} paused ${authorized ? "after" : "before"} studio authorization orders peer reads and eviction against replacement`, async () => {
      const { disk, state, restore, closeMemory } =
        memoryDatabaseForReconnect();
      const reset = replaceGlobals({ navigator: {} });
      const paused = signal(),
        resume = signal();
      let completing: Promise<unknown> | undefined;
      try {
        const key = source.sourceFileKey,
          file = new BrowserDocumentRepository(key);
        await file.save(design([]));
        const writer = new (
          await isolatedDocumentTab()
        ).BrowserDocumentRepository(key);
        await writer.load();
        const original = Array.from({ length: 100 }, (_, i) =>
          episode("old-" + i, { createdAt: new Date(i * 1000).toISOString() }),
        );
        disk.set("episodes", new Map(original.map((ep) => [ep.id, ep])));
        const archived = episode("committed-in-studio", {
          sourceLifetimeToken: file.getLifetimeToken(),
        });
        const repo = new IndexedDbProjectMemoryRepository();
        if (replay) {
          closeMemory();
          state.denials = 1;
          assert.deepEqual(await repo.saveEpisodeWithReceipt(archived), {
            episode: archived,
            durable: false,
          });
        }
        if (authorized) {
          state.afterStudioCommit = (keys) => {
            if (!keys.some((key) => key.startsWith(commitPrefix))) return;
            state.afterStudioCommit = () => undefined;
            paused.resolve();
            return resume.promise;
          };
        } else {
          let reads = 0;
          registerLiveFileStateReader(async (fileKey) => {
            const live = await readLiveFileState(fileKey);
            if (++reads === 2) {
              paused.resolve();
              await resume.promise;
            }
            return live;
          });
        }
        completing = replay
          ? repo.listEpisodes(scope, { requireDurable: true })
          : repo.saveEpisodeWithReceipt(archived);
        await Promise.race([
          paused.promise,
          completing.then(() => assert.fail("writer missed the pause")),
        ]);
        const stage = [...disk.get("tombstones")!.keys()].find((k) =>
          k.startsWith("__forma_staged_ep__:ep-"),
        );
        assert.ok(stage);
        assert.equal(
          await isFileCommitAuthorized(
            stage.slice("__forma_staged_ep__:".length),
          ),
          authorized ? "authorized" : "missing",
        );
        assert.deepEqual(
          [...disk.get("episodes")!.keys()],
          original.map((ep) => ep.id),
        );
        state.abortWrites = true;
        await writer.save({ ...design([]), id: "new-doc" });
        assert.equal((await readLiveFileState(key))?.docId, "new-doc");
        state.abortWrites = false;
        const peer = new IndexedDbProjectMemoryRepository();
        const beforeResume = await peer.listEpisodes(scope, {
          requireDurable: true,
        });
        const expected = authorized
          ? [...original.slice(1), archived]
          : original;
        assert.deepEqual(
          beforeResume.map((ep) => ep.id).sort(),
          expected.map((ep) => ep.id).sort(),
        );
        resume.resolve();
        if (replay) assert.deepEqual(await completing, beforeResume);
        else if (authorized)
          assert.deepEqual(await completing, {
            episode: archived,
            durable: true,
          });
        else await assert.rejects(completing, /已替换/);
        assert.deepEqual(
          await peer.listEpisodes(scope, { requireDurable: true }),
          beforeResume,
        );
        assert.ok(!disk.get("tombstones")!.has(stage));
      } finally {
        resume.resolve();
        await completing?.catch(() => {});
        registerLiveFileStateReader(readLiveFileState);
        reset();
        restore();
      }
    });
  }
}

for (const change of ["delete", "replace", "replace back"] as const) {
  test(`a staged publication rejects a source ${change} committed while catalog writes and the publisher lease were unavailable`, async () => {
    const { catalog, catalogState, catalogTransactions, restore } =
      memoryDatabaseForReconnect();
    const reset = replaceGlobals({ navigator: {} });
    const start = Date.now(),
      clock = mock.method(Date, "now", () => start);
    const paused = signal(),
      resume = signal();
    let publishing: Promise<unknown> | undefined;
    try {
      const key = "publish-before-" + change,
        file = new BrowserDocumentRepository(key);
      await file.save(design([]));
      const fence = await readWorkspaceScopeFence(key, null, "doc-a");
      const library = {
        ...checkoutDesign().libraries!.mobile,
        id: key + "-lib",
      };
      catalogState.delayCompletion = (_stores, puts) => {
        if (puts.some((k) => k.startsWith("__staged_lib__:cat-"))) {
          catalogState.delayCompletion = () => undefined;
          paused.resolve();
          return resume.promise;
        }
      };
      const remote = await isolatedMemoryTab();
      publishing = remote.withFileProjectScopeLock(key, () =>
        saveWorkspaceLibraryIfUnchanged(library, "packaged", null, {
          expectedFence: fence,
        }),
      );
      await Promise.race([
        paused.promise,
        publishing.then(() => assert.fail("never staged")),
      ]);
      clock.mock.mockImplementation(() => start + 16_001);
      catalogState.abortWrites = true;
      if (change === "delete") await deleteLocalFile(key);
      else {
        await file.save({ ...design([]), id: "imported" });
        if (change === "replace back") await file.save(design([]));
      }
      const expectedDoc = {
        delete: undefined,
        replace: "imported",
        "replace back": "doc-a",
      }[change];
      assert.equal((await readLiveFileState(key))?.docId, expectedDoc);
      catalogState.abortWrites = false;
      assert.equal(await getWorkspaceLibrary(library.id), null);
      assert.deepEqual(await listWorkspaceLibraries(), []);
      resume.resolve();
      await assert.rejects(publishing, {
        message: "所属项目空间或源文件状态已变更，请刷新后重试",
      });
      assert.ok(
        !catalogTransactions.some((tx) => tx.puts.includes(library.id)),
      );
      assert.ok(
        ![...catalog.get("fences")!.keys()].some((k) =>
          k.startsWith("__staged_lib__:"),
        ),
      );
    } finally {
      resume.resolve();
      await publishing?.catch(() => {});
      clock.mock.restore();
      reset();
      restore();
    }
  });
}

for (const reader of ["list", "get"] as const) {
  test(`catalog ${reader} completes a peer's authorized stage after a source deletion interrupted its fence update`, async () => {
    const { state, catalogState, catalogTransactions, restore } =
      memoryDatabaseForReconnect();
    const paused = signal(),
      resume = signal();
    let publishing:
      ReturnType<typeof saveWorkspaceLibraryIfUnchanged> | undefined;
    try {
      const key = "publish-after-" + reader,
        file = new BrowserDocumentRepository(key);
      await file.save(design([]));
      const fence = await readWorkspaceScopeFence(key, null, "doc-a");
      const library = {
        ...checkoutDesign().libraries!.mobile,
        id: key + "-lib",
      };
      state.afterStudioCommit = (keys) => {
        if (keys.some((key) => key.startsWith(commitPrefix))) {
          state.afterStudioCommit = () => undefined;
          paused.resolve();
          return resume.promise;
        }
      };
      publishing = saveWorkspaceLibraryIfUnchanged(library, "packaged", null, {
        expectedFence: fence,
      });
      await Promise.race([
        paused.promise,
        publishing.then(() => assert.fail("never authorized")),
      ]);
      assert.ok(
        !catalogTransactions.some((tx) => tx.puts.includes(library.id)),
      );
      catalogState.abortWrites = true;
      await deleteLocalFile(key);
      catalogState.abortWrites = false;
      assert.equal((await readLiveFileState(key))?.exists, false);
      const observed =
        reader === "list"
          ? (await listWorkspaceLibraries()).find(
              (lib) => lib.id === library.id,
            )
          : await getWorkspaceLibrary(library.id);
      assert.deepEqual(observed?.library, library);
      resume.resolve();
      assert.deepEqual(await publishing, observed);
      assert.equal(
        catalogTransactions.filter((tx) => tx.puts.includes(library.id)).length,
        1,
      );
    } finally {
      resume.resolve();
      await publishing?.catch(() => {});
      restore();
    }
  });
}

test("studio authorization unavailable after staging is retryable on archive save and journal replay", async () => {
  const { state, disk, restore } = memoryDatabaseForReconnect();
  try {
    const file = new BrowserDocumentRepository(source.sourceFileKey);
    await file.save(design([]));
    state.denyAuthorization = true;
    const repo = new IndexedDbProjectMemoryRepository();
    const ep = episode("deferred-decision", {
      sourceLifetimeToken: file.getLifetimeToken(),
    });
    assert.deepEqual(await repo.saveEpisodeWithReceipt(ep), {
      episode: ep,
      durable: false,
    });
    await assert.rejects(
      repo.listEpisodes(scope, { requireDurable: true }),
      isProjectMemoryUnavailableError,
    );
    assert.ok(
      ![...disk.get("tombstones")!.keys()].some((key) =>
        key.startsWith("__forma_staged_ep__:"),
      ),
    );
    assert.deepEqual(
      await new IndexedDbProjectMemoryRepository().listEpisodes(scope),
      [],
    );
    state.denyAuthorization = false;
    assert.deepEqual(await repo.listEpisodes(scope, { requireDurable: true }), [
      ep,
    ]);
    assert.deepEqual(
      await new IndexedDbProjectMemoryRepository().getEpisode(ep.id),
      ep,
    );
  } finally {
    restore();
  }
});

test("a failed studio open cannot authorize restoring generation 3 over healthy generation 4", async () => {
  const { state, closeStudio, restore } = memoryDatabaseForReconnect();
  try {
    const key = "initial-open-denied",
      writer = new BrowserDocumentRepository(key);
    const doc = design([]);
    await writer.save(doc);
    await writer.save({ ...doc, revision: 2 });
    closeStudio();
    state.studioDenied = true;
    const stale = new BrowserDocumentRepository(key);
    await assert.rejects(stale.load(), { name: "SecurityError" });
    state.studioDenied = false;
    const generation3 = { ...doc, revision: 3, name: "Healthy 3" };
    const generation4 = { ...doc, revision: 4, name: "Healthy 4" };
    await writer.save(generation3);
    await writer.save(generation4);
    await assert.rejects(stale.recovery(), {
      message: "原文件当前版本可读，请刷新页面打开最新版本",
    });
    await assert.rejects(stale.save(generation3));
    assert.equal((await readLiveFileState(key))?.generation, 4);
    assert.deepEqual(await stale.load(), generation4);
  } finally {
    restore();
  }
});

test("retry after failed open can recover a confirmed corrupt generation and preserves its readable backup", async () => {
  const { state, closeStudio, documents, restore } =
    memoryDatabaseForReconnect();
  try {
    const key = "failed-open-corrupt",
      writer = new BrowserDocumentRepository(key);
    const doc = design([]);
    await writer.save(doc);
    await writer.save({ ...doc, revision: 2 });
    closeStudio();
    state.studioDenied = true;
    const recovery = new BrowserDocumentRepository(key);
    await assert.rejects(recovery.load(), { name: "SecurityError" });
    state.studioDenied = false;
    documents.set(key, {
      ...(documents.get(key) as object),
      current: { id: doc.id, nodes: false },
    });
    const backup = await recovery.recovery();
    assert.deepEqual(backup, doc);
    await recovery.save(backup!);
    assert.equal((await readLiveFileState(key))?.generation, 3);
    assert.deepEqual(await recovery.load(), doc);
    assert.deepEqual(await recovery.recovery(), doc);
  } finally {
    restore();
  }
});

test("same-lifetime replacement rejects the old editor's scope, pin and delete on the new document's private episode", async () => {
  const { restore } = memoryDatabaseForReconnect();
  try {
    const key = "editor-guard",
      file = new BrowserDocumentRepository(key);
    await file.save(design([]));
    const token = file.getLifetimeToken();
    await file.save({ ...design([]), id: "doc-b" });
    assert.equal(file.getLifetimeToken(), token);
    const repo = new IndexedDbProjectMemoryRepository();
    const ep = await repo.saveEpisode(
      episode("only-in-b", {
        scopeProjectId: fileScopeId(key),
        sourceFileKey: key,
        sourceDocId: "doc-b",
        sourceLifetimeToken: token,
      }),
    );
    const guard = {
      sourceFileKey: key,
      expectedLifetimeToken: token,
      expectedDocId: "doc-a",
    };
    await assert.rejects(
      repo.getFileProject(key, guard),
      isFileLifetimeMismatchError,
    );
    await assert.rejects(
      repo.updateEpisode(ep.id, { pinned: true }, guard),
      isFileLifetimeMismatchError,
    );
    await assert.rejects(
      repo.deleteEpisode(ep.id, guard),
      isFileLifetimeMismatchError,
    );
    // A source read can precede the import. The transaction must independently
    // reject the observed B tombstone before it can touch the private row.
    registerLiveFileStateReader(async () => ({
      exists: true,
      docId: "doc-a",
      lifetimeToken: token,
    }));
    await assert.rejects(
      repo.getFileProject(key, guard),
      isFileLifetimeMismatchError,
    );
    await assert.rejects(
      repo.updateEpisode(ep.id, { pinned: true }, guard),
      isFileLifetimeMismatchError,
    );
    await assert.rejects(
      repo.deleteEpisode(ep.id, guard),
      isFileLifetimeMismatchError,
    );
    assert.deepEqual(
      await new IndexedDbProjectMemoryRepository().getEpisode(ep.id),
      ep,
    );
  } finally {
    registerLiveFileStateReader(readLiveFileState);
    restore();
  }
});

test("reconnected provisional ID rejects pin and delete when the selected snapshot moved to its own durable ID", async () => {
  const { state, restore } = memoryDatabaseForReconnect();
  try {
    const file = new BrowserDocumentRepository(source.sourceFileKey);
    await file.save(design([]));
    const repo = new IndexedDbProjectMemoryRepository(),
      offline = new IndexedDbProjectMemoryRepository();
    const provisional = "ep-snapshot-branch";
    const a = episode(provisional, { snapshotKey: "v2:first:" + provisional });
    const b = episode(provisional, { snapshotKey: "v2:second:" + provisional });
    await repo.saveEpisode(a);
    state.denials = 1;
    const receipt = await offline.saveEpisodeWithReceipt(b);
    assert.ok(receipt.episode.captureId);
    assert.deepEqual(receipt, {
      episode: { ...b, captureId: receipt.episode.captureId },
      durable: false,
    });
    const rows = await offline.listEpisodes(scope, { requireDurable: true });
    assert.equal(rows.length, 2);
    assert.ok(
      rows.some(
        (ep) =>
          ep.snapshotKey === b.snapshotKey &&
          ep.id !== provisional &&
          ep.captureId === receipt.episode.captureId,
      ),
    );
    const guard = { expectedSnapshotKey: b.snapshotKey };
    const moved = {
      message: "该历史需求档案的标识已更新，请刷新档案列表后重试",
    };
    await assert.rejects(
      offline.updateEpisode(provisional, { pinned: true }, guard),
      moved,
    );
    await assert.rejects(offline.deleteEpisode(provisional, guard), moved);
    assert.deepEqual(await repo.listEpisodes(scope), rows);
  } finally {
    restore();
  }
});

test("a pending copy activation blocks the copy's durable list while the original file's history stays available", async () => {
  const { state, closeMemory, restore } = memoryDatabaseForReconnect();
  try {
    const healthy = new BrowserDocumentRepository(source.sourceFileKey);
    await healthy.save(design([]));
    const ep = await saveDesignEpisodeWithReceipt(episode("healthy-history"));
    assert.equal(ep.durable, true);
    closeMemory();
    state.denials = Infinity;
    const copy = await createLocalFileWithKey({
      ...design([]),
      id: "copy-doc",
    });
    state.denials = 0;
    registerLiveFileStateReader((key) =>
      key === copy.key ? Promise.resolve(null) : readLiveFileState(key),
    );
    assert.equal(
      await getFileProjectSpace(healthy.key, { requireDurable: true }),
      null,
    );
    assert.deepEqual(await listScopeEpisodes(scope, { requireDurable: true }), [
      ep.episode,
    ]);
    await assert.rejects(
      listScopeEpisodes(fileScopeId(copy.key), { requireDurable: true }),
      isProjectMemoryUnavailableError,
    );
    registerLiveFileStateReader(readLiveFileState);
    assert.deepEqual(
      await listScopeEpisodes(fileScopeId(copy.key), { requireDurable: true }),
      [],
    );
  } finally {
    registerLiveFileStateReader(readLiveFileState);
    restore();
  }
});

for (const mutation of ["pin", "delete"] as const) {
  test(`journal replay rechecks the editor's live document before a queued ${mutation} even when memory activation was interrupted`, async () => {
    const { state, disk, restore } = memoryDatabaseForReconnect();
    try {
      const actor = new BrowserDocumentRepository("editing-file");
      await actor.save(design([]));
      await new BrowserDocumentRepository(source.sourceFileKey).save(
        design([]),
      );
      const ep = episode("shared-existing", {
        snapshotKey: "shared-fingerprint",
      });
      const other = new IndexedDbProjectMemoryRepository();
      await other.saveEpisode(ep);
      const session = new IndexedDbProjectMemoryRepository();
      state.denials = 2;
      assert.equal((await session.saveEpisodeWithReceipt(ep)).durable, false);
      const guard = {
        sourceFileKey: actor.key,
        expectedLifetimeToken: actor.getLifetimeToken(),
        expectedDocId: "doc-a",
        expectedSnapshotKey: ep.snapshotKey,
      };
      if (mutation === "pin")
        assert.equal(
          (await session.updateEpisode(ep.id, { pinned: true }, guard))?.pinned,
          true,
        );
      else assert.equal(await session.deleteEpisode(ep.id, guard), true);
      state.abortTransaction = (_, puts) => puts.includes(actor.key);
      await actor.save({ ...design([]), id: "doc-b" });
      state.abortTransaction = () => false;
      assert.equal(
        (disk.get("tombstones")!.get(actor.key) as { activeDocId: string })
          .activeDocId,
        "doc-a",
      );
      assert.deepEqual(
        await session.listEpisodes(scope, { requireDurable: true }),
        [ep],
      );
      assert.deepEqual(await other.getEpisode(ep.id), ep);
    } finally {
      restore();
    }
  });
}

test("a pending reassignment blocks durable history in both affected projects and permits an unrelated file scope", async () => {
  const { state, restore } = memoryDatabaseForReconnect();
  try {
    const file = new BrowserDocumentRepository("moving-copy");
    await file.save(design([]));
    const other = new IndexedDbProjectMemoryRepository();
    const a = await other.createProject({ name: "A" }),
      b = await other.createProject({ name: "B" });
    await other.assignFileToProject(file.key, a.id);
    const session = new IndexedDbProjectMemoryRepository();
    state.denials = 1;
    await session.clearFileTombstone(file.key, {
      activeDocId: "doc-a",
      activeLifetimeToken: file.getLifetimeToken(),
      activeDocGeneration: 1,
    });
    registerLiveFileStateReader((key) =>
      key === file.key ? Promise.resolve(null) : readLiveFileState(key),
    );
    assert.equal(
      (await session.assignFileToProject(file.key, b.id)).project?.id,
      b.id,
    );
    for (const project of [a, b])
      await assert.rejects(
        session.listEpisodes(projectScopeId(project.id), {
          requireDurable: true,
        }),
        isProjectMemoryUnavailableError,
      );
    assert.deepEqual(
      await session.listEpisodes(scope, { requireDurable: true }),
      [],
    );
    registerLiveFileStateReader(readLiveFileState);
    assert.deepEqual(
      await session.listEpisodes(projectScopeId(b.id), {
        requireDurable: true,
      }),
      [],
    );
    assert.equal((await other.getFileProject(file.key))?.id, b.id);
  } finally {
    registerLiveFileStateReader(readLiveFileState);
    restore();
  }
});

test("a scoped catalog stage requires the source lifetime supplied by the opening fence", async () => {
  const { catalogTransactions, restore } = memoryDatabaseForReconnect();
  try {
    const file = new BrowserDocumentRepository("bound-publication");
    await file.save(design([]));
    const fence = await readWorkspaceScopeFence(file.key, null, "doc-a");
    const library = {
      ...checkoutDesign().libraries!.mobile,
      id: "bound-library",
    };
    const publish = (expectedLifetimeToken: string) =>
      saveWorkspaceLibraryIfUnchanged(library, "packaged", null, {
        expectedFence: { ...fence, expectedLifetimeToken },
      });
    await assert.rejects(publish("previous-lifetime"), /源文件状态已变更/);
    assert.ok(!catalogTransactions.some((tx) => tx.puts.includes(library.id)));
    const current = await publish(file.getLifetimeToken()!);
    assert.deepEqual(await getWorkspaceLibrary(library.id), current);
  } finally {
    restore();
  }
});

test("snapshot-guarded offline mutations retire when replay assigns the provisional ID to another branch", async () => {
  const { state, restore } = memoryDatabaseForReconnect();
  try {
    await new BrowserDocumentRepository(source.sourceFileKey).save(design([]));
    const disk = new IndexedDbProjectMemoryRepository();
    const offline = new IndexedDbProjectMemoryRepository();
    const provisional = "ep-snapshot-replay";
    const a = episode(provisional, { snapshotKey: "v2:a:" + provisional });
    const b = episode(provisional, { snapshotKey: "v2:b:" + provisional });
    const savedA = await disk.saveEpisode(a);
    state.denials = 3;
    const receipt = await offline.saveEpisodeWithReceipt(b);
    assert.equal(receipt.durable, false);
    assert.ok(receipt.episode.captureId);
    const guard = { expectedSnapshotKey: b.snapshotKey };
    assert.ok(
      (await offline.updateEpisode(provisional, { pinned: true }, guard))
        ?.pinned,
    );
    assert.ok(await offline.deleteEpisode(provisional, guard));
    const rows = await offline.listEpisodes(scope, { requireDurable: true });
    assert.equal(rows.length, 2);
    assert.deepEqual(
      rows.find((row) => row.id === provisional),
      savedA,
    );
    const durableB = rows.find((row) => row.snapshotKey === b.snapshotKey)!;
    assert.notEqual(durableB.id, provisional);
    assert.deepEqual(durableB, { ...receipt.episode, id: durableB.id });
    assert.deepEqual(await disk.listEpisodes(scope), rows);
  } finally {
    restore();
  }
});

test("a replay retry acknowledges a peer-deleted archive after 300 intervening commits and stage expiry", async () => {
  const { state, restore, documents, disk } = memoryDatabaseForReconnect();
  const start = Date.now(),
    clock = mock.method(Date, "now", () => start);
  try {
    await new BrowserDocumentRepository(source.sourceFileKey).save(design([]));
    const repo = new IndexedDbProjectMemoryRepository();
    const ep = episode("already-finalized");
    state.denials = 1;
    assert.equal((await repo.saveEpisodeWithReceipt(ep)).durable, false);
    state.abortTransaction = (_stores, puts) => puts.includes(ep.id);
    await assert.rejects(
      repo.listEpisodes(scope, { requireDurable: true }),
      isProjectMemoryUnavailableError,
    );
    const decision = [...documents.keys()].find((id) =>
      id.startsWith(commitPrefix),
    );
    assert.ok(decision);
    state.abortTransaction = () => false;
    const peer = new IndexedDbProjectMemoryRepository();
    assert.deepEqual(await peer.listEpisodes(scope), [ep]);
    assert.equal(await peer.deleteEpisode(ep.id), true);
    const other = new BrowserDocumentRepository("busy-file");
    await other.save(design([]));
    for (let i = 0; i < 300; i++) {
      const saved = await peer.saveEpisodeWithReceipt(
        episode("busy-" + i, {
          sourceFileKey: other.key,
          scopeProjectId: fileScopeId(other.key),
          createdAt: new Date(start + i).toISOString(),
        }),
      );
      assert.equal(saved.durable, true);
    }
    clock.mock.mockImplementation(() => start + 61_001);
    assert.ok(documents.has(decision));
    const applied =
      "__forma_applied_commit__:" + decision.slice(commitPrefix.length);
    assert.ok(disk.get("tombstones")!.has(applied));
    assert.deepEqual(
      await repo.listEpisodes(scope, { requireDurable: true }),
      [],
    );
    assert.equal(await repo.isDurable(), true);
    assert.deepEqual(
      await repo.listEpisodes(scope, { requireDurable: true }),
      [],
    );
    assert.ok(!documents.has(decision));
    assert.ok(!disk.get("tombstones")!.has(applied));
    assert.equal(
      [...disk.get("episodes")!.values()].filter(
        (row) => row.scopeProjectId === scope,
      ).length,
      0,
    );
    assert.deepEqual(await peer.listEpisodes(scope), []);
  } finally {
    clock.mock.restore();
    restore();
  }
});

test("A→B→A after the final archive identity read rejects epoch 1 in the studio authorization transaction", async () => {
  const { restore, disk, documents } = memoryDatabaseForReconnect();
  const reset = replaceGlobals({ navigator: {} });
  const paused = signal(),
    resume = signal();
  let saving: Promise<unknown> | undefined;
  try {
    const file = new BrowserDocumentRepository("aba-archive");
    const original = design([layer("frame", "old-board", "Old board")]);
    await file.save(original);
    const writer = new (await isolatedDocumentTab()).BrowserDocumentRepository(
      file.key,
    );
    await writer.load();
    const episode = buildManualEpisodeFromSelection({
      document: original,
      selectionIds: ["old-board"],
      sourceFileKey: file.key,
      scopeProjectId: fileScopeId(file.key),
      sourceLifetimeToken: file.getLifetimeToken(),
      sourceDocumentEpoch: file.getDocumentEpoch(),
    });
    assert.equal(episode.sourceDocumentEpoch, 1);
    let reads = 0;
    registerLiveFileStateReader(async (key) => {
      const live = await readLiveFileState(key);
      if (++reads === 2) {
        paused.resolve();
        await resume.promise;
      }
      return live;
    });
    saving = new IndexedDbProjectMemoryRepository().saveEpisodeWithReceipt(
      episode,
    );
    await Promise.race([
      paused.promise,
      saving.then(() => assert.fail("archive skipped final read")),
    ]);
    await writer.save({ ...design([]), id: "doc-b" });
    await writer.save(design([]));
    assert.equal(writer.getDocumentEpoch(), 3);
    assert.equal(
      (documents.get(file.key) as { replacementEpoch: number })
        .replacementEpoch,
      3,
    );
    assert.equal(writer.getLifetimeToken(), file.getLifetimeToken());
    assert.deepEqual(
      (await new BrowserDocumentRepository(file.key).load())?.nodes,
      [],
    );
    resume.resolve();
    await assert.rejects(saving, /已替换/);
    assert.equal(disk.get("episodes")?.size ?? 0, 0);
  } finally {
    resume.resolve();
    await saving?.catch(() => {});
    registerLiveFileStateReader(readLiveFileState);
    reset();
    restore();
  }
});

test("A→B→A rejects drawer read, update and delete using the editor's opening epoch in both databases", async () => {
  const { restore } = memoryDatabaseForReconnect();
  try {
    const file = new BrowserDocumentRepository("aba-drawer");
    await file.save(design([]));
    const starting = await readLiveFileState(file.key);
    const guard = {
      sourceFileKey: file.key,
      expectedDocId: "doc-a",
      expectedLifetimeToken: file.getLifetimeToken(),
      expectedDocumentEpoch: file.getDocumentEpoch(),
    };
    const repo = new IndexedDbProjectMemoryRepository();
    await file.save({ ...design([]), id: "doc-b" });
    const ep = await repo.saveEpisode(
      episode("private-b", {
        sourceFileKey: file.key,
        sourceDocId: "doc-b",
        title: "B private only",
        scopeProjectId: fileScopeId(file.key),
        sourceLifetimeToken: guard.expectedLifetimeToken,
        sourceDocumentEpoch: 2,
      }),
    );
    await file.save(design([]));
    assert.equal((await readLiveFileState(file.key))?.documentEpoch, 3);
    for (const reader of [readLiveFileState, async () => starting]) {
      registerLiveFileStateReader(reader);
      await assert.rejects(
        repo.getFileProject(file.key, guard),
        isFileLifetimeMismatchError,
      );
      await assert.rejects(
        repo.updateEpisode(ep.id, { pinned: true }, guard),
        isFileLifetimeMismatchError,
      );
      await assert.rejects(
        repo.deleteEpisode(ep.id, guard),
        isFileLifetimeMismatchError,
      );
    }
    assert.deepEqual(await repo.getEpisode(ep.id), ep);
  } finally {
    registerLiveFileStateReader(readLiveFileState);
    restore();
  }
});

test("explicit same-ID import advances the file and catalog epochs and retires the old archive and promotion", async () => {
  const { documents, disk, restore } = memoryDatabaseForReconnect();
  try {
    const key = "same-id-import",
      file = new BrowserDocumentRepository(key);
    const doc = design([layer("frame", "board", "Old board")]);
    await file.save(doc);
    const oldEpoch = file.getDocumentEpoch();
    const old = new BrowserDocumentRepository(key);
    await old.load();
    const fence = await readWorkspaceScopeFence(key, null, doc.id, oldEpoch);
    const ep = buildEpisodeFromAppliedProposal({
      beforeDoc: design([]),
      afterDoc: doc,
      createdRootIds: ["board"],
      prompt: "Old board",
      sourceFileKey: key,
      scopeProjectId: fileScopeId(key),
      sourceLifetimeToken: old.getLifetimeToken(),
      sourceDocumentEpoch: old.getDocumentEpoch(),
    });
    await file.save({ ...doc, name: "ordinary edit" });
    assert.equal(file.getDocumentEpoch(), oldEpoch);
    await file.save(design([]), { replacedDocument: true });
    await new IndexedDbProjectMemoryRepository().clearFileTombstone(key, {
      activeDocId: doc.id,
      activeLifetimeToken: old.getLifetimeToken(),
      activeDocEpoch: oldEpoch,
    });
    assert.equal(
      (documents.get(key) as { replacementEpoch: number }).replacementEpoch,
      2,
    );
    assert.equal(
      (disk.get("tombstones")!.get(key) as { activeDocEpoch: number })
        .activeDocEpoch,
      2,
    );
    const current = await readWorkspaceScopeFence(key, null, doc.id, 2);
    assert.equal(current.fileEpoch, fence.fileEpoch + 1);
    await assert.rejects(
      readWorkspaceScopeFence(key, null, doc.id, oldEpoch),
      /已变更/,
    );
    await assert.rejects(old.save(doc), /另一个标签页更新/);
    await assert.rejects(
      new IndexedDbProjectMemoryRepository().saveEpisode(ep),
      /已替换/,
    );
    const library = {
      ...checkoutDesign().libraries!.mobile,
      id: "former-selection",
    };
    await assert.rejects(
      saveWorkspaceLibraryIfUnchanged(library, "packaged", null, {
        expectedFence: fence,
      }),
      /已变更/,
    );
    assert.equal(await getWorkspaceLibrary(library.id), null);
    assert.equal(disk.get("episodes")?.size ?? 0, 0);
  } finally {
    restore();
  }
});

test("a one-time UnknownError on the generation-4 partition cursor cannot restore generation 3 over the healthy file", async () => {
  const { state, documents, restore } = memoryDatabaseForReconnect();
  try {
    const key = "partition-cursor-recovery",
      writer = new BrowserDocumentRepository(key);
    const doc = design([]);
    doc.importReport = {
      version: 1,
      format: "Sketch",
      filename: "boards.sketch",
      sha256: "0".repeat(64),
      sourceNodes: 2001,
      issues: Array.from({ length: 2001 }, () => ({
        node: "board",
        detail: "import",
      })),
    };
    for (let revision = 1; revision <= 4; revision++)
      await writer.save({ ...doc, revision, name: "Healthy " + revision });
    const record = structuredClone(documents.get(key));
    const stale = new BrowserDocumentRepository(key);
    state.partitionReadError = () => {
      state.partitionReadError = () => undefined;
      return new DOMException("interrupted chunk cursor", "UnknownError");
    };
    await assert.rejects(stale.load(), { name: "UnknownError" });
    const peer = new BrowserDocumentRepository(key);
    assert.equal((await peer.load())?.name, "Healthy 4");
    const backup = await peer.recovery();
    assert.equal(backup?.revision, 3);
    state.partitionReadError = () =>
      new DOMException("I/O interrupted", "UnknownError");
    await assert.rejects(stale.recovery(), { name: "UnknownError" });
    assert.deepEqual(documents.get(key), record);
    state.partitionReadError = () =>
      new Error("wrapped cursor failure", {
        cause: new DOMException("connection closed", "AbortError"),
      });
    await assert.rejects(stale.recovery(), /wrapped cursor failure/);
    state.partitionReadError = () => undefined;
    await assert.rejects(stale.recovery(), {
      message: "原文件当前版本可读，请刷新页面打开最新版本",
    });
    await assert.rejects(stale.save(backup!));
    assert.deepEqual(documents.get(key), record);
    assert.equal((await stale.load())?.revision, 4);
  } finally {
    restore();
  }
});

for (const mutation of ["delete", "pin"] as const) {
  test(`queued shared-episode ${mutation} retires after deleting and recreating the acting file during interrupted cleanup`, async () => {
    const { state, disk, documents, restore } = memoryDatabaseForReconnect();
    try {
      const actor = new BrowserDocumentRepository("acting-file");
      const other = new BrowserDocumentRepository(source.sourceFileKey);
      await actor.save(design([]));
      await other.save(design([]));
      const peer = new IndexedDbProjectMemoryRepository();
      const project = await peer.createProject({ name: "Shared" });
      for (const key of [actor.key, other.key])
        await peer.assignFileToProject(key, project.id);
      const scope = projectScopeId(project.id);
      const shared = await peer.saveEpisode(
        episode("shared-peer-archive", {
          scopeProjectId: scope,
          sourceLifetimeToken: other.getLifetimeToken(),
        }),
      );
      const session = new IndexedDbProjectMemoryRepository();
      state.denyAuthorization = true;
      const pending = await session.saveEpisodeWithReceipt({
        ...shared,
        id: "session-only",
      });
      assert.equal(pending.durable, false);
      const guard = {
        expectedScopeId: scope,
        sourceFileKey: actor.key,
        expectedDocId: "doc-a",
        expectedDocumentEpoch: actor.getDocumentEpoch(),
        expectedLifetimeToken: actor.getLifetimeToken(),
        expectedIdentityKey: episodeIdentityKey(shared),
      };
      if (mutation === "delete")
        assert.equal(await session.deleteEpisode(shared.id, guard), true);
      else
        assert.equal(
          (await session.updateEpisode(shared.id, { pinned: true }, guard))
            ?.pinned,
          true,
        );
      assert.deepEqual(disk.get("episodes")!.get(shared.id), shared);
      state.abortTransaction = (_stores, puts) => puts.includes(actor.key);
      await deleteLocalFile(actor.key);
      const replacement = new BrowserDocumentRepository(actor.key);
      await replacement.save(design([]));
      assert.notEqual(replacement.getLifetimeToken(), actor.getLifetimeToken());
      assert.equal(
        (await readLiveFileState(actor.key))?.docId,
        guard.expectedDocId,
      );
      assert.ok(documents.has("__forma_internal_pending_memory_cleanups__"));
      state.denyAuthorization = false;
      assert.ok(await session.isDurable());
      assert.deepEqual(await peer.getEpisode(shared.id), shared);
      assert.deepEqual(disk.get("episodes")!.get(shared.id), shared);
      state.abortTransaction = () => false;
      await flushPendingFileMemoryCleanups();
    } finally {
      restore();
    }
  });
}

for (const capture of [
  "401-node draft migration",
  "two-board restored branch",
] as const) {
  test(`legacy dedup preserves the pinned original and the modern ${capture}`, async () => {
    const { disk, restore } = memoryDatabaseForReconnect();
    try {
      const dense = capture === "401-node draft migration";
      const file = new BrowserDocumentRepository("legacy-evidence");
      const first = layer("frame", "first", "First");
      const doc = design([
        first,
        ...(dense
          ? Array.from({ length: 400 }, (_, i) =>
              layer("rectangle", "r-" + i, "Rect", first.id),
            )
          : [layer("frame", "second", "Second")]),
      ]);
      const input = (document: DesignDocument) => ({
        document,
        selectionIds: dense ? ["first"] : ["first", "second"],
        sourceFileKey: file.key,
        sourceLifetimeToken: file.getLifetimeToken(),
        scopeProjectId: fileScopeId(file.key),
      });
      const branch = (base: DesignDocument, fill: string) => {
        const result = structuredClone(base);
        result.revision++;
        result.nodes[1].style.fill = fill;
        return result;
      };
      await file.save(doc);
      const a = branch(doc, "#123456");
      await file.save(a);
      const original = buildManualEpisodeFromSelection(input(a));
      const legacy = { ...original, pinned: true };
      delete legacy.snapshotKey;
      const recovered = (await file.recovery())!;
      await file.save(recovered);
      const b = branch(recovered, "#ffee11");
      await file.save(b);
      const modern = buildManualEpisodeFromSelection(input(b));
      assert.equal(a.revision, b.revision);
      assert.equal(modern.id, legacy.id);
      assert.notEqual(modern.snapshotKey, original.snapshotKey);
      assert.deepEqual(modern.screens, legacy.screens);
      assert.equal(modern.thumbnailSvg, legacy.thumbnailSvg);
      if (dense) {
        assert.equal(legacy.screens[0].nodeCount, 401);
        assert.equal(legacy.thumbnailSvg, undefined);
      } else {
        assert.equal(legacy.screens.length, 2);
        assert.ok(legacy.thumbnailSvg);
      }
      const repo = new IndexedDbProjectMemoryRepository();
      let scope = fileScopeId(file.key);
      if (dense) {
        const p = await repo.createProject({ name: "Target" });
        await repo.assignFileToProject(file.key, p.id);
        scope = projectScopeId(p.id);
        await repo.saveEpisode({
          ...modern,
          id: "preexisting-modern",
          scopeProjectId: scope,
        });
        await repo.assignFileToProject(file.key, null);
        disk.get("episodes")!.set(legacy.id, legacy);
        await repo.assignFileToProject(file.key, p.id);
      } else {
        disk.set("episodes", new Map([[legacy.id, legacy]]));
        assert.equal((await repo.saveEpisodeWithReceipt(modern)).durable, true);
      }
      const saved = await repo.saveEpisode({
        ...modern,
        scopeProjectId: scope,
      });
      assert.notEqual(saved.id, legacy.id);
      const rows = await new IndexedDbProjectMemoryRepository().listEpisodes(
        scope,
      );
      assert.equal(rows.length, 2);
      assert.equal(rows.find((row) => row.id === legacy.id)?.pinned, true);
      assert.equal(rows.find((row) => row.id === saved.id)?.pinned, undefined);
    } finally {
      restore();
    }
  });
}

test("same-fingerprint provisional deletion cannot remove a pin from a former file lifetime", async () => {
  const { state, restore } = memoryDatabaseForReconnect();
  try {
    const key = source.sourceFileKey,
      first = new BrowserDocumentRepository(key);
    const doc = design([layer("frame", "board", "Board")]);
    await first.save(doc);
    const repo = new IndexedDbProjectMemoryRepository();
    const project = await repo.createProject({ name: "Shared" });
    const scope = projectScopeId(project.id);
    const capture = (file: BrowserDocumentRepository) =>
      buildManualEpisodeFromSelection({
        document: doc,
        selectionIds: ["board"],
        sourceFileKey: file.key,
        scopeProjectId: scope,
        sourceLifetimeToken: file.getLifetimeToken(),
      });
    await repo.assignFileToProject(key, project.id);
    const old = await repo.saveEpisode(capture(first));
    const pin = await repo.updateEpisode(old.id, {
      pinned: true,
      title: "Former lifetime pin",
    });
    await deleteLocalFile(key);
    const current = new BrowserDocumentRepository(key);
    await current.save(doc);
    await repo.assignFileToProject(key, project.id);
    const session = new IndexedDbProjectMemoryRepository();
    state.denials = 1;
    const receipt = await session.saveEpisodeWithReceipt(capture(current));
    assert.equal(receipt.durable, false);
    assert.equal(receipt.episode.id, old.id);
    assert.equal(receipt.episode.snapshotKey, old.snapshotKey);
    assert.notEqual(
      episodeIdentityKey(receipt.episode),
      episodeIdentityKey(old),
    );
    assert.equal(
      (await session.listEpisodes(scope, { requireDurable: true })).length,
      2,
    );
    const guard = {
      expectedScopeId: scope,
      expectedIdentityKey: episodeIdentityKey(receipt.episode),
    };
    await assert.rejects(
      session.deleteEpisode(receipt.episode.id, guard),
      /已变更或由新版本替代/,
    );
    assert.deepEqual(await repo.getEpisode(old.id), pin);
    assert.equal((await repo.listEpisodes(scope)).length, 2);
  } finally {
    restore();
  }
});

test("a tokenless normalized draft keeps its guarded identity across migration until a peer replaces the row", async () => {
  const { disk, restore } = memoryDatabaseForReconnect();
  try {
    const file = new BrowserDocumentRepository(source.sourceFileKey);
    await file.save(design([]));
    const token = file.getLifetimeToken()!;
    const id = "ep-snapshot-tokenless-mig";
    const draft = episode(id, {
      snapshotKey: id,
      sourceLifetimeToken: undefined,
    });
    disk.set("episodes", new Map([[id, draft]]));
    const originalIdentity = episodeIdentityKey(draft);
    const repo = new IndexedDbProjectMemoryRepository();
    const project = await repo.createProject({ name: "Migration" });
    const projectScope = projectScopeId(project.id);
    await repo.assignFileToProject(file.key, project.id, {
      expectedLifetimeToken: token,
    });
    const [migrated] = await repo.listEpisodes(projectScope);
    assert.equal(migrated.id, id);
    assert.equal(migrated.sourceLifetimeToken, token);
    assert.equal(migrated.snapshotKey, id);
    assert.equal(episodeIdentityKey(migrated), originalIdentity);
    const guard = {
      expectedIdentityKey: originalIdentity,
      expectedScopeId: projectScope,
      sourceFileKey: file.key,
      expectedLifetimeToken: token,
      expectedDocId: draft.sourceDocId,
      expectedDocumentEpoch: file.getDocumentEpoch(),
    };
    assert.equal(
      (await repo.updateEpisode(id, { pinned: true }, guard))?.pinned,
      true,
    );
    const peer = new IndexedDbProjectMemoryRepository();
    assert.equal((await peer.getEpisode(id))?.pinned, true);
    assert.equal(await peer.deleteEpisode(id), true);
    const replacement = await peer.saveEpisode({
      ...draft,
      scopeProjectId: projectScope,
      sourceLifetimeToken: token,
      title: "Replacement",
    });
    assert.equal(replacement.id, id);
    assert.equal(replacement.snapshotKey, id);
    assert.notEqual(episodeIdentityKey(replacement), originalIdentity);
    await assert.rejects(
      repo.updateEpisode(id, { pinned: true }, guard),
      /已变更或由新版本替代/,
    );
    await assert.rejects(repo.deleteEpisode(id, guard), /已变更或由新版本替代/);
    assert.deepEqual(await peer.listEpisodes(projectScope), [replacement]);
  } finally {
    restore();
  }
});

for (const sameCapture of [false, true]) {
  test(`migration into an unpinned tokenless legacy copy with a ${sameCapture ? "matching" : "different"} creation time preserves the draft's guarded identity`, async () => {
    const { disk, restore } = memoryDatabaseForReconnect();
    try {
      const file = new BrowserDocumentRepository(source.sourceFileKey);
      await file.save(design([]));
      const token = file.getLifetimeToken();
      assert.ok(token);
      const repo = new IndexedDbProjectMemoryRepository();
      const project = await repo.createProject({ name: "Legacy migration" });
      const destination = projectScopeId(project.id);
      const draft = episode("draft", { snapshotKey: "ep-snapshot-shared" });
      const copy = {
        ...draft,
        id: "destination",
        scopeProjectId: destination,
        createdAt: sameCapture ? draft.createdAt : "2026-01-01T00:00:00.000Z",
      };
      disk.set(
        "episodes",
        new Map([
          [draft.id, draft],
          [copy.id, copy],
        ]),
      );
      const identity = episodeIdentityKey(draft);
      await repo.assignFileToProject(file.key, project.id, {
        expectedLifetimeToken: token,
      });
      const peer = new IndexedDbProjectMemoryRepository();
      const rows = await peer.listEpisodes(destination, {
        requireDurable: true,
      });
      assert.equal(rows.length, sameCapture ? 1 : 2);
      assert.deepEqual(await peer.listEpisodes(scope), []);
      const migrated = rows.find(
        (row) => row.id === (sameCapture ? copy.id : draft.id),
      )!;
      assert.equal(migrated.createdAt, draft.createdAt);
      assert.equal(migrated.sourceLifetimeToken, token);
      assert.equal(migrated.legacyIdentity, identity);
      assert.equal(episodeIdentityKey(migrated), identity);
      assert.ok(!migrated.pinned);
      const pin = await repo.updateEpisode(
        draft.id,
        { pinned: true },
        {
          expectedIdentityKey: identity,
          expectedScopeId: destination,
          sourceFileKey: file.key,
          expectedLifetimeToken: token,
          expectedDocId: draft.sourceDocId,
          expectedDocumentEpoch: file.getDocumentEpoch(),
        },
      );
      assert.equal(pin?.id, migrated.id);
      assert.equal((await peer.getEpisode(migrated.id))?.pinned, true);
      if (!sameCapture) assert.deepEqual(await peer.getEpisode(copy.id), copy);
    } finally {
      restore();
    }
  });
}

for (const bound of [false, true]) {
  test(`a renamed private legacy draft retains its identity beside a ${bound ? "token-bound" : "tokenless"} destination copy`, async () => {
    const { disk, restore } = memoryDatabaseForReconnect();
    try {
      const file = new BrowserDocumentRepository(source.sourceFileKey);
      await file.save(design([]));
      const token = file.getLifetimeToken()!;
      const repo = new IndexedDbProjectMemoryRepository();
      const project = await repo.createProject({ name: "Migration" });
      const destination = projectScopeId(project.id);
      const draft = episode("draft", {
        snapshotKey: "ep-snapshot-shared",
        title: "Private draft",
      });
      const copy = {
        ...draft,
        id: "copy",
        scopeProjectId: destination,
        title: "Shared title",
        ...(bound && { sourceLifetimeToken: token }),
      };
      disk.set(
        "episodes",
        new Map([
          [draft.id, draft],
          [copy.id, copy],
        ]),
      );
      const identity = episodeIdentityKey(draft);
      const guard = {
        sourceFileKey: file.key,
        expectedScopeId: scope,
        expectedIdentityKey: identity,
        expectedLifetimeToken: token,
        expectedDocId: draft.sourceDocId,
        expectedDocumentEpoch: file.getDocumentEpoch(),
      };
      const renamed = await repo.updateEpisode(
        draft.id,
        { title: copy.title },
        guard,
      );
      assert.equal(renamed?.legacyIdentity, identity);
      assert.notEqual(identity, episodeIdentityKey(copy));
      await repo.assignFileToProject(file.key, project.id, {
        expectedLifetimeToken: token,
      });
      const pinned = await repo.updateEpisode(
        draft.id,
        { pinned: true },
        { ...guard, expectedScopeId: destination },
      );
      assert.equal(pinned?.id, draft.id);
      assert.equal(pinned.sourceLifetimeToken, token);
      assert.equal(pinned.legacyIdentity, identity);
      assert.equal(pinned.pinned, true);
      const peer = new IndexedDbProjectMemoryRepository();
      assert.deepEqual(
        await peer.listEpisodes(destination, { requireDurable: true }),
        [pinned, copy],
      );
      assert.deepEqual(await peer.listEpisodes(scope), []);
    } finally {
      restore();
    }
  });
}

test("migration preserves a long pre-existing legacy identity within the stored key limit", async () => {
  const { disk, restore } = memoryDatabaseForReconnect();
  try {
    const key = "f".repeat(200);
    const doc = { ...design([]), id: "d".repeat(128) };
    const file = new BrowserDocumentRepository(key);
    await file.save(doc);
    const draft = episode("ep-snapshot-" + "x".repeat(116), {
      sourceFileKey: key,
      scopeProjectId: fileScopeId(key),
      sourceDocId: doc.id,
      legacyIdentity: "digest:1234567890abcdef",
    });
    draft.snapshotKey = draft.id;
    const identity = episodeIdentityKey(draft);
    assert.ok(identity.length > 512);
    disk.set("episodes", new Map([[draft.id, draft]]));
    const repo = new IndexedDbProjectMemoryRepository();
    const project = await repo.createProject({ name: "Long key" });
    await repo.assignFileToProject(key, project.id);
    const moved = await repo.updateEpisode(
      draft.id,
      { summary: "Edited" },
      { expectedIdentityKey: identity },
    );
    assert.ok(moved?.legacyIdentity && moved.legacyIdentity.length <= 512);
    assert.equal(moved.sourceLifetimeToken, file.getLifetimeToken());
    assert.equal(episodeIdentityKey(moved), identity);
  } finally {
    restore();
  }
});

test("a stale legacy identity rejects delete and pin after a different branch reuses its display ID", async () => {
  const { disk, restore } = memoryDatabaseForReconnect();
  try {
    const key = source.sourceFileKey,
      file = new BrowserDocumentRepository(key);
    await file.save(design([]));
    const legacy = episode("ep-snapshot-reused", {
      sourceLifetimeToken: file.getLifetimeToken(),
    });
    disk.set("episodes", new Map([[legacy.id, legacy]]));
    const reader = new IndexedDbProjectMemoryRepository(),
      peer = new IndexedDbProjectMemoryRepository();
    const selected = (await reader.getEpisode(legacy.id))!;
    const guard = {
      expectedIdentityKey: episodeIdentityKey(selected),
      expectedScopeId: scope,
    };
    assert.equal(await peer.deleteEpisode(legacy.id), true);
    const replacement = await peer.saveEpisode({
      ...legacy,
      title: "Replacement",
      snapshotKey: "v2:other:" + legacy.id,
    });
    assert.equal(replacement.id, selected.id);
    await assert.rejects(
      reader.deleteEpisode(selected.id, guard),
      /已变更或由新版本替代/,
    );
    await assert.rejects(
      reader.updateEpisode(selected.id, { pinned: true }, guard),
      /已变更或由新版本替代/,
    );
    assert.deepEqual(await peer.listEpisodes(scope), [replacement]);
  } finally {
    restore();
  }
});

test("malformed parts headers are confirmed corruption and a readable previous revision can be restored", async () => {
  const { documents, restore } = memoryDatabaseForReconnect();
  try {
    const file = new BrowserDocumentRepository("invalid-part-generation");
    const doc = design([]);
    await file.save(doc);
    await file.save({ ...doc, revision: 2 });
    const healthy = documents.get(file.key) as {
      current: unknown;
      previous: unknown;
    };
    const header = { format: "parts-v1", generation: 2, chunks: 1, assets: [] };
    assert.throws(
      () => IDBKeyRange.bound([file.key, null] as unknown as IDBValidKey, []),
      { name: "DataError" },
    );
    for (const invalid of [
      { generation: null },
      { generation: NaN },
      { generation: -1 },
      { generation: 1.5 },
      { generation: Number.MAX_SAFE_INTEGER + 1 },
      { chunks: null },
      { chunks: -1 },
      { chunks: 1.5 },
      { assets: "broken" },
      { assets: [null] },
      { assets: Array(1) },
    ]) {
      documents.set(file.key, {
        ...healthy,
        current: { ...header, ...invalid },
      });
      const reader = new BrowserDocumentRepository(file.key);
      await assert.rejects(reader.load(), {
        name: "Error",
        message: "本机文档存储快照头无效",
      });
      const previous = await reader.recovery();
      assert.equal(previous?.revision, 1);
      await reader.save(previous!);
      assert.equal(
        (await new BrowserDocumentRepository(file.key).load())?.revision,
        1,
      );
    }
    // A corrupt previous partition must also permit an ordinary save.
    documents.set(file.key, {
      ...healthy,
      previous: { ...header, generation: null },
    });
    const reader = new BrowserDocumentRepository(file.key);
    assert.equal((await reader.load())?.revision, 2);
    await reader.save({ ...doc, revision: 3 });
    assert.equal((await reader.load())?.revision, 3);
  } finally {
    restore();
  }
});

for (const op of ["delete", "update"] as const) {
  for (const phase of [
    "before grant",
    "after grant",
    "live after grant",
  ] as const) {
    test(`guarded shared ${op} paused ${phase} is ordered against recreation and consumes a single receipt`, async () => {
      const { state, disk, documents, transactions, restore } =
        memoryDatabaseForReconnect();
      const noLocks = replaceGlobals({ navigator: {} });
      const start = Date.now();
      const clock = mock.method(Date, "now", () => start);
      const paused = signal(),
        resume = signal();
      let work: Promise<unknown> | undefined;
      try {
        const doc = design([]);
        const actor = new BrowserDocumentRepository("actor");
        const author = new BrowserDocumentRepository(source.sourceFileKey);
        await actor.save(doc);
        await author.save(doc);
        const peer = new IndexedDbProjectMemoryRepository();
        const repo = new (
          await isolatedMemoryTab()
        ).IndexedDbProjectMemoryRepository();
        const project = await peer.createProject({ name: "Shared" });
        const scope = projectScopeId(project.id);
        for (const key of [actor.key, author.key])
          await peer.assignFileToProject(key, project.id);
        const shared = await peer.saveEpisode(
          episode("shared", {
            scopeProjectId: scope,
            sourceLifetimeToken: author.getLifetimeToken(),
          }),
        );
        const guard = {
          sourceFileKey: actor.key,
          expectedScopeId: scope,
          expectedDocId: doc.id,
          expectedDocumentEpoch: 1,
          expectedLifetimeToken: actor.getLifetimeToken(),
          requireBoundLifetime: true,
          expectedIdentityKey: episodeIdentityKey(shared),
          expectedSnapshotKey: shared.id,
        };
        const mutate = () =>
          op === "delete"
            ? repo.deleteEpisode(shared.id, guard)
            : repo.updateEpisode(shared.id, { title: "Granted edit" }, guard);
        const replay = phase !== "live after grant";
        const granted = phase !== "before grant";
        if (replay) {
          state.denyAuthorization = true;
          const provisional = await mutate();
          assert.ok(
            op === "delete"
              ? provisional === true
              : typeof provisional === "object" &&
                  provisional?.title === "Granted edit",
          );
          assert.deepEqual(disk.get("episodes")!.get(shared.id), shared);
          state.denyAuthorization = false;
        }
        const stagePrefix = "__staged_mut__:";
        if (granted) {
          state.afterStudioCommit = (keys) => {
            if (!keys.some((key) => key.startsWith(commitPrefix + "mut-")))
              return;
            state.afterStudioCommit = () => undefined;
            paused.resolve();
            return resume.promise;
          };
        } else {
          state.delayCompletion = (_, keys) => {
            if (!keys.some((key) => key.startsWith(stagePrefix))) return;
            state.delayCompletion = () => undefined;
            paused.resolve();
            return resume.promise;
          };
        }
        work = replay ? repo.isDurable() : mutate();
        await Promise.race([
          paused.promise,
          work.then(() => assert.fail("mutation missed pause")),
        ]);
        const stageKey = [...disk.get("tombstones")!.keys()].find((key) =>
          key.startsWith(stagePrefix),
        )!;
        const commitId = stageKey.slice(stagePrefix.length),
          appliedKey = "__forma_applied_commit__:" + commitId;
        const stage = disk.get("tombstones")!.get(stageKey) as {
          binding: Record<string, unknown>;
        };
        assert.deepEqual(stage.binding, {
          op,
          fileKey: actor.key,
          targetId: shared.id,
          expectedScopeId: scope,
          expectedDocId: guard.expectedDocId,
          expectedDocumentEpoch: 1,
          expectedLifetimeToken: guard.expectedLifetimeToken,
          expectedSnapshotKey: shared.id,
          expectedIdentityKey: guard.expectedIdentityKey,
        });
        assert.equal(
          await isFileCommitAuthorized(commitId, stage.binding),
          granted ? "authorized" : "missing",
        );
        assert.equal(
          await isFileCommitAuthorized(commitId, {
            ...stage.binding,
            targetId: "unrelated",
          }),
          "missing",
        );
        clock.mock.mockImplementation(() => start + 16_001);
        state.abortTransaction = (_, puts) =>
          puts.includes(actor.key) || puts.includes(appliedKey);
        await deleteLocalFile(actor.key);
        const replacement = new BrowserDocumentRepository(actor.key);
        await replacement.save(doc);
        assert.notEqual(
          replacement.getLifetimeToken(),
          guard.expectedLifetimeToken,
        );
        assert.equal((await readLiveFileState(actor.key))?.docId, doc.id);
        assert.ok(documents.has("__forma_internal_pending_memory_cleanups__"));
        state.abortTransaction = () => false;
        const visible = await peer.listEpisodes(scope, {
          requireDurable: true,
        });
        let originalResult: boolean | DesignEpisode = true;
        if (!granted) {
          assert.deepEqual(visible, [shared]);
        } else {
          if (op === "delete") assert.deepEqual(visible, []);
          else {
            assert.equal(visible[0]?.title, "Granted edit");
            originalResult = visible[0];
          }
          assert.deepEqual(disk.get("tombstones")!.get(appliedKey), {
            fileKey: appliedKey,
            kind: "mutation",
            result: originalResult,
          });
          if (op === "update") await peer.deleteEpisode(shared.id);
          const later = await peer.saveEpisode({
            ...shared,
            title: "Later capture",
          });
          assert.equal(later.id, shared.id);
        }
        resume.resolve();
        assert.deepEqual(await work, replay ? true : originalResult);
        assert.equal(
          (await peer.getEpisode(shared.id))?.title,
          granted ? "Later capture" : shared.title,
        );
        assert.equal(
          transactions.filter(
            (tx) => !tx.aborted && tx.puts.includes(appliedKey),
          ).length,
          granted ? 1 : 0,
        );
        assert.ok(!disk.get("tombstones")!.has(stageKey));
        assert.ok(!disk.get("tombstones")!.has(appliedKey));
        assert.equal(await isFileCommitAuthorized(commitId), "missing");
      } finally {
        resume.resolve();
        await work?.catch(() => {});
        clock.mock.restore();
        noLocks();
        restore();
      }
    });
  }
}

for (const edit of [
  "remove Back interaction",
  "resize nested slice",
] as const) {
  test(`legacy and modern captures survive a same-revision edit omitted from the preview: ${edit}`, async () => {
    const { disk, restore } = memoryDatabaseForReconnect();
    try {
      const board = layer("frame", "board", "Board");
      const base = design([board]);
      if (edit === "remove Back interaction")
        board.interaction = { actions: [{ kind: "back" }] };
      else base.nodes.push(layer("slice", "slice", "Export slice", board.id));
      const file = new BrowserDocumentRepository(source.sourceFileKey);
      await file.save(base);
      const capture = (document: DesignDocument) =>
        buildManualEpisodeFromSelection({
          ...archive,
          document,
          selectionIds: [board.id],
          sourceLifetimeToken: file.getLifetimeToken(),
          sourceDocumentEpoch: file.getDocumentEpoch(),
        });
      const original = capture(base);
      const legacy = { ...original, pinned: true };
      delete legacy.snapshotKey;
      disk.set("episodes", new Map([[legacy.id, legacy]]));
      const changed = structuredClone(base);
      if (edit === "remove Back interaction")
        delete changed.nodes[0].interaction;
      else changed.nodes[1].style.width += 50;
      await file.save(changed);
      const modern = capture(changed);
      assert.equal(modern.id, legacy.id);
      assert.notEqual(modern.snapshotKey, original.snapshotKey);
      assert.ok(legacy.thumbnailSvg);
      assert.equal(modern.thumbnailSvg, legacy.thumbnailSvg);
      assert.deepEqual(modern.screens, legacy.screens);
      const repo = new IndexedDbProjectMemoryRepository();
      const receipt = await repo.saveEpisodeWithReceipt(modern);
      assert.equal(receipt.durable, true);
      assert.notEqual(receipt.episode.id, legacy.id);
      assert.match(receipt.episode.snapshotKey!, /^v2:[^:]+$/);
      const peer = new IndexedDbProjectMemoryRepository();
      assert.deepEqual(
        await peer.saveEpisodeWithReceipt(capture(changed)),
        receipt,
      );
      assert.deepEqual(await peer.listEpisodes(scope), [
        legacy,
        receipt.episode,
      ]);
    } finally {
      restore();
    }
  });
}

test("a changed text suffix past character 240 preserves the pinned legacy capture and deduplicates only the modern branch", async () => {
  const { disk, restore } = memoryDatabaseForReconnect();
  try {
    const board = layer("frame", "board", "Board");
    const base = design([board, layer("text", "body", "Body", board.id)]);
    const file = new BrowserDocumentRepository(source.sourceFileKey);
    await file.save(base);
    const capture = async (preceding: DesignDocument, suffix: string) => {
      const doc = structuredClone(preceding);
      doc.nodes[1].text = "x".repeat(240) + suffix;
      doc.revision++;
      await file.save(doc);
      return buildManualEpisodeFromSelection({
        ...archive,
        document: doc,
        selectionIds: [board.id],
        sourceLifetimeToken: file.getLifetimeToken(),
      });
    };
    const original = await capture(base, "original");
    const legacy = { ...original, pinned: true };
    delete legacy.snapshotKey;
    disk.set("episodes", new Map([[legacy.id, legacy]]));
    const previous = (await file.recovery())!;
    assert.equal(previous.revision, 1);
    await file.save(previous);
    const modern = await capture(previous, "changed");
    assert.equal(legacy.id, modern.id);
    assert.ok(legacy.thumbnailSvg);
    assert.equal(legacy.thumbnailSvg, modern.thumbnailSvg);
    assert.match(modern.snapshotKey!, /^v2:[^:]+$/);
    assert.notEqual(original.snapshotKey, modern.snapshotKey);
    const repo = new IndexedDbProjectMemoryRepository();
    const receipt = await repo.saveEpisodeWithReceipt(modern);
    assert.equal(receipt.durable, true);
    assert.notEqual(receipt.episode.id, legacy.id);
    const reopened = new IndexedDbProjectMemoryRepository();
    assert.deepEqual(await reopened.listEpisodes(scope), [
      legacy,
      receipt.episode,
    ]);
    assert.deepEqual(await reopened.saveEpisodeWithReceipt(modern), receipt);
    assert.deepEqual(await repo.listEpisodes(scope), [legacy, receipt.episode]);
  } finally {
    restore();
  }
});

function boundBoardDocument(boards: number, binding: "variable" | "fillToken") {
  const nodes = Array.from({ length: boards }, (_, i) =>
    layer("frame", "board-" + (i + 1), "Board " + (i + 1)),
  );
  const doc = design(nodes);
  const bound = nodes[boards - 1];
  if (binding === "fillToken") {
    bound.fillToken = "brand";
    doc.tokens.brand = { name: "Brand", value: "#224466" };
  } else {
    bound.variableBindings = { fill: "brand" };
    doc.designSystem = {
      collections: {
        palette: {
          id: "palette",
          name: "Palette",
          modes: [{ id: "light", name: "Light" }],
          defaultModeId: "light",
        },
      },
      variables: {
        brand: {
          id: "brand",
          name: "Brand",
          type: "color",
          collectionId: "palette",
          description: "",
          codeSyntax: "",
          scopes: [],
          values: { light: "#224466" },
        },
      },
      styles: {},
      activeModes: { palette: "light" },
    };
  }
  return doc;
}

for (const [boards, binding] of [
  [2, "variable"],
  [25, "variable"],
  [2, "fillToken"],
] as const) {
  test(`a ${binding} fill on board ${boards} fingerprints both restored revision-2 branches`, async () => {
    const { restore } = memoryDatabaseForReconnect();
    try {
      const base = boundBoardDocument(boards, binding);
      const file = new BrowserDocumentRepository(source.sourceFileKey);
      await file.save(base);
      const capture = async (previous: DesignDocument, value: string) => {
        const doc = structuredClone(previous);
        doc.revision++;
        assert.equal(doc.revision, 2);
        if (binding === "variable")
          doc.designSystem!.variables.brand.values.light = value;
        else doc.tokens.brand.value = value;
        await file.save(doc);
        return buildManualEpisodeFromSelection({
          ...archive,
          document: doc,
          selectionIds: base.nodes.map((n) => n.id),
          sourceLifetimeToken: file.getLifetimeToken(),
        });
      };
      const red = await capture(base, "#ff0000");
      const preceding = (await file.recovery())!;
      assert.equal(preceding.revision, 1);
      await file.save(preceding);
      const blue = await capture(preceding, "#0000ff");
      assert.ok(red.thumbnailSvg);
      assert.equal(red.thumbnailSvg, blue.thumbnailSvg);
      assert.deepEqual(red.screens, blue.screens);
      assert.match(red.snapshotKey!, /^v2:/);
      assert.match(blue.snapshotKey!, /^v2:/);
      assert.notEqual(red.snapshotKey, blue.snapshotKey);
      const repo = new IndexedDbProjectMemoryRepository();
      const a = await repo.saveEpisodeWithReceipt(red);
      const b = await repo.saveEpisodeWithReceipt(blue);
      assert.ok(a.durable && b.durable);
      assert.notEqual(a.episode.id, b.episode.id);
      assert.deepEqual(
        new Set(
          (
            await new IndexedDbProjectMemoryRepository().listEpisodes(scope)
          ).map((row) => row.id),
        ),
        new Set([a.episode.id, b.episode.id]),
      );
    } finally {
      restore();
    }
  });
}

function twoModeBoardDocument(boards: number) {
  const doc = boundBoardDocument(boards, "variable");
  const system = doc.designSystem!;
  system.collections.palette.modes.push({ id: "dark", name: "Dark" });
  system.variables.brand.values = { light: "#112233", dark: "#445566" };
  return doc;
}

async function assertDistinctRevisionTwoCaptures(
  before: DesignDocument,
  after: DesignDocument,
) {
  const file = new BrowserDocumentRepository(source.sourceFileKey);
  const repo = new IndexedDbProjectMemoryRepository();
  const capture = async (document: DesignDocument) => {
    assert.equal(document.revision, 2);
    await file.save(document);
    const reopened = new BrowserDocumentRepository(file.key);
    const persisted = (await reopened.load())!;
    const receipt = await repo.saveEpisodeWithReceipt(
      buildManualEpisodeFromSelection({
        ...archive,
        document: persisted,
        selectionIds: [],
        sourceLifetimeToken: reopened.getLifetimeToken(),
        sourceDocumentEpoch: reopened.getDocumentEpoch(),
      }),
    );
    assert.equal(receipt.durable, true);
    assert.match(receipt.episode.snapshotKey!, /^v2:/);
    return receipt.episode;
  };
  const first = await capture(before);
  const second = await capture(after);
  assert.deepEqual(first.screens, second.screens);
  assert.ok(first.thumbnailSvg);
  assert.equal(first.thumbnailSvg, second.thumbnailSvg);
  assert.notEqual(first.snapshotKey, second.snapshotKey);
  const rows = await new IndexedDbProjectMemoryRepository().listEpisodes(
    scope,
    { requireDurable: true },
  );
  assert.deepEqual(
    rows.map((row) => row.snapshotKey).sort(),
    [first.snapshotKey, second.snapshotKey].sort(),
  );
}

async function embedTestFont(doc: DesignDocument, name: string) {
  const bytes = await readFile(
    new URL("./fixtures/forma-geometry-test.ttf", import.meta.url),
  );
  const fontKey = "font-" + createHash("sha256").update(bytes).digest("hex");
  doc.fonts = {
    [fontKey]: {
      name,
      weight: 400,
      axes: [],
      data: "data:font/ttf;base64," + bytes.toString("base64"),
    },
  };
  return fontKey;
}

function applyBoldFont(beforeDoc: DesignDocument, fontId: string) {
  const prompt = "Update the embedded font weight";
  const { document: afterDoc } = validateProposalSnapshot(
    { prompt, document: beforeDoc, selection: null },
    {
      baseRevision: beforeDoc.revision,
      operations: [
        {
          type: "putFont",
          id: fontId,
          font: { ...beforeDoc.fonts![fontId], weight: 700 },
        },
      ],
    },
  );
  assert.equal(afterDoc.fonts![fontId].weight, 700);
  const capture = buildEpisodeFromAppliedProposal({
    ...archive,
    beforeDoc,
    afterDoc,
    prompt,
    createdRootIds: [],
  });
  return { afterDoc, capture };
}

for (const family of ["Forma Test", "Forma, Test"]) {
  test(`a secondary-board rich-text run fingerprints the quoted family "${family}" across a weight change at revision 2`, async () => {
    const { restore } = memoryDatabaseForReconnect();
    try {
      const first = layer("frame", "one", "Primary");
      const second = layer("frame", "two", "Secondary");
      const label = layer("text", "label", "Label", second.id);
      label.text = "Sample";
      label.textRuns = [
        {
          start: 0,
          end: 6,
          style: { fontFamily: `System, "${family}", serif` },
        },
      ];
      const before = design([first, second, label]);
      before.revision = 2;
      const fontKey = await embedTestFont(before, family);
      const after = structuredClone(before);
      after.fonts![fontKey].weight = 700;
      await assertDistinctRevisionTwoCaptures(before, after);
    } finally {
      restore();
    }
  });
}

for (const [family, reference, binding] of [
  ["Forma Test", "embedded ID"],
  ["Forma, Test", '"FORMA, TEST"'],
  ["Forma, Test", String.raw`"\46 orma, Test"`],
  ["Forma, Test", "uppercase embedded ID"],
  ["Straße", "STRASSE"],
  ["Straße", '"STRAẞE"'],
  ["Forma, Test", "Forma\\,\t   Test"],
  ["F🚀7\uFFFD\uFFFD\uFFFD", "'\\46\r\n\\01f6807\\0\t\\d800\f\\110000'"],
  ["Forma's, Test", "'Forma\\'s, Test'", "text style"],
] as const) {
  test(`a secondary-board inactive font alias using ${JSON.stringify(reference)} fingerprints its weight at revision 2`, async () => {
    const { restore } = memoryDatabaseForReconnect();
    try {
      const before = twoModeBoardDocument(2);
      const fontKey = await embedTestFont(before, family);
      const label = layer("text", "label", "Label", "board-2");
      label.text = "Sample";
      if (binding === "text style") {
        before.designSystem!.styles.heading = {
          id: "heading",
          name: "Heading",
          kind: "text",
          description: "",
          properties: {},
          bindings: { fontFamily: "family" },
        };
        label.styleBindings = { text: "heading" };
      } else label.variableBindings = { fontFamily: "family" };
      before.nodes.push(label);
      const variables = before.designSystem!.variables;
      variables.family = {
        ...variables.brand,
        id: "family",
        name: "Family",
        type: "string",
        values: { light: "serif", dark: { alias: "dark-family" } },
      };
      variables["dark-family"] = {
        ...variables.family,
        id: "dark-family",
        name: "Dark family",
        values: {
          light: "sans-serif",
          dark:
            reference === "embedded ID"
              ? fontKey
              : reference === "uppercase embedded ID"
                ? fontKey.toUpperCase()
                : reference,
        },
      };
      const { afterDoc, capture } = applyBoldFont(before, fontKey);
      assert.deepEqual(
        capture.screens.map((s) => s.rootId),
        ["board-2"],
      );
      await assertDistinctRevisionTwoCaptures(
        { ...before, revision: 2 },
        afterDoc,
      );
    } finally {
      restore();
    }
  });
}

for (const [family, reference] of [
  ["Local Face", "font ID before a CSS comment"],
  ["Straße", '"STRAẞE"'],
] as const) {
  test(`putFont recognizes ${reference} and keeps both revision-2 weights`, async () => {
    const { restore } = memoryDatabaseForReconnect();
    try {
      const before = boundBoardDocument(2, "variable");
      const fontId = await embedTestFont(before, family);
      const label = layer("text", "label", "Label", "board-2");
      label.style.fontFamily =
        family === "Local Face" ? fontId + " /* local */, serif" : reference;
      before.nodes.push(label);
      const { afterDoc, capture } = applyBoldFont(before, fontId);
      assert.deepEqual(
        capture.screens.map((s) => s.rootId),
        ["board-2"],
      );
      await assertDistinctRevisionTwoCaptures(
        { ...before, revision: 2 },
        afterDoc,
      );
    } finally {
      restore();
    }
  });
}

for (const [family, bound, other] of [
  ["Atlas  Sans", '"Atlas  Sans"', '"Atlas Sans"'],
  ["system-ui", '"system-ui"', "system-ui"],
  ["system-ui", '"system-ui"', String.raw`s\79 stem-ui`],
  ["Brand", '"Brand"', 'Ahem!, "Brand"'],
  ["Atlas Sans", "Atlas/* , */   Sans/* unfinished", '"Atlas  Sans"'],
  ["A/*,*/B", "'A/*,*/B'", "A/*,*/B"],
  ["Atlas", "'At\\\r\nlas'", "serif"],
] as const) {
  test(`putFont selects only board-25 for ${JSON.stringify(bound)} among 24 references to ${JSON.stringify(other)}`, async () => {
    const before = boundBoardDocument(25, "variable");
    const fontId = await embedTestFont(before, family);
    for (const board of before.nodes.slice()) {
      const label = layer("text", "label-" + board.id, "Label", board.id);
      label.style.fontFamily = board.id === "board-25" ? bound : other;
      before.nodes.push(label);
    }
    const { capture } = applyBoldFont(before, fontId);
    assert.deepEqual(
      capture.screens.map((s) => s.rootId),
      ["board-25"],
    );
  });
}

for (const field of ["weight", "data"] as const) {
  test(`a v2 archive includes embedded font ${field} even outside the selected board`, async () => {
    const { restore } = memoryDatabaseForReconnect();
    try {
      const before = design([layer("frame", "board", "Board")]);
      before.revision = 2;
      const id = await embedTestFont(before, "Straße");
      const label = layer("text", "label", "Label");
      label.style.fontFamily = '"STRAẞE"';
      before.activePage = "first";
      before.pages = [
        { id: "first", name: "Page 1" },
        { id: "second", name: "Page 2", nodes: [label] },
      ];
      const after = structuredClone(before);
      if (field === "weight") after.fonts![id].weight = 700;
      else {
        const [header, encoded] = before.fonts![id].data.split(",");
        const padded = Buffer.concat([
          Buffer.from(encoded, "base64"),
          Buffer.alloc(4),
        ]);
        after.fonts![id].data = header + "," + padded.toString("base64");
      }
      assert.notEqual(before.fonts![id][field], after.fonts![id][field]);
      await assertDistinctRevisionTwoCaptures(before, after);
    } finally {
      restore();
    }
  });
}

for (const binding of [
  "variable",
  "style binding",
  "node gradient",
  "style gradient",
] as const) {
  test(`changing an inactive mode behind a ${binding} on a secondary board changes its durable fingerprint`, async () => {
    const { restore } = memoryDatabaseForReconnect();
    try {
      const before = twoModeBoardDocument(
        binding === "style gradient" ? 25 : 2,
      );
      before.revision = 2;
      const board = before.nodes.at(-1)!;
      const system = before.designSystem!;
      if (binding !== "variable") {
        system.variables.accent = {
          ...system.variables.brand,
          id: "accent",
          name: "Accent",
          values: { light: "#112233", dark: "#556677" },
        };
        system.variables.brand.values.dark = { alias: "accent" };
        const gradient: NonNullable<DesignNode["style"]["gradient"]> = {
          type: "linear",
          angle: 0,
          stops: [
            { offset: 0, color: "#112233", opacity: 1, variableId: "brand" },
            { offset: 1, color: "#ffffff", opacity: 1 },
          ],
        };
        delete board.variableBindings;
        if (binding === "node gradient") board.style.gradient = gradient;
        else {
          system.styles.surface = {
            id: "surface",
            name: "Surface",
            kind: "paint",
            description: "",
            properties: binding === "style gradient" ? { gradient } : {},
            bindings: binding === "style binding" ? { fill: "brand" } : {},
          };
          board.styleBindings = { paint: "surface" };
        }
      }
      const after = structuredClone(before);
      const variable = binding === "variable" ? "brand" : "accent";
      after.designSystem!.variables[variable].values.dark = "#cc0033";
      await assertDistinctRevisionTwoCaptures(before, after);
    } finally {
      restore();
    }
  });
}

for (const [binding, inactive] of [
  ["fillToken", false],
  ["variable", false],
  ["fillToken", true],
  ["variable", true],
] as const) {
  test(`a ${binding}-only proposal on the ${inactive ? "inactive" : "active"} page archives the bound board and its updated thumbnail after reopening`, async () => {
    const { restore } = memoryDatabaseForReconnect();
    try {
      const file = new BrowserDocumentRepository(source.sourceFileKey);
      const document = boundBoardDocument(2, binding);
      if (inactive) {
        document.activePage = "one";
        document.pages = [
          { id: "one", name: "Page 1" },
          { id: "two", name: "Page 2", nodes: document.nodes.splice(1) },
        ];
      }
      await file.save(document);
      const reopened = new BrowserDocumentRepository(file.key);
      const beforeDoc = (await reopened.load())!;
      const system = structuredClone(beforeDoc.designSystem);
      if (system) system.variables.brand.values.light = "#ff0000";
      const op = system
        ? { type: "setDesignSystem", system }
        : {
            type: "putToken",
            id: "brand",
            token: { name: "Brand", value: "#ff0000" },
          };
      const prompt = "Change the brand color";
      const { document: afterDoc } = validateProposalSnapshot(
        { prompt, document: beforeDoc, selection: null },
        { baseRevision: beforeDoc.revision, operations: [op] },
      );
      assert.deepEqual(afterDoc.nodes, beforeDoc.nodes);
      await reopened.save(afterDoc);
      const capture = buildEpisodeFromAppliedProposal({
        ...archive,
        prompt,
        beforeDoc,
        afterDoc,
        createdRootIds: [],
        sourceLifetimeToken: reopened.getLifetimeToken(),
        sourceDocumentEpoch: reopened.getDocumentEpoch(),
      });
      const { durable, episode } =
        await new IndexedDbProjectMemoryRepository().saveEpisodeWithReceipt(
          capture,
        );
      assert.equal(durable, true);
      assert.deepEqual(
        episode.screens.map((screen) => screen.rootId),
        ["board-2"],
      );
      assert.match(episode.thumbnailSvg!, /#ff0000/i);
      assert.deepEqual(
        await new IndexedDbProjectMemoryRepository().listEpisodes(scope),
        [episode],
      );
    } finally {
      restore();
    }
  });
}

test("putFont archives only board-25 when 24 system-ui labels contain the embedded family name", async () => {
  const beforeDoc = boundBoardDocument(25, "variable");
  const fontId = await embedTestFont(beforeDoc, "Brand");
  const vars = beforeDoc.designSystem!.variables;
  vars["var-brand-label"] = {
    ...vars.brand,
    id: "var-brand-label",
    name: "Brand label",
    type: "string",
    values: { light: "Brand" },
  };
  for (const board of beforeDoc.nodes.slice()) {
    const label = layer("text", "label-" + board.id, "Label", board.id);
    if (board.id === "board-25") label.style.fontFamily = "Brand";
    else {
      label.style.fontFamily = "system-ui";
      label.variableBindings = { text: "var-brand-label" };
    }
    beforeDoc.nodes.push(label);
  }
  const { capture } = applyBoldFont(beforeDoc, fontId);
  assert.deepEqual(
    capture.screens.map((screen) => screen.rootId),
    ["board-25"],
  );
});

for (const change of ["mode switch", "inactive value"] as const) {
  test(`a palette ${change} behind 24 inactive aliases selects the affected board across pages`, () => {
    const beforeDoc = twoModeBoardDocument(25);
    const system = beforeDoc.designSystem!;
    system.collections.theme = {
      ...system.collections.palette,
      id: "theme",
      name: "Theme",
    };
    system.activeModes.theme = "light";
    system.variables["palette-accent"] = {
      ...system.variables.brand,
      id: "palette-accent",
      name: "Accent",
    };
    system.variables.theme = {
      ...system.variables.brand,
      id: "theme",
      collectionId: "theme",
      values: { light: "#ffffff", dark: { alias: "palette-accent" } },
    };
    for (const board of beforeDoc.nodes) {
      board.variableBindings = {
        fill: board.id === "board-25" ? "palette-accent" : "theme",
      };
    }
    beforeDoc.activePage = "first";
    beforeDoc.pages = [
      { id: "first", name: "Page 1" },
      { id: "second", name: "Page 2", nodes: beforeDoc.nodes.splice(24) },
    ];
    const next = structuredClone(system);
    if (change === "mode switch") next.activeModes.palette = "dark";
    else next.variables.theme.values.dark = "#112233";
    const { document: afterDoc } = validateProposalSnapshot(
      { prompt: change, document: beforeDoc, selection: null },
      {
        baseRevision: beforeDoc.revision,
        operations: [{ type: "setDesignSystem", system: next }],
      },
    );
    const capture = buildEpisodeFromAppliedProposal({
      ...archive,
      beforeDoc,
      afterDoc,
      prompt: change,
      createdRootIds: [],
    });
    if (change === "mode switch") {
      assert.deepEqual(
        capture.screens.map((s) => s.rootId),
        ["board-25"],
      );
      assert.match(capture.thumbnailSvg!, /<title>Board 25<\/title>/);
      assert.match(capture.thumbnailSvg!, /#445566/i);
    } else {
      assert.deepEqual(
        capture.screens.map((s) => s.rootId),
        beforeDoc.nodes.map((n) => n.id),
      );
      assert.match(capture.thumbnailSvg!, /#ffffff/i);
    }
  });
}

for (const sameFill of [false, true]) {
  test(`a global palette mode switch archives only board-25 on page two after 24 ${sameFill ? "bound boards with identical fills" : "unbound boards"}`, () => {
    const beforeDoc = twoModeBoardDocument(25);
    if (sameFill) {
      const variables = beforeDoc.designSystem!.variables;
      variables["var-same"] = {
        ...variables.brand,
        id: "var-same",
        name: "Same",
        values: { light: "#fafafa", dark: "#fafafa" },
      };
      variables["var-diff"] = {
        ...variables.brand,
        id: "var-diff",
        name: "Different",
      };
      for (const board of beforeDoc.nodes)
        board.variableBindings = {
          fill: board.id === "board-25" ? "var-diff" : "var-same",
        };
    }
    beforeDoc.activePage = "first";
    beforeDoc.pages = [
      { id: "first", name: "Page 1" },
      { id: "second", name: "Page 2", nodes: beforeDoc.nodes.splice(24) },
    ];
    const system = structuredClone(beforeDoc.designSystem!);
    system.activeModes.palette = "dark";
    const prompt = "Switch the palette to dark";
    const { document: afterDoc } = validateProposalSnapshot(
      { prompt, document: beforeDoc, selection: null },
      {
        baseRevision: beforeDoc.revision,
        operations: [{ type: "setDesignSystem", system }],
      },
    );
    const capture = buildEpisodeFromAppliedProposal({
      ...archive,
      beforeDoc,
      afterDoc,
      prompt,
      createdRootIds: [],
    });
    assert.deepEqual(
      capture.screens.map((s) => s.rootId),
      ["board-25"],
    );
    assert.match(capture.thumbnailSvg!, /<title>Board 25<\/title>/);
    assert.match(capture.thumbnailSvg!, /#445566/i);
    assert.doesNotMatch(capture.thumbnailSvg!, /#112233/i);
  });
}

test("per-board palette overrides archive only the board whose resolved fill changes", () => {
  const beforeDoc = twoModeBoardDocument(25);
  const variables = beforeDoc.designSystem!.variables;
  variables.same = {
    ...variables.brand,
    id: "same",
    name: "Same fill",
    values: { light: "#fafafa", dark: "#fafafa" },
  };
  for (const board of beforeDoc.nodes.slice(0, 24))
    board.variableBindings = { fill: "same" };
  const prompt = "Use dark mode on all boards";
  const { document: afterDoc } = validateProposalSnapshot(
    { prompt, document: beforeDoc, selection: null },
    {
      baseRevision: beforeDoc.revision,
      operations: beforeDoc.nodes.map(({ id }) => ({
        type: "update",
        id,
        patch: { variableModes: { palette: "dark" } },
      })),
    },
  );
  const capture = buildEpisodeFromAppliedProposal({
    ...archive,
    beforeDoc,
    afterDoc,
    prompt,
    createdRootIds: [],
  });
  assert.deepEqual(
    capture.screens.map((s) => s.rootId),
    ["board-25"],
  );
  assert.match(capture.thumbnailSvg!, /<title>Board 25<\/title>/);
  assert.match(capture.thumbnailSvg!, /#445566/i);
});

test("an equal-value mode switch still selects the bound board in the fallback pass and changes its revision-2 snapshot", async () => {
  const { restore } = memoryDatabaseForReconnect();
  try {
    const beforeDoc = twoModeBoardDocument(2);
    beforeDoc.designSystem!.variables.brand.values = {
      light: "#fafafa",
      dark: "#fafafa",
    };
    const system = structuredClone(beforeDoc.designSystem!);
    system.activeModes.palette = "dark";
    const prompt = "Switch the palette to dark";
    const { document: afterDoc } = validateProposalSnapshot(
      { prompt, document: beforeDoc, selection: null },
      {
        baseRevision: beforeDoc.revision,
        operations: [{ type: "setDesignSystem", system }],
      },
    );
    const capture = buildEpisodeFromAppliedProposal({
      ...archive,
      prompt,
      beforeDoc,
      afterDoc,
      createdRootIds: [],
    });
    assert.deepEqual(
      capture.screens.map((s) => s.rootId),
      ["board-2"],
    );
    await assertDistinctRevisionTwoCaptures(
      { ...beforeDoc, revision: 2 },
      afterDoc,
    );
  } finally {
    restore();
  }
});

test("one proposal collects boards on the active and a newly added page and previews the primary on that page", () => {
  const beforeDoc = design([layer("frame", "active", "Old name")]);
  const afterDoc = checkoutDesign();
  const newPageNodes = afterDoc.nodes;
  afterDoc.nodes = [{ ...beforeDoc.nodes[0], name: "Edited active board" }];
  afterDoc.pages = [
    { id: "first", name: "First" },
    { id: "new", name: "New", nodes: newPageNodes },
  ];
  const episode = buildEpisodeFromAppliedProposal({
    ...archive,
    prompt: "New checkout",
    beforeDoc,
    afterDoc,
    createdRootIds: ["main", "sheet"],
    screenRoles: { active: "detail", sheet: "overlay", main: "primary" },
  });
  assert.deepEqual(
    episode.screens.map((board) => board.rootId),
    ["active", "sheet", "main"],
  );
  assert.equal(
    episode.componentsUsed.find((c) => c.componentId === "pay")?.count,
    2,
  );
  assert.deepEqual(episode.customModules, ["配送方式"]);
  assert.match(episode.thumbnailSvg!, /<title>结算<\/title>/);
  assert.match(episode.thumbnailSvg!, /确认支付/);
});

test("proposal thumbnail resolves the board's inherited Section dark mode before detaching it", () => {
  const beforeDoc = twoModeBoardDocument(1);
  const section = layer("section", "section", "Dark section");
  section.variableModes = { palette: "dark" };
  beforeDoc.nodes[0].parentId = section.id;
  beforeDoc.nodes.unshift(section);
  const system = structuredClone(beforeDoc.designSystem!);
  system.variables.brand.values.dark = "#cc0033";
  const prompt = "Change the dark color";
  const { document: afterDoc } = validateProposalSnapshot(
    { prompt, document: beforeDoc, selection: null },
    {
      baseRevision: beforeDoc.revision,
      operations: [{ type: "setDesignSystem", system }],
    },
  );
  const capture = buildEpisodeFromAppliedProposal({
    ...archive,
    prompt,
    beforeDoc,
    afterDoc,
    createdRootIds: [],
  });
  assert.deepEqual(
    capture.screens.map((screen) => screen.rootId),
    ["board-1"],
  );
  assert.match(capture.thumbnailSvg!, /#cc0033/i);
  assert.doesNotMatch(capture.thumbnailSvg!, /#112233/i);
});

for (const kind of ["legacy", "modern"] as const) {
  test(`a mounted drawer and composer reject the retired ${kind} capture after its ID is reused`, async () => {
    const { restore } = memoryDatabaseForReconnect();
    const css = registerHooks({
      load(url, context, next) {
        return url.endsWith(".css")
          ? { format: "module", source: "", shortCircuit: true }
          : next(url, context);
      },
    });
    const doc = new DOMParser().parseFromString("<html/>", "text/html");
    const create = doc.createElement.bind(doc),
      createNS = doc.createElementNS.bind(doc);
    const noop = () => {};
    const element = (el: Element) =>
      Object.assign(el, {
        style: { setProperty: noop },
        options: [],
        focus: noop,
        scrollIntoView: noop,
        addEventListener: noop,
        removeEventListener: noop,
      });
    Object.assign(doc, {
      createElement: (name: string) => element(create(name)),
      createElementNS: (ns: string, name: string) =>
        element(createNS(ns, name)),
      addEventListener: noop,
    });
    const host = doc.createElement("div");
    const events = new EventTarget();
    host.addEventListener = events.addEventListener.bind(events);
    const requests: string[] = [];
    const restoreDom = replaceGlobals({
      document: doc,
      window: Object.assign(new EventTarget(), {
        document: doc,
        HTMLIFrameElement: class {},
      }),
      fetch: async (url: string) => {
        requests.push(url);
        throw Error("Unexpected request");
      },
      IS_REACT_ACT_ENVIRONMENT: true,
    });
    const { createElement, act } = await import("react");
    const root = (await import("react-dom/client")).createRoot(host);
    try {
      const { AgentPanel } = await import("../src/editor/AgentPanel");
      const document = design([layer("frame", "board", "Archived board")]);
      const file = new BrowserDocumentRepository(source.sourceFileKey);
      await file.save(document);
      const peer = new IndexedDbProjectMemoryRepository();
      const original =
        kind === "legacy"
          ? episode("ep-snapshot-legacy-reused", {
              snapshotKey: "ep-snapshot-legacy-reused",
              title: "Original legacy",
              createdAt: "2026-01-01T00:00:00.000Z",
              sourceLifetimeToken: file.getLifetimeToken(),
            })
          : buildManualEpisodeFromSelection({
              ...archive,
              document,
              selectionIds: ["board"],
              title: "Original modern",
              sourceLifetimeToken: file.getLifetimeToken(),
              sourceDocumentEpoch: file.getDocumentEpoch(),
            });
      const { episode: selected, durable } =
        await peer.saveEpisodeWithReceipt(original);
      assert.equal(durable, true);
      const id = selected.id;
      const identity = episodeIdentityKey(selected);
      let refresh = signal();
      await act(() =>
        root.render(
          createElement(AgentPanel, {
            document,
            fileKey: file.key,
            activeProject: null,
            projectEpisodes: [selected],
            getFileLifetimeToken: () => file.getLifetimeToken(),
            getFileDocumentEpoch: () => file.getDocumentEpoch(),
            selection: null,
            selectionCount: 0,
            onRefreshEpisodes: () => refresh.resolve(),
            status: {
              configured: true,
              activeProfile: null,
              activeProfileId: null,
              profiles: [],
            },
          }),
        ),
      );
      const click = async (label: string, finished?: Promise<void>) => {
        const button = Array.from(host.getElementsByTagName("button")).find(
          (b) =>
            b.getAttribute("aria-label") === label ||
            b.textContent?.trim() === label ||
            b.getAttribute("class") === label,
        );
        assert.ok(button && !button.hasAttribute("disabled"), label);
        const event = new Event("click", { bubbles: true });
        Object.defineProperty(event, "target", { value: button });
        await act(async () => {
          events.dispatchEvent(event);
          await finished;
        });
      };
      await click("历史需求档案");
      if (kind === "legacy") await click("@引用");
      assert.equal(await peer.deleteEpisode(id), true);
      const recaptured = await peer.saveEpisode(
        kind === "modern"
          ? original
          : {
              ...original,
              title: "Replacement legacy",
              createdAt: "2026-01-02T00:00:00.000Z",
            },
      );
      assert.equal(recaptured.id, id);
      assert.equal(recaptured.snapshotKey, selected.snapshotKey);
      if (kind === "modern")
        assert.notEqual(recaptured.captureId, selected.captureId);
      else assert.ok(recaptured.createdAt > selected.createdAt);
      assert.notEqual(episodeIdentityKey(recaptured), identity);
      const replacement = await peer.updateEpisode(id, {
        title: "Peer rename",
        pinned: true,
      });
      assert.ok(replacement?.pinned);
      assert.equal(
        episodeIdentityKey(replacement),
        episodeIdentityKey(recaptured),
      );
      if (kind === "modern") await click("@引用");
      assert.ok(host.textContent!.includes("已引用「" + selected.title + "」"));
      for (const label of ["置顶", "删除档案"]) {
        refresh = signal();
        await click(label, refresh.promise);
        assert.match(host.textContent!, /已变更或由新版本替代/);
        assert.deepEqual(await peer.getEpisode(id), replacement);
      }
      await click("agent-quick-chip");
      refresh = signal();
      await click("生成设计", refresh.promise);
      assert.match(host.textContent!, /所引用的历史需求档案已变更或删除/);
      assert.deepEqual(requests, []);
      assert.deepEqual(
        await new IndexedDbProjectMemoryRepository().listEpisodes(scope, {
          requireDurable: true,
        }),
        [replacement],
      );
    } finally {
      await act(() => root.unmount());
      restoreDom();
      css.deregister();
      restore();
    }
  });
}

test("an offline guarded delete preserves another tab's same-millisecond recapture of the same board", async () => {
  const { state, restore } = memoryDatabaseForReconnect();
  let time = Date.parse(date);
  const clock = mock.method(Date, "now", () => time);
  try {
    const document = design([layer("frame", "board", "Board")]);
    const file = new BrowserDocumentRepository(source.sourceFileKey);
    await file.save(document);
    const tabA = await isolatedMemoryTab();
    const tabB = await isolatedMemoryTab();
    const offline = new tabA.IndexedDbProjectMemoryRepository();
    const online = new tabB.IndexedDbProjectMemoryRepository();
    const snapshot = buildManualEpisodeFromSelection({
      ...archive,
      document,
      selectionIds: ["board"],
      sourceLifetimeToken: file.getLifetimeToken(),
      sourceDocumentEpoch: file.getDocumentEpoch(),
    });
    const original = await online.saveEpisode(snapshot);
    time += 1000;
    state.denials = 2;
    const session = await offline.saveEpisodeWithReceipt(snapshot);
    assert.equal(session.durable, false);
    assert.ok(
      await offline.deleteEpisode(session.episode.id, {
        sourceFileKey: file.key,
        expectedScopeId: scope,
        expectedLifetimeToken: file.getLifetimeToken(),
        expectedDocId: document.id,
        expectedDocumentEpoch: file.getDocumentEpoch(),
        expectedIdentityKey: episodeIdentityKey(session.episode),
      }),
    );
    assert.ok(await online.deleteEpisode(original.id));
    const replacement = await online.saveEpisodeWithReceipt(snapshot);
    assert.ok(replacement.durable);
    assert.equal(replacement.episode.id, session.episode.id);
    assert.equal(replacement.episode.snapshotKey, session.episode.snapshotKey);
    assert.equal(replacement.episode.createdAt, session.episode.createdAt);
    const rows = await offline.listEpisodes(scope, { requireDurable: true });
    assert.deepEqual(rows, [replacement.episode]);
    assert.deepEqual(
      await new IndexedDbProjectMemoryRepository().listEpisodes(scope, {
        requireDurable: true,
      }),
      rows,
    );
    assert.ok(session.episode.captureId && replacement.episode.captureId);
    assert.notEqual(session.episode.captureId, replacement.episode.captureId);
    assert.notEqual(
      episodeIdentityKey(session.episode),
      episodeIdentityKey(replacement.episode),
    );
    assert.deepEqual(await online.saveEpisode(snapshot), replacement.episode);
  } finally {
    clock.mock.restore();
    restore();
  }
});

for (const scenario of [
  "room available",
  "99 pins",
  "99 pins and a peer finishing publication",
  "pin then unpin",
  "all pinned",
] as const) {
  test(`an offline guarded pin replays after another tab archives a different board 60 seconds later with ${scenario}`, async () => {
    const { disk, state, restore } = memoryDatabaseForReconnect();
    let time = Date.now();
    const clock = mock.method(Date, "now", () => time);
    try {
      const document = design([
        layer("frame", "alpha", "Alpha"),
        layer("frame", "beta", "Beta"),
      ]);
      const file = new BrowserDocumentRepository(source.sourceFileKey);
      await file.save(document);
      const capture = (id: string) =>
        buildManualEpisodeFromSelection({
          ...archive,
          document,
          selectionIds: [id],
          sourceLifetimeToken: file.getLifetimeToken(),
          sourceDocumentEpoch: file.getDocumentEpoch(),
        });
      const offline = new IndexedDbProjectMemoryRepository();
      const original = Array.from(
        { length: scenario === "room available" ? 0 : 99 },
        (_, i) => episode("existing-" + i, { pinned: true }),
      );
      disk.set("episodes", new Map(original.map((row) => [row.id, row])));
      state.denials = scenario === "pin then unpin" ? 3 : 2;
      const { episode: alpha, durable } = await offline.saveEpisodeWithReceipt(
        capture("alpha"),
      );
      assert.equal(durable, false);
      const guard = {
        sourceFileKey: file.key,
        expectedScopeId: scope,
        expectedIdentityKey: episodeIdentityKey(alpha),
        expectedLifetimeToken: file.getLifetimeToken(),
        expectedDocId: document.id,
        expectedDocumentEpoch: file.getDocumentEpoch(),
      };
      const pinned = await offline.updateEpisode(
        alpha.id,
        { pinned: true },
        guard,
      );
      assert.equal(pinned?.pinned, true);
      if (scenario === "pin then unpin")
        assert.equal(
          (await offline.updateEpisode(alpha.id, { pinned: false }, guard))
            ?.pinned,
          false,
        );
      time += 60_000;
      const tabB = await isolatedMemoryTab();
      const online = new tabB.IndexedDbProjectMemoryRepository();
      const beta = await online.saveEpisodeWithReceipt(capture("beta"));
      assert.ok(beta.durable);
      assert.equal(
        Date.parse(beta.episode.createdAt) - Date.parse(alpha.createdAt),
        60_000,
      );
      if (scenario === "all pinned")
        assert.ok(
          (await online.updateEpisode(beta.episode.id, { pinned: true }))
            ?.pinned,
        );
      const peerFinishes =
        scenario === "99 pins and a peer finishing publication";
      const authorized = signal(),
        resume = signal();
      if (peerFinishes) {
        state.afterStudioCommit = (keys) => {
          if (!keys.some((key) => key.startsWith(commitPrefix))) return;
          state.afterStudioCommit = () => undefined;
          authorized.resolve();
          return resume.promise;
        };
      }
      const replay = offline.listEpisodes(scope, { requireDurable: true });
      if (peerFinishes) {
        try {
          await Promise.race([
            authorized.promise,
            replay.then(() => assert.fail("archive missed authorization")),
          ]);
          const staged = await online.listEpisodes(scope, {
            requireDurable: true,
          });
          assert.deepEqual(
            staged.find((row) => row.id === alpha.id),
            pinned,
          );
          assert.ok(!staged.some((row) => row.id === beta.episode.id));
        } finally {
          resume.resolve();
          await replay;
        }
      }
      await replay;
      assert.equal(await offline.isDurable(), true);
      const rows = await new IndexedDbProjectMemoryRepository().listEpisodes(
        scope,
        { requireDurable: true },
      );
      if (scenario === "room available") {
        assert.deepEqual(rows, [pinned, beta.episode]);
      } else {
        assert.equal(rows.length, 100);
        assert.equal(
          rows.filter((row) => row.pinned).length,
          scenario === "pin then unpin" ? 99 : 100,
        );
        const keepAlpha = scenario === "99 pins" || peerFinishes;
        const preserved = keepAlpha ? pinned! : beta.episode;
        assert.deepEqual(
          new Set(rows.map((row) => row.id)),
          new Set([...original.map((row) => row.id), preserved.id]),
        );
        if (keepAlpha)
          assert.deepEqual(
            rows.find((row) => row.id === alpha.id),
            pinned,
          );
      }
    } finally {
      clock.mock.restore();
      restore();
    }
  });
}

for (const scenario of [
  "original ID",
  "different durable ID",
  "two pending pins",
  "peer publishes B",
  "later unpin",
] as const) {
  test(`replaying save B honors the later pin of A after a peer saves C (${scenario})`, async () => {
    const { disk, state, restore } = memoryDatabaseForReconnect();
    let time = Date.now();
    const clock = mock.method(Date, "now", () => time);
    try {
      const document = design(
        ["A", "B", "C", "D"].map((id) => layer("frame", id, id)),
      );
      const file = new BrowserDocumentRepository(source.sourceFileKey);
      await file.save(document);
      const capture = (id: string) =>
        buildManualEpisodeFromSelection({
          ...archive,
          document,
          selectionIds: [id],
          sourceLifetimeToken: file.getLifetimeToken(),
          sourceDocumentEpoch: file.getDocumentEpoch(),
        });
      const twoPins = scenario === "two pending pins";
      const originals = Array.from({ length: twoPins ? 97 : 98 }, (_, i) =>
        episode("original-" + i, { pinned: true }),
      );
      disk.set("episodes", new Map(originals.map((row) => [row.id, row])));
      const offline = new IndexedDbProjectMemoryRepository();
      const tab = await isolatedMemoryTab();
      const peer = new tab.IndexedDbProjectMemoryRepository();
      state.denials = twoPins ? 2 : 1;
      const a = await offline.saveEpisodeWithReceipt(capture("A"));
      assert.equal(a.durable, false);
      const d = twoPins
        ? await offline.saveEpisodeWithReceipt(capture("D"))
        : undefined;
      if (d) assert.equal(d.durable, false);
      time += 60_000;
      const c = await peer.saveEpisodeWithReceipt(capture("C"));
      assert.ok(c.durable);
      const durableId =
        scenario === "different durable ID" ? "durable-A" : a.episode.id;
      if (scenario === "different durable ID") {
        const copy = await peer.saveEpisodeWithReceipt({
          ...a.episode,
          id: durableId,
        });
        assert.ok(copy.durable);
        assert.equal(copy.episode.id, durableId);
        assert.equal(
          episodeIdentityKey(copy.episode),
          episodeIdentityKey(a.episode),
        );
      }
      time += 60_000;
      state.denials = scenario === "later unpin" || twoPins ? 3 : 2;
      const b = await offline.saveEpisodeWithReceipt(capture("B"));
      assert.equal(b.durable, false);
      const guard = {
        sourceFileKey: file.key,
        expectedScopeId: scope,
        expectedIdentityKey: episodeIdentityKey(a.episode),
        expectedLifetimeToken: file.getLifetimeToken(),
        expectedDocId: document.id,
        expectedDocumentEpoch: file.getDocumentEpoch(),
      };
      assert.equal(
        (await offline.updateEpisode(a.episode.id, { pinned: true }, guard))
          ?.pinned,
        true,
      );
      if (d)
        assert.equal(
          (
            await offline.updateEpisode(
              d.episode.id,
              { pinned: true },
              {
                ...guard,
                expectedIdentityKey: episodeIdentityKey(d.episode),
              },
            )
          )?.pinned,
          true,
        );
      if (scenario === "later unpin")
        assert.equal(
          (await offline.updateEpisode(a.episode.id, { pinned: false }, guard))
            ?.pinned,
          false,
        );
      if (scenario === "peer publishes B") {
        let authorizations = 0;
        const authorized = signal(),
          resume = signal();
        state.afterStudioCommit = (keys) => {
          if (
            keys.some((key) => key.startsWith(commitPrefix)) &&
            ++authorizations === 2
          ) {
            authorized.resolve();
            return resume.promise;
          }
        };
        const replay = offline.isDurable();
        try {
          await Promise.race([
            authorized.promise,
            replay.then(() => assert.fail("B missed authorization")),
          ]);
          const rows = await peer.listEpisodes(scope, { requireDurable: true });
          assert.ok(rows.some((row) => row.id === b.episode.id));
          assert.ok(rows.some((row) => row.id === durableId));
        } finally {
          resume.resolve();
          await replay;
        }
      }
      assert.equal(await offline.isDurable(), true);
      const rows = await new IndexedDbProjectMemoryRepository().listEpisodes(
        scope,
        { requireDurable: true },
      );
      const keepA = scenario !== "later unpin";
      assert.equal(rows.length, 100);
      assert.equal(rows.filter((row) => row.pinned).length, keepA ? 99 : 98);
      assert.deepEqual(
        new Set(rows.filter((row) => row.pinned).map((row) => row.id)),
        new Set([
          ...originals.map((row) => row.id),
          ...(keepA ? [durableId] : []),
          ...(d ? [d.episode.id] : []),
        ]),
      );
      assert.ok(rows.some((row) => row.id === b.episode.id));
      assert.equal(
        rows.some((row) => row.id === c.episode.id),
        !keepA,
      );
    } finally {
      clock.mock.restore();
      restore();
    }
  });
}

function replayCapture(
  id: string,
  file: BrowserDocumentRepository,
  target: string,
  minute: number,
) {
  return episode(id, {
    snapshotKey: "v2:" + id,
    sourceFileKey: file.key,
    sourceLifetimeToken: file.getLifetimeToken(),
    sourceDocumentEpoch: file.getDocumentEpoch(),
    scopeProjectId: target,
    createdAt: new Date(Date.parse(date) + minute * 60_000).toISOString(),
  });
}

function replayPinGuard(row: DesignEpisode) {
  return {
    sourceFileKey: row.sourceFileKey,
    expectedDocId: row.sourceDocId,
    expectedDocumentEpoch: row.sourceDocumentEpoch,
    expectedLifetimeToken: row.sourceLifetimeToken,
    expectedScopeId: row.scopeProjectId,
    expectedIdentityKey: episodeIdentityKey(row),
  };
}

test("a peer publishing C after B's grant sees the replayed pin of A durably", async () => {
  const { disk, state, transactions, restore } = memoryDatabaseForReconnect();
  const resume = signal();
  let replay: Promise<boolean> | undefined;
  try {
    const file = new BrowserDocumentRepository(source.sourceFileKey);
    const other = new BrowserDocumentRepository("file-c");
    await file.save(design([]));
    await other.save(design([]));
    const offline = new IndexedDbProjectMemoryRepository();
    const peer = new (
      await isolatedMemoryTab()
    ).IndexedDbProjectMemoryRepository();
    state.denials = Infinity;
    const project = await offline.createProject({ name: "Shared review" });
    const target = projectScopeId(project.id);
    for (const key of [file.key, other.key])
      await offline.assignFileToProject(key, project.id);
    const a = await offline.saveEpisodeWithReceipt(
      replayCapture("A", file, target, 0),
    );
    const b = await offline.saveEpisodeWithReceipt(
      replayCapture("B", file, target, 2),
    );
    assert.ok(!a.durable && !b.durable);
    const pinned = await offline.updateEpisode(
      "A",
      { pinned: true },
      replayPinGuard(a.episode),
    );
    assert.ok(pinned?.pinned);
    const originals = Array.from({ length: 98 }, (_, i) =>
      episode("base-" + i, { pinned: true, scopeProjectId: target }),
    );
    disk.set("episodes", new Map(originals.map((row) => [row.id, row])));
    const granted = signal();
    let grants = 0;
    state.afterStudioCommit = (keys) => {
      if (
        keys.some((key) => key.startsWith(commitPrefix + "ep-")) &&
        ++grants === 2
      ) {
        granted.resolve();
        return resume.promise;
      }
    };
    state.denials = 0;
    replay = offline.isDurable();
    await Promise.race([
      granted.promise,
      replay.then(() => assert.fail("B missed its grant")),
    ]);
    // C was captured between A and B, but published after B's grant.
    await assert.rejects(
      peer.saveEpisode(replayCapture("C", other, target, 1)),
      { message: fullScopeError },
    );
    assert.deepEqual(await peer.getEpisode("A"), pinned);
    resume.resolve();
    assert.equal(await replay, true);
    const rows = await new IndexedDbProjectMemoryRepository().listEpisodes(
      target,
      { requireDurable: true },
    );
    assert.equal(rows.length, 100);
    assert.equal(rows.filter((row) => row.pinned).length, 99);
    assert.deepEqual(
      rows.find((row) => row.id === "A"),
      pinned,
    );
    assert.ok(rows.some((row) => row.id === "B"));
    assert.ok(!rows.some((row) => row.id === "C"));
    assert.equal(
      transactions.filter((tx) => !tx.aborted && tx.puts.includes("A")).length,
      1,
    );
  } finally {
    resume.resolve();
    await replay;
    restore();
  }
});

for (const sameFile of [true, false]) {
  test(`B's replay grant ${sameFile ? "pins already-durable A" : "leaves A's other-file pin guarded through replacement"}`, async () => {
    const { state, restore } = memoryDatabaseForReconnect();
    const resume = signal();
    let replay: Promise<boolean> | undefined;
    try {
      const file = new BrowserDocumentRepository(source.sourceFileKey);
      const other = new BrowserDocumentRepository("other-file");
      const doc = design([]);
      await file.save(doc);
      await other.save(doc);
      const offline = new IndexedDbProjectMemoryRepository();
      const peer = new (
        await isolatedMemoryTab()
      ).IndexedDbProjectMemoryRepository();
      const project = await peer.createProject({ name: "Shared" });
      const target = projectScopeId(project.id);
      for (const key of [file.key, other.key])
        await peer.assignFileToProject(key, project.id);
      const a = await peer.saveEpisode(replayCapture("A", file, target, 0));
      state.denyAuthorization = true;
      assert.equal(
        (
          await offline.saveEpisodeWithReceipt(
            replayCapture("B", file, target, 2),
          )
        ).durable,
        false,
      );
      const actor = sameFile ? file : other;
      const pinned = await offline.updateEpisode(
        "A",
        { pinned: true },
        {
          ...replayPinGuard(a),
          sourceFileKey: actor.key,
          expectedLifetimeToken: actor.getLifetimeToken(),
          expectedDocumentEpoch: actor.getDocumentEpoch(),
        },
      );
      assert.ok(pinned?.pinned);
      state.denyAuthorization = false;
      const granted = signal();
      state.afterStudioCommit = (keys) => {
        if (!keys.some((key) => key.startsWith(commitPrefix + "ep-"))) return;
        state.afterStudioCommit = () => undefined;
        granted.resolve();
        return resume.promise;
      };
      replay = offline.isDurable();
      await Promise.race([
        granted.promise,
        replay.then(() => assert.fail("B missed its grant")),
      ]);
      assert.deepEqual(await peer.getEpisode("A"), sameFile ? pinned : a);
      assert.ok(await peer.getEpisode("B"));
      if (!sameFile) await actor.save({ ...doc, id: "replacement" });
      resume.resolve();
      assert.equal(await replay, true);
      assert.deepEqual(
        await new IndexedDbProjectMemoryRepository().getEpisode("A"),
        sameFile ? pinned : a,
      );
    } finally {
      resume.resolve();
      await replay;
      restore();
    }
  });
}

for (const scenario of ["peer recapture", "later delete"] as const) {
  test(`99 pins leave room for newer B when A has a ${scenario}`, async () => {
    const { disk, state, restore } = memoryDatabaseForReconnect();
    try {
      const file = new BrowserDocumentRepository(source.sourceFileKey);
      await file.save(design([]));
      const peer = new (
        await isolatedMemoryTab()
      ).IndexedDbProjectMemoryRepository();
      const offline = new IndexedDbProjectMemoryRepository();
      const originals = Array.from({ length: 99 }, (_, i) =>
        episode("base-" + i, { pinned: true }),
      );
      disk.set("episodes", new Map(originals.map((row) => [row.id, row])));
      const snapshot = replayCapture("A", file, scope, 0);
      state.denials = 1;
      const a = await offline.saveEpisodeWithReceipt(snapshot);
      assert.equal(a.durable, false);
      if (scenario === "peer recapture") {
        const independent = await peer.saveEpisode(snapshot);
        assert.equal(independent.id, a.episode.id);
        assert.notEqual(
          episodeIdentityKey(independent),
          episodeIdentityKey(a.episode),
        );
      }
      state.denials = Infinity;
      assert.equal(
        (
          await offline.saveEpisodeWithReceipt(
            replayCapture("B", file, scope, 2),
          )
        ).durable,
        false,
      );
      const guard = replayPinGuard(a.episode);
      assert.ok(
        (await offline.updateEpisode("A", { pinned: true }, guard))?.pinned,
      );
      if (scenario === "later delete")
        assert.ok(await offline.deleteEpisode("A", guard));
      state.denials = 0;
      assert.equal(await offline.isDurable(), true);
      const rows = await new IndexedDbProjectMemoryRepository().listEpisodes(
        scope,
        { requireDurable: true },
      );
      assert.ok(rows.some((row) => row.id === "B"));
      assert.ok(!rows.some((row) => row.id === "A"));
      assert.equal(rows.length, 100);
      assert.equal(rows.filter((row) => row.pinned).length, 99);
    } finally {
      restore();
    }
  });
}

test("replaying a draft migration protects a destination archive pinned later in the journal", async () => {
  const { disk, state, restore } = memoryDatabaseForReconnect();
  try {
    const offline = new IndexedDbProjectMemoryRepository();
    const file = new BrowserDocumentRepository(source.sourceFileKey);
    const draftFile = new BrowserDocumentRepository("draft-file");
    await file.save(design([]));
    await draftFile.save(design([]));
    state.denials = Infinity;
    const project = await offline.createProject({ name: "Migration" });
    const target = projectScopeId(project.id);
    await offline.assignFileToProject(file.key, project.id);
    const a = await offline.saveEpisodeWithReceipt(
      episode("A", {
        scopeProjectId: target,
        createdAt: "2026-01-01T00:00:00.000Z",
        sourceLifetimeToken: file.getLifetimeToken(),
      }),
    );
    assert.equal(a.durable, false);
    const b = await offline.saveEpisodeWithReceipt(
      episode("B", {
        scopeProjectId: fileScopeId(draftFile.key),
        sourceFileKey: draftFile.key,
        sourceLifetimeToken: draftFile.getLifetimeToken(),
      }),
    );
    assert.equal(b.durable, false);
    assert.equal(
      (await offline.assignFileToProject(draftFile.key, project.id))
        .migratedEpisodes,
      1,
    );
    assert.equal(
      (
        await offline.updateEpisode(
          a.episode.id,
          { pinned: true },
          {
            sourceFileKey: file.key,
            expectedScopeId: target,
            expectedIdentityKey: episodeIdentityKey(a.episode),
          },
        )
      )?.pinned,
      true,
    );
    const originals = Array.from({ length: 98 }, (_, i) =>
      episode("original-" + i, { scopeProjectId: target, pinned: true }),
    );
    const c = episode("C", {
      scopeProjectId: target,
      createdAt: "2026-02-01T00:00:00.000Z",
    });
    disk.set(
      "episodes",
      new Map([...originals, c].map((row) => [row.id, row])),
    );
    state.denials = 0;
    assert.equal(await offline.isDurable(), true);
    const rows = await new IndexedDbProjectMemoryRepository().listEpisodes(
      target,
      { requireDurable: true },
    );
    assert.equal(rows.length, 100);
    assert.equal(rows.filter((row) => row.pinned).length, 99);
    assert.equal(rows.find((row) => row.id === "A")?.pinned, true);
    assert.ok(rows.some((row) => row.id === "B"));
    assert.ok(!rows.some((row) => row.id === "C"));
  } finally {
    restore();
  }
});

test("a same-millisecond offline modern recapture keeps its new identity when replayed to disk", async () => {
  const { state, restore } = memoryDatabaseForReconnect();
  const time = Date.now();
  const clock = mock.method(Date, "now", () => time);
  try {
    const document = design([layer("frame", "board", "Archive me")]);
    const file = new BrowserDocumentRepository(source.sourceFileKey);
    await file.save(document);
    const original = buildManualEpisodeFromSelection({
      ...archive,
      document,
      selectionIds: [],
      sourceLifetimeToken: file.getLifetimeToken(),
    });
    const peer = new IndexedDbProjectMemoryRepository();
    const old = await peer.saveEpisode(original);
    await peer.deleteEpisode(old.id);
    const offline = new IndexedDbProjectMemoryRepository();
    state.denials = 1;
    const receipt = await offline.saveEpisodeWithReceipt(original);
    assert.equal(receipt.durable, false);
    assert.equal(receipt.episode.snapshotKey, old.snapshotKey);
    assert.equal(receipt.episode.createdAt, old.createdAt);
    assert.notEqual(receipt.episode.captureId, old.captureId);
    const identity = episodeIdentityKey(receipt.episode);
    assert.notEqual(identity, episodeIdentityKey(old));
    const [persisted] = await offline.listEpisodes(scope, {
      requireDurable: true,
    });
    assert.equal(episodeIdentityKey(persisted), identity);
    assert.equal(persisted.createdAt, receipt.episode.createdAt);
    const pinned = await peer.updateEpisode(
      persisted.id,
      { pinned: true },
      { expectedIdentityKey: identity },
    );
    assert.ok(pinned?.pinned);
  } finally {
    clock.mock.restore();
    restore();
  }
});

test("legacy title and summary edits freeze the capture identity, and same-millisecond unstamped recaptures get distinct IDs", async () => {
  const { restore } = memoryDatabaseForReconnect();
  const time = Date.parse(date);
  const NativeDate = Date;
  // Freeze both archive timestamps (new Date) and lease clocks (Date.now).
  class FixedDate extends NativeDate {
    constructor(value: number | string = time) {
      super(value);
    }
    static override now() {
      return time;
    }
  }
  const resetClock = replaceGlobals({ Date: FixedDate });
  try {
    const file = new BrowserDocumentRepository(source.sourceFileKey);
    await file.save(design([]));
    const original = episode("ep-snapshot-unstamped", {
      createdAt: UNSAVED_EPISODE_TIMESTAMP,
      sourceLifetimeToken: file.getLifetimeToken(),
    });
    const tab = await isolatedMemoryTab();
    const repo = new tab.IndexedDbProjectMemoryRepository();
    const saved = await repo.saveEpisode(original);
    assert.equal(saved.createdAt, date);
    assert.equal(Object.hasOwn(saved, "legacyIdentity"), false);
    const guard = {
      expectedIdentityKey: episodeIdentityKey(saved),
      expectedScopeId: scope,
      sourceFileKey: file.key,
      expectedLifetimeToken: file.getLifetimeToken(),
    };
    const renamed = await repo.updateEpisode(
      saved.id,
      { title: "Rename", summary: "Edit" },
      guard,
    );
    assert.ok(renamed?.legacyIdentity);
    assert.equal(episodeIdentityKey(renamed), guard.expectedIdentityKey);
    assert.equal(
      toRecalledEpisodePayload(renamed, { currentFileKey: file.key }).title,
      "Rename",
    );
    assert.equal(await repo.deleteEpisode(saved.id, guard), true);
    const peer = await isolatedMemoryTab();
    const recaptured =
      await new peer.IndexedDbProjectMemoryRepository().saveEpisode(original);
    assert.equal(recaptured.createdAt, saved.createdAt);
    assert.ok(saved.captureId && recaptured.captureId);
    assert.notEqual(recaptured.captureId, saved.captureId);
    assert.notEqual(episodeIdentityKey(recaptured), guard.expectedIdentityKey);
    const long = await repo.saveEpisode({
      ...original,
      snapshotKey: "a".repeat(160),
      id: "long-historical-key",
    });
    const longIdentity = episodeIdentityKey(long);
    assert.ok(
      longIdentity.includes(
        "legacy:" + long.snapshotKey + ":" + long.captureId,
      ),
    );
    const edited = await repo.updateEpisode(long.id, { summary: "Renamed" });
    assert.equal(edited?.legacyIdentity, longIdentity);
    assert.ok(edited.legacyIdentity.length <= 512);
    assert.equal(episodeIdentityKey(edited), longIdentity);
  } finally {
    resetClock();
    restore();
  }
});

test("mutation grants require the opening lifetime and a clear replacement fence, and compare bindings canonically", async () => {
  const { documents, restore } = memoryDatabaseForReconnect();
  try {
    const file = new BrowserDocumentRepository(source.sourceFileKey);
    await file.save(design([]));
    const input = {
      commitId: "mut-bound",
      fileKey: file.key,
      expectedDocId: "doc-a",
      requireBoundLifetime: true,
      binding: { op: "update", nested: { id: 1, labels: ["a", "b"] } },
    };
    assert.equal(await authorizeFileCommit(input), "rejected");
    const bound = { ...input, expectedLifetimeToken: file.getLifetimeToken() };
    const fence = "__forma_internal_pending_file_fences__";
    documents.set(fence, [
      { fileKey: file.key, docId: "doc-a", opId: "pending" },
    ]);
    assert.equal(await authorizeFileCommit(bound), "rejected");
    assert.equal(await isFileCommitAuthorized(input.commitId), "missing");
    documents.delete(fence);
    assert.equal(await authorizeFileCommit(bound), "authorized");
    assert.equal(
      await isFileCommitAuthorized(input.commitId, {
        nested: { labels: ["a", "b"], id: 1 },
        op: "update",
      }),
      "authorized",
    );
    assert.equal(
      await isFileCommitAuthorized(input.commitId, {
        nested: { labels: ["b", "a"], id: 1 },
        op: "update",
      }),
      "missing",
    );
  } finally {
    restore();
  }
});

test("a reader records a rejected guarded edit once when a different capture occupies the authorized target", async () => {
  const { state, disk, restore } = memoryDatabaseForReconnect();
  const staged = signal(),
    allowGrant = signal(),
    granted = signal(),
    finish = signal();
  let updating: Promise<DesignEpisode | null> | undefined;
  try {
    const file = new BrowserDocumentRepository(source.sourceFileKey);
    await file.save(design([]));
    const writer = new IndexedDbProjectMemoryRepository(),
      peer = new IndexedDbProjectMemoryRepository();
    const original = await peer.saveEpisode(
      episode("ep-snapshot-occupied", {
        sourceLifetimeToken: file.getLifetimeToken(),
      }),
    );
    state.delayCompletion = (_, puts) => {
      if (!puts.some((k) => k.startsWith("__staged_mut__:"))) return;
      state.delayCompletion = () => undefined;
      staged.resolve();
      return allowGrant.promise;
    };
    updating = writer.updateEpisode(
      original.id,
      { pinned: true },
      {
        sourceFileKey: file.key,
        expectedScopeId: scope,
        expectedIdentityKey: episodeIdentityKey(original),
        expectedLifetimeToken: file.getLifetimeToken(),
      },
    );
    await Promise.race([
      staged.promise,
      updating.then(() => assert.fail("edit missed staging")),
    ]);
    await peer.deleteEpisode(original.id);
    const replacement = await peer.saveEpisode({
      ...original,
      title: "New occupant",
    });
    state.afterStudioCommit = (keys) => {
      if (!keys.some((k) => k.startsWith(commitPrefix + "mut-"))) return;
      state.afterStudioCommit = () => undefined;
      granted.resolve();
      return finish.promise;
    };
    allowGrant.resolve();
    await Promise.race([
      granted.promise,
      updating.then(() => assert.fail("edit missed grant")),
    ]);
    const stage = [...disk.get("tombstones")!.keys()].find((k) =>
      k.startsWith("__staged_mut__:"),
    )!;
    const applied =
      "__forma_applied_commit__:" + stage.slice("__staged_mut__:".length);
    await peer.listEpisodes(fileScopeId("unrelated"));
    assert.ok(disk.get("tombstones")!.has(stage));
    assert.deepEqual(await peer.listEpisodes(scope), [replacement]);
    assert.ok(!disk.get("tombstones")!.has(stage));
    assert.match(
      (disk.get("tombstones")!.get(applied) as { rejected: string }).rejected,
      /已变更或由新版本替代/,
    );
    finish.resolve();
    await assert.rejects(updating, /已变更或由新版本替代/);
    assert.ok(!disk.get("tombstones")!.has(applied));
    assert.deepEqual(await peer.getEpisode(original.id), replacement);
  } finally {
    allowGrant.resolve();
    finish.resolve();
    await updating?.catch(() => {});
    restore();
  }
});

test("replay skips an already-folded pin so a peer's confirmed unpin is preserved", async () => {
  const { state, restore } = memoryDatabaseForReconnect();
  try {
    const file = new BrowserDocumentRepository(source.sourceFileKey);
    const doc = design([layer("frame", "board", "Board")]);
    await file.save(doc);
    const offline = new IndexedDbProjectMemoryRepository();
    const peer = new IndexedDbProjectMemoryRepository();
    state.denials = Infinity;
    const saved = await offline.saveEpisodeWithReceipt(
      buildManualEpisodeFromSelection({
        document: doc,
        selectionIds: ["board"],
        sourceFileKey: file.key,
        scopeProjectId: scope,
        sourceLifetimeToken: file.getLifetimeToken(),
        sourceDocumentEpoch: file.getDocumentEpoch(),
      }),
    );
    assert.equal(saved.durable, false);
    const guard = {
      sourceFileKey: file.key,
      expectedScopeId: scope,
      expectedIdentityKey: episodeIdentityKey(saved.episode),
      expectedDocId: doc.id,
      expectedLifetimeToken: file.getLifetimeToken(),
      expectedDocumentEpoch: file.getDocumentEpoch(),
    };
    const pinned = await offline.updateEpisode(
      saved.episode.id,
      { pinned: true },
      guard,
    );
    assert.equal(pinned?.pinned, true);
    state.denials = 0;
    let peerUnpinned = false;
    // Pause right after the archive publication commits so peer can unpin it.
    state.delayCompletion = (stores, puts) => {
      if (
        peerUnpinned ||
        !stores.includes("episodes") ||
        !puts.includes(saved.episode.id)
      )
        return;
      peerUnpinned = true;
      return peer
        .updateEpisode(saved.episode.id, { pinned: false })
        .then((updated) => {
          assert.equal(updated?.pinned, false);
        });
    };
    await offline.listEpisodes(scope, { requireDurable: true });
    assert.equal(peerUnpinned, true);
    assert.equal(await offline.isDurable(), true);
    const fresh = await new IndexedDbProjectMemoryRepository().getEpisode(
      saved.episode.id,
    );
    assert.equal(fresh?.pinned, false);
  } finally {
    restore();
  }
});

test("an offline delete follows its remapped ID when a peer occupies the original display ID", async () => {
  const { state, restore } = memoryDatabaseForReconnect();
  try {
    const file = new BrowserDocumentRepository(source.sourceFileKey);
    const base = design([layer("frame", "board", "Board")]);
    await file.save(base);
    const branchA = structuredClone(base);
    branchA.revision++;
    branchA.nodes[0].style.fill = "#aa1155";
    await file.save(branchA);
    const peerCapture = buildManualEpisodeFromSelection({
      document: branchA,
      selectionIds: ["board"],
      sourceFileKey: file.key,
      scopeProjectId: scope,
      sourceLifetimeToken: file.getLifetimeToken(),
      sourceDocumentEpoch: file.getDocumentEpoch(),
    });
    const peer = new IndexedDbProjectMemoryRepository();
    const peerSaved = await peer.saveEpisode(peerCapture);

    const branchB = structuredClone(base);
    branchB.revision++;
    branchB.nodes[0].style.fill = "#1155aa";
    const offlineCapture = buildManualEpisodeFromSelection({
      document: branchB,
      selectionIds: ["board"],
      sourceFileKey: file.key,
      scopeProjectId: scope,
      sourceLifetimeToken: file.getLifetimeToken(),
      sourceDocumentEpoch: file.getDocumentEpoch(),
    });
    assert.equal(offlineCapture.id, peerSaved.id);
    assert.notEqual(offlineCapture.snapshotKey, peerSaved.snapshotKey);

    const offline = new IndexedDbProjectMemoryRepository();
    state.denials = Infinity;
    const saved = await offline.saveEpisodeWithReceipt(offlineCapture);
    assert.equal(saved.durable, false);
    const deleted = await offline.deleteEpisode(saved.episode.id, {
      sourceFileKey: file.key,
      expectedScopeId: scope,
      expectedIdentityKey: episodeIdentityKey(saved.episode),
      expectedDocId: branchB.id,
      expectedLifetimeToken: file.getLifetimeToken(),
      expectedDocumentEpoch: file.getDocumentEpoch(),
    });
    assert.equal(deleted, true);

    state.denials = 0;
    const rows = await offline.listEpisodes(scope, { requireDurable: true });
    assert.equal(await offline.isDurable(), true);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].snapshotKey, peerSaved.snapshotKey);
  } finally {
    restore();
  }
});

test("two proposals deleting different boards from the same revision produce distinct durable archives", async () => {
  const { restore } = memoryDatabaseForReconnect();
  try {
    const file = new BrowserDocumentRepository(source.sourceFileKey);
    const boardA = layer("frame", "board-a", "Board A");
    const boardB = layer("frame", "board-b", "Board B");
    const base = design([boardA, boardB]);
    await file.save(base);
    const afterDeleteA = { ...base, revision: 2, nodes: [boardB] };
    const afterDeleteB = { ...base, revision: 2, nodes: [boardA] };
    const epA = buildEpisodeFromAppliedProposal({
      beforeDoc: base,
      afterDoc: afterDeleteA,
      createdRootIds: [],
      prompt: "Remove the selected board",
      summary: "Removed board",
      scopeProjectId: scope,
      sourceFileKey: file.key,
      sourceLifetimeToken: file.getLifetimeToken(),
      sourceDocumentEpoch: file.getDocumentEpoch(),
    });
    const epB = buildEpisodeFromAppliedProposal({
      beforeDoc: base,
      afterDoc: afterDeleteB,
      createdRootIds: [],
      prompt: "Remove the selected board",
      summary: "Removed board",
      scopeProjectId: scope,
      sourceFileKey: file.key,
      sourceLifetimeToken: file.getLifetimeToken(),
      sourceDocumentEpoch: file.getDocumentEpoch(),
    });
    assert.notEqual(epA.snapshotKey, epB.snapshotKey);
    const repo = new IndexedDbProjectMemoryRepository();
    const resA = await repo.saveEpisodeWithReceipt(epA);
    const resB = await repo.saveEpisodeWithReceipt(epB);
    assert.equal(resA.durable, true);
    assert.equal(resB.durable, true);
    assert.notEqual(resA.episode.id, resB.episode.id);
    const fresh = await new IndexedDbProjectMemoryRepository().listEpisodes(
      scope,
    );
    assert.equal(fresh.length, 2);
  } finally {
    restore();
  }
});
