import { useState } from "react";
import { Plus, Check, Unlink, Pencil } from "lucide-react";
import type { EditorController } from "./useEditor";
import type {
  LibraryComponent,
  ComponentVariant,
} from "../domain/library-schema";
import { localMasters } from "../domain/component-masters";
import { ancestors, instanceOwner, isLocked } from "../domain/tree";

export function MasterVariants({
  editor: e,
  component,
  variant,
  id,
}: {
  editor: EditorController;
  component: LibraryComponent;
  variant: ComponentVariant;
  id: string;
}) {
  const axes = Object.keys(variant.properties);
  const [selected, setSelected] = useState<string | null>(axes[0] ?? null);
  const [name, setName] = useState<string | null>(null);
  const [current, setCurrent] = useState<string | null>(null);
  const [next, setNext] = useState("");
  const axis = selected !== null && axes.includes(selected) ? selected : null;
  const label = (name ?? axis ?? (axes.length ? "" : "状态")).trim();
  const currentValue = current ?? (axis ? variant.properties[axis] : "默认");
  const choose = (axis: string | null) => {
    setSelected(axis);
    setCurrent(null);
    setName(null);
    setNext("");
  };
  const changed =
    !!axis &&
    (label !== axis || currentValue.trim() !== variant.properties[axis]);
  return (
    <details className="advanced-properties master-variants">
      <summary>组件变体 · {component.variants.length}</summary>
      <fieldset className="exposed-fields" disabled={isLocked(e.doc, id)}>
        <button
          className="wide"
          onClick={() =>
            e.attempt(() => e.apply([{ type: "arrangeComponentSet", id }]))
          }
        >
          在画布排列组件集
        </button>
        {axes.length > 0 && (
          <div className="track-toolbar">
            <select
              aria-label="选择变体属性"
              value={axis ?? ""}
              onChange={(ev) => choose(ev.target.value || null)}
            >
              {axes.map((a) => (
                <option key={a}>{a}</option>
              ))}
              <option value="">新增属性…</option>
            </select>
            {axis && (
              <button
                className="icon-btn icon-btn-sm"
                aria-label="重命名变体属性"
                data-tip="重命名变体属性"
                onClick={() => setName(name === null ? axis : null)}
              >
                <Pencil size={13} />
              </button>
            )}
            {component.variants[0].id !== variant.id && (
              <button
                className="icon-btn icon-btn-sm"
                aria-label="移出变体集"
                data-tip="移出变体集"
                data-tip-desc="保留画布图层。使用中的变体须先替换。"
                onClick={() =>
                  e.attempt(() =>
                    e.apply([{ type: "unlinkComponentVariant", id }]),
                  )
                }
              >
                <Unlink size={13} />
              </button>
            )}
          </div>
        )}
        {(!axis || name !== null) && (
          <label className="instance-property">
            属性名
            <input
              aria-label="变体属性名"
              maxLength={128}
              placeholder="属性名，如状态"
              value={name ?? axis ?? (axes.length ? "" : "状态")}
              onChange={(ev) => setName(ev.target.value)}
            />
          </label>
        )}
        <label className="instance-property">
          {axis ? "当前值" : "默认值"}
          <input
            aria-label="变体当前值"
            maxLength={200}
            value={currentValue}
            onChange={(ev) => setCurrent(ev.target.value)}
          />
        </label>
        {axis && changed && (
          <button
            className="wide"
            disabled={!label || !currentValue.trim()}
            onClick={() =>
              e.attempt(() => {
                e.apply([
                  {
                    type: "editVariantProperty",
                    id,
                    axis,
                    newAxis: label,
                    value: currentValue.trim(),
                  },
                ]);
                choose(label);
              })
            }
          >
            <Check size={13} />
            应用变体属性
          </button>
        )}
        <div className="track-toolbar">
          <input
            aria-label="新增变体值"
            maxLength={200}
            placeholder="新增值，如「悬停」"
            value={next}
            onChange={(ev) => setNext(ev.target.value)}
          />
          <button
            className="icon-btn icon-btn-sm"
            aria-label="添加变体"
            data-tip="添加变体"
            data-tip-desc="复制当前主组件，新变体可以在画布中直接编辑"
            disabled={
              !label ||
              (!axis && axes.includes(label)) ||
              !next.trim() ||
              !currentValue.trim() ||
              changed ||
              component.variants.length >= 200
            }
            onClick={() =>
              e.attempt(() => {
                const newId = crypto.randomUUID();
                e.apply([
                  {
                    type: "addComponentVariant",
                    id,
                    newId,
                    variantId: crypto.randomUUID(),
                    axis: label,
                    value: next.trim(),
                    defaultValue: currentValue.trim(),
                  },
                ]);
                e.setSelection([newId]);
                requestAnimationFrame(() => e.api.current?.fit([newId]));
              })
            }
          >
            <Plus size={14} />
          </button>
        </div>
      </fieldset>
    </details>
  );
}

export function CombineVariants({ editor: e }: { editor: EditorController }) {
  const nodes = e.selected;
  const prefix = nodes[0]?.name.split("/")[0].trim();
  const sharedPrefix =
    prefix && nodes.every((n) => n.name.split("/")[0].trim() === prefix)
      ? prefix
      : "";
  const [name, setName] = useState(sharedPrefix),
    [axis, setAxis] = useState("状态"),
    [values, setValues] = useState<Record<string, string>>({});
  if (
    nodes.length < 2 ||
    nodes.length > 200 ||
    nodes.some(
      (n) =>
        n.componentSet ||
        n.type !== nodes[0].type ||
        instanceOwner(e.doc, n.id) ||
        isLocked(e.doc, n.id),
    )
  )
    return null;
  const selected = new Set(e.selection);
  if (nodes.some((n) => ancestors(e.doc, n.id).some((p) => selected.has(p.id))))
    return null;
  const counts = new Map<string, number>();
  for (const n of nodes) counts.set(n.name, (counts.get(n.name) ?? 0) + 1);
  const labels = new Map(
    nodes.map((n, i) => [
      n.id,
      (counts.get(n.name) ?? 0) > 1 ? n.name + " · " + (i + 1) : n.name,
    ]),
  );
  const value = (n: (typeof nodes)[number]) =>
    Object.hasOwn(values, n.id)
      ? values[n.id]
      : sharedPrefix && n.name.includes("/")
        ? n.name.split("/").slice(1).join(" / ").trim()
        : labels.get(n.id)!;
  const copies = localMasters(e.doc).some((m) => selected.has(m.nodeId));
  const ready =
    name.trim() &&
    axis.trim() &&
    nodes.every((n) => value(n).trim()) &&
    new Set(nodes.map((n) => value(n).trim())).size === nodes.length;
  return (
    <section>
      <details className="advanced-properties">
        <summary>组合为变体集</summary>
        <fieldset className="exposed-fields">
          <label className="instance-property">
            组件集名
            <input
              aria-label="组件集名称"
              maxLength={200}
              value={name}
              onChange={(ev) => setName(ev.target.value)}
            />
          </label>
          <label className="instance-property">
            属性名
            <input
              aria-label="组件集属性"
              maxLength={128}
              value={axis}
              onChange={(ev) => setAxis(ev.target.value)}
            />
          </label>
          {nodes.map((n) => (
            <label key={n.id} className="instance-property">
              <span className="truncate" title={n.name}>
                {labels.get(n.id)}
              </span>
              <input
                aria-label={"变体值 " + labels.get(n.id)}
                value={value(n)}
                maxLength={200}
                onChange={(ev) =>
                  setValues({ ...values, [n.id]: ev.target.value })
                }
              />
            </label>
          ))}
          <button
            className="wide"
            disabled={!ready}
            data-tip="创建组件变体集"
            data-tip-desc={
              copies
                ? "已有主组件使用副本，保留原组件及其使用方"
                : "每个选中图层成为一个可在画布编辑的变体"
            }
            onClick={() =>
              e.attempt(() => {
                const libraryId = crypto.randomUUID();
                e.apply([
                  {
                    type: "createVariantSet",
                    canvas: true,
                    libraryId,
                    name: name.trim(),
                    axis: axis.trim(),
                    members: nodes.map((n) => ({
                      id: n.id,
                      value: value(n).trim(),
                      variantId: crypto.randomUUID(),
                    })),
                  },
                ]);
                const root =
                  e.historyRef.current.present.libraries?.[libraryId]
                    ?.components[0].master?.nodeId;
                if (root) {
                  e.setSelection([root]);
                  requestAnimationFrame(() => e.api.current?.fit([root]));
                }
              })
            }
          >
            <Plus size={13} />
            {copies ? "保留原主件，创建变体集" : "创建变体集"}
          </button>
        </fieldset>
      </details>
    </section>
  );
}
