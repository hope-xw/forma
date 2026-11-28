import {
  getAlignEligibility,
  isEditActionEnabled,
  type ActionId,
} from "./actions";
import { maxLayerDimension } from "../domain/document-limits";
import { editableRules, saveRules } from "../domain/layout-breakpoints";
import { LayoutBreakpoints } from "./LayoutBreakpoints";
import { FontAssets } from "./FontAssets";
import { GridTracks } from "./GridTracks";
import { typeSettings } from "../domain/font-settings";
import {
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { findLayer, childrenOf } from "../domain/scene-index";
import {
  flow,
  sizingMode,
  modeKey,
  type Axis,
  type SizeMode,
} from "../domain/sizing";
import { arrangeGrid } from "../domain/smart-selection";
import { layoutBounds } from "../domain/geometry";
import type { Operation } from "../domain/commands";
import {
  AlignLeft,
  AlignCenter,
  AlignRight,
  AlignJustify,
  AlignStartVertical as AlignLeftIcon,
  AlignCenterVertical as AlignCenterHIcon,
  AlignEndVertical as AlignRightIcon,
  AlignStartHorizontal as AlignTopIcon,
  AlignCenterHorizontal as AlignCenterVIcon,
  AlignEndHorizontal as AlignBottomIcon,
  AlignHorizontalSpaceAround,
  AlignVerticalSpaceAround,
  AlignVerticalJustifyStart,
  AlignVerticalJustifyCenter,
  AlignVerticalJustifyEnd,
  Move,
  ArrowRight as RowFlow,
  ArrowDown as ColumnFlow,
  Scan,
  Blend,
  WrapText,
  Grid2X2,
  FlipHorizontal2,
  FlipVertical2,
  RotateCw,
  Crosshair,
  Eye,
  EyeOff,
  Lock,
  Unlock,
  Plus,
  Trash2,
  ChevronUp,
  ChevronDown,
  Italic,
  Underline,
  Strikethrough,
  MoreHorizontal,
  Code2,
  LayoutPanelTop,
  Scissors,
  Shapes,
  Sparkles,
  X,
} from "lucide-react";

const BLEND_MODE_LABELS: Record<string, string> = {
  "pass-through": "穿透",
  normal: "正常",
  multiply: "正片叠底",
  screen: "滤色",
  overlay: "叠加",
  darken: "变暗",
  lighten: "变亮",
  "color-dodge": "颜色减淡",
  "color-burn": "颜色加深",
  "hard-light": "强光",
  "soft-light": "柔光",
  difference: "差值",
  exclusion: "排除",
  hue: "色相",
  saturation: "饱和度",
  color: "颜色",
  luminosity: "明度",
};
import type { DesignDocument, DesignNode, NodeStyle } from "../domain/document";
import {
  ancestors,
  instanceAncestor,
  isLocked,
  instanceOwner,
  instanceGeometryKeys,
  isContainer,
  subtreeIds,
} from "../domain/tree";
import {
  PopoverSurfaceContext,
  useAnchoredPopover,
} from "./useAnchoredPopover";
import { compositeSurface } from "../domain/surface-color";
import { fillUsesTextColor, maxShadows } from "../domain/node";
import { resolveNode } from "../domain/design-system";
import type { VariableProperty } from "../domain/design-properties";
import { useGestureEditor, type EditorController } from "./useEditor";
import { InstanceInspector } from "./InstanceInspector";
import { ColorField, type PaintChannel } from "./ColorField";
import { PropertyGlyph, BooleanIcon } from "./property-icons";
import { GradientEditor } from "./GradientEditor";
import { PaintStack } from "./PaintStack";
import { ImageFillTrigger, ImageInspector } from "./ImageInspector";
import { VectorInspector } from "./VectorInspector";
import { booleanNames, type BooleanOperation } from "../domain/boolean-shapes";
import { SelectionColors } from "./SelectionColors";
import { blendModes } from "../domain/node";
import { previewGeometry } from "../application/geometry-preview";
import { SizeLimits } from "./SizeLimits";
import { TokenBinding, StyleBinding, ModeSelectors } from "./TokenBinding";
import { ScalePanel } from "./ScalePanel";
import { LayoutGuidesInspector } from "./LayoutGuidesInspector";
import { ExportPanel } from "./ExportPanel";
function evalMath(raw: string): number | null {
  const s = raw.trim();
  if (!s) return null;
  const simple = Number(s);
  if (Number.isFinite(simple)) return simple;
  if (!/^[\d.\s+\-*/()]+$/.test(s)) return null;
  let i = 0;
  const skip = () => {
    while (i < s.length && s[i] === " ") i++;
  };
  const parseExpr = (): number => {
    let val = parseTerm();
    for (;;) {
      skip();
      if (s[i] === "+") {
        i++;
        val += parseTerm();
      } else if (s[i] === "-") {
        i++;
        val -= parseTerm();
      } else break;
    }
    return val;
  };
  const parseTerm = (): number => {
    let val = parseFactor();
    for (;;) {
      skip();
      if (s[i] === "*") {
        i++;
        val *= parseFactor();
      } else if (s[i] === "/") {
        i++;
        const rhs = parseFactor();
        val = rhs === 0 ? NaN : val / rhs;
      } else break;
    }
    return val;
  };
  const parseFactor = (): number => {
    skip();
    if (s[i] === "+") {
      i++;
      return parseFactor();
    }
    if (s[i] === "-") {
      i++;
      return -parseFactor();
    }
    if (s[i] === "(") {
      i++;
      const val = parseExpr();
      skip();
      if (s[i] !== ")") return NaN;
      i++;
      return val;
    }
    const start = i;
    while (i < s.length && ((s[i] >= "0" && s[i] <= "9") || s[i] === ".")) i++;
    if (i === start) return NaN;
    return Number(s.slice(start, i));
  };
  const result = parseExpr();
  skip();
  return i === s.length && Number.isFinite(result) ? result : null;
}
function Field({
  property,
  label,
  prefixText,
  suffix,
  value,
  onCommit,
  onPreview,
  disabled = false,
  percent = false,
  numeric: isNumeric = false,
  list,
  children,
}: {
  property?: keyof NodeStyle;
  label: string;
  prefixText?: string;
  suffix?: string;
  value: string | number | undefined;
  onCommit(value: string): void;
  onPreview?(value: string): void;
  disabled?: boolean;
  percent?: boolean;
  numeric?: boolean;
  list?: string;
  children?: React.ReactNode;
}) {
  const displayValue =
    value === undefined
      ? ""
      : String(
          percent && typeof value === "number"
            ? Math.round(value * 100)
            : typeof value === "number"
              ? Math.round(value * 100) / 100
              : value,
        );
  const [draft, setDraft] = useState(displayValue);
  const cancelledRef = useRef(false);
  useLayoutEffect(() => setDraft(displayValue), [displayValue]);
  const stopScrub = useRef<(() => void) | null>(null);
  useLayoutEffect(() => () => stopScrub.current?.(), [disabled]);
  const scrub = (ev: React.PointerEvent) => {
    if (
      ev.button !== 0 ||
      stopScrub.current ||
      !isNumeric ||
      disabled ||
      typeof value !== "number"
    )
      return;
    ev.preventDefault();
    const startX = ev.clientX;
    const base = percent ? Math.round(value * 100) : value;
    const target = ev.currentTarget as HTMLElement;
    target.setPointerCapture(ev.pointerId);
    let last = base;
    const onMove = (moveEv: PointerEvent) => {
      if (moveEv.pointerId !== ev.pointerId) return;
      const dx = moveEv.clientX - startX;
      const step = moveEv.shiftKey ? 10 : moveEv.altKey ? 0.1 : 1;
      const rawNext =
        Math.round((base + Math.round(dx / 2) * step) * 100) / 100;
      const next = percent ? Math.max(0, Math.min(100, rawNext)) : rawNext;
      if (next !== last) {
        last = next;
        setDraft(String(next));
        onPreview?.(percent ? String(next / 100) : String(next));
      }
    };
    const detach = () => {
      stopScrub.current = null;
      target.removeEventListener("pointermove", onMove);
      target.removeEventListener("pointerup", onUp);
      target.removeEventListener("pointercancel", onUp);
      target.removeEventListener("lostpointercapture", onUp);
    };
    stopScrub.current = () => {
      detach();
      onPreview?.("");
    };
    const onUp = (event: PointerEvent) => {
      if (event.pointerId !== ev.pointerId) return;
      detach();
      setDraft(displayValue);
      if (event.type === "pointerup" && last !== base)
        onCommit(
          percent
            ? String(Math.max(0, Math.min(100, last)) / 100)
            : String(last),
        );
      else onPreview?.("");
    };
    target.addEventListener("pointermove", onMove);
    target.addEventListener("pointerup", onUp);
    target.addEventListener("pointercancel", onUp);
    target.addEventListener("lostpointercapture", onUp);
  };
  return (
    <label
      className="property-field"
      title={label}
      data-tip={label}
      data-tip-desc={
        isNumeric && !disabled
          ? "左右拖动图标可调值，↑/↓ 键微调，支持四则运算"
          : undefined
      }
      data-tip-side="top"
    >
      <span
        className={`field-prefix ${isNumeric && !disabled ? "scrubbable" : ""}`}
        onPointerDown={scrub}
      >
        {prefixText ? (
          <span aria-hidden>{prefixText}</span>
        ) : (
          <PropertyGlyph property={property} label={label} />
        )}
      </span>
      <input
        aria-label={label}
        disabled={disabled}
        list={list}
        value={draft}
        placeholder={value === undefined ? "Mixed" : ""}
        onFocus={(e) => {
          cancelledRef.current = false;
          e.currentTarget.select();
        }}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={(event) => {
          const input = event.currentTarget.value;
          setDraft(displayValue);
          if (disabled || cancelledRef.current) return;
          if ((input !== "" || !isNumeric) && input !== displayValue) {
            if (isNumeric) {
              const computed = evalMath(input);
              if (computed === null) return;
              const clamped = percent
                ? Math.max(0, Math.min(100, computed))
                : computed;
              onCommit(percent ? String(clamped / 100) : String(clamped));
            } else {
              onCommit(input);
            }
          }
        }}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229)
            return;
          if (isNumeric && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
            e.preventDefault();
            if (draft.trim() === "") return;
            const cur = evalMath(draft);
            if (cur === null || !Number.isFinite(cur)) return;
            const delta =
              (e.key === "ArrowUp" ? 1 : -1) * (e.shiftKey ? 10 : 1);
            const next = Math.round((cur + delta) * 100) / 100;
            const clamped = percent ? Math.max(0, Math.min(100, next)) : next;
            setDraft(String(clamped));
            onCommit(percent ? String(clamped / 100) : String(clamped));
            return;
          }
          if (e.key === "Enter") {
            e.preventDefault();
            e.currentTarget.blur();
          }
          if (e.key === "Escape") {
            setDraft(displayValue);
            cancelledRef.current = true;
            e.currentTarget.blur();
          }
        }}
      />
      {percent && <small>%</small>}
      {!percent && suffix && <small>{suffix}</small>}
      {children}
    </label>
  );
}
const numericRanges: Partial<
  Record<keyof NodeStyle, [min: number, max: number, integer?: boolean]>
> = {
  width: [0, maxLayerDimension],
  height: [0, maxLayerDimension],
  radius: [0, 10000],
  gap: [0, 1000],
  rowGap: [0, 1000],
  padding: [0, 1000],
  strokeWidth: [0, 100],
  opacity: [0, 1],
  blur: [0, 100],
  backdropBlur: [0, 512],
  rotation: [-360, 360],
  fontWeight: [100, 900, true],
  fontSize: [1, 500],
  lineHeight: [1, 1000],
  letterSpacing: [-50, 200],
  columns: [1, 64, true],
  columnSpan: [1, 64, true],
  rowSpan: [1, 64, true],
  gridRowHeight: [1, 10000],
  minColumnWidth: [0, 10000],
};
const paddingEdges = [
  ["left", "左边距"],
  ["top", "上边距"],
  ["right", "右边距"],
  ["bottom", "下边距"],
] as const;
function paddingSides(style: NodeStyle) {
  const p = style.padding;
  return style.insets ?? { top: p, right: p, bottom: p, left: p };
}

const alignHints = {
  ok: "",
  preview: "请先确认或取消当前预览",
  locked: "选中包含锁定图层，请先解锁",
  instance: "组件实例内部图层不可直接对齐",
  inFlow: "自动布局内请调整布局对齐，或开启绝对定位后对齐",
  needMore: "请选中至少 2 个图层或容器内子图层",
  needThree: "请同时选中至少 3 个同级或独立图层",
};

export interface InspectorProps {
  tabActive?: boolean;
  canvasBackground?: string;
  editor: EditorController;
  tool?: string;
  onExitScale?(): void;
  onOpenBatchExport?(): void;
  onOpenDesignLint?(): void;
  onOpenInlineAgent?(): void;
  agentConfigured?: boolean;
  onApplyOperations?(ops: Operation[]): void;
}

function usePropertyGesture(editor: EditorController, scope: string) {
  const ownedPreviewRef = useRef<{ key: string; doc: DesignDocument } | null>(
    null,
  );
  const { setLocalPreview, committed, historyRef, apply } = editor;
  function cancel(key: string) {
    const owned = ownedPreviewRef.current;
    if (owned?.key !== key) return;
    setLocalPreview(owned.doc, null);
    ownedPreviewRef.current = null;
  }
  useLayoutEffect(
    () => () => {
      const owned = ownedPreviewRef.current;
      if (owned) setLocalPreview(owned.doc, null);
      ownedPreviewRef.current = null;
    },
    [scope, setLocalPreview],
  );
  function change(key: string, ops: Operation[], preview = false) {
    if (historyRef.current.present !== committed) return;
    const owned = ownedPreviewRef.current;
    if (
      (owned && owned.key !== key) ||
      editor.isExternalPreviewRef.current ||
      editor.previewRef.current !== (owned?.doc ?? null)
    )
      return;
    if (preview && ops.length) {
      const next = previewGeometry(committed, ops);
      if (setLocalPreview(owned?.doc ?? null, next))
        ownedPreviewRef.current = { key, doc: next };
    } else {
      cancel(key);
      if (!preview && ops.length) apply(ops, committed.revision);
    }
  }
  useLayoutEffect(() => {
    if (editor.hasExternalPreview) ownedPreviewRef.current = null;
  }, [editor.hasExternalPreview]);
  const owns = (key: string) =>
    ownedPreviewRef.current?.key === key &&
    ownedPreviewRef.current.doc === editor.previewRef.current &&
    !editor.isExternalPreviewRef.current;
  return { cancel, change, owns };
}

function contrastBackground(
  doc: DesignDocument,
  node: DesignNode,
  canvasBackground: string,
) {
  const layers = ancestors(doc, node.id).reverse();
  if (node.type === "button") layers.push(node);
  const page = compositeSurface(
    doc.pageBackground ?? canvasBackground,
    doc.pageBackgroundVisible === false ? 0 : (doc.pageBackgroundOpacity ?? 1),
    canvasBackground,
  );
  function paint(index: number, backdrop: string): string {
    if (index === layers.length) return backdrop;
    const layer = resolveNode(doc, layers[index]);
    const style = layer.style;
    let surface = backdrop;
    if (!["text", "group", "slice", "vector"].includes(layer.type)) {
      surface = compositeSurface(
        layer.fillToken
          ? (doc.tokens[layer.fillToken]?.value ?? style.fill)
          : style.fill,
        style.fillOpacity ?? 1,
        backdrop,
      );
      surface = (style.paints ?? []).reduceRight(
        (below, p) =>
          p.visible ? compositeSurface(p.color, p.opacity, below) : below,
        surface,
      );
    }
    // Parent opacity applies after its children have been painted as a group.
    return compositeSurface(
      paint(index + 1, surface),
      style.opacity ?? 1,
      backdrop,
    );
  }
  return paint(0, page);
}

export function Inspector({ tabActive = true, ...props }: InspectorProps) {
  const surfaceActive = useContext(PopoverSurfaceContext) && tabActive;
  return (
    <PopoverSurfaceContext.Provider value={surfaceActive}>
      <InspectorPanel {...props} tabActive={surfaceActive} />
    </PopoverSurfaceContext.Provider>
  );
}

function InspectorPanel({
  tabActive = true,
  canvasBackground = "#ffffff",
  editor,
  tool,
  onExitScale,
  onOpenBatchExport,
  onOpenInlineAgent,
  agentConfigured = false,
  onApplyOperations,
}: InspectorProps) {
  const scope = JSON.stringify([
    editor.doc.id,
    editor.doc.activePage,
    editor.selection,
  ]);
  const e = useGestureEditor(editor, scope);
  const gesture = usePropertyGesture(editor, scope);
  const previewBlocked = editor.hasExternalPreview;
  const smoothingPending = useRef<Operation[] | null>(null);
  useLayoutEffect(() => {
    smoothingPending.current = null;
  }, [scope, previewBlocked]);
  const [ratio, setRatio] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [blurOpen, setBlurOpen] = useState(false);
  const [typeDetailsOpen, setTypeDetailsOpen] = useState(false);
  const typeBtnRef = useRef<HTMLButtonElement>(null);
  const activeTool = tool ?? e.tool;
  const nodes = e.selected.map((n) => resolveNode(e.doc, n)),
    node = nodes[0];
  const anyLocked = previewBlocked || nodes.some((n) => isLocked(e.doc, n.id));
  useLayoutEffect(() => {
    setRatio(false);
    setTypeDetailsOpen(false);
  }, [e.selection]);
  const typeOpen = typeDetailsOpen && tabActive && !anyLocked;
  const closeTypeDetails = () => setTypeDetailsOpen(false);
  const typePopoverRef = useRef<HTMLDivElement>(null);
  // A queued field commit can still hold a handler from the active render.
  const canEditTypeDetails = () =>
    tabActive &&
    typePopoverRef.current?.isConnected &&
    typeBtnRef.current?.getClientRects().length;
  useAnchoredPopover({
    open: typeOpen,
    triggerRef: typeBtnRef,
    popoverRef: typePopoverRef,
    preferredSide: "left",
    onClose: closeTypeDetails,
  });
  useLayoutEffect(() => {
    if (anyLocked || !tabActive) setTypeDetailsOpen(false);
  }, [anyLocked, tabActive]);
  useLayoutEffect(() => {
    if (node && (node.style.blur || node.style.backdropBlur)) setBlurOpen(true);
  }, [node?.id, node?.style.blur, node?.style.backdropBlur]);
  const bounds = useMemo(() => layoutBounds(e.doc), [e.doc]);
  const getPalette = useCallback(() => {
    const colors = new Set<string>();
    for (const n of e.committed.nodes) {
      const resolved = resolveNode(e.committed, n);
      colors.add(resolved.style.fill);
      colors.add(resolved.style.color);
      if (resolved.style.stroke) colors.add(resolved.style.stroke);
      for (const p of [
        ...(resolved.style.paints ?? []),
        ...(resolved.style.strokePaints ?? []),
      ]) {
        if (p.visible) colors.add(p.color);
      }
      for (const stop of resolved.style.gradient?.stops ?? []) {
        colors.add(stop.color);
      }
      for (const sh of resolved.style.shadows ?? []) {
        if (sh.visible !== false) colors.add(sh.color);
      }
      if (colors.size >= 24) break;
    }
    return [...colors];
  }, [e.committed]);
  const parentOf = (n: DesignNode) => {
    const parent = findLayer(e.doc, n.parentId);
    return parent && resolveNode(e.doc, parent);
  };
  const sizingDisabled =
    anyLocked || nodes.some((n) => instanceAncestor(e.doc, n.id));
  function setSizing(modes: Partial<Record<Axis, SizeMode>>) {
    if (sizingDisabled) return;
    e.attempt(() =>
      e.apply(
        nodes.map((n) => {
          const style: Partial<NodeStyle> = {};
          for (const axis of ["width", "height"] as const) {
            const mode = modes[axis];
            if (!mode) continue;
            style[modeKey(axis)] = mode;
            if (mode === "hug")
              style[axis === "width" ? "constraintX" : "constraintY"] = "start";
            if (mode === "fixed")
              style[axis] = Math.min(
                maxLayerDimension,
                Math.max(0, bounds.get(n.id)![axis]),
              );
          }
          return { type: "update", id: n.id, patch: {}, style };
        }),
      ),
    );
  }
  const sizing = (axis: Axis) => {
    const key = modeKey(axis);
    const canHug = nodes.every(
      (n) =>
        n.type === "text" ||
        (n.type === "button" && axis === "width") ||
        (flow(n) &&
          !n.text &&
          !e.doc.nodes.some(
            (c) => c.parentId === n.id && c.style[key] === "fill",
          )),
    );
    const canFill = nodes.every((n) => {
      const p = parentOf(n);
      return flow(p) && p?.style[key] !== "hug";
    });
    return (
      <select
        aria-label={axis === "width" ? "宽度模式" : "高度模式"}
        title={axis === "width" ? "宽度模式" : "高度模式"}
        disabled={sizingDisabled}
        value={common((n) => sizingMode(n, parentOf(n), axis)) ?? ""}
        onChange={(event) =>
          setSizing({ [axis]: event.target.value as SizeMode })
        }
      >
        <option value="" hidden>
          Mixed
        </option>
        <option value="fixed">Fixed · 固定</option>
        <option value="hug" disabled={!canHug}>
          Hug · 适应内容
        </option>
        <option value="fill" disabled={!canFill}>
          Fill · 填满容器
        </option>
      </select>
    );
  };
  const common = <T,>(get: (n: DesignNode) => T): T | undefined =>
    nodes.every((n) => get(n) === get(node)) ? get(node) : undefined;
  const smoothing = common((n) => n.style.cornerSmoothing ?? 0);
  const smoothingText =
    smoothing === undefined ? "Mixed" : Math.round(smoothing * 100) + "%";
  function finishSmoothing() {
    const ops = smoothingPending.current;
    smoothingPending.current = null;
    if (ops && gesture.owns("cornerSmoothing"))
      e.attempt(() => gesture.change("cornerSmoothing", ops));
  }
  const layoutDisabled =
    anyLocked || nodes.some((n) => !!instanceOwner(e.doc, n.id));
  const hasInsets = nodes.some((n) => !!n.style.insets);
  const allInsets = nodes.every((n) => !!n.style.insets);
  const hasRowGap = nodes.every(
    (n) =>
      n.style.layout === "grid" || (n.style.layout === "row" && n.style.wrap),
  );
  const hasAutoLayoutParent = nodes.every((n) => {
    const p = parentOf(n);
    return (
      p?.type === "frame" &&
      (p.style.layout === "row" || p.style.layout === "column")
    );
  });
  const showSizing = nodes.some(
    (n) =>
      n.type === "text" ||
      flow(n) ||
      flow(parentOf(n)) ||
      (n.style.widthMode ?? "fixed") !== "fixed" ||
      (n.style.heightMode ?? "fixed") !== "fixed",
  );
  const inFlow = nodes.some((n) => {
    const p = parentOf(n);
    return (
      p?.type === "frame" &&
      p.style.layout !== "free" &&
      !n.style.absolutePosition
    );
  });
  const maskImageSource =
    nodes.length > 1 &&
    e.doc.nodes.find((n) => e.selection.includes(n.id))?.image;
  const allowed = (id: ActionId) =>
    isEditActionEnabled(id, e.actionEligibility);
  const { canAlign, canDistribute, reason } = getAlignEligibility(
    e.doc,
    e.selection,
    e.hasPreview,
  );
  const distributionReason = reason === "needMore" ? "needThree" : reason;
  const distributionDescription =
    distributionReason === "needThree"
      ? "请同时选中至少 3 个图层，父层与子层同时选中时只计父层。"
      : undefined;
  const protectedGeometry = (key: string) =>
    anyLocked ||
    (inFlow && (key === "x" || key === "y")) ||
    (nodes.some((n) => instanceAncestor(e.doc, n.id)) &&
      instanceGeometryKeys.has(key)) ||
    (nodes.some((n) => n.instance) &&
      [
        "layout",
        "gap",
        "rowGap",
        "columns",
        "gridTracks",
        "layoutBreakpoints",
        "gridRowHeight",
        "gridBreakpoint",
        "narrowColumns",
        "narrowGap",
        "minColumnWidth",
        "padding",
      ].includes(key));
  const numeric = (
    key: keyof NodeStyle,
    label: string,
    binding = true,
    prefixText?: string,
  ) => {
    const buildOps = (value: number) => {
      const allowNegativeGap =
        key === "gap" &&
        nodes.every(
          (n) =>
            (n.style.layout === "row" || n.style.layout === "column") &&
            !n.style.wrap,
        );
      const range = numericRanges[key];
      const min = allowNegativeGap ? -1000 : (range?.[0] ?? -Infinity);
      const max = range?.[1] ?? Infinity;
      const clamped = Math.max(
        min,
        Math.min(max, range?.[2] ? Math.round(value) : value),
      );
      const fixedModePatch =
        key === "width" || key === "height"
          ? { [modeKey(key)]: "fixed" as const }
          : {};
      if (ratio && (key === "width" || key === "height") && clamped > 0) {
        const other = key === "width" ? "height" : "width";
        return nodes.map((n) => {
          const b = bounds.get(n.id);
          const curW = (b?.[key] ?? n.style[key]) || 1;
          const curO = b?.[other] ?? n.style[other];
          return {
            type: "update" as const,
            id: n.id,
            patch: {},
            style: {
              [key]: clamped,
              [other]: Math.min(
                maxLayerDimension,
                Math.max(0, Math.round((100 * curO * clamped) / curW) / 100),
              ),
              [modeKey(key)]: "fixed" as const,
              [modeKey(other)]: "fixed" as const,
            },
          };
        });
      }
      return nodes.map((n) => ({
        type: "update" as const,
        id: n.id,
        patch: {},
        style: {
          [key]: clamped,
          ...(key === "width" || key === "height"
            ? sizingMode(n, parentOf(n), key) !== "fixed"
              ? fixedModePatch
              : {}
            : {}),
        },
      }));
    };
    return (
      <Field
        key={scope + key}
        property={key}
        prefixText={prefixText}
        label={label}
        suffix={key === "rotation" ? "°" : undefined}
        numeric
        value={common((n) =>
          key === "width" || key === "height"
            ? Math.round(bounds.get(n.id)![key] * 100) / 100
            : typeof n.style[key] === "number"
              ? Math.round((n.style[key] as number) * 100) / 100
              : (
                  {
                    opacity: 1,
                    fillOpacity: 1,
                    strokeWidth: 0,
                    blur: 0,
                    backdropBlur: 0,
                    fontWeight: 400,
                    lineHeight: Math.round(n.style.fontSize * 1.4 * 100) / 100,
                    rowGap: n.style.gap,
                    columns: 2,
                    columnSpan: 1,
                    rowSpan: 1,
                    narrowColumns: 1,
                    narrowGap: n.style.gap,
                    rotation: 0,
                    minColumnWidth: 0,
                    letterSpacing: 0,
                  } as Partial<Record<keyof NodeStyle, number>>
                )[key],
        )}
        disabled={protectedGeometry(key)}
        percent={key === "opacity"}
        onPreview={(v) => {
          if (!v) gesture.cancel(key);
          else if (Number.isFinite(Number(v)))
            e.attempt(() => gesture.change(key, buildOps(Number(v)), true));
        }}
        onCommit={(v) => {
          if (Number.isFinite(Number(v)))
            e.attempt(() => gesture.change(key, buildOps(Number(v))));
        }}
      >
        {binding && (
          <TokenBinding
            editor={e}
            property={key as VariableProperty}
            disabled={protectedGeometry(key)}
          />
        )}
      </Field>
    );
  };
  const updateEachStyle = (
    change: (n: DesignNode) => Partial<NodeStyle> | undefined,
    preview = false,
    gestureKey = "style",
  ) =>
    e.attempt(() => {
      const ops = nodes.flatMap((n) => {
        const style = change(n);
        return style
          ? [{ type: "update" as const, id: n.id, patch: {}, style }]
          : [];
      });
      if (!ops.length) return;
      gesture.change(gestureKey, ops, preview);
    });
  type Shadow = NonNullable<NodeStyle["shadows"]>[number];
  const sharedShadowCount = Math.min(
    ...nodes.map((n) => n.style.shadows?.length ?? 0),
  );
  const moveShadow = (index: number, target: number) =>
    updateEachStyle((n) => {
      const shadows = [...(n.style.shadows ?? [])];
      if (!shadows[index] || !shadows[target]) return;
      [shadows[index], shadows[target]] = [shadows[target], shadows[index]];
      return { shadows };
    });
  const changeShadow = (
    index: number,
    patch: Partial<Shadow>,
    preview = false,
  ) =>
    updateEachStyle(
      (n) => ({
        shadows: n.style.shadows?.map((s, i) =>
          i === index ? { ...s, ...patch } : s,
        ),
      }),
      preview,
      "shadow-" + index,
    );
  const blocked = useMemo(
    () => (moreOpen ? subtreeIds(e.doc, e.selection) : new Set<string>()),
    [e.doc, e.selection, moreOpen],
  );
  const text = nodes.every((n) => n.type === "text" || n.type === "button");
  const fillProperty = (n: DesignNode) =>
    fillUsesTextColor(n) ? "color" : "fill";
  const colorProperty = common(fillProperty);
  const colors = (property: "base" | "color" | "stroke", label: string) => {
    const keyFor = (n: DesignNode) =>
      property === "base" ? fillProperty(n) : property;
    const alphaFor = (n: DesignNode) => `${keyFor(n)}Opacity` as const;
    const currentColor = (n: DesignNode) =>
      (keyFor(n) === "fill" && n.fillToken
        ? (e.doc.tokens[n.fillToken]?.value ?? n.style.fill ?? "#000000")
        : (n.style[keyFor(n)] ?? "#000000")
      ).toLowerCase();
    const currentAlpha = (n: DesignNode) => n.style[alphaFor(n)] ?? 1;
    const binding = common(keyFor);
    const buildColorOps = (
      color: string,
      alpha: number,
      channel: PaintChannel,
    ) =>
      e.committed.nodes
        .filter((layer) => e.selection.includes(layer.id))
        .flatMap((raw) => {
          const layer = resolveNode(e.committed, raw);
          const key = keyFor(layer),
            alphaKey = alphaFor(layer);
          const recolor =
            channel !== "alpha" && currentColor(layer) !== color.toLowerCase();
          const fade = channel !== "color" && currentAlpha(layer) !== alpha;
          return recolor || fade
            ? [
                {
                  type: "update" as const,
                  id: layer.id,
                  patch:
                    recolor && key === "fill" ? { fillToken: undefined } : {},
                  style: {
                    ...(recolor ? { [key]: color } : {}),
                    ...(fade ? { [alphaKey]: alpha } : {}),
                  },
                },
              ]
            : [];
        });
    const contrastBg =
      property === "color" || (property === "base" && keyFor(node) === "color")
        ? contrastBackground(e.doc, node, canvasBackground)
        : undefined;
    return (
      <div className="paint-row">
        <ColorField
          label={label}
          color={currentColor(node)}
          alpha={currentAlpha(node)}
          mixedColor={common(currentColor) === undefined}
          mixedAlpha={common(currentAlpha) === undefined}
          contrastAgainst={contrastBg}
          disabled={anyLocked}
          palette={getPalette}
          onCancelPreview={() => gesture.cancel(property)}
          onPreview={(color, alpha, channel) =>
            e.attempt(() =>
              gesture.change(
                property,
                buildColorOps(color, alpha, channel),
                true,
              ),
            )
          }
          onChange={(color, alpha, channel) =>
            e.attempt(() =>
              gesture.change(property, buildColorOps(color, alpha, channel)),
            )
          }
        />
        {binding && (
          <TokenBinding editor={e} property={binding} disabled={anyLocked} />
        )}
      </div>
    );
  };
  const hasObjectActions =
    allowed("mask") ||
    (nodes.length === 1 && !!node.maskSourceId) ||
    allowed("union") ||
    (nodes.length === 1 &&
      (!!node.booleanOperation ||
        parentOf(node)?.booleanOperation === "compound"));
  const supportsDevStatus = nodes.some(
    (n) =>
      n.type === "frame" ||
      n.type === "section" ||
      !!n.instance ||
      !!n.componentSet,
  );
  const allDevReady =
    nodes.length > 0 &&
    nodes.every((n) => n.devStatus === "ready" || n.devStatus === "completed");
  const isSingleSlice = nodes.length === 1 && node.type === "slice";
  const isSingleSection = nodes.length === 1 && node.type === "section";
  const sectionChildCount = isSingleSection
    ? childrenOf(e.doc, node.id).length
    : 0;
  const applyScaleOps = (ops: Operation[]) => {
    if (e.isExternalPreviewRef.current) return;
    if (onApplyOperations) onApplyOperations(ops);
    else e.attempt(() => e.apply(ops));
  };
  return (
    <>
      {activeTool === "scale" && nodes.length > 0 && (
        <ScalePanel
          previewBlocked={previewBlocked}
          document={e.committed}
          selectedIds={e.selection}
          onApplyOperations={applyScaleOps}
          onExitScale={() =>
            onExitScale ? onExitScale() : e.setTool("select")
          }
        />
      )}
      <div className="object-heading">
        <Field
          label="名称"
          disabled={nodes.length !== 1 || anyLocked}
          value={nodes.length === 1 ? node.name : `${nodes.length} 个图层`}
          onCommit={(name) => {
            if (nodes.length === 1 && name.trim())
              e.update({ name: name.trim() });
          }}
        />
        {onOpenInlineAgent && (
          <button
            type="button"
            className={`inspector-ai-btn ${agentConfigured ? "is-ready" : ""}`}
            title="用 AI 生成或编辑选中图层"
            aria-label="用 AI 生成或编辑选中图层"
            data-tip="AI 对话生成 / 编辑"
            data-tip-kbd="⌘↵"
            data-tip-desc="唤起 Agent 对话框，直接通过对话对当前选中图层生成或修改设计"
            data-tip-side="left"
            onClick={onOpenInlineAgent}
          >
            <Sparkles size={12} />
            <span>AI</span>
          </button>
        )}
        {supportsDevStatus && (
          <button
            type="button"
            className={`icon-btn icon-btn-sm ${allDevReady ? "active" : ""}`}
            title={
              allDevReady
                ? "已标记为待开发 (点击取消)"
                : "标记为待开发 (Ready for dev)"
            }
            aria-label="切换待开发状态"
            aria-pressed={allDevReady}
            data-tip={allDevReady ? "取消待开发标记" : "标记为待开发"}
            data-tip-desc="在图层树与 Dev Mode 中高亮标出待交付页面或分区"
            data-tip-side="top"
            disabled={anyLocked}
            style={
              allDevReady
                ? {
                    color: "var(--figma-green, #14ae5c)",
                    background: "rgba(20, 174, 92, 0.14)",
                  }
                : undefined
            }
            onClick={() =>
              e.update({ devStatus: allDevReady ? "none" : "ready" })
            }
          >
            <Code2 size={14} />
          </button>
        )}
        <button
          className="icon-btn icon-btn-sm"
          title="显示 / 隐藏"
          aria-label="切换图层可见性"
          data-tip={nodes.every((n) => n.hidden) ? "显示图层" : "隐藏图层"}
          data-tip-kbd="⇧⌘H"
          data-tip-side="top"
          disabled={!allowed("hide")}
          onClick={() => e.perform("hide")}
        >
          {nodes.every((n) => n.hidden) ? (
            <EyeOff size={14} />
          ) : (
            <Eye size={14} />
          )}
        </button>
        <button
          className="icon-btn icon-btn-sm"
          title="锁定 / 解锁"
          aria-label="切换图层锁定"
          data-tip={nodes.every((n) => n.locked) ? "解锁图层" : "锁定图层"}
          data-tip-kbd="⇧⌘L"
          data-tip-side="top"
          disabled={!allowed("lock")}
          onClick={() => e.perform("lock")}
        >
          {nodes.every((n) => n.locked) ? (
            <Lock size={14} />
          ) : (
            <Unlock size={14} />
          )}
        </button>
      </div>
      {isSingleSection && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 6,
            padding: "6px 12px",
            borderBottom: "1px solid var(--border-subtle)",
            fontSize: 11,
            color: "var(--text-secondary)",
          }}
        >
          <span
            style={{ display: "inline-flex", alignItems: "center", gap: 5 }}
          >
            <LayoutPanelTop size={13} />
            <span>画布分区 · {sectionChildCount} 个图层</span>
          </span>
          {(node.devStatus === "ready" || node.devStatus === "completed") && (
            <span
              style={{
                padding: "1px 6px",
                borderRadius: 4,
                fontSize: 10,
                fontWeight: 600,
                background: "rgba(20, 174, 92, 0.14)",
                color: "var(--figma-green, #14ae5c)",
                border: "1px solid rgba(20, 174, 92, 0.3)",
              }}
            >
              {node.devStatus === "completed" ? "已完成" : "Ready for dev"}
            </span>
          )}
        </div>
      )}
      {isSingleSlice && (
        <>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              padding: "6px 12px",
              borderBottom: "1px solid var(--border-subtle)",
              fontSize: 11,
              color: "var(--text-secondary)",
            }}
          >
            <Scissors
              size={13}
              style={{ color: "var(--figma-blue, #0d99ff)" }}
            />
            <span>导出切片 · 仅用于静态与批量资产导出</span>
          </div>
          <section>
            <div className="section-title">位置与尺寸</div>
            <div className="property-grid">
              {numeric("x", "X", false)}
              {numeric("y", "Y", false)}
              {numeric("width", "宽度")}
              {numeric("height", "高度")}
            </div>
          </section>
          <ExportPanel
            previewBlocked={previewBlocked}
            document={e.committed}
            node={node}
            onUpdateSettings={(exportSettings) =>
              e.update({
                exportSettings: exportSettings.length
                  ? exportSettings
                  : undefined,
              })
            }
            onOpenBatchExport={onOpenBatchExport}
          />
          <section>
            <button
              className="danger wide"
              disabled={!allowed("delete")}
              onClick={() => e.perform("delete")}
            >
              删除切片
            </button>
          </section>
        </>
      )}
      {!isSingleSlice && (
        <>
          {hasObjectActions && (
            <div className="object-actions-bar" aria-label="对象布尔与蒙版操作">
              {allowed("mask") && (
                <button
                  className="icon-btn icon-btn-sm"
                  aria-label={maskImageSource ? "用作位图蒙版" : "用作矢量蒙版"}
                  title="用底层图层作蒙版"
                  data-tip={maskImageSource ? "用作位图蒙版" : "用作矢量蒙版"}
                  data-tip-kbd="⌃⌘M"
                  data-tip-desc="以最底层图层轮廓裁剪其上方的所选图层"
                  data-tip-side="top"
                  onClick={() => e.perform("mask")}
                >
                  <Blend size={15} />
                </button>
              )}
              {node.maskSourceId &&
                nodes.length === 1 &&
                e.doc.nodes.find((n) => n.id === node.maskSourceId)?.image && (
                  <select
                    aria-label="蒙版类型"
                    value={node.maskType ?? "vector"}
                    disabled={
                      previewBlocked ||
                      isLocked(e.doc, node.id) ||
                      !!instanceOwner(e.doc, node.id)
                    }
                    onChange={(ev) =>
                      e.update({
                        maskType: ev.target.value as DesignNode["maskType"],
                      })
                    }
                  >
                    <option value="vector">矢量轮廓</option>
                    <option value="alpha">Alpha · 透明度</option>
                    <option value="luminance">亮度</option>
                  </select>
                )}
              {nodes.length === 1 && node.maskSourceId && (
                <button
                  className="icon-btn icon-btn-sm"
                  aria-label="解除蒙版"
                  title="解除蒙版"
                  data-tip="解除蒙版"
                  data-tip-desc="恢复被裁剪的图层并取消蒙版关联"
                  data-tip-side="top"
                  disabled={!allowed("releaseMask")}
                  onClick={() => e.perform("releaseMask")}
                >
                  <Blend size={15} />
                </button>
              )}
              {allowed("union") && (
                <div
                  className="boolean-tools"
                  role="group"
                  aria-label="布尔运算"
                >
                  {(Object.keys(booleanNames) as BooleanOperation[]).map(
                    (mode) => (
                      <button
                        key={mode}
                        className="icon-btn icon-btn-sm"
                        aria-label={booleanNames[mode]}
                        data-tip={booleanNames[mode]}
                        title={booleanNames[mode]}
                        onClick={() => e.perform(mode)}
                      >
                        <BooleanIcon mode={mode} />
                      </button>
                    ),
                  )}
                </div>
              )}
              {nodes.length === 1 &&
                parentOf(node)?.booleanOperation === "compound" && (
                  <select
                    aria-label="子路径运算"
                    value={node.operandOperation ?? "compound"}
                    disabled={
                      previewBlocked ||
                      isLocked(e.doc, node.id) ||
                      !!instanceOwner(e.doc, node.id)
                    }
                    onChange={(ev) =>
                      e.update({
                        operandOperation:
                          ev.target.value === "compound"
                            ? undefined
                            : (ev.target.value as BooleanOperation),
                      })
                    }
                  >
                    <option value="compound">保留轮廓</option>
                    {Object.entries(booleanNames).map(([id, name]) => (
                      <option key={id} value={id}>
                        {name}
                      </option>
                    ))}
                  </select>
                )}
              {nodes.length === 1 && node.booleanOperation && (
                <select
                  aria-label="布尔运算类型"
                  value={node.booleanOperation}
                  disabled={
                    previewBlocked ||
                    isLocked(e.doc, node.id) ||
                    !!instanceOwner(e.doc, node.id)
                  }
                  onChange={(ev) =>
                    e.update({
                      booleanOperation: ev.target.value as BooleanOperation,
                    })
                  }
                >
                  {node.booleanOperation === "compound" && (
                    <option value="compound">复合路径</option>
                  )}
                  {Object.entries(booleanNames).map(([id, name]) => (
                    <option key={id} value={id}>
                      {name}
                    </option>
                  ))}
                </select>
              )}
              {nodes.length === 1 && node.booleanOperation && (
                <button
                  className="icon-btn icon-btn-sm"
                  title="拼合为矢量"
                  aria-label="拼合为矢量"
                  data-tip="拼合为矢量"
                  data-tip-kbd="⌘E"
                  disabled={
                    previewBlocked ||
                    isLocked(e.doc, node.id) ||
                    !!instanceOwner(e.doc, node.id)
                  }
                  onClick={() =>
                    e.attempt(() =>
                      e.apply([{ type: "flattenBoolean", id: node.id }]),
                    )
                  }
                >
                  <Grid2X2 size={14} />
                </button>
              )}
            </div>
          )}
          <fieldset disabled={previewBlocked} style={{ display: "contents" }}>
            <InstanceInspector editor={e} />
          </fieldset>
          <section>
            <div className="alignment-toolbar">
              {(
                [
                  { id: "left", name: "左对齐", icon: AlignLeftIcon },
                  { id: "center", name: "水平居中", icon: AlignCenterHIcon },
                  { id: "right", name: "右对齐", icon: AlignRightIcon },
                  { id: "top", name: "顶对齐", icon: AlignTopIcon },
                  { id: "middle", name: "垂直居中", icon: AlignCenterVIcon },
                  { id: "bottom", name: "底对齐", icon: AlignBottomIcon },
                ] as const
              ).map((a) => (
                <button
                  key={a.id}
                  data-align-id={a.id}
                  aria-label={a.name}
                  title={a.name}
                  data-tip={a.name}
                  data-tip-desc={
                    canAlign ? "按选区边界或父容器对齐图层" : alignHints[reason]
                  }
                  data-tip-side="top"
                  disabled={!canAlign}
                  onClick={() => e.align(a.id)}
                >
                  <a.icon size={15} />
                </button>
              ))}
              <button
                data-align-id="horizontal"
                title="水平等距分布"
                aria-label="水平分布"
                data-tip="水平等距分布"
                data-tip-desc={
                  canDistribute
                    ? "使所选图层在水平方向均匀分布间距"
                    : alignHints[distributionReason]
                }
                data-tip-side="top"
                aria-description={distributionDescription}
                disabled={!canDistribute}
                onClick={() => e.align("horizontal")}
              >
                <AlignHorizontalSpaceAround size={15} />
              </button>
              <button
                data-align-id="vertical"
                title="垂直等距分布"
                aria-label="垂直分布"
                data-tip="垂直等距分布"
                data-tip-desc={
                  canDistribute
                    ? "使所选图层在垂直方向均匀分布间距"
                    : alignHints[distributionReason]
                }
                data-tip-side="top"
                aria-description={distributionDescription}
                disabled={!canDistribute}
                onClick={() => e.align("vertical")}
              >
                <AlignVerticalSpaceAround size={15} />
              </button>
            </div>
            {e.smartGrid && (
              <div className="smart-controls">
                <button
                  title="智能整理"
                  aria-label="智能整理"
                  data-tip="智能整理排列"
                  data-tip-desc="自动对齐所选多个图层并统一行列间距"
                  data-tip-side="top"
                  disabled={!allowed("tidy")}
                  onClick={() => e.perform("tidy")}
                >
                  <Grid2X2 size={15} />
                </button>
                {(["gapX", "gapY"] as const).map((axis) => (
                  <Field
                    key={axis}
                    numeric
                    property={axis === "gapX" ? "gap" : "rowGap"}
                    label={axis === "gapX" ? "选区水平间距" : "选区垂直间距"}
                    value={e.smartGrid![axis]}
                    disabled={
                      axis === "gapX"
                        ? e.smartGrid!.columns === 1
                        : e.smartGrid!.columns === e.smartGrid!.items.length
                    }
                    onCommit={(raw) => {
                      const val = Number(raw);
                      if (!Number.isFinite(val) || val < 0) return;
                      const ops = arrangeGrid({ ...e.smartGrid!, [axis]: val });
                      if (ops.length) e.attempt(() => e.apply(ops));
                    }}
                  />
                ))}
              </div>
            )}
            <div className="section-title">
              位置
              {hasAutoLayoutParent && (
                <button
                  type="button"
                  className={`icon-btn icon-btn-sm ${nodes.every((n) => n.style.absolutePosition) ? "active" : ""}`}
                  aria-label="忽略自动布局（绝对定位）"
                  aria-pressed={nodes.every((n) => !!n.style.absolutePosition)}
                  data-tip="绝对定位 (Ignore auto layout)"
                  data-tip-desc="使此图层脱离自动布局流，按 X/Y 坐标定位"
                  data-tip-side="left"
                  disabled={
                    previewBlocked ||
                    nodes.some(
                      (n) =>
                        isLocked(e.doc, n.id) || instanceAncestor(e.doc, n.id),
                    )
                  }
                  onClick={() =>
                    e.update(
                      {},
                      {
                        absolutePosition: !nodes.every(
                          (n) => !!n.style.absolutePosition,
                        ),
                      },
                    )
                  }
                >
                  <Crosshair size={13} />
                </button>
              )}
            </div>
            <div className="property-grid">
              {numeric("x", "X", false)}
              {numeric("y", "Y", false)}
              {numeric("rotation", "旋转角度", false)}
              <div className="flip-group" role="group" aria-label="旋转与翻转">
                <button
                  type="button"
                  aria-label="顺时针旋转 90°"
                  data-tip="旋转 90°"
                  title="顺时针旋转 90°"
                  disabled={
                    previewBlocked ||
                    nodes.some(
                      (n) =>
                        isLocked(e.doc, n.id) || instanceAncestor(e.doc, n.id),
                    )
                  }
                  onClick={() =>
                    updateEachStyle((n) => ({
                      rotation:
                        (((n.style.rotation ?? 0) + 90 + 180) % 360) - 180,
                    }))
                  }
                >
                  <RotateCw size={13} />
                </button>
                {(["flipX", "flipY"] as const).map((key, i) => (
                  <button
                    key={key}
                    aria-label={i ? "垂直翻转" : "水平翻转"}
                    data-tip={i ? "垂直翻转" : "水平翻转"}
                    data-tip-kbd={i ? "⇧V" : "⇧H"}
                    title={i ? "垂直翻转" : "水平翻转"}
                    disabled={
                      previewBlocked ||
                      nodes.some(
                        (n) =>
                          isLocked(e.doc, n.id) ||
                          instanceAncestor(e.doc, n.id),
                      )
                    }
                    aria-pressed={nodes.every((n) => n.style[key])}
                    onClick={() => e.flipSelection(i ? "y" : "x")}
                  >
                    {i ? (
                      <FlipVertical2 size={14} />
                    ) : (
                      <FlipHorizontal2 size={14} />
                    )}
                  </button>
                ))}
              </div>
            </div>
          </section>
          <section>
            <div className="section-title">
              布局
              <button
                className="icon-btn icon-btn-sm"
                title="锁定宽高比"
                aria-label="锁定宽高比"
                data-tip={ratio ? "已锁定宽高比" : "锁定宽高比"}
                data-tip-desc="修改宽或高时按原比例等比缩放"
                data-tip-side="left"
                aria-pressed={ratio}
                onClick={() => setRatio(!ratio)}
              >
                {ratio ? <Lock size={14} /> : <Unlock size={14} />}
              </button>
            </div>
            {nodes.every((n) => n.type === "frame") && (
              <div
                className="layout-options"
                role="group"
                aria-label="自动布局"
                style={{ marginBottom: 6 }}
              >
                {(["free", "row", "column", "grid"] as const).map(
                  (layout, i) => (
                    <button
                      className={
                        common((n) => n.style.layout) === layout ? "active" : ""
                      }
                      aria-pressed={common((n) => n.style.layout) === layout}
                      key={layout}
                      disabled={layoutDisabled}
                      title={
                        ["自由定位", "水平排列", "垂直排列", "网格布局"][i]
                      }
                      data-tip={
                        [
                          "自由定位",
                          "水平自动布局",
                          "垂直自动布局",
                          "网格布局",
                        ][i]
                      }
                      data-tip-kbd={i === 2 ? "⇧A" : undefined}
                      data-tip-desc={
                        [
                          "子图层使用坐标与约束自由定位",
                          "按水平行依次排布子图层并控制间距",
                          "按垂直列依次排布子图层并控制间距",
                          "按列数或最小列宽自动网格排布",
                        ][i]
                      }
                      data-tip-side="top"
                      aria-label={
                        ["自由定位", "水平排列", "垂直排列", "网格布局"][i]
                      }
                      onClick={() => e.update({}, { layout })}
                    >
                      {
                        [
                          <Move size={15} />,
                          <RowFlow size={15} />,
                          <ColumnFlow size={15} />,
                          <Grid2X2 size={15} />,
                        ][i]
                      }
                    </button>
                  ),
                )}
                {nodes.every((n) => n.style.layout === "row") && (
                  <button
                    title="自动换行"
                    aria-label="自动换行"
                    data-tip="自动换行"
                    data-tip-desc="水平排列超出容器宽度时自动折行显示"
                    data-tip-side="top"
                    aria-pressed={nodes.every((n) => n.style.wrap)}
                    className={nodes.every((n) => n.style.wrap) ? "active" : ""}
                    disabled={layoutDisabled}
                    onClick={() =>
                      e.update({}, { wrap: !nodes.every((n) => n.style.wrap) })
                    }
                  >
                    <WrapText size={15} />
                  </button>
                )}
              </div>
            )}
            <div className="property-grid">
              {numeric("width", "宽度")}
              {numeric("height", "高度")}
              {showSizing && sizing("width")}
              {showSizing && sizing("height")}
              {nodes.every((n) => {
                const parent = parentOf(n);
                return (
                  parent?.style.layout === "grid" &&
                  !parent.style.minColumnWidth
                );
              }) && numeric("columnSpan", "跨列数", false)}
              {nodes.every(
                (n) =>
                  parentOf(n)?.style.layout === "grid" &&
                  !parentOf(n)?.style.minColumnWidth,
              ) && (
                <>
                  <label>
                    单元格
                    <select
                      aria-label="单元格位置"
                      disabled={protectedGeometry("gridCell")}
                      value={
                        common((n) =>
                          n.style.gridCell ? "explicit" : "auto",
                        ) ?? ""
                      }
                      onChange={(ev) =>
                        e.update(
                          {},
                          {
                            gridCell:
                              ev.target.value === "explicit"
                                ? { row: 1, column: 1 }
                                : undefined,
                          },
                        )
                      }
                    >
                      <option value="" hidden>
                        Mixed
                      </option>
                      <option value="auto">自动排列</option>
                      <option value="explicit">指定行列</option>
                    </select>
                  </label>
                  {nodes.every((n) => n.style.gridCell) &&
                    (["row", "column"] as const).map((key) => (
                      <Field
                        key={key}
                        label={key === "row" ? "起始行" : "起始列"}
                        numeric
                        disabled={protectedGeometry("gridCell")}
                        value={common((n) => n.style.gridCell![key])}
                        onCommit={(v) =>
                          e.attempt(() =>
                            e.apply(
                              nodes.map((n) => ({
                                type: "update",
                                id: n.id,
                                patch: {},
                                style: {
                                  gridCell: {
                                    ...n.style.gridCell!,
                                    [key]: Number(v),
                                  },
                                },
                              })),
                            ),
                          )
                        }
                      />
                    ))}
                </>
              )}
              {nodes.every((n) => parentOf(n)?.style.layout === "grid") &&
                numeric("rowSpan", "跨行数", false)}
            </div>
            {nodes.every((n) => n.type === "frame") && (
              <div className="layout-check-row">
                <label className="compact-check">
                  <input
                    type="checkbox"
                    disabled={
                      anyLocked ||
                      nodes.some((n) => !!instanceOwner(e.doc, n.id))
                    }
                    checked={nodes.every((n) => n.style.clipContent)}
                    ref={(el) => {
                      if (el)
                        el.indeterminate =
                          nodes.some((n) => n.style.clipContent) &&
                          !nodes.every((n) => n.style.clipContent);
                    }}
                    onChange={(ev) =>
                      e.update({}, { clipContent: ev.target.checked })
                    }
                  />
                  裁剪内容
                </label>
                {nodes.every((n) => !n.parentId) && (
                  <label
                    className="compact-check"
                    title="导出页面的画板宽度跟随浏览器"
                  >
                    <input
                      type="checkbox"
                      disabled={anyLocked}
                      aria-label="跟随视口宽度"
                      checked={nodes.every((n) => n.style.viewportWidth)}
                      onChange={(ev) =>
                        e.update({}, { viewportWidth: ev.target.checked })
                      }
                    />
                    跟随视口宽度
                  </label>
                )}
              </div>
            )}
            {nodes.every(
              (n) =>
                n.parentId &&
                (parentOf(n)?.style.layout === "free" ||
                  n.style.absolutePosition),
            ) && (
              <div className="constraints-block">
                <div className="subsection-label">约束</div>
                <div className="constraints-row">
                  {(() => {
                    const cx = common((n) => n.style.constraintX ?? "start");
                    const cy = common((n) => n.style.constraintY ?? "start");
                    const locked =
                      previewBlocked ||
                      nodes.some(
                        (n) =>
                          isLocked(e.doc, n.id) ||
                          instanceAncestor(e.doc, n.id),
                      );
                    const on = "var(--figma-blue)",
                      off = "var(--border-strong)";
                    const clickPin = (
                      axis: "constraintX" | "constraintY",
                      target: "start" | "end" | "center",
                      shift: boolean,
                    ) => {
                      if (locked) return;
                      const cur = axis === "constraintX" ? cx : cy;
                      let next: "start" | "center" | "end" | "stretch" = target;
                      if (shift && target !== "center") {
                        if (
                          (cur === "start" && target === "end") ||
                          (cur === "end" && target === "start")
                        )
                          next = "stretch";
                        else if (cur === "stretch")
                          next = target === "start" ? "end" : "start";
                      }
                      e.update(
                        {},
                        {
                          [axis]: next,
                          ...(next === "stretch"
                            ? {
                                [axis === "constraintY"
                                  ? "heightMode"
                                  : "widthMode"]: "fixed",
                              }
                            : {}),
                        },
                      );
                    };
                    const pin = (
                      axis: "constraintX" | "constraintY",
                      target: "start" | "end" | "center",
                      label: string,
                    ) => ({
                      role: "button",
                      tabIndex: locked ? -1 : 0,
                      "aria-label": label,
                      "aria-disabled": locked,
                      onClick: (ev: React.MouseEvent) =>
                        clickPin(axis, target, ev.shiftKey),
                      onKeyDown: (ev: React.KeyboardEvent) => {
                        if (ev.key === "Enter" || ev.key === " ") {
                          ev.preventDefault();
                          ev.stopPropagation();
                          clickPin(axis, target, ev.shiftKey);
                        }
                      },
                    });
                    return (
                      <svg
                        className="constraint-diagram constraints-diagram"
                        width="48"
                        height="48"
                        viewBox="0 0 48 48"
                        role="group"
                        aria-label="点击边缘切换约束（Shift+点击切换拉伸）"
                      >
                        <rect
                          x="1"
                          y="1"
                          width="46"
                          height="46"
                          rx="4"
                          fill="var(--bg-input)"
                          stroke="var(--border-subtle)"
                        />
                        <rect
                          x="16"
                          y="16"
                          width="16"
                          height="16"
                          rx="2"
                          fill="var(--bg-panel)"
                          stroke="var(--border-strong)"
                        />
                        <line
                          className="pin-hit"
                          x1="4"
                          y1="24"
                          x2="14"
                          y2="24"
                          stroke={cx === "start" || cx === "stretch" ? on : off}
                          strokeWidth={
                            cx === "start" || cx === "stretch" ? 2.5 : 1.5
                          }
                          {...pin("constraintX", "start", "左侧约束")}
                        />
                        <line
                          className="pin-hit"
                          x1="34"
                          y1="24"
                          x2="44"
                          y2="24"
                          stroke={cx === "end" || cx === "stretch" ? on : off}
                          strokeWidth={
                            cx === "end" || cx === "stretch" ? 2.5 : 1.5
                          }
                          {...pin("constraintX", "end", "右侧约束")}
                        />
                        <line
                          className="pin-hit"
                          x1="20"
                          y1="24"
                          x2="28"
                          y2="24"
                          stroke={cx === "center" || cx === "scale" ? on : off}
                          strokeWidth={
                            cx === "center" || cx === "scale" ? 2.5 : 1.5
                          }
                          {...pin("constraintX", "center", "水平居中约束")}
                        />
                        <line
                          className="pin-hit"
                          x1="24"
                          y1="4"
                          x2="24"
                          y2="14"
                          stroke={cy === "start" || cy === "stretch" ? on : off}
                          strokeWidth={
                            cy === "start" || cy === "stretch" ? 2.5 : 1.5
                          }
                          {...pin("constraintY", "start", "顶部约束")}
                        />
                        <line
                          className="pin-hit"
                          x1="24"
                          y1="34"
                          x2="24"
                          y2="44"
                          stroke={cy === "end" || cy === "stretch" ? on : off}
                          strokeWidth={
                            cy === "end" || cy === "stretch" ? 2.5 : 1.5
                          }
                          {...pin("constraintY", "end", "底部约束")}
                        />
                        <line
                          className="pin-hit"
                          x1="24"
                          y1="20"
                          x2="24"
                          y2="28"
                          stroke={cy === "center" || cy === "scale" ? on : off}
                          strokeWidth={
                            cy === "center" || cy === "scale" ? 2.5 : 1.5
                          }
                          {...pin("constraintY", "center", "垂直居中约束")}
                        />
                      </svg>
                    );
                  })()}
                  <div className="constraints-selects">
                    {(["constraintX", "constraintY"] as const).map((key, i) => (
                      <select
                        key={key}
                        aria-label={i ? "垂直约束" : "水平约束"}
                        title={i ? "垂直约束" : "水平约束"}
                        value={common((n) => n.style[key] ?? "start") ?? ""}
                        disabled={
                          previewBlocked ||
                          nodes.some(
                            (n) =>
                              isLocked(e.doc, n.id) ||
                              instanceAncestor(e.doc, n.id),
                          )
                        }
                        onChange={(ev) =>
                          e.update(
                            {},
                            {
                              [key]: ev.target.value,
                              ...(["stretch", "scale"].includes(ev.target.value)
                                ? { [i ? "heightMode" : "widthMode"]: "fixed" }
                                : {}),
                            },
                          )
                        }
                      >
                        <option hidden value="">
                          Mixed
                        </option>
                        {(
                          [
                            "start",
                            "center",
                            "end",
                            "stretch",
                            "scale",
                          ] as const
                        ).map((v, j) => (
                          <option key={v} value={v}>
                            {
                              (i
                                ? [
                                    "顶部",
                                    "垂直居中",
                                    "底部",
                                    "上下拉伸",
                                    "按高度缩放",
                                  ]
                                : [
                                    "左侧",
                                    "水平居中",
                                    "右侧",
                                    "左右拉伸",
                                    "按宽度缩放",
                                  ])[j]
                            }
                          </option>
                        ))}
                      </select>
                    ))}
                  </div>
                </div>
              </div>
            )}
            {nodes.every((n) => n.type === "frame") && (
              <>
                {nodes.every((n) => n.style.layout !== "free") && (
                  <div className="flow-settings">
                    <div className="flow-placement">
                      <div
                        className="flow-anchor"
                        role="group"
                        aria-label="容器内对齐"
                      >
                        {(["start", "center", "end"] as const).flatMap(
                          (alignY, row) =>
                            (["start", "center", "end"] as const).map(
                              (alignX, col) => {
                                const label =
                                  ["上", "中", "下"][row] +
                                  ["左", "中", "右"][col] +
                                  "对齐";
                                return (
                                  <button
                                    key={alignX + alignY}
                                    title={label}
                                    aria-label={label}
                                    data-tip={label}
                                    aria-pressed={nodes.every(
                                      (n) =>
                                        (n.style.alignX ?? "start") ===
                                          alignX &&
                                        (n.style.alignY ?? "start") === alignY,
                                    )}
                                    disabled={layoutDisabled}
                                    onClick={() =>
                                      e.update({}, { alignX, alignY })
                                    }
                                  >
                                    <i />
                                  </button>
                                );
                              },
                            ),
                        )}
                      </div>
                      <div className="flow-spacing">
                        {!hasRowGap && (
                          <span className="flow-caption">图层间距</span>
                        )}
                        <div className="flow-control-row">
                          {numeric(
                            "gap",
                            "间距",
                            true,
                            hasRowGap ? "列距" : undefined,
                          )}
                          {nodes.every(
                            (n) =>
                              n.style.layout === "row" ||
                              n.style.layout === "column",
                          ) && (
                            <button
                              type="button"
                              className={`icon-btn icon-btn-sm ${nodes.every((n) => n.style.justifyContent === "space-between") ? "active" : ""}`}
                              aria-label="两端对齐间距 (Space between)"
                              aria-pressed={nodes.every(
                                (n) =>
                                  n.style.justifyContent === "space-between",
                              )}
                              data-tip="主轴两端对齐 (Auto / Space between)"
                              data-tip-desc="在容器主轴方向自动均分子图层间距"
                              data-tip-side="left"
                              disabled={layoutDisabled}
                              onClick={() =>
                                e.update(
                                  {},
                                  {
                                    justifyContent: nodes.every(
                                      (n) =>
                                        n.style.justifyContent ===
                                        "space-between",
                                    )
                                      ? "pack"
                                      : "space-between",
                                  },
                                )
                              }
                            >
                              {nodes.every(
                                (n) => n.style.layout === "column",
                              ) ? (
                                <AlignVerticalSpaceAround size={14} />
                              ) : (
                                <AlignHorizontalSpaceAround size={14} />
                              )}
                            </button>
                          )}
                        </div>
                        {hasRowGap &&
                          numeric("rowGap", "行间距", false, "行距")}
                      </div>
                    </div>
                    <div
                      className="flow-control-row flow-padding"
                      role="group"
                      aria-label="容器内边距"
                    >
                      {hasInsets ? (
                        <div className="flow-insets">
                          {paddingEdges.map(([edge, label]) => (
                            <Field
                              key={edge}
                              numeric
                              label={label}
                              value={common((n) => paddingSides(n.style)[edge])}
                              disabled={layoutDisabled}
                              onCommit={(value) => {
                                const next = Number(value);
                                if (!Number.isFinite(next) || next < 0) return;
                                updateEachStyle((n) => ({
                                  insets: {
                                    ...paddingSides(n.style),
                                    [edge]: next,
                                  },
                                }));
                              }}
                            />
                          ))}
                        </div>
                      ) : (
                        numeric("padding", "内边距", true, "内边距")
                      )}
                      <button
                        type="button"
                        className="icon-btn icon-btn-sm"
                        aria-label="独立内边距"
                        data-tip={
                          allInsets ? "恢复统一内边距" : "分别设置四边内边距"
                        }
                        data-tip-desc={
                          allInsets
                            ? "恢复已绑定变量；未绑定时，四边相等沿用当前值，否则恢复原统一值"
                            : "分别调整左、上、右、下内边距"
                        }
                        data-tip-side="left"
                        aria-pressed={
                          allInsets ? true : hasInsets ? "mixed" : false
                        }
                        disabled={layoutDisabled}
                        onClick={() =>
                          updateEachStyle((n) => {
                            if (!allInsets)
                              return n.style.insets
                                ? undefined
                                : { insets: paddingSides(n.style) };
                            const sides = n.style.insets!;
                            const equal = paddingEdges.every(
                              ([edge]) => sides[edge] === sides.top,
                            );
                            return {
                              insets: undefined,
                              ...(equal &&
                              !n.variableBindings?.padding &&
                              sides.top !== n.style.padding
                                ? { padding: sides.top }
                                : {}),
                            };
                          })
                        }
                      >
                        <Scan size={14} />
                      </button>
                    </div>
                    {nodes.every((n) => n.style.layout === "grid") && (
                      <div className="flow-grid-options">
                        {nodes.every((n) => !instanceOwner(e.doc, n.id)) && (
                          <StyleBinding editor={e} kind="grid" />
                        )}
                        {!nodes.some(
                          (n) => n.style.gridTracks && !n.style.minColumnWidth,
                        ) && numeric("columns", "列数", false)}
                        {nodes.length === 1 && !node.style.minColumnWidth && (
                          <GridTracks
                            previewBlocked={previewBlocked}
                            style={node.style}
                            disabled={protectedGeometry("gridTracks")}
                            commit={(s) => e.update({}, s)}
                          />
                        )}
                        <label>
                          网格行高
                          <select
                            aria-label="网格行高模式"
                            value={
                              common((n) =>
                                n.style.gridRowHeight ? "fixed" : "auto",
                              ) ?? ""
                            }
                            disabled={protectedGeometry("gridRowHeight")}
                            onChange={(event) =>
                              e.update(
                                {},
                                {
                                  gridRowHeight:
                                    event.target.value === "fixed"
                                      ? 48
                                      : undefined,
                                },
                              )
                            }
                          >
                            <option value="" disabled>
                              Mixed
                            </option>
                            <option value="auto">适应内容</option>
                            <option value="fixed">固定</option>
                          </select>
                        </label>
                        {nodes.every(
                          (n) => n.style.gridRowHeight !== undefined,
                        ) && numeric("gridRowHeight", "每行高度", false)}
                        {numeric("minColumnWidth", "自适应最小列宽", false)}
                      </div>
                    )}
                  </div>
                )}
              </>
            )}
            <div className="layout-advanced-pair">
              <SizeLimits
                editor={e}
                nodes={nodes}
                disabled={
                  previewBlocked ||
                  nodes.some(
                    (n) =>
                      isLocked(e.doc, n.id) || !!instanceAncestor(e.doc, n.id),
                  )
                }
              />
              {nodes.every((n) => n.type === "frame") &&
                nodes.every(
                  (n) =>
                    JSON.stringify(editableRules(n.style)) ===
                    JSON.stringify(editableRules(node.style)),
                ) && (
                  <LayoutBreakpoints
                    previewBlocked={previewBlocked}
                    grid={
                      node.style.layout === "grid" && !node.style.minColumnWidth
                    }
                    appearanceOnly={nodes.some(
                      (n) =>
                        n.style.layout === "free" ||
                        n.style.widthMode === "hug",
                    )}
                    baseFill={node.style.fill}
                    rules={editableRules(node.style)}
                    disabled={protectedGeometry("layoutBreakpoints")}
                    commit={(rules) => e.update({}, saveRules(rules))}
                  />
                )}
            </div>
          </section>
          <section>
            <div className="section-title">
              <span>外观</span>
              <div className="section-actions">
                <select
                  className="header-ghost-select"
                  aria-label="混合模式"
                  title="混合模式"
                  disabled={anyLocked}
                  value={
                    common((n) => n.style.blendMode ?? "pass-through") ?? ""
                  }
                  onChange={(ev) =>
                    e.update(
                      {},
                      { blendMode: ev.target.value as NodeStyle["blendMode"] },
                    )
                  }
                >
                  <option value="" hidden>
                    Mixed
                  </option>
                  {blendModes.map((mode) => (
                    <option key={mode} value={mode}>
                      {BLEND_MODE_LABELS[mode] ?? mode}
                    </option>
                  ))}
                </select>
                {nodes.length === 1 &&
                  node.type !== "ellipse" &&
                  node.type !== "text" && (
                    <button
                      className="corner-toggle icon-btn icon-btn-sm"
                      disabled={anyLocked}
                      title="独立圆角"
                      aria-label="独立圆角"
                      data-tip={
                        node.style.corners ? "恢复统一圆角" : "分别设置四角圆角"
                      }
                      data-tip-desc="切换左上、右上、右下、左下独立圆角控制"
                      data-tip-side="left"
                      aria-pressed={!!node.style.corners}
                      onClick={() => {
                        const r = node.style.radius;
                        e.update(
                          {},
                          {
                            corners: node.style.corners
                              ? undefined
                              : { tl: r, tr: r, br: r, bl: r },
                          },
                        );
                      }}
                    >
                      <Scan size={14} />
                    </button>
                  )}
              </div>
            </div>
            <div className="property-grid">
              {numeric("opacity", "不透明度")}
              {nodes.every(
                (n) =>
                  n.type !== "ellipse" && n.type !== "text" && !n.style.corners,
              ) && numeric("radius", "圆角")}
            </div>
            {nodes.length === 1 &&
              node.type !== "ellipse" &&
              node.type !== "text" &&
              node.style.corners && (
                <div className="property-grid">
                  {(["tl", "tr", "bl", "br"] as const).map((key, index) => (
                    <Field
                      key={key}
                      numeric
                      disabled={anyLocked}
                      label={
                        ["左上圆角", "右上圆角", "左下圆角", "右下圆角"][index]
                      }
                      value={node.style.corners![key]}
                      onCommit={(v) => {
                        const n = Number(v);
                        if (!Number.isFinite(n) || n < 0) return;
                        e.update(
                          {},
                          {
                            corners: { ...node.style.corners!, [key]: n },
                          },
                        );
                      }}
                    />
                  ))}
                </div>
              )}
            {nodes.every(
              (n) =>
                n.type !== "ellipse" && n.type !== "text" && n.type !== "slice",
            ) &&
              (Boolean(node.style.corners) ||
                nodes.some(
                  (n) =>
                    n.style.radius > 0 || (n.style.cornerSmoothing ?? 0) > 0,
                )) && (
                <label
                  style={{
                    display: "grid",
                    gridTemplateColumns: "56px minmax(0, 1fr) 34px",
                    alignItems: "center",
                    gap: 6,
                    marginTop: 6,
                    fontSize: 11,
                    color: "var(--text-secondary)",
                  }}
                >
                  <span>圆角平滑</span>
                  <input
                    type="range"
                    aria-label="圆角平滑"
                    disabled={anyLocked}
                    min={0}
                    max={100}
                    step={1}
                    style={{ width: "100%", minWidth: 0, margin: 0 }}
                    value={Math.round((smoothing ?? 0) * 100)}
                    aria-valuetext={smoothingText}
                    onChange={(ev) => {
                      const cornerSmoothing =
                        Number(ev.target.value) / 100 || undefined;
                      const ops = nodes.map((n) => ({
                        type: "update" as const,
                        id: n.id,
                        patch: {},
                        style: { cornerSmoothing },
                      }));
                      smoothingPending.current = ops;
                      gesture.change("cornerSmoothing", ops, true);
                    }}
                    onPointerUp={finishSmoothing}
                    onKeyUp={finishSmoothing}
                    onBlur={finishSmoothing}
                    onPointerCancel={() => {
                      smoothingPending.current = null;
                      gesture.cancel("cornerSmoothing");
                    }}
                  />
                  <span
                    style={{
                      textAlign: "right",
                      fontVariantNumeric: "tabular-nums",
                      color: "var(--text-muted)",
                    }}
                  >
                    {smoothingText}
                  </span>
                </label>
              )}
          </section>
          {text && (
            <section>
              <div className="section-title">
                <span>文字</span>
                <div className="section-actions">
                  <StyleBinding editor={e} kind="text" placement="header" />
                  {nodes.length === 1 && node.type === "text" && (
                    <button
                      type="button"
                      className="icon-btn icon-btn-sm"
                      aria-label="文字转轮廓"
                      title="文字转轮廓 ⇧⌘O"
                      data-tip="文字转轮廓"
                      data-tip-kbd="⇧⌘O"
                      data-tip-desc="将当前文字转为可编辑矢量路径（支持系统字体与嵌入字体）"
                      data-tip-side="left"
                      disabled={!allowed("outlineText")}
                      onClick={() => e.perform("outlineText")}
                    >
                      <Shapes size={14} />
                    </button>
                  )}
                  <button
                    ref={typeBtnRef}
                    type="button"
                    className={`icon-btn icon-btn-sm ${typeDetailsOpen ? "active" : ""}`}
                    aria-label="更多文字样式设置"
                    aria-expanded={typeOpen}
                    data-tip="文字详情 (Type details)"
                    data-tip-desc="斜体、装饰线、大小写、垂直对齐、溢出截断与文本框缩放"
                    data-tip-side="left"
                    disabled={!tabActive || anyLocked}
                    onClick={() => setTypeDetailsOpen((v) => !v)}
                  >
                    <MoreHorizontal size={14} />
                  </button>
                </div>
              </div>
              <StyleBinding editor={e} kind="text" placement="body" />
              <Field
                label="字体"
                disabled={anyLocked}
                list="forma-font-families"
                value={common(
                  (n) =>
                    e.doc.fonts?.[n.style.fontFamily ?? ""]?.name ??
                    n.style.fontFamily ??
                    "system-ui, sans-serif",
                )}
                onCommit={(fontFamily) => {
                  const matchedFontId = Object.entries(e.doc.fonts ?? {}).find(
                    ([, f]) => f.name === fontFamily,
                  )?.[0];
                  e.update({}, { fontFamily: matchedFontId ?? fontFamily });
                }}
              >
                <TokenBinding
                  editor={e}
                  property="fontFamily"
                  disabled={anyLocked}
                />
              </Field>
              <fieldset
                disabled={previewBlocked}
                style={{ display: "contents" }}
              >
                <FontAssets editor={e} nodes={nodes} />
              </fieldset>
              <datalist id="forma-font-families">
                <option value="Inter, -apple-system, sans-serif" />
                <option value="system-ui, -apple-system, PingFang SC, sans-serif" />
                <option value="SF Pro Display, -apple-system, sans-serif" />
                <option value="Georgia, serif" />
                <option value="JetBrains Mono, ui-monospace, monospace" />
              </datalist>
              <div className="property-grid">
                {numeric("fontWeight", "字重")}
                {numeric("fontSize", "字号")}
                {numeric("lineHeight", "行高")}
                {numeric("letterSpacing", "字距")}
              </div>
              <div
                className="text-alignment"
                role="group"
                aria-label="文字对齐"
              >
                {(["left", "center", "right", "justify"] as const).map(
                  (align, i) => (
                    <button
                      key={align}
                      disabled={anyLocked}
                      title={["左对齐", "居中", "右对齐", "两端对齐"][i]}
                      aria-label={`文字${["左对齐", "居中", "右对齐", "两端对齐"][i]}`}
                      data-tip={["左对齐", "居中", "右对齐", "两端对齐"][i]}
                      aria-pressed={
                        common((n) => n.style.textAlign ?? "left") === align
                      }
                      className={
                        common((n) => n.style.textAlign ?? "left") === align
                          ? "active"
                          : ""
                      }
                      onClick={() => e.update({}, { textAlign: align })}
                    >
                      {
                        [
                          <AlignLeft size={14} />,
                          <AlignCenter size={14} />,
                          <AlignRight size={14} />,
                          <AlignJustify size={14} />,
                        ][i]
                      }
                    </button>
                  ),
                )}
              </div>
              <div
                className="type-inline-row"
                role="group"
                aria-label="文字样式与垂直对齐"
              >
                <button
                  type="button"
                  disabled={anyLocked}
                  aria-label="斜体"
                  data-tip="斜体"
                  aria-pressed={nodes.every(
                    (n) => n.style.fontStyle === "italic",
                  )}
                  onClick={() =>
                    e.update(
                      {},
                      {
                        fontStyle: nodes.every(
                          (n) => n.style.fontStyle === "italic",
                        )
                          ? "normal"
                          : "italic",
                      },
                    )
                  }
                >
                  <Italic size={13} />
                </button>
                <button
                  type="button"
                  disabled={anyLocked}
                  aria-label="下划线"
                  data-tip="下划线"
                  aria-pressed={nodes.every(
                    (n) => n.style.textDecoration === "underline",
                  )}
                  onClick={() =>
                    e.update(
                      {},
                      {
                        textDecoration: nodes.every(
                          (n) => n.style.textDecoration === "underline",
                        )
                          ? "none"
                          : "underline",
                      },
                    )
                  }
                >
                  <Underline size={13} />
                </button>
                <button
                  type="button"
                  disabled={anyLocked}
                  aria-label="删除线"
                  data-tip="删除线"
                  aria-pressed={nodes.every(
                    (n) => n.style.textDecoration === "line-through",
                  )}
                  onClick={() =>
                    e.update(
                      {},
                      {
                        textDecoration: nodes.every(
                          (n) => n.style.textDecoration === "line-through",
                        )
                          ? "none"
                          : "line-through",
                      },
                    )
                  }
                >
                  <Strikethrough size={13} />
                </button>
                <button
                  type="button"
                  disabled={anyLocked}
                  aria-label="切换大小写"
                  data-tip="切换大小写 (无/大写/小写/首字母大写)"
                  aria-pressed={nodes.some(
                    (n) =>
                      !!n.style.textTransform &&
                      n.style.textTransform !== "none",
                  )}
                  onClick={() => {
                    const cycle = [
                      "none",
                      "uppercase",
                      "lowercase",
                      "capitalize",
                    ] as const;
                    const cur = node.style.textTransform ?? "none";
                    const next = cycle[(cycle.indexOf(cur) + 1) % cycle.length];
                    e.update({}, { textTransform: next });
                  }}
                >
                  {node.style.textTransform === "uppercase"
                    ? "AA"
                    : node.style.textTransform === "lowercase"
                      ? "aa"
                      : node.style.textTransform === "capitalize"
                        ? "Aa"
                        : "A"}
                </button>
              </div>
              {typeOpen &&
                createPortal(
                  <div
                    ref={typePopoverRef}
                    role="dialog"
                    aria-label="文字详情"
                    className="type-details-popover"
                    onKeyDown={(event) => {
                      if (
                        event.key === "Escape" &&
                        !event.nativeEvent.isComposing &&
                        event.nativeEvent.keyCode !== 229 &&
                        !event.defaultPrevented
                      ) {
                        event.preventDefault();
                        event.stopPropagation();
                        closeTypeDetails();
                      }
                    }}
                  >
                    <div className="type-details-header">
                      <span>文字详情</span>
                      <button
                        type="button"
                        className="icon-btn icon-btn-sm"
                        autoFocus
                        aria-label="关闭文字详情"
                        data-tip="关闭文字详情"
                        onClick={closeTypeDetails}
                      >
                        <X size={13} />
                      </button>
                    </div>
                    <div>
                      <div className="subsection-label">大小写转换</div>
                      <div
                        className="type-inline-row"
                        role="group"
                        aria-label="文字大小写"
                      >
                        {(
                          [
                            ["none", "原样"],
                            ["uppercase", "AA"],
                            ["lowercase", "aa"],
                            ["capitalize", "Aa"],
                          ] as const
                        ).map(([val, lbl]) => (
                          <button
                            key={val}
                            type="button"
                            aria-pressed={
                              common((n) => n.style.textTransform ?? "none") ===
                              val
                            }
                            onClick={() =>
                              canEditTypeDetails() &&
                              e.update({}, { textTransform: val })
                            }
                          >
                            {lbl}
                          </button>
                        ))}
                      </div>
                    </div>
                    <div>
                      <div className="subsection-label">垂直对齐</div>
                      <div
                        className="type-inline-row"
                        style={{ gridTemplateColumns: "repeat(3, 1fr)" }}
                        role="group"
                        aria-label="文字垂直对齐"
                      >
                        {(
                          [
                            ["top", "顶部对齐", AlignVerticalJustifyStart],
                            ["middle", "垂直居中", AlignVerticalJustifyCenter],
                            ["bottom", "底部对齐", AlignVerticalJustifyEnd],
                          ] as const
                        ).map(([val, lbl, Icon]) => (
                          <button
                            key={val}
                            type="button"
                            aria-label={lbl}
                            data-tip={lbl}
                            aria-pressed={
                              common((n) => n.style.verticalAlign ?? "top") ===
                              val
                            }
                            onClick={() =>
                              canEditTypeDetails() &&
                              e.update({}, { verticalAlign: val })
                            }
                          >
                            <Icon size={13} />
                          </button>
                        ))}
                      </div>
                    </div>
                    <div>
                      <div className="subsection-label">文本框缩放</div>
                      <div
                        className="type-inline-row"
                        style={{ gridTemplateColumns: "repeat(3, 1fr)" }}
                        role="group"
                        aria-label="文本框缩放模式"
                      >
                        <button
                          type="button"
                          aria-pressed={nodes.every(
                            (n) =>
                              n.style.widthMode === "hug" &&
                              n.style.heightMode === "hug",
                          )}
                          disabled={sizingDisabled}
                          onClick={() =>
                            canEditTypeDetails() &&
                            setSizing({ width: "hug", height: "hug" })
                          }
                        >
                          自动宽度
                        </button>
                        <button
                          type="button"
                          aria-pressed={nodes.every(
                            (n) =>
                              (n.style.widthMode ?? "fixed") === "fixed" &&
                              n.style.heightMode === "hug",
                          )}
                          disabled={sizingDisabled}
                          onClick={() =>
                            canEditTypeDetails() &&
                            setSizing({ width: "fixed", height: "hug" })
                          }
                        >
                          自动高度
                        </button>
                        <button
                          type="button"
                          aria-pressed={nodes.every(
                            (n) =>
                              (n.style.widthMode ?? "fixed") === "fixed" &&
                              (n.style.heightMode ?? "fixed") === "fixed",
                          )}
                          disabled={sizingDisabled}
                          onClick={() =>
                            canEditTypeDetails() &&
                            setSizing({ width: "fixed", height: "fixed" })
                          }
                        >
                          固定尺寸
                        </button>
                      </div>
                    </div>
                    <Field
                      label="最大行数截断"
                      prefixText="行"
                      numeric
                      disabled={anyLocked}
                      value={common((n) => n.style.maxLines ?? 0)}
                      onCommit={(v) => {
                        if (!canEditTypeDetails()) return;
                        const n = Math.round(Number(v));
                        e.update(
                          {},
                          {
                            maxLines:
                              Number.isFinite(n) && n >= 1
                                ? Math.min(100, n)
                                : undefined,
                          },
                        );
                      }}
                    />
                  </div>,
                  document.body,
                )}
              <details className="advanced-properties">
                <summary>高级字体设置</summary>
                {typeSettings.map(({ key, label, example }) => (
                  <Field
                    key={key}
                    label={label}
                    disabled={anyLocked}
                    list={"forma-" + key}
                    value={common((n) => n.style[key] ?? "")}
                    onCommit={(v) =>
                      e.update({}, { [key]: v.trim() || undefined })
                    }
                  >
                    <datalist id={"forma-" + key}>
                      <option value={example} />
                    </datalist>
                  </Field>
                ))}
              </details>
              <details className="advanced-properties">
                <summary>
                  文本内容
                  <TokenBinding
                    editor={e}
                    property="text"
                    disabled={anyLocked}
                  />
                </summary>
                <TextContent
                  key={e.selection.join(",")}
                  disabled={anyLocked}
                  value={common((n) => n.text)}
                  commit={(text) => e.update({ text })}
                />
              </details>
            </section>
          )}
          {nodes.length === 1 && node.style.tint && (
            <section>
              <div className="section-title">
                <span>整体着色</span>
                <button
                  type="button"
                  className="remove-property icon-btn icon-btn-sm"
                  disabled={anyLocked}
                  title="移除整体着色"
                  aria-label="移除整体着色"
                  data-tip="移除整体着色"
                  data-tip-side="left"
                  onClick={() => updateEachStyle(() => ({ tint: undefined }))}
                >
                  <Trash2 size={12} />
                </button>
              </div>
              <ColorField
                label="整体着色"
                color={node.style.tint.color}
                alpha={node.style.tint.opacity}
                palette={getPalette}
                disabled={anyLocked}
                onCancelPreview={() => gesture.cancel("tint")}
                onPreview={(color, opacity) =>
                  updateEachStyle(
                    () => ({ tint: { color, opacity } }),
                    true,
                    "tint",
                  )
                }
                onChange={(color, opacity) => {
                  updateEachStyle(
                    () => ({ tint: { color, opacity } }),
                    false,
                    "tint",
                  );
                }}
              />
            </section>
          )}
          <section>
            {nodes.length === 1 &&
            (!["text", "group", "vector"].includes(node.type) ||
              node.vector?.fillFromStyle) ? (
              <PaintStack
                previewBlocked={previewBlocked}
                system={e.doc.designSystem}
                layers={node.style.paints}
                disabled={anyLocked}
                palette={getPalette}
                cancelPreview={() => gesture.cancel("paints")}
                update={(paints, preview) =>
                  updateEachStyle(() => ({ paints }), preview, "paints")
                }
                headerActions={
                  <>
                    {colorProperty === "fill" && (
                      <GradientEditor editor={e} placement="header" />
                    )}
                    <StyleBinding editor={e} kind="paint" placement="header" />
                    {colorProperty === "fill" && node.type !== "vector" && (
                      <ImageFillTrigger editor={e} node={node} />
                    )}
                  </>
                }
              />
            ) : (
              <div className="section-title">
                <span>填充</span>
                <div className="section-actions">
                  {colorProperty === "fill" && (
                    <GradientEditor editor={e} placement="header" />
                  )}
                  <StyleBinding editor={e} kind="paint" placement="header" />
                  {colorProperty === "fill" && nodes.length === 1 && (
                    <ImageFillTrigger editor={e} node={node} />
                  )}
                </div>
              </div>
            )}
            <StyleBinding editor={e} kind="paint" placement="body" />
            {!nodes.every((n) => !!n.style.gradient) && colors("base", "填充")}
            {colorProperty === "fill" && (
              <GradientEditor editor={e} placement="body" />
            )}
            {colorProperty === "fill" &&
              nodes.length === 1 &&
              node.type !== "vector" && (
                <ImageInspector editor={e} node={node} hideWhenEmpty />
              )}
          </section>
          {nodes.length === 1 && node.type === "vector" && node.vector && (
            <fieldset
              key={node.id}
              disabled={previewBlocked || e.hasPreview}
              style={{ display: "contents" }}
            >
              <VectorInspector node={node} editor={e} />
            </fieldset>
          )}
          {text && colorProperty === "fill" && (
            <section>
              <div className="section-title">文字颜色</div>
              {colors("color", "文字")}
            </section>
          )}
          {!(nodes.length === 1 && node.type === "vector") && (
            <section
              className={
                !nodes.some((n) => n.style.strokeWidth)
                  ? "is-collapsed-section"
                  : undefined
              }
            >
              <div className="section-title">
                描边
                <div className="section-actions">
                  <StyleBinding editor={e} kind="stroke" placement="header" />
                  {nodes.length === 1 &&
                    (node.type === "rectangle" || node.type === "ellipse") &&
                    allowed("outlineStroke") && (
                      <button
                        type="button"
                        className="icon-btn icon-btn-sm"
                        aria-label="轮廓化描边"
                        title="轮廓化描边 ⇧⌘O"
                        data-tip="轮廓化描边"
                        data-tip-kbd="⇧⌘O"
                        data-tip-desc="将描边转为闭合填充的可编辑矢量轮廓"
                        data-tip-side="left"
                        onClick={() => e.perform("outlineStroke")}
                      >
                        <Shapes size={14} />
                      </button>
                    )}
                  {nodes.some((n) => n.style.strokeWidth) && (
                    <>
                      <button
                        className="icon-btn icon-btn-sm"
                        disabled={anyLocked}
                        aria-label={
                          nodes.every((n) => n.style.strokeVisible === false)
                            ? "显示描边"
                            : "隐藏描边"
                        }
                        data-tip={
                          nodes.every((n) => n.style.strokeVisible === false)
                            ? "显示描边"
                            : "隐藏描边"
                        }
                        data-tip-side="left"
                        onClick={() =>
                          e.update(
                            {},
                            {
                              strokeVisible: nodes.every(
                                (n) => n.style.strokeVisible === false,
                              ),
                            },
                          )
                        }
                      >
                        {nodes.every((n) => n.style.strokeVisible === false) ? (
                          <EyeOff size={12} />
                        ) : (
                          <Eye size={12} />
                        )}
                      </button>
                      {nodes.length === 1 && (
                        <button
                          className={`icon-btn icon-btn-sm ${node.style.strokeSides ? "active" : ""}`}
                          disabled={anyLocked}
                          aria-label="独立边描边"
                          aria-pressed={!!node.style.strokeSides}
                          data-tip={
                            node.style.strokeSides
                              ? "恢复四边统一描边"
                              : "分别设置上右下左描边宽度"
                          }
                          data-tip-side="left"
                          onClick={() => {
                            const w = node.style.strokeWidth ?? 1;
                            e.update(
                              {},
                              {
                                strokeSides: node.style.strokeSides
                                  ? undefined
                                  : { top: w, right: w, bottom: w, left: w },
                              },
                            );
                          }}
                        >
                          <Scan size={12} />
                        </button>
                      )}
                      <button
                        className="remove-property icon-btn icon-btn-sm"
                        disabled={anyLocked}
                        title="移除描边"
                        aria-label="移除描边"
                        data-tip="移除描边"
                        data-tip-side="left"
                        onClick={() =>
                          e.update(
                            {},
                            {
                              strokeWidth: 0,
                              strokePaints: undefined,
                              strokeSides: undefined,
                              strokeVisible: undefined,
                            },
                          )
                        }
                      >
                        <Trash2 size={12} />
                      </button>
                    </>
                  )}
                  <button
                    className="icon-btn icon-btn-sm"
                    disabled={
                      anyLocked ||
                      (nodes.length === 1
                        ? (node.style.strokePaints?.length ?? 0) >= 16
                        : nodes.every((n) => !!n.style.strokeWidth))
                    }
                    title={
                      nodes.length === 1 && node.style.strokeWidth
                        ? "添加描边层"
                        : "添加描边"
                    }
                    aria-label={
                      nodes.length === 1 && node.style.strokeWidth
                        ? "添加描边层"
                        : "添加描边"
                    }
                    data-tip={
                      nodes.length === 1 && node.style.strokeWidth
                        ? "添加描边层"
                        : "添加描边"
                    }
                    data-tip-side="left"
                    onClick={() =>
                      updateEachStyle((n) => {
                        if (!n.style.strokeWidth)
                          return {
                            stroke: n.style.stroke ?? "#b8bec9",
                            strokeWidth: 1,
                            strokeVisible: true,
                          };
                        if (nodes.length !== 1) return;
                        const strokes = n.style.strokePaints ?? [
                          {
                            id: crypto.randomUUID(),
                            color: n.style.stroke ?? "#000000",
                            opacity: n.style.strokeOpacity ?? 1,
                            visible: true,
                            blendMode: n.style.strokeBlendMode,
                            colorVariableId: n.variableBindings?.stroke,
                            opacityVariableId:
                              n.variableBindings?.strokeOpacity,
                          },
                        ];
                        if (strokes.length >= 16) return;
                        return {
                          strokePaints: [
                            {
                              id: crypto.randomUUID(),
                              color: "#000000",
                              opacity: 0.16,
                              visible: true,
                            },
                            ...strokes,
                          ],
                        };
                      })
                    }
                  >
                    <Plus size={14} />
                  </button>
                </div>
              </div>
              <StyleBinding editor={e} kind="stroke" placement="body" />
              {nodes.some((n) => n.style.strokeWidth) && (
                <>
                  {nodes.length === 1 && node.style.strokePaints?.length ? (
                    <PaintStack
                      previewBlocked={previewBlocked}
                      kind="stroke"
                      hideHeader
                      system={e.doc.designSystem}
                      layers={node.style.strokePaints}
                      disabled={anyLocked}
                      palette={getPalette}
                      cancelPreview={() => gesture.cancel("strokePaints")}
                      update={(strokePaints, preview) =>
                        updateEachStyle(
                          () =>
                            strokePaints.length
                              ? { strokePaints }
                              : {
                                  strokePaints: undefined,
                                  strokeWidth: 0,
                                  strokeSides: undefined,
                                },
                          preview,
                          "strokePaints",
                        )
                      }
                    />
                  ) : (
                    colors("stroke", "描边")
                  )}
                  <div className="property-grid">
                    {numeric("strokeWidth", "粗细")}
                    <select
                      aria-label="描边线型"
                      disabled={anyLocked}
                      value={
                        common((n) => n.style.strokeStyle ?? "solid") ?? ""
                      }
                      onChange={(ev) =>
                        e.update(
                          {},
                          {
                            strokeStyle: ev.target
                              .value as NodeStyle["strokeStyle"],
                          },
                        )
                      }
                    >
                      <option value="" hidden>
                        Mixed
                      </option>
                      <option value="solid">实线</option>
                      <option value="dashed">虚线</option>
                      <option value="dotted">点线</option>
                      <option value="double">双线</option>
                    </select>
                  </div>
                  {nodes.length === 1 && node.style.strokeSides && (
                    <div className="property-grid" style={{ marginTop: 6 }}>
                      {(["top", "right", "bottom", "left"] as const).map(
                        (edge, idx) => (
                          <Field
                            key={edge}
                            numeric
                            disabled={anyLocked}
                            prefixText={["上", "右", "下", "左"][idx]}
                            label={
                              ["上描边", "右描边", "下描边", "左描边"][idx]
                            }
                            value={node.style.strokeSides![edge] ?? 0}
                            onCommit={(v) => {
                              const n = Number(v);
                              if (!Number.isFinite(n) || n < 0) return;
                              e.update(
                                {},
                                {
                                  strokeSides: {
                                    ...node.style.strokeSides!,
                                    [edge]: Math.min(100, n),
                                  },
                                },
                              );
                            }}
                          />
                        ),
                      )}
                    </div>
                  )}
                  {(nodes.some((n) => n.style.strokeStyle === "dashed") ||
                    nodes.some((n) => !!n.style.strokeDash)) && (
                    <div style={{ marginTop: 6 }}>
                      <Field
                        label="虚线样式"
                        prefixText="虚线"
                        disabled={anyLocked}
                        value={common((n) => n.style.strokeDash ?? "")}
                        onCommit={(val) =>
                          e.update({}, { strokeDash: val.trim() || undefined })
                        }
                      />
                    </div>
                  )}
                  <div
                    className="stroke-placement"
                    role="group"
                    aria-label="描边位置"
                  >
                    {(["inside", "center", "outside"] as const).map(
                      (place, i) => {
                        const label = ["内描边", "居中描边", "外描边"][i];
                        return (
                          <button
                            key={place}
                            disabled={anyLocked}
                            aria-label={label}
                            data-tip={label}
                            title={label}
                            aria-pressed={nodes.every(
                              (n) =>
                                (n.style.strokeAlign ?? "inside") === place,
                            )}
                            onClick={() => e.update({}, { strokeAlign: place })}
                          >
                            <svg
                              width="17"
                              height="17"
                              viewBox="0 0 18 18"
                              aria-hidden="true"
                            >
                              <rect
                                x="4.5"
                                y="4.5"
                                width="9"
                                height="9"
                                fill="none"
                                stroke="currentColor"
                                strokeDasharray="1 1"
                              />
                              <rect
                                x={6 - i * 1.5}
                                y={6 - i * 1.5}
                                width={6 + i * 3}
                                height={6 + i * 3}
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="2"
                              />
                            </svg>
                          </button>
                        );
                      },
                    )}
                  </div>
                </>
              )}
            </section>
          )}
          <section>
            <div className="section-title">
              <span>效果</span>
              <div className="section-actions">
                <StyleBinding editor={e} kind="effect" placement="header" />
                <button
                  className="icon-btn icon-btn-sm"
                  title="添加投影"
                  aria-label="添加投影"
                  data-tip="添加投影效果"
                  data-tip-desc={`新增一层可自定义偏移与模糊度的投影（最多 ${maxShadows} 层）`}
                  data-tip-side="left"
                  disabled={
                    anyLocked ||
                    nodes.some(
                      (n) => (n.style.shadows?.length ?? 0) >= maxShadows,
                    )
                  }
                  onClick={() =>
                    updateEachStyle((n) => ({
                      shadows: [
                        ...(n.style.shadows ?? []),
                        {
                          x: 0,
                          y: 4,
                          blur: 12,
                          spread: 0,
                          color: "#000000",
                          opacity: 0.16,
                          visible: true,
                          inset: false,
                        },
                      ],
                    }))
                  }
                >
                  <Plus size={14} />
                </button>
              </div>
            </div>
            <StyleBinding editor={e} kind="effect" placement="body" />
            {node.style.shadows
              ?.slice(0, sharedShadowCount)
              .map((shadow, index) => (
                <details
                  className="effect-detail"
                  key={index}
                  style={
                    shadow.visible === false ? { opacity: 0.55 } : undefined
                  }
                >
                  <summary>
                    <span>
                      {common((n) => n.style.shadows![index].inset) ===
                      undefined
                        ? "混合阴影"
                        : shadow.inset
                          ? "内阴影"
                          : "投影"}
                    </span>
                    <small>
                      {common((n) =>
                        [
                          n.style.shadows![index].x,
                          n.style.shadows![index].y,
                          n.style.shadows![index].blur,
                        ].join(", "),
                      ) ?? "Mixed"}
                    </small>
                    <button
                      className="icon-btn icon-btn-sm"
                      disabled={anyLocked}
                      aria-label={
                        shadow.visible === false
                          ? `显示阴影 ${index + 1}`
                          : `隐藏阴影 ${index + 1}`
                      }
                      data-tip={
                        shadow.visible === false ? "显示效果" : "隐藏效果"
                      }
                      data-tip-side="top"
                      onClick={(ev) => {
                        ev.preventDefault();
                        changeShadow(index, {
                          visible: shadow.visible === false,
                        });
                      }}
                    >
                      {shadow.visible === false ? (
                        <EyeOff size={12} />
                      ) : (
                        <Eye size={12} />
                      )}
                    </button>
                    {([-1, 1] as const).map((step) => {
                      const label = step === -1 ? "上移阴影" : "下移阴影";
                      const Icon = step === -1 ? ChevronUp : ChevronDown;
                      return (
                        <button
                          key={step}
                          className="icon-btn icon-btn-sm"
                          aria-label={`${label} ${index + 1}`}
                          data-tip={label}
                          data-tip-side="top"
                          disabled={
                            anyLocked ||
                            index + step < 0 ||
                            index + step >= sharedShadowCount
                          }
                          onClick={(ev) => {
                            ev.preventDefault();
                            moveShadow(index, index + step);
                          }}
                        >
                          <Icon size={13} />
                        </button>
                      );
                    })}
                    <button
                      className="icon-btn icon-btn-sm"
                      disabled={anyLocked}
                      aria-label={`删除阴影 ${index + 1}`}
                      data-tip="删除效果"
                      title="删除效果"
                      onClick={(ev) => {
                        ev.preventDefault();
                        updateEachStyle((n) => ({
                          shadows: n.style.shadows!.filter(
                            (_, i) => i !== index,
                          ),
                        }));
                      }}
                    >
                      <Trash2 size={12} />
                    </button>
                  </summary>
                  <div className="property-grid">
                    {(
                      [
                        ["x", "X"],
                        ["y", "Y"],
                        ["blur", "模糊"],
                        ["spread", "扩散"],
                      ] as const
                    ).map(([key, short]) => (
                      <Field
                        key={key}
                        prefixText={short}
                        label={`阴影 ${index + 1} ${key}`}
                        numeric
                        disabled={anyLocked}
                        value={common((n) => n.style.shadows![index][key])}
                        onCommit={(v) => {
                          const n = Number(v);
                          if (!Number.isFinite(n)) return;
                          changeShadow(index, {
                            [key]: key === "blur" ? Math.max(0, n) : n,
                          });
                        }}
                      />
                    ))}
                  </div>
                  <ColorField
                    label={`阴影 ${index + 1}`}
                    color={shadow.color}
                    alpha={shadow.opacity}
                    disabled={anyLocked}
                    palette={getPalette}
                    mixedColor={
                      common((n) => n.style.shadows![index].color) === undefined
                    }
                    mixedAlpha={
                      common((n) => n.style.shadows![index].opacity) ===
                      undefined
                    }
                    onCancelPreview={() => gesture.cancel("shadow-" + index)}
                    onPreview={(color, opacity, channel) =>
                      changeShadow(
                        index,
                        channel === "alpha" ? { opacity } : { color },
                        true,
                      )
                    }
                    onChange={(color, opacity, channel) =>
                      changeShadow(index, {
                        ...(channel !== "alpha" && { color }),
                        ...(channel !== "color" && { opacity }),
                      })
                    }
                  />
                  <label className="compact-check">
                    <input
                      type="checkbox"
                      disabled={anyLocked}
                      checked={shadow.inset}
                      ref={(el) => {
                        if (el)
                          el.indeterminate =
                            common((n) => n.style.shadows![index].inset) ===
                            undefined;
                      }}
                      onChange={(ev) =>
                        changeShadow(index, { inset: ev.target.checked })
                      }
                    />
                    内阴影
                  </label>
                </details>
              ))}
            <details
              className="advanced-properties"
              open={blurOpen}
              onToggle={(ev) => setBlurOpen(ev.currentTarget.open)}
            >
              <summary>模糊</summary>
              <div className="property-grid" style={{ alignItems: "center" }}>
                <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    {numeric("blur", "图层模糊")}
                  </div>
                  <button
                    type="button"
                    className="icon-btn icon-btn-sm"
                    disabled={anyLocked}
                    aria-label="切换图层模糊可见性"
                    data-tip={
                      nodes.every((n) => n.style.blurVisible === false)
                        ? "启用图层模糊"
                        : "暂时隐藏图层模糊"
                    }
                    onClick={() =>
                      e.update(
                        {},
                        {
                          blurVisible: nodes.every(
                            (n) => n.style.blurVisible === false,
                          ),
                        },
                      )
                    }
                  >
                    {nodes.every((n) => n.style.blurVisible === false) ? (
                      <EyeOff size={12} />
                    ) : (
                      <Eye size={12} />
                    )}
                  </button>
                </div>
                <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    {numeric("backdropBlur", "背景模糊")}
                  </div>
                  <button
                    type="button"
                    className="icon-btn icon-btn-sm"
                    disabled={anyLocked}
                    aria-label="切换背景模糊可见性"
                    data-tip={
                      nodes.every((n) => n.style.backdropBlurVisible === false)
                        ? "启用背景模糊"
                        : "暂时隐藏背景模糊"
                    }
                    onClick={() =>
                      e.update(
                        {},
                        {
                          backdropBlurVisible: nodes.every(
                            (n) => n.style.backdropBlurVisible === false,
                          ),
                        },
                      )
                    }
                  >
                    {nodes.every(
                      (n) => n.style.backdropBlurVisible === false,
                    ) ? (
                      <EyeOff size={12} />
                    ) : (
                      <Eye size={12} />
                    )}
                  </button>
                </div>
              </div>
            </details>
          </section>
          {nodes.length === 1 &&
            (node.type === "frame" || node.type === "section") && (
              <LayoutGuidesInspector
                previewBlocked={previewBlocked}
                node={node}
                locked={anyLocked}
                onChange={(layoutGuides) =>
                  e.update(
                    {},
                    {
                      layoutGuides: layoutGuides.length
                        ? layoutGuides
                        : undefined,
                    },
                  )
                }
              />
            )}
          <ModeSelectors editor={e} />
          <SelectionColors editor={e} />
          {nodes.length === 1 && (
            <ExportPanel
              previewBlocked={previewBlocked}
              document={e.committed}
              node={node}
              onUpdateSettings={(exportSettings) =>
                e.update({
                  exportSettings: exportSettings.length
                    ? exportSettings
                    : undefined,
                })
              }
              onOpenBatchExport={onOpenBatchExport}
            />
          )}
          <section>
            <details
              className="advanced-properties"
              open={moreOpen}
              onToggle={(ev) => setMoreOpen(ev.currentTarget.open)}
            >
              <summary>更多属性</summary>
              {moreOpen && (
                <>
                  <label className="mode-row">
                    父容器
                    <select
                      aria-label="父容器"
                      disabled={
                        anyLocked ||
                        nodes.some((n) => !!instanceAncestor(e.doc, n.id))
                      }
                      value={common((n) => n.parentId ?? "") ?? "__mixed__"}
                      onChange={(ev) =>
                        e.reparent(e.selection, ev.target.value || null)
                      }
                    >
                      <option value="__mixed__" hidden>
                        Mixed
                      </option>
                      <option value="">页面根层</option>
                      {e.doc.nodes
                        .filter(
                          (n) =>
                            isContainer(n) &&
                            !isLocked(e.doc, n.id) &&
                            !instanceOwner(e.doc, n.id) &&
                            !blocked.has(n.id),
                        )
                        .map((n) => (
                          <option value={n.id} key={n.id}>
                            {n.name}
                          </option>
                        ))}
                    </select>
                  </label>
                  <div className="mode-row">
                    <span>可见性</span>
                    <TokenBinding
                      editor={e}
                      property="visible"
                      disabled={anyLocked}
                    />
                  </div>
                  {nodes.every((n) => Boolean(n.control)) && (
                    <Field
                      label="可访问名称"
                      disabled={anyLocked}
                      value={common((n) => n.control?.label ?? "")}
                      onCommit={(label) =>
                        e.attempt(() =>
                          e.apply(
                            nodes.map((n) => ({
                              type: "update",
                              id: n.id,
                              patch: { control: { ...n.control!, label } },
                            })),
                          ),
                        )
                      }
                    />
                  )}
                  <button
                    className="danger wide"
                    disabled={!allowed("delete")}
                    title="组件内部图层需先分离实例"
                    onClick={() => e.perform("delete")}
                  >
                    删除所选图层
                  </button>
                </>
              )}
            </details>
          </section>
        </>
      )}
    </>
  );
}
function TextContent({
  disabled,
  value,
  commit,
}: {
  disabled: boolean;
  value: string | undefined;
  commit(value: string): void;
}) {
  const [draft, setDraft] = useState(value ?? "");
  const dirty = useRef(false);
  useLayoutEffect(() => {
    setDraft(value ?? "");
    dirty.current = false;
  }, [value]);
  return (
    <textarea
      disabled={disabled}
      aria-label="文本内容"
      value={draft}
      placeholder={value === undefined ? "Mixed" : ""}
      onChange={(e) => {
        dirty.current = true;
        setDraft(e.target.value);
      }}
      onBlur={() => {
        if (!disabled && dirty.current && draft !== value) commit(draft);
        dirty.current = false;
      }}
    />
  );
}
