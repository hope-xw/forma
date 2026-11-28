import "./canvas-feel.css";
import { flushSync } from "react-dom";
import {
  applyWheelToViewport,
  createCameraChannel,
  stepZoomLevel,
  type CameraChannel,
} from "../application/canvas-camera";
import {
  shouldAutoExpandMinimap,
  viewportWorldRect,
  type MinimapNodeSummary,
} from "../application/minimap-layout";
import { buildSpatialIndex } from "../domain/spatial-index";
import { CanvasOverlayHud } from "./CanvasOverlayHud";
import { CanvasMinimap } from "./CanvasMinimap";
import { CornerRadiusHandles } from "./CornerRadiusHandles";
import { AutoLayoutHandles } from "./AutoLayoutHandles";
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
  useCallback,
  useEffect,
  useEffectEvent,
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
  Map as MapIcon,
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
  type DesignNode,
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
  type SnapGuide,
  type Viewport,
} from "../domain/geometry";
import {
  childrenOf,
  findLayer,
  indexPublishedScene,
  positionDelta,
} from "../domain/scene-index";
import { duplicateSelectionForDrag } from "../domain/clipboard";
import {
  useGestureEditor,
  type EditorController,
  type Tool,
} from "./useEditor";
import {
  ArtboardLabel,
  collectArtboardLabelNodes,
  shouldAllowArtboardLabelPointer,
} from "./ArtboardLabel";
import { BoardLodTile } from "./BoardLodTile";
import {
  isBoardLodRenderable,
  branchHasLayoutGuides,
  hasMoreDescendantsThan,
  LOD_MIN_BOARD_NODES,
  resolveBoardLodMode,
  resolveLodActive,
} from "../application/board-lod";
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
  onToggleViewOption?(key: keyof CanvasViewOptions, next: boolean): void;
  active?: boolean;
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
      fromTitle: boolean;
      shiftToggleId?: string;
      appliedDelta: Point;
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

function labelIdAt(target: Element | null) {
  const label = target?.closest<HTMLElement>(
    "[data-frame-label-id],[data-section-label-id]",
  );
  return label?.dataset.frameLabelId ?? label?.dataset.sectionLabelId;
}
function rootIdOf(doc: DesignDocument, id: string) {
  return ancestors(doc, id).at(-1)?.id ?? id;
}
function rootIdsOf(doc: DesignDocument, ids?: Iterable<string>) {
  const roots = new Set<string>();
  if (ids) for (const id of ids) roots.add(rootIdOf(doc, id));
  return roots;
}
function selectionBounds(
  doc: DesignDocument,
  roots: DesignNode[],
  bounds: Map<string, Rect>,
  matrices: Map<string, Matrix>,
) {
  return union(
    roots
      .filter((node) => isVisible(doc, node.id))
      .map((node) => {
        const box = bounds.get(node.id)!;
        return roots.length === 1
          ? box
          : visualBounds(box, matrices.get(node.id)!);
      }),
  );
}

function summaryFill(doc: DesignDocument, resolved: DesignNode) {
  const token = resolved.fillToken && doc.tokens[resolved.fillToken];
  return displayColor(
    token ? token.value : resolved.style.fill,
    doc.colorProfile,
  );
}

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
  editor,
  active = true,
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
  const e = useGestureEditor(
    editor,
    JSON.stringify([editor.committed.id, editor.committed.activePage]),
  );
  const currentTool = e.tool as ExtendedTool;
  const selectTool = (next: ExtendedTool) => {
    e.setEditing(null);
    e.setTool(next as Tool);
  };
  const [localViewOpts, setLocalViewOpts] = useState({
    showMinimap: undefined as boolean | undefined,
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
  const rootNodes = useMemo(() => childrenOf(e.doc, null), [e.doc]);
  const rootBoardCount = useMemo(
    () => rootNodes.filter((node) => node.type === "frame").length,
    [rootNodes],
  );
  const totalNodes = e.doc.nodes.length;
  const [lodActive, setLodActive] = useState(false);
  useEffect(() => {
    setLodActive((prev) =>
      resolveLodActive(viewport.zoom, prev, rootBoardCount, totalNodes),
    );
  }, [viewport.zoom, rootBoardCount, totalNodes]);
  const isLodActive = resolveLodActive(
    viewport.zoom,
    lodActive,
    rootBoardCount,
    totalNodes,
  );
  const cullRoots = rootNodes.length > 8 && e.doc.nodes.length > 500;
  const viewRef = useRef(viewport);
  const settledViewportRef = useRef(viewport);
  const worldRef = useRef<HTMLDivElement>(null);
  const vectorEditorRef = useRef<HTMLDivElement>(null);
  const overlaysRef = useRef<HTMLDivElement>(null);
  const zoomReadoutRef = useRef<HTMLButtonElement>(null);
  const cameraRef = useRef<CameraChannel | null>(null);
  if (!cameraRef.current)
    cameraRef.current = createCameraChannel(viewport, { settleMs: 72 });
  const camera = cameraRef.current;
  const renderCount = useRef(0);
  renderCount.current++;

  const paintCamera = useCallback(() => {
    const stage = surface.current,
      world = worldRef.current,
      overlays = overlaysRef.current;
    if (!stage || !world || !overlays) return;
    const live = camera.get(),
      settled = settledViewportRef.current;
    world.style.transform = `translate(${live.x}px, ${live.y}px) scale(${live.zoom})`;
    world.style.setProperty("--canvas-zoom", String(live.zoom));
    stage.dataset.zoom = String(live.zoom);
    stage.classList.toggle("is-camera-moving", camera.isInteracting());
    const step = (16 * live.zoom < 10 ? 32 : 16) * live.zoom;
    stage.style.backgroundImage = live.zoom < 0.16 ? "none" : "";
    stage.style.backgroundPosition = `${live.x}px ${live.y}px`;
    stage.style.backgroundSize = `${step}px ${step}px`;
    const readout = Math.round(live.zoom * 100) + "%";
    if (
      zoomReadoutRef.current &&
      zoomReadoutRef.current.textContent !== readout
    )
      zoomReadoutRef.current.textContent = readout;
    // Keep screen-space adornments anchored until React commits their new coordinates.
    const ratio = live.zoom / settled.zoom;
    const dx = live.x - settled.x * ratio,
      dy = live.y - settled.y * ratio;
    overlays.style.transform =
      live === settled ? "" : `translate(${dx}px, ${dy}px) scale(${ratio})`;
    if (live === settled)
      overlays.style.removeProperty("--live-overlay-inv-scale");
    else
      overlays.style.setProperty("--live-overlay-inv-scale", String(1 / ratio));
    // Vector artwork follows the overlay, but its tool palette stays at the top of the screen.
    if (vectorEditorRef.current) {
      const style = vectorEditorRef.current.style;
      style.setProperty("--overlay-dx", dx + "px");
      style.setProperty("--overlay-dy", dy + "px");
      style.setProperty("--overlay-scale", String(ratio));
    }
  }, [camera]);
  useLayoutEffect(() => {
    let frame: number | undefined;
    function commitViewport(next: Viewport) {
      settledViewportRef.current = next;
      paintCamera();
      setViewport(next);
    }
    const stopLive = camera.subscribeLive(({ interacting }) => {
      if (!interacting) {
        if (frame !== undefined) cancelAnimationFrame(frame);
        frame = undefined;
        paintCamera();
      } else if (frame === undefined) {
        frame = requestAnimationFrame(() => {
          frame = undefined;
          const live = camera.get();
          if (
            resolveLodActive(
              live.zoom,
              isLodActive,
              rootBoardCount,
              totalNodes,
            ) !== isLodActive
          ) {
            flushSync(() => commitViewport(live));
            return;
          }
          if (cullRoots) {
            // Keep 220 of the 480 prefetched screen pixels in reserve at each edge.
            const settled = settledViewportRef.current;
            const view = viewportWorldRect(live, surfaceSize);
            const left = settled.x + view.x * settled.zoom;
            const top = settled.y + view.y * settled.zoom;
            if (
              left < -260 ||
              top < -260 ||
              left + view.width * settled.zoom > surfaceSize.width + 260 ||
              top + view.height * settled.zoom > surfaceSize.height + 260
            ) {
              flushSync(() => commitViewport(live));
              return;
            }
          }
          paintCamera();
        });
      }
    });
    const stopSettled = camera.subscribeSettled(commitViewport);
    return () => {
      stopLive();
      stopSettled();
      if (frame !== undefined) cancelAnimationFrame(frame);
    };
  }, [
    camera,
    paintCamera,
    cullRoots,
    surfaceSize,
    isLodActive,
    rootBoardCount,
    totalNodes,
  ]);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      // StrictMode reconnects effects synchronously on the same channel.
      queueMicrotask(() => {
        if (!mounted.current) camera.dispose();
      });
    };
  }, [camera]);
  useLayoutEffect(() => {
    settledViewportRef.current = viewport;
    paintCamera();
  }, [viewport, paintCamera]);
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
  const capturedPointer = useRef<number | null>(null);
  const gesturePreview = useRef<DesignDocument | null>(null);
  const handleDraggingRef = useRef(false);
  const onHandleDragActiveChange = useCallback((active: boolean) => {
    handleDraggingRef.current = active;
  }, []);
  const hasExternalPreview =
    Boolean(e.hasExternalPreview) ||
    Boolean(aiPreviewNodeIds?.size) ||
    (e.doc !== e.committed &&
      !handleDraggingRef.current &&
      (!gesture.current || e.doc !== gesturePreview.current));
  const [box, setBox] = useState<Rect | null>(null);
  const boxRef = useRef<Rect | null>(null);
  function updateBox(next: Rect | null) {
    boxRef.current = next;
    setBox(next);
  }
  const [guides, setGuides] = useState<SnapGuide[]>([]);
  const [dropCell, setDropCell] = useState<ReturnType<typeof gridDrop>>();
  const [ghost, setGhost] = useState<Rect | null>(null);
  const [snap, setSnap] = useState(true);
  const [fileDragActive, setFileDragActive] = useState(false);
  const [hover, setHover] = useState<string | null>(null);
  const [alt, setAlt] = useState(false);
  const altRef = useRef(false);
  const [interacting, setInteracting] = useState(false);
  const [hoveredLabelId, setHoveredLabelId] = useState<string | null>(null);
  const [canvasRenamingId, setCanvasRenamingId] = useState<string | null>(null);
  const artboardLabelsInteractive = shouldAllowArtboardLabelPointer({
    locked: false,
    panning: space || currentTool === "hand",
    tool: currentTool,
    devMode,
    interacting,
    hasMarquee: Boolean(box),
  });
  useEffect(() => {
    if (!active || !artboardLabelsInteractive) setHoveredLabelId(null);
  }, [active, artboardLabelsInteractive]);
  useLayoutEffect(() => {
    setCanvasRenamingId(null);
    setHoveredLabelId(null);
  }, [e.committed.id, page, active]);
  useEffect(() => {
    if (canvasRenamingId && !findLayer(e.committed, canvasRenamingId))
      setCanvasRenamingId(null);
  }, [canvasRenamingId, e.committed]);
  function capturePointer(id: number) {
    try {
      surface.current?.setPointerCapture(id);
    } catch (error) {
      // Synthetic presses and released pointers cannot own a drag.
      if (error instanceof DOMException && error.name === "NotFoundError")
        return false;
      throw error;
    }
    capturedPointer.current = id;
    return true;
  }
  const clearGesturePreview = useCallback(() => {
    const owned = gesturePreview.current;
    gesturePreview.current = null;
    if (owned && e.previewRef.current === owned)
      e.setPreview((current) => (current === owned ? null : current));
  }, [e.previewRef, e.setPreview]);
  const cancelCanvasGesture = useCallback(() => {
    const state = gesture.current;
    if (!state) return;
    gesture.current = null;
    if (
      state.kind === "drag" &&
      state.prefix.length &&
      state.base === e.historyRef.current.present
    )
      e.setSelection(state.originalIds);
    const id = capturedPointer.current;
    capturedPointer.current = null;
    if (id !== null && surface.current?.hasPointerCapture(id))
      surface.current.releasePointerCapture(id);
    if ("base" in state && state.base !== e.historyRef.current.present)
      gesturePreview.current = null;
    else clearGesturePreview();
    setInteracting(false);
    updateBox(null);
    setPencilStroke(null);
    setGhost(null);
    setDropCell(undefined);
    setGuides([]);
  }, [clearGesturePreview, e.historyRef, e.setSelection]);
  useLayoutEffect(() => {
    if (hasExternalPreview) {
      setCanvasRenamingId(null);
      cancelCanvasGesture();
      return;
    }
    const current = gesture.current;
    if (
      (current?.kind === "rotate" ||
        current?.kind === "resize" ||
        current?.kind === "drag") &&
      current.base !== e.committed
    )
      cancelCanvasGesture();
  }, [hasExternalPreview, e.committed, cancelCanvasGesture]);
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
  const selectedNode =
    roots.length === 1 ? resolveNode(e.doc, roots[0]) : undefined;
  const selectedMatrix =
    roots.length === 1 ? matrices.get(roots[0].id)! : identity;
  const selectionBox = selectionBounds(e.doc, roots, bounds, matrices);
  const minimapItems = useMemo(() => {
    const items: MinimapNodeSummary[] = [];
    const selected = new Set(roots.map((n) => n.id));
    function collect(node: DesignNode) {
      if (!(
        node.type === "frame" ||
        node.type === "section" ||
        node.componentSet
      ))
        return;
      const resolved = resolveNode(e.doc, node);
      if (resolved.hidden) return;
      const rect = bounds.get(node.id);
      if (!rect) return;
      items.push({
        id: node.id,
        rect: visualBounds(rect, matrices.get(node.id) ?? identity),
        kind: node.componentSet
          ? "component"
          : node.type === "section"
            ? "section"
            : "frame",
        fill: summaryFill(e.doc, resolved),
        selected: selected.has(node.id),
      });
      if (node.type === "section") childrenOf(e.doc, node.id).forEach(collect);
    }
    rootNodes.forEach(collect);
    return items;
  }, [rootNodes, bounds, matrices, roots, e.doc]);
  const minimapBoardCount = useMemo(
    () => minimapItems.filter((n) => n.kind === "frame").length,
    [minimapItems],
  );
  const minimapExpanded =
    viewOptions?.showMinimap ??
    localViewOpts.showMinimap ??
    shouldAutoExpandMinimap(minimapBoardCount, surfaceSize);
  const effectiveViewOptions: CanvasViewOptions = {
    showMinimap: minimapExpanded,
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
      onToggleViewOption(key, !effectiveViewOptions[key]);
      return;
    }
    if (key === "showRulers") e.perform("rulers");
    else if (key === "snapEnabled") setSnap((s) => !s);
    else
      setLocalViewOpts((prev) => ({
        ...prev,
        [key]: !effectiveViewOptions[key],
      }));
  };
  const toggleMinimapShortcut = useEffectEvent(() =>
    handleToggleViewOption("showMinimap"),
  );
  const ready = useRef(false);
  const local = (client: Point) => {
    const rect = surface.current!.getBoundingClientRect();
    return { x: client.x - rect.left, y: client.y - rect.top };
  };
  const world = (client: Point) =>
    screenToWorld(local(client), viewRef.current);
  const setView = useCallback(
    (next: Viewport, live = false) => {
      if (handleDraggingRef.current) return;
      views.set(page, next);
      viewRef.current = next;
      if (live) camera.setLive(next);
      else camera.setImmediate(next);
    },
    [camera, page, views],
  );
  function fit(ids?: string[]) {
    if (handleDraggingRef.current) return;
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
        if (handleDraggingRef.current) return;
        const r = surface.current!.getBoundingClientRect();
        setView(
          zoomAt(viewRef.current, viewRef.current.zoom * factor, {
            x: r.width / 2,
            y: r.height / 2,
          }),
        );
      },
      zoom100: () => {
        if (handleDraggingRef.current) return;
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
      const saved = views.get(page);
      if (saved) setView(saved);
      else
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
      if (handleDraggingRef.current) {
        event.preventDefault();
        return;
      }
      if (
        (event.target as HTMLElement).closest(
          'textarea,[contenteditable="true"]',
        )
      )
        return;
      event.preventDefault();
      const { deltaX, deltaY, deltaMode, ctrlKey, metaKey, shiftKey } = event;
      const result = applyWheelToViewport(viewRef.current, {
        deltaX,
        deltaY,
        deltaMode,
        ctrlKey,
        metaKey,
        shiftKey,
        anchor: local({ x: event.clientX, y: event.clientY }),
      });
      setView(result.viewport, true);
    };
    element.addEventListener("wheel", wheel, { passive: false });
    return () => element.removeEventListener("wheel", wheel);
  }, [setView]);
  useEffect(() => {
    const resetInput = () => {
      spaceRef.current = false;
      setSpace(false);
      altRef.current = false;
      setAlt(false);
      setHover(null);
      cancelCanvasGesture();
    };
    if (!active) {
      resetInput();
      return;
    }
    const down = (event: KeyboardEvent) => {
      if (document.querySelector('[aria-modal="true"]')) return;
      if (
        event.code === "KeyM" &&
        event.shiftKey &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey &&
        !event.isComposing &&
        !event.repeat &&
        !event.defaultPrevented &&
        !(event.target as Element)?.closest?.(
          'input,textarea,select,[contenteditable]:not([contenteditable="false"]),[role="textbox"],[role="dialog"],[role="menu"],[role="menuitem"],[role="menuitemcheckbox"]',
        )
      ) {
        if (document.querySelector('[role="menu"]')) return;
        event.preventDefault();
        toggleMinimapShortcut();
        return;
      }
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
        cancelCanvasGesture();
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
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", resetInput);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", resetInput);
    };
  }, [active, cancelCanvasGesture, currentTool]);
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
    return buildSpatialIndex(doc, geometry, transforms).findSmallestContainerAt(
      point,
      ({ id, type }) =>
        type === "section" &&
        !excluded.has(id) &&
        !isLocked(doc, id) &&
        isVisible(doc, id),
    );
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
    return buildSpatialIndex(doc, geometry, transforms).findSmallestContainerAt(
      point,
      ({ id, type, order }) =>
        (type === "frame" ||
          type === "section" ||
          (includeSets && !!doc.nodes[order].componentSet)) &&
        !excluded.has(id) &&
        !isLocked(doc, id) &&
        !instanceOwner(doc, id) &&
        isVisible(doc, id),
    );
  }
  function flushForEditing() {
    if (camera.isInteracting()) flushSync(() => camera.flush());
    else if (camera.get() !== viewport)
      flushSync(() => setViewport(camera.get()));
  }
  function down(event: ReactPointerEvent) {
    if (!active || gesture.current || event.button === 2) return;
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
    const panning =
      event.button === 1 || spaceRef.current || currentTool === "hand";
    const selecting =
      !panning &&
      !devMode &&
      (currentTool === "select" || currentTool === "scale");
    const sectionLabelId = selecting
      ? labelIdAt(event.target as Element)
      : undefined;
    const hit = selecting ? (sectionLabelId ?? targetId(event)) : null;
    const hitNode = hit ? findLayer(e.committed, hit) : undefined;
    const deepBox =
      hitNode && isContainer(hitNode) && (event.metaKey || event.ctrlKey);
    if (hit && (sectionLabelId || !deepBox)) {
      beginNodeDrag(event, hit, { directId: Boolean(sectionLabelId) });
      return;
    }
    event.preventDefault();
    surface.current?.focus();
    if (!capturePointer(event.pointerId)) return;
    const point = world({ x: event.clientX, y: event.clientY });
    if (panning) {
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
    gesture.current = {
      kind: "box",
      start: point,
      add: event.shiftKey ? e.selection : [],
      deep: event.metaKey || event.ctrlKey,
      clickId: hitNode?.id,
    };
    if (!hitNode && !event.shiftKey) e.setSelection([]);
    updateBox({ x: point.x, y: point.y, width: 0, height: 0 });
  }
  function beginNodeDrag(
    event: ReactPointerEvent,
    hit: string,
    options?: { directId?: boolean },
  ) {
    if (gesture.current) return;
    if (!canStartCanvasEdit()) return;
    flushForEditing();
    event.preventDefault();
    event.stopPropagation();
    surface.current?.focus();
    if (
      !findLayer(e.committed, hit) ||
      isLocked(e.committed, hit) ||
      !capturePointer(event.pointerId)
    )
      return;
    const point = world({ x: event.clientX, y: event.clientY });
    if (e.cropping) e.setCropping(null);
    const id = options?.directId
      ? hit
      : shallow(hit, event.metaKey || event.ctrlKey);
    const alreadySelected = e.selection.includes(id);
    const originalIds = alreadySelected
      ? e.selection
      : event.shiftKey
        ? [...e.selection, id]
        : [id];
    let ids = originalIds;
    if (
      ids.some(
        (selected) =>
          isLocked(e.committed, selected) || instanceAncestor(e.doc, selected),
      )
    ) {
      if (event.shiftKey && alreadySelected) e.select(id, true);
      else e.setSelection(ids);
      return;
    }
    if (!event.shiftKey || !alreadySelected) e.setSelection(ids);
    let working = e.committed;
    let prefix: Operation[] = [];
    if (event.altKey) {
      try {
        const nodes = selectionRoots(working, ids);
        const parent = nodes.every((n) => n.parentId === nodes[0].parentId)
          ? nodes[0].parentId
          : null;
        const result = duplicateSelectionForDrag(working, ids, parent);
        prefix = result.operations;
        working = transact(working, {
          baseRevision: working.revision,
          operations: prefix,
        });
        ids = result.selection;
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
      appliedDelta: { x: 0, y: 0 },
      ids: selectionRoots(working, ids).map((n) => n.id),
      originalIds,
      fromTitle: Boolean(options?.directId),
      shiftToggleId: event.shiftKey && alreadySelected ? id : undefined,
      prefix,
      operations: prefix,
      moved: false,
    };
  }
  function preview(base: DesignDocument, operations: Operation[]) {
    if (!operations.length) return;
    try {
      const next = previewGeometry(base, operations);
      gesturePreview.current = next;
      e.setPreview(next);
    } catch (error) {
      e.setError(String(error));
    }
  }
  function canStartCanvasEdit() {
    return (
      !hasExternalPreview &&
      e.previewRef.current === null &&
      e.doc === e.committed &&
      e.historyRef.current.present === e.committed
    );
  }
  function gestureSuperseded(state: Gesture | null) {
    return (
      state &&
      "base" in state &&
      (hasExternalPreview ||
        state.base !== e.historyRef.current.present ||
        (e.previewRef.current !== null &&
          e.previewRef.current !== gesturePreview.current))
    );
  }
  function move(event: ReactPointerEvent) {
    const state = gesture.current;
    if (state && capturedPointer.current !== event.pointerId) return;
    if (gestureSuperseded(state)) return cancelCanvasGesture();
    const point = world({ x: event.clientX, y: event.clientY });
    if (!state) {
      const target = event.target as Element;
      let labelId = labelIdAt(target) ?? null;
      if (!labelId && artboardLabelsInteractive) {
        const hitId =
          target.closest<HTMLElement>("[data-node-id]")?.dataset.nodeId;
        let board = findLayer(e.doc, hitId ?? null);
        while (board && !labelNodeIds.has(board.id))
          board = findLayer(e.doc, board.parentId);
        const rect = board && bounds.get(board.id);
        if (board && board.type !== "section" && rect) {
          const visual = visualBounds(rect, matrices.get(board.id) ?? identity);
          if (Math.min(visual.width, visual.height) * viewRef.current.zoom < 32)
            labelId = board.id;
        }
      }
      if (artboardLabelsInteractive && labelId !== hoveredLabelId)
        setHoveredLabelId(labelId);
      if (altRef.current || devMode) {
        const directHit = (event.target as HTMLElement).closest<HTMLElement>(
          "[data-node-id]",
        )?.dataset.nodeId;
        setHover(devMode ? (directHit ?? null) : targetId(event));
      } else if (isLodActive) {
        const id = targetId(event);
        setHover(id ? rootIdOf(e.doc, id) : null);
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
      setView(
        {
          ...state.viewport,
          x: state.viewport.x + event.clientX - state.start.x,
          y: state.viewport.y + event.clientY - state.start.y,
        },
        true,
      );
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
    if (!state.moved) {
      setInteracting(true);
      if (state.kind === "drag" && state.prefix.length)
        e.setSelection(state.ids);
    }
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
          inFlow:
            parent?.type === "frame" &&
            parent.style.layout !== "free" &&
            !node.style.absolutePosition,
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
      delta = Math.abs(dx) >= Math.abs(dy) ? { x: dx, y: 0 } : { x: 0, y: dy };
    if (effectiveViewOptions.snapEnabled && !event.metaKey && !event.ctrlKey) {
      const result = snapMoveIndexed(
        { ...initial, x: initial.x + delta.x, y: initial.y + delta.y },
        snapIndex,
        5 / viewport.zoom,
      );
      const allowX = !event.shiftKey || Math.abs(dx) >= Math.abs(dy);
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
    state.appliedDelta = delta;
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
      parentData[0].inFlow &&
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
    if (gesture.current && capturedPointer.current !== event.pointerId) return;
    if (cancel || gestureSuperseded(gesture.current)) {
      cancelCanvasGesture();
      return;
    }
    const state = gesture.current;
    gesture.current = null;
    capturedPointer.current = null;
    if (!state || state.kind === "pan") return;
    setInteracting(false);
    setGuides([]);
    setGhost(null);
    setDropCell(undefined);
    setPencilStroke(null);
    clearGesturePreview();
    const point = world({ x: event.clientX, y: event.clientY });
    const drawn = boxRef.current;
    updateBox(null);
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
        const index = buildSpatialIndex(e.committed, layout, matrices);
        const context =
          e.selected.length === 1 && isContainer(e.selected[0])
            ? e.selected[0].id
            : null;
        const ids = index
          .queryRect(drawn)
          .filter(
            ({ id, parentId, rect, order }) =>
              (state.deep || parentId === context) &&
              !isLocked(e.committed, id) &&
              isVisible(e.committed, id) &&
              (!state.deep ||
                !isContainer(e.committed.nodes[order]) ||
                (contains(drawn, rect) &&
                  contains(drawn, {
                    x: rect.x + rect.width,
                    y: rect.y + rect.height,
                  }))),
          )
          .map((entry) => entry.id);
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
        const excluded = subtreeIds(state.working, state.ids);
        const target = containerAt(
          point,
          state.working,
          excluded,
          geometry,
          transforms,
          true,
        );
        const targetNode = findLayer(state.working, target);
        nodes.forEach((node, i) => {
          const oldParent = findLayer(state.working, node.parentId);
          // Canvas and section boards stay artboards when dropped over another board's contents.
          const artboard =
            (node.type === "frame" || node.componentSet) &&
            (!oldParent || oldParent.type === "section");
          if (
            targetNode?.componentSet &&
            !state.fromTitle &&
            (!artboard || nodes.length === 1) &&
            !node.componentSet &&
            node.type !== "section" &&
            node.parentId !== targetNode.id
          ) {
            if (nodes.length !== 1) throw Error("请一次拖入一个变体");
            operations.length = 0;
            operations.push(...state.prefix, {
              type: "includeSetDrawing",
              id: node.id,
              setId: targetNode.id,
            });
            return;
          }
          let destination = target;
          if (node.type === "section" || artboard) {
            const rect = visualBounds(
              geometry.get(node.id)!,
              transforms.get(node.id)!,
            );
            const finalRect = {
              ...rect,
              x: rect.x + state.appliedDelta.x,
              y: rect.y + state.appliedDelta.y,
            };
            destination = sectionParentAt(
              {
                x: finalRect.x + rect.width / 2,
                y: finalRect.y + rect.height / 2,
              },
              state.working,
              excluded,
              geometry,
              transforms,
            );
            if (
              destination === null &&
              oldParent?.type === "section" &&
              intersects(
                finalRect,
                visualBounds(
                  geometry.get(oldParent.id)!,
                  transforms.get(oldParent.id)!,
                ),
              )
            ) {
              destination = oldParent.id;
            }
          }
          const parent = findLayer(state.working, destination);
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
                destination ? geometry.get(destination) : undefined,
                transforms.get(destination ?? "") ?? identity,
                state.appliedDelta,
              ),
            });
          }
          const inFlow =
            parent?.type === "frame" &&
            parent.style.layout !== "free" &&
            !node.style.absolutePosition;
          const cell =
            inFlow &&
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
          } else if (inFlow) {
            const siblings = state.working.nodes.filter(
              (n) => n.parentId === destination && !state.ids.includes(n.id),
            );
            const axis = parent.style.layout === "row" ? "x" : "y",
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
          }
        });
        if (operations.length) e.apply(operations, state.base.revision);
      }
    });
  }
  function beginResize(event: ReactPointerEvent, handle: Handle) {
    event.stopPropagation();
    event.preventDefault();
    if (!canStartCanvasEdit() || gesture.current || handleDraggingRef.current)
      return;
    const base = e.committed;
    const items = selectionRoots(base, e.selection);
    if (
      !items.length ||
      items.some((n) => isLocked(base, n.id) || instanceAncestor(base, n.id))
    )
      return;
    const geometry = layoutBounds(base);
    const box = selectionBounds(
      base,
      items,
      geometry,
      sceneTransforms(base, geometry),
    );
    if (!box) return;
    if (!capturePointer(event.pointerId)) return;
    gesture.current = {
      kind: "resize",
      start: world({ x: event.clientX, y: event.clientY }),
      base,
      ids: items.map((n) => n.id),
      box,
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
    event.stopPropagation();
    event.preventDefault();
    if (!canStartCanvasEdit() || gesture.current || handleDraggingRef.current)
      return;
    const committedNode = findLayer(e.committed, roots[0].id);
    if (
      !committedNode ||
      isLocked(e.committed, committedNode.id) ||
      instanceAncestor(e.committed, committedNode.id)
    )
      return;
    const geometry = layoutBounds(e.committed);
    const b = geometry.get(committedNode.id)!;
    const parentInverse = inverse(
      committedNode.parentId
        ? sceneTransforms(e.committed, geometry).get(committedNode.parentId)!
        : identity,
    );
    const p = transform(
        parentInverse,
        world({ x: event.clientX, y: event.clientY }),
      ),
      center = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
    if (!capturePointer(event.pointerId)) return;
    setInteracting(true);
    gesture.current = {
      kind: "rotate",
      base: e.committed,
      id: committedNode.id,
      center,
      parentInverse,
      angle: (Math.atan2(p.y - center.y, p.x - center.x) * 180) / Math.PI,
      initial: committedNode.style.rotation ?? 0,
      operations: [],
    };
  }
  const selectedWorldRect =
    selectionBox && visualBounds(selectionBox, selectedMatrix);
  const hoveredBox = hover && bounds.get(hover);
  const hoverWorldRect =
    hover &&
    hoveredBox &&
    visualBounds(hoveredBox, matrices.get(hover) ?? identity);
  const measure = (() => {
    if (
      !hoverWorldRect ||
      !selectedWorldRect ||
      !hover ||
      e.selection.includes(hover)
    )
      return null;
    const inside =
      selectedWorldRect.x >= hoverWorldRect.x &&
      selectedWorldRect.y >= hoverWorldRect.y &&
      selectedWorldRect.x + selectedWorldRect.width <=
        hoverWorldRect.x + hoverWorldRect.width &&
      selectedWorldRect.y + selectedWorldRect.height <=
        hoverWorldRect.y + hoverWorldRect.height;
    if (inside) {
      return {
        inside: true as const,
        left: selectedWorldRect.x - hoverWorldRect.x,
        right:
          hoverWorldRect.x +
          hoverWorldRect.width -
          (selectedWorldRect.x + selectedWorldRect.width),
        top: selectedWorldRect.y - hoverWorldRect.y,
        bottom:
          hoverWorldRect.y +
          hoverWorldRect.height -
          (selectedWorldRect.y + selectedWorldRect.height),
        dx: selectedWorldRect.x - hoverWorldRect.x,
        dy: selectedWorldRect.y - hoverWorldRect.y,
      };
    }
    return {
      inside: false as const,
      dx: Math.max(
        0,
        Math.max(
          hoverWorldRect.x - selectedWorldRect.x - selectedWorldRect.width,
          selectedWorldRect.x - hoverWorldRect.x - hoverWorldRect.width,
        ),
      ),
      dy: Math.max(
        0,
        Math.max(
          hoverWorldRect.y - selectedWorldRect.y - selectedWorldRect.height,
          selectedWorldRect.y - hoverWorldRect.y - hoverWorldRect.height,
        ),
      ),
    };
  })();
  useEffect(() => {
    if (!active) return;
    const update = (event: KeyboardEvent) => {
      altRef.current = event.altKey;
      setAlt(event.altKey);
      if (!event.altKey && !devMode && !isLodActive) setHover(null);
    };
    window.addEventListener("keydown", update);
    window.addEventListener("keyup", update);
    return () => {
      window.removeEventListener("keydown", update);
      window.removeEventListener("keyup", update);
    };
  }, [active, devMode, isLodActive]);
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
  const selectedRootIds = useMemo(
    () => rootIdsOf(e.doc, e.selection),
    [e.doc, e.selection],
  );
  const editingId = e.editing ?? e.cropping ?? canvasRenamingId;
  const editingRootId = useMemo(
    () => editingId && rootIdOf(e.doc, editingId),
    [e.doc, editingId],
  );
  const hoveredId = hoveredLabelId ?? hover;
  const hoveredRootId = useMemo(
    () => hoveredId && rootIdOf(e.doc, hoveredId),
    [e.doc, hoveredId],
  );
  const activeGesture = interacting ? gesture.current : null;
  const draggingRootIds = useMemo(
    () =>
      rootIdsOf(
        e.doc,
        activeGesture?.kind === "rotate"
          ? [activeGesture.id]
          : activeGesture?.kind === "drag" || activeGesture?.kind === "resize"
            ? activeGesture.ids
            : undefined,
      ),
    [e.doc, activeGesture],
  );
  const aiPreviewRootIds = useMemo(
    () => rootIdsOf(e.doc, aiPreviewNodeIds),
    [e.doc, aiPreviewNodeIds],
  );
  const pinnedRoots = useMemo(() => {
    if (!cullRoots) return null;
    const ids = new Set([
      ...selectedRootIds,
      ...draggingRootIds,
      ...aiPreviewRootIds,
    ]);
    if (editingRootId) ids.add(editingRootId);
    return ids;
  }, [
    cullRoots,
    selectedRootIds,
    editingRootId,
    draggingRootIds,
    aiPreviewRootIds,
  ]);
  const visibleRootIds = useMemo(() => {
    if (!visibleWorldRect) return null;
    // A position preview only changes selected branches. Keep the full index on the
    // stable scene and check the few moving roots against the current geometry.
    const delta = positionDelta(e.doc);
    const scene = delta?.base ?? e.doc;
    const geometry = delta ? layoutBounds(scene) : bounds;
    const transforms = delta ? sceneTransforms(scene, geometry) : matrices;
    const index = buildSpatialIndex(scene, geometry, transforms);
    const ids = new Set(
      index.queryRootsInRect(visibleWorldRect).map((entry) => entry.id),
    );
    if (delta) {
      for (const id of delta.moved.keys()) {
        if (findLayer(e.doc, id)?.parentId !== null) continue;
        const rect = visualBounds(
          bounds.get(id)!,
          matrices.get(id) ?? identity,
        );
        if (intersects(rect, visibleWorldRect)) ids.add(id);
        else ids.delete(id);
      }
    }
    return ids;
  }, [visibleWorldRect, e.doc, bounds, matrices]);
  const labelScene = positionDelta(e.doc)?.base ?? e.doc;
  const labelNodes = useMemo(
    () => collectArtboardLabelNodes(labelScene),
    [labelScene],
  );
  const labelNodeIds = useMemo(
    () => new Set(labelNodes.map((node) => node.id)),
    [labelNodes],
  );
  const hoveredLabel = hoveredLabelId
    ? findLayer(e.doc, hoveredLabelId)
    : undefined;
  const hoverRect = hoveredLabel && bounds.get(hoveredLabel.id);
  function componentLabelRole(node: DesignNode) {
    if (node.componentSet) return "component-set";
    if (masters.has(node.id)) return "component";
    if (node.instance) return "instance";
  }
  function startLabelRename(id: string) {
    if (!canStartCanvasEdit()) return;
    if (!active || !artboardLabelsInteractive || isLocked(e.committed, id))
      return;
    flushForEditing();
    e.setSelection([id]);
    setCanvasRenamingId(id);
  }
  function commitLabelRename(id: string, nextName: string) {
    setCanvasRenamingId((current) => (current === id ? null : current));
    if (!canStartCanvasEdit()) return;
    const node = findLayer(e.committed, id);
    if (
      node &&
      nextName &&
      nextName !== node.name &&
      !isLocked(e.committed, id)
    )
      e.attempt(() =>
        e.apply([{ type: "update", id, patch: { name: nextName } }]),
      );
  }
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
            onClick={() =>
              setZoomExact(stepZoomLevel(viewRef.current.zoom, -1))
            }
          >
            <Minus size={14} />
          </button>
          <button
            ref={zoomReadoutRef}
            className="zoom-readout"
            title="缩放至 100%"
            data-tip="重置缩放至 100%"
            data-tip-kbd="⌘0"
            data-tip-desc="点击恢复 1:1 实际像素视图"
            data-tip-side="bottom"
            onClick={() => e.api.current?.zoom100()}
          />
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
            onClick={() => setZoomExact(stepZoomLevel(viewRef.current.zoom, 1))}
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
          <button
            type="button"
            className="icon-btn"
            aria-label="画布小地图"
            aria-pressed={minimapExpanded}
            data-tip="画布小地图"
            data-tip-kbd="⇧M"
            data-tip-desc="在右下角显示百屏缩略导航图，支持点击与拖拽快速定位"
            data-tip-side="bottom"
            onClick={() => handleToggleViewOption("showMinimap")}
          >
            <MapIcon size={15} />
          </button>
        </div>
      </div>
      <div
        ref={surface}
        className={`canvas editor-canvas canvas-stage ${interacting ? "is-interacting" : ""} ${fileDragActive ? "file-drop-active" : ""} ${effectiveViewOptions.outlineMode ? "is-outline-mode" : ""} ${devMode ? "is-dev-mode" : ""} ${space || currentTool === "hand" ? "panning-tool" : currentTool !== "select" && currentTool !== "scale" ? "drawing-tool" : ""}`}
        tabIndex={0}
        aria-label="设计画布"
        data-render-count={renderCount.current}
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
        onPointerDownCapture={(event) => {
          if (!active || gesture.current) {
            event.stopPropagation();
            return;
          }
          if ((event.target as Element).closest(".canvas-minimap")) return;
          if (
            event.button === 1 ||
            (event.button === 0 && (spaceRef.current || currentTool === "hand"))
          ) {
            down(event);
            event.stopPropagation();
          } else flushForEditing();
        }}
        onContextMenuCapture={flushForEditing}
        onPointerDown={down}
        onPointerMove={move}
        onPointerLeave={() => {
          setHover(null);
          setHoveredLabelId(null);
        }}
        onPointerUp={(event) => end(event)}
        onPointerCancel={(event) => end(event, true)}
        onLostPointerCapture={(event) => {
          if (event.target === surface.current) end(event, true);
        }}
        onDoubleClick={(event) => {
          if (hasExternalPreview || e.doc !== e.committed) return;
          if (devMode) return;
          const label = labelIdAt(
            event.target === surface.current
              ? document.elementFromPoint(event.clientX, event.clientY)
              : (event.target as Element),
          );
          if (label) {
            startLabelRename(label);
            return;
          }
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
              'input,textarea,[contenteditable="true"]',
            )
          )
            return;
          event.preventDefault();
          const labelId = labelIdAt(event.target as Element);
          const id = labelId ?? targetId(event);
          if (labelId) {
            if (!e.selection.includes(labelId)) e.setSelection([labelId]);
          } else if (!id) e.setSelection([]);
          else if (
            ![id, ...ancestors(e.doc, id).map((n) => n.id)].some((key) =>
              e.selection.includes(key),
            )
          )
            e.setSelection([shallow(id, event.metaKey || event.ctrlKey)]);
          const layers = [
            ...new Set([
              ...(labelId ? [labelId] : []),
              ...document
                .elementsFromPoint(event.clientX, event.clientY)
                .flatMap((el) => {
                  const key = (el as HTMLElement).dataset?.nodeId;
                  return key && !isLocked(e.doc, key) ? [key] : [];
                }),
            ]),
          ];
          contextMenu(event.clientX, event.clientY, layers);
        }}
        style={pageBgStyle}
      >
        <div
          ref={worldRef}
          className="canvas-world"
          style={tokenVars as CSSProperties}
        >
          <InlineTextContext.Provider value={e.editing ? e : null}>
            {rootNodes.map((node) => {
              const rect = bounds.get(node.id);
              if (
                visibleRootIds &&
                rect &&
                !pinnedRoots?.has(node.id) &&
                !visibleRootIds.has(node.id)
              ) {
                const resolved = resolveNode(e.doc, node);
                if (resolved.hidden) return null;
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
                      background: summaryFill(e.doc, resolved),
                      borderRadius: resolved.style.radius,
                      pointerEvents: "none",
                    }}
                  />
                );
              }
              const tileCandidate =
                isLodActive &&
                node.type === "frame" &&
                hasMoreDescendantsThan(e.doc, node.id, LOD_MIN_BOARD_NODES);
              const lodMode = resolveBoardLodMode({
                lodActive: isLodActive,
                node,
                descendantCount: tileCandidate ? LOD_MIN_BOARD_NODES + 1 : 0,
                isSelectedBranch: selectedRootIds.has(node.id),
                isHovered: hoveredRootId === node.id,
                isEditingBranch: editingRootId === node.id,
                isDragging: draggingRootIds.has(node.id),
                isAiPreview: aiPreviewRootIds.has(node.id),
                outlineMode: effectiveViewOptions.outlineMode,
                showLayoutGuides: effectiveViewOptions.showLayoutGuides,
                renderable:
                  tileCandidate && isBoardLodRenderable(e.doc, node.id, bounds),
                hasLayoutGuides:
                  tileCandidate &&
                  effectiveViewOptions.showLayoutGuides &&
                  branchHasLayoutGuides(e.doc, node.id),
              });
              if (lodMode === "cached" && rect)
                return (
                  <BoardLodTile
                    key={node.id}
                    document={e.doc}
                    node={node}
                    rect={rect}
                    bounds={bounds}
                    showLayoutGuides={effectiveViewOptions.showLayoutGuides}
                    zoom={viewport.zoom}
                  />
                );
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
        <CanvasOverlayHud
          camera={camera}
          surfaceSize={surfaceSize}
          showPixelGrid={effectiveViewOptions.showPixelGrid}
          guides={guides}
          measure={
            (alt || devMode) && measure && hoverWorldRect && selectedWorldRect
              ? {
                  selectionBox: selectedWorldRect,
                  hoverRect: hoverWorldRect,
                  ...measure,
                }
              : null
          }
        />
        <div className="canvas-live-overlays" ref={overlaysRef}>
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
          {hoveredLabel &&
            hoverRect &&
            artboardLabelsInteractive &&
            !e.selection.includes(hoveredLabel.id) && (
              <div
                aria-hidden="true"
                className={`artboard-hover-outline ${componentLabelRole(hoveredLabel) ? "is-component" : ""}`}
                style={oriented(
                  hoverRect,
                  matrices.get(hoveredLabel.id) ?? identity,
                )}
              />
            )}
          {labelNodes.map((node) => {
            const rect = bounds.get(node.id);
            if (!rect) return null;
            const rootId = node.parentId
              ? rootIdOf(e.doc, node.parentId)
              : node.id;
            if (
              visibleRootIds &&
              !pinnedRoots?.has(rootId) &&
              !visibleRootIds.has(rootId)
            )
              return null;
            const visual = visualBounds(
              rect,
              matrices.get(node.id) ?? identity,
            );
            const selected = e.selection.includes(node.id);
            const renaming = canvasRenamingId === node.id;
            const screenW = visual.width * viewport.zoom;
            const screenH = visual.height * viewport.zoom;
            if (
              node.type !== "section" &&
              !selected &&
              hoveredLabelId !== node.id &&
              !renaming &&
              Math.min(screenW, screenH) < 32
            )
              return null;
            return (
              <ArtboardLabel
                labelRole={
                  node.type === "section"
                    ? "section"
                    : (componentLabelRole(node) ?? "frame")
                }
                devStatus={
                  node.devStatus === "none" ? undefined : node.devStatus
                }
                maxWidth={
                  node.type === "section"
                    ? undefined
                    : Math.max(44, Math.min(240, Math.floor(screenW)))
                }
                key={node.id}
                nodeId={node.id}
                name={node.name}
                width={rect.width}
                height={rect.height}
                left={viewport.x + visual.x * viewport.zoom}
                top={viewport.y + visual.y * viewport.zoom - 8}
                selected={selected}
                locked={isLocked(e.committed, node.id)}
                interactive={artboardLabelsInteractive}
                renaming={renaming}
                onSelect={e.select}
                onBeginDrag={(event, id) =>
                  beginNodeDrag(event, id, { directId: true })
                }
                onHoverChange={setHoveredLabelId}
                onStartRename={startLabelRename}
                onCommitRename={commitLabelRename}
                onCancelRename={() => setCanvasRenamingId(null)}
              />
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
              data-selection-kind={
                isComponentSelection ? "component" : undefined
              }
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
              {roots.length === 1 &&
                selectedNode &&
                active &&
                !hasExternalPreview &&
                currentTool === "select" &&
                !prototypeMode &&
                !devMode &&
                !interacting &&
                !box &&
                !space && (
                  <>
                    <CornerRadiusHandles
                      onDragActiveChange={onHandleDragActiveChange}
                      editor={e}
                      node={selectedNode}
                      box={selectionBox}
                      matrix={selectedMatrix}
                      zoom={viewport.zoom}
                    />
                    <AutoLayoutHandles
                      onDragActiveChange={onHandleDragActiveChange}
                      editor={e}
                      node={selectedNode}
                      box={selectionBox}
                      bounds={bounds}
                      matrix={selectedMatrix}
                      zoom={viewport.zoom}
                    />
                  </>
                )}
              <span className="dimension-label">
                {Math.round(selectionBox.width)} ×{" "}
                {Math.round(selectionBox.height)}
              </span>
              {roots.length === 1 &&
                !hasExternalPreview &&
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
              {!hasExternalPreview &&
                !devMode &&
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
                active={active}
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
                      drawing.paths[0].fill
                        ? "rgba(13, 153, 255, 0.14)"
                        : "none"
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
          {guides.map((guide) => (
            <span
              key={guide.axis}
              className={`snap-guide guide-${guide.axis}`}
              data-value={guide.value}
              hidden
            />
          ))}
          {(alt || devMode) &&
            measure &&
            hoverWorldRect &&
            selectedWorldRect && (
              <>
                {measure.inside ? (
                  <>
                    {measure.left > 0 && (
                      <div
                        className="measure-line measure-line-x"
                        style={{
                          left: viewport.x + hoverWorldRect.x * viewport.zoom,
                          top:
                            viewport.y +
                            (selectedWorldRect.y +
                              selectedWorldRect.height / 2) *
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
                            (selectedWorldRect.x + selectedWorldRect.width) *
                              viewport.zoom,
                          top:
                            viewport.y +
                            (selectedWorldRect.y +
                              selectedWorldRect.height / 2) *
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
                            (selectedWorldRect.x +
                              selectedWorldRect.width / 2) *
                              viewport.zoom,
                          top: viewport.y + hoverWorldRect.y * viewport.zoom,
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
                            (selectedWorldRect.x +
                              selectedWorldRect.width / 2) *
                              viewport.zoom,
                          top:
                            viewport.y +
                            (selectedWorldRect.y + selectedWorldRect.height) *
                              viewport.zoom,
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
                              selectedWorldRect.x + selectedWorldRect.width,
                              hoverWorldRect.x + hoverWorldRect.width,
                            ) *
                              viewport.zoom,
                          top:
                            viewport.y +
                            (selectedWorldRect.y +
                              selectedWorldRect.height / 2) *
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
                            (selectedWorldRect.x +
                              selectedWorldRect.width / 2) *
                              viewport.zoom,
                          top:
                            viewport.y +
                            Math.min(
                              selectedWorldRect.y + selectedWorldRect.height,
                              hoverWorldRect.y + hoverWorldRect.height,
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
                        left: viewport.x + hoverWorldRect.x * viewport.zoom,
                        top: viewport.y + hoverWorldRect.y * viewport.zoom - 26,
                      }}
                    >
                      水平 {Math.round(measure.dx)} · 垂直{" "}
                      {Math.round(measure.dy)} px
                    </div>
                  </>
                )}
              </>
            )}
          {(e.tool === "pen" ||
            e.doc.nodes.some(
              (n) => n.id === e.editing && n.type === "vector",
            )) && (
            <div className="canvas-vector-editor" ref={vectorEditorRef}>
              <VectorEditor
                worldContainer={worldRef.current}
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
            </div>
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
          {effectiveViewOptions.showComments &&
            effectiveComments.length > 0 && (
              <CommentsCanvasLayer
                comments={effectiveComments}
                viewport={viewport}
                activeCommentId={effectiveActiveCommentId}
                onSelectComment={handleSelectComment}
                onUpdateComments={handleUpdateComments}
              />
            )}
        </div>
        {fileDragActive && (
          <div className="canvas-drop-hint" aria-hidden="true">
            释放以导入 Sketch、Figma、Forma 设计文件或图片 / SVG
          </div>
        )}
        {effectiveViewOptions.showRulers && (
          <CanvasRulers
            camera={camera}
            selection={selectedWorldRect ?? undefined}
            viewport={viewport}
            guides={e.committed.guides ?? []}
            change={(guides) =>
              e.attempt(() => e.apply([{ type: "setGuides", guides }]))
            }
          />
        )}
        <CanvasMinimap
          camera={camera}
          viewport={viewport}
          surfaceSize={surfaceSize}
          items={minimapItems}
          expanded={minimapExpanded}
          onNavigate={(next) => setView(next, true)}
          onToggleExpanded={() => handleToggleViewOption("showMinimap")}
          onFitAll={() => fit()}
        />
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
