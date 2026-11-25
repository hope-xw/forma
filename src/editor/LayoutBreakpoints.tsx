import { ColorField } from "./ColorField";
import { Plus, Minus, RotateCcw } from "lucide-react";
import { useState } from "react";
import type { LayoutRule } from "../domain/layout-breakpoints";

const fields = [
  ["maxWidth", "最大宽度", 1, 10000],
  ["columns", "列数", 1, 64],
  ["gap", "间距", 0, 1000],
  ["rowGap", "行间距", 0, 1000],
  ["padding", "内边距", 0, 1000],
  ["radius", "圆角", 0, 1000],
  ["opacity", "不透明度", 0, 100],
] as const;

export function LayoutBreakpoints({
  rules = [],
  grid,
  appearanceOnly = false,
  baseFill = "#ffffff",
  disabled = false,
  commit,
}: {
  rules?: LayoutRule[];
  grid: boolean;
  appearanceOnly?: boolean;
  baseFill?: string;
  disabled?: boolean;
  commit: (rules: LayoutRule[] | undefined) => void;
}) {
  const [open, setOpen] = useState(false);
  const used = new Set(rules.map((r) => r.maxWidth));
  const add = () => {
    let max =
      [768, 480, 1024, 1280, 1440, 640, 360, 1920].find((n) => !used.has(n)) ??
      1;
    while (used.has(max)) max++;
    commit([
      ...rules,
      { maxWidth: max, ...(grid && !appearanceOnly ? { columns: 1 } : {}) },
    ]);
    setOpen(true);
  };
  return (
    <details
      className="advanced-properties breakpoint-editor"
      open={open}
      onToggle={(ev) => setOpen(ev.currentTarget.open)}
    >
      <summary>容器断点{rules.length ? " · " + rules.length : ""}</summary>
      {rules.map((r, i) => (
        <fieldset key={i} disabled={disabled}>
          <legend>
            <span>≤ {r.maxWidth} px</span>{" "}
            <button
              className="icon-btn icon-btn-sm"
              disabled={disabled}
              aria-label={"移除断点 " + (i + 1)}
              data-tip={"移除断点 " + (i + 1)}
              onClick={() =>
                commit(
                  rules.length > 1
                    ? rules.filter((_, j) => j !== i)
                    : undefined,
                )
              }
            >
              <Minus size={14} />
            </button>
          </legend>
          {fields
            .filter(([key]) =>
              appearanceOnly
                ? ["maxWidth", "radius", "opacity"].includes(key)
                : key !== "columns" || grid,
            )
            .map(([key, name, min, max]) => (
              <label key={key}>
                {key === "opacity" ? name + " (%)" : name}
                <input
                  type="number"
                  key={String(r[key])}
                  aria-label={"断点 " + (i + 1) + " " + name}
                  min={min}
                  max={max}
                  step={key === "maxWidth" || key === "columns" ? "1" : "any"}
                  defaultValue={
                    key === "opacity" && r.opacity !== undefined
                      ? Number((r.opacity * 100).toFixed(8))
                      : (r[key] ?? "")
                  }
                  placeholder="继承"
                  onBlur={(ev) => {
                    const input = ev.currentTarget;
                    const reset = () => {
                      input.value = input.defaultValue;
                    };
                    const value =
                      input.value === ""
                        ? undefined
                        : input.valueAsNumber / (key === "opacity" ? 100 : 1);
                    if (
                      !input.validity.valid ||
                      (key === "maxWidth" &&
                        (value === undefined ||
                          rules.some(
                            (b, j) => j !== i && b.maxWidth === value,
                          )))
                    ) {
                      reset();
                      return;
                    }
                    if (value !== r[key])
                      commit(
                        rules.map((b, j) =>
                          j === i ? { ...b, [key]: value } : b,
                        ),
                      );
                  }}
                  onKeyDown={(ev) => {
                    if (ev.key === "Enter") ev.currentTarget.blur();
                  }}
                />
              </label>
            ))}
          <div className="breakpoint-fill">
            <span>填充</span>
            <ColorField
              label={"断点 " + (i + 1) + " 填充"}
              color={
                r.fill ??
                rules
                  .filter((b) => b.maxWidth > r.maxWidth && b.fill)
                  .sort((a, b) => a.maxWidth - b.maxWidth)[0]?.fill ??
                baseFill
              }
              allowAlpha={false}
              disabled={disabled}
              onChange={(fill) =>
                commit(rules.map((b, j) => (i === j ? { ...b, fill } : b)))
              }
            />
            <button
              type="button"
              className="icon-btn icon-btn-sm"
              aria-label={"断点 " + (i + 1) + " 恢复继承填充"}
              data-tip="恢复继承填充"
              disabled={disabled || r.fill === undefined}
              onClick={() =>
                commit(
                  rules.map((b, j) =>
                    i === j ? { ...b, fill: undefined } : b,
                  ),
                )
              }
            >
              <RotateCcw size={13} />
            </button>
          </div>
        </fieldset>
      ))}
      <button
        type="button"
        className="breakpoint-add"
        disabled={disabled || rules.length >= 8}
        onClick={add}
      >
        <Plus size={14} />
        添加断点
      </button>
    </details>
  );
}
