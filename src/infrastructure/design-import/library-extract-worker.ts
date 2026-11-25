import pdfiumUrl from "@embedpdf/pdfium/pdfium.wasm?url";
import { importReportSchema, parseDocument } from "../../domain/document";
import { extractLibrariesFromDocument } from "../../domain/library-packaging";
import { openDesignArchive } from "./archive";
import { importFigma } from "./figma";
import { checkImportedFonts } from "./font-check";
import { importSketch } from "./sketch";
import { configurePdfReader } from "./sketch-image";
import {
  checkDesignFileSize,
  figmaHeader,
  requireImportCrypto,
  unsupportedFigma,
} from "./types";

configurePdfReader(async () => {
  const response = await fetch(pdfiumUrl);
  if (!response.ok) throw Error("无法载入本机 PDF 读取器");
  return response.arrayBuffer();
});

self.onmessage = async ({ data: file }: MessageEvent<File>) => {
  try {
    checkDesignFileSize(file.size);
    const bytes = new Uint8Array(await file.arrayBuffer());
    const header = figmaHeader(bytes);
    if (header === "unsupported") throw Error(unsupportedFigma);
    const bareFigma = header === "design";
    const archive =
      !bareFigma && bytes[0] === 0x50 && bytes[1] === 0x4b
        ? openDesignArchive(bytes)
        : undefined;
    const sketch = archive?.has("document.json") && archive.has("meta.json");
    const figma = bareFigma || archive?.has("canvas.fig");
    if ((!sketch && !figma) || (sketch && figma))
      throw Error("请选择 .fig 或 .sketch 原生设计文件");

    const format = sketch ? "Sketch" : "Figma";
    self.postMessage({ stage: "正在解析 " + format + " 组件、变体与样式" });
    requireImportCrypto();
    const result = await (sketch ? importSketch : importFigma)(
      bytes,
      file.name,
    );
    // importSketch already calls parseDocument before returning.
    const doc = sketch ? result.document : parseDocument(result.document);
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    const sha256 = Array.from(new Uint8Array(digest), (n) =>
      n.toString(16).padStart(2, "0"),
    ).join("");
    doc.importReport = importReportSchema.parse({
      version: 1,
      filename: file.name,
      format,
      sha256,
      issues: [...result.issues, ...(await checkImportedFonts(doc))],
      sourceNodes: result.sourceNodes,
    });

    self.postMessage({ stage: "正在打包并校验可复用组件库" });
    const library = extractLibrariesFromDocument(doc);
    self.postMessage({
      library,
      format,
      componentCount: library.components.length,
      variantCount: library.components.reduce(
        (sum, c) => sum + c.variants.length,
        0,
      ),
      issueCount: result.issues.length,
    });
  } catch (error) {
    self.postMessage({
      error: error instanceof Error ? error.message : String(error),
    });
  }
};
