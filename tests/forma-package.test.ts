import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { strFromU8, strToU8, unzipSync, zipSync, zlibSync } from "fflate";
import { assetHash, encodeBase64 } from "../src/domain/asset-bytes";
import {
  createNode,
  parseDocument,
  type DesignDocument,
} from "../src/domain/document";
import { createLibraryFromSelection } from "../src/domain/library";
import { crc32 } from "../src/infrastructure/design-import/archive";
import { importImageBytes } from "../src/infrastructure/design-import/image";
import { isExternalDesign } from "../src/infrastructure/design-import/types";
import { importFontBytes } from "../src/infrastructure/font-import";
import type { FormaPackageManifest } from "../src/infrastructure/forma-package";
import {
  decodeFormaPackage,
  encodeFormaPackage,
  formaFilename,
  formaPackageBlob,
  isFormaPackageZip,
  nativeDocumentBlob,
  readNativeDocument,
} from "../src/infrastructure/native-document";

function samplePng(width = 128) {
  function chunk(name: string, bytes: Uint8Array) {
    const out = Buffer.alloc(12 + bytes.length);
    out.writeUInt32BE(bytes.length);
    out.write(name, 4);
    out.set(bytes, 8);
    out.writeUInt32BE(crc32(out.subarray(4, -4)), out.length - 4);
    return out;
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(width, 4);
  header[8] = 8;
  header[9] = 2;
  const rowBytes = width * 3 + 1;
  const rows = Buffer.alloc(width * rowBytes);
  let seed = 1;
  for (let y = 0; y < width; y++) {
    for (let x = 1; x < rowBytes; x++) {
      seed = (Math.imul(1664525, seed) + 1013904223) >>> 0;
      rows[y * rowBytes + x] = seed >>> 24;
    }
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", zlibSync(rows)),
    chunk("IEND", new Uint8Array()),
  ]);
}
async function fixture() {
  const png = samplePng();
  const { id: imageId, image } = await importImageBytes(png, "封面");
  const ttf = readFileSync(
    new URL("./fixtures/forma-geometry-test.ttf", import.meta.url),
  );
  const { id: fontId, asset } = await importFontBytes(ttf, "样例.ttf");
  const vector = createNode("vector");
  vector.vector = {
    width: 12,
    height: 12,
    paths: [{ d: "M0 0L12 12L0 12Z", fill: true, strokeWidth: 0 }],
  };
  const hidden = createNode("rectangle");
  hidden.hidden = true;
  const bitmap = createNode("rectangle");
  bitmap.image = { assetId: imageId, fit: "fill", x: 50, y: 50, zoom: 1 };
  const document: DesignDocument = {
    schemaVersion: 1,
    id: "fixture",
    name: "多页样例",
    revision: 3,
    nodes: [hidden, vector, bitmap],
    tokens: {},
    activePage: "one",
    pages: [
      { id: "one", name: "素材" },
      { id: "two", name: "正文", nodes: [createNode("text")] },
    ],
    images: { [imageId]: image },
    fonts: { [fontId]: asset },
  };
  const library = createLibraryFromSelection(document, bitmap.id, "像素组件");
  document.libraries = { [library.id]: library };
  return {
    doc: parseDocument(JSON.parse(JSON.stringify(document))),
    png,
    ttf,
    imageId,
    fontId,
  };
}
function meta(entries: Record<string, Uint8Array>): FormaPackageManifest {
  return JSON.parse(strFromU8(entries["manifest.json"]));
}
test("two-page package stores raw media once across the document and library and restores editable SVG paths", async (t) => {
  const { doc, png, ttf, imageId, fontId } = await fixture();
  const before = JSON.stringify(doc);
  const bytes = encodeFormaPackage(doc, { appVersion: "0.12.0" });
  assert.equal(JSON.stringify(doc), before);
  const methods = new Map<string, number>();
  const entries = unzipSync(bytes, {
    filter: (e) => {
      methods.set(e.name, e.compression);
      return true;
    },
  });
  const manifest = meta(entries);
  assert.equal(manifest.format, "forma/package");
  assert.equal(manifest.appVersion, "0.12.0");
  assert.equal(manifest.packageVersion, 1);
  assert.equal(manifest.nodeCount, 4);
  assert.equal(manifest.pages, 2);
  assert.equal(manifest.previewPath, "preview.svg");
  assert.ok(entries["preview.svg"].length <= 256 * 1024);
  assert.match(strFromU8(entries["preview.svg"]), /<path[^>]+M0 0L12 12L0 12Z/);
  assert.equal(manifest.documentPath, "document.json");
  assert.doesNotMatch(strFromU8(entries["document.json"]), /;base64,/);
  const payload = JSON.parse(strFromU8(entries["document.json"]));
  assert.equal(payload.images[imageId].data, "");
  assert.equal(payload.fonts[fontId].name, doc.fonts![fontId].name);
  assert.equal(Object.keys(manifest.assets).length, 2);
  for (const [id, original, kind, extension, mime, method] of [
    [imageId, png, "images", "png", "image/png", 0],
    [fontId, ttf, "fonts", "ttf", "font/ttf", 8],
  ] as const) {
    const path = "assets/" + kind + "/" + id + "." + extension;
    assert.deepEqual(manifest.assets[id], {
      path,
      mime,
      bytes: original.length,
      sha256: await assetHash(original),
    });
    assert.deepEqual(Buffer.from(entries[path]), original);
    assert.equal(methods.get(path), method);
  }
  assert.equal(methods.get("document.json"), 8);
  assert.ok(bytes.length < Buffer.byteLength(before) * 0.8);
  t.diagnostic(
    `Compact JSON ${Buffer.byteLength(before)} bytes, package ${bytes.length} bytes, preview ${entries["preview.svg"].length} bytes`,
  );
  assert.deepEqual(await decodeFormaPackage(bytes), doc);
  const blob = formaPackageBlob(doc, { includePreview: false });
  assert.equal(blob.type, "application/vnd.forma.design+zip");
  const noCover = unzipSync(new Uint8Array(await blob.arrayBuffer()));
  assert.equal(meta(noCover).previewPath, undefined);
  assert.ok(!("preview.svg" in noCover));
  assert.deepEqual(await readNativeDocument(blob), doc);
});

test("opaque media strings are preserved verbatim on disk and the package reader respects the current image schema", async () => {
  const { doc } = await fixture();
  const svg = strToU8(
    '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>',
  );
  const id = "img-" + (await assetHash(svg));
  const scope = { name: "SVG", width: 1, height: 1, data: "" };
  // Raw SVG is distinct from the native editable vector layer exercised above.
  for (const source of [
    strFromU8(svg),
    "data:image/svg+xml," + encodeURIComponent(strFromU8(svg)),
    "https://example.invalid/image",
  ]) {
    doc.images![id] = { ...scope, data: source };
    const entries = unzipSync(
      encodeFormaPackage(doc, { includePreview: false }),
    );
    assert.equal(
      JSON.parse(strFromU8(entries["document.json"])).images[id].data,
      source,
    );
  }
  doc.images![id] = {
    ...scope,
    data: "data:image/svg+xml;base64," + encodeBase64(svg),
  };
  const bytes = encodeFormaPackage(doc, { includePreview: false });
  const entries = unzipSync(bytes);
  assert.deepEqual(entries["assets/images/" + id + ".svg"], svg);
  assert.doesNotMatch(strFromU8(entries["document.json"]), /;base64,/);
  await assert.rejects(decodeFormaPackage(bytes), /无法识别位图格式/);
});

test("10,000 active-page layers select parts storage and reopen with all shared assets", async () => {
  const { doc, imageId } = await fixture();
  const layer = createNode("rectangle");
  while (doc.nodes.length < 10000)
    doc.nodes.push({ ...layer, id: "layer-" + doc.nodes.length });
  const bytes = encodeFormaPackage(doc, { includePreview: false });
  const entries = unzipSync(bytes);
  const manifest = meta(entries);
  assert.equal(manifest.documentPath, "document.parts.ndjson");
  assert.equal(manifest.nodeCount, 10001);
  assert.ok(!entries["document.json"]);
  const text = strFromU8(entries[manifest.documentPath]);
  assert.doesNotMatch(text, /;base64,|"kind":"asset"/);
  assert.ok(text.split("\n").length > 78);
  const copy = await decodeFormaPackage(bytes);
  assert.equal(copy.nodes.length, 10000);
  assert.deepEqual(copy.nodes.at(-1), doc.nodes.at(-1));
  assert.equal(copy.images![imageId].data, doc.images![imageId].data);
  assert.deepEqual(copy.libraries, doc.libraries);
  assert.deepEqual(copy.pages, doc.pages);
  // At exactly 10,000 layers the legacy text writer would choose one JSON value.
  delete doc.libraries;
  doc.pages![1].nodes = [];
  const exact = encodeFormaPackage(doc);
  assert.equal(meta(unzipSync(exact)).documentPath, "document.parts.ndjson");
  assert.equal((await decodeFormaPackage(exact)).nodes.length, 10000);
});

test("an oversized SVG cover can be omitted without losing the original image", async () => {
  const { id, image } = await importImageBytes(samplePng(260), "大封面");
  const node = createNode("rectangle");
  node.image = { assetId: id, fit: "fill", x: 50, y: 50, zoom: 1 };
  const doc: DesignDocument = {
    schemaVersion: 1,
    id: "cover",
    name: "大封面",
    revision: 0,
    nodes: [node],
    tokens: {},
    images: { [id]: image },
  };
  assert.ok(image.data.length > 256 * 1024);
  const bytes = encodeFormaPackage(doc);
  assert.equal(meta(unzipSync(bytes)).previewPath, undefined);
  assert.deepEqual((await decodeFormaPackage(bytes)).images, doc.images);
});

test("filenames, legacy JSON and ZIP routing survive extension changes", async () => {
  const { doc } = await fixture();
  assert.equal(formaFilename("  项目 / A.FORMA.JSON  "), "项目-A.forma");
  assert.equal(formaFilename("draft.json"), "draft.forma");
  assert.equal(formaFilename("draft.forma"), "draft.forma");
  assert.equal(formaFilename(" .forma "), "design.forma");
  const json = nativeDocumentBlob(doc);
  assert.equal(json.type, "application/json");
  assert.deepEqual(JSON.parse(await json.text()), doc);
  assert.deepEqual(
    await readNativeDocument(new File([json], "legacy.forma.json")),
    doc,
  );
  const bytes = encodeFormaPackage(doc);
  assert.equal(isFormaPackageZip(bytes), true);
  assert.equal(isFormaPackageZip(new Uint8Array(0)), false);
  for (const name of ["native.forma", "renamed.bin", "old.forma.json"]) {
    class SlicedFile extends File {
      override arrayBuffer(): Promise<ArrayBuffer> {
        throw Error("Sniffer read entire package");
      }
    }
    assert.equal(await isExternalDesign(new SlicedFile([bytes], name)), false);
  }
  const reordered = zipSync({
    "preview.svg": strToU8("<svg/>"),
    "manifest.json": unzipSync(bytes)["manifest.json"],
  });
  assert.equal(
    await isExternalDesign(new File([reordered], "reordered.bin")),
    false,
  );
  for (const name of ["example.fig", "example.forma", "renamed.bin"])
    assert.equal(
      await isExternalDesign(
        new File([strToU8("fig-kiwi"), new Uint8Array(2)], name),
      ),
      true,
    );
  const sketch = zipSync({ "document.json": strToU8("{}") });
  assert.equal(isFormaPackageZip(sketch), false);
  for (const name of ["example.sketch", "wrong.forma", "renamed.bin"])
    assert.equal(await isExternalDesign(new File([sketch], name)), true);
  const fig = zipSync({ "canvas.fig": strToU8("fig-kiwi") });
  assert.equal(await isExternalDesign(new File([fig], "renamed.forma")), true);
});

test("package reader checks manifest, asset checksums, dimensions, sizes and references", async () => {
  const { doc, imageId } = await fixture();
  const entries = unzipSync(encodeFormaPackage(doc));
  const manifest = meta(entries);
  const asset = manifest.assets[imageId];
  const corrupt = entries[asset.path].slice();
  corrupt[corrupt.length - 1] ^= 1;
  await assert.rejects(
    decodeFormaPackage(zipSync({ ...entries, [asset.path]: corrupt })),
    /内容与标识/,
  );
  await assert.rejects(
    decodeFormaPackage(
      zipSync({ ...entries, "assets/images/unlisted.png": corrupt }),
    ),
    /未登记的资源/,
  );
  const payload = JSON.parse(strFromU8(entries["document.json"]));
  payload.images[imageId].width++;
  await assert.rejects(
    decodeFormaPackage(
      zipSync({
        ...entries,
        "document.json": strToU8(JSON.stringify(payload)),
      }),
    ),
    /像素尺寸/,
  );
  for (const patch of [
    { format: "sketch" },
    { packageVersion: 2 },
    { documentPath: "../other.json" },
    { assets: null },
    {
      assets: {
        ...manifest.assets,
        [imageId]: { ...asset, sha256: "0".repeat(64) },
      },
    },
    {
      assets: {
        ...manifest.assets,
        [imageId]: { ...asset, bytes: asset.bytes - 1 },
      },
    },
    {
      assets: {
        ...manifest.assets,
        [imageId]: { ...asset, path: "document.json" },
      },
    },
  ]) {
    const modified = zipSync({
      ...entries,
      "manifest.json": strToU8(JSON.stringify({ ...manifest, ...patch })),
    });
    await assert.rejects(decodeFormaPackage(modified), /清单/);
  }
  delete entries[asset.path];
  await assert.rejects(decodeFormaPackage(zipSync(entries)), /清单/);
});

test("all ZIP paths and declared budgets are checked before expanding even the first entry", async () => {
  const empty = new Uint8Array();
  for (const path of [
    "../evil",
    "/evil",
    "assets/./x",
    "a//b",
    "assets\\evil",
    "a\0b",
    "C:/bad",
  ]) {
    await assert.rejects(
      decodeFormaPackage(zipSync({ [path]: empty })),
      /路径/,
    );
  }
  await assert.rejects(
    decodeFormaPackage(zipSync({ "e\u0301": empty, é: empty })),
    /重复/,
  );
  const localPath = zipSync({ abc: empty });
  localPath.set(strToU8("../"), 30);
  await assert.rejects(decodeFormaPackage(localPath), /本地路径/);
  // Alter only size declarations in a tiny archive. No large fixture is needed.
  for (const [name, size, expected] of [
    ["assets/images/test.bin", 256 * 1024 * 1024 + 1, /256 MiB/],
    ["document.json", 512 * 1024 * 1024 + 1, /512 MiB/],
  ] as const) {
    const archive = zipSync({ [name]: empty });
    const view = new DataView(archive.buffer);
    const central = view.getUint32(archive.length - 6, true);
    view.setUint32(central + 24, size, true);
    await assert.rejects(decodeFormaPackage(archive), expected);
  }
});

test("desktop bridge dispatches edit and file actions separately and forwards native file operations", async () => {
  const { EventEmitter } = await import("node:events");
  const { runInNewContext } = await import("node:vm");
  let bridge!: FormaDesktopBridge;
  const ipc = Object.assign(new EventEmitter(), {
    invoke: async (channel: string, arg?: unknown) => {
      calls.push([channel, arg]);
    },
  });
  const calls: [string, unknown][] = [];
  runInNewContext(
    readFileSync(new URL("../electron/preload.cjs", import.meta.url), "utf8"),
    {
      process: {
        argv: ["--forma-agent-configured=1", "--forma-version=0.12.0"],
        platform: "darwin",
      },
      require: () => ({
        ipcRenderer: ipc,
        contextBridge: {
          exposeInMainWorld: (_key: string, value: FormaDesktopBridge) => {
            bridge = value;
          },
        },
      }),
    },
  );
  assert.equal(bridge.agentConfigured, true);
  const oldActions: string[] = [],
    edits: string[] = [],
    files: string[] = [];
  const offOld = bridge.onMenuAction((action) => oldActions.push(action));
  const off = bridge.onMenuAction(
    (action) => edits.push(action),
    (action) => files.push(action),
  );
  for (const action of ["undo", "save", "saveAs", "redo"])
    ipc.emit("forma:menu-action", {}, action);
  assert.deepEqual(oldActions, ["undo", "redo"]);
  assert.deepEqual(edits, oldActions);
  assert.deepEqual(files, ["save", "saveAs"]);
  offOld();
  off();
  assert.equal(ipc.listenerCount("forma:menu-action"), 0);
  const options = {
    bytes: new Uint8Array(4),
    suggestedName: "draft.forma",
    fileKey: "key",
    saveAs: true,
  };
  await bridge.getBoundFile("key");
  await bridge.bindPendingFile("key");
  await bridge.saveNativeFile(options);
  await bridge.hasConfiguredAgent();
  assert.deepEqual(calls, [
    ["forma:get-bound-file", "key"],
    ["forma:bind-pending-file", "key"],
    ["forma:save-native-file", options],
    ["forma:has-configured-agent", undefined],
  ]);
});
