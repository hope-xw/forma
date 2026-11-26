import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { X } from "lucide-react";
import type { ProjectSpace } from "../agent/project-memory";
import { BUILTIN_LIBRARY_IDS } from "../design-system/catalog";
import {
  NEW_PROJECT_LIBRARY_TARGET,
  projectDerivedLibraryId,
  promoteSelectionToLibrary,
  suggestPromotionDefaults,
  type PromoteSelectionDefaults,
  type PromoteSelectionResult,
} from "../domain/library-promotion";
import { transact } from "../domain/commands";
import type { AssetTier, ComponentLibrary } from "../domain/library-schema";
import {
  acknowledgeCatalogCommit,
  hasAppliedCatalogCommit,
  listWorkspaceLibraries,
  getWorkspaceLibraryRecord,
  readWorkspaceScopeFence,
  saveWorkspaceLibraryIfUnchanged,
  WorkspaceLibraryConflictError,
  type WorkspaceLibraryRecord,
  type WorkspaceScopeFence,
} from "../infrastructure/library-catalog-store";
import {
  FileLifetimeMismatchError,
  getFileProjectSpace,
  isFileLifetimeMismatchError,
  updateProjectSpace,
  withFileProjectScopeLock,
} from "../infrastructure/project-memory-store";
import type { EditorController } from "./useEditor";
import { useModalDialog } from "./useModalDialog";

const reopenPromotionMessage =
  "所属项目空间或源文件状态已变更，请重新打开沉淀弹窗";

export interface PromoteModuleModalProps {
  editor: EditorController;
  fileKey?: string;
  fileLifetimeInvalid?: boolean;
  getFileLifetimeToken?: () => Promise<string | undefined> | string | undefined;
  onFileLifetimeInvalidated?(message?: string): void;
  activeProject?: ProjectSpace | null;
  preferredLibraryId?: string;
  onSuccess?(message: string): void;
  close(): void;
}

export function PromoteModuleModal({
  editor,
  fileKey: effectiveFileKey = "forma.document.v1",
  fileLifetimeInvalid = false,
  getFileLifetimeToken = editor.getLifetimeToken,
  onFileLifetimeInvalidated,
  activeProject,
  preferredLibraryId,
  onSuccess,
  close,
}: PromoteModuleModalProps) {
  // Keep the intended selection stable, including after replacing it with an instance.
  const [source] = useState(() => ({
    doc: editor.committed,
    nodeId: editor.selected[0]?.id,
    projectId: activeProject?.id,
    projectName: activeProject?.name,
    preferredLibraryId,
    lifetimeToken: editor.getCurrentLifetimeToken?.(),
    documentEpoch: editor.getCurrentDocumentEpoch?.(),
    getLifetimeToken: getFileLifetimeToken,
    getDocumentEpoch: editor.getDocumentEpoch,
  }));
  const [setup, setSetup] = useState<{
    expectedLifetimeToken?: string;
    expectedDocumentEpoch?: number;
    defaults: PromoteSelectionDefaults;
    libraries: ComponentLibrary[];
  } | null>(null);
  const [target, setTarget] = useState("");
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  const openingFenceRef = useRef<WorkspaceScopeFence | null>(null);
  const pendingAttemptRef = useRef<{
    signature: string;
    commitId: string;
    prepared: ReturnType<typeof promoteSelectionToLibrary>;
    document: typeof source.doc;
    baseline: Pick<WorkspaceLibraryRecord, "revision" | "savedAt"> | null;
    openingFence: WorkspaceScopeFence;
  } | null>(null);
  const sessionActive = useRef(false);
  useLayoutEffect(() => {
    sessionActive.current = !fileLifetimeInvalid;
    return () => {
      sessionActive.current = false;
    };
  }, [fileLifetimeInvalid]);
  const [committed, setCommitted] = useState<PromoteSelectionResult | null>(
    null,
  );
  const [workspaceOnly, setWorkspaceOnly] = useState(false);
  const [error, setError] = useState("");
  const dismiss = () => {
    if (!submitting.current) close();
  };
  const ref = useModalDialog(true, dismiss);
  const derivedId = source.projectId
    ? projectDerivedLibraryId(source.projectId)
    : undefined;

  async function withVerifiedProjectScope<T>(
    session: Pick<
      WorkspaceScopeFence,
      "expectedLifetimeToken" | "expectedDocumentEpoch"
    >,
    task: (expectedFence: WorkspaceScopeFence) => Promise<T>,
  ) {
    return withFileProjectScopeLock(
      effectiveFileKey,
      async () => {
        const { expectedLifetimeToken, expectedDocumentEpoch } = session;
        const verifySource = () =>
          getFileProjectSpace(effectiveFileKey, {
            requireDurable: true,
            expectedLifetimeToken,
            expectedDocumentEpoch,
            requireBoundLifetime: true,
            expectedDocId: source.doc.id,
          });
        try {
          const expectedFence = await readWorkspaceScopeFence(
            effectiveFileKey,
            source.projectId ?? null,
            source.doc.id,
            expectedDocumentEpoch,
          );
          const liveProject = await verifySource();
          if (liveProject?.id !== source.projectId) {
            if (openingFenceRef.current)
              throw new FileLifetimeMismatchError(reopenPromotionMessage);
            throw new Error("所属项目空间已变更，请重新确认目标组件库后再沉淀");
          }
          return await task({
            ...expectedFence,
            expectedLifetimeToken,
            expectedDocumentEpoch,
          });
        } catch (error) {
          // The catalog uses the same error for a replaced and an unreadable
          // source. Let the durable identity check distinguish them.
          if (
            error instanceof Error &&
            error.message === "所属项目空间或源文件状态已变更，请刷新后重试"
          )
            await verifySource();
          throw error;
        }
      },
      source.projectId ? { projectId: source.projectId } : undefined,
    );
  }

  function reportError(err: unknown) {
    if (isFileLifetimeMismatchError(err)) {
      const message =
        err instanceof Error
          ? err.message
          : "当前文件已在其他窗口删除或替换，请重新打开文件";
      setError(message);
      onFileLifetimeInvalidated?.(message);
    } else setError(err instanceof Error ? err.message : String(err));
  }

  useEffect(() => {
    openingFenceRef.current = null;
    setSetup(null);
    if (fileLifetimeInvalid) return;
    let active = true;
    async function initialize() {
      if (!source.nodeId) throw new Error("请先单选要沉淀的图层");
      // Resolve any pending document save before taking the lock that save uses.
      const [expectedLifetimeToken, expectedDocumentEpoch] = await Promise.all([
        source.lifetimeToken ?? source.getLifetimeToken?.(),
        source.documentEpoch ?? source.getDocumentEpoch?.(),
      ]);
      const session = { expectedLifetimeToken, expectedDocumentEpoch };
      if (!active) return;
      const records = await withVerifiedProjectScope(session, async (fence) => {
        const records = await listWorkspaceLibraries();
        if (active) openingFenceRef.current = fence;
        return records;
      });
      const workspaceLibraries = records.map((record) => record.library);
      if (!active) return;
      const defaults = suggestPromotionDefaults(source.doc, source.nodeId, {
        projectId: source.projectId,
        projectName: source.projectName,
        preferredLibraryId: source.preferredLibraryId,
        workspaceLibraries,
      });
      const libraries = new Map(
        [...workspaceLibraries, ...Object.values(source.doc.libraries ?? {})]
          .filter((lib) => !BUILTIN_LIBRARY_IDS.has(lib.id))
          .map((lib) => [lib.id, lib]),
      );
      setTarget(defaults.suggestedLibraryId);
      setSetup({ ...session, defaults, libraries: [...libraries.values()] });
    }
    void initialize().catch((err) => {
      if (active) reportError(err);
    });
    return () => {
      active = false;
      openingFenceRef.current = null;
    };
  }, [source, fileLifetimeInvalid, effectiveFileKey]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (
      !setup ||
      !source.nodeId ||
      fileLifetimeInvalid ||
      submitting.current ||
      workspaceOnly
    )
      return;
    const nodeId = source.nodeId;
    const fields = new FormData(event.currentTarget);
    const setAsProjectDefault = fields.has("setDefault");
    const value = (name: string) => String(fields.get(name) ?? "").trim();
    setError("");
    submitting.current = true;
    setBusy(true);
    try {
      const openingFence = openingFenceRef.current;
      if (!openingFence) throw new Error("请等待组件库校验完成后再沉淀");
      const persist = async () => {
        const doc = editor.historyRef.current.present;
        if (
          doc.id !== source.doc.id ||
          doc.activePage !== source.doc.activePage
        )
          throw new Error("文件或页面已切换，请重新选择图层");
        const componentName = value("componentName");
        if (!componentName) throw new Error("请输入组件名称");
        if (target === NEW_PROJECT_LIBRARY_TARGET && !value("newLibraryName"))
          throw new Error("请输入新组件库名称");
        const tags = [
          ...new Set(
            value("tagsText")
              .split(/[,，、\s]+/u)
              .filter(Boolean),
          ),
        ];
        if (tags.length > 16 || tags.some((tag) => tag.length > 40))
          throw new Error("最多可填写 16 个检索标签，每个标签最多 40 个字符");
        const options = {
          projectId: source.projectId,
          projectName: source.projectName,
          targetLibraryId: target,
          componentName,
          newLibraryName: value("newLibraryName"),
          assetTier: value("assetTier") as AssetTier,
          category: value("category"),
          whenToUse: value("whenToUse"),
          tags,
          refreshPlaybook: fields.has("refreshPlaybook"),
          replaceSelectionWithInstance: fields.has(
            "replaceSelectionWithInstance",
          ),
        };
        const formSignature = JSON.stringify([
          target,
          componentName,
          options.newLibraryName,
          options.assetTier,
          options.category,
          options.whenToUse,
          tags,
          options.refreshPlaybook,
          options.replaceSelectionWithInstance,
          setAsProjectDefault,
        ]);
        if (pendingAttemptRef.current?.signature !== formSignature)
          pendingAttemptRef.current = null;
        const destination =
          target === NEW_PROJECT_LIBRARY_TARGET ? derivedId : target;
        let record =
          !pendingAttemptRef.current && destination
            ? await getWorkspaceLibraryRecord(destination)
            : null;
        for (let conflicts = 0; ; conflicts++) {
          if (
            !sessionActive.current ||
            editor.historyRef.current.present !== doc
          )
            throw new Error("文件已变更，请重新确认选区后重试");
          if (!pendingAttemptRef.current) {
            const prepared = promoteSelectionToLibrary(doc, nodeId, {
              ...options,
              existingWorkspaceLibrary: record?.library,
            });
            transact(doc, {
              baseRevision: doc.revision,
              operations: prepared.operations,
            });
            pendingAttemptRef.current = {
              signature: formSignature,
              commitId: "cat-" + crypto.randomUUID(),
              prepared,
              document: doc,
              baseline: record
                ? { revision: record.revision, savedAt: record.savedAt }
                : null,
              openingFence,
            };
          }
          const attempt = pendingAttemptRef.current;
          const result = attempt.prepared;
          try {
            await saveWorkspaceLibraryIfUnchanged(
              result.library,
              "packaged",
              attempt.baseline,
              {
                expectedFence: attempt.openingFence,
                commitId: attempt.commitId,
              },
            );
          } catch (err) {
            if (err instanceof WorkspaceLibraryConflictError) {
              if (!(await hasAppliedCatalogCommit(attempt.commitId))) {
                pendingAttemptRef.current = null;
                if (conflicts > 0)
                  throw new Error("其他文件正在更新此组件库，请重试");
                record = err.current;
                continue;
              }
            } else {
              // Preserve the attempt on an uncertain storage or commit failure.
              if (
                err instanceof Error &&
                (err.message === "工作区组件库已删除，请刷新后重试" ||
                  err.message ===
                    "所属项目空间或源文件状态已变更，请刷新后重试")
              )
                pendingAttemptRef.current = null;
              if (
                err instanceof Error &&
                err.message ===
                  "所属项目空间已变更，请重新确认目标组件库后再沉淀"
              )
                throw new FileLifetimeMismatchError(reopenPromotionMessage);
              throw err;
            }
          }
          // Persistence succeeded. Never append this module a second time on retry.
          pendingAttemptRef.current = null;
          void acknowledgeCatalogCommit(attempt.commitId).catch(() => {});
          setWorkspaceOnly(true);
          try {
            if (
              !sessionActive.current ||
              editor.historyRef.current.present !== attempt.document
            )
              throw new Error("当前文件已变更，请关闭弹窗并从组件库载入模块。");
            editor.apply(result.operations, attempt.document.revision);
          } catch (error) {
            throw new Error(
              `模块已保存到工作区，写入当前文件失败：${error instanceof Error ? error.message : String(error)}`,
            );
          }
          setCommitted(result);
          setWorkspaceOnly(false);
          if (result.replacedNodeId)
            editor.setSelection([result.replacedNodeId]);
          return result;
        }
      };
      const result = await withVerifiedProjectScope(
        setup,
        async (currentFence) => {
          if (!sessionActive.current) return;
          if (
            currentFence.fileEpoch !== openingFence.fileEpoch ||
            currentFence.projectEpoch !== openingFence.projectEpoch ||
            currentFence.projectId !== openingFence.projectId
          )
            throw new FileLifetimeMismatchError(reopenPromotionMessage);
          const result = committed ?? (await persist());
          if (sessionActive.current && source.projectId && setAsProjectDefault)
            await updateProjectSpace(
              source.projectId,
              { defaultLibraryId: result.library.id },
              { expectedAssignedFileKey: effectiveFileKey },
            );
          return result;
        },
      );
      if (!sessionActive.current || !result) return;
      const component = result.library.components.find(
        (item) => item.id === result.componentId,
      )!;
      onSuccess?.(
        `已将「${component.name}」沉淀至「${result.library.name}」（r${result.library.revision}）${result.playbookRefreshed ? "，AI 说明书已更新" : ""}`,
      );
      close();
    } catch (err) {
      if (isFileLifetimeMismatchError(err)) pendingAttemptRef.current = null;
      if (sessionActive.current) reportError(err);
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }

  return (
    <div
      className="modal-backdrop"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) dismiss();
      }}
    >
      <div
        className="promote-modal"
        ref={ref}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label="沉淀为组件库模块"
      >
        <div className="panel-heading">
          <strong>沉淀为组件库模块</strong>
          <button
            className="icon-btn icon-btn-sm"
            aria-label="关闭沉淀弹窗"
            data-tip="关闭"
            data-tip-side="bottom"
            data-tip-kbd="Esc"
            disabled={busy}
            onClick={dismiss}
          >
            <X size={16} />
          </button>
        </div>
        {fileLifetimeInvalid ? (
          <p className="file-browser-notice" role="alert">
            {error || "当前文件已在其他窗口删除或替换，请重新打开文件"}
          </p>
        ) : setup ? (
          <form
            className="promote-form"
            onSubmit={submit}
            onChange={() => {
              pendingAttemptRef.current = null;
            }}
          >
            <div className="promote-scroll">
              <fieldset disabled={busy || !!committed || workspaceOnly}>
                <label>
                  组件名称
                  <input
                    name="componentName"
                    required
                    maxLength={120}
                    defaultValue={setup.defaults.componentName.slice(0, 120)}
                  />
                </label>
                <label>
                  目标组件库
                  <select
                    aria-label="目标组件库"
                    value={target}
                    onChange={(event) => setTarget(event.target.value)}
                  >
                    {!setup.libraries.some((lib) => lib.id === derivedId) && (
                      <option value={NEW_PROJECT_LIBRARY_TARGET}>
                        {source.projectId
                          ? "新建项目衍生库"
                          : "新建自定义模块库"}
                        （{setup.defaults.suggestedNewLibraryName}）
                      </option>
                    )}
                    {setup.libraries.map((lib) => (
                      <option key={lib.id} value={lib.id}>
                        {lib.name}
                        {lib.id === derivedId ? "（当前项目衍生库）" : ""}
                      </option>
                    ))}
                  </select>
                </label>
                {target === NEW_PROJECT_LIBRARY_TARGET && (
                  <label>
                    新组件库名称
                    <input
                      name="newLibraryName"
                      required
                      maxLength={200}
                      defaultValue={setup.defaults.suggestedNewLibraryName}
                    />
                  </label>
                )}
                <p className="promote-hint">
                  官方内置 4
                  大体系保持只读，新造或派生模块将沉淀至项目衍生库或自定义组件库。
                </p>
                <div className="promote-classification">
                  <label>
                    资产层级
                    <select
                      name="assetTier"
                      aria-label="资产层级"
                      defaultValue={setup.defaults.assetTier}
                    >
                      <option value="page">页面样板</option>
                      <option value="block">业务模块</option>
                      <option value="component">原子组件</option>
                    </select>
                  </label>
                  <label>
                    组件分类
                    <input
                      name="category"
                      aria-label="组件分类"
                      maxLength={200}
                      defaultValue={setup.defaults.category}
                    />
                  </label>
                </div>
                <label>
                  AI 适用场景提示
                  <textarea
                    name="whenToUse"
                    aria-label="AI 适用场景提示"
                    maxLength={500}
                    rows={2}
                    placeholder="描述该模块适用业务场景、文案边界或组合建议，将写入 AI 说明书"
                  />
                </label>
                <label>
                  检索标签
                  <input
                    name="tagsText"
                    aria-label="检索标签"
                    placeholder="用逗号或空格分隔"
                  />
                </label>
                <label className="promote-checkbox-row">
                  <input
                    name="refreshPlaybook"
                    type="checkbox"
                    defaultChecked
                  />
                  自动增量刷新目标库 AI 说明书（保留手动备注）
                </label>
                <label className="promote-checkbox-row">
                  <input name="replaceSelectionWithInstance" type="checkbox" />
                  同时将画布选区替换为受保护组件实例（支持 ⌘Z 单步撤销）
                </label>
              </fieldset>
              {activeProject && (
                <label className="promote-checkbox-row">
                  <input type="checkbox" name="setDefault" disabled={busy} />
                  设为当前项目默认组件库
                </label>
              )}
            </div>
            {error && (
              <p role="alert" className="file-browser-notice">
                {committed && "画布已更新。"}
                {error}
              </p>
            )}
            <div className="promote-footer">
              <button type="button" disabled={busy} onClick={dismiss}>
                取消
              </button>
              <button
                className="project-submit"
                type="submit"
                disabled={busy || workspaceOnly}
              >
                {busy ? "正在保存…" : committed ? "重试保存" : "沉淀到组件库"}
              </button>
            </div>
          </form>
        ) : (
          <p className="file-browser-notice" role={error ? "alert" : "status"}>
            {error || "正在读取本机组件库…"}
          </p>
        )}
      </div>
    </div>
  );
}
