import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  AppWindow,
  ArrowUpRight,
  Clock3,
  Files,
  Folder,
  FolderOpen,
  Grid2X2,
  Layers2,
  List,
  Menu,
  Monitor,
  Moon,
  Pencil,
  Plus,
  Search,
  SlidersHorizontal,
  Smartphone,
  Sparkles,
  SquareDashed,
  Sun,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { projectScopeId, type ProjectSpace } from "../agent/project-memory";
import { BUILTIN_LIBRARIES } from "../design-system/catalog";
import {
  acceptedDesignFiles,
  checkDesignFileSize,
  isExternalDesign,
} from "../infrastructure/design-import/types";
import { listWorkspaceLibraries } from "../infrastructure/library-catalog-store";
import { readNativeDocument } from "../infrastructure/native-document";
import {
  countEpisodesByScope,
  createProjectSpace,
  deleteProjectSpace,
  isProjectMemoryDurable,
  listFileProjectAssignments,
  listProjectSpaces,
  subscribeProjectMemory,
  updateProjectSpace,
} from "../infrastructure/project-memory-store";
import {
  cachedRecentFiles,
  fileUrl,
  recentFiles,
  type FileSummary,
} from "../infrastructure/storage";
import {
  createBrowserFile,
  editorFileUrl,
  newDesignFile,
  type QuickStartPreset,
} from "./file-actions";
import {
  createDesignTab,
  createDocumentTab,
  FilePreview,
  isPlainClick,
  LibraryOptions,
  sessionGroupingNotice,
  WorkspaceImportDialog,
  type OpenFileTab,
} from "./FileBrowser";
import { TooltipHost } from "./TooltipHost";
import {
  isDesktopRuntime,
  storageUnavailableCopy,
  WELCOME_FRAME_PRESETS,
} from "./ux-copy";
import "./workspace-home.css";

export interface WorkspaceHomeProps {
  initialTheme?: "dark" | "light";
  onOpenModelConfig?: () => void;
  onOpenIntegrations?: () => void;
  onOpenReleaseNotes?: () => void;
  onImportExternalFile?: (file: File, projectId: string | null) => void;
  onOpenNativeFile?: (file: File, projectId: string | null) => Promise<void>;
  onOpenFileTab?: OpenFileTab;
  onOpenExampleTab?: (target: {
    example: string;
    edition?: string;
    page?: string;
    node?: string;
    title: string;
  }) => void;
  openFileKeys?: ReadonlySet<string>;
  agentConnectedLabel?: string | null;
}

const examples = [
  { title: "SaaS 工作台样例", params: { example: "aura-showcase" } },
  {
    title: "移动设计研究室",
    params: {
      example: "mobile-studio",
      edition: "atlas",
      page: "atlas",
      node: "atlas-tablet-root",
    },
  },
] as const;

type Theme = "dark" | "light";
type LibraryChoice = { id: string; name: string };
const views = [
  { id: "recent", label: "最近打开", icon: Clock3 },
  { id: "all", label: "全部文件", icon: Files },
  { id: "unassigned", label: "未归类草稿", icon: FolderOpen },
] as const;
const { mobile, desktop } = WELCOME_FRAME_PRESETS;
const starts = [
  {
    preset: "mobile",
    label: "新建移动端设计",
    detail: `${mobile.label} · ${mobile.w} × ${mobile.h}`,
    icon: Smartphone,
  },
  {
    preset: "desktop",
    label: "新建桌面端设计",
    detail: `Web · ${desktop.w} × ${desktop.h}`,
    icon: Monitor,
  },
  {
    preset: "ai",
    label: "用 Forma AI 起稿",
    detail: "自然语言生成可编辑画板",
    icon: Sparkles,
  },
  {
    preset: "blank",
    label: "空白画布",
    detail: "从零开始自由绘制",
    icon: SquareDashed,
  },
] as const;

const recentKey = "forma.workspace.recent-opens";
const recentLimit = 24;
function recentOpens(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const value: unknown = JSON.parse(localStorage.getItem(recentKey) ?? "[]");
    if (Array.isArray(value))
      return value
        .filter((key): key is string => typeof key === "string")
        .slice(0, recentLimit);
  } catch {
    /* History is optional in restricted storage contexts. */
  }
  return [];
}
function rememberOpen(key: string) {
  const next = [key, ...recentOpens().filter((id) => id !== key)].slice(
    0,
    recentLimit,
  );
  try {
    localStorage.setItem(recentKey, JSON.stringify(next));
  } catch {
    /* Opening is still available. */
  }
}
function returningFromEditor(): string | undefined {
  if (!document.referrer) return;
  const previous = new URL(document.referrer);
  if (
    previous.protocol !== location.protocol ||
    previous.host !== location.host ||
    previous.pathname !== location.pathname
  )
    return;
  const file = previous.searchParams.get("file");
  if (file) return file;
  if (previous.searchParams.get("editor") === "1") return "forma.document.v1";
  const example = previous.searchParams.get("example");
  if (example === "aura-showcase") return "forma.example.aura-showcase.v1";
  if (example === "mobile-studio") {
    const edition = previous.searchParams.get("edition");
    return (
      "forma.example.mobile-studio." +
      (edition === "atlas" || edition === "flows" ? edition : "v1")
    );
  }
}
function savedTheme(): Theme {
  if (typeof window === "undefined") return "dark";
  try {
    return localStorage.getItem("forma.ui-theme") === "light"
      ? "light"
      : "dark";
  } catch {
    return "dark";
  }
}
function workspaceError(error: unknown) {
  const text = error instanceof Error ? error.message : String(error);
  if (/indexeddb|IDBDatabase|IDBTransaction/i.test(text))
    return isDesktopRuntime()
      ? "暂时无法访问本机设计文件，请重新打开工作台。"
      : "暂时无法访问设计文件，请检查浏览器的本地存储权限。";
  return text.replace(
    "当前浏览器未启用本地持久存储，跨页跳转后项目归属无法保存",
    storageUnavailableCopy(),
  );
}

function useCatalog() {
  const [files, setFiles] = useState(cachedRecentFiles);
  const [projects, setProjects] = useState<ProjectSpace[]>([]);
  const [assignments, setAssignments] = useState<Record<string, string>>({});
  const [episodes, setEpisodes] = useState<Record<string, number>>({});
  const [libraries, setLibraries] = useState<LibraryChoice[]>(
    BUILTIN_LIBRARIES.map(({ id, name }) => ({ id, name })),
  );
  const [error, setError] = useState("");
  const [opens, setOpens] = useState(recentOpens);
  useEffect(() => {
    let generation = 0;
    const previous = returningFromEditor();
    if (previous) rememberOpen(previous);
    async function refresh() {
      const read = ++generation;
      setOpens(recentOpens());
      const [filesResult, projectsResult, libraryResult] =
        await Promise.allSettled([
          recentFiles(),
          Promise.all([
            listProjectSpaces(),
            listFileProjectAssignments(),
            countEpisodesByScope(),
          ]),
          listWorkspaceLibraries(),
        ]);
      if (read !== generation) return;
      if (filesResult.status === "fulfilled") setFiles(filesResult.value);
      if (projectsResult.status === "fulfilled") {
        const [spaces, assigned, counts] = projectsResult.value;
        setProjects(spaces);
        setAssignments(assigned);
        setEpisodes(counts);
      }
      if (libraryResult.status === "fulfilled") {
        const unique = new Map(
          [...BUILTIN_LIBRARIES, ...libraryResult.value].map(({ id, name }) => [
            id,
            { id, name },
          ]),
        );
        setLibraries([...unique.values()]);
      }
      const failed = [filesResult, projectsResult, libraryResult].find(
        (result) => result.status === "rejected",
      );
      setError(
        failed?.status === "rejected" ? workspaceError(failed.reason) : "",
      );
    }
    const unsubscribe = subscribeProjectMemory(refresh);
    void refresh();
    window.addEventListener("focus", refresh);
    window.addEventListener("pageshow", refresh);
    return () => {
      generation++;
      unsubscribe();
      window.removeEventListener("focus", refresh);
      window.removeEventListener("pageshow", refresh);
    };
  }, []);
  function updateProject(project: ProjectSpace) {
    setProjects((existing) => [
      project,
      ...existing.filter(({ id }) => id !== project.id),
    ]);
  }
  return {
    files,
    projects,
    assignments,
    episodes,
    libraries,
    opens,
    error,
    updateProject,
  };
}

type Run = (operation: () => Promise<void>) => Promise<void>;
function ProjectForm({
  project,
  libraries,
  onSave,
  cancel,
  run,
}: {
  project?: ProjectSpace;
  libraries: LibraryChoice[];
  onSave: (project: ProjectSpace) => void | Promise<void>;
  cancel: () => void;
  run: Run;
}) {
  const [name, setName] = useState(project?.name ?? "");
  const [library, setLibrary] = useState("");
  function submit(event: FormEvent) {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    void run(async () => {
      const result = project
        ? await updateProjectSpace(project.id, { name: trimmed })
        : await createProjectSpace({
            name: trimmed,
            defaultLibraryId: library || undefined,
          });
      await onSave(result);
    });
  }
  return (
    <form
      className="wh-project-form"
      aria-label={project ? "重命名项目" : "创建项目"}
      onSubmit={submit}
      onKeyDown={(event) => {
        if (event.key === "Escape" && !event.nativeEvent.isComposing) cancel();
      }}
    >
      <input
        aria-label="项目名称"
        placeholder="项目名称"
        autoFocus
        required
        maxLength={120}
        value={name}
        onChange={(event) => setName(event.target.value)}
      />
      {!project && (
        <select
          aria-label="默认组件库"
          value={library}
          onChange={(event) => setLibrary(event.target.value)}
        >
          <LibraryOptions libraries={libraries} />
        </select>
      )}
      <div className="wh-inline">
        <button className="wh-secondary" type="submit" disabled={!name.trim()}>
          {project ? "保存" : "创建项目"}
        </button>
        <button type="button" onClick={cancel}>
          取消
        </button>
      </div>
    </form>
  );
}

function FileTile({
  file,
  project,
  isOpen,
  onOpenFileTab,
}: {
  file: FileSummary;
  project?: string;
  isOpen?: boolean;
  onOpenFileTab?: OpenFileTab;
}) {
  return (
    <a
      className="wh-file"
      href={editorFileUrl(fileUrl(file.key))}
      aria-label={`打开 ${file.name}`}
      aria-description={isOpen ? "已打开" : undefined}
      onClick={(event) => {
        rememberOpen(file.key);
        if (onOpenFileTab && isPlainClick(event)) {
          event.preventDefault();
          onOpenFileTab({ fileKey: file.key, title: file.name });
        }
      }}
    >
      <span className="wh-cover">
        <FilePreview file={file} />
      </span>
      <span className="wh-file-info">
        <strong>{file.name}</strong>
        <small>
          {project ?? "未归类草稿"} · {file.pages} 页
          {isOpen && (
            <>
              {" "}
              <span className="wh-pill">已打开</span>
            </>
          )}
        </small>
      </span>
      {file.updatedAt > 0 && (
        <time dateTime={new Date(file.updatedAt).toISOString()}>
          {new Date(file.updatedAt).toLocaleDateString("zh-CN", {
            month: "short",
            day: "numeric",
          })}
        </time>
      )}
    </a>
  );
}

export function WorkspaceHome({
  initialTheme,
  onOpenModelConfig,
  onOpenIntegrations,
  onOpenReleaseNotes,
  onImportExternalFile,
  onOpenNativeFile,
  onOpenFileTab,
  onOpenExampleTab,
  openFileKeys,
  agentConnectedLabel,
}: WorkspaceHomeProps) {
  const catalog = useCatalog();
  const [theme, setTheme] = useState<Theme>(() => initialTheme ?? savedTheme());
  const [view, setView] = useState("recent");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<"updated" | "name" | "opened">("opened");
  const [layout, setLayout] = useState<"grid" | "list">("grid");
  const [edit, setEdit] = useState<"new" | "rename" | "delete" | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [externalImport, setExternalImport] = useState<{
    file: File;
    projectId: string | null;
  } | null>(null);
  const [error, setError] = useState("");
  const pending = useRef(false);
  const input = useRef<HTMLInputElement>(null);
  const menuButton = useRef<HTMLButtonElement>(null);
  const newProjectButton = useRef<HTMLButtonElement>(null);
  const renameButton = useRef<HTMLButtonElement>(null);
  const dragDepth = useRef(0);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem("forma.ui-theme", theme);
    } catch {
      /* Apply the theme for this session. */
    }
  }, [theme]);
  const activeProject = catalog.projects.find((project) => project.id === view);
  const targetProjectId = activeProject?.id ?? null;
  const currentView =
    activeProject?.id ??
    (views.some((item) => item.id === view) ? view : "all");
  const title =
    activeProject?.name ?? views.find((item) => item.id === currentView)?.label;
  const projectNames = new Map(
    catalog.projects.map(({ id, name }) => [id, name]),
  );
  const counts = new Map<string, number>();
  const projectForFile = (key: string) =>
    Object.hasOwn(catalog.assignments, key)
      ? catalog.assignments[key]
      : "unassigned";
  for (const file of catalog.files) {
    const id = projectForFile(file.key);
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  const recentRank = new Map(catalog.opens.map((key, rank) => [key, rank]));
  const scopeFiles =
    currentView === "recent"
      ? [...catalog.files]
          .sort(
            (a, b) =>
              (recentRank.get(a.key) ?? recentLimit) -
                (recentRank.get(b.key) ?? recentLimit) ||
              b.updatedAt - a.updatedAt,
          )
          .slice(0, recentLimit)
      : catalog.files.filter(
          (file) =>
            currentView === "all" || projectForFile(file.key) === currentView,
        );
  const search = query.trim().toLocaleLowerCase();
  const filtered = scopeFiles.filter(({ name }) =>
    name.toLocaleLowerCase().includes(search),
  );
  if (sort === "name")
    filtered.sort((a, b) =>
      a.name.localeCompare(b.name, "zh-CN", { numeric: true }),
    );
  else if (sort === "updated" || currentView !== "recent")
    filtered.sort((a, b) => b.updatedAt - a.updatedAt);

  const appVersion =
    (typeof window !== "undefined" && window.formaDesktop?.version) ||
    (typeof __FORMA_VERSION__ === "string" ? __FORMA_VERSION__ : "");
  const themeLabel = theme === "light" ? "切换深色主题" : "切换浅色主题";
  function selectView(id: string) {
    setView(id);
    setQuery("");
    setEdit(null);
    setExpanded(false);
    setError("");
    setSort(id === "recent" ? "opened" : "updated");
    if (expanded) menuButton.current?.focus();
  }
  async function run(operation: () => Promise<void>) {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      await operation();
    } catch (cause) {
      setError(workspaceError(cause));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  function start(preset: QuickStartPreset) {
    void run(() =>
      onOpenFileTab
        ? createDesignTab(onOpenFileTab, preset, targetProjectId)
        : newDesignFile({ projectId: targetProjectId, preset }),
    );
  }
  function openFile(file: File) {
    void run(async () => {
      const external = await isExternalDesign(file);
      checkDesignFileSize(file.size, external);
      if (external) {
        if (onImportExternalFile)
          await onImportExternalFile(file, targetProjectId);
        else setExternalImport({ file, projectId: targetProjectId });
      } else if (onOpenNativeFile)
        await onOpenNativeFile(file, targetProjectId);
      else {
        const doc = await readNativeDocument(file);
        if (onOpenFileTab)
          await createDocumentTab(onOpenFileTab, doc, targetProjectId);
        else
          location.assign(
            editorFileUrl(await createBrowserFile(doc, targetProjectId)),
          );
      }
    });
  }
  const displayIssue = error || catalog.error;
  return (
    <>
      <div
        className="workspace-home"
        data-theme={theme}
        onDragEnter={(event) => {
          if (!event.dataTransfer.types.includes("Files")) return;
          event.preventDefault();
          dragDepth.current++;
          setDragging(true);
        }}
        onDragOver={(event) => {
          if (event.dataTransfer.types.includes("Files")) {
            event.preventDefault();
            event.dataTransfer.dropEffect = "copy";
          }
        }}
        onDragLeave={() => {
          dragDepth.current = Math.max(0, dragDepth.current - 1);
          if (!dragDepth.current) setDragging(false);
        }}
        onDrop={(event) => {
          if (!event.dataTransfer.types.includes("Files")) return;
          event.preventDefault();
          dragDepth.current = 0;
          setDragging(false);
          if (event.dataTransfer.files.length > 1)
            setError("请每次拖入一个设计文件。");
          else if (event.dataTransfer.files[0])
            openFile(event.dataTransfer.files[0]);
        }}
      >
        <aside className="wh-sidebar" aria-label="工作台导航">
          <div className="wh-brand-row">
            <span className="wh-mark" aria-hidden="true">
              f
            </span>
            <strong>Forma</strong>
            <button
              className="wh-version"
              aria-label="版本日志"
              data-tip="版本日志"
              data-tip-side="bottom"
              disabled={!onOpenReleaseNotes}
              onClick={onOpenReleaseNotes}
            >
              v{appVersion}
            </button>
            <button
              className="icon-btn wh-theme"
              aria-label={themeLabel}
              data-tip={themeLabel}
              data-tip-side="bottom"
              onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
            >
              {theme === "dark" ? <Sun size={16} /> : <Moon size={16} />}
            </button>
            <button
              ref={menuButton}
              className="icon-btn wh-menu"
              aria-label="工作台导航"
              aria-expanded={expanded}
              aria-controls="wh-navigation"
              data-tip="工作台导航"
              data-tip-side="bottom"
              onClick={() => setExpanded(!expanded)}
            >
              {expanded ? <X size={18} /> : <Menu size={18} />}
            </button>
          </div>
          <div
            className="wh-navigation"
            id="wh-navigation"
            data-expanded={expanded}
            onKeyDown={(event) => {
              if (expanded && !edit && event.key === "Escape") {
                setExpanded(false);
                menuButton.current?.focus();
              }
            }}
          >
            <nav className="wh-nav" aria-label="工作台视图">
              {views.map(({ id, label, icon: Icon }) => (
                <button
                  key={id}
                  aria-label={label}
                  aria-current={currentView === id ? "page" : undefined}
                  onClick={() => selectView(id)}
                >
                  <Icon size={17} />
                  <span>{label}</span>
                  {id !== "recent" && (
                    <small className="wh-count">
                      {id === "all"
                        ? catalog.files.length
                        : (counts.get(id) ?? 0)}
                    </small>
                  )}
                </button>
              ))}
            </nav>
            <nav className="wh-projects" aria-label="项目空间">
              <div className="wh-project-heading">
                <h2>项目空间</h2>
                <button
                  ref={newProjectButton}
                  aria-label="新建项目"
                  aria-expanded={edit === "new"}
                  onClick={() => setEdit(edit === "new" ? null : "new")}
                >
                  <Plus size={13} />
                  新建项目
                </button>
              </div>
              {edit === "new" && (
                <ProjectForm
                  libraries={catalog.libraries}
                  run={run}
                  onSave={async (project) => {
                    catalog.updateProject(project);
                    selectView(project.id);
                    if (!(await isProjectMemoryDurable()))
                      setError(sessionGroupingNotice());
                  }}
                  cancel={() => {
                    setEdit(null);
                    newProjectButton.current?.focus();
                  }}
                />
              )}
              {catalog.projects.map((project) => (
                <button
                  key={project.id}
                  className="wh-project"
                  aria-label={project.name}
                  aria-current={view === project.id ? "page" : undefined}
                  onClick={() => selectView(project.id)}
                >
                  <Folder size={16} />
                  <span className="wh-project-name">
                    {project.name}
                    {project.defaultLibraryId && (
                      <small>
                        {catalog.libraries.find(
                          (lib) => lib.id === project.defaultLibraryId,
                        )?.name ?? "默认组件库"}
                      </small>
                    )}
                  </span>
                  <small className="wh-count">
                    {counts.get(project.id) ?? 0}
                  </small>
                </button>
              ))}
            </nav>
            <div className="wh-utilities">
              <button disabled={!onOpenModelConfig} onClick={onOpenModelConfig}>
                <SlidersHorizontal size={16} />
                <span>AI 模型配置</span>
                <small className={agentConnectedLabel ? "wh-connected" : ""}>
                  {agentConnectedLabel || "未连接"}
                </small>
              </button>
              <button
                disabled={!onOpenIntegrations}
                onClick={onOpenIntegrations}
              >
                <Layers2 size={16} />
                外部工具集成 (MCP)
              </button>
              <div className="wh-samples">
                {examples.map(({ title, params }) => (
                  <a
                    key={params.example}
                    href={`?${new URLSearchParams(params)}`}
                    onClick={(event) => {
                      if (onOpenExampleTab && isPlainClick(event)) {
                        event.preventDefault();
                        onOpenExampleTab({ ...params, title });
                      }
                    }}
                  >
                    {title} <span>↗</span>
                  </a>
                ))}
              </div>
            </div>
          </div>
        </aside>
        <main className="wh-main" aria-label="Forma 工作台">
          <div className="wh-content">
            <header className="wh-header">
              <div className="wh-context">
                <div className="wh-inline">
                  <h1>{title}</h1>
                  {activeProject && (
                    <button
                      ref={renameButton}
                      className="icon-btn"
                      aria-label="重命名项目"
                      data-tip="重命名项目"
                      data-tip-side="bottom"
                      onClick={() => setEdit("rename")}
                    >
                      <Pencil size={15} />
                    </button>
                  )}
                </div>
                {activeProject && (
                  <small>将自动归入「{activeProject.name}」</small>
                )}
              </div>
              <div className="wh-actions">
                <button
                  className="primary wh-primary-cta"
                  aria-label="新建设计"
                  disabled={busy}
                  onClick={() => start("blank")}
                >
                  + 新建设计
                </button>
                <button
                  className="wh-secondary"
                  disabled={busy}
                  onClick={() => input.current?.click()}
                >
                  <Upload size={16} />
                  导入设计文件
                </button>
              </div>
            </header>
            {activeProject && (
              <div className="wh-project-settings" key={activeProject.id}>
                {edit === "rename" && (
                  <ProjectForm
                    project={activeProject}
                    libraries={catalog.libraries}
                    run={run}
                    onSave={(project) => {
                      catalog.updateProject(project);
                      setEdit(null);
                      renameButton.current?.focus();
                    }}
                    cancel={() => {
                      setEdit(null);
                      renameButton.current?.focus();
                    }}
                  />
                )}
                <label>
                  默认组件库
                  <select
                    aria-label="项目默认组件库"
                    value={activeProject.defaultLibraryId ?? ""}
                    disabled={busy}
                    onChange={(event) => {
                      const defaultLibraryId = event.target.value || null;
                      void run(async () => {
                        catalog.updateProject(
                          await updateProjectSpace(activeProject.id, {
                            defaultLibraryId,
                          }),
                        );
                      });
                    }}
                  >
                    <LibraryOptions
                      libraries={catalog.libraries}
                      value={activeProject.defaultLibraryId}
                    />
                  </select>
                </label>
                <small className="wh-pill">
                  {catalog.episodes[projectScopeId(activeProject.id)] ?? 0}{" "}
                  条历史需求档案
                </small>
                <button
                  className="icon-btn"
                  aria-label="删除项目"
                  data-tip="删除项目"
                  data-tip-desc="保留设计文件，移除项目历史档案"
                  data-tip-side="bottom"
                  onClick={() => setEdit("delete")}
                >
                  <Trash2 size={15} />
                </button>
                {edit === "delete" && (
                  <div
                    className="wh-confirm"
                    role="group"
                    aria-label="确认删除项目"
                  >
                    <span>
                      删除「{activeProject.name}
                      」及其历史需求档案？设计文件将移至未归类草稿。
                    </span>
                    <button
                      disabled={busy}
                      className="wh-danger"
                      onClick={() =>
                        void run(async () => {
                          await deleteProjectSpace(activeProject.id);
                          selectView("unassigned");
                        })
                      }
                    >
                      确认删除
                    </button>
                    <button onClick={() => setEdit(null)}>取消</button>
                  </div>
                )}
              </div>
            )}
            {displayIssue && (
              <p className="wh-issue" role="alert">
                {displayIssue}
              </p>
            )}
            {(currentView === "recent" ||
              currentView === "all" ||
              !scopeFiles.length) && (
              <section className="wh-quickstart" aria-label="快速开始">
                {starts.map(({ preset, label, detail, icon: Icon }) => (
                  <button
                    key={preset}
                    data-preset={preset}
                    aria-label={label}
                    disabled={busy}
                    onClick={() => start(preset)}
                  >
                    <span className="wh-art" aria-hidden="true">
                      <Icon size={32} strokeWidth={1.5} />
                      <ArrowUpRight className="wh-start-arrow" size={15} />
                    </span>
                    <strong>{label}</strong>
                    <small>{detail}</small>
                  </button>
                ))}
              </section>
            )}
            <section className="wh-gallery" aria-label="设计文件">
              <div className="wh-toolbar">
                <h2>
                  设计文件 <span>{filtered.length}</span>
                </h2>
                <label className="wh-search">
                  <Search size={15} />
                  <input
                    type="search"
                    aria-label="搜索设计文件"
                    placeholder="搜索设计文件…"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                  />
                </label>
                <select
                  aria-label="文件排序"
                  value={
                    sort === "opened" && currentView !== "recent"
                      ? "updated"
                      : sort
                  }
                  onChange={(event) =>
                    setSort(event.target.value as typeof sort)
                  }
                >
                  {currentView === "recent" && (
                    <option value="opened">最近打开</option>
                  )}
                  <option value="updated">最近更新</option>
                  <option value="name">名称</option>
                </select>
                <div className="wh-layout" role="group" aria-label="文件视图">
                  {(
                    [
                      { id: "grid", label: "网格视图", icon: Grid2X2 },
                      { id: "list", label: "列表视图", icon: List },
                    ] as const
                  ).map(({ id, label, icon: Icon }) => (
                    <button
                      key={id}
                      className="icon-btn"
                      aria-label={label}
                      data-tip={label}
                      data-tip-side="bottom"
                      aria-pressed={layout === id}
                      onClick={() => setLayout(id)}
                    >
                      <Icon size={16} />
                    </button>
                  ))}
                </div>
              </div>
              {filtered.length ? (
                <div className={`wh-files wh-${layout}`}>
                  {filtered.map((file) => (
                    <FileTile
                      key={file.key}
                      file={file}
                      project={projectNames.get(projectForFile(file.key))}
                      isOpen={openFileKeys?.has(file.key)}
                      onOpenFileTab={onOpenFileTab}
                    />
                  ))}
                </div>
              ) : (
                <div className="wh-empty" role="status">
                  {search ? (
                    <Search size={24} />
                  ) : (
                    <AppWindow size={30} strokeWidth={1.25} />
                  )}
                  <strong>
                    {search
                      ? "未找到匹配的设计文件"
                      : activeProject
                        ? "这个项目还没有设计文件"
                        : currentView === "unassigned"
                          ? "暂无未归类草稿"
                          : isDesktopRuntime()
                            ? "本机工作空间暂无已保存的设计文件"
                            : "当前浏览器暂无已保存的设计文件"}
                  </strong>
                  {search ? (
                    <button onClick={() => setQuery("")}>清空搜索</button>
                  ) : (
                    <span>拖入 Forma、Figma 或 Sketch 文件即可开始。</span>
                  )}
                </div>
              )}
            </section>
          </div>
        </main>
        <input
          type="file"
          ref={input}
          hidden
          aria-label="选择设计文件"
          accept={acceptedDesignFiles}
          onChange={(event) => {
            const file = event.currentTarget.files?.[0];
            event.currentTarget.value = "";
            if (file) openFile(file);
          }}
        />
        {dragging && (
          <div className="wh-drop" role="status">
            <Upload size={28} />
            松开以导入设计文件
          </div>
        )}
        <TooltipHost />
      </div>
      {externalImport && (
        <WorkspaceImportDialog
          file={externalImport.file}
          targetProjectId={externalImport.projectId}
          onImported={
            onOpenFileTab &&
            ((target) => {
              setExternalImport(null);
              onOpenFileTab(target);
            })
          }
          close={() => setExternalImport(null)}
        />
      )}
    </>
  );
}
