import { createNode, type DesignNode } from "../domain/document";
import { readImage } from "./image-import";
import { importSvg } from "./svg-import";
import type { Operation } from "../domain/commands";
export async function readCanvasAsset(
  file: File,
): Promise<{ node: DesignNode; resources: Operation[] }> {
  if (file.type === "image/svg+xml" || /\.svg$/i.test(file.name)) {
    if (file.size > 2_000_000) throw new Error("SVG 图标上限为 2 MB");
    return { node: importSvg(await file.text(), file.name), resources: [] };
  }
  const { id, image } = await readImage(file);
  const node = createNode("rectangle"),
    scale = Math.min(1, 10000 / Math.max(image.width, image.height));
  node.name = image.name.slice(0, 200);
  Object.assign(node.style, {
    width: image.width * scale,
    height: image.height * scale,
    radius: 0,
    padding: 0,
    fillOpacity: 0,
  });
  node.image = { assetId: id, fit: "cover", x: 50, y: 50, zoom: 1 };
  return { node, resources: [{ type: "putImage", id, image }] };
}
