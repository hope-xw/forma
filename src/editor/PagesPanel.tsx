import { SourceName } from "./SourceName";
import {
  Plus,
  File,
  Pencil,
  Trash2,
  PanelsTopLeft,
  Copy,
  ChevronDown,
  ChevronRight,
} from "lucide-react";
import { memo, useEffect, useState } from "react";
import type { EditorController } from "./useEditor";
import {
  addPage,
  openPage,
  pageList,
  removePage,
  duplicatePage,
  reorderPage,
} from "../domain/pages";
export const PagesPanel = memo(
  function PagesPanelView({ editor }: { editor: EditorController }) {
    const doc = editor.committed,
      pages = pageList(doc),
      active = doc.activePage ?? pages[0].id;
    const [renaming, rename] = useState<string | null>(null);
    const [hovered, setHovered] = useState<string | null>(null);
    const [loading, load] = useState(false);
    const [collapsed, setCollapsed] = useState(false);
    const [listHeight, setListHeight] = useState<number | null>(null);
    const [dropTarget, setDropTarget] = useState<{
      id: string;
      pos: "before" | "after";
    } | null>(null);
    const [pageMenu, setPageMenu] = useState<{
      id: string;
      x: number;
      y: number;
    } | null>(null);

    useEffect(() => {
      if (!pageMenu) return;
      const close = () => setPageMenu(null);
      const key = (ev: KeyboardEvent) => {
        if (ev.key === "Escape") setPageMenu(null);
      };
      window.addEventListener("pointerdown", close);
      window.addEventListener("keydown", key);
      return () => {
        window.removeEventListener("pointerdown", close);
        window.removeEventListener("keydown", key);
      };
    }, [pageMenu]);

    async function openExamples() {
      const revision = doc.revision;
      load(true);
      try {
        const response = await fetch(
          import.meta.env.BASE_URL + "examples/mobile-studio.forma.json",
        );
        if (!response.ok) throw new Error("样例读取失败");
        const example = await response.json();
        if (editor.historyRef.current.present.revision !== revision)
          throw new Error("文件已变化，请重新打开样例");
        editor.importDocument(example, { replacedDocument: true });
        editor.setSelection([]);
      } catch (error) {
        editor.setError(String(error));
      } finally {
        load(false);
      }
    }

    function duplicateTargetPage(pageId: string) {
      editor.attempt(() => {
        const base = pageId === active ? doc : openPage(doc, pageId);
        editor.importDocument(duplicatePage(base));
        editor.setSelection([]);
      });
    }

    function deleteTargetPage(pageId: string) {
      if (pages.length <= 1) return;
      editor.attempt(() => {
        if (pageId === active) {
          editor.importDocument(removePage(doc));
          editor.setSelection([]);
        } else {
          editor.importDocument({
            ...doc,
            activePage: active,
            pages: pages.filter((p) => p.id !== pageId),
          });
        }
      });
    }

    function startResize(ev: React.PointerEvent<HTMLDivElement>) {
      ev.preventDefault();
      const section = ev.currentTarget
        .previousElementSibling as HTMLElement | null;
      const startH =
        listHeight ?? section?.getBoundingClientRect().height ?? 120;
      const startY = ev.clientY;
      const onMove = (moveEv: PointerEvent) => {
        const next = Math.max(
          56,
          Math.min(360, startH + moveEv.clientY - startY),
        );
        setListHeight(next);
      };
      const onUp = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    }

    const activePageName = pages.find((p) => p.id === active)?.name ?? "页面 1";

    return (
      <section className="file-pages" aria-label="页面列表">
        <div className="layers-heading">
          <button
            type="button"
            className="pages-toggle-btn"
            aria-expanded={!collapsed}
            aria-label={collapsed ? "展开页面列表" : "收起页面列表"}
            onClick={() => setCollapsed((v) => !v)}
          >
            {collapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
            <span>{collapsed ? activePageName : "页面"}</span>
            {!collapsed && pages.length > 1 && (
              <small style={{ color: "var(--text-muted)", fontWeight: 400 }}>
                {pages.length}
              </small>
            )}
          </button>
          <div>
            <button
              className="icon-btn icon-btn-sm"
              title="打开移动设计样例（可撤销）"
              aria-label="打开移动设计样例"
              data-tip="载入移动设计样例"
              data-tip-desc="打开包含 iPad、iPhone 与野径图志的 4 页综合样例（可撤销）"
              data-tip-side="bottom"
              disabled={loading}
              onClick={openExamples}
            >
              <PanelsTopLeft size={14} />
            </button>
            <button
              className="icon-btn icon-btn-sm"
              title="新建页面"
              aria-label="新建页面"
              data-tip="新建页面"
              data-tip-desc="在当前文档中新增一个空白页面"
              data-tip-side="bottom"
              onClick={() => {
                setCollapsed(false);
                editor.attempt(() =>
                  editor.importDocument(
                    addPage(doc, "页面 " + (pages.length + 1)),
                  ),
                );
              }}
            >
              <Plus size={14} />
            </button>
          </div>
        </div>
        {!collapsed && (
          <>
            <div
              className="pages-scroll"
              style={
                listHeight
                  ? { maxHeight: listHeight, height: listHeight }
                  : undefined
              }
              onDragLeave={(ev) => {
                if (!ev.currentTarget.contains(ev.relatedTarget as Node | null))
                  setDropTarget(null);
              }}
            >
              {pages.map((page) => {
                const isCurrent = active === page.id;
                const dropCls =
                  dropTarget?.id === page.id
                    ? `page-drop-${dropTarget.pos}`
                    : "";
                return (
                  <div
                    key={page.id}
                    draggable={!renaming}
                    onMouseEnter={() => setHovered(page.id)}
                    onMouseLeave={() =>
                      setHovered((cur) => (cur === page.id ? null : cur))
                    }
                    onDragStart={(event) => {
                      event.dataTransfer.setData(
                        "application/x-forma-page",
                        page.id,
                      );
                      event.dataTransfer.effectAllowed = "move";
                    }}
                    onDragOver={(event) => {
                      if (
                        !event.dataTransfer.types.includes(
                          "application/x-forma-page",
                        )
                      )
                        return;
                      event.preventDefault();
                      const rect = event.currentTarget.getBoundingClientRect();
                      const pos =
                        event.clientY - rect.top < rect.height / 2
                          ? "before"
                          : "after";
                      setDropTarget({ id: page.id, pos });
                    }}
                    onDragEnd={() => setDropTarget(null)}
                    onDrop={(event) => {
                      const source = event.dataTransfer.getData(
                        "application/x-forma-page",
                      );
                      setDropTarget(null);
                      if (source && source !== page.id)
                        editor.attempt(() =>
                          editor.importDocument(
                            reorderPage(
                              doc,
                              source,
                              page.id,
                              event.clientY <
                                event.currentTarget.getBoundingClientRect()
                                  .top +
                                  event.currentTarget.offsetHeight / 2
                                ? "before"
                                : "after",
                            ),
                          ),
                        );
                    }}
                    onContextMenu={(event) => {
                      event.preventDefault();
                      setPageMenu({
                        id: page.id,
                        x: Math.min(event.clientX, window.innerWidth - 180),
                        y: Math.min(event.clientY, window.innerHeight - 120),
                      });
                    }}
                    className={`file-page ${isCurrent ? "current active" : ""} ${dropCls}`}
                  >
                    <File size={13} />
                    {renaming === page.id ? (
                      <input
                        aria-label="页面名称"
                        autoFocus
                        style={{
                          fontFamily:
                            "system-ui, var(--source-name-families, sans-serif), sans-serif",
                        }}
                        defaultValue={page.name}
                        maxLength={120}
                        onFocus={(event) => event.target.select()}
                        onBlur={(event) => {
                          const name = event.currentTarget.value.trim();
                          rename(null);
                          if (name && name !== page.name)
                            editor.attempt(() =>
                              editor.importDocument({
                                ...doc,
                                activePage: active,
                                pages: pages.map((item) =>
                                  item.id === page.id
                                    ? { ...item, name }
                                    : item,
                                ),
                              }),
                            );
                        }}
                        onKeyDown={(event) => {
                          event.stopPropagation();
                          if (event.key === "Enter") event.currentTarget.blur();
                          if (event.key === "Escape") {
                            event.currentTarget.value = page.name;
                            event.currentTarget.blur();
                          }
                        }}
                      />
                    ) : (
                      <button
                        className="page-name"
                        aria-current={isCurrent ? "page" : undefined}
                        onDoubleClick={() => rename(page.id)}
                        onClick={() => {
                          if (!isCurrent) {
                            editor.setSelection([]);
                            editor.switchPage(page.id);
                          }
                        }}
                      >
                        <SourceName name={page.name} />
                      </button>
                    )}
                    {renaming !== page.id &&
                      (isCurrent || hovered === page.id) && (
                        <span
                          className="page-actions"
                          style={{
                            display: "inline-flex",
                            gap: 2,
                            opacity: 1,
                            pointerEvents: "auto",
                          }}
                        >
                          <button
                            className="page-action"
                            title="复制页面"
                            aria-label="复制页面"
                            data-tip="复制页面"
                            data-tip-desc="独立复制此页全部图层、辅助线与内部原型连线"
                            data-tip-side="top"
                            onClick={(ev) => {
                              ev.stopPropagation();
                              duplicateTargetPage(page.id);
                            }}
                          >
                            <Copy size={12} />
                          </button>
                          <button
                            className="page-action"
                            title="重命名页面"
                            aria-label="重命名页面"
                            data-tip="重命名页面"
                            data-tip-desc="编辑页名（也可直接双击页面名称）"
                            data-tip-side="top"
                            onClick={(ev) => {
                              ev.stopPropagation();
                              rename(page.id);
                            }}
                          >
                            <Pencil size={12} />
                          </button>
                          {pages.length > 1 && (
                            <button
                              className="page-action"
                              title="删除此页（可撤销）"
                              aria-label="删除此页（可撤销）"
                              data-tip="删除页面"
                              data-tip-desc="移除此页面，支持撤销恢复"
                              data-tip-side="top"
                              onClick={(ev) => {
                                ev.stopPropagation();
                                deleteTargetPage(page.id);
                              }}
                            >
                              <Trash2 size={12} />
                            </button>
                          )}
                        </span>
                      )}
                  </div>
                );
              })}
            </div>
            <div
              className="pages-resizer"
              role="separator"
              aria-orientation="horizontal"
              aria-label="调整页面区域高度"
              onPointerDown={startResize}
            />
          </>
        )}
        {pageMenu && (
          <div
            className="action-menu compact-context"
            role="menu"
            aria-label="页面操作"
            style={{
              position: "fixed",
              left: pageMenu.x,
              top: pageMenu.y,
              width: 168,
              zIndex: 85,
            }}
            onPointerDown={(ev) => ev.stopPropagation()}
          >
            <button
              role="menuitem"
              onClick={() => {
                const id = pageMenu.id;
                setPageMenu(null);
                rename(id);
              }}
            >
              <span>重命名页面</span>
            </button>
            <button
              role="menuitem"
              onClick={() => {
                const id = pageMenu.id;
                setPageMenu(null);
                duplicateTargetPage(id);
              }}
            >
              <span>复制页面</span>
            </button>
            <hr />
            <button
              role="menuitem"
              disabled={pages.length <= 1}
              onClick={() => {
                const id = pageMenu.id;
                setPageMenu(null);
                deleteTargetPage(id);
              }}
            >
              <span>删除此页</span>
            </button>
          </div>
        )}
      </section>
    );
  },
  (prev, next) => prev.editor.committed === next.editor.committed,
);
