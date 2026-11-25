// Original compressed image/font files are bounded independently of their decoded surfaces.
export const maxAssetBytes = 32 * 1024 * 1024;
export const maxEncodedAssetLength = 64 + 4 * Math.ceil(maxAssetBytes / 3);
export const maxDocumentAssetBytes = 256 * 1024 * 1024;

type NativeBase64 = Uint8Array & { toBase64?: () => string };
export function encodeBase64(bytes: Uint8Array) {
  const native = (bytes as NativeBase64).toBase64;
  if (native) return native.call(bytes);
  const parts: string[] = [];
  // Align partitions to three bytes so their padded encodings concatenate.
  for (let i = 0; i < bytes.length; i += 24576)
    parts.push(btoa(String.fromCharCode(...bytes.subarray(i, i + 24576))));
  return parts.join("");
}
export function assetByteLength(data: string) {
  const len = data.length - data.indexOf(",") - 1;
  if (len % 4 || !len) throw Error("资源 Base64 长度无效");
  return (3 * len) / 4 - (data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0);
}
export function decodeBase64(data: string): Uint8Array<ArrayBuffer> {
  const start = data.indexOf(",") + 1;
  const bytes = new Uint8Array(assetByteLength(data));
  let dest = 0;
  for (let i = start; i < data.length; i += 32768) {
    const piece = atob(data.slice(i, i + 32768));
    for (let j = 0; j < piece.length; j++) bytes[dest++] = piece.charCodeAt(j);
  }
  return bytes;
}
export async function assetHash(bytes: Uint8Array) {
  const view =
    bytes.buffer instanceof ArrayBuffer
      ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
      : new Uint8Array(bytes);
  return Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", view)),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
}
