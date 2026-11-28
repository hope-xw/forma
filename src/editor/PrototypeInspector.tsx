import { useState, useRef } from "react";
import {
  LocateFixed,
  ArrowUp,
  ArrowDown,
  Minus,
  Plus,
  Play,
  Trash2,
  Variable,
} from "lucide-react";
import type { EditorController } from "./useEditor";
import type { Interaction, PrototypeAction } from "../domain/prototype";
import { isSceneFrame, prototypeIssues } from "../domain/prototype";
import { resolveVariable } from "../domain/design-system";
import { isLocked } from "../domain/tree";
import type { DesignNode } from "../domain/document";
import { DraftNumberInput } from "./GridTracks";
import { ColorField } from "./ColorField";

const labels: Record<PrototypeAction["kind"], string> = {
  navigate: "跳转至画板",
  overlay: "打开浮层",
  openLink: "打开外部链接",
  close: "关闭浮层",
  back: "返回",
  reset: "重新开始",
  scrollTo: "滚动到图层",
  control: "设置控件状态",
  set: "设置变量",
  toggle: "切换布尔变量",
  input: "写入触发值",
};
type Value = string | number | boolean;
function ValueField({
  value,
  isColor = false,
  disabled = false,
  onChange,
}: {
  value: Value;
  isColor?: boolean;
  disabled?: boolean;
  onChange: (v: Value) => void;
}) {
  if (isColor && typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value)) {
    return (
      <ColorField
        disabled={disabled}
        label="变量颜色值"
        color={value}
        allowAlpha={false}
        onChange={(hex) => onChange(hex)}
      />
    );
  }
  return typeof value === "boolean" ? (
    <select
      disabled={disabled}
      aria-label="值"
      value={String(value)}
      onChange={(e) => onChange(e.target.value === "true")}
    >
      <option>true</option>
      <option>false</option>
    </select>
  ) : (
    <input
      disabled={disabled}
      aria-label="值"
      key={String(value)}
      type={typeof value === "number" ? "number" : "text"}
      defaultValue={value}
      onBlur={(e) => {
        const v =
          typeof value === "number" ? e.target.valueAsNumber : e.target.value;
        if (v !== value && (typeof v !== "number" || Number.isFinite(v)))
          onChange(v);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" && !e.nativeEvent.isComposing)
          e.currentTarget.blur();
      }}
    />
  );
}
export function PrototypeInspector({
  editor: e,
  openVariables,
}: {
  editor: EditorController;
  openVariables: () => void;
}) {
  const [origin, setOrigin] = useState<{
    file: string;
    page: string;
    id: string;
  } | null>(null);
  const cancelledRef = useRef(false);
  const activePage = e.doc.activePage ?? e.doc.pages?.[0]?.id ?? "first";
  function reveal(page: string, id: string) {
    // Switching pages replaces history and would dismiss an active proposal.
    if (page !== activePage && e.previewRef?.current) return;
    const nodes =
      page === activePage
        ? e.doc.nodes
        : e.doc.pages?.find((p) => p.id === page)?.nodes;
    if (!nodes?.some((n) => n.id === id)) {
      setOrigin(null);
      e.setError("连线图层已不存在");
      return;
    }
    if (page !== activePage) e.switchPage(page);
    e.setSelection([id]);
    requestAnimationFrame(() => e.api.current?.fit([id]));
  }
  const node = e.selected.length === 1 ? e.selected[0] : undefined;
  const activeById = new Map(e.doc.nodes.map((n) => [n.id, n]));
  const boards = e.doc.nodes.filter(
    (n) => isSceneFrame(n, activeById) && !n.hidden,
  );
  const boardGroups = [
    {
      name:
        e.doc.pages?.find((p) => p.id === e.doc.activePage)?.name ?? "当前页面",
      id: activePage,
      nodes: boards,
    },
    ...(e.doc.pages ?? [])
      .filter((p) => p.nodes)
      .map((p) => {
        const pMap = new Map(p.nodes!.map((n) => [n.id, n]));
        return {
          name: p.name,
          id: p.id,
          nodes: p.nodes!.filter((n) => isSceneFrame(n, pMap) && !n.hidden),
        };
      }),
  ];
  const locate = (target: string) => {
    const group = boardGroups.find((p) => p.nodes.some((b) => b.id === target));
    if (group && node) {
      setOrigin({ file: e.doc.id, page: activePage, id: node.id });
      reveal(group.id, target);
    }
  };
  const targetBoards = boardGroups.flatMap((p) => p.nodes);
  const rule = node?.interaction ?? {};
  const extraRules = node?.interactions ?? [];
  const previewBlocked = Boolean(
    e.previewRef?.current && e.doc !== e.committed,
  );
  const disabled = previewBlocked || (!!node && isLocked(e.doc, node.id));
  const patch = (p: Partial<Interaction>) =>
    !disabled &&
    !e.previewRef?.current &&
    e.update({ interaction: { ...rule, ...p } });
  const updateExtraRules = (next: Interaction[]) =>
    !disabled &&
    !e.previewRef?.current &&
    e.update({ interactions: next.length ? next : undefined });
  const patchExtra = (ruleIndex: number, p: Partial<Interaction>) =>
    updateExtraRules(
      extraRules.map((item, idx) =>
        idx === ruleIndex ? { ...item, ...p } : item,
      ),
    );
  const addExtraInteraction = () => {
    const primaryTrigger = rule.trigger ?? "click";
    const nextTrigger: NonNullable<Interaction["trigger"]> =
      primaryTrigger === "hover" ? "click" : "hover";
    const board =
      targetBoards.find((b) => b.id !== node?.id) ?? targetBoards[0];
    const defaultAction: PrototypeAction = board
      ? { kind: "navigate", target: board.id }
      : { kind: "back" };
    updateExtraRules([
      ...extraRules,
      {
        trigger: nextTrigger,
        actions: [defaultAction],
      },
    ]);
  };
  return (
    <div className="page-inspector prototype-panel">
      {origin?.file === e.doc.id && (
        <button
          disabled={previewBlocked && origin.page !== activePage}
          onClick={() => {
            reveal(origin.page, origin.id);
            setOrigin(null);
          }}
        >
          返回连线来源
        </button>
      )}
      <section>
        <div className="section-title">流程起点</div>
        {boardGroups.flatMap((group) =>
          group.nodes
            .filter((b) => b.interaction?.flow)
            .map((b) => (
              <button
                key={group.id + ":" + b.id}
                disabled={previewBlocked && group.id !== activePage}
                className="local-style-row"
                onClick={() => reveal(group.id, b.id)}
              >
                <Play size={11} style={{ color: "var(--figma-blue)" }} />
                <span className="truncate">{b.interaction!.flow}</span>
                {group.id !== activePage && (
                  <small
                    style={{ marginLeft: "auto", color: "var(--text-muted)" }}
                  >
                    {group.name}
                  </small>
                )}
              </button>
            )),
        )}
        {node && isSceneFrame(node, activeById) && (
          <label>
            名称
            <input
              aria-label="流程名称"
              key={node.id + rule.flow}
              defaultValue={rule.flow ?? ""}
              placeholder="添加流程起点"
              disabled={disabled}
              onBlur={(ev) => {
                if (cancelledRef.current) {
                  cancelledRef.current = false;
                  return;
                }
                const flow = ev.target.value.trim() || undefined;
                if (flow !== rule.flow) patch({ flow });
              }}
              onKeyDown={(ev) => {
                if (ev.nativeEvent.isComposing) return;
                if (ev.key === "Escape" || ev.key === "Enter") {
                  ev.preventDefault();
                  ev.stopPropagation();
                  cancelledRef.current = ev.key === "Escape";
                  if (cancelledRef.current)
                    ev.currentTarget.value = rule.flow ?? "";
                  ev.currentTarget.blur();
                }
              }}
            />
          </label>
        )}
      </section>
      {node ? (
        <fieldset>
          {node.type === "frame" && (
            <section>
              <label>
                溢出滚动
                <select
                  aria-label="溢出滚动"
                  disabled={disabled}
                  value={rule.scroll ?? ""}
                  onChange={(ev) =>
                    patch({
                      scroll:
                        (ev.target.value as Interaction["scroll"]) || undefined,
                    })
                  }
                >
                  <option value="">无</option>
                  <option value="vertical">垂直</option>
                  <option value="horizontal">水平</option>
                  <option value="both">双向</option>
                </select>
              </label>
            </section>
          )}
          <section>
            <div className="section-title">
              {node.control && node.control.kind !== "button"
                ? "值变化时"
                : rule.trigger === "hover"
                  ? "悬停时"
                  : rule.trigger === "delay"
                    ? "延迟后"
                    : "点击时"}
              <button
                className="icon-btn icon-btn-sm"
                title="管理原型变量"
                aria-label="管理原型变量"
                disabled={disabled}
                data-tip="管理原型变量"
                onClick={() => {
                  if (!e.previewRef?.current) openVariables();
                }}
              >
                <Variable size={14} />
              </button>
            </div>
          </section>
          <RuleEditor
            key={node.id}
            editor={e}
            node={node}
            rule={rule}
            patch={patch}
            disabled={disabled}
            boardGroups={boardGroups}
            locate={locate}
          />
          {extraRules.map((extra, rIdx) => {
            return (
              <section
                key={node.id + ":extra:" + rIdx}
                style={{
                  borderTop: "1px solid var(--border-subtle)",
                  paddingTop: 8,
                  marginTop: 4,
                }}
              >
                <div className="section-title">
                  <span>
                    附加交互 {rIdx + 2} ·{" "}
                    {extra.trigger === "hover"
                      ? "悬停时"
                      : extra.trigger === "delay"
                        ? "延迟后"
                        : "点击时"}
                  </span>
                  <div style={{ display: "inline-flex", gap: 4 }}>
                    <button
                      type="button"
                      className="icon-btn icon-btn-sm"
                      title="删除此交互规则"
                      disabled={disabled}
                      aria-label={`删除交互 ${rIdx + 2}`}
                      data-tip="删除此交互"
                      onClick={() =>
                        updateExtraRules(
                          extraRules.filter((_, j) => j !== rIdx),
                        )
                      }
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                </div>
                <RuleEditor
                  editor={e}
                  node={node}
                  rule={extra}
                  number={rIdx + 2}
                  patch={(p) => patchExtra(rIdx, p)}
                  disabled={disabled}
                  boardGroups={boardGroups}
                  locate={locate}
                />
              </section>
            );
          })}
          <section>
            <button
              type="button"
              className="wide"
              aria-label="添加交互"
              disabled={disabled || extraRules.length >= 16}
              onClick={addExtraInteraction}
            >
              + 添加交互
            </button>
          </section>
        </fieldset>
      ) : (
        <section>选择一个图层以编辑交互</section>
      )}
      {prototypeIssues(e.doc).map((issue, i) => (
        <p key={i} role="status">
          {issue}
        </p>
      ))}
    </div>
  );
}

function RuleEditor({
  editor: e,
  rule,
  patch,
  node,
  number,
  boardGroups,
  locate,
  disabled,
}: {
  editor: EditorController;
  rule: Interaction;
  node: DesignNode;
  number?: number;
  boardGroups: { id: string; name: string; nodes: DesignNode[] }[];
  locate(target: string): void;
  patch(change: Partial<Interaction>): void;
  disabled: boolean;
}) {
  const escapedLink = useRef<HTMLInputElement | null>(null);
  const label = (name: string) => (number ? `交互 ${number} ${name}` : name);
  const targetBoards = boardGroups.flatMap((p) => p.nodes);
  const controls = e.doc.nodes.filter((n) => n.control);
  const system = e.doc.designSystem;
  const vars = Object.values(system?.variables ?? {});
  const setType = (a: Extract<PrototypeAction, { kind: "set" }>) =>
    system?.variables[a.variable]?.type ?? typeof a.value;
  const initial = (id: string) =>
    resolveVariable(system!, id, system!.activeModes);
  function make(kind: PrototypeAction["kind"]): PrototypeAction | undefined {
    const board =
      targetBoards.find((b) => b.id !== node?.id) ?? targetBoards[0];
    switch (kind) {
      case "navigate":
      case "overlay":
        return (
          board &&
          (kind === "navigate"
            ? { kind, target: board.id }
            : { kind, target: board.id, position: "center" })
        );
      case "scrollTo":
        return node && { kind, target: node.id };
      case "control":
        return (
          controls[0] && {
            kind,
            target: controls[0].id,
            value: controls[0].control!.value,
          }
        );
      case "input":
      case "toggle":
      case "set": {
        const v = vars.find((v) =>
          kind === "toggle"
            ? v.type === "boolean"
            : kind === "input"
              ? v.type ===
                (node?.control ? typeof node.control.value : "boolean")
              : true,
        );
        return (
          v &&
          (kind === "set"
            ? { kind, variable: v.id, value: initial(v.id) }
            : { kind, variable: v.id })
        );
      }
      case "openLink":
        return { kind, url: "https://example.com" };
      case "back":
      case "close":
      case "reset":
        return { kind };
    }
  }
  function sequence(key: "actions" | "otherwise") {
    const list = rule[key] ?? [];
    const replace = (i: number, a: PrototypeAction) =>
      patch({ [key]: list.map((old, j) => (j === i ? a : old)) });
    const reorder = (i: number, j: number) => {
      const next = list.slice();
      [next[i], next[j]] = [next[j], next[i]];
      patch({ [key]: next });
    };
    return (
      <section>
        <div className="section-title">
          {key === "otherwise" ? "否则" : rule.condition ? "条件成立" : "动作"}
          <button
            title="添加动作"
            aria-label={
              number && key === "actions"
                ? `添加交互 ${number} 动作`
                : label(key === "otherwise" ? "添加否则动作" : "添加动作")
            }
            data-tip="添加动作"
            disabled={disabled || list.length >= 64}
            onClick={() =>
              patch({ [key]: [...list, make("navigate") ?? { kind: "back" }] })
            }
          >
            <Plus size={14} />
          </button>
        </div>
        {list.map((a, i) => (
          <div key={i} className="prototype-action">
            <div className="prototype-row">
              <select
                disabled={disabled}
                aria-label={label("动作类型")}
                value={a.kind}
                onChange={(ev) => {
                  const next = make(ev.target.value as PrototypeAction["kind"]);
                  if (!next) return;
                  if (
                    (a.kind === "navigate" || a.kind === "overlay") &&
                    (next.kind === "navigate" || next.kind === "overlay") &&
                    targetBoards.some((n) => n.id === a.target)
                  )
                    next.target = a.target;
                  replace(i, next);
                }}
              >
                {Object.entries(labels).map(([k, name]) => (
                  <option
                    key={k}
                    value={k}
                    disabled={!make(k as PrototypeAction["kind"])}
                  >
                    {name}
                  </option>
                ))}
              </select>
              <button
                aria-label={label("上移动作")}
                data-tip="上移"
                title="上移"
                disabled={disabled || i === 0}
                onClick={() => reorder(i, i - 1)}
              >
                <ArrowUp size={13} />
              </button>
              <button
                aria-label={label("下移动作")}
                data-tip="下移"
                title="下移"
                disabled={disabled || i === list.length - 1}
                onClick={() => reorder(i, i + 1)}
              >
                <ArrowDown size={13} />
              </button>
              <button
                disabled={disabled}
                aria-label={number ? `删除交互 ${number} 动作` : "删除动作"}
                data-tip="删除"
                title="删除"
                onClick={() => patch({ [key]: list.filter((_, j) => j !== i) })}
              >
                <Minus size={13} />
              </button>
            </div>
            {a.kind === "openLink" && (
              <input
                disabled={disabled}
                aria-label={label("链接地址")}
                type="url"
                placeholder="https://example.com"
                key={node.id + ":" + a.url}
                defaultValue={a.url}
                onBlur={(ev) => {
                  const input = ev.currentTarget;
                  if (escapedLink.current === input) {
                    escapedLink.current = null;
                    return;
                  }
                  const url = input.value.trim();
                  if (url !== a.url.trim() && /^https?:\/\//i.test(url)) {
                    input.value = url;
                    replace(i, { ...a, url });
                  } else input.value = a.url;
                }}
                onKeyDown={(ev) => {
                  if (
                    ev.nativeEvent.isComposing ||
                    (ev.key !== "Enter" && ev.key !== "Escape")
                  )
                    return;
                  ev.preventDefault();
                  ev.stopPropagation();
                  if (ev.key === "Escape") {
                    escapedLink.current = ev.currentTarget;
                    ev.currentTarget.value = a.url;
                  }
                  ev.currentTarget.blur();
                }}
              />
            )}
            {"target" in a && (
              <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                <select
                  disabled={disabled}
                  aria-label={label("动作目标")}
                  style={{ flex: 1, minWidth: 0 }}
                  value={a.target}
                  onChange={(ev) => {
                    const target = ev.target.value;
                    replace(
                      i,
                      a.kind === "control"
                        ? {
                            ...a,
                            target,
                            value: controls.find((n) => n.id === target)!
                              .control!.value,
                          }
                        : { ...a, target },
                    );
                  }}
                >
                  {!(
                    a.kind === "overlay" || a.kind === "navigate"
                      ? targetBoards
                      : e.doc.nodes
                  ).some((n) => n.id === a.target) && (
                    <option value={a.target}>目标已删除</option>
                  )}
                  {a.kind === "navigate" || a.kind === "overlay"
                    ? boardGroups
                        .filter((p) => p.nodes.length)
                        .map((p, idx) => (
                          <optgroup key={idx} label={p.name}>
                            {p.nodes.map((n) => (
                              <option key={n.id} value={n.id}>
                                {n.name}
                              </option>
                            ))}
                          </optgroup>
                        ))
                    : (a.kind === "control" ? controls : e.doc.nodes).map(
                        (n) => (
                          <option key={n.id} value={n.id}>
                            {n.name}
                          </option>
                        ),
                      )}
                </select>
                {(a.kind === "navigate" || a.kind === "overlay") && node && (
                  <button
                    className="icon-btn icon-btn-sm"
                    aria-label={label("定位目标画板")}
                    data-tip="定位目标画板"
                    data-tip-desc="在设计画布中查看连线目标"
                    disabled={
                      !targetBoards.some((b) => b.id === a.target) ||
                      (Boolean(
                        e.previewRef?.current && e.doc !== e.committed,
                      ) &&
                        !boardGroups[0].nodes.some((b) => b.id === a.target))
                    }
                    onClick={() => locate(a.target)}
                  >
                    <LocateFixed size={13} />
                  </button>
                )}
              </div>
            )}
            {(a.kind === "navigate" || a.kind === "overlay") && (
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <div className="prototype-row">
                  <select
                    disabled={disabled}
                    aria-label={label("转场动画")}
                    style={{ flex: 1 }}
                    value={a.transition?.type ?? "instant"}
                    onChange={(ev) => {
                      const type = ev.target.value as NonNullable<
                        typeof a.transition
                      >["type"];
                      replace(i, {
                        ...a,
                        transition:
                          type === "instant"
                            ? undefined
                            : {
                                type,
                                direction:
                                  a.transition?.direction ??
                                  (a.kind === "overlay" ? "top" : "left"),
                                duration: a.transition?.duration ?? 300,
                                easing: a.transition?.easing ?? "ease-out",
                              },
                      });
                    }}
                  >
                    <option value="instant">瞬间切换 (Instant)</option>
                    <option value="dissolve">溶解淡入 (Dissolve)</option>
                    <option value="smart-animate">
                      智能动画 (Smart Animate)
                    </option>
                    <option value="move-in">移入 (Move in)</option>
                    <option value="push">推入 (Push)</option>
                    <option value="slide-in">滑入 (Slide in)</option>
                  </select>
                  {a.transition && a.transition.type !== "instant" && (
                    <DraftNumberInput
                      disabled={disabled}
                      aria-label={label("转场时长毫秒")}
                      min={0}
                      max={5000}
                      style={{ width: 64 }}
                      value={a.transition.duration ?? 300}
                      onCommit={(duration) =>
                        replace(i, {
                          ...a,
                          transition: { ...a.transition!, duration },
                        })
                      }
                    />
                  )}
                </div>
                {a.transition && a.transition.type !== "instant" && (
                  <div className="prototype-row">
                    {!["smart-animate", "dissolve"].includes(
                      a.transition.type,
                    ) && (
                      <select
                        disabled={disabled}
                        aria-label={label("转场方向")}
                        style={{ flex: 1 }}
                        value={a.transition.direction ?? "left"}
                        onChange={(ev) =>
                          replace(i, {
                            ...a,
                            transition: {
                              ...a.transition!,
                              direction: ev.target.value as
                                "left" | "right" | "top" | "bottom",
                            },
                          })
                        }
                      >
                        <option value="left">向左 (Left)</option>
                        <option value="right">向右 (Right)</option>
                        <option value="top">向上 (Top)</option>
                        <option value="bottom">向下 (Bottom)</option>
                      </select>
                    )}
                    <select
                      disabled={disabled}
                      aria-label={label("缓动曲线")}
                      style={{ flex: 1 }}
                      value={a.transition.easing ?? "ease-out"}
                      onChange={(ev) =>
                        replace(i, {
                          ...a,
                          transition: {
                            ...a.transition!,
                            easing: ev.target.value as
                              "linear" | "ease-out" | "ease-in-out",
                          },
                        })
                      }
                    >
                      <option value="ease-out">缓出 (Ease out)</option>
                      <option value="ease-in-out">
                        缓入缓出 (Ease in-out)
                      </option>
                      <option value="linear">线性 (Linear)</option>
                    </select>
                  </div>
                )}
              </div>
            )}
            {a.kind === "navigate" && (
              <label>
                <input
                  disabled={disabled}
                  type="checkbox"
                  checked={!!a.resetScroll}
                  onChange={(ev) =>
                    replace(i, { ...a, resetScroll: ev.target.checked })
                  }
                />
                重置目标滚动位置
              </label>
            )}
            {a.kind === "overlay" && (
              <select
                disabled={disabled}
                aria-label={label("浮层位置")}
                value={a.position}
                onChange={(ev) =>
                  replace(i, {
                    ...a,
                    position: ev.target.value as typeof a.position,
                  })
                }
              >
                <option value="center">居中</option>
                <option value="bottom">底部</option>
              </select>
            )}
            {a.kind === "set" && (
              <select
                disabled={disabled}
                aria-label={label("赋值类型")}
                value={setType(a)}
                onChange={(ev) => {
                  const first = vars.find((v) => v.type === ev.target.value);
                  if (first)
                    replace(i, {
                      ...a,
                      variable: first.id,
                      value: initial(first.id),
                    });
                }}
              >
                {[...new Set(vars.map((v) => v.type))].map((type) => (
                  <option key={type} value={type}>
                    {
                      {
                        color: "颜色",
                        string: "文本",
                        number: "数值",
                        boolean: "布尔",
                      }[type]
                    }
                  </option>
                ))}
              </select>
            )}
            {"variable" in a && (
              <select
                disabled={disabled}
                aria-label={label("目标变量")}
                value={a.variable}
                onChange={(ev) => {
                  const variable = ev.target.value;
                  replace(
                    i,
                    a.kind === "set"
                      ? { ...a, variable, value: initial(variable) }
                      : { ...a, variable },
                  );
                }}
              >
                {vars
                  .filter((v) =>
                    a.kind === "toggle"
                      ? v.type === "boolean"
                      : a.kind === "input"
                        ? v.type ===
                          (node?.control
                            ? typeof node.control.value
                            : "boolean")
                        : v.type === setType(a),
                  )
                  .map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.name}
                    </option>
                  ))}
              </select>
            )}
            {"value" in a && (
              <ValueField
                disabled={disabled}
                value={a.value}
                isColor={
                  "variable" in a &&
                  system?.variables[a.variable]?.type === "color"
                }
                onChange={(value) => replace(i, { ...a, value })}
              />
            )}
          </div>
        ))}
      </section>
    );
  }
  return (
    <>
      <section>
        {(number || !node.control || node.control.kind === "button") && (
          <div className="prototype-row" style={{ marginBottom: 6 }}>
            <select
              aria-label={label("触发方式")}
              disabled={disabled}
              style={{ flex: 1 }}
              value={rule.trigger ?? "click"}
              onChange={(ev) => {
                const trigger = ev.target.value as NonNullable<
                  Interaction["trigger"]
                >;
                patch({
                  trigger: trigger === "click" ? undefined : trigger,
                  ...(trigger === "delay"
                    ? { delayMs: rule.delayMs ?? 1000 }
                    : { delayMs: undefined }),
                });
              }}
            >
              <option value="click">点击时 (On click)</option>
              <option value="hover">悬停时 (While hovering)</option>
              <option value="delay">延迟后 (After delay)</option>
            </select>
            {rule.trigger === "delay" && (
              <DraftNumberInput
                aria-label={label("延迟毫秒")}
                disabled={disabled}
                min={0}
                max={60000}
                step={1}
                style={{ width: 72 }}
                value={rule.delayMs ?? 1000}
                onCommit={(delayMs) => patch({ delayMs })}
              />
            )}
          </div>
        )}
        <select
          disabled={disabled}
          aria-label={label("条件变量")}
          value={rule.condition?.variable ?? ""}
          onChange={(ev) => {
            const id = ev.target.value;
            patch({
              condition: id
                ? { variable: id, operator: "equals", value: initial(id) }
                : undefined,
              ...(!id ? { otherwise: undefined } : {}),
            });
          }}
        >
          <option value="">总是执行</option>
          {vars.map((v) => (
            <option key={v.id} value={v.id}>
              如果 · {v.name}
            </option>
          ))}
        </select>
        {rule.condition && (
          <div className="prototype-row">
            <select
              disabled={disabled}
              aria-label={label("比较方式")}
              value={rule.condition.operator}
              onChange={(ev) =>
                patch({
                  condition: {
                    ...rule.condition!,
                    operator: ev.target.value as NonNullable<
                      Interaction["condition"]
                    >["operator"],
                  },
                })
              }
            >
              <option value="equals">等于</option>
              <option value="different">不等于</option>
              {typeof rule.condition.value === "number" && (
                <>
                  <option value="greater">大于</option>
                  <option value="less">小于</option>
                </>
              )}
            </select>
            <ValueField
              disabled={disabled}
              value={rule.condition.value}
              onChange={(value) =>
                patch({ condition: { ...rule.condition!, value } })
              }
            />
          </div>
        )}
      </section>
      {sequence("actions")}
      {rule.condition && sequence("otherwise")}
    </>
  );
}
