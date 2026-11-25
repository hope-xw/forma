import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  Archive,
  ArrowLeft,
  FileInput,
  Layers,
  Library,
  RefreshCw,
  X,
} from "lucide-react";
import {
  BUILTIN_LIBRARIES,
  BUILTIN_LIBRARY_IDS,
  type BuiltinLibraryEntry,
} from "../design-system/catalog";
import {
  buildLibraryManifest,
  generateLibraryPlaybook,
} from "../agent/library-intelligence";
import { installLibrary } from "../domain/library";
import { integrateLibrarySystem } from "../domain/library-design-system";
import type { DesignDocument } from "../domain/document";
import {
  allLibraryInstanceCounts,
  countLibraryInstances,
  packageDocumentAsLibrary,
} from "../domain/library-packaging";
import {
  parseLibrary,
  type ComponentLibrary,
  type LibraryAiGuide,
} from "../domain/library-schema";
import { loadFonts } from "../infrastructure/font-import";
import {
  listWorkspaceLibraries,
  updateWorkspaceLibraryAiGuide,
  deleteWorkspaceLibrary,
  saveWorkspaceLibrary,
  type WorkspaceLibraryRecord,
} from "../infrastructure/library-catalog-store";
import {
  fetchLibrary,
  subscriptions,
  saveSubscription,
  type Subscription,
} from "../infrastructure/subscribed-libraries";
import { download } from "../infrastructure/storage";
import { AssetPreview } from "./AssetPreview";
import { PublishLibrary } from "./PublishLibrary";
import { useModalDialog } from "./useModalDialog";
import type { EditorController } from "./useEditor";

// A file can contain only the official components that have been inserted.
export function browsableLibrary(
  entry: BuiltinLibraryEntry,
  doc: DesignDocument,
): ComponentLibrary {
  const installed = doc.libraries?.[entry.id];
  if (!installed) return entry.library;
  if (installed.revision !== entry.library.revision) return installed;
  const ids = new Set(installed.components.map((c) => c.id));
  const missing = entry.library.components.filter((c) => !ids.has(c.id));
  if (!missing.length) return installed;
  const extra = integrateLibrarySystem(
    { ...doc, designSystem: installed.designSystem },
    { ...entry.library, components: missing },
  );
  return {
    ...installed,
    designSystem: extra.system,
    components: [...installed.components, ...extra.library.components],
  };
}

export async function readLibraryFile(file: File) {
  if (file.size > 15_000_000) throw Error("组件库超过 15 MB，请拆分导入");
  const library = parseLibrary(JSON.parse(await file.text()));
  await loadFonts(library.fonts);
  return library;
}

export function downloadLibrary(lib: ComponentLibrary, name = lib.name) {
  const slug = name
    .trim()
    .replace(/[^\p{L}\p{N}_-]+/gu, "-")
    .replace(/^-|-$/g, "");
  download(
    `${slug || lib.id}.forma-library.json`,
    JSON.stringify(lib, null, 2),
  );
}

type ManagerProps = {
  editor: EditorController;
  enabledIds: string[];
  onEnabledChange: (ids: string[]) => void;
  close: () => void;
  onFoundations: (id: string) => void;
  onImportLibrary: (lib: ComponentLibrary) => void;
  onReviewLibrary: (lib: ComponentLibrary) => void;
  onSubscriptionsChange: () => void;
};

type Notice = { message: string; error?: boolean };
export function guideSaveNotice(
  name: string,
  res: Awaited<ReturnType<typeof updateWorkspaceLibraryAiGuide>>,
  editorError?: string,
): Notice {
  let message = `已应用「${name}」AI 说明书到当前文档`;
  if (res.status === "updated") message += "（工作区已同步）";
  if (res.status === "conflict")
    message = `已应用到当前文档；工作区中已有更新版本 r${res.currentRevision}，未覆盖工作区副本`;
  if (res.status === "error")
    message = "已应用到当前文档；工作区同步失败：" + res.message;
  if (editorError) message += "；" + editorError;
  return {
    message,
    error:
      Boolean(editorError) ||
      res.status === "conflict" ||
      res.status === "error",
  };
}

const errorText = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
const tabNames = [
  ["builtin", "官方体系"],
  ["custom", "本文件与自定义"],
  ["subscriptions", "在线订阅"],
] as const;
type Tab = (typeof tabNames)[number][0];

export function LibraryManagerModal(props: ManagerProps) {
  const { editor: e, enabledIds, onEnabledChange, close } = props;
  const [tab, setTab] = useState<Tab>("builtin");
  const [guideId, setGuideId] = useState("");
  const returnGuideFocusId = useRef("");
  const modal = useModalDialog(true, () =>
    guideId ? setGuideId("") : close(),
  );
  useLayoutEffect(() => {
    if (guideId || !returnGuideFocusId.current) return;
    modal.current
      ?.querySelector<HTMLButtonElement>(
        `button[data-guide-trigger="${CSS.escape(returnGuideFocusId.current)}"]`,
      )
      ?.focus();
    returnGuideFocusId.current = "";
  }, [guideId, modal]);
  const guideLibrary = useMemo(() => {
    if (!guideId) return;
    const entry =
      tab === "builtin" &&
      BUILTIN_LIBRARIES.find((item) => item.id === guideId);
    return entry ? browsableLibrary(entry, e.doc) : e.doc.libraries?.[guideId];
  }, [guideId, tab, e.doc.libraries]);
  function openGuide(id: string) {
    setNotice(undefined);
    returnGuideFocusId.current = id;
    setGuideId(id);
  }
  const [notice, setNotice] = useState<Notice>();
  const counts = useMemo(() => allLibraryInstanceCounts(e.doc), [e.doc]);
  const selectTab = (next: Tab) => {
    returnGuideFocusId.current = "";
    setGuideId("");
    setTab(next);
    setNotice(undefined);
  };
  function toggle(entry: BuiltinLibraryEntry, enabled: boolean) {
    try {
      const current = e.historyRef.current.present;
      const installed = current.libraries?.[entry.id];
      const count = countLibraryInstances(current, entry.id);
      if (enabled) {
        const complete = browsableLibrary(entry, current);
        if (complete !== installed)
          e.apply([
            {
              type: "putLibrary",
              library: installed
                ? complete
                : installLibrary(current, entry.library),
            },
          ]);
      }
      const hasAnnotations =
        Boolean(installed?.aiGuide) ||
        installed?.components.some(
          (c) => c.assetTier !== undefined || c.aiHints !== undefined,
        );
      if (!enabled && !count && installed && !hasAnnotations)
        e.apply([{ type: "removeLibrary", libraryId: entry.id }]);
      onEnabledChange(
        enabled
          ? [...enabledIds, entry.id]
          : enabledIds.filter((id) => id !== entry.id),
      );
      setNotice(
        !enabled && count
          ? { message: `画布仍有 ${count} 个实例，已隐藏浏览并保留实例定义` }
          : !enabled && hasAnnotations
            ? { message: "已保留你编辑的 AI 说明书与标注，重新启用后自动恢复" }
            : undefined,
      );
    } catch (err) {
      setNotice({ error: true, message: errorText(err) });
    }
  }
  async function saveGuide(guide: LibraryAiGuide) {
    const current = e.historyRef.current.present;
    const entry =
      tab === "builtin" &&
      BUILTIN_LIBRARIES.find((item) => item.id === guideId);
    const lib = entry
      ? browsableLibrary(entry, current)
      : current.libraries?.[guideId];
    if (!lib || current.id !== e.doc.id)
      throw Error("组件库已移除或文件已切换");
    const aiGuide = { ...lib.aiGuide, ...guide };
    e.apply([{ type: "putLibrary", library: { ...lib, aiGuide } }]);
    if (entry && !current.libraries?.[lib.id] && !enabledIds.includes(lib.id))
      onEnabledChange([...enabledIds, lib.id]);
    const res = await updateWorkspaceLibraryAiGuide(
      lib.id,
      lib.revision,
      aiGuide,
    );
    return guideSaveNotice(lib.name, res, e.error);
  }
  return createPortal(
    <div
      className="modal-backdrop library-manager-backdrop"
      onMouseDown={(ev) => {
        if (ev.target === ev.currentTarget) close();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="组件库管理"
        tabIndex={-1}
        ref={modal}
        className="library-manager"
      >
        <div className="manager-heading">
          <Library size={17} />
          <h2>组件库管理</h2>
          <button
            type="button"
            className="icon-btn icon-btn-sm"
            aria-label="关闭组件库管理"
            data-tip="关闭组件库管理"
            data-tip-kbd="Esc"
            data-tip-side="bottom"
            onClick={close}
          >
            <X size={15} />
          </button>
        </div>
        <div role="tablist" aria-label="组件库来源" className="manager-tabs">
          {tabNames.map(([id, label], i) => (
            <button
              key={id}
              role="tab"
              id={"library-tab-" + id}
              aria-controls="library-manager-content"
              aria-selected={tab === id}
              tabIndex={tab === id ? 0 : -1}
              onKeyDown={(ev) => {
                const target =
                  ev.key === "ArrowRight"
                    ? (i + 1) % 3
                    : ev.key === "ArrowLeft"
                      ? (i + 2) % 3
                      : ev.key === "Home"
                        ? 0
                        : ev.key === "End"
                          ? 2
                          : -1;
                if (target < 0) return;
                ev.preventDefault();
                selectTab(tabNames[target][0]);
                ev.currentTarget.parentElement
                  ?.querySelectorAll<HTMLButtonElement>("button")
                  [target].focus();
              }}
              onClick={() => selectTab(id)}
            >
              {label}
            </button>
          ))}
        </div>
        {notice && (
          <div
            className="manager-notice"
            role={notice.error ? "alert" : "status"}
          >
            {notice.message}
          </div>
        )}
        <div
          className="manager-body"
          role="tabpanel"
          id="library-manager-content"
          aria-labelledby={"library-tab-" + tab}
          key={tab}
        >
          {guideLibrary && (
            <LibraryPlaybookEditor
              key={guideLibrary.id}
              library={guideLibrary}
              back={() => setGuideId("")}
              editorError={e.error}
              save={saveGuide}
            />
          )}
          {!guideLibrary && tab === "builtin" && (
            <>
              <p className="manager-intro">
                已启用{" "}
                <strong>
                  {enabledIds.length} / {BUILTIN_LIBRARIES.length}
                </strong>{" "}
                套官方设计体系 · 全部 100% 离线可编辑，启用后自动同步画布与 AI
                助手
              </p>
              <div className="kit-grid">
                {BUILTIN_LIBRARIES.map((entry) => {
                  const active = enabledIds.includes(entry.id),
                    used = counts[entry.id] ?? 0;
                  const components = entry.library.components;
                  return (
                    <section
                      className="kit-card"
                      key={entry.id}
                      data-library-id={entry.id}
                    >
                      <div className="kit-heading">
                        <div>
                          <span className="platform-pill">
                            {entry.platformLabel}
                          </span>
                          <h3>{entry.name}</h3>
                        </div>
                        <label className="lib-switch">
                          <input
                            type="checkbox"
                            role="switch"
                            aria-label={`启用 ${entry.name}`}
                            checked={active}
                            onChange={(ev) => toggle(entry, ev.target.checked)}
                          />
                          <span aria-hidden="true" />
                        </label>
                      </div>
                      <div className="kit-swatches">
                        {entry.swatches.map((color, i) => (
                          <i key={i} style={{ background: color }} />
                        ))}
                      </div>
                      <div className="kit-preview">
                        {components.slice(0, 2).map((c) => (
                          <AssetPreview
                            key={c.id}
                            compact
                            variant={c.variants[0]}
                            images={entry.library.images}
                            designSystem={entry.library.designSystem}
                          />
                        ))}
                      </div>
                      <div className="kit-metrics">
                        <span>
                          {components.length} 组件 ·{" "}
                          {components.reduce(
                            (n, c) => n + c.variants.length,
                            0,
                          )}{" "}
                          变体 · {entry.templates.length} 页面模板
                        </span>
                        <small className="kit-status" data-active={active}>
                          {used
                            ? `画布已用 ${used} 实例`
                            : active
                              ? "已启用 · AI 可用"
                              : "未启用"}
                        </small>
                      </div>
                      <p>{entry.summary}</p>
                      <div className="manager-actions kit-actions">
                        <button onClick={() => props.onFoundations(entry.id)}>
                          查看规范
                        </button>
                        <PlaybookButton
                          id={entry.id}
                          name={
                            e.doc.libraries?.[entry.id]?.name ??
                            entry.library.name
                          }
                          open={() => openGuide(entry.id)}
                        />
                        <button
                          onClick={() =>
                            downloadLibrary(browsableLibrary(entry, e.doc))
                          }
                        >
                          导出 JSON
                        </button>
                      </div>
                    </section>
                  );
                })}
              </div>
            </>
          )}
          {!guideLibrary && tab === "custom" && (
            <CustomLibraries
              {...props}
              counts={counts}
              notify={setNotice}
              openGuide={openGuide}
            />
          )}
          {!guideLibrary && tab === "subscriptions" && (
            <OnlineLibraries
              editor={e}
              onReviewLibrary={props.onReviewLibrary}
              onImportLibrary={props.onImportLibrary}
              onSubscriptionsChange={props.onSubscriptionsChange}
            />
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

function PlaybookButton({
  id,
  name,
  open,
}: {
  id: string;
  name: string;
  open: () => void;
}) {
  return (
    <button
      type="button"
      data-guide-trigger={id}
      aria-label={`AI 说明书 · ${name}`}
      data-tip="查看与编辑 AI 说明书"
      data-tip-side="top"
      onClick={open}
    >
      AI 说明书
    </button>
  );
}

function LibraryPlaybookEditor({
  library,
  back,
  editorError,
  save,
}: {
  library: ComponentLibrary;
  back: () => void;
  editorError: string;
  save: (guide: LibraryAiGuide) => Promise<Notice>;
}) {
  const { manifest, aiGuide } = useMemo(
    () =>
      library.aiGuide?.playbookMarkdown !== undefined
        ? { manifest: buildLibraryManifest(library), aiGuide: library.aiGuide }
        : generateLibraryPlaybook(library),
    [library],
  );
  const [draft, setDraft] = useState(aiGuide);
  const [notice, setNotice] = useState<Notice>();
  const [saving, setSaving] = useState(false);
  const { page, block, component } = manifest.tierCounts;
  return (
    <div className="library-playbook">
      <div className="library-playbook-title">
        <button
          type="button"
          className="icon-btn icon-btn-sm"
          aria-label="返回组件库列表"
          data-tip="返回组件库列表"
          data-tip-side="bottom"
          onClick={back}
          autoFocus
        >
          <ArrowLeft size={14} />
        </button>
        <h3>{library.name} · AI 说明书</h3>
      </div>
      <div className="library-playbook-toolbar">
        <span className="library-playbook-counts">
          Page {page} · Block {block} · Component {component} · 异常态{" "}
          {manifest.exceptionComponents.length}
        </span>
        <div className="manager-actions">
          <button
            type="button"
            disabled={saving}
            onClick={() => {
              const next = generateLibraryPlaybook(library, {
                ...library.aiGuide,
                playbookMarkdown: draft.playbookMarkdown,
              });
              setDraft({ ...library.aiGuide, ...next.aiGuide });
              setNotice({ message: "已刷新资产清单" });
            }}
          >
            增量刷新
          </button>
          <button
            type="button"
            className="primary"
            aria-disabled={saving}
            onClick={async () => {
              if (saving) return;
              setSaving(true);
              try {
                setNotice(await save(draft));
              } catch (err) {
                setNotice({ error: true, message: errorText(err) });
              } finally {
                setSaving(false);
              }
            }}
          >
            保存说明书
          </button>
        </div>
      </div>
      <textarea
        aria-label="组件库 AI 说明书 Markdown"
        maxLength={64000}
        spellCheck={false}
        readOnly={saving}
        value={draft.playbookMarkdown ?? ""}
        onChange={(ev) => {
          setDraft({ ...draft, playbookMarkdown: ev.target.value });
          setNotice(undefined);
        }}
      />
      {editorError && !notice?.message.includes(editorError) && (
        <small className="library-guide-error" role="alert">
          {editorError}
        </small>
      )}
      {notice && (
        <small
          className={notice.error ? "library-guide-error" : undefined}
          role={notice.error ? "alert" : "status"}
        >
          {notice.message}
        </small>
      )}
    </div>
  );
}

type ExtractionResult =
  | { stage: string }
  | { error: string }
  | {
      library: ComponentLibrary;
      format: "Figma" | "Sketch";
      componentCount: number;
      variantCount: number;
      issueCount: number;
    };

const sourceLabels = {
  json: "JSON",
  figma: "Figma",
  sketch: "Sketch",
  packaged: "打包",
} as const;
function CustomLibraries({
  editor: e,
  counts,
  enabledIds,
  onEnabledChange,
  onImportLibrary,
  openGuide,
  notify,
}: ManagerProps & {
  counts: Record<string, number>;
  openGuide: (id: string) => void;
  notify: (notice: Notice | undefined) => void;
}) {
  const [records, setRecords] = useState<WorkspaceLibraryRecord[]>([]);
  const [stage, setStage] = useState("");
  const [packageName, setPackageName] = useState(
    e.doc.name.slice(0, 196) + " 组件库",
  );
  const [includeImported, setIncludeImported] = useState(false);
  const [publishing, setPublishing] = useState("");
  const json = useRef<HTMLInputElement>(null),
    design = useRef<HTMLInputElement>(null);
  const worker = useRef<Worker | null>(null);
  const life = useRef(new AbortController());
  const refreshVersion = useRef(0);
  async function refresh() {
    const version = ++refreshVersion.current;
    const next = await listWorkspaceLibraries();
    if (!life.current.signal.aborted && refreshVersion.current === version)
      setRecords(next);
  }
  useEffect(() => {
    life.current = new AbortController();
    void refresh();
    return () => {
      life.current.abort();
      worker.current?.terminate();
      worker.current = null;
    };
  }, []);
  async function run(action: () => Promise<void>) {
    notify(undefined);
    try {
      await action();
    } catch (err) {
      if (!life.current.signal.aborted)
        notify({ error: true, message: errorText(err) });
    }
  }
  function cancelExtraction() {
    worker.current?.terminate();
    worker.current = null;
    setStage("");
  }
  async function importJson(file: File) {
    const parsed = await readLibraryFile(file);
    if (life.current.signal.aborted) return;
    onImportLibrary(parsed);
    await saveWorkspaceLibrary(parsed, "json");
    await refresh();
    if (!life.current.signal.aborted)
      notify({
        message: `已导入并保存「${parsed.name}」 · ${parsed.components.length} 组件`,
      });
  }
  function extract(file: File) {
    cancelExtraction();
    const job = new Worker(
      new URL(
        "../infrastructure/design-import/library-extract-worker.ts",
        import.meta.url,
      ),
      { type: "module" },
    );
    worker.current = job;
    setStage("正在读取 " + file.name);
    job.onmessage = ({ data }: MessageEvent<ExtractionResult>) => {
      if (worker.current !== job) return;
      if ("stage" in data) {
        setStage(data.stage);
        return;
      }
      if ("error" in data) {
        cancelExtraction();
        notify({ message: data.error, error: true });
        return;
      }
      job.terminate();
      setStage("正在载入字体与组件");
      void run(async () => {
        try {
          await loadFonts(data.library.fonts);
          if (worker.current !== job || life.current.signal.aborted) return;
          worker.current = null;
          setStage("");
          onImportLibrary(data.library);
          await saveWorkspaceLibrary(
            data.library,
            data.format === "Figma" ? "figma" : "sketch",
          );
          await refresh();
          if (!life.current.signal.aborted)
            notify({
              message: `已提取并保存「${data.library.name}」 · ${data.componentCount} 组件 · ${data.variantCount} 变体${data.issueCount ? " · " + data.issueCount + " 条导入提示" : ""}`,
            });
        } finally {
          if (worker.current === job) cancelExtraction();
        }
      });
    };
    job.onerror = (event) => {
      if (worker.current === job) {
        cancelExtraction();
        notify({ error: true, message: event.message || "原稿读取失败" });
      }
    };
    job.postMessage(file);
  }
  function remove(lib: ComponentLibrary) {
    const users = countLibraryInstances(e.historyRef.current.present, lib.id);
    if (users) {
      notify({ error: true, message: `画布仍有 ${users} 个实例正在使用此库` });
      return;
    }
    e.attempt(() => {
      e.apply([{ type: "removeLibrary", libraryId: lib.id }]);
      if (BUILTIN_LIBRARY_IDS.has(lib.id))
        onEnabledChange(enabledIds.filter((id) => id !== lib.id));
      notify({ message: "已移除「" + lib.name + "」" });
    });
  }
  const installed = Object.values(e.doc.libraries ?? {});
  return (
    <>
      <div className="library-quick-grid">
        <div className="library-quick-card">
          <FileInput size={17} />
          <h3>导入 JSON 组件库</h3>
          <p>安装到当前文件，并保存至工作区。</p>
          <button
            aria-label="从 JSON 导入组件库"
            onClick={() => json.current?.click()}
          >
            选择 JSON
          </button>
          <input
            ref={json}
            type="file"
            hidden
            accept=".json"
            onChange={(ev) => {
              const file = ev.target.files?.[0];
              ev.target.value = "";
              if (file) void run(() => importJson(file));
            }}
          />
        </div>
        <div className="library-quick-card">
          <Layers size={17} />
          <h3>从原稿提取组件库</h3>
          <p>从 .fig 或 .sketch 原稿提取组件与变体。</p>
          {stage ? (
            <>
              <small role="status">{stage}</small>
              <button onClick={cancelExtraction}>取消提取</button>
            </>
          ) : (
            <button
              aria-label="从 Figma 或 Sketch 提取组件库"
              onClick={() => design.current?.click()}
            >
              选择原稿
            </button>
          )}
          <input
            ref={design}
            type="file"
            hidden
            accept=".fig,.sketch"
            onChange={(ev) => {
              const file = ev.target.files?.[0];
              ev.target.value = "";
              if (file) void run(async () => extract(file));
            }}
          />
        </div>
        <div className="library-quick-card">
          <Archive size={17} />
          <h3>打包当前文档主组件</h3>
          <input
            aria-label="打包组件库名称"
            value={packageName}
            maxLength={200}
            onChange={(ev) => setPackageName(ev.target.value)}
          />
          <label>
            <input
              type="checkbox"
              checked={includeImported}
              onChange={(ev) => setIncludeImported(ev.target.checked)}
            />
            包含已导入库组件
          </label>
          <button
            disabled={!packageName.trim()}
            onClick={() =>
              void run(async () => {
                const lib = packageDocumentAsLibrary(
                  e.historyRef.current.present,
                  {
                    name: packageName.trim(),
                    includeImportedLibraries: includeImported,
                  },
                );
                await saveWorkspaceLibrary(lib, "packaged");
                await refresh();
                if (!life.current.signal.aborted)
                  notify({
                    message: `已打包「${lib.name}」 · ${lib.components.length} 组件，可从工作区导出 JSON`,
                  });
              })
            }
          >
            打包并保存
          </button>
        </div>
      </div>
      <section className="manager-section">
        <h3>
          当前文档已安装组件库 <small>{installed.length}</small>
        </h3>
        {!installed.length && <p>当前文件尚未安装组件库。</p>}
        {installed.map((lib) => {
          const builtin = BUILTIN_LIBRARY_IDS.has(lib.id),
            local = lib.components.some(
              (c) => c.master?.documentId === e.doc.id,
            ),
            used = counts[lib.id] ?? 0;
          return (
            <div key={lib.id} className="library-record">
              <div className="library-record-line">
                <div>
                  <strong>{lib.name}</strong>{" "}
                  <span className="platform-pill">
                    {builtin ? "官方内置" : local ? "本地主组件" : "外部导入"}
                  </span>
                  <small>
                    r{lib.revision} · {lib.components.length} 组件 · 画布已用{" "}
                    {used} 实例
                  </small>
                </div>
                <div className="manager-actions">
                  <PlaybookButton
                    id={lib.id}
                    name={lib.name}
                    open={() => openGuide(lib.id)}
                  />
                  <button onClick={() => downloadLibrary(lib)}>导出</button>
                  {!builtin && (
                    <button
                      onClick={() =>
                        void run(async () => {
                          await saveWorkspaceLibrary(
                            lib,
                            records.find((r) => r.id === lib.id)?.sourceKind ??
                              (local ? "packaged" : "json"),
                          );
                          await refresh();
                          if (!life.current.signal.aborted)
                            notify({
                              message: "已保存「" + lib.name + "」至工作区",
                            });
                        })
                      }
                    >
                      存至工作区
                    </button>
                  )}
                  {local && (
                    <button
                      aria-expanded={publishing === lib.id}
                      onClick={() =>
                        setPublishing(publishing === lib.id ? "" : lib.id)
                      }
                    >
                      发布
                    </button>
                  )}
                  <button
                    aria-label={`移除组件库 ${lib.name}`}
                    data-tip={
                      used
                        ? `画布仍有 ${used} 个实例正在使用此库`
                        : "移除组件库"
                    }
                    onClick={() => remove(lib)}
                  >
                    移除
                  </button>
                </div>
              </div>
              {publishing === lib.id && <ExpandedPublisher library={lib} />}
            </div>
          );
        })}
      </section>
      <section className="manager-section">
        <div className="manager-section-heading">
          <h3>
            工作区已保存组件库（跨文件复用） <small>{records.length}</small>
          </h3>
          <button
            className="icon-btn icon-btn-sm"
            aria-label="刷新工作区组件库"
            data-tip="刷新工作区组件库"
            data-tip-side="left"
            onClick={() => void refresh()}
          >
            <RefreshCw size={13} />
          </button>
        </div>
        {!records.length && (
          <p>从文件导入或打包主组件后，可在这里跨文件复用。</p>
        )}
        {records.map((r) => (
          <div className="library-record library-record-line" key={r.id}>
            <div>
              <strong>{r.name}</strong>{" "}
              <span className="platform-pill">
                {sourceLabels[r.sourceKind]}
              </span>
              <small>
                {r.componentCount} 组件 · {r.variantCount} 变体
              </small>
            </div>
            <div className="manager-actions">
              <button
                onClick={() =>
                  void run(async () => {
                    await loadFonts(r.library.fonts);
                    if (!life.current.signal.aborted) {
                      onImportLibrary(r.library);
                      notify({ message: "已启用「" + r.name + "」" });
                    }
                  })
                }
              >
                启用到当前文件
              </button>
              <button onClick={() => downloadLibrary(r.library)}>
                导出 JSON
              </button>
              <button
                onClick={() =>
                  void run(async () => {
                    await deleteWorkspaceLibrary(r.id);
                    await refresh();
                    if (!life.current.signal.aborted)
                      notify({ message: "已从工作区删除「" + r.name + "」" });
                  })
                }
              >
                删除
              </button>
            </div>
          </div>
        ))}
      </section>
    </>
  );
}

function ExpandedPublisher({ library }: { library: ComponentLibrary }) {
  const container = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const details = container.current?.querySelector("details");
    if (details) details.open = true;
  }, []);
  return (
    <div ref={container}>
      <PublishLibrary library={library} />
    </div>
  );
}

function OnlineLibraries({
  editor: e,
  onReviewLibrary,
  onImportLibrary,
  onSubscriptionsChange,
}: Pick<
  ManagerProps,
  "editor" | "onReviewLibrary" | "onImportLibrary" | "onSubscriptionsChange"
>) {
  const docId = e.doc.id;
  const [links, setLinks] = useState(() => subscriptions(docId));
  const [address, setAddress] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [results, setResults] = useState<
    Record<string, { library?: ComponentLibrary; message?: string }>
  >({});
  const life = useRef(new AbortController());
  async function check(link: Subscription, signal: AbortSignal) {
    setResults((old) => ({ ...old, [link.id]: { message: "检查中…" } }));
    try {
      const library = await fetchLibrary(link.url, signal);
      if (library.id !== link.id) throw Error("此地址已改为另一组件库");
      if (!signal.aborted)
        setResults((old) => ({ ...old, [link.id]: { library } }));
    } catch (err) {
      if (!signal.aborted)
        setResults((old) => ({
          ...old,
          [link.id]: { message: "检查失败 · " + errorText(err) },
        }));
    }
  }
  useEffect(() => {
    const controller = new AbortController();
    life.current = controller;
    for (const link of subscriptions(docId))
      void check(link, controller.signal);
    return () => controller.abort();
  }, [docId]);
  async function subscribe() {
    const signal = life.current.signal;
    setBusy(true);
    setError("");
    try {
      const url = new URL(address.trim()).href;
      const library = await fetchLibrary(url, signal);
      await loadFonts(library.fonts);
      if (signal.aborted || e.historyRef.current.present.id !== docId) return;
      if (!e.historyRef.current.present.libraries?.[library.id])
        onImportLibrary(library);
      setLinks(
        saveSubscription(docId, library.id, {
          id: library.id,
          name: library.name,
          url,
        }),
      );
      setResults((old) => ({ ...old, [library.id]: { library } }));
      setAddress("");
      onSubscriptionsChange();
    } catch (err) {
      if (!signal.aborted) setError(errorText(err));
    } finally {
      if (!signal.aborted) setBusy(false);
    }
  }
  return (
    <section className="manager-section online-libraries">
      <form
        onSubmit={(ev) => {
          ev.preventDefault();
          void subscribe();
        }}
      >
        <label>
          团队组件库地址
          <input
            type="url"
            required
            aria-label="组件库地址"
            placeholder="https://…/library.forma-library.json"
            value={address}
            onChange={(ev) => setAddress(ev.target.value)}
          />
        </label>
        <button className="primary" disabled={busy || !address.trim()}>
          {busy ? "正在连接…" : "订阅"}
        </button>
      </form>
      {error && <p role="alert">{error}</p>}
      {!links.length && <p>尚未订阅在线组件库。</p>}
      {links.map((link) => {
        const result = results[link.id],
          lib = result?.library,
          installed = e.doc.libraries?.[link.id];
        const available =
          lib && (!installed || lib.revision > installed.revision);
        const status =
          result?.message ||
          (available
            ? "可用版本 r" + lib.revision
            : !lib
              ? "等待检查"
              : installed && installed.revision > lib.revision
                ? "远端版本较早"
                : JSON.stringify(installed) !== JSON.stringify(lib)
                  ? "修订号相同，快照内容不同"
                  : "已是最新版本");
        return (
          <div key={link.id} className="library-record library-record-line">
            <div>
              <strong>{link.name}</strong>
              <small>{link.url}</small>
              <small>
                {status}
                {installed && " · 本地 r" + installed.revision}
              </small>
            </div>
            <div className="manager-actions">
              <button
                disabled={result?.message === "检查中…"}
                onClick={() => void check(link, life.current.signal)}
              >
                检查更新
              </button>
              {available && (
                <button
                  onClick={async () => {
                    try {
                      await loadFonts(lib.fonts);
                      if (!life.current.signal.aborted) onReviewLibrary(lib);
                    } catch (err) {
                      if (!life.current.signal.aborted)
                        setError(errorText(err));
                    }
                  }}
                >
                  {installed ? "查看更新" : "重新安装"}
                </button>
              )}
              <button
                onClick={() => {
                  try {
                    setLinks(saveSubscription(docId, link.id));
                    onSubscriptionsChange();
                  } catch (err) {
                    setError(errorText(err));
                  }
                }}
              >
                取消订阅
              </button>
            </div>
          </div>
        );
      })}
    </section>
  );
}
