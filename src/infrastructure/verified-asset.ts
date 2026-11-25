import type { DesignDocument } from "../domain/document";
import { assetHash, decodeBase64 } from "../domain/asset-bytes";
import { inspectImageBytes } from "./design-import/image";
import { inspectFontBytes } from "./font-import";
export async function verifyEncodedAsset(id: string, data: string) {
  const bytes = decodeBase64(data);
  if ((await assetHash(bytes)) !== id.slice(id.indexOf("-") + 1))
    throw Error("资源内容与标识不一致：" + id);
  if (id.startsWith("img-")) {
    const info = inspectImageBytes(bytes);
    if (!data.startsWith("data:image/" + info.mime + ";base64,"))
      throw Error("图片格式与标注不一致：" + id);
    return { width: info.width, height: info.height };
  }
  const info = inspectFontBytes(bytes);
  if (!data.startsWith("data:font/" + info.format + ";base64,"))
    throw Error("字体格式与标注不一致：" + id);
}
export function checkImageMetadata(
  doc: DesignDocument,
  sizes: ReadonlyMap<string, { width: number; height: number }>,
) {
  for (const scope of [doc, ...Object.values(doc.libraries ?? {})])
    for (const [id, image] of Object.entries(scope.images ?? {})) {
      const s = sizes.get(id);
      if (s && (image.width !== s.width || image.height !== s.height))
        throw Error("图片像素尺寸与标注不一致：" + id);
    }
}
