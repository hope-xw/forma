import { createContext, useState } from "react";
import { X } from "lucide-react";
import {
  changeProfile,
  profileLabel,
  type ColorProfile,
} from "../domain/color-profile";
import type { DesignDocument } from "../domain/document";
import { useModalDialog } from "./useModalDialog";

export const FileColorContext = createContext<ColorProfile>("srgb");
const preferenceKey = "forma.preferred-color-profile";
export function preferredProfile(): ColorProfile {
  return localStorage.getItem(preferenceKey) === "display-p3"
    ? "display-p3"
    : "srgb";
}
export function ColorProfileDialog({
  doc,
  save,
  close,
}: {
  doc: DesignDocument;
  save: (doc: DesignDocument) => void;
  close: () => void;
}) {
  const current = doc.colorProfile ?? "srgb";
  const [target, setTarget] = useState(current);
  const [mode, setMode] = useState<"assign" | "convert">("assign");
  const [output, setOutput] = useState(doc.exportColorProfile ?? "file");
  const [preferred, setPreferred] = useState(preferredProfile);
  const ref = useModalDialog(true, close);
  const supportsP3 =
    typeof window !== "undefined" &&
    window.matchMedia?.("(color-gamut: p3)").matches;
  const dirty =
    current !== target ||
    output !== (doc.exportColorProfile ?? "file") ||
    preferred !== preferredProfile();
  const options = (
    <>
      <option value="srgb">sRGB</option>
      <option value="display-p3">Display P3</option>
    </>
  );
  return (
    <div
      className="modal-backdrop"
      onPointerDown={(ev) => {
        if (ev.target === ev.currentTarget) close();
      }}
    >
      <div
        className="file-browser profile-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="颜色配置"
        tabIndex={-1}
        ref={ref}
      >
        <div className="panel-heading">
          <strong>颜色配置</strong>
          <button
            type="button"
            className="icon-btn icon-btn-sm"
            aria-label="关闭颜色配置"
            data-tip="关闭"
            data-tip-kbd="Esc"
            onClick={close}
          >
            <X size={15} />
          </button>
        </div>
        <form
          onSubmit={(ev) => {
            ev.preventDefault();
            if (
              current !== target ||
              output !== (doc.exportColorProfile ?? "file")
            )
              save({
                ...changeProfile(doc, target, mode),
                exportColorProfile:
                  output === "file" ? undefined : (output as ColorProfile),
              });
            if (preferred !== preferredProfile())
              localStorage.setItem(preferenceKey, preferred);
            close();
          }}
        >
          <p
            style={{
              margin: 0,
              fontSize: 10.5,
              color: "var(--text-muted)",
            }}
          >
            当前显示器色域：{supportsP3 ? "支持 Display P3 广色域" : "sRGB"}
          </p>
          <label>
            文件色域
            <select
              value={target}
              onChange={(e) => setTarget(e.target.value as ColorProfile)}
            >
              {options}
            </select>
          </label>
          {target !== current && (
            <fieldset>
              <legend>
                {profileLabel(current)} → {profileLabel(target)}
              </legend>
              <label>
                <input
                  type="radio"
                  name="mode"
                  checked={mode === "assign"}
                  onChange={() => setMode("assign")}
                />
                指定 · 保留颜色数值
              </label>
              <label>
                <input
                  type="radio"
                  name="mode"
                  checked={mode === "convert"}
                  onChange={() => setMode("convert")}
                />
                转换 · 尽量保持外观
              </label>
              {mode === "convert" && (
                <small>
                  转换图层用色，保留样式与变量定义。超出目标色域的颜色会裁切。
                </small>
              )}
            </fieldset>
          )}
          <label>
            React 导出色域
            <select value={output} onChange={(e) => setOutput(e.target.value)}>
              <option value="file">跟随文件（{profileLabel(target)}）</option>
              {options}
            </select>
          </label>
          <label>
            新建文件默认色域
            <select
              value={preferred}
              onChange={(e) => setPreferred(e.target.value as ColorProfile)}
            >
              {options}
            </select>
          </label>
          <footer>
            <button type="button" onClick={close}>
              取消
            </button>
            <button className="primary" type="submit" disabled={!dirty}>
              应用
            </button>
          </footer>
        </form>
      </div>
    </div>
  );
}
