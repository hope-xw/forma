import { useModalDialog } from "./useModalDialog";
import { layoutBounds } from "../domain/geometry";
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
  useRef,
  useCallback,
} from "react";
import { X, RotateCcw, ChevronLeft, ChevronRight } from "lucide-react";
import {
  runtimeNodes,
  documentRuntimeStyle,
  prototypeProgram,
} from "../compiler/runtime";
import { PrototypePlayer } from "../runtime/PrototypePlayer";
import { DesignNodeView, ImageResources } from "../runtime/FormaRuntime";
import type { DesignDocument } from "../domain/document";
import { isSceneFrame, linkedPrototypeScene } from "../domain/prototype";
import { ancestors } from "../domain/tree";

export function PreviewDialog({
  document: activePage,
  selection,
  close,
}: {
  document: DesignDocument;
  selection: string[];
  close(): void;
}) {
  const document = useMemo(
    () => linkedPrototypeScene(activePage),
    [activePage],
  );
  const modal = useModalDialog(true, close);
  const [previewWidth, setPreviewWidth] = useState<number>();
  const [zoomMode, setZoomMode] = useState<"fit" | "100" | "fill">("fit");
  const [bezel, setBezel] = useState<
    "none" | "iphone16" | "ipad-pro" | "browser"
  >("none");
  const stage = useRef<HTMLDivElement>(null);
  const [area, setArea] = useState({ width: 1, height: 1 });
  const [revision, setRevision] = useState(0);
  const [lastAction, setLastAction] = useState("");
  useLayoutEffect(() => {
    const element = stage.current!;
    element.focus({ preventScroll: true });
    const css = getComputedStyle(element);
    setArea({
      width: Math.max(
        1,
        element.clientWidth -
          parseFloat(css.paddingLeft) -
          parseFloat(css.paddingRight),
      ),
      height: Math.max(
        1,
        element.clientHeight -
          parseFloat(css.paddingTop) -
          parseFloat(css.paddingBottom),
      ),
    });
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setArea({ width: Math.max(1, width), height: Math.max(1, height) });
    });
    observer.observe(stage.current!);
    return () => observer.disconnect();
  }, []);

  const selected = document.nodes.find((n) => n.id === selection[0]);
  const program = useMemo(() => prototypeProgram(document), [document]);
  const rootBoards = useMemo(() => {
    const index = new Map(document.nodes.map((n) => [n.id, n]));
    const nestedBoards = document.nodes.filter(
      (n) =>
        n.parentId &&
        !n.hidden &&
        isSceneFrame(n, index) &&
        !ancestors(document, n.id).some((p) => p.hidden),
    );
    const sections = new Set(
      nestedBoards.flatMap((n) => ancestors(document, n.id).map((p) => p.id)),
    );
    return [
      ...document.nodes.filter(
        (n) => !n.parentId && !n.hidden && !sections.has(n.id),
      ),
      ...nestedBoards,
    ];
  }, [document]);
  const root = useMemo(() => {
    if (!selected)
      return (
        document.nodes.find((n) => n.id === program?.flows[0]?.id) ??
        rootBoards[0]
      );
    const parents = ancestors(document, selected.id);
    const candidates = new Set(rootBoards.map((n) => n.id));
    return (
      [selected, ...parents].find((n) => candidates.has(n.id)) ??
      parents.at(-1) ??
      selected
    );
  }, [document, selected, program, rootBoards]);
  const [start, setStart] = useState(root?.id ?? "");
  const activeBoard =
    document.nodes.find((n) => n.id === start) ?? root ?? rootBoards[0];

  const [screen, setScreen] = useState(start);
  const boards = useMemo(
    () =>
      [...rootBoards].sort(
        (a, b) => a.style.x - b.style.x || a.style.y - b.style.y,
      ),
    [rootBoards],
  );
  const currentIdx = boards.findIndex((board) => board.id === screen);
  const show = useCallback((id: string) => {
    setStart(id);
    setScreen(id);
    setRevision((n) => n + 1);
    setLastAction("");
  }, []);
  const step = useCallback(
    (delta: number) => {
      if (boards.length > 1)
        show(
          boards[
            (Math.max(0, currentIdx) + delta + boards.length) % boards.length
          ].id,
        );
    },
    [currentIdx, boards, show],
  );
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (
        ev.defaultPrevented ||
        ev.isComposing ||
        (ev.target as Element)?.closest?.(
          "input,textarea,select,[contenteditable=true]",
        ) ||
        ev.ctrlKey ||
        ev.altKey ||
        ev.metaKey
      )
        return;
      if (ev.key.toLowerCase() === "r") show(start);
      else if (ev.key === "ArrowLeft" || ev.key === "ArrowRight")
        step(ev.key === "ArrowLeft" ? -1 : 1);
      else return;
      ev.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [start, step, show]);

  const nodes = useMemo(
    () =>
      runtimeNodes(
        document,
        !program && activeBoard ? [activeBoard.id] : undefined,
        !!program,
      ),
    [document, activeBoard, program],
  );
  const bounds = useMemo(() => layoutBounds(document), [document]),
    size = activeBoard ? bounds.get(activeBoard.id) : undefined;
  const width =
      (activeBoard?.style.viewportWidth && previewWidth) || size?.width || 390,
    height = size?.height ?? 844;
  const { width: stageW, height: stageH } = area;
  const scale =
    zoomMode === "100"
      ? 1
      : zoomMode === "fill"
        ? stageW / width
        : Math.min(1, stageW / width, stageH / height);

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(ev) => {
        if (ev.target === ev.currentTarget) close();
      }}
    >
      <div
        className="preview-dialog theater-dialog"
        ref={modal}
        aria-modal="true"
        tabIndex={-1}
        role="dialog"
        aria-label="交互预览"
      >
        <div className="panel-heading preview-header">
          {program ? (
            <select
              aria-label="预览流程"
              value={start}
              onChange={(e) => {
                show(e.target.value);
              }}
            >
              {!program.flows.some((f) => f.id === start) && (
                <option value={start}>{activeBoard?.name}</option>
              )}
              {program.flows.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </select>
          ) : (
            <strong>{activeBoard?.name ?? "设计"} · 交互预览</strong>
          )}
          {boards.length > 1 && (
            <div
              style={{ display: "inline-flex", alignItems: "center", gap: 4 }}
            >
              <button
                type="button"
                className="icon-btn icon-btn-sm"
                aria-label="上一画面"
                data-tip="上一画面"
                data-tip-kbd="←"
                onClick={() => step(-1)}
              >
                <ChevronLeft size={14} />
              </button>
              <small
                style={{
                  color: "var(--text-muted)",
                  fontVariantNumeric: "tabular-nums",
                }}
              >
                {(currentIdx < 0 ? 0 : currentIdx) + 1} / {boards.length}
              </small>
              <button
                type="button"
                className="icon-btn icon-btn-sm"
                aria-label="下一画面"
                data-tip="下一画面"
                data-tip-kbd="→"
                onClick={() => step(1)}
              >
                <ChevronRight size={14} />
              </button>
            </div>
          )}
          <div
            style={{
              marginLeft: "auto",
              display: "flex",
              alignItems: "center",
              gap: 6,
            }}
          >
            <select
              aria-label="设备外框"
              title="设备外框"
              value={bezel}
              onChange={(ev) =>
                setBezel(
                  ev.target.value as
                    "none" | "iphone16" | "ipad-pro" | "browser",
                )
              }
            >
              <option value="none">无边框</option>
              <option value="iphone16">iPhone 16</option>
              <option value="ipad-pro">iPad Pro</option>
              <option value="browser">浏览器窗口</option>
            </select>
            <select
              aria-label="缩放模式"
              title="缩放模式"
              value={zoomMode}
              onChange={(ev) =>
                setZoomMode(ev.target.value as "fit" | "100" | "fill")
              }
            >
              <option value="fit">适应屏幕 (Fit)</option>
              <option value="100">实际尺寸 (100%)</option>
              <option value="fill">适应宽度 (Fit width)</option>
            </select>
            {nodes.some((n) => n.style.width === "100%") && (
              <select
                aria-label="预览视口宽度"
                title="预览视口宽度"
                value={previewWidth ?? ""}
                onChange={(ev) =>
                  setPreviewWidth(Number(ev.target.value) || undefined)
                }
              >
                <option value="">设计宽度</option>
                {[375, 390, 768, 1024, 1440].map((w) => (
                  <option key={w} value={w}>
                    {w} px
                  </option>
                ))}
              </select>
            )}
            <button
              className="icon-btn icon-btn-sm"
              title="重置预览"
              aria-label="重置预览"
              data-tip="重置原型状态"
              data-tip-kbd="R"
              data-tip-desc="恢复初始页面、变量与交互控件状态"
              data-tip-side="bottom"
              onClick={() => {
                show(start);
              }}
            >
              <RotateCcw size={15} />
            </button>
            <button
              className="icon-btn icon-btn-sm"
              aria-label="关闭预览"
              data-tip="关闭预览"
              data-tip-kbd="Esc"
              data-tip-side="bottom"
              onClick={close}
            >
              <X size={18} />
            </button>
          </div>
        </div>
        <ImageResources.Provider value={document.images ?? {}}>
          <div ref={stage} tabIndex={-1} className="runtime-stage">
            <div
              className="theater-frame-wrap"
              data-device-bezel={bezel}
              style={
                bezel === "iphone16"
                  ? {
                      padding: "16px 12px 14px",
                      borderRadius: 46,
                      background:
                        "linear-gradient(145deg, #2b2d34 0%, #15161a 100%)",
                      border: "3px solid #454854",
                      boxShadow:
                        "0 24px 64px rgba(0,0,0,0.55), inset 0 0 0 1px rgba(255,255,255,0.12)",
                      display: "flex",
                      flexDirection: "column",
                      alignItems: "center",
                    }
                  : bezel === "ipad-pro"
                    ? {
                        padding: "18px 18px",
                        borderRadius: 28,
                        background:
                          "linear-gradient(145deg, #272930 0%, #141519 100%)",
                        border: "2px solid #444752",
                        boxShadow:
                          "0 24px 64px rgba(0,0,0,0.5), inset 0 0 0 1px rgba(255,255,255,0.1)",
                        display: "flex",
                        flexDirection: "column",
                        alignItems: "center",
                      }
                    : bezel === "browser"
                      ? {
                          borderRadius: 12,
                          background: "#1f2026",
                          border: "1px solid #383a46",
                          boxShadow: "0 24px 60px rgba(0,0,0,0.45)",
                          overflow: "hidden",
                          display: "flex",
                          flexDirection: "column",
                        }
                      : undefined
              }
            >
              {bezel === "iphone16" && (
                <div
                  aria-hidden="true"
                  style={{
                    width: 96,
                    height: 22,
                    borderRadius: 14,
                    background: "#090a0d",
                    marginBottom: 8,
                    boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.08)",
                  }}
                />
              )}
              {bezel === "ipad-pro" && (
                <div
                  aria-hidden="true"
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: "50%",
                    background: "#0c0d11",
                    border: "1px solid #3a3d47",
                    marginBottom: 8,
                  }}
                />
              )}
              {bezel === "browser" && (
                <div
                  aria-hidden="true"
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    height: 32,
                    padding: "0 12px",
                    background: "#262830",
                    borderBottom: "1px solid #353742",
                  }}
                >
                  <span
                    style={{
                      width: 10,
                      height: 10,
                      borderRadius: "50%",
                      background: "#ff5f57",
                    }}
                  />
                  <span
                    style={{
                      width: 10,
                      height: 10,
                      borderRadius: "50%",
                      background: "#febc2e",
                    }}
                  />
                  <span
                    style={{
                      width: 10,
                      height: 10,
                      borderRadius: "50%",
                      background: "#28c840",
                    }}
                  />
                  <span
                    style={{
                      marginLeft: 10,
                      flex: 1,
                      height: 20,
                      lineHeight: "20px",
                      padding: "0 10px",
                      borderRadius: 6,
                      background: "#181920",
                      color: "#9aa0b4",
                      fontSize: 11,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    https://forma.preview/{activeBoard?.name ?? "screen"}
                  </span>
                </div>
              )}
              <div
                style={
                  bezel === "iphone16"
                    ? { borderRadius: 34, overflow: "hidden" }
                    : bezel === "ipad-pro"
                      ? { borderRadius: 16, overflow: "hidden" }
                      : undefined
                }
              >
                {program ? (
                  <PrototypePlayer
                    key={start + ":" + revision}
                    onScreenChange={setScreen}
                    nodes={nodes}
                    program={program}
                    start={start}
                    previewWidth={previewWidth}
                    onAction={(summary) => setLastAction(summary)}
                    fit={{ width: stageW, height: stageH, mode: zoomMode }}
                    style={documentRuntimeStyle(document, true)}
                  />
                ) : (
                  <div style={{ width: width * scale, height: height * scale }}>
                    <div
                      key={revision}
                      style={{
                        ...documentRuntimeStyle(document),
                        minWidth: width,
                        minHeight: height,
                        width,
                        height,
                        transform: `scale(${scale})`,
                        transformOrigin: "top left",
                        position: "relative",
                      }}
                    >
                      {nodes.map((node) => (
                        <DesignNodeView
                          key={node.id}
                          node={{
                            ...node,
                            style: { ...node.style, left: 0, top: 0 },
                          }}
                          onAction={(id, value) =>
                            setLastAction(
                              `${document.nodes.find((n) => n.id === id)?.name ?? id} → ${String(value)}`,
                            )
                          }
                        />
                      ))}
                    </div>
                  </div>
                )}
              </div>
              {bezel === "iphone16" && (
                <div
                  aria-hidden="true"
                  style={{
                    width: 116,
                    height: 4,
                    borderRadius: 3,
                    background: "rgba(255,255,255,0.4)",
                    marginTop: 8,
                  }}
                />
              )}
            </div>
          </div>
        </ImageResources.Provider>
        {lastAction && (
          <footer
            aria-live="polite"
            style={{
              padding: "6px 14px",
              background: "#1e1e1e",
              borderTop: "1px solid #303030",
              color: "#b3b3b3",
              fontSize: 11,
            }}
          >
            {lastAction}
          </footer>
        )}
      </div>
    </div>
  );
}
