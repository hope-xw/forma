import { readNativeDocument } from "../infrastructure/native-document";
import { useEffect, useRef, useState } from "react";
import { BUILTIN_LIBRARIES } from "../design-system/catalog";
import { projectScopeId, type ProjectSpace } from "../agent/project-memory";
import {
  getWorkspaceLibraryRecord,
  listWorkspaceLibraries,
  saveWorkspaceLibraryDurable,
  WorkspaceLibraryConflictError,
} from "../infrastructure/library-catalog-store";
import {
  assignFileToProject,
  countEpisodesByScope,
  createProjectSpace,
  deleteProjectSpace,
  getFileProjectSpace,
  isProjectMemoryDurable,
  listFileProjectAssignments,
  listProjectSpaces,
  subscribeProjectMemory,
  updateProjectSpace,
} from "../infrastructure/project-memory-store";
import {
  File,
  FilePlus2,
  FolderPlus,
  Copy,
  LayoutGrid,
  List,
  Pencil,
  Search,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import {
  readLocalDocument,
  readLocalPreview,
  cachedRecentFiles,
  deleteLocalFile,
  fileUrl,
  recentFiles,
  renameLocalFile,
  type FileSummary,
} from "../infrastructure/storage";
import { exportNodeToSvg } from "../infrastructure/static-export";
import { cloneDocument, type DesignDocument } from "../domain/document";
import { useModalDialog } from "./useModalDialog";
import { isDesktopRuntime, storageUnavailableCopy } from "./ux-copy";
import { createBrowserFile, newBlankFile, ownLibrary } from "./file-actions";

import {
  acceptedDesignFiles,
  isExternalDesign,
  checkDesignFileSize,
} from "../infrastructure/design-import/types";

export { newBlankFile, ownLibrary };

function sessionGroupingNotice() {
  return `${storageUnavailableCopy()}。分组仅在当前页面有效，离开后将丢失。`;
}

function FileThumbnail({
  file,
  current,
}: {
  file: FileSummary;
  current?: DesignDocument;
}) {
  const holder = useRef<HTMLButtonElement>(null);
  const [src, setSrc] = useState("");
  useEffect(() => {
    let active = true;
    let url = "";
    setSrc("");
    const load = async () => {
      const doc = current ?? (await readLocalPreview(file.key));
      if (!active || !doc) return;
      const root =
        doc.nodes.find((n) => !n.parentId && !n.hidden && n.type === "frame") ??
        doc.nodes.find((n) => !n.parentId && !n.hidden);
      if (!root) return;
      const svg = exportNodeToSvg(doc, root.id);
      url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
      setSrc(url);
    };
    const observer = new IntersectionObserver(([entry]) => {
      if (!entry.isIntersecting) return;
      observer.disconnect();
      void load().catch(() => {
        /* A file can still be opened when its preview is unavailable. */
      });
    });
    observer.observe(holder.current!);
    return () => {
      active = false;
      observer.disconnect();
      if (url) URL.revokeObjectURL(url);
    };
  }, [file.key, file.updatedAt, current]);
  return (
    <button
      ref={holder}
      className="file-card-thumb"
      aria-label={`打开 ${file.name}`}
      data-tip="打开设计文件"
      data-tip-side="top"
      onClick={() => location.assign(fileUrl(file.key))}
    >
      {src ? <img alt="" src={src} /> : <File size={26} strokeWidth={1.4} />}
    </button>
  );
}
type LibraryChoice = { id: string; name: string };

function LibraryOptions({
  libraries,
  value,
}: {
  libraries: LibraryChoice[];
  value?: string;
}) {
  return (
    <>
      <option value="">无默认组件库</option>
      {value && !libraries.some((lib) => lib.id === value) && (
        <option value={value}>{value}（本机未载入）</option>
      )}
      {libraries.map((lib) => (
        <option key={lib.id} value={lib.id}>
          {lib.name}
        </option>
      ))}
    </>
  );
}

function ProjectSidebar({
  projects,
  filter,
  selectFilter,
  fileCounts,
  total,
  episodeCounts,
  libraries,
  ensureDefaultLibrary,
  run,
  notify,
}: {
  projects: ProjectSpace[];
  filter: string;
  selectFilter(filter: string): void;
  fileCounts: Map<string, number>;
  total: number;
  episodeCounts: Record<string, number>;
  libraries: LibraryChoice[];
  ensureDefaultLibrary(id: string | null): Promise<void>;
  run(work: () => Promise<void>): void;
  notify(message: string): void;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const sidebar = useRef<HTMLElement>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const [name, setName] = useState("");
  const [libraryId, setLibraryId] = useState("");
  function finishEdit() {
    setEditing(null);
    requestAnimationFrame(() => {
      if (trigger.current?.isConnected) trigger.current.focus();
      else
        sidebar.current
          ?.querySelector<HTMLButtonElement>(".project-add")
          ?.focus();
    });
  }
  function edit(button: HTMLButtonElement, project?: ProjectSpace) {
    trigger.current = button;
    setDeleting(null);
    setEditing(project?.id ?? "new");
    setName(project?.name ?? "");
    setLibraryId("");
  }
  function form(project?: ProjectSpace) {
    return (
      <form
        className="project-create-form"
        data-escape-local
        onKeyDown={(event) => {
          if (event.key === "Escape" && !event.nativeEvent.isComposing) {
            event.preventDefault();
            finishEdit();
          }
        }}
        onSubmit={(event) => {
          event.preventDefault();
          if (!name.trim()) return;
          run(async () => {
            if (project)
              await updateProjectSpace(project.id, { name: name.trim() });
            else {
              await ensureDefaultLibrary(libraryId);
              const created = await createProjectSpace({
                name: name.trim(),
                defaultLibraryId: libraryId || undefined,
              });
              selectFilter(created.id);
              if (!(await isProjectMemoryDurable()))
                notify(sessionGroupingNotice());
            }
            finishEdit();
          });
        }}
      >
        <label>
          项目名称
          <input
            aria-label="项目名称"
            autoFocus
            required
            maxLength={120}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        {!project && (
          <label>
            默认组件库
            <select
              aria-label="默认组件库"
              value={libraryId}
              onChange={(event) => setLibraryId(event.target.value)}
            >
              <LibraryOptions libraries={libraries} />
            </select>
          </label>
        )}
        <div className="project-form-actions">
          <button
            type="submit"
            className="project-submit"
            disabled={!name.trim()}
          >
            {project ? "保存" : "创建"}
          </button>
          <button type="button" onClick={() => finishEdit()}>
            取消
          </button>
        </div>
      </form>
    );
  }
  function filterButton(
    id: string,
    label: string,
    count: number,
    episodes?: number,
  ) {
    return (
      <button
        type="button"
        className={`project-nav-item${filter === id ? " active" : ""}`}
        aria-label={label}
        aria-description={`${count} 份设计稿${episodes !== undefined ? `，${episodes} 条记忆` : ""}`}
        aria-pressed={filter === id}
        onClick={() => selectFilter(id)}
      >
        <span className="project-name">{label}</span>
        <span className="project-count" aria-label={`${count} 份设计稿`}>
          {count}
        </span>
        {episodes !== undefined && (
          <small className="project-memory-count">{episodes} 条记忆</small>
        )}
      </button>
    );
  }
  return (
    <nav ref={sidebar} className="project-sidebar" aria-label="项目空间">
      {filterButton("all", "全部文件", total)}
      {filterButton("drafts", "未归类草稿", fileCounts.get("drafts") ?? 0)}
      <div className="project-sidebar-heading">项目空间</div>
      {projects.map((project) => (
        <div className="project-item" key={project.id}>
          <div className="project-nav-row">
            {filterButton(
              project.id,
              project.name,
              fileCounts.get(project.id) ?? 0,
              episodeCounts[projectScopeId(project.id)] ?? 0,
            )}
            <button
              className="icon-btn icon-btn-sm"
              aria-label={`重命名项目 ${project.name}`}
              data-tip="重命名项目"
              data-tip-side="bottom"
              onClick={(event) => edit(event.currentTarget, project)}
            >
              <Pencil size={12} />
            </button>
            <button
              className="icon-btn icon-btn-sm"
              aria-label={`删除项目 ${project.name}`}
              data-tip="删除项目"
              data-tip-desc="保留设计稿，移除项目历史档案"
              data-tip-side="bottom"
              onClick={() => {
                setEditing(null);
                setDeleting(project.id);
              }}
            >
              <Trash2 size={12} />
            </button>
          </div>
          {editing === project.id && form(project)}
          {deleting === project.id && (
            <div className="project-create-form">
              <span>
                删除「{project.name}
                」及其历史需求档案？设计稿将保留在未归类草稿中。
              </span>
              <div className="project-form-actions">
                <button
                  type="button"
                  onClick={() =>
                    run(async () => {
                      const { unassignedFiles } = await deleteProjectSpace(
                        project.id,
                      );
                      if (filter === project.id) selectFilter("drafts");
                      setDeleting(null);
                      notify(
                        `已删除项目「${project.name}」，其下 ${unassignedFiles.length} 份设计稿已保留在未归类草稿中`,
                      );
                    })
                  }
                >
                  确认删除
                </button>
                <button onClick={() => setDeleting(null)}>取消</button>
              </div>
            </div>
          )}
        </div>
      ))}
      {editing === "new" ? (
        form()
      ) : (
        <button
          className="project-add"
          onClick={(event) => edit(event.currentTarget)}
        >
          <FolderPlus size={14} />
          新建项目空间
        </button>
      )}
    </nav>
  );
}

export function FileBrowser({
  close,
  currentKey,
  current,
  renameCurrent,
  externalImport,
}: {
  close(): void;
  currentKey: string;
  current: DesignDocument;
  renameCurrent(name: string): void;
  externalImport(file: File, projectId?: string | null): void;
}) {
  const ref = useModalDialog(true, close),
    input = useRef<HTMLInputElement>(null),
    searchRef = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<FileSummary[]>(cachedRecentFiles),
    [query, search] = useState(""),
    [view, setView] = useState<"grid" | "list">("grid"),
    [renaming, setRenaming] = useState<FileSummary | null>(null),
    [error, setError] = useState("");

  const [projects, setProjects] = useState<ProjectSpace[]>([]);
  const [assignments, setAssignments] = useState<Record<string, string>>({});
  const [episodeCounts, setEpisodeCounts] = useState<Record<string, number>>(
    {},
  );
  const [workspaceChoices, setWorkspaceChoices] = useState<LibraryChoice[]>([]);
  const [filter, setFilter] = useState("all");
  const [notice, setNotice] = useState("");
  const pending = useRef(false);
  const refreshCatalog = useRef<(() => Promise<void>) | null>(null);
  function reportError(err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    setError(
      message.replace(
        "当前浏览器未启用本地持久存储，跨页跳转后项目归属无法保存",
        storageUnavailableCopy(),
      ),
    );
  }
  async function run(work: () => Promise<void>) {
    if (pending.current) return;
    pending.current = true;
    setError("");
    setNotice("");
    try {
      await work();
    } catch (err) {
      reportError(err);
    } finally {
      pending.current = false;
    }
  }

  useEffect(() => {
    let generation = 0;
    let mounted = true;
    const refresh = async () => {
      const read = ++generation;
      try {
        const [spaces, assigned, counts, catalog] = await Promise.all([
          listProjectSpaces(),
          listFileProjectAssignments(),
          countEpisodesByScope(),
          recentFiles().catch((err) => {
            if (mounted && read === generation) reportError(err);
            return cachedRecentFiles();
          }),
        ]);
        if (!mounted || read !== generation) return;
        setProjects(spaces);
        setAssignments(assigned);
        setEpisodeCounts(counts);
        setFiles(catalog);
      } catch (err) {
        if (mounted && read === generation) reportError(err);
      }
    };
    refreshCatalog.current = refresh;
    const unsubscribe = subscribeProjectMemory(refresh);
    void refresh();
    void listWorkspaceLibraries()
      .then((records) => {
        if (mounted)
          setWorkspaceChoices(records.map(({ id, name }) => ({ id, name })));
      })
      .catch((err) => {
        if (mounted) reportError(err);
      });
    const focus = requestAnimationFrame(() => searchRef.current?.focus());
    return () => {
      mounted = false;
      refreshCatalog.current = null;
      unsubscribe();
      cancelAnimationFrame(focus);
    };
  }, []);

  const selectedProject = projects.find((p) => p.id === filter);
  const activeFilter =
    selectedProject?.id ?? (filter === "drafts" ? "drafts" : "all");
  const fileCounts = new Map<string, number>();
  function assignedProjectId(key: string) {
    return Object.hasOwn(assignments, key) ? assignments[key] : undefined;
  }
  for (const file of files) {
    const id = assignedProjectId(file.key) ?? "drafts";
    fileCounts.set(id, (fileCounts.get(id) ?? 0) + 1);
  }
  const filtered = files.filter(
    (f) =>
      (activeFilter === "all" ||
        (assignedProjectId(f.key) ?? "drafts") === activeFilter) &&
      f.name.toLowerCase().includes(query.trim().toLowerCase()),
  );
  const libraries = Array.from(
    new Map(
      [
        ...BUILTIN_LIBRARIES,
        ...workspaceChoices,
        ...Object.values(current.libraries ?? {}),
      ].map((lib) => [lib.id, { id: lib.id, name: lib.name }]),
    ).values(),
  );
  async function ensureDefaultLibrary(id: string | null) {
    if (!id || BUILTIN_LIBRARIES.some((library) => library.id === id)) return;
    try {
      if (await getWorkspaceLibraryRecord(id)) return;
      const library = ownLibrary(current.libraries, id);
      if (!library) throw new Error("本机找不到该组件库");
      await saveWorkspaceLibraryDurable(library, "packaged");
    } catch (error) {
      if (error instanceof WorkspaceLibraryConflictError) return;
      throw new Error(
        `无法保存项目默认组件库：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  function projectSelect(f: FileSummary) {
    return (
      <select
        className="file-project-select"
        aria-label={`设置 ${f.name} 所属项目`}
        value={assignedProjectId(f.key) ?? ""}
        onChange={(event) => {
          const id = event.target.value || null;
          void run(async () => {
            let assignment;
            try {
              assignment = await assignFileToProject(f.key, id, {
                migrateDraftEpisodes: true,
                expectedLifetimeToken: f.lifetimeToken,
              });
            } catch (error) {
              reportError(error);
              await refreshCatalog.current?.();
              return;
            }
            const { migratedEpisodes, project } = assignment;
            setAssignments((current) => {
              if (project) return { ...current, [f.key]: project.id };
              const next = { ...current };
              delete next[f.key];
              return next;
            });
            const [counts, durable] = await Promise.all([
              countEpisodesByScope(),
              isProjectMemoryDurable(),
            ]);
            setEpisodeCounts(counts);
            if (!durable) setNotice(sessionGroupingNotice());
            else if (project && migratedEpisodes)
              setNotice(
                `已将「${f.name}」归入「${project.name}」，同步迁移 ${migratedEpisodes} 条历史需求档案`,
              );
          });
        }}
      >
        <option value="">未归类草稿</option>
        {projects.map((project) => (
          <option key={project.id} value={project.id}>
            {project.name}
          </option>
        ))}
      </select>
    );
  }

  const removeFile = async (target: FileSummary) => {
    try {
      await deleteLocalFile(
        target.key,
        target.lifetimeToken
          ? { expectedLifetimeToken: target.lifetimeToken }
          : undefined,
      );
      if (target.key === currentKey) {
        const remaining = files.find((f) => f.key !== target.key);
        if (remaining) location.replace(fileUrl(remaining.key));
        else await newBlankFile();
        return;
      }
    } catch (err) {
      reportError(err);
    }
    await refreshCatalog.current?.();
  };

  const commitRename = async (target: FileSummary, nextName: string) => {
    const { key, lifetimeToken } = target;
    const trimmed = nextName.trim();
    setRenaming(null);
    requestAnimationFrame(() => {
      const row = ref.current?.querySelector<HTMLElement>(
        `[data-file-key="${CSS.escape(key)}"] a[href]`,
      );
      (row ?? searchRef.current)?.focus();
    });
    if (!trimmed || target.name === trimmed) return;
    try {
      if (key === currentKey) renameCurrent(trimmed);
      else
        await renameLocalFile(
          key,
          trimmed,
          lifetimeToken ? { expectedLifetimeToken: lifetimeToken } : undefined,
        );
      setFiles((cur) =>
        cur.map((f) =>
          f.key === key && f.lifetimeToken === lifetimeToken
            ? { ...f, name: trimmed }
            : f,
        ),
      );
    } catch (err) {
      reportError(err);
      await refreshCatalog.current?.();
    }
  };

  async function duplicateFile(target: FileSummary) {
    try {
      const original = await readLocalDocument(
        target.key,
        target.lifetimeToken
          ? { expectedLifetimeToken: target.lifetimeToken }
          : undefined,
      );
      if (!original) throw new Error("文件已移除");
      const liveProject = await getFileProjectSpace(target.key, {
        requireDurable: typeof indexedDB !== "undefined",
        expectedLifetimeToken: target.lifetimeToken,
        requireBoundLifetime: typeof indexedDB !== "undefined",
      });
      if ((liveProject?.id ?? null) !== (assignedProjectId(target.key) ?? null))
        throw new Error("该设计文件的项目归属已变更，请刷新文件列表后重试");
      const copy = cloneDocument(original);
      copy.id = crypto.randomUUID();
      copy.revision = 0;
      copy.name = original.name.slice(0, 116) + " 副本";
      for (const library of Object.values(copy.libraries ?? {}))
        for (const component of library.components)
          if (component.master?.documentId === original.id)
            component.master.documentId = copy.id;
      await createBrowserFile(
        copy,
        selectedProject ? liveProject?.id : undefined,
      );
      setFiles(await recentFiles());
    } catch (err) {
      reportError(err);
      await refreshCatalog.current?.();
    }
  }
  const fileActions = (f: FileSummary) => (
    <>
      <button
        type="button"
        className="icon-btn icon-btn-sm"
        aria-label={`重命名 ${f.name}`}
        data-tip="重命名文件"
        data-tip-side="top"
        onClick={() => setRenaming(f)}
      >
        <Pencil size={12} />
      </button>
      <button
        className="icon-btn icon-btn-sm"
        aria-label={`复制 ${f.name}`}
        data-tip="创建独立副本"
        data-tip-side="top"
        onClick={() => void duplicateFile(f)}
      >
        <Copy size={12} />
      </button>
      <button
        type="button"
        className="icon-btn icon-btn-sm"
        aria-label={`删除 ${f.name}`}
        data-tip="删除文件"
        data-tip-side="top"
        onClick={() => void removeFile(f)}
      >
        <Trash2 size={12} />
      </button>
    </>
  );
  const renameInput = (f: FileSummary) => (
    <input
      autoFocus
      aria-label="重命名文件"
      data-escape-local
      defaultValue={f.name}
      maxLength={120}
      onFocus={(ev) => ev.currentTarget.select()}
      onBlur={(ev) => void commitRename(f, ev.target.value)}
      onKeyDown={(ev) => {
        if (ev.nativeEvent.isComposing) return;
        if (ev.key === "Enter") ev.currentTarget.blur();
        if (ev.key === "Escape") {
          ev.preventDefault();
          ev.currentTarget.value = f.name;
          ev.currentTarget.blur();
        }
      }}
    />
  );
  return (
    <div
      className="modal-backdrop"
      onPointerDown={(ev) => {
        if (ev.target === ev.currentTarget) close();
      }}
    >
      <div
        className="file-browser file-browser-wide"
        role="dialog"
        aria-modal="true"
        aria-label="本机文件"
        tabIndex={-1}
        ref={ref}
      >
        <div className="panel-heading">
          <strong>本机文件与项目空间</strong>
          <button
            className="icon-btn icon-btn-sm"
            aria-label="关闭本机文件"
            data-tip="关闭本机文件"
            data-tip-kbd="Esc"
            data-tip-side="bottom"
            onClick={close}
          >
            <X size={16} />
          </button>
        </div>
        <div className="file-browser-shell">
          <ProjectSidebar
            projects={projects}
            filter={activeFilter}
            selectFilter={setFilter}
            fileCounts={fileCounts}
            total={files.length}
            episodeCounts={episodeCounts}
            libraries={libraries}
            ensureDefaultLibrary={ensureDefaultLibrary}
            run={run}
            notify={setNotice}
          />
          <div className="file-browser-content">
            {selectedProject && (
              <div className="project-banner">
                <div className="project-banner-title">
                  <strong>{selectedProject.name}</strong>
                  <small className="project-memory-count">
                    {episodeCounts[projectScopeId(selectedProject.id)] ?? 0}{" "}
                    条历史需求档案
                  </small>
                </div>
                <div className="project-banner-actions">
                  <label>
                    默认组件库
                    <select
                      aria-label="项目默认组件库"
                      value={selectedProject.defaultLibraryId ?? ""}
                      onChange={(event) => {
                        const defaultLibraryId = event.target.value || null;
                        void run(async () => {
                          await ensureDefaultLibrary(defaultLibraryId);
                          await updateProjectSpace(selectedProject.id, {
                            defaultLibraryId,
                          });
                        });
                      }}
                    >
                      <LibraryOptions
                        libraries={libraries}
                        value={selectedProject.defaultLibraryId}
                      />
                    </select>
                  </label>
                  <button
                    onClick={() => run(() => newBlankFile(selectedProject.id))}
                  >
                    <FilePlus2 size={14} />
                    在此项目中新建
                  </button>
                </div>
              </div>
            )}
            <div className="file-browser-toolbar">
              <label className="search">
                <Search size={14} />
                <input
                  ref={searchRef}
                  aria-label="搜索文件"
                  placeholder="搜索本机设计文件…"
                  value={query}
                  onChange={(ev) => search(ev.target.value)}
                />
                {query && (
                  <button
                    type="button"
                    className="icon-btn icon-btn-sm"
                    aria-label="清空搜索"
                    data-tip="清空搜索"
                    data-tip-side="bottom"
                    onClick={() => search("")}
                  >
                    <X size={12} />
                  </button>
                )}
              </label>
              <button
                className="icon-btn icon-btn-sm"
                aria-label="网格视图"
                data-tip="网格视图"
                data-tip-side="bottom"
                aria-pressed={view === "grid"}
                onClick={() => setView("grid")}
              >
                <LayoutGrid size={14} />
              </button>
              <button
                className="icon-btn icon-btn-sm"
                aria-label="列表视图"
                data-tip="列表视图"
                data-tip-side="bottom"
                aria-pressed={view === "list"}
                onClick={() => setView("list")}
              >
                <List size={14} />
              </button>
              <span className="toolbar-sep" aria-hidden="true" />
              <button
                className="icon-btn icon-btn-sm"
                title="导入为独立文件"
                aria-label="导入为独立文件"
                data-tip="导入为独立文件"
                data-tip-desc="从 Forma、Sketch 或 Figma 原生文件创建本机副本"
                data-tip-side="bottom"
                onClick={() => input.current?.click()}
              >
                <Upload size={15} />
              </button>
              <button
                className="icon-btn icon-btn-sm"
                title="新建设计文件"
                aria-label="新建设计文件"
                data-tip="新建设计文件"
                data-tip-desc="创建一个空白设计文件并立即切换"
                data-tip-side="bottom"
                onClick={() => run(() => newBlankFile(selectedProject?.id))}
              >
                <FilePlus2 size={16} />
              </button>
            </div>
            {!filtered.length ? (
              <p className="compact-empty" role="status">
                {query
                  ? "未找到匹配的本机文件"
                  : isDesktopRuntime()
                    ? "本机工作空间暂无已保存的设计文件"
                    : "暂无已保存的本机文件"}
              </p>
            ) : view === "grid" ? (
              <div className="recent-files file-grid">
                {filtered.map((f) => (
                  <div className="file-card" key={f.key} data-file-key={f.key}>
                    <FileThumbnail
                      file={f}
                      current={f.key === currentKey ? current : undefined}
                    />
                    <div className="file-card-meta">
                      {renaming?.key === f.key ? (
                        renameInput(renaming)
                      ) : (
                        <a href={fileUrl(f.key)} title={f.name}>
                          {f.name}
                        </a>
                      )}
                      {fileActions(f)}
                    </div>
                    {projectSelect(f)}
                    <div className="file-card-detail">
                      <span>{f.pages} 页</span>
                      <time>
                        {f.updatedAt
                          ? new Date(f.updatedAt).toLocaleString([], {
                              month: "numeric",
                              day: "numeric",
                              hour: "2-digit",
                              minute: "2-digit",
                            })
                          : ""}
                      </time>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="recent-files">
                {filtered.map((f) => (
                  <div
                    key={f.key}
                    className="file-list-row"
                    data-file-key={f.key}
                  >
                    {renaming?.key === f.key ? (
                      renameInput(renaming)
                    ) : (
                      <a href={fileUrl(f.key)}>
                        <File size={15} />
                        <span className="truncate">{f.name}</span>
                        <small>{f.pages} 页</small>
                        <time>
                          {f.updatedAt
                            ? new Date(f.updatedAt).toLocaleDateString()
                            : null}
                        </time>
                      </a>
                    )}
                    {projectSelect(f)}
                    {fileActions(f)}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
        {notice && (
          <p className="file-browser-notice" role="status">
            {notice}
          </p>
        )}
        {error && (
          <p className="file-browser-notice" role="alert">
            {error}
          </p>
        )}
        <input
          type="file"
          hidden
          ref={input}
          data-testid="browser-design-file-input"
          accept={acceptedDesignFiles}
          onChange={async (ev) => {
            const file = ev.target.files?.[0];
            ev.target.value = "";
            if (!file) return;
            try {
              const external = await isExternalDesign(file);
              checkDesignFileSize(file.size, external);
              if (external) {
                externalImport(file, selectedProject?.id ?? null);
                return;
              }
              location.assign(
                await createBrowserFile(
                  await readNativeDocument(file),
                  selectedProject?.id,
                ),
              );
            } catch (err) {
              reportError(err);
            }
          }}
        />
      </div>
    </div>
  );
}
