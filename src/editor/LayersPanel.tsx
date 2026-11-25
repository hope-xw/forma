import { SourceName } from "./SourceName";
import {
  memo,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Diamond,
  Plus,
  ChevronsDownUp,
  Component,
  Blend,
  PenTool,
  Pentagon,
  Star,
  Combine,
  ChevronDown,
  ChevronRight,
  Circle,
  Eye,
  EyeOff,
  Frame,
  Group,
  Lock,
  Search,
  Square,
  Type,
  Unlock,
  Rows3,
  Columns3,
  Grid2X2,
  WrapText,
  LayoutGrid,
  LayoutPanelTop,
  Scissors,
  CopyCheck,
  Image as ImageIcon,
  ListFilter,
  X,
} from "lucide-react";
import type { DesignNode } from "../domain/document";
import { findMatchingLayers } from "../domain/section";
import {
  ancestors,
  instanceAncestor,
  instanceOwner,
  isLocked,
  isContainer,
  subtreeIds,
} from "../domain/tree";
import type { EditorController } from "./useEditor";
import { localMasters } from "../domain/component-masters";
import {
  childrenOf,
  findLayer,
  indexPublishedScene,
} from "../domain/scene-index";
export const LayersPanel = memo(
  function LayersPanelView({
    editor: e,
    contextMenu,
    onSelectMatching,
  }: {
    editor: EditorController;
    contextMenu(x: number, y: number): void;
    onSelectMatching?(): void;
  }) {
    const [query, setQuery] = useState("");
    const [kindFilter, setKindFilter] = useState<
      "all" | "frame" | "text" | "component" | "vector"
    >("all");
    const [filtersOpen, setFiltersOpen] = useState(false);
    const [draggingLayers, setDraggingLayers] = useState(false);
    const masters = useMemo(
      () => new Set(localMasters(e.committed).map((m) => m.nodeId)),
      [e.committed],
    );
    const [collapsed, setCollapsed] = useState<Set<string>>(
      () =>
        new Set(
          e.committed.nodes.length > 150
            ? e.committed.nodes
                .filter((node) => !node.parentId)
                .map((node) => node.id)
            : [],
        ),
    );
    const [openInstances, setOpenInstances] = useState<Set<string>>(new Set());
    const closed = (node: DesignNode) =>
      node.instance ? !openInstances.has(node.id) : collapsed.has(node.id);
    indexPublishedScene(e.committed);
    useEffect(() => {
      if (!e.selection.length) return;
      const parents = e.selection.flatMap((id) => ancestors(e.committed, id));
      if (!parents.length) return;
      const instanceParents = parents
        .filter((n) => n.instance)
        .map((n) => n.id);
      if (instanceParents.length) {
        setOpenInstances((current) => {
          if (instanceParents.every((id) => current.has(id))) return current;
          return new Set([...current, ...instanceParents]);
        });
      }
      const parentIds = new Set(parents.map((n) => n.id));
      setCollapsed((current) => {
        let changed = false;
        for (const id of parentIds) {
          if (current.has(id)) {
            changed = true;
            break;
          }
        }
        if (!changed) return current;
        const next = new Set(current);
        for (const id of parentIds) next.delete(id);
        return next;
      });
    }, [e.selection, e.committed]);
    const [over, setOver] = useState<{
      id: string;
      zone: "before" | "inside" | "after";
    } | null>(null);
    const rangeAnchor = useRef<string | null>(null);
    useEffect(() => {
      if (e.selection.length === 1) rangeAnchor.current = e.selection[0];
      else if (!e.selection.length) rangeAnchor.current = null;
    }, [e.selection]);
    function isVisualStack(parent: string | null) {
      if (parent === null) return true;
      const node = findLayer(e.committed, parent);
      return !node || node.type === "group" || node.style.layout === "free";
    }
    function selectLayer(id: string, shift: boolean, toggle: boolean) {
      if (shift && rangeAnchor.current) {
        const visible = rows.map((r) => r.node.id);
        const start = visible.indexOf(rangeAnchor.current),
          end = visible.indexOf(id);
        if (start >= 0 && end >= 0) {
          const slice = visible.slice(
            Math.min(start, end),
            Math.max(start, end) + 1,
          );
          e.setSelection(start > end ? slice.reverse() : slice);
          return;
        }
      }
      rangeAnchor.current = id;
      e.select(id, toggle);
    }
    function collapseLayers() {
      const path = new Set(
        e.selection.flatMap((id) =>
          ancestors(e.committed, id).map((n) => n.id),
        ),
      );
      setCollapsed(
        new Set(
          e.committed.nodes
            .filter((n) => isContainer(n) && !path.has(n.id))
            .map((n) => n.id),
        ),
      );
      setOpenInstances(
        new Set([...path].filter((id) => findLayer(e.committed, id)?.instance)),
      );
    }
    function toggle(id: string) {
      const setter = findLayer(e.committed, id)?.instance
        ? setOpenInstances
        : setCollapsed;
      setter((s) => {
        const next = new Set(s);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
    }
    function row(node: DesignNode, depth: number): React.ReactNode {
      const children = childrenOf(e.committed, node.id);
      const protectedChild = instanceAncestor(e.committed, node.id);
      const isMaster = masters.has(node.id);
      const isSet = !!node.componentSet;
      const hasImageFill = !!node.image;
      const frameIcon =
        node.style.layout === "grid"
          ? Grid2X2
          : node.style.layout === "row"
            ? node.style.wrap
              ? WrapText
              : Columns3
            : node.style.layout === "column"
              ? Rows3
              : Frame;
      const Icon = isSet
        ? LayoutGrid
        : isMaster
          ? Component
          : node.instance
            ? Diamond
            : node.maskSourceId
              ? Blend
              : node.booleanOperation
                ? Combine
                : node.type === "rectangle" && hasImageFill
                  ? ImageIcon
                  : {
                      frame: frameIcon,
                      group: Group,
                      section: LayoutPanelTop,
                      slice: Scissors,
                      text: Type,
                      ellipse: Circle,
                      rectangle: Square,
                      button: Square,
                      vector:
                        node.vector?.radial?.kind === "star"
                          ? Star
                          : node.vector?.radial
                            ? Pentagon
                            : PenTool,
                    }[node.type];
      const stateTooltip = isSet
        ? "组件变体集"
        : isMaster
          ? "主组件 · 编辑会同步到文件中的实例"
          : node.instance
            ? "组件实例 · 结构受保护，分离后可修改结构"
            : protectedChild
              ? `属于组件 ${protectedChild.name}，可覆盖文字与外观`
              : undefined;
      return (
        <div
          key={node.id}
          role="treeitem"
          aria-level={depth + 1}
          aria-selected={e.selection.includes(node.id)}
          aria-expanded={children.length ? !closed(node) : undefined}
        >
          <div
            data-instance-state={
              isSet
                ? "component-set"
                : isMaster
                  ? "master-component"
                  : node.instance
                    ? "protected-instance"
                    : protectedChild
                      ? "instance-child"
                      : undefined
            }
            data-layer-id={node.id}
            className={`layer-row ${e.selection.includes(node.id) ? "active" : ""} ${node.parentId === null && node.type === "frame" ? "is-root-frame" : ""} ${node.hidden ? "hidden-layer" : ""} ${over?.id === node.id ? `drop-${over.zone}` : ""}`}
            style={{ paddingLeft: 6 + depth * 14 }}
            draggable={
              !isLocked(e.committed, node.id) &&
              !protectedChild &&
              e.renaming !== node.id
            }
            onDragStart={(event) => {
              const ids = e.selection.includes(node.id)
                ? e.selection
                : [node.id];
              e.setSelection(ids);
              setDraggingLayers(true);
              event.dataTransfer.setData(
                "application/x-forma-layers",
                JSON.stringify(ids),
              );
              event.dataTransfer.effectAllowed = "move";
            }}
            onDragOver={(event) => {
              if (
                !event.dataTransfer.types.includes("application/x-forma-layers")
              )
                return;
              if (instanceOwner(e.committed, node.id) && !node.instance) return;
              event.preventDefault();
              const rect = event.currentTarget.getBoundingClientRect();
              const y = (event.clientY - rect.top) / rect.height;
              setOver({
                id: node.id,
                zone:
                  y < 0.25
                    ? "before"
                    : y > 0.75
                      ? "after"
                      : isContainer(node) && !node.instance
                        ? "inside"
                        : "after",
              });
              event.dataTransfer.dropEffect = "move";
            }}
            onDragEnd={() => {
              setOver(null);
              setDraggingLayers(false);
            }}
            onDrop={(event) => {
              event.preventDefault();
              event.stopPropagation();
              const target = over;
              setOver(null);
              setDraggingLayers(false);
              if (!target) return;
              e.attempt(() => {
                const ids: unknown = JSON.parse(
                  event.dataTransfer.getData("application/x-forma-layers"),
                );
                if (
                  !Array.isArray(ids) ||
                  !ids.every((id) => typeof id === "string")
                )
                  throw new Error("拖动数据无效");
                if (subtreeIds(e.committed, ids).has(node.id))
                  throw new Error("不能移入自身或子层");
                const parent =
                  target.zone === "inside" ? node.id : node.parentId;
                const reversed = isVisualStack(parent);
                const siblings = e.committed.nodes.filter(
                  (n) => n.parentId === parent && !ids.includes(n.id),
                );
                const pos = siblings.findIndex((n) => n.id === node.id);
                const index =
                  target.zone === "inside"
                    ? undefined
                    : reversed
                      ? pos + (target.zone === "before" ? 1 : 0)
                      : pos + (target.zone === "after" ? 1 : 0);
                e.reparent(ids, parent, index);
              });
            }}
            onContextMenu={(event) => {
              event.preventDefault();
              if (!e.selection.includes(node.id)) e.setSelection([node.id]);
              contextMenu(event.clientX, event.clientY);
            }}
          >
            <button
              className="tree-toggle"
              aria-label={`${closed(node) ? "展开" : "折叠"} ${node.name}`}
              data-tip={
                children.length
                  ? closed(node)
                    ? "展开子层"
                    : "折叠子层"
                  : undefined
              }
              disabled={!children.length}
              onClick={() => toggle(node.id)}
            >
              {children.length ? (
                closed(node) ? (
                  <ChevronRight size={12} />
                ) : (
                  <ChevronDown size={12} />
                )
              ) : null}
            </button>
            <button
              className="layer-main"
              title={stateTooltip}
              aria-label={`选择图层 ${node.name}`}
              onClick={(event) =>
                selectLayer(
                  node.id,
                  event.shiftKey,
                  event.metaKey || event.ctrlKey,
                )
              }
              onDoubleClick={() => e.setRenaming(node.id)}
            >
              <Icon size={13} />
              {e.renaming !== node.id && (
                <span className="truncate">
                  <SourceName name={node.name} />
                </span>
              )}
            </button>
            {e.renaming === node.id && (
              <input
                autoFocus
                aria-label="重命名图层"
                className="layer-rename"
                style={{
                  fontFamily:
                    "system-ui, var(--source-name-families, sans-serif), sans-serif",
                }}
                defaultValue={node.name}
                onFocus={(event) => event.target.select()}
                onBlur={(event) => {
                  const name = event.target.value.trim();
                  if (name && name !== node.name)
                    e.attempt(() =>
                      e.apply([
                        { type: "update", id: node.id, patch: { name } },
                      ]),
                    );
                  e.setRenaming(null);
                }}
                onKeyDown={(event) => {
                  event.stopPropagation();
                  if (event.key === "Enter") event.currentTarget.blur();
                  if (event.key === "Escape") {
                    event.currentTarget.value = node.name;
                    event.currentTarget.blur();
                  }
                }}
              />
            )}
            {(node.devStatus === "ready" || node.devStatus === "completed") && (
              <span
                className="layer-dev-badge"
                title={
                  node.devStatus === "completed"
                    ? "已完成开发"
                    : "待开发 (Ready for dev)"
                }
                aria-label={
                  node.devStatus === "completed" ? "已完成开发" : "待开发"
                }
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 3,
                  fontSize: 9,
                  fontWeight: 600,
                  lineHeight: 1,
                  padding: "2px 4px",
                  borderRadius: 3,
                  flexShrink: 0,
                  background:
                    node.devStatus === "completed"
                      ? "rgba(20, 174, 92, 0.2)"
                      : "rgba(20, 174, 92, 0.12)",
                  color: "var(--figma-green, #14ae5c)",
                  border: "1px solid rgba(20, 174, 92, 0.3)",
                }}
              >
                <span
                  aria-hidden="true"
                  style={{
                    width: 5,
                    height: 5,
                    borderRadius: "50%",
                    background: "var(--figma-green, #14ae5c)",
                  }}
                />
                DEV
              </span>
            )}
            <button
              className={`layer-control ${node.locked ? "persistent" : ""}`}
              title={node.locked ? "解锁图层" : "锁定图层"}
              aria-label={node.locked ? "解锁图层" : "锁定图层"}
              data-tip={node.locked ? "解锁图层" : "锁定图层"}
              data-tip-kbd="⇧⌘L"
              data-tip-side="right"
              onClick={() =>
                e.attempt(() =>
                  e.apply([
                    {
                      type: "update",
                      id: node.id,
                      patch: { locked: !node.locked },
                    },
                  ]),
                )
              }
            >
              {node.locked ? <Lock size={12} /> : <Unlock size={12} />}
            </button>
            <button
              className={`layer-control ${node.hidden ? "persistent" : ""}`}
              title={node.hidden ? "显示图层" : "隐藏图层"}
              aria-label={node.hidden ? "显示图层" : "隐藏图层"}
              data-tip={node.hidden ? "显示图层" : "隐藏图层"}
              data-tip-kbd="⇧⌘H"
              data-tip-side="right"
              onClick={() =>
                e.attempt(() =>
                  e.apply([
                    {
                      type: "update",
                      id: node.id,
                      patch: { hidden: !node.hidden },
                    },
                  ]),
                )
              }
            >
              {node.hidden ? <EyeOff size={12} /> : <Eye size={12} />}
            </button>
          </div>
        </div>
      );
    }
    const filtering = !!query || kindFilter !== "all";
    const matching = useMemo(() => {
      const result = new Set<string>();
      if (filtering) {
        const term = query.toLowerCase();
        for (const node of e.committed.nodes) {
          const matchesKind =
            kindFilter === "all" ||
            (kindFilter === "frame" && node.type === "frame") ||
            (kindFilter === "text" &&
              (node.type === "text" || node.type === "button")) ||
            (kindFilter === "component" &&
              (masters.has(node.id) ||
                !!node.instance ||
                !!node.componentSet)) ||
            (kindFilter === "vector" &&
              (node.type === "vector" || !!node.booleanOperation));
          if (
            matchesKind &&
            (!term || node.name.toLowerCase().includes(term))
          ) {
            result.add(node.id);
            for (const parent of ancestors(e.committed, node.id))
              result.add(parent.id);
          }
        }
      }
      return result;
    }, [e.committed, query, kindFilter, filtering, masters]);
    const rows = useMemo(() => {
      const flat: { node: DesignNode; depth: number }[] = [];
      function visit(parent: string | null, depth: number) {
        const kids = childrenOf(e.committed, parent);
        const ordered = isVisualStack(parent) ? [...kids].reverse() : kids;
        for (const node of ordered) {
          if (filtering && !matching.has(node.id)) continue;
          flat.push({ node, depth });
          if (filtering || !closed(node)) visit(node.id, depth + 1);
        }
      }
      visit(null, 0);
      return flat;
    }, [e.committed, matching, filtering, collapsed, openInstances]);
    const tree = useRef<HTMLDivElement>(null);
    const [windowSize, setWindowSize] = useState(600),
      [scroll, setScroll] = useState(0);
    const rowHeight = 26,
      virtual = rows.length > 300;
    const start = virtual
      ? Math.max(
          0,
          Math.min(rows.length - 1, Math.floor(scroll / rowHeight) - 10),
        )
      : 0;
    const end = virtual
      ? Math.min(rows.length, start + Math.ceil(windowSize / rowHeight) + 22)
      : rows.length;
    useLayoutEffect(() => {
      const el = tree.current;
      if (!el) return;
      const ro = new ResizeObserver(() => setWindowSize(el.clientHeight));
      ro.observe(el);
      return () => ro.disconnect();
    }, []);
    const selectedId = e.selection.at(-1);
    const selectedIndex = rows.findIndex((r) => r.node.id === selectedId);
    useLayoutEffect(() => {
      const el = tree.current;
      if (!el || selectedIndex < 0) return;
      const top = selectedIndex * rowHeight,
        bottom = top + rowHeight;
      if (top < el.scrollTop) el.scrollTop = top;
      else if (bottom > el.scrollTop + el.clientHeight)
        el.scrollTop = bottom - el.clientHeight;
      setScroll(el.scrollTop);
    }, [selectedId, selectedIndex]);
    return (
      <>
        <div className="layers-heading">
          <span>图层</span>
          <div className="layer-heading-actions">
            <button
              className="icon-btn icon-btn-sm"
              title="选择匹配图层 ⌥⌘A"
              aria-label="选择匹配图层"
              data-tip="选择匹配图层"
              data-tip-kbd="⌥⌘A"
              data-tip-desc="在同级画板和分区中选取同名同类型图层"
              data-tip-side="right"
              disabled={!e.selection.length}
              onClick={() => {
                if (onSelectMatching) onSelectMatching();
                else {
                  const ids = findMatchingLayers(e.committed, e.selection);
                  if (ids.length) e.setSelection(ids);
                }
              }}
            >
              <CopyCheck size={14} />
            </button>
            <button
              className="icon-btn icon-btn-sm"
              aria-label="折叠图层"
              data-tip="折叠图层"
              data-tip-desc="保留选区的上级路径，收起其他分支"
              data-tip-side="right"
              disabled={
                !!query ||
                !rows.some(
                  ({ node }) =>
                    childrenOf(e.committed, node.id).length && !closed(node),
                )
              }
              onClick={collapseLayers}
            >
              <ChevronsDownUp size={14} />
            </button>
            <button
              className="icon-btn icon-btn-sm"
              title="添加画板"
              aria-label="添加画板"
              data-tip="添加新画板"
              data-tip-desc="在画布插入一个默认尺寸画板容器"
              data-tip-side="right"
              onClick={() => e.add("frame")}
            >
              <Plus size={14} />
            </button>
          </div>
        </div>
        <label className="search">
          <Search size={13} />
          <input
            aria-label="搜索图层"
            placeholder="搜索图层…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          {query && (
            <button
              type="button"
              className="icon-btn icon-btn-sm"
              style={{ width: 18, height: 18 }}
              aria-label="清空图层搜索"
              data-tip="清空图层搜索"
              onClick={() => setQuery("")}
            >
              <X size={11} />
            </button>
          )}
          <button
            type="button"
            className={`icon-btn icon-btn-sm ${filtersOpen || kindFilter !== "all" ? "active" : ""}`}
            style={{ width: 18, height: 18 }}
            aria-label="筛选图层类型"
            aria-expanded={filtersOpen || kindFilter !== "all"}
            title="按类型筛选图层"
            data-tip="按图层类型筛选"
            data-tip-side="top"
            onClick={(ev) => {
              ev.preventDefault();
              setFiltersOpen((v) => !v);
            }}
          >
            <ListFilter size={11} />
          </button>
        </label>
        {(filtersOpen || kindFilter !== "all" || query.trim().length > 0) && (
          <div
            className="layer-filter-pills"
            role="group"
            aria-label="按类型筛选图层"
          >
            {(
              [
                ["all", "全部"],
                ["frame", "画板"],
                ["text", "文本"],
                ["component", "组件"],
                ["vector", "矢量"],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                className={kindFilter === id ? "active" : ""}
                aria-pressed={kindFilter === id}
                onClick={() => setKindFilter(id)}
              >
                {label}
              </button>
            ))}
          </div>
        )}
        <div
          className="layer-list"
          ref={tree}
          role="tree"
          aria-label="图层"
          aria-multiselectable="true"
          tabIndex={0}
          onDragLeave={(event) => {
            if (
              !event.currentTarget.contains(event.relatedTarget as Node | null)
            )
              setOver(null);
          }}
          onKeyDown={(event) => {
            if (e.renaming) return;
            if (!rows.length) return;
            const currentId = e.selection.at(-1);
            const idx = currentId
              ? rows.findIndex((r) => r.node.id === currentId)
              : -1;
            const moveTo = (nextIdx: number) => {
              const clamped = Math.max(0, Math.min(rows.length - 1, nextIdx));
              const target = rows[clamped];
              if (!target) return;
              selectLayer(target.node.id, event.shiftKey, false);
              requestAnimationFrame(() => {
                tree.current
                  ?.querySelector<HTMLButtonElement>(
                    `[data-layer-id="${target.node.id}"] .layer-main`,
                  )
                  ?.focus();
              });
            };
            if (event.key === "ArrowDown") {
              event.preventDefault();
              event.stopPropagation();
              moveTo(idx < 0 ? 0 : idx + 1);
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              event.stopPropagation();
              moveTo(idx < 0 ? rows.length - 1 : idx - 1);
            } else if (event.key === "Home") {
              event.preventDefault();
              event.stopPropagation();
              moveTo(0);
            } else if (event.key === "End") {
              event.preventDefault();
              event.stopPropagation();
              moveTo(rows.length - 1);
            } else if (event.key === "ArrowRight" && idx >= 0) {
              const cur = rows[idx].node;
              const kids = childrenOf(e.committed, cur.id);
              if (kids.length) {
                event.preventDefault();
                event.stopPropagation();
                if (closed(cur)) toggle(cur.id);
                else moveTo(idx + 1);
              }
            } else if (event.key === "ArrowLeft" && idx >= 0) {
              const cur = rows[idx].node;
              const kids = childrenOf(e.committed, cur.id);
              event.preventDefault();
              event.stopPropagation();
              if (kids.length && !closed(cur)) toggle(cur.id);
              else if (cur.parentId) {
                const pIdx = rows.findIndex((r) => r.node.id === cur.parentId);
                if (pIdx >= 0) moveTo(pIdx);
              }
            } else if (event.key === "Escape" && e.selection.length) {
              event.preventDefault();
              event.stopPropagation();
              e.setSelection([]);
            }
          }}
          onScroll={(event) => setScroll(event.currentTarget.scrollTop)}
        >
          {virtual && (
            <div aria-hidden="true" style={{ height: start * rowHeight }} />
          )}
          {rows.slice(start, end).map((r) => row(r.node, r.depth))}
          {virtual && (
            <div
              aria-hidden="true"
              style={{ height: (rows.length - end) * rowHeight }}
            />
          )}
        </div>
        {draggingLayers && (
          <div
            className="layer-root-drop"
            title="拖放到页面根层"
            onDragOver={(event) => {
              if (
                event.dataTransfer.types.includes("application/x-forma-layers")
              )
                event.preventDefault();
            }}
            onDrop={(event) => {
              event.preventDefault();
              setOver(null);
              setDraggingLayers(false);
              e.attempt(() => {
                const ids: unknown = JSON.parse(
                  event.dataTransfer.getData("application/x-forma-layers"),
                );
                if (
                  Array.isArray(ids) &&
                  ids.every((id) => typeof id === "string")
                )
                  e.reparent(ids, null);
              });
            }}
          >
            拖放到此处移至页面根层
          </div>
        )}
      </>
    );
  },
  (prev, next) =>
    prev.editor.committed === next.editor.committed &&
    prev.editor.selection === next.editor.selection &&
    prev.editor.renaming === next.editor.renaming &&
    prev.onSelectMatching === next.onSelectMatching,
);
