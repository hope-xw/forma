import {
  fontTagNames,
  settingsMap,
  setFontOption,
} from "../domain/font-settings";
import { useRef, useState } from "react";
import { Upload } from "lucide-react";
import type { EditorController } from "./useEditor";
import { readFont } from "../infrastructure/font-import";
import type { FontAsset } from "../domain/fonts";
import type { DesignNode } from "../domain/node";
import { isLocked } from "../domain/tree";
function Axis({
  axis,
  value,
  mixed,
  disabled,
  commit,
}: {
  axis: FontAsset["axes"][number];
  value: number;
  mixed: boolean;
  disabled?: boolean;
  commit: (n: number) => void;
}) {
  const [draft, setDraft] = useState<number | null>(null);
  const val = draft ?? value;
  const finish = (v: number) => {
    setDraft(null);
    if (
      (mixed || v !== value) &&
      Number.isFinite(v) &&
      v >= axis.min &&
      v <= axis.max
    )
      commit(v);
  };
  return (
    <label className="font-axis">
      <span title={axis.tag}>{fontTagNames[axis.tag] ?? axis.tag}</span>
      <input
        aria-label={axis.tag + " 滑块"}
        type="range"
        disabled={disabled}
        min={axis.min}
        max={axis.max}
        step="any"
        value={val}
        aria-valuetext={draft === null && mixed ? "Mixed" : String(val)}
        onChange={(ev) => setDraft(ev.currentTarget.valueAsNumber)}
        onPointerUp={(ev) => finish(ev.currentTarget.valueAsNumber)}
        onKeyUp={(ev) => {
          if (draft !== null) finish(ev.currentTarget.valueAsNumber);
        }}
        onBlur={(ev) => {
          if (draft !== null) finish(ev.currentTarget.valueAsNumber);
        }}
      />
      <input
        type="number"
        disabled={disabled}
        aria-label={axis.tag + " 轴值"}
        key={String(mixed) + ":" + value}
        min={axis.min}
        max={axis.max}
        step="any"
        placeholder={mixed ? "Mixed" : undefined}
        defaultValue={mixed ? "" : value}
        onBlur={(ev) => {
          if (ev.currentTarget.validity.valid)
            finish(ev.currentTarget.valueAsNumber);
          else ev.currentTarget.value = mixed ? "" : String(value);
        }}
        onKeyDown={(ev) => {
          if (ev.key === "Enter") ev.currentTarget.blur();
        }}
      />
    </label>
  );
}
export function FontAssets({
  editor: e,
  nodes,
}: {
  editor: EditorController;
  nodes: DesignNode[];
}) {
  const input = useRef<HTMLInputElement>(null);
  const locked = nodes.some((n) => isLocked(e.doc, n.id));
  const sharedFamily = nodes.every(
    (n) => n.style.fontFamily === nodes[0].style.fontFamily,
  );
  const family = sharedFamily ? nodes[0].style.fontFamily : undefined;
  const asset = family && e.doc.fonts?.[family];
  return (
    <>
      <div className="font-resource">
        <select
          aria-label="文件字体"
          disabled={locked}
          value={!sharedFamily ? "mixed" : asset ? family : ""}
          onChange={(ev) =>
            e.update(
              {},
              {
                fontFamily: ev.target.value || undefined,
                fontVariationSettings: undefined,
              },
            )
          }
        >
          <option value="mixed" hidden>
            Mixed
          </option>
          <option value="">系统字体</option>
          {Object.entries(e.doc.fonts ?? {}).map(([id, f]) => (
            <option key={id} value={id}>
              {f.name}
            </option>
          ))}
        </select>
        <button
          className="icon-btn icon-btn-sm"
          disabled={locked}
          aria-label="导入字体"
          data-tip="导入字体"
          data-tip-desc="嵌入可分发的 TTF 或 OTF，随设计文件和 React 工程保存"
          data-tip-side="left"
          onClick={() => input.current?.click()}
        >
          <Upload size={14} />
        </button>
        <input
          hidden
          ref={input}
          type="file"
          accept=".ttf,.otf"
          onChange={async (ev) => {
            const file = ev.target.files?.[0];
            ev.target.value = "";
            if (!file) return;
            const doc = e.historyRef.current.present,
              ids = nodes.map((n) => n.id);
            try {
              const { id, asset } = await readFont(file);
              if (e.historyRef.current.present.id !== doc.id) return;
              e.apply(
                [
                  { type: "putFont", id, font: asset },
                  ...ids.map((nodeId) => ({
                    type: "update" as const,
                    id: nodeId,
                    patch: {},
                    style: { fontFamily: id, fontVariationSettings: undefined },
                  })),
                ],
                doc.revision,
              );
            } catch (err) {
              e.setError(err instanceof Error ? err.message : String(err));
            }
          }}
        />
      </div>
      {asset && asset.axes.length > 0 && (
        <details className="advanced-properties">
          <summary>字体轴 · {asset.axes.length}</summary>
          {asset.axes.map((a) => {
            const first =
              settingsMap(nodes[0].style.fontVariationSettings).get(a.tag) ??
              a.default;
            return (
              <Axis
                key={a.tag}
                axis={a}
                disabled={locked}
                value={first}
                mixed={nodes.some(
                  (n) =>
                    (settingsMap(n.style.fontVariationSettings).get(a.tag) ??
                      a.default) !== first,
                )}
                commit={(v) =>
                  e.attempt(() =>
                    e.apply(
                      nodes.map((n) => {
                        return {
                          type: "update",
                          id: n.id,
                          patch: {},
                          style: {
                            fontVariationSettings: setFontOption(
                              n.style.fontVariationSettings,
                              a.tag,
                              v,
                            ),
                          },
                        };
                      }),
                    ),
                  )
                }
              />
            );
          })}
        </details>
      )}
      {asset && !!asset.features?.length && (
        <details className="advanced-properties">
          <summary>OpenType 字形 · {asset.features.length}</summary>
          {asset.features.map((tag) => {
            const vals = nodes.map((n) =>
              settingsMap(n.style.fontFeatureSettings).get(tag),
            );
            const shared = vals.every((v) => v === vals[0]);
            return (
              <label className="mode-row" key={tag}>
                <span title={tag}>{fontTagNames[tag] ?? tag}</span>
                <select
                  aria-label={"字体特性 " + tag}
                  disabled={locked}
                  value={shared ? String(vals[0] ?? "default") : "mixed"}
                  onChange={(ev) => {
                    const v = ev.target.value;
                    e.attempt(() =>
                      e.apply(
                        nodes.map((n) => ({
                          type: "update",
                          id: n.id,
                          patch: {},
                          style: {
                            fontFeatureSettings: setFontOption(
                              n.style.fontFeatureSettings,
                              tag,
                              v === "default" ? undefined : Number(v),
                            ),
                          },
                        })),
                      ),
                    );
                  }}
                >
                  <option value="mixed" hidden>
                    Mixed
                  </option>
                  <option value="default">字体默认</option>
                  <option value="1">启用</option>
                  <option value="0">关闭</option>
                  {shared && vals[0] !== undefined && vals[0] > 1 && (
                    <option value={vals[0]}>{vals[0]}</option>
                  )}
                </select>
              </label>
            );
          })}
        </details>
      )}
    </>
  );
}
