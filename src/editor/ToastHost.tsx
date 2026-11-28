import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  Info,
  X,
} from "lucide-react";

export type StatusSeverity = "info" | "success" | "warning";
type ToastSeverity = "error" | StatusSeverity;

export interface ShellNotice {
  id: string;
  text: string;
  severity?: ToastSeverity;
}

interface ToastProps {
  error?: string;
  onDismissError?: () => void;
  status?: string;
  statusSeverity?: StatusSeverity;
  shellNotice?: string;
  shellNotices?: ShellNotice[];
  shellNoticeSeverity?: ToastSeverity;
  onDismissShellNotice?: (id: string) => void;
  onDismissStatus?: () => void;
  notice?: string;
  onDismissNotice?: () => void;
  anchorRef?: RefObject<HTMLElement | null>;
}

type ToastKind = "error" | "status" | "notice" | "shellNotice";
interface ToastItem {
  kind: ToastKind;
  severity: ToastSeverity;
  message: string;
  onDismiss: () => void;
}
const severityIcons = {
  error: AlertCircle,
  warning: AlertTriangle,
  info: Info,
  success: CheckCircle2,
};
type Bounds = Pick<DOMRect, "left" | "right" | "top" | "bottom">;

const popovers = ".color-popover, .binding-popover, .type-details-popover";
const chrome = ".left-panel, .right-panel, .toolbar, .canvas-minimap";

// Keep the host anchored. Only displace or wrap its cards if a panel actually
// covers their preferred location (including a picker dragged across the canvas).
function freeToastArea(
  bounds: Bounds,
  obstacles: Bounds[],
  width: number,
  height: number,
) {
  const center = (bounds.left + bounds.right) / 2;
  let best:
    { left: number; top: number; width: number; height: number } | undefined;
  let bestArea = -1,
    bestDistance = Infinity;
  const tops = [bounds.top, ...obstacles.map((r) => r.bottom + 4)];
  const bottoms = [bounds.bottom, ...obstacles.map((r) => r.top - 4)];
  for (const top of tops) {
    for (const bottom of bottoms) {
      if (top < bounds.top || bottom > bounds.bottom || bottom <= top) continue;
      let spans = [[bounds.left, bounds.right]];
      for (const rect of obstacles) {
        if (rect.bottom + 4 <= top || rect.top - 4 >= bottom) continue;
        spans = spans.flatMap(([left, right]) =>
          [
            [left, Math.min(right, rect.left - 4)],
            [Math.max(left, rect.right + 4), right],
          ].filter(([l, r]) => r > l),
        );
      }
      for (const [left, right] of spans) {
        const w = Math.min(right - left, width);
        const x = Math.max(left, Math.min(right - w, center - w / 2));
        const area = w * Math.min(height, bottom - top);
        const distance = Math.abs(x + w / 2 - center) + top - bounds.top;
        if (area > bestArea || (area === bestArea && distance < bestDistance)) {
          bestArea = area;
          bestDistance = distance;
          best = {
            left: x + w / 2,
            top,
            width: right - left,
            height: bottom - top,
          };
        }
      }
    }
  }
  return best;
}

function ToastCard({ kind, severity, message, onDismiss }: ToastItem) {
  const card = useRef<HTMLDivElement>(null);
  const dismiss = useRef(onDismiss);
  useLayoutEffect(() => {
    dismiss.current = onDismiss;
  }, [onDismiss]);
  useEffect(() => {
    const el = card.current;
    if (!el || kind !== "status") return;
    let remaining = severity === "warning" ? 8000 : 4500;
    let started = 0;
    let timer: number | undefined;
    let hovered = el.matches(":hover");
    let focused = el.contains(document.activeElement);
    const update = () => {
      if (timer !== undefined) {
        window.clearTimeout(timer);
        remaining -= performance.now() - started;
        timer = undefined;
      }
      if (!hovered && !focused) {
        started = performance.now();
        timer = window.setTimeout(
          () => dismiss.current(),
          Math.max(0, remaining),
        );
      }
    };
    const enter = () => {
      hovered = true;
      update();
    };
    const leave = () => {
      hovered = false;
      update();
    };
    const focus = () => {
      focused = true;
      update();
    };
    const blur = (event: FocusEvent) => {
      focused = el.contains(event.relatedTarget as Node | null);
      update();
    };
    update();
    el.addEventListener("mouseenter", enter);
    el.addEventListener("mouseleave", leave);
    el.addEventListener("focusin", focus);
    el.addEventListener("focusout", blur);
    return () => {
      window.clearTimeout(timer);
      el.removeEventListener("mouseenter", enter);
      el.removeEventListener("mouseleave", leave);
      el.removeEventListener("focusin", focus);
      el.removeEventListener("focusout", blur);
    };
  }, [kind, severity, message]);
  const isError = severity === "error";
  const Icon = severityIcons[severity];
  const closeLabel = isError
    ? "关闭错误"
    : kind === "notice"
      ? "关闭项目记忆提示"
      : "关闭状态提示";
  return (
    <div
      ref={card}
      role={isError ? "alert" : "status"}
      data-kind={kind}
      data-severity={severity}
      className={
        isError
          ? "forma-toast forma-toast-error toast"
          : "forma-toast forma-toast-info toast project-status-toast"
      }
    >
      <span className="forma-toast-icon" aria-hidden="true">
        <Icon size={15} />
      </span>
      <span className="forma-toast-message">{message}</span>
      <button
        type="button"
        className="icon-btn icon-btn-sm"
        aria-label={closeLabel}
        data-tip={closeLabel}
        onClick={onDismiss}
      >
        <X size={13} />
      </button>
    </div>
  );
}

export function ToastHost({
  error,
  status,
  statusSeverity = "success",
  shellNotice,
  shellNotices = [],
  shellNoticeSeverity = "error",
  onDismissShellNotice,
  notice,
  onDismissError,
  onDismissStatus,
  onDismissNotice,
  anchorRef,
}: ToastProps) {
  const host = useRef<HTMLDivElement>(null);
  const stack = useRef<HTMLDivElement>(null);
  const [portalTarget, setPortalTarget] = useState<HTMLElement | null>(null);
  const [dismissed, setDismissed] = useState<Record<string, string>>({});
  const sources: {
    id: string;
    kind: ToastKind;
    text?: string;
    severity: ToastSeverity;
    dismiss?: () => void;
  }[] = [
    {
      id: "error",
      kind: "error",
      text: error,
      severity: "error",
      dismiss: onDismissError,
    },
    ...shellNotices.map(({ id, text, severity }) => ({
      id: `shellNotice:${id}`,
      kind: "shellNotice" as const,
      text,
      severity: severity ?? "error",
      dismiss: () => onDismissShellNotice?.(id),
    })),
    {
      id: "shellNotice",
      kind: "shellNotice",
      text: shellNotice,
      severity: shellNoticeSeverity,
      dismiss: () => onDismissShellNotice?.("shellNotice"),
    },
    {
      id: "status",
      kind: "status",
      text: status,
      severity: statusSeverity,
      dismiss: onDismissStatus,
    },
    {
      id: "notice",
      kind: "notice",
      text: notice,
      severity: "info",
      dismiss: onDismissNotice,
    },
  ];
  useEffect(() => {
    const entries = Object.entries(dismissed);
    const current = entries.filter(([id, text]) =>
      sources.some((source) => source.id === id && source.text === text),
    );
    if (current.length !== entries.length)
      setDismissed(Object.fromEntries(current));
  });
  const seen = new Set<string>();
  const cards = sources.flatMap(({ id, kind, text, severity }) => {
    if (!text || dismissed[id] === text || seen.has(text)) return [];
    // An identical persistent memory notice must not expire with a status.
    if (kind === "status" && text === notice) return [];
    seen.add(text);
    return (
      <ToastCard
        key={id}
        kind={kind}
        severity={severity}
        message={text}
        onDismiss={() => {
          const updates: Record<string, string> = {};
          for (const source of sources) {
            if (source.text === text) {
              updates[source.id] = text;
              source.dismiss?.();
            }
          }
          setDismissed((previous) => ({ ...previous, ...updates }));
        }}
      />
    );
  });

  const active = cards.length > 0;
  const currentAnchor = anchorRef?.current;
  useLayoutEffect(() => {
    const container = host.current;
    const group = stack.current;
    if (!container || !group) {
      setPortalTarget(null);
      return;
    }
    let anchor: HTMLElement | null = null;
    let obstacles: Element[] = [];
    const measure = () => {
      if ((anchorRef?.current ?? null) !== anchor) {
        track();
        return;
      }
      const scrollTop = group.scrollTop;
      const rect = anchor?.getBoundingClientRect();
      const attached = rect && rect.width > 0 && rect.height > 0;
      const width = attached ? rect.width : window.innerWidth;
      const center = attached ? rect.left + width / 2 : width / 2;
      const top = attached ? rect.top + 12 : 52;
      const maxWidth = Math.min(420, Math.max(220, width - 24));
      Object.assign(container.style, {
        left: center + "px",
        top: top + "px",
        maxWidth: maxWidth + "px",
      });
      Object.assign(group.style, {
        maxWidth: maxWidth + "px",
        maxHeight: "none",
      });
      const box = group.getBoundingClientRect();
      const bounds = {
        left: center - width / 2 + 12,
        right: center + width / 2 - 12,
        top,
        bottom: (attached ? rect.bottom : window.innerHeight) - 12,
      };
      const blockers = obstacles
        .map((el) => el.getBoundingClientRect())
        .filter(
          (r) =>
            r.width &&
            r.height &&
            r.right > bounds.left &&
            r.left < bounds.right &&
            r.bottom > top &&
            r.top < bounds.bottom,
        );
      const area = freeToastArea(bounds, blockers, box.width, box.height);
      group.style.visibility = area ? "visible" : "hidden";
      if (area)
        Object.assign(group.style, {
          left: `calc(50% + ${area.left - center}px)`,
          top: area.top - top + "px",
          maxWidth: Math.min(maxWidth, area.width) + "px",
          maxHeight: area.height + "px",
        });
      group.style.overflow =
        group.scrollHeight > group.clientHeight ? "auto" : "visible";
      if (scrollTop) group.scrollTop = scrollTop;
    };
    const resize = new ResizeObserver(measure);
    const moved = new MutationObserver(measure);
    const track = () => {
      resize.disconnect();
      moved.disconnect();
      mounted.disconnect();
      anchor = anchorRef?.current ?? null;
      setPortalTarget(anchor?.matches(".canvas-stage") ? anchor : null);
      const stage = anchor?.closest(".app") ?? anchor;
      // A lazy stage may attach its ref after the host has already rendered.
      mounted.observe(document.body, {
        childList: true,
        subtree: Boolean(anchorRef && !anchor),
      });
      if (anchor) mounted.observe(anchor, { childList: true });
      // Switching pages replaces the workspace containing the canvas.
      if (stage && stage !== anchor)
        mounted.observe(stage, { childList: true });
      obstacles = [
        ...document.body.querySelectorAll(popovers),
        ...(stage?.querySelectorAll(chrome) ?? []),
      ];
      if (anchor) resize.observe(anchor);
      resize.observe(group);
      for (const el of obstacles) {
        resize.observe(el);
        moved.observe(el, {
          attributes: true,
          attributeFilter: ["style", "hidden", "class"],
        });
      }
      measure();
    };
    const mounted = new MutationObserver(track);
    track();
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      mounted.disconnect();
      moved.disconnect();
      resize.disconnect();
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [active, anchorRef, currentAnchor, portalTarget]);

  if (!active) return null;
  const layer = (
    <div className="forma-toast-layer">
      <div className="forma-toast-host" ref={host}>
        <div className="forma-toast-stack" ref={stack}>
          {cards}
        </div>
      </div>
    </div>
  );
  return portalTarget ? createPortal(layer, portalTarget) : layer;
}
