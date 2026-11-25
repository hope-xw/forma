import { editableRules, saveRules } from "../domain/layout-breakpoints";
import { LayoutBreakpoints } from "./LayoutBreakpoints";
import { useMemo, useRef, useState } from "react";
import {
  X,
  Plus,
  Search,
  Variable,
  Trash2,
  Download,
  Upload,
  Undo2,
  Redo2,
  Paintbrush,
  Type,
  Layers,
  LayoutGrid,
} from "lucide-react";
import type { EditorController } from "./useEditor";
import { useModalDialog } from "./useModalDialog";
import {
  emptyDesignSystem,
  type DesignSystem,
  type DesignVariable,
  type VariableValue,
} from "../domain/design-system-schema";
import {
  resolveVariable,
  parseDesignSystem,
  mergeDesignSystem,
} from "../domain/design-system";
import {
  variableProperties,
  propertyLabels,
  propertyType,
  styleGroups,
} from "../domain/design-properties";
import {
  captureStyle,
  applyReusableStyle,
  migrateLegacyTokens,
} from "../domain/design-system-actions";
import { nativeDesignSystem } from "../design-system/tokens";
import { download } from "../infrastructure/storage";
import { PaintStack } from "./PaintStack";
import { GradientControls } from "./GradientEditor";
import { isLocked } from "../domain/tree";
import { ColorField } from "./ColorField";
const colorAlpha = {
  fill: "fillOpacity",
  stroke: "strokeOpacity",
  color: "colorOpacity",
} as const;
const styleOptions: Record<string, Record<string, string>> = {
  strokeAlign: { inside: "内侧", center: "居中", outside: "外侧" },
  strokeStyle: {
    solid: "实线",
    dashed: "虚线",
    dotted: "点线",
    double: "双线",
  },
  fontStyle: { normal: "常规", italic: "斜体" },
  textDecoration: { none: "无", underline: "下划线", "line-through": "删除线" },
  textTransform: {
    none: "原文",
    uppercase: "大写",
    lowercase: "小写",
    capitalize: "首字母大写",
  },
  verticalAlign: { top: "顶部", middle: "居中", bottom: "底部" },
  leadingTrim: { cap: "大写字高" },
};
const textStyleInputs = new Set([
  "fontFamily",
  "textAlign",
  "gridTracks",
  "gridRowTracks",
  "fontVariationSettings",
  "fontFeatureSettings",
  "strokeDash",
]);
function CommitInput({
  value,
  label,
  commit,
  type = "text",
}: {
  value: string | number;
  label: string;
  commit(value: string): void;
  type?: string;
}) {
  return (
    <input
      key={String(value)}
      aria-label={label}
      type={type}
      defaultValue={value}
      onBlur={(e) => {
        if (e.target.value !== String(value)) commit(e.target.value);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
        if (e.key === "Escape") {
          e.currentTarget.value = String(value);
          e.currentTarget.blur();
        }
      }}
    />
  );
}
const names = {
  color: "颜色",
  number: "数值",
  string: "字符串",
  boolean: "布尔",
};
export function DesignSystemDialog({
  editor: e,
  initialView = "variables",
  initialStyleId = "",
  close,
}: {
  editor: EditorController;
  initialView?: "variables" | "styles";
  initialStyleId?: string;
  close(): void;
}) {
  const modal = useModalDialog(true, close, false),
    file = useRef<HTMLInputElement>(null);
  const [view, setView] = useState<"variables" | "styles">(initialView),
    [collectionId, setCollectionId] = useState(""),
    [groupFilter, setGroupFilter] = useState(""),
    [selected, setSelected] = useState(initialStyleId),
    [query, setQuery] = useState(""),
    [type, setType] = useState<DesignVariable["type"]>("color"),
    [newStyleKind, setNewStyleKind] =
      useState<keyof typeof styleGroups>("paint"),
    [dragOffset, setDragOffset] = useState({ x: 0, y: 0 }),
    [error, setError] = useState("");
  const system = e.doc.designSystem ?? emptyDesignSystem(),
    collections = Object.values(system.collections),
    collection = system.collections[collectionId] ?? collections[0];
  const act = (work: () => void) => {
    try {
      work();
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "操作失败");
    }
  };
  const mutate = (work: (system: DesignSystem) => void) =>
    act(() => {
      const next = structuredClone(system);
      work(next);
      e.apply([{ type: "setDesignSystem", system: next }]);
    });
  const collectionVariables = useMemo(
    () =>
      Object.values(system.variables).filter(
        (v) => v.collectionId === collection?.id,
      ),
    [system.variables, collection?.id],
  );
  const groups = useMemo(() => {
    const counts = new Map<string, number>();
    for (const v of collectionVariables) {
      const slash = v.name.indexOf("/");
      if (slash > 0) {
        const prefix = v.name.slice(0, slash);
        counts.set(prefix, (counts.get(prefix) ?? 0) + 1);
      }
    }
    return [...counts.entries()];
  }, [collectionVariables]);
  const variables = collectionVariables.filter(
    (v) =>
      (!groupFilter || v.name.startsWith(groupFilter + "/")) &&
      v.name.toLowerCase().includes(query.toLowerCase()),
  );
  const startHeaderDrag = (ev: React.PointerEvent<HTMLDivElement>) => {
    if ((ev.target as HTMLElement).closest("button,input,select")) return;
    ev.preventDefault();
    const box = modal.current!.getBoundingClientRect();
    const startX = ev.clientX,
      startY = ev.clientY,
      baseX = box.left + (box.width - window.innerWidth) / 2,
      baseY = box.top + (box.height - window.innerHeight) / 2;
    const onMove = (moveEv: PointerEvent) => {
      setDragOffset({
        x: baseX + moveEv.clientX - startX,
        y: baseY + moveEv.clientY - startY,
      });
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  };
  const addStyle = () => {
    const id = crypto.randomUUID();
    const existingCount = Object.values(system.styles).filter(
      (s) => s.kind === newStyleKind,
    ).length;
    const labelMap = {
      paint: "颜色样式",
      stroke: "描边样式",
      text: "文字样式",
      effect: "效果样式",
      grid: "网格样式",
    } as const;
    const styleName = `${labelMap[newStyleKind]} ${existingCount + 1}`;
    mutate((s) => {
      if (e.selected.length === 1) {
        const captured = captureStyle(
          e.doc,
          e.selected[0],
          newStyleKind,
          styleName,
        );
        s.styles[id] = { ...captured, id };
      } else {
        const defaults = {
          stroke: { stroke: "#0d99ff", strokeOpacity: 1, strokeWidth: 1 },
          paint: { fill: "#0d99ff", fillOpacity: 1 },
          text: {
            fontFamily: "Inter, -apple-system, sans-serif",
            fontSize: 16,
            fontWeight: 500,
            lineHeight: 24,
            letterSpacing: 0,
          },
          effect: {
            shadows: [
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
          },
          grid: { layout: "grid" as const, columns: 4, gap: 16, rowGap: 16 },
        }[newStyleKind];
        s.styles[id] = {
          id,
          name: styleName,
          kind: newStyleKind,
          description: "",
          properties: defaults,
          bindings: {},
        };
      }
    });
    setSelected(id);
  };
  const variable = system.variables[selected],
    styles = Object.values(system.styles).filter((s) =>
      s.name.toLowerCase().includes(query.toLowerCase()),
    ),
    style = system.styles[selected];
  const updateValue = (v: DesignVariable, mode: string, value: VariableValue) =>
    mutate((s) => {
      s.variables[v.id].values[mode] = value;
    });
  const addCollection = () => {
    const id = crypto.randomUUID(),
      mode = crypto.randomUUID();
    mutate((s) => {
      s.collections[id] = {
        id,
        name: `Collection ${collections.length + 1}`,
        defaultModeId: mode,
        modes: [{ id: mode, name: "Default" }],
      };
    });
    setCollectionId(id);
    setSelected("");
  };
  const addVariable = () => {
    if (!collection) return;
    const id = crypto.randomUUID();
    let i = 1;
    while (
      Object.values(system.variables).some(
        (v) =>
          v.collectionId === collection.id &&
          v.name === `${names[type]}/New ${i}`,
      )
    )
      i++;
    mutate((s) => {
      s.variables[id] = {
        id,
        collectionId: collection.id,
        name: `${names[type]}/New ${i}`,
        type,
        description: "",
        codeSyntax: "",
        scopes: [],
        values: Object.fromEntries(
          collection.modes.map((m) => [
            m.id,
            type === "color"
              ? "#635bff"
              : type === "number"
                ? 16
                : type === "boolean"
                  ? true
                  : "Text",
          ]),
        ),
      };
    });
    setSelected(id);
  };
  return (
    <div
      className="modal-backdrop ds-floating-backdrop"
      style={{
        display: "grid",
        placeItems: "center",
        background: "transparent",
      }}
    >
      <div
        className="ds-dialog"
        ref={modal}
        role="dialog"
        tabIndex={-1}
        aria-modal="false"
        aria-label="变量与样式"
        style={
          dragOffset.x || dragOffset.y
            ? {
                transform: `translate(clamp(min(0px, 50% - 50vw + 6px), ${dragOffset.x}px, max(0px, 50vw - 50% - 6px)), clamp(min(0px, 50% - 50dvh + 6px), ${dragOffset.y}px, max(0px, 50dvh - 50% - 6px)))`,
              }
            : undefined
        }
        onKeyDown={(ev) => {
          if (
            (ev.target as Element)?.closest?.("input,textarea,select") ||
            !(ev.metaKey || ev.ctrlKey)
          )
            return;
          const k = ev.key.toLowerCase();
          if (k === "z") {
            ev.preventDefault();
            if (ev.shiftKey) e.redo();
            else e.undo();
          } else if (k === "y") {
            ev.preventDefault();
            e.redo();
          }
        }}
      >
        <div className="ds-header" onPointerDown={startHeaderDrag}>
          <strong>变量与样式</strong>
          <div className="ds-tabs">
            <button
              className={view === "variables" ? "active" : ""}
              onClick={() => {
                setView("variables");
                setSelected("");
              }}
            >
              变量
            </button>
            <button
              className={view === "styles" ? "active" : ""}
              onClick={() => {
                setView("styles");
                setSelected("");
              }}
            >
              样式
            </button>
          </div>
          <div className="ds-header-actions">
            <button
              className="icon-btn icon-btn-sm"
              title="撤销"
              aria-label="撤销设计系统修改"
              data-tip="撤销"
              data-tip-kbd="⌘Z"
              data-tip-desc="撤销上一次变量或样式修改"
              data-tip-side="bottom"
              disabled={!e.canUndo}
              onClick={e.undo}
            >
              <Undo2 size={15} />
            </button>
            <button
              className="icon-btn icon-btn-sm"
              title="重做"
              aria-label="重做设计系统修改"
              data-tip="重做"
              data-tip-kbd="⇧⌘Z"
              data-tip-desc="恢复已撤销的变量或样式修改"
              data-tip-side="bottom"
              disabled={!e.canRedo}
              onClick={e.redo}
            >
              <Redo2 size={15} />
            </button>
            <button
              className="icon-btn icon-btn-sm"
              title="导入变量与样式"
              aria-label="导入设计系统"
              data-tip="导入变量与样式"
              data-tip-desc="从本地 JSON 合并设计变量与样式集合"
              data-tip-side="bottom"
              onClick={() => file.current?.click()}
            >
              <Upload size={15} />
            </button>
            <button
              className="icon-btn icon-btn-sm"
              title="导出变量与样式"
              aria-label="导出设计系统"
              data-tip="导出变量与样式"
              data-tip-desc="下载当前设计系统的 JSON 文件以便团队共享"
              data-tip-side="bottom"
              onClick={() =>
                download(
                  "forma-design-system.json",
                  JSON.stringify(
                    { format: "forma/design-system", version: 1, system },
                    null,
                    2,
                  ),
                )
              }
            >
              <Download size={15} />
            </button>
            <button
              className="icon-btn icon-btn-sm"
              aria-label="关闭变量与样式"
              data-tip="关闭变量与样式"
              data-tip-kbd="Esc"
              data-tip-side="bottom"
              onClick={close}
            >
              <X size={17} />
            </button>
          </div>
        </div>
        <div className="ds-body">
          <aside className="ds-sidebar">
            <div className="section-title">
              {view === "variables" ? "集合" : "样式分类"}
              {view === "variables" && (
                <button
                  className="icon-btn icon-btn-sm"
                  title="新建集合"
                  aria-label="新建集合"
                  data-tip="新建变量集合"
                  data-tip-desc="新增一组可支持多主题模式的变量集合"
                  data-tip-side="bottom"
                  onClick={addCollection}
                >
                  <Plus size={14} />
                </button>
              )}
            </div>
            {view === "variables" ? (
              <>
                {collections.map((c) => {
                  const isActive = collection?.id === c.id;
                  return (
                    <div key={c.id}>
                      <button
                        className={`collection-item ${isActive && !groupFilter ? "active" : ""}`}
                        onClick={() => {
                          setCollectionId(c.id);
                          setGroupFilter("");
                          setSelected("");
                        }}
                      >
                        <Variable size={14} />
                        <span>{c.name}</span>
                        <small>
                          {
                            Object.values(system.variables).filter(
                              (v) => v.collectionId === c.id,
                            ).length
                          }
                        </small>
                      </button>
                      {isActive && groups.length > 0 && (
                        <div>
                          <button
                            type="button"
                            className={`ds-group-item ${groupFilter === "" ? "active" : ""}`}
                            onClick={() => setGroupFilter("")}
                          >
                            <span>全部变量</span>
                            <small>{collectionVariables.length}</small>
                          </button>
                          {groups.map(([groupName, count]) => (
                            <button
                              type="button"
                              key={groupName}
                              className={`ds-group-item ${groupFilter === groupName ? "active" : ""}`}
                              onClick={() => setGroupFilter(groupName)}
                            >
                              <span className="truncate">{groupName}</span>
                              <small>{count}</small>
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </>
            ) : (
              styles.map((s) => (
                <button
                  className={`collection-item ${selected === s.id ? "active" : ""}`}
                  key={s.id}
                  onClick={() => setSelected(s.id)}
                >
                  {s.kind === "paint" ? (
                    <Paintbrush size={14} />
                  ) : s.kind === "text" ? (
                    <Type size={14} />
                  ) : s.kind === "grid" ? (
                    <LayoutGrid size={14} />
                  ) : (
                    <Layers size={14} />
                  )}
                  <span>
                    {s.name}
                    {s.sourceArchived ? "（源稿已归档）" : ""}
                  </span>
                </button>
              ))
            )}
            <div className="ds-library-actions">
              <button
                onClick={() =>
                  mutate((next) => {
                    const native = nativeDesignSystem();
                    for (const kind of [
                      "collections",
                      "variables",
                      "styles",
                    ] as const)
                      for (const [id, value] of Object.entries(native[kind]))
                        if (!next[kind][id])
                          Object.assign(next[kind], { [id]: value });
                  })
                }
              >
                添加 Forma 基础体系
              </button>
              {Object.values(e.doc.tokens).length > 0 && (
                <button
                  title="迁移原有颜色变量及图层绑定"
                  onClick={() => act(() => e.apply(migrateLegacyTokens(e.doc)))}
                >
                  迁移旧颜色变量
                </button>
              )}
            </div>
          </aside>
          <div className="ds-main">
            <div className="ds-toolbar">
              <label className="search-field">
                <Search size={14} />
                <input
                  aria-label="搜索变量或样式"
                  value={query}
                  placeholder="搜索"
                  onChange={(ev) => setQuery(ev.target.value)}
                />
              </label>
              {view === "variables" && (
                <>
                  <select
                    aria-label="新变量类型"
                    value={type}
                    onChange={(ev) => setType(ev.target.value as typeof type)}
                  >
                    {Object.entries(names).map(([k, v]) => (
                      <option value={k} key={k}>
                        {v}
                      </option>
                    ))}
                  </select>
                  <button disabled={!collection} onClick={addVariable}>
                    <Plus size={14} />
                    创建变量
                  </button>
                </>
              )}
              {view === "styles" && (
                <>
                  <select
                    aria-label="新建样式类型"
                    value={newStyleKind}
                    onChange={(ev) =>
                      setNewStyleKind(ev.target.value as typeof newStyleKind)
                    }
                  >
                    <option value="paint">颜色样式</option>
                    <option value="stroke">描边样式</option>
                    <option value="text">文字样式</option>
                    <option value="effect">效果样式</option>
                    <option value="grid">网格样式</option>
                  </select>
                  <button type="button" onClick={addStyle}>
                    <Plus size={14} />
                    新建样式
                  </button>
                  <button
                    disabled={e.selected.length !== 1 || !style}
                    title="将当前选区的属性更新到此样式"
                    onClick={() =>
                      mutate((s) => {
                        if (style && e.selected[0]) {
                          const captured = captureStyle(
                            e.doc,
                            e.selected[0],
                            style.kind,
                            style.name,
                          );
                          s.styles[style.id] = {
                            ...captured,
                            id: style.id,
                            description: style.description,
                            sourceArchived: style.sourceArchived,
                          };
                        }
                      })
                    }
                  >
                    从选区更新样式
                  </button>
                </>
              )}
            </div>
            {error && (
              <div role="alert" className="ds-error">
                {error}
                <button
                  aria-label="清除设计系统错误"
                  data-tip="清除设计系统错误"
                  onClick={() => setError("")}
                >
                  ×
                </button>
              </div>
            )}
            {view === "variables" && collection && (
              <>
                <div className="collection-heading">
                  <CommitInput
                    label="集合名称"
                    value={collection.name}
                    commit={(name) =>
                      mutate((s) => {
                        s.collections[collection.id].name = name;
                      })
                    }
                  />
                  <button
                    title="删除集合（引用存在时阻止删除）"
                    aria-label="删除集合"
                    data-tip="删除集合（引用存在时阻止删除）"
                    onClick={() =>
                      mutate((s) => {
                        delete s.collections[collection.id];
                        delete s.activeModes[collection.id];
                        for (const v of Object.values(s.variables))
                          if (v.collectionId === collection.id)
                            delete s.variables[v.id];
                      })
                    }
                  >
                    <Trash2 size={13} />
                  </button>
                  <button
                    onClick={() => {
                      const id = crypto.randomUUID();
                      mutate((s) => {
                        const c = s.collections[collection.id];
                        c.modes.push({
                          id,
                          name: `Mode ${c.modes.length + 1}`,
                        });
                        for (const v of Object.values(s.variables))
                          if (v.collectionId === c.id)
                            v.values[id] = structuredClone(
                              v.values[c.defaultModeId],
                            );
                      });
                    }}
                  >
                    <Plus size={13} />
                    添加模式
                  </button>
                </div>
                <div className="variable-table-wrap">
                  <table className="variable-table">
                    <thead>
                      <tr>
                        <th>名称</th>
                        {collection.modes.map((m) => (
                          <th key={m.id}>
                            <div className="mode-heading">
                              <CommitInput
                                label={`模式名称 ${m.name}`}
                                value={m.name}
                                commit={(name) =>
                                  mutate((s) => {
                                    s.collections[collection.id].modes.find(
                                      (x) => x.id === m.id,
                                    )!.name = name;
                                  })
                                }
                              />
                              <button
                                title={
                                  m.id === collection.defaultModeId
                                    ? "默认模式"
                                    : "设为默认模式"
                                }
                                aria-label={`设为默认 ${m.name}`}
                                data-tip={
                                  m.id === collection.defaultModeId
                                    ? "默认模式"
                                    : "设为默认模式"
                                }
                                className={
                                  m.id === collection.defaultModeId
                                    ? "active"
                                    : ""
                                }
                                onClick={() =>
                                  mutate((s) => {
                                    s.collections[collection.id].defaultModeId =
                                      m.id;
                                  })
                                }
                              >
                                ◇
                              </button>
                              <button
                                title="删除模式"
                                aria-label={`删除模式 ${m.name}`}
                                data-tip="删除模式"
                                disabled={m.id === collection.defaultModeId}
                                onClick={() =>
                                  mutate((s) => {
                                    s.collections[collection.id].modes =
                                      s.collections[collection.id].modes.filter(
                                        (x) => x.id !== m.id,
                                      );
                                    if (s.activeModes[collection.id] === m.id)
                                      delete s.activeModes[collection.id];
                                    for (const v of Object.values(s.variables))
                                      if (v.collectionId === collection.id)
                                        delete v.values[m.id];
                                  })
                                }
                              >
                                ×
                              </button>
                            </div>
                          </th>
                        ))}
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {variables.map((v) => (
                        <tr
                          key={v.id}
                          className={selected === v.id ? "selected" : ""}
                          onClick={() => setSelected(v.id)}
                        >
                          <td>
                            <span
                              className="variable-type"
                              title={names[v.type]}
                            >
                              {v.type === "color"
                                ? "◉"
                                : v.type === "number"
                                  ? "#"
                                  : v.type === "boolean"
                                    ? "◑"
                                    : "T"}
                            </span>
                            <CommitInput
                              label={`变量名称 ${v.name}`}
                              value={v.name}
                              commit={(name) =>
                                mutate((s) => {
                                  s.variables[v.id].name = name;
                                })
                              }
                            />
                          </td>
                          {collection.modes.map((m) => {
                            const value = v.values[m.id],
                              alias = typeof value === "object";
                            return (
                              <td key={m.id}>
                                <div className="variable-value">
                                  {alias ? (
                                    <span
                                      className="alias-chip"
                                      title={String(
                                        resolveVariable(system, v.id, {
                                          ...system.activeModes,
                                          [collection.id]: m.id,
                                        }),
                                      )}
                                    >
                                      ↗ {system.variables[value.alias]?.name}
                                    </span>
                                  ) : v.type === "color" ? (
                                    <ColorField
                                      label={`${v.name} ${m.name}`}
                                      allowAlpha={false}
                                      color={String(value)}
                                      onChange={(color) =>
                                        updateValue(v, m.id, color)
                                      }
                                    />
                                  ) : v.type === "boolean" ? (
                                    <select
                                      aria-label={`${v.name} ${m.name}`}
                                      value={String(value)}
                                      onChange={(ev) =>
                                        updateValue(
                                          v,
                                          m.id,
                                          ev.target.value === "true",
                                        )
                                      }
                                    >
                                      <option value="true">True</option>
                                      <option value="false">False</option>
                                    </select>
                                  ) : (
                                    <CommitInput
                                      label={`${v.name} ${m.name}`}
                                      value={String(value)}
                                      type={
                                        v.type === "number" ? "number" : "text"
                                      }
                                      commit={(text) =>
                                        updateValue(
                                          v,
                                          m.id,
                                          v.type === "number"
                                            ? Number(text)
                                            : text,
                                        )
                                      }
                                    />
                                  )}
                                  <span
                                    className="alias-select-wrap"
                                    data-aliased={alias ? "true" : undefined}
                                  >
                                    <select
                                      className="alias-select"
                                      title={
                                        alias ? "更改或解除引用" : "引用变量"
                                      }
                                      aria-label={`引用 ${v.name} ${m.name}`}
                                      value={alias ? value.alias : ""}
                                      onChange={(ev) =>
                                        updateValue(
                                          v,
                                          m.id,
                                          ev.target.value
                                            ? { alias: ev.target.value }
                                            : resolveVariable(system, v.id, {
                                                ...system.activeModes,
                                                [collection.id]: m.id,
                                              }),
                                        )
                                      }
                                    >
                                      <option value="">
                                        {alias ? "解除引用" : "引用变量…"}
                                      </option>
                                      {Object.values(system.variables)
                                        .filter(
                                          (x) =>
                                            x.id !== v.id && x.type === v.type,
                                        )
                                        .map((x) => (
                                          <option value={x.id} key={x.id}>
                                            {system.collections[x.collectionId]
                                              ?.name ?? "集合"}{" "}
                                            / {x.name}
                                          </option>
                                        ))}
                                    </select>
                                    <span
                                      className="alias-select-glyph"
                                      aria-hidden="true"
                                    >
                                      ↗
                                    </span>
                                  </span>
                                </div>
                              </td>
                            );
                          })}
                          <td>
                            <button
                              title="删除变量"
                              aria-label={`删除变量 ${v.name}`}
                              data-tip="删除变量"
                              onClick={() =>
                                mutate((s) => {
                                  delete s.variables[v.id];
                                })
                              }
                            >
                              <Trash2 size={12} />
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
            {view === "variables" && !collection && (
              <div className="compact-empty">
                <button onClick={addCollection}>
                  <Plus size={14} />
                  创建集合
                </button>
              </div>
            )}
            {view === "styles" &&
              (style ? (
                <div className="style-detail">
                  <div className="style-detail-header">
                    <CommitInput
                      label="样式名称"
                      value={style.name}
                      commit={(name) =>
                        mutate((s) => {
                          s.styles[style.id].name = name;
                        })
                      }
                    />
                    <button
                      title="应用到选区"
                      disabled={
                        !e.selected.length ||
                        e.selected.some((n) => isLocked(e.doc, n.id))
                      }
                      onClick={() =>
                        act(() =>
                          e.apply(
                            e.selected.map((n) => applyReusableStyle(n, style)),
                          ),
                        )
                      }
                    >
                      应用样式
                    </button>
                    <button
                      title="删除样式（仍被引用时阻止）"
                      aria-label="删除样式"
                      data-tip="删除样式（仍被引用时阻止）"
                      onClick={() =>
                        mutate((s) => {
                          delete s.styles[style.id];
                        })
                      }
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                  {styleGroups[style.kind]
                    .filter(
                      (key) =>
                        ![
                          "shadows",
                          "sketchGlass",
                          "figmaGlass",
                          "gradient",
                          "paints",
                          "strokePaints",
                          "gridBreakpoint",
                          "narrowColumns",
                          "narrowGap",
                        ].includes(key),
                    )
                    .map((key) => {
                      const value =
                        style.properties[key as keyof typeof style.properties];
                      if (key === "strokeSides")
                        return (
                          <div className="property-grid" key={key}>
                            {(["top", "right", "bottom", "left"] as const).map(
                              (side) => {
                                const label = {
                                  top: "上边宽度",
                                  right: "右边宽度",
                                  bottom: "下边宽度",
                                  left: "左边宽度",
                                }[side];
                                return (
                                  <label key={side}>
                                    {label}
                                    <CommitInput
                                      label={label}
                                      type="number"
                                      value={
                                        style.properties.strokeSides?.[side] ??
                                        ""
                                      }
                                      commit={(raw) =>
                                        mutate((s) => {
                                          const properties =
                                            s.styles[style.id].properties;
                                          const sides = {
                                            ...properties.strokeSides,
                                          };
                                          if (raw.trim())
                                            sides[side] = Number(raw);
                                          else delete sides[side];
                                          properties.strokeSides = Object.keys(
                                            sides,
                                          ).length
                                            ? sides
                                            : undefined;
                                        })
                                      }
                                    />
                                  </label>
                                );
                              },
                            )}
                          </div>
                        );
                      if (key === "layoutBreakpoints")
                        return (
                          <LayoutBreakpoints
                            key={key}
                            grid
                            rules={editableRules({
                              ...style.properties,
                              layout: "grid",
                            })}
                            commit={(rules) =>
                              mutate((s) => {
                                Object.assign(
                                  s.styles[style.id].properties,
                                  saveRules(rules),
                                );
                              })
                            }
                          />
                        );
                      return (
                        <label className="style-property" key={key}>
                          <span>{propertyLabels[key] ?? key}</span>
                          {key === "fill" ||
                          key === "stroke" ||
                          key === "color" ? (
                            <ColorField
                              label={
                                {
                                  fill: "样式填充",
                                  stroke: "样式描边",
                                  color: "样式文字颜色",
                                }[key]
                              }
                              color={String(value ?? "#ffffff")}
                              alpha={style.properties[colorAlpha[key]] ?? 1}
                              onChange={(fill, alpha, channel) =>
                                mutate((s) => {
                                  const def = s.styles[style.id];
                                  if (channel !== "alpha") {
                                    def.properties[key] = fill;
                                    delete def.bindings[key];
                                  }
                                  if (channel !== "color") {
                                    const opacityKey = colorAlpha[key];
                                    def.properties[opacityKey] = alpha;
                                    delete def.bindings[opacityKey];
                                  }
                                })
                              }
                            />
                          ) : key === "strokeVisible" ? (
                            <input
                              type="checkbox"
                              aria-label="样式描边可见"
                              checked={value !== false}
                              onChange={(ev) =>
                                mutate((s) => {
                                  s.styles[style.id].properties.strokeVisible =
                                    ev.target.checked;
                                })
                              }
                            />
                          ) : styleOptions[key] ? (
                            <select
                              aria-label={`样式属性 ${key}`}
                              value={typeof value === "string" ? value : ""}
                              onChange={(ev) =>
                                mutate((s) => {
                                  Object.assign(s.styles[style.id].properties, {
                                    [key]: ev.target.value || undefined,
                                  });
                                })
                              }
                            >
                              <option value="">默认</option>
                              {Object.entries(styleOptions[key]).map(
                                ([v, label]) => (
                                  <option key={v} value={v}>
                                    {label}
                                  </option>
                                ),
                              )}
                            </select>
                          ) : (
                            <CommitInput
                              label={`样式属性 ${key}`}
                              value={
                                typeof value === "string" ||
                                typeof value === "number"
                                  ? value
                                  : ""
                              }
                              type={
                                textStyleInputs.has(key) ? "text" : "number"
                              }
                              commit={(text) =>
                                mutate((s) => {
                                  delete s.styles[style.id].bindings[
                                    key as keyof typeof style.bindings
                                  ];
                                  Object.assign(s.styles[style.id].properties, {
                                    [key]: textStyleInputs.has(key)
                                      ? text.trim() || undefined
                                      : text.trim()
                                        ? Number(text)
                                        : undefined,
                                  });
                                })
                              }
                            />
                          )}
                          {variableProperties.some((k) => k === key) && (
                            <select
                              aria-label={`样式变量 ${key}`}
                              value={
                                style.bindings[
                                  key as keyof typeof style.bindings
                                ] ?? ""
                              }
                              onChange={(ev) =>
                                mutate((s) => {
                                  if (ev.target.value)
                                    Object.assign(s.styles[style.id].bindings, {
                                      [key]: ev.target.value,
                                    });
                                  else
                                    delete s.styles[style.id].bindings[
                                      key as keyof typeof style.bindings
                                    ];
                                })
                              }
                            >
                              <option value="">未绑定</option>
                              {Object.values(system.variables)
                                .filter(
                                  (v) =>
                                    v.type === propertyType(key) &&
                                    (!v.scopes.length ||
                                      v.scopes.includes(
                                        key as (typeof variableProperties)[number],
                                      )),
                                )
                                .map((v) => (
                                  <option value={v.id} key={v.id}>
                                    {v.name}
                                  </option>
                                ))}
                            </select>
                          )}
                        </label>
                      );
                    })}
                  {style.kind === "paint" && (
                    <>
                      <GradientControls
                        color={style.properties.fill ?? "#ffffff"}
                        system={system}
                        gradient={style.properties.gradient}
                        update={(gradient) =>
                          mutate((s) => {
                            s.styles[style.id].properties.gradient = gradient;
                          })
                        }
                      />
                      <PaintStack
                        layers={style.properties.paints}
                        system={system}
                        update={(paints) =>
                          mutate((s) => {
                            s.styles[style.id].properties.paints = paints;
                          })
                        }
                      />
                    </>
                  )}
                  {style.kind === "stroke" && (
                    <PaintStack
                      kind="stroke"
                      system={system}
                      layers={style.properties.strokePaints}
                      update={(strokePaints) =>
                        mutate((s) => {
                          const properties = s.styles[style.id].properties;
                          const base = properties.stroke;
                          properties.strokePaints =
                            !properties.strokePaints?.length &&
                            base &&
                            strokePaints.length
                              ? [
                                  ...strokePaints,
                                  {
                                    id: crypto.randomUUID(),
                                    color: base,
                                    opacity: properties.strokeOpacity ?? 1,
                                    visible: true,
                                    blendMode: properties.strokeBlendMode,
                                  },
                                ]
                              : strokePaints;
                        })
                      }
                    />
                  )}
                  {style.kind === "effect" && (
                    <div className="section-title">
                      阴影
                      <button
                        className="icon-btn icon-btn-sm"
                        aria-label="添加样式阴影"
                        data-tip="添加阴影"
                        disabled={(style.properties.shadows?.length ?? 0) >= 32}
                        onClick={() =>
                          mutate((s) => {
                            (s.styles[style.id].properties.shadows ??= []).push(
                              {
                                x: 0,
                                y: 4,
                                blur: 12,
                                spread: 0,
                                color: "#000000",
                                opacity: 0.16,
                                inset: false,
                                visible: true,
                              },
                            );
                          })
                        }
                      >
                        <Plus size={14} />
                      </button>
                    </div>
                  )}
                  {style.properties.shadows?.map((shadow, index) => (
                    <div className="style-shadow" key={index}>
                      <div className="section-title">
                        <strong>阴影 {index + 1}</strong>
                        <button
                          className="icon-btn icon-btn-sm"
                          aria-label={`删除样式阴影 ${index + 1}`}
                          data-tip="删除阴影"
                          onClick={() =>
                            mutate((s) => {
                              s.styles[style.id].properties.shadows!.splice(
                                index,
                                1,
                              );
                            })
                          }
                        >
                          <Trash2 size={13} />
                        </button>
                      </div>
                      {(["x", "y", "blur", "spread"] as const).map((key) => (
                        <label key={key}>
                          {
                            { x: "X", y: "Y", blur: "模糊", spread: "扩散" }[
                              key
                            ]
                          }
                          <CommitInput
                            label={`样式阴影 ${index + 1} ${key}`}
                            type="number"
                            value={shadow[key]}
                            commit={(value) =>
                              mutate((s) => {
                                s.styles[style.id].properties.shadows![index][
                                  key
                                ] = Number(value);
                              })
                            }
                          />
                        </label>
                      ))}
                      <ColorField
                        label={`样式阴影 ${index + 1}`}
                        color={shadow.color}
                        alpha={shadow.opacity}
                        onChange={(color, opacity) =>
                          mutate((s) => {
                            Object.assign(
                              s.styles[style.id].properties.shadows![index],
                              { color, opacity },
                            );
                          })
                        }
                      />
                    </div>
                  ))}
                  <label className="detail-label">
                    描述
                    <CommitInput
                      label="样式描述"
                      value={style.description}
                      commit={(description) =>
                        mutate((s) => {
                          s.styles[style.id].description = description;
                        })
                      }
                    />
                  </label>
                </div>
              ) : (
                <div className="compact-empty">选择样式</div>
              ))}
          </div>
          {view === "variables" && variable && (
            <aside className="variable-detail">
              <div className="section-title">
                {names[variable.type]}变量
                <button
                  className="icon-btn icon-btn-sm"
                  aria-label="关闭变量详情"
                  data-tip="关闭详情"
                  data-tip-side="left"
                  onClick={() => setSelected("")}
                >
                  <X size={13} />
                </button>
              </div>
              <strong>{variable.name}</strong>
              <label className="detail-label">
                描述
                <CommitInput
                  label="变量描述"
                  value={variable.description}
                  commit={(description) =>
                    mutate((s) => {
                      s.variables[variable.id].description = description;
                    })
                  }
                />
              </label>
              <label className="detail-label">
                代码名称
                <CommitInput
                  label="变量代码名称"
                  value={variable.codeSyntax}
                  commit={(codeSyntax) =>
                    mutate((s) => {
                      s.variables[variable.id].codeSyntax = codeSyntax;
                    })
                  }
                />
              </label>
              <div className="section-title" title="各平台代码导出语法">
                多平台 Code Syntax
              </div>
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: 6,
                }}
              >
                {(
                  [
                    ["web", "Web (CSS)", "--color-accent"],
                    ["react", "React", "tokens.colorAccent"],
                    ["ios", "iOS", "Color.accent"],
                    ["android", "Android", "R.color.accent"],
                  ] as const
                ).map(([platform, platformLabel, placeholder]) => (
                  <label
                    key={platform}
                    className="detail-label"
                    style={{ margin: 0 }}
                  >
                    <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
                      {platformLabel}
                    </span>
                    <input
                      key={`${variable.id}:${platform}:${variable.platformCodeSyntax?.[platform] ?? ""}`}
                      aria-label={`${platformLabel} 代码语法`}
                      placeholder={placeholder}
                      defaultValue={
                        variable.platformCodeSyntax?.[platform] ?? ""
                      }
                      onBlur={(ev) => {
                        const nextVal = ev.target.value.trim();
                        const prevVal =
                          variable.platformCodeSyntax?.[platform] ?? "";
                        if (nextVal === prevVal) return;
                        mutate((s) => {
                          const target = s.variables[variable.id];
                          const nextSyntax = {
                            ...(target.platformCodeSyntax ?? {}),
                          };
                          if (nextVal) nextSyntax[platform] = nextVal;
                          else delete nextSyntax[platform];
                          target.platformCodeSyntax = Object.keys(nextSyntax)
                            .length
                            ? nextSyntax
                            : undefined;
                        });
                      }}
                      onKeyDown={(ev) => {
                        if (ev.key === "Enter") ev.currentTarget.blur();
                        if (ev.key === "Escape") {
                          ev.currentTarget.value =
                            variable.platformCodeSyntax?.[platform] ?? "";
                          ev.currentTarget.blur();
                        }
                      }}
                    />
                  </label>
                ))}
              </div>
              <div className="section-title" title="未选择时允许所有同类型属性">
                作用域
                {variable.scopes.length > 0 && (
                  <button
                    type="button"
                    className="icon-btn icon-btn-sm"
                    style={{
                      width: "auto",
                      padding: "0 6px",
                      fontSize: 10,
                    }}
                    title="清空作用域限制以允许所有同类型属性"
                    aria-label="重置变量作用域"
                    data-tip="允许全部同类型属性"
                    onClick={() =>
                      mutate((s) => {
                        s.variables[variable.id].scopes = [];
                      })
                    }
                  >
                    全部
                  </button>
                )}
              </div>
              <div className="scope-list">
                {variableProperties
                  .filter((k) => propertyType(k) === variable.type)
                  .map((scope) => (
                    <label key={scope}>
                      <input
                        type="checkbox"
                        checked={variable.scopes.includes(scope)}
                        onChange={(ev) =>
                          mutate((s) => {
                            s.variables[variable.id].scopes = ev.target.checked
                              ? [...variable.scopes, scope]
                              : variable.scopes.filter((x) => x !== scope);
                          })
                        }
                      />
                      {propertyLabels[scope] ?? scope}
                    </label>
                  ))}
              </div>
            </aside>
          )}
        </div>
        <footer className="ds-footer">
          <span>
            {Object.keys(system.variables).length} 个变量 ·{" "}
            {Object.keys(system.styles).length} 个样式
          </span>
          <span title="更改将同步到引用这些变量与样式的图层，并可撤销">
            本地文件
          </span>
        </footer>
        <input
          ref={file}
          type="file"
          accept=".json"
          hidden
          onChange={async (ev) => {
            const input = ev.currentTarget,
              selected = input.files?.[0];
            if (!selected) return;
            try {
              if (selected.size > 10_000_000)
                throw new Error("设计系统文件超过 10 MB");
              const data = JSON.parse(await selected.text());
              act(() => {
                if (data.format !== "forma/design-system" || data.version !== 1)
                  throw new Error("设计系统文件格式不支持");
                const imported = parseDesignSystem(data.system),
                  merged = mergeDesignSystem(system, imported);
                e.apply([{ type: "setDesignSystem", system: merged.system }]);
              });
            } catch {
              setError("无法读取设计系统文件");
            } finally {
              input.value = "";
            }
          }}
        />
      </div>
    </div>
  );
}
