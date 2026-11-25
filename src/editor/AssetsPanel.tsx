import { extractComponentManifest } from "../agent/library-intelligence";
import { displayColor } from "../domain/color-profile";
import { PublishLibrary } from "./PublishLibrary";
import { LibraryReview } from "./LibraryReview";
import { LibrarySubscriptions } from "./LibrarySubscriptions";
import { createStarter } from "../domain/seed";
import { transact } from "../domain/commands";
import { useModalDialog } from "./useModalDialog";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import {
  RefreshCw,
  Plus,
  Search,
  Upload,
  X,
  Download,
  Component,
  Bot,
  LayoutGrid,
  List,
  Frame,
  Square,
  Circle,
  Type,
  MousePointerClick,
  ChevronRight,
  Library,
} from "lucide-react";
import {
  BUILTIN_LIBRARIES,
  BUILTIN_LIBRARY_IDS,
  BUILTIN_TEMPLATES,
  DEFAULT_ENABLED_BUILTIN_IDS,
  findBuiltinEntry,
  createBuiltinTemplate,
  type Appearance,
  type BuiltinLibraryEntry,
} from "../design-system/catalog";
import {
  getEnabledBuiltinLibraries,
  setEnabledBuiltinLibraries,
} from "../infrastructure/library-catalog-store";
import { createNode, type DesignDocument } from "../domain/document";
import { fillUsesTextColor } from "../domain/node";
import {
  LibraryManagerModal,
  browsableLibrary,
  downloadLibrary,
  readLibraryFile,
} from "./LibraryManagerModal";
import "./assets-panel.css";
import { instantiateComponent, installLibrary } from "../domain/library";
import type {
  AssetTier,
  ComponentLibrary,
  ComponentVariant,
  LibraryComponent,
} from "../domain/library-schema";
import { insertionParent, isLocked } from "../domain/tree";
import { layoutBounds } from "../domain/geometry";
import { AssetPreview } from "./AssetPreview";
import type { EditorController } from "./useEditor";

const builtinTokenIds = new Set(
  BUILTIN_LIBRARIES.flatMap((entry) => Object.keys(entry.tokens)),
);
const basicElements = [
  ["frame", "画板", Frame],
  ["rectangle", "矩形", Square],
  ["ellipse", "椭圆", Circle],
  ["text", "文本", Type],
  ["button", "按钮", MousePointerClick],
] as const;
const templatePlatforms = {
  ios: "iOS",
  android: "Android",
  "web-enterprise": "Web 中后台",
  "web-modern": "现代 Web",
};

const TemplatePreview = memo(function TemplatePreview({
  id,
  appearance,
}: {
  id: string;
  appearance: Appearance;
}) {
  const stage = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { root: el.closest(".assets-list"), rootMargin: "120px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const preview = useMemo(() => {
    if (!visible) return;
    try {
      const empty = { ...createStarter(), nodes: [] };
      const { operations } = createBuiltinTemplate(empty, id, appearance, {
        x: 0,
        y: 0,
      });
      const doc = transact(empty, { baseRevision: empty.revision, operations });
      return {
        variant: { id, name: id, properties: {}, nodes: doc.nodes },
        doc,
      };
    } catch {
      return null;
    }
  }, [id, appearance, visible]);
  return (
    <div ref={stage} className="template-stage">
      {preview ? (
        <AssetPreview
          variant={preview.variant}
          designSystem={preview.doc.designSystem}
          images={preview.doc.images}
        />
      ) : preview === null ? (
        "预览不可用"
      ) : null}
    </div>
  );
});

function preferredIds(doc: DesignDocument) {
  const installedBuiltinIds = Object.keys(doc.libraries ?? {}).filter((id) =>
    BUILTIN_LIBRARY_IDS.has(id),
  );
  return getEnabledBuiltinLibraries(
    doc.id,
    installedBuiltinIds,
    DEFAULT_ENABLED_BUILTIN_IDS,
  ).filter((id) => BUILTIN_LIBRARY_IDS.has(id));
}

// A preference changed alongside a library transaction follows that definition
// through undo/redo. Hiding a library with live instances stays independent.
const installationPreferences = new WeakMap<
  EditorController["historyRef"],
  Map<string, Set<string>>
>();

export function AssetsPanel({
  editor: e,
  managerOpen,
  setManagerOpen,
}: {
  editor: EditorController;
  managerOpen: boolean;
  setManagerOpen: (open: boolean) => void;
}) {
  const [preferred, setPreferred] = useState(() => preferredIds(e.doc));
  const [coupled] = useState(() => {
    const files =
      installationPreferences.get(e.historyRef) ??
      new Map<string, Set<string>>();
    installationPreferences.set(e.historyRef, files);
    const ids = files.get(e.doc.id) ?? new Set<string>();
    files.set(e.doc.id, ids);
    return ids;
  });
  const enabledIds = useMemo(() => {
    const ids = new Set(preferred);
    for (const id of coupled) {
      if (e.committed.libraries?.[id]) ids.add(id);
      else ids.delete(id);
    }
    return [...ids];
  }, [preferred, coupled, e.committed.libraries]);
  const latestEnabled = useRef(enabledIds);
  latestEnabled.current = enabledIds;
  useEffect(() => {
    if (
      enabledIds.length !== preferred.length ||
      enabledIds.some((id) => !preferred.includes(id))
    )
      setPreferred(setEnabledBuiltinLibraries(e.doc.id, enabledIds));
  }, [enabledIds, preferred, e.doc.id]);
  const [subscriptionVersion, setSubscriptionVersion] = useState(0);
  const [foundationId, setFoundationId] = useState("");
  const [templateLibFilter, setTemplateLibFilter] = useState("all");
  const foundation =
    findBuiltinEntry(foundationId || enabledIds[0]) ?? BUILTIN_LIBRARIES[0];
  function changeEnabled(next: string[], before = e.committed) {
    for (const entry of BUILTIN_LIBRARIES) {
      if (latestEnabled.current.includes(entry.id) === next.includes(entry.id))
        continue;
      if (
        !!before.libraries?.[entry.id] !==
        !!e.historyRef.current.present.libraries?.[entry.id]
      )
        coupled.add(entry.id);
      else coupled.delete(entry.id);
    }
    latestEnabled.current = next;
    setPreferred(setEnabledBuiltinLibraries(e.doc.id, next));
  }
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("全部");
  const [appearance, setAppearance] = useState<Appearance>("Light");
  const [layoutMode, setLayoutMode] = useState<"grid" | "list">("grid");
  const [view, setView] = useState<"components" | "templates" | "foundations">(
    "components",
  );
  const [detailIds, setDetail] = useState<{
    libraryId: string;
    componentId: string;
    variantId: string;
  } | null>(null);
  const [upgrade, setUpgrade] = useState<{
    lib: ComponentLibrary;
    base: typeof e.committed;
  } | null>(null);
  const file = useRef<HTMLInputElement>(null);
  function importLibrary(parsed: ComponentLibrary) {
    const current = e.historyRef.current.present;
    if (current.id !== e.doc.id) throw Error("文件已切换，请重新导入");
    const old = current.libraries?.[parsed.id];
    if (old && parsed.revision > old.revision) {
      setManagerOpen(false);
      setUpgrade({ lib: parsed, base: current });
      return;
    }
    const library = installLibrary(current, parsed);
    e.apply([{ type: "putLibrary", library }]);
    if (
      BUILTIN_LIBRARY_IDS.has(library.id) &&
      !latestEnabled.current.includes(library.id)
    )
      changeEnabled([...latestEnabled.current, library.id], current);
  }
  const libraries = useMemo(
    () => [
      ...BUILTIN_LIBRARIES.filter((entry) => enabledIds.includes(entry.id)).map(
        (entry) => browsableLibrary(entry, e.doc),
      ),
      ...Object.values(e.doc.libraries ?? {}).filter(
        (lib) => !BUILTIN_LIBRARY_IDS.has(lib.id),
      ),
    ],
    [enabledIds, e.doc.libraries],
  );
  const detailLibrary = detailIds
    ? libraries.find((lib) => lib.id === detailIds.libraryId)
    : undefined;
  const detailComponent = detailLibrary?.components.find(
    (c) => c.id === detailIds?.componentId,
  );
  const detail =
    detailLibrary && detailComponent
      ? {
          library: detailLibrary,
          component: detailComponent,
          variant:
            detailComponent.variants.find(
              (v) => v.id === detailIds?.variantId,
            ) ?? detailComponent.variants[0],
        }
      : null;
  const modal = useModalDialog(!!detail, () => setDetail(null));
  const upgradeAvailable = BUILTIN_LIBRARIES.find(
    (entry) =>
      enabledIds.includes(entry.id) &&
      (e.doc.libraries?.[entry.id]?.revision ?? Infinity) <
        entry.library.revision,
  );
  const categories = [
    "全部",
    ...new Set(
      libraries.flatMap((lib) => lib.components.map((c) => c.category)),
    ),
  ];
  const activeCategory = categories.includes(category) ? category : "全部";
  const groupedVisible = libraries
    .map((library) => ({
      library,
      components: library.components.filter(
        (c) =>
          (activeCategory === "全部" || c.category === activeCategory) &&
          `${c.name} ${c.category} ${c.description}`
            .toLowerCase()
            .includes(query.trim().toLowerCase()),
      ),
    }))
    .filter((group) => group.components.length);
  const insert = (
    library: ComponentLibrary,
    component: LibraryComponent,
    variant: ComponentVariant,
  ) =>
    e.attempt(() => {
      const current = e.historyRef.current.present,
        selected = current.nodes.find((n) => n.id === e.selection[0]);
      const parent = insertionParent(current, selected);
      if (parent && isLocked(current, parent))
        throw new Error("目标容器已锁定");
      const box = parent ? layoutBounds(current).get(parent) : null;
      const position = box
        ? { x: box.x + 24, y: box.y + 24 }
        : (e.api.current?.center() ?? { x: 80, y: 80 });
      const scoped = { ...library, components: [component] };
      const result = instantiateComponent(
        current,
        scoped,
        component.id,
        variant.id,
        parent,
        position,
      );
      e.apply(result.operations);
      e.setSelection([result.id]);
      setDetail(null);
      requestAnimationFrame(() => e.api.current?.fit([result.id]));
    });
  return (
    <div className="assets-panel">
      <div className="assets-sticky-top">
        <div className="assets-top-row">
          <div className="asset-tabs">
            {(
              [
                ["components", "组件"],
                ["templates", "页面"],
                ["foundations", "规范"],
              ] as const
            ).map(([key, label]) => (
              <button
                className={view === key ? "active" : ""}
                key={key}
                aria-pressed={view === key}
                onClick={() => setView(key)}
              >
                {label}
              </button>
            ))}
          </div>
          <button
            type="button"
            className="icon-btn icon-btn-sm assets-manage-btn"
            aria-label="组件库管理"
            data-tip="组件库管理"
            data-tip-kbd="⌥3"
            data-tip-desc="按文件启用 iOS / Material 3 / AntD 5 / shadcn 或管理自定义与导入组件库"
            data-tip-side="bottom"
            onClick={() => setManagerOpen(true)}
          >
            <Library size={14} />
            <small>{libraries.length}</small>
          </button>
        </div>
        <div className="assets-controls">
          {view === "components" && (
            <label className="asset-search">
              <Search size={13} />
              <input
                aria-label="搜索组件"
                placeholder="搜索组件、用途…"
                value={query}
                onChange={(ev) => setQuery(ev.target.value)}
              />
              {query && (
                <button
                  type="button"
                  className="icon-btn icon-btn-sm"
                  style={{ width: 18, height: 18 }}
                  aria-label="清空组件搜索"
                  data-tip="清空组件搜索"
                  onClick={() => setQuery("")}
                >
                  <X size={11} />
                </button>
              )}
            </label>
          )}
          <div className="asset-filters">
            {view === "components" && (
              <select
                aria-label="组件分类"
                value={activeCategory}
                onChange={(ev) => setCategory(ev.target.value)}
              >
                {categories.map((c) => (
                  <option key={c}>{c}</option>
                ))}
              </select>
            )}
            {view !== "components" && (
              <select
                aria-label={view === "templates" ? "模板体系" : "规范体系"}
                value={view === "templates" ? templateLibFilter : foundation.id}
                onChange={(ev) =>
                  (view === "templates"
                    ? setTemplateLibFilter
                    : setFoundationId)(ev.target.value)
                }
              >
                {view === "templates" && <option value="all">全部体系</option>}
                {BUILTIN_LIBRARIES.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.shortName}
                  </option>
                ))}
              </select>
            )}
            <select
              aria-label="资源外观"
              value={appearance}
              onChange={(ev) => setAppearance(ev.target.value as Appearance)}
            >
              <option value="Light">浅色</option>
              <option value="Dark">深色</option>
            </select>
          </div>
        </div>
        {view === "components" && (
          <div className="library-actions">
            <LibrarySubscriptions
              key={subscriptionVersion}
              editor={e}
              review={(lib) => e.attempt(() => importLibrary(lib))}
            />
            {upgradeAvailable && (
              <button
                className="icon-btn icon-btn-sm"
                aria-label="更新内置组件库"
                data-tip="更新内置组件库"
                data-tip-desc="查看版本差异和关联实例"
                data-tip-side="bottom"
                onClick={() =>
                  e.attempt(() => importLibrary(upgradeAvailable.library))
                }
              >
                <RefreshCw size={15} />
              </button>
            )}
            <button
              className="icon-btn icon-btn-sm"
              title="允许 Agent 使用此库"
              aria-label="供 Agent 使用"
              data-tip="供 AI Agent 使用"
              data-tip-desc="将已启用的官方组件库注册到当前文件，供 AI 助手检索与插入"
              data-tip-side="bottom"
              onClick={() =>
                e.attempt(() => {
                  const current = e.historyRef.current.present;
                  e.apply(
                    BUILTIN_LIBRARIES.filter((entry) =>
                      enabledIds.includes(entry.id),
                    )
                      .map((entry) => browsableLibrary(entry, current))
                      .filter(
                        (library) =>
                          library !== current.libraries?.[library.id],
                      )
                      .map((library) => ({
                        type: "putLibrary",
                        library,
                      })),
                  );
                })
              }
            >
              <Bot size={15} />
            </button>
            <button
              className="icon-btn icon-btn-sm"
              title="导入组件库"
              aria-label="导入组件库"
              data-tip="导入外部组件库"
              data-tip-desc="从本地 .forma-library.json 文件导入共享组件与变量"
              data-tip-side="bottom"
              onClick={() => file.current?.click()}
            >
              <Upload size={14} />
            </button>
            <button
              className="icon-btn icon-btn-sm"
              title="将选区创建为主组件"
              aria-label="保存选区"
              data-tip="将选区创建为主组件"
              data-tip-kbd="⌥⌘K"
              data-tip-desc={
                e.componentUnavailable ||
                (e.selected[0]?.instance
                  ? "将当前实例保存为独立的可复用快照"
                  : "将选中的图层创建为可复用的主组件")
              }
              data-tip-side="bottom"
              disabled={!!e.componentUnavailable}
              onClick={() =>
                e.attempt(() => {
                  e.saveComponent();
                  setCategory("自定义");
                  setQuery("");
                  setView("components");
                })
              }
            >
              <Component size={15} />
            </button>
            <span style={{ flex: 1 }} />
            <button
              className={`icon-btn icon-btn-sm ${layoutMode === "grid" ? "active" : ""}`}
              aria-label={
                layoutMode === "grid" ? "切换为列表视图" : "切换为网格视图"
              }
              data-tip={
                layoutMode === "grid" ? "切换列表视图" : "切换 2 列网格视图"
              }
              data-tip-side="bottom"
              onClick={() =>
                setLayoutMode((m) => (m === "grid" ? "list" : "grid"))
              }
            >
              {layoutMode === "grid" ? (
                <LayoutGrid size={13} />
              ) : (
                <List size={13} />
              )}
            </button>
          </div>
        )}
      </div>
      <div className="assets-list" key={view}>
        {view === "components" &&
          groupedVisible.map(({ library, components }) => (
            <details className="assets-lib-group" key={library.id} open>
              <summary>
                <ChevronRight size={12} className="disclosure-chevron" />
                <span className="assets-lib-name">{library.name}</span>
                <span className="platform-pill">
                  {findBuiltinEntry(library.id)?.platform === "ios"
                    ? "iOS"
                    : (findBuiltinEntry(library.id)?.platformLabel ?? "自定义")}
                </span>
                <small
                  style={{ color: "var(--text-secondary)", fontWeight: 400 }}
                >
                  r{library.revision} · {components.length}
                </small>
              </summary>
              <div
                className={layoutMode === "grid" ? "assets-grid-2col" : ""}
                style={
                  layoutMode === "list"
                    ? { display: "flex", flexDirection: "column", gap: 6 }
                    : undefined
                }
              >
                {components.map((component) => {
                  const variant =
                    component.variants.find(
                      (v) => v.properties.Appearance === appearance,
                    ) ?? component.variants[0];
                  return (
                    <button
                      className="component-card"
                      key={`${library.id}/${component.id}`}
                      draggable
                      onDragStart={(ev) => {
                        ev.dataTransfer.setData(
                          "application/x-forma-asset",
                          JSON.stringify({
                            libraryId: library.id,
                            componentId: component.id,
                            variantId: variant.id,
                          }),
                        );
                        ev.dataTransfer.effectAllowed = "copy";
                      }}
                      onClick={() =>
                        setDetail({
                          libraryId: library.id,
                          componentId: component.id,
                          variantId: variant.id,
                        })
                      }
                      aria-label={`查看 ${component.name}`}
                      title={`点击查看变体，或直接拖到画布插入 ${component.name}`}
                    >
                      <div className="component-card-stage">
                        <AssetPreview
                          variant={variant}
                          images={library.images}
                          designSystem={library.designSystem}
                          compact={layoutMode === "grid"}
                        />
                      </div>
                      <div className="component-card-meta">
                        <strong>{component.name}</strong>
                        <span>
                          {component.variants.length} 变体 <Plus size={11} />
                        </span>
                      </div>
                    </button>
                  );
                })}
              </div>
            </details>
          ))}
        {view === "components" && !groupedVisible.length && (
          <p className="asset-empty">没有匹配的组件，试试其他关键词。</p>
        )}
        {view === "components" && (
          <button className="manage-more" onClick={() => setManagerOpen(true)}>
            管理更多组件库（Material 3 · AntD 5 · shadcn）
          </button>
        )}
        {view === "templates" &&
          BUILTIN_TEMPLATES.filter(
            (t) =>
              templateLibFilter === "all" || templateLibFilter === t.libraryId,
          ).map((t) => (
            <button
              type="button"
              className="template-card"
              key={t.id}
              title={t.description}
              onClick={() =>
                e.attempt(() => {
                  const result = createBuiltinTemplate(
                    e.historyRef.current.present,
                    t.id,
                    appearance,
                    e.api.current?.center() ?? { x: 0, y: 0 },
                  );
                  e.apply(result.operations);
                  e.setSelection([result.id]);
                  requestAnimationFrame(() => e.api.current?.fit([result.id]));
                })
              }
            >
              <TemplatePreview id={t.id} appearance={appearance} />
              <span className="template-meta">
                <strong>{t.name}</strong>
                <span className="platform-pill">
                  {templatePlatforms[t.platform]}
                </span>
              </span>
              <small>
                {t.width} × {t.height} · 插入页面
              </small>
            </button>
          ))}
        {view === "foundations" && (
          <Foundations editor={e} entry={foundation} appearance={appearance} />
        )}
        <details className="basic-assets">
          <summary>
            <ChevronRight className="disclosure-chevron" size={12} />
            基础元素
          </summary>
          <div className="basic-asset-grid">
            {basicElements.map(([type, label, Icon]) => (
              <button type="button" key={type} onClick={() => e.add(type)}>
                <Icon size={13} />
                {label}
              </button>
            ))}
          </div>
        </details>
      </div>
      <input
        type="file"
        accept=".json"
        hidden
        ref={file}
        onChange={async (ev) => {
          const input = ev.currentTarget,
            selected = input.files?.[0];
          if (!selected) return;
          try {
            const parsed = await readLibraryFile(selected);
            importLibrary(parsed);
            setCategory("全部");
            setQuery("");
            setView("components");
          } catch (error) {
            e.setError(`组件库导入失败：${String(error)}`);
          }
          input.value = "";
        }}
      />
      {managerOpen && (
        <LibraryManagerModal
          editor={e}
          enabledIds={enabledIds}
          onEnabledChange={changeEnabled}
          close={() => setManagerOpen(false)}
          onFoundations={(id) => {
            setFoundationId(id);
            setView("foundations");
            setManagerOpen(false);
          }}
          onImportLibrary={importLibrary}
          onReviewLibrary={(lib) => {
            setManagerOpen(false);
            importLibrary(lib);
          }}
          onSubscriptionsChange={() => setSubscriptionVersion((v) => v + 1)}
        />
      )}
      {upgrade && (
        <LibraryReview
          editor={e}
          base={upgrade.base}
          incoming={upgrade.lib}
          close={() => setUpgrade(null)}
        />
      )}
      {detail && (
        <div
          className="modal-backdrop"
          onMouseDown={(ev) => {
            if (ev.target === ev.currentTarget) setDetail(null);
          }}
        >
          <div
            className="library-dialog"
            ref={modal}
            aria-modal="true"
            tabIndex={-1}
            role="dialog"
            aria-label="组件详情"
          >
            <div className="panel-heading">
              <div>
                <strong>{detail.component.name}</strong>
                <small>
                  {detail.library.name} / {detail.component.category}
                </small>
              </div>
              <button
                className="icon-btn icon-btn-sm"
                aria-label="关闭组件详情"
                data-tip="关闭详情"
                data-tip-kbd="Esc"
                data-tip-side="bottom"
                onClick={() => setDetail(null)}
              >
                <X size={18} />
              </button>
            </div>
            <div className="library-dialog-body">
              <div
                className={`library-stage ${detail.variant.properties.Appearance === "Dark" ? "dark" : ""}`}
              >
                <AssetPreview
                  variant={detail.variant}
                  images={detail.library.images}
                  designSystem={detail.library.designSystem}
                  large
                />
              </div>
              <div className="library-options">
                <p>{detail.component.description}</p>
                {Object.keys(detail.variant.properties).map((key) => (
                  <label key={key}>
                    {(
                      {
                        Appearance: "外观",
                        State: "状态",
                        Size: "尺寸",
                        Style: "样式",
                        Value: "值",
                        Material: "材质",
                        Title: "标题",
                        Selected: "选中项",
                        Accessory: "附件",
                        Actions: "操作数",
                        Page: "页码",
                        Type: "类型",
                      } as Record<string, string>
                    )[key] ?? key}
                    <select
                      aria-label={`预览 ${key}`}
                      value={detail.variant.properties[key]}
                      onChange={(ev) => {
                        const value = ev.target.value;
                        const candidates = detail.component.variants.filter(
                          (v) => v.properties[key] === value,
                        );
                        const variant =
                          candidates.find((v) =>
                            Object.entries(detail.variant.properties).every(
                              ([k, x]) => k === key || v.properties[k] === x,
                            ),
                          ) ?? candidates[0];
                        setDetail({
                          libraryId: detail.library.id,
                          componentId: detail.component.id,
                          variantId: variant.id,
                        });
                      }}
                    >
                      {[
                        ...new Set(
                          detail.component.variants.map(
                            (v) => v.properties[key],
                          ),
                        ),
                      ].map((value) => (
                        <option key={value}>{value}</option>
                      ))}
                    </select>
                  </label>
                ))}
                <AssetAnnotations
                  key={detail.component.id}
                  editor={e}
                  library={detail.library}
                  component={detail.component}
                />
                <div className="component-stats">
                  <span>{detail.variant.nodes.length} 个可编辑图层</span>
                  <span>
                    {detail.variant.nodes[0].style.width} ×{" "}
                    {detail.variant.nodes[0].style.height}
                  </span>
                </div>
                <button
                  className="primary wide"
                  onClick={() =>
                    insert(detail.library, detail.component, detail.variant)
                  }
                >
                  <Plus size={15} />
                  插入组件
                </button>
                <button
                  className="wide"
                  onClick={() =>
                    downloadLibrary(
                      detail.library,
                      detail.library.components.length === 1
                        ? detail.component.name || detail.component.id
                        : detail.library.name,
                    )
                  }
                >
                  <Download size={14} />
                  导出此组件库
                </button>
                {detail.library.components.some(
                  (c) => c.master?.documentId === e.doc.id,
                ) && <PublishLibrary library={detail.library} />}
                <small className="library-provenance">
                  {detail.library.source.license}
                </small>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const assetTiers = {
  page: "Page 页面样板",
  block: "Block 业务模块",
  component: "Component 原子组件",
};

function AssetAnnotations({
  editor: e,
  library,
  component,
}: {
  editor: EditorController;
  library: ComponentLibrary;
  component: LibraryComponent;
}) {
  const manifest = useMemo(
    () => extractComponentManifest(library, component),
    [library, component],
  );
  const defaultKeys = new Set(
    component.variants[0].nodes.map((n) => n.templateKey),
  );
  const slots = [
    ...manifest.textSlots
      .filter((s) => defaultKeys.has(s.templateKey))
      .map((s) => s.name + "（文案）"),
    ...manifest.imageSlots
      .filter((s) => defaultKeys.has(s.templateKey))
      .map((s) => s.name + "（图像）"),
    ...manifest.swapSlots
      .filter((s) => defaultKeys.has(s.targetTemplateKey))
      .map((s) => s.name + "（替换）"),
  ];
  const scenario = component.aiHints?.whenToUse ?? "";
  const [tier, setTier] = useState(manifest.assetTier);
  const [hint, setHint] = useState(scenario);
  useEffect(() => {
    setTier(manifest.assetTier);
    setHint(scenario);
  }, [manifest.assetTier, scenario]);
  const installed = !!e.doc.libraries?.[library.id];
  const unchanged = component.assetTier === tier && scenario === hint.trim();
  return (
    <div className="asset-ai-annotations">
      <strong>Forma AI 资产标注</strong>
      <small>
        {assetTiers[manifest.assetTier]} ·{" "}
        {component.assetTier ? "已标注" : "自动推断"}
      </small>
      <small>默认槽位 · {slots.length ? slots.join("、") : "无"}</small>
      {installed && (
        <>
          <label>
            资产层级
            <select
              aria-label="AI 资产层级"
              value={tier}
              onChange={(ev) => setTier(ev.target.value as AssetTier)}
            >
              {(["component", "block", "page"] as const).map((t) => (
                <option key={t} value={t}>
                  {assetTiers[t]}
                </option>
              ))}
            </select>
          </label>
          <label>
            适用场景
            <input
              aria-label="AI 适用场景提示"
              maxLength={500}
              value={hint}
              placeholder="例如：双列瀑布流商品展示，标题最多两行"
              onChange={(ev) => setHint(ev.target.value)}
            />
          </label>
          <button
            type="button"
            disabled={unchanged}
            onClick={() =>
              e.attempt(() => {
                const doc = e.historyRef.current.present;
                const current = doc.libraries?.[library.id];
                if (!current) throw Error("组件库已移除");
                const entry = findBuiltinEntry(library.id);
                const installedComponent = current.components.find(
                  (c) => c.id === component.id,
                );
                // Official kits may be only partly installed. Add the annotated asset on demand.
                const source =
                  !installedComponent && entry
                    ? browsableLibrary(entry, doc)
                    : current;
                const target =
                  installedComponent ??
                  source.components.find((c) => c.id === component.id);
                if (!target) throw Error("组件已移除");
                const components = installedComponent
                  ? current.components
                  : [...current.components, target];
                e.apply([
                  {
                    type: "putLibrary",
                    library: {
                      ...source,
                      components: components.map((c) =>
                        c.id === component.id
                          ? {
                              ...c,
                              assetTier: tier,
                              aiHints: {
                                ...c.aiHints,
                                whenToUse: hint.trim() || undefined,
                              },
                            }
                          : c,
                      ),
                    },
                  },
                ]);
              })
            }
          >
            保存 AI 标注
          </button>
        </>
      )}
    </div>
  );
}

function Foundations({
  editor: e,
  entry,
  appearance,
}: {
  editor: EditorController;
  entry: BuiltinLibraryEntry;
  appearance: Appearance;
}) {
  const tokens = entry.getAppearanceTokens(appearance);
  const fileTokens = Object.entries(e.doc.tokens)
    .filter(([id]) => !builtinTokenIds.has(id))
    .map(([id, t]) => ({ id, label: t.name, value: t.value }));
  const missing = Object.entries(entry.tokens).filter(
    ([id]) => !e.doc.tokens[id],
  );
  const [feedback, setFeedback] = useState<{
    id: string;
    message: string;
  } | null>(null);
  useEffect(() => {
    if (!feedback) return;
    const timer = window.setTimeout(() => setFeedback(null), 1300);
    return () => clearTimeout(timer);
  }, [feedback]);
  const unlocked = e.selected.filter((n) => !isLocked(e.doc, n.id));
  function colorRow(token: { id: string; label: string; value: string }) {
    const locked = e.selected.length > 0 && !unlocked.length;
    return (
      <button
        type="button"
        key={token.id}
        className="token-row foundation-token-row"
        disabled={locked}
        data-tip={
          locked ? "选区已锁定" : e.selected.length ? "应用到选区" : "复制 HEX"
        }
        data-tip-side="right"
        onClick={async () => {
          if (!e.selected.length) {
            try {
              await navigator.clipboard.writeText(token.value.toUpperCase());
              setFeedback({ id: token.id, message: "已复制" });
            } catch {
              e.setError("无法写入系统剪贴板");
            }
            return;
          }
          e.attempt(() => {
            e.apply(
              unlocked.map((n) => {
                const key = fillUsesTextColor(n) ? "color" : "fill";
                return {
                  type: "update",
                  id: n.id,
                  patch: key === "fill" ? { fillToken: undefined } : {},
                  style: { [key]: token.value },
                };
              }),
            );
            setFeedback({ id: token.id, message: "已应用" });
          });
        }}
      >
        <i
          className="token-swatch"
          style={{ background: displayColor(token.value, e.doc.colorProfile) }}
        />
        <span>{token.label}</span>
        <code aria-live="polite">
          {feedback?.id === token.id
            ? feedback.message
            : token.value.toUpperCase()}
        </code>
      </button>
    );
  }
  const textTarget =
    e.selected.length === 1 && unlocked[0]?.type === "text"
      ? unlocked[0]
      : undefined;
  return (
    <div className="asset-foundations">
      <section>
        <div className="foundation-section-head">
          <h3>语义颜色</h3>
          <small>{tokens.length}</small>
          <button
            type="button"
            className="foundation-add"
            aria-label="添加颜色到文件"
            disabled={!missing.length}
            onClick={() =>
              e.attempt(() =>
                e.apply(
                  missing.map(([id, token]) => ({
                    type: "putToken",
                    id,
                    token,
                  })),
                ),
              )
            }
          >
            {missing.length ? (
              <>
                <Plus size={11} />
                添加到文件
              </>
            ) : (
              "已添加"
            )}
          </button>
        </div>
        <div className="foundation-token-list">{tokens.map(colorRow)}</div>
      </section>
      <section>
        <div className="foundation-section-head">
          <h3>文字层级</h3>
          <small>{entry.typography.length}</small>
        </div>
        <div className="foundation-type-list">
          {entry.typography.map((t) => (
            <button
              type="button"
              className="type-spec foundation-type-row"
              key={t.name}
              data-tip={textTarget ? "应用到所选文本" : "插入样例文本"}
              data-tip-side="right"
              onClick={() =>
                e.attempt(() => {
                  const style = {
                    fontSize: t.size,
                    lineHeight: t.lineHeight,
                    fontWeight: t.weight,
                  };
                  if (textTarget) {
                    e.apply([
                      { type: "update", id: textTarget.id, patch: {}, style },
                    ]);
                  } else {
                    const node = createNode("text");
                    const center = e.api.current?.center() ?? { x: 80, y: 80 };
                    node.name = node.text = t.name;
                    Object.assign(node.style, style, {
                      height: t.lineHeight,
                      width: Math.max(160, Math.ceil(t.size * t.name.length)),
                      padding: 0,
                    });
                    node.style.x = Math.round(center.x - node.style.width / 2);
                    node.style.y = Math.round(center.y - node.style.height / 2);
                    e.apply([{ type: "create", node }]);
                    e.setSelection([node.id]);
                  }
                })
              }
            >
              <strong
                style={{
                  fontSize: Math.min(
                    16,
                    Math.max(11, Math.round(t.size * 0.48)),
                  ),
                  fontWeight: t.weight,
                }}
              >
                {t.name}
              </strong>
              <span>
                {t.size}/{t.lineHeight} · {t.weight}
              </span>
            </button>
          ))}
        </div>
      </section>
      <section>
        <div className="foundation-section-head">
          <h3>圆角与间距</h3>
        </div>
        <div className="foundation-scale-grid">
          {entry.scales.map((s) => (
            <div key={s.name}>
              <span>{s.name}</span>
              <code>{s.value}</code>
            </div>
          ))}
        </div>
      </section>
      {!!fileTokens.length && (
        <section>
          <div className="foundation-section-head">
            <h3>文件颜色</h3>
            <small>{fileTokens.length}</small>
          </div>
          <div className="foundation-token-list">
            {fileTokens.map(colorRow)}
          </div>
        </section>
      )}
    </div>
  );
}
