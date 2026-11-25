import { useContext, useMemo, useState } from "react";
import { Crosshair } from "lucide-react";
import { resolveNode } from "../domain/design-system";
import { displayColor } from "../domain/color-profile";
import { FileColorContext } from "./ColorProfileDialog";
import { subtreeIds, isLocked } from "../domain/tree";
import type { EditorController } from "./useEditor";
import type { Operation } from "../domain/commands";
import { ColorField } from "./ColorField";

type Slot =
  | { id: string; kind: "fill" | "stroke" | "color"; variableName?: string }
  | { id: string; kind: "paint" | "strokePaint"; index: number }
  | {
      id: string;
      kind: "gradientStop";
      index: number;
      paintIndex?: number;
      stroke?: boolean;
    }
  | { id: string; kind: "vectorFill" | "vectorStroke"; index: number }
  | { id: string; kind: "shadow" | "textRun"; index: number };

export function SelectionColors({ editor }: { editor: EditorController }) {
  const profile = useContext(FileColorContext);
  const [open, setOpen] = useState(false);
  const palette = useMemo(() => {
    const result = new Map<string, Slot[]>();
    const included = subtreeIds(editor.doc, editor.selection);
    const sys = editor.doc.designSystem;
    for (const layer of editor.doc.nodes) {
      if (!included.has(layer.id) || isLocked(editor.doc, layer.id)) continue;
      const n = resolveNode(editor.doc, layer),
        s = n.style;
      const add = (color: string | undefined, slot: Slot) => {
        if (!color) return;
        const id = color.toLowerCase();
        const items = result.get(id) ?? [];
        items.push(slot);
        result.set(id, items);
      };
      if (!["group", "text", "vector"].includes(n.type) && !s.gradient) {
        const varId = layer.variableBindings?.fill;
        add(
          n.fillToken
            ? (editor.doc.tokens[n.fillToken]?.value ?? s.fill)
            : s.fill,
          {
            id: n.id,
            kind: "fill",
            variableName: varId ? sys?.variables[varId]?.name : undefined,
          },
        );
      }
      if (s.gradient) {
        s.gradient.stops.forEach((stop, index) =>
          add(stop.color, { id: n.id, kind: "gradientStop", index }),
        );
      }
      s.shadows?.forEach((shadow, index) => {
        if (shadow.visible !== false)
          add(shadow.color, { id: n.id, kind: "shadow", index });
      });
      for (const kind of ["paints", "strokePaints"] as const) {
        if (kind === "strokePaints" && s.strokeVisible === false) continue;
        s[kind]?.forEach((paint, index) => {
          if (!paint.visible) return;
          if (paint.gradient)
            paint.gradient.stops.forEach((stop, stopIndex) =>
              add(stop.color, {
                id: n.id,
                kind: "gradientStop",
                index: stopIndex,
                paintIndex: index,
                stroke: kind === "strokePaints",
              }),
            );
          else
            add(paint.color, {
              id: n.id,
              kind: kind === "strokePaints" ? "strokePaint" : "paint",
              index,
            });
        });
      }
      if (n.type === "vector" && n.vector) {
        let usesLayerColor = false;
        n.vector.paths.forEach((p, index) => {
          if (p.fill) {
            if (p.fillColor)
              add(p.fillColor, { id: n.id, kind: "vectorFill", index });
            else usesLayerColor = true;
          }
          if (p.strokeWidth) {
            if (p.strokeColor)
              add(p.strokeColor, { id: n.id, kind: "vectorStroke", index });
            else usesLayerColor = true;
          }
        });
        if (usesLayerColor) {
          const varId = layer.variableBindings?.color;
          add(s.color, {
            id: n.id,
            kind: "color",
            variableName: varId ? sys?.variables[varId]?.name : undefined,
          });
        }
      } else if (n.type === "text" || n.text) {
        const varId = layer.variableBindings?.color;
        add(s.color, {
          id: n.id,
          kind: "color",
          variableName: varId ? sys?.variables[varId]?.name : undefined,
        });
      }
      if (n.textRuns?.length) {
        n.textRuns.forEach((run, index) => {
          if (run.style.color)
            add(run.style.color, { id: n.id, kind: "textRun", index });
        });
      }
      if (
        !s.strokePaints?.length &&
        (s.strokeWidth || Object.values(s.strokeSides ?? {}).some(Boolean)) &&
        s.strokeVisible !== false
      ) {
        const varId = layer.variableBindings?.stroke;
        add(s.stroke ?? s.color, {
          id: n.id,
          kind: "stroke",
          variableName: varId ? sys?.variables[varId]?.name : undefined,
        });
      }
    }
    return result;
  }, [editor.doc, editor.selection]);

  const entries = [...palette.entries()];

  function replaceColor(oldColor: string, nextColor: string, slots: Slot[]) {
    if (nextColor.toLowerCase() === oldColor) return;
    const updates = new Map<string, Extract<Operation, { type: "update" }>>();
    const byId = new Map(editor.doc.nodes.map((n) => [n.id, n]));
    for (const slot of slots) {
      const layer = byId.get(slot.id);
      if (!layer) continue;
      const op = updates.get(slot.id) ?? {
        type: "update" as const,
        id: slot.id,
        patch: {},
        style: {},
      };
      if (
        slot.kind === "fill" ||
        slot.kind === "stroke" ||
        slot.kind === "color"
      ) {
        op.style = { ...op.style, [slot.kind]: nextColor };
        if (slot.kind === "fill")
          op.patch = { ...op.patch, fillToken: undefined };
      } else if (slot.kind === "paint" || slot.kind === "strokePaint") {
        const stack = slot.kind === "strokePaint" ? "strokePaints" : "paints";
        const paints = [
          ...(op.style?.[stack] ??
            resolveNode(editor.doc, layer).style[stack] ??
            []),
        ];
        if (paints[slot.index]) {
          paints[slot.index] = {
            ...paints[slot.index],
            color: nextColor,
            colorVariableId: undefined,
          };
          op.style = { ...op.style, [stack]: paints };
        }
      } else if (slot.kind === "gradientStop") {
        const style = resolveNode(editor.doc, layer).style;
        const stack = slot.stroke ? "strokePaints" : "paints";
        const paints = op.style?.[stack] ?? style[stack];
        const grad =
          slot.paintIndex === undefined
            ? (op.style?.gradient ?? style.gradient)
            : paints?.[slot.paintIndex].gradient;
        if (!grad) continue;
        const gradient = {
          ...grad,
          stops: grad.stops.map((stop, i) =>
            i === slot.index
              ? { ...stop, color: nextColor, variableId: undefined }
              : stop,
          ),
        };
        if (slot.paintIndex === undefined) op.style = { ...op.style, gradient };
        else
          op.style = {
            ...op.style,
            [stack]: paints?.map((paint, i) =>
              i === slot.paintIndex ? { ...paint, gradient } : paint,
            ),
          };
      } else if (
        (slot.kind === "vectorFill" || slot.kind === "vectorStroke") &&
        layer.vector
      ) {
        const vec = op.patch.vector ?? layer.vector;
        const paths = vec.paths.map((p, idx) =>
          idx === slot.index
            ? {
                ...p,
                [slot.kind === "vectorFill" ? "fillColor" : "strokeColor"]:
                  nextColor,
              }
            : p,
        );
        op.patch = { ...op.patch, vector: { ...vec, paths } };
      } else if (slot.kind === "shadow") {
        const shadows =
          op.style?.shadows ?? resolveNode(editor.doc, layer).style.shadows;
        op.style = {
          ...op.style,
          shadows: shadows?.map((shadow, i) =>
            i === slot.index ? { ...shadow, color: nextColor } : shadow,
          ),
        };
      } else if (slot.kind === "textRun" && layer.textRuns) {
        const runs = (op.patch.textRuns ?? layer.textRuns).map((r, idx) =>
          idx === slot.index
            ? { ...r, style: { ...r.style, color: nextColor } }
            : r,
        );
        op.patch = { ...op.patch, textRuns: runs };
      }
      updates.set(slot.id, op);
    }
    editor.attempt(() => editor.apply([...updates.values()]));
  }

  return (
    <section>
      <details
        className="advanced-properties"
        open={open}
        onToggle={(event) => setOpen(event.currentTarget.open)}
      >
        <summary
          title="查看并批量替换选区及子层的颜色（含填充、渐变、描边、矢量和富文本）；跳过锁定图层"
          style={{ display: "flex", alignItems: "center", gap: 6 }}
        >
          <span>选区纯色</span>
          {entries.length > 0 && (
            <span
              style={{
                marginLeft: "auto",
                display: "inline-flex",
                alignItems: "center",
                gap: 3,
              }}
            >
              {entries.slice(0, 5).map(([hex]) => (
                <i
                  key={hex}
                  aria-hidden="true"
                  style={{
                    width: 9,
                    height: 9,
                    borderRadius: 2,
                    border: "1px solid var(--border-strong)",
                    background: displayColor(hex, profile),
                    display: "inline-block",
                  }}
                />
              ))}
              <small style={{ color: "var(--text-muted)", marginLeft: 2 }}>
                {entries.length}
              </small>
            </span>
          )}
        </summary>
        {entries.map(([color, slots]) => {
          const varName = slots.find(
            (s) => "variableName" in s && s.variableName,
          );
          const matchingIds = [...new Set(slots.map((s) => s.id))];
          return (
            <div className="selection-color-row" key={color}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <ColorField
                  label={"选区颜色 " + color}
                  color={color}
                  allowAlpha={false}
                  onChange={(value) => replaceColor(color, value, slots)}
                />
                {varName &&
                  "variableName" in varName &&
                  varName.variableName && (
                    <small
                      style={{
                        display: "block",
                        fontSize: 10,
                        color: "var(--figma-blue)",
                        marginTop: 2,
                      }}
                    >
                      变量: {varName.variableName}
                    </small>
                  )}
              </div>
              <small title="引用位置数" style={{ color: "var(--text-muted)" }}>
                {slots.length}
              </small>
              <button
                type="button"
                className="icon-btn icon-btn-sm"
                aria-label={`选中所有使用颜色 ${color} 的图层`}
                data-tip="选中匹配图层"
                data-tip-desc={`选中此区域内使用 ${color.toUpperCase()} 的 ${matchingIds.length} 个图层`}
                data-tip-side="left"
                onClick={() => editor.setSelection(matchingIds)}
              >
                <Crosshair size={12} />
              </button>
            </div>
          );
        })}
      </details>
    </section>
  );
}
