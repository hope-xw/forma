import { createLibraryFromSelection, detachInstance } from "../domain/library";
import { localMasters } from "../domain/component-masters";
import { loadFonts } from "../infrastructure/font-import";
import { readCanvasAsset } from "../infrastructure/asset-import";
import { importSvg } from "../infrastructure/svg-import";
import { clipboardRequest } from "../infrastructure/clipboard";
import { combineShapes, maskSelection } from "../domain/boolean-shapes";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  createNode,
  type DesignNode,
  type NodeStyle,
} from "../domain/document";
import {
  copySelection,
  pasteSelection,
  readClipboard,
  type ClipboardPayload,
} from "../domain/clipboard";
import {
  alignOperations,
  editablePatch,
  layerOrderOperations,
  reparentOperations,
  ungroupOperations,
  wrapOperations,
  type Alignment,
} from "../domain/editing";
import {
  ancestors,
  insertionParent,
  instanceOwner,
  isLocked,
  isVisible,
  selectionRoots,
} from "../domain/tree";
import { findLayer } from "../domain/scene-index";
import { layoutBounds, type Point } from "../domain/geometry";
import type { Operation } from "../domain/commands";
import { smartSelection, arrangeGrid } from "../domain/smart-selection";
import { findMatchingLayers, wrapInSection } from "../domain/section";
import { useDocument } from "./useDocument";
import type { ActionId } from "./actions";
export type Tool =
  | "select"
  | "scale"
  | "hand"
  | "frame"
  | "section"
  | "slice"
  | "rectangle"
  | "ellipse"
  | "line"
  | "polygon"
  | "star"
  | "text"
  | "button"
  | "pen"
  | "pencil"
  | "comment";
export interface CanvasApi {
  fit(ids?: string[]): void;
  zoom(factor: number): void;
  zoom100(): void;
  center(): Point;
}
const isInput = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  !!target.closest(
    'input,textarea,select,[contenteditable="true"],[role="dialog"],[role="menu"]',
  );
export function useEditor(options?: import("./useDocument").EditorFileOptions) {
  const document = useDocument(options);
  const { doc, committed, apply, attempt } = document;
  const [selection, setSelection] = useState<string[]>(
    options?.initialSelection ?? [],
  );
  const smartGrid = useMemo(
    () => smartSelection(committed, selection),
    [committed, selection],
  );
  const [tool, setTool] = useState<Tool>("select");
  const [editing, setEditing] = useState<string | null>(null);
  const [cropping, setCropping] = useState<string | null>(null);
  useEffect(() => {
    if (!cropping) return;
    const node = findLayer(committed, cropping);
    if (
      selection.length !== 1 ||
      selection[0] !== cropping ||
      !node?.image ||
      node.image.fit === "tile" ||
      editing ||
      tool !== "select" ||
      isLocked(committed, cropping)
    )
      setCropping(null);
  }, [cropping, committed, selection, editing, tool]);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [palette, setPalette] = useState(false);
  const [rulers, setRulers] = useState(false);
  const [help, setHelp] = useState(false);
  const api = useRef<CanvasApi | null>(null);
  const clipboard = useRef<ClipboardPayload | null>(null);
  const [styleClipboard, setStyleClipboard] =
    useState<Partial<NodeStyle> | null>(null);
  useEffect(() => {
    setSelection((previous) => {
      const next = previous.filter((id) => !!findLayer(committed, id));
      return next.length === previous.length ? previous : next;
    });
    if (editing && !findLayer(committed, editing)) setEditing(null);
  }, [committed, editing]);
  const selections = useRef(new WeakMap<typeof committed, string[]>());
  selections.current.set(committed, selection);
  function undo() {
    const target = document.historyRef.current.past.at(-1);
    if (!target) return;
    const restored = selections.current.get(target) ?? [];
    document.undo();
    setSelection(restored);
  }
  function redo() {
    const target = document.historyRef.current.future.at(-1);
    if (!target) return;
    const restored = selections.current.get(target) ?? [];
    document.redo();
    setSelection(restored);
  }
  const selected = useMemo(
    () =>
      selection.flatMap((id) => {
        const node = findLayer(doc, id);
        return node ? [node] : [];
      }),
    [doc, selection],
  );
  function select(id: string, add = false) {
    setSelection((current) =>
      add
        ? current.includes(id)
          ? current.filter((i) => i !== id)
          : [...current, id]
        : [id],
    );
  }
  function update(patch: Partial<DesignNode>, style?: Partial<NodeStyle>) {
    attempt(() => apply(editablePatch(selected, patch, style)));
  }
  function remove() {
    apply(
      selectionRoots(committed, selection).map((n) => ({
        type: "remove",
        id: n.id,
      })),
    );
    setSelection([]);
  }
  function clone() {
    const payload = copySelection(committed, selection);
    const roots = selectionRoots(committed, selection);
    const parent = roots.every((n) => n.parentId === roots[0].parentId)
      ? roots[0].parentId
      : null;
    const bounds = layoutBounds(committed);
    const result = pasteSelection(committed, payload, parent, {
      x: Math.min(...roots.map((n) => bounds.get(n.id)!.x)) + 20,
      y: Math.min(...roots.map((n) => bounds.get(n.id)!.y)) + 20,
    });
    apply(result.operations);
    setSelection(result.selection);
  }
  function placement() {
    const parentId = insertionParent(
      committed,
      selection.length === 1 ? selected[0] : undefined,
    );
    return {
      parentId,
      point: parentId
        ? { x: 24, y: 24 }
        : (api.current?.center() ?? { x: 80, y: 80 }),
    };
  }
  async function importAssets(files: File[], target = placement()) {
    if (!files.length) return;
    try {
      const operations: Operation[] = [],
        ids: string[] = [];
      for (const file of files) {
        const { node, resources } = await readCanvasAsset(file);
        node.parentId = target.parentId;
        node.style.x = target.point.x + 16 * ids.length;
        node.style.y = target.point.y + 16 * ids.length;
        operations.push(...resources, { type: "create", node });
        ids.push(node.id);
      }
      apply(operations, committed.revision);
      setSelection(ids);
    } catch (error) {
      document.setError(error instanceof Error ? error.message : String(error));
    }
  }
  function pasteText(text: string, inPlace = false) {
    const payload = readClipboard(text);
    const current =
      selection.length === 1
        ? committed.nodes.find((n) => n.id === selection[0])
        : undefined;
    const parent = insertionParent(committed, current);
    if (parent && isLocked(committed, parent))
      throw new Error("目标容器已锁定");
    const bounds = layoutBounds(committed);
    const parentRect = parent ? bounds.get(parent) : null;
    const position = inPlace
      ? undefined
      : parentRect
        ? { x: parentRect.x + 24, y: parentRect.y + 24 }
        : (api.current?.center() ?? { x: 80, y: 80 });
    if (payload) {
      const commitPaste = () => {
        const result = pasteSelection(committed, payload, parent, position);
        apply(result.operations, committed.revision);
        setSelection(result.selection);
      };
      if (payload.document.fonts)
        void loadFonts(payload.document.fonts)
          .then(commitPaste)
          .catch((err) => document.setError(String(err)));
      else commitPaste();
    } else if (/^\s*(?:<\?xml[^?]*\?>\s*)?<svg[\s>]/i.test(text)) {
      const node = importSvg(text, "粘贴图标"),
        target = placement();
      node.parentId = target.parentId;
      Object.assign(node.style, target.point);
      apply([{ type: "create", node }]);
      setSelection([node.id]);
    } else if (text.trim()) {
      const node = createNode("text", parent);
      node.text = text.slice(0, 50000);
      node.style.x = (position?.x ?? 80) - (parentRect?.x ?? 0);
      node.style.y = (position?.y ?? 80) - (parentRect?.y ?? 0);
      node.style.width = 320;
      node.style.height = 80;
      apply([{ type: "create", node }]);
      setSelection([node.id]);
    }
  }
  async function copy(cut = false) {
    const payload = copySelection(committed, selection);
    clipboard.current = payload;
    try {
      await clipboardRequest(
        navigator.clipboard.writeText(JSON.stringify(payload)),
      );
    } catch {
      if (cut)
        throw new Error("系统剪贴板不可写，剪切未执行。请使用 ⌘/Ctrl X。");
      document.setError(
        "浏览器未允许系统剪贴板；已复制到本工具剪贴板，可在这里粘贴",
      );
    }
    if (
      cut &&
      document.historyRef.current.present.revision !== committed.revision
    )
      throw new Error("剪贴板操作期间文件已变化，剪切未执行，请重试");
    if (cut) remove();
  }
  async function paste(inPlace = false) {
    let text = "";
    try {
      text = await clipboardRequest(navigator.clipboard.readText());
    } catch {
      /* Browser clipboard can be denied; an explicit same-editor buffer remains available. */
    }
    if (!text && clipboard.current) text = JSON.stringify(clipboard.current);
    if (!text) throw new Error("剪贴板为空或无法读取，请使用 ⌘/Ctrl V 粘贴");
    if (document.historyRef.current.present.revision !== committed.revision)
      throw new Error("剪贴板操作期间文件已变化，请重新粘贴");
    pasteText(text, inPlace);
  }
  function add(type: DesignNode["type"]) {
    attempt(() => {
      let parentId = insertionParent(
        committed,
        selected.length === 1 ? selected[0] : undefined,
      );
      if (type === "section") {
        let candidate = findLayer(committed, parentId);
        while (candidate && candidate.type !== "section") {
          candidate = findLayer(committed, candidate.parentId);
        }
        parentId = candidate?.id ?? null;
      }
      const parent = findLayer(committed, parentId);
      const node = createNode(type, parent?.id ?? null);
      const point = api.current?.center() ?? { x: 80, y: 80 };
      node.style.x = Math.round(parent ? 24 : point.x - node.style.width / 2);
      node.style.y = Math.round(parent ? 24 : point.y - node.style.height / 2);
      apply([{ type: "create", node }]);
      setSelection([node.id]);
    });
  }
  const single = selected.length === 1 ? selected[0] : undefined;
  const componentUnavailable = useMemo(() => {
    if (!single) return "请先单选一个图层";
    if (isLocked(committed, single.id)) return "请先解除图层锁定";
    if (!single.instance && instanceOwner(committed, single.id))
      return "请先选择所属实例或显式分离";
    if (localMasters(committed).some((m) => m.nodeId === single.id))
      return "此图层已是主组件";
    return "";
  }, [committed, single]);
  function saveComponent() {
    if (componentUnavailable || !single)
      throw Error(componentUnavailable || "请先单选一个图层");
    const lib = createLibraryFromSelection(
      committed,
      single.id,
      "我的组件 · " + single.name,
    );
    apply([{ type: "putLibrary", library: lib }]);
  }
  function perform(id: ActionId) {
    attempt(() => {
      const alignments: Partial<Record<ActionId, Alignment>> = {
        alignLeft: "left",
        alignCenter: "center",
        alignRight: "right",
        alignTop: "top",
        alignMiddle: "middle",
        alignBottom: "bottom",
        distributeX: "horizontal",
        distributeY: "vertical",
      };
      const alignment = alignments[id];
      if (alignment) {
        apply(alignOperations(committed, selection, alignment));
        return;
      }
      switch (id) {
        case "createComponent":
          saveComponent();
          break;
        case "createFrame":
          add("frame");
          break;
        case "createSection":
          add("section");
          break;
        case "createSlice":
          add("slice");
          break;
        case "createText":
          add("text");
          break;
        case "wrapSection": {
          const result = wrapInSection(committed, selection);
          apply(result.operations);
          setSelection([result.id]);
          break;
        }
        case "selectMatching": {
          const matched = findMatchingLayers(committed, selection);
          if (matched.length) setSelection(matched);
          break;
        }
        case "toggleDevStatus": {
          const targets = selected.filter(
            (n) =>
              (n.type === "frame" ||
                n.type === "section" ||
                !!n.componentSet) &&
              !isLocked(committed, n.id),
          );
          if (!targets.length) break;
          const nextStatus = targets.every((n) => n.devStatus === "ready")
            ? "none"
            : "ready";
          apply(
            targets.map((n) => ({
              type: "update",
              id: n.id,
              patch: { devStatus: nextStatus },
            })),
          );
          break;
        }
        case "scaleTool":
          setTool("scale");
          break;
        case "pencilTool":
          setTool("pencil");
          break;
        case "commentTool":
          setTool("comment");
          break;
        case "tidy": {
          if (!smartGrid) throw Error("请选择至少三个可移动的同级图层");
          const ops = arrangeGrid(smartGrid);
          if (ops.length) apply(ops);
          return;
        }
        case "mask": {
          const result = maskSelection(committed, selection);
          apply(result.operations);
          setSelection([result.id]);
          break;
        }
        case "releaseMask": {
          const group = selected.length === 1 && selected[0];
          if (group && group.maskSourceId)
            apply([
              {
                type: "update",
                id: group.id,
                patch: { maskSourceId: undefined, maskType: undefined },
              },
            ]);
          break;
        }
        case "union":
        case "subtract":
        case "intersect":
        case "exclude": {
          const result = combineShapes(committed, selection, id);
          apply(result.operations);
          setSelection([result.id]);
          break;
        }
        case "undo":
          undo();
          break;
        case "redo":
          redo();
          break;
        case "copy":
          void copy().catch((e) => document.setError(String(e)));
          break;
        case "cut":
          void copy(true).catch((e) => document.setError(String(e)));
          break;
        case "paste":
        case "pasteHere":
          void paste(id === "pasteHere").catch((e) =>
            document.setError(String(e)),
          );
          break;
        case "duplicate":
          clone();
          break;
        case "delete":
          remove();
          break;
        case "selectAll": {
          const parent = selected.length ? selected[0].parentId : null;
          setSelection(
            committed.nodes
              .filter(
                (n) =>
                  n.parentId === parent &&
                  !isLocked(committed, n.id) &&
                  isVisible(committed, n.id),
              )
              .map((n) => n.id),
          );
          break;
        }
        case "group":
        case "wrapFrame": {
          const result = wrapOperations(
            committed,
            selection,
            id === "group" ? "group" : "frame",
          );
          apply(result.operations);
          setSelection([result.id]);
          break;
        }
        case "ungroup": {
          const result = ungroupOperations(committed, selection);
          apply(result.operations);
          setSelection(result.selection);
          break;
        }
        case "autoLayout": {
          if (selected.length === 1 && selected[0].type === "frame")
            apply([
              {
                type: "update",
                id: selected[0].id,
                patch: {},
                style: { layout: "column" },
              },
            ]);
          else {
            const result = wrapOperations(committed, selection, "frame", true);
            apply(result.operations);
            setSelection([result.id]);
          }
          break;
        }
        case "front":
        case "back":
        case "forward":
        case "backward":
          apply(layerOrderOperations(committed, selection, id));
          break;
        case "lock": {
          const roots = selectionRoots(committed, selection);
          const locked = !roots.every((n) => n.locked);
          apply(
            roots.map((n) => ({ type: "update", id: n.id, patch: { locked } })),
          );
          break;
        }
        case "hide": {
          const hidden = !selected.every((n) => n.hidden);
          apply(editablePatch(selected, { hidden }));
          break;
        }
        case "rename":
          setRenaming(selection.at(-1) ?? null);
          break;
        case "fit":
          api.current?.fit();
          break;
        case "fitSelection":
          api.current?.fit(selection);
          break;
        case "rulers":
          setRulers((v) => !v);
          break;
        case "zoom100":
          api.current?.zoom100();
          break;
        case "copyStyle": {
          const style = selected.at(-1)?.style;
          if (style) {
            const {
              x: _x,
              y: _y,
              width: _w,
              height: _h,
              layout: _layout,
              gap: _gap,
              padding: _padding,
              ...appearance
            } = style;
            void _x;
            void _y;
            void _w;
            void _h;
            void _layout;
            void _gap;
            void _padding;
            setStyleClipboard(appearance);
          }
          break;
        }
        case "pasteStyle":
          if (styleClipboard)
            apply(editablePatch(selected, {}, styleClipboard));
          break;
      }
    });
  }
  function navigate(direction: "parent" | "child" | "next" | "previous") {
    const node = committed.nodes.find((n) => n.id === selection.at(-1));
    if (!node) return;
    if (direction === "parent") {
      setSelection(node.parentId ? [node.parentId] : []);
      return;
    }
    if (direction === "child") {
      if (
        node.type === "text" ||
        node.type === "button" ||
        (node.type === "vector" && !instanceOwner(committed, node.id))
      ) {
        if (!isLocked(committed, node.id)) setEditing(node.id);
      } else {
        const child = committed.nodes.find(
          (n) =>
            n.parentId === node.id &&
            isVisible(committed, n.id) &&
            !isLocked(committed, n.id),
        );
        if (child) setSelection([child.id]);
      }
      return;
    }
    const siblings = committed.nodes.filter(
      (n) =>
        n.parentId === node.parentId &&
        isVisible(committed, n.id) &&
        !isLocked(committed, n.id),
    );
    const i = siblings.findIndex((n) => n.id === node.id);
    if (siblings.length)
      setSelection([
        siblings[
          (i + (direction === "next" ? 1 : -1) + siblings.length) %
            siblings.length
        ].id,
      ]);
  }
  function nudge(dx: number, dy: number) {
    attempt(() => {
      const operations: Operation[] = [];
      for (const n of selectionRoots(committed, selection)) {
        const parent = committed.nodes.find((p) => p.id === n.parentId);
        if (parent?.type === "frame" && parent.style.layout !== "free") {
          const siblings = committed.nodes.filter(
            (c) => c.parentId === parent.id,
          );
          const index = siblings.findIndex((c) => c.id === n.id);
          const step =
            parent.style.layout === "row" ? Math.sign(dx) : Math.sign(dy);
          if (step)
            operations.push({
              type: "reorder",
              id: n.id,
              index: Math.max(0, index + step),
            });
        } else
          operations.push({
            type: "update",
            id: n.id,
            patch: {},
            style: { x: n.style.x + dx, y: n.style.y + dy },
          });
      }
      apply(operations);
    });
  }
  const current = useRef({
    perform,
    pasteText,
    add,
    tool,
    importAssets,
    remove,
    navigate,
    nudge,
    update,
  });
  current.current = {
    perform,
    pasteText,
    add,
    tool,
    importAssets,
    remove,
    navigate,
    nudge,
    update,
  };
  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  const tabActive = options?.active !== false;
  useEffect(() => {
    if (!tabActive) return;
    const key = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing || isInput(e.target)) return;
      if (
        e.key === "Enter" &&
        e.target instanceof HTMLElement &&
        e.target.closest("button, a, summary") &&
        !e.target.closest('[role="tree"]')
      )
        return;
      const mod = e.metaKey || e.ctrlKey,
        k = e.key.toLowerCase();
      let action: ActionId | undefined;
      if (mod) {
        if (k === "z") action = e.shiftKey ? "redo" : "undo";
        if (k === "y" && !e.metaKey) action = "redo";
        if (k === "a") action = e.altKey ? "selectMatching" : "selectAll";
        if (k === "d") action = "duplicate";
        if (k === "g")
          action = e.altKey ? "wrapFrame" : e.shiftKey ? "ungroup" : "group";
        if (k === "r") action = "rename";
        if (k === "l" && e.shiftKey) action = "lock";
        if (k === "h" && e.shiftKey) action = "hide";
        if (k === "[") action = "back";
        if (k === "]") action = "front";
        if (k === "c" && e.altKey) action = "copyStyle";
        if (k === "v" && e.altKey) action = "pasteStyle";
        if (k === "v" && e.shiftKey) action = "pasteHere";
        if (e.code === "Digit0" && !e.shiftKey) action = "zoom100";
        if (k === "k" || e.code === "KeyK") {
          if (e.altKey) action = "createComponent";
          else {
            e.preventDefault();
            setPalette((v) => !v);
            return;
          }
        }
        if (k === "m" && e.ctrlKey && e.metaKey) action = "mask";
        if (k === "b" && e.altKey && !e.shiftKey) {
          const only =
            selectionRef.current.length === 1
              ? document.historyRef.current.present.nodes.find(
                  (n) => n.id === selectionRef.current[0],
                )
              : undefined;
          if (
            only?.instance &&
            !isLocked(document.historyRef.current.present, only.id)
          ) {
            e.preventDefault();
            document.attempt(() =>
              document.apply(
                detachInstance(document.historyRef.current.present, only.id),
              ),
            );
            return;
          }
        }
        if (k === "e" && !e.shiftKey && !e.altKey) {
          const only =
            selectionRef.current.length === 1
              ? document.historyRef.current.present.nodes.find(
                  (n) => n.id === selectionRef.current[0],
                )
              : undefined;
          if (
            only?.booleanOperation &&
            !isLocked(document.historyRef.current.present, only.id)
          ) {
            e.preventDefault();
            document.attempt(() =>
              document.apply([{ type: "flattenBoolean", id: only.id }]),
            );
            return;
          }
        }
      } else {
        if (e.key === "Delete" || e.key === "Backspace") action = "delete";
        if (k === "[") action = "backward";
        if (k === "]") action = "forward";
        if (k === "r" && e.shiftKey) action = "rulers";
        if (k === "a" && e.shiftKey) action = "autoLayout";
        if (
          k === "h" &&
          e.shiftKey &&
          !e.altKey &&
          selectionRef.current.length
        ) {
          e.preventDefault();
          current.current.update(
            {},
            {
              flipX: !document.historyRef.current.present.nodes.find(
                (n) => n.id === selectionRef.current[0],
              )?.style.flipX,
            },
          );
          return;
        }
        if (
          k === "v" &&
          e.shiftKey &&
          !e.altKey &&
          selectionRef.current.length
        ) {
          e.preventDefault();
          current.current.update(
            {},
            {
              flipY: !document.historyRef.current.present.nodes.find(
                (n) => n.id === selectionRef.current[0],
              )?.style.flipY,
            },
          );
          return;
        }
        if (e.code === "Digit1" && e.shiftKey) action = "fit";
        if (e.code === "Digit2" && e.shiftKey) action = "fitSelection";
        if (e.code === "Digit0" && e.shiftKey) action = "zoom100";
      }
      if (action) {
        e.preventDefault();
        current.current.perform(action);
        return;
      }
      if (e.key === "+" || e.key === "=" || e.key === "-") {
        e.preventDefault();
        api.current?.zoom(e.key === "-" ? 1 / 1.2 : 1.2);
        return;
      }
      if (mod) return;
      if (e.key === "Escape") {
        setEditing(null);
        setTool("select");
        setSelection((s) => {
          const node = document.historyRef.current.present.nodes.find(
            (n) => n.id === s.at(-1),
          );
          return node?.parentId ? [node.parentId] : [];
        });
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        const tool = current.current.tool;
        if (
          !e.shiftKey &&
          (tool === "frame" ||
            tool === "section" ||
            tool === "slice" ||
            tool === "text" ||
            tool === "rectangle" ||
            tool === "ellipse")
        ) {
          current.current.add(tool);
          setTool("select");
          return;
        }
        current.current.navigate(e.shiftKey ? "parent" : "child");
        return;
      }
      if (e.key === "Tab") {
        if (!(
          e.target instanceof Element &&
          e.target.closest('.editor-canvas,[role="tree"]')
        ))
          return;
        e.preventDefault();
        current.current.navigate(e.shiftKey ? "previous" : "next");
        return;
      }
      if (e.key.startsWith("Arrow")) {
        e.preventDefault();
        const d = e.shiftKey ? 10 : 1;
        current.current.nudge(
          e.key === "ArrowLeft" ? -d : e.key === "ArrowRight" ? d : 0,
          e.key === "ArrowUp" ? -d : e.key === "ArrowDown" ? d : 0,
        );
        return;
      }
      const tools: Record<string, Tool> = {
        v: "select",
        k: "scale",
        h: "hand",
        f: "frame",
        s: "slice",
        r: "rectangle",
        o: "ellipse",
        l: "line",
        t: "text",
        p: "pen",
        c: "comment",
      };
      const shiftTools: Record<string, Tool> = {
        s: "section",
        p: "pencil",
      };
      if (e.shiftKey && !e.altKey && shiftTools[k]) {
        if (window.document.querySelector('[aria-modal="true"]')) return;
        window.document
          .querySelector<HTMLElement>(".editor-canvas")
          ?.focus({ preventScroll: true });
        setTool(shiftTools[k]);
        e.preventDefault();
      } else if (!e.shiftKey && !e.altKey && tools[k]) {
        if (window.document.querySelector('[aria-modal="true"]')) return;
        window.document
          .querySelector<HTMLElement>(".editor-canvas")
          ?.focus({ preventScroll: true });
        setTool(tools[k]);
        e.preventDefault();
      }
      if (e.key === "?") {
        setHelp((v) => !v);
        e.preventDefault();
      }
    };
    const onCopy = (e: ClipboardEvent) => {
      if (isInput(e.target) || !selectionRef.current.length) return;
      document.attempt(() => {
        const payload = copySelection(
          document.historyRef.current.present,
          selectionRef.current,
        );
        if (!e.clipboardData) throw new Error("系统剪贴板不可写，原图层已保留");
        e.clipboardData.setData("text/plain", JSON.stringify(payload));
        clipboard.current = payload;
        e.preventDefault();
        if (e.type === "cut") current.current.remove();
      });
    };
    const onPaste = (e: ClipboardEvent) => {
      if (isInput(e.target)) return;
      if (e.clipboardData?.files.length) {
        e.preventDefault();
        void current.current.importAssets(Array.from(e.clipboardData.files));
        return;
      }
      const text =
        e.clipboardData?.getData("image/svg+xml") ||
        e.clipboardData?.getData("text/plain");
      if (!text) return;
      e.preventDefault();
      document.attempt(() => current.current.pasteText(text));
    };
    window.addEventListener("keydown", key);
    window.addEventListener("copy", onCopy);
    window.addEventListener("cut", onCopy);
    window.addEventListener("paste", onPaste);
    return () => {
      window.removeEventListener("keydown", key);
      window.removeEventListener("copy", onCopy);
      window.removeEventListener("cut", onCopy);
      window.removeEventListener("paste", onPaste);
    };
  }, [document.attempt, document.historyRef, tabActive]);
  return {
    ...document,
    canPasteStyle: !!styleClipboard,
    componentUnavailable,
    saveComponent,
    undo,
    redo,
    selection,
    setSelection,
    selected,
    smartGrid,
    select,
    tool,
    setTool,
    editing,
    setEditing,
    cropping,
    setCropping,
    renaming,
    setRenaming,
    palette,
    setPalette,
    rulers,
    setRulers,
    help,
    setHelp,
    api,
    perform,
    importAssets,
    update,
    align: (alignment: Alignment) =>
      attempt(() => apply(alignOperations(committed, selection, alignment))),
    reparent: (ids: string[], parentId: string | null, index?: number) =>
      attempt(() => {
        if (
          parentId &&
          findLayer(committed, parentId)?.componentSet &&
          ids.some((id) => findLayer(committed, id)?.parentId !== parentId)
        ) {
          apply(
            ids.map((id) => ({
              type: "includeSetDrawing",
              id,
              setId: parentId,
            })),
          );
        } else apply(reparentOperations(committed, ids, parentId, index));
      }),
    add,
    addPresetFrame: (name: string, width: number, height: number) =>
      attempt(() => {
        const node = createNode("frame", null);
        node.name = name;
        const roots = committed.nodes.filter((n) => !n.parentId);
        const maxRight = roots.length
          ? Math.max(...roots.map((n) => n.style.x + n.style.width)) + 80
          : 80;
        const topY = roots.length
          ? Math.min(...roots.map((n) => n.style.y))
          : 80;
        node.style.x = Math.round(maxRight);
        node.style.y = Math.round(topY);
        node.style.width = width;
        node.style.height = height;
        node.style.radius = 0;
        node.style.clipContent = true;
        apply([{ type: "create", node }]);
        setSelection([node.id]);
        setTool("select");
        requestAnimationFrame(() => api.current?.fit([node.id]));
      }),
    selectAncestor: (id: string) => {
      const chain = [...ancestors(committed, id)].reverse();
      setSelection([chain[0]?.id ?? id]);
    },
  };
}
export type EditorController = ReturnType<typeof useEditor>;
