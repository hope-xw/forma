import { sketchFontInstances } from "./sketch-font-instances";
import type { FontAsset } from "../../domain/fonts";
import type { ImportIssue } from "./types";
import { importFontBytes } from "../font-import";
import type { openDesignArchive } from "./archive";

// Only source entries with embedded bytes declare a usable face. A family can
// contain distinct italic/upright assets, so prioritize exact PostScript names.
export async function importSketchFonts(
  raw: Record<string, unknown>,
  archive: ReturnType<typeof openDesignArchive>,
) {
  const fonts: Record<string, FontAsset> = {},
    instances = new Map<string, Record<string, number>>(),
    fontBytes = new Map<string, Uint8Array>(),
    tracking = new Map<string, (size: number) => number>(),
    families = new Map<string, string>(),
    ambiguous = new Set<string>(),
    byFamily = new Map<string, string>(),
    issues: ImportIssue[] = [];
  for (const r of Array.isArray(raw.fontReferences) ? raw.fontReferences : []) {
    const path = r?.fontData?._ref ?? r?.fontFileReference?._ref;
    if (typeof path !== "string") continue;
    try {
      if (!path.startsWith("fonts/") || !archive.has(path))
        throw Error("找不到嵌入字体");
      const bytes = archive.read(path);
      const {
        id,
        asset,
        tracking: spacing,
        trackingIssue,
      } = await importFontBytes(
        bytes,
        r.fontFileName || r.fontFamilyName || path,
      );
      for (const [name, coords] of sketchFontInstances(bytes))
        instances.set(name, coords);
      fontBytes.set(id, bytes);
      fonts[id] ??= asset;
      if (spacing) tracking.set(id, spacing);
      if (trackingIssue) issues.push({ node: path, detail: trackingIssue });
      for (const ps of Array.isArray(r.postscriptNames)
        ? r.postscriptNames
        : [])
        if (typeof ps === "string") families.set(ps, id);
      const family = r.fontFamilyName;
      if (typeof family === "string") {
        if (byFamily.has(family) && byFamily.get(family) !== id)
          ambiguous.add(family);
        else byFamily.set(family, id);
      }
    } catch (error) {
      issues.push({
        node: path,
        detail: error instanceof Error ? error.message : "无法读取嵌入字体",
      });
    }
  }
  for (const [name, id] of byFamily)
    if (!ambiguous.has(name) && !families.has(name)) families.set(name, id);
  return { fonts, families, fontBytes, instances, tracking, issues };
}
