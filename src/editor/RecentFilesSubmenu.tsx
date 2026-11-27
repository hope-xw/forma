import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { ChevronRight, Clock3 } from "lucide-react";
import {
  listFileProjectAssignments,
  listProjectSpaces,
} from "../infrastructure/project-memory-store";
import { cachedRecentFiles, recentFiles } from "../infrastructure/storage";

export interface RecentFilesSubmenuProps {
  currentFileKey?: string;
  menuOpen: boolean;
  onOpenFile(file: { fileKey: string; title: string }): void;
  onOpenHome(): void;
}

export function RecentFilesSubmenu({
  menuOpen,
  ...props
}: RecentFilesSubmenuProps) {
  return menuOpen ? <RecentFilesMenu {...props} /> : null;
}

function RecentFilesMenu({
  currentFileKey,
  onOpenFile,
  onOpenHome,
}: Omit<RecentFilesSubmenuProps, "menuOpen">) {
  const [files, setFiles] = useState(cachedRecentFiles);
  const [projectNames, setProjectNames] = useState(new Map<string, string>());
  const [expanded, setExpanded] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const clicked = useRef(false);
  const enterMenu = useRef(false);
  const menuId = useId();

  useEffect(() => {
    let active = true;
    void recentFiles().then(
      (result) => {
        if (active) setFiles(result);
      },
      () => {
        /* Keep the cached catalog when storage is unavailable. */
      },
    );
    void Promise.all([listProjectSpaces(), listFileProjectAssignments()]).then(
      ([spaces, assignments]) => {
        if (!active) return;
        const names = new Map(spaces.map(({ id, name }) => [id, name]));
        const byFile = new Map<string, string>();
        for (const [fileKey, projectId] of Object.entries(assignments)) {
          const name = names.get(projectId);
          if (name) byFile.set(fileKey, name);
        }
        setProjectNames(byFile);
      },
      () => {
        /* Project labels are optional when the store is unavailable. */
      },
    );
    return () => {
      active = false;
    };
  }, []);

  // The parent dropdown scrolls. A fixed flyout can extend beyond its edge.
  useLayoutEffect(() => {
    const button = trigger.current;
    const panel = menu.current;
    if (!expanded || !button || !panel) return;
    function position() {
      if (!panel || !button) return;
      const rect = button.getBoundingClientRect();
      const fitsBeside = rect.right + 300 <= window.innerWidth - 4;
      panel.style.position = fitsBeside ? "fixed" : "static";
      panel.style.width = fitsBeside ? "300px" : "100%";
      panel.style.left = rect.right - 1 + "px";
      panel.style.top =
        Math.max(
          4,
          Math.min(rect.top, window.innerHeight - panel.offsetHeight - 4),
        ) + "px";
    }
    position();
    if (enterMenu.current) {
      enterMenu.current = false;
      panel.querySelector("button")?.focus();
    }
    window.addEventListener("resize", position);
    window.addEventListener("scroll", position, true);
    return () => {
      window.removeEventListener("resize", position);
      window.removeEventListener("scroll", position, true);
    };
  }, [expanded, files]);

  function collapse() {
    clicked.current = false;
    enterMenu.current = false;
    setExpanded(false);
  }
  return (
    <div
      className="file-menu-submenu"
      onMouseEnter={() => setExpanded(true)}
      onMouseLeave={(event) => {
        if (!event.currentTarget.contains(document.activeElement)) collapse();
      }}
      onFocus={() => setExpanded(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) collapse();
      }}
      onKeyDown={(event) => {
        if (event.key === "ArrowRight") {
          event.preventDefault();
          event.stopPropagation();
          if (menu.current) menu.current.querySelector("button")?.focus();
          else {
            enterMenu.current = true;
            setExpanded(true);
          }
        } else if (
          expanded &&
          (event.key === "ArrowLeft" || event.key === "Escape")
        ) {
          event.preventDefault();
          event.stopPropagation();
          trigger.current?.focus();
          collapse();
        } else if (
          menu.current?.contains(event.target as Node) &&
          ["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)
        ) {
          event.preventDefault();
          event.stopPropagation();
          const items = Array.from(menu.current.querySelectorAll("button"));
          const i = items.indexOf(document.activeElement as HTMLButtonElement);
          const next =
            event.key === "Home"
              ? 0
              : event.key === "End"
                ? items.length - 1
                : (i + (event.key === "ArrowUp" ? -1 : 1) + items.length) %
                  items.length;
          items[next]?.focus();
        }
      }}
    >
      <button
        ref={trigger}
        type="button"
        aria-haspopup="menu"
        aria-expanded={expanded}
        aria-controls={expanded ? menuId : undefined}
        onClick={(event) => {
          event.stopPropagation();
          if (clicked.current) collapse();
          else {
            clicked.current = true;
            setExpanded(true);
          }
        }}
      >
        <Clock3 size={13} />
        最近打开
        <ChevronRight size={13} style={{ marginLeft: "auto" }} />
      </button>
      {expanded && (
        <div
          id={menuId}
          ref={menu}
          role="menu"
          aria-label="最近打开"
          style={{
            position: "fixed",
            zIndex: 1,
            width: "min(300px, calc(100vw - 8px))",
            maxHeight: "min(360px, 65dvh)",
            overflowY: "auto",
            overscrollBehavior: "contain",
            padding: 5,
            background: "var(--bg-menu)",
            border: "1px solid rgba(255,255,255,.12)",
            borderRadius: 8,
            boxShadow: "var(--shadow-popover)",
          }}
        >
          {[...files]
            .sort((a, b) => b.updatedAt - a.updatedAt)
            .slice(0, 10)
            .map((file) => (
              <button
                key={file.key}
                type="button"
                role="menuitem"
                aria-current={file.key === currentFileKey || undefined}
                onClick={() =>
                  onOpenFile({ fileKey: file.key, title: file.name })
                }
              >
                <span className="truncate">{file.name}</span>
                {file.key === currentFileKey && (
                  <small
                    style={{
                      padding: "0 4px",
                      borderRadius: 4,
                      background: "rgba(255,255,255,.16)",
                    }}
                  >
                    当前
                  </small>
                )}
                <small
                  className="truncate"
                  style={{ marginLeft: "auto", maxWidth: "26%", opacity: 0.72 }}
                >
                  {projectNames.get(file.key) ?? "草稿"}
                </small>
                {file.updatedAt > 0 && (
                  <time
                    style={{ opacity: 0.72, fontSize: 10 }}
                    dateTime={new Date(file.updatedAt).toISOString()}
                  >
                    {new Date(file.updatedAt).toLocaleDateString("zh-CN", {
                      month: "numeric",
                      day: "numeric",
                    })}
                  </time>
                )}
              </button>
            ))}
          {!files.length && (
            <div style={{ padding: 8, fontSize: 11, opacity: 0.72 }}>
              暂无最近打开的设计文件
            </div>
          )}
          <hr role="separator" />
          <button type="button" role="menuitem" onClick={onOpenHome}>
            在工作台查看全部…
          </button>
        </div>
      )}
    </div>
  );
}
