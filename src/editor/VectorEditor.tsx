import { displayColor } from "../domain/color-profile";
import {
  useLayoutEffect,
  useCallback,
  useMemo,
  useRef,
  useState,
  type PointerEvent as Pointer,
} from "react";
import {
  Check,
  CornerUpLeft,
  GitCommitHorizontal,
  GitBranch,
  Minus,
  Plus,
  Spline,
} from "lucide-react";
import type { EditorController } from "./useEditor";
import { createNode, type DesignNode } from "../domain/document";
import { findLayer } from "../domain/scene-index";
import {
  contains,
  type Point,
  type Rect,
  type Viewport,
} from "../domain/geometry";
import {
  identity,
  inverse,
  localTransform,
  transform,
  vector,
  type Matrix,
} from "../domain/transforms";
import {
  allAnchors,
  anchorKey,
  bendSegment,
  branchVector,
  editablePaths,
  encodeVector,
  mapContours,
  moveNetworkAnchors,
  nearestSegmentPoint,
  pathData,
  removeNetworkAnchors,
  sameAnchor,
  splitSegment,
  toggleAnchorsSmooth,
  vectorBounds,
  type AnchorIndex,
  type EditablePath,
  type SegmentHit,
} from "../domain/vector-path";

type Handle = "anchor" | "incoming" | "outgoing";
interface PointerTrack {
  start: Point;
  current: Point;
  pointer: number;
}
interface MarqueeDrag extends PointerTrack {
  kind: "marquee";
  additive: boolean;
  baseSelection: AnchorIndex[];
}
interface GeometryDrag extends PointerTrack {
  before: EditablePath[];
  preview?: EditablePath[];
}
interface AnchorDrag extends GeometryDrag {
  kind: "anchor";
  pick: AnchorIndex;
  handle: Handle;
  selected: AnchorIndex[];
  onClick: AnchorIndex[];
  mirror: boolean;
  previousDraft?: { paths: EditablePath[]; selection: AnchorIndex[] };
}
interface BendDrag extends GeometryDrag {
  kind: "bend";
  hit: SegmentHit;
}
type Drag = MarqueeDrag | AnchorDrag | BendDrag;

export function normalizeMarqueeRect(start: Point, end: Point): Rect {
  return {
    x: Math.min(start.x, end.x),
    y: Math.min(start.y, end.y),
    width: Math.abs(end.x - start.x),
    height: Math.abs(end.y - start.y),
  };
}

export function resolveAnchorClickSelection(
  selected: AnchorIndex[],
  pick: AnchorIndex,
  shift: boolean,
) {
  const included = selected.some((at) => sameAnchor(at, pick));
  const onDown = included ? selected : shift ? [...selected, pick] : [pick];
  const onClick = !shift
    ? [pick]
    : included
      ? selected.filter((at) => !sameAnchor(at, pick))
      : onDown;
  return { onDown, onClick };
}

export function segmentPreviewPathData(
  paths: EditablePath[],
  { p, c, index }: Pick<SegmentHit, "p" | "c" | "index">,
) {
  const contour = paths[p]?.contours[c];
  if (!contour || contour.anchors.length < 2) return "";
  const a = contour.anchors[index];
  const b =
    contour.anchors[index + 1] ?? (contour.closed && contour.anchors[0]);
  return a && b ? pathData([{ closed: false, anchors: [a, b] }]) : "";
}

function validMatrix(m: DOMMatrix | null | undefined): m is DOMMatrix {
  if (!m) return false;
  const det = m.a * m.d - m.b * m.c;
  return (
    [m.a, m.b, m.c, m.d, m.e, m.f, det].every(Number.isFinite) && det !== 0
  );
}
function screenMatrix(element: SVGGraphicsElement | null | undefined) {
  if (!element?.isConnected || !element.getClientRects().length) return null;
  const matrix = element.getScreenCTM();
  return validMatrix(matrix) ? matrix : null;
}
const newPaths = (): EditablePath[] => [
  { fill: false, strokeWidth: 2, contours: [{ anchors: [], closed: false }] },
];
interface Props {
  panning: boolean;
  editor: Pick<
    EditorController,
    | "doc"
    | "committed"
    | "historyRef"
    | "previewRef"
    | "hasPreview"
    | "tabActive"
    | "activeEditHandlerRef"
    | "setCanUndoDraft"
    | "tool"
    | "apply"
    | "attempt"
    | "setSelection"
  >;
  node?: DesignNode;
  worldContainer?: HTMLElement | null;
  box?: Rect;
  viewport: Viewport;
  parentAt: (p: Point) => { id: string | null; box?: Rect; matrix: Matrix };
  close: () => void;
}
export function VectorEditor({
  editor: e,
  node: target,
  worldContainer,
  box,
  viewport,
  parentAt,
  close,
  panning,
}: Props) {
  const committedBase = e.committed;
  const node = target ? findLayer(committedBase, target.id) : undefined;
  const blocked =
    !e.tabActive ||
    e.hasPreview ||
    e.doc !== committedBase ||
    (!!target && !node?.vector);
  const canEditNow = () =>
    !blocked &&
    e.previewRef.current === null &&
    e.historyRef.current.present === committedBase;
  const root = useRef<SVGSVGElement>(null),
    group = useRef<SVGGElement>(null);
  const original = useMemo(
    () => (node?.vector ? editablePaths(node.vector) : newPaths()),
    [node?.vector],
  );
  const [working, setWorking] = useState<EditablePath[] | null>(null),
    paths = working ?? original;
  const [selected, select] = useState<AnchorIndex[]>([]);
  const primarySelected = selected.at(-1) ?? null;
  const selectedKeys = useMemo(
    () => new Set(selected.map(anchorKey)),
    [selected],
  );
  const isAnchorSelected = (target: AnchorIndex) =>
    selectedKeys.has(anchorKey(target));
  const [branching, setBranching] = useState(false);
  const [bendMode, setBendMode] = useState(false);
  const [altPressed, setAltPressed] = useState(false);
  const effectiveBend = Boolean(node) && !branching && (bendMode || altPressed);
  const [hoveredSegment, setHoveredSegment] = useState<SegmentHit | null>(null);
  const hoverClient = useRef<Pick<Pointer, "clientX" | "clientY"> | null>(null);
  const [marquee, setMarquee] = useState<Rect | null>(null);
  const [cursor, setCursor] = useState<Point | null>(null);
  const drag = useRef<Drag | null>(null);
  const parent = useRef<ReturnType<Props["parentAt"]> | null>(null);
  const layerSvg = useCallback(() => {
    const world =
      worldContainer ??
      root.current?.closest(".editor-canvas")?.querySelector(".canvas-world");
    return (
      node &&
      world?.querySelector<SVGSVGElement>(
        '[data-node-id="' + CSS.escape(node.id) + '"] > svg[viewBox]',
      )
    );
  }, [worldContainer, node]);
  const [layerMatrix, setLayerMatrix] = useState<Matrix | null>(null);
  const matrixReady = !node || layerMatrix !== null;
  const matrix = node
    ? (layerMatrix ?? identity)
    : {
        ...identity,
        a: viewport.zoom,
        d: viewport.zoom,
        e: viewport.x,
        f: viewport.y,
      };
  useLayoutEffect(() => {
    if (!node || blocked) return;
    const svg = layerSvg();
    function sync() {
      const local = screenMatrix(root.current),
        paint = screenMatrix(svg);
      const next = local && paint ? local.inverse().multiply(paint) : null;
      setLayerMatrix(validMatrix(next) ? next : null);
    }
    sync();
    if (!svg) return;
    const observer = new ResizeObserver(sync);
    observer.observe(svg);
    return () => observer.disconnect();
  }, [node, layerSvg, viewport, box, blocked]);
  const unit = 1 / Math.max(0.001, Math.hypot(matrix.a, matrix.b));
  function point(ev: Pick<Pointer, "clientX" | "clientY">) {
    const screen = node
      ? screenMatrix(root.current) && screenMatrix(layerSvg())
      : group.current?.getScreenCTM();
    return matrixReady && validMatrix(screen)
      ? transform(screen.inverse(), { x: ev.clientX, y: ev.clientY })
      : null;
  }
  function localPoint(ev: Pick<Pointer, "clientX" | "clientY">) {
    const screen = screenMatrix(root.current);
    return (
      screen && transform(screen.inverse(), { x: ev.clientX, y: ev.clientY })
    );
  }
  function commit(next: EditablePath[]) {
    if (!canEditNow() || !node || !box || !node.vector) return;
    if (
      !matrixReady ||
      !screenMatrix(layerSvg()) ||
      !screenMatrix(root.current)
    ) {
      setWorking(null);
      return;
    }
    const container = findLayer(committedBase, node.parentId);
    const inFlow =
      container?.type === "frame" &&
      container.style.layout !== "free" &&
      !node.style.absolutePosition;
    const v = node.vector;
    const b = vectorBounds(next, inFlow ? 0 : 1);
    const { radial: _radial, ...preserved } = v;
    let viewBox = b;
    let style: Partial<DesignNode["style"]> | undefined;
    if (inFlow) {
      // Layout owns the box. Keep path coordinates in its original viewBox.
      viewBox = { x: 0, y: 0, width: v.width, height: v.height };
      if (
        b.x < 0 ||
        b.y < 0 ||
        b.x + b.width > v.width ||
        b.y + b.height > v.height
      )
        preserved.overflowVisible = true;
    } else {
      const s = Math.min(box.width / v.width, box.height / v.height);
      const sx = v.stretch ? box.width / v.width : s,
        sy = v.stretch ? box.height / v.height : s;
      const width = b.width * sx,
        height = b.height * sy;
      const shift = vector(localTransform(node, box), {
        x: (b.x + (b.width - v.width) / 2) * sx,
        y: (b.y + (b.height - v.height) / 2) * sy,
      });
      style = {
        x: node.style.x + shift.x + (box.width - width) / 2,
        y: node.style.y + shift.y + (box.height - height) / 2,
        width: Math.max(1, width),
        height: Math.max(1, height),
        widthMode: "fixed",
        heightMode: "fixed",
      };
    }
    e.apply([
      {
        type: "update",
        id: node.id,
        patch: { vector: { ...preserved, ...encodeVector(next, viewBox) } },
        style,
      },
    ]);
    setWorking(null);
  }
  function finish(closed: boolean) {
    if (!canEditNow()) return;
    if (node) {
      close();
      return;
    }
    if (paths[0].contours[0].anchors.length < 2) {
      close();
      return;
    }
    const host = parent.current!,
      m = inverse(host.matrix);
    const contours = mapContours([{ ...paths[0].contours[0], closed }], (p) =>
      transform(m, p),
    );
    const next = [{ ...paths[0], contours, fill: closed }],
      b = vectorBounds(next);
    const n = createNode("vector", host.id);
    n.name = "矢量路径";
    n.vector = encodeVector(next, b);
    Object.assign(n.style, {
      x: b.x - (host.box?.x ?? 0),
      y: b.y - (host.box?.y ?? 0),
      width: b.width,
      height: b.height,
      padding: 0,
    });
    e.apply([{ type: "create", node: n }]);
    e.setSelection([n.id]);
    close();
  }
  const editingNode = Boolean(node);
  const cancelGesture = useCallback(() => {
    const track = drag.current;
    drag.current = null;
    if (track && root.current?.hasPointerCapture(track.pointer))
      root.current.releasePointerCapture(track.pointer);
    if (track && editingNode) setWorking(null);
    else if (track?.kind === "anchor" && track.previousDraft) {
      setWorking(track.previousDraft.paths);
      select(track.previousDraft.selection);
    }
    hoverClient.current = null;
    setHoveredSegment(null);
    setMarquee(null);
    setCursor(null);
    setAltPressed(false);
  }, [editingNode]);

  useLayoutEffect(() => {
    cancelGesture();
    if (editingNode)
      select((previous) => {
        const valid = previous.filter(
          ({ p, c, a }) => original[p]?.contours[c]?.anchors[a],
        );
        return valid.length === previous.length ? previous : valid;
      });
  }, [original, committedBase, editingNode, e.tool, cancelGesture]);

  useLayoutEffect(() => {
    if (!blocked) return;
    cancelGesture();
    if (e.hasPreview || e.doc !== committedBase) {
      setWorking(null);
      if (!editingNode) select([]);
    }
    setBendMode(false);
    setBranching(false);
  }, [blocked, e.hasPreview, e.doc, committedBase, editingNode, cancelGesture]);

  useLayoutEffect(() => {
    if (panning) cancelGesture();
    window.addEventListener("blur", cancelGesture);
    return () => window.removeEventListener("blur", cancelGesture);
  }, [panning, cancelGesture]);

  function updateHover(pos: Point) {
    const nearAnchor = paths.some((path) =>
      path.contours.some((c) =>
        c.anchors.some((a) => Math.hypot(a.x - pos.x, a.y - pos.y) <= unit * 6),
      ),
    );
    setHoveredSegment(
      nearAnchor ? null : nearestSegmentPoint(paths, pos, unit * 8),
    );
  }
  function changePoint(
    command: "remove" | "split" | "smooth" | "close" | Point,
  ) {
    if (!canEditNow() || !primarySelected || drag.current) return;
    const next = structuredClone(paths);
    if (typeof command === "object")
      moveNetworkAnchors(next, selected, command);
    else if (command === "smooth") toggleAnchorsSmooth(next, selected);
    else if (command === "remove") {
      if (!removeNetworkAnchors(next, selected, Boolean(node))) return;
      select([]);
    } else {
      const { p, c, a } = primarySelected;
      const contour = next[p]?.contours[c];
      if (!contour?.anchors[a]) return;
      if (command === "split") {
        if (
          selected.length !== 1 ||
          (!contour.closed && a === contour.anchors.length - 1)
        )
          return;
        splitSegment(contour, a);
      } else {
        if (contour.anchors.length < 3) return;
        contour.closed = !contour.closed;
      }
    }
    setBranching(false);
    setHoveredSegment(null);
    if (node) e.attempt(() => commit(next));
    else setWorking(next.length ? next : newPaths());
  }
  const draftHasAnchors =
    !node && !blocked && paths[0].contours[0].anchors.length > 0;
  useLayoutEffect(() => {
    if (!draftHasAnchors) return;
    e.setCanUndoDraft(true);
    return () => e.setCanUndoDraft(false);
  }, [draftHasAnchors, e.setCanUndoDraft]);

  useLayoutEffect(() => {
    if (blocked) return;
    const handlers = {
      selectAll() {
        if (!canEditNow() || !node) return false;
        cancelGesture();
        setBranching(false);
        select(allAnchors(original));
        return true;
      },
      undo() {
        if (!canEditNow() || !draftHasAnchors) return false;
        cancelGesture();
        const next = structuredClone(paths);
        const anchors = next[0].contours[0].anchors;
        anchors.pop();
        setWorking(next);
        select(anchors.length ? [{ p: 0, c: 0, a: anchors.length - 1 }] : []);
        return true;
      },
    };
    e.activeEditHandlerRef.current = handlers;
    const key = (ev: KeyboardEvent) => {
      if (!canEditNow() || ev.defaultPrevented || ev.isComposing) return;
      if (
        (ev.target as Element)?.closest?.(
          "input,textarea,select,[contenteditable=true],[role=dialog],.canvas-minimap",
        )
      )
        return;
      if (node && ev.key === "Alt") {
        setAltPressed(true);
        if (!drag.current && hoverClient.current && !branching && !panning) {
          const pos = point(hoverClient.current);
          if (pos) updateHover(pos);
        }
        return;
      }
      if ((ev.metaKey || ev.ctrlKey) && !ev.altKey && !ev.shiftKey) {
        const command = ev.key.toLowerCase();
        if (
          (command === "a" && handlers.selectAll()) ||
          (command === "z" && handlers.undo())
        ) {
          ev.preventDefault();
          ev.stopImmediatePropagation();
        }
        return;
      }
      if (ev.metaKey || ev.ctrlKey || (ev.altKey && ev.key !== "Escape"))
        return;
      const arrow = ev.key.startsWith("Arrow");
      if (
        !arrow &&
        !["Escape", "Enter", "Backspace", "Delete"].includes(ev.key)
      )
        return;
      ev.preventDefault();
      ev.stopImmediatePropagation();
      if (ev.key === "Escape") {
        cancelGesture();
        if (bendMode) {
          setBendMode(false);
          return;
        }
        if (branching) {
          setBranching(false);
          return;
        }
        close();
        return;
      }
      if (drag.current) return;
      if (ev.key === "Enter") {
        e.attempt(() => finish(false));
        return;
      }
      if (arrow) {
        if (!matrixReady) return;
        const d = (ev.shiftKey ? 10 : 1) * viewport.zoom;
        changePoint(
          vector(inverse(matrix), {
            x: ev.key === "ArrowRight" ? d : ev.key === "ArrowLeft" ? -d : 0,
            y: ev.key === "ArrowDown" ? d : ev.key === "ArrowUp" ? -d : 0,
          }),
        );
      } else changePoint("remove");
    };
    const keyUp = (ev: KeyboardEvent) => {
      if (ev.key === "Alt") {
        setAltPressed(false);
        if (!bendMode && drag.current?.kind !== "bend") setHoveredSegment(null);
      }
    };
    window.addEventListener("keydown", key, true);
    window.addEventListener("keyup", keyUp, true);
    return () => {
      if (e.activeEditHandlerRef.current === handlers)
        e.activeEditHandlerRef.current = null;
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("keyup", keyUp, true);
    };
  });
  function down(ev: Pointer<SVGSVGElement>) {
    if (!canEditNow() || ev.button !== 0 || panning || drag.current) return;
    ev.preventDefault();
    ev.stopPropagation();
    const pos = point(ev);
    if (!pos) return;
    const el = (ev.target as Element).closest<SVGElement>("[data-anchor]");
    let pick = el
      ? {
          p: Number(el.dataset.path),
          c: Number(el.dataset.contour),
          a: Number(el.dataset.anchor),
        }
      : null;
    let handle = (el?.dataset.handle ?? "anchor") as Handle;
    const pointer = ev.pointerId;
    const start = pos;
    if (node) setAltPressed(ev.altKey);
    if (node && branching && primarySelected) {
      const next = structuredClone(paths);
      const target = handle === "anchor" && pick ? pick : undefined;
      e.attempt(() => {
        branchVector(next, primarySelected, pos, target);
        commit(next);
        setBranching(false);
        select([]);
      });
      return;
    }
    if (node && !branching && (bendMode || ev.altKey) && handle === "anchor") {
      if (pick) {
        const next = structuredClone(paths);
        toggleAnchorsSmooth(next, [pick]);
        select([pick]);
        setHoveredSegment(null);
        e.attempt(() => commit(next));
      } else {
        const hit = nearestSegmentPoint(paths, pos, unit * 10);
        setHoveredSegment(hit);
        if (hit) {
          drag.current = {
            kind: "bend",
            hit,
            before: structuredClone(paths),
            current: pos,
            start,
            pointer,
          };
          ev.currentTarget.setPointerCapture(pointer);
        }
      }
      return;
    }
    if (node && !pick) {
      if (branching || (ev.target as Element).closest(".vector-bend-segment"))
        return;
      const screenStart = localPoint(ev);
      if (!screenStart) return;
      drag.current = {
        kind: "marquee",
        start: screenStart,
        current: screenStart,
        additive: ev.shiftKey,
        baseSelection: selected,
        pointer,
      };
      setMarquee(normalizeMarqueeRect(screenStart, screenStart));
      ev.currentTarget.setPointerCapture(pointer);
      return;
    }
    const next = structuredClone(paths);
    if (!pick) {
      const contour = next[0].contours[0];
      if (!contour.anchors.length) parent.current = parentAt(pos);
      pick = { p: 0, c: 0, a: contour.anchors.length };
      contour.anchors.push(pos);
      handle = "outgoing";
      setWorking(next);
    } else if (
      !node &&
      pick.a === 0 &&
      next[0].contours[0].anchors.length >= 3
    ) {
      e.attempt(() => finish(true));
      return;
    }
    const selection =
      node && handle === "anchor"
        ? resolveAnchorClickSelection(selected, pick, ev.shiftKey)
        : { onDown: [pick], onClick: [pick] };
    select(selection.onDown);
    setHoveredSegment(null);
    let mirror = true;
    if (handle !== "anchor") {
      const anchor = next[pick.p].contours[pick.c].anchors[pick.a];
      const cur = anchor[handle],
        opp = anchor[handle === "incoming" ? "outgoing" : "incoming"];
      if (cur && opp)
        mirror =
          Math.hypot(
            opp.x - (2 * anchor.x - cur.x),
            opp.y - (2 * anchor.y - cur.y),
          ) < Math.max(1.5, unit * 3);
    }
    drag.current = {
      kind: "anchor",
      pick,
      handle,
      selected: selection.onDown,
      onClick: selection.onClick,
      current: pos,
      start,
      pointer,
      before: next,
      mirror,
      previousDraft: node ? undefined : { paths, selection: selected },
    };
    ev.currentTarget.setPointerCapture(pointer);
  }
  function move(ev: Pointer<SVGSVGElement>) {
    const track = drag.current;
    if (!canEditNow() || panning || (track && track.pointer !== ev.pointerId))
      return;
    if (node) setAltPressed(ev.altKey);
    if (!track) {
      if (!node && paths[0].contours[0].anchors.length) setCursor(point(ev));
      if (node) {
        hoverClient.current = (ev.target as Element).closest("[data-anchor]")
          ? null
          : { clientX: ev.clientX, clientY: ev.clientY };
        const pos =
          !branching && (bendMode || ev.altKey) && hoverClient.current
            ? point(ev)
            : null;
        if (pos) updateHover(pos);
        else setHoveredSegment(null);
      }
      return;
    }
    const p = track.kind === "marquee" ? localPoint(ev) : point(ev);
    if (!p) {
      cancelGesture();
      return;
    }
    setCursor(null);
    ev.stopPropagation();
    if (track.kind === "marquee") {
      track.current = p;
      setMarquee(normalizeMarqueeRect(track.start, track.current));
      return;
    }
    previewGeometry(track, p, ev.altKey);
  }
  function previewGeometry(
    track: AnchorDrag | BendDrag,
    p: Point,
    breakMirror: boolean,
  ) {
    track.current = p;
    const delta = { x: p.x - track.start.x, y: p.y - track.start.y };
    if (!track.preview && Math.hypot(delta.x, delta.y) < unit * 2) return;
    const next = structuredClone(track.before);
    if (track.kind === "bend") {
      bendSegment(next, track.hit, {
        x: track.hit.point.x + delta.x,
        y: track.hit.point.y + delta.y,
      });
    } else if (track.handle === "anchor")
      moveNetworkAnchors(next, track.selected, delta);
    else {
      const { p: path, c, a } = track.pick;
      const anchor = next[path].contours[c].anchors[a];
      anchor[track.handle] = p;
      if (!breakMirror && track.mirror)
        anchor[track.handle === "incoming" ? "outgoing" : "incoming"] = {
          x: 2 * anchor.x - p.x,
          y: 2 * anchor.y - p.y,
        };
    }
    track.preview = next;
    setWorking(next);
  }
  function end(ev: Pointer<SVGSVGElement>) {
    const track = drag.current;
    if (!track || track.pointer !== ev.pointerId) return;
    if (!canEditNow()) {
      cancelGesture();
      return;
    }
    ev.stopPropagation();
    drag.current = null;
    if (track.kind === "marquee") {
      setMarquee(null);
      const p = localPoint(ev);
      if (!p || !matrixReady || !screenMatrix(layerSvg())) return;
      if (Math.hypot(p.x - track.start.x, p.y - track.start.y) < 2) {
        if (!track.additive) select([]);
        return;
      }
      const rect = normalizeMarqueeRect(track.start, p);
      const hits = allAnchors(paths).filter(({ p, c, a }) =>
        contains(rect, transform(matrix, paths[p].contours[c].anchors[a])),
      );
      const base = track.baseSelection;
      const keys = new Set(base.map(anchorKey));
      select(
        track.additive
          ? [...base, ...hits.filter((hit) => !keys.has(anchorKey(hit)))]
          : hits,
      );
      return;
    }
    const release = point(ev);
    if (!release) {
      if (node) setWorking(null);
    } else if (release.x !== track.current.x || release.y !== track.current.y) {
      previewGeometry(track, release, ev.altKey);
    }
    setHoveredSegment(null);
    hoverClient.current = null;
    if (release && track.preview && node) {
      const next = track.preview;
      e.attempt(() => commit(next));
      setWorking(null);
    } else if (!track.preview && track.kind === "anchor") select(track.onClick);
  }
  const a =
    primarySelected &&
    paths[primarySelected.p]?.contours[primarySelected.c]?.anchors[
      primarySelected.a
    ];
  const bending = drag.current?.kind === "bend";
  if (blocked) return null;
  return (
    <>
      <svg
        ref={root}
        className="vector-surface"
        aria-label={node ? "矢量编辑" : "钢笔绘制"}
        onPointerLeave={() => {
          hoverClient.current = null;
          setCursor(null);
          if (drag.current?.kind !== "bend") setHoveredSegment(null);
        }}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={end}
        onPointerCancel={(ev) => {
          if (!drag.current || drag.current.pointer === ev.pointerId)
            cancelGesture();
        }}
        onLostPointerCapture={(ev) => {
          if (
            ev.target === ev.currentTarget &&
            drag.current?.pointer === ev.pointerId
          )
            cancelGesture();
        }}
        onDoubleClick={(ev) => {
          ev.stopPropagation();
          if (!node) e.attempt(() => finish(false));
        }}
      >
        <g
          ref={group}
          visibility={matrixReady ? undefined : "hidden"}
          transform={`matrix(${matrix.a} ${matrix.b} ${matrix.c} ${matrix.d} ${matrix.e} ${matrix.f})`}
        >
          {!node && cursor && paths[0].contours[0].anchors.length > 0 && (
            <path
              aria-hidden="true"
              className="pen-guide"
              pointerEvents="none"
              fill="none"
              stroke="#0d99ff"
              strokeWidth={unit}
              d={pathData([
                {
                  closed: false,
                  anchors: [paths[0].contours[0].anchors.at(-1)!, cursor],
                },
              ])}
            />
          )}
          {paths.map((p, j) => (
            <path
              key={j}
              d={pathData(p.contours)}
              fill={
                p.fill
                  ? displayColor(
                      p.fillColor ?? node?.style.color ?? "#161616",
                      e.doc.colorProfile,
                    )
                  : "none"
              }
              fillRule={p.fillRule}
              stroke={
                p.strokeWidth
                  ? displayColor(
                      p.strokeColor ?? node?.style.color ?? "#161616",
                      e.doc.colorProfile,
                    )
                  : "none"
              }
              strokeWidth={p.strokeWidth}
              strokeLinejoin={p.lineJoin ?? "round"}
              opacity={p.opacity}
              fillOpacity={p.fillOpacity}
              strokeOpacity={p.strokeOpacity}
              strokeLinecap={p.lineCap ?? "round"}
            />
          ))}
          {(effectiveBend || bending) && hoveredSegment && (
            <path
              className={
                bending
                  ? "vector-bend-segment is-bending"
                  : "vector-bend-segment"
              }
              data-testid="vector-bend-preview"
              d={segmentPreviewPathData(paths, hoveredSegment)}
              strokeWidth={3 * unit}
              style={{ strokeOpacity: 1 }}
            />
          )}
          {paths.map((p, j) =>
            p.contours.map((c, k) =>
              c.anchors.map((v, i) => {
                const active = isAnchorSelected({ p: j, c: k, a: i });
                return (
                  <circle
                    key={i}
                    className={
                      active && selected.length > 1
                        ? "vector-anchor is-multi-selected"
                        : "vector-anchor"
                    }
                    data-selected={active || undefined}
                    data-path={j}
                    data-contour={k}
                    data-anchor={i}
                    aria-label={"锚点 " + (i + 1)}
                    cx={v.x}
                    cy={v.y}
                    r={4 * unit}
                    fill={active ? "#7159ed" : "white"}
                    stroke="#7159ed"
                    strokeWidth={1.3 * unit}
                  />
                );
              }),
            ),
          )}
          {a &&
            primarySelected &&
            (["incoming", "outgoing"] as const).map(
              (key) =>
                a[key] && (
                  <g key={key}>
                    <line
                      pointerEvents="none"
                      x1={a.x}
                      y1={a.y}
                      x2={a[key].x}
                      y2={a[key].y}
                      stroke="#8670fa"
                      strokeWidth={unit}
                    />
                    <rect
                      data-path={primarySelected.p}
                      data-contour={primarySelected.c}
                      data-anchor={primarySelected.a}
                      data-handle={key}
                      x={a[key].x - 3 * unit}
                      y={a[key].y - 3 * unit}
                      width={6 * unit}
                      height={6 * unit}
                      transform={`rotate(45 ${a[key].x} ${a[key].y})`}
                      fill="white"
                      stroke="#7159ed"
                      strokeWidth={unit}
                    />
                  </g>
                ),
            )}
        </g>
        {marquee && (
          <rect
            className="vector-marquee-rect"
            data-testid="vector-marquee"
            {...marquee}
          />
        )}
      </svg>
      <div
        className="vector-tools"
        onPointerDown={(ev) => ev.stopPropagation()}
      >
        {node && (
          <>
            <button
              className="icon-btn icon-btn-sm"
              aria-label="弯曲工具"
              data-tip="弯曲工具"
              data-tip-desc="拖动曲线段直接拉弯，点击锚点切换平滑或尖角（按住 ⌥ 临时启用）"
              aria-pressed={bendMode}
              onClick={() => {
                cancelGesture();
                setBranching(false);
                setBendMode(!bendMode);
              }}
            >
              <Spline size={15} />
            </button>
            <button
              className="icon-btn icon-btn-sm"
              title="从锚点连接分支"
              aria-label="从锚点连接分支"
              aria-pressed={branching}
              disabled={selected.length !== 1}
              data-tip="从锚点连接分支"
              data-tip-desc="点击空白处延伸，或点击同一区域的不相邻锚点分区"
              onClick={() => {
                cancelGesture();
                setBendMode(false);
                setBranching(!branching);
              }}
            >
              <GitBranch size={14} />
            </button>
            <button
              className="icon-btn icon-btn-sm"
              title="插入中点"
              aria-label="插入中点"
              data-tip="插入中点"
              disabled={selected.length !== 1}
              onClick={() => changePoint("split")}
            >
              <Plus size={14} />
            </button>
            <button
              className="icon-btn icon-btn-sm"
              title="删除锚点"
              aria-label="删除锚点"
              data-tip="删除锚点"
              disabled={!selected.length}
              onClick={() => changePoint("remove")}
            >
              <Minus size={14} />
            </button>
            <button
              className="icon-btn icon-btn-sm"
              title="平滑 / 尖角"
              aria-label="平滑 / 尖角"
              data-tip="平滑 / 尖角"
              disabled={!selected.length}
              onClick={() => changePoint("smooth")}
            >
              <GitCommitHorizontal size={15} />
            </button>
            <button
              className="icon-btn icon-btn-sm"
              title="闭合 / 断开"
              aria-label="闭合 / 断开"
              data-tip="闭合 / 断开"
              disabled={!selected.length}
              onClick={() => changePoint("close")}
            >
              <CornerUpLeft size={14} />
            </button>
            {selected.length > 1 && (
              <small
                className="fp-count-pill"
                style={{ alignSelf: "center", whiteSpace: "nowrap" }}
              >
                已选 {selected.length} 点
              </small>
            )}
          </>
        )}
        <button
          className="icon-btn icon-btn-sm"
          title="完成路径 Enter"
          aria-label="完成路径"
          data-tip="完成路径编辑"
          data-tip-kbd="Enter"
          data-tip-side="bottom"
          onClick={() => e.attempt(() => finish(false))}
        >
          <Check size={15} />
        </button>
      </div>
    </>
  );
}
