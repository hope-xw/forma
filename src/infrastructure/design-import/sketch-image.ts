import { init, type WrappedPdfiumModule } from "@embedpdf/pdfium";
import { zlibSync } from "fflate";
import { crc32 } from "./archive";
import { importImageBytes } from "./image";

let loadWasm: (() => Promise<ArrayBuffer>) | undefined;
let reader: Promise<WrappedPdfiumModule> | undefined;
export function configurePdfReader(loader: () => Promise<ArrayBuffer>) {
  loadWasm = loader;
  reader = undefined;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const chunk = new Uint8Array(data.length + 12);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, data.length);
  chunk.set(new TextEncoder().encode(type), 4);
  chunk.set(data, 8);
  view.setUint32(chunk.length - 4, crc32(chunk.subarray(4, -4)));
  return chunk;
}

// Use straight-alpha RGBA, one unfiltered scanline per row.
function encodePng(
  pixels: Uint8Array,
  width: number,
  height: number,
  stride: number,
) {
  const header = new Uint8Array(13),
    view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header[8] = 8;
  header[9] = 6;
  const rowSize = width * 4 + 1;
  const rows = new Uint8Array(rowSize * height);
  for (let y = 0; y < height; y++)
    rows.set(
      pixels.subarray(y * stride, y * stride + width * 4),
      y * rowSize + 1,
    );
  const chunks = [
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", zlibSync(rows)),
    pngChunk("IEND", new Uint8Array()),
  ];
  const result = new Uint8Array(chunks.reduce((sum, c) => sum + c.length, 0));
  let p = 0;
  for (const chunk of chunks) {
    result.set(chunk, p);
    p += chunk.length;
  }
  return result;
}

export async function rasterizeSketchPdf(bytes: Uint8Array) {
  if (!loadWasm || bytes.length > 32 * 1024 * 1024)
    throw Error("当前环境无法解码此 PDF 图像");
  reader ??= loadWasm()
    .then(async (wasmBinary) => {
      const pdf = await init({ wasmBinary });
      pdf.FPDF_InitLibrary();
      return pdf;
    })
    .catch((error) => {
      reader = undefined;
      throw error;
    });
  const pdf = await reader,
    mod = pdf.pdfium;
  const ptr = mod.wasmExports.malloc(bytes.byteLength);
  if (!ptr) throw Error("PDF 图像内存不足");
  let doc = 0,
    page = 0,
    bitmap = 0;
  try {
    mod.HEAPU8.set(bytes, ptr);
    doc = pdf.FPDF_LoadMemDocument(ptr, bytes.byteLength, "");
    if (!doc || pdf.FPDF_GetPageCount(doc) !== 1)
      throw Error("图像资源须为可读取的单页 PDF");
    page = pdf.FPDF_LoadPage(doc, 0);
    if (!page) throw Error("PDF 图像页损坏");
    const width = Math.ceil(pdf.FPDF_GetPageWidth(page)),
      height = Math.ceil(pdf.FPDF_GetPageHeight(page));
    if (!(
      width > 0 &&
      height > 0 &&
      width <= 8192 &&
      height <= 8192 &&
      width * height <= 4_194_304
    ))
      throw Error("PDF 图像超出渲染尺寸预算");
    bitmap = pdf.FPDFBitmap_Create(width, height, 1);
    if (!bitmap) throw Error("无法分配 PDF 图像");
    pdf.FPDFBitmap_FillRect(bitmap, 0, 0, width, height, 0);
    // FPDF_REVERSE_BYTE_ORDER makes the bitmap RGBA rather than BGRA.
    pdf.FPDF_RenderPageBitmap(bitmap, page, 0, 0, width, height, 0, 0x10);
    const stride = pdf.FPDFBitmap_GetStride(bitmap),
      start = pdf.FPDFBitmap_GetBuffer(bitmap);
    return encodePng(
      mod.HEAPU8.subarray(start, start + stride * height),
      width,
      height,
      stride,
    );
  } finally {
    if (bitmap) pdf.FPDFBitmap_Destroy(bitmap);
    if (page) pdf.FPDF_ClosePage(page);
    if (doc) pdf.FPDF_CloseDocument(doc);
    mod.wasmExports.free(ptr);
  }
}
export async function importSketchImage(bytes: Uint8Array, name: string) {
  if (bytes[0] === 37 && bytes[1] === 80 && bytes[2] === 68 && bytes[3] === 70)
    return importImageBytes(
      await rasterizeSketchPdf(bytes),
      name.replace(/\.pdf$/i, "") + ".png",
    );
  return importImageBytes(bytes, name);
}
