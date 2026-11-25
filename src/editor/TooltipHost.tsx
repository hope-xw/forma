import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

type Side = "top" | "bottom" | "left" | "right";

interface TipState {
  target: HTMLElement;
  label: string;
  kbd?: string;
  desc?: string;
  side: Side;
  warm: boolean;
}

const COLD_DELAY_MS = 260;
const WARM_WINDOW_MS = 500;
const GAP = 9;
const VIEWPORT_PAD = 8;

function inferSide(el: HTMLElement): Side {
  const explicit = el.dataset.tipSide as Side | undefined;
  if (
    explicit === "top" ||
    explicit === "bottom" ||
    explicit === "left" ||
    explicit === "right"
  )
    return explicit;
  if (el.closest("header, .canvas-top, .panel-tabs, .ds-header, .vector-tools"))
    return "bottom";
  if (el.closest(".toolbar")) return "top";
  if (el.closest(".right-panel")) return "top";
  return "top";
}

function readTip(el: HTMLElement): Omit<TipState, "target" | "warm"> | null {
  const explicit = el.dataset.tip?.trim();
  const titleText = (
    el.dataset.stashedTitle ??
    el.getAttribute("title") ??
    ""
  ).trim();
  const label = explicit || titleText;
  if (!label) return null;
  const kbd = el.dataset.tipKbd?.trim() || undefined;
  const desc = el.dataset.tipDesc?.trim() || undefined;
  return { label, kbd, desc, side: inferSide(el) };
}

function stashTitle(el: HTMLElement) {
  if (el.hasAttribute("title") && el.dataset.stashedTitle === undefined) {
    el.dataset.stashedTitle = el.getAttribute("title") ?? "";
    el.removeAttribute("title");
  }
}

function restoreTitle(el: HTMLElement | null) {
  if (!el || el.dataset.stashedTitle === undefined) return;
  const value = el.dataset.stashedTitle;
  delete el.dataset.stashedTitle;
  if (el.isConnected && value) el.setAttribute("title", value);
}

function findTipTarget(
  raw: EventTarget | null,
  clientX?: number,
  clientY?: number,
): HTMLElement | null {
  if (!(raw instanceof Element)) return null;
  // Never trigger tooltip queries during canvas interactions.
  if (raw.closest(".editor-canvas.is-interacting")) return null;
  const direct = raw.closest<HTMLElement>(
    "[data-tip], [title], [data-stashed-title]",
  );
  if (direct) return direct;
  // Support disabled icon buttons inside chrome containers when pointer hovers over them.
  if (
    clientX !== undefined &&
    clientY !== undefined &&
    !raw.closest(".editor-canvas")
  ) {
    const disabled = raw.querySelectorAll<HTMLElement>(
      "button:disabled[data-tip], button:disabled[title], button:disabled[data-stashed-title]",
    );
    for (const btn of disabled) {
      const r = btn.getBoundingClientRect();
      if (
        clientX >= r.left &&
        clientX <= r.right &&
        clientY >= r.top &&
        clientY <= r.bottom
      ) {
        return btn;
      }
    }
  }
  return null;
}

export function TooltipHost() {
  const [tip, setTip] = useState<TipState | null>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const hoveredRef = useRef<HTMLElement | null>(null);
  const timerRef = useRef<number | null>(null);
  const lastClosedAtRef = useRef(0);
  const visibleRef = useRef(false);

  useEffect(() => {
    const clearTimer = () => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };

    const hide = (recordWarm = true) => {
      clearTimer();
      restoreTitle(hoveredRef.current);
      hoveredRef.current = null;
      if (visibleRef.current) {
        visibleRef.current = false;
        if (recordWarm) lastClosedAtRef.current = Date.now();
        setTip(null);
      }
    };

    const activate = (el: HTMLElement, immediate = false) => {
      if (hoveredRef.current === el && (visibleRef.current || timerRef.current))
        return;
      clearTimer();
      if (hoveredRef.current && hoveredRef.current !== el) {
        restoreTitle(hoveredRef.current);
      }
      stashTitle(el);
      hoveredRef.current = el;
      const parsed = readTip(el);
      if (!parsed) {
        hide(false);
        return;
      }
      const isWarm =
        immediate ||
        visibleRef.current ||
        Date.now() - lastClosedAtRef.current < WARM_WINDOW_MS;
      const show = () => {
        timerRef.current = null;
        if (hoveredRef.current !== el || !el.isConnected) return;
        const fresh = readTip(el);
        if (!fresh) return;
        visibleRef.current = true;
        setTip({ target: el, ...fresh, warm: isWarm });
      };
      if (isWarm) show();
      else timerRef.current = window.setTimeout(show, COLD_DELAY_MS);
    };

    const onPointerOver = (ev: PointerEvent) => {
      if (ev.buttons !== 0 || ev.pointerType === "touch") return;
      const el = findTipTarget(ev.target, ev.clientX, ev.clientY);
      if (!el) {
        if (hoveredRef.current) hide(true);
        return;
      }
      activate(el, false);
    };

    const onPointerMove = (ev: PointerEvent) => {
      if (ev.buttons !== 0 || ev.pointerType === "touch") return;
      const target = ev.target as Element | null;
      if (!target || target.closest(".editor-canvas")) return;
      const hit = findTipTarget(target, ev.clientX, ev.clientY);
      if (hit && hit !== hoveredRef.current) {
        activate(hit, false);
      } else if (!hit && hoveredRef.current) {
        const r = hoveredRef.current.getBoundingClientRect();
        if (
          ev.clientX < r.left ||
          ev.clientX > r.right ||
          ev.clientY < r.top ||
          ev.clientY > r.bottom
        ) {
          hide(true);
        }
      }
    };

    const onPointerOut = (ev: PointerEvent) => {
      const current = hoveredRef.current;
      if (!current) return;
      const related = ev.relatedTarget as Node | null;
      if (related && current.contains(related)) return;
      if (!related) {
        hide(true);
        return;
      }
      const next = findTipTarget(related);
      if (!next) hide(true);
    };

    const onFocusIn = (ev: FocusEvent) => {
      const target = ev.target;
      if (!(target instanceof HTMLElement)) return;
      if (!target.matches(":focus-visible")) return;
      const el = findTipTarget(target);
      if (el) activate(el, true);
    };

    const onFocusOut = () => hide(false);
    const onDismiss = () => hide(false);
    const onKeyDown = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") hide(false);
    };

    document.addEventListener("pointerover", onPointerOver, true);
    document.addEventListener("pointermove", onPointerMove, true);
    document.addEventListener("pointerout", onPointerOut, true);
    document.addEventListener("pointerdown", onDismiss, true);
    document.addEventListener("focusin", onFocusIn, true);
    document.addEventListener("focusout", onFocusOut, true);
    document.addEventListener("scroll", onDismiss, true);
    document.addEventListener("wheel", onDismiss, {
      capture: true,
      passive: true,
    });
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("blur", onDismiss);

    return () => {
      clearTimer();
      restoreTitle(hoveredRef.current);
      document.removeEventListener("pointerover", onPointerOver, true);
      document.removeEventListener("pointermove", onPointerMove, true);
      document.removeEventListener("pointerout", onPointerOut, true);
      document.removeEventListener("pointerdown", onDismiss, true);
      document.removeEventListener("focusin", onFocusIn, true);
      document.removeEventListener("focusout", onFocusOut, true);
      document.removeEventListener("scroll", onDismiss, true);
      document.removeEventListener("wheel", onDismiss, true);
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("blur", onDismiss);
    };
  }, []);

  useLayoutEffect(() => {
    const el = tipRef.current;
    if (!tip || !el) return;
    const anchor = tip.target.getBoundingClientRect();
    if (anchor.width === 0 && anchor.height === 0) {
      el.style.visibility = "hidden";
      return;
    }
    const box = el.getBoundingClientRect();
    let side: Side = tip.side;
    const spaceTop = anchor.top - VIEWPORT_PAD;
    const spaceBottom = window.innerHeight - anchor.bottom - VIEWPORT_PAD;
    const spaceLeft = anchor.left - VIEWPORT_PAD;
    const spaceRight = window.innerWidth - anchor.right - VIEWPORT_PAD;

    if (side === "top" && spaceTop < box.height + GAP && spaceBottom > spaceTop)
      side = "bottom";
    else if (
      side === "bottom" &&
      spaceBottom < box.height + GAP &&
      spaceTop > spaceBottom
    )
      side = "top";
    else if (
      side === "right" &&
      spaceRight < box.width + GAP &&
      spaceLeft > spaceRight
    )
      side = "left";
    else if (
      side === "left" &&
      spaceLeft < box.width + GAP &&
      spaceRight > spaceLeft
    )
      side = "right";

    const anchorCenterX = anchor.left + anchor.width / 2;
    const anchorCenterY = anchor.top + anchor.height / 2;
    let left = 0;
    let top = 0;

    if (side === "top" || side === "bottom") {
      left = Math.max(
        VIEWPORT_PAD,
        Math.min(
          window.innerWidth - box.width - VIEWPORT_PAD,
          anchorCenterX - box.width / 2,
        ),
      );
      top =
        side === "top"
          ? Math.max(VIEWPORT_PAD, anchor.top - box.height - GAP)
          : Math.min(
              window.innerHeight - box.height - VIEWPORT_PAD,
              anchor.bottom + GAP,
            );
      const arrowX = Math.max(
        10,
        Math.min(box.width - 10, anchorCenterX - left),
      );
      el.style.setProperty("--tip-arrow-x", `${arrowX}px`);
    } else {
      top = Math.max(
        VIEWPORT_PAD,
        Math.min(
          window.innerHeight - box.height - VIEWPORT_PAD,
          anchorCenterY - box.height / 2,
        ),
      );
      left =
        side === "left"
          ? Math.max(VIEWPORT_PAD, anchor.left - box.width - GAP)
          : Math.min(
              window.innerWidth - box.width - VIEWPORT_PAD,
              anchor.right + GAP,
            );
      const arrowY = Math.max(
        10,
        Math.min(box.height - 10, anchorCenterY - top),
      );
      el.style.setProperty("--tip-arrow-y", `${arrowY}px`);
    }

    el.dataset.side = side;
    el.style.left = `${Math.round(left)}px`;
    el.style.top = `${Math.round(top)}px`;
    el.style.visibility = "visible";
  }, [tip]);

  if (!tip) return null;

  return createPortal(
    <div
      ref={tipRef}
      role="tooltip"
      className={`forma-tooltip ${tip.warm ? "warm" : ""}`}
      data-side={tip.side}
      style={{ visibility: "hidden" }}
    >
      <div className="forma-tooltip-row">
        <span className="forma-tooltip-label">{tip.label}</span>
        {tip.kbd && <kbd className="forma-tooltip-kbd">{tip.kbd}</kbd>}
      </div>
      {tip.desc && <div className="forma-tooltip-desc">{tip.desc}</div>}
    </div>,
    document.body,
  );
}
