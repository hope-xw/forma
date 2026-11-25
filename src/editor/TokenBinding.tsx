import { isLocked } from "../domain/tree";
import { displayColor } from "../domain/color-profile";
import { useState, useRef, useEffect } from "react";
import { createPortal } from "react-dom";
import { useModalDialog } from "./useModalDialog";
import { Variable, Unlink, Search, LayoutGrid, Plus } from "lucide-react";
import type { EditorController } from "./useEditor";
import {
  propertyType,
  type VariableProperty,
  type StyleKind,
} from "../domain/design-properties";
import {
  bindVariable,
  detachVariable,
  applyReusableStyle,
  detachReusableStyle,
  captureStyle,
} from "../domain/design-system-actions";
import { effectiveModes, resolveVariable } from "../domain/design-system";
import { emptyDesignSystem } from "../domain/design-system-schema";
export function TokenBinding({
  editor: e,
  property,
  disabled = false,
}: {
  editor: EditorController;
  property: VariableProperty;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false),
    [query, setQuery] = useState("");
  const trigger = useRef<HTMLButtonElement>(null),
    popup = useModalDialog(open, () => setOpen(false));
  const rect = trigger.current?.getBoundingClientRect();
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
  const ids = e.selected.map((n) => n.variableBindings?.[property]);
  const allSame = ids.every((x) => x === ids[0]);
  const id = allSame ? ids[0] : undefined;
  const mixedBound = !allSame && ids.some(Boolean);
  const system = e.doc.designSystem;
  const token = id ? system?.variables[id] : undefined;
  const variables = Object.values(system?.variables ?? {}).filter(
    (v) =>
      v.type === propertyType(property) &&
      (!v.scopes.length || v.scopes.includes(property)) &&
      v.name.toLowerCase().includes(query.toLowerCase()),
  );
  return (
    <div className={`token-binding ${token || mixedBound ? "bound" : ""}`}>
      <button
        ref={trigger}
        className="binding-trigger"
        disabled={disabled}
        aria-label={`绑定变量 ${property}`}
        data-tip={
          token
            ? `${token.name} · ${token.description || "绑定变量"}`
            : mixedBound
              ? "混合变量绑定"
              : "应用变量"
        }
        title={
          token
            ? `${token.name} · ${token.description || "绑定变量"}`
            : mixedBound
              ? "混合变量绑定"
              : "应用变量"
        }
        onClick={() => setOpen(!open)}
      >
        <Variable size={13} />
        {token && <span>{token.name.split("/").at(-1)}</span>}
        {mixedBound && <span>Mixed</span>}
      </button>
      {(token || mixedBound) && (
        <button
          disabled={disabled}
          title="解除变量绑定，保留当前值"
          aria-label={`解除变量 ${property}`}
          data-tip="解除变量绑定，保留当前值"
          onClick={() =>
            e.attempt(() =>
              e.apply(
                e.selected.map((n) => detachVariable(e.doc, n, property)),
              ),
            )
          }
        >
          <Unlink size={11} />
        </button>
      )}
      {open &&
        createPortal(
          <div
            ref={popup}
            aria-modal="true"
            tabIndex={-1}
            style={{
              position: "fixed",
              left: Math.min(
                window.innerWidth - 282,
                Math.max(10, (rect?.left ?? 0) - 245),
              ),
              top: Math.max(
                10,
                Math.min(window.innerHeight - 310, (rect?.bottom ?? 0) + 5),
              ),
            }}
            className="binding-popover"
            role="dialog"
            aria-label={`选择变量 ${property}`}
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
                aria-label={`搜索变量 ${property}`}
                placeholder="搜索变量"
                value={query}
                onChange={(ev) => setQuery(ev.target.value)}
              />
              <button
                className="icon-btn icon-btn-sm"
                aria-label="关闭变量列表"
                data-tip="关闭"
                data-tip-kbd="Esc"
                data-tip-side="top"
                onClick={() => setOpen(false)}
              >
                ×
              </button>
            </label>
            {variables.map((v) => {
              const value = system
                ? resolveVariable(
                    system,
                    v.id,
                    effectiveModes(e.doc, e.selected[0]),
                  )
                : "";
              return (
                <button
                  className="binding-option"
                  key={v.id}
                  title={v.description}
                  onClick={() => {
                    e.attempt(() =>
                      e.apply(
                        e.selected.map((n) => bindVariable(n, property, v.id)),
                      ),
                    );
                    setOpen(false);
                  }}
                >
                  {v.type === "color" ? (
                    <i
                      style={{
                        background: displayColor(
                          String(value),
                          e.doc.colorProfile,
                        ),
                      }}
                    />
                  ) : (
                    <Variable size={12} />
                  )}
                  <span>{v.name}</span>
                  <small>
                    {typeof value === "boolean"
                      ? value
                        ? "True"
                        : "False"
                      : String(value).slice(0, 20)}
                  </small>
                </button>
              );
            })}
            {!variables.length && (
              <div className="compact-empty">无匹配变量</div>
            )}
          </div>,
          document.body,
        )}
    </div>
  );
}
export function StyleBinding({
  editor: e,
  kind,
  placement = "inline",
}: {
  editor: EditorController;
  kind: StyleKind;
  placement?: "inline" | "header" | "body";
}) {
  const [creating, setCreating] = useState(false),
    [open, setOpen] = useState(false),
    [name, setName] = useState("");
  const trigger = useRef<HTMLButtonElement>(null),
    popup = useModalDialog(open, () => {
      setOpen(false);
      setCreating(false);
    });
  useEffect(() => {
    if (!open) return;
    const outside = (ev: PointerEvent) => {
      if (
        !popup.current?.contains(ev.target as Node) &&
        !trigger.current?.contains(ev.target as Node)
      ) {
        setOpen(false);
        setCreating(false);
      }
    };
    window.addEventListener("pointerdown", outside);
    return () => window.removeEventListener("pointerdown", outside);
  }, [open, popup]);
  const locked = e.selected.some((n) => isLocked(e.doc, n.id));
  const source = e.selected[0],
    id = e.selected.every(
      (n) => n.styleBindings?.[kind] === source.styleBindings?.[kind],
    )
      ? source.styleBindings?.[kind]
      : "";
  const system = e.doc.designSystem;
  const styles = Object.values(system?.styles ?? {}).filter(
    (s) =>
      (!s.sourceArchived || s.id === id) &&
      (s.kind === kind ||
        (kind === "stroke" &&
          s.kind === "paint" &&
          !s.properties.gradient &&
          !s.properties.paints?.some((p) => p.gradient))),
  );
  const kindLabel = {
    paint: "颜色样式",
    stroke: "描边样式",
    text: "文字样式",
    grid: "网格样式",
    effect: "效果样式",
  }[kind];
  const defaultName =
    {
      paint: "Color",
      stroke: "Stroke",
      text: "Text",
      grid: "Grid",
      effect: "Effect",
    }[kind] + "/New style";

  if (placement === "header") {
    if (id) return null;
    const rect = trigger.current?.getBoundingClientRect();
    return (
      <>
        <button
          ref={trigger}
          type="button"
          className={`icon-btn icon-btn-sm ${open ? "active" : ""}`}
          disabled={locked}
          title={`应用或新建${kindLabel}`}
          aria-label={`应用或新建${kindLabel}`}
          aria-expanded={open}
          data-tip={kindLabel}
          data-tip-desc={
            styles.length
              ? `选择已有${kindLabel}（${styles.length}）或从当前选区新建`
              : `将当前属性存为可复用的${kindLabel}`
          }
          data-tip-side="left"
          onClick={() => setOpen((v) => !v)}
        >
          <LayoutGrid size={12} />
        </button>
        {open &&
          createPortal(
            <div
              ref={popup}
              aria-modal="true"
              tabIndex={-1}
              style={{
                position: "fixed",
                left: Math.min(
                  window.innerWidth - 252,
                  Math.max(10, (rect?.left ?? 0) - 216),
                ),
                top: Math.max(
                  10,
                  Math.min(window.innerHeight - 280, (rect?.bottom ?? 0) + 5),
                ),
              }}
              className="binding-popover style-picker-popover"
              role="dialog"
              aria-label={`选择${kindLabel}`}
              onKeyDown={(ev) => {
                if (ev.key === "Escape") {
                  ev.stopPropagation();
                  setOpen(false);
                  setCreating(false);
                }
              }}
            >
              <div className="style-picker-head">
                <span>{kindLabel}</span>
                <button
                  type="button"
                  className="icon-btn icon-btn-sm"
                  disabled={locked}
                  title={`从当前选区创建${kindLabel}`}
                  aria-label={`创建${kind}样式`}
                  data-tip={`新建${kindLabel}`}
                  data-tip-side="top"
                  onClick={() => {
                    setName(defaultName);
                    setCreating((v) => !v);
                  }}
                >
                  <Plus size={13} />
                </button>
              </div>
              {creating && (
                <form
                  className="style-create"
                  onSubmit={(ev) => {
                    ev.preventDefault();
                    e.attempt(() => {
                      const style = captureStyle(
                          e.doc,
                          source,
                          kind,
                          name.trim(),
                        ),
                        next = structuredClone(
                          e.doc.designSystem ?? emptyDesignSystem(),
                        );
                      next.styles[style.id] = style;
                      e.apply([
                        { type: "setDesignSystem", system: next },
                        ...e.selected.map((n) =>
                          applyReusableStyle(n, style, kind),
                        ),
                      ]);
                      setCreating(false);
                      setOpen(false);
                    });
                  }}
                >
                  <input
                    autoFocus
                    aria-label="新样式名称"
                    value={name}
                    onChange={(ev) => setName(ev.target.value)}
                    required
                  />
                  <button type="submit" disabled={locked}>
                    创建
                  </button>
                </form>
              )}
              {styles.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  className="binding-option"
                  onClick={() => {
                    e.attempt(() =>
                      e.apply(
                        e.selected.map((n) => applyReusableStyle(n, s, kind)),
                      ),
                    );
                    setOpen(false);
                  }}
                >
                  {s.kind === "paint" && s.properties.fill ? (
                    <i
                      style={{
                        background: displayColor(
                          s.properties.fill,
                          e.doc.colorProfile,
                        ),
                      }}
                    />
                  ) : (
                    <LayoutGrid size={12} />
                  )}
                  <span>{s.name}</span>
                </button>
              ))}
              {!styles.length && !creating && (
                <div className="compact-empty">
                  暂无{kindLabel}，点击右上角 + 创建
                </div>
              )}
            </div>,
            document.body,
          )}
      </>
    );
  }

  if (placement === "body" && !id) {
    return null;
  }

  return (
    <div className="style-binding">
      <select
        disabled={locked}
        aria-label={`${kind}样式`}
        value={id ?? ""}
        onChange={(ev) => {
          const style = system?.styles[ev.target.value];
          e.attempt(() =>
            e.apply(
              e.selected.map((n) =>
                style
                  ? applyReusableStyle(n, style, kind)
                  : detachReusableStyle(e.doc, n, kind),
              ),
            ),
          );
        }}
      >
        <option value="">{kindLabel}</option>
        {styles.map((s) => (
          <option value={s.id} key={s.id}>
            {s.name}
            {s.sourceArchived ? "（源稿已归档）" : ""}
          </option>
        ))}
      </select>
      {id && (
        <button
          disabled={locked}
          title="解除样式"
          aria-label={`解除${kind}样式`}
          data-tip="解除样式"
          onClick={() =>
            e.attempt(() =>
              e.apply(
                e.selected.map((n) => detachReusableStyle(e.doc, n, kind)),
              ),
            )
          }
        >
          <Unlink size={13} />
        </button>
      )}
      {placement === "inline" && (
        <button
          disabled={locked}
          title="从当前选区创建样式"
          aria-label={`创建${kind}样式`}
          data-tip="从当前选区创建样式"
          onClick={() => {
            setName(defaultName);
            setCreating(!creating);
          }}
        >
          +
        </button>
      )}
      {creating && (
        <form
          className="style-create"
          onSubmit={(ev) => {
            ev.preventDefault();
            e.attempt(() => {
              const style = captureStyle(e.doc, source, kind, name.trim()),
                next = structuredClone(
                  e.doc.designSystem ?? emptyDesignSystem(),
                );
              next.styles[style.id] = style;
              e.apply([
                { type: "setDesignSystem", system: next },
                ...e.selected.map((n) => applyReusableStyle(n, style, kind)),
              ]);
              setCreating(false);
            });
          }}
        >
          <input
            autoFocus
            aria-label="新样式名称"
            value={name}
            onChange={(ev) => setName(ev.target.value)}
            required
          />
          <button type="submit" disabled={locked}>
            创建
          </button>
        </form>
      )}
    </div>
  );
}
export function ModeSelectors({
  editor: e,
  document = false,
}: {
  editor: EditorController;
  document?: boolean;
}) {
  const system = e.doc.designSystem;
  const multiCollections = system
    ? Object.values(system.collections).filter((c) => c.modes.length > 1)
    : [];
  if (!system || !multiCollections.length) return null;
  return (
    <section className="mode-section">
      <div className="section-title">{document ? "文件模式" : "变量模式"}</div>
      {multiCollections.map((c) => {
        const allValues = e.selected.map((n) => n.variableModes?.[c.id] ?? "");
        const isMixed =
          !document &&
          allValues.length > 1 &&
          allValues.some((v) => v !== allValues[0]);
        const mode = document
          ? (system.activeModes[c.id] ?? c.defaultModeId)
          : isMixed
            ? "__mixed__"
            : (allValues[0] ?? "");
        return (
          <label className="mode-row" key={c.id}>
            <span>{c.name}</span>
            <select
              disabled={
                !document && e.selected.some((n) => isLocked(e.doc, n.id))
              }
              aria-label={`模式 ${c.name}`}
              value={mode}
              onChange={(ev) =>
                e.attempt(() => {
                  if (document) {
                    const next = structuredClone(system);
                    next.activeModes[c.id] = ev.target.value;
                    e.apply([{ type: "setDesignSystem", system: next }]);
                  } else
                    e.apply(
                      e.selected.map((node) => {
                        const modes = { ...node.variableModes };
                        if (ev.target.value) modes[c.id] = ev.target.value;
                        else delete modes[c.id];
                        return {
                          type: "update",
                          id: node.id,
                          patch: { variableModes: modes },
                        };
                      }),
                    );
                })
              }
            >
              {isMixed && (
                <option value="__mixed__" hidden>
                  Mixed
                </option>
              )}
              {!document && <option value="">继承</option>}
              {c.modes.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          </label>
        );
      })}
    </section>
  );
}
