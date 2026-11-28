import { convertColor, displayColor } from "../domain/color-profile";
import { FileColorContext } from "./ColorProfileDialog";
import {
  type FocusEvent,
  type KeyboardEvent,
  type PointerEvent,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { Pipette, X } from "lucide-react";
import {
  hexToHsv,
  hsvToHex,
  hexToRgb,
  hexToHsl,
  parseColorInput,
  type HSV,
} from "../domain/color";
import {
  PopoverDocumentSessionContext,
  PopoverSurfaceContext,
  useAnchoredPopover,
} from "./useAnchoredPopover";
import { useModalDialog } from "./useModalDialog";
import { contrastRatio, wcagGrade } from "../domain/design-lint";
export type PaintChannel = "color" | "alpha" | "both";
function compositeOver(fgHex: string, fgAlpha: number, bgHex: string): string {
  const a = Math.max(0, Math.min(1, fgAlpha));
  if (a >= 0.999) return fgHex;
  const [fr, fg, fb] = hexToRgb(fgHex);
  const [br, bg, bb] = hexToRgb(bgHex);
  const r = Math.round(fr * a + br * (1 - a));
  const g = Math.round(fg * a + bg * (1 - a));
  const b = Math.round(fb * a + bb * (1 - a));
  return "#" + [r, g, b].map((n) => n.toString(16).padStart(2, "0")).join("");
}
interface Props {
  onCancelPreview?(): void;
  label: string;
  color: string;
  alpha?: number;
  allowAlpha?: boolean;
  mixedColor?: boolean;
  mixedAlpha?: boolean;
  contrastAgainst?: string;
  onChange(color: string, alpha: number, channel: PaintChannel): void;
  onPreview?(color: string, alpha: number, channel: PaintChannel): void;
  palette?: string[] | (() => string[]);
  disabled?: boolean;
  previewDisabled?: boolean;
}
export function ColorField({
  label,
  color,
  alpha = 1,
  allowAlpha = true,
  mixedColor = false,
  mixedAlpha = false,
  contrastAgainst,
  onChange,
  onPreview,
  onCancelPreview,
  palette = [],
  disabled: controlDisabled,
  previewDisabled = false,
}: Props) {
  const disabled = Boolean(controlDisabled || previewDisabled);
  const profile = useContext(FileColorContext);
  const [fallbackBg, setFallbackBg] = useState<"#ffffff" | "#1e1e1e">(() =>
    typeof document !== "undefined" &&
    document.documentElement.dataset.theme === "dark"
      ? "#1e1e1e"
      : "#ffffff",
  );
  const effectiveContrastBg =
    contrastAgainst && /^#[0-9a-f]{6}$/i.test(contrastAgainst)
      ? contrastAgainst
      : fallbackBg;
  const displayHex = mixedColor ? "" : color.slice(1).toUpperCase();
  const [inline, setInline] = useState(displayHex);
  const [alphaDraft, setAlphaDraft] = useState(
    mixedAlpha ? "" : String(Math.round(alpha * 100)),
  );
  const [session, setSession] = useState<number | null>(null),
    [draft, setDraft] = useState(color),
    [opacity, setOpacity] = useState(alpha),
    [hsv, setHsv] = useState(() => hexToHsv(color)),
    [model, setModel] = useState<"HEX" | "RGB" | "HSL" | "HSB" | "CSS">("HEX"),
    [input, setInput] = useState(color),
    [invalid, setInvalid] = useState(false);
  const surfaceActive = useContext(PopoverSurfaceContext);
  const surfaceActiveRef = useRef(surfaceActive);
  const docSession = useContext(PopoverDocumentSessionContext);
  const docSessionRef = useRef(docSession);
  const blockedRef = useRef(disabled);
  const open =
    session !== null &&
    surfaceActive &&
    !disabled &&
    docSessionRef.current === docSession;
  const openRef = useRef(false);
  const pickerSessionRef = useRef(0);
  useLayoutEffect(() => {
    const documentChanged = docSessionRef.current !== docSession;
    docSessionRef.current = docSession;
    openRef.current = open;
    surfaceActiveRef.current = surfaceActive;
    if (documentChanged || (!open && session !== null)) {
      pickerSessionRef.current++;
      if (documentChanged) releaseSlider();
      setSession(null);
    }
    return () => {
      openRef.current = false;
    };
  }, [open, surfaceActive, session, docSession]);
  const closePicker = () => {
    pickerSessionRef.current++;
    openRef.current = false;
    setSession(null);
  };
  const modal = useModalDialog(open, closePicker, true, {
    restoreFocus: false,
  });
  const currentField = () =>
    docSession === docSessionRef.current &&
    surfaceActiveRef.current &&
    !blockedRef.current;
  const currentPicker = () =>
    currentField() &&
    openRef.current &&
    session === pickerSessionRef.current &&
    Boolean(modal.current?.isConnected);
  function inPicker<E>(handler: (event: E) => void) {
    return (event: E) => {
      if (currentPicker()) handler(event);
    };
  }
  const button = useRef<HTMLButtonElement>(null);
  const { onDragPointerDown } = useAnchoredPopover({
    open,
    triggerRef: button,
    popoverRef: modal,
    preferredSide: "left",
    draggable: true,
    onClose: closePicker,
  });
  const sliderDragging = useRef<{
    pointerId: number;
    target: HTMLElement;
    channel: "color" | "alpha";
    color: string;
    alpha: number;
    hsv: HSV;
  } | null>(null);
  const releaseSlider = () => {
    const drag = sliderDragging.current;
    sliderDragging.current = null;
    if (drag?.target.hasPointerCapture(drag.pointerId))
      drag.target.releasePointerCapture(drag.pointerId);
    return drag;
  };
  const cancelRef = useRef(onCancelPreview);
  useLayoutEffect(() => {
    cancelRef.current = onCancelPreview;
    blockedRef.current = disabled;
    if (disabled) releaseSlider();
  }, [disabled, onCancelPreview]);
  const cancelSlider = () => {
    if (releaseSlider() && !blockedRef.current) cancelRef.current?.();
  };
  useEffect(() => {
    if (open) return cancelSlider;
  }, [open]);
  const latest = useRef({ color: draft, alpha: opacity });
  latest.current = { color: draft, alpha: opacity };
  useLayoutEffect(() => {
    setInline(displayHex);
    setDraft(color);
    setOpacity(alpha);
    setAlphaDraft(mixedAlpha ? "" : String(Math.round(alpha * 100)));
    setHsv(hexToHsv(color));
  }, [color, alpha, displayHex, mixedAlpha, open, docSession]);
  const displayValue = mixedColor
    ? ""
    : model === "HEX"
      ? draft.slice(1).toUpperCase()
      : model === "RGB"
        ? hexToRgb(draft).join(", ")
        : model === "HSL"
          ? hexToHsl(draft).join(", ")
          : model === "HSB"
            ? `${Math.round(hsv.h)}, ${Math.round(hsv.s * 100)}%, ${Math.round(hsv.v * 100)}%`
            : opacity < 1
              ? `rgba(${hexToRgb(draft).join(", ")}, ${Math.round(opacity * 100) / 100})`
              : `rgb(${hexToRgb(draft).join(", ")})`;
  useLayoutEffect(() => {
    setInput(displayValue);
    setInvalid(false);
  }, [displayValue, model, open]);
  const change = (
    hex: string,
    a = opacity,
    commit = true,
    channel: PaintChannel = "color",
  ) => {
    if (!currentField()) return;
    setDraft(hex);
    setOpacity(a);
    setAlphaDraft(String(Math.round(a * 100)));
    latest.current = { color: hex, alpha: a };
    if (commit) onChange(hex, a, channel);
    else onPreview?.(hex, a, channel);
  };
  const beginSlider = (
    ev: PointerEvent<HTMLElement>,
    channel: "color" | "alpha",
  ) => {
    if (sliderDragging.current || blockedRef.current) return false;
    sliderDragging.current = {
      pointerId: ev.pointerId,
      target: ev.currentTarget,
      channel,
      color: draft,
      alpha: opacity,
      hsv,
    };
    ev.currentTarget.setPointerCapture(ev.pointerId);
    return true;
  };
  const isDragging = (ev: PointerEvent<HTMLElement>) =>
    sliderDragging.current?.target === ev.currentTarget &&
    sliderDragging.current.pointerId === ev.pointerId;
  const finishSlider = (ev: PointerEvent<HTMLElement>) => {
    if (!isDragging(ev)) return;
    const drag = releaseSlider()!;
    if (!blockedRef.current)
      onChange(latest.current.color, latest.current.alpha, drag.channel);
  };
  const interruptSlider = (ev: PointerEvent<HTMLElement>) => {
    if (!isDragging(ev)) return;
    const drag = sliderDragging.current!;
    cancelSlider();
    setDraft(drag.color);
    setOpacity(drag.alpha);
    setAlphaDraft(mixedAlpha ? "" : String(Math.round(drag.alpha * 100)));
    setHsv(drag.hsv);
  };
  const sliderEndEvents = {
    onPointerUp: inPicker(finishSlider),
    onPointerCancel: inPicker(interruptSlider),
    onLostPointerCapture: inPicker(interruptSlider),
  };
  const storedOpacity = mixedAlpha ? "" : String(Math.round(alpha * 100));
  const commitOpacity = (ev: FocusEvent<HTMLInputElement>) => {
    if (!currentField()) return;
    const raw = ev.currentTarget.value.trim();
    const percent = Number(raw);
    if (
      raw &&
      Number.isInteger(percent) &&
      percent >= 0 &&
      percent <= 100 &&
      !disabled
    ) {
      if (String(percent) !== storedOpacity)
        change(open ? draft : color, percent / 100, true, "alpha");
      ev.currentTarget.value = String(percent);
      setAlphaDraft(String(percent));
    } else {
      ev.currentTarget.value = storedOpacity;
      setAlphaDraft(storedOpacity);
    }
  };
  const opacityKeyDown = (ev: KeyboardEvent<HTMLInputElement>) => {
    if (
      ev.nativeEvent.isComposing ||
      (ev.key !== "Enter" && ev.key !== "Escape")
    )
      return;
    ev.preventDefault();
    ev.stopPropagation();
    if (ev.key === "Escape") {
      ev.currentTarget.value = storedOpacity;
      setAlphaDraft(storedOpacity);
    }
    ev.currentTarget.blur();
  };
  const fromHsv = (next: HSV, commit = false) => {
    setHsv(next);
    change(hsvToHex(next), opacity, commit);
  };
  const commitHexAlpha = (value: string) => {
    const match =
      allowAlpha && value.trim().match(/^#?([0-9a-f]{6})([0-9a-f]{2})$/i);
    if (!match) return false;
    const hex = "#" + match[1].toLowerCase();
    setHsv(hexToHsv(hex));
    setInline(match[1].toUpperCase());
    change(hex, parseInt(match[2], 16) / 255, true, "both");
    setInvalid(false);
    return true;
  };
  const commitInput = () => {
    if (input === displayValue) return;
    if ((model === "CSS" || model === "HEX") && commitHexAlpha(input)) return;
    let hex: string | null = null;
    if (model === "HSB") {
      const m = input
        .trim()
        .match(
          /^(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)%?\s*,\s*(\d+(?:\.\d+)?)%?$/,
        );
      if (m) {
        const h = ((Number(m[1]) % 360) + 360) % 360;
        const s = Math.max(0, Math.min(100, Number(m[2]))) / 100;
        const v = Math.max(0, Math.min(100, Number(m[3]))) / 100;
        hex = hsvToHex({ h, s, v });
      }
    } else if (model === "CSS") {
      const rgbaMatch = input
        .trim()
        .match(
          /^rgba?\(\s*(\d+)\s*[,\s]\s*(\d+)\s*[,\s]\s*(\d+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/i,
        );
      if (rgbaMatch) {
        hex = parseColorInput(
          `${rgbaMatch[1]}, ${rgbaMatch[2]}, ${rgbaMatch[3]}`,
          "RGB",
        );
        if (hex && rgbaMatch[4] && allowAlpha) {
          const rawA = rgbaMatch[4].endsWith("%")
            ? Number(rgbaMatch[4].slice(0, -1)) / 100
            : Number(rgbaMatch[4]);
          if (Number.isFinite(rawA)) {
            const clampedA = Math.max(0, Math.min(1, rawA));
            setHsv(hexToHsv(hex));
            change(hex, clampedA, true, "both");
            setInvalid(false);
            return;
          }
        }
      } else {
        hex = parseColorInput(input, "HEX");
      }
    } else {
      hex = parseColorInput(input, model);
    }
    setInvalid(!hex);
    if (hex) {
      setHsv(hexToHsv(hex));
      change(hex);
    }
  };
  const sample = async () => {
    const Eye = (
      window as unknown as {
        EyeDropper?: new () => { open(): Promise<{ sRGBHex: string }> };
      }
    ).EyeDropper;
    if (!Eye || !currentPicker()) return;
    try {
      const result = await new Eye().open();
      if (!currentPicker()) return;
      const hex = convertColor(result.sRGBHex, "srgb", profile);
      setHsv(hexToHsv(hex));
      change(hex);
    } catch {
      /* User cancelled the native picker. */
    }
  };
  return (
    <div className="paint-field">
      <button
        ref={button}
        aria-expanded={open}
        aria-haspopup="dialog"
        className={`paint-swatch checker ${mixedColor ? "mixed-color" : ""}`}
        data-tip={`编辑${label}颜色`}
        disabled={disabled}
        aria-label={`编辑${label}颜色`}
        title={label}
        onClick={() => {
          if (open) closePicker();
          else if (currentField()) setSession(++pickerSessionRef.current);
        }}
      >
        {!mixedColor && (
          <i
            style={{ background: displayColor(color, profile), opacity: alpha }}
          />
        )}
      </button>
      <input
        aria-label={`${label} HEX`}
        disabled={disabled}
        placeholder={mixedColor ? "Mixed" : undefined}
        value={inline}
        onChange={(e) => setInline(e.target.value)}
        onBlur={(e) => {
          if (!currentField()) return;
          const value = e.currentTarget.value;
          if (value === displayHex || commitHexAlpha(value)) return;
          const hex = parseColorInput(value, "HEX");
          if (hex) {
            onChange(hex, alpha, "color");
            setInline(hex.slice(1).toUpperCase());
          } else setInline(displayHex);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
          if (e.key === "Escape") {
            e.currentTarget.value = displayHex;
            setInline(displayHex);
            e.currentTarget.blur();
          }
        }}
        onFocus={(e) => e.currentTarget.select()}
      />
      {allowAlpha && (
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            flexShrink: 0,
            paddingLeft: 4,
            borderLeft: "1px solid var(--border-subtle)",
          }}
        >
          <input
            type="number"
            className="paint-alpha-input"
            aria-label={`${label}不透明度`}
            title="不透明度 (%)"
            disabled={disabled}
            min={0}
            max={100}
            placeholder={mixedAlpha ? "Mix" : undefined}
            value={alphaDraft}
            onFocus={(e) => e.currentTarget.select()}
            onChange={(e) => setAlphaDraft(e.target.value)}
            onBlur={commitOpacity}
            onKeyDown={opacityKeyDown}
          />
          <span className="paint-alpha" aria-hidden="true">
            %
          </span>
        </span>
      )}
      {open &&
        createPortal(
          <div
            ref={modal}
            role="dialog"
            aria-modal="true"
            aria-label={`颜色 · ${label}`}
            className="color-popover"
          >
            <div
              className="panel-heading"
              onPointerDown={inPicker(onDragPointerDown)}
            >
              <strong>{label}</strong>
              <button
                className="icon-btn icon-btn-sm"
                aria-label="关闭颜色选择器"
                data-tip="关闭颜色选择器"
                data-tip-kbd="Esc"
                onClick={inPicker(closePicker)}
              >
                <X size={14} />
              </button>
            </div>
            <div className="color-popover-body">
              <div
                className="color-sv"
                role="slider"
                aria-label="饱和度与亮度"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(hsv.s * 100)}
                aria-valuetext={`${Math.round(hsv.s * 100)}%, ${Math.round(hsv.v * 100)}%`}
                tabIndex={0}
                style={{
                  backgroundColor: displayColor(
                    hsvToHex({ h: hsv.h, s: 1, v: 1 }),
                    profile,
                  ),
                }}
                onPointerDown={inPicker((e) => {
                  if (!beginSlider(e, "color")) return;
                  const r = e.currentTarget.getBoundingClientRect();
                  fromHsv({
                    ...hsv,
                    s: Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)),
                    v: Math.max(
                      0,
                      Math.min(1, 1 - (e.clientY - r.top) / r.height),
                    ),
                  });
                })}
                onPointerMove={inPicker((e) => {
                  if (!isDragging(e)) return;
                  const r = e.currentTarget.getBoundingClientRect();
                  fromHsv({
                    ...hsv,
                    s: Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)),
                    v: Math.max(
                      0,
                      Math.min(1, 1 - (e.clientY - r.top) / r.height),
                    ),
                  });
                })}
                {...sliderEndEvents}
                onKeyDown={inPicker((e) => {
                  if (
                    [
                      "ArrowLeft",
                      "ArrowRight",
                      "ArrowUp",
                      "ArrowDown",
                    ].includes(e.key)
                  ) {
                    e.preventDefault();
                    const step = e.shiftKey ? 0.1 : 0.01;
                    fromHsv(
                      {
                        ...hsv,
                        s: Math.max(
                          0,
                          Math.min(
                            1,
                            hsv.s +
                              (e.key === "ArrowRight"
                                ? step
                                : e.key === "ArrowLeft"
                                  ? -step
                                  : 0),
                          ),
                        ),
                        v: Math.max(
                          0,
                          Math.min(
                            1,
                            hsv.v +
                              (e.key === "ArrowUp"
                                ? step
                                : e.key === "ArrowDown"
                                  ? -step
                                  : 0),
                          ),
                        ),
                      },
                      true,
                    );
                  }
                })}
              >
                <span
                  style={{
                    left: `${hsv.s * 100}%`,
                    top: `${(1 - hsv.v) * 100}%`,
                    background: displayColor(draft, profile),
                  }}
                />
              </div>
              <div className="color-sliders">
                <button
                  title={
                    "EyeDropper" in window ? "吸管" : "当前浏览器不支持屏幕吸管"
                  }
                  aria-label="吸管"
                  data-tip={
                    "EyeDropper" in window ? "吸管" : "当前浏览器不支持屏幕吸管"
                  }
                  disabled={!("EyeDropper" in window)}
                  onClick={inPicker(sample)}
                >
                  <Pipette size={17} />
                </button>
                <div>
                  <input
                    className="hue-slider"
                    type="range"
                    aria-label="色相"
                    min="0"
                    max="359"
                    value={hsv.h}
                    onPointerDown={inPicker((ev) => beginSlider(ev, "color"))}
                    {...sliderEndEvents}
                    onChange={inPicker((e) =>
                      fromHsv(
                        { ...hsv, h: Number(e.target.value) },
                        sliderDragging.current?.target !== e.currentTarget,
                      ),
                    )}
                  />
                  <input
                    hidden={!allowAlpha}
                    className="alpha-slider"
                    style={{
                      backgroundImage: `linear-gradient(90deg,transparent,${displayColor(draft, profile)}), repeating-conic-gradient(#d4d4dc 0% 25%, #ffffff 0% 50%)`,
                      backgroundSize: "100% 100%, 8px 8px",
                    }}
                    type="range"
                    aria-label="颜色透明度"
                    min="0"
                    max="100"
                    value={Math.round(opacity * 100)}
                    onPointerDown={inPicker((ev) => beginSlider(ev, "alpha"))}
                    {...sliderEndEvents}
                    onChange={inPicker((e) =>
                      change(
                        draft,
                        Number(e.target.value) / 100,
                        sliderDragging.current?.target !== e.currentTarget,
                        "alpha",
                      ),
                    )}
                  />
                </div>
              </div>
              <div className="color-values">
                <select
                  aria-label="颜色模型"
                  value={model}
                  onChange={inPicker((e) => {
                    setModel(e.target.value as typeof model);
                    setInvalid(false);
                  })}
                >
                  {["HEX", "RGB", "HSL", "HSB", "CSS"].map((m) => (
                    <option key={m}>{m}</option>
                  ))}
                </select>
                <input
                  placeholder={mixedColor ? "Mixed" : undefined}
                  aria-label="颜色值"
                  aria-invalid={invalid}
                  value={input}
                  onChange={inPicker((e) => setInput(e.target.value))}
                  onBlur={inPicker(commitInput)}
                  onKeyDown={inPicker((e) => {
                    if (e.key === "Enter") commitInput();
                  })}
                />
                <input
                  type="number"
                  hidden={!allowAlpha}
                  aria-label="颜色不透明度百分比"
                  min="0"
                  max="100"
                  placeholder={mixedAlpha ? "Mixed" : undefined}
                  value={alphaDraft}
                  onChange={inPicker((e) =>
                    setAlphaDraft(e.currentTarget.value),
                  )}
                  data-escape-local
                  onBlur={inPicker(commitOpacity)}
                  onKeyDown={inPicker(opacityKeyDown)}
                />
              </div>
              <div
                className="color-contrast-bar"
                role="status"
                aria-label="WCAG 对比度检查"
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 6,
                  padding: "5px 8px",
                  borderRadius: 6,
                  background: "var(--bg-muted, rgba(128,128,128,0.08))",
                  border:
                    "1px solid var(--border-subtle, rgba(128,128,128,0.18))",
                  fontSize: 11,
                  marginTop: 6,
                }}
              >
                {(() => {
                  const background = convertColor(
                    effectiveContrastBg,
                    profile,
                    "srgb",
                  );
                  const effectiveFg = compositeOver(
                    convertColor(draft, profile, "srgb"),
                    allowAlpha ? opacity : 1,
                    background,
                  );
                  const { ratio, aa, aaa } = wcagGrade(
                    contrastRatio(effectiveFg, background),
                  );
                  return (
                    <>
                      <div
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          gap: 6,
                        }}
                      >
                        <button
                          type="button"
                          disabled={Boolean(contrastAgainst)}
                          title={
                            contrastAgainst
                              ? `对照背景 ${effectiveContrastBg.toUpperCase()}`
                              : "点击切换亮色/深色背景对比"
                          }
                          aria-label="对比度参照背景"
                          data-tip={
                            contrastAgainst
                              ? `对照背景 ${effectiveContrastBg.toUpperCase()}`
                              : "切换亮色/深色参照背景"
                          }
                          onClick={inPicker(() =>
                            setFallbackBg((b) =>
                              b === "#ffffff" ? "#1e1e1e" : "#ffffff",
                            ),
                          )}
                          style={{
                            width: 24,
                            height: 18,
                            borderRadius: 4,
                            border:
                              "1px solid var(--border-subtle, rgba(128,128,128,0.3))",
                            background,
                            color: effectiveFg,
                            fontSize: 10,
                            fontWeight: 700,
                            lineHeight: 1,
                            padding: 0,
                            display: "inline-grid",
                            placeItems: "center",
                            cursor: contrastAgainst ? "default" : "pointer",
                          }}
                        >
                          Aa
                        </button>
                        <span
                          style={{
                            fontVariantNumeric: "tabular-nums",
                            fontWeight: 600,
                            color: "var(--text-primary)",
                          }}
                        >
                          {ratio.toFixed(2)}:1
                        </span>
                      </div>
                      <div
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          gap: 4,
                        }}
                      >
                        <span
                          style={{
                            padding: "1px 5px",
                            borderRadius: 4,
                            fontSize: 10,
                            fontWeight: 600,
                            background: aa
                              ? "rgba(20, 174, 92, 0.16)"
                              : "rgba(242, 72, 34, 0.14)",
                            color: aa
                              ? "var(--figma-green, #14ae5c)"
                              : "var(--figma-danger, #f24822)",
                          }}
                        >
                          AA {aa ? "✓" : "✕"}
                        </span>
                        <span
                          style={{
                            padding: "1px 5px",
                            borderRadius: 4,
                            fontSize: 10,
                            fontWeight: 600,
                            background: aaa
                              ? "rgba(20, 174, 92, 0.16)"
                              : "rgba(128, 128, 128, 0.14)",
                            color: aaa
                              ? "var(--figma-green, #14ae5c)"
                              : "var(--text-muted, #888)",
                          }}
                        >
                          AAA {aaa ? "✓" : "✕"}
                        </span>
                      </div>
                    </>
                  );
                })()}
              </div>
              <div className="color-swatches">
                <span>文件颜色</span>
                <div>
                  {[
                    ...new Set([
                      color,
                      ...(typeof palette === "function" ? palette() : palette),
                      "#ffffff",
                      "#000000",
                    ]),
                  ]
                    .slice(0, 18)
                    .map((hex) => (
                      <button
                        key={hex}
                        aria-label={`使用颜色 ${hex}`}
                        title={hex}
                        data-tip={hex}
                        style={{ background: displayColor(hex, profile) }}
                        onClick={inPicker(() => {
                          setHsv(hexToHsv(hex));
                          change(hex);
                        })}
                      />
                    ))}
                </div>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
