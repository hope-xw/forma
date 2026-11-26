import type { DesignDocument } from "../domain/document";
import {
  configureSvgTextWidth,
  exportNodeToSvg,
  svgAsset,
  type Scale,
  type RasterFormat,
} from "../compiler/svg-export";
export * from "../compiler/svg-export";

const measureContext = (() => {
  if (typeof document === "undefined") return null;
  try {
    return document.createElement("canvas").getContext?.("2d") ?? null;
  } catch {
    return null;
  }
})();

if (measureContext) {
  configureSvgTextWidth((text, font) => {
    measureContext.font = `${font.style} ${font.weight} ${font.size}px ${font.family}`;
    return measureContext.measureText(text).width;
  });
}

export async function exportNodeAsRaster(
  doc: DesignDocument,
  nodeId: string,
  options: { format: RasterFormat; scale: Scale; quality?: number },
): Promise<Blob> {
  const { svg, width, height } = svgAsset(doc, nodeId);
  const pixelsWide = Math.max(1, Math.round(width * options.scale)),
    pixelsHigh = Math.max(1, Math.round(height * options.scale));
  if (
    !Number.isFinite(pixelsWide + pixelsHigh) ||
    Math.max(pixelsWide, pixelsHigh) > 32767 ||
    pixelsWide * pixelsHigh > 128 * 1024 * 1024
  )
    throw Error(
      "位图超过 32767 px 单边或 128 Mpx 像素预算，请缩小倍率或选择较小范围",
    );
  const url = URL.createObjectURL(
    new Blob([svg], { type: "image/svg+xml;charset=utf-8" }),
  );
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = pixelsWide;
    canvas.height = pixelsHigh;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw Error("无法创建位图画布");
    if (options.format === "jpeg") {
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    const mime = "image/" + options.format;
    return await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(
        (blob) =>
          blob?.type === mime
            ? resolve(blob)
            : reject(Error("浏览器无法编码 " + mime)),
        mime,
        options.quality,
      ),
    );
  } finally {
    URL.revokeObjectURL(url);
  }
}
export async function downloadStaticExport(
  doc: DesignDocument,
  nodeId: string,
  options: { format: "svg" | RasterFormat; scale: Scale },
): Promise<void> {
  const { format, scale } = options;
  const blob =
    format === "svg"
      ? new Blob([exportNodeToSvg(doc, nodeId, scale)], {
          type: "image/svg+xml",
        })
      : await exportNodeAsRaster(doc, nodeId, { format, scale });
  const name =
    doc.nodes
      .find((n) => n.id === nodeId)!
      .name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
      .trim()
      .replace(/[. ]+$/, "") || "Forma";
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${name}@${scale}x.${format}`;
  try {
    a.click();
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}
