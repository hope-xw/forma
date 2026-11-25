import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Check, ChevronDown, Eye, EyeOff } from "lucide-react";
import "./figma-panels.css";

export interface CanvasViewOptions {
  showRulers: boolean;
  showPixelGrid: boolean;
  showLayoutGuides: boolean;
  outlineMode: boolean;
  snapEnabled: boolean;
  showComments: boolean;
}

export interface ViewOptionsMenuProps {
  zoom: number;
  options: CanvasViewOptions;
  onZoomChange(z: number): void;
  onFit(): void;
  onFitSelection(): void;
  onToggleOption(key: keyof CanvasViewOptions): void;
  onToggleUI(): void;
  uiHidden: boolean;
}

const ZOOM_PRESETS = [0.5, 1, 2] as const;

const VIEW_TOGGLES: {
  key: keyof CanvasViewOptions;
  label: string;
  kbd?: string;
}[] = [
  { key: "showRulers", label: "标尺与辅助线", kbd: "⇧R" },
  { key: "showLayoutGuides", label: "布局参考网格", kbd: "⌃G" },
  { key: "showPixelGrid", label: "像素网格", kbd: "⌘'" },
  { key: "outlineMode", label: "轮廓线框视图", kbd: "⌘Y" },
  { key: "snapEnabled", label: "智能吸附对齐" },
  { key: "showComments", label: "显示画布评论", kbd: "⇧C" },
];

function clampZoom(z: number): number {
  return Math.min(8, Math.max(0.05, Math.round(z * 1000) / 1000));
}

export function ViewOptionsMenu({
  zoom,
  options,
  onZoomChange,
  onFit,
  onFitSelection,
  onToggleOption,
  onToggleUI,
  uiHidden,
}: ViewOptionsMenuProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.isComposing || event.keyCode === 229) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [open]);

  const handleMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const items = Array.from(
      menuRef.current?.querySelectorAll<HTMLButtonElement>(
        'button[role="menuitem"]:not(:disabled), button[role="menuitemcheckbox"]:not(:disabled)',
      ) ?? [],
    );
    if (!items.length) return;
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === "ArrowDown") {
      event.preventDefault();
      items[(current + 1 + items.length) % items.length]?.focus();
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      items[(current - 1 + items.length) % items.length]?.focus();
    } else if (event.key === "Home") {
      event.preventDefault();
      items[0]?.focus();
    } else if (event.key === "End") {
      event.preventDefault();
      items[items.length - 1]?.focus();
    }
  };

  const pct = Math.round(zoom * 100);

  return (
    <div
      ref={rootRef}
      className="fp-view-menu-wrap"
      onPointerDown={(event) => event.stopPropagation()}
    >
      <button
        ref={triggerRef}
        type="button"
        className={`fp-view-trigger icon-btn icon-btn-sm ${open ? "is-open" : ""}`}
        aria-label="缩放与视图选项"
        aria-haspopup="menu"
        aria-expanded={open}
        title={`缩放与视图选项 (${pct}%)`}
        data-tip="缩放与视图选项"
        data-tip-desc="调整画布缩放倍率，切换标尺、网格、像素网格、线框视图与评论"
        data-tip-side="bottom"
        onClick={() => setOpen((v) => !v)}
      >
        <ChevronDown size={13} className="fp-view-chevron" aria-hidden="true" />
      </button>

      {open && (
        <div
          ref={menuRef}
          className="fp-view-menu action-menu compact-context"
          role="menu"
          aria-label="缩放与视图选项"
          onKeyDown={handleMenuKeyDown}
        >
          <div className="fp-view-presets" role="group" aria-label="快捷缩放">
            {ZOOM_PRESETS.map((preset) => {
              const label = `${Math.round(preset * 100)}%`;
              const active = Math.abs(zoom - preset) < 0.015;
              return (
                <button
                  key={preset}
                  type="button"
                  role="menuitem"
                  className={`fp-view-preset-btn ${active ? "is-active" : ""}`}
                  aria-label={`缩放至 ${label}`}
                  onClick={() => {
                    onZoomChange(preset);
                    setOpen(false);
                  }}
                >
                  {label}
                </button>
              );
            })}
          </div>

          <button
            type="button"
            role="menuitem"
            className="fp-menu-item"
            onClick={() => {
              onZoomChange(clampZoom(zoom * 1.25));
              setOpen(false);
            }}
          >
            <span className="fp-menu-check" aria-hidden="true" />
            <span className="fp-menu-label">放大画布</span>
            <kbd>+</kbd>
          </button>

          <button
            type="button"
            role="menuitem"
            className="fp-menu-item"
            onClick={() => {
              onZoomChange(clampZoom(zoom / 1.25));
              setOpen(false);
            }}
          >
            <span className="fp-menu-check" aria-hidden="true" />
            <span className="fp-menu-label">缩小画布</span>
            <kbd>-</kbd>
          </button>

          <button
            type="button"
            role="menuitem"
            className="fp-menu-item"
            onClick={() => {
              onZoomChange(1);
              setOpen(false);
            }}
          >
            <span className="fp-menu-check" aria-hidden="true" />
            <span className="fp-menu-label">实际大小 (100%)</span>
            <kbd>⌘0</kbd>
          </button>

          <button
            type="button"
            role="menuitem"
            className="fp-menu-item"
            onClick={() => {
              onFit();
              setOpen(false);
            }}
          >
            <span className="fp-menu-check" aria-hidden="true" />
            <span className="fp-menu-label">适应全部画板</span>
            <kbd>⇧1</kbd>
          </button>

          <button
            type="button"
            role="menuitem"
            className="fp-menu-item"
            onClick={() => {
              onFitSelection();
              setOpen(false);
            }}
          >
            <span className="fp-menu-check" aria-hidden="true" />
            <span className="fp-menu-label">适应选区</span>
            <kbd>⇧2</kbd>
          </button>

          <hr className="fp-menu-sep" />

          {VIEW_TOGGLES.map((item) => {
            const checked = options[item.key];
            return (
              <button
                key={item.key}
                type="button"
                role="menuitemcheckbox"
                aria-checked={checked}
                className={`fp-menu-item ${checked ? "is-checked" : ""}`}
                onClick={() => onToggleOption(item.key)}
              >
                <span className="fp-menu-check" aria-hidden="true">
                  {checked && <Check size={12} strokeWidth={2.4} />}
                </span>
                <span className="fp-menu-label">{item.label}</span>
                {item.kbd && <kbd>{item.kbd}</kbd>}
              </button>
            );
          })}

          <hr className="fp-menu-sep" />

          <button
            type="button"
            role="menuitemcheckbox"
            aria-checked={uiHidden}
            className={`fp-menu-item ${uiHidden ? "is-checked" : ""}`}
            onClick={() => {
              onToggleUI();
              setOpen(false);
            }}
          >
            <span className="fp-menu-check" aria-hidden="true">
              {uiHidden ? <Eye size={12} /> : <EyeOff size={12} />}
            </span>
            <span className="fp-menu-label">
              {uiHidden ? "显示界面" : "隐藏界面"}
            </span>
            <kbd>⌘\</kbd>
          </button>
        </div>
      )}
    </div>
  );
}
