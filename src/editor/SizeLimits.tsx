import { DraftNumberInput } from "./GridTracks";
import type { DesignNode } from "../domain/document";
import { propertyLabels } from "../domain/design-properties";
import type { EditorController } from "./useEditor";
import { isLocked } from "../domain/tree";
import { TokenBinding } from "./TokenBinding";
export function SizeLimits({
  editor,
  nodes,
  disabled: locked,
}: {
  editor: EditorController;
  nodes: DesignNode[];
  disabled: boolean;
}) {
  const disabled =
    locked ||
    nodes.some((n) => isLocked(editor.doc, n.id)) ||
    Boolean(editor.previewRef?.current && editor.doc !== editor.committed);
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
                <DraftNumberInput
                  aria-label={propertyLabels[key]}
                  min={1}
                  max={10000}
                  key={nodes.map((n) => n.id + "=" + n.style[key]).join(",")}
                  placeholder={mixed ? "Mixed" : "—"}
                  disabled={disabled}
                  value={mixed ? undefined : value}
                  onClear={() => {
                    if (
                      (mixed || value !== undefined) &&
                      !editor.previewRef?.current
                    )
                      editor.update({}, { [key]: undefined });
                  }}
                  onCommit={(next) => {
                    if (!editor.previewRef?.current)
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
