import { Compass, FileText, House, Plus, X } from "lucide-react";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import {
  HOME_TAB_ID,
  type QuickStartPreset,
  type WorkspaceTab,
} from "../application/workspace-tabs";
import "./workspace-tabs.css";

export interface WorkspaceTabBarProps {
  tabs: WorkspaceTab[];
  activeTabId: string;
  canReopenClosed: boolean;
  isMacDesktop?: boolean;
  onSelectTab(tabId: string): void;
  onCloseTab(tabId: string): void;
  onNewTab(preset?: QuickStartPreset): void;
  onReopenClosed(): void;
  onCloseOthers(tabId: string): void;
  onCloseToRight(tabId: string): void;
  onReorderTab(fromId: string, toId: string): void;
  onOpenInNewWindow?(tab: WorkspaceTab): void;
  onDropFiles?(files: FileList): void;
}

interface MenuAnchor {
  tabId: string;
  trigger: HTMLButtonElement;
  x: number;
  y: number;
}

function navigateItems(
  event: KeyboardEvent,
  items: HTMLButtonElement[],
  horizontal: boolean,
) {
  if (
    event.altKey ||
    event.ctrlKey ||
    event.metaKey ||
    event.shiftKey ||
    !items.length
  )
    return;
  const index = items.indexOf(event.target as HTMLButtonElement);
  if (index < 0) return;
  let next: number;
  switch (event.key) {
    case "Home":
      next = 0;
      break;
    case "End":
      next = items.length - 1;
      break;
    case horizontal ? "ArrowRight" : "ArrowDown":
      next = (index + 1) % items.length;
      break;
    case horizontal ? "ArrowLeft" : "ArrowUp":
      next = (index - 1 + items.length) % items.length;
      break;
    default:
      return;
  }
  event.preventDefault();
  event.stopPropagation();
  items[next].focus();
  return items[next];
}

export function WorkspaceTabBar(props: WorkspaceTabBarProps) {
  const { tabs, activeTabId, onDropFiles } = props;
  const activeButton = useRef<HTMLButtonElement>(null);
  const draggedId = useRef<string | null>(null);
  const fileDragDepth = useRef(0);
  const [fileHover, setFileHover] = useState(false);
  const [menu, setMenu] = useState<MenuAnchor | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuTab = tabs.find((tab) => tab.id === menu?.tabId);

  useLayoutEffect(() => {
    activeButton.current?.scrollIntoView?.({
      block: "nearest",
      inline: "nearest",
    });
  }, [activeTabId]);

  useLayoutEffect(() => {
    const surface = menuRef.current;
    if (!surface || !menu) return;
    const place = () => {
      const { width, height } = surface.getBoundingClientRect();
      surface.style.left =
        Math.max(4, Math.min(menu.x, window.innerWidth - width - 4)) + "px";
      surface.style.top =
        Math.max(4, Math.min(menu.y, window.innerHeight - height - 4)) + "px";
    };
    place();
    surface
      .querySelector<HTMLButtonElement>("button:not(:disabled)")
      ?.focus({ preventScroll: true });
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [menu]);

  useEffect(() => {
    if (!menu) return;
    if (!menuTab) {
      setMenu(null);
      return;
    }
    function outside(event: Event) {
      if (!menuRef.current?.contains(event.target as Node)) setMenu(null);
    }
    function escape(event: globalThis.KeyboardEvent) {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      setMenu(null);
      menu?.trigger.focus();
    }
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("click", outside, true);
    document.addEventListener("focusin", outside);
    document.addEventListener("keydown", escape, true);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("click", outside, true);
      document.removeEventListener("focusin", outside);
      document.removeEventListener("keydown", escape, true);
    };
  }, [menu, menuTab]);

  function resetFileDrag() {
    fileDragDepth.current = 0;
    setFileHover(false);
  }
  function menuItem(label: string, action: () => void, disabled = false) {
    return (
      <button
        type="button"
        role="menuitem"
        disabled={disabled}
        onClick={() => {
          setMenu(null);
          menu?.trigger.focus();
          action();
        }}
      >
        {label}
      </button>
    );
  }

  return (
    <div
      className={[
        "workspace-tabbar",
        props.isMacDesktop && "is-mac-desktop",
        fileHover && "is-file-over",
      ]
        .filter(Boolean)
        .join(" ")}
      role="navigation"
      aria-label="设计文件标签栏"
      onDragEnter={(event) => {
        if (!onDropFiles || !event.dataTransfer.types.includes("Files")) return;
        event.preventDefault();
        fileDragDepth.current++;
        setFileHover(true);
      }}
      onDragOver={(event) => {
        if (onDropFiles && event.dataTransfer.types.includes("Files")) {
          event.preventDefault();
          event.dataTransfer.dropEffect = "copy";
        }
      }}
      onDragLeave={() => {
        fileDragDepth.current = Math.max(0, fileDragDepth.current - 1);
        if (!fileDragDepth.current) setFileHover(false);
      }}
      onDrop={(event) => {
        resetFileDrag();
        if (!onDropFiles || !event.dataTransfer.files.length) return;
        event.preventDefault();
        event.stopPropagation();
        onDropFiles(event.dataTransfer.files);
      }}
    >
      <div
        className="wtb-list"
        role="tablist"
        aria-label="工作台与设计文件"
        onKeyDown={(event) => {
          const buttons = Array.from(
            event.currentTarget.querySelectorAll<HTMLButtonElement>(
              '[role="tab"]',
            ),
          );
          const next = navigateItems(event, buttons, true);
          if (next?.dataset.tabId) props.onSelectTab(next.dataset.tabId);
        }}
      >
        {tabs.map((tab) => {
          const home = tab.id === HOME_TAB_ID;
          const active = tab.id === activeTabId;
          const Icon = home ? House : tab.kind === "file" ? FileText : Compass;
          const busyLabel =
            tab.busyReason === "ai"
              ? "AI 生成中"
              : tab.busyReason === "mcp"
                ? "MCP 已连接"
                : undefined;
          return (
            <div
              className={home ? "wtb-item wtb-home" : "wtb-item"}
              data-active={active}
              key={tab.id}
              onAuxClick={(event) => {
                if (!home && event.button === 1) {
                  event.preventDefault();
                  props.onCloseTab(tab.id);
                }
              }}
              onDragOver={(event) => {
                if (!home && draggedId.current) {
                  event.preventDefault();
                  event.dataTransfer.dropEffect = "move";
                }
              }}
              onDrop={(event) => {
                const from = draggedId.current;
                if (home || !from || event.dataTransfer.types.includes("Files"))
                  return;
                event.preventDefault();
                event.stopPropagation();
                draggedId.current = null;
                if (from !== tab.id) props.onReorderTab(from, tab.id);
              }}
            >
              <button
                type="button"
                className="wtb-tab"
                role="tab"
                ref={active ? activeButton : undefined}
                aria-label={home ? "返回工作台" : tab.title}
                aria-selected={active}
                aria-haspopup="menu"
                tabIndex={active ? 0 : -1}
                aria-description={
                  [tab.dirty && "未保存", busyLabel]
                    .filter(Boolean)
                    .join("，") || undefined
                }
                data-tab-id={tab.id}
                data-file-key={tab.fileKey}
                data-tip={home ? "工作台首页" : tab.title}
                data-tip-kbd={home ? "⌘1" : undefined}
                data-tip-side="bottom"
                draggable={!home}
                onDragStart={(event) => {
                  if (home) {
                    event.preventDefault();
                    return;
                  }
                  draggedId.current = tab.id;
                  event.dataTransfer.effectAllowed = "move";
                  event.dataTransfer.setData("application/x-forma-tab", tab.id);
                }}
                onDragEnd={() => {
                  draggedId.current = null;
                }}
                onClick={() => props.onSelectTab(tab.id)}
                onContextMenu={(event) => {
                  event.preventDefault();
                  const trigger = event.currentTarget;
                  const rect = trigger.getBoundingClientRect();
                  const atPointer = event.clientX !== 0 || event.clientY !== 0;
                  setMenu({
                    tabId: tab.id,
                    trigger,
                    x: atPointer ? event.clientX : rect.left,
                    y: atPointer ? event.clientY : rect.bottom,
                  });
                }}
              >
                <Icon size={home ? 16 : 14} aria-hidden="true" />
                {!home && <span className="wtb-title">{tab.title}</span>}
                {tab.dirty && (
                  <span className="wtb-dirty-dot" aria-label="未保存" />
                )}
                {busyLabel && (
                  <span
                    className="wtb-busy-dot"
                    aria-label={busyLabel}
                    title={busyLabel}
                  />
                )}
              </button>
              {!home && (
                <button
                  type="button"
                  className="wtb-close"
                  aria-label={`关闭标签页 ${tab.title}`}
                  tabIndex={active ? 0 : -1}
                  data-tip="关闭标签页"
                  data-tip-kbd={active ? "⌘W" : undefined}
                  data-tip-side="bottom"
                  onClick={() => props.onCloseTab(tab.id)}
                >
                  <X size={12} aria-hidden="true" />
                </button>
              )}
            </div>
          );
        })}
      </div>
      <button
        type="button"
        className="wtb-new-btn"
        aria-label="新建设计标签页"
        data-tip="新建设计标签页"
        data-tip-kbd="⌘T"
        data-tip-side="bottom"
        onClick={() => props.onNewTab()}
      >
        <Plus size={16} aria-hidden="true" />
      </button>
      {menu && menuTab && (
        <div
          className="wtb-menu"
          ref={menuRef}
          role="menu"
          aria-label="标签页操作"
          onKeyDown={(event) => {
            navigateItems(
              event,
              Array.from(
                event.currentTarget.querySelectorAll<HTMLButtonElement>(
                  "button:not(:disabled)",
                ),
              ),
              false,
            );
          }}
        >
          {menuItem(
            "关闭标签页",
            () => props.onCloseTab(menuTab.id),
            menuTab.id === HOME_TAB_ID,
          )}
          {menuItem(
            "关闭其他标签页",
            () => props.onCloseOthers(menuTab.id),
            !tabs.some(
              (tab) => tab.id !== HOME_TAB_ID && tab.id !== menuTab.id,
            ),
          )}
          {menuItem(
            "关闭右侧标签页",
            () => props.onCloseToRight(menuTab.id),
            menuTab.id === tabs.at(-1)?.id,
          )}
          {menuItem(
            "重新打开已关闭标签页",
            props.onReopenClosed,
            !props.canReopenClosed,
          )}
          {props.onOpenInNewWindow &&
            menuItem("在新窗口中打开", () =>
              props.onOpenInNewWindow?.(menuTab),
            )}
        </div>
      )}
    </div>
  );
}
