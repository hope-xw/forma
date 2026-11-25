import type { ImageAsset } from "../domain/images";
export async function readImage(
  file: File,
): Promise<{ id: string; image: ImageAsset }> {
  if (file.size > 8 * 1024 * 1024) throw new Error("单张图片上限为 8 MB");
  const bytes = await file.arrayBuffer(),
    view = new Uint8Array(bytes);
  const head = String.fromCharCode(...view.slice(0, 12));
  const mime = head.startsWith("\x89PNG\r\n\x1a\n")
    ? "image/png"
    : view[0] === 255 && view[1] === 216 && view[2] === 255
      ? "image/jpeg"
      : head.startsWith("RIFF") && head.slice(8) === "WEBP"
        ? "image/webp"
        : /^GIF8[79]a/.test(head)
          ? "image/gif"
          : null;
  if (!mime) throw new Error("支持 PNG、JPEG、WebP 和 GIF 图片");
  const blob = new Blob([bytes], { type: mime }),
    bitmap = await createImageBitmap(blob);
  const { width, height } = bitmap;
  bitmap.close();
  if (width > 32768 || height > 32768) throw new Error("图片边长超过 32768px");
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  const data = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => resolve(String(reader.result));
    reader.readAsDataURL(blob);
  });
  return {
    id:
      "img-" +
      Array.from(digest, (n) => n.toString(16).padStart(2, "0")).join(""),
    image: { name: file.name.slice(0, 255) || "图片", width, height, data },
  };
}
