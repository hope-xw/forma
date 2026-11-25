import type { DesignNode } from "../domain/document";
import { propertyLabels } from "../domain/design-properties";
import type { EditorController } from "./useEditor";
import { TokenBinding } from "./TokenBinding";
export function SizeLimits({
  editor,
  nodes,
  disabled,
}: {
  editor: EditorController;
  nodes: DesignNode[];
  disabled: boolean;
}) {
  return (
    <details className="size-limits advanced-properties">
      <summary>尺寸范围</summary>
      <div className="property-grid">
        {(["minWidth", "maxWidth", "minHeight", "maxHeight"] as const).map(
          (key) => {
            const value = nodes[0].style[key],
              mixed = nodes.some((n) => n.style[key] !== value);
            return (
              <label
                className="property-field"
                key={key}
                title={propertyLabels[key]}
              >
                <span>{propertyLabels[key]}</span>
                <input
                  aria-label={propertyLabels[key]}
                  type="number"
                  min={1}
                  max={10000}
                  key={
                    key +
                    ":" +
                    nodes.map((n) => n.id + "=" + n.style[key]).join(",")
                  }
                  placeholder={mixed ? "Mixed" : "—"}
                  disabled={disabled}
                  defaultValue={mixed ? "" : (value ?? "")}
                  onKeyDown={(ev) => {
                    if (ev.key === "Enter") ev.currentTarget.blur();
                  }}
                  onBlur={(ev) => {
                    const input = ev.currentTarget;
                    const raw = input.value.trim();
                    if (mixed && raw === "") return;
                    if (raw !== "" && !input.validity.valid) {
                      input.value = mixed ? "" : String(value ?? "");
                      return;
                    }
                    const next = raw === "" ? undefined : Number(raw);
                    if (next !== undefined && !Number.isFinite(next)) {
                      input.value = mixed ? "" : String(value ?? "");
                      return;
                    }
                    if (next !== value || (mixed && raw !== ""))
                      editor.update({}, { [key]: next });
                  }}
                />
                <TokenBinding
                  editor={editor}
                  property={key}
                  disabled={disabled}
                />
              </label>
            );
          },
        )}
      </div>
    </details>
  );
}
