import { FileColorContext } from "./ColorProfileDialog";
import { useContext, useMemo } from "react";
import { variantPreview } from "../domain/library";
import type {
  ComponentLibrary,
  ComponentVariant,
} from "../domain/library-schema";
import { CanvasNode } from "./CanvasNode";
export function AssetPreview({
  variant,
  images,
  designSystem,
  large = false,
  compact = false,
}: {
  variant: ComponentVariant;
  images?: ComponentLibrary["images"];
  designSystem?: ComponentLibrary["designSystem"];
  large?: boolean;
  compact?: boolean;
}) {
  const root = variant.nodes.find((n) => n.parentId === null)!;
  const scale = Math.min(
    large ? 1 : compact ? 0.56 : 0.68,
    (large ? 560 : compact ? 90 : 212) / root.style.width,
    (large ? 420 : compact ? 62 : 108) / root.style.height,
  );
  const colorProfile = useContext(FileColorContext);
  const doc = useMemo(
    () => ({ ...variantPreview(variant), images, designSystem, colorProfile }),
    [variant, images, designSystem, colorProfile],
  );
  return (
    <div className={`asset-preview ${large ? "large" : ""}`}>
      <div
        style={{
          width: root.style.width * scale,
          height: root.style.height * scale,
        }}
      >
        <div
          style={{
            position: "relative",
            width: root.style.width,
            height: root.style.height,
            transform: `scale(${scale})`,
            transformOrigin: "top left",
          }}
        >
          <CanvasNode
            node={root}
            document={doc}
            selection={[]}
            editing={null}
          />
        </div>
      </div>
    </div>
  );
}
