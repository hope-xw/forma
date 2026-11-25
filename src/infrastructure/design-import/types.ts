import type { DesignDocument, ImportIssue } from "../../domain/document";
export type { ImportIssue };
export interface ExternalDesignImport {
  document: DesignDocument;
  issues: ImportIssue[];
  sourceNodes: number;
}
export const acceptedDesignFiles = ".forma,.json,.sketch,.fig";
export const maxDesignBytes = 256 * 1024 * 1024;
export const maxNativeBytes = 512 * 1024 * 1024;
export function checkDesignFileSize(size: number, external = true) {
  const limit = external ? maxDesignBytes : maxNativeBytes;
  if (size > limit) throw Error(`设计文件超过 ${limit / 1024 / 1024} MiB`);
}
export function limitedText(
  value: string,
  max: number,
  warn?: (detail: string) => void,
  label = "文本",
) {
  if (value.length <= max) return value;
  warn?.(label + "已截短至 " + max + " 字符");
  return value.slice(0, max).replace(/[\uD800-\uDBFF]$/, "");
}
export function importName(
  value: string,
  fallback: string,
  max = 200,
  warn?: (detail: string) => void,
) {
  const name = value.trim();
  if (!name) warn?.("空名称已采用默认名称");
  return limitedText(name || fallback, max, warn, "名称");
}
export function figmaHeader(bytes: Uint8Array) {
  const header = new TextDecoder().decode(bytes.subarray(0, 8));
  if (header === "fig-jam." || header === "fig-deck") return "unsupported";
  if (header === "fig-kiwi") return "design";
}
export const unsupportedFigma =
  "暂不支持 FigJam 或 Figma Slides 文件，请在 Figma Design 中通过「Save local copy…」导出 .fig 文件后导入。";
export function requireImportCrypto() {
  if (!globalThis.crypto?.subtle)
    throw Error(
      "导入设计文件需要安全连接，请使用 HTTPS 或在 localhost 打开 Forma。",
    );
}
export async function isExternalDesign(file: File) {
  if (/\.(sketch|fig)$/i.test(file.name)) return true;
  const header = new Uint8Array(await file.slice(0, 8).arrayBuffer());
  return (header[0] === 80 && header[1] === 75) || !!figmaHeader(header);
}
