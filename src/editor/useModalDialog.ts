import { useLayoutEffect, useRef } from "react";
/** Isolates modal keyboard input from canvas commands and returns focus on close. */
export function useModalDialog(open: boolean, close: () => void, modal = true) {
  const ref = useRef<HTMLDivElement>(null),
    closeRef = useRef(close);
  closeRef.current = close;
  useLayoutEffect(() => {
    if (!open || !ref.current) return;
    const previous = document.activeElement as HTMLElement | null,
      dialog = ref.current;
    const focusable = () =>
      Array.from(
        dialog.querySelectorAll<HTMLElement>(
          'a[href],button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex="0"]',
        ),
      ).filter((n) => n.getClientRects().length);
    (focusable()[0] ?? dialog).focus();
    const key = (event: KeyboardEvent) => {
      const topModal = Array.from(
        document.querySelectorAll('[aria-modal="true"]'),
      ).at(-1);
      if (
        modal
          ? topModal !== dialog
          : topModal || !dialog.contains(event.target as Node)
      )
        return;
      if (event.isComposing || event.keyCode === 229) return;
      if (
        event.key === "Escape" &&
        !(event.target as HTMLElement)?.closest?.("[data-escape-local]")
      ) {
        event.preventDefault();
        event.stopImmediatePropagation();
        closeRef.current();
      }
      if (modal && event.key === "Tab") {
        const nodes = focusable(),
          first = nodes[0],
          last = nodes.at(-1);
        if (!first) {
          event.preventDefault();
          dialog.focus();
          return;
        }
        if (!dialog.contains(document.activeElement)) {
          event.preventDefault();
          (event.shiftKey ? last : first)?.focus();
        } else if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", key, true);
    return () => {
      document.removeEventListener("keydown", key, true);
      if (previous?.isConnected) previous.focus();
    };
  }, [open, modal]);
  return ref;
}
