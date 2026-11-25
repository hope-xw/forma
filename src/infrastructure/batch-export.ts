import { zipSync, strToU8 } from "fflate";
import type { DesignDocument, DesignNode } from "../domain/document";
import { subtreeIds } from "../domain/tree";
import { exportNodeAsRaster, exportNodeToSvg } from "./static-export";

export interface ExportTarget {
  nodeId: string;
  nodeName: string;
  nodeType: DesignNode["type"];
  format: "png" | "jpeg" | "webp" | "svg";
  scale: number;
  suffix: string;
  /** Relative ZIP path, preserving safe `/` subfolders and suffixes. */
  path: string;
}

export interface BatchExportOptions {
  /** Optional custom rasterizer (e.g., for headless/Node test verification). */
  rasterize?: (
    doc: DesignDocument,
    nodeId: string,
    options: { format: "png" | "jpeg" | "webp"; scale: number },
  ) => Promise<Uint8Array>;
}

function sanitizePathSegments(name: string): string {
  const parts = name
    .replace(/\\/g, "/")
    .split("/")
    .map((segment) =>
      segment
        .replace(/[<>:"|?*\u0000-\u001f]/g, "_")
        .trim()
        .replace(/^\.+/, "")
        .replace(/[. ]+$/, ""),
    )
    .filter(
      (segment) => segment.length > 0 && segment !== "." && segment !== "..",
    );
  return parts.length ? parts.join("/") : "Forma";
}

function sanitizeSuffix(suffix: string): string {
  return suffix.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").trim();
}

/**
 * Collect all batch export targets for a document (or optional node subset):
 * includes every node with `exportSettings` and every `slice` node, preserving
 * safe `/` subfolders from layer names and configured suffixes.
 */
export function collectExportTargets(
  doc: DesignDocument,
  nodeIds?: string[],
): ExportTarget[] {
  const scope = nodeIds?.length ? subtreeIds(doc, nodeIds) : null;
  const candidates = doc.nodes.filter(
    (n) => !n.hidden && (!scope || scope.has(n.id)),
  );

  const selected = candidates.filter(
    (n) => (n.exportSettings?.length ?? 0) > 0 || n.type === "slice",
  );

  // If explicit nodeIds were provided and none in their subtrees carry exportSettings/slices,
  // still allow direct export of the requested nodes at default 1x SVG.
  const effectiveNodes =
    selected.length > 0 || !nodeIds?.length
      ? selected
      : doc.nodes.filter((n) => !n.hidden && nodeIds.includes(n.id));

  const usedPaths = new Set<string>();
  const targets: ExportTarget[] = [];

  for (const node of effectiveNodes) {
    const settings = node.exportSettings?.length
      ? node.exportSettings
      : [{ id: "default", format: "svg" as const, scale: 1, suffix: "" }];

    const baseName = sanitizePathSegments(node.name);
    for (const setting of settings) {
      const cleanSuffix = sanitizeSuffix(setting.suffix ?? "");
      const ext = setting.format;
      let candidatePath = `${baseName}${cleanSuffix}.${ext}`;
      if (usedPaths.has(candidatePath)) {
        const scaleTag = `@${setting.scale}x`;
        const withScale = `${baseName}${cleanSuffix}${scaleTag}.${ext}`;
        if (!usedPaths.has(withScale)) {
          candidatePath = withScale;
        } else {
          let counter = 2;
          while (usedPaths.has(`${baseName}${cleanSuffix}-${counter}.${ext}`)) {
            counter++;
          }
          candidatePath = `${baseName}${cleanSuffix}-${counter}.${ext}`;
        }
      }
      usedPaths.add(candidatePath);
      targets.push({
        nodeId: node.id,
        nodeName: node.name,
        nodeType: node.type,
        format: setting.format,
        scale: setting.scale,
        suffix: cleanSuffix,
        path: candidatePath,
      });
    }
  }

  return targets;
}

/**
 * Batch-export all collected targets (nodes with `exportSettings` and `slice` nodes)
 * into a single ZIP archive preserving `/` subfolders and configured suffixes.
 */
export async function exportBatchZip(
  doc: DesignDocument,
  nodeIds?: string[],
  options: BatchExportOptions = {},
): Promise<Uint8Array> {
  const targets = collectExportTargets(doc, nodeIds);
  const entries: Record<string, Uint8Array> = {};

  for (const target of targets) {
    if (target.format === "svg") {
      const svg = exportNodeToSvg(doc, target.nodeId, target.scale);
      entries[target.path] = strToU8(svg);
    } else if (options.rasterize) {
      entries[target.path] = await options.rasterize(doc, target.nodeId, {
        format: target.format,
        scale: target.scale,
      });
    } else {
      const blob = await exportNodeAsRaster(doc, target.nodeId, {
        format: target.format,
        scale: target.scale,
      });
      entries[target.path] = new Uint8Array(await blob.arrayBuffer());
    }
  }

  return zipSync(entries, { level: 6 });
}
