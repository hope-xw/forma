import { displayColor, type ColorProfile } from "../domain/color-profile";
import { typeSettings, validFontSettings } from "../domain/font-settings";
import {
  createContext,
  useContext,
  useRef,
  useState,
  useLayoutEffect,
} from "react";
import {
  Bold,
  Italic,
  Underline,
  Strikethrough,
  Check,
  RemoveFormatting,
  CaseSensitive,
} from "lucide-react";
import { createPortal } from "react-dom";
import type { DesignNode } from "../domain/document";
import {
  replaceText,
  formatRange,
  textParts,
  type TextDraft,
  type InlineStyle,
} from "../domain/rich-text";
import type { EditorController } from "./useEditor";

type RangeOffsets = [number, number];
function offsets(el: HTMLElement): RangeOffsets | null {
  const selection = window.getSelection();
  if (!selection?.rangeCount) return null;
  const r = selection.getRangeAt(0);
  if (!el.contains(r.startContainer) || !el.contains(r.endContainer))
    return null;
  const prefix = r.cloneRange();
  prefix.selectNodeContents(el);
  prefix.setEnd(r.startContainer, r.startOffset);
  return [
    prefix.toString().length,
    prefix.toString().length + r.toString().length,
  ];
}
function paint(
  el: HTMLElement,
  draft: TextDraft,
  [from, to]: RangeOffsets,
  profile?: ColorProfile,
) {
  const runNodes = textParts(draft).map((p) => {
    const span = document.createElement("span");
    Object.assign(span.style, p.style, {
      color: p.style.color ? displayColor(p.style.color, profile) : "",
      letterSpacing:
        p.style.letterSpacing === undefined ? "" : p.style.letterSpacing + "px",
      fontSize: p.style.fontSize ? p.style.fontSize + "px" : "",
    });
    span.textContent = p.text;
    return span;
  });
  el.replaceChildren(...runNodes);
  // A contenteditable needs a caret stop on the empty final line. A <br>
  // contributes no characters to the saved text or rich-text offsets.
  if (!draft.text || draft.text.endsWith("\n"))
    el.append(document.createElement("br"));
  const r = document.createRange();
  r.selectNodeContents(el);
  r.collapse(true);
  let offset = 0;
  for (const span of runNodes) {
    const text = span.firstChild;
    if (!text) continue;
    const end = offset + (text.textContent ?? "").length;
    if (from >= offset && from <= end) r.setStart(text, from - offset);
    if (to >= offset && to <= end) r.setEnd(text, to - offset);
    offset = end;
  }
  const s = window.getSelection();
  s?.removeAllRanges();
  s?.addRange(r);
}
export const InlineTextContext = createContext<EditorController | null>(null);

export function InlineText({ node }: { node: DesignNode }) {
  const e = useContext(InlineTextContext)!;
  const [toolbarHost, setToolbarHost] = useState<HTMLElement | null>(null);
  const input = useRef<HTMLSpanElement>(null),
    toolbar = useRef<HTMLDivElement>(null);
  const draft = useRef<TextDraft>({ text: node.text, textRuns: node.textRuns });
  const range = useRef<RangeOffsets>([0, node.text.length]),
    finished = useRef(false),
    composing = useRef(false);
  const past = useRef<TextDraft[]>([]),
    future = useRef<TextDraft[]>([]);
  const [selected, setSelected] = useState(!!node.text.length);
  const [typeOptions, setTypeOptions] = useState(false);
  const [activeMarks, setActiveMarks] = useState<{
    bold: boolean;
    italic: boolean;
    underline: boolean;
    strike: boolean;
  }>({ bold: false, italic: false, underline: false, strike: false });
  function computeMarks(r: RangeOffsets) {
    const [a, b] = r;
    if (a === b)
      return { bold: false, italic: false, underline: false, strike: false };
    const overlapping = (draft.current.textRuns ?? []).filter(
      (run) => run.end > a && run.start < b,
    );
    const run = overlapping.find(
      (run) => run.start <= a && run.end >= b,
    )?.style;
    const weight = run?.fontWeight ?? node.style.fontWeight ?? 400;
    const dec = new Set((run?.textDecoration ?? "").split(" ").filter(Boolean));
    return {
      bold: weight >= 600,
      italic: run?.fontStyle === "italic",
      underline: dec.has("underline"),
      strike: dec.has("line-through"),
    };
  }
  function remember() {
    if (input.current) {
      const r = offsets(input.current);
      if (r) {
        range.current = r;
        setSelected(r[0] !== r[1]);
        setActiveMarks(computeMarks(r));
      }
    }
  }
  useLayoutEffect(() => {
    const el = input.current!;
    setToolbarHost(el.closest<HTMLElement>(".editor-canvas"));
    el.focus({ preventScroll: true });
    paint(el, draft.current, range.current, e.doc.colorProfile);
    document.addEventListener("selectionchange", remember);
    return () => document.removeEventListener("selectionchange", remember);
  }, []);
  function update(next: TextDraft, r: RangeOffsets, record = true) {
    const el = input.current;
    if (!el) return;
    if (next.text.length > 50000) {
      paint(el, draft.current, range.current, e.doc.colorProfile);
      e.setError("文本超过 50000 字符");
      return;
    }
    if (record && next !== draft.current) {
      past.current.push(draft.current);
      if (past.current.length > 100) past.current.shift();
      future.current = [];
    }
    draft.current = next;
    range.current = r;
    el.focus({ preventScroll: true });
    paint(el, next, r, e.doc.colorProfile);
    setSelected(r[0] !== r[1]);
    setActiveMarks(computeMarks(r));
  }
  function sync() {
    if (!input.current || composing.current) return;
    const r = offsets(input.current) ?? range.current;
    const text = input.current.textContent ?? "";
    update(replaceText(draft.current, text), r);
  }
  function insert(text: string) {
    const [a, b] = offsets(input.current!) ?? range.current;
    update(
      replaceText(
        draft.current,
        draft.current.text.slice(0, a) + text + draft.current.text.slice(b),
      ),
      [a + text.length, a + text.length],
    );
  }
  function format(patch: InlineStyle) {
    const [a, b] = range.current;
    if (a !== b) update(formatRange(draft.current, a, b, patch), [a, b]);
  }
  function toggle(kind: "bold" | "italic" | "underline" | "line-through") {
    const [a, b] = range.current,
      parts = draft.current.textRuns ?? [];
    const attr =
      kind === "bold"
        ? "fontWeight"
        : kind === "italic"
          ? "fontStyle"
          : "textDecoration";
    const current = parts.find((r) => r.start <= a && r.end >= b)?.style;
    if (kind === "bold")
      format({
        fontWeight:
          (current?.fontWeight ?? node.style.fontWeight ?? 400) >= 600
            ? 400
            : 700,
      });
    else if (kind === "italic")
      format({ fontStyle: current?.fontStyle ? undefined : "italic" });
    else {
      const next = new Set(current?.textDecoration?.split(" ") ?? []);
      if (next.has(kind)) next.delete(kind);
      else next.add(kind);
      format({
        [attr]:
          ["underline", "line-through"].filter((s) => next.has(s)).join(" ") ||
          undefined,
      });
    }
  }
  function finish(cancel = false) {
    if (finished.current) return;
    finished.current = true;
    if (
      !cancel &&
      (draft.current.text !== node.text ||
        JSON.stringify(draft.current.textRuns) !==
          JSON.stringify(node.textRuns))
    )
      e.attempt(() =>
        e.apply([
          {
            type: "update",
            id: node.id,
            patch: {
              text: draft.current.text,
              textRuns: draft.current.textRuns,
            },
          },
        ]),
      );
    e.setEditing(null);
  }
  const blur = (to: EventTarget | null) => {
    if (
      to instanceof Node &&
      (input.current?.contains(to) || toolbar.current?.contains(to))
    )
      return;
    finish();
  };
  const s = node.style;
  const applyFamily = (raw: string) => {
    const family = raw.trim();
    if (family)
      format({
        fontFamily:
          Object.entries(e.doc.fonts ?? {}).find(
            ([, font]) => font.name === family,
          )?.[0] ?? family,
      });
  };
  const applyTypeSetting = (
    key: "fontVariationSettings" | "fontFeatureSettings",
    example: string,
    target: HTMLInputElement,
  ) => {
    const v = target.value.trim();
    if (!v || validFontSettings(v, key === "fontVariationSettings")) {
      target.setCustomValidity("");
      format({ [key]: v || undefined });
    } else {
      target.setCustomValidity("示例：" + example);
      target.reportValidity();
    }
  };
  const applyLetterSpacing = (target: HTMLInputElement) => {
    if (target.validity.valid)
      format({
        letterSpacing: target.value ? target.valueAsNumber : undefined,
      });
  };
  const applyFontSize = (target: HTMLInputElement) => {
    if (!target.value) return;
    const n = target.valueAsNumber;
    if (n >= 1 && n <= 500) format({ fontSize: n });
  };
  return (
    <>
      <span
        role="textbox"
        aria-multiline="true"
        aria-label="画布文本编辑"
        contentEditable
        suppressContentEditableWarning
        ref={input}
        className="inline-text-editor"
        style={
          node.style.leadingTrim === "cap"
            ? {
                display: "block",
                textBoxTrim: "trim-both",
                textBoxEdge: "cap alphabetic",
              }
            : undefined
        }
        onPointerDown={(ev) => ev.stopPropagation()}
        onDoubleClick={(ev) => ev.stopPropagation()}
        onInput={sync}
        onCompositionStart={() => {
          composing.current = true;
        }}
        onCompositionEnd={() => {
          composing.current = false;
          sync();
        }}
        onPaste={(ev) => {
          ev.preventDefault();
          insert(ev.clipboardData.getData("text/plain"));
        }}
        onDrop={(ev) => ev.preventDefault()}
        onBlur={(ev) => blur(ev.relatedTarget)}
        onKeyDown={(ev) => {
          ev.stopPropagation();
          if (ev.nativeEvent.isComposing) return;
          const mod = ev.metaKey || ev.ctrlKey,
            k = ev.key.toLowerCase();
          if (k === "escape") {
            ev.preventDefault();
            finish(false);
          }
          if (k === "enter") {
            ev.preventDefault();
            if (mod) finish();
            else insert("\n");
          }
          if (mod && ["b", "i", "u"].includes(k)) {
            ev.preventDefault();
            remember();
            toggle(k === "b" ? "bold" : k === "i" ? "italic" : "underline");
          }
          if (mod && ev.shiftKey && k === "x") {
            ev.preventDefault();
            remember();
            toggle("line-through");
          }
          if (mod && k === "z") {
            ev.preventDefault();
            const src = ev.shiftKey ? future : past,
              dst = ev.shiftKey ? past : future,
              next = src.current.pop();
            if (next) {
              dst.current.push(draft.current);
              const caret = Math.min(range.current[1], next.text.length);
              update(next, [caret, caret], false);
            }
          }
        }}
      />
      {toolbarHost &&
        createPortal(
          <div
            ref={toolbar}
            className="vector-tools text-tools"
            onPointerDownCapture={remember}
            onPointerDown={(ev) => ev.stopPropagation()}
            onBlur={(ev) => blur(ev.relatedTarget)}
          >
            {(
              [
                [Bold, "局部加粗", "bold", "⌘B", activeMarks.bold],
                [Italic, "局部斜体", "italic", "⌘I", activeMarks.italic],
                [
                  Underline,
                  "局部下划线",
                  "underline",
                  "⌘U",
                  activeMarks.underline,
                ],
                [
                  Strikethrough,
                  "局部删除线",
                  "line-through",
                  "⇧⌘X",
                  activeMarks.strike,
                ],
              ] as const
            ).map(([Icon, label, kind, kbd, pressed]) => (
              <button
                key={kind}
                className="icon-btn icon-btn-sm"
                title={label}
                aria-label={label}
                aria-pressed={pressed}
                data-tip={label}
                data-tip-kbd={kbd || undefined}
                data-tip-desc={!selected ? "请先拖选一段文字" : undefined}
                data-tip-side="bottom"
                disabled={!selected}
                onMouseDown={(ev) => ev.preventDefault()}
                onClick={() => toggle(kind)}
              >
                <Icon size={14} />
              </button>
            ))}
            <button
              className="icon-btn icon-btn-sm"
              title="选区字体设置"
              aria-label="选区字体设置"
              data-tip="选区字体设置"
              aria-expanded={typeOptions}
              aria-pressed={typeOptions}
              disabled={!selected}
              onMouseDown={(ev) => ev.preventDefault()}
              onClick={() => setTypeOptions((v) => !v)}
            >
              <CaseSensitive size={16} />
            </button>
            {typeOptions && (
              <div className="inline-type-options">
                <label>
                  字体
                  <input
                    aria-label="选区字体族"
                    maxLength={200}
                    list="inline-font-families"
                    placeholder={s.fontFamily ?? "system-ui"}
                    onBlur={(ev) => applyFamily(ev.currentTarget.value)}
                    onKeyDown={(ev) => {
                      if (ev.key !== "Enter") return;
                      ev.preventDefault();
                      ev.stopPropagation();
                      applyFamily(ev.currentTarget.value);
                    }}
                  />
                </label>
                {typeSettings.map(({ key, label, example }) => (
                  <label key={key}>
                    {label}
                    <input
                      aria-label={"选区" + label}
                      placeholder={example}
                      onBlur={(ev) =>
                        applyTypeSetting(key, example, ev.currentTarget)
                      }
                      onKeyDown={(ev) => {
                        if (ev.key !== "Enter") return;
                        ev.preventDefault();
                        ev.stopPropagation();
                        applyTypeSetting(key, example, ev.currentTarget);
                      }}
                      onInput={(ev) => ev.currentTarget.setCustomValidity("")}
                    />
                  </label>
                ))}
                <label>
                  字距
                  <input
                    aria-label="选区字距"
                    type="number"
                    step="0.1"
                    min="-100"
                    max="500"
                    onBlur={(ev) => applyLetterSpacing(ev.currentTarget)}
                    onKeyDown={(ev) => {
                      if (ev.key === "Enter") {
                        ev.preventDefault();
                        ev.stopPropagation();
                        applyLetterSpacing(ev.currentTarget);
                      }
                    }}
                  />
                </label>
                <datalist id="inline-font-families">
                  {[
                    ...Object.values(e.doc.fonts ?? {}).map((f) => f.name),
                    "system-ui",
                    "sans-serif",
                    "serif",
                    "monospace",
                  ].map((f) => (
                    <option key={f} value={f} />
                  ))}
                </datalist>
                <label>
                  字重
                  <select
                    aria-label="选区字重"
                    defaultValue=""
                    onChange={(ev) =>
                      format({ fontWeight: Number(ev.target.value) })
                    }
                  >
                    <option value="" disabled>
                      选择字重
                    </option>
                    {[100, 200, 300, 400, 500, 600, 700, 800, 900].map((n) => (
                      <option key={n} value={n}>
                        {n}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            )}
            <input
              aria-label="选区字号"
              title="选区字号"
              type="number"
              min="1"
              max="500"
              disabled={!selected}
              placeholder={String(s.fontSize)}
              onBlur={(ev) => applyFontSize(ev.currentTarget)}
              onKeyDown={(ev) => {
                if (ev.key === "Enter") {
                  ev.preventDefault();
                  ev.stopPropagation();
                  applyFontSize(ev.currentTarget);
                }
              }}
            />
            <input
              type="color"
              aria-label="选区文字颜色"
              title="选区文字颜色"
              defaultValue={s.color}
              disabled={!selected}
              onChange={(ev) => format({ color: ev.target.value })}
            />
            <button
              className="icon-btn icon-btn-sm"
              title="清除局部格式"
              aria-label="清除局部格式"
              data-tip="清除局部格式"
              disabled={!selected}
              onMouseDown={(ev) => ev.preventDefault()}
              onClick={() =>
                format({
                  fontWeight: undefined,
                  fontStyle: undefined,
                  textDecoration: undefined,
                  fontSize: undefined,
                  color: undefined,
                  fontFamily: undefined,
                  fontVariationSettings: undefined,
                  fontFeatureSettings: undefined,
                  letterSpacing: undefined,
                })
              }
            >
              <RemoveFormatting size={14} />
            </button>
            <button
              className="icon-btn icon-btn-sm"
              title="提交文字"
              aria-label="提交文字"
              data-tip="提交文字"
              data-tip-kbd="Esc / ⌘↵"
              onMouseDown={(ev) => ev.preventDefault()}
              onClick={() => finish()}
            >
              <Check size={14} />
            </button>
          </div>,
          toolbarHost,
        )}
    </>
  );
}
