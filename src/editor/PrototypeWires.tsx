import { useState, useRef, useEffect, useId, type PointerEvent } from "react";
import { Play, Plus } from "lucide-react";
import type { EditorController } from "./useEditor";
import type { Point, Rect, Viewport } from "../domain/geometry";
import { screenToWorld, contains } from "../domain/geometry";
import {
  transform,
  inverse,
  visualBounds,
  type Matrix,
} from "../domain/transforms";
import type { Interaction } from "../domain/prototype";
import { isLocked } from "../domain/tree";

type Link = { branch: "actions" | "otherwise"; index: number; target: string };
const WIRE_BLUE = "#0d99ff";

export function PrototypeWires({
  editor: e,
  viewport,
  bounds,
  matrices,
  onPlayFlow,
}: {
  editor: EditorController;
  viewport: Viewport;
  bounds: Map<string, Rect>;
  matrices: Map<string, Matrix>;
  onPlayFlow?: (frameId: string) => void;
}) {
  const node = e.selected.length === 1 ? e.selected[0] : undefined;
  const surface = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<{
    source: string;
    revision: number;
    link: Link | null;
    origin: Point;
    point: Point;
    target?: string;
  } | null>(null);
  const [picker, setPicker] = useState<{ link: Link | null } | null>(null);
  const arrow = useId();
  const mutedArrow = useId();
  useEffect(() => {
    setDrag(null);
    setPicker(null);
  }, [node?.id]);
  useEffect(() => {
    const stop = () => {
      setDrag(null);
      setPicker(null);
    };
    window.addEventListener("blur", stop);
    return () => window.removeEventListener("blur", stop);
  }, []);

  const project = (p: Point) => ({
    x: viewport.x + p.x * viewport.zoom,
    y: viewport.y + p.y * viewport.zoom,
  });
  const rect = (id: string) => {
    const b = bounds.get(id);
    if (!b) return null;
    return visualBounds(b, matrices.get(id)!);
  };
  const boards = e.doc.nodes.filter(
    (n) => !n.parentId && n.type === "frame" && !n.hidden,
  );
  const flowBoards = boards.filter((b) => !!b.interaction?.flow);

  function routeWire(srcBox: Rect, dstBox: Rect, offsetY = 0) {
    const srcCenter = {
      x: srcBox.x + srcBox.width / 2,
      y: srcBox.y + srcBox.height / 2,
    };
    const dstCenter = {
      x: dstBox.x + dstBox.width / 2,
      y: dstBox.y + dstBox.height / 2,
    };
    const goesLeft = dstCenter.x + dstBox.width * 0.25 < srcBox.x;
    const fromWorld = goesLeft
      ? { x: srcBox.x, y: srcCenter.y }
      : { x: srcBox.x + srcBox.width, y: srcCenter.y };
    const toWorld = goesLeft
      ? { x: dstBox.x + dstBox.width, y: dstCenter.y }
      : { x: dstBox.x, y: dstCenter.y };
    const s = project(fromWorld);
    const t = project(toWorld);
    t.y += offsetY;
    const dir = goesLeft ? -1 : 1;
    const curve = Math.max(36, Math.min(160, Math.abs(t.x - s.x) / 2));
    return {
      start: s,
      end: t,
      d: `M${s.x} ${s.y} C${s.x + dir * curve} ${s.y} ${t.x - dir * curve} ${t.y} ${t.x} ${t.y}`,
    };
  }

  // Ambient page wires for non-selected layers so designers see the full flow map
  const ambientWires: {
    key: string;
    source: string;
    d: string;
    dashed: boolean;
  }[] = [];
  for (const n of e.doc.nodes) {
    if (n.id === node?.id || !n.interaction || n.hidden) continue;
    const srcBox = rect(n.id);
    if (!srcBox) continue;
    for (const branch of ["actions", "otherwise"] as const) {
      n.interaction[branch]?.forEach((a, idx) => {
        if (a.kind !== "navigate" && a.kind !== "overlay") return;
        const dstBox = rect(a.target);
        if (!dstBox) return;
        const routed = routeWire(srcBox, dstBox);
        ambientWires.push({
          key: `${n.id}-${branch}-${idx}`,
          source: n.id,
          d: routed.d,
          dashed: branch === "otherwise",
        });
      });
    }
  }

  const source = node;
  const box = source ? rect(source.id) : null;
  const start = box
    ? project({ x: box.x + box.width, y: box.y + box.height / 2 })
    : { x: 0, y: 0 };

  const links: Link[] = [];
  if (source) {
    for (const branch of ["actions", "otherwise"] as const)
      source.interaction?.[branch]?.forEach((a, index) => {
        if (a.kind === "navigate" || a.kind === "overlay")
          links.push({ branch, index, target: a.target });
      });
  }

  function commit(link: Link | null, target: string, revision: number) {
    if (!source) return;
    const rule: Interaction = { ...source.interaction };
    if (link) {
      const actions = rule[link.branch]?.slice();
      const existing = actions?.[link.index];
      if (
        !actions ||
        !existing ||
        (existing.kind !== "navigate" && existing.kind !== "overlay") ||
        existing.target !== link.target ||
        existing.target === target
      )
        return;
      actions[link.index] = { ...existing, target };
      rule[link.branch] = actions;
    } else
      rule.actions = [...(rule.actions ?? []), { kind: "navigate", target }];
    e.attempt(() =>
      e.apply(
        [{ type: "update", id: source.id, patch: { interaction: rule } }],
        revision,
      ),
    );
  }

  function disconnect(link: Link, revision: number) {
    if (!source) return;
    const rule: Interaction = { ...source.interaction };
    const actions = rule[link.branch]?.slice();
    if (!actions || !actions[link.index]) return;
    actions.splice(link.index, 1);
    rule[link.branch] = actions;
    e.attempt(() =>
      e.apply(
        [{ type: "update", id: source.id, patch: { interaction: rule } }],
        revision,
      ),
    );
  }

  function pointer(ev: PointerEvent<HTMLButtonElement>) {
    const b = surface.current!.getBoundingClientRect(),
      point = { x: ev.clientX - b.left, y: ev.clientY - b.top };
    const world = screenToWorld(point, viewport);
    const target = boards
      .slice()
      .reverse()
      .find((n) =>
        contains(
          bounds.get(n.id)!,
          transform(inverse(matrices.get(n.id)!), world),
        ),
      )?.id;
    return { point, target };
  }

  function handle(key: string, label: string, p: Point, link: Link | null) {
    if (!source) return null;
    return (
      <button
        key={key}
        type="button"
        className={"wire-handle" + (link ? " wire-target" : " wire-source")}
        data-tip={link ? "单击选择目标，拖至空白断开" : label}
        title={link ? `${label}（拖至空白画布可断开）` : label}
        aria-label={label}
        disabled={isLocked(e.doc, source.id)}
        style={{ left: p.x, top: p.y }}
        onPointerDown={(ev) => {
          if (ev.button !== 0) return;
          ev.preventDefault();
          ev.stopPropagation();
          ev.currentTarget.focus({ preventScroll: true });
          ev.currentTarget.setPointerCapture(ev.pointerId);
          setDrag({
            source: source.id,
            link,
            revision: e.committed.revision,
            origin: pointer(ev).point,
            ...pointer(ev),
          });
        }}
        onPointerMove={(ev) => {
          if (drag) {
            ev.stopPropagation();
            setDrag({ ...drag, ...pointer(ev) });
          }
        }}
        onPointerUp={(ev) => {
          if (!drag) return;
          ev.stopPropagation();
          const { target, point } = pointer(ev);
          if (drag.source === source.id) {
            if (
              Math.hypot(point.x - drag.origin.x, point.y - drag.origin.y) < 3
            )
              setPicker({ link: drag.link });
            else if (target) commit(drag.link, target, drag.revision);
            else if (drag.link) disconnect(drag.link, drag.revision);
          }
          setDrag(null);
        }}
        onPointerCancel={() => setDrag(null)}
        onLostPointerCapture={() => setDrag(null)}
        onKeyDown={(ev) => {
          if (ev.key === "Escape") {
            ev.preventDefault();
            ev.stopPropagation();
            setDrag(null);
            setPicker(null);
          }
          if ((ev.key === "Delete" || ev.key === "Backspace") && link) {
            ev.preventDefault();
            ev.stopPropagation();
            disconnect(link, e.committed.revision);
          }
        }}
        onClick={(ev) => {
          ev.stopPropagation();
          if (ev.detail === 0) setPicker({ link });
        }}
      >
        {!link && <Plus size={11} />}
      </button>
    );
  }

  const endpoint = (link: Link) => {
    const dstBox = rect(link.target);
    if (!box || !dstBox) return { x: 0, y: 0, d: "" };
    const matching = links.filter((l) => l.target === link.target);
    const offsetY = (matching.indexOf(link) - (matching.length - 1) / 2) * 12;
    const routed = routeWire(box, dstBox, offsetY);
    return { x: routed.end.x, y: routed.end.y, d: routed.d };
  };

  const dragPath = (end: Point) => {
    const curve = Math.max(36, Math.min(160, Math.abs(end.x - start.x) / 2));
    return `M${start.x} ${start.y} C${start.x + curve} ${start.y} ${end.x - curve} ${end.y} ${end.x} ${end.y}`;
  };

  const local = links.filter((l) => bounds.has(l.target));
  const highlight = drag?.target ? rect(drag.target) : null;
  return (
    <div ref={surface} className="wire-layer">
      <svg aria-hidden="true">
        <defs>
          <marker
            id={arrow}
            viewBox="0 0 8 8"
            refX="7"
            refY="4"
            markerWidth="6"
            markerHeight="6"
            orient="auto"
          >
            <path d="M0 0L8 4L0 8Z" fill={WIRE_BLUE} />
          </marker>
          <marker
            id={mutedArrow}
            viewBox="0 0 8 8"
            refX="7"
            refY="4"
            markerWidth="6"
            markerHeight="6"
            orient="auto"
          >
            <path d="M0 0L8 4L0 8Z" fill={WIRE_BLUE} fillOpacity="0.4" />
          </marker>
        </defs>
        {ambientWires.map((w) => (
          <path
            key={w.key}
            d={w.d}
            fill="none"
            stroke={WIRE_BLUE}
            strokeOpacity={0.35}
            strokeWidth={1.5}
            strokeDasharray={w.dashed ? "4 3" : undefined}
            markerEnd={`url(#${mutedArrow})`}
          />
        ))}
        {local.map((l) => (
          <path
            key={l.branch + l.index}
            d={endpoint(l).d}
            fill="none"
            stroke={WIRE_BLUE}
            strokeWidth={2}
            strokeDasharray={l.branch === "otherwise" ? "4 3" : undefined}
            markerEnd={`url(#${arrow})`}
          />
        ))}
        {ambientWires.map((wire) => (
          <path
            key={"hit-" + wire.key}
            className="wire-hit"
            d={wire.d}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              e.setSelection([wire.source]);
            }}
          />
        ))}
        {source &&
          !isLocked(e.doc, source.id) &&
          local.map((link) => (
            <path
              key={"hit-" + link.branch + link.index}
              className="wire-hit wire-hit-selected"
              d={endpoint(link).d}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation();
                setPicker({ link });
              }}
            />
          ))}
        {drag && (
          <path
            d={dragPath(drag.point)}
            fill="none"
            stroke={WIRE_BLUE}
            strokeWidth={2}
            strokeDasharray="5 3"
          />
        )}
        {highlight && (
          <rect
            x={project(highlight).x}
            y={project(highlight).y}
            width={highlight.width * viewport.zoom}
            height={highlight.height * viewport.zoom}
            stroke={WIRE_BLUE}
            strokeWidth={2}
            fill="rgba(13, 153, 255, 0.06)"
          />
        )}
      </svg>
      {flowBoards.map((board) => {
        const b = rect(board.id);
        if (!b) return null;
        const pos = project({ x: b.x, y: b.y });
        return (
          <button
            key={`flow-${board.id}`}
            type="button"
            className="flow-canvas-badge"
            style={{ left: pos.x, top: pos.y - 24 }}
            aria-label={`播放流程 ${board.interaction!.flow}`}
            data-tip={`从「${board.interaction!.flow}」开始预览`}
            onPointerDown={(ev) => ev.stopPropagation()}
            onClick={(ev) => {
              ev.stopPropagation();
              if (onPlayFlow) onPlayFlow(board.id);
              else e.setSelection([board.id]);
            }}
          >
            <Play size={10} fill="currentColor" />
            <span>{board.interaction!.flow}</span>
          </button>
        );
      })}
      {source &&
        box &&
        local.map((l) => {
          const ep = endpoint(l);
          return handle(
            l.branch + l.index,
            "调整连接至 " + e.doc.nodes.find((n) => n.id === l.target)!.name,
            { x: ep.x, y: ep.y },
            l,
          );
        })}
      {source &&
        box &&
        handle("new", "新建原型连接", { x: start.x + 9, y: start.y }, null)}
      {source && box && picker && (
        <select
          autoFocus
          className="wire-picker"
          style={{
            left: Math.max(
              4,
              Math.min(
                start.x + 14,
                (surface.current?.clientWidth ?? 200) - 180,
              ),
            ),
            top: Math.max(
              4,
              Math.min(
                start.y + 12,
                (surface.current?.clientHeight ?? 40) - 36,
              ),
            ),
          }}
          aria-label="连接目标画板"
          defaultValue={picker.link?.target ?? ""}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.stopPropagation();
              setPicker(null);
            }
          }}
          onBlur={() => setPicker(null)}
          onPointerDown={(ev) => ev.stopPropagation()}
          onChange={(ev) => {
            if (
              picker.link &&
              ev.currentTarget.selectedOptions[0]?.dataset.disconnect
            )
              disconnect(picker.link, e.committed.revision);
            else if (ev.target.value)
              commit(picker.link, ev.target.value, e.committed.revision);
            setPicker(null);
          }}
        >
          {!picker.link && (
            <option value="" disabled>
              选择画板
            </option>
          )}
          {picker.link && (
            <option data-disconnect="true" value="">
              断开连接
            </option>
          )}
          {boards.map((n) => (
            <option key={n.id} value={n.id}>
              {n.name}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}
