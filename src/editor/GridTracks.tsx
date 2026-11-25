import { Plus, Minus, Columns3 } from "lucide-react";
import { useState } from "react";
import { parseTracks } from "../domain/grid-tracks";
import type { NodeStyle } from "../domain/node";

export function GridTracks({
  style,
  disabled,
  commit,
}: {
  style: NodeStyle;
  disabled: boolean;
  commit: (value: Partial<NodeStyle>) => void;
}) {
  const [axis, setAxis] = useState<"column" | "row">("column");
  const columns = axis === "column";
  const key = columns ? "gridTracks" : "gridRowTracks";
  const tracks = style[key]
    ? parseTracks(style[key]!)
    : Array.from({ length: columns ? (style.columns ?? 2) : 1 }, () =>
        columns
          ? { value: 1, unit: "fr" }
          : style.gridRowHeight
            ? { value: style.gridRowHeight, unit: "px" }
            : { value: 1, unit: "auto" },
      );
  const store = (next: typeof tracks) =>
    commit({
      [key]: next
        .map((t) => (t.unit === "auto" ? "auto" : t.value + t.unit))
        .join(" "),
      ...(columns ? { columns: next.length } : {}),
    });
  const name = columns ? "列" : "行";
  return (
    <details className="advanced-properties track-editor">
      <summary>
        <Columns3 size={14} />
        网格轨道
      </summary>
      <div className="track-toolbar">
        <select
          aria-label="轨道方向"
          value={axis}
          onChange={(ev) => setAxis(ev.target.value as typeof axis)}
        >
          <option value="column">列轨道</option>
          <option value="row">行轨道</option>
        </select>
        <button
          className="icon-btn icon-btn-sm"
          aria-label={"添加" + name + "轨道"}
          data-tip={"添加" + name + "轨道"}
          disabled={disabled || tracks.length >= 64}
          onClick={() =>
            store([...tracks, { value: 1, unit: columns ? "fr" : "auto" }])
          }
        >
          <Plus size={14} />
        </button>
      </div>
      {tracks.map((t, i) => {
        const label = "第 " + (i + 1) + " " + name;
        return (
          <div className="track-row" key={axis + i}>
            <span>
              {name} {i + 1}
            </span>
            <input
              key={t.value + ":" + t.unit}
              aria-label={label + "尺寸"}
              type="number"
              min="0.01"
              max="10000"
              step="any"
              defaultValue={t.unit === "auto" ? "" : t.value}
              disabled={disabled || t.unit === "auto"}
              onBlur={(ev) => {
                const value = ev.currentTarget.valueAsNumber;
                if (
                  ev.currentTarget.validity.valid &&
                  Number.isFinite(value) &&
                  value !== t.value
                )
                  store(tracks.map((a, j) => (i === j ? { ...a, value } : a)));
                else ev.currentTarget.value = String(t.value);
              }}
              onKeyDown={(ev) => {
                if (ev.key === "Enter") ev.currentTarget.blur();
              }}
            />
            <select
              aria-label={label + "模式"}
              disabled={disabled}
              value={t.unit}
              onChange={(ev) => {
                const unit = ev.target.value;
                store(
                  tracks.map((a, j) =>
                    i === j
                      ? {
                          unit,
                          value:
                            unit === "px"
                              ? Math.max(
                                  1,
                                  Math.round(
                                    (columns ? style.width : style.height) /
                                      tracks.length,
                                  ),
                                )
                              : 1,
                        }
                      : a,
                  ),
                );
              }}
            >
              <option value="px">固定 px</option>
              <option value="fr">比例 fr</option>
              <option value="auto">适应内容</option>
            </select>
            <button
              className="icon-btn icon-btn-sm"
              data-tip={"删除" + label}
              aria-label={"删除" + label}
              disabled={disabled || tracks.length === 1}
              onClick={() => store(tracks.filter((_, j) => j !== i))}
            >
              <Minus size={13} />
            </button>
          </div>
        );
      })}
      {style[key] && (
        <button
          disabled={disabled}
          onClick={() => commit({ [key]: undefined })}
        >
          {columns ? "恢复等宽列" : "恢复默认行高"}
        </button>
      )}
    </details>
  );
}
