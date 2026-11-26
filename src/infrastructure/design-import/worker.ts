import pdfiumUrl from "@embedpdf/pdfium/pdfium.wasm?url";
import { configurePdfReader } from "./sketch-image";
import { checkImportedFonts } from "./font-check";
import {
  importReportSchema,
  parseDocument,
  type DesignDocument,
} from "../../domain/document";
import { importSummary } from "./summary";
import { openDesignArchive } from "./archive";
import { importSketch } from "./sketch";
import { importFigma } from "./figma";
import {
  checkDesignFileSize,
  figmaHeader,
  requireImportCrypto,
  unsupportedFigma,
} from "./types";

configurePdfReader(async () => {
  const r = await fetch(pdfiumUrl);
  if (!r.ok) throw Error("无法载入本机 PDF 读取器");
  return r.arrayBuffer();
});

let draft: DesignDocument | undefined;
let saving = false;
self.onmessage = async ({ data: file }: MessageEvent<File | "save">) => {
  try {
    if (file === "save") {
      if (!draft || saving) return;
      saving = true;
      try {
        const { createLocalFileWithKey } = await import("../storage");
        const { key, url } = await createLocalFileWithKey(draft);
        draft = undefined;
        self.postMessage({ key, url });
      } finally {
        saving = false;
      }
      return;
    }
    checkDesignFileSize(file.size);
    const bytes = new Uint8Array(await file.arrayBuffer());
    const header = figmaHeader(bytes);
    if (header === "unsupported") throw Error(unsupportedFigma);
    const bareFigma = header === "design";
    const archive = bareFigma ? undefined : openDesignArchive(bytes);
    const sketch = archive?.has("document.json") && archive.has("meta.json");
    const figma = bareFigma || archive?.has("canvas.fig");
    if ((!sketch && !figma) || (sketch && figma))
      throw Error(
        "请选择 Sketch 或 Figma 的原生设计文件。导出的图片包缺少页面与组件定义。",
      );
    const format = sketch ? "Sketch" : "Figma";
    self.postMessage({ stage: "正在读取 " + format + " 图层、组件与样式" });
    if (sketch) requireImportCrypto();
    const result = await (sketch ? importSketch : importFigma)(
      bytes,
      file.name,
    );
    self.postMessage({ stage: "正在校验页面、组件和资源引用" });
    const sha256 = Array.from(
      new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
      (n) => n.toString(16).padStart(2, "0"),
    ).join("");
    const fontIssues = await checkImportedFonts(result.document);
    const report = importReportSchema.parse({
      version: 1,
      filename: file.name,
      format,
      sha256,
      issues: [...result.issues, ...fontIssues],
      sourceNodes: result.sourceNodes,
    });
    draft = sketch ? result.document : parseDocument(result.document);
    draft.importReport = report;
    self.postMessage({ report, summary: importSummary(draft) });
  } catch (error) {
    self.postMessage({
      error: error instanceof Error ? error.message : String(error),
    });
  }
};
