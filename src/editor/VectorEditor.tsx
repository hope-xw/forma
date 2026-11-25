import { displayColor } from "../domain/color-profile";
import {
  useLayoutEffect,
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
} from "lucide-react";
import type { EditorController } from "./useEditor";
import { createNode, type DesignNode } from "../domain/document";
import type { Point, Rect, Viewport } from "../domain/geometry";
import {
  identity,
  inverse,
  localTransform,
  transform,
  vector,
  type Matrix,
} from "../domain/transforms";
import {
  editablePaths,
  encodeVector,
  mapContours,
  moveNetworkAnchor,
  branchVector,
  pathData,
  splitSegment,
  vectorBounds,
  type EditablePath,
} from "../domain/vector-path";

type Selection = { p: number; c: number; a: number };
type Handle = "anchor" | "incoming" | "outgoing";
const newPaths = (): EditablePath[] => [
  { fill: false, strokeWidth: 2, contours: [{ anchors: [], closed: false }] },
];
interface Props {
  panning: boolean;
  editor: EditorController;
  node?: DesignNode;
  box?: Rect;
  viewport: Viewport;
  parentAt: (p: Point) => { id: string | null; box?: Rect; matrix: Matrix };
  close: () => void;
}
export function VectorEditor({
  editor: e,
  node,
  box,
  viewport,
  parentAt,
  close,
  panning,
}: Props) {
  const root = useRef<SVGSVGElement>(null),
    group = useRef<SVGGElement>(null);
  const original = useMemo(
    () => (node?.vector ? editablePaths(node.vector) : newPaths()),
    [node?.vector],
  );
  const [working, setWorking] = useState<EditablePath[] | null>(null),
    paths = working ?? original;
  const [selected, select] = useState<Selection | null>(null);
  const [branching, setBranching] = useState(false);
  const [cursor, setCursor] = useState<Point | null>(null);
  const drag = useRef<{
    pick: Selection;
    handle: Handle;
    pointer: number;
    start: Point;
    before: EditablePath[];
    mirror: boolean;
    changed: boolean;
  } | null>(null);
  const parent = useRef<ReturnType<Props["parentAt"]> | null>(null);
  const [matrix, setMatrix] = useState<Matrix>(identity);
  useLayoutEffect(() => {
    if (!root.current) return;
    const element =
      node &&
      root.current.parentElement?.querySelector<SVGSVGElement>(
        '[data-node-id="' + CSS.escape(node.id) + '"] > svg',
      );
    const local = root.current.getScreenCTM(),
      paint = element?.getScreenCTM();
    setMatrix(
      local && paint
        ? local.inverse().multiply(paint)
        : {
            a: viewport.zoom,
            b: 0,
            c: 0,
            d: viewport.zoom,
            e: viewport.x,
            f: viewport.y,
          },
    );
  }, [node, viewport, box]);
  const unit = 1 / Math.max(0.001, Math.hypot(matrix.a, matrix.b));
  function point(ev: Pointer<SVGElement>) {
    const m = group.current!.getScreenCTM()!.inverse();
    return transform(m, { x: ev.clientX, y: ev.clientY });
  }
  function commit(next: EditablePath[]) {
    if (!node || !box || !node.vector) return;
    const b = vectorBounds(next),
      v = node.vector,
      s = Math.min(box.width / v.width, box.height / v.height);
    const sx = v.stretch ? box.width / v.width : s,
      sy = v.stretch ? box.height / v.height : s;
    const width = b.width * sx,
      height = b.height * sy;
    const shift = vector(localTransform(node, box), {
      x: (b.x + (b.width - v.width) / 2) * sx,
      y: (b.y + (b.height - v.height) / 2) * sy,
    });
    e.apply([
      {
        type: "update",
        id: node.id,
        patch: { vector: { ...encodeVector(next, b), stretch: v.stretch } },
        style: {
          x: node.style.x + shift.x + (box.width - width) / 2,
          y: node.style.y + shift.y + (box.height - height) / 2,
          width: Math.max(1, width),
          height: Math.max(1, height),
          widthMode: "fixed",
          heightMode: "fixed",
        },
      },
    ]);
    setWorking(null);
  }
  function finish(closed: boolean) {
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
  function changePoint(
    command: "remove" | "split" | "smooth" | "close",
    delta?: Point,
  ) {
    if (!selected) return;
    const next = structuredClone(paths),
      c = next[selected.p]?.contours[selected.c],
      i = selected.a,
      a = c?.anchors[i];
    if (!a) return;
    if (delta)
      moveNetworkAnchor(next, selected, { x: a.x + delta.x, y: a.y + delta.y });
    else if (command === "split") {
      splitSegment(c, i);
    } else if (command === "close") {
      if (c.anchors.length > 2) c.closed = !c.closed;
    } else if (command === "smooth") {
      if (a.incoming || a.outgoing) {
        delete a.incoming;
        delete a.outgoing;
      } else {
        const prev = c.anchors[(i + c.anchors.length - 1) % c.anchors.length],
          n = c.anchors[(i + 1) % c.anchors.length],
          dx = (n.x - prev.x) / 6,
          dy = (n.y - prev.y) / 6;
        a.incoming = { x: a.x - dx, y: a.y - dy };
        a.outgoing = { x: a.x + dx, y: a.y + dy };
      }
    } else {
      if (
        node &&
        c.anchors.length <= 2 &&
        next.length === 1 &&
        next[0].contours.length === 1
      )
        return;
      c.anchors.splice(i, 1);
      if (c.anchors.length < 3) c.closed = false;
      if (node && c.anchors.length < 2) {
        next[selected.p].contours.splice(selected.c, 1);
        if (!next[selected.p].contours.length) next.splice(selected.p, 1);
      }
      select(null);
    }
    if (node) e.attempt(() => commit(next));
    else setWorking(next);
  }
  useLayoutEffect(() => {
    const key = (ev: KeyboardEvent) => {
      if (
        (ev.target as Element)?.closest?.("input,textarea,select,[role=dialog]")
      )
        return;
      if (
        !node &&
        (ev.metaKey || ev.ctrlKey) &&
        !ev.shiftKey &&
        !ev.altKey &&
        ev.key.toLowerCase() === "z"
      ) {
        ev.preventDefault();
        ev.stopImmediatePropagation();
        const anchors = paths[0]?.contours[0]?.anchors;
        if (anchors && anchors.length > 0) {
          const next = structuredClone(paths);
          next[0].contours[0].anchors.pop();
          const rem = next[0].contours[0].anchors.length;
          setWorking(next);
          select(rem > 0 ? { p: 0, c: 0, a: rem - 1 } : null);
          return;
        }
        return;
      }
      if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
      const arrow = ev.key.startsWith("Arrow");
      if (
        !arrow &&
        !["Escape", "Enter", "Backspace", "Delete"].includes(ev.key)
      )
        return;
      ev.preventDefault();
      ev.stopImmediatePropagation();
      if (ev.key === "Escape") {
        if (branching) {
          setBranching(false);
          return;
        }
        close();
        return;
      }
      if (ev.key === "Enter") {
        e.attempt(() => finish(false));
        return;
      }
      if (arrow) {
        const d = ev.shiftKey ? 10 : 1;
        changePoint("remove", {
          x: ev.key === "ArrowRight" ? d : ev.key === "ArrowLeft" ? -d : 0,
          y: ev.key === "ArrowDown" ? d : ev.key === "ArrowUp" ? -d : 0,
        });
      } else changePoint("remove");
    };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  });
  function down(ev: Pointer<SVGSVGElement>) {
    if (ev.button !== 0 || panning) return;
    ev.preventDefault();
    ev.stopPropagation();
    const pos = point(ev),
      el = (ev.target as Element).closest<SVGElement>("[data-anchor]");
    const next = structuredClone(paths);
    let pick: Selection,
      handle: Handle = "anchor";
    if (node && branching && selected) {
      const target =
        el && !el.dataset.handle
          ? {
              p: Number(el.dataset.path),
              c: Number(el.dataset.contour),
              a: Number(el.dataset.anchor),
            }
          : undefined;
      e.attempt(() => {
        branchVector(next, selected, pos, target);
        commit(next);
        setBranching(false);
        select(null);
      });
      return;
    }
    if (el) {
      pick = {
        p: Number(el.dataset.path),
        c: Number(el.dataset.contour),
        a: Number(el.dataset.anchor),
      };
      handle = (el.dataset.handle ?? "anchor") as Handle;
      if (!node && pick.a === 0 && next[0].contours[0].anchors.length >= 3) {
        e.attempt(() => finish(true));
        return;
      }
    } else if (!node) {
      const c = next[0].contours[0];
      if (!c.anchors.length) parent.current = parentAt(pos);
      pick = { p: 0, c: 0, a: c.anchors.length };
      c.anchors.push(pos);
      handle = "outgoing";
      setWorking(next);
    } else {
      select(null);
      return;
    }
    select(pick);
    ev.currentTarget.setPointerCapture(ev.pointerId);
    let mirror = true;
    if (handle !== "anchor") {
      const anchor = next[pick.p]?.contours[pick.c]?.anchors[pick.a];
      const oppKey = handle === "incoming" ? "outgoing" : "incoming";
      const cur = anchor?.[handle],
        opp = anchor?.[oppKey];
      if (anchor && cur && opp) {
        mirror =
          Math.hypot(
            opp.x - (2 * anchor.x - cur.x),
            opp.y - (2 * anchor.y - cur.y),
          ) < Math.max(1.5, unit * 3);
      }
    }
    drag.current = {
      pick,
      handle,
      start: pos,
      pointer: ev.pointerId,
      before: next,
      mirror,
      changed: false,
    };
  }
  function move(ev: Pointer<SVGSVGElement>) {
    const track = drag.current;
    if (!track) {
      if (!node && paths[0].contours[0].anchors.length && !panning)
        setCursor(point(ev));
      return;
    }
    setCursor(null);
    ev.stopPropagation();
    const p = point(ev);
    if (
      !track.changed &&
      Math.hypot(p.x - track.start.x, p.y - track.start.y) < unit * 2
    )
      return;
    track.changed = true;
    const next = structuredClone(track.before),
      { p: j, c, k } = { p: track.pick.p, c: track.pick.c, k: track.pick.a };
    const anchors = next[j].contours[c].anchors,
      a = anchors[k];
    if (track.handle === "anchor")
      moveNetworkAnchor(next, track.pick, {
        x: a.x + p.x - track.start.x,
        y: a.y + p.y - track.start.y,
      });
    else {
      a[track.handle] = p;
      if (!ev.altKey && track.mirror)
        a[track.handle === "incoming" ? "outgoing" : "incoming"] = {
          x: 2 * a.x - p.x,
          y: 2 * a.y - p.y,
        };
    }
    setWorking(next);
  }
  function end(ev: Pointer<SVGSVGElement>) {
    const t = drag.current;
    if (!t) return;
    ev.stopPropagation();
    drag.current = null;
    if (node && working && t.changed) e.attempt(() => commit(working));
  }
  const a =
    selected && paths[selected.p]?.contours[selected.c]?.anchors[selected.a];
  return (
    <>
      <svg
        ref={root}
        className="vector-surface"
        aria-label={node ? "矢量编辑" : "钢笔绘制"}
        onPointerLeave={() => setCursor(null)}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={end}
        onPointerCancel={() => {
          drag.current = null;
          if (node) setWorking(null);
        }}
        onDoubleClick={(ev) => {
          ev.stopPropagation();
          if (!node) e.attempt(() => finish(false));
        }}
      >
        <g
          ref={group}
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
            <g key={j}>
              <path
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
              {p.contours.map((c, k) =>
                c.anchors.map((v, i) => (
                  <circle
                    key={k + "-" + i}
                    data-path={j}
                    data-contour={k}
                    data-anchor={i}
                    aria-label={"锚点 " + (i + 1)}
                    cx={v.x}
                    cy={v.y}
                    r={4 * unit}
                    fill={
                      selected?.a === i && selected.c === k && selected.p === j
                        ? "#7159ed"
                        : "white"
                    }
                    stroke="#7159ed"
                    strokeWidth={1.3 * unit}
                  />
                )),
              )}
            </g>
          ))}
          {a &&
            selected &&
            (["incoming", "outgoing"] as const).map(
              (key) =>
                a[key] && (
                  <g key={key}>
                    <line
                      x1={a.x}
                      y1={a.y}
                      x2={a[key].x}
                      y2={a[key].y}
                      stroke="#8670fa"
                      strokeWidth={unit}
                    />
                    <rect
                      data-path={selected.p}
                      data-contour={selected.c}
                      data-anchor={selected.a}
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
      </svg>
      <div
        className="vector-tools"
        onPointerDown={(ev) => ev.stopPropagation()}
      >
        {node && (
          <>
            <button
              className="icon-btn icon-btn-sm"
              title="从锚点连接分支"
              aria-label="从锚点连接分支"
              aria-pressed={branching}
              disabled={!a}
              data-tip="从锚点连接分支"
              data-tip-desc="点击空白处延伸，或点击同一区域的不相邻锚点分区"
              onClick={() => setBranching(!branching)}
            >
              <GitBranch size={14} />
            </button>
            <button
              className="icon-btn icon-btn-sm"
              title="插入中点"
              aria-label="插入中点"
              data-tip="插入中点"
              disabled={!a}
              onClick={() => changePoint("split")}
            >
              <Plus size={14} />
            </button>
            <button
              className="icon-btn icon-btn-sm"
              title="删除锚点"
              aria-label="删除锚点"
              data-tip="删除锚点"
              disabled={!a}
              onClick={() => changePoint("remove")}
            >
              <Minus size={14} />
            </button>
            <button
              className="icon-btn icon-btn-sm"
              title="切换平滑锚点"
              aria-label="切换平滑锚点"
              data-tip="切换平滑锚点"
              disabled={!a}
              onClick={() => changePoint("smooth")}
            >
              <GitCommitHorizontal size={15} />
            </button>
            <button
              className="icon-btn icon-btn-sm"
              title="闭合或打开路径"
              aria-label="闭合或打开路径"
              data-tip="闭合或打开路径"
              disabled={!a}
              onClick={() => changePoint("close")}
            >
              <CornerUpLeft size={14} />
            </button>
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
