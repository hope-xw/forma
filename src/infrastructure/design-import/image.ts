import {
  assetHash,
  encodeBase64,
  maxAssetBytes,
} from "../../domain/asset-bytes";
import type { ImageAsset } from "../../domain/images";

// Read dimensions without a DOM canvas. The archive can also contain PDFs and TIFFs.
function dimensions(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const at = (i: number, n: number) =>
    String.fromCharCode(...bytes.subarray(i, i + n));
  if (
    bytes.length >= 24 &&
    at(0, 8) === "\x89PNG\r\n\x1a\n" &&
    at(12, 4) === "IHDR"
  )
    return {
      mime: "png",
      width: view.getUint32(16),
      height: view.getUint32(20),
    };
  if (bytes.length >= 10 && /^GIF8[79]a/.test(at(0, 6)))
    return {
      mime: "gif",
      width: view.getUint16(6, true),
      height: view.getUint16(8, true),
    };
  if (bytes.length >= 30 && at(0, 4) === "RIFF" && at(8, 4) === "WEBP") {
    if (at(12, 4) === "VP8X") {
      const uint24 = (p: number) =>
        bytes[p] + (bytes[p + 1] << 8) + (bytes[p + 2] << 16);
      return { mime: "webp", width: 1 + uint24(24), height: 1 + uint24(27) };
    }
    if (at(12, 4) === "VP8 ")
      return {
        mime: "webp",
        width: view.getUint16(26, true) & 16383,
        height: view.getUint16(28, true) & 16383,
      };
    if (at(12, 4) === "VP8L") {
      const bits = view.getUint32(21, true);
      return {
        mime: "webp",
        width: (bits & 16383) + 1,
        height: ((bits >>> 14) & 16383) + 1,
      };
    }
  }
  if (bytes[0] === 255 && bytes[1] === 216) {
    let i = 2;
    while (i < bytes.length - 4 && bytes[i] === 255) {
      while (bytes[i] === 255) i++;
      const marker = bytes[i++];
      if (marker === 217 || marker === 218) break;
      if (marker === 1 || (marker >= 0xd0 && marker <= 0xd8)) continue;
      if (i + 2 > bytes.length) break;
      const length = view.getUint16(i);
      if (length < 2 || i + length > bytes.length) break;
      if (
        [
          192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207,
        ].includes(marker) &&
        length >= 7
      )
        return {
          mime: "jpeg",
          width: view.getUint16(i + 5),
          height: view.getUint16(i + 3),
        };
      i += length;
    }
  }
}
export function inspectImageBytes(bytes: Uint8Array) {
  const info = dimensions(bytes);
  if (!info) throw Error("无法识别位图格式");
  if (
    !info.width ||
    !info.height ||
    Math.max(info.width, info.height) > 32768 ||
    info.width * info.height > 64_000_000
  )
    throw Error("图像尺寸超出可编辑范围");
  if (bytes.length > maxAssetBytes) throw Error("单张图片超过 32 MiB");
  return info;
}
export async function importImageBytes(
  bytes: Uint8Array,
  name: string,
): Promise<{ id: string; image: ImageAsset }> {
  const info = inspectImageBytes(bytes);
  return {
    id: "img-" + (await assetHash(bytes)),
    image: {
      name: name.slice(0, 255) || "图片",
      width: info.width,
      height: info.height,
      data: "data:image/" + info.mime + ";base64," + encodeBase64(bytes),
    },
  };
}
