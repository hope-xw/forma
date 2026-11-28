import {
  fontTagNames,
  settingsMap,
  setFontOption,
} from "../domain/font-settings";
import { useContext, useLayoutEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import {
  PopoverDocumentSessionContext,
  PopoverSurfaceContext,
} from "./useAnchoredPopover";
import { Upload } from "lucide-react";
import type { EditorController } from "./useEditor";
import {
  readFont,
  releaseDocumentFonts,
  type listTtcFaces,
} from "../infrastructure/font-import";
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
    if (!Number.isFinite(v) || v < axis.min || v > axis.max) return false;
    if (mixed || v !== value) commit(v);
    return true;
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
          const field = ev.currentTarget;
          if (!field.validity.valid || !finish(field.valueAsNumber))
            field.value = mixed ? "" : String(value);
        }}
        onKeyDown={(ev) => {
          if (ev.nativeEvent.isComposing) return;
          if (ev.key === "Escape") {
            ev.stopPropagation();
            ev.currentTarget.value = mixed ? "" : String(value);
            ev.currentTarget.blur();
          } else if (ev.key === "Enter") ev.currentTarget.blur();
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
  type Faces = ReturnType<typeof listTtcFaces>;
  const [choices, setChoices] = useState<Faces>();
  const picker = useRef<((index?: number) => void) | undefined>(undefined);
  const surfaceActive = useContext(PopoverSurfaceContext);
  const documentSession = useContext(PopoverDocumentSessionContext);
  const documentSessionRef = useRef(documentSession);
  const active = useRef(false);
  const docId = e.committed.id;
  const selectionKey = JSON.stringify(e.selection);
  // The typography inspector supplies text layers and editable button labels.
  const targetIds = nodes.map((n) => n.id).sort();
  const sequence = useRef(0);
  function captureTarget() {
    return { tokenId: ++sequence.current, docId, targetIds, documentSession };
  }
  const pendingChooserRef = useRef<ReturnType<typeof captureTarget> | null>(
    null,
  );
  // An invalidated native dialog can still deliver a change after reactivation.
  const awaitingChooser = useRef(false);
  const pending = useRef<{ owner: string; controller: AbortController } | null>(
    null,
  );
  function cancelImport() {
    if (pending.current) {
      pending.current.controller.abort();
      releaseDocumentFonts(pending.current.owner);
      pending.current = null;
    }
    picker.current?.();
  }
  useLayoutEffect(() => {
    documentSessionRef.current = documentSession;
    active.current = surfaceActive;
    const field = input.current;
    const dismissChooser = () => {
      awaitingChooser.current = false;
      pendingChooserRef.current = null;
    };
    field?.addEventListener("cancel", dismissChooser);
    setChoices(undefined);
    return () => {
      field?.removeEventListener("cancel", dismissChooser);
      active.current = false;
      pendingChooserRef.current = null;
      cancelImport();
    };
  }, [surfaceActive, docId, selectionKey, documentSession]);
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
          value={!sharedFamily ? "mixed" : (family ?? "")}
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
          {family && !asset && <option value={family}>{family}</option>}
          {Object.entries(e.doc.fonts ?? {}).map(([id, f]) => (
            <option key={id} value={id}>
              {f.name}
            </option>
          ))}
        </select>
        <button
          className="icon-btn icon-btn-sm"
          disabled={locked || !!choices}
          aria-label="导入字体"
          data-tip="导入字体"
          data-tip-desc="导入 TTF、OTF、TTC、WOFF 或 WOFF2 字体，嵌入设计文件与 React 导出工程"
          data-tip-side="left"
          onClick={() => {
            if (!input.current || !active.current) return;
            cancelImport();
            pendingChooserRef.current = captureTarget();
            awaitingChooser.current = true;
            input.current.click();
          }}
        >
          <Upload size={14} />
        </button>
        <input
          hidden
          ref={input}
          type="file"
          accept=".ttf,.otf,.ttc,.otc,.woff,.woff2"
          onChange={async (ev) => {
            const file = ev.target.files?.[0];
            ev.target.value = "";
            const target = awaitingChooser.current
              ? pendingChooserRef.current
              : captureTarget();
            awaitingChooser.current = false;
            pendingChooserRef.current = null;
            if (
              !file ||
              !active.current ||
              !target ||
              documentSessionRef.current !== target.documentSession ||
              target.docId !== e.historyRef.current.present.id ||
              target.docId !== docId ||
              !targetIds.length ||
              target.targetIds.length !== targetIds.length ||
              target.targetIds.some((id, i) => id !== targetIds[i])
            )
              return;
            cancelImport();
            setChoices(undefined);
            const job = {
              owner: "import-pending:" + crypto.randomUUID(),
              controller: new AbortController(),
            };
            pending.current = job;
            const signal = job.controller.signal;
            const doc = e.historyRef.current.present;
            const current = () =>
              active.current &&
              !signal.aborted &&
              documentSessionRef.current === target.documentSession &&
              sequence.current === target.tokenId &&
              e.historyRef.current.present.id === target.docId;
            try {
              const weight = nodes[0].style.fontWeight ?? 400;
              const italic = nodes[0].style.fontStyle === "italic";
              const shared = nodes.every(
                (n) =>
                  (n.style.fontWeight ?? 400) === weight &&
                  (n.style.fontStyle === "italic") === italic,
              );
              const { id, asset } = await readFont(
                file,
                {
                  ...(shared ? { weight, italic } : {}),
                  chooseFace: (faces) =>
                    new Promise((resolve, reject) => {
                      if (!current()) {
                        reject(new DOMException("已取消", "AbortError"));
                        return;
                      }
                      picker.current?.();
                      picker.current = (index) => {
                        picker.current = undefined;
                        if (index === undefined)
                          reject(new DOMException("已取消", "AbortError"));
                        else resolve(index);
                      };
                      setChoices(faces);
                    }),
                },
                { owner: job.owner, signal },
              );
              if (!current()) return;
              // Commit the document owner before releasing the temporary registration.
              flushSync(() =>
                e.apply(
                  [
                    { type: "putFont", id, font: asset },
                    ...target.targetIds.map((nodeId) => ({
                      type: "update" as const,
                      id: nodeId,
                      patch: {},
                      style: {
                        fontFamily: id,
                        fontVariationSettings: undefined,
                      },
                    })),
                  ],
                  doc.revision,
                ),
              );
            } catch (err) {
              if (
                !current() ||
                (err instanceof DOMException && err.name === "AbortError")
              )
                return;
              e.setError(err instanceof Error ? err.message : String(err));
            } finally {
              releaseDocumentFonts(job.owner);
              if (pending.current === job) pending.current = null;
            }
          }}
        />
      </div>
      {choices && (
        <label className="mode-row">
          <span>字体集字面</span>
          <select
            aria-label="选择字体集字面"
            value=""
            onChange={(ev) => {
              const value = ev.currentTarget.value;
              setChoices(undefined);
              picker.current?.(value === "cancel" ? undefined : Number(value));
            }}
          >
            <option value="" disabled>
              选择字面…
            </option>
            {choices.map((face) => (
              <option key={face.faceIndex} value={face.faceIndex}>
                {face.family} · {face.weight}
                {face.italic ? " 斜体" : ""} · #{face.faceIndex + 1}
              </option>
            ))}
            <option value="cancel">取消导入</option>
          </select>
        </label>
      )}
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
