import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent,
} from "react";
import {
  canEditCornerRadius,
  checkHandleBindingScopes,
  computeCornerRadiusDrag,
  cornerCoordinates,
  getCornerHandleSpecs,
  getNodeCornerRadii,
  type CornerHandleSpec,
  type CornerKey,
  type PaddingSide,
} from "../application/canvas-handles";
import { previewGeometry } from "../application/geometry-preview";
import type { Operation } from "../domain/commands";
import { resolveNode } from "../domain/design-system";
import { findLayer } from "../domain/scene-index";
import type { DesignDocument, DesignNode } from "../domain/document";
import { layoutBounds, type Point, type Rect } from "../domain/geometry";
import {
  inverse,
  sceneTransforms,
  vector,
  type Matrix,
} from "../domain/transforms";
import type { EditorController } from "./useEditor";

export interface CornerRadiusHandlesProps {
  editor: EditorController;
  node: DesignNode;
  box: Rect;
  matrix: Matrix;
  zoom: number;
  onDragActiveChange?(active: boolean): void;
}
type Modifiers = Pick<KeyboardEvent, "altKey" | "shiftKey">;
interface HandleReadout {
  label: string;
  affectedSides?: PaddingSide[];
}
type DragResult = HandleReadout & { operations: Operation[] };
type Calculate = (delta: Point, modifiers: Modifiers) => DragResult;

export function arrowIncrement(key: string, shift: boolean) {
  const step = shift ? 4 : 1;
  if (key === "ArrowLeft" || key === "ArrowUp") return -step;
  if (key === "ArrowRight" || key === "ArrowDown") return step;
  return 0;
}

/** Both overlays share pointer ownership, revision checks and the preview/commit boundary. */
export function useCanvasHandleDrag<T>(
  editor: EditorController,
  nodeId: string,
  zoom: number,
  onDragActiveChange?: (active: boolean) => void,
) {
  const { doc, committed, previewRef, historyRef, setPreview, apply, attempt } =
    editor;
  const bounds = useMemo(() => layoutBounds(committed), [committed]);
  const [active, setActive] = useState<
    (HandleReadout & { target: T; preview: DesignDocument | null }) | null
  >(null);
  const notify = useRef(onDragActiveChange);
  notify.current = onDragActiveChange;
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  const gesture = useRef<{
    button: HTMLButtonElement;
    pointerId: number;
    start: Point;
    inverseMatrix: Matrix;
    delta: Point;
    target: T;
    calculate: Calculate;
    base: DesignDocument;
    preview: DesignDocument | null;
    frame?: number;
    modifiers: Modifiers;
    last?: DragResult;
  } | null>(null);
  const cancel = useCallback(() => {
    const g = gesture.current;
    if (!g) return;
    gesture.current = null;
    if (g.frame !== undefined) cancelAnimationFrame(g.frame);
    if (g.button.hasPointerCapture(g.pointerId))
      g.button.releasePointerCapture(g.pointerId);
    const owned = g.preview;
    if (owned && previewRef.current === owned)
      setPreview((current) => (current === owned ? null : current));
    setActive(null);
    notify.current?.(false);
  }, [previewRef, setPreview]);

  // Another owner can replace our draft between frames, even at the same revision.
  useLayoutEffect(() => {
    const g = gesture.current;
    if (g && (committed !== g.base || doc !== (g.preview ?? g.base))) cancel();
  }, [doc, committed, active, cancel]);

  const commit = useCallback(
    (operations: Operation[], base: DesignDocument) => {
      if (
        operations.length &&
        previewRef.current === null &&
        historyRef.current.present === base
      )
        attempt(() =>
          apply(checkHandleBindingScopes(base, operations), base.revision),
        );
    },
    [apply, attempt, historyRef, previewRef],
  );

  const refresh = useCallback(
    (modifiers: Modifiers, finish = false) => {
      const g = gesture.current;
      if (!g) return;
      if (
        historyRef.current.present !== g.base ||
        previewRef.current !== g.preview
      ) {
        cancel();
        return;
      }
      const next = g.calculate(g.delta, modifiers);
      // Clicking or returning to the grab point must preserve asymmetric values and bindings.
      if (g.delta.x === 0 && g.delta.y === 0) next.operations = [];
      if (finish) {
        cancel();
        commit(next.operations, g.base);
        return;
      }
      if (
        g.last?.label === next.label &&
        g.last.operations.length === next.operations.length
      )
        return;
      attempt(() => {
        try {
          const previous = g.preview;
          const preview = next.operations.length
            ? previewGeometry(
                g.base,
                checkHandleBindingScopes(g.base, next.operations),
              )
            : null;
          if (previous !== preview)
            setPreview((current) => (current === previous ? preview : current));
          g.preview = preview;
          g.last = next;
          setActive({
            target: g.target,
            label: next.label,
            affectedSides: next.affectedSides,
            preview,
          });
        } catch (error) {
          cancel();
          throw error;
        }
      });
    },
    [commit, attempt, cancel, historyRef, previewRef, setPreview],
  );
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (!gesture.current) return;
      if (event.key === "Escape" && event.type === "keydown") {
        event.preventDefault();
        event.stopImmediatePropagation();
        cancel();
      } else if (event.key === "Alt" || event.key === "Shift") {
        gesture.current.modifiers = {
          altKey: event.altKey,
          shiftKey: event.shiftKey,
        };
        refresh(event);
      }
    };
    const capture = { capture: true };
    window.addEventListener("keydown", key, capture);
    window.addEventListener("keyup", key, capture);
    window.addEventListener("blur", cancel);
    return () => {
      window.removeEventListener("keydown", key, capture);
      window.removeEventListener("keyup", key, capture);
      window.removeEventListener("blur", cancel);
      cancel();
    };
  }, [cancel, refresh, nodeId, committed]);
  function begin(
    event: PointerEvent<HTMLButtonElement>,
    target: T,
    calculate: Calculate,
  ) {
    if (
      event.button !== 0 ||
      event.isPrimary === false ||
      gesture.current ||
      previewRef.current !== null ||
      doc !== committed ||
      historyRef.current.present !== committed
    )
      return;
    const matrix = sceneTransforms(committed, bounds).get(nodeId);
    if (!matrix) return;
    event.preventDefault();
    event.stopPropagation();
    const button = event.currentTarget;
    button.focus({ preventScroll: true });
    button.setPointerCapture(event.pointerId);
    gesture.current = {
      button,
      pointerId: event.pointerId,
      target,
      calculate,
      base: committed,
      preview: null,
      modifiers: { altKey: event.altKey, shiftKey: event.shiftKey },
      start: { x: event.clientX, y: event.clientY },
      delta: { x: 0, y: 0 },
      inverseMatrix: inverse(matrix),
    };
    notify.current?.(true);
    refresh(event);
  }
  function pointer(event: PointerEvent<HTMLButtonElement>, finish: boolean) {
    const g = gesture.current;
    if (!g || g.pointerId !== event.pointerId) return;
    event.stopPropagation();
    g.delta = vector(g.inverseMatrix, {
      x: (event.clientX - g.start.x) / zoomRef.current,
      y: (event.clientY - g.start.y) / zoomRef.current,
    });
    g.modifiers = { altKey: event.altKey, shiftKey: event.shiftKey };
    if (finish) refresh(g.modifiers, true);
    else if (g.frame === undefined) {
      g.frame = requestAnimationFrame(() => {
        g.frame = undefined;
        if (gesture.current === g) refresh(g.modifiers);
      });
    }
  }
  function interrupted(event: PointerEvent<HTMLButtonElement>) {
    if (gesture.current?.pointerId === event.pointerId) cancel();
  }
  return {
    active,
    bounds,
    commit: (operations: Operation[]) => {
      if (doc === committed) commit(operations, committed);
    },
    begin,
    events: {
      onPointerMove: (event: PointerEvent<HTMLButtonElement>) =>
        pointer(event, false),
      onPointerUp: (event: PointerEvent<HTMLButtonElement>) =>
        pointer(event, true),
      onPointerCancel: interrupted,
      onLostPointerCapture: interrupted,
      onBlur: cancel,
    },
  };
}

const cornerNames: Record<CornerKey, string> = {
  tl: "左上",
  tr: "右上",
  br: "右下",
  bl: "左下",
};
const cornerHint = "⌥ 单角 · ⇧ 4px";

export function CornerRadiusHandles({
  editor: e,
  node: selected,
  zoom,
  onDragActiveChange,
}: CornerRadiusHandlesProps) {
  const drag = useCanvasHandleDrag<CornerHandleSpec>(
    e,
    selected.id,
    zoom,
    onDragActiveChange,
  );
  const raw = findLayer(e.committed, selected.id);
  const box = drag.bounds.get(selected.id);
  if (!box || !raw || (e.doc !== e.committed && drag.active?.preview !== e.doc))
    return null;
  const node = resolveNode(e.committed, raw);
  if (!canEditCornerRadius(e.committed, node)) return null;
  const radii = getNodeCornerRadii(node);
  // Only our own preview may move a grip. All input calculations use the committed radii.
  const preview = drag.active?.preview;
  const visible = preview && findLayer(preview, raw.id);
  return (
    <>
      {getCornerHandleSpecs(
        visible && preview ? resolveNode(preview, visible) : node,
        box,
        zoom,
      ).map((spec) => {
        const { corner, localPoint } = spec;
        const radius = radii[corner];
        const name = cornerNames[corner];
        const label = name + "圆角";
        const active = drag.active?.target.corner === corner;
        // Anchor to the original radius, independently of the 12-screen-pixel grip inset.
        const visibleRadius = Math.min(radius, spec.maxRadius);
        const anchor = cornerCoordinates(box, corner, {
          x: visibleRadius,
          y: visibleRadius,
        });
        const result = (
          point: Point,
          singleCorner: boolean,
          snapStep?: number,
        ) => {
          const next = computeCornerRadiusDrag({
            node: raw,
            initialRadii: radii,
            box,
            corner,
            localPoint: point,
            singleCorner,
            snapStep,
          });
          const changed = singleCorner
            ? next.value !== radius
            : Object.values(radii).some((r) => r !== next.value);
          return {
            label: (singleCorner ? name + " " : "") + next.value,
            operations: changed ? next.operations : [],
          };
        };
        return (
          <Fragment key={corner}>
            <button
              type="button"
              className={"corner-radius-handle" + (active ? " is-active" : "")}
              data-testid={"corner-handle-" + corner}
              aria-label={`画布${label}手柄`}
              title={label}
              data-tip={label}
              data-tip-desc="拖动调整四角，方向键微调，Esc 取消"
              data-tip-kbd={cornerHint}
              data-tip-side="bottom"
              style={{ left: localPoint.x * zoom, top: localPoint.y * zoom }}
              {...drag.events}
              onPointerDown={(event) =>
                drag.begin(event, spec, (delta, mods) =>
                  result(
                    { x: anchor.x + delta.x, y: anchor.y + delta.y },
                    mods.altKey,
                    mods.shiftKey ? 4 : 1,
                  ),
                )
              }
              onDoubleClick={(event) => event.stopPropagation()}
              onKeyDown={(event) => {
                const step = arrowIncrement(event.key, event.shiftKey);
                if (!step) return;
                event.preventDefault();
                event.stopPropagation();
                if (drag.active) return;
                const value = visibleRadius + step;
                const next = result(
                  cornerCoordinates(box, corner, { x: value, y: value }),
                  event.altKey,
                );
                drag.commit(next.operations);
              }}
            />
            {active && (
              <span
                className="corner-radius-badge"
                data-testid="corner-radius-badge"
                title={cornerHint}
                aria-label={drag.active?.label + " · " + cornerHint}
                style={{
                  left: localPoint.x * zoom + 10,
                  top: localPoint.y * zoom + 10,
                }}
              >
                {drag.active?.label}
              </span>
            )}
          </Fragment>
        );
      })}
    </>
  );
}
