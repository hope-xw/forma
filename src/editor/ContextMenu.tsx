import { useLayoutEffect, useRef, useState } from "react";
import { ChevronRight, Layers, Check } from "lucide-react";
import { editActions, type ActionId } from "./actions";
import { canMask, canCombine } from "../domain/boolean-shapes";
import { instanceAncestor, instanceOwner, isLocked } from "../domain/tree";
import {
  detachInstance,
  instanceSource,
  switchInstance,
} from "../domain/library";
import { findMatchingLayers, wrapInSection } from "../domain/section";
import { inspectNodeForDev } from "../compiler/dev-inspect";
import { exportNodeToSvg } from "../infrastructure/static-export";
import type { EditorController } from "./useEditor";

const groups = {
  排列: ["front", "forward", "backward", "back"],
  组织: [
    "createComponent",
    "group",
    "ungroup",
    "wrapFrame",
    "autoLayout",
    "mask",
    "releaseMask",
  ],
  布尔运算: ["union", "subtract", "intersect", "exclude"],
  对齐与分布: [
    "tidy",
    "alignLeft",
    "alignCenter",
    "alignRight",
    "alignTop",
    "alignMiddle",
    "alignBottom",
    "distributeX",
    "distributeY",
  ],
  图层与样式: [
    "rename",
    "hide",
    "lock",
    "copyStyle",
    "pasteStyle",
    "pasteHere",
    "fitSelection",
  ],
  视图: ["fit", "zoom100", "rulers"],
} as const satisfies Record<string, readonly ActionId[]>;

type Group = keyof typeof groups | "选择重叠图层" | "复制为";

export interface ContextMenuProps {
  editor: EditorController;
  position: { x: number; y: number; layers?: string[] };
  close(): void;
  onWrapSection?(): void;
  onSelectMatching?(): void;
  onToggleDevStatus?(): void;
  onPromoteModule?(): void;
}

export function ContextMenu({
  editor: e,
  position,
  close,
  onWrapSection,
  onSelectMatching,
  onToggleDevStatus,
  onPromoteModule,
}: ContextMenuProps) {
  const [openGroup, setOpenGroup] = useState<Group | null>(null);
  const [subPos, setSubPos] = useState<{ left: number; top: number } | null>(
    null,
  );
  const surface = useRef<HTMLDivElement>(null);
  const submenuRef = useRef<HTMLDivElement>(null);

  const nodes = e.selected,
    locked = nodes.some((n) => isLocked(e.doc, n.id)),
    inside = nodes.some((n) => instanceAncestor(e.doc, n.id)),
    sameParent = nodes.every((n) => n.parentId === nodes[0]?.parentId);

  function allowed(id: ActionId) {
    if (id === "createComponent") return !e.componentUnavailable;
    if (id === "tidy") return !!e.smartGrid;
    if (id === "mask") return canMask(e.doc, e.selection);
    if (id === "releaseMask")
      return (
        nodes.length === 1 && !!nodes[0].maskSourceId && !inside && !locked
      );
    if (id === "ungroup")
      return nodes.some((n) => n.type === "group") && !locked && !inside;
    if (id.startsWith("align") || id.startsWith("distribute"))
      return (
        (id.startsWith("align")
          ? nodes.length > 1 || !!nodes[0]?.parentId
          : nodes.length >= 3) &&
        !nodes.some((n) =>
          e.doc.nodes.some(
            (parent) =>
              parent.id === n.parentId &&
              parent.type === "frame" &&
              parent.style.layout !== "free",
          ),
        ) &&
        !locked &&
        !inside
      );
    if (
      [
        "group",
        "wrapFrame",
        "autoLayout",
        "front",
        "back",
        "forward",
        "backward",
      ].includes(id)
    )
      return (
        sameParent &&
        !locked &&
        !inside &&
        !(id === "autoLayout" && nodes.some((n) => instanceOwner(e.doc, n.id)))
      );
    if (["cut", "delete", "duplicate"].includes(id)) return !locked && !inside;
    if (id === "lock")
      return !nodes.some((n) => n.parentId && isLocked(e.doc, n.parentId));
    if (id === "pasteStyle") return !locked && e.canPasteStyle;
    if (["hide", "rename"].includes(id)) return !locked;
    if (id === "undo") return e.canUndo;
    if (id === "redo") return e.canRedo;
    return true;
  }

  useLayoutEffect(() => {
    const previous = document.activeElement as HTMLElement;
    return () => {
      if (
        previous?.isConnected &&
        !document.activeElement?.classList.contains("layer-rename")
      )
        previous.focus({ preventScroll: true });
    };
  }, []);

  useLayoutEffect(() => {
    const el = surface.current!;
    const place = () => {
      const box = el.getBoundingClientRect();
      const left =
          position.x + box.width + 6 <= innerWidth
            ? position.x
            : position.x - box.width,
        top =
          position.y + box.height + 6 <= innerHeight
            ? position.y
            : position.y - box.height;
      el.style.left =
        Math.max(6, Math.min(innerWidth - box.width - 6, left)) + "px";
      el.style.top =
        Math.max(6, Math.min(innerHeight - box.height - 6, top)) + "px";
    };
    place();
    el.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus({
      preventScroll: true,
    });
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [position]);

  const openSubmenu = (
    name: Group,
    triggerEl: HTMLElement,
    focusFirst = false,
  ) => {
    const parentBox = surface.current?.getBoundingClientRect();
    const rowBox = triggerEl.getBoundingClientRect();
    const subW = 216;
    const estH = 260;
    const rightSpace = innerWidth - (parentBox?.right ?? rowBox.right) - 8;
    const left =
      rightSpace >= subW
        ? (parentBox?.right ?? rowBox.right) + 4
        : Math.max(6, (parentBox?.left ?? rowBox.left) - subW - 4);
    const top = Math.max(6, Math.min(innerHeight - estH - 6, rowBox.top - 4));
    setSubPos({ left, top });
    setOpenGroup(name);
    if (focusFirst) {
      requestAnimationFrame(() => {
        submenuRef.current
          ?.querySelector<HTMLButtonElement>("button:not(:disabled)")
          ?.focus({ preventScroll: true });
      });
    }
  };

  useLayoutEffect(() => {
    if (!openGroup || !submenuRef.current) return;
    const box = submenuRef.current.getBoundingClientRect();
    if (box.bottom > innerHeight - 6) {
      submenuRef.current.style.top =
        Math.max(6, innerHeight - box.height - 6) + "px";
    }
  }, [openGroup, subPos]);

  const labelFor = (id: ActionId, fallback: string) => {
    if (id === "hide" && nodes.length)
      return nodes.every((n) => n.hidden) ? "显示" : "隐藏";
    if (id === "lock" && nodes.length)
      return nodes.every((n) => n.locked) ? "解锁" : "锁定";
    return fallback;
  };

  const command = (id: ActionId) => {
    const item = editActions.find((action) => action.id === id)!;
    return (
      <button
        key={id}
        role="menuitem"
        disabled={!allowed(id)}
        onMouseEnter={(event) => {
          if (!submenuRef.current?.contains(event.currentTarget))
            setOpenGroup(null);
        }}
        onClick={() => {
          close();
          e.perform(id);
        }}
      >
        <span>{labelFor(id, item.label)}</span>
        {item.shortcut && <kbd>{item.shortcut}</kbd>}
      </button>
    );
  };

  const categories = (
    nodes.length
      ? [
          "排列",
          "组织",
          ...(canCombine(e.doc, e.selection) ? ["布尔运算"] : []),
          "对齐与分布",
          "图层与样式",
        ]
      : ["视图"]
  ) as (keyof typeof groups)[];

  const singleInstance =
    nodes.length === 1 && nodes[0].instance && !locked && !inside
      ? nodes[0]
      : null;
  const masterRef = (() => {
    if (!singleInstance) return null;
    const src = instanceSource(e.doc, singleInstance);
    if (!src || src.component.master?.documentId !== e.committed.id)
      return null;
    return src.variant.masterNodeId ?? src.component.master.nodeId;
  })();

  const canWrapSection =
    nodes.length > 0 &&
    sameParent &&
    !locked &&
    !inside &&
    (nodes[0].parentId === null ||
      e.doc.nodes.find((n) => n.id === nodes[0].parentId)?.type === "section");

  const canMarkDev =
    nodes.length > 0 &&
    !locked &&
    nodes.some(
      (n) => n.type === "frame" || n.type === "section" || n.type === "group",
    );

  const allDevReady =
    nodes.length > 0 &&
    nodes.every((n) => n.devStatus === "ready" || n.devStatus === "completed");

  const copyText = (text: string) => {
    if (navigator.clipboard?.writeText) {
      void navigator.clipboard.writeText(text).catch(() => {
        /* ignore clipboard rejection */
      });
    }
  };

  const handleWrapSection = () => {
    close();
    if (onWrapSection) {
      onWrapSection();
      return;
    }
    e.attempt(() => {
      const res = wrapInSection(e.committed, e.selection);
      e.apply(res.operations);
      e.setSelection([res.id]);
    });
  };

  const handleSelectMatching = () => {
    close();
    if (onSelectMatching) {
      onSelectMatching();
      return;
    }
    const ids = findMatchingLayers(e.committed, e.selection);
    if (ids.length) e.setSelection(ids);
  };

  const handleToggleDevStatus = () => {
    close();
    if (onToggleDevStatus) {
      onToggleDevStatus();
      return;
    }
    const nextStatus = allDevReady ? "none" : "ready";
    e.attempt(() => {
      e.apply(
        nodes.map((n) => ({
          type: "update" as const,
          id: n.id,
          patch: { devStatus: nextStatus },
        })),
      );
    });
  };

  return (
    <div
      className="context-backdrop"
      onPointerDown={(ev) => {
        if (ev.target === ev.currentTarget) close();
      }}
      onContextMenu={(ev) => {
        ev.preventDefault();
        if (ev.target === ev.currentTarget) close();
      }}
    >
      <div
        className="action-menu compact-context"
        ref={surface}
        role="menu"
        aria-label={openGroup ?? "编辑菜单"}
        onKeyDown={(ev) => {
          ev.stopPropagation();
          const inSub = !!submenuRef.current?.contains(document.activeElement);
          if (ev.key === "Escape") {
            ev.preventDefault();
            if (openGroup) {
              const prevCat = openGroup;
              setOpenGroup(null);
              surface.current
                ?.querySelector<HTMLButtonElement>(
                  `button[data-category="${prevCat}"]`,
                )
                ?.focus({ preventScroll: true });
            } else close();
            return;
          }
          if (ev.key === "ArrowLeft" && openGroup) {
            ev.preventDefault();
            const prevCat = openGroup;
            setOpenGroup(null);
            surface.current
              ?.querySelector<HTMLButtonElement>(
                `button[data-category="${prevCat}"]`,
              )
              ?.focus({ preventScroll: true });
            return;
          }
          if (ev.key === "Tab") {
            ev.preventDefault();
            close();
            return;
          }
          const container = inSub ? submenuRef.current! : surface.current!;
          const items = Array.from(
            container.querySelectorAll<HTMLButtonElement>(
              inSub
                ? "button:not(:disabled)"
                : ":scope > button:not(:disabled)",
            ),
          );
          const index = items.indexOf(
            document.activeElement as HTMLButtonElement,
          );
          if (
            !inSub &&
            ev.key === "ArrowRight" &&
            items[index]?.dataset.category
          ) {
            ev.preventDefault();
            openSubmenu(
              items[index].dataset.category as Group,
              items[index],
              true,
            );
            return;
          }
          if (["ArrowDown", "ArrowUp", "Home", "End"].includes(ev.key)) {
            ev.preventDefault();
            items[
              ev.key === "Home"
                ? 0
                : ev.key === "End"
                  ? items.length - 1
                  : (index + (ev.key === "ArrowDown" ? 1 : -1) + items.length) %
                    items.length
            ]?.focus();
          }
        }}
      >
        {(nodes.length
          ? (["cut", "copy", "paste", "duplicate"] as const)
          : (["paste", "pasteHere", "selectAll", "undo", "redo"] as const)
        ).map(command)}
        <hr />
        {nodes.length > 0 && (
          <button
            role="menuitem"
            data-category="复制为"
            aria-haspopup="menu"
            aria-expanded={openGroup === "复制为"}
            onMouseEnter={(ev) =>
              openSubmenu("复制为", ev.currentTarget, false)
            }
            onClick={(ev) => openSubmenu("复制为", ev.currentTarget, true)}
          >
            <span>复制为</span>
            <ChevronRight size={14} />
          </button>
        )}
        {categories
          .filter((name) => groups[name].some(allowed))
          .map((name) => (
            <button
              key={name}
              role="menuitem"
              data-category={name}
              aria-haspopup="menu"
              aria-expanded={openGroup === name}
              onMouseEnter={(ev) => openSubmenu(name, ev.currentTarget, false)}
              onClick={(ev) => openSubmenu(name, ev.currentTarget, true)}
            >
              <span>{name}</span>
              <ChevronRight size={14} />
            </button>
          ))}
        {nodes.length > 0 && (
          <>
            <button
              role="menuitem"
              disabled={!canWrapSection}
              onMouseEnter={() => {
                if (!submenuRef.current?.contains(document.activeElement))
                  setOpenGroup(null);
              }}
              onClick={handleWrapSection}
            >
              <span>包裹为画布分区</span>
              <kbd>⇧S</kbd>
            </button>
            <button
              role="menuitem"
              onMouseEnter={() => {
                if (!submenuRef.current?.contains(document.activeElement))
                  setOpenGroup(null);
              }}
              onClick={handleSelectMatching}
            >
              <span>选择匹配图层</span>
              <kbd>⌥⌘A</kbd>
            </button>
            {canMarkDev && (
              <button
                role="menuitem"
                onMouseEnter={() => {
                  if (!submenuRef.current?.contains(document.activeElement))
                    setOpenGroup(null);
                }}
                onClick={handleToggleDevStatus}
              >
                <span>
                  {allDevReady
                    ? "取消待开发标记"
                    : "标记为待开发 (Ready for dev)"}
                </span>
              </button>
            )}
          </>
        )}
        {!!position.layers && position.layers.length > 1 && (
          <button
            role="menuitem"
            data-category="选择重叠图层"
            aria-haspopup="menu"
            aria-expanded={openGroup === "选择重叠图层"}
            onMouseEnter={(ev) =>
              openSubmenu("选择重叠图层", ev.currentTarget, false)
            }
            onClick={(ev) =>
              openSubmenu("选择重叠图层", ev.currentTarget, true)
            }
          >
            <span>选择重叠图层</span>
            <ChevronRight size={14} />
          </button>
        )}
        {nodes.length > 0 && (
          <>
            <hr />
            {singleInstance && (
              <>
                {masterRef && (
                  <button
                    role="menuitem"
                    onClick={() => {
                      close();
                      e.setSelection([masterRef]);
                      requestAnimationFrame(() =>
                        e.api.current?.fit([masterRef]),
                      );
                    }}
                  >
                    <span>定位到主组件</span>
                  </button>
                )}
                <button
                  role="menuitem"
                  onClick={() => {
                    close();
                    e.attempt(() =>
                      e.apply(
                        switchInstance(
                          e.doc,
                          singleInstance.id,
                          singleInstance.instance!.variantId,
                          true,
                        ),
                      ),
                    );
                  }}
                >
                  <span>重置实例覆盖</span>
                </button>
                <button
                  role="menuitem"
                  onClick={() => {
                    close();
                    e.attempt(() =>
                      e.apply(detachInstance(e.doc, singleInstance.id)),
                    );
                  }}
                >
                  <span>分离组件实例</span>
                  <kbd>⌥ ⌘ B</kbd>
                </button>
              </>
            )}
            {command("delete")}
          </>
        )}
        {openGroup && subPos && (
          <div
            ref={submenuRef}
            className="context-cascade-submenu"
            style={{ left: subPos.left, top: subPos.top }}
          >
            {openGroup === "选择重叠图层" ? (
              position.layers?.map((id) => {
                const n = e.doc.nodes.find((n) => n.id === id);
                return (
                  n && (
                    <button
                      key={id}
                      role="menuitem"
                      aria-label={"选取 " + n.name}
                      onClick={() => {
                        e.setSelection([id]);
                        close();
                      }}
                    >
                      <span
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          gap: 6,
                          minWidth: 0,
                        }}
                      >
                        <Layers size={12} />
                        <span className="truncate">{n.name}</span>
                      </span>
                      {e.selection.includes(id) && <Check size={12} />}
                    </button>
                  )
                );
              })
            ) : openGroup === "复制为" ? (
              <>
                <button
                  role="menuitem"
                  disabled={!nodes.length}
                  onClick={() => {
                    const first = nodes[0];
                    close();
                    if (!first) return;
                    e.attempt(() => {
                      const out = inspectNodeForDev(e.doc, first.id, "px");
                      copyText(out.snippets.css);
                    });
                  }}
                >
                  <span>复制 CSS</span>
                </button>
                <button
                  role="menuitem"
                  disabled={!nodes.length}
                  onClick={() => {
                    const first = nodes[0];
                    close();
                    if (!first) return;
                    e.attempt(() => {
                      const svg = exportNodeToSvg(e.doc, first.id, 1);
                      copyText(svg);
                    });
                  }}
                >
                  <span>复制 SVG</span>
                </button>
                <hr />
                {command("copyStyle")}
                {command("pasteStyle")}
              </>
            ) : (
              <>
                {groups[openGroup].filter(allowed).map(command)}
                {openGroup === "组织" &&
                  nodes.length === 1 &&
                  !e.componentUnavailable &&
                  onPromoteModule && (
                    <button
                      role="menuitem"
                      onClick={() => {
                        close();
                        onPromoteModule();
                      }}
                    >
                      沉淀为组件库模块…
                    </button>
                  )}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
