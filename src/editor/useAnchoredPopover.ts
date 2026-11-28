import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useRef,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";

export const PopoverSurfaceContext = createContext<boolean>(true);
export const PopoverDocumentSessionContext = createContext<number>(0);
// A modal trap can share the same portal. Only the anchor returns its focus.
export const anchoredFocusOwners = new WeakSet<HTMLElement>();

export function canRestoreFocus(el: HTMLElement | null): el is HTMLElement {
  if (
    !el?.isConnected ||
    el.closest("[hidden], [inert]") ||
    el.getClientRects().length === 0
  )
    return false;
  const { visibility, display } = window.getComputedStyle(el);
  return (
    visibility !== "hidden" && visibility !== "collapse" && display !== "none"
  );
}

type Side = "left" | "bottom";
type Point = { left: number; top: number };
type Anchor = Pick<DOMRect, "left" | "right" | "top" | "bottom">;
type Size = Pick<DOMRect, "width" | "height">;

interface LayoutOptions {
  triggerRect: Anchor;
  popRect: Size;
  viewportWidth: number;
  viewportHeight: number;
  preferredSide?: Side;
  gap?: number;
  padding?: number;
  draggedPosition?: Point;
}

export function computeAnchoredPopoverLayout({
  triggerRect: anchor,
  popRect: { width, height },
  viewportWidth,
  viewportHeight,
  preferredSide = "left",
  gap = 8,
  padding = 12,
  draggedPosition,
}: LayoutOptions) {
  const lastLeft = Math.max(padding, viewportWidth - width - padding);
  const lastTop = Math.max(padding, viewportHeight - height - padding);
  let left = anchor.left - width - gap;
  let top = anchor.top;
  if (preferredSide === "bottom") {
    left = anchor.right - width;
    if (
      (left < padding || left > lastLeft) &&
      anchor.left >= padding &&
      anchor.left <= lastLeft
    )
      left = anchor.left;
    top = anchor.bottom + gap;
    const above = anchor.top - height - gap;
    if (top + height > viewportHeight - padding && above >= padding)
      top = above;
  } else if (left < padding) {
    left = anchor.right + gap;
  }
  left = Math.max(padding, Math.min(lastLeft, draggedPosition?.left ?? left));
  top = Math.max(padding, Math.min(lastTop, draggedPosition?.top ?? top));
  return {
    left,
    top,
    maxHeight: Math.max(160, Math.floor(viewportHeight - top - padding)),
    maxWidth: Math.max(200, Math.floor(viewportWidth - padding * 2)),
  };
}

interface PopoverOptions {
  open: boolean;
  triggerRef: RefObject<HTMLElement | null>;
  popoverRef: RefObject<HTMLElement | null>;
  preferredSide?: Side;
  gap?: number;
  padding?: number;
  draggable?: boolean;
  onClose?: () => void;
}

/** Owns the portaled element's fixed geometry for the duration of each open session. */
export function useAnchoredPopover({
  open,
  triggerRef,
  popoverRef,
  preferredSide = "left",
  gap = 8,
  padding = 12,
  draggable = false,
  onClose,
}: PopoverOptions) {
  const surfaceActive = useContext(PopoverSurfaceContext);
  const docSession = useContext(PopoverDocumentSessionContext);
  const openedDocSession = useRef<number | null>(null);
  const surfaceActiveRef = useRef(surfaceActive);
  surfaceActiveRef.current = surfaceActive;
  const restoreFocus = useRef(false);
  const close = useRef(onClose);
  const dismissHidden = useCallback(() => {
    restoreFocus.current = false;
    close.current?.();
  }, []);
  useLayoutEffect(() => {
    close.current = onClose;
  }, [onClose]);
  useLayoutEffect(() => {
    if (open) {
      openedDocSession.current ??= docSession;
      if (!surfaceActive || openedDocSession.current !== docSession)
        dismissHidden();
    } else {
      const trigger = triggerRef.current;
      if (
        surfaceActive &&
        openedDocSession.current === docSession &&
        restoreFocus.current &&
        canRestoreFocus(trigger)
      )
        trigger.focus({ preventScroll: true });
      openedDocSession.current = null;
      restoreFocus.current = false;
    }
  }, [open, surfaceActive, docSession, triggerRef, dismissHidden]);
  const beginDrag =
    useRef<(event: ReactPointerEvent<HTMLElement>) => void>(undefined);

  useLayoutEffect(() => {
    const trigger = triggerRef.current;
    const popup = popoverRef.current;
    if (!open || !popup) return;
    anchoredFocusOwners.add(popup);
    if (!surfaceActive || openedDocSession.current !== docSession) return;
    if (!trigger) {
      dismissHidden();
      return;
    }
    let anchorLost = false;
    let dragged: Point | undefined;
    let endDrag: (() => void) | undefined;
    const position = (anchor: Anchor, size: Size) => {
      const layout = computeAnchoredPopoverLayout({
        triggerRect: anchor,
        popRect: size,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        preferredSide,
        gap,
        padding,
        draggedPosition: dragged,
      });
      Object.assign(popup.style, {
        position: "fixed",
        left: layout.left + "px",
        top: layout.top + "px",
        maxHeight: layout.maxHeight + "px",
        maxWidth: layout.maxWidth + "px",
      });
      if (dragged) dragged = { left: layout.left, top: layout.top };
    };
    let measured = false;
    let retryFrame: number | undefined;
    const measure = () => {
      if (anchorLost) return;
      if (
        !surfaceActiveRef.current ||
        !trigger.isConnected ||
        trigger.closest("[hidden]")
      ) {
        anchorLost = true;
        dismissHidden();
        return;
      }
      const anchor = trigger.getBoundingClientRect();
      if (!anchor.width && !anchor.height) {
        if (!measured) {
          retryFrame ??= requestAnimationFrame(() => {
            retryFrame = undefined;
            measured = true;
            measure();
          });
        } else {
          anchorLost = true;
          dismissHidden();
        }
        return;
      }
      measured = true;
      if (retryFrame !== undefined) {
        cancelAnimationFrame(retryFrame);
        retryFrame = undefined;
      }
      // Lift the previous anchor's height limit before measuring. A growing form or a
      // taller window can then reclaim room above the trigger in the same layout pass.
      popup.style.maxWidth =
        Math.max(200, Math.floor(window.innerWidth - 2 * padding)) + "px";
      popup.style.maxHeight =
        Math.max(160, window.innerHeight - 2 * padding) + "px";
      position(anchor, popup.getBoundingClientRect());
    };
    measure();
    if (anchorLost) return;
    const observer = new ResizeObserver(measure);
    observer.observe(trigger);
    observer.observe(popup);
    // A capped border box need not resize when options are added inside it.
    const content = new MutationObserver(measure);
    content.observe(popup, {
      subtree: true,
      childList: true,
      characterData: true,
    });
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    const outside = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !popup.contains(event.target) &&
        !trigger.contains(event.target) &&
        close.current
      ) {
        // Closing on pointerdown would otherwise unmount a dirty input before
        // the browser delivers its blur commit.
        const focused = document.activeElement;
        if (focused instanceof HTMLElement && popup.contains(focused))
          focused.blur();
        close.current();
      }
    };
    document.addEventListener("pointerdown", outside, true);

    // React may detach the portal (and clear activeElement) before layout cleanup.
    let focusInside = popup.contains(document.activeElement);
    const trackFocus = (event: FocusEvent) => {
      if (popup.isConnected) focusInside = popup.contains(event.target as Node);
    };
    document.addEventListener("focusin", trackFocus, true);

    if (draggable)
      beginDrag.current = (event) => {
        if (
          event.button !== 0 ||
          endDrag ||
          (event.target as Element).closest(
            "button, input, select, textarea, a",
          )
        )
          return;
        event.preventDefault();
        const handle = event.currentTarget;
        const id = event.pointerId;
        const rect = popup.getBoundingClientRect();
        dragged = { left: rect.left, top: rect.top };
        let x = event.clientX,
          y = event.clientY;
        const move = (next: PointerEvent) => {
          if (next.pointerId !== id || !dragged) return;
          dragged.left += next.clientX - x;
          dragged.top += next.clientY - y;
          x = next.clientX;
          y = next.clientY;
          // Integrate from the last clamped position so reversing a single pixel
          // at any edge moves the panel immediately.
          position(
            trigger.getBoundingClientRect(),
            popup.getBoundingClientRect(),
          );
        };
        const finish = (next: PointerEvent) => {
          if (next.pointerId === id) endDrag?.();
        };
        endDrag = () => {
          handle.removeEventListener("pointermove", move);
          handle.removeEventListener("pointerup", finish);
          handle.removeEventListener("pointercancel", finish);
          handle.removeEventListener("lostpointercapture", finish);
          if (handle.hasPointerCapture(id)) handle.releasePointerCapture(id);
          endDrag = undefined;
        };
        handle.setPointerCapture(id);
        handle.addEventListener("pointermove", move);
        handle.addEventListener("pointerup", finish);
        handle.addEventListener("pointercancel", finish);
        handle.addEventListener("lostpointercapture", finish);
      };

    return () => {
      if (retryFrame !== undefined) cancelAnimationFrame(retryFrame);
      endDrag?.();
      beginDrag.current = undefined;
      observer.disconnect();
      content.disconnect();
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("focusin", trackFocus, true);
      restoreFocus.current =
        surfaceActiveRef.current && focusInside && !anchorLost;
    };
  }, [
    open,
    surfaceActive,
    docSession,
    triggerRef,
    popoverRef,
    preferredSide,
    gap,
    padding,
    draggable,
    dismissHidden,
  ]);

  return {
    onDragPointerDown: (event: ReactPointerEvent<HTMLElement>) =>
      beginDrag.current?.(event),
  };
}
