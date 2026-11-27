import type { DesignDocument, ImportIssue } from "../../domain/document";
import { inflateSync, strFromU8, unzipSync } from "fflate";
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
const manifestName = "manifest.json";
// The native writer puts the manifest first. Inspect just that range on disk.
// Other ZIP writers may reorder entries or use data descriptors.
export const maxManifestBytes = 32 * 1024 * 1024;
function packageMarker(bytes: Uint8Array) {
  return JSON.parse(strFromU8(bytes))?.format === "forma/package";
}
export function isFormaPackageZip(bytes: Uint8Array): boolean {
  if (
    bytes[0] !== 80 ||
    bytes[1] !== 75 ||
    bytes[2] !== 3 ||
    bytes[3] !== 4 ||
    bytes.length < 22 ||
    bytes.length > maxNativeBytes
  )
    return false;
  try {
    let found = false;
    const entries = unzipSync(bytes, {
      filter: ({ name, size, originalSize }) => {
        if (name !== manifestName) return false;
        if (found || size > maxManifestBytes || originalSize > maxManifestBytes)
          throw Error("无效的 Forma 包清单");
        found = true;
        return true;
      },
    });
    return !!entries[manifestName] && packageMarker(entries[manifestName]);
  } catch {
    return false;
  }
}
export async function isExternalDesign(file: File) {
  if (/\.(sketch|fig)$/i.test(file.name)) return true;
  const header = new Uint8Array(
    await file.slice(0, 30 + manifestName.length).arrayBuffer(),
  );
  if (figmaHeader(header)) return true;
  if (header[0] !== 80 || header[1] !== 75) return false;
  checkDesignFileSize(file.size, false);
  if (header[2] !== 3 || header[3] !== 4) return true;
  if (header.length === 30 + manifestName.length) {
    const view = new DataView(header.buffer);
    const method = view.getUint16(8, true);
    if (
      !(view.getUint16(6, true) & 9) &&
      (method === 0 || method === 8) &&
      view.getUint16(26, true) === manifestName.length &&
      strFromU8(header.subarray(30)) === manifestName
    ) {
      const size = view.getUint32(18, true),
        expanded = view.getUint32(22, true);
      const start = header.length + view.getUint16(28, true);
      if (
        size > maxManifestBytes ||
        expanded > maxManifestBytes ||
        start + size > file.size
      )
        return true;
      try {
        const data = new Uint8Array(
          await file.slice(start, start + size).arrayBuffer(),
        );
        return !packageMarker(
          method === 0
            ? data
            : inflateSync(data, { out: new Uint8Array(expanded) }),
        );
      } catch {
        return true;
      }
    }
  }
  return !isFormaPackageZip(new Uint8Array(await file.arrayBuffer()));
}
