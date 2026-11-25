import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { MasterVariants } from "./MasterVariants";
import { ChevronDown, Minus, Plus, Search, X } from "lucide-react";
import { useModalDialog } from "./useModalDialog";
import type { EditorController } from "./useEditor";
import { localMasters } from "../domain/component-masters";
import { isLocked, subtreeIds } from "../domain/tree";
import { findLayer } from "../domain/scene-index";
import { instanceSource } from "../domain/library";
import type { Operation } from "../domain/commands";
import { resolveNode } from "../domain/design-system";
import type { ExposedProperty } from "../domain/library-schema";
import type { DesignNode } from "../domain/node";

export function MasterProperties({
  editor: e,
  id,
}: {
  editor: EditorController;
  id: string;
}) {
  const m = localMasters(e.doc).find((m) => m.nodeId === id);
  const [target, setTarget] = useState(""),
    [kind, setKind] = useState<ExposedProperty["kind"] | "inherited">("text"),
    [name, setName] = useState("");
  if (!m) return null;
  const properties = m.component.exposed ?? [];
  const template = m.variant.nodes;
  const byId = new Map(template.map((n) => [n.id, n]));
  const inherited = template.flatMap((slot) => {
    const live = findLayer(e.doc, slot.id);
    if (!live?.instance) return [];
    const fields = instanceSource(e.doc, live)?.component.exposed ?? [];
    if (!fields.length) return [];
    const children = new Map(
      [...subtreeIds(e.doc, [live.id])].map((id) => [
        findLayer(e.doc, id)?.templateKey,
        id,
      ]),
    );
    return fields.flatMap((field) => {
      const layer = byId.get(children.get(field.target) ?? "");
      if (!layer?.templateKey) return [];
      return [
        {
          id: JSON.stringify([slot.id, field.id]),
          label: slot.name + " / " + field.name,
          suggested: field.name,
          kind: field.kind,
          target: layer.templateKey,
        },
      ];
    });
  });
  const available =
    kind === "inherited"
      ? inherited
      : template
          .filter((n) =>
            kind === "swap"
              ? n.nestedSlot
              : kind === "visible" || n.type === "text" || n.type === "button",
          )
          .map((n) => ({
            id: n.templateKey!,
            label: n.name,
            suggested: "",
            kind,
            target: n.templateKey!,
          }));
  const selected = available.find((n) => n.id === target) ?? available[0];
  const propertyName = name.trim() || selected?.suggested || "";
  const commit = (next: ExposedProperty[]) =>
    e.attempt(() =>
      e.apply([
        {
          type: "setComponentProperties",
          id,
          libraryId: m.library.id,
          componentId: m.component.id,
          properties: next,
        },
      ]),
    );
  return (
    <section>
      <MasterVariants
        key={id}
        editor={e}
        id={id}
        component={m.component}
        variant={m.variant}
      />
      <details className="advanced-properties">
        <summary>公开组件属性 · {properties.length}</summary>
        <fieldset disabled={isLocked(e.doc, id)} className="exposed-fields">
          {properties.map((p) => (
            <div key={p.id} className="track-toolbar">
              <input
                key={p.name}
                aria-label={"重命名属性 " + p.name}
                defaultValue={p.name}
                maxLength={100}
                onBlur={(ev) => {
                  const value = ev.currentTarget.value.trim();
                  ev.currentTarget.value = p.name;
                  if (value && value !== p.name)
                    commit(
                      properties.map((other) =>
                        other.id === p.id ? { ...other, name: value } : other,
                      ),
                    );
                }}
                onKeyDown={(ev) => {
                  if (ev.key === "Escape") ev.currentTarget.value = p.name;
                  if (ev.key === "Enter" || ev.key === "Escape")
                    ev.currentTarget.blur();
                }}
              />
              <small>
                {{ text: "文本", visible: "显示", swap: "嵌套替换" }[p.kind]}
              </small>
              <button
                className="icon-btn icon-btn-sm"
                aria-label={"移除属性 " + p.name}
                data-tip={"移除属性 " + p.name}
                onClick={() => commit(properties.filter((s) => s.id !== p.id))}
              >
                <Minus size={13} />
              </button>
            </div>
          ))}
          <select
            aria-label="组件属性类型"
            value={kind}
            onChange={(ev) => setKind(ev.target.value as typeof kind)}
          >
            <option value="text">文本</option>
            <option value="inherited" disabled={!inherited.length}>
              来自嵌套实例
            </option>
            <option value="visible">显示 / 隐藏</option>
            <option value="swap" disabled={!template.some((n) => n.nestedSlot)}>
              嵌套实例替换
            </option>
          </select>
          <select
            aria-label="属性目标图层"
            value={selected?.id ?? ""}
            onChange={(ev) => setTarget(ev.target.value)}
          >
            {available.map((n) => (
              <option key={n.id} value={n.id}>
                {n.label}
              </option>
            ))}
          </select>
          <div className="track-toolbar">
            <input
              aria-label="组件属性名称"
              placeholder={selected?.suggested || "属性名称"}
              value={name}
              onChange={(ev) => setName(ev.target.value)}
            />
            <button
              className="icon-btn icon-btn-sm"
              disabled={
                !propertyName ||
                !selected ||
                properties.some(
                  (p) =>
                    p.name === propertyName ||
                    p.previousNames?.includes(propertyName),
                )
              }
              aria-label="公开属性"
              data-tip="公开属性"
              data-tip-desc="使设计师可以从实例根层编辑此值"
              onClick={() => {
                commit([
                  ...properties,
                  {
                    id: crypto.randomUUID(),
                    name: propertyName,
                    kind: selected.kind,
                    target: selected.target,
                  },
                ]);
                setName("");
              }}
            >
              <Plus size={14} />
            </button>
          </div>
        </fieldset>
      </details>
    </section>
  );
}
type Source = NonNullable<ReturnType<typeof instanceSource>>;
export type InstanceSelection = { root: DesignNode; source: Source };

function sameValue<T>(values: T[]) {
  return values.every((v) => v === values[0]) ? values[0] : undefined;
}
const componentKey = (id: string, component: string) =>
  JSON.stringify([id, component]);

interface SlotOption {
  key: string;
  label: string;
  group: string;
}

function SlotSwapPicker({
  ariaLabel,
  disabled,
  value,
  options,
  onSelect,
  allowReset = true,
}: {
  ariaLabel: string;
  disabled: boolean;
  value: string | undefined;
  options: SlotOption[];
  onSelect(choice: string): void;
  allowReset?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const trigger = useRef<HTMLButtonElement>(null);
  const popup = useModalDialog(open, () => setOpen(false));
  useEffect(() => {
    if (!open) return;
    const outside = (ev: PointerEvent) => {
      if (
        !popup.current?.contains(ev.target as Node) &&
        !trigger.current?.contains(ev.target as Node)
      )
        setOpen(false);
    };
    window.addEventListener("pointerdown", outside);
    return () => window.removeEventListener("pointerdown", outside);
  }, [open, popup]);

  const currentLabel =
    value === undefined
      ? "Mixed"
      : value === ""
        ? "主组件默认"
        : (options.find((o) => o.key === value)?.label ?? "自定义插槽内容");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = q
      ? options.filter(
          (o) =>
            o.label.toLowerCase().includes(q) ||
            o.group.toLowerCase().includes(q),
        )
      : options;
    return { items: list.slice(0, 60), total: list.length };
  }, [options, query]);

  const rect = trigger.current?.getBoundingClientRect();

  return (
    <>
      <button
        ref={trigger}
        type="button"
        className="slot-swap-trigger"
        aria-label={ariaLabel}
        aria-expanded={open}
        aria-haspopup="dialog"
        disabled={disabled}
        title={currentLabel}
        onClick={() => {
          setQuery("");
          setOpen((v) => !v);
        }}
      >
        <span className="truncate">{currentLabel}</span>
        <ChevronDown size={12} />
      </button>
      {open &&
        createPortal(
          <div
            ref={popup}
            className="binding-popover slot-swap-popover"
            role="dialog"
            aria-modal="true"
            aria-label={`选择 ${ariaLabel}`}
            tabIndex={-1}
            style={{
              position: "fixed",
              left: Math.min(
                window.innerWidth - 282,
                Math.max(10, (rect?.left ?? 0) - 80),
              ),
              top: Math.max(
                10,
                Math.min(window.innerHeight - 320, (rect?.bottom ?? 0) + 5),
              ),
            }}
            onKeyDown={(ev) => {
              if (ev.key === "Escape") {
                ev.stopPropagation();
                setOpen(false);
              }
            }}
          >
            <label className="binding-search">
              <Search size={12} />
              <input
                autoFocus
                aria-label={`搜索 ${ariaLabel}`}
                placeholder={`搜索 ${options.length.toLocaleString()} 个组件变体…`}
                value={query}
                onChange={(ev) => setQuery(ev.target.value)}
              />
              <button
                type="button"
                className="icon-btn icon-btn-sm"
                aria-label="关闭组件选择"
                data-tip="关闭"
                data-tip-kbd="Esc"
                onClick={() => setOpen(false)}
              >
                <X size={12} />
              </button>
            </label>
            {allowReset && (
              <button
                type="button"
                className={`binding-option ${value === "" ? "active" : ""}`}
                onClick={() => {
                  onSelect("");
                  setOpen(false);
                }}
              >
                <span>主组件默认</span>
              </button>
            )}
            {filtered.items.map((opt) => (
              <button
                key={opt.key}
                type="button"
                className={`binding-option ${value === opt.key ? "active" : ""}`}
                title={`${opt.group} / ${opt.label}`}
                onClick={() => {
                  onSelect(opt.key);
                  setOpen(false);
                }}
              >
                <span className="truncate">{opt.label}</span>
                <small className="truncate">{opt.group}</small>
              </button>
            ))}
            {filtered.total > filtered.items.length && (
              <div className="compact-empty">
                已显示前 {filtered.items.length} / {filtered.total}{" "}
                项，输入关键词缩小范围
              </div>
            )}
            {!filtered.items.length && (
              <div className="compact-empty">无匹配组件</div>
            )}
          </div>,
          document.body,
        )}
    </>
  );
}

export function InstanceProperties({
  editor: e,
  selection,
}: {
  editor: EditorController;
  selection: InstanceSelection[];
}) {
  const libs = Object.values(e.doc.libraries ?? {});
  const selectionKey = JSON.stringify(selection.map(({ root }) => root.id));
  const locked = selection.some(({ root }) => isLocked(e.doc, root.id));
  const commit = (ops: Operation[]) => {
    if (ops.length) e.attempt(() => e.apply(ops));
  };
  const selectedComponentKeys = new Set(
    selection.map(({ source }) =>
      componentKey(source.library.id, source.component.id),
    ),
  );
  const choices = libs.flatMap((library) =>
    library.components
      .filter((component) => {
        const key = componentKey(library.id, component.id);
        if (
          component.category === "Figma 插槽内容" &&
          !selectedComponentKeys.has(key)
        )
          return false;
        const template = component.variants[0].nodes.find((n) => !n.parentId);
        return selection.every(
          ({ root }) =>
            template?.type === root.type &&
            template.templateKey === root.templateKey,
        );
      })
      .map((component) => ({ library, component })),
  );
  const componentValue = sameValue(
    selection.map(({ source }) =>
      componentKey(source.library.id, source.component.id),
    ),
  );
  const swapComponent = (nextKey: string) => {
    const item = choices.find(
      ({ library, component }) =>
        componentKey(library.id, component.id) === nextKey,
    );
    if (!item) return;
    commit(
      selection
        .filter(
          ({ source }) =>
            source.library.id !== item.library.id ||
            source.component.id !== item.component.id,
        )
        .map(({ root }) => ({
          type: "swapInstance",
          id: root.id,
          libraryId: item.library.id,
          componentId: item.component.id,
          variantId: item.component.variants[0].id,
        })),
    );
  };
  const targets = selection.map(({ root, source }) => {
    const layers = new Map<string, DesignNode>();
    if (source.component.exposed?.length) {
      for (const id of subtreeIds(e.doc, [root.id])) {
        const n = findLayer(e.doc, id);
        if (n?.templateKey) layers.set(n.templateKey, n);
      }
    }
    return { root, source, layers };
  });
  return (
    <>
      {choices.length > 0 && (
        <label className="instance-property">
          组件
          {choices.length > 40 ? (
            <SlotSwapPicker
              ariaLabel="替换实例组件"
              disabled={locked}
              value={componentValue}
              allowReset={false}
              options={choices.map(({ library, component }) => ({
                key: componentKey(library.id, component.id),
                label: component.name,
                group: library.name,
              }))}
              onSelect={swapComponent}
            />
          ) : (
            <select
              aria-label="替换实例组件"
              disabled={locked}
              value={componentValue ?? "mixed"}
              onChange={(ev) => swapComponent(ev.target.value)}
            >
              {componentValue === undefined && (
                <option disabled value="mixed">
                  Mixed
                </option>
              )}
              {choices.map(({ library, component }) => {
                const key = componentKey(library.id, component.id);
                return (
                  <option key={key} value={key}>
                    {library.name} / {component.name}
                  </option>
                );
              })}
            </select>
          )}
        </label>
      )}
      {(selection[0].source.component.exposed ?? []).map((p) => {
        const bound = targets.flatMap(({ root, source, layers }) => {
          const prop = source.component.exposed?.find(
            (other) => other.name === p.name && other.kind === p.kind,
          );
          const layer = prop && layers.get(prop.target);
          return prop && layer
            ? [{ root, prop, layer: resolveNode(e.doc, layer) }]
            : [];
        });
        if (bound.length !== targets.length) return null;
        const disabled =
          locked || bound.some(({ layer }) => isLocked(e.doc, layer.id));
        const name = "实例属性 " + p.name;
        let field;
        if (p.kind === "swap") {
          const selected = bound.map(({ root, prop }) => {
            const ref = root.instance?.slots?.[prop.target];
            return ref
              ? JSON.stringify([ref.libraryId, ref.componentId, ref.variantId])
              : "";
          });
          const value = sameValue(selected);
          const selectedSet = new Set(selected.filter(Boolean));
          const grouped: {
            groupKey: string;
            groupLabel: string;
            items: SlotOption[];
          }[] = [];
          const flatOptions: SlotOption[] = [];
          for (const lib of libs) {
            for (const c of lib.components) {
              if (
                selection.some(
                  ({ source }) =>
                    source.library.id === lib.id &&
                    source.component.id === c.id,
                )
              )
                continue;
              const isAuxiliarySlot = c.category === "Figma 插槽内容";
              const items: SlotOption[] = [];
              for (const v of c.variants) {
                const key = JSON.stringify([lib.id, c.id, v.id]);
                if (isAuxiliarySlot && !selectedSet.has(key)) continue;
                const type = v.nodes.find((n) => !n.parentId)?.type;
                if (!bound.every(({ layer }) => layer.type === type)) continue;
                const option: SlotOption = {
                  key,
                  label: isAuxiliarySlot
                    ? `自定义插槽 · ${c.name}`
                    : `${c.name} · ${v.name}`,
                  group: `${lib.name} / ${c.name}`,
                };
                items.push(option);
                flatOptions.push(option);
              }
              if (items.length) {
                grouped.push({
                  groupKey: componentKey(lib.id, c.id),
                  groupLabel: `${lib.name} / ${c.name}`,
                  items,
                });
              }
            }
          }
          const applyChoice = (choice: string) => {
            const pick: [string, string, string] | undefined = choice
              ? JSON.parse(choice)
              : undefined;
            commit(
              bound.flatMap(({ root, prop }, i) =>
                selected[i] === choice
                  ? []
                  : [
                      {
                        type: "setInstanceSlot",
                        id: root.id,
                        property: prop.id,
                        value: pick && {
                          libraryId: pick[0],
                          componentId: pick[1],
                          variantId: pick[2],
                        },
                      },
                    ],
              ),
            );
          };
          field =
            flatOptions.length > 40 ? (
              <SlotSwapPicker
                ariaLabel={name}
                disabled={disabled}
                value={value}
                options={flatOptions}
                onSelect={applyChoice}
              />
            ) : (
              <select
                aria-label={name}
                disabled={disabled}
                value={value ?? "mixed"}
                onChange={(ev) => applyChoice(ev.target.value)}
              >
                {value === undefined && (
                  <option disabled value="mixed">
                    Mixed
                  </option>
                )}
                <option value="">主组件默认</option>
                {grouped.map((g) => (
                  <optgroup key={g.groupKey} label={g.groupLabel}>
                    {g.items.map((opt) => (
                      <option key={opt.key} value={opt.key}>
                        {opt.label}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
            );
        } else if (p.kind === "visible") {
          const value = sameValue(bound.map(({ layer }) => !layer.hidden));
          field = (
            <input
              type="checkbox"
              aria-label={name}
              aria-checked={value ?? "mixed"}
              disabled={disabled}
              checked={value ?? false}
              ref={(el) => {
                if (el) el.indeterminate = value === undefined;
              }}
              onChange={(ev) => {
                const hidden = !ev.target.checked;
                commit(
                  bound
                    .filter(({ layer }) => layer.hidden !== hidden)
                    .map(({ layer }) => ({
                      type: "update",
                      id: layer.id,
                      patch: { hidden },
                    })),
                );
              }}
            />
          );
        } else {
          const value = sameValue(bound.map(({ layer }) => layer.text));
          field = (
            <input
              key={
                selectionKey +
                JSON.stringify(bound.map(({ layer }) => layer.text))
              }
              aria-label={name}
              disabled={disabled}
              maxLength={50000}
              defaultValue={value ?? ""}
              placeholder={value === undefined ? "Mixed" : undefined}
              onChange={(ev) => {
                ev.currentTarget.dataset.edited = "true";
              }}
              onBlur={(ev) => {
                if (!ev.currentTarget.dataset.edited) return;
                delete ev.currentTarget.dataset.edited;
                const text = ev.currentTarget.value;
                commit(
                  bound
                    .filter(({ layer }) => layer.text !== text)
                    .map(({ layer }) => ({
                      type: "update",
                      id: layer.id,
                      patch: { text },
                    })),
                );
              }}
              onKeyDown={(ev) => {
                if (ev.key === "Enter" && !ev.nativeEvent.isComposing)
                  ev.currentTarget.blur();
              }}
            />
          );
        }
        return (
          <label className="instance-property" key={p.id}>
            {p.name}
            {field}
          </label>
        );
      })}
      <VariantProperties editor={e} selection={selection} locked={locked} />
    </>
  );
}

const variantLabels: Record<string, string> = {
  Appearance: "外观",
  State: "状态",
  Size: "尺寸",
  Style: "样式",
  Value: "值",
  Material: "材质",
  Selected: "选中项",
  Title: "标题",
  Accessory: "附件",
  Actions: "操作数",
  Page: "页码",
  Type: "类型",
};
function VariantProperties({
  editor: e,
  selection,
  locked,
}: {
  editor: EditorController;
  selection: InstanceSelection[];
  locked: boolean;
}) {
  const first = selection[0].source;
  return (
    <>
      {Object.keys(first.variant.properties).map((axis) => {
        if (
          selection.some(({ source }) => !(axis in source.variant.properties))
        )
          return null;
        // A new axis value must keep each instance's other properties, including mixed ones.
        const alternatives = selection.map(
          ({ source }) =>
            new Map(
              source.component.variants
                .filter((variant) =>
                  Object.entries(source.variant.properties).every(
                    ([key, value]) =>
                      key === axis || variant.properties[key] === value,
                  ),
                )
                .map((variant) => [variant.properties[axis], variant.id]),
            ),
        );
        const values = [
          ...new Set(
            first.component.variants
              .map((v) => v.properties[axis])
              .filter((v) => v !== undefined),
          ),
        ];
        const allValues = selection.map(
          ({ source }) => source.variant.properties[axis],
        );
        const value = sameValue(allValues);
        let mixed = "mixed";
        while (values.includes(mixed)) mixed += "_";
        return (
          <label className="instance-property" key={axis}>
            <span>{variantLabels[axis] ?? axis}</span>
            <select
              aria-label={`实例 ${axis}`}
              disabled={locked}
              value={value ?? mixed}
              onChange={(ev) => {
                const pick = ev.target.value;
                const ops: Operation[] = [];
                selection.forEach(({ root }, i) => {
                  const id = alternatives[i].get(pick);
                  if (id && id !== root.instance?.variantId)
                    ops.push({
                      type: "switchInstance",
                      id: root.id,
                      variantId: id,
                    });
                });
                if (ops.length) e.attempt(() => e.apply(ops));
              }}
            >
              {value === undefined && (
                <option disabled value={mixed}>
                  Mixed
                </option>
              )}
              {values.map((v) => (
                <option key={v} disabled={!alternatives.every((m) => m.has(v))}>
                  {v}
                </option>
              ))}
            </select>
          </label>
        );
      })}
    </>
  );
}
