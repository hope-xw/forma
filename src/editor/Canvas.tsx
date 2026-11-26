import { ImageCropOverlay } from "./ImageCropOverlay";
import { displayColor } from "../domain/color-profile";
import { resolveNode } from "../domain/design-system";
import { GridHandles } from "./GridHandles";
import { gridDrop } from "../domain/grid-drop";
import { PrototypeWires } from "./PrototypeWires";
import { SmartHandles } from "./SmartHandles";
import {
  ShapeTools,
  MoveToolGroup,
  FrameToolGroup,
  PenToolGroup,
  type ExtendedTool,
} from "./ShapeTools";
import { ViewOptionsMenu, type CanvasViewOptions } from "./ViewOptionsMenu";
import { CommentsCanvasLayer } from "./CommentsOverlay";
import {
  radialVector,
  defaultRadial,
  drawnLine,
  lineEndpoint,
} from "../domain/shape-tools";
import { CanvasRulers } from "./CanvasRulers";
import { InlineTextContext } from "./InlineText";
import { instanceAncestor, instanceOwner } from "../domain/tree";
import {
  useEffect,
  useMemo,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  ImagePlus,
  Ruler,
  Maximize,
  Plus,
  Minus,
  Type,
  Undo2,
  Redo2,
  MessageSquare,
  Sparkles,
  Code2,
  Magnet,
} from "lucide-react";
import { localMasters } from "../domain/component-masters";
import { instantiateComponent } from "../domain/library";
import { OFFICIAL_BUILTIN_LIBRARY_IDS } from "../domain/library-schema";
import {
  createNode,
  type DesignComment,
  type DesignDocument,
} from "../domain/document";
import { transact, type Operation } from "../domain/commands";
import {
  ancestors,
  isContainer,
  isLocked,
  isVisible,
  selectionRoots,
  subtreeIds,
} from "../domain/tree";
import {
  contains,
  createSnapIndex,
  fitViewport,
  intersects,
  layoutBounds,
  resizeRect,
  screenToWorld,
  snapMoveIndexed,
  union,
  zoomAt,
  type Handle,
  type Point,
  type Rect,
  type SnapIndex,
  type Viewport,
} from "../domain/geometry";
import {
  childrenOf,
  findLayer,
  indexPublishedScene,
} from "../domain/scene-index";
import { copySelection, pasteSelection } from "../domain/clipboard";
import type { EditorController, Tool } from "./useEditor";
import { CanvasNode } from "./CanvasNode";
import { previewGeometry } from "../application/geometry-preview";
import { VectorEditor } from "./VectorEditor";
import {
  sceneTransforms,
  visualBounds,
  identity,
  transform,
  vector,
  inverse,
  localTransform,
  degrees,
  poseInParent,
  type Matrix,
} from "../domain/transforms";
interface Props {
  prototypeMode: boolean;
  views: Map<string, Viewport>;
  editor: EditorController;
  contextMenu(x: number, y: number, layers?: string[]): void;
  onPlayFlow?: (frameId: string) => void;
  viewOptions?: CanvasViewOptions;
  onToggleViewOption?(key: keyof CanvasViewOptions): void;
  onToggleUI?(): void;
  uiHidden?: boolean;
  devMode?: boolean;
  onToggleDevMode?(): void;
  comments?: DesignComment[];
  activeCommentId?: string | null;
  onSelectComment?(id: string | null): void;
  onUpdateComments?(comments: DesignComment[]): void;
  onOpenInlineAgent?(): void;
  aiPreviewNodeIds?: ReadonlySet<string>;
  onOpenDesignLint?(): void;
  onImportDesign(file: File): void;
  onOpenNativeDesign?(file: File): void;
}
type DrawTool = Exclude<
  ExtendedTool,
  "select" | "hand" | "pen" | "scale" | "pencil" | "comment"
>;
type Gesture =
  | {
      kind: "rotate";
      base: DesignDocument;
      id: string;
      center: Point;
      parentInverse: Matrix;
      initial: number;
      angle: number;
      operations: Operation[];
    }
  | { kind: "pan"; start: Point; viewport: Viewport }
  | {
      kind: "box";
      start: Point;
      add: string[];
      deep: boolean;
      clickId?: string;
    }
  | {
      kind: "pencil";
      points: Point[];
      parentId: string | null;
    }
  | {
      kind: "draw";
      start: Point;
      parentId: string | null;
      preview?: NonNullable<import("../domain/document").DesignNode["vector"]>;
      type: DrawTool;
      id: string;
    }
  | {
      kind: "drag";
      start: Point;
      base: DesignDocument;
      working: DesignDocument;
      ids: string[];
      originalIds: string[];
      shiftToggleId?: string;
      prefix: Operation[];
      operations: Operation[];
      moved: boolean;
      cache?: {
        geometry: Map<string, Rect>;
        transforms: Map<string, Matrix>;
        nodes: import("../domain/document").DesignNode[];
        initial: Rect;
        snapIndex: SnapIndex;
        parentData: {
          node: import("../domain/document").DesignNode;
          inFlow: boolean;
          parentInv: Matrix;
        }[];
      };
    }
  | {
      kind: "resize";
      start: Point;
      base: DesignDocument;
      ids: string[];
      box: Rect;
      handle: Handle;
      operations: Operation[];
      moved: boolean;
      cache?: {
        geometry: Map<string, Rect>;
        items: import("../domain/document").DesignNode[];
        single: import("../domain/document").DesignNode | null;
        invMatrix: Matrix;
      };
    };
const handles: Handle[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];

function buildPencilVector(rawPoints: Point[]) {
  if (rawPoints.length < 2) return null;
  const pts: Point[] = [rawPoints[0]];
  for (let i = 1; i < rawPoints.length; i++) {
    const prev = pts[pts.length - 1];
    const cur = rawPoints[i];
    if (
      Math.hypot(cur.x - prev.x, cur.y - prev.y) >= 2.5 ||
      i === rawPoints.length - 1
    ) {
      pts.push(cur);
    }
  }
  if (pts.length < 2) return null;
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const p of pts) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  const pad = 2;
  const x = minX - pad;
  const y = minY - pad;
  const width = Math.max(4, Math.min(10000, Math.round(maxX - minX + pad * 2)));
  const height = Math.max(
    4,
    Math.min(10000, Math.round(maxY - minY + pad * 2)),
  );
  const fmt = (v: number) => String(Math.round(v * 10) / 10);
  const rel = pts.map((p) => ({ x: p.x - x, y: p.y - y }));
  let d = `M ${fmt(rel[0].x)} ${fmt(rel[0].y)}`;
  if (rel.length === 2) {
    d += ` L ${fmt(rel[1].x)} ${fmt(rel[1].y)}`;
  } else {
    for (let i = 1; i < rel.length - 1; i++) {
      const mx = (rel[i].x + rel[i + 1].x) / 2;
      const my = (rel[i].y + rel[i + 1].y) / 2;
      d += ` Q ${fmt(rel[i].x)} ${fmt(rel[i].y)} ${fmt(mx)} ${fmt(my)}`;
    }
    const last = rel[rel.length - 1];
    d += ` L ${fmt(last.x)} ${fmt(last.y)}`;
  }
  return {
    rect: { x: Math.round(x), y: Math.round(y), width, height },
    vector: {
      width,
      height,
      paths: [
        {
          d,
          fill: false,
          strokeColor: "#1e293b",
          strokeWidth: 2,
          lineCap: "round" as const,
          lineJoin: "round" as const,
        },
      ],
    },
  };
}

export function Canvas({
  editor: e,
  contextMenu,
  views,
  prototypeMode,
  onPlayFlow,
  viewOptions,
  onToggleViewOption,
  onToggleUI,
  uiHidden = false,
  devMode = false,
  onToggleDevMode,
  comments,
  activeCommentId,
  onSelectComment,
  onUpdateComments,
  onOpenInlineAgent,
  aiPreviewNodeIds,
  onImportDesign,
  onOpenNativeDesign,
}: Props) {
  const currentTool = e.tool as ExtendedTool;
  const selectTool = (next: ExtendedTool) => {
    e.setEditing(null);
    e.setTool(next as Tool);
  };
  const [localViewOpts, setLocalViewOpts] = useState({
    showPixelGrid: false,
    showLayoutGuides: true,
    outlineMode: false,
    showComments: true,
  });
  const [localActiveCommentId, setLocalActiveCommentId] = useState<
    string | null
  >(null);
  const [pencilStroke, setPencilStroke] = useState<Point[] | null>(null);
  const page = e.doc.activePage ?? "first";
  const surface = useRef<HTMLDivElement>(null);
  const assetFile = useRef<HTMLInputElement>(null);
  const [viewport, setViewport] = useState<Viewport>(
    () => views.get(page) ?? { x: 0, y: 0, zoom: 0.7 },
  );
  const [surfaceSize, setSurfaceSize] = useState({ width: 1200, height: 800 });
  const viewRef = useRef(viewport);
  viewRef.current = viewport;
  useLayoutEffect(() => {
    const el = surface.current;
    if (!el) return;
    const sync = () =>
      setSurfaceSize((prev) =>
        prev.width === el.clientWidth && prev.height === el.clientHeight
          ? prev
          : { width: el.clientWidth || 1200, height: el.clientHeight || 800 },
      );
    sync();
    const ro = new ResizeObserver(sync);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const [space, setSpace] = useState(false);
  const spaceRef = useRef(false);
  const gesture = useRef<Gesture | null>(null);
  const [box, setBox] = useState<Rect | null>(null);
  const boxRef = useRef<Rect | null>(null);
  function updateBox(next: Rect | null) {
    boxRef.current = next;
    setBox(next);
  }
  const [guides, setGuides] = useState<{ axis: "x" | "y"; value: number }[]>(
    [],
  );
  const [dropCell, setDropCell] = useState<ReturnType<typeof gridDrop>>();
  const [ghost, setGhost] = useState<Rect | null>(null);
  const [snap, setSnap] = useState(true);
  const [fileDragActive, setFileDragActive] = useState(false);
  const [hover, setHover] = useState<string | null>(null);
  const [alt, setAlt] = useState(false);
  const altRef = useRef(false);
  const [interacting, setInteracting] = useState(false);
  const effectiveViewOptions: CanvasViewOptions = {
    showRulers: viewOptions?.showRulers ?? e.rulers,
    showPixelGrid: viewOptions?.showPixelGrid ?? localViewOpts.showPixelGrid,
    showLayoutGuides:
      viewOptions?.showLayoutGuides ?? localViewOpts.showLayoutGuides,
    outlineMode: viewOptions?.outlineMode ?? localViewOpts.outlineMode,
    snapEnabled: viewOptions?.snapEnabled ?? snap,
    showComments: viewOptions?.showComments ?? localViewOpts.showComments,
  };
  const handleToggleViewOption = (key: keyof CanvasViewOptions) => {
    if (onToggleViewOption) {
      onToggleViewOption(key);
      return;
    }
    if (key === "showRulers") e.perform("rulers");
    else if (key === "snapEnabled") setSnap((s) => !s);
    else
      setLocalViewOpts((prev) => ({
        ...prev,
        [key]: !prev[key as keyof typeof prev],
      }));
  };
  const effectiveComments = comments ?? e.committed.comments ?? [];
  const effectiveActiveCommentId =
    activeCommentId !== undefined ? activeCommentId : localActiveCommentId;
  const handleSelectComment = (id: string | null) => {
    if (onSelectComment) onSelectComment(id);
    else setLocalActiveCommentId(id);
  };
  const handleUpdateComments = (next: DesignComment[]) => {
    if (onUpdateComments) onUpdateComments(next);
    else e.attempt(() => e.apply([{ type: "setComments", comments: next }]));
  };
  const masters = useMemo(
    () => new Set(localMasters(e.doc).map((m) => m.nodeId)),
    [e.doc],
  );
  const bounds = useMemo(() => layoutBounds(e.doc), [e.doc]);
  const roots = useMemo(
    () => selectionRoots(e.doc, e.selection),
    [e.doc, e.selection],
  );
  const matrices = useMemo(
    () => sceneTransforms(e.doc, bounds),
    [e.doc, bounds],
  );
  const tokenVars = useMemo(
    () =>
      Object.fromEntries(
        Object.entries(e.doc.tokens).map(([id, t]) => [
          `--token-${id}`,
          displayColor(t.value, e.doc.colorProfile),
        ]),
      ),
    [e.doc.tokens, e.doc.colorProfile],
  );
  const rootNodes = useMemo(() => childrenOf(e.doc, null), [e.doc]);
  const selectedNode =
    roots.length === 1 ? resolveNode(e.doc, roots[0]) : undefined;
  const selectedMatrix =
    roots.length === 1 ? matrices.get(roots[0].id)! : identity;
  const selectionBox = union(
    roots
      .filter((n) => isVisible(e.doc, n.id))
      .map((n) =>
        roots.length === 1
          ? bounds.get(n.id)!
          : visualBounds(bounds.get(n.id)!, matrices.get(n.id)!),
      ),
  );
  const ready = useRef(false);
  const local = (client: Point) => {
    const rect = surface.current!.getBoundingClientRect();
    return { x: client.x - rect.left, y: client.y - rect.top };
  };
  const world = (client: Point) =>
    screenToWorld(local(client), viewRef.current);
  function setView(next: Viewport) {
    views.set(page, next);
    viewRef.current = next;
    setViewport(next);
  }
  function fit(ids?: string[]) {
    const doc = e.historyRef.current.present;
    const geometry = layoutBounds(doc);
    const transforms = sceneTransforms(doc, geometry);
    const rect = union(
      doc.nodes
        .filter(
          (n) =>
            (ids ? ids.includes(n.id) : n.parentId === null) &&
            isVisible(doc, n.id),
        )
        .map((n) => visualBounds(geometry.get(n.id)!, transforms.get(n.id)!)),
    );
    if (rect && surface.current)
      setView(fitViewport(rect, surface.current.getBoundingClientRect()));
  }
  useLayoutEffect(() => {
    e.api.current = {
      fit,
      zoom: (factor) => {
        const r = surface.current!.getBoundingClientRect();
        setView(
          zoomAt(viewRef.current, viewRef.current.zoom * factor, {
            x: r.width / 2,
            y: r.height / 2,
          }),
        );
      },
      zoom100: () => {
        const r = surface.current!.getBoundingClientRect();
        setView(
          zoomAt(viewRef.current, 1, { x: r.width / 2, y: r.height / 2 }),
        );
      },
      center: () => {
        const r = surface.current!.getBoundingClientRect();
        return screenToWorld(
          { x: r.width / 2, y: r.height / 2 },
          viewRef.current,
        );
      },
    };
    if (!ready.current) {
      ready.current = true;
      if (!views.has(page))
        fit(
          e.selection.length &&
            e.selection.some((id) => e.doc.nodes.some((n) => n.id === id))
            ? e.selection
            : undefined,
        );
    }
  });
  useEffect(() => {
    const element = surface.current!;
    const wheel = (event: WheelEvent) => {
      if (
        (event.target as HTMLElement).closest(
          'textarea,[contenteditable="true"]',
        )
      )
        return;
      event.preventDefault();
      const current = viewRef.current;
      if (event.ctrlKey || event.metaKey)
        setView(
          zoomAt(
            current,
            current.zoom * Math.exp(-event.deltaY * 0.008),
            local({ x: event.clientX, y: event.clientY }),
          ),
        );
      else
        setView({
          ...current,
          x: current.x - (event.shiftKey ? event.deltaY : event.deltaX),
          y: current.y - (event.shiftKey ? 0 : event.deltaY),
        });
    };
    element.addEventListener("wheel", wheel, { passive: false });
    return () => element.removeEventListener("wheel", wheel);
  }, []);
  useEffect(() => {
    const down = (event: KeyboardEvent) => {
      if (document.querySelector('[aria-modal="true"]')) return;
      if (
        event.code === "Space" &&
        !(event.target as HTMLElement).closest(
          'input,textarea,select,button,[contenteditable="true"],[role="dialog"],[role="menu"]',
        )
      ) {
        event.preventDefault();
        spaceRef.current = true;
        setSpace(true);
      }
      if (event.key === "Escape" && gesture.current) {
        gesture.current = null;
        e.setPreview(null);
        updateBox(null);
        setPencilStroke(null);
        setGhost(null);
        setDropCell(undefined);
        setGuides([]);
      } else if (
        event.key === "Escape" &&
        (currentTool === "pencil" ||
          currentTool === "comment" ||
          currentTool === "scale" ||
          currentTool === "section" ||
          currentTool === "slice")
      ) {
        selectTool("select");
      }
    };
    const up = (event: KeyboardEvent) => {
      if (event.code === "Space") {
        spaceRef.current = false;
        setSpace(false);
      }
    };
    const blur = () => {
      spaceRef.current = false;
      setSpace(false);
      gesture.current = null;
      e.setPreview(null);
      updateBox(null);
      setPencilStroke(null);
      setGhost(null);
      setDropCell(undefined);
      setGuides([]);
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", blur);
    };
  }, [e.setPreview, currentTool]);
  function targetId(event: ReactPointerEvent | React.MouseEvent) {
    const direct = (event.target as HTMLElement).closest<HTMLElement>(
      "[data-node-id]",
    )?.dataset.nodeId;
    // Pointer capture retargets click/double-click to the surface. Re-hit-test
    // the painted DOM at the event position rather than losing the text target.
    const hit =
      direct ??
      document
        .elementsFromPoint(event.clientX, event.clientY)
        .map((el) => el.closest<HTMLElement>("[data-node-id]")?.dataset.nodeId)
        .find(Boolean);
    return hit && !isLocked(e.committed, hit) ? hit : null;
  }
  function shallow(id: string, deep: boolean) {
    if (deep) return id;
    const boundary = instanceOwner(e.committed, id);
    if (boundary) return boundary.id;
    const chain = [...ancestors(e.committed, id)]
      .reverse()
      .map((n) => n.id)
      .concat(id);
    if (e.selection.includes(id)) return id;
    const selectedIndex = chain.findIndex((n) => e.selection.includes(n));
    return selectedIndex >= 0
      ? chain[Math.min(selectedIndex + 1, chain.length - 1)]
      : chain[0];
  }
  function sectionParentAt(
    point: Point,
    doc: DesignDocument,
    excluded = new Set<string>(),
    cachedGeometry?: Map<string, Rect>,
    cachedMatrices?: Map<string, Matrix>,
  ) {
    const geometry = cachedGeometry ?? layoutBounds(doc);
    const transforms = cachedMatrices ?? sceneTransforms(doc, geometry);
    let bestId: string | null = null;
    let bestArea = Infinity;
    for (const n of doc.nodes) {
      if (n.type !== "section" || excluded.has(n.id)) continue;
      const rect = geometry.get(n.id);
      if (!rect) continue;
      const m = transforms.get(n.id) ?? identity;
      const localPoint = m === identity ? point : transform(inverse(m), point);
      if (!contains(rect, localPoint)) continue;
      const area = rect.width * rect.height;
      if (area >= bestArea) continue;
      if (isLocked(doc, n.id) || !isVisible(doc, n.id)) continue;
      bestArea = area;
      bestId = n.id;
    }
    return bestId;
  }
  function containerAt(
    point: Point,
    doc: DesignDocument,
    excluded = new Set<string>(),
    cachedGeometry?: Map<string, Rect>,
    cachedMatrices?: Map<string, Matrix>,
    includeSets = false,
  ) {
    const geometry = cachedGeometry ?? layoutBounds(doc);
    const transforms = cachedMatrices ?? sceneTransforms(doc, geometry);
    let bestId: string | null = null;
    let bestArea = Infinity;
    for (const n of doc.nodes) {
      if (
        (n.type !== "frame" &&
          n.type !== "section" &&
          !(includeSets && n.componentSet)) ||
        excluded.has(n.id)
      )
        continue;
      const rect = geometry.get(n.id);
      if (!rect) continue;
      const m = transforms.get(n.id) ?? identity;
      const localPoint = m === identity ? point : transform(inverse(m), point);
      if (!contains(rect, localPoint)) continue;
      const area = rect.width * rect.height;
      if (area >= bestArea) continue;
      if (
        isLocked(doc, n.id) ||
        instanceOwner(doc, n.id) ||
        !isVisible(doc, n.id)
      )
        continue;
      bestArea = area;
      bestId = n.id;
    }
    return bestId;
  }
  function down(event: ReactPointerEvent) {
    if (event.button === 2) return;
    if (
      (event.target as HTMLElement).closest(
        'textarea,[contenteditable="true"],.fp-comments-layer,.fp-comment-popover,.fp-comment-pin',
      )
    )
      return;
    // A click in the unused portion of a text box still belongs to its editor.
    const textLayer =
      e.editing &&
      event.button === 0 &&
      (event.target as Element).closest("[data-editing-text]");
    const input =
      textLayer && textLayer.querySelector<HTMLElement>(".inline-text-editor");
    if (input) {
      event.preventDefault();
      input.focus({ preventScroll: true });
      const caret = document.caretPositionFromPoint?.(
        event.clientX,
        event.clientY,
      );
      const selection = window.getSelection();
      if (caret && input.contains(caret.offsetNode))
        selection?.collapse(caret.offsetNode, caret.offset);
      else {
        selection?.selectAllChildren(input);
        selection?.collapseToEnd();
      }
      return;
    }
    event.preventDefault();
    surface.current?.focus();
    surface.current?.setPointerCapture(event.pointerId);
    const point = world({ x: event.clientX, y: event.clientY });
    if (event.button === 1 || spaceRef.current || currentTool === "hand") {
      gesture.current = {
        kind: "pan",
        start: { x: event.clientX, y: event.clientY },
        viewport: viewRef.current,
      };
      return;
    }
    if (devMode) {
      const directHit = (event.target as HTMLElement).closest<HTMLElement>(
        "[data-node-id]",
      )?.dataset.nodeId;
      const devHit =
        directHit ??
        document
          .elementsFromPoint(event.clientX, event.clientY)
          .map(
            (el) => el.closest<HTMLElement>("[data-node-id]")?.dataset.nodeId,
          )
          .find(Boolean);
      if (devHit) e.setSelection([devHit]);
      else e.setSelection([]);
      return;
    }
    if (currentTool === "comment") {
      const hitNodeId = targetId(event) ?? undefined;
      const created: DesignComment = {
        id: crypto.randomUUID(),
        x: Math.round(point.x),
        y: Math.round(point.y),
        nodeId: hitNodeId,
        author: "设计师",
        text: "请查看此处设计细节",
        createdAt: new Date().toISOString(),
        resolved: false,
        replies: [],
      };
      handleUpdateComments([...effectiveComments, created]);
      handleSelectComment(created.id);
      if (!effectiveViewOptions.showComments) {
        handleToggleViewOption("showComments");
      }
      return;
    }
    if (currentTool === "pencil") {
      gesture.current = {
        kind: "pencil",
        points: [point],
        parentId: containerAt(point, e.committed),
      };
      setPencilStroke([point]);
      return;
    }
    if (currentTool === "pen") return;
    if (currentTool !== "select" && currentTool !== "scale") {
      gesture.current = {
        kind: "draw",
        start: point,
        parentId:
          currentTool === "section"
            ? sectionParentAt(point, e.committed)
            : containerAt(point, e.committed),
        type: currentTool,
        id: crypto.randomUUID(),
      };
      updateBox({ x: point.x, y: point.y, width: 0, height: 0 });
      return;
    }
    if (e.cropping) e.setCropping(null);
    const hit = targetId(event);
    const hitNode = hit ? findLayer(e.committed, hit) : undefined;
    if (hitNode && isContainer(hitNode) && (event.metaKey || event.ctrlKey)) {
      gesture.current = {
        kind: "box",
        start: point,
        add: event.shiftKey ? e.selection : [],
        deep: true,
        clickId: hitNode.id,
      };
      updateBox({ x: point.x, y: point.y, width: 0, height: 0 });
      return;
    }
    if (!hit) {
      gesture.current = {
        kind: "box",
        start: point,
        add: event.shiftKey ? e.selection : [],
        deep: event.metaKey || event.ctrlKey,
      };
      if (!event.shiftKey) e.setSelection([]);
      updateBox({ x: point.x, y: point.y, width: 0, height: 0 });
      return;
    }
    const id = shallow(hit, event.metaKey || event.ctrlKey);
    const alreadySelected = e.selection.includes(id);
    const originalIds = alreadySelected
      ? e.selection
      : event.shiftKey
        ? [...e.selection, id]
        : [id];
    let ids = originalIds;
    if (ids.some((selected) => instanceAncestor(e.doc, selected))) {
      if (event.shiftKey && alreadySelected) e.select(id, true);
      else e.setSelection(ids);
      return;
    }
    if (!event.shiftKey || !alreadySelected) e.setSelection(ids);
    let working = e.committed;
    let prefix: Operation[] = [];
    if (event.altKey) {
      try {
        const source = copySelection(working, ids);
        const nodes = selectionRoots(working, ids);
        const parent = nodes.every((n) => n.parentId === nodes[0].parentId)
          ? nodes[0].parentId
          : null;
        const result = pasteSelection(working, source, parent);
        prefix = result.operations;
        working = transact(working, {
          baseRevision: working.revision,
          operations: prefix,
        });
        ids = result.selection;
        e.setSelection(ids);
      } catch (error) {
        e.setError(String(error));
        return;
      }
    }
    gesture.current = {
      kind: "drag",
      start: point,
      base: e.committed,
      working,
      ids: selectionRoots(working, ids).map((n) => n.id),
      originalIds,
      shiftToggleId: event.shiftKey && alreadySelected ? id : undefined,
      prefix,
      operations: prefix,
      moved: false,
    };
  }
  function preview(base: DesignDocument, operations: Operation[]) {
    if (!operations.length) return;
    try {
      e.setPreview(previewGeometry(base, operations));
    } catch (error) {
      e.setError(String(error));
    }
  }
  function move(event: ReactPointerEvent) {
    const state = gesture.current;
    const point = world({ x: event.clientX, y: event.clientY });
    if (!state) {
      if (altRef.current || devMode) {
        const directHit = (event.target as HTMLElement).closest<HTMLElement>(
          "[data-node-id]",
        )?.dataset.nodeId;
        setHover(devMode ? (directHit ?? null) : targetId(event));
      }
      return;
    }
    if (state.kind === "pencil") {
      const prev = state.points[state.points.length - 1];
      if (
        !prev ||
        Math.hypot(point.x - prev.x, point.y - prev.y) >= 2 / viewport.zoom
      ) {
        state.points.push(point);
        setPencilStroke([...state.points]);
      }
      return;
    }
    if (state.kind === "rotate") {
      const p = transform(state.parentInverse, point);
      let rotation = degrees(
        state.initial +
          (Math.atan2(p.y - state.center.y, p.x - state.center.x) * 180) /
            Math.PI -
          state.angle,
      );
      if (event.shiftKey) rotation = Math.round(rotation / 15) * 15;
      state.operations = [
        { type: "update", id: state.id, patch: {}, style: { rotation } },
      ];
      preview(state.base, state.operations);
      return;
    }
    if (state.kind === "pan") {
      setView({
        ...state.viewport,
        x: state.viewport.x + event.clientX - state.start.x,
        y: state.viewport.y + event.clientY - state.start.y,
      });
      return;
    }
    if (state.kind === "box" || state.kind === "draw") {
      if (state.kind === "draw" && state.type === "line") {
        const line = drawnLine(
          state.start,
          lineEndpoint(state.start, point, event.shiftKey),
        );
        state.preview = line.vector;
        updateBox(line.rect);
        return;
      }
      let width = Math.abs(point.x - state.start.x),
        height = Math.abs(point.y - state.start.y);
      if (event.shiftKey && state.kind === "draw")
        width = height = Math.max(width, height);
      const fromCenter = event.altKey && state.kind === "draw";
      const rect = fromCenter
        ? {
            x: state.start.x - width,
            y: state.start.y - height,
            width: width * 2,
            height: height * 2,
          }
        : {
            x: point.x < state.start.x ? state.start.x - width : state.start.x,
            y: point.y < state.start.y ? state.start.y - height : state.start.y,
            width,
            height,
          };
      if (
        state.kind === "draw" &&
        (state.type === "star" || state.type === "polygon") &&
        rect.width > 0 &&
        rect.height > 0
      )
        state.preview = radialVector(
          defaultRadial(state.type),
          rect.width,
          rect.height,
        );
      updateBox(rect);
      return;
    }
    const dx = point.x - state.start.x,
      dy = point.y - state.start.y;
    if (Math.hypot(dx, dy) * viewport.zoom < 2 && !state.moved) return;
    if (!state.moved) setInteracting(true);
    state.moved = true;
    if (state.kind === "resize") {
      if (!state.cache) {
        const geometry = layoutBounds(state.base);
        const items = selectionRoots(state.base, state.ids);
        const single = items.length === 1 ? items[0] : null;
        const matrix = single
          ? sceneTransforms(state.base, geometry).get(single.id)!
          : identity;
        state.cache = {
          geometry,
          items,
          single,
          invMatrix: inverse(matrix),
        };
      }
      const { geometry, items, single, invMatrix } = state.cache;
      const delta = vector(invMatrix, { x: dx, y: dy });
      const rect = resizeRect(
        state.box,
        state.handle,
        delta,
        event.shiftKey,
        event.altKey,
      );
      const sx = rect.width / state.box.width,
        sy = rect.height / state.box.height;
      const operations: Operation[] = [];
      for (const node of items) {
        const b = geometry.get(node.id)!;
        const shift = single
          ? vector(localTransform(node, b), {
              x: rect.x + rect.width / 2 - b.x - b.width / 2,
              y: rect.y + rect.height / 2 - b.y - b.height / 2,
            })
          : null;
        operations.push({
          type: "update",
          id: node.id,
          patch: {},
          style: {
            x:
              node.style.x +
              (shift
                ? shift.x + (b.width - rect.width) / 2
                : rect.x + (b.x - state.box.x) * sx - b.x),
            y:
              node.style.y +
              (shift
                ? shift.y + (b.height - rect.height) / 2
                : rect.y + (b.y - state.box.y) * sy - b.y),
            width: Math.max(1, b.width * sx),
            height: Math.max(1, b.height * sy),
            ...(sx !== 1 && node.style.widthMode
              ? { widthMode: "fixed" as const }
              : {}),
            ...(sy !== 1 && node.style.heightMode
              ? { heightMode: "fixed" as const }
              : {}),
          },
        });
        if (node.type === "group") {
          const descendants = subtreeIds(state.base, [node.id]);
          for (const childId of descendants) {
            if (childId === node.id) continue;
            const child = findLayer(state.base, childId);
            if (!child) continue;
            operations.push({
              type: "update",
              id: child.id,
              patch: {},
              style: {
                x: child.style.x * sx,
                y: child.style.y * sy,
                width: Math.max(1, child.style.width * sx),
                height: Math.max(1, child.style.height * sy),
                fontSize: Math.min(
                  500,
                  Math.max(1, child.style.fontSize * Math.min(sx, sy)),
                ),
              },
            });
          }
        }
      }
      state.operations = operations;
      preview(state.base, operations);
      return;
    }
    if (!state.cache) {
      indexPublishedScene(state.working);
      const geometry = layoutBounds(state.working),
        nodes = selectionRoots(state.working, state.ids);
      const transforms = sceneTransforms(state.working, geometry);
      const initial = union(
        nodes.map((n) =>
          visualBounds(geometry.get(n.id)!, transforms.get(n.id)!),
        ),
      )!;
      const excluded = subtreeIds(state.working, state.ids);
      const scopeRoots = new Set<string | null>();
      for (const node of nodes) {
        const chain = ancestors(state.working, node.id);
        scopeRoots.add(chain.length ? chain[chain.length - 1].id : null);
      }
      const candidates: import("../domain/document").DesignNode[] = [];
      if (state.working.nodes.length <= 400 || scopeRoots.has(null)) {
        for (const root of childrenOf(state.working, null)) {
          if (excluded.has(root.id) || !isVisible(state.working, root.id))
            continue;
          candidates.push(root);
          if (state.working.nodes.length <= 400) {
            const stack = [...childrenOf(state.working, root.id)];
            while (stack.length) {
              const cur = stack.pop()!;
              if (excluded.has(cur.id) || cur.hidden) continue;
              candidates.push(cur);
              for (const c of childrenOf(state.working, cur.id)) stack.push(c);
            }
          }
        }
      } else {
        for (const root of childrenOf(state.working, null)) {
          if (excluded.has(root.id) || root.hidden) continue;
          candidates.push(root);
          if (scopeRoots.has(root.id)) {
            const stack = [...childrenOf(state.working, root.id)];
            while (stack.length) {
              const cur = stack.pop()!;
              if (excluded.has(cur.id) || cur.hidden) continue;
              candidates.push(cur);
              for (const c of childrenOf(state.working, cur.id)) stack.push(c);
            }
          }
        }
      }
      const targets = candidates.map((n) =>
        visualBounds(geometry.get(n.id)!, transforms.get(n.id)!),
      );
      const snapIndex = createSnapIndex(
        targets,
        effectiveViewOptions.showRulers ? (state.working.guides ?? []) : [],
      );
      const parentData = nodes.map((node) => {
        const parent = findLayer(state.working, node.parentId);
        return {
          node,
          inFlow: parent?.type === "frame" && parent.style.layout !== "free",
          parentInv: inverse(parent ? transforms.get(parent.id)! : identity),
        };
      });
      state.cache = {
        geometry,
        transforms,
        nodes,
        initial,
        snapIndex,
        parentData,
      };
    }
    const { initial, snapIndex, parentData } = state.cache;
    let delta = { x: dx, y: dy };
    if (event.shiftKey)
      delta = Math.abs(dx) > Math.abs(dy) ? { x: dx, y: 0 } : { x: 0, y: dy };
    if (effectiveViewOptions.snapEnabled && !event.metaKey && !event.ctrlKey) {
      const result = snapMoveIndexed(
        { ...initial, x: initial.x + delta.x, y: initial.y + delta.y },
        snapIndex,
        5 / viewport.zoom,
      );
      const allowX = !event.shiftKey || Math.abs(dx) > Math.abs(dy);
      const allowY = !event.shiftKey || !allowX;
      if (allowX) delta.x += result.dx;
      if (allowY) delta.y += result.dy;
      const nextGuides = result.guides.filter((g) =>
        g.axis === "x" ? allowX : allowY,
      );
      setGuides((prev) =>
        prev.length === 0 && nextGuides.length === 0 ? prev : nextGuides,
      );
    } else setGuides((prev) => (prev.length === 0 ? prev : []));
    const operations: Operation[] = [...state.prefix];
    let flow = false;
    for (const { node, inFlow, parentInv } of parentData) {
      if (inFlow) {
        flow = true;
        continue;
      }
      const movement = vector(parentInv, delta);
      operations.push({
        type: "update",
        id: node.id,
        patch: {},
        style: {
          x: Math.round(node.style.x + movement.x),
          y: Math.round(node.style.y + movement.y),
        },
      });
    }
    const gridParent =
      parentData.length === 1 &&
      findLayer(state.working, parentData[0].node.parentId);
    setDropCell(
      gridParent && gridParent.style.layout === "grid"
        ? gridDrop(
            state.working,
            gridParent,
            point,
            state.cache.geometry,
            state.cache.transforms.get(gridParent.id) ?? identity,
          )
        : undefined,
    );
    setGhost((prev) =>
      flow
        ? { ...initial, x: initial.x + delta.x, y: initial.y + delta.y }
        : prev === null
          ? prev
          : null,
    );
    state.operations = operations;
    preview(state.base, operations);
  }
  function end(event: ReactPointerEvent, cancel = false) {
    const state = gesture.current;
    gesture.current = null;
    setInteracting(false);
    setGuides([]);
    setGhost(null);
    setDropCell(undefined);
    setPencilStroke(null);
    e.setPreview(null);
    const point = world({ x: event.clientX, y: event.clientY });
    const drawn = boxRef.current;
    updateBox(null);
    if (!state || cancel) return;
    e.attempt(() => {
      if (state.kind === "pencil") {
        const built = buildPencilVector(state.points);
        if (!built) return;
        const node = createNode("vector", state.parentId);
        node.name = "铅笔路径";
        node.vector = built.vector;
        const parent = state.parentId
          ? layoutBounds(e.committed).get(state.parentId)
          : null;
        const posed = poseInParent(
          node,
          built.rect,
          identity,
          parent ?? undefined,
          matrices.get(state.parentId ?? "") ?? identity,
        );
        Object.assign(node.style, {
          ...posed,
          x: Math.round(posed.x),
          y: Math.round(posed.y),
          width: built.rect.width,
          height: built.rect.height,
        });
        e.apply([{ type: "create", node }]);
        e.setSelection([node.id]);
        return;
      }
      if (state.kind === "rotate" && state.operations.length)
        e.apply(state.operations, state.base.revision);
      if (state.kind === "box" && drawn) {
        if (state.clickId && drawn.width < 3 && drawn.height < 3) {
          e.select(state.clickId, !!state.add.length);
          return;
        }
        const layout = layoutBounds(e.committed),
          matrices = sceneTransforms(e.committed, layout);
        const geometry = new Map(
          [...layout].map(([id, r]) => [
            id,
            visualBounds(r, matrices.get(id)!),
          ]),
        );
        const context =
          e.selected.length === 1 && isContainer(e.selected[0])
            ? e.selected[0].id
            : null;
        const ids = e.committed.nodes
          .filter(
            (n) =>
              (state.deep || n.parentId === context) &&
              !isLocked(e.committed, n.id) &&
              isVisible(e.committed, n.id) &&
              intersects(drawn, geometry.get(n.id)!) &&
              (!state.deep ||
                !isContainer(n) ||
                (contains(drawn, geometry.get(n.id)!) &&
                  contains(drawn, {
                    x: geometry.get(n.id)!.x + geometry.get(n.id)!.width,
                    y: geometry.get(n.id)!.y + geometry.get(n.id)!.height,
                  }))),
          )
          .map((n) => n.id);
        e.setSelection([...new Set([...state.add, ...ids])]);
      }
      if (state.kind === "draw") {
        const kind = state.type;
        const node = createNode(
          kind === "polygon" || kind === "star" || kind === "line"
            ? "vector"
            : kind,
          state.parentId,
        );
        node.id = state.id;
        const parent = state.parentId
          ? layoutBounds(e.committed).get(state.parentId)
          : null;
        const dragged = !!(drawn && drawn.width > 3 && drawn.height > 3);
        let rect = dragged
          ? {
              x: Math.round(drawn!.x),
              y: Math.round(drawn!.y),
              width: Math.max(1, Math.round(drawn!.width)),
              height: Math.max(1, Math.round(drawn!.height)),
            }
          : {
              x: Math.round(state.start.x),
              y: Math.round(state.start.y),
              width: node.style.width,
              height: node.style.height,
            };
        if (kind === "polygon" || kind === "star") {
          if (!dragged) rect = { ...rect, width: 100, height: 100 };
          node.name = kind === "star" ? "星形" : "多边形";
          node.vector = radialVector(
            defaultRadial(kind),
            rect.width,
            rect.height,
          );
        }
        if (kind === "line") {
          const moved =
            Math.hypot(point.x - state.start.x, point.y - state.start.y) *
              viewport.zoom >
            3;
          const end = moved
            ? lineEndpoint(state.start, point, event.shiftKey)
            : { x: state.start.x + 100, y: state.start.y };
          const line = drawnLine(state.start, end);
          node.name = "直线";
          node.vector = line.vector;
          rect = line.rect;
        }
        const posed = poseInParent(
          node,
          rect,
          identity,
          parent ?? undefined,
          matrices.get(state.parentId ?? "") ?? identity,
        );
        Object.assign(node.style, {
          ...posed,
          x: Math.round(posed.x),
          y: Math.round(posed.y),
          width: Math.max(1, Math.round(rect.width)),
          height: Math.max(1, Math.round(rect.height)),
          ...(kind === "text" && !dragged
            ? { widthMode: "hug" as const, heightMode: "hug" as const }
            : {}),
        });
        e.apply([{ type: "create", node }]);
        e.setSelection([node.id]);
        e.setTool("select");
        if (node.type === "text")
          requestAnimationFrame(() => e.setEditing(node.id));
      }
      if (state.kind === "resize" && state.moved)
        e.apply(state.operations, state.base.revision);
      if (state.kind === "drag") {
        if (!state.moved) {
          if (state.prefix.length) e.setSelection(state.originalIds);
          else if (state.shiftToggleId) e.select(state.shiftToggleId, true);
          return;
        }
        const operations = [...state.operations];
        const geometry = state.cache?.geometry ?? layoutBounds(state.working);
        const transforms =
          state.cache?.transforms ?? sceneTransforms(state.working, geometry);
        const nodes =
          state.cache?.nodes ?? selectionRoots(state.working, state.ids);
        if (state.moved) {
          const target = containerAt(
            point,
            state.working,
            subtreeIds(state.working, state.ids),
            geometry,
            transforms,
            true,
          );
          const parent = findLayer(state.working, target);
          const parentRect = target ? geometry.get(target) : null;
          nodes.forEach((node, i) => {
            if (parent?.componentSet && node.parentId !== parent.id) {
              if (nodes.length !== 1) throw Error("请一次拖入一个变体");
              operations.length = 0;
              operations.push(...state.prefix);
              operations.push({
                type: "includeSetDrawing",
                id: node.id,
                setId: parent.id,
              });
              return;
            }
            const oldParent = findLayer(state.working, node.parentId);
            const isFlow =
              oldParent?.type === "frame" && oldParent.style.layout !== "free";
            // Sections only live at canvas root or inside another section (Figma F06).
            // Root frames remain root frames unless dropped directly into a section.
            const destination =
              node.type === "section"
                ? parent?.type === "section"
                  ? target
                  : sectionParentAt(
                      point,
                      state.working,
                      subtreeIds(state.working, state.ids),
                      geometry,
                      transforms,
                    )
                : node.type === "frame" && !node.parentId
                  ? parent?.type === "section"
                    ? target
                    : null
                  : target;
            if (destination !== node.parentId) {
              operations.push({
                type: "move",
                id: node.id,
                parentId: destination,
              });
              const b = geometry.get(node.id)!;
              operations.push({
                type: "update",
                id: node.id,
                patch: {},
                style: poseInParent(
                  node,
                  b,
                  transforms.get(node.id)!,
                  destination ? (parentRect ?? undefined) : undefined,
                  transforms.get(destination ?? "") ?? identity,
                  { x: point.x - state.start.x, y: point.y - state.start.y },
                ),
              });
            }
            const cell =
              destination &&
              parent &&
              nodes.length === 1 &&
              gridDrop(
                state.working,
                parent,
                point,
                geometry,
                transforms.get(parent.id) ?? identity,
              );
            if (cell) {
              operations.push({
                type: "update",
                id: node.id,
                patch: {},
                style: { gridCell: cell.cell },
              });
            } else if (destination && parent?.style.layout !== "free") {
              const siblings = state.working.nodes.filter(
                (n) => n.parentId === destination && !state.ids.includes(n.id),
              );
              const axis = parent!.style.layout === "row" ? "x" : "y",
                size = axis === "x" ? "width" : "height";
              let index = siblings.findIndex(
                (n) =>
                  point[axis] <
                  geometry.get(n.id)![axis] + geometry.get(n.id)![size] / 2,
              );
              if (index < 0) index = siblings.length;
              operations.push({
                type: "reorder",
                id: node.id,
                index: index + i,
              });
            } else if (isFlow && destination === node.parentId) {
              /* only possible for a changed layout in a rejected revision */
            }
          });
        }
        if (operations.length) e.apply(operations, state.base.revision);
      }
    });
  }
  function beginResize(event: ReactPointerEvent, handle: Handle) {
    event.stopPropagation();
    event.preventDefault();
    if (!selectionBox || roots.some((n) => isLocked(e.doc, n.id))) return;
    surface.current?.setPointerCapture(event.pointerId);
    gesture.current = {
      kind: "resize",
      start: world({ x: event.clientX, y: event.clientY }),
      base: e.committed,
      ids: roots.map((n) => n.id),
      box: selectionBox,
      handle,
      operations: [],
      moved: false,
    };
  }
  const cropNode =
    !prototypeMode &&
    e.cropping &&
    e.selection.length === 1 &&
    e.selection[0] === e.cropping
      ? findLayer(e.committed, e.cropping)
      : undefined;
  const drawing =
    gesture.current?.kind === "draw" ? gesture.current.preview : undefined;
  const scaled = (rect: Rect): CSSProperties => ({
    left: viewport.x + rect.x * viewport.zoom,
    top: viewport.y + rect.y * viewport.zoom,
    width: rect.width * viewport.zoom,
    height: rect.height * viewport.zoom,
  });
  function oriented(rect: Rect, m: Matrix): CSSProperties {
    return {
      ...scaled({ ...rect, ...transform(m, rect) }),
      transformOrigin: "0 0",
      transform: `matrix(${m.a},${m.b},${m.c},${m.d},0,0)`,
    };
  }
  function beginRotate(event: ReactPointerEvent) {
    const n = roots[0],
      b = bounds.get(n.id)!;
    const parentInverse = inverse(
      n.parentId ? matrices.get(n.parentId)! : identity,
    );
    const p = transform(
        parentInverse,
        world({ x: event.clientX, y: event.clientY }),
      ),
      center = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
    event.stopPropagation();
    event.preventDefault();
    surface.current?.setPointerCapture(event.pointerId);
    gesture.current = {
      kind: "rotate",
      base: e.committed,
      id: n.id,
      center,
      parentInverse,
      angle: (Math.atan2(p.y - center.y, p.x - center.x) * 180) / Math.PI,
      initial: n.style.rotation ?? 0,
      operations: [],
    };
  }
  const hoverRect = hover && bounds.get(hover);
  const measure = (() => {
    if (!hoverRect || !selectionBox || !hover || e.selection.includes(hover))
      return null;
    const inside =
      selectionBox.x >= hoverRect.x &&
      selectionBox.y >= hoverRect.y &&
      selectionBox.x + selectionBox.width <= hoverRect.x + hoverRect.width &&
      selectionBox.y + selectionBox.height <= hoverRect.y + hoverRect.height;
    if (inside) {
      return {
        inside: true as const,
        left: selectionBox.x - hoverRect.x,
        right:
          hoverRect.x + hoverRect.width - (selectionBox.x + selectionBox.width),
        top: selectionBox.y - hoverRect.y,
        bottom:
          hoverRect.y +
          hoverRect.height -
          (selectionBox.y + selectionBox.height),
        dx: selectionBox.x - hoverRect.x,
        dy: selectionBox.y - hoverRect.y,
      };
    }
    return {
      inside: false as const,
      dx: Math.max(
        0,
        Math.max(
          hoverRect.x - selectionBox.x - selectionBox.width,
          selectionBox.x - hoverRect.x - hoverRect.width,
        ),
      ),
      dy: Math.max(
        0,
        Math.max(
          hoverRect.y - selectionBox.y - selectionBox.height,
          selectionBox.y - hoverRect.y - hoverRect.height,
        ),
      ),
    };
  })();
  useEffect(() => {
    const update = (event: KeyboardEvent) => {
      altRef.current = event.altKey;
      setAlt(event.altKey);
      if (!event.altKey) setHover(null);
    };
    const clear = () => {
      altRef.current = false;
      setAlt(false);
      setHover(null);
    };
    window.addEventListener("keydown", update);
    window.addEventListener("keyup", update);
    window.addEventListener("blur", clear);
    return () => {
      window.removeEventListener("keydown", update);
      window.removeEventListener("keyup", update);
      window.removeEventListener("blur", clear);
    };
  }, []);
  const cullRoots = rootNodes.length > 8 && e.doc.nodes.length > 500;
  const visibleWorldRect = useMemo<Rect | null>(() => {
    if (!cullRoots) return null;
    const margin = 480;
    return {
      x: (-viewport.x - margin) / viewport.zoom,
      y: (-viewport.y - margin) / viewport.zoom,
      width: (surfaceSize.width + margin * 2) / viewport.zoom,
      height: (surfaceSize.height + margin * 2) / viewport.zoom,
    };
  }, [cullRoots, viewport.x, viewport.y, viewport.zoom, surfaceSize]);
  const pinnedRoots = useMemo(() => {
    if (!cullRoots) return null;
    const set = new Set<string>();
    for (const id of e.selection) {
      const chain = ancestors(e.doc, id);
      set.add(chain.length ? chain[chain.length - 1].id : id);
    }
    if (e.editing) {
      const chain = ancestors(e.doc, e.editing);
      set.add(chain.length ? chain[chain.length - 1].id : e.editing);
    }
    return set;
  }, [cullRoots, e.doc, e.selection, e.editing]);
  const gridStep =
    viewport.zoom < 0.16
      ? 0
      : 16 * viewport.zoom < 10
        ? 32 * viewport.zoom
        : 16 * viewport.zoom;
  const pageName =
    e.doc.pages?.find((p) => p.id === e.doc.activePage)?.name ?? "页面 1";
  const pageBgStyle: CSSProperties =
    e.doc.pageBackground && e.doc.pageBackgroundVisible !== false
      ? {
          backgroundColor: displayColor(
            `${e.doc.pageBackground}${Math.round(
              Math.max(0, Math.min(1, e.doc.pageBackgroundOpacity ?? 1)) * 255,
            )
              .toString(16)
              .padStart(2, "0")}`,
            e.doc.colorProfile,
          ),
        }
      : {};
  const isComponentSelection = roots.some(
    (n) => masters.has(n.id) || !!n.instance || !!n.componentSet,
  );
  const drawKind =
    gesture.current?.kind === "draw" ? gesture.current.type : null;
  function setZoomExact(target: number) {
    const r = surface.current?.getBoundingClientRect();
    if (!r) return;
    setView(
      zoomAt(viewRef.current, target, { x: r.width / 2, y: r.height / 2 }),
    );
  }
  return (
    <main className="workspace">
      <div className="canvas-top">
        <span className="canvas-page-crumb" title={pageName}>
          {devMode ? "开发" : "设计"}
          <span className="subtle">/</span>
          <span className="canvas-page-name">{pageName}</span>
          {devMode && (
            <span
              style={{
                marginLeft: 8,
                padding: "1px 6px",
                borderRadius: 4,
                fontSize: 10,
                fontWeight: 600,
                background: "rgba(20, 174, 92, 0.16)",
                color: "var(--figma-green, #14ae5c)",
                border: "1px solid rgba(20, 174, 92, 0.35)",
              }}
            >
              DEV MODE
            </span>
          )}
        </span>
        <div>
          <button
            className="icon-btn"
            title="撤销"
            aria-label="撤销"
            data-tip="撤销"
            data-tip-kbd="⌘Z"
            data-tip-desc="撤销上一步文档修改并恢复选区"
            data-tip-side="bottom"
            disabled={!e.canUndo}
            onClick={e.undo}
          >
            <Undo2 size={15} />
          </button>
          <button
            className="icon-btn"
            title="重做"
            aria-label="重做"
            data-tip="重做"
            data-tip-kbd="⇧⌘Z"
            data-tip-desc="重做已撤销的操作"
            data-tip-side="bottom"
            disabled={!e.canRedo}
            onClick={e.redo}
          >
            <Redo2 size={15} />
          </button>
          <span className="toolbar-sep" aria-hidden="true" />
          <button
            className={`icon-btn ${effectiveViewOptions.showRulers ? "active" : ""}`}
            title="标尺与辅助线 ⇧R"
            aria-label="标尺与辅助线"
            aria-pressed={effectiveViewOptions.showRulers}
            data-tip="标尺与辅助线"
            data-tip-kbd="⇧R"
            data-tip-desc="显示像素标尺，可从标尺边缘拖出吸附辅助线"
            data-tip-side="bottom"
            onClick={() => handleToggleViewOption("showRulers")}
          >
            <Ruler size={15} />
          </button>
          <button
            type="button"
            className={`icon-btn icon-btn-sm canvas-quiet-toggle ${effectiveViewOptions.snapEnabled ? "is-enabled" : ""}`}
            title={
              effectiveViewOptions.snapEnabled
                ? "智能吸附对齐：已开启"
                : "智能吸附对齐：已关闭"
            }
            aria-label="智能吸附对齐"
            aria-pressed={effectiveViewOptions.snapEnabled}
            data-tip={
              effectiveViewOptions.snapEnabled
                ? "智能吸附对齐（已开启）"
                : "智能吸附对齐（已关闭）"
            }
            data-tip-desc="拖拽时自动对齐相邻边界、中心线与辅助线（按住 ⌘ 临时关闭）"
            data-tip-side="bottom"
            onClick={() => handleToggleViewOption("snapEnabled")}
          >
            <Magnet size={14} />
          </button>
          <span className="toolbar-sep" aria-hidden="true" />
          <button
            className="icon-btn icon-btn-sm"
            title="缩小"
            aria-label="缩小"
            data-tip="缩小画布"
            data-tip-kbd="-"
            data-tip-side="bottom"
            onClick={() => e.api.current?.zoom(1 / 1.2)}
          >
            <Minus size={14} />
          </button>
          <button
            className="zoom-readout"
            title="缩放至 100%"
            data-tip="重置缩放至 100%"
            data-tip-kbd="⌘0"
            data-tip-desc="点击恢复 1:1 实际像素视图"
            data-tip-side="bottom"
            onClick={() => e.api.current?.zoom100()}
          >
            {Math.round(viewport.zoom * 100)}%
          </button>
          <ViewOptionsMenu
            zoom={viewport.zoom}
            options={effectiveViewOptions}
            onZoomChange={(z) => setZoomExact(z)}
            onFit={() => fit()}
            onFitSelection={() => {
              if (e.selection.length) fit(e.selection);
            }}
            onToggleOption={handleToggleViewOption}
            onToggleUI={() => onToggleUI?.()}
            uiHidden={uiHidden}
          />
          <button
            className="icon-btn icon-btn-sm"
            title="放大"
            aria-label="放大"
            data-tip="放大画布"
            data-tip-kbd="+"
            data-tip-side="bottom"
            onClick={() => e.api.current?.zoom(1.2)}
          >
            <Plus size={14} />
          </button>
          <button
            className="icon-btn"
            title="适应全部内容 Shift+1"
            aria-label="适应全部内容"
            data-tip="适应全部内容"
            data-tip-kbd="⇧1"
            data-tip-desc="居中展示当前页面全部画板（适应选区：⇧2）"
            data-tip-side="bottom"
            onClick={() => fit()}
          >
            <Maximize size={15} />
          </button>
        </div>
      </div>
      <div
        ref={surface}
        className={`canvas editor-canvas canvas-stage ${interacting ? "is-interacting" : ""} ${fileDragActive ? "file-drop-active" : ""} ${effectiveViewOptions.outlineMode ? "is-outline-mode" : ""} ${devMode ? "is-dev-mode" : ""} ${space || currentTool === "hand" ? "panning-tool" : currentTool !== "select" && currentTool !== "scale" ? "drawing-tool" : ""}`}
        tabIndex={0}
        aria-label="设计画布"
        data-zoom={viewport.zoom}
        onDragOver={(ev) => {
          const types = ev.dataTransfer.types;
          if (
            types.includes("Files") ||
            types.includes("application/x-forma-asset")
          ) {
            ev.preventDefault();
            ev.dataTransfer.dropEffect = "copy";
            if (!fileDragActive) setFileDragActive(true);
          }
        }}
        onDragLeave={(ev) => {
          if (!ev.currentTarget.contains(ev.relatedTarget as Node | null))
            setFileDragActive(false);
        }}
        onDrop={(ev) => {
          setFileDragActive(false);
          const assetPayload = ev.dataTransfer.getData(
            "application/x-forma-asset",
          );
          if (assetPayload) {
            ev.preventDefault();
            const dropPoint = { x: ev.clientX, y: ev.clientY };
            void (async () => {
              try {
                const parsed = JSON.parse(assetPayload) as {
                  libraryId: string;
                  componentId: string;
                  variantId: string;
                };
                const builtin = OFFICIAL_BUILTIN_LIBRARY_IDS.has(
                  parsed.libraryId,
                )
                  ? (
                      await import("../design-system/catalog")
                    ).findBuiltinLibrary(parsed.libraryId)
                  : undefined;
                e.attempt(() => {
                  const current = e.historyRef.current.present;
                  const installed = current.libraries?.[parsed.libraryId];
                  const library =
                    builtin &&
                    (!installed || installed.revision === builtin.revision)
                      ? builtin
                      : (installed ?? builtin);
                  const component = library?.components.find(
                    (c) => c.id === parsed.componentId,
                  );
                  if (!library || !component)
                    throw new Error("找不到拖入的组件");
                  const point = world(dropPoint);
                  const parentId = containerAt(point, current);
                  if (parentId && isLocked(current, parentId))
                    throw new Error("目标容器已锁定");
                  const placement = parentId
                    ? transform(inverse(matrices.get(parentId)!), point)
                    : point;
                  const scoped = { ...library, components: [component] };
                  const result = instantiateComponent(
                    current,
                    scoped,
                    component.id,
                    parsed.variantId,
                    parentId,
                    { x: Math.round(placement.x), y: Math.round(placement.y) },
                  );
                  e.apply(result.operations);
                  e.setSelection([result.id]);
                });
              } catch (err) {
                e.setError(err instanceof Error ? err.message : String(err));
              }
            })();
            return;
          }
          if (!ev.dataTransfer.files.length) return;
          ev.preventDefault();
          const dropped = Array.from(ev.dataTransfer.files);
          const external = dropped.filter((f) =>
            /\.(sketch|fig)$/i.test(f.name),
          );
          if (external.length) {
            if (dropped.length !== 1) e.setError("请一次拖入一份设计文件");
            else onImportDesign(external[0]);
            return;
          }
          const nativeDesign = dropped.filter((f) =>
            /\.(forma|forma\.json)$/i.test(f.name),
          );
          if (nativeDesign.length && onOpenNativeDesign) {
            if (dropped.length !== 1) e.setError("请一次拖入一份设计文件");
            else onOpenNativeDesign(nativeDesign[0]);
            return;
          }
          const point = world({ x: ev.clientX, y: ev.clientY }),
            parentId = containerAt(point, e.committed);
          const box = parentId ? bounds.get(parentId) : null;
          const relative = parentId
            ? transform(inverse(matrices.get(parentId)!), point)
            : point;
          void e.importAssets(dropped, {
            parentId,
            point: {
              x: relative.x - (box?.x ?? 0),
              y: relative.y - (box?.y ?? 0),
            },
          });
        }}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={(event) => end(event)}
        onPointerCancel={(event) => end(event, true)}
        onDoubleClick={(event) => {
          if (devMode) return;
          const id = targetId(event);
          if (!id) return;
          const node = e.doc.nodes.find((n) => n.id === id)!;
          e.setSelection([id]);
          if (
            node.image &&
            node.image.fit !== "tile" &&
            node.type !== "text" &&
            node.type !== "button" &&
            node.type !== "vector" &&
            !isLocked(e.doc, id) &&
            !prototypeMode
          )
            e.setCropping(id);
          if (node.type === "text" || node.type === "button") e.setEditing(id);
          if (node.type === "vector" && !instanceOwner(e.doc, id))
            e.setEditing(id);
        }}
        onContextMenu={(event) => {
          if (
            (event.target as HTMLElement).closest(
              'textarea,[contenteditable="true"]',
            )
          )
            return;
          event.preventDefault();
          const id = targetId(event);
          if (!id) e.setSelection([]);
          else if (
            ![id, ...ancestors(e.doc, id).map((n) => n.id)].some((key) =>
              e.selection.includes(key),
            )
          )
            e.setSelection([shallow(id, event.metaKey || event.ctrlKey)]);
          const layers = [
            ...new Set(
              document
                .elementsFromPoint(event.clientX, event.clientY)
                .flatMap((el) => {
                  const key = (el as HTMLElement).dataset?.nodeId;
                  return key && !isLocked(e.doc, key) ? [key] : [];
                }),
            ),
          ];
          contextMenu(event.clientX, event.clientY, layers);
        }}
        style={
          gridStep
            ? {
                ...pageBgStyle,
                backgroundPosition: `${viewport.x}px ${viewport.y}px`,
                backgroundSize: `${gridStep}px ${gridStep}px`,
              }
            : { ...pageBgStyle, backgroundImage: "none" }
        }
      >
        <div
          className="canvas-world"
          style={
            {
              transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.zoom})`,
              "--canvas-zoom": viewport.zoom,
              ...tokenVars,
            } as CSSProperties
          }
        >
          <InlineTextContext.Provider value={e.editing ? e : null}>
            {rootNodes.map((node) => {
              const rect = bounds.get(node.id);
              if (
                visibleWorldRect &&
                rect &&
                !pinnedRoots?.has(node.id) &&
                !intersects(
                  visualBounds(rect, matrices.get(node.id) ?? identity),
                  visibleWorldRect,
                )
              ) {
                return (
                  <div
                    key={node.id}
                    data-node-id={node.id}
                    data-node-type={node.type}
                    className="design-node"
                    style={{
                      position: "absolute",
                      left: rect.x,
                      top: rect.y,
                      width: rect.width,
                      height: rect.height,
                      background: displayColor(
                        node.style.fill,
                        e.doc.colorProfile,
                      ),
                      borderRadius: node.style.radius,
                      pointerEvents: "none",
                    }}
                  />
                );
              }
              return (
                <CanvasNode
                  key={node.id}
                  node={node}
                  document={e.doc}
                  selection={e.selection}
                  editing={e.editing}
                  showLayoutGuides={effectiveViewOptions.showLayoutGuides}
                  outlineMode={effectiveViewOptions.outlineMode}
                  aiPreviewNodeIds={aiPreviewNodeIds}
                />
              );
            })}
          </InlineTextContext.Provider>
        </div>
        {(effectiveViewOptions.showPixelGrid || viewport.zoom >= 4) && (
          <div
            aria-hidden="true"
            className="canvas-pixel-grid"
            style={{
              position: "absolute",
              inset: 0,
              pointerEvents: "none",
              backgroundPosition: `${viewport.x}px ${viewport.y}px`,
              backgroundSize: `${viewport.zoom >= 4 ? viewport.zoom : Math.max(8, viewport.zoom * 8)}px ${viewport.zoom >= 4 ? viewport.zoom : Math.max(8, viewport.zoom * 8)}px`,
              backgroundImage:
                "linear-gradient(to right, rgba(128, 128, 128, 0.14) 1px, transparent 1px), linear-gradient(to bottom, rgba(128, 128, 128, 0.14) 1px, transparent 1px)",
            }}
          />
        )}
        {pencilStroke && pencilStroke.length > 1 && (
          <svg
            aria-hidden="true"
            style={{
              position: "absolute",
              inset: 0,
              width: "100%",
              height: "100%",
              pointerEvents: "none",
              overflow: "visible",
            }}
          >
            <polyline
              fill="none"
              stroke="#0d99ff"
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
              points={pencilStroke
                .map(
                  (p) =>
                    `${viewport.x + p.x * viewport.zoom},${viewport.y + p.y * viewport.zoom}`,
                )
                .join(" ")}
            />
          </svg>
        )}
        {rootNodes.map((node) => {
          if (node.hidden || (node.type !== "frame" && !node.componentSet))
            return null;
          const rect = bounds.get(node.id);
          if (!rect) return null;
          if (
            visibleWorldRect &&
            !pinnedRoots?.has(node.id) &&
            !intersects(
              visualBounds(rect, matrices.get(node.id) ?? identity),
              visibleWorldRect,
            )
          )
            return null;
          const left = viewport.x + rect.x * viewport.zoom;
          const top = viewport.y + rect.y * viewport.zoom - 6;
          const isComp =
            masters.has(node.id) || !!node.instance || !!node.componentSet;
          return (
            <button
              key={`lbl-${node.id}`}
              type="button"
              className={`frame-label ${e.selection.includes(node.id) ? "selected" : ""} ${isComp ? "is-component" : ""}`}
              style={{ left, top }}
              onPointerDown={(ev) => {
                ev.stopPropagation();
                if (!isLocked(e.committed, node.id))
                  e.select(node.id, ev.shiftKey);
              }}
              onDoubleClick={(ev) => {
                ev.stopPropagation();
                if (!isLocked(e.committed, node.id)) {
                  e.setSelection([node.id]);
                  e.setRenaming(node.id);
                }
              }}
            >
              {node.name}{" "}
              <small>
                {Math.round(rect.width)} × {Math.round(rect.height)}
              </small>
            </button>
          );
        })}
        {dropCell && (
          <div
            aria-hidden="true"
            className="grid-drop-preview"
            style={oriented(dropCell.rect, dropCell.matrix)}
          >
            <span>
              {dropCell.cell.row} × {dropCell.cell.column}
            </span>
          </div>
        )}
        {selectionBox && !e.editing && !cropNode && e.tool !== "pen" && (
          <div
            className="selection-overlay"
            data-selection-kind={isComponentSelection ? "component" : undefined}
            style={oriented(selectionBox, selectedMatrix)}
            data-testid="selection-box"
          >
            {selectedNode &&
              e.tool === "select" &&
              !prototypeMode &&
              selectedNode.style.layout === "grid" &&
              !selectedNode.style.minColumnWidth &&
              !roots[0].instance &&
              !instanceAncestor(e.doc, roots[0].id) &&
              !isLocked(e.doc, roots[0].id) && (
                <GridHandles
                  key={roots[0].id}
                  editor={e}
                  node={selectedNode}
                  boxes={bounds}
                  matrix={selectedMatrix}
                  zoom={viewport.zoom}
                />
              )}
            <span className="dimension-label">
              {Math.round(selectionBox.width)} ×{" "}
              {Math.round(selectionBox.height)}
            </span>
            {roots.length === 1 &&
              !devMode &&
              !isLocked(e.doc, roots[0].id) &&
              !instanceAncestor(e.doc, roots[0].id) && (
                <button
                  className="rotation-handle"
                  aria-label="旋转选区"
                  title="旋转 · Shift 15°"
                  onPointerDown={beginRotate}
                />
              )}
            {!devMode &&
              !roots.some(
                (n) => isLocked(e.doc, n.id) || instanceAncestor(e.doc, n.id),
              ) &&
              handles.map((handle) => (
                <button
                  key={handle}
                  className={`resize-handle handle-${handle}`}
                  aria-label={`调整尺寸 ${handle}`}
                  onPointerDown={(event) => beginResize(event, handle)}
                />
              ))}
          </div>
        )}
        {prototypeMode &&
          !devMode &&
          !e.editing &&
          currentTool === "select" && (
            <PrototypeWires
              editor={e}
              viewport={viewport}
              bounds={bounds}
              matrices={matrices}
              onPlayFlow={onPlayFlow}
            />
          )}
        {e.smartGrid &&
          !prototypeMode &&
          !devMode &&
          !e.editing &&
          currentTool === "select" && (
            <SmartHandles
              editor={e}
              grid={e.smartGrid}
              viewport={viewport}
              matrix={matrices.get(e.smartGrid.parent ?? "") ?? identity}
            />
          )}
        {box &&
          (drawing ? (
            <div
              style={{
                ...scaled(box),
                position: "absolute",
                pointerEvents: "none",
              }}
            >
              <svg
                aria-hidden="true"
                className="shape-preview"
                style={{ width: "100%", height: "100%", position: "static" }}
                viewBox={`0 0 ${drawing.width} ${drawing.height}`}
                preserveAspectRatio="none"
              >
                <path
                  d={drawing.paths[0].d}
                  fill={
                    drawing.paths[0].fill ? "rgba(13, 153, 255, 0.14)" : "none"
                  }
                  stroke="#0d99ff"
                  vectorEffect="non-scaling-stroke"
                />
              </svg>
              {box.width > 4 && box.height > 4 && (
                <span className="dimension-label">
                  {Math.round(box.width)} × {Math.round(box.height)}
                </span>
              )}
            </div>
          ) : (
            <div
              className="marquee"
              style={{
                ...scaled(box),
                ...(drawKind === "ellipse" ? { borderRadius: "50%" } : {}),
                ...(drawKind === "slice"
                  ? {
                      borderStyle: "dashed",
                      borderColor: "#0d99ff",
                      background: "rgba(13, 153, 255, 0.06)",
                    }
                  : {}),
                ...(drawKind === "section"
                  ? {
                      borderRadius: 8,
                      borderColor: "#525866",
                      background: "rgba(99, 102, 241, 0.08)",
                    }
                  : {}),
              }}
            >
              {drawKind && box.width > 4 && box.height > 4 && (
                <span className="dimension-label">
                  {Math.round(box.width)} × {Math.round(box.height)}
                </span>
              )}
            </div>
          ))}
        {ghost && (
          <div className="drag-ghost" style={scaled(ghost)}>
            拖入容器 / 调整顺序
          </div>
        )}
        {guides.map((guide, i) => (
          <div
            key={i}
            className={`snap-guide guide-${guide.axis}`}
            style={
              guide.axis === "x"
                ? { left: viewport.x + guide.value * viewport.zoom }
                : { top: viewport.y + guide.value * viewport.zoom }
            }
          />
        ))}
        {fileDragActive && (
          <div className="canvas-drop-hint" aria-hidden="true">
            释放以导入 Sketch、Figma、Forma 设计文件或图片 / SVG
          </div>
        )}
        {effectiveViewOptions.showRulers && (
          <CanvasRulers
            selection={
              selectionBox
                ? visualBounds(selectionBox, selectedMatrix)
                : undefined
            }
            viewport={viewport}
            guides={e.committed.guides ?? []}
            change={(guides) =>
              e.attempt(() => e.apply([{ type: "setGuides", guides }]))
            }
          />
        )}
        {(alt || devMode) && measure && hoverRect && selectionBox && (
          <>
            {measure.inside ? (
              <>
                {measure.left > 0 && (
                  <div
                    className="measure-line measure-line-x"
                    style={{
                      left: viewport.x + hoverRect.x * viewport.zoom,
                      top:
                        viewport.y +
                        (selectionBox.y + selectionBox.height / 2) *
                          viewport.zoom,
                      width: measure.left * viewport.zoom,
                    }}
                  >
                    <span>{Math.round(measure.left)}</span>
                  </div>
                )}
                {measure.right > 0 && (
                  <div
                    className="measure-line measure-line-x"
                    style={{
                      left:
                        viewport.x +
                        (selectionBox.x + selectionBox.width) * viewport.zoom,
                      top:
                        viewport.y +
                        (selectionBox.y + selectionBox.height / 2) *
                          viewport.zoom,
                      width: measure.right * viewport.zoom,
                    }}
                  >
                    <span>{Math.round(measure.right)}</span>
                  </div>
                )}
                {measure.top > 0 && (
                  <div
                    className="measure-line measure-line-y"
                    style={{
                      left:
                        viewport.x +
                        (selectionBox.x + selectionBox.width / 2) *
                          viewport.zoom,
                      top: viewport.y + hoverRect.y * viewport.zoom,
                      height: measure.top * viewport.zoom,
                    }}
                  >
                    <span>{Math.round(measure.top)}</span>
                  </div>
                )}
                {measure.bottom > 0 && (
                  <div
                    className="measure-line measure-line-y"
                    style={{
                      left:
                        viewport.x +
                        (selectionBox.x + selectionBox.width / 2) *
                          viewport.zoom,
                      top:
                        viewport.y +
                        (selectionBox.y + selectionBox.height) * viewport.zoom,
                      height: measure.bottom * viewport.zoom,
                    }}
                  >
                    <span>{Math.round(measure.bottom)}</span>
                  </div>
                )}
              </>
            ) : (
              <>
                {measure.dx > 0 && (
                  <div
                    className="measure-line measure-line-x"
                    style={{
                      left:
                        viewport.x +
                        Math.min(
                          selectionBox.x + selectionBox.width,
                          hoverRect.x + hoverRect.width,
                        ) *
                          viewport.zoom,
                      top:
                        viewport.y +
                        (selectionBox.y + selectionBox.height / 2) *
                          viewport.zoom,
                      width: measure.dx * viewport.zoom,
                    }}
                  >
                    <span>{Math.round(measure.dx)}</span>
                  </div>
                )}
                {measure.dy > 0 && (
                  <div
                    className="measure-line measure-line-y"
                    style={{
                      left:
                        viewport.x +
                        (selectionBox.x + selectionBox.width / 2) *
                          viewport.zoom,
                      top:
                        viewport.y +
                        Math.min(
                          selectionBox.y + selectionBox.height,
                          hoverRect.y + hoverRect.height,
                        ) *
                          viewport.zoom,
                      height: measure.dy * viewport.zoom,
                    }}
                  >
                    <span>{Math.round(measure.dy)}</span>
                  </div>
                )}
                <div
                  className="measurement"
                  style={{
                    left: viewport.x + hoverRect.x * viewport.zoom,
                    top: viewport.y + hoverRect.y * viewport.zoom - 26,
                  }}
                >
                  水平 {Math.round(measure.dx)} · 垂直 {Math.round(measure.dy)}{" "}
                  px
                </div>
              </>
            )}
          </>
        )}
        {(e.tool === "pen" ||
          e.doc.nodes.some(
            (n) => n.id === e.editing && n.type === "vector",
          )) && (
          <VectorEditor
            key={e.editing ?? "pen"}
            panning={space}
            editor={e}
            node={e.doc.nodes.find(
              (n) => n.id === e.editing && n.type === "vector",
            )}
            box={bounds.get(e.editing ?? "")}
            viewport={viewport}
            parentAt={(p) => {
              const id = containerAt(p, e.committed);
              return {
                id,
                box: bounds.get(id ?? ""),
                matrix: matrices.get(id ?? "") ?? identity,
              };
            }}
            close={() => {
              e.setTool("select");
              e.setEditing(null);
            }}
          />
        )}
        {cropNode?.image && bounds.has(cropNode.id) && (
          <ImageCropOverlay
            key={cropNode.id}
            editor={e}
            node={resolveNode(e.committed, cropNode)}
            box={bounds.get(cropNode.id)!}
            matrix={matrices.get(cropNode.id)!}
            zoom={viewport.zoom}
            style={oriented(
              bounds.get(cropNode.id)!,
              matrices.get(cropNode.id)!,
            )}
          />
        )}
        {effectiveViewOptions.showComments && effectiveComments.length > 0 && (
          <CommentsCanvasLayer
            comments={effectiveComments}
            viewport={viewport}
            activeCommentId={effectiveActiveCommentId}
            onSelectComment={handleSelectComment}
            onUpdateComments={handleUpdateComments}
          />
        )}
      </div>
      <input
        hidden
        type="file"
        accept=".svg,image/svg+xml,image/png,image/jpeg,image/webp,image/gif"
        multiple
        ref={assetFile}
        onChange={(ev) => {
          const files = Array.from(ev.target.files ?? []);
          ev.target.value = "";
          void e.importAssets(files);
        }}
      />
      <div className="toolbar" role="toolbar" aria-label="画布绘图工具栏">
        <MoveToolGroup tool={currentTool} choose={selectTool} />
        <span className="toolbar-sep" aria-hidden="true" />
        <FrameToolGroup tool={currentTool} choose={selectTool} />
        <ShapeTools tool={currentTool} choose={selectTool} />
        <PenToolGroup tool={currentTool} choose={selectTool} />
        <button
          title="绘制文本 T"
          data-tip="文本工具"
          data-tip-kbd="T"
          data-tip-desc="点击画布直接输入自适应文本，或拖拽创建固定宽文本框"
          data-tip-side="top"
          className={`tool-btn ${currentTool === "text" ? "selected-tool" : ""}`}
          aria-label="绘制文本 T"
          aria-pressed={currentTool === "text"}
          onClick={() => selectTool("text")}
        >
          <Type size={18} />
        </button>
        <button
          title="画布评论 C"
          data-tip="画布评论"
          data-tip-kbd="C"
          data-tip-desc="点击画布任意位置添加评审批注与讨论串"
          data-tip-side="top"
          className={`tool-btn ${currentTool === "comment" ? "selected-tool" : ""}`}
          aria-label="评论工具 C"
          aria-pressed={currentTool === "comment"}
          onClick={() => selectTool("comment")}
        >
          <MessageSquare size={17} />
        </button>
        <span className="toolbar-sep" aria-hidden="true" />
        <button
          className="tool-btn"
          aria-label="置入图像或 SVG"
          title="置入图像或 SVG"
          data-tip="置入图像或 SVG"
          data-tip-desc="导入 PNG / JPG / WebP / GIF 位图或可编辑 SVG 矢量图形"
          data-tip-side="top"
          onClick={() => assetFile.current?.click()}
        >
          <ImagePlus size={18} />
        </button>
        <button
          type="button"
          className="tool-btn"
          aria-label="AI 画布对话"
          title="AI 画布对话 ⌘↵"
          data-tip="AI 画布对话"
          data-tip-kbd="⌘↵"
          data-tip-desc="在画布中直接用自然语言生成页面、组件或调整布局"
          data-tip-side="top"
          onClick={() => onOpenInlineAgent?.()}
        >
          <Sparkles size={17} />
        </button>
        <span className="toolbar-sep" aria-hidden="true" />
        <button
          type="button"
          className={`tool-btn ${devMode ? "selected-tool" : ""}`}
          aria-label="切换开发模式"
          title="开发模式 ⇧D"
          aria-pressed={devMode}
          data-tip="开发模式 (Dev Mode)"
          data-tip-kbd="⇧D"
          data-tip-desc="进入只读开发检查模式，悬停测量红线间距并查看代码与 Token"
          data-tip-side="top"
          onClick={() => onToggleDevMode?.()}
          style={
            devMode
              ? {
                  background: "rgba(20, 174, 92, 0.18)",
                  color: "var(--figma-green, #14ae5c)",
                }
              : undefined
          }
        >
          <Code2 size={17} />
        </button>
      </div>
      <div className="canvas-caption"></div>
    </main>
  );
}
